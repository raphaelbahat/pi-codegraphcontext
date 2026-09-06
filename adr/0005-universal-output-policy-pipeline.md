# ADR-0005: All wrapped cgc output flows through one universal policy pipeline in the runner

## Status

Proposed

## Date

2026-09-06

## Context

Every `cgc` invocation the extension wraps produces terminal-oriented output that flows to human surfaces and, in some cases, toward agent-visible material. Three facts make an output policy architectural rather than cosmetic: (1) CGC's CLI output is not redacted — its `REDACT_SECRETS` configuration covers bundle contents, while CLI output (doctor/report rendering file-adjacent content) can echo secrets present in source trees; (2) uncapped output floods session transcripts and wastes tokens regardless of which surface triggered the invocation; and (3) per-surface output handling has already begun to diverge (the slash-commands renderer implemented its own bounding while the lifecycle gate captures probe output separately). CGC additionally documents an opt-in compact output format (GCF with JSON fallback) the extension can pass through.

## Decision

The shared `cgc` runner applies one universal output pipeline to every invocation's captured output: strip control sequences → redact secret-shaped strings (default on, explicit opt-out) → bound to the configured budget preserving head and tail with an explicit truncation marker stating the original size → optionally spill the full output to a session-scoped file in the OS temp directory (never the workspace) whose path the marker names and whose removal is part of the existing multi-path session teardown. When configured, the runner sets CGC's documented GCF output-format environment on invocations and relies on CGC's documented JSON fallback rather than probing availability. Pipeline failures are fail-open: they degrade to best-effort delivery and are recorded, never failing the underlying invocation. All current and future surfaces are consumers of this pipeline; none may implement private output handling that bypasses it.

## Consequences

- Positive: secret hygiene and token bounds hold for every surface by construction — new surfaces (future tools, proactive notes) inherit the policy with zero additional code.
- Positive: one implementation of truncation/redaction/spill to test, instead of one per surface; divergence between surfaces becomes structurally impossible.
- Positive: diagnostics keep their informative ends (head+tail) and full fidelity remains available via the named spill file.
- Negative: redaction false positives can mangle legitimate output; the explicit opt-out is the designed pressure valve and must be documented.
- Negative: truncated output loses its middle; the spill file compensates but adds a temp-file read step for the consumer.
- Negative: spill files hold session output (potentially secret-bearing) on disk for the session lifetime; mitigated by temp-directory location, restrictive permissions where supported, and teardown cleanup.
- Follow-up: any future agent-visible use of wrapped output must consume pipeline-cleaned data only; raw capture access is reserved to the pipeline itself.
