// Session-scoped output spill (task 1.4 of
// openspec/changes/add-cgc-output-token-economy, design D3).
//
// When the delivered output is truncated and `output.spillToTemp` is enabled,
// the runner writes the FULL captured stream to a file under a per-session
// directory in the OS temp location — never the workspace — names that path in
// the truncation marker, and removes the directory on every session teardown
// path (cleanup.ts's `session_shutdown` hook, the process `exit` handler, and
// signal interception).
//
// The directory is created lazily, only once something is actually spilled,
// and carries restrictive owner-only permissions (0700 directory, 0600 file)
// where the platform supports them. Every filesystem operation is fail-open: a
// spill defect degrades to "no path in the marker" and never fails the
// invocation (spec scenario "Policy error is contained").

import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Restrictive directory permission bits (owner-only) where supported. */
const DIR_MODE = 0o700
/** Restrictive file permission bits (owner-only) where supported. */
const FILE_MODE = 0o600

/** Options for a {@link SpillSession}. */
export interface SpillSessionOptions {
  /**
   * Base directory under which the session spill directory is created;
   * defaults to the OS temp location. NEVER the workspace (design D3) — this
   * is a test seam, not a placement override for callers.
   */
  baseDir?: string
  /** Directory-name prefix (diagnosability / test seam). */
  prefix?: string
  /**
   * Session identifier embedded in the directory name; defaults to
   * `pid-<random>`, unique enough that two sessions never share a directory.
   */
  id?: string
}

/**
 * One capture stream's spill sink (design D3). Chunks arrive as they are
 * produced; they are retained in memory only until the stream crosses the
 * truncation threshold, then written to a file. A stream that never crosses
 * the threshold is discarded without ever touching disk, so the common
 * (untruncated) invocation creates no temp file at all.
 *
 * The writer is deliberately synchronous: the runner resolves the invocation
 * synchronously and every teardown path (including `process` `exit`) can only
 * do synchronous work, so the file is fully on disk before its path is named.
 */
export class SpillWriter {
  private fd: number | null = null
  private path: string | null = null
  private failed = false
  private lastError: string | null = null
  private readonly buffered: Buffer[] = []
  private bufferedBytes = 0

  constructor(
    private readonly session: SpillSession,
    private readonly label: string,
    private readonly thresholdBytes: number,
  ) {}

  /**
   * Sink for the capture buffer: every chunk of the stream arrives here.
   * Buffers below the truncation threshold; spills to disk at or above it.
   * Never throws (fail-open).
   */
  readonly sink = (chunk: Buffer): void => {
    if (this.failed) return
    try {
      if (this.fd === null) {
        if (this.bufferedBytes + chunk.length < this.thresholdBytes) {
          this.buffered.push(chunk)
          this.bufferedBytes += chunk.length
          return
        }
        this.open()
      }
      if (this.fd !== null) writeSync(this.fd, chunk)
    } catch (error) {
      this.fail(error)
    }
  }

  /** The spill file path, or null until a file has actually been created. */
  get filePath(): string | null {
    return this.path
  }

  /**
   * The message of the last fail-open spill error, or null when the spill has
   * not (yet) failed. Task 1.7 exposes this so the runner can RECORD a spill
   * write failure on the invocation result while still delivering best-effort
   * output (spec scenario "Policy error is contained").
   */
  get error(): string | null {
    return this.lastError
  }

  /**
   * Keep the spill: flush everything seen so far and return the file path.
   * Returns undefined when the spill could not be written — the marker then
   * carries no path (the spec's fail-open scenario).
   */
  commit(): string | undefined {
    if (this.failed) return undefined
    try {
      if (this.fd === null) this.open()
      this.close()
      return this.path ?? undefined
    } catch (error) {
      this.fail(error)
      return undefined
    }
  }

  /** Drop the spill: close and delete the file, if any was created. */
  discard(): void {
    this.close()
    this.buffered.length = 0
    this.bufferedBytes = 0
    this.unlinkQuietly()
  }

  private open(): void {
    const path = this.session.nextFilePath(this.label)
    const fd = openSync(path, 'w', FILE_MODE)
    this.fd = fd
    this.path = path
    for (const chunk of this.buffered) writeSync(fd, chunk)
    this.buffered.length = 0
    this.bufferedBytes = 0
  }

  private close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {
        // Already closed / never opened; nothing to do.
      }
      this.fd = null
    }
  }

  private fail(error?: unknown): void {
    this.failed = true
    if (error !== undefined && this.lastError === null) {
      this.lastError = error instanceof Error ? error.message : String(error)
    }
    this.close()
    this.buffered.length = 0
    this.bufferedBytes = 0
    this.unlinkQuietly()
  }

  private unlinkQuietly(): void {
    const path = this.path
    this.path = null
    if (path !== null) {
      try {
        rmSync(path, { force: true })
      } catch {
        // Best effort: the session directory removal is the backstop.
      }
    }
  }
}

/**
 * The per-session spill directory (design D3). Owns lazily-created writers and
 * can remove the directory and all of its files in one fail-open sweep, which
 * is what the session teardown paths invoke.
 */
export class SpillSession {
  private readonly baseDir: string
  private readonly prefix: string
  private readonly id: string
  private directory: string | null = null
  private sequence = 0
  private readonly writers = new Set<SpillWriter>()

  constructor(options: SpillSessionOptions = {}) {
    this.baseDir = options.baseDir ?? tmpdir()
    this.prefix = options.prefix ?? 'pi-cgc-spill'
    this.id = options.id ?? `${process.pid}-${randomUUID().slice(0, 8)}`
  }

  /** The session directory path, or null until something has been spilled. */
  get directoryPath(): string | null {
    return this.directory
  }

  /** Create a writer for one capture stream; nothing touches disk yet. */
  createWriter(label: string, thresholdBytes: number): SpillWriter {
    const writer = new SpillWriter(this, label, thresholdBytes)
    this.writers.add(writer)
    return writer
  }

  /** Ensure the session directory exists under the OS temp location. */
  ensureDirectory(): string {
    if (this.directory !== null) return this.directory
    const directory = join(this.baseDir, `${this.prefix}-${this.id}`)
    mkdirSync(directory, { recursive: true, mode: DIR_MODE })
    try {
      chmodSync(directory, DIR_MODE)
    } catch {
      // Mode bits are unsupported on some platforms (e.g. Windows); the
      // directory still exists and is still outside the workspace.
    }
    this.directory = directory
    return directory
  }

  /** A unique file path within the session directory for one spill. */
  nextFilePath(label: string): string {
    const directory = this.ensureDirectory()
    this.sequence += 1
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '-')
    return join(directory, `spill-${safeLabel}-${this.sequence}.log`)
  }

  /**
   * Remove the session directory and every spill file in it. Closes any open
   * writers first, then deletes recursively. Idempotent and fail-open.
   */
  remove(): void {
    for (const writer of [...this.writers]) writer.discard()
    this.writers.clear()
    const directory = this.directory
    this.directory = null
    if (directory !== null) {
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch {
        // The individual writers already unlinked; the directory may linger
        // empty on a locked platform. Never throw into a teardown path.
      }
    }
  }
}
