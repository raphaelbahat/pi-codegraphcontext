## ADDED Requirements

### Requirement: Bounded head+tail capture

Rule: The shared runner SHALL cap captured output at the configured budget (`output.maxBytes`), preserving the beginning AND the end of the output, and SHALL mark truncation with an explicit marker that states the original output size.

#### Scenario: Small output passes through unchanged

- **GIVEN** a `cgc` invocation produces output smaller than the configured budget
- **WHEN** the runner captures it
- **THEN** the output is delivered complete and unmarked

#### Scenario: Oversized output is capped at both ends

- **GIVEN** a `cgc` invocation produces output larger than the configured budget
- **WHEN** the runner captures it
- **THEN** the delivered output contains the beginning and the end of the original, separated by an explicit truncation marker that names the original size

### Requirement: Spill-to-file on truncation

Rule: When output is truncated and `output.spillToTemp` is enabled, the runner SHALL write the full output to a session-scoped file in the OS temporary directory (never the workspace), name that path in the truncation marker, and MUST remove spill files during session shutdown cleanup.

#### Scenario: Truncated output spills to a temp file

- **GIVEN** output exceeds the budget and spill is enabled
- **WHEN** the runner truncates it
- **THEN** a file outside the workspace contains the full output and the truncation marker names its path

#### Scenario: Spill disabled

- **GIVEN** output exceeds the budget and `output.spillToTemp` is disabled
- **WHEN** the runner truncates it
- **THEN** the truncation marker is shown without any spill path and nothing is written

#### Scenario: Spill files are cleaned up

- **GIVEN** spill files were created during a session
- **WHEN** the session shuts down through any cleanup path
- **THEN** the session's spill files are removed

### Requirement: Secret redaction in captured output

Rule: The runner SHALL redact secret-shaped strings (credential-style assignments and high-entropy literals) in captured output by default, before the output is rendered or made available to any agent-visible surface, and the redaction SHALL be disableable only through the explicit `output.redactSecrets` opt-out.

#### Scenario: Secret-shaped string is redacted

- **GIVEN** captured output contains a credential-style assignment such as an API key or password literal
- **WHEN** the output passes the policy pipeline
- **THEN** the secret value is replaced with a redaction placeholder in everything the surfaces render

#### Scenario: Redaction opt-out

- **GIVEN** the user has explicitly disabled `output.redactSecrets`
- **WHEN** output passes the pipeline
- **THEN** values are left as produced by `cgc` (bounding and stripping still apply)

### Requirement: Control-sequence hygiene

Rule: The runner MUST strip ANSI/control sequences from captured output before delivery.

#### Scenario: Rich terminal output is cleaned

- **GIVEN** a `cgc` invocation emits ANSI-colored, cursor-manipulated output
- **WHEN** the runner captures it
- **THEN** the delivered output contains plain text without control sequences

### Requirement: Optional GCF passthrough

Rule: When `output.gcf` is enabled, the runner SHALL set CGC's documented output-format environment (`CGC_OUTPUT_FORMAT=gcf`) on its invocations and MUST rely on CGC's documented fallback behavior when the format is unavailable, without failing the invocation.

#### Scenario: GCF enabled

- **GIVEN** `output.gcf` is enabled
- **WHEN** the runner spawns `cgc`
- **THEN** the invocation carries the GCF output-format environment setting

#### Scenario: GCF unavailable on the installed CGC

- **GIVEN** `output.gcf` is enabled but the installed CGC cannot produce GCF output
- **WHEN** an invocation completes
- **THEN** the invocation succeeds with CGC's fallback output and no extension error is raised

### Requirement: Universal application of the policy

Rule: The output policy SHALL apply to every `cgc` invocation made through the shared runner, so all surfaces (lifecycle gate, slash commands, status notices, future tools) inherit it without per-surface logic.

#### Scenario: Probe and command outputs both pass the pipeline

- **GIVEN** a lifecycle probe and a `/cgc doctor` command run in the same session
- **WHEN** their outputs are captured
- **THEN** both have been stripped, redacted per configuration, and bounded by the same policy

### Requirement: Fail-open policy pipeline

Rule: Policy pipeline failures (redaction, spill write, stripping) MUST NOT fail the underlying invocation handling; the runner SHALL deliver best-effort output and record the policy error.

#### Scenario: Policy error is contained

- **GIVEN** the spill write fails (for example, a read-only temp directory)
- **WHEN** an oversized output is captured
- **THEN** the invocation result is still delivered with the truncation marker (without a spill path), the policy error is recorded, and the session is unaffected
