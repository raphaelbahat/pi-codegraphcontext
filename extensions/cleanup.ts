// Multi-path process cleanup (task 1.4 of openspec/changes/add-cgc-session-lifecycle-gate).
//
// Guarantee: no extension-spawned `cgc` process outlives the session. Three
// independent teardown paths cover every way a Pi session can end:
//
//   1. `session_shutdown` hook — the graceful path. The runner's `killAll`
//      sends SIGTERM first, giving cgc a chance to release embedded-database
//      locks and clean up temp files before the SIGKILL escalation.
//   2. `process` `exit` event — the last-resort path. Only synchronous work is
//      possible here (no awaiting, no pending timers), so live children are
//      hard-killed (SIGKILL) inline.
//   3. Termination signals (SIGINT/SIGTERM/SIGHUP) — the intercepted path.
//      Live children are hard-killed inline, then the signal is re-raised so
//      the host process exits exactly as it would have without the handler
//      (preserving the host's own signal semantics and exit status).
//
// Every path is idempotent and safe when nothing is in flight. Fail-open:
// installation and every handler body catch their own errors; a cleanup
// failure is recorded but never thrown into the host.

import type { CgcRunner } from './runner'

/** Default signals intercepted for teardown. */
export const DEFAULT_CLEANUP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

export type CleanupPath = 'session-shutdown' | 'process-exit' | 'signal'

/** Diagnostic record of one teardown sweep (surfaced by later changes only). */
export interface CleanupEvent {
  path: CleanupPath
  /** The signal received, for the `signal` path. */
  signal?: NodeJS.Signals | undefined
  /** Number of live children the sweep signalled. */
  terminated: number
  at: number
}

/**
 * Minimal Pi extension API surface needed for the shutdown hook (a structural
 * test seam: real `ExtensionAPI` satisfies it).
 */
export interface CleanupExtensionApi {
  on(event: 'session_shutdown', handler: (event: unknown, ctx: unknown) => unknown): unknown
}

/**
 * Minimal process surface the exit/signal paths attach to (a structural test
 * seam: the real `process` object satisfies it).
 */
export interface CleanupProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  once(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
  readonly pid?: number
  kill?(pid: number, signal: NodeJS.Signals | number): boolean
}

export interface ProcessCleanupOptions {
  /** Signals to intercept; defaults to {@link DEFAULT_CLEANUP_SIGNALS}. */
  signals?: readonly NodeJS.Signals[]
  /** Pi extension API receiving the `session_shutdown` hook. */
  api?: CleanupExtensionApi
  /** Process object for the exit/signal handlers; defaults to `process`. */
  processObject?: CleanupProcess
}

export interface ProcessCleanupHandle {
  /**
   * Remove the process-exit and signal handlers. The `session_shutdown` hook
   * cannot be unregistered (the Pi extension API has no removal surface), so
   * after `dispose` that handler becomes a no-op. Idempotent.
   */
  dispose(): void
  /** Diagnostic record of every teardown sweep performed so far. */
  readonly events: readonly CleanupEvent[]
}

/**
 * Install all teardown paths for one runner. Call once per extension instance;
 * returns a handle whose `events` later surfaces (status HUD, slash commands)
 * can read and whose `dispose` is for tests and reload paths.
 */
export function installProcessCleanup(
  runner: CgcRunner,
  options: ProcessCleanupOptions = {},
): ProcessCleanupHandle {
  const signals = options.signals ?? DEFAULT_CLEANUP_SIGNALS
  const emitter: CleanupProcess = options.processObject ?? (process as unknown as CleanupProcess)
  const events: CleanupEvent[] = []
  const removers: Array<() => void> = []
  let disposed = false

  const record = (path: CleanupPath, terminated = 0, signal?: NodeJS.Signals): void => {
    events.push({ path, signal, terminated, at: Date.now() })
  }

  // Path 2 (exit) and paths shared by signal interception: a synchronous,
  // hard-kill sweep. The `process` `exit` event allows only synchronous work,
  // and a signal handler must finish before the default disposition runs —
  // neither can await the SIGTERM grace period, so children get SIGKILL
  // directly. Embedded backends treat abrupt process death as expected
  // operational reality (the lifecycle's `corrupt` state exists for it), while
  // an orphaned lock-holding cgc process is guaranteed harm.
  const hardSweep = (path: CleanupPath, signal?: NodeJS.Signals): number => {
    try {
      const terminated = runner.terminateAllSync()
      record(path, terminated, signal)
      return terminated
    } catch {
      record(path, 0, signal)
      return 0
    }
  }

  // Path 1: graceful teardown when the Pi session shuts down. If the host does
  // not wait for the graceful SIGTERM grace period, the exit/signal paths
  // still hard-kill anything left.
  if (options.api !== undefined) {
    const api = options.api
    const onShutdown = (): void => {
      if (disposed) return
      try {
        void runner
          .killAll()
          .then((terminated) => record('session-shutdown', terminated))
          .catch(() => record('session-shutdown'))
      } catch {
        record('session-shutdown')
      }
    }
    try {
      api.on('session_shutdown', onShutdown)
    } catch {
      record('session-shutdown')
    }
  }

  // Path 2: synchronous hard sweep when the Node process exits.
  const onExit = (): void => {
    hardSweep('process-exit')
  }
  try {
    emitter.on('exit', onExit)
    removers.push(() => emitter.removeListener('exit', onExit))
  } catch {
    hardSweep('process-exit')
  }

  // Path 3: signal interception. Hard-kill children inline, then re-raise the
  // same signal to the current process so the host terminates with the exact
  // status it would have had without the handler. The listener is registered
  // with `once` and removed before re-raising, so the re-delivered signal
  // reaches the host's remaining handlers (if any) or the default disposition,
  // and cannot loop back into this handler.
  for (const signal of signals) {
    const onSignal = (): void => {
      hardSweep('signal', signal)
      try {
        emitter.removeListener(signal, onSignal)
        if (emitter.pid !== undefined && typeof emitter.kill === 'function') {
          emitter.kill(emitter.pid, signal)
        }
      } catch {
        // The sweep already ran; nothing further to do.
      }
    }
    try {
      emitter.once(signal, onSignal)
      removers.push(() => emitter.removeListener(signal, onSignal))
    } catch {
      // Signal unsupported on this platform; skip it.
    }
  }

  return {
    dispose(): void {
      disposed = true
      while (removers.length > 0) {
        const remove = removers.pop()
        try {
          remove?.()
        } catch {
          // Removing a never-registered listener is a no-op error; ignore.
        }
      }
    },
    events,
  }
}
