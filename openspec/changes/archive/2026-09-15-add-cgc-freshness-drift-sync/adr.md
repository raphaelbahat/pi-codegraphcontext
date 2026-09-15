# ADR Review Manifest

- Status: completed
- Review date: 2026-09-06

## Review Summary

ADR review completed for this change.

## In-Force ADRs Reviewed

- `adr/0001-cgc-binary-only-integration.md` (Proposed, in force): drift syncs and the watcher run through the shared runner; skip-as-busy and multi-path teardown are reused, not re-implemented.
- `adr/0002-readiness-gated-nonconfigurable-guidance.md` (Proposed, in force): this module writes nothing to agent context; the opt-in proactive-injection change is the only sanctioned consumer for agent-visible freshness content.
- `adr/0003-confirmation-gated-destructive-actions.md` (Proposed, in force): incremental indexing is non-destructive; no consent interactions introduced.
- `adr/0004-passive-status-renderers.md` (Proposed, in force): the freshness module is a state maintainer (it may spawn via the runner), while its notices follow the once-per-condition discipline renderers use.
- `adr/0005-universal-output-policy-pipeline.md` (Proposed, in force): sync/watcher output flows through the policy pipeline.
- `adr/0006-cli-gap-tools-boundary.md` (Proposed, in force): unaffected; freshness registers no tools.

## New Durable ADRs Created

- `adr/0007-lazy-freshness-default-watchers-optin.md` — Freshness defaults to lazy budgeted re-index; long-lived CGC watchers are opt-in because they dominate the embedded-database lock (Nygard format; Status: Proposed). Establishes the default freshness posture, the budget guarantee, and the advisory-only staleness contract that later surfaces (including proactive injection) build on.
