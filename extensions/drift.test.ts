import { describe, expect, it } from 'bun:test'
import { SessionInvocationBudget } from './budget'
import { DEFAULT_SYNC_ARGS, DriftPath } from './drift'
import type { CgcCommandResult, CgcRunner } from './runner'

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
    argv: [...DEFAULT_SYNC_ARGS],
    cwd: '/unused',
    ...overrides,
  }
}

/**
 * Minimal runner stand-in. Queues canned results for background sync runs;
 * unprefilled calls resolve with a healthy default so tests only specify
 * what matters.
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
  options: Partial<{ syncOnStart: boolean; syncTimeoutMs: number }> = {},
): DriftPath {
  return new DriftPath({
    runner: runner as unknown as CgcRunner,
    syncOnStart: options.syncOnStart ?? true,
    ...(options.syncTimeoutMs === undefined ? {} : { syncTimeoutMs: options.syncTimeoutMs }),
  })
}

describe('DriftPath with syncOnStart on (default)', () => {
  it('starts the incremental sync in the background and reports syncing', () => {
    const runner = new MockRunner()
    runner.results.push(makeResult({ code: 'OK', ok: true, durationMs: 1234 }))
    const path = makePath(runner)

    const outcome = path.handle('/repo')

    expect(outcome.action).toBe('syncing')
    expect(outcome.repeated).toBe(false)
    expect(outcome.syncing).toBe(true)
    expect(outcome.degradeReason).toBeNull()
    expect(runner.calls).toEqual([
      { cwd: '/repo', args: [...DEFAULT_SYNC_ARGS], timeoutMs: undefined },
    ])
    expect(path.status('/repo')).toBe('syncing')
    expect(path.isSyncing('/repo')).toBe(true)
    expect(path.result('/repo')).toBeNull()
  })

  it('runs the sync in the session workspace, never the process cwd', async () => {
    const runner = new MockRunner()
    const path = makePath(runner)

    path.handle('/some/session/workspace')
    await path.whenSettled('/some/session/workspace')

    expect(runner.calls[0]?.cwd).toBe('/some/session/workspace')
  })

  it('records the settled outcome in state and flips to settled', async () => {
    const runner = new MockRunner()
    runner.results.push(makeResult({ code: 'OK', ok: true, durationMs: 500 }))
    const path = makePath(runner)

    path.handle('/repo')
    const record = await path.whenSettled('/repo')

    expect(record).not.toBeNull()
    expect(record?.ok).toBe(true)
    expect(record?.code).toBe('OK')
    expect(record?.durationMs).toBe(500)
    expect(path.status('/repo')).toBe('settled')
    expect(path.isSyncing('/repo')).toBe(false)
    expect(path.result('/repo')).toEqual(record)
  })

  it('captures a failed sync into state without rejecting (fail open)', async () => {
    const runner = new MockRunner()
    runner.results.push(
      makeResult({ ok: false, code: 'COMMAND_FAILED', message: 'cgc exited with code 1' }),
    )
    const path = makePath(runner)

    path.handle('/repo')
    const record = await path.whenSettled('/repo')

    expect(record?.ok).toBe(false)
    expect(record?.code).toBe('COMMAND_FAILED')
    expect(path.status('/repo')).toBe('settled')
    expect(path.isSyncing('/repo')).toBe(false)
  })

  it('captures a busy (lock-conflict) outcome into state without retrying', async () => {
    const runner = new MockRunner()
    runner.results.push(makeResult({ ok: false, code: 'BUSY', message: 'lock held' }))
    const path = makePath(runner)

    path.handle('/repo')
    const record = await path.whenSettled('/repo')

    expect(record?.code).toBe('BUSY')
    expect(path.status('/repo')).toBe('settled')
    expect(path.isSyncing('/repo')).toBe(false)
    // No retries: exactly one spawn for the workspace.
    expect(runner.calls.length).toBe(1)
  })

  it('captures an unexpected runner settlement as COMMAND_FAILED (never rejects)', async () => {
    const runner = new MockRunner()
    runner.overrideRun = async () => {
      throw new Error('tracking exploded')
    }
    const path = makePath(runner)

    path.handle('/repo')
    const record = await path.whenSettled('/repo')

    expect(record?.ok).toBe(false)
    expect(record?.code).toBe('COMMAND_FAILED')
    expect(record?.message).toContain('tracking exploded')
    expect(path.status('/repo')).toBe('settled')
  })

  it('never throws when the runner itself throws at start time (degrade to degraded)', () => {
    const runner = new MockRunner()
    runner.overrideRun = () => {
      throw new TypeError('cgc runner: cwd is required')
    }
    const path = makePath(runner)

    const outcome = path.handle('/repo')

    expect(outcome.action).toBe('degraded')
    expect(outcome.syncing).toBe(false)
    expect(outcome.degradeReason).toContain('cwd is required')
    expect(path.status('/repo')).toBe('degraded')
    expect(path.isSyncing('/repo')).toBe(false)
  })

  it('starts at most one sync per workspace per session (one-time semantics)', () => {
    const runner = new MockRunner()
    const path = makePath(runner)

    const first = path.handle('/repo')
    const second = path.handle('/repo')

    expect(first.action).toBe('syncing')
    expect(second.action).toBe('already-done')
    expect(second.repeated).toBe(true)
    expect(second.degradeReason).toBeNull()
    expect(runner.calls.length).toBe(1)
    expect(path.status('/repo')).toBe('syncing')
  })

  it('keeps workspaces independent', () => {
    const runner = new MockRunner()
    const path = makePath(runner)

    const first = path.handle('/repo-a')
    const second = path.handle('/repo-b')

    expect(first.action).toBe('syncing')
    expect(second.action).toBe('syncing')
    expect(second.repeated).toBe(false)
    expect(runner.calls.length).toBe(2)
    expect(runner.calls.map((call) => call.cwd)).toEqual(['/repo-a', '/repo-b'])
  })

  it('passes the configured sync time budget through to the runner', () => {
    const runner = new MockRunner()
    const path = makePath(runner, { syncTimeoutMs: 60_000 })

    path.handle('/repo')

    expect(runner.calls[0]?.timeoutMs).toBe(60_000)
  })

  it('resolves whenSettled from the recorded result for a settled workspace', async () => {
    const runner = new MockRunner()
    runner.results.push(makeResult({ code: 'OK', ok: true }))
    const path = makePath(runner)

    path.handle('/repo')
    const settled = await path.whenSettled('/repo')
    // A later read (in-flight gone) must still return the recorded result.
    const again = await path.whenSettled('/repo')

    expect(again).toEqual(settled)
  })

  it('resolves whenSettled to null for an unhandled workspace', async () => {
    const runner = new MockRunner()
    const path = makePath(runner)

    expect(await path.whenSettled('/repo')).toBeNull()
    expect(runner.calls).toEqual([])
  })
})

describe('DriftPath with syncOnStart off (config switch)', () => {
  it('starts no sync and reports disabled', () => {
    const runner = new MockRunner()
    const path = makePath(runner, { syncOnStart: false })

    const outcome = path.handle('/repo')

    expect(outcome.action).toBe('disabled')
    expect(outcome.repeated).toBe(false)
    expect(outcome.syncing).toBe(false)
    expect(outcome.degradeReason).toBeNull()
    expect(runner.calls).toEqual([])
    expect(path.status('/repo')).toBe('disabled')
    expect(path.isSyncing('/repo')).toBe(false)
  })

  it('stays disabled on repeated evaluations (never spawns later in the session)', () => {
    const runner = new MockRunner()
    const path = makePath(runner, { syncOnStart: false })

    const first = path.handle('/repo')
    const second = path.handle('/repo')

    expect(first.action).toBe('disabled')
    expect(second.action).toBe('already-done')
    expect(second.repeated).toBe(true)
    expect(runner.calls).toEqual([])
  })
})

describe('DriftPath lifecycle', () => {
  it('resets all per-session state', async () => {
    const runner = new MockRunner()
    runner.results.push(makeResult({ code: 'OK', ok: true }))
    const path = makePath(runner)

    path.handle('/repo')
    await path.whenSettled('/repo')
    path.reset()

    expect(path.status('/repo')).toBe('unhandled')
    expect(path.result('/repo')).toBeNull()
    expect(path.isSyncing('/repo')).toBe(false)

    // After a reset the path handles the workspace again (fresh session).
    const outcome = path.handle('/repo')
    expect(outcome.action).toBe('syncing')
    expect(outcome.repeated).toBe(false)
  })

  it('reports unhandled status for unknown workspaces', () => {
    const runner = new MockRunner()
    const path = makePath(runner)

    expect(path.status('/never-seen')).toBe('unhandled')
    expect(path.result('/never-seen')).toBeNull()
    expect(path.isSyncing('/never-seen')).toBe(false)
  })
})

describe('DriftPath per-session invocation budget (task 2.7)', () => {
  it('consumes one maintenance slot when the sync starts', () => {
    const runner = new MockRunner()
    const budget = new SessionInvocationBudget()
    const path = new DriftPath({
      runner: runner as unknown as CgcRunner,
      syncOnStart: true,
      budget,
    })

    expect(path.handle('/repo').action).toBe('syncing')
    expect(budget.used).toBe(1)
    expect(budget.remaining).toBe(budget.maxInvocations - 1)
  })

  it('degrades without spawning when the budget is exhausted', () => {
    const runner = new MockRunner()
    const budget = new SessionInvocationBudget({ maxInvocations: 1 })
    budget.tryAcquire('/other', 'drift-sync')
    const path = new DriftPath({
      runner: runner as unknown as CgcRunner,
      syncOnStart: true,
      budget,
    })

    const outcome = path.handle('/repo')

    expect(outcome.action).toBe('degraded')
    expect(outcome.syncing).toBe(false)
    expect(outcome.degradeReason).toContain('budget exhausted')
    expect(runner.calls).toEqual([])
    expect(path.status('/repo')).toBe('degraded')
    expect(budget.used).toBe(1)
  })

  it('never consumes a second slot on repeated evaluation of the same workspace', () => {
    const runner = new MockRunner()
    const budget = new SessionInvocationBudget({ maxInvocations: 2 })
    const path = new DriftPath({
      runner: runner as unknown as CgcRunner,
      syncOnStart: true,
      budget,
    })

    path.handle('/repo')
    const outcome = path.handle('/repo')

    expect(outcome.action).toBe('already-done')
    expect(budget.used).toBe(1)
    expect(runner.calls).toHaveLength(1)
  })

  it('spends the slot even when the start fails, so failures cannot loop the cap', () => {
    const runner = new MockRunner()
    runner.overrideRun = () => {
      throw new TypeError('contract violation injected')
    }
    const budget = new SessionInvocationBudget({ maxInvocations: 2 })
    const path = new DriftPath({
      runner: runner as unknown as CgcRunner,
      syncOnStart: true,
      budget,
    })

    expect(path.handle('/repo').action).toBe('degraded')
    expect(budget.used).toBe(1)
  })
})
