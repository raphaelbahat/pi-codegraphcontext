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

// ---------------------------------------------------------------------------
// Session rebind (add-cgc-session-rebind): pi re-runs the factory on every
// session replacement (/resume, /new, /fork, /reload) with a fresh API. The
// contract under test: a resumed session is a fully-live session — every
// hook-owning surface re-wires onto the new API, the gate evaluates there,
// the teardown paths survive, and the cross-session state persists.
// ---------------------------------------------------------------------------

interface RecordedHook {
  event: string
  handler: (event: unknown, ctx: unknown) => unknown
}

function recordingApi(): {
  hooks: Map<string, RecordedHook[]>
  commands: string[]
  tools: string[]
  api: never
} {
  const hooks = new Map<string, RecordedHook[]>()
  const commands: string[] = []
  const tools: string[] = []
  const api = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): unknown {
      const list = hooks.get(event) ?? []
      list.push({ event, handler })
      hooks.set(event, list)
      return undefined
    },
    registerCommand(name: string): unknown {
      commands.push(name)
      return undefined
    },
    registerTool(tool: { name: string }): unknown {
      tools.push(tool.name)
      return undefined
    },
  }
  return { hooks, commands, tools, api: api as never }
}

/** Poll `probe` until it returns a non-null value or the budget expires. */
async function waitFor<T>(probe: () => T | null | undefined, budgetMs = 4000): Promise<T> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const value = probe()
    if (value !== null && value !== undefined) return value
    if (Date.now() > deadline) throw new Error('waitFor: budget expired')
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe('extension entry session rebind (add-cgc-session-rebind)', () => {
  it(
    'task 4.1 (the reproducing test): after a session replacement every surface registers on the ' +
      'new API and a gate evaluation driven through it records state and flows notices',
    async () => {
      // A fresh module instance isolates the cached singletons. The
      // nonexistent executable makes the gate's background evaluation fail
      // fast to the deterministic `unavailable` state (spawn ENOENT).
      const savedExecutable = process.env.CGC_EXECUTABLE
      process.env.CGC_EXECUTABLE = '/nonexistent/cgc-session-rebind'
      const savedCwd = process.cwd()
      const workspace = mkdtempSync(join(tmpdir(), 'cgc-rebind-'))
      try {
        process.chdir(workspace)
        const mod = (await freshEntry('rebind-resume=1')) as {
          default: (api: never) => void
          getGate: () =>
            | {
                snapshot: (cwd: string) => { state: string } | null
                lifecycleStore: () => unknown
              }
            | undefined
          getRunner: () => unknown
          getLifecycleStateStore: () => unknown
          getCleanupEvents: () => readonly { path: string; signal?: string }[]
        }

        const a = recordingApi()
        mod.default(a.api)

        // The first session starts (the gate evaluates in the background).
        const notifyA: string[] = []
        a.hooks
          .get('session_start')?.[0]
          ?.handler(
            { type: 'session_start' },
            { cwd: workspace, ui: { notify: (text: string) => notifyA.push(text) } },
          )
        await waitFor(() => mod.getGate()?.snapshot(workspace))

        // Pi's replacement sequence: session_shutdown on the outgoing API,
        // factory re-run with the fresh API, then session_start on it.
        for (const hook of a.hooks.get('session_shutdown') ?? []) hook.handler({}, {})
        const runnerBefore = mod.getRunner()
        const storeBefore = mod.getLifecycleStateStore()
        const exitListenersDuringA = process.listenerCount('exit')
        const handlersOnABefore = [...a.hooks.values()].reduce((sum, list) => sum + list.length, 0)

        const b = recordingApi()
        mod.default(b.api)

        // Every hook-owning surface registered on B: the gate (session_*),
        // the freshness observer (tool_call), the injectors and HUD
        // (before_agent_start / session_*), the skill exposure
        // (resources_discover), and the cleanup sweep (session_shutdown).
        for (const event of [
          'session_start',
          'session_shutdown',
          'tool_call',
          'before_agent_start',
          'resources_discover',
        ]) {
          expect((b.hooks.get(event) ?? []).length).toBeGreaterThan(0)
        }
        // The command and CLI-gap tool surfaces re-register exactly once.
        expect(b.commands.filter((name) => name === 'cgc')).toHaveLength(1)
        for (const tool of ['cgc_bundle_export', 'cgc_context', 'cgc_doctor']) {
          expect(b.tools.filter((name) => name === tool)).toHaveLength(1)
        }
        // The old API gained no new handlers (it is dead after replacement).
        const handlersOnAAfter = [...a.hooks.values()].reduce((sum, list) => sum + list.length, 0)
        expect(handlersOnAAfter).toBe(handlersOnABefore)

        // Cross-session state persists: same runner (child tracking), same
        // process-lifetime store; exactly one active cleanup installation.
        expect(mod.getRunner()).toBe(runnerBefore)
        expect(mod.getLifecycleStateStore()).toBe(storeBefore)
        expect(process.listenerCount('exit')).toBe(exitListenersDuringA)

        // A gate evaluation driven through B's session_start works: the
        // snapshot is recorded for the resumed session and the availability
        // notice flows to the NEW session's notify surface.
        const notifyB: string[] = []
        b.hooks
          .get('session_start')?.[0]
          ?.handler(
            { type: 'session_start' },
            { cwd: workspace, ui: { notify: (text: string) => notifyB.push(text) } },
          )
        const snapshot = await waitFor(() => mod.getGate()?.snapshot(workspace))
        expect(snapshot.state).toBe('unavailable')
        await waitFor(() => (notifyB.length > 0 ? true : null))
        expect(notifyB[0]).toContain('unavailable')

        // The teardown sweep on the new session records through the active
        // (reinstalled) cleanup handle.
        for (const hook of b.hooks.get('session_shutdown') ?? []) hook.handler({}, {})
        await waitFor(() => {
          const event = mod.getCleanupEvents().find((e) => e.path === 'session-shutdown')
          return event ?? null
        })
      } finally {
        if (savedExecutable === undefined) delete process.env.CGC_EXECUTABLE
        else process.env.CGC_EXECUTABLE = savedExecutable
        process.chdir(savedCwd)
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it('task 4.2 (same-api idempotence): invoking the factory twice with the same API wires each hook and the /cgc command exactly once', async () => {
    const mod = (await freshEntry('rebind-same-api=1')) as { default: (api: never) => void }
    const api = recordingApi()

    mod.default(api.api)
    const aCounts = new Map<string, number>()
    for (const [event, list] of api.hooks) aCounts.set(event, list.length)
    const hooksAfterFirst = [...api.hooks.values()].reduce((sum, list) => sum + list.length, 0)
    const exitAfterFirst = process.listenerCount('exit')

    mod.default(api.api)

    // No duplicates anywhere: every event carries exactly the same handler
    // count it had after the first run (each surface wires once per API), one
    // /cgc command, one set of CLI-gap tools, and no additional process
    // cleanup installation.
    for (const [event, list] of api.hooks) {
      expect(list).toHaveLength((aCounts.get(event) as number | undefined) ?? 0)
    }
    const hooksAfterSecond = [...api.hooks.values()].reduce((sum, list) => sum + list.length, 0)
    expect(hooksAfterSecond).toBe(hooksAfterFirst)
    expect(api.commands.filter((name) => name === 'cgc')).toHaveLength(1)
    for (const tool of ['cgc_bundle_export', 'cgc_context', 'cgc_doctor']) {
      expect(api.tools.filter((name) => name === tool)).toHaveLength(1)
    }
    expect(process.listenerCount('exit')).toBe(exitAfterFirst)
  })
})
