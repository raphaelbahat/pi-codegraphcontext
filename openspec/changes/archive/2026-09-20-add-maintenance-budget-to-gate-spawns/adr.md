# ADR Review Manifest

- Status: completed
- Review date: 2026-09-19

## Review Summary

ADR review completed for this change. The change is a budget-wiring follow-up to the shipped \`cgc.maintenanceTimeoutMs\` capability; it does not contradict any in-force ADR. ADR-0007's watcher posture (lazy re-index default, watcher opt-in) is untouched — this change budgets the *finite spawns*, which remain the default reconciliation mechanism under ADR-0007.

## In-Force ADRs Reviewed

- ADR-0001 (sub-agent/openspec constraints): respected — planning artifacts only in this change; implementation via \`/opsx-apply\` or the main session.
- ADR-0003 (user confirmation semantics): respected — no consent flow changes.
- ADR-0005 (the shared output policy): respected — the spawns remain under the runner's policy; only their time budget changes.
- ADR-0007 (lazy freshness, watcher opt-in): respected and reinforced — the finite spawns become viable for large workspaces, preserving the lazy default's viability.

## New ADRs Required

None. The decision "maintenance budgets follow the work class, not the trigger" is an application of the existing budget capability, not an architecture decision.
