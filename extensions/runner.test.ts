import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CgcRunner } from './runner'

const BUN = process.execPath

const HANG_SCRIPT = 'setInterval(() => {}, 60_000)'
const SLOW_DONE_SCRIPT = 'setTimeout(() => { console.log("done") }, 150)'

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'cgc-runner-test-'))
}

function cleanupWorkspace(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

function envWith(entries: Record<string, string>): NodeJS.ProcessEnv {
  return { ...entries }
}

describe('CgcRunner', () => {
  it('spawns with the explicit cwd and captures output', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write(process.cwd())'],
        env: {},
      })

      expect(result.ok).toBe(true)
      expect(result.code).toBe('OK')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(workspace)
      expect(result.cwd).toBe(workspace)
      expect(result.truncated).toBe(false)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('passes arguments verbatim as an argument array (no shell parsing)', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write(process.env.CGC_PROBE ?? "")'],
        env: envWith({ CGC_PROBE: 'a; rm -rf / && $(boom) | cat' }),
      })

      expect(result.ok).toBe(true)
      expect(result.stdout).toBe('a; rm -rf / && $(boom) | cat')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('captures stderr and maps non-zero exits to COMMAND_FAILED', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const result = await runner.run(workspace, {
        args: ['-e', 'console.error("boom"); process.exit(3)'],
        env: {},
      })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('COMMAND_FAILED')
      expect(result.exitCode).toBe(3)
      expect(result.stderr).toContain('boom')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('maps lock-conflict output on a failed command to BUSY', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const result = await runner.run(workspace, {
        args: ['-e', 'console.error("database is locked by another process"); process.exit(1)'],
        env: {},
      })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('BUSY')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('does not map a successful command mentioning locks to BUSY', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const result = await runner.run(workspace, {
        args: ['-e', 'console.log("lock file checked"); process.exit(0)'],
        env: {},
      })

      expect(result.ok).toBe(true)
      expect(result.code).toBe('OK')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('terminates a hung command at the time budget and reports TIMEOUT', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const result = await runner.run(workspace, {
        args: ['-e', HANG_SCRIPT],
        env: {},
        timeoutMs: 150,
      })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('TIMEOUT')
      expect(result.exitCode).toBeNull()
      expect(result.durationMs).toBeLessThan(5_000)
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('cancels via an abort signal and reports CANCELLED', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 80)
      const result = await runner.run(workspace, {
        args: ['-e', HANG_SCRIPT],
        env: {},
        signal: controller.signal,
      })

      expect(result.code).toBe('CANCELLED')
      expect(result.ok).toBe(false)
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('reports CANCELLED without spawning when the signal is already aborted', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const controller = new AbortController()
      controller.abort()
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("should not run")'],
        env: {},
        signal: controller.signal,
      })

      expect(result.code).toBe('CANCELLED')
      expect(result.stdout).toBe('')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('reports UNAVAILABLE when the executable cannot be spawned', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: 'cgc-definitely-not-installed-xyz' })
      const result = await runner.run(workspace, { args: ['--version'], env: {} })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('UNAVAILABLE')
      expect(result.exitCode).toBeNull()
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('reports UNAVAILABLE when the cwd does not exist', async () => {
    const runner = new CgcRunner({ executable: BUN })
    const result = await runner.run('/nonexistent-cgc-runner-workspace', {
      args: ['-e', 'process.exit(0)'],
      env: {},
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('UNAVAILABLE')
  })

  it('bounds captured output and keeps the most recent bytes', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const maxOutputBytes = 4 * 1024
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("x".repeat(1024 * 1024))'],
        env: {},
        maxOutputBytes,
      })

      expect(result.ok).toBe(true)
      expect(result.truncated).toBe(true)
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(maxOutputBytes)
      // Tail retention: the final bytes of the stream must be present.
      expect(result.stdout.endsWith('xx')).toBe(true)
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('deduplicates identical concurrent invocations per workspace', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const run = () => runner.run(workspace, { args: ['-e', SLOW_DONE_SCRIPT], env: {} })
      const first = run()
      const second = run()

      expect(runner.isInFlight(workspace)).toBe(true)
      const [firstResult, secondResult] = await Promise.all([first, second])

      expect(firstResult).toBe(secondResult)
      expect(firstResult.code).toBe('OK')
      expect(runner.isInFlight(workspace)).toBe(false)
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('runs distinct commands for the same workspace in parallel without sharing', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const first = runner.run(workspace, { args: ['-e', 'console.log("one")'], env: {} })
      const second = runner.run(workspace, { args: ['-e', 'console.log("two")'], env: {} })
      const [firstResult, secondResult] = await Promise.all([first, second])

      expect(firstResult).not.toBe(secondResult)
      expect(firstResult.stdout).toBe('one\n')
      expect(secondResult.stdout).toBe('two\n')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('does not deduplicate the same args across different workspaces', async () => {
    const workspaceA = makeWorkspace()
    const workspaceB = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const args = ['-e', 'process.stdout.write(process.cwd())']
      const first = runner.run(workspaceA, { args, env: {} })
      const second = runner.run(workspaceB, { args, env: {} })
      const [firstResult, secondResult] = await Promise.all([first, second])

      expect(firstResult).not.toBe(secondResult)
      expect(firstResult.stdout).toBe(workspaceA)
      expect(secondResult.stdout).toBe(workspaceB)
    } finally {
      cleanupWorkspace(workspaceA)
      cleanupWorkspace(workspaceB)
    }
  })

  it('killAll terminates in-flight children and pending runs settle as CANCELLED', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const pending = runner.run(workspace, { args: ['-e', HANG_SCRIPT], env: {} })
      await new Promise((resolve) => setTimeout(resolve, 80))

      await runner.killAll()
      const result = await pending

      expect(result.code).toBe('CANCELLED')
      expect(runner.isInFlight(workspace)).toBe(false)
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('rejects contract violations instead of spawning', () => {
    const runner = new CgcRunner({ executable: BUN })
    expect(() => runner.run('', { args: ['--version'], env: {} })).toThrow(TypeError)
    expect(() =>
      runner.run('/tmp', { args: ['--flag', 42 as unknown as string], env: {} }),
    ).toThrow(TypeError)
  })

  it('falls back to the default time budget for invalid per-call budgets', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN, defaultTimeoutMs: 150 })
      const result = await runner.run(workspace, {
        args: ['-e', HANG_SCRIPT],
        env: {},
        timeoutMs: -5,
      })

      expect(result.code).toBe('TIMEOUT')
      expect(result.durationMs).toBeLessThan(5_000)
    } finally {
      cleanupWorkspace(workspace)
    }
  })
})
