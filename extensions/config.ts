// Config loading for the pi-codegraphcontext extension (design D5 of
// openspec/changes/add-cgc-session-lifecycle-gate).
//
// Resolution order (lowest to highest precedence):
//   1. Built-in defaults
//   2. Optional JSON config files (global <agent-dir>/cgc.json — the Pi agent
//      directory: PI_CODING_AGENT_DIR when set, else ~/.pi/agent — then project
//      .pi/cgc.json)
//   3. Environment-variable overrides (headless/CI use)
//
// Loading is fail-open: unreadable or invalid layers are skipped and recorded
// as warnings; `loadConfig` never throws.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export interface ApiConfig {
  /**
   * Use the CGC HTTP API for the marker-absent indexedness probe chain
   * (health → Cypher point lookup → repositories fallback → on-demand
   * loopback spawn), falling back to `cgc list` (default true).
   */
  enabled: boolean
  /** Port the CGC API server is expected on / spawned on (default 8000). */
  port: number
}

export interface CgcConfig {
  /** `cgc` binary to spawn (resolved against PATH when not an absolute path). */
  executable: string
  /** Default time budget for cgc invocations, in milliseconds. */
  timeoutMs: number
  /**
   * Time budget for MAINTENANCE invocations, in milliseconds (default
   * 600000): the `/cgc index` and `/cgc sync` background runs. A real
   * incremental `cgc index .` legitimately takes about a minute on a
   * non-trivial workspace, so the probe-sized `timeoutMs` above would
   * terminate it every time. The read-only probes (status / classifier /
   * api-registry / version) deliberately keep `timeoutMs`.
   */
  maintenanceTimeoutMs: number
  /** Tighter time budget for the cached version probe, in milliseconds. */
  versionProbeTimeoutMs: number
  /** CGC HTTP API settings for the registry-backed indexedness probe chain. */
  api: ApiConfig
}

export interface LifecycleConfig {
  /** Opt-in consent gate: create a missing index automatically (default off). */
  autoCreate: boolean
  /** Reconcile graph↔disk drift at session start when an index exists. */
  syncOnStart: boolean
}

/** Proactive-injection tier config (design D1 of add-cgc-proactive-context-injection). */
export interface ProactiveConfig {
  /**
   * Session-start coverage note (default on): when guidance is ready, inject a
   * single capped coverage paragraph at most once per session. Opt out by
   * setting this to false.
   */
  sessionNote: boolean
  /**
   * Episode-scoped drift steers (default off, opt-in): when guidance is ready
   * and the session observes a fresh → possibly-stale freshness transition,
   * inject ONE agent-facing steer naming the staleness and the `/cgc sync`
   * option; no further steer fires until the episode resolves (design D3).
   * Opt in by setting this to true.
   */
  driftSteers: boolean
  /**
   * Result annotations (default off, opt-in): when enabled and the session
   * observes staleness, append a one-line freshness annotation to outputs
   * the extension itself produces (slash-command renders); annotations never
   * alter the output semantics and never touch CGC MCP server results (design
   * D4). Opt in by setting this to true.
   */
  resultAnnotations: boolean
}

/** Worktree isolation mode (design of add-cgc-worktree-aware-contexts). */
export type WorktreeMode = 'off' | 'isolate'

export interface WorktreeConfig {
  /**
   * Per-worktree CGC context isolation. `off` (default) leaves CGC's own
   * context resolution unchanged; `isolate` maps each linked worktree to a
   * dedicated `wt-` named context behind the auto-create consent gate.
   */
  mode: WorktreeMode
}

/** The freshness watcher mode (tri-state design of add-freshness-watch-tri-state). */
export type WatchMode = 'off' | 'on' | 'auto'

/** Session freshness drift/sync tier (design D2/D3 of add-cgc-freshness-drift-sync). */
export interface FreshnessConfig {
  /**
   * The continuous watcher mode (tri-state, default `off`):
   * - `off` — no watcher is ever spawned (byte-compatible with the old `false`).
   * - `on` — CGC's own watcher runs as a managed child unconditionally on every
   *   backend (byte-compatible with the old `true`; the user accepts the
   *   trade-offs, including the embedded-backend lock).
   * - `auto` — the gated backend-aware mode: the watcher spawns only when the
   *   detected backend is a server backend (neo4j / falkordb-remote), the
   *   workspace is already indexed, and the watcher's liveness is verified
   *   (within `watcherLivenessMs`) before the fresh claim is recorded. Only
   *   the literal text `auto` enables this mode — existing booleans map to
   *   on/off and never inherit the gating.
   */
  watch: WatchMode
  /**
   * Liveness-verification budget for the managed watcher (default 15000):
   * after spawning, the watcher must survive this window without settling as
   * failed before the workspace is recorded fresh; a dead or failed watcher
   * records the honest not-verified state plus a one-time notice.
   */
  watcherLivenessMs: number
  /**
   * Run short-lived incremental indexes on first drift (default on), capped
   * at `maxSyncsPerSession`; after the cap, staleness is advisory only.
   */
  autoSync: boolean
  /**
   * Session budget of automatic syncs (default 2): at most this many
   * incremental indexes run per session before only state + notice updates.
   */
  maxSyncsPerSession: number
}

/** Shared output-policy config (design D1–D5 of add-cgc-output-token-economy). */
export interface OutputConfig {
  /**
   * Delivered-output budget in bytes (default 16384): the shared runner caps
   * captured output at this size, preserving head+tail with an explicit
   * truncation marker (design D2).
   */
  maxBytes: number
  /**
   * Spill truncated output to a session-scoped temp file (default true): the
   * full output is written under the OS temp directory (never the workspace)
   * and removed at session teardown (design D3).
   */
  spillToTemp: boolean
  /**
   * Redact secret-shaped strings in captured output (default true): the
   * policy replaces credential-style assignments and high-entropy literals
   * before bounding; disable only for explicit fidelity (design D4).
   */
  redactSecrets: boolean
  /**
   * CGC GCF output-format passthrough (default false): when enabled the
   * runner sets `CGC_OUTPUT_FORMAT=gcf` on invocations and relies on CGC's
   * documented JSON fallback when the format is unavailable (design D5).
   */
  gcf: boolean
}

/** CLI-gap tool surface config (design D1/D2 of add-cgc-cli-gap-tools). */
export interface ToolsConfig {
  /**
   * Register the three CLI-gap tools (`cgc_bundle_export`, `cgc_context`,
   * `cgc_doctor`) — default on. One flag gates all three; the
   * `CGC_TOOLS_CLI_GAP_ENABLED` environment override takes precedence over
   * the config key (design D2). When disabled no CLI-gap tool exists in the
   * tool catalog at all.
   */
  cliGap: {
    enabled: boolean
  }
}

/** Agent-routing guidance config (design D2 of add-cgc-agent-routing-guidance). */
export interface GuidanceConfig {
  /**
   * Opt-in routing skill (default false): when enabled and guidance is ready,
   * the deeper routing skill is offered to the agent at skill-discovery time.
   * There is deliberately no key controlling the always-on guideline card —
   * that layer is non-configurable by design, so the only removal path is
   * disabling/uninstalling the extension.
   */
  routingSkill: boolean
}

export interface ExtensionConfig {
  cgc: CgcConfig
  lifecycle: LifecycleConfig
  worktree: WorktreeConfig
  proactive: ProactiveConfig
  freshness: FreshnessConfig
  output: OutputConfig
  tools: ToolsConfig
  guidance: GuidanceConfig
}

export type ConfigSource = 'default' | 'config-file' | 'env'

export type ConfigKey =
  | 'cgc.executable'
  | 'cgc.timeoutMs'
  | 'cgc.maintenanceTimeoutMs'
  | 'cgc.versionProbeTimeoutMs'
  | 'cgc.api.enabled'
  | 'cgc.api.port'
  | 'lifecycle.autoCreate'
  | 'lifecycle.syncOnStart'
  | 'worktree.mode'
  | 'proactive.sessionNote'
  | 'proactive.driftSteers'
  | 'proactive.resultAnnotations'
  | 'freshness.watch'
  | 'freshness.watcherLivenessMs'
  | 'freshness.autoSync'
  | 'freshness.maxSyncsPerSession'
  | 'output.maxBytes'
  | 'output.spillToTemp'
  | 'output.redactSecrets'
  | 'output.gcf'
  | 'tools.cliGap.enabled'
  | 'guidance.routingSkill'
export interface ConfigResult {
  config: ExtensionConfig
  /** Non-fatal notes about skipped/invalid layers or values. */
  warnings: string[]
  /** Where each effective value came from; useful for diagnostics surfaces. */
  sources: Record<ConfigKey, ConfigSource>
}

export interface LoadConfigOptions {
  /** Environment to read overrides from; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Workspace root for the project config file; defaults to `process.cwd()`. */
  cwd?: string
  /** Home directory for the global config file; defaults to `os.homedir()`. */
  homeDir?: string
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  cgc: {
    executable: 'cgc',
    timeoutMs: 30_000,
    maintenanceTimeoutMs: 600_000,
    versionProbeTimeoutMs: 10_000,
    api: {
      enabled: true,
      port: 8_000,
    },
  },
  lifecycle: {
    autoCreate: false,
    syncOnStart: true,
  },
  worktree: {
    mode: 'off',
  },
  proactive: {
    sessionNote: true,
    driftSteers: false,
    resultAnnotations: false,
  },
  freshness: {
    watch: 'off',
    watcherLivenessMs: 15_000,
    autoSync: true,
    maxSyncsPerSession: 2,
  },
  output: {
    maxBytes: 16_384,
    spillToTemp: true,
    redactSecrets: true,
    gcf: false,
  },
  tools: {
    cliGap: {
      enabled: true,
    },
  },
  guidance: {
    routingSkill: true,
  },
}

/** Environment-variable overrides per config key (design D5). */
export const CONFIG_ENV_VARS: Record<ConfigKey, string> = {
  'cgc.executable': 'CGC_EXECUTABLE',
  'cgc.timeoutMs': 'CGC_TIMEOUT_MS',
  'cgc.maintenanceTimeoutMs': 'CGC_MAINTENANCE_TIMEOUT_MS',
  'cgc.versionProbeTimeoutMs': 'CGC_VERSION_PROBE_TIMEOUT_MS',
  'cgc.api.enabled': 'CGC_API_ENABLED',
  'cgc.api.port': 'CGC_API_PORT',
  'lifecycle.autoCreate': 'CGC_LIFECYCLE_AUTO_CREATE',
  'lifecycle.syncOnStart': 'CGC_LIFECYCLE_SYNC_ON_START',
  'worktree.mode': 'CGC_WORKTREE_MODE',
  'proactive.sessionNote': 'CGC_PROACTIVE_SESSION_NOTE',
  'proactive.driftSteers': 'CGC_PROACTIVE_DRIFT_STEERS',
  'proactive.resultAnnotations': 'CGC_PROACTIVE_RESULT_ANNOTATIONS',
  'freshness.watch': 'CGC_FRESHNESS_WATCH',
  'freshness.watcherLivenessMs': 'CGC_FRESHNESS_WATCHER_LIVENESS_MS',
  'freshness.autoSync': 'CGC_FRESHNESS_AUTO_SYNC',
  'freshness.maxSyncsPerSession': 'CGC_FRESHNESS_MAX_SYNCS_PER_SESSION',
  'output.maxBytes': 'CGC_OUTPUT_MAX_BYTES',
  'output.spillToTemp': 'CGC_OUTPUT_SPILL_TO_TEMP',
  'output.redactSecrets': 'CGC_OUTPUT_REDACT_SECRETS',
  'output.gcf': 'CGC_OUTPUT_GCF',
  'tools.cliGap.enabled': 'CGC_TOOLS_CLI_GAP_ENABLED',
  'guidance.routingSkill': 'CGC_GUIDANCE_ROUTING_SKILL',
}

const CONFIG_KEYS: readonly ConfigKey[] = Object.keys(CONFIG_ENV_VARS) as ConfigKey[]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Lenient boolean parsing shared by env and file layers. */
export function parseBoolean(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase()
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false
  return undefined
}

/** Lenient worktree-mode parsing shared by env and file layers. */
export function parseWorktreeMode(raw: string): WorktreeMode | undefined {
  const value = raw.trim().toLowerCase()
  if (value === 'off') return 'off'
  if (value === 'isolate') return 'isolate'
  return undefined
}

/**
 * Lenient watcher-mode parsing shared by env and file layers (tri-state with
 * boolean compatibility): `auto` only from the literal text; booleans and
 * their string forms map to `on`/`off` so existing configurations keep their
 * exact meaning.
 */
export function parseWatchMode(raw: string): WatchMode | undefined {
  const value = raw.trim().toLowerCase()
  if (value === 'auto') return 'auto'
  const parsed = parseBoolean(raw)
  if (parsed === true) return 'on'
  if (parsed === false) return 'off'
  return undefined
}

// ---------------------------------------------------------------------------
// Shared validation rules (add-cgc-settings-modal task 1.1).
//
// One validation vocabulary for the loader and the settings modal: every rule
// here is exactly the rule the load-time parser enforces, and `error` is the
// exact parenthetical hint the loader's warning carries — so a modal rejection
// and a loader skip-with-warning read the same way. Pure: no warnings array,
// no side effects; the loader composes its own message shapes around these.
// ---------------------------------------------------------------------------

/** Discriminated validation result shared by the loader and the settings modal. */
export type ValueRule<T> = { ok: true; value: T } | { ok: false; error: string }

/** Boolean rule: booleans pass through; strings go through parseBoolean. */
export function validateBooleanValue(raw: unknown): ValueRule<boolean> {
  const parsed =
    typeof raw === 'boolean' ? raw : typeof raw === 'string' ? parseBoolean(raw) : undefined
  if (parsed === undefined) return { ok: false, error: 'expected 1/true/yes/on or 0/false/no/off' }
  return { ok: true, value: parsed }
}

/** Worktree-mode rule: "off" or "isolate" (case-insensitive like the loader). */
export function validateWorktreeModeValue(raw: unknown): ValueRule<WorktreeMode> {
  const parsed = typeof raw === 'string' ? parseWorktreeMode(raw) : undefined
  if (parsed === undefined) return { ok: false, error: 'expected "off" or "isolate"' }
  return { ok: true, value: parsed }
}

/**
 * Watcher-mode rule: the tri-state vocabulary with boolean compatibility
 * (booleans and boolean strings map to on/off; `auto` is literal-only).
 */
export function validateWatchModeValue(raw: unknown): ValueRule<WatchMode> {
  const parsed =
    typeof raw === 'boolean'
      ? raw
        ? 'on'
        : 'off'
      : typeof raw === 'string'
        ? parseWatchMode(raw)
        : undefined
  if (parsed === undefined) {
    return { ok: false, error: 'expected "off", "on", "auto", or a boolean' }
  }
  return { ok: true, value: parsed }
}

/** Timeout rule: a finite positive number of milliseconds (strings accepted). */
export function validateTimeoutMsValue(raw: unknown): ValueRule<number> {
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return { ok: false, error: 'expected a positive number of milliseconds' }
  }
  return { ok: true, value }
}

/** TCP-port rule: an integer between 1 and 65535 (strings accepted). */
export function validatePortValue(raw: unknown): ValueRule<number> {
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65_535
  ) {
    return { ok: false, error: 'expected a TCP port between 1 and 65535' }
  }
  return { ok: true, value }
}

/** Byte-budget rule: a positive whole number of bytes (strings accepted). */
export function validateMaxBytesValue(raw: unknown): ValueRule<number> {
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    return { ok: false, error: 'expected a positive whole number of bytes' }
  }
  return { ok: true, value }
}

/** Per-session count rule: a positive integer (strings accepted). */
export function validateMaxSyncsPerSessionValue(raw: unknown): ValueRule<number> {
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    return { ok: false, error: 'expected a positive whole number of syncs' }
  }
  return { ok: true, value }
}

/**
 * Watcher liveness-budget rule: a positive whole number of milliseconds
 * (strings accepted) — the same shape as the other millisecond budgets but
 * whole-number-strict, matching the maxSyncsPerSession validator.
 */
export function validateWatcherLivenessMsValue(raw: unknown): ValueRule<number> {
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    return { ok: false, error: 'expected a positive whole number of milliseconds' }
  }
  return { ok: true, value }
}

/** Executable rule: a non-empty string; the trimmed value is the result. */
export function validateExecutableValue(raw: unknown): ValueRule<string> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, error: 'expected a non-empty string' }
  }
  return { ok: true, value: raw.trim() }
}

function parseTimeoutMs(raw: unknown, key: ConfigKey, warnings: string[]): number | undefined {
  const result = validateTimeoutMsValue(raw)
  if (!result.ok) {
    warnings.push(`${key}: ignoring invalid timeout ${JSON.stringify(raw)} (${result.error})`)
    return undefined
  }
  return result.value
}

/** Parse a TCP port (whole number 1–65535) shared by env and file layers. */
function parsePort(raw: unknown, key: ConfigKey, warnings: string[]): number | undefined {
  const result = validatePortValue(raw)
  if (!result.ok) {
    warnings.push(`${key}: ignoring invalid ${JSON.stringify(raw)} (${result.error})`)
    return undefined
  }
  return result.value
}

/** Parse a byte budget (positive whole number) shared by env and file layers. */
function parseMaxBytes(raw: unknown, key: ConfigKey, warnings: string[]): number | undefined {
  const result = validateMaxBytesValue(raw)
  if (!result.ok) {
    warnings.push(`${key}: ignoring invalid ${JSON.stringify(raw)} (${result.error})`)
    return undefined
  }
  return result.value
}

/** Parse a per-session count (positive integer) shared by env and file layers. */
function parseMaxSyncsPerSession(
  raw: unknown,
  key: ConfigKey,
  warnings: string[],
): number | undefined {
  const result = validateMaxSyncsPerSessionValue(raw)
  if (!result.ok) {
    warnings.push(`${key}: ignoring invalid ${JSON.stringify(raw)} (${result.error})`)
    return undefined
  }
  return result.value
}

/** Parse the watcher liveness budget (positive whole ms) shared by env and file layers. */
function parseWatcherLivenessMs(
  raw: unknown,
  key: ConfigKey,
  warnings: string[],
): number | undefined {
  const result = validateWatcherLivenessMsValue(raw)
  if (!result.ok) {
    warnings.push(`${key}: ignoring invalid ${JSON.stringify(raw)} (${result.error})`)
    return undefined
  }
  return result.value
}

/**
 * Read one optional JSON config file. Missing files are silent; unreadable or
 * malformed files yield a warning. Returns only keys that were present and valid.
 */
function readConfigFile(
  path: string,
  label: string,
  warnings: string[],
): Partial<Record<ConfigKey, unknown>> {
  if (!existsSync(path)) return {}

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    warnings.push(`${label}: unreadable config file at ${path} (${String(error)})`)
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    warnings.push(`${label}: invalid JSON in config file at ${path} (${String(error)})`)
    return {}
  }

  if (!isPlainObject(parsed)) {
    warnings.push(`${label}: ignoring config file at ${path} (expected a JSON object)`)
    return {}
  }

  const values: Partial<Record<ConfigKey, unknown>> = {}

  const cgc = parsed.cgc
  if (cgc !== undefined) {
    if (isPlainObject(cgc)) {
      if (cgc.executable !== undefined) values['cgc.executable'] = cgc.executable
      if (cgc.timeoutMs !== undefined) values['cgc.timeoutMs'] = cgc.timeoutMs
      if (cgc.maintenanceTimeoutMs !== undefined) {
        values['cgc.maintenanceTimeoutMs'] = cgc.maintenanceTimeoutMs
      }
      if (cgc.versionProbeTimeoutMs !== undefined) {
        values['cgc.versionProbeTimeoutMs'] = cgc.versionProbeTimeoutMs
      }
      const api = cgc.api
      if (api !== undefined) {
        if (isPlainObject(api)) {
          if (api.enabled !== undefined) values['cgc.api.enabled'] = api.enabled
          if (api.port !== undefined) values['cgc.api.port'] = api.port
        } else {
          warnings.push(
            `${label}: ignoring "api" section under "cgc" in ${path} (expected an object)`,
          )
        }
      }
    } else {
      warnings.push(`${label}: ignoring "cgc" section in ${path} (expected an object)`)
    }
  }

  const lifecycle = parsed.lifecycle
  if (lifecycle !== undefined) {
    if (isPlainObject(lifecycle)) {
      if (lifecycle.autoCreate !== undefined) values['lifecycle.autoCreate'] = lifecycle.autoCreate
      if (lifecycle.syncOnStart !== undefined) {
        values['lifecycle.syncOnStart'] = lifecycle.syncOnStart
      }
    } else {
      warnings.push(`${label}: ignoring "lifecycle" section in ${path} (expected an object)`)
    }
  }

  const worktree = parsed.worktree
  if (worktree !== undefined) {
    if (isPlainObject(worktree)) {
      if (worktree.mode !== undefined) values['worktree.mode'] = worktree.mode
    } else {
      warnings.push(`${label}: ignoring "worktree" section in ${path} (expected an object)`)
    }
  }

  const proactive = parsed.proactive
  if (proactive !== undefined) {
    if (isPlainObject(proactive)) {
      if (proactive.sessionNote !== undefined) {
        values['proactive.sessionNote'] = proactive.sessionNote
      }
      if (proactive.driftSteers !== undefined) {
        values['proactive.driftSteers'] = proactive.driftSteers
      }
      if (proactive.resultAnnotations !== undefined) {
        values['proactive.resultAnnotations'] = proactive.resultAnnotations
      }
    } else {
      warnings.push(`${label}: ignoring "proactive" section in ${path} (expected an object)`)
    }
  }

  const freshness = parsed.freshness
  if (freshness !== undefined) {
    if (isPlainObject(freshness)) {
      if (freshness.watch !== undefined) values['freshness.watch'] = freshness.watch
      if (freshness.watcherLivenessMs !== undefined) {
        values['freshness.watcherLivenessMs'] = freshness.watcherLivenessMs
      }
      if (freshness.autoSync !== undefined) values['freshness.autoSync'] = freshness.autoSync
      if (freshness.maxSyncsPerSession !== undefined) {
        values['freshness.maxSyncsPerSession'] = freshness.maxSyncsPerSession
      }
    } else {
      warnings.push(`${label}: ignoring "freshness" section in ${path} (expected an object)`)
    }
  }

  const output = parsed.output
  if (output !== undefined) {
    if (isPlainObject(output)) {
      if (output.maxBytes !== undefined) values['output.maxBytes'] = output.maxBytes
      if (output.spillToTemp !== undefined) values['output.spillToTemp'] = output.spillToTemp
      if (output.redactSecrets !== undefined) values['output.redactSecrets'] = output.redactSecrets
      if (output.gcf !== undefined) values['output.gcf'] = output.gcf
    } else {
      warnings.push(`${label}: ignoring "output" section in ${path} (expected an object)`)
    }
  }

  const tools = parsed.tools
  if (tools !== undefined) {
    if (isPlainObject(tools)) {
      const cliGap = tools.cliGap
      if (cliGap !== undefined) {
        if (isPlainObject(cliGap)) {
          if (cliGap.enabled !== undefined) values['tools.cliGap.enabled'] = cliGap.enabled
        } else {
          warnings.push(`${label}: ignoring "cliGap" section in ${path} (expected an object)`)
        }
      }
    } else {
      warnings.push(`${label}: ignoring "tools" section in ${path} (expected an object)`)
    }
  }

  const guidance = parsed.guidance
  if (guidance !== undefined) {
    if (isPlainObject(guidance)) {
      if (guidance.routingSkill !== undefined) {
        values['guidance.routingSkill'] = guidance.routingSkill
      }
    } else {
      warnings.push(`${label}: ignoring "guidance" section in ${path} (expected an object)`)
    }
  }

  return values
}

/**
 * Apply one file layer's values onto the accumulating config. `winner` (the
 * layer's file attribution, D5 of add-cgc-settings-modal) is recorded for
 * every key this layer validly applies — the last layer to set a key wins.
 */
function applyFileLayer(
  values: Partial<Record<ConfigKey, unknown>>,
  label: string,
  config: ExtensionConfig,
  sources: Record<ConfigKey, ConfigSource>,
  warnings: string[],
  winner?: 'global' | 'project',
  fileWinners?: Partial<Record<ConfigKey, 'global' | 'project'>>,
): void {
  for (const key of CONFIG_KEYS) {
    if (!(key in values)) continue
    const raw = values[key]

    switch (key) {
      case 'cgc.executable': {
        const executable = validateExecutableValue(raw)
        if (executable.ok) {
          config.cgc.executable = executable.value
          sources[key] = 'config-file'
        } else {
          warnings.push(`${label}: ignoring invalid cgc.executable value ${JSON.stringify(raw)}`)
        }
        break
      }
      case 'cgc.timeoutMs': {
        const timeoutMs = parseTimeoutMs(raw, key, warnings)
        if (timeoutMs !== undefined) {
          config.cgc.timeoutMs = timeoutMs
          sources[key] = 'config-file'
        }
        break
      }
      case 'cgc.maintenanceTimeoutMs': {
        const timeoutMs = parseTimeoutMs(raw, key, warnings)
        if (timeoutMs !== undefined) {
          config.cgc.maintenanceTimeoutMs = timeoutMs
          sources[key] = 'config-file'
        }
        break
      }
      case 'cgc.versionProbeTimeoutMs': {
        const timeoutMs = parseTimeoutMs(raw, key, warnings)
        if (timeoutMs !== undefined) {
          config.cgc.versionProbeTimeoutMs = timeoutMs
          sources[key] = 'config-file'
        }
        break
      }
      case 'cgc.api.enabled': {
        const parsed =
          typeof raw === 'boolean' ? raw : typeof raw === 'string' ? parseBoolean(raw) : undefined
        if (parsed !== undefined) {
          config.cgc.api.enabled = parsed
          sources[key] = 'config-file'
        } else {
          warnings.push(`${label}: ignoring invalid cgc.api.enabled value ${JSON.stringify(raw)}`)
        }
        break
      }
      case 'cgc.api.port': {
        const port = parsePort(raw, key, warnings)
        if (port !== undefined) {
          config.cgc.api.port = port
          sources[key] = 'config-file'
        }
        break
      }
      case 'lifecycle.autoCreate': {
        const parsed =
          typeof raw === 'boolean' ? raw : typeof raw === 'string' ? parseBoolean(raw) : undefined
        if (parsed !== undefined) {
          config.lifecycle.autoCreate = parsed
          sources[key] = 'config-file'
        } else {
          warnings.push(
            `${label}: ignoring invalid lifecycle.autoCreate value ${JSON.stringify(raw)}`,
          )
        }
        break
      }
      case 'lifecycle.syncOnStart': {
        const parsed =
          typeof raw === 'boolean' ? raw : typeof raw === 'string' ? parseBoolean(raw) : undefined
        if (parsed !== undefined) {
          config.lifecycle.syncOnStart = parsed
          sources[key] = 'config-file'
        } else {
          warnings.push(
            `${label}: ignoring invalid lifecycle.syncOnStart value ${JSON.stringify(raw)}`,
          )
        }
        break
      }
      case 'worktree.mode': {
        const parsed = typeof raw === 'string' ? parseWorktreeMode(raw) : undefined
        if (parsed !== undefined) {
          config.worktree.mode = parsed
          sources[key] = 'config-file'
        } else {
          warnings.push(
            `${label}: ignoring invalid worktree.mode value ${JSON.stringify(raw)} (expected "off" or "isolate")`,
          )
        }
        break
      }
      case 'proactive.sessionNote':
      case 'proactive.driftSteers':
      case 'proactive.resultAnnotations': {
        const parsed =
          typeof raw === 'boolean' ? raw : typeof raw === 'string' ? parseBoolean(raw) : undefined
        if (parsed !== undefined) {
          if (key === 'proactive.sessionNote') config.proactive.sessionNote = parsed
          else if (key === 'proactive.driftSteers') config.proactive.driftSteers = parsed
          else config.proactive.resultAnnotations = parsed
          sources[key] = 'config-file'
        } else {
          warnings.push(`${label}: ignoring invalid ${key} value ${JSON.stringify(raw)}`)
        }
        break
      }
      case 'freshness.watch': {
        const parsed = validateWatchModeValue(raw)
        if (parsed.ok) {
          config.freshness.watch = parsed.value
          sources[key] = 'config-file'
        } else {
          warnings.push(
            `${label}: ignoring invalid ${key} value ${JSON.stringify(raw)} (${parsed.error})`,
          )
        }
        break
      }
      case 'freshness.watcherLivenessMs': {
        const livenessMs = parseWatcherLivenessMs(raw, key, warnings)
        if (livenessMs !== undefined) {
          config.freshness.watcherLivenessMs = livenessMs
          sources[key] = 'config-file'
        }
        break
      }
      case 'freshness.autoSync': {
        const parsed =
          typeof raw === 'boolean' ? raw : typeof raw === 'string' ? parseBoolean(raw) : undefined
        if (parsed !== undefined) {
          config.freshness.autoSync = parsed
          sources[key] = 'config-file'
        } else {
          warnings.push(`${label}: ignoring invalid ${key} value ${JSON.stringify(raw)}`)
        }
        break
      }
      case 'freshness.maxSyncsPerSession': {
        const maxSyncs = parseMaxSyncsPerSession(raw, key, warnings)
        if (maxSyncs !== undefined) {
          config.freshness.maxSyncsPerSession = maxSyncs
          sources[key] = 'config-file'
        }
        break
      }
      case 'output.maxBytes': {
        const maxBytes = parseMaxBytes(raw, key, warnings)
        if (maxBytes !== undefined) {
          config.output.maxBytes = maxBytes
          sources[key] = 'config-file'
        }
        break
      }
      case 'output.spillToTemp':
      case 'output.redactSecrets':
      case 'output.gcf': {
        const parsed =
          typeof raw === 'boolean' ? raw : typeof raw === 'string' ? parseBoolean(raw) : undefined
        if (parsed !== undefined) {
          if (key === 'output.spillToTemp') config.output.spillToTemp = parsed
          else if (key === 'output.redactSecrets') config.output.redactSecrets = parsed
          else config.output.gcf = parsed
          sources[key] = 'config-file'
        } else {
          warnings.push(`${label}: ignoring invalid ${key} value ${JSON.stringify(raw)}`)
        }
        break
      }
      case 'tools.cliGap.enabled': {
        const parsed =
          typeof raw === 'boolean' ? raw : typeof raw === 'string' ? parseBoolean(raw) : undefined
        if (parsed !== undefined) {
          config.tools.cliGap.enabled = parsed
          sources[key] = 'config-file'
        } else {
          warnings.push(
            `${label}: ignoring invalid tools.cliGap.enabled value ${JSON.stringify(raw)}`,
          )
        }
        break
      }
      case 'guidance.routingSkill': {
        const parsed =
          typeof raw === 'boolean' ? raw : typeof raw === 'string' ? parseBoolean(raw) : undefined
        if (parsed !== undefined) {
          config.guidance.routingSkill = parsed
          sources[key] = 'config-file'
        } else {
          warnings.push(
            `${label}: ignoring invalid guidance.routingSkill value ${JSON.stringify(raw)}`,
          )
        }
        break
      }
    }
    if (winner !== undefined && fileWinners !== undefined && sources[key] === 'config-file') {
      fileWinners[key] = winner
    }
  }
}

/** Apply environment-variable overrides onto the accumulating config. */
function applyEnvLayer(
  env: Record<string, string | undefined>,
  config: ExtensionConfig,
  sources: Record<ConfigKey, ConfigSource>,
  warnings: string[],
): void {
  for (const key of CONFIG_KEYS) {
    const name = CONFIG_ENV_VARS[key]
    const raw = env[name]
    if (raw === undefined || raw.trim().length === 0) continue

    switch (key) {
      case 'cgc.executable': {
        config.cgc.executable = raw.trim()
        sources[key] = 'env'
        break
      }
      case 'cgc.timeoutMs':
      case 'cgc.maintenanceTimeoutMs':
      case 'cgc.versionProbeTimeoutMs': {
        const timeoutMs = parseTimeoutMs(raw, key, warnings)
        if (timeoutMs !== undefined) {
          if (key === 'cgc.timeoutMs') config.cgc.timeoutMs = timeoutMs
          else if (key === 'cgc.maintenanceTimeoutMs') config.cgc.maintenanceTimeoutMs = timeoutMs
          else config.cgc.versionProbeTimeoutMs = timeoutMs
          sources[key] = 'env'
        }
        break
      }
      case 'cgc.api.enabled': {
        const parsed = parseBoolean(raw)
        if (parsed !== undefined) {
          config.cgc.api.enabled = parsed
          sources[key] = 'env'
        } else {
          warnings.push(
            `${key}: ignoring invalid ${name} value ${JSON.stringify(raw)} (expected 1/true/yes/on or 0/false/no/off)`,
          )
        }
        break
      }
      case 'cgc.api.port': {
        const port = parsePort(raw, key, warnings)
        if (port !== undefined) {
          config.cgc.api.port = port
          sources[key] = 'env'
        }
        break
      }
      case 'lifecycle.autoCreate':
      case 'lifecycle.syncOnStart':
      case 'proactive.sessionNote':
      case 'proactive.driftSteers':
      case 'proactive.resultAnnotations':
      case 'freshness.autoSync':
      case 'output.spillToTemp':
      case 'output.redactSecrets':
      case 'output.gcf':
      case 'tools.cliGap.enabled':
      case 'guidance.routingSkill': {
        const parsed = parseBoolean(raw)
        if (parsed !== undefined) {
          if (key === 'lifecycle.autoCreate') config.lifecycle.autoCreate = parsed
          else if (key === 'lifecycle.syncOnStart') config.lifecycle.syncOnStart = parsed
          else if (key === 'proactive.sessionNote') config.proactive.sessionNote = parsed
          else if (key === 'proactive.driftSteers') config.proactive.driftSteers = parsed
          else if (key === 'proactive.resultAnnotations')
            config.proactive.resultAnnotations = parsed
          else if (key === 'freshness.autoSync') config.freshness.autoSync = parsed
          else if (key === 'output.spillToTemp') config.output.spillToTemp = parsed
          else if (key === 'output.redactSecrets') config.output.redactSecrets = parsed
          else if (key === 'tools.cliGap.enabled') config.tools.cliGap.enabled = parsed
          else if (key === 'output.gcf') config.output.gcf = parsed
          else config.guidance.routingSkill = parsed
          sources[key] = 'env'
        } else {
          warnings.push(
            `${key}: ignoring invalid ${name} value ${JSON.stringify(raw)} (expected 1/true/yes/on or 0/false/no/off)`,
          )
        }
        break
      }
      case 'freshness.watch': {
        const parsed = validateWatchModeValue(raw)
        if (parsed.ok) {
          config.freshness.watch = parsed.value
          sources[key] = 'env'
        } else {
          warnings.push(
            `${key}: ignoring invalid ${name} value ${JSON.stringify(raw)} (${parsed.error})`,
          )
        }
        break
      }
      case 'freshness.watcherLivenessMs': {
        const livenessMs = parseWatcherLivenessMs(raw, key, warnings)
        if (livenessMs !== undefined) {
          config.freshness.watcherLivenessMs = livenessMs
          sources[key] = 'env'
        }
        break
      }
      case 'freshness.maxSyncsPerSession': {
        const maxSyncs = parseMaxSyncsPerSession(raw, key, warnings)
        if (maxSyncs !== undefined) {
          config.freshness.maxSyncsPerSession = maxSyncs
          sources[key] = 'env'
        }
        break
      }
      case 'output.maxBytes': {
        const maxBytes = parseMaxBytes(raw, key, warnings)
        if (maxBytes !== undefined) {
          config.output.maxBytes = maxBytes
          sources[key] = 'env'
        }
        break
      }
      case 'worktree.mode': {
        const parsed = parseWorktreeMode(raw)
        if (parsed !== undefined) {
          config.worktree.mode = parsed
          sources[key] = 'env'
        } else {
          warnings.push(
            `${key}: ignoring invalid ${name} value ${JSON.stringify(raw)} (expected "off" or "isolate")`,
          )
        }
        break
      }
    }
  }
}

/**
 * Resolve Pi's agent directory (the global config home): the
 * `PI_CODING_AGENT_DIR` environment variable when set (a leading `~` expands
 * against `homeDir`), else `<homeDir>/.pi/agent` — the same resolution pi
 * itself uses, so the extension reads the user's actual global config. The
 * override is read from `env` (the config layer's environment, so tests inject
 * it like every other override), falling back to the process environment.
 */
export function resolvePiAgentDir(
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.PI_CODING_AGENT_DIR
  if (override !== undefined && override.trim().length > 0) {
    const trimmed = override.trim()
    return trimmed.startsWith('~') ? join(homeDir, trimmed.slice(1)) : trimmed
  }
  return join(homeDir, '.pi', 'agent')
}

function loadConfigWithFileWinnersInternal(options: LoadConfigOptions): {
  config: ExtensionConfig
  warnings: string[]
  sources: Record<ConfigKey, ConfigSource>
  fileWinners: Partial<Record<ConfigKey, 'global' | 'project'>>
} {
  const warnings: string[] = []
  const sources = Object.fromEntries(
    CONFIG_KEYS.map((key) => [key, 'default' as ConfigSource]),
  ) as Record<ConfigKey, ConfigSource>
  const config: ExtensionConfig = structuredClone(DEFAULT_CONFIG)
  const fileWinners: Partial<Record<ConfigKey, 'global' | 'project'>> = {}

  const homeDir = options.homeDir ?? homedir()
  const cwd = options.cwd ?? process.cwd()

  // Layer 2: JSON config files (global first, project wins on conflict). The
  // global file lives in Pi's agent directory — PI_CODING_AGENT_DIR overrides
  // the default ~/.pi/agent (tilde-expanded), matching pi's own resolution.
  const globalFile = readConfigFile(
    resolveGlobalConfigPath(homeDir, options.env),
    'config',
    warnings,
  )
  applyFileLayer(globalFile, 'config', config, sources, warnings, 'global', fileWinners)
  const projectFile = readConfigFile(resolveProjectConfigPath(cwd), 'config', warnings)
  applyFileLayer(projectFile, 'config', config, sources, warnings, 'project', fileWinners)

  // Layer 3: environment-variable overrides (highest precedence).
  const env = options.env ?? process.env
  applyEnvLayer(env, config, sources, warnings)

  // Attribution only for keys whose FINAL source is 'config-file': an
  // env-superseded key is no longer file-sourced at all (D5).
  for (const key of CONFIG_KEYS) {
    if (sources[key] !== 'config-file') delete fileWinners[key]
  }

  return { config, warnings, sources, fileWinners }
}

/**
 * Resolve the effective extension configuration. Never throws; problems are
 * recorded in `warnings` and the affected value falls back to a lower layer.
 */
export function loadConfig(options: LoadConfigOptions = {}): ConfigResult {
  const { config, warnings, sources } = loadConfigWithFileWinnersInternal(options)
  return { config, warnings, sources }
}

/**
 * `loadConfig` plus the file-layer attribution the settings modal needs (D5 of
 * add-cgc-settings-modal): for every key whose effective source is
 * `config-file`, which file last set it — `project` or `global` (project wins
 * on conflict, matching the layering). Behavior of the resolved values is
 * identical to `loadConfig`.
 */
export interface ConfigResultWithFileWinners extends ConfigResult {
  fileWinners: Partial<Record<ConfigKey, 'global' | 'project'>>
}

export function loadConfigWithFileWinners(
  options: LoadConfigOptions = {},
): ConfigResultWithFileWinners {
  return loadConfigWithFileWinnersInternal(options)
}

// ---------------------------------------------------------------------------
// Never-clobber atomic merge writer (add-cgc-settings-modal task 1.2).
//
// The write-direction twin of the warn-and-skip read discipline above: only the
// edited nested keys are applied, every other section/key/ordering is preserved
// verbatim, and any refusal leaves the target file byte-identical. Writes are
// atomic (temp file + rename). This is the ONLY path the settings modal uses to
// touch a config file.
// ---------------------------------------------------------------------------

/** Which config file a settings save writes to (design D2 of add-cgc-settings-modal). */
export type ConfigFileTarget = 'project' | 'global'

/** The project config file path (`<cwd>/.pi/cgc.json`). */
export function resolveProjectConfigPath(cwd: string): string {
  return join(cwd, '.pi', 'cgc.json')
}

/**
 * The global config file path (`<agent-dir>/cgc.json`), via the shipped
 * `resolvePiAgentDir` (PI_CODING_AGENT_DIR-aware).
 */
export function resolveGlobalConfigPath(
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(resolvePiAgentDir(homeDir, env), 'cgc.json')
}

/** Typed refusals of {@link mergeConfigEdits}; every one leaves the file unmodified. */
export type MergeWriteRefusal =
  | 'missing'
  | 'unreadable'
  | 'invalid-json'
  | 'not-object'
  | 'section-not-object'
  | 'invalid-edit'
  | 'write-failed'

export type MergeWriteResult =
  | { ok: true; path: string; writtenKeys: readonly string[] }
  | { ok: false; refusal: MergeWriteRefusal; message: string }

/** One dotted config key (e.g. `cgc.api.port`) and its validated value. */
export interface MergeEdit {
  key: string
  value: unknown
}

/**
 * Merge `edits` into the JSON object at `targetPath` without clobbering
 * anything else: unknown sections/keys survive verbatim, a touched section
 * that is not a plain object refuses the whole save, and the write is atomic
 * (temp file + rename; dir `0o700` when created, file `0o600`). Never throws —
 * every failure is a typed refusal.
 */
export function mergeConfigEdits(
  targetPath: string,
  edits: readonly MergeEdit[],
  options: { createIfMissing?: boolean } = {},
): MergeWriteResult {
  try {
    let root: Record<string, unknown>
    if (!existsSync(targetPath)) {
      if (options.createIfMissing !== true) {
        return {
          ok: false,
          refusal: 'missing',
          message: `refusing to write ${targetPath}: the file does not exist (nothing was written)`,
        }
      }
      root = {}
    } else {
      let text: string
      try {
        text = readFileSync(targetPath, 'utf8')
      } catch (error) {
        return {
          ok: false,
          refusal: 'unreadable',
          message: `refusing to write ${targetPath}: the file is unreadable (${String(error)}); nothing was written`,
        }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text) as unknown
      } catch (error) {
        return {
          ok: false,
          refusal: 'invalid-json',
          message: `refusing to write ${targetPath}: invalid JSON (${String(error)}); nothing was written`,
        }
      }
      if (!isPlainObject(parsed)) {
        return {
          ok: false,
          refusal: 'not-object',
          message: `refusing to write ${targetPath}: expected a JSON object; nothing was written`,
        }
      }
      root = structuredClone(parsed) as Record<string, unknown>
    }

    // Validate every edit path BEFORE mutating anything — all-or-nothing.
    for (const edit of edits) {
      const parts = edit.key.split('.')
      if (parts.length < 2 || parts.some((part) => part.length === 0)) {
        return {
          ok: false,
          refusal: 'invalid-edit',
          message: `refusing to write ${targetPath}: invalid config key ${JSON.stringify(edit.key)}; nothing was written`,
        }
      }
      let cursor: Record<string, unknown> = root
      for (const section of parts.slice(0, -1)) {
        const child = cursor[section]
        if (child !== undefined && !isPlainObject(child)) {
          return {
            ok: false,
            refusal: 'section-not-object',
            message: `refusing to write ${targetPath}: the "${section}" section is not an object; nothing was written`,
          }
        }
        cursor = child === undefined ? {} : (child as Record<string, unknown>)
      }
    }

    // Apply — every path is validated above, so section objects are created
    // only where they are missing.
    for (const edit of edits) {
      const parts = edit.key.split('.')
      let cursor: Record<string, unknown> = root
      for (const section of parts.slice(0, -1)) {
        if (!isPlainObject(cursor[section])) cursor[section] = {}
        cursor = cursor[section] as Record<string, unknown>
      }
      cursor[parts[parts.length - 1] as string] = edit.value
    }

    const text = `${JSON.stringify(root, null, 2)}\n`
    const dir = dirname(targetPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = join(dir, `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`)
    try {
      writeFileSync(temp, text, { mode: 0o600 })
      renameSync(temp, targetPath)
    } catch (error) {
      try {
        unlinkSync(temp)
      } catch {
        // Best-effort cleanup; the target file is untouched either way.
      }
      return {
        ok: false,
        refusal: 'write-failed',
        message: `failed to write ${targetPath} (${String(error)}); nothing was changed`,
      }
    }
    return { ok: true, path: targetPath, writtenKeys: edits.map((edit) => edit.key) }
  } catch (error) {
    return {
      ok: false,
      refusal: 'write-failed',
      message: `failed to write ${targetPath} (${String(error)}); nothing was changed`,
    }
  }
}
