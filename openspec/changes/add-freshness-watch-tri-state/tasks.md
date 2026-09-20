## 1. Config layer (extensions/config.ts)

- [x] 1.1 Add the `WatchMode` literal union (`'off' | 'on' | 'auto'`), widen `FreshnessConfig.watch`, default `'off'`; add `freshness.watcherLivenessMs` (default 15000) to the config interface, `DEFAULT_CONFIG`, `ConfigKey`, and the env-var map (`CGC_FRESHNESS_WATCHER_LIVENESS_MS`).
- [x] 1.2 Implement `parseWatchMode` (boolean → on/off; string `true/yes/on/1` → on, `false/no/off/0` → off, `auto` → auto; else invalid) and wire it into the file-layer and env-layer cases for `freshness.watch`; implement the positive-integer validator for `freshness.watcherLivenessMs` in both layers.
- [x] 1.3 Config tests: off/on/auto/true/false (both layers), invalid values skipped with warnings, defaults unchanged, sources recorded.

## 2. Observer and backend detection (extensions/freshness.ts)

- [x] 2.1 Implement `detectCgcBackend` (env overrides → bounded `cgc doctor` "Default database:" parse → `.env` `DATABASE_TYPE`/`DEFAULT_DATABASE` fallback → null) and `isServerBackend` (only `neo4j`, `falkordb-remote`); injectable seams for tests (env, homeDir, runner/executable, timeout).
- [x] 2.2 Rework the watcher start: tri-state gating (off → never; on → unconditional; auto → server backend AND indexed workspace via `isWorkspaceIndexed`), async fire-and-forget, one attempt per session, decline notices (`watcher-not-started-embedded`, `watcher-not-started-unindexed`).
- [x] 2.3 Replace the spawn-time fresh record with liveness verification (`watcherLivenessMs` budget, injectable sleep): verified → `fresh` + `watcher-started` notice; failed → honest not-verified state (`possibly-stale` + recorded error) + `watcher-not-verified` notice; BUSY/CANCELLED settle semantics preserved.
- [x] 2.4 Observer tests: auto+server+indexed → spawn; auto+embedded → no spawn; auto+unindexed → no spawn; auto+unknown backend → no spawn; liveness failure → honest state + notice, never fresh; liveness success → fresh + notice; on/off behavior unchanged; detection helper unit tests (env, doctor parse, .env fallback, fail-open).

## 3. Wiring and modal

- [x] 3.1 Wire the tri-state value, `watcherLivenessMs`, and the production `detectBackend` (configured executable) into the observer in `extensions/index.ts`.
- [x] 3.2 Move `freshness.watch` to the enum kind in `extensions/settings-modal.ts` with options `['off', 'on', 'auto']` and the loader-matching validator; update modal tests.

## 4. Docs

- [x] 4.1 README: configuration table row for the tri-state `freshness.watch` and the new `freshness.watcherLivenessMs` key (plus the env-var table).
- [x] 4.2 docs/agent-guide.md: configuration rows for both keys, accurate to the implemented behavior.

## 5. Verification

- [x] 5.1 Full test suite green; `bunx tsc --noEmit` clean; biome clean.
- [x] 5.2 `openspec validate add-freshness-watch-tri-state --type change --strict` passes.
