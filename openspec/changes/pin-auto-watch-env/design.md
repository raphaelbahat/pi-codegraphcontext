## Context

CGC's `cgc index` reads `ENABLE_AUTO_WATCH` from its config loader (environment variables have highest priority — `config_manager.py` merges `os.getenv` over file config) and, when it is `true`, forks into a foreground watcher right after indexing (`cli_helpers.py` index helper: "ENABLE_AUTO_WATCH is enabled. Starting watcher..."), blocking forever. The extension's shared runner (`extensions/runner.ts`) is the single spawn path for ALL cgc invocations — the CLI verbs, the lifecycle probes, the gate paths, and the opt-in managed `freshness.watch` watcher child — and currently passes no env override, so children inherit the caller's environment untouched. On machines where `ENABLE_AUTO_WATCH=true` is set in the environment, every "short-lived" index run (the sync verb, the session-start sync, freshness auto-syncs, the auto-create path) forks a watcher and hangs; the 0.8.2 `cgc.maintenanceTimeoutMs` budget only delays the timeout warning.

The extension already owns its watcher policy (ADR-0007): the only watcher it sanctions is the opt-in `freshness.watch` managed child, started at session start through the same runner and terminated through every session cleanup path. Any watcher forked by a child process is unowned, untracked, and lock-hostile.

## Goals / Non-Goals

**Goals:**

- The extension's cgc spawns must NEVER fork their own background watchers — the extension owns its watcher policy explicitly.
- One pin covers everything: placed in the runner's spawn-environment construction, every invocation (verbs, probes, gate paths) inherits it without per-caller logic.
- All other environment variables pass through unchanged (CGC credential variables, PATH, context overrides).

**Non-Goals:**

- No user-facing documentation changes: `ENABLE_AUTO_WATCH` is a CGC-owned env var, not an extension config key; the agent guide/README document only extension-level `CGC_*` overrides and claim nothing about child env inheritance.
- No change to `freshness.watch` semantics: the managed watcher stays opt-in, default off, and unchanged in behavior.
- No new extension config key — the pin is unconditional policy, not user-configurable (the extension must own its policy; a config knob would reintroduce the failure mode).

## Decisions

**D1 — Pin in the runner's `childEnv`, not per call site.**
The runner's private `childEnv()` is the single point where the child environment for any invocation is built (it already merges `CGC_OUTPUT_FORMAT=gcf` there, design D5 of add-cgc-output-token-economy). The pin becomes a second unconditional merge in the same place:

```ts
const CGC_AUTO_WATCH_ENV = 'ENABLE_AUTO_WATCH'

private childEnv(base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env = { ...(base ?? process.env), [CGC_AUTO_WATCH_ENV]: 'false' }
  if (!this.gcfOutput) return env
  return { ...env, [CGC_OUTPUT_FORMAT_ENV]: 'gcf' }
}
```

Alternative considered: pinning per call site (the sync verb, the gate, the freshness path). Rejected — it duplicates policy across ~6 call sites and any future spawn site silently regresses; the runner is already the single spawn path ("one pin covers everything").

Alternative considered: pinning only on index-like verbs. Rejected — the pin is one line, unconditional, and CGC's auto-watch fork is reachable from any verb path that ends in indexing; unconditional is simpler and strictly safer.

**D2 — Merge over the inherited env, never replace it.**
The spread (`{ ...env, [KEY]: 'false' }`) keeps every inherited variable unchanged — CGC's credential keys, `CGC_API_KEY`, PATH, and the caller's other overrides all pass through. This matches the existing `CGC_OUTPUT_FORMAT` merge pattern. The `base ?? process.env` fallback is preserved: an explicit caller `env` still wins as the inheritance source.

**D3 — Watcher-spawn safety: the pin IS applied to the managed watcher child, and that is verified harmless.**
The managed `freshness.watch` child (`cgc watch .`, `WATCHER_ARGS` in `extensions/freshness.ts`) is spawned through the shared runner, so the pin applies to it too. Verified against CGC's CLI source: `ENABLE_AUTO_WATCH` is read in exactly one place — the index helper (`cli_helpers.py`, the post-index fork-and-block) — and nowhere in the `watch` command (`main.py` watch definition), `watch_helper`, or `core/watcher.py`. So `ENABLE_AUTO_WATCH=false` on the watcher child is inert: the command ignores it and the watcher keeps watching normally. No carve-out or conditional pin is needed (and a conditional would require verb sniffing in the runner — worse).

**D4 — Test approach.** Follow the existing `CGC_OUTPUT_FORMAT` child-env test pattern in `runner.test.ts` (`env: {}` base + a bun child script that echoes the variable): assert the child sees `ENABLE_AUTO_WATCH === 'false'`, that a caller-set `ENABLE_AUTO_WATCH=true` is overridden (the pin wins over inherited env), and that other inherited variables pass through unchanged.

## Risks / Trade-offs

- [CGC changes the variable name or adds new auto-fork behavior] -> The pin is one named constant; a CGC-side rename is a one-line follow-up. CGC's own default for the key is already `"false"` (config_manager `DEFAULT_CONFIG`), so the pin matches the upstream default posture.
- [Pin hides a legitimately desired user auto-watch] -> The extension sanctions its own watcher (`freshness.watch`) for exactly this; a user wanting auto-watch on manual CLI runs (outside the extension) is unaffected — the pin exists only inside the extension's child processes.
- [Caller-provided `env` relying on `ENABLE_AUTO_WATCH` passthrough] -> No extension call site passes this variable in `env`; the runner's contract is that it owns the child's watcher policy, and the test pins that contract.

## Migration Plan

Single-commit fix on the runner; no migration, no config change, no state change. Rollback is reverting the one merge line.

## Open Questions

- None. ADR-0007 (lazy freshness, watchers opt-in) is reinforced, not revisited: the pin keeps every extension-spawned process finite and leaves the managed opt-in child untouched. No in-force ADR requires supersession.