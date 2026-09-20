## Why

CGC's own `ENABLE_AUTO_WATCH` config (env has highest priority in CGC's config loader) makes every `cgc index` run fork into a background watcher after indexing and block forever — empirically measured: indexing finishes in ~16.6 s, then prints "ENABLE_AUTO_WATCH is enabled. Starting watcher..." and hangs until killed. The user machine's environment sets `ENABLE_AUTO_WATCH=true`, and the extension's runner passes no env override, so every "short-lived" gate invocation (the sync verb, the session-start sync, freshness auto-syncs, the auto-create path) inherits it and blocks. The 0.8.2 maintenance budget (600 s) only delays the timeout warning; it does not fix the fork. The extension must own its watcher policy explicitly — the only watcher it sanctions is the opt-in managed `freshness.watch` child — so its spawns must never fork their own watchers.

## What Changes

- The shared runner pins `ENABLE_AUTO_WATCH=false` in every child process environment it constructs, merged over the inherited environment (every other variable inherited unchanged). One pin covers all cgc invocations — the verbs, the probes, and the gate paths — because the runner is the single spawn path.
- The pin is safe on the managed watcher child (`freshness.watch` spawns `cgc watch .` through the same runner): `cgc watch` never reads `ENABLE_AUTO_WATCH` (verified in CGC's CLI source — only the index helper reads it), so the pin is inert there and the managed watcher is unaffected.

## Capabilities

### New Capabilities

- None

### Modified Capabilities

- `cgc-index-lifecycle`: the runner's spawn contract gains an environment pin — every extension-spawned `cgc` invocation carries `ENABLE_AUTO_WATCH=false` so short-lived index runs can never fork a blocking background watcher, regardless of the user's machine environment or CGC config.

## Impact

- `extensions/runner.ts` (the `childEnv` spawn-environment construction — one constant, one merge).
- `extensions/runner.test.ts` (new env-pin assertions following the existing `CGC_OUTPUT_FORMAT` child-env test pattern).
- No user-facing documentation changes: `ENABLE_AUTO_WATCH` is a CGC-owned environment variable, not an extension config key; the agent guide and README only document extension-level `CGC_*` overrides and never claim anything about child env inheritance.
