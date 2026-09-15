// Task 2.1 (add-cgc-agent-guide): the accuracy coupling that fails CI the day
// `docs/agent-guide.md` names a surface the implementation no longer has. The
// test extracts every *extension* surface the guide names — `/cgc` commands,
// CLI-gap tool names, config keys, and `CGC_*` env overrides — and asserts each
// resolves to the corresponding registry (`CGC_SUBCOMMANDS`,
// `CLI_GAP_TOOL_NAMES`, `CONFIG_ENV_VARS`/`ConfigKey`/`DEFAULT_CONFIG`), and
// that no registered surface is left undocumented.
//
// Scope note: only surfaces this extension registers are asserted. Graph
// relationship tools (`analyze_code_relationships`, `find_dead_code`,
// `calculate_cyclomatic_complexity`, `find_most_complex_functions`,
// `find_code`) are registered by the CGC MCP server, not by this extension, so
// the guide names them but this test deliberately does not resolve them.
//
// The test lives under `extensions/` so the existing `bun test` step in
// `.github/workflows/ci.yml` runs it; no CI wiring change is required.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { CLI_GAP_TOOL_NAMES } from './cli-gap-tools'
import { CGC_SUBCOMMANDS } from './commands'
import { CONFIG_ENV_VARS, DEFAULT_CONFIG } from './config'

const GUIDE = readFileSync(new URL('../docs/agent-guide.md', import.meta.url), 'utf8')
const SKILL = readFileSync(new URL('../skills/cgc-routing/SKILL.md', import.meta.url), 'utf8')

/** Every config key the implementation understands (the `ConfigKey` union). */
const CONFIG_KEYS: readonly string[] = Object.keys(CONFIG_ENV_VARS)
/** Every `/cgc` verb the implementation registers. */
const COMMAND_VERBS: readonly string[] = CGC_SUBCOMMANDS.map((spec) => spec.verb)

/**
 * `CGC_*` names the guide legitimately mentions that are not extension config
 * overrides: two are CGC-side contract variables, and `CGC_REPORT` is the
 * filename stem of the `CGC_REPORT.md` report path. Everything else must map to
 * a configured override.
 */
const NON_CONFIG_ENV_TOKENS: readonly string[] = [
  'CGC_ALLOWED_ROOTS',
  'CGC_OUTPUT_FORMAT',
  'CGC_REPORT',
]

/** The routing scope phrase both artifacts must agree on. */
const SCOPE_RE = /CodeGraphContext v(\d+\.\d+\.x)/

/** A row of the guide's configuration table. */
interface GuideConfigRow {
  key: string
  defaultCell: string
  envCell: string
}

/**
 * The configuration-table row shape: a dotted `key` backticked in the first
 * column, a backticked default, and an uppercase env override in the third. The
 * dot requirement keeps unrelated tables (lifecycle states, consent actions)
 * out.
 */
const CONFIG_ROW_RE =
  /^\|\s*`([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)`\s*\|\s*`([^`]*)`\s*\|\s*`([A-Z0-9_]+)`\s*\|/gm

/** A config key token as it would appear fully formed inside backticks. */
const CONFIG_KEY_RE = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/

function matchValues(text: string, re: RegExp, group: number): string[] {
  const values: string[] = []
  for (const match of text.matchAll(re)) {
    const value = match[group]
    if (value !== undefined) values.push(value)
  }
  return values
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** `/cgc <verb>` mentions across the given text. */
function slashCommandVerbs(text: string): string[] {
  return unique(matchValues(text, /\/cgc\s+([a-z][a-z0-9-]*)/g, 1))
}

/** `cgc_*` tool mentions (the underscored extension namespace). */
function cliGapToolMentions(text: string): string[] {
  return unique(matchValues(text, /\b(cgc_[a-z_]+)\b/g, 1))
}

/** Fully-formed dotted config keys quoted in the given text. */
function backtickedConfigKeys(text: string): string[] {
  return unique(matchValues(text, /`([^`]+)`/g, 1).filter((span) => CONFIG_KEY_RE.test(span)))
}

function configRows(text: string): GuideConfigRow[] {
  const rows: GuideConfigRow[] = []
  for (const match of text.matchAll(CONFIG_ROW_RE)) {
    const [, key, defaultCell, envCell] = match
    if (key !== undefined && defaultCell !== undefined && envCell !== undefined) {
      rows.push({ key, defaultCell, envCell })
    }
  }
  return rows
}

/** Resolve a dotted config key against `DEFAULT_CONFIG`. */
function resolveDefault(key: string): unknown {
  let node: unknown = DEFAULT_CONFIG
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

function renderDefault(value: unknown): string {
  return typeof value === 'string' ? value : String(value)
}

function lookupEnv(key: string): string | undefined {
  return (CONFIG_ENV_VARS as Record<string, string>)[key]
}

/** The `## <heading>` body, up to the next level-2 heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading)
  if (start < 0) return ''
  const rest = text.slice(start + heading.length)
  const next = rest.indexOf('\n## ')
  return next < 0 ? rest : rest.slice(0, next)
}

describe('agent guide accuracy — extension surface registries', () => {
  it('names exactly the registered `/cgc` subcommands', () => {
    const verbs = slashCommandVerbs(GUIDE)
    expect(verbs.length).toBeGreaterThan(0)
    expect([...verbs].sort()).toEqual([...COMMAND_VERBS].sort())
  })

  it('names exactly the registered CLI-gap tools', () => {
    const tools = cliGapToolMentions(GUIDE)
    expect(tools.length).toBeGreaterThan(0)
    expect([...tools].sort()).toEqual([...CLI_GAP_TOOL_NAMES].sort())
  })

  it('documents exactly the `ConfigKey` union, with the registry default and env override per key', () => {
    const rows = configRows(GUIDE)
    expect(rows.map((row) => row.key).sort()).toEqual([...CONFIG_KEYS].sort())
    for (const row of rows) {
      expect(lookupEnv(row.key)).toBe(row.envCell)
      expect(renderDefault(resolveDefault(row.key))).toBe(row.defaultCell)
    }
  })

  it('uses only configured overrides (or documented CGC-side variables) for every `CGC_*` token', () => {
    const tokens = unique(matchValues(GUIDE, /\b(CGC_[A-Z0-9_]+)\b/g, 1))
    const known = new Set([...Object.values(CONFIG_ENV_VARS), ...NON_CONFIG_ENV_TOKENS])
    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) {
      expect(known.has(token)).toBe(true)
    }
  })
})

describe('agent guide accuracy — worked example and scope line', () => {
  it('uses only implemented surfaces in the worked example session', () => {
    const example = section(GUIDE, '## Worked example session')
    expect(example.length).toBeGreaterThan(0)

    const verbs = slashCommandVerbs(example)
    const tools = cliGapToolMentions(example)
    const keys = backtickedConfigKeys(example)
    // The example must actually exercise surfaces, so the membership checks below
    // are not vacuous.
    expect(verbs.length).toBeGreaterThan(0)
    expect(tools.length).toBeGreaterThan(0)
    expect(keys.length).toBeGreaterThan(0)

    for (const verb of verbs) expect(COMMAND_VERBS).toContain(verb)
    for (const tool of tools) expect(CLI_GAP_TOOL_NAMES).toContain(tool)
    for (const key of keys) expect(CONFIG_KEYS).toContain(key)
  })

  it('carries the same supported-CGC-version scope line as the routing skill', () => {
    const guideScope = GUIDE.match(SCOPE_RE)
    const skillScope = SKILL.match(SCOPE_RE)
    expect(guideScope).not.toBeNull()
    expect(skillScope).not.toBeNull()
    expect(guideScope?.[1]).toBe(skillScope?.[1])
  })
})
