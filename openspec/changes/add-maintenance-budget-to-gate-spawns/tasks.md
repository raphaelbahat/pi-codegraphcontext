# Tasks

## 1. Gate wiring

- [x] 1.1 `extensions/gate.ts`: pass `syncTimeoutMs: this.config.cgc.maintenanceTimeoutMs` into the `DriftPath` construction.
- [x] 1.2 `extensions/gate.ts`: pass `indexTimeoutMs: this.config.cgc.maintenanceTimeoutMs` into the `UnindexedPath` construction.

## 2. Freshness wiring

- [x] 2.1 `extensions/index.ts`: pass `syncTimeoutMs: getConfig().config.cgc.maintenanceTimeoutMs` into the `FreshnessDriftObserver` construction.

## 3. Tests

- [x] 3.1 `gate.test.ts`: the drift-path spawn carries `timeoutMs: 600000` when the key is set (the fake-runner assertion); the key absent → `timeoutMs` undefined.
- [x] 3.2 `gate.test.ts`: the consented auto-create spawn carries the same budget and the absent-key behavior.
- [x] 3.3 `freshness.test.ts`: the auto-sync spawn carries the maintenance budget; absent → undefined.

## 4. Verification

- [x] 4.1 `bun test` green; `bunx tsc --noEmit` clean; biome clean.
- [x] 4.2 `openspec validate add-maintenance-budget-to-gate-spawns --type change --strict` passes; `openspec validate --specs --strict` stays green post-archive (main session).
- [x] 4.3 Docs: confirm the README/agent-guide rows already cover the gate spawns (no edits expected).
