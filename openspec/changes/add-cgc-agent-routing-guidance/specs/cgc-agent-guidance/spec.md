## ADDED Requirements

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

### Requirement: Opt-in routing skill

Rule: The extension SHALL provide a routing skill containing deeper CGC onboarding content, and the skill SHALL be disabled by default.

#### Scenario: Skill disabled by default

- **GIVEN** a default installation with no routing-skill opt-in
- **WHEN** a session starts
- **THEN** the routing skill is not offered to the agent

#### Scenario: Skill enabled

- **GIVEN** the user has opted in to the routing skill
- **WHEN** a session starts with guidance ready
- **THEN** the agent can consult the routing skill for tool-choice-by-intent, backend caveats, the CGC path sandbox, and indexing basics

#### Scenario: Skill discoverability is evaluated at discovery time

- **GIVEN** the user has opted in to the routing skill and guidance was not ready when the session's skill discovery ran
- **WHEN** guidance readiness first becomes true later in the same session
- **THEN** the routing skill's discoverability is not changed retroactively mid-session; it is offered at a discovery evaluation only when the opt-in flag is set and guidance is ready

### Requirement: Fail-open guidance delivery

Rule: Guidance delivery failures MUST NOT affect the agent session, and a failing injection SHALL NOT be retried more than once per session.

#### Scenario: Injection error is contained

- **GIVEN** the guidance injection fails (for example, the prompt mechanism rejects the payload)
- **WHEN** the session continues
- **THEN** the error is recorded, the agent loop is unaffected, and the extension does not retry the injection more than once in the session
