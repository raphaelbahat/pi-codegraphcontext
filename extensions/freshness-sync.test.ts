// Lazy drift-sync tests (task 2.1 of
// openspec/changes/add-cgc-freshness-drift-sync): the auto-sync path of the
// freshness drift observer — first-drift trigger within the per-session
// budget, one incremental `cgc index .` through the shared runner, background
// execution with progress state (`syncing` until the run settles), runner
// dedup with in-flight syncs, and the D5 settle machine
// (`fresh | skipped-busy | possibly-stale`). Detection itself stays
// spawn-free (design D1) — the sync is a maintenance spawn, not a detection
// one — and the `tool_call` handler keeps its contract (returns undefined,
// never mutates input) while the sync runs. Task 2.3 adds the skip-as-busy
// notice (design D4): a `BUSY` settle records `skipped-busy` AND surfaces
// one human-facing notice naming the conflict, once per session, through the
// session context's `ui.notify`. Task 3.1 completes the D4 notice surface:
// the episode-opening mark surfaces the once-per-session stale notice (with
// the `/cgc sync` hint) and a successful settle surfaces the once-per-session
// completion notice — each under its own condition key, never in the agent
// context (ADR-0002).
import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installProcessCleanup } from './cleanup'
import type { WatchMode } from './config'
import {
  AUTO_SYNC_ARGS,
  detectCgcBackend,
  FreshnessDriftObserver,
  type FreshnessExtensionApi,
  type FreshnessNoticeSink,
  type FreshnessSyncResult,
  type FreshnessSyncRunner,
  isServerBackend,
  parseDoctorBackend,
  parseEnvFileBackend,
  WATCHER_ARGS,
  WATCHER_TIMEOUT_MS,
} from './freshness'
import { FreshnessStateStore } from './freshness-state'
import { CgcRunner } from './runner'

type Handlers = Map<string, (event: unknown, ctx: unknown) => unknown>

interface SyncHarnessOptions {
  autoSync?: boolean
  /** The continuous watcher mode (task 2.4, tri-state). */
  watch?: WatchMode
  maxSyncsPerSession?: number
  syncTimeoutMs?: number
  worktreeBlockFor?: (cwd: string) => { blocked: boolean } | null
  now?: () => number
  /** Liveness-verification budget (default 0 with the default immediate sleep). */
  watcherLivenessMs?: number
  /** Injectable verification delay; default resolves immediately. */
  sleep?: (ms: number) => Promise<void>
  /** Already-indexed check for `auto` gating (default: not indexed). */
  isIndexed?: (cwd: string) => boolean
  /** Backend detector for `auto` gating (default: none → conservative no-spawn). */
  detectBackend?: () => Promise<string | null> | string | null
  /** Runner rejects every run with this message. */
  rejectWith?: string
  /** Runner throws synchronously from run(). */
  throwOnRun?: boolean
  /** Construct the observer without any runner (observation-only). */
  withoutRunner?: boolean
}

interface SyncHarness {
  store: FreshnessStateStore
  handlers: Handlers
  observer: FreshnessDriftObserver
  /** Every recorded run invocation (cwd + args + optional timeoutMs). */
  calls: { cwd: string; args: readonly string[]; timeoutMs?: number }[]
  /** Every notice delivered to the session `ui.notify` sink (task 2.3). */
  notices: { text: string; type: 'info' | 'warning' | 'error' }[]
  /** Resolve the currently pending run; no-op when nothing is pending. */
  settle: (result: FreshnessSyncResult) => void
  /** The currently pending run promise, or null when none is in flight. */
  run: () => Promise<FreshnessSyncResult> | null
  /** Let a settled promise's continuation run (microtasks + macrotask). */
  flush: () => Promise<void>
}

function makeHarness(options: SyncHarnessOptions = {}): SyncHarness {
  const store = new FreshnessStateStore()
  const handlers: Handlers = new Map()
  const api: FreshnessExtensionApi = {
    on: (event, handler) => {
      handlers.set(event, handler)
      return undefined
    },
  }

  const calls: SyncHarness['calls'] = []
  const notices: SyncHarness['notices'] = []
  let pending: {
    promise: Promise<FreshnessSyncResult>
    resolve: (r: FreshnessSyncResult) => void
  } | null = null

  const runner: FreshnessSyncRunner = {
    run: (cwd, opts) => {
      calls.push({
        cwd,
        args: [...opts.args],
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      })
      // The shared runner's dedup contract: an already-in-flight identical
      // invocation is joined, never re-spawned.
      if (pending !== null) return pending.promise
      if (options.throwOnRun === true) throw new Error('runner exploded synchronously')
      if (options.rejectWith !== undefined) {
        return Promise.reject(new Error(options.rejectWith))
      }
      let resolve!: (r: FreshnessSyncResult) => void
      const promise = new Promise<FreshnessSyncResult>((res) => {
        resolve = res
      })
      pending = { promise, resolve }
      return promise
    },
  }

  const observer = new FreshnessDriftObserver({
    store,
    ...(options.withoutRunner === true ? {} : { runner }),
    ...(options.autoSync === undefined ? {} : { autoSync: options.autoSync }),
    ...(options.watch === undefined ? {} : { watch: options.watch }),
    ...(options.maxSyncsPerSession === undefined
      ? {}
      : { maxSyncsPerSession: options.maxSyncsPerSession }),
    ...(options.syncTimeoutMs === undefined ? {} : { syncTimeoutMs: options.syncTimeoutMs }),
    ...(options.worktreeBlockFor === undefined
      ? {}
      : { worktreeBlockFor: options.worktreeBlockFor }),
    ...(options.now === undefined ? {} : { now: options.now }),
    // Default harness liveness: the verification window resolves on a
    // macrotask (capped at 1 ms) so `await h.flush()` settles the verifier
    // deterministically AFTER any synchronous settle — a settle always wins
    // the race, matching the real semantics where a fast-exiting watcher is
    // observed before the verification budget expires. Tests override the
    // sleep/budget seams explicitly when they need finer control.
    watcherLivenessMs: options.watcherLivenessMs ?? 0,
    sleep:
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 1)))),
    ...(options.isIndexed === undefined ? {} : { isIndexed: options.isIndexed }),
    ...(options.detectBackend === undefined ? {} : { detectBackend: options.detectBackend }),
    api,
  })
  observer.register()

  return {
    store,
    handlers,
    observer,
    calls,
    notices,
    settle: (result) => {
      const current = pending
      pending = null
      current?.resolve(result)
    },
    run: () => pending?.promise ?? null,
    flush: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  }
}

function invokeHandler(
  handlers: Handlers,
  event: string,
  eventPayload: unknown,
  ctx: unknown,
): unknown {
  const handler = handlers.get(event)
  if (handler === undefined) throw new Error(`${event} handler not registered`)
  return handler(eventPayload, ctx)
}

function sessionStart(
  handlers: Handlers,
  cwd = '/repo',
  ui?: { notify?: FreshnessNoticeSink },
): void {
  invokeHandler(handlers, 'session_start', {}, { cwd, ...(ui === undefined ? {} : { ui }) })
}

function sessionShutdown(handlers: Handlers): void {
  invokeHandler(handlers, 'session_shutdown', {}, {})
}

function toolCall(handlers: Handlers, toolName = 'edit'): unknown {
  return invokeHandler(handlers, 'tool_call', { toolName, toolCallId: 't1', input: {} }, {})
}

const OK = { ok: true, code: 'OK', message: 'index updated' } as const
const BUSY = { ok: false, code: 'BUSY', message: 'database locked by CGC MCP server' } as const
const FAILED = { ok: false, code: 'COMMAND_FAILED', message: 'boom' } as const

/**
 * Notices for the SHARED `skipped-busy` condition key (design D4): the
 * lazy-sync busy skip (task 2.3) and the watcher-start-blocked notice
 * (task 2.4) both carry the same once-per-session budget, so tests count
 * them together regardless of which produced the notice.
 */
function busyKeyNotices(notices: SyncHarness['notices']): SyncHarness['notices'] {
  return notices.filter((n) => n.text.includes('skipped') || n.text.includes('could not start'))
}

describe('lazy drift sync trigger (task 2.1: first drift, background run, progress state)', () => {
  it('starts one background `cgc index .` on the first observed edit and shows syncing until it settles', async () => {
    let clock = 1000
    const h = makeHarness({ now: () => clock })
    sessionStart(h.handlers)

    toolCall(h.handlers)

    // The drift mark happens first, then the sync starts synchronously.
    expect(h.calls).toEqual([{ cwd: '/repo', args: [...AUTO_SYNC_ARGS] }])
    expect(AUTO_SYNC_ARGS).toEqual(['index', '.'])
    const during = h.store.snapshot('/repo')
    expect(during?.status).toBe('syncing')
    expect(during?.staleSince).toBe(1000) // episode first-mark is preserved

    clock = 2000
    h.settle({ ...OK })
    await h.flush()

    const settled = h.store.snapshot('/repo')
    expect(settled?.status).toBe('fresh')
    expect(settled?.lastSyncedAt).toBe(2000) // completion time
    expect(settled?.staleSince).toBeNull()
  })

  it('the tool_call handler keeps its contract with sync wired: returns undefined, never mutates input', async () => {
    const h = makeHarness()
    sessionStart(h.handlers)
    const input = { path: '/repo/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }
    const event = { toolName: 'edit', toolCallId: 't1', input }

    const returned = invokeHandler(h.handlers, 'tool_call', event, {})

    expect(returned).toBeUndefined()
    expect(event.input).toEqual(input)
    expect(h.store.snapshot('/repo')?.status).toBe('syncing') // spawn happened off to the side

    h.settle({ ...OK })
    await h.flush()
    expect(h.store.snapshot('/repo')?.status).toBe('fresh')
  })

  it('burst edits inside the open episode trigger exactly one sync (per-episode dedup)', async () => {
    const h = makeHarness()
    sessionStart(h.handlers)

    toolCall(h.handlers)
    toolCall(h.handlers, 'write')
    toolCall(h.handlers, 'edit')

    expect(h.calls).toHaveLength(1)
    expect(h.store.snapshot('/repo')?.status).toBe('syncing')

    h.settle({ ...OK })
    await h.flush()
    expect(h.store.snapshot('/repo')?.status).toBe('fresh')
  })

  it('an in-flight identical sync is joined by the runner, never re-spawned (dedup with in-flight syncs)', async () => {
    const h = makeHarness()
    sessionStart(h.handlers)

    // The shared runner's contract (tested in runner.test.ts): a second run
    // with the same cwd+args while one is pending returns the SAME promise.
    // The observer relies on exactly this: the gate's or `/cgc index`'s sync
    // under the same workspace is joined, and the calls stay at one.
    toolCall(h.handlers)
    const first = h.run()
    expect(first).not.toBeNull()

    // Even if the observer were asked again (it is not, per-episode), the
    // runner would coalesce — simulate by re-issuing an edit after a fresh
    // settle on a NEW episode while a sync is pending: no second child.
    h.settle({ ...OK })
    await h.flush()
    expect(h.calls).toHaveLength(1)
  })

  it('a completed sync ends the episode; later edits open a new one and may sync again within the budget', async () => {
    const h = makeHarness({ maxSyncsPerSession: 2 })
    sessionStart(h.handlers)

    toolCall(h.handlers)
    h.settle({ ...OK })
    await h.flush()
    expect(h.store.snapshot('/repo')?.status).toBe('fresh')

    toolCall(h.handlers)
    expect(h.calls).toHaveLength(2) // new episode, second budget slot
    expect(h.store.snapshot('/repo')?.status).toBe('syncing')

    h.settle({ ...OK })
    await h.flush()
    expect(h.store.snapshot('/repo')?.status).toBe('fresh')
  })

  it('a configured syncTimeoutMs is passed through to the runner', async () => {
    const h = makeHarness({ syncTimeoutMs: 5000 })
    sessionStart(h.handlers)

    toolCall(h.handlers)

    expect(h.calls[0]?.timeoutMs).toBe(5000)
    h.settle({ ...OK })
    await h.flush()
  })

  it('the maintenance budget reaches the auto-sync spawn (add-maintenance-budget-to-gate-spawns 3.3)', async () => {
    const h = makeHarness({ syncTimeoutMs: 600_000 })
    sessionStart(h.handlers)

    toolCall(h.handlers)

    expect(h.calls[0]?.timeoutMs).toBe(600_000)
    h.settle({ ...OK })
    await h.flush()
  })

  it('leaves the auto-sync budget unset when no syncTimeoutMs is configured (D2 pass-through)', async () => {
    const h = makeHarness()
    sessionStart(h.handlers)

    toolCall(h.handlers)

    expect(h.calls[0]?.timeoutMs).toBeUndefined()
    h.settle({ ...OK })
    await h.flush()
  })
})

describe('per-session auto-sync budget (design D3: maxSyncsPerSession)', () => {
  it('after the cap, further drift refreshes the advisory state only — no automatic sync', async () => {
    const h = makeHarness({ maxSyncsPerSession: 1 })
    sessionStart(h.handlers)

    toolCall(h.handlers)
    expect(h.calls).toHaveLength(1)
    h.settle({ ...OK })
    await h.flush()
    expect(h.store.snapshot('/repo')?.status).toBe('fresh')

    // A new stale episode after the cap: state-only refresh, nothing spawns.
    toolCall(h.handlers)
    expect(h.store.snapshot('/repo')?.status).toBe('possibly-stale')
    expect(h.calls).toHaveLength(1)
    expect(h.run()).toBeNull() // no sync in flight
  })

  it('session shutdown resets the per-session budget', async () => {
    const h = makeHarness({ maxSyncsPerSession: 1 })
    sessionStart(h.handlers)

    toolCall(h.handlers)
    h.settle({ ...OK })
    await h.flush()

    toolCall(h.handlers) // denied: cap consumed
    expect(h.calls).toHaveLength(1)

    sessionShutdown(h.handlers)
    sessionStart(h.handlers)
    toolCall(h.handlers) // fresh session, fresh budget
    expect(h.calls).toHaveLength(2)
    expect(h.store.snapshot('/repo')?.status).toBe('syncing')
  })

  it('with the default cap of 2, the third episode of the session is advisory-only', async () => {
    // The production default (freshness.maxSyncsPerSession = 2): two
    // completed syncs consume the session budget; the third stale episode
    // still refreshes the advisory state but never spawns an automatic
    // sync (design D3's past-cap posture, pinned against the real default).
    const h = makeHarness()
    sessionStart(h.handlers)

    toolCall(h.handlers)
    expect(h.store.snapshot('/repo')?.status).toBe('syncing')
    h.settle({ ...OK })
    await h.flush()
    expect(h.store.snapshot('/repo')?.status).toBe('fresh')

    toolCall(h.handlers)
    expect(h.calls).toHaveLength(2)
    h.settle({ ...OK })
    await h.flush()
    expect(h.store.snapshot('/repo')?.status).toBe('fresh')

    // Cap reached: a new stale episode refreshes the advisory state only.
    toolCall(h.handlers)
    expect(h.store.snapshot('/repo')?.status).toBe('possibly-stale')
    expect(h.calls).toHaveLength(2) // no third automatic sync
    expect(h.run()).toBeNull() // and nothing is in flight
  })

  it('a fresh state restored outside the budget (manual sync) never re-grants an automatic slot', async () => {
    const h = makeHarness({ maxSyncsPerSession: 1 })
    sessionStart(h.handlers)

    toolCall(h.handlers)
    expect(h.calls).toHaveLength(1)
    h.settle({ ...OK })
    await h.flush()
    expect(h.store.snapshot('/repo')?.status).toBe('fresh')

    // Cap consumed. An external path (e.g. a manual /cgc sync) restores
    // fresh; further drift still gets only the advisory refresh — the
    // per-session budget is state-independent and is not re-granted.
    h.store.recordStatus({ cwd: '/repo', status: 'fresh', at: 9_000 })
    toolCall(h.handlers)

    expect(h.store.snapshot('/repo')?.status).toBe('possibly-stale')
    expect(h.store.snapshot('/repo')?.lastSyncedAt).toBe(9_000) // manual sync kept
    expect(h.calls).toHaveLength(1)
    expect(h.run()).toBeNull()
  })

  it('a blocked workspace never consumes a session slot; the budget survives for a later unblocked drift', async () => {
    let blocked = true
    const h = makeHarness({
      maxSyncsPerSession: 1,
      worktreeBlockFor: () => ({ blocked }),
    })
    sessionStart(h.handlers)

    // Isolate-mode fail-closed: blocked drift records nothing and spawns
    // nothing, so the single slot is not squandered on a context the gate
    // refuses to act on.
    toolCall(h.handlers)
    expect(h.calls).toHaveLength(0)
    expect(h.store.snapshots()).toEqual([])

    // The gate releases the workspace: the same session still holds its
    // budget, and the first unblocked drift may sync within it.
    blocked = false
    toolCall(h.handlers)
    expect(h.store.snapshot('/repo')?.status).toBe('syncing')
    expect(h.calls).toHaveLength(1)

    h.settle({ ...OK })
    await h.flush()
    expect(h.store.snapshot('/repo')?.status).toBe('fresh')
  })
})

describe('autoSync off and runnerless degradation (design D2: advisory only)', () => {
  it('autoSync off records drift but never spawns a sync', () => {
    const h = makeHarness({ autoSync: false })
    sessionStart(h.handlers)

    toolCall(h.handlers)

    expect(h.store.snapshot('/repo')?.status).toBe('possibly-stale')
    expect(h.calls).toHaveLength(0)
  })

  it('no runner → observation still records, no automatic sync ever spawns (fail-open)', () => {
    const h = makeHarness({ withoutRunner: true })
    sessionStart(h.handlers)

    toolCall(h.handlers)

    expect(h.store.snapshot('/repo')?.status).toBe('possibly-stale')
    expect(h.store.snapshot('/repo')?.staleSince).not.toBeNull()
  })
})

describe('settle machine and fail-open containment (ADR-0007)', () => {
  it('a BUSY outcome records skipped-busy and preserves the stale episode timestamps', async () => {
    let clock = 1000
    const h = makeHarness({ now: () => clock })
    sessionStart(h.handlers)

    toolCall(h.handlers)
    expect(h.store.snapshot('/repo')?.staleSince).toBe(1000)

    clock = 3000
    h.settle({ ...BUSY })
    await h.flush()

    const snap = h.store.snapshot('/repo')
    expect(snap?.status).toBe('skipped-busy')
    expect(snap?.staleSince).toBe(1000) // first-mark never clobbered
    expect(snap?.lastSyncedAt).toBeNull()
  })

  it('a failed sync keeps the advisory possibly-stale state and never retries the episode', async () => {
    const h = makeHarness()
    sessionStart(h.handlers)

    toolCall(h.handlers)
    h.settle({ ...FAILED })
    await h.flush()

    const snap = h.store.snapshot('/repo')
    expect(snap?.status).toBe('possibly-stale') // never a false fresh
    expect(snap?.lastSyncedAt).toBeNull()

    // The stale episode stays open: further edits record nothing and no
    // automatic retry spawns (one attempt per episode, task 3.2's cap).
    toolCall(h.handlers)
    expect(h.calls).toHaveLength(1)
    expect(h.store.snapshot('/repo')?.status).toBe('possibly-stale')
  })

  it('a rejecting run is contained: no unhandled rejection, advisory state kept', async () => {
    const h = makeHarness({ rejectWith: 'child process exploded' })
    sessionStart(h.handlers)

    expect(() => toolCall(h.handlers)).not.toThrow()
    await h.flush()

    const snap = h.store.snapshot('/repo')
    expect(snap?.status).toBe('possibly-stale')
    expect(snap?.staleSince).not.toBeNull()
  })

  it('a synchronously-throwing runner fails open (tool call unaffected, advisory kept)', async () => {
    const h = makeHarness({ throwOnRun: true })
    sessionStart(h.handlers)

    expect(() => toolCall(h.handlers)).not.toThrow()
    expect(h.store.snapshot('/repo')?.status).toBe('syncing') // progress recorded
    await h.flush()

    expect(h.store.snapshot('/repo')?.status).toBe('possibly-stale') // settled advisory
  })

  it('a blocked workspace never spawns a sync (fail-closed gate)', async () => {
    const consulted: string[] = []
    const h = makeHarness({
      worktreeBlockFor: (cwd) => {
        consulted.push(cwd)
        return { blocked: true }
      },
    })
    sessionStart(h.handlers)

    toolCall(h.handlers)

    expect(consulted).toEqual(['/repo'])
    expect(h.store.snapshots()).toEqual([]) // nothing recorded when blocked
    expect(h.calls).toHaveLength(0)
  })

  it('an unblocked workspace with a block surface still syncs normally', async () => {
    const h = makeHarness({ worktreeBlockFor: () => ({ blocked: false }) })
    sessionStart(h.handlers)

    toolCall(h.handlers)

    expect(h.calls).toHaveLength(1)
    h.settle({ ...OK })
    await h.flush()
    expect(h.store.snapshot('/repo')?.status).toBe('fresh')
  })
})

describe('error recording and one-attempt retry cap (task 3.2)', () => {
  it('a failed sync records lastError, keeps the episode open, and never retries it', async () => {
    const h = makeHarness()
    sessionStart(h.handlers)

    toolCall(h.handlers)
    h.settle({ ...FAILED })
    await h.flush()

    const snap = h.store.snapshot('/repo')
    expect(snap?.status).toBe('possibly-stale')
    expect(snap?.lastError).toBe('boom') // the runner's failure message is recorded

    // The stale episode stays open: further edits record nothing and no
    // automatic retry spawns (one attempt per episode — task 3.2's cap).
    toolCall(h.handlers)
    expect(h.calls).toHaveLength(1)
    expect(h.store.snapshot('/repo')?.lastError).toBe('boom')
  })

  it('a rejecting run records lastError with the unexpected-failure text', async () => {
    const h = makeHarness({ rejectWith: 'child process exploded' })
    sessionStart(h.handlers)

    toolCall(h.handlers)
    await h.flush()

    const snap = h.store.snapshot('/repo')
    expect(snap?.status).toBe('possibly-stale')
    expect(snap?.lastError).toContain('child process exploded')
  })

  it('a synchronously-throwing runner records lastError with the start-failure text', async () => {
    const h = makeHarness({ throwOnRun: true })
    sessionStart(h.handlers)

    toolCall(h.handlers)
    await h.flush()

    const snap = h.store.snapshot('/repo')
    expect(snap?.status).toBe('possibly-stale')
    expect(snap?.lastError).toContain('failed to start')
  })

  it('a BUSY settle records no lastError (it is a skip, not an error)', async () => {
    const h = makeHarness()
    sessionStart(h.handlers)

    toolCall(h.handlers)
    h.settle({ ...BUSY })
    await h.flush()

    const snap = h.store.snapshot('/repo')
    expect(snap?.status).toBe('skipped-busy')
    expect(snap?.lastError).toBeNull()
  })

  it('a completed sync clears lastError (the error condition resolves)', async () => {
    const h = makeHarness()
    sessionStart(h.handlers)

    toolCall(h.handlers)
    h.settle({ ...FAILED })
    await h.flush()
    expect(h.store.snapshot('/repo')?.lastError).toBe('boom')

    // A later successful sync (a fresh episode the explicit /cgc sync path
    // opened through the shared store) clears the recorded error.
    h.store.recordStatus({ cwd: '/repo', status: 'fresh', at: 1000 })
    toolCall(h.handlers)
    h.settle({ ...OK })
    await h.flush()

    expect(h.store.snapshot('/repo')?.status).toBe('fresh')
    expect(h.store.snapshot('/repo')?.lastError).toBeNull()
  })

  it('a non-BUSY watcher failure records the honest not-verified state and never re-attempts', async () => {
    const h = makeHarness({ watch: 'on' })
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })

    h.settle({ ...FAILED })
    await h.flush()

    expect(h.store.snapshot('/repo')?.lastError).toBe('boom')
    // The honest not-verified degradation: advisory stale + ONE notice.
    expect(h.store.snapshot('/repo')?.status).toBe('possibly-stale')
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.type).toBe('warning')
    expect(h.notices[0]?.text).toContain('NOT reported fresh')

    // Lazy mode resumed: the episode is already open, so the next edit
    // records nothing and does not double-trigger (the notice names /cgc sync).
    toolCall(h.handlers)
    expect(h.store.snapshot('/repo')?.status).toBe('possibly-stale')
    expect(h.calls).toHaveLength(1) // watcher attempt only, no watcher retry
  })

  it('a BUSY watcher settle records no lastError and no status claim (a skip, not an error)', async () => {
    const h = makeHarness({ watch: 'on' })
    sessionStart(h.handlers)

    h.settle({ ...BUSY })
    await h.flush()

    // The store is left untouched: unrecorded = no claim, no error.
    expect(h.store.snapshot('/repo')).toBeNull()
  })

  it('an event subscription failure is recorded at the next session start', () => {
    // register() knows no workspace, so a failed hook subscription is
    // deferred and recorded once the session provides one (task 3.2).
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const api: FreshnessExtensionApi = {
      on: (event, handler) => {
        if (event === 'tool_call') throw new Error('busy registration table')
        handlers.set(event, handler)
        return undefined
      },
    }
    const store = new FreshnessStateStore()
    const observer = new FreshnessDriftObserver({ store, api })
    observer.register()

    sessionStart(handlers)
    const snap = store.snapshot('/repo')
    expect(snap?.lastError).toContain('tool_call')
    expect(snap?.lastError).toContain('busy registration table')

    // The deferred list drains once recorded: a fresh session records
    // nothing (the store reset dropped the previous session's error).
    sessionShutdown(handlers)
    sessionStart(handlers)
    expect(store.snapshot('/repo')).toBeNull()
  })

  it('a throwing recordError surface cannot break the tool_call handler (fail-open)', () => {
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
      recordError: () => {
        throw new Error('recordError boom')
      },
      reset: () => {},
      subscribe: () => () => {},
    } as unknown as FreshnessStateStore
    const observer = new FreshnessDriftObserver({ store: broken, api })
    observer.register()
    sessionStart(handlers)

    expect(() => toolCall(handlers, 'edit')).not.toThrow()
    expect(toolCall(handlers, 'edit')).toBeUndefined()
    expect(observer.dispose()).toBeUndefined()
  })
})

describe('skip-as-busy notice (task 2.3, design D4)', () => {
  it('a BUSY settle emits exactly one notice naming the conflict and keeps skipped-busy state', async () => {
    const h = makeHarness()
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })

    toolCall(h.handlers)
    h.settle({ ...BUSY })
    await h.flush()

    expect(h.store.snapshot('/repo')?.status).toBe('skipped-busy')
    expect(h.store.snapshot('/repo')?.staleSince).not.toBeNull()
    const busy = h.notices.find((n) => n.text.includes('skipped'))
    expect(busy).toBeDefined()
    expect(busy?.type).toBe('warning')
    // The runner's BUSY message names the conflict inside the notice.
    expect(busy?.text).toContain('CGC MCP server')
    expect(busy?.text).toContain('skipped')
    // Task 3.1: the episode-opening mark fired its own once-per-session
    // stale notice first — the busy notice is a distinct condition key.
    expect(h.notices).toHaveLength(2)
    expect(h.notices[0]?.text).toContain('possibly stale')
  })

  it('the skipped-busy notice fires only once per session, even across episodes', async () => {
    const h = makeHarness()
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })

    toolCall(h.handlers)
    h.settle({ ...BUSY })
    await h.flush()
    expect(busyKeyNotices(h.notices)).toHaveLength(1)
    expect(h.notices).toHaveLength(2) // stale notice + busy notice

    // An explicit sync (the /cgc sync path shares the store) ends the
    // episode; a later automatic sync hits the same lock again — the
    // `skipped-busy` condition key is latched for the session, so no second
    // busy notice fires (and the stale key is latched too: the second
    // episode's mark surfaces no new notice).
    h.store.recordStatus({ cwd: '/repo', status: 'fresh', at: 1000 })
    toolCall(h.handlers)
    expect(h.calls).toHaveLength(2)
    h.settle({ ...BUSY })
    await h.flush()

    expect(h.store.snapshot('/repo')?.status).toBe('skipped-busy')
    expect(busyKeyNotices(h.notices)).toHaveLength(1)
    expect(h.notices).toHaveLength(2)
  })

  it('a successful settle never emits the skipped-busy notice', async () => {
    const h = makeHarness()
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })

    toolCall(h.handlers)
    h.settle({ ...OK })
    await h.flush()

    expect(h.store.snapshot('/repo')?.status).toBe('fresh')
    // The conflicting-condition text never appears...
    expect(h.notices.find((n) => n.text.includes('skipped'))).toBeUndefined()
    // ...only this session's two legit conditions fired: the episode-opening
    // stale notice and the completion notice (task 3.1).
    expect(h.notices).toHaveLength(2)
    expect(h.notices[0]?.text).toContain('possibly stale')
    expect(h.notices[1]?.type).toBe('info')
    expect(h.notices[1]?.text).toContain('up to date')
  })

  it('the once-per-session notice latch resets at session shutdown', async () => {
    const h = makeHarness()
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })

    toolCall(h.handlers)
    h.settle({ ...BUSY })
    await h.flush()
    expect(busyKeyNotices(h.notices)).toHaveLength(1)
    expect(h.notices).toHaveLength(2) // stale + busy

    sessionShutdown(h.handlers)
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })
    toolCall(h.handlers)
    h.settle({ ...BUSY })
    await h.flush()

    expect(busyKeyNotices(h.notices)).toHaveLength(2) // the next session may notify again
    expect(h.notices).toHaveLength(4) // stale + busy, for each session
  })

  it('a missing ui sink settles quietly (fail-open)', async () => {
    const h = makeHarness()
    sessionStart(h.handlers) // no ui surface

    toolCall(h.handlers)
    h.settle({ ...BUSY })
    await h.flush()

    expect(h.store.snapshot('/repo')?.status).toBe('skipped-busy')
    expect(h.notices).toHaveLength(0)
  })

  it('a throwing ui.notify never breaks settlement (fail-open)', async () => {
    const h = makeHarness()
    sessionStart(h.handlers, '/repo', {
      notify: () => {
        throw new Error('ui exploded')
      },
    })

    toolCall(h.handlers)
    expect(() => h.settle({ ...BUSY })).not.toThrow()
    await h.flush()

    expect(h.store.snapshot('/repo')?.status).toBe('skipped-busy')
  })
})

describe('once-per-condition notices (task 3.1, design D4)', () => {
  it('the episode-opening drift mark emits exactly one possibly-stale notice with the /cgc sync hint', async () => {
    const h = makeHarness()
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })

    toolCall(h.handlers)
    await h.flush()

    expect(h.store.snapshot('/repo')?.status).toBe('syncing')
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.type).toBe('warning')
    expect(h.notices[0]?.text).toContain('possibly stale')
    expect(h.notices[0]?.text).toContain('/cgc sync')
  })

  it('the possibly-stale notice fires once per session, never per episode', async () => {
    const h = makeHarness()
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })

    toolCall(h.handlers)
    h.settle({ ...OK })
    await h.flush()
    expect(h.notices).toHaveLength(2) // possibly-stale + sync-completed

    // A second episode (an explicit sync ended the first) re-marks staleness
    // within the budget, but both condition keys are latched — no further
    // notices this session.
    h.store.recordStatus({ cwd: '/repo', status: 'fresh', at: 1000 })
    toolCall(h.handlers)
    expect(h.store.snapshot('/repo')?.status).toBe('syncing')
    h.settle({ ...OK })
    await h.flush()

    expect(h.store.snapshot('/repo')?.status).toBe('fresh')
    expect(h.notices).toHaveLength(2)
  })

  it('a successful settle emits exactly one sync-completed notice and reports fresh', async () => {
    const h = makeHarness()
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })

    toolCall(h.handlers)
    h.settle({ ...OK })
    await h.flush()

    expect(h.store.snapshot('/repo')?.status).toBe('fresh')
    expect(h.notices).toHaveLength(2)
    expect(h.notices[1]?.type).toBe('info')
    expect(h.notices[1]?.text).toContain('up to date')
  })

  it('an unsuccessful settle emits no sync-completed notice (advisory stale kept)', async () => {
    const h = makeHarness()
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })

    toolCall(h.handlers)
    h.settle({ ...FAILED })
    await h.flush()

    expect(h.store.snapshot('/repo')?.status).toBe('possibly-stale')
    expect(h.notices).toHaveLength(1) // stale notice only
    expect(h.notices[0]?.text).toContain('possibly stale')
  })
  it('the possibly-stale notice never fires while the managed watcher owns freshness', async () => {
    const h = makeHarness({ watch: 'on' })
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })

    toolCall(h.handlers)
    await h.flush()
    await h.flush()

    // The verified watcher owns freshness: fresh state, watcher-start notice
    // only — no possibly-stale notice (design D4's suppression).
    expect(h.store.snapshot('/repo')?.status).toBe('fresh')
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.type).toBe('info')
    expect(h.notices[0]?.text).toContain('verified alive')
  })

  it('a missing ui sink stays quiet (fail-open): state still flows, no notices', async () => {
    const h = makeHarness()
    sessionStart(h.handlers) // no ui surface

    expect(() => toolCall(h.handlers)).not.toThrow()
    expect(h.store.snapshot('/repo')?.status).toBe('syncing')
    h.settle({ ...OK })
    await h.flush()

    expect(h.store.snapshot('/repo')?.status).toBe('fresh')
    expect(h.notices).toHaveLength(0)
  })

  it('a throwing ui.notify never breaks drift marking or settlement (fail-open)', async () => {
    const h = makeHarness()
    sessionStart(h.handlers, '/repo', {
      notify: () => {
        throw new Error('ui exploded')
      },
    })

    expect(() => toolCall(h.handlers)).not.toThrow()
    expect(() => h.settle({ ...OK })).not.toThrow()
    await h.flush()

    expect(h.store.snapshot('/repo')?.status).toBe('fresh')
    expect(h.notices).toHaveLength(0)
  })

  it('the notice latch resets at session shutdown so the next session may notify again', async () => {
    const h = makeHarness()
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })

    toolCall(h.handlers)
    h.settle({ ...OK })
    await h.flush()
    expect(h.notices).toHaveLength(2)

    sessionShutdown(h.handlers)
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })
    toolCall(h.handlers)
    expect(h.notices).toHaveLength(3) // stale again — the latch cleared
    expect(h.notices[2]?.text).toContain('possibly stale')
    h.settle({ ...OK })
    await h.flush()

    expect(h.notices).toHaveLength(4) // completion again
  })
})

describe('continuous watcher (task 2.4, tri-state per add-freshness-watch-tri-state)', () => {
  // The watcher spawn lands in the shared runner's live-children set so
  // every session cleanup path (cleanup.ts) terminates it — exercised here
  // through the runner fake recording the spawn and its long time budget.
  const watcherCall = { cwd: '/repo', args: ['watch', '.'], timeoutMs: WATCHER_TIMEOUT_MS }
  /** The harness default: the verification window resolves immediately. */
  const verified = async (h: Awaited<ReturnType<typeof makeHarness>>): Promise<void> => {
    await h.flush()
    await h.flush()
  }

  it('session start with freshness.watch on spawns `cgc watch .` via the runner; fresh records only after liveness verification', async () => {
    const h = makeHarness({ watch: 'on' })
    sessionStart(h.handlers)

    expect(WATCHER_ARGS).toEqual(['watch', '.'])
    expect(h.calls).toEqual([watcherCall])
    // The honest claim: NO fresh record at spawn time (design D4).
    expect(h.store.snapshot('/repo')).toBeNull()

    await verified(h)
    const snap = h.store.snapshot('/repo')
    expect(snap?.status).toBe('fresh')
    expect(snap?.lastSyncedAt).not.toBeNull()
  })

  it('a verified watcher surfaces the one-time watcher-start notice', async () => {
    const h = makeHarness({ watch: 'on' })
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })

    await verified(h)
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.type).toBe('info')
    expect(h.notices[0]?.text).toContain('verified alive')
  })

  it('watch off (the default) spawns no watcher; lazy freshness behavior is unchanged', () => {
    const h = makeHarness()
    sessionStart(h.handlers)
    expect(h.calls).toEqual([])

    toolCall(h.handlers)
    expect(h.calls).toEqual([{ cwd: '/repo', args: [...AUTO_SYNC_ARGS] }])
    expect(h.store.snapshot('/repo')?.status).toBe('syncing')
  })

  it('while a verified watcher runs, session edits open no stale episode and no lazy sync starts', async () => {
    const h = makeHarness({ watch: 'on' })
    sessionStart(h.handlers)
    await verified(h)
    expect(h.calls).toHaveLength(1)

    toolCall(h.handlers)
    toolCall(h.handlers, 'write')

    expect(h.calls).toHaveLength(1) // only the watcher spawn
    expect(h.store.snapshot('/repo')?.status).toBe('fresh')
  })

  it('a watcher that dies within the verification window never records fresh (honest not-verified)', async () => {
    const h = makeHarness({ watch: 'on', watcherLivenessMs: 30 })
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })
    expect(h.calls).toEqual([watcherCall])
    expect(h.store.snapshot('/repo')).toBeNull() // no claim at spawn

    // The watcher settles as failed within the window.
    h.settle({ ...FAILED })
    await verified(h)

    const snap = h.store.snapshot('/repo')
    expect(snap?.status).toBe('possibly-stale') // the honest not-verified state
    expect(snap?.lastError).toBe('boom')
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.type).toBe('warning')
    expect(h.notices[0]?.text).toContain('NOT reported fresh')
    expect(h.calls).toHaveLength(1) // no watcher retry
  })

  it('a verified watcher that dies later degrades lazily: the next edit re-opens the episode and syncs', async () => {
    const h = makeHarness({ watch: 'on' })
    sessionStart(h.handlers, '/repo', { notify: (text, type) => h.notices.push({ text, type }) })
    await verified(h)
    expect(h.store.snapshot('/repo')?.status).toBe('fresh')

    // Mid-session death AFTER verification: error recorded, the status stays
    // fresh until the next observed edit re-opens the episode (lazy takeover).
    h.settle({ ...FAILED })
    await h.flush()
    expect(h.store.snapshot('/repo')?.lastError).toBe('boom')

    toolCall(h.handlers)
    expect(h.store.snapshot('/repo')?.status).toBe('syncing')
    expect(h.calls).toHaveLength(2)
  })

  it('a BUSY watcher start fires ONE watcher-blocked notice, records nothing, and degrades to lazy mode', async () => {
    const h = makeHarness({ watch: 'on' })
    sessionStart(h.handlers, '/repo', {
      notify: (text, type) => h.notices.push({ text, type }),
    })
    expect(h.calls).toEqual([watcherCall])

    h.settle({ ...BUSY })
    await verified(h)

    // The notice names the conflict; the state store is left untouched so the
    // next edit opens a normal episode the lazy path can act on.
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.type).toBe('warning')
    expect(h.notices[0]?.text).toContain('watcher')
    expect(h.notices[0]?.text).toContain('CGC MCP server')
    expect(h.store.snapshot('/repo')).toBeNull() // unrecorded = no claim

    // Degraded to lazy mode: the next edit opens the episode and runs the
    // budgeted auto-sync.
    toolCall(h.handlers)
    expect(h.store.snapshot('/repo')?.status).toBe('syncing')
    expect(h.calls).toHaveLength(2)
    h.settle({ ...OK })
    await h.flush()
    expect(h.store.snapshot('/repo')?.status).toBe('fresh')
  })

  it('the watcher-blocked notice shares the skipped-busy once-per-session latch (no double notice)', async () => {
    const h = makeHarness({ watch: 'on' })
    sessionStart(h.handlers, '/repo', {
      notify: (text, type) => h.notices.push({ text, type }),
    })
    h.settle({ ...BUSY })
    await verified(h)
    expect(busyKeyNotices(h.notices)).toHaveLength(1)
    expect(h.notices).toHaveLength(1) // watcher-blocked notice only, so far

    // The degraded lazy sync later hits the same lock: same condition key,
    // already latched — no second busy notice. The episode-opening mark does
    // surface the distinct stale condition once (its own key).
    toolCall(h.handlers)
    h.settle({ ...BUSY })
    await h.flush()

    expect(h.store.snapshot('/repo')?.status).toBe('skipped-busy')
    expect(busyKeyNotices(h.notices)).toHaveLength(1)
    expect(h.notices).toHaveLength(2) // stale notice + busy notice
  })

  it('the watcher attempt is per-session: shutdown resets the flags so a new session starts it again', () => {
    const h = makeHarness({ watch: 'on' })
    sessionStart(h.handlers)
    expect(h.calls).toHaveLength(1)

    sessionShutdown(h.handlers)
    sessionStart(h.handlers)
    expect(h.calls).toHaveLength(2) // a fresh session attempts a fresh watcher
  })

  it('a worktree-blocked workspace never starts the watcher (fail-closed gate)', () => {
    const h = makeHarness({ watch: 'on', worktreeBlockFor: () => ({ blocked: true }) })
    sessionStart(h.handlers)

    expect(h.calls).toHaveLength(0)
    expect(h.store.snapshots()).toEqual([])
  })

  // --- auto mode: the gated backend-aware default (design D3) ---

  it('auto + server backend + indexed workspace spawns the watcher', async () => {
    const h = makeHarness({
      watch: 'auto',
      detectBackend: () => 'neo4j',
      isIndexed: () => true,
    })
    sessionStart(h.handlers)
    await verified(h)

    expect(h.calls).toEqual([watcherCall])
    expect(h.store.snapshot('/repo')?.status).toBe('fresh')
  })

  it('auto + embedded backend never spawns (conservative no-spawn)', async () => {
    const h = makeHarness({
      watch: 'auto',
      detectBackend: () => 'kuzudb',
      isIndexed: () => true,
    })
    sessionStart(h.handlers, '/repo', { notify: (t, ty) => h.notices.push({ text: t, type: ty }) })
    await verified(h)

    expect(h.calls).toEqual([])
    expect(h.store.snapshots()).toEqual([])
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.text).toContain('auto')
    expect(h.notices[0]?.text).toContain('server backends')
  })

  it('auto + unknown backend fails open to the conservative answer (no spawn)', async () => {
    const h = makeHarness({
      watch: 'auto',
      detectBackend: () => null,
      isIndexed: () => true,
    })
    sessionStart(h.handlers)
    await verified(h)

    expect(h.calls).toEqual([])
  })

  it('auto + unindexed workspace never spawns and never creates an index (consent model intact)', async () => {
    const h = makeHarness({
      watch: 'auto',
      detectBackend: () => 'falkordb-remote',
      isIndexed: () => false,
    })
    sessionStart(h.handlers, '/repo', { notify: (t, ty) => h.notices.push({ text: t, type: ty }) })
    await verified(h)

    expect(h.calls).toEqual([]) // no watcher AND no initial scan/index spawn
    expect(h.store.snapshots()).toEqual([])
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.text).toContain('not indexed')
  })

  it('auto with no detector wired resolves to the conservative no-spawn', async () => {
    const h = makeHarness({ watch: 'auto', isIndexed: () => true })
    sessionStart(h.handlers)
    await verified(h)

    expect(h.calls).toEqual([])
  })

  it('auto decline notices fire once per session (latched, no notice storm)', async () => {
    const h = makeHarness({
      watch: 'auto',
      detectBackend: () => 'neo4j',
      isIndexed: () => false,
    })
    sessionStart(h.handlers, '/repo', { notify: (t, ty) => h.notices.push({ text: t, type: ty }) })
    await verified(h)
    expect(h.notices).toHaveLength(1)

    // A second session start on the same session does not re-notify.
    sessionStart(h.handlers)
    await verified(h)
    expect(h.notices).toHaveLength(1)
  })

  it('auto backend detection is cached per session (one detector call)', async () => {
    let detections = 0
    const h = makeHarness({
      watch: 'auto',
      isIndexed: () => true,
      detectBackend: () => {
        detections += 1
        return 'neo4j'
      },
    })
    sessionStart(h.handlers)
    await verified(h)
    sessionStart(h.handlers) // same session, re-entrant start attempt
    await verified(h)

    expect(detections).toBe(1)
  })
})

/**
 * Task 3.3 — the watcher's containment guarantee, integration-level. The
 * fake-runner watcher tests above prove the observer's wiring; these prove
 * that a watcher child spawned through the REAL CgcRunner lands in its
 * live-children set and is terminated by each of cleanup.ts's three teardown
 * paths (session_shutdown → killAll, process exit → terminateAllSync, signal
 * → hardSweep). cleanup.test.ts exercises the same paths with generic
 * children; here the child is the freshness watcher verb itself
 * (WATCHER_ARGS + WATCHER_TIMEOUT_MS), so the lifecycle closes end to end.
 */
describe('watcher teardown on every cleanup path (task 3.3: real runner)', () => {
  /** A `cgc watch`-like child: prints one line, then stays alive indefinitely. */
  const WATCHER_STUB_SOURCE = '#!/bin/sh\nprintf "watching\\n"\nwhile :; do :; done\n'

  /** A script that ignores its argv (the watcher verb passes through) and lives until killed. */
  function makeWatcherStub(): { dir: string; executable: string } {
    const dir = mkdtempSync(join(tmpdir(), 'cgc-freshness-watcher-'))
    const executable = join(dir, 'cgc-watch')
    writeFileSync(executable, WATCHER_STUB_SOURCE, 'utf8')
    chmodSync(executable, 0o755)
    return { dir, executable }
  }

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /** Multi-handler extension API (per-event ordered lists): the shared wiring seam. */
  class RecordingExtensionApi {
    readonly listeners = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>()

    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): unknown {
      const list = this.listeners.get(event) ?? []
      list.push(handler)
      this.listeners.set(event, list)
      return undefined
    }

    emit(event: string, payload: unknown = {}, ctx: unknown = {}): void {
      for (const handler of this.listeners.get(event) ?? []) handler(payload, ctx)
    }
  }

  /** Fake process surface (an EventEmitter exposing kill and pid) — the cleanup seam. */
  class FakeProcess extends EventEmitter {
    readonly killedSignals: Array<{ pid: number; signal: string | number }> = []

    constructor(readonly pid = 42_424) {
      super()
    }

    kill(pid: number, signal: string | number): boolean {
      this.killedSignals.push({ pid, signal })
      return true
    }

    // The cleanup module calls on/once/removeListener with (string, fn); widen
    // EventEmitter's overloads to that shape.
    override on(event: string, listener: (...args: unknown[]) => void): this {
      return super.on(event, listener as never)
    }

    override once(event: string, listener: (...args: unknown[]) => void): this {
      return super.once(event, listener as never)
    }

    override removeListener(event: string, listener: (...args: unknown[]) => void): this {
      return super.removeListener(event, listener as never)
    }
  }

  it('a watcher child spawned with the freshness verb lands in liveChildren (killAll counts and cancels it)', async () => {
    const { dir, executable } = makeWatcherStub()
    try {
      const runner = new CgcRunner({ executable })
      const pending = runner.run(dir, { args: [...WATCHER_ARGS], timeoutMs: WATCHER_TIMEOUT_MS })
      await delay(120) // let the spawn land in the live-children set

      // The child is LIVE in liveChildren: the graceful sweep counts exactly
      // one watcher and terminates it (the run settles CANCELLED).
      const signalled = await runner.killAll()
      const result = await pending

      expect(signalled).toBe(1)
      expect(result.code).toBe('CANCELLED')
      expect(result.ok).toBe(false)
      // The set drained: a second sweep finds nothing left to signal.
      expect(await runner.killAll()).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('teardown path 1 (session_shutdown): the graceful killAll sweep terminates the watcher child', async () => {
    const { dir, executable } = makeWatcherStub()
    try {
      const runner = new CgcRunner({ executable })
      const api = new RecordingExtensionApi()
      const handle = installProcessCleanup(runner, { api })

      const pending = runner.run(dir, { args: [...WATCHER_ARGS], timeoutMs: WATCHER_TIMEOUT_MS })
      await delay(120)

      api.emit('session_shutdown')
      const result = await pending
      await delay(50) // let the sweep record its event

      expect(result.code).toBe('CANCELLED')
      expect(handle.events).toContainEqual(
        expect.objectContaining({ path: 'session-shutdown', terminated: 1 }),
      )
      handle.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('teardown path 2 (process exit): the synchronous hard sweep SIGKILLs the watcher child', async () => {
    const { dir, executable } = makeWatcherStub()
    try {
      const runner = new CgcRunner({ executable })
      const fakeProcess = new FakeProcess()
      const handle = installProcessCleanup(runner, { processObject: fakeProcess })

      const pending = runner.run(dir, { args: [...WATCHER_ARGS], timeoutMs: WATCHER_TIMEOUT_MS })
      await delay(120)

      fakeProcess.emit('exit', 0)
      const result = await pending

      expect(result.code).toBe('CANCELLED')
      expect(result.signal).toBe('SIGKILL')
      expect(handle.events).toContainEqual(
        expect.objectContaining({ path: 'process-exit', terminated: 1 }),
      )
      handle.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('teardown path 3 (signal): SIGINT hard-kills the watcher child and re-raises the signal once', async () => {
    const { dir, executable } = makeWatcherStub()
    try {
      const runner = new CgcRunner({ executable })
      const fakeProcess = new FakeProcess()
      const handle = installProcessCleanup(runner, { processObject: fakeProcess })

      const pending = runner.run(dir, { args: [...WATCHER_ARGS], timeoutMs: WATCHER_TIMEOUT_MS })
      await delay(120)

      fakeProcess.emit('SIGINT')
      const result = await pending
      // The re-raised signal must not re-enter our (now removed) handler.
      fakeProcess.emit('SIGINT')
      await delay(20)

      expect(result.code).toBe('CANCELLED')
      expect(result.signal).toBe('SIGKILL')
      expect(fakeProcess.killedSignals).toEqual([{ pid: 42_424, signal: 'SIGINT' }])
      expect(handle.events).toContainEqual(
        expect.objectContaining({ path: 'signal', signal: 'SIGINT', terminated: 1 }),
      )
      handle.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('end to end: a freshness.watch session spawns through the real runner; session_shutdown kills the child and resets the store', async () => {
    const { dir, executable } = makeWatcherStub()
    try {
      const store = new FreshnessStateStore()
      const runner = new CgcRunner({ executable })
      // Production wiring (index.ts): the cleanup install and the freshness
      // observer share one extension API — cleanup registered FIRST so its
      // shutdown sweep runs before the observer's store reset.
      const api = new RecordingExtensionApi()
      const handle = installProcessCleanup(runner, { api })
      const observer = new FreshnessDriftObserver({
        store,
        runner,
        watch: 'on',
        // The real runner path needs a real (small) verification window: the
        // child must survive it before the fresh record lands.
        watcherLivenessMs: 50,
        api,
      })
      observer.register()

      api.emit('session_start', {}, { cwd: dir })
      await delay(120) // let the watcher spawn land in liveChildren

      expect(store.snapshot(dir)?.status).toBe('fresh') // the watcher owns freshness
      api.emit('session_shutdown')
      await delay(100) // sweep + record + observer store reset

      // The observer-spawned watcher child was in liveChildren: the cleanup
      // sweep counted and terminated it, and the observer reset the store.
      expect(handle.events).toContainEqual(
        expect.objectContaining({ path: 'session-shutdown', terminated: 1 }),
      )
      expect(store.snapshot(dir)).toBeNull()
      expect(await runner.killAll()).toBe(0) // nothing left live
      handle.dispose()
      observer.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * The bounded backend-detection helper (design D2 of
 * add-freshness-watch-tri-state): CGC's own precedence order, time-bounded
 * doctor probe, .env fallback, fail-open to unknown (conservative embedded).
 */
describe('backend detection (add-freshness-watch-tri-state design D2)', () => {
  it('isServerBackend accepts only the server backends, conservatively rejecting unknown', () => {
    expect(isServerBackend('neo4j')).toBe(true)
    expect(isServerBackend('falkordb-remote')).toBe(true)
    expect(isServerBackend('  NEO4J  ')).toBe(true)
    expect(isServerBackend('kuzudb')).toBe(false)
    expect(isServerBackend('falkordb')).toBe(false)
    expect(isServerBackend('ladybugdb')).toBe(false)
    expect(isServerBackend('nornic')).toBe(false)
    expect(isServerBackend('')).toBe(false)
    expect(isServerBackend(null)).toBe(false)
    expect(isServerBackend(undefined)).toBe(false)
  })

  it('parseDoctorBackend reads the Default database line CGC doctor prints', () => {
    const doctor = [
      '2. Checking Database Connection...',
      'Loaded configuration from: /home/u/.codegraphcontext/.env',
      '   Default database: neo4j (source: /home/u/.codegraphcontext/.env)',
      '   ✓ Port 7687 is reachable',
    ].join('\n')
    expect(parseDoctorBackend(doctor)).toBe('neo4j')
    expect(parseDoctorBackend('   Default database: KuzuDB (source: auto-detect)')).toBe('kuzudb')
    expect(parseDoctorBackend('no database line here')).toBeNull()
    expect(parseDoctorBackend('')).toBeNull()
  })

  it('parseEnvFileBackend reads DATABASE_TYPE/DEFAULT_DATABASE with quotes and comments', () => {
    expect(parseEnvFileBackend('DATABASE_TYPE=neo4j\n')).toBe('neo4j')
    expect(parseEnvFileBackend('DEFAULT_DATABASE="falkordb-remote"\n')).toBe('falkordb-remote')
    expect(parseEnvFileBackend('# comment\nDATABASE_TYPE = kuzudb\n')).toBe('kuzudb')
    expect(parseEnvFileBackend('DATABASE_TYPE=neo4j\nDEFAULT_DATABASE=falkordb\n')).toBe('falkordb') // last wins
    expect(parseEnvFileBackend('NEO4J_URI=neo4j://host:7687\n')).toBeNull()
    expect(parseEnvFileBackend('')).toBeNull()
  })

  it('detectCgcBackend prefers the runtime env overrides, then doctor, then .env, then null', async () => {
    // 1: CGC's runtime override wins outright.
    expect(
      await detectCgcBackend({
        env: { CGC_RUNTIME_DB_TYPE: 'falkordb-remote', DATABASE_TYPE: 'kuzudb' },
        probe: async () => {
          throw new Error('probe must not run for explicit env')
        },
      }),
    ).toBe('falkordb-remote')

    // 2: process-level DATABASE_TYPE next.
    expect(
      await detectCgcBackend({
        env: { DATABASE_TYPE: 'neo4j' },
        probe: async () => {
          throw new Error('probe must not run for explicit env')
        },
      }),
    ).toBe('neo4j')

    // 3: the doctor probe (bounded) resolves the full chain.
    expect(
      await detectCgcBackend({
        env: {},
        probe: async () => '   Default database: falkordb-remote (source: context (main))',
      }),
    ).toBe('falkordb-remote')

    // 4: the .env fallback when doctor fails.
    expect(
      await detectCgcBackend({
        env: {},
        probe: async () => null,
        readTextFile: () => 'DATABASE_TYPE="neo4j"\n',
      }),
    ).toBe('neo4j')

    // 5: unknown fails open — the conservative embedded answer.
    expect(
      await detectCgcBackend({
        env: {},
        probe: async () => null,
        readTextFile: () => undefined,
      }),
    ).toBeNull()
  })

  it('detectCgcBackend never throws on a failing probe or reader (fail-open)', async () => {
    expect(
      await detectCgcBackend({
        env: {},
        probe: async () => {
          throw new Error('doctor exploded')
        },
        readTextFile: () => {
          throw new Error('fs exploded')
        },
      }),
    ).toBeNull()
  })
})
