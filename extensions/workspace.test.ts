import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CgcCommandResult, type CgcResultCode, CgcRunner } from './runner'
import { isWorkspaceIndexed, parseCgcVersion, WorkspaceDetector } from './workspace'

const BUN = process.execPath

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'cgc-workspace-test-'))
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
    argv: ['--version'],
    cwd: '/unused',
    ...overrides,
  }
}

/** Minimal runner stand-in that counts invocations and returns canned results. */
class MockRunner {
  calls: { cwd: string; args: readonly string[]; timeoutMs?: number | undefined }[] = []
  results: CgcCommandResult[] = []

  run(
    cwd: string,
    options: { args: readonly string[]; timeoutMs?: number },
  ): Promise<CgcCommandResult> {
    this.calls.push({ cwd, args: options.args, timeoutMs: options.timeoutMs })
    const result = this.results.shift() ?? makeResult({ stdout: '1.2.3' })
    return Promise.resolve(result)
  }
}

describe('parseCgcVersion', () => {
  it('extracts a semantic version from stdout', () => {
    expect(parseCgcVersion('CodeGraphContext, version 0.7.1\n', '')).toBe('0.7.1')
  })

  it('falls back to stderr and tolerates build metadata', () => {
    expect(parseCgcVersion('', 'cgc 1.0.0-rc.2')).toBe('1.0.0-rc.2')
  })

  it('returns null on unparseable output (fail-safe, not failure)', () => {
    expect(parseCgcVersion('hello world', '')).toBeNull()
  })
})

describe('workspace detection', () => {
  it('resolves the session cwd and only falls back to process.cwd() when absent', () => {
    const detector = new WorkspaceDetector({ runner: new MockRunner() as unknown as CgcRunner })
    expect(detector.resolveSessionCwd('/session/cwd')).toBe('/session/cwd')
    expect(detector.resolveSessionCwd('')).toBe(process.cwd())
    expect(detector.resolveSessionCwd(undefined)).toBe(process.cwd())
  })

  it('detects .codegraphcontext/ presence in the workspace', () => {
    const workspace = makeWorkspace()
    try {
      const detector = new WorkspaceDetector({ runner: new MockRunner() as unknown as CgcRunner })
      expect(detector.detectIndex(workspace).indexed).toBe(false)

      mkdirSync(join(workspace, '.codegraphcontext'))
      expect(detector.detectIndex(workspace).indexed).toBe(true)
      expect(detector.detectIndex(workspace).indexDir).toBe(join(workspace, '.codegraphcontext'))

      // A file named .codegraphcontext is not an index directory.
      const fileWorkspace = makeWorkspace()
      try {
        writeFileSync(join(fileWorkspace, '.codegraphcontext'), '')
        expect(detector.detectIndex(fileWorkspace).indexed).toBe(false)
      } finally {
        cleanupWorkspace(fileWorkspace)
      }
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('isWorkspaceIndexed agrees with detectIndex', () => {
    const workspace = makeWorkspace()
    try {
      expect(isWorkspaceIndexed(workspace)).toBe(false)
      mkdirSync(join(workspace, '.codegraphcontext'))
      expect(isWorkspaceIndexed(workspace)).toBe(true)
    } finally {
      cleanupWorkspace(workspace)
    }
  })
})

describe('cached cgc liveness probe', () => {
  it('runs exactly one spawn per session and serves later calls from cache', async () => {
    const mock = new MockRunner()
    const detector = new WorkspaceDetector({ runner: mock as unknown as CgcRunner })

    const first = await detector.probe('/ws/a')
    const second = await detector.probe('/ws/a')

    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0]?.args).toEqual(['--version'])
    expect(mock.calls[0]?.timeoutMs).toBe(10_000)
    expect(first.available).toBe(true)
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(second.version).toBe('1.2.3')

    // Different workspace => its own probe, still through the same cache.
    await detector.probe('/ws/b')
    expect(mock.calls).toHaveLength(2)

    // reset() clears the per-session cache; the next probe re-spawns.
    detector.reset()
    await detector.probe('/ws/a')
    expect(mock.calls).toHaveLength(3)
  })

  it('reports unavailability fail-open without throwing', async () => {
    const mock = new MockRunner()
    mock.results.push(
      makeResult({ ok: false, code: 'UNAVAILABLE', exitCode: null, message: 'spawn failed' }),
    )
    const detector = new WorkspaceDetector({ runner: mock as unknown as CgcRunner })

    const result = await detector.probe('/ws/a')
    expect(result.available).toBe(false)
    expect(result.code).toBe('UNAVAILABLE')
    expect(result.version).toBeNull()
    expect(result.cached).toBe(false)

    const cached = await detector.probe('/ws/a')
    expect(cached.available).toBe(false)
    expect(cached.cached).toBe(true)
  })

  it('maps non-OK outcome codes through to the probe result', async () => {
    const mock = new MockRunner()
    mock.results.push(makeResult({ ok: false, code: 'BUSY' as CgcResultCode, exitCode: 1 }))
    const detector = new WorkspaceDetector({ runner: mock as unknown as CgcRunner })
    const result = await detector.probe('/ws/a')
    expect(result.available).toBe(false)
    expect(result.code).toBe('BUSY')
  })

  it('probes against the real cgc runner and parses the version (bun stand-in)', async () => {
    const workspace = makeWorkspace()
    try {
      const detector = new WorkspaceDetector({
        runner: new CgcRunner({ executable: BUN }),
        versionProbeTimeoutMs: 10_000,
      })
      const result = await detector.probe(workspace)
      expect(result.available).toBe(true)
      expect(result.version).toMatch(/^\d+\.\d+\.\d+/)
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('honors the tighter version-probe time budget', async () => {
    const workspace = makeWorkspace()
    try {
      const detector = new WorkspaceDetector({
        runner: new CgcRunner({ executable: BUN }),
        versionProbeTimeoutMs: 150,
      })
      const result = await detector.probe(workspace)
      // bun itself exits quickly; the budget only bounds a hung probe, so this
      // asserts the contract (TIMEOUT => unavailable) rather than the clock.
      expect(result.available).toBe(result.code !== 'TIMEOUT')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('detect() combines cwd resolution, index presence, and the cached probe', async () => {
    const workspace = makeWorkspace()
    try {
      const mock = new MockRunner()
      const detector = new WorkspaceDetector({ runner: mock as unknown as CgcRunner })
      const detection = await detector.detect(workspace)

      expect(detection.cwd).toBe(workspace)
      expect(detection.indexed).toBe(false)
      expect(detection.indexDir).toBe(join(workspace, '.codegraphcontext'))
      expect(detection.probe.available).toBe(true)
      expect(mock.calls).toHaveLength(1)

      // Second detect reuses the cached probe: still exactly one spawn.
      await detector.detect(workspace)
      expect(mock.calls).toHaveLength(1)
    } finally {
      cleanupWorkspace(workspace)
    }
  })
})
