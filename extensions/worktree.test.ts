import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionInvocationBudget } from './budget'
import type { CgcCommandResult, CgcRunner } from './runner'
import {
  buildWorktreeContextName,
  buildWorktreeIsolateCollisionNotice,
  buildWorktreeIsolateCreatingNotice,
  buildWorktreeIsolateDeclinedNotice,
  buildWorktreeIsolateDegradedNotice,
  buildWorktreePrunedNotice,
  CONTEXT_CREATE_VERB,
  parseGitfile,
  repoCommonDirOf,
  WORKTREE_MAP_FILE,
  WorktreeDetector,
  type WorktreeIsolateNotice,
  WorktreeIsolator,
  WorktreeMap,
  type WorktreeMapRecord,
  worktreeContextResolver,
  worktreeMapPath,
} from './worktree'

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'cgc-worktree-test-'))
}

function cleanupWorkspace(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** Absolute gitdir fixture: `<repo>/.git/worktrees/<id>`. */
function gitdirFor(workspace: string, id: string): string {
  return join(workspace, '.git', 'worktrees', id)
}

function makeGitfile(workspace: string, content: string): void {
  writeFileSync(join(workspace, '.git'), content, 'utf8')
}

describe('parseGitfile', () => {
  it('parses an absolute gitdir pointer into common dir and worktree id', () => {
    const parse = parseGitfile('gitdir: /repo/.git/worktrees/wt-1\n', '/unused')
    expect(parse).toEqual({
      ok: true,
      kind: 'worktree',
      commonDir: '/repo/.git',
      id: 'wt-1',
    })
  })

  it('tolerates the conventional space, BOM, and CRLF line endings', () => {
    expect(parseGitfile('gitdir: /repo/.git/worktrees/a\r\n', '/unused')).toMatchObject({
      ok: true,
      kind: 'worktree',
      id: 'a',
    })
    expect(parseGitfile('\uFEFFgitdir: /repo/.git/worktrees/b\n', '/unused')).toMatchObject({
      ok: true,
      kind: 'worktree',
      id: 'b',
    })
  })

  it('resolves relative gitdir paths against the directory containing the gitfile', () => {
    const parse = parseGitfile('gitdir: .git/worktrees/wt-rel', '/home/dev/app')
    expect(parse).toEqual({
      ok: true,
      kind: 'worktree',
      commonDir: '/home/dev/app/.git',
      id: 'wt-rel',
    })
  })

  it('expands a leading ~ against the home directory', () => {
    const parse = parseGitfile(
      'gitdir: ~/.codegraphcontext/.git/worktrees/wt-home',
      '/unused',
      '/home/user',
    )
    expect(parse).toEqual({
      ok: true,
      kind: 'worktree',
      commonDir: '/home/user/.codegraphcontext/.git',
      id: 'wt-home',
    })
  })

  it('rejects pointers without the gitdir: prefix', () => {
    const parse = parseGitfile('/repo/.git/worktrees/wt-1\n', '/unused')
    expect(parse.ok).toBe(false)
    if (!parse.ok) expect(parse.reason).toContain('gitdir')
  })

  it('rejects empty and multi-line gitdir paths', () => {
    expect(parseGitfile('gitdir:\n', '/unused').ok).toBe(false)
    expect(parseGitfile('gitdir:  \n', '/unused').ok).toBe(false)
    expect(parseGitfile('gitdir: /repo/.git/worktrees/wt-1\ngarbage\n', '/unused').ok).toBe(false)
  })

  it('classifies submodule gitfiles as non-worktree targets', () => {
    // Submodules are also gitfiles, but point at `.git/modules/<name>`.
    const parse = parseGitfile('gitdir: /repo/.git/modules/dep\n', '/unused')
    expect(parse).toEqual({ ok: true, kind: 'other', targetDir: '/repo/.git/modules/dep' })
  })

  it('classifies store-adjacent targets without a worktree id as non-worktree', () => {
    const parse = parseGitfile('gitdir: /repo/.git/worktrees\n', '/unused')
    expect(parse).toEqual({ ok: true, kind: 'other', targetDir: '/repo/.git/worktrees' })
  })
})

describe('WorktreeDetector', () => {
  it('reports non-git directories as non-worktrees', () => {
    const workspace = makeWorkspace()
    try {
      const result = new WorktreeDetector().detect(workspace)
      expect(result.isWorktree).toBe(false)
      expect(result.identity).toBeNull()
      expect(result.message).toContain('no .git entry')
      expect(result.cached).toBe(false)
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('reports main checkouts (.git directory) as non-worktrees', () => {
    const workspace = makeWorkspace()
    try {
      mkdirSync(join(workspace, '.git'))
      const result = new WorktreeDetector().detect(workspace)
      expect(result.isWorktree).toBe(false)
      expect(result.message).toContain('main checkout')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('detects a linked worktree from its gitdir pointer without spawning anything', () => {
    const workspace = makeWorkspace()
    try {
      makeGitfile(workspace, `gitdir: ${gitdirFor(workspace, 'wt-branch')}\n`)

      const result = new WorktreeDetector().detect(workspace)
      expect(result.isWorktree).toBe(true)
      expect(result.identity).toEqual({
        commonDir: join(workspace, '.git'),
        id: 'wt-branch',
      })
      expect(result.message).toContain('wt-branch')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('handles relative gitdir pointers through the detector', () => {
    const workspace = makeWorkspace()
    try {
      makeGitfile(workspace, 'gitdir: .git/worktrees/wt-rel\n')
      const result = new WorktreeDetector().detect(workspace)
      expect(result.isWorktree).toBe(true)
      expect(result.identity).toEqual({ commonDir: join(workspace, '.git'), id: 'wt-rel' })
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('expands ~ gitdir pointers through the detector', () => {
    const workspace = makeWorkspace()
    try {
      makeGitfile(workspace, 'gitdir: ~/repo/.git/worktrees/wt-home\n')
      const result = new WorktreeDetector({ homeDir: '/home/x' }).detect(workspace)
      expect(result.isWorktree).toBe(true)
      expect(result.identity).toEqual({ commonDir: '/home/x/repo/.git', id: 'wt-home' })
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('reports submodule gitfiles as non-worktrees, not failures', () => {
    const workspace = makeWorkspace()
    try {
      makeGitfile(workspace, 'gitdir: /repo/.git/modules/dep\n')
      const result = new WorktreeDetector().detect(workspace)
      expect(result.isWorktree).toBe(false)
      expect(result.identity).toBeNull()
      expect(result.message).toContain('outside .git/worktrees')
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('caches the detection result for the lifetime of the detector', () => {
    const workspace = makeWorkspace()
    try {
      makeGitfile(workspace, `gitdir: ${gitdirFor(workspace, 'wt-cached')}\n`)

      const detector = new WorktreeDetector()
      const first = detector.detect(workspace)
      const second = detector.detect(workspace)

      expect(first.cached).toBe(false)
      expect(second.cached).toBe(true)
      expect(second.isWorktree).toBe(true)
      expect(second.identity).toEqual(first.identity)

      detector.reset()
      const third = detector.detect(workspace)
      expect(third.cached).toBe(false)
    } finally {
      cleanupWorkspace(workspace)
    }
  })

  it('fails open on malformed pointers with exactly one retry per session', () => {
    const brokenA = makeWorkspace()
    const brokenB = makeWorkspace()
    try {
      makeGitfile(brokenA, 'not a git pointer\n')
      makeGitfile(brokenB, 'gitdir:\n')

      const detector = new WorktreeDetector()
      const first = detector.detect(brokenA)
      expect(first.isWorktree).toBe(false)
      expect(first.identity).toBeNull()
      expect(first.message).toContain('degraded to non-worktree')
      // The malformed pointer consumed the session's one retry.
      expect(first.retried).toBe(true)

      // Cached: no further pointer reads, so no further retries either.
      const cached = detector.detect(brokenA)
      expect(cached.cached).toBe(true)
      expect(cached.retried).toBe(true)

      // Budget is spent: a second malformed pointer is never retried.
      const second = detector.detect(brokenB)
      expect(second.isWorktree).toBe(false)
      expect(second.retried).toBe(false)

      // A fresh session restores the budget.
      detector.reset()
      const afterReset = detector.detect(brokenB)
      expect(afterReset.isWorktree).toBe(false)
      expect(afterReset.retried).toBe(true)
    } finally {
      cleanupWorkspace(brokenA)
      cleanupWorkspace(brokenB)
    }
  })

  it('does not spend the retry budget on well-formed pointers', () => {
    const good = makeWorkspace()
    const bad = makeWorkspace()
    try {
      makeGitfile(good, `gitdir: ${gitdirFor(good, 'wt-ok')}\n`)
      makeGitfile(bad, 'junk\n')

      const detector = new WorktreeDetector()
      expect(detector.detect(good).isWorktree).toBe(true)
      expect(detector.detect(good).retried).toBe(false)

      // The retry budget is still intact for the genuine failure.
      const badResult = detector.detect(bad)
      expect(badResult.retried).toBe(true)
    } finally {
      cleanupWorkspace(good)
      cleanupWorkspace(bad)
    }
  })

  it('applies the one-retry-per-session cap to unreadable pointers (fail-open containment)', () => {
    // A unix-socket file is stat-able as a non-directory but open() fails
    // with ENXIO — a deterministic, permission-independent way to make the
    // pointer read fail AFTER a successful stat, exercising the `unreadable`
    // branch of the one-retry cap (the malformed-content branch is covered
    // by the test above).
    const workspaceA = makeWorkspace()
    const workspaceB = makeWorkspace()
    const sockA = createServer()
    const sockB = createServer()
    sockA.listen(join(workspaceA, '.git'), () => undefined)
    sockB.listen(join(workspaceB, '.git'), () => undefined)
    try {
      const detector = new WorktreeDetector()
      const first = detector.detect(workspaceA)
      expect(first.isWorktree).toBe(false)
      expect(first.identity).toBeNull()
      expect(first.message).toContain('unreadable')
      expect(first.message).toContain('degraded to non-worktree')
      // The unreadable pointer consumed the session's one retry.
      expect(first.retried).toBe(true)

      // Cached: no further pointer reads, so no further retries either.
      const cached = detector.detect(workspaceA)
      expect(cached.cached).toBe(true)
      expect(cached.retried).toBe(true)

      // Budget is spent: a second unreadable pointer is never retried.
      const second = detector.detect(workspaceB)
      expect(second.isWorktree).toBe(false)
      expect(second.retried).toBe(false)

      // A fresh session restores the budget.
      detector.reset()
      const afterReset = detector.detect(workspaceB)
      expect(afterReset.isWorktree).toBe(false)
      expect(afterReset.retried).toBe(true)
    } finally {
      // Closing the listeners unlinks the socket files inside the workspaces
      // (before the recursive cleanup removes the directories).
      sockA.close()
      sockB.close()
      cleanupWorkspace(workspaceA)
      cleanupWorkspace(workspaceB)
    }
  })

  it('never throws, even on a dangling or empty .git entry', () => {
    const workspace = makeWorkspace()
    try {
      try {
        symlinkSync(join(workspace, 'nowhere'), join(workspace, '.git'))
      } catch {
        // Symlinks unsupported on this filesystem: fall back to an empty file.
        writeFileSync(join(workspace, '.git'), '')
      }
      const result = new WorktreeDetector().detect(workspace)
      expect(result.isWorktree).toBe(false)
      expect(result.cached).toBe(false)
    } finally {
      cleanupWorkspace(workspace)
    }
  })
})

// --- Worktree map fixtures (task 1.3) ---

/** A fake repository's main checkout: a directory with a `.git` DIRECTORY. */
function makeRepo(): string {
  const repo = makeWorkspace()
  mkdirSync(join(repo, '.git'))
  return repo
}

/** A linked worktree of the fake repository, via a gitfile into its store. */
function makeWorktree(commonDir: string, id: string): string {
  const wt = makeWorkspace()
  writeFileSync(join(wt, '.git'), `gitdir: ${join(commonDir, 'worktrees', id)}\n`, 'utf8')
  return wt
}

/** Read and parse the persisted map file of a repository. */
function readMapFile(commonDir: string): unknown {
  return JSON.parse(readFileSync(join(commonDir, WORKTREE_MAP_FILE), 'utf8')) as unknown
}

/** One map + one detector = one Pi session (both are per-session objects). */
function freshMap(): WorktreeMap {
  return new WorktreeMap({ detector: new WorktreeDetector() })
}

/** Test helper: find a record or fail loudly (avoids `!` assertions). */
function requireRecord(
  records: readonly WorktreeMapRecord[],
  predicate: (record: WorktreeMapRecord) => boolean,
): WorktreeMapRecord {
  const record = records.find(predicate)
  if (record === undefined) throw new Error('expected a matching worktree map record')
  return record
}

describe('WorktreeMap', () => {
  it('places the map file inside the repository common git dir', () => {
    expect(worktreeMapPath('/repo/.git')).toBe(join('/repo/.git', WORKTREE_MAP_FILE))
  })

  it('reports non-worktree workspaces as not-worktree with no mapping', () => {
    const plain = makeWorkspace()
    try {
      const resolution = freshMap().resolve(plain)
      expect(resolution.status).toBe('not-worktree')
      expect(resolution.contextName).toBeNull()
      expect(resolution.recorded).toBeNull()
    } finally {
      cleanupWorkspace(plain)
    }
  })

  it('fails open on a malformed gitfile: not-worktree resolution, no name, no record', () => {
    // A malformed pointer must degrade to non-worktree behavior end to end:
    // resolution reports not-worktree (never a blocked/unmapped state), no
    // context name is ever injected, and recording refuses — the map never
    // guesses an identity from a broken pointer (spec: "Detection errors are
    // contained").
    const wt = makeWorkspace()
    try {
      makeGitfile(wt, 'not a git pointer\n')
      const map = freshMap()
      const resolution = map.resolve(wt)
      expect(resolution.status).toBe('not-worktree')
      expect(resolution.contextName).toBeNull()
      expect(resolution.detected).toBeNull()
      expect(resolution.recorded).toBeNull()
      expect(map.contextFor(wt)).toBeNull()
      const attempt = map.record(wt, 'wt-x')
      expect(attempt.status).toBe('invalid')
      expect(attempt.reason).toContain('not a linked git worktree')
    } finally {
      cleanupWorkspace(wt)
    }
  })

  it('leaves a worktree with no record unmapped', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const resolution = freshMap().resolve(wt)
      expect(resolution.status).toBe('unmapped')
      expect(resolution.contextName).toBeNull()
      expect(resolution.detected).toEqual({ commonDir, id: 'branch-a' })
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('persists a record and reuses the mapping across sessions (matching identity)', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const recorded = freshMap().record(wt, 'wt-branch-a')
      expect(recorded.status).toBe('recorded')
      expect(recorded.record).toMatchObject({
        cwd: wt,
        contextName: 'wt-branch-a',
        commonDir,
        worktreeId: 'branch-a',
      })

      const file = readMapFile(commonDir) as { version: number; records: unknown[] }
      expect(file.version).toBe(1)
      expect(file.records).toEqual([
        expect.objectContaining({ cwd: wt, contextName: 'wt-branch-a' }),
      ])

      // A fresh session (new detector + new map) reads the persisted record.
      const resolution = freshMap().resolve(wt)
      expect(resolution.status).toBe('match')
      expect(resolution.contextName).toBe('wt-branch-a')
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('records the same workspace and name idempotently, preserving createdAt', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      let clock = 1000
      const map = new WorktreeMap({ detector: new WorktreeDetector(), now: () => clock })
      const first = map.record(wt, 'wt-a')
      clock = 2000
      const second = map.record(wt, 'wt-a')
      expect(first.status).toBe('recorded')
      expect(second.status).toBe('recorded')
      expect(second.record?.createdAt).toBe(1000)
      expect(second.record?.updatedAt).toBe(2000)
      const file = readMapFile(commonDir) as { records: unknown[] }
      expect(file.records).toHaveLength(1)
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('fail-closes when the worktree identity shifts to a new id', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      freshMap().record(wt, 'wt-old')
      // The worktree is re-added with a new id (simulated by rewriting the pointer).
      writeFileSync(
        join(wt, '.git'),
        `gitdir: ${join(commonDir, 'worktrees', 'branch-b')}\n`,
        'utf8',
      )

      const resolution = freshMap().resolve(wt)
      expect(resolution.status).toBe('mismatch')
      expect(resolution.contextName).toBeNull()
      expect(resolution.recorded?.contextName).toBe('wt-old')
      expect(resolution.reason).toContain('different worktree')
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('fail-closes when the workspace now belongs to a different repository', () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    const commonDirA = join(repoA, '.git')
    const wt = makeWorktree(commonDirA, 'branch-a')
    try {
      freshMap().record(wt, 'wt-a')
      writeFileSync(
        join(wt, '.git'),
        `gitdir: ${join(repoB, '.git', 'worktrees', 'branch-a')}\n`,
        'utf8',
      )

      // A fresh session at the re-pointed path cannot locate the old repo's
      // record file, so it resolves unmapped — crucially WITHOUT reusing the
      // recorded context name (no silent wrong-repo use). The stale record is
      // caught from the old repository's side by per-record verification
      // (task 2.4's pruned/mismatch surface).
      const resolution = freshMap().resolve(wt)
      expect(resolution.status).toBe('unmapped')
      expect(resolution.contextName).toBeNull()
      expect(resolution.recorded).toBeNull()

      const staleRecords = freshMap().recordsForCommonDir(commonDirA)
      expect(staleRecords).toHaveLength(1)
      const stale = requireRecord(staleRecords, (record) => record.contextName === 'wt-a')
      expect(freshMap().verifyRecord(stale)).toMatchObject({
        kind: 'mismatch',
        reason: expect.stringContaining('different repository'),
      })
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repoA)
      cleanupWorkspace(repoB)
    }
  })

  it('rejects a duplicate wt- context name mapped by another workspace', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wtA = makeWorktree(commonDir, 'branch-a')
    const wtB = makeWorktree(commonDir, 'branch-b')
    try {
      const map = freshMap()
      expect(map.record(wtA, 'wt-shared').status).toBe('recorded')
      const collision = map.record(wtB, 'wt-shared')
      expect(collision.status).toBe('collision')
      expect(collision.existing?.cwd).toBe(wtA)
      expect(collision.reason).toContain('unique')
      const file = readMapFile(commonDir) as { records: unknown[] }
      expect(file.records).toHaveLength(1)
    } finally {
      cleanupWorkspace(wtA)
      cleanupWorkspace(wtB)
      cleanupWorkspace(repo)
    }
  })

  it('frees a context name after its mapping is removed', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wtA = makeWorktree(commonDir, 'branch-a')
    const wtB = makeWorktree(commonDir, 'branch-b')
    try {
      const map = freshMap()
      map.record(wtA, 'wt-x')
      expect(map.record(wtB, 'wt-x').status).toBe('collision')
      expect(map.remove(wtA).status).toBe('removed')
      expect(map.record(wtB, 'wt-x').status).toBe('recorded')
      const file = readMapFile(commonDir) as { records: unknown[] }
      expect(file.records).toHaveLength(1)
    } finally {
      cleanupWorkspace(wtA)
      cleanupWorkspace(wtB)
      cleanupWorkspace(repo)
    }
  })

  it('replaces the mapping when the same workspace is re-recorded under a new name', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      let clock = 100
      const map = new WorktreeMap({ detector: new WorktreeDetector(), now: () => clock })
      expect(map.record(wt, 'wt-old').status).toBe('recorded')
      clock = 200
      const replaced = map.record(wt, 'wt-new')
      expect(replaced.status).toBe('recorded')
      expect(replaced.record).toMatchObject({
        contextName: 'wt-new',
        createdAt: 100,
        updatedAt: 200,
      })
      const file = readMapFile(commonDir) as { records: unknown[] }
      expect(file.records).toHaveLength(1)
      expect(freshMap().resolve(wt).status).toBe('match')
      expect(freshMap().resolve(wt).contextName).toBe('wt-new')
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('removes a mapping from the persisted file', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const map = freshMap()
      map.record(wt, 'wt-a')
      expect(map.remove(wt).status).toBe('removed')
      const file = readMapFile(commonDir) as { records: unknown[] }
      expect(file.records).toHaveLength(0)
      expect(freshMap().resolve(wt).status).toBe('unmapped')
      expect(map.remove(wt).status).toBe('absent')
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('refuses to record for non-worktree workspaces (plain dir and main checkout)', () => {
    const plain = makeWorkspace()
    const repo = makeRepo()
    try {
      const map = freshMap()
      const plainResult = map.record(plain, 'wt-x')
      expect(plainResult.status).toBe('invalid')
      expect(plainResult.reason).toContain('not a linked git worktree')
      const mainResult = map.record(repo, 'wt-x')
      expect(mainResult.status).toBe('invalid')
      expect(mainResult.reason).toContain('not a linked git worktree')
    } finally {
      cleanupWorkspace(plain)
      cleanupWorkspace(repo)
    }
  })

  it('verifies records: match, missing (pruned), mismatch (rewritten pointer)', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wtMatch = makeWorktree(commonDir, 'branch-a')
    const wtPruned = makeWorktree(commonDir, 'branch-b')
    const wtRewritten = makeWorktree(commonDir, 'branch-c')
    try {
      freshMap().record(wtMatch, 'wt-a')
      freshMap().record(wtPruned, 'wt-b')
      freshMap().record(wtRewritten, 'wt-c')

      // Prune one checkout entirely; rewrite another's pointer to a new id.
      rmSync(wtPruned, { recursive: true, force: true })
      writeFileSync(
        join(wtRewritten, '.git'),
        `gitdir: ${join(commonDir, 'worktrees', 'branch-cc')}\n`,
        'utf8',
      )

      const verifier = freshMap()
      const records = verifier.recordsForCommonDir(commonDir)
      expect(records).toHaveLength(3)
      const byId = (id: string) => requireRecord(records, (record) => record.worktreeId === id)
      expect(verifier.verifyRecord(byId('branch-a'))).toMatchObject({ kind: 'match' })
      expect(verifier.verifyRecord(byId('branch-b'))).toMatchObject({ kind: 'missing' })
      expect(verifier.verifyRecord(byId('branch-c'))).toMatchObject({ kind: 'mismatch' })
    } finally {
      cleanupWorkspace(wtMatch)
      cleanupWorkspace(wtRewritten)
      cleanupWorkspace(repo)
    }
  })

  it('verifyCommonDir enumerates per-record staleness of one repository (task 2.4 surface)', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wtLive = makeWorktree(commonDir, 'branch-a')
    const wtPruned = makeWorktree(commonDir, 'branch-b')
    try {
      freshMap().record(wtLive, 'wt-a')
      freshMap().record(wtPruned, 'wt-b')
      // Prune one checkout: the map file keeps its record; the directory is gone.
      rmSync(wtPruned, { recursive: true, force: true })

      const verifications = freshMap().verifyCommonDir(commonDir)
      expect(verifications).toHaveLength(2)
      const kindFor = (id: string) =>
        verifications.find((verification) => verification.record.worktreeId === id)?.kind
      expect(kindFor('branch-a')).toBe('match')
      expect(kindFor('branch-b')).toBe('missing')
    } finally {
      cleanupWorkspace(wtLive)
      cleanupWorkspace(repo)
    }
  })

  it('reaches the map file from the main checkout via common-dir discovery', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wtA = makeWorktree(commonDir, 'branch-a')
    const wtB = makeWorktree(commonDir, 'branch-b')
    try {
      freshMap().record(wtA, 'wt-a')
      freshMap().record(wtB, 'wt-b')

      const commonDirFromMain = repoCommonDirOf(repo)
      if (commonDirFromMain === null) {
        throw new Error('expected the main checkout common dir')
      }
      expect(commonDirFromMain).toBe(commonDir)
      expect(freshMap().recordsForCommonDir(commonDirFromMain)).toHaveLength(2)
    } finally {
      cleanupWorkspace(wtA)
      cleanupWorkspace(wtB)
      cleanupWorkspace(repo)
    }
  })

  it('never clobbers an unreadable map file and resolves unmapped with a warning', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      freshMap().record(wt, 'wt-a')
      const mapPath = join(commonDir, WORKTREE_MAP_FILE)
      writeFileSync(mapPath, '{ not json', 'utf8')

      const resolution = freshMap().resolve(wt)
      expect(resolution.status).toBe('unmapped')
      expect(resolution.contextName).toBeNull()
      expect(resolution.reason).toContain('unreadable')

      const attempt = freshMap().record(wt, 'wt-b')
      expect(attempt.status).toBe('unwritable')
      expect(readFileSync(mapPath, 'utf8')).toBe('{ not json')
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('refuses to overwrite a map file from an unsupported version', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      writeFileSync(
        join(commonDir, WORKTREE_MAP_FILE),
        JSON.stringify({ version: 99, records: [] }),
        'utf8',
      )
      const attempt = freshMap().record(wt, 'wt-a')
      expect(attempt.status).toBe('unwritable')
      expect(attempt.reason).toContain('unsupported map version')
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })
})

// --- Task 2.1: isolate-mode mapping (context creation) ---

/**
 * Minimal runner stand-in. Queues canned results for context creation runs;
 * unprefilled calls resolve with a healthy exit-0 result so tests only
 * specify what matters.
 */
class IsolatorMockRunner {
  calls: { cwd: string; args: readonly string[]; timeoutMs?: number | undefined }[] = []
  results: CgcCommandResult[] = []
  /** When set, replaces the implementation entirely (failure-injection tests). */
  overrideRun?: (cwd: string, options: { args: readonly string[] }) => Promise<CgcCommandResult>

  run(
    cwd: string,
    options: { args: readonly string[]; timeoutMs?: number },
  ): Promise<CgcCommandResult> {
    this.calls.push({ cwd, args: options.args, timeoutMs: options.timeoutMs })
    if (this.overrideRun) return this.overrideRun(cwd, options)
    const next = this.results.shift()
    return Promise.resolve(next ?? this.okResult(cwd, options.args))
  }

  private okResult(cwd: string, args: readonly string[]): CgcCommandResult {
    return {
      ok: true,
      code: 'OK',
      message: 'cgc exited 0',
      exitCode: 0,
      signal: null,
      stdout: `Created context '${args[args.length - 1]}' (DB: neo4j)\n`,
      stderr: '',
      truncated: false,
      durationMs: 1,
      argv: [...args],
      cwd,
    }
  }
}

/** One detector + one map + one isolator = one Pi session (all per-session). */
function makeIsolator(
  runner: IsolatorMockRunner,
  options: Partial<{
    autoCreate: boolean
    budget: SessionInvocationBudget
    onNotice: (notice: WorktreeIsolateNotice) => void
  }> = {},
): { isolator: WorktreeIsolator; map: WorktreeMap; detector: WorktreeDetector } {
  const detector = new WorktreeDetector()
  const map = new WorktreeMap({ detector })
  return {
    detector,
    map,
    isolator: new WorktreeIsolator({
      runner: runner as unknown as CgcRunner,
      detector,
      map,
      autoCreate: options.autoCreate ?? false,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.onNotice === undefined ? {} : { onNotice: options.onNotice }),
    }),
  }
}

/** Rewrite a workspace's gitfile pointer (identity-shift fixtures). */
function repointGitfile(workspace: string, target: string): void {
  writeFileSync(join(workspace, '.git'), `gitdir: ${target}\n`, 'utf8')
}

describe('WorktreeMap.contextFor (task 2.2 --context injection surface)', () => {
  it('returns the verified context name only while the recorded identity matches', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const map = freshMap()

      // No mapping yet (including the creation-in-flight window, where the
      // record is only persisted after CGC confirms the context).
      expect(map.contextFor(wt)).toBeNull()

      expect(map.record(wt, 'wt-branch-a').status).toBe('recorded')
      expect(map.contextFor(wt)).toBe('wt-branch-a')

      // A fresh session-slice (new map, same durable file) still matches.
      expect(freshMap().contextFor(wt)).toBe('wt-branch-a')
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('returns null for non-worktrees, main checkouts, and other workspaces', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    const plainDir = makeWorkspace()
    const otherWt = makeWorktree(commonDir, 'branch-b')
    try {
      const map = freshMap()
      expect(map.record(wt, 'wt-branch-a').status).toBe('recorded')

      expect(map.contextFor(plainDir)).toBeNull() // non-git directory
      expect(map.contextFor(repo)).toBeNull() // main checkout
      expect(map.contextFor(otherWt)).toBeNull() // another worktree, unmapped
    } finally {
      cleanupWorkspace(plainDir)
      cleanupWorkspace(otherWt)
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('fails closed on identity mismatch: the name is never returned for a blocked workspace', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const map = freshMap()
      expect(map.record(wt, 'wt-branch-a').status).toBe('recorded')
      expect(map.contextFor(wt)).toBe('wt-branch-a')

      // The checkout is re-pointed at a different worktree id: identity shift.
      repointGitfile(wt, join(commonDir, 'worktrees', 'branch-a-renamed'))
      const nextSession = freshMap()
      expect(nextSession.resolve(wt).status).toBe('mismatch')
      expect(nextSession.contextFor(wt)).toBeNull()
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('fails closed on an unreadable map file: no name is ever injected', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const map = freshMap()
      expect(map.record(wt, 'wt-branch-a').status).toBe('recorded')

      // Corrupt the durable file the next session would read.
      writeFileSync(join(commonDir, WORKTREE_MAP_FILE), '{broken json', 'utf8')
      const nextSession = freshMap()
      expect(nextSession.contextFor(wt)).toBeNull()
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })
})

describe('worktreeContextResolver (task 2.2 runner hook)', () => {
  it('delegates to the map: a verified match yields the name, everything else null', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const map = freshMap()
      const resolver = worktreeContextResolver(map)

      expect(resolver(wt)).toBeNull()
      expect(map.record(wt, 'wt-branch-a').status).toBe('recorded')
      expect(resolver(wt)).toBe('wt-branch-a')
      expect(resolver(repo)).toBeNull()
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })
})

describe('buildWorktreeContextName', () => {
  it('derives a wt- name from a plain worktree id', () => {
    expect(buildWorktreeContextName('branch-a')).toEqual({ ok: true, name: 'wt-branch-a' })
  })

  it('refuses empty ids, path separators, and control characters', () => {
    expect(buildWorktreeContextName('')).toMatchObject({ ok: false })
    expect(buildWorktreeContextName('feature/x')).toMatchObject({ ok: false })
    expect(buildWorktreeContextName('bad\\id')).toMatchObject({ ok: false })
    expect(buildWorktreeContextName('bad\u0000id')).toMatchObject({ ok: false })
  })
})

describe('worktree isolate notice builders', () => {
  it('declined notice names the mapped context and every enablement route', () => {
    const text = buildWorktreeIsolateDeclinedNotice('/repo/wt', 'wt-branch-a')
    expect(text).toContain('wt-branch-a')
    expect(text).toContain('worktree.mode=isolate')
    expect(text).toContain('autoCreate')
    expect(text).toContain('lifecycle')
    expect(text).toContain('CGC_LIFECYCLE_AUTO_CREATE=1')
    expect(text).toContain('cgc context create wt-branch-a')
    expect(text).toContain('cgc index . --context wt-branch-a')
  })

  it('creating notice names the background creation', () => {
    const text = buildWorktreeIsolateCreatingNotice('/repo/wt', 'wt-branch-a')
    expect(text).toContain('wt-branch-a')
    expect(text).toContain('background')
  })

  it('collision notice names the conflicting workspace when a record exists', () => {
    const record: WorktreeMapRecord = {
      cwd: '/other/ws',
      contextName: 'wt-branch-a',
      commonDir: '/repo/.git',
      worktreeId: 'other-id',
      createdAt: 1,
      updatedAt: 1,
    }
    const text = buildWorktreeIsolateCollisionNotice('/repo/wt', 'wt-branch-a', record)
    expect(text).toContain('/other/ws')
    expect(text).toContain('/cgc_context delete')
    expect(text).toContain('NOT recorded')
  })

  it('collision notice names the cleanup command when CGC pre-owned the name', () => {
    const text = buildWorktreeIsolateCollisionNotice('/repo/wt', 'wt-branch-a', null)
    expect(text).toContain('already exists in the CGC registry')
    expect(text).toContain('/cgc_context delete')
    expect(text).toContain('identity, not the name')
  })

  it('degraded notice carries the failure reason and a manual path', () => {
    const text = buildWorktreeIsolateDegradedNotice('/repo/wt', 'spawn exploded')
    expect(text).toContain('spawn exploded')
    expect(text).toContain('cgc context create')
  })

  it('pruned notice names the orphaned context and the cleanup command, and nothing is deleted', () => {
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      freshMap().record(wt, 'wt-branch-a')
      rmSync(wt, { recursive: true, force: true })
      const record = requireRecord(
        freshMap().recordsForCommonDir(commonDir),
        (item) => item.worktreeId === 'branch-a',
      )
      const verification = freshMap().verifyRecord(record)
      expect(verification.kind).toBe('missing')

      const text = buildWorktreePrunedNotice(record, verification)
      expect(text).toContain('wt-branch-a')
      expect(text).toContain('`/cgc_context delete`')
      expect(text).toContain('Nothing was deleted')
      expect(text.toLowerCase()).toContain('orphan')
      // No autonomous deletion: the record is still in the map file.
      expect(
        freshMap()
          .recordsForCommonDir(commonDir)
          .some((item) => item.cwd === wt),
      ).toBe(true)
    } finally {
      cleanupWorkspace(repo)
    }
  })
})

describe('WorktreeIsolator outside worktrees', () => {
  it('does nothing for non-worktree workspaces (no spawn, no notice)', () => {
    const runner = new IsolatorMockRunner()
    const plain = makeWorkspace()
    try {
      const { isolator } = makeIsolator(runner, { autoCreate: true })
      const outcome = isolator.ensureMapping(plain)
      expect(outcome.action).toBe('not-worktree')
      expect(outcome.contextName).toBeNull()
      expect(outcome.creating).toBe(false)
      expect(runner.calls).toEqual([])
      expect(isolator.notices.length).toBe(0)
      expect(isolator.status(plain)).toBe('unhandled')
    } finally {
      cleanupWorkspace(plain)
    }
  })

  it('treats a malformed .git pointer exactly like a non-worktree (fail-open containment)', () => {
    // Detection errors are contained: a broken pointer is NOT a worktree, so
    // not even a consented isolate flow may derive a name, spawn, or notice
    // for it — the session proceeds as a main checkout would.
    const runner = new IsolatorMockRunner()
    const broken = makeWorkspace()
    try {
      makeGitfile(broken, 'junk\n')
      const { isolator } = makeIsolator(runner, { autoCreate: true })
      const outcome = isolator.ensureMapping(broken)
      expect(outcome.action).toBe('not-worktree')
      expect(outcome.contextName).toBeNull()
      expect(outcome.creating).toBe(false)
      expect(runner.calls).toEqual([])
      expect(isolator.notices.length).toBe(0)
      expect(isolator.status(broken)).toBe('unhandled')
    } finally {
      cleanupWorkspace(broken)
    }
  })
})

describe('WorktreeIsolator with autoCreate off (closed consent gate)', () => {
  it('starts no creation, surfaces the one-time declined notice, and never spawns', () => {
    const runner = new IsolatorMockRunner()
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const { isolator, map } = makeIsolator(runner)
      const outcome = isolator.ensureMapping(wt)

      expect(outcome.action).toBe('declined')
      expect(outcome.contextName).toBe('wt-branch-a')
      expect(outcome.notice?.kind).toBe('worktree-declined')
      expect(outcome.notice?.text).toContain('wt-branch-a')
      expect(runner.calls).toEqual([])
      expect(isolator.status(wt)).toBe('declined')
      expect(isolator.isCreating(wt)).toBe(false)

      // No mapping was persisted: the worktree stays unmapped.
      expect(map.resolve(wt).status).toBe('unmapped')
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('declines exactly once per workspace per session', () => {
    const runner = new IsolatorMockRunner()
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const { isolator } = makeIsolator(runner)
      const first = isolator.ensureMapping(wt)
      const second = isolator.ensureMapping(wt)
      expect(first.notice).not.toBeNull()
      expect(second.action).toBe('already-done')
      expect(second.repeated).toBe(true)
      expect(second.notice).toBeNull()
      expect(isolator.notices.length).toBe(1)
      expect(runner.calls).toEqual([])
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('delivers the notice to the sink and survives a throwing sink', () => {
    const runner = new IsolatorMockRunner()
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const seen: string[] = []
      const { isolator } = makeIsolator(runner, {
        onNotice: (notice: WorktreeIsolateNotice) => {
          seen.push(notice.text)
          throw new Error('sink exploded')
        },
      })
      const outcome = isolator.ensureMapping(wt)
      expect(seen.length).toBe(1)
      expect(isolator.notices.length).toBe(1)
      expect(outcome.action).toBe('declined')
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })
})

describe('WorktreeIsolator with autoCreate on (consented)', () => {
  it('creates the wt- context through the runner and records the mapping on success', async () => {
    const runner = new IsolatorMockRunner()
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const { isolator, map } = makeIsolator(runner, { autoCreate: true })
      const outcome = isolator.ensureMapping(wt)

      expect(outcome.action).toBe('creating')
      expect(outcome.creating).toBe(true)
      expect(outcome.contextName).toBe('wt-branch-a')
      expect(runner.calls).toEqual([
        { cwd: wt, args: [...CONTEXT_CREATE_VERB, 'wt-branch-a'], timeoutMs: undefined },
      ])
      expect(isolator.status(wt)).toBe('creating')
      expect(isolator.isCreating(wt)).toBe(true)
      expect(isolator.notices.map((notice) => notice.kind)).toContain('worktree-creating')

      const result = await isolator.whenCreated(wt)
      expect(result?.ok).toBe(true)
      expect(result?.code).toBe('OK')
      expect(result?.contextName).toBe('wt-branch-a')
      expect(result?.alreadyExists).toBe(false)
      expect(result?.conflictingRecord).toBeNull()
      expect(isolator.status(wt)).toBe('created')
      expect(isolator.isCreating(wt)).toBe(false)

      // The mapping is persisted and resolves as a verified reuse.
      expect(map.resolve(wt).status).toBe('match')
      const file = readMapFile(commonDir) as { records: unknown[] }
      expect(file.records).toEqual([
        expect.objectContaining({ cwd: wt, contextName: 'wt-branch-a', worktreeId: 'branch-a' }),
      ])
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('passes an explicit creation time budget when one is configured', async () => {
    const runner = new IsolatorMockRunner()
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const detector = new WorktreeDetector()
      const map = new WorktreeMap({ detector })
      const isolator = new WorktreeIsolator({
        runner: runner as unknown as CgcRunner,
        detector,
        map,
        autoCreate: true,
        createTimeoutMs: 5_000,
      })
      isolator.ensureMapping(wt)
      await isolator.whenCreated(wt)
      expect(runner.calls[0]?.timeoutMs).toBe(5_000)
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('reuses an existing verified mapping without spawning', () => {
    const runner = new IsolatorMockRunner()
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const detector = new WorktreeDetector()
      const map = new WorktreeMap({ detector })
      map.record(wt, 'wt-branch-a')
      const isolator = new WorktreeIsolator({
        runner: runner as unknown as CgcRunner,
        detector,
        map,
        autoCreate: true,
      })

      const outcome = isolator.ensureMapping(wt)
      expect(outcome.action).toBe('reused')
      expect(outcome.contextName).toBe('wt-branch-a')
      expect(outcome.creating).toBe(false)
      expect(runner.calls).toEqual([])
      expect(isolator.status(wt)).toBe('reused')
      expect(isolator.notices.length).toBe(0)
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('never re-spawns on repeated evaluations of the same workspace', () => {
    const runner = new IsolatorMockRunner()
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const { isolator } = makeIsolator(runner, { autoCreate: true })
      const first = isolator.ensureMapping(wt)
      const second = isolator.ensureMapping(wt)
      expect(first.action).toBe('creating')
      expect(second.action).toBe('already-done')
      expect(second.creating).toBe(true)
      expect(runner.calls.length).toBe(1)
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('records the failure and leaves the worktree unmapped when creation fails', async () => {
    const runner = new IsolatorMockRunner()
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      runner.results.push({
        ok: false,
        code: 'UNAVAILABLE',
        message: 'cgc executable could not be spawned: not found',
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 1,
        argv: [...CONTEXT_CREATE_VERB, 'wt-branch-a'],
        cwd: wt,
      })
      const { isolator, map } = makeIsolator(runner, { autoCreate: true })
      isolator.ensureMapping(wt)

      const result = await isolator.whenCreated(wt)
      expect(result?.ok).toBe(false)
      expect(result?.code).toBe('UNAVAILABLE')
      expect(isolator.status(wt)).toBe('failed')
      expect(isolator.notices.map((notice) => notice.kind)).toContain('worktree-degraded')
      expect(map.resolve(wt).status).toBe('unmapped')
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })
})

describe('WorktreeIsolator collision handling (name uniqueness)', () => {
  it('refuses to adopt a context cgc reports as already existing (exit 0)', async () => {
    const runner = new IsolatorMockRunner()
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      runner.results.push({
        ok: true,
        code: 'OK',
        message: 'cgc exited 0',
        exitCode: 0,
        signal: null,
        stdout: "Context 'wt-branch-a' already exists.\n",
        stderr: '',
        truncated: false,
        durationMs: 1,
        argv: [...CONTEXT_CREATE_VERB, 'wt-branch-a'],
        cwd: wt,
      })
      const { isolator, map } = makeIsolator(runner, { autoCreate: true })
      isolator.ensureMapping(wt)

      const result = await isolator.whenCreated(wt)
      expect(result?.ok).toBe(false)
      expect(result?.alreadyExists).toBe(true)
      expect(result?.conflictingRecord).toBeNull()
      expect(isolator.status(wt)).toBe('collision')

      // The collision is surfaced as a structured notice naming cleanup.
      const collision = isolator.notices.find((notice) => notice.kind === 'worktree-collision')
      expect(collision).not.toBeUndefined()
      expect(collision?.text).toContain('/cgc_context delete')

      // Nothing was recorded for this workspace.
      expect(map.resolve(wt).status).toBe('unmapped')
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('surfaces a structured collision with the conflicting record when the name is already mapped', async () => {
    const runner = new IsolatorMockRunner()
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      // A sibling workspace already maps the exact name `wt-branch-a` under a
      // DIFFERENT identity (crafted directly into the map file: the map's
      // record() cannot be used because identity keys are unique per id).
      const sibling = makeWorkspace()
      writeFileSync(
        join(commonDir, WORKTREE_MAP_FILE),
        JSON.stringify({
          version: 1,
          records: [
            {
              cwd: sibling,
              contextName: 'wt-branch-a',
              commonDir,
              worktreeId: 'other-id',
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
        'utf8',
      )
      const { isolator, map } = makeIsolator(runner, { autoCreate: true })
      isolator.ensureMapping(wt)

      const result = await isolator.whenCreated(wt)
      expect(result?.ok).toBe(false)
      expect(result?.alreadyExists).toBe(false)
      expect(result?.conflictingRecord).toMatchObject({
        cwd: sibling,
        contextName: 'wt-branch-a',
        worktreeId: 'other-id',
      })
      expect(isolator.status(wt)).toBe('collision')

      const collision = isolator.notices.find((notice) => notice.kind === 'worktree-collision')
      expect(collision?.text).toContain(sibling)
      expect(collision?.text).toContain('/cgc_context delete')

      // The sibling's mapping is untouched; this workspace stays unmapped.
      const file = readMapFile(commonDir) as { records: { cwd: string; worktreeId: string }[] }
      expect(file.records).toHaveLength(1)
      expect(file.records[0]?.cwd).toBe(sibling)
      expect(map.resolve(wt).status).toBe('unmapped')
      cleanupWorkspace(sibling)
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })
})

describe('WorktreeIsolator fail-closed identity checks and degradation', () => {
  it('refuses to create or record when a recorded identity no longer matches', () => {
    const runner = new IsolatorMockRunner()
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      // Session 1 records the mapping under identity `branch-a`.
      const session1 = new WorktreeMap({ detector: new WorktreeDetector() })
      expect(session1.record(wt, 'wt-branch-a').status).toBe('recorded')

      // The pointer now points at a different worktree id (re-pointed). The
      // detector caches per session, so the mismatch only surfaces across
      // sessions — exactly the worktree-awary design contract.
      repointGitfile(wt, join(commonDir, 'worktrees', 'branch-b'))
      const detector2 = new WorktreeDetector()
      const map2 = new WorktreeMap({ detector: detector2 })
      const isolator = new WorktreeIsolator({
        runner: runner as unknown as CgcRunner,
        detector: detector2,
        map: map2,
        autoCreate: true,
      })

      const outcome = isolator.ensureMapping(wt)
      expect(outcome.action).toBe('blocked-mismatch')
      expect(outcome.creating).toBe(false)
      expect(outcome.reason).toContain('no longer matches')
      expect(runner.calls).toEqual([])
      expect(isolator.status(wt)).toBe('blocked')

      // The original mapping is untouched (fail-closed, nothing created).
      expect(map2.resolve(wt).status).toBe('mismatch')
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('degrades without spawning when the session maintenance budget is exhausted', () => {
    const runner = new IsolatorMockRunner()
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const budget = new SessionInvocationBudget({ maxInvocations: 1 })
      budget.tryAcquire('/other', 'drift-sync')
      const { isolator, map } = makeIsolator(runner, { autoCreate: true, budget })

      const outcome = isolator.ensureMapping(wt)
      expect(outcome.action).toBe('degraded')
      expect(outcome.reason).toContain('budget')
      expect(runner.calls).toEqual([])
      expect(isolator.status(wt)).toBe('degraded')
      expect(isolator.notices.map((notice) => notice.kind)).toContain('worktree-degraded')
      expect(map.resolve(wt).status).toBe('unmapped')
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('degrades without spawning when the worktree id cannot form a valid name', () => {
    const runner = new IsolatorMockRunner()
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    // A control character inside the id slips through the detector's final-
    // segment split but must never produce a context name (or a spawn).
    const wt = makeWorkspace()
    writeFileSync(
      join(wt, '.git'),
      `gitdir: ${join(commonDir, 'worktrees', `bad\u0001id`)}\n`,
      'utf8',
    )
    try {
      const { isolator, map } = makeIsolator(runner, { autoCreate: true })
      const outcome = isolator.ensureMapping(wt)

      expect(outcome.action).toBe('degraded')
      expect(outcome.contextName).toBeNull()
      expect(outcome.reason).toContain('control characters')
      expect(runner.calls).toEqual([])
      expect(isolator.status(wt)).toBe('degraded')
      expect(isolator.notices.map((notice) => notice.kind)).toContain('worktree-degraded')
      expect(map.resolve(wt).status).toBe('unmapped')
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })

  it('reset clears the one-time markers so a fresh session can be evaluated', () => {
    const runner = new IsolatorMockRunner()
    const repo = makeRepo()
    const commonDir = join(repo, '.git')
    const wt = makeWorktree(commonDir, 'branch-a')
    try {
      const { isolator, map } = makeIsolator(runner)
      expect(isolator.ensureMapping(wt).action).toBe('declined')
      expect(isolator.ensureMapping(wt).action).toBe('already-done')
      isolator.reset()
      expect(isolator.ensureMapping(wt).action).toBe('declined')
      // The new session's notice log starts fresh (one notice, not two).
      expect(isolator.notices.length).toBe(1)
      expect(isolator.status(wt)).toBe('declined')
      // The underlying fixtures are intact.
      expect(map.resolve(wt).status).toBe('unmapped')
    } finally {
      cleanupWorkspace(wt)
      cleanupWorkspace(repo)
    }
  })
})
