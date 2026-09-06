## Why

Every surface in this extension assumes someone taught the agent which tool to reach for — but the knowledge is scattered across tool descriptions, injected guidelines, and README prose. Reference practice (codeLens's `docs/agent-guide.md`) shows that a single, intent-first guide written for the agent as a first-class reader is the cheapest way to make the whole surface discoverable — and it doubles as human onboarding documentation. This change ships that guide for `pi-codegraphcontext`.

## What Changes

- A new `docs/agent-guide.md` shipped in the extension repository, organized intent-first (not tool-by-tool):
  - Tool-choice-by-intent mapping: relationship questions (callers, callees, chains, impact, dead code, complexity) → CGC MCP graph tools; exact-string and known-file work → built-in search/read; freshness and status → `/cgc` slash commands; bundle export, named contexts, diagnostics → CLI-gap tools; index creation → automatic via the lifecycle gate, with manual overrides.
  - One worked end-to-end example session showing the routing decisions in context.
  - Backend caveats summary (fuzzy-search semantics per backend, path sandbox, output-format notes) and configuration/consent overview (what runs automatically, what asks first).
  - Troubleshooting pointers (unindexed workspace, busy/lock conflicts, missing `cgc`).
- Discovery: the repository README links the guide; the opt-in routing skill references it as the deep-dive continuation.
- An accuracy test that asserts every extension surface named in the guide (tools, commands, config keys) actually exists — the documentation cannot silently drift from the implementation.
- A scope line naming the supported CGC version range, versioned with the extension.
- Documentation only: no runtime code, no tool registrations, no injected content.

## Capabilities

### New Capabilities

- `cgc-agent-guide`: the intent-first agent guide document — shipped, accuracy-tested, discoverable — teaching surface selection across the MCP graph tools, built-in search, slash commands, and CLI-gap tools.

### Modified Capabilities

(none — no existing capabilities; `openspec/specs/` is empty)

## Impact

- Extension repository docs and README only; no runtime behavior in any capability.
- Referenced (not duplicated) by the routing skill's deep-dive section (`add-cgc-agent-routing-guidance`).
- The accuracy test couples the guide to the implemented surfaces, so later surface renames fail CI until the guide is updated.
- No changes to CodeGraphContext, the MCP server, or any other capability's behavior.
