# ADR Review Manifest

- Status: completed
- Review date: 2026-09-06

## Review Summary

ADR review completed for this change.

## In-Force ADRs Reviewed

- None — `<repo>/adr/` had no in-force ADRs when this change's design was written.

## New Durable ADRs Created

- `adr/0001-cgc-binary-only-integration.md` — Integrate with CodeGraphContext exclusively via the `cgc` binary behind a fail-open lifecycle gate (Nygard format; Status: Proposed). Establishes the wrap-only integration boundary, the five-state lifecycle machine, and the skip-as-busy lock policy that later changes in this campaign inherit.
