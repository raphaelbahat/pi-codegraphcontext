# Task Validation: add-cgc-session-lifecycle-gate

- Validated against: live framework/library/tool documentation
- Validation date: 2026-09-06
- Verdict: READY

Validation method: three read-only validators (one per technology group) checked every externally-observable claim in tasks.md. Pi-harness claims were validated against the locally installed Pi documentation (`@earendil-works/pi-coding-agent`, bundled docs — authoritative for the installed version). CodeGraphContext claims were validated against the project's live documentation on GitHub `main` (Context7 unavailable in this environment; documented fallback used). Node.js claims were validated against live nodejs.org API documentation (current LTS).

---

## INVALID — requires revision

None.

---

## VALID — confirmed

### 1.1

- Pi extensions are TypeScript modules exporting a default factory receiving `ExtensionAPI`; packaging uses a `pi.extensions` field in package.json and the `pi-package` npm keyword for gallery listing; types import from `@earendil-works/pi-coding-agent` (loaded via jiti, no compile step).
  - Evidence: `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`, `.../docs/packages.md`, `.../README.md` (installed package docs)

### 1.3

- `child_process.spawn` runs the binary without a shell by default (`shell: false`), accepts `options.cwd`, and accepts `signal: AbortSignal` (abort ≈ kill); `AbortSignal.timeout(ms)` provides the time budget (v17.3.0+; backported to v16.14.0). `spawn` has no `maxBuffer` — bounded output capture is the caller's responsibility, matching the task's "bounded output capture" wording.
  - Evidence: <https://nodejs.org/api/child_process.html#child_processspawncommand-args-options> ; <https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay>

### 1.4

- `subprocess.kill([signal])` sends SIGTERM by default; signal-based termination is the documented cleanup mechanism (SIGKILL force on Windows). Nuance recorded for implementation: docs caveat that a delivered signal may not actually terminate the process. The `'exit'` event on `process` permits only synchronous operations and `beforeExit` is not emitted for `process.exit()`/uncaught exceptions — confirming the task's multi-path cleanup design (sync `exit` handler plus async-capable session-shutdown/signal paths).
  - Evidence: <https://nodejs.org/api/child_process.html#subprocesskillsignal> ; <https://nodejs.org/api/process.html#event-exit>

### 2.1

- The session working directory is exactly `ctx.cwd` on the documented `ExtensionContext` ("Current working directory"); `session_start` and `session_shutdown` events exist and pass `(event, ctx)`.
  - Evidence: `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` ("ExtensionContext → ctx.cwd", "Session Events")
- `cgc list` (ls), `cgc stats`, and `cgc doctor` are documented read-only probes (doctor checks configuration, database connectivity, parsers, dependencies, permissions).
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/reference/cli.md>
  - Nuance: reference table documents `cgc stats` without a `[PATH]` argument; use the bare form for the probe.

### 2.4

- `cgc index [PATH]` is "Incremental by default; --force rebuilds from scratch"; no `cgc sync` command exists — incremental sync is achieved by re-running `cgc index .`; `cgc watch --sync-on-start` reconciles graph↔filesystem before monitoring and is off by default.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/reference/cli.md> ; <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/guides/indexing.md>
  - Nuance: a complete graph may print "already indexed … Skipping" (skip-guard); changed files are still picked up — treat the message as informational, not failure.

### 2.5 / 2.6

- Embedded backends are single-process; concurrent access from another CGC process (Gateway, MCP server, watcher) yields the "Could not set lock on file" error class, documented as expected behavior ("not a configuration problem; cgc doctor won't help") — supporting skip-as-busy as the only lock policy and `cgc doctor` as a health probe, not a lock resolver.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/TROUBLESHOOTING.md>
  - Nuance: the lock-error entry names KùzuDB/LadybugDB explicitly; our artifacts intentionally say "embedded database" generically and never claim FalkorDB Lite lock semantics specifically.

### 2.2 (supporting)

- `.cgcignore` layering (defaults → `.gitignore` → `.cgcignore`, last match wins) is documented — relevant to drift detection scope.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/TROUBLESHOOTING.md> ; <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/guides/indexing.md>

### 4.2

- `openspec validate <item> --type <type> --strict` matches the local OpenSpec CLI usage exactly (`--type change|spec`, `--strict`, `--json`).
  - Evidence: `openspec validate --help` (installed CLI, verified 2026-09-06)

---

## Fixes needed

None. (Informational nuances above are recorded as implementation guidance, not invalid task details.)

---

## Verdict

`VERDICT: READY`

> **Re-validated 2026-09-07** after the disposition pass revised tasks.md and sibling artifacts — `openspec validate --type change --strict` passed; the READY verdict below is re-confirmed as of this date.
