// Busy path of the CGC lifecycle gate (design D2/D4 of
// openspec/changes/add-cgc-session-lifecycle-gate, task 2.6).
//
// Two triggers map onto skip-as-busy (design D4):
//   1. A lock-holding probe: the classifier's status/stats probe showed that
//      another CGC process owns the embedded database (the classifier reports
//      `state: 'busy'`, task 2.2).
//   2. A lock error: a maintenance command started by another path (index
//      creation, drift sync, confirmed rebuild) settled with the runner's
//      `BUSY` code — a coarse embedded-backend lock marker in a failed
//      command's captured output. Those paths record the outcome as-is and
//      deliberately leave surfacing it to this path.
//
// The path's entire action repertoire is one thing: surface a one-time notice
// and skip. It holds no runner and spawns nothing — there is no mechanism to
// retry the skipped command, force-terminate the other process, or delete a
// lock file. Embedded backends are single-process by design, and CGC's
// troubleshooting docs treat lock errors as expected behavior, not bugs
// ("not a configuration problem"); retrying would only burn the command
// budget, and stale-lock reclamation is explicitly deferred (design D4
// alternatives).
//
// One-time semantics: at most one busy notice per workspace per handler
// lifetime (one handler per session), across both triggers. Evidence of the
// latest lock conflict is still recorded into state (task 3.1) — recording is
// not an action and never re-notifies.
//
// Fail-open contract: `handle` and `reportLockError` never throw. A malformed
// or non-BUSY report is ignored, not surfaced; the session proceeds either
// way, and nothing on disk is ever touched.

/**
 * Why the path did what it did this evaluation:
 *   - `skipped`      — a lock conflict was observed (probe or command): the
 *                      one-time busy notice was surfaced and the work is
 *                      skipped as busy.
 *   - `already-done` — this workspace was already marked busy this session
 *                      (one-time semantics; nothing surfaced again).
 *   - `ignored`      — the report was not evidence of a lock conflict (a
 *                      non-BUSY code or a malformed report); nothing was
 *                      recorded or surfaced.
 */
export type BusyAction = 'skipped' | 'already-done' | 'ignored'

/** Which trigger produced the lock evidence. */
export type BusyLockSource = 'probe' | 'command'

/** A one-time user-facing notice produced by this path. */
export interface BusyNotice {
  /** Human-readable notice text (multi-line). */
  text: string
  kind: 'busy'
  /** When the notice was produced (epoch ms). */
  at: number
}

/** Outcome of one `handle` / `reportLockError` evaluation. */
export interface BusyOutcome {
  /** The workspace cwd this evaluation applied to. */
  cwd: string
  /** What the path did this evaluation. */
  action: BusyAction
  /** True when this workspace was already marked busy earlier in this session. */
  repeated: boolean
  /** The notice produced by this evaluation, if one was surfaced. */
  notice: BusyNotice | null
}

/**
 * Minimal shape this path accepts as settled lock evidence from a runner
 * result (or a path's recorded outcome). Only code `BUSY` is actionable.
 */
export interface BusyLockReport {
  /** Structured runner outcome code. */
  code: string
  /** Human-readable, single-line description of the outcome. */
  message: string
}

/** Recorded evidence of the latest observed lock conflict (state for 3.1). */
export interface BusyLockRecord {
  /** Which trigger observed the conflict. */
  source: BusyLockSource
  /** The structured runner outcome code (`BUSY`). */
  code: string
  /** Human-readable, single-line description of the outcome. */
  message: string
  /** When the conflict was observed (epoch ms). */
  at: number
}

/** Where the path currently stands for a workspace (state for 3.1). */
export type BusyStatus = 'unhandled' | 'busy-skipped'

export interface BusyPathOptions {
  /**
   * Sink for notices (the eventual gate wires this to Pi's session
   * notification surface). When omitted, notices accumulate in `notices` for
   * downstream surfaces (task 3.1) to read.
   */
  onNotice?: (notice: BusyNotice) => void
}

/**
 * Per-session busy path. One instance per session (or per gate); the one-time
 * markers live exactly as long as the handler, so repeated gate evaluations
 * in the same session never re-notify per workspace.
 */
export class BusyPath {
  private readonly onNotice: ((notice: BusyNotice) => void) | undefined

  /** Workspaces already marked busy this session (one-time semantics). */
  private readonly handled = new Set<string>()
  /** Notices surfaced this session, in order (read by later surfaces, 3.1). */
  private readonly noticeLog: BusyNotice[] = []
  /** Latest observed lock conflict per workspace cwd (state for 3.1). */
  private readonly records = new Map<string, BusyLockRecord>()
  /** Current status per workspace (state for 3.1). */
  private readonly statuses = new Map<string, BusyStatus>()

  constructor(options: BusyPathOptions = {}) {
    this.onNotice = options.onNotice
  }

  /** Notices surfaced so far this session (read-only view for later surfaces). */
  get notices(): readonly BusyNotice[] {
    return this.noticeLog
  }

  /** Current status for a workspace (state for 3.1; `unhandled` if never seen). */
  status(cwd: string): BusyStatus {
    return this.statuses.get(cwd) ?? 'unhandled'
  }

  /**
   * Whether this workspace was already skipped as busy this session. The gate
   * consults this to honor design D4's "takes no further action that session":
   * once true, no maintenance work should be started for the workspace.
   */
  isBusy(cwd: string): boolean {
    return this.handled.has(cwd)
  }

  /** The latest observed lock conflict for a workspace, if any (state for 3.1). */
  record(cwd: string): BusyLockRecord | null {
    return this.records.get(cwd) ?? null
  }

  /**
   * Handle one evaluation of a workspace the classifier reported as `busy`
   * (the lock-holding probe trigger). Never spawns anything, never throws:
   * the entire response is the one-time notice.
   */
  handle(cwd: string, reason?: string): BusyOutcome {
    // One-time semantics: this workspace was already marked busy this session.
    if (this.handled.has(cwd)) {
      return { cwd, action: 'already-done', repeated: true, notice: null }
    }

    const detail = typeof reason === 'string' && reason.length > 0 ? reason : undefined
    this.markBusy(cwd, {
      source: 'probe',
      code: 'BUSY',
      message: detail ?? 'a status/stats probe reported another CGC process holding the database',
    })

    const notice = this.emit({ kind: 'busy', text: buildBusyNotice(cwd, detail) })
    return { cwd, action: 'skipped', repeated: false, notice }
  }

  /**
   * Report a settled maintenance outcome that may be a lock error (the
   * lock-error trigger). Only the runner's `BUSY` code is actionable: anything
   * else (or a malformed report) is ignored without recording or notifying —
   * routing non-lock failures is the owning path's business, not this one.
   *
   * Never spawns anything, never retries the failed command, never touches
   * the lock or database files; the skipped work stays skipped.
   */
  reportLockError(cwd: string, report: BusyLockReport | null | undefined): BusyOutcome {
    if (
      report === null ||
      typeof report !== 'object' ||
      report.code !== 'BUSY' ||
      typeof report.message !== 'string'
    ) {
      return { cwd, action: 'ignored', repeated: false, notice: null }
    }

    // One-time semantics across both triggers: never re-notify a workspace
    // that is already marked busy. The latest evidence is still recorded —
    // recording is bookkeeping for later surfaces, not an action.
    if (this.handled.has(cwd)) {
      this.records.set(cwd, {
        source: 'command',
        code: report.code,
        message: report.message,
        at: Date.now(),
      })
      return { cwd, action: 'already-done', repeated: true, notice: null }
    }

    this.markBusy(cwd, {
      source: 'command',
      code: report.code,
      message: report.message,
    })

    const notice = this.emit({ kind: 'busy', text: buildBusyNotice(cwd, report.message) })
    return { cwd, action: 'skipped', repeated: false, notice }
  }

  /** Clear all per-session state (session shutdown / fresh session). */
  reset(): void {
    this.handled.clear()
    this.noticeLog.length = 0
    this.records.clear()
    this.statuses.clear()
  }

  private markBusy(cwd: string, record: Omit<BusyLockRecord, 'at'>): void {
    this.handled.add(cwd)
    this.statuses.set(cwd, 'busy-skipped')
    this.records.set(cwd, { ...record, at: Date.now() })
  }

  private emit(input: Omit<BusyNotice, 'at'>): BusyNotice {
    const notice: BusyNotice = { ...input, at: Date.now() }
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
 * The one-time skip-as-busy notice: which process state conflicts, why force
 * is off the table (no retries, no termination, no lock-file deletion), what
 * the user can do instead, and that the session proceeds.
 */
export function buildBusyNotice(cwd: string, detail?: string): string {
  const detected = detail ? `Detected state: ${detail}.` : undefined
  return [
    `CGC: another CGC process is holding the embedded database for ${cwd} — the workspace is busy.`,
    ...(detected ? [detected] : []),
    "This is expected behavior for CGC's single-process embedded backends, not a fault to fix by force. The extension will not retry the skipped work, will not terminate the other process, and will never delete lock files. Nothing was modified.",
    'If you want the skipped maintenance now, stop the other CGC process (for example a running `cgc watch` or the CGC MCP server), then run the command manually (for example `cgc index .`).',
    'This session proceeds without the skipped maintenance; graph queries still go through the process that holds the database. You will not be notified again this session.',
  ].join('\n')
}
