// CLI-gap tool surface (design D1/D2 of add-cgc-cli-gap-tools). The three
// management tools wrap documented `cgc` CLI verbs the CGC MCP server does
// not expose (bundle export, named-context management, doctor), closing the
// gap between the MCP catalog and the CLI (D1). They register as one set
// gated on `tools.cliGap.enabled` (default on; the CGC_TOOLS_CLI_GAP_ENABLED
// environment override takes precedence, D2) — see the gated call in
// extensions/index.ts.
//
// Task 1.1 establishes the registration contract: the tool names, labels,
// descriptions and parameter schemas plus a fail-closed execute seam. Task
// 1.2 wires the `cgc_bundle_export` executor (confirmation via the ADR-0003
// consent layer, documented `cgc bundle export` verb, never destructive
// flags); the remaining executors (tasks 1.3–1.4) and the structured error
// mapper (task 1.5) plug into the same dependency surface, so a tool without
// an executor still fails closed with an explicit "not implemented in this
// build" message and never touches the `cgc` binary.
import { statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { type TSchema, Type } from 'typebox'
import { DOCTOR_ARGS } from './commands'
import { applyOutputPolicy, boundText, OUTPUT_POLICY_MAX_BYTES } from './output-policy'
import type { CgcCommandResult, CgcRunner, CgcRunOptions } from './runner'

/** The bundle-export tool (executor wired by task 1.2). */
export const BUNDLE_EXPORT_TOOL = 'cgc_bundle_export'
/** The named-context tool (executor wired by task 1.3). */
export const CONTEXT_TOOL = 'cgc_context'
/** The diagnostics tool (executor wired by task 1.4). */
export const DOCTOR_TOOL = 'cgc_doctor'

/** The three CLI-gap tool names, in registration order (D1). */
export const CLI_GAP_TOOL_NAMES: readonly string[] = [BUNDLE_EXPORT_TOOL, CONTEXT_TOOL, DOCTOR_TOOL]

/** Argument name for the repository path of `cgc_bundle_export`. */
export const BUNDLE_EXPORT_REPOSITORY_ARG = 'repository'
/** Argument name for the output path of `cgc_bundle_export`. */
export const BUNDLE_EXPORT_OUTPUT_ARG = 'output'

/**
 * The documented verb prefix of `cgc bundle export` (design D1: fixed,
 * documented verbs only — no passthrough; task 1.2 never appends
 * clear-on-load-style destructive flags). The output path and the `--repo`
 * flag complete the argv at call time.
 */
export const BUNDLE_EXPORT_VERB_ARGS: readonly string[] = ['bundle', 'export']

/**
 * The fixed parameter schema of `cgc_bundle_export` (design D1: validated
 * fixed arguments only). `repository` maps to the documented `--repo` flag;
 * `output` is the positional `.cgc` destination of the verb.
 */
export const BUNDLE_EXPORT_PARAMETERS: TSchema = Type.Object({
  [BUNDLE_EXPORT_REPOSITORY_ARG]: Type.String({
    description: 'Repository path to export (the documented `cgc bundle export --repo` argument)',
    minLength: 1,
  }),
  [BUNDLE_EXPORT_OUTPUT_ARG]: Type.String({
    description: 'Output path for the generated .cgc bundle file',
    minLength: 1,
  }),
})

/** One text content block of a tool result (the pi tool-result shape). */
export interface CliGapToolTextContent {
  type: 'text'
  text: string
}

/** Result a CLI-gap tool executor resolves with. */
export interface CliGapToolResult {
  content: CliGapToolTextContent[]
  /** Structured details for logs/UI; task 1.5's error mapper fills these. */
  details: Record<string, unknown>
}

/**
 * Minimal Pi session-context slice a CLI-gap executor reads (defensive
 * narrowing; the real `ExtensionContext` satisfies it structurally).
 */
export interface CliGapToolContext {
  cwd?: unknown
  ui?: {
    confirm?: unknown
    notify?: unknown
  }
}

/**
 * One tool executor: pure function of (tool call, args, abort, update, session).
 *
 * Mirrors pi 0.85.1's real invocation order for `registerTool` definitions
 * (dist/core/extensions/types.d.ts:372): `execute(toolCallId, params, signal,
 * onUpdate, ctx)` — the 4th argument is the optional progress-update callback,
 * the session context is the 5th. This seam is typed as unknown/defensive
 * narrowing like {@link CliGapToolContext}; the real `ExtensionContext`
 * satisfies it structurally.
 */
export type CliGapToolExecutor = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: CliGapToolContext,
) => Promise<CliGapToolResult>

/** A registerable CLI-gap tool definition (structural subset of pi's). */
export interface CliGapToolDefinition {
  name: string
  label: string
  description: string
  parameters: TSchema
  execute: CliGapToolExecutor
}

/**
 * Minimal Pi extension API surface the CLI-gap tools register on (a
 * structural test seam, same pattern as gate.ts / cleanup.ts).
 */
export interface CliGapToolsApi {
  registerTool(tool: CliGapToolDefinition): void
}

/**
 * The dependency surface index.ts wires. The per-tool executors arrive with
 * tasks 1.2–1.4; a missing executor registers the fail-closed placeholder so
 * registration order and count are stable from task 1.1 onward.
 */
export interface CliGapToolDependencies {
  bundleExport?: CliGapToolExecutor
  context?: CliGapToolExecutor
  doctor?: CliGapToolExecutor
}

/** Fail-closed executor used until the owning task ships the real one. */
function notImplementedExecutor(toolName: string): CliGapToolExecutor {
  return async (_toolCallId, _params, _signal, _onUpdate, _ctx) => ({
    content: [
      {
        type: 'text',
        text:
          `${toolName}: this extension build does not implement this tool yet ` +
          '(add-cgc-cli-gap-tools task 1.2–1.4); nothing ran. Use the `cgc` CLI directly.',
      },
    ],
    details: { tool: toolName, implemented: false },
  })
}

// ---------------------------------------------------------------------------
// Shared structured error mapper (task 1.5)
// ---------------------------------------------------------------------------

/**
 * Failure codes the shared mapper renders: the six canonical D4 codes
 * (NOT_FOUND / NOT_ALLOWED / BUSY / TIMEOUT / COMMAND_FAILED / UNAVAILABLE)
 * plus the runner's CANCELLED abort code. NOT_FOUND and NOT_ALLOWED are
 * never emitted by the runner (runner.ts:28-34) — the tool layer derives
 * them from coarse CLI output markers, exactly like the context `not found`
 * classification below — while the runner's own codes (UNAVAILABLE, TIMEOUT,
 * BUSY, COMMAND_FAILED, and the CANCELLED abort) fill out the rest.
 */
export type CliGapErrorCode = CgcCommandResult['code'] | 'NOT_FOUND' | 'NOT_ALLOWED'

/** The six canonical normalized error codes of design D4. */
export const CLI_GAP_ERROR_CODES: readonly CliGapErrorCode[] = [
  'NOT_FOUND',
  'NOT_ALLOWED',
  'BUSY',
  'TIMEOUT',
  'COMMAND_FAILED',
  'UNAVAILABLE',
]

/** Input of the shared D4 error-text builder ({@link cliGapErrorText}). */
export interface CliGapErrorTextInput {
  /** The tool's error prefix, e.g. `cgc_bundle_export`. */
  tool: string
  /** The normalized UPPER_SNAKE code (one of {@link CliGapErrorCode}). */
  code: CliGapErrorCode
  /** The settled failure message from the runner result. */
  message: string
  /** The bounded stderr tail to embed (the runner result's `stderr`). */
  stderr?: string
  /**
   * The generic remediation line rendered when the code has no tailored
   * hint (callers phrase the tool's own "nothing happened" consequence).
   */
  fallback: string
}

/**
 * Budget for the stderr tail embedded in a structured D4 error (design D4:
 * "a bounded stderr tail"). The runner capture is already head+tail bounded
 * (output-policy.ts), but the ERROR's tail is bounded HERE, independently of
 * the message, so a pathological stream can never crowd the remediation hint
 * out of the rendered text. 4 KiB carries any real stderr tail; oversized
 * tails are bounded head+tail with the shared truncation marker.
 */
export const CLI_GAP_ERROR_STDERR_TAIL_BUDGET = 4096

/**
 * One-line remediation hint for a normalized failure code (design D4). The
 * hint is the "how to fix it" half of the structured-error contract; codes
 * without a tailored hint (COMMAND_FAILED and friends) fall back to the
 * caller's generic line.
 */
export function remediateCliGapFailure(code: CliGapErrorCode): string | undefined {
  switch (code) {
    case 'UNAVAILABLE':
      return (
        'Install CodeGraphContext and make sure `cgc` is on PATH, or set ' +
        '"cgc": { "executable": "\u2026" } in .pi/cgc.json (project) or ~/.pi/agent/cgc.json (global), or CGC_EXECUTABLE.'
      )
    case 'BUSY':
      return 'Another CGC process holds the registry or database; retry once it finishes (no automatic retry was attempted).'
    case 'TIMEOUT':
      return 'The command exceeded its time budget and was terminated.'
    case 'CANCELLED':
      return 'The invocation was cancelled by the session; nothing was changed.'
    case 'NOT_FOUND':
      return 'The named resource was not found; list or verify the exact name and retry.'
    case 'NOT_ALLOWED':
      return 'CGC rejected the path or operation as outside its allowed sandbox; use a path inside an allowed root and retry.'
    default:
      return undefined
  }
}

/**
 * The shared D4 structured error text (task 1.5): a canonical UPPER_SNAKE
 * code line, the bounded stderr tail (when the result carries one), and a
 * one-line remediation hint. Replaces the per-tool error-text twins. The
 * render sites pipe the result through {@link applyOutputPolicy} (the 16 KiB
 * delivered budget), so the full text can never exceed the policy.
 */
export function cliGapErrorText(input: CliGapErrorTextInput): string {
  const text = [`${input.tool}: ${input.code} \u2014 ${input.message}.`]
  const stderr = input.stderr?.trim() ?? ''
  if (stderr.length > 0) {
    text.push(
      `stderr: ${boundText(stderr, {
        budget: CLI_GAP_ERROR_STDERR_TAIL_BUDGET,
        label: input.tool,
        originalSize: stderr.length,
      })}`,
    )
  }
  text.push(remediateCliGapFailure(input.code) ?? input.fallback)
  return text.join('\n')
}

// ---------------------------------------------------------------------------
// Path sandbox (task 2.3): mirror CGC's sandbox, never bypass it
// ---------------------------------------------------------------------------

/**
 * Environment variable carrying ADDITIONAL allowed sandbox roots — the exact
 * variable CGC's own path sandbox reads (utils/path_sandbox.py
 * `get_allowed_roots`). The runner spawns `cgc` with the session working
 * directory, so CGC's process cwd IS the session cwd and the two allowed-root
 * sets coincide; widening here widens CGC's sandbox identically.
 */
export const CGC_ALLOWED_ROOTS_ENV = 'CGC_ALLOWED_ROOTS'

/**
 * The roots a tool path argument may resolve under: the resolved session
 * working directory plus every non-empty entry of
 * {@link CGC_ALLOWED_ROOTS_ENV} (separated by ':' on POSIX and ';' on
 * Windows — exactly CGC's separator).
 */
export function allowedSandboxRoots(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const roots = [resolve(cwd)]
  const raw = env[CGC_ALLOWED_ROOTS_ENV]
  if (raw !== undefined && raw.length > 0) {
    const separator = process.platform === 'win32' ? ';' : ':'
    for (const entry of raw.split(separator)) {
      const trimmed = entry.trim()
      if (trimmed.length > 0) roots.push(resolve(trimmed))
    }
  }
  return roots
}

/** One path argument rejected as outside the allowed roots. */
export interface SandboxViolation {
  /** Argument name, e.g. {@link BUNDLE_EXPORT_OUTPUT_ARG}. */
  label: string
  /** The raw argument the agent passed. */
  value: string
  /** The path resolved against the invocation cwd, as the spawn sees it. */
  resolved: string
}

/**
 * Resolve a tool path argument against the invocation cwd — the same
 * resolution the runner's spawn and CGC's sandbox apply — and return null
 * when it stays inside the allowed roots, or a {@link SandboxViolation}
 * naming the escaping path. Mirrors CGC's `is_path_allowed`
 * (utils/path_sandbox.py): allowed iff the resolved path IS a root or sits
 * under one. Purely lexical (resolve/containment; no filesystem access), like
 * the native check.
 */
export function checkSandboxedPath(
  cwd: string,
  label: string,
  value: string,
  env: Record<string, string | undefined> = process.env,
): SandboxViolation | null {
  const roots = allowedSandboxRoots(cwd, env)
  const resolved = resolve(cwd, value)
  for (const root of roots) {
    const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`
    if (resolved === root || resolved.startsWith(rootWithSep)) return null
  }
  return { label, value, resolved }
}

/**
 * Render a pre-flight sandbox rejection as a structured NOT_ALLOWED result
 * (design D4, task 2.3): the canonical UPPER_SNAKE code, a message naming the
 * offending argument and the path it resolves to, and the shared remediation
 * hint ("use a path inside an allowed root and retry"). Nothing ran, so
 * there is no stderr tail; `fallback` covers the (hint-less) impossible case.
 */
function sandboxRejectedResult(
  tool: string,
  violation: SandboxViolation,
  fallback: string,
): CliGapToolResult {
  const text = applyOutputPolicy(
    cliGapErrorText({
      tool,
      code: 'NOT_ALLOWED',
      message: `${violation.label} ${violation.value} resolves outside the allowed roots (${violation.resolved})`,
      fallback,
    }),
    { budget: OUTPUT_POLICY_MAX_BYTES, label: tool },
  )
  return {
    content: [{ type: 'text' as const, text }],
    details: {
      tool,
      ok: false,
      code: 'NOT_ALLOWED',
      reason: 'outside allowed roots',
      label: violation.label,
      value: violation.value,
      resolved: violation.resolved,
    },
  }
}

/**
 * Wording CGC prints when ITS path sandbox rejects an operation
 * (path_sandbox.py / server handlers: "outside the allowed roots", "not
 * inside any allowed root"). The runner has no sandbox knowledge, so a
 * FAILED result carrying this wording is re-derived to NOT_ALLOWED here — the
 * spec's "WHEN CGC rejects it" leg of the sandbox scenario; the other leg is
 * the pre-flight {@link checkSandboxedPath}.
 */
const SANDBOX_REJECTION_MARKER = /outside (?:the )?allowed roots?|not inside any allowed root/i

/**
 * The normalized D4 code of a failed runner result: the runner's own code
 * unless the captured output shows CGC's sandbox rejection, which the runner
 * cannot classify (BUSY/TIMEOUT/... keep their runner codes).
 */
function failureCode(
  result: Pick<CgcCommandResult, 'code' | 'stdout' | 'stderr'>,
): CliGapErrorCode {
  if (SANDBOX_REJECTION_MARKER.test(`${result.stdout}\n${result.stderr}`)) return 'NOT_ALLOWED'
  return result.code
}

// ---------------------------------------------------------------------------
// cgc_bundle_export (task 1.2)
// ---------------------------------------------------------------------------

/** Dependencies the bundle-export executor needs (wired by index.ts). */
export interface BundleExportDependencies {
  /** The shared runner every cgc spawn goes through (runner.ts). */
  runner: CgcRunner
}

/** The bundle-export confirmation dialog title (ADR-0003: the write is named before consent). */
export const BUNDLE_EXPORT_CONFIRM_TITLE = 'Export a CGC bundle?'

/**
 * The bundle-export confirmation message (ADR-0003: a file write requires
 * explicit consent naming the destination; mirrors the slash-commands
 * report-write consent, which also names the exact path).
 */
export function bundleExportConsentMessage(repository: string, output: string): string {
  return (
    `This exports a .cgc bundle of ${repository} to ${output} using the documented ` +
    '`cgc bundle export` verb and writes the bundle file at the destination. Continue?'
  )
}

/**
 * One consent exchange for the bundle write, fail-closed (ADR-0003): consent
 * is granted ONLY by an explicit `true` from the session's confirm dialog. A
 * missing dialog surface, a throwing dialog, or a user decline all resolve
 * declined — never an exception, never a silent grant. The caller must not
 * proceed on `false` (spec: "no file was written and no `cgc` export command
 * ran" when declined).
 */
async function confirmBundleExport(
  ctx: CliGapToolContext,
  repository: string,
  output: string,
): Promise<boolean> {
  const confirm = ctx.ui?.confirm
  if (typeof confirm !== 'function') return false
  try {
    return (
      (await confirm(
        BUNDLE_EXPORT_CONFIRM_TITLE,
        bundleExportConsentMessage(repository, output),
      )) === true
    )
  } catch {
    return false
  }
}

/** Basic size information for the produced bundle (spec: names it with basic size information). */
function describeBundleSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

/**
 * Best-effort size of the produced bundle at the output path (resolved
 * against the invocation cwd), or null when it cannot be statted — the
 * result then simply omits size information; the export itself succeeded.
 */
function statBundleSize(cwd: string, output: string): number | null {
  try {
    return statSync(resolve(cwd, output)).size
  } catch {
    return null
  }
}

/**
 * Create the `cgc_bundle_export` executor (task 1.2).
 *
 * Flow: validate the fixed arguments (repository + output paths) → explicit
 * in-session confirmation of the file write (ADR-0003, fail-closed) → one
 * `cgc bundle export <output> --repo <repository>` invocation through the
 * shared runner (argument-array spawn, session cwd, time budget, abort
 * signal, output policy) → a structured result naming the bundle with basic
 * size information. Never passes destructive flags (D3). A decline or any
 * pre-flight failure runs NO `cgc` command.
 *
 * Invoked by pi as `(toolCallId, params, signal, onUpdate, ctx)` (0.85.1);
 * the session context used for cwd and consent is the 5th argument.
 */
export function createBundleExportExecutor(deps: BundleExportDependencies): CliGapToolExecutor {
  return async (_toolCallId, params, signal, _onUpdate, ctx) => {
    const repository = params[BUNDLE_EXPORT_REPOSITORY_ARG]
    const output = params[BUNDLE_EXPORT_OUTPUT_ARG]

    if (
      typeof repository !== 'string' ||
      repository.length === 0 ||
      typeof output !== 'string' ||
      output.length === 0
    ) {
      const text =
        `${BUNDLE_EXPORT_TOOL}: invalid arguments \u2014 "${BUNDLE_EXPORT_REPOSITORY_ARG}" ` +
        `(repository path) and "${BUNDLE_EXPORT_OUTPUT_ARG}" (output path) are required ` +
        'non-empty strings; nothing ran.'
      return {
        content: [{ type: 'text' as const, text }],
        details: { tool: BUNDLE_EXPORT_TOOL, error: 'INVALID_ARGUMENTS' },
      }
    }

    const cwd = typeof ctx.cwd === 'string' && ctx.cwd.length > 0 ? ctx.cwd : undefined
    if (cwd === undefined) {
      const text =
        `${BUNDLE_EXPORT_TOOL}: UNAVAILABLE \u2014 the session did not provide a working ` +
        'directory; nothing ran. Restart the session so Pi supplies a working directory.'
      return {
        content: [{ type: 'text' as const, text }],
        details: { tool: BUNDLE_EXPORT_TOOL, code: 'UNAVAILABLE' },
      }
    }

    // Task 2.3: the export must stay inside the allowed roots (the session
    // working directory plus any CGC_ALLOWED_ROOTS entries — the same sandbox
    // CGC enforces; design: this surface "MUST NOT bypass CGC's path
    // sandbox"). The check runs BEFORE the consent dialog: an out-of-root
    // destination is a hard rejection (NOT_ALLOWED), not a prompt.
    for (const [label, value] of [
      [BUNDLE_EXPORT_REPOSITORY_ARG, repository],
      [BUNDLE_EXPORT_OUTPUT_ARG, output],
    ] as const) {
      const violation = checkSandboxedPath(cwd, label, value)
      if (violation !== null) {
        return sandboxRejectedResult(
          BUNDLE_EXPORT_TOOL,
          violation,
          'No bundle was written and no `cgc` command ran.',
        )
      }
    }

    // ADR-0003: the file write needs explicit consent; only `true` proceeds.
    if (!(await confirmBundleExport(ctx, repository, output))) {
      const text = `${BUNDLE_EXPORT_TOOL}: export declined \u2014 no file was written and no \`cgc\` command ran.`
      return {
        content: [{ type: 'text' as const, text }],
        details: { tool: BUNDLE_EXPORT_TOOL, action: 'declined', repository, output },
      }
    }

    const argv: string[] = [...BUNDLE_EXPORT_VERB_ARGS, output, '--repo', repository]
    const options: CgcRunOptions = { args: argv }
    if (signal !== undefined) options.signal = signal
    let result: CgcCommandResult
    try {
      result = await deps.runner.run(cwd, options)
    } catch (error) {
      // The runner only throws on caller contract violations (non-string argv
      // or an empty cwd) — both are excluded above, so this is defensive.
      const detail = error instanceof Error ? error.message : String(error)
      const text = `${BUNDLE_EXPORT_TOOL}: COMMAND_FAILED \u2014 ${detail}; nothing was written.`
      return {
        content: [{ type: 'text' as const, text }],
        details: { tool: BUNDLE_EXPORT_TOOL, code: 'COMMAND_FAILED', error: detail },
      }
    }

    if (result.ok) {
      const sizeBytes = statBundleSize(cwd, output)
      const sizeNote = sizeBytes !== null ? ` (${describeBundleSize(sizeBytes)})` : ''
      const text =
        `${BUNDLE_EXPORT_TOOL}: exported bundle of ${repository} to ${output}${sizeNote} ` +
        'using the documented `cgc bundle export` verb.'
      return {
        content: [{ type: 'text' as const, text }],
        details: {
          tool: BUNDLE_EXPORT_TOOL,
          ok: true,
          code: result.code,
          repository,
          output,
          sizeBytes,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          argv: result.argv,
        },
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: applyOutputPolicy(
            cliGapErrorText({
              tool: BUNDLE_EXPORT_TOOL,
              code: failureCode(result),
              message: result.message,
              stderr: result.stderr,
              fallback: 'The cgc command failed; nothing was written.',
            }),
            { budget: OUTPUT_POLICY_MAX_BYTES, label: BUNDLE_EXPORT_TOOL },
          ),
        },
      ],
      details: {
        tool: BUNDLE_EXPORT_TOOL,
        ok: false,
        code: failureCode(result),
        message: result.message,
        repository,
        output,
        exitCode: result.exitCode,
        argv: result.argv,
        stdoutTail: result.stdout,
        stderrTail: result.stderr,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// cgc_context (task 1.3)
// ---------------------------------------------------------------------------

/** Argument name selecting the context operation (design D1: fixed, validated verbs). */
export const CONTEXT_VERB_ARG = 'verb'
/** Argument name for the target context name (create/delete/set-default). */
export const CONTEXT_NAME_ARG = 'name'
/** Argument name for the optional create database backend (`--database`). */
export const CONTEXT_DATABASE_ARG = 'database'
/** Argument name for the optional create database path (`--db-path`). */
export const CONTEXT_DB_PATH_ARG = 'dbPath'

/**
 * The four documented `cgc context` capabilities (design D1 / proposal
 * vocabulary). `set-default` maps to the documented `default` verb — the
 * cgc CLI names it `cgc context default <name>`.
 */
export const CONTEXT_VERBS: readonly string[] = ['list', 'create', 'delete', 'set-default']

/** argv heads of the documented `cgc context` verbs (verified against cgc 0.6.x). */
export const CONTEXT_LIST_VERB_ARGS: readonly string[] = ['context', 'list']
export const CONTEXT_CREATE_VERB_ARGS: readonly string[] = ['context', 'create']
export const CONTEXT_DELETE_VERB_ARGS: readonly string[] = ['context', 'delete']
export const CONTEXT_DEFAULT_VERB_ARGS: readonly string[] = ['context', 'default']

/**
 * The fixed parameter schema of `cgc_context` (design D1: validated fixed
 * arguments only). `verb` selects the documented operation; `name` is
 * validated per-verb in the executor (create/delete/set-default require a
 * non-empty name); `database`/`dbPath` are the optional create settings that
 * map to the documented `--database`/`--db-path` flags.
 */
export const CONTEXT_PARAMETERS: TSchema = Type.Object({
  [CONTEXT_VERB_ARG]: Type.Enum(['list', 'create', 'delete', 'set-default'] as const, {
    description:
      'The operation: "list" (mode, contexts, repositories, current default), ' +
      '"create" (register a new context), "delete" (remove the registration; ' +
      'requires confirmation; never deletes database files), or "set-default" ' +
      '(the documented `cgc context default` verb).',
  }),
  [CONTEXT_NAME_ARG]: Type.String({
    description: 'The context name; required for create/delete/set-default',
    minLength: 1,
  }),
  [CONTEXT_DATABASE_ARG]: Type.String({
    description:
      'Database backend for create (neo4j|falkordb|falkordb-remote|kuzudb|…); ' +
      'maps to the documented `--database` flag (verb default when omitted)',
    minLength: 1,
  }),
  [CONTEXT_DB_PATH_ARG]: Type.String({
    description:
      'Explicit database path for create; maps to the documented `--db-path` ' +
      'flag (context default when omitted)',
    minLength: 1,
  }),
})

/** Dependencies the context executor needs (wired by index.ts). */
export interface ContextDependencies {
  /** The shared runner every cgc spawn goes through (runner.ts). */
  runner: CgcRunner
}

/** The delete confirmation dialog title (ADR-0003: the mutation is named before consent). */
export const CONTEXT_DELETE_CONFIRM_TITLE = 'Delete a CGC named context?'

/**
 * The delete confirmation message (ADR-0003 - and D3 of the design: context
 * delete is a registration-level mutation, never a database deletion).
 */
export function contextDeleteConsentMessage(name: string): string {
  return (
    `This deletes the CGC named context '${name}' from the registry using the ` +
    'documented `cgc context delete` verb. Only the registration is removed ' +
    '— database files remain on disk. Continue?'
  )
}

/**
 * The answer fed to the CLI's OWN confirmation prompt (`[y/N]`) after the
 * ADR-0003 layer above already granted consent: without it the verb aborts
 * with "Aborted." because the shared runner gives the child /dev/null stdin.
 */
export const CONTEXT_DELETE_CONFIRM_ANSWER = 'y\n'

/** Exit-0-but-ineffective markers the cgc CLI prints (it never changes its exit code for these). */
const CONTEXT_DUPLICATE_MARKER = /already exists\./i
const CONTEXT_NOT_FOUND_MARKER = /not found\./i

/**
 * One consent exchange for the context deletion, fail-closed (ADR-0003):
 * consent is granted ONLY by an explicit `true` from the session's confirm
 * dialog. A missing dialog surface, a throwing dialog, or a user decline all
 * resolve declined — never an exception, never a silent grant.
 */
async function confirmContextDelete(ctx: CliGapToolContext, name: string): Promise<boolean> {
  const confirm = ctx.ui?.confirm
  if (typeof confirm !== 'function') return false
  try {
    return (await confirm(CONTEXT_DELETE_CONFIRM_TITLE, contextDeleteConsentMessage(name))) === true
  } catch {
    return false
  }
}

/**
 * Classify an output-positive-but-ineffective result (the cgc CLI exits 0
 * even when a create is a duplicate or a delete/set-default names an
 * unregistered context — worktree.ts documents the same create quirk). Only
 * the mutating verbs are watched; `list` output carries no markers.
 */
function contextResultIssue(
  result: CgcCommandResult,
  verb: string,
): 'duplicate' | 'not-found' | null {
  if (verb !== 'create' && verb !== 'delete' && verb !== 'set-default') return null
  const haystack = `${result.stdout}\n${result.stderr}`
  if (CONTEXT_DUPLICATE_MARKER.test(haystack)) return 'duplicate'
  if (CONTEXT_NOT_FOUND_MARKER.test(haystack)) return 'not-found'
  return null
}

/**
 * Create the `cgc_context` executor (task 1.3).
 *
 * Flow: validate the fixed arguments (documented verb + per-verb name and
 * create settings) → consent for `delete` only (ADR-0003/D3, fail-closed;
 * list/create/set-default run without consent) → one documented `cgc context`
 * invocation through the shared runner (argument-array spawn, session cwd,
 * time budget, abort signal, output policy). Delete answers the CLI's own
 * `[y/N]` prompt via the runner's stdin escape hatch AFTER consent, and the
 * tool never touches deletion-safety-gated operations or `--clear` (D3).
 * A decline or any pre-flight failure runs NO `cgc` command.
 *
 * Invoked by pi as `(toolCallId, params, signal, onUpdate, ctx)` (0.85.1);
 * the session context used for cwd and consent is the 5th argument.
 */
export function createContextExecutor(deps: ContextDependencies): CliGapToolExecutor {
  return async (_toolCallId, params, signal, _onUpdate, ctx) => {
    const verb = params[CONTEXT_VERB_ARG]
    if (typeof verb !== 'string' || !CONTEXT_VERBS.includes(verb)) {
      const text =
        `${CONTEXT_TOOL}: invalid arguments \u2014 "${CONTEXT_VERB_ARG}" must be one of ` +
        `"${CONTEXT_VERBS.join('", "')}"; nothing ran.`
      return {
        content: [{ type: 'text' as const, text }],
        details: { tool: CONTEXT_TOOL, error: 'INVALID_ARGUMENTS', verb },
      }
    }

    let name: string | undefined
    if (verb === 'create' || verb === 'delete' || verb === 'set-default') {
      const rawName = params[CONTEXT_NAME_ARG]
      if (typeof rawName !== 'string' || rawName.length === 0) {
        const text =
          `${CONTEXT_TOOL}: invalid arguments \u2014 ${CONTEXT_VERB_ARG} "${verb}" requires ` +
          `a non-empty "${CONTEXT_NAME_ARG}"; nothing ran.`
        return {
          content: [{ type: 'text' as const, text }],
          details: { tool: CONTEXT_TOOL, error: 'INVALID_ARGUMENTS', verb, name: rawName },
        }
      }
      name = rawName
    }

    let database: string | undefined
    let dbPath: string | undefined
    if (verb === 'create') {
      const rawDatabase = params[CONTEXT_DATABASE_ARG]
      const rawDbPath = params[CONTEXT_DB_PATH_ARG]
      for (const [label, raw] of [
        [CONTEXT_DATABASE_ARG, rawDatabase],
        [CONTEXT_DB_PATH_ARG, rawDbPath],
      ] as const) {
        if (raw !== undefined && (typeof raw !== 'string' || raw.length === 0)) {
          const text =
            `${CONTEXT_TOOL}: invalid arguments \u2014 create "${label}" must be a non-empty ` +
            'string when provided; nothing ran.'
          return {
            content: [{ type: 'text' as const, text }],
            details: { tool: CONTEXT_TOOL, error: 'INVALID_ARGUMENTS', verb, label, [label]: raw },
          }
        }
      }
      database = typeof rawDatabase === 'string' ? rawDatabase : undefined
      dbPath = typeof rawDbPath === 'string' ? rawDbPath : undefined
    }

    const cwd = typeof ctx.cwd === 'string' && ctx.cwd.length > 0 ? ctx.cwd : undefined
    if (cwd === undefined) {
      const text =
        `${CONTEXT_TOOL}: UNAVAILABLE \u2014 the session did not provide a working ` +
        'directory; nothing ran. Restart the session so Pi supplies a working directory.'
      return {
        content: [{ type: 'text' as const, text }],
        details: { tool: CONTEXT_TOOL, code: 'UNAVAILABLE' },
      }
    }

    // Task 2.3: a create dbPath must stay inside the allowed roots (session
    // working directory plus CGC_ALLOWED_ROOTS — the sandbox CGC enforces;
    // design: "MUST NOT bypass CGC's path sandbox"). Only the create path
    // argument is sandbox-checked; context names are registry keys, not paths.
    if (verb === 'create' && dbPath !== undefined) {
      const violation = checkSandboxedPath(cwd, CONTEXT_DB_PATH_ARG, dbPath)
      if (violation !== null) {
        return sandboxRejectedResult(
          CONTEXT_TOOL,
          violation,
          'No context was registered and no `cgc` command ran.',
        )
      }
    }

    // ADR-0003/D3: only DELETE is consent-gated; list/create/set-default run
    // without confirmation and nothing below runs on a decline.
    if (verb === 'delete') {
      if (!(await confirmContextDelete(ctx, name as string))) {
        const text =
          `${CONTEXT_TOOL}: delete declined \u2014 the context registration was not ` +
          'changed and no `cgc` command ran.'
        return {
          content: [{ type: 'text' as const, text }],
          details: { tool: CONTEXT_TOOL, action: 'declined', verb, name },
        }
      }
    }

    let argv: string[]
    switch (verb) {
      case 'list':
        argv = [...CONTEXT_LIST_VERB_ARGS]
        break
      case 'create':
        argv = [...CONTEXT_CREATE_VERB_ARGS, name as string]
        if (database !== undefined) argv.push('--database', database)
        if (dbPath !== undefined) argv.push('--db-path', dbPath)
        break
      case 'delete':
        argv = [...CONTEXT_DELETE_VERB_ARGS, name as string]
        break
      default:
        // 'set-default' maps to the documented `default` verb.
        argv = [...CONTEXT_DEFAULT_VERB_ARGS, name as string]
        break
    }

    const options: CgcRunOptions = { args: argv }
    // Only delete answers the CLI's own [y/N] — and only after consent above.
    if (verb === 'delete') options.stdin = CONTEXT_DELETE_CONFIRM_ANSWER
    if (signal !== undefined) options.signal = signal
    let result: CgcCommandResult
    try {
      result = await deps.runner.run(cwd, options)
    } catch (error) {
      // The runner only throws on caller contract violations (non-string argv
      // or an empty cwd) — both are excluded above, so this is defensive.
      const detail = error instanceof Error ? error.message : String(error)
      const text = `${CONTEXT_TOOL}: COMMAND_FAILED \u2014 ${detail}; nothing was changed.`
      return {
        content: [{ type: 'text' as const, text }],
        details: { tool: CONTEXT_TOOL, code: 'COMMAND_FAILED', error: detail },
      }
    }

    if (result.ok) {
      const issue = contextResultIssue(result, verb)
      if (issue === 'duplicate') {
        return {
          content: [
            {
              type: 'text' as const,
              text: applyOutputPolicy(
                cliGapErrorText({
                  tool: CONTEXT_TOOL,
                  code: 'COMMAND_FAILED',
                  message: `context '${name}' already exists`,
                  stderr: result.stderr,
                  fallback: 'List contexts to confirm, or delete and recreate it.',
                }),
                { budget: OUTPUT_POLICY_MAX_BYTES, label: CONTEXT_TOOL },
              ),
            },
          ],
          details: {
            tool: CONTEXT_TOOL,
            ok: false,
            code: 'COMMAND_FAILED',
            reason: 'already exists',
            verb,
            name,
            exitCode: result.exitCode,
            stdoutTail: result.stdout,
            stderrTail: result.stderr,
          },
        }
      }
      if (issue === 'not-found') {
        return {
          content: [
            {
              type: 'text' as const,
              text: applyOutputPolicy(
                cliGapErrorText({
                  tool: CONTEXT_TOOL,
                  code: 'NOT_FOUND',
                  message: `context '${name}' is not registered`,
                  stderr: result.stderr,
                  fallback: 'List contexts to confirm the exact name.',
                }),
                { budget: OUTPUT_POLICY_MAX_BYTES, label: CONTEXT_TOOL },
              ),
            },
          ],
          details: {
            tool: CONTEXT_TOOL,
            ok: false,
            code: 'NOT_FOUND',
            verb,
            name,
            exitCode: result.exitCode,
            stdoutTail: result.stdout,
            stderrTail: result.stderr,
          },
        }
      }

      if (verb === 'list') {
        // The cgc CLI prints its rich context table to STDERR (verified live
        // against cgc 0.6.x), so the success surface reads BOTH streams.
        const cliOutput = [result.stdout.trim(), result.stderr.trim()]
          .filter((part) => part.length > 0)
          .join('\n')
        const text = applyOutputPolicy(
          `${CONTEXT_TOOL}: listed CGC named contexts \u2014 mode, context repositories, ` +
            `and the current default, from the documented \`cgc context list\` verb:\n${cliOutput}`,
          { budget: OUTPUT_POLICY_MAX_BYTES, label: CONTEXT_TOOL },
        )
        return {
          content: [{ type: 'text' as const, text }],
          details: {
            tool: CONTEXT_TOOL,
            ok: true,
            code: result.code,
            verb,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            argv: result.argv,
          },
        }
      }

      if (verb === 'create') {
        const text =
          `${CONTEXT_TOOL}: created CGC named context '${name}' (database: ` +
          `${database ?? 'configured default'}` +
          `${dbPath !== undefined ? `; db path: ${dbPath}` : ''}) using the documented ` +
          '`cgc context create` verb.'
        return {
          content: [{ type: 'text' as const, text }],
          details: {
            tool: CONTEXT_TOOL,
            ok: true,
            code: result.code,
            verb,
            name,
            database,
            dbPath,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            argv: result.argv,
          },
        }
      }

      if (verb === 'delete') {
        const text =
          `${CONTEXT_TOOL}: deleted CGC named context '${name}' from the registry ` +
          '(database files were NOT deleted) using the documented `cgc context delete` verb.'
        return {
          content: [{ type: 'text' as const, text }],
          details: {
            tool: CONTEXT_TOOL,
            ok: true,
            code: result.code,
            verb,
            name,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            argv: result.argv,
          },
        }
      }

      const text =
        `${CONTEXT_TOOL}: set the default CGC named context to '${name}' using the ` +
        'documented `cgc context default` verb.'
      return {
        content: [{ type: 'text' as const, text }],
        details: {
          tool: CONTEXT_TOOL,
          ok: true,
          code: result.code,
          verb,
          name,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          argv: result.argv,
        },
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: applyOutputPolicy(
            cliGapErrorText({
              tool: CONTEXT_TOOL,
              code: failureCode(result),
              message: result.message,
              stderr: result.stderr,
              fallback: 'The cgc command failed; nothing was changed.',
            }),
            { budget: OUTPUT_POLICY_MAX_BYTES, label: CONTEXT_TOOL },
          ),
        },
      ],
      details: {
        tool: CONTEXT_TOOL,
        ok: false,
        code: failureCode(result),
        message: result.message,
        verb,
        name,
        exitCode: result.exitCode,
        argv: result.argv,
        stdoutTail: result.stdout,
        stderrTail: result.stderr,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// cgc_doctor (task 1.4)
// ---------------------------------------------------------------------------

/** Dependencies the doctor executor needs (wired by index.ts). */
export interface DoctorDependencies {
  /** The shared runner every cgc spawn goes through (runner.ts). */
  runner: CgcRunner
}

/**
 * The fixed parameter schema of `cgc_doctor` (design D1: validated fixed
 * arguments only). The documented `cgc doctor` verb takes no arguments, so
 * the schema is empty — extra arguments are refused by schema validation and
 * the executor never passes anything to the binary.
 */
export const DOCTOR_PARAMETERS: TSchema = Type.Object({})

/**
 * Create the `cgc_doctor` executor (task 1.4).
 *
 * Flow: only the session working directory is validated (the documented
 * `cgc doctor` verb takes no arguments) → one read-only `cgc doctor`
 * invocation through the shared runner (argument-array spawn via the
 * commands.ts DOCTOR_ARGS head, session cwd, time budget, abort signal) →
 * the settled report rendered through the output policy (bounded to
 * OUTPUT_POLICY_MAX_BYTES with a truncation marker when oversized). Doctor
 * is non-destructive (design D2), so it runs WITHOUT confirmation and never
 * passes flags — nothing here can mutate state (D3).
 *
 * Invoked by pi as `(toolCallId, params, signal, onUpdate, ctx)` (0.85.1);
 * the session context used for cwd is the 5th argument.
 */
export function createDoctorExecutor(deps: DoctorDependencies): CliGapToolExecutor {
  return async (_toolCallId, _params, signal, _onUpdate, ctx) => {
    const cwd = typeof ctx.cwd === 'string' && ctx.cwd.length > 0 ? ctx.cwd : undefined
    if (cwd === undefined) {
      const text =
        `${DOCTOR_TOOL}: UNAVAILABLE \u2014 the session did not provide a working ` +
        'directory; nothing ran. Restart the session so Pi supplies a working directory.'
      return {
        content: [{ type: 'text' as const, text }],
        details: { tool: DOCTOR_TOOL, code: 'UNAVAILABLE' },
      }
    }

    const argv: string[] = [...DOCTOR_ARGS]
    const options: CgcRunOptions = { args: argv }
    if (signal !== undefined) options.signal = signal
    let result: CgcCommandResult
    try {
      result = await deps.runner.run(cwd, options)
    } catch (error) {
      // The runner only throws on caller contract violations (non-string argv
      // or an empty cwd) — both are excluded above, so this is defensive.
      const detail = error instanceof Error ? error.message : String(error)
      const text = `${DOCTOR_TOOL}: COMMAND_FAILED \u2014 ${detail}; no diagnostics were produced.`
      return {
        content: [{ type: 'text' as const, text }],
        details: { tool: DOCTOR_TOOL, code: 'COMMAND_FAILED', error: detail },
      }
    }

    if (result.ok) {
      // Doctor output can arrive on either stream, so — like the context-list
      // branch and the /cgc doctor renderer — the success surface folds both
      // in: stdout carries the report, stderr any warnings.
      const cliOutput = [result.stdout.trim(), result.stderr.trim()]
        .filter((part) => part.length > 0)
        .join('\n')
      const text = applyOutputPolicy(
        `${DOCTOR_TOOL}: CGC diagnostics \u2014 report from the documented \`cgc doctor\` verb (read-only):\n${cliOutput}`,
        { budget: OUTPUT_POLICY_MAX_BYTES, label: DOCTOR_TOOL },
      )
      return {
        content: [{ type: 'text' as const, text }],
        details: {
          tool: DOCTOR_TOOL,
          ok: true,
          code: result.code,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          argv: result.argv,
        },
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: applyOutputPolicy(
            cliGapErrorText({
              tool: DOCTOR_TOOL,
              code: failureCode(result),
              message: result.message,
              stderr: result.stderr,
              fallback: 'The cgc command failed; no diagnostics were produced.',
            }),
            { budget: OUTPUT_POLICY_MAX_BYTES, label: DOCTOR_TOOL },
          ),
        },
      ],
      details: {
        tool: DOCTOR_TOOL,
        ok: false,
        code: failureCode(result),
        message: result.message,
        exitCode: result.exitCode,
        argv: result.argv,
        stdoutTail: result.stdout,
        stderrTail: result.stderr,
      },
    }
  }
}

/**
 * The three tool definitions; each tool's parameter schema lands with its
 * executor (task 1.2 landed bundle export's; 1.3/1.4 landed the rest).
 */
function buildToolDefinitions(deps: CliGapToolDependencies): CliGapToolDefinition[] {
  return [
    {
      name: BUNDLE_EXPORT_TOOL,
      label: 'CGC bundle export',
      description:
        'Export a .cgc bundle for a repository to an output path using the documented ' +
        '`cgc bundle export` verb. REQUIRED arguments: "repository" (repository path, ' +
        'passed as `--repo`) and "output" (output path for the .cgc bundle file). ' +
        'Confirms the file write first (ADR-0003) and never invokes destructive flags.',
      parameters: BUNDLE_EXPORT_PARAMETERS,
      execute: deps.bundleExport ?? notImplementedExecutor(BUNDLE_EXPORT_TOOL),
    },
    {
      name: CONTEXT_TOOL,
      label: 'CGC named contexts',
      description:
        'List, create, delete, or set the default named context through the documented ' +
        '`cgc context` verbs (set-default maps to the documented `default` verb). ' +
        'Argument "verb" selects the operation; "name" is the context name ' +
        '(create/delete/set-default); create also accepts "database" and "dbPath". ' +
        'Deletion requires confirmation and removal never deletes database files.',
      parameters: CONTEXT_PARAMETERS,
      execute: deps.context ?? notImplementedExecutor(CONTEXT_TOOL),
    },
    {
      name: DOCTOR_TOOL,
      label: 'CGC diagnostics',
      description:
        'Run CGC diagnostics read-only and return bounded, policy-cleaned output ' +
        'from the documented `cgc doctor` verb. Takes no arguments; the invocation ' +
        'is non-destructive and runs without confirmation.',
      parameters: DOCTOR_PARAMETERS,
      execute: deps.doctor ?? notImplementedExecutor(DOCTOR_TOOL),
    },
  ]
}

/**
 * Register the three CLI-gap tools (task 1.1). Callers gate on
 * `config.tools.cliGap.enabled` — when disabled, no CLI-gap tool exists in
 * the tool catalog at all. Fail-open per tool: one broken registration must
 * never break extension load (the remaining tools still register).
 */
export function registerCliGapTools(api: CliGapToolsApi, deps: CliGapToolDependencies = {}): void {
  for (const tool of buildToolDefinitions(deps)) {
    try {
      api.registerTool(tool)
    } catch {
      // Fail-open: skip this tool; later tools still register.
    }
  }
}
