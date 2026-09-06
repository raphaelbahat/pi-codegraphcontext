# ADR-0002: Agent guidance is readiness-gated, always-on, and non-configurable

## Status

Proposed

## Date

2026-09-06

## Context

The `pi-codegraphcontext` extension injects agent-facing routing guidance (when graph queries beat text search and vice versa). Two failure modes are documented by reference-extension research: guidance injected before the `cgc` binary and index are ready causes agents to call capabilities that do not exist (empty-result detours, hallucinated tool usage), and permanently injected prompt content adds overhead that users resent when they cannot see or control it. The project owner has recorded two configuration decisions for this layer: the compact routing guidelines are enabled and non-configurable, while the deeper routing skill is opt-in (disabled by default). This change builds on ADR-0001 (wrap-only integration; the extension registers no query tools; fail-open posture).

## Decision

Routing guidelines are injected at most once per session, only when a readiness predicate over the ADR-0001 lifecycle state is true (`cgc` available AND the workspace index exists or is being created). The guideline set is always-on and exposes no configuration key or off switch; the only removal path is disabling or uninstalling the extension. Deeper onboarding material ships as a separately opt-in skill (default off). Guidance content is advisory only: it must never block, restrict, or penalize any tool the agent could otherwise use, and delivery failures must never affect the agent session (retry cap: one per session).

## Consequences

- Positive: routing guidance is present exactly when it can be true, eliminating the hallucinated-guidance failure mode without user setup.
- Positive: prompt cost is bounded and predictable (compact always-on card; deep material only for opted-in users).
- Positive: later changes (proactive context notes, status surfaces) inherit a single, tested readiness predicate instead of re-deriving readiness.
- Negative: users who want zero prompt overhead cannot turn guidelines off alone — the escape hatch is disabling the whole extension; this trade-off is accepted by recorded project decision.
- Negative: guidance arriving mid-session (index created after start) is later than ideal; accepted because the alternative is guidance for nonexistent capabilities.
- Negative: guideline and skill content must track CGC CLI/MCP reality across versions; content is versioned with the extension and carries a supported-version scope line.
- Follow-up: the proactive context-injection change must reuse this readiness predicate and must not provide a bypass around the non-configurability decision.
