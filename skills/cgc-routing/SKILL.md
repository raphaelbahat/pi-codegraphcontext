---
name: cgc-routing
disable-model-invocation: true
description: >-
  Choose the right CodeGraphContext (CGC) surface for the task at hand: graph
  relationship queries vs built-in search/read, `/cgc` status and indexing
  commands, and the `cgc_*` management tools. Use when working in a
  CGC-indexed workspace, deciding between graph and text search, or running
  CGC indexing, sync, and diagnostic operations.
---

# CGC routing skill (opt-out)

Scope: **CodeGraphContext v0.6.x**. This skill is the deep, default-on companion (opt-out) to
the always-on guideline card; when the two overlap, the card is the compact
statement and this skill is the detail. The content is advisory — it never
blocks or restricts any tool. Graph query tools are registered by the CGC MCP
server, not by this extension.

## Tool-choice by intent

Route by the shape of the question, not by the first plausible tool name.

| Intent | Route | Examples |
| --- | --- | --- |
| Relationships & structure | CGC MCP graph tools | callers, callees, call chains, imports, class hierarchy, impact |
| Code health | CGC MCP graph tools | dead code, cyclomatic complexity, most-complex functions |
| Exact strings & known files | Built-in search / file read | literal text, a regex, a file you can already name |
| Workspace status & freshness | `/cgc status` | is this workspace indexed, stale, or busy? |
| Index lifecycle | `/cgc index`, `/cgc sync` | create a missing index, rebuild, reconcile drift |
| Diagnostics & reports | `/cgc doctor`, `/cgc report` | connections fail; write the quality report |
| Bundle / context management | `cgc_bundle_export`, `cgc_context`, `cgc_doctor` | export a bundle, switch/name a context |

### Relationship-shaped questions

Callers, callees, call chains, impact, dead code, and complexity are graph
questions: ask the CGC MCP server directly rather than reconstructing them by
reading files one at a time. Typical MCP tools (names appear under whatever
namespace your MCP config assigns, e.g. a `codegraphcontext` server):

- `analyze_code_relationships` — callers, callees, imports, hierarchy.
- `find_dead_code` — potentially unused functions.
- `calculate_cyclomatic_complexity` / `find_most_complex_functions`.
- `find_code` — keyword symbol search over the index.

If the MCP server is not configured or the workspace is not ready (see
Indexing basics), fall back to built-in search and say the graph was
unavailable; do not fabricate graph results.

### Exact-string work stays with built-in tools

Literal strings, regexes, and reading a file you already can name are best done
with the harness's built-in search and file reading. Graph queries are not
required for them and may be slower or lossier. This skill does not steer that
work away from built-in tools.

## Backend fuzzy-search caveats

`find_code`'s `fuzzy_search` behaves differently per backend:

- **Kùzu / FalkorDB**: matching is typo-tolerant (edit distance). Use the
  `edit_distance` argument to widen or tighten it; a query with the wrong
  letters can still return hits, so review matches rather than trusting rank.
- **Neo4j**: fuzzy search uses Lucene-style full-text terms. Tokenization and
  stemming apply, so an exact substring may not rank first.
- **Casing**: preserve the original casing of camelCase / PascalCase symbols
  when fuzziness matters — lowercasing a symbol can change which tokens match.

When fuzzy results look surprising, re-run `find_code` with
`fuzzy_search: false` to get an exact-match baseline before concluding the
symbol is missing.

## Path sandbox (`CGC_ALLOWED_ROOTS`)

CGC's indexing, bundle-load, watch, context-switch, report, and context-discovery
operations only accept paths under:

1. the MCP server process's **current working directory**, and
2. any extra roots listed in the `CGC_ALLOWED_ROOTS` environment variable.

`CGC_ALLOWED_ROOTS` is a path list separated by `:` on Linux/macOS and `;` on
Windows:

```bash
export CGC_ALLOWED_ROOTS="/home/me/projects:/data/repos"
cgc mcp   # or configure mcp.json with the same env
```

Without the variable, sibling directories outside the server cwd are rejected
for security. The extension enforces the same sandbox for its own tools: the
runner spawns `cgc` in the session working directory, so that directory counts
as an allowed root, and paths outside every allowed root are refused before
`cgc` runs (the CGC "outside the allowed roots" / "not inside any allowed root"
rejection is surfaced with a "use a path inside an allowed root" hint). To
operate on another tree, add it to `CGC_ALLOWED_ROOTS` rather than trying to
escape the sandbox.

## Indexing basics

CGC indexes a repo into a graph database. Choose the backend once and keep the
CLI and the MCP server on the **same configuration**, or they will see
different graphs.

- **Install**: `pip install codegraphcontext` (or `pipx install codegraphcontext`).
  With `uv`, `uv tool install codegraphcontext` or `uvx codegraphcontext …`
  works; if a parser fails with `ModuleNotFoundError: tree_sitter_c_sharp`,
  install the parser as an explicit extra (e.g.
  `uvx --with tree-sitter-c-sharp codegraphcontext …`).
- **Configure**: optional `~/.codegraphcontext/.env` for `DEFAULT_DATABASE`, a
  Neo4j URI, or a Kùzu path. The bundled backend is the default.
- **Index from the repo root**: `cgc index .`; `cgc index --force .` rebuilds.
- **Doctor**: run `cgc doctor` when connections or parses fail.
- **MCP wiring**: run `cgc mcp setup` and pick the editor, or add a stdio server
  entry that runs `cgc` with arguments `mcp` `start` and the same environment as
  the CLI.

The extension wraps this lifecycle:

- `/cgc status` reports the active workspace, lifecycle state, last action, and
  running work (read-only).
- `/cgc index` creates a missing index, or force-rebuilds the existing one —
  a rebuild requires explicit confirmation.
- Automatic index creation is **off by default**
  (`lifecycle.autoCreate`, env `CGC_LIFECYCLE_AUTO_CREATE`); enable it only if
  you want the extension to create a missing index without asking.
- `/cgc sync` triggers an incremental drift sync. At session start the
  extension reconciles graph↔disk drift when an index already exists
  (`lifecycle.syncOnStart`, default on); `freshness.autoSync` (default on) runs
  capped short-lived incremental syncs on first drift.
- Lifecycle states `clean` / `drift` / `syncing` / `indexing` / `rebuilding`
  are treated as ready for graph queries; `unavailable` / `unindexed` / `busy`
  / `corrupt` suppress guidance and graph routing until resolved. Use
  `/cgc doctor` to diagnose `unavailable` and `corrupt`.

## Configuration reference

The extension resolves settings from an optional global `~/.pi/agent/cgc.json`,
then a project `.pi/cgc.json` (project wins), then `CGC_*` environment
overrides. Relevant keys and their defaults:

| Key | Default | Environment override |
| --- | --- | --- |
| `guidance.routingSkill` | `false` | `CGC_GUIDANCE_ROUTING_SKILL` |
| `lifecycle.autoCreate` | `false` | `CGC_LIFECYCLE_AUTO_CREATE` |
| `lifecycle.syncOnStart` | `true` | `CGC_LIFECYCLE_SYNC_ON_START` |
| `freshness.autoSync` | `true` | `CGC_FRESHNESS_AUTO_SYNC` |
| `tools.cliGap.enabled` | `true` | `CGC_TOOLS_CLI_GAP_ENABLED` |

This skill is on by default; opt out with `guidance.routingSkill: false`; the always-on guideline card
has no off switch of its own — disabling the extension is the only way to
remove it.

## Deep dive

This skill is the compact routing layer. For the full intent-first reference —
the complete routing table, the configuration/consent overview, backend
caveats, and troubleshooting — continue to the [CGC agent guide](https://raw.githubusercontent.com/raphaelbahat/pi-codegraphcontext/refs/heads/main/docs/agent-guide.md)
(raw Markdown; `docs/agent-guide.md` in this repository). Link out to it rather than copying
its content into the skill.
