## 1. Tier 1 — session-start coverage note (default on)

- [ ] 1.1 Implement config key `proactive.sessionNote` (default true) with an environment-variable override.
- [ ] 1.2 Implement the coverage note builder from cached probe data (repositories, languages, symbol counts when available, snapshot time, supported-CGC scope line), hard length cap asserted by test, graceful degradation when counts are missing, zero new spawns.
- [ ] 1.3 Wire one-shot injection at readiness through a `before_agent_start` handler returning the chained system prompt (same documented mechanism as the routing card), at most once per session.

## 2. Tier 2 — opt-in intrusive surfaces

- [ ] 2.1 Implement `proactive.driftSteers` (default false) with an environment-variable override: one agent-facing steer per fresh→possibly-stale episode, driven by freshness state transitions, naming `/cgc sync`; never fires when disabled.
- [ ] 2.2 Implement `proactive.resultAnnotations` (default false) with an environment-variable override: one-line freshness annotation on extension-owned tool and command outputs only; semantics untouched; never on CGC MCP server results.

## 3. Contract compliance and verification

- [ ] 3.1 Implement the structural duplication test: tier content classes disjoint from the routing card; readiness predicate shared with the guidance module; fail-open retry cap of one per session for every tier.
- [ ] 3.2 Test the full gating matrix (readiness × three tier settings), once-per-session and once-per-episode semantics, opt-out behavior, and failure containment.
- [ ] 3.3 Verify all scenarios in `specs/cgc-proactive-notes/spec.md` against the implementation.
- [ ] 3.4 Run `openspec validate add-cgc-proactive-context-injection --type change --strict` before archive.
- [ ] 3.5 Finalize `adr/0009-two-tier-proactive-injection.md` (already drafted during change authoring; Status: Proposed): review its Context so the MCP-results-out-of-scope boundary is recorded as a deliberate decision (the harness-documented `tool_result` event exists but is rejected as a surprising annotation surface), not a platform limitation.
