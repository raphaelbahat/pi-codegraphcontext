import { describe, expect, it } from 'bun:test'
import type { LifecycleClassification, LifecycleState } from './classifier'
import {
  buildCoverageNote,
  buildDriftSteer,
  buildResultAnnotation,
  COVERAGE_NOTE_MAX_CHARS,
  type CoverageCachedData,
  CoverageNoteInjector,
  type CoverageNoteSource,
  coverageNoteSourceFrom,
  DRIFT_STEER_MAX_CHARS,
  type DriftFreshnessStatus,
  type DriftFreshnessStore,
  type DriftFreshnessSummary,
  DriftSteerInjector,
  DriftSteerTracker,
  formatSnapshotTime,
  isGuidanceReady,
  PROACTIVE_RETRY_BUDGET,
  type ProactiveInjectionApi,
  RESULT_ANNOTATION_MAX_CHARS,
  type ReadinessPredicate,
  ResultAnnotator,
} from './proactive'

const SNAPSHOT_AT = 1_700_000_000_000
const SNAPSHOT_ISO = new Date(SNAPSHOT_AT).toISOString()

/**
 * A full cached-data source: counts captured, version captured, indexed.
 * Mirrors what a probe that DID capture structured counts would produce
 * (the change-1 probe captures none today — see the degrade tests).
 */
function fullSource(): CoverageNoteSource {
  return {
    cwd: '/home/user/project',
    indexed: true,
    cgcVersion: '0.6.2',
    at: SNAPSHOT_AT,
    counts: {
      repositories: 1,
      languages: ['TypeScript', 'Go', 'Python'],
      symbols: 1042,
    },
  }
}

/** The normal cached-data shape today: classification, no structured counts. */
function degradedSource(): CoverageNoteSource {
  return {
    cwd: '/home/user/project',
    indexed: true,
    cgcVersion: '0.6.2',
    at: SNAPSHOT_AT,
  }
}

/** A minimal classification in the shape classifier.ts produces. */
function classification(cwd: string): LifecycleClassification {
  return classified(cwd, 'clean')
}

/** A classification in the classifier's shape for an arbitrary lifecycle state. */
function classified(cwd: string, state: LifecycleState): LifecycleClassification {
  return {
    cwd,
    state,
    indexed: true,
    probe: {
      available: true,
      code: 'OK',
      version: '0.6.2',
      message: 'cgc is available',
      cached: true,
    },
    health: null,
    reason: 'test canned classification',
    at: SNAPSHOT_AT,
  }
}

describe('buildCoverageNote (task 1.2: coverage note builder)', () => {
  it('renders repositories, languages, symbol counts, snapshot time, and the scope line', () => {
    const note = buildCoverageNote(fullSource())

    expect(note).toContain('/home/user/project')
    expect(note).toContain('index present')
    expect(note).toContain('3 languages: TypeScript, Go, Python')
    expect(note).toContain('1042 symbols')
    expect(note).toContain(`snapshot ${SNAPSHOT_ISO}`)
    expect(note).toContain('CGC scope: supported CodeGraphContext CLI v0.6.2')
    expect(note.length).toBeLessThan(COVERAGE_NOTE_MAX_CHARS)
  })

  it('degrades to index presence + snapshot time when counts were not captured', () => {
    // The normal case: the change-1 classifier keeps no structured counts.
    const note = buildCoverageNote(degradedSource())

    expect(note).toContain('/home/user/project')
    expect(note).toContain('index present')
    expect(note).toContain(`snapshot ${SNAPSHOT_ISO}`)
    expect(note).toContain('CGC scope: supported CodeGraphContext CLI v0.6.2')
    // No invented numbers: no count facts at all in the degraded form.
    expect(note).not.toContain('symbols')
    expect(note).not.toContain('languages')
    expect(note).not.toContain('repositories')
  })

  it('states no-index presence, uncaptured snapshot, and uncaptured version without inventing facts', () => {
    const note = buildCoverageNote({
      cwd: '/home/user/project',
      indexed: false,
      cgcVersion: null,
      at: 0,
    })

    expect(note).toContain('no index detected')
    expect(note).toContain('snapshot not captured')
    expect(note).toContain('CGC scope: supported CodeGraphContext CLI (version not captured)')
    expect(note).not.toContain('0 symbols')
    expect(note).not.toContain('0 languages')
  })

  it('single language and single symbol count render in the singular', () => {
    const note = buildCoverageNote({
      cwd: '/repo',
      indexed: true,
      cgcVersion: '0.6.2',
      at: SNAPSHOT_AT,
      counts: { languages: 1, symbols: 1 },
    })

    expect(note).toContain('1 language')
    expect(note).toContain('1 symbol')
  })

  it('language names are trimmed and empty entries are dropped', () => {
    const note = buildCoverageNote({
      cwd: '/repo',
      indexed: true,
      cgcVersion: '0.6.2',
      at: SNAPSHOT_AT,
      counts: { languages: [' TypeScript ', '  ', 'Go'] },
    })

    expect(note).toContain('2 languages: TypeScript, Go')
  })

  it('never exceeds the hard length cap, even for pathological inputs', () => {
    const note = buildCoverageNote({
      cwd: `/very/${'long'.repeat(1_000)}/workspace`,
      indexed: true,
      cgcVersion: `9.9.9-${'beta'.repeat(1_000)}`,
      at: SNAPSHOT_AT,
      counts: {
        repositories: 1_000,
        languages: Array.from({ length: 500 }, (_, i) => `Language-${i}-${'x'.repeat(40)}`),
        symbols: 123_456_789,
      },
    })

    expect(note.length).toBeLessThanOrEqual(COVERAGE_NOTE_MAX_CHARS)
    // Cap enforcement preserves the tail facts (snapshot + scope) and marks
    // the truncation explicitly.
    expect(note).toContain('…')
    expect(note).toContain('CGC scope:')
  })

  it('is a pure function of the cached data: deterministic, input-only, no spawns', () => {
    const source = fullSource()
    const first = buildCoverageNote(source)
    const second = buildCoverageNote(source)

    expect(second).toBe(first)
    // Frozen cached data builds the same note (the builder never mutates or
    // re-derives its input through any other surface — zero spawns by
    // construction: the function is synchronous and reads only its argument).
    expect(buildCoverageNote(Object.freeze(source))).toBe(first)
  })
})

describe('coverageNoteSourceFrom (task 1.2: cached-data seam)', () => {
  it('maps cwd, index presence, cached version, and snapshot time; keeps counts absent', () => {
    const source = coverageNoteSourceFrom(classification('/home/user/project'))

    expect(source.cwd).toBe('/home/user/project')
    expect(source.indexed).toBe(true)
    expect(source.cgcVersion).toBe('0.6.2')
    expect(source.at).toBe(SNAPSHOT_AT)
    // The classifier keeps no structured counts — the degraded note is the
    // normal shape and no counts key is invented.
    expect('counts' in source).toBe(false)
  })
})

describe('formatSnapshotTime (task 1.2: snapshot rendering)', () => {
  it('renders a captured epoch as ISO-8601 UTC', () => {
    expect(formatSnapshotTime(SNAPSHOT_AT)).toBe(SNAPSHOT_ISO)
  })

  it('renders missing timestamps as "not captured" instead of a fabricated time', () => {
    expect(formatSnapshotTime(0)).toBe('not captured')
    expect(formatSnapshotTime(-5)).toBe('not captured')
    expect(formatSnapshotTime(Number.NaN)).toBe('not captured')
  })
})

// ---------------------------------------------------------------------------
// Task 1.3: the one-shot, readiness-gated injector (CoverageNoteInjector).
// ---------------------------------------------------------------------------

/** States the ADR-0002 readiness predicate suppresses (isGuidanceReady false). */
const SUPPRESSED_STATES: readonly LifecycleState[] = ['unavailable', 'unindexed', 'busy', 'corrupt']

/** The base chained system prompt pi hands to a before_agent_start handler. */
const BASE_PROMPT = 'base system prompt'

/** A before_agent_start event in the installed pi docs' shape. */
function promptEvent(
  cwd: string = '/repo',
  systemPrompt: unknown = BASE_PROMPT,
): {
  systemPrompt: unknown
  systemPromptOptions: { cwd: string }
} {
  return { systemPrompt, systemPromptOptions: { cwd } }
}

interface InjectorHarness {
  injector: CoverageNoteInjector
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>
  /** Set/replace the cached classification the provider returns for a cwd. */
  setData: (cwd: string, data: CoverageCachedData | null) => void
  /** The last cwd the injector asked the provider for (diagnostics). */
  lastAskedCwd: () => string | undefined
  sessionStart: (cwd: string) => void
  sessionShutdown: () => void
  /** Dispatch before_agent_start through the registered handler. */
  beforeAgentStart: (event: unknown) => unknown
}

/**
 * Drive CoverageNoteInjector exactly the way pi drives it: hooks registered
 * through a minimal api are dispatched by the harness (the same structural
 * seam pattern as status-hud.test.ts). The cached-data provider is a per-cwd
 * map the tests mutate to simulate the gate's background evaluation landing.
 */
function makeInjectorHarness(
  options: { sessionNote?: boolean; readiness?: ReadinessPredicate } = {},
): InjectorHarness {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  const dataByCwd = new Map<string, CoverageCachedData | null>()
  let askedCwd: string | undefined

  const api: ProactiveInjectionApi = {
    on(
      event: 'before_agent_start' | 'session_start' | 'session_shutdown',
      handler: (event: unknown, ctx: unknown) => unknown,
    ): unknown {
      handlers.set(event, handler)
      return undefined
    },
  }
  const injector = new CoverageNoteInjector({
    sessionNote: options.sessionNote ?? true,
    // Omit the readiness seam unless asked: the default IS the shared
    // predicate (asserted by the task 3.1 structural test), and passing
    // undefined would violate exactOptionalPropertyTypes.
    ...(options.readiness === undefined ? {} : { readiness: options.readiness }),
    sourceFor: (cwd: string) => {
      askedCwd = cwd
      return dataByCwd.get(cwd) ?? null
    },
    api,
  })
  injector.register()

  const sessionStart = (cwd: string): void => {
    const handler = handlers.get('session_start')
    if (handler === undefined) throw new Error('session_start handler not registered')
    handler({ type: 'session_start' }, { cwd })
  }
  const sessionShutdown = (): void => {
    const handler = handlers.get('session_shutdown')
    if (handler === undefined) throw new Error('session_shutdown handler not registered')
    handler({ type: 'session_shutdown' }, {})
  }
  const beforeAgentStart = (event: unknown): unknown => {
    const handler = handlers.get('before_agent_start')
    if (handler === undefined) throw new Error('before_agent_start handler not registered')
    return handler(event, {})
  }

  return {
    injector,
    handlers,
    setData: (cwd: string, data: CoverageCachedData | null) => {
      dataByCwd.set(cwd, data)
    },
    lastAskedCwd: () => askedCwd,
    sessionStart,
    sessionShutdown,
    beforeAgentStart,
  }
}

/** Narrow the injector's before_agent_start return to the prompt mutation shape. */
function returnedPrompt(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const systemPrompt = (result as { systemPrompt?: unknown }).systemPrompt
  return typeof systemPrompt === 'string' ? systemPrompt : undefined
}

describe('CoverageNoteInjector (task 1.3: one-shot readiness-gated injection)', () => {
  it('wires session_start, session_shutdown, and before_agent_start; register() is idempotent', () => {
    const { injector, handlers } = makeInjectorHarness()

    injector.register()

    expect(handlers.has('session_start')).toBe(true)
    expect(handlers.has('session_shutdown')).toBe(true)
    expect(handlers.has('before_agent_start')).toBe(true)
    expect(handlers.size).toBe(3)
  })

  it('injects the coverage note into the chained system prompt exactly once on the first ready turn', () => {
    const { injector, setData, sessionStart, beforeAgentStart } = makeInjectorHarness()

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))

    const chained = returnedPrompt(beforeAgentStart(promptEvent()))

    // The existing chained prompt is preserved and the capped note appended
    // (the documented routing-card mechanism: systemPrompt + note).
    expect(chained).not.toBeUndefined()
    expect(chained?.startsWith(`${BASE_PROMPT}\n\n`)).toBe(true)
    expect(chained).toContain('CGC coverage:')
    expect(chained).toContain('/repo')
    expect(chained?.length).toBeLessThanOrEqual(BASE_PROMPT.length + 2 + COVERAGE_NOTE_MAX_CHARS)
    expect(injector.hasInjected()).toBe(true)

    // At most once per session: a later ready turn changes nothing.
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    // Even a mid-session readiness transition (clean → drift) never re-injects.
    setData('/repo', classified('/repo', 'drift'))
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
  })

  it('defers while the gate is still settling and injects on the first turn with cached data', () => {
    const { injector, setData, sessionStart, beforeAgentStart } = makeInjectorHarness()

    sessionStart('/repo')
    // No cached classification yet (the gate evaluates in the background).
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.hasInjected()).toBe(false)

    // The evaluation lands on a later turn: the first READY turn wins.
    setData('/repo', classified('/repo', 'clean'))
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(injector.hasInjected()).toBe(true)
  })

  it('never injects for suppressed states, and those turns stay retryable', () => {
    const { injector, setData, sessionStart, beforeAgentStart } = makeInjectorHarness()

    sessionStart('/repo')

    for (const state of SUPPRESSED_STATES) {
      setData('/repo', classified('/repo', state))
      expect(beforeAgentStart(promptEvent())).toBeUndefined()
      expect(injector.hasInjected()).toBe(false)
    }

    // The not-ready turns never burned the one-shot: a later ready turn
    // injects (at-most-once-including-transitions semantics).
    setData('/repo', classified('/repo', 'clean'))
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(injector.hasInjected()).toBe(true)
  })

  it('never injects when proactive.sessionNote is disabled (opt-out)', () => {
    const { injector, setData, sessionStart, beforeAgentStart } = makeInjectorHarness({
      sessionNote: false,
    })

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))

    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.hasInjected()).toBe(false)
  })

  it('never replaces the chained prompt when systemPrompt is absent or non-string', () => {
    const { injector, setData, sessionStart, beforeAgentStart } = makeInjectorHarness()

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))

    expect(beforeAgentStart({ systemPromptOptions: { cwd: '/repo' } })).toBeUndefined()
    expect(beforeAgentStart(promptEvent('/repo', 42))).toBeUndefined()
    expect(injector.hasInjected()).toBe(false)

    // The malformed turns never burned the one-shot either.
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(injector.hasInjected()).toBe(true)
  })

  it('resolves the session cwd from session_start and falls back to systemPromptOptions.cwd', () => {
    const { injector, setData, lastAskedCwd, beforeAgentStart } = makeInjectorHarness()

    // No session_start observed: the documented fallback cwd applies.
    setData('/fallback', classified('/fallback', 'clean'))
    expect(returnedPrompt(beforeAgentStart(promptEvent('/fallback')))).not.toBeUndefined()
    expect(lastAskedCwd()).toBe('/fallback')
    expect(injector.hasInjected()).toBe(true)
  })

  it('prefers the session_start cwd over the event cwd (never process.cwd())', () => {
    const { injector, setData, sessionStart, lastAskedCwd, beforeAgentStart } =
      makeInjectorHarness()

    sessionStart('/session-path')
    setData('/session-path', classified('/session-path', 'clean'))
    setData('/event-path', classified('/event-path', 'clean'))

    // The event claims a different cwd; the provider is asked about the
    // session cwd — the classification that exists there lands.
    expect(returnedPrompt(beforeAgentStart(promptEvent('/event-path')))).not.toBeUndefined()
    expect(lastAskedCwd()).toBe('/session-path')
    expect(injector.currentSessionCwd()).toBe('/session-path')
    expect(injector.hasInjected()).toBe(true)
  })

  it('does nothing when no cwd is recoverable and does not mark the one-shot used', () => {
    const { injector, setData, beforeAgentStart } = makeInjectorHarness()

    setData('/repo', classified('/repo', 'clean'))

    expect(beforeAgentStart({ systemPrompt: BASE_PROMPT })).toBeUndefined()
    expect(injector.hasInjected()).toBe(false)
    expect(injector.currentSessionCwd()).toBeUndefined()
  })

  it('re-arms at session shutdown: the next session injects once again', () => {
    const { injector, setData, sessionStart, sessionShutdown, beforeAgentStart } =
      makeInjectorHarness()

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(injector.hasInjected()).toBe(true)

    sessionShutdown()
    expect(injector.currentSessionCwd()).toBeUndefined()
    expect(injector.hasInjected()).toBe(false)

    // A brand-new session gets its own single injection.
    sessionStart('/repo')
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(injector.hasInjected()).toBe(true)
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
  })

  it('re-arms on a fresh session_start even without shutdown', () => {
    const { injector, setData, sessionStart, beforeAgentStart } = makeInjectorHarness()

    sessionStart('/one')
    setData('/one', classified('/one', 'clean'))
    expect(returnedPrompt(beforeAgentStart(promptEvent('/one')))).not.toBeUndefined()
    expect(beforeAgentStart(promptEvent('/one'))).toBeUndefined()

    // The user switched workspaces mid-process: a new session, a new shot.
    sessionStart('/two')
    setData('/two', classified('/two', 'clean'))
    expect(returnedPrompt(beforeAgentStart(promptEvent('/two')))).not.toBeUndefined()
    expect(injector.hasInjected()).toBe(true)
    expect(beforeAgentStart(promptEvent('/two'))).toBeUndefined()
  })

  it('registers nothing and stays inert without an api; dispose() silences all hooks', () => {
    const bare = new CoverageNoteInjector({ sessionNote: true, sourceFor: () => null })
    expect(() => bare.register()).not.toThrow()
    expect(() => bare.dispose()).not.toThrow()

    const { injector, setData, sessionStart, beforeAgentStart } = makeInjectorHarness()
    setData('/repo', classified('/repo', 'clean'))
    injector.dispose()

    expect(() => sessionStart('/repo')).not.toThrow()
    expect(() => beforeAgentStart(promptEvent())).not.toThrow()
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.hasInjected()).toBe(false)
  })
})

describe('CoverageNoteInjector fail-open posture (task 1.3)', () => {
  it('register() never throws on a throwing api', () => {
    const throwingApi = {
      on(event: string): unknown {
        throw new Error(`api exploded for ${event}`)
      },
    }
    const injector = new CoverageNoteInjector({
      sessionNote: true,
      sourceFor: () => null,
      api: throwingApi as unknown as ProactiveInjectionApi,
    })

    expect(() => injector.register()).not.toThrow()
    expect(() => injector.dispose()).not.toThrow()
  })

  it('handlers never throw into the turn on garbage or missing events/contexts', () => {
    const { injector, setData, sessionStart, sessionShutdown, beforeAgentStart } =
      makeInjectorHarness()

    setData('/repo', classified('/repo', 'clean'))
    sessionStart('/repo')

    expect(() => beforeAgentStart(null)).not.toThrow()
    expect(() => beforeAgentStart(undefined)).not.toThrow()
    expect(() => beforeAgentStart({})).not.toThrow()
    expect(() => beforeAgentStart({ systemPrompt: [], systemPromptOptions: 42 })).not.toThrow()
    // Garbage never injects and never burns the one-shot.
    expect(injector.hasInjected()).toBe(false)

    // A real event after the garbage still injects.
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(injector.hasInjected()).toBe(true)

    expect(() => sessionShutdown()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Task 2.1: the opt-in drift-steer tier (design D1/D3/D5).
// ---------------------------------------------------------------------------

/** A freshness observation for a workspace. */
function freshnessFor(cwd: string, status: DriftFreshnessStatus): DriftFreshnessSummary {
  return { cwd, status }
}

describe('buildDriftSteer (task 2.1: steer content)', () => {
  it('names the staleness state, the workspace, and the /cgc sync option', () => {
    const steer = buildDriftSteer({ cwd: '/repo', status: 'possibly-stale' })

    expect(steer).toContain('possibly stale')
    expect(steer).toContain('/repo')
    expect(steer).toContain('/cgc sync')
  })

  it('labels the skipped-busy state and falls back to the raw status for unknown states', () => {
    expect(buildDriftSteer({ cwd: '/repo', status: 'skipped-busy' })).toContain(
      'sync skipped as busy',
    )

    const unknown = { cwd: '/repo', status: 'mystery' }
    expect(buildDriftSteer(unknown as DriftFreshnessSummary)).toContain('mystery')
  })

  it('never exceeds the hard length cap, even for a pathological cwd', () => {
    const steer = buildDriftSteer({
      cwd: `/very/${'long'.repeat(1_000)}/workspace`,
      status: 'possibly-stale',
    })

    expect(steer.length).toBeLessThanOrEqual(DRIFT_STEER_MAX_CHARS)
    // The essential content survives the bound.
    expect(steer).toContain('/cgc sync')
  })
})

describe('DriftSteerTracker (task 2.1: episode transition machine)', () => {
  it('owes exactly one steer on an observed fresh → possibly-stale transition', () => {
    const tracker = new DriftSteerTracker()

    tracker.observe(freshnessFor('/repo', 'fresh'))
    tracker.observe(freshnessFor('/repo', 'possibly-stale'))

    expect(tracker.episodesOpened()).toBe(1)
    const steer = tracker.queuedSteer()
    expect(steer).not.toBeUndefined()
    expect(steer).toContain('/cgc sync')
    expect(tracker.take()).toBe(steer)
    expect(tracker.queuedSteer()).toBeUndefined()
  })

  it('an inherited episode (first observation possibly-stale) owes nothing, but the next resolve/reopen cycle fires', () => {
    const tracker = new DriftSteerTracker()

    // The session subscribed mid-episode: no transition was observed.
    tracker.observe(freshnessFor('/repo', 'possibly-stale'))
    expect(tracker.episodesOpened()).toBe(0)
    expect(tracker.queuedSteer()).toBeUndefined()

    // The episode resolves and reopens inside the session: the transition owes.
    tracker.observe(freshnessFor('/repo', 'fresh'))
    tracker.observe(freshnessFor('/repo', 'possibly-stale'))
    expect(tracker.episodesOpened()).toBe(1)
    expect(tracker.queuedSteer()).not.toBeUndefined()
  })

  it('syncing and skipped-busy keep the episode open without owing another steer', () => {
    const tracker = new DriftSteerTracker()

    tracker.observe(freshnessFor('/repo', 'fresh'))
    tracker.observe(freshnessFor('/repo', 'possibly-stale'))
    tracker.observe(freshnessFor('/repo', 'syncing'))
    tracker.observe(freshnessFor('/repo', 'skipped-busy'))
    tracker.observe(freshnessFor('/repo', 'possibly-stale'))

    expect(tracker.episodesOpened()).toBe(1)
  })

  it('resolves on fresh and fires once per resolved episode', () => {
    const tracker = new DriftSteerTracker()

    tracker.observe(freshnessFor('/repo', 'fresh'))
    tracker.observe(freshnessFor('/repo', 'possibly-stale'))
    tracker.take()
    tracker.observe(freshnessFor('/repo', 'fresh'))
    tracker.observe(freshnessFor('/repo', 'possibly-stale'))

    expect(tracker.episodesOpened()).toBe(2)
    expect(tracker.queuedSteer()).not.toBeUndefined()
  })

  it('never overwrites an undelivered steer (keep-first: at most one owed at a time)', () => {
    const tracker = new DriftSteerTracker()

    tracker.observe(freshnessFor('/repo', 'fresh'))
    tracker.observe(freshnessFor('/repo', 'possibly-stale'))
    const first = tracker.queuedSteer()
    expect(first).not.toBeUndefined()

    // Episode churn (resolve + reopen) before delivery: two episodes opened,
    // but only the FIRST steer is owed.
    tracker.observe(freshnessFor('/other', 'fresh'))
    tracker.observe(freshnessFor('/other', 'possibly-stale'))
    expect(tracker.episodesOpened()).toBe(2)

    const taken = tracker.take()
    expect(taken).toBe(first)
    expect(taken).not.toContain('/other')
    expect(tracker.queuedSteer()).toBeUndefined()
  })

  it('reset clears the machine', () => {
    const tracker = new DriftSteerTracker()

    tracker.observe(freshnessFor('/repo', 'fresh'))
    tracker.observe(freshnessFor('/repo', 'possibly-stale'))
    tracker.reset()

    expect(tracker.episodesOpened()).toBe(0)
    expect(tracker.queuedSteer()).toBeUndefined()
    expect(tracker.take()).toBeUndefined()
  })
})

/** A minimal in-memory freshness store the steer tier subscribes to (tests). */
class TestDriftStore implements DriftFreshnessStore {
  readonly listeners = new Set<(summary: DriftFreshnessSummary) => void>()
  snapshotValue: DriftFreshnessSummary | null = null

  subscribe(listener: (summary: DriftFreshnessSummary) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot(cwd: string): DriftFreshnessSummary | null {
    if (this.snapshotValue === null) return null
    return this.snapshotValue.cwd === cwd ? this.snapshotValue : null
  }

  /** Emit a freshness observation to every subscribed listener. */
  emit(summary: DriftFreshnessSummary): void {
    for (const listener of [...this.listeners]) listener(summary)
  }
}

interface DriftSteerHarness {
  injector: DriftSteerInjector
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>
  store: TestDriftStore
  /** Set/replace the cached classification the readiness provider returns. */
  setData: (cwd: string, data: CoverageCachedData | null) => void
  sessionStart: (cwd: string) => void
  sessionShutdown: () => void
  beforeAgentStart: (event: unknown) => unknown
}

/**
 * Drive DriftSteerInjector exactly the way pi drives it (same structural seam
 * pattern as the coverage-note harness). With `withStore: false` no
 * freshness provider is passed — the capability-absent degradation.
 */
function makeDriftHarness(
  options: { driftSteers?: boolean; withStore?: boolean; readiness?: ReadinessPredicate } = {},
): DriftSteerHarness {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  const dataByCwd = new Map<string, CoverageCachedData | null>()
  const store = new TestDriftStore()

  const api: ProactiveInjectionApi = {
    on(
      event: 'before_agent_start' | 'session_start' | 'session_shutdown',
      handler: (event: unknown, ctx: unknown) => unknown,
    ): unknown {
      handlers.set(event, handler)
      return undefined
    },
  }
  const injector = new DriftSteerInjector({
    driftSteers: options.driftSteers ?? true,
    // Omit the readiness seam unless asked (exactOptionalPropertyTypes).
    ...(options.readiness === undefined ? {} : { readiness: options.readiness }),
    sourceFor: (cwd: string) => dataByCwd.get(cwd) ?? null,
    // Omit the provider entirely when the capability is absent
    // (exactOptionalPropertyTypes: undefined is not a value here).
    ...(options.withStore === false ? {} : { freshnessFor: (_cwd: string) => store }),
    api,
  })
  injector.register()

  const sessionStart = (cwd: string): void => {
    const handler = handlers.get('session_start')
    if (handler === undefined) throw new Error('session_start handler not registered')
    handler({ type: 'session_start' }, { cwd })
  }
  const sessionShutdown = (): void => {
    const handler = handlers.get('session_shutdown')
    if (handler === undefined) throw new Error('session_shutdown handler not registered')
    handler({ type: 'session_shutdown' }, {})
  }
  const beforeAgentStart = (event: unknown): unknown => {
    const handler = handlers.get('before_agent_start')
    if (handler === undefined) throw new Error('before_agent_start handler not registered')
    return handler(event, {})
  }

  return {
    injector,
    handlers,
    store,
    setData: (cwd: string, data: CoverageCachedData | null) => {
      dataByCwd.set(cwd, data)
    },
    sessionStart,
    sessionShutdown,
    beforeAgentStart,
  }
}

describe('DriftSteerInjector (task 2.1: episode-scoped, readiness-gated delivery)', () => {
  it('wires session_start, session_shutdown, and before_agent_start; register() is idempotent', () => {
    const { injector, handlers } = makeDriftHarness()

    injector.register()

    expect(handlers.size).toBe(3)
    expect(handlers.has('session_start')).toBe(true)
    expect(handlers.has('session_shutdown')).toBe(true)
    expect(handlers.has('before_agent_start')).toBe(true)
  })

  it('delivers exactly one steer per fresh → possibly-stale episode into the chained prompt', () => {
    const { injector, store, setData, sessionStart, beforeAgentStart } = makeDriftHarness()

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))

    const chained = returnedPrompt(beforeAgentStart(promptEvent()))
    expect(chained?.startsWith(`${BASE_PROMPT}\n\n`)).toBe(true)
    expect(chained).toContain('possibly stale')
    expect(chained).toContain('/cgc sync')
    expect(chained).toContain('/repo')
    expect(injector.episodesOpened()).toBe(1)
    expect(injector.steersDelivered()).toBe(1)

    // Fired once for the episode: later turns and re-observed staleness
    // (possibly-stale stays, syncing attempts, skipped-busy) change nothing.
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    store.emit(freshnessFor('/repo', 'possibly-stale'))
    store.emit(freshnessFor('/repo', 'syncing'))
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.episodesOpened()).toBe(1)
    expect(injector.steersDelivered()).toBe(1)
  })

  it('episode resolves and reopens: exactly one NEW steer for the new episode', () => {
    const { injector, store, setData, sessionStart, beforeAgentStart } = makeDriftHarness()

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))

    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(injector.steersDelivered()).toBe(1)

    // Resolve, then a fresh observation cycle reopens the episode.
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(injector.episodesOpened()).toBe(2)
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(injector.steersDelivered()).toBe(2)
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
  })

  it('owes at most one steer at any moment even across episode churn before delivery', () => {
    const { injector, store, setData, sessionStart, beforeAgentStart } = makeDriftHarness()

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))

    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))
    // The episode resolved (synced) and reopened before any agent turn.
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(injector.episodesOpened()).toBe(2)

    // Exactly one steer is delivered for the two episodes (keep-first).
    const chained = returnedPrompt(beforeAgentStart(promptEvent()))
    expect(chained).not.toBeUndefined()
    expect(chained).toContain('/cgc sync')
    expect(injector.steersDelivered()).toBe(1)

    // The next episode owes the next steer.
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(injector.steersDelivered()).toBe(2)
  })

  it('never fires when disabled, and a disabled tier subscribes to nothing', () => {
    const { injector, store, setData, sessionStart, beforeAgentStart } = makeDriftHarness({
      driftSteers: false,
    })

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))

    // The config switch gates the subscription itself: the store never sees us.
    expect(store.listeners).toHaveLength(0)
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))

    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.episodesOpened()).toBe(0)
    expect(injector.steersDelivered()).toBe(0)
  })

  it('never fires when the freshness capability is absent (no provider wired)', () => {
    const { injector, store, setData, sessionStart, beforeAgentStart } = makeDriftHarness({
      withStore: false,
    })

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))

    expect(store.listeners).toHaveLength(0)
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.episodesOpened()).toBe(0)
    expect(injector.steersDelivered()).toBe(0)
  })

  it('defers while guidance is not ready and delivers the episode steer on the first ready turn', () => {
    const { injector, store, setData, sessionStart, beforeAgentStart } = makeDriftHarness()

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'busy'))

    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    // The deferral never consumed the episode's ONE steer.
    expect(injector.queuedSteer()).not.toBeUndefined()
    expect(injector.steersDelivered()).toBe(0)

    setData('/repo', classified('/repo', 'clean'))
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(injector.queuedSteer()).toBeUndefined()
    expect(injector.steersDelivered()).toBe(1)
  })

  it('defers while the gate is still settling (no cached data) and delivers once it lands', () => {
    const { injector, store, setData, sessionStart, beforeAgentStart } = makeDriftHarness()

    sessionStart('/repo')
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))

    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.queuedSteer()).not.toBeUndefined()

    setData('/repo', classified('/repo', 'clean'))
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(injector.steersDelivered()).toBe(1)
  })

  it('delivers a steer observed and queued while readiness is suppressed once readiness holds', () => {
    const { injector, store, setData, sessionStart, beforeAgentStart } = makeDriftHarness()

    sessionStart('/repo')
    // Not ready yet (unavailable), but the transition is still observed.
    setData('/repo', classified('/repo', 'unavailable'))
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(beforeAgentStart(promptEvent())).toBeUndefined()

    setData('/repo', classified('/repo', 'clean'))
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(injector.steersDelivered()).toBe(1)
  })

  it('re-arms per session and treats an inherited episode as baseline (no steer until a transition)', () => {
    const { injector, store, setData, sessionStart, sessionShutdown, beforeAgentStart } =
      makeDriftHarness()

    setData('/repo', classified('/repo', 'clean'))
    // The store already held staleness when the session subscribed.
    store.snapshotValue = freshnessFor('/repo', 'possibly-stale')
    sessionStart('/repo')

    expect(injector.episodesOpened()).toBe(0)
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.steersDelivered()).toBe(0)

    // Resolve and reopen inside the session: the transition owes its steer.
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(injector.steersDelivered()).toBe(1)

    sessionShutdown()
    expect(injector.currentSessionCwd()).toBeUndefined()
    expect(injector.steersDelivered()).toBe(0)
    expect(injector.episodesOpened()).toBe(0)

    // Second session, still-possibly-stale snapshot: inherited again — no
    // steer until the session observes its own fresh → possibly-stale cycle.
    sessionStart('/repo')
    expect(injector.episodesOpened()).toBe(0)
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
  })

  it('missing or non-string systemPrompt never consumes the owed steer', () => {
    const { injector, store, setData, sessionStart, beforeAgentStart } = makeDriftHarness()

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))

    expect(beforeAgentStart({ systemPromptOptions: { cwd: '/repo' } })).toBeUndefined()
    expect(beforeAgentStart(promptEvent('/repo', 42))).toBeUndefined()
    expect(injector.queuedSteer()).not.toBeUndefined()
    expect(injector.steersDelivered()).toBe(0)

    expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(injector.steersDelivered()).toBe(1)
  })

  it('registers nothing and stays inert without an api; dispose() silences all hooks', () => {
    const bare = new DriftSteerInjector({ driftSteers: true, sourceFor: () => null })
    expect(() => bare.register()).not.toThrow()
    expect(() => bare.dispose()).not.toThrow()

    const { injector, setData, sessionStart, beforeAgentStart } = makeDriftHarness()
    setData('/repo', classified('/repo', 'clean'))
    injector.dispose()

    expect(() => sessionStart('/repo')).not.toThrow()
    expect(() => beforeAgentStart(promptEvent())).not.toThrow()
    expect(injector.steersDelivered()).toBe(0)
  })
})

describe('DriftSteerInjector fail-open posture (task 2.1)', () => {
  it('register() never throws on a throwing api', () => {
    const throwingApi = {
      on(event: string): unknown {
        throw new Error(`api exploded for ${event}`)
      },
    }
    const injector = new DriftSteerInjector({
      driftSteers: true,
      sourceFor: () => null,
      api: throwingApi as unknown as ProactiveInjectionApi,
    })

    expect(() => injector.register()).not.toThrow()
    expect(() => injector.dispose()).not.toThrow()
  })

  it('a throwing freshness store degrades silently at session start', () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const api: ProactiveInjectionApi = {
      on(
        event: 'before_agent_start' | 'session_start' | 'session_shutdown',
        handler: (event: unknown, ctx: unknown) => unknown,
      ): unknown {
        handlers.set(event, handler)
        return undefined
      },
    }
    const injector = new DriftSteerInjector({
      driftSteers: true,
      sourceFor: () => null,
      freshnessFor: () => {
        throw new Error('store exploded')
      },
      api,
    })
    injector.register()

    const sessionStart = handlers.get('session_start')
    if (sessionStart === undefined) throw new Error('session_start handler not registered')
    expect(() => sessionStart({}, { cwd: '/repo' })).not.toThrow()
    expect(injector.steersDelivered()).toBe(0)

    const sessionShutdown = handlers.get('session_shutdown')
    if (sessionShutdown === undefined) throw new Error('session_shutdown handler not registered')
    expect(() => sessionShutdown({}, {})).not.toThrow()
    expect(() => injector.dispose()).not.toThrow()
  })

  it('handlers never throw on garbage events; the owed steer survives and delivers later', () => {
    const { injector, store, setData, sessionStart, sessionShutdown, beforeAgentStart } =
      makeDriftHarness()

    setData('/repo', classified('/repo', 'clean'))
    sessionStart('/repo')
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))

    expect(() => beforeAgentStart(null)).not.toThrow()
    expect(() => beforeAgentStart(undefined)).not.toThrow()
    expect(() => beforeAgentStart({})).not.toThrow()
    expect(() => beforeAgentStart({ systemPrompt: [], systemPromptOptions: 42 })).not.toThrow()
    expect(injector.queuedSteer()).not.toBeUndefined()
    expect(injector.steersDelivered()).toBe(0)

    // A real event after the garbage still delivers the episode steer.
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(injector.steersDelivered()).toBe(1)

    expect(() => sessionShutdown()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Task 2.2: the opt-in result-annotation tier (design D1/D4/D5).
// ---------------------------------------------------------------------------

describe('buildResultAnnotation (task 2.2: annotation content)', () => {
  it('renders a one-line annotation naming the staleness, the workspace, and the /cgc sync option', () => {
    const annotation = buildResultAnnotation({ cwd: '/repo', status: 'possibly-stale' })

    expect(annotation).not.toBeNull()
    expect(annotation).toContain('possibly stale')
    expect(annotation).toContain('/repo')
    expect(annotation).toContain('/cgc sync')
    // One line: the annotation never contains a line break.
    expect(annotation?.includes('\n')).toBe(false)
  })

  it('labels the skipped-busy staleness variant', () => {
    const annotation = buildResultAnnotation({ cwd: '/repo', status: 'skipped-busy' })
    expect(annotation).toContain('sync skipped as busy')
    expect(annotation).toContain('/cgc sync')
  })

  it('renders nothing for non-staleness states (fresh, syncing, disabled, unknown)', () => {
    expect(buildResultAnnotation({ cwd: '/repo', status: 'fresh' })).toBeNull()
    expect(buildResultAnnotation({ cwd: '/repo', status: 'syncing' })).toBeNull()
    expect(buildResultAnnotation({ cwd: '/repo', status: 'disabled' })).toBeNull()
    const unknown = { cwd: '/repo', status: 'mystery' }
    expect(buildResultAnnotation(unknown as DriftFreshnessSummary)).toBeNull()
  })

  it('never exceeds the hard length cap, even for a pathological cwd', () => {
    const annotation = buildResultAnnotation({
      cwd: `/very/${'long'.repeat(1_000)}/workspace`,
      status: 'possibly-stale',
    })

    expect(annotation).not.toBeNull()
    expect(annotation?.length).toBeLessThanOrEqual(RESULT_ANNOTATION_MAX_CHARS)
    // The actionable content survives the bound.
    expect(annotation).toContain('/cgc sync')
  })
})

interface ResultAnnotatorHarness {
  annotator: ResultAnnotator
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>
  store: TestDriftStore
  /** Set/replace the cached classification the readiness provider returns. */
  setData: (cwd: string, data: CoverageCachedData | null) => void
  sessionStart: (cwd: string) => void
  sessionShutdown: () => void
}

/**
 * Drive ResultAnnotator exactly the way pi drives it (same structural seam
 * pattern as the other tier harnesses). With `withStore: false` no freshness
 * provider is passed — the capability-absent degradation.
 */
function makeAnnotatorHarness(
  options: {
    resultAnnotations?: boolean
    withStore?: boolean
    readiness?: ReadinessPredicate
  } = {},
): ResultAnnotatorHarness {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  const dataByCwd = new Map<string, CoverageCachedData | null>()
  const store = new TestDriftStore()

  const api: ProactiveInjectionApi = {
    on(
      event: 'before_agent_start' | 'session_start' | 'session_shutdown',
      handler: (event: unknown, ctx: unknown) => unknown,
    ): unknown {
      handlers.set(event, handler)
      return undefined
    },
  }
  const annotator = new ResultAnnotator({
    resultAnnotations: options.resultAnnotations ?? true,
    // Omit the readiness seam unless asked (exactOptionalPropertyTypes).
    ...(options.readiness === undefined ? {} : { readiness: options.readiness }),
    sourceFor: (cwd: string) => dataByCwd.get(cwd) ?? null,
    // Omit the provider entirely when the capability is absent
    // (exactOptionalPropertyTypes: undefined is not a value here).
    ...(options.withStore === false ? {} : { freshnessFor: (_cwd: string) => store }),
    api,
  })
  annotator.register()

  const sessionStart = (cwd: string): void => {
    const handler = handlers.get('session_start')
    if (handler === undefined) throw new Error('session_start handler not registered')
    handler({ type: 'session_start' }, { cwd })
  }
  const sessionShutdown = (): void => {
    const handler = handlers.get('session_shutdown')
    if (handler === undefined) throw new Error('session_shutdown handler not registered')
    handler({ type: 'session_shutdown' }, {})
  }

  return {
    annotator,
    handlers,
    store,
    setData: (cwd: string, data: CoverageCachedData | null) => {
      dataByCwd.set(cwd, data)
    },
    sessionStart,
    sessionShutdown,
  }
}

describe('ResultAnnotator (task 2.2: freshness-scoped output decoration)', () => {
  it('wires session_start and session_shutdown; register() is idempotent', () => {
    const { annotator, handlers } = makeAnnotatorHarness()

    annotator.register()

    expect(handlers.size).toBe(2)
    expect(handlers.has('session_start')).toBe(true)
    expect(handlers.has('session_shutdown')).toBe(true)
  })

  it('annotates an extension-owned output when enabled and staleness is observed, preserving the original text verbatim', () => {
    const { annotator, store, setData, sessionStart } = makeAnnotatorHarness()

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))

    const original = 'CGC status — /repo\nLifecycle: clean'
    const decorated = annotator.annotate(original)

    // Semantics untouched: the original output is preserved as a prefix and
    // the annotation is appended as one clearly delimited line.
    expect(decorated.startsWith(`${original}\n`)).toBe(true)
    expect(decorated).toContain('possibly stale')
    expect(decorated).toContain('/repo')
    expect(decorated).toContain('/cgc sync')
    expect(annotator.annotationsApplied()).toBe(1)
  })

  it('returns the input unchanged when proactive.resultAnnotations is disabled, and subscribes to nothing', () => {
    const { annotator, store, setData, sessionStart } = makeAnnotatorHarness({
      resultAnnotations: false,
    })

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))

    // The config switch gates the subscription itself: the store never sees us.
    expect(store.listeners).toHaveLength(0)
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))

    expect(annotator.annotate('/repo output')).toBe('/repo output')
    expect(annotator.annotationsApplied()).toBe(0)
  })

  it('is an identity when the freshness capability is absent (no provider wired)', () => {
    const { annotator, store, setData, sessionStart } = makeAnnotatorHarness({ withStore: false })

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))

    expect(store.listeners).toHaveLength(0)
    expect(annotator.annotate('/repo output')).toBe('/repo output')
    expect(annotator.annotationsApplied()).toBe(0)
  })

  it('annotates an inherited stale episode from the store snapshot (no emission needed)', () => {
    const { annotator, store, setData, sessionStart } = makeAnnotatorHarness()

    setData('/repo', classified('/repo', 'clean'))
    // The store already held staleness when the session subscribed.
    store.snapshotValue = freshnessFor('/repo', 'possibly-stale')
    sessionStart('/repo')

    expect(annotator.annotate('status text')).toContain('possibly stale')
    expect(annotator.annotationsApplied()).toBe(1)
  })

  it('returns the input unchanged while freshness is fresh or syncing', () => {
    const { annotator, store, setData, sessionStart } = makeAnnotatorHarness()

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))
    store.emit(freshnessFor('/repo', 'fresh'))
    expect(annotator.annotate('status text')).toBe('status text')
    store.emit(freshnessFor('/repo', 'syncing'))
    expect(annotator.annotate('status text')).toBe('status text')
    expect(annotator.annotationsApplied()).toBe(0)
  })

  it('annotates the skipped-busy staleness variant', () => {
    const { annotator, store, setData, sessionStart } = makeAnnotatorHarness()

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))
    store.emit(freshnessFor('/repo', 'skipped-busy'))

    expect(annotator.annotate('status text')).toContain('sync skipped as busy')
    expect(annotator.annotationsApplied()).toBe(1)
  })

  it('defers while guidance is not ready and annotates on the first ready output', () => {
    const { annotator, store, setData, sessionStart } = makeAnnotatorHarness()

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'busy'))
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))

    expect(annotator.annotate('status text')).toBe('status text')
    expect(annotator.annotationsApplied()).toBe(0)

    setData('/repo', classified('/repo', 'clean'))
    expect(annotator.annotate('status text')).toContain('possibly stale')
    expect(annotator.annotationsApplied()).toBe(1)
  })

  it('defers while the gate is still settling (no cached data) and annotates once it lands', () => {
    const { annotator, store, sessionStart, setData } = makeAnnotatorHarness()

    sessionStart('/repo')
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))

    expect(annotator.annotate('status text')).toBe('status text')

    setData('/repo', classified('/repo', 'clean'))
    expect(annotator.annotate('status text')).toContain('possibly stale')
    expect(annotator.annotationsApplied()).toBe(1)
  })

  it('only follows freshness emissions for the session workspace', () => {
    const { annotator, store, setData, sessionStart } = makeAnnotatorHarness()

    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))
    store.emit(freshnessFor('/other', 'possibly-stale'))

    expect(annotator.annotate('status text')).toBe('status text')
    expect(annotator.observedStatus()).toBeUndefined()
  })

  it('re-arms per session: shutdown clears the observation, the next session observes fresh', () => {
    const { annotator, store, setData, sessionStart, sessionShutdown } = makeAnnotatorHarness()

    setData('/repo', classified('/repo', 'clean'))
    sessionStart('/repo')
    store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(annotator.annotate('status text')).toContain('possibly stale')

    sessionShutdown()
    expect(annotator.currentSessionCwd()).toBeUndefined()
    expect(annotator.annotate('status text')).toBe('status text')
    expect(annotator.annotationsApplied()).toBe(0)

    sessionStart('/repo')
    expect(annotator.annotate('status text')).toBe('status text')
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(annotator.annotate('status text')).toContain('possibly stale')
  })

  it('does nothing when no session cwd was captured', () => {
    const { annotator, setData } = makeAnnotatorHarness()

    setData('/repo', classified('/repo', 'clean'))
    expect(annotator.annotate('status text')).toBe('status text')
    expect(annotator.annotationsApplied()).toBe(0)
  })

  it('registers nothing without an api; dispose() silences the hooks and the decoration', () => {
    const bare = new ResultAnnotator({ resultAnnotations: true, sourceFor: () => null })
    expect(() => bare.register()).not.toThrow()
    expect(() => bare.dispose()).not.toThrow()

    const { annotator, store, setData, sessionStart } = makeAnnotatorHarness()
    setData('/repo', classified('/repo', 'clean'))
    store.emit(freshnessFor('/repo', 'fresh'))
    annotator.dispose()

    expect(() => sessionStart('/repo')).not.toThrow()
    expect(annotator.annotate('status text')).toBe('status text')
    expect(annotator.annotationsApplied()).toBe(0)
  })
})

describe('ResultAnnotator fail-open posture (task 2.2)', () => {
  it('register() never throws on a throwing api', () => {
    const throwingApi = {
      on(event: string): unknown {
        throw new Error(`api exploded for ${event}`)
      },
    }
    const annotator = new ResultAnnotator({
      resultAnnotations: true,
      sourceFor: () => null,
      api: throwingApi as unknown as ProactiveInjectionApi,
    })

    expect(() => annotator.register()).not.toThrow()
    expect(() => annotator.dispose()).not.toThrow()
  })

  it('a throwing freshness store degrades silently at session start and annotate stays an identity', () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const api: ProactiveInjectionApi = {
      on(
        event: 'before_agent_start' | 'session_start' | 'session_shutdown',
        handler: (event: unknown, ctx: unknown) => unknown,
      ): unknown {
        handlers.set(event, handler)
        return undefined
      },
    }
    const annotator = new ResultAnnotator({
      resultAnnotations: true,
      sourceFor: () => null,
      freshnessFor: () => {
        throw new Error('store exploded')
      },
      api,
    })
    annotator.register()

    const sessionStart = handlers.get('session_start')
    if (sessionStart === undefined) throw new Error('session_start handler not registered')
    expect(() => sessionStart({}, { cwd: '/repo' })).not.toThrow()
    expect(annotator.annotate('status text')).toBe('status text')
    expect(annotator.annotationsApplied()).toBe(0)

    const sessionShutdown = handlers.get('session_shutdown')
    if (sessionShutdown === undefined) throw new Error('session_shutdown handler not registered')
    expect(() => sessionShutdown({}, {})).not.toThrow()
    expect(() => annotator.dispose()).not.toThrow()
  })

  it('garbage session events never throw; annotate never throws on a throwing readiness provider', () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const store = new TestDriftStore()
    const api: ProactiveInjectionApi = {
      on(
        event: 'before_agent_start' | 'session_start' | 'session_shutdown',
        handler: (event: unknown, ctx: unknown) => unknown,
      ): unknown {
        handlers.set(event, handler)
        return undefined
      },
    }
    const annotator = new ResultAnnotator({
      resultAnnotations: true,
      sourceFor: () => {
        throw new Error('readiness exploded')
      },
      freshnessFor: () => store,
      api,
    })
    annotator.register()

    const sessionStart = handlers.get('session_start')
    if (sessionStart === undefined) throw new Error('session_start handler not registered')

    expect(() => sessionStart(null, null)).not.toThrow()
    expect(() => sessionStart({}, {})).not.toThrow()
    expect(() => sessionStart({}, { cwd: '/repo' })).not.toThrow()

    store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(() => annotator.annotate('status text')).not.toThrow()
    expect(annotator.annotate('status text')).toBe('status text')
    expect(annotator.annotationsApplied()).toBe(0)

    const sessionShutdown = handlers.get('session_shutdown')
    if (sessionShutdown === undefined) throw new Error('session_shutdown handler not registered')
    expect(() => sessionShutdown(null, null)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Task 3.1: the structural duplication test (design D5 / ADR-0002 follow-up /
// ADR-0009). Three structural properties hold across the WHOLE injection
// module, not tier by tier:
//   1. CONTENT: the tier renderers stay disjoint from the routing card
//      (change 2): coverage facts for the note, staleness facts for the steer
//      and the annotation — never routing rules.
//   2. READINESS: every tier gates through the SAME predicate — the
//      module-level {@link isGuidanceReady} (asserted by identity — a copy or
//      per-tier re-derivation cannot satisfy `toBe`), never a re-derivation.
//   3. FAIL-OPEN RETRY CAP: every tier contains delivery failures and retries
//      at most once per session (ADR-0009 / change 2 spec: "a failing
//      injection SHALL NOT be retried more than once in the session").
// ---------------------------------------------------------------------------

/** Routing-card content-class markers (change 2 spec + design vocabulary). */
const ROUTING_RULE_MARKERS: readonly string[] = [
  'relationship',
  'exact-string',
  'built-in search',
  'file reading',
  'graph query',
  'call chain',
  'callers',
  'dead code',
  'complexity',
  'routing',
]

/** The staleness-remediation phrase exclusive to the agent-intrusive tiers. */
const STALENESS_REMEDIATION = '/cgc sync'

/** Assert a rendered tier surface carries zero routing-card vocabulary. */
function expectNoRoutingContent(content: string): void {
  const folded = content.toLowerCase()
  for (const marker of ROUTING_RULE_MARKERS) {
    expect(folded).not.toContain(marker)
  }
}

const STALENESS_STATES: readonly DriftFreshnessStatus[] = ['possibly-stale', 'skipped-busy']
const QUIET_STATES: readonly DriftFreshnessStatus[] = ['fresh', 'syncing', 'disabled']

describe('Contract compliance (task 3.1): tier content classes disjoint from the routing card', () => {
  it('the coverage note renders coverage facts only — never routing rules', () => {
    const note = buildCoverageNote(degradedSource())

    // Coverage-fact class: index presence, snapshot time, supported-CGC scope.
    expect(note).toContain('CGC coverage:')
    expect(note).toContain('index present')
    expect(note).toContain('snapshot')
    expect(note).toContain('CGC scope:')
    expectNoRoutingContent(note)
    // Disjoint from the staleness class too: the note never prescribes the
    // remediation the agent-intrusive tiers carry, and never names a
    // staleness judgment (the note is a fact snapshot, not a state verdict).
    expect(note).not.toContain(STALENESS_REMEDIATION)
    expect(note).not.toContain('code graph')
  })

  it('the drift steer renders staleness facts only — never routing rules', () => {
    const steer = buildDriftSteer(freshnessFor('/repo', 'possibly-stale'))

    // Staleness-fact class: the state, the workspace, the remediation.
    expect(steer).toContain('possibly stale')
    expect(steer).toContain('/repo')
    expect(steer).toContain(STALENESS_REMEDIATION)
    expectNoRoutingContent(steer)
    // Disjoint from the coverage class: no coverage-fact vocabulary.
    expect(steer).not.toContain('CGC coverage:')
    expect(steer).not.toContain('repository')
    expect(steer).not.toContain('snapshot')
  })

  it('the result annotation renders staleness facts only — never routing rules', () => {
    for (const status of STALENESS_STATES) {
      const annotation = buildResultAnnotation(freshnessFor('/repo', status))
      expect(annotation).not.toBeNull()
      expect(annotation ?? '').toContain(STALENESS_REMEDIATION)
      expectNoRoutingContent(annotation ?? '')
    }
    // The staleness class says nothing when there is no staleness to name.
    for (const status of QUIET_STATES) {
      expect(buildResultAnnotation(freshnessFor('/repo', status))).toBeNull()
    }
  })
})

describe('Contract compliance (task 3.1): one shared readiness predicate — no per-tier re-derivation', () => {
  it('the shared predicate is ready on exactly clean and drift', () => {
    expect(isGuidanceReady('clean')).toBe(true)
    expect(isGuidanceReady('drift')).toBe(true)
    for (const state of SUPPRESSED_STATES) {
      expect(isGuidanceReady(state)).toBe(false)
    }
    expect(isGuidanceReady(null)).toBe(false)
    expect(isGuidanceReady(undefined)).toBe(false)
  })

  it('every tier defaults to the SAME predicate object — isGuidanceReady, not a copy', () => {
    const tiers = [
      new CoverageNoteInjector({ sessionNote: true, sourceFor: () => null }),
      new DriftSteerInjector({ driftSteers: true, sourceFor: () => null }),
      new ResultAnnotator({ resultAnnotations: true, sourceFor: () => null }),
    ]
    for (const tier of tiers) {
      expect(tier.readinessPredicate()).toBe(isGuidanceReady)
    }
  })

  it('the coverage note delegates readiness wholesale to the predicate — the predicate alone decides', () => {
    let decision = false
    const { injector, setData, sessionStart, beforeAgentStart } = makeInjectorHarness({
      readiness: () => decision,
    })
    sessionStart('/repo')
    // State HELD at clean while only the predicate outcome flips: a tier that
    // re-derived readiness internally would ignore the flipped predicate and
    // the outcome would not change. It must change everything.
    setData('/repo', classified('/repo', 'clean'))
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.hasInjected()).toBe(false)

    decision = true
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).toContain('CGC coverage:')
    expect(injector.hasInjected()).toBe(true)
  })

  it('the drift steer delegates readiness wholesale to the predicate', () => {
    let decision = false
    const { injector, store, setData, sessionStart, beforeAgentStart } = makeDriftHarness({
      readiness: () => decision,
    })
    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))

    // Predicate false: the episode's owed steer stays queued, deferred.
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.queuedSteer()).toContain('possibly stale')
    expect(injector.steersDelivered()).toBe(0)

    // Same state, predicate flips true: the QUEUED steer delivers.
    decision = true
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).toContain('possibly stale')
    expect(injector.steersDelivered()).toBe(1)
  })

  it('the result annotator delegates readiness wholesale to the predicate', () => {
    let decision = false
    const { annotator, store, setData, sessionStart } = makeAnnotatorHarness({
      readiness: () => decision,
    })
    sessionStart('/repo')
    setData('/repo', classified('/repo', 'clean'))
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))

    // Predicate false: the output passes through untouched.
    expect(annotator.annotate('status text')).toBe('status text')
    expect(annotator.annotationsApplied()).toBe(0)

    // Same state, predicate flips true: the SAME output is decorated.
    decision = true
    expect(annotator.annotate('status text')).toContain('possibly stale')
    expect(annotator.annotationsApplied()).toBe(1)
  })
})

describe('Contract compliance (task 3.1): fail-open retry cap of one per session (every tier)', () => {
  it('the budget is exactly one retry (ADR-0009 / change 2 spec)', () => {
    expect(PROACTIVE_RETRY_BUDGET).toBe(1)
  })

  it('the coverage note: a throwing delivery is contained, retried once, then silenced; the budget re-arms at the session boundary', () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    let providerCalls = 0
    let exploding = true
    const api: ProactiveInjectionApi = {
      on(
        event: 'before_agent_start' | 'session_start' | 'session_shutdown',
        handler: (event: unknown, ctx: unknown) => unknown,
      ): unknown {
        handlers.set(event, handler)
        return undefined
      },
    }
    const injector = new CoverageNoteInjector({
      sessionNote: true,
      sourceFor: () => {
        providerCalls += 1
        if (exploding) throw new Error('provider exploded')
        return classified('/repo', 'clean')
      },
      api,
    })
    injector.register()

    const sessionStart = handlers.get('session_start')
    const sessionShutdown = handlers.get('session_shutdown')
    const beforeAgentStart = handlers.get('before_agent_start')
    if (
      sessionStart === undefined ||
      sessionShutdown === undefined ||
      beforeAgentStart === undefined
    ) {
      throw new Error('expected hooks not registered')
    }

    sessionStart({ type: 'session_start' }, { cwd: '/repo' })
    // Initial attempt: contained — never throws into the turn.
    expect(() => beforeAgentStart(promptEvent(), {})).not.toThrow()
    // The ONE permitted retry: contained too (fail-open both times).
    expect(() => beforeAgentStart(promptEvent(), {})).not.toThrow()
    expect(providerCalls).toBe(2)
    expect(injector.failedDeliveries()).toBe(2)
    // Budget exhausted: the tier is silent — the broken surface is never
    // evaluated again this session, and the one-shot was never spent.
    expect(() => beforeAgentStart(promptEvent(), {})).not.toThrow()
    expect(providerCalls).toBe(2)
    expect(injector.hasInjected()).toBe(false)

    // A new session re-arms the budget: the same tier delivers once the
    // surface heals — the silence was per-session, never permanent.
    exploding = false
    sessionShutdown({ type: 'session_shutdown' }, {})
    sessionStart({ type: 'session_start' }, { cwd: '/repo' })
    expect(returnedPrompt(beforeAgentStart(promptEvent(), {}))).toContain('CGC coverage:')
    expect(injector.hasInjected()).toBe(true)
    expect(injector.failedDeliveries()).toBe(0)
  })

  it('the drift steer: a throwing delivery is contained, retried once, then silenced — the owed steer survives, and the budget re-arms', () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    let providerCalls = 0
    let exploding = true
    const store = new TestDriftStore()
    const api: ProactiveInjectionApi = {
      on(
        event: 'before_agent_start' | 'session_start' | 'session_shutdown',
        handler: (event: unknown, ctx: unknown) => unknown,
      ): unknown {
        handlers.set(event, handler)
        return undefined
      },
    }
    const injector = new DriftSteerInjector({
      driftSteers: true,
      sourceFor: () => {
        providerCalls += 1
        if (exploding) throw new Error('provider exploded')
        return classified('/repo', 'clean')
      },
      freshnessFor: () => store,
      api,
    })
    injector.register()

    const sessionStart = handlers.get('session_start')
    const sessionShutdown = handlers.get('session_shutdown')
    const beforeAgentStart = handlers.get('before_agent_start')
    if (
      sessionStart === undefined ||
      sessionShutdown === undefined ||
      beforeAgentStart === undefined
    ) {
      throw new Error('expected hooks not registered')
    }

    sessionStart({ type: 'session_start' }, { cwd: '/repo' })
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))

    // Initial attempt: contained; the ONE retry: contained.
    expect(() => beforeAgentStart(promptEvent(), {})).not.toThrow()
    expect(() => beforeAgentStart(promptEvent(), {})).not.toThrow()
    expect(providerCalls).toBe(2)
    expect(injector.failedDeliveries()).toBe(2)
    // The episode's ONE steer is not lost to the failure — the budget (not
    // the queue) is what the cap spends; delivery stays unspent.
    expect(injector.queuedSteer()).toContain('possibly stale')
    expect(injector.steersDelivered()).toBe(0)
    // Budget exhausted: silent — the broken surface is never touched again.
    expect(() => beforeAgentStart(promptEvent(), {})).not.toThrow()
    expect(providerCalls).toBe(2)

    // A new session re-arms the budget (and the episode machine).
    exploding = false
    sessionShutdown({ type: 'session_shutdown' }, {})
    sessionStart({ type: 'session_start' }, { cwd: '/repo' })
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(returnedPrompt(beforeAgentStart(promptEvent(), {}))).toContain('possibly stale')
    expect(injector.steersDelivered()).toBe(1)
    expect(injector.failedDeliveries()).toBe(0)
  })

  it('the result annotator: a failing decoration is contained, retried once, then silent — identity throughout, budget re-arms', () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    let providerCalls = 0
    let exploding = true
    const store = new TestDriftStore()
    const api: ProactiveInjectionApi = {
      on(
        event: 'before_agent_start' | 'session_start' | 'session_shutdown',
        handler: (event: unknown, ctx: unknown) => unknown,
      ): unknown {
        handlers.set(event, handler)
        return undefined
      },
    }
    const annotator = new ResultAnnotator({
      resultAnnotations: true,
      sourceFor: () => {
        providerCalls += 1
        if (exploding) throw new Error('provider exploded')
        return classified('/repo', 'clean')
      },
      freshnessFor: () => store,
      api,
    })
    annotator.register()

    const sessionStart = handlers.get('session_start')
    const sessionShutdown = handlers.get('session_shutdown')
    if (sessionStart === undefined || sessionShutdown === undefined) {
      throw new Error('expected hooks not registered')
    }

    sessionStart({ type: 'session_start' }, { cwd: '/repo' })
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))

    // Attempt 1 and the ONE retry: both fail open — the output passes
    // through byte-for-byte unchanged, semantics untouched.
    expect(annotator.annotate('status text')).toBe('status text')
    expect(annotator.annotate('status text')).toBe('status text')
    expect(providerCalls).toBe(2)
    expect(annotator.failedDeliveries()).toBe(2)
    // Budget exhausted: silent — identity without touching the surface.
    expect(annotator.annotate('status text')).toBe('status text')
    expect(providerCalls).toBe(2)
    expect(annotator.annotationsApplied()).toBe(0)

    // A new session re-arms the budget (and the staleness observation).
    exploding = false
    sessionShutdown({ type: 'session_shutdown' }, {})
    sessionStart({ type: 'session_start' }, { cwd: '/repo' })
    store.emit(freshnessFor('/repo', 'fresh'))
    store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(annotator.annotate('status text')).toContain('possibly stale')
    expect(annotator.annotationsApplied()).toBe(1)
    expect(annotator.failedDeliveries()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Task 3.2: the full gating matrix (design D5 / ADR-0002 / ADR-0009).
//
// Task 3.1 pinned the STRUCTURAL properties of the whole module; 3.2 pins
// the BEHAVIORAL table the per-tier tests only sample: every tier x every
// readiness row x enabled/disabled. One fire predicate holds across the whole
// matrix — a tier fires exactly when it is enabled AND guidance is ready —
// and the four contract properties fall out of it:
//   1. GATING: enabled x ready fires; every other combination defers without
//      spending anything, so the first ready turn still wins.
//   2. SEMANTICS: once-per-session (note) and once-per-episode (steer) hold
//      in every matrix row, and every tier re-arms at the session boundary.
//   3. OPT-OUT: a disabled tier never fires AND (for the observe-based tiers)
//      subscribes to nothing — the switch closes the observation surface,
//      not just the delivery handler.
//   4. CONTAINMENT: a deferral never consumes the retry budget; a real
//      delivery failure is contained, retried at most once per session, then
//      silent until the session boundary re-arms the budget (ADR-0009).
// ---------------------------------------------------------------------------

/**
 * Readiness rows the gating matrix sweeps: the ready pair (clean / drift),
 * the suppressed quartet (unavailable / unindexed / busy / corrupt), and the
 * still-settling gate (no cached classification yet). `ready` is what
 * {@link isGuidanceReady} decides for the row's state.
 */
const READINESS_ROWS: readonly {
  label: string
  data: CoverageCachedData | null
  ready: boolean
}[] = [
  { label: 'clean (ready)', data: classified('/repo', 'clean'), ready: true },
  { label: 'drift (ready)', data: classified('/repo', 'drift'), ready: true },
  { label: 'unavailable (suppressed)', data: classified('/repo', 'unavailable'), ready: false },
  { label: 'unindexed (suppressed)', data: classified('/repo', 'unindexed'), ready: false },
  { label: 'busy (suppressed)', data: classified('/repo', 'busy'), ready: false },
  { label: 'corrupt (suppressed)', data: classified('/repo', 'corrupt'), ready: false },
  { label: 'settling (no cached data)', data: null, ready: false },
]

describe('Contract compliance (task 3.2): the full gating matrix — readiness x tier settings', () => {
  it('the coverage note fires exactly on enabled x ready; deferred rows are never spent; disabled never fires', () => {
    for (const row of READINESS_ROWS) {
      for (const enabled of [true, false]) {
        const { injector, setData, sessionStart, beforeAgentStart } = makeInjectorHarness({
          sessionNote: enabled,
        })
        sessionStart('/repo')
        setData('/repo', row.data)

        const fired = returnedPrompt(beforeAgentStart(promptEvent())) !== undefined
        expect(fired).toBe(enabled && row.ready)
        expect(injector.hasInjected()).toBe(enabled && row.ready)

        if (enabled && row.ready) {
          // Once per session: a second ready turn — even after a mid-session
          // readiness transition — never re-injects.
          expect(beforeAgentStart(promptEvent())).toBeUndefined()
          setData('/repo', classified('/repo', 'drift'))
          expect(beforeAgentStart(promptEvent())).toBeUndefined()
          expect(injector.hasInjected()).toBe(true)
        }
        if (enabled && !row.ready) {
          // A deferral is not a failure: the retry budget is untouched and
          // the one-shot was never spent — the first ready turn injects.
          expect(injector.failedDeliveries()).toBe(0)
          setData('/repo', classified('/repo', 'clean'))
          expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
          expect(injector.hasInjected()).toBe(true)
        }
      }
    }
  })

  it('the drift steer fires exactly on enabled x ready, once per episode; disabled subscribes to nothing and never fires', () => {
    for (const row of READINESS_ROWS) {
      for (const enabled of [true, false]) {
        const { injector, store, setData, sessionStart, beforeAgentStart } = makeDriftHarness({
          driftSteers: enabled,
        })
        sessionStart('/repo')
        setData('/repo', row.data)

        // The opt-out switch gates the observation surface itself: a
        // disabled tier subscribes to nothing, whatever the readiness data
        // says — it can never even see a transition to act on.
        expect(store.listeners.size).toBe(enabled ? 1 : 0)
        store.emit(freshnessFor('/repo', 'fresh'))
        store.emit(freshnessFor('/repo', 'possibly-stale'))

        const fired = returnedPrompt(beforeAgentStart(promptEvent())) !== undefined
        expect(fired).toBe(enabled && row.ready)
        expect(injector.steersDelivered()).toBe(enabled && row.ready ? 1 : 0)

        if (enabled && row.ready) {
          // Once per episode: the fired episode owes nothing more until it
          // resolves — re-observed staleness cannot owe another steer.
          expect(beforeAgentStart(promptEvent())).toBeUndefined()
          store.emit(freshnessFor('/repo', 'possibly-stale'))
          expect(beforeAgentStart(promptEvent())).toBeUndefined()
          expect(injector.steersDelivered()).toBe(1)
        }
        if (enabled && !row.ready) {
          // Deferral keeps the episode's ONE steer queued and spends no
          // budget; the first ready turn delivers it.
          expect(injector.queuedSteer()).toContain('possibly stale')
          expect(injector.failedDeliveries()).toBe(0)
          expect(injector.steersDelivered()).toBe(0)
          setData('/repo', classified('/repo', 'clean'))
          expect(returnedPrompt(beforeAgentStart(promptEvent()))).not.toBeUndefined()
          expect(injector.steersDelivered()).toBe(1)
        }
        if (!enabled) {
          expect(injector.episodesOpened()).toBe(0)
          expect(injector.queuedSteer()).toBeUndefined()
          expect(injector.steersDelivered()).toBe(0)
        }
      }
    }
  })

  it('the result annotator decorates exactly on enabled x ready; disabled subscribes to nothing and stays clean', () => {
    for (const row of READINESS_ROWS) {
      for (const enabled of [true, false]) {
        const { annotator, store, setData, sessionStart } = makeAnnotatorHarness({
          resultAnnotations: enabled,
        })
        sessionStart('/repo')
        setData('/repo', row.data)

        expect(store.listeners.size).toBe(enabled ? 1 : 0)
        store.emit(freshnessFor('/repo', 'fresh'))
        store.emit(freshnessFor('/repo', 'possibly-stale'))

        const decorated = annotator.annotate('status text')
        const fired = decorated.includes('possibly stale')
        expect(fired).toBe(enabled && row.ready)
        expect(annotator.annotationsApplied()).toBe(enabled && row.ready ? 1 : 0)
        // Semantics untouched in every row: the original text is preserved.
        expect(decorated.startsWith('status text')).toBe(true)

        if (enabled && !row.ready) {
          // A deferral never spends anything: the first output after the
          // cached data lands is decorated.
          expect(annotator.failedDeliveries()).toBe(0)
          expect(annotator.annotationsApplied()).toBe(0)
          setData('/repo', classified('/repo', 'clean'))
          expect(annotator.annotate('status text')).toContain('possibly stale')
          expect(annotator.annotationsApplied()).toBe(1)
        }
      }
    }
  })

  it('every tier re-arms at the session boundary: per-session semantics hold across the matrix', () => {
    // The note injects once per session, and a NEW session injects again.
    const note = makeInjectorHarness()
    note.sessionStart('/repo')
    note.setData('/repo', classified('/repo', 'clean'))
    expect(returnedPrompt(note.beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(note.beforeAgentStart(promptEvent())).toBeUndefined()
    note.sessionShutdown()
    expect(note.injector.hasInjected()).toBe(false)
    note.sessionStart('/repo')
    expect(returnedPrompt(note.beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(note.injector.hasInjected()).toBe(true)

    // The steer's episode machine is per-session: the delivered count and
    // episode ledger reset, and the next session's transition owes its own
    // steer (an inherited episode never carries across sessions).
    const steer = makeDriftHarness()
    steer.sessionStart('/repo')
    steer.setData('/repo', classified('/repo', 'clean'))
    steer.store.emit(freshnessFor('/repo', 'fresh'))
    steer.store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(returnedPrompt(steer.beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(steer.injector.steersDelivered()).toBe(1)
    steer.sessionShutdown()
    expect(steer.injector.steersDelivered()).toBe(0)
    expect(steer.injector.episodesOpened()).toBe(0)
    expect(steer.injector.queuedSteer()).toBeUndefined()
    steer.sessionStart('/repo')
    steer.store.emit(freshnessFor('/repo', 'fresh'))
    steer.store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(returnedPrompt(steer.beforeAgentStart(promptEvent()))).not.toBeUndefined()
    expect(steer.injector.steersDelivered()).toBe(1)

    // The annotator's observation is per-session: a new session starts
    // clean and decorates only after its OWN staleness observation.
    const annotator = makeAnnotatorHarness()
    annotator.sessionStart('/repo')
    annotator.setData('/repo', classified('/repo', 'clean'))
    annotator.store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(annotator.annotator.annotate('status text')).toContain('possibly stale')
    annotator.sessionShutdown()
    expect(annotator.annotator.annotationsApplied()).toBe(0)
    annotator.sessionStart('/repo')
    expect(annotator.annotator.annotate('status text')).toBe('status text')
    annotator.store.emit(freshnessFor('/repo', 'fresh'))
    annotator.store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(annotator.annotator.annotate('status text')).toContain('possibly stale')
  })

  it('failure containment holds across the matrix: every tier contains one delivery failure, retries once, then goes silent; the budget re-arms', () => {
    for (const tier of ['note', 'steer', 'annotator'] as const) {
      let exploding = true
      let providerCalls = 0
      const store = new TestDriftStore()
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
      const api: ProactiveInjectionApi = {
        on(
          event: 'before_agent_start' | 'session_start' | 'session_shutdown',
          handler: (event: unknown, ctx: unknown) => unknown,
        ): unknown {
          handlers.set(event, handler)
          return undefined
        },
      }
      const sourceFor = (): CoverageCachedData => {
        providerCalls += 1
        if (exploding) throw new Error('provider exploded')
        return classified('/repo', 'clean')
      }

      // Wire the tier to its delivery point (the 3.1 fail-open probes,
      // unified into one matrix row).
      let deliver: () => unknown = () => undefined
      let deliveredNow: () => boolean = () => false
      let successes: () => number = () => 0
      let failures: () => number = () => 0
      let observes = false
      if (tier === 'note') {
        const note = new CoverageNoteInjector({ sessionNote: true, sourceFor, api })
        note.register()
        deliver = (): unknown => {
          const before = handlers.get('before_agent_start')
          if (before === undefined) throw new Error('before_agent_start not registered')
          return before(promptEvent(), {})
        }
        deliveredNow = (): boolean => note.hasInjected()
        successes = (): number => (note.hasInjected() ? 1 : 0)
        failures = (): number => note.failedDeliveries()
      } else if (tier === 'steer') {
        const steer = new DriftSteerInjector({
          driftSteers: true,
          sourceFor,
          freshnessFor: () => store,
          api,
        })
        steer.register()
        deliver = (): unknown => {
          const before = handlers.get('before_agent_start')
          if (before === undefined) throw new Error('before_agent_start not registered')
          return before(promptEvent(), {})
        }
        deliveredNow = (): boolean => steer.steersDelivered() > 0
        successes = (): number => steer.steersDelivered()
        failures = (): number => steer.failedDeliveries()
        observes = true
      } else {
        const annotator = new ResultAnnotator({
          resultAnnotations: true,
          sourceFor,
          freshnessFor: () => store,
          api,
        })
        annotator.register()
        deliver = (): unknown => annotator.annotate('status text')
        deliveredNow = (): boolean => annotator.annotationsApplied() > 0
        successes = (): number => annotator.annotationsApplied()
        failures = (): number => annotator.failedDeliveries()
        observes = true
      }

      const sessionStart = handlers.get('session_start')
      const sessionShutdown = handlers.get('session_shutdown')
      if (sessionStart === undefined || sessionShutdown === undefined) {
        throw new Error('expected session hooks not registered')
      }
      const start = (): void => {
        sessionStart({ type: 'session_start' }, { cwd: '/repo' })
      }
      const stop = (): void => {
        sessionShutdown({ type: 'session_shutdown' }, {})
      }
      // The observe-based tiers owe a delivery through a fresh → possibly-
      // stale transition; the note owes through its one-shot alone.
      const owe = (): void => {
        if (!observes) return
        store.emit(freshnessFor('/repo', 'fresh'))
        store.emit(freshnessFor('/repo', 'possibly-stale'))
      }

      start()
      owe()
      // The initial attempt and the ONE permitted retry: both contained —
      // a throwing delivery never escapes into the turn or the session.
      expect(() => deliver()).not.toThrow()
      expect(() => deliver()).not.toThrow()
      expect(providerCalls).toBe(2)
      expect(failures()).toBe(2)
      expect(deliveredNow()).toBe(false)
      // Budget exhausted: silent — the broken surface is never touched again
      // this session (ADR-0009), and no success was ever fabricated.
      expect(() => deliver()).not.toThrow()
      expect(providerCalls).toBe(2)
      expect(successes()).toBe(0)

      // The budget is per-session: once the surface heals, a NEW session
      // delivers normally with a clean ledger.
      exploding = false
      stop()
      start()
      owe()
      expect(() => deliver()).not.toThrow()
      expect(deliveredNow()).toBe(true)
      expect(successes()).toBe(1)
      expect(failures()).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Session rebind (add-cgc-session-rebind): the three proactive tiers are
// cached singletons; register() must re-wire their hooks onto a replacement
// session's API, re-arming each tier's one-shot-per-session budget there.
// ---------------------------------------------------------------------------

type ProactiveHookName = 'before_agent_start' | 'session_start' | 'session_shutdown'

function countingProactiveApi(): {
  wired: Map<ProactiveHookName, Array<(event: unknown, ctx: unknown) => unknown>>
  api: ProactiveInjectionApi
} {
  const wired = new Map<ProactiveHookName, Array<(event: unknown, ctx: unknown) => unknown>>()
  const api: ProactiveInjectionApi = {
    on(event: ProactiveHookName, handler: (event: unknown, ctx: unknown) => unknown): unknown {
      const list = wired.get(event) ?? []
      list.push(handler)
      wired.set(event, list)
      return undefined
    },
  }
  return { wired, api }
}

describe('proactive session rebind (add-cgc-session-rebind)', () => {
  it('CoverageNoteInjector rebinds all three hooks and re-arms the one-shot in the replacement session', () => {
    const a = countingProactiveApi()
    const injector = new CoverageNoteInjector({
      sessionNote: true,
      sourceFor: (cwd: string) => classified(cwd, 'clean'),
      api: a.api,
    })
    injector.register()
    for (const name of ['session_start', 'session_shutdown', 'before_agent_start'] as const) {
      expect(a.wired.get(name)).toHaveLength(1)
    }

    injector.register() // same api: idempotent
    for (const name of ['session_start', 'session_shutdown', 'before_agent_start'] as const) {
      expect(a.wired.get(name)).toHaveLength(1)
    }

    const b = countingProactiveApi()
    injector.register(b.api)
    for (const name of ['session_start', 'session_shutdown', 'before_agent_start'] as const) {
      expect(b.wired.get(name)).toHaveLength(1)
      expect(a.wired.get(name)).toHaveLength(1)
    }

    // The one-shot re-armed with the replacement session: the note injects
    // again there, exactly once.
    b.wired.get('session_start')?.[0]?.({ type: 'session_start' }, { cwd: '/repo' })
    const first = returnedPrompt(b.wired.get('before_agent_start')?.[0]?.(promptEvent(), {}))
    expect(first).not.toBeUndefined()
    expect(injector.hasInjected()).toBe(true)
    expect(
      returnedPrompt(b.wired.get('before_agent_start')?.[0]?.(promptEvent(), {})),
    ).toBeUndefined()

    // A disposed tier stays inert across a rebind attempt.
    injector.dispose()
    const c = countingProactiveApi()
    injector.register(c.api)
    expect(c.wired.size).toBe(0)
  })

  it('DriftSteerInjector rebinds all three hooks (same-api idempotent, replaced api untouched)', () => {
    const a = countingProactiveApi()
    const steer = new DriftSteerInjector({
      driftSteers: true,
      sourceFor: (cwd: string) => classified(cwd, 'clean'),
      api: a.api,
    })
    steer.register()
    for (const name of ['session_start', 'session_shutdown', 'before_agent_start'] as const) {
      expect(a.wired.get(name)).toHaveLength(1)
    }

    steer.register() // same api: idempotent
    for (const name of ['session_start', 'session_shutdown', 'before_agent_start'] as const) {
      expect(a.wired.get(name)).toHaveLength(1)
    }

    const b = countingProactiveApi()
    steer.register(b.api)
    for (const name of ['session_start', 'session_shutdown', 'before_agent_start'] as const) {
      expect(b.wired.get(name)).toHaveLength(1)
      expect(a.wired.get(name)).toHaveLength(1)
    }

    steer.dispose()
    const c = countingProactiveApi()
    steer.register(c.api)
    expect(c.wired.size).toBe(0)
  })

  it('ResultAnnotator rebinds its session hooks and decorates through the replacement API', () => {
    const store = new TestDriftStore()
    const a = countingProactiveApi()
    const annotator = new ResultAnnotator({
      resultAnnotations: true,
      sourceFor: (cwd: string) => classified(cwd, 'clean'),
      freshnessFor: () => store,
      api: a.api,
    })
    annotator.register()
    for (const name of ['session_start', 'session_shutdown'] as const) {
      expect(a.wired.get(name)).toHaveLength(1)
    }

    annotator.register() // same api: idempotent
    expect(a.wired.get('session_start')).toHaveLength(1)

    const b = countingProactiveApi()
    annotator.register(b.api)
    for (const name of ['session_start', 'session_shutdown'] as const) {
      expect(b.wired.get(name)).toHaveLength(1)
      expect(a.wired.get(name)).toHaveLength(1)
    }

    // Decoration works through the rebound hooks: the replacement session
    // observes staleness and the next extension-owned output is annotated.
    b.wired.get('session_start')?.[0]?.({ type: 'session_start' }, { cwd: '/repo' })
    store.emit(freshnessFor('/repo', 'possibly-stale'))
    expect(annotator.annotate('status text')).not.toBe('status text')

    annotator.dispose()
    const c = countingProactiveApi()
    annotator.register(c.api)
    expect(c.wired.size).toBe(0)
  })
})
