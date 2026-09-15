// Pipeline matrix tests (change add-cgc-output-token-economy, task 2.2).
//
// Exercises the uniform output policy through the shared runner across the
// required matrix — small/oversized outputs, spill on/off, redaction on/off,
// GCF on/off, ANSI-rich input, and pipeline-stage failure injection — so the
// spec's scenarios (specs/cgc-output-economy/spec.md) are covered end to end
// rather than stage by stage.
//
// The failure-injection cases use the runner's `outputPolicy` test seam (see
// runner.ts): replacing the real pipeline with a throwing stage must still
// resolve the invocation with best-effort output and leave no spill file
// behind (spec scenario "Policy error is contained").

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CgcRunner } from './runner'

const BUN = process.execPath
const BUDGET = 2048
// 32+ hex chars with variety: hash/key-shaped, so high-entropy redaction fires.
const HIGH_ENTROPY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'

function makeTemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Session spill directories (and their files) left under a test base. */
function spillDirs(base: string): string[] {
  return readdirSync(base).filter((entry) => entry.startsWith('pi-cgc-spill'))
}

function spillFiles(base: string): string[] {
  return spillDirs(base).flatMap((dir) => readdirSync(join(base, dir)))
}

function removeAll(...paths: string[]): void {
  for (const path of paths) rmSync(path, { recursive: true, force: true })
}

describe('pipeline matrix: bounded capture (task 2.2)', () => {
  it('small output passes through complete and unmarked', async () => {
    const workspace = makeTemp('cgc-matrix-ws-')
    try {
      const runner = new CgcRunner({ executable: BUN })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("hello matrix")'],
        env: {},
        maxOutputBytes: BUDGET,
      })

      expect(result.ok).toBe(true)
      expect(result.stdout).toBe('hello matrix')
      expect(result.truncated).toBe(false)
      expect(result.stdout).not.toContain('truncated')
    } finally {
      removeAll(workspace)
    }
  })

  it('oversized output keeps head and tail with a marker naming the original size', async () => {
    const workspace = makeTemp('cgc-matrix-ws-')
    try {
      const runner = new CgcRunner({ executable: BUN })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("x".repeat(200000))'],
        env: {},
        maxOutputBytes: BUDGET,
      })

      expect(result.ok).toBe(true)
      expect(result.truncated).toBe(true)
      expect(result.stdout.length).toBeLessThanOrEqual(BUDGET)
      expect(result.stdout.startsWith('x')).toBe(true)
      expect(result.stdout.endsWith('x')).toBe(true)
      expect(result.stdout).toContain('truncated')
      expect(result.stdout).toContain('original 200000 chars')
    } finally {
      removeAll(workspace)
    }
  })
})

describe('pipeline matrix: spill on/off (task 2.2)', () => {
  it('spills the full output outside the workspace and names the path when on', async () => {
    const workspace = makeTemp('cgc-matrix-ws-')
    const spillBase = makeTemp('cgc-matrix-spill-')
    try {
      const runner = new CgcRunner({
        executable: BUN,
        spillToTemp: true,
        spillBaseDir: spillBase,
      })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("y".repeat(150000))'],
        env: {},
        maxOutputBytes: BUDGET,
      })

      const spillPath = result.stdout.match(/spilled to ([^\]]+)\]/)?.[1]
      expect(spillPath).toBeDefined()
      expect((spillPath as string).startsWith(workspace)).toBe(false)
      expect((spillPath as string).startsWith(spillBase)).toBe(true)
      expect(readFileSync(spillPath as string).length).toBe(150000)

      runner.cleanupSpills()
      expect(spillDirs(spillBase).length).toBe(0)
    } finally {
      removeAll(workspace, spillBase)
    }
  })

  it('writes nothing and names no path when spill is off', async () => {
    const workspace = makeTemp('cgc-matrix-ws-')
    const spillBase = makeTemp('cgc-matrix-spill-')
    try {
      const runner = new CgcRunner({
        executable: BUN,
        spillToTemp: false,
        spillBaseDir: spillBase,
      })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("y".repeat(150000))'],
        env: {},
        maxOutputBytes: BUDGET,
      })

      expect(result.stdout).toContain('truncated')
      expect(result.stdout).not.toContain('spilled to')
      expect(spillDirs(spillBase).length).toBe(0)
    } finally {
      removeAll(workspace, spillBase)
    }
  })
})

describe('pipeline matrix: redaction on/off (task 2.2)', () => {
  it('redacts credential assignments and high-entropy literals by default', async () => {
    const workspace = makeTemp('cgc-matrix-ws-')
    try {
      const runner = new CgcRunner({ executable: BUN })
      const script = `process.stdout.write("api_key=abcdef1234567890 digest ${HIGH_ENTROPY}")`
      const result = await runner.run(workspace, {
        args: ['-e', script],
        env: {},
        maxOutputBytes: BUDGET,
      })

      expect(result.stdout).not.toContain('abcdef1234567890')
      expect(result.stdout).not.toContain(HIGH_ENTROPY)
      expect(result.stdout).toContain('[REDACTED]')
    } finally {
      removeAll(workspace)
    }
  })

  it('leaves values verbatim on opt-out while stripping still applies', async () => {
    const workspace = makeTemp('cgc-matrix-ws-')
    try {
      const runner = new CgcRunner({ executable: BUN, redactSecrets: false })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("\\u001b[31mapi_key=abcdef1234567890\\u001b[0m")'],
        env: {},
        maxOutputBytes: BUDGET,
      })

      expect(result.stdout).toBe('api_key=abcdef1234567890')
      expect(result.stdout).not.toContain('\u001b')
    } finally {
      removeAll(workspace)
    }
  })

  it('opt-out still bounds an oversized secret-bearing stream', async () => {
    const workspace = makeTemp('cgc-matrix-ws-')
    try {
      const runner = new CgcRunner({ executable: BUN, redactSecrets: false })
      const script = 'process.stdout.write(("secret=abcdef1234567890\\n").repeat(20000))'
      const result = await runner.run(workspace, {
        args: ['-e', script],
        env: {},
        maxOutputBytes: BUDGET,
      })

      expect(result.stdout).toContain('abcdef1234567890')
      expect(result.stdout).toContain('truncated')
      expect(result.stdout.length).toBeLessThanOrEqual(BUDGET)
    } finally {
      removeAll(workspace)
    }
  })
})

describe('pipeline matrix: ANSI-rich input (task 2.2)', () => {
  it('strips ESC/CSI sequences and standalone C1 controls, preserving layout', async () => {
    const workspace = makeTemp('cgc-matrix-ws-')
    try {
      const runner = new CgcRunner({ executable: BUN })
      const script =
        'process.stdout.write("\\u001b[32mok\\u001b[0m\\u001b[2Jline1\\n\\tline2\\u009bX")'
      const result = await runner.run(workspace, {
        args: ['-e', script],
        env: {},
        maxOutputBytes: BUDGET,
      })

      expect(result.stdout).toBe('okline1\n\tline2X')
      expect(result.stdout).not.toContain('\u001b')
      expect(result.stdout).not.toContain('\u009b')
    } finally {
      removeAll(workspace)
    }
  })

  it('combines ANSI, secrets, oversized output, and spill in one stream', async () => {
    const workspace = makeTemp('cgc-matrix-ws-')
    const spillBase = makeTemp('cgc-matrix-spill-')
    try {
      const runner = new CgcRunner({
        executable: BUN,
        spillToTemp: true,
        spillBaseDir: spillBase,
      })
      const script =
        'process.stdout.write(("\\u001b[36m" + "api_key=abcdef1234567890" + "\\u001b[0m\\n").repeat(20000))'
      const result = await runner.run(workspace, {
        args: ['-e', script],
        env: {},
        maxOutputBytes: BUDGET,
      })

      expect(result.stdout).not.toContain('\u001b')
      expect(result.stdout).not.toContain('abcdef1234567890')
      expect(result.stdout).toContain('[REDACTED]')
      expect(result.stdout).toContain('truncated')
      expect(result.stdout).toContain('spilled to')
      expect(result.stdout.length).toBeLessThanOrEqual(BUDGET)
      runner.cleanupSpills()
      expect(spillFiles(spillBase).length).toBe(0)
    } finally {
      removeAll(workspace, spillBase)
    }
  })
})

describe('pipeline matrix: GCF on/off (task 2.2)', () => {
  it('sets CGC_OUTPUT_FORMAT=gcf only when enabled', async () => {
    const workspace = makeTemp('cgc-matrix-ws-')
    try {
      const echoFormat = 'process.stdout.write(process.env.CGC_OUTPUT_FORMAT ?? "")'

      const on = new CgcRunner({ executable: BUN, gcfOutput: true })
      const onResult = await on.run(workspace, {
        args: ['-e', echoFormat],
        env: {},
      })
      expect(onResult.stdout).toBe('gcf')

      const off = new CgcRunner({ executable: BUN, gcfOutput: false })
      const offResult = await off.run(workspace, {
        args: ['-e', echoFormat],
        env: {},
      })
      expect(offResult.stdout).toBe('')
    } finally {
      removeAll(workspace)
    }
  })
})

describe('pipeline matrix: pipeline-stage failure injection (task 2.2)', () => {
  it('contains a throwing pipeline stage and delivers best-effort retained output', async () => {
    const workspace = makeTemp('cgc-matrix-ws-')
    const spillBase = makeTemp('cgc-matrix-spill-')
    try {
      const runner = new CgcRunner({
        executable: BUN,
        spillToTemp: true,
        spillBaseDir: spillBase,
        outputPolicy: () => {
          throw new Error('injected pipeline stage failure')
        },
      })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("z".repeat(200000))'],
        env: {},
        maxOutputBytes: BUDGET,
      })

      // The invocation is unaffected (spec scenario "Policy error is contained").
      expect(result.ok).toBe(true)
      expect(result.code).toBe('OK')
      // Best-effort: the retained head+tail text, with no policy marker and no
      // spill path (the policy never ran to completion).
      expect(result.stdout).toContain('z')
      expect(result.stdout).not.toContain('truncated')
      expect(result.stdout).not.toContain('spilled to')
      // The stage error is RECORDED on the result without failing the
      // invocation (task 1.7 fail-open semantics).
      expect(
        result.policyErrors?.some((entry) => entry.includes('injected pipeline stage failure')),
      ).toBe(true)
      // The spill started for the truncated stream is discarded on the error.
      expect(spillFiles(spillBase).length).toBe(0)
    } finally {
      removeAll(workspace, spillBase)
    }
  })

  it('also contains a throwing stage on stderr for a failing command', async () => {
    const workspace = makeTemp('cgc-matrix-ws-')
    try {
      const runner = new CgcRunner({
        executable: BUN,
        outputPolicy: () => {
          throw new Error('injected pipeline stage failure')
        },
      })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stderr.write("boom"); process.exit(2)'],
        env: {},
      })

      expect(result.code).toBe('COMMAND_FAILED')
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('boom')
    } finally {
      removeAll(workspace)
    }
  })

  it('records a spill write failure and delivers the marker without a path (task 1.7)', async () => {
    const workspace = makeTemp('cgc-matrix-ws-')
    // A regular FILE used as the spill base makes every spill directory
    // creation fail (ENOTDIR): the spec's "read-only temp directory" analogue.
    const blockedBase = join(tmpdir(), `cgc-spill-blocked-${process.pid}-${Date.now()}`)
    writeFileSync(blockedBase, 'not a directory')
    try {
      const runner = new CgcRunner({
        executable: BUN,
        spillToTemp: true,
        spillBaseDir: blockedBase,
      })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("q".repeat(200000))'],
        env: {},
        maxOutputBytes: BUDGET,
      })

      // The invocation is unaffected; the delivered output is still bounded
      // with the truncation marker, just without a spill path.
      expect(result.ok).toBe(true)
      expect(result.code).toBe('OK')
      expect(result.truncated).toBe(true)
      expect(result.stdout).toContain('truncated')
      expect(result.stdout).not.toContain('spilled to')
      expect(result.stdout.length).toBeLessThanOrEqual(BUDGET)
      // ...and the policy error is recorded.
      expect(result.policyErrors?.some((entry) => entry.includes('spill write failed'))).toBe(true)
    } finally {
      removeAll(workspace, blockedBase)
    }
  })
})
