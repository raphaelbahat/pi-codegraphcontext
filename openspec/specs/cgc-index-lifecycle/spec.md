# cgc-index-lifecycle Specification

## Purpose
Tracks the codegraph (CGC) index lifecycle per session — unavailable, unindexed, busy, indexing, rebuilding, drift, syncing, clean, corrupt — so extensions and the CLI can gate behavior on readiness instead of probing the indexer directly.

## Requirements

### Requirement: Session-start index detection

Rule: The extension SHALL determine the CGC index state of the active workspace at session start without slowing or blocking the agent.

#### Scenario: Workspace with an existing index starts a session

- **GIVEN** the workspace at the session's working directory contains a valid CGC index
- **WHEN** a Pi session starts
- **THEN** the extension reports the index state as ready before or while the agent begins work, and the agent is never blocked waiting on the check

#### Scenario: Workspace without an index starts a session

- **GIVEN** the workspace at the session's working directory has no CGC index
- **WHEN** a Pi session starts
- **THEN** the extension reports the index state as unindexed and the session proceeds normally

#### Scenario: Session working directory is the source of truth

- **GIVEN** the Pi session's working directory differs from the extension process's working directory
- **WHEN** the gate resolves which workspace to manage
- **THEN** it uses the session's working directory, not the process's

### Requirement: Opt-in index creation

Rule: When `lifecycle.autoCreate` is enabled and the workspace has no index, the gate SHALL start the index creation in the background with a one-time notice, passing `cgc.maintenanceTimeoutMs` (the maintenance budget — an index creation is maintenance work, not a probe) as the invocation's time budget. Absent key → the pre-existing default budget applies. The consent-gated, one-time-notice, fail-open semantics are unchanged.

#### Scenario: Auto-create disabled (default)

- **GIVEN** the workspace has no CGC index and auto-creation is disabled (the default)
- **WHEN** the session-start gate runs
- **THEN** no indexing is started, the user is informed once that the workspace is unindexed with guidance on enabling creation, and the session proceeds

#### Scenario: Auto-create enabled

- **GIVEN** the workspace has no CGC index and the user has opted in to automatic creation
- **WHEN** the session-start gate runs
- **THEN** the extension starts indexing in the background, reports that indexing is running, and the session proceeds while it completes

#### Scenario: Consented auto-create carries the maintenance budget

- **WHEN** `lifecycle.autoCreate` is on and the session starts on an unindexed workspace
- **THEN** the background creation spawn's time budget is `cgc.maintenanceTimeoutMs`
- **AND** the user receives the same one-time notice as before

### Requirement: Start-time drift sync

Rule: When the workspace is already indexed but the graph is behind the working tree, the extension MUST reconcile them at session start.

#### Scenario: Indexed workspace with files changed since last sync

- **GIVEN** the workspace has a CGC index and tracked files changed since the graph was last updated
- **WHEN** the session-start gate runs
- **THEN** a sync of the changed files is started in the background and the reported state reflects that syncing is in progress

#### Scenario: Indexed workspace with no drift

- **GIVEN** the workspace has a CGC index that matches the working tree
- **WHEN** the session-start gate runs
- **THEN** no indexing work is triggered and the index is reported as clean

### Requirement: Corrupt index requires explicit rebuild consent

Rule: A corrupt or unusable index SHALL never be destroyed or rebuilt without explicit confirmation.

#### Scenario: Corrupt index detected

- **GIVEN** the workspace's CGC index exists but is unusable (for example, a failed or inconsistent index)
- **WHEN** the session-start gate runs
- **THEN** the extension reports the index as corrupt and offers a full rebuild, performs no destructive action on its own, and the session proceeds

### Requirement: Busy and lock conflicts skip gracefully

Rule: The gate MUST NOT fight another CGC process for the embedded database.

#### Scenario: Embedded database locked by another CGC process

- **GIVEN** a CGC MCP server or watcher already holds the embedded database for the workspace
- **WHEN** the session-start gate needs to run indexing or sync work
- **THEN** the gate skips that work as busy, surfaces a one-time notice naming the conflicting process state, and the session proceeds without errors

### Requirement: Clean state performs no redundant work

Rule: When the workspace index is healthy and unchanged since the last session, the extension MUST perform no redundant maintenance work beyond a cached liveness check.

#### Scenario: Healthy index on repeated sessions

- **GIVEN** the workspace index is healthy and unchanged since the last session
- **WHEN** subsequent sessions start
- **THEN** no `cgc` maintenance commands run beyond a cached liveness check, and repeated sessions do not re-index or re-probe redundantly

### Requirement: Safe execution and teardown of cgc invocations

Rule: Every `cgc` invocation the extension makes SHALL be sandboxed, cancellable, deduplicated, and cleaned up. Every extension-spawned `cgc` child SHALL additionally carry a pinned watcher-policy environment (`ENABLE_AUTO_WATCH=false`, merged over the inherited environment so every other variable is inherited unchanged), so a short-lived index run can never fork its own background watcher and block on it — the extension's watcher policy is owned by the extension, and the only watcher it sanctions is the opt-in managed `freshness.watch` child. The pin is inert on the managed watcher child (`cgc watch` never reads the variable), so `freshness.watch` behavior is unchanged.

#### Scenario: Indexing command runs to completion

- **GIVEN** the gate starts a `cgc` maintenance command
- **WHEN** the command finishes within its time budget
- **THEN** its output is captured with a bounded size, its result updates the reported index state, and no further invocations for the same workspace run in parallel with it

#### Scenario: Hung command is cancelled

- **GIVEN** a `cgc` maintenance command exceeds its time budget
- **WHEN** the budget expires
- **THEN** the command is cancelled, the state records a timeout, and the session is unaffected

#### Scenario: Session shuts down while work is in flight

- **GIVEN** the session ends while a `cgc` maintenance command or watcher started by the gate is running
- **WHEN** the session shuts down
- **THEN** all extension-spawned `cgc` processes are terminated through multiple cleanup paths, leaving no orphaned processes holding database locks

#### Scenario: Machine environment enables CGC auto-watch

- **GIVEN** the machine environment or CGC config sets `ENABLE_AUTO_WATCH=true`
- **WHEN** the extension spawns a short-lived `cgc index` run (a sync verb, the session-start sync, a freshness auto-sync, or an auto-create)
- **THEN** the child's environment carries `ENABLE_AUTO_WATCH=false`, the run finishes indexing and exits without forking a background watcher, and the invocation settles on its own instead of hanging

#### Scenario: Inherited environment is otherwise untouched

- **GIVEN** the extension spawns any `cgc` invocation
- **WHEN** the runner constructs the child environment
- **THEN** every environment variable other than `ENABLE_AUTO_WATCH` is inherited unchanged (including CGC's credential variables), and the pin is merged over the inherited values rather than replacing them

#### Scenario: Managed watcher child is unaffected by the pin

- **GIVEN** `freshness.watch` is enabled and the observer starts CGC's own `cgc watch .` as a managed child through the shared runner
- **WHEN** the runner applies the spawn environment pin
- **THEN** the watcher child starts and keeps watching normally, because `cgc watch` does not read `ENABLE_AUTO_WATCH` — the pin is inert on it

### Requirement: Fail-open operation

Rule: Every gate failure mode MUST leave the agent usable.

#### Scenario: cgc binary is missing

- **GIVEN** the `cgc` executable is not found
- **WHEN** the session-start gate runs
- **THEN** the extension reports CGC as unavailable with a one-time notice and the session proceeds normally

#### Scenario: Gate errors are contained

- **GIVEN** any error occurs inside the gate (spawn failure, parse failure, unexpected output)
- **WHEN** the session continues
- **THEN** the error is captured into the reported state, the agent loop is never interrupted, and the gate does not retry failing work more than once per session

### Requirement: API-backed indexedness probe chain

Rule: When the workspace filesystem marker (`.codegraphcontext/`) is absent, the extension SHALL resolve indexedness through a bounded CGC HTTP API probe chain before falling back to the `cgc list` CLI probe: a health check, then a Cypher point lookup, then a repositories JSON fallback on query error, then an on-demand server spawn, then the unchanged CLI fallback. The marker-present path SHALL NOT consult the API or the registry.

#### Scenario: API is up and the path is indexed

- **GIVEN** a workspace without the filesystem marker whose repository path is registered in the CGC graph, with a CGC API server already reachable on the configured port
- **WHEN** the session-start classifier resolves indexedness
- **THEN** the Cypher point lookup finds the repository, the workspace is classified as indexed, the health probe decides clean/drift/corrupt exactly as for the marker-present path, and the reason names `registry (cypher)` as the decider

#### Scenario: API is up and the path is not indexed

- **GIVEN** a workspace without the filesystem marker whose repository path is absent from the CGC graph, with a CGC API server already reachable
- **WHEN** the session-start classifier resolves indexedness
- **THEN** the point lookup returns no records and the workspace is classified `unindexed` with the standard one-time notice, never mapped to any work-triggering state

#### Scenario: Query errors fall back to the repositories JSON

- **GIVEN** a reachable API server whose query endpoint returns an unexpected error (neither found nor absent)
- **WHEN** the session-start classifier resolves indexedness
- **THEN** the extension checks the parsed `GET /api/v1/repositories` JSON for the workspace path exactly, and that result decides indexedness with the same doctrine mapping

#### Scenario: No API is reachable and the spawn budget succeeds

- **GIVEN** no API server is reachable and the extension spawns one on loopback that becomes healthy within the spawn budget
- **WHEN** the session-start classifier resolves indexedness
- **THEN** the Cypher point lookup against the spawned server decides indexedness, the spawned server is terminated after the probe resolves, and no spawned process remains

#### Scenario: Spawn budget exhausted falls back to the CLI registry

- **GIVEN** no API server is reachable and the spawn phase cannot produce a healthy server before its hard deadline
- **WHEN** the session-start classifier resolves indexedness
- **THEN** the spawn phase stops at the deadline with any spawned child terminated, the existing `cgc list` probe decides indexedness unchanged, and the reason names `registry (cgc list)` as the decider

#### Scenario: Marker-present path never touches the API or registry

- **GIVEN** a workspace with `.codegraphcontext/` present
- **WHEN** the session-start classifier resolves indexedness
- **THEN** no HTTP request is made and no registry probe (API or CLI) runs — the cheap marker path is preserved

### Requirement: Bounded and secure API spawning

Rule: Every spawned CGC API server SHALL bind loopback only (`--host 127.0.0.1`), SHALL carry an authentication key (the user's `CGC_API_KEY` passed through untouched, or a generated ephemeral key sent via the server's environment), and the whole spawn phase SHALL run under a monotonic hard deadline with per-request timeouts via abort signals. Spawned servers SHALL be registered with the shared runner's child cleanup so no spawned process outlives the session.

#### Scenario: Loopback-only spawn argv

- **GIVEN** the extension spawns a CGC API server
- **WHEN** the child process is created
- **THEN** its arguments include `--host 127.0.0.1` and never bind a network-exposed interface

#### Scenario: User key passes through untouched

- **GIVEN** `CGC_API_KEY` is set in the extension's environment
- **WHEN** the client makes API requests and spawns a server
- **THEN** requests carry that exact key (`Authorization: Bearer` / `X-API-Key`) and the spawned server receives the same key via its environment — it is never replaced or regenerated

#### Scenario: Ephemeral key generated when no user key exists

- **GIVEN** `CGC_API_KEY` is not set
- **WHEN** the client makes API requests and spawns a server
- **THEN** a random ephemeral key is generated, sent on every request, and handed to the spawned server via its environment, and the key value never appears in user-facing reasons or notices

#### Scenario: Exit-code-3 conflicts retry on a new port within the deadline

- **GIVEN** a spawned server exits with code 3 (bind conflict) on the configured port
- **WHEN** the spawn phase continues
- **THEN** the next attempt uses a new port (configured port first, then random ephemeral ports), health is polled on each attempt, and all attempts together respect the monotonic hard deadline

#### Scenario: Teardown sweeps spawned servers

- **GIVEN** a spawned CGC API server is alive when the session shuts down, the process exits, or a termination signal arrives
- **WHEN** any teardown path runs
- **THEN** the spawned server is terminated together with the runner's other children, leaving no orphaned process

### Requirement: Doctrine mapping unchanged for API-decided outcomes

Rule: API probe outcomes SHALL map onto the existing lifecycle doctrine exactly as the CLI registry probe does: found → indexed (health probe decides), absent → `unindexed` notice, BUSY → `busy`, and any other failure → corrupt-adjacent unknown. Uncertainty SHALL never map to `drift` and SHALL never trigger automatic maintenance work.

#### Scenario: BUSY is not converted by the API path

- **GIVEN** the API path fails overall and the `cgc list` fallback reports a database lock conflict
- **WHEN** the session-start classifier resolves indexedness
- **THEN** the workspace is classified `busy`, not corrupt and not drift

#### Scenario: Total API path failure fails safe

- **GIVEN** the API path fails and the `cgc list` fallback is also inconclusive
- **WHEN** the session-start classifier resolves indexedness
- **THEN** the classification is corrupt-adjacent unknown, no action is taken without confirmation, and the reason states the failure

### Requirement: API probe configuration

Rule: The API probe chain SHALL be configurable through `cgc.api` (`enabled`, default true; `port`, default 8000) with environment-variable overrides (`CGC_API_ENABLED`, `CGC_API_PORT`) that take precedence over config files, validated with the shared warning-and-fallback conventions.

#### Scenario: Defaults enable the API path on port 8000

- **GIVEN** a default installation with no configuration
- **WHEN** the marker-absent path runs
- **THEN** the API probe chain is attempted against port 8000 before the CLI fallback

#### Scenario: Disabling the API path restores the CLI-only behavior

- **GIVEN** `cgc.api.enabled` is false (or `CGC_API_ENABLED=0`)
- **WHEN** the marker-absent path runs
- **THEN** no HTTP request or server spawn is attempted and the `cgc list` probe decides indexedness exactly as before this change

#### Scenario: Invalid port values are rejected with a warning

- **GIVEN** `CGC_API_PORT` or `cgc.api.port` holds a value outside 1–65535
- **WHEN** configuration is resolved
- **THEN** the value is skipped with a warning and the port falls back to the lower layer (default 8000)

### Requirement: Session replacement rebinds the gate and the teardown sweep

Rule: When Pi replaces the session (`/resume`, `/new`, `/fork`, `/reload`) and re-runs the extension factory with a fresh API instance, the lifecycle gate and the multi-path teardown sweep SHALL re-bind to the new session's API — the resumed session receives a full session-start evaluation, and the new session's `session_shutdown` and process teardown paths remain armed. Re-registration on the same API SHALL remain a single, idempotent registration (no duplicate hooks).

#### Scenario: A resumed session gets a gate evaluation

- **GIVEN** an earlier session ran with the gate live and the user replaces it via `/resume`
- **WHEN** the new session's `session_start` fires
- **THEN** the gate evaluates the workspace on the new session (the lifecycle state is recorded) and any availability or state notices flow to the new session's UI, instead of the gate staying dormant on the replaced session's API

#### Scenario: The teardown sweep survives a session replacement

- **GIVEN** a session is replaced while the extension holds tracked `cgc` children
- **WHEN** the new session later shuts down or the process exits
- **THEN** the teardown sweep terminates the extension's tracked children exactly once per path (the old installation is disposed before the new one is installed; no duplicated `exit`/signal listeners)

#### Scenario: Same-API registration stays idempotent

- **GIVEN** the extension factory is invoked twice with the same API instance
- **WHEN** each guarded surface's registration runs
- **THEN** each hook is wired exactly once — no duplicate handlers are registered

#### Scenario: Cross-session state survives the rebind

- **GIVEN** the shared runner holds tracked children and the process-lifetime stores hold recorded snapshots from earlier sessions
- **WHEN** a session replacement rebinds the surfaces
- **THEN** the runner's child tracking and the process-lifetime stores are preserved (the same runner instance keeps sweeping; recorded snapshots remain readable), while the per-session budgets, one-shot flags, and once-per-session notice markers re-arm for the new session

### Requirement: Gate maintenance spawns carry the maintenance budget

Rule: The gate's session-start maintenance spawns — the consented auto-create index (`UnindexedPath`, `lifecycle.autoCreate` on) and the start-time drift sync (`DriftPath`, `lifecycle.syncOnStart` on) — SHALL pass `cgc.maintenanceTimeoutMs` (default 600 000 ms) as the spawned \`cgc\` invocation's time budget, because these runs are the same work class as the \`/cgc index\` and \`/cgc sync\` command runs and are not probes. When the key is absent the seams stay unset and the pre-existing runner default (`cgc.timeoutMs`, probe-sized) applies byte-for-byte.

#### Scenario: Session-start drift sync on a large workspace completes

- **WHEN** the session-start evaluation detects drift and starts a background incremental sync
- **THEN** the spawned invocation's time budget is `cgc.maintenanceTimeoutMs` (the maintenance-sized default), so a run that legitimately takes longer than a probe is not terminated
- **AND** the completion (or any recorded termination) flows through the lifecycle state exactly as today

#### Scenario: Maintenance key absent leaves current behavior

- **WHEN** `cgc.maintenanceTimeoutMs` is absent from every config layer and the environment
- **THEN** the gate's spawn seams remain unset and the runner applies its existing default budget — the behavior is unchanged from the pre-change code
