// Config loading for the pi-codegraphcontext extension (design D5 of
// openspec/changes/add-cgc-session-lifecycle-gate).
//
// Resolution order (lowest to highest precedence):
//   1. Built-in defaults
//   2. Optional JSON config files (global ~/.pi/agent/cgc.json, project .pi/cgc.json)
//   3. Environment-variable overrides (headless/CI use)
//
// Loading is fail-open: unreadable or invalid layers are skipped and recorded
// as warnings; `loadConfig` never throws.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CgcConfig {
  /** `cgc` binary to spawn (resolved against PATH when not an absolute path). */
  executable: string
  /** Default time budget for cgc invocations, in milliseconds. */
  timeoutMs: number
  /** Tighter time budget for the cached version probe, in milliseconds. */
  versionProbeTimeoutMs: number
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

/** Session freshness drift/sync tier (design D2/D3 of add-cgc-freshness-drift-sync). */
export interface FreshnessConfig {
  /**
   * Run CGC's own watcher as a managed child process (default off, opt-in).
   * A running watcher holds the embedded database, so it trades away the
   * user's own CGC MCP server availability for continuous freshness.
   */
  watch: boolean
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
  | 'cgc.versionProbeTimeoutMs'
  | 'lifecycle.autoCreate'
  | 'lifecycle.syncOnStart'
  | 'worktree.mode'
  | 'proactive.sessionNote'
  | 'proactive.driftSteers'
  | 'proactive.resultAnnotations'
  | 'freshness.watch'
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
    versionProbeTimeoutMs: 10_000,
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
    watch: false,
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
    routingSkill: false,
  },
}

/** Environment-variable overrides per config key (design D5). */
export const CONFIG_ENV_VARS: Record<ConfigKey, string> = {
  'cgc.executable': 'CGC_EXECUTABLE',
  'cgc.timeoutMs': 'CGC_TIMEOUT_MS',
  'cgc.versionProbeTimeoutMs': 'CGC_VERSION_PROBE_TIMEOUT_MS',
  'lifecycle.autoCreate': 'CGC_LIFECYCLE_AUTO_CREATE',
  'lifecycle.syncOnStart': 'CGC_LIFECYCLE_SYNC_ON_START',
  'worktree.mode': 'CGC_WORKTREE_MODE',
  'proactive.sessionNote': 'CGC_PROACTIVE_SESSION_NOTE',
  'proactive.driftSteers': 'CGC_PROACTIVE_DRIFT_STEERS',
  'proactive.resultAnnotations': 'CGC_PROACTIVE_RESULT_ANNOTATIONS',
  'freshness.watch': 'CGC_FRESHNESS_WATCH',
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

function parseTimeoutMs(raw: unknown, key: ConfigKey, warnings: string[]): number | undefined {
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    warnings.push(
      `${key}: ignoring invalid timeout ${JSON.stringify(raw)} (expected a positive number of milliseconds)`,
    )
    return undefined
  }
  return value
}

/** Parse a byte budget (positive whole number) shared by env and file layers. */
function parseMaxBytes(raw: unknown, key: ConfigKey, warnings: string[]): number | undefined {
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    warnings.push(
      `${key}: ignoring invalid ${JSON.stringify(raw)} (expected a positive whole number of bytes)`,
    )
    return undefined
  }
  return value
}

/** Parse a per-session count (positive integer) shared by env and file layers. */
function parseMaxSyncsPerSession(
  raw: unknown,
  key: ConfigKey,
  warnings: string[],
): number | undefined {
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    warnings.push(
      `${key}: ignoring invalid ${JSON.stringify(raw)} (expected a positive whole number of syncs)`,
    )
    return undefined
  }
  return value
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
      if (cgc.versionProbeTimeoutMs !== undefined) {
        values['cgc.versionProbeTimeoutMs'] = cgc.versionProbeTimeoutMs
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

/** Apply one file layer's values onto the accumulating config. */
function applyFileLayer(
  values: Partial<Record<ConfigKey, unknown>>,
  label: string,
  config: ExtensionConfig,
  sources: Record<ConfigKey, ConfigSource>,
  warnings: string[],
): void {
  for (const key of CONFIG_KEYS) {
    if (!(key in values)) continue
    const raw = values[key]

    switch (key) {
      case 'cgc.executable': {
        if (typeof raw === 'string' && raw.trim().length > 0) {
          config.cgc.executable = raw.trim()
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
      case 'cgc.versionProbeTimeoutMs': {
        const timeoutMs = parseTimeoutMs(raw, key, warnings)
        if (timeoutMs !== undefined) {
          config.cgc.versionProbeTimeoutMs = timeoutMs
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
      case 'freshness.watch':
      case 'freshness.autoSync': {
        const parsed =
          typeof raw === 'boolean' ? raw : typeof raw === 'string' ? parseBoolean(raw) : undefined
        if (parsed !== undefined) {
          if (key === 'freshness.watch') config.freshness.watch = parsed
          else config.freshness.autoSync = parsed
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
      case 'cgc.versionProbeTimeoutMs': {
        const timeoutMs = parseTimeoutMs(raw, key, warnings)
        if (timeoutMs !== undefined) {
          if (key === 'cgc.timeoutMs') config.cgc.timeoutMs = timeoutMs
          else config.cgc.versionProbeTimeoutMs = timeoutMs
          sources[key] = 'env'
        }
        break
      }
      case 'lifecycle.autoCreate':
      case 'lifecycle.syncOnStart':
      case 'proactive.sessionNote':
      case 'proactive.driftSteers':
      case 'proactive.resultAnnotations':
      case 'freshness.watch':
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
          else if (key === 'freshness.watch') config.freshness.watch = parsed
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
 * Resolve the effective extension configuration. Never throws; problems are
 * recorded in `warnings` and the affected value falls back to a lower layer.
 */
export function loadConfig(options: LoadConfigOptions = {}): ConfigResult {
  const warnings: string[] = []
  const sources = Object.fromEntries(
    CONFIG_KEYS.map((key) => [key, 'default' as ConfigSource]),
  ) as Record<ConfigKey, ConfigSource>
  const config: ExtensionConfig = structuredClone(DEFAULT_CONFIG)

  const homeDir = options.homeDir ?? homedir()
  const cwd = options.cwd ?? process.cwd()

  // Layer 2: JSON config files (global first, project wins on conflict).
  const globalFile = readConfigFile(join(homeDir, '.pi', 'agent', 'cgc.json'), 'config', warnings)
  applyFileLayer(globalFile, 'config', config, sources, warnings)
  const projectFile = readConfigFile(join(cwd, '.pi', 'cgc.json'), 'config', warnings)
  applyFileLayer(projectFile, 'config', config, sources, warnings)

  // Layer 3: environment-variable overrides (highest precedence).
  const env = options.env ?? process.env
  applyEnvLayer(env, config, sources, warnings)

  return { config, warnings, sources }
}
