import { describe, expect, it } from 'bun:test'
import { SessionInvocationBudget } from './budget'
import type { CgcCommandResult, CgcRunner } from './runner'
import type { UnindexedNotice } from './unindexed'
import {
  buildDegradedNotice,
  buildIndexingStartedNotice,
  buildUnindexedNotice,
  DEFAULT_INDEX_ARGS,
  UnindexedPath,
} from './unindexed'

function makeResult(overrides: Partial<CgcCommandResult> = {}): CgcCommandResult {
  return {
    ok: true,
    code: 'OK',
    message: 'cgc exited 0',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    durationMs: 1,
    argv: [...DEFAULT_INDEX_ARGS],
    cwd: '/unused',
    ...overrides,
  }
}

/**
 * Minimal runner stand-in. Queues canned results for background indexing
 * runs; unprefilled calls resolve with a healthy default so tests only
 * specify what matters.
 */
class MockRunner {
  calls: { cwd: string; args: readonly string[]; timeoutMs?: number | undefined }[] = []
  results: CgcCommandResult[] = []
  /** When set, replaces the implementation entirely (failure-injection tests). */
  overrideRun?: (cwd: string, options: { args: readonly string[] }) => Promise<CgcCommandResult>

  run(
    cwd: string,
    options: { args: readonly string[]; timeoutMs?: number },
  ): Promise<CgcCommandResult> {
    this.calls.push({ cwd, args: options.args, timeoutMs: options.timeoutMs })
    if (this.overrideRun) return this.overrideRun(cwd, options)
    const next = this.results.shift()
    return Promise.resolve(next ?? makeResult({ cwd, argv: [...options.args] }))
  }
}

function makePath(
  runner: MockRunner,
  options: Partial<{ autoCreate: boolean; onNotice: (notice: UnindexedNotice) => void }> = {},
): UnindexedPath {
  return new UnindexedPath({
    runner: runner as unknown as CgcRunner,
    autoCreate: options.autoCreate ?? false,
    ...(options.onNotice === undefined ? {} : { onNotice: options.onNotice }),
  })
}

describe('buildUnindexedNotice', () => {
  it('names the workspace, the cost, and every enablement route', () => {
    const text = buildUnindexedNotice('/repo')
    expect(text).toContain('/repo')
    expect(text).toContain('no code index')
    expect(text).toContain('lifecycle')
    expect(text).toContain('"autoCreate": true')
    expect(text).toContain('.pi/cgc.json')
    expect(text).toContain('~/.pi/agent/cgc.json')
    expect(text).toContain('CGC_LIFECYCLE_AUTO_CREATE=1')
    expect(text).toContain('cgc index .')
  })

  it('builds a started notice naming the background command', () => {
    const text = buildIndexingStartedNotice('/repo', DEFAULT_INDEX_ARGS)
    expect(text).toContain('/repo')
    expect(text).toContain('lifecycle.autoCreate')
    expect(text).toContain('cgc index .')
    expect(text).toContain('background')
  })

  it('builds a degraded notice carrying the failure reason', () => {
    const text = buildDegradedNotice('/repo', 'spawn exploded')
    expect(text).toContain('/repo')
    expect(text).toContain('spawn exploded')
    expect(text).toContain('cgc index .')
  })
})

describe('UnindexedPath with autoCreate off (default consent gate)', () => {
  it('starts no indexing and surfaces the one-time notice', () => {
    const runner = new MockRunner()
    const path = makePath(runner)

    const outcome = path.handle('/repo')

    expect(outcome.action).toBe('notice')
    expect(outcome.repeated).toBe(false)
    expect(outcome.indexing).toBe(false)
    expect(outcome.notice?.kind).toBe('unindexed')
    expect(outcome.notice?.text).toContain('autoCreate')
    expect(runner.calls).toEqual([])
    expect(path.status('/repo')).toBe('noticed')
    expect(path.isIndexing('/repo')).toBe(false)
  })

  it('surfaces the notice exactly once per workspace per session', () => {
    const runner = new MockRunner()
    const path = makePath(runner)

    const first = path.handle('/repo')
    const second = path.handle('/repo')

    expect(first.notice).not.toBeNull()
    expect(second.action).toBe('already-done')
    expect(second.repeated).toBe(true)
    expect(second.notice).toBeNull()
    expect(path.notices.length).toBe(1)
    expect(runner.calls).toEqual([])
  })

  it('tracks workspaces independently', () => {
    const runner = new MockRunner()
    const path = makePath(runner)

    const first = path.handle('/repo-a')
    const second = path.handle('/repo-b')

    expect(first.repeated).toBe(false)
    expect(second.repeated).toBe(false)
    expect(path.notices.length).toBe(2)
  })

  it('delivers the notice to the sink and survives a throwing sink', () => {
    const runner = new MockRunner()
    const seen: string[] = []
    const path = makePath(runner, {
      onNotice: (notice: UnindexedNotice) => {
        seen.push(notice.text)
        throw new Error('sink exploded')
      },
    })

    const outcome = path.handle('/repo')

    expect(seen.length).toBe(1)
    expect(path.notices.length).toBe(1)
    expect(outcome.action).toBe('notice')
  })
})

describe('UnindexedPath with autoCreate on (consented)', () => {
  it('starts background indexing through the runner and reports it running', async () => {
    const runner = new MockRunner()
    const path = makePath(runner, { autoCreate: true })

    const outcome = path.handle('/repo')

    expect(outcome.action).toBe('indexing')
    expect(outcome.indexing).toBe(true)
    expect(outcome.notice).toBeNull()
    expect(runner.calls).toEqual([
      { cwd: '/repo', args: [...DEFAULT_INDEX_ARGS], timeoutMs: undefined },
    ])
    expect(path.status('/repo')).toBe('indexing')
    expect(path.isIndexing('/repo')).toBe(true)

    const result = await path.whenSettled('/repo')
    expect(result?.ok).toBe(true)
    expect(result?.code).toBe('OK')
    expect(path.status('/repo')).toBe('settled')
    expect(path.isIndexing('/repo')).toBe(false)
  })

  it('never re-spawns on repeated evaluations of the same workspace', () => {
    const runner = new MockRunner()
    const path = makePath(runner, { autoCreate: true })

    const first = path.handle('/repo')
    const second = path.handle('/repo')

    expect(first.action).toBe('indexing')
    expect(second.action).toBe('already-done')
    expect(second.indexing).toBe(true)
    expect(runner.calls.length).toBe(1)
  })

  it('passes an explicit index time budget when one is configured', async () => {
    const runner = new MockRunner()
    const path = new UnindexedPath({
      runner: runner as unknown as CgcRunner,
      autoCreate: true,
      indexTimeoutMs: 123_456,
    })

    path.handle('/repo')
    await path.whenSettled('/repo')

    expect(runner.calls[0]?.timeoutMs).toBe(123_456)
  })

  it('records a failed run once and never retries', async () => {
    const runner = new MockRunner()
    runner.results = [
      makeResult({ ok: false, code: 'COMMAND_FAILED', message: 'cgc exited with code 1' }),
    ]
    const path = makePath(runner, { autoCreate: true })

    path.handle('/repo')
    await path.whenSettled('/repo')

    expect(runner.calls.length).toBe(1)
    expect(path.result('/repo')?.ok).toBe(false)
    expect(path.result('/repo')?.code).toBe('COMMAND_FAILED')
    expect(path.status('/repo')).toBe('settled')
  })

  it('records a timeout outcome without retrying', async () => {
    const runner = new MockRunner()
    runner.results = [makeResult({ ok: false, code: 'TIMEOUT', message: 'budget exceeded' })]
    const path = makePath(runner, { autoCreate: true })

    path.handle('/repo')
    await path.whenSettled('/repo')

    expect(path.result('/repo')?.code).toBe('TIMEOUT')
    expect(runner.calls.length).toBe(1)
  })

  it('records a busy outcome as-is: no retry, no lock fighting', async () => {
    const runner = new MockRunner()
    runner.results = [
      makeResult({
        ok: false,
        code: 'BUSY',
        message: 'cgc reported an embedded-database lock conflict',
      }),
    ]
    const path = makePath(runner, { autoCreate: true })

    path.handle('/repo')
    await path.whenSettled('/repo')

    expect(path.result('/repo')?.code).toBe('BUSY')
    expect(runner.calls.length).toBe(1)
  })

  it('degrades to the one-time notice when starting the run throws synchronously', () => {
    const runner = new MockRunner()
    runner.overrideRun = () => {
      throw new Error('runner contract violated')
    }
    const path = makePath(runner, { autoCreate: true })

    const outcome = path.handle('/repo')

    expect(outcome.action).toBe('degraded')
    expect(outcome.indexing).toBe(false)
    expect(outcome.notice?.kind).toBe('indexing-degraded')
    expect(outcome.notice?.text).toContain('runner contract violated')
    expect(path.status('/repo')).toBe('degraded-to-notice')
  })

  it('captures a rejected run promise fail-open instead of rejecting the hook body', async () => {
    const runner = new MockRunner()
    runner.overrideRun = () => Promise.reject(new Error('runner exploded'))
    const path = makePath(runner, { autoCreate: true })

    const outcome = path.handle('/repo')

    expect(outcome.action).toBe('indexing')
    const result = await path.whenSettled('/repo')
    expect(result?.ok).toBe(false)
    expect(result?.code).toBe('COMMAND_FAILED')
    expect(result?.message).toContain('runner exploded')
    expect(runner.calls.length).toBe(1)
  })
})

describe('UnindexedPath lifecycle', () => {
  it('reset clears per-session state so the path can act again', () => {
    const runner = new MockRunner()
    const path = makePath(runner)

    path.handle('/repo')
    path.reset()

    expect(path.notices.length).toBe(0)
    expect(path.status('/repo')).toBe('unhandled')
    const again = path.handle('/repo')
    expect(again.repeated).toBe(false)
    expect(again.notice).not.toBeNull()
  })

  it('whenSettled resolves null for workspaces that never started indexing', async () => {
    const path = makePath(new MockRunner())
    expect(await path.whenSettled('/never-seen')).toBeNull()
  })
})

describe('UnindexedPath per-session invocation budget (task 2.7)', () => {
  it('consumes one maintenance slot when consented indexing starts', () => {
    const runner = new MockRunner()
    const budget = new SessionInvocationBudget()
    const path = new UnindexedPath({
      runner: runner as unknown as CgcRunner,
      autoCreate: true,
      budget,
    })

    expect(path.handle('/repo').action).toBe('indexing')
    expect(budget.used).toBe(1)
    expect(budget.remaining).toBe(budget.maxInvocations - 1)
  })

  it('degrades to the notice path without spawning when the budget is exhausted', () => {
    const runner = new MockRunner()
    const budget = new SessionInvocationBudget({ maxInvocations: 1 })
    budget.tryAcquire('/other', 'unindexed-indexing')
    const path = new UnindexedPath({
      runner: runner as unknown as CgcRunner,
      autoCreate: true,
      budget,
    })

    const outcome = path.handle('/repo')

    expect(outcome.action).toBe('degraded')
    expect(outcome.indexing).toBe(false)
    expect(outcome.notice).not.toBeNull()
    expect(outcome.notice?.text).toContain('budget exhausted')
    expect(runner.calls).toEqual([])
    expect(path.status('/repo')).toBe('degraded-to-notice')
  })

  it('never consumes budget on the notice path (autoCreate off spawns nothing)', () => {
    const runner = new MockRunner()
    const budget = new SessionInvocationBudget()
    const path = new UnindexedPath({
      runner: runner as unknown as CgcRunner,
      autoCreate: false,
      budget,
    })

    expect(path.handle('/repo').action).toBe('notice')
    expect(budget.used).toBe(0)
  })

  it('never consumes a second slot on repeated evaluation of the same workspace', () => {
    const runner = new MockRunner()
    const budget = new SessionInvocationBudget({ maxInvocations: 2 })
    const path = new UnindexedPath({
      runner: runner as unknown as CgcRunner,
      autoCreate: true,
      budget,
    })

    path.handle('/repo')
    const outcome = path.handle('/repo')

    expect(outcome.action).toBe('already-done')
    expect(budget.used).toBe(1)
    expect(runner.calls).toHaveLength(1)
  })
})
