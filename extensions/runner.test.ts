import { describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** An executable that prints its argv, one argument per line. */
function makeArgvEcho(): { dir: string; executable: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cgc-runner-argv-'))
  const executable = join(dir, 'argv-echo')
  writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n', 'utf8')
  chmodSync(executable, 0o755)
  return { dir, executable }
}

/** An executable that appends the joined argv to a log, then echoes it. */
function makeArgvLogger(logPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cgc-runner-logger-'))
  const executable = join(dir, 'argv-logger')
  // The log path is embedded at creation time; single-quote it for the shell.
  const quoted = `'${logPath.replace(/'/g, `'\\''`)}'`
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quoted}\nprintf '%s\\n' "$@"\n`,
    'utf8',
  )
  chmodSync(executable, 0o755)
  return executable
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

  it('writes the optional stdin text to the child then closes it (CLI confirm-answer escape hatch)', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const result = await runner.run(workspace, {
        args: ['-e', 'console.log("GOT:" + (await Bun.stdin.text()).trim())'],
        env: {},
        stdin: 'y\n',
      })

      expect(result.ok).toBe(true)
      expect(result.code).toBe('OK')
      expect(result.stdout).toContain('GOT:y')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('leaves stdin at /dev/null when no stdin is supplied, so an interactive prompt sees EOF (fail-closed, never a hang)', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const result = await runner.run(workspace, {
        args: [
          '-e',
          'console.log("EOF:" + ((await Bun.stdin.text()).trim().length === 0 ? "empty" : "input"))',
        ],
        env: {},
      })

      expect(result.ok).toBe(true)
      expect(result.stdout).toContain('EOF:empty')
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

  it('bounds captured output preserving head and tail with an explicit marker', async () => {
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
      // The delivered text respects the policy budget in characters (the unit
      // the bound uses); the byte count is at most the marker's UTF-8 slack
      // (the ellipsis) above it.
      expect(result.stdout.length).toBeLessThanOrEqual(maxOutputBytes)
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(maxOutputBytes + 16)
      // Head+tail retention (design D2): the beginning AND the end survive.
      expect(result.stdout.startsWith('xx')).toBe(true)
      expect(result.stdout.endsWith('xx')).toBe(true)
      // The truncation marker is explicit and states the ORIGINAL size.
      expect(result.stdout).toContain('truncated')
      expect(result.stdout).toContain('original 1048576 chars')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('strips control sequences from captured output before delivery', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("\\u001b[32mok\\u001b[0m")'],
        env: {},
      })

      expect(result.ok).toBe(true)
      expect(result.stdout).toBe('ok')
      expect(result.stdout).not.toContain('\u001b')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('redacts secret-shaped assignments from captured output before delivery', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("api_key=abcdef1234567890")'],
        env: {},
      })

      expect(result.ok).toBe(true)
      expect(result.stdout).toBe('api_key=[REDACTED]')
      expect(result.stdout).not.toContain('abcdef1234567890')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('applies the output policy to stderr too (uniform before any consumer)', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const result = await runner.run(workspace, {
        args: [
          '-e',
          'process.stderr.write("\\u001b[31merror\\u001b[0m token=deadbeefcafe"); process.exit(1)',
        ],
        env: {},
      })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('COMMAND_FAILED')
      expect(result.stderr).toBe('error token=[REDACTED]')
      expect(result.stderr).not.toContain('\u001b')
      expect(result.stderr).not.toContain('deadbeefcafe')
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

  describe('--context injection (task 2.2: carry the mapped flag)', () => {
    it('prepends --context <name> to every invocation while the resolver yields a name', async () => {
      const fixture = makeArgvEcho()
      const workspace = makeWorkspace()
      try {
        const runner = new CgcRunner({
          executable: fixture.executable,
          contextResolver: () => 'wt-branch-a',
        })
        const result = await runner.run(workspace, {
          args: ['stats'],
          env: {},
        })
        expect(result.ok).toBe(true)
        expect(result.argv).toEqual(['--context', 'wt-branch-a', 'stats'])
        expect(result.stdout.trim().split('\n')).toEqual(['--context', 'wt-branch-a', 'stats'])
      } finally {
        cleanupWorkspace(workspace)
        cleanupWorkspace(fixture.dir)
      }
    })

    it('leaves argv untouched (no injection) when the resolver returns null or empty', async () => {
      const fixture = makeArgvEcho()
      const workspace = makeWorkspace()
      try {
        for (const name of [null, ''] as readonly (string | null)[]) {
          const runner = new CgcRunner({
            executable: fixture.executable,
            contextResolver: () => name,
          })
          const result = await runner.run(workspace, { args: ['index', '.'], env: {} })
          expect(result.ok).toBe(true)
          expect(result.argv).toEqual(['index', '.'])
          expect(result.stdout.trim().split('\n')).toEqual(['index', '.'])
        }
      } finally {
        cleanupWorkspace(workspace)
        cleanupWorkspace(fixture.dir)
      }
    })

    it('never stacks onto a caller-supplied --context or -c flag', async () => {
      const fixture = makeArgvEcho()
      const workspace = makeWorkspace()
      try {
        const runner = new CgcRunner({
          executable: fixture.executable,
          contextResolver: () => 'wt-branch-a',
        })
        const longFlag = await runner.run(workspace, {
          args: ['--context', 'manual', 'index'],
          env: {},
        })
        expect(longFlag.argv).toEqual(['--context', 'manual', 'index'])
        const shortFlag = await runner.run(workspace, {
          args: ['-c', 'other', 'stats'],
          env: {},
        })
        expect(shortFlag.argv).toEqual(['-c', 'other', 'stats'])
      } finally {
        cleanupWorkspace(workspace)
        cleanupWorkspace(fixture.dir)
      }
    })

    it('fails open when the resolver throws: no injection, the run still resolves', async () => {
      const fixture = makeArgvEcho()
      const workspace = makeWorkspace()
      try {
        const runner = new CgcRunner({
          executable: fixture.executable,
          contextResolver: () => {
            throw new Error('resolver exploded')
          },
        })
        const result = await runner.run(workspace, { args: ['ping'], env: {} })
        expect(result.ok).toBe(true)
        expect(result.argv).toEqual(['ping'])
      } finally {
        cleanupWorkspace(workspace)
        cleanupWorkspace(fixture.dir)
      }
    })

    it('setContextResolver(null) disables injection and a new resolver re-enables it', async () => {
      const fixture = makeArgvEcho()
      const workspace = makeWorkspace()
      try {
        const runner = new CgcRunner({ executable: fixture.executable })
        expect((await runner.run(workspace, { args: ['probe'], env: {} })).argv).toEqual(['probe'])
        runner.setContextResolver(() => 'wt-branch-a')
        expect((await runner.run(workspace, { args: ['probe'], env: {} })).argv).toEqual([
          '--context',
          'wt-branch-a',
          'probe',
        ])
        runner.setContextResolver(null)
        expect((await runner.run(workspace, { args: ['probe'], env: {} })).argv).toEqual(['probe'])
      } finally {
        cleanupWorkspace(workspace)
        cleanupWorkspace(fixture.dir)
      }
    })

    it('deduplicates on the final argv: same injected command shares one child, different contexts do not', async () => {
      const workspace = makeWorkspace()
      const log = join(workspace, 'spawns.log')
      const executable = makeArgvLogger(log)
      try {
        const runner = new CgcRunner({
          executable,
          contextResolver: () => 'wt-branch-a',
        })
        // Identical args + identical injected context -> one spawn.
        const first = runner.run(workspace, { args: ['index', '.'], env: {} })
        const second = runner.run(workspace, { args: ['index', '.'], env: {} })
        const [firstResult, secondResult] = await Promise.all([first, second])
        expect(firstResult.argv).toEqual(['--context', 'wt-branch-a', 'index', '.'])
        expect(secondResult.argv).toEqual(firstResult.argv)

        // A different injected context -> a distinct spawn (no shared child).
        runner.setContextResolver(() => 'wt-branch-b')
        const other = await runner.run(workspace, { args: ['index', '.'], env: {} })
        expect(other.argv).toEqual(['--context', 'wt-branch-b', 'index', '.'])

        const lines = readFileSync(log, 'utf8').trim().split('\n')
        expect(lines).toEqual(['--context wt-branch-a index .', '--context wt-branch-b index .'])
      } finally {
        cleanupWorkspace(workspace)
      }
    })
  })
})
