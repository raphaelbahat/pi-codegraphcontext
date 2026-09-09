import { describe, expect, it } from 'bun:test'
import {
  buildCorruptNotice,
  buildRebuildRefusedNotice,
  buildRebuildStartedNotice,
  CorruptPath,
  DEFAULT_REBUILD_ARGS,
} from './corrupt'
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
    argv: [...DEFAULT_REBUILD_ARGS],
    cwd: '/unused',
    ...overrides,
  }
}

/**
 * Minimal runner stand-in. Queues canned results for background rebuild runs;
 * unprefilled calls resolve with a healthy default so tests only specify what
 * matters.
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

const CWD = '/repo'

function makePath(
  runner: MockRunner,
  options: Partial<{ onNotice: (notice: { kind: string }) => void }> = {},
): CorruptPath {
  return new CorruptPath({
    runner: runner as unknown as CgcRunner,
    ...(options.onNotice === undefined ? {} : { onNotice: options.onNotice as never }),
  })
}

describe('CorruptPath.handle', () => {
  it('reports the corrupt state and offers a rebuild without spawning anything', () => {
    const runner = new MockRunner()
    const path = makePath(runner)

    const outcome = path.handle(CWD, 'index health probe reported corruption markers')

    expect(outcome.action).toBe('notified')
    expect(outcome.repeated).toBe(false)
    expect(outcome.rebuilding).toBe(false)
    expect(outcome.notice?.kind).toBe('corrupt')
    expect(runner.calls).toEqual([])
    expect(path.status(CWD)).toBe('noticed')
  })

  it('is one-time per workspace: a repeat evaluation re-notifies nothing', () => {
    const runner = new MockRunner()
    const path = makePath(runner)
    path.handle(CWD)

    const repeat = path.handle(CWD)

    expect(repeat.action).toBe('already-done')
    expect(repeat.repeated).toBe(true)
    expect(repeat.notice).toBeNull()
    expect(runner.calls).toEqual([])
    expect(path.notices).toHaveLength(1)
  })

  it('reports rebuilding=true on a repeat while a confirmed rebuild is in flight', () => {
    const runner = new MockRunner()
    const path = makePath(runner)
    path.handle(CWD)
    path.rebuild(CWD, { confirm: true })

    const repeat = path.handle(CWD)

    expect(repeat.action).toBe('already-done')
    expect(repeat.rebuilding).toBe(true)
  })
})

describe('CorruptPath.rebuild confirmation gate', () => {
  it('refuses to rebuild without explicit confirmation and spawns nothing', () => {
    const runner = new MockRunner()
    const path = makePath(runner)

    // Runtime-level refusals are exercised with casts: TypeScript callers can
    // never even construct a non-true request, but JS callers can, and the
    // runtime gate must still hold.
    const refused = path.rebuild(CWD, { confirm: false as true })
    expect(refused.action).toBe('refused')
    expect(refused.rebuilding).toBe(false)
    expect(refused.refuseReason).toContain('no explicit confirmation')

    const shapeless = path.rebuild(CWD, { confirm: undefined as unknown as true })
    expect(shapeless.action).toBe('refused')

    const missing = path.rebuild(CWD, {} as never)
    expect(missing.action).toBe('refused')

    expect(runner.calls).toEqual([])
    expect(path.status(CWD)).not.toBe('rebuilding')
    expect(path.notices.at(-1)?.kind).toBe('rebuild-refused')
  })

  it('starts the full rebuild only with confirm: true', () => {
    const runner = new MockRunner()
    runner.results.push(makeResult({ ok: true, code: 'OK', durationMs: 4321 }))
    const path = makePath(runner)

    const outcome = path.rebuild(CWD, { confirm: true })

    expect(outcome.action).toBe('rebuilding')
    expect(outcome.rebuilding).toBe(true)
    expect(outcome.refuseReason).toBeNull()
    expect(runner.calls).toEqual([
      { cwd: CWD, args: [...DEFAULT_REBUILD_ARGS], timeoutMs: undefined },
    ])
    expect(path.status(CWD)).toBe('rebuilding')
    expect(path.isRebuilding(CWD)).toBe(true)
    expect(path.notices.at(-1)?.kind).toBe('rebuild-started')
  })

  it('never retries: a second confirmed request after a started rebuild does nothing', async () => {
    const runner = new MockRunner()
    const path = makePath(runner)
    path.rebuild(CWD, { confirm: true })
    await path.whenSettled(CWD)

    const second = path.rebuild(CWD, { confirm: true })

    expect(second.action).toBe('already-done')
    expect(second.rebuilding).toBe(false)
    expect(runner.calls).toHaveLength(1)
  })

  it('a refusal consumes nothing: a later confirmed request still rebuilds', () => {
    const runner = new MockRunner()
    const path = makePath(runner)
    path.rebuild(CWD, { confirm: false as true })

    const confirmed = path.rebuild(CWD, { confirm: true })

    expect(confirmed.action).toBe('rebuilding')
    expect(runner.calls).toHaveLength(1)
  })
})

describe('CorruptPath.rebuild settlement', () => {
  it('records the settled outcome and reports settled state', async () => {
    const runner = new MockRunner()
    runner.results.push(makeResult({ ok: true, code: 'OK', durationMs: 4321 }))
    const path = makePath(runner)
    path.rebuild(CWD, { confirm: true })

    const result = await path.whenSettled(CWD)

    expect(result).not.toBeNull()
    expect(result?.ok).toBe(true)
    expect(result?.code).toBe('OK')
    expect(result?.durationMs).toBe(4321)
    expect(path.status(CWD)).toBe('settled')
    expect(path.isRebuilding(CWD)).toBe(false)
    expect(path.result(CWD)?.at).toBeGreaterThan(0)
  })

  it('records a busy outcome as-is without retrying or forcing', async () => {
    const runner = new MockRunner()
    runner.results.push(
      makeResult({
        ok: false,
        code: 'BUSY',
        message: 'cgc index .: another process holds the lock',
      }),
    )
    const path = makePath(runner)
    path.rebuild(CWD, { confirm: true })

    const result = await path.whenSettled(CWD)

    expect(result?.ok).toBe(false)
    expect(result?.code).toBe('BUSY')
    expect(path.status(CWD)).toBe('settled')
    // No retries, no second spawn, no lock-file deletion of any kind.
    expect(runner.calls).toHaveLength(1)
  })

  it('captures an unexpected runner rejection into state instead of rejecting', async () => {
    const runner = new MockRunner()
    runner.overrideRun = () => Promise.reject(new Error('runner exploded'))
    const path = makePath(runner)
    path.rebuild(CWD, { confirm: true })

    const result = await path.whenSettled(CWD)

    expect(result?.ok).toBe(false)
    expect(result?.code).toBe('COMMAND_FAILED')
    expect(result?.message).toContain('runner exploded')
    expect(path.status(CWD)).toBe('settled')
  })

  it('degrades to a recorded status when the rebuild cannot be started', () => {
    const runner = new MockRunner()
    runner.overrideRun = () => {
      throw new Error('contract violation')
    }
    const path = makePath(runner)

    const outcome = path.rebuild(CWD, { confirm: true })

    expect(outcome.action).toBe('degraded')
    expect(outcome.rebuilding).toBe(false)
    expect(outcome.notice?.kind).toBe('rebuild-degraded')
    expect(path.status(CWD)).toBe('degraded')
    // The corrupt index was left untouched; the failed start is never retried.
    const callsAfterDegradedStart = runner.calls.length
    const second = path.rebuild(CWD, { confirm: true })
    expect(second.action).toBe('already-done')
    expect(runner.calls).toHaveLength(callsAfterDegradedStart)
  })
})

describe('CorruptPath notices', () => {
  it('routes notices to the sink and records them for later surfaces', () => {
    const seen: string[] = []
    const runner = new MockRunner()
    const path = new CorruptPath({
      runner: runner as unknown as CgcRunner,
      onNotice: (notice) => seen.push(notice.kind),
    })
    path.handle(CWD)
    path.rebuild(CWD, { confirm: false as true })

    expect(seen).toEqual(['corrupt', 'rebuild-refused'])
    expect(path.notices.map((notice) => notice.kind)).toEqual(['corrupt', 'rebuild-refused'])
  })

  it('a throwing notice sink never breaks the path', () => {
    const runner = new MockRunner()
    const path = new CorruptPath({
      runner: runner as unknown as CgcRunner,
      onNotice: () => {
        throw new Error('sink exploded')
      },
    })

    const outcome = path.handle(CWD)

    expect(outcome.action).toBe('notified')
    expect(path.notices).toHaveLength(1)
    expect(runner.calls).toEqual([])
  })

  it('reset clears all per-session state', async () => {
    const runner = new MockRunner()
    const path = makePath(runner)
    path.handle(CWD)
    path.rebuild(CWD, { confirm: true })
    await path.whenSettled(CWD)

    path.reset()

    expect(path.status(CWD)).toBe('unhandled')
    expect(path.result(CWD)).toBeNull()
    expect(path.isRebuilding(CWD)).toBe(false)
    expect(path.notices).toHaveLength(0)
    // After a reset the workspace can be reported fresh.
    expect(path.handle(CWD).action).toBe('notified')
  })
})

describe('notice builders', () => {
  it('the corrupt offer names the state, the cost, and the no-auto-destruct promise', () => {
    const text = buildCorruptNotice(CWD, DEFAULT_REBUILD_ARGS, 'probe was inconclusive')
    expect(text).toContain(CWD)
    expect(text).toContain('corrupt or unusable')
    expect(text).toContain('probe was inconclusive')
    expect(text).toContain('cgc index . --force')
    expect(text).toContain('Nothing has been changed or deleted')
    expect(text).toContain('explicitly confirm')
  })

  it('the started notice names the background command', () => {
    const text = buildRebuildStartedNotice(CWD, DEFAULT_REBUILD_ARGS)
    expect(text).toContain(CWD)
    expect(text).toContain('cgc index . --force')
    expect(text).toContain('background')
  })

  it('the refused notice makes the no-op explicit', () => {
    const text = buildRebuildRefusedNotice(CWD, 'no explicit confirmation was provided')
    expect(text).toContain(CWD)
    expect(text).toContain('was not started')
    expect(text).toContain('Nothing was changed or deleted')
  })
})
