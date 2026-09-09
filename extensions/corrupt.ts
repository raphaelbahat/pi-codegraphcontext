// Corrupt path of the CGC lifecycle gate (design D2/D3 of
// openspec/changes/add-cgc-session-lifecycle-gate, task 2.5).
//
// When the classifier reports `corrupt` (an unusable index, or the fail-safe
// "corrupt-adjacent unknown" bucket from an inconclusive probe), this path
// does exactly one thing on its own: surface a one-time notice reporting the
// state and offering a full rebuild. It NEVER takes a destructive action by
// itself — no deletion, no rebuild spawn, nothing. A rebuild happens only
// through an explicit `rebuild(cwd, { confirm: true })` call, which the
// human-facing surfaces (add-cgc-slash-commands) wire to an actual in-session
// user confirmation (ADR-0003: no config flag or "don't ask again" bypass;
// the only way past the gate is the user's explicit yes).
//
// "Never self-destruct data": the path never touches `.codegraphcontext/` or
// any database file. Even the confirmed rebuild delegates the replacement to
// CGC itself (`cgc index . --force`), spawned through the shared runner —
// deduplicated, budgeted, abortable, bounded output. CGC verbs gated by
// `ALLOW_DB_DELETION` (delete/clean) are never invoked here or anywhere in
// the extension (ADR-0003).
//
// Design D2 transition: `corrupt ──(explicit confirm)──► rebuilding ──► clean`.
// The rebuild is fire-and-forget (design D3: gate bodies never await cgc
// completion); its settled outcome is recorded into state (task 3.1). At most
// one rebuild is started per workspace per handler lifetime; a refused request
// consumes nothing (the user may still confirm later); no outcome is ever
// retried here (the one-retry cap belongs to the gate, task 3.2).
//
// Fail-open contract: `handle` and `rebuild` never throw. A rebuild that
// cannot be started degrades to a recorded `degraded` status; the session
// proceeds either way, and the corrupt index is left exactly as it was.

import type { CgcCommandResult, CgcRunner, CgcRunOptions } from './runner'

/**
 * The full-rebuild command. `cgc index .` is incremental by default;
 * `--force` rebuilds the index from scratch, replacing the corrupt one
 * (CGC-verified CLI behavior, recorded in the change's validate.md). The
 * extension never invokes CGC's deletion verbs.
 */
export const DEFAULT_REBUILD_ARGS: readonly string[] = ['index', '.', '--force']

/**
 * Why the corrupt path did what it did this evaluation:
 *   - `notified`     — the one-time corrupt report + rebuild offer was surfaced.
 *                      Nothing was spawned; the session proceeds.
 *   - `already-done` — this workspace was already handled this session
 *                      (one-time semantics; nothing surfaced or spawned again).
 */
export type CorruptAction = 'notified' | 'already-done'

/** Outcome of one `handle` evaluation (also the path's reported state input). */
export interface CorruptOutcome {
  /** The workspace cwd this evaluation applied to. */
  cwd: string
  /** What the path did this evaluation. */
  action: CorruptAction
  /** True when this workspace was already handled earlier in this session. */
  repeated: boolean
  /** The notice produced by this evaluation, if one was surfaced. */
  notice: CorruptNotice | null
  /** True while a confirmed background rebuild is in flight. */
  rebuilding: boolean
}

/**
 * Why a `rebuild` request did what it did:
 *   - `rebuilding`    — explicit confirmation received: the full rebuild was
 *                       started in the background.
 *   - `refused`       — no explicit confirmation (or the request shape was
 *                       invalid): nothing was spawned and nothing was deleted.
 *                       Refusing consumes nothing; the user may confirm later.
 *   - `already-done`  — a rebuild was already started for this workspace this
 *                       session; outcomes are never retried, so nothing ran.
 *   - `degraded`      — confirmation received but starting the background
 *                       rebuild failed unexpectedly; the corrupt index is
 *                       untouched and the failure is recorded in state.
 */
export type CorruptRebuildAction = 'rebuilding' | 'refused' | 'already-done' | 'degraded'

export interface CorruptRebuildRequest {
  /**
   * The explicit confirmation gate. Must be literally `true`. Callers pass it
   * ONLY after the user explicitly confirmed the rebuild in-session (ADR-0003);
   * the confirmation names the effect — the existing index is replaced from
   * scratch. There is deliberately no config flag, environment variable, or
   * "don't ask again" bypass: the only path to a destructive rebuild is a
   * human saying yes.
   */
  confirm: true
  /**
   * Optional free-text note about where the confirmation came from (e.g.
   * "user confirmed via /cgc rebuild"). Diagnostics only; never validated.
   */
  via?: string
}

/** Outcome of one `rebuild` request. */
export interface CorruptRebuildOutcome {
  /** The workspace cwd this request applied to. */
  cwd: string
  /** What the request did. */
  action: CorruptRebuildAction
  /** Why the request was refused; null for every other action. */
  refuseReason: string | null
  /** The notice produced by this request, if one was surfaced. */
  notice: CorruptNotice | null
  /** True while the confirmed background rebuild is in flight. */
  rebuilding: boolean
}

/** A one-time user-facing notice produced by this path. */
export interface CorruptNotice {
  /** Human-readable notice text (multi-line). */
  text: string
  kind: 'corrupt' | 'rebuild-started' | 'rebuild-refused' | 'rebuild-degraded'
  /** When the notice was produced (epoch ms). */
  at: number
}

/** Recorded outcome of a settled background rebuild run (state for 3.1). */
export interface CorruptRebuildResult {
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
export type CorruptStatus = 'unhandled' | 'noticed' | 'rebuilding' | 'settled' | 'degraded'

export interface CorruptPathOptions {
  /** The extension's single cgc runner; every spawn goes through it. */
  runner: CgcRunner
  /**
   * Arguments for the confirmed full-rebuild command; defaults to
   * `['index', '.', '--force']` run with `cwd` set to the session working
   * directory. Overridable for tests and for absorbing CLI verb changes.
   */
  rebuildArgs?: readonly string[]
  /**
   * Time budget for the rebuild command. Defaults to the runner's configured
   * default budget (config `cgc.timeoutMs`); a full rebuild can legitimately
   * take longer than a probe on a large working tree, so the gate may pass a
   * larger budget.
   */
  rebuildTimeoutMs?: number
  /**
   * Sink for notices (the eventual gate wires this to Pi's session
   * notification surface). When omitted, notices accumulate in `notices` for
   * downstream surfaces (task 3.1) to read.
   */
  onNotice?: (notice: CorruptNotice) => void
}

/**
 * Per-session corrupt path. One instance per session (or per gate); the
 * one-time markers live exactly as long as the handler, so repeated gate
 * evaluations in the same session never re-notify or re-spawn per workspace.
 */
export class CorruptPath {
  private readonly runner: CgcRunner
  private readonly rebuildArgs: readonly string[]
  private readonly rebuildTimeoutMs: number | undefined
  private readonly onNotice: ((notice: CorruptNotice) => void) | undefined

  /** Workspaces already reported this session (one-time semantics). */
  private readonly handled = new Set<string>()
  /** Workspaces with an already-started rebuild this session (no retries). */
  private readonly rebuildAttempted = new Set<string>()
  /** Notices surfaced this session, in order (read by later surfaces, 3.1). */
  private readonly noticeLog: CorruptNotice[] = []
  /** In-flight confirmed rebuilds, keyed by workspace cwd. */
  private readonly inFlight = new Map<string, Promise<CorruptRebuildResult | null>>()
  /** Settled rebuild outcomes, keyed by workspace cwd (state for 3.1). */
  private readonly results = new Map<string, CorruptRebuildResult>()
  /** Current status per workspace (state for 3.1). */
  private readonly statuses = new Map<string, CorruptStatus>()

  constructor(options: CorruptPathOptions) {
    this.runner = options.runner
    this.rebuildArgs = options.rebuildArgs ?? DEFAULT_REBUILD_ARGS
    this.rebuildTimeoutMs = options.rebuildTimeoutMs
    this.onNotice = options.onNotice
  }

  /** Notices surfaced so far this session (read-only view for later surfaces). */
  get notices(): readonly CorruptNotice[] {
    return this.noticeLog
  }

  /** Current status for a workspace (state for 3.1; `unhandled` if never seen). */
  status(cwd: string): CorruptStatus {
    return this.statuses.get(cwd) ?? 'unhandled'
  }

  /** The settled background rebuild outcome for a workspace, if it has one. */
  result(cwd: string): CorruptRebuildResult | null {
    return this.results.get(cwd) ?? null
  }

  /** Whether a confirmed background rebuild is currently in flight for a workspace. */
  isRebuilding(cwd: string): boolean {
    return this.inFlight.has(cwd)
  }

  /** Resolves once the confirmed background rebuild for the workspace settles. */
  whenSettled(cwd: string): Promise<CorruptRebuildResult | null> {
    return this.inFlight.get(cwd) ?? Promise.resolve(this.results.get(cwd) ?? null)
  }

  /**
   * Handle one evaluation of a `corrupt` workspace: report the state and offer
   * a rebuild, once per workspace per session. Never spawns any command — the
   * rebuild offer is an offer; the destructive action lives behind
   * `rebuild(..., { confirm: true })`.
   */
  handle(cwd: string, reason?: string): CorruptOutcome {
    // One-time semantics: this workspace was already reported this session.
    if (this.handled.has(cwd)) {
      return {
        cwd,
        action: 'already-done',
        repeated: true,
        notice: null,
        rebuilding: this.isRebuilding(cwd),
      }
    }
    this.handled.add(cwd)

    const notice = this.emit({
      kind: 'corrupt',
      text: buildCorruptNotice(cwd, this.rebuildArgs, reason),
    })
    this.statuses.set(cwd, 'noticed')
    return { cwd, action: 'notified', repeated: false, notice, rebuilding: false }
  }

  /**
   * Attempt a full rebuild of the corrupt index for `cwd`.
   *
   * The request is refused unless `request.confirm` is literally `true` — the
   * caller's explicit act of relaying the user's in-session confirmation
   * (ADR-0003). A refusal spawns nothing, deletes nothing, and consumes
   * nothing. A confirmed request starts the rebuild in the background (fire
   * and forget) and records its outcome when it settles; at most one rebuild
   * is ever started per workspace per handler lifetime.
   */
  rebuild(cwd: string, request: CorruptRebuildRequest): CorruptRebuildOutcome {
    // Confirmation gate first, always: no request shape or state combination
    // gets past it without the caller's explicit `confirm: true`.
    if (request?.confirm !== true) {
      const notice = this.emit({
        kind: 'rebuild-refused',
        text: buildRebuildRefusedNotice(cwd, 'no explicit confirmation was provided'),
      })
      // A refusal changes nothing on disk and consumes nothing: the corrupt
      // state stands, and a later confirmed request is still possible.
      if (this.status(cwd) === 'unhandled') this.statuses.set(cwd, 'noticed')
      return {
        cwd,
        action: 'refused',
        refuseReason: 'no explicit confirmation was provided',
        notice,
        rebuilding: false,
      }
    }

    // No retries: one rebuild per workspace per handler lifetime, regardless
    // of how a previous attempt ended (the gate owns any retry policy, 3.2).
    if (this.rebuildAttempted.has(cwd)) {
      return {
        cwd,
        action: 'already-done',
        refuseReason: null,
        notice: null,
        rebuilding: this.isRebuilding(cwd),
      }
    }

    // Mark the attempt before spawning so even a degraded start can never be
    // silently retried by a repeat call.
    this.rebuildAttempted.add(cwd)

    const runOptions: CgcRunOptions = { args: this.rebuildArgs }
    if (this.rebuildTimeoutMs !== undefined) runOptions.timeoutMs = this.rebuildTimeoutMs
    let started: Promise<CgcCommandResult>
    try {
      started = this.runner.run(cwd, runOptions)
    } catch (error) {
      // The runner only throws on caller contract violations; record the
      // degraded status rather than throwing out of a gate hook body. The
      // corrupt index is untouched.
      const reason = error instanceof Error ? error.message : String(error)
      const notice = this.emit({
        kind: 'rebuild-degraded',
        text: buildRebuildDegradedNotice(cwd, reason),
      })
      this.statuses.set(cwd, 'degraded')
      return { cwd, action: 'degraded', refuseReason: null, notice, rebuilding: false }
    }

    this.emit({
      kind: 'rebuild-started',
      text: buildRebuildStartedNotice(cwd, this.rebuildArgs),
    })
    this.statuses.set(cwd, 'rebuilding')

    // Settle the run: record the outcome and clear the in-flight marker
    // before the tracking promise resolves, so any consumer awaiting it (via
    // `whenSettled`) observes final state atomically. A gate hook body must
    // never reject, so every failure is captured into state (fail open).
    const settled: Promise<CorruptRebuildResult | null> = (async () => {
      let record: CorruptRebuildResult
      try {
        const result = await started
        // Record the outcome once. A `BUSY` outcome is left for the busy
        // path (task 2.6) to surface; no retries here (design D4, task 3.2)
        // and, on any outcome, no further destructive action by this path.
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
          message: `background rebuild failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
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

    return { cwd, action: 'rebuilding', refuseReason: null, notice: null, rebuilding: true }
  }

  /** Clear all per-session state (session shutdown / fresh session). */
  reset(): void {
    this.handled.clear()
    this.rebuildAttempted.clear()
    this.noticeLog.length = 0
    this.results.clear()
    this.statuses.clear()
    this.inFlight.clear()
  }

  private emit(input: Omit<CorruptNotice, 'at'>): CorruptNotice {
    const notice: CorruptNotice = { ...input, at: Date.now() }
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
 * The one-time corrupt report + rebuild offer: what was detected, what it
 * means, and that nothing will be destroyed without an explicit yes.
 */
export function buildCorruptNotice(
  cwd: string,
  rebuildArgs: readonly string[],
  reason?: string,
): string {
  const detected = reason
    ? `Detected state: ${reason}.`
    : 'The index health probe could not confirm the index is usable.'
  return [
    `CGC: the code index at ${cwd} appears corrupt or unusable. ${detected}`,
    'Nothing has been changed or deleted. To fix this, the index must be rebuilt from scratch (`cgc ' +
      `${rebuildArgs.join(' ')}\`), which replaces the existing index.`,
    'A rebuild is only ever performed after you explicitly confirm it in this session — the extension never rebuilds or deletes on its own. You can also run the rebuild command manually.',
    'This session proceeds without a usable index; graph queries may return empty or failed results until the index is rebuilt. You will not be asked again.',
  ].join('\n')
}

/** The notice that a confirmed background rebuild has started. */
export function buildRebuildStartedNotice(cwd: string, rebuildArgs: readonly string[]): string {
  return [
    `CGC: rebuilding the corrupt index at ${cwd} from scratch.`,
    `The rebuild is running in the background (\`cgc ${rebuildArgs.join(' ')}\`); the existing index is replaced when it completes. The session proceeds while it runs.`,
  ].join('\n')
}

/** The notice used when a rebuild request was refused at the confirmation gate. */
export function buildRebuildRefusedNotice(cwd: string, reason: string): string {
  return [
    `CGC: the rebuild of the corrupt index at ${cwd} was not started: ${reason}.`,
    'Nothing was changed or deleted. The rebuild happens only after you explicitly confirm it; nothing is ever rebuilt or destroyed automatically.',
  ].join('\n')
}

/** The notice used when starting a confirmed rebuild failed unexpectedly. */
export function buildRebuildDegradedNotice(cwd: string, reason: string): string {
  return [
    `CGC: the confirmed rebuild of the corrupt index at ${cwd} could not be started (${reason}).`,
    'Nothing was changed or deleted; the corrupt index is untouched. You can retry by confirming the rebuild again, or run `cgc index . --force` manually.',
  ].join('\n')
}
