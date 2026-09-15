# ADR Review Manifest

- Status: completed
- Review date: 2026-09-06

## Review Summary

ADR review completed for this change.

## In-Force ADRs Reviewed

- `adr/0001-cgc-binary-only-integration.md` (Proposed, in force): tools execute only through the shared runner; ADR-0001's "extension registers no graph query tools" is preserved — these are management verbs with no MCP equivalent.
- `adr/0002-readiness-gated-nonconfigurable-guidance.md` (Proposed, in force): unaffected; tools are agent-invoked on demand, not injected guidance.
- `adr/0003-confirmation-gated-destructive-actions.md` (Proposed, in force): bundle export (file write) and context delete (config mutation) sit behind the shared consent layer; no `ALLOW_DB_DELETION`-gated verbs exposed.
- `adr/0004-passive-status-renderers.md` (Proposed, in force): unaffected; this change registers tools, not renderers.
- `adr/0005-universal-output-policy-pipeline.md` (Proposed, in force): all tool output returns through the policy pipeline; raw capture access stays inside the pipeline.

## New Durable ADRs Created

- `adr/0006-cli-gap-tools-boundary.md` — CLI-gap verbs become agent tools; MCP-covered verbs never do (Nygard format; Status: Proposed). Establishes the curated three-tool boundary, the default-on/opt-out posture, the structured error contract, and the mechanical deprecation path when the MCP catalog catches up.
