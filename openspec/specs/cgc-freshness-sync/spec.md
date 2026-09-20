# cgc-freshness-sync Specification

## Purpose
Detects drift between the repository working tree and the CGC graph (stale mtime/hash signatures) and auto-syncs the affected symbols, keeping graph answers trustworthy as code changes.

## Requirements

### Requirement: Freshness state tracking

Rule: The extension SHALL maintain a freshness state for the active workspace — last successful sync time and a conservative dirty condition — and SHALL expose it to other extension surfaces (status display, slash commands).

#### Scenario: Fresh after a completed sync

- **GIVEN** an incremental sync for the active workspace completed successfully
- **WHEN** other surfaces read the freshness state
- **THEN** the state reports fresh with the sync completion time

#### Scenario: Dirty after observed edits

- **GIVEN** the freshness state was fresh and the session then performs file edits
- **WHEN** other surfaces read the freshness state
- **THEN** the state reports possibly-stale with the time of the first observed edit

#### Scenario: Optional capability degradation

- **GIVEN** the freshness capability is not present in an installation
- **WHEN** the status display or `/cgc status` renders
- **THEN** they omit freshness information per their specified degradation and raise no error

### Requirement: Conservative drift observation without probing

Rule: The extension SHALL mark the workspace dirty when it observes the session's own file-edit activity, using no `cgc` invocations, no filesystem hashing, and no polling for detection.

#### Scenario: Edit observed marks dirty without spawns

- **GIVEN** the session performs an edit through a tool the harness reports
- **WHEN** the edit event is observed
- **THEN** the workspace is marked possibly-stale and no `cgc` process was started for detection

#### Scenario: No false freshness

- **GIVEN** edits were observed since the last successful sync
- **WHEN** the freshness state is read
- **THEN** it never reports fresh until a new sync completes successfully

### Requirement: Lazy, budgeted drift sync

Rule: When `freshness.autoSync` is enabled (default), the extension SHALL run one incremental index through the shared runner on first drift detection, again only within `freshness.maxSyncsPerSession`, MUST deduplicate with any in-flight sync, and MUST skip as busy with a notice when the embedded database is locked by another CGC process. The spawned sync's time budget SHALL be `cgc.maintenanceTimeoutMs` (default 600 000 ms — an auto-sync is the same maintenance work class as a command-path sync), falling back to the pre-existing runner default when the key is absent. All other semantics — dedup, budget slots, busy-skip, fail-open — are unchanged.

#### Scenario: First drift triggers a background sync

- **WHEN** the freshness observer detects the first drift in a session
- **THEN** the background sync spawn's time budget is `cgc.maintenanceTimeoutMs` (the maintenance-sized budget)
- **AND** the dedup and per-session slot semantics are unchanged

#### Scenario: Sync skipped when busy

- **GIVEN** a CGC MCP server or watcher holds the embedded database when a sync would start
- **WHEN** the sync attempt runs
- **THEN** no indexing starts, a one-time busy notice names the conflict, and the state reflects skipped-as-busy

#### Scenario: Budget exhausted

- **WHEN** the session's `freshness.maxSyncsPerSession` slots are already consumed
- **THEN** no spawn happens and the existing skip notice flows — unchanged by this delta

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

### Requirement: One-time human-facing staleness notices

Rule: The extension SHALL surface staleness conditions (possibly-stale after edits, sync skipped as busy, sync completed) as notices at most once per condition per session, and MUST NOT place any freshness notice into the agent's context or prompt.

#### Scenario: Stale notice shown once

- **GIVEN** the workspace becomes possibly-stale for the first time this session
- **WHEN** the notice surface renders
- **THEN** the user sees one staleness notice with the sync options, and re-observed edits produce no further notices

#### Scenario: Sync completion is visible

- **GIVEN** a drift sync completed successfully
- **WHEN** the notice surface renders
- **THEN** the user sees one completion notice for that condition this session

#### Scenario: Notices stay out of the agent prompt

- **GIVEN** any freshness condition or notice has fired
- **WHEN** the agent runs its next turn
- **THEN** no freshness content appears in the agent's context or prompt

### Requirement: Fail-open operation and teardown

Rule: Freshness failures MUST NOT affect the agent session, and any watcher or sync process started by this capability MUST be terminated through all session cleanup paths.

#### Scenario: Session ends while work is active

- **GIVEN** a sync is running or the watcher is active when the session shuts down
- **WHEN** any cleanup path executes
- **THEN** the processes are terminated, no orphaned CGC processes hold the database lock, and the session exits normally

#### Scenario: Errors are contained

- **GIVEN** the freshness module encounters an error (event subscription failure, spawn failure, state write failure)
- **WHEN** the session continues
- **THEN** the error is recorded, the agent loop is unaffected, and the module does not retry failing work more than once per session

### Requirement: Freshness observation rebinds on session replacement

Rule: When Pi replaces the session and re-runs the extension factory with a fresh API instance, the freshness drift observer SHALL re-bind its `session_start`/`session_shutdown`/`tool_call` hooks to the new session's API — file-modifying tool calls mark drift in the resumed session, and the per-session sync budget re-arms. The shared freshness state store persists across the rebind; same-API registration SHALL remain a single, idempotent registration.

#### Scenario: A resumed session marks drift

- **GIVEN** an earlier session was freshness-watched and the user replaces it via `/resume`
- **WHEN** a file-modifying tool call runs in the resumed session
- **THEN** the drift mark is recorded for the new session (the `tool_call` handler is registered on the new API) and the lazy auto-sync path can fire, instead of the observer staying dormant on the replaced session's API

#### Scenario: The sync budget re-arms per session

- **GIVEN** the outgoing session exhausted its `freshness.maxSyncsPerSession` budget
- **WHEN** the session is replaced and drift marks again in the new session
- **THEN** the new session has a fresh budget — the budget is per session, not per process

#### Scenario: Same-API re-registration adds no duplicate handler

- **GIVEN** the extension factory is invoked twice with the same API instance
- **WHEN** the observer's registration runs twice
- **THEN** each hook (`session_start`, `session_shutdown`, `tool_call`) is subscribed exactly once

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
