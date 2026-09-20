# ADR Review Manifest

- Status: completed
- Review date: 2026-09-20

## Review Summary

ADR review completed for this change. All nine repository-level ADRs (ADR-0001 through ADR-0009) were read; none is superseded (no `Supersedes` links exist in the folder), so all are in force. No in-force ADR is contradicted by this change and none requires supersession.

## In-Force ADRs Reviewed

- ADR-0001 (cgc binary-only integration) — unaffected; the pin changes the child environment, not the binary-only integration posture.
- ADR-0002 (readiness-gated non-configurable guidance) — unaffected.
- ADR-0003 (confirmation-gated destructive actions) — unaffected; the pin performs no destructive action.
- ADR-0004 (passive status renderers) — unaffected.
- ADR-0005 (universal output-policy pipeline) — coherent; the pin is unconditional policy applied at the same single point (`childEnv`) where the output-format env is merged.
- ADR-0006 (CLI-gap tools boundary) — unaffected; CLI-gap tools run through the runner and inherit the pin.
- ADR-0007 (lazy freshness with default-watchers opt-in) — **reinforced**: the pin makes the extension's spawns stay finite (no child ever forks its own watcher), keeping the embedded-database lock held only by the opt-in managed `freshness.watch` child. The extension's watcher policy is now enforced at the spawn boundary rather than by convention.
- ADR-0008 (worktree isolation via named contexts) — unaffected.
- ADR-0009 (two-tier proactive injection) — unaffected.

## New Durable ADRs Created

- None - no major durable architectural decisions were introduced. The pin is a one-line tactical enforcement of the watcher posture already committed by ADR-0007 (the extension owns its watcher policy; only the managed opt-in child is a watcher); it reuses the established `childEnv` merge pattern from the output-policy design and creates no new boundary, pattern, or contract beyond what ADR-0007 already records.