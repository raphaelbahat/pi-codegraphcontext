## 1. Tool surface

- [ ] 1.1 Implement the config key `tools.cliGap.enabled` (default true) with an environment-variable override; register the three tools when enabled and none when disabled.
- [ ] 1.2 Implement `cgc_bundle_export` (repository path + output path arguments; confirmation for the file write via the ADR-0003 layer; documented `cgc bundle export` verbs only; never destructive flags).
- [ ] 1.3 Implement `cgc_context` (list / create / delete / set-default via documented `cgc context` verbs; delete behind confirmation; results show mode, repositories, and current default).
- [ ] 1.4 Implement `cgc_doctor` (read-only diagnostics with policy-cleaned, bounded output).
- [ ] 1.5 Implement the structured error mapper (NOT_FOUND / NOT_ALLOWED / BUSY / TIMEOUT / COMMAND_FAILED / UNAVAILABLE) with remediation hints and bounded stderr tails.

## 2. Guardrails and verification

- [ ] 2.1 Add the CI collision test: no extension tool name matches or shadows a documented CGC MCP catalog tool name, and no extension tool duplicates an MCP tool's behavior (asserted against the catalog snapshot per D5); assert the catalog snapshot used by the test is refreshed deliberately.
- [ ] 2.2 Test consent integration: export and delete confirmations (proceed/decline paths); declined actions perform nothing.
- [ ] 2.3 Test sandbox and failure behavior: out-of-root paths return structured NOT_ALLOWED; missing `cgc` returns UNAVAILABLE with install guidance; lock conflicts return BUSY without retries.
- [ ] 2.4 Verify all scenarios in `specs/cgc-cli-bridge/spec.md` against the implementation.
- [ ] 2.5 Run `openspec validate add-cgc-cli-gap-tools --type change --strict` before archive.
- [ ] 2.6 Document `tools.cliGap.enabled` (default true, environment-variable override) in the README.
