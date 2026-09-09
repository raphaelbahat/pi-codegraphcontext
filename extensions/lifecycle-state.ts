// Central lifecycle-state store (design D2/D3 of
// openspec/changes/add-cgc-session-lifecycle-gate, task 3.1).
//
// Aggregates, per workspace, what the rest of the extension produced: the
// latest `LifecycleClassification` (classifier.ts, task 2.2) and the actions
// taken by the gate paths (unindexed.ts 2.3, drift.ts 2.4, corrupt.ts 2.5,
// busy.ts 2.6, clean.ts 2.7). This is the read-only state surface that the
// downstream campaign changes render: the status HUD (add-cgc-status-hud)
// subscribes to snapshots, the slash commands (add-cgc-slash-commands) read
// them on demand. This module registers no tools and spawns no processes —
// the CGC MCP server remains the only query engine (ADR 0001).
//
// Snapshot contract (task 3.1): every workspace carries its path, the current
// lifecycle state, the current background activity (indexing / syncing /
// rebuilding / idle — the HUD chip's activity states), the last action with a
// human-readable detail, and the relevant timestamps. Snapshots are frozen
// copies; consumers can never mutate store state.
//
// Session scoping: the gate (task 3.2) creates one store per session and
// feeds it; `reset()` clears everything between sessions. Stores are cheap,
// so downstream surfaces may also hold their own short-lived instance when no
// gate-managed session store is reachable.
//
// Fail-open contract: recording never throws and never validates against the
// classifier — a late action for an unclassified workspace still records (the
// state stays `unavailable`-shaped "unknown" via `state: null`... rendered as
// unavailable by convention). Bounded memory: the per-workspace action log is
// capped (oldest dropped first).

import type { LifecycleClassification, LifecycleState } from './classifier'

/**
 * Background-work marker while maintenance runs. The HUD chip renders these
 * as "indexing…", "syncing…", "rebuilding…" instead of the terminal state
 * (add-cgc-status-hud design D1/D3).
 */
export type LifecycleActivity = 'idle' | 'indexing' | 'syncing' | 'rebuilding'

/**
 * What the gate did, as recorded by the gate paths. The literals cover the
 * actions this change's paths produce; the open-string tail (the same
 * pattern as budget.ts `MaintenancePurpose`) lets later campaign changes
 * (freshness sync, slash-command-triggered work) record their own actions
 * without touching this module.
 */
export type LifecycleActionKind =
  | 'classified'
  | 'unindexed-notice'
  | 'indexing-started'
  | 'indexing-settled'
  | 'drift-sync-started'
  | 'drift-sync-settled'
  | 'busy-skipped'
  | 'corrupt-notice'
  | 'rebuild-started'
  | 'rebuild-settled'
  | 'clean-skipped'
  | (string & {})

/** One recorded gate action (also the shape of `lastAction` in a snapshot). */
export interface LifecycleAction {
  kind: LifecycleActionKind
  /** The workspace the action applied to (session cwd, never process cwd). */
  cwd: string
  /** Human-readable, single-line description for downstream rendering. */
  detail: string
  /**
   * Outcome when known: true (succeeded), false (failed / degraded), null
   * (not applicable — notices, skips, and start markers).
   */
  ok: boolean | null
  /** When the action was recorded (epoch ms). */
  at: number
}

/** Inputs for `recordAction`; everything but the first three is defaulted. */
export interface LifecycleActionInput {
  kind: LifecycleActionKind
  cwd: string
  detail: string
  ok?: boolean | null
  /** Defaults to now; overridable for tests. */
  at?: number
}

/** Read-only per-workspace view of the lifecycle state (the 3.1 surface). */
export interface LifecycleSnapshot {
  /** The workspace root this state applies to (the Pi session cwd). */
  cwd: string
  /**
   * The classified lifecycle state; null until the first classification was
   * recorded. Downstream surfaces render null as "unavailable" by convention
   * (the canonical "do nothing, proceed" state, classifier.ts).
   */
  state: LifecycleState | null
  /** Current background activity; derived from recorded start/settle actions. */
  activity: LifecycleActivity
  /** Whether `.codegraphcontext/` was present at the last classification. */
  indexed: boolean | null
  /** The most recent action recorded for this workspace. */
  lastAction: LifecycleAction | null
  /** Single-line reason from the latest classification. */
  reason: string | null
  /** When the workspace was last classified (epoch ms; null if never). */
  classifiedAt: number | null
  /** When the lifecycle state last changed (epoch ms; null if never). */
  stateChangedAt: number | null
  /** When anything about this workspace was last recorded (epoch ms). */
  updatedAt: number
  /** Bounded action history, oldest first, newest last. */
  actions: readonly LifecycleAction[]
}

/** Change listener for the HUD's event-driven render (its design D1). */
export type LifecycleListener = (snapshot: LifecycleSnapshot) => void

export interface LifecycleStateStoreOptions {
  /**
   * Maximum recorded actions kept per workspace; the oldest are dropped
   * first. Defaults to 32 — far more than a budgeted session can produce
   * (DEFAULT_MAX_MAINTENANCE_INVOCATIONS_PER_SESSION maintenance spawns),
   * while keeping memory trivially bounded.
   */
  maxActionsPerWorkspace?: number
}

/** Start actions that map onto a background activity (start/settle pairs). */
const ACTIVITY_BY_START: ReadonlyMap<string, LifecycleActivity> = new Map([
  ['indexing-started', 'indexing'],
  ['drift-sync-started', 'syncing'],
  ['rebuild-started', 'rebuilding'],
])

/**
 * Per-session lifecycle-state store. One instance per gate-managed session;
 * `reset()` clears all workspaces when the session ends so a reused store
 * never leaks state across sessions.
 */
export class LifecycleStateStore {
  private readonly maxActionsPerWorkspace: number
  private readonly workspaces = new Map<
    string,
    {
      cwd: string
      state: LifecycleState | null
      activity: LifecycleActivity
      indexed: boolean | null
      reason: string | null
      classifiedAt: number | null
      stateChangedAt: number | null
      updatedAt: number
      actions: LifecycleAction[]
    }
  >()
  private readonly listeners = new Set<LifecycleListener>()

  constructor(options: LifecycleStateStoreOptions = {}) {
    this.maxActionsPerWorkspace = Math.max(1, options.maxActionsPerWorkspace ?? 32)
  }

  /**
   * Record a classification outcome. Overwrites the state, indexed flag,
   * reason, and timestamps; the activity is left untouched (a classification
   * never implies that background work started or stopped — the start/settle
   * action pairs own the activity marker).
   */
  recordClassification(classification: LifecycleClassification): LifecycleSnapshot {
    const now = Date.now()
    const entry = this.entryFor(classification.cwd)
    const stateChanged = entry.state !== classification.state
    entry.state = classification.state
    entry.indexed = classification.indexed
    entry.reason = classification.reason
    entry.classifiedAt = classification.at
    if (stateChanged) entry.stateChangedAt = classification.at
    entry.updatedAt = now
    return this.record(entry, {
      kind: 'classified',
      cwd: classification.cwd,
      detail: classification.reason,
      ok: null,
      at: now,
    })
  }

  /**
   * Record one gate action. Start actions (`*-started` for indexing, drift
   * sync, rebuild) move the activity marker; their settle counterparts and
   * terminal notices/skips return it to `idle`. Unknown kinds record without
   * touching the activity marker.
   */
  recordAction(input: LifecycleActionInput): LifecycleSnapshot {
    const now = input.at ?? Date.now()
    const entry = this.entryFor(input.cwd)
    const activity = ACTIVITY_BY_START.get(input.kind)
    if (activity) {
      entry.activity = activity
    } else if (
      input.kind.endsWith('-settled') ||
      input.kind.endsWith('-notice') ||
      input.kind.endsWith('-skipped')
    ) {
      entry.activity = 'idle'
    }
    entry.updatedAt = now
    return this.record(entry, {
      kind: input.kind,
      cwd: input.cwd,
      detail: input.detail,
      ok: input.ok ?? null,
      at: now,
    })
  }

  /** Read-only snapshot for one workspace; null when nothing was recorded. */
  snapshot(cwd: string): LifecycleSnapshot | null {
    const entry = this.workspaces.get(cwd)
    return entry ? this.freeze(entry) : null
  }

  /** Read-only snapshots for every workspace ever recorded (unordered). */
  snapshots(): readonly LifecycleSnapshot[] {
    return [...this.workspaces.values()].map((entry) => this.freeze(entry))
  }

  /**
   * Subscribe to state changes (HUD design D1: renders are event-driven, no
   * polling). The listener receives the frozen snapshot of the workspace that
   * changed. Returns an unsubscribe function; listeners are also dropped by
   * `reset()`.
   */
  subscribe(listener: LifecycleListener): () => void {
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
        state: null,
        activity: 'idle',
        indexed: null,
        reason: null,
        classifiedAt: null,
        stateChangedAt: null,
        updatedAt: 0,
        actions: [],
      }
      this.workspaces.set(cwd, entry)
    }
    return entry
  }

  private record(
    entry: NonNullable<ReturnType<LifecycleStateStore['entryFor']>>,
    action: LifecycleAction,
  ): LifecycleSnapshot {
    entry.actions.push(action)
    if (entry.actions.length > this.maxActionsPerWorkspace) {
      entry.actions.splice(0, entry.actions.length - this.maxActionsPerWorkspace)
    }

    const snapshot = this.freeze(entry)
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Fail-open: a broken downstream renderer must never break the gate's
        // recording path (the gate hook bodies are try/catch-guarded anyway,
        // task 3.2, but the guarantee starts here).
      }
    }
    return snapshot
  }

  private freeze(
    entry: NonNullable<ReturnType<LifecycleStateStore['entryFor']>>,
  ): LifecycleSnapshot {
    return Object.freeze({
      cwd: entry.cwd,
      state: entry.state,
      activity: entry.activity,
      indexed: entry.indexed,
      lastAction:
        entry.actions.length > 0
          ? (Object.freeze({ ...entry.actions[entry.actions.length - 1] }) as LifecycleAction)
          : null,
      reason: entry.reason,
      classifiedAt: entry.classifiedAt,
      stateChangedAt: entry.stateChangedAt,
      updatedAt: entry.updatedAt,
      actions: Object.freeze(
        entry.actions.map((action) => Object.freeze({ ...action }) as LifecycleAction),
      ),
    })
  }
}
