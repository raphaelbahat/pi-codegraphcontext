# Task Validation: add-cgc-output-token-economy

- Validated against: live framework/library/tool documentation
- Validation date: 2026-09-06
- Verdict: READY

Validation method: one read-only validator (single technology group — all externally-observable claims are CodeGraphContext documentation claims; the pipeline itself is internal design) checked every claim against the project's live files on GitHub `main` (Context7 unavailable in this environment; documented fallback used).

---

## INVALID — requires revision

None.

---

## VALID — confirmed

### 1.6

- `CGC_OUTPUT_FORMAT=gcf` is documented as an opt-in (env var or MCP config env) reducing tool response tokens by ~62%, and CGC explicitly "falls back to JSON if `gcf-python` is not installed" — so config-driven passthrough with CGC's own fallback (no availability probing) is exactly the documented behavior.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/README.md> (section "Token-Optimized Output (GCF)", lines ~688–713)

### 1.5 (premise)

- `REDACT_SECRETS=true` is documented as redacting likely secrets (API keys, tokens, passwords, connection strings) — explicitly scoped to bundle content ("node properties from the indexed source code") for `bundle export`; no documentation anywhere claims CLI stdout redaction. This confirms the design premise that the extension's output-policy redaction is defense in depth for CLI output, not a duplicate of CGC's bundle-level feature.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/guides/bundles.md> (section "Secrets in Bundles", lines ~358–371)

### 1.5 (supporting)

- CGC "logs a warning at index time when potential secrets are detected, listing the affected nodes and properties" — corroborating that source trees commonly carry hardcoded secrets, which CLI output (doctor/report rendering file-adjacent content) can echo.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/guides/bundles.md> (section "Secrets in Bundles", line ~371)

### 3.4

- `openspec validate <item> --type <type> --strict` matches the installed OpenSpec CLI usage exactly.
  - Evidence: `openspec validate --help` (verified 2026-09-06; same CLI verified for change 1)

---

## Fixes needed

None.

---

## Verdict

`VERDICT: READY`
