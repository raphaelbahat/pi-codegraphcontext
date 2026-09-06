## ADDED Requirements

### Requirement: Session-start coverage note (default on, opt-out)

Feature: `cgc-proactive-notes`
Rule: When guidance is ready and `proactive.sessionNote` is enabled (the default), the extension SHALL inject a single capped coverage paragraph into the agent's context at most once per session; it SHALL NOT inject the note when the setting is disabled or guidance is not ready.

#### Scenario: Note injected when ready and enabled

- **GIVEN** guidance is ready (CGC available, index exists or being created) and `proactive.sessionNote` is enabled
- **WHEN** the session starts
- **THEN** the agent's context contains exactly one coverage note for the session

#### Scenario: Opted out

- **GIVEN** `proactive.sessionNote` is disabled
- **WHEN** the session starts
- **THEN** no coverage note is injected

#### Scenario: Not ready

- **GIVEN** guidance is not ready (CGC unavailable, or no index and none being created)
- **WHEN** the session starts
- **THEN** no coverage note is injected

#### Scenario: Once per session

- **GIVEN** the coverage note was already injected this session
- **WHEN** readiness re-evaluates or turns continue
- **THEN** no second note is injected

### Requirement: Coverage note content and sourcing

Rule: The coverage note MUST be derived from already-captured probe data (no new `cgc` invocations for its content), MUST state the coverage snapshot time and the supported CGC scope, MUST NOT duplicate the routing guideline card's content, and SHALL degrade to a minimal form when symbol counts were not captured.

#### Scenario: Note reflects cached data without spawns

- **GIVEN** the lifecycle probe previously captured repository/language/symbol-count information
- **WHEN** the note is built
- **THEN** it summarizes that cached coverage and no `cgc` process is started to build it

#### Scenario: Graceful degradation without counts

- **GIVEN** the cached probe data lacks symbol counts
- **WHEN** the note is built
- **THEN** it states the index's presence and snapshot time without inventing counts

### Requirement: Drift steers (opt-in)

Rule: When `proactive.driftSteers` is enabled, the extension SHALL inject one agent-facing steer per staleness episode when freshness transitions to possibly-stale; when disabled (the default), it SHALL never inject steers.

#### Scenario: Enabled steer on staleness transition

- **GIVEN** `proactive.driftSteers` is enabled and freshness transitions from fresh to possibly-stale
- **WHEN** the transition is observed
- **THEN** one steer naming the staleness and the `/cgc sync` option is injected, and no further steer fires until the episode resolves

#### Scenario: Disabled means never

- **GIVEN** `proactive.driftSteers` is disabled (the default)
- **WHEN** freshness transitions occur
- **THEN** no steer is ever injected

### Requirement: Result annotations (opt-in, extension-owned outputs only)

Rule: When `proactive.resultAnnotations` is enabled, the extension MAY append a one-line freshness annotation to its own tool and command outputs; annotations MUST NOT alter result semantics, MUST appear only on extension-owned surfaces (never on CGC MCP server results), and when disabled (the default) no annotation appears.

#### Scenario: Annotation on an extension-owned output

- **GIVEN** `proactive.resultAnnotations` is enabled and freshness is possibly-stale
- **WHEN** an extension-owned command output is produced
- **THEN** a one-line annotation naming the staleness accompanies the output without changing its content

#### Scenario: Disabled means clean output

- **GIVEN** `proactive.resultAnnotations` is disabled (the default)
- **WHEN** extension outputs are produced
- **THEN** no annotations appear

#### Scenario: MCP results are out of scope

- **GIVEN** the CGC MCP server produces tool results
- **WHEN** annotations are enabled
- **THEN** the extension does not modify or annotate those results

### Requirement: Contract compliance for all tiers

Rule: Every injection tier MUST reuse the guidance readiness predicate, MUST be fail-open and time-boxed (never blocking or interrupting the agent loop), MUST cap failures at one retry per session, and MUST NOT bypass the guidance contract (ADR-0002) by writing agent-visible content outside this capability's defined mechanisms.

#### Scenario: Failures are contained

- **GIVEN** an injection attempt fails (payload rejected, mechanism unavailable)
- **WHEN** the session continues
- **THEN** the failure is recorded, the session is unaffected, and the tier does not retry more than once this session

#### Scenario: Tiers compose without duplication

- **GIVEN** the routing guidelines and the coverage note are both enabled
- **WHEN** the agent's context is assembled
- **THEN** both appear without overlapping or duplicating each other's content
