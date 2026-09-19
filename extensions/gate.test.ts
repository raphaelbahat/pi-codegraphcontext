import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LifecycleClassification, LifecycleState } from './classifier'
import type { ExtensionConfig } from './config'
import {
  buildUnavailableNotice,
  GATE_EVALUATION_WORK,
  type GateClassifierLike,
  type GateExtensionApi,
  type GateHookHandler,
  type GateNoticeSink,
  LifecycleGate,
  MAX_GATE_EVALUATION_RETRIES_PER_SESSION,
} from './gate'
import type { CgcCommandResult } from './runner'
import { CgcRunner } from './runner'
import { WORKTREE_MAP_FILE, WorktreeDetector, WorktreeMap } from './worktree'

// ---------------------------------------------------------------------------
// Test scaffolding: canned runner, temp workspaces, classification helpers.
// ---------------------------------------------------------------------------

function okResult(
  args: readonly string[],
  overrides: Partial<CgcCommandResult> = {},
): CgcCommandResult {
  return {
    ok: true,
    code: 'OK',
    message: 'cgc exited 0',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    durationMs: 1,
    argv: [...args],
    cwd: '/unused',
    ...overrides,
  }
}

/** Minimal runner stand-in: canned results keyed by the joined argument array. */
class GateMockRunner {
  calls: { cwd: string; args: string[] }[] = []
  results = new Map<string, CgcCommandResult>()
  /** When set, non-version runs never resolve (the never-block test). */
  hangNonVersion = false

  run(cwd: string, options: { args: readonly string[] }): Promise<CgcCommandResult> {
    this.calls.push({ cwd, args: [...options.args] })
    if (this.hangNonVersion && options.args[0] !== '--version') {
      return new Promise<CgcCommandResult>(() => {
        // Never resolves.
      })
    }
    const key = options.args.join(' ')
    return Promise.resolve(this.results.get(key) ?? okResult(options.args))
  }
}

/** Runner stand-in that records the per-call time budget (probe-wiring probe). */
class TimeoutRecordingRunner {
  calls: { cwd: string; args: readonly string[]; timeoutMs?: number | undefined }[] = []
  results = new Map<string, CgcCommandResult>()

  run(
    cwd: string,
    options: { args: readonly string[]; timeoutMs?: number },
  ): Promise<CgcCommandResult> {
    this.calls.push({ cwd, args: [...options.args], timeoutMs: options.timeoutMs })
    const key = options.args.join(' ')
    return Promise.resolve(this.results.get(key) ?? okResult(options.args))
  }
}

function makeConfig(
  overrides: Partial<{ autoCreate: boolean; syncOnStart: boolean }> = {},
): ExtensionConfig {
  return {
    cgc: {
      executable: 'cgc',
      timeoutMs: 30_000,
      maintenanceTimeoutMs: 600_000,
      versionProbeTimeoutMs: 10_000,
      api: { enabled: true, port: 8_000 },
    },
    lifecycle: {
      autoCreate: overrides.autoCreate ?? false,
      syncOnStart: overrides.syncOnStart ?? true,
    },
    worktree: { mode: 'off' },
    proactive: { sessionNote: true, driftSteers: false, resultAnnotations: false },
    freshness: { watch: false, autoSync: true, maxSyncsPerSession: 2 },
    output: { maxBytes: 16_384, spillToTemp: true, redactSecrets: true, gcf: false },
    tools: { cliGap: { enabled: true } },
    guidance: { routingSkill: false },
  }
}

interface GateOptions {
  config?: ExtensionConfig
  notify?: GateNoticeSink
  classifier?: GateClassifierLike
}

function makeGate(runner: GateMockRunner, options: GateOptions = {}): LifecycleGate {
  return new LifecycleGate({
    runner: runner as unknown as CgcRunner,
    config: options.config ?? makeConfig(),
    ...(options.notify === undefined ? {} : { notify: options.notify }),
    ...(options.classifier === undefined ? {} : { classifier: options.classifier }),
  })
}

function makeRegisteredGate(options: GateOptions = {}): {
  gate: LifecycleGate
  runner: GateMockRunner
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>
} {
  const runner = new GateMockRunner()
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  const api: GateExtensionApi = {
    on: (event, handler) => {
      handlers.set(event, handler)
      return undefined
    },
  }
  const gate = new LifecycleGate({
    runner: runner as unknown as CgcRunner,
    config: options.config ?? makeConfig(),
    api,
    ...(options.notify === undefined ? {} : { notify: options.notify }),
  })
  gate.register()
  return { gate, runner, handlers }
}

function makeApi(): {
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>
  api: GateExtensionApi
} {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  const api: GateExtensionApi = {
    on: (event, handler) => {
      handlers.set(event, handler)
      return undefined
    },
  }
  return { handlers, api }
}

const versionResult = () => okResult(['--version'], { stdout: 'cgc 0.1.0\n' })

const stats = {
  clean: () => okResult(['stats'], { stdout: 'Repository statistics: 42 files indexed\n' }),
  drift: () => okResult(['stats'], { stdout: 'index is stale: 3 files changed since last sync\n' }),
  corrupt: () => okResult(['stats'], { stdout: 'database is corrupt\n' }),
  busy: () =>
    okResult(['stats'], {
      ok: false,
      code: 'BUSY',
      message: 'cgc reported an embedded-database lock conflict',
      stderr: 'Could not set lock on file',
    }),
}

const indexResult = (overrides: Partial<CgcCommandResult> = {}) =>
  okResult(['index', '.'], overrides)

function mockClassification(cwd: string, state: LifecycleState): LifecycleClassification {
  return {
    cwd,
    state,
    indexed: state !== 'unindexed',
    probe: {
      available: true,
      code: 'OK',
      version: '0.1.0',
      message: 'cgc is available',
      cached: false,
    },
    health: null,
    reason: `mock ${state}`,
    at: Date.now(),
  }
}

/** Classifier override whose classify() rejects N times, then succeeds (or always). */
class FlakyClassifier {
  calls = 0
  constructor(
    private readonly state: LifecycleState,
    private readonly rejectFirst: number,
    private readonly alwaysReject = false,
  ) {}

  classify(cwd: string): Promise<LifecycleClassification> {
    this.calls += 1
    if (this.alwaysReject || this.calls <= this.rejectFirst) {
      return Promise.reject(new Error('classifier exploded'))
    }
    return Promise.resolve(mockClassification(cwd, this.state))
  }

  reset(): void {
    this.calls = 0
  }
}

/** Classifier override that always resists routing: an unexpected state. */
function weirdClassifier(): GateClassifierLike {
  return {
    classify: (cwd: string) => Promise.resolve(mockClassification(cwd, 'wacky' as LifecycleState)),
    reset: () => {
      // no-op
    },
  }
}

let createdDirs: string[] = []

function makeWorkspace(indexed: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'cgc-gate-'))
  createdDirs.push(dir)
  if (indexed) mkdirSync(join(dir, '.codegraphcontext'), { recursive: true })
  return dir
}

afterEach(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  createdDirs = []
})

/** Wait until the recorded last action for the workspace has the given kind. */
async function settleUntil(gate: LifecycleGate, cwd: string, kind: string): Promise<void> {
  // Yield to the MACROtask queue (timers / I/O / process events), not just microtasks:
  // `await Promise.resolve()` never lets a spawned-CLI completion callback run, so under CI
  // load this loop could exhaust before the action settles (observed 2026-09-15 in
  // release-branch CI, run 34975161174). Poll with real event-loop yields and a generous
  // budget — when the state is already settled the first check returns immediately.
  for (let i = 0; i < 1000; i++) {
    if (gate.snapshot(cwd)?.lastAction?.kind === kind) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`state never settled to ${kind}`)
}

describe('buildUnavailableNotice', () => {
  it('names the workspace, the reason, and every enablement route', () => {
    const text = buildUnavailableNotice('/repo', 'spawn failed')
    expect(text).toContain('/repo')
    expect(text).toContain('spawn failed')
    expect(text).toContain('CGC_EXECUTABLE')
    expect(text).toContain('.pi/cgc.json')
    expect(text).toContain('~/.pi/agent/cgc.json')
    expect(text).toContain('PATH')
  })
})

describe('LifecycleGate session hooks (task 3.2: guarded, non-blocking)', () => {
  it('wires both session hooks and is idempotent', () => {
    const { handlers, api } = makeApi()
    const runner = new GateMockRunner()
    const gate = new LifecycleGate({
      runner: runner as unknown as CgcRunner,
      config: makeConfig(),
      api,
    })

    gate.register()
    gate.register()

    expect(handlers.has('session_start')).toBe(true)
    expect(handlers.has('session_shutdown')).toBe(true)
  })

  it('is a fail-open no-op when no api is supplied (tests drive evaluate directly)', () => {
    const gate = makeGate(new GateMockRunner())
    expect(() => gate.register()).not.toThrow()
    expect(() => gate.dispose()).not.toThrow()
  })

  it('never throws on a garbage or missing session context', async () => {
    const { handlers } = makeRegisteredGate()
    const sessionStart = handlers.get('session_start') as (event: unknown, ctx: unknown) => unknown

    expect(() => sessionStart({ type: 'session_start' }, null)).not.toThrow()
    expect(() => sessionStart({ type: 'session_start' }, {})).not.toThrow()
    expect(() => sessionStart({ type: 'session_start' }, { cwd: 42 })).not.toThrow()
    expect(() => sessionStart({ type: 'session_start' }, { cwd: '' })).not.toThrow()
    // A throwing ui.notify must not break the hook either.
    expect(() =>
      sessionStart(
        { type: 'session_start' },
        {
          cwd: makeWorkspace(false),
          ui: {
            notify: () => {
              throw new Error('ui exploded')
            },
          },
        },
      ),
    ).not.toThrow()
  })

  it('returns immediately without awaiting cgc completion (never blocks the loop)', () => {
    const runner = new GateMockRunner()
    runner.results.set('--version', versionResult())
    runner.hangNonVersion = true
    const cwd = makeWorkspace(true)

    const { handlers, api } = makeApi()
    const gate = new LifecycleGate({
      runner: runner as unknown as CgcRunner,
      config: makeConfig(),
      api,
    })
    gate.register()
    const sessionStart = handlers.get('session_start') as (event: unknown, ctx: unknown) => unknown

    // The health probe never resolves; a blocking gate would never return.
    const returned = sessionStart({ type: 'session_start' }, { cwd, ui: {} })

    expect(returned).toBeUndefined()
    expect(runner.calls.length).toBeGreaterThan(0)
  })

  it('resolves the workspace from ctx.cwd (never process.cwd) and works in the background', async () => {
    const { gate, runner, handlers } = makeRegisteredGate()
    runner.results.set('--version', versionResult())
    runner.results.set('stats', stats.clean())
    const cwd = makeWorkspace(true)

    handlers.get('session_start')?.({ type: 'session_start' }, { cwd })

    const outcome = await gate.whenEvaluated(cwd)
    expect(outcome?.attempted).toBe(true)
    expect(outcome?.state).toBe('clean')
    expect(gate.snapshot(cwd)?.cwd).toBe(cwd)
    expect(runner.calls.every((c) => c.cwd === cwd)).toBe(true)
    expect(gate.snapshot(cwd)?.lastAction?.kind).toBe('clean-skipped')
  })
})

describe('LifecycleGate state routing (task 3.2)', () => {
  it('routes unavailable: one-time warning notice, no work beyond the probe', async () => {
    const runner = new GateMockRunner()
    runner.results.set(
      '--version',
      okResult(['--version'], { ok: false, code: 'UNAVAILABLE', message: 'cgc not found' }),
    )
    const cwd = makeWorkspace(false)
    const notices: string[] = []
    const gate = makeGate(runner, { notify: (text) => notices.push(text) })

    const first = await gate.evaluate(cwd)
    await gate.evaluate(cwd)

    expect(first.state).toBe('unavailable')
    expect(notices.length).toBe(1) // one-time
    expect(notices[0]).toContain('unavailable')
    expect(gate.snapshot(cwd)?.state).toBe('unavailable')
    expect(gate.snapshot(cwd)?.lastAction?.kind).toBe('unavailable-notice')
    expect(runner.calls.filter((c) => c.args[0] === 'index')).toEqual([])
  })

  it('routes unindexed (autoCreate off) to the one-time notice without indexing', async () => {
    const runner = new GateMockRunner()
    runner.results.set('--version', versionResult())
    const cwd = makeWorkspace(false)
    const notices: string[] = []
    const gate = makeGate(runner, { notify: (text) => notices.push(text) })

    const outcome = await gate.evaluate(cwd)

    expect(outcome.state).toBe('unindexed')
    expect(notices.length).toBe(1)
    expect(notices[0]).toContain('autoCreate')
    expect(gate.snapshot(cwd)?.lastAction?.kind).toBe('unindexed-notice')
    expect(runner.calls.some((c) => c.args[0] === 'index')).toBe(false)
  })

  it('routes unindexed (autoCreate on) to background indexing and records the settle', async () => {
    const runner = new GateMockRunner()
    runner.results.set('--version', versionResult())
    const cwd = makeWorkspace(false)
    const gate = makeGate(runner, { config: makeConfig({ autoCreate: true }) })

    await gate.evaluate(cwd)
    await settleUntil(gate, cwd, 'indexing-settled')

    expect(runner.calls.filter((c) => c.args.join(' ') === 'index .')).toHaveLength(1)
    expect(gate.snapshot(cwd)?.lastAction?.kind).toBe('indexing-settled')
    expect(gate.snapshot(cwd)?.lastAction?.ok).toBe(true)
    expect(gate.snapshot(cwd)?.activity).toBe('idle')
  })

  it('routes drift to a background sync and records the settle', async () => {
    const runner = new GateMockRunner()
    runner.results.set('--version', versionResult())
    runner.results.set('stats', stats.drift())
    const cwd = makeWorkspace(true)
    const gate = makeGate(runner)

    await gate.evaluate(cwd)
    await settleUntil(gate, cwd, 'drift-sync-settled')

    expect(runner.calls.filter((c) => c.args.join(' ') === 'index .')).toHaveLength(1)
    expect(gate.snapshot(cwd)?.lastAction?.kind).toBe('drift-sync-settled')
  })

  it('respects syncOnStart off: drift reports disabled and spawns nothing', async () => {
    const runner = new GateMockRunner()
    runner.results.set('--version', versionResult())
    runner.results.set('stats', stats.drift())
    const cwd = makeWorkspace(true)
    const gate = makeGate(runner, { config: makeConfig({ syncOnStart: false }) })

    await gate.evaluate(cwd)

    expect(gate.snapshot(cwd)?.lastAction?.kind).toBe('drift-sync-disabled')
    expect(runner.calls.filter((c) => c.args.join(' ') === 'index .')).toEqual([])
  })

  it('routes corrupt to the one-time report + offer with no destructive action', async () => {
    const runner = new GateMockRunner()
    runner.results.set('--version', versionResult())
    runner.results.set('stats', stats.corrupt())
    const cwd = makeWorkspace(true)
    const notices: string[] = []
    const gate = makeGate(runner, { notify: (text) => notices.push(text) })

    await gate.evaluate(cwd)

    expect(gate.snapshot(cwd)?.state).toBe('corrupt')
    expect(gate.snapshot(cwd)?.lastAction?.kind).toBe('corrupt-notice')
    expect(notices.length).toBe(1)
    expect(notices[0]).toContain('rebuild')
    expect(runner.calls.filter((c) => c.args[0] === 'index')).toEqual([])
  })

  it('routes busy (probe) to skip-as-busy with a one-time notice', async () => {
    const runner = new GateMockRunner()
    runner.results.set('--version', versionResult())
    runner.results.set('stats', stats.busy())
    const cwd = makeWorkspace(true)
    const notices: string[] = []
    const gate = makeGate(runner, { notify: (text) => notices.push(text) })

    await gate.evaluate(cwd)

    expect(gate.snapshot(cwd)?.state).toBe('busy')
    expect(gate.snapshot(cwd)?.lastAction?.kind).toBe('busy-skipped')
    expect(notices[0]).toContain('busy')
  })

  it('routes clean: silent skip with zero maintenance invocations', async () => {
    const runner = new GateMockRunner()
    runner.results.set('--version', versionResult())
    runner.results.set('stats', stats.clean())
    const cwd = makeWorkspace(true)
    const gate = makeGate(runner)

    await gate.evaluate(cwd)

    expect(gate.snapshot(cwd)?.state).toBe('clean')
    expect(gate.snapshot(cwd)?.lastAction?.kind).toBe('clean-skipped')
    expect(gate.notices()).toEqual([])
    expect(runner.calls.filter((c) => c.args[0] === 'index')).toEqual([])
  })

  it('routes a BUSY-settled maintenance command to skip-as-busy (one-time notice)', async () => {
    const runner = new GateMockRunner()
    runner.results.set('--version', versionResult())
    runner.results.set('index .', indexResult({ ok: false, code: 'BUSY' }))
    const cwd = makeWorkspace(false) // unindexed -> autoCreate starts index . -> BUSY
    const notices: string[] = []
    const gate = makeGate(runner, {
      config: makeConfig({ autoCreate: true }),
      notify: (text) => notices.push(text),
    })

    await gate.evaluate(cwd)
    await settleUntil(gate, cwd, 'busy-skipped')

    expect(gate.snapshot(cwd)?.lastAction?.kind).toBe('busy-skipped')
    expect(notices.some((n) => n.includes('busy'))).toBe(true)
    // No retry: the failed command ran exactly once.
    expect(runner.calls.filter((c) => c.args.join(' ') === 'index .')).toHaveLength(1)
  })

  it('records a failed settle as failed work and does not retry it', async () => {
    const runner = new GateMockRunner()
    runner.results.set('--version', versionResult())
    runner.results.set('index .', indexResult({ ok: false, code: 'COMMAND_FAILED' }))
    const cwd = makeWorkspace(false)
    const gate = makeGate(runner, { config: makeConfig({ autoCreate: true }) })

    await gate.evaluate(cwd)
    await settleUntil(gate, cwd, 'indexing-settled')

    expect(gate.snapshot(cwd)?.lastAction?.ok).toBe(false)
    expect(gate.snapshot(cwd)?.lastAction?.kind).toBe('indexing-settled')
    expect(runner.calls.filter((c) => c.args.join(' ') === 'index .')).toHaveLength(1)
  })
})

describe('LifecycleGate fail-open and one-retry cap (task 3.2)', () => {
  it('never rejects a failed evaluation and records it as gate-failed', async () => {
    const classifier = new FlakyClassifier('clean', 1, true)
    const gate = makeGate(new GateMockRunner(), { classifier })

    const outcome = await gate.evaluate('/repo')

    expect(outcome.failed).toBe(true)
    expect(outcome.attempted).toBe(true)
    expect(outcome.state).toBe('unavailable') // nothing recorded yet — the fail-safe fallback
    expect(gate.snapshot('/repo')?.lastAction?.kind).toBe('gate-failed')
    expect(gate.hasRetryBeenClaimed('/repo')).toBe(false)
  })

  it('allows exactly one retry of a failed evaluation per workspace per session', async () => {
    const classifier = new FlakyClassifier('clean', 0, true)
    const gate = makeGate(new GateMockRunner(), { classifier })

    const first = await gate.evaluate('/repo')
    expect(first.failed).toBe(true)

    const second = await gate.evaluate('/repo') // the one allowed retry — also fails
    expect(second.attempted).toBe(true)
    expect(second.failed).toBe(true)
    expect(gate.hasRetryBeenClaimed('/repo')).toBe(true)

    const third = await gate.evaluate('/repo') // refused: no more retries this session
    expect(third.attempted).toBe(false)
    expect(third.refusedReason).not.toBeNull()
    expect(third.refusedReason).toContain('retry refused')
    expect(gate.snapshot('/repo')?.lastAction?.kind).toBe('gate-retry-refused')
  })

  it('claims the single retry and lets a later attempt succeed', async () => {
    const classifier = new FlakyClassifier('clean', 1) // fails once, then succeeds
    const gate = makeGate(new GateMockRunner(), { classifier })

    const first = await gate.evaluate('/repo')
    expect(first.failed).toBe(true)

    const second = await gate.evaluate('/repo')
    expect(second.failed).toBe(false)
    expect(second.attempted).toBe(true)
    expect(second.repeated).toBe(false)
    expect(gate.hasRetryBeenClaimed('/repo')).toBe(true)

    const third = await gate.evaluate('/repo') // success cleared the marker — no refusal
    expect(third.attempted).toBe(true)
    expect(third.refusedReason).toBeNull()
  })

  it('fail-open on an unexpected classifier state (records without throwing)', async () => {
    const gate = makeGate(new GateMockRunner(), { classifier: weirdClassifier() })

    const outcome = await gate.evaluate('/repo')

    expect(outcome.attempted).toBe(true)
    expect(outcome.failed).toBe(false)
    expect(gate.snapshot('/repo')?.lastAction?.kind).toBe('gate-failed')
  })
})

describe('LifecycleGate session lifecycle', () => {
  it('clears everything on session_shutdown; the next session starts fresh', async () => {
    const { gate, handlers } = makeRegisteredGate()
    const cwd = makeWorkspace(false)
    const other = makeWorkspace(false)

    handlers.get('session_start')?.({ type: 'session_start' }, { cwd })
    await gate.whenEvaluated(cwd)
    expect(gate.notices().length).toBe(1)
    expect(gate.snapshot(cwd)).not.toBeNull()

    handlers.get('session_shutdown')?.({ type: 'session_shutdown', reason: 'quit' }, {})

    expect(gate.snapshot(cwd)).toBeNull()
    expect(gate.notices()).toEqual([])

    handlers.get('session_start')?.({ type: 'session_start' }, { cwd: other })
    await gate.whenEvaluated(other)

    expect(gate.snapshot(other)?.cwd).toBe(other)
    expect(gate.snapshot(other)?.lastAction?.kind).toBe('unindexed-notice')
    expect(gate.snapshot(cwd)).toBeNull()
  })

  it('re-evaluating the same workspace in one session is a repeat, not a re-do', async () => {
    const runner = new GateMockRunner()
    runner.results.set('--version', versionResult())
    runner.results.set('stats', stats.clean())
    const cwd = makeWorkspace(true)
    const gate = makeGate(runner)

    const first = await gate.evaluate(cwd)
    const second = await gate.evaluate(cwd)

    expect(first.attempted).toBe(true)
    expect(second.repeated).toBe(true)
    expect(runner.calls.filter((c) => c.args[0] === 'index')).toHaveLength(0)
    expect(gate.snapshot(cwd)?.lastAction?.kind).toBe('clean-skipped')
  })

  it('surfaces the one-retry constant the shared ledger enforces', () => {
    expect(MAX_GATE_EVALUATION_RETRIES_PER_SESSION).toBe(1)
    expect(GATE_EVALUATION_WORK).toBe('gate-evaluation')
  })
})

describe('LifecycleGate task 3.3 audit fills (probe budgets, dispose, teardown)', () => {
  it('register() is fail-open when the api throws on hook registration', async () => {
    const runner = new GateMockRunner()
    runner.results.set('--version', versionResult())
    const api: GateExtensionApi = {
      on: () => {
        throw new Error('api exploded')
      },
    }
    const gate = new LifecycleGate({
      runner: runner as unknown as CgcRunner,
      config: makeConfig(),
      api,
    })

    expect(() => gate.register()).not.toThrow()

    // The gate itself stays fully usable: evaluate() never touches the API.
    const outcome = await gate.evaluate('/repo')
    expect(outcome.attempted).toBe(true)
    expect(outcome.state).toBe('unindexed')
  })

  it('passes the configured probe time budgets through to cgc (D5 wiring)', async () => {
    const runner = new TimeoutRecordingRunner()
    runner.results.set('--version', versionResult())
    runner.results.set('stats', stats.clean())
    const cwd = makeWorkspace(true)
    const gate = new LifecycleGate({
      runner: runner as unknown as CgcRunner,
      config: {
        cgc: {
          executable: 'cgc',
          timeoutMs: 1_234,
          maintenanceTimeoutMs: 600_000,
          versionProbeTimeoutMs: 5_678,
          api: { enabled: true, port: 8_000 },
        },
        lifecycle: { autoCreate: false, syncOnStart: true },
        worktree: { mode: 'off' },
        proactive: { sessionNote: true, driftSteers: false, resultAnnotations: false },
        freshness: { watch: false, autoSync: true, maxSyncsPerSession: 2 },
        output: { maxBytes: 16_384, spillToTemp: true, redactSecrets: true, gcf: false },
        tools: { cliGap: { enabled: true } },
        guidance: { routingSkill: false },
      },
    })

    await gate.evaluate(cwd)

    const version = runner.calls.find((call) => call.args[0] === '--version')
    const health = runner.calls.find((call) => call.args[0] === 'stats')
    expect(version?.timeoutMs).toBe(5_678)
    expect(health?.timeoutMs).toBe(1_234)
    expect(health?.cwd).toBe(cwd)
  })

  it('after dispose(), the registered session hooks are no-ops', async () => {
    const runner = new GateMockRunner()
    runner.results.set('--version', versionResult())
    const cwd = makeWorkspace(false)
    const { handlers, api } = makeApi()
    const gate = new LifecycleGate({
      runner: runner as unknown as CgcRunner,
      config: makeConfig(),
      api,
    })
    gate.register()
    gate.dispose()

    expect(() => handlers.get('session_start')?.({ type: 'session_start' }, { cwd })).not.toThrow()
    expect(runner.calls).toEqual([])
    expect(() => handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, {})).not.toThrow()
    expect(gate.snapshot(cwd)).toBeNull()
  })

  it('whenEvaluated returns the one in-flight evaluation promise (dedup)', async () => {
    const cwd = makeWorkspace(false)
    const releaseBox: { release: (classification: LifecycleClassification) => void } = {
      release: () => {
        // Patched by classify().
      },
    }
    const classifier: GateClassifierLike = {
      classify: (_cwd: string) =>
        new Promise<LifecycleClassification>((resolve) => {
          releaseBox.release = resolve
        }),
      reset: () => {
        // no-op
      },
    }
    const { handlers, api } = makeApi()
    const gate = new LifecycleGate({
      runner: new GateMockRunner() as unknown as CgcRunner,
      config: makeConfig(),
      api,
      classifier,
    })
    gate.register()

    handlers.get('session_start')?.({ type: 'session_start' }, { cwd })

    const first = gate.whenEvaluated(cwd)
    const second = gate.whenEvaluated(cwd)
    expect(first).toBe(second)

    releaseBox.release(mockClassification(cwd, 'clean'))
    const outcome = await first
    const repeated = await second

    expect(outcome).toBe(repeated)
    expect(outcome?.state).toBe('clean')
    expect(gate.snapshot(cwd)?.lastAction?.kind).toBe('clean-skipped')
  })

  it('shuts down with an evaluation in flight: gate resets and the runner still sweeps the child', async () => {
    const workspace = makeWorkspace(true)
    const shimDir = mkdtempSync(join(tmpdir(), 'cgc-gate-shim-'))
    createdDirs.push(shimDir)
    const shim = join(shimDir, 'cgc-fake')
    const statsPidFile = join(shimDir, 'stats.pid')
    try {
      // A fake `cgc` whose version probe succeeds and whose stats probe hangs.
      writeFileSync(
        shim,
        [
          '#!/bin/sh',
          'if [ "$1" = "--version" ]; then',
          '  printf "CodeGraphContext, version 9.9.9\\n"',
          '  exit 0',
          'fi',
          'if [ "$1" = "stats" ]; then',
          `  printf "%s" "$$" > ${statsPidFile}`,
          '  exec sleep 60',
          'fi',
          'exit 2',
        ].join('\n'),
        'utf8',
      )
      chmodSync(shim, 0o755)

      const runner = new CgcRunner({ executable: shim })
      const { handlers, api } = makeApi()
      const gate = new LifecycleGate({ runner, config: makeConfig(), api })
      gate.register()

      handlers.get('session_start')?.({ type: 'session_start' }, { cwd: workspace })

      // Wait until the background evaluation's stats child is really in flight.
      let sawStats = false
      for (let i = 0; i < 500; i++) {
        try {
          sawStats = readFileSync(statsPidFile, 'utf8').length > 0
        } catch {
          // Not written yet.
        }
        if (sawStats && runner.isInFlight(workspace)) break
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
      expect(sawStats).toBe(true)
      expect(runner.isInFlight(workspace)).toBe(true)

      // The session ends while the evaluation is still running.
      handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, {})
      expect(gate.snapshot(workspace)).toBeNull()
      expect(gate.notices()).toEqual([])

      // The runner's own teardown path (cleanup.ts) still terminates the child:
      // no orphaned process is left holding the embedded database.
      const signalled = await runner.killAll()
      expect(signalled).toBeGreaterThanOrEqual(1)
      expect(runner.isInFlight(workspace)).toBe(false)
    } finally {
      rmSync(shimDir, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

/**
 * The post-resume corruption warning (fix/resume-corrupt-warning): pi
 * rebinds extensions on session replacement, and the outgoing session's
 * teardown sweep (cleanup.ts killAll) cancels any in-flight probe children.
 * The still-running background evaluation then receives CANCELLED probe
 * results, the fail-safe classifier maps them onto the corrupt bucket, and
 * — before the fix — the stale evaluation routed that classification on the
 * replaced session object, emitting the one-time "appears corrupt or
 * unusable" notice. A late classification for a replaced session is a
 * teardown artefact and must never surface.
 */
describe('LifecycleGate stale-evaluation drop (the post-resume corrupt warning)', () => {
  it('never notifies from a classification that lands after the session was replaced', async () => {
    const workspace = makeWorkspace(true)
    const shimDir = mkdtempSync(join(tmpdir(), 'cgc-gate-resume-'))
    createdDirs.push(shimDir)
    const shim = join(shimDir, 'cgc-fake')
    const statsStarted = join(shimDir, 'stats-started')
    try {
      // A fake `cgc`: the version probe succeeds; the stats probe hangs until
      // signalled — the teardown-cancelled probe of the /resume race.
      writeFileSync(
        shim,
        [
          '#!/bin/sh',
          'if [ "$1" = "--version" ]; then',
          '  printf "CodeGraphContext, version 9.9.9\\n"',
          '  exit 0',
          'fi',
          'if [ "$1" = "stats" ]; then',
          `  : > ${statsStarted}`,
          '  exec sleep 60',
          'fi',
          'exit 2',
        ].join('\n'),
        'utf8',
      )
      chmodSync(shim, 0o755)

      const runner = new CgcRunner({ executable: shim })
      const notifications: { text: string; type: string }[] = []
      const { handlers, api } = makeApi()
      const gate = new LifecycleGate({
        runner,
        config: makeConfig(),
        api,
        notify: (text, type) => notifications.push({ text, type }),
      })
      gate.register()

      // The session-start evaluation runs in the background exactly as at
      // launch; the hanging stats child is its in-flight probe.
      handlers.get('session_start')?.(
        { type: 'session_start' },
        {
          cwd: workspace,
          ui: { notify: () => undefined },
        },
      )
      for (let i = 0; i < 500; i++) {
        if (existsSync(statsStarted) && runner.isInFlight(workspace)) break
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
      expect(runner.isInFlight(workspace)).toBe(true)

      // /resume: pi emits session_shutdown for the outgoing session, then
      // the teardown sweep cancels every in-flight probe child while the
      // evaluation is still awaiting it.
      handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, {})
      await runner.killAll()

      // The CANCELLED result settles the stale evaluation; the fail-safe
      // classifier maps it onto the corrupt bucket. The replaced session
      // must surface nothing.
      for (let i = 0; i < 200; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      expect(notifications).toEqual([])
    } finally {
      rmSync(shimDir, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('LifecycleGate worktree isolation wiring (task 2.2: carry the mapped --context flag)', () => {
  function makeFakeRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), 'cgc-gate-repo-'))
    createdDirs.push(repo)
    mkdirSync(join(repo, '.git'), { recursive: true })
    return repo
  }

  function makeFakeWorktree(commonDir: string, id: string): string {
    const wt = mkdtempSync(join(tmpdir(), 'cgc-gate-wt-'))
    createdDirs.push(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${join(commonDir, 'worktrees', id)}\n`, 'utf8')
    return wt
  }

  /** A fake `cgc` that logs every argv, answers verbs, and returns 0. */
  function installFakeCgc(log: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cgc-gate-cgc-'))
    createdDirs.push(dir)
    const executable = join(dir, 'cgc')
    const quoted = `'${log.replace(/'/g, `'\\''`)}'`
    writeFileSync(
      executable,
      `${[
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${quoted}`,
        'while [ "$1" = "--context" ] || [ "$1" = "-c" ]; do',
        '  shift 2',
        'done',
        'case "$1" in',
        '  --version) echo "cgc 0.1.0"; exit 0 ;;',
        '  stats) echo "Repository statistics: 42 files indexed"; exit 0 ;;',
        '  index) echo "index ok"; exit 0 ;;',
        // The deliberate delay keeps the creation-in-flight window open past
        // session route time, so the no-maintenance-while-creating policy is
        // observable without racing the settle chain.
        '  context) sleep 0.3; echo "context ok"; exit 0 ;;',
        '  *) echo "unknown command: $1"; exit 1 ;;',
        'esac',
      ].join('\n')}\n`,
      'utf8',
    )
    chmodSync(executable, 0o755)
    return executable
  }

  function isolateConfig(
    overrides: Partial<{ autoCreate: boolean; syncOnStart: boolean }> = {},
  ): ExtensionConfig {
    return {
      cgc: {
        executable: 'cgc',
        timeoutMs: 30_000,
        maintenanceTimeoutMs: 600_000,
        versionProbeTimeoutMs: 10_000,
        api: { enabled: true, port: 8_000 },
      },
      lifecycle: {
        autoCreate: overrides.autoCreate ?? false,
        syncOnStart: overrides.syncOnStart ?? true,
      },
      worktree: { mode: 'isolate' },
      proactive: { sessionNote: true, driftSteers: false, resultAnnotations: false },
      freshness: { watch: false, autoSync: true, maxSyncsPerSession: 2 },
      output: { maxBytes: 16_384, spillToTemp: true, redactSecrets: true, gcf: false },
      tools: { cliGap: { enabled: true } },
      guidance: { routingSkill: false },
    }
  }

  function makeStubClassifier(state: LifecycleState): GateClassifierLike {
    return {
      classify: (cwd: string) => Promise.resolve(mockClassification(cwd, state)),
      reset: () => {
        // no-op
      },
    }
  }

  async function waitForLogContaining(log: string, needle: string): Promise<string[]> {
    for (let i = 0; i < 300; i++) {
      try {
        const text = readFileSync(log, 'utf8')
        if (text.includes(needle)) return text.trim().split('\n')
      } catch {
        // Not written yet.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`cgc invocation log never contained ${needle}`)
  }

  async function waitForRecordedMap(commonDir: string, cwd: string): Promise<void> {
    for (let i = 0; i < 300; i++) {
      try {
        const file = JSON.parse(readFileSync(join(commonDir, WORKTREE_MAP_FILE), 'utf8')) as {
          records: { cwd: string }[]
        }
        if (file.records.some((record) => record.cwd === cwd)) return
      } catch {
        // Not persisted yet.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`worktree map record for ${cwd} was never persisted`)
  }

  it('carries --context wt-<id> on every invocation while the mapping identity matches (reuse)', async () => {
    const repo = makeFakeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeFakeWorktree(commonDir, 'branch-a')
    const log = join(repo, 'cgc.log')
    const executable = installFakeCgc(log)
    // A durable mapping from a previous session.
    const recorded = new WorktreeMap({ detector: new WorktreeDetector() }).record(wt, 'wt-branch-a')
    expect(recorded.status).toBe('recorded')

    const runner = new CgcRunner({ executable, defaultTimeoutMs: 10_000 })
    const gate = new LifecycleGate({
      runner,
      config: isolateConfig({ autoCreate: true }),
      classifier: makeStubClassifier('unindexed'),
    })
    try {
      const outcome = await gate.evaluate(wt)
      expect(outcome.attempted).toBe(true)

      const lines = await waitForLogContaining(log, 'index .')
      // Automatic indexing for the worktree carries its mapped context; no
      // creation spawn happens on reuse of a verified mapping.
      expect(lines).toEqual(['--context wt-branch-a index .'])
    } finally {
      gate.reset()
      await runner.killAll()
    }
  })

  it('default mode (off) is zero change: a mapped worktree gets no flag injection', async () => {
    const repo = makeFakeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeFakeWorktree(commonDir, 'branch-a')
    const log = join(repo, 'cgc.log')
    const executable = installFakeCgc(log)
    expect(
      new WorktreeMap({ detector: new WorktreeDetector() }).record(wt, 'wt-branch-a').status,
    ).toBe('recorded')

    const runner = new CgcRunner({ executable, defaultTimeoutMs: 10_000 })
    const gate = new LifecycleGate({
      runner,
      config: {
        cgc: {
          executable: 'cgc',
          timeoutMs: 30_000,
          maintenanceTimeoutMs: 600_000,
          versionProbeTimeoutMs: 10_000,
          api: { enabled: true, port: 8_000 },
        },
        lifecycle: { autoCreate: true, syncOnStart: true },
        worktree: { mode: 'off' },
        proactive: { sessionNote: true, driftSteers: false, resultAnnotations: false },
        freshness: { watch: false, autoSync: true, maxSyncsPerSession: 2 },
        output: { maxBytes: 16_384, spillToTemp: true, redactSecrets: true, gcf: false },
        tools: { cliGap: { enabled: true } },
        guidance: { routingSkill: false },
      },
      classifier: makeStubClassifier('unindexed'),
    })
    try {
      await gate.evaluate(wt)
      const lines = await waitForLogContaining(log, 'index .')
      expect(lines).toEqual(['index .'])
    } finally {
      gate.reset()
      await runner.killAll()
    }
  })

  it('a worktree with no verified mapping receives no indexing spawns (consent declined)', async () => {
    const repo = makeFakeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeFakeWorktree(commonDir, 'branch-a')
    const log = join(repo, 'cgc.log')
    const executable = installFakeCgc(log)

    const runner = new CgcRunner({ executable, defaultTimeoutMs: 10_000 })
    const gate = new LifecycleGate({
      runner,
      config: isolateConfig({ autoCreate: false }),
      classifier: makeStubClassifier('unindexed'),
    })
    try {
      await gate.evaluate(wt)
      await settleUntil(gate, wt, 'worktree-isolation')
      // The declined guidance reached the notice surface.
      expect(gate.notices().some((n) => n.text.includes('wt-branch-a'))).toBe(true)
      // Nothing was spawned: no creation (consent closed) and no indexing
      // against CGC's default context (no verified mapping).
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      expect(existsSync(log)).toBe(false)
    } finally {
      gate.reset()
      await runner.killAll()
    }
  })

  it('fails open on an unreadable map file: no maintenance spawn, no mismatch state, no clobbering (containment)', async () => {
    const repo = makeFakeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeFakeWorktree(commonDir, 'branch-a')
    const log = join(repo, 'cgc.log')
    const executable = installFakeCgc(log)
    const mapPath = join(commonDir, WORKTREE_MAP_FILE)
    // An unreadable map must never be trusted, repaired, or retried into a
    // context name — even with the auto-create consent gate wide open.
    writeFileSync(mapPath, '{ not json', 'utf8')

    const runner = new CgcRunner({ executable, defaultTimeoutMs: 10_000 })
    const gate = new LifecycleGate({
      runner,
      config: isolateConfig({ autoCreate: true }),
      classifier: makeStubClassifier('unindexed'),
    })
    try {
      await gate.evaluate(wt)
      // The unreadable map resolves `unmapped`, never `mismatch`: the generic
      // worktree-isolation action is recorded — NOT the fail-closed
      // identity-mismatch state, whose once-per-session notice demands
      // re-consent for a condition the user did not cause.
      await settleUntil(gate, wt, 'worktree-isolation')
      expect(gate.notices().some((notice) => notice.text.includes('identity mismatch'))).toBe(false)

      // The block surface is honest: blocked because no mapping CAN be
      // verified, with no context name leaked from an unreadable record.
      expect(gate.worktreeBlockFor(wt)).toEqual({
        blocked: true,
        status: 'unmapped',
        contextName: null,
        reason: expect.stringContaining('unreadable'),
      })

      // Nothing spawns against CGC's default context: consented creation may
      // run, but no indexing maintenance follows while the map is unreadable
      // (the create settles into a refused record — degraded, never a fix).
      await waitForLogContaining(log, 'context create')
      expect(gate.snapshot(wt)?.lastAction?.kind).toBe('worktree-isolation')
      await new Promise<void>((resolve) => setTimeout(resolve, 400))
      const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
      expect(lines.some((line) => line.includes('index .'))).toBe(false)

      // Fail-open containment also means: the unreadable map is left exactly
      // as found — the extension never clobbers or discards it at the gate
      // wiring level (the map's own never-clobber guarantee, held end to end).
      expect(readFileSync(mapPath, 'utf8')).toBe('{ not json')
    } finally {
      gate.reset()
      await runner.killAll()
    }
  })

  it('the creation-in-flight window injects nothing and runs no maintenance (creating)', async () => {
    const repo = makeFakeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeFakeWorktree(commonDir, 'branch-a')
    const log = join(repo, 'cgc.log')
    const executable = installFakeCgc(log)

    const runner = new CgcRunner({ executable, defaultTimeoutMs: 10_000 })
    const gate = new LifecycleGate({
      runner,
      config: isolateConfig({ autoCreate: true }),
      classifier: makeStubClassifier('unindexed'),
    })
    try {
      await gate.evaluate(wt)
      // The consented creation runs WITHOUT the flag: at spawn time no
      // verified mapping exists (identity, not the derived name, is the
      // source of truth).
      const lines = await waitForLogContaining(log, 'context create')
      expect(lines).toEqual(['context create wt-branch-a'])
      // Maintenance stays off while the mapping is in flight: at route time
      // the workspace was still unmapped, so no index spawn happened.
      expect(lines.some((line) => line.includes('index .'))).toBe(false)
      // Once CGC confirms, the mapping is persisted (durable) — later
      // sessions reuse it and every invocation carries --context.
      await waitForRecordedMap(commonDir, wt)
    } finally {
      gate.reset()
      await runner.killAll()
    }
  })

  it('blocks maintenance spawns on identity mismatch (fail closed) until re-consent', async () => {
    const repo = makeFakeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeFakeWorktree(commonDir, 'branch-a')
    const log = join(repo, 'cgc.log')
    const executable = installFakeCgc(log)
    expect(
      new WorktreeMap({ detector: new WorktreeDetector() }).record(wt, 'wt-branch-a').status,
    ).toBe('recorded')
    // The checkout is re-pointed at a different worktree id: the recorded
    // identity no longer matches, so the context must not be used.
    writeFileSync(
      join(wt, '.git'),
      `gitdir: ${join(commonDir, 'worktrees', 'branch-a-renamed')}\n`,
      'utf8',
    )

    const runner = new CgcRunner({ executable, defaultTimeoutMs: 10_000 })
    const gate = new LifecycleGate({
      runner,
      config: isolateConfig({ autoCreate: true }),
      classifier: makeStubClassifier('unindexed'),
    })
    try {
      await gate.evaluate(wt)
      // Task 2.3: the mismatch records the DISTINCT identity-mismatch action
      // kind (not the generic no-mapping block) and surfaces the
      // identity-mismatch state once on the user-facing notice surface,
      // naming the blocked context and the fail-closed guarantee.
      await settleUntil(gate, wt, 'worktree-identity-mismatch')
      expect(gate.notices().some((notice) => notice.text.includes('wt-branch-a'))).toBe(true)
      expect(gate.notices().some((notice) => notice.text.includes('identity mismatch'))).toBe(true)
      expect(gate.notices().some((notice) => notice.text.includes('until you re-consent'))).toBe(
        true,
      )
      // The one-time guarantee: a second evaluation does not re-notify.
      const first = gate.notices().length
      await gate.evaluate(wt)
      expect(gate.notices().length).toBe(first)

      // The block surface commands/tests consume reports the mismatch in
      // isolate mode and resolves null in off mode.
      expect(gate.worktreeBlockFor(wt)).toEqual({
        blocked: true,
        status: 'mismatch',
        contextName: 'wt-branch-a',
        reason: expect.stringContaining('no longer matches'),
      })
      expect(gate.worktreeBlockFor(join(repo, 'missing-worktree'))).toEqual({
        blocked: false,
        status: 'not-worktree',
        contextName: null,
        reason: null,
      })

      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      expect(existsSync(log)).toBe(false)
    } finally {
      gate.reset()
      await runner.killAll()
    }
  })

  it('exposes worktreeBlockFor as a null no-op outside isolate mode (off = zero change)', async () => {
    const repo = makeFakeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeFakeWorktree(commonDir, 'branch-a')
    const log = join(repo, 'cgc.log')
    const executable = installFakeCgc(log)
    expect(
      new WorktreeMap({ detector: new WorktreeDetector() }).record(wt, 'wt-branch-a').status,
    ).toBe('recorded')
    writeFileSync(
      join(wt, '.git'),
      `gitdir: ${join(commonDir, 'worktrees', 'branch-a-renamed')}\n`,
      'utf8',
    )

    const runner = new CgcRunner({ executable, defaultTimeoutMs: 10_000 })
    const gate = new LifecycleGate({
      runner,
      config: {
        cgc: {
          executable: 'cgc',
          timeoutMs: 30_000,
          maintenanceTimeoutMs: 600_000,
          versionProbeTimeoutMs: 10_000,
          api: { enabled: true, port: 8_000 },
        },
        lifecycle: { autoCreate: true, syncOnStart: true },
        worktree: { mode: 'off' },
        proactive: { sessionNote: true, driftSteers: false, resultAnnotations: false },
        freshness: { watch: false, autoSync: true, maxSyncsPerSession: 2 },
        output: { maxBytes: 16_384, spillToTemp: true, redactSecrets: true, gcf: false },
        tools: { cliGap: { enabled: true } },
        guidance: { routingSkill: false },
      },
      classifier: makeStubClassifier('unindexed'),
    })
    try {
      await gate.evaluate(wt)
      // `off` mode: no worktree surface is wired, so every caller sees null
      // and behaves exactly as before (zero change).
      expect(gate.worktreeBlockFor(wt)).toBeNull()
      // Without an active session the surface is also a null no-op.
      gate.reset()
      expect(gate.worktreeBlockFor(wt)).toBeNull()
    } finally {
      gate.reset()
      await runner.killAll()
    }
  })

  it('surfaces one-time pruned-worktree notices (task 2.4) and deletes nothing', async () => {
    const repo = makeFakeRepo()
    const commonDir = join(repo, '.git')
    const wtLive = makeFakeWorktree(commonDir, 'branch-a')
    const wtPruned = makeFakeWorktree(commonDir, 'branch-b')
    const map = new WorktreeMap({ detector: new WorktreeDetector() })
    expect(map.record(wtLive, 'wt-branch-a').status).toBe('recorded')
    expect(map.record(wtPruned, 'wt-branch-b').status).toBe('recorded')
    // Prune one checkout: the durable mapping record survives; the directory
    // is gone, so a later session only ever sees a stale record for it.
    rmSync(wtPruned, { recursive: true, force: true })

    const { gate, handlers } = makeRegisteredGate({
      config: isolateConfig({ autoCreate: false }),
    })
    const sessionStart = handlers.get('session_start') as (event: unknown, ctx: unknown) => unknown
    const prunedNotices = () =>
      gate.notices().filter((notice) => notice.text.includes('wt-branch-b'))
    try {
      // Session starts inside the survived worktree of the same repository.
      // The pruned scan is synchronous in the session-start hook, so the
      // notice is already present once the hook returns.
      sessionStart({ type: 'session_start' }, { cwd: wtLive, ui: {} })
      expect(prunedNotices()).toHaveLength(1)
      expect(prunedNotices()[0]?.text).toContain('wt-branch-b')
      expect(prunedNotices()[0]?.text).toContain('/cgc_context delete')
      expect(prunedNotices()[0]?.text).toContain('Nothing was deleted')
      // The live mapping is not flagged as pruned.
      expect(gate.notices().some((notice) => notice.text.includes('wt-branch-a'))).toBe(false)
      // No autonomous deletion: the pruned record is still in the map file.
      const file = JSON.parse(readFileSync(join(commonDir, WORKTREE_MAP_FILE), 'utf8')) as {
        records: { cwd: string }[]
      }
      expect(file.records.some((record) => record.cwd === wtPruned)).toBe(true)

      // One-time per session: a second session start does not re-notify.
      sessionStart({ type: 'session_start' }, { cwd: wtLive, ui: {} })
      await gate.whenEvaluated(wtLive)
      expect(prunedNotices()).toHaveLength(1)

      // A fresh session re-surfaces the notice while the record stays stale:
      // reset() discards the old session (and its notice log), so the new
      // session's log holds exactly the re-emitted notice.
      gate.reset()
      sessionStart({ type: 'session_start' }, { cwd: wtLive, ui: {} })
      expect(prunedNotices()).toHaveLength(1)
    } finally {
      gate.reset()
    }
  })

  it('isolate mode fails open on a malformed .git pointer: the session proceeds as a non-worktree (containment)', async () => {
    const repo = makeFakeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeFakeWorktree(commonDir, 'branch-a')
    // The pointer is malformed: detection must degrade to non-worktree —
    // never a mismatch or an unmapped block — so the session proceeds exactly
    // as it would in a main checkout (spec: "Detection errors are contained").
    // Even with the auto-create consent gate wide open, not a single worktree
    // surface may fire.
    writeFileSync(join(wt, '.git'), 'not a git pointer\n', 'utf8')
    const log = join(repo, 'cgc.log')
    const executable = installFakeCgc(log)

    const runner = new CgcRunner({ executable, defaultTimeoutMs: 10_000 })
    const gate = new LifecycleGate({
      runner,
      config: isolateConfig({ autoCreate: true }),
      classifier: makeStubClassifier('unindexed'),
    })
    try {
      const outcome = await gate.evaluate(wt)
      expect(outcome.attempted).toBe(true)

      // Normal maintenance runs under CGC's default context resolution: no
      // --context flag, no creation spawn, no mapping — exactly a main
      // checkout's behavior.
      const lines = await waitForLogContaining(log, 'index .')
      expect(lines).toEqual(['index .'])
      await settleUntil(gate, wt, 'indexing-settled')

      // No worktree surface fired: no notices of any worktree kind.
      expect(gate.notices().some((notice) => notice.text.includes('worktree'))).toBe(false)

      // The block surface reports the honest, non-blocking degradation —
      // never a stale or ambiguous block — and no mapping was persisted.
      expect(gate.worktreeBlockFor(wt)).toEqual({
        blocked: false,
        status: 'not-worktree',
        contextName: null,
        reason: null,
      })
      expect(existsSync(join(commonDir, WORKTREE_MAP_FILE))).toBe(false)
    } finally {
      gate.reset()
      await runner.killAll()
    }
  })

  it('off mode never inspects .git: a malformed pointer stays zero change (default off)', async () => {
    // `off` wiring constructs no worktree components at all, so even a
    // malformed pointer file in the session cwd changes nothing: no
    // detection, no mapping, no block surface, no flag injection — the
    // default mode guarantee holds under adverse input too.
    const wt = makeWorkspace(false)
    writeFileSync(join(wt, '.git'), 'not a git pointer\n', 'utf8')

    const runner = new GateMockRunner()
    runner.results.set('--version', versionResult())
    const gate = makeGate(runner, {
      config: makeConfig({ autoCreate: true }),
      classifier: makeStubClassifier('unindexed'),
    })
    try {
      await gate.evaluate(wt)
      await settleUntil(gate, wt, 'indexing-settled')

      expect(gate.worktreeBlockFor(wt)).toBeNull()
      expect(gate.notices().some((notice) => notice.text.includes('worktree'))).toBe(false)
      const calls = runner.calls
      // No context creation and no --context injection anywhere.
      expect(calls.some((call) => call.args[0] === 'context')).toBe(false)
      expect(calls.some((call) => call.args.includes('--context'))).toBe(false)
      // The normal maintenance spawn still ran (zero change, not zero work).
      expect(calls.some((call) => call.args.join(' ') === 'index .')).toBe(true)
    } finally {
      gate.reset()
    }
  })
})

// ---------------------------------------------------------------------------
// Session rebind (add-cgc-session-rebind): pi re-runs the extension factory on
// every session replacement with a fresh API instance. The gate is a cached
// singleton, so register() must adopt a different API instance (re-arm and
// re-wire) while the same API stays the historical idempotent no-op.
// ---------------------------------------------------------------------------

type CountedHook = { event: 'session_start' | 'session_shutdown'; handler: GateHookHandler }

function countingGateApi(): { wired: CountedHook[]; api: GateExtensionApi } {
  const wired: CountedHook[] = []
  const api: GateExtensionApi = {
    on: (event, handler) => {
      wired.push({ event, handler })
      return undefined
    },
  }
  return { wired, api }
}

describe('LifecycleGate session rebind (add-cgc-session-rebind)', () => {
  it('rebinds both session hooks onto a replacement API and evaluates there', async () => {
    const runner = new GateMockRunner()
    runner.results.set('--version', versionResult())
    runner.results.set('stats', stats.clean())
    const cwd = makeWorkspace(true)

    const a = countingGateApi()
    const gate = new LifecycleGate({
      runner: runner as unknown as CgcRunner,
      config: makeConfig(),
      api: a.api,
    })
    gate.register()
    expect(a.wired.map((w) => w.event).sort()).toEqual(['session_shutdown', 'session_start'])

    // Same-API re-registration is the historical idempotent no-op.
    gate.register()
    expect(a.wired).toHaveLength(2)

    // Session replacement: the factory re-runs register() with the fresh API.
    const b = countingGateApi()
    gate.register(b.api)
    expect(b.wired.map((w) => w.event).sort()).toEqual(['session_shutdown', 'session_start'])
    // The replaced API gained no additional handlers.
    expect(a.wired).toHaveLength(2)

    // The rebound hooks actually work: a gate evaluation driven through the
    // replacement session's session_start records the snapshot and wires the
    // workspace, exactly as a first session would.
    const sessionStart = b.wired.find((w) => w.event === 'session_start')
    if (sessionStart === undefined) throw new Error('session_start not registered on the new api')
    sessionStart.handler({ type: 'session_start' }, { cwd })
    const outcome = await gate.whenEvaluated(cwd)
    expect(outcome?.state).toBe('clean')
    expect(gate.snapshot(cwd)?.state).toBe('clean')

    // A disposed gate stays inert: a rebind attempt wires nothing.
    gate.dispose()
    const c = countingGateApi()
    gate.register(c.api)
    expect(c.wired).toHaveLength(0)
  })
})
