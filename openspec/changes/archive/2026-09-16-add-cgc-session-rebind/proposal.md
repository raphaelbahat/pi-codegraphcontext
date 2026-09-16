# Add CGC Session Rebind

## Why

Pi re-runs the extension factory on every session replacement (`/resume`, `/new`, `/fork`, `/reload`) with a fresh extension object and a fresh `ExtensionAPI` instance (pi 0.85.x `docs/extensions.md`: "pi emits `session_shutdown` for the old extension instance, reloads and rebinds extensions for the new session, then emits `session_start`"). But every long-lived surface in `extensions/index.ts` is a module-level singleton constructed once and guarded by a register-once flag (`registered = true`) — so the hooks are registered onto the **first load's API object only**. After any session replacement, all of those surfaces are dormant in the new session: no gate evaluation (the original `/cgc status` complaint — "no lifecycle state recorded yet … the session-start gate has not evaluated it"), no freshness watching, no HUD updates, no guidance card, no routing-skill pointer, no proactive tiers, and no `session_shutdown` cleanup hook on the new API.

The register-once guard exists to prevent duplicate hook registration on the **same** API — a real hazard it must keep guarding. The defect is that it also swallows registration onto a **different** API instance, which is exactly what a session replacement delivers.

## What Changes

- A **session rebind**: when the factory re-runs for a new session, every cached surface that registered hooks re-binds to the new session's API instead of staying dormant.
- The mechanism is an **api-identity guard** inside each surface's `register()`: `register()` accepts the API it should be wired to; when it receives a different API instance than the one it is currently wired to, it swaps its api reference, clears its registration flag, and wires its hooks onto the new API; when it receives the same API (or none), it stays the existing idempotent no-op. The singletons and their `??=` memoization are kept — they own valuable cross-session state (the runner's child tracking, the process-lifetime stores, the health-probe cache) and rebuilding them would orphan that state.
- Surfaces that rebind (the complete list from `extensions/index.ts`): the lifecycle gate, the process-cleanup handle (dispose + reinstall keyed on the API), the freshness drift observer, the status HUD, the coverage-note injector, the guidance injector, the guidance skill exposure, the drift-steer injector, and the result annotator. The runner, workspace detector, API-registry client, and process-lifetime stores own no API hooks and need no rebind. The slash commands and CLI-gap tools already re-register on every factory run (unguarded) and are covered by regression tests, not new machinery.
- State discipline across a rebind: cross-session state **persists** (the runner's tracked children and spill files, the process-lifetime lifecycle/freshness stores, the detector's probe cache); per-session state **resets** because the old API's `session_shutdown` fires before the factory re-runs (gate `reset()`, budget resets, one-shot re-arms) and the new API's `session_start` re-arms the rest on the freshly registered hooks.
- The fail-open doctrine is unchanged: rebind never throws, a broken API degrades each surface individually, and the agent loop is never interrupted.

## Capabilities

### New Capabilities

(none — this change alters the delivery semantics of existing capabilities, not a new user-visible surface)

### Modified Capabilities

- `cgc-index-lifecycle`: the gate and the teardown sweep rebind on session replacement — a resumed session gets a full session-start evaluation and working cleanup paths instead of a dormant gate.
- `cgc-agent-guidance`: the routing card and the routing-skill exposure rebind — resumed sessions receive guidance and skill discovery again.
- `cgc-status-display`: the status HUD re-subscribes on session replacement — the chip renders in resumed sessions and per-session warnings re-arm.
- `cgc-slash-commands`: `/cgc status` reports live lifecycle state in a resumed session (the original defect report).
- `cgc-freshness-sync`: the drift observer rebinds — tool-call drift marks and the per-session sync budget work in resumed sessions.
- `cgc-proactive-notes`: the coverage-note, drift-steer, and result-annotation tiers rebind — their one-shot-per-session budgets re-arm per session.

## Impact

- `extensions/gate.ts`, `extensions/freshness.ts`, `extensions/status-hud.ts`, `extensions/guidance.ts`, `extensions/proactive.ts`: each registering class's `register()` gains the api-identity rebind (no constructor changes, `dispose()` semantics unchanged).
- `extensions/cleanup.ts` + `extensions/index.ts`: the cleanup handle is reinstalled (old handle disposed) when the API instance changes; `index.ts` passes the current `pi` to every guarded `register()` call.
- New tests in `extensions/index.test.ts` (the reproducing factory test) plus per-surface rebind assertions in each surface's test file; the same-api idempotence contract is asserted everywhere.
- No config keys, no new ADRs, no new dependencies, no new spawns; ADR-0001/0002 boundaries untouched.
