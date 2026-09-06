# Task Validation: add-cgc-proactive-context-injection

- Validated against: live framework/library/tool documentation
- Validation date: 2026-09-06

Validation method: one read-only validator (single technology group spanning the Pi injection/event surface and the CGC stats verb) checked every externally-observable claim in tasks.md against the locally installed Pi documentation (bundled docs, authoritative for the installed version) and the project's live files on GitHub `main`, corroborated empirically against the locally installed CGC binary.

---

## VALID — confirmed

### 1.3

- The injection mechanism is confirmed with the corrected names (consistent with change 2's pinned findings): there is no `addPromptGuidelines`; the documented `before_agent_start` Agent event lets an extension return a `systemPrompt` (appended paragraph, chained across handlers) and/or an injected persistent `message` — the correct vehicle for the session-start coverage note, gated to fire once at the first turn after `session_start`. (`systemPromptOptions.promptGuidelines` exists but is tool-scoped, appended only while the tool is active — not suitable for a session note.)
  - Evidence: `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (lines 530–560 "before_agent_start … Can inject a message and/or modify the system prompt"; lines 1373–1388, 1919–1921 for tool-level `promptGuidelines`)

### 1.2

- `cgc stats` is documented as "Repository and node counts for the active context" and empirically returns an Overall Database Statistics table (Repositories, Files, Functions, Classes, Interfaces, Modules; per-repo via the optional `path` argument) — exactly the coverage fields the note summarizes.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/reference/cli.md> (stats row) ; local `cgc stats` / `cgc stats --help` run on the installed binary
  - Empirical excerpt (local `cgc stats`, 2026-09-06): table titled `Overall Database Statistics` with rows `Repositories`, `Files`, `Functions`, `Classes`, `Interfaces`, `Modules` (columns `Metric` / `Count`).

### 2.1

- The drift-steer trigger is implementable as designed: the documented `tool_call` event (and `tool_result` for completion) fires per tool execution with `event.toolName`/`event.input` — sufficient to know when file-modifying activity happens and when a staleness episode opens (freshness state from change 7 supplies the episode boundary).
  - Evidence: `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (lines 70–71, 273–306 event flow, 778–841 `tool_call`, 842+ `tool_result`)

### 3.4

- `openspec validate <item> --type <type> --strict` matches the installed OpenSpec CLI usage exactly.
  - Evidence: `openspec validate --help` (verified 2026-09-06; same CLI verified for change 1)

---

## Fixes needed

None.

---

## Verdict

`VERDICT: READY`
