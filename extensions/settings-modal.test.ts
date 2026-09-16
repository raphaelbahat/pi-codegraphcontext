// add-cgc-settings-modal: the pure logic (rows, validation, degradation
// decision, save path) and the fail-open command entry point. The TUI
// components are exercised through the real factories with a fake
// `ctx.ui.custom`; the ui.custom-driven flows are pinned end-to-end against
// real temp files, so the never-clobber and next-session guarantees are
// asserted against actual disk state.

import { describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONFIG_ENV_VARS,
  type ConfigKey,
  type ConfigResult,
  DEFAULT_CONFIG,
  loadConfigWithFileWinners,
  resolveGlobalConfigPath,
  resolveProjectConfigPath,
} from './config'
import {
  buildSettingsModalComponent,
  buildSettingsRows,
  decideSettingsUi,
  openCgcSettings,
  renderHeadlessSettings,
  resolveTargetPaths,
  SETTINGS_KEY_KINDS,
  type SettingsModalOutcome,
  type SettingsRow,
  saveSettingsEdits,
  settingsSourceAnnotation,
  settingValueText,
  validateSettingValue,
  validationRuleText,
} from './settings-modal'

const CONFIG_KEYS = Object.keys(CONFIG_ENV_VARS) as ConfigKey[]

/** Clean environment (no CGC_* or PI_CODING_AGENT_DIR leakage from the host). */
function cleanEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { PI_CODING_AGENT_DIR: undefined }
  for (const key of CONFIG_KEYS) env[CONFIG_ENV_VARS[key]] = undefined
  return { ...env, ...extra }
}

function makeLoaded(
  overrides: {
    sources?: Partial<Record<ConfigKey, ConfigResult['sources'][ConfigKey]>>
    fileWinners?: Partial<Record<ConfigKey, 'global' | 'project'>>
    values?: (config: ConfigResult['config']) => void
  } = {},
): ConfigResult & { fileWinners: Partial<Record<ConfigKey, 'global' | 'project'>> } {
  const loaded = loadConfigWithFileWinners({
    cwd: '/nonexistent',
    homeDir: '/nonexistent',
    env: cleanEnv(),
  })
  if (overrides.values !== undefined) overrides.values(loaded.config)
  if (overrides.sources !== undefined) Object.assign(loaded.sources, overrides.sources)
  return { ...loaded, fileWinners: overrides.fileWinners ?? {} }
}

interface Notified {
  message: string
  type: 'info' | 'warning' | 'error'
}

type Ui = Record<string, unknown>

function makeTuiContext(options: { dir: string; ui: Ui }): {
  ctx: Parameters<typeof openCgcSettings>[0]
  notified: Notified[]
} {
  const notified: Notified[] = []
  const ui = {
    notify(message: string, type?: Notified['type']): void {
      notified.push({ message, type: type ?? 'info' })
    },
    ...options.ui,
  }
  const ctx = { cwd: options.dir, mode: 'tui', hasUI: true, ui }
  return { ctx: ctx as unknown as Parameters<typeof openCgcSettings>[0], notified }
}

function makeHeadlessContext(dir: string): {
  ctx: Parameters<typeof openCgcSettings>[0]
  notified: Notified[]
} {
  const notified: Notified[] = []
  const ctx = {
    cwd: dir,
    mode: 'print',
    hasUI: false,
    ui: {
      notify(message: string, type?: Notified['type']): void {
        notified.push({ message, type: type ?? 'info' })
      },
      confirm(): Promise<boolean> {
        return Promise.reject(new Error('dialog must not be touched without a UI'))
      },
    },
  }
  return { ctx: ctx as unknown as Parameters<typeof openCgcSettings>[0], notified }
}

/** A fake `ctx.ui.custom` that records the options and resolves via `done`. */
function makeCustomSurface(outcome: SettingsModalOutcome | 'throw') {
  const overlayOptions: Array<boolean | undefined> = []
  const custom = <T>(
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result: T) => void,
    ) => unknown,
    options?: { overlay?: boolean },
  ): Promise<T> => {
    overlayOptions.push(options?.overlay)
    if (outcome === 'throw') return Promise.reject(new Error('overlay rejected'))
    return new Promise<T>((resolve) => {
      // Build the component (exercising the real pi-tui factories), then
      // resolve immediately with the outcome — simulating a user who has
      // already interacted and closed the modal.
      factory(
        {},
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        {},
        done,
      )
      done(outcome as T)
      function done(result: T): void {
        resolve(result)
      }
    })
  }
  return { custom, overlayOptions }
}
/** Run the fake custom surface immediately with a save outcome through openCgcSettings. */
function makeCustomSaveContext(dir: string, outcome: SettingsModalOutcome) {
  const surface = makeCustomSurface(outcome)
  return {
    ...makeTuiContext({ dir, ui: { custom: surface.custom, confirm: async () => true } }),
    surface,
  }
}

describe('SETTINGS_KEY_KINDS (the editable-key list, task 2.2)', () => {
  it('covers every ConfigKey exactly once', () => {
    expect(Object.keys(SETTINGS_KEY_KINDS).sort()).toEqual([...CONFIG_KEYS].sort())
  })

  it('kinds match the design: one enum (worktree.mode), booleans cycle, the rest are text', () => {
    expect(SETTINGS_KEY_KINDS['worktree.mode']).toBe('enum')
    for (const key of CONFIG_KEYS) {
      const kind = SETTINGS_KEY_KINDS[key]
      if (key === 'worktree.mode') continue
      if (kind === 'boolean') continue
      expect(kind === 'number' || kind === 'string', `${key} -> ${kind}`).toBe(true)
    }
    expect(SETTINGS_KEY_KINDS['cgc.api.port']).toBe('number')
    expect(SETTINGS_KEY_KINDS['cgc.executable']).toBe('string')
  })
})

describe('validateSettingValue (task 1.1/D4: the loader rules, exactly)', () => {
  it('booleans accept the parseBoolean vocabulary and reject everything else', () => {
    for (const key of [
      'lifecycle.autoCreate',
      'freshness.watch',
      'tools.cliGap.enabled',
    ] as ConfigKey[]) {
      expect(validateSettingValue(key, 'on')).toEqual({ ok: true, value: true })
      expect(validateSettingValue(key, 'off')).toEqual({ ok: true, value: false })
      expect(validateSettingValue(key, 'TRUE')).toEqual({ ok: true, value: true })
      expect(validateSettingValue(key, '0')).toEqual({ ok: true, value: false })
      expect(validateSettingValue(key, true)).toEqual({ ok: true, value: true })
      const invalid = validateSettingValue(key, 'maybe')
      expect(invalid.ok).toBe(false)
      if (!invalid.ok) expect(invalid.error).toBe('expected 1/true/yes/on or 0/false/no/off')
    }
  })

  it('worktree.mode accepts only off/isolate with the loader message', () => {
    expect(validateSettingValue('worktree.mode', 'off')).toEqual({ ok: true, value: 'off' })
    expect(validateSettingValue('worktree.mode', 'ISOLATE')).toEqual({ ok: true, value: 'isolate' })
    const invalid = validateSettingValue('worktree.mode', 'never')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error).toBe('expected "off" or "isolate"')
  })

  it('ports accept 1–65535 integers (strings included) and reject out-of-range with the loader message', () => {
    expect(validateSettingValue('cgc.api.port', 8_000)).toEqual({ ok: true, value: 8_000 })
    expect(validateSettingValue('cgc.api.port', '1')).toEqual({ ok: true, value: 1 })
    expect(validateSettingValue('cgc.api.port', '65535')).toEqual({ ok: true, value: 65_535 })
    for (const bad of [99_999, '99999', '0', '1.5', 'abc', -1]) {
      const invalid = validateSettingValue('cgc.api.port', bad)
      expect(invalid.ok, `port ${String(bad)}`).toBe(false)
      if (!invalid.ok) expect(invalid.error).toBe('expected a TCP port between 1 and 65535')
    }
  })

  it('timeouts must be positive finite ms', () => {
    expect(validateSettingValue('cgc.timeoutMs', '5000')).toEqual({ ok: true, value: 5_000 })
    expect(validateSettingValue('cgc.versionProbeTimeoutMs', 1_000)).toEqual({
      ok: true,
      value: 1_000,
    })
    const invalid = validateSettingValue('cgc.timeoutMs', '0')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error).toBe('expected a positive number of milliseconds')
  })

  it('byte budgets and sync counts must be positive whole numbers', () => {
    expect(validateSettingValue('output.maxBytes', '16384')).toEqual({ ok: true, value: 16_384 })
    expect(validateSettingValue('freshness.maxSyncsPerSession', '2')).toEqual({
      ok: true,
      value: 2,
    })
    const bytes = validateSettingValue('output.maxBytes', '1.5')
    expect(bytes.ok).toBe(false)
    if (!bytes.ok) expect(bytes.error).toBe('expected a positive whole number of bytes')
    const syncs = validateSettingValue('freshness.maxSyncsPerSession', 0)
    expect(syncs.ok).toBe(false)
    if (!syncs.ok) expect(syncs.error).toBe('expected a positive whole number of syncs')
  })

  it('the executable must be a non-empty string; the trimmed value wins', () => {
    expect(validateSettingValue('cgc.executable', ' /usr/local/bin/cgc ')).toEqual({
      ok: true,
      value: '/usr/local/bin/cgc',
    })
    const invalid = validateSettingValue('cgc.executable', '   ')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error).toBe('expected a non-empty string')
  })

  it('every validation rule text equals the loader rejection vocabulary', () => {
    expect(validationRuleText('lifecycle.autoCreate')).toBe(
      'expected 1/true/yes/on or 0/false/no/off',
    )
    expect(validationRuleText('worktree.mode')).toBe('expected "off" or "isolate"')
    expect(validationRuleText('cgc.api.port')).toBe('expected a TCP port between 1 and 65535')
    expect(validationRuleText('cgc.timeoutMs')).toBe('expected a positive number of milliseconds')
    expect(validationRuleText('output.maxBytes')).toBe('expected a positive whole number of bytes')
    expect(validationRuleText('freshness.maxSyncsPerSession')).toBe(
      'expected a positive whole number of syncs',
    )
    expect(validationRuleText('cgc.executable')).toBe('expected a non-empty string')
  })

  it('booleans render on/off in display text', () => {
    expect(settingValueText('lifecycle.autoCreate', true)).toBe('on')
    expect(settingValueText('lifecycle.autoCreate', false)).toBe('off')
    expect(settingValueText('cgc.api.port', 8_000)).toBe('8000')
  })
})

describe('buildSettingsRows (task 1.3: fresh-load rows with sources and env names)', () => {
  it('renders every key with its effective value, source, and interaction kind', () => {
    const rows = buildSettingsRows(makeLoaded())
    expect(rows.map((row) => row.key)).toEqual(CONFIG_KEYS)
    for (const row of rows) {
      expect(row.source).toBe('default')
      expect(row.envVar).toBeUndefined()
      expect(row.fileWinner).toBeUndefined()
      expect(row.kind).toBe(
        row.key === 'worktree.mode'
          ? 'cycle'
          : SETTINGS_KEY_KINDS[row.key] === 'boolean'
            ? 'cycle'
            : 'text',
      )
    }
    const port = rows.find((row) => row.key === 'cgc.api.port')
    expect(port?.valueText).toBe('8000')
    const autoCreate = rows.find((row) => row.key === 'lifecycle.autoCreate')
    expect(autoCreate?.valueText).toBe('off')
  })

  it('env-sourced keys become read-only rows annotated with the winning env var (D5)', () => {
    const loaded = makeLoaded({
      sources: { 'output.maxBytes': 'env', 'cgc.api.port': 'env' },
      values: (config) => {
        config.output.maxBytes = 4096
        config.cgc.api.port = 9001
      },
    })
    const rows = buildSettingsRows(loaded, {})
    const maxBytes = rows.find((row) => row.key === 'output.maxBytes')
    expect(maxBytes?.kind).toBe('readonly')
    expect(maxBytes?.envVar).toBe('CGC_OUTPUT_MAX_BYTES')
    expect(maxBytes?.valueText).toBe('4096')
    const port = rows.find((row) => row.key === 'cgc.api.port')
    expect(port?.envVar).toBe('CGC_API_PORT')
  })

  it('config-file keys carry the file-winner annotation (D5: which file won)', () => {
    const loaded = makeLoaded({
      sources: { 'lifecycle.autoCreate': 'config-file', 'tools.cliGap.enabled': 'config-file' },
      fileWinners: { 'lifecycle.autoCreate': 'project', 'tools.cliGap.enabled': 'global' },
    })
    const rows = buildSettingsRows(loaded, loaded.fileWinners)
    const project = rows.find((row) => row.key === 'lifecycle.autoCreate')
    expect(project?.fileWinner).toBe('project')
    expect(project?.kind).toBe('cycle')
    const global = rows.find((row) => row.key === 'tools.cliGap.enabled')
    expect(global?.fileWinner).toBe('global')
  })

  it('annotations name the layer, file, and read-only env condition', () => {
    const row = (overrides: Partial<SettingsRow>): SettingsRow => ({
      key: 'lifecycle.autoCreate',
      rawValue: false,
      valueText: 'off',
      source: 'default',
      envVar: undefined,
      fileWinner: undefined,
      kind: 'cycle',
      ...overrides,
    })
    expect(settingsSourceAnnotation(row({ source: 'default' }))).toBe('built-in default')
    expect(settingsSourceAnnotation(row({ source: 'config-file', fileWinner: 'project' }))).toBe(
      'config file (project .pi/cgc.json)',
    )
    expect(settingsSourceAnnotation(row({ source: 'config-file', fileWinner: 'global' }))).toBe(
      'config file (global cgc.json)',
    )
    expect(settingsSourceAnnotation(row({ source: 'env', envVar: 'CGC_X' }))).toBe(
      'env override CGC_X — read-only',
    )
  })
})

describe('decideSettingsUi (D1 step 4: the degradation decision)', () => {
  it('gates ALL terminal input on ctx.mode === "tui" (hasUI cannot gate — RPC sets it true)', () => {
    for (const mode of ['print', 'json', 'rpc', undefined]) {
      expect(decideSettingsUi({ mode, hasCustom: true, hasDialogs: true })).toBe('readonly')
    }
  })

  it('prefers custom (overlay attempted first) over dialogs, dialogs over readonly', () => {
    expect(decideSettingsUi({ mode: 'tui', hasCustom: true, hasDialogs: true })).toBe('tui')
    expect(decideSettingsUi({ mode: 'tui', hasCustom: true, hasDialogs: false })).toBe('tui')
    expect(decideSettingsUi({ mode: 'tui', hasCustom: false, hasDialogs: true })).toBe('dialogs')
    expect(decideSettingsUi({ mode: 'tui', hasCustom: false, hasDialogs: false })).toBe('readonly')
  })
})

describe('renderHeadlessSettings (the read-only table)', () => {
  it('renders the key/value/source table naming both config paths and the restart boundary', () => {
    const dir = '/ws'
    const rows = buildSettingsRows(makeLoaded())
    const paths = resolveTargetPaths(dir, '/home/u', cleanEnv())
    const text = renderHeadlessSettings(rows, paths)

    expect(text).toContain('cgc config:')
    expect(text).toContain(`project config: ${resolveProjectConfigPath(dir)}`)
    expect(text).toContain(`global config: ${resolveGlobalConfigPath('/home/u', cleanEnv())}`)
    expect(text).toContain('cgc.executable')
    expect(text).toContain('cgc')
    expect(text).toContain('[default]')
    expect(text).toContain('next session start')
  })

  it('names the winning env var for env-sourced rows', () => {
    const loaded = makeLoaded({ sources: { 'output.maxBytes': 'env' } })
    const rows = buildSettingsRows(loaded, {})
    const text = renderHeadlessSettings(rows, { project: '/p', global: '/g' })
    expect(text).toContain('[env (CGC_OUTPUT_MAX_BYTES)]')
  })

  it('prefixes the degradation warning when every interactive surface is broken (D5)', () => {
    const rows = buildSettingsRows(makeLoaded(), {})
    const text = renderHeadlessSettings(rows, { project: '/p', global: '/g' }, true)
    expect(text).toContain('interactive settings UI is unavailable')
    expect(text).toContain('cgc config:')
  })
})

describe('mergeConfigEdits + saveSettingsEdits (tasks 1.2/2.3: never-clobber, layered, atomic)', () => {
  function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'cgc-settings-test-'))
  }

  it('writes the edited nested keys and preserves unknown sections/keys verbatim', async () => {
    const dir = makeTempDir()
    try {
      const project = resolveProjectConfigPath(dir)
      mkdirSync(join(dir, '.pi'), { recursive: true })
      writeFileSync(
        project,
        JSON.stringify({
          customSection: { keep: 'me', nested: [1, 2] },
          lifecycle: { autoCreate: false, unknownKey: 'stay' },
        }),
      )
      const before = readFileSync(project, 'utf8')

      const result = await saveSettingsEdits({
        edits: [{ key: 'lifecycle.autoCreate', value: true }],
        target: 'project',
        cwd: dir,
        homeDir: '/nonexistent',
        env: cleanEnv(),
      })

      expect(result.ok).toBe(true)
      const written = JSON.parse(readFileSync(project, 'utf8')) as Record<string, unknown>
      expect(written['customSection']).toEqual({ keep: 'me', nested: [1, 2] })
      expect(written['lifecycle']).toEqual({ autoCreate: true, unknownKey: 'stay' })
      // A touched-section sibling key survived, unknown section survived — and
      // the file gained only the merge, never a regeneration.
      expect(readFileSync(project, 'utf8')).not.toBe(before)
      expect(result.ok && result.message).toContain('next session start')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates the three-level cgc.api.port path when missing', async () => {
    const dir = makeTempDir()
    try {
      const result = await saveSettingsEdits({
        edits: [{ key: 'cgc.api.port', value: 9_000 }],
        target: 'project',
        cwd: dir,
        homeDir: '/nonexistent',
        env: cleanEnv(),
        confirmCreate: () => true,
      })
      expect(result.ok).toBe(true)
      const written = JSON.parse(readFileSync(resolveProjectConfigPath(dir), 'utf8')) as {
        cgc?: { api?: { port?: number } }
      }
      expect(written.cgc?.api?.port).toBe(9_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lands global saves in the PI_CODING_AGENT_DIR-resolved agent directory', async () => {
    const home = makeTempDir()
    try {
      const result = await saveSettingsEdits({
        edits: [{ key: 'output.maxBytes', value: 4_096 }],
        target: 'global',
        cwd: '/nonexistent',
        homeDir: home,
        env: cleanEnv({ PI_CODING_AGENT_DIR: join(home, 'agent') }),
        confirmCreate: () => true,
      })
      expect(result.ok).toBe(true)
      expect(existsSync(join(home, 'agent', 'cgc.json'))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('refuses invalid staged values BEFORE any filesystem touch (D4: nothing reaches the write path)', async () => {
    const dir = makeTempDir()
    try {
      const result = await saveSettingsEdits({
        edits: [{ key: 'cgc.api.port', value: 99_999 }],
        target: 'project',
        cwd: dir,
        homeDir: '/nonexistent',
        env: cleanEnv(),
        confirmCreate: () => true,
      })
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.message).toContain(
        'expected a TCP port between 1 and 65535',
      )
      expect(existsSync(resolveProjectConfigPath(dir))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a missing target file unless creation is confirmed (D2)', async () => {
    const dir = makeTempDir()
    try {
      const declined = await saveSettingsEdits({
        edits: [{ key: 'lifecycle.autoCreate', value: true }],
        target: 'project',
        cwd: dir,
        homeDir: '/nonexistent',
        env: cleanEnv(),
      })
      expect(declined.ok).toBe(false)
      expect(declined.ok === false && declined.message).toContain('nothing was written')
      expect(existsSync(resolveProjectConfigPath(dir))).toBe(false)

      const confirmed = await saveSettingsEdits({
        edits: [{ key: 'lifecycle.autoCreate', value: true }],
        target: 'project',
        cwd: dir,
        homeDir: '/nonexistent',
        env: cleanEnv(),
        confirmCreate: () => true,
      })
      expect(confirmed.ok).toBe(true)
      expect(JSON.parse(readFileSync(resolveProjectConfigPath(dir), 'utf8'))).toEqual({
        lifecycle: { autoCreate: true },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a malformed target file and leaves it byte-identical (all-or-nothing)', async () => {
    const dir = makeTempDir()
    try {
      mkdirSync(join(dir, '.pi'), { recursive: true })
      const project = resolveProjectConfigPath(dir)
      const malformed = '{ this is not json'
      writeFileSync(project, malformed)

      const invalidJson = await saveSettingsEdits({
        edits: [{ key: 'lifecycle.autoCreate', value: true }],
        target: 'project',
        cwd: dir,
        homeDir: '/nonexistent',
        env: cleanEnv(),
      })
      expect(invalidJson.ok).toBe(false)
      expect(invalidJson.ok === false && invalidJson.message).toContain('nothing was written')
      expect(readFileSync(project, 'utf8')).toBe(malformed)

      writeFileSync(project, '[1, 2, 3]')
      const notObject = await saveSettingsEdits({
        edits: [{ key: 'lifecycle.autoCreate', value: true }],
        target: 'project',
        cwd: dir,
        homeDir: '/nonexistent',
        env: cleanEnv(),
      })
      expect(notObject.ok).toBe(false)
      expect(readFileSync(project, 'utf8')).toBe('[1, 2, 3]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses when a touched section is not an object and leaves the file byte-identical', async () => {
    const dir = makeTempDir()
    try {
      mkdirSync(join(dir, '.pi'), { recursive: true })
      const project = resolveProjectConfigPath(dir)
      const content = JSON.stringify({ lifecycle: 'not-an-object', custom: { a: 1 } })
      writeFileSync(project, content)

      const result = await saveSettingsEdits({
        edits: [{ key: 'lifecycle.autoCreate', value: true }],
        target: 'project',
        cwd: dir,
        homeDir: '/nonexistent',
        env: cleanEnv(),
      })
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.message).toContain('section')
      expect(readFileSync(project, 'utf8')).toBe(content)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes atomically: file mode 0o600, created dir mode 0o700, no temp residue', async () => {
    const dir = makeTempDir()
    try {
      const result = await saveSettingsEdits({
        edits: [{ key: 'lifecycle.autoCreate', value: true }],
        target: 'project',
        cwd: dir,
        homeDir: '/nonexistent',
        env: cleanEnv(),
        confirmCreate: () => true,
      })
      expect(result.ok).toBe(true)
      const project = resolveProjectConfigPath(dir)
      expect((statSync(project).mode & 0o777) === 0o600).toBe(true)
      expect((statSync(join(dir, '.pi')).mode & 0o777) === 0o700).toBe(true)
      const residue = readdirSync(join(dir, '.pi')).filter((name) => name.endsWith('.tmp'))
      expect(residue).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses zero staged edits', async () => {
    const result = await saveSettingsEdits({
      edits: [],
      target: 'project',
      cwd: '/nonexistent',
      homeDir: '/nonexistent',
      env: cleanEnv(),
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('no edits were staged')
  })
})

describe('buildSettingsModalComponent (the thin TUI composition, tasks 2.1/2.2)', () => {
  const paths = { project: '/ws/.pi/cgc.json', global: '/home/u/.pi/agent/cgc.json' }
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text }

  function build(rows: SettingsRow[], onClose: (outcome: SettingsModalOutcome) => void) {
    return buildSettingsModalComponent({ theme, rows, initialTarget: 'project', paths, onClose })
  }

  it('renders the leading rows with their effective values and the next-session note', () => {
    const closed: SettingsModalOutcome[] = []
    const rows = buildSettingsRows(makeLoaded(), {})
    const component = build(rows, closed.push.bind(closed))
    const text = component.render(120).join('\n')
    expect(text).toContain('CGC settings')
    expect(text).toContain('Save target')
    expect(text).toContain('next session start')
    // The list caps its visible window; assert the rows it shows.
    for (const row of rows.slice(0, 13)) {
      expect(text).toContain(row.key)
    }
    expect(closed).toEqual([])
  })

  it('ESC closes with a cancel outcome (staged edits discarded)', () => {
    const closed: SettingsModalOutcome[] = []
    const component = build(buildSettingsRows(makeLoaded(), {}), closed.push.bind(closed))

    component.handleInput('\u001b') // ESC is SettingsList's cancel binding

    expect(closed).toHaveLength(1)
    expect(closed[0]?.kind).toBe('cancel')
  })

  it('ctrl+s closes with the staged edits and the selected target', () => {
    const closed: SettingsModalOutcome[] = []
    const component = build(buildSettingsRows(makeLoaded(), {}), closed.push.bind(closed))

    component.handleInput('\u0013') // ctrl+s: explicit save

    expect(closed).toHaveLength(1)
    expect(closed[0]?.kind).toBe('save')
    expect(closed[0]?.target).toBe('project')
    expect(closed[0]?.edits).toEqual([])
  })

  it('cycling a boolean stages the flipped value and ctrl+s emits it as a save (D1/D4)', () => {
    const closed: SettingsModalOutcome[] = []
    // Exactly the rows the render can show: the target row plus the boolean,
    // so the first down-arrow lands on the boolean deterministically.
    const rows = buildSettingsRows(makeLoaded(), {}).filter(
      (row) => row.key === 'lifecycle.autoCreate',
    )
    const component = build(rows, closed.push.bind(closed))

    component.handleInput('\x1b[B') // down arrow: select the boolean row
    component.handleInput('\r') // enter: cycles off -> on, stages it
    component.handleInput('\u0013') // ctrl+s: save

    expect(closed).toHaveLength(1)
    expect(closed[0]?.kind).toBe('save')
    expect(closed[0]?.target).toBe('project')
    const edit = closed[0]?.edits.find((candidate) => candidate.key === 'lifecycle.autoCreate')
    expect(edit?.value).toBe(true)
  })
})

describe('openCgcSettings (the fail-open command entry point, D1–D5)', () => {
  it('headless mode renders exactly one read-only table notice and never touches dialogs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgc-settings-headless-'))
    try {
      const { ctx, notified } = makeHeadlessContext(dir)

      await openCgcSettings(ctx, { homeDir: dir, env: cleanEnv() })

      expect(notified).toHaveLength(1)
      expect(notified[0]?.type).toBe('info')
      expect(notified[0]?.message).toContain('cgc config:')
      expect(notified[0]?.message).toContain(`project config: ${resolveProjectConfigPath(dir)}`)
      expect(notified[0]?.message).toContain(
        `global config: ${resolveGlobalConfigPath(dir, cleanEnv())}`,
      )
      expect(notified[0]?.message).toContain('next session start')
      // No modal attempted, no file written.
      expect(existsSync(resolveProjectConfigPath(dir))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('inside the TUI, overlay custom is attempted first and a save lands on disk with the next-session notice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgc-settings-overlay-'))
    try {
      const { ctx, notified, surface } = makeCustomSaveContext(dir, {
        kind: 'save',
        edits: [
          { key: 'cgc.api.port', value: 9_000 },
          { key: 'lifecycle.autoCreate', value: true },
        ],
        target: 'project',
      })

      await openCgcSettings(ctx, { homeDir: dir, env: cleanEnv() })

      // D1 step 1: the overlay option was requested on the first attempt.
      expect(surface.overlayOptions[0]).toBe(true)
      expect(notified).toHaveLength(1)
      expect(notified[0]?.type).toBe('info')
      expect(notified[0]?.message).toContain('next session start')

      const written = JSON.parse(readFileSync(resolveProjectConfigPath(dir), 'utf8')) as Record<
        string,
        unknown
      >
      expect((written['cgc'] as { api?: { port?: number } }).api?.port).toBe(9_000)
      expect((written['lifecycle'] as { autoCreate?: boolean }).autoCreate).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades overlay → plain custom → dialogs (D1 chain: custom throws twice, dialogs work)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgc-settings-degrade-'))
    try {
      const surface = makeCustomSurface('throw')
      const selects: Array<{ title: string; options: string[] }> = []
      const ui: Ui = {
        custom: surface.custom,
        select: async (title: string, options: string[]) => {
          selects.push({ title, options })
          return undefined // ESC out of the key picker
        },
        input: async () => undefined,
        confirm: async () => true,
      }
      const { ctx, notified } = makeTuiContext({ dir, ui })

      await openCgcSettings(ctx, { homeDir: dir, env: cleanEnv() })

      // D1: overlay requested first, then the plain custom retry, then the
      // dialog flow ran; a clean cancel of the dialog flow is a terminal
      // state, not a failure — the read-only table was still surfaced (info).
      expect(surface.overlayOptions[0]).toBe(true)
      expect(surface.overlayOptions).toHaveLength(2)
      expect(selects[0]?.title).toContain('edit which setting')
      expect(notified.some((entry) => entry.message.includes('cgc config:'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades to the read-only warning table when EVERY interactive surface fails (D5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgc-settings-allfail-'))
    try {
      const surface = makeCustomSurface('throw')
      const ui: Ui = {
        custom: surface.custom,
        select: async () => {
          throw new Error('dialog exploded')
        },
        input: async () => undefined,
        confirm: async () => true,
      }
      const { ctx, notified } = makeTuiContext({ dir, ui })

      await openCgcSettings(ctx, { homeDir: dir, env: cleanEnv() })

      const fallback = notified.at(-1)
      expect(fallback?.type).toBe('warning')
      expect(fallback?.message).toContain('interactive settings UI is unavailable')
      expect(fallback?.message).toContain('cgc config:')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the dialog flow stages nothing on an empty input and never reaches the write path (D4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgc-settings-dialogs-'))
    try {
      let selectCalls = 0
      const ui: Ui = {
        select: async (_title: string, options: string[]) => {
          selectCalls++
          // First call: pick the first editable row. Second call (the loop
          // continues because the input resolves empty): cancel the picker —
          // the flow returns.
          return selectCalls === 1 ? (options[0] ?? undefined) : undefined
        },
        input: async () => undefined,
        confirm: async () => true,
      }
      const { ctx } = makeTuiContext({ dir, ui })

      await openCgcSettings(ctx, { homeDir: dir, env: cleanEnv() })

      expect(selectCalls).toBe(2)
      expect(existsSync(resolveProjectConfigPath(dir))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never throws — not on a broken custom surface, a broken notify sink, or a broken config dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgc-settings-failopen-'))
    try {
      // Broken custom surface + broken notify sink.
      const surface = makeCustomSurface('throw')
      const throwingNotify = {
        notify(): void {
          throw new Error('notify exploded')
        },
        custom: surface.custom,
      }
      const broken = {
        cwd: dir,
        mode: 'tui',
        hasUI: true,
        ui: throwingNotify,
      } as unknown as Parameters<typeof openCgcSettings>[0]
      await expect(
        openCgcSettings(broken, { homeDir: dir, env: cleanEnv() }),
      ).resolves.toBeUndefined()

      // A read-only cwd (chmod 0o500) must also fail open on the fresh load.
      const readonlyDir = mkdtempSync(join(tmpdir(), 'cgc-settings-readonly-'))
      try {
        writeFileSync(join(readonlyDir, 'sentinel'), 'untouched')
        chmodSync(readonlyDir, 0o500)
        const { ctx } = makeHeadlessContext(readonlyDir)
        await expect(
          openCgcSettings(ctx, { homeDir: readonlyDir, env: cleanEnv() }),
        ).resolves.toBeUndefined()
      } finally {
        chmodSync(readonlyDir, 0o700)
        rmSync(readonlyDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reflects hand-edited on-disk state at open time (D3: fresh load, not the process cache)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgc-settings-fresh-'))
    try {
      mkdirSync(join(dir, '.pi'), { recursive: true })
      writeFileSync(
        resolveProjectConfigPath(dir),
        JSON.stringify({ lifecycle: { autoCreate: true } }),
      )

      const { ctx, notified } = makeHeadlessContext(dir)
      await openCgcSettings(ctx, { homeDir: dir, env: cleanEnv() })

      const text = notified[0]?.message ?? ''
      expect(text).toContain('lifecycle.autoCreate')
      expect(text).toContain('on')
      expect(text).toContain('[config file (project)]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ADR boundary (task 3.3: no tools, no spawns, writes confined to the two config targets)', () => {
  it('the settings module registers no tools, spawns nothing, and imports no runner (source scan)', async () => {
    const { readFileSync: readSource } = await import('node:fs')
    const source = readSource(new URL('./settings-modal.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\bregisterTool\b/)
    expect(source).not.toMatch(/spawnSync|execSync|Bun\.spawn|node:child_process/)
    expect(source).not.toMatch(/from '\.\/runner'/)
  })

  it('a full save flow touches only the chosen config file — an unrelated sentinel file is untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgc-settings-boundary-'))
    try {
      writeFileSync(join(dir, 'sentinel.txt'), 'user content')
      const { ctx } = makeCustomSaveContext(dir, {
        kind: 'save',
        edits: [{ key: 'lifecycle.autoCreate', value: true }],
        target: 'project',
      })

      await openCgcSettings(ctx, { homeDir: dir, env: cleanEnv() })

      expect(readFileSync(join(dir, 'sentinel.txt'), 'utf8')).toBe('user content')
      const entries = readdirSync(dir)
      expect(entries).toContain('.pi')
      expect(entries).toContain('sentinel.txt')
      expect(JSON.parse(readFileSync(resolveProjectConfigPath(dir), 'utf8'))).toEqual({
        lifecycle: { autoCreate: true },
      })
      expect(DEFAULT_CONFIG.lifecycle.autoCreate).toBe(false) // the loader's own state is untouched
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
