# pi-codegraphcontext

A [Pi](https://github.com/earendil-works/pi-coding-agent) coding-agent extension for
[CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext), keeping a
code-graph index healthy for every session and makes it effortless for the agent to use.

## What It Is

A single Pi extension that wraps the `cgc` CLI, evaluates the index
lifecycle at session start, syncs drift automatically, and surfaces everything the agent needs: slash commands, a status widget, CLI-gap tools, and routing guidance.

## Why It Exists

Code-graph answers are only as good as the index behind them. Without a gate, agents either skip the graph (stale or missing index) or block on it (busy, corrupt). This extension makes the graph **always ready or honestly unavailable**, never silently wrong.

> [!NOTE]
> Graph relationship tools (`analyze_code_relationships`, `find_dead_code`,
> `find_code`, …) are registered by the **CGC MCP server**, **_not by this extension_**. The
> extension owns everything around them: the lifecycle, the freshness, the status
> surfaces, and the gaps in the MCP catalog.

## Features

| Capability               | What you get                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Index lifecycle gate** | Every session start classifies the workspace (`unavailable`, `unindexed`, `busy`, `indexing`, `rebuilding`, `drift`, `syncing`, `clean`, `corrupt`) and routes accordingly — one-time notices, background indexing, or a silent skip |
| **Freshness sync**       | Drift between the working tree and the graph is detected and auto-synced (bounded per session), so graph answers stay trustworthy as code changes                                                                                    |
| **Status HUD**           | A persistent widget shows index state at a glance — no commands needed                                                                                                                                                               |
| **Slash commands**       | `/cgc status`, `/cgc index`, `/cgc sync`, `/cgc rebuild`, `/cgc report`, `/cgc doctor` for explicit control                                                                                                                          |
| **Proactive context**    | A one-shot session note (at most once, even across mid-session readiness transitions) tells the agent what the graph can answer                                                                                                      |
| **Worktree contexts**    | Optional `isolate` mode maps git worktrees to dedicated CGC contexts (`--context wt-<id>`), with durable identity-verified mappings and fail-closed mismatch handling                                                                |
| **Output economy**       | CGC tool output is size-capped, secrets are redacted, and oversized results spill to disk with archive IDs instead of flooding the context window                                                                                    |
| **CLI-gap tools**        | `cgc_bundle_export`, `cgc_context`, and `cgc_doctor` wrap the CGC verbs the MCP catalog does not expose                                                                                                                              |
| **Agent guidance**       | An always-on routing guideline card (graph-vs-text tool choice) plus an opt-in `cgc-routing` skill                                                                                                                                   |

Everything is **fail-open**: a guard error is recorded, retried at most once per session,
and never blocks the agent loop. Detection errors degrade honestly (for example, a
malformed `.git` pointer simply means "not a worktree") instead of producing wrong answers.

## Requirements

- **Pi** coding agent (`@earendil-works/pi-coding-agent` is used as a peer dependency).
- The **`cgc` CLI** (CodeGraphContext, tested against v0.6.x) on `PATH`, or pointed at via
  `CGC_EXECUTABLE`. See the
  [CGC indexing guide](https://github.com/CodeGraphContext/CodeGraphContext/blob/main/docs/docs/guides/indexing.md)
  for installing and preparing the CLI.

## Installation

1. Install the `cgc` CLI and confirm it works:

    ```sh
    cgc --version
    ```

2. Add the extension to Pi. Either the published package:

    ```sh
    # in ~/.pi/agent/settings.json
    {
      "packages": ["npm:pi-codegraphcontext"]
    }
    ```

    …or a local clone:

    ```json
    {
        "packages": ["/path/to/pi-codegraphcontext"]
    }
    ```

3. Start (or `/reload` Pi). On the first session in a repository you get exactly one
   honest notice: either "indexing in the background" (`lifecycle.autoCreate`) or
   "not indexed — here is how to enable auto-create" (default).

> [!TIP]
> No configuration is required for the default experience. Every behavior below has a
> working default; the configuration section is purely opt-in.

## Usage

### Slash Commands

All commands live under `/cgc`:

| Command        | Purpose                                                        |
| -------------- | -------------------------------------------------------------- |
| `/cgc status`  | Workspace state, freshness, and recent activity                |
| `/cgc index`   | Force (re)index now                                            |
| `/cgc sync`    | Reconcile graph/disk drift on demand                           |
| `/cgc rebuild` | Drop and rebuild the index                                     |
| `/cgc report`  | Write the CGC quality report to a confirmed path               |
| `/cgc doctor`  | Bounded diagnostic render (connection, parser, backend health) |

### Automatic Behavior

On every `session_start` the gate classifies the workspace and acts:

- **clean** → silent skip, zero maintenance invocations
- **drift** → background sync (bounded by `freshness.maxSyncsPerSession`)
- **unindexed** → background indexing if `lifecycle.autoCreate`, else one honest notice
- **busy** → skip with a one-time notice (never fights a running index)
- **corrupt** → one-time report with a rebuild offer; nothing destructive happens uninvited
- **unavailable** → one-time warning naming every enablement route (`CGC_EXECUTABLE`,
  config files, `PATH`)

The status HUD reflects all of this live; no command is needed to see the state.

### What the Agent Gets

- **CGC MCP graph tools** (from the CGC MCP server) for relationship, structure, and code
  health questions — see the
  [MCP tools documentation](https://github.com/CodeGraphContext/CodeGraphContext/blob/main/docs/MCP_TOOLS.md).
- **The always-on guideline card** steering tool choice: graph for relationships,
  built-in search for exact strings.
- **The `cgc-routing` skill** (`guidance.routingSkill`, on by default) with intent-first — user-executable via `/skill:cgc-routing`
  tool-choice detail.
- **The CLI-gap tools** filling the MCP catalog gaps.
- **The [agent guide](docs/agent-guide.md)** — the deep, intent-first reference the card
  and skill link to.

## Configuration

Configuration is resolved in this order (each layer overrides the previous one):

1. Built-in defaults
2. Global config file — `$PI_CODING_AGENT_DIR/cgc.json` (default `~/.pi/agent/cgc.json`)
3. Project config file — `.pi/cgc.json` (wins on conflict)
4. Environment variables (for headless/CI setups)

Only keys present in a config file are applied; invalid values are skipped with a warning
and fall back to the lower layer.

### Full Configuration Reference

```json
{
    "cgc": {
        "executable": "cgc",
        "timeoutMs": 30000,
        "versionProbeTimeoutMs": 10000
    },
    "lifecycle": {
        "autoCreate": false,
        "syncOnStart": true
    },
    "worktree": {
        "mode": "off"
    },
    "proactive": {
        "sessionNote": true,
        "driftSteers": false,
        "resultAnnotations": false
    },
    "freshness": {
        "watch": false,
        "autoSync": true,
        "maxSyncsPerSession": 2
    },
    "output": {
        "maxBytes": 16384,
        "spillToTemp": true,
        "redactSecrets": true,
        "gcf": false
    },
    "tools": {
        "cliGap": {
            "enabled": true
        }
    },
    "guidance": {
        "routingSkill": false
    }
}
```

| Section     | Key                                                  | Default                             | What it controls                                                                       |
| ----------- | ---------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| `cgc`       | `executable`                                         | `"cgc"`                             | The CGC binary (name or absolute path)                                                 |
| `cgc`       | `timeoutMs` / `versionProbeTimeoutMs`                | `30000` / `10000`                   | Per-command and version-probe time budgets                                             |
| `lifecycle` | `autoCreate`                                         | `false`                             | Index a workspace automatically when none exists (consent gate)                        |
| `lifecycle` | `syncOnStart`                                        | `true`                              | Sync drift detected at session start                                                   |
| `worktree`  | `mode`                                               | `"off"`                             | `"isolate"` maps each git worktree to its own CGC context                              |
| `proactive` | `sessionNote` / `driftSteers` / `resultAnnotations`  | `true` / `false` / `false`          | Proactive surfaces: the one-shot session note, drift steering, tool-result annotations |
| `freshness` | `watch` / `autoSync` / `maxSyncsPerSession`          | `false` / `true` / `2`              | File watching, background syncing, and its per-session bound                           |
| `output`    | `maxBytes` / `spillToTemp` / `redactSecrets` / `gcf` | `16384` / `true` / `true` / `false` | Output budget, spill-to-disk, secret redaction, graph-context-format output            |
| `tools`     | `cliGap.enabled`                                     | `true`                              | Registers the three CLI-gap tools (`cgc_bundle_export`, `cgc_context`, `cgc_doctor`)   |
| `guidance`  | `routingSkill`                                       | `false`                             | Offers the opt-in `cgc-routing` skill to the agent                                     |

### Environment Variables

Every behavior has an environment override (they take precedence over config files).
Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`.

| Variable                                                                                                     | Overrides                                        |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `CGC_EXECUTABLE`                                                                                             | `cgc.executable`                                 |
| `CGC_LIFECYCLE_AUTO_CREATE` / `CGC_LIFECYCLE_SYNC_ON_START`                                                  | `lifecycle.*`                                    |
| `CGC_WORKTREE_MODE`                                                                                          | `worktree.mode`                                  |
| `CGC_FRESHNESS_WATCH` / `CGC_FRESHNESS_AUTO_SYNC` / `CGC_FRESHNESS_MAX_SYNCS_PER_SESSION`                    | `freshness.*`                                    |
| `CGC_GUIDANCE_ENABLED` / `CGC_GUIDANCE_ALWAYS_ON` / `CGC_GUIDANCE_ROUTING_SKILL` / `CGC_GUIDANCE_GUIDELINES` | `guidance.*` and the guideline text itself       |
| `CGC_TOOLS_CLI_GAP_ENABLED`                                                                                  | `tools.cliGap.enabled`                           |
| `CGC_ALLOWED_ROOTS`                                                                                          | Path sandbox for CGC operations (absolute roots) |
| `CGC_COMMAND_NAME` / `CGC_NAMESPACE`                                                                         | The `/cgc` command name and namespace            |

Example for a headless CI run:

```sh
export CGC_LIFECYCLE_AUTO_CREATE=true
export CGC_FRESHNESS_WATCH=false
export CGC_ALLOWED_ROOTS="$PWD"
```

## Troubleshooting

- **"unavailable" notice at session start** — the `cgc` binary was not found. Check
  `PATH`, set `CGC_EXECUTABLE`, or configure `cgc.executable` in a config file.
- **"unindexed" notice** — enable `lifecycle.autoCreate` (or `CGC_LIFECYCLE_AUTO_CREATE`)
  or run `/cgc index`.
- **Graph answers look stale** — run `/cgc sync`, or enable `freshness.watch`.
- **Nothing worktree-related happens** — worktree contexts are `off` by default; set
  `worktree.mode: "isolate"` to opt in.
- **CLI errors** — see the
  [CGC troubleshooting guide](https://github.com/CodeGraphContext/CodeGraphContext/blob/main/docs/TROUBLESHOOTING.md),
  then `/cgc doctor`.

## Development

```sh
bun install
bun test          # 844 tests across 30 files
bunx tsc --noEmit # type check
```

The extension is fully covered by the per-capability specs under
`openspec/specs/` and the archived change history under `openspec/changes/archive/`.
