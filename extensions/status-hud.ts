// Status HUD — the one-line lifecycle chip (openspec/changes/add-cgc-status-hud,
// task 1.2).
//
// Surface pinning (task 1.1, verified against the installed pi docs:
// extensions.md §"Widgets, Status, and Footer" ~2586–2625, tui.md Patterns
// 4/6 ~766–856, rpc.md §notify/§setStatus ~1191–1307):
//   - PRIMARY chip surface: `ctx.ui.setStatus("cgc", text)` — a persistent
//     footer status that composes with the built-in footer (which renders
//     extension statuses via `footerData.getExtensionStatuses()`), persists
//     until cleared with `setStatus("cgc", undefined)`.
//   - `ctx.ui.setFooter` is NOT used: it replaces the built-in footer
//     entirely (and is a no-op in RPC), which would clobber the composable
//     status area — reserved as the degradation path only.
//   - NOTICE surface: `ctx.ui.notify(msg, 'info'|'warning'|'error')` — the
//     session warning path (task 1.4) and the fallback if the chip surface is
//     ever unavailable.
//   - Headless gate (task 1.5, design D4): `ctx.mode === "tui"` (`ctx.hasUI`
//     is ALSO true in RPC, so it cannot gate). The mode is captured here at
//     session start; outside TUI mode the module deactivates entirely — no
//     chip, no TUI notices — and warnings then ride the change-1 lifecycle
//     one-time notices (session-level, not TUI-level).
//
// Rendering contract (design D1/D3): the chip renders EXCLUSIVELY from
// lifecycle-state snapshots (the `state` and `activity` fields); this module
// holds no runner reference and spawns nothing — the passive boundary is
// enforced structurally by task 1.6. Updates are event-driven: the HUD
// subscribes to the lifecycle store at every `session_start` and unsubscribes
// at `session_shutdown` (the gate creates a fresh store per session and its
// `reset()` drops listeners, so the subscription MUST be re-established per
// session; production resolves the gate's per-session store with the
// process-lifetime `getLifecycleStateStore()` as fallback).
//
// Debounce (design D1): the store fires on every record — even when the
// (state, activity) pair did not change — and transition bursts coalesce into
// ONE render: emissions are deduplicated by their (state, activity) pair, and
// a short window (DEBOUNCE_MS) absorbs the burst so only the latest snapshot
// renders. A rejecting TUI surface is swallowed (fail-open) and never retried
// for the same state change (spec: "rendering attempts do not repeat more
// than once per state change"). Fail-open everywhere: no hook body, listener,
// Fail-open everywhere: no hook body, listener,
// or render path throws into pi's event dispatch or the store's listener loop.
//
// Freshness (task 1.3): the chip's freshness contribution exists ONLY while
// the freshness capability is present. The seam is an optional `freshnessFor`
// accessor resolving a subscribable freshness store for the session workspace
// (subscribe + snapshot, the same shape as the lifecycle store); the HUD
// subscribes per session, unsubscribes at shutdown, and merges a marker only
// when freshness is worse than fresh. Today no provider is wired —
// add-cgc-freshness-drift-sync is not installed — so the chip renders
// lifecycle-only (specified degradation, cgc-status-display spec "MUST update
// only from lifecycle (and, when present, freshness) state changes"; design
// D1/D3, migration plan). The store seam keeps the HUD passive: no polling,
// no query on render — updates arrive only as emissions.
//
// Warnings (task 1.4, design D2/D4): the per-session one-time warning set.
// Four conditions a user must know about — cgc-missing, unindexed (with
// auto-create guidance), busy (with lock-conflict naming), corrupt (with the
// rebuild path pointer) — are surfaced through the session notice surface
// (`ctx.ui.notify(msg, 'warning')`, task 1.1 pinning) at most once per
// session each, tracked by a session-scoped condition set. Warnings fire
// from the same event-driven emissions as the chip when a condition state
// enters view and are deduplicated per condition: re-entering a shown
// condition is silent. TUI-only (D4): nothing is emitted outside
// `ctx.mode === "tui"` — in headless/RPC the change-1 lifecycle one-time
// notices (session-level) ride instead. Strictly passive (D3): warning text
// is built only from snapshot fields the gate already captured.

import type { LifecycleState } from './classifier'
import type { LifecycleActivity, LifecycleListener, LifecycleSnapshot } from './lifecycle-state'

/** The extension status key rendered in the TUI footer (task 1.1 pinning). */
export const STATUS_KEY = 'cgc'

/**
 * Debounce window (ms) for coalescing transition bursts (design D1). The
 * store can emit several records in quick succession (classification plus
 * start/settle action pairs); within this window the HUD coalesces them into
 * a single render of the latest snapshot. Injectable per-instance for tests.
 */
export const DEBOUNCE_MS = 150

/**
 * Map a lifecycle (state, activity) pair onto the one-line chip text.
 *
 * Activity wins (design D1/D3): while background work runs the chip shows the
 * running activity ("indexing…", "syncing…", "rebuilding…") instead of the
 * terminal state. Otherwise the terminal state renders, with the healthy pair
 * and the unknown case folded by the chip:
 *   - clean / drift      -> "ready"       (the classifier never emits a
 *                                           literal "ready"; folding the
 *                                           healthy pair is the chip's job)
 *   - state null         -> "unavailable" (no classification yet — the
 *                                           canonical "do nothing, proceed"
 *                                           state, classifier.ts)
 *   - unindexed / busy / corrupt -> the state itself
 */
export function chipTextFor(state: LifecycleState | null, activity: LifecycleActivity): string {
  if (activity !== 'idle') return `${activity}…`
  if (state === null || state === 'unavailable') return 'unavailable'
  if (state === 'clean' || state === 'drift') return 'ready'
  return state
}

/**
 * The freshness marker appended to the one-line chip (task 1.3). Only a
 * freshness state WORSE than fresh earns a marker (design D1: render on
 * change; a fresh graph adds no noise to the chip). `fresh` and `disabled`
 * (tracking explicitly off) render nothing; an unknown future status fails
 * quiet rather than inventing text.
 */
export function freshnessMarkerFor(summary: FreshnessHudSummary | null): string | null {
  if (summary === null) return null
  switch (summary.status) {
    case 'possibly-stale':
      return 'possibly stale'
    case 'syncing':
      return 'syncing'
    case 'skipped-busy':
      return 'busy'
    case 'fresh':
    case 'disabled':
      return null
    default:
      // A future store may add statuses; unknown ones fail quiet.
      return null
  }
}

/**
 * Compose the one-line chip from the latest lifecycle snapshot and (when the
 * capability is present) the latest freshness summary:
 *   - capability absent (`freshness === null`) -> lifecycle-only — the
 *     task 1.3 specified degradation;
 *   - present and fresh/disabled -> the lifecycle text unchanged;
 *   - present and worse-than-fresh -> the lifecycle text plus a
 *     parenthesized marker ("ready (possibly stale)"), or the bare marker
 *     ("possibly stale") when no lifecycle record exists yet;
 *   - no lifecycle record and no marker -> undefined (the chip clears).
 */
export function composeChipText(
  snapshot: LifecycleSnapshot | null,
  freshness: FreshnessHudSummary | null,
): string | undefined {
  const base = snapshot === null ? undefined : chipTextFor(snapshot.state, snapshot.activity)
  const marker = freshnessMarkerFor(freshness)
  if (marker === null) return base
  if (base === undefined) return marker
  return `${base} (${marker})`
}

// ---------------------------------------------------------------------------
// Per-session one-time warning set (task 1.4, design D2/D4).
//
// Four conditions a user must know about, each with an actionable hint:
//   - cgc-missing  (state `unavailable`) — the `cgc` binary is not usable;
//                    how to enable it (PATH / config file / env override).
//   - unindexed    (state `unindexed`)    — no index; guidance on enabling
//                    the opt-in `lifecycle.autoCreate` creation.
//   - busy         (state `busy`)         — the lock conflict is named from
//                    the classification reason / last action detail.
//   - corrupt      (state `corrupt`)      — the corrupt state is described
//                    and the rebuild path pointed at (`cgc index . --force`
//                    / `/cgc index --force` after explicit confirmation).
//
// Each condition is surfaced AT MOST ONCE per session through the session
// notice surface (`ctx.ui.notify(msg, 'warning')`, task 1.1 pinning),
// tracked by the session-scoped {@link WarningSet}; re-entering a shown
// condition is silent (spec: "Warnings never repeat within a session").
// Warnings are TUI-only (design D4): no notice is emitted unless the session
// runs in `ctx.mode === "tui"` — outside the TUI the change-1 lifecycle
// one-time notices (session-level) ride instead, and a host without a notify
// surface gets none. Strictly passive (D3): every builder derives from
// snapshot fields the gate already captured — never a spawn, never a poll,
// and this module still holds no runner reference.
// ---------------------------------------------------------------------------

/** The four one-time warning conditions (design D2). */
export type WarningCondition = 'cgc-missing' | 'unindexed' | 'busy' | 'corrupt'

/** The notice-surface severity the display may emit (task 1.1 pinning). */
export type NoticeSeverity = 'info' | 'warning' | 'error'

/** One warning emission derived from an accepted lifecycle snapshot. */
export interface HudWarningInput {
  condition: WarningCondition
  /** The workspace the warning applies to (the session cwd from the snapshot). */
  cwd: string
  /**
   * Single-line context (classification reason, lock-conflict detail,
   * fail-safe bucket); may be empty.
   */
  detail: string
}

/**
 * The warning condition a lifecycle state maps onto; null for the healthy
 * pair and for "no record yet" — a null state is the chip's "unavailable"
 * rendering CONVENTION, not a cgc-missing classification (only a real
 * `unavailable` state warns).
 */
export function warningConditionFor(state: LifecycleState | null): WarningCondition | null {
  switch (state) {
    case 'unavailable':
      return 'cgc-missing'
    case 'unindexed':
      return 'unindexed'
    case 'busy':
      return 'busy'
    case 'corrupt':
      return 'corrupt'
    default:
      return null
  }
}

/**
 * Derive a warning input from an accepted snapshot, or null when the state
 * carries no warning condition. The detail prefers the classifier's reason
 * (which names the busy lock conflict and the corrupt fail-safe bucket) and
 * falls back to the last recorded action's detail.
 */
export function warningInputFor(snapshot: LifecycleSnapshot): HudWarningInput | null {
  const condition = warningConditionFor(snapshot.state)
  if (condition === null) return null
  const reason = (snapshot.reason ?? '').trim()
  const detail = reason.length > 0 ? reason : (snapshot.lastAction?.detail ?? '').trim()
  return { condition, cwd: snapshot.cwd, detail }
}

/** The one-time cgc-missing warning: what is missing and how to enable it. */
export function buildCgcMissingWarning(cwd: string, detail = ''): string {
  const detected = detail.length > 0 ? ` (${detail})` : ''
  return [
    `CGC: the cgc CLI is unavailable for ${cwd}${detected} — graph-index features are disabled for this session.`,
    'To enable them, install CodeGraphContext and make sure `cgc` is on PATH, or set "cgc": { "executable": "…" } in .pi/cgc.json (project) / ~/.pi/agent/cgc.json (global), or CGC_EXECUTABLE.',
  ].join('\n')
}

/** The one-time unindexed warning: no index, and how to enable automatic creation. */
export function buildUnindexedWarning(cwd: string): string {
  return [
    `CGC: the workspace at ${cwd} has no code index, so graph queries will return empty or failed results.`,
    'Index creation is opt-in and was not performed. To enable it, set "lifecycle": { "autoCreate": true } in .pi/cgc.json (project) or ~/.pi/agent/cgc.json (global), or CGC_LIFECYCLE_AUTO_CREATE=1 — indexing then starts automatically in the background at session start. To index once without opting in, run `cgc index .` in the workspace.',
    'This session continues without an index; you will not be asked again.',
  ].join('\n')
}

/** The one-time busy warning: the lock conflict is named, plus what is NOT done. */
export function buildBusyWarning(cwd: string, detail = ''): string {
  const detected = detail.length > 0 ? ` (${detail})` : ''
  return [
    `CGC: ${cwd} is busy — another CGC process holds the embedded database${detected}.`,
    'The extension will not retry the skipped work, terminate the other process, or delete lock files. If you want the skipped maintenance now, stop the other CGC process (for example a running `cgc watch` or the CGC MCP server), then run the command manually (for example `cgc index .`).',
  ].join('\n')
}

/** The one-time corrupt warning: the corrupt state described, with the rebuild pointer. */
export function buildCorruptWarning(cwd: string, detail = ''): string {
  const detected = detail.length > 0 ? ` (${detail})` : ''
  return [
    `CGC: the code index at ${cwd} appears corrupt or unusable${detected}. Nothing has been changed or deleted.`,
    'To fix it, the index must be rebuilt from scratch (`cgc index . --force` — in-session: `/cgc index --force`), which replaces the existing index. A rebuild is only performed after you explicitly confirm it in this session; the extension never rebuilds or deletes on its own.',
  ].join('\n')
}

/** Build the full warning text for a derived warning input (dispatcher). */
export function buildWarningText(input: HudWarningInput): string {
  switch (input.condition) {
    case 'cgc-missing':
      return buildCgcMissingWarning(input.cwd, input.detail)
    case 'unindexed':
      return buildUnindexedWarning(input.cwd)
    case 'busy':
      return buildBusyWarning(input.cwd, input.detail)
    case 'corrupt':
      return buildCorruptWarning(input.cwd, input.detail)
  }
}

/**
 * The per-session one-time warning set (design D2): each condition may be
 * surfaced at most once per session. One instance per display; `reset()`
 * clears it at session shutdown (and disposal), so a fresh session may
 * re-warn. Never throws.
 */
export class WarningSet {
  private readonly surfacedConditions = new Set<WarningCondition>()

  /** Whether `condition` still needs surfacing this session. */
  shouldSurface(condition: WarningCondition): boolean {
    return !this.surfacedConditions.has(condition)
  }

  /** Record that `condition` was surfaced this session. */
  mark(condition: WarningCondition): void {
    this.surfacedConditions.add(condition)
  }

  /** Conditions already surfaced this session, in surface order (tests/diagnostics). */
  surfaced(): readonly WarningCondition[] {
    return [...this.surfacedConditions]
  }

  /** Clear the set (session shutdown / fresh session). */
  reset(): void {
    this.surfacedConditions.clear()
  }
}

/**
 * The narrow store surface the HUD consumes (the real
 * {@link LifecycleStateStore} satisfies it structurally; tests may pass a
 * stand-in). Subscribe receives every recorded snapshot for every workspace
 * the store knows; `snapshot` returns the current state for one workspace.
 */
export interface StatusHudStore {
  subscribe(listener: LifecycleListener): () => void
  snapshot(cwd: string): LifecycleSnapshot | null
}

/**
 * Freshness states a future freshness store can report — the status literals
 * of add-cgc-freshness-drift-sync design D5, the same set the `/cgc status`
 * renderer labels. The HUD consumes them through a store seam identical to
 * the lifecycle store's, keeping the chip a passive subscriber.
 */
export type FreshnessStatus = 'fresh' | 'possibly-stale' | 'syncing' | 'skipped-busy' | 'disabled'

/**
 * One freshness emission, scoped to the workspace it describes (a future
 * freshness store emits these; the HUD renders the ACTIVE session workspace
 * only, exactly like lifecycle snapshots).
 */
export interface FreshnessHudSummary {
  /** The workspace root this state applies to (the Pi session cwd). */
  cwd: string
  status: FreshnessStatus
  /** When the last incremental sync completed (epoch ms); null when none ran. */
  lastSyncedAt: number | null
  /** When the workspace was marked possibly stale (epoch ms); null when fresh. */
  staleSince: number | null
}

/** Freshness change listener for the event-driven chip (design D1). */
export type FreshnessHudListener = (summary: FreshnessHudSummary) => void

/**
 * The narrow freshness store surface the HUD consumes when the capability is
 * present (structural, like {@link StatusHudStore}; a future
 * add-cgc-freshness-drift-sync store satisfies it).
 */
export interface FreshnessHudStore {
  subscribe(listener: FreshnessHudListener): () => void
  snapshot(cwd: string): FreshnessHudSummary | null
}

/**
 * Minimal Pi extension API surface the HUD registers hooks on (the same
 * structural seam pattern as cleanup.ts / gate.ts: the real `ExtensionAPI`
 * satisfies it; tests pass a recorder).
 */
export interface StatusHudExtensionApi {
  on(event: 'session_start', handler: (event: unknown, ctx: unknown) => unknown): unknown
  on(event: 'session_shutdown', handler: (event: unknown, ctx: unknown) => unknown): unknown
}

/** The slice of the Pi session context the HUD reads (defensive narrowing). */
interface StatusHudSessionContext {
  cwd?: unknown
  mode?: unknown
  ui?: unknown
}

interface StatusHudUiContext {
  setStatus?: unknown
  notify?: unknown
}

export interface StatusHudOptions {
  /**
   * Resolves the lifecycle store for a session workspace. Production wires
   * the gate's per-session store (`lifecycleStore()`) with the
   * process-lifetime `getLifecycleStateStore()` as fallback; tests pass a
   * store they drive directly. Null means no store is reachable — the HUD
   * then renders nothing (the chip stays cleared) and records nothing.
   */
  storeFor: (cwd: string) => StatusHudStore | null
  /**
   * Resolves the freshness store for a session workspace (task 1.3). Omit
   * — or return null — when the freshness capability is absent
   * (add-cgc-freshness-drift-sync is not installed): the chip then renders
   * lifecycle-only (specified degradation). When present the HUD subscribes
   * to the store's emissions and merges a worse-than-fresh marker into the
   * chip, with the same per-session subscribe / shutdown-unsubscribe and
   * fail-open discipline as the lifecycle store.
   */
  freshnessFor?: (cwd: string) => FreshnessHudStore | null
  /**
   * Pi extension API receiving the session hooks. When omitted (tests driving
   * the class directly), `register()` is a no-op.
   */
  api?: StatusHudExtensionApi
  /**
   * Debounce window in milliseconds; defaults to {@link DEBOUNCE_MS}.
   * Shortened in tests to keep them fast and deterministic.
   */
  debounceMs?: number
}

/** The combined lifecycle + freshness view awaiting the debounce timer. */
interface PendingRender {
  lifecycle: LifecycleSnapshot | null
  freshness: FreshnessHudSummary | null
}

/**
 * The one-line lifecycle chip (task 1.2; freshness merge task 1.3).
 * Event-driven and strictly passive: it subscribes to lifecycle-state
 * snapshots — and freshness emissions when that capability is present — and
 * renders the ACTIVE session workspace's state through
 * `ui.setStatus(STATUS_KEY, …)`; it never polls, never spawns, and never
 * touches the agent's context or prompt (spec "Human-facing only"). Rapid
 * transitions debounce-coalesce per design D1. Task 1.4 adds the
 * per-session one-time warning set (design D2): accepted condition states
 * surface through the session notice surface (`ui.notify`, TUI-only), at
 * most once per condition per session. Task 1.5 (design D4) gates the
 * whole module to TUI sessions: outside `ctx.mode === "tui"` the display
 * fully deactivates — no chip rendering and no notice emissions through
 * TUI surfaces (headless-safe, spec "Headless operation is a no-op").
 */
export class StatusHud {
  private readonly debounceMs: number
  private api: StatusHudExtensionApi | undefined
  private readonly storeFor: (cwd: string) => StatusHudStore | null
  private readonly freshnessFor: ((cwd: string) => FreshnessHudStore | null) | undefined

  private registered = false
  private disposed = false

  /** The session workspace the chip renders (from ctx.cwd — never process.cwd()). */
  private activeCwd: string | undefined
  /**
   * The session mode, captured at session start. The task 1.5 headless gate
   * (D4): only a `"tui"` session activates the display — any other mode (or
   * a missing one) deactivates the module entirely for that session.
   */
  private activeMode: string | undefined
  /** The `ui.setStatus` captured from the most recent session-start context. */
  private setStatus: ((key: string, text: string | undefined) => unknown) | undefined
  /**
   * The `ui.notify` captured from the most recent session-start context (the
   * task 1.4 session notice surface; task 1.1 pinning).
   */
  private notify: ((message: string, severity: NoticeSeverity) => unknown) | undefined
  /**
   * The per-session one-time warning set (task 1.4, design D2): each
   * condition is surfaced at most once per session. Reset at session
   * shutdown (and disposal).
   */
  private readonly warnings = new WarningSet()
  /** The store subscription for the current session (unsubscribed at shutdown). */
  private unsubscribe: (() => void) | undefined
  /** The freshness store subscription (task 1.3; unsubscribed at shutdown). */
  private freshnessUnsubscribe: (() => void) | undefined

  /** Dedupe key of the last accepted emission (undefined before the first). */
  private lastEmittedKey: string | undefined
  /** Latest accepted lifecycle snapshot (rendered after the freshness merge). */
  private lastLifecycle: LifecycleSnapshot | null = null
  /** Latest accepted freshness summary; null when none (or capability absent). */
  private lastFreshness: FreshnessHudSummary | null = null
  /** The combined view awaiting the debounce timer; undefined when nothing is pending. */
  private pending: PendingRender | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(options: StatusHudOptions) {
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS
    this.api = options.api
    this.storeFor = options.storeFor
    this.freshnessFor = options.freshnessFor
  }

  /** The session cwd the HUD renders against (tests / diagnostics). */
  currentSessionCwd(): string | undefined {
    return this.activeCwd
  }

  /** The session mode captured at session start (tests / diagnostics; task 1.5 gate). */
  currentSessionMode(): string | undefined {
    return this.activeMode
  }

  /**
   * Wire the `session_start` and `session_shutdown` hooks. Idempotent and
   * fail-open: a broken API never throws out of registration (the hooks are
   * also individually guarded). No-op after `dispose()`.
   *
   * Session rebind (add-cgc-session-rebind): when `api` is supplied and
   * differs from the API this HUD is wired to (pi re-runs the factory on
   * every session replacement), adopt it, re-arm the registration flag, and
   * wire the hooks onto the new API. The same API stays the idempotent no-op.
   */
  register(api?: StatusHudExtensionApi): void {
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
    } catch {
      // Fail-open: extension load must never break on a throwing API.
    }
    try {
      target.on('session_shutdown', this.handleSessionShutdown)
    } catch {
      // Fail-open (same rationale).
    }
  }

  /**
   * Mark the HUD inert (the Pi API has no hook-removal surface, so the
   * registered handlers become no-ops). Idempotent; for tests and reload
   * paths. Never throws.
   */
  dispose(): void {
    this.disposed = true
    this.registered = false
    try {
      this.detachStore()
      this.warnings.reset()
    } catch {
      // Fail-open: disposal must never throw.
    }
  }

  /**
   * Session-start hook body. Captures the TUI chip surface and the session
   * workspace, re-subscribes to the (per-session) lifecycle store, and
   * renders the current state (a fresh gate store has no record yet, so the
   * chip starts cleared and fills in when the classification lands). Task
   * 1.5 gate: outside a TUI session the body returns right after detaching
   * the previous session — the module deactivates entirely for that session
   * (no subscription, no render, no notices). Every branch is guarded so the
   * hook can never throw into pi's event dispatch.
   */
  private readonly handleSessionStart = (_event: unknown, ctx: unknown): void => {
    if (this.disposed) return
    try {
      const context = (ctx ?? {}) as StatusHudSessionContext
      const ui = (context.ui ?? {}) as StatusHudUiContext
      const cwd =
        typeof context.cwd === 'string' && context.cwd.length > 0 ? context.cwd : undefined
      this.activeCwd = cwd
      this.activeMode = typeof context.mode === 'string' ? context.mode : undefined
      this.setStatus =
        typeof ui.setStatus === 'function'
          ? (ui.setStatus as (key: string, text: string | undefined) => unknown)
          : undefined
      this.notify =
        typeof ui.notify === 'function'
          ? (ui.notify as (message: string, severity: NoticeSeverity) => unknown)
          : undefined

      // Re-subscribe per session: the gate creates a fresh store per session
      // and its `reset()` drops listeners, so a stale subscription would go
      // silent. Production resolves the gate store; without one the
      // process-lifetime fallback's last record is the best available state.
      this.detachStore()

      // Task 1.5 (design D4) — full headless deactivation: the display
      // module activates ONLY inside a TUI session (`ctx.mode === "tui"`;
      // `ctx.hasUI` is also true in RPC and cannot gate). Outside the TUI
      // this session the HUD does no work at all — no store subscription, no
      // initial snapshot, no chip rendering, no notice emissions through TUI
      // surfaces (the change-1 lifecycle one-time notices are the headless
      // path there). A host that omits `mode` is not TUI: the headless-safe
      // default, kept consistent with the warnings gate below.
      if (this.activeMode !== 'tui') return

      let initial: LifecycleSnapshot | null = null
      let initialFreshness: FreshnessHudSummary | null = null
      if (cwd !== undefined) {
        const store = this.storeFor(cwd)
        if (store !== null) {
          try {
            this.unsubscribe = store.subscribe(this.onSnapshot)
          } catch {
            // Fail-open: an unsubscribable store degrades to the one-shot
            // initial snapshot below (no live updates this session).
            this.unsubscribe = undefined
          }
          try {
            initial = store.snapshot(cwd)
          } catch {
            // Fail-open: an unreadable snapshot degrades to a cleared chip.
            initial = null
          }
        }

        // Freshness capability (task 1.3): subscribe ONLY when present — an
        // absent provider (add-cgc-freshness-drift-sync not installed) keeps
        // the chip lifecycle-only, the specified degradation. Same
        // subscribe + initial-snapshot + fail-open shape as the lifecycle
        // store; a broken provider degrades this session, nothing throws.
        if (typeof this.freshnessFor === 'function') {
          try {
            const freshnessStore = this.freshnessFor(cwd)
            if (freshnessStore !== null) {
              try {
                this.freshnessUnsubscribe = freshnessStore.subscribe(this.onFreshness)
              } catch {
                this.freshnessUnsubscribe = undefined
              }
              try {
                initialFreshness = freshnessStore.snapshot(cwd) ?? null
              } catch {
                initialFreshness = null
              }
            }
          } catch {
            this.freshnessUnsubscribe = undefined
            initialFreshness = null
          }
        }
      }
      // Initial render: the fallback store's last record, or a clear when the
      // fresh gate store has no record yet. This also repairs a missed
      // emission when the store already held state before we subscribed.
      this.accept(initial, initialFreshness)
    } catch {
      // Fail-open: a session_start hook body must never throw.
    }
  }

  /** Session-shutdown hook: unsubscribe; the footer chip keeps its last state. */
  private readonly handleSessionShutdown = (): void => {
    if (this.disposed) return
    try {
      this.detachStore()
      this.activeCwd = undefined
      this.activeMode = undefined
      this.notify = undefined
      // Fresh session, fresh warning set (design D2): the conditions shown
      // last session may be shown again once the next session re-encounters
      // them (they are worth knowing about again in a new session).
      this.warnings.reset()
    } catch {
      // Fail-open: shutdown must never throw.
    }
  }

  /** Store listener body (also feeds the initial snapshot). Never throws. */
  private readonly onSnapshot = (snapshot: LifecycleSnapshot): void => {
    this.accept(snapshot, this.lastFreshness)
  }

  /** Freshness store listener (task 1.3). Never throws. */
  private readonly onFreshness = (summary: FreshnessHudSummary): void => {
    this.accept(this.lastLifecycle, summary)
  }

  /**
   * Accept one emission from either store: deduplicate by the
   * (state, activity, freshness) triple — the stores fire on every record,
   * even unchanged state — then arm the debounce so a burst of transitions
   * coalesces into one render of the latest combined view. A null lifecycle
   * snapshot means "no record" (the chip clears) unless freshness carries the
   * render; null freshness means "no record / no capability". Never throws
   * (this runs inside a store's listener loop; the stores already guard, but
   * the guarantee starts here).
   */
  private accept(lifecycle: LifecycleSnapshot | null, freshness: FreshnessHudSummary | null): void {
    try {
      // The chip renders the ACTIVE session workspace only; records for other
      // workspaces in the same store never touch it. When no session cwd was
      // captured (a host that omits it) the store's records are the best
      // available signal — best-effort render rather than a wrong-filtered
      // silence.
      if (lifecycle !== null && this.activeCwd !== undefined && lifecycle.cwd !== this.activeCwd)
        return
      if (freshness !== null && this.activeCwd !== undefined && freshness.cwd !== this.activeCwd)
        return

      // Warnings (task 1.4, D2): accepted emissions of a warning condition
      // surface through the session notice surface once per condition per
      // session (see surfaceWarnings). Evaluated BEFORE the chip's key-based
      // dedupe so a warning never depends on chip-dedupe behavior — its own
      // condition set is the only gate.
      this.surfaceWarnings(lifecycle)

      const lifecycleKey =
        lifecycle === null ? 'none' : `${lifecycle.state ?? 'null'}|${lifecycle.activity}`
      const freshnessKey = freshness === null ? 'none' : freshness.status
      const key = `${lifecycleKey}|${freshnessKey}`
      if (key === this.lastEmittedKey) return
      this.lastEmittedKey = key
      this.lastLifecycle = lifecycle
      this.lastFreshness = freshness
      this.pending = { lifecycle, freshness }
      this.armTimer()
    } catch {
      // Fail-open: a broken listener must never break the store's dispatch.
    }
  }

  /**
   * Task 1.4 (design D2/D4): accepted emissions of a warning condition are
   * surfaced through the session notice surface at most once per condition
   * per session. TUI-only — a non-`tui` session (or a host without a notify
   * surface) emits nothing; outside the TUI the change-1 lifecycle one-time
   * notices are the session-level path (design D4). The condition is marked
   * BEFORE the notify call: a rejecting TUI surface is swallowed and never
   * re-attempted for that condition this session (the same one-attempt
   * discipline as the chip, spec "rendering attempts do not repeat more than
   * once per state change"). Never throws.
   */
  private surfaceWarnings(lifecycle: LifecycleSnapshot | null): void {
    try {
      if (lifecycle === null) return
      // Design D4: the notice surface is TUI-only; a missing mode is not TUI.
      if (this.activeMode !== 'tui') return
      const notify = this.notify
      if (typeof notify !== 'function') return
      const input = warningInputFor(lifecycle)
      if (input === null) return
      if (!this.warnings.shouldSurface(input.condition)) return
      this.warnings.mark(input.condition)
      notify(buildWarningText(input), 'warning')
    } catch {
      // Fail-open: a broken warning path must never break the store dispatch.
    }
  }

  /** Arm (or re-arm) the one-shot debounce window. */
  private armTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.debounceMs)
  }

  /** Debounce fired: render the latest pending combined view, exactly once. */
  private flush(): void {
    const pending = this.pending
    if (pending === undefined) return
    this.pending = undefined
    this.render(pending.lifecycle, pending.freshness)
  }

  /**
   * The one render path: `setStatus(STATUS_KEY, text)` (undefined clears the
   * chip). Composes lifecycle + optional freshness (task 1.3). Wrapped so a
   * rejecting TUI surface is swallowed; the dedupe already consumed this
   * state change, so a failed render is never retried for the same state
   * (spec: no more than one attempt per state change).
   */
  private render(lifecycle: LifecycleSnapshot | null, freshness: FreshnessHudSummary | null): void {
    try {
      // Task 1.5 gate, defense-in-depth: only a TUI session renders the chip.
      // The session-start gate keeps non-TUI sessions from ever reaching here
      // (no subscription, no timer); this guard makes the headless boundary
      // structural so no render path can fire outside a TUI session even if a
      // future caller reaches it.
      if (this.activeMode !== 'tui') return
      const setStatus = this.setStatus
      if (typeof setStatus !== 'function') return
      setStatus(STATUS_KEY, composeChipText(lifecycle, freshness))
    } catch {
      // Fail-open: a throwing TUI surface must never affect the session.
    }
  }

  /** Drop the debounce timer and the session subscription (shutdown / re-subscribe). */
  private detachStore(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.pending = undefined
    if (this.unsubscribe !== undefined) {
      try {
        this.unsubscribe()
      } catch {
        // Fail-open: an unsubscriber must never break the teardown path.
      }
      this.unsubscribe = undefined
    }
    if (this.freshnessUnsubscribe !== undefined) {
      try {
        this.freshnessUnsubscribe()
      } catch {
        // Fail-open: an unsubscriber must never break the teardown path.
      }
      this.freshnessUnsubscribe = undefined
    }
  }
}
