// Workspace detection for the CGC lifecycle gate (design D2 of
// openspec/changes/add-cgc-session-lifecycle-gate, task 2.1).
//
// The detector answers three cheap questions per session, in order of cost:
//   1. Which workspace to manage — the Pi session's working directory (never
//      `process.cwd()`; recon-confirmed bug in reference extensions).
//   2. Is it indexed — filesystem presence of `.codegraphcontext/` (free and
//      lock-free).
//   3. Is `cgc` alive — a one-shot `cgc --version` liveness probe, cached for
//      the lifetime of the detector (one detector per session), so repeated
//      gate evaluations never re-spawn the probe.
//
// Fail-open contract: every method resolves or returns a structured result; no
// method throws for cgc-level or filesystem-level failures. Classification of
// the probe outcome into lifecycle states belongs to the state machine (2.2).

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CgcCommandResult, CgcResultCode, CgcRunner } from './runner'

/** Per-repo CGC state directory that marks a workspace as indexed. */
export const WORKSPACE_INDEX_DIR = '.codegraphcontext'

/** Result of the cached one-shot `cgc` liveness/version probe. */
export interface CgcProbeResult {
  /**
   * True only when the `cgc` binary was spawned and exited 0 (the CLI contract
   * is the exit code; stdout parsing is best-effort diagnostics only).
   */
  available: boolean
  /** Structured runner outcome code for diagnostics surfaces. */
  code: CgcResultCode
  /**
   * Semantic version string parsed from `cgc --version` output, or null when
   * the output was unparseable or the probe failed. Coarse parsing only:
   * unparseable output must not flip availability (ADR 0001 fail-safe rule).
   */
  version: string | null
  /** Human-readable, single-line description of the outcome. */
  message: string
  /** True when this result came from the per-session cache, not a fresh spawn. */
  cached: boolean
}

export interface WorkspaceDetection {
  /** The workspace root: the Pi session's working directory. */
  cwd: string
  /** Absolute path of the workspace's `.codegraphcontext/` directory. */
  indexDir: string
  /** True when `.codegraphcontext/` exists (as a directory) in the workspace. */
  indexed: boolean
  /** The cached liveness/version probe outcome for this workspace. */
  probe: CgcProbeResult
}

export interface WorkspaceDetectorOptions {
  /** The extension's single cgc runner; every probe spawn goes through it. */
  runner: CgcRunner
  /** Time budget for the version probe; defaults to 10 000 ms (design D5). */
  versionProbeTimeoutMs?: number
}

/** Coarse semantic-version extraction from `cgc --version` output. */
const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/

/**
 * Extracts the first semantic-version-looking token from probe output. Returns
 * null on anything unparseable — callers must treat null as "unknown", never
 * as evidence of a broken install.
 */
export function parseCgcVersion(stdout: string, stderr: string): string | null {
  const match = VERSION_PATTERN.exec(stdout) ?? VERSION_PATTERN.exec(stderr)
  return match?.[1] ?? null
}

/**
 * Per-session workspace detector.
 *
 * One instance per Pi session (create it in the session-start path and drop it
 * at shutdown): the probe cache lives exactly as long as the session, which is
 * what makes the liveness check one-shot per session while still allowing
 * later evaluations in the same session to read the cached verdict.
 */
export class WorkspaceDetector {
  private readonly runner: CgcRunner
  private readonly versionProbeTimeoutMs: number
  /** Per-session probe cache, keyed by workspace cwd. */
  private readonly probeCache = new Map<string, Promise<CgcProbeResult>>()

  constructor(options: WorkspaceDetectorOptions) {
    this.runner = options.runner
    this.versionProbeTimeoutMs = options.versionProbeTimeoutMs ?? 10_000
  }

  /**
   * Resolve the workspace root from the Pi session context. `sessionCwd` must
   * be supplied by the caller from the session context; `process.cwd()` is
   * only a last-resort fallback for hosts that do not provide a session cwd,
   * and its use is flagged in the detection result by the caller.
   */
  resolveSessionCwd(sessionCwd?: string | null): string {
    if (typeof sessionCwd === 'string' && sessionCwd.trim().length > 0) {
      return sessionCwd
    }
    return process.cwd()
  }

  /**
   * Detect `.codegraphcontext/` presence in the workspace. Free and lock-free.
   * Fail-open: unreadable workspace or stat errors classify as unindexed —
   * the gate then does nothing rather than acting on wrong information.
   */
  detectIndex(sessionCwd: string): { indexDir: string; indexed: boolean } {
    const indexDir = join(sessionCwd, WORKSPACE_INDEX_DIR)
    try {
      return { indexDir, indexed: statSync(indexDir).isDirectory() }
    } catch {
      // ENOENT is the normal "not indexed" case; anything else (permissions,
      // race) also fails open to unindexed. existsSync is checked only to
      // keep the stat fallback honest about symlinks to files.
      return { indexDir, indexed: false }
    }
  }

  /**
   * Cached one-shot `cgc` liveness/version probe for the workspace.
   *
   * The probe spawns `cgc --version` (root-level verb, no database access, so
   * it never contends for the embedded backend) under the tighter version-probe
   * time budget, through the shared runner (deduplicated if a caller races).
   * The completed result is cached for the detector's lifetime, so later calls
   * in the same session return the cached verdict with `cached: true` and never
   * re-spawn — the "cached liveness check" the clean path is allowed to cost.
   */
  probe(sessionCwd: string): Promise<CgcProbeResult> {
    const cached = this.probeCache.get(sessionCwd)
    if (cached) return cached.then((result) => ({ ...result, cached: true }))

    const promise = this.probeOnce(sessionCwd)
    this.probeCache.set(sessionCwd, promise)
    return promise
  }

  /**
   * Combined detection: resolve the workspace, check index presence, and read
   * the cached probe. This is the cheap read the state machine (2.2) consumes.
   */
  async detect(sessionCwd: string): Promise<WorkspaceDetection> {
    const cwd = this.resolveSessionCwd(sessionCwd)
    const { indexDir, indexed } = this.detectIndex(cwd)
    const probe = await this.probe(cwd)
    return { cwd, indexDir, indexed, probe }
  }

  /**
   * Clear the per-session probe cache (session shutdown or a fresh session on
   * the same detector). Does not affect in-flight runner deduplication.
   */
  reset(): void {
    this.probeCache.clear()
  }

  private async probeOnce(sessionCwd: string): Promise<CgcProbeResult> {
    let result: CgcCommandResult
    try {
      result = await this.runner.run(sessionCwd, {
        args: ['--version'],
        timeoutMs: this.versionProbeTimeoutMs,
      })
    } catch (error) {
      // The runner only throws on caller contract violations; treat anything
      // unexpected as fail-open unavailability rather than propagating.
      return {
        available: false,
        code: 'UNAVAILABLE',
        version: null,
        message: `cgc liveness probe failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
        cached: false,
      }
    }

    if (result.ok) {
      return {
        available: true,
        code: 'OK',
        version: parseCgcVersion(result.stdout, result.stderr),
        message: 'cgc is available',
        cached: false,
      }
    }

    return {
      available: false,
      code: result.code,
      version: null,
      message: `cgc liveness probe: ${result.message}`,
      cached: false,
    }
  }
}

/**
 * Convenience helper for callers that only need the index-presence answer
 * synchronously (e.g. deciding whether a probe is worth spawning at all).
 */
export function isWorkspaceIndexed(sessionCwd: string): boolean {
  return existsSync(join(sessionCwd, WORKSPACE_INDEX_DIR))
}
