import { describe, expect, it } from 'bun:test'
import { CLEAN_PATH_MAINTENANCE_INVOCATIONS, CleanPath } from './clean'

describe('CleanPath (task 2.7: clean skips silently)', () => {
  it('skips silently with zero maintenance invocations and no notice', () => {
    const path = new CleanPath()

    const outcome = path.handle('/repo')

    expect(outcome).toEqual({
      cwd: '/repo',
      action: 'skipped',
      repeated: false,
      maintenanceInvocations: CLEAN_PATH_MAINTENANCE_INVOCATIONS,
    })
    expect(CLEAN_PATH_MAINTENANCE_INVOCATIONS).toBe(0)
    expect(path.status('/repo')).toBe('skipped-clean')
    expect(path.isSkipped('/repo')).toBe(true)
  })

  it('is structurally incapable of spawning cgc commands', () => {
    // The constructor accepts no runner at all: there is no way to hand the
    // clean path a spawn capability, so "no maintenance invocations beyond
    // the cached probe" holds by construction.
    const path = new CleanPath()
    expect((path as unknown as { run?: unknown }).run).toBeUndefined()
    expect((path as unknown as { runner?: unknown }).runner).toBeUndefined()
  })

  it('is one-shot per workspace: repeated evaluations report already-done', () => {
    const path = new CleanPath()

    path.handle('/repo')
    const outcome = path.handle('/repo')

    expect(outcome.action).toBe('already-done')
    expect(outcome.repeated).toBe(true)
    expect(outcome.maintenanceInvocations).toBe(0)
    expect(path.status('/repo')).toBe('skipped-clean')
  })

  it('tracks workspaces independently', () => {
    const path = new CleanPath()

    path.handle('/repo-a')

    expect(path.status('/repo-a')).toBe('skipped-clean')
    expect(path.status('/repo-b')).toBe('unhandled')
    expect(path.handle('/repo-b').action).toBe('skipped')
    expect(path.handle('/repo-a').action).toBe('already-done')
  })

  it('never throws for any input a gate can produce', () => {
    const path = new CleanPath()

    expect(() => path.handle('')).not.toThrow()
    expect(() => path.handle('/spaces and \n weird')).not.toThrow()
  })

  it('resets all per-session state (fresh session)', () => {
    const path = new CleanPath()

    path.handle('/repo')
    path.reset()

    expect(path.status('/repo')).toBe('unhandled')
    expect(path.isSkipped('/repo')).toBe(false)
    expect(path.handle('/repo').action).toBe('skipped')
  })
})
