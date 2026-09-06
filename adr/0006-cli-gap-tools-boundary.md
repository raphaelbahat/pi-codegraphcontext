# ADR-0006: CLI-gap verbs become agent tools; MCP-covered verbs never do

## Status

Proposed

## Date

2026-09-06

## Context

The `pi-codegraphcontext` campaign's standing boundary is that the CGC MCP server is the graph query engine and the extension registers no re-wrapped query tools. However, CGC's 25-tool MCP catalog has verified management gaps: it cannot export bundles (only load/search), cannot manage named context workspaces (only discover/switch), and has no diagnostics command. Those verbs are CLI-only. The user restored this feature into scope with a lean toward "enabled by default (opt-out)", explicitly marked as not-final. Any tool the extension registers must coexist with the MCP catalog without inflating the agent's tool-selection burden — the campaign's core anti-pattern.

## Decision

The extension exposes exactly three agent tools — `cgc_bundle_export`, `cgc_context`, `cgc_doctor` — mapping one-to-one to documented CLI verbs that have no MCP equivalent. No generic passthrough tool exists. The tool set is enabled by default with a single opt-out flag (`tools.cliGap.enabled`). Consent classes follow ADR-0003 exactly (file writes and config-deleting mutations confirm; read-only and additive operations do not), every tool inherits the shared runner guardrails and output-policy pipeline, and every failure returns a structured, agent-actionable error code. A CI test asserts no name or behavior collision with the documented MCP catalog, and when a future CGC MCP release covers one of these verbs, the corresponding extension tool is retired in favor of the MCP tool.

## Consequences

- Positive: the agent gains the only CGC capabilities it previously could not reach, without duplicating anything the MCP server already provides.
- Positive: the tool surface stays three inspectable schemas instead of an unbounded CLI bridge; per-verb consent remains enforceable.
- Positive: drift is caught mechanically — the collision test fires if CGC's MCP catalog later covers these verbs, triggering the deprecation path instead of debate.
- Negative: three more tool names exist in the agent's catalog by default; users wanting a minimal surface must find the opt-out flag (documented in proposal and README).
- Negative: tool schemas track CLI verb shapes; CGC version drift requires maintenance (pinned supported range absorbs most of it).
- Negative: the recorded default (opt-out) is explicitly not final; flipping it to opt-in before apply is a one-line config change but resets discoverability expectations.
- Follow-up: thin convenience query tools (impact-before-edit, blast-radius) remain deferred and would violate this ADR's boundary if ever added while MCP covers the same queries; any such future proposal must supersede this ADR rather than quietly extend it.
