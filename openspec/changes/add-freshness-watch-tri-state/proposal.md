## Why

The watcher-defaults research (source-verified lock semantics plus empirical lock probes) established the facts ADR-0007 generalized from: the exclusive process-scoped lock that a running `cgc watch` holds is an **embedded-backend** property only (Kùzu-family backends) — on server backends (Neo4j, falkordb-remote) the watcher, the CGC MCP server, and index runs were all probed coexisting with exit-0. A blanket default-ON is still wrong for three backend-independent reasons: the watcher's "fresh" claim is unverifiable (the extension records fresh at spawn with no liveness check — a watcher that dies within milliseconds has already silenced per CGC's own watcher state-clearing behavior, and the stale "fresh" claim persists), it is an unrequested ~108 MB resident daemon, and on an unindexed workspace `cgc watch .` performs a full initial scan that bypasses the `lifecycle.autoCreate: false` consent model. Today's boolean `freshness.watch` cannot express any of this: it is either a global opt-in with an unverifiable fresh claim, or off.

## What Changes

- `freshness.watch` becomes a tri-state key — `off` (new default, byte-compatible with today's `false`), `on` (byte-compatible with today's `true`), and `auto`:
  - `off`: no watcher is ever spawned.
  - `on`: the managed watcher spawns unconditionally on every backend (the user accepts the trade-offs).
  - `auto`: the gated backend-aware default — the watcher spawns ONLY when ALL of: (a) the detected backend is a SERVER backend (Neo4j / falkordb-remote — never kuzu / falkordb local), (b) the workspace is already indexed (never spawns on an unindexed workspace — the consent model stays intact), (c) the watcher's liveness is verified before the fresh claim is recorded.
- New config key `freshness.watcherLivenessMs` (default 15000): the liveness-verification budget. After spawning the watcher, the extension verifies it is alive and watching (process alive past a bounded stabilization probe) before recording the freshness state; a dead or failed watcher records the honest not-verified state (advisory stale + recorded error) plus a one-time notice — never a false "fresh".
- New backend-detection helper (the extension has no backend probe today): a small bounded detection that parses `cgc doctor`'s "Default database:" line (preferred, it resolves CGC's full precedence chain) with an explicit-environment and `~/.codegraphcontext/.env` read as fallback, failing open to the conservative embedded answer (`kuzu` — auto never spawns when the backend is unknown).
- Boolean compatibility: `true`/`false` in existing config files and environment variables keep their meaning (mapped to `on`/`off`); the migration is additive and `auto` never silently applies to an existing boolean configuration — only explicit `auto` text enables the gated mode.
- One-time watcher notices: a watcher-start confirmation after verified liveness, and one-time informational notices when `auto` declines to spawn (embedded backend, or unindexed workspace), so the conservative default is observable rather than silent.
- Docs: README config table rows and the agent-guide configuration rows updated for the tri-state key and the new liveness key (accuracy tests cover both).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `cgc-freshness-sync`: the watcher requirement's new shape — the tri-state `freshness.watch` gating (off / on / auto with backend-awareness, indexed-workspace consent, and liveness verification), the `freshness.watcherLivenessMs` budget, the honest not-verified degradation, the backend detection helper's contract, the boolean compatibility mapping, and the new one-time notices.

## Impact

- `extensions/config.ts`: `FreshnessConfig.watch` type widens to the tri-state literal union, the new `watcherLivenessMs` key and its validation, the boolean-compat parsing (file and environment layers).
- `extensions/freshness.ts`: the observer's spawn gating (the auto condition evaluation), the liveness verification replacing the spawn-time fresh record, the backend detection helper, the new notices.
- `extensions/index.ts`: wiring the tri-state config value, the liveness budget, and the production backend detector.
- `extensions/settings-modal.ts`: the `freshness.watch` row becomes the enum kind (off / on / auto) — the modal's key-kind registry requires it.
- Tests: config validation (off/on/auto/true/false/invalid), observer gating and liveness scenarios, settings-modal and docs accuracy tests.
- Docs: README configuration table, docs/agent-guide.md configuration rows.
