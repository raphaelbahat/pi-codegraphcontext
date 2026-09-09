import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_ENV_VARS, type ConfigKey, DEFAULT_CONFIG, loadConfig, parseBoolean } from './config'

const ENV_KEYS = Object.keys(CONFIG_ENV_VARS) as ConfigKey[]

function envWith(entries: Partial<Record<ConfigKey, string>>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(entries) as [ConfigKey, string][]) {
    env[CONFIG_ENV_VARS[key]] = value
  }
  return env
}

/** Environment with every CGC_* override cleared, so hosts do not leak in. */
function cleanEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const key of ENV_KEYS) env[CONFIG_ENV_VARS[key]] = undefined
  return { ...env, ...extra }
}

describe('loadConfig', () => {
  it('yields the documented defaults with no file or env input', () => {
    const result = loadConfig({ env: cleanEnv(), cwd: '/nonexistent', homeDir: '/nonexistent' })

    expect(result.config).toEqual(DEFAULT_CONFIG)
    expect(result.config.cgc.executable).toBe('cgc')
    expect(result.config.cgc.timeoutMs).toBe(30_000)
    expect(result.config.cgc.versionProbeTimeoutMs).toBe(10_000)
    expect(result.config.lifecycle.autoCreate).toBe(false)
    expect(result.config.lifecycle.syncOnStart).toBe(true)
    expect(result.warnings).toEqual([])
    for (const key of ENV_KEYS) {
      expect(result.sources[key]).toBe('default')
    }
  })

  it('applies environment-variable overrides', () => {
    const result = loadConfig({
      env: cleanEnv(
        envWith({
          'cgc.executable': '/usr/local/bin/cgc',
          'cgc.timeoutMs': '45000',
          'lifecycle.autoCreate': 'true',
          'lifecycle.syncOnStart': 'false',
        }),
      ),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })

    expect(result.config.cgc.executable).toBe('/usr/local/bin/cgc')
    expect(result.config.cgc.timeoutMs).toBe(45_000)
    expect(result.config.cgc.versionProbeTimeoutMs).toBe(10_000)
    expect(result.config.lifecycle.autoCreate).toBe(true)
    expect(result.config.lifecycle.syncOnStart).toBe(false)
    expect(result.sources['cgc.executable']).toBe('env')
    expect(result.sources['cgc.timeoutMs']).toBe('env')
    expect(result.sources['lifecycle.autoCreate']).toBe('env')
    expect(result.sources['lifecycle.syncOnStart']).toBe('env')
    expect(result.sources['cgc.versionProbeTimeoutMs']).toBe('default')
  })

  it('supports the version-probe timeout override independently', () => {
    const result = loadConfig({
      env: cleanEnv(envWith({ 'cgc.versionProbeTimeoutMs': '5000' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })

    expect(result.config.cgc.versionProbeTimeoutMs).toBe(5_000)
    expect(result.config.cgc.timeoutMs).toBe(30_000)
    expect(result.sources['cgc.versionProbeTimeoutMs']).toBe('env')
    expect(result.sources['cgc.timeoutMs']).toBe('default')
  })

  it('parses lenient boolean forms and falls back on invalid ones', () => {
    const yes = loadConfig({
      env: cleanEnv(envWith({ 'lifecycle.autoCreate': 'ON' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(yes.config.lifecycle.autoCreate).toBe(true)

    const no = loadConfig({
      env: cleanEnv(envWith({ 'lifecycle.syncOnStart': '0' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(no.config.lifecycle.syncOnStart).toBe(false)

    const invalid = loadConfig({
      env: cleanEnv(envWith({ 'lifecycle.autoCreate': 'maybe' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(invalid.config.lifecycle.autoCreate).toBe(false)
    expect(invalid.sources['lifecycle.autoCreate']).toBe('default')
    expect(invalid.warnings.join('\n')).toContain('lifecycle.autoCreate')
  })

  it('falls back to defaults on invalid timeout values', () => {
    for (const bad of ['0', '-5', 'abc', 'Infinity']) {
      const result = loadConfig({
        env: cleanEnv(envWith({ 'cgc.timeoutMs': bad })),
        cwd: '/nonexistent',
        homeDir: '/nonexistent',
      })
      expect(result.config.cgc.timeoutMs).toBe(30_000)
      expect(result.warnings.join('\n')).toContain('cgc.timeoutMs')
    }
  })

  it('reads project and global config files with project precedence', () => {
    const home = mkdtempSync(join(tmpdir(), 'cgc-cfg-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'cgc-cfg-proj-'))
    try {
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
      writeFileSync(
        join(home, '.pi', 'agent', 'cgc.json'),
        JSON.stringify({
          cgc: { executable: 'global-cgc', timeoutMs: 60_000 },
          lifecycle: { autoCreate: true },
        }),
      )
      mkdirSync(join(cwd, '.pi'), { recursive: true })
      writeFileSync(
        join(cwd, '.pi', 'cgc.json'),
        JSON.stringify({ cgc: { executable: 'project-cgc' } }),
      )

      const result = loadConfig({ env: cleanEnv(), cwd, homeDir: home })

      expect(result.config.cgc.executable).toBe('project-cgc')
      expect(result.config.cgc.timeoutMs).toBe(60_000)
      expect(result.config.lifecycle.autoCreate).toBe(true)
      expect(result.config.lifecycle.syncOnStart).toBe(true)
      expect(result.sources['cgc.executable']).toBe('config-file')
      expect(result.sources['lifecycle.autoCreate']).toBe('config-file')
      expect(result.warnings).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('gives environment overrides precedence over config files', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cgc-cfg-both-'))
    try {
      mkdirSync(join(cwd, '.pi'), { recursive: true })
      writeFileSync(
        join(cwd, '.pi', 'cgc.json'),
        JSON.stringify({ cgc: { executable: 'file-cgc', timeoutMs: 60_000 } }),
      )

      const result = loadConfig({
        env: cleanEnv(envWith({ 'cgc.executable': 'env-cgc' })),
        cwd,
        homeDir: '/nonexistent',
      })

      expect(result.config.cgc.executable).toBe('env-cgc')
      expect(result.sources['cgc.executable']).toBe('env')
      expect(result.config.cgc.timeoutMs).toBe(60_000)
      expect(result.sources['cgc.timeoutMs']).toBe('config-file')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('stays fail-open on malformed config files', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cgc-cfg-bad-'))
    try {
      mkdirSync(join(cwd, '.pi'), { recursive: true })
      writeFileSync(join(cwd, '.pi', 'cgc.json'), '{ not json')

      const result = loadConfig({ env: cleanEnv(), cwd, homeDir: '/nonexistent' })

      expect(result.config).toEqual(DEFAULT_CONFIG)
      expect(result.warnings.join('\n')).toContain('invalid JSON')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('ignores invalid and unknown file values with warnings, keeping valid keys', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cgc-cfg-partial-'))
    try {
      mkdirSync(join(cwd, '.pi'), { recursive: true })
      writeFileSync(
        join(cwd, '.pi', 'cgc.json'),
        JSON.stringify({
          cgc: { executable: '', timeoutMs: -1, versionProbeTimeoutMs: 8000 },
          lifecycle: { autoCreate: 'not-a-bool' },
          unknownSection: { nested: true },
        }),
      )

      const result = loadConfig({ env: cleanEnv(), cwd, homeDir: '/nonexistent' })

      expect(result.config.cgc.executable).toBe('cgc')
      expect(result.config.cgc.timeoutMs).toBe(30_000)
      expect(result.config.cgc.versionProbeTimeoutMs).toBe(8_000)
      expect(result.config.lifecycle.autoCreate).toBe(false)
      const joined = result.warnings.join('\n')
      expect(joined).toContain('cgc.executable')
      expect(joined).toContain('cgc.timeoutMs')
      expect(joined).toContain('lifecycle.autoCreate')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('parseBoolean', () => {
  it('accepts documented truthy and falsy forms', () => {
    for (const v of ['1', 'true', 'YES', 'on']) expect(parseBoolean(v)).toBe(true)
    for (const v of ['0', 'false', 'No', 'off']) expect(parseBoolean(v)).toBe(false)
  })

  it('rejects anything else', () => {
    expect(parseBoolean('')).toBeUndefined()
    expect(parseBoolean('maybe')).toBeUndefined()
    expect(parseBoolean('2')).toBeUndefined()
  })
})
