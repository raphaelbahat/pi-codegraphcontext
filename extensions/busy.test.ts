import { describe, expect, it } from 'bun:test'
import { BusyPath, buildBusyNotice } from './busy'

const CWD = '/repo'

describe('BusyPath.handle (lock-holding probe trigger)', () => {
  it('skips as busy with a one-time notice and spawns nothing', () => {
    const path = new BusyPath()

    const outcome = path.handle(
      CWD,
      'another CGC process holds the embedded database (lock conflict)',
    )

    expect(outcome.action).toBe('skipped')
    expect(outcome.repeated).toBe(false)
    expect(outcome.notice?.kind).toBe('busy')
    expect(outcome.notice?.text).toContain(CWD)
    expect(path.status(CWD)).toBe('busy-skipped')
    expect(path.isBusy(CWD)).toBe(true)
  })

  it('is one-time per workspace: a repeat evaluation re-notifies nothing', () => {
    const path = new BusyPath()
    path.handle(CWD)

    const repeat = path.handle(CWD, 'a different reason string')

    expect(repeat.action).toBe('already-done')
    expect(repeat.repeated).toBe(true)
    expect(repeat.notice).toBeNull()
    expect(path.notices).toHaveLength(1)
  })

  it('works without a reason string', () => {
    const path = new BusyPath()

    const outcome = path.handle(CWD)

    expect(outcome.action).toBe('skipped')
    expect(outcome.notice?.text).toContain('busy')
    // The default evidence names the probe that observed the conflict.
    expect(path.record(CWD)?.source).toBe('probe')
  })

  it('records the probe evidence for later surfaces', () => {
    const path = new BusyPath()
    path.handle(CWD, 'health probe hit the lock')

    const record = path.record(CWD)
    expect(record?.source).toBe('probe')
    expect(record?.code).toBe('BUSY')
    expect(record?.message).toBe('health probe hit the lock')
    expect(record?.at).toBeGreaterThan(0)
  })
})

describe('BusyPath.reportLockError (lock-error trigger)', () => {
  it('surfaces the one-time notice for a BUSY maintenance outcome', () => {
    const path = new BusyPath()

    const outcome = path.reportLockError(CWD, {
      code: 'BUSY',
      message:
        'cgc reported an embedded-database lock conflict (another CGC process holds the workspace)',
    })

    expect(outcome.action).toBe('skipped')
    expect(outcome.repeated).toBe(false)
    expect(outcome.notice?.kind).toBe('busy')
    expect(path.status(CWD)).toBe('busy-skipped')
    expect(path.isBusy(CWD)).toBe(true)
    expect(path.record(CWD)?.source).toBe('command')
  })

  it('ignores non-BUSY outcomes without recording or notifying', () => {
    const path = new BusyPath()

    const timeout = path.reportLockError(CWD, { code: 'TIMEOUT', message: 'timed out' })
    const failed = path.reportLockError(CWD, { code: 'COMMAND_FAILED', message: 'exited 1' })

    expect(timeout.action).toBe('ignored')
    expect(failed.action).toBe('ignored')
    expect(path.notices).toHaveLength(0)
    expect(path.status(CWD)).toBe('unhandled')
    expect(path.isBusy(CWD)).toBe(false)
    expect(path.record(CWD)).toBeNull()
  })

  it('ignores malformed reports instead of throwing (fail-open)', () => {
    const path = new BusyPath()

    expect(path.reportLockError(CWD, null).action).toBe('ignored')
    expect(path.reportLockError(CWD, undefined).action).toBe('ignored')
    expect(
      path.reportLockError(CWD, { code: 'BUSY', message: 42 as unknown as string }).action,
    ).toBe('ignored')
    expect(path.notices).toHaveLength(0)
    expect(path.status(CWD)).toBe('unhandled')
  })

  it('is one-time across both triggers: a lock error after the probe notice re-notifies nothing', () => {
    const path = new BusyPath()
    path.handle(CWD, 'probe saw the lock')

    const repeat = path.reportLockError(CWD, { code: 'BUSY', message: 'sync settled BUSY' })

    expect(repeat.action).toBe('already-done')
    expect(repeat.repeated).toBe(true)
    expect(repeat.notice).toBeNull()
    expect(path.notices).toHaveLength(1)
    // The latest evidence is still recorded (state bookkeeping, not a notice).
    expect(path.record(CWD)?.source).toBe('command')
    expect(path.record(CWD)?.message).toBe('sync settled BUSY')
  })

  it('is one-time across both triggers: a probe busy after a lock error re-notifies nothing', () => {
    const path = new BusyPath()
    path.reportLockError(CWD, { code: 'BUSY', message: 'indexing settled BUSY' })

    const repeat = path.handle(CWD, 'probe saw the lock later')

    expect(repeat.action).toBe('already-done')
    expect(path.notices).toHaveLength(1)
    expect(path.isBusy(CWD)).toBe(true)
  })

  it('never retries: an ignored report leaves the workspace unhandled for a later real lock', () => {
    const path = new BusyPath()
    path.reportLockError(CWD, { code: 'TIMEOUT', message: 'timed out' })

    const skipped = path.reportLockError(CWD, { code: 'BUSY', message: 'then it hit the lock' })

    expect(skipped.action).toBe('skipped')
    expect(path.notices).toHaveLength(1)
    expect(path.record(CWD)?.code).toBe('BUSY')
  })
})

describe('BusyPath notices', () => {
  it('routes notices to the sink and records them for later surfaces', () => {
    const seen: string[] = []
    const path = new BusyPath({ onNotice: (notice) => seen.push(notice.kind) })
    path.handle(CWD)
    path.reportLockError('/other', { code: 'BUSY', message: 'locked' })

    expect(seen).toEqual(['busy', 'busy'])
    expect(path.notices.map((notice) => notice.kind)).toEqual(['busy', 'busy'])
  })

  it('a throwing notice sink never breaks the path', () => {
    const path = new BusyPath({
      onNotice: () => {
        throw new Error('sink exploded')
      },
    })

    const outcome = path.handle(CWD)

    expect(outcome.action).toBe('skipped')
    expect(path.notices).toHaveLength(1)
  })
})

describe('BusyPath state', () => {
  it('untracked workspaces read as unhandled and not busy', () => {
    const path = new BusyPath()

    expect(path.status('/never-seen')).toBe('unhandled')
    expect(path.isBusy('/never-seen')).toBe(false)
    expect(path.record('/never-seen')).toBeNull()
    expect(path.notices).toHaveLength(0)
  })

  it('reset clears all per-session state', () => {
    const path = new BusyPath()
    path.handle(CWD)

    path.reset()

    expect(path.status(CWD)).toBe('unhandled')
    expect(path.isBusy(CWD)).toBe(false)
    expect(path.record(CWD)).toBeNull()
    expect(path.notices).toHaveLength(0)
    // After a reset the workspace can be reported fresh.
    expect(path.handle(CWD).action).toBe('skipped')
  })

  it('tracks distinct workspaces independently', () => {
    const path = new BusyPath()
    path.handle(CWD)

    expect(path.isBusy('/other')).toBe(false)
    const other = path.handle('/other', 'different workspace, same lock')

    expect(other.action).toBe('skipped')
    expect(path.notices).toHaveLength(2)
  })
})

describe('notice builders', () => {
  it('the busy notice names the conflict, the no-force policy, and the one-time promise', () => {
    const text = buildBusyNotice(CWD, 'cgc index . settled with a lock conflict')
    expect(text).toContain(CWD)
    expect(text).toContain('busy')
    expect(text).toContain('cgc index . settled with a lock conflict')
    expect(text).toContain('will not retry')
    expect(text).toContain('will never delete lock files')
    expect(text).toContain('notified again this session')
  })

  it('the busy notice works without a detected detail', () => {
    const text = buildBusyNotice(CWD)
    expect(text).toContain(CWD)
    expect(text).toContain('holding the embedded database')
    expect(text).toContain('Nothing was modified')
  })
})
