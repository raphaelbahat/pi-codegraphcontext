## Context

ADR-0007 made the continuous `cgc watch` strictly opt-in (default off), generalizing the embedded-backend lock to all backends. The watcher-defaults research corrected the record: the exclusive process-scoped lock is an embedded-backend property (Kùzu family); on server backends (Neo4j, falkordb-remote) the watcher, the CGC MCP server, and index runs were all probed coexisting. But three backend-independent failure modes keep default-OFF honest: (1) the extension records `fresh` at spawn with no liveness check — a watcher that dies within milliseconds leaves a stale "fresh" claim (the same dishonesty CGC's own watcher state-clearing guards against); (2) the watcher is an unrequested ~108 MB resident daemon; (3) on an unindexed workspace `cgc watch .` performs a full initial scan, bypassing the `lifecycle.autoCreate: false` consent model. The adopted shape is the tri-state `freshness.watch` (`off` default / `on` unconditional / `auto` gated) plus liveness verification.

In-force ADR set: 0001 (binary-only integration), 0002 (readiness-gated, non-configurable guidance), 0003 (confirmation-gated destructive actions), 0004 (passive status renderers), 0005 (universal output policy pipeline), 0006 (CLI gap tools boundary), 0007 (lazy freshness, watcher opt-in), 0008 (worktree isolation via named contexts), 0009 (two-tier proactive injection). This design refines ADR-0007 without contradicting it: the watcher stays opt-in (the default is `off`, byte-compatible with today's `false`); ADR-0010 records the corrected rationale and the tri-state policy.

## Goals / Non-Goals

**Goals:**
- Tri-state `freshness.watch`: `off` (default), `on` (unconditional), `auto` (backend-aware, indexed-only, liveness-verified).
- Boolean compatibility: existing `true`/`false` configs map to `on`/`off` with identical behavior.
- Honest freshness: no "fresh" claim until the watcher's liveness is verified within `freshness.watcherLivenessMs`; a dead/failed watcher degrades to the honest not-verified state plus a one-time notice.
- Backend detection helper: bounded, fail-open to the conservative embedded answer.
- Consent model intact: `auto` never spawns on an unindexed workspace.

**Non-Goals:**
- Not changing the lazy drift/sync path, the sync budget, or the state-machine statuses (the store's literal set is unchanged; "not verified" reuses `possibly-stale` + `lastError`).
- Not arbitrates between a user's manual terminal watcher and the managed one (documented, not fought — see Decisions).
- Not changing ADR-0001–0009; the corrected rationale is recorded in a new superseding-context ADR (0010), not an edit to 0007.
- Not pursuing a stronger "is watching" probe than process liveness: CGC exposes no queryable watcher-registry surface in v0.6.x, so survival of the stabilization probe IS the verifiable contract.

## Decisions

### D1 — Tri-state config with additive boolean compat (`extensions/config.ts`)

`FreshnessConfig.watch` becomes the literal union `'off' | 'on' | 'auto'` (type `WatchMode`), default `'off'`. Parsing (`parseWatchMode`, shared by the file layer and the environment layer):
- Native boolean → `true` → `'on'`, `false` → `'off'` (byte-compatible with today's behavior).
- String → normalized (trim, lowercase): `true/yes/on/1` → `'on'`; `false/no/off/0` → `'off'`; `auto` → `'auto'`; anything else is invalid (warning, skipped).
- `auto` never results from a boolean value — only the literal text enables the gated mode.

New key `freshness.watcherLivenessMs` (positive integer, default 15000) validated like the other numeric keys (the `maxSyncsPerSession` validator pattern): non-positive, non-integer, or non-numeric values are skipped with a warning. New `ConfigKey` entries and env mapping `CGC_FRESHNESS_WATCHER_LIVENESS_MS` follow the existing tables. Alternative considered: keeping the boolean type and adding a separate `freshness.watchMode` — rejected as two sources of truth for one behavior.

### D2 — Backend detection helper (in `extensions/freshness.ts`)

The extension has no backend probe today. New bounded helper:

- `detectCgcBackend(options)` resolves the backend name in CGC's own precedence order (verified against CGC v0.6.13 source, `cli/main.py` database-selection block):
  1. `CGC_RUNTIME_DB_TYPE` (CGC's runtime override),
  2. `DATABASE_TYPE` / `DEFAULT_DATABASE` from the process environment,
  3. `cgc doctor` parse — the "Default database: <name>" line (main.py prints exactly `Default database: {default_db} (source: {db_source})`), preferred over the .env read because doctor resolves CGC's full chain (context database, merged .env, auto-detect) itself,
  4. `DATABASE_TYPE` / `DEFAULT_DATABASE` parsed from `~/.codegraphcontext/.env` (`KEY=VALUE` lines, quotes stripped),
  5. unknown → `null`.
- The doctor probe is time-bounded (5 s budget constant) and any failure (non-zero exit, timeout, unparseable output) falls through to the next source. Values are normalized lowercase.
- `isServerBackend(name)`: true only for `neo4j` and `falkordb-remote`. Every other value — `kuzudb`, `falkordb`, `ladybugdb`, `nornic`, unknown, null — is treated as embedded/conservative (fail-open to no-spawn).
- Detection runs at most once per session (cached on the observer), bounded spawn cost, and never blocks the session-start path (the whole gating sequence is fire-and-forget).

### D3 — Auto-mode gating order (the observer's spawn point)

`startWatcherIfEnabled` becomes an async fire-and-forget sequence (still never awaited from `session_start`, still guarded fail-open, still one attempt per session). Evaluation order — cheap and consent-critical first:

1. mode `off` → return (no detection, no spawn — byte-compatible with today's false);
2. no session cwd / runner missing / worktree gate blocks → return (unchanged);
3. mode `on` → spawn (unconditional on backend; the existing runner + gate checks are the only conditions);
4. mode `auto`:
   a. resolve backend (D2); not a server backend → one-time notice (`watcher-not-started-embedded`), return — no spawn;
   b. `isWorkspaceIndexed(cwd)` false → one-time notice (`watcher-not-started-unindexed`), return — no spawn, no index creation;
   c. all conditions pass → spawn with liveness verification (D4).

The unindexed check is the same filesystem marker (`isWorkspaceIndexed`, workspace.ts) CGC's own watcher uses for its "Already indexed" verdict — no new probe surface. The decline notices are once-per-session under their own condition keys so a user who chose `auto` can always see why nothing spawned.

### D4 — Liveness verification replaces the spawn-time fresh record

Today `startWatcher` records `fresh` unconditionally at spawn. Replaced by:

- Spawn through the shared runner exactly as today (long budget, live-children teardown).
- The fresh record moves to AFTER verification: the tracking promise resolves only when the watcher exits, so "settled" is the observable death signal. Verification waits up to `watcherLivenessMs` (injectable `sleep` seam for deterministic tests); if the run settled within the window, the watcher failed liveness.
- Verified → record `fresh` + one-time `watcher-started` notice; drift suppression stays active (it already keys on `watcherActive`).
- Failed liveness → `watcherActive=false`, `watcherFailed=true` (lazy mode resumes), record the honest not-verified state (`possibly-stale` + `lastError` naming the failure — no new status literal, so HUD/status renderers need no change), surface the one-time `watcher-not-verified` notice. Never a false "fresh".
- Settle semantics stay: BUSY → the existing shared `skipped-busy` notice with the store untouched (unrecorded = no claim); session teardown (`CANCELLED`) records nothing. A mid-session death AFTER verified liveness keeps the today behavior (error recorded, the next observed edit re-opens the episode and the lazy path takes over).
- Verification applies to `on` and `auto` alike — the honest-claim requirement is backend- and mode-independent; `on` users accept the watcher, not an unverifiable claim.

### D5 — Notices and the double-watcher posture

New once-per-session notices (design D4 convention, `ui.notify` only — never the agent context): `watcher-started` (info, after verified liveness), `watcher-not-started-embedded` (info, auto declined: embedded/unknown backend), `watcher-not-started-unindexed` (info, auto declined: unindexed workspace), `watcher-not-verified` (warning, liveness failed). The existing `skipped-busy` notice is unchanged. A user's own terminal `cgc watch` is documented as coexisting (server backends) or conflicting (embedded: the managed start settles BUSY and degrades honestly) — the extension reports, it does not fight: no discovery, no kill, no arbitration beyond the existing BUSY handling.

### D6 — Wiring and settings modal

`extensions/index.ts` passes `watch` (now the tri-state), `watcherLivenessMs`, and the production `detectBackend` (bound to the configured `cgc.executable`) into the observer; when no detector is wired (construction failure paths), `auto` resolves to the conservative no-spawn. `extensions/settings-modal.ts`: `'freshness.watch'` moves from the boolean kind to the enum kind with options `['off', 'on', 'auto']` (generalizing the `worktree.mode` pattern into a per-key options table) so the modal cycles the real value domain and validates with the same rule the loader enforces.

## Risks / Trade-offs

- [Doctor probe cost (spawns `cgc doctor`, DB connectivity checks)] -> 5 s hard budget, once per session, fire-and-forget from session start; explicit-env shortcut short-circuits the common override case.
- [Verification delays the fresh record by up to `watcherLivenessMs`] -> Honest-by-construction: no claim beats a false claim; the window is advisory state only and nothing blocks on it.
- [`auto` decline notices could surprise users who expected a watcher] -> That is the point: the conservative default is observable, once per session, with the exact reason and the `on` escape hatch named.
- [Unverified watcher leaves `possibly-stale`, which suppresses the episode-opening sync trigger until the next `fresh`] -> Accepted: the state is visible (HUD/status), the notice names `/cgc sync`, and the gate's start-time sync reconciles next session; keeping auto-sync retry-on-edit would re-couple the lazy path to a watcher that just failed.
- [Detection heuristic vs. CGC's full context resolution] -> Doctor parse is CGC's own resolved answer; the env/.env fallbacks mirror its documented precedence; unknown always fails conservative.
- [Tri-state widens the config type] -> Additive: boolean inputs map losslessly; `off` default preserves today's behavior byte-for-byte; no existing valid config breaks.

## Migration Plan

No migration step: the default (`off`) equals today's effective default (`false`), and boolean values map to identical behavior. Users who set `true` keep their watcher (now with liveness verification — strictly more honest). Users who want the backend-aware default set `auto` explicitly. Rollback is a revert of the change; no persisted state is involved (the freshness store is process-lifetime).

## Open Questions

- None blocking. The stronger "is watching" probe (querying CGC for a watcher registry) is deferred until CGC exposes a queryable surface; process-survival liveness is the verifiable contract today.
