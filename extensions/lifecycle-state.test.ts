import { describe, expect, it } from 'bun:test'
import type { LifecycleClassification, LifecycleState } from './classifier'
import { LifecycleStateStore } from './lifecycle-state'

/** Build a minimal classification the way classifier.ts produces them. */
function classification(
  cwd: string,
  state: LifecycleState,
  at = Date.now(),
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
    reason: `classified as ${state}`,
    at,
  }
}

describe('LifecycleStateStore (task 3.1: internal state exposure)', () => {
  it('starts empty: unknown workspaces have no snapshot', () => {
    const store = new LifecycleStateStore()

    expect(store.snapshot('/repo')).toBeNull()
    expect(store.snapshots()).toEqual([])
  })

  it('exposes workspace path, state, and timestamps from a classification', () => {
    const store = new LifecycleStateStore()
    const at = 1_700_000_000_000

    const snapshot = store.recordClassification(classification('/repo', 'clean', at))

    expect(snapshot.cwd).toBe('/repo')
    expect(snapshot.state).toBe('clean')
    expect(snapshot.reason).toBe('classified as clean')
    expect(snapshot.classifiedAt).toBe(at)
    expect(snapshot.stateChangedAt).toBe(at)
    expect(snapshot.indexed).toBe(true)
    expect(snapshot.activity).toBe('idle')
    expect(snapshot.lastAction?.kind).toBe('classified')
  })

  it('reports null state before any classification, but still records actions', () => {
    const store = new LifecycleStateStore()

    const snapshot = store.recordAction({
      kind: 'busy-skipped',
      cwd: '/repo',
      detail: 'another CGC process holds the database',
    })

    expect(snapshot.state).toBeNull()
    expect(snapshot.classifiedAt).toBeNull()
    expect(snapshot.lastAction?.kind).toBe('busy-skipped')
    expect(snapshot.lastAction?.ok).toBeNull()
    expect(snapshot.updatedAt).toBeGreaterThan(0)
  })

  it('tracks state transitions with stateChangedAt only on change', () => {
    const store = new LifecycleStateStore()

    store.recordClassification(classification('/repo', 'drift', 1000))
    store.recordClassification(classification('/repo', 'clean', 2000))
    const unchanged = store.recordClassification(classification('/repo', 'clean', 3000))

    expect(store.snapshot('/repo')?.stateChangedAt).toBe(2000)
    expect(store.snapshot('/repo')?.classifiedAt).toBe(3000)
    expect(unchanged.state).toBe('clean')
  })

  it('derives activity from start/settle action pairs', () => {
    const store = new LifecycleStateStore()

    store.recordAction({ kind: 'drift-sync-started', cwd: '/repo', detail: 'sync running' })
    expect(store.snapshot('/repo')?.activity).toBe('syncing')

    store.recordAction({ kind: 'drift-sync-settled', cwd: '/repo', detail: 'sync done', ok: true })
    expect(store.snapshot('/repo')?.activity).toBe('idle')

    store.recordAction({ kind: 'indexing-started', cwd: '/repo', detail: 'indexing' })
    expect(store.snapshot('/repo')?.activity).toBe('indexing')

    store.recordAction({ kind: 'indexing-settled', cwd: '/repo', detail: 'done', ok: true })
    expect(store.snapshot('/repo')?.activity).toBe('idle')

    store.recordAction({ kind: 'rebuild-started', cwd: '/repo', detail: 'rebuilding' })
    expect(store.snapshot('/repo')?.activity).toBe('rebuilding')

    store.recordAction({ kind: 'rebuild-settled', cwd: '/repo', detail: 'done', ok: true })
    expect(store.snapshot('/repo')?.activity).toBe('idle')
  })

  it('keeps the last action as the newest recorded entry', () => {
    const store = new LifecycleStateStore()

    store.recordAction({ kind: 'corrupt-notice', cwd: '/repo', detail: 'corrupt' })
    store.recordAction({ kind: 'clean-skipped', cwd: '/repo', detail: 'nothing to do' })

    expect(store.snapshot('/repo')?.lastAction?.kind).toBe('clean-skipped')
    expect(store.snapshot('/repo')?.actions.map((action) => action.kind)).toEqual([
      'corrupt-notice',
      'clean-skipped',
    ])
  })

  it('bounds the per-workspace action log, dropping oldest first', () => {
    const store = new LifecycleStateStore({ maxActionsPerWorkspace: 2 })

    store.recordAction({ kind: 'unindexed-notice', cwd: '/repo', detail: '1' })
    store.recordAction({ kind: 'busy-skipped', cwd: '/repo', detail: '2' })
    store.recordAction({ kind: 'clean-skipped', cwd: '/repo', detail: '3' })

    const actions = store.snapshot('/repo')?.actions ?? []
    expect(actions.map((action) => action.detail)).toEqual(['2', '3'])
  })

  it('tracks workspaces independently', () => {
    const store = new LifecycleStateStore()

    store.recordClassification(classification('/repo-a', 'busy'))
    store.recordClassification(classification('/repo-b', 'unindexed'))

    expect(store.snapshot('/repo-a')?.state).toBe('busy')
    expect(store.snapshot('/repo-b')?.state).toBe('unindexed')
    expect(store.snapshots().length).toBe(2)
  })

  it('notifies subscribers on every change with the frozen snapshot', () => {
    const store = new LifecycleStateStore()
    const seen: string[] = []

    const unsubscribe = store.subscribe((snapshot) =>
      seen.push(`${snapshot.cwd}:${snapshot.state ?? 'null'}`),
    )
    store.recordClassification(classification('/repo', 'unindexed'))
    store.recordAction({ kind: 'unindexed-notice', cwd: '/repo', detail: 'notice shown' })
    unsubscribe()
    store.recordClassification(classification('/repo', 'clean'))

    expect(seen).toEqual(['/repo:unindexed', '/repo:unindexed'])
  })

  it('a throwing listener never breaks recording (fail-open)', () => {
    const store = new LifecycleStateStore()
    store.subscribe(() => {
      throw new Error('broken renderer')
    })

    expect(() => store.recordClassification(classification('/repo', 'clean'))).not.toThrow()
    expect(store.snapshot('/repo')?.state).toBe('clean')
  })

  it('snapshots are frozen copies: mutating them cannot corrupt the store', () => {
    const store = new LifecycleStateStore()
    const snapshot = store.recordClassification(classification('/repo', 'clean'))

    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.lastAction)).toBe(true)
    expect(() => {
      ;(snapshot as { state?: string }).state = 'corrupt'
    }).toThrow()
    expect(store.snapshot('/repo')?.state).toBe('clean')
  })

  it('resets all workspaces and listeners (session shutdown / fresh session)', () => {
    const store = new LifecycleStateStore()
    let notified = 0
    store.subscribe(() => {
      notified += 1
    })

    store.recordClassification(classification('/repo', 'clean'))
    store.reset()

    expect(store.snapshot('/repo')).toBeNull()
    expect(store.snapshots()).toEqual([])
    store.recordClassification(classification('/repo', 'busy'))
    expect(notified).toBe(1)
  })

  it('never throws for any input a gate can produce', () => {
    const store = new LifecycleStateStore()

    expect(() =>
      store.recordAction({ kind: 'custom-future-action', cwd: '', detail: '' }),
    ).not.toThrow()
    expect(() =>
      store.recordAction({ kind: 'x', cwd: '/spaces and \n weird', detail: 'ok', at: 0 }),
    ).not.toThrow()
    expect(() => store.recordClassification(classification('', 'unavailable'))).not.toThrow()
  })
})
