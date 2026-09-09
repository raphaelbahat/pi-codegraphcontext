import { describe, expect, it } from 'bun:test'
import { DEFAULT_MAX_MAINTENANCE_INVOCATIONS_PER_SESSION, SessionInvocationBudget } from './budget'

describe('SessionInvocationBudget (task 2.7: per-session invocation budget)', () => {
  it('defaults to the documented per-session cap', () => {
    const budget = new SessionInvocationBudget()
    expect(budget.maxInvocations).toBe(DEFAULT_MAX_MAINTENANCE_INVOCATIONS_PER_SESSION)
    expect(budget.used).toBe(0)
    expect(budget.remaining).toBe(DEFAULT_MAX_MAINTENANCE_INVOCATIONS_PER_SESSION)
    expect(budget.exhausted).toBe(false)
  })

  it('grants and consumes slots until the cap, then refuses without consuming', () => {
    const budget = new SessionInvocationBudget({ maxInvocations: 2 })

    const first = budget.tryAcquire('/repo-a', 'drift-sync')
    expect(first.granted).toBe(true)
    expect(first.reason).toBeNull()
    expect(first.used).toBe(1)
    expect(first.remaining).toBe(1)

    const second = budget.tryAcquire('/repo-b', 'unindexed-indexing')
    expect(second.granted).toBe(true)
    expect(budget.exhausted).toBe(true)

    const third = budget.tryAcquire('/repo-c', 'drift-sync')
    expect(third.granted).toBe(false)
    expect(third.reason).toContain('budget exhausted')
    expect(third.reason).toContain('2/2')
    expect(third.used).toBe(2)
    expect(third.remaining).toBe(0)
    expect(budget.used).toBe(2)
  })

  it('is session-wide: the cap spans workspaces and purposes', () => {
    const budget = new SessionInvocationBudget({ maxInvocations: 3 })

    for (const [cwd, purpose] of [
      ['/w1', 'drift-sync'],
      ['/w2', 'unindexed-indexing'],
      ['/w1', 'unindexed-indexing'],
    ] as const) {
      expect(budget.tryAcquire(cwd, purpose).granted).toBe(true)
    }
    expect(budget.tryAcquire('/w3', 'drift-sync').granted).toBe(false)
  })

  it('floors fractional caps and falls back to the default for invalid values', () => {
    expect(new SessionInvocationBudget({ maxInvocations: 2.9 }).maxInvocations).toBe(2)
    expect(new SessionInvocationBudget({ maxInvocations: 0 }).maxInvocations).toBe(
      DEFAULT_MAX_MAINTENANCE_INVOCATIONS_PER_SESSION,
    )
    expect(new SessionInvocationBudget({ maxInvocations: -5 }).maxInvocations).toBe(
      DEFAULT_MAX_MAINTENANCE_INVOCATIONS_PER_SESSION,
    )
    expect(new SessionInvocationBudget({ maxInvocations: Number.NaN }).maxInvocations).toBe(
      DEFAULT_MAX_MAINTENANCE_INVOCATIONS_PER_SESSION,
    )
  })

  it('throws only on caller contract violations', () => {
    const budget = new SessionInvocationBudget()
    expect(() => budget.tryAcquire('', 'drift-sync')).toThrow(TypeError)
    expect(() => budget.tryAcquire('/repo', '')).toThrow(TypeError)
    expect(() => budget.tryAcquire(undefined as unknown as string, 'drift-sync')).toThrow(TypeError)
  })

  it('resets all per-session accounting (fresh session)', () => {
    const budget = new SessionInvocationBudget({ maxInvocations: 1 })
    budget.tryAcquire('/repo', 'drift-sync')
    expect(budget.claimRetry('/repo', 'drift-sync')).toBe(true)

    budget.reset()

    expect(budget.used).toBe(0)
    expect(budget.exhausted).toBe(false)
    expect(budget.hasRetryBeenClaimed('/repo', 'drift-sync')).toBe(false)
    expect(budget.tryAcquire('/repo', 'drift-sync').granted).toBe(true)
  })
})

describe('SessionInvocationBudget retry ledger (task 2.7: one-retry cap)', () => {
  it('allows exactly one retry per (workspace, work) pair per session', () => {
    const budget = new SessionInvocationBudget()

    expect(budget.claimRetry('/repo', 'drift-sync')).toBe(true)
    expect(budget.hasRetryBeenClaimed('/repo', 'drift-sync')).toBe(true)
    expect(budget.claimRetry('/repo', 'drift-sync')).toBe(false)
    // The cap is one, total — not one per evaluation.
    expect(budget.claimRetry('/repo', 'drift-sync')).toBe(false)
  })

  it('tracks pairs independently by workspace and work', () => {
    const budget = new SessionInvocationBudget()

    expect(budget.claimRetry('/repo-a', 'drift-sync')).toBe(true)
    expect(budget.claimRetry('/repo-b', 'drift-sync')).toBe(true)
    expect(budget.claimRetry('/repo-a', 'unindexed-indexing')).toBe(true)
    expect(budget.claimRetry('/repo-a', 'drift-sync')).toBe(false)
    expect(budget.hasRetryBeenClaimed('/repo-c', 'drift-sync')).toBe(false)
  })

  it('does not consume an invocation slot', () => {
    const budget = new SessionInvocationBudget({ maxInvocations: 1 })
    budget.claimRetry('/repo', 'drift-sync')
    expect(budget.used).toBe(0)
    expect(budget.tryAcquire('/repo', 'drift-sync').granted).toBe(true)
  })

  it('throws only on caller contract violations', () => {
    const budget = new SessionInvocationBudget()
    expect(() => budget.claimRetry('', 'drift-sync')).toThrow(TypeError)
    expect(() => budget.claimRetry('/repo', '')).toThrow(TypeError)
    expect(budget.hasRetryBeenClaimed('', 'drift-sync')).toBe(false)
  })
})
