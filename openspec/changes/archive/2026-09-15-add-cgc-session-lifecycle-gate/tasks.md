## 1. Extension foundation

- [x] 1.1 Scaffold the `pi-codegraphcontext` TypeScript extension package (npm `pi-package` metadata, `pi.extensions` manifest, TypeScript build) registered against the Pi extension API.
- [x] 1.2 Implement config loading for `cgc.executable` (default `cgc`), `cgc.timeoutMs` (default 30000; version probe 10000), `lifecycle.autoCreate` (default false), `lifecycle.syncOnStart` (default true), each with environment-variable overrides.
- [x] 1.3 Implement the `cgc` command runner: argument-array spawn with explicit `cwd` from the Pi session context, time budget, abort signal, bounded output capture, structured error codes, and per-workspace in-flight deduplication.
- [x] 1.4 Implement multi-path process cleanup (session shutdown hook, process exit handler, signal handlers) so no extension-spawned `cgc` process outlives the session.

## 2. Lifecycle state machine

- [x] 2.1 Implement workspace detection: resolve the session working directory, detect `.codegraphcontext/` presence, and run the cached one-shot `cgc` liveness/version probe per session.
- [x] 2.2 Implement the five-state classifier (unavailable / unindexed / busy / corrupt / clean|drift) with fail-safe handling of unparseable probe output.
- [x] 2.3 Implement the `unindexed` path: honor the opt-in `lifecycle.autoCreate` consent gate (default off) and surface the one-time unindexed notice with enablement guidance.
- [x] 2.4 Implement the start-time `drift` path: when `lifecycle.syncOnStart` is on and drift is detected, run the incremental sync command in the background and track its progress in state.
- [x] 2.5 Implement the `corrupt` path: report state, offer rebuild, require explicit confirmation before any destructive rebuild, and never self-destruct data.
- [x] 2.6 Implement the `busy` path: map lock errors and lock-holding probes to skip-as-busy with a one-time notice, no retries, no lock-file deletion.
- [x] 2.7 Implement the `clean` path: no maintenance invocations beyond the cached probe; enforce the per-session invocation budget and one-retry cap.

## 3. State exposure and resilience

- [x] 3.1 Expose the lifecycle state (workspace path, state, last action, timestamps) internally for downstream surfaces (status HUD, slash commands) without registering any graph query tools.
- [x] 3.2 Guarantee fail-open behavior: guard every hook body, cap failed-work retries at one per session, and never block or interrupt the agent loop.
- [x] 3.3 Add unit/integration tests covering each state transition, dedup, timeout/cancellation, cleanup paths, and the consent gates.

## 4. Validation and closure

- [x] 4.1 Verify all scenarios in `specs/cgc-index-lifecycle/spec.md` against the implementation.
- [x] 4.2 Run `openspec validate add-cgc-session-lifecycle-gate --type change --strict` before archive.
