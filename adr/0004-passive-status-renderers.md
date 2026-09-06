# ADR-0004: Status surfaces are passive renderers — no spawns, no polling, no agent-context writes

## Status

Proposed

## Date

2026-09-06

## Context

The `pi-codegraphcontext` extension renders human-facing status surfaces (the persistent TUI chip and per-session warnings) derived from lifecycle and freshness state. Reference-extension experience shows two failure modes for such surfaces: displays that trigger their own `cgc` invocations can collide with the single-process embedded backends the lifecycle gate carefully avoids (ADR-0001's skip-as-busy policy exists precisely because of lock contention), and any code path that writes into the agent's context becomes part of the guidance contract (ADR-0002) rather than a cosmetic layer. Headless/CI sessions must be entirely unperturbed by cosmetic code.

## Decision

Every status/display surface in the extension is a passive renderer: it subscribes to state updates and renders on change only. Display modules are structurally denied access to the `cgc` command runner (module boundary enforced by lint/test), never poll on timers, never spawn processes, and never write to the agent's context or prompt. In headless/non-TUI operation the display module deactivates entirely; session-level warnings ride the lifecycle gate's existing one-time notice path rather than TUI-specific surfaces. Optional detail (for example, backend name) is rendered only from data already captured by existing probes.

## Consequences

- Positive: displays can never cause lock contention, redundant work, or per-session invocation churn — the class of bugs the lifecycle gate exists to prevent is structurally impossible from a renderer.
- Positive: the agent's context remains exactly as specified by the guidance and proactive-injection changes; display code cannot leak into prompts.
- Positive: headless/CI behavior is unchanged by cosmetic code by construction.
- Negative: the chip can only be as informative as the state already captured (for example, no backend detail if no probe captured it); enriching display data requires extending the probe, not the display.
- Negative: event-driven rendering depends on the state layer emitting transitions reliably; a missed transition shows until the next one (accepted: transitions are frequent and cheap).
- Follow-up: future surfaces (output shaping, proactive notes) must keep rendering logic inside this passive boundary and route any agent-visible content through the guidance/injection contracts instead.
