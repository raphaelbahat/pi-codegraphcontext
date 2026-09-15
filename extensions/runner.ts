// cgc command runner (design D1 of openspec/changes/add-cgc-session-lifecycle-gate).
//
// Every CGC interaction goes through this runner:
//   - argument-array spawn (never a shell string),
//   - an explicit `cwd` supplied by the Pi session context (never `process.cwd()`),
//   - a per-command time budget with termination on expiry,
//   - AbortSignal cancellation,
//   - bounded output capture (design D2: head+tail retention with an
//     explicit truncation marker — see output-policy.ts),
//   - structured result codes, and
//   - per-workspace in-flight deduplication.
//
// Fail-open contract: `run` resolves with a structured result for every runtime
// failure (missing binary, timeout, cancellation, lock conflict, non-zero exit).
// It only throws on caller contract violations (non-string argv entries or an
// empty cwd), which are programming errors, not cgc failures.

import { type ChildProcess, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import {
  applyOutputPolicy,
  type CgcOutputPolicyOptions,
  OUTPUT_POLICY_MAX_BYTES,
} from './output-policy'
import { SpillSession, type SpillWriter } from './spill'

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

/**
 * Synchronous per-workspace `--context` resolution hook (design D2 of
 * add-cgc-worktree-aware-contexts, task 2.2). Maps a workspace to the CGC
 * named context every invocation in that workspace must carry
 * (`--context <name>`), or null for no injection.
 *
 * The hook MUST be fail-closed: it returns a name only for a VERIFIED mapping
 * identity (the session's `WorktreeMap.contextFor`), never a name derived
 * from unverified state — it is the implementation of isolate-mode context
 * isolation. A throwing hook degrades to no injection (fail-open on the
 * runner side, so a broken hook can never break an invocation).
 */
export type RunnerContextResolver = (cwd: string) => string | null

export interface CgcRunOptions {
  /** Argument array, passed to the child verbatim (no shell parsing). */
  args: readonly string[]
  /** Time budget in milliseconds; defaults to the runner's budget. */
  timeoutMs?: number
  /** External cancellation; aborting terminates the child and yields CANCELLED. */
  signal?: AbortSignal
  /** Child environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /**
   * Per-stream capture cap in bytes; defaults to
   * {@link DEFAULT_MAX_OUTPUT_BYTES}. The buffer retains the head and tail of
   * the stream within this cap; the DELIVERED text never exceeds the smaller
   * of this cap and the output policy budget ({@link OUTPUT_POLICY_MAX_BYTES})
   * — both ends survive, separated by an explicit truncation marker.
   */
  maxOutputBytes?: number
  /**
   * Optional text written to the child's stdin (followed by EOF) right after
   * spawn — the escape hatch for documented CLI verbs that print their OWN
   * confirmation prompt (e.g. `cgc context delete` asks its `[y/N]`). The
   * caller supplies an answer ONLY after the ADR-0003 consent layer already
   * granted explicit consent; the runner never prompts or answers on its own.
   * When omitted the child's stdin stays /dev/null (unchanged behavior).
   */
  stdin?: string
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
  /**
   * True when a stream exceeded the capture cap and the retained
   * head+tail reconstruction is missing middle bytes (design D2).
   */
  truncated: boolean
  /**
   * Policy-pipeline errors recorded while applying the uniform output policy
   * to this invocation's streams (task 1.7 fail-open semantics). Each entry
   * names the failing stage and reason; their presence NEVER changes `ok` or
   * `code` — the invocation itself succeeded or failed on its own merits, and
   * the delivered `stdout`/`stderr` are the best-effort output. Omitted when no
   * stage reported an error.
   */
  policyErrors?: string[]
  durationMs: number
  argv: string[]
  /** The workspace cwd the command ran in (the Pi session cwd). */
  cwd: string
}

/**
 * Default per-stream capture cap: 256 KiB, enough for status output, cheap
 * to hold. This is a RAW retention ceiling (memory guard), not the delivered
 * budget — the output policy's {@link OUTPUT_POLICY_MAX_BYTES} (16 KiB,
 * design of `output.maxBytes`) is what consumers receive, bounded head+tail.
 */
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

/**
 * The environment variable CGC reads to select its output format (design D5,
 * task 1.6). Setting it to `gcf` asks for the compact format; CGC falls back
 * to JSON on its own when `gcf-python` is unavailable.
 */
const CGC_OUTPUT_FORMAT_ENV = 'CGC_OUTPUT_FORMAT'

/**
 * Bounded byte buffer keeping the HEAD and TAIL of a stream (design D2 of
 * add-cgc-output-token-economy): the first and last `maxBytes` are retained
 * while the true total is tracked (`totalBytes`), so the truncation marker
 * can state the ORIGINAL size even after middle bytes were dropped. The old
 * tail-only buffer broke D2 (the head was lost) and lost the totals — this
 * replaces it as the pipeline's capture stage.
 *
 * `truncated` is true exactly when bytes WERE dropped, i.e. the stream
 * exceeded 2× the cap and the retained head+tail reconstruction is
 * incomplete; between `maxBytes` and 2× the cap the head and tail exactly
 * tile the stream, so nothing is lost.
 *
 * Spill seam (design D3; task 1.4 wires the session temp directory): an
 * optional sink receives EVERY chunk as it arrives, so a spill writer sees
 * the full stream even though the buffer drops its middle — once overflow
 * has happened the full output can no longer be reconstructed from memory.
 */
class HeadTailBuffer {
  /** Snapshot of the first `maxBytes` (frozen once at the first overflow). */
  private first: Buffer | null = null
  /** The most recent bytes (rolling tail, never over `maxBytes`). */
  private readonly tail: Buffer[] = []
  private tailBytes = 0
  /** True once any byte was dropped (`totalBytes` exceeded 2× the cap). */
  truncated = false
  totalBytes = 0
  private cachedText: string | null = null

  constructor(
    private readonly maxBytes: number,
    private readonly spill?: (chunk: Buffer) => void,
  ) {}

  push(chunk: Buffer): void {
    this.totalBytes += chunk.length
    this.cachedText = null
    this.spill?.(chunk)

    if (this.first === null) {
      // Pre-overflow: accumulate; the tail list holds the whole stream.
      if (this.tailBytes + chunk.length <= this.maxBytes) {
        this.tail.push(chunk)
        this.tailBytes += chunk.length
        return
      }
      // This chunk crosses the cap. Snapshot the first `maxBytes` (the tail
      // list is the exact stream prefix) plus this chunk's filling part, then
      // roll the chunk's remainder as the start of the tail.
      const space = this.maxBytes - this.tailBytes
      const headFill = chunk.subarray(0, space)
      this.tail.push(headFill)
      this.first = Buffer.concat(this.tail)
      this.tail.splice(0)
      this.tailBytes = 0
      const remainder = chunk.subarray(space)
      if (remainder.length > 0) {
        this.tail.push(remainder)
        this.tailBytes = remainder.length
      }
      this.trimTail()
      return
    }

    // Overflow already happened: the head snapshot is frozen, roll the tail.
    this.tail.push(chunk)
    this.tailBytes += chunk.length
    this.trimTail()
  }

  /** Drop bytes from the front of the tail to keep it within `maxBytes`. */
  private trimTail(): void {
    while (this.tailBytes > this.maxBytes) {
      const oldest = this.tail[0]
      if (oldest === undefined) break
      const overflow = this.tailBytes - this.maxBytes
      if (oldest.length > overflow) {
        this.tail[0] = oldest.subarray(overflow)
        this.tailBytes -= overflow
      } else {
        this.tail.shift()
        this.tailBytes -= oldest.length
      }
      this.truncated = true
    }
  }

  /** The retained reconstruction: head snapshot (when overflowed) + tail. */
  text(): string {
    if (this.cachedText !== null) return this.cachedText
    const parts = this.first !== null ? [this.first, ...this.tail] : this.tail
    this.cachedText = Buffer.concat(parts).toString('utf8')
    return this.cachedText
  }
}

/**
 * The minimal process surface the runner's tracking and termination paths
 * touch. Real `ChildProcess` objects satisfy it structurally (and so does
 * any test stand-in), so nothing needs a cast to be tracked or terminated.
 */
export interface TrackedChild {
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: string, listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
}

function terminate(child: TrackedChild): boolean {
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
  child: TrackedChild
  /** Resolves once the child has closed (successfully or after termination). */
  closed: Promise<void>
  /** Marks the owning run as cancelled (teardown paths do the actual kill). */
  markCancelled: () => void
}

/**
 * The runner's output-policy function signature (design D1): strip control
 * sequences, redact secrets per `redact`, and bound to `budget`. Exposed as a
 * seam so tests can inject a throwing stage and prove the runner's fail-open
 * containment (task 2.2); production wiring always uses
 * {@link applyOutputPolicy}.
 */
export type CgcOutputPolicyFn = (text: string, options: CgcOutputPolicyOptions) => string

export interface CgcRunnerOptions {
  /** cgc binary to spawn; resolved against PATH when not absolute. */
  executable?: string
  /** Default time budget for invocations that do not pass `timeoutMs`. */
  defaultTimeoutMs?: number
  /**
   * Optional per-workspace `--context` injection hook (task 2.2). When it
   * returns a non-empty name for a workspace, every invocation there gets
   * `--context <name>` prepended to argv (before the in-flight key is
   * computed, so deduplication observes the real command). Consulted
   * synchronously once per `run` call. Per-session state is swapped via
   * {@link CgcRunner.setContextResolver}.
   */
  contextResolver?: RunnerContextResolver
  /**
   * Spill the FULL captured output to a session-scoped file under the OS temp
   * location when the delivered output is truncated (design D3, task 1.4).
   * Default false at the runner level; the extension passes
   * `config.output.spillToTemp` (default true). Spill files are removed by
   * {@link CgcRunner.cleanupSpills}, which the session teardown paths invoke.
   */
  spillToTemp?: boolean
  /**
   * Whether the redaction stage of the output policy runs (default true —
   * secret hygiene is on unless a caller explicitly opts out). The extension
   * passes `config.output.redactSecrets` (default true); the `output.redactSecrets`
   * opt-out reaches the pipeline through this seam (task 1.5).
   */
  redactSecrets?: boolean
  /**
   * Base directory for the session spill directory (test seam); defaults to
   * the OS temp location. Spill files are NEVER placed in the workspace.
   */
  spillBaseDir?: string
  /**
   * Whether to request CGC's compact GCF output format by setting
   * `CGC_OUTPUT_FORMAT=gcf` on every invocation (design D5, task 1.6). The
   * extension passes `config.output.gcf` (default false — opt-in). No
   * availability probing: CGC's own documented fallback to JSON when
   * `gcf-python` is absent keeps the invocation succeeding.
   */
  gcfOutput?: boolean
  /**
   * Test seam (task 2.2): replace the uniform output policy pipeline. The
   * default IS {@link applyOutputPolicy}; supplying a throwing function
   * exercises the fail-open wrapper — the invocation still resolves with
   * best-effort (retained) output and never fails because a policy stage
   * threw. Production wiring never sets it.
   */
  outputPolicy?: CgcOutputPolicyFn
}

/**
 * Spawns the `cgc` binary on behalf of the extension. One runner instance per
 * extension; it tracks in-flight invocations for deduplication and teardown.
 */
export class CgcRunner {
  private readonly executable: string
  private readonly defaultTimeoutMs: number
  private contextResolver: RunnerContextResolver | null
  private readonly inflight = new Map<string, Promise<CgcCommandResult>>()
  private readonly liveChildren = new Set<LiveChild>()
  private readonly spillToTemp: boolean
  private readonly spillBaseDir: string
  private readonly redactSecrets: boolean
  private readonly gcfOutput: boolean
  private readonly outputPolicy: CgcOutputPolicyFn
  private spillSession: SpillSession | null = null

  constructor(options: CgcRunnerOptions = {}) {
    this.executable = options.executable ?? 'cgc'
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
    this.contextResolver = options.contextResolver ?? null
    this.spillToTemp = options.spillToTemp ?? false
    this.spillBaseDir = options.spillBaseDir ?? tmpdir()
    // Default on: the `output.redactSecrets` opt-out is the ONLY way off.
    this.redactSecrets = options.redactSecrets ?? true
    // Default off: GCF passthrough is opt-in through `output.gcf`.
    this.gcfOutput = options.gcfOutput ?? false
    // Default to the real pipeline; only the task 2.2 test seam replaces it.
    this.outputPolicy = options.outputPolicy ?? applyOutputPolicy
  }

  /** The binary this runner spawns (diagnostic surfaces only). */
  get executablePath(): string {
    return this.executable
  }

  /**
   * Swap the per-workspace `--context` resolver (per-session wiring: the
   * lifecycle gate attaches the session's worktree map on session start and
   * detaches it on shutdown). Pass null to disable injection. Never throws.
   */
  setContextResolver(resolver: RunnerContextResolver | null): void {
    this.contextResolver = resolver
  }

  /**
   * The child environment for one invocation: the caller's environment (or the
   * process default) plus CGC's output-format request when `output.gcf` is on
   * (design D5, task 1.6). The runner never probes for `gcf-python` — CGC
   * performs its own documented JSON fallback, so the invocation always
   * succeeds regardless of what the installed CGC can produce.
   */
  private childEnv(base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
    const env = base ?? process.env
    if (!this.gcfOutput) return env
    return { ...env, [CGC_OUTPUT_FORMAT_ENV]: 'gcf' }
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

    // Task 2.2: carry the mapped `--context` flag on every invocation of a
    // workspace whose mapping identity matches. Injection happens BEFORE the
    // in-flight key is computed so deduplication observes the real command
    // (identical injected commands dedup; differently injected ones do not).
    const args = this.withInjectedContext(cwd, options.args)

    const key = `${cwd}${DEDUP_KEY_SEPARATOR}${args.join(ARG_SEPARATOR)}`
    const existing = this.inflight.get(key)
    if (existing) return existing

    const promise = this.runOnce(cwd, { ...options, args }).finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, promise)
    return promise
  }

  /**
   * Prepend `--context <name>` when the session's resolver yields a verified
   * context name for this workspace. Deliberately fail-open: no resolver, a
   * throwing resolver, or an empty name leaves argv untouched (`off` mode is
   * zero change). An explicit caller-supplied context flag (long or short)
   * always wins and is never stacked — a manual `--context` on the command is
   * the caller's decision, and cgc takes the last flag verbatim.
   */
  private withInjectedContext(cwd: string, args: readonly string[]): string[] {
    const resolver = this.contextResolver
    if (resolver === null) return [...args]
    let contextName: string | null
    try {
      contextName = resolver(cwd)
    } catch {
      // Fail-open: a throwing resolver must never break an invocation.
      return [...args]
    }
    if (contextName === null || contextName.length === 0) return [...args]
    if (args.includes('--context') || args.includes('-c')) return [...args]
    return ['--context', contextName, ...args]
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
   * Track a long-lived child process spawned OUTSIDE the runner's `run`
   * pipeline — today the on-demand `cgc api start` server of the registry-
   * backed indexedness probe (add-cgc-api-registry-probe, design D4). The
   * runner does not own the child (it never spawns, waits for, or reads it);
   * ownership stays with the caller, who terminates it when done. Tracking
   * only makes the EXISTING teardown guarantee apply: every cleanup path —
   * the graceful `session_shutdown` sweep (`killAll`), the synchronous
   * `process` `exit` sweep, and signal interception
   * (`terminateAllSync`) — signals tracked children together with the
   * runner's own command children, so no externally spawned cgc process
   * outlives the session. The entry self-removes when the child closes.
   * Idempotent-safe: an already-exited child is not tracked.
   */
  trackExternalChild(child: TrackedChild): void {
    if (child.exitCode !== null || child.signalCode !== null) return
    const entry: LiveChild = {
      child,
      closed: new Promise<void>((resolveClosed) => {
        child.once('close', () => {
          this.liveChildren.delete(entry)
          resolveClosed()
        })
      }),
      // No owning run promise to mark cancelled; the caller owns the child.
      markCancelled: () => {},
    }
    this.liveChildren.add(entry)
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

  /**
   * Remove the session's spill directory and every file in it (design D3).
   * Synchronous and fail-open, so every teardown path — the `session_shutdown`
   * hook (after `killAll`), the process `exit` handler, and signal
   * interception — can call it. Idempotent; a later command recreates the
   * directory lazily.
   */
  cleanupSpills(): void {
    const session = this.spillSession
    this.spillSession = null
    session?.remove()
  }

  /**
   * A spill writer for one capture stream when spill is enabled, else
   * undefined. The session (and its directory) is created lazily on first use.
   */
  private spillWriter(label: string, thresholdBytes: number): SpillWriter | undefined {
    if (!this.spillToTemp) return undefined
    this.spillSession ??= new SpillSession({ baseDir: this.spillBaseDir })
    return this.spillSession.createWriter(label, thresholdBytes)
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
    // The delivered-text budget of the uniform output policy (design D1): the
    // smaller of the per-invocation capture cap and the policy default
    // (16 KiB, the design of `output.maxBytes`, plumbed from config by task
    // 1.2). The marker therefore also fires for any output the policy bound
    // cuts, not only for capture-cap overflow.
    const policyBudget = Math.min(maxOutputBytes, OUTPUT_POLICY_MAX_BYTES)

    return new Promise((resolve) => {
      // Spill writers see EVERY chunk as it arrives (design D3); they are
      // created only when spill is enabled, and never touch disk unless the
      // stream is actually truncated.
      const stdoutSpill = this.spillWriter('stdout', policyBudget)
      const stderrSpill = this.spillWriter('stderr', policyBudget)
      const stdoutBuffer = new HeadTailBuffer(maxOutputBytes, stdoutSpill?.sink)
      const stderrBuffer = new HeadTailBuffer(maxOutputBytes, stderrSpill?.sink)
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
        const stdoutPolicy = applyCapturePolicy(
          stdoutBuffer,
          policyBudget,
          'command',
          this.redactSecrets,
          this.outputPolicy,
          stdoutSpill,
        )
        const stderrPolicy = applyCapturePolicy(
          stderrBuffer,
          policyBudget,
          'command',
          this.redactSecrets,
          this.outputPolicy,
          stderrSpill,
        )
        // Every policy-stage error is recorded on the result (task 1.7): the
        // invocation still resolves with best-effort delivered output and
        // never fails because a stage (redaction, spill write, stripping) threw.
        const policyErrors = [stdoutPolicy.error, stderrPolicy.error].filter(
          (entry): entry is string => entry !== undefined,
        )
        resolve({
          ok: code === 'OK',
          code,
          message,
          exitCode,
          signal: signalName,
          stdout: stdoutPolicy.text,
          stderr: stderrPolicy.text,
          truncated: stdoutBuffer.truncated || stderrBuffer.truncated,
          ...(policyErrors.length > 0 ? { policyErrors } : {}),
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
        // `stdin` is the only reason to open the pipe: otherwise the child's
        // stdin stays /dev/null so an interactive prompt can never hang.
        const stdinText = options.stdin
        const stdio = [stdinText !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] as [
          'pipe' | 'ignore',
          'pipe',
          'pipe',
        ]
        const spawned = spawn(this.executable, argv, {
          cwd,
          env: this.childEnv(options.env),
          stdio,
          shell: false,
          windowsHide: true,
        })
        child = spawned
        if (stdinText !== undefined) {
          const stdinStream = spawned.stdin
          if (stdinStream !== null) {
            try {
              stdinStream.write(stdinText)
              // End our side of the prompt pipe right after writing: `end()`
              // flushes the queued text and signals EOF (the declared Writable
              // API — no cast), which is exactly what an answer-then-close
              // prompt needs.
              stdinStream.end()
            } catch {
              // The child may close its stdin early (e.g. it rejected the verb
              // without prompting); the close handler below reports the real
              // outcome and the invocation never fails on a broken pipe.
            }
          }
        }
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

/**
 * Apply the uniform output policy pipeline (design D1) to one captured
 * stream: strip control sequences → redact secrets → bound with head+tail
 * and an explicit truncation marker stating the ORIGINAL stream size
 * (`buffer.totalBytes` — the marker stays honest about material the capture
 * retention or the bound dropped). Applied here, in the runner, before any
 * consumer receives results.
 *
 * Fail-open (task 1.7): a pipeline stage defect degrades to best-effort
 * delivery of the retained text — the invocation itself never fails because a
 * policy stage threw — and the stage error is RETURNED so the runner can
 * record it on the invocation result (`policyErrors`). A spill write failure
 * is reported the same way: the marker stands alone without a path, the
 * delivered output is still bounded, and the error is recorded.
 */
function applyCapturePolicy(
  buffer: HeadTailBuffer,
  budget: number,
  label: string,
  redact: boolean,
  policy: CgcOutputPolicyFn,
  spill?: SpillWriter,
): { text: string; error?: string } {
  const text = buffer.text()
  try {
    // Truncation is exactly the condition under which `boundText` rewrites the
    // text (the delivered length exceeds the budget). Only then is the spill
    // kept and its path named; an untruncated stream's writer is discarded so
    // no temp file is left behind.
    const truncated = text.length > budget
    let spillPath: string | undefined
    if (truncated) {
      spillPath = spill?.commit()
    } else {
      spill?.discard()
    }
    const applied = policy(text, {
      budget,
      label,
      originalSize: buffer.totalBytes,
      redact,
      ...(spillPath !== undefined ? { spillPath } : {}),
    })
    // A sink-time spill failure is recorded without failing the policy: the
    // marker already carries no path, so the delivered output is unchanged.
    const spillError = spill?.error
    return spillError === null || spillError === undefined
      ? { text: applied }
      : { text: applied, error: `spill write failed: ${spillError}` }
  } catch (error) {
    spill?.discard()
    return { text, error: `output policy failed: ${errorMessage(error)}` }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
