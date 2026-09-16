# Tasks: Add CGC Settings Modal

## 1. Config read/write plumbing

- [x] 1.1 Export shared validation helpers from `extensions/config.ts` (boolean, worktree-mode enum, timeout-ms, port, max-bytes, max-syncs, non-empty executable) with the exact rules and message shapes of the existing load-time parsers, and refactor the load-time parsers to use them without behavior change.
- [x] 1.2 Implement the never-clobber atomic merge writer: read the target `cgc.json` (refuse unreadable/non-object/touched-section-non-object with a typed refusal), apply only the edited nested keys, write via temp file + rename (dir `0o700` when created, file `0o600`); unit-test unknown-key preservation, malformed-file refusal, and all-or-nothing semantics.
- [x] 1.3 Add the fresh-load read path for the modal (`loadConfig` at open time, not the process cache) producing the key/effective-value/source rows, with env-sourced keys annotated with their `CONFIG_ENV_VARS` name.

## 2. Settings modal UI

- [x] 2.1 Implement `extensions/settings-modal.ts`: the `ctx.ui.custom` overlay modal (experimental `{ overlay: true }` path) composed from pi-tui `SettingsList`/`SelectList`/`Text`/`Box`, with a staged-edits model, ESC close, and explicit save — pinned against the installed `docs/extensions.md` "Custom UI / Overlay Mode" and `docs/tui.md` Patterns 1 and 3 during implementation.
- [x] 2.2 Implement the interaction kinds: inline cycling for booleans and `worktree.mode`, in-modal text input for numeric/string keys with D4 validation and loader-shaped rejection messages, and read-only rendering for env-overridden keys.
- [x] 2.3 Implement the write-target selector (Project default, Global via `resolvePiAgentDir`), the save flow through the 1.2 writer, and the post-save "applies at next session start" notice (D3).
- [x] 2.4 Implement the degradation chain: overlay → non-overlay `ctx.ui.custom` → `ctx.ui.select`/`input`/`confirm` dialog flow → headless read-only key/value/source table guarded on `ctx.mode === "tui"`.

## 3. Command wiring and guardrails

- [x] 3.1 Add the `config` verb to `CGC_SUBCOMMANDS`, the usage text, and `getArgumentCompletions` in `extensions/commands.ts`, dispatching to the modal in TUI mode and the read-only renderer otherwise; verify no second `pi.registerCommand` call is introduced.
- [x] 3.2 Enforce the fail-open contract: every UI and filesystem failure path degrades to a bounded, severity-tagged notice and the handler returns without throwing; assert with tests that handler errors never crash or block the session.
- [x] 3.3 Assert in tests: no agent tools registered by the modal, no `cgc` spawns, and writes confined to the two config file targets (ADR-0001 boundary).
- [x] 3.4 Verify all scenarios in `specs/cgc-settings-modal/spec.md` against the implementation.
- [x] 3.5 Run `openspec validate add-cgc-settings-modal --type change --strict` before archive.
