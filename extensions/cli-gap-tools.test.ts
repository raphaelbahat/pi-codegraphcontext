import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUNDLE_EXPORT_CONFIRM_TITLE,
  BUNDLE_EXPORT_OUTPUT_ARG,
  BUNDLE_EXPORT_PARAMETERS,
  BUNDLE_EXPORT_REPOSITORY_ARG,
  BUNDLE_EXPORT_TOOL,
  BUNDLE_EXPORT_VERB_ARGS,
  CGC_ALLOWED_ROOTS_ENV,
  CLI_GAP_ERROR_CODES,
  CLI_GAP_ERROR_STDERR_TAIL_BUDGET,
  CLI_GAP_TOOL_NAMES,
  type CliGapToolContext,
  type CliGapToolDefinition,
  type CliGapToolExecutor,
  type CliGapToolsApi,
  CONTEXT_CREATE_VERB_ARGS,
  CONTEXT_DATABASE_ARG,
  CONTEXT_DB_PATH_ARG,
  CONTEXT_DEFAULT_VERB_ARGS,
  CONTEXT_DELETE_CONFIRM_ANSWER,
  CONTEXT_DELETE_CONFIRM_TITLE,
  CONTEXT_DELETE_VERB_ARGS,
  CONTEXT_LIST_VERB_ARGS,
  CONTEXT_NAME_ARG,
  CONTEXT_PARAMETERS,
  CONTEXT_TOOL,
  CONTEXT_VERB_ARG,
  CONTEXT_VERBS,
  cliGapErrorText,
  contextDeleteConsentMessage,
  createBundleExportExecutor,
  createContextExecutor,
  createDoctorExecutor,
  DOCTOR_PARAMETERS,
  DOCTOR_TOOL,
  registerCliGapTools,
  remediateCliGapFailure,
} from './cli-gap-tools'
import { DOCTOR_ARGS } from './commands'
import { OUTPUT_POLICY_MAX_BYTES } from './output-policy'
import { type CgcCommandResult, CgcRunner, type CgcRunOptions } from './runner'

/** Collects the tool definitions handed to registerTool for assertions. */
function capturingApi(): { api: CliGapToolsApi; tools: CliGapToolDefinition[] } {
  const tools: CliGapToolDefinition[] = []
  return {
    api: { registerTool: (tool) => tools.push(tool) },
    tools,
  }
}

describe('registerCliGapTools', () => {
  it('task 1.1: registers exactly the three CLI-gap tools, in contract order', () => {
    const { api, tools } = capturingApi()

    registerCliGapTools(api)

    expect(tools.map((tool) => tool.name)).toEqual([BUNDLE_EXPORT_TOOL, CONTEXT_TOOL, DOCTOR_TOOL])
    expect(CLI_GAP_TOOL_NAMES).toEqual([BUNDLE_EXPORT_TOOL, CONTEXT_TOOL, DOCTOR_TOOL])
  })

  it('task 1.1: every registered tool carries a full contract (label, description, schema, executor)', () => {
    const { api, tools } = capturingApi()

    registerCliGapTools(api)

    for (const tool of tools) {
      expect(typeof tool.label).toBe('string')
      expect(tool.label.length).toBeGreaterThan(0)
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.parameters).toBeDefined()
      expect(typeof tool.execute).toBe('function')
    }
  })

  it('task 1.1 seam: per-tool executors from the dependency surface replace the placeholders', async () => {
    const called: string[] = []
    const bundleExport: CliGapToolExecutor = async () => {
      called.push(BUNDLE_EXPORT_TOOL)
      return {
        content: [{ type: 'text' as const, text: 'exported' }],
        details: {},
      }
    }
    const context: CliGapToolExecutor = async () => {
      called.push(CONTEXT_TOOL)
      return {
        content: [{ type: 'text' as const, text: 'contexts' }],
        details: {},
      }
    }
    const doctor: CliGapToolExecutor = async () => {
      called.push(DOCTOR_TOOL)
      return {
        content: [{ type: 'text' as const, text: 'ok' }],
        details: {},
      }
    }
    const { api, tools } = capturingApi()

    registerCliGapTools(api, { bundleExport, context, doctor })

    for (const [index, tool] of tools.entries()) {
      // pi 0.85.1 order: (toolCallId, params, signal, onUpdate, ctx).
      await tool.execute(`t${index + 1}`, {}, undefined, undefined, { cwd: '/repo' })
    }
    expect(called).toEqual([BUNDLE_EXPORT_TOOL, CONTEXT_TOOL, DOCTOR_TOOL])
  })

  it('task 1.1: the placeholder executor fails closed without touching any binary', async () => {
    const { api, tools } = capturingApi()

    registerCliGapTools(api)

    for (const tool of tools) {
      const result = await tool.execute(`call-${tool.name}`, {}, undefined, undefined, {
        cwd: '/repo',
      })
      const [block] = result.content
      expect(block?.type).toBe('text')
      expect(block?.text).toContain(tool.name)
      expect(block?.text).toContain('not implement')
      expect(result.details).toEqual({ tool: tool.name, implemented: false })
    }
  })

  it('task 1.1: a throwing registerTool never breaks registration of the rest (fail-open)', () => {
    const called: string[] = []
    const api: CliGapToolsApi = {
      registerTool(tool) {
        if (tool.name === CONTEXT_TOOL) throw new Error('api exploded')
        called.push(tool.name)
      },
    }

    registerCliGapTools(api)

    expect(called).toContain(BUNDLE_EXPORT_TOOL)
    expect(called).toContain(DOCTOR_TOOL)
    expect(called).not.toContain(CONTEXT_TOOL)
  })
})

// ---------------------------------------------------------------------------
// cgc_bundle_export executor (task 1.2)
// ---------------------------------------------------------------------------

/** A runner doubling as a call recorder; default result is a clean OK. */
function spiedRunner(result: Partial<CgcCommandResult> = {}): {
  runner: CgcRunner
  calls: { cwd: string; args: string[] }[]
} {
  const calls: { cwd: string; args: string[] }[] = []
  const runner: CgcRunner = {
    run: async (cwd: string, options: CgcRunOptions) => {
      calls.push({ cwd, args: [...options.args] })
      return {
        ok: true,
        code: 'OK',
        message: 'ok',
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 5,
        argv: [...options.args],
        cwd,
        ...result,
      }
    },
  } as unknown as CgcRunner
  return { runner, calls }
}

function toolContext(overrides: Partial<CliGapToolContext> = {}): CliGapToolContext {
  return { cwd: '/workspace/repo', ...overrides }
}

/** A context whose confirm dialog always grants consent (for proceed-path tests). */
function confirmingContext(overrides: Partial<CliGapToolContext> = {}): CliGapToolContext {
  return toolContext({ ui: { confirm: async () => true }, ...overrides })
}

function bundleParams(
  repository = '/workspace/repo',
  // In-root by default (cwd is /workspace/repo): the task 2.3 sandbox rejects
  // out-of-root destinations before anything runs.
  output = '/workspace/repo/repo.cgc',
): Record<string, unknown> {
  return { [BUNDLE_EXPORT_REPOSITORY_ARG]: repository, [BUNDLE_EXPORT_OUTPUT_ARG]: output }
}

describe('cgc_bundle_export executor (task 1.2)', () => {
  it('task 1.2: the bundle-export tool carries the fixed two-argument schema', () => {
    const schema = BUNDLE_EXPORT_PARAMETERS as {
      properties?: Record<string, { type?: string; minLength?: number }>
      required?: string[]
    }
    expect(schema.properties?.[BUNDLE_EXPORT_REPOSITORY_ARG]?.type).toBe('string')
    expect(schema.properties?.[BUNDLE_EXPORT_OUTPUT_ARG]?.type).toBe('string')
    expect(schema.required).toEqual([BUNDLE_EXPORT_REPOSITORY_ARG, BUNDLE_EXPORT_OUTPUT_ARG])
  })

  it('task 1.2: a confirmed export runs the documented verb and names the bundle with size info', async () => {
    // Real workspace root so the sandbox passes AND the produced file can be
    // statted for the size note.
    const dir = mkdtempSync(join(tmpdir(), 'cgc-export-'))
    const repository = join(dir, 'repo')
    const output = join(dir, 'repo.cgc')
    writeFileSync(output, 'AB'.repeat(1024)) // 2048 bytes
    try {
      const { runner, calls } = spiedRunner()
      const executor = createBundleExportExecutor({ runner })

      const result = await executor(
        't1',
        bundleParams(repository, output),
        undefined,
        undefined,
        confirmingContext({ cwd: dir }),
      )

      expect(calls).toEqual([
        {
          cwd: dir,
          args: [...BUNDLE_EXPORT_VERB_ARGS, output, '--repo', repository],
        },
      ])
      const [block] = result.content
      expect(block?.text).toContain(`exported bundle of ${repository} to ${output}`)
      expect(block?.text).toContain('2.0 KiB')
      expect(block?.text).toContain('cgc bundle export')
      const details = result.details as Record<string, unknown>
      expect(details.ok).toBe(true)
      expect(details.code).toBe('OK')
      expect(details.sizeBytes).toBe(2048)
      expect(details.argv).toEqual([...BUNDLE_EXPORT_VERB_ARGS, output, '--repo', repository])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('task 1.2: a confirmed export still names the destination when the file cannot be statted', async () => {
    const { runner, calls } = spiedRunner()
    const executor = createBundleExportExecutor({ runner })

    const result = await executor('t2', bundleParams(), undefined, undefined, confirmingContext())

    expect(calls).toHaveLength(1)
    const [block] = result.content
    expect(block?.text).toContain('/workspace/repo/repo.cgc')
    expect(block?.text).not.toContain('KiB')
  })

  it('task 1.2: a declined consent runs NO cgc command and writes nothing', async () => {
    // Real workspace root so the sandbox passes and the decline path (not the
    // task 2.3 NOT_ALLOWED rejection) is exercised.
    const dir = mkdtempSync(join(tmpdir(), 'cgc-declined-'))
    const repository = join(dir, 'repo')
    const output = join(dir, 'repo.cgc')
    const seen: { title: string }[] = []
    try {
      const { runner, calls } = spiedRunner()
      const executor = createBundleExportExecutor({ runner })

      const result = await executor(
        't3',
        bundleParams(repository, output),
        undefined,
        undefined,
        toolContext({
          cwd: dir,
          ui: {
            confirm: async (title: string) => {
              seen.push({ title })
              return false
            },
          },
        }),
      )

      // The user was asked exactly once and refused: no run, no bundle file on disk.
      expect(seen.map((entry) => entry.title)).toEqual([BUNDLE_EXPORT_CONFIRM_TITLE])
      expect(calls).toHaveLength(0)
      expect(existsSync(output)).toBe(false)
      const [block] = result.content
      expect(block?.text).toContain('declined')
      expect(block?.text).toContain('no `cgc` command ran')
      expect(result.details).toEqual({
        tool: BUNDLE_EXPORT_TOOL,
        action: 'declined',
        repository,
        output,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('task 2.2: a truthy-but-not-true confirm answer still declines for export (=== true only)', async () => {
    const { runner, calls } = spiedRunner()
    const executor = createBundleExportExecutor({ runner })

    const result = await executor(
      't11',
      bundleParams(),
      undefined,
      undefined,
      toolContext({ ui: { confirm: async () => 'yes' } }),
    )

    expect(calls).toHaveLength(0)
    expect(result.content[0]?.text).toContain('declined')
    expect(result.details).toEqual({
      tool: BUNDLE_EXPORT_TOOL,
      action: 'declined',
      repository: '/workspace/repo',
      output: '/workspace/repo/repo.cgc',
    })
  })

  it('task 1.2: a missing confirm surface fails closed (declined, nothing ran)', async () => {
    const { runner, calls } = spiedRunner()
    const executor = createBundleExportExecutor({ runner })

    const result = await executor('t4', bundleParams(), undefined, undefined, toolContext({}))

    expect(calls).toHaveLength(0)
    expect(result.content[0]?.text).toContain('declined')
  })

  it('task 1.2: a throwing confirm dialog fails closed (declined, nothing ran)', async () => {
    const { runner, calls } = spiedRunner()
    const executor = createBundleExportExecutor({ runner })

    const result = await executor(
      't5',
      bundleParams(),
      undefined,
      undefined,
      toolContext({
        ui: {
          confirm: async () => {
            throw new Error('dialog exploded')
          },
        },
      }),
    )

    expect(calls).toHaveLength(0)
    expect(result.content[0]?.text).toContain('declined')
  })

  it('task 1.2: invalid arguments return a structured error and never spawn', async () => {
    const { runner, calls } = spiedRunner()
    const executor = createBundleExportExecutor({ runner })

    const missing = await executor(
      't6',
      { [BUNDLE_EXPORT_REPOSITORY_ARG]: '/workspace/repo' },
      undefined,
      undefined,
      toolContext(),
    )
    const blank = await executor('t7', bundleParams('', ''), undefined, undefined, toolContext())

    expect(calls).toHaveLength(0)
    for (const result of [missing, blank]) {
      expect(result.content[0]?.text).toContain(BUNDLE_EXPORT_TOOL)
      expect(result.content[0]?.text).toContain('invalid arguments')
      expect(result.details).toEqual({ tool: BUNDLE_EXPORT_TOOL, error: 'INVALID_ARGUMENTS' })
    }
  })

  it('task 1.2: a missing session cwd returns UNAVAILABLE and never spawns', async () => {
    const { runner } = spiedRunner()
    const executor = createBundleExportExecutor({ runner })

    const result = await executor(
      't8',
      bundleParams(),
      undefined,
      undefined,
      toolContext({ cwd: undefined }),
    )

    expect(result.content[0]?.text).toContain('UNAVAILABLE')
    expect(result.details).toEqual({ tool: BUNDLE_EXPORT_TOOL, code: 'UNAVAILABLE' })
  })

  it('task 1.2: a failed run returns a D4 UPPER_SNAKE error with remediation and bounded stderr', async () => {
    const { runner, calls } = spiedRunner({
      ok: false,
      code: 'UNAVAILABLE',
      message: 'cgc binary not found',
      exitCode: null,
    })
    const executor = createBundleExportExecutor({ runner })

    const result = await executor('t9', bundleParams(), undefined, undefined, confirmingContext())

    expect(calls).toHaveLength(1)
    const [block] = result.content
    expect(block?.text).toContain('UNAVAILABLE')
    expect(block?.text).toContain('on PATH')
    const details = result.details as Record<string, unknown>
    expect(details.ok).toBe(false)
    expect(details.code).toBe('UNAVAILABLE')
    expect(details.stderrTail).toBeDefined()
  })

  it('task 1.2: the confirmation dialog names the exact destination before consent', async () => {
    const seen: { title: string; message: string }[] = []
    const { runner } = spiedRunner()
    const executor = createBundleExportExecutor({ runner })

    await executor(
      't10',
      bundleParams(),
      undefined,
      undefined,
      toolContext({
        ui: {
          confirm: async (title: string, message: string) => {
            seen.push({ title, message })
            return true
          },
        },
      }),
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]?.title).toBe(BUNDLE_EXPORT_CONFIRM_TITLE)
    expect(seen[0]?.message).toContain('/workspace/repo/repo.cgc')
    expect(seen[0]?.message).toContain('/workspace/repo')
  })

  it("task 1.2 regression: the registered definition runs under pi's 5-arg execute order (onUpdate, then ctx)", async () => {
    // Verifier-repro harness: pi 0.85.1 invokes definitions as
    // execute(toolCallId, params, signal, onUpdate, ctx) — the 4th argument
    // is a progress callback, never the session context. Register the real
    // executor and drive the captured definition exactly like pi does; a
    // 4-arg executor would bind onUpdate as ctx and decline (no run).
    const { runner, calls } = spiedRunner()
    const { api, tools } = capturingApi()
    registerCliGapTools(api, { bundleExport: createBundleExportExecutor({ runner }) })
    const bundleTool = tools.find((tool) => tool.name === BUNDLE_EXPORT_TOOL)
    expect(bundleTool).toBeDefined()
    if (bundleTool === undefined) throw new Error('bundle tool not registered')

    const onUpdate = () => {}
    const result = await bundleTool.execute(
      'regression-1',
      bundleParams(),
      undefined,
      onUpdate,
      confirmingContext(),
    )

    const [block] = result.content
    expect(block?.text).toContain('exported bundle')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual([
      ...BUNDLE_EXPORT_VERB_ARGS,
      '/workspace/repo/repo.cgc',
      '--repo',
      '/workspace/repo',
    ])
  })
})

// ---------------------------------------------------------------------------
// cgc_context executor (task 1.3)
// ---------------------------------------------------------------------------

/** A runner recorder that also captures the stdin option (used by context delete). */
function recordingRunner(result: Partial<CgcCommandResult> = {}): {
  runner: CgcRunner
  calls: { cwd: string; args: string[]; stdin?: string }[]
} {
  const calls: { cwd: string; args: string[]; stdin?: string }[] = []
  const runner: CgcRunner = {
    run: async (cwd: string, options: CgcRunOptions) => {
      const call: { cwd: string; args: string[]; stdin?: string } = {
        cwd,
        args: [...options.args],
      }
      if (options.stdin !== undefined) call.stdin = options.stdin
      calls.push(call)
      return {
        ok: true,
        code: 'OK',
        message: 'ok',
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 5,
        argv: [...options.args],
        cwd,
        ...result,
      }
    },
  } as unknown as CgcRunner
  return { runner, calls }
}

function contextParams(
  verb: string,
  name?: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const params: Record<string, unknown> = { [CONTEXT_VERB_ARG]: verb }
  if (name !== undefined) params[CONTEXT_NAME_ARG] = name
  return { ...params, ...extra }
}

describe('cgc_context executor (task 1.3)', () => {
  it('task 1.3: the context tool carries the fixed verb-and-settings schema', () => {
    const schema = CONTEXT_PARAMETERS as {
      properties?: Record<string, { type?: string; enum?: string[]; minLength?: number }>
    }
    expect(schema.properties?.[CONTEXT_VERB_ARG]?.enum).toEqual([...CONTEXT_VERBS])
    expect(schema.properties?.[CONTEXT_NAME_ARG]?.type).toBe('string')
    expect(schema.properties?.[CONTEXT_DATABASE_ARG]?.type).toBe('string')
    expect(schema.properties?.[CONTEXT_DB_PATH_ARG]?.type).toBe('string')
    expect(CONTEXT_VERBS).toEqual(['list', 'create', 'delete', 'set-default'])
  })

  it('task 1.3: list runs the documented verb without consent and returns mode/repositories/default output', async () => {
    // The real cgc CLI prints its rich context table to STDERR (verified live
    // against cgc 0.6.x); stdout stays empty. The executor reads both.
    const stderr =
      'Current Mode: named\nDefault Context: wt-main\n' +
      'wt-main│falkordb│~/.codegraphcontext/contexts/wt-main/db│3'
    const { runner, calls } = recordingRunner({ stderr })
    const executor = createContextExecutor({ runner })

    const result = await executor('c1', contextParams('list'), undefined, undefined, toolContext())

    expect(calls).toEqual([{ cwd: '/workspace/repo', args: [...CONTEXT_LIST_VERB_ARGS] }])
    const [block] = result.content
    expect(block?.text).toContain('cgc context list')
    expect(block?.text).toContain('Current Mode: named')
    expect(block?.text).toContain('Default Context: wt-main')
    const details = result.details as Record<string, unknown>
    expect(details.ok).toBe(true)
    expect(details.verb).toBe('list')
    expect(details.argv).toEqual([...CONTEXT_LIST_VERB_ARGS])
  })

  it('task 1.3: create runs the documented verb with name + settings and runs WITHOUT consent', async () => {
    // In-root dbPath (task 2.3 sandbox): /workspace/repo is the session cwd.
    const dbPath = '/workspace/repo/db/project-b-db'
    const { runner, calls } = recordingRunner()
    const executor = createContextExecutor({ runner })

    const result = await executor(
      'c2',
      contextParams('create', 'project-b', {
        [CONTEXT_DATABASE_ARG]: 'falkordb',
        [CONTEXT_DB_PATH_ARG]: dbPath,
      }),
      undefined,
      undefined,
      toolContext(),
    )

    expect(calls).toEqual([
      {
        cwd: '/workspace/repo',
        args: [
          ...CONTEXT_CREATE_VERB_ARGS,
          'project-b',
          '--database',
          'falkordb',
          '--db-path',
          dbPath,
        ],
      },
    ])
    const [block] = result.content
    expect(block?.text).toContain("created CGC named context 'project-b'")
    expect(block?.text).toContain('falkordb')
    expect(block?.text).toContain(dbPath)
    expect(block?.text).toContain('cgc context create')
    const details = result.details as Record<string, unknown>
    expect(details.ok).toBe(true)
    expect(details.name).toBe('project-b')
    expect(details.database).toBe('falkordb')
    expect(details.dbPath).toBe(dbPath)
  })

  it('task 1.3: create without settings still confirms name + configured default', async () => {
    const { runner, calls } = recordingRunner()
    const executor = createContextExecutor({ runner })

    const result = await executor(
      'c3',
      contextParams('create', 'plain'),
      undefined,
      undefined,
      toolContext(),
    )

    expect(calls).toEqual([
      { cwd: '/workspace/repo', args: [...CONTEXT_CREATE_VERB_ARGS, 'plain'] },
    ])
    const [block] = result.content
    expect(block?.text).toContain("'plain'")
    expect(block?.text).toContain('configured default')
  })

  it('task 1.3: create on a duplicate (CLI exits 0 with a marker) surfaces COMMAND_FAILED, not success', async () => {
    const { runner, calls } = recordingRunner({
      stdout: "Context 'plain' already exists.",
    })
    const executor = createContextExecutor({ runner })

    const result = await executor(
      'c4',
      contextParams('create', 'plain'),
      undefined,
      undefined,
      toolContext(),
    )

    expect(calls).toHaveLength(1)
    const [block] = result.content
    expect(block?.text).toContain('COMMAND_FAILED')
    expect(block?.text).toContain('already exists')
    const details = result.details as Record<string, unknown>
    expect(details.ok).toBe(false)
    expect(details.code).toBe('COMMAND_FAILED')
    expect(details.reason).toBe('already exists')
  })

  it("task 1.3: a confirmed delete runs the documented verb and answers the CLI's own prompt via stdin", async () => {
    const { runner, calls } = recordingRunner()
    const executor = createContextExecutor({ runner })

    const result = await executor(
      'c5',
      contextParams('delete', 'legacy'),
      undefined,
      undefined,
      confirmingContext(),
    )

    expect(calls).toEqual([
      {
        cwd: '/workspace/repo',
        args: [...CONTEXT_DELETE_VERB_ARGS, 'legacy'],
        stdin: CONTEXT_DELETE_CONFIRM_ANSWER,
      },
    ])
    const [block] = result.content
    expect(block?.text).toContain("deleted CGC named context 'legacy'")
    expect(block?.text).toContain('database files were NOT deleted')
    const details = result.details as Record<string, unknown>
    expect(details.ok).toBe(true)
    expect(details.argv).toEqual([...CONTEXT_DELETE_VERB_ARGS, 'legacy'])
  })

  it('task 1.3: a declined delete runs NO cgc command and changes nothing', async () => {
    const seen: { title: string; message: string }[] = []
    const { runner, calls } = recordingRunner()
    const executor = createContextExecutor({ runner })

    const result = await executor(
      'c6',
      contextParams('delete', 'legacy'),
      undefined,
      undefined,
      toolContext({
        ui: {
          confirm: async (title: string, message: string) => {
            seen.push({ title, message })
            return false
          },
        },
      }),
    )

    // The user was asked exactly once with the ADR-0003 delete wording and refused.
    expect(seen).toEqual([
      { title: CONTEXT_DELETE_CONFIRM_TITLE, message: contextDeleteConsentMessage('legacy') },
    ])
    expect(calls).toHaveLength(0)
    const [block] = result.content
    expect(block?.text).toContain('declined')
    expect(block?.text).toContain('no `cgc` command ran')
    expect(result.details).toEqual({
      tool: CONTEXT_TOOL,
      action: 'declined',
      verb: 'delete',
      name: 'legacy',
    })
  })

  it('task 2.2: a truthy-but-not-true confirm answer still declines for delete (=== true only)', async () => {
    const { runner, calls } = recordingRunner()
    const executor = createContextExecutor({ runner })

    const result = await executor(
      'c18',
      contextParams('delete', 'legacy'),
      undefined,
      undefined,
      toolContext({ ui: { confirm: async () => 'y' } }),
    )

    expect(calls).toHaveLength(0)
    expect(result.content[0]?.text).toContain('declined')
    expect(result.details).toEqual({
      tool: CONTEXT_TOOL,
      action: 'declined',
      verb: 'delete',
      name: 'legacy',
    })
  })

  it('task 1.3: a missing or throwing confirm surface fails closed for delete', async () => {
    const { runner, calls } = recordingRunner()
    const executor = createContextExecutor({ runner })

    const missing = await executor(
      'c7',
      contextParams('delete', 'legacy'),
      undefined,
      undefined,
      toolContext({}),
    )
    const throwing = await executor(
      'c8',
      contextParams('delete', 'legacy'),
      undefined,
      undefined,
      toolContext({
        ui: {
          confirm: async () => {
            throw new Error('dialog exploded')
          },
        },
      }),
    )

    expect(calls).toHaveLength(0)
    for (const result of [missing, throwing]) {
      expect(result.content[0]?.text).toContain('declined')
    }
  })

  it('task 1.3: delete of an unregistered context (CLI exits 0 with a marker) surfaces NOT_FOUND', async () => {
    const { runner, calls } = recordingRunner({
      stdout: "Context 'legacy' not found.",
    })
    const executor = createContextExecutor({ runner })

    const result = await executor(
      'c9',
      contextParams('delete', 'legacy'),
      undefined,
      undefined,
      confirmingContext(),
    )

    expect(calls).toHaveLength(1)
    const [block] = result.content
    expect(block?.text).toContain('NOT_FOUND')
    expect(block?.text).toContain('not registered')
    const details = result.details as Record<string, unknown>
    expect(details.ok).toBe(false)
    expect(details.code).toBe('NOT_FOUND')
  })

  it('task 1.3: set-default runs the documented `cgc context default` verb WITHOUT consent', async () => {
    const { runner, calls } = recordingRunner()
    const executor = createContextExecutor({ runner })

    const result = await executor(
      'c10',
      contextParams('set-default', 'wt-main'),
      undefined,
      undefined,
      toolContext(),
    )

    expect(calls).toEqual([
      { cwd: '/workspace/repo', args: [...CONTEXT_DEFAULT_VERB_ARGS, 'wt-main'] },
    ])
    const [block] = result.content
    expect(block?.text).toContain('default CGC named context')
    expect(block?.text).toContain("'wt-main'")
    expect(block?.text).toContain('cgc context default')
  })

  it('task 1.3: invalid arguments return a structured error and never spawn', async () => {
    const { runner, calls } = recordingRunner()
    const executor = createContextExecutor({ runner })

    const badVerb = await executor(
      'c11',
      { [CONTEXT_VERB_ARG]: 'destroy' },
      undefined,
      undefined,
      toolContext(),
    )
    const missingName = await executor(
      'c12',
      contextParams('create'),
      undefined,
      undefined,
      toolContext(),
    )
    const blankName = await executor(
      'c13',
      contextParams('delete', ''),
      undefined,
      undefined,
      toolContext(),
    )
    const badDatabase = await executor(
      'c14',
      contextParams('create', 'x', { [CONTEXT_DATABASE_ARG]: '' }),
      undefined,
      undefined,
      toolContext(),
    )

    expect(calls).toHaveLength(0)
    for (const result of [badVerb, missingName, blankName, badDatabase]) {
      expect(result.content[0]?.text).toContain(CONTEXT_TOOL)
      expect(result.content[0]?.text).toContain('invalid arguments')
      expect((result.details as Record<string, unknown>).error).toBe('INVALID_ARGUMENTS')
    }
  })

  it('task 1.3: a missing session cwd returns UNAVAILABLE and never spawns', async () => {
    const { runner } = recordingRunner()
    const executor = createContextExecutor({ runner })

    const result = await executor(
      'c15',
      contextParams('list'),
      undefined,
      undefined,
      toolContext({ cwd: undefined }),
    )

    expect(result.content[0]?.text).toContain('UNAVAILABLE')
    expect(result.details).toEqual({ tool: CONTEXT_TOOL, code: 'UNAVAILABLE' })
  })

  it('task 1.3: a failed run returns a D4 UPPER_SNAKE error with remediation', async () => {
    const { runner, calls } = recordingRunner({
      ok: false,
      code: 'UNAVAILABLE',
      message: 'cgc binary not found',
      exitCode: null,
      stderr: 'sh: cgc: command not found',
    })
    const executor = createContextExecutor({ runner })

    const result = await executor('c16', contextParams('list'), undefined, undefined, toolContext())

    expect(calls).toHaveLength(1)
    const [block] = result.content
    expect(block?.text).toContain('UNAVAILABLE')
    expect(block?.text).toContain('on PATH')
    const details = result.details as Record<string, unknown>
    expect(details.ok).toBe(false)
    expect(details.code).toBe('UNAVAILABLE')
    expect(details.stderrTail).toContain('command not found')
  })

  it('task 1.3: the delete confirmation names the context, the verb, and that DB files stay', async () => {
    const seen: { title: string; message: string }[] = []
    const { runner } = recordingRunner()
    const executor = createContextExecutor({ runner })

    await executor(
      'c17',
      contextParams('delete', 'docs'),
      undefined,
      undefined,
      toolContext({
        ui: {
          confirm: async (title: string, message: string) => {
            seen.push({ title, message })
            return true
          },
        },
      }),
    )

    expect(seen).toEqual([
      { title: CONTEXT_DELETE_CONFIRM_TITLE, message: contextDeleteConsentMessage('docs') },
    ])
    expect(seen[0]?.message).toContain("'docs'")
    expect(seen[0]?.message).toContain('cgc context delete')
    expect(seen[0]?.message).toContain('database files remain on disk')
  })

  it("task 1.3 regression: the registered definition runs under pi's 5-arg execute order (onUpdate, then ctx)", async () => {
    const { runner, calls } = recordingRunner()
    const { api, tools } = capturingApi()
    registerCliGapTools(api, { context: createContextExecutor({ runner }) })
    const contextTool = tools.find((tool) => tool.name === CONTEXT_TOOL)
    expect(contextTool).toBeDefined()
    if (contextTool === undefined) throw new Error('context tool not registered')

    const onUpdate = () => {}
    const result = await contextTool.execute(
      'regression-2',
      contextParams('create', 'branch-a'),
      undefined,
      onUpdate,
      toolContext(),
    )

    const [block] = result.content
    expect(block?.text).toContain("created CGC named context 'branch-a'")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual([...CONTEXT_CREATE_VERB_ARGS, 'branch-a'])
  })
})

// ---------------------------------------------------------------------------
// cgc_doctor executor (task 1.4)
// ---------------------------------------------------------------------------

describe('cgc_doctor executor (task 1.4)', () => {
  it('task 1.4: the doctor tool carries the fixed empty schema (no arguments)', () => {
    const schema = DOCTOR_PARAMETERS as {
      properties?: Record<string, unknown>
      required?: string[]
    }
    expect(schema.properties).toBeDefined()
    expect(schema.properties).toEqual({})
    expect(schema.required).toBeUndefined()
  })

  it('task 1.4: a successful run returns the report from the documented verb, policy-cleaned', async () => {
    const stdout =
      '\u001b[1m\u001b[34mcgc doctor\u001b[0m — \u001b[32mhealthy\u001b[0m\nscan complete'
    const { runner, calls } = recordingRunner({ stdout })
    const executor = createDoctorExecutor({ runner })

    const result = await executor('d1', {}, undefined, undefined, toolContext())

    expect(calls).toEqual([{ cwd: '/workspace/repo', args: [...DOCTOR_ARGS] }])
    const [block] = result.content
    expect(block?.text).toContain('cgc doctor')
    expect(block?.text).toContain('healthy')
    expect(block?.text).toContain('scan complete')
    // The shared pipeline strips ANSI/control sequences before delivery.
    expect(block?.text).not.toContain('\u001b')
    const details = result.details as Record<string, unknown>
    expect(details.ok).toBe(true)
    expect(details.code).toBe('OK')
    expect(details.argv).toEqual([...DOCTOR_ARGS])
  })

  it('task 1.4: runs WITHOUT confirmation (non-destructive, design D2)', async () => {
    const { runner, calls } = recordingRunner()
    const executor = createDoctorExecutor({ runner })

    // No ui surface at all — a consent-gated tool would decline and not spawn.
    const result = await executor('d2', {}, undefined, undefined, toolContext({}))

    expect(calls).toHaveLength(1)
    expect(result.content[0]?.text).toContain('CGC diagnostics')
  })

  it('task 1.4: oversized reports are bounded with an explicit truncation marker', async () => {
    const pad = 'x'.repeat(OUTPUT_POLICY_MAX_BYTES * 2)
    const { runner } = recordingRunner({ stdout: pad })
    const executor = createDoctorExecutor({ runner })

    const result = await executor('d3', {}, undefined, undefined, toolContext())

    const [block] = result.content
    // The marker names the ORIGINAL total size (header + report) and the
    // delivered text never exceeds the policy budget.
    expect(block?.text).toContain('output truncated')
    expect(block?.text).toMatch(/original \d+ chars/)
    expect((block?.text ?? '').length).toBeLessThanOrEqual(OUTPUT_POLICY_MAX_BYTES)
  })

  it('task 1.4: a failed run returns a D4 UPPER_SNAKE error with remediation and bounded stderr', async () => {
    const { runner, calls } = recordingRunner({
      ok: false,
      code: 'UNAVAILABLE',
      message: 'cgc binary not found',
      exitCode: null,
      stderr: 'sh: cgc: command not found',
    })
    const executor = createDoctorExecutor({ runner })

    const result = await executor('d4', {}, undefined, undefined, toolContext())

    expect(calls).toHaveLength(1)
    const [block] = result.content
    expect(block?.text).toContain('UNAVAILABLE')
    expect(block?.text).toContain('on PATH')
    expect(block?.text).toContain('command not found')
    const details = result.details as Record<string, unknown>
    expect(details.ok).toBe(false)
    expect(details.code).toBe('UNAVAILABLE')
    expect(details.stderrTail).toContain('command not found')
  })

  it('task 1.4: a missing session cwd returns UNAVAILABLE and never spawns', async () => {
    const { runner, calls } = recordingRunner()
    const executor = createDoctorExecutor({ runner })

    const result = await executor('d5', {}, undefined, undefined, toolContext({ cwd: undefined }))

    expect(calls).toHaveLength(0)
    expect(result.content[0]?.text).toContain('UNAVAILABLE')
    expect(result.details).toEqual({ tool: DOCTOR_TOOL, code: 'UNAVAILABLE' })
  })

  it('task 1.4: a throwing runner surfaces COMMAND_FAILED defensively (nothing ran)', async () => {
    const runner = {
      run: async () => {
        throw new Error('contract violation')
      },
    } as unknown as CgcRunner
    const executor = createDoctorExecutor({ runner })

    const result = await executor('d6', {}, undefined, undefined, toolContext())

    const [block] = result.content
    expect(block?.text).toContain('COMMAND_FAILED')
    expect((result.details as Record<string, unknown>).code).toBe('COMMAND_FAILED')
  })

  it("task 1.4 regression: the registered definition runs under pi's 5-arg execute order (onUpdate, then ctx)", async () => {
    const { runner, calls } = recordingRunner({ stdout: 'healthy' })
    const { api, tools } = capturingApi()
    registerCliGapTools(api, { doctor: createDoctorExecutor({ runner }) })
    const doctorTool = tools.find((tool) => tool.name === DOCTOR_TOOL)
    expect(doctorTool).toBeDefined()
    if (doctorTool === undefined) throw new Error('doctor tool not registered')

    const onUpdate = () => {}
    const result = await doctorTool.execute('regression-3', {}, undefined, onUpdate, toolContext())

    expect(result.content[0]?.text).toContain('healthy')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual([...DOCTOR_ARGS])
  })
})

// ---------------------------------------------------------------------------
// Task 2.3: sandbox and failure behavior
// ---------------------------------------------------------------------------

describe('task 2.3: sandbox and failure behavior', () => {
  it('task 2.3: an out-of-root export output returns NOT_ALLOWED, never prompts, never spawns', async () => {
    const { runner, calls } = spiedRunner()
    const executor = createBundleExportExecutor({ runner })

    const result = await executor(
      's1',
      bundleParams('/workspace/repo', '/etc/repo.cgc'),
      undefined,
      undefined,
      confirmingContext(),
    )

    expect(calls).toHaveLength(0)
    const [block] = result.content
    expect(block?.text).toContain('NOT_ALLOWED')
    expect(block?.text).toContain('/etc/repo.cgc')
    expect(block?.text).toContain('outside the allowed roots')
    expect(block?.text).toContain('inside an allowed root')
    const details = result.details as Record<string, unknown>
    expect(details.ok).toBe(false)
    expect(details.code).toBe('NOT_ALLOWED')
    expect(details.reason).toBe('outside allowed roots')
    expect(details.label).toBe(BUNDLE_EXPORT_OUTPUT_ARG)
    expect(details.resolved).toBe('/etc/repo.cgc')
  })

  it('task 2.3: an out-of-root export repository returns NOT_ALLOWED before the consent dialog', async () => {
    const seen: { title: string }[] = []
    const { runner, calls } = spiedRunner()
    const executor = createBundleExportExecutor({ runner })

    const result = await executor(
      's2',
      bundleParams('/home/other/repo', '/workspace/repo/repo.cgc'),
      undefined,
      undefined,
      toolContext({
        ui: {
          confirm: async (title: string) => {
            seen.push({ title })
            return true
          },
        },
      }),
    )

    expect(calls).toHaveLength(0)
    // The rejection is a hard NOT_ALLOWED, not a prompt: no dialog, no run.
    expect(seen).toHaveLength(0)
    expect(result.content[0]?.text).toContain('NOT_ALLOWED')
    expect(result.content[0]?.text).toContain('/home/other/repo')
    expect((result.details as Record<string, unknown>).code).toBe('NOT_ALLOWED')
    expect((result.details as Record<string, unknown>).label).toBe(BUNDLE_EXPORT_REPOSITORY_ARG)
  })

  it('task 2.3: a relative path escaping the session root returns NOT_ALLOWED', async () => {
    const { runner, calls } = spiedRunner()
    const executor = createBundleExportExecutor({ runner })

    const result = await executor(
      's3',
      bundleParams('/workspace/repo', '../escape.cgc'),
      undefined,
      undefined,
      confirmingContext(),
    )

    expect(calls).toHaveLength(0)
    expect(result.content[0]?.text).toContain('NOT_ALLOWED')
    expect(result.content[0]?.text).toContain('/workspace/escape.cgc')
  })

  it('task 2.3: CGC_ALLOWED_ROOTS entries widen the sandbox (mirrors CGC get_allowed_roots)', async () => {
    const previous = process.env[CGC_ALLOWED_ROOTS_ENV]
    process.env[CGC_ALLOWED_ROOTS_ENV] = '/tmp'
    try {
      const { runner, calls } = spiedRunner()
      const executor = createBundleExportExecutor({ runner })

      const result = await executor(
        's4',
        bundleParams('/workspace/repo', '/tmp/repo.cgc'),
        undefined,
        undefined,
        confirmingContext(),
      )

      expect(calls).toHaveLength(1)
      expect(result.content[0]?.text).toContain('exported bundle')
      const details = result.details as Record<string, unknown>
      expect(details.ok).toBe(true)
      expect(details.code).toBe('OK')
    } finally {
      if (previous === undefined) delete process.env[CGC_ALLOWED_ROOTS_ENV]
      else process.env[CGC_ALLOWED_ROOTS_ENV] = previous
    }
  })

  it('task 2.3: an out-of-root context create dbPath returns NOT_ALLOWED and never spawns', async () => {
    const { runner, calls } = recordingRunner()
    const executor = createContextExecutor({ runner })

    const result = await executor(
      's5',
      contextParams('create', 'escaped', { [CONTEXT_DB_PATH_ARG]: '/etc/cgc-db' }),
      undefined,
      undefined,
      toolContext(),
    )

    expect(calls).toHaveLength(0)
    expect(result.content[0]?.text).toContain('NOT_ALLOWED')
    expect(result.content[0]?.text).toContain('/etc/cgc-db')
    const details = result.details as Record<string, unknown>
    expect(details.code).toBe('NOT_ALLOWED')
    expect(details.label).toBe(CONTEXT_DB_PATH_ARG)
  })

  it('task 2.3: a CGC sandbox rejection on a failed run is re-derived to NOT_ALLOWED', async () => {
    // The "WHEN CGC rejects it" leg: the runner has no sandbox knowledge, so
    // a failed result carrying CGC's rejection wording must surface NOT_ALLOWED
    // (doctor carries no tool-side path arguments, so it reaches the runner).
    const { runner, calls } = recordingRunner({
      ok: false,
      code: 'COMMAND_FAILED',
      message: 'cgc exited with code 1',
      exitCode: 1,
      stderr: "Path '/etc/repo.cgc' is outside the allowed roots.",
    })
    const executor = createDoctorExecutor({ runner })

    const result = await executor('s6', {}, undefined, undefined, toolContext())

    expect(calls).toHaveLength(1)
    const [block] = result.content
    expect(block?.text).toContain('NOT_ALLOWED')
    expect(block?.text).toContain('outside the allowed roots')
    expect(block?.text).toContain('inside an allowed root')
    const details = result.details as Record<string, unknown>
    expect(details.ok).toBe(false)
    expect(details.code).toBe('NOT_ALLOWED')
    expect(details.stderrTail).toContain('outside the allowed roots')
  })

  it('task 2.3: a missing cgc binary surfaces UNAVAILABLE with install guidance through the real runner', async () => {
    const runner = new CgcRunner({ executable: '/nonexistent-cgc-binary-task-2-3' })
    const executor = createDoctorExecutor({ runner })

    const result = await executor('s7', {}, undefined, undefined, toolContext())

    const [block] = result.content
    expect(block?.text).toContain('UNAVAILABLE')
    expect(block?.text).toContain('Install CodeGraphContext')
    expect(block?.text).toContain('on PATH')
    const details = result.details as Record<string, unknown>
    expect(details.ok).toBe(false)
    expect(details.code).toBe('UNAVAILABLE')
  })

  it('task 2.3: a lock-conflict export returns BUSY and is attempted exactly once (no retries)', async () => {
    const { runner, calls } = spiedRunner({
      ok: false,
      code: 'BUSY',
      message:
        'cgc reported an embedded-database lock conflict (another CGC process holds the workspace)',
      exitCode: 1,
      stderr: 'database is locked by another process',
    })
    const executor = createBundleExportExecutor({ runner })

    const result = await executor('s8', bundleParams(), undefined, undefined, confirmingContext())

    expect(calls).toHaveLength(1)
    const [block] = result.content
    expect(block?.text).toContain('BUSY')
    expect(block?.text).toContain('Another CGC process holds')
    expect(block?.text).toContain('no automatic retry was attempted')
    const details = result.details as Record<string, unknown>
    expect(details.ok).toBe(false)
    expect(details.code).toBe('BUSY')
    expect(details.stderrTail).toContain('locked')
  })

  it('task 2.3: a lock-conflict doctor run returns BUSY naming the conflict, without retrying', async () => {
    const { runner, calls } = recordingRunner({
      ok: false,
      code: 'BUSY',
      message:
        'cgc reported an embedded-database lock conflict (another CGC process holds the workspace)',
      exitCode: 1,
      stderr: 'The database is locked; another process holds it.',
    })
    const executor = createDoctorExecutor({ runner })

    const result = await executor('s9', {}, undefined, undefined, toolContext())

    expect(calls).toHaveLength(1)
    const [block] = result.content
    expect(block?.text).toContain('BUSY')
    expect(block?.text).toContain('Another CGC process holds')
    expect((result.details as Record<string, unknown>).code).toBe('BUSY')
  })
})

// ---------------------------------------------------------------------------
// Shared structured error mapper (task 1.5)
// ---------------------------------------------------------------------------

describe('shared structured error mapper (task 1.5)', () => {
  it('task 1.5: exports exactly the six canonical D4 error codes', () => {
    expect(CLI_GAP_ERROR_CODES).toEqual([
      'NOT_FOUND',
      'NOT_ALLOWED',
      'BUSY',
      'TIMEOUT',
      'COMMAND_FAILED',
      'UNAVAILABLE',
    ])
  })

  it('task 1.5: renders a UPPER_SNAKE header, the bounded stderr tail, and the remediation hint', () => {
    const text = cliGapErrorText({
      tool: CONTEXT_TOOL,
      code: 'UNAVAILABLE',
      message: 'cgc binary not found',
      stderr: 'sh: cgc: command not found',
      fallback: 'The cgc command failed; nothing was changed.',
    })

    expect(text).toContain(`${CONTEXT_TOOL}: UNAVAILABLE \u2014 cgc binary not found.`)
    expect(text).toContain('stderr: sh: cgc: command not found')
    expect(text).toContain('on PATH')
  })

  it('task 1.5: every canonical D4 code except COMMAND_FAILED carries a tailored remediation hint', () => {
    const hints = new Map(CLI_GAP_ERROR_CODES.map((code) => [code, remediateCliGapFailure(code)]))
    for (const code of CLI_GAP_ERROR_CODES) {
      // COMMAND_FAILED is the catch-all: its remedial line is the caller's
      // fallback, which cliGapErrorText renders when the hint is undefined.
      if (code === 'COMMAND_FAILED') continue
      expect(hints.get(code)).toBeDefined()
    }
    expect(remediateCliGapFailure('COMMAND_FAILED')).toBeUndefined()
  })

  it('task 1.5: a code without a tailored hint falls back to the caller line', () => {
    const text = cliGapErrorText({
      tool: BUNDLE_EXPORT_TOOL,
      code: 'COMMAND_FAILED',
      message: 'the verb exited 3',
      stderr: '',
      fallback: 'The cgc command failed; nothing was written.',
    })

    expect(text).toContain('COMMAND_FAILED')
    expect(text).toContain('The cgc command failed; nothing was written.')
  })

  it('task 1.5: NOT_FOUND and NOT_ALLOWED render canonical codes with actionable hints', () => {
    const notFound = cliGapErrorText({
      tool: CONTEXT_TOOL,
      code: 'NOT_FOUND',
      message: "context 'legacy' is not registered",
      stderr: '',
      fallback: 'List contexts to confirm the exact name.',
    })
    const notAllowed = cliGapErrorText({
      tool: BUNDLE_EXPORT_TOOL,
      code: 'NOT_ALLOWED',
      message: 'the output path is outside the allowed roots',
      stderr: 'sandbox: /etc/repo.cgc is not inside any allowed root',
      fallback: 'The cgc command failed; nothing was written.',
    })

    expect(notFound).toContain('NOT_FOUND')
    expect(notFound).toContain("context 'legacy' is not registered")
    expect(notFound).toContain('verify the exact name')
    expect(notAllowed).toContain('NOT_ALLOWED')
    expect(notAllowed).toContain('outside its allowed sandbox')
    expect(notAllowed).toContain('stderr: sandbox: /etc/repo.cgc is not inside any allowed root')
  })

  it('task 1.5: the embedded stderr tail is bounded with the truncation marker', () => {
    const huge = 'x'.repeat(CLI_GAP_ERROR_STDERR_TAIL_BUDGET * 3)
    const text = cliGapErrorText({
      tool: DOCTOR_TOOL,
      code: 'TIMEOUT',
      message: 'the command exceeded its time budget',
      stderr: huge,
      fallback: 'no diagnostics were produced.',
    })

    expect(text).toContain('TIMEOUT')
    expect(text).toContain('output truncated')
    // The bounded tail plus header/hint stays far under the delivered policy
    // budget, so the render sites never double-truncate the final text.
    expect(text.length).toBeLessThan(OUTPUT_POLICY_MAX_BYTES)
  })

  it("task 1.5: the runner's CANCELLED abort code keeps its UPPER_SNAKE hint", () => {
    const text = cliGapErrorText({
      tool: CONTEXT_TOOL,
      code: 'CANCELLED',
      message: 'aborted by the session',
      stderr: '',
      fallback: 'nothing was changed.',
    })

    expect(text).toContain('CANCELLED')
    expect(text).toContain('cancelled by the session')
  })
})
