## ADDED Requirements

### Requirement: Tri-state watcher configuration

Rule: The `freshness.watch` key SHALL accept the string enum `off | on | auto` with `off` as the default, and MUST retain boolean compatibility: `true` maps to `on` and `false` maps to `off` in both the configuration-file layer and the environment layer, so existing boolean configurations keep their exact meaning. Only the literal text `auto` (in either layer) enables the gated mode — `auto` is never implicitly applied to a boolean configuration. The companion key `freshness.watcherLivenessMs` (a positive integer, default 15000) bounds the liveness-verification budget. An invalid value is skipped with a warning and never breaks configuration load.

#### Scenario: Default stays off

- **GIVEN** no configuration layer sets `freshness.watch`
- **WHEN** the extension loads its configuration
- **THEN** the effective value is `off` and no watcher is ever spawned

#### Scenario: Existing boolean config keeps its meaning

- **GIVEN** an existing configuration sets `freshness.watch` to the boolean `true` (or `false`)
- **WHEN** the configuration loads
- **THEN** the effective value is `on` (or `off` respectively), the watcher behavior is unchanged, and no `auto` gating is applied

#### Scenario: Explicit auto enables the gated mode

- **GIVEN** a configuration layer sets `freshness.watch` to the text `auto`
- **WHEN** the configuration loads
- **THEN** the effective value is `auto` and the watcher spawn decision follows the backend-aware gating

#### Scenario: Invalid value is skipped with a warning

- **GIVEN** a configuration layer sets `freshness.watch` to a value that is neither a recognized boolean nor `off`/`on`/`auto`
- **WHEN** the configuration loads
- **THEN** the value is ignored, a non-fatal warning is recorded, and the previous/default value stands

### Requirement: Backend-aware watcher detection

Rule: For `auto` mode the extension SHALL detect the CGC backend through a bounded detection helper that (in order) checks the CGC runtime-environment database overrides, parses `cgc doctor`'s "Default database:" output line, and falls back to reading the `DATABASE_TYPE`/`DEFAULT_DATABASE` keys from `~/.codegraphcontext/.env`. Detection MUST be time-bounded and MUST fail open to the conservative embedded answer when the backend cannot be determined. Only the server backends (`neo4j`, `falkordb-remote`) satisfy the auto-mode backend condition; every other backend — including unknown — is treated as embedded for spawning purposes.

#### Scenario: Server backend satisfies the backend condition

- **GIVEN** `freshness.watch` is `auto` and detection reports `neo4j` (or `falkordb-remote`)
- **WHEN** the watcher gating evaluates
- **THEN** the backend condition passes and the watcher may spawn when the remaining conditions hold

#### Scenario: Embedded backend never auto-spawns

- **GIVEN** `freshness.watch` is `auto` and detection reports an embedded backend (`kuzudb`, `falkordb`, `ladybugdb`, or equivalent)
- **WHEN** the watcher gating evaluates
- **THEN** no watcher spawns and the lazy drift/sync behavior runs for the session

#### Scenario: Unknown backend fails open to the conservative answer

- **GIVEN** `freshness.watch` is `auto` and detection cannot determine the backend (doctor fails or times out, no fallback source resolves)
- **WHEN** the watcher gating evaluates
- **THEN** the backend is treated as embedded, no watcher spawns, and the session proceeds normally

### Requirement: Auto mode never spawns on an unindexed workspace

Rule: In `auto` mode the watcher SHALL NOT spawn on a workspace that is not already indexed (no `.codegraphcontext/` marker — the same filesystem presence check CGC's own watcher uses for its "Already indexed" verdict). The consent model (`lifecycle.autoCreate: false`) stays intact: watching never implies creating.

#### Scenario: Unindexed workspace stays watcher-free

- **GIVEN** `freshness.watch` is `auto`, the detected backend is a server backend, and the workspace has no index
- **WHEN** the session starts
- **THEN** no watcher spawns, no initial scan or index creation is triggered, and a one-time notice explains the decline

### Requirement: Watcher liveness verification before the fresh claim

Rule: After spawning the managed watcher (in `on` or `auto` mode), the extension SHALL verify the watcher is alive and watching within the `freshness.watcherLivenessMs` budget before recording any freshness state — verifiably: the watcher child survives a bounded stabilization probe without settling as failed. A watcher that dies or fails during verification records the honest not-verified state (advisory stale with the failure recorded) plus a one-time notice; the extension MUST never record a "fresh" claim for an unverified watcher. A watcher verified alive records fresh and surfaces the one-time watcher-start notice.

#### Scenario: Verified watcher owns freshness

- **GIVEN** the managed watcher spawned and survived the liveness-verification budget
- **WHEN** files change during the session
- **THEN** the freshness state reports fresh, session edits open no stale episode, and the one-time watcher-start notice was surfaced

#### Scenario: Watcher fails liveness verification

- **GIVEN** the managed watcher spawned but settled as failed within the verification budget
- **WHEN** the verification concludes
- **THEN** the freshness state is the honest not-verified state (advisory stale, error recorded), a one-time notice names the failure, the lazy drift/sync behavior resumes, and no "fresh" claim was ever recorded

## MODIFIED Requirements

### Requirement: Opt-in continuous watcher mode

Rule: The `freshness.watch` key controls the managed CGC watcher as a tri-state: `off` (the default) never spawns a watcher; `on` starts CGC's own watcher as a managed child process unconditionally on every backend (the user accepts the watcher's trade-offs, including the embedded-backend lock); `auto` starts the watcher only when ALL of the gated conditions hold — the detected backend is a server backend, the workspace is already indexed, and (after spawn) the watcher's liveness is verified before the fresh claim is recorded. In every spawning mode the watcher MUST be terminated through all session cleanup paths so it never outlives the session or orphaned-holds the database lock, and the spawn attempt is one-per-session: a failed or declined attempt is not retried until the next session.

#### Scenario: Watcher keeps the graph current

- **GIVEN** `freshness.watch` is `on` (or `auto` with all gating conditions met) and the watcher started successfully and passed liveness verification
- **WHEN** files change during the session
- **THEN** the graph is updated incrementally by the watcher and the freshness state reports fresh

#### Scenario: Watcher start blocked by lock

- **GIVEN** the watcher would start but another CGC process holds the embedded database
- **WHEN** the watcher start settles as busy
- **THEN** it does not start, a one-time busy notice names the conflict, freshness degrades to the lazy mode behavior, and no "fresh" claim was recorded for the failed watcher

#### Scenario: On mode spawns unconditionally

- **GIVEN** `freshness.watch` is `on` on any backend, including embedded
- **WHEN** the session starts
- **THEN** the managed watcher spawns subject only to the existing runner and worktree-gate checks, and the user's explicit opt-in is honored without backend gating

#### Scenario: Off mode never spawns

- **GIVEN** `freshness.watch` is `off` (explicitly or by default)
- **WHEN** the session starts on any backend
- **THEN** no watcher spawns, no detection runs, and the lazy drift/sync behavior is unchanged
