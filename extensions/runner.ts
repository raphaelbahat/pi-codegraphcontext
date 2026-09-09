// cgc command runner (design D1 of openspec/changes/add-cgc-session-lifecycle-gate).
//
// Every CGC interaction goes through this runner:
//   - argument-array spawn (never a shell string),
//   - an explicit `cwd` supplied by the Pi session context (never `process.cwd()`),
//   - a per-command time budget with termination on expiry,
//   - AbortSignal cancellation,
//   - bounded output capture (the most recent bytes are kept per stream),
//   - structured result codes, and
//   - per-workspace in-flight deduplication.
//
// Fail-open contract: `run` resolves with a structured result for every runtime
// failure (missing binary, timeout, cancellation, lock conflict, non-zero exit).
// It only throws on caller contract violations (non-string argv entries or an
// empty cwd), which are programming errors, not cgc failures.

import { type ChildProcess, spawn } from 'node:child_process'

/**
 * Structured outcome codes for a cgc invocation.
 *
 * `BUSY` maps to embedded-backend lock conflicts (design D4: skip-as-busy is
 * the only lock policy); it is detected from coarse markers in the captured
 * output of a failed command, never from log parsing.
 */
export type CgcResultCode =
  | 'OK'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'BUSY'
  | 'COMMAND_FAILED'

export interface CgcRunOptions {
  /** Argument array, passed to the child verbatim (no shell parsing). */
  args: readonly string[]
  /** Time budget in milliseconds; defaults to the runner's budget. */
  timeoutMs?: number
  /** External cancellation; aborting terminates the child and yields CANCELLED. */
  signal?: AbortSignal
  /** Child environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Per-stream capture cap in bytes; defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}. */
  maxOutputBytes?: number
}

export interface CgcCommandResult {
  /** True only for code `OK`. */
  ok: boolean
  code: CgcResultCode
  /** Human-readable, single-line description of the outcome. */
  message: string
  /** Child exit code, or null when it was terminated or failed to spawn. */
  exitCode: number | null
  /** Terminating signal, when the child was killed by one. */
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** True when a stream hit the capture cap and earlier bytes were dropped. */
  truncated: boolean
  durationMs: number
  argv: string[]
  /** The workspace cwd the command ran in (the Pi session cwd). */
  cwd: string
}

/** Default per-stream output cap: 256 KiB, enough for status output, cheap to hold. */
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024

/** Grace period between SIGTERM and SIGKILL when terminating a child. */
const KILL_GRACE_MS = 1_000

/**
 * Coarse embedded-database lock markers (design D4). Deliberately broad and
 * cheap: lock errors are expected behavior, and a false BUSY only means the
 * gate skips work it would otherwise have retried anyway.
 */
const LOCK_PATTERN = /\block(ed|ing)\b/i

const DEDUP_KEY_SEPARATOR = '\u0000'
const ARG_SEPARATOR = '\u0001'

/** Bounded byte buffer that keeps the most recent bytes (a tail) per stream. */
class BoundedBuffer {
  private readonly chunks: Buffer[] = []
  private total = 0
  truncated = false

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.total += chunk.length
    while (this.total > this.maxBytes) {
      const head = this.chunks[0]
      if (head === undefined) break
      const overflow = this.total - this.maxBytes
      if (head.length > overflow) {
        this.chunks[0] = head.subarray(overflow)
        this.total -= overflow
      } else {
        this.chunks.shift()
        this.total -= head.length
      }
      this.truncated = true
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/**
 * Terminate a child: SIGTERM first, SIGKILL after the grace period.
 * Returns false when the child had already exited.
 */
function terminate(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false
  child.kill('SIGTERM')
  const enforce = setTimeout(() => {
    child.kill('SIGKILL')
  }, KILL_GRACE_MS)
  enforce.unref?.()
  child.once('close', () => {
    clearTimeout(enforce)
  })
  return true
}

interface LiveChild {
  child: ChildProcess
  /** Resolves once the child has closed (successfully or after termination). */
  closed: Promise<void>
  /** Marks the owning run as cancelled (teardown paths do the actual kill). */
  markCancelled: () => void
}

export interface CgcRunnerOptions {
  /** cgc binary to spawn; resolved against PATH when not absolute. */
  executable?: string
  /** Default time budget for invocations that do not pass `timeoutMs`. */
  defaultTimeoutMs?: number
}

/**
 * Spawns the `cgc` binary on behalf of the extension. One runner instance per
 * extension; it tracks in-flight invocations for deduplication and teardown.
 */
export class CgcRunner {
  private readonly executable: string
  private readonly defaultTimeoutMs: number
  private readonly inflight = new Map<string, Promise<CgcCommandResult>>()
  private readonly liveChildren = new Set<LiveChild>()

  constructor(options: CgcRunnerOptions = {}) {
    this.executable = options.executable ?? 'cgc'
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
  }

  /** The binary this runner spawns (diagnostic surfaces only). */
  get executablePath(): string {
    return this.executable
  }

  /**
   * Run one cgc command in the given workspace.
   *
   * `cwd` MUST be the Pi session's working directory (the session context),
   * never `process.cwd()`: the session cwd is the source of truth for which
   * workspace the gate manages. Resolves (never rejects) with a structured
   * result; identical concurrent invocations for the same workspace share one
   * child process and one result, including its timeout or cancellation.
   */
  run(cwd: string, options: CgcRunOptions): Promise<CgcCommandResult> {
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new TypeError('cgc runner: cwd is required (use the Pi session working directory)')
    }
    for (const arg of options.args) {
      if (typeof arg !== 'string') {
        throw new TypeError(
          'cgc runner: every entry of args must be a string (argument-array spawn)',
        )
      }
    }

    const key = `${cwd}${DEDUP_KEY_SEPARATOR}${options.args.join(ARG_SEPARATOR)}`
    const existing = this.inflight.get(key)
    if (existing) return existing

    const promise = this.runOnce(cwd, options).finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, promise)
    return promise
  }

  /** Whether any cgc command is currently in flight for the given workspace. */
  isInFlight(cwd: string): boolean {
    const prefix = `${cwd}${DEDUP_KEY_SEPARATOR}`
    for (const key of this.inflight.keys()) {
      if (key.startsWith(prefix)) return true
    }
    return false
  }

  /**
   * Terminate every in-flight cgc child (graceful session teardown path).
   * Sends SIGTERM first (SIGKILL after the grace period) and resolves once all
   * children have closed; the pending `run` promises settle as CANCELLED.
   * Resolves with the number of children that were still alive and signalled.
   */
  async killAll(): Promise<number> {
    const entries = [...this.liveChildren]
    if (entries.length === 0) return 0
    let signalled = 0
    for (const entry of entries) {
      entry.markCancelled()
      if (terminate(entry.child)) signalled += 1
    }
    await Promise.all(entries.map((entry) => entry.closed))
    return signalled
  }

  /**
   * Synchronously terminate every live cgc child with SIGKILL (hard teardown
   * path for `process` `exit` and signal handlers, where only synchronous work
   * is possible — no awaiting, no pending timers). Pending `run` promises
   * settle as CANCELLED once the killed children close. Returns the number of
   * children that were still alive and hard-killed.
   */
  terminateAllSync(): number {
    let killed = 0
    for (const entry of [...this.liveChildren]) {
      const child = entry.child
      if (child.exitCode !== null || child.signalCode !== null) continue
      entry.markCancelled()
      child.kill('SIGKILL')
      killed += 1
    }
    return killed
  }

  private runOnce(cwd: string, options: CgcRunOptions): Promise<CgcCommandResult> {
    const startedAt = Date.now()
    const argv = [...options.args]
    const requestedTimeout = options.timeoutMs ?? this.defaultTimeoutMs
    const timeoutMs =
      Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? requestedTimeout
        : this.defaultTimeoutMs
    const maxOutputBytes =
      options.maxOutputBytes && options.maxOutputBytes > 0
        ? options.maxOutputBytes
        : DEFAULT_MAX_OUTPUT_BYTES

    return new Promise((resolve) => {
      const stdoutBuffer = new BoundedBuffer(maxOutputBytes)
      const stderrBuffer = new BoundedBuffer(maxOutputBytes)
      let settled = false
      let killReason: 'TIMEOUT' | 'CANCELLED' | undefined
      let child: ChildProcess | undefined
      let timer: ReturnType<typeof setTimeout> | undefined

      let entry: LiveChild | undefined
      const signal = options.signal
      const onAbort = () => {
        if (child !== undefined && terminate(child)) killReason = 'CANCELLED'
      }

      const finish = (
        code: CgcResultCode,
        message: string,
        exitCode: number | null,
        signalName: NodeJS.Signals | null,
      ): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (entry !== undefined) this.liveChildren.delete(entry)
        resolve({
          ok: code === 'OK',
          code,
          message,
          exitCode,
          signal: signalName,
          stdout: stdoutBuffer.text(),
          stderr: stderrBuffer.text(),
          truncated: stdoutBuffer.truncated || stderrBuffer.truncated,
          durationMs: Date.now() - startedAt,
          argv,
          cwd,
        })
      }

      if (signal?.aborted) {
        finish('CANCELLED', 'cgc invocation aborted before the process was spawned', null, null)
        return
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        if (child !== undefined && terminate(child)) killReason = 'TIMEOUT'
      }, timeoutMs)

      try {
        const spawned = spawn(this.executable, argv, {
          cwd,
          env: options.env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        })
        child = spawned
        entry = {
          child: spawned,
          closed: new Promise<void>((resolveClosed) => {
            spawned.once('close', () => resolveClosed())
          }),
          markCancelled: () => {
            killReason = 'CANCELLED'
          },
        }
        this.liveChildren.add(entry)
      } catch (error) {
        finish(
          'UNAVAILABLE',
          `cgc executable could not be spawned: ${errorMessage(error)}`,
          null,
          null,
        )
        return
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuffer.push(chunk)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuffer.push(chunk)
      })

      child.on('error', (error: NodeJS.ErrnoException) => {
        finish(
          'UNAVAILABLE',
          `cgc executable could not be spawned (${error.code ?? 'unknown error'}): ${errorMessage(error)}`,
          null,
          null,
        )
      })

      child.on('close', (exitCode, signalName) => {
        const stdout = stdoutBuffer.text()
        const stderr = stderrBuffer.text()

        if (killReason === 'TIMEOUT') {
          finish(
            'TIMEOUT',
            `cgc invocation exceeded its ${timeoutMs}ms time budget and was terminated`,
            null,
            signalName,
          )
          return
        }
        if (killReason === 'CANCELLED') {
          finish('CANCELLED', 'cgc invocation was aborted before completion', null, signalName)
          return
        }
        if (exitCode === 0) {
          finish('OK', 'cgc exited 0', exitCode, signalName)
          return
        }
        if (LOCK_PATTERN.test(stdout) || LOCK_PATTERN.test(stderr)) {
          finish(
            'BUSY',
            'cgc reported an embedded-database lock conflict (another CGC process holds the workspace)',
            exitCode,
            signalName,
          )
          return
        }
        finish('COMMAND_FAILED', `cgc exited with code ${exitCode ?? 'null'}`, exitCode, signalName)
      })
    })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
