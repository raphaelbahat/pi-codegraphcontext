import { describe, expect, it } from 'bun:test'
import { FreshnessStateStore } from './freshness-state'
import type { FreshnessHudSummary } from './status-hud'

describe('FreshnessStateStore (task 1.2: subscribable freshness state)', () => {
  it('starts empty: unknown workspaces have no snapshot', () => {
    const store = new FreshnessStateStore()

    expect(store.snapshot('/repo')).toBeNull()
    expect(store.snapshots()).toEqual([])
  })

  it('records a fresh status as the first record, without a prior state', () => {
    const store = new FreshnessStateStore()
    const at = 1_700_000_000_000

    const snapshot = store.recordStatus({ cwd: '/repo', status: 'fresh', at })

    expect(snapshot.cwd).toBe('/repo')
    expect(snapshot.status).toBe('fresh')
    expect(snapshot.lastSyncedAt).toBe(at)
    expect(snapshot.staleSince).toBeNull()
    expect(snapshot.stateChangedAt).toBeNull() // first recorded status: nothing prior
    expect(snapshot.updatedAt).toBe(at)
  })

  it('marks possibly-stale on first observed edit; burst re-marks keep the first staleSince', () => {
    const store = new FreshnessStateStore()

    store.recordStatus({ cwd: '/repo', status: 'fresh', at: 1000 })
    store.recordStatus({ cwd: '/repo', status: 'possibly-stale', at: 2000 })
    const reMarked = store.recordStatus({ cwd: '/repo', status: 'possibly-stale', at: 3000 })

    expect(reMarked.status).toBe('possibly-stale')
    expect(reMarked.staleSince).toBe(2000) // first mark wins (burst debounce)
    expect(reMarked.stateChangedAt).toBe(2000)
    expect(reMarked.updatedAt).toBe(3000)
    expect(reMarked.lastSyncedAt).toBe(1000) // sync history persists while stale
  })

  it('walks the fresh -> possibly-stale -> syncing -> fresh cycle', () => {
    const store = new FreshnessStateStore()

    store.recordStatus({ cwd: '/repo', status: 'fresh', at: 1000 })
    store.recordStatus({ cwd: '/repo', status: 'possibly-stale', at: 2000 })

    const syncing = store.recordStatus({ cwd: '/repo', status: 'syncing', at: 2100 })
    expect(syncing.status).toBe('syncing')
    expect(syncing.staleSince).toBe(2000) // stays stale while syncing

    const fresh = store.recordStatus({ cwd: '/repo', status: 'fresh', at: 2500 })
    expect(fresh.status).toBe('fresh')
    expect(fresh.lastSyncedAt).toBe(2500)
    expect(fresh.staleSince).toBeNull() // stale episode ends only on a completed sync
    expect(fresh.stateChangedAt).toBe(2500)
  })

  it('records skipped-busy without losing the stale episode or sync history', () => {
    const store = new FreshnessStateStore()

    store.recordStatus({ cwd: '/repo', status: 'fresh', at: 1000 })
    store.recordStatus({ cwd: '/repo', status: 'possibly-stale', at: 2000 })
    const skipped = store.recordStatus({ cwd: '/repo', status: 'skipped-busy', at: 2200 })

    expect(skipped.status).toBe('skipped-busy')
    expect(skipped.lastSyncedAt).toBe(1000)
    expect(skipped.staleSince).toBe(2000) // a busy skip does not end the episode
    expect(skipped.stateChangedAt).toBe(2200)
  })

  it('records the disabled status (tracking explicitly off)', () => {
    const store = new FreshnessStateStore()

    const disabled = store.recordStatus({ cwd: '/repo', status: 'disabled', at: 500 })

    expect(disabled.status).toBe('disabled')
    expect(disabled.lastSyncedAt).toBeNull()
    expect(disabled.staleSince).toBeNull()
  })

  it('tracks workspaces independently', () => {
    const store = new FreshnessStateStore()

    store.recordStatus({ cwd: '/repo-a', status: 'fresh', at: 1 })
    store.recordStatus({ cwd: '/repo-b', status: 'possibly-stale', at: 2 })

    expect(store.snapshot('/repo-a')?.status).toBe('fresh')
    expect(store.snapshot('/repo-b')?.status).toBe('possibly-stale')
    expect(store.snapshots().length).toBe(2)
  })

  it('emits snapshots structurally compatible with the status-hud freshness seam', () => {
    const store = new FreshnessStateStore()

    const snapshot = store.recordStatus({ cwd: '/repo', status: 'possibly-stale', at: 1 })

    // FreshnessSnapshot is assignable to FreshnessHudSummary (extra fields
    // allowed) — the compile-time proof of the D5 read seam.
    const summary: FreshnessHudSummary = snapshot
    expect(summary.status).toBe('possibly-stale')
    expect(summary.lastSyncedAt).toBeNull()
    expect(summary.staleSince).toBe(1)
  })

  it('notifies subscribers on every record with the frozen snapshot', () => {
    const store = new FreshnessStateStore()
    const seen: string[] = []

    const unsubscribe = store.subscribe((snapshot) =>
      seen.push(`${snapshot.cwd}:${snapshot.status}`),
    )
    store.recordStatus({ cwd: '/repo', status: 'fresh', at: 1 })
    store.recordStatus({ cwd: '/repo', status: 'possibly-stale', at: 2 })
    unsubscribe()
    store.recordStatus({ cwd: '/repo', status: 'syncing', at: 3 })

    expect(seen).toEqual(['/repo:fresh', '/repo:possibly-stale'])
  })

  it('a throwing listener never breaks recording (fail-open)', () => {
    const store = new FreshnessStateStore()
    store.subscribe(() => {
      throw new Error('broken renderer')
    })

    expect(() => store.recordStatus({ cwd: '/repo', status: 'possibly-stale' })).not.toThrow()
    expect(store.snapshot('/repo')?.status).toBe('possibly-stale')
  })

  it('snapshots are frozen copies: mutating them cannot corrupt the store', () => {
    const store = new FreshnessStateStore()
    const snapshot = store.recordStatus({ cwd: '/repo', status: 'possibly-stale', at: 1 })

    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(() => {
      ;(snapshot as { status?: string }).status = 'fresh'
    }).toThrow()
    expect(store.snapshot('/repo')?.status).toBe('possibly-stale')
  })

  it('resets all workspaces and listeners (session shutdown / fresh session)', () => {
    const store = new FreshnessStateStore()
    let notified = 0
    store.subscribe(() => {
      notified += 1
    })

    store.recordStatus({ cwd: '/repo', status: 'fresh', at: 1 })
    store.reset()

    expect(store.snapshot('/repo')).toBeNull()
    expect(store.snapshots()).toEqual([])
    store.recordStatus({ cwd: '/repo', status: 'disabled', at: 2 })
    expect(notified).toBe(1)
  })

  it('never throws for any input the freshness module can produce', () => {
    const store = new FreshnessStateStore()

    expect(() => store.recordStatus({ cwd: '', status: 'fresh' })).not.toThrow()
    expect(() =>
      store.recordStatus({ cwd: '/spaces and \n weird', status: 'possibly-stale', at: 0 }),
    ).not.toThrow()
    expect(() => store.recordStatus({ cwd: '/repo', status: 'skipped-busy' })).not.toThrow()
  })

  it('records an error without touching status or episode timestamps, clearing on the next fresh', () => {
    const store = new FreshnessStateStore()

    store.recordStatus({ cwd: '/repo', status: 'possibly-stale', at: 1000 })
    const errored = store.recordError({
      cwd: '/repo',
      message: 'background sync failed: boom',
      at: 2000,
    })

    expect(errored.status).toBe('possibly-stale') // the status stays the operative signal
    expect(errored.lastError).toBe('background sync failed: boom')
    expect(errored.staleSince).toBe(1000) // episode timestamps untouched
    expect(errored.lastSyncedAt).toBeNull()
    expect(errored.stateChangedAt).toBeNull() // no status change
    expect(errored.updatedAt).toBe(2000)

    const fresh = store.recordStatus({ cwd: '/repo', status: 'fresh', at: 3000 })
    expect(fresh.lastError).toBeNull() // a completed sync resolves the error
    expect(fresh.status).toBe('fresh')
  })

  it('recordError creates the entry on demand and never sets lastError elsewhere', () => {
    const store = new FreshnessStateStore()

    const errored = store.recordError({ cwd: '/repo-a', message: 'watcher start failed', at: 1 })

    expect(errored.status).toBe('fresh') // no status was recorded yet
    expect(errored.lastError).toBe('watcher start failed')
    expect(store.snapshot('/repo-a')?.lastError).toBe('watcher start failed')
    expect(store.snapshot('/repo-b')).toBeNull() // untouched workspace
  })

  it('emits recorded errors to subscribers like any record (consumers dedupe)', () => {
    const store = new FreshnessStateStore()
    const seen: string[] = []
    store.subscribe((snapshot) => seen.push(`${snapshot.status}/${snapshot.lastError ?? 'none'}`))

    store.recordError({ cwd: '/repo', message: 'boom' })
    store.recordStatus({ cwd: '/repo', status: 'fresh' })

    expect(seen).toEqual(['fresh/boom', 'fresh/none'])
  })

  it('reset() clears recorded errors with the session (no cross-session leak)', () => {
    const store = new FreshnessStateStore()
    store.recordError({ cwd: '/repo', message: 'boom' })
    store.reset()

    expect(store.snapshot('/repo')).toBeNull()
  })
})
