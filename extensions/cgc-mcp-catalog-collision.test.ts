// Task 2.1 (add-cgc-cli-gap-tools): the D5 CI collision guard. The three
// CLI-gap tools exist only because the CGC MCP catalog has a gap; the day a
// future CGC MCP release grows an equivalent tool, that extension tool is
// retired in favor of the MCP one (D5). This test makes the retirement
// decision mechanical: it asserts, against the stored catalog snapshot in
// fixtures/cgc-mcp-catalog.json, that (a) no extension tool name matches or
// shadows a documented MCP catalog tool name and (b) no extension tool
// duplicates an MCP tool's behavior — and (c) that the snapshot itself is
// refreshed deliberately (well-formed provenance instead of silent ad-hoc
// edits), so CI drift on the stored catalog is caught at CI time.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  BUNDLE_EXPORT_TOOL,
  BUNDLE_EXPORT_VERB_ARGS,
  CLI_GAP_TOOL_NAMES,
  CONTEXT_TOOL,
  CONTEXT_VERBS,
  DOCTOR_TOOL,
} from './cli-gap-tools'
import { DOCTOR_ARGS } from './commands'

interface CatalogToolEntry {
  name: string
  behavior: string
}

interface CatalogProvenance {
  capturedAt: string
  source: string
  catalogVersion: string
  refresh: string
}

interface CatalogSnapshot {
  catalog: string
  provenance: CatalogProvenance
  tools: CatalogToolEntry[]
}

/** The single stored D5 catalog snapshot the collision guard asserts against. */
const SNAPSHOT_URL = './fixtures/cgc-mcp-catalog.json'
/** Catalog tool names are lowercase snake_case by convention. */
const SNAKE_CASE_NAME = /^[a-z0-9_]+$/
/** The documented CLI-gap surface lives in the cgc_ namespace (D1). */
const CGC_NAMESPACE = /^cgc_[a-z0-9_]+$/
/**
 * Pinned size of the stored snapshot. This pin is the deliberate-refresh
 * tripwire: growing the snapshot (or the catalog it mirrors) fails CI until
 * someone consciously updates the fixture and re-pins — exactly the drift
 * signal D5 wants surfaced at CI time.
 */
const SNAPSHOT_TOOL_COUNT = 29

function loadSnapshot(): CatalogSnapshot {
  return JSON.parse(readFileSync(new URL(SNAPSHOT_URL, import.meta.url), 'utf8')) as CatalogSnapshot
}

/**
 * The extension side of the D5 behavior guard: the fixed, documented
 * capability phrases of the three CLI-gap tools (design D1). Phrases are
 * derived from the same argv/verb constants the executors invoke, so a tool
 * that joins the surface extends this list consciously. Multi-word phrases
 * only — single words such as "context" are intentionally absent, because
 * the MCP catalog legitimately uses them in unrelated capacities
 * (switch_context flips the active graph; it does not manage named
 * contexts).
 */
function extensionCapabilityPhrases(): string[] {
  const contextPhrases = CONTEXT_VERBS.map((verb) =>
    verb === 'set-default' ? verb : `context ${verb}`,
  )
  return [
    BUNDLE_EXPORT_VERB_ARGS.join(' '),
    'named context',
    ...contextPhrases,
    'read-only diagnostics',
    DOCTOR_ARGS.join(' '),
  ]
}

describe('D5 catalog snapshot (fixtures/cgc-mcp-catalog.json)', () => {
  it('is refreshed deliberately: provenance documents the capture and refresh procedure', () => {
    const snapshot = loadSnapshot()
    expect(snapshot.catalog).toBe('codegraphcontext-mcp')

    const { provenance } = snapshot
    expect(typeof provenance.capturedAt).toBe('string')
    const capturedAt = Date.parse(provenance.capturedAt)
    expect(Number.isNaN(capturedAt)).toBe(false)
    // A future-dated capture is impossible for a real refresh.
    expect(capturedAt).toBeLessThanOrEqual(Date.now())
    expect(typeof provenance.source).toBe('string')
    expect(provenance.source.length).toBeGreaterThan(0)
    expect(typeof provenance.catalogVersion).toBe('string')
    expect(provenance.catalogVersion.length).toBeGreaterThan(0)
    // The refresh procedure must name the deliberate act (regenerating from
    // the live catalog and re-stamping the capture date), so a silent ad-hoc
    // edit cannot masquerade as a refresh.
    expect(typeof provenance.refresh).toBe('string')
    expect(provenance.refresh).toContain('regenerate')
    expect(provenance.refresh).toContain('capturedAt')
  })

  it('tool entries are unique, sorted, snake_case, and free of the cgc_ namespace', () => {
    const snapshot = loadSnapshot()
    expect(snapshot.tools).toHaveLength(SNAPSHOT_TOOL_COUNT)

    const names = snapshot.tools.map((tool) => tool.name)
    expect(names).toEqual([...names].sort())
    expect(new Set(names).size).toBe(names.length)
    for (const tool of snapshot.tools) {
      expect(tool.name).toMatch(SNAKE_CASE_NAME)
      expect(tool.name).not.toContain('cgc')
      expect(typeof tool.behavior).toBe('string')
      expect(tool.behavior.length).toBeGreaterThan(0)
    }
  })
})

describe('D5 collision guard — extension vs MCP tool names', () => {
  it('every CLI-gap tool name lives in the cgc_ namespaced surface (exact registration consts)', () => {
    expect(CLI_GAP_TOOL_NAMES).toEqual([BUNDLE_EXPORT_TOOL, CONTEXT_TOOL, DOCTOR_TOOL])
    expect(CLI_GAP_TOOL_NAMES.length).toBeGreaterThan(0)
    for (const name of CLI_GAP_TOOL_NAMES) {
      expect(name).toMatch(CGC_NAMESPACE)
    }
  })

  it('no catalog tool name matches an extension tool name', () => {
    const snapshot = loadSnapshot()
    const catalogNames = new Set(snapshot.tools.map((tool) => tool.name))
    for (const name of CLI_GAP_TOOL_NAMES) {
      expect(catalogNames.has(name)).toBe(false)
    }
  })

  it('no catalog tool name shadows the cgc_ namespace', () => {
    const snapshot = loadSnapshot()
    for (const tool of snapshot.tools) {
      expect(tool.name.startsWith('cgc_')).toBe(false)
    }
  })
})

describe('D5 collision guard — extension vs MCP tool behavior', () => {
  it('no catalog behavior covers a documented CLI-gap capability phrase', () => {
    const snapshot = loadSnapshot()
    const capabilities = extensionCapabilityPhrases()
    expect(capabilities).not.toHaveLength(0)
    for (const phrase of capabilities) {
      const phraseLower = phrase.toLowerCase()
      const duplicatingNames = snapshot.tools
        .filter((tool) => tool.behavior.toLowerCase().includes(phraseLower))
        .map((tool) => tool.name)
      expect(duplicatingNames).toEqual([])
    }
  })
})
