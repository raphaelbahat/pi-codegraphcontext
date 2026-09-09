// Start-time drift path of the CGC lifecycle gate (design D2/D3 of
// openspec/changes/add-cgc-session-lifecycle-gate, task 2.4).
//
// When the classifier reports `drift` (the workspace is indexed but the graph
// is behind the working tree) and `lifecycle.syncOnStart` is on, this path
// starts an incremental sync in the background and tracks its progress in
// state. `cgc index` is incremental by default (design D2: "drift ──►
// syncing ──► clean | corrupt"), so the sync reuses the `index` verb through
// the shared runner — deduplicated, budgeted, abortable, bounded output.
//
// Gate discipline (design D3): the sync is fire-and-forget — `handle` never
// awaits cgc completion, so gate hook bodies never block the agent loop. The
// settled outcome is recorded into state (status/result accessors) for the
// downstream surfaces (task 3.1). A busy outcome is recorded as-is: surfacing
// it belongs to the busy path (task 2.6), and no retries happen here (the
// one-retry cap belongs to the gate, task 3.2).
//
// One-time semantics: at most one background sync is started per workspace
// per handler lifetime (one handler per session); repeated gate evaluations
// never re-spawn. When `lifecycle.syncOnStart` is off, the path starts
// nothing and reports `disabled` — start-time drift sync is the default-on
// behavior the config key switches off (design D5).
//
// Fail-open contract: `handle` never throws. Unexpected start failures
// degrade to a recorded `degraded` status; the session proceeds either way.
//
// Per-session invocation budget (task 2.7): the sync counts against the
// session-wide maintenance budget when the gate supplies one; a denial
// degrades the path without spawning. No retry ever happens here — the
// one-retry cap is enforced through the shared budget module (budget.ts).

import type { SessionInvocationBudget } from './budget'
import type { CgcCommandResult, CgcRunner, CgcRunOptions } from './runner'

/**
 * The incremental sync command. `cgc index .` is incremental by default
 * (CGC reconciles only files changed since the graph was last updated), so
 * the drift path and the unindexed creation path share the verb.
 */
export const DEFAULT_SYNC_ARGS: readonly string[] = ['index', '.']

/**
 * Why the path did what it did this evaluation:
 *   - `syncing`      — syncOnStart on: the background incremental sync was
 *                      started (or is already running from a prior
 *                      evaluation of the same workspace).
 *   - `already-done` — this workspace was already handled this session
 *                      (one-time semantics; nothing spawned again).
 *   - `disabled`     — syncOnStart off: no sync is ever started by this path.
 *   - `degraded`     — syncOnStart on but starting the background sync
 *                      failed unexpectedly; the failure is recorded in
 *                      state and the session proceeds.
 */
export type DriftAction = 'syncing' | 'already-done' | 'disabled' | 'degraded'

/** Outcome of one `handle` evaluation (also the path's reported state input). */
export interface DriftOutcome {
  /** The workspace cwd this evaluation applied to. */
  cwd: string
  /** What the path did this evaluation. */
  action: DriftAction
  /** True when this workspace was already handled earlier in this session. */
  repeated: boolean
  /** True while the background incremental sync is in flight. */
  syncing: boolean
  /**
   * The reason for a `degraded` outcome; null for every other action.
   * Human-readable, single-line.
   */
  degradeReason: string | null
}

/** Recorded outcome of a settled background sync run (state for 3.1). */
export interface DriftSyncResult {
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
export type DriftStatus = 'unhandled' | 'disabled' | 'syncing' | 'settled' | 'degraded'

export interface DriftPathOptions {
  /** The extension's single cgc runner; every spawn goes through it. */
  runner: CgcRunner
  /**
   * The config switch (config `lifecycle.syncOnStart`, default `true`).
   * False disables the path entirely: no sync is started for any workspace
   * and the reported status is `disabled`.
   */
  syncOnStart: boolean
  /**
   * Arguments for the background sync command; defaults to `['index', '.']`
   * run with `cwd` set to the session working directory. Overridable for
   * tests and for absorbing CLI verb changes.
   */
  syncArgs?: readonly string[]
  /**
   * Time budget for the sync command. Defaults to the runner's configured
   * default budget (config `cgc.timeoutMs`); a sync can legitimately take
   * longer than a probe on a large working tree, so the gate may pass a
   * larger budget.
   */
  syncTimeoutMs?: number
  /**
   * The gate's per-session invocation budget (task 2.7). When supplied, the
   * background sync consumes one maintenance slot; an exhausted budget
   * degrades the path instead of spawning. When omitted, the path relies on
   * its own one-time-per-workspace semantics.
   */
  budget?: SessionInvocationBudget
}

/**
 * Per-session start-time drift path. One instance per session (or per gate);
 * the one-time markers live exactly as long as the handler, so repeated gate
 * evaluations in the same session never re-spawn per workspace.
 */
export class DriftPath {
  private readonly runner: CgcRunner
  private readonly syncOnStart: boolean
  private readonly syncArgs: readonly string[]
  private readonly syncTimeoutMs: number | undefined
  private readonly budget: SessionInvocationBudget | undefined

  /** Workspaces already handled this session (one-time semantics). */
  private readonly handled = new Set<string>()
  /** In-flight background syncs, keyed by workspace cwd. */
  private readonly inFlight = new Map<string, Promise<DriftSyncResult | null>>()
  /** Settled sync outcomes, keyed by workspace cwd (state for 3.1). */
  private readonly results = new Map<string, DriftSyncResult>()
  /** Current status per workspace (state for 3.1). */
  private readonly statuses = new Map<string, DriftStatus>()

  constructor(options: DriftPathOptions) {
    this.runner = options.runner
    this.syncOnStart = options.syncOnStart
    this.syncArgs = options.syncArgs ?? DEFAULT_SYNC_ARGS
    this.syncTimeoutMs = options.syncTimeoutMs
    this.budget = options.budget
  }

  /** Current status for a workspace (state for 3.1; `unhandled` if never seen). */
  status(cwd: string): DriftStatus {
    return this.statuses.get(cwd) ?? 'unhandled'
  }

  /** The settled background sync outcome for a workspace, if it has one. */
  result(cwd: string): DriftSyncResult | null {
    return this.results.get(cwd) ?? null
  }

  /** Whether the background incremental sync is currently in flight for a workspace. */
  isSyncing(cwd: string): boolean {
    return this.inFlight.has(cwd)
  }

  /** Resolves once the background sync for the workspace settles. */
  whenSettled(cwd: string): Promise<DriftSyncResult | null> {
    return this.inFlight.get(cwd) ?? Promise.resolve(this.results.get(cwd) ?? null)
  }

  /**
   * Handle one evaluation of a `drift` workspace.
   *
   * Never throws and never awaits cgc completion: the sync is fire-and-forget,
   * its outcome recorded into state when it settles. At most one sync per
   * workspace per handler lifetime.
   */
  handle(cwd: string): DriftOutcome {
    // One-time semantics: this workspace was already handled this session —
    // never re-spawn the sync regardless of how it went (no retries here;
    // the gate owns any retry policy, task 3.2).
    if (this.handled.has(cwd)) {
      return {
        cwd,
        action: 'already-done',
        repeated: true,
        syncing: this.isSyncing(cwd),
        degradeReason: null,
      }
    }
    this.handled.add(cwd)

    if (!this.syncOnStart) {
      // Config switch off (design D5): start-time drift sync is disabled for
      // this session. Record it so downstream surfaces can show why nothing
      // is running, and let the session proceed with the stale graph.
      this.statuses.set(cwd, 'disabled')
      return { cwd, action: 'disabled', repeated: false, syncing: false, degradeReason: null }
    }

    // Per-session invocation budget (task 2.7): automatic maintenance is
    // capped session-wide. A denial degrades without spawning; the slot is
    // consumed on grant even if the start below fails, so no failure path can
    // loop around the cap.
    if (this.budget !== undefined) {
      const acquisition = this.budget.tryAcquire(cwd, 'drift-sync')
      if (!acquisition.granted) {
        this.statuses.set(cwd, 'degraded')
        return {
          cwd,
          action: 'degraded',
          repeated: false,
          syncing: false,
          degradeReason: acquisition.reason ?? 'per-session cgc invocation budget exhausted',
        }
      }
    }

    // Start the incremental sync in the background (fire and forget — design
    // D3 forbids awaiting cgc completion in gate paths).
    const runOptions: CgcRunOptions = { args: this.syncArgs }
    if (this.syncTimeoutMs !== undefined) runOptions.timeoutMs = this.syncTimeoutMs
    let started: Promise<CgcCommandResult>
    try {
      started = this.runner.run(cwd, runOptions)
    } catch (error) {
      // The runner only throws on caller contract violations; record the
      // degraded status rather than throwing out of a gate hook body.
      const reason = error instanceof Error ? error.message : String(error)
      this.statuses.set(cwd, 'degraded')
      return { cwd, action: 'degraded', repeated: false, syncing: false, degradeReason: reason }
    }

    this.statuses.set(cwd, 'syncing')

    // Settle the run: record the outcome and clear the in-flight marker
    // before the tracking promise resolves, so any consumer awaiting it (via
    // `whenSettled`) observes final state atomically. A gate hook body must
    // never reject, so every failure is captured into state (fail open).
    const settled: Promise<DriftSyncResult | null> = (async () => {
      let record: DriftSyncResult
      try {
        const result = await started
        // Record the outcome once. A `BUSY` outcome is left for the busy
        // path (task 2.6) to surface; no retries here (design D4, task 3.2)
        // and no destructive action of any kind.
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
          message: `background sync failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
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

    return { cwd, action: 'syncing', repeated: false, syncing: true, degradeReason: null }
  }

  /** Clear all per-session state (session shutdown / fresh session). */
  reset(): void {
    this.handled.clear()
    this.results.clear()
    this.statuses.clear()
    this.inFlight.clear()
  }
}
