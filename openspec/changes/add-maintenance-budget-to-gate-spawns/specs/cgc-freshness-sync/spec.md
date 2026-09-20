# cgc-freshness-sync (delta)

## MODIFIED Requirements

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
