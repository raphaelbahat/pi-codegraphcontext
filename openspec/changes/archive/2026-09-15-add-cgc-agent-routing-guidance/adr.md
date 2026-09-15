# ADR Review Manifest

- Status: completed
- Review date: 2026-09-06

## Review Summary

ADR review completed for this change.

## In-Force ADRs Reviewed

- `adr/0001-cgc-binary-only-integration.md` (Proposed, in force — not superseded): wrap-only integration, fail-open posture, no query tools registered. This design complies: guidance names MCP graph tools but registers none, and delivery is fail-open with a retry cap.

## New Durable ADRs Created

- `adr/0002-readiness-gated-nonconfigurable-guidance.md` — Agent guidance is readiness-gated, always-on, and non-configurable (Nygard format; Status: Proposed). Establishes the readiness predicate over the ADR-0001 lifecycle state, the one-shot injection contract, the advisory-only content rule, and the recorded configuration split (always-on guidelines without a config key; opt-in routing skill) that later changes must respect.
