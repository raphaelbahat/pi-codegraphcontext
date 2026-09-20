## 1. Runner env pin

- [x] 1.1 Add the `ENABLE_AUTO_WATCH` constant and pin `ENABLE_AUTO_WATCH=false` in `extensions/runner.ts`'s `childEnv()` construction, merged over the inherited environment (every other variable inherited unchanged), before the `CGC_OUTPUT_FORMAT` merge.

## 2. Tests

- [x] 2.1 Add the runner env-pin tests in `extensions/runner.test.ts` following the `CGC_OUTPUT_FORMAT` pattern: child sees `ENABLE_AUTO_WATCH === 'false'`; a caller-provided `env` with `ENABLE_AUTO_WATCH=true` is overridden; another inherited variable passes through unchanged.
- [x] 2.2 Run the full test suite (`bun test`) and confirm green; run `bunx tsc --noEmit` and `bunx biome check` and confirm clean.

## 3. Validation and gating

- [x] 3.1 Run `openspec validate pin-auto-watch-env --type change --strict` and confirm the change validates.
- [x] 3.2 Confirm no user-facing doc changes are needed (agent-guide/README document only extension-level `CGC_*` overrides, nothing about child env inheritance) and record the watcher-spawn safety analysis outcome in the completion notes.

## Completion notes

- Watcher-spawn safety analysis outcome: the managed `freshness.watch` watcher child IS spawned through the shared runner, so the pin applies to it. Verified harmless against CGC's CLI source: `ENABLE_AUTO_WATCH` is read in exactly one place — the index helper (`cli_helpers.py`, the post-index fork-and-block) — and nowhere in the `cgc watch` command, `watch_helper`, or `core/watcher.py`, so the pin is inert on the watcher child and `freshness.watch` behavior is unchanged.
- Verification evidence: full suite 957 pass / 0 fail / 1 todo (958 tests, 32 files); `bunx tsc --noEmit` clean; `bunx biome check .` exit 0 (6 pre-existing infos in unrelated files); `openspec validate pin-auto-watch-env --type change --strict` valid.
- No user-facing doc changes: the agent guide and README document only extension-level `CGC_*` overrides and claim nothing about child env inheritance, so no accuracy test changes were needed.