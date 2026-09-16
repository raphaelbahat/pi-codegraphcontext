# cgc-status-display — Spec Delta

## ADDED Requirements

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
