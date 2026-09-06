## Why

CodeGraphContext's MCP server exposes the full graph query surface, but nothing keeps the index alive across sessions: an unindexed workspace makes every graph tool return empty or failed results, graph↔disk drift goes unnoticed, and blind CLI calls can hard-lock against the single-process embedded backends. This change adds the bedrock of the planned `pi-codegraphcontext` extension: a session-start lifecycle gate that makes the index exist, fresh, and healthy without the user or the agent having to think about it.

## What Changes

- New Pi extension foundation, package name `pi-codegraphcontext` (TypeScript, Pi extension APIs), which wraps the `cgc` binary only — it never modifies CodeGraphContext source, and the CGC MCP server remains the graph query engine (zero re-wrapped query tools).
- Session-start lifecycle gate: on `session_start`, resolve the workspace from the session context (`ctx.cwd`, never `process.cwd`) and run a non-blocking state machine:
  - `unindexed` → offer/create an index (opt-in via config; never auto-create without consent)
  - `indexed + drift` → sync the graph to disk (incremental re-index of changed files)
  - `corrupt` → offer a full rebuild (explicit confirmation)
  - `lock/busy` → skip as busy with a one-time notice (embedded backends are single-process)
  - `clean` → skip silently
- Fail-open, fire-and-forget semantics: the gate never blocks or slows agent start; in-flight same-project invocations are deduplicated; every `cgc` spawn uses argument-array execution, a time-boxed timeout, and an `AbortSignal`, with cleanup on `session_shutdown` and process exit.
- Lazy initialization: no `cgc` invocation until the gate needs one; version probe is time-boxed and cached.
- Deferred decision (recorded, not implemented): bundling the CGC MCP server with the extension so one install provides both — future consideration.

## Capabilities

### New Capabilities

- `cgc-index-lifecycle`: automatic, safe, observable management of the CGC index for the active workspace across the session lifecycle — detection, opt-in creation, drift sync, busy/lock handling, and teardown cleanup.

### Modified Capabilities

(none — no existing capabilities; `openspec/specs/` is empty)

## Impact

- New extension package in this repo (`pi-codegraphcontext`), using Pi extension hooks (`session_start`, `session_shutdown`) and Pi session context (`ctx.cwd`).
- Spawns the `cgc` binary (must be on `PATH` or explicitly configured); reads CGC on-disk state (`~/.codegraphcontext/`, per-repo `.codegraphcontext/`) only to detect status — it never writes CGC's database files directly.
- Coexists with the CGC MCP server: respects its single-process locks (skip-as-busy) rather than fighting them.
- Downstream changes in this campaign (freshness/drift sync, status HUD, worktree contexts) build on this gate's state machine and runner.
- No changes to the CodeGraphContext project itself; no MCP tool surface changes.
