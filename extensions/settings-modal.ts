// /cgc config — the in-session settings surface (add-cgc-settings-modal,
// design D1–D6).
//
// Structure mirrors the repo's seam discipline: everything decidable is pure
// and exported (rows, validation, degradation decision, save path, headless
// render); the only impure part is the thin `ctx.ui.custom` overlay component
// (pi-tui SettingsList / SelectList / Input / Text / Box) and the documented
// `ctx.ui.select/input/confirm` fallback flow.
//
// Degradation chain (D1), tried in order:
//   1. `ctx.ui.custom` with `{ overlay: true }` (experimental overlay mode)
//   2. plain `ctx.ui.custom` (non-overlay)
//   3. `ctx.ui.select` / `ctx.ui.input` / `ctx.ui.confirm` dialog flow
//   4. outside `ctx.mode === "tui"` (or every surface broken): the read-only
//      effective key/value/source table — no interactive UI is attempted.
//
// Fail-open (D5): every UI and filesystem failure degrades to a bounded,
// severity-tagged notice and the handler returns; nothing here can throw into
// pi's dispatch. The modal registers no agent tools and spawns no processes
// (ADR 0001); its read paths perform no maintenance work (ADR 0004).
//
// Effect semantics (D3): the modal reads a FRESH `loadConfig` at open time
// (on-disk truth, not the process-lifetime cache) and every save notice states
// that changes apply at the NEXT session start — the running session keeps its
// loaded behavior.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { getSettingsListTheme } from '@earendil-works/pi-coding-agent'
import type { SettingsListTheme } from '@earendil-works/pi-tui'
import {
  Box,
  Container,
  Input,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
  Text,
} from '@earendil-works/pi-tui'
import {
  CONFIG_ENV_VARS,
  type ConfigFileTarget,
  type ConfigKey,
  type ConfigResult,
  loadConfigWithFileWinners,
  mergeConfigEdits,
  resolveGlobalConfigPath,
  resolveProjectConfigPath,
  type ValueRule,
  validateBooleanValue,
  validateExecutableValue,
  validateMaxBytesValue,
  validateMaxSyncsPerSessionValue,
  validatePortValue,
  validateTimeoutMsValue,
  validateWorktreeModeValue,
} from './config'

// ---------------------------------------------------------------------------
// Key metadata: the editable-key list and per-key interaction kind (D4)
// ---------------------------------------------------------------------------

/** How the modal edits one config key. */
export type SettingsKeyKind = 'boolean' | 'enum' | 'number' | 'string'

/**
 * Every config key is file-layer-writable (design D5): the only runtime
 * read-only condition is an env-sourced effective value. `worktree.mode` is
 * the sole enum; numeric and string keys go through the in-modal text input.
 */
export const SETTINGS_KEY_KINDS: Readonly<Record<ConfigKey, SettingsKeyKind>> = Object.freeze({
  'cgc.executable': 'string',
  'cgc.timeoutMs': 'number',
  'cgc.versionProbeTimeoutMs': 'number',
  'cgc.api.enabled': 'boolean',
  'cgc.api.port': 'number',
  'lifecycle.autoCreate': 'boolean',
  'lifecycle.syncOnStart': 'boolean',
  'worktree.mode': 'enum',
  'proactive.sessionNote': 'boolean',
  'proactive.driftSteers': 'boolean',
  'proactive.resultAnnotations': 'boolean',
  'freshness.watch': 'boolean',
  'freshness.autoSync': 'boolean',
  'freshness.maxSyncsPerSession': 'number',
  'output.maxBytes': 'number',
  'output.spillToTemp': 'boolean',
  'output.redactSecrets': 'boolean',
  'output.gcf': 'boolean',
  'tools.cliGap.enabled': 'boolean',
  'guidance.routingSkill': 'boolean',
})

const NUMBER_VALIDATORS: Readonly<Partial<Record<ConfigKey, (raw: unknown) => ValueRule<number>>>> =
  Object.freeze({
    'cgc.timeoutMs': validateTimeoutMsValue,
    'cgc.versionProbeTimeoutMs': validateTimeoutMsValue,
    'cgc.api.port': validatePortValue,
    'output.maxBytes': validateMaxBytesValue,
    'freshness.maxSyncsPerSession': validateMaxSyncsPerSessionValue,
  })

const BOOLEAN_KEYS: ReadonlySet<ConfigKey> = new Set(
  (Object.keys(SETTINGS_KEY_KINDS) as ConfigKey[]).filter(
    (key) => SETTINGS_KEY_KINDS[key] === 'boolean',
  ),
)

/**
 * Validate one edit against the SAME rule its loader enforces (design D4).
 * Accepts the string forms the file layer accepts (`Number(raw)`, the
 * parseBoolean vocabulary) plus native JSON values. The `error` text is the
 * loader's own message shape, so a modal rejection and a loader skip read the
 * same way.
 */
export function validateSettingValue(
  key: ConfigKey,
  raw: unknown,
): ValueRule<boolean | number | string> {
  const kind = SETTINGS_KEY_KINDS[key]
  if (kind === 'boolean') return validateBooleanValue(raw)
  if (kind === 'enum') return validateWorktreeModeValue(raw)
  if (kind === 'number') {
    const validator = NUMBER_VALIDATORS[key]
    return validator !== undefined
      ? validator(raw)
      : { ok: false, error: 'expected a positive number' }
  }
  return validateExecutableValue(raw)
}

/** The validation rule text for one key (the loader's own rejection message). */
export function validationRuleText(key: ConfigKey): string {
  const kind = SETTINGS_KEY_KINDS[key]
  if (kind === 'boolean') return 'expected 1/true/yes/on or 0/false/no/off'
  if (kind === 'enum') return 'expected "off" or "isolate"'
  if (kind === 'string') return 'expected a non-empty string'
  const validator = NUMBER_VALIDATORS[key]
  if (validator === undefined) return 'expected a positive number'
  const invalid = validator('\u0000')
  return invalid.ok ? 'expected a positive number' : invalid.error
}

/**
 * The SettingsList theme. Fail-open (D5): `getSettingsListTheme()` throws
 * when pi's theme subsystem is not initialized; a plain fallback keeps the
 * modal renderable instead of degrading the whole surface.
 */
function modalSettingsListTheme(): SettingsListTheme {
  try {
    return getSettingsListTheme()
  } catch {
    return {
      label: (text) => text,
      value: (text) => text,
      description: (text) => text,
      cursor: '→ ',
      hint: (text) => text,
    }
  }
}

/** Display text for one effective value (booleans render on/off). */
export function settingValueText(key: ConfigKey, value: boolean | number | string): string {
  if (BOOLEAN_KEYS.has(key)) return value ? 'on' : 'off'
  return String(value)
}

// ---------------------------------------------------------------------------
// Rows: the fresh-load key/effective-value/source display model (task 1.3)
// ---------------------------------------------------------------------------

/** Where the effective value of one key lives. */
export type SettingsSource = 'default' | 'config-file' | 'env'

/** How the modal treats one key in this session's modal state. */
export type SettingsRowKind = 'cycle' | 'text' | 'readonly'

export interface SettingsRow {
  key: ConfigKey
  /** The effective raw value (booleans as booleans, numbers as numbers). */
  rawValue: boolean | number | string
  /** Human display of the effective value. */
  valueText: string
  /** The load-time source layer (`ConfigResult.sources`). */
  source: SettingsSource
  /** The winning env var when `source === 'env'`, else undefined. */
  envVar: string | undefined
  /** Which file won the layering when `source === 'config-file'` (D5). */
  fileWinner: 'global' | 'project' | undefined
  /** The interaction kind: cycle / text / read-only. */
  kind: SettingsRowKind
}

/** Read the effective values off a loaded config, in CONFIG_ENV_VARS order. */
const CONFIG_VALUE_GETTERS: Readonly<
  Record<ConfigKey, (config: ConfigResult['config']) => boolean | number | string>
> = Object.freeze({
  'cgc.executable': (c) => c.cgc.executable,
  'cgc.timeoutMs': (c) => c.cgc.timeoutMs,
  'cgc.versionProbeTimeoutMs': (c) => c.cgc.versionProbeTimeoutMs,
  'cgc.api.enabled': (c) => c.cgc.api.enabled,
  'cgc.api.port': (c) => c.cgc.api.port,
  'lifecycle.autoCreate': (c) => c.lifecycle.autoCreate,
  'lifecycle.syncOnStart': (c) => c.lifecycle.syncOnStart,
  'worktree.mode': (c) => c.worktree.mode,
  'proactive.sessionNote': (c) => c.proactive.sessionNote,
  'proactive.driftSteers': (c) => c.proactive.driftSteers,
  'proactive.resultAnnotations': (c) => c.proactive.resultAnnotations,
  'freshness.watch': (c) => c.freshness.watch,
  'freshness.autoSync': (c) => c.freshness.autoSync,
  'freshness.maxSyncsPerSession': (c) => c.freshness.maxSyncsPerSession,
  'output.maxBytes': (c) => c.output.maxBytes,
  'output.spillToTemp': (c) => c.output.spillToTemp,
  'output.redactSecrets': (c) => c.output.redactSecrets,
  'output.gcf': (c) => c.output.gcf,
  'tools.cliGap.enabled': (c) => c.tools.cliGap.enabled,
  'guidance.routingSkill': (c) => c.guidance.routingSkill,
})

const CONFIG_KEYS_IN_ORDER: readonly ConfigKey[] = Object.keys(CONFIG_ENV_VARS) as ConfigKey[]

/**
 * Build the modal's row model from a fresh `loadConfigWithFileWinners` result
 * (task 1.3). Env-sourced keys are read-only rows annotated with the winning
 * env var (D5) — the modal never offers an edit it cannot make effective.
 */
export function buildSettingsRows(
  result: ConfigResult,
  fileWinners: Partial<Record<ConfigKey, 'global' | 'project'>> = {},
): SettingsRow[] {
  return CONFIG_KEYS_IN_ORDER.map((key) => {
    const rawValue = CONFIG_VALUE_GETTERS[key](result.config)
    const source = result.sources[key]
    return {
      key,
      rawValue,
      valueText: settingValueText(key, rawValue),
      source,
      envVar: source === 'env' ? CONFIG_ENV_VARS[key] : undefined,
      fileWinner: source === 'config-file' ? (fileWinners[key] ?? undefined) : undefined,
      kind:
        source === 'env'
          ? 'readonly'
          : SETTINGS_KEY_KINDS[key] === 'boolean' || SETTINGS_KEY_KINDS[key] === 'enum'
            ? 'cycle'
            : 'text',
    }
  })
}

/** The per-row source annotation (which layer — and which file — won). */
export function settingsSourceAnnotation(row: SettingsRow): string {
  if (row.source === 'env') return `env override ${row.envVar} — read-only`
  if (row.source === 'config-file') {
    const file =
      row.fileWinner === 'project'
        ? 'project .pi/cgc.json'
        : row.fileWinner === 'global'
          ? 'global cgc.json'
          : 'project/global'
    return `config file (${file})`
  }
  return 'built-in default'
}

// ---------------------------------------------------------------------------
// Degradation decision (D1 step 4) and the target/save model (D2)
// ---------------------------------------------------------------------------

export type SettingsUiDecision = 'tui' | 'dialogs' | 'readonly'

export interface SettingsUiCapabilities {
  /** `ctx.mode` — only `tui` may attempt terminal input. */
  mode: string | undefined
  /** Whether `ctx.ui.custom` exists. */
  hasCustom: boolean
  /** Whether the documented dialog surfaces exist. */
  hasDialogs: boolean
}

/**
 * Decide the degradation step up front (design D1): `ctx.mode === "tui"` gates
 * ALL terminal input (`ctx.hasUI` is true in RPC and cannot gate). Inside the
 * TUI the overlay-vs-plain-custom ordering is attempted by the caller; this
 * decision only separates custom → dialogs → read-only.
 */
export function decideSettingsUi(caps: SettingsUiCapabilities): SettingsUiDecision {
  if (caps.mode !== 'tui') return 'readonly'
  if (caps.hasCustom) return 'tui'
  if (caps.hasDialogs) return 'dialogs'
  return 'readonly'
}

/** The two config-file paths the modal saves between. */
export function resolveTargetPaths(
  cwd: string,
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
): { project: string; global: string } {
  return {
    project: resolveProjectConfigPath(cwd),
    global: resolveGlobalConfigPath(homeDir, env),
  }
}

export function resolveTargetPath(
  target: ConfigFileTarget,
  cwd: string,
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return target === 'project'
    ? resolveProjectConfigPath(cwd)
    : resolveGlobalConfigPath(homeDir, env)
}

/** One staged edit: a config key and its validated value. */
export interface StagedEdit {
  key: ConfigKey
  value: boolean | number | string
}

export interface SettingsSaveRequest {
  edits: readonly StagedEdit[]
  target: ConfigFileTarget
  cwd: string
  homeDir: string
  env?: Record<string, string | undefined>
  /**
   * Offered when the target file does not exist yet (design D2): return true
   * to create a fresh `{}` object; anything else refuses with nothing written.
   */
  confirmCreate?: () => boolean | Promise<boolean>
}

export type SettingsSaveResult =
  | { ok: true; path: string; message: string }
  | { ok: false; message: string }

/**
 * The save path (D2/D4/D5): re-validates EVERY staged edit (invalid values
 * never reach the write path), refuses on a missing file unless the caller
 * confirms creation, then delegates to the never-clobber atomic merge writer.
 * Never throws.
 */
export async function saveSettingsEdits(request: SettingsSaveRequest): Promise<SettingsSaveResult> {
  if (request.edits.length === 0) {
    return { ok: false, message: 'cgc config: no edits were staged; nothing was written.' }
  }
  for (const edit of request.edits) {
    const validated = validateSettingValue(edit.key, edit.value)
    if (!validated.ok) {
      return {
        ok: false,
        message: `cgc config: refusing to save ${edit.key}: ${validated.error}; nothing was written.`,
      }
    }
  }
  const targetPath = resolveTargetPath(request.target, request.cwd, request.homeDir, request.env)
  let createIfMissing = false
  if (!existsSync(targetPath)) {
    const confirmed = request.confirmCreate === undefined ? false : await request.confirmCreate()
    if (!confirmed) {
      return {
        ok: false,
        message: `cgc config: ${targetPath} does not exist — save declined; nothing was written.`,
      }
    }
    createIfMissing = true
  }
  const result = mergeConfigEdits(
    targetPath,
    request.edits.map((edit) => ({ key: edit.key, value: edit.value })),
    { createIfMissing },
  )
  if (!result.ok) {
    return { ok: false, message: `cgc config: ${result.message}` }
  }
  return {
    ok: true,
    path: result.path,
    message:
      `cgc config: saved ${result.writtenKeys.length} edit(s) to ${result.path}. ` +
      'Changes apply at the next session start — this running session keeps its current behavior.',
  }
}

// ---------------------------------------------------------------------------
// Headless read-only render (D1 step 4 / "Headless degradation")
// ---------------------------------------------------------------------------

/**
 * The read-only effective key/value/source table. Rendered verbatim outside
 * the TUI, and as the final fail-open fallback when every interactive surface
 * is broken. `interactiveUnavailable` prefixes a warning line naming the
 * degradation (D5).
 */
export function renderHeadlessSettings(
  rows: readonly SettingsRow[],
  paths: { project: string; global: string },
  interactiveUnavailable = false,
): string {
  const width = rows.reduce((max, row) => Math.max(max, row.key.length), 0)
  const lines: string[] = interactiveUnavailable
    ? ['cgc config: interactive settings UI is unavailable — effective settings (read-only):']
    : ['cgc config: effective settings (read-only outside the TUI)']
  lines.push(`project config: ${paths.project}`)
  lines.push(`global config: ${paths.global}`)
  for (const row of rows) {
    const source =
      row.source === 'env'
        ? `env (${row.envVar})`
        : row.source === 'config-file'
          ? `config file (${row.fileWinner ?? 'project/global'})`
          : 'default'
    lines.push(`  ${row.key.padEnd(width)}  ${row.valueText}  [${source}]`)
  }
  lines.push(
    'Edit the files above to change settings (environment overrides win); changes apply at the next session start.',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// The TUI modal (D1 steps 1–2) — thin pi-tui composition
// ---------------------------------------------------------------------------

const SAVE_TARGET_ITEM_ID = '__cgc_save_target'
/** ctrl+s — the explicit save key inside the modal (ESC closes without saving). */
const SAVE_KEY = '\u0013'

export interface SettingsModalOutcome {
  kind: 'save' | 'cancel'
  edits: StagedEdit[]
  target: ConfigFileTarget
}

interface ModalTheme {
  fg(color: string, text: string): string
  bold(text: string): string
}

/**
 * Build the modal component: a SettingsList (cycling booleans/enums with
 * fuzzy search; text keys open an Input picker; the save-target row opens a
 * SelectList picker), a staged-edits model, ESC close, and ctrl+s save.
 * Edits are staged here and persisted only by the explicit save path.
 */
export function buildSettingsModalComponent(params: {
  theme: ModalTheme
  rows: readonly SettingsRow[]
  initialTarget: ConfigFileTarget
  paths: { project: string; global: string }
  onClose: (outcome: SettingsModalOutcome) => void
}): { render(width: number): string[]; invalidate(): void; handleInput(data: string): void } {
  const staged = new Map<ConfigKey, boolean | number | string>()
  let target: ConfigFileTarget = params.initialTarget

  const sourceDescription = (row: SettingsRow): string => {
    const rule = row.kind === 'readonly' ? undefined : `rule: ${validationRuleText(row.key)} —`
    return [rule, settingsSourceAnnotation(row)].filter((part) => part !== undefined).join(' ')
  }

  const selectPickerSubmenu =
    (title: string, items: SelectItem[]) =>
    (currentValue: string, done: (selectedValue?: string) => void) => {
      const container = new Container()
      container.addChild(new Text(params.theme.fg('accent', params.theme.bold(title)), 1, 0))
      const list = new SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (t) => params.theme.fg('accent', t),
        selectedText: (t) => params.theme.fg('accent', t),
        description: (t) => params.theme.fg('muted', t),
        scrollInfo: (t) => params.theme.fg('dim', t),
        noMatch: (t) => params.theme.fg('warning', t),
      })
      list.setSelectedIndex(
        Math.max(
          0,
          items.findIndex((item) => item.value === currentValue),
        ),
      )
      list.onSelect = (item) => done(item.value)
      list.onCancel = () => done()
      container.addChild(list)
      container.addChild(
        new Text(params.theme.fg('dim', '↑↓ navigate • enter select • esc cancel'), 1, 0),
      )
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data)
        },
      }
    }

  const textInputSubmenu =
    (row: SettingsRow) => (currentValue: string, done: (selectedValue?: string) => void) => {
      const container = new Container()
      container.addChild(
        new Text(params.theme.fg('accent', `${row.key} — ${validationRuleText(row.key)}`), 1, 0),
      )
      const errorText = new Text('', 1, 0)
      const input = new Input({ prompt: 'new value: ', placeholder: currentValue })
      input.setValue(row.kind === 'text' ? String(row.rawValue) : '')
      input.onSubmit = (value: string) => {
        const validated = validateSettingValue(row.key, value)
        if (!validated.ok) {
          // Invalid input is rejected INSIDE the modal and never staged (D4).
          errorText.setText(params.theme.fg('warning', `${row.key}: ${validated.error}`))
          errorText.invalidate()
          return
        }
        done(settingValueText(row.key, validated.value))
      }
      input.onEscape = () => done()
      container.addChild(input)
      container.addChild(errorText)
      container.addChild(new Text(params.theme.fg('dim', 'enter submit • esc cancel'), 1, 0))
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          input.handleInput(data)
        },
      }
    }

  const items: SettingItem[] = [
    {
      id: SAVE_TARGET_ITEM_ID,
      label: 'Save target',
      description: `where staged edits are written — project ${params.paths.project} or global ${params.paths.global}`,
      currentValue: target,
      submenu: selectPickerSubmenu('Save to which config file?', [
        {
          value: 'project',
          label: `project — ${params.paths.project}`,
          description: 'this workspace (wins the layering here)',
        },
        {
          value: 'global',
          label: `global — ${params.paths.global}`,
          description: 'cross-project defaults',
        },
      ]),
    },
    ...params.rows.map(
      (row): SettingItem => ({
        id: row.key,
        label: row.key,
        description: sourceDescription(row),
        currentValue: row.valueText,
        ...(row.kind === 'readonly'
          ? {}
          : row.kind === 'cycle'
            ? { values: row.key === 'worktree.mode' ? ['off', 'isolate'] : ['on', 'off'] }
            : { submenu: textInputSubmenu(row) }),
      }),
    ),
  ]

  const settingsList = new SettingsList(
    items,
    Math.min(items.length + 2, 15),
    modalSettingsListTheme(),
    (id: string, newValue: string) => {
      if (id === SAVE_TARGET_ITEM_ID) {
        target = newValue === 'global' ? 'global' : 'project'
        return
      }
      const validated = validateSettingValue(id as ConfigKey, newValue)
      if (validated.ok) staged.set(id as ConfigKey, validated.value)
    },
    () => params.onClose({ kind: 'cancel', edits: [], target }),
    { enableSearch: true },
  )

  const container = new Container()
  container.addChild(new Text(params.theme.fg('accent', params.theme.bold('CGC settings')), 1, 0))
  container.addChild(
    new Text(
      params.theme.fg(
        'muted',
        `save target: ${target === 'project' ? params.paths.project : params.paths.global}`,
      ),
      1,
      0,
    ),
  )
  container.addChild(settingsList)
  const help = new Box(1, 0)
  help.addChild(
    new Text(
      params.theme.fg(
        'dim',
        'type to search • enter edit • esc close (discard) • ctrl+s save — changes apply at the next session start',
      ),
      0,
      0,
    ),
  )
  container.addChild(help)

  return {
    render: (width: number) => container.render(width),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => {
      if (data === SAVE_KEY) {
        params.onClose({
          kind: 'save',
          edits: [...staged].map(([key, value]) => ({ key, value })),
          target,
        })
        return
      }
      settingsList.handleInput(data)
    },
  }
}

// ---------------------------------------------------------------------------
// The command entry point: fresh load + degradation chain + fail-open
// ---------------------------------------------------------------------------

/** Minimal guarded notify (the repo's commands.ts convention). */
function notifyOnce(
  ctx: { ui?: { notify?: (message: string, type?: 'info' | 'warning' | 'error') => void } },
  message: string,
  type: 'info' | 'warning' | 'error',
): void {
  try {
    ctx.ui?.notify?.(message, type)
  } catch {
    // Fail-open: a throwing notify sink must never break the command.
  }
}

export interface CgcSettingsDeps {
  /** Home directory for the global target; defaults to `os.homedir()`. */
  homeDir?: string
  /** Environment for PI_CODING_AGENT_DIR; defaults to `process.env`. */
  env?: Record<string, string | undefined>
}

/**
 * Run `/cgc config` (design D1–D6): open the settings modal in the TUI, run
 * the dialog flow when `ctx.ui.custom` is unavailable, or render the read-only
 * table otherwise. Never throws into the command dispatch.
 */
export async function openCgcSettings(
  ctx: ExtensionCommandContext,
  deps: CgcSettingsDeps = {},
): Promise<void> {
  try {
    const env = deps.env ?? process.env
    const homeDir = deps.homeDir ?? homedir()
    const cwd = ctx.cwd
    const paths = resolveTargetPaths(cwd, homeDir, env)

    // D3: a FRESH load at open time — on-disk truth, not the process cache.
    const loaded = loadConfigWithFileWinners({ cwd, homeDir, env })
    const rows = buildSettingsRows(loaded, loaded.fileWinners)

    const decision = decideSettingsUi({
      mode: typeof ctx.mode === 'string' ? ctx.mode : undefined,
      hasCustom: typeof (ctx.ui as { custom?: unknown } | undefined)?.custom === 'function',
      hasDialogs:
        typeof (ctx.ui as { select?: unknown } | undefined)?.select === 'function' &&
        typeof (ctx.ui as { input?: unknown } | undefined)?.input === 'function' &&
        typeof (ctx.ui as { confirm?: unknown } | undefined)?.confirm === 'function',
    })

    if (decision === 'readonly') {
      notifyOnce(ctx, renderHeadlessSettings(rows, paths), 'info')
      return
    }

    const session = { rows, paths, homeDir, env, cwd }

    if (decision === 'tui') {
      // D1 steps 1–2: overlay first, plain custom second; either outcome is
      // handled identically, a throw degrades to the next step.
      for (const overlay of [true, false]) {
        try {
          const outcome = await showCustomModal(ctx, session, overlay)
          await applyModalOutcome(ctx, outcome, session)
          return
        } catch {
          // Degrade: try the next step of the chain.
        }
      }
    }

    // D1 step 3: the documented dialog flow.
    try {
      await runDialogFlow(ctx, session)
      return
    } catch {
      // Fall through to the final read-only fallback.
    }

    notifyOnce(ctx, renderHeadlessSettings(rows, paths, true), 'warning')
  } catch {
    // Fail-open (D5): the settings command can never crash or block the session.
    notifyOnce(
      ctx,
      'cgc config: the settings command failed unexpectedly; nothing was changed.',
      'error',
    )
  }
}

interface SettingsSession {
  rows: SettingsRow[]
  paths: { project: string; global: string }
  homeDir: string
  env: Record<string, string | undefined>
  cwd: string
}

async function showCustomModal(
  ctx: ExtensionCommandContext,
  session: SettingsSession,
  overlay: boolean,
): Promise<SettingsModalOutcome> {
  const ui = ctx.ui as {
    custom?: <T>(
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => { render(width: number): string[]; invalidate(): void; handleInput(data: string): void },
      options?: { overlay?: boolean },
    ) => Promise<T>
  }
  if (typeof ui.custom !== 'function') throw new Error('ctx.ui.custom unavailable')
  const initialTarget: ConfigFileTarget = 'project'
  return await ui.custom<SettingsModalOutcome>(
    (_tui, theme, _keybindings, done) =>
      buildSettingsModalComponent({
        theme: theme as ModalTheme,
        rows: session.rows,
        initialTarget,
        paths: session.paths,
        onClose: done,
      }),
    overlay ? { overlay: true } : undefined,
  )
}

async function applyModalOutcome(
  ctx: ExtensionCommandContext,
  outcome: SettingsModalOutcome,
  session: SettingsSession,
): Promise<void> {
  if (outcome.kind !== 'save') return // ESC close: discard, no notice noise.
  const result = await saveSettingsEdits({
    edits: outcome.edits,
    target: outcome.target,
    cwd: session.cwd,
    homeDir: session.homeDir,
    env: session.env,
    confirmCreate: () =>
      confirmDialog(
        ctx,
        'Create the config file?',
        `${resolveTargetPath(outcome.target, session.cwd, session.homeDir, session.env)} does not exist yet. Create it with the staged edits?`,
      ),
  })
  notifyOnce(ctx, result.message, result.ok ? 'info' : 'warning')
}

/** Guarded dialog seams (the dialogs fallback and the create-file confirm). */
async function confirmDialog(
  ctx: ExtensionCommandContext,
  title: string,
  message: string,
): Promise<boolean> {
  const ui = ctx.ui as { confirm?: (title: string, message: string) => Promise<boolean> }
  if (typeof ui.confirm !== 'function') return false
  return (await ui.confirm(title, message)) === true
}

/**
 * D1 step 3: the documented dialog flow — pick a key, pick/enter a value,
 * confirm, choose the target, save. Every dialog resolution is guarded; the
 * flow returns on cancel/ESC and any throw degrades to the read-only fallback.
 */
async function runDialogFlow(
  ctx: ExtensionCommandContext,
  session: SettingsSession,
): Promise<void> {
  const ui = ctx.ui as {
    select?: (title: string, options: string[]) => Promise<string | undefined>
    input?: (title: string, placeholder?: string) => Promise<string | undefined>
    confirm?: (title: string, message: string) => Promise<boolean>
  }
  if (
    typeof ui.select !== 'function' ||
    typeof ui.input !== 'function' ||
    typeof ui.confirm !== 'function'
  ) {
    throw new Error('dialog surfaces unavailable')
  }

  // Show the full read-only table first (env keys have no edit offer here).
  notifyOnce(ctx, renderHeadlessSettings(session.rows, session.paths), 'info')

  const staged = new Map<ConfigKey, boolean | number | string>()

  for (;;) {
    const editable = session.rows.filter((row) => row.kind !== 'readonly')
    const pick = await ui.select(
      'cgc config — edit which setting?',
      editable.map((row) => `${row.key} = ${row.valueText}  (${settingsSourceAnnotation(row)})`),
    )
    if (pick === undefined) return
    const row = editable.find((candidate) => pick.startsWith(`${candidate.key} =`))
    if (row === undefined) continue

    if (row.kind === 'cycle') {
      const options = row.key === 'worktree.mode' ? ['off', 'isolate'] : ['on', 'off']
      const chosen = await ui.select(`${row.key} — choose a value`, options)
      if (chosen !== undefined) {
        const validated = validateSettingValue(row.key, chosen)
        if (validated.ok) staged.set(row.key, validated.value)
      }
    } else {
      const raw = await ui.input(
        `${row.key} — ${validationRuleText(row.key)}`,
        String(row.rawValue),
      )
      if (raw === undefined) continue
      const validated = validateSettingValue(row.key, raw)
      if (!validated.ok) {
        // Rejected with the loader's message; nothing is staged (D4).
        notifyOnce(ctx, `cgc config: ${row.key}: ${validated.error}`, 'warning')
        continue
      }
      staged.set(row.key, validated.value)
    }

    const summary =
      staged.size === 0
        ? 'nothing staged'
        : [...staged].map(([key, value]) => `${key} = ${settingValueText(key, value)}`).join(', ')
    const saveNow = await ui.confirm(
      'Save staged edits?',
      `${summary}\n\nTarget file: project ${session.paths.project} or global ${session.paths.global}. Changes apply at the next session start.`,
    )
    if (!saveNow) continue

    const targetChoice = await ui.select('Save to which config file?', [
      `project — ${session.paths.project}`,
      `global — ${session.paths.global}`,
    ])
    if (targetChoice === undefined) return
    const target: ConfigFileTarget = targetChoice.startsWith('global') ? 'global' : 'project'

    const result = await saveSettingsEdits({
      edits: [...staged].map(([key, value]) => ({ key, value })),
      target,
      cwd: session.cwd,
      homeDir: session.homeDir,
      env: session.env,
      confirmCreate: () =>
        confirmDialog(
          ctx,
          'Create the config file?',
          `${resolveTargetPath(target, session.cwd, session.homeDir, session.env)} does not exist yet. Create it with the staged edits?`,
        ),
    })
    notifyOnce(ctx, result.message, result.ok ? 'info' : 'warning')
    return
  }
}
