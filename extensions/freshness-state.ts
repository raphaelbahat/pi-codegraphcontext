// Freshness state store (design D5 of
// openspec/changes/add-cgc-freshness-drift-sync, task 1.2).
//
// The subscribable data layer behind the freshness capability: records, per
// workspace, the current freshness status (`fresh | possibly-stale | syncing
// | skipped-busy | disabled`), when the last incremental sync completed, and
// when the workspace was first marked possibly-stale. This module registers
// no tools and spawns no processes — it only stores what the freshness module
// records (task 1.3 drift observation, task 2.x sync execution). It is the
// read-only state surface downstream surfaces consume: the status HUD
// (add-cgc-status-hud) subscribes to snapshots, `/cgc status`
// (add-cgc-slash-commands) reads them on demand, and the opt-in proactive
// injection builds on the same store.
//
// Snapshot contract (task 1.2): every workspace carries its path, its current
// status, the last-sync timestamp, the first-stale timestamp of the current
// stale episode, and — since task 3.2's fail-open containment — the message
// of the most recently recorded error (`lastError`; null when none, and
// cleared by a completed sync so a resolved episode never reads as
// error-laden). Snapshots are frozen copies; consumers can never mutate
// store state.
//
// Session scoping: the freshness module creates one store per session and
// feeds it; `reset()` clears everything between sessions. Stores are cheap,
// so downstream surfaces may also hold their own short-lived instance when no
// session-managed store is reachable — the same convention as the lifecycle
// state store (add-cgc-session-lifecycle-gate task 3.1).
//
// Timestamp contract:
//   - `lastSyncedAt` is set when a sync completes (a status recorded as
//     `fresh`) and persists as history; no other status clears it.
//   - `staleSince` is set on the FIRST transition into `possibly-stale`
//     (task 1.3's "first observed edit" — later re-marks within the same
//     stale episode keep the original timestamp, the data-layer half of burst
//     debouncing) and cleared only when a sync completes (status back to
//     `fresh`).
//   - `stateChangedAt` moves only when the status literal changes from a
//     previously recorded status; it stays null for a workspace whose current
//     status is also its first (there was nothing prior to change from).
//   - `updatedAt` moves on every record.
//
// Fail-open contract: recording never throws and never validates callers — a
// late update for an unknown workspace still records (the entry is created on
// demand, the lifecycle-state convention). A throwing listener never breaks
// the recording path. Bounded memory: one small entry per workspace ever
// recorded, cleared wholesale by `reset()`.

/**
 * Freshness status of one workspace — the design D5 literal set, the same
 * statuses the status HUD's chip marker and the `/cgc status` renderer label
 * (the seams declared in status-hud.ts and commands.ts are satisfied
 * structurally by {@link FreshnessSnapshot}).
 */
export type FreshnessStatus = 'fresh' | 'possibly-stale' | 'syncing' | 'skipped-busy' | 'disabled'

/**
 * Read-only per-workspace view of the freshness state (what listeners receive
 * and `snapshot(cwd)` returns). Snapshots are frozen copies; the subset
 * `{ cwd, status, lastSyncedAt, staleSince }` is structurally assignable to
 * the status-hud `FreshnessHudSummary` and the commands.ts
 * `CgcFreshnessSummary` seams.
 */
export interface FreshnessSnapshot {
  /** The workspace root this state applies to (the Pi session cwd). */
  cwd: string
  /** The current freshness status. */
  status: FreshnessStatus
  /** When the last incremental sync completed (epoch ms); null when none ran. */
  lastSyncedAt: number | null
  /**
   * When the workspace was FIRST marked possibly-stale in the current stale
   * episode (epoch ms); null when fresh. Re-marks while already
   * possibly-stale keep the original timestamp (burst debounce).
   */
  staleSince: number | null
  /**
   * The most recently recorded error message for this workspace (task 3.2's
   * fail-open containment: an encountered error is recorded, not silently
   * swallowed); null when no error has been recorded since the last
   * completed sync (a `fresh` record clears it). The status literal stays
   * the operative signal — recording an error never changes the status, so
   * the capability keeps degrading to advisory after a failure.
   */
  lastError: string | null
  /**
   * When the status last changed from a previously recorded status (epoch
   * ms); null when the current status is also the first one recorded for the
   * workspace.
   */
  stateChangedAt: number | null
  /** When anything about this workspace was last recorded (epoch ms). */
  updatedAt: number
}

/** Freshness change listener for the event-driven consumers (HUD design D1). */
export type FreshnessListener = (snapshot: FreshnessSnapshot) => void

/**
 * Inputs for `recordError`; everything but `cwd` and `message` is defaulted.
 */
export interface FreshnessErrorInput {
  /** The workspace the recorded error applies to (the session cwd). */
  cwd: string
  /** Human-readable description of what failed (never the agent loop). */
  message: string
  /** Defaults to now; overridable for tests. */
  at?: number
}

/**
 * Inputs for `recordStatus`; everything but `cwd` and `status` is defaulted.
 */
export interface FreshnessUpdateInput {
  /** The workspace the status applies to (the session cwd, never process cwd). */
  cwd: string
  /** The status to record. */
  status: FreshnessStatus
  /** Defaults to now; overridable for tests. */
  at?: number
}

/**
 * Per-session freshness-state store. The freshness module creates one
 * instance per session and feeds it as drift is observed and syncs run
 * (recording, since task 3.2, the errors it contains — the fail-open
 * contract's observable half); `reset()` clears all workspaces when the
 * session ends so a reused store never leaks state across sessions.
 */
export class FreshnessStateStore {
  private readonly workspaces = new Map<
    string,
    {
      cwd: string
      /** Whether any status was recorded yet (first record has no prior status). */
      observed: boolean
      status: FreshnessStatus
      lastSyncedAt: number | null
      staleSince: number | null
      stateChangedAt: number | null
      /** Most recent recorded error message (task 3.2); null when none. */
      lastError: string | null
      updatedAt: number
    }
  >()

  private readonly listeners = new Set<FreshnessListener>()

  /**
   * Record a freshness status for a workspace, creating the entry on demand.
   *
   * Timestamp bookkeeping follows the module-header contract: a recorded
   * `fresh` completes a stale episode (`lastSyncedAt` set, `staleSince`
   * cleared) and clears the entry's `lastError` (a completed sync resolves
   * the error condition), a recorded `possibly-stale` starts one
   * (`staleSince` set on the first mark only), and `syncing` / `skipped-busy`
   * / `disabled` leave both timestamps untouched.
   *
   * Emits the frozen snapshot to every subscriber — every record fires, even
   * when the status literal did not change, mirroring the lifecycle store
   * (consumers dedupe) — and returns it.
   */
  recordStatus(input: FreshnessUpdateInput): FreshnessSnapshot {
    const at = input.at ?? Date.now()
    const entry = this.entryFor(input.cwd)
    if (entry.observed && entry.status !== input.status) {
      entry.stateChangedAt = at
    }
    entry.status = input.status
    entry.observed = true
    if (input.status === 'fresh') {
      entry.lastSyncedAt = at
      entry.staleSince = null
      // A completed sync resolves the error condition (task 3.2): the
      // workspace never reads as error-laden while it reports fresh.
      entry.lastError = null
    } else if (input.status === 'possibly-stale') {
      entry.staleSince ??= at
    }
    entry.updatedAt = at
    return this.record(entry)
  }

  /**
   * Record an error message without changing the workspace's status literal
   * (task 3.2's "the error is recorded" half of fail-open containment): the
   * status stays the operative freshness signal and `updatedAt` moves so the
   * record is visible. Never throws and never validates — the same fail-open
   * contract as `recordStatus`. Emits to subscribers like any record
   * (consumers dedupe by status).
   */
  recordError(input: FreshnessErrorInput): FreshnessSnapshot {
    const at = input.at ?? Date.now()
    const entry = this.entryFor(input.cwd)
    entry.lastError = input.message
    entry.updatedAt = at
    return this.record(entry)
  }

  /** Read-only snapshot for one workspace; null when nothing was recorded. */
  snapshot(cwd: string): FreshnessSnapshot | null {
    const entry = this.workspaces.get(cwd)
    return entry ? this.freeze(entry) : null
  }

  /** Read-only snapshots for every workspace ever recorded (unordered). */
  snapshots(): readonly FreshnessSnapshot[] {
    return [...this.workspaces.values()].map((entry) => this.freeze(entry))
  }

  /**
   * Subscribe to freshness changes (HUD design D1: renders are event-driven,
   * no polling). The listener receives the frozen snapshot of the workspace
   * that changed. Returns an unsubscribe function; listeners are also dropped
   * by `reset()`.
   */
  subscribe(listener: FreshnessListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Clear all workspace state and listeners (session shutdown / fresh session). */
  reset(): void {
    this.workspaces.clear()
    this.listeners.clear()
  }

  private entryFor(cwd: string) {
    let entry = this.workspaces.get(cwd)
    if (!entry) {
      entry = {
        cwd,
        observed: false,
        status: 'fresh',
        lastSyncedAt: null,
        staleSince: null,
        stateChangedAt: null,
        lastError: null,
        updatedAt: 0,
      }
      this.workspaces.set(cwd, entry)
    }
    return entry
  }

  private record(
    entry: NonNullable<ReturnType<FreshnessStateStore['entryFor']>>,
  ): FreshnessSnapshot {
    const snapshot = this.freeze(entry)
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Fail-open: a broken downstream renderer must never break the
        // recording path (task 3.2's containment starts here).
      }
    }
    return snapshot
  }

  private freeze(
    entry: NonNullable<ReturnType<FreshnessStateStore['entryFor']>>,
  ): FreshnessSnapshot {
    return Object.freeze({
      cwd: entry.cwd,
      status: entry.status,
      lastSyncedAt: entry.lastSyncedAt,
      staleSince: entry.staleSince,
      stateChangedAt: entry.stateChangedAt,
      lastError: entry.lastError,
      updatedAt: entry.updatedAt,
    })
  }
}
