## ADDED Requirements

### Requirement: Spawn-free worktree detection

Feature: `cgc-worktree-contexts`
Rule: The extension SHALL detect linked-git-worktree membership for the session working directory by inspecting the `.git` pointer file (a `gitdir:` reference into the repository's worktrees store) once per session and caching the result, using no `cgc` or `git` invocations for detection; main checkouts and non-git directories SHALL be reported as non-worktrees.

#### Scenario: Linked worktree is detected

- **GIVEN** the session working directory is a linked git worktree of some repository
- **WHEN** the extension resolves the workspace identity
- **THEN** it reports the worktree (repository common directory plus worktree identity) without spawning any process for detection

#### Scenario: Main checkout is not treated as a worktree

- **GIVEN** the session working directory is a repository's main checkout (a `.git` directory, not a pointer file)
- **WHEN** the extension resolves the workspace identity
- **THEN** it reports a non-worktree and no worktree behavior applies

### Requirement: Opt-in isolation through named contexts

Rule: When `worktree.mode` is `isolate`, the extension SHALL map each linked worktree to a dedicated CGC named context (`wt-` prefixed), create the context on demand under the same auto-create consent gate as the lifecycle, and carry the matching `--context` flag on every extension runner invocation for that workspace. When `worktree.mode` is `off` (the default), CGC's own context resolution SHALL apply unchanged.

#### Scenario: First session in a worktree with isolation enabled

- **GIVEN** `worktree.mode` is `isolate` and the worktree has no mapped context yet
- **WHEN** the session starts
- **THEN** the extension asks the auto-create consent question, and on consent creates the `wt-` context and indexes the worktree into it with the `--context` flag

#### Scenario: Consent declined in a worktree

- **GIVEN** `worktree.mode` is `isolate` and the user declines context creation
- **WHEN** the session continues
- **THEN** no context is created and no extension indexing runs for that worktree; the state says unindexed-pending-consent

#### Scenario: Subsequent session reuses the mapping

- **GIVEN** a worktree already has a mapped `wt-` context recorded with matching identity
- **WHEN** a new session starts in that worktree
- **THEN** the extension reuses the mapped context without asking again and all runner invocations carry its `--context` flag

#### Scenario: Default mode leaves CGC behavior unchanged

- **GIVEN** `worktree.mode` is `off`
- **WHEN** a session starts in any worktree
- **THEN** no worktree mapping, context creation, or flag injection occurs

### Requirement: Fail-closed identity checks

Rule: The extension MUST NOT use a mapped context whose recorded identity (repository common directory plus worktree identity) no longer matches the session's worktree; on mismatch it SHALL surface an identity-mismatch state and take no further extension action for that workspace until re-consented.

#### Scenario: Mismatched registration is refused

- **GIVEN** a `wt-` context exists but its recorded identity belongs to a different repository or worktree
- **WHEN** the session resolves the mapping
- **THEN** the extension reports an identity mismatch, performs no indexing or syncing against that context, and the session proceeds without silently-wrong graph data

### Requirement: Stale worktrees surface as notices, not deletions

Rule: When a mapped worktree directory no longer exists on disk (pruned), the extension SHALL surface a one-time notice naming the orphaned context and the cleanup command, and MUST NOT delete context registrations or database files on its own.

#### Scenario: Pruned worktree is noticed

- **GIVEN** a recorded mapping points at a worktree directory that no longer exists
- **WHEN** the extension evaluates its mappings
- **THEN** the user sees a one-time notice naming the orphaned context and the cleanup command, and nothing is deleted

#### Scenario: Cleanup stays manual

- **GIVEN** an orphaned context notice has been surfaced
- **WHEN** the user chooses to clean up
- **THEN** removal happens only through the user-driven CLI-gap context tool with its own confirmation, never autonomously

### Requirement: Fail-open containment

Rule: Worktree detection and mapping failures MUST NOT affect the agent session; the extension SHALL degrade to non-worktree behavior and cap retries at one per session.

#### Scenario: Detection errors are contained

- **GIVEN** the `.git` pointer file is unreadable or malformed
- **WHEN** the extension resolves the workspace identity
- **THEN** it records the error, degrades to non-worktree behavior, and the session proceeds normally
