import { describe, expect, it } from 'bun:test'
import type { CgcFreshnessSummary } from './commands'
import {
  FILE_MODIFYING_TOOLS,
  FreshnessDriftObserver,
  type FreshnessExtensionApi,
  type FreshnessWorktreeBlock,
  getFreshnessStateStore,
} from './freshness'
import { FreshnessStateStore } from './freshness-state'
import type { DriftFreshnessStore } from './proactive'
import type { FreshnessHudStore } from './status-hud'

/**
 * A registered observer harness: a real store the test drives, a recorded
 * hook map (the same seam pattern as gate.test.ts / proactive.test.ts), and
 * the observer itself. `worktreeBlockFor` is only passed when supplied.
 */
function makeHarness(
  options: {
    worktreeBlockFor?: (cwd: string) => FreshnessWorktreeBlock | null
    now?: () => number
  } = {},
) {
  const store = new FreshnessStateStore()
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  const api: FreshnessExtensionApi = {
    on: (event, handler) => {
      handlers.set(event, handler)
      return undefined
    },
  }
  const observer = new FreshnessDriftObserver({
    store,
    ...(options.worktreeBlockFor === undefined
      ? {}
      : { worktreeBlockFor: options.worktreeBlockFor }),
    ...(options.now === undefined ? {} : { now: options.now }),
    api,
  })
  observer.register()
  return { store, observer, handlers }
}

function invokeHandler(
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
  event: string,
  eventPayload: unknown,
  ctx: unknown,
): void {
  const handler = handlers.get(event)
  if (handler === undefined) throw new Error(`${event} handler not registered`)
  handler(eventPayload, ctx)
}

function sessionStart(
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
  cwd = '/repo',
): void {
  invokeHandler(handlers, 'session_start', {}, { cwd })
}

function sessionShutdown(handlers: Map<string, (event: unknown, ctx: unknown) => unknown>): void {
  invokeHandler(handlers, 'session_shutdown', {}, {})
}

function toolCall(
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
  toolName: string,
  input: Record<string, unknown> = {},
): unknown {
  const handler = handlers.get('tool_call')
  if (handler === undefined) throw new Error('tool_call handler not registered')
  return handler({ toolName, toolCallId: 't1', input }, {})
}

describe('FILE_MODIFYING_TOOLS (task 1.3: deterministic file-modifying tools)', () => {
  it('names pi built-ins and the lean-ctx patch editor', () => {
    expect([...FILE_MODIFYING_TOOLS].sort()).toEqual([
      'ctx_patch',
      'edit',
      'remove_file',
      'rename_file',
      'write',
    ])
  })

  it('excludes read-only and opaque tools (bash/ctx_shell are not deterministically file-modifying)', () => {
    for (const tool of ['read', 'bash', 'ctx_shell', 'ctx_execute', 'grep', 'ctx_read']) {
      expect(FILE_MODIFYING_TOOLS.has(tool)).toBe(false)
    }
  })
})

describe('FreshnessDriftObserver registration', () => {
  it('wires session_start, session_shutdown and tool_call once (idempotent)', () => {
    const registered: string[] = []
    const api: FreshnessExtensionApi = {
      on: (event, _handler) => {
        registered.push(event)
        return undefined
      },
    }
    const observer = new FreshnessDriftObserver({ store: new FreshnessStateStore(), api })

    observer.register()
    observer.register()

    expect(registered).toEqual(['session_start', 'session_shutdown', 'tool_call'])
  })

  it('a throwing api.on never breaks registration (fail-open)', () => {
    const api: FreshnessExtensionApi = {
      on: () => {
        throw new Error('api exploded')
      },
    }
    const observer = new FreshnessDriftObserver({ store: new FreshnessStateStore(), api })

    expect(() => observer.register()).not.toThrow()
  })

  it('registration without an api is a no-op', () => {
    const observer = new FreshnessDriftObserver({ store: new FreshnessStateStore() })

    expect(() => observer.register()).not.toThrow()
  })

  it('dispose() turns the handlers into no-ops', () => {
    const { store, handlers, observer } = makeHarness()
    observer.dispose()

    sessionStart(handlers)
    toolCall(handlers, 'edit')

    expect(store.snapshots()).toEqual([])
  })
})

describe('drift observation (design D1: mark possibly-stale on first observed edit)', () => {
  it('records nothing without a session workspace', () => {
    const { store, handlers } = makeHarness()

    toolCall(handlers, 'edit')

    expect(store.snapshots()).toEqual([])
  })

  it('captures the session cwd and marks the workspace possibly-stale on the first edit', () => {
    const { store, handlers } = makeHarness()
    sessionStart(handlers)

    toolCall(handlers, 'edit')

    const snapshot = store.snapshot('/repo')
    expect(snapshot?.status).toBe('possibly-stale')
    expect(snapshot?.staleSince).not.toBeNull() // first mark carries the observation time
    expect(snapshot?.lastSyncedAt).toBeNull()
    expect(snapshot?.stateChangedAt).toBeNull() // first recorded status: nothing prior
  })

  it('every deterministic file-modifying tool opens the stale episode', () => {
    for (const tool of ['edit', 'write', 'remove_file', 'rename_file', 'ctx_patch']) {
      const { store, handlers } = makeHarness()
      sessionStart(handlers)

      toolCall(handlers, tool)

      expect(store.snapshot('/repo')?.status).toBe('possibly-stale')
    }
  })

  it('read-only tools never mark the workspace (read/bash/ctx_* are not drift)', () => {
    const { store, handlers } = makeHarness()
    sessionStart(handlers)

    for (const tool of ['read', 'bash', 'ctx_shell', 'ctx_execute', 'ctx_read', 'grep']) {
      toolCall(handlers, tool)
    }

    expect(store.snapshots()).toEqual([])
  })

  it('burst-debounces: re-observed edits within the same stale episode record nothing', () => {
    let clock = 1000
    const { store, handlers } = makeHarness({ now: () => clock })
    let emissions = 0
    store.subscribe(() => {
      emissions += 1
    })
    sessionStart(handlers)

    clock = 2000
    toolCall(handlers, 'edit')
    clock = 3000
    toolCall(handlers, 'edit')
    clock = 4000
    toolCall(handlers, 'write')
    clock = 5000
    toolCall(handlers, 'remove_file')

    // One emission total: the episode's first mark only, never re-recorded.
    expect(emissions).toBe(1)
    const snapshot = store.snapshot('/repo')
    expect(snapshot?.status).toBe('possibly-stale')
    expect(snapshot?.staleSince).toBe(2000) // first mark wins
  })

  it('a fresh status (sync completed) ends the episode; the next edit opens a NEW one', () => {
    let clock = 1000
    const { store, handlers } = makeHarness({ now: () => clock })
    sessionStart(handlers)

    toolCall(handlers, 'edit')
    expect(store.snapshot('/repo')?.staleSince).toBe(1000)

    store.recordStatus({ cwd: '/repo', status: 'fresh', at: 6000 })
    clock = 7000
    toolCall(handlers, 'edit')

    const snapshot = store.snapshot('/repo')
    expect(snapshot?.status).toBe('possibly-stale')
    expect(snapshot?.lastSyncedAt).toBe(6000) // sync history persists
    expect(snapshot?.staleSince).toBe(7000) // new episode, new first mark
  })

  it('never clobbers active statuses: syncing / skipped-busy / disabled stay put', () => {
    for (const status of ['syncing', 'skipped-busy', 'disabled'] as const) {
      const { store, handlers } = makeHarness()
      sessionStart(handlers)
      store.recordStatus({ cwd: '/repo', status, at: 100 })

      toolCall(handlers, 'edit')

      expect(store.snapshot('/repo')?.status).toBe(status)
      expect(store.snapshot('/repo')?.updatedAt).toBe(100)
    }
  })

  it('a session without an explicit cwd observes nothing', () => {
    const { store, handlers } = makeHarness()
    invokeHandler(handlers, 'session_start', {}, {})

    toolCall(handlers, 'edit')

    expect(store.snapshots()).toEqual([])
  })

  it('session shutdown resets the store and drops the workspace; a new session starts clean', () => {
    const { store, handlers } = makeHarness()
    sessionStart(handlers)
    toolCall(handlers, 'edit')
    expect(store.snapshot('/repo')?.status).toBe('possibly-stale')

    sessionShutdown(handlers)
    expect(store.snapshots()).toEqual([]) // no session carries state into the next

    // A tool call with no session observes nothing again...
    toolCall(handlers, 'edit')
    expect(store.snapshots()).toEqual([])

    // ...and a fresh session starts a fresh episode.
    sessionStart(handlers, '/repo')
    toolCall(handlers, 'edit')
    expect(store.snapshot('/repo')?.status).toBe('possibly-stale')
  })

  it('ignores malformed events (missing or non-string toolName)', () => {
    const { store, handlers } = makeHarness()
    sessionStart(handlers)

    invokeHandler(handlers, 'tool_call', { toolCallId: 't1' }, {})
    invokeHandler(handlers, 'tool_call', { toolName: 42 }, {})
    invokeHandler(handlers, 'tool_call', { toolName: null }, {})

    expect(store.snapshots()).toEqual([])
  })
})

describe('tool_call contract (docs/extensions.md: can block, input mutable)', () => {
  it('always returns undefined — drift observation never blocks a tool', () => {
    const { handlers } = makeHarness()
    sessionStart(handlers)

    expect(toolCall(handlers, 'edit')).toBeUndefined()
    expect(toolCall(handlers, 'read')).toBeUndefined()
    expect(toolCall(handlers, 'missing')).toBeUndefined()
  })

  it('never mutates event.input', () => {
    const { store, handlers } = makeHarness()
    sessionStart(handlers)
    const input = { path: '/repo/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }
    const event = { toolName: 'edit', toolCallId: 't1', input }

    invokeHandler(handlers, 'tool_call', event, {})

    expect(event.input).toEqual(input)
    expect(store.snapshot('/repo')?.status).toBe('possibly-stale')
  })
})

describe('worktree-isolation gate (fail-closed, isolate mode only)', () => {
  it('records nothing for a workspace the gate blocks', () => {
    const consulted: string[] = []
    const { store, handlers } = makeHarness({
      worktreeBlockFor: (cwd) => {
        consulted.push(cwd)
        return { blocked: true }
      },
    })
    sessionStart(handlers)

    toolCall(handlers, 'edit')

    expect(consulted).toEqual(['/repo']) // the gate is asked about the session workspace
    expect(store.snapshots()).toEqual([])
  })

  it('records normally when the gate reports unblocked or no block at all', () => {
    for (const gate of [() => ({ blocked: false }), () => null]) {
      const { store, handlers } = makeHarness({ worktreeBlockFor: gate })
      sessionStart(handlers)

      toolCall(handlers, 'edit')

      expect(store.snapshot('/repo')?.status).toBe('possibly-stale')
    }
  })

  it('a throwing block surface never stops observation (fail-open)', () => {
    const { store, handlers } = makeHarness({
      worktreeBlockFor: () => {
        throw new Error('gate exploded')
      },
    })
    sessionStart(handlers)

    expect(() => toolCall(handlers, 'edit')).not.toThrow()
    expect(store.snapshot('/repo')?.status).toBe('possibly-stale')
  })
})

describe('fail-open containment (ADR-0007)', () => {
  it('a throwing store never throws out of the tool_call handler', () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const api: FreshnessExtensionApi = {
      on: (event, handler) => {
        handlers.set(event, handler)
        return undefined
      },
    }
    const broken = {
      snapshot: () => {
        throw new Error('snapshot boom')
      },
      recordStatus: () => {
        throw new Error('record boom')
      },
      reset: () => {
        throw new Error('reset boom')
      },
      subscribe: () => () => {},
    } as unknown as FreshnessStateStore
    const observer = new FreshnessDriftObserver({ store: broken, api })
    observer.register()
    sessionStart(handlers)

    expect(() => toolCall(handlers, 'edit')).not.toThrow()
    expect(() => sessionShutdown(handlers)).not.toThrow()
    expect(observer.dispose()).toBeUndefined()
  })

  it('an observation error still returns undefined (the tool proceeds)', () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const api: FreshnessExtensionApi = {
      on: (event, handler) => {
        handlers.set(event, handler)
        return undefined
      },
    }
    const broken = {
      snapshot: () => null,
      recordStatus: () => {
        throw new Error('record boom')
      },
      reset: () => {},
      subscribe: () => () => {},
    } as unknown as FreshnessStateStore
    const observer = new FreshnessDriftObserver({ store: broken, api })
    observer.register()
    sessionStart(handlers)

    expect(toolCall(handlers, 'edit')).toBeUndefined()
  })
})

describe('getFreshnessStateStore (the shared consumer surface, design D5)', () => {
  it('returns one process-lifetime instance, empty until recorded', () => {
    const first = getFreshnessStateStore()
    const second = getFreshnessStateStore()

    expect(second).toBe(first)
    expect(first.snapshot('/repo')).toBeNull()
  })

  it('satisfies the downstream freshness seams structurally (HUD, steer, /cgc status)', () => {
    const store = getFreshnessStateStore()

    // Compile-time proofs of the D5 read seams (extra fields allowed).
    const hudStore: FreshnessHudStore = store
    const driftStore: DriftFreshnessStore = store
    const snapshot = store.recordStatus({ cwd: '/repo', status: 'possibly-stale', at: 1 })
    const summary: CgcFreshnessSummary = snapshot

    expect(hudStore.snapshot('/repo')?.status).toBe('possibly-stale')
    expect(driftStore.snapshot('/repo')?.status).toBe('possibly-stale')
    expect(summary.staleSince).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Session rebind (add-cgc-session-rebind): the freshness drift observer is a
// cached singleton; register() must re-wire its hooks onto a replacement
// session's API so tool-call drift marks work in resumed sessions.
// ---------------------------------------------------------------------------

function countingFreshnessApi(): {
  wired: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>
  api: FreshnessExtensionApi
} {
  const wired = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>()
  const api: FreshnessExtensionApi = {
    on: (event, handler) => {
      const list = wired.get(event) ?? []
      list.push(handler)
      wired.set(event, list)
      return undefined
    },
  }
  return { wired, api }
}

describe('FreshnessDriftObserver session rebind (add-cgc-session-rebind)', () => {
  it('re-wires all three hooks onto a replacement API and observes drift there', () => {
    const store = new FreshnessStateStore()
    const a = countingFreshnessApi()
    const observer = new FreshnessDriftObserver({ store, api: a.api })
    observer.register()
    for (const event of ['session_start', 'session_shutdown', 'tool_call']) {
      expect(a.wired.get(event)).toHaveLength(1)
    }

    // Same-API re-registration stays a single subscription.
    observer.register()
    for (const event of ['session_start', 'session_shutdown', 'tool_call']) {
      expect(a.wired.get(event)).toHaveLength(1)
    }

    // Session replacement: the fresh API receives every hook; the replaced
    // API gains nothing further.
    const b = countingFreshnessApi()
    observer.register(b.api)
    for (const event of ['session_start', 'session_shutdown', 'tool_call']) {
      expect(b.wired.get(event)).toHaveLength(1)
      expect(a.wired.get(event)).toHaveLength(1)
    }

    // Drift observation works through the rebound hooks: a file-modifying
    // tool call in the replacement session marks the workspace possibly-stale.
    b.wired.get('session_start')?.[0]?.({}, { cwd: '/repo' })
    b.wired.get('tool_call')?.[0]?.({ toolName: 'write', toolCallId: 't1', input: {} }, {})
    expect(store.snapshot('/repo')?.status).toBe('possibly-stale')

    // A disposed observer stays inert across a rebind attempt.
    observer.dispose()
    const c = countingFreshnessApi()
    observer.register(c.api)
    expect(c.wired.size).toBe(0)
  })
})
