## 1. Display implementation

- [ ] 1.1 Pin the Pi TUI status/footer rendering surface from the installed `docs/extensions.md` / `docs/tui.md` before coding; decide primary vs fallback (notice-on-change) rendering path and record the choice in the implementation.
- [ ] 1.2 Implement the one-line chip renderer from lifecycle state (ready / unindexed / busy / corrupt / unavailable, plus indexing…/syncing… activity states), event-driven with debounce coalescing of rapid transitions.
- [ ] 1.3 Subscribe to freshness state when the freshness capability is present; omit the freshness section otherwise (specified degradation).
- [ ] 1.4 Implement the per-session one-time warning set (cgc-missing; unindexed with auto-create guidance; busy with lock-conflict naming; corrupt with rebuild-pointer) surfaced through the session notice surface, deduplicated per condition.
- [ ] 1.5 Implement headless/non-TUI gating: the display module fully deactivates (no chip, no TUI notices) outside TUI sessions.
- [ ] 1.6 Enforce the passive boundary structurally: the display module holds no reference to the `cgc` runner; add a lint/test assertion that no display code path can spawn or poll.

## 2. Verification and closure

- [ ] 2.1 Test the state→chip mapping for every lifecycle state, including activity states and debounce coalescing.
- [ ] 2.2 Test once-per-session warning semantics, including re-entering a previously shown condition silently.
- [ ] 2.3 Test headless no-op behavior and fail-open containment (render errors swallowed, no more than one attempt per state change).
- [ ] 2.4 Verify all scenarios in `specs/cgc-status-display/spec.md` against the implementation.
- [ ] 2.5 Run `openspec validate add-cgc-status-hud --type change --strict` before archive.
