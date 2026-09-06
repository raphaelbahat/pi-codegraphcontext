## 1. Guidance content

- [ ] 1.1 Author the compact always-on guideline card (hard budget ~10 lines, asserted by a test): graph-vs-text routing rules with tool-name-agnostic primary phrasing, exact-string exceptions, and a supported-CGC-version scope line.
- [ ] 1.2 Author the opt-in routing skill content: tool-choice-by-intent, backend fuzzy-search caveats, the `CGC_ALLOWED_ROOTS` path sandbox, and indexing basics (adapted from CGC's published Cursor skill).
- [ ] 1.3 Add the config key `guidance.routingSkill` (default `false`) with an environment-variable override, read via the documented `pi.registerFlag`/`pi.getFlag` pattern (or a direct settings-file read); deliberately add no key controlling the always-on guidelines.

## 2. Readiness gating and delivery

- [ ] 2.1 Implement the readiness predicate over the lifecycle state from `add-cgc-session-lifecycle-gate` (ready for clean/drift/syncing/indexing; suppressed for unavailable/unindexed/busy/corrupt), degrading to permanently suppressed when that change is absent.
- [ ] 2.2 Implement one-shot guideline injection through a `before_agent_start` handler returning the chained system prompt (`systemPrompt: event.systemPrompt + guidance card`), per installed `docs/extensions.md` — with at-most-once semantics including mid-session readiness transitions.
- [ ] 2.3 Implement fail-open delivery: guard all hook bodies, record errors, cap retries at one per session, never block the agent loop.
- [ ] 2.4 Ship the routing skill via the package manifest (`"pi": { "skills": [...] }`) and gate its exposure on the opt-in flag through the `resources_discover` event (returning `skillPaths` only when enabled), so it is offered to the agent only when enabled and guidance is ready.

## 3. Verification and closure

- [ ] 3.1 Test the gating matrix across all lifecycle states, the mid-session readiness transition, and the at-most-once injection property.
- [ ] 3.2 Test the no-opt-out property (no config key disables guidelines alone) and the fail-open retry cap.
- [ ] 3.3 Verify all scenarios in `specs/cgc-agent-guidance/spec.md` against the implementation.
- [ ] 3.4 Run `openspec validate add-cgc-agent-routing-guidance --type change --strict` before archive.
