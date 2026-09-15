// Always-on routing guideline card (design D2/D3/D4 of
// openspec/changes/add-cgc-agent-routing-guidance, task 1.1).
//
// This module owns the compact, always-on guideline CONTENT: the static,
// bundled, versioned card injected once per session when guidance is ready.
// Task 1.1 authors only the card and its budget; the readiness gate and the
// one-shot `before_agent_start` injector (task 2.2) land in this same module.
//
// Design boundaries:
//
//   - D2: the card has no configuration key and no off switch of its own. The
//     only removal path is disabling or uninstalling the extension.
//   - D3: the content is static and versioned with the extension; it fetches
//     nothing and spawns nothing. The scope line pins the supported CGC range
//     ("CodeGraphContext v0.6.x"), so content changes ship as releases.
//   - D4: delivery is a one-shot `before_agent_start` system-prompt append; the
//     injector is deliberately NOT built here.
//
// Content-class boundary (design D5 / change 1): this card renders routing
// RULES. Coverage FACTS belong to the proactive module (`proactive.ts`); the
// structural duplication test there asserts the two content classes stay
// disjoint.
//
// Advisory only (spec "Advisory routing content"): the card names graph
// relationship queries as the route for relationship-shaped questions and
// explicitly leaves exact-string work with built-in search and file reading.
// It never blocks, restricts, or forbids any tool, and its primary routing
// phrasing is tool-name-agnostic ("graph relationship queries") so a missing
// MCP server degrades gracefully.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { LifecycleActivity, LifecycleSnapshot } from './lifecycle-state'
import { isGuidanceReady } from './proactive'

/**
 * Hard line budget for the always-on card (design risk row: "Guideline text
 * grows and bloats every session prompt"). The card must stay at or under this
 * many lines; the budget is asserted by test (`guidance.test.ts`).
 */
export const GUIDANCE_CARD_MAX_LINES = 10

/** Supported CGC version range this card is written against (design D3). */
export const GUIDANCE_SCOPE = 'CodeGraphContext v0.6.x'

/**
 * The compact always-on routing guideline card, one entry per rendered line.
 * The card is the shipped content itself: static, bundled, and versioned with
 * the extension (design D3) — no runtime rendering, fetching, or spawning.
 */
export const GUIDANCE_CARD_LINES: readonly string[] = [
  `${GUIDANCE_SCOPE} routing guidance:`,
  '- Relationship-shaped questions — callers, callees, call chains, impact, dead',
  '  code, or complexity — are best answered with graph relationship queries.',
  '- Exact-string and literal lookups, and reading known files, stay with your',
  '  built-in search and file reading; graph queries are not required for them.',
  '- Graph relationship queries come from the CGC MCP server when it is configured;',
  '  if it is unavailable, use built-in search.',
  '- This guidance is advisory: it never blocks or restricts any tool.',
]

/**
 * The card as a single string, ready to append to the system prompt. Kept as a
 * derived export so callers never hand-roll the line join.
 */
export const GUIDANCE_CARD = GUIDANCE_CARD_LINES.join('\n')

/**
 * Task 2.1 — the guidance-readiness predicate (design D1, spec "Readiness
 * gating of guidance"): guidance is ready only when `cgc` is available AND the
 * active workspace's index exists or is being created.
 *
 * The lifecycle gate (add-cgc-session-lifecycle-gate) models "exists" as the
 * terminal pair `clean`/`drift` and "being created" as the background-activity
 * markers `indexing`/`syncing`/`rebuilding` (lifecycle-state.ts). This
 * predicate composes both halves:
 *
 *   - the STATE half delegates to the ONE shared ADR-0002 predicate
 *     ({@link isGuidanceReady}, imported from `proactive.ts`) so change 2 and
 *     every proactive tier gate on the same function — no re-derivation, and
 *     the structural duplication test's identity assertion keeps holding;
 *   - the ACTIVITY half accepts the three transient maintenance markers, so an
 *     index being created (autoCreate indexing, drift syncing, rebuild) is
 *     ready even though the terminal state is still `unindexed` or `corrupt`.
 *     `rebuilding` counts as ready by explicit design decision (D1: during a
 *     rebuild an index is being created).
 *
 * The four suppressing terminal states (`unavailable`, `unindexed`, `busy`,
 * `corrupt`) suppress while their activity is `idle`.
 *
 * Degradation (design Migration Plan): if the lifecycle gate change is absent
 * there is no snapshot to read. {@link createGuidanceReadiness} turns a missing
 * or never-ready source into a PERMANENTLY suppressed predicate; a null or
 * undefined snapshot is never ready.
 */
export type GuidanceReadinessPredicate = (snapshot: LifecycleSnapshot | null | undefined) => boolean

/**
 * The background-activity markers that mean an index is being created
 * (design D1: `indexing`, `syncing`, `rebuilding` — `rebuilding` counts as
 * ready). Kept as a set so the predicate is a membership test, not a chain of
 * literals a future marker could silently miss.
 */
export const GUIDANCE_READY_ACTIVITIES: ReadonlySet<LifecycleActivity> = new Set([
  'indexing',
  'syncing',
  'rebuilding',
])

/**
 * The pure readiness predicate over one lifecycle snapshot. Null/undefined
 * (no classification recorded yet, or the lifecycle change absent) is not
 * ready. Never throws and never reads anything but its argument.
 */
export function isGuidanceReadyForSnapshot(
  snapshot: LifecycleSnapshot | null | undefined,
): boolean {
  if (snapshot === null || snapshot === undefined) return false
  if (isGuidanceReady(snapshot.state)) return true
  return GUIDANCE_READY_ACTIVITIES.has(snapshot.activity)
}

/**
 * Zero-spawn snapshot source: the current lifecycle snapshot for a workspace,
 * or null/undefined when none exists yet. Production wires the gate's
 * per-session store's `snapshot(cwd)`; tests pass canned data. Nothing here
 * spawns `cgc` — the snapshot is already-captured gate state (ADR-0001).
 */
export type GuidanceSnapshotSource = (cwd: string) => LifecycleSnapshot | null | undefined

/** Per-workspace readiness check built from a snapshot source. */
export type GuidanceReadiness = (cwd: string) => boolean

/**
 * Build a workspace readiness check from a snapshot source. Omitting the
 * source — the lifecycle gate change absent — degrades to a PERMANENTLY
 * suppressed predicate: it returns false for every workspace forever. Every
 * evaluation is fail-open, so a throwing source is reported as not ready
 * rather than propagated into the agent loop.
 */
export function createGuidanceReadiness(source?: GuidanceSnapshotSource): GuidanceReadiness {
  if (source === undefined) return () => false
  return (cwd: string): boolean => {
    try {
      return isGuidanceReadyForSnapshot(source(cwd))
    } catch {
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// Task 2.2: one-shot `before_agent_start` delivery of the always-on card
// (design D2/D4, spec "Always-on routing guidelines" / "Readiness gating of
// guidance" / "Fail-open guidance delivery").
// ---------------------------------------------------------------------------

/**
 * Minimal Pi extension API surface the guidance injector registers hooks on
 * (the same structural seam pattern as cleanup.ts / gate.ts / proactive.ts:
 * the real `ExtensionAPI` satisfies it). Three hooks:
 *   - `session_start` — capture the session cwd (the source of truth, never
 *     `process.cwd()`) and re-arm the one-shot,
 *   - `before_agent_start` — the injection point: append the card to the
 *     chained system prompt at most once, on the first ready turn,
 *   - `session_shutdown` — clear the session cwd and re-arm for the next
 *     session.
 */
export interface GuidanceInjectionApi {
  on(event: 'before_agent_start', handler: (event: unknown, ctx: unknown) => unknown): unknown
  on(event: 'session_start', handler: (event: unknown, ctx: unknown) => unknown): unknown
  on(event: 'session_shutdown', handler: (event: unknown, ctx: unknown) => unknown): unknown
}

/**
 * Zero-spawn snapshot provider: the current lifecycle snapshot for a workspace,
 * or null/undefined when none exists yet. Production wires the gate's
 * per-session store `snapshot(cwd)` with the process-lifetime store as
 * fallback; tests pass canned data. Nothing here spawns `cgc`.
 */
export type GuidanceSnapshotProvider = (cwd: string) => LifecycleSnapshot | null | undefined

/** Retry budget: a failing injection is retried at most once per session (spec). */
export const GUIDANCE_RETRY_BUDGET = 1

export interface GuidanceInjectorOptions {
  /** Snapshot source (see {@link GuidanceSnapshotProvider}); omitted -> permanently suppressed. */
  snapshotFor?: GuidanceSnapshotProvider
  /**
   * The predicate the injector gates delivery on. Defaults to the module-level
   * {@link isGuidanceReadyForSnapshot} — which delegates its STATE half to the
   * ONE shared ADR-0002 predicate ({@link isGuidanceReady}, imported from
   * `proactive.ts`); no per-tier re-derivation. Injectable so tests can drive
   * the readiness outcome directly.
   */
  readiness?: GuidanceReadinessPredicate
  /** Pi API receiving the hooks. When omitted, `register()` is a no-op. */
  api?: GuidanceInjectionApi
  /**
   * When true, the delivered card carries the `/skill:cgc-routing` pointer
   * (the user-executable routing skill). Wired from `guidance.routingSkill`.
   */
  routingSkillPointer?: boolean
  /** Optional error sink: every contained delivery error is reported here once. */
  onError?: (message: string) => void
}

/**
 * One-shot, readiness-gated injection of the always-on routing card (design
 * D2/D4, task 2.2). Wires `session_start` / `session_shutdown` /
 * `before_agent_start` on the Pi extension API. The `before_agent_start`
 * handler returns the CHAINED system prompt (`systemPrompt: event.systemPrompt
 * + card`) exactly once per session, on the first turn where:
 *
 *   1. the card has not already been injected this session (`injected`),
 *   2. the session workspace is known (`session_start` ctx.cwd, with the
 *      documented `event.systemPromptOptions.cwd` fallback — never
 *      `process.cwd()`),
 *   3. the ADR-0002 readiness predicate holds over the workspace's lifecycle
 *      snapshot (design D1: `cgc` available AND the index exists or is being
 *      created),
 *   4. a real chained system prompt string is present (defensive: never replace
 *      Pi's prompt with only the card).
 *
 * A NOT-ready turn is a deferral, not a failure: it returns undefined and does
 * NOT spend the one-shot, so the first ready turn wins — including a
 * mid-session readiness transition (`unindexed` -> `clean` later in the same
 * session) injects exactly once, never on every turn (task 2.2's at-most-once
 * guarantee).
 *
 * Guarantees:
 *   - at most once per session — `injected` arms when the card is appended,
 *     re-arms on `session_start`/`session_shutdown`,
 *   - zero spawns — delivery renders the bundled card from a snapshot the
 *     lifecycle gate already captured (ADR-0001),
 *   - fail-open — `register()` never throws; every hook body (registration,
 *     `session_start`, `session_shutdown`, `before_agent_start`) is guarded so
 *     it can never throw into pi's event dispatch or reject a turn, and every
 *     contained failure is recorded (in the in-memory ledger and, when given,
 *     the error sink). A delivery FAILURE is additionally retried at most once
 *     per session ({@link GUIDANCE_RETRY_BUDGET}), then the injector goes
 *     silent until the next session (spec "Fail-open guidance delivery"),
 *   - no opt-out (design D2) — the injector has no on/off switch; the only
 *     removal path is disabling the extension.
 */
export class GuidanceInjector {
  private readonly snapshotFor: GuidanceSnapshotProvider | undefined
  private readonly readiness: GuidanceReadinessPredicate
  private readonly api: GuidanceInjectionApi | undefined
  private readonly onError: ((message: string) => void) | undefined
  /** When true, the delivered card carries the `/skill:cgc-routing` pointer. */
  /** When true, the delivered card carries the `/skill:cgc-routing` pointer. */
  private readonly routingSkillPointer: boolean

  private registered = false
  private disposed = false
  /** The session cwd captured from the latest `session_start` (never process.cwd()). */
  private sessionCwd: string | undefined
  /** At-most-once-per-session marker; armed exactly when the card was appended. */
  private injected = false
  /** True once the session's delivery retry budget is exhausted. */
  private silenced = false
  /** How many delivery attempts failed this session. */
  private deliveryFailures = 0
  /** Every recorded delivery error (diagnostics / tests). */
  private readonly errors: string[] = []

  constructor(options: GuidanceInjectorOptions = {}) {
    this.snapshotFor = options.snapshotFor
    this.readiness = options.readiness ?? isGuidanceReadyForSnapshot
    this.api = options.api
    this.onError = options.onError
    this.routingSkillPointer = options.routingSkillPointer ?? false
  }

  /**
   * Wire the session and injection hooks. Idempotent and fail-open: a broken
   * API never throws out of registration (each hook is also individually
   * guarded). No-op after `dispose()`.
   */
  register(): void {
    if (this.disposed || this.registered) return
    this.registered = true
    const api = this.api
    if (api === undefined) return
    try {
      api.on('session_start', this.handleSessionStart)
    } catch (error) {
      // Fail-open: extension load must never break on a throwing API, but the
      // contained failure is still recorded (task 2.3).
      this.recordError(`guidance hook registration failed: ${errorMessage(error)}`)
    }
    try {
      api.on('session_shutdown', this.handleSessionShutdown)
    } catch (error) {
      // Fail-open (same rationale), recorded like every other hook body.
      this.recordError(`guidance hook registration failed: ${errorMessage(error)}`)
    }
    try {
      api.on('before_agent_start', this.handleBeforeAgentStart)
    } catch (error) {
      // Fail-open (same rationale), recorded like every other hook body.
      this.recordError(`guidance hook registration failed: ${errorMessage(error)}`)
    }
  }

  /**
   * Mark the injector inert (the Pi API has no hook-removal surface, so the
   * registered handlers become no-ops). Idempotent; for tests and reload paths.
   */
  dispose(): void {
    this.disposed = true
    this.registered = false
  }

  /**
   * Record one contained hook failure (task 2.3): append it to the in-memory
   * ledger and report it to the optional sink exactly once. Fail-open by
   * construction — the sink is itself guarded, so an error reporter that
   * throws can never break the hook body that is already failing, and this
   * method never throws into pi's event dispatch.
   */
  private recordError(message: string): void {
    this.errors.push(message)
    try {
      this.onError?.(message)
    } catch {
      // Fail-open: an error sink that throws must not break the handler.
    }
  }

  /**
   * Session-start hook body: capture the Pi session cwd (ctx.cwd — the same
   * source the gate's workspace resolution uses; never `process.cwd()`) and
   * re-arm the one-shot and the retry budget for this session. Never throws.
   */
  private readonly handleSessionStart = (_event: unknown, ctx: unknown): void => {
    if (this.disposed) return
    try {
      const context = (ctx ?? {}) as { cwd?: unknown }
      const cwd =
        typeof context.cwd === 'string' && context.cwd.length > 0 ? context.cwd : undefined
      this.sessionCwd = cwd
      this.injected = false
      this.silenced = false
      this.deliveryFailures = 0
    } catch (error) {
      // Fail-open: a session_start hook body must never throw. The contained
      // failure is recorded (task 2.3) — it is not a delivery attempt, so it
      // does not consume the retry budget.
      this.recordError(`guidance session_start hook failed: ${errorMessage(error)}`)
    }
  }

  /** Session-shutdown hook: clear the session cwd and re-arm. Never throws. */
  private readonly handleSessionShutdown = (): void => {
    if (this.disposed) return
    try {
      this.sessionCwd = undefined
      this.injected = false
      this.silenced = false
      this.deliveryFailures = 0
    } catch (error) {
      // Fail-open: shutdown must never throw. Recorded like every other hook
      // body (task 2.3); not a delivery attempt, so no budget is consumed.
      this.recordError(`guidance session_shutdown hook failed: ${errorMessage(error)}`)
    }
  }

  /**
   * The injection point. Returns `{ systemPrompt }` (the chained prompt plus
   * the card) exactly once per session, on the first turn where the workspace
   * snapshot is ready. Every deferral returns undefined without spending the
   * one-shot, so a mid-session readiness transition still injects. Never
   * throws.
   */
  private readonly handleBeforeAgentStart = (event: unknown): unknown => {
    // A spent retry budget silences the injector outright: a broken delivery
    // surface is never evaluated (and never retried) again this session.
    if (this.disposed || this.silenced) return undefined
    try {
      if (this.injected) return undefined

      const beforeEvent = (event ?? {}) as {
        systemPrompt?: unknown
        systemPromptOptions?: { cwd?: unknown }
      }
      // The session cwd captured at session_start is the source of truth; the
      // documented before_agent_start cwd (systemPromptOptions.cwd) is the
      // fallback for hosts that omit it. process.cwd() is never used.
      const cwd = this.sessionCwd ?? beforeAgentStartCwd(beforeEvent)
      if (cwd === undefined) return undefined

      const snapshotFor = this.snapshotFor
      if (snapshotFor === undefined) return undefined

      // Cached lifecycle state only (ADR-0001): the gate captured this cwd; a
      // not-ready snapshot is a deferral — retry on a later turn.
      const snapshot = snapshotFor(cwd)
      if (!this.readiness(snapshot)) return undefined

      const systemPrompt = beforeEvent.systemPrompt
      // Defensive: never replace Pi's chained prompt with only the card.
      if (typeof systemPrompt !== 'string') return undefined

      this.injected = true
      // The routing-skill pointer rides the same per-turn injection so the
      // agent-facing availability stays readiness-gated (the skill itself is
      // user-executable via /skill regardless — discovery contributes it
      // whenever the flag is enabled).
      const delivery = this.routingSkillPointer
        ? `${GUIDANCE_CARD}\n\nDeeper routing detail: /skill:cgc-routing.`
        : GUIDANCE_CARD
      return { systemPrompt: `${systemPrompt}\n\n${delivery}` }
    } catch (error) {
      // Fail-open: the injection handler must never throw into the turn. A
      // delivery FAILURE (not a deferral) is recorded and consumes the
      // session's retry budget; once the budget is exhausted the injector goes
      // silent so a broken surface can never be retried forever. The one-shot
      // stays unspent — the silence, not the card, is what the budget buys.
      this.deliveryFailures += 1
      this.recordError(`guidance injection failed: ${errorMessage(error)}`)
      if (this.deliveryFailures > GUIDANCE_RETRY_BUDGET) this.silenced = true
      return undefined
    }
  }

  /** Whether the card was already appended this session (tests / diagnostics). */
  hasInjected(): boolean {
    return this.injected
  }

  /** True once the session's delivery retry budget is exhausted (tests / diagnostics). */
  isSilenced(): boolean {
    return this.silenced
  }

  /** How many delivery attempts failed this session (tests / diagnostics). */
  failedDeliveries(): number {
    return this.deliveryFailures
  }

  /** Every recorded delivery error, in order (tests / diagnostics). */
  recordedErrors(): readonly string[] {
    return [...this.errors]
  }

  /** The readiness predicate this injector gates on (the shared snapshot predicate by default). */
  readinessPredicate(): GuidanceReadinessPredicate {
    return this.readiness
  }

  /** The session cwd the injector resolves against (tests / diagnostics). */
  currentSessionCwd(): string | undefined {
    return this.sessionCwd
  }
}

// ---------------------------------------------------------------------------
// Task 2.4: routing-skill exposure (design D2, spec "Opt-out routing skill").
// The deep routing skill ships inside the package's `skills/` tree, and it is
// offered to the agent when the flag is enabled (default on) AND guidance is
// ready. Exposure is a `resources_discover` contribution evaluated at
// discovery time, so a readiness transition later in the same session is never
// applied retroactively to that session's discovery.
//
// The package manifest lists the `skills/` tree but force-excludes the skill
// (`"!skills/cgc-routing/**"` in package.json), because pi's resource loader
// loads manifest resources unconditionally. The exclusion keeps a static load
// from bypassing the readiness gating; this module's discovery handler is
// therefore the only runtime exposure path.
// ---------------------------------------------------------------------------

/** The routing skill's directory name inside the package's `skills/` tree. */
export const GUIDANCE_ROUTING_SKILL_NAME = 'cgc-routing'

/**
 * Absolute path to the bundled routing skill directory. This module lives in
 * `<package-root>/extensions/`, so the package root is its parent and the skill
 * is at `<package-root>/skills/cgc-routing`. Resolved from `import.meta.url`
 * (never `process.cwd()`) so it is stable wherever the package is loaded from.
 */
export const GUIDANCE_ROUTING_SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
  GUIDANCE_ROUTING_SKILL_NAME,
)

/**
 * Minimal Pi extension API surface the skill exposure registers on: the
 * documented `resources_discover` event, whose result may contribute
 * `skillPaths` (installed `docs/extensions.md`). The real `ExtensionAPI`
 * satisfies it structurally (the same seam pattern as the sibling modules).
 */
export interface GuidanceSkillDiscoverApi {
  on(event: 'resources_discover', handler: (event: unknown, ctx: unknown) => unknown): unknown
}

/** Options for {@link GuidanceSkillExposure}. */
export interface GuidanceSkillExposureOptions {
  /**
   * The routing-skill flag (`guidance.routingSkill`, default true). When
   * explicitly opted out (false) the skill is never contributed, whatever the
   * readiness outcome (spec "Skill opted out").
   */
  enabled: boolean
  /**
   * Per-workspace readiness check (the shared {@link GuidanceReadiness} built
  /** Pi API receiving the `resources_discover` handler. Omitted -> `register()` is a no-op. */
  api?: GuidanceSkillDiscoverApi
  /** Skill path(s) contributed when enabled. Defaults to the bundled skill. */
  skillPaths?: readonly string[]
  /** Optional error sink: every contained discovery error is reported here once. */
  onError?: (message: string) => void
}

/**
 * Routing-skill exposure (task 2.4). Registers a `resources_discover`
 * handler that returns `{ skillPaths }` whenever the flag is enabled (the
 * default); readiness deliberately does NOT gate discovery (pi fires
 * `resources_discover` before the gate's background classification records
 * any snapshot — gating there made the skill invisible on every fresh
 * session). Readiness gates the AGENT-side pointer instead: the injector
 * appends the `/skill:cgc-routing` pointer on the first ready turn, evaluated
 * per turn (spec "Skill user-executable when enabled").
 *
 * Fail-open: `register()` never throws, the handler body is fully guarded, and
 * every contained failure is recorded (never propagated into pi's event
 * dispatch). The handler is synchronous.
 */
export class GuidanceSkillExposure {
  private readonly enabled: boolean
  private readonly api: GuidanceSkillDiscoverApi | undefined
  private readonly skillPaths: readonly string[]
  private readonly onError: ((message: string) => void) | undefined

  private registered = false
  private disposed = false
  /** Every recorded discovery error (diagnostics / tests). */
  private readonly errors: string[] = []

  constructor(options: GuidanceSkillExposureOptions) {
    this.enabled = options.enabled
    this.api = options.api
    this.skillPaths = options.skillPaths ?? [GUIDANCE_ROUTING_SKILL_PATH]
    this.onError = options.onError
  }

  /**
   * Wire the discovery hook. Idempotent and fail-open: a broken API never
   * throws out of registration. No-op after `dispose()`.
   */
  register(): void {
    if (this.disposed || this.registered) return
    this.registered = true
    const api = this.api
    if (api === undefined) return
    try {
      api.on('resources_discover', this.handleResourcesDiscover)
    } catch (error) {
      // Fail-open: extension load must never break on a throwing API, but the
      // contained failure is recorded.
      this.recordError(`guidance skill hook registration failed: ${errorMessage(error)}`)
    }
  }

  /** Mark the exposure inert (idempotent; for tests and reload paths). */
  dispose(): void {
    this.disposed = true
    this.registered = false
  }

  /** Record one contained failure; never throws into pi's event dispatch. */
  private recordError(message: string): void {
    this.errors.push(message)
    try {
      this.onError?.(message)
    } catch {
      // Fail-open: an error sink that throws must not break the handler.
    }
  }

  /**
   * Discovery hook body. Contributes the skill path(s) whenever the
   * routing-skill flag is enabled — readiness deliberately does NOT gate
   * discovery: pi fires `resources_discover` before the gate's background
   * classification records any snapshot, so a readiness check here made the
   * skill invisible on every fresh session (the observed bug). Readiness
   * gates the AGENT-side pointer instead (the `before_agent_start`
   * injection, evaluated per turn). Never throws.
   */
  private readonly handleResourcesDiscover = (event: unknown): unknown => {
    if (this.disposed) return undefined
    try {
      if (!this.enabled) return undefined
      const cwd = resourcesDiscoverCwd(event)
      if (cwd === undefined) return undefined
      return { skillPaths: [...this.skillPaths] }
    } catch (error) {
      // Fail-open: skill discovery must never throw into pi's dispatch.
      this.recordError(`guidance skill discovery failed: ${errorMessage(error)}`)
      return undefined
    }
  }

  /** Whether the exposure was registered (tests / diagnostics). */
  isRegistered(): boolean {
    return this.registered
  }

  /** Every recorded discovery error, in order (tests / diagnostics). */
  recordedErrors(): readonly string[] {
    return [...this.errors]
  }
}

/** Extract the documented resources_discover cwd (event.cwd). */
function resourcesDiscoverCwd(event: unknown): string | undefined {
  const discovered = (event ?? {}) as { cwd?: unknown }
  return typeof discovered.cwd === 'string' && discovered.cwd.length > 0
    ? discovered.cwd
    : undefined
}

/** Extract the documented before_agent_start cwd (event.systemPromptOptions.cwd). */
function beforeAgentStartCwd(event: {
  systemPromptOptions?: { cwd?: unknown }
}): string | undefined {
  const options = event.systemPromptOptions
  const cwd = typeof options === 'object' && options !== null ? options.cwd : undefined
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** One-line error text; never itself throws. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
