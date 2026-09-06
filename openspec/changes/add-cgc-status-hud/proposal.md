## Why

The lifecycle gate and freshness work do real things invisibly: indexes get created, syncs run, locks cause skips. A user watching the session cannot tell whether the graph is ready, stale, busy, or absent — invisible background health is indistinguishable from a broken extension. This change adds the extension's persistent status display and one-time warnings to `pi-codegraphcontext`, converting background state into visible, trustworthy signal.

## What Changes

- Persistent one-line CGC status chip in the Pi TUI (footer/status area): lifecycle state at a glance (ready / unindexed / busy / corrupt / unavailable), activity states while work runs (indexing…, syncing…), styled to be glanceable and quiet.
- One-time warnings per session, surfaced as notices (never repeated): `cgc` binary missing; workspace unindexed (with guidance on enabling auto-create); embedded-database lock conflict (busy); corrupt index detected (with the rebuild path pointer).
- Strictly passive, fail-open rendering: the display derives entirely from lifecycle (and, when present, freshness) state; it never spawns `cgc` on its own, never polls in a loop, never blocks or errors the session, and is a no-op in headless/non-TUI mode.
- Human-facing only: the display adds nothing to the agent's context (agent-facing guidance is `add-cgc-agent-routing-guidance`; proactive notes are `add-cgc-proactive-context-injection`).

## Capabilities

### New Capabilities

- `cgc-status-display`: persistent, passive TUI status rendering of CGC lifecycle (and optional freshness) state, plus per-session one-time warnings, with fail-open and headless-safe behavior.

### Modified Capabilities

(none — no existing capabilities; `openspec/specs/` is empty)

## Impact

- Extension package `pi-codegraphcontext`; renders through Pi's TUI status/footer extension surface (exact API pinned from installed Pi docs during implementation, validated at the validate phase).
- Consumes lifecycle state (`add-cgc-session-lifecycle-gate`) and freshness state (`add-cgc-freshness-drift-sync`, optional — degrades to lifecycle-only display).
- No new `cgc` invocations, no MCP changes, no agent-context changes; detail fields (e.g., backend name) render only when already captured by existing probes.
