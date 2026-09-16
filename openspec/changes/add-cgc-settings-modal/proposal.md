# Add CGC Settings Modal

## Why

The extension's configuration lives in hand-edited JSON files (project `.pi/cgc.json` over the global `<agent-dir>/cgc.json`, both layered over defaults and under env overrides). There is no in-session surface: the human must leave the session (or ask the agent) to edit JSON by hand, guessing at key names, valid ranges, and which layer currently wins. The user requested a small modal HUD to configure the extension from within Pi, citing the `/context` command of the `pi-context` extension (spences10/my-pi) as a working example of the pattern.

## What Changes

- A new `/cgc config` verb on the existing `/cgc` command registration (one registration, per the repo's verified pi dispatch constraint) that opens an interactive settings modal in the TUI.
- The modal renders every config key with its effective value and source (`default` / `config-file` / `env`, from `ConfigResult.sources`):
  - Booleans cycle on/off inline (pi-tui `SettingsList`); `worktree.mode` cycles its `off`/`isolate` enum.
  - Numeric keys (`cgc.timeoutMs`, `cgc.versionProbeTimeoutMs`, `cgc.api.port`, `freshness.maxSyncsPerSession`, `output.maxBytes`) and the string key `cgc.executable` are edited through an in-modal text input validated with the exact rules of `extensions/config.ts` (positive-ms timeouts, TCP port 1–65535, positive whole bytes, positive sync count, non-empty executable).
  - Env-overridden keys are read-only display (naming the winning env var): editing a file cannot beat the env layer, so offering an edit would lie about the effect.
- A write-target selector (Project `.pi/cgc.json` — the default — or Global `<agent-dir>/cgc.json` via `resolvePiAgentDir`) applies to the edits saved in one modal session.
- Saves merge into the chosen target file with a never-clobber policy: the existing JSON is read and only the edited nested keys are set; unknown sections/keys and already-malformed sections are preserved verbatim; an unparsable target file is refused with a warning rather than rewritten. Writes are atomic (temp file + rename).
- Honest immediate-effect semantics: a successful save states that changes apply at the next session start (the running process keeps its loaded values); the modal never implies live application.
- Headless degradation: outside the TUI the verb renders the current effective key/value/source table and points at the config files — no modal is attempted.

## Capabilities

### New Capabilities

- `cgc-settings-modal`: an in-session, TUI-modal settings HUD for the extension's configuration — display of effective values and sources, validated editing of file-layer-writable keys, layer-targeted never-clobber persistence, and honest next-session effect semantics.

### Modified Capabilities

(none — the `/cgc config` verb is delivered through the existing single `/cgc` registration owned by `cgc-slash-commands`' implementation; this change alters no requirement of that capability. Registration details are specified here.)

## Impact

- Extension package `pi-codegraphcontext`: a new `extensions/settings-modal.ts` module plus a `config` verb added to the existing `registerCgcCommands` dispatch (`extensions/commands.ts`); `extensions/config.ts` gains export-ready validation helpers and an atomic merge-write helper (behavior of `loadConfig` unchanged).
- UI built exclusively on pi's documented extension surfaces — `ctx.ui.custom()` with `{ overlay: true }` (experimental overlay mode, with a specified degradation chain) and `SettingsList`/`SelectList`/`Text` from `@earendil-works/pi-tui`. No third-party modal dependency.
- Registers no agent tools (ADR-0001); spawns no `cgc` processes; performs no maintenance work (ADR-0004's passive-renderer rule applies to the read paths).
- File writes are confined to the two existing config files; no other files are created or modified.
- Fail-open: every UI and filesystem failure degrades to a notice; the command handler can never crash or block the session.
