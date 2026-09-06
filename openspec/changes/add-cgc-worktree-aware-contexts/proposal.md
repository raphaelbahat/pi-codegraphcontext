## Why

In a git worktree setup, several checkouts of one repository exist side by side, each potentially on a different branch — yet CGC's context resolution has no worktree awareness. Without it, a worktree session either indexes into the shared global graph (mixing branches into one answer set) or creates a silently misplaced local context, and a pruned worktree leaves an orphaned graph behind. This change gives `pi-codegraphcontext` opt-in worktree isolation built on CGC's own named-context primitive, with identity checks that fail closed.

## What Changes

- Worktree detection (no spawns): once per session, the extension detects whether the session working directory is a linked git worktree by reading the `.git` pointer file (a `gitdir:` reference into the repository's `worktrees/` store) — pure filesystem inspection, cached, zero `cgc`/`git` invocations.
- Opt-in isolation mode (`worktree.mode`: `off` (default) | `isolate`): in `isolate` mode, each linked worktree maps to a dedicated CGC named context (`wt-<worktree-id>`), created on demand under the same auto-create consent gate as the lifecycle change; all extension runner invocations for that workspace carry the matching `--context` flag.
- Identity-checked, fail-closed: the extension records the mapping (worktree identity = repository common dir + worktree id); if a resolved context's identity no longer matches the session's worktree — replaced, re-registered, or pointing at a different repository — the extension reports an unknown/identity-mismatch state instead of silently querying another worktree's graph.
- Stale-worktree notices, never autonomous deletion: when a mapped worktree directory no longer exists (pruned), the extension surfaces a one-time notice naming the orphaned context and the cleanup command (`/cgc_context delete`); it never deletes registrations or files on its own, per the ADR-0003 consent model.
- Main checkouts and non-git directories are unaffected; when the mode is `off`, CGC's own context resolution applies unchanged.
- Config key: `worktree.mode` (default `off`), with an environment-variable override.

## Capabilities

### New Capabilities

- `cgc-worktree-contexts`: opt-in, identity-checked worktree isolation — worktree detection, per-worktree named-context mapping on CGC's primitive, fail-closed identity verification, and stale-worktree cleanup notices.

### Modified Capabilities

(none — no existing capabilities; `openspec/specs/` is empty)

## Impact

- Extension package `pi-codegraphcontext`; detection is filesystem-only; context creation rides the documented `cgc context create` verb through the shared runner; all workspace invocations gain a `--context` flag in isolate mode.
- Composes with the lifecycle gate (worktree context creation follows the same consent gate) and the CLI-gap tools (`/cgc_context` is the documented cleanup path for stale worktrees).
- Fail-closed behavior changes answers in a safe direction: identity mismatches surface as errors/notices rather than silently-wrong graph results.
- No changes to CodeGraphContext, the MCP server, or other capabilities; default `off` means non-worktree users see no behavior change.
