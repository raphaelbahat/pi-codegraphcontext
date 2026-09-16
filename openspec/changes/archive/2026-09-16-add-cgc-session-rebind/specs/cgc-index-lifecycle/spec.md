# cgc-index-lifecycle — Spec Delta

## ADDED Requirements

### Requirement: Session replacement rebinds the gate and the teardown sweep

Rule: When Pi replaces the session (`/resume`, `/new`, `/fork`, `/reload`) and re-runs the extension factory with a fresh API instance, the lifecycle gate and the multi-path teardown sweep SHALL re-bind to the new session's API — the resumed session receives a full session-start evaluation, and the new session's `session_shutdown` and process teardown paths remain armed. Re-registration on the same API SHALL remain a single, idempotent registration (no duplicate hooks).

#### Scenario: A resumed session gets a gate evaluation

- **GIVEN** an earlier session ran with the gate live and the user replaces it via `/resume`
- **WHEN** the new session's `session_start` fires
- **THEN** the gate evaluates the workspace on the new session (the lifecycle state is recorded) and any availability or state notices flow to the new session's UI, instead of the gate staying dormant on the replaced session's API

#### Scenario: The teardown sweep survives a session replacement

- **GIVEN** a session is replaced while the extension holds tracked `cgc` children
- **WHEN** the new session later shuts down or the process exits
- **THEN** the teardown sweep terminates the extension's tracked children exactly once per path (the old installation is disposed before the new one is installed; no duplicated `exit`/signal listeners)

#### Scenario: Same-API registration stays idempotent

- **GIVEN** the extension factory is invoked twice with the same API instance
- **WHEN** each guarded surface's registration runs
- **THEN** each hook is wired exactly once — no duplicate handlers are registered

#### Scenario: Cross-session state survives the rebind

- **GIVEN** the shared runner holds tracked children and the process-lifetime stores hold recorded snapshots from earlier sessions
- **WHEN** a session replacement rebinds the surfaces
- **THEN** the runner's child tracking and the process-lifetime stores are preserved (the same runner instance keeps sweeping; recorded snapshots remain readable), while the per-session budgets, one-shot flags, and once-per-session notice markers re-arm for the new session
