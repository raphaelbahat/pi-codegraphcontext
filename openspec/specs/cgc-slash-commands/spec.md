# cgc-slash-commands Specification

## Purpose

Exposes /cgc:* slash commands (status, index, sync, clear and friends) so the user can drive the CGC lifecycle manually from the prompt, mirroring the automatic gating extensions with explicit, reviewable actions.

## Requirements

### Requirement: Status command

Rule: The extension SHALL provide a `/cgc status` command that reports the active workspace, its lifecycle state, an indexed answer for the workspace (the Index line, with the source that decided it), the last action taken, and — when the freshness capability is present — an index freshness summary, without performing any maintenance work.

#### Scenario: Status on a clean workspace

- **GIVEN** the active workspace's index is healthy and no work is running
- **WHEN** the user runs `/cgc status`
- **THEN** the output names the workspace, reports the clean state, and lists no running work

#### Scenario: Status while work is running

- **GIVEN** a session-start sync or index job is running for the active workspace
- **WHEN** the user runs `/cgc status`
- **THEN** the output shows the running action and its progress state instead of a terminal state

#### Scenario: Status without optional capabilities

- **GIVEN** the freshness capability is not present in this installation
- **WHEN** the user runs `/cgc status`
- **THEN** the output still renders workspace and lifecycle state and simply omits the freshness section

#### Scenario: Status answers indexedness from the recorded snapshot

- **GIVEN** the lifecycle gate has evaluated the workspace and recorded an indexed answer
- **WHEN** the user runs `/cgc status`
- **THEN** the Index line answers from the recorded snapshot, labels the source (`snapshot`), and runs no probe

#### Scenario: Status answers indexedness when no snapshot is recorded

- **GIVEN** the session-start gate has not evaluated the workspace (or recorded no indexed answer)
- **WHEN** the user runs `/cgc status`
- **THEN** the Index line answers through the cheapest read-only signal chain — the filesystem marker (a positive-only signal, hedged as "likely indexed"), then the CGC HTTP API registry point lookup, then a bounded `cgc list` — and labels the deciding source; no indexing or maintenance work is ever triggered by the view

#### Scenario: The indexed answer fails open

- **GIVEN** every indexedness signal is unavailable, inconclusive, or failing
- **WHEN** the user runs `/cgc status`
- **THEN** the Index line renders `unknown`, the command raises no error, and no maintenance work is triggered

### Requirement: Index command consent gates

Rule: `/cgc index` MUST honor the same consent gates as the session-start lifecycle: creating a missing index follows the auto-create opt-in, and a force rebuild MUST require explicit confirmation in the session before running.

#### Scenario: Creating a missing index

- **GIVEN** the active workspace has no CGC index
- **WHEN** the user runs `/cgc index` on the unindexed workspace
- **THEN** the extension applies the auto-create consent gate from the add-cgc-session-lifecycle-gate change — asking for confirmation to create the index — and on confirmation starts indexing in the background with visible progress state

#### Scenario: Force rebuild requires confirmation

- **GIVEN** the active workspace has an existing index and the user runs `/cgc index` with the force option
- **THEN** the extension explains that a rebuild replaces the existing index and only proceeds after explicit confirmation

#### Scenario: Confirmation declined

- **GIVEN** the user is prompted for an index action and declines
- **WHEN** the command ends
- **THEN** no `cgc` maintenance command runs and the existing index is untouched

### Requirement: Sync command

Rule: `/cgc sync` SHALL trigger an incremental drift sync for the active workspace and MUST skip with a one-time notice when the embedded database is locked by another CGC process.

#### Scenario: Sync triggers incremental indexing

- **GIVEN** the active workspace has an index with tracked changes on disk
- **WHEN** the user runs `/cgc sync`
- **THEN** an incremental indexing run starts for the current workspace and its progress state is visible

#### Scenario: Sync skipped when busy

- **GIVEN** a CGC MCP server or watcher holds the embedded database
- **WHEN** the user runs `/cgc sync`
- **THEN** no indexing starts, the user sees a busy notice naming the conflict, and no error is raised

### Requirement: Doctor command

Rule: `/cgc doctor` SHALL run the CGC diagnostic command and render its output with bounded size and cleaned formatting, performing no state changes.

#### Scenario: Doctor output is rendered

- **GIVEN** the `cgc` binary is available
- **WHEN** the user runs `/cgc doctor`
- **THEN** the diagnostic results are rendered in the session, truncated with an explicit marker if they exceed the output budget

### Requirement: Report command writes with confirmation

Rule: `/cgc report` MUST ask for confirmation before writing the report file into the workspace, and MUST NOT write any file when confirmation is declined.

#### Scenario: Report generated after confirmation

- **GIVEN** the user runs `/cgc report` and confirms the file write
- **WHEN** the CGC report command completes
- **THEN** the report file exists at the confirmed destination path and the command reports it (CGC's documentation does not state the default output location, so the extension confirms the exact path before writing)

#### Scenario: Report declined

- **GIVEN** the user runs `/cgc report` and declines the file write
- **WHEN** the command ends
- **THEN** no report file is written and no `cgc` report command runs

### Requirement: No destructive verbs exposed

Rule: The command surface MUST NOT expose database deletion or cleanup operations gated by CGC's deletion-safety configuration.

#### Scenario: No delete or clean command

- **GIVEN** the extension's registered commands
- **WHEN** the user inspects the `/cgc` command list
- **THEN** no command maps to CGC's repository deletion or database cleanup operations

### Requirement: Fail-open command behavior

Rule: Command failures MUST NOT crash or block the session, and every command SHALL apply the shared invocation guardrails (argument-array execution, session working directory, time budget, abort, bounded output).

#### Scenario: Command when cgc is unavailable

- **GIVEN** the `cgc` executable is not available
- **WHEN** the user runs any `/cgc` command
- **THEN** the command reports CGC as unavailable and the session continues normally

### Requirement: Commands report live state in replaced sessions

Rule: The `/cgc` commands SHALL report live lifecycle state in every session, including sessions created by replacing an earlier one (`/resume`, `/new`, `/fork`, `/reload`): the read-only state seam resolves the rebound gate's per-session store (with the process-lifetime store as fallback), and the command registration re-runs on each replacement's fresh API without duplicating the bare `/cgc` command.

#### Scenario: Status in a resumed session is not empty

- **GIVEN** an earlier session ran and the user replaced it via `/resume`
- **WHEN** the user runs `/cgc status` in the resumed session after its session-start evaluation recorded state
- **THEN** the status renders the current lifecycle state and notices for the resumed session — not the "no lifecycle state recorded yet … the session-start gate has not evaluated it" degradation of a dormant gate

#### Scenario: Command registration stays single across replacements

- **GIVEN** a session is replaced and the factory re-runs on the new API
- **WHEN** the command surface registers again
- **THEN** exactly one bare `/cgc` command exists on the new API (pi assigns no `:1` invocation suffix from a duplicate)
