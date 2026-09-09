// Per-session invocation budget and one-retry cap (design D2/D3 of
// openspec/changes/add-cgc-session-lifecycle-gate, task 2.7).
//
// Design D3's hard rule is that gate work must never hot-loop: "A one-shot-
// per-session retry cap prevents hot loops", and the risk table requires "all
// work is backgrounded with a per-session invocation budget". This module is
// that enforcement primitive, shared by every gate path that starts automatic
// maintenance work:
//
//   - The invocation budget caps how many `cgc` maintenance invocations the
//     gate may start per session, across all workspaces and all automatic
//     paths (unindexed creation, drift sync). Once exhausted, further
//     automatic work degrades — it is never started, and the degradation is
//     recorded by the owning path instead of retried.
//
//   - The retry ledger caps failed-work retries at exactly one per (workspace,
//     work) pair per session: the first retry is claimable, every later claim
//     is refused. The automatic paths currently never retry at all (their
//     one-time semantics are stricter than the cap); the ledger exists so the
//     gate (task 3.2) and any future retry-capable surface enforce the
//     one-retry ceiling through this shared accounting instead of ad-hoc flags.
//
// Scope (deliberate): the budget governs AUTOMATIC maintenance only. Work the
// user explicitly confirmed in-session (the corrupt path's rebuild, ADR-0003)
// is never denied by an automatic budget — an explicit human yes must not be
// silently vetoed by accounting. Detection probes (liveness, health/stats) are
// also outside the budget: they are read-only, cached per session by their
// owners (tasks 2.1/2.2), and bounded by the runner's per-command time budget.

/**
 * Default per-session cap on `cgc` maintenance invocations started by the
 * gate. Covers the realistic worst case — an unindexed creation, a drift
 * sync, one retry of either, and headroom for a multi-workspace session —
 * while hard-bounding hot loops. There is deliberately no config key for it:
 * it is a safety ceiling, not a tuning knob (design D5's minimum surface).
 */
export const DEFAULT_MAX_MAINTENANCE_INVOCATIONS_PER_SESSION = 4

/** Why an automatic maintenance invocation is being requested (bookkeeping). */
export type MaintenancePurpose = 'unindexed-indexing' | 'drift-sync' | (string & {})

/** Result of one budget acquisition attempt. */
export interface InvocationAcquisition {
  /** True when a budget slot was granted (and consumed). */
  granted: boolean
  /**
   * Human-readable, single-line denial reason; null when granted. Stable
   * enough to surface in a path's degraded record.
   */
  reason: string | null
  /** Invocations consumed so far this session (after this attempt). */
  used: number
  /** Slots left this session (after this attempt). */
  remaining: number
}

export interface SessionInvocationBudgetOptions {
  /**
   * Per-session cap on maintenance invocations. Must be a positive finite
   * number; anything else falls back to
   * {@link DEFAULT_MAX_MAINTENANCE_INVOCATIONS_PER_SESSION}.
   */
  maxInvocations?: number
}

const KEY_SEPARATOR = '\u0000'

/**
 * Per-session accounting for gate-started `cgc` maintenance invocations and
 * failed-work retries. One instance per session (created by the gate); state
 * lives exactly as long as the session, so the caps are per session by
 * construction.
 */
export class SessionInvocationBudget {
  private readonly max: number
  private usedCount = 0
  /** (cwd, work) pairs whose single retry has already been claimed. */
  private readonly retriesClaimed = new Set<string>()

  constructor(options: SessionInvocationBudgetOptions = {}) {
    const requested = options.maxInvocations
    this.max =
      typeof requested === 'number' && Number.isFinite(requested) && requested > 0
        ? Math.floor(requested)
        : DEFAULT_MAX_MAINTENANCE_INVOCATIONS_PER_SESSION
  }

  /** The effective per-session cap (diagnostics surfaces only). */
  get maxInvocations(): number {
    return this.max
  }

  /** Maintenance invocations consumed so far this session. */
  get used(): number {
    return this.usedCount
  }

  /** Budget slots left this session. */
  get remaining(): number {
    return Math.max(0, this.max - this.usedCount)
  }

  /** True once no further maintenance invocation can be granted this session. */
  get exhausted(): boolean {
    return this.remaining === 0
  }

  /**
   * Request one maintenance invocation slot for `cwd` (the Pi session working
   * directory). Grants and consumes a slot when the budget has room; refuses
   * — consuming nothing — once exhausted. A granted slot is spent even if the
   * owning path subsequently fails to start the command: a hot loop must not
   * be able to retry its way around the cap.
   *
   * Throws only on caller contract violations (non-string cwd or purpose) —
   * programming errors, not cgc failures — mirroring the runner.
   */
  tryAcquire(cwd: string, purpose: MaintenancePurpose): InvocationAcquisition {
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new TypeError(
        'invocation budget: cwd is required (use the Pi session working directory)',
      )
    }
    if (typeof purpose !== 'string' || purpose.length === 0) {
      throw new TypeError('invocation budget: purpose is required (e.g. "drift-sync")')
    }

    if (this.exhausted) {
      return {
        granted: false,
        reason: `per-session cgc invocation budget exhausted (${this.usedCount}/${this.max} maintenance invocations used this session)`,
        used: this.usedCount,
        remaining: 0,
      }
    }

    this.usedCount += 1
    return { granted: true, reason: null, used: this.usedCount, remaining: this.remaining }
  }

  /**
   * Claim the single retry allowed for a failed work item (design D3: the
   * one-shot-per-session retry cap). Returns true exactly once per
   * (cwd, work) pair per session; every later claim for the same pair is
   * refused. Claiming does not consume an invocation-budget slot — the retry,
   * if actually started, acquires its own slot like any other invocation.
   */
  claimRetry(cwd: string, work: MaintenancePurpose): boolean {
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new TypeError(
        'invocation budget: cwd is required (use the Pi session working directory)',
      )
    }
    if (typeof work !== 'string' || work.length === 0) {
      throw new TypeError('invocation budget: work is required (e.g. "drift-sync")')
    }
    const key = `${cwd}${KEY_SEPARATOR}${work}`
    if (this.retriesClaimed.has(key)) return false
    this.retriesClaimed.add(key)
    return true
  }

  /** Whether the one allowed retry for a work item has already been claimed. */
  hasRetryBeenClaimed(cwd: string, work: MaintenancePurpose): boolean {
    if (
      typeof cwd !== 'string' ||
      cwd.length === 0 ||
      typeof work !== 'string' ||
      work.length === 0
    ) {
      return false
    }
    return this.retriesClaimed.has(`${cwd}${KEY_SEPARATOR}${work}`)
  }

  /** Clear all per-session accounting (session shutdown / fresh session). */
  reset(): void {
    this.usedCount = 0
    this.retriesClaimed.clear()
  }
}
