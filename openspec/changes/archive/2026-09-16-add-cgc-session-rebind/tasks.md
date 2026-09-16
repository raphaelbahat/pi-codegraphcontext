# Tasks: Add CGC Session Rebind

## 1. Planning artifacts

- [x] 1.1 Write the proposal, design (D1 api-identity guard, D2 cleanup dispose/reinstall, D3 state persistence/reset discipline, D4 ordering/idempotence), and capability deltas for the six affected specs.
- [x] 1.2 Pass `openspec validate add-cgc-session-rebind --type change --strict` before implementation.

## 2. The rebind mechanism (api-identity guard)

- [x] 2.1 `extensions/gate.ts`: `LifecycleGate.register(api?)` — adopt a different API instance, re-arm the registration flag, and wire `session_start`/`session_shutdown` onto it; same-api and disposed behavior unchanged.
- [x] 2.2 `extensions/guidance.ts`: `GuidanceInjector.register(api?)` and `GuidanceSkillExposure.register(api?)` — same guard over their hook sets.
- [x] 2.3 `extensions/freshness.ts`: `FreshnessDriftObserver.register(api?)` — same guard over `session_start`/`session_shutdown`/`tool_call`.
- [x] 2.4 `extensions/status-hud.ts`: `StatusHud.register(api?)` — same guard over `session_start`/`session_shutdown`.
- [x] 2.5 `extensions/proactive.ts`: `CoverageNoteInjector.register(api?)`, `DriftSteerInjector.register(api?)`, `ResultAnnotator.register(api?)` — same guard over their hook sets.

## 3. Factory wiring

- [x] 3.1 `extensions/index.ts`: pass the current `pi` to every guarded `register()` call (memoization and registration order unchanged); document the session-rebind rationale at the factory.
- [x] 3.2 `extensions/index.ts`: reinstall the cleanup handle when the API instance changes — dispose the old handle (no duplicated `exit`/signal listeners) and install a fresh one for the new API, tracked per API; fail-open on every step.
- [x] 3.3 The slash commands and CLI-gap tools: key their (unguarded) registrations on the API instance in the factory — re-register on a fresh API, skip the same API — and assert exactly-once registration per API on factory re-runs.

## 4. Tests (a resumed session is a fully-live session)

- [x] 4.1 The reproducing factory test in `extensions/index.test.ts`: `entry(apiA)` → drive the session → `entry(apiB)` (session replacement) → assert the hooks are registered on B and that a gate evaluation driven through B's `session_start` works (state recorded, notices flow).
- [x] 4.2 The same-api idempotence test: `entry(api)` twice on the same API wires each hook exactly once (no duplicate `/cgc` command, no duplicate hooks).
- [x] 4.3 Per-surface rebind assertions: the gate, the guidance injector, the skill exposure, the HUD, the freshness observer, the cleanup handle, the coverage-note injector, the drift-steer injector, and the result annotator each re-wire onto the new API (and not onto the old one alone).
- [x] 4.4 State-persistence tests: the runner identity (child tracking) and the process-lifetime stores survive a rebind; per-session flags (one-shot injection, warning-once ledger, sync budget) reset with the new session's `session_start`.

## 5. Verification

- [x] 5.1 `bunx tsc --noEmit` clean; biome formatting/lint clean; full suite green.
- [x] 5.2 `openspec validate add-cgc-session-rebind --type change --strict` and `openspec validate --specs --strict` pass after implementation.
