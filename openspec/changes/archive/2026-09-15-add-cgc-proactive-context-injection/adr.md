# ADR Review Manifest

- Status: completed
- Review date: 2026-09-06

## Review Summary

ADR review completed for this change.

## In-Force ADRs Reviewed

- `adr/0001-cgc-binary-only-integration.md` (Proposed, in force): the coverage note is built without new spawns; no runner semantics change.
- `adr/0002-readiness-gated-nonconfigurable-guidance.md` (Proposed, in force): this change is the sanctioned second writer of agent-visible content — it reuses the readiness predicate, never touches the routing card's non-configurability, and keeps content classes disjoint (enforced by test).
- `adr/0003-confirmation-gated-destructive-actions.md` (Proposed, in force): unaffected; no actions introduced.
- `adr/0004-passive-status-renderers.md` (Proposed, in force): annotations decorate extension outputs at their production points; renderer modules remain passive.
- `adr/0005-universal-output-policy-pipeline.md` (Proposed, in force): annotated outputs are pipeline-cleaned data; the injection module adds no raw-capture access.
- `adr/0006-cli-gap-tools-boundary.md` (Proposed, in force): annotations may decorate CLI-gap tool outputs; no new tools registered.
- `adr/0007-lazy-freshness-default-watchers-optin.md` (Proposed, in force): steers consume freshness state transitions; no new watchers or syncs triggered by this change.
- `adr/0008-worktree-isolation-via-named-contexts.md` (Proposed, in force): unaffected; the coverage note describes whatever context the lifecycle resolved.

## New Durable ADRs Created

- `adr/0009-two-tier-proactive-injection.md` — Proactive injection is two-tier: default-on session coverage note, opt-in drift steers and result annotations (Nygard format; Status: Proposed). Codifies the recorded configuration split, the readiness-predicate reuse, the disjoint-content-class rule, and the MCP-results-out-of-scope boundary (a recorded decision, not a platform limitation — the harness's `tool_result` event exists but is rejected as a surprising annotation surface; the ADR text is to be aligned via task 3.5).
