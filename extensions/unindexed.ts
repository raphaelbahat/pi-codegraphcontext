// Unindexed path of the CGC lifecycle gate (design D2/D3 of
// openspec/changes/add-cgc-session-lifecycle-gate, task 2.3).
//
// When the classifier reports `unindexed` (no `.codegraphcontext/` directory
// but a usable `cgc` binary), this path decides what — if anything — happens:
//
//   - `lifecycle.autoCreate` off (the default, an explicit consent gate):
//     NO indexing is started. The user is informed exactly once that the
//     workspace is unindexed, with guidance on enabling automatic creation
//     (config file or environment override) or indexing manually. The session
//     proceeds normally without an index.
//
//   - `lifecycle.autoCreate` on (opted in): index creation is started in the
//     background (`cgc index .` through the shared runner — deduplicated,
//     budgeted, abortable, bounded output) and the user is told once that
//     indexing is running. The session proceeds while it completes.
//
// One-time semantics: the notice is surfaced at most once per workspace per
// handler lifetime (one handler per session), and indexing is started at most
// once per workspace — repeated gate evaluations never re-notify or re-spawn.
//
// Fail-open contract (design D3): `handle` never throws and never blocks.
// Indexing is fire-and-forget — callers never `await` completion; the settled
// outcome is recorded into state for downstream surfaces (task 3.1). A failed
// or busy indexing run is recorded once and never retried by this path
// (design D4: no retries; the busy policy and the one-retry cap belong to the
// gate, tasks 2.6/2.7/3.2).
//
// Per-session invocation budget (task 2.7): consented indexing counts against
// the session-wide maintenance budget when the gate supplies one; a denial
// degrades to the notice path without spawning. No retry ever happens here —
// the one-retry cap is enforced through the shared budget module (budget.ts).

import type { SessionInvocationBudget } from './budget'
import type { CgcCommandResult, CgcRunner, CgcRunOptions } from './runner'

/** Default background index-creation command (design D1/D2: the `index` verb). */
export const DEFAULT_INDEX_ARGS: readonly string[] = ['index', '.']

/**
 * Why the path did what it did this evaluation:
 *   - `notice`        — autoCreate off: the one-time unindexed notice was surfaced.
 *   - `indexing`      — autoCreate on: background index creation was started.
 *   - `degraded`      — autoCreate on but starting the background work failed
 *                       unexpectedly; degraded to the one-time notice + guidance.
 *   - `already-done`  — this workspace was already handled this session
 *                       (one-time semantics; nothing surfaced or spawned again).
 */
export type UnindexedAction = 'notice' | 'indexing' | 'degraded' | 'already-done'

/** A one-time user-facing notice produced by this path. */
export interface UnindexedNotice {
  /** Human-readable notice text (multi-line; includes enablement guidance). */
  text: string
  /** Why the notice was surfaced: no consent, or consented indexing started. */
  kind: 'unindexed' | 'indexing-started' | 'indexing-degraded'
  /** When the notice was produced (epoch ms). */
  at: number
}

/** Outcome of one `handle` evaluation (also the path's reported state). */
export interface UnindexedOutcome {
  /** The workspace cwd this evaluation applied to. */
  cwd: string
  /** What the path did this evaluation. */
  action: UnindexedAction
  /** True when this workspace was already handled earlier in this session. */
  repeated: boolean
  /** The notice produced by this evaluation, if one was surfaced. */
  notice: UnindexedNotice | null
  /** True while consented background indexing is in flight. */
  indexing: boolean
}

/** Recorded outcome of a settled background indexing run (state for 3.1). */
export interface UnindexedIndexResult {
  ok: boolean
  /** Structured runner outcome code (`OK`, `BUSY`, `TIMEOUT`, ...). */
  code: CgcCommandResult['code']
  /** Human-readable, single-line description of the outcome. */
  message: string
  durationMs: number
  /** When the run settled (epoch ms). */
  at: number
}

/** Where the path currently stands for a workspace (state for 3.1). */
export type UnindexedStatus =
  | 'unhandled'
  | 'noticed'
  | 'indexing'
  | 'settled'
  | 'degraded-to-notice'

export interface UnindexedPathOptions {
  /** The extension's single cgc runner; every spawn goes through it. */
  runner: CgcRunner
  /**
   * The opt-in consent gate (config `lifecycle.autoCreate`, default `false`).
   * False means the path never creates an index — it only surfaces the
   * one-time unindexed notice with enablement guidance.
   */
  autoCreate: boolean
  /**
   * Arguments for the background creation command; defaults to
   * `['index', '.']` run with `cwd` set to the session working directory.
   * Overridable for tests and for absorbing CLI verb changes.
   */
  indexArgs?: readonly string[]
  /**
   * Time budget for the indexing command. Defaults to the runner's configured
   * default budget (config `cgc.timeoutMs`); indexing is a long-running,
   * cancellable command, so a larger budget may be supplied by the gate.
   */
  indexTimeoutMs?: number
  /**
   * The gate's per-session invocation budget (task 2.7). When supplied,
   * consented background indexing consumes one maintenance slot; an exhausted
   * budget degrades to the notice path instead of spawning. When omitted,
   * the path relies on its own one-time-per-workspace semantics.
   */
  budget?: SessionInvocationBudget
  /**
   * Sink for one-time notices (the eventual gate wires this to Pi's session
   * notification surface). When omitted, notices accumulate in `notices` for
   * downstream surfaces (task 3.1) to read.
   */
  onNotice?: (notice: UnindexedNotice) => void
}

/**
 * Per-session unindexed path. One instance per session (or per gate); the
 * one-time markers live exactly as long as the handler, so repeated gate
 * evaluations in the same session never re-notify or re-spawn per workspace.
 */
export class UnindexedPath {
  private readonly runner: CgcRunner
  private readonly autoCreate: boolean
  private readonly indexArgs: readonly string[]
  private readonly indexTimeoutMs: number | undefined
  private readonly budget: SessionInvocationBudget | undefined
  private readonly onNotice: ((notice: UnindexedNotice) => void) | undefined

  /** Workspaces already handled this session (one-time semantics). */
  private readonly handled = new Set<string>()
  /** Notices surfaced this session, in order (read by later surfaces, 3.1). */
  private readonly noticeLog: UnindexedNotice[] = []
  /** In-flight consented indexing, keyed by workspace cwd. */
  private readonly inFlight = new Map<string, Promise<UnindexedIndexResult | null>>()
  /** Settled indexing outcomes, keyed by workspace cwd (state for 3.1). */
  private readonly results = new Map<string, UnindexedIndexResult>()
  /** Current status per workspace (state for 3.1). */
  private readonly statuses = new Map<string, UnindexedStatus>()

  constructor(options: UnindexedPathOptions) {
    this.runner = options.runner
    this.autoCreate = options.autoCreate
    this.indexArgs = options.indexArgs ?? DEFAULT_INDEX_ARGS
    this.indexTimeoutMs = options.indexTimeoutMs
    this.budget = options.budget
    this.onNotice = options.onNotice
  }

  /** Notices surfaced so far this session (read-only view for later surfaces). */
  get notices(): readonly UnindexedNotice[] {
    return this.noticeLog
  }

  /** Current status for a workspace (state for 3.1; `unhandled` if never seen). */
  status(cwd: string): UnindexedStatus {
    return this.statuses.get(cwd) ?? 'unhandled'
  }

  /** The settled background indexing outcome for a workspace, if it has one. */
  result(cwd: string): UnindexedIndexResult | null {
    return this.results.get(cwd) ?? null
  }

  /** Whether consented background indexing is currently in flight for a workspace. */
  isIndexing(cwd: string): boolean {
    return this.inFlight.has(cwd)
  }

  /** Resolves once consented background indexing for the workspace settles. */
  whenSettled(cwd: string): Promise<UnindexedIndexResult | null> {
    return this.inFlight.get(cwd) ?? Promise.resolve(this.results.get(cwd) ?? null)
  }

  /**
   * Handle one evaluation of an `unindexed` workspace.
   *
   * Never throws and never awaits cgc completion: background indexing is
   * fire-and-forget, its outcome recorded into state when it settles. At most
   * one notice and one indexing run per workspace per handler lifetime.
   */
  handle(cwd: string): UnindexedOutcome {
    // One-time semantics: this workspace was already handled this session.
    if (this.handled.has(cwd)) {
      return {
        cwd,
        action: 'already-done',
        repeated: true,
        notice: null,
        indexing: this.isIndexing(cwd),
      }
    }
    this.handled.add(cwd)

    if (!this.autoCreate) {
      // Consent gate closed (the default): no indexing is started. Inform the
      // user once, with guidance on enabling creation, and let the session
      // proceed without an index.
      const notice = this.emit({
        kind: 'unindexed',
        text: buildUnindexedNotice(cwd),
      })
      this.statuses.set(cwd, 'noticed')
      return { cwd, action: 'notice', repeated: false, notice, indexing: false }
    }

    // Per-session invocation budget (task 2.7): consented indexing is capped
    // session-wide. A denial degrades to the notice path without spawning;
    // the slot is consumed on grant even if the start below fails, so no
    // failure path can loop around the cap.
    if (this.budget !== undefined) {
      const acquisition = this.budget.tryAcquire(cwd, 'unindexed-indexing')
      if (!acquisition.granted) {
        const notice = this.emit({
          kind: 'indexing-degraded',
          text: buildDegradedNotice(
            cwd,
            acquisition.reason ?? 'per-session cgc invocation budget exhausted',
          ),
        })
        this.statuses.set(cwd, 'degraded-to-notice')
        return { cwd, action: 'degraded', repeated: false, notice, indexing: false }
      }
    }

    // Consent gate open: start index creation in the background (fire and
    // forget — design D3 forbids awaiting cgc completion in gate paths).
    const runOptions: CgcRunOptions = { args: this.indexArgs }
    if (this.indexTimeoutMs !== undefined) runOptions.timeoutMs = this.indexTimeoutMs
    let started: Promise<CgcCommandResult>
    try {
      started = this.runner.run(cwd, runOptions)
    } catch (error) {
      // The runner only throws on caller contract violations; degrade to the
      // notice path rather than throwing out of a gate hook body.
      const notice = this.emit({
        kind: 'indexing-degraded',
        text: buildDegradedNotice(cwd, error instanceof Error ? error.message : String(error)),
      })
      this.statuses.set(cwd, 'degraded-to-notice')
      return { cwd, action: 'degraded', repeated: false, notice, indexing: false }
    }

    this.emit({
      kind: 'indexing-started',
      text: buildIndexingStartedNotice(cwd, this.indexArgs),
    })
    this.statuses.set(cwd, 'indexing')

    // Settle the run: record the outcome and clear the in-flight marker
    // before the tracking promise resolves, so any consumer awaiting it (via
    // `whenSettled`) observes final state atomically. A gate hook body must
    // never reject, so every failure is captured into state (fail open).
    const settled: Promise<UnindexedIndexResult | null> = (async () => {
      let record: UnindexedIndexResult
      try {
        const result = await started
        // Record the outcome once. No retries here (design D4; the one-retry
        // cap belongs to the gate, task 3.2) and no destructive action — a
        // `BUSY` outcome is left for the busy path (task 2.6) to surface.
        record = {
          ok: result.ok,
          code: result.code,
          message: result.message,
          durationMs: result.durationMs,
          at: Date.now(),
        }
      } catch (error) {
        // Unreachable with the current runner (it resolves runtime failures),
        // but a gate hook body must never reject: capture and fail open.
        record = {
          ok: false,
          code: 'COMMAND_FAILED',
          message: `background indexing failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
          durationMs: 0,
          at: Date.now(),
        }
      }
      this.results.set(cwd, record)
      this.statuses.set(cwd, 'settled')
      this.inFlight.delete(cwd)
      return record
    })()
    // Safety net: the tracking promise is always consumed via `inFlight`; if
    // no consumer ever awaits it, the settlement must never surface as an
    // unhandled rejection.
    settled.catch(() => undefined)
    this.inFlight.set(cwd, settled)

    return { cwd, action: 'indexing', repeated: false, notice: null, indexing: true }
  }

  /** Clear all per-session state (session shutdown / fresh session). */
  reset(): void {
    this.handled.clear()
    this.noticeLog.length = 0
    this.results.clear()
    this.statuses.clear()
    this.inFlight.clear()
  }

  private emit(input: Omit<UnindexedNotice, 'at'>): UnindexedNotice {
    const notice: UnindexedNotice = { ...input, at: Date.now() }
    this.noticeLog.push(notice)
    // The sink is user-supplied; a throwing callback must not break the gate.
    try {
      this.onNotice?.(notice)
    } catch {
      // Fail-open: the notice is still recorded in the log.
    }
    return notice
  }
}

/**
 * The one-time unindexed notice for a consent-gated (autoCreate off)
 * workspace: what is missing, what it costs, and every way to enable creation.
 */
export function buildUnindexedNotice(cwd: string): string {
  return [
    `CGC: the workspace at ${cwd} has no code index, so graph queries will return empty or failed results.`,
    'Index creation is opt-in and was not performed. To enable it, set "lifecycle": { "autoCreate": true } in .pi/cgc.json (project) or ~/.pi/agent/cgc.json (global), or set CGC_LIFECYCLE_AUTO_CREATE=1; indexing then starts automatically in the background at session start.',
    'To index once without opting in, run `cgc index .` in the workspace. This session continues without an index; you will not be asked again.',
  ].join('\n')
}

/** The one-time notice that consented background indexing has started. */
export function buildIndexingStartedNotice(cwd: string, indexArgs: readonly string[]): string {
  return [
    `CGC: the workspace at ${cwd} has no code index; automatic creation is enabled (lifecycle.autoCreate).`,
    `Indexing is running in the background (\`cgc ${indexArgs.join(' ')}\`); the session proceeds while it completes.`,
  ].join('\n')
}

/** The one-time notice used when starting consented indexing failed unexpectedly. */
export function buildDegradedNotice(cwd: string, reason: string): string {
  return [
    `CGC: the workspace at ${cwd} has no code index and automatic creation could not be started (${reason}).`,
    'You can enable or retry creation with lifecycle.autoCreate in .pi/cgc.json or CGC_LIFECYCLE_AUTO_CREATE=1, or run `cgc index .` manually.',
  ].join('\n')
}
