# ADR Review Manifest

- Status: completed
- Review date: 2026-09-06

## Review Summary

ADR review completed for this change.

## In-Force ADRs Reviewed

- `adr/0001-cgc-binary-only-integration.md` (Proposed, in force): context creation and `--context`-flagged invocations run through the shared runner only.
- `adr/0002-readiness-gated-nonconfigurable-guidance.md` (Proposed, in force): unaffected; worktree states surface as human notices, not agent content.
- `adr/0003-confirmation-gated-destructive-actions.md` (Proposed, in force): cleanup is notice-plus-user-driven-deletion; the extension never deletes autonomously.
- `adr/0004-passive-status-renderers.md` (Proposed, in force): the worktree map is a state maintainer; renderers stay passive consumers.
- `adr/0005-universal-output-policy-pipeline.md` (Proposed, in force): all worktree-related command output flows the policy pipeline.
- `adr/0006-cli-gap-tools-boundary.md` (Proposed, in force): `/cgc_context` is the user-driven cleanup path this design points to.
- `adr/0007-lazy-freshness-default-watchers-optin.md` (Proposed, in force): freshness operates within the mapped worktree context; no interlock conflicts (both reuse the same runner).

## New Durable ADRs Created

- `adr/0008-worktree-isolation-via-named-contexts.md` — Worktree isolation rides CGC named contexts keyed by worktree identity, fail-closed on mismatch (Nygard format; Status: Proposed). Establishes the opt-in isolation mechanism, the identity-verification contract, and the notice-based cleanup posture for all future worktree-aware behavior.
