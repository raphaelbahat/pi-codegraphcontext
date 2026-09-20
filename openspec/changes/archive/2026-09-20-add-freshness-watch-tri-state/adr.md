# ADR Review Manifest

- Status: completed
- Review date: 2026-09-20

## Review Summary

ADR review completed for this change. The watcher-defaults research corrected ADR-0007's rationale (the exclusive lock is embedded-backend-only; server backends coexist), while its mechanics (lazy default, managed teardown, one attempt per session, advisory staleness) remain correct and in force. The durable decision — the backend-aware tri-state watcher policy with verified liveness and bounded backend detection — required a new repository-level ADR whose Status notes that it supersedes ADR-0007's rationale only.

## In-Force ADRs Reviewed

- adr/0001-cgc-binary-only-integration.md — the watcher spawns through the shared runner against the `cgc` binary only (unchanged).
- adr/0002-readiness-gated-nonconfigurable-guidance.md — notices stay on the user-facing surface, never the agent context (unchanged).
- adr/0003-confirmation-gated-destructive-actions.md — no destructive action introduced; the watcher never creates or deletes an index.
- adr/0004-passive-status-renderers.md — no new status literal; renderers unchanged.
- adr/0005-universal-output-policy-pipeline.md — the watcher spawn keeps the runner's output policy (unchanged).
- adr/0006-cli-gap-tools-boundary.md — backend detection reads CGC's own surfaces (doctor output, .env); no new CLI-gap tool.
- adr/0007-lazy-freshness-default-watchers-optin.md — mechanics remain in force; the corrected rationale and the tri-state policy are recorded in ADR-0010.
- adr/0008-worktree-isolation-via-named-contexts.md — the worktree fail-closed gate still short-circuits watcher spawning (unchanged).
- adr/0009-two-tier-proactive-injection.md — untouched by this change.

## New Durable ADRs Created

- adr/0010-backend-aware-tri-state-freshness-watcher.md — the freshness watcher policy: the backend-aware tri-state `freshness.watch` (`off` default / `on` unconditional / `auto` gated on server backend + indexed workspace + verified liveness), the `freshness.watcherLivenessMs` budget, the bounded fail-open backend detection, boolean compatibility, and the corrected ADR-0007 rationale (supersedes rationale only).
