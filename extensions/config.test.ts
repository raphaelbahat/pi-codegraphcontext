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
    expect(result.config.worktree.mode).toBe('off')
    expect(result.config.proactive.sessionNote).toBe(true)
    expect(result.config.proactive.driftSteers).toBe(false)
    expect(result.config.proactive.resultAnnotations).toBe(false)
    expect(result.config.freshness.watch).toBe(false)
    expect(result.config.freshness.autoSync).toBe(true)
    expect(result.config.freshness.maxSyncsPerSession).toBe(2)
    expect(result.config.output.maxBytes).toBe(16_384)
    expect(result.config.output.spillToTemp).toBe(true)
    expect(result.config.output.redactSecrets).toBe(true)
    expect(result.config.output.gcf).toBe(false)
    expect(result.config.tools.cliGap.enabled).toBe(true)
    expect(result.config.guidance.routingSkill).toBe(false)
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
    expect(result.config.worktree.mode).toBe('off')
    expect(result.sources['cgc.executable']).toBe('env')
    expect(result.sources['cgc.timeoutMs']).toBe('env')
    expect(result.sources['lifecycle.autoCreate']).toBe('env')
    expect(result.sources['lifecycle.syncOnStart']).toBe('env')
    expect(result.sources['cgc.versionProbeTimeoutMs']).toBe('default')
    expect(result.sources['worktree.mode']).toBe('default')
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

  it('overrides worktree.mode via environment and falls back on invalid values', () => {
    const isolate = loadConfig({
      env: cleanEnv(envWith({ 'worktree.mode': 'isolate' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(isolate.config.worktree.mode).toBe('isolate')
    expect(isolate.sources['worktree.mode']).toBe('env')
    expect(isolate.warnings).toEqual([])

    const invalid = loadConfig({
      env: cleanEnv(envWith({ 'worktree.mode': 'sandbox' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(invalid.config.worktree.mode).toBe('off')
    expect(invalid.sources['worktree.mode']).toBe('default')
    expect(invalid.warnings.join('\n')).toContain('worktree.mode')
  })

  it('reads worktree.mode from config files with env override precedence', () => {
    const home = mkdtempSync(join(tmpdir(), 'cgc-cfg-wt-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'cgc-cfg-wt-proj-'))
    try {
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
      writeFileSync(
        join(home, '.pi', 'agent', 'cgc.json'),
        JSON.stringify({ worktree: { mode: 'isolate' } }),
      )
      mkdirSync(join(cwd, '.pi'), { recursive: true })
      writeFileSync(join(cwd, '.pi', 'cgc.json'), JSON.stringify({ worktree: { mode: 'off' } }))

      const fromFile = loadConfig({ env: cleanEnv(), cwd, homeDir: home })
      expect(fromFile.config.worktree.mode).toBe('off')
      expect(fromFile.sources['worktree.mode']).toBe('config-file')
      expect(fromFile.warnings).toEqual([])

      const fromEnv = loadConfig({
        env: cleanEnv(envWith({ 'worktree.mode': 'isolate' })),
        cwd,
        homeDir: home,
      })
      expect(fromEnv.config.worktree.mode).toBe('isolate')
      expect(fromEnv.sources['worktree.mode']).toBe('env')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
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

  it('defaults proactive.sessionNote to true (quiet tier, opt-out)', () => {
    const result = loadConfig({ env: cleanEnv(), cwd: '/nonexistent', homeDir: '/nonexistent' })
    expect(result.config.proactive.sessionNote).toBe(true)
    expect(result.sources['proactive.sessionNote']).toBe('default')
    expect(result.warnings).toEqual([])
  })

  it('overrides proactive.sessionNote via environment and falls back on invalid values', () => {
    const off = loadConfig({
      env: cleanEnv(envWith({ 'proactive.sessionNote': 'false' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(off.config.proactive.sessionNote).toBe(false)
    expect(off.sources['proactive.sessionNote']).toBe('env')
    expect(off.warnings).toEqual([])

    const on = loadConfig({
      env: cleanEnv(envWith({ 'proactive.sessionNote': 'YES' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(on.config.proactive.sessionNote).toBe(true)
    expect(on.sources['proactive.sessionNote']).toBe('env')

    const invalid = loadConfig({
      env: cleanEnv(envWith({ 'proactive.sessionNote': 'maybe' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(invalid.config.proactive.sessionNote).toBe(true)
    expect(invalid.sources['proactive.sessionNote']).toBe('default')
    expect(invalid.warnings.join('\n')).toContain('proactive.sessionNote')
  })

  it('defaults proactive.driftSteers to false (intrusive tier, opt-in) with env override', () => {
    const result = loadConfig({ env: cleanEnv(), cwd: '/nonexistent', homeDir: '/nonexistent' })
    expect(result.config.proactive.driftSteers).toBe(false)
    expect(result.sources['proactive.driftSteers']).toBe('default')
    expect(result.warnings).toEqual([])

    const on = loadConfig({
      env: cleanEnv(envWith({ 'proactive.driftSteers': '1' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(on.config.proactive.driftSteers).toBe(true)
    expect(on.sources['proactive.driftSteers']).toBe('env')
    expect(on.warnings).toEqual([])

    const off = loadConfig({
      env: cleanEnv(envWith({ 'proactive.driftSteers': 'OFF' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(off.config.proactive.driftSteers).toBe(false)
    expect(off.sources['proactive.driftSteers']).toBe('env')

    const invalid = loadConfig({
      env: cleanEnv(envWith({ 'proactive.driftSteers': 'maybe' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(invalid.config.proactive.driftSteers).toBe(false)
    expect(invalid.sources['proactive.driftSteers']).toBe('default')
    expect(invalid.warnings.join('\n')).toContain('proactive.driftSteers')
  })

  it('reads proactive.driftSteers from config files with env override precedence', () => {
    const home = mkdtempSync(join(tmpdir(), 'cgc-cfg-drift-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'cgc-cfg-drift-proj-'))
    try {
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
      writeFileSync(
        join(home, '.pi', 'agent', 'cgc.json'),
        JSON.stringify({ proactive: { driftSteers: true } }),
      )

      const fromFile = loadConfig({ env: cleanEnv(), cwd, homeDir: home })
      expect(fromFile.config.proactive.driftSteers).toBe(true)
      expect(fromFile.sources['proactive.driftSteers']).toBe('config-file')
      expect(fromFile.warnings).toEqual([])
      // The tier keys are independent: sessionNote keeps its default.
      expect(fromFile.config.proactive.sessionNote).toBe(true)

      const fromEnv = loadConfig({
        env: cleanEnv(envWith({ 'proactive.driftSteers': 'false' })),
        cwd,
        homeDir: home,
      })
      expect(fromEnv.config.proactive.driftSteers).toBe(false)
      expect(fromEnv.sources['proactive.driftSteers']).toBe('env')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('defaults proactive.resultAnnotations to false (intrusive tier, opt-in) with env override', () => {
    const result = loadConfig({ env: cleanEnv(), cwd: '/nonexistent', homeDir: '/nonexistent' })
    expect(result.config.proactive.resultAnnotations).toBe(false)
    expect(result.sources['proactive.resultAnnotations']).toBe('default')
    expect(result.warnings).toEqual([])

    const on = loadConfig({
      env: cleanEnv(envWith({ 'proactive.resultAnnotations': '1' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(on.config.proactive.resultAnnotations).toBe(true)
    expect(on.sources['proactive.resultAnnotations']).toBe('env')
    expect(on.warnings).toEqual([])

    const off = loadConfig({
      env: cleanEnv(envWith({ 'proactive.resultAnnotations': 'OFF' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(off.config.proactive.resultAnnotations).toBe(false)
    expect(off.sources['proactive.resultAnnotations']).toBe('env')

    const invalid = loadConfig({
      env: cleanEnv(envWith({ 'proactive.resultAnnotations': 'maybe' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(invalid.config.proactive.resultAnnotations).toBe(false)
    expect(invalid.sources['proactive.resultAnnotations']).toBe('default')
    expect(invalid.warnings.join('\n')).toContain('proactive.resultAnnotations')
  })

  it('reads proactive.resultAnnotations from config files with env override precedence', () => {
    const home = mkdtempSync(join(tmpdir(), 'cgc-cfg-anno-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'cgc-cfg-anno-proj-'))
    try {
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
      writeFileSync(
        join(home, '.pi', 'agent', 'cgc.json'),
        JSON.stringify({ proactive: { resultAnnotations: true } }),
      )

      const fromFile = loadConfig({ env: cleanEnv(), cwd, homeDir: home })
      expect(fromFile.config.proactive.resultAnnotations).toBe(true)
      expect(fromFile.sources['proactive.resultAnnotations']).toBe('config-file')
      expect(fromFile.warnings).toEqual([])
      // The tier keys are independent: the intrusive defaults stay off.
      expect(fromFile.config.proactive.driftSteers).toBe(false)
      expect(fromFile.config.proactive.sessionNote).toBe(true)

      const fromEnv = loadConfig({
        env: cleanEnv(envWith({ 'proactive.resultAnnotations': 'false' })),
        cwd,
        homeDir: home,
      })
      expect(fromEnv.config.proactive.resultAnnotations).toBe(false)
      expect(fromEnv.sources['proactive.resultAnnotations']).toBe('env')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reads proactive.sessionNote from config files with env override precedence', () => {
    const home = mkdtempSync(join(tmpdir(), 'cgc-cfg-pro-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'cgc-cfg-pro-proj-'))
    try {
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
      writeFileSync(
        join(home, '.pi', 'agent', 'cgc.json'),
        JSON.stringify({ proactive: { sessionNote: false } }),
      )

      const fromFile = loadConfig({ env: cleanEnv(), cwd, homeDir: home })
      expect(fromFile.config.proactive.sessionNote).toBe(false)
      expect(fromFile.sources['proactive.sessionNote']).toBe('config-file')
      expect(fromFile.warnings).toEqual([])

      const fromEnv = loadConfig({
        env: cleanEnv(envWith({ 'proactive.sessionNote': 'true' })),
        cwd,
        homeDir: home,
      })
      expect(fromEnv.config.proactive.sessionNote).toBe(true)
      expect(fromEnv.sources['proactive.sessionNote']).toBe('env')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('defaults output.maxBytes to 16384 with env override and fallback on invalid values', () => {
    const result = loadConfig({ env: cleanEnv(), cwd: '/nonexistent', homeDir: '/nonexistent' })
    expect(result.config.output.maxBytes).toBe(16_384)
    expect(result.sources['output.maxBytes']).toBe('default')
    expect(result.warnings).toEqual([])

    const raised = loadConfig({
      env: cleanEnv(envWith({ 'output.maxBytes': '32768' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(raised.config.output.maxBytes).toBe(32_768)
    expect(raised.sources['output.maxBytes']).toBe('env')
    expect(raised.warnings).toEqual([])

    for (const bad of ['0', '-2', '1.5', 'abc', 'Infinity']) {
      const fallback = loadConfig({
        env: cleanEnv(envWith({ 'output.maxBytes': bad })),
        cwd: '/nonexistent',
        homeDir: '/nonexistent',
      })
      expect(fallback.config.output.maxBytes).toBe(16_384)
      expect(fallback.sources['output.maxBytes']).toBe('default')
      expect(fallback.warnings.join('\n')).toContain('output.maxBytes')
    }
  })

  it('defaults output.spillToTemp to true (quiet tier, opt-out) with env override', () => {
    const result = loadConfig({ env: cleanEnv(), cwd: '/nonexistent', homeDir: '/nonexistent' })
    expect(result.config.output.spillToTemp).toBe(true)
    expect(result.sources['output.spillToTemp']).toBe('default')
    expect(result.warnings).toEqual([])

    const off = loadConfig({
      env: cleanEnv(envWith({ 'output.spillToTemp': 'false' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(off.config.output.spillToTemp).toBe(false)
    expect(off.sources['output.spillToTemp']).toBe('env')
    expect(off.warnings).toEqual([])

    const on = loadConfig({
      env: cleanEnv(envWith({ 'output.spillToTemp': 'YES' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(on.config.output.spillToTemp).toBe(true)
    expect(on.sources['output.spillToTemp']).toBe('env')

    const invalid = loadConfig({
      env: cleanEnv(envWith({ 'output.spillToTemp': 'maybe' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(invalid.config.output.spillToTemp).toBe(true)
    expect(invalid.sources['output.spillToTemp']).toBe('default')
    expect(invalid.warnings.join('\n')).toContain('output.spillToTemp')
  })

  it('defaults output.redactSecrets to true (opt-out) with env override', () => {
    const result = loadConfig({ env: cleanEnv(), cwd: '/nonexistent', homeDir: '/nonexistent' })
    expect(result.config.output.redactSecrets).toBe(true)
    expect(result.sources['output.redactSecrets']).toBe('default')
    expect(result.warnings).toEqual([])

    const off = loadConfig({
      env: cleanEnv(envWith({ 'output.redactSecrets': '0' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(off.config.output.redactSecrets).toBe(false)
    expect(off.sources['output.redactSecrets']).toBe('env')
    expect(off.warnings).toEqual([])

    const invalid = loadConfig({
      env: cleanEnv(envWith({ 'output.redactSecrets': 'nope' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(invalid.config.output.redactSecrets).toBe(true)
    expect(invalid.sources['output.redactSecrets']).toBe('default')
    expect(invalid.warnings.join('\n')).toContain('output.redactSecrets')
  })

  it('defaults output.gcf to false (opt-in passthrough) with env override', () => {
    const result = loadConfig({ env: cleanEnv(), cwd: '/nonexistent', homeDir: '/nonexistent' })
    expect(result.config.output.gcf).toBe(false)
    expect(result.sources['output.gcf']).toBe('default')
    expect(result.warnings).toEqual([])

    const on = loadConfig({
      env: cleanEnv(envWith({ 'output.gcf': '1' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(on.config.output.gcf).toBe(true)
    expect(on.sources['output.gcf']).toBe('env')
    expect(on.warnings).toEqual([])

    const off = loadConfig({
      env: cleanEnv(envWith({ 'output.gcf': 'OFF' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(off.config.output.gcf).toBe(false)
    expect(off.sources['output.gcf']).toBe('env')

    const invalid = loadConfig({
      env: cleanEnv(envWith({ 'output.gcf': 'maybe' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(invalid.config.output.gcf).toBe(false)
    expect(invalid.sources['output.gcf']).toBe('default')
    expect(invalid.warnings.join('\n')).toContain('output.gcf')
  })

  it('reads output keys from config files with env override precedence', () => {
    const home = mkdtempSync(join(tmpdir(), 'cgc-cfg-out-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'cgc-cfg-out-proj-'))
    try {
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
      writeFileSync(
        join(home, '.pi', 'agent', 'cgc.json'),
        JSON.stringify({
          output: { maxBytes: 8192, spillToTemp: false, redactSecrets: false, gcf: true },
        }),
      )

      const fromFile = loadConfig({ env: cleanEnv(), cwd, homeDir: home })
      expect(fromFile.config.output.maxBytes).toBe(8_192)
      expect(fromFile.config.output.spillToTemp).toBe(false)
      expect(fromFile.config.output.redactSecrets).toBe(false)
      expect(fromFile.config.output.gcf).toBe(true)
      expect(fromFile.sources['output.maxBytes']).toBe('config-file')
      expect(fromFile.sources['output.spillToTemp']).toBe('config-file')
      expect(fromFile.sources['output.redactSecrets']).toBe('config-file')
      expect(fromFile.sources['output.gcf']).toBe('config-file')
      expect(fromFile.warnings).toEqual([])
      // Output keys are independent of the other sections.
      expect(fromFile.config.freshness.maxSyncsPerSession).toBe(2)

      const fromEnv = loadConfig({
        env: cleanEnv(envWith({ 'output.maxBytes': '65536', 'output.gcf': 'false' })),
        cwd,
        homeDir: home,
      })
      expect(fromEnv.config.output.maxBytes).toBe(65_536)
      expect(fromEnv.config.output.spillToTemp).toBe(false)
      expect(fromEnv.config.output.redactSecrets).toBe(false)
      expect(fromEnv.config.output.gcf).toBe(false)
      expect(fromEnv.sources['output.maxBytes']).toBe('env')
      expect(fromEnv.sources['output.gcf']).toBe('env')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('ignores invalid output file values with warnings, keeping valid keys', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cgc-cfg-out-partial-'))
    try {
      mkdirSync(join(cwd, '.pi'), { recursive: true })
      writeFileSync(
        join(cwd, '.pi', 'cgc.json'),
        JSON.stringify({
          output: { maxBytes: -1, spillToTemp: 'maybe', redactSecrets: 'nope', gcf: 'nope' },
        }),
      )

      const result = loadConfig({ env: cleanEnv(), cwd, homeDir: '/nonexistent' })

      expect(result.config.output.maxBytes).toBe(16_384)
      expect(result.config.output.spillToTemp).toBe(true)
      expect(result.config.output.redactSecrets).toBe(true)
      expect(result.config.output.gcf).toBe(false)
      const joined = result.warnings.join('\n')
      expect(joined).toContain('output.maxBytes')
      expect(joined).toContain('output.spillToTemp')
      expect(joined).toContain('output.redactSecrets')
      expect(joined).toContain('output.gcf')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
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
          proactive: { sessionNote: false },
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
      expect(result.config.proactive.sessionNote).toBe(false)
      expect(result.sources['cgc.executable']).toBe('config-file')
      expect(result.sources['lifecycle.autoCreate']).toBe('config-file')
      expect(result.sources['proactive.sessionNote']).toBe('config-file')
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

  it('defaults freshness.watch to false (opt-in watcher) with env override', () => {
    const result = loadConfig({ env: cleanEnv(), cwd: '/nonexistent', homeDir: '/nonexistent' })
    expect(result.config.freshness.watch).toBe(false)
    expect(result.sources['freshness.watch']).toBe('default')
    expect(result.warnings).toEqual([])

    const on = loadConfig({
      env: cleanEnv(envWith({ 'freshness.watch': '1' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(on.config.freshness.watch).toBe(true)
    expect(on.sources['freshness.watch']).toBe('env')
    expect(on.warnings).toEqual([])

    const off = loadConfig({
      env: cleanEnv(envWith({ 'freshness.watch': 'OFF' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(off.config.freshness.watch).toBe(false)
    expect(off.sources['freshness.watch']).toBe('env')

    const invalid = loadConfig({
      env: cleanEnv(envWith({ 'freshness.watch': 'maybe' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(invalid.config.freshness.watch).toBe(false)
    expect(invalid.sources['freshness.watch']).toBe('default')
    expect(invalid.warnings.join('\n')).toContain('freshness.watch')
  })

  it('defaults freshness.autoSync to true (quiet tier, opt-out) with env override', () => {
    const result = loadConfig({ env: cleanEnv(), cwd: '/nonexistent', homeDir: '/nonexistent' })
    expect(result.config.freshness.autoSync).toBe(true)
    expect(result.sources['freshness.autoSync']).toBe('default')
    expect(result.warnings).toEqual([])

    const off = loadConfig({
      env: cleanEnv(envWith({ 'freshness.autoSync': 'false' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(off.config.freshness.autoSync).toBe(false)
    expect(off.sources['freshness.autoSync']).toBe('env')
    expect(off.warnings).toEqual([])

    const on = loadConfig({
      env: cleanEnv(envWith({ 'freshness.autoSync': 'YES' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(on.config.freshness.autoSync).toBe(true)
    expect(on.sources['freshness.autoSync']).toBe('env')

    const invalid = loadConfig({
      env: cleanEnv(envWith({ 'freshness.autoSync': 'maybe' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(invalid.config.freshness.autoSync).toBe(true)
    expect(invalid.sources['freshness.autoSync']).toBe('default')
    expect(invalid.warnings.join('\n')).toContain('freshness.autoSync')
  })

  it('defaults freshness.maxSyncsPerSession to 2 with env override and fallback on invalid values', () => {
    const result = loadConfig({ env: cleanEnv(), cwd: '/nonexistent', homeDir: '/nonexistent' })
    expect(result.config.freshness.maxSyncsPerSession).toBe(2)
    expect(result.sources['freshness.maxSyncsPerSession']).toBe('default')
    expect(result.warnings).toEqual([])

    const raised = loadConfig({
      env: cleanEnv(envWith({ 'freshness.maxSyncsPerSession': '5' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(raised.config.freshness.maxSyncsPerSession).toBe(5)
    expect(raised.sources['freshness.maxSyncsPerSession']).toBe('env')
    expect(raised.warnings).toEqual([])

    for (const bad of ['0', '-2', '1.5', 'abc', 'Infinity']) {
      const fallback = loadConfig({
        env: cleanEnv(envWith({ 'freshness.maxSyncsPerSession': bad })),
        cwd: '/nonexistent',
        homeDir: '/nonexistent',
      })
      expect(fallback.config.freshness.maxSyncsPerSession).toBe(2)
      expect(fallback.sources['freshness.maxSyncsPerSession']).toBe('default')
      expect(fallback.warnings.join('\n')).toContain('freshness.maxSyncsPerSession')
    }
  })

  it('reads freshness keys from config files with env override precedence', () => {
    const home = mkdtempSync(join(tmpdir(), 'cgc-cfg-fresh-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'cgc-cfg-fresh-proj-'))
    try {
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
      writeFileSync(
        join(home, '.pi', 'agent', 'cgc.json'),
        JSON.stringify({
          freshness: { watch: true, autoSync: false, maxSyncsPerSession: 3 },
        }),
      )

      const fromFile = loadConfig({ env: cleanEnv(), cwd, homeDir: home })
      expect(fromFile.config.freshness.watch).toBe(true)
      expect(fromFile.config.freshness.autoSync).toBe(false)
      expect(fromFile.config.freshness.maxSyncsPerSession).toBe(3)
      expect(fromFile.sources['freshness.watch']).toBe('config-file')
      expect(fromFile.sources['freshness.autoSync']).toBe('config-file')
      expect(fromFile.sources['freshness.maxSyncsPerSession']).toBe('config-file')
      expect(fromFile.warnings).toEqual([])
      // Freshness keys are independent of the other sections.
      expect(fromFile.config.proactive.sessionNote).toBe(true)

      const fromEnv = loadConfig({
        env: cleanEnv(envWith({ 'freshness.watch': 'false', 'freshness.maxSyncsPerSession': '1' })),
        cwd,
        homeDir: home,
      })
      expect(fromEnv.config.freshness.watch).toBe(false)
      expect(fromEnv.sources['freshness.watch']).toBe('env')
      expect(fromEnv.config.freshness.autoSync).toBe(false)
      expect(fromEnv.config.freshness.maxSyncsPerSession).toBe(1)
      expect(fromEnv.sources['freshness.maxSyncsPerSession']).toBe('env')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('defaults tools.cliGap.enabled to true (CLI-gap surface on) with env override and invalid fallback', () => {
    const defaults = loadConfig({ env: cleanEnv(), cwd: '/nonexistent', homeDir: '/nonexistent' })
    expect(defaults.config.tools.cliGap.enabled).toBe(true)
    expect(defaults.sources['tools.cliGap.enabled']).toBe('default')
    expect(defaults.warnings).toEqual([])

    const off = loadConfig({
      env: cleanEnv(envWith({ 'tools.cliGap.enabled': 'false' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(off.config.tools.cliGap.enabled).toBe(false)
    expect(off.sources['tools.cliGap.enabled']).toBe('env')
    expect(off.warnings).toEqual([])

    const on = loadConfig({
      env: cleanEnv(envWith({ 'tools.cliGap.enabled': '1' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(on.config.tools.cliGap.enabled).toBe(true)
    expect(on.sources['tools.cliGap.enabled']).toBe('env')

    const invalid = loadConfig({
      env: cleanEnv(envWith({ 'tools.cliGap.enabled': 'maybe' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(invalid.config.tools.cliGap.enabled).toBe(true)
    expect(invalid.sources['tools.cliGap.enabled']).toBe('default')
    expect(invalid.warnings.join('\n')).toContain('tools.cliGap.enabled')
  })

  it('reads tools.cliGap.enabled from config files with env override precedence', () => {
    const home = mkdtempSync(join(tmpdir(), 'cgc-cfg-tools-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'cgc-cfg-tools-proj-'))
    try {
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
      writeFileSync(
        join(home, '.pi', 'agent', 'cgc.json'),
        JSON.stringify({ tools: { cliGap: { enabled: false } } }),
      )

      const fromFile = loadConfig({ env: cleanEnv(), cwd, homeDir: home })
      expect(fromFile.config.tools.cliGap.enabled).toBe(false)
      expect(fromFile.sources['tools.cliGap.enabled']).toBe('config-file')
      expect(fromFile.warnings).toEqual([])

      const fromEnv = loadConfig({
        env: cleanEnv(envWith({ 'tools.cliGap.enabled': 'true' })),
        cwd,
        homeDir: home,
      })
      expect(fromEnv.config.tools.cliGap.enabled).toBe(true)
      expect(fromEnv.sources['tools.cliGap.enabled']).toBe('env')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('defaults guidance.routingSkill to false (always-on card stays non-configurable) with env override and invalid fallback', () => {
    const defaults = loadConfig({ env: cleanEnv(), cwd: '/nonexistent', homeDir: '/nonexistent' })
    expect(defaults.config.guidance.routingSkill).toBe(false)
    expect(defaults.sources['guidance.routingSkill']).toBe('default')
    expect(defaults.warnings).toEqual([])

    const on = loadConfig({
      env: cleanEnv(envWith({ 'guidance.routingSkill': 'true' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(on.config.guidance.routingSkill).toBe(true)
    expect(on.sources['guidance.routingSkill']).toBe('env')
    expect(on.warnings).toEqual([])

    const invalid = loadConfig({
      env: cleanEnv(envWith({ 'guidance.routingSkill': 'maybe' })),
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
    })
    expect(invalid.config.guidance.routingSkill).toBe(false)
    expect(invalid.sources['guidance.routingSkill']).toBe('default')
    expect(invalid.warnings.join('\n')).toContain('guidance.routingSkill')
  })

  it('reads guidance.routingSkill from config files with env override precedence', () => {
    const home = mkdtempSync(join(tmpdir(), 'cgc-cfg-guidance-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'cgc-cfg-guidance-proj-'))
    try {
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
      writeFileSync(
        join(home, '.pi', 'agent', 'cgc.json'),
        JSON.stringify({ guidance: { routingSkill: true } }),
      )

      const fromFile = loadConfig({ env: cleanEnv(), cwd, homeDir: home })
      expect(fromFile.config.guidance.routingSkill).toBe(true)
      expect(fromFile.sources['guidance.routingSkill']).toBe('config-file')
      expect(fromFile.warnings).toEqual([])

      const fromEnv = loadConfig({
        env: cleanEnv(envWith({ 'guidance.routingSkill': 'false' })),
        cwd,
        homeDir: home,
      })
      expect(fromEnv.config.guidance.routingSkill).toBe(false)
      expect(fromEnv.sources['guidance.routingSkill']).toBe('env')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('warns on a malformed guidance section while keeping the default', () => {
    const home = mkdtempSync(join(tmpdir(), 'cgc-cfg-guidance-bad-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'cgc-cfg-guidance-bad-proj-'))
    try {
      mkdirSync(join(cwd, '.pi'), { recursive: true })
      writeFileSync(join(cwd, '.pi', 'cgc.json'), JSON.stringify({ guidance: 'nope' }))
      const result = loadConfig({ env: cleanEnv(), cwd, homeDir: home })
      expect(result.config.guidance.routingSkill).toBe(false)
      expect(result.sources['guidance.routingSkill']).toBe('default')
      expect(result.warnings.join('\n')).toContain('"guidance" section')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('warns on malformed tools sections while keeping the default', () => {
    const home = mkdtempSync(join(tmpdir(), 'cgc-cfg-tools-bad-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'cgc-cfg-tools-bad-proj-'))
    try {
      mkdirSync(join(cwd, '.pi'), { recursive: true })
      writeFileSync(join(cwd, '.pi', 'cgc.json'), JSON.stringify({ tools: 'nope' }))
      const result = loadConfig({ env: cleanEnv(), cwd, homeDir: home })
      expect(result.config.tools.cliGap.enabled).toBe(true)
      expect(result.sources['tools.cliGap.enabled']).toBe('default')
      expect(result.warnings.join('\n')).toContain('"tools" section')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
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
          worktree: { mode: 'sandbox' },
          proactive: { sessionNote: 'maybe', driftSteers: 'nope', resultAnnotations: 'nope' },
          freshness: { watch: 'maybe', autoSync: 'nope', maxSyncsPerSession: 1.5 },
          output: { maxBytes: -1, spillToTemp: 'maybe', redactSecrets: 'nope', gcf: 'nope' },
          tools: { cliGap: { enabled: 'nope' } },
          guidance: { routingSkill: 'nope' },
          unknownSection: { nested: true },
        }),
      )

      const result = loadConfig({ env: cleanEnv(), cwd, homeDir: '/nonexistent' })

      expect(result.config.cgc.executable).toBe('cgc')
      expect(result.config.cgc.timeoutMs).toBe(30_000)
      expect(result.config.cgc.versionProbeTimeoutMs).toBe(8_000)
      expect(result.config.lifecycle.autoCreate).toBe(false)
      expect(result.config.worktree.mode).toBe('off')
      expect(result.config.proactive.sessionNote).toBe(true)
      expect(result.config.proactive.driftSteers).toBe(false)
      expect(result.config.proactive.resultAnnotations).toBe(false)
      expect(result.config.freshness.watch).toBe(false)
      expect(result.config.freshness.autoSync).toBe(true)
      expect(result.config.freshness.maxSyncsPerSession).toBe(2)
      expect(result.config.output.maxBytes).toBe(16_384)
      expect(result.config.output.spillToTemp).toBe(true)
      expect(result.config.output.redactSecrets).toBe(true)
      expect(result.config.output.gcf).toBe(false)
      expect(result.config.tools.cliGap.enabled).toBe(true)
      expect(result.config.guidance.routingSkill).toBe(false)
      const joined = result.warnings.join('\n')
      expect(joined).toContain('cgc.executable')
      expect(joined).toContain('cgc.timeoutMs')
      expect(joined).toContain('lifecycle.autoCreate')
      expect(joined).toContain('worktree.mode')
      expect(joined).toContain('proactive.sessionNote')
      expect(joined).toContain('proactive.driftSteers')
      expect(joined).toContain('proactive.resultAnnotations')
      expect(joined).toContain('freshness.watch')
      expect(joined).toContain('freshness.autoSync')
      expect(joined).toContain('freshness.maxSyncsPerSession')
      expect(joined).toContain('output.maxBytes')
      expect(joined).toContain('output.spillToTemp')
      expect(joined).toContain('output.redactSecrets')
      expect(joined).toContain('output.gcf')
      expect(joined).toContain('tools.cliGap.enabled')
      expect(joined).toContain('guidance.routingSkill')
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
