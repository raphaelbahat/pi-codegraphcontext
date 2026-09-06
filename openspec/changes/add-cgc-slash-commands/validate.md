# Task Validation: add-cgc-slash-commands

- Validated against: live framework/library/tool documentation
- Validation date: 2026-09-06
- Verdict: READY

Validation method: two read-only validators (one per technology group) checked every externally-observable claim in tasks.md. Pi-harness claims were validated against the locally installed Pi documentation (`@earendil-works/pi-coding-agent`, bundled docs — authoritative for the installed version). CodeGraphContext verb claims were validated against the project's live files on GitHub `main` (Context7 unavailable in this environment; documented fallback used).

Approved precision fix applied: the validator confirmed `cgc report` is documented without stating its output location; with user approval (same policy as the change-2 corrections), the spec's report scenario was softened to "the confirmed destination path" — no verdict changed.

---

## INVALID — requires revision

None.

---

## VALID — confirmed

### 1.1

- Commands register via `pi.registerCommand(name, options)` with `{ description, handler: async (args, ctx) => {...}, getArgumentCompletions? }`; the docs explicitly frame registered commands as slash commands (`/mycommand`), with argument auto-completion support.
  - Evidence: `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (lines 1525–1555, 14, 1541; example `examples/extensions/hello.ts`)
  - Note: colliding command names get numeric suffixes (e.g. `/review:1`) — harmless here, but the registration test should assert the bare `/cgc:*` names resolve without suffixes.

### 2.1

- Mid-command confirmation is documented: `await ctx.ui.confirm(title, message)` returns a boolean, works inside command handlers, and blocks awaiting the user. Caveat recorded for implementation: in print/JSON mode `ctx.hasUI` is false and dialog methods must be guarded (headless-safe requirement already specified).
  - Evidence: `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (lines 585–592, 970–974, 2523–2584; examples `timed-confirm.ts`, `permission-gate.ts`)

### 2.2 / 2.3

- `cgc index [PATH] [--force] [--summarize]` is a plain blocking CLI command — incremental by default, `--force` rebuilds, and no background/daemon flag exists, so backgrounding via the shared runner is the caller's responsibility (as designed). No `cgc sync` command exists; incremental sync = re-run `cgc index .`.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/reference/cli.md>

### 1.2 / 1.3 (supporting)

- `cgc doctor` is documented as read-only system diagnostics (configuration, database connectivity, Tree-sitter parsers, dependencies, permissions) with no documented mutation behavior.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/reference/cli.md>

### 2.4 (CV1 precision)

- `cgc report [--java]` is documented verbatim as "Generate CGC_REPORT.md with god-node, complexity, and coupling metrics", but the docs do not state where the file is written. The spec was softened accordingly: the confirmation names the exact destination path, and the implementation verifies the location empirically rather than assuming cwd.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/reference/cli.md>

### 3.1 (supporting)

- `ALLOW_DB_DELETION` (default `false`) gates `cgc clean` and `cgc delete`/`cgc rm`, both erroring while disabled — confirming the "no destructive verbs exposed" requirement maps to real CGC safety behavior the extension never touches.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/reference/cli.md> ; <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/reference/config.md>

### 3.4

- `openspec validate <item> --type <type> --strict` matches the installed OpenSpec CLI usage exactly.
  - Evidence: `openspec validate --help` (verified 2026-09-06; same CLI verified for change 1)

---

## Fixes needed

None outstanding. (The validator-prescribed report-location softening was applied to the spec scenario with user approval under the established corrections policy.)

---

## Verdict

`VERDICT: READY`
