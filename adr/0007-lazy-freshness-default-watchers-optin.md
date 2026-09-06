# ADR-0007: Freshness defaults to lazy budgeted re-index; long-lived CGC watchers are opt-in

## Status

Proposed

## Date

2026-09-06

## Context

Keeping the code graph fresh during a session requires reconciling graph↔disk drift as edits happen. CodeGraphContext offers two mechanisms: short-lived incremental indexes (`cgc index` is incremental by default) and a continuous watchdog-based watcher (`cgc watch`) that holds the embedded graph database open for its entire lifetime. The embedded backends are single-process: whatever holds the lock excludes every other CGC process — including the user's own CGC MCP server, which in the dominant real-world setup is answering the agent's graph queries continuously. The extension's lifecycle gate already commits to skip-as-busy rather than fight locks (ADR-0001), and the freshness capability must not become the process that starves the user's own tooling.

## Decision

Freshness drift is observed from the session's own edit events (no filesystem watching, no hashing, no detection spawns) and reconciled by default with lazy, budgeted re-indexing: at most a small per-session number of short-lived incremental indexes, deduplicated through the shared runner, skip-as-busy on lock conflicts. The continuous `cgc watch` mode is supported but strictly opt-in (default off) for users who accept that its lifetime lock excludes their other CGC processes; when enabled, it runs as a managed child terminated through all session cleanup paths. Staleness remains advisory — a visible state plus once-per-condition human notices — and never blocks the agent loop or injects into agent context.

## Consequences

- Positive: in the default configuration the extension never holds the embedded-database lock for more than a brief sync window, so the user's CGC MCP server stays available — freshness never competes with the queries it exists to improve.
- Positive: drift detection costs nothing (session events), and the sync budget bounds worst-case spawn churn on editing-heavy sessions.
- Positive: the advisory staleness model is honest by construction (never fresh after observed edits until a sync completes) without pretending to per-file precision.
- Negative: freshness is eventually-consistent by default — after the sync budget is spent, drift remains visible but un-synced until the user runs `/cgc sync` or the next session starts (the gate's start-time sync catches it).
- Negative: session-event observation cannot see edits made outside the session; that gap is documented and covered by the next session-start reconciliation.
- Negative: users who enable watcher mode accept the lock trade-off explicitly; the extension does not arbitrate between the watcher and other CGC processes beyond skip-as-busy notices.
- Follow-up: any future feature that wants long-lived lock-holding processes (for example, a bundled watcher service) must supersede this ADR with an explicit lock-arbitration design.
