import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LifecycleClassification, LifecycleState } from './classifier'
import type { ExtensionConfig } from './config'
import {
  buildUnavailableNotice,
  GATE_EVALUATION_WORK,
  type GateClassifierLike,
  type GateExtensionApi,
  type GateNoticeSink,
  LifecycleGate,
  MAX_GATE_EVALUATION_RETRIES_PER_SESSION,
} from './gate'
import type { CgcCommandResult } from './runner'
import { CgcRunner } from './runner'

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
    cgc: { executable: 'cgc', timeoutMs: 30_000, versionProbeTimeoutMs: 10_000 },
    lifecycle: {
      autoCreate: overrides.autoCreate ?? false,
      syncOnStart: overrides.syncOnStart ?? true,
    },
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
  for (let i = 0; i < 100; i++) {
    if (gate.snapshot(cwd)?.lastAction?.kind === kind) return
    await Promise.resolve()
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
        cgc: { executable: 'cgc', timeoutMs: 1_234, versionProbeTimeoutMs: 5_678 },
        lifecycle: { autoCreate: false, syncOnStart: true },
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
