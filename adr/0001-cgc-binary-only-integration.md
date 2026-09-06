# ADR-0001: Integrate with CodeGraphContext exclusively via the cgc binary behind a fail-open lifecycle gate

## Status

Proposed

## Date

2026-09-06

## Context

The `pi-codegraphcontext` extension must keep CodeGraphContext (CGC) indexes usable for Pi sessions. CGC's MCP server already provides the graph query surface (25 tools), assumes an index exists, and shares embedded single-process graph backends (FalkorDB Lite / KuzuDB) with any other `cgc` process. CGC's own troubleshooting documentation treats backend lock errors as expected multi-process behavior, not bugs. The extension is TypeScript; CGC is Python. The project rule is that the extension wraps the `cgc` binary and never modifies CodeGraphContext source. Reference-extension research (multiple independent Pi code-graph extensions and forks) shows recurring integration failures: resolving the wrong working directory (`process.cwd()` instead of the session's), orphaned subprocesses holding locks, eager startup slowing sessions, and guidance injected before tools or indexes are ready.

## Decision

The extension integrates with CGC exclusively by spawning the `cgc` binary through a single sandboxed command runner — argument-array invocation (never shell strings) with the session's working directory, per-command time budgets, abort signals, bounded output capture, and per-workspace in-flight deduplication. A fail-open, fire-and-forget lifecycle gate runs at session start and classifies the workspace into five states (unavailable, unindexed, busy, corrupt, clean/drift): unindexed workspaces are created only with explicit opt-in, drift is synced automatically at start time, corrupt indexes require explicit rebuild consent, and lock/busy conflicts are skipped with a one-time notice — never forced, retried in a loop, or resolved by deleting locks. The extension registers no graph query tools; the CGC MCP server remains the query engine.

## Consequences

- Positive: every later extension capability (freshness sync, status surfaces, worktree contexts, CLI-gap tools) builds on one runner and one state machine instead of re-solving process management.
- Positive: safe coexistence with the user's CGC MCP server and watchers — the extension is a well-behaved tenant of single-process backends by construction.
- Positive: CGC version tolerance — the extension depends on CLI verbs and exit codes, not on CGC internals or database schemas, satisfying the no-source-modification rule.
- Negative: CLI output is a versioned-but-informal contract; output-format drift must be absorbed by coarse parsing and a supported-version range, and unparseable output must fail safe.
- Negative: skip-as-busy can leave a stale graph for the remainder of a session when another CGC process holds the backend; visibility of that state is delegated to the status-surface changes.
- Negative: no access to CGC's Python APIs means some checks (e.g., precise lock ownership) are approximated rather than exact.
- Follow-up: runtime (post-edit) freshness tracking and staleness notices are deliberately out of scope here and are specified by a separate change.
