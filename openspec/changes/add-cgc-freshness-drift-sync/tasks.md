## 1. Freshness state and observation

- [ ] 1.1 Implement config keys `freshness.watch` (default false), `freshness.autoSync` (default true), `freshness.maxSyncsPerSession` (default 2), each with environment-variable overrides.
- [ ] 1.2 Implement the freshness state store (`fresh | possibly-stale | syncing | skipped-busy | disabled` plus timestamps) with change subscriptions, mirroring the lifecycle state shape.
- [ ] 1.3 Subscribe to the harness session event for file-modifying tool activity (pin the exact event name from installed `docs/extensions.md` during implementation) and mark the workspace possibly-stale on first observed edit, with burst debouncing and zero detection spawns.

## 2. Sync execution

- [ ] 2.1 Implement the lazy sync path: first-drift trigger within the budget, incremental `cgc index .` through the shared runner, background execution with progress state, runner dedup with in-flight syncs.
- [ ] 2.2 Implement budget enforcement: after `maxSyncsPerSession`, further drift refreshes the advisory state only; no automatic syncs.
- [ ] 2.3 Implement skip-as-busy handling for lock conflicts with a one-time notice naming the conflict, and state `skipped-busy`.
- [ ] 2.4 Implement the opt-in watcher path: start `cgc watch` as a managed child when `freshness.watch` is on and the lock is available; degrade to lazy mode with a busy notice when blocked; terminate through all session cleanup paths.

## 3. Notices, guardrails, and verification

- [ ] 3.1 Implement once-per-condition-per-session notices (possibly-stale with `/cgc sync` hint; skipped-busy; sync-completed) through the session notice surface, never in the agent context.
- [ ] 3.2 Implement fail-open containment: errors recorded, retry cap one per session, agent loop unaffected.
- [ ] 3.3 Test the freshness state machine (fresh→dirty→syncing→fresh; budget exhaustion; busy skips; watcher lifecycle incl. teardown on all cleanup paths).
- [ ] 3.4 Verify all scenarios in `specs/cgc-freshness-sync/spec.md` against the implementation.
- [ ] 3.5 Run `openspec validate add-cgc-freshness-drift-sync --type change --strict` before archive.
