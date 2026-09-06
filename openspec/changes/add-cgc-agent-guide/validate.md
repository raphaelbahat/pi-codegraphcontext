# Task Validation: add-cgc-agent-guide

- Validated against: live framework/library/tool documentation
- Validation date: 2026-09-06
- Verdict: READY

Validation method: one read-only validator (single technology group — the guide's citable CGC facts) checked every factual claim the guide will embed against the project's live files on GitHub `main` (Context7 unavailable in this environment; documented fallback used). Pi-harness surface names in the guide were already validated in the changes 1–4/6 rounds against installed Pi docs.

Authoring notes from the validator (recorded for task 1.1, not invalid findings): (1) the single-process lock limitation applies to embedded backends only (external servers unaffected); (2) `CGC_ALLOWED_ROOTS` separators are platform-dependent (`:` Linux/macOS, `;` Windows); (3) the GCF JSON fallback is automatic, requiring no explicit configuration.

---

## INVALID — requires revision

None.

---

## VALID — confirmed

### 1.1 (caveats facts)

- Backend-dependent fuzzy search is documented exactly as the guide will cite: Kùzu/FalkorDB typo-tolerant edit-distance matching; Neo4j Lucene-style full-text; preserve original casing for camelCase symbols.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/.cursor/skills/codegraphcontext/SKILL.md> (Agent behavior section)
- The `CGC_ALLOWED_ROOTS` path sandbox is documented (extra roots added to the MCP server's cwd; indexing, bundle-load, watch, and context-switch tools reject outside paths; siblings rejected without the variable).
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/MCP_TOOLS.md> (Path sandbox section)
- Opt-in GCF compact output (`CGC_OUTPUT_FORMAT=gcf`, `pip install gcf-python`, ~62% token reduction) with automatic JSON fallback when `gcf-python` is absent is documented.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/README.md> (Token-Optimized Output (GCF) section)
- Single-process embedded backends ("Could not set lock on file" on concurrent access) and incremental indexing (timestamps/hashes; `--force` full rebuild) are documented — the guide's busy/lock and indexing-intent explanations rest on documented behavior.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/TROUBLESHOOTING.md> (Databases section) ; <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/guides/indexing.md> (Overwriting the Index section)

### 2.1 (supporting)

- The accuracy test's approach (assert every surface named in the guide exists) is implementable against the extension's own registries — the Pi surface names it will assert (`pi.registerCommand`, `registerTool`, `pi.skills` manifest, `before_agent_start`) were validated in earlier rounds against the installed Pi docs.

### 2.3

- `openspec validate <item> --type <type> --strict` matches the installed OpenSpec CLI usage exactly.
  - Evidence: `openspec validate --help` (verified 2026-09-06; same CLI verified for change 1)

---

## Fixes needed

None outstanding. (The three authoring notes above are precision guidance for the guide's caveats section, recorded under task 1.1 rather than corrections.)

---

## Verdict

`VERDICT: READY`
