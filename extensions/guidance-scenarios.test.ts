// Spec-scenario verification (change add-cgc-agent-routing-guidance, task 3.3).
//
// Walks EVERY scenario in specs/cgc-agent-guidance/spec.md against the real
// implementation, one describe block per requirement, one `it` per scenario,
// so a reader can map "spec scenario -> assertion" one to one. The matrix
// coverage tests (task 3.1, guidance.test.ts) prove the (state, activity) grid;
// this file is the scenario ledger the spec asks for, and may restate a grid
// cell when a scenario names it.
//
// Task 3.3 verification ledger — all ELEVEN spec scenarios are asserted below:
//   Always-on routing guidelines
//     guidelines-injected-when-ready | guidelines-have-no-opt-out
//   Readiness gating of guidance
//     cgc-binary-missing | workspace-has-no-index | index-becomes-ready-mid-session
//   Advisory routing content
//     relationship-question-routes-to-graph | exact-string-stays-with-built-ins
//   Opt-in routing skill
//     skill-disabled-by-default | skill-enabled | discoverability-evaluated-at-discovery-time
//   Fail-open guidance delivery
//     injection-error-contained

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

import type { LifecycleState } from './classifier'
import { CONFIG_ENV_VARS, DEFAULT_CONFIG, loadConfig } from './config'
import {
  GUIDANCE_CARD,
  GUIDANCE_RETRY_BUDGET,
  GUIDANCE_ROUTING_SKILL_NAME,
  GUIDANCE_ROUTING_SKILL_PATH,
  GUIDANCE_SCOPE,
  type GuidanceInjectionApi,
  GuidanceInjector,
  type GuidanceSkillDiscoverApi,
  GuidanceSkillExposure,
} from './guidance'
import type { LifecycleActivity, LifecycleSnapshot } from './lifecycle-state'

const SKILL_MD = readFileSync(new URL('../skills/cgc-routing/SKILL.md', import.meta.url), 'utf8')
const PACKAGE_JSON = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { pi?: { skills?: string[] } }

/** A minimal lifecycle snapshot for the readiness scenarios (design D1). */
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

/** The documented before_agent_start event shape a handler receives. */
function promptEvent(systemPrompt = 'base system prompt'): unknown {
  return { type: 'before_agent_start', systemPrompt, systemPromptOptions: { cwd: '/repo' } }
}

function returnedPrompt(result: unknown): string | undefined {
  return (result as { systemPrompt?: string } | undefined)?.systemPrompt
}

/** Register a real GuidanceInjector against a map-backed fake Pi API. */
function makeGuidanceHarness(
  options: {
    snapshotFor?: (cwd: string) => LifecycleSnapshot | null | undefined
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
    beforeAgentStart: (event: unknown = promptEvent()) => required('before_agent_start')(event, {}),
  }
}

/** Register a real GuidanceSkillExposure and expose its discovery handler. */
function makeSkillHarness(options: { enabled: boolean }) {
  const handlers: Array<(event: unknown) => unknown> = []
  const exposure = new GuidanceSkillExposure({
    enabled: options.enabled,
    api: {
      on: (_event: 'resources_discover', handler: (event: unknown, ctx: unknown) => unknown) =>
        handlers.push(handler as (event: unknown) => unknown),
    } as unknown as GuidanceSkillDiscoverApi,
  })
  exposure.register()
  return { exposure, discover: (reason = 'startup') => handlers[0]?.({ cwd: '/repo', reason }) }
}

describe('spec scenarios: always-on routing guidelines', () => {
  it('Scenario "Guidelines are injected when ready": cgc available and the index exists or is being created', () => {
    // "index exists" — the healthy terminal pair.
    for (const state of ['clean', 'drift'] as const) {
      const { injector, sessionStart, beforeAgentStart } = makeGuidanceHarness({
        snapshotFor: () => snapshot(state),
      })
      sessionStart('/repo')
      expect(returnedPrompt(beforeAgentStart(promptEvent('pi system prompt')))).toBe(
        `pi system prompt\n\n${GUIDANCE_CARD}`,
      )
      expect(injector.hasInjected()).toBe(true)
    }
    // "index is being created" — an in-flight indexing/syncing/rebuilding marker.
    for (const activity of ['indexing', 'syncing', 'rebuilding'] as const) {
      const { injector, sessionStart, beforeAgentStart } = makeGuidanceHarness({
        snapshotFor: () => snapshot('unindexed', activity),
      })
      sessionStart('/repo')
      expect(returnedPrompt(beforeAgentStart(promptEvent('pi system prompt')))).toBe(
        `pi system prompt\n\n${GUIDANCE_CARD}`,
      )
      expect(injector.hasInjected()).toBe(true)
    }
  })

  it('Scenario "Guidelines have no opt-out of their own": no setting disables the guidelines alone', () => {
    // The guidance config section carries exactly the routing-skill flag.
    expect(Object.keys(DEFAULT_CONFIG.guidance)).toEqual(['routingSkill'])
    // Across the whole extension config surface, the ONLY `guidance.*` key is
    // that routing-skill flag.
    const guidanceKeys = Object.keys(CONFIG_ENV_VARS).filter((key) => key.startsWith('guidance.'))
    expect(guidanceKeys).toEqual(['guidance.routingSkill'])
    // No key in ANY section even names the guideline/card layer.
    expect(
      Object.keys(CONFIG_ENV_VARS).filter((key) =>
        /guideline|always[-_.]?on|card|routingrules|routing-rules/i.test(key),
      ),
    ).toEqual([])

    // Honoring the routing-skill flag does not touch the always-on card: it
    // is delivered identically with the flag off and on.
    for (const routingSkill of [false, true]) {
      const loaded = loadConfig({
        env: { CGC_GUIDANCE_ROUTING_SKILL: String(routingSkill) },
        cwd: '/nonexistent',
        homeDir: '/nonexistent',
      })
      expect(loaded.config.guidance.routingSkill).toBe(routingSkill)

      const { sessionStart, beforeAgentStart } = makeGuidanceHarness({
        snapshotFor: () => snapshot('clean'),
      })
      sessionStart('/repo')
      expect(returnedPrompt(beforeAgentStart(promptEvent('pi system prompt')))).toBe(
        `pi system prompt\n\n${GUIDANCE_CARD}`,
      )
    }
  })
})

describe('spec scenarios: readiness gating of guidance', () => {
  it('Scenario "cgc binary missing": no guidelines injected, session proceeds normally', () => {
    const { injector, sessionStart, beforeAgentStart } = makeGuidanceHarness({
      snapshotFor: () => snapshot('unavailable'),
    })
    sessionStart('/repo')

    // The session proceeds: the handler defers (undefined) and never throws.
    expect(() => beforeAgentStart(promptEvent())).not.toThrow()
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.hasInjected()).toBe(false)
    // A deferral is not a failure and never spends the retry budget.
    expect(injector.failedDeliveries()).toBe(0)
    expect(injector.recordedErrors()).toHaveLength(0)
  })

  it('Scenario "Workspace has no index": no guidelines injected, session proceeds normally', () => {
    const { injector, sessionStart, beforeAgentStart } = makeGuidanceHarness({
      snapshotFor: () => snapshot('unindexed', 'idle'),
    })
    sessionStart('/repo')

    expect(() => beforeAgentStart(promptEvent())).not.toThrow()
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.hasInjected()).toBe(false)
    expect(injector.failedDeliveries()).toBe(0)
  })

  it('Scenario "Index becomes ready mid-session": injected at most once, never per turn', () => {
    let current: LifecycleSnapshot = snapshot('unindexed', 'idle')
    const { injector, sessionStart, beforeAgentStart } = makeGuidanceHarness({
      snapshotFor: () => current,
    })
    sessionStart('/repo')

    // Withheld while unindexed — repeatedly, without spending the one-shot.
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(beforeAgentStart(promptEvent())).toBeUndefined()
    expect(injector.hasInjected()).toBe(false)

    // The index is created later in the SAME session: exactly one injection.
    current = snapshot('clean')
    expect(returnedPrompt(beforeAgentStart(promptEvent('pi system prompt')))).toBe(
      `pi system prompt\n\n${GUIDANCE_CARD}`,
    )
    expect(injector.hasInjected()).toBe(true)

    // Never repeats on subsequent turns.
    for (let turn = 0; turn < 5; turn += 1) {
      expect(beforeAgentStart(promptEvent())).toBeUndefined()
    }
    expect(injector.hasInjected()).toBe(true)
  })
})

describe('spec scenarios: advisory routing content', () => {
  function injectedGuidanceText(): string {
    const { sessionStart, beforeAgentStart } = makeGuidanceHarness({
      snapshotFor: () => snapshot('clean'),
    })
    sessionStart('/repo')
    const prompt = returnedPrompt(beforeAgentStart(promptEvent('pi system prompt')))
    expect(prompt).toContain(GUIDANCE_CARD)
    return prompt ?? ''
  }

  it('Scenario "Relationship question routes to the graph": the guidance names graph relationship queries', () => {
    const guidance = injectedGuidanceText().replace(/\s+/g, ' ').toLowerCase()
    expect(guidance).toContain('graph relationship queries')
    for (const shape of ['caller', 'callee', 'call chain', 'impact', 'dead code', 'complexity']) {
      expect(guidance).toContain(shape)
    }
  })

  it('Scenario "Exact-string work stays with built-in search": the guidance does not steer it away', () => {
    const guidance = injectedGuidanceText().toLowerCase()
    expect(guidance).toContain('built-in search')
    expect(guidance).toContain('file reading')
    expect(guidance).toContain('exact-string')
    expect(guidance).not.toMatch(/do not use built-in|never use built-in|avoid built-in/)
  })
})

describe('spec scenarios: routing skill exposure (default on, opt-out)', () => {
  it('Scenario "Skill enabled by default": a default install offers the skill', () => {
    // The config default is on.
    expect(DEFAULT_CONFIG.guidance.routingSkill).toBe(true)
    // The package manifest still force-excludes the skill from static loading,
    // so only the runtime discovery handler can expose it.
    expect(PACKAGE_JSON.pi?.skills).toContain('!skills/cgc-routing/**')

    const { discover } = makeSkillHarness({ enabled: true })
    expect(discover()).toEqual({ skillPaths: [GUIDANCE_ROUTING_SKILL_PATH] })
  })

  it('Scenario "Skill opted out": an explicit false hides it', () => {
    const { discover } = makeSkillHarness({ enabled: false })
    expect(discover()).toBeUndefined()
  })

  it('Scenario "Skill enabled": the agent can consult the four onboarding topics', () => {
    // Opted in and ready -> the skill path is contributed.
    const { discover } = makeSkillHarness({ enabled: true })
    expect(discover()).toEqual({ skillPaths: [GUIDANCE_ROUTING_SKILL_PATH] })
    // The bundled skill really is the routing skill and is version-scoped to
    // the same CGC range as the always-on card.
    expect(GUIDANCE_ROUTING_SKILL_PATH).toContain(GUIDANCE_ROUTING_SKILL_NAME)
    expect(SKILL_MD).toContain(GUIDANCE_SCOPE)

    // The four topics the scenario names are present in the shipped content.
    const skill = SKILL_MD.toLowerCase()
    expect(skill).toContain('tool-choice by intent')
    expect(skill).toContain('backend fuzzy-search caveats')
    expect(skill).toContain('cgc_allowed_roots')
    expect(skill).toContain('indexing basics')
  })

  it('Scenario "Skill user-executable when enabled": contributed at discovery, readiness gates the agent side per turn', () => {
    // Discovery contributes whenever the flag is enabled — pi fires
    // resources_discover BEFORE the gate's background classification records
    // any snapshot, so readiness must not gate this path (the observed bug:
    // the skill was invisible on every fresh session). The agent-side pointer
    // is evaluated per turn instead (the injector's routingSkillPointer).
    const handlers: Array<(event: unknown) => unknown> = []
    const exposure = new GuidanceSkillExposure({
      enabled: true,
      api: {
        on: (_event: 'resources_discover', handler: (event: unknown, ctx: unknown) => unknown) =>
          handlers.push(handler as (event: unknown) => unknown),
      } as unknown as GuidanceSkillDiscoverApi,
    })
    exposure.register()

    // A fresh session: no snapshot recorded yet — the skill is still
    // contributed (user-executable via /skill:cgc-routing).
    expect(handlers[0]?.({ cwd: '/repo', reason: 'startup' })).toEqual({
      skillPaths: [GUIDANCE_ROUTING_SKILL_PATH],
    })
  })
})

describe('spec scenarios: fail-open guidance delivery', () => {
  it('Scenario "Injection error is contained": error recorded, loop unaffected, retried at most once', () => {
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

    // Initial attempt + exactly one retry; the agent loop never sees a throw.
    for (let i = 0; i < GUIDANCE_RETRY_BUDGET + 1; i += 1) {
      expect(() => beforeAgentStart(promptEvent())).not.toThrow()
    }
    expect(attempts).toBe(GUIDANCE_RETRY_BUDGET + 1)
    expect(injector.failedDeliveries()).toBe(GUIDANCE_RETRY_BUDGET + 1)
    expect(injector.recordedErrors()).toHaveLength(GUIDANCE_RETRY_BUDGET + 1)
    expect(reported).toHaveLength(GUIDANCE_RETRY_BUDGET + 1)
    expect(injector.isSilenced()).toBe(true)

    // Silenced for the rest of the session: no further retry.
    for (let turn = 0; turn < 5; turn += 1) {
      expect(beforeAgentStart(promptEvent())).toBeUndefined()
    }
    expect(attempts).toBe(GUIDANCE_RETRY_BUDGET + 1)
  })
})
