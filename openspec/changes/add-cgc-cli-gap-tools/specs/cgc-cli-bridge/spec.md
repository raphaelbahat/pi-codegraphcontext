## ADDED Requirements

### Requirement: Tool availability with opt-out

Feature: `cgc-cli-bridge`
Rule: The extension SHALL register the three CLI-gap tools (`cgc_bundle_export`, `cgc_context`, `cgc_doctor`) when `tools.cliGap.enabled` is true (the default), and SHALL NOT register them when it is disabled.

#### Scenario: Default installation exposes the tools

- **GIVEN** a default installation (opt-out not set)
- **WHEN** a session starts
- **THEN** the agent can discover and call all three CLI-gap tools

#### Scenario: Opted-out installation hides the tools

- **GIVEN** `tools.cliGap.enabled` is disabled
- **WHEN** a session starts
- **THEN** none of the three tools is registered and no tool-catalog entry for them exists

### Requirement: Bundle export with confirmation

Rule: `cgc_bundle_export` SHALL export a `.cgc` bundle for a repository to a named output path using documented CLI verbs, MUST require explicit confirmation for the file write, and MUST NOT invoke destructive flags (such as clear-on-load variants).

#### Scenario: Confirmed export creates a bundle

- **GIVEN** the agent calls `cgc_bundle_export` with a repository path and output path, and the write is confirmed
- **WHEN** the export completes
- **THEN** the bundle file exists at the requested path and the result names it with basic size information

#### Scenario: Declined export writes nothing

- **GIVEN** the agent calls `cgc_bundle_export` and the write is declined
- **WHEN** the tool returns
- **THEN** no file was written and no `cgc` export command ran

### Requirement: Named-context management

Rule: `cgc_context` SHALL support listing, creating, deleting, and setting the default named context through documented CLI verbs; deletion MUST require explicit confirmation; and the tool MUST NOT expose any operation gated by CGC's deletion-safety configuration.

#### Scenario: Listing contexts

- **GIVEN** named contexts exist in the CGC configuration
- **WHEN** the agent lists contexts
- **THEN** the result names each context with its mode and associated repositories

#### Scenario: Creating a context

- **GIVEN** the agent creates a named context
- **WHEN** the command completes
- **THEN** the context registration exists and the result confirms its name and database settings

#### Scenario: Delete requires confirmation

- **GIVEN** the agent requests deletion of a named context
- **WHEN** the tool runs
- **THEN** deletion proceeds only after explicit confirmation, removes only the registration, and never deletes database files

#### Scenario: Declined delete

- **GIVEN** the agent requests deletion and the confirmation is declined
- **WHEN** the tool returns
- **THEN** the context registration is unchanged

### Requirement: Diagnostics tool

Rule: `cgc_doctor` SHALL run CGC diagnostics read-only and return bounded, policy-cleaned output.

#### Scenario: Diagnostics returned

- **GIVEN** the `cgc` binary is available
- **WHEN** the agent calls `cgc_doctor`
- **THEN** the result contains the diagnostic report, bounded by the output policy with a truncation marker if oversized

### Requirement: Shared guardrails and structured errors

Rule: Every CLI-gap tool MUST execute through the shared runner guardrails (argument-array, session working directory, time budget, abort, output-policy pipeline), MUST NOT bypass CGC's path sandbox, and MUST return structured, agent-actionable error codes with remediation hints (for example not-found, busy, timeout) rather than raw stack traces.

#### Scenario: Sandboxed path rejected cleanly

- **GIVEN** the agent calls a tool with a path outside the allowed roots
- **WHEN** CGC rejects it
- **THEN** the tool returns a structured not-allowed error naming the constraint and how to fix it, not a stack trace

#### Scenario: cgc missing

- **GIVEN** the `cgc` executable is not available
- **WHEN** the agent calls any CLI-gap tool
- **THEN** the tool returns a structured unavailable error with installation guidance

#### Scenario: Busy database

- **GIVEN** another CGC process holds the embedded database
- **WHEN** the agent calls `cgc_doctor` or an export that needs the database
- **THEN** the tool returns a structured busy error naming the conflict instead of retrying or crashing

### Requirement: No duplication of the MCP catalog

Rule: The tool surface MUST NOT register any tool equivalent to a tool in the CGC MCP server's documented catalog, and the three tool names MUST NOT collide with any MCP tool name.

#### Scenario: Name-collision check holds

- **GIVEN** the extension's registered tool names and the documented CGC MCP catalog
- **WHEN** the name sets are compared
- **THEN** no extension tool name matches or shadows an MCP tool name, and no extension tool duplicates an MCP tool's behavior
