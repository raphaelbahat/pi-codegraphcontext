# cgc-index-lifecycle (delta)

## ADDED Requirements

### Requirement: Gate maintenance spawns carry the maintenance budget

Rule: The gate's session-start maintenance spawns — the consented auto-create index (`UnindexedPath`, `lifecycle.autoCreate` on) and the start-time drift sync (`DriftPath`, `lifecycle.syncOnStart` on) — SHALL pass `cgc.maintenanceTimeoutMs` (default 600 000 ms) as the spawned \`cgc\` invocation's time budget, because these runs are the same work class as the \`/cgc index\` and \`/cgc sync\` command runs and are not probes. When the key is absent the seams stay unset and the pre-existing runner default (`cgc.timeoutMs`, probe-sized) applies byte-for-byte.

#### Scenario: Session-start drift sync on a large workspace completes

- **WHEN** the session-start evaluation detects drift and starts a background incremental sync
- **THEN** the spawned invocation's time budget is `cgc.maintenanceTimeoutMs` (the maintenance-sized default), so a run that legitimately takes longer than a probe is not terminated
- **AND** the completion (or any recorded termination) flows through the lifecycle state exactly as today

#### Scenario: Maintenance key absent leaves current behavior

- **WHEN** `cgc.maintenanceTimeoutMs` is absent from every config layer and the environment
- **THEN** the gate's spawn seams remain unset and the runner applies its existing default budget — the behavior is unchanged from the pre-change code

## MODIFIED Requirements

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
