## ADDED Requirements

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

Rule: When `freshness.autoSync` is enabled (default), the extension SHALL run one incremental index through the shared runner on first drift detection, again only within `freshness.maxSyncsPerSession`, MUST deduplicate with any in-flight sync, and MUST skip as busy with a notice when the embedded database is locked by another CGC process.

#### Scenario: First drift triggers a background sync

- **GIVEN** the workspace is marked possibly-stale for the first time this session and auto-sync is enabled
- **WHEN** the budget allows
- **THEN** one incremental index starts in the background and the state shows syncing until it completes

#### Scenario: Budget exhausted

- **GIVEN** the per-session sync budget has been used up and further edits occur
- **WHEN** drift is detected again
- **THEN** no additional sync starts automatically and the staleness notice remains the visible signal

#### Scenario: Sync skipped when busy

- **GIVEN** a CGC MCP server or watcher holds the embedded database when a sync would start
- **WHEN** the sync attempt runs
- **THEN** no indexing starts, a one-time busy notice names the conflict, and the state reflects skipped-as-busy

### Requirement: Opt-in continuous watcher mode

Rule: When `freshness.watch` is enabled, the extension SHALL start CGC's own watcher as a managed child process for the workspace, and the watcher MUST be terminated through all session cleanup paths so it never outlives the session or orphaned-holds the database lock.

#### Scenario: Watcher keeps the graph current

- **GIVEN** `freshness.watch` is enabled and the watcher started successfully
- **WHEN** files change during the session
- **THEN** the graph is updated incrementally by the watcher and the freshness state reports fresh

#### Scenario: Watcher start blocked by lock

- **GIVEN** `freshness.watch` is enabled but another CGC process holds the embedded database
- **WHEN** the watcher would start
- **THEN** it does not start, a one-time busy notice names the conflict, and freshness degrades to the lazy mode behavior

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
