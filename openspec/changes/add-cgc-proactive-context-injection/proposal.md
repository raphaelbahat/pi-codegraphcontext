## Why

Reactive tools wait for the agent to ask; proactive context does the retrieval for it. The extension already holds the two facts an agent needs before its first graph question — that an index exists (readiness) and what it covers (languages, symbol counts) — and the freshness work tracks when that coverage ages. This change closes the loop with two tiers of proactive injection in `pi-codegraphcontext`, with the configuration split recorded by project decision: the quiet session-start coverage note is enabled by default (opt-out), while agent-intrusive surfaces — per-turn drift steers and result annotations — are opt-in (disabled by default).

## What Changes

- Tier 1 — session-start coverage note (enabled by default, `proactive.sessionNote` opt-out): a single capped paragraph injected at most once per session when guidance is ready, summarizing what the graph covers for the active workspace (indexed repositories, languages, symbol counts when the cached probe captured them, the coverage snapshot time, and the supported CGC scope line). Derived entirely from already-captured probe data — no new spawns.
- Tier 2a — drift steers (opt-in, `proactive.driftSteers` default false): when freshness transitions to possibly-stale, inject one agent-facing steer per staleness episode (not per turn), pointing at `/cgc sync` and the freshness state. Consumes the freshness state from `add-cgc-freshness-drift-sync`; disabled means never.
- Tier 2b — result annotations (opt-in, `proactive.resultAnnotations` default false): one-line freshness annotations appended to the extension's own tool and command outputs (e.g., `/cgc doctor`, CLI-gap tools) when staleness is relevant. The extension cannot intercept the CGC MCP server's results — annotations deliberately scope to surfaces the extension owns.
- Contract compliance: all injection reuses the readiness predicate from ADR-0002 (nothing fires when `cgc` is unavailable or the index is absent), stays fail-open and time-boxed, never blocks the loop, and never duplicates the routing guideline card's content (different content class: coverage facts, not routing rules).
- Deferred decision (recorded, not implemented): deeper proactive curation (Fovea-style per-turn maps) — future consideration only; this change's tiers are the recorded scope.

## Capabilities

### New Capabilities

- `cgc-proactive-notes`: two-tier proactive context injection — the default-on session-start coverage note and the opt-in drift steers and result annotations — composed from readiness and freshness state under the guidance contract.

### Modified Capabilities

(none — no existing capabilities; `openspec/specs/` is empty)

## Impact

- Extension package `pi-codegraphcontext`; injects through Pi's documented prompt-guideline mechanism (same surface as the routing guidelines) and annotates only extension-owned outputs.
- Consumes readiness (lifecycle state) and freshness state; degrades to silent when either is unavailable.
- Config keys: `proactive.sessionNote` (default true), `proactive.driftSteers` (default false), `proactive.resultAnnotations` (default false) — each with environment-variable overrides.
- No changes to CodeGraphContext or the MCP server; no interception of MCP tool results (outside the extension's control by design).
