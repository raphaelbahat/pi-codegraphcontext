// Clean path of the CGC lifecycle gate (design D2/D3 of
// openspec/changes/add-cgc-session-lifecycle-gate, task 2.7).
//
// When the classifier reports `clean` (a usable `cgc` binary, an existing
// index, and a health probe reporting no staleness), the gate's entire
// response is to skip silently: the workspace is healthy, so NO maintenance
// invocation of any kind is made. The only `cgc` cost a clean session ever
// pays is the already-cached detection pair — the one-shot `cgc --version`
// liveness probe (WorkspaceDetector, task 2.1) and the one-shot cached
// `cgc stats` health probe (LifecycleClassifier, task 2.2) — both cached per
// session, so repeated gate evaluations (and repeated sessions on the same
// healthy workspace) never re-index or re-probe redundantly (spec: "Healthy
// index on repeated sessions").
//
// Enforcement is structural: this path holds no CgcRunner and accepts none.
// There is no code path here that could spawn a process, record a budget
// slot, or retry work — the clean state cannot regress into maintenance by
// construction. Automatic maintenance lives in the sibling paths (unindexed
// 2.3, drift 2.4, corrupt 2.5) and the session-wide per-session invocation
// budget / one-retry cap live in the shared budget module (budget.ts, 2.7);
// the clean path simply never reaches them.
//
// One-time semantics: like every gate path, evaluation is at most once per
// workspace per handler lifetime (one handler per session); repeated
// evaluations report `already-done` without re-recording state.
//
// Fail-open contract: `handle` never throws and never blocks. There is
// nothing to fail here — which is the point.

/**
 * The exact number of `cgc` maintenance invocations the clean path makes:
 * zero. Exported so tests and downstream surfaces can assert the guarantee
 * against the constant instead of the implementation.
 */
export const CLEAN_PATH_MAINTENANCE_INVOCATIONS = 0

/**
 * Why the path did what it did this evaluation:
 *   - `skipped`      — the workspace was clean: nothing was spawned and the
 *                      session proceeds silently (no notice — skip silently
 *                      is the designed behavior, proposal.md).
 *   - `already-done` — this workspace was already skipped clean this session
 *                      (one-time semantics; nothing re-recorded).
 */
export type CleanAction = 'skipped' | 'already-done'

/** Outcome of one `handle` evaluation (also the path's reported state). */
export interface CleanOutcome {
  /** The workspace cwd this evaluation applied to. */
  cwd: string
  /** What the path did this evaluation. */
  action: CleanAction
  /** True when this workspace was already skipped earlier in this session. */
  repeated: boolean
  /**
   * Always 0 (see {@link CLEAN_PATH_MAINTENANCE_INVOCATIONS}): the path makes
   * no maintenance invocations, beyond the cached probes detection already
   * paid for.
   */
  maintenanceInvocations: typeof CLEAN_PATH_MAINTENANCE_INVOCATIONS
}

/** Where the path currently stands for a workspace (state for 3.1). */
export type CleanStatus = 'unhandled' | 'skipped-clean'

/**
 * Per-session clean path. One instance per session (or per gate). Note the
 * absence of any runner option: the path is incapable of spawning `cgc`
 * commands by construction — the strongest possible enforcement of "no
 * maintenance invocations beyond the cached probe".
 */
export class CleanPath {
  /** Workspaces already skipped this session (one-time semantics). */
  private readonly handled = new Set<string>()
  /** Current status per workspace (state for 3.1). */
  private readonly statuses = new Map<string, CleanStatus>()

  /** Current status for a workspace (state for 3.1; `unhandled` if never seen). */
  status(cwd: string): CleanStatus {
    return this.statuses.get(cwd) ?? 'unhandled'
  }

  /** Whether this workspace was already skipped as clean this session. */
  isSkipped(cwd: string): boolean {
    return this.handled.has(cwd)
  }

  /**
   * Handle one evaluation of a `clean` workspace: skip silently.
   *
   * Never spawns anything (no runner exists here), never throws, never
   * notifies — a healthy workspace is the one state that says nothing. At
   * most one evaluation is recorded per workspace per handler lifetime.
   */
  handle(cwd: string): CleanOutcome {
    // One-time semantics: this workspace was already skipped this session.
    if (this.handled.has(cwd)) {
      return {
        cwd,
        action: 'already-done',
        repeated: true,
        maintenanceInvocations: CLEAN_PATH_MAINTENANCE_INVOCATIONS,
      }
    }

    this.handled.add(cwd)
    this.statuses.set(cwd, 'skipped-clean')
    return {
      cwd,
      action: 'skipped',
      repeated: false,
      maintenanceInvocations: CLEAN_PATH_MAINTENANCE_INVOCATIONS,
    }
  }

  /** Clear all per-session state (session shutdown / fresh session). */
  reset(): void {
    this.handled.clear()
    this.statuses.clear()
  }
}
