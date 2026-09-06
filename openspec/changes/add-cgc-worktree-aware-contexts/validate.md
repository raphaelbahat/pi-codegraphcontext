# Task Validation: add-cgc-worktree-aware-contexts

- Validated against: live framework/library/tool documentation
- Validation date: 2026-09-06
- Verdict: READY

Validation method: one read-only validator (single technology group spanning git's worktree pointer-file mechanism and CGC's named-context verbs) checked every externally-observable claim in tasks.md against the official git documentation (git-scm.com) and the project's live files on GitHub `main` (Context7 unavailable in this environment; the same evidence sources were fetched directly).

Approved precision fix applied: the validator flagged that submodule checkouts also use a `.git` gitfile, so "gitfile ⇒ worktree" is not strictly exclusive. With user approval (established corrections policy), design.md D1 was updated to require verifying the gitdir target sits under the repository's `.git/worktrees/` prefix before treating it as worktree membership. No verdict changed.

---

## INVALID — requires revision

None.

---

## VALID — confirmed

### 1.2

- Worktree detection via the `.git` pointer file is confirmed by official git docs: a linked worktree's `.git` is a plain-text gitfile containing `gitdir: <path>` into the main repository's `$GIT_DIR/worktrees/<id>/`, while a main checkout's `.git` is a directory; the worktree id is the store directory name (numeric suffix only for uniqueness). The pointer yields both membership detection and the id with zero spawns.
  - Evidence: <https://git-scm.com/docs/git-worktree> (DETAILS) ; <https://git-scm.com/docs/gitrepository-layout>
  - Caveat pinned into the design: submodule checkouts also use a gitfile — verify the gitdir target is under the repo's `.git/worktrees/` prefix.

### 2.1 / 2.2

- CGC named contexts are a real isolation primitive with the full documented lifecycle: `cgc context create <name> [--database <backend>] [--db-path <path>]`, `cgc context list`, `cgc context delete <name>`, `cgc context default <name>`, plus the global `--context`/`-c` option ("Target a named context workspace") that takes top precedence in CGC's context resolution.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/guides/contexts.md> ; <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/reference/cli.md>

### 2.4 (supporting)

- Context deletion is registration-level by CGC's own design: "Deleting a context removes its registration from `config.yaml`. The underlying database files on disk are preserved to prevent data loss." — matching the notice-based (never autonomous) cleanup posture.
  - Evidence: <https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/docs/docs/guides/contexts.md> (Delete a Context)

### 3.4

- `openspec validate <item> --type <type> --strict` matches the installed OpenSpec CLI usage exactly.
  - Evidence: `openspec validate --help` (verified 2026-09-06; same CLI verified for change 1)

---

## Fixes needed

None outstanding. (The validator-prescribed submodule caveat was applied to design.md D1 with user approval under the established corrections policy.)

---

## Verdict

`VERDICT: READY`
