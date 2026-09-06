# Task Validation: add-cgc-freshness-drift-sync

- Validated against: live framework/library/tool documentation
- Validation date: 2026-09-06
- Verdict: READY

Validation method: one read-only validator (single technology group spanning the Pi event surface and the CGC watcher/index verbs) checked every externally-observable claim in tasks.md against the locally installed Pi documentation (bundled docs, authoritative for the installed version), the project's live files on GitHub `main`, and the locally installed CGC package (`cgc index --help`, `cgc watch --help`, installed `core/watcher.py`) — Context7 unavailable in this environment; documented fallback used.

Approved precision fix applied: the validator pinned the exact drift-observation event (`tool_call`); design.md D1 and the Open Questions entry were updated with user approval under the established corrections policy. No verdict changed.

---

## INVALID — requires revision

None.

---

## VALID — confirmed

### 1.3

- The drift-observation event is pinned: Pi documents `tool_call` (fired after `tool_execution_start`, before execution; handler receives `event.toolName` and typed `event.input`, e.g. file paths for edit/write tools), complemented by `tool_execution_start`/`tool_execution_end`. No file-specific "file edited" event exists — tool-call interception is the available conservative signal, exactly what task 1.3 requires.
  - Evidence: `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (Events → Tool Events: `#### tool_call`, `#### tool_execution_start/end`)

### 2.4

- `cgc watch [PATH]` is a continuous, foreground, watchdog-based watcher (create/modify/delete/move monitoring; automatic re-indexing of affected files and relationships) running as a long-lived process until `cgc unwatch` or termination — managed-child semantics in the design map directly onto the documented behavior. Watchdog 6.0.0 confirmed in the installed package (`core/watcher.py` imports `watchdog.observers.Observer`). Note: upstream cli.md lists `cgc unwatch <PATH>` plainly, but the locally installed 0.6.10 CLI marks `cgc unwatch` as "[MCP only]" — informational only, since the design's managed-child termination (task 2.4) is the sole stop path regardless.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/reference/cli.md> (Real-Time Watchers); <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/guides/indexing.md> (§4); installed `codegraphcontext/core/watcher.py:11–13`

### 2.1 / 2.2

- `cgc index [PATH]` is "Incremental by default" (timestamps/hashes tracked; only changed files re-parsed) and a normal blocking CLI invocation with no background/daemon flag (`cgc index --help` on installed 0.6.10 confirms) — so the lazy-sync design (caller-side backgrounding via the shared runner) matches documented behavior exactly.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/reference/cli.md> (Core Index & Lifecycle); <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/guides/indexing.md> (§1); local `cgc index --help`

### 2.3 (supporting)

- The skip-as-busy posture reuses the single-process embedded-backend behavior validated for change 1 ("Could not set lock on file" when another CGC process — Gateway, MCP server, watcher — holds the database).
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/TROUBLESHOOTING.md> (validated in the change-1 round; same source)

### 3.5

- `openspec validate <item> --type <type> --strict` matches the installed OpenSpec CLI usage exactly.
  - Evidence: `openspec validate --help` (verified 2026-09-06; same CLI verified for change 1)

---

## Fixes needed

None outstanding. (The validator-pinned event name was applied to design.md with user approval under the established corrections policy.)

---

## Verdict

`VERDICT: READY`
