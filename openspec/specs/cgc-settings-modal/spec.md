# cgc-settings-modal Specification

## Purpose
An in-session settings surface: the `/cgc config` verb opens a modal (pi-tui, framed and padded) over every extension configuration key with its effective value, source, and validation — letting the user view and edit the extension's behavior from within Pi without hand-editing JSON files, with layer-targeted never-clobber persistence and honest next-session effect semantics.

## Requirements

### Requirement: Config command opens the settings modal

Rule: The extension SHALL provide a `/cgc config` verb on its existing `/cgc` command registration that, in TUI mode (`ctx.mode === "tui"`), opens an interactive settings modal displaying every config key with its effective value and source (`default`, `config-file`, or `env`).

#### Scenario: Modal opens in a TUI session

- **GIVEN** the user is in a TUI session (`ctx.mode === "tui"`)
- **WHEN** the user runs `/cgc config`
- **THEN** an interactive modal opens rendering every config key with its effective value and per-key source annotation

#### Scenario: Modal reflects on-disk state at open time

- **GIVEN** the user has hand-edited `.pi/cgc.json` since the session started
- **WHEN** the user runs `/cgc config`
- **THEN** the modal shows the values resolved from a fresh config load at open time, including the current per-key sources, not the extension's process-lifetime cached view

### Requirement: Validated editing of file-layer-writable keys

Rule: The modal SHALL allow editing every config key except those whose effective value is sourced from the environment, and SHALL validate every edit with the same rules `extensions/config.ts` applies on load (booleans; `worktree.mode` ∈ {off, isolate}; timeouts as positive milliseconds; port as an integer 1–65535; byte budgets as positive whole numbers; sync counts as positive integers; executable as a non-empty string). Invalid input MUST be rejected inside the modal and MUST NOT reach the write path.

#### Scenario: Cycling a boolean key

- **GIVEN** the modal is open with `lifecycle.autoCreate` currently `off`
- **WHEN** the user cycles that key
- **THEN** the staged value flips to `on` and is marked as a pending edit

#### Scenario: Entering an out-of-range port

- **GIVEN** the user is editing `cgc.api.port`
- **WHEN** the user enters `99999`
- **THEN** the modal rejects the input with a message matching the loader's rule (a TCP port between 1 and 65535) and stages no change for that key

#### Scenario: Setting the executable path

- **GIVEN** the user is editing `cgc.executable`
- **WHEN** the user enters a non-empty path string
- **THEN** the value is staged; an empty input is rejected

#### Scenario: Invalid input never reaches disk

- **GIVEN** the user staged an invalid value that was rejected
- **WHEN** the user saves
- **THEN** the rejected value is not written to any config file

### Requirement: Env-overridden keys are read-only

Rule: For any key whose effective source is `env`, the modal SHALL render the key read-only, naming the winning environment variable, and MUST NOT offer an edit for it.

#### Scenario: Env override wins

- **GIVEN** `CGC_OUTPUT_MAX_BYTES` is set in the environment
- **WHEN** the user views `output.maxBytes` in the modal
- **THEN** the key shows the env value with the variable name and cannot be edited in the modal

### Requirement: Layer-targeted never-clobber persistence

Rule: The modal SHALL let the user choose the write target for the staged edits — the project `.pi/cgc.json` (default) or the global agent-directory `cgc.json` resolved by `resolvePiAgentDir` — and a save MUST merge only the edited nested keys into the chosen file: existing unknown sections and keys are preserved verbatim; a target file that is unreadable, not a JSON object, or whose touched sections are not objects MUST be refused with a warning and left unmodified; writes MUST be atomic (temp file + rename).

#### Scenario: Saving to the project layer

- **GIVEN** the user staged `lifecycle.autoCreate = on` with the Project target selected
- **WHEN** the user saves
- **THEN** `.pi/cgc.json` is written containing the `lifecycle.autoCreate` key, and any other content already in the file is unchanged

#### Scenario: Saving to the global layer

- **GIVEN** the user selected the Global target
- **WHEN** the user saves
- **THEN** the write lands in the agent directory resolved by `resolvePiAgentDir` (honoring `PI_CODING_AGENT_DIR` when set)

#### Scenario: Unknown keys survive a save

- **GIVEN** the project `.pi/cgc.json` contains a `customSection` key this extension does not know
- **WHEN** the user saves a staged edit to that file
- **THEN** `customSection` is still present and unmodified after the write

#### Scenario: Malformed target file is refused

- **GIVEN** the selected target file exists but is not valid JSON
- **WHEN** the user saves
- **THEN** nothing is written, the file is left untouched, and the user sees a warning naming the refusal

#### Scenario: Interrupted save leaves no partial file

- **GIVEN** a save is in progress to either target
- **WHEN** the write is interrupted or fails
- **THEN** the target file is either fully updated or fully unchanged (atomic temp-file rename), never partially written

### Requirement: Honest next-session effect semantics

Rule: The extension MUST NOT claim live application of saved changes: after a successful save the modal and its completion notice SHALL state that changes take effect at the next session start, and the running session's behavior MUST remain unchanged until then.

#### Scenario: Successful save announces the restart boundary

- **GIVEN** the user saved staged edits successfully
- **WHEN** the modal closes
- **THEN** the user sees a notice that the changes apply at the next session start

#### Scenario: Running session behavior is unchanged

- **GIVEN** the user saved `freshness.watch = on` in a running session
- **WHEN** the session continues without restart
- **THEN** the extension's running components keep their previously loaded behavior

### Requirement: Headless degradation

Rule: Outside TUI mode the `/cgc config` verb MUST NOT attempt any interactive UI and SHALL instead render a read-only table of every config key with its effective value and source, pointing at the two config file paths.

#### Scenario: Headless invocation

- **GIVEN** the session runs in print/JSON/RPC mode (`ctx.mode !== "tui"`)
- **WHEN** the user (or tooling) runs `/cgc config`
- **THEN** the output is a read-only key/value/source summary naming the project and global config paths, and no modal, dialog, or file write occurs

### Requirement: Fail-open modal behavior

Rule: Modal and persistence failures MUST NOT crash or block the session: any UI, rendering, or filesystem failure degrades to a bounded notice and the command returns cleanly. The modal registers no agent tools and spawns no processes.

#### Scenario: UI failure degrades to a notice

- **GIVEN** the overlay modal cannot be constructed or the UI surface throws
- **WHEN** the handler handles `/cgc config`
- **THEN** the user sees a bounded warning notice and the session continues normally

#### Scenario: Filesystem failure on save

- **GIVEN** the target directory or file cannot be written (permissions, disk error)
- **WHEN** the user saves
- **THEN** the user sees a warning naming the failure, no file is modified, and the session continues normally
