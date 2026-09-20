# ADR-0010: Freshness watcher policy is a backend-aware tri-state with verified liveness

## Status

Proposed — supersedes the rationale (not the mechanics) of ADR-0007

## Date

2026-09-20

Supersedes: ADR-0007 (rationale only; the lazy-default and managed-teardown mechanics remain in force)

## Context

ADR-0007 defaulted the continuous `cgc watch` off on the rationale that "whatever holds the lock excludes every other CGC process", generalizing the embedded-database behavior to all backends. The watcher-defaults research (source-verified lock semantics plus empirical lock probes) corrected that record:

- **Embedded backends (Kùzu family)**: the lock is real — an exclusive, process-scoped hard-fail lock. A running watcher locks out every other CGC process (stats, list, a second watch): all error. This part of ADR-0007's rationale stands.
- **Server backends (Neo4j, falkordb-remote)**: there is no database lock. The watcher, the CGC MCP server, and index runs were all probed coexisting with exit-0.

Blanket default-ON is nevertheless wrong for three backend-independent reasons:

1. **The fresh claim is unverifiable.** The extension recorded `fresh` at spawn with no liveness check; a watcher that dies within milliseconds leaves a stale "fresh" claim — the same dishonesty CGC's own watcher state-clearing code guards against on its side.
2. **It is an unrequested ~108 MB resident daemon.** A default-on watcher imposes a permanent process the user never asked for.
3. **It bypasses the consent model.** On an unindexed workspace `cgc watch .` performs a full initial scan, side-stepping `lifecycle.autoCreate: false`.

The boolean `freshness.watch` (default `false`, ADR-0007) cannot express any of this; it is either a global opt-in with an unverifiable fresh claim, or off.

## Decision

`freshness.watch` becomes a tri-state key with `off` as the default (byte-compatible with today's `false`):

- **`off`** — no watcher is ever spawned.
- **`on`** — the managed watcher spawns unconditionally on every backend (byte-compatible with today's `true`); the user accepts the trade-offs, including the embedded-backend lock.
- **`auto`** — the gated backend-aware default. The watcher spawns ONLY when ALL of: (a) the detected backend is a server backend (Neo4j / falkordb-remote — never Kùzu / falkordb local), (b) the workspace is already indexed (never spawns on an unindexed workspace — the consent model stays), and (c) the watcher's liveness is verified before the fresh claim is recorded.

Supporting commitments:

- **Liveness verification** (`freshness.watcherLivenessMs`, default 15000): after spawning, the extension verifies the watcher is alive and watching — the child survives a bounded stabilization probe without settling as failed — before recording any freshness state. A dead/failed watcher records the honest not-verified state (advisory stale plus a recorded error) and a one-time notice; a false "fresh" is never recorded. Verification applies to `on` and `auto` alike: the honest-claim requirement is backend- and mode-independent.
- **Backend detection**: a small bounded helper resolves the backend via the CGC runtime-environment overrides, then `cgc doctor`'s "Default database:" line, then the `DATABASE_TYPE`/`DEFAULT_DATABASE` keys of `~/.codegraphcontext/.env`, failing open to the conservative embedded answer when unknown — `auto` never spawns on an unknown backend.
- **Boolean compatibility**: `true`/`false` in existing configs map to `on`/`off`; only the literal text `auto` enables the gated mode — the migration is additive and never silently reinterprets a boolean configuration.
- **Observable conservatism**: one-time notices report a verified watcher start and each `auto` decline reason (embedded/unknown backend, unindexed workspace); a user's own terminal watcher is documented as coexisting (server) or conflicting (embedded, settling BUSY honestly) — the extension reports, it does not fight.
- **ADR-0007's mechanics remain in force**: the lazy budgeted drift/sync default, managed-child teardown through all session cleanup paths, one attempt per session, and staleness-as-advisory are unchanged.

## Consequences

- Positive: the corrected lock record is actionable — server-backend users can adopt continuous freshness through `auto` without giving up their MCP server, while embedded-backend users keep the conservative default.
- Positive: freshness claims become verified or absent; a dead watcher can no longer silence as "fresh".
- Positive: the consent model holds in every mode — watching never implies creating.
- Positive: no existing configuration changes meaning; the default stays off.
- Negative: the fresh record is delayed by up to the liveness budget, and an unverified watcher leaves the workspace advisory-stale until a sync or the next session's reconciliation.
- Negative: `auto` depends on a detection heuristic (bounded doctor parse with env/.env fallbacks); an undetectable backend degrades to no watcher — safe, but silent for users who expected otherwise (mitigated by the decline notices).
- Follow-up: if CGC exposes a queryable watcher-registry surface, the liveness probe can be strengthened from process-survival to a registry check; the tri-state shape does not change.
