import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import type {
  CgcCommandDependencies,
  CgcConsentSurface,
  CgcFreshnessSummary,
  CgcStatusState,
  CgcStatusView,
} from './commands'
import {
  boundText,
  buildStatusView,
  CGC_COMMAND_NAME,
  CGC_REPORT_FILENAME,
  CGC_SUBCOMMANDS,
  cgcUnavailableNotice,
  confirmForceRebuild,
  confirmReportWrite,
  DOCTOR_ARGS,
  doctorStartedNotice,
  doctorUnknownArgumentNotice,
  forceRebuildConsentMessage,
  forceRebuildDeclinedNotice,
  handleCgcInvocation,
  INDEX_FORCE_FLAG,
  indexAlreadyInFlightNotice,
  indexCreationDeclinedNotice,
  indexStartedNotice,
  indexUnknownOptionNotice,
  lifecycleStateLabel,
  OUTPUT_TEXT_BUDGET,
  parseIndexOptions,
  REPORT_OUTPUT_FLAG,
  registerCgcCommands,
  renderCommandText,
  renderStatusText,
  reportArgs,
  reportStartedNotice,
  reportUnknownArgumentNotice,
  reportWriteConsentMessage,
  reportWriteDeclinedNotice,
  resolveReportDestination,
  stripControlSequences,
  syncDeclinedNotice,
  syncJoinInFlightNotice,
  syncStartedNotice,
  syncUnknownArgumentNotice,
  timeAgo,
  truncationMarker,
  usageText,
} from './commands'
import type { LifecycleAction, LifecycleActionInput, LifecycleSnapshot } from './lifecycle-state'
import { type CgcCommandResult, CgcRunner } from './runner'

// ---------------------------------------------------------------------------
// Test scaffolding: a recording pi API and a fake command context.
// ---------------------------------------------------------------------------

interface Registration {
  name: string
  description: string | undefined
  getArgumentCompletions: ((prefix: string) => unknown) | undefined
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
}

function makeRecordingApi(): { api: ExtensionAPI; registrations: Registration[] } {
  const registrations: Registration[] = []
  const api = {
    on() {
      return undefined
    },
    registerCommand(
      name: string,
      options: {
        description?: string
        getArgumentCompletions?: (prefix: string) => unknown
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
      },
    ) {
      registrations.push({
        name,
        description: options.description,
        getArgumentCompletions: options.getArgumentCompletions,
        handler: options.handler,
      })
    },
  }
  return { api: api as unknown as ExtensionAPI, registrations }
}

interface Notified {
  message: string
  type: 'info' | 'warning' | 'error'
}

function makeContext(
  notifyImpl?: (message: string, type: 'info' | 'warning' | 'error') => void,
  cwd: string = '/ws',
  confirmImpl?: () => boolean | Promise<boolean>,
): {
  ctx: ExtensionCommandContext
  notified: Notified[]
} {
  const notified: Notified[] = []
  const ui = {
    notify(message: string, type: 'info' | 'warning' | 'error'): void {
      if (notifyImpl !== undefined) {
        notifyImpl(message, type)
        return
      }
      notified.push({ message, type })
    },
    // Structural match for the consent surface (task 2.1): the fake command
    // context can be passed straight to the consent gates like the real one.
    async confirm(_title: string, _message: string): Promise<boolean> {
      return confirmImpl !== undefined ? await confirmImpl() : true
    },
  }
  const ctx = {
    cwd,
    mode: 'tui',
    hasUI: true,
    ui,
  }
  return { ctx: ctx as unknown as ExtensionCommandContext, notified }
}

/**
 * A print/JSON-mode (headless) command context: `hasUI` is false, so the
 * consent gate must decline without ever touching the dialog (validate.md
 * headless-safe requirement).
 */
function makeHeadlessContext(): { ctx: ExtensionCommandContext; notified: Notified[] } {
  const notified: Notified[] = []
  const ctx = {
    cwd: '/ws',
    mode: 'print',
    hasUI: false,
    ui: {
      notify(message: string, type: 'info' | 'warning' | 'error'): void {
        notified.push({ message, type })
      },
      async confirm(): Promise<boolean> {
        throw new Error('dialog must not be touched without a UI')
      },
    },
  }
  return { ctx: ctx as unknown as ExtensionCommandContext, notified }
}

interface ConsentPrompt {
  title: string
  message: string
}

/**
 * A recording consent surface for the task 2.1 gates: `confirmImpl` decides
 * the dialog answer (default true); the prompt history lets tests assert the
 * exact title/message the gate presented.
 */
function makeConsentContext(
  confirmImpl?: () => boolean | Promise<boolean>,
  hasUI: boolean = true,
): { ctx: CgcConsentSurface; prompts: ConsentPrompt[] } {
  const prompts: ConsentPrompt[] = []
  const ctx: CgcConsentSurface = {
    hasUI,
    ui: {
      async confirm(title: string, message: string): Promise<boolean> {
        prompts.push({ title, message })
        return confirmImpl !== undefined ? await confirmImpl() : true
      },
    },
  }
  return { ctx, prompts }
}

const VERBS = CGC_SUBCOMMANDS.map((spec) => spec.verb)

/**
 * CGC verbs that delete or clean data (gated by CGC's deletion-safety
 * configuration) — the command surface must never expose any of these
 * (spec: "No destructive verbs exposed"; ADR 0003).
 */
const DESTRUCTIVE_VERBS = ['clean', 'delete', 'rm', 'cleanup', 'rebuild']

// ---------------------------------------------------------------------------
// Task 1.2 fixtures: lifecycle snapshots and dependency surfaces.
// ---------------------------------------------------------------------------

function makeAction(overrides: Partial<LifecycleAction> = {}): LifecycleAction {
  return {
    kind: 'classified',
    cwd: '/ws',
    detail: 'index is healthy; no maintenance work needed',
    ok: null,
    at: Date.now(),
    ...overrides,
  }
}

function makeSnapshot(overrides: Partial<LifecycleSnapshot> = {}): LifecycleSnapshot {
  return {
    cwd: '/ws',
    state: 'clean',
    activity: 'idle',
    indexed: true,
    lastAction: null,
    reason: null,
    classifiedAt: null,
    stateChangedAt: null,
    updatedAt: Date.now(),
    actions: [],
    ...overrides,
  }
}

function makeStateSurface(
  overrides: {
    snapshot?: (cwd: string) => LifecycleSnapshot | null
    isInFlight?: (cwd: string) => boolean
  } = {},
): { state: CgcStatusState; reads: string[] } {
  const reads: string[] = []
  const state: CgcStatusState = {
    snapshot(cwd: string): LifecycleSnapshot | null {
      reads.push(`snapshot:${cwd}`)
      return overrides.snapshot !== undefined ? overrides.snapshot(cwd) : makeSnapshot()
    },
    isInFlight(cwd: string): boolean {
      reads.push(`isInFlight:${cwd}`)
      return overrides.isInFlight !== undefined ? overrides.isInFlight(cwd) : false
    },
  }
  return { state, reads }
}

// ---------------------------------------------------------------------------
// Task 2.2 fixtures: a controllable fake runner and a recordAction spy.
// ---------------------------------------------------------------------------

interface FakeRun {
  cwd: string
  args: string[]
  /** Resolve the fake spawn with a result (OK / BUSY / COMMAND_FAILED / …). */
  settle: (result: CgcCommandResult) => void
}

/** A controllable stand-in for {@link CgcRunner} (run returns a settle-able promise). */
function makeFakeRunner(): { runner: CgcRunner; runs: FakeRun[]; inflight: Set<string> } {
  const runs: FakeRun[] = []
  const inflight = new Set<string>()
  const runner = {
    isInFlight(cwd: string): boolean {
      return inflight.has(cwd)
    },
    run(cwd: string, options: { args: readonly string[] }): Promise<CgcCommandResult> {
      let settle: (result: CgcCommandResult) => void = () => {}
      const promise = new Promise<CgcCommandResult>((resolve) => {
        settle = resolve
      })
      runs.push({ cwd, args: [...options.args], settle })
      return promise
    },
  }
  return { runner: runner as unknown as CgcRunner, runs, inflight }
}

function makeResult(overrides: Partial<CgcCommandResult> = {}): CgcCommandResult {
  return {
    ok: true,
    code: 'OK',
    message: 'cgc exited 0',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    durationMs: 1,
    argv: [],
    cwd: '/ws',
    ...overrides,
  }
}

interface RecordedAction {
  kind: string
  cwd: string
  detail: string
  ok: boolean | null
}

/** A recordAction sink that captures every recorded lifecycle action. */
function makeRecordSpy(): {
  recordAction: (input: LifecycleActionInput) => void
  actions: RecordedAction[]
} {
  const actions: RecordedAction[] = []
  return {
    recordAction(input: LifecycleActionInput): void {
      actions.push({ kind: input.kind, cwd: input.cwd, detail: input.detail, ok: input.ok ?? null })
    },
    actions,
  }
}

/** A real (temporary) workspace that IS indexed (contains `.codegraphcontext/`). */
function makeIndexedWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cgc-index-test-'))
  mkdirSync(join(dir, '.codegraphcontext'))
  return dir
}

// ---------------------------------------------------------------------------
// Registration surface (task 1.1)
// ---------------------------------------------------------------------------

describe('CGC_SUBCOMMANDS (the registered command list)', () => {
  it('is exactly the five documented commands, in usage order', () => {
    expect(VERBS).toEqual(['status', 'index', 'sync', 'doctor', 'report'])
  })

  it('never exposes CGC deletion/cleanup verbs (ADR 0003)', () => {
    for (const forbidden of DESTRUCTIVE_VERBS) {
      expect(VERBS).not.toContain(forbidden)
    }
  })

  it('describes every subcommand for the usage text and completions', () => {
    for (const spec of CGC_SUBCOMMANDS) {
      expect(spec.verb).toBeTypeOf('string')
      expect(spec.verb.length).toBeGreaterThan(0)
      expect(spec.description).toBeTypeOf('string')
      expect(spec.description.length).toBeGreaterThan(0)
    }
  })
})

describe('registerCgcCommands', () => {
  it('registers ONE bare cgc command (single registration: pi would resolve /cgc without a :1 suffix)', () => {
    const { api, registrations } = makeRecordingApi()

    registerCgcCommands(api)

    expect(registrations).toHaveLength(1)
    const [registration] = registrations
    expect(registration?.name).toBe(CGC_COMMAND_NAME)
    // The bare name carries no numeric suffix (pi appends ":n" only when the
    // same name is registered more than once — our single registration avoids
    // that class of collision entirely).
    expect(registration?.name).toBe('cgc')
    expect(registration?.name).not.toContain(':')
    expect(registration?.description).toContain('status')
  })

  it('provides argument completions for every subcommand, filtered by prefix', () => {
    const { api, registrations } = makeRecordingApi()
    registerCgcCommands(api)
    const completions = registrations[0]?.getArgumentCompletions

    expect(completions).toBeTypeOf('function')
    const all = completions?.('') as Array<{ value: string; label: string; description?: string }>
    expect(all?.map((item) => item.value)).toEqual(VERBS)
    for (const item of all ?? []) {
      expect(item.label).toBe(item.value)
      expect(item.description).toBeTypeOf('string')
    }

    const filtered = completions?.('st') as Array<{ value: string }>
    expect(filtered?.map((item) => item.value)).toEqual(['status'])
    expect(completions?.('bogus')).toBeNull()
  })

  it('registers no destructive verb on the command surface (ADR 0003: asserted over the registered list)', () => {
    const { api, registrations } = makeRecordingApi()
    registerCgcCommands(api)

    // Every API-level registration is the bare `cgc` name; none may carry a
    // deletion/cleanup verb (a name containing a space could never be invoked,
    // but the assertion documents the surface either way).
    for (const registration of registrations) {
      expect(registration.name).toBe(CGC_COMMAND_NAME)
      for (const forbidden of DESTRUCTIVE_VERBS) {
        expect(registration.name, `registered name ${registration.name}`).not.toContain(forbidden)
      }
    }

    // The dispatchable command list is the surface pi actually offers to the
    // user: the registered command's argument completions. It must be exactly
    // the five documented verbs — and none of the destructive ones.
    const completions = registrations[0]?.getArgumentCompletions
    expect(completions).toBeTypeOf('function')
    const all = completions?.('') as Array<{ value: string; label: string }>
    const values = all?.map((item) => item.value) ?? []
    expect(values).toEqual(VERBS)
    for (const forbidden of DESTRUCTIVE_VERBS) {
      expect(values, `registered list contains forbidden verb ${forbidden}`).not.toContain(
        forbidden,
      )
    }
  })

  it('is fail-open: a throwing registration API never breaks extension load', () => {
    const throwingApi = {
      registerCommand() {
        throw new Error('api exploded')
      },
    }

    expect(() => registerCgcCommands(throwingApi as unknown as ExtensionAPI)).not.toThrow()
  })

  it('is idempotent in effect: repeated registration re-registers the same bare name', () => {
    const { api, registrations } = makeRecordingApi()

    registerCgcCommands(api)
    registerCgcCommands(api)

    expect(registrations.map((registration) => registration.name)).toEqual(['cgc', 'cgc'])
  })
})

// ---------------------------------------------------------------------------
// Dispatch (task 1.1: the five commands are reachable under /cgc)
// ---------------------------------------------------------------------------

describe('/cgc dispatch', () => {
  it('routes every subcommand invocation to its own handler', async () => {
    const { api, registrations } = makeRecordingApi()
    registerCgcCommands(api)
    const handler = registrations[0]?.handler
    expect(handler).toBeTypeOf('function')

    for (const verb of VERBS) {
      const { ctx, notified } = makeContext()
      await handler?.(verb, ctx)
      expect(notified, `verb ${verb}`).toHaveLength(1)
      // Index/sync/doctor/report notify 'warning' on their unavailable paths
      // (no runner wired here), 'info' otherwise — either way exactly one
      // notification is emitted per route into the verb's own handler.
      const type = notified[0]?.type
      expect(type === 'info' || type === 'warning', `verb ${verb}`).toBe(true)
      if (verb === 'status') {
        // Task 1.2 replaced the status stub: the handler now renders the
        // workspace status report (dispatched under the same bare command).
        expect(notified[0]?.message).toContain('CGC status')
        expect(notified[0]?.message).toContain('/ws')
      } else {
        expect(notified[0]?.message, `verb ${verb}`).toContain(`cgc ${verb}`)
      }
    }
  })

  it('passes everything after the verb as the handler rest-argument', async () => {
    const { api, registrations } = makeRecordingApi()
    registerCgcCommands(api)
    const handler = registrations[0]?.handler

    // `/cgc index --force` parses verb `index`, rest `--force`.
    const { ctx, notified } = makeContext()
    await handler?.('index --force', ctx)
    expect(notified[0]?.message).toContain('cgc index')
  })

  it('renders usage (all five commands) for a bare /cgc invocation', async () => {
    const { ctx, notified } = makeContext()

    await handleCgcInvocation('', ctx)

    expect(notified).toHaveLength(1)
    const text = notified[0]?.message ?? ''
    expect(text).toContain('/cgc <command>')
    for (const verb of VERBS) {
      expect(text).toContain(verb)
    }
  })

  it('renders usage for an unknown verb instead of throwing', async () => {
    const { ctx, notified } = makeContext()

    await handleCgcInvocation('frobnicate the index', ctx)

    expect(notified).toHaveLength(1)
    expect(notified[0]?.message).toContain('/cgc <command>')
  })

  it('never maps a deletion/cleanup verb to a handler — each falls through to usage (ADR 0003)', async () => {
    const { api, registrations } = makeRecordingApi()
    registerCgcCommands(api)
    const handler = registrations[0]?.handler
    expect(handler).toBeTypeOf('function')

    for (const forbidden of DESTRUCTIVE_VERBS) {
      const { ctx, notified } = makeContext()
      await handler?.(forbidden, ctx)

      // A routed subcommand renders its own notice (status report, started /
      // unavailable / declined notice, ...) — the usage render is the proof
      // the verb was not dispatched to any operation.
      expect(notified, `verb ${forbidden}`).toHaveLength(1)
      expect(notified[0]?.message, `verb ${forbidden}`).toBe(usageText())
      expect(notified[0]?.message, `verb ${forbidden}`).toContain('/cgc <command>')
    }
  })

  it('never throws into the session, even when notify is broken (fail-open)', async () => {
    const { ctx } = makeContext(() => {
      throw new Error('notify exploded')
    })

    // A broken UI sink must not surface as a command failure.
    expect(async () => await handleCgcInvocation('status', ctx)).not.toThrow()
    expect(async () => await handleCgcInvocation('', ctx)).not.toThrow()
  })

  it('usage and completion surfaces agree on the command set', () => {
    const text = usageText()
    for (const spec of CGC_SUBCOMMANDS) {
      expect(text).toContain(spec.description)
      expect(text).toContain(spec.verb)
    }
  })
})

// ---------------------------------------------------------------------------
// Status renderer (task 1.2)
// ---------------------------------------------------------------------------

describe('/cgc status renderer', () => {
  it('reports the workspace, lifecycle state, last action, and no running work on a clean workspace', () => {
    const now = Date.now()
    const view: CgcStatusView = {
      cwd: '/ws',
      snapshot: makeSnapshot({
        state: 'clean',
        reason: 'index health probe succeeded and reported no staleness',
        lastAction: makeAction({ kind: 'clean-skipped', at: now - 12_000 }),
      }),
      workInFlight: false,
      freshness: null,
    }

    const text = renderStatusText(view)

    expect(text).toContain('CGC status — /ws')
    expect(text).toContain('Lifecycle: clean')
    expect(text).toContain('index health probe succeeded and reported no staleness')
    expect(text).toContain('Last action: clean-skipped')
    expect(text).toContain('12s ago')
    expect(text).toContain('Running work: none')
    // Freshness capability absent: the section is omitted (not an error).
    expect(text).not.toContain('Freshness:')
  })

  it('shows the running action and its progress state while work is running', () => {
    const view: CgcStatusView = {
      cwd: '/ws',
      snapshot: makeSnapshot({
        state: 'clean',
        activity: 'indexing',
        lastAction: makeAction({
          kind: 'indexing-started',
          detail: 'background index creation started',
        }),
      }),
      workInFlight: true,
      freshness: null,
    }

    const text = renderStatusText(view)

    expect(text).toContain('Running work: indexing (in progress)')
    expect(text).toContain('background index creation started')
  })

  it('falls back to the in-flight marker when work runs but no lifecycle activity is recorded', () => {
    const view: CgcStatusView = {
      cwd: '/ws',
      snapshot: null,
      workInFlight: true,
      freshness: null,
    }

    const text = renderStatusText(view)

    expect(text).toContain('Running work: a cgc command is in flight')
  })

  it('renders the freshness section only when the freshness capability is present', () => {
    const now = Date.now()
    const freshness: CgcFreshnessSummary = {
      status: 'possibly-stale',
      lastSyncedAt: now - 3 * 60_000,
      staleSince: now - 5 * 60_000,
    }
    const view: CgcStatusView = {
      cwd: '/ws',
      snapshot: makeSnapshot(),
      workInFlight: false,
      freshness,
    }

    const text = renderStatusText(view)

    expect(text).toContain('Freshness: possibly stale')
    expect(text).toContain('stale since')
    expect(text).toContain('run /cgc sync to reconcile')
  })

  it('renders unavailable when no lifecycle state has been recorded (specified degradation)', () => {
    const text = renderStatusText({
      cwd: '/ws',
      snapshot: null,
      workInFlight: false,
      freshness: null,
    })

    expect(text).toContain('CGC status — /ws')
    expect(text).toContain('Lifecycle: unavailable')
    expect(text).toContain('no lifecycle state recorded')
    expect(text).toContain('Last action: none recorded')
  })

  it('uses the lifecycle null-state convention for labels', () => {
    expect(lifecycleStateLabel('clean')).toBe('clean')
    expect(lifecycleStateLabel('unindexed')).toBe('unindexed')
    expect(lifecycleStateLabel(null)).toBe('unavailable')
  })

  it('strips control sequences from embedded state detail (pre-ADR-0005 discipline)', () => {
    const view: CgcStatusView = {
      cwd: '/ws',
      snapshot: makeSnapshot({
        reason: '\u001b[31mred\u001b[0m probe outcome',
        lastAction: makeAction({ detail: '\u001b]0;title\u0007bell\u001b[K', kind: 'gate-failed' }),
      }),
      workInFlight: false,
      freshness: null,
    }

    const text = renderStatusText(view)

    expect(text).not.toContain('\u001b')
    expect(text).toContain('red probe outcome')
    expect(text).toContain('bell')
    expect(stripControlSequences('a\u001b[31m\u001b[0m b\t\n')).toBe('a b\t\n')
  })

  it('bounds pathological output with a head+tail truncation marker', () => {
    const huge = 'x'.repeat(OUTPUT_TEXT_BUDGET * 2)
    const view: CgcStatusView = {
      cwd: '/ws',
      snapshot: makeSnapshot({
        reason: huge,
        lastAction: makeAction({ detail: huge }),
      }),
      workInFlight: false,
      freshness: null,
    }

    const text = renderStatusText(view)

    expect(text.length).toBeLessThanOrEqual(OUTPUT_TEXT_BUDGET)
    expect(text).toContain('truncated')
    expect(text.startsWith('CGC status — /ws')).toBe(true)
    expect(boundText('ok')).toBe('ok')
  })

  it('builds the view from the dependency surface, reading only snapshot and in-flight', () => {
    const { state, reads } = makeStateSurface()
    const view = buildStatusView('/ws', { state })

    expect(view.cwd).toBe('/ws')
    expect(view.snapshot?.state).toBe('clean')
    expect(view.workInFlight).toBe(false)
    expect(view.freshness).toBeNull()
    expect(reads).toEqual(['snapshot:/ws', 'isInFlight:/ws'])
  })

  it('reads the freshness capability when present and degrades when it throws', () => {
    const { state } = makeStateSurface()
    const viewWithFreshness = buildStatusView('/ws', {
      state,
      freshness: () => ({ status: 'fresh', lastSyncedAt: null, staleSince: null }),
    })
    expect(viewWithFreshness.freshness?.status).toBe('fresh')

    const viewWithBrokenFreshness = buildStatusView('/ws', {
      state,
      freshness: () => {
        throw new Error('freshness store exploded')
      },
    })
    expect(viewWithBrokenFreshness.freshness).toBeNull()
  })

  it('fails open when the state surface throws (a broken store never breaks status)', () => {
    const state = {
      snapshot() {
        throw new Error('store exploded')
      },
      isInFlight() {
        throw new Error('runner exploded')
      },
    }
    const view = buildStatusView('/ws', { state })
    const text = renderStatusText(view)

    expect(view.snapshot).toBeNull()
    expect(view.workInFlight).toBe(false)
    expect(text).toContain('Lifecycle: unavailable')
  })

  it('reaches the injected dependencies through the registered command handler', async () => {
    const { api, registrations } = makeRecordingApi()
    const { state } = makeStateSurface({
      snapshot: () => makeSnapshot({ state: 'drift', reason: 'index reported staleness markers' }),
    })
    const deps: CgcCommandDependencies = { state }
    registerCgcCommands(api, deps)
    const handler = registrations[0]?.handler
    expect(handler).toBeTypeOf('function')

    const { ctx, notified } = makeContext()
    await handler?.('status', ctx)

    expect(notified).toHaveLength(1)
    expect(notified[0]?.type).toBe('info')
    expect(notified[0]?.message).toContain('CGC status — /ws')
    expect(notified[0]?.message).toContain('Lifecycle: drift')
  })

  it('keeps the fail-open guarantee when the status handler runs un-wired', async () => {
    const { ctx, notified } = makeContext()

    await handleCgcInvocation('status', ctx)

    expect(notified).toHaveLength(1)
    expect(notified[0]?.message).toContain('CGC status — /ws')
    expect(notified[0]?.message).toContain('Lifecycle: unavailable')
  })

  it('formats relative timestamps compactly', () => {
    const now = Date.now()
    expect(timeAgo(now, now)).toBe('just now')
    expect(timeAgo(now - 42_000, now)).toBe('42s ago')
    expect(timeAgo(now - 7 * 60_000, now)).toBe('7m ago')
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2d ago')
  })
})

// ---------------------------------------------------------------------------
// Shared output-hygiene renderer (task 1.3)
// ---------------------------------------------------------------------------

describe('shared output-hygiene renderer (task 1.3)', () => {
  it('strips every ESC-led sequence family and keeps layout whitespace', () => {
    // CSI (SGR), OSC (terminated by BEL), and a trailing single-character
    // escape — all removed; tab/newline/CR are layout and survive.
    const text = 'a \u001b[31mred\u001b[0m b \u001b]0;title\u0007bell c\u001b[K d'

    expect(stripControlSequences(text)).toBe('a red b bell c d')
  })

  it('strips standalone C1 controls without an ESC introducer', () => {
    // NEL (U+0085), the one-character CSI (U+009B), and APC (U+009F) have no
    // ESC byte in sight — the C1 pass removes them outright while layout
    // whitespace (tab) still survives.
    expect(stripControlSequences('a\u0085b\u009bc\u009fd\te')).toBe('abcd\te')
  })

  it('passes clean text through intact', () => {
    expect(stripControlSequences('plain text, no escapes here')).toBe('plain text, no escapes here')
  })

  it('names the truncating command and original size in the marker', () => {
    expect(truncationMarker(8192)).toBe('\n… [cgc command output truncated, original 8192 chars]')
    expect(truncationMarker(8192, 'doctor')).toBe(
      '\n… [cgc doctor output truncated, original 8192 chars]',
    )
  })

  it('returns short text unchanged', () => {
    expect(boundText('ok')).toBe('ok')
  })

  it('preserves head and tail with an explicit marker when over budget', () => {
    const text = `HEAD-${'z'.repeat(OUTPUT_TEXT_BUDGET * 2)}-TAIL`
    const bounded = boundText(text, { label: 'status' })

    expect(bounded.length).toBeLessThanOrEqual(OUTPUT_TEXT_BUDGET)
    expect(bounded.startsWith('HEAD-')).toBe(true)
    expect(bounded.endsWith('-TAIL')).toBe(true)
    expect(bounded).toContain('truncated')
    expect(bounded).toContain('cgc status output truncated')
  })

  it('returns the marker alone when it cannot fit the budget (the truncation contract still holds)', () => {
    const bounded = boundText('abcdefghijklmnopqrst', { budget: 10, label: 'doctor' })

    expect(bounded).toBe(truncationMarker(20, 'doctor'))
  })

  it('renders doctor output through the shared pipeline: stripped, bounded, labelled', () => {
    const pad = 'x'.repeat(OUTPUT_TEXT_BUDGET)
    const doctorOut = `\u001b[1m\u001b[34mcgc doctor\u001b[0m — \u001b[32mhealthy\u001b[0m\nscan complete\n${pad}`
    const rendered = renderCommandText(doctorOut, { label: 'doctor' })

    expect(rendered).not.toContain('\u001b')
    expect(rendered).toContain('cgc doctor')
    expect(rendered).toContain('healthy')
    expect(rendered).toContain('scan complete')
    expect(rendered.length).toBeLessThanOrEqual(OUTPUT_TEXT_BUDGET)
    expect(rendered).toContain('cgc doctor output truncated')
    expect(rendered.endsWith('x')).toBe(true)
  })

  it('renders report output through the shared pipeline: stripped, bounded, labelled', () => {
    const pad = 'y'.repeat(OUTPUT_TEXT_BUDGET)
    const reportOut = `writing report \u001b]0;cgc report\u0007 to /ws/out.md\n${pad}`
    const rendered = renderCommandText(reportOut, { label: 'report' })

    expect(rendered).not.toContain('\u001b')
    expect(rendered).not.toContain('\u0007')
    expect(rendered).toContain('/ws/out.md')
    expect(rendered).toContain('cgc report output truncated')
    expect(rendered.length).toBeLessThanOrEqual(OUTPUT_TEXT_BUDGET)
  })

  it('is the pipeline renderStatusText consumes (status label, same budget)', () => {
    const huge = 'x'.repeat(OUTPUT_TEXT_BUDGET * 2)
    const view: CgcStatusView = {
      cwd: '/ws',
      snapshot: makeSnapshot({ reason: huge }),
      workInFlight: false,
      freshness: null,
    }

    const text = renderStatusText(view)

    expect(text.length).toBeLessThanOrEqual(OUTPUT_TEXT_BUDGET)
    expect(text).toContain('cgc status output truncated')
  })
})

// ---------------------------------------------------------------------------
// Consent layer (task 2.1, ADR-0003)
// ---------------------------------------------------------------------------

describe('consent layer (task 2.1, ADR-0003)', () => {
  it('names CGC_REPORT.md as the documented report filename', () => {
    // CGC docs: `cgc report` — "Generate CGC_REPORT.md with god-node,
    // complexity, and coupling metrics". The filename is documented; the
    // write LOCATION is not (validate.md) and is confirmed per write.
    expect(CGC_REPORT_FILENAME).toBe('CGC_REPORT.md')
  })

  it('confirms a force rebuild with a message naming the replace effect', async () => {
    const { ctx, prompts } = makeConsentContext()

    const granted = await confirmForceRebuild(ctx, '/ws')

    expect(granted).toBe(true)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.title).toContain('Rebuild')
    // Spec "Force rebuild requires confirmation": the prompt EXPLAINS that a
    // rebuild replaces the existing index before consent is possible.
    expect(prompts[0]?.message).toContain('replaces the existing CGC index')
    expect(prompts[0]?.message).toContain('/ws')
    expect(forceRebuildConsentMessage('/ws')).toContain('replaces')
  })

  it('grants only explicit confirmation: a decline resolves declined', async () => {
    const { ctx, prompts } = makeConsentContext(() => false)

    const granted = await confirmForceRebuild(ctx, '/ws')

    expect(granted).toBe(false)
    // The gate asked even though the answer is no — declining is a real answer.
    expect(prompts).toHaveLength(1)
  })

  it('re-asks every time: no skip-confirmation path exists (ADR-0003)', async () => {
    const { ctx, prompts } = makeConsentContext(() => true)

    const first = await confirmForceRebuild(ctx, '/ws')
    const second = await confirmForceRebuild(ctx, '/ws')

    expect(first).toBe(true)
    expect(second).toBe(true)
    // Two force rebuilds, two dialogs: consent is never remembered or skipped
    // — "confirmations are skippable only by declining the action".
    expect(prompts).toHaveLength(2)
  })

  it('treats a missing dialog surface as declined (print/JSON mode hasUI:false)', async () => {
    const { ctx, prompts } = makeConsentContext(() => {
      throw new Error('dialog must not be touched without a UI')
    }, false)

    const granted = await confirmForceRebuild(ctx, '/ws')

    expect(granted).toBe(false)
    expect(prompts).toHaveLength(0)
  })

  it('fails open when the confirmation dialog throws (never throws into a handler)', async () => {
    const { ctx, prompts } = makeConsentContext(() => {
      throw new Error('dialog exploded')
    })

    let granted = true
    expect(async () => (granted = await confirmForceRebuild(ctx, '/ws'))).not.toThrow()
    expect(granted).toBe(false)
    expect(prompts).toHaveLength(1)

    granted = true
    expect(async () => (granted = await confirmReportWrite(ctx, '/ws/CGC_REPORT.md'))).not.toThrow()
    expect(granted).toBe(false)
  })

  it('confirms a report write with a message naming the exact destination path', async () => {
    const destination = '/ws/CGC_REPORT.md'
    const { ctx, prompts } = makeConsentContext()

    const granted = await confirmReportWrite(ctx, destination)

    expect(granted).toBe(true)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.title).toContain('Write the CGC report')
    // Spec "Report generated after confirmation": the prompt names the exact
    // destination path (resolved empirically per validate.md — never a guess).
    expect(prompts[0]?.message).toContain(destination)
    expect(reportWriteConsentMessage(destination)).toContain(destination)
  })

  it('grants a report write only on explicit confirmation (decline resolves declined)', async () => {
    const destination = '/ws/CGC_REPORT.md'
    const { ctx, prompts } = makeConsentContext(() => false)

    const granted = await confirmReportWrite(ctx, destination)

    expect(granted).toBe(false)
    expect(prompts).toHaveLength(1)
  })

  it('treats a missing dialog surface as declined for report too (headless mode)', async () => {
    const destination = '/ws/CGC_REPORT.md'
    const { ctx, prompts } = makeConsentContext(() => {
      throw new Error('dialog must not be touched without a UI')
    }, false)

    const granted = await confirmReportWrite(ctx, destination)

    expect(granted).toBe(false)
    expect(prompts).toHaveLength(0)
  })

  it('renders declined notices matching the spec guarantees', () => {
    const rebuild = forceRebuildDeclinedNotice('/ws')
    expect(rebuild).toContain('declined')
    expect(rebuild).toContain('/ws')
    // Spec "Confirmation declined": no maintenance command runs; the existing
    // index is untouched.
    expect(rebuild).toContain('no maintenance command ran')
    expect(rebuild).toContain('untouched')

    const report = reportWriteDeclinedNotice('/ws/CGC_REPORT.md')
    expect(report).toContain('declined')
    expect(report).toContain('/ws/CGC_REPORT.md')
    // Spec "Report declined": no report file is written; no report command runs.
    expect(report).toContain('no report was written')
    expect(report).toContain('no report command ran')
  })

  it('keeps the real session context structurally compatible with the consent surface', async () => {
    // The real ExtensionCommandContext exposes hasUI plus ui.confirm — the
    // narrowed surface must accept it without a cast incompatibility.
    const { ctx: commandContext } = makeContext()
    const granted = await confirmForceRebuild(commandContext, '/ws')
    expect(granted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Index command (task 2.2)
// ---------------------------------------------------------------------------

describe('/cgc index (task 2.2)', () => {
  it('declines creation on an unindexed workspace when the auto-create gate is closed (no spawn, no dialog)', async () => {
    const { runner, runs } = makeFakeRunner()
    const { recordAction, actions } = makeRecordSpy()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner, lifecycle: { autoCreate: false }, recordAction }

    await handleCgcInvocation('index', ctx, deps)

    expect(runs).toHaveLength(0)
    expect(notified).toHaveLength(1)
    expect(notified[0]?.type).toBe('info')
    // Design D2: creation follows the change-1 auto-create opt-in — the gate
    // is the config, not a second confirmation dialog, so no prompt appears
    // and no cgc command runs (spec: the existing index is untouched).
    expect(notified[0]?.message).toContain('lifecycle.autoCreate is off')
    expect(notified[0]?.message).toContain('untouched')
    expect(actions.map((action) => action.kind)).toContain('unindexed-notice')
  })

  it('declines creation when the gate config is absent (the closed default)', async () => {
    const { runner, runs } = makeFakeRunner()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner }

    await handleCgcInvocation('index', ctx, deps)

    expect(runs).toHaveLength(0)
    expect(notified[0]?.message).toContain('index creation is opt-in')
  })

  it('creates a missing index in the background when the gate is open (autoCreate on), with progress state', async () => {
    const { runner, runs } = makeFakeRunner()
    const { recordAction, actions } = makeRecordSpy()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner, lifecycle: { autoCreate: true }, recordAction }

    await handleCgcInvocation('index', ctx, deps)

    // Spawned through the shared runner: session cwd, argument array, `index .`.
    expect(runs).toHaveLength(1)
    expect(runs[0]?.cwd).toBe('/ws')
    expect(runs[0]?.args).toEqual(['index', '.'])
    // Progress state recorded before the handler returns (fire-and-forget).
    const started = actions.filter((action) => action.kind === 'indexing-started')
    expect(started).toHaveLength(1)
    expect(started[0]?.cwd).toBe('/ws')
    expect(started[0]?.ok).toBeNull()
    expect(notified[0]?.message).toContain('index creation started in the background')

    // Settling records the outcome and stays quiet on success.
    runs[0]?.settle(makeResult())
    await Promise.resolve()
    expect(actions.map((action) => action.kind)).toContain('indexing-settled')
    expect(notified).toHaveLength(1)
  })

  it('runs the incremental index freely on an already-indexed workspace (no force)', async () => {
    const dir = makeIndexedWorkspace()
    try {
      const { runner, runs } = makeFakeRunner()
      const { recordAction, actions } = makeRecordSpy()
      const { ctx, notified } = makeContext(undefined, dir)
      const deps: CgcCommandDependencies = { runner, recordAction }

      await handleCgcInvocation('index', ctx, deps)

      expect(runs).toHaveLength(1)
      expect(runs[0]?.args).toEqual(['index', '.'])
      expect(actions.map((action) => action.kind)).toContain('indexing-started')
      expect(notified[0]?.message).toContain('incremental indexing started')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('force rebuild runs only behind explicit confirmation', async () => {
    const { runner, runs } = makeFakeRunner()
    const { recordAction, actions } = makeRecordSpy()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner, recordAction }

    await handleCgcInvocation('index --force', ctx, deps)

    expect(runs).toHaveLength(1)
    expect(runs[0]?.args).toEqual(['index', '.', '--force'])
    expect(actions.map((action) => action.kind)).toContain('rebuild-started')
    const started = actions.filter((action) => action.kind === 'rebuild-started')[0]
    expect(started?.detail).toContain('index rebuild started')
    expect(notified[0]?.message).toContain('force rebuild started')
    expect(notified[0]?.message).toContain('replaced')
  })

  it('never spawns on a declined force confirmation (spec: existing index untouched)', async () => {
    const { runner, runs } = makeFakeRunner()
    const { recordAction, actions } = makeRecordSpy()
    const { ctx, notified } = makeContext(undefined, '/ws', () => false)
    const deps: CgcCommandDependencies = { runner, recordAction }

    await handleCgcInvocation('index --force', ctx, deps)

    expect(runs).toHaveLength(0)
    expect(notified).toHaveLength(1)
    expect(notified[0]?.message).toContain('force rebuild declined')
    expect(notified[0]?.message).toContain('untouched')
    expect(actions.map((action) => action.kind)).not.toContain('rebuild-started')
  })

  it('declines force in headless (print/JSON) mode without touching the dialog', async () => {
    const { runner, runs } = makeFakeRunner()
    const { ctx, notified } = makeHeadlessContext()
    const deps: CgcCommandDependencies = { runner }

    await handleCgcInvocation('index --force', ctx, deps)

    expect(runs).toHaveLength(0)
    expect(notified[0]?.message).toContain('force rebuild declined')
  })

  it('reports cgc unavailable when the runner is not wired, without throwing', async () => {
    const { ctx, notified } = makeContext()

    await handleCgcInvocation('index --force', ctx)

    expect(notified).toHaveLength(1)
    expect(notified[0]?.message).toContain('cgc index')
    expect(notified[0]?.message).toContain('unavailable')
    expect(cgcUnavailableNotice('/ws', 'index', 'no runner')).toContain('nothing was run')
  })

  it('does not spawn a second command while work is in flight (dedup)', async () => {
    const { runner, runs, inflight } = makeFakeRunner()
    inflight.add('/ws')
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner, lifecycle: { autoCreate: true } }

    await handleCgcInvocation('index', ctx, deps)

    expect(runs).toHaveLength(0)
    expect(notified[0]?.message).toContain('already running')
    expect(indexAlreadyInFlightNotice('/ws')).toContain('/cgc status')
  })

  it('surfaces a busy notice and records busy-skipped when the run reports a lock conflict', async () => {
    const { runner, runs } = makeFakeRunner()
    const { recordAction, actions } = makeRecordSpy()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner, lifecycle: { autoCreate: true }, recordAction }

    await handleCgcInvocation('index', ctx, deps)
    runs[0]?.settle(
      makeResult({ ok: false, code: 'BUSY', message: 'database is locked by another process' }),
    )
    await Promise.resolve()

    expect(actions.map((action) => action.kind)).toContain('busy-skipped')
    // Design D3: the busy notice names the conflict (reused from busy.ts).
    expect(notified.some((entry) => entry.message.includes('holding the embedded database'))).toBe(
      true,
    )
    expect(notified.some((entry) => entry.type === 'warning')).toBe(true)
  })

  it('records the settled outcome and warns on a failed run', async () => {
    const { runner, runs } = makeFakeRunner()
    const { recordAction, actions } = makeRecordSpy()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner, lifecycle: { autoCreate: true }, recordAction }

    await handleCgcInvocation('index', ctx, deps)
    runs[0]?.settle(
      makeResult({ ok: false, code: 'COMMAND_FAILED', message: 'cgc exited with code 2' }),
    )
    await Promise.resolve()

    const settled = actions.find((action) => action.kind === 'indexing-settled')
    expect(settled?.ok).toBe(false)
    expect(notified.some((entry) => entry.message.includes('did not complete'))).toBe(true)
  })

  it('fails open when state recording throws', async () => {
    const { runner, runs } = makeFakeRunner()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = {
      runner,
      lifecycle: { autoCreate: true },
      recordAction() {
        throw new Error('store exploded')
      },
    }

    expect(async () => await handleCgcInvocation('index', ctx, deps)).not.toThrow()
    expect(runs).toHaveLength(1)
    expect(notified[0]?.message).toContain('index creation started')
  })

  it('rejects unrecognized options with usage guidance and never runs', async () => {
    const { runner, runs } = makeFakeRunner()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner }

    await handleCgcInvocation('index --bogus', ctx, deps)

    expect(runs).toHaveLength(0)
    expect(notified[0]?.message).toContain('/cgc index [--force]')
    expect(indexUnknownOptionNotice(['--bogus'])).toContain('--bogus')

    // Unknown options win even next to --force: refuse, no confirm, no spawn.
    const { ctx: ctx2, notified: notified2 } = makeContext()
    await handleCgcInvocation('index --force --bogus', ctx2, deps)
    expect(runs).toHaveLength(0)
    expect(notified2[0]?.message).toContain('unrecognized option')
  })

  it('parses index options: only --force is understood', () => {
    expect(parseIndexOptions('')).toEqual({ force: false, unknown: [] })
    expect(parseIndexOptions('   ')).toEqual({ force: false, unknown: [] })
    expect(parseIndexOptions('--force')).toEqual({ force: true, unknown: [] })
    expect(parseIndexOptions('  --force  ')).toEqual({ force: true, unknown: [] })
    expect(parseIndexOptions('--force extra')).toEqual({ force: true, unknown: ['extra'] })
    expect(INDEX_FORCE_FLAG).toBe('--force')
  })

  it('renders started and declined notices naming the exact command and effect', () => {
    expect(indexStartedNotice('/ws', ['index', '.'], 'create')).toContain('cgc index .')
    expect(indexStartedNotice('/ws', ['index', '.'], 'incremental')).toContain('incremental')
    expect(indexStartedNotice('/ws', ['index', '.', '--force'], 'rebuild')).toContain('replaced')
    expect(indexCreationDeclinedNotice('/ws')).toContain('/ws')
    expect(indexCreationDeclinedNotice('/ws')).toContain('untouched')
  })
})

describe('/cgc sync (task 2.3)', () => {
  it('triggers an incremental drift sync in the background on an indexed workspace, with syncing progress state', async () => {
    const dir = makeIndexedWorkspace()
    try {
      const { runner, runs } = makeFakeRunner()
      const { recordAction, actions } = makeRecordSpy()
      // Sync is non-destructive (design D2): it must never touch the consent
      // dialog — a throwing confirm proves no dialog is ever opened.
      const { ctx, notified } = makeContext(undefined, dir, () => {
        throw new Error('sync must not ask for confirmation')
      })
      const deps: CgcCommandDependencies = { runner, recordAction }

      await handleCgcInvocation('sync', ctx, deps)

      // Same shared runner, same incremental `cgc index .` command (D1).
      expect(runs).toHaveLength(1)
      expect(runs[0]?.cwd).toBe(dir)
      expect(runs[0]?.args).toEqual(['index', '.'])
      // Progress state visible in /cgc status: drift-sync-started maps to
      // lifecycle activity "syncing" (spec: "its progress state is visible").
      const started = actions.filter((action) => action.kind === 'drift-sync-started')
      expect(started).toHaveLength(1)
      expect(started[0]?.cwd).toBe(dir)
      expect(started[0]?.ok).toBeNull()
      expect(started[0]?.detail).toContain('/cgc sync')
      expect(notified[0]?.message).toContain('incremental drift sync started')
      expect(notified[0]?.message).toContain('cgc index .')
      // No consent dialog was opened and no command failure was reported.
      expect(notified.some((entry) => entry.message.includes('failed unexpectedly'))).toBe(false)

      // Settling records the outcome and stays quiet on success.
      runs[0]?.settle(makeResult())
      await Promise.resolve()
      expect(actions.map((action) => action.kind)).toContain('drift-sync-settled')
      expect(notified).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('joins an in-flight cgc run instead of spawning a duplicate (dedup)', async () => {
    const { runner, runs, inflight } = makeFakeRunner()
    inflight.add('/ws')
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner, lifecycle: { autoCreate: true } }

    await handleCgcInvocation('sync', ctx, deps)

    expect(runs).toHaveLength(0)
    // The task-2.3 contract: the sync JOINS the in-flight run rather than
    // duplicating it, with progress visible in /cgc status.
    expect(notified[0]?.message).toContain('already running')
    expect(notified[0]?.message).toContain('joins')
    expect(syncJoinInFlightNotice('/ws')).toContain('/cgc status')
  })

  it('surfaces the one-time busy notice and records busy-skipped when the sync reports a lock conflict', async () => {
    const dir = makeIndexedWorkspace()
    try {
      const { runner, runs } = makeFakeRunner()
      const { recordAction, actions } = makeRecordSpy()
      const { ctx, notified } = makeContext(undefined, dir)
      const deps: CgcCommandDependencies = { runner, recordAction }

      await handleCgcInvocation('sync', ctx, deps)
      runs[0]?.settle(
        makeResult({ ok: false, code: 'BUSY', message: 'database is locked by another process' }),
      )
      await Promise.resolve()

      expect(actions.map((action) => action.kind)).toContain('busy-skipped')
      // Design D3: the one-time notice names the conflict, clean exit (no error).
      expect(
        notified.some((entry) => entry.message.includes('holding the embedded database')),
      ).toBe(true)
      expect(notified.some((entry) => entry.type === 'warning')).toBe(true)
      expect(notified.some((entry) => entry.message.includes('failed unexpectedly'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('declines on an unindexed workspace when the auto-create gate is closed (no spawn)', async () => {
    const { runner, runs } = makeFakeRunner()
    const { recordAction, actions } = makeRecordSpy()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner, lifecycle: { autoCreate: false }, recordAction }

    await handleCgcInvocation('sync', ctx, deps)

    expect(runs).toHaveLength(0)
    // Design D2: sync on an unindexed workspace would be a creation, so it
    // follows the change-1 auto-create opt-in — no cgc command ran.
    expect(notified[0]?.message).toContain('not indexed yet')
    expect(notified[0]?.message).toContain('autoCreate is off')
    expect(notified[0]?.message).toContain('untouched')
    expect(actions.map((action) => action.kind)).toContain('unindexed-notice')
  })

  it('declines on an unindexed workspace when the gate config is absent (the closed default)', async () => {
    const { runner, runs } = makeFakeRunner()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner }

    await handleCgcInvocation('sync', ctx, deps)

    expect(runs).toHaveLength(0)
    expect(notified[0]?.message).toContain('index creation is opt-in')
  })

  it('creates the missing index in the background when the gate is open (autoCreate on)', async () => {
    const { runner, runs } = makeFakeRunner()
    const { recordAction, actions } = makeRecordSpy()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner, lifecycle: { autoCreate: true }, recordAction }

    await handleCgcInvocation('sync', ctx, deps)

    expect(runs).toHaveLength(1)
    expect(runs[0]?.args).toEqual(['index', '.'])
    expect(actions.map((action) => action.kind)).toContain('drift-sync-started')
    expect(notified[0]?.message).toContain('incremental drift sync started')
  })

  it('reports cgc unavailable when the runner is not wired, without throwing', async () => {
    // An INDEXED workspace is required to reach the runner check: on an
    // unindexed workspace the auto-create gate declines first (same ordering
    // as `/cgc index` — the gate precedes any spawn, so unavailability is
    // only observable where spawn would otherwise happen).
    const dir = makeIndexedWorkspace()
    try {
      const { ctx, notified } = makeContext(undefined, dir)

      await handleCgcInvocation('sync', ctx)

      expect(notified).toHaveLength(1)
      expect(notified[0]?.message).toContain('cgc sync')
      expect(notified[0]?.message).toContain('unavailable')
      expect(notified[0]?.message).toContain('nothing was run')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses unexpected arguments with usage guidance and never runs', async () => {
    const { runner, runs } = makeFakeRunner()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner }

    await handleCgcInvocation('sync --again', ctx, deps)

    expect(runs).toHaveLength(0)
    expect(notified[0]?.message).toContain('unrecognized argument')
    expect(notified[0]?.message).toContain('/cgc sync')
    expect(notified[0]?.message).toContain('nothing was run')
  })

  it('fails open when state recording throws', async () => {
    const dir = makeIndexedWorkspace()
    try {
      const { runner, runs } = makeFakeRunner()
      const { ctx, notified } = makeContext(undefined, dir)
      const deps: CgcCommandDependencies = {
        runner,
        recordAction() {
          throw new Error('store exploded')
        },
      }

      expect(async () => await handleCgcInvocation('sync', ctx, deps)).not.toThrow()
      expect(runs).toHaveLength(1)
      expect(notified[0]?.message).toContain('incremental drift sync started')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('warns and records the settled failure when the background sync fails', async () => {
    const dir = makeIndexedWorkspace()
    try {
      const { runner, runs } = makeFakeRunner()
      const { recordAction, actions } = makeRecordSpy()
      const { ctx, notified } = makeContext(undefined, dir)
      const deps: CgcCommandDependencies = { runner, recordAction }

      await handleCgcInvocation('sync', ctx, deps)
      runs[0]?.settle(
        makeResult({ ok: false, code: 'COMMAND_FAILED', message: 'cgc exited with code 2' }),
      )
      await Promise.resolve()

      const settled = actions.find((action) => action.kind === 'drift-sync-settled')
      expect(settled?.ok).toBe(false)
      expect(notified.some((entry) => entry.message.includes('did not complete'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('renders sync notices naming the exact command and effect', () => {
    expect(syncStartedNotice('/ws', ['index', '.'])).toContain('cgc sync')
    expect(syncStartedNotice('/ws', ['index', '.'])).toContain('incremental drift sync started')
    expect(syncStartedNotice('/ws', ['index', '.'])).toContain('cgc index .')
    expect(syncJoinInFlightNotice('/ws')).toContain('already running')
    expect(syncJoinInFlightNotice('/ws')).toContain('joins')
    expect(syncDeclinedNotice('/ws')).toContain('/ws')
    expect(syncDeclinedNotice('/ws')).toContain('untouched')
    expect(syncUnknownArgumentNotice('--bogus')).toContain('--bogus')
    expect(syncUnknownArgumentNotice('--bogus')).toContain('nothing was run')
  })
})

// ---------------------------------------------------------------------------
// Doctor command (task 2.4)
// ---------------------------------------------------------------------------

describe('/cgc doctor (task 2.4)', () => {
  it('runs the diagnostic command through the shared runner in the background and renders the settled output, bounded and cleaned', async () => {
    const { runner, runs } = makeFakeRunner()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner }

    await handleCgcInvocation('doctor', ctx, deps)

    // Spawned through the shared runner with the session cwd (no options,
    // no confirmation — design D2: doctor is non-destructive).
    expect(runs).toHaveLength(1)
    expect(runs[0]?.cwd).toBe('/ws')
    expect(runs[0]?.args).toEqual(['doctor'])
    expect(DOCTOR_ARGS).toEqual(['doctor'])
    // The started notice arrives immediately: the handler never awaits cgc
    // completion inline (fire-and-forget background trigger).
    expect(notified[0]?.message).toContain('diagnostics started in the background')
    expect(notified[0]?.type).toBe('info')

    // Settling renders the captured output through the shared hygiene
    // pipeline (design D4): ANSI stripped, size-bounded with the explicit
    // marker naming the verb.
    const pad = 'x'.repeat(OUTPUT_TEXT_BUDGET)
    runs[0]?.settle(
      makeResult({
        stdout: `\u001b[1m\u001b[34mcgc doctor\u001b[0m — \u001b[32mhealthy\u001b[0m\nscan complete\n${pad}`,
      }),
    )
    await Promise.resolve()

    expect(notified).toHaveLength(2)
    const rendered = notified[1]?.message ?? ''
    expect(rendered).not.toContain('\u001b')
    expect(rendered).toContain('healthy')
    expect(rendered).toContain('scan complete')
    expect(rendered).toContain('cgc doctor output truncated')
    expect(rendered.length).toBeLessThanOrEqual(OUTPUT_TEXT_BUDGET)
    expect(notified[1]?.type).toBe('info')
  })

  it('never asks for confirmation and never records state (spec: doctor performs no state changes)', async () => {
    const { runner, runs } = makeFakeRunner()
    const { recordAction, actions } = makeRecordSpy()
    const { ctx, notified } = makeContext(undefined, '/ws', () => {
      throw new Error('doctor must not ask for confirmation')
    })
    const deps: CgcCommandDependencies = { runner, recordAction }

    await handleCgcInvocation('doctor', ctx, deps)
    runs[0]?.settle(makeResult({ code: 'BUSY', message: 'database is locked by another process' }))
    await Promise.resolve()

    // One spawn, a busy notice on a lock conflict, and zero recorded state.
    expect(runs).toHaveLength(1)
    expect(actions).toHaveLength(0)
    expect(notified.some((entry) => entry.message.includes('holding the embedded database'))).toBe(
      true,
    )
    expect(notified.some((entry) => entry.message.includes('failed unexpectedly'))).toBe(false)
  })

  it('surfaces the runner-level failure with the rendered output on a failed run', async () => {
    const { runner, runs } = makeFakeRunner()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner }

    await handleCgcInvocation('doctor', ctx, deps)
    runs[0]?.settle(
      makeResult({
        ok: false,
        code: 'COMMAND_FAILED',
        message: 'cgc exited with code 2',
        stdout: 'diagnostic detail line',
      }),
    )
    await Promise.resolve()

    const failure = notified.find((entry) => entry.type === 'warning')
    expect(failure?.message).toContain('did not complete')
    expect(failure?.message).toContain('command_failed')
    expect(failure?.message).toContain('diagnostic detail line')
  })

  it('renders the busy notice instead of captured output on a lock conflict (design D3)', async () => {
    const { runner, runs } = makeFakeRunner()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner }

    await handleCgcInvocation('doctor', ctx, deps)
    runs[0]?.settle(
      makeResult({
        ok: false,
        code: 'BUSY',
        message: 'database is locked by another process',
        stdout: 'some output that must not be rendered',
      }),
    )
    await Promise.resolve()

    expect(notified.some((entry) => entry.message.includes('holding the embedded database'))).toBe(
      true,
    )
    expect(notified.some((entry) => entry.type === 'warning')).toBe(true)
    expect(
      notified.some((entry) => entry.message.includes('some output that must not be rendered')),
    ).toBe(false)
  })

  it('reports cgc unavailable when the runner is not wired, without throwing', async () => {
    const { ctx, notified } = makeContext()

    await handleCgcInvocation('doctor', ctx)

    expect(notified).toHaveLength(1)
    expect(notified[0]?.message).toContain('cgc doctor')
    expect(notified[0]?.message).toContain('unavailable')
    expect(notified[0]?.message).toContain('nothing was run')
  })

  it('refuses unexpected arguments with usage guidance and never runs', async () => {
    const { runner, runs } = makeFakeRunner()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner }

    await handleCgcInvocation('doctor --verbose', ctx, deps)

    expect(runs).toHaveLength(0)
    expect(notified[0]?.message).toContain('unrecognized argument')
    expect(notified[0]?.message).toContain('/cgc doctor')
    expect(notified[0]?.message).toContain('nothing was run')
  })

  it('fails open when the runner throws on spawn', async () => {
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = {
      runner: {
        isInFlight() {
          return false
        },
        run() {
          throw new Error('spawn exploded')
        },
      } as unknown as CgcRunner,
    }

    expect(async () => await handleCgcInvocation('doctor', ctx, deps)).not.toThrow()
    expect(notified[0]?.message).toContain('cgc doctor')
    expect(notified[0]?.message).toContain('unavailable')
    expect(notified[0]?.message).toContain('could not spawn cgc')
  })

  it('renders doctor notices naming the exact command and effect', () => {
    expect(doctorStartedNotice('/ws', ['doctor'])).toContain('cgc doctor')
    expect(doctorStartedNotice('/ws', ['doctor'])).toContain('background')
    expect(doctorUnknownArgumentNotice('--verbose')).toContain('--verbose')
    expect(doctorUnknownArgumentNotice('--verbose')).toContain('nothing was run')
  })
})

// ---------------------------------------------------------------------------
// Report command (task 2.4)
// ---------------------------------------------------------------------------

describe('/cgc report (task 2.4)', () => {
  it('confirms the exact destination, spawns report --output <path> in the background, and renders the settled output', async () => {
    const { runner, runs } = makeFakeRunner()
    const { recordAction, actions } = makeRecordSpy()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner, recordAction }

    await handleCgcInvocation('report', ctx, deps)

    // One spawn through the shared runner with the session cwd, and the
    // confirmed ABSOLUTE destination passed via --output so the confirmed
    // path is exactly what is written (spec: the report file exists at the
    // confirmed destination path; empirical finding: cgc report writes its
    // process cwd unless --output is given).
    expect(runs).toHaveLength(1)
    expect(runs[0]?.cwd).toBe('/ws')
    expect(runs[0]?.args).toEqual(['report', '--output', '/ws/CGC_REPORT.md'])
    expect(REPORT_OUTPUT_FLAG).toBe('--output')
    expect(reportArgs('/ws/CGC_REPORT.md')).toEqual(['report', '--output', '/ws/CGC_REPORT.md'])
    // The started notice names the destination and the exact command.
    expect(notified[0]?.message).toContain('report generation started in the background')
    expect(notified[0]?.message).toContain('/ws/CGC_REPORT.md')
    expect(notified[0]?.message).toContain('--output /ws/CGC_REPORT.md')
    // Progress state visible in /cgc status: report-started then report-settled.
    expect(actions.map((action) => action.kind)).toContain('report-started')

    runs[0]?.settle(makeResult({ stdout: 'CGC report written' }))
    await Promise.resolve()

    expect(actions.map((action) => action.kind)).toContain('report-settled')
    expect(notified.some((entry) => entry.message.includes('CGC report written'))).toBe(true)
  })

  it('declines without running or writing anything when confirmation is declined (spec: report declined)', async () => {
    const { runner, runs } = makeFakeRunner()
    const { recordAction, actions } = makeRecordSpy()
    const { ctx, notified } = makeContext(undefined, '/ws', () => false)
    const deps: CgcCommandDependencies = { runner, recordAction }

    await handleCgcInvocation('report', ctx, deps)

    expect(runs).toHaveLength(0)
    expect(notified).toHaveLength(1)
    expect(notified[0]?.type).toBe('info')
    expect(notified[0]?.message).toContain('declined')
    expect(notified[0]?.message).toContain('/ws/CGC_REPORT.md')
    expect(notified[0]?.message).toContain('no report was written')
    // Spec: no report file is written and no `cgc` report command runs —
    // nothing was spawned and no progress state was recorded.
    expect(actions).toHaveLength(0)
  })

  it('declines in headless (print/JSON) mode without touching the dialog (no spawn, no write)', async () => {
    const { runner, runs } = makeFakeRunner()
    const { ctx, notified } = makeHeadlessContext()
    const deps: CgcCommandDependencies = { runner }

    await handleCgcInvocation('report', ctx, deps)

    expect(runs).toHaveLength(0)
    expect(notified[0]?.message).toContain('declined')
    expect(notified[0]?.message).toContain('no report was written')
  })

  it('refuses unexpected arguments with usage guidance — before any confirmation and any spawn', async () => {
    const { runner, runs } = makeFakeRunner()
    const { recordAction, actions } = makeRecordSpy()
    const { ctx, notified } = makeContext(undefined, '/ws', () => {
      throw new Error('unknown arguments must be refused before any confirmation')
    })
    const deps: CgcCommandDependencies = { runner, recordAction }

    await handleCgcInvocation('report --java', ctx, deps)

    expect(runs).toHaveLength(0)
    expect(notified[0]?.message).toContain('unrecognized argument')
    expect(notified[0]?.message).toContain('/cgc report')
    expect(notified[0]?.message).toContain('nothing was run')
    expect(actions).toHaveLength(0)
  })

  it('reports cgc unavailable when the runner is not wired, without throwing', async () => {
    const { ctx, notified } = makeContext()

    await handleCgcInvocation('report', ctx)

    expect(notified).toHaveLength(1)
    expect(notified[0]?.message).toContain('cgc report')
    expect(notified[0]?.message).toContain('unavailable')
    expect(notified[0]?.message).toContain('nothing was run')
  })

  it('surfaces the one-time busy notice and records busy-skipped on a lock conflict (design D3)', async () => {
    const { runner, runs } = makeFakeRunner()
    const { recordAction, actions } = makeRecordSpy()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner, recordAction }

    await handleCgcInvocation('report', ctx, deps)
    runs[0]?.settle(
      makeResult({ ok: false, code: 'BUSY', message: 'database is locked by another process' }),
    )
    await Promise.resolve()

    expect(actions.map((action) => action.kind)).toContain('busy-skipped')
    expect(notified.some((entry) => entry.message.includes('holding the embedded database'))).toBe(
      true,
    )
    expect(notified.some((entry) => entry.type === 'warning')).toBe(true)
    expect(notified.some((entry) => entry.message.includes('failed unexpectedly'))).toBe(false)
  })

  it('records the settled failure and warns on a failed run', async () => {
    const { runner, runs } = makeFakeRunner()
    const { recordAction, actions } = makeRecordSpy()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = { runner, recordAction }

    await handleCgcInvocation('report', ctx, deps)
    runs[0]?.settle(
      makeResult({
        ok: false,
        code: 'COMMAND_FAILED',
        message: 'cgc exited with code 2',
        stdout: 'could not open graph',
      }),
    )
    await Promise.resolve()

    const settled = actions.find((action) => action.kind === 'report-settled')
    expect(settled?.ok).toBe(false)
    const failure = notified.find((entry) => entry.type === 'warning')
    expect(failure?.message).toContain('did not complete')
    expect(failure?.message).toContain('could not open graph')
  })

  it('fails open when state recording throws (spawn and render still proceed)', async () => {
    const { runner, runs } = makeFakeRunner()
    const { ctx, notified } = makeContext()
    const deps: CgcCommandDependencies = {
      runner,
      recordAction() {
        throw new Error('store exploded')
      },
    }

    expect(async () => await handleCgcInvocation('report', ctx, deps)).not.toThrow()
    expect(runs).toHaveLength(1)
    expect(notified[0]?.message).toContain('report generation started')

    runs[0]?.settle(makeResult({ stdout: 'CGC report written' }))
    await Promise.resolve()
    expect(notified.some((entry) => entry.message.includes('CGC report written'))).toBe(true)
  })

  it('resolves the report destination as an absolute path inside the workspace', () => {
    expect(resolveReportDestination('/ws')).toBe('/ws/CGC_REPORT.md')
    expect(resolveReportDestination('/ws/')).toBe('/ws/CGC_REPORT.md')
    expect(resolveReportDestination('/deep/ws')).toBe('/deep/ws/CGC_REPORT.md')
    expect(CGC_REPORT_FILENAME).toBe('CGC_REPORT.md')
  })

  it('renders report notices naming the exact destination and command', () => {
    const args = reportArgs('/ws/CGC_REPORT.md')
    expect(reportStartedNotice('/ws', args, '/ws/CGC_REPORT.md')).toContain('/ws/CGC_REPORT.md')
    expect(reportStartedNotice('/ws', args, '/ws/CGC_REPORT.md')).toContain(
      'cgc report --output /ws/CGC_REPORT.md',
    )
    expect(reportUnknownArgumentNotice('--java')).toContain('--java')
    expect(reportUnknownArgumentNotice('--java')).toContain('nothing was run')
  })
})

// ---------------------------------------------------------------------------
// Task 3.2: fail-open behavior — commands report unavailability when cgc is
// missing, and handler errors never crash or block the session.
// ---------------------------------------------------------------------------

/**
 * Poll until `predicate` returns true or the deadline passes. The settle
 * chains of the REAL CgcRunner resolve on the event loop (a missing
 * executable surfaces via the spawn error/close path), so command tests that
 * drive real spawns need a bounded wait instead of a fixed microtask hop.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000, stepMs = 10): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return false
}

describe('fail-open behavior (task 3.2)', () => {
  it('reports cgc unavailability through the REAL runner when the cgc executable is missing — gracefully, never via the catch-all', async () => {
    // The production "cgc is missing" shape: the extension wires a real
    // CgcRunner (index.ts getConfig/runner), and the missing executable
    // surfaces at spawn time as a structured UNAVAILABLE result — never a
    // crash and never the "failed unexpectedly" catch-all.
    const runner = new CgcRunner({ executable: 'cgc-definitely-not-installed-failopen' })
    const dir = makeIndexedWorkspace()
    try {
      for (const verb of ['index', 'sync', 'doctor', 'report']) {
        const { ctx, notified } = makeContext(undefined, dir)
        await handleCgcInvocation(verb, ctx, { runner })

        const surfaced = await waitFor(() =>
          notified.some((entry) => entry.message.includes('could not be spawned')),
        )
        expect(surfaced, `${verb}: the unavailable settle must surface`).toBe(true)
        expect(
          notified.some((entry) => entry.message.toLowerCase().includes('unavailable')),
          `${verb}: the rendered outcome names the unavailability`,
        ).toBe(true)
        expect(
          notified.some((entry) => entry.type === 'warning'),
          `${verb}`,
        ).toBe(true)
        expect(
          notified.some((entry) => entry.message.includes('failed unexpectedly')),
          `${verb}: a missing cgc is a graceful settle, not the catch-all`,
        ).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('turns an unguarded handler defect into the catch-all error notice — never a crash, never a blocked session', async () => {
    // The command layer guards every cgc/state call it expects to fail; a
    // defect that slips past those guards (here: a throwing in-flight probe)
    // must resolve as ONE error notice, not an exception out of the handler.
    const dir = makeIndexedWorkspace()
    try {
      for (const verb of ['index', 'sync']) {
        const { ctx, notified } = makeContext(undefined, dir)
        const brokenRunner = {
          isInFlight(): boolean {
            throw new Error('broken in-flight probe')
          },
          run() {
            throw new Error('must not be reached (guard should have stopped first)')
          },
        }
        await handleCgcInvocation(verb, ctx, {
          runner: brokenRunner as unknown as CgcRunner,
        })

        expect(notified, verb).toHaveLength(1)
        expect(notified[0]?.type, verb).toBe('error')
        expect(notified[0]?.message, verb).toContain('failed unexpectedly')
        expect(notified[0]?.message, verb).toContain('nothing was run')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('swallows a run promise that rejects (safety net: the settle chain never surfaces an unhandled rejection)', async () => {
    // The runner contract resolves every runtime failure, so a REJECTING run
    // promise is a violation — the settle chain's `.catch` safety net must
    // absorb it. Without that net, bun:test fails this test with an
    // unhandled promise rejection, so the assertion genuinely bites.
    const dir = makeIndexedWorkspace()
    try {
      for (const verb of ['index', 'sync', 'doctor', 'report']) {
        const { ctx, notified } = makeContext(undefined, dir)
        const rejectingRunner = {
          isInFlight(): boolean {
            return false
          },
          run(): Promise<CgcCommandResult> {
            return new Promise<CgcCommandResult>((_resolve, reject) => {
              reject(new Error(`runner contract violation (${verb})`))
            })
          },
        }
        await handleCgcInvocation(verb, ctx, {
          runner: rejectingRunner as unknown as CgcRunner,
        })
        // Let the rejected settle chain run out (the safety net absorbs it).
        await Promise.resolve()
        await Promise.resolve()

        // The start/progress notice still surfaced synchronously, and no
        // failure notice replaced it — the command neither crashed nor
        // blocked the session on a violating runner.
        expect(
          notified.some((entry) => entry.message.includes('started')),
          verb,
        ).toBe(true)
        expect(
          notified.some((entry) => entry.message.includes('failed unexpectedly')),
          verb,
        ).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns without awaiting cgc completion — pending background work never blocks the session', async () => {
    const dir = makeIndexedWorkspace()
    try {
      for (const verb of ['index', 'sync', 'doctor']) {
        const { ctx, notified } = makeContext(undefined, dir)
        const neverSettles = new Promise<CgcCommandResult>(() => {})
        const pendingRunner = {
          isInFlight(): boolean {
            return false
          },
          run(): Promise<CgcCommandResult> {
            return neverSettles
          },
        }
        const SESSION_WINDOW_MS = 200
        const outcome = await Promise.race([
          handleCgcInvocation(verb, ctx, { runner: pendingRunner as unknown as CgcRunner }),
          new Promise((resolve) => setTimeout(() => resolve('SESSION-BLOCKED'), SESSION_WINDOW_MS)),
        ])
        expect(outcome, `${verb}: the handler must return without awaiting cgc`).not.toBe(
          'SESSION-BLOCKED',
        )
        // The background trigger surfaced synchronously; the run is still
        // pending and the session was never blocked on it.
        expect(
          notified.some((entry) => entry.message.includes('started')),
          verb,
        ).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
