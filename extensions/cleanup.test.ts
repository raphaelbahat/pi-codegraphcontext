import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CLEANUP_SIGNALS, installProcessCleanup } from './cleanup'
import { CgcRunner } from './runner'

const BUN = process.execPath
const HANG_SCRIPT = 'setInterval(() => {}, 60_000)'
const SPILL_SCRIPT = 'process.stdout.write("x".repeat(1024 * 1024))'

/** Session spill directories present under a spill base (task 1.4 naming). */
function spillDirs(base: string): string[] {
  return readdirSync(base).filter((entry) => entry.startsWith('pi-cgc-spill'))
}

/** Force a truncation+spill and return the spill base directory. */
async function withSpilledOutput(
  workspace: string,
  spillBase: string,
  runner: CgcRunner,
): Promise<void> {
  const result = await runner.run(workspace, {
    args: ['-e', SPILL_SCRIPT],
    env: {},
    maxOutputBytes: 2048,
  })
  if (!result.stdout.includes('spilled to')) {
    throw new Error(`expected a spill marker, got: ${result.stdout.slice(0, 200)}`)
  }
  if (spillDirs(spillBase).length !== 1) {
    throw new Error(`expected exactly one spill directory in ${spillBase}`)
  }
}

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'cgc-cleanup-test-'))
}

function cleanupWorkspace(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** Fake Pi extension API that records registered session_shutdown handlers. */
class FakeExtensionApi {
  readonly handlers: Array<(...args: unknown[]) => unknown> = []

  on(event: string, handler: (...args: unknown[]) => unknown): void {
    if (event === 'session_shutdown') this.handlers.push(handler)
  }

  emitShutdown(): unknown {
    return this.handlers.map((handler) => handler({ type: 'session_shutdown' }, {}))
  }
}

/** Fake process surface (an EventEmitter exposing kill and pid). */
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

describe('installProcessCleanup', () => {
  it('registers exactly one session_shutdown handler on the Pi API', () => {
    const api = new FakeExtensionApi()
    const handle = installProcessCleanup(new CgcRunner({ executable: BUN }), { api })
    handle.dispose()

    expect(api.handlers.length).toBe(1)
  })

  it('gracefully terminates in-flight children on session_shutdown (CANCELLED)', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const api = new FakeExtensionApi()
      const handle = installProcessCleanup(runner, { api })

      const pending = runner.run(workspace, { args: ['-e', HANG_SCRIPT], env: {} })
      await new Promise((resolve) => setTimeout(resolve, 80))

      api.emitShutdown()
      const result = await pending
      // Give the record promise a tick to settle.
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(result.code).toBe('CANCELLED')
      expect(handle.events.some((event) => event.path === 'session-shutdown')).toBe(true)
      handle.dispose()
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('session_shutdown is a no-op after dispose', async () => {
    const runner = new CgcRunner({ executable: BUN })
    const api = new FakeExtensionApi()
    const handle = installProcessCleanup(runner, { api })
    handle.dispose()

    api.emitShutdown()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(handle.events.filter((event) => event.path === 'session-shutdown').length).toBe(0)
  })

  it('the process exit handler hard-kills live children synchronously', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const fakeProcess = new FakeProcess()
      const handle = installProcessCleanup(runner, { processObject: fakeProcess })

      const pending = runner.run(workspace, { args: ['-e', HANG_SCRIPT], env: {} })
      await new Promise((resolve) => setTimeout(resolve, 80))

      fakeProcess.emit('exit', 0)
      const result = await pending

      expect(result.code).toBe('CANCELLED')
      expect(result.signal).toBe('SIGKILL')
      expect(handle.events).toContainEqual(
        expect.objectContaining({ path: 'process-exit', terminated: 1 }),
      )
      handle.dispose()
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('the exit sweep is idempotent when nothing is in flight', () => {
    const runner = new CgcRunner({ executable: BUN })
    const fakeProcess = new FakeProcess()
    const handle = installProcessCleanup(runner, { processObject: fakeProcess })

    fakeProcess.emit('exit', 0)
    fakeProcess.emit('exit', 0)

    const sweeps = handle.events.filter((event) => event.path === 'process-exit')
    expect(sweeps.length).toBe(2)
    expect(sweeps.every((event) => event.terminated === 0)).toBe(true)
    handle.dispose()
  })

  it('signal handlers hard-kill children and re-raise the signal once', async () => {
    const workspace = makeWorkspace()
    try {
      const runner = new CgcRunner({ executable: BUN })
      const fakeProcess = new FakeProcess()
      const handle = installProcessCleanup(runner, { processObject: fakeProcess })

      const pending = runner.run(workspace, { args: ['-e', HANG_SCRIPT], env: {} })
      await new Promise((resolve) => setTimeout(resolve, 80))

      fakeProcess.emit('SIGINT')
      const result = await pending
      // The re-raised signal must not re-enter our (now removed) handler.
      fakeProcess.emit('SIGINT')
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(result.code).toBe('CANCELLED')
      expect(result.signal).toBe('SIGKILL')
      expect(fakeProcess.killedSignals).toEqual([{ pid: 42_424, signal: 'SIGINT' }])
      expect(handle.events).toContainEqual(
        expect.objectContaining({ path: 'signal', signal: 'SIGINT', terminated: 1 }),
      )
      handle.dispose()
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('registers a once-handler per default signal', () => {
    const runner = new CgcRunner({ executable: BUN })
    const fakeProcess = new FakeProcess()
    const handle = installProcessCleanup(runner, { processObject: fakeProcess })

    for (const signal of DEFAULT_CLEANUP_SIGNALS) {
      expect(fakeProcess.listenerCount(signal)).toBe(1)
    }
    handle.dispose()

    for (const signal of DEFAULT_CLEANUP_SIGNALS) {
      expect(fakeProcess.listenerCount(signal)).toBe(0)
    }
  })

  it('dispose removes the exit and signal handlers but keeps sweeps recorded before it', () => {
    const runner = new CgcRunner({ executable: BUN })
    const fakeProcess = new FakeProcess()
    const handle = installProcessCleanup(runner, { processObject: fakeProcess })

    handle.dispose()

    expect(fakeProcess.listenerCount('exit')).toBe(0)
    for (const signal of DEFAULT_CLEANUP_SIGNALS) {
      expect(fakeProcess.listenerCount(signal)).toBe(0)
    }

    // After dispose, emitted events must not trigger sweeps.
    fakeProcess.emit('exit', 0)
    expect(handle.events.length).toBe(0)
  })

  it('dispose is idempotent', () => {
    const handle = installProcessCleanup(new CgcRunner({ executable: BUN }), {
      processObject: new FakeProcess(),
    })
    handle.dispose()
    handle.dispose()
  })
})

describe('spill cleanup through every session teardown path (task 2.3)', () => {
  it('removes spill files on the session_shutdown graceful path', async () => {
    const workspace = makeWorkspace()
    const spillBase = mkdtempSync(join(tmpdir(), 'cgc-cleanup-spill-'))
    try {
      const runner = new CgcRunner({
        executable: BUN,
        spillToTemp: true,
        spillBaseDir: spillBase,
      })
      const api = new FakeExtensionApi()
      const handle = installProcessCleanup(runner, { api })

      await withSpilledOutput(workspace, spillBase, runner)

      api.emitShutdown()
      // killAll resolves on a microtask when nothing is in flight; give the
      // record/cleanup continuation a tick to run.
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(spillDirs(spillBase).length).toBe(0)
      expect(handle.events.some((event) => event.path === 'session-shutdown')).toBe(true)
      handle.dispose()
    } finally {
      cleanupWorkspace(workspace)
      rmSync(spillBase, { recursive: true, force: true })
    }
  })

  it('removes spill files on the synchronous process exit path', async () => {
    const workspace = makeWorkspace()
    const spillBase = mkdtempSync(join(tmpdir(), 'cgc-cleanup-spill-'))
    try {
      const runner = new CgcRunner({
        executable: BUN,
        spillToTemp: true,
        spillBaseDir: spillBase,
      })
      const fakeProcess = new FakeProcess()
      const handle = installProcessCleanup(runner, { processObject: fakeProcess })

      await withSpilledOutput(workspace, spillBase, runner)

      fakeProcess.emit('exit', 0)

      expect(spillDirs(spillBase).length).toBe(0)
      expect(handle.events.some((event) => event.path === 'process-exit')).toBe(true)
      handle.dispose()
    } finally {
      cleanupWorkspace(workspace)
      rmSync(spillBase, { recursive: true, force: true })
    }
  })

  it('removes spill files on the intercepted signal path', async () => {
    const workspace = makeWorkspace()
    const spillBase = mkdtempSync(join(tmpdir(), 'cgc-cleanup-spill-'))
    try {
      const runner = new CgcRunner({
        executable: BUN,
        spillToTemp: true,
        spillBaseDir: spillBase,
      })
      const fakeProcess = new FakeProcess()
      const handle = installProcessCleanup(runner, { processObject: fakeProcess })

      await withSpilledOutput(workspace, spillBase, runner)

      fakeProcess.emit('SIGINT')

      expect(spillDirs(spillBase).length).toBe(0)
      expect(handle.events).toContainEqual(
        expect.objectContaining({ path: 'signal', signal: 'SIGINT' }),
      )
      handle.dispose()
    } finally {
      cleanupWorkspace(workspace)
      rmSync(spillBase, { recursive: true, force: true })
    }
  })
})
