// Five-state lifecycle classifier (design D2 of
// openspec/changes/add-cgc-session-lifecycle-gate, task 2.2).
//
// Classifies the active workspace into exactly one of the five lifecycle
// states: `unavailable` (no usable `cgc` binary), `unindexed` (no
// `.codegraphcontext/` directory), `busy` (another CGC process holds the
// embedded database), `corrupt`, or the `clean`/`drift` pair.
//
// Inputs, cheapest first (design D2):
//   1. The cached one-shot `cgc --version` liveness probe (task 2.1) —
//      distinguishes `unavailable`.
//   2. Filesystem presence of `.codegraphcontext/` — distinguishes `unindexed`.
//   3. A bounded `cgc stats` health probe — distinguishes busy / clean /
//      drift / corrupt. Runs once per classifier (per session) and is cached;
//      every spawn goes through the shared runner (deduplicated, budgeted,
//      abortable, bounded output).
//
// Fail-safe contract (ADR 0001, design D2 risk table): only exit codes and
// coarse output markers are parsed. Any probe outcome that does not yield a
// definite verdict — unparseable output, non-zero exit without lock markers,
// timeout, cancellation — maps onto the fail-safe `corrupt` bucket
// ("corrupt-adjacent unknown"): the corrupt path never takes a destructive
// action without explicit confirmation, so a misclassification here can only
// cause a harmless prompt, never data loss or a busy fight. The classification
// never maps to `drift` on uncertainty, because drift is the one state that
// triggers automatic maintenance work (task 2.4).
//
// Fail-open contract: `classify` never throws; unexpected internal errors are
// captured into the reported state (as `unavailable` — the canonical
// "do nothing, proceed" state) with the error in the reason.

import type { CgcRunner } from './runner'
import type { CgcProbeResult, WorkspaceDetector } from './workspace'

/** The five lifecycle states; `clean` and `drift` form the healthy pair. */
export type LifecycleState = 'unavailable' | 'unindexed' | 'busy' | 'corrupt' | 'clean' | 'drift'

/** Verdict extracted from a health probe's captured output. */
export type HealthVerdict = 'clean' | 'drift' | 'corrupt' | 'unparseable'

export interface HealthParse {
  verdict: HealthVerdict
  /** Marker categories that matched; empty for `unparseable`. Diagnostics only. */
  matched: string[]
}

export interface HealthProbeResult {
  /** True only when the probe command exited 0. */
  ok: boolean
  /** Structured runner outcome code. */
  code: string
  /** Parsed verdict; null when the probe produced no output to parse at all. */
  parse: HealthParse | null
  /** Human-readable, single-line description of the outcome. */
  message: string
  /** True when the capture cap dropped earlier output bytes. */
  truncated: boolean
  durationMs: number
  /** True when this result came from the per-session cache, not a fresh spawn. */
  cached: boolean
}

export interface LifecycleClassification {
  /** The workspace root the classification applies to (the Pi session cwd). */
  cwd: string
  /** The classified lifecycle state. */
  state: LifecycleState
  /** Whether `.codegraphcontext/` was present at classification time. */
  indexed: boolean
  /** The cached liveness/version probe outcome backing the classification. */
  probe: CgcProbeResult
  /** The health-probe outcome, when one was run (indexed + available only). */
  health: HealthProbeResult | null
  /** Human-readable, single-line reason for the classification. */
  reason: string
  /** Classification timestamp (epoch ms). */
  at: number
}

export interface LifecycleClassifierOptions {
  /** The session's workspace detector (owns the cached liveness probe). */
  detector: WorkspaceDetector
  /** The extension's single cgc runner; the health probe spawns through it. */
  runner: CgcRunner
  /**
   * Time budget for the health probe; defaults to 30 000 ms (the runner's
   * default command budget, design D5).
   */
  healthProbeTimeoutMs?: number
  /**
   * Arguments for the health probe; defaults to `['stats']` run with
   * `cwd` set to the session working directory. Overridable for tests and for
   * absorbing CLI verb changes without touching the classifier logic.
   */
  healthArgs?: readonly string[]
}

/**
 * Coarse corruption markers (design D2: parse coarse markers only, never log
 * formats). Broad by design: a false `corrupt` is fail-safe (it can only lead
 * to a rebuild offer that requires explicit confirmation), whereas a missed
 * corruption marker would let the gate act on a broken index.
 */
export const CORRUPTION_PATTERN =
  /\b(corrupt(?:ed|ion)?|inconsisten\w*|damaged|unreadable|invalid database|schema (?:mismatch|error)|not a valid (?:database|graph)|failed to (?:open|load|initialize|connect)(?: the)? (?:database|graph|db))\b/i

/**
 * Coarse staleness/drift markers. Absence of staleness evidence in parseable
 * health output means `clean`; the freshness change (add-cgc-freshness-drift-sync)
 * owns runtime drift, this only reads what the CLI reports at start time.
 */
export const STALENESS_PATTERN =
  /\b(stale|outdated|drift(?:ed|ing)?|changed since|needs? (?:a )?(?:re-?)?sync(?:ing)?|behind (?:the )?(?:working tree|disk)|re-?index(?:ing)? recommended)\b/i

/**
 * Coarse health markers that make probe output recognizably a status/stats
 * report. Output with none of these (and no corruption or staleness markers)
 * is unparseable and fails safe.
 */
export const HEALTH_PATTERN =
  /\b(statistics|repositor(?:y|ies)|indexed|files|functions|classes|interfaces|modules|nodes|relationships)\b/i

/**
 * Parse a health probe's captured output into a verdict using coarse markers.
 * Precedence: corruption first (safest), then staleness, then recognizable
 * health reporting (`clean`); anything else is `unparseable` — the caller
 * maps that onto the fail-safe `corrupt` bucket.
 */
export function parseHealthProbe(stdout: string, stderr: string): HealthParse {
  const text = `${stdout}\n${stderr}`
  if (CORRUPTION_PATTERN.test(text)) {
    return { verdict: 'corrupt', matched: ['corruption'] }
  }
  if (STALENESS_PATTERN.test(text)) {
    return { verdict: 'drift', matched: ['staleness'] }
  }
  if (HEALTH_PATTERN.test(text)) {
    return { verdict: 'clean', matched: ['health'] }
  }
  return { verdict: 'unparseable', matched: [] }
}

/**
 * Per-session lifecycle classifier. One instance per Pi session: the health
 * probe cache lives exactly as long as the classifier, so repeated gate
 * evaluations never re-spawn the status/stats probe (the per-session
 * invocation budget, task 2.7, is enforced here and in the runner's dedup).
 */
export class LifecycleClassifier {
  private readonly detector: WorkspaceDetector
  private readonly runner: CgcRunner
  private readonly healthProbeTimeoutMs: number
  private readonly healthArgs: readonly string[]
  /** Per-session health-probe cache, keyed by workspace cwd. */
  private readonly healthCache = new Map<string, Promise<HealthProbeResult>>()

  constructor(options: LifecycleClassifierOptions) {
    this.detector = options.detector
    this.runner = options.runner
    this.healthProbeTimeoutMs = options.healthProbeTimeoutMs ?? 30_000
    this.healthArgs = options.healthArgs ?? ['stats']
  }

  /**
   * Classify the workspace at `sessionCwd` (the Pi session's working
   * directory, never `process.cwd()` — the detector owns that rule).
   *
   * Never throws: every outcome resolves to a classification, and the
   * classification never selects `drift` on uncertainty.
   */
  async classify(sessionCwd: string): Promise<LifecycleClassification> {
    let detection: Awaited<ReturnType<WorkspaceDetector['detect']>>
    try {
      detection = await this.detector.detect(sessionCwd)
    } catch (error) {
      // Fail-open: an unexpected detector failure disables CGC integration for
      // this evaluation rather than risking action on unknown state.
      return this.unavailable(
        sessionCwd,
        false,
        `classification failed unexpectedly: ${errorMessage(error)}`,
      )
    }

    const { cwd, indexed, probe } = detection

    // 1. No usable cgc binary: nothing else can be known or done.
    if (!probe.available) {
      return this.unavailable(cwd, indexed, probe.message)
    }

    // 2. No .codegraphcontext/ directory: unindexed, no health probe needed.
    if (!indexed) {
      return {
        cwd,
        state: 'unindexed',
        indexed,
        probe,
        health: null,
        reason: `no ${'.codegraphcontext/'} directory in ${cwd}`,
        at: Date.now(),
      }
    }

    // 3. Indexed + available: the bounded status/stats probe decides.
    const health = await this.healthProbe(cwd)

    if (health.code === 'BUSY') {
      return {
        cwd,
        state: 'busy',
        indexed,
        probe,
        health,
        reason: 'another CGC process holds the embedded database (lock conflict)',
        at: Date.now(),
      }
    }

    if (health.code === 'OK' && health.parse !== null) {
      switch (health.parse.verdict) {
        case 'clean':
          return {
            cwd,
            state: 'clean',
            indexed,
            probe,
            health,
            reason: 'index health probe succeeded and reported no staleness',
            at: Date.now(),
          }
        case 'drift':
          return {
            cwd,
            state: 'drift',
            indexed,
            probe,
            health,
            reason: 'index health probe reported staleness/drift markers',
            at: Date.now(),
          }
        case 'corrupt':
          return {
            cwd,
            state: 'corrupt',
            indexed,
            probe,
            health,
            reason: 'index health probe reported corruption markers',
            at: Date.now(),
          }
        case 'unparseable':
          // Fail-safe bucket (design D2): unparseable probe output is treated
          // as corrupt-adjacent unknown. The corrupt path never destroys or
          // rebuilds without explicit confirmation, so this can only lead to
          // a harmless prompt — never data loss.
          return {
            cwd,
            state: 'corrupt',
            indexed,
            probe,
            health,
            reason:
              'index health probe output was unparseable; failing safe as corrupt-adjacent unknown (no action without confirmation)',
            at: Date.now(),
          }
      }
    }

    // 4. Any other inconclusive probe outcome (failed command, timeout,
    //    cancellation, spawn failure after a successful liveness probe) is
    //    unknown, not healthy: fail safe into the corrupt bucket.
    return {
      cwd,
      state: 'corrupt',
      indexed,
      probe,
      health,
      reason: `index health probe was inconclusive (${health.message}); failing safe as corrupt-adjacent unknown (no action without confirmation)`,
      at: Date.now(),
    }
  }

  /** Clear the per-session health-probe cache (session shutdown / fresh session). */
  reset(): void {
    this.healthCache.clear()
  }

  private unavailable(cwd: string, indexed: boolean, message: string): LifecycleClassification {
    return {
      cwd,
      state: 'unavailable',
      indexed,
      // A synthetic probe result: when detection itself failed there is no
      // probe to report; availability is the only field the state depends on.
      probe: {
        available: false,
        code: 'UNAVAILABLE',
        version: null,
        message,
        cached: false,
      },
      health: null,
      reason: message,
      at: Date.now(),
    }
  }

  /**
   * Cached bounded status/stats probe. Spawned through the shared runner
   * (deduplicated in flight), cached per workspace for the classifier's
   * lifetime so later evaluations in the same session never re-spawn.
   */
  private healthProbe(cwd: string): Promise<HealthProbeResult> {
    const cached = this.healthCache.get(cwd)
    if (cached) return cached.then((result) => ({ ...result, cached: true }))

    const promise = this.healthProbeOnce(cwd)
    this.healthCache.set(cwd, promise)
    return promise
  }

  private async healthProbeOnce(cwd: string): Promise<HealthProbeResult> {
    let result: Awaited<ReturnType<CgcRunner['run']>>
    try {
      result = await this.runner.run(cwd, {
        args: this.healthArgs,
        timeoutMs: this.healthProbeTimeoutMs,
      })
    } catch (error) {
      // The runner only throws on caller contract violations; treat anything
      // unexpected as an inconclusive probe (fail safe, never propagate).
      return {
        ok: false,
        code: 'COMMAND_FAILED',
        parse: null,
        message: `index health probe failed unexpectedly: ${errorMessage(error)}`,
        truncated: false,
        durationMs: 0,
        cached: false,
      }
    }

    const parse =
      result.ok || result.stdout.length > 0 || result.stderr.length > 0
        ? parseHealthProbe(result.stdout, result.stderr)
        : null

    return {
      ok: result.ok,
      code: result.code,
      parse,
      message: `cgc ${this.healthArgs.join(' ')}: ${result.message}`,
      truncated: result.truncated,
      durationMs: result.durationMs,
      cached: false,
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
