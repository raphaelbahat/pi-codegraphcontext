# ADR Review Manifest

- Status: completed
- Review date: 2026-09-06

## Review Summary

ADR review completed for this change.

## In-Force ADRs Reviewed

- `adr/0001-cgc-binary-only-integration.md` (Proposed, in force): this change modifies the runner's capture pipeline only; spawn semantics, fail-open posture, and cleanup paths are unchanged and reused (spill cleanup rides the multi-path teardown).
- `adr/0002-readiness-gated-nonconfigurable-guidance.md` (Proposed, in force): the pipeline introduces no agent-context content; what surfaces inject remains governed by the guidance contract.
- `adr/0003-confirmation-gated-destructive-actions.md` (Proposed, in force): unaffected; the policy adds no actions.
- `adr/0004-passive-status-renderers.md` (Proposed, in force): the pipeline lives in the runner (not in display modules); renderers remain pure consumers of cleaned output.

## New Durable ADRs Created

- `adr/0005-universal-output-policy-pipeline.md` — All wrapped `cgc` output flows through one universal policy pipeline in the runner (strip → redact → bound+spill), fail-open, with spill files session-scoped in the OS temp directory and GCF passthrough via CGC's documented fallback (Nygard format; Status: Proposed). Establishes the output contract every current and future surface inherits.
