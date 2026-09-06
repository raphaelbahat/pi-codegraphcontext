## 1. Policy pipeline in the shared runner

- [ ] 1.1 Restructure runner capture into the pipeline: strip control sequences → redact secrets → bound with head+tail (+spill), applied uniformly before any consumer receives results.
- [ ] 1.2 Implement the config keys `output.maxBytes` (default 16384), `output.spillToTemp` (default true), `output.redactSecrets` (default true), `output.gcf` (default false), each with environment-variable overrides.
- [ ] 1.3 Implement the truncation marker: explicit, stating the original output size and (when spill is enabled) the spill file path.
- [ ] 1.4 Implement spill-to-file: session-scoped directory under the OS temp location (never the workspace), restrictive permissions where supported, path named in the marker, removal wired into all session teardown paths.
- [ ] 1.5 Implement conservative pattern-based secret redaction (credential-style assignments, high-entropy literals) applied before bounding, with the `output.redactSecrets` opt-out.
- [ ] 1.6 Implement GCF passthrough: when `output.gcf` is on, set `CGC_OUTPUT_FORMAT=gcf` on invocations; rely on CGC's documented JSON fallback when the format is unavailable; no availability probing.
- [ ] 1.7 Implement fail-open pipeline semantics: any pipeline stage error records the policy error and delivers best-effort output without failing the invocation.

## 2. Consumer alignment and verification

- [ ] 2.1 Migrate the slash-commands renderer to consume the shared policy output, removing its ad-hoc bounding (its design anticipated this handoff).
- [ ] 2.2 Test the pipeline across the matrix: small/oversized outputs, spill on/off, redaction on/off, GCF on/off, ANSI-rich input, and pipeline-stage failure injection.
- [ ] 2.3 Test spill cleanup: spill files removed through every session teardown path (shutdown hook, exit handler, signals).
- [ ] 2.4 Verify all scenarios in `specs/cgc-output-economy/spec.md` against the implementation.
- [ ] 2.5 Run `openspec validate add-cgc-output-token-economy --type change --strict` before archive.
