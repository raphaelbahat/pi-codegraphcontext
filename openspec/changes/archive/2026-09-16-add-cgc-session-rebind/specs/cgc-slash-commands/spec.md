# cgc-slash-commands — Spec Delta

## ADDED Requirements

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
