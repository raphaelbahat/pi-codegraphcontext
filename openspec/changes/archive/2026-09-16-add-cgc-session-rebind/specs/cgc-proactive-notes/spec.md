# cgc-proactive-notes — Spec Delta

## ADDED Requirements

### Requirement: Proactive tiers rebind on session replacement

Rule: When Pi replaces the session and re-runs the extension factory with a fresh API instance, the coverage-note, drift-steer, and result-annotation tiers SHALL re-bind their hooks to the new session's API — each tier's one-shot-per-session behavior re-arms for the new session, and a tier disabled by config still subscribes to nothing. Same-API registration SHALL remain a single, idempotent registration.

#### Scenario: A resumed session receives the coverage note

- **GIVEN** the session-start coverage note fired in an earlier session and the user replaces it via `/resume`
- **WHEN** the new session's first turn with the readiness predicate satisfied runs
- **THEN** the coverage note is injected once in the new session (the `before_agent_start` handler is registered on the new API) — the one-shot is per session, not per process

#### Scenario: Opt-in tiers stay silent when disabled across a rebind

- **GIVEN** `proactive.driftSteers` / `proactive.resultAnnotations` are disabled
- **WHEN** a session is replaced and the tiers re-register on the new API
- **THEN** the disabled tiers subscribe to nothing and never fire in the resumed session (the specified degradation is unchanged)

#### Scenario: Same-API re-registration adds no duplicate hook

- **GIVEN** the extension factory is invoked twice with the same API instance
- **WHEN** each tier's registration runs twice
- **THEN** each hook is wired exactly once — no duplicate injections or annotations
