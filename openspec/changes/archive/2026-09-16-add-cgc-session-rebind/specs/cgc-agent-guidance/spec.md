# cgc-agent-guidance — Spec Delta

## ADDED Requirements

### Requirement: Guidance surfaces rebind on session replacement

Rule: When Pi replaces the session and re-runs the extension factory with a fresh API instance, the routing-card injector and the routing-skill exposure SHALL re-bind their hooks to the new session's API — the resumed session receives the always-on routing card when guidance is ready, and skill discovery contributes the routing skill again. Same-API registration SHALL remain a single, idempotent registration, and the one-shot-per-session injection budget SHALL re-arm for the new session.

#### Scenario: A resumed session receives the routing card

- **GIVEN** guidance was injected in an earlier session and the user replaces it via `/resume`
- **WHEN** the new session's first turn with guidance ready runs
- **THEN** the routing card is injected into the chained system prompt of the new session (the injector's hooks live on the new API), and the injection happens at most once in the new session

#### Scenario: A resumed session re-contributes the routing skill

- **GIVEN** the routing skill is enabled and a session is replaced via `/resume` or `/new`
- **WHEN** skill discovery runs in the new session
- **THEN** the routing skill is contributed on the new session's API (the `resources_discover` handler is registered there)

#### Scenario: Rebind failure never breaks the session

- **GIVEN** the new session's API rejects a hook registration during the rebind
- **WHEN** the factory re-runs for the replaced session
- **THEN** the failure is contained per surface (recorded, degraded to no guidance), extension load completes, and the agent loop is unaffected
