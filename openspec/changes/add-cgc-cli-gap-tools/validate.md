# Task Validation: add-cgc-cli-gap-tools

- Validated against: live framework/library/tool documentation
- Validation date: 2026-09-06
- Verdict: READY

Validation method: one read-only validator (single technology group — all externally-observable claims are CodeGraphContext documentation claims; tool registration itself was already validated against installed Pi docs in the lifecycle-gate change — see openspec/changes/add-cgc-session-lifecycle-gate/validate.md) checked every claim against the project's live files on GitHub `main` (Context7 unavailable in this environment; documented fallback used).

---

## INVALID — requires revision

None.

---

## VALID — confirmed

### 1.2 (CB1)

- The MCP catalog contains only `load_bundle` and `search_registry_bundles` under bundle management — no export tool exists — while `cgc bundle export <output.cgc> [--repo PATH]` (shortcut `cgc export`) is documented CLI-only. The tool's premise holds exactly.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/MCP_TOOLS.md> ; <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/reference/cli.md>

### 1.3 (CB2)

- The MCP catalog's only context tools are `discover_codegraph_contexts` and `switch_context`; named-context workspace management (`cgc context list|mode|create|delete|default`) is CLI-only — the `cgc_context` tool fills a real catalog gap.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/MCP_TOOLS.md> ; <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/reference/cli.md>

### 1.4 (CB3)

- No doctor/diagnostics tool appears in any of the 25 MCP tool definitions; `cgc doctor` is documented under "System Diagnostics" (config, DB connectivity, parsers, dependencies, permissions — read-only checks).
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/MCP_TOOLS.md> ; <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/reference/cli.md>

### 2.1 / 1.3 (CB4)

- Context deletion is registration-level by CGC's own design: "Deleting a context removes its registration from `config.yaml`. The underlying database files on disk are preserved to prevent data loss." — matching the tool's confirmation-gated, registration-only delete.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/guides/contexts.md>

### 2.1 (CB5)

- Name-collision check confirmed: all 25 documented MCP tool names are snake_case; none starts with `cgc_` and none equals `cgc_bundle_export`, `cgc_context`, or `cgc_doctor` — zero collisions.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/MCP_TOOLS.md>
  - Wording nit (documentation-level): the catalog names are snake_case (not "camelCase"); correct the gloss in extension docs when the guide is authored.

### 2.5

- `openspec validate <item> --type <type> --strict` matches the installed OpenSpec CLI usage exactly.
  - Evidence: `openspec validate --help` (verified 2026-09-06; same CLI verified in the lifecycle-gate change, openspec/changes/add-cgc-session-lifecycle-gate/validate.md)

---

## Fixes needed

None outstanding. (CB5's snake_case/camelCase gloss nit is documentation-level, noted for the agent-guide authoring task rather than a tasks.md correction.)

---

## Verdict

`VERDICT: READY`
