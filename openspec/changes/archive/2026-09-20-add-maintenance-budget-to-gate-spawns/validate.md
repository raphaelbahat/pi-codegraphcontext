# Task Validation: add-maintenance-budget-to-gate-spawns

- Validated against: live framework/library/tool documentation + read-only repo verification (one read-only validator, research-only discipline)
- Validation date: 2026-09-19
- Verdict: READY

---

## VALID — notable confirmations

### Claim group 1 — the cgc CLI work classes

- \`cgc index\` is a finite, incremental-by-default command (\`cgc index --help\`; the indexing guide: CGC "tracks modification timestamps and file hashes to perform incremental scans"; \`--force\` = full rebuild); \`cgc watch\` is the continuous mode ("runs in the foreground and monitors … Press Ctrl+C to stop"). The tasks budget the finite-spawn class — the correct class per ADR-0007's posture.
  - **Evidence**: https://github.com/CodeGraphContext/CodeGraphContext/blob/main/docs/docs/guides/indexing.md

### Claim group 2 — TypeScript / bun

- Optional properties read as \`T | undefined\`; the \`!== undefined\` guard in every seam is correct. Bun test per-test timeouts default to 5000 ms (the fake-runner stubs resolve before bun's timeout); \`tsc --noEmit\` type-checks without emitting.
  - **Evidence**: https://www.typescriptlang.org/tsconfig#exactOptionalPropertyTypes · https://bun.com/docs/test/writing-tests · https://www.typescriptlang.org/tsconfig/noEmit.html

### Claim group 3 — process-timeout semantics

- The budget termination mechanism (kill on elapsed budget) is documented Node/Bun child-process semantics ("If \`timeout\` is greater than 0, the parent sends \`killSignal\` … if the child runs longer than \`timeout\` milliseconds"). Note: this repo's runner implements the budget with its own setTimeout → terminate (\`extensions/runner.ts\` 645-647, 726), producing the "exceeded its Nms time budget and was terminated" message — semantics-equivalent; no task impact.
  - **Evidence**: https://nodejs.org/api/child_process.html

### Claim group 4 — code-level sanity (read-only repo verification)

- \`cgc.maintenanceTimeoutMs\` exists with default 600 000 (\`config.ts\` 42/224, env \`CGC_MAINTENANCE_TIMEOUT_MS\` 268). The seams and consumption sites match the tasks: \`drift.ts\` 109→219, \`unindexed.ts\` 115→243, \`freshness.ts\` 185→498; the construction sites (\`gate.ts\` 1120/1127, \`index.ts\` 258) have the config in scope. Existing test precedents assert the timeoutMs pass-through (\`unindexed.test.ts\` 190-196, \`freshness-sync.test.ts\` 281) — the planned assertions follow the established pattern.

## INVALID — requires revision

None.

## Cross-cutting fixes needed

None. The design's D3 (no doc changes) is confirmed: the 0.8.2 README/agent-guide rows already describe the key as the budget for background maintenance runs.
