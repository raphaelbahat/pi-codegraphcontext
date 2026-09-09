import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CLEANUP_SIGNALS, installProcessCleanup } from './cleanup'
import { CgcRunner } from './runner'

const BUN = process.execPath
const HANG_SCRIPT = 'setInterval(() => {}, 60_000)'

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
