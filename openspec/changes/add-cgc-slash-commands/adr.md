# ADR Review Manifest

- Status: completed
- Review date: 2026-09-06

## Review Summary

ADR review completed for this change.

## In-Force ADRs Reviewed

- `adr/0001-cgc-binary-only-integration.md` (Proposed, in force — not superseded): commands spawn `cgc` only through the shared runner; skip-as-busy lock policy reused by `/cgc sync`; no query tools registered by this change.
- `adr/0002-readiness-gated-nonconfigurable-guidance.md` (Proposed, in force — not superseded): unaffected by this change; commands are human-facing and do not touch the guidance readiness predicate or injection contract.

## New Durable ADRs Created

- `adr/0003-confirmation-gated-destructive-actions.md` — Destructive `cgc` actions require in-session confirmation; deletion verbs are never exposed (Nygard format; Status: Proposed). Establishes the consent model (non-destructive actions run freely; force rebuild and report file-writes confirm; `ALLOW_DB_DELETION`-gated verbs never surface) that all future extension surfaces must inherit.
