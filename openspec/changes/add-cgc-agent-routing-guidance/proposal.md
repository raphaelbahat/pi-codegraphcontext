## Why

CodeGraphContext's MCP tools carry no "when to use me" guidance, so agents either fall back to grep-style habits and under-use the graph, or reach for graph tools they have not verified exist. CGC ships an agent-facing skill for Cursor, but Pi has no equivalent. This change adds the extension's guidance layer to `pi-codegraphcontext`: always-on routing rules that steer tool choice correctly, plus a deeper opt-in skill for users who want full onboarding material.

## What Changes

- Always-on, gated prompt guidelines (enabled and non-configurable by decision): a compact set of routing rules injected into the agent's context via Pi's documented prompt-guideline mechanism, teaching when graph queries beat text search (callers/callees, call chains, blast radius, dead code, complexity) and when built-in grep/read remains correct (exact strings, known files, generated files).
- Readiness gating: guidelines are injected only after the `cgc` binary is available AND an index exists or is being created (reusing the lifecycle state from `add-cgc-session-lifecycle-gate`); injecting guidance for nonexistent capabilities is the documented failure mode this gate prevents.
- Opt-in routing skill (disabled by default): a Pi skill with richer onboarding content — tool-choice-by-intent guidance, backend caveats (fuzzy-search semantics per backend), the `CGC_ALLOWED_ROOTS` path sandbox, and indexing basics — for users who enable it.
- Non-configurable by design: the always-on guidelines expose no config key and no off switch; this is a recorded project decision (correct routing is the point of the guidance layer), distinct from the opt-in skill.
- No tools are registered by this change, and no CGC source is modified; the CGC MCP server remains the query engine.

## Capabilities

### New Capabilities

- `cgc-agent-guidance`: readiness-gated agent routing guidance — the always-on guideline set and the opt-in routing skill — that steers tool selection between graph queries and text search without registering any tools.

### Modified Capabilities

(none — no existing capabilities; `openspec/specs/` is empty)

## Impact

- Extension package `pi-codegraphcontext` (same package as `add-cgc-session-lifecycle-gate`); uses Pi's prompt-guideline and skill mechanisms.
- Depends on the lifecycle state produced by `add-cgc-session-lifecycle-gate` for readiness gating (cross-change assumption; degrades to no-guidance if that change is absent).
- One-time content additions to the extension bundle (guideline text, skill file); no changes to CodeGraphContext, the MCP server, or MCP tool schemas.
- Config surface: a single opt-in flag for the routing skill (default off); deliberately no flag for the always-on guidelines.
