# ADR Review Manifest

- Status: completed
- Review date: 2026-09-06

## Review Summary

ADR review completed for this change.

## In-Force ADRs Reviewed

- `adr/0001` through `adr/0007` (all Proposed, in force — none superseded): all seven are the factual basis the guide documents (wrap-only integration, gated guidance, consent model, passive renderers, output policy, CLI-gap tool boundary, lazy freshness). None are modified by this documentation-only change; the guide must describe them as they are, and the accuracy test enforces that.
- `adr/0008` (worktree isolation via named contexts, Proposed, in force): defines the worktree/named-context interplay the guide's named-context management section must document accurately.
- `adr/0009` (two-tier proactive injection, Proposed, in force): defines the injected-guidelines-versus-opt-in-skill guidance split the guide documents, including the proactive config keys the consent overview must describe.

Note: `adr/0008` and `adr/0009` were created by the concurrent in-progress changes `add-cgc-worktree-aware-contexts` and `add-cgc-proactive-context-injection` (created after this change); they are included above as part of the in-force set and the factual basis the guide documents.

## New Durable ADRs Created

- None — no major durable architectural decisions were introduced. The change is documentation-only; its decisions (intent-first organization, accuracy-as-CI-gate, reference-not-duplicate) are documentation practices without structural or evolutionary impact, and are recorded in design.md instead.
