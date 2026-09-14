import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import entry from './index'

/**
 * A FRESH module instance of the extension entry. The entry gates CLI-gap
 * tool registration on `getConfig()`, whose cache is per module instance, so
 * the spec 2.4 availability tests drive a distinct instance per environment.
 * The query string is a runtime-only specifier (Bun treats each unique URL as
 * its own module); tsc can only handle it as a computed import, hence the
 * helper. The instance is exercised exactly once per import.
 */
async function freshEntry(variant: string): Promise<{ default: (api: never) => void }> {
  return (await import(`./index?${variant}`)) as { default: (api: never) => void }
}

const brokenApi = {
  on() {
    throw new Error('api exploded')
  },
}

describe('extension entry', () => {
  it('exports a default Pi extension factory', () => {
    expect(typeof entry).toBe('function')
  })

  it('task 3.2: loading with a throwing extension API never throws (fail-open)', () => {
    expect(() => entry(brokenApi as never)).not.toThrow()
  })

  it('task 1.1 (slash commands): loading registers the bare /cgc command', () => {
    const registered: string[] = []
    const api = {
      on() {
        return undefined
      },
      registerCommand(name: string) {
        registered.push(name)
      },
    }

    entry(api as never)

    expect(registered).toContain('cgc')
    // The slash-command surface is a single bare registration: no duplicate
    // name that would make pi assign a `:1` invocation suffix.
    expect(registered.filter((name) => name === 'cgc')).toHaveLength(1)
  })

  it('task 1.1 (slash commands): a throwing registerCommand never breaks load (fail-open)', () => {
    const api = {
      on() {
        return undefined
      },
      registerCommand() {
        throw new Error('api exploded')
      },
    }

    expect(() => entry(api as never)).not.toThrow()
  })

  it('task 1.1 (cli-gap tools): loading registers the three CLI-gap tools (default on)', () => {
    const registered: string[] = []
    const api = {
      on() {
        return undefined
      },
      registerTool(tool: { name: string }) {
        registered.push(tool.name)
      },
    }

    entry(api as never)

    expect(registered).toContain('cgc_bundle_export')
    expect(registered).toContain('cgc_context')
    expect(registered).toContain('cgc_doctor')
  })

  it('task 1.1 (cli-gap tools): a throwing registerTool never breaks load (fail-open)', () => {
    const api = {
      on() {
        return undefined
      },
      registerTool() {
        throw new Error('api exploded')
      },
    }

    expect(() => entry(api as never)).not.toThrow()
  })

  it('spec 2.4 (tool availability): an opted-out installation registers none of the CLI-gap tools', async () => {
    // S2 of specs/cgc-cli-bridge/spec.md: GIVEN `tools.cliGap.enabled` is
    // disabled, WHEN a session starts, THEN none of the three tools is
    // registered and no tool-catalog entry for them exists. The entry gate
    // (index.ts: `if (getConfig().config.tools.cliGap.enabled)`) sits behind
    // the per-module-instance config cache, so this test drives a FRESH
    // import of the entry with cwd pointed at a temporary project whose
    // `.pi/cgc.json` opts the tool set out (config.test.ts covers the flag
    // resolution; this proves the session-start registration gate consumes
    // it). cwd is used because Bun's os.homedir() does not honour
    // process.env.HOME.
    const project = mkdtempSync(join(tmpdir(), 'cgc-cligap-spec-off-'))
    const savedCwd = process.cwd()
    try {
      mkdirSync(join(project, '.pi'), { recursive: true })
      writeFileSync(
        join(project, '.pi', 'cgc.json'),
        JSON.stringify({ tools: { cliGap: { enabled: false } } }),
      )
      process.chdir(project)

      const registered: string[] = []
      const optedOut = await freshEntry('spec-cli-gap-off=1')
      optedOut.default({
        on() {
          return undefined
        },
        registerTool(tool: { name: string }) {
          registered.push(tool.name)
        },
      } as never)

      expect(registered).not.toContain('cgc_bundle_export')
      expect(registered).not.toContain('cgc_context')
      expect(registered).not.toContain('cgc_doctor')
    } finally {
      process.chdir(savedCwd)
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('spec 2.4 (tool availability): the environment override wins over the config key', async () => {
    // S3 of specs/cgc-cli-bridge/spec.md: GIVEN the config key enables the
    // tool set but CGC_TOOLS_CLI_GAP_ENABLED explicitly disables it, WHEN a
    // session starts, THEN none of the three tools is registered — the
    // override takes precedence. A fresh entry instance per direction pins
    // the precedence BOTH ways at the session-start gate (config-file < env).
    const project = mkdtempSync(join(tmpdir(), 'cgc-cligap-spec-env-'))
    const savedCwd = process.cwd()
    const savedOverride = process.env.CGC_TOOLS_CLI_GAP_ENABLED
    try {
      mkdirSync(join(project, '.pi'), { recursive: true })
      process.chdir(project)

      // Project config says ON, env override says OFF -> nothing registered.
      writeFileSync(
        join(project, '.pi', 'cgc.json'),
        JSON.stringify({ tools: { cliGap: { enabled: true } } }),
      )
      process.env.CGC_TOOLS_CLI_GAP_ENABLED = 'false'
      const offRegistered: string[] = []
      const envOff = await freshEntry('spec-cli-gap-env-off=1')
      envOff.default({
        on() {
          return undefined
        },
        registerTool(tool: { name: string }) {
          offRegistered.push(tool.name)
        },
      } as never)
      expect(offRegistered).not.toContain('cgc_bundle_export')
      expect(offRegistered).not.toContain('cgc_context')
      expect(offRegistered).not.toContain('cgc_doctor')

      // Project config says OFF, env override says ON -> all three register
      // (the override also wins in the enabling direction; guards the gate
      // against silently registering nothing).
      writeFileSync(
        join(project, '.pi', 'cgc.json'),
        JSON.stringify({ tools: { cliGap: { enabled: false } } }),
      )
      process.env.CGC_TOOLS_CLI_GAP_ENABLED = 'true'
      const onRegistered: string[] = []
      const envOn = await freshEntry('spec-cli-gap-env-on=1')
      envOn.default({
        on() {
          return undefined
        },
        registerTool(tool: { name: string }) {
          onRegistered.push(tool.name)
        },
      } as never)
      expect(onRegistered).toContain('cgc_bundle_export')
      expect(onRegistered).toContain('cgc_context')
      expect(onRegistered).toContain('cgc_doctor')
    } finally {
      if (savedOverride === undefined) delete process.env.CGC_TOOLS_CLI_GAP_ENABLED
      else process.env.CGC_TOOLS_CLI_GAP_ENABLED = savedOverride
      process.chdir(savedCwd)
      rmSync(project, { recursive: true, force: true })
    }
  })
})
