import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type HealthProbeResult, LifecycleClassifier, parseHealthProbe } from './classifier'
import type { CgcCommandResult, CgcRunner } from './runner'
import { WorkspaceDetector } from './workspace'

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'cgc-classifier-test-'))
}

function cleanupWorkspace(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

function makeResult(overrides: Partial<CgcCommandResult> = {}): CgcCommandResult {
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
    argv: ['stats'],
    cwd: '/unused',
    ...overrides,
  }
}

/** Realistic `cgc stats` report body (coarse-marker-parsable, healthy). */
const STATS_OUTPUT = [
  '📊 Overall Database Statistics',
  '',
  '┏━━━━━━━━━━━━━━┳━━━━━━━┓',
  '┃ Metric       ┃ Count ┃',
  '┡━━━━━━━━━━━━━━╇━━━━━━━┩',
  '│ Repositories │     3 │',
  '│ Files        │   434 │',
  '│ Functions    │   615 │',
  '└──────────────┴───────┘',
].join('\n')

const VERSION_OUTPUT = 'CodeGraphContext, version 1.2.3'

/**
 * Minimal runner stand-in. Canned results are queued separately for the
 * liveness probe (`--version`) and the health probe (`stats`); unprefilled
 * calls fall back to healthy defaults so tests only specify what matters.
 */
class MockRunner {
  calls: { cwd: string; args: readonly string[]; timeoutMs?: number | undefined }[] = []
  livenessResults: CgcCommandResult[] = []
  healthResults: CgcCommandResult[] = []
  /** When set, replaces the implementation entirely (failure-injection tests). */
  overrideRun?: (
    cwd: string,
    options: { args: readonly string[]; timeoutMs?: number },
  ) => Promise<CgcCommandResult>

  run(
    cwd: string,
    options: { args: readonly string[]; timeoutMs?: number },
  ): Promise<CgcCommandResult> {
    if (this.overrideRun) {
      return this.overrideRun(cwd, options)
    }
    this.calls.push({ cwd, args: options.args, timeoutMs: options.timeoutMs })
    if (options.args[0] === '--version') {
      const result =
        this.livenessResults.shift() ?? makeResult({ stdout: VERSION_OUTPUT, argv: ['--version'] })
      return Promise.resolve(result)
    }
    const result = this.healthResults.shift() ?? makeResult({ stdout: STATS_OUTPUT })
    return Promise.resolve(result)
  }
}

function makeClassifier(mock: MockRunner, _workspace?: string): LifecycleClassifier {
  const detector = new WorkspaceDetector({ runner: mock as unknown as CgcRunner })
  return new LifecycleClassifier({ detector, runner: mock as unknown as CgcRunner })
}

/** Give the workspace an index directory so classification reaches the probe. */
function seedIndex(workspace: string): void {
  mkdirSync(join(workspace, '.codegraphcontext'))
}

describe('parseHealthProbe', () => {
  it('recognizes healthy stats output as clean', () => {
    expect(parseHealthProbe(STATS_OUTPUT, '')).toEqual({
      verdict: 'clean',
      matched: ['health'],
    })
  })

  it('recognizes staleness markers as drift', () => {
    const parse = parseHealthProbe(
      'Repositories: 1\nRepository is stale: 12 files changed since last sync',
      '',
    )
    expect(parse.verdict).toBe('drift')
  })

  it('recognizes corruption markers with top precedence', () => {
    const parse = parseHealthProbe(
      'Stats: 3 repositories\nWarning: graph database is corrupt and inconsistent',
      '',
    )
    expect(parse.verdict).toBe('corrupt')
  })

  it('treats output with no recognizable markers as unparseable', () => {
    expect(parseHealthProbe('lorem ipsum dolor sit amet', '')).toEqual({
      verdict: 'unparseable',
      matched: [],
    })
    expect(parseHealthProbe('', '')).toEqual({ verdict: 'unparseable', matched: [] })
  })

  it('considers stderr as well as stdout', () => {
    expect(parseHealthProbe('', 'error: schema mismatch detected').verdict).toBe('corrupt')
  })
})

describe('five-state classification', () => {
  it('classifies an unusable cgc binary as unavailable', async () => {
    const workspace = makeWorkspace()
    try {
      seedIndex(workspace)
      const mock = new MockRunner()
      mock.livenessResults.push(
        makeResult({
          ok: false,
          code: 'UNAVAILABLE',
          exitCode: null,
          argv: ['--version'],
          message: 'spawn failed',
        }),
      )
      const classifier = makeClassifier(mock, workspace)

      const result = await classifier.classify(workspace)
      expect(result.state).toBe('unavailable')
      expect(result.indexed).toBe(true)
      expect(result.health).toBeNull()
      // No health probe is spent on an unavailable binary.
      expect(mock.calls).toHaveLength(1)
      expect(mock.calls[0]?.args).toEqual(['--version'])
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('classifies a workspace without .codegraphcontext/ as unindexed', async () => {
    const workspace = makeWorkspace()
    try {
      const mock = new MockRunner()
      const classifier = makeClassifier(mock, workspace)

      const result = await classifier.classify(workspace)
      expect(result.state).toBe('unindexed')
      expect(result.indexed).toBe(false)
      expect(result.health).toBeNull()
      // Only the cached liveness probe runs; no stats spawn.
      expect(mock.calls).toHaveLength(1)
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('classifies a lock conflict on the health probe as busy', async () => {
    const workspace = makeWorkspace()
    try {
      seedIndex(workspace)
      const mock = new MockRunner()
      mock.healthResults.push(
        makeResult({
          ok: false,
          code: 'BUSY',
          exitCode: 1,
          message: 'cgc reported an embedded-database lock conflict',
        }),
      )
      const classifier = makeClassifier(mock, workspace)

      const result = await classifier.classify(workspace)
      expect(result.state).toBe('busy')
      expect(result.health?.code).toBe('BUSY')
      expect(result.reason).toContain('lock')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('classifies parseable healthy stats output as clean', async () => {
    const workspace = makeWorkspace()
    try {
      seedIndex(workspace)
      const mock = new MockRunner()
      const classifier = makeClassifier(mock, workspace)

      const result = await classifier.classify(workspace)
      expect(result.state).toBe('clean')
      expect(result.health?.parse?.verdict).toBe('clean')
      expect(result.probe.available).toBe(true)
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('classifies staleness markers in the health probe as drift', async () => {
    const workspace = makeWorkspace()
    try {
      seedIndex(workspace)
      const mock = new MockRunner()
      mock.healthResults.push(
        makeResult({
          stdout: `${STATS_OUTPUT}\nRepository is outdated: files changed since last index`,
        }),
      )
      const classifier = makeClassifier(mock, workspace)

      const result = await classifier.classify(workspace)
      expect(result.state).toBe('drift')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('maps corruption markers to corrupt', async () => {
    const workspace = makeWorkspace()
    try {
      seedIndex(workspace)
      const mock = new MockRunner()
      mock.healthResults.push(makeResult({ stdout: `${STATS_OUTPUT}\nerror: index corrupt` }))
      const classifier = makeClassifier(mock, workspace)

      const result = await classifier.classify(workspace)
      expect(result.state).toBe('corrupt')
      expect(result.reason).toContain('corruption')
    } finally {
      cleanupWorkspace(workspace)
    }
  })
})

describe('fail-safe handling of unparseable and inconclusive probes', () => {
  it('maps unparseable OK output to corrupt (fail-safe unknown, never clean/drift)', async () => {
    const workspace = makeWorkspace()
    try {
      seedIndex(workspace)
      const mock = new MockRunner()
      mock.healthResults.push(makeResult({ stdout: '###\nrandom banner\n###\n' }))
      const classifier = makeClassifier(mock, workspace)

      const result = await classifier.classify(workspace)
      expect(result.state).toBe('corrupt')
      expect(result.health?.parse?.verdict).toBe('unparseable')
      expect(result.reason).toContain('unparseable')
      expect(result.reason).toContain('confirmation')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('maps a failed health probe to corrupt (inconclusive, never clean/drift)', async () => {
    const workspace = makeWorkspace()
    try {
      seedIndex(workspace)
      const mock = new MockRunner()
      mock.healthResults.push(
        makeResult({ ok: false, code: 'COMMAND_FAILED', exitCode: 2, stdout: '', stderr: '' }),
      )
      const classifier = makeClassifier(mock, workspace)

      const result = await classifier.classify(workspace)
      expect(result.state).toBe('corrupt')
      expect(result.reason).toContain('inconclusive')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('maps a timed-out health probe to corrupt (inconclusive, never clean/drift)', async () => {
    const workspace = makeWorkspace()
    try {
      seedIndex(workspace)
      const mock = new MockRunner()
      mock.healthResults.push(
        makeResult({ ok: false, code: 'TIMEOUT', exitCode: null, message: 'exceeded budget' }),
      )
      const classifier = makeClassifier(mock, workspace)

      const result = await classifier.classify(workspace)
      expect(result.state).toBe('corrupt')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('never throws when detection fails unexpectedly (fail-open)', async () => {
    const workspace = makeWorkspace()
    try {
      const mock = new MockRunner()
      const classifier = makeClassifier(mock, workspace)
      // Sabotage the detector to simulate an internal error.
      ;(classifier as unknown as { detector: { detect: () => Promise<never> } }).detector = {
        detect: () => Promise.reject(new Error('boom')),
      }

      const result = await classifier.classify(workspace)
      expect(result.state).toBe('unavailable')
      expect(result.reason).toContain('boom')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('never throws when the runner throws on the health probe', async () => {
    const workspace = makeWorkspace()
    try {
      seedIndex(workspace)
      const mock = new MockRunner()
      // Liveness succeeds; only the health probe's spawn path throws.
      mock.overrideRun = (_cwd, options) =>
        options.args[0] === '--version'
          ? Promise.resolve(makeResult({ stdout: VERSION_OUTPUT, argv: ['--version'] }))
          : Promise.reject(new TypeError('args must be strings'))
      const classifier = makeClassifier(mock, workspace)

      const result = await classifier.classify(workspace)
      expect(result.state).toBe('corrupt')
      expect(result.reason).toContain('inconclusive')
    } finally {
      cleanupWorkspace(workspace)
    }
  })
})

describe('health probe budget and caching', () => {
  it('passes the health-probe time budget and runs the probe through the runner', async () => {
    const workspace = makeWorkspace()
    try {
      seedIndex(workspace)
      const mock = new MockRunner()
      const detector = new WorkspaceDetector({ runner: mock as unknown as CgcRunner })
      const classifier = new LifecycleClassifier({
        detector,
        runner: mock as unknown as CgcRunner,
        healthProbeTimeoutMs: 1_234,
      })

      await classifier.classify(workspace)
      expect(mock.calls).toHaveLength(2)
      expect(mock.calls[1]?.args).toEqual(['stats'])
      expect(mock.calls[1]?.timeoutMs).toBe(1_234)
      expect(mock.calls[1]?.cwd).toBe(workspace)
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('caches the health probe per workspace; later classifications never re-spawn', async () => {
    const workspace = makeWorkspace()
    try {
      seedIndex(workspace)
      const mock = new MockRunner()
      const classifier = makeClassifier(mock, workspace)

      const first = await classifier.classify(workspace)
      const second = await classifier.classify(workspace)

      expect(mock.calls).toHaveLength(2) // 1 liveness (cached) + 1 health, total
      expect(first.health?.cached).toBe(false)
      expect(second.health?.cached).toBe(true)
      expect(second.state).toBe(first.state)
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('reset() clears the health cache so the next classification re-probes', async () => {
    const workspace = makeWorkspace()
    try {
      seedIndex(workspace)
      const mock = new MockRunner()
      const classifier = makeClassifier(mock, workspace)

      await classifier.classify(workspace)
      classifier.reset()
      await classifier.classify(workspace)
      expect(mock.calls).toHaveLength(3) // 1 liveness (detector cache) + 2 health

      const healthCalls = mock.calls.filter((call) => call.args[0] === 'stats')
      expect(healthCalls).toHaveLength(2)
    } finally {
      cleanupWorkspace(workspace)
    }
  })
})

describe('health probe result shape', () => {
  it('records truncation and code diagnostics on the health result', async () => {
    const workspace = makeWorkspace()
    try {
      seedIndex(workspace)
      const mock = new MockRunner()
      mock.healthResults.push(makeResult({ truncated: true, stdout: STATS_OUTPUT, durationMs: 42 }))
      const classifier = makeClassifier(mock, workspace)

      const result = await classifier.classify(workspace)
      const health = result.health as HealthProbeResult
      expect(health.truncated).toBe(true)
      expect(health.ok).toBe(true)
      expect(health.code).toBe('OK')
      expect(health.durationMs).toBe(42)
      expect(health.message).toContain('stats')
    } finally {
      cleanupWorkspace(workspace)
    }
  })
})
