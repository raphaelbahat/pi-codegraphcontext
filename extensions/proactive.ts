// Proactive context injection — Tier 1 coverage note builder (design D1/D2/D5 of
// openspec/changes/add-cgc-proactive-context-injection, task 1.2).
//
// This module owns the coverage-note CONTENT tier: a single capped paragraph of
// coverage facts injected at session start. Task 1.2 implements the pure note
// builder here — cached probe data in, capped text out, always. The readiness
// gate and the one-shot injector (task 1.3) and the opt-in tiers (2.x) land in
// this same module.
//
// Sourcing contract (design D2): the note renders EXCLUSIVELY from
// already-captured probe data — the workspace root, index presence, the cached
// `cgc --version` liveness probe, the snapshot timestamp, and any structured
// counts the lifecycle probe captured. Building it never spawns `cgc` (ADR 0001:
// every spawn is a workflow decision; ADR 0004: renderers are passive) — the
// function is synchronous and reads only its argument.
//
// Degradation contract (design D2, spec "graceful degradation without counts"):
// the lifecycle classifier (change 1) keeps NO structured counts — it parses
// coarse markers only — so counts are usually absent from the cached data and
// the minimal presence-and-time form is the NORMAL case, not an edge case. When
// counts are missing the note states index presence and the snapshot time and
// never invents numbers.
//
// Content-class boundary (design D5): this module renders coverage FACTS (what
// the index contains and when it was measured). Routing RULES belong to the
// routing card (add-cgc-agent-routing-guidance, change 2); the structural
// duplication test (task 3.1) asserts the content classes stay disjoint.

import type { LifecycleClassification, LifecycleState } from './classifier'

/**
 * Hard length cap for the rendered coverage note (design D2 risk row:
 * "coverage note grows past a paragraph"). One short paragraph plus the scope
 * line; asserted by test, and enforced defensively inside the builder so even
 * pathological inputs (a very long workspace path or version string) can never
 * exceed it.
 */
export const COVERAGE_NOTE_MAX_CHARS = 700

/** Longest rendered workspace path token (paths beyond this are truncated). */
const MAX_CWD_CHARS = 96

/** Longest rendered cgc version token (versions beyond this are truncated). */
const MAX_VERSION_CHARS = 48

/**
 * Structured counts captured alongside the lifecycle probe, when the probe
 * captured them. Every field is optional: an absent field means "not
 * captured" and renders nothing — never a zero. The change-1 probe captures no
 * counts today, so callers normally omit the whole object.
 */
export interface CoverageCounts {
  /** Number of indexed repositories, when captured. */
  repositories?: number
  /** Language count, or the captured language names. */
  languages?: number | readonly string[]
  /** Indexed symbol count, when captured. */
  symbols?: number
}

/**
 * The slice of cached probe data the coverage note renders (a narrow
 * structural interface: any surface holding the cached probe data — the
 * lifecycle classification today — satisfies it; nothing is re-probed to
 * build the note).
 */
export interface CoverageNoteSource {
  /**
   * The workspace root the probe data belongs to (the Pi session cwd — never
   * `process.cwd()`; that rule lives in the detector, ADR-0001).
   */
  cwd: string
  /** True when `.codegraphcontext/` was present at probe time. */
  indexed: boolean
  /**
   * The detected `cgc` CLI version from the cached liveness probe, or null
   * when the probe failed or its output was unparseable.
   */
  cgcVersion: string | null
  /**
   * Snapshot time of the cached probe data (epoch ms). Non-positive values
   * render as "not captured" rather than a fabricated timestamp.
   */
  at: number
  /** Structured counts captured alongside the probe, when available. */
  counts?: CoverageCounts | null
}

/**
 * Map a lifecycle classification onto the note's narrow source interface
 * (task 1.3 and tests consume cached data through this seam). The classifier
 * keeps no structured counts (coarse markers only), so `counts` is deliberately
 * absent here — the degraded note is the normal shape.
 */
export function coverageNoteSourceFrom(
  classification: Pick<LifecycleClassification, 'cwd' | 'indexed' | 'probe' | 'at'>,
): CoverageNoteSource {
  return {
    cwd: classification.cwd,
    indexed: classification.indexed,
    cgcVersion: classification.probe.version,
    at: classification.at,
  }
}

/**
 * Render the coverage snapshot timestamp (ISO-8601 UTC). Non-positive or
 * non-finite timestamps render as "not captured" — the note must never present
 * a fabricated time (design D2: the snapshot time is what makes staleness
 * visible; inventing one would defeat that).
 */
export function formatSnapshotTime(at: number): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return 'not captured'
  return new Date(at).toISOString()
}

/**
 * Build the Tier 1 coverage note from cached probe data.
 *
 * Guarantees:
 *   - zero spawns — synchronous and input-only (it reads `source` and nothing
 *     else; constructing the note never starts a `cgc` process),
 *   - hard length cap — the return value always satisfies
 *     `note.length <= COVERAGE_NOTE_MAX_CHARS`, even for pathological inputs
 *     (long paths, long version strings, huge count lists); long tokens are
 *     truncated up front and the final cap preserves the tail facts
 *     (snapshot + scope) with an explicit marker,
 *   - graceful degradation — counts absent from the cached data (the normal
 *     case) yield the minimal presence-and-time note; no invented numbers ever.
 */
export function buildCoverageNote(source: CoverageNoteSource): string {
  const facts: string[] = []

  // The workspace root is the one repository the cached data knows about (its
  // identity, never a re-probe). An empty cwd renders as unknown rather than
  // an empty fact; a very long path is truncated.
  const cwdRaw =
    typeof source.cwd === 'string' && source.cwd.trim().length > 0
      ? source.cwd
      : '(unknown workspace)'
  facts.push(boundToken(cwdRaw, MAX_CWD_CHARS))

  // Repository count, when the probe captured one.
  const repositories = positiveCount(source.counts?.repositories)
  if (repositories !== null) {
    facts.push(`${repositories} repository${repositories === 1 ? '' : 's'}`)
  }

  // Index presence is a guaranteed fact (part of the degrade-to shape).
  facts.push(source.indexed ? 'index present' : 'no index detected')

  // Languages, when captured (a count, or names when the probe captured them).
  const languages = languageFact(source.counts?.languages)
  if (languages !== null) facts.push(languages)

  // Symbol count, when captured.
  const symbols = positiveCount(source.counts?.symbols)
  if (symbols !== null) facts.push(`${symbols} symbols`)

  // Snapshot time is a guaranteed fact: coverage is only as fresh as the
  // cached probe, and the note says so (design D2 / ADR-0009 consequences).
  facts.push(`snapshot ${formatSnapshotTime(source.at)}`)

  const coverage = `CGC coverage: ${facts.join('; ')}.`
  const scope = scopeLine(source.cgcVersion)
  return capCoverageNote(`${coverage}\n${scope}`)
}

/**
 * The supported-CGC scope line (change 2 D3's one-line scope statement): the
 * extension's supported CLI scope as evidenced by the cached liveness probe.
 * When the version was not captured the line says so instead of guessing a
 * range.
 */
function scopeLine(cgcVersion: string | null): string {
  const version =
    typeof cgcVersion === 'string' && cgcVersion.trim().length > 0 ? cgcVersion.trim() : null
  return version !== null
    ? `CGC scope: supported CodeGraphContext CLI v${boundToken(version, MAX_VERSION_CHARS)}`
    : 'CGC scope: supported CodeGraphContext CLI (version not captured)'
}

/**
 * Truncate one long token (workspace path, version string) with an explicit
 * marker so it can never dominate the note's length: the primary defense for
 * the two unbounded inputs, keeping the final cap a structural safety net.
 */
function boundToken(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`
}

/**
 * Enforce the hard length cap with head/tail preservation (the same pattern
 * as commands.ts `boundText`, scoped to the note's own budget): the tail
 * carries the snapshot and scope facts the cap must preserve; the head carries
 * the coverage line's start. The marker keeps the truncation explicit, never
 * silent.
 */
function capCoverageNote(text: string): string {
  if (text.length <= COVERAGE_NOTE_MAX_CHARS) return text
  const marker = ' … '
  const tail = Math.min(200, COVERAGE_NOTE_MAX_CHARS - marker.length)
  const head = COVERAGE_NOTE_MAX_CHARS - marker.length - tail
  return `${text.slice(0, Math.max(0, head))}${marker}${text.slice(text.length - tail)}`
}

/**
 * A positive integer count renders; anything else (missing, zero, negative,
 * fractional, non-number) is treated as "not captured" — a real captured count
 * of zero is indistinguishable from absent data and must not render as a
 * factual "0 …" line (inventing counts is the one thing the note must never
 * do).
 */
function positiveCount(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** Language fact from captured data; null when languages were not captured. */
function languageFact(languages: number | readonly string[] | undefined): string | null {
  if (typeof languages === 'number') {
    return Number.isInteger(languages) && languages > 0 ? `${languages} languages` : null
  }
  if (Array.isArray(languages)) {
    const names = languages.map((name) => name.trim()).filter((name) => name.length > 0)
    if (names.length === 0) return null
    return `${names.length} language${names.length === 1 ? '' : 's'}: ${names.join(', ')}`
  }
  return null
}

/**
 * The ADR-0002 guidance-readiness decision: given the lifecycle state — or
 * null/undefined when no classification exists yet — is the guidance surface
 * ready? Exactly ONE shared predicate exists (design D5 / ADR-0002 follow-up):
 * the routing-guidance module (change 2) and every proactive tier consume it,
 * and no tier re-derives readiness for itself. The structural duplication
 * test (task 3.1) asserts the sharing.
 */
export type ReadinessPredicate = (state: LifecycleState | null | undefined) => boolean

/**
 * Per-session delivery retry budget: at most ONE retry of a FAILED delivery
 * per session (ADR-0009 — every tier is fail-open with a one-retry-per-session
 * cap; change 2 spec: "a failing injection SHALL NOT be retried more than once
 * in the session"). The first delivery failure is contained (fail-open); the
 * single permitted retry is attempted once; a second failure silences the tier
 * for the rest of the session — it never loops on a broken surface and never
 * blocks the agent loop. Session boundaries (session_start / session_shutdown)
 * re-arm the budget. Delivery DEFERRALS are not failures: a turn that is not
 * yet ready (cached data still settling, readiness suppressed, no prompt) does
 * not consume the budget, so the first READY turn still wins.
 */
export const PROACTIVE_RETRY_BUDGET = 1

/**
 * ADR-0002 readiness predicate, shared across the extension's agent-visible
 * guidance surfaces: `cgc` available AND the workspace index exists or is
 * being created (change 2 design D1). Operationalized over the implemented
 * lifecycle states (classifier.ts): `clean` and `drift` are ready; the
 * suppressing states — `unavailable` (no cgc), `unindexed` (no index),
 * `busy` (lock conflict), `corrupt` (broken/unknown index) — are not. The
 * change-2 design enumerates transient `syncing`/`indexing`/`rebuilding`
 * states; this implementation models those as background-activity markers on
 * the terminal states, so the letter of D1 holds unchanged: `unindexed`
 * suppresses even while auto-creation is in flight, and the healthy pair is
 * always ready. Null/undefined (no classification yet) is not ready.
 *
 * This is THE shared predicate (ADR-0002 follow-up): the routing-guidance
 * module (change 2) and every future agent-visible tier consume this single
 * function — the structural duplication test (task 3.1) asserts the sharing
 * instead of per-tier re-derivation. The proactive tier classes default their
 * `readiness` seam to this function, so the test asserts sharing by IDENTITY,
 * not by behavior.
 */
export function isGuidanceReady(state: LifecycleState | null | undefined): boolean {
  return state === 'clean' || state === 'drift'
}

/**
 * The slice of cached probe data the injector consumes: the lifecycle
 * classification plus the `state` the readiness predicate evaluates (D5 —
 * every tier flows through the same predicate). The note CONTENT renders via
 * {@link coverageNoteSourceFrom}; counts stay absent in the mapped source
 * (the classifier keeps none — the degraded note is the normal shape).
 */
export type CoverageCachedData = Pick<
  LifecycleClassification,
  'cwd' | 'indexed' | 'probe' | 'at' | 'state'
>

/**
 * Zero-spawn cached-data provider: resolves the cached classification for a
 * workspace, or null when it is not (yet) available — the gate's evaluation
 * is still settling, or no gate session exists. Null is a retry signal, not
 * an error: the injector checks again on the next turn (at-most-once means
 * the first READY turn wins, never a per-turn flood). Production wires the
 * gate's `lastClassification`; tests pass canned data.
 */
export type CoverageDataProvider = (cwd: string) => CoverageCachedData | null

/**
 * Minimal Pi extension API surface the injector registers hooks on (the same
 * structural seam pattern as cleanup.ts / gate.ts: the real `ExtensionAPI`
 * satisfies it). Three hooks:
 *   - `session_start` — capture the session cwd (the source of truth, never
 *     `process.cwd()`) and re-arm the one-shot,
 *   - `before_agent_start` — the injection point: append the chained system
 *     prompt at most once, on the first turn where readiness holds,
 *   - `session_shutdown` — clear the session cwd and re-arm for the next
 *     session.
 */
export interface ProactiveInjectionApi {
  on(event: 'before_agent_start', handler: (event: unknown, ctx: unknown) => unknown): unknown
  on(event: 'session_start', handler: (event: unknown, ctx: unknown) => unknown): unknown
  on(event: 'session_shutdown', handler: (event: unknown, ctx: unknown) => unknown): unknown
}

export interface CoverageNoteInjectorOptions {
  /** The tier's on/off switch: `proactive.sessionNote` (design D1, default on). */
  sessionNote: boolean
  /**
   * Zero-spawn cached-data provider (see {@link CoverageDataProvider}):
   * production wires the gate's `lastClassification`; tests pass canned data.
   */
  sourceFor: CoverageDataProvider
  /**
   * The readiness predicate the tier gates delivery on (design D5). Defaults
   * to the module-level shared predicate {@link isGuidanceReady} — the single
   * ADR-0002 predicate the routing-guidance module (change 2) and every tier
   * consume; the structural duplication test (task 3.1) asserts each tier's
   * default IS that function, proving no per-tier re-derivation. Injectable
   * so tests can spy on the gate; production omits it. This only selects
   * WHICH predicate gates — it never toggles the routing card's own
   * non-configurability (ADR-0002).
   */
  readiness?: ReadinessPredicate
  /** Pi API receiving the hooks. When omitted, `register()` is a no-op. */
  api?: ProactiveInjectionApi
}

/**
 * One-shot, readiness-gated injection of the Tier 1 coverage note (design
 * D1/D2/D5, task 1.3). Wires `session_start` / `session_shutdown` /
 * `before_agent_start` on the Pi extension API. The `before_agent_start`
 * handler appends the capped coverage note (`buildCoverageNote`) to the
 * chained system prompt exactly once per session, on the first turn where:
 *
 *   1. the tier is enabled (`proactive.sessionNote`),
 *   2. the ADR-0002 readiness predicate holds (`isGuidanceReady` over the
 *      cached classification's state — the same predicate the routing card
 *      consumes, design D5),
 *   3. cached probe data is available (the provider returned a
 *      classification; the gate's evaluation settles in the background after
 *      `session_start`, so early turns often have none — later turns retry
 *      and the first READY turn wins; there is no per-turn steering),
 *   4. a real chained system prompt string is present (defensive: never
 *      replace Pi's prompt with just the note).
 *
 * Delivery is the same documented mechanism as the routing card (change 2
 * D4): returning `{ systemPrompt: event.systemPrompt + note }` from
 * `before_agent_start`. Pi has no `addPromptGuidelines`; tool-scoped
 * `systemPromptOptions.promptGuidelines` is not a session-note surface.
 *
 * Guarantees (all structural — nothing here spawns):
 *   - at most once per session — the `injected` flag arms on `session_start`
 *     and re-arms on `session_shutdown`,
 *   - zero spawns — the note renders from the provider's cached data only
 *     (ADR 0001: the probes already ran for readiness),
 *   - session cwd is the source of truth — captured from `session_start`
 *     context (never `process.cwd()`), with `before_agent_start`'s
 *     `systemPromptOptions.cwd` as the documented fallback for hosts that
 *     omit it,
 *   - fail-open — `register()` never throws (every hook wraps in its own
 *     try/catch, the extension-wide registration pattern) and every handler
 *     body is guarded so it can never throw into pi's event dispatch or
 *     reject a turn,
 *   - one-retry-per-session cap — a delivery FAILURE is contained, retried
 *     at most once per session (ADR-0009), and then the tier goes silent
 *     until the next session; deferrals are not failures.
 */
export class CoverageNoteInjector {
  private readonly sessionNote: boolean
  private readonly sourceFor: CoverageDataProvider
  private api: ProactiveInjectionApi | undefined
  /** The readiness predicate this tier gates on; production default: {@link isGuidanceReady}. */
  private readonly readiness: ReadinessPredicate

  private registered = false
  private disposed = false
  /** The session cwd captured from the latest `session_start` (never process.cwd()). */
  private sessionCwd: string | undefined
  /** At-most-once-per-session marker; armed exactly when the note was appended. */
  private injected = false
  /** True once the session's delivery retry budget is exhausted (ADR-0009). */
  private silenced = false
  /** How many delivery attempts failed this session (the retry-budget ledger). */
  private deliveryFailures = 0

  constructor(options: CoverageNoteInjectorOptions) {
    this.sessionNote = options.sessionNote
    this.sourceFor = options.sourceFor
    this.api = options.api
    this.readiness = options.readiness ?? isGuidanceReady
  }

  /**
   * Wire the session and injection hooks. Idempotent and fail-open: a broken
   * API never throws out of registration (each hook is also individually
   * guarded). No-op after `dispose()`.
   *
   * Session rebind (add-cgc-session-rebind): when `api` is supplied and
   * differs from the API this tier is wired to (pi re-runs the factory on
   * every session replacement), adopt it, re-arm the registration flag, and
   * wire the hooks onto the new API. The same API stays the idempotent no-op.
   */
  register(api?: ProactiveInjectionApi): void {
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
    try {
      target.on('before_agent_start', this.handleBeforeAgentStart)
    } catch {
      // Fail-open (same rationale).
    }
  }

  /**
   * Mark the injector inert (the Pi API has no hook-removal surface, so the
   * registered handlers become no-ops). Idempotent; for tests and reload
   * paths.
   */
  dispose(): void {
    this.disposed = true
    this.registered = false
  }

  /**
   * Session-start hook body: capture the Pi session cwd (ctx.cwd — the same
   * source the gate's workspace resolution uses; never `process.cwd()`) and
   * re-arm the one-shot for this session. Never throws.
   */
  private readonly handleSessionStart = (_event: unknown, ctx: unknown): void => {
    if (this.disposed) return
    try {
      const context = (ctx ?? {}) as { cwd?: unknown }
      const cwd =
        typeof context.cwd === 'string' && context.cwd.length > 0 ? context.cwd : undefined
      // A fresh session re-arms the at-most-once guarantee. Hosts without a
      // session cwd leave the capture undefined and the before_agent_start
      // fallback (event.systemPromptOptions.cwd) applies instead.
      this.sessionCwd = cwd
      this.injected = false
      // A fresh session re-arms the whole contract: the one-shot AND the
      // delivery retry budget (ADR-0009).
      this.silenced = false
      this.deliveryFailures = 0
    } catch {
      // Fail-open: a session_start hook body must never throw.
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
    } catch {
      // Fail-open: shutdown must never throw.
    }
  }

  /**
   * The injection point. Returns `{ systemPrompt }` (chained) exactly once
   * per session, on the first turn where the tier is enabled, the cached
   * classification is available, and the readiness predicate holds. Every
   * other case returns undefined (no prompt change) and, crucially, does NOT
   * mark the one-shot used — a not-yet-ready turn stays retryable so a
   * mid-session readiness transition still injects (change 2 task 2.2's
   * at-most-once-including-transitions semantics). Never throws.
   */
  private readonly handleBeforeAgentStart = (event: unknown): unknown => {
    // A spent retry budget silences the tier outright: a broken delivery
    // surface is never evaluated (and never retried) again this session.
    if (this.disposed || this.silenced) return undefined
    try {
      if (!this.sessionNote) return undefined
      if (this.injected) return undefined

      const beforeEvent = (event ?? {}) as {
        systemPrompt?: unknown
        systemPromptOptions?: { cwd?: unknown }
      }
      // The session cwd captured at session_start is the source of truth;
      // the documented before_agent_start cwd (systemPromptOptions.cwd) is
      // the fallback for hosts that omit it. process.cwd() is never used.
      const cwd = this.sessionCwd ?? sessionCwdOf(beforeEvent)
      if (cwd === undefined) return undefined

      // Cached data only (design D2): the gate evaluated this cwd at
      // session_start; nothing is spawned here. Null means the evaluation is
      // still settling (or absent) — retry on a later turn.
      const data = this.sourceFor(cwd)
      if (data === null) return undefined

      // Shared readiness predicate (ADR-0002 / design D5): the tier gates
      // through the single ADR-0002 predicate (default {@link isGuidanceReady})
      // — never a per-tier re-derivation.
      if (!this.readiness(data.state)) return undefined

      const systemPrompt = beforeEvent.systemPrompt
      // Defensive: never replace Pi's chained prompt with only the note.
      if (typeof systemPrompt !== 'string') return undefined

      const note = buildCoverageNote(coverageNoteSourceFrom(data))
      this.injected = true
      return { systemPrompt: `${systemPrompt}\n\n${note}` }
    } catch {
      // Fail-open: the injection handler must never throw into the turn. A
      // delivery FAILURE (not a deferral) consumes the session's retry
      // budget; once the budget is exhausted the tier goes silent so a
      // broken surface can never be retried forever (ADR-0009). The
      // one-shot stays unspent — the silence, not the note, is what the
      // budget buys.
      this.deliveryFailures += 1
      if (this.deliveryFailures > PROACTIVE_RETRY_BUDGET) this.silenced = true
      return undefined
    }
  }

  /** Whether the note was already appended this session (tests / diagnostics). */
  hasInjected(): boolean {
    return this.injected
  }

  /** The readiness predicate this tier gates on (the shared predicate by default). */
  readinessPredicate(): ReadinessPredicate {
    return this.readiness
  }

  /** How many delivery attempts failed this session (tests / diagnostics). */
  failedDeliveries(): number {
    return this.deliveryFailures
  }

  /** The session cwd the injector resolves against (tests / diagnostics). */
  currentSessionCwd(): string | undefined {
    return this.sessionCwd
  }
}

// ---------------------------------------------------------------------------
// Task 2.2: the opt-in result-annotation tier (design D1/D4/D5).
//
// One-line freshness annotation appended to outputs the extension itself
// produces — slash-command renders today (and CLI-gap tool results when that
// change lands) — when the tier is enabled, the session OBSERVES staleness
// (the same DriftFreshnessStatus vocabulary as the steer tier), and the
// shared ADR-0002 readiness predicate holds over the cached classification.
// The annotation is a decoration, never a semantic change: `annotate` is
// append-only and returns the input unchanged whenever any gate closes, so
// the original output is byte-for-byte preserved as a prefix. CGC MCP server
// results are deliberately out of scope (design D4 / ADR-0009): the
// harness-documented `tool_result` event could patch their content, but
// annotating another surface's results is rejected as surprising — this tier
// only ever decorates surfaces the extension itself emits (the commands
// module applies `annotate` at its notify choke point).
//
// Gating mirrors the steer tier: the freshness capability (change 7) is
// subscribed at session start only when the tier is enabled and the provider
// is present; without the capability the tier observes nothing and
// `annotate` is an identity — the specified degradation, never an error.
// Fail-open everywhere: no hook body, subscription, observation, or
// decoration path throws into pi's event dispatch or a command handler.

/**
 * Hard length cap for one rendered result annotation (one short, bounded
 * line — the same budget as the steer, so an annotation can never dominate
 * an output it decorates).
 */
export const RESULT_ANNOTATION_MAX_CHARS = 240

/**
 * Render the one-line freshness annotation for an extension-owned output.
 * Returns null when the state has no staleness fact to name — `fresh`,
 * `syncing`, `disabled` (and unknown future statuses) render NOTHING, so an
 * annotation only ever repeats a real staleness judgment. The line names the
 * staleness (the `/cgc status` vocabulary via {@link DRIFT_STEER_STATE_LABELS})
 * and the workspace root, and includes the `/cgc sync` remediation so the
 * annotation stays actionable. Synchronous and input-only — zero spawns, the
 * same passive boundary as every renderer (ADR 0004). Never exceeds
 * {@link RESULT_ANNOTATION_MAX_CHARS} even for a pathological cwd (bounded
 * up front with the same token bounder as the note and the steer).
 */
export function buildResultAnnotation(summary: DriftFreshnessSummary): string | null {
  const state = DRIFT_STEER_STATE_LABELS[summary.status]
  // Only staleness states have a label; fresh / syncing / disabled / unknown
  // statuses yield no annotation (nothing to say, and an annotation must
  // never invent a staleness judgment).
  if (state === undefined) return null
  const cwd =
    typeof summary.cwd === 'string' && summary.cwd.trim().length > 0
      ? summary.cwd
      : '(unknown workspace)'
  const line = `CGC note: code graph ${state} for ${boundToken(cwd, MAX_CWD_CHARS)}; run /cgc sync to reconcile.`
  if (line.length <= RESULT_ANNOTATION_MAX_CHARS) return line
  return `${line.slice(0, RESULT_ANNOTATION_MAX_CHARS - 1)}…`
}

export interface ResultAnnotatorOptions {
  /** The tier's on/off switch: `proactive.resultAnnotations` (design D1, default off). */
  resultAnnotations: boolean
  /**
   * Zero-spawn cached-data provider for the shared ADR-0002 readiness
   * predicate (design D5): the same seam the note and the steer consume.
   * When the delivery point has no cached classification (the gate's
   * evaluation is still settling) the output is returned unchanged —
   * fail-open, never a fabricated annotation.
   */
  sourceFor: CoverageDataProvider
  /**
   * The readiness predicate the tier gates decoration on (design D5).
   * Defaults to the module-level shared predicate {@link isGuidanceReady} —
   * the single ADR-0002 predicate the routing-guidance module (change 2) and
   * every tier consume; the structural duplication test (task 3.1) asserts
   * each tier's default IS that function. Injectable so tests can spy on the
   * gate; production omits it. This only selects WHICH predicate gates — it
   * never toggles the routing card's own non-configurability (ADR-0002).
   */
  readiness?: ReadinessPredicate
  /**
   * Resolves the freshness store for the session workspace. Omit — or return
   * null — when the freshness capability is absent (change 7 not installed):
   * the tier subscribes to nothing and `annotate` is an identity (the
   * specified degradation, mirroring the steer tier and the HUD's seam).
   * Change 7 wires the real store here.
   */
  freshnessFor?: DriftFreshnessProvider
  /** Pi API receiving the hooks. When omitted, `register()` is a no-op. */
  api?: ProactiveInjectionApi
}

/**
 * Session-scoped, readiness-gated result annotation (task 2.2, design
 * D1/D4/D5). Wires `session_start` / `session_shutdown` on the Pi extension
 * API and exposes {@link ResultAnnotator.annotate} — the single entry point
 * extension-owned output surfaces call before emitting text:
 *
 *   - `session_start` captures the session workspace, subscribes to the
 *     freshness store (only when the tier is enabled AND the capability is
 *     present), and records the store's initial snapshot so an inherited
 *     stale episode is annotated from the first output on,
 *   - freshness emissions for the session workspace update the observed
 *     staleness state,
 *   - `annotate(text)` appends the one-line annotation exactly when the tier
 *     is enabled, the session observes staleness (`possibly-stale` /
 *     `skipped-busy`), the ADR-0002 readiness predicate holds over the
 *     cached classification, and a real annotation renders; every other case
 *     returns `text` unchanged.
 *
 * Never annotates when disabled: the `resultAnnotations` switch gates both
 * the subscription (a disabled tier observes nothing) and the decoration
 * path (belt and suspenders). Semantics untouched by construction: the
 * annotation is only ever appended, never spliced into the output, and the
 * original text is preserved as a prefix. Fail-open everywhere (same
 * structural posture as {@link CoverageNoteInjector} and
 * {@link DriftSteerInjector}), with the same one-retry-per-session
 * delivery cap (ADR-0009).
 */
export class ResultAnnotator {
  private readonly resultAnnotations: boolean
  private readonly sourceFor: CoverageDataProvider
  private readonly freshnessFor: DriftFreshnessProvider | undefined
  private api: ProactiveInjectionApi | undefined
  /** The readiness predicate this tier gates on; production default: {@link isGuidanceReady}. */
  private readonly readiness: ReadinessPredicate

  private registered = false
  private disposed = false
  /** The session cwd captured from the latest `session_start` (never process.cwd()). */
  private sessionCwd: string | undefined
  /** The freshness store subscription for the current session (unsubscribed at shutdown). */
  private freshnessUnsubscribe: (() => void) | undefined
  /** Latest observed freshness status for the session workspace (undefined = none yet). */
  private currentStatus: DriftFreshnessStatus | undefined
  /** How many outputs were annotated this session (tests / diagnostics). */
  private annotated = 0
  /** True once the session's decoration retry budget is exhausted (ADR-0009). */
  private silenced = false
  /** How many decoration attempts failed this session (the retry-budget ledger). */
  private deliveryFailures = 0

  constructor(options: ResultAnnotatorOptions) {
    this.resultAnnotations = options.resultAnnotations
    this.sourceFor = options.sourceFor
    this.freshnessFor = options.freshnessFor
    this.api = options.api
    this.readiness = options.readiness ?? isGuidanceReady
  }

  /**
   * Wire the session hooks. Idempotent and fail-open: a broken API never
   * throws out of registration (each hook is also individually guarded).
   * No-op after `dispose()`.
   *
   * Session rebind (add-cgc-session-rebind): when `api` is supplied and
   * differs from the API this tier is wired to (pi re-runs the factory on
   * every session replacement), adopt it, re-arm the registration flag, and
   * wire the hooks onto the new API. The same API stays the idempotent no-op.
   */
  register(api?: ProactiveInjectionApi): void {
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
   * Mark the annotator inert (the Pi API has no hook-removal surface, so the
   * registered handlers become no-ops and `annotate` becomes an identity).
   * Idempotent; for tests and reload paths. Never throws.
   */
  dispose(): void {
    this.disposed = true
    this.registered = false
    try {
      this.detachFreshness()
    } catch {
      // Fail-open: disposal must never throw.
    }
  }

  /** Unsubscribe from the freshness store (idempotent, fail-open). */
  private detachFreshness(): void {
    const unsubscribe = this.freshnessUnsubscribe
    this.freshnessUnsubscribe = undefined
    if (unsubscribe === undefined) return
    try {
      unsubscribe()
    } catch {
      // Fail-open: a throwing unsubscribe must never break session/shutdown.
    }
  }

  /**
   * Session-start hook body: capture the session cwd (ctx.cwd — never
   * `process.cwd()`), clear the staleness observation, and subscribe to the
   * freshness store when the tier is enabled and the capability present. A
   * disabled tier observes nothing from the start (the config switch gates
   * the subscription itself). Never throws.
   */
  private readonly handleSessionStart = (_event: unknown, ctx: unknown): void => {
    if (this.disposed) return
    try {
      const context = (ctx ?? {}) as { cwd?: unknown }
      const cwd =
        typeof context.cwd === 'string' && context.cwd.length > 0 ? context.cwd : undefined
      this.sessionCwd = cwd
      this.currentStatus = undefined
      this.annotated = 0
      this.silenced = false
      this.deliveryFailures = 0
      this.detachFreshness()
      if (cwd === undefined) return

      // Gated on the tier switch AND the capability: disabled observes
      // nothing; an absent provider (change 7 not installed) degrades to an
      // identity decoration (never an annotation — the specified
      // degradation).
      if (!this.resultAnnotations) return
      if (typeof this.freshnessFor !== 'function') return
      try {
        const store = this.freshnessFor(cwd)
        if (store === null) return
        try {
          this.freshnessUnsubscribe = store.subscribe(this.onFreshness)
        } catch {
          // Fail-open: an unsubscribable store degrades to the one-shot
          // initial snapshot below (no live transitions this session).
          this.freshnessUnsubscribe = undefined
        }
        try {
          // Baseline only: an inherited stale episode must be annotated from
          // the first output on; emissions later keep it current.
          const initial = store.snapshot(cwd)
          if (initial !== null) this.onFreshness(initial)
        } catch {
          // Fail-open: an unreadable snapshot degrades to a fresh observer.
        }
      } catch {
        this.freshnessUnsubscribe = undefined
      }
    } catch {
      // Fail-open: a session_start hook body must never throw.
    }
  }

  /**
   * Session-shutdown hook: unsubscribe from the freshness store and clear the
   * per-session observation state. Never throws.
   */
  private readonly handleSessionShutdown = (): void => {
    if (this.disposed) return
    try {
      this.detachFreshness()
      this.sessionCwd = undefined
      this.currentStatus = undefined
      this.annotated = 0
      this.silenced = false
      this.deliveryFailures = 0
    } catch {
      // Fail-open: shutdown must never throw.
    }
  }

  /**
   * Freshness emission handler: session workspace only, then record the
   * observed status. Never throws.
   */
  private readonly onFreshness = (summary: DriftFreshnessSummary): void => {
    if (this.disposed) return
    try {
      if (summary.cwd !== this.sessionCwd) return
      this.currentStatus = summary.status
    } catch {
      // Fail-open: a listener body must never throw into the store's loop.
    }
  }

  /**
   * Decorate one extension-owned output with the staleness annotation.
   * Returns the input unchanged — semantics untouched — unless EVERY gate is
   * open: the tier is enabled, the session observed staleness, the session
   * cwd is known, the cached classification exists and the shared readiness
   * predicate holds, and a real annotation rendered. Never throws, so a
   * broken freshness/readiness surface can never break a command handler.
   */
  annotate(text: string): string {
    // A spent retry budget silences the decoration outright: a broken
    // readiness surface is never evaluated again this session (ADR-0009).
    if (this.disposed || this.silenced) return text
    try {
      if (!this.resultAnnotations) return text
      if (this.sessionCwd === undefined) return text
      const status = this.currentStatus
      if (status === undefined) return text
      const annotation = buildResultAnnotation({ cwd: this.sessionCwd, status })
      if (annotation === null) return text

      // Shared readiness predicate (ADR-0002 / design D5): the cached
      // classification must exist AND be ready. A still-settling gate
      // (null) degrades to no annotation — fail-open, never a fabricated
      // staleness note on a surface the gate has not validated.
      const data = this.sourceFor(this.sessionCwd)
      if (data === null) return text
      // Shared readiness predicate (ADR-0002 / design D5): the tier gates
      // through the single ADR-0002 predicate (default {@link isGuidanceReady})
      // — never a per-tier re-derivation.
      if (!this.readiness(data.state)) return text

      this.annotated += 1
      return `${text}\n${annotation}`
    } catch {
      // Fail-open: a decoration defect degrades to the raw output. The
      // failure (not a deferral) consumes the retry budget; a broken
      // readiness surface can never be retried forever within a session
      // (ADR-0009).
      this.deliveryFailures += 1
      if (this.deliveryFailures > PROACTIVE_RETRY_BUDGET) this.silenced = true
      return text
    }
  }

  /** How many outputs were annotated this session (tests / diagnostics). */
  annotationsApplied(): number {
    return this.annotated
  }

  /** The readiness predicate this tier gates on (the shared predicate by default). */
  readinessPredicate(): ReadinessPredicate {
    return this.readiness
  }

  /** How many decoration attempts failed this session (tests / diagnostics). */
  failedDeliveries(): number {
    return this.deliveryFailures
  }

  /** The latest observed freshness status for the session (tests / diagnostics). */
  observedStatus(): DriftFreshnessStatus | undefined {
    return this.currentStatus
  }

  /** The session cwd the annotator resolves against (tests / diagnostics). */
  currentSessionCwd(): string | undefined {
    return this.sessionCwd
  }
}

/** Extract the documented before_agent_start cwd (event.systemPromptOptions.cwd). */
function sessionCwdOf(event: { systemPromptOptions?: { cwd?: unknown } }): string | undefined {
  const options = event.systemPromptOptions
  const cwd = typeof options === 'object' && options !== null ? options.cwd : undefined
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

// ---------------------------------------------------------------------------
// Task 2.1: the opt-in drift-steer tier (design D1/D3/D5).
//
// One agent-facing steer per fresh → possibly-stale EPISODE, driven by
// freshness state transitions — the same FreshnessStatus literals the status
// HUD (status-hud.ts) and the `/cgc status` renderer (commands.ts
// `CgcFreshnessSummary`) consume, re-declared here as a narrow structural
// seam: add-cgc-freshness-drift-sync is not installed, so a shared freshness
// store does not exist yet, and the tier must not depend on a widget module
// for its state vocabulary.
//
// Episode semantics (design D3): a steer is owed exactly when the session
// OBSERVES a transition from `fresh` to `possibly-stale`. A status is not a
// transition: the initial snapshot of an already-open episode (staleness
// inherited from before this session subscribed) queues nothing but records
// the baseline so the next resolve/reopen cycle owes its steer. The owed
// steer is delivered at the next agent turn through the documented prompt
// mechanism (before_agent_start, ADR-0002) — once per episode. While the
// episode stays open, re-observations of staleness cannot owe another steer
// (no fresh transition in between); when the episode resolves (`fresh` /
// `disabled`), the next fresh → possibly-stale transition owes the next
// steer. At most one steer can ever be owed at a moment (keep-first).
//
// Delivery gating mirrors the coverage note: the shared ADR-0002 readiness
// predicate over the cached lifecycle classification, cached data available,
// a real chained system prompt. A not-yet-ready turn DEFERS — the queue
// survives and the episode's ONE steer is consumed only on actual delivery —
// so deferral is never a firing and "never fires when disabled" plus "one
// steer per episode" both hold strictly. Fail-open everywhere: no hook body,
// subscription, or observation path throws into pi's event dispatch.

/**
 * Freshness states the steer transition machine consumes (the same literals
 * as the HUD's `FreshnessStatus` and `commands.ts` `CgcFreshnessSummary`).
 * Re-declared as a narrow structural seam so the future freshness store
 * satisfies it without any shared import.
 */
export type DriftFreshnessStatus =
  | 'fresh'
  | 'possibly-stale'
  | 'syncing'
  | 'skipped-busy'
  | 'disabled'

/**
 * One freshness observation the steer machine consumes: workspace identity
 * plus status (a narrow slice of the future store's summary — extra fields
 * such as `lastSyncedAt` / `staleSince` are structurally ignored).
 */
export interface DriftFreshnessSummary {
  cwd: string
  status: DriftFreshnessStatus
}

/** Freshness emission listener for the steer tier (design: event-driven). */
export type DriftFreshnessListener = (summary: DriftFreshnessSummary) => void

/**
 * The narrow freshness store surface the steer tier subscribes to when the
 * capability is present (structural, like the HUD's `FreshnessHudStore`).
 */
export interface DriftFreshnessStore {
  subscribe(listener: DriftFreshnessListener): () => void
  snapshot(cwd: string): DriftFreshnessSummary | null
}

/** Hard length cap for one rendered steer (one short, bounded line). */
export const DRIFT_STEER_MAX_CHARS = 240

/**
 * State labels the steer names — the `/cgc status` vocabulary (design D3:
 * the steer names the staleness). States that can never open an episode
 * (fresh, syncing, disabled) are intentionally absent; unknown future
 * statuses render raw rather than inventing a label.
 */
const DRIFT_STEER_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'possibly-stale': 'possibly stale',
  'skipped-busy': 'possibly stale (sync skipped as busy)',
})

/**
 * Render one steer from the observation that opened the episode. Always
 * names the staleness and the `/cgc sync` option (the tier's REQUIREMENT:
 * per-episode steer naming the staleness and the `/cgc sync` option); the
 * workspace root is included so the steer stays useful in multi-workspace
 * sessions. Synchronous and input-only — zero spawns, the same passive
 * boundary as the coverage note (ADR 0004). Never exceeds
 * {@link DRIFT_STEER_MAX_CHARS} even for a pathological cwd (it is bounded
 * up front with the same token bounder as the note).
 */
export function buildDriftSteer(summary: DriftFreshnessSummary): string {
  const cwd =
    typeof summary.cwd === 'string' && summary.cwd.trim().length > 0
      ? summary.cwd
      : '(unknown workspace)'
  const state = DRIFT_STEER_STATE_LABELS[summary.status] ?? summary.status
  const line = `CGC note: code graph ${state} for ${boundToken(cwd, MAX_CWD_CHARS)}; run /cgc sync to reconcile.`
  if (line.length <= DRIFT_STEER_MAX_CHARS) return line
  return `${line.slice(0, DRIFT_STEER_MAX_CHARS - 1)}…`
}

/**
 * The episode transition machine (pure, synchronous, per-session). Feed it
 * every freshness observation for the session workspace; it owes exactly one
 * steer per fresh → possibly-stale episode:
 *
 *   - a steer is queued ONLY on an observed `fresh` → `possibly-stale`
 *     transition (the initial snapshot of an inherited episode queues
 *     nothing, but records the baseline so the next reopen fires),
 *   - `syncing` / `skipped-busy` keep the staleness active without owing
 *     (no new transition occurred — the staleness is being addressed, or
 *     its resolution was skipped as busy),
 *   - `fresh` / `disabled` resolve the episode: the next `fresh` →
 *     `possibly-stale` transition owes the next steer,
 *   - an undelivered steer is never overwritten (keep-first: at most one
 *     steer owed at any moment).
 *
 * The machine holds no timer, no runner, and no hooks — it only classifies
 * observations; delivery and readiness gating live in
 * {@link DriftSteerInjector}.
 */
export class DriftSteerTracker {
  private lastStatus: DriftFreshnessStatus | undefined
  private queued: string | undefined
  private episodes = 0

  /** Observe one freshness emission for the session workspace. Never throws. */
  observe(summary: DriftFreshnessSummary): void {
    const status = summary.status
    if (status === 'possibly-stale' && this.lastStatus === 'fresh') {
      // An observed fresh → possibly-stale transition opens an episode. The
      // steer is owed only when none is already outstanding (keep-first: at
      // most one steer owed at any moment — the episode's one steer covers
      // churn until it is delivered).
      this.episodes += 1
      if (this.queued === undefined) this.queued = buildDriftSteer(summary)
    }
    this.lastStatus = status
  }

  /** The owed steer, if any (undefined when nothing is owed). */
  queuedSteer(): string | undefined {
    return this.queued
  }

  /**
   * Consume the owed steer. Called only at actual delivery — a deferred turn
   * (not ready, no cached data, no prompt) leaves the queue intact so the
   * episode's ONE steer is never lost to readiness timing.
   */
  take(): string | undefined {
    const steer = this.queued
    this.queued = undefined
    return steer
  }

  /** How many episodes opened this session (diagnostics / tests). */
  episodesOpened(): number {
    return this.episodes
  }

  /** Clear all session state (session_start re-arm / shutdown). Never throws. */
  reset(): void {
    this.lastStatus = undefined
    this.queued = undefined
    this.episodes = 0
  }
}

/**
 * Zero-spawn freshness-store provider for the steer tier: resolves the
 * freshness store for a workspace, or null when the capability is absent
 * (change 7 not installed). Null means "observe nothing" — the tier then has
 * no transitions to drive it and never fires (the specified degradation,
 * mirroring the HUD's freshness seam).
 */
export type DriftFreshnessProvider = (cwd: string) => DriftFreshnessStore | null

export interface DriftSteerInjectorOptions {
  /** The tier's on/off switch: `proactive.driftSteers` (design D1, default off). */
  driftSteers: boolean
  /**
   * Zero-spawn cached-data provider for the shared readiness predicate
   * (ADR-0002 / design D5): the same seam the coverage note consumes. When
   * the delivery turn has no cached classification (the gate's evaluation is
   * still settling), the steer stays queued and a later ready turn delivers
   * it.
   */
  sourceFor: CoverageDataProvider
  /**
   * The readiness predicate the tier gates delivery on (design D5). Defaults
   * to the module-level shared predicate {@link isGuidanceReady} — the single
   * ADR-0002 predicate the routing-guidance module (change 2) and every tier
   * consume; the structural duplication test (task 3.1) asserts each tier's
   * default IS that function. Injectable so tests can spy on the gate;
   * production omits it. This only selects WHICH predicate gates — it never
   * toggles the routing card's own non-configurability (ADR-0002).
   */
  readiness?: ReadinessPredicate
  /**
   * Resolves the freshness store for the session workspace. Omit — or return
   * null — when the freshness capability is absent (change 7 not installed):
   * the tier subscribes to nothing and never fires. Change 7 wires the real
   * store here.
   */
  freshnessFor?: DriftFreshnessProvider
  /** Pi API receiving the hooks. When omitted, `register()` is a no-op. */
  api?: ProactiveInjectionApi
}

/**
 * Episode-scoped, readiness-gated drift-steer delivery (task 2.1, design
 * D1/D3/D5). Wires `session_start` / `session_shutdown` /
 * `before_agent_start` on the Pi extension API:
 *
 *   - `session_start` captures the session workspace, subscribes to the
 *     freshness store (only when the tier is enabled AND the capability is
 *     present), and feeds the store's initial snapshot into the episode
 *     machine as the baseline (an inherited episode owes nothing — only
 *     observed transitions queue steers),
 *   - freshness emissions for the session workspace feed the episode
 *     machine; a fresh → possibly-stale transition owes one steer,
 *   - `before_agent_start` delivers the owed steer into the chained system
 *     prompt exactly once per episode — same documented prompt mechanism as
 *     the coverage note and the routing card (change 2 D4) — on the first
 *     turn where the tier is enabled, the ADR-0002 readiness predicate
 *     holds over the cached classification, and a real chained system
 *     prompt is present; deferred turns keep the steer queued.
 *
 * Never fires when disabled: the `driftSteers` switch gates both the
 * subscription (a disabled tier observes nothing) and the delivery handler
 * (belt and suspenders). Fail-open everywhere (same structural posture as
 * {@link CoverageNoteInjector}) with the same one-retry-per-session
 * delivery cap (ADR-0009).
 */
export class DriftSteerInjector {
  private readonly driftSteers: boolean
  private readonly sourceFor: CoverageDataProvider
  private readonly freshnessFor: DriftFreshnessProvider | undefined
  private api: ProactiveInjectionApi | undefined
  /** The readiness predicate this tier gates on; production default: {@link isGuidanceReady}. */
  private readonly readiness: ReadinessPredicate

  private readonly tracker = new DriftSteerTracker()
  private registered = false
  private disposed = false
  /** The session cwd captured from the latest `session_start` (never process.cwd()). */
  private sessionCwd: string | undefined
  /** The freshness store subscription for the current session (unsubscribed at shutdown). */
  private freshnessUnsubscribe: (() => void) | undefined
  /** How many steers were delivered this session (at most one per episode). */
  private delivered = 0
  /** True once the session's delivery retry budget is exhausted (ADR-0009). */
  private silenced = false
  /** How many delivery attempts failed this session (the retry-budget ledger). */
  private deliveryFailures = 0

  constructor(options: DriftSteerInjectorOptions) {
    this.driftSteers = options.driftSteers
    this.sourceFor = options.sourceFor
    this.freshnessFor = options.freshnessFor
    this.api = options.api
    this.readiness = options.readiness ?? isGuidanceReady
  }

  /**
   * Wire the session and delivery hooks. Idempotent and fail-open: a broken
   * API never throws out of registration (each hook is also individually
   * guarded). No-op after `dispose()`.
   *
   * Session rebind (add-cgc-session-rebind): when `api` is supplied and
   * differs from the API this tier is wired to (pi re-runs the factory on
   * every session replacement), adopt it, re-arm the registration flag, and
   * wire the hooks onto the new API. The same API stays the idempotent no-op.
   */
  register(api?: ProactiveInjectionApi): void {
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
    try {
      target.on('before_agent_start', this.handleBeforeAgentStart)
    } catch {
      // Fail-open (same rationale).
    }
  }

  /**
   * Mark the injector inert (the Pi API has no hook-removal surface, so the
   * registered handlers become no-ops). Idempotent; for tests and reload
   * paths. Never throws.
   */
  dispose(): void {
    this.disposed = true
    this.registered = false
    try {
      this.detachFreshness()
    } catch {
      // Fail-open: disposal must never throw.
    }
  }

  /** Unsubscribe from the freshness store (idempotent, fail-open). */
  private detachFreshness(): void {
    const unsubscribe = this.freshnessUnsubscribe
    this.freshnessUnsubscribe = undefined
    if (unsubscribe === undefined) return
    try {
      unsubscribe()
    } catch {
      // Fail-open: a throwing unsubscribe must never break session/shutdown.
    }
  }

  /**
   * Session-start hook body: capture the session cwd (ctx.cwd — never
   * `process.cwd()`), re-arm the per-session machine, and subscribe to the
   * freshness store when the tier is enabled and the capability present. A
   * disabled tier observes nothing from the start (the config switch gates
   * the subscription itself). Never throws.
   */
  private readonly handleSessionStart = (_event: unknown, ctx: unknown): void => {
    if (this.disposed) return
    try {
      const context = (ctx ?? {}) as { cwd?: unknown }
      const cwd =
        typeof context.cwd === 'string' && context.cwd.length > 0 ? context.cwd : undefined
      this.sessionCwd = cwd
      this.tracker.reset()
      this.delivered = 0
      this.silenced = false
      this.deliveryFailures = 0
      this.detachFreshness()
      if (cwd === undefined) return

      // Gated on the tier switch AND the capability: disabled observes
      // nothing; an absent provider (change 7 not installed) degrades to a
      // silent session (never fires — the specified degradation).
      if (!this.driftSteers) return
      if (typeof this.freshnessFor !== 'function') return
      try {
        const store = this.freshnessFor(cwd)
        if (store === null) return
        try {
          this.freshnessUnsubscribe = store.subscribe(this.onFreshness)
        } catch {
          // Fail-open: an unsubscribable store degrades to the one-shot
          // initial snapshot below (no live transitions this session).
          this.freshnessUnsubscribe = undefined
        }
        try {
          // Baseline only: an inherited episode queues nothing (no transition
          // was observed), but the machine must know the current status so
          // the next resolve/reopen cycle owes its steer.
          const initial = store.snapshot(cwd)
          if (initial !== null) this.tracker.observe(initial)
        } catch {
          // Fail-open: an unreadable snapshot degrades to a fresh machine.
        }
      } catch {
        this.freshnessUnsubscribe = undefined
      }
    } catch {
      // Fail-open: a session_start hook body must never throw.
    }
  }

  /**
   * Session-shutdown hook: unsubscribe from the freshness store and clear the
   * per-session state (the owed steer, if any, does not carry across
   * sessions — per-session semantics, matching the coverage note). Never
   * throws.
   */
  private readonly handleSessionShutdown = (): void => {
    if (this.disposed) return
    try {
      this.detachFreshness()
      this.sessionCwd = undefined
      this.tracker.reset()
      this.delivered = 0
      this.silenced = false
      this.deliveryFailures = 0
    } catch {
      // Fail-open: shutdown must never throw.
    }
  }

  /**
   * Freshness emission handler: session workspace only, then the episode
   * machine. Never throws.
   */
  private readonly onFreshness = (summary: DriftFreshnessSummary): void => {
    if (this.disposed) return
    try {
      if (summary.cwd !== this.sessionCwd) return
      this.tracker.observe(summary)
    } catch {
      // Fail-open: a listener body must never throw into the store's loop.
    }
  }

  /**
   * The delivery point. Returns `{ systemPrompt }` (chained) exactly once per
   * episode, on the first turn after a fresh → possibly-stale transition
   * where the tier is enabled, the cached classification is available, the
   * readiness predicate holds, and a real chained system prompt is present.
   * Every other case returns undefined (no prompt change) and, crucially,
   * does NOT consume the owed steer — a deferred turn keeps the queue so the
   * episode's ONE steer survives readiness timing. Never throws.
   */
  private readonly handleBeforeAgentStart = (event: unknown): unknown => {
    // A spent retry budget silences the tier outright: a broken delivery
    // surface is never evaluated (and never retried) again this session.
    if (this.disposed || this.silenced) return undefined
    try {
      if (!this.driftSteers) return undefined
      if (this.tracker.queuedSteer() === undefined) return undefined

      const beforeEvent = (event ?? {}) as {
        systemPrompt?: unknown
        systemPromptOptions?: { cwd?: unknown }
      }
      // The session cwd captured at session_start is the source of truth;
      // the documented before_agent_start cwd (systemPromptOptions.cwd) is
      // the fallback for hosts that omit it. process.cwd() is never used.
      const cwd = this.sessionCwd ?? sessionCwdOf(beforeEvent)
      if (cwd === undefined) return undefined

      // Cached data only: the gate evaluated this cwd at session_start;
      // nothing is spawned here. Null means the evaluation is still settling
      // — defer and retry on a later turn.
      const data = this.sourceFor(cwd)
      if (data === null) return undefined

      // Shared readiness predicate (ADR-0002 / design D5): the tier gates
      // through the single ADR-0002 predicate (default {@link isGuidanceReady})
      // — never a per-tier re-derivation.
      if (!this.readiness(data.state)) return undefined

      const systemPrompt = beforeEvent.systemPrompt
      // Defensive: never replace Pi's chained prompt with only the steer.
      if (typeof systemPrompt !== 'string') return undefined

      const steer = this.tracker.take()
      if (steer === undefined) return undefined
      this.delivered += 1
      return {
        systemPrompt: `${systemPrompt}

${steer}`,
      }
    } catch {
      // Fail-open: the delivery handler must never throw into the turn. A
      // delivery FAILURE (not a deferral) consumes the session's retry
      // budget; exhaustion silences the tier so a broken surface is never
      // retried forever (ADR-0009). The owed steer is NOT consumed by the
      // failure — it stays queued, and the budget, not the queue, is spent.
      this.deliveryFailures += 1
      if (this.deliveryFailures > PROACTIVE_RETRY_BUDGET) this.silenced = true
      return undefined
    }
  }

  /** How many steers were delivered this session (tests / diagnostics). */
  steersDelivered(): number {
    return this.delivered
  }

  /** The readiness predicate this tier gates on (the shared predicate by default). */
  readinessPredicate(): ReadinessPredicate {
    return this.readiness
  }

  /** How many delivery attempts failed this session (tests / diagnostics). */
  failedDeliveries(): number {
    return this.deliveryFailures
  }

  /** How many episodes opened this session (tests / diagnostics). */
  episodesOpened(): number {
    return this.tracker.episodesOpened()
  }

  /** The owed-but-undelivered steer, if any (tests / diagnostics). */
  queuedSteer(): string | undefined {
    return this.tracker.queuedSteer()
  }

  /** The session cwd the injector resolves against (tests / diagnostics). */
  currentSessionCwd(): string | undefined {
    return this.sessionCwd
  }
}
