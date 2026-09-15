// Spec-scenario verification (change add-cgc-output-token-economy, task 2.4).
//
// Walks EVERY scenario in specs/cgc-output-economy/spec.md against the real
// implementation, end to end through the shared runner (`CgcRunner.run` →
// `applyCapturePolicy` → `applyOutputPolicy`), rather than stage by stage.
// The matrix coverage test (task 2.2, `output-policy-matrix.test.ts`) proves
// the stage matrix; this file is the scenario ledger the spec asks for, so a
// reader can map "spec scenario → assertion" one to one.
//
// Task 2.4 verification ledger — all TWELVE spec scenarios are asserted below
// and pass (13 passing assertions; `bun test output-policy-scenarios.test.ts`):
//   bounded head+tail capture  small-unmarked | oversized-ends+marker-size
//   spill-to-file on truncation  spills-outside-workspace | spill-off | cleanup
//   secret redaction  assignment-redacted | opt-out
//   control-sequence hygiene  rich-terminal-plain
//   optional GCF passthrough  enabled | unavailable-fallback
//   universal application  probe+command-share-pipeline
//   fail-open pipeline  marker-without-path | recorded-policy-error
//
// One clause BEYOND the spec scenarios remains unimplemented and is recorded
// as `it.todo` below (a verification must not assert unimplemented behavior as
// correct): the JSON/GCF shape `"api_key": "value"`, where the KEY is itself
// quoted, is NOT redacted — the conservative pattern (design D4) requires the
// separator immediately after a bare key. The `key=value`, `key: value`, and
// quoted-VALUE (`token="abc"`) shapes ARE redacted. This is pattern tuning
// scoped to task 1.5, not one of the twelve spec scenarios asserted here.

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CgcRunner } from './runner'

const BUN = process.execPath
const BUDGET = 2048

function makeTemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Session spill directories left under a test base. */
function spillDirs(base: string): string[] {
  return readdirSync(base).filter((entry) => entry.startsWith('pi-cgc-spill'))
}

function spillFiles(base: string): string[] {
  return spillDirs(base).flatMap((dir) => readdirSync(join(base, dir)))
}

function removeAll(...paths: string[]): void {
  for (const path of paths) rmSync(path, { recursive: true, force: true })
}

describe('spec scenarios (2.4): bounded head+tail capture', () => {
  it('small output passes through unchanged (unmarked)', async () => {
    const workspace = makeTemp('cgc-scenario-ws-')
    try {
      const runner = new CgcRunner({ executable: BUN })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("small scenario output")'],
        env: {},
        maxOutputBytes: BUDGET,
      })

      expect(result.ok).toBe(true)
      expect(result.stdout).toBe('small scenario output')
      expect(result.truncated).toBe(false)
      expect(result.stdout).not.toContain('truncated')
    } finally {
      removeAll(workspace)
    }
  })

  it('oversized output is capped at both ends with a marker naming the original size', async () => {
    const workspace = makeTemp('cgc-scenario-ws-')
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
      expect(result.stdout).toContain('output truncated')
      expect(result.stdout).toContain('original 200000 chars')
    } finally {
      removeAll(workspace)
    }
  })
})

describe('spec scenarios (2.4): spill-to-file on truncation', () => {
  it('truncated output spills to a temp file outside the workspace, path named in the marker', async () => {
    const workspace = makeTemp('cgc-scenario-ws-')
    const spillBase = makeTemp('cgc-scenario-spill-')
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

  it('spill disabled: marker without a path and nothing written', async () => {
    const workspace = makeTemp('cgc-scenario-ws-')
    const spillBase = makeTemp('cgc-scenario-spill-')
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

      expect(result.stdout).toContain('output truncated')
      expect(result.stdout).not.toContain('spilled to')
      expect(spillDirs(spillBase).length).toBe(0)
    } finally {
      removeAll(workspace, spillBase)
    }
  })

  it('session shutdown cleanup removes the spill directory (teardown wiring covered by task 2.3)', async () => {
    const workspace = makeTemp('cgc-scenario-ws-')
    const spillBase = makeTemp('cgc-scenario-spill-')
    try {
      const runner = new CgcRunner({
        executable: BUN,
        spillToTemp: true,
        spillBaseDir: spillBase,
      })
      await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("y".repeat(150000))'],
        env: {},
        maxOutputBytes: BUDGET,
      })
      expect(spillFiles(spillBase).length).toBeGreaterThan(0)

      runner.cleanupSpills()
      expect(spillDirs(spillBase).length).toBe(0)
    } finally {
      removeAll(workspace, spillBase)
    }
  })
})

describe('spec scenarios (2.4): secret redaction in captured output', () => {
  it('credential-style assignments are redacted', async () => {
    const workspace = makeTemp('cgc-scenario-ws-')
    try {
      const runner = new CgcRunner({ executable: BUN })
      const script =
        'process.stdout.write("api_key=fakevalue123 not-a-delimiter password: hunter2")'
      const result = await runner.run(workspace, {
        args: ['-e', script],
        env: {},
        maxOutputBytes: BUDGET,
      })

      expect(result.stdout).not.toContain('fakevalue123')
      expect(result.stdout).not.toContain('hunter2')
      expect(result.stdout).toContain('[REDACTED]')
    } finally {
      removeAll(workspace)
    }
  })

  // KNOWN GAP (beyond the twelve spec scenarios; task 1.5 pattern tuning):
  // CGC's JSON/GCF output quotes keys (`"api_key": "value"`), and the current
  // conservative pattern requires the separator immediately after a bare key,
  // so the value survives unredacted. The `key=value`, `key: value`, and
  // quoted-VALUE (`token="abc"`) shapes asserted above ARE redacted; this
  // quoted-KEY form is additional hardening, not a spec scenario.
  it.todo('JSON/GCF quoted-key shape `"api_key": "value"` (hardening; task 1.5)', () => {})

  it('redaction opt-out leaves values verbatim while stripping still applies', async () => {
    const workspace = makeTemp('cgc-scenario-ws-')
    try {
      const runner = new CgcRunner({ executable: BUN, redactSecrets: false })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("\\u001b[31mpassword=hunter2\\u001b[0m")'],
        env: {},
        maxOutputBytes: BUDGET,
      })

      expect(result.stdout).toBe('password=hunter2')
      expect(result.stdout).not.toContain('\u001b')
    } finally {
      removeAll(workspace)
    }
  })
})

describe('spec scenarios (2.4): control-sequence hygiene', () => {
  it('rich terminal output is delivered as plain text', async () => {
    const workspace = makeTemp('cgc-scenario-ws-')
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
})

describe('spec scenarios (2.4): optional GCF passthrough', () => {
  it('GCF enabled carries CGC_OUTPUT_FORMAT=gcf on the invocation', async () => {
    const workspace = makeTemp('cgc-scenario-ws-')
    try {
      const runner = new CgcRunner({ executable: BUN, gcfOutput: true })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write(process.env.CGC_OUTPUT_FORMAT ?? "")'],
        env: {},
        maxOutputBytes: BUDGET,
      })

      expect(result.stdout).toBe('gcf')
    } finally {
      removeAll(workspace)
    }
  })

  it('GCF unavailable: invocation succeeds with CGC fallback output, no extension error', async () => {
    const workspace = makeTemp('cgc-scenario-ws-')
    try {
      // The child ignores CGC_OUTPUT_FORMAT (a stand-in for an installed CGC
      // without `gcf-python`) and returns plain fallback output; the runner
      // never probes for availability and must not fail the invocation.
      const runner = new CgcRunner({ executable: BUN, gcfOutput: true })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("fallback-json-output")'],
        env: {},
        maxOutputBytes: BUDGET,
      })

      expect(result.ok).toBe(true)
      expect(result.code).toBe('OK')
      expect(result.stdout).toBe('fallback-json-output')
    } finally {
      removeAll(workspace)
    }
  })
})

describe('spec scenarios (2.4): universal application of the policy', () => {
  it('probe and command outputs both pass the pipeline', async () => {
    const workspace = makeTemp('cgc-scenario-ws-')
    try {
      const runner = new CgcRunner({ executable: BUN })
      const script = 'process.stdout.write("\\u001b[36mapi_key=fakevalue123\\u001b[0m")'

      // A lifecycle-probe-shaped invocation and a command-shaped invocation
      // share the same runner and therefore the same policy.
      const probe = await runner.run(workspace, {
        args: ['-e', script],
        env: {},
        maxOutputBytes: BUDGET,
      })
      const command = await runner.run(workspace, {
        args: ['-e', script],
        env: {},
        maxOutputBytes: BUDGET,
      })

      for (const result of [probe, command]) {
        expect(result.stdout).not.toContain('\u001b')
        expect(result.stdout).not.toContain('fakevalue123')
        expect(result.stdout).toContain('[REDACTED]')
      }
    } finally {
      removeAll(workspace)
    }
  })
})

describe('spec scenarios (2.4): fail-open policy pipeline', () => {
  it('spill write failure delivers the marker without a path and leaves the session unaffected', async () => {
    const workspace = makeTemp('cgc-scenario-ws-')
    const spillBase = makeTemp('cgc-scenario-spill-')
    const blocker = join(spillBase, 'not-a-directory')
    try {
      // Point the spill base at a regular FILE so the session directory cannot
      // be created (ENOTDIR) regardless of platform/root — a deterministic
      // spill-write fault that stands in for a read-only temp directory.
      writeFileSync(blocker, '')

      const runner = new CgcRunner({
        executable: BUN,
        spillToTemp: true,
        spillBaseDir: blocker,
      })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("y".repeat(150000))'],
        env: {},
        maxOutputBytes: BUDGET,
      })

      // Invocation unaffected, best-effort bounded output with the truncation
      // marker and NO spill path (the write failed).
      expect(result.ok).toBe(true)
      expect(result.code).toBe('OK')
      expect(result.stdout).toContain('output truncated')
      expect(result.stdout).not.toContain('spilled to')

      // The session is unaffected: a later invocation still works.
      const after = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("still-alive")'],
        env: {},
        maxOutputBytes: BUDGET,
      })
      expect(after.stdout).toBe('still-alive')
    } finally {
      removeAll(workspace, spillBase)
    }
  })

  // Task 1.7: the spec additionally requires the policy error be RECORDED.
  // The runner records it on the invocation result (`policyErrors`) while the
  // delivered output and the session remain unaffected.
  it('records the policy error without failing the invocation (task 1.7)', async () => {
    const workspace = makeTemp('cgc-scenario-ws-')
    const spillBase = makeTemp('cgc-scenario-spill-')
    const blocker = join(spillBase, 'not-a-directory')
    try {
      // Same deterministic spill-write fault as above (ENOTDIR).
      writeFileSync(blocker, '')

      const runner = new CgcRunner({
        executable: BUN,
        spillToTemp: true,
        spillBaseDir: blocker,
      })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("y".repeat(150000))'],
        env: {},
        maxOutputBytes: BUDGET,
      })

      // Recorded, yet the invocation result is delivered and unaffected.
      expect(result.ok).toBe(true)
      expect(result.code).toBe('OK')
      expect(result.stdout).toContain('output truncated')
      expect(result.stdout).not.toContain('spilled to')
      expect(result.policyErrors?.some((entry) => entry.includes('spill write failed'))).toBe(true)
    } finally {
      removeAll(workspace, spillBase)
    }
  })
})
