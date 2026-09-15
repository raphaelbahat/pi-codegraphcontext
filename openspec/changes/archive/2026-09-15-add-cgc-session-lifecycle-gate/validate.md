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

> **Re-validated 2026-09-07 (post task 1.1 verification marking)** — `openspec validate --type change --strict` passed; READY re-confirmed after the latest tasks.md revision.

---

## Task 4.1 — spec scenario verification (`specs/cgc-index-lifecycle/spec.md`)

All 15 scenarios walked against the implementation in `extensions/` (files: `gate.ts`, `classifier.ts`, `workspace.ts`, `runner.ts`, `cleanup.ts`, `config.ts`, `budget.ts`, `lifecycle-state.ts`, `unindexed.ts`, `drift.ts`, `corrupt.ts`, `busy.ts`, `clean.ts`). Verification evidence: `bun test extensions/` 203 pass / 0 fail, `bunx tsc --noEmit` exit 0, `bunx biome check extensions/` clean. Each scenario below is mapped to its implementing code and its load-bearing tests.

### Session-start index detection

- **Workspace with an existing index starts a session** — Gate resolves cwd, classifies via cached probe pair, routes `clean` → `CleanPath` (silent skip) and records the state into the per-session store. Non-blocking is structural: the `session_start` body is synchronous and fires the evaluation in the background (never awaits cgc). Tests: `gate.test.ts` "returns immediately without awaiting cgc completion (never blocks the loop)", "resolves the workspace from ctx.cwd…", "routes clean: silent skip with zero maintenance invocations".
- **Workspace without an index starts a session** — No `.codegraphcontext/` → `unindexed`; session proceeds via the notice path (`UnindexedPath.handle`, consent gate closed by default). Test: `gate.test.ts` "routes unindexed (autoCreate off) to the one-time notice without indexing".
- **Session working directory is the source of truth** — `handleSessionStart` reads `ctx.cwd` only; `WorkspaceDetector.resolveSessionCwd` prefers the session cwd, and every spawn carries the explicit session cwd (`runner.run(cwd, …)`, never `process.cwd()`). Test: `gate.test.ts` "resolves the workspace from ctx.cwd (never process.cwd)" asserts every recorded spawn cwd equals the session cwd.

### Opt-in index creation

- **Auto-create disabled (default)** — `config.ts` `lifecycle.autoCreate` default `false`; `UnindexedPath.handle` surfaces the one-time `buildUnindexedNotice` (guidance: `.pi/cgc.json`, `~/.pi/agent/cgc.json`, `CGC_LIFECYCLE_AUTO_CREATE=1`, manual `cgc index .`) and spawns nothing. Tests: `gate.test.ts` unindexed-off routing; `unindexed.test.ts` autoCreate-off suite.
- **Auto-create enabled** — Consent gate open → `cgc index .` starts in the background (fire-and-forget), `indexing-started` notice surfaces, session proceeds; settle records `indexing-settled` into state. Tests: `gate.test.ts` "routes unindexed (autoCreate on) to background indexing and records the settle"; `unindexed.test.ts` autoCreate-on suite.

### Start-time drift sync

- **Indexed workspace with files changed since last sync** — Health probe output matches `STALENESS_PATTERN` → `drift` → `DriftPath` starts background incremental sync (`cgc index .`, which is incremental by default per the 2.4 validation note above) and records `drift-sync-started`. Test: `gate.test.ts` "routes drift to a background sync and records the settle".
- **Indexed workspace with no drift** — No staleness evidence in parseable health output → `clean`; `CleanPath` runs zero maintenance invocations by construction (no runner; `CLEAN_PATH_MAINTENANCE_INVOCATIONS === 0`). Tests: `gate.test.ts` clean routing; `clean.test.ts`.

### Corrupt index requires explicit rebuild consent

- **Corrupt index detected** — Corruption markers or any inconclusive/unparseable probe outcome map to `corrupt` (fail-safe bucket); `CorruptPath.handle` only reports and offers a rebuild — it never spawns, deletes, or modifies anything. Any destructive action requires `rebuild(cwd, { confirm: true })`, which delegates the replacement to `cgc index . --force` (never the deletion verbs, ADR-0003). Tests: `gate.test.ts` "routes corrupt to the one-time report + offer with no destructive action"; `corrupt.test.ts` confirmation-gate suite; `classifier.test.ts` fail-safe suites (unparseable/failed/timed-out probes).

### Busy and lock conflicts skip gracefully

- **Embedded database locked by another CGC process** — A `BUSY` health probe classifies `busy`; a maintenance command settling `BUSY` is routed to the busy path by `attachSettle`. `BusyPath` surfaces one one-time notice naming the conflicting process state and skips; it holds no runner, so retry/kill/lock-delete are structurally impossible (design D4). Tests: `gate.test.ts` both busy-routing tests; `busy.test.ts` probe-trigger, lock-error-trigger, and one-time-across-both-triggers suites.

### Clean state performs no redundant work

- **Healthy index on repeated sessions** — The clean path spawns nothing; the only cgc cost anywhere is the cached detection pair (`cgc --version` + one `cgc stats`), each cached per session (`WorkspaceDetector.probeCache`, `LifecycleClassifier.healthCache`) and dropped on session reset, so each new session pays exactly the one allowed cached liveness check and never re-indexes. Tests: `gate.test.ts` "re-evaluating the same workspace in one session is a repeat, not a re-do"; `workspace.test.ts` probe caching; `classifier.test.ts` health-probe caching/budget.

### Safe execution and teardown of cgc invocations

- **Indexing command runs to completion** — `CgcRunner` captures output into bounded buffers (256 KiB/stream, most-recent-bytes kept), resolves a structured result, the path records the settle into state, and in-flight dedup on `(cwd, args)` guarantees no parallel duplicate. Tests: `runner.test.ts` bounded-capture and dedup suites; `gate.test.ts`/`unindexed.test.ts`/`drift.test.ts` settle recording.
- **Hung command is cancelled** — The runner's time budget terminates the child (SIGTERM, SIGKILL after grace) and resolves `TIMEOUT`; a timed-out health probe fails safe to `corrupt` (no maintenance is triggered) and the session is unaffected (fire-and-forget). Tests: `runner.test.ts` "terminates a hung command at the time budget and reports TIMEOUT"; `classifier.test.ts` "maps a timed-out health probe to corrupt".
- **Session shuts down while work is in flight** — Three independent teardown paths: `session_shutdown` → `killAll` (graceful SIGTERM→SIGKILL), `process` `exit` → synchronous hard-kill, SIGINT/SIGTERM/SIGHUP → hard-kill then signal re-raise; every extension-spawned child is tracked by the single runner. Tests: `cleanup.test.ts` all three paths; `gate.test.ts` "shuts down with an evaluation in flight" (real child, repeatedly stable).

### Fail-open operation

- **cgc binary is missing** — Spawn failure / failed `--version` → `UNAVAILABLE` → `unavailable` state with the one-time `buildUnavailableNotice`; nothing is spawned and the session proceeds. Tests: `runner.test.ts` "reports UNAVAILABLE when the executable cannot be spawned"; `gate.test.ts` "routes unavailable: one-time warning notice, no work beyond the probe".
- **Gate errors are contained** — Every hook body and every path is try/catch-guarded; `evaluate` never rejects (failures captured as `gate-failed` into state); the one-retry cap (`SessionInvocationBudget.claimRetry`, work key `gate-evaluation`) allows exactly one re-attempt per failed evaluation per session and refuses further attempts (`gate-retry-refused`). Tests: `gate.test.ts` fail-open and one-retry-cap suites; `index.test.ts` fail-open registration; `budget.test.ts` retry ledger.

All 15 scenarios hold. No implementation change was required — task 4.1 verification passed against the current tree.

> **Re-validated 2026-09-10 (task 4.1 spec scenario verification)** — all 15 scenarios in `specs/cgc-index-lifecycle/spec.md` walked against the implementation and PASS; 203/203 tests green, tsc clean, biome clean. READY re-confirmed after the task 3.3 verification marking. (Command-level gate: task 4.2 `openspec validate add-cgc-session-lifecycle-gate --type change --strict` remains to be run by the next agent before archive.)

---

## Task 4.2 — `openspec validate` command-level gate

Ran `openspec validate add-cgc-session-lifecycle-gate --type change --strict` from the repository root (`/home/bahat/projects/pi-codegraphcontext`) on 2026-09-10.

Result: **pass** — CLI reported `Change 'add-cgc-session-lifecycle-gate' is valid` (exit 0).

> **Re-validated 2026-09-10 (task 4.2 command-level gate)** — `openspec validate add-cgc-session-lifecycle-gate --type change --strict` PASSED (exit 0). READY verdict re-confirmed with all 14 tasks (1.x–4.2) complete; change is ready for archive (openspec archive). Note: the change's working files in `extensions/` (gate.ts, gate.test.ts untracked; index.ts, index.test.ts modified) plus tasks.md/validate.md remain UNCOMMITTED — commit before archiving.
