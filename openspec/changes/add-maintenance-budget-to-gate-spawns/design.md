# Design: maintenance budget for the gate's own maintenance spawns

## Context

0.8.2 introduced \`cgc.maintenanceTimeoutMs\` (default 600 000 ms) and wired it into the *command* path only: \`/cgc index\` and \`/cgc sync\` pass it to \`runner.run\` through \`startIndexWork\` (\`commands.ts\` 1005). The gate's own maintenance spawns declare the same intent but never populate their seams, so they fall to the probe-sized runner default (\`cgc.timeoutMs\` = 30 000 ms):

- \`DriftPath\` (\`drift.ts\`): \`syncTimeoutMs\` declared (109) and consumed (219: \`if (this.syncTimeoutMs !== undefined) runOptions.timeoutMs = …\`) — never supplied at construction (\`gate.ts\` 1127).
- \`UnindexedPath\` (\`unindexed.ts\`): \`indexTimeoutMs\` declared (115) and consumed (243) — never supplied (\`gate.ts\` 1120).
- \`FreshnessDriftObserver\` (\`freshness.ts\`): \`syncTimeoutMs\` declared (185) and consumed (498) — never supplied (\`index.ts\` 258).

Empirically: a real incremental sync took ~63 s on the Neo4j-backed outfitter workspace; a cold index of a ~600-file tree exceeded 300 s. The session-start paths terminate at 30 s today.

## Goals / Non-Goals

**Goals:**
- One budget for one work class: every spawn that runs \`cgc index .\` (or its flags) carries \`cgc.maintenanceTimeoutMs\`, regardless of trigger (command, session-start drift sync, consented auto-create, freshness auto-sync).
- Absent key → byte-for-byte current behavior (the seams stay unset; the runner default applies).

**Non-Goals:**
- No new config keys; no change to the probe chain (\`cgc.timeoutMs\` still bounds every probe).
- The worktree seam's \`createTimeoutMs\` (\`worktree.ts\` 1326) is **excluded**: it budgets git worktree *creation* (seconds-scale, local git), not a \`cgc\` invocation — a different work class. The proposal's mention of \`createTimeoutMs\` alongside \`UnindexedPath\` is corrected here: \`UnindexedPath\` only uses \`indexTimeoutMs\`.

## Decisions

- **D1 — populate at the construction sites, not inside the path classes.** The path classes already consume the options correctly; the wiring belongs where the objects are built: \`gate.ts\` passes \`this.config.cgc.maintenanceTimeoutMs\` into \`DriftPath({ syncTimeoutMs })\` and \`UnindexedPath({ indexTimeoutMs })\`; \`index.ts\` passes it into \`FreshnessDriftObserver({ syncTimeoutMs })\`. Minimal surface, no contract change, the seam options stay optional.
- **D2 — absent key → unset seam.** \`cgc.maintenanceTimeoutMs\` may be \`undefined\` (the config default is 600 000, so in practice it is always set; the undefined path exists for the config-less/test fixtures). Passing \`undefined\` through the construction sites reproduces today's behavior exactly.
- **D3 — no doc changes.** The 0.8.2 README/agent-guide rows already describe the key as "the budget for background maintenance runs" — the gate's spawns are exactly that. The accuracy tests pass unchanged.

## Risks / Trade-offs

- A long-running session-start sync now occupies the runner's per-workspace slot for up to 10 minutes — but it always did occupy it for its real duration; the change only stops the *false* termination at 30 s. Busy-skip and dedup semantics are untouched.
- Rollback: revert the three construction-site lines; no data or state migration involved.

## Migration Plan

None — a behavior-only wiring change, shipping in a patch release. Users who want the old (broken) 30 s ceiling can set \`cgc.maintenanceTimeoutMs: 30000\`.

## Open Questions

None. (The backend-aware watcher-defaults question is tracked separately as the \`watch-defaults-research\` delegation, not part of this change.)
