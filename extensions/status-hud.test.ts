import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { LifecycleClassification, LifecycleState } from './classifier'
import { type LifecycleSnapshot, LifecycleStateStore } from './lifecycle-state'
import {
  buildBusyWarning,
  buildCgcMissingWarning,
  buildCorruptWarning,
  buildUnindexedWarning,
  buildWarningText,
  chipTextFor,
  composeChipText,
  DEBOUNCE_MS,
  type FreshnessHudListener,
  type FreshnessHudStore,
  type FreshnessHudSummary,
  freshnessMarkerFor,
  type NoticeSeverity,
  STATUS_KEY,
  StatusHud,
  type StatusHudExtensionApi,
  type StatusHudStore,
  type WarningCondition,
  WarningSet,
  warningConditionFor,
  warningInputFor,
} from './status-hud'

// ---------------------------------------------------------------------------
// Test scaffolding: fake extension API (handlers map), chip recorder, temp
// lifecycle stores driven directly. Debounce is shortened to 5 ms so tests
// stay fast; every test settles with a small sleep (repo convention).
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Build a minimal classification the way classifier.ts produces them. */
function classification(
  cwd: string,
  state: LifecycleState,
  at = Date.now(),
  reason?: string,
): LifecycleClassification {
  return {
    cwd,
    state,
    indexed: state !== 'unindexed' && state !== 'unavailable',
    probe: {
      available: state !== 'unavailable',
      code: state === 'unavailable' ? 'UNAVAILABLE' : 'OK',
      version: state === 'unavailable' ? null : '1.0.0',
      message: `probe for ${state}`,
      cached: false,
    },
    health: null,
    reason: reason ?? `classified as ${state}`,
    at,
  }
}

interface ChipCall {
  key: string
  text: string | undefined
}

interface NoticeCall {
  severity: NoticeSeverity
  text: string
}

interface Harness {
  hud: StatusHud
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>
  chipCalls: ChipCall[]
  /** Warnings routed through the session notice surface (task 1.4). */
  noticeCalls: NoticeCall[]
  /** Dispatch session_start with a TUI context for `cwd` (default chip + notice recorders). */
  sessionStart: (cwd: string, ctx?: { mode?: unknown; ui?: unknown }) => void
  sessionShutdown: () => void
}

function makeHarness(
  storeFor: (cwd: string) => StatusHudStore | null,
  options: {
    debounceMs?: number
    setStatus?: (key: string, text: string | undefined) => void
    notify?: (message: string, severity: NoticeSeverity) => unknown
    freshnessFor?: (cwd: string) => FreshnessHudStore | null
  } = {},
): Harness {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  const chipCalls: ChipCall[] = []
  const noticeCalls: NoticeCall[] = []
  const api: StatusHudExtensionApi = {
    on(
      event: 'session_start' | 'session_shutdown',
      handler: (event: unknown, ctx: unknown) => unknown,
    ): unknown {
      handlers.set(event, handler)
      return undefined
    },
  }
  const setStatus =
    options.setStatus ??
    ((key: string, text: string | undefined) => {
      chipCalls.push({ key, text })
    })
  const notify =
    options.notify ??
    ((message: string, severity: NoticeSeverity) => {
      noticeCalls.push({ severity, text: message })
    })
  const freshnessFor =
    options.freshnessFor !== undefined ? { freshnessFor: options.freshnessFor } : {}
  const hud = new StatusHud({
    storeFor,
    api,
    debounceMs: options.debounceMs ?? 5,
    ...freshnessFor,
  })
  hud.register()

  const sessionStart = (cwd: string, ctx: { mode?: unknown; ui?: unknown } = {}): void => {
    const handler = handlers.get('session_start')
    if (handler === undefined) throw new Error('session_start handler not registered')
    handler(
      { type: 'session_start' },
      {
        cwd,
        mode: ctx.mode ?? 'tui',
        ui: ctx.ui !== undefined ? ctx.ui : { setStatus, notify },
      },
    )
  }
  const sessionShutdown = (): void => {
    const handler = handlers.get('session_shutdown')
    if (handler === undefined) throw new Error('session_shutdown handler not registered')
    handler({ type: 'session_shutdown' }, {})
  }
  return { hud, handlers, chipCalls, noticeCalls, sessionStart, sessionShutdown }
}

// ---------------------------------------------------------------------------
// Freshness test scaffolding (task 1.3): a subscribable fake freshness store
// mirroring the lifecycle store's shape, plus builders for its summaries.
// ---------------------------------------------------------------------------

/** A subscribable fake freshness store the HUD's `freshnessFor` resolves. */
interface FreshnessHarnessStore {
  subscribers: Set<FreshnessHudListener>
  records: Map<string, FreshnessHudSummary>
}

function makeFreshnessStore(): FreshnessHarnessStore {
  return { subscribers: new Set(), records: new Map() }
}

/** Emits one summary to every current subscriber (a real store on change). */
function emitFreshness(store: FreshnessHarnessStore, summary: FreshnessHudSummary): void {
  for (const listener of store.subscribers) listener(summary)
}

/** The `freshnessFor` accessor wiring a fake store into the HUD. */
function freshnessStoreFor(
  resolve: () => FreshnessHarnessStore,
): (cwd: string) => FreshnessHudStore {
  return (_cwd: string) => {
    const store = resolve()
    return {
      subscribe(listener: FreshnessHudListener): () => void {
        store.subscribers.add(listener)
        return () => {
          store.subscribers.delete(listener)
        }
      },
      snapshot(queried: string): FreshnessHudSummary | null {
        return store.records.get(queried) ?? null
      },
    }
  }
}

/** A well-formed freshness summary for one workspace. */
function freshnessSummary(
  cwd: string,
  status: FreshnessHudSummary['status'],
  at = Date.now(),
): FreshnessHudSummary {
  return {
    cwd,
    status,
    lastSyncedAt: status === 'fresh' ? at : null,
    staleSince: status === 'possibly-stale' ? at : null,
  }
}

/** The lifecycle snapshot the store would emit for a recorded classification. */
function snapshotFor(cwd: string, state: LifecycleState, at = Date.now()): LifecycleSnapshot {
  const store = new LifecycleStateStore()
  store.recordClassification(classification(cwd, state, at))
  const snapshot = store.snapshot(cwd)
  if (snapshot === null) throw new Error('fixture snapshot missing')
  return snapshot
}

// Task 2.2: the four once-per-session warning conditions (design D2), with
// the lifecycle state each maps onto and the spec-hinted content every notice
// must carry. Shared by the matrix tests below.
const WARNING_MATRIX: ReadonlyArray<{
  condition: WarningCondition
  state: LifecycleState
  contains: string
}> = [
  { condition: 'cgc-missing', state: 'unavailable', contains: 'CLI is unavailable' },
  { condition: 'unindexed', state: 'unindexed', contains: 'autoCreate' },
  {
    condition: 'busy',
    state: 'busy',
    contains: 'another CGC process holds the embedded database',
  },
  { condition: 'corrupt', state: 'corrupt', contains: 'cgc index . --force' },
]

/** A lifecycle state carrying a DIFFERENT warning condition than `condition` (task 2.2). */
function otherWarningState(condition: WarningCondition): LifecycleState {
  switch (condition) {
    case 'cgc-missing':
      return 'corrupt'
    case 'unindexed':
      return 'busy'
    case 'busy':
      return 'corrupt'
    case 'corrupt':
      return 'unindexed'
  }
}

// ---------------------------------------------------------------------------
// Pure mapping: state/activity -> chip text.
// ---------------------------------------------------------------------------

describe('chipTextFor (state -> chip mapping)', () => {
  it('maps the healthy pair to "ready" (never a literal from the classifier)', () => {
    expect(chipTextFor('clean', 'idle')).toBe('ready')
    expect(chipTextFor('drift', 'idle')).toBe('ready')
  })

  it('renders every unhealthy terminal state verbatim', () => {
    expect(chipTextFor('unindexed', 'idle')).toBe('unindexed')
    expect(chipTextFor('busy', 'idle')).toBe('busy')
    expect(chipTextFor('corrupt', 'idle')).toBe('corrupt')
    expect(chipTextFor('unavailable', 'idle')).toBe('unavailable')
  })

  it('renders a null state (nothing classified yet) as unavailable', () => {
    expect(chipTextFor(null, 'idle')).toBe('unavailable')
  })

  it('lets activity states win over the terminal state while work runs', () => {
    expect(chipTextFor('clean', 'indexing')).toBe('indexing…')
    expect(chipTextFor('unindexed', 'indexing')).toBe('indexing…')
    expect(chipTextFor('clean', 'syncing')).toBe('syncing…')
    expect(chipTextFor('corrupt', 'rebuilding')).toBe('rebuilding…')
    expect(chipTextFor(null, 'rebuilding')).toBe('rebuilding…')
  })

  // Task 2.1: pin the FULL state x activity matrix. Every lifecycle state
  // (the six classifier states plus the null "nothing classified yet"
  // convention) is mapped under every activity, so a regression in any single
  // combination fails loudly.
  it('pins the full state x activity matrix — every lifecycle state under every activity', () => {
    const states: ReadonlyArray<LifecycleState | null> = [
      null,
      'unavailable',
      'unindexed',
      'busy',
      'corrupt',
      'clean',
      'drift',
    ]
    // Terminal (idle) mapping, including the two folds: the healthy pair ->
    // "ready", and the null state -> "unavailable" (classifier.ts: the
    // canonical "do nothing, proceed" state).
    const idleExpected: ReadonlyArray<{ state: LifecycleState | null; chip: string }> = [
      { state: null, chip: 'unavailable' },
      { state: 'unavailable', chip: 'unavailable' },
      { state: 'unindexed', chip: 'unindexed' },
      { state: 'busy', chip: 'busy' },
      { state: 'corrupt', chip: 'corrupt' },
      { state: 'clean', chip: 'ready' },
      { state: 'drift', chip: 'ready' },
    ]
    for (const { state, chip } of idleExpected) {
      expect(chipTextFor(state, 'idle')).toBe(chip)
    }
    // Activity states win over EVERY terminal state — no combination where a
    // terminal state leaks through while work runs.
    for (const activity of ['indexing', 'syncing', 'rebuilding'] as const) {
      for (const state of states) {
        expect(chipTextFor(state, activity)).toBe(`${activity}…`)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Wiring and fail-open posture.
// ---------------------------------------------------------------------------

describe('StatusHud wiring (register / session hooks)', () => {
  it('wires both session hooks and is idempotent; pins the constants', () => {
    const store = new LifecycleStateStore()
    const harness = makeHarness(() => store)

    harness.hud.register()

    expect(harness.handlers.has('session_start')).toBe(true)
    expect(harness.handlers.has('session_shutdown')).toBe(true)
    expect(harness.handlers.size).toBe(2)
    expect(STATUS_KEY).toBe('cgc')
    expect(DEBOUNCE_MS).toBeGreaterThan(0)
  })

  it('is a fail-open no-op without an api (tests may drive the class directly)', () => {
    const hud = new StatusHud({ storeFor: () => new LifecycleStateStore() })
    expect(() => hud.register()).not.toThrow()
    expect(() => hud.dispose()).not.toThrow()
  })

  it('never throws on garbage or missing session contexts', () => {
    const store = new LifecycleStateStore()
    const harness = makeHarness(() => store)
    const sessionStart = harness.handlers.get('session_start') as (
      event: unknown,
      ctx: unknown,
    ) => unknown

    expect(() => sessionStart({ type: 'session_start' }, null)).not.toThrow()
    expect(() => sessionStart({ type: 'session_start' }, {})).not.toThrow()
    expect(() => sessionStart({ type: 'session_start' }, { cwd: 42 })).not.toThrow()
    expect(() => sessionStart({ type: 'session_start' }, { cwd: '', mode: 42 })).not.toThrow()
    expect(() =>
      sessionStart({ type: 'session_start' }, { cwd: '/repo', mode: 'tui', ui: {} }),
    ).not.toThrow()
    expect(() =>
      sessionStart({ type: 'session_start' }, { cwd: '/repo', ui: { setStatus: 'nope' } }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Rendering: fresh store, fallback store, workspace scoping, activity.
// ---------------------------------------------------------------------------

describe('StatusHud chip rendering', () => {
  it('starts cleared on a fresh store and renders the classified state', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, chipCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)
    expect(chipCalls).toEqual([{ key: STATUS_KEY, text: undefined }])

    store.recordClassification(classification('/repo', 'clean'))
    await sleep(30)
    expect(chipCalls).toEqual([
      { key: STATUS_KEY, text: undefined },
      { key: STATUS_KEY, text: 'ready' },
    ])
  })

  it('renders the last known state when a store already holds a record at session start', async () => {
    const store = new LifecycleStateStore()
    store.recordClassification(classification('/repo', 'drift'))
    const { sessionStart, chipCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)
    expect(chipCalls).toEqual([{ key: STATUS_KEY, text: 'ready' }])
  })

  it('renders only the active session workspace', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, chipCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)
    chipCalls.length = 0

    store.recordClassification(classification('/other', 'corrupt'))
    await sleep(30)
    expect(chipCalls).toEqual([])

    store.recordClassification(classification('/repo', 'corrupt'))
    await sleep(30)
    expect(chipCalls).toEqual([{ key: STATUS_KEY, text: 'corrupt' }])
  })

  it('shows the running activity instead of the terminal state (coalesced burst)', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, chipCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)
    chipCalls.length = 0

    // A burst: classification + start action land back-to-back. The debounce
    // coalesces them into ONE render of the latest snapshot (indexing).
    store.recordClassification(classification('/repo', 'clean'))
    store.recordAction({ kind: 'indexing-started', cwd: '/repo', detail: 'auto-create started' })
    await sleep(30)
    expect(chipCalls).toEqual([{ key: STATUS_KEY, text: 'indexing…' }])

    store.recordAction({ kind: 'indexing-settled', cwd: '/repo', detail: 'settled' })
    await sleep(30)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: 'ready' })
  })

  it('dedupes store emissions whose (state, activity) did not change', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, chipCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)
    chipCalls.length = 0

    store.recordClassification(classification('/repo', 'busy'))
    await sleep(30)
    expect(chipCalls).toEqual([{ key: STATUS_KEY, text: 'busy' }])

    // The store fires on every record — unchanged pairs must not re-render.
    store.recordAction({ kind: 'busy-skipped', cwd: '/repo', detail: 'skip' })
    store.recordClassification(classification('/repo', 'busy'))
    await sleep(30)
    expect(chipCalls).toEqual([{ key: STATUS_KEY, text: 'busy' }])
  })

  // Task 2.1: every lifecycle state rendered END-TO-END through the real
  // store -> HUD pipeline (not just the pure mapping) — the chip text for the
  // full state set, including the "unavailable" state the HUD notes warn on.
  it('renders every terminal state end-to-end (the full state -> chip set)', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, chipCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)
    chipCalls.length = 0

    const terminal: ReadonlyArray<{ state: LifecycleState; chip: string }> = [
      { state: 'clean', chip: 'ready' },
      { state: 'drift', chip: 'ready' },
      { state: 'unindexed', chip: 'unindexed' },
      { state: 'busy', chip: 'busy' },
      { state: 'corrupt', chip: 'corrupt' },
      { state: 'unavailable', chip: 'unavailable' },
    ]
    for (const { state, chip } of terminal) {
      store.recordClassification(classification('/repo', state))
      await sleep(30)
      expect(chipCalls.at(-1)?.text).toBe(chip)
    }
  })

  it('renders "unavailable" for a recorded action before any classification (null-state convention)', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, chipCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)
    expect(chipCalls.at(-1)?.text).toBeUndefined() // no record at all -> cleared

    // Fail-open contract: an action may record before the classification
    // lands, leaving state null — which the chip renders as "unavailable"
    // (classifier.ts: the canonical "do nothing, proceed" state).
    store.recordAction({ kind: 'busy-skipped', cwd: '/repo', detail: 'skip' })
    await sleep(30)
    expect(chipCalls.at(-1)?.text).toBe('unavailable')
  })

  // Task 2.1: every ACTIVITY state (indexing / syncing / rebuilding) driven
  // through the real store's start/settle action pairs — the running activity
  // wins over the terminal state, then settling returns the terminal chip.
  it('renders every activity state end-to-end, activity winning over the terminal state', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, chipCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)
    store.recordClassification(classification('/repo', 'corrupt'))
    await sleep(30)
    chipCalls.length = 0

    const activities: ReadonlyArray<{ start: string; settle: string; chip: string }> = [
      { start: 'indexing-started', settle: 'indexing-settled', chip: 'indexing…' },
      { start: 'drift-sync-started', settle: 'drift-sync-settled', chip: 'syncing…' },
      { start: 'rebuild-started', settle: 'rebuild-settled', chip: 'rebuilding…' },
    ]
    for (const { start, settle, chip } of activities) {
      store.recordAction({ kind: start, cwd: '/repo', detail: 'start' })
      await sleep(30)
      // While work runs, the running activity wins over the corrupt terminal
      // state; the terminal state never shows mid-work.
      expect(chipCalls.at(-1)?.text).toBe(chip)

      store.recordAction({ kind: settle, cwd: '/repo', detail: 'settled' })
      await sleep(30)
      expect(chipCalls.at(-1)?.text).toBe('corrupt')
    }
  })
})

// ---------------------------------------------------------------------------
// Debounce coalescing semantics.
// ---------------------------------------------------------------------------

describe('StatusHud debounce coalescing', () => {
  it('coalesces a rapid transition storm into one render of the latest state', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, chipCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)
    chipCalls.length = 0

    // A storm: multiple distinct pairs inside one debounce window.
    store.recordClassification(classification('/repo', 'unindexed'))
    store.recordAction({ kind: 'indexing-started', cwd: '/repo', detail: 'start' })
    store.recordAction({ kind: 'indexing-settled', cwd: '/repo', detail: 'settle' })
    store.recordClassification(classification('/repo', 'clean'))
    await sleep(30)

    expect(chipCalls).toEqual([{ key: STATUS_KEY, text: 'ready' }])
  })

  it('coalesces across the window boundary only when new pairs arrive', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, chipCalls } = makeHarness(() => store, { debounceMs: 20 })

    sessionStart('/repo')
    await sleep(80)
    chipCalls.length = 0

    store.recordClassification(classification('/repo', 'unindexed'))
    await sleep(10) // still inside the 20 ms window
    store.recordAction({ kind: 'indexing-started', cwd: '/repo', detail: 'start' })
    await sleep(50) // window closed: the burst rendered once

    expect(chipCalls).toEqual([{ key: STATUS_KEY, text: 'indexing…' }])
  })

  // Task 2.1: debounce coalescing around ACTIVITY transitions — the window's
  // LAST pair (activity or settled) is the only render that reaches the
  // surface; intermediate pairs are swallowed.
  it('coalesces a burst that ends mid-activity: only the final (activity) pair renders', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, chipCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)
    chipCalls.length = 0

    // A storm ending mid-work: the intermediate terminal states are
    // swallowed; the window's LAST pair (syncing) is the only render.
    store.recordClassification(classification('/repo', 'busy'))
    store.recordClassification(classification('/repo', 'unindexed'))
    store.recordClassification(classification('/repo', 'clean'))
    store.recordAction({ kind: 'drift-sync-started', cwd: '/repo', detail: 'start' })
    await sleep(30)

    expect(chipCalls).toEqual([{ key: STATUS_KEY, text: 'syncing…' }])
  })

  it('coalesces a full start/settle cycle inside one window into a single render of the settled pair', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, chipCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)
    store.recordClassification(classification('/repo', 'unindexed'))
    await sleep(30)
    chipCalls.length = 0

    // start + settle land inside the same window: the intermediate
    // "indexing…" never reaches the surface, and the settled pair — already
    // rendered before the burst — still renders exactly once (the burst
    // moved the dedupe key to the intermediate activity pair, so the settle
    // is a fresh change, not a duplicate).
    store.recordAction({ kind: 'indexing-started', cwd: '/repo', detail: 'auto-create start' })
    store.recordAction({ kind: 'indexing-settled', cwd: '/repo', detail: 'auto-create settled' })
    await sleep(30)

    expect(chipCalls).toEqual([{ key: STATUS_KEY, text: 'unindexed' }])
  })
})

// ---------------------------------------------------------------------------
// Fail-open containment (spec: render errors swallowed, session unaffected,
// no more than one attempt per state change).
// ---------------------------------------------------------------------------

describe('StatusHud fail-open containment', () => {
  it('swallows a rejecting TUI surface and never retries the same state change', async () => {
    const store = new LifecycleStateStore()
    let attempts = 0
    const { sessionStart } = makeHarness(() => store, {
      setStatus: () => {
        attempts += 1
        throw new Error('tui exploded')
      },
    })

    sessionStart('/repo')
    await sleep(30)
    expect(attempts).toBe(1) // the initial clear: one attempt, swallowed

    store.recordClassification(classification('/repo', 'unindexed'))
    await sleep(30)
    expect(attempts).toBe(2) // one attempt for the new state change

    // Same pair re-emitted: deduped — no extra attempt.
    store.recordAction({ kind: 'unindexed-notice', cwd: '/repo', detail: 'again' })
    await sleep(30)
    expect(attempts).toBe(2)

    // A genuinely new state change gets exactly one new attempt.
    store.recordClassification(classification('/repo', 'clean'))
    await sleep(30)
    expect(attempts).toBe(3)
  })

  it('keeps the store dispatch unbroken while the chip surface rejects', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart } = makeHarness(() => store, {
      setStatus: () => {
        throw new Error('tui exploded')
      },
    })

    sessionStart('/repo')
    await sleep(30)

    // The store's listener loop must survive the render failure and keep
    // recording for every other consumer.
    expect(() => store.recordClassification(classification('/repo', 'clean'))).not.toThrow()
    expect(store.snapshot('/repo')?.state).toBe('clean')
  })

  it('leaves the session unaffected: a render error never escapes and cannot wedge the HUD (a recovered surface renders the next change)', async () => {
    const store = new LifecycleStateStore()
    const rendered: ChipCall[] = []
    let calls = 0
    const { sessionStart } = makeHarness(() => store, {
      setStatus: (key: string, text: string | undefined) => {
        calls += 1
        if (calls === 1) throw new Error('tui exploded') // the initial clear rejects
        rendered.push({ key, text })
      },
    })

    // The rejection is swallowed INSIDE the session-start hook body: the
    // hook itself must not throw, so pi's event dispatch (and the session)
    // is unaffected by the failing render.
    expect(() => sessionStart('/repo')).not.toThrow()
    await sleep(30)
    expect(calls).toBe(1) // one attempt for the initial clear, swallowed

    // A failure cannot wedge the HUD: the next state change reaches the
    // (recovered) surface — the session keeps working normally (spec: "the
    // error is swallowed, the session is unaffected").
    store.recordClassification(classification('/repo', 'unindexed'))
    await sleep(30)
    expect(calls).toBe(2)
    expect(rendered).toEqual([{ key: STATUS_KEY, text: 'unindexed' }])
  })
})

// ---------------------------------------------------------------------------
// Session lifecycle: re-subscribe per session_start, unsubscribe on shutdown.
// ---------------------------------------------------------------------------

describe('StatusHud session lifecycle', () => {
  it('unsubscribes at session shutdown: later store emissions do not render', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, sessionShutdown, chipCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)
    store.recordClassification(classification('/repo', 'clean'))
    await sleep(30)
    const before = chipCalls.length

    sessionShutdown()
    store.recordClassification(classification('/repo', 'corrupt'))
    await sleep(30)
    expect(chipCalls.length).toBe(before)
  })

  it('re-subscribes to the current store each session and drops the previous subscription', async () => {
    const first = new LifecycleStateStore()
    const second = new LifecycleStateStore()
    let current: LifecycleStateStore = first
    const { sessionStart, sessionShutdown, chipCalls } = makeHarness(() => current)

    sessionStart('/repo')
    await sleep(30)
    first.recordClassification(classification('/repo', 'busy'))
    await sleep(30)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: 'busy' })

    // A fresh gate store per session: the HUD must re-resolve and re-subscribe.
    current = second
    sessionShutdown()
    sessionStart('/repo')
    await sleep(30)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: undefined })

    // The first store's subscription was dropped — its records stay silent.
    first.recordClassification(classification('/repo', 'corrupt'))
    await sleep(30)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: undefined })

    // The new session's store renders.
    second.recordClassification(classification('/repo', 'clean'))
    await sleep(30)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: 'ready' })
  })
})

// ---------------------------------------------------------------------------
// Freshness capability (task 1.3): subscribe to freshness state when the
// capability is present; omit the freshness section otherwise (specified
// degradation). The seam mirrors the lifecycle store's (subscribe + snapshot);
// no polling, no queries on render.
// ---------------------------------------------------------------------------

describe('freshnessMarkerFor (worse-than-fresh marker mapping)', () => {
  it('marks every worse-than-fresh state and stays quiet on healthy states', () => {
    expect(freshnessMarkerFor(null)).toBeNull()
    expect(freshnessMarkerFor(freshnessSummary('/repo', 'fresh'))).toBeNull()
    expect(freshnessMarkerFor(freshnessSummary('/repo', 'disabled'))).toBeNull()
    expect(freshnessMarkerFor(freshnessSummary('/repo', 'possibly-stale'))).toBe('possibly stale')
    expect(freshnessMarkerFor(freshnessSummary('/repo', 'syncing'))).toBe('syncing')
    expect(freshnessMarkerFor(freshnessSummary('/repo', 'skipped-busy'))).toBe('busy')
  })
})

describe('composeChipText (lifecycle + optional freshness)', () => {
  it('is lifecycle-only when the capability is absent (specified degradation)', () => {
    expect(composeChipText(snapshotFor('/repo', 'clean'), null)).toBe('ready')
    expect(composeChipText(null, null)).toBeUndefined()
  })

  it('keeps the lifecycle text when freshness is fresh or disabled', () => {
    expect(composeChipText(snapshotFor('/repo', 'clean'), freshnessSummary('/repo', 'fresh'))).toBe(
      'ready',
    )
    expect(
      composeChipText(snapshotFor('/repo', 'clean'), freshnessSummary('/repo', 'disabled')),
    ).toBe('ready')
  })

  it('appends the marker when freshness is worse than fresh', () => {
    expect(
      composeChipText(snapshotFor('/repo', 'clean'), freshnessSummary('/repo', 'possibly-stale')),
    ).toBe('ready (possibly stale)')
    expect(
      composeChipText(snapshotFor('/repo', 'clean'), freshnessSummary('/repo', 'syncing')),
    ).toBe('ready (syncing)')
    expect(
      composeChipText(snapshotFor('/repo', 'clean'), freshnessSummary('/repo', 'skipped-busy')),
    ).toBe('ready (busy)')
  })

  it('renders the bare marker when no lifecycle record exists yet', () => {
    expect(composeChipText(null, freshnessSummary('/repo', 'possibly-stale'))).toBe(
      'possibly stale',
    )
  })
})

describe('StatusHud freshness subscription (task 1.3)', () => {
  it('subscribes when the capability is present and re-renders on freshness change', async () => {
    const lifecycle = new LifecycleStateStore()
    const freshness = makeFreshnessStore()
    const { sessionStart, chipCalls } = makeHarness(() => lifecycle, {
      freshnessFor: freshnessStoreFor(() => freshness),
    })

    sessionStart('/repo')
    await sleep(30)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: undefined })

    lifecycle.recordClassification(classification('/repo', 'clean'))
    await sleep(30)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: 'ready' })

    // A freshness emission re-renders even though the lifecycle did not change.
    emitFreshness(freshness, freshnessSummary('/repo', 'possibly-stale'))
    await sleep(30)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: 'ready (possibly stale)' })

    emitFreshness(freshness, freshnessSummary('/repo', 'fresh'))
    await sleep(30)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: 'ready' })
  })

  it('dedupes a repeated freshness status (no re-render for unchanged state)', async () => {
    const lifecycle = new LifecycleStateStore()
    const freshness = makeFreshnessStore()
    const { sessionStart, chipCalls } = makeHarness(() => lifecycle, {
      freshnessFor: freshnessStoreFor(() => freshness),
    })

    sessionStart('/repo')
    await sleep(30)
    lifecycle.recordClassification(classification('/repo', 'clean'))
    await sleep(30)
    const before = chipCalls.length

    emitFreshness(freshness, freshnessSummary('/repo', 'possibly-stale'))
    await sleep(30)
    emitFreshness(freshness, freshnessSummary('/repo', 'possibly-stale'))
    await sleep(30)

    expect(chipCalls.length).toBe(before + 1)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: 'ready (possibly stale)' })
  })

  it('renders the initial freshness snapshot captured at session start', async () => {
    const freshness = makeFreshnessStore()
    freshness.records.set('/repo', freshnessSummary('/repo', 'possibly-stale'))
    const { sessionStart, chipCalls } = makeHarness(() => new LifecycleStateStore(), {
      freshnessFor: freshnessStoreFor(() => freshness),
    })

    sessionStart('/repo')
    await sleep(30)
    // Lifecycle has no record yet: the bare freshness marker carries the chip.
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: 'possibly stale' })
  })

  it('scopes freshness emissions to the active session workspace', async () => {
    const lifecycle = new LifecycleStateStore()
    const freshness = makeFreshnessStore()
    const { sessionStart, chipCalls } = makeHarness(() => lifecycle, {
      freshnessFor: freshnessStoreFor(() => freshness),
    })

    sessionStart('/repo')
    await sleep(30)
    chipCalls.length = 0

    emitFreshness(freshness, freshnessSummary('/other', 'possibly-stale'))
    await sleep(30)
    expect(chipCalls).toEqual([])

    emitFreshness(freshness, freshnessSummary('/repo', 'possibly-stale'))
    await sleep(30)
    expect(chipCalls).toEqual([{ key: STATUS_KEY, text: 'possibly stale' }])
  })

  it('unsubscribes from the freshness store at shutdown', async () => {
    const lifecycle = new LifecycleStateStore()
    const freshness = makeFreshnessStore()
    const { sessionStart, sessionShutdown, chipCalls } = makeHarness(() => lifecycle, {
      freshnessFor: freshnessStoreFor(() => freshness),
    })

    sessionStart('/repo')
    await sleep(30)
    lifecycle.recordClassification(classification('/repo', 'busy'))
    await sleep(30)
    const before = chipCalls.length

    sessionShutdown()
    emitFreshness(freshness, freshnessSummary('/repo', 'possibly-stale'))
    await sleep(30)
    expect(chipCalls.length).toBe(before)
  })

  it('re-subscribes to the current freshness store each session', async () => {
    const lifecycle = new LifecycleStateStore()
    const first = makeFreshnessStore()
    const second = makeFreshnessStore()
    let current: FreshnessHarnessStore = first
    const { sessionStart, sessionShutdown, chipCalls } = makeHarness(() => lifecycle, {
      freshnessFor: freshnessStoreFor(() => current),
    })

    sessionStart('/repo')
    await sleep(30)
    lifecycle.recordClassification(classification('/repo', 'clean'))
    await sleep(30)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: 'ready' })

    emitFreshness(first, freshnessSummary('/repo', 'syncing'))
    await sleep(30)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: 'ready (syncing)' })

    // A fresh freshness store per session: the HUD must re-resolve and
    // re-subscribe. The lifecycle store still holds its record, so the chip
    // re-renders the lifecycle text and the freshness marker drops (the new
    // store's initial snapshot is empty).
    current = second
    sessionShutdown()
    sessionStart('/repo')
    await sleep(30)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: 'ready' })

    // The first store's subscription was dropped — its records stay silent.
    emitFreshness(first, freshnessSummary('/repo', 'possibly-stale'))
    await sleep(30)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: 'ready' })

    // The new session's store renders.
    emitFreshness(second, freshnessSummary('/repo', 'possibly-stale'))
    await sleep(30)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: 'ready (possibly stale)' })
  })

  it('fails open when the freshness provider throws (lifecycle-only session)', async () => {
    const lifecycle = new LifecycleStateStore()
    const { sessionStart, chipCalls } = makeHarness(() => lifecycle, {
      freshnessFor: () => {
        throw new Error('freshness provider exploded')
      },
    })

    sessionStart('/repo')
    await sleep(30)
    lifecycle.recordClassification(classification('/repo', 'unindexed'))
    await sleep(30)
    expect(chipCalls.at(-1)).toEqual({ key: STATUS_KEY, text: 'unindexed' })
  })

  it('omits the freshness section entirely when the capability is absent', async () => {
    const lifecycle = new LifecycleStateStore()
    const { sessionStart, chipCalls } = makeHarness(() => lifecycle)

    sessionStart('/repo')
    await sleep(30)
    lifecycle.recordClassification(classification('/repo', 'busy'))
    await sleep(30)
    // The lifecycle-only chip: no freshness marker space, ever.
    expect(chipCalls).toEqual([
      { key: STATUS_KEY, text: undefined },
      { key: STATUS_KEY, text: 'busy' },
    ])
  })
})

// ---------------------------------------------------------------------------
// Task 1.4: per-session one-time warning set — state mapping, builders, and
// the deduplicated session notice surface (design D2/D4).
// ---------------------------------------------------------------------------

describe('warningConditionFor (state -> condition mapping)', () => {
  it('maps the four warning states and stays null for the healthy pair and no-record', () => {
    expect(warningConditionFor('unavailable')).toBe('cgc-missing')
    expect(warningConditionFor('unindexed')).toBe('unindexed')
    expect(warningConditionFor('busy')).toBe('busy')
    expect(warningConditionFor('corrupt')).toBe('corrupt')
    expect(warningConditionFor('clean')).toBeNull()
    expect(warningConditionFor('drift')).toBeNull()
    // A null state is the chip's "unavailable" CONVENTION, not a cgc-missing
    // classification: no record yet must never warn.
    expect(warningConditionFor(null)).toBeNull()
  })
})

describe('warning builders (task 1.4)', () => {
  it('builds the cgc-missing warning with enablement guidance', () => {
    const text = buildCgcMissingWarning('/repo', 'probe failed')
    expect(text).toContain('/repo')
    expect(text).toContain('unavailable')
    expect(text).toContain('probe failed')
    expect(text).toContain('PATH')
    expect(text).toContain('CGC_EXECUTABLE')
  })

  it('builds the unindexed warning with auto-create guidance', () => {
    const text = buildUnindexedWarning('/repo')
    expect(text).toContain('/repo')
    expect(text).toContain('autoCreate')
    expect(text).toContain('CGC_LIFECYCLE_AUTO_CREATE')
    expect(text).toContain('cgc index .')
  })

  it('builds the busy warning naming the lock conflict', () => {
    const text = buildBusyWarning('/repo', 'another process holds the embedded database')
    expect(text).toContain('busy')
    expect(text).toContain('another process holds the embedded database')
    expect(text).toContain('lock files')
  })

  it('builds the corrupt warning pointing at the rebuild path', () => {
    const text = buildCorruptWarning('/repo', 'corruption markers')
    expect(text).toContain('corrupt')
    expect(text).toContain('corruption markers')
    expect(text).toContain('cgc index . --force')
    expect(text).toContain('/cgc index --force')
  })

  it('dispatches warningInputFor onto the right builder via buildWarningText', () => {
    expect(
      buildWarningText({ condition: 'cgc-missing', cwd: '/repo', detail: 'probe failed' }),
    ).toContain('PATH')
    expect(buildWarningText({ condition: 'busy', cwd: '/repo', detail: '' })).toContain('busy')
    expect(buildWarningText({ condition: 'corrupt', cwd: '/repo', detail: '' })).toContain(
      'rebuild',
    )
    expect(buildWarningText({ condition: 'unindexed', cwd: '/repo', detail: '' })).toContain(
      'autoCreate',
    )
  })
})

describe('warningInputFor (snapshot -> warning input)', () => {
  it('prefers the classification reason and falls back to the last action detail', () => {
    const store = new LifecycleStateStore()
    store.recordClassification(
      classification('/repo', 'busy', Date.now(), 'another CGC process holds the database'),
    )
    const busy = store.snapshot('/repo')
    if (busy === null) throw new Error('fixture snapshot missing')
    expect(warningInputFor(busy)).toEqual({
      condition: 'busy',
      cwd: '/repo',
      detail: 'another CGC process holds the database',
    })

    // No classification reason: the last recorded action's detail fills in.
    const fallback = new LifecycleStateStore()
    fallback.recordClassification(classification('/repo', 'busy', Date.now(), ''))
    fallback.recordAction({
      kind: 'busy-skipped',
      cwd: '/repo',
      detail: 'maintenance skipped as busy (lock conflict)',
    })
    const noReason = fallback.snapshot('/repo')
    if (noReason === null) throw new Error('fixture snapshot missing')
    expect(warningInputFor(noReason)?.detail).toBe('maintenance skipped as busy (lock conflict)')
  })

  it('returns null for states without a warning condition', () => {
    expect(warningInputFor(snapshotFor('/repo', 'clean'))).toBeNull()
    expect(warningInputFor(snapshotFor('/repo', 'drift'))).toBeNull()
  })
})

describe('WarningSet (per-session dedup)', () => {
  it('allows each condition once and then stays silent; independent conditions are unaffected', () => {
    const set = new WarningSet()
    expect(set.shouldSurface('corrupt')).toBe(true)
    set.mark('corrupt')
    expect(set.shouldSurface('corrupt')).toBe(false)
    expect(set.surfaced()).toEqual(['corrupt'])
    expect(set.shouldSurface('busy')).toBe(true)
    set.mark('busy')
    expect(set.surfaced()).toEqual(['corrupt', 'busy'])
    expect(set.shouldSurface('busy')).toBe(false)
  })

  it('resets between sessions', () => {
    const set = new WarningSet()
    set.mark('unindexed')
    set.mark('cgc-missing')
    set.reset()
    expect(set.surfaced()).toEqual([])
    expect(set.shouldSurface('unindexed')).toBe(true)
    expect(set.shouldSurface('cgc-missing')).toBe(true)
  })
})

describe('StatusHud one-time warnings (task 1.4)', () => {
  it('surfaces each condition once through the session notice surface', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, noticeCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)

    store.recordClassification(classification('/repo', 'unavailable'))
    await sleep(30)
    expect(noticeCalls).toHaveLength(1)
    expect(noticeCalls.at(0)?.severity).toBe('warning')
    expect(noticeCalls.at(0)?.text).toContain('unavailable')

    // Same condition again (re-emission, then re-entry): silent.
    store.recordAction({ kind: 'unavailable-notice', cwd: '/repo', detail: 'again' })
    store.recordClassification(classification('/repo', 'unavailable'))
    await sleep(30)
    expect(noticeCalls).toHaveLength(1)

    // A different condition surfaces on top.
    store.recordClassification(classification('/repo', 'unindexed'))
    await sleep(30)
    expect(noticeCalls).toHaveLength(2)
    expect(noticeCalls.at(1)?.text).toContain('autoCreate')

    // Re-entering an already shown condition stays silent.
    store.recordClassification(classification('/repo', 'unavailable'))
    store.recordClassification(classification('/repo', 'busy'))
    store.recordClassification(classification('/repo', 'unavailable'))
    await sleep(30)
    expect(noticeCalls).toHaveLength(3)
    expect(noticeCalls.at(2)?.text).toContain('busy')
  })

  // Task 2.2: the once-per-session warning matrix, structural like the 2.1
  // chip matrix. For EVERY condition — first occurrence surfaces exactly one
  // warning notice carrying the spec-hinted content; re-emitting the same
  // record stays silent (the store fires on every record, so this silence is
  // the WarningSet, not the chip's dedupe); TRUE re-entry (leave to a
  // healthy state, then return) stays silent; and the set is per-condition —
  // a different condition still surfaces afterward.
  it('pins the once-per-session matrix: every condition surfaces once; re-emission and true re-entry are silent', async () => {
    for (const { condition, state, contains } of WARNING_MATRIX) {
      const store = new LifecycleStateStore()
      const { sessionStart, noticeCalls } = makeHarness(() => store)
      sessionStart('/repo')
      await sleep(30)

      // First occurrence: exactly one warning notice, spec-hinted content.
      store.recordClassification(classification('/repo', state))
      await sleep(30)
      expect(noticeCalls).toHaveLength(1)
      expect(noticeCalls.at(0)?.severity).toBe('warning')
      expect(noticeCalls.at(0)?.text).toContain(contains)

      // Re-emission of the same record: silent.
      store.recordClassification(classification('/repo', state))
      await sleep(30)
      expect(noticeCalls).toHaveLength(1)

      // True re-entry: leave to a healthy state, then return — silent.
      store.recordClassification(classification('/repo', 'clean'))
      await sleep(30)
      store.recordClassification(classification('/repo', state))
      await sleep(30)
      expect(noticeCalls).toHaveLength(1)

      // Per-condition set: a DIFFERENT condition still surfaces afterward.
      store.recordClassification(classification('/repo', otherWarningState(condition)))
      await sleep(30)
      expect(noticeCalls).toHaveLength(2)
    }
  })

  // Task 2.2 (spec "at session start" scenarios): a condition the store
  // already holds when the display activates surfaces exactly once from the
  // activation snapshot; later emissions of the same record stay silent.
  it('warns exactly once for each condition already recorded at session start', async () => {
    for (const { state, contains } of WARNING_MATRIX) {
      const store = new LifecycleStateStore()
      store.recordClassification(classification('/repo', state))
      const { sessionStart, noticeCalls } = makeHarness(() => store)

      sessionStart('/repo')
      await sleep(30)
      expect(noticeCalls).toHaveLength(1)
      expect(noticeCalls.at(0)?.severity).toBe('warning')
      expect(noticeCalls.at(0)?.text).toContain(contains)

      // The same condition re-emitted after activation: silent for the session.
      store.recordClassification(classification('/repo', state))
      await sleep(30)
      expect(noticeCalls).toHaveLength(1)
    }
  })

  it('names the busy lock conflict and points the corrupt warning at the rebuild path', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, noticeCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)

    store.recordClassification(
      classification(
        '/repo',
        'busy',
        Date.now(),
        'another CGC process holds the embedded database',
      ),
    )
    await sleep(30)
    expect(noticeCalls).toHaveLength(1)
    expect(noticeCalls.at(0)?.text).toContain('another CGC process holds the embedded database')

    store.recordClassification(
      classification(
        '/repo',
        'corrupt',
        Date.now(),
        'index health probe reported corruption markers',
      ),
    )
    await sleep(30)
    expect(noticeCalls).toHaveLength(2)
    expect(noticeCalls.at(1)?.text).toContain('corruption markers')
    expect(noticeCalls.at(1)?.text).toContain('cgc index . --force')
  })

  it('never warns for the healthy pair, activity states, or untouched records', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, noticeCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)
    expect(noticeCalls).toEqual([])

    store.recordClassification(classification('/repo', 'clean'))
    store.recordClassification(classification('/repo', 'drift'))
    store.recordAction({ kind: 'indexing-started', cwd: '/repo', detail: 'start' })
    await sleep(30)
    expect(noticeCalls).toEqual([])
  })

  it('is silent without a notify surface', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, noticeCalls } = makeHarness(() => store)

    sessionStart('/repo', { ui: { setStatus: () => undefined } })
    await sleep(30)
    store.recordClassification(classification('/repo', 'corrupt'))
    await sleep(30)
    expect(noticeCalls).toEqual([])
  })

  it('is TUI-only: no notices in non-TUI modes (design D4)', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, noticeCalls } = makeHarness(() => store)

    sessionStart('/repo', { mode: 'rpc' })
    await sleep(30)
    store.recordClassification(classification('/repo', 'corrupt'))
    store.recordClassification(classification('/repo', 'busy'))
    await sleep(30)
    expect(noticeCalls).toEqual([])
  })

  it('resets the warning set at session shutdown; a fresh session may re-warn', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, sessionShutdown, noticeCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)
    store.recordClassification(classification('/repo', 'unindexed'))
    await sleep(30)
    expect(noticeCalls).toHaveLength(1)

    sessionShutdown()
    sessionStart('/repo')
    await sleep(30)
    store.recordClassification(classification('/repo', 'unindexed'))
    await sleep(30)
    expect(noticeCalls).toHaveLength(2)
  })

  it('scopes warnings to the active session workspace', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, noticeCalls } = makeHarness(() => store)

    sessionStart('/repo')
    await sleep(30)

    store.recordClassification(classification('/other', 'corrupt'))
    await sleep(30)
    expect(noticeCalls).toEqual([])

    store.recordClassification(classification('/repo', 'corrupt'))
    await sleep(30)
    expect(noticeCalls).toHaveLength(1)
  })

  it('swallows a rejecting notice surface, one attempt per condition', async () => {
    const store = new LifecycleStateStore()
    let attempts = 0
    const { sessionStart } = makeHarness(() => store, {
      notify: (_message: string) => {
        attempts += 1
        throw new Error('notice surface exploded')
      },
    })

    sessionStart('/repo')
    await sleep(30)
    store.recordClassification(classification('/repo', 'corrupt'))
    await sleep(30)
    expect(attempts).toBe(1)

    // Re-emission / re-entry of the same condition: no re-attempt.
    store.recordClassification(classification('/repo', 'corrupt'))
    await sleep(30)
    expect(attempts).toBe(1)

    // A genuinely new condition gets exactly one new attempt.
    store.recordClassification(classification('/repo', 'busy'))
    await sleep(30)
    expect(attempts).toBe(2)

    // The store dispatch survives a rejecting notice surface.
    expect(() => store.recordClassification(classification('/repo', 'clean'))).not.toThrow()
    expect(store.snapshot('/repo')?.state).toBe('clean')
  })
})

// ---------------------------------------------------------------------------
// Headless / non-TUI gating (task 1.5, design D4): outside a TUI session
// (`ctx.mode !== "tui"`) the display module fully deactivates — no chip
// rendering, no notice emissions, and (strongest form) no store subscription
// at all, so no rendering work happens in headless operation.
// ---------------------------------------------------------------------------

describe('StatusHud headless gating (task 1.5, design D4)', () => {
  it('deactivates entirely in every non-TUI mode: no chip, no notices', async () => {
    for (const mode of ['rpc', 'json', 'print']) {
      const store = new LifecycleStateStore()
      const { hud, sessionStart, chipCalls, noticeCalls } = makeHarness(() => store)

      sessionStart('/repo', { mode })
      await sleep(30)
      expect(hud.currentSessionMode()).toBe(mode)

      // Lifecycle transitions — including warning conditions — render and
      // notify nothing: the module is inactive for the whole session.
      store.recordClassification(classification('/repo', 'unavailable'))
      store.recordClassification(classification('/repo', 'corrupt'))
      store.recordClassification(classification('/repo', 'busy'))
      await sleep(30)
      expect(chipCalls).toEqual([])
      expect(noticeCalls).toEqual([])
    }
  })

  it('treats a missing session mode as non-TUI (headless-safe default)', () => {
    const store = new LifecycleStateStore()
    const { handlers, chipCalls, noticeCalls } = makeHarness(() => store)
    const sessionStart = handlers.get('session_start') as (event: unknown, ctx: unknown) => unknown

    // A host that omits `mode` is not a TUI session (D4): the HUD must not
    // assume the UI surface is live just because cwd is present.
    expect(() => sessionStart({ type: 'session_start' }, { cwd: '/repo' })).not.toThrow()
    store.recordClassification(classification('/repo', 'corrupt'))
    expect(chipCalls).toEqual([])
    expect(noticeCalls).toEqual([])
  })

  it('never subscribes to the lifecycle or freshness stores in headless sessions', async () => {
    let lifecycleSubscribes = 0
    let freshnessSubscribes = 0
    const store = new LifecycleStateStore()
    const freshnessStore = makeFreshnessStore()
    const wrappedLifecycle: StatusHudStore = {
      subscribe(listener) {
        lifecycleSubscribes += 1
        return store.subscribe(listener)
      },
      snapshot(cwd) {
        return store.snapshot(cwd)
      },
    }
    const wrappedFreshness: FreshnessHudStore = {
      subscribe(listener) {
        freshnessSubscribes += 1
        freshnessStore.subscribers.add(listener)
        return () => {
          freshnessStore.subscribers.delete(listener)
        }
      },
      snapshot(queried) {
        return freshnessStore.records.get(queried) ?? null
      },
    }
    const { sessionStart, chipCalls, noticeCalls } = makeHarness(() => wrappedLifecycle, {
      freshnessFor: () => wrappedFreshness,
    })

    sessionStart('/repo', { mode: 'rpc' })
    await sleep(30)
    emitFreshness(freshnessStore, freshnessSummary('/repo', 'possibly-stale'))
    store.recordClassification(classification('/repo', 'corrupt'))
    await sleep(30)

    // No subscriptions means no emissions, means no rendering work at all
    // (spec: "the display performs no rendering work and nothing in the
    // agent loop changes" — strongest form).
    expect(lifecycleSubscribes).toBe(0)
    expect(freshnessSubscribes).toBe(0)
    expect(chipCalls).toEqual([])
    expect(noticeCalls).toEqual([])
  })

  it('performs no store work at all headless: no resolve, subscribe, or snapshot (spec: "no rendering work")', async () => {
    let lifecycleResolves = 0
    let lifecycleSubscribes = 0
    let lifecycleSnapshots = 0
    let freshnessResolves = 0
    let freshnessSubscribes = 0
    let freshnessSnapshots = 0
    const store = new LifecycleStateStore()
    const freshnessStore = makeFreshnessStore()
    // Both stores already hold the exact records a TUI session would render
    // at start-up — the strongest possible leak for a headless session.
    store.recordClassification(classification('/repo', 'corrupt'))
    freshnessStore.records.set('/repo', freshnessSummary('/repo', 'possibly-stale'))

    const wrappedLifecycle: StatusHudStore = {
      subscribe(listener) {
        lifecycleSubscribes += 1
        return store.subscribe(listener)
      },
      snapshot(cwd) {
        lifecycleSnapshots += 1
        return store.snapshot(cwd)
      },
    }
    const wrappedFreshness: FreshnessHudStore = {
      subscribe(listener) {
        freshnessSubscribes += 1
        freshnessStore.subscribers.add(listener)
        return () => {
          freshnessStore.subscribers.delete(listener)
        }
      },
      snapshot(queried) {
        freshnessSnapshots += 1
        return freshnessStore.records.get(queried) ?? null
      },
    }
    const { sessionStart, chipCalls, noticeCalls } = makeHarness(
      (_cwd: string) => {
        lifecycleResolves += 1
        return wrappedLifecycle
      },
      {
        freshnessFor: (_cwd: string) => {
          freshnessResolves += 1
          return wrappedFreshness
        },
      },
    )

    sessionStart('/repo', { mode: 'rpc' })
    await sleep(30)

    // A TUI session would resolve BOTH stores, subscribe to each, read the
    // initial snapshot+marker, and render. Headless, the display performs no
    // store interaction at all — no resolve, no subscribe, no snapshot, no
    // render, no notice: a complete no-op ("the display performs no
    // rendering work and nothing in the agent loop changes").
    expect(lifecycleResolves).toBe(0)
    expect(lifecycleSubscribes).toBe(0)
    expect(lifecycleSnapshots).toBe(0)
    expect(freshnessResolves).toBe(0)
    expect(freshnessSubscribes).toBe(0)
    expect(freshnessSnapshots).toBe(0)
    expect(chipCalls).toEqual([])
    expect(noticeCalls).toEqual([])
  })

  it('is per-session: a headless session deactivates only that session; the next TUI session renders', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, sessionShutdown, chipCalls, noticeCalls } = makeHarness(() => store)

    sessionStart('/repo', { mode: 'rpc' })
    await sleep(30)
    store.recordClassification(classification('/repo', 'corrupt'))
    await sleep(30)
    expect(chipCalls).toEqual([])
    expect(noticeCalls).toEqual([])

    sessionShutdown()

    // A fresh TUI session re-activates the module: the store's record from
    // the headless session is visible (lifecycle data is session-agnostic),
    // proving the deactivation is scoped to the headless session.
    sessionStart('/repo')
    await sleep(30)
    expect(chipCalls).toEqual([{ key: STATUS_KEY, text: 'corrupt' }])

    store.recordClassification(classification('/repo', 'clean'))
    await sleep(30)
    expect(chipCalls).toEqual([
      { key: STATUS_KEY, text: 'corrupt' },
      { key: STATUS_KEY, text: 'ready' },
    ])
    // The TUI session is a fresh warning session: the corrupt condition
    // (previously silent in headless) surfaces exactly once here — proving
    // the deactivation was scoped to the headless session, both ways.
    expect(noticeCalls).toHaveLength(1)
    expect(noticeCalls.at(0)?.severity).toBe('warning')
    expect(noticeCalls.at(0)?.text).toContain('corrupt')
  })
})

// ---------------------------------------------------------------------------
// Task 1.6 (design D3): the passive boundary, enforced STRUCTURALLY. Three
// assertions make "the display cannot cause invocations" a property of the
// module rather than a convention (design risk: "Display code accidentally
// grows spawns"):
//   1. SHAPE — the StatusHud instance and prototype expose no runner, spawn,
//      or poll capability: no `run` / `runner` / `spawn` / `poll` members and
//      no `runnerFor` option seam (mirrors CleanPath's structural assertion
//      in clean.test.ts).
//   2. SOURCE LINT — the module references no runner and imports none of the
//      spawn/poll primitives: no `from './runner'`, no `child_process`, no
//      `spawn(` / `exec(` / `fork(` call sites, no `setInterval(`. The ONLY
//      timer in the module is the one-shot debounce `setTimeout(` — exactly
//      one call site; a polling loop would be a `setInterval` or a
//      re-arming `setTimeout` chain, both rejected here.
//   3. BEHAVIOR — with no store emissions the debounce fires once and the HUD
//      goes silent: the timer never re-arms itself, so renders happen
//      strictly in response to state changes (spec: "MUST NOT poll on a
//      timer").
// ---------------------------------------------------------------------------

describe('StatusHud passive boundary (task 1.6, design D3): no runner reference, no spawn, no polling loop', () => {
  it('exposes no runner, spawn, or poll capability on the instance or prototype', () => {
    const hud = new StatusHud({ storeFor: () => null })
    const spawnCapabilityNames: readonly string[] = ['run', 'runner', 'spawn', 'poll', 'runnerFor']
    for (const name of spawnCapabilityNames) {
      expect((hud as unknown as Record<string, unknown>)[name]).toBeUndefined()
      expect(name in StatusHud.prototype).toBe(false)
    }
    // The only seams a host can hand the HUD are the session hooks, the two
    // store accessors, and the debounce window (see StatusHudOptions) — there
    // is no slot through which a spawn capability could be injected, so
    // "no runner reference" holds by construction.
  })

  it('module source references no runner and contains no spawn or poll primitive (lint assertion)', () => {
    // Read the module source fresh: this is a STRUCTURAL guard over the file
    // itself, not over a compiled snapshot.
    const source = readFileSync(new URL('./status-hud.ts', import.meta.url), 'utf8')

    // No runner reference: the runner module is never imported, no runner
    // option or member is declared (`runnerFor`, `runner:` / `runner?:`).
    expect(source).not.toMatch(/from ['"]\.\/runner['"]/)
    expect(source).not.toContain('runnerFor')
    expect(source).not.toMatch(/runner\??\s*:/)

    // No spawn primitive: the spawn-capable `child_process` module is not
    // imported and no spawn/exec/fork call site exists. (Comments MAY say
    // "never spawns" — call sites are what the guard rejects.)
    expect(source).not.toContain('child_process')
    expect(source).not.toMatch(/spawn\(/)
    expect(source).not.toMatch(/\bexec\(/)
    expect(source).not.toMatch(/\bfork\(/)

    // No poll primitive: `setInterval` is the polling timer; `setTimeout` is
    // permitted only as the exactly-one one-shot debounce. Any second timer
    // would need a deliberate design decision, and a polling loop would
    // re-arm it (asserted behaviorally below).
    expect(source).not.toMatch(/setInterval\(/)
    expect(source.match(/setTimeout\(/g)).toHaveLength(1)
  })

  it('never polls: the debounce fires once and the HUD stays silent between emissions', async () => {
    const store = new LifecycleStateStore()
    const { sessionStart, chipCalls } = makeHarness(() => store, { debounceMs: 5 })

    sessionStart('/repo')
    // Far past several debounce windows: the session-start render happened
    // exactly once and the one-shot timer did NOT re-arm itself — no
    // emissions, no renders.
    await sleep(120)
    expect(chipCalls).toEqual([{ key: STATUS_KEY, text: undefined }])

    // A state change renders exactly once, then silence again (spec: the
    // chip updates FROM the state change, never on a timer).
    store.recordClassification(classification('/repo', 'clean'))
    await sleep(120)
    expect(chipCalls).toEqual([
      { key: STATUS_KEY, text: undefined },
      { key: STATUS_KEY, text: 'ready' },
    ])
  })
})

// ---------------------------------------------------------------------------
// Task 2.4 — spec scenario "Agent context unaffected" (requirement
// Human-facing only): the display's ONLY outputs are the TUI chip and the
// session notice surface. NOTHING the display does may land in the agent's
// context or prompt. Two guards: (1) a Proxy canary over the session context
// handed to the hooks proves the HUD's whole session-context surface is
// read-only and bounded to { cwd, mode, ui -> { setStatus, notify } } — any
// future regression that writes display content into the session state fires
// the set-trap even though the HUD is fail-open, so the guard cannot go
// silent; (2) a source guard proves the module holds no reference to the
// repo's agent-context channels (the gate's runner context resolver and the
// before_agent_start system-prompt mechanism).
// ---------------------------------------------------------------------------

describe('StatusHud human-facing only (spec "Agent context unaffected")', () => {
  it('registers only the two session hooks and never writes to the session context (read-only canary)', async () => {
    const store = new LifecycleStateStore()
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const chipCalls: ChipCall[] = []
    const noticeCalls: NoticeCall[] = []
    const hud = new StatusHud({
      storeFor: () => store,
      api: {
        on(event: 'session_start' | 'session_shutdown', handler): unknown {
          handlers.set(event, handler)
          return undefined
        },
      },
      debounceMs: 5,
    })
    hud.register()

    // The display registers EXACTLY the two session hooks — the Pi seams
    // that could inject content into the agent's context (a
    // before_agent_start prompt hook, a context resolver, …) are absent by
    // construction: the seam type offers nothing else to register on.
    expect([...handlers.keys()].sort()).toEqual(['session_shutdown', 'session_start'])

    // Proxy canary over the session context passed to the hook: every read
    // is recorded, and ANY write attempt is trapped. The HUD must leave the
    // context object pristine — a write here would be display content
    // entering the agent's session state (the exact prohibition in the
    // "Human-facing only" requirement).
    const ctxReads: string[] = []
    const uiReads: string[] = []
    const ctxWrites: string[] = []
    const uiWrites: string[] = []
    const uiProxy = new Proxy(
      {
        setStatus(key: string, text: string | undefined) {
          chipCalls.push({ key, text })
        },
        notify(message: string, severity: NoticeSeverity) {
          noticeCalls.push({ severity, text: message })
        },
      },
      {
        get(target, key) {
          uiReads.push(`ui.${String(key)}`)
          return Reflect.get(target, key)
        },
        set(target, key, value) {
          uiWrites.push(`ui.${String(key)}`)
          return Reflect.set(target, key, value)
        },
      },
    )
    const ctxProxy = new Proxy(
      { cwd: '/repo', mode: 'tui', ui: uiProxy },
      {
        get(target, key) {
          ctxReads.push(String(key))
          return Reflect.get(target, key)
        },
        set(target, key, value) {
          ctxWrites.push(String(key))
          return Reflect.set(target, key, value)
        },
      },
    )

    const sessionStart = handlers.get('session_start')
    if (sessionStart === undefined) throw new Error('session_start handler missing')
    sessionStart({ type: 'session_start' }, ctxProxy)
    await sleep(30)

    // Drive the COMPLETE display lifecycle through the real store: every
    // terminal state (so all four one-time warnings surface through the
    // notice surface), then an activity burst. The canary therefore observes
    // a fully active display session — not an empty one.
    for (const state of ['unavailable', 'unindexed', 'busy', 'corrupt', 'clean'] as const) {
      store.recordClassification(classification('/repo', state))
    }
    await sleep(30)
    store.recordAction({ kind: 'indexing-started', cwd: '/repo', detail: 'start' })
    await sleep(30)
    store.recordAction({ kind: 'indexing-settled', cwd: '/repo', detail: 'settled' })
    await sleep(30)

    // Sanity: the display WAS active — the chip rendered throughout and
    // settled on "ready", and all four conditions surfaced exactly one
    // warning each.
    expect(chipCalls.length).toBeGreaterThan(0)
    expect(chipCalls.at(-1)?.text).toBe('ready')
    expect(noticeCalls).toHaveLength(4)
    expect(noticeCalls.map((n) => n.severity)).toEqual(['warning', 'warning', 'warning', 'warning'])

    // The session context is never written — not once, not even a
    // bookkeeping field — and the read surface is exactly the bounded set
    // the seam declares: ctx.cwd / ctx.mode / ctx.ui, and on the UI object
    // setStatus / notify. (Sets, not counts: the module may legitimately
    // read the same field several times while narrowing it — e.g. typeof
    // guard plus final read.)
    expect(ctxWrites).toEqual([])
    expect(uiWrites).toEqual([])
    expect([...new Set(ctxReads)].sort()).toEqual(['cwd', 'mode', 'ui'])
    expect([...new Set(uiReads)].sort()).toEqual(['ui.notify', 'ui.setStatus'])
  })

  it('module source holds no reference to any agent-context channel (source guard)', () => {
    // The repo's agent-context channels — the gate's runner context resolver
    // (gate.ts: setContextResolver / WorktreeMap.contextFor) and the
    // before_agent_start system-prompt mechanism (index.ts) — never appear
    // in the display module. The passive-boundary guard already proves no
    // runner reference (so setContextResolver is unreachable); this closes
    // the context side: nothing the module references can feed the agent's
    // context or prompt.
    const source = readFileSync(new URL('./status-hud.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('setContextResolver')
    expect(source).not.toContain('contextFor')
    expect(source).not.toContain('before_agent_start')
    expect(source).not.toContain('addContext')
  })
})
