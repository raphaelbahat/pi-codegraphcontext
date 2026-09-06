# Task Validation: add-cgc-agent-routing-guidance

- Validated against: live framework/library/tool documentation
- Validation date: 2026-09-06
- Verdict: READY

Validation method: two read-only validators (one per technology group) checked every externally-observable claim in tasks.md. Pi-harness claims were validated against the locally installed Pi documentation (`@earendil-works/pi-coding-agent`, bundled docs — authoritative for the installed version). CodeGraphContext content facts were validated against the project's live files on GitHub `main` (Context7 unavailable in this environment; documented fallback used).

Approved revision applied: the validator pinned the exact Pi APIs, which differ from the reference extensions' names (there is no `addPromptGuidelines`). With user approval, design.md (D4), and tasks 1.3/2.2/2.4 were corrected to the documented mechanisms (`before_agent_start` system-prompt modification; `pi.skills` manifest + `resources_discover`; `pi.registerFlag`/`pi.getFlag`). The corrections use the same evidence cited below; `openspec validate --strict` re-run green after the edits.

---

## INVALID — requires revision

None.

---

## VALID — confirmed

### 1.1 / 1.3

- Pi extensions are TypeScript modules with a default factory receiving `ExtensionAPI`; runtime configuration reads go through the documented `pi.registerFlag`/`pi.getFlag` pattern (no general settings-read API — settings files must be read directly if needed). Task 1.3 was corrected to pin this.
  - Evidence: `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (lines 1652–1664; 532–565)

### 1.2 / 2.4

- Skills ship via the package manifest (`"pi": { "skills": ["./skills"] }` in package.json, or a conventional `skills/` directory) and can be exposed conditionally at runtime via the `resources_discover` event returning `{ skillPaths }`; skills surface as `/skill:name` commands and in system-prompt options. Task 2.4 was corrected to pin this mechanism.
  - Evidence: `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/packages.md` (lines 5, 126, 163, 185); `.../docs/extensions.md` (lines 374–389)

### 2.1 / 2.2

- Prompt injection mechanism confirmed with corrected names: there is no `addPromptGuidelines`; the documented surfaces are per-tool `promptGuidelines: string[]` on `pi.registerTool()` and general injection via a `before_agent_start` handler returning the chained `systemPrompt`. Since this change registers no tools, `before_agent_start` is the applicable mechanism (task 2.2 and design D4 corrected).
  - Evidence: `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (lines 1373–1388, 1915–1921, 290; examples `pirate.ts`, `prompt-customizer.ts`)

### 1.2 (content facts)

- CGC's published Cursor skill documents the backend fuzzy-search caveats the skill content will adapt: typo-tolerant edit-distance matching on Kùzu/Falkor backends vs Lucene-style full-text on Neo4j, preserving original casing for camelCase symbols.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/.cursor/skills/codegraphcontext/SKILL.md> (Agent behavior section)
- CGC's MCP server enforces the `CGC_ALLOWED_ROOTS` path sandbox (server cwd plus extra roots; indexing, bundle-load, watch, and context-switch tools reject outside paths) — the skill content cites this accurately.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/MCP_TOOLS.md> (Path sandbox section)
- Provenance claim verified: `.cursor/skills/codegraphcontext/SKILL.md` exists on CGC's `main` branch, so "adapted from CGC's published Cursor skill" is accurate.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/.cursor/skills/codegraphcontext/SKILL.md>

### 3.4

- `openspec validate <item> --type <type> --strict` matches the installed OpenSpec CLI usage exactly.
  - Evidence: `openspec validate --help` (verified 2026-09-06; same CLI verified for change 1)

---

## Fixes needed

None outstanding. (The validator-prescribed API-name corrections were applied with user approval before this verdict was finalized; `openspec validate --strict` re-run green after the edits.)

---

## Verdict

`VERDICT: READY`
