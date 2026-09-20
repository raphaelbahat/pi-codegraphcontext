## Why

The dedicated maintenance budget (shipped in 0.8.2) applies `cgc.maintenanceTimeoutMs` (default 600 000 ms) to the `/cgc index` and `/cgc sync` **command** spawns — but only to the command path. The gate's own maintenance spawns — the session-start drift sync (`DriftPath`, `lifecycle.syncOnStart` default on), the consented auto-create (`UnindexedPath`), and the freshness observer's auto-syncs — were left with the seams' timeout options unset (`syncTimeoutMs` / `indexTimeoutMs` / `createTimeoutMs` are declared but never populated). They therefore fall to the runner's probe-sized default (`cgc.timeoutMs` = 30 000 ms), which empirically terminates real maintenance runs: a first-post-fix or large-workspace incremental sync takes ~63 s on the Neo4j backend, and a cold index of a ~600-file tree did not finish within 300 s. The symptom recurs at **every session start** on such workspaces even though `/cgc sync` now succeeds.

## What Changes

- Wire the already-declared timeout seams to consume `cgc.maintenanceTimeoutMs` (the same config key the command path uses — one budget for the same work class, regardless of trigger):
  - `DriftPath`: populate `syncTimeoutMs` from the maintenance budget at gate construction (`gate.ts`).
  - `UnindexedPath`: populate `indexTimeoutMs` / `createTimeoutMs` the same way.
  - `FreshnessDriftObserver` (the freshness auto-syncs): populate its `syncTimeoutMs` from the maintenance budget at extension-factory construction (`index.ts`).
- No new config keys, no behavior change when `cgc.maintenanceTimeoutMs` is absent (the seams stay unset → the pre-existing runner default, exactly as today).
- The probe chain (status indexedness, classifier, api-registry, version probe) is untouched at `cgc.timeoutMs` — probes stay bounded.

## Capabilities

### New Capabilities

(none — this change modifies existing capability behavior only)

### Modified Capabilities

- `cgc-index-lifecycle`: the session-start maintenance spawns (drift sync, consented auto-create) carry the maintenance budget — the lifecycle spec's spawn-timeout contract changes from "probe-sized default" to "maintenance-sized".
- `cgc-freshness-sync`: the freshness observer's auto-sync spawns carry the maintenance budget.

## Impact

- **Affected specs**: `openspec/specs/cgc-index-lifecycle/spec.md`, `openspec/specs/cgc-freshness-sync/spec.md` (delta scenarios for the spawn budgets).
- **Affected code**: `extensions/gate.ts` (the DriftPath/UnindexedPath construction sites), `extensions/index.ts` (the FreshnessDriftObserver construction site), plus tests (`gate.test.ts`, `commands.test.ts`/`freshness.test.ts` as applicable). The seams' plumbing already exists (`drift.ts:219`, `freshness.ts:498`, `unindexed.ts:243` consume the options when set) — this change only populates them.
- **Docs**: the README/agent-guide config-table rows already document `cgc.maintenanceTimeoutMs` as "the budget for background maintenance runs" — that wording now covers the gate's spawns without edits (verified against 0.8.2's docs).
- **Risk**: minimal — the wiring is population-only; absent config → the current behavior byte-for-byte. The fail-open doctrine is untouched (a budget termination remains a recorded outcome, never a crash).
