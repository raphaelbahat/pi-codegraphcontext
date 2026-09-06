## 1. Detection and mapping

- [ ] 1.1 Implement config key `worktree.mode` (`off` default | `isolate`) with an environment-variable override.
- [ ] 1.2 Implement spawn-free worktree detection: read the `.git` pointer file, parse the `gitdir:` reference into repository common dir + worktree id, cache once per session; report main checkouts and non-git directories as non-worktrees; degrade fail-open on malformed pointers, capping retries at one per session.
- [ ] 1.3 Implement the worktree map: `{context name, repository common dir, worktree id}` records persisted per workspace, with identity verification at resolution.

## 2. Isolation behavior

- [ ] 2.1 Implement isolate-mode mapping: create `wt-<worktree-id>` named contexts on demand via documented `cgc context create` behind the auto-create consent gate; verify name uniqueness with structured errors on collision.
- [ ] 2.2 Carry the mapped `--context` flag on every extension runner invocation for the workspace while a mapping's identity matches.
- [ ] 2.3 Implement fail-closed identity checks: any mismatch (different repository, missing worktree pointer, recreated context) blocks extension indexing/syncing/tool use for that context and surfaces the identity-mismatch state.
- [ ] 2.4 Implement stale-worktree notices: pruned mappings surface a one-time notice naming the orphaned context and `/cgc_context delete`; no autonomous deletion.

## 3. Verification and closure

- [ ] 3.1 Test detection across main checkout / linked worktree / malformed pointer; test mapping lifecycle (create-on-consent, reuse, mismatch refusal, pruned notice).
- [ ] 3.2 Test default-off behavior (no mapping, no flag injection) and fail-open containment, including the one-retry-per-session cap.
- [ ] 3.3 Verify all scenarios in `specs/cgc-worktree-contexts/spec.md` against the implementation.
- [ ] 3.4 Run `openspec validate add-cgc-worktree-aware-contexts --type change --strict` before archive.
