# ADR-0009: Proactive injection is two-tier — default-on coverage note, opt-in agent-intrusive surfaces

## Status

Proposed

## Date

2026-09-06

## Context

The extension holds two facts the agent needs before its first graph question — that an index exists and what it covers — plus a live staleness signal from the freshness capability (ADR-0007). Proactively injecting such context removes retrieval burden from the agent, but reference-extension experience (CKG) shows proactivity is valuable exactly until users perceive it as noise, and ADR-0002 established that agent-visible content must flow through sanctioned contracts: a shared readiness predicate, fail-open delivery, and content classes that never duplicate the non-configurable routing card. The project owner recorded the configuration split: the session-start coverage note is enabled by default with an opt-out, while drift steers and result annotations are opt-in (disabled by default). The extension also has no hook into the CGC MCP server's results — it cannot annotate another process's protocol output.

## Decision

Proactive injection is one module with two tiers. Tier 1 — the session-start coverage note — injects a single capped paragraph (repositories, languages, symbol counts when the lifecycle probe captured them, snapshot time, supported CGC scope) at most once per session, only when the guidance readiness predicate is true; it is enabled by default and disabled via `proactive.sessionNote`. Tier 2 — the agent-intrusive surfaces — is disabled by default and separately opt-in: drift steers (one per staleness episode, `proactive.driftSteers`) and one-line freshness annotations on the extension's own tool and command outputs (`proactive.resultAnnotations`), never on CGC MCP server results. All tiers reuse the ADR-0002 readiness predicate, are fail-open with a one-retry-per-session cap, and emit content disjoint from the routing card by construction and by test.

## Consequences

- Positive: every session starts with grounded coverage facts at bounded prompt cost, without any user setup — the highest-value proactivity carries the safe default.
- Positive: the intrusive surfaces exist for users who want them but cannot annoy anyone who did not opt in; each tier's default encodes its intrusiveness.
- Positive: the injection module composes with the guidance contract rather than competing with it — one readiness predicate, disjoint content classes, a structural duplication test.
- Negative: the coverage note's data is only as fresh as the cached probe (snapshot time is printed); keeping it live would require spawns the design forbids.
- Negative: three more configuration keys with interdependent semantics (tiers compose); documentation must make the tier split legible.
- Negative: annotations improve only extension-owned outputs — users may expect MCP results annotated and learn the boundary only from docs.
- Follow-up: deeper proactive curation (per-turn maps, Fovea-style) remains deferred; any such proposal must supersede this ADR and revisit the tier defaults rather than quietly extending them.
