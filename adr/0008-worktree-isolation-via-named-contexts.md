# ADR-0008: Worktree isolation rides CGC named contexts keyed by worktree identity, fail-closed on mismatch

## Status

Proposed

## Date

2026-09-06

## Context

Git worktrees multiply one repository into several live checkouts that may sit on different branches. The extension's lifecycle gate and freshness machinery resolve "the workspace" from the session working directory; in a worktree setup, that resolution can mix branches into one graph or silently query another worktree's index — the dangerous failure is a confidently wrong answer. CGC provides named contexts (`--context` on CLI verbs, managed by documented `cgc context` verbs whose deletion preserves database files) as its isolation primitive, but nothing keys a context to a worktree or verifies the pairing over time. The reference-extension research established the correctness bar: identity-checked per-worktree graphs, fail-closed on mismatch, cleanup after worktree removal — and, critically, no silent cross-branch queries.

## Decision

Worktree awareness is opt-in (`worktree.mode`: `off` default | `isolate`). Detection reads the `.git` pointer file (a `gitdir:` reference into the repository's worktrees store) — pure filesystem inspection, no spawns. In `isolate` mode, each linked worktree maps to a dedicated CGC named context (`wt-<worktree-id>`) created on demand under the lifecycle's auto-create consent gate, and every extension runner invocation for that workspace carries the matching `--context` flag. Each mapping records its identity (repository common directory + worktree id); resolution verifies the identity and fails closed on any mismatch — a mismatched or replaced context is refused and surfaced, never silently used, never auto-repaired. Pruned worktrees surface a one-time notice naming the orphaned context and the user-driven cleanup path (`/cgc_context delete`); the extension never deletes registrations or files autonomously. The extension isolates only its own maintenance surface; the user's CGC MCP server session context remains the user's to manage via CGC's own discover/switch tools, and the agent guide documents that interplay.

## Consequences

- Positive: branch mixing becomes impossible for the extension-maintained surface — each opted-in worktree's index lives in its own CGC context, centrally stored and manageable with existing verbs.
- Positive: the dangerous failure mode (silently querying another branch's graph) is structurally prevented by fail-closed identity checks rather than naming conventions.
- Positive: zero-spawn detection keeps the resolution free of lock contention and runner budget usage; cleanup composes with ADR-0003's consent model and the `/cgc_context` tool instead of adding deletion code.
- Negative: worktree identity shifts (re-added worktrees) fail closed and require a re-consent — noisy-but-safe rather than seamless.
- Negative: users may expect MCP-server queries to follow the worktree automatically; the extension cannot deliver that (it does not control the MCP server session), and must document the interplay clearly to avoid a false sense of isolation.
- Negative: another opt-in mode means another configuration surface to test and document; default `off` limits the blast radius but also the discoverability.
- Follow-up: if a future CGC release adds native worktree awareness, this mechanism should be retired in favor of it (recorded for the guide's deprecation notes); the accuracy test from the agent-guide change keeps such notes honest.
