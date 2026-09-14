// Worktree detection and mapping for pi-codegraphcontext (design D1/D3 of
// openspec/changes/add-cgc-worktree-aware-contexts, tasks 1.2/1.3).
//
// A linked git worktree is identified by its `.git` being a FILE (a gitfile)
// whose first line reads `gitdir: <path>`, where <path> points at the entry
// `<common>/.git/worktrees/<id>` in the repository's worktree store. Detection
// is spawn-free: one stat + one read, no `git` or `cgc` invocation (ADR-0001's
// wrap-only boundary), and the parsed result is cached on the detector, which
// lives exactly one Pi session. Worktrees do not move mid-session, so the
// pointer is resolved only once.
//
// Classification for a session working directory:
//   - no `.git` entry           -> non-worktree (not a git checkout)
//   - `.git` is a directory     -> non-worktree (main checkout)
//   - `.git` is a gitfile whose target sits under `<common>/.git/worktrees/<id>`
//                                -> WORKTREE {commonDir, id}
//   - `.git` is a gitfile pointing anywhere else (e.g. `.git/modules/<name>`
//                                for submodules) -> non-worktree
//   - `.git` is a gitfile that is unreadable or malformed -> fail-open
//                                non-worktree with a recorded error, with at
//                                most ONE re-read retry per session
//
// Fail-open contract: `detect()` never throws; every outcome is a structured
// WorktreeDetection, matching the workspace detector's posture. Malformed
// pointers degrade to non-worktree behavior and the session proceeds normally
// (spec: "Detection errors are contained").

import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { SessionInvocationBudget } from './budget'
import type { CgcCommandResult, CgcRunner, CgcRunOptions, RunnerContextResolver } from './runner'

/** Identity of a linked git worktree: its repository location plus its id. */
export interface WorktreeIdentity {
  /**
   * The worktree's repository common directory: the main checkout's `.git`
   * directory (which holds the shared objects/refs and the `worktrees/` store).
   */
  commonDir: string
  /** Worktree identifier, the final path segment of the `worktrees/` store entry. */
  id: string
}

/** Where does a gitfile point, and is it a linked worktree at all? */
export type GitfileParse =
  | { ok: true; kind: 'worktree'; commonDir: string; id: string }
  | { ok: true; kind: 'other'; targetDir: string }
  | { ok: false; reason: string }

/** Result of resolving one session working directory against the worktree store. */
export interface WorktreeDetection {
  /** The resolved session working directory that was inspected. */
  cwd: string
  /** True when the session working directory is a linked git worktree. */
  isWorktree: boolean
  /** Worktree identity, present only when `isWorktree` is true. */
  identity: WorktreeIdentity | null
  /** Single-line human-readable outcome for diagnostics surfaces. */
  message: string
  /**
   * True when this resolution consumed the session's one-time retry on a
   * malformed or unreadable gitfile pointer.
   */
  retried: boolean
  /** True when served from the per-session cache (no pointer was re-read). */
  cached: boolean
}

export interface WorktreeDetectorOptions {
  /**
   * Home directory used to expand a leading `~` in gitdir paths; defaults to
   * `os.homedir()`. Injectable for deterministic tests.
   */
  homeDir?: string
}

/**
 * Parse raw gitfile content (`gitdir: <path>`, git's documented on-disk
 * pointer contract). Mirrors git's own leniency: one line, optional trailing
 * newline, leading whitespace after the prefix skipped, and a leading `~`
 * expanded against the home directory. Relative paths resolve against
 * `baseDir` — the directory containing the `.git` file (the session cwd).
 *
 * Returns `ok: false` with a reason when the content is not a well-formed
 * pointer; returns `kind: 'other'` when the pointer is well-formed but targets
 * a location outside `<common>/.git/worktrees/<id>` (e.g. a submodule).
 */
export function parseGitfile(content: string, baseDir: string, homeDir = homedir()): GitfileParse {
  let text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  // Git writes a single `gitdir: <path>\n` line; tolerate one trailing CRLF.
  text = text.replace(/\r?\n$/, '')

  if (!text.startsWith('gitdir:')) {
    return { ok: false, reason: 'missing "gitdir:" prefix' }
  }

  const rawPath = text.slice('gitdir:'.length).trim()
  if (rawPath.length === 0) {
    return { ok: false, reason: 'empty gitdir path' }
  }
  if (rawPath.includes('\n')) {
    return { ok: false, reason: 'unexpected newline in gitdir path' }
  }

  // Expand a leading bare `~` (git's own convention for `$HOME`).
  let expanded = rawPath
  if (expanded === '~' || expanded.startsWith('~/')) {
    if (homeDir.length === 0) {
      return { ok: false, reason: 'gitdir path starts with "~" but no home directory is known' }
    }
    expanded = expanded === '~' ? homeDir : join(homeDir, expanded.slice(2))
  }

  const target = isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded)
  const worktree = splitWorktreeStorePath(target)
  if (worktree === null) {
    return { ok: true, kind: 'other', targetDir: target }
  }
  return { ok: true, kind: 'worktree', commonDir: worktree.commonDir, id: worktree.id }
}

/**
 * Split a resolved gitdir target into `{commonDir, id}` when it lives under
 * `<common>/.git/worktrees/<id>`. Only that store prefix proves worktree
 * membership — gitfiles alone are also used by submodules
 * (`<common>/.git/modules/<name>`). Returns null for any other location.
 */
function splitWorktreeStorePath(target: string): { commonDir: string; id: string } | null {
  const normalized = target.replace(/[\\/]+$/, '')
  const segments = normalized.split(sep)
  // Walk from the end so a nested `.git/worktrees/` inside a directory name
  // never shadows the real store; `<id>` is exactly one final segment.
  for (let i = segments.length - 3; i >= 0; i--) {
    if (segments[i] === '.git' && segments[i + 1] === 'worktrees') {
      const id = segments[segments.length - 1]
      if (id === undefined || id.length === 0) return null
      return { commonDir: segments.slice(0, i + 1).join(sep), id }
    }
  }
  return null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Per-session worktree detector.
 *
 * One instance per Pi session (create it in the session-start path and drop it
 * at shutdown): the parse cache and the one-time retry budget live exactly as
 * long as the session. Detection is synchronous and spawn-free — a `.git`
 * directory (main checkout) or a missing `.git` entry never touches the
 * pointer file at all.
 */
export class WorktreeDetector {
  private readonly homeDir: string
  /** Per-session cache of detection results, keyed by resolved session cwd. */
  private readonly cache = new Map<string, WorktreeDetection>()
  /** Session-wide retry budget for malformed pointers: at most one. */
  private retriesLeft = 1

  constructor(options: WorktreeDetectorOptions = {}) {
    this.homeDir = options.homeDir ?? homedir()
  }

  /**
   * Resolve the session working directory's worktree status, serving repeated
   * calls from the per-session cache. Never throws: unreadable or malformed
   * pointers fail open to a non-worktree result with a recorded message.
   */
  detect(sessionCwd: string): WorktreeDetection {
    const cwd = resolve(sessionCwd)
    const cached = this.cache.get(cwd)
    if (cached) return { ...cached, cached: true }

    const result = this.detectOnce(cwd)
    this.cache.set(cwd, result)
    return result
  }

  /**
   * Clear the per-session cache and restore the one-time retry budget (session
   * shutdown or a fresh session on the same detector).
   */
  reset(): void {
    this.cache.clear()
    this.retriesLeft = 1
  }

  private detectOnce(cwd: string): WorktreeDetection {
    const gitPath = join(cwd, '.git')

    // Main checkouts and non-git directories are non-worktrees without cost.
    let kind: 'dir' | 'file' | 'missing'
    try {
      kind = statSync(gitPath).isDirectory() ? 'dir' : 'file'
    } catch {
      kind = 'missing'
    }

    if (kind === 'missing') {
      return {
        cwd,
        isWorktree: false,
        identity: null,
        message: 'not a git checkout: no .git entry',
        retried: false,
        cached: false,
      }
    }
    if (kind === 'dir') {
      return {
        cwd,
        isWorktree: false,
        identity: null,
        message: 'main checkout: .git is a directory',
        retried: false,
        cached: false,
      }
    }

    // `.git` is a gitfile: parse the pointer, re-reading at most once per
    // session when the first attempt is unreadable or malformed.
    let parse = this.readPointer(gitPath, cwd)
    let retried = false
    if (!parse.ok && this.retriesLeft > 0) {
      this.retriesLeft -= 1
      retried = true
      parse = this.readPointer(gitPath, cwd)
    }

    if (!parse.ok) {
      return {
        cwd,
        isWorktree: false,
        identity: null,
        message: `malformed .git pointer (${parse.reason}); degraded to non-worktree`,
        retried,
        cached: false,
      }
    }

    if (parse.kind === 'worktree') {
      return {
        cwd,
        isWorktree: true,
        identity: { commonDir: parse.commonDir, id: parse.id },
        message: `linked git worktree "${parse.id}" of ${parse.commonDir}`,
        retried,
        cached: false,
      }
    }

    return {
      cwd,
      isWorktree: false,
      identity: null,
      message: `non-worktree: gitfile points outside .git/worktrees (${parse.targetDir})`,
      retried,
      cached: false,
    }
  }

  private readPointer(gitPath: string, baseDir: string): GitfileParse {
    let content: string
    try {
      content = readFileSync(gitPath, 'utf8')
    } catch (error) {
      return { ok: false, reason: `unreadable (${errorText(error)})` }
    }
    return parseGitfile(content, baseDir, this.homeDir)
  }
}

// --- Worktree map (design D3, task 1.3) ---

/** Version of the persisted worktree-map file format. */
export const WORKTREE_MAP_VERSION = 1

/**
 * File name of the per-repository worktree map. Stored inside the
 * repository's common git directory (`<repo>/.git/worktree-map.json`), which
 * survives worktree pruning: the durable records stay readable after the
 * checkout itself is gone (task 2.4 pruned notices), and every session inside
 * the repository — main checkout or any worktree — can reach the same file.
 */
export const WORKTREE_MAP_FILE = 'worktree-map.json'

/** Absolute path of the worktree map inside a repository's common git dir. */
export function worktreeMapPath(commonDir: string): string {
  return join(commonDir, WORKTREE_MAP_FILE)
}

/**
 * Spawn-free repository common-dir discovery for REPO-LEVEL FILE access only
 * (reading the worktree map from any session inside the repository, including
 * the main checkout, whose `.git` directory IS the common dir). This is not
 * the detection contract: identity checks must go through
 * `WorktreeDetector.detect()` so the per-session cache and the one-retry
 * budget stay single-sourced (task 1.3 gotchas).
 *
 * Returns the common dir for main checkouts (`.git` directory) and linked
 * worktrees (gitfile into `.git/worktrees/`); null for missing `.git`,
 * submodule pointers, or malformed gitfiles — fail-open, never throws.
 */
export function repoCommonDirOf(sessionCwd: string): string | null {
  const cwd = resolve(sessionCwd)
  const gitPath = join(cwd, '.git')
  let kind: 'dir' | 'file' | 'missing'
  try {
    kind = statSync(gitPath).isDirectory() ? 'dir' : 'file'
  } catch {
    kind = 'missing'
  }
  if (kind === 'dir') return gitPath
  if (kind === 'missing') return null
  let content: string
  try {
    content = readFileSync(gitPath, 'utf8')
  } catch {
    return null
  }
  const parse = parseGitfile(content, cwd)
  return parse.ok && parse.kind === 'worktree' ? parse.commonDir : null
}

/** One persisted worktree mapping (design D3's identity record). */
export interface WorktreeMapRecord {
  /** The worktree checkout this mapping belongs to (absolute session cwd). */
  cwd: string
  /** The CGC named context the worktree maps to (created under consent). */
  contextName: string
  /**
   * The recorded repository common directory (the main checkout's `.git`,
   * kept as detected — trailing `.git` included, never re-joined).
   */
  commonDir: string
  /** The recorded worktree id (the `.git/worktrees/<id>` store segment). */
  worktreeId: string
  /** Epoch ms of the first persistence. */
  createdAt: number
  /** Epoch ms of the last persistence. */
  updatedAt: number
}

/** On-disk shape of the worktree map file. */
interface WorktreeMapFileData {
  version: number
  records: WorktreeMapRecord[]
}

/** Resolution outcome for one workspace (the task 1.3 resolution surface). */
export type WorktreeMapResolutionStatus = 'not-worktree' | 'unmapped' | 'match' | 'mismatch'

export interface WorktreeMapResolution {
  /** The workspace that was resolved (the session cwd). */
  cwd: string
  /**
   * - `not-worktree` — the workspace is not a linked worktree; no worktree
   *   behavior applies.
   * - `unmapped` — the workspace is a linked worktree with no mapping yet.
   * - `match` — a recorded mapping's identity (repository common dir +
   *   worktree id) matches the live detection; `contextName` is usable.
   * - `mismatch` — a recorded mapping exists for this workspace but its
   *   identity no longer matches (different repository, missing worktree
   *   pointer, or a recreated context); fail-closed until re-consent.
   */
  status: WorktreeMapResolutionStatus
  /** The verified context name for `--context` injection; set only on `match`. */
  contextName: string | null
  /** The currently detected worktree identity (null for non-worktrees). */
  detected: WorktreeIdentity | null
  /** The persisted record checked during resolution, when one applied. */
  recorded: WorktreeMapRecord | null
  /** One-line human-readable outcome for diagnostics and notices. */
  reason: string | null
}

/**
 * Task 2.3's fail-closed tool-use surface: the per-workspace worktree
 * isolation block a caller (gate route, `/cgc` command handlers) must honor
 * before spawning ANY extension work. Null on the gate means worktree
 * isolation is not wired for the session (`off` mode) — callers then behave
 * exactly as before. `blocked` is true for every resolution that must not
 * consume or act on the mapped context: `mismatch` (identity no longer
 * matches — different repository, missing worktree pointer, recreated
 * context) and `unmapped` (no verified mapping yet, e.g. consent declined or
 * creation in flight). Fail-closed: without a verified `--context` a spawn
 * would silently fall into CGC's default context resolution — the
 * silently-wrong graph data D3 exists to prevent.
 */
export interface WorktreeIsolationBlock {
  /** True when the workspace's mapped context may NOT be used. */
  blocked: boolean
  /** The resolution that produced this block condition. */
  status: WorktreeMapResolutionStatus
  /** The mapped context (mismatch/corrupt-map cases); null otherwise. */
  contextName: string | null
  /** One-line reason for the block; null when not blocked. */
  reason: string | null
}

/** Outcome of persisting a mapping. */
export type WorktreeMapRecordStatus = 'recorded' | 'collision' | 'invalid' | 'unwritable'

export interface WorktreeMapRecordResult {
  status: WorktreeMapRecordStatus
  /** The persisted record; set when `status` is `recorded`. */
  record: WorktreeMapRecord | null
  /** One-line reason for `collision`, `invalid`, and `unwritable` outcomes. */
  reason: string | null
  /** The conflicting record when `status` is `collision` (wt- names are unique). */
  existing: WorktreeMapRecord | null
}

/** Outcome of removing a mapping. */
export type WorktreeMapRemoveStatus = 'removed' | 'absent' | 'unwritable'

export interface WorktreeMapRemoveResult {
  status: WorktreeMapRemoveStatus
  /** The record that was removed, when one was found. */
  record: WorktreeMapRecord | null
  /** One-line reason for `absent` and `unwritable` outcomes. */
  reason: string | null
}

/** Per-record identity verification outcome (the task 2.4 pruned surface). */
export type WorktreeRecordVerificationKind = 'match' | 'missing' | 'mismatch'

export interface WorktreeRecordVerification {
  /** The record that was verified against a fresh detection of its cwd. */
  record: WorktreeMapRecord
  /**
   * - `match` — the record's cwd still detects as the same worktree.
   * - `missing` — the record's cwd is gone or no longer a worktree (pruned /
   *   missing pointer); the mapping must not be used.
   * - `mismatch` — the record's cwd is a worktree with a different identity.
   */
  kind: WorktreeRecordVerificationKind
  /** One-line reason from the fresh detection. */
  reason: string
}

export interface WorktreeMapOptions {
  /**
   * The per-session worktree detector. Every identity check routes through it
   * (`detect()`), keeping the parse cache and the one-retry budget
   * single-sourced (task 1.3 gotchas).
   */
  detector: WorktreeDetector
  /** Test seam: map file name inside the common dir. Defaults to WORKTREE_MAP_FILE. */
  mapFileName?: string
  /** Test seam: clock for createdAt/updatedAt. Defaults to Date.now. */
  now?: () => number
}

/** Parsed state of one map file, as read by the session-scoped cache. */
interface CachedMapFile {
  /** Records when the file parsed cleanly; empty for an absent file. */
  records?: WorktreeMapRecord[]
  /** Set when the file exists but cannot be trusted (corrupt / unknown version). */
  corruptReason?: string
}

/**
 * Per-session worktree map (design D3, task 1.3).
 *
 * Records are identity triples `{context name, repository common dir, worktree
 * id}` persisted per repository in the common git directory — durable across
 * sessions and readable after a worktree checkout is pruned. Resolution
 * verifies a recorded identity against the live detector before a context may
 * be used again: mismatch (other repository, missing worktree pointer,
 * recreated context) resolves fail-closed to `mismatch` and blocks usage until
 * re-consent (task 2.3).
 *
 * One instance per Pi session (like the detector): the file-parse cache and
 * the in-session record index live exactly as long as the session. Fail-open
 * contract: `resolve`, `record`, `remove`, and `verifyRecord` never throw.
 * An unreadable or unsupported map file is never clobbered on write — the
 * extension prefers a visible "cannot verify" outcome over destroying unknown
 * content.
 */
export class WorktreeMap {
  private readonly detector: WorktreeDetector
  private readonly mapFileName: string
  private readonly now: () => number
  /** Per-session parse cache of map files, keyed by common dir. */
  private readonly files = new Map<string, CachedMapFile>()
  /**
   * Session-scoped index of every record seen this session, keyed by cwd. The
   * durable truth is the file; this only covers same-session lookups (e.g. a
   * record needed after its repo file became unreadable, or remove() without
   * a fresh detection).
   */
  private readonly byCwd = new Map<string, WorktreeMapRecord>()

  constructor(options: WorktreeMapOptions) {
    this.detector = options.detector
    this.mapFileName = options.mapFileName ?? WORKTREE_MAP_FILE
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Resolve the worktree mapping for a workspace, verifying any recorded
   * identity against the live detection. Fail-closed: a recorded mapping
   * whose identity no longer matches resolves to `mismatch` (never to
   * `match`), so no runner invocation can pick up a stale context. Never
   * throws and never writes.
   */
  resolve(sessionCwd: string): WorktreeMapResolution {
    const cwd = resolve(sessionCwd)
    const detection = this.detector.detect(cwd)

    if (!detection.isWorktree) {
      // Non-worktrees (main checkouts, non-git dirs, degraded pointers) never
      // map. A formerly-mapped checkout whose pointer vanished between
      // sessions cannot be located from here (its record file lives in the
      // common git dir); task 2.4's per-record verification names it via
      // `verifyRecord` on any later session inside the same repository.
      return {
        cwd,
        status: 'not-worktree',
        contextName: null,
        detected: null,
        recorded: null,
        reason: null,
      }
    }

    const identity = detection.identity
    if (identity === null) {
      // Unreachable with the real detector (isWorktree and identity are set
      // together), but a detector defect must fail open, not throw.
      return {
        cwd,
        status: 'not-worktree',
        contextName: null,
        detected: null,
        recorded: null,
        reason: null,
      }
    }

    const file = this.readFile(identity.commonDir)
    if (file.corruptReason !== undefined) {
      // An unreadable map cannot verify a mapping (fail-closed on anything
      // this session might still know; otherwise unmapped with a visible
      // reason so surfaces can explain why no mapping applies).
      const known = this.byCwd.get(cwd)
      if (known !== undefined) {
        return {
          cwd,
          status: 'mismatch',
          contextName: null,
          detected: identity,
          recorded: known,
          reason: `mapped context ${known.contextName} cannot be verified (worktree map file unreadable at ${this.pathFor(identity.commonDir)}: ${file.corruptReason}); blocked until re-consent`,
        }
      }
      return {
        cwd,
        status: 'unmapped',
        contextName: null,
        detected: identity,
        recorded: null,
        reason: `worktree map file unreadable (${file.corruptReason}); no mapping can be verified`,
      }
    }

    // The identity is the source of truth (names are user-editable, D3): a
    // record whose common dir AND worktree id both match is reusable even if
    // the checkout path drifted (a moved worktree keeps its id).
    const byIdentity = file.records?.find(
      (record) => record.commonDir === identity.commonDir && record.worktreeId === identity.id,
    )
    if (byIdentity !== undefined) {
      return {
        cwd,
        status: 'match',
        contextName: byIdentity.contextName,
        detected: identity,
        recorded: byIdentity,
        reason: `mapping verified: worktree "${identity.id}" of ${identity.commonDir} -> context ${byIdentity.contextName}`,
      }
    }

    // Same workspace, different identity: re-created or re-pointed worktree
    // (different repository or a fresh worktree id). Fail closed.
    const byCwd = file.records?.find((record) => record.cwd === cwd)
    if (byCwd !== undefined) {
      const difference =
        byCwd.commonDir !== identity.commonDir
          ? 'different repository'
          : `different worktree (recorded "${byCwd.worktreeId}", live "${identity.id}")`
      return {
        cwd,
        status: 'mismatch',
        contextName: null,
        detected: identity,
        recorded: byCwd,
        reason: `mapped context ${byCwd.contextName} no longer matches this workspace (${difference}); blocked until re-consent`,
      }
    }

    return {
      cwd,
      status: 'unmapped',
      contextName: null,
      detected: identity,
      recorded: null,
      reason: null,
    }
  }

  /**
   * Task 2.2's injection surface: the verified context name to carry as
   * `--context` on every runner invocation for `sessionCwd`, or null when no
   * mapping may be used. The name comes only from a `match` resolution — the
   * recorded identity verified against a live detection — and never from the
   * derived `wt-` name alone (identity, not the name, is the source of truth,
   * D3). Fail-closed: non-worktrees, unmapped, blocked (mismatch), and
   * corrupt-map workspaces all yield null. Because the mapping is persisted
   * only AFTER CGC confirmed the context, the creation window (isolator
   * status `creating`) resolves `unmapped` here and injects nothing. Never
   * throws and never writes.
   */
  contextFor(sessionCwd: string): string | null {
    const resolution = this.resolve(sessionCwd)
    return resolution.status === 'match' ? resolution.contextName : null
  }

  /**
   * Persist a mapping for a worktree workspace. The identity is taken from a
   * live detection of `sessionCwd` — the map never records an unverified
   * identity — so the workspace must currently be a linked worktree. Records
   * are keyed by the workspace cwd; re-recording the same cwd replaces its
   * mapping (the re-consent flow). `wt-` context names are unique within a
   * repository: recording a name already mapped by another workspace is a
   * structured `collision`. Never throws; unreadable map files are never
   * overwritten.
   */
  record(sessionCwd: string, contextName: string): WorktreeMapRecordResult {
    const cwd = resolve(sessionCwd)
    const name = contextName.trim()
    if (name.length === 0) {
      return {
        status: 'invalid',
        record: null,
        existing: null,
        reason: 'context name must not be empty',
      }
    }

    const detection = this.detector.detect(cwd)
    if (!detection.isWorktree || detection.identity === null) {
      return {
        status: 'invalid',
        record: null,
        existing: null,
        reason: `${cwd} is not a linked git worktree; only worktrees get mapped contexts`,
      }
    }
    const { commonDir, id } = detection.identity

    const file = this.readFile(commonDir)
    const collision = file.records?.find(
      (record) => record.contextName === name && record.cwd !== cwd,
    )
    if (collision !== undefined) {
      return {
        status: 'collision',
        record: null,
        existing: collision,
        reason: `context name ${name} is already mapped by ${collision.cwd}; wt- names are unique — choose another name or remove that mapping first`,
      }
    }
    if (file.corruptReason !== undefined) {
      return {
        status: 'unwritable',
        record: null,
        existing: null,
        reason: `refusing to overwrite an unreadable worktree map at ${this.pathFor(commonDir)} (${file.corruptReason})`,
      }
    }

    const now = this.now()
    const previous = file.records?.find((record) => record.cwd === cwd)
    const record: WorktreeMapRecord = {
      cwd,
      contextName: name,
      commonDir,
      worktreeId: id,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    const records = [...(file.records ?? []).filter((item) => item.cwd !== cwd), record]
    if (!this.writeFile(commonDir, records)) {
      return {
        status: 'unwritable',
        record: null,
        existing: null,
        reason: `could not persist the worktree map at ${this.pathFor(commonDir)}; the mapping is not recorded`,
      }
    }
    this.files.set(commonDir, { records })
    this.index(records)
    return {
      status: 'recorded',
      record,
      existing: null,
      reason: `recorded mapping: worktree "${id}" of ${commonDir} -> context ${name}`,
    }
  }

  /**
   * Remove the mapping recorded for a workspace. The record is located via
   * the session index or the live detection's repository; the file it lives
   * in (`record.commonDir`) is rewritten, so removal works even from a
   * different workspace of the same repository. Never throws.
   */
  remove(sessionCwd: string): WorktreeMapRemoveResult {
    const cwd = resolve(sessionCwd)
    const known = this.byCwd.get(cwd)
    if (known !== undefined) return this.removeRecord(known)

    const detection = this.detector.detect(cwd)
    if (detection.isWorktree && detection.identity !== null) {
      const file = this.readFile(detection.identity.commonDir)
      const record = file.records?.find((item) => item.cwd === cwd)
      if (record !== undefined) return this.removeRecord(record)
    }
    return {
      status: 'absent',
      record: null,
      reason: `no worktree mapping recorded for ${cwd}`,
    }
  }

  /**
   * All persisted records of one repository, by its common git dir. This is
   * the durable enumeration surface task 2.4 consumes for pruned notices —
   * paired with `verifyRecord` for per-record staleness. Never throws.
   */
  recordsForCommonDir(commonDir: string): readonly WorktreeMapRecord[] {
    const file = this.readFile(resolve(commonDir))
    return file.records ?? []
  }

  /**
   * Verify one persisted record against a fresh detection of its cwd. A
   * pruned worktree directory (or a missing pointer) verifies as `missing`;
   * a worktree whose identity changed verifies as `mismatch`. Never throws.
   */
  verifyRecord(record: WorktreeMapRecord): WorktreeRecordVerification {
    const detection = this.detector.detect(record.cwd)
    if (!detection.isWorktree || detection.identity === null) {
      return { record, kind: 'missing', reason: detection.message }
    }
    const identity = detection.identity
    if (identity.commonDir === record.commonDir && identity.id === record.worktreeId) {
      return {
        record,
        kind: 'match',
        reason: `worktree "${record.worktreeId}" of ${record.commonDir} still matches`,
      }
    }
    const difference =
      identity.commonDir !== record.commonDir
        ? 'different repository'
        : `different worktree id (recorded "${record.worktreeId}", live "${identity.id}")`
    return { record, kind: 'mismatch', reason: difference }
  }

  /**
   * Task 2.4's stale-worktree surface: verify every persisted record of one
   * repository in file order. `missing` results name records whose worktree
   * checkout no longer exists on disk (pruned); `match` records are live;
   * `mismatch` records exist under a changed identity. Consumers surface
   * one-time notices for `missing` results only — stale records stay in the
   * file, untouched (never autonomous deletion). Never throws.
   */
  verifyCommonDir(commonDir: string): readonly WorktreeRecordVerification[] {
    return this.recordsForCommonDir(commonDir).map((record) => this.verifyRecord(record))
  }

  /** Clear session-scoped caches (session shutdown / fresh session). */
  reset(): void {
    this.files.clear()
    this.byCwd.clear()
  }

  private index(records: readonly WorktreeMapRecord[]): void {
    for (const record of records) this.byCwd.set(record.cwd, record)
  }

  private removeRecord(record: WorktreeMapRecord): WorktreeMapRemoveResult {
    const file = this.readFile(record.commonDir)
    if (file.corruptReason !== undefined) {
      return {
        status: 'unwritable',
        record: null,
        reason: `refusing to rewrite an unreadable worktree map at ${this.pathFor(record.commonDir)} (${file.corruptReason})`,
      }
    }
    const records = (file.records ?? []).filter((item) => item.cwd !== record.cwd)
    if (!this.writeFile(record.commonDir, records)) {
      return {
        status: 'unwritable',
        record: null,
        reason: `could not persist the worktree map at ${this.pathFor(record.commonDir)}`,
      }
    }
    this.files.set(record.commonDir, { records })
    this.byCwd.delete(record.cwd)
    return { status: 'removed', record, reason: null }
  }

  private readFile(commonDir: string): CachedMapFile {
    const cached = this.files.get(commonDir)
    if (cached !== undefined) return cached
    const file = this.readFileOnce(commonDir)
    this.files.set(commonDir, file)
    if (file.records !== undefined) this.index(file.records)
    return file
  }

  private readFileOnce(commonDir: string): CachedMapFile {
    const path = this.pathFor(commonDir)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      // Absent file (or transiently unreadable): treat as empty, fail-open.
      return { records: [] }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch (error) {
      return { corruptReason: `invalid JSON (${errorText(error)})` }
    }
    if (!isPlainObject(parsed)) {
      return { corruptReason: 'expected a JSON object' }
    }
    if (parsed.version !== WORKTREE_MAP_VERSION) {
      return {
        corruptReason: `unsupported map version ${JSON.stringify(parsed.version)} (expected ${WORKTREE_MAP_VERSION})`,
      }
    }
    const raw = parsed.records
    if (!Array.isArray(raw)) {
      return { corruptReason: 'missing "records" array' }
    }
    for (const entry of raw) {
      if (!isValidRecord(entry)) {
        return { corruptReason: 'malformed record entry; refusing to guess' }
      }
    }
    return { records: raw as WorktreeMapRecord[] }
  }

  private writeFile(commonDir: string, records: WorktreeMapRecord[]): boolean {
    const path = this.pathFor(commonDir)
    const sorted = [...records].sort((a, b) => a.cwd.localeCompare(b.cwd))
    const body: WorktreeMapFileData = { version: WORKTREE_MAP_VERSION, records: sorted }
    try {
      // Write-then-rename so a torn write can never leave a half-parsed file.
      const tmp = `${path}.tmp`
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
      renameSync(tmp, path)
      return true
    } catch {
      return false
    }
  }

  private pathFor(commonDir: string): string {
    return join(commonDir, this.mapFileName)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Defensive whole-record validation: refuse to guess on malformed entries. */
function isValidRecord(value: unknown): value is WorktreeMapRecord {
  if (!isPlainObject(value)) return false
  for (const key of ['cwd', 'contextName', 'commonDir', 'worktreeId'] as const) {
    const field = value[key]
    if (typeof field !== 'string' || field.length === 0) return false
  }
  return (
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt)
  )
}

// --- Isolate-mode mapping (design D2, task 2.1) ---
//
// When `worktree.mode` is `isolate`, each linked worktree maps to a dedicated
// CGC named context named `wt-<worktree-id>`, created on demand via the
// documented `cgc context create <name>` verb behind the same auto-create
// consent gate as the lifecycle (config `lifecycle.autoCreate`). This section
// owns that creation flow: the `wt-` name generation/validation, the one-time
// consent + start of the background creation, and the settle step that records
// the mapping only after CGC confirmed the context (identity, not the name, is
// the source of truth — D3).
//
// Uniqueness is verified at two points, both structured:
//   - `WorktreeMap.record()` is the per-repository authority: it refuses a
//     name already mapped by another workspace of the same repository with a
//     structured `collision` (the `wt-` prefix is enforced HERE, not by the
//     map — task 1.3 gotchas).
//   - `cgc context create` exits 0 even when the name is already taken
//     (it prints "context '<name>' already exists"), so the extension cannot
//     trust the exit code: it detects the marker and refuses to adopt a
//     pre-existing context it cannot verify (fail-closed, design risk table).
//     Cleanup of any stray context stays user-driven (`/cgc_context delete`,
//     ADR-0006 — the tool is not part of this extension, so notices name it
//     only).

/** Context-name prefix for per-worktree contexts (design D2). */
export const WORKTREE_CONTEXT_PREFIX = 'wt-'

/** The documented cgc verb that creates named contexts (`cgc context create <name>`). */
export const CONTEXT_CREATE_VERB: readonly string[] = ['context', 'create']

/** Default time budget for one context creation spawn. */
export const DEFAULT_CONTEXT_CREATE_TIMEOUT_MS = 30_000

/**
 * Coarse marker for cgc's exit-0 "already exists" answer. Deliberately
 * broad and cheap: a false positive only turns a creation into a visible,
 * structured collision instead of a silent adopt — the safe direction.
 */
const CONTEXT_ALREADY_EXISTS_PATTERN = /already exists/i

/** Outcome of deriving a `wt-<worktree-id>` context name from a worktree id. */
export type WorktreeContextName = { ok: true; name: string } | { ok: false; reason: string }

/**
 * Derive the CGC named context for a worktree id: `wt-` + the id verbatim.
 *
 * The task-1.3 map deliberately does not enforce the prefix; this is the
 * single place the `wt-` naming contract lives (design D2). Validation is
 * defensive — ids come from the worktree store's final path segment, so they
 * are single segments by construction — and fails closed on anything that
 * would make the name ambiguous or unsafe for an argument-array spawn
 * (control characters; matched via a Unicode property so no control byte
 * ever appears in this source).
 */
export function buildWorktreeContextName(worktreeId: string): WorktreeContextName {
  if (worktreeId.length === 0) {
    return { ok: false, reason: 'worktree id is empty; no context name can be derived' }
  }
  if (worktreeId.includes('/') || worktreeId.includes('\\')) {
    return {
      ok: false,
      reason:
        'worktree id ' +
        JSON.stringify(worktreeId) +
        ' is not a single path segment; refusing to derive a context name',
    }
  }
  if (/[\p{Cc}]/u.test(worktreeId)) {
    return {
      ok: false,
      reason:
        'worktree id ' +
        JSON.stringify(worktreeId) +
        ' contains control characters; refusing to derive a context name',
    }
  }
  return { ok: true, name: WORKTREE_CONTEXT_PREFIX + worktreeId }
}

/** One-time user-facing notice produced by the isolate mapping flow. */
export interface WorktreeIsolateNotice {
  /**
   * - `worktree-declined` — the auto-create consent gate is closed; the
   *   worktree stays unmapped with enablement guidance.
   * - `worktree-creating` — consent granted; background context creation
   *   started.
   * - `worktree-collision` — the context name is already taken (CGC registry
   *   or another mapping of this repository); the mapping was NOT recorded.
   * - `worktree-degraded` — creation (or recording) could not be started or
   *   completed; the worktree stays unmapped with a manual path.
   */
  kind: 'worktree-declined' | 'worktree-creating' | 'worktree-collision' | 'worktree-degraded'
  /** Human-readable notice text (multi-line). */
  text: string
  /** When the notice was produced (epoch ms). */
  at: number
}

/** Outcome of one `ensureMapping` evaluation. */
export interface WorktreeIsolateOutcome {
  /** The workspace this evaluation applied to (the Pi session cwd). */
  cwd: string
  /**
   * - `not-worktree` — not a linked worktree; no isolation behavior applies.
   * - `reused` — a mapping exists with a verified identity; nothing is
   *   created (task 2.2 consumes `contextName` for `--context`).
   * - `blocked-mismatch` — the recorded identity no longer matches; fail
   *   closed, nothing is created or recorded (task 2.3 owns surfacing this).
   * - `declined` — the auto-create consent gate is closed; one-time guidance.
   * - `creating` — consent granted; background context creation is running.
   * - `degraded` — creation (or recording) could not be started; one-time
   *   notice with the reason and manual path.
   * - `already-done` — this workspace was already handled this session.
   */
  action:
    | 'not-worktree'
    | 'reused'
    | 'blocked-mismatch'
    | 'declined'
    | 'creating'
    | 'degraded'
    | 'already-done'
  /** True when this workspace was already handled earlier in this session. */
  repeated: boolean
  /** The `wt-<id>` name this workspace maps to, when derivable. */
  contextName: string | null
  /** The notice produced by this evaluation, if one was surfaced. */
  notice: WorktreeIsolateNotice | null
  /** True while consented context creation is in flight. */
  creating: boolean
  /** One-line diagnostics for `blocked-mismatch`, `degraded`, and `reused`. */
  reason: string | null
}

/** Where the isolate flow currently stands for a workspace (state for 3.1). */
export type WorktreeIsolateStatus =
  | 'unhandled'
  | 'reused'
  | 'blocked'
  | 'declined'
  | 'degraded'
  | 'creating'
  | 'created'
  | 'collision'
  | 'failed'

/** Recorded outcome of a settled context creation (state for 3.1). */
export interface WorktreeIsolateCreationResult {
  ok: boolean
  /** Structured runner outcome code (`OK`, `BUSY`, `TIMEOUT`, ...). */
  code: CgcCommandResult['code']
  /** Human-readable, single-line description of the outcome. */
  message: string
  durationMs: number
  /** When the run settled (epoch ms). */
  at: number
  /** The `wt-` name the creation flow targeted. */
  contextName: string | null
  /**
   * True when cgc answered (exit 0) that a context of this name already
   * exists; the mapping was NOT recorded (fail-closed adoption refusal).
   */
  alreadyExists: boolean
  /**
   * The conflicting persisted record when the map refused the name (a
   * structured `collision`); null otherwise.
   */
  conflictingRecord: WorktreeMapRecord | null
}

export interface WorktreeIsolatorOptions {
  /** The extension's single cgc runner; every spawn goes through it. */
  runner: CgcRunner
  /**
   * The per-session worktree detector (`detect()` only — the parse cache and
   * the one-retry budget stay single-sourced).
   */
  detector: WorktreeDetector
  /** The per-session worktree map (record() is the uniqueness authority). */
  map: WorktreeMap
  /**
   * The auto-create consent gate (config `lifecycle.autoCreate`, default
   * false). False means no context creation is started — the flow only
   * surfaces the one-time declined notice with enablement guidance.
   */
  autoCreate: boolean
  /**
   * Optional per-session maintenance budget. When supplied, consented
   * context creation consumes one slot; an exhausted budget degrades to a
   * notice instead of spawning (same posture as the unindexed path).
   */
  budget?: SessionInvocationBudget
  /** Time budget for one context creation spawn; defaults to 30s. */
  createTimeoutMs?: number
  /**
   * Sink for one-time notices (the eventual gate wires this to Pi's session
   * notification surface). When omitted, notices accumulate in `notices`.
   */
  onNotice?: (notice: WorktreeIsolateNotice) => void
}

/**
 * Per-session isolate-mode mapping flow (design D2, task 2.1).
 *
 * One instance per session (like the detector and the map); the one-time
 * markers live exactly as long as the session. `ensureMapping` is
 * synchronous and never blocks: consented creation is fire-and-forget
 * through the shared runner, mirroring the unindexed path's contract
 * (design D3 forbids awaiting cgc completion in gate paths). The mapping is
 * recorded ONLY after CGC confirmed the context exists — the map's
 * `record()` takes its identity from a live detection, so recording must
 * happen while the checkout still exists (task 1.3 gotchas); a record-time
 * `collision` surfaces as a structured error with the conflicting record.
 *
 * Fail-open contract: `ensureMapping` never throws; every outcome is
 * structured, and unreadable map files are never clobbered (the map's own
 * `unwritable` refusal is surfaced as a degraded outcome).
 */
export class WorktreeIsolator {
  private readonly runner: CgcRunner
  private readonly detector: WorktreeDetector
  private readonly map: WorktreeMap
  private readonly autoCreate: boolean
  private readonly budget: SessionInvocationBudget | undefined
  private readonly createTimeoutMs: number | undefined
  private readonly onNotice: ((notice: WorktreeIsolateNotice) => void) | undefined

  /** Workspaces already handled this session (one-time semantics). */
  private readonly handled = new Set<string>()
  /** Notices surfaced this session, in order. */
  private readonly noticeLog: WorktreeIsolateNotice[] = []
  /** Last outcome per workspace (diagnostics and tests). */
  private readonly outcomes = new Map<string, WorktreeIsolateOutcome>()
  /** In-flight context creation, keyed by workspace cwd. */
  private readonly inFlight = new Map<string, Promise<WorktreeIsolateCreationResult | null>>()
  /** Settled creation results, keyed by workspace cwd (state for 3.1). */
  private readonly results = new Map<string, WorktreeIsolateCreationResult>()
  /** Current status per workspace (state for 3.1). */
  private readonly statuses = new Map<string, WorktreeIsolateStatus>()

  constructor(options: WorktreeIsolatorOptions) {
    this.runner = options.runner
    this.detector = options.detector
    this.map = options.map
    this.autoCreate = options.autoCreate
    this.budget = options.budget
    this.createTimeoutMs = options.createTimeoutMs
    this.onNotice = options.onNotice
  }

  /** Notices surfaced so far this session (read-only view). */
  get notices(): readonly WorktreeIsolateNotice[] {
    return this.noticeLog
  }

  /** Current status for a workspace (`unhandled` if never seen). */
  status(cwd: string): WorktreeIsolateStatus {
    return this.statuses.get(cwd) ?? 'unhandled'
  }

  /** The last outcome for a workspace, if it was evaluated this session. */
  outcome(cwd: string): WorktreeIsolateOutcome | null {
    return this.outcomes.get(cwd) ?? null
  }

  /** The settled creation result for a workspace, if it has one. */
  result(cwd: string): WorktreeIsolateCreationResult | null {
    return this.results.get(cwd) ?? null
  }

  /** Whether consented context creation is currently in flight. */
  isCreating(cwd: string): boolean {
    return this.inFlight.has(cwd)
  }

  /** Resolves once consented context creation for the workspace settles. */
  whenCreated(cwd: string): Promise<WorktreeIsolateCreationResult | null> {
    return this.inFlight.get(cwd) ?? Promise.resolve(this.results.get(cwd) ?? null)
  }

  /**
   * Resolve the isolate mapping for a workspace, creating the `wt-<id>`
   * context on demand when consent is granted. Never throws and never
   * awaits cgc completion: background creation is fire-and-forget, its
   * outcome recorded when it settles. At most one notice and one creation
   * run per workspace per session.
   */
  ensureMapping(cwd: string): WorktreeIsolateOutcome {
    // One-time semantics: this workspace was already handled this session.
    if (this.handled.has(cwd)) {
      return this.finish({
        cwd,
        action: 'already-done',
        repeated: true,
        contextName: this.outcomes.get(cwd)?.contextName ?? null,
        notice: null,
        creating: this.isCreating(cwd),
        reason: null,
      })
    }
    this.handled.add(cwd)

    const detection = this.detector.detect(cwd)
    if (!detection.isWorktree || detection.identity === null) {
      // Main checkouts, non-git directories, and degraded pointers never map
      // (the detector's contract; zero isolation behavior for them).
      return this.finish({
        cwd,
        action: 'not-worktree',
        repeated: false,
        contextName: null,
        notice: null,
        creating: false,
        reason: null,
      })
    }

    const nameResult = buildWorktreeContextName(detection.identity.id)
    if (!nameResult.ok) {
      // Undetectable with the real detector (ids are single store segments),
      // but a hostile id must fail open with a visible reason, not spawn.
      const notice = this.emit({
        kind: 'worktree-degraded',
        text: buildWorktreeIsolateDegradedNotice(cwd, nameResult.reason),
      })
      this.statuses.set(cwd, 'degraded')
      return this.finish({
        cwd,
        action: 'degraded',
        repeated: false,
        contextName: null,
        notice,
        creating: false,
        reason: nameResult.reason,
      })
    }
    const contextName = nameResult.name

    const resolution = this.map.resolve(cwd)
    if (resolution.status === 'match') {
      // A recorded mapping with a verified identity: nothing to create. Task
      // 2.2 consumes the verified name for `--context` injection.
      this.statuses.set(cwd, 'reused')
      return this.finish({
        cwd,
        action: 'reused',
        repeated: false,
        contextName: resolution.contextName ?? contextName,
        notice: null,
        creating: false,
        reason: resolution.reason,
      })
    }
    if (resolution.status === 'mismatch') {
      // Fail closed: a recorded identity that no longer matches blocks ALL
      // creation and recording for this workspace until re-consent (D3).
      // Task 2.3 owns surfacing the identity-mismatch state; this flow only
      // guarantees nothing is created or recorded against it.
      this.statuses.set(cwd, 'blocked')
      return this.finish({
        cwd,
        action: 'blocked-mismatch',
        repeated: false,
        contextName,
        notice: null,
        creating: false,
        reason: resolution.reason,
      })
    }

    // From here: `unmapped` (or unmapped-with-corrupt-file reason from the
    // map) — creation is the only way to get a mapping, and it is
    // consent-gated exactly like the lifecycle's auto-create.
    if (!this.autoCreate) {
      const notice = this.emit({
        kind: 'worktree-declined',
        text: buildWorktreeIsolateDeclinedNotice(cwd, contextName),
      })
      this.statuses.set(cwd, 'declined')
      return this.finish({
        cwd,
        action: 'declined',
        repeated: false,
        contextName,
        notice,
        creating: false,
        reason: null,
      })
    }

    // Per-session maintenance budget: consented creation is capped
    // session-wide. A denial degrades to the notice path without spawning;
    // the slot is consumed on grant even if the start below fails (same
    // anti-hot-loop posture as the unindexed path).
    if (this.budget !== undefined) {
      const acquisition = this.budget.tryAcquire(cwd, 'worktree-context-create')
      if (!acquisition.granted) {
        const notice = this.emit({
          kind: 'worktree-degraded',
          text: buildWorktreeIsolateDegradedNotice(
            cwd,
            acquisition.reason ?? 'per-session cgc invocation budget exhausted',
          ),
        })
        this.statuses.set(cwd, 'degraded')
        return this.finish({
          cwd,
          action: 'degraded',
          repeated: false,
          contextName,
          notice,
          creating: false,
          reason: acquisition.reason,
        })
      }
    }

    // Consent gate open: create the context in the background (fire and
    // forget — design D3 forbids awaiting cgc completion in gate paths).
    const runOptions: CgcRunOptions = {
      args: [...CONTEXT_CREATE_VERB, contextName],
    }
    if (this.createTimeoutMs !== undefined) runOptions.timeoutMs = this.createTimeoutMs
    let started: Promise<CgcCommandResult>
    try {
      started = this.runner.run(cwd, runOptions)
    } catch (error) {
      // The runner only throws on caller contract violations; degrade to the
      // notice path rather than throwing out of a gate hook body.
      const reason = error instanceof Error ? error.message : String(error)
      const notice = this.emit({
        kind: 'worktree-degraded',
        text: buildWorktreeIsolateDegradedNotice(cwd, reason),
      })
      this.statuses.set(cwd, 'degraded')
      return this.finish({
        cwd,
        action: 'degraded',
        repeated: false,
        contextName,
        notice,
        creating: false,
        reason,
      })
    }

    this.emit({
      kind: 'worktree-creating',
      text: buildWorktreeIsolateCreatingNotice(cwd, contextName),
    })
    this.statuses.set(cwd, 'creating')

    const settled = this.settleCreation(cwd, contextName, started)
    // Safety net: the tracking promise is always consumed via `inFlight`; if
    // no consumer ever awaits it, the settlement must never surface as an
    // unhandled rejection.
    settled.catch(() => undefined)
    this.inFlight.set(cwd, settled)

    return this.finish({
      cwd,
      action: 'creating',
      repeated: false,
      contextName,
      notice: null,
      creating: true,
      reason: null,
    })
  }

  /** Clear all per-session state (session shutdown / fresh session). */
  reset(): void {
    this.handled.clear()
    this.noticeLog.length = 0
    this.outcomes.clear()
    this.results.clear()
    this.statuses.clear()
    this.inFlight.clear()
  }

  /**
   * Settle a background context creation: record the mapping only after CGC
   * confirmed the context exists, and refuse (structurally) any name that is
   * already taken — whether by another mapping of this repository (`record`
   * collision, with the conflicting record) or by CGC itself (exit-0
   * "already exists", detected from the marker because cgc cannot be trusted
   * to fail). Never rejects; failures are captured into the result surface.
   */
  private settleCreation(
    cwd: string,
    contextName: string,
    started: Promise<CgcCommandResult>,
  ): Promise<WorktreeIsolateCreationResult | null> {
    const settled: Promise<WorktreeIsolateCreationResult | null> = (async () => {
      let result: CgcCommandResult
      try {
        result = await started
      } catch (error) {
        // Unreachable with the current runner (it resolves runtime failures),
        // but a gate surface must never reject: capture and fail open.
        result = {
          ok: false,
          code: 'COMMAND_FAILED',
          message:
            'context creation failed unexpectedly: ' +
            (error instanceof Error ? error.message : String(error)),
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          truncated: false,
          durationMs: 0,
          argv: [...CONTEXT_CREATE_VERB, contextName],
          cwd,
        }
      }

      let settledResult: WorktreeIsolateCreationResult
      if (!result.ok) {
        // The spawn itself failed (unavailable binary, timeout, busy, ...):
        // no context was created, nothing is recorded.
        settledResult = {
          ok: false,
          code: result.code,
          message: result.message,
          durationMs: result.durationMs,
          at: Date.now(),
          contextName,
          alreadyExists: false,
          conflictingRecord: null,
        }
        this.statuses.set(cwd, 'failed')
        this.emit({
          kind: 'worktree-degraded',
          text: buildWorktreeIsolateDegradedNotice(cwd, result.message),
        })
      } else if (CONTEXT_ALREADY_EXISTS_PATTERN.test(`${result.stdout}\n${result.stderr}`)) {
        // cgc answers "already exists" with exit 0 — structurally ambiguous.
        // The name is taken by something this repository's map does not own,
        // so adopting it would risk silently mixing graphs (the design's
        // central danger). Refuse; the user resolves via the notice's path.
        settledResult = {
          ok: false,
          code: result.code,
          message:
            'CGC already has a context named ' +
            JSON.stringify(contextName) +
            '; refusing to adopt an unverified context',
          durationMs: result.durationMs,
          at: Date.now(),
          contextName,
          alreadyExists: true,
          conflictingRecord: null,
        }
        this.statuses.set(cwd, 'collision')
        this.emit({
          kind: 'worktree-collision',
          text: buildWorktreeIsolateCollisionNotice(cwd, contextName, null),
        })
      } else {
        // The context exists under this name and is freshly ours: persist the
        // mapping. `record()` is the per-repository uniqueness authority and
        // takes its identity from a LIVE detection (task 1.3 gotchas).
        const recorded = this.map.record(cwd, contextName)
        if (recorded.status === 'recorded') {
          settledResult = {
            ok: true,
            code: result.code,
            message: recorded.reason ?? `mapped worktree ${cwd} -> context ${contextName}`,
            durationMs: result.durationMs,
            at: Date.now(),
            contextName,
            alreadyExists: false,
            conflictingRecord: null,
          }
          this.statuses.set(cwd, 'created')
        } else if (recorded.status === 'collision') {
          // Another workspace of this repository already mapped the name: the
          // structured collision surfaces the conflicting record. The context
          // we just created is surplus; cleanup stays user-driven (the
          // notice names `/cgc_context delete` only — ADR-0006).
          settledResult = {
            ok: false,
            code: result.code,
            message:
              recorded.reason ??
              `context name ${JSON.stringify(contextName)} is already mapped by another workspace`,
            durationMs: result.durationMs,
            at: Date.now(),
            contextName,
            alreadyExists: false,
            conflictingRecord: recorded.existing,
          }
          this.statuses.set(cwd, 'collision')
          this.emit({
            kind: 'worktree-collision',
            text: buildWorktreeIsolateCollisionNotice(cwd, contextName, recorded.existing),
          })
        } else {
          // `unwritable` (unreadable/unsupported map file — never clobbered)
          // or `invalid` (impossible here: detection verified the worktree).
          // The context exists in CGC but no mapping was persisted.
          settledResult = {
            ok: false,
            code: result.code,
            message:
              recorded.reason ??
              `mapping for ${JSON.stringify(contextName)} could not be persisted`,
            durationMs: result.durationMs,
            at: Date.now(),
            contextName,
            alreadyExists: false,
            conflictingRecord: null,
          }
          this.statuses.set(cwd, 'failed')
          this.emit({
            kind: 'worktree-degraded',
            text: buildWorktreeIsolateDegradedNotice(cwd, settledResult.message),
          })
        }
      }

      this.results.set(cwd, settledResult)
      this.inFlight.delete(cwd)
      return settledResult
    })()
    return settled
  }

  /** Record the outcome, then hand it back (single place for tests). */
  private finish(outcome: WorktreeIsolateOutcome): WorktreeIsolateOutcome {
    // A later `already-done` re-evaluation never clobbers the first
    // meaningful outcome (downstream surfaces read the original decision).
    if (outcome.action !== 'already-done' || !this.outcomes.has(outcome.cwd)) {
      this.outcomes.set(outcome.cwd, outcome)
    }
    return outcome
  }

  private emit(input: Omit<WorktreeIsolateNotice, 'at'>): WorktreeIsolateNotice {
    const notice: WorktreeIsolateNotice = { ...input, at: Date.now() }
    this.noticeLog.push(notice)
    // The sink is user-supplied; a throwing callback must not break the flow.
    try {
      this.onNotice?.(notice)
    } catch {
      // Fail-open: the notice is still recorded in the log.
    }
    return notice
  }
}

/**
 * Build the runner's per-session `--context` resolution hook (task 2.2) from
 * a session's worktree map. The runner consults it synchronously once per
 * invocation; the map's per-session caches (detector parse + map file) keep
 * the identity check single-sourced, and the one shared runner deduplicates
 * on the final argv. A verified `match` identity yields the name; everything
 * else (unmapped, mismatch, non-worktree, corrupt map) yields null.
 */
export function worktreeContextResolver(map: WorktreeMap): RunnerContextResolver {
  return (sessionCwd: string) => map.contextFor(sessionCwd)
}

/**
 * The one-time identity-mismatch notice (task 2.3, D3): a recorded mapping
 * exists for the workspace but its identity no longer matches the live
 * detection (different repository, missing worktree pointer, or a context
 * recreated against another workspace). The extension took no further
 * action for that workspace — indexing, syncing, and tool use are blocked
 * until the user re-consents — and this text explains why and how. Naming
 * the user-driven cleanup verb is deliberate (ADR-0006: the `/cgc_context`
 * tool is not part of this extension — notices name it only).
 */
export function buildWorktreeIdentityMismatchNotice(
  cwd: string,
  contextName: string | null,
  reason: string | null,
): string {
  const mapped =
    contextName === null || contextName.length === 0
      ? 'the mapped context'
      : `context \`${contextName}\``
  return [
    'CGC: worktree identity mismatch — ' +
      mapped +
      ' no longer matches the worktree at ' +
      cwd +
      ' (' +
      (reason ?? 'recorded identity does not match the live worktree') +
      ').',
    'Fail-closed: no extension indexing, syncing, or tool use runs against that context until you re-consent; the session proceeds without silently-wrong graph data.',
    'If the environment changed permanently, remove the stale `wt-` context with `/cgc_context delete` (its own confirmation) and start a new session in this worktree to map it fresh.',
  ].join('\n')
}

/**
 * The one-time stale-worktree notice (task 2.4, D4): a recorded mapping's
 * worktree checkout no longer exists on disk (pruned), so the mapping can
 * never be used again. The notice names the orphaned context and the
 * user-driven cleanup command; the extension takes NO autonomous action and
 * never deletes registrations or database files. Naming the cleanup verb is
 * deliberate (ADR-0006: the `/cgc_context` tool is not part of this
 * extension — notices name it only).
 */
export function buildWorktreePrunedNotice(
  record: WorktreeMapRecord,
  verification: WorktreeRecordVerification,
): string {
  return [
    'CGC: worktree "' +
      record.worktreeId +
      '" of ' +
      record.commonDir +
      ' no longer exists (last seen at ' +
      record.cwd +
      '), so its isolated context `' +
      record.contextName +
      '` is orphaned (' +
      (verification.reason ?? 'worktree checkout is gone on disk') +
      ').',
    'Nothing was deleted: the extension never removes context registrations or database files on its own.',
    'To clean up, remove the orphaned context with `/cgc_context delete` (its own confirmation); the stale mapping record stays in the worktree map and can no longer match any live worktree.',
  ].join('\n')
}

/** The one-time declined notice (auto-create consent gate closed). */
export function buildWorktreeIsolateDeclinedNotice(cwd: string, contextName: string): string {
  return [
    'CGC: worktree isolation is enabled (worktree.mode=isolate) but context creation is opt-in and was not performed for ' +
      cwd +
      '.',
    'This worktree would map to the named context `' +
      contextName +
      '`; without it, no extension indexing or syncing runs for this worktree.',
    'To enable automatic creation, set "lifecycle": { "autoCreate": true } in .pi/cgc.json (project) or ~/.pi/agent/cgc.json (global), or set CGC_LIFECYCLE_AUTO_CREATE=1.',
    'To map it manually, run `cgc context create ' +
      contextName +
      '` once; the mapping is picked up on the next session (or index now with `cgc index . --context ' +
      contextName +
      '`).',
  ].join('\n')
}

/** The one-time notice that consented background creation has started. */
export function buildWorktreeIsolateCreatingNotice(cwd: string, contextName: string): string {
  return [
    'CGC: creating the isolated context `' +
      contextName +
      '` for the worktree at ' +
      cwd +
      ' in the background (worktree.mode=isolate).',
    'Once created, indexing and maintenance for this worktree run against this context alone.',
  ].join('\n')
}

/**
 * The one-time collision notice: the name is taken by another mapping of
 * this repository (`conflicting` record present) or by CGC itself (null).
 * Names the user-driven cleanup command without invoking it (ADR-0006: the
 * `/cgc_context` tool is not part of this extension — the notice names it
 * only).
 */
export function buildWorktreeIsolateCollisionNotice(
  cwd: string,
  contextName: string,
  conflicting: WorktreeMapRecord | null,
): string {
  if (conflicting !== null) {
    return [
      'CGC: context name `' +
        contextName +
        '` is already mapped by another workspace (' +
        conflicting.cwd +
        '); the mapping for ' +
        cwd +
        ' was NOT recorded.',
      'The freshly created context was not adopted, so it is surplus. To resolve, remove the surplus context with `/cgc_context delete` (its own confirmation) or free the name by removing the other mapping first.',
    ].join('\n')
  }
  return [
    'CGC: context `' +
      contextName +
      "` already exists in the CGC registry, so it cannot be verified as this worktree's own; the mapping for " +
      cwd +
      ' was NOT created.',
    'The extension never adopts an unverified context (identity, not the name, is the source of truth). To proceed, remove the existing context with `/cgc_context delete` (its own confirmation) and start a new session.',
  ].join('\n')
}

/** The one-time degraded notice (creation or recording could not complete). */
export function buildWorktreeIsolateDegradedNotice(cwd: string, reason: string): string {
  return [
    'CGC: the isolated context for the worktree at ' +
      cwd +
      ' could not be created (' +
      reason +
      '); no mapping was recorded.',
    'The session proceeds without worktree isolation for this workspace. Enable lifecycle.autoCreate, or create the context manually with `cgc context create` and start a new session.',
  ].join('\n')
}

/**
 * Project a map resolution onto the fail-closed block surface (task 2.3):
 * non-worktrees (main checkouts, non-git dirs) and verified `match`
 * resolutions are NOT blocked; every other resolution (`mismatch`, and
 * `unmapped` — consent declined, creation in flight, corrupt map) blocks
 * spawning surface work that would otherwise lose its `--context`.
 */
export function worktreeIsolationBlockOf(
  resolution: WorktreeMapResolution,
): WorktreeIsolationBlock {
  const blocked = resolution.status !== 'not-worktree' && resolution.status !== 'match'
  return {
    blocked,
    status: resolution.status,
    contextName: resolution.contextName ?? resolution.recorded?.contextName ?? null,
    reason: resolution.reason,
  }
}
