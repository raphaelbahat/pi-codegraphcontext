// Freshness drift observation (design D1 of
// openspec/changes/add-cgc-freshness-drift-sync, task 1.3) — the producer
// half of the freshness capability.
//
// The harness documents no file-specific "file edited" event — tool-call
// interception is the available, conservative signal (validate.md §1.3 pins
// `tool_call`, per installed docs/extensions.md, complemented by
// `tool_execution_start` / `tool_execution_end`). This module owns that
// signal: a {@link FreshnessDriftObserver} subscribes to `tool_call` and
// marks the session workspace possibly-stale on the FIRST observed
// file-modifying tool call, debouncing bursts (later calls within the same
// stale episode record nothing; the store's first-mark-wins `staleSince`
// timestamp is the data-layer backstop, task 1.2). DETECTION stays
// spawn-free: no filesystem hashing, no polling, and no cgc invocation for
// observation — the signal is purely event-driven. The separate lazy
// auto-sync path (task 2.1) then starts ONE budgeted, background incremental
// `cgc index .` through the shared runner on the first drift mark (design
// D2), recorded as progress state (`syncing`) until it settles — the runner
// dedups an already-in-flight identical sync instead of re-spawning.
// Task 2.4 adds the opt-in continuous watcher mode (design D2): with
// `freshness.watch` on, CGC's own `cgc watch .` starts at session start as a
// managed child THROUGH the shared runner (so every session cleanup path
// terminates it); while it runs it owns freshness — session edits open no
// stale episode and no lazy syncs run. A BUSY start (database lock held
// elsewhere) degrades the session back to the lazy mode with a one-time busy
// notice under the shared `skipped-busy` condition key.
//
// Contract posture (this module writes nothing to the agent context — the
// session notice surface (Pi's `ui.notify`, design D4: once per condition key
// per session) and downstream renderers consume the state store):
//   - `tool_call` Can Block — the handler ALWAYS returns undefined and never
//     mutates `event.input` (docs/extensions.md behavior guarantees). Drift
//     observation is a passive side effect, never a gate.
//   - Fail-open everywhere (ADR-0002 / ADR-0007): registration guards each
//     `on` individually and every hook body is guarded, so a throwing API or
//     store can never break extension load or reach pi's event dispatch.
//     Containment is observable (task 3.2): an encountered error is recorded
//     into the state store (`lastError`) rather than only swallowed, and
//     failing work is retried at most once per session (the watcher attempt,
//     gated by `watcherFailed`; a failed episode stays open, so no automatic
//     sync retries it).
//   - The worktree-isolation gate (isolate mode only) is consulted per
//     observation: a workspace the gate reports blocked records NO freshness
//     state — a context the gate refuses to verify must not be claimed stale
//     (or, later, synced, task 2.1) by this module (fail-closed, the same
//     surface the spawning verbs honor). `off` mode / no session → the
//     provider returns null → never blocked.
//   - The state store is process-lifetime (one shared instance served to
//     every consumer — HUD, `/cgc status`, future proactive tiers — through
//     {@link getFreshnessStateStore}); the session boundary is enforced by
//     `reset()` on `session_shutdown`, so no session ever carries state into
//     the next one.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WatchMode } from './config'
import { FreshnessStateStore } from './freshness-state'
import { isWorkspaceIndexed } from './workspace'

/**
 * The deterministic file-modifying tool names the drift observer watches
 * (design D1). Pi's built-in file-surface tools plus the lean-ctx anchored
 * patch editor. Shells / sandboxes (`bash`, `ctx_shell`, `ctx_execute`, …)
 * are deliberately NOT included: they are not deterministically
 * file-modifying, and flagging every interactive command would make the
 * advisory stale flag meaningless — CGC's incremental index computes the
 * real file set anyway (design D1 rationale).
 */
export const FILE_MODIFYING_TOOLS: ReadonlySet<string> = new Set([
  'edit', // pi built-in: anchored replacement in an existing file
  'write', // pi built-in: create or overwrite a file
  'remove_file', // pi built-in (harness): delete a file
  'rename_file', // pi built-in (harness): move/rename a file
  'ctx_patch', // lean-ctx: anchored patch edit (ctx_search anchored refs)
])

/** Whether a tool name is in the deterministic file-modifying set. */
export function isFileModifyingTool(toolName: string): boolean {
  return FILE_MODIFYING_TOOLS.has(toolName)
}

/**
 * The slice of the worktree-isolation block the observer reads (structural:
 * the gate's `WorktreeIsolationBlock` satisfies it). `blocked` true = the
 * workspace's mapped context may not be consumed or acted on.
 */
export interface FreshnessWorktreeBlock {
  blocked: boolean
}

/**
 * Minimal Pi extension API surface the drift observer registers hooks on
 * (the same structural seam pattern as cleanup.ts / gate.ts / status-hud.ts:
 * the real `ExtensionAPI` satisfies it; tests pass a recorder).
 */
export interface FreshnessExtensionApi {
  on(event: 'session_start', handler: (event: unknown, ctx: unknown) => unknown): unknown
  on(event: 'session_shutdown', handler: (event: unknown, ctx: unknown) => unknown): unknown
  on(event: 'tool_call', handler: (event: unknown, ctx: unknown) => unknown): unknown
}

/**
 * Minimal structural slice of the shared cgc runner the lazy auto-sync path
 * uses (the real `CgcRunner` satisfies it): a fire-and-forget spawn that
 * resolves a structured result. The runner's per-workspace dedup is the
 * "dedup with in-flight syncs" guarantee (design D2) — an identical
 * `cgc index .` already running under the workspace is joined, never
 * double-spawned.
 */
export interface FreshnessSyncResult {
  ok: boolean
  /** Structured outcome code (`OK`, `BUSY`, `COMMAND_FAILED`, ...). */
  code: string
  /** Human-readable, single-line description of the outcome. */
  message: string
}

/** Args for one automatic sync — the shared incremental `index` verb. */
export interface FreshnessSyncRunOptions {
  args: readonly string[]
  timeoutMs?: number
}

/** The sync spawn surface (structural; `CgcRunner` satisfies this). */
export interface FreshnessSyncRunner {
  run(cwd: string, options: FreshnessSyncRunOptions): Promise<FreshnessSyncResult>
}

/** Final user-facing freshness notice sink (production: Pi's `ui.notify`). */
export type FreshnessNoticeSink = (text: string, type: 'info' | 'warning' | 'error') => void

/** The slice of the Pi session context the observer reads (defensive narrowing). */
interface FreshnessSessionContext {
  cwd?: unknown
  ui?: unknown
}

interface FreshnessUiContext {
  notify?: unknown
}

export interface FreshnessDriftObserverOptions {
  /**
   * The freshness state store the observer marks (production wires the
   * shared instance from {@link getFreshnessStateStore}).
   */
  store: FreshnessStateStore
  /**
   * The extension's shared cgc runner driving the lazy auto-sync (task 2.1).
   * Omit, or pass undefined, when no runner exists (its construction
   * failed): drift observation still records advisory state but no
   * automatic sync ever spawns (fail-open — the capability degrades to
   * observation-only).
   */
  runner?: FreshnessSyncRunner | undefined
  /**
   * Config `freshness.autoSync` (default true). False disables automatic
   * syncs for the session: drift is recorded and surfaced, but staleness
   * stays advisory only (design D2/D5).
   */
  autoSync?: boolean
  /**
   * Config `freshness.watch` (tri-state, default `off` — design D1 of
   * add-freshness-watch-tri-state):
   * - `off` — no watcher is ever spawned (byte-compatible with the old false).
   * - `on` — CGC's own `cgc watch .` starts as a managed child through the
   *   shared runner at session start, unconditionally on every backend (the
   *   user accepts the trade-offs, including the embedded-backend lock). The
   *   child lands in the runner's live-children set, so every session
   *   cleanup path terminates it. A start blocked by a lock conflict (`BUSY`)
   *   degrades the session back to the lazy mode with a one-time busy notice
   *   under the shared `skipped-busy` condition key.
   * - `auto` — the gated backend-aware mode: the watcher spawns only when the
   *   detected backend is a server backend (neo4j / falkordb-remote), the
   *   workspace is already indexed (never spawn on an unindexed workspace —
   *   the `lifecycle.autoCreate` consent model stays), and the watcher's
   *   liveness is verified (within `watcherLivenessMs`) before the fresh
   *   claim is recorded. Each auto decline surfaces a one-time notice.
   * In every spawning mode the workspace records fresh only AFTER the
   * watcher's liveness is verified — a dead or failed watcher records the
   * honest not-verified state (advisory stale + recorded error) plus a
   * one-time notice, never a false "fresh".
   */
  watch?: WatchMode
  /**
   * Config `freshness.watcherLivenessMs` (default 15000): the
   * liveness-verification budget. After spawning the managed watcher, the
   * observer waits this long for evidence of death; a watcher that settles
   * as failed within the window never yields a fresh record.
   */
  watcherLivenessMs?: number
  /**
   * The CGC backend detector used by `auto` gating (production:
   * {@link createBackendDetector} bound to the configured executable).
   * May return the raw backend name or null (unknown). Omitting it (or an
   * unknown result) resolves to the conservative embedded answer — `auto`
   * never spawns when the backend cannot be determined (fail-open, ADR-0010).
   */
  detectBackend?: () => Promise<string | null> | string | null
  /**
   * Already-indexed check used by `auto` gating; defaults to the filesystem
   * marker check ({@link isWorkspaceIndexed} — the same presence check CGC's
   * own watcher uses for its "Already indexed" verdict). Injectable for tests.
   */
  isIndexed?: (cwd: string) => boolean
  /**
   * Config `freshness.maxSyncsPerSession` (default 2): the per-session cap
   * of automatic syncs (design D3). After the cap, further drift refreshes
   * the advisory state only — no automatic syncs (the denial the task 2.2
   * formality pins, implemented here as the budget gate). The counter is
   * per-session: `session_shutdown` resets it.
   */
  maxSyncsPerSession?: number
  /**
   * Time budget for the automatic sync; defaults to the runner's configured
   * default budget. Overridable for tests and for absorbing CLI verb
   * changes (the drift.ts convention).
   */
  syncTimeoutMs?: number
  /**
   * Fail-closed worktree-isolation gate (wired from the lifecycle gate's
   * `worktreeBlockFor` in isolate mode). Omit, or return null, when worktree
   * isolation is not wired (`off` mode / no session) — observation is then
   * never blocked.
   */
  worktreeBlockFor?: (cwd: string) => FreshnessWorktreeBlock | null
  /**
   * Pi extension API receiving the session and `tool_call` hooks. When
   * omitted (tests driving the observer directly), `register()` is a no-op.
   */
  api?: FreshnessExtensionApi
  /**
   * Observation clock; defaults to `Date.now`. Injectable so tests can drive
   * the recorded timestamps deterministically (the same seam as the HUD's
   * `debounceMs`). Only the observer's own marks use it — values a sync
   * path records later (task 2.x) carry their own `at`.
   */
  now?: () => number
  /**
   * Injectable delay for the liveness-verification window; defaults to a
   * real `setTimeout`. Tests inject an immediate resolution to drive the
   * verification deterministically.
   */
  sleep?: (ms: number) => Promise<void>
}

/**
 * The drift-observation producer (task 1.3). Subscribes to the harness
 * `tool_call` event and marks the session workspace possibly-stale on the
 * first observed file-modifying tool call per stale episode, with burst
 * debouncing and zero detection spawns. Registers no tools and spawns no
 * processes — it only feeds the freshness state store (task 1.2's data
 * layer), which downstream surfaces (HUD, `/cgc status`, proactive tiers)
 * consume. Fail-open everywhere: no hook body throws into pi's event
 * dispatch, and the `tool_call` handler never blocks and never mutates
 * `event.input`.
 */
export class FreshnessDriftObserver {
  private readonly store: FreshnessStateStore
  private readonly worktreeBlockFor: ((cwd: string) => FreshnessWorktreeBlock | null) | undefined
  private api: FreshnessExtensionApi | undefined
  private readonly now: () => number

  private registered = false
  private disposed = false
  /** The session cwd captured from the latest `session_start` (never process.cwd()). */
  private sessionCwd: string | undefined
  private readonly runner: FreshnessSyncRunner | undefined
  private readonly autoSync: boolean
  private readonly maxSyncsPerSession: number
  private readonly syncTimeoutMs: number | undefined
  /** Automatic syncs started this session (the design D3 budget). */
  private syncsThisSession = 0
  /**
   * Config `freshness.watch` — the continuous watcher mode (task 2.4,
   * tri-state per add-freshness-watch-tri-state: off / on / auto).
   */
  private readonly watch: WatchMode
  /** Config `freshness.watcherLivenessMs` — the liveness-verification budget. */
  private readonly watcherLivenessMs: number
  /** The backend detector used by `auto` gating (undefined → conservative no-spawn). */
  private readonly detectBackend: (() => Promise<string | null> | string | null) | undefined
  /** The already-indexed check used by `auto` gating. */
  private readonly isIndexed: (cwd: string) => boolean
  /** Injectable delay seam for the liveness-verification window (tests). */
  private readonly sleep: (ms: number) => Promise<void>
  /** Cached per-session backend detection (one bounded probe per session). */
  private backendPromise: Promise<string | null> | undefined
  /**
   * True while the managed watcher is running (from its spawn until it
   * settles). While active it owns freshness: drift marks are suppressed and
   * lazy syncs are skipped (task 2.4).
   */
  private watcherActive = false
  /**
   * True once this session's watcher attempt settled as failed (one attempt
   * per session, task 3.2's retry cap): the mode degraded to lazy behavior
   * and is not re-attempted until the next session.
   */
  private watcherFailed = false
  /**
   * True once the running watcher passed liveness verification (the fresh
   * claim is recorded only after this). A settle before verification is the
   * honest not-verified case; a verified death keeps the today behavior
   * (the next observed edit re-opens the episode and lazy mode takes over).
   */
  private watcherVerified = false
  /**
   * Pi's `ui.notify` captured at session start (design D4 notice sink; the
   * user-facing notice surface — never the agent context, ADR-0002).
   */
  private sessionNotify: FreshnessNoticeSink | undefined
  /** Notice condition keys surfaced this session (design D4: once per key). */
  private readonly noticesEmitted = new Set<string>()

  /**
   * Event-subscription failures from `register()` (task 3.2: the spec's
   * "event subscription failure" error class). No session cwd exists at
   * registration time, so the messages are deferred and recorded into the
   * store at the next `session_start`. Registration is once per process and
   * never re-attempted (task 3.2's retry cap).
   */
  private readonly registrationErrors: string[] = []

  constructor(options: FreshnessDriftObserverOptions) {
    this.store = options.store
    this.worktreeBlockFor = options.worktreeBlockFor
    this.api = options.api
    this.now = options.now ?? Date.now
    this.runner = options.runner
    this.autoSync = options.autoSync ?? true
    this.maxSyncsPerSession = options.maxSyncsPerSession ?? 2
    this.watch = options.watch ?? 'off'
    this.watcherLivenessMs = options.watcherLivenessMs ?? DEFAULT_WATCHER_LIVENESS_MS
    this.detectBackend = options.detectBackend
    this.isIndexed = options.isIndexed ?? isWorkspaceIndexed
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.syncTimeoutMs = options.syncTimeoutMs
  }

  /**
   * Wire the session and `tool_call` hooks. Idempotent and fail-open: a
   * broken API never throws out of registration (each hook is also
   * individually guarded). No-op after `dispose()`.
   *
   * Session rebind (add-cgc-session-rebind): when `api` is supplied and
   * differs from the API this observer is wired to (pi re-runs the factory on
   * every session replacement), adopt it, re-arm the registration flag, and
   * wire the hooks onto the new API. The same API stays the idempotent no-op.
   */
  register(api?: FreshnessExtensionApi): void {
    if (this.disposed) return
    if (api !== undefined && api !== this.api) {
      // Session replacement: adopt the fresh API and re-arm registration.
      this.api = api
      this.registered = false
    }
    if (this.registered) return
    this.registered = true
    const target = this.api
    if (target === undefined) return
    try {
      target.on('session_start', this.handleSessionStart)
    } catch (error) {
      // Fail-open: extension load must never break on a throwing API. The
      // failure is recorded (task 3.2), deferred until a session start
      // provides a workspace to key the error on.
      this.registrationErrors.push(errorMessage(error, 'subscribe session_start'))
    }
    try {
      target.on('session_shutdown', this.handleSessionShutdown)
    } catch (error) {
      this.registrationErrors.push(errorMessage(error, 'subscribe session_shutdown'))
    }
    try {
      target.on('tool_call', this.handleToolCall)
    } catch (error) {
      this.registrationErrors.push(errorMessage(error, 'subscribe tool_call'))
    }
  }

  /**
   * Mark the observer inert (the Pi API has no hook-removal surface, so the
   * registered handlers become no-ops). Idempotent; for tests and reload
   * paths.
   */
  dispose(): void {
    this.disposed = true
    this.registered = false
  }

  /**
   * Session-start hook body: capture the Pi session cwd (ctx.cwd — the same
   * source the gate's workspace resolution uses; never `process.cwd()`).
   * Never throws.
   */
  private readonly handleSessionStart = (_event: unknown, ctx: unknown): void => {
    if (this.disposed) return
    try {
      const context = (ctx ?? {}) as FreshnessSessionContext
      this.sessionCwd =
        typeof context.cwd === 'string' && context.cwd.length > 0 ? context.cwd : undefined
      // Capture the user-facing notice sink (design D4) from the session
      // context's `ui.notify` — the same seam the lifecycle gate uses. A
      // missing or malformed sink is a no-op (fail-open); a throwing sink is
      // contained at notify time.
      const ui = (context.ui ?? {}) as FreshnessUiContext
      this.sessionNotify =
        typeof ui.notify === 'function'
          ? (ui.notify as (text: string, type: 'info' | 'warning' | 'error') => void)
          : undefined
      // Task 3.2: record any event-subscription failures deferred from
      // registration (no workspace existed to key them on at register time).
      // Best-effort and fail-open — a broken store cannot break session
      // start, and the deferred list drains once recorded.
      if (this.registrationErrors.length > 0) {
        const deferredCwd = this.sessionCwd
        if (deferredCwd !== undefined) {
          for (const message of this.registrationErrors) {
            this.recordError(deferredCwd, message)
          }
          this.registrationErrors.length = 0
        }
      }
      // Task 2.4: the opt-in continuous watcher (design D2). Starts at
      // session start so the workspace graph stays incrementally current for
      // the whole session; fire-and-forget, guarded fail-open.
      this.startWatcherIfEnabled()
    } catch {
      // Fail-open: a session_start hook body must never throw.
    }
  }

  /**
   * Session-shutdown hook body: drop the session cwd and reset the shared
   * store so no session carries freshness state into the next one (and
   * listeners are dropped — the store emits nothing further). Never throws.
   */
  private readonly handleSessionShutdown = (): void => {
    if (this.disposed) return
    try {
      this.sessionCwd = undefined
      // Drop the notice sink and clear the once-per-condition latch with the
      // session: design D4 notices are per-session (the next session may
      // notify again) and the sink is stale after teardown.
      this.sessionNotify = undefined
      this.noticesEmitted.clear()
      // Reset the per-session auto-sync budget alongside the store: no
      // session may spend the next session's slots (design D3).
      this.syncsThisSession = 0
      // The watcher attempt is per-session too (task 2.4, design D2):
      // whatever happened this session (running, blocked, failed), the next
      // session starts fresh. A still-live child is the runner's teardown
      // paths' job — its late settle no-ops on the cleared flags. The
      // backend detection cache is per-session as well (one bounded probe
      // per session, design D2 of add-freshness-watch-tri-state).
      this.watcherActive = false
      this.watcherFailed = false
      this.watcherVerified = false
      this.backendPromise = undefined
      this.store.reset()
    } catch {
      // Fail-open: shutdown must never throw.
    }
  }

  /**
   * The drift-observation point (design D1). Marks the session workspace
   * possibly-stale on the FIRST observed file-modifying tool call of a stale
   * episode (current status fresh — or nothing recorded yet), debouncing
   * bursts: while the episode is already flagged (possibly-stale, syncing,
   * skipped-busy, disabled) no further record happens and no state is
   * clobbered — the stale flag and the first-mark `staleSince` are kept.
   * The episode-opening mark also surfaces the once-per-session stale notice
   * (task 3.1, design D4). Never blocks the tool and never mutates
   * `event.input`: this handler always returns undefined. Never throws — an
   * observation error is recorded (task 3.2) and the tool proceeds
   * (fail-open, ADR-0007).
   */
  private readonly handleToolCall = (event: unknown): unknown => {
    if (this.disposed) return undefined
    let cwd: string | undefined
    try {
      if (!isFileModifyingCall(event)) return undefined
      cwd = this.sessionCwd
      if (cwd === undefined) return undefined
      if (this.isBlocked(cwd)) return undefined
      // Task 2.4: while the managed watcher runs it owns freshness (design
      // D2) — the graph is kept current incrementally, so session edits open
      // no stale episode (the state stays fresh). After a degraded settle
      // (`watcherFailed`) this check passes again and the lazy mode resumes.
      if (this.watcherActive) return undefined
      const current = this.store.snapshot(cwd)
      // First mark of the episode only: a snapshot that is null (nothing
      // recorded yet) or fresh (episode ended by a completed sync) is the
      // state that opens a stale episode; any other status is already
      // flagged or in an active sync/busy/disabled state.
      if (current !== null && current.status !== 'fresh') return undefined
      this.store.recordStatus({ cwd, status: 'possibly-stale', at: this.now() })
      // Task 3.1 (design D4): the stale condition is human-visible — one
      // once-per-session notice naming the manual sync option (`/cgc sync`).
      // The notifyOnce latch makes this session-scoped, never per-episode;
      // the watcher-active early return above and the gate's blocked check
      // guarantee this never fires while the managed watcher owns freshness
      // or for a workspace the gate refuses to verify.
      this.notifyOnce('possibly-stale', buildPossiblyStaleNotice(cwd), 'warning')
      // Task 2.1: the lazy-drift sync trigger. The same mark that opens the
      // stale episode feeds the budgeted background sync; the helper is
      // guarded and never blocks or mutates the tool call. Zero probing
      // still holds: the sync is a maintenance spawn, not a detection one.
      this.maybeStartSync(cwd)
    } catch (error) {
      // Fail-open: an observation error must never reach pi's event dispatch
      // — the tool proceeds untouched. Task 3.2: the error is RECORDED
      // (best-effort; a broken store is contained by recordError).
      if (cwd !== undefined) {
        this.recordError(cwd, errorMessage(error, 'drift observation failed'))
      }
    }
    return undefined
  }

  /**
   * The lazy-drift sync trigger (task 2.1, design D2/D3). When auto-sync is
   * on, a runner is available, the worktree gate does not block the
   * workspace, and the per-session budget is not exhausted, start ONE
   * background incremental sync — fire-and-forget, never awaited from a hook
   * body — and record its progress through the store. The slot is consumed
   * BEFORE the spawn (the drift.ts convention): no failure path can loop
   * around the per-session cap. Guarded fail-open: no path here may throw
   * into the `tool_call` handler.
   */
  private maybeStartSync(cwd: string): void {
    try {
      if (!this.autoSync) return
      const runner = this.runner
      if (runner === undefined) return
      if (this.isBlocked(cwd)) return
      // Task 2.4: while the watcher runs it owns the embedded database — a
      // lazy sync would only contend on its lock (and burn a budget slot).
      if (this.watcherActive) return
      if (this.syncsThisSession >= this.maxSyncsPerSession) return
      this.syncsThisSession += 1
      this.startSync(runner, cwd)
    } catch (error) {
      // Fail-open: a sync trigger must never reach pi's event dispatch. The
      // error is recorded (task 3.2) so containment stays observable.
      this.recordError(cwd, errorMessage(error, 'auto-sync trigger failed'))
    }
  }

  /**
   * Start the background incremental sync for the workspace and record
   * progress (`syncing`) until it settles (design D2's
   * `syncing → fresh | skipped-busy | stale`). Fire-and-forget by design:
   * the hook body never awaits cgc. Dedup: the shared runner coalesces an
   * identical in-flight `cgc index .` for the same workspace, so a sync the
   * gate or `/cgc index` already started is joined, never double-spawned.
   * Never throws — a run that rejects or a runner that throws synchronously
   * settles as an unsuccessful sync (fail-open, ADR-0007).
   */
  private startSync(runner: FreshnessSyncRunner, cwd: string): void {
    // Progress state: the workspace is syncing until the run settles.
    this.store.recordStatus({ cwd, status: 'syncing', at: this.now() })
    const options: FreshnessSyncRunOptions = { args: AUTO_SYNC_ARGS }
    if (this.syncTimeoutMs !== undefined) options.timeoutMs = this.syncTimeoutMs
    let run: Promise<FreshnessSyncResult>
    try {
      run = runner.run(cwd, options)
    } catch (error) {
      // A synchronously-throwing runner is a caller contract breach; fail
      // open with an unsuccessful sync that keeps the advisory stale state.
      run = Promise.resolve({
        ok: false,
        code: 'COMMAND_FAILED',
        message: `background freshness sync failed to start: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    // The tracking promise is always consumed so a rejection can never
    // surface as an unhandled rejection; settlement records into the store.
    void (async () => {
      let result: FreshnessSyncResult
      try {
        result = await run
      } catch (error) {
        result = {
          ok: false,
          code: 'COMMAND_FAILED',
          message: `background freshness sync failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      this.settleSync(cwd, result)
    })().catch(() => undefined)
  }

  /**
   * Record the settled outcome of a background sync (design D5 state
   * machine). A `BUSY` outcome (another CGC process holds the embedded
   * database) records `skipped-busy`, keeps the stale episode — the
   * store leaves timestamps alone for that status, so the first-mark
   * `staleSince` is never clobbered — and surfaces the one-time busy
   * notice naming the conflict (task 2.3, design D4). A successful run
   * ends the episode `fresh` (sets `lastSyncedAt`, clears `staleSince`)
   * and surfaces the one-time completion notice (task 3.1, design D4).
   * Any other failure keeps the advisory `possibly-stale` state — the
   * workspace never reports fresh until a sync completes successfully
   * — and, because the stale episode stays open, no automatic retry
   * fires this session. Never throws.
   */
  private settleSync(cwd: string, result: FreshnessSyncResult): void {
    try {
      if (result.code === 'BUSY') {
        this.store.recordStatus({ cwd, status: 'skipped-busy', at: this.now() })
        // Task 2.3: the skip is visible — one human-facing notice per session
        // naming the conflict (design D4; this `skipped-busy` key is shared
        // with the future watcher-blocked case, task 2.4). The notice names
        // the holding process when the runner's BUSY message knows it.
        const detail =
          typeof result.message === 'string' && result.message.length > 0
            ? result.message
            : undefined
        this.notifyOnce('skipped-busy', buildSkippedBusyNotice(cwd, detail), 'warning')
        return
      }
      if (result.ok) {
        this.store.recordStatus({ cwd, status: 'fresh', at: this.now() })
        // Task 3.1 (design D4): the completion is human-visible — one
        // once-per-session notice under its own `sync-completed` condition
        // key, distinct from the earlier stale notice. Fail-open: a missing
        // or throwing sink never breaks settlement (notifyOnce contains it).
        this.notifyOnce('sync-completed', buildSyncCompletedNotice(cwd), 'info')
        return
      }
      this.store.recordStatus({ cwd, status: 'possibly-stale', at: this.now() })
      // Task 3.2: the spawn/run failure is RECORDED (it is not a BUSY skip;
      // the workspace stays advisory stale and no automatic retry fires this
      // episode). The runner's message names the failure when known.
      const reason =
        typeof result.message === 'string' && result.message.length > 0
          ? result.message
          : 'background sync failed'
      this.recordError(cwd, reason)
    } catch (error) {
      // Fail-open: settlement must never reject the background tracking
      // promise (the caller's safety net catches it regardless). Task 3.2:
      // best-effort record of the settlement failure itself.
      this.recordError(cwd, errorMessage(error, 'sync settlement failed'))
    }
  }

  /**
   * The continuous watcher start point (task 2.4, tri-state per
   * add-freshness-watch-tri-state):
   * - `off` — never spawns (no detection, no spawn; byte-compatible with the
   *   old boolean false).
   * - `on` — spawns unconditionally when a runner is available and the
   *   worktree gate does not block the workspace (byte-compatible with the
   *   old boolean true; the user accepts the embedded-backend lock).
   * - `auto` — spawns only when ALL gated conditions hold: the detected
   *   backend is a server backend (unknown → conservative no-spawn), and the
   *   workspace is already indexed (never spawn on an unindexed workspace —
   *   the `lifecycle.autoCreate` consent model stays). Each decline surfaces
   *   a one-time notice so the conservative default is observable.
   * The spawn is one attempt per session (task 3.2's retry cap); on any
   * failure the mode degrades to the lazy auto-sync behavior. The gating is
   * async but fire-and-forget: nothing here blocks or throws into
   * `session_start`, and the backend detection runs at most once per session.
   */
  private startWatcherIfEnabled(): void {
    // Fire-and-forget the async gating: the `on` path runs synchronously up
    // to the spawn (so spawn calls are recorded synchronously), the `auto`
    // path awaits the bounded backend detection. Never awaited by the hook.
    void this.startWatcherGated().catch(() => undefined)
  }

  private async startWatcherGated(): Promise<void> {
    let cwd: string | undefined
    try {
      if (this.disposed) return
      if (this.watch === 'off') return
      if (this.watcherActive || this.watcherFailed) return
      cwd = this.sessionCwd
      if (cwd === undefined) return
      if (this.isBlocked(cwd)) return
      const runner = this.runner
      if (runner === undefined) return
      if (this.watch === 'auto') {
        const backend = await this.resolveBackend()
        if (!isServerBackend(backend)) {
          // Conservative decline (ADR-0010): embedded or unknown backend.
          this.notifyOnce(
            'watcher-not-started-embedded',
            buildWatcherNotStartedEmbeddedNotice(cwd, backend),
            'info',
          )
          return
        }
        if (!this.isIndexed(cwd)) {
          // Consent decline: watching never implies creating (ADR-0010).
          this.notifyOnce(
            'watcher-not-started-unindexed',
            buildWatcherNotStartedUnindexedNotice(cwd),
            'info',
          )
          return
        }
      }
      this.watcherActive = true
      this.startWatcher(runner, cwd)
    } catch (error) {
      // Fail-open: a watcher start must never reach the session-start path.
      // The attempt is spent for the session (task 3.2's retry cap) and the
      // error is recorded; the mode falls back to lazy behavior so drift
      // observation and the budgeted syncs resume normally.
      this.watcherActive = false
      this.watcherFailed = true
      if (cwd !== undefined) {
        this.recordError(cwd, errorMessage(error, 'watcher start failed'))
      }
    }
  }

  /**
   * Resolve the CGC backend for `auto` gating (design D2 of
   * add-freshness-watch-tri-state): the injected detector when wired,
   * else null (unknown → conservative embedded). The result is cached per
   * session — one bounded probe, never a per-session-start storm.
   */
  private resolveBackend(): Promise<string | null> {
    const detector = this.detectBackend
    if (detector === undefined) return Promise.resolve(null)
    this.backendPromise ??= Promise.resolve().then(() => detector())
    return this.backendPromise
  }

  /**
   * Spawn the managed watcher child. The workspace is NOT recorded fresh
   * here — that claim now follows liveness verification (design D4 of
   * add-freshness-watch-tri-state): the tracking promise resolves only when
   * the watcher exits, so "settled within the verification window" is the
   * observable death signal. After the spawn, {@link verifyWatcherLiveness}
   * waits the `freshness.watcherLivenessMs` budget: survival records fresh
   * (the watcher keeps the graph incrementally current, so session edits
   * open NO stale episode and no lazy sync runs — they would only contend on
   * the lock a watcher holds); an early settle is handled by
   * {@link settleWatcher} as the honest not-verified case. The run is
   * fire-and-forget with a long time budget (a watcher outlives any index
   * command yet is still subject to the runner's termination paths). Never
   * throws — a synchronously-throwing runner degrades to lazy mode.
   */
  private startWatcher(runner: FreshnessSyncRunner, cwd: string): void {
    const options: FreshnessSyncRunOptions = {
      args: WATCHER_ARGS,
      timeoutMs: WATCHER_TIMEOUT_MS,
    }
    let run: Promise<FreshnessSyncResult>
    try {
      run = runner.run(cwd, options)
    } catch (error) {
      // A synchronously-throwing runner is a caller contract breach; fail
      // open with the watcher absent and lazy mode resumed for the session.
      // The failure is recorded (task 3.2) — the one-attempt latch keeps it
      // from being re-tried this session.
      this.watcherActive = false
      this.watcherFailed = true
      this.recordError(cwd, errorMessage(error, 'managed watcher failed to start'))
      return
    }
    let settled = false
    void (async () => {
      let result: FreshnessSyncResult
      try {
        result = await run
      } catch (error) {
        result = {
          ok: false,
          code: 'COMMAND_FAILED',
          message: `managed watcher failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      // Set the observable death flag BEFORE settlement handling, so the
      // liveness verifier can never record fresh for a watcher that exited.
      settled = true
      this.settleWatcher(cwd, result)
    })().catch(() => undefined)
    void this.verifyWatcherLiveness(cwd, () => settled).catch(() => undefined)
  }

  /**
   * The liveness-verification pass (design D4 of
   * add-freshness-watch-tri-state): after the verification budget expires
   * with the watcher still running (never settled as failed), record fresh
   * and surface the one-time watcher-start notice — the verifiable "alive
   * and watching" contract (CGC exposes no queryable watcher registry in
   * v0.6.x, so process survival past the budget IS the verifiable claim). A
   * watcher that settled during the window is skipped — settlement already
   * recorded the honest state. A session that ended (or rebound to another
   * cwd) during the window records nothing. Never throws (callers catch).
   */
  private async verifyWatcherLiveness(cwd: string, isSettled: () => boolean): Promise<void> {
    await this.sleep(this.watcherLivenessMs)
    if (this.disposed) return
    if (this.sessionCwd !== cwd) return
    if (isSettled() || !this.watcherActive || this.watcherVerified) return
    this.watcherVerified = true
    try {
      this.store.recordStatus({ cwd, status: 'fresh', at: this.now() })
    } catch {
      // Fail-open: a broken store never blocks the notice below.
    }
    this.notifyOnce('watcher-started', buildWatcherStartedNotice(cwd), 'info')
  }

  /**
   * Settle the watcher's run: the watcher died or was terminated. The
   * watcher attempt is a per-session, one-shot capability (task 3.2's retry
   * cap): on ANY settle the session degrades to the lazy mode behavior —
   * drift observation resumes and the budgeted automatic sync path is
   * re-enabled (new episodes from the next session-start reconciliation). A
   * `BUSY` settle is the lock-blocked start (design D2 / spec: another CGC
   * process holds the embedded database): the one-time notice names the
   * conflict under the SHARED `skipped-busy` condition key (the same
   * once-per-session budget as the lazy-sync busy skip, design D4) and the
   * state store is left untouched — the next edit opens a normal episode
   * the lazy path can act on. A settle BEFORE liveness verification passed
   * is the honest not-verified case (design D4 of
   * add-freshness-watch-tri-state): the workspace records advisory stale
   * plus the recorded failure and a one-time notice — never a false
   * "fresh". A verified watcher's later death records the error only (the
   * status stays fresh until the next observed edit re-opens the episode
   * and the lazy path takes over). Session teardown (`CANCELLED`) lands
   * after the store's reset and records nothing. Never throws.
   */
  private settleWatcher(cwd: string, result: FreshnessSyncResult): void {
    try {
      if (!this.watcherActive) return
      this.watcherActive = false
      this.watcherFailed = true
      if (result.code === 'BUSY') {
        const detail =
          typeof result.message === 'string' && result.message.length > 0
            ? result.message
            : undefined
        this.notifyOnce('skipped-busy', buildWatcherBlockedNotice(cwd, detail), 'warning')
        return
      }
      // Task 3.2: a spawn/command failure is recorded (an OK exit or session
      // teardown is not an error; a BUSY settle returned above — that skip
      // is a condition, not an error).
      if (!result.ok) {
        this.recordError(
          cwd,
          typeof result.message === 'string' && result.message.length > 0
            ? result.message
            : 'managed watcher failed',
        )
      }
      if (result.code === 'CANCELLED') return
      if (this.watcherVerified) return
      // Unverified failure: the honest not-verified state (design D4 of
      // add-freshness-watch-tri-state) — advisory stale plus the failure
      // already recorded above, and a one-time notice. No false "fresh".
      this.store.recordStatus({ cwd, status: 'possibly-stale', at: this.now() })
      const detail =
        typeof result.message === 'string' && result.message.length > 0 ? result.message : undefined
      this.notifyOnce('watcher-not-verified', buildWatcherNotVerifiedNotice(cwd, detail), 'warning')
    } catch (error) {
      // Fail-open: watcher settlement must never reject the tracking promise.
      // Task 3.2: best-effort record of the settlement failure itself.
      this.recordError(cwd, errorMessage(error, 'watcher settlement failed'))
    }
  }

  /**
   * Surface a human-facing notice at most once per condition key per session
   * (design D4: the notice keys are possibly-stale, skipped-busy and
   * sync-completed; `skipped-busy` is shared with the watcher-blocked case,
   * task 2.4). The sink is the session context's `ui.notify` captured
   * at session start — the user-facing notice surface, never the agent
   * context (ADR-0002). Fail-open: a missing or throwing sink never reaches
   * event dispatch.
   */
  private notifyOnce(key: string, text: string, type: 'info' | 'warning' | 'error'): void {
    if (this.noticesEmitted.has(key)) return
    this.noticesEmitted.add(key)
    try {
      this.sessionNotify?.(text, type)
    } catch {
      // Fail-open: a throwing notify sink must never break settlement.
    }
  }

  /**
   * Record an error message for the session workspace without touching the
   * status literal (task 3.2's "the error is recorded" half of fail-open
   * containment; the store's `recordError` does the write). Never throws — a
   * broken or missing store method must never surface from a hook body.
   */
  private recordError(cwd: string, message: string): void {
    try {
      this.store.recordError({ cwd, message, at: this.now() })
    } catch {
      // Fail-open: recording an error must never itself throw.
    }
  }

  /** Whether the session workspace is fail-closed by worktree isolation. */
  private isBlocked(cwd: string): boolean {
    try {
      const block = this.worktreeBlockFor === undefined ? null : this.worktreeBlockFor(cwd)
      return block !== null && block.blocked === true
    } catch {
      // Fail-open: a broken block surface never stops observation (the
      // gate's own worktreeBlockFor already returns null on errors).
      return false
    }
  }
}

/**
 * One-line error text for the store's `lastError` (task 3.2). Never itself
 * throws — the fail-open containment it reports must not start a new one.
 */
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && typeof error.message === 'string' && error.message.length > 0
    ? `${fallback}: ${error.message}`
    : fallback
}

/** Narrow the `tool_call` event to its tool name without touching input. */
function isFileModifyingCall(event: unknown): boolean {
  const call = (event ?? {}) as { toolName?: unknown }
  return typeof call.toolName === 'string' && isFileModifyingTool(call.toolName)
}

let cachedFreshnessStore: FreshnessStateStore | undefined

/**
 * The incremental sync command the lazy auto-sync path runs (design D2:
 * `cgc index` is incremental by default — it reconciles only files changed
 * since the graph was last updated — so the drift sync shares the verb with
 * `/cgc index` and the gate's start-time drift path, run with cwd set to
 * the session workspace).
 */
export const AUTO_SYNC_ARGS: readonly string[] = ['index', '.']

/**
 * The continuous watcher command the opt-in watcher mode runs (task 2.4,
 * design D2): `cgc watch .` from the session workspace — CGC's own
 * foreground watcher that incrementally indexes file changes (verified
 * against the installed `cgc watch --help`: `cgc watch .` watches the
 * current directory). Spawned through the shared runner so it lands in the
 * runner's live-children set and every session cleanup path terminates it.
 */
export const WATCHER_ARGS: readonly string[] = ['watch', '.']

/**
 * Time budget for the managed watcher child (task 2.4): 24h — long enough
 * that no realistic session expires it (the watcher is terminated by the
 * session cleanup paths, not by its time budget), short enough that a
 * runaway watcher cannot hold the embedded database forever.
 */
export const WATCHER_TIMEOUT_MS = 24 * 60 * 60 * 1000

/**
 * Default liveness-verification budget for the managed watcher (design D4 of
 * add-freshness-watch-tri-state; config `freshness.watcherLivenessMs`): long
 * enough that a watcher that survives it is genuinely running, short enough
 * that the fresh claim lands promptly after session start.
 */
export const DEFAULT_WATCHER_LIVENESS_MS = 15_000

/**
 * Hard budget for the `cgc doctor` backend-detection probe (design D2 of
 * add-freshness-watch-tri-state): doctor runs CGC's own diagnostics (including
 * database connectivity checks), so the probe must be bounded. A timeout or
 * failure falls through to the next detection source, never blocks session
 * start, and never spawns a watcher on its own.
 */
export const BACKEND_DETECT_TIMEOUT_MS = 5_000

/**
 * The SERVER backends (design D2 of add-freshness-watch-tri-state): the only
 * backends where `auto` mode may spawn the watcher. The watcher-defaults
 * research (source-verified lock semantics plus empirical probes) established
 * that the exclusive process-scoped lock is an embedded-backend property — on
 * these backends the watcher, the CGC MCP server, and index runs coexist.
 * EVERY other value — kuzudb, falkordb (local), ladybugdb, nornic, unknown —
 * is treated as embedded/conservative: `auto` never spawns on it.
 */
export const SERVER_BACKENDS: ReadonlySet<string> = new Set(['neo4j', 'falkordb-remote'])

/**
 * Whether a backend name is a server backend (case-insensitive, trimmed).
 * Unknown/null are false — the conservative embedded answer (fail-open to
 * no-spawn, ADR-0010).
 */
export function isServerBackend(name: string | null | undefined): boolean {
  if (name === null || name === undefined) return false
  return SERVER_BACKENDS.has(name.trim().toLowerCase())
}

/** Normalize a backend-name candidate: trimmed lowercase, empty → null. */
function normalizeBackendName(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const value = raw.trim().toLowerCase()
  return value.length > 0 ? value : null
}

/**
 * Parse CGC's doctor output for the resolved backend (design D2 of
 * add-freshness-watch-tri-state): the `Default database: <name>` line that
 * `cgc doctor` prints for the database it resolved through its own full
 * precedence chain (runtime env → context database → merged .env →
 * auto-detect; verified against CGC v0.6.13's cli/main.py). Returns null when
 * the line is absent.
 */
export function parseDoctorBackend(output: string): string | null {
  const match = /Default database:\s*([^\s(]+)/i.exec(output ?? '')
  return normalizeBackendName(match?.[1])
}

/**
 * Parse a CGC .env file's text for the backend keys CGC itself honors
 * (`DATABASE_TYPE` / `DEFAULT_DATABASE`; verified against CGC v0.6.13's
 * database-selection precedence). The LAST occurrence wins (dot-env override
 * convention); optional surrounding quotes are stripped; anything unparseable
 * yields null.
 */
export function parseEnvFileBackend(text: string): string | null {
  if (typeof text !== 'string' || text.length === 0) return null
  let found: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (key !== 'DATABASE_TYPE' && key !== 'DEFAULT_DATABASE') continue
    let value = trimmed.slice(eq + 1).trim()
    const hasMatchingQuotes =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    if (hasMatchingQuotes) {
      value = value.slice(1, -1)
    }
    found = normalizeBackendName(value) ?? found
  }
  return found
}

/** Injectable spawn-text seam for the doctor probe (tests pass a fake). */
export type BackendProbe = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string | null>

/** Injectable file-read seam for the .env fallback (tests pass a fake). */
export type BackendFileReader = (path: string) => string | undefined

export interface BackendDetectionOptions {
  /** The cgc executable to probe (default `cgc`, resolved against PATH). */
  executable?: string
  /** Home directory for the `.codegraphcontext/.env` fallback (default os.homedir()). */
  homeDir?: string
  /**
   * Environment consulted for CGC's runtime database overrides before any
   * spawn (`CGC_RUNTIME_DB_TYPE`, then `DATABASE_TYPE` / `DEFAULT_DATABASE`,
   * mirroring CGC's own precedence). Defaults to `process.env`.
   */
  env?: Record<string, string | undefined>
  /** The doctor probe budget (default {@link BACKEND_DETECT_TIMEOUT_MS}). */
  doctorTimeoutMs?: number
  /** Injectable probe seam (default: a real bounded `cgc doctor` spawn). */
  probe?: BackendProbe
  /** Injectable file-read seam (default: a synchronous existsSync+read). */
  readTextFile?: BackendFileReader
}

/**
 * The bounded CGC backend-detection helper (design D2 of
 * add-freshness-watch-tri-state). Resolution order mirrors CGC's own
 * database-selection precedence (verified against CGC v0.6.13 source):
 *   1. `CGC_RUNTIME_DB_TYPE` (CGC's runtime override),
 *   2. `DATABASE_TYPE` / `DEFAULT_DATABASE` from the environment,
 *   3. `cgc doctor`'s `Default database:` line (preferred over the .env read:
 *      doctor resolves CGC's full chain — context database, merged .env,
 *      auto-detect — itself), bounded by `doctorTimeoutMs`, any failure
 *      falling through,
 *   4. `DATABASE_TYPE` / `DEFAULT_DATABASE` from `~/.codegraphcontext/.env`,
 *   5. null — unknown. Callers treat unknown as embedded (conservative
 *      no-spawn; fail-open, ADR-0010). Never throws.
 */
export async function detectCgcBackend(
  options: BackendDetectionOptions = {},
): Promise<string | null> {
  try {
    const env = options.env ?? process.env
    // 1–2: runtime overrides (cheap, and CGC's own top precedence).
    const runtime =
      normalizeBackendName(env['CGC_RUNTIME_DB_TYPE']) ??
      normalizeBackendName(env['DATABASE_TYPE']) ??
      normalizeBackendName(env['DEFAULT_DATABASE'])
    if (runtime !== null) return runtime
    // 3: the bounded doctor probe.
    const probe =
      options.probe ?? ((command, args, timeoutMs) => runDoctorProbe(command, args, timeoutMs))
    const doctorOutput = await probe(
      options.executable ?? 'cgc',
      ['doctor'],
      options.doctorTimeoutMs ?? BACKEND_DETECT_TIMEOUT_MS,
    )
    const fromDoctor = parseDoctorBackend(doctorOutput ?? '')
    if (fromDoctor !== null) return fromDoctor
    // 4: the .env fallback.
    const read = options.readTextFile ?? readEnvFileText
    const envText = read(join(options.homeDir ?? homedir(), '.codegraphcontext', '.env'))
    return parseEnvFileBackend(envText ?? '')
  } catch {
    // Fail-open: detection must never throw — unknown is the safe answer.
    return null
  }
}

/**
 * The production doctor probe: one bounded `cgc doctor` spawn. Resolves the
 * combined output when the process produced any within the budget, null on
 * spawn failure or timeout — the caller falls through to the next source.
 */
async function runDoctorProbe(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        finish(output.length > 0 ? output : null)
      }, timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
      })
      child.on('error', () => {
        clearTimeout(timer)
        finish(null)
      })
      child.on('close', () => {
        clearTimeout(timer)
        finish(output.length > 0 ? output : null)
      })
    } catch {
      finish(null)
    }
  })
}

/** Synchronous .env read for the fallback source (missing/unreadable → undefined). */
function readEnvFileText(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * The production backend detector for the observer's `auto` gating: bound to
 * the configured executable and environment once, invoked at most once per
 * session by the observer's cache.
 */
export function createBackendDetector(
  options: Pick<BackendDetectionOptions, 'executable' | 'env'> = {},
): () => Promise<string | null> {
  return () => detectCgcBackend(options)
}

/**
 * The one-time skip-as-busy notice (task 2.3, design D4): when the embedded
 * database is locked by another CGC process at sync-settle time, the skip is
 * visible, the conflict named (the runner's BUSY message when known), and
 * nothing was modified. The stale episode stays open and no automatic retry
 * fires this session — the manual options are named instead.
 */
export function buildSkippedBusyNotice(cwd: string, detail?: string): string {
  const detected = detail ? `Detected state: ${detail}.` : undefined
  return [
    `CGC freshness: the automatic index sync for ${cwd} was skipped — another CGC process is holding the embedded database.`,
    ...(detected ? [detected] : []),
    'Nothing was modified and no automatic retry will fire this session; the workspace stays advisory-stale until a sync completes. Stop the other CGC process (for example a running `cgc watch` or the CGC MCP server) when you want the sync, or run it manually (`cgc index .` or `/cgc sync`).',
    'You will not be notified again for this condition this session.',
  ].join('\n')
}

/**
 * The one-time watcher-start-blocked notice (task 2.4, design D4): when a
 * continuous `cgc watch` cannot start because another CGC process holds the
 * embedded database, the conflict is named, freshness degrades to the lazy
 * mode behavior for the session (drift observation and the budgeted
 * automatic sync resume), and the manual options are stated. Fires under
 * the SAME `skipped-busy` condition key as the lazy-sync busy skip (shared
 * once-per-session budget, design D4) with watcher-specific text.
 */
export function buildWatcherBlockedNotice(cwd: string, detail?: string): string {
  const detected = detail ? `Detected state: ${detail}.` : undefined
  return [
    `CGC freshness: the continuous watcher for ${cwd} could not start — another CGC process is holding the embedded database.`,
    ...(detected ? [detected] : []),
    'Nothing started and nothing was modified; freshness degrades to the lazy mode for this session (the automatic index sync still runs on first observed drift, within the session budget). Stop the other CGC process (for example a running `cgc watch` or the CGC MCP server) when you want continuous watching, or run the sync manually (`cgc index .` or `/cgc sync`).',
    'You will not be notified again for this condition this session.',
  ].join('\n')
}

/**
 * The one-time watcher-start notice (design D5 of
 * add-freshness-watch-tri-state): the fresh claim is only recorded AFTER
 * liveness verification, and the user sees ONE confirmation that the managed
 * watcher is running and verified (condition key `watcher-started`).
 */
export function buildWatcherStartedNotice(cwd: string): string {
  return [
    `CGC freshness: the continuous watcher for ${cwd} is running — it was verified alive and is keeping the graph current.`,
    'Session edits will not mark the workspace stale while it runs; stop it (or set freshness.watch to off) to return to the lazy sync mode.',
    'You will not be notified again for this condition this session.',
  ].join('\n')
}

/**
 * The one-time auto-decline notice for an embedded/unknown backend (design
 * D5 of add-freshness-watch-tri-state): `auto` never spawns on an embedded
 * backend (the watcher would lock the user's own CGC processes out) or on an
 * unknown backend (fail-open to the conservative answer) — the decline is
 * observable, once per session, with the `on` escape hatch named.
 */
export function buildWatcherNotStartedEmbeddedNotice(cwd: string, backend?: string | null): string {
  const detected = backend
    ? `Detected backend: ${backend} (embedded or unknown — no watcher in auto mode).`
    : undefined
  return [
    `CGC freshness: freshness.watch is "auto" — no watcher was started for ${cwd}.`,
    ...(detected ? [detected] : []),
    'In auto mode the watcher only starts on server backends (neo4j, falkordb-remote): on embedded backends a running watcher would lock out every other CGC process. The lazy drift sync still runs within the session budget. Set freshness.watch to "on" to force the watcher on this backend.',
    'You will not be notified again for this condition this session.',
  ].join('\n')
}

/**
 * The one-time auto-decline notice for an unindexed workspace (design D5 of
 * add-freshness-watch-tri-state): `auto` never spawns on an unindexed
 * workspace — `cgc watch .` would perform a full initial scan, bypassing the
 * `lifecycle.autoCreate` consent model. The decline is observable, once per
 * session, with the index-first path named.
 */
export function buildWatcherNotStartedUnindexedNotice(cwd: string): string {
  return [
    `CGC freshness: freshness.watch is "auto" — no watcher was started for ${cwd} because the workspace is not indexed yet.`,
    'In auto mode the watcher only starts on already-indexed workspaces: watching never implies creating. Index the workspace (`cgc index .` or `/cgc sync`, or enable lifecycle.autoCreate) and the watcher will start in a future session, or set freshness.watch to "on" to force it now.',
    'You will not be notified again for this condition this session.',
  ].join('\n')
}

/**
 * The one-time watcher-not-verified notice (design D4 of
 * add-freshness-watch-tri-state): the managed watcher spawned but settled as
 * failed before liveness verification passed — the honest not-verified state
 * (advisory stale + recorded error) replaces the old spawn-time fresh claim,
 * so a dead watcher can never silence as "fresh".
 */
export function buildWatcherNotVerifiedNotice(cwd: string, detail?: string): string {
  const detected = detail ? `Detected state: ${detail}.` : undefined
  return [
    `CGC freshness: the continuous watcher for ${cwd} failed before it could be verified — the workspace is NOT reported fresh.`,
    ...(detected ? [detected] : []),
    'Nothing was claimed fresh and no watcher retry fires this session; the advisory stale state stands and the lazy mode behavior resumes (the next session-start sync also reconciles). Run the sync manually any time (`cgc index .` or `/cgc sync`).',
    'You will not be notified again for this condition this session.',
  ].join('\n')
}

/**
 * The one-time stale-condition notice (task 3.1, design D4): the first
 * observed file-modifying tool call of a session opens the stale episode and
 * the user sees ONE advisory notice naming the manual sync option (`/cgc
 * sync`) — at most once per session (condition key `possibly-stale`; the
 * notifyOnce latch makes it session-scoped, never per-episode). Fires only
 * when a stale episode actually opens (fresh or unrecorded state before the
 * mark) and never while the managed watcher owns freshness or for a workspace
 * the worktree gate reports blocked.
 */
export function buildPossiblyStaleNotice(cwd: string): string {
  return [
    `CGC freshness: ${cwd} is possibly stale — file changes were observed but the index may not include them yet.`,
    'The automatic sync runs in the background within the session budget; run it manually any time with `/cgc sync` (or `cgc index .`).',
    'You will not be notified again for this condition this session.',
  ].join('\n')
}

/**
 * The one-time sync-completion notice (task 3.1, design D4): when a drift
 * sync settles successfully the episode ends `fresh`, and the user sees ONE
 * confirmation notice (condition key `sync-completed`, at most once per
 * session) so the episode's closing signal is recognizable apart from the
 * stale notice that opened it. Never fires for a BUSY or failed settle.
 */
export function buildSyncCompletedNotice(cwd: string): string {
  return [
    `CGC freshness: the index for ${cwd} is up to date — the background sync completed and the workspace is reported fresh.`,
    'You will not be notified again for this condition this session.',
  ].join('\n')
}

/**
 * The extension's process-lifetime freshness-state store (the data layer all
 * freshness consumers share — the drift observer feeds it, the status HUD
 * and `/cgc status` subscribe/read it, future proactive tiers build on it).
 * The observer resets the instance at session shutdown, so a reused instance
 * never leaks state across sessions. Safe to call repeatedly; the instance
 * is cached for the process lifetime.
 */
export function getFreshnessStateStore(): FreshnessStateStore {
  cachedFreshnessStore ??= new FreshnessStateStore()
  return cachedFreshnessStore
}
