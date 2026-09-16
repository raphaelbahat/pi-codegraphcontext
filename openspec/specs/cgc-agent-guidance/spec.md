# cgc-agent-guidance Specification

## Purpose
Publishes an always-on routing guideline card (graph-vs-text tool choice) plus an opt-in routing skill so agents consistently reach for CGC relationship queries when they help and stay with built-in search for exact-string work.

## Requirements

### Requirement: Always-on routing guidelines

Rule: The extension SHALL inject a compact, always-on set of routing guidelines into the agent's context whenever guidance is ready, and the guidelines SHALL have no configuration key or off switch of their own.

#### Scenario: Guidelines are injected when ready

- **GIVEN** the `cgc` binary is available and the active workspace's index exists or is being created
- **WHEN** the agent session is running
- **THEN** the routing guidelines are present in the agent's context

#### Scenario: Guidelines have no opt-out of their own

- **GIVEN** the extension is installed and enabled
- **WHEN** the user inspects the extension configuration
- **THEN** there is no setting that disables the routing guidelines alone (the only way to remove them is to disable or uninstall the extension)

### Requirement: Readiness gating of guidance

Rule: The extension MUST NOT inject routing guidelines before guidance is ready, and guidance is ready only when the `cgc` binary is available AND the active workspace's index exists or is being created.

#### Scenario: cgc binary missing

- **GIVEN** the `cgc` executable is not available
- **WHEN** a session starts
- **THEN** no routing guidelines are injected and the session proceeds normally

#### Scenario: Workspace has no index

- **GIVEN** the `cgc` binary is available but the active workspace has no CGC index and none is being created
- **WHEN** a session starts
- **THEN** no routing guidelines are injected and the session proceeds normally

#### Scenario: Index becomes ready mid-session

- **GIVEN** guidelines were withheld because the workspace was unindexed
- **WHEN** an index is created or detected later in the same session
- **THEN** the guidelines are injected at most once, without repeating on every turn

### Requirement: Advisory routing content

Rule: The guidelines MUST direct relationship-shaped questions (callers, callees, call chains, impact, dead code, complexity) toward graph queries, MUST NOT instruct the agent to avoid built-in search or file reading for exact-string work, and MUST NOT block or restrict any tool.

#### Scenario: Relationship question routes to the graph

- **GIVEN** the guidelines are injected and the user asks which code calls a function
- **WHEN** the agent chooses a tool
- **THEN** the guidance it received names graph relationship queries as the appropriate approach for that shape of question

#### Scenario: Exact-string work stays with built-in search

- **GIVEN** the guidelines are injected and the user asks to find a literal string in a known file
- **WHEN** the agent chooses a tool
- **THEN** the guidance it received does not steer that work away from built-in search or file reading

### Requirement: Opt-out routing skill

Rule: The extension SHALL provide a routing skill containing deeper CGC onboarding content, and the skill SHALL be enabled by default (opt-out via `guidance.routingSkill: false` or `CGC_GUIDANCE_ROUTING_SKILL=0`).

#### Scenario: Skill enabled by default

- **GIVEN** a default installation with no routing-skill opt-out
- **WHEN** a session starts
- **THEN** the routing skill is offered to the agent

#### Scenario: Skill opted out

- **GIVEN** the user has opted out of the routing skill
- **WHEN** a session starts
- **THEN** the routing skill is not offered to the agent

#### Scenario: Skill enabled

- **GIVEN** the user has opted in to the routing skill
- **WHEN** a session starts with guidance ready
- **THEN** the agent can consult the routing skill for tool-choice-by-intent, backend caveats, the CGC path sandbox, and indexing basics

#### Scenario: Skill model-invocable and user-executable when enabled

- **GIVEN** the routing skill is enabled (the default)
- **WHEN** skill discovery runs
- **THEN** the skill is contributed regardless of guidance readiness at discovery time, is model-invocable (the agent can pull the deep routing content autonomously), and is user-executable via `/skill:cgc-routing`

#### Scenario: Agent-side availability follows readiness per turn

- **GIVEN** the routing skill is enabled and guidance was not ready at discovery
- **WHEN** guidance readiness first becomes true later in the same session
- **THEN** the agent-facing routing pointer is injected on the first ready turn (per-turn evaluation, never a discovery-time race)

### Requirement: Fail-open guidance delivery

Rule: Guidance delivery failures MUST NOT affect the agent session, and a failing injection SHALL NOT be retried more than once per session.

#### Scenario: Injection error is contained

- **GIVEN** the guidance injection fails (for example, the prompt mechanism rejects the payload)
- **WHEN** the session continues
- **THEN** the error is recorded, the agent loop is unaffected, and the extension does not retry the injection more than once in the session

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
