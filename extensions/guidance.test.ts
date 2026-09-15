import { describe, expect, it } from 'bun:test'
import type { LifecycleState } from './classifier'
import { CONFIG_ENV_VARS, DEFAULT_CONFIG, loadConfig } from './config'
import {
  createGuidanceReadiness,
  GUIDANCE_CARD,
  GUIDANCE_CARD_LINES,
  GUIDANCE_CARD_MAX_LINES,
  GUIDANCE_READY_ACTIVITIES,
  GUIDANCE_RETRY_BUDGET,
  GUIDANCE_ROUTING_SKILL_PATH,
  GUIDANCE_SCOPE,
  type GuidanceInjectionApi,
  GuidanceInjector,
  type GuidanceSkillDiscoverApi,
  GuidanceSkillExposure,
  isGuidanceReadyForSnapshot,
} from './guidance'
import type { LifecycleActivity, LifecycleSnapshot } from './lifecycle-state'
import { isGuidanceReady } from './proactive'

/**
 * Task 1.1 — the compact always-on guideline card. These tests pin the hard
 * content budget and the routing contract the spec requires: relationship
 * questions route to graph queries, exact-string work stays with built-in
 * search/read, no tool is blocked, and the card is tool-name-agnostic.
 */
describe('guidance card (task 1.1: compact always-on routing guidelines)', () => {
  it('stays within the hard line budget', () => {
    expect(GUIDANCE_CARD_MAX_LINES).toBe(10)
    expect(GUIDANCE_CARD_LINES.length).toBeGreaterThan(0)
    expect(GUIDANCE_CARD_LINES.length).toBeLessThanOrEqual(GUIDANCE_CARD_MAX_LINES)
    expect(GUIDANCE_CARD.split('\n')).toHaveLength(GUIDANCE_CARD_LINES.length)
  })

  it('opens with the supported-CGC-version scope line', () => {
    expect(GUIDANCE_SCOPE).toBe('CodeGraphContext v0.6.x')
    expect(GUIDANCE_CARD_LINES[0]).toContain(GUIDANCE_SCOPE)
    expect(GUIDANCE_CARD).toContain('CodeGraphContext v0.6.x')
  })

  it('routes relationship-shaped questions to graph relationship queries', () => {
    const card = GUIDANCE_CARD.replace(/\s+/g, ' ').toLowerCase()
    for (const shape of ['caller', 'callee', 'call chain', 'impact', 'dead code', 'complexity']) {
      expect(card).toContain(shape)
    }
    expect(card).toContain('graph relationship queries')
  })

  it('keeps exact-string and known-file work with built-in search and reading', () => {
    const card = GUIDANCE_CARD.toLowerCase()
    expect(card).toContain('exact-string')
    expect(card).toContain('literal')
    expect(card).toContain('built-in search')
    expect(card).toContain('file reading')
    // Never steer exact-string work away from the built-ins.
    expect(card).not.toMatch(/do not use built-in|never use built-in|avoid built-in/)
  })

  it('is advisory only and never blocks or restricts a tool', () => {
    const card = GUIDANCE_CARD.replace(/\s+/g, ' ').toLowerCase()
    expect(card).toContain('advisory')
    expect(card).toContain('never blocks or restricts')
    expect(card).not.toMatch(/do not call|must not call|forbidden|disable tool/)
  })

  it('uses tool-name-agnostic primary phrasing (no MCP tool identifiers)', () => {
    const card = GUIDANCE_CARD.replace(/\s+/g, ' ').toLowerCase()
    for (const toolName of [
      'add_code_to_graph',
      'analyze_code_relationships',
      'calculate_cyclomatic_complexity',
      'find_code',
      'find_dead_code',
      'find_most_complex_functions',
      'list_indexed_repositories',
    ]) {
      expect(card).not.toContain(toolName)
    }
  })
})

/** A minimal lifecycle snapshot for the readiness matrix (design D1). */
function snapshot(state: LifecycleState, activity: LifecycleActivity = 'idle'): LifecycleSnapshot {
  return {
    cwd: '/repo',
    state,
    activity,
    indexed: state === 'clean' || state === 'drift',
    lastAction: null,
    reason: `${state}/${activity}`,
    classifiedAt: 1,
    stateChangedAt: 1,
    updatedAt: 1,
    actions: [],
  }
}

/**
 * Task 2.1 — the guidance-readiness predicate over the lifecycle state from
 * `add-cgc-session-lifecycle-gate` (design D1). Ready for `clean`/`drift` and
 * for the `indexing`/`syncing`/`rebuilding` background activities (an index
 * being created); suppressed for `unavailable`/`unindexed`/`busy`/`corrupt`
 * while idle. A missing snapshot — the lifecycle gate change absent — degrades
 * to permanently suppressed.
 */
describe('guidance readiness predicate (task 2.1)', () => {
  it('is ready on the healthy terminal pair, clean and drift', () => {
    expect(isGuidanceReadyForSnapshot(snapshot('clean'))).toBe(true)
    expect(isGuidanceReadyForSnapshot(snapshot('drift'))).toBe(true)
  })

  it('is ready while an index is being created (indexing / syncing / rebuilding)', () => {
    expect(GUIDANCE_READY_ACTIVITIES.has('indexing')).toBe(true)
    expect(GUIDANCE_READY_ACTIVITIES.has('syncing')).toBe(true)
    expect(GUIDANCE_READY_ACTIVITIES.has('rebuilding')).toBe(true)
    // AutoCreate: terminal state still unindexed, but the index is being created.
    expect(isGuidanceReadyForSnapshot(snapshot('unindexed', 'indexing'))).toBe(true)
    // Drift sync.
    expect(isGuidanceReadyForSnapshot(snapshot('drift', 'syncing'))).toBe(true)
    // Rebuild counts as ready even though the terminal state is corrupt (design D1).
    expect(isGuidanceReadyForSnapshot(snapshot('corrupt', 'rebuilding'))).toBe(true)
  })

  it('suppresses the four unhealthy terminal states while idle', () => {
    for (const state of ['unavailable', 'unindexed', 'busy', 'corrupt'] as const) {
      expect(isGuidanceReadyForSnapshot(snapshot(state))).toBe(false)
    }
  })

  it('is permanently suppressed without a snapshot (the lifecycle change absent)', () => {
    expect(isGuidanceReadyForSnapshot(null)).toBe(false)
    expect(isGuidanceReadyForSnapshot(undefined)).toBe(false)
    const readiness = createGuidanceReadiness()
    expect(readiness('/repo')).toBe(false)
    expect(readiness('/other')).toBe(false)
  })

  it('reads the workspace snapshot through a source and is fail-open on errors', () => {
    const readiness = createGuidanceReadiness((cwd) => (cwd === '/repo' ? snapshot('clean') : null))
    expect(readiness('/repo')).toBe(true)
    expect(readiness('/elsewhere')).toBe(false)

    const throwing = createGuidanceReadiness(() => {
      throw new Error('lifecycle store unavailable')
    })
    expect(throwing('/repo')).toBe(false)
  })
})

/** The documented before_agent_start event shape a handler receives. */
function promptEvent(systemPrompt = 'base system prompt'): unknown {
  return {
    type: 'before_agent_start',
    systemPrompt,
    systemPromptOptions: { cwd: '/repo' },
  }
}

function returnedPrompt(result: unknown): string | undefined {
  return (result as { systemPrompt?: string } | undefined)?.systemPrompt
}

/** Register a GuidanceInjector against a map-backed fake Pi API. */
function makeGuidanceHarness(
  options: {
    snapshotFor?: (cwd: string) => LifecycleSnapshot | null | undefined
    readiness?: (value: LifecycleSnapshot | null | undefined) => boolean
    onError?: (message: string) => void
  } = {},
) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  const api: GuidanceInjectionApi = {
    on(
      event: 'before_agent_start' | 'session_start' | 'session_shutdown',
      handler: (event: unknown, ctx: unknown) => unknown,
    ): unknown {
      handlers.set(event, handler)
      return undefined
    },
  }
  const injector = new GuidanceInjector({ ...options, api })
  injector.register()
  const required = (name: string): ((event: unknown, ctx: unknown) => unknown) => {
    const handler = handlers.get(name)
    if (handler === undefined) throw new Error(`expected ${name} hook registered`)
    return handler
  }
  return {
    injector,
    sessionStart: (cwd: string) => required('session_start')({ type: 'session_start' }, { cwd }),
    sessionShutdown: () => required('session_shutdown')({ type: 'session_shutdown' }, {}),
    beforeAgentStart: (event: unknown = promptEvent()) => required('before_agent_start')(event, {}),
  }
}

/**
 * Task 2.2 — one-shot `before_agent_start` delivery of the always-on card.
 * The injector appends the card to the CHAINED system prompt exactly once per
 * session, defers without spending the one-shot while guidance is not ready,
 * injects on a mid-session readiness transition, and is fail-open with a
 * one-retry-per-session cap.
 */
describe('guidance one-shot injection (task 2.2)', () => {
  it('appends the card to the chained system prompt exactly once when ready', () => {
    const { injector, sessionStart, beforeAgentStart } = makeGuidanceHarness({
      snapshotFor: () => snapshot('clean'),
    })
    sessionStart('/repo')

    const first = beforeAgentStart(promptEvent('pi system prompt'))
    const chained = returnedPrompt(first)
    expect(chained).toBe(`pi system prompt\n\n${GUIDANCE_CARD}`)
    expect(injector.hasInjected()).toBe(true)

    // At-most-once: every subsequent turn is untouched.
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.hasInjected()).toBe(true)
  })

  it('defers while not ready and injects on a mid-session readiness transition, at most once', () => {
    let current: LifecycleSnapshot | null = snapshot('unindexed')
    const { injector, sessionStart, beforeAgentStart } = makeGuidanceHarness({
      snapshotFor: () => current,
    })
    sessionStart('/repo')

    // Deferral: the one-shot is NOT spent.
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.hasInjected()).toBe(false)

    // The index appears later in the same session: the first ready turn wins.
    current = snapshot('clean')
    const chained = returnedPrompt(beforeAgentStart(promptEvent('pi system prompt')))
    expect(chained).toBe(`pi system prompt\n\n${GUIDANCE_CARD}`)
    expect(injector.hasInjected()).toBe(true)

    // Still at most once after the transition.
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
  })

  it('injects nothing and proceeds normally when the workspace is not ready', () => {
    const { sessionStart, beforeAgentStart } = makeGuidanceHarness({
      snapshotFor: () => snapshot('unavailable'),
    })
    sessionStart('/repo')
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    // A missing snapshot source degrades to permanently suppressed.
    const { sessionStart: start2, beforeAgentStart: inject2 } = makeGuidanceHarness()
    start2('/repo')
    expect(inject2(promptEvent())).toBeUndefined()
  })

  it('uses the shared snapshot predicate by default (delegates, never re-derives)', () => {
    const { injector } = makeGuidanceHarness()
    expect(injector.readinessPredicate()).toBe(isGuidanceReadyForSnapshot)
  })

  it('is fail-open: a throwing delivery is recorded, retried once, silenced, and re-armed next session', () => {
    expect(GUIDANCE_RETRY_BUDGET).toBe(1)
    let exploding = true
    const reported: string[] = []
    const { injector, sessionStart, sessionShutdown, beforeAgentStart } = makeGuidanceHarness({
      snapshotFor: () => {
        if (exploding) throw new Error('snapshot store exploded')
        return snapshot('clean')
      },
      onError: (message) => reported.push(message),
    })
    sessionStart('/repo')

    // Initial attempt + the ONE permitted retry: both contained.
    expect(() => beforeAgentStart(promptEvent())).not.toThrow()
    expect(() => beforeAgentStart(promptEvent())).not.toThrow()
    expect(injector.failedDeliveries()).toBe(2)
    expect(reported).toHaveLength(2)
    expect(injector.recordedErrors()).toHaveLength(2)

    // Budget exhausted: silent — the broken surface is never evaluated again.
    expect(() => beforeAgentStart(promptEvent())).not.toThrow()
    expect(injector.failedDeliveries()).toBe(2)
    expect(injector.isSilenced()).toBe(true)
    expect(injector.hasInjected()).toBe(false)

    // A new session re-arms the budget: the surface heals and delivery works.
    exploding = false
    sessionShutdown()
    sessionStart('/repo')
    expect(returnedPrompt(beforeAgentStart(promptEvent()))).toContain(GUIDANCE_CARD)
    expect(injector.hasInjected()).toBe(true)
    expect(injector.failedDeliveries()).toBe(0)
  })

  it('registers nothing when no API is supplied', () => {
    const injector = new GuidanceInjector({ snapshotFor: () => snapshot('clean') })
    expect(() => injector.register()).not.toThrow()
  })
})

/**
 * Task 2.4 — opt-in routing-skill exposure. The skill is contributed through
 * `resources_discover` ONLY when the opt-in flag is set AND guidance is ready,
 * evaluated per discovery event (never retroactively mid-session).
 */
describe('guidance routing-skill exposure (task 2.4)', () => {
  function makeSkillHarness(options: {
    enabled: boolean
    ready?: boolean
    throwOnReady?: boolean
  }) {
    const handlers: Array<(event: unknown, ctx: unknown) => unknown> = []
    const api = {
      on(_event: 'resources_discover', handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.push(handler)
      },
    } as unknown as GuidanceSkillDiscoverApi
    const reported: string[] = []
    const exposure = new GuidanceSkillExposure({
      enabled: options.enabled,
      readiness: () => {
        if (options.throwOnReady) throw new Error('snapshot store exploded')
        return options.ready ?? true
      },
      api,
      onError: (message) => reported.push(message),
    })
    exposure.register()
    return {
      exposure,
      reported,
      discover: (cwd: string) => handlers[0]?.({ cwd, reason: 'startup' }, {}),
    }
  }

  it('offers the bundled skill when opted in and ready', () => {
    const { discover } = makeSkillHarness({ enabled: true, ready: true })
    expect(discover('/repo')).toEqual({ skillPaths: [GUIDANCE_ROUTING_SKILL_PATH] })
  })

  it('is disabled by default: contributes nothing when not opted in', () => {
    const { discover } = makeSkillHarness({ enabled: false, ready: true })
    expect(discover('/repo')).toBeUndefined()
  })

  it('contributes nothing when opted in but guidance is not ready', () => {
    const { discover } = makeSkillHarness({ enabled: true, ready: false })
    expect(discover('/repo')).toBeUndefined()
  })

  it('does not apply a readiness transition retroactively (evaluated per discovery event)', () => {
    // Readiness is read afresh per discovery, so a reload discovers the skill
    // once ready; the earlier startup discovery was simply quiet.
    let ready = false
    const handlers: Array<(event: unknown) => unknown> = []
    const exposure = new GuidanceSkillExposure({
      enabled: true,
      readiness: () => ready,
      api: {
        on: (_event: 'resources_discover', handler: (event: unknown, ctx: unknown) => unknown) =>
          handlers.push(handler as (event: unknown) => unknown),
      } as unknown as GuidanceSkillDiscoverApi,
    })
    exposure.register()
    expect(handlers[0]?.({ cwd: '/repo' })).toBeUndefined()
    ready = true
    expect(handlers[0]?.({ cwd: '/repo' })).toEqual({ skillPaths: [GUIDANCE_ROUTING_SKILL_PATH] })
  })

  it('is fail-open: a throwing readiness check is recorded and contributes nothing', () => {
    const { exposure, reported, discover } = makeSkillHarness({ enabled: true, throwOnReady: true })
    expect(() => discover('/repo')).not.toThrow()
    expect(discover('/repo')).toBeUndefined()
    expect(exposure.recordedErrors()).toHaveLength(2)
    expect(reported).toHaveLength(2)
  })

  it('registers nothing when no API is supplied', () => {
    const exposure = new GuidanceSkillExposure({ enabled: true, readiness: () => true })
    expect(() => exposure.register()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Task 3.1: the gating matrix across ALL lifecycle states, the mid-session
// readiness transition, and the at-most-once injection property — asserted at
// the INJECTOR level against the change's D1 readiness table, over the ACTUAL
// shared predicate (never a re-derived copy).
// ---------------------------------------------------------------------------

/**
 * Every lifecycle state the gate can record (classifier.ts) plus the
 * "no classification yet" null state (lifecycle-state.ts models it as
 * `state: null`). The matrix drives the injector over the cross product of
 * these states and the four activities.
 */
const GATING_MATRIX_STATES: readonly (LifecycleState | null)[] = [
  null,
  'unavailable',
  'unindexed',
  'busy',
  'corrupt',
  'clean',
  'drift',
]

/**
 * The design-D1 readiness rule as a SPEC table, not a copy of the predicate:
 * while idle only the healthy terminal pair (clean/drift) is ready — null (no
 * classification yet) and the four unhealthy states are suppressed; an index
 * being created (indexing/syncing/rebuilding) is ready in every state.
 */
const IDLE_READY_STATES: ReadonlySet<LifecycleState | null> = new Set(['clean', 'drift'])

/** A synthetic snapshot for one (state, activity) matrix cell. */
function matrixSnapshot(
  state: LifecycleState | null,
  activity: LifecycleActivity,
): LifecycleSnapshot {
  if (state !== null) return snapshot(state, activity)
  return {
    cwd: '/repo',
    state: null,
    activity,
    indexed: null,
    lastAction: null,
    reason: null,
    classifiedAt: null,
    stateChangedAt: null,
    updatedAt: 1,
    actions: [],
  }
}

describe('guidance gating matrix (task 3.1)', () => {
  it('injects on exactly the ready (state, activity) cells and defers on the rest', () => {
    for (const state of GATING_MATRIX_STATES) {
      for (const activity of ['idle', 'indexing', 'syncing', 'rebuilding'] as const) {
        const expected = activity === 'idle' ? IDLE_READY_STATES.has(state) : true
        const { injector, sessionStart, beforeAgentStart } = makeGuidanceHarness({
          snapshotFor: () => matrixSnapshot(state, activity),
        })
        sessionStart('/repo')

        const result = beforeAgentStart(promptEvent('pi system prompt'))
        if (expected) {
          expect(returnedPrompt(result)).toBe(`pi system prompt\n\n${GUIDANCE_CARD}`)
          expect(injector.hasInjected()).toBe(true)
        } else {
          expect(result).toBeUndefined()
          expect(injector.hasInjected()).toBe(false)
        }
        // A deferral is not a failure: the turn is never blocked and no
        // delivery error is recorded (fail-open, advisory only).
        expect(injector.failedDeliveries()).toBe(0)
        expect(injector.recordedErrors()).toHaveLength(0)
      }
    }
  })

  it('injects at most once when readiness arrives mid-session, from every suppressed start', () => {
    const suppressedStarts = GATING_MATRIX_STATES.filter(
      (candidate) => !IDLE_READY_STATES.has(candidate),
    )
    expect(suppressedStarts.length).toBeGreaterThan(0)
    for (const state of suppressedStarts) {
      let current: LifecycleSnapshot = matrixSnapshot(state, 'idle')
      const { injector, sessionStart, beforeAgentStart } = makeGuidanceHarness({
        snapshotFor: () => current,
      })
      sessionStart('/repo')

      // Suppressed start: withhold on repeated turns WITHOUT spending the
      // one-shot, so the first later ready turn still wins.
      expect(beforeAgentStart(promptEvent())).toBeUndefined()
      expect(beforeAgentStart(promptEvent())).toBeUndefined()
      expect(injector.hasInjected()).toBe(false)

      // Readiness arrives later in the SAME session: exactly one injection.
      current = matrixSnapshot('clean', 'idle')
      expect(returnedPrompt(beforeAgentStart(promptEvent('pi system prompt')))).toBe(
        `pi system prompt\n\n${GUIDANCE_CARD}`,
      )
      expect(injector.hasInjected()).toBe(true)

      // Never again this session.
      for (let turn = 0; turn < 5; turn += 1) {
        expect(beforeAgentStart(promptEvent())).toBeUndefined()
      }
      expect(injector.hasInjected()).toBe(true)
    }
  })

  it('injects when maintenance activity starts mid-session (unindexed -> indexing)', () => {
    let current: LifecycleSnapshot = matrixSnapshot('unindexed', 'idle')
    const { injector, sessionStart, beforeAgentStart } = makeGuidanceHarness({
      snapshotFor: () => current,
    })
    sessionStart('/repo')

    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.hasInjected()).toBe(false)

    current = matrixSnapshot('unindexed', 'indexing')
    expect(returnedPrompt(beforeAgentStart(promptEvent('pi system prompt')))).toBe(
      `pi system prompt\n\n${GUIDANCE_CARD}`,
    )
    expect(injector.hasInjected()).toBe(true)
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
  })

  it('appends the card exactly once per session, never repeating across many turns', () => {
    const { injector, sessionStart, beforeAgentStart } = makeGuidanceHarness({
      snapshotFor: () => snapshot('clean'),
    })
    sessionStart('/repo')

    const first = returnedPrompt(beforeAgentStart(promptEvent('pi system prompt')))
    // The card appears exactly once in the first chained prompt.
    expect(first?.split(GUIDANCE_CARD)).toHaveLength(2)
    for (let turn = 0; turn < 10; turn += 1) {
      expect(beforeAgentStart(promptEvent('pi system prompt'))).toBeUndefined()
    }
    expect(injector.hasInjected()).toBe(true)
  })

  it('gates the opt-in routing skill on the same matrix at discovery time', () => {
    for (const state of GATING_MATRIX_STATES) {
      const handlers: Array<(event: unknown, ctx: unknown) => unknown> = []
      const exposure = new GuidanceSkillExposure({
        enabled: true,
        readiness: createGuidanceReadiness(() => matrixSnapshot(state, 'idle')),
        api: {
          on: (
            _event: 'resources_discover',
            handler: (event: unknown, ctx: unknown) => unknown,
          ) => {
            handlers.push(handler)
          },
        } as unknown as GuidanceSkillDiscoverApi,
      })
      exposure.register()

      const result = handlers[0]?.({ cwd: '/repo' }, {})
      if (IDLE_READY_STATES.has(state)) {
        expect(result).toEqual({ skillPaths: [GUIDANCE_ROUTING_SKILL_PATH] })
      } else {
        expect(result).toBeUndefined()
      }
    }
  })

  it('keeps the state half on the ONE shared ADR-0002 predicate (delegation, not a copy)', () => {
    // Identity: the injector defaults to the module predicate, which composes
    // proactive.ts's shared state predicate (proactive.test.ts pins the other
    // end of the same seam by asserting every tier defaults to that function).
    const { injector } = makeGuidanceHarness()
    expect(injector.readinessPredicate()).toBe(isGuidanceReadyForSnapshot)

    // Agreement over the whole matrix while idle: the composed predicate's
    // state half is exactly the shared predicate's decision — a re-derived
    // copy that drifted would diverge here.
    for (const state of GATING_MATRIX_STATES) {
      expect(isGuidanceReadyForSnapshot(matrixSnapshot(state, 'idle'))).toBe(isGuidanceReady(state))
    }
    expect(isGuidanceReadyForSnapshot(null)).toBe(isGuidanceReady(null))
    expect(isGuidanceReadyForSnapshot(undefined)).toBe(isGuidanceReady(undefined))
  })
})

// ---------------------------------------------------------------------------
// Task 3.2: the no-opt-out property (design D2, spec "Guidelines have no
// opt-out of their own") and the fail-open retry cap (spec "Fail-open guidance
// delivery": a failing injection is not retried more than once per session).
// ---------------------------------------------------------------------------

describe('guidance no-opt-out property (task 3.2)', () => {
  it('registers no config key that can disable the always-on guidelines alone', () => {
    // The guidance config section carries exactly the opt-in routing skill:
    // there is deliberately no card/guidelines/always-on switch of its own.
    expect(Object.keys(DEFAULT_CONFIG.guidance)).toEqual(['routingSkill'])

    // Across the WHOLE extension config surface the only `guidance.*` key is
    // that routing-skill opt-in — no sibling key names the always-on card.
    const guidanceKeys = Object.keys(CONFIG_ENV_VARS).filter((key) => key.startsWith('guidance.'))
    expect(guidanceKeys).toEqual(['guidance.routingSkill'])
    expect(CONFIG_ENV_VARS['guidance.routingSkill']).toBe('CGC_GUIDANCE_ROUTING_SKILL')

    // No key in ANY section even names the guideline/card layer, so there is
    // nothing a user could flip to remove the card while keeping the extension.
    const cardish = Object.keys(CONFIG_ENV_VARS).filter((key) =>
      /guideline|always[-_.]?on|card|routingrules|routing-rules/i.test(key),
    )
    expect(cardish).toEqual([])
  })

  it('ignores invented guidance off-switch keys instead of honoring them', () => {
    // A user cannot opt out by hand-writing a key: unknown names are not part
    // of the config surface, so the effective guidance section still holds
    // only the routing-skill flag and the card stays on.
    const result = loadConfig({
      env: {
        CGC_GUIDANCE_ENABLED: 'false',
        CGC_GUIDANCE_ALWAYS_ON: 'false',
        CGC_GUIDANCE_GUIDELINES: 'false',
      },
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(Object.keys(result.config.guidance)).toEqual(['routingSkill'])
    expect(result.config.guidance.routingSkill).toBe(false)
    expect(result.sources['guidance.routingSkill']).toBe('default')
  })

  it('delivers the always-on card regardless of the routing-skill opt-in', () => {
    // `guidance.routingSkill` gates ONLY the deeper skill exposure; the card
    // itself has no input through which any config value could turn it off.
    for (const routingSkill of [false, true]) {
      const loaded = loadConfig({
        env: { CGC_GUIDANCE_ROUTING_SKILL: String(routingSkill) },
        cwd: '/nonexistent',
        homeDir: '/nonexistent',
      })
      expect(loaded.config.guidance.routingSkill).toBe(routingSkill)

      const { injector, sessionStart, beforeAgentStart } = makeGuidanceHarness({
        snapshotFor: () => snapshot('clean'),
      })
      sessionStart('/repo')
      expect(returnedPrompt(beforeAgentStart(promptEvent('pi system prompt')))).toBe(
        `pi system prompt\n\n${GUIDANCE_CARD}`,
      )
      expect(injector.hasInjected()).toBe(true)
    }
  })
})

describe('guidance fail-open retry cap (task 3.2)', () => {
  it('attempts a failing delivery at most RETRY_BUDGET + 1 times, then goes silent', () => {
    expect(GUIDANCE_RETRY_BUDGET).toBe(1)
    let attempts = 0
    const reported: string[] = []
    const { injector, sessionStart, beforeAgentStart } = makeGuidanceHarness({
      snapshotFor: () => {
        attempts += 1
        throw new Error('prompt mechanism rejected the payload')
      },
      onError: (message) => reported.push(message),
    })
    sessionStart('/repo')

    // Initial attempt + exactly ONE retry = RETRY_BUDGET + 1 total attempts.
    for (let i = 0; i < GUIDANCE_RETRY_BUDGET + 1; i += 1) {
      expect(() => beforeAgentStart(promptEvent())).not.toThrow()
    }
    expect(attempts).toBe(GUIDANCE_RETRY_BUDGET + 1)
    expect(injector.failedDeliveries()).toBe(GUIDANCE_RETRY_BUDGET + 1)
    expect(injector.isSilenced()).toBe(true)
    expect(injector.recordedErrors()).toHaveLength(GUIDANCE_RETRY_BUDGET + 1)
    expect(reported).toHaveLength(GUIDANCE_RETRY_BUDGET + 1)

    // Silenced for the rest of the session: the broken surface is never
    // touched again, so the agent loop is never hit by an endless retry.
    for (let turn = 0; turn < 5; turn += 1) {
      expect(beforeAgentStart(promptEvent())).toBeUndefined()
    }
    expect(attempts).toBe(GUIDANCE_RETRY_BUDGET + 1)
    expect(injector.failedDeliveries()).toBe(GUIDANCE_RETRY_BUDGET + 1)
    expect(injector.isSilenced()).toBe(true)
    expect(injector.hasInjected()).toBe(false)
  })

  it('never spends the retry budget on a not-ready deferral, only on failures', () => {
    let mode: 'defer' | 'fail' | 'ready' = 'defer'
    const { injector, sessionStart, beforeAgentStart } = makeGuidanceHarness({
      snapshotFor: () => {
        if (mode === 'fail') throw new Error('snapshot store exploded')
        return mode === 'ready' ? snapshot('clean') : snapshot('unindexed')
      },
    })
    sessionStart('/repo')

    // Many deferrals: no failure is recorded and no budget is consumed.
    for (let turn = 0; turn < 5; turn += 1) {
      expect(beforeAgentStart(promptEvent())).toBeUndefined()
    }
    expect(injector.failedDeliveries()).toBe(0)
    expect(injector.isSilenced()).toBe(false)

    // A single contained failure still leaves the one permitted retry unused.
    mode = 'fail'
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.failedDeliveries()).toBe(1)
    expect(injector.isSilenced()).toBe(false)

    // The next ready turn still injects: the budget caps failures, not delivery.
    mode = 'ready'
    expect(returnedPrompt(beforeAgentStart(promptEvent('pi system prompt')))).toBe(
      `pi system prompt\n\n${GUIDANCE_CARD}`,
    )
    expect(injector.hasInjected()).toBe(true)
  })
})
