## Why

The CGC MCP server covers the graph query surface but not every maintenance verb: it cannot export bundles (only load/search them), cannot manage named context workspaces (only discover/switch), and cannot run system diagnostics. Today those capabilities are reachable only by the human typing `cgc` in a shell. This change exposes exactly those CLI-gap verbs to the agent as a small, curated set of extension tools in `pi-codegraphcontext` — the only tool-registering change in the campaign — under the standing boundary that MCP-covered verbs are never duplicated.

## What Changes

- Three agent-facing tools (the extension's entire tool surface), registered through Pi's documented tool API and named to avoid any collision with the 25-tool CGC MCP catalog:
  - `cgc_bundle_export` — export a portable `.cgc` bundle for a repository (file write; behind the ADR-0003 confirmation layer; never uses destructive `--clear`).
  - `cgc_context` — list / create / delete / set-default named CGC context workspaces via documented CLI verbs (delete behind confirmation; `ALLOW_DB_DELETION`-gated operations remain unreachable).
  - `cgc_doctor` — run CGC diagnostics and return bounded, policy-cleaned output (read-only).
- Default-on with opt-out: the tool set is enabled by default (`tools.cliGap.enabled`, default true) with an environment-variable override — **open question flagged**: the user leaned "opt-out (enabled by default)" but marked the default as not-final; recorded here for review confirmation.
- Strictly curated surface: no generic `cgc` passthrough tool; every tool argument passes the shared runner guardrails (argument-array, session cwd, timeouts, abort, output-policy pipeline); workspace sandbox semantics (including `CGC_ALLOWED_ROOTS`) are preserved by CGC itself and never bypassed.
- Structured, agent-actionable errors (normalized error codes with remediation hints, e.g. not-found / busy / timeout) instead of raw stack traces.
- Deferred decisions (recorded, not implemented): thin convenience query tools (impact-before-edit, blast-radius) — future consideration, recorded in the slash-commands change; bundling the CGC MCP server with the extension — future consideration, recorded in the lifecycle-gate change.

## Capabilities

### New Capabilities

- `cgc-cli-bridge`: a curated, opt-out-able agent tool surface for CGC capabilities the MCP server lacks — bundle export, named-context management, and diagnostics — executed through the shared runner with consent and sandbox guardrails.

### Modified Capabilities

(none — no existing capabilities; `openspec/specs/` is empty)

## Impact

- Extension package `pi-codegraphcontext`; registers tools through Pi's documented `registerTool` API (validated against installed docs in the lifecycle-gate change).
- Departs from the campaign's "no tools" stance deliberately and narrowly: these are management verbs absent from the MCP catalog, not re-wrapped graph queries.
- Consumes the output-policy pipeline (`add-cgc-output-token-economy`) for all returned output; uses the shared runner and consent layer (ADR-0003).
- Deprecation path: if a future CGC MCP release adds an equivalent tool, the extension tool is retired in favor of the MCP one (recorded in the ADR).
- No changes to CodeGraphContext or the MCP server.
