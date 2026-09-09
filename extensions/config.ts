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

export interface ExtensionConfig {
  cgc: CgcConfig
  lifecycle: LifecycleConfig
}

export type ConfigSource = 'default' | 'config-file' | 'env'

export type ConfigKey =
  | 'cgc.executable'
  | 'cgc.timeoutMs'
  | 'cgc.versionProbeTimeoutMs'
  | 'lifecycle.autoCreate'
  | 'lifecycle.syncOnStart'

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
}

/** Environment-variable overrides per config key (design D5). */
export const CONFIG_ENV_VARS: Record<ConfigKey, string> = {
  'cgc.executable': 'CGC_EXECUTABLE',
  'cgc.timeoutMs': 'CGC_TIMEOUT_MS',
  'cgc.versionProbeTimeoutMs': 'CGC_VERSION_PROBE_TIMEOUT_MS',
  'lifecycle.autoCreate': 'CGC_LIFECYCLE_AUTO_CREATE',
  'lifecycle.syncOnStart': 'CGC_LIFECYCLE_SYNC_ON_START',
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
      case 'lifecycle.syncOnStart': {
        const parsed = parseBoolean(raw)
        if (parsed !== undefined) {
          if (key === 'lifecycle.autoCreate') config.lifecycle.autoCreate = parsed
          else config.lifecycle.syncOnStart = parsed
          sources[key] = 'env'
        } else {
          warnings.push(
            `${key}: ignoring invalid ${name} value ${JSON.stringify(raw)} (expected 1/true/yes/on or 0/false/no/off)`,
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
