## Why

CodeGraphContext's MCP server serves the agent, but the human has no in-session surface: index and sync jobs run invisibly, and checking health or generating a quality report means leaving the session to type `cgc` commands in a shell. This change adds the extension's human-facing slash commands to `pi-codegraphcontext`, converting the lifecycle state produced by the bedrock changes into visible, direct control.

## What Changes

- `/cgc status` — show the active workspace, lifecycle state (clean/drift/syncing/indexing/busy/corrupt/unindexed/unavailable), last action, and freshness summary; read-only, always available.
- `/cgc index` — create or (with confirmation) force-rebuild the index for the active workspace, honoring the consent gates defined by `add-cgc-session-lifecycle-gate` (auto-create consent; explicit confirmation for destructive rebuilds).
- `/cgc sync` — trigger a drift sync of the current workspace immediately (same incremental indexing semantics as the session-start gate).
- `/cgc doctor` — run `cgc doctor` and render its bounded output in the session.
- `/cgc report` — run `cgc report` to generate the markdown quality report, asking for confirmation before writing the report file (`CGC_REPORT.md` per CGC docs; exact destination confirmed in-session, since the docs do not state the write location).
- Commands are human-facing conveniences built on the shared `cgc` runner; they register no graph query tools and duplicate no MCP tool surface.
- Deferred decision (recorded, not implemented): thin agent-facing convenience tools derived from these commands (e.g., impact-before-edit, blast-radius) — future consideration, to avoid duplicating the CGC MCP server's `analyze_code_relationships` surface.

## Capabilities

### New Capabilities

- `cgc-slash-commands`: human-facing `/cgc` command surface — status visibility and consent-guarded index/sync/doctor/report actions driven by the shared `cgc` runner and lifecycle state.

### Modified Capabilities

(none — no existing capabilities; `openspec/specs/` is empty)

## Impact

- Extension package `pi-codegraphcontext`; registers commands through Pi's documented command-registration API.
- Depends on lifecycle state (`add-cgc-session-lifecycle-gate`) and, for freshness display, on `add-cgc-freshness-drift-sync` when present (degrades gracefully to lifecycle-only status).
- Spawns `cgc` via the shared runner (arg-array, cwd from session context, timeouts, abort signals, bounded output).
- Consent/destructive-operation guards: rebuild (`--force`) and report file-writing require explicit confirmation; no command deletes data (`ALLOW_DB_DELETION`-gated verbs are never exposed).
- No changes to CodeGraphContext, the MCP server, or MCP tool schemas.
