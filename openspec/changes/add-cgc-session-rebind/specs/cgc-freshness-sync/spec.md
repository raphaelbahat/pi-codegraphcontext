# cgc-freshness-sync — Spec Delta

## ADDED Requirements

### Requirement: Freshness observation rebinds on session replacement

Rule: When Pi replaces the session and re-runs the extension factory with a fresh API instance, the freshness drift observer SHALL re-bind its `session_start`/`session_shutdown`/`tool_call` hooks to the new session's API — file-modifying tool calls mark drift in the resumed session, and the per-session sync budget re-arms. The shared freshness state store persists across the rebind; same-API registration SHALL remain a single, idempotent registration.

#### Scenario: A resumed session marks drift

- **GIVEN** an earlier session was freshness-watched and the user replaces it via `/resume`
- **WHEN** a file-modifying tool call runs in the resumed session
- **THEN** the drift mark is recorded for the new session (the `tool_call` handler is registered on the new API) and the lazy auto-sync path can fire, instead of the observer staying dormant on the replaced session's API

#### Scenario: The sync budget re-arms per session

- **GIVEN** the outgoing session exhausted its `freshness.maxSyncsPerSession` budget
- **WHEN** the session is replaced and drift marks again in the new session
- **THEN** the new session has a fresh budget — the budget is per session, not per process

#### Scenario: Same-API re-registration adds no duplicate handler

- **GIVEN** the extension factory is invoked twice with the same API instance
- **WHEN** the observer's registration runs twice
- **THEN** each hook (`session_start`, `session_shutdown`, `tool_call`) is subscribed exactly once
