## Why

A graph that was fresh at session start goes stale the moment the first edit lands, and nothing tells the agent or user that graph answers are now aging. Change 1 reconciled drift at session start only; this change — the second bedrock of `pi-codegraphcontext` — keeps the freshness story honest for the whole session: drift is observed as edits happen, the graph is re-synced conservatively, and staleness is always visible rather than silent.

## What Changes

- Freshness state for the active workspace: tracks the last successful sync time and a conservative dirty condition, exposed to the status display (`add-cgc-status-hud`) and `/cgc status` (`add-cgc-slash-commands`).
- Drift observation without new `cgc` probing: the extension observes the session's own edit activity (documented Pi events) and marks the workspace dirty conservatively — any observed edit makes freshness "possibly stale"; no filesystem hashing, no polling, no extra spawns for detection.
- Lazy drift sync: on first drift detection per session (and again only within an explicit per-session budget), the extension runs one incremental `cgc index .` through the shared runner — a short-lived spawn, deduplicated with any in-flight sync, skip-as-busy on lock conflicts.
- Continuous watcher mode is opt-in, not default: `cgc watch` holds the embedded database for its lifetime and would lock out the user's own MCP server; the default posture is lazy re-index, with `freshness.watch` (default false) enabling the managed watcher for users who accept the lock trade-off.
- One-time staleness notices per condition per session (human-facing, via the session notice surface): stale-after-edits, sync-skipped-busy, sync-completed. Never per-turn; never in the agent's prompt — agent-facing injection is the proactive-injection change's opt-in contract.
- Config keys: `freshness.watch` (default false), `freshness.autoSync` (default true — the lazy first-drift sync), `freshness.maxSyncsPerSession` (default 2) — each with environment-variable overrides.
- Deferred decision (recorded, not implemented): per-turn drift steers and query-result annotations are agent-intrusive surfaces owned by `add-cgc-proactive-context-injection` under its opt-in contract; this change delivers the state they would consume, none of the injection.

## Capabilities

### New Capabilities

- `cgc-freshness-sync`: session-long freshness tracking for the active workspace — conservative drift observation, budgeted lazy re-sync, opt-in continuous watcher, staleness notices, and freshness state for other surfaces.

### Modified Capabilities

(none — no existing capabilities; `openspec/specs/` is empty)

## Impact

- Extension package `pi-codegraphcontext`; subscribes to Pi session events for edit observation; spawns `cgc` only through the shared runner (incremental index or the opt-in watcher).
- Consumed by the status display and slash commands (freshness section/summary render only when this capability is present — their specified degradation paths).
- Respects the single-process reality: watcher mode and syncs are skip-as-busy with notices, never lock-fighting; syncs cannot run concurrently (runner dedup).
- No changes to CodeGraphContext or the MCP server; no agent-context content produced by this change.
