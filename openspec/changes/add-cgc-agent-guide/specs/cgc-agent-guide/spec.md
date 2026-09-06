## ADDED Requirements

### Requirement: Shipped intent-first guide

Feature: `cgc-agent-guide`
Rule: The extension repository SHALL include `docs/agent-guide.md`, organized intent-first (by the question being asked, not by tool listing), covering every extension surface.

#### Scenario: Guide is present

- **GIVEN** the extension repository at a released state
- **WHEN** a reader looks for agent documentation
- **THEN** `docs/agent-guide.md` exists and opens with the intent-first routing guidance

### Requirement: Intent-to-surface coverage

Rule: The guide MUST document the choice of surface for each intent class: relationship questions (callers, callees, chains, impact, dead code, complexity) map to CGC MCP graph tools; exact-string and known-file work maps to built-in search and file reading; status and freshness questions map to `/cgc` slash commands; bundle export, named-context management, and diagnostics map to CLI-gap tools; index creation maps to the automatic lifecycle gate with manual overrides.

#### Scenario: Relationship intent is routed to graph tools

- **GIVEN** the guide's routing section
- **WHEN** a reader looks up "who calls this function / what will my change affect"
- **THEN** the guide names the CGC MCP graph relationship tools as the surface

#### Scenario: Exact-string intent stays with built-in search

- **GIVEN** the guide's routing section
- **WHEN** a reader looks up "find this literal string in this file"
- **THEN** the guide names built-in search and file reading as the surface and does not route it to graph tools

#### Scenario: Status and freshness intents route to slash commands

- **GIVEN** the guide's routing section
- **WHEN** a reader looks up "is the graph fresh / what state is the index in"
- **THEN** the guide names the `/cgc status` and `/cgc sync` commands as the surface

#### Scenario: Management intents route to CLI-gap tools

- **GIVEN** the guide's routing section and the CLI-gap tools enabled
- **WHEN** a reader looks up "export a bundle / manage named contexts / run diagnostics"
- **THEN** the guide names the corresponding CLI-gap tool as the surface

#### Scenario: Indexing intent explains the automatic path

- **GIVEN** the guide's routing section
- **WHEN** a reader looks up "how does the index get created and updated"
- **THEN** the guide describes the session-start lifecycle gate and the freshness auto-sync as the automatic path, with `/cgc index` and `/cgc sync` as manual overrides

### Requirement: Worked example session

Rule: The guide MUST include at least one worked end-to-end example session whose named surfaces all exist in the implementation.

#### Scenario: Example session is present and real

- **GIVEN** the guide's example section
- **WHEN** a reader follows the example from question to surface to outcome
- **THEN** every surface named in the example exists in the extension (verified by the accuracy test)

### Requirement: Accuracy coupling

Rule: The guide MUST be covered by an accuracy test that asserts every extension surface it names (tools, commands, config keys) exists in the implementation, and SHALL carry a scope line naming the supported CGC version range.

#### Scenario: Accuracy test holds on current surfaces

- **GIVEN** the current implementation and the guide
- **WHEN** the accuracy test runs
- **THEN** every surface named in the guide resolves to an implemented tool, command, or config key

#### Scenario: Renamed surface fails the test

- **GIVEN** a surface named in the guide is renamed or removed without updating the guide
- **WHEN** the accuracy test runs
- **THEN** the test fails, blocking silent documentation drift

### Requirement: Discovery links

Rule: The repository README SHALL link the guide, and the opt-in routing skill SHALL reference it as the deep-dive continuation without duplicating its content.

#### Scenario: README links the guide

- **GIVEN** the repository README
- **WHEN** a reader looks for documentation
- **THEN** a link to `docs/agent-guide.md` is present

#### Scenario: Routing skill references the guide

- **GIVEN** the opt-in routing skill content
- **WHEN** a reader wants deeper material
- **THEN** the skill points to the agent guide rather than repeating it
