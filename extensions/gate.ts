// Lifecycle gate (design D2/D3 of openspec/changes/add-cgc-session-lifecycle-gate,
// task 3.2: fail-open guarantees).
//
// The gate is the session-start coordinator: it wires the Pi `session_start`
// and `session_shutdown` hooks and runs the five-state lifecycle state machine
// for the active workspace, delegating each state to its owning path:
//
//   state          routing
//   unavailable    one-time notice (buildUnavailableNotice); no spawn, session proceeds
//   unindexed      UnindexedPath (2.3): consent-gated creation or one-time notice
//   drift          DriftPath (2.4): background incremental sync when syncOnStart
//   corrupt        CorruptPath (2.5): one-time report + rebuild offer (confirm-only)
//   busy           BusyPath (2.6): skip-as-busy with a one-time notice
//   clean          CleanPath (2.7): silent skip, zero maintenance invocations
//
// Task 3.2 owns four guarantees, each enforced structurally:
//
//   1. Fail-open — every hook body (session_start, session_shutdown, and the
//      background evaluation) is try/catch-guarded and never throws or
//      rejects. Guarded failures are captured into the per-session
//      lifecycle-state store (task 3.1) with a `gate-failed` action, and the
//      agent loop is never interrupted.
//
//   2. One-retry cap — a failed gate evaluation is re-attempted at most ONCE
//      per (workspace, work) pair per session, enforced through the shared
//      retry ledger (budget.ts `SessionInvocationBudget.claimRetry`): the
//      first re-evaluation after a failure claims the single allowed retry;
//      every later request is refused (`attempted: false` plus a recorded
//      `gate-retry-refused` action) so no failure path can hot-loop.
//
//   3. Never block — the `session_start` hook body is synchronous: it resolves
//      the workspace, captures the notification sink, and fires the
//      evaluation in the background. It never awaits cgc completion; the
//      background maintenance commands are fire-and-forget too (the paths'
//      contract), so the agent loop proceeds immediately.
//
//   4. Source-of-truth cwd — the workspace resolves from the Pi session
//      context (`ctx.cwd`), never from `process.cwd()`. `process.cwd()` is
//      used only as the detector's documented last-resort fallback for hosts
//      that provide no session cwd.
//
// Session scoping: one store/budget/detector/classifier/path set per session,
// created lazily on the first `session_start` and reset on `session_shutdown`
// (or `reset()`), so per-session accounting (probe caches, one-time markers,
// invocation budget, retry ledger) never leaks across sessions. Registration
// is fail-open: a throwing API never breaks extension load.

import { SessionInvocationBudget } from './budget'
import { type BusyNotice, BusyPath } from './busy'
import {
  type LifecycleClassification,
  LifecycleClassifier,
  type LifecycleState,
} from './classifier'
import { CleanPath } from './clean'
import type { ExtensionConfig } from './config'
import { type CorruptNotice, CorruptPath } from './corrupt'
import { DriftPath } from './drift'
import { type LifecycleSnapshot, LifecycleStateStore } from './lifecycle-state'
import type { CgcRunner } from './runner'
import { type UnindexedNotice, UnindexedPath } from './unindexed'
import { type WorkspaceDetector, WorkspaceDetector as WorkspaceDetectorImpl } from './workspace'

/**
 * The retry ledger's work key for a full gate evaluation (the one retryable
 * unit this change owns). The state paths are strictly one-shot (they never
 * retry their own work), so the gate's retry cap applies to the evaluation
 * itself; future retry-capable surfaces (slash commands) must go through the
 * same shared ledger (budget.ts) to stay under the ceiling.
 */
export const GATE_EVALUATION_WORK = 'gate-evaluation'

/** The one-shot-per-session retry ceiling (design D3; budget.ts enforces it). */
export const MAX_GATE_EVALUATION_RETRIES_PER_SESSION = 1

export type GateNoticeType = 'info' | 'warning' | 'error'

/** Final user-facing notice sink; production wires this to Pi's UI notify. */
export type GateNoticeSink = (text: string, type: GateNoticeType) => void

/**
 * Minimal Pi extension API surface the gate registers hooks on (a structural
 * test seam: the real `ExtensionAPI` satisfies it — same pattern as
 * cleanup.ts).
 */
export interface GateExtensionApi {
  on(event: 'session_start', handler: (event: unknown, ctx: unknown) => unknown): unknown
  on(event: 'session_shutdown', handler: (event: unknown, ctx: unknown) => unknown): unknown
}

/** The slice of the Pi session context the gate reads (defensive narrowing). */
interface GateSessionContext {
  cwd?: unknown
  ui?: unknown
}

interface GateUiContext {
  notify?: unknown
}

/** One recorded user-facing notice (gate-level log for tests/diagnostics). */
export interface GateNotice {
  text: string
  type: GateNoticeType
  at: number
}

/** Outcome of one gate evaluation (also the reported state input for 3.1). */
export interface GateEvaluationOutcome {
  /** The workspace cwd this evaluation applied to (the session cwd). */
  cwd: string
  /** The classified lifecycle state (last recorded state if refused). */
  state: LifecycleState
  /**
   * True when this evaluation actually classified and routed the workspace.
   * False only when the one-retry cap refused a re-attempt after an earlier
   * failure — in which case nothing ran and `refusedReason` is set.
   */
  attempted: boolean
  /** True when this workspace was already evaluated this session. */
  repeated: boolean
  /** Set when the evaluation was refused by the one-retry cap. */
  refusedReason: string | null
  /** True when an unexpected gate failure was captured into state (fail-open). */
  failed: boolean
}

/** A settled background run as consumed by the gate's settle routing. */
interface SettledGateOutcome {
  ok: boolean
  code: string
  message: string
  durationMs: number
  at: number
}

export interface LifecycleGateOptions {
  /** The extension's single cgc runner; every spawn goes through it. */
  runner: CgcRunner
  /** Resolved extension configuration (defaults <- files <- env, task 1.2). */
  config: ExtensionConfig
  /**
   * Pi extension API receiving the session hooks. When omitted (tests driving
   * `evaluate` directly), `register()` is a no-op.
   */
  api?: GateExtensionApi
  /**
   * Final notice sink; defaults to a no-op. The gate also routes notices to
   * the session context's `ui.notify` when the hook supplied one. Tests pass
   * a collector here.
   */
  notify?: GateNoticeSink
  /**
   * Test seam: classifier override. When supplied, the gate uses it as the
   * per-session classifier instead of constructing one (its `reset()` is
   * still called on session reset). Production code never passes this.
   */
  classifier?: GateClassifierLike
}

/**
 * Minimal classifier surface the gate consumes (a structural seam: the real
 * {@link LifecycleClassifier} satisfies it; tests pass stand-ins).
 */
export interface GateClassifierLike {
  classify(sessionCwd: string): Promise<LifecycleClassification>
  reset(): void
}

/** Per-session gate state (created lazily, reset at session shutdown). */
interface GateSession {
  store: LifecycleStateStore
  budget: SessionInvocationBudget
  detector: WorkspaceDetector
  classifier: GateClassifierLike
  unindexed: UnindexedPath
  drift: DriftPath
  busy: BusyPath
  corrupt: CorruptPath
  clean: CleanPath
  /** All notices forwarded this session, in order (tests/diagnostics). */
  notices: GateNotice[]
  /** Workspaces whose evaluation completed at least once this session. */
  evaluated: Set<string>
  /**
   * Workspaces whose evaluation failed unexpectedly; cleared on the first
   * successful re-evaluation (the one-retry cap, budget.ts ledger).
   */
  failedEvaluations: Map<string, { at: number; detail: string }>
  /** Workspaces already given the one-time unavailable notice. */
  unavailableNotified: Set<string>
  /** The `ui.notify` captured from the most recent session-start context. */
  activeNotify: GateNoticeSink | undefined
  /** In-flight evaluations, keyed by workspace cwd. */
  activeEvaluations: Map<string, Promise<GateEvaluationOutcome>>
  /** Last evaluation outcome per workspace (for `whenEvaluated`). */
  lastOutcomes: Map<string, GateEvaluationOutcome>
}

/**
 * Per-session CGC lifecycle gate. One instance per extension; session state
 * is created lazily and reset between sessions. Register it against the Pi
 * extension API via {@link register} (or drive `evaluate` directly in tests).
 */
export class LifecycleGate {
  private readonly runner: CgcRunner
  private readonly config: ExtensionConfig
  private readonly api: GateExtensionApi | undefined
  private readonly externalNotify: GateNoticeSink | undefined
  private readonly classifierOverride: GateClassifierLike | undefined

  private session: GateSession | undefined
  private registered = false
  private disposed = false

  constructor(options: LifecycleGateOptions) {
    this.runner = options.runner
    this.config = options.config
    this.api = options.api
    this.externalNotify = options.notify
    this.classifierOverride = options.classifier
  }

  /**
   * Wire the `session_start` and `session_shutdown` hooks. Idempotent and
   * fail-open: a broken API never throws out of registration (the hooks are
   * also individually guarded). No-op after `dispose()`.
   */
  register(): void {
    if (this.disposed || this.registered) return
    this.registered = true
    const api = this.api
    if (api === undefined) return
    try {
      api.on('session_start', this.handleSessionStart)
    } catch {
      // Fail-open: extension load must never break on a throwing API.
    }
    try {
      api.on('session_shutdown', this.handleSessionShutdown)
    } catch {
      // Fail-open (same rationale).
    }
  }

  /**
   * Mark the gate inert (the Pi API has no hook-removal surface, so the
   * registered handlers become no-ops). Idempotent; for tests and reload
   * paths.
   */
  dispose(): void {
    this.disposed = true
    this.registered = false
    try {
      this.reset()
    } catch {
      // Fail-open: disposal must never throw.
    }
  }

  /**
   * The per-session lifecycle-state store (read-only surface for downstream
   * HUD/slash-command changes). Returns null before the first session.
   */
  lifecycleStore(): LifecycleStateStore | null {
    return this.session?.store ?? null
  }

  /** Test/diagnostic accessors. */

  snapshot(cwd: string): LifecycleSnapshot | null {
    return this.session?.store.snapshot(cwd) ?? null
  }

  snapshots(): readonly LifecycleSnapshot[] {
    return this.session?.store.snapshots() ?? []
  }

  /** Notices forwarded this session, in order. */
  notices(): readonly GateNotice[] {
    return this.session?.notices ?? []
  }

  /** Whether the one evaluation retry for a workspace has been claimed. */
  hasRetryBeenClaimed(cwd: string): boolean {
    if (this.session === undefined) return false
    try {
      return this.session.budget.hasRetryBeenClaimed(cwd, GATE_EVALUATION_WORK)
    } catch {
      return false
    }
  }

  /**
   * Resolves when the in-flight evaluation for the workspace settles (or with
   * the last completed outcome). Null when the workspace was never evaluated.
   */
  whenEvaluated(cwd: string): Promise<GateEvaluationOutcome | null> {
    const session = this.ensureSession()
    return (
      session.activeEvaluations.get(cwd) ?? Promise.resolve(session.lastOutcomes.get(cwd) ?? null)
    )
  }

  /** Reset all per-session state (session shutdown / fresh session). */
  reset(): void {
    const session = this.session
    if (session === undefined) return
    this.session = undefined
    try {
      session.store.reset()
    } catch {
      // Fail-open: reset must never throw.
    }
    try {
      session.budget.reset()
    } catch {
      // Fail-open.
    }
    try {
      session.detector.reset()
    } catch {
      // Fail-open.
    }
    try {
      session.classifier.reset()
    } catch {
      // Fail-open.
    }
    try {
      session.unindexed.reset()
    } catch {
      // Fail-open.
    }
    try {
      session.drift.reset()
    } catch {
      // Fail-open.
    }
    try {
      session.busy.reset()
    } catch {
      // Fail-open.
    }
    try {
      session.corrupt.reset()
    } catch {
      // Fail-open.
    }
    try {
      session.clean.reset()
    } catch {
      // Fail-open.
    }
  }

  /**
   * Run the full gate evaluation for a workspace (fire-and-forget friendly).
   *
   * Public surface for tests and future retry-capable commands
   * (add-cgc-slash-commands). Never rejects: every failure is captured into
   * the per-session store as `gate-failed` and reported on the outcome
   * (`failed: true`). A re-evaluation of a workspace whose previous
   * evaluation failed is allowed at most once per session (the shared retry
   * ledger); further attempts are refused without running anything.
   */
  async evaluate(cwd: string): Promise<GateEvaluationOutcome> {
    const session = this.ensureSession()
    return this.evaluateIn(cwd, session)
  }

  /**
   * Session-start hook body. Synchronous by contract: resolves the workspace
   * from `ctx.cwd` (never `process.cwd()`), captures the session UI, and
   * fires the evaluation in the background. Every branch is guarded so the
   * hook can never throw into pi's session dispatch; the agent loop is never
   * blocked and never interrupted.
   */
  private readonly handleSessionStart = (_event: unknown, ctx: unknown): void => {
    if (this.disposed) return
    try {
      const session = this.ensureSession()
      const context = (ctx ?? {}) as GateSessionContext
      const ui = (context.ui ?? {}) as GateUiContext
      session.activeNotify =
        typeof ui.notify === 'function'
          ? (ui.notify as (text: string, type: 'info' | 'warning' | 'error') => void)
          : undefined

      // The Pi session working directory is the source of truth (never
      // process.cwd(); the detector's fallback is only for hosts that omit a
      // session cwd entirely and stays flagged in the detection result).
      const sessionCwd =
        typeof context.cwd === 'string' && context.cwd.length > 0 ? context.cwd : undefined
      const cwd = session.detector.resolveSessionCwd(sessionCwd)

      this.kickOff(session, cwd)
    } catch {
      // Fail-open: a session_start hook body must never throw; the agent
      // loop is the point of the guarantee.
    }
  }

  /** Session-shutdown hook: clear all per-session state. Never throws. */
  private readonly handleSessionShutdown = (): void => {
    if (this.disposed) return
    try {
      this.reset()
    } catch {
      // Fail-open: shutdown must never throw.
    }
  }

  /** Fire the evaluation without awaiting it (and never let it reject). */
  private kickOff(session: GateSession, cwd: string): void {
    const evaluation = this.evaluateIn(cwd, session)
    // Safety net: evaluate never rejects by contract, but guard the
    // unhandled-rejection path so hook dispatch can never be interrupted.
    evaluation.catch(() => undefined)
    session.activeEvaluations.set(cwd, evaluation)
    void evaluation
      .finally(() => {
        if (session.activeEvaluations.get(cwd) === evaluation) {
          session.activeEvaluations.delete(cwd)
        }
      })
      .catch(() => undefined)
  }

  private async evaluateIn(cwd: string, session: GateSession): Promise<GateEvaluationOutcome> {
    const repeated = session.evaluated.has(cwd)

    // One-retry cap (design D3): a failed evaluation may be re-attempted once
    // per session; everything after that is refused without running anything
    // — the ledger (budget.ts) owns the ceiling.
    if (session.failedEvaluations.has(cwd)) {
      let claimable = false
      try {
        claimable = session.budget.claimRetry(cwd, GATE_EVALUATION_WORK)
      } catch {
        claimable = false
      }
      if (!claimable) {
        const refusedReason = `gate evaluation retry refused: the one-per-session retry for ${cwd} was already used after an earlier failure`
        try {
          session.store.recordAction({
            kind: 'gate-retry-refused',
            cwd,
            ok: false,
            detail: refusedReason,
          })
        } catch {
          // Fail-open: recording must never break the evaluation.
        }
        const outcome: GateEvaluationOutcome = {
          cwd,
          state: this.lastState(session, cwd),
          attempted: false,
          repeated: true,
          refusedReason,
          failed: false,
        }
        session.lastOutcomes.set(cwd, outcome)
        return outcome
      }
    }

    try {
      const classification = await session.classifier.classify(cwd)
      // The classifier never throws, but a rethrow here would mean an
      // unexpected internal defect — the catch below still owns it.
      this.route(session, classification)
      session.evaluated.add(cwd)
      session.failedEvaluations.delete(cwd)

      const outcome: GateEvaluationOutcome = {
        cwd,
        state: classification.state,
        attempted: true,
        repeated,
        refusedReason: null,
        failed: false,
      }
      session.lastOutcomes.set(cwd, outcome)
      return outcome
    } catch (error) {
      // Fail-open: capture the error into the reported state, mark the
      // evaluation failed so the one-retry cap engages, and never throw into
      // the hook or the agent loop. Guard the ledger read too.
      const detail = `gate evaluation failed unexpectedly: ${
        error instanceof Error ? error.message : String(error)
      }`
      try {
        session.store.recordAction({ kind: 'gate-failed', cwd, ok: false, detail })
      } catch {
        // Fail-open: even store recording must not break the evaluation.
      }
      session.failedEvaluations.set(cwd, { at: Date.now(), detail })

      const outcome: GateEvaluationOutcome = {
        cwd,
        state: this.lastState(session, cwd),
        attempted: true,
        repeated,
        refusedReason: null,
        failed: true,
      }
      session.lastOutcomes.set(cwd, outcome)
      return outcome
    }
  }

  /** Classify-and-route one workspace into its owning path; never throws. */
  private route(session: GateSession, classification: LifecycleClassification): void {
    const { cwd, state } = classification

    // State exposure (task 3.1): every workspace carries its classification.
    // Recorded once per session — a re-evaluation (repeat) must not clobber
    // the last meaningful action (notice/skip/settle) with a fresh
    // `classified` entry.
    try {
      if (!session.evaluated.has(cwd)) {
        session.store.recordClassification(classification)
      }
    } catch {
      // Fail-open: state recording must never break the routing.
    }

    switch (state) {
      case 'unavailable': {
        // One-time notice per workspace per session; nothing is spawned and
        // the session proceeds (spec: "cgc binary is missing").
        if (!session.unavailableNotified.has(cwd)) {
          session.unavailableNotified.add(cwd)
          this.forwardNotice(
            session,
            'warning',
            buildUnavailableNotice(cwd, classification.probe.message),
          )
          try {
            session.store.recordAction({
              kind: 'unavailable-notice',
              cwd,
              ok: null,
              detail: `cgc unavailable: ${classification.probe.message}`,
            })
          } catch {
            // Fail-open.
          }
        }
        break
      }
      case 'unindexed': {
        let outcome: ReturnType<UnindexedPath['handle']>
        try {
          outcome = session.unindexed.handle(cwd)
        } catch {
          // Guarded, but a path defect must still fail open (record only).
          try {
            session.store.recordAction({
              kind: 'unindexed-notice',
              cwd,
              ok: false,
              detail:
                'unindexed handling failed unexpectedly; the one-time notice was not surfaced',
            })
          } catch {
            // Fail-open.
          }
          break
        }
        switch (outcome.action) {
          case 'notice': {
            try {
              session.store.recordAction({
                kind: 'unindexed-notice',
                cwd,
                ok: null,
                detail: 'unindexed workspace: the one-time notice was surfaced (autoCreate off)',
              })
            } catch {
              // Fail-open.
            }
            break
          }
          case 'indexing': {
            try {
              session.store.recordAction({
                kind: 'indexing-started',
                cwd,
                ok: null,
                detail: 'background index creation started (lifecycle.autoCreate on)',
              })
            } catch {
              // Fail-open.
            }
            this.attachSettle(session, cwd, session.unindexed.whenSettled(cwd), 'indexing-settled')
            break
          }
          case 'degraded': {
            try {
              session.store.recordAction({
                kind: 'unindexed-notice',
                cwd,
                ok: false,
                detail:
                  'automatic index creation could not be started; the one-time notice was surfaced',
              })
            } catch {
              // Fail-open.
            }
            break
          }
          case 'already-done':
            break
        }
        break
      }
      case 'drift': {
        const outcome = session.drift.handle(cwd)
        switch (outcome.action) {
          case 'syncing': {
            try {
              session.store.recordAction({
                kind: 'drift-sync-started',
                cwd,
                ok: null,
                detail: 'start-time drift sync started in the background',
              })
            } catch {
              // Fail-open.
            }
            this.attachSettle(session, cwd, session.drift.whenSettled(cwd), 'drift-sync-settled')
            break
          }
          case 'disabled': {
            try {
              session.store.recordAction({
                kind: 'drift-sync-disabled',
                cwd,
                ok: null,
                detail: 'start-time drift sync disabled by config (lifecycle.syncOnStart off)',
              })
            } catch {
              // Fail-open.
            }
            break
          }
          case 'degraded': {
            try {
              session.store.recordAction({
                kind: 'drift-sync-degraded',
                cwd,
                ok: false,
                detail: outcome.degradeReason ?? 'start-time drift sync could not be started',
              })
            } catch {
              // Fail-open.
            }
            break
          }
          case 'already-done':
            break
        }
        break
      }
      case 'corrupt': {
        const outcome = session.corrupt.handle(cwd, classification.reason)
        if (outcome.action === 'notified') {
          try {
            session.store.recordAction({
              kind: 'corrupt-notice',
              cwd,
              ok: null,
              detail:
                'corrupt index reported and a rebuild was offered (explicit confirmation required)',
            })
          } catch {
            // Fail-open.
          }
        }
        break
      }
      case 'busy': {
        const outcome = session.busy.handle(cwd, classification.reason)
        if (outcome.action === 'skipped') {
          try {
            session.store.recordAction({
              kind: 'busy-skipped',
              cwd,
              ok: null,
              detail:
                'maintenance skipped as busy (another CGC process holds the embedded database)',
            })
          } catch {
            // Fail-open.
          }
        }
        break
      }
      case 'clean': {
        const outcome = session.clean.handle(cwd)
        if (outcome.action === 'skipped') {
          try {
            session.store.recordAction({
              kind: 'clean-skipped',
              cwd,
              ok: null,
              detail: 'index is healthy; no maintenance work needed',
            })
          } catch {
            // Fail-open.
          }
        }
        break
      }
      default: {
        // A classifier produced an unexpected state (impossible with the
        // closed union, but a gate body must still fail open).
        try {
          session.store.recordAction({
            kind: 'gate-failed',
            cwd,
            ok: false,
            detail: `gate evaluation failed unexpectedly: classifier returned unhandled state ${JSON.stringify(state)}`,
          })
        } catch {
          // Fail-open.
        }
        break
      }
    }
  }

  /**
   * Route a settled background maintenance outcome into state. `BUSY`
   * outcomes are delegated to the busy path (skip-as-busy, task 2.6) and
   * recorded as `busy-skipped`; every other outcome records its settle kind
   * with the outcome's ok flag. Never rejects.
   */
  private attachSettle(
    session: GateSession,
    cwd: string,
    pending: Promise<SettledGateOutcome | null>,
    kind: 'indexing-settled' | 'drift-sync-settled',
  ): void {
    pending
      .then((result) => {
        try {
          if (result === null) return
          if (result.code === 'BUSY') {
            try {
              session.store.recordAction({
                kind: 'busy-skipped',
                cwd,
                ok: null,
                detail: `maintenance command reported a lock conflict; skipped as busy (${result.message})`,
                at: result.at,
              })
            } catch {
              // Fail-open.
            }
            try {
              session.busy.reportLockError(cwd, { code: result.code, message: result.message })
            } catch {
              // Fail-open: the busy path never throws, but a defect must not
              // break the settle chain.
            }
            return
          }
          try {
            session.store.recordAction({
              kind,
              cwd,
              ok: result.ok,
              detail: result.message,
              at: result.at,
            })
          } catch {
            // Fail-open.
          }
        } catch {
          // Fail-open: the settle routing must never reject.
        }
      })
      .catch(() => {
        // The paths' tracking promises never reject by contract; belt and
        // braces so the settle chain can never surface an unhandled rejection.
      })
  }

  private forwardNotice(session: GateSession, type: GateNoticeType, text: string): void {
    try {
      session.notices.push({ text, type, at: Date.now() })
    } catch {
      // Fail-open: the notice log must never break the gate.
    }
    try {
      this.externalNotify?.(text, type)
    } catch {
      // A user-supplied sink must never break the gate.
    }
    try {
      session.activeNotify?.(text, type)
    } catch {
      // The context's notify must never break the gate.
    }
  }

  private ensureSession(): GateSession {
    if (this.session !== undefined) return this.session

    const store = new LifecycleStateStore()
    const budget = new SessionInvocationBudget()
    const detector = new WorkspaceDetectorImpl({
      runner: this.runner,
      versionProbeTimeoutMs: this.config.cgc.versionProbeTimeoutMs,
    })
    const session: GateSession = {
      detector,
      budget,
      classifier:
        this.classifierOverride ??
        new LifecycleClassifier({
          detector,
          runner: this.runner,
          healthProbeTimeoutMs: this.config.cgc.timeoutMs,
        }),
      store,
      unindexed: new UnindexedPath({
        runner: this.runner,
        autoCreate: this.config.lifecycle.autoCreate,
        budget,
        onNotice: (notice: UnindexedNotice) =>
          this.forwardNotice(session, noticeTypeFor(notice.kind), notice.text),
      }),
      drift: new DriftPath({
        runner: this.runner,
        syncOnStart: this.config.lifecycle.syncOnStart,
        budget,
      }),
      busy: new BusyPath({
        onNotice: (notice: BusyNotice) =>
          this.forwardNotice(session, noticeTypeFor(notice.kind), notice.text),
      }),
      corrupt: new CorruptPath({
        runner: this.runner,
        onNotice: (notice: CorruptNotice) =>
          this.forwardNotice(session, noticeTypeFor(notice.kind), notice.text),
      }),
      clean: new CleanPath(),
      notices: [],
      evaluated: new Set(),
      failedEvaluations: new Map(),
      unavailableNotified: new Set(),
      activeNotify: undefined,
      activeEvaluations: new Map(),
      lastOutcomes: new Map(),
    }
    this.session = session
    return session
  }

  private lastState(session: GateSession, cwd: string): LifecycleState {
    try {
      return session.store.snapshot(cwd)?.state ?? 'unavailable'
    } catch {
      return 'unavailable'
    }
  }
}

/** Notice type by path kind: informational creation messages vs warnings. */
function noticeTypeFor(kind: string): GateNoticeType {
  return kind === 'unindexed' || kind === 'indexing-started' ? 'info' : 'warning'
}

/** The one-time unavailable notice: what is missing and every way to fix it. */
export function buildUnavailableNotice(cwd: string, detail: string): string {
  return [
    `CGC: the cgc CLI is unavailable for ${cwd} — graph-index features are disabled for this session (${detail}).`,
    'To enable them, install CodeGraphContext and make sure `cgc` is on PATH, or set "cgc": { "executable": "…" } in .pi/cgc.json (project) or ~/.pi/agent/cgc.json (global), or CGC_EXECUTABLE.',
    'This session proceeds normally without CGC integration. You will not be asked again this session.',
  ].join('\n')
}
