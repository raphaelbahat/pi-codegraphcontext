# ADR Review Manifest

- Status: completed
- Review date: 2026-09-06

## Review Summary

ADR review completed for this change.

## In-Force ADRs Reviewed

- `adr/0001-cgc-binary-only-integration.md` (Proposed, in force): this display spawns nothing, consistent with wrap-only integration and skip-as-busy policy.
- `adr/0002-readiness-gated-nonconfigurable-guidance.md` (Proposed, in force): the display writes nothing to agent context, leaving the guidance contract untouched.
- `adr/0003-confirmation-gated-destructive-actions.md` (Proposed, in force): the chip exposes no actions; all actions remain in `/cgc` commands behind the consent layer.

## New Durable ADRs Planned

- `adr/0004-passive-status-renderers.md` (to be created during implementation) — Status surfaces are passive renderers: no spawns, no polling, no agent-context writes; structurally no runner access; headless no-op (Nygard format; Status: Proposed). Establishes the rendering boundary that all future display surfaces in this extension must inherit.
