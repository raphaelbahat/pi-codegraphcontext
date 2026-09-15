## ADDED Requirements

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

Rule: A missing index SHALL be created only with explicit user consent.

#### Scenario: Auto-create disabled (default)

- **GIVEN** the workspace has no CGC index and auto-creation is disabled (the default)
- **WHEN** the session-start gate runs
- **THEN** no indexing is started, the user is informed once that the workspace is unindexed with guidance on enabling creation, and the session proceeds

#### Scenario: Auto-create enabled

- **GIVEN** the workspace has no CGC index and the user has opted in to automatic creation
- **WHEN** the session-start gate runs
- **THEN** the extension starts indexing in the background, reports that indexing is running, and the session proceeds while it completes

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

Rule: Every `cgc` invocation the extension makes SHALL be sandboxed, cancellable, deduplicated, and cleaned up.

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
