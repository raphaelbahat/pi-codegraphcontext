# CGC agent guide

Scope: **CodeGraphContext v0.6.x**. This guide is written against the CGC
surfaces this extension wraps; a different CGC major/minor may rename verbs or
change defaults. It is the deep, always-current companion to the always-on
routing guideline card and the opt-in `cgc-routing` skill, which link here for
depth rather than repeating it.

The guide is organized **intent-first**: start from the question you are trying
to answer, not from a tool name. The routing table below is the primary
content; the reference sections after it are deliberately brief and link out to
the CGC documentation for depth.

Graph relationship tools are registered by the **CGC MCP server**, not by this
extension. The extension owns the `/cgc` commands, the CLI-gap tools, the
lifecycle/freshness automation, and the configuration below.

## Route by the question you are asking

| If the question is... | Route to | Examples |
| --- | --- | --- |
| Relationship, structure, or code health | CGC MCP graph tools: `analyze_code_relationships`, `find_dead_code`, `calculate_cyclomatic_complexity`, `find_most_complex_functions`, `find_code` | who calls this function, call chains, imports, class hierarchy, what a change affects, unused functions, hot spots |
| Exact text, a regex, or a file you can already name | Built-in search and file reading | a literal string, a known path, a config value |
| Workspace status and freshness | `/cgc status`, `/cgc sync` | is this workspace indexed, stale, or busy? reconcile graph/disk drift |
| Management: bundle export, named contexts, diagnostics | CLI-gap tools: `cgc_bundle_export`, `cgc_context`, `cgc_doctor` | snapshot a repo to a `.cgc` bundle, list/create/switch contexts, connection or parser failures |
| Quality report | `/cgc report` (and `/cgc doctor` for a bounded diagnostic render) | write the CGC quality report to a confirmed path |
| Index creation and maintenance | The automatic lifecycle gate and freshness auto-sync; `/cgc index` and `/cgc sync` as manual overrides | first-run creation, force a rebuild, keep a live index current |

### Relationship questions go to the graph

Callers, callees, call chains, impact, dead code, and complexity are graph
questions. Ask the CGC MCP server instead of reconstructing them by reading
files one at a time:

- `analyze_code_relationships` — callers, callees, imports, class hierarchy.
- `find_dead_code` — potentially unused functions.
- `calculate_cyclomatic_complexity` / `find_most_complex_functions` — hotspot
  and complexity analysis.
- `find_code` — keyword/symbol lookup over the index.

Tool names appear under whatever namespace your MCP configuration assigns. If
the MCP server is not configured, or the workspace lifecycle state suppresses
graph routing (see [Indexing](#how-the-index-is-created-and-kept-current)),
fall back to built-in search and say the graph was unavailable. Never fabricate
graph results.

### Exact-string work stays with built-in tools

Literal strings, regexes, and reading a file you can already name belong to the
harness's built-in search and file reading. Routing them through graph queries
is slower and lossier, and this guide does not steer that work away from the
built-in tools.

### Status and freshness go to `/cgc`

- `/cgc status` — read-only: the active workspace, lifecycle state, last
  action, and any running work.
- `/cgc sync` — triggers the incremental `cgc index .` reconcile for the
  active workspace (non-destructive; no confirmation).

### Management goes to the CLI-gap tools

The CGC MCP catalog does not expose bundle export, named-context management, or
diagnostics as tools; these three fill that gap by wrapping documented `cgc`
CLI verbs. Enable or disable all three together with `tools.cliGap.enabled`.

- `cgc_bundle_export` — `cgc bundle export`; writes a `.cgc` bundle. Requires
  confirmation.
- `cgc_context` — `cgc context`; `verb` is one of `list`, `create`, `delete`,
  `set-default`. `delete` requires confirmation and removes only the
  registration, never database files.
- `cgc_doctor` — `cgc doctor`; runs diagnostics and renders bounded output.

`/cgc doctor` is the slash-command surface for the same `cgc doctor` verb;
`cgc_doctor` is the tool-surface equivalent.

## Worked example session

One question, followed from first check to final outcome, using only
implemented surfaces. The scenario: a repository is already checked out, you
are asked to change `resolveWorkspace`, and you want to know what the change
affects before you touch it.

1. **"Is this workspace indexed, and is the graph current?"** This is a status
   question, so run `/cgc status`. It reports the active workspace, the
   lifecycle state, the last action, and any running work. If the state is
   `drift`, the session-start gate has already scheduled a background reconcile
   (`lifecycle.syncOnStart`, default on). If the state is `unindexed`, no index
   exists yet: with `lifecycle.autoCreate` off (the default) none was created,
   and `/cgc index` on an unindexed workspace is declined unless that opt-in is
   on. To create it, enable `lifecycle.autoCreate` first — `"lifecycle":
   {"autoCreate": true}` in `.pi/cgc.json` (or `CGC_LIFECYCLE_AUTO_CREATE=1`),
   then run `/cgc index` — or run `cgc index .` in a terminal. When the state is
   `unavailable` or `corrupt`, run `/cgc doctor` before trusting any graph
   answer.

2. **"Who calls `resolveWorkspace`, and what breaks if I change it?"** This is
   a relationship question, so ask the CGC MCP graph tool
   `analyze_code_relationships` for callers, callees, and impact instead of
   reconstructing the call graph file by file. The answer comes from the index
   because the state is ready (`clean`, `drift`, `syncing`, `indexing`, or
   `rebuilding`). Had the state been `unavailable`, `unindexed`, `busy`, or
   `corrupt`, graph routing is suppressed — fall back to built-in search and
   say the graph was unavailable rather than fabricating an answer.

3. **"Where does the literal string `resolveWorkspace(` appear in comments and
   tests?"** This is exact-string work, so use the built-in search and file
   reading. Do not route it to the graph: the index models relationships, not
   literal text.

4. **"I edited files — is the graph stale now?"** The first file-modifying
   tool call of the session marks the workspace possibly-stale. With
   `freshness.autoSync` on (default) the extension has already started one
   budgeted incremental `cgc index .`, capped at `freshness.maxSyncsPerSession`
   (default 2). Re-run `/cgc status`; if it still reports `drift`, run
   `/cgc sync` for an immediate incremental reconcile before the next
   relationship query.

5. **"Give me a quality snapshot before I open the PR."** Run `/cgc report`.
   It resolves an absolute destination of `CGC_REPORT.md` in the session working
   directory and asks for confirmation naming that exact path; on confirm the
   report is generated in the background and `/cgc status` shows the last
   action. The outcome is `CGC_REPORT.md` written at the destination you
   confirmed.

6. **"Snapshot this repo to a bundle, then use my worktree's named context."**
   These are management intents, served by the CLI-gap tools:
   - `cgc_bundle_export` with a `repository` and an `output` path writes a
     `.cgc` bundle behind a confirmation.
   - `cgc_context` with `verb: "list"` shows the registered contexts; `verb:
     "create"` with a `name` registers one; `verb: "set-default"` with a `name`
     makes it the default (the CLI name for that verb is `cgc context default`);
     `verb: "delete"` with a `name` confirms and then removes only the
     registration, never database files.
   Enable or disable all three tools together with `tools.cliGap.enabled`. The
   outcome is a bundle on disk and the named context active.

7. **"Something failed — connections or parsers."** Run `cgc_doctor` (or
   `/cgc doctor`) for diagnostics and bounded output. The failing connection or
   parser is named; a `corrupt` workspace escalates to a confirmed
   `/cgc index --force` rebuild.

## How the index is created and kept current

CGC indexes a repository into a graph database. The extension wraps that
lifecycle so the automatic path is the default and manual commands exist as
overrides.

### The automatic path

1. **Session-start lifecycle gate.** When a session starts, the extension
   resolves the workspace and classifies its state, then routes each state:

   | State | What happens automatically |
   | --- | --- |
   | `clean` | Nothing; silent skip. |
   | `drift` | A background incremental sync runs when `lifecycle.syncOnStart` is on (default on). |
   | `unindexed` | No index is created unless `lifecycle.autoCreate` is on (default off); otherwise a one-time notice explains how to enable or run it manually. |
   | `corrupt` | A one-time diagnostic report is offered with a confirmation-gated rebuild. |
   | `busy` | Skips as busy with a one-time notice; no maintenance spawn. |
   | `unavailable` | A one-time notice; the session proceeds without the graph. |

   The gate never blocks the agent loop: indexing and syncing are
   fire-and-forget background work.

2. **Freshness after start.** The extension observes the first file-modifying
   tool call of a session and marks the workspace possibly-stale. With
   `freshness.autoSync` on (default on) it starts one budgeted background
   incremental `cgc index .`, capped at `freshness.maxSyncsPerSession` per
   session. With `freshness.watch` on (opt-in) CGC's own `cgc watch .` runs as
   a managed child instead; a busy start degrades back to lazy mode.

Lifecycle states `clean`, `drift`, `syncing`, `indexing`, and `rebuilding` are
ready for graph queries. `unavailable`, `unindexed`, `busy`, and `corrupt`
suppress graph routing and guidance until resolved.

### Manual overrides

- `/cgc index` — on an indexed workspace this is the non-destructive
  incremental `cgc index .`; on an unindexed workspace it follows the same
  `lifecycle.autoCreate` opt-in gate, with no second dialog.
- `/cgc index --force` — force-rebuilds, replacing the existing index. Always
  requires explicit confirmation.
- `/cgc sync` — the same incremental reconcile, available any time.
- `/cgc doctor` / `cgc_doctor` — diagnose `unavailable` or `corrupt`.
- `/cgc report` — write the CGC quality report to a confirmed destination.

The CLI and the MCP server must use the **same backend configuration**
(`DEFAULT_DATABASE`, a Neo4j URI, or a Kuzu path) or they will see different
graphs. Index from the repository root with `cgc index .`.

## Configuration and consent

Settings resolve lowest-to-highest precedence:

1. Built-in defaults.
2. Optional JSON config files — global `~/.pi/agent/cgc.json`, then project
   `.pi/cgc.json` (project wins on conflict). Keys are nested by section, as
   in `{"tools": {"cliGap": {"enabled": false}}}`.
3. `CGC_*` environment-variable overrides (headless/CI use).

Only keys present in a file are applied; invalid values are skipped with a
warning and fall back to the lower layer.

| Key | Default | Environment override | Purpose |
| --- | --- | --- | --- |
| `cgc.executable` | `cgc` | `CGC_EXECUTABLE` | Binary to spawn (PATH-resolved unless absolute). |
| `cgc.timeoutMs` | `30000` | `CGC_TIMEOUT_MS` | Time budget for cgc invocations. |
| `cgc.versionProbeTimeoutMs` | `10000` | `CGC_VERSION_PROBE_TIMEOUT_MS` | Time budget for the cached version probe. |
| `lifecycle.autoCreate` | `false` | `CGC_LIFECYCLE_AUTO_CREATE` | Opt-in: create a missing index automatically (also gates `/cgc index` on an unindexed workspace). |
| `lifecycle.syncOnStart` | `true` | `CGC_LIFECYCLE_SYNC_ON_START` | Reconcile graph/disk drift at session start when an index exists. |
| `worktree.mode` | `off` | `CGC_WORKTREE_MODE` | `off` or `isolate`; isolate gives each worktree its own named context. |
| `proactive.sessionNote` | `true` | `CGC_PROACTIVE_SESSION_NOTE` | One capped coverage note per session. |
| `proactive.driftSteers` | `false` | `CGC_PROACTIVE_DRIFT_STEERS` | Opt-in: one staleness steer naming `/cgc sync`. |
| `proactive.resultAnnotations` | `false` | `CGC_PROACTIVE_RESULT_ANNOTATIONS` | Opt-in: one-line freshness annotation on extension-produced renders. |
| `freshness.watch` | `false` | `CGC_FRESHNESS_WATCH` | Opt-in: run `cgc watch .` as a managed child. |
| `freshness.autoSync` | `true` | `CGC_FRESHNESS_AUTO_SYNC` | Budgeted incremental sync on first observed drift. |
| `freshness.maxSyncsPerSession` | `2` | `CGC_FRESHNESS_MAX_SYNCS_PER_SESSION` | Cap on automatic syncs per session. |
| `output.maxBytes` | `16384` | `CGC_OUTPUT_MAX_BYTES` | Bound on rendered command output. |
| `output.spillToTemp` | `true` | `CGC_OUTPUT_SPILL_TO_TEMP` | Spill over-budget output to a temp file. |
| `output.redactSecrets` | `true` | `CGC_OUTPUT_REDACT_SECRETS` | Redact secret-looking values from rendered output. |
| `output.gcf` | `false` | `CGC_OUTPUT_GCF` | Opt-in: request GCF compact output. |
| `tools.cliGap.enabled` | `true` | `CGC_TOOLS_CLI_GAP_ENABLED` | Register the three CLI-gap tools as one set. |
| `guidance.routingSkill` | `false` | `CGC_GUIDANCE_ROUTING_SKILL` | Opt-in: install the deep `cgc-routing` skill. |

The always-on routing guideline card has no off switch of its own; disabling
the extension is the only way to remove it. This guide is the card's deep-dive
continuation.

### Consent overview

Consent is granted only by an explicit confirmation dialog. A missing dialog,
a throwing dialog, or a decline all mean "no" and nothing is spawned.

| Action | Consent |
| --- | --- |
| `/cgc index --force` (rebuild, replaces the index) | Dialog: "Rebuild the CGC index?" |
| `/cgc report` (writes a file) | Dialog naming the exact destination path. |
| `cgc_bundle_export` (writes a bundle) | Dialog: "Export a CGC bundle?" |
| `cgc_context` `delete` | Dialog naming the context; removes the registration only. |
| Automatic/missing-index creation | No dialog: gated by the `lifecycle.autoCreate` opt-in. |
| `/cgc status`, `/cgc sync`, `/cgc doctor`, `/cgc index` (incremental), `cgc_doctor`, `cgc_context` `list`/`create`/`set-default` | Run without confirmation (non-destructive). |

## Backend and environment caveats

- **Path sandbox (`CGC_ALLOWED_ROOTS`).** CGC only accepts paths under the MCP
  server process's working directory plus any extra roots in `CGC_ALLOWED_ROOTS`.
  The list separator is `:` on Linux/macOS and `;` on Windows. Sibling
  directories are rejected without the variable. The extension's own runner
  spawns `cgc` in the session working directory, so that directory is allowed;
  to work on another tree, add it to `CGC_ALLOWED_ROOTS`.

  ```bash
  export CGC_ALLOWED_ROOTS="/home/me/projects:/data/repos"
  ```

- **Fuzzy search is backend-dependent.** `find_code` with `fuzzy_search` uses
  typo-tolerant edit-distance matching on Kuzu/FalkorDB (tune with
  `edit_distance`) and Lucene-style full-text terms on Neo4j (tokenization and
  stemming apply). Preserve the original casing of camelCase/PascalCase symbols;
  lowercasing can change which tokens match. When results look surprising,
  re-run with `fuzzy_search: false` for an exact-match baseline before
  concluding a symbol is missing.

- **Embedded backends are single-process.** The bundled/embedded graph
  databases take a single-process lock, so concurrent access fails with
  "Could not set lock on file". External servers (e.g. Neo4j) are unaffected.
  The lifecycle gate surfaces this as the `busy` state; wait for the other
  process to finish rather than retrying in a hot loop.

- **GCF compact output falls back automatically.** Setting `CGC_OUTPUT_FORMAT=gcf`
  (or `output.gcf`) requests compressed output when `gcf-python` is installed;
  when it is absent, CGC falls back to JSON with no extra configuration.

- **Worktree isolation can block maintenance.** With `worktree.mode: isolate`,
  a worktree whose mapping identity cannot be verified gets no index/rebuild
  spawn (fail-closed) so a run can never silently index the wrong context.

## Troubleshooting pointers

| Symptom | First surface |
| --- | --- |
| Connections or parsers fail | `cgc_doctor`, `/cgc doctor` |
| "Could not set lock on file" | Another process holds the embedded database; wait, then re-run |
| "outside the allowed roots" / "not inside any allowed root" | Add the path to `CGC_ALLOWED_ROOTS` |
| State is `unavailable` or `corrupt` | `/cgc doctor`, then `/cgc index --force` (confirmed) |
| Symbols missing from `find_code` | Re-run with `fuzzy_search: false` for an exact baseline |
| Unsure whether the graph is current | `/cgc status`, then `/cgc sync` |

For depth, see the CGC project documentation:
[TROUBLESHOOTING](https://github.com/CodeGraphContext/CodeGraphContext/blob/main/docs/TROUBLESHOOTING.md),
[MCP_TOOLS](https://github.com/CodeGraphContext/CodeGraphContext/blob/main/docs/MCP_TOOLS.md),
and the [indexing guide](https://github.com/CodeGraphContext/CodeGraphContext/blob/main/docs/docs/guides/indexing.md).

## Supported version

This guide, the `/cgc` command surface, the CLI-gap tools, and the
configuration keys above are written for **CodeGraphContext v0.6.x**. Behavior
changes that move a surface must update this guide in the same change, and the
accuracy test fails CI when a surface named here no longer exists.
