# cgc-status-display Specification

## Purpose
Renders a persistent status-hud widget in the pi UI showing the CGC lifecycle state (indexing progress, drift, sync result) so the user sees graph health at a glance without running commands.

## Requirements

### Requirement: Persistent status chip

Feature: `cgc-status-display`
Rule: The extension SHALL render a one-line CGC status chip in the TUI status/footer area that reflects the current lifecycle state, and SHALL show activity states while background work runs.

#### Scenario: Ready state is rendered

- **GIVEN** the active workspace's index is healthy and no CGC work is running
- **WHEN** the TUI renders the status area
- **THEN** the chip shows the workspace's CGC as ready

#### Scenario: Activity state is rendered during work

- **GIVEN** the lifecycle state reports indexing or syncing in progress
- **WHEN** the TUI renders the status area
- **THEN** the chip shows the running activity rather than a terminal state

#### Scenario: Unindexed state is rendered

- **GIVEN** the active workspace has no CGC index and no CGC work is running
- **WHEN** the TUI renders the status area
- **THEN** the chip shows the workspace as unindexed rather than ready

#### Scenario: Busy state is rendered on lock conflict

- **GIVEN** a maintenance action was skipped because another CGC process holds the embedded database
- **WHEN** the TUI renders the status area
- **THEN** the chip shows the workspace as busy rather than ready

#### Scenario: Corrupt state is rendered

- **GIVEN** the workspace's index is classified as corrupt and no CGC work is running
- **WHEN** the TUI renders the status area
- **THEN** the chip shows the workspace's index as corrupt rather than ready

#### Scenario: Unavailable state is rendered

- **GIVEN** the `cgc` binary is not available
- **WHEN** the TUI renders the status area
- **THEN** the chip shows CGC as unavailable rather than ready

### Requirement: One-time session warnings

Rule: The extension SHALL surface each warning condition at most once per session as a notice: `cgc` binary missing; workspace unindexed (with guidance on enabling auto-create); embedded-database lock conflict (busy); corrupt index (with the rebuild path pointer).

#### Scenario: cgc missing warning

- **GIVEN** the `cgc` binary is not found at session start
- **WHEN** the status display activates
- **THEN** the user sees a notice that CGC is unavailable, exactly once this session

#### Scenario: Unindexed warning includes guidance

- **GIVEN** the active workspace has no CGC index
- **WHEN** the status display activates
- **THEN** the user sees a one-time notice that the workspace is unindexed and how to enable automatic index creation

#### Scenario: Busy warning

- **GIVEN** a maintenance action was skipped because another CGC process holds the embedded database
- **WHEN** the state transitions to busy
- **THEN** the user sees a one-time notice naming the lock conflict

#### Scenario: Corrupt warning

- **GIVEN** the workspace's index is classified as corrupt
- **WHEN** the state transitions to corrupt
- **THEN** the user sees a one-time notice describing the corrupt state and pointing at the rebuild path

#### Scenario: Warnings never repeat within a session

- **GIVEN** a warning condition has already been surfaced this session and the same condition occurs again
- **WHEN** the state re-enters that condition
- **THEN** no additional notice is shown for it

### Requirement: Passive rendering only

Rule: The status display MUST NOT spawn `cgc` processes, MUST NOT poll on a timer, and MUST update only from lifecycle (and, when present, freshness) state changes.

#### Scenario: Display updates without new invocations

- **GIVEN** the status chip is rendered
- **WHEN** background work transitions the lifecycle state
- **THEN** the chip updates from that state change without any new `cgc` invocation caused by the display

### Requirement: Fail-open and headless-safe display

Rule: Display failures MUST NOT affect the session, and the display SHALL be a no-op in headless or non-TUI operation.

#### Scenario: Rendering error is contained

- **GIVEN** the status rendering throws (for example, the TUI surface rejects an update)
- **WHEN** the session continues
- **THEN** the error is swallowed, the session is unaffected, and rendering attempts do not repeat more than once per state change

#### Scenario: Headless operation is a no-op

- **GIVEN** the session runs headless (no TUI)
- **WHEN** lifecycle state changes
- **THEN** the display performs no rendering work and nothing in the agent loop changes

### Requirement: Human-facing only

Rule: The status display MUST NOT add any content to the agent's context or prompt.

#### Scenario: Agent context unaffected

- **GIVEN** the status chip is rendered and warnings are shown
- **WHEN** the agent runs its next turn
- **THEN** no status-display content appears in the agent's context or prompt

### Requirement: Status chip rebinds on session replacement

Rule: When Pi replaces the session and re-runs the extension factory with a fresh API instance, the status HUD SHALL re-subscribe its `session_start`/`session_shutdown` hooks to the new session's API — the chip renders the resumed session's lifecycle state, and the once-per-session warning ledger re-arms so each warning condition can surface again in the new session. Same-API registration SHALL remain a single, idempotent registration.

#### Scenario: A resumed session renders the chip

- **GIVEN** an earlier session rendered the status chip and the user replaces it via `/resume`
- **WHEN** the new session starts and the gate records its lifecycle state
- **THEN** the chip renders the new session's lifecycle state (the HUD's subscription lives on the new API) instead of staying frozen on the replaced session's store

#### Scenario: Warnings re-arm in a resumed session

- **GIVEN** a warning condition (for example, CGC unavailable) already surfaced once in the outgoing session
- **WHEN** the same condition holds in the replaced session
- **THEN** the warning surfaces once in the new session — the once-per-session ledger is per session, not per process

#### Scenario: Same-API re-registration adds no duplicate subscription

- **GIVEN** the extension factory is invoked twice with the same API instance
- **WHEN** the HUD's registration runs twice
- **THEN** the HUD subscribes to each hook exactly once
