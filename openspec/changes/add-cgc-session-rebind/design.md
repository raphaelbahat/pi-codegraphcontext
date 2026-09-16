# Design: Add CGC Session Rebind

## Context

pi 0.85.x re-runs every extension's default factory on session replacement: `session_shutdown` fires on the outgoing session's extension instance, then pi "reloads and rebinds extensions for the new session, then emits `session_start`" (`docs/extensions.md`, the `/resume`//`fork` sequences at lines 432/449). The factory receives a **fresh `ExtensionAPI`** each time.

`extensions/index.ts` was built around module-level singletons constructed once and guarded by a register-once flag. Nine of those surfaces wire hooks onto the API they were constructed with:

| Surface | Module | Hooks |
|---|---|---|
| `LifecycleGate` (`cachedGate`) | `gate.ts` | `session_start`, `session_shutdown` |
| `ProcessCleanupHandle` (`cachedCleanup`) | `cleanup.ts` | `session_shutdown` (plus process `exit`/signal listeners) |
| `FreshnessDriftObserver` (`cachedFreshnessObserver`) | `freshness.ts` | `session_start`, `session_shutdown`, `tool_call` |
| `StatusHud` (`cachedStatusHud`) | `status-hud.ts` | `session_start`, `session_shutdown` |
| `CoverageNoteInjector` (`cachedCoverageInjector`) | `proactive.ts` | `session_start`, `session_shutdown`, `before_agent_start` |
| `GuidanceInjector` (`cachedGuidanceInjector`) | `guidance.ts` | `session_start`, `session_shutdown`, `before_agent_start` |
| `GuidanceSkillExposure` (`cachedGuidanceSkillExposure`) | `guidance.ts` | `resources_discover` |
| `DriftSteerInjector` (`cachedDriftSteerInjector`) | `proactive.ts` | `session_start`, `session_shutdown`, `before_agent_start` |
| `ResultAnnotator` (`cachedResultAnnotator`) | `proactive.ts` | `session_start`, `session_shutdown` |

The slash commands (`registerCgcCommands`) and the CLI-gap tools (`registerCliGapTools`) are **not** memoized — they re-register onto the fresh API on every factory run and were never dormant; they need regression coverage only.

Two verified constraints shape the design:

1. **The pi extension API has no hook-removal surface.** `pi.on(...)` returns nothing removable (the repo's `cleanup.ts` documents this: "the `session_shutdown` hook cannot be unregistered"). "Unhooking from the old API" can therefore only mean: neutralize old-path behavior where reachable (dispose semantics) and stop caring about the old API — pi drops the old extension instance after `session_shutdown`, so its handlers are unreachable afterward.
2. **The singletons own cross-session state by design** (2026-09-15 campaign): the runner's child tracking and spill registry (the multi-path teardown guarantee), the process-lifecycle state store, the freshness state store, and the detector's version-probe cache. The register-once guard itself is correct for its original purpose — deduplicating hook registration when the factory re-runs against the **same** API.

## Goals / Non-Goals

**Goals:**

- After any session replacement (`/resume`, `/new`, `/fork`, `/reload`), every hook-owning surface is live on the new session's API: the gate evaluates, notices flow, the HUD renders, guidance injects, the skill is discoverable, freshness watches, the proactive tiers re-arm, and the teardown paths cover the new session.
- Same-API registration stays exactly as it is today: an idempotent no-op.
- Cross-session state survives the rebind; per-session state resets per session.
- The change is fail-open end to end: rebind can never break extension load or the agent loop.

**Non-Goals:**

- No new hook surface, config key, or user-facing command; the fix is invisible except that resumed sessions work.
- No change to `dispose()` semantics (still permanent, still for tests/reload).
- No per-session surface instances (see D1 alternatives).
- No new ADR: the decisions below are change-scoped mechanics inheriting the existing doctrine set.

## Decisions

### D1: The rebind mechanism — an api-identity guard inside each surface's `register(api?)`

**Decision:** `register()` gains an optional parameter carrying the API it should be wired to. The guard becomes an identity check on the API instance:

```
register(api?: Seam): void {
  if (this.disposed) return
  if (api !== undefined && api !== this.api) {
    this.api = api          // session replacement: adopt the fresh API
    this.registered = false // …and re-arm registration
  }
  if (this.registered) return
  this.registered = true
  // wire the hooks onto this.api (unchanged bodies)
}
```

`extensions/index.ts` keeps every `??=` memoization and simply passes the current `pi` to each `register()` call: `cachedGate.register(pi as unknown as GateExtensionApi)`. First load: `api === this.api` → identical to today. Same-API re-invocation: no-op (the guard's original contract, preserved). New-API re-invocation (session replacement): the hooks are wired onto the new API.

**Rationale:** The bug is one comparison; the fix belongs next to the flag that causes it. Keeping the memoization preserves the cross-session state the surfaces own (the whole point of singletons), keeps the diff surgical across five modules, and makes the contract testable at both the unit level (`register(a); register(a)` → one wiring; `register(a); register(b)` → wired on `b`) and the factory level (`entry(apiA); entry(apiB)` → hooks on `B`).

**Alternatives considered:**

- *Per-session surface instances (drop the singletons)* — rejected: the runner's child tracking is the anchor of the multi-path teardown guarantee (cleanup paths sweep that one runner); rebuilding surfaces per session orphans tracked children and spill files, drops the process-lifetime stores' history, and re-spawns the health-probe cache. The singletons exist deliberately; the guard, not the lifetime, is what is broken.
- *Reset the singletons on api change (dispose + reconstruct everything in the factory)* — rejected for the same state-loss reasons, plus it would re-run `installProcessCleanup`'s process-listener installation on every reload path with more moving parts than the one-line guard.
- *Re-register from a `session_start` hook instead of the factory* — rejected: the hook must already be registered on the new API to fire; the factory re-run is the earliest point we reliably see the new API instance.

### D2: The cleanup handle — dispose and reinstall keyed on the API

**Decision:** `installProcessCleanup` is a closure factory, not a class; its handle captures the API in the `session_shutdown` hook and owns the process `exit`/signal listeners. It cannot re-wire in place. `extensions/index.ts` therefore tracks the API the active handle was installed for; when the factory re-runs with a different API it calls `cachedCleanup.dispose()` (removing the old process listeners and marking the old shutdown hook a no-op — the old API is dead after the replacement anyway) and installs a fresh handle for the new API. The new handle's `events` ledger starts empty; `getCleanupEvents()` reads the active handle, so diagnostics reflect the current installation.

**Rationale:** The process-level listeners (`exit`, signals) are the one place where a naive "register again" would actually duplicate work — dispose-first is what keeps exactly one sweep per path. The old handle's unreachable `session_shutdown` hook is neutralized by its existing `disposed` flag.

**Alternatives considered:**

- *Teach the handle to rebind* — rejected: it would need a class-shaped refactor for one call site; the dispose/reinstall pair is already the handle's documented reload path.

### D3: State across the rebind — what persists, what resets

**Decision:**

- **Persists (cross-session by design):** the runner (tracked children, spill registry, in-flight dedup), the workspace detector's probe cache, the API-registry client, the process-lifecycle state store (`getLifecycleStateStore()`), the freshness state store (`getFreshnessStateStore()`), and the cleanup events of the active installation (reset only when D2 reinstalls).
- **Resets (per-session):** the gate's `GateSession` (store, budget, classifier caches, one-time-notice sets) via `session_shutdown` → `reset()` firing on the old API before the factory re-runs; the injectors' one-shot flags via their own `session_shutdown` handlers and the new session's `session_start` re-arm; the HUD's warning-once ledger; the freshness observer's per-session sync budget and drift marks.

**Rationale:** pi's own replacement sequence (old-API `session_shutdown` → factory re-run → new-API `session_start`) already implements the reset discipline; the rebind only restores the delivery of those events. No surface needs bespoke rebind-time state surgery.

**Alternative considered:** *force-reset all per-session state during rebind* — rejected as redundant: the shutdown handlers already ran on the old API, and duplicating the reset in rebind would double-clear and risk dropping in-flight evaluations the stale-evaluation drop (fix `053f1d2`) depends on.

### D4: Ordering and idempotence guarantees

**Decision:** In `extensions/index.ts` the registration order is unchanged (gate first, then the surfaces that read it). Rebind happens inline at each existing registration site. Every rebind path is individually guarded exactly like the registration it extends: a throwing `api.on`, a throwing dispose, or any construction failure leaves the surface degraded — never the session. Rebind is idempotent per API instance: running the factory N times with the same API wires each hook once.

The two unguarded registrations (slash commands, CLI-gap tools) get the same identity discipline from the factory side: `extensions/index.ts` tracks the API each was last registered on and skips the re-registration when the API is unchanged. Without that skip, a same-API double factory run would duplicate the bare `/cgc` command and the three tool registrations — the one place a naive "register again" still duplicates work.

**Rationale:** The fail-open doctrine (every change in this repo): registration must never break extension load, and a hook body must never throw into pi's dispatch. The rebind is registration; it inherits the same posture.

## Risks / Trade-offs

- *Old-API handler residue:* the old API object keeps dead handler references. Accepted: pi discards the old extension instance after `session_shutdown`, so the residue is unreachable; the alternative (a removal API) does not exist in pi 0.85.x.
- *Double-wiring risk on a future pi change:* if pi ever re-runs the factory with the **same** API, the identity guard makes it a no-op — the historical behavior is preserved exactly.
- *Cleanup events ledger reset on reinstall:* teardown diagnostics collected before a session replacement are dropped. Accepted: they describe a dead installation; the active handle's ledger is the meaningful one.

## Migration Plan

No migration: the change is behavior-only, additive at the registration seam, and covered by the existing test suite plus the new rebind contracts. Rollback is reverting the commit.
