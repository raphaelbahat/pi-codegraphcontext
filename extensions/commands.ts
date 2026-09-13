// CGC slash commands (design D1 of openspec/changes/add-cgc-slash-commands;
// task 1.1: registration and dispatch; task 1.2: the status renderer).
//
// Pi's extension-command dispatch (verified against the installed
// `docs/extensions.md` and the resolved `_tryExecuteExtensionCommand` of
// pi-coding-agent 0.85.1) parses an invocation at the FIRST space:
//
//   /cgc status   -> command name `cgc`, argument string `status`
//
// A registered name containing a space can therefore never be invoked, and
// registering the same name repeatedly makes pi assign `:1`-style numeric
// invocation suffixes (`/review:1`, `/review:2`). The five user-facing
// commands — `/cgc status|index|sync|doctor|report` — are consequently reached
// through ONE `pi.registerCommand("cgc", …)` whose handler dispatches on the
// first argument token. Handlers receive everything after the command name as
// `args`; that is exactly the shape the documented API describes
// (`handler: async (args, ctx) => …` plus optional `getArgumentCompletions`).
//
// Task 1.1 owns registration and dispatch; task 1.2 implements the status
// renderer; task 1.3 factors the shared output-hygiene renderer below that
// every command's rendered text routes through — status, doctor, and report.
// The consent layer (2.1), the index command (2.2), the sync command (2.3),
// and the doctor/report commands (2.4) are implemented below. The surface registers NO
// agent tools (ADR 0001 — the CGC MCP server stays the only query engine) and
// never exposes CGC's deletion/cleanup verbs (`clean`/`delete`/`rm` are gated
// by `ALLOW_DB_DELETION` and deliberately have no command here; ADR 0003).
//
// Fail-open contract: registration never throws out of extension load, and
// every handler body swallows its own failures — a broken command must never
// crash or block the session (spec: "Fail-open command behavior").

import { join } from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { buildBusyNotice } from './busy'
import type { LifecycleConfig } from './config'
import { DEFAULT_SYNC_ARGS } from './drift'
import type { LifecycleActionInput, LifecycleSnapshot } from './lifecycle-state'
import type { CgcCommandResult, CgcRunner } from './runner'
import { isWorkspaceIndexed } from './workspace'

/** The registered pi command name — invoked as `/cgc …`. */
export const CGC_COMMAND_NAME = 'cgc'

/** One of the five human-facing `/cgc` subcommands. */
export type CgcSubcommandVerb = 'status' | 'index' | 'sync' | 'doctor' | 'report'

export interface CgcSubcommandSpec {
  /** The verb typed after `/cgc` (e.g. `status` for `/cgc status`). */
  verb: CgcSubcommandVerb
  /** One-line human description of what the subcommand does. */
  description: string
}

/**
 * The five registered subcommands, in usage order. This closed list is the
 * command surface: no `clean`/`delete`/`rm` verb may ever be added here
 * (ADR 0003 — deletion-gated CGC verbs are never exposed).
 */
export const CGC_SUBCOMMANDS: readonly CgcSubcommandSpec[] = Object.freeze([
  {
    verb: 'status',
    description: 'Show the active workspace, lifecycle state, last action, and running work',
  },
  {
    verb: 'index',
    description: 'Create the missing index, or (with confirmation) force-rebuild the existing one',
  },
  {
    verb: 'sync',
    description: 'Trigger an incremental drift sync for the active workspace',
  },
  {
    verb: 'doctor',
    description: 'Run cgc diagnostics and render the bounded, cleaned output',
  },
  {
    verb: 'report',
    description:
      'Write the CGC quality report to the confirmed destination (confirmation required)',
  },
])

/** The full usage text rendered for a bare or unknown `/cgc` invocation. */
export function usageText(): string {
  const lines = [`cgc: CodeGraphContext commands for this workspace. Usage: /cgc <command> [args]`]
  for (const spec of CGC_SUBCOMMANDS) {
    lines.push(`  ${spec.verb} — ${spec.description}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Status renderer (task 1.2)
// ---------------------------------------------------------------------------

/**
 * Read-only state the status renderer consumes. Status is a passive renderer
 * (ADR-0004): everything here is a synchronous read — the production wiring
 * resolves snapshots from the gate's per-session lifecycle store (with the
 * process-lifetime store as fallback) and the in-flight read from the shared
 * runner's dedup map. Nothing here spawns, polls, or records.
 */
export interface CgcStatusState {
  /** Read-only lifecycle snapshot for the workspace; null when none recorded. */
  snapshot(cwd: string): LifecycleSnapshot | null
  /** Whether any cgc command is currently in flight for the workspace. */
  isInFlight(cwd: string): boolean
}

/**
 * Minimal read-only view of the freshness capability (design D5 of
 * add-cgc-freshness-drift-sync). That change is not part of this
 * installation, so the status renderer treats a missing provider as
 * "capability not present" and omits the freshness section — the specified
 * degradation, not an error (slash-commands migration plan).
 */
export interface CgcFreshnessSummary {
  status: 'fresh' | 'possibly-stale' | 'syncing' | 'skipped-busy' | 'disabled'
  /** When the last incremental sync completed (epoch ms); null when none ran. */
  lastSyncedAt: number | null
  /** When the workspace was marked possibly stale (epoch ms); null when fresh. */
  staleSince: number | null
}

/**
 * Optional wiring for the command surface; every omission degrades fail-open
 * (an unwired command still renders a well-formed status instead of throwing).
 */
export interface CgcCommandDependencies {
  /**
   * Lifecycle-state surface for the status renderer. Defaults to a passive
   * "nothing recorded" surface so a bare invocation renders an unavailable
   * status exactly like the lifecycle-state null convention.
   */
  state?: CgcStatusState
  /**
   * Freshness capability accessor. Omit, or return null, when
   * add-cgc-freshness-drift-sync is not present — the status then omits the
   * freshness section (specified degradation).
   */
  freshness?: (cwd: string) => CgcFreshnessSummary | null
  /**
   * The shared cgc runner (tasks 2.2+): background spawn with per-workspace
   * dedup for the action verbs. Absent (runner construction failed) → the
   * spawning verbs report cgc as unavailable and run nothing (fail-open).
   * Also typed to accept an explicit `undefined` (the extension entry wires
   * the possibly-unconstructed cached runner under strict optional types).
   */
  runner?: CgcRunner | undefined
  /**
   * Resolved lifecycle config; `autoCreate` is the change-1 auto-create
   * consent gate the creation path reuses (design D2). Absent → treated as
   * off (the config default), so `/cgc index` never creates an index without
   * opt-in.
   */
  lifecycle?: Pick<LifecycleConfig, 'autoCreate'>
  /**
   * Records progress state into the lifecycle store (the spec's "visible
   * progress state" — `/cgc status` renders the recorded activity). Absent →
   * the command still runs and notifies, but records no state (fail-open).
   */
  recordAction?: (input: LifecycleActionInput) => unknown
}

/** One rendered status report: everything {@link renderStatusText} needs. */
export interface CgcStatusView {
  /** The active workspace (the Pi session cwd — never process.cwd()). */
  cwd: string
  /** Latest lifecycle snapshot for the workspace; null when none recorded. */
  snapshot: LifecycleSnapshot | null
  /** Whether a cgc command is currently in flight for the workspace. */
  workInFlight: boolean
  /** Read-only freshness summary when the capability is present; null otherwise. */
  freshness: CgcFreshnessSummary | null
}

// ---------------------------------------------------------------------------
// Shared output-hygiene renderer (task 1.3)
// ---------------------------------------------------------------------------

/**
 * Size budget for rendered command output (head+tail bounding, design D4).
 * Every command's rendered text — status, doctor, report — passes through the
 * same cap, so pathological output can never flood the session transcript.
 */
export const OUTPUT_TEXT_BUDGET = 4096

/**
 * Control/ANSI-escape stripping for rendered text (pre-ADR-0005 discipline:
 * rendered output embeds state detail strings and raw cgc command output, so
 * defense in depth keeps any escape sequence out of the session transcript).
 * Tab/newline/carriage return are preserved — they are layout, not escapes.
 *
 * Task 1.3 widens the status-local pass (task 1.2) into the shared rule and
 * also strips standalone C1 controls (U+0080–U+009F, including the
 * one-character CSI U+009B): a control byte never survives into a transcript,
 * even without its ESC introducer.
 */
// Built with `new RegExp` on purpose: this pattern exists to match control
// bytes, so a regex literal containing control-character escapes would trip
// biome's `noControlCharactersInRegex`; string escapes sidestep the false
// positive while keeping the exact same pattern.
const ESC_CHAR = '\\x1b'
const CONTROL_SEQUENCE_PATTERN = new RegExp(
  `${ESC_CHAR}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^\\x07${ESC_CHAR}]*(?:\\x07|${ESC_CHAR}\\\\)|[()#][0-9A-Za-z]|[\\x2d-\\x5f])|[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]`,
  'g',
)

// Standalone C1 controls (U+0080–U+009F, e.g. the one-character CSI U+009B)
// are stripped as well (task 1.3): a control byte never survives into a
// transcript, even without its ESC introducer. Built from a string (like
// CONTROL_SEQUENCE_PATTERN) so biome's `noControlCharactersInRegex` sees no
// control bytes in a regex literal.
const C1_CONTROL_PATTERN = /[\u0080-\u009f]/g

/** Strip control sequences and ANSI escapes from text (see pattern doc). */
export function stripControlSequences(text: string): string {
  return text.replace(CONTROL_SEQUENCE_PATTERN, '').replace(C1_CONTROL_PATTERN, '')
}

/** Explicit truncation marker naming the original size (design D4). */
export function truncationMarker(originalLength: number, label = 'command'): string {
  return `\n… [cgc ${label} output truncated, original ${originalLength} chars]`
}

/** Options controlling the shared size-bound (design D4). */
export interface CgcOutputBoundOptions {
  /**
   * Size cap in characters. Defaults to {@link OUTPUT_TEXT_BUDGET} — the
   * shared cap every command renders under.
   */
  budget?: number
  /**
   * Command name embedded in the truncation marker (e.g. "status" renders
   * "cgc status output truncated …"). Defaults to "command".
   */
  label?: string
}

/**
 * Bound rendered text to a budget, preserving head and tail with an explicit
 * truncation marker (design D4: size-bounded render with head+tail
 * preservation). Command output is generated and short in the common case, so
 * this is a fail-safe net for pathological embedded detail strings and raw
 * cgc output, not a hot path. When even the marker cannot fit the budget the
 * marker alone is returned — the truncation contract still holds.
 */
export function boundText(text: string, options: CgcOutputBoundOptions = {}): string {
  const budget = options.budget ?? OUTPUT_TEXT_BUDGET
  if (text.length <= budget) return text
  const marker = truncationMarker(text.length, options.label ?? 'command')
  if (budget < marker.length) return marker
  const headLength = Math.floor((budget - marker.length) / 2)
  return `${text.slice(0, headLength)}${marker}${text.slice(text.length - (budget - marker.length - headLength))}`
}

/**
 * The shared output-hygiene pipeline (design D4): strip control sequences,
 * then size-bound with head+tail preservation and an explicit truncation
 * marker. Every command's rendered output routes through this one function —
 * the status renderer consumes it directly, and doctor/report (task 2.4) feed
 * raw `cgc` command output through it before rendering.
 */
export function renderCommandText(text: string, options: CgcOutputBoundOptions = {}): string {
  return boundText(stripControlSequences(text), options)
}

/** Human label for a lifecycle state; null renders as unavailable (convention). */
export function lifecycleStateLabel(state: LifecycleSnapshot['state']): string {
  return state ?? 'unavailable'
}

/** Human labels for the lifecycle activity markers (the HUD chip vocabulary). */
const ACTIVITY_LABELS: Readonly<Record<LifecycleSnapshot['activity'], string>> = Object.freeze({
  idle: 'none',
  indexing: 'indexing',
  syncing: 'syncing',
  rebuilding: 'rebuilding',
})

/** Human labels for the freshness capability states (freshness design D5). */
const FRESHNESS_LABELS: Readonly<Record<CgcFreshnessSummary['status'], string>> = Object.freeze({
  fresh: 'fresh',
  'possibly-stale': 'possibly stale',
  syncing: 'syncing',
  'skipped-busy': 'skipped as busy',
  disabled: 'disabled',
})

/** Compact relative time ("just now", "42s ago", "7m ago", "3h ago", "2d ago"). */
export function timeAgo(at: number, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - at)
  if (elapsed < 1_000) return 'just now'
  const seconds = Math.floor(elapsed / 1_000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * Gather the read-only inputs for one status report. Never throws and never
 * spawns: every read is guarded fail-open (a broken state surface degrades to
 * "nothing recorded", exactly like the rest of the extension).
 */
export function buildStatusView(cwd: string, deps: CgcCommandDependencies = {}): CgcStatusView {
  const state = deps.state
  let snapshot: LifecycleSnapshot | null = null
  try {
    snapshot = state?.snapshot(cwd) ?? null
  } catch {
    snapshot = null
  }
  let workInFlight = false
  try {
    workInFlight = state?.isInFlight(cwd) ?? false
  } catch {
    workInFlight = false
  }
  let freshness: CgcFreshnessSummary | null = null
  if (typeof deps.freshness === 'function') {
    try {
      freshness = deps.freshness(cwd)
    } catch {
      freshness = null
    }
  }
  return { cwd, snapshot, workInFlight, freshness }
}

function formatLastActionLine(snapshot: LifecycleSnapshot | null): string {
  const lastAction = snapshot?.lastAction ?? null
  if (lastAction === null) return 'Last action: none recorded'
  return `Last action: ${lastAction.kind} — ${lastAction.detail} (${timeAgo(lastAction.at)})`
}

function formatRunningWorkLine(snapshot: LifecycleSnapshot | null, workInFlight: boolean): string {
  const activity = snapshot?.activity ?? 'idle'
  if (activity !== 'idle') {
    const startedDetail = snapshot?.lastAction?.kind.endsWith('-started')
      ? ` — ${snapshot.lastAction.detail}`
      : ''
    // The running action and its progress state, instead of a terminal label
    // (spec: "shows the running action and its progress state").
    return `Running work: ${ACTIVITY_LABELS[activity]} (in progress)${startedDetail}`
  }
  if (workInFlight) {
    return 'Running work: a cgc command is in flight for this workspace (index/sync — its lifecycle progress state has not been recorded yet)'
  }
  return 'Running work: none'
}

function formatFreshnessLine(freshness: CgcFreshnessSummary): string {
  const label = FRESHNESS_LABELS[freshness.status] ?? freshness.status
  const hints: string[] = []
  if (freshness.status === 'possibly-stale' && freshness.staleSince !== null) {
    hints.push(`stale since ${timeAgo(freshness.staleSince)}`)
    hints.push('run /cgc sync to reconcile')
  }
  if (freshness.status === 'syncing') hints.push('sync in progress')
  if (freshness.status === 'skipped-busy') {
    hints.push('sync skipped: another CGC process holds the embedded database')
    hints.push('run /cgc sync again once it is free')
  }
  if (freshness.lastSyncedAt !== null) {
    hints.push(`last synced ${timeAgo(freshness.lastSyncedAt)}`)
  }
  const suffix = hints.length > 0 ? ` — ${hints.join('; ')}` : ''
  return `Freshness: ${label}${suffix}`
}

/**
 * Render one status report (task 1.2). Lines:
 *   - header naming the active workspace,
 *   - lifecycle state (with the classification reason when recorded),
 *   - the last recorded action (kind, detail, relative time; "none recorded"
 *     when the store has nothing yet),
 *   - running-work progress: the activity label while work runs (indexing /
 *     syncing / rebuilding) or an in-flight fallback, "none" when idle,
 *   - the freshness section ONLY when the freshness capability is present
 *     (specified degradation otherwise).
 *
 * The final text goes through the shared output-hygiene pipeline (task 1.3):
 * control-sequence-stripped and size-bounded with an explicit marker (design
 * D4).
 */
export function renderStatusText(view: CgcStatusView): string {
  const lines: string[] = []
  lines.push(`CGC status — ${view.cwd}`)

  const snapshot = view.snapshot
  if (snapshot === null) {
    lines.push(
      'Lifecycle: unavailable — no lifecycle state recorded yet for this workspace (the session-start gate has not evaluated it; this view is passive and performs no work)',
    )
  } else {
    const reason =
      snapshot.reason !== null && snapshot.reason.length > 0 ? ` — ${snapshot.reason}` : ''
    lines.push(`Lifecycle: ${lifecycleStateLabel(snapshot.state)}${reason}`)
  }

  lines.push(formatLastActionLine(snapshot))
  lines.push(formatRunningWorkLine(snapshot, view.workInFlight))

  if (view.freshness !== null) {
    lines.push(formatFreshnessLine(view.freshness))
  }

  return renderCommandText(lines.join('\n'), { label: 'status' })
}

// ---------------------------------------------------------------------------
// Consent layer (task 2.1, ADR-0003)
// ---------------------------------------------------------------------------

/**
 * Report filename documented by CGC (`cgc report` — "Generate CGC_REPORT.md
 * with god-node, complexity, and coupling metrics"). CGC's docs state the
 * filename but NOT the write location (validate.md), so the report handler
 * (task 2.4) resolves the exact destination path empirically and confirms it
 * per write — this constant is the name half of that destination.
 */
export const CGC_REPORT_FILENAME = 'CGC_REPORT.md'

/**
 * Minimal consent seam (defensive narrowing, same discipline as
 * {@link CgcCommandUi}): the real session UI satisfies this structurally —
 * only the one dialog the consent model touches is exposed, so tests pass
 * fakes and a broken session UI can never break a command handler.
 */
export interface CgcConsentUi {
  /** Show a confirmation dialog; resolves true only on explicit user consent. */
  confirm(title: string, message: string): Promise<boolean>
}

/**
 * The session surface the consent model reads: dialog methods exist only when
 * `hasUI` is true (print/JSON mode set it false — validate.md's headless-safe
 * requirement), so the gate checks it before ever touching `ui`.
 */
export interface CgcConsentSurface {
  hasUI: boolean
  ui: CgcConsentUi
}

/**
 * One consent exchange, fail-open (ADR-0003 / the command fail-open contract):
 * consent is granted ONLY by an explicit `true` from the confirmation dialog.
 * A missing dialog surface (print/JSON mode has `hasUI:false`), a throwing
 * dialog, or a user decline all resolve declined — never an exception, never
 * a silent grant. There is deliberately no skip-confirmation path: every
 * destructive/file-writing action re-asks, every time ("skippable only by
 * declining the action" — ADR-0003).
 */
async function askConsent(
  ctx: CgcConsentSurface,
  title: string,
  message: string,
): Promise<boolean> {
  if (!ctx.hasUI) return false
  try {
    return (await ctx.ui.confirm(title, message)) === true
  } catch {
    return false
  }
}

/**
 * The force-rebuild confirmation message (ADR-0003 / spec "Force rebuild
 * requires confirmation"): the prompt NAMES THE REPLACE EFFECT — a rebuild
 * discards the existing index — before any consent can be given.
 */
export function forceRebuildConsentMessage(cwd: string): string {
  return `A force rebuild replaces the existing CGC index at ${cwd}: the current index is discarded and rebuilt from scratch. No data outside the index is touched. Continue?`
}

/**
 * The report-write confirmation message (ADR-0003 / spec "Report generated
 * after confirmation"): the prompt names the exact destination path that was
 * resolved empirically (validate.md), never a guessed location.
 */
export function reportWriteConsentMessage(destinationPath: string): string {
  return `This writes the CGC quality report to ${destinationPath}. Continue?`
}

/**
 * Ask for explicit in-session consent to a force rebuild (`/cgc index
 * --force`, task 2.2's force path). True only on explicit confirmation; every
 * other resolution — no dialog surface, a throwing dialog, a decline — is
 * declined and never throws into the command handler. The caller must not
 * proceed on `false` (spec: "no `cgc` maintenance command runs and the
 * existing index is untouched").
 */
export async function confirmForceRebuild(ctx: CgcConsentSurface, cwd: string): Promise<boolean> {
  return askConsent(ctx, 'Rebuild the CGC index?', forceRebuildConsentMessage(cwd))
}

/**
 * Ask for explicit in-session consent to writing the CGC report
 * (`/cgc report`, task 2.4's post-confirmation trigger). True only on
 * explicit confirmation; every other resolution is declined and never throws
 * (spec: "no report file is written and no `cgc` report command runs").
 */
export async function confirmReportWrite(
  ctx: CgcConsentSurface,
  destinationPath: string,
): Promise<boolean> {
  return askConsent(ctx, 'Write the CGC report?', reportWriteConsentMessage(destinationPath))
}

/**
 * The declined notice for a force rebuild (spec "Confirmation declined": no
 * maintenance command runs and the existing index is untouched). Handlers
 * notify this and stop — the guarantee is the whole point of the gate.
 */
export function forceRebuildDeclinedNotice(cwd: string): string {
  return `cgc index: force rebuild declined — no maintenance command ran and the existing index at ${cwd} is untouched.`
}

/**
 * The declined notice for a report write (spec "Report declined": no report
 * file is written and no `cgc` report command runs). Handlers notify this and
 * stop — nothing is spawned on a declined gate.
 */
export function reportWriteDeclinedNotice(destinationPath: string): string {
  return `cgc report: declined — no report was written to ${destinationPath} and no report command ran.`
}

// ---------------------------------------------------------------------------
// Handler plumbing
// ---------------------------------------------------------------------------

type VerbHandler = (
  ctx: ExtensionCommandContext,
  rest: string,
  deps: CgcCommandDependencies,
) => Promise<void> | void

/**
 * Minimal UI seam the command renderers touch (defensive narrowing: tests pass
 * fakes, and a broken session UI must never break a command).
 */
interface CgcCommandUi {
  notify?: (message: string, type?: 'info' | 'warning' | 'error') => void
}

/** Fire-and-forget notify that can never throw into a command handler. */
function notify(
  ctx: { ui: CgcCommandUi },
  message: string,
  type: 'info' | 'warning' | 'error',
): void {
  try {
    ctx.ui.notify?.(message, type)
  } catch {
    // Fail-open: a throwing notify sink must never break a command handler.
  }
}

// ---------------------------------------------------------------------------
// Index command (task 2.2)
// ---------------------------------------------------------------------------

/**
 * The force flag of `/cgc index` (design D2: the one confirmed index action —
 * a rebuild replaces the existing index).
 */
export const INDEX_FORCE_FLAG = '--force'

/**
 * Parse `/cgc index` option tokens. Only `--force` is understood; any other
 * token is collected into `unknown` so the handler can refuse with usage
 * guidance instead of silently running something unexpected.
 */
export function parseIndexOptions(rest: string): { force: boolean; unknown: string[] } {
  const unknown: string[] = []
  let force = false
  for (const token of rest.trim().split(/\s+/)) {
    if (token.length === 0) continue
    if (token === INDEX_FORCE_FLAG) force = true
    else unknown.push(token)
  }
  return { force, unknown }
}

/** The unavailable notice for a spawning verb (fail-open: nothing was run). */
export function cgcUnavailableNotice(cwd: string, verb: string, detail: string): string {
  return [
    `cgc ${verb}: cgc is unavailable for ${cwd} — nothing was run (${detail}).`,
    'To enable it, install CodeGraphContext and make sure `cgc` is on PATH, or set "cgc": { "executable": "…" } in .pi/cgc.json (project) / ~/.pi/agent/cgc.json (global), or CGC_EXECUTABLE.',
  ].join('\n')
}

/**
 * The declined notice for `/cgc index` when the change-1 auto-create gate
 * (config `lifecycle.autoCreate`, default off) is closed: no cgc command ran
 * and the workspace is untouched (design D2 — creation follows the
 * auto-create opt-in; there is no second auto-create confirmation dialog).
 */
export function indexCreationDeclinedNotice(cwd: string): string {
  return [
    `cgc index: index creation is opt-in and was not performed (lifecycle.autoCreate is off) — no cgc command ran and the workspace at ${cwd} is untouched.`,
    'To create the index, set "lifecycle": { "autoCreate": true } in .pi/cgc.json (project) or ~/.pi/agent/cgc.json (global), or CGC_LIFECYCLE_AUTO_CREATE=1 — or run `cgc index .` in a terminal.',
  ].join('\n')
}

/**
 * The started notice for a background index action. The progress state itself
 * is the recorded lifecycle action (indexing/rebuilding), rendered by
 * `/cgc status` while the work runs.
 */
export function indexStartedNotice(
  cwd: string,
  args: readonly string[],
  mode: 'create' | 'incremental' | 'rebuild',
): string {
  const command = `cgc ${args.join(' ')}`
  if (mode === 'create') {
    return `cgc index: index creation started in the background for ${cwd} (${command}).`
  }
  if (mode === 'rebuild') {
    return `cgc index: force rebuild started in the background for ${cwd} (${command}); the previous index is being replaced.`
  }
  return `cgc index: incremental indexing started in the background for ${cwd} (${command}).`
}

/** The dedup notice: no second spawn while a cgc command is in flight. */
export function indexAlreadyInFlightNotice(cwd: string): string {
  return `cgc index: a cgc command is already running for ${cwd} — nothing new was started; run /cgc status to see the running work.`
}

/** The usage notice for unrecognized `/cgc index` option tokens. */
export function indexUnknownOptionNotice(unknown: readonly string[]): string {
  return `cgc index: unrecognized option(s) ${unknown.map((token) => `\`${token}\``).join(', ')}; syntax is /cgc index [--force] — nothing was run.`
}

/**
 * The started notice for a background sync (task 2.3). The progress state
 * itself is the recorded `drift-sync-started` action, rendered by `/cgc
 * status` as activity "syncing" while the work runs.
 */
export function syncStartedNotice(cwd: string, args: readonly string[]): string {
  return `cgc sync: incremental drift sync started in the background for ${cwd} (cgc ${args.join(' ')}).`
}

/**
 * The dedup notice for `/cgc sync` (task 2.3): a sync issued while cgc work
 * is already running for the workspace JOINS the in-flight run rather than
 * starting a duplicate — sync runs the same incremental `cgc index .`
 * command, so the already-running command satisfies it. Progress stays
 * visible in `/cgc status`.
 */
export function syncJoinInFlightNotice(cwd: string): string {
  return `cgc sync: a cgc command is already running for ${cwd} — this sync joins that in-flight run instead of starting a duplicate; run /cgc status to see the running work.`
}

/**
 * The declined notice for `/cgc sync` on an unindexed workspace when the
 * change-1 auto-create gate (config `lifecycle.autoCreate`, default off) is
 * closed: sync on an unindexed workspace would be an index creation, so it
 * follows the same opt-in gate (design D2) — no cgc command ran and the
 * workspace is untouched.
 */
export function syncDeclinedNotice(cwd: string): string {
  return [
    `cgc sync: this workspace is not indexed yet, and index creation is opt-in (lifecycle.autoCreate is off) — no cgc command ran and the workspace at ${cwd} is untouched.`,
    'To create the index, set "lifecycle": { "autoCreate": true } in .pi/cgc.json (project) or ~/.pi/agent/cgc.json (global), or CGC_LIFECYCLE_AUTO_CREATE=1 — or run `cgc index .` in a terminal.',
  ].join('\n')
}

/**
 * The usage notice for `/cgc sync` argument tokens: sync takes no options,
 * so an unexpected argument is refused with usage guidance instead of
 * silently spawning something unexpected (same fail-safe as index).
 */
export function syncUnknownArgumentNotice(argument: string): string {
  return `cgc sync: unrecognized argument \`${argument}\`; syntax is /cgc sync — nothing was run.`
}

/**
 * What kind of background work a spawn represents (maps to the lifecycle
 * activity/progress-state action pair). `indexing`/`rebuilding` are the
 * `/cgc index` surfaces; `syncing` is `/cgc sync` — the same incremental
 * `cgc index .` run through the runner, recorded with the drift-sync action
 * kinds so `/cgc status` shows activity "syncing" while it runs.
 */
type IndexWorkKind = 'indexing' | 'rebuilding' | 'syncing'

/**
 * Notice words and the recorded start/settle action kinds per work kind
 * (the lifecycle-state action vocabulary owns the literals). One table, used
 * by every spawn branch — the shared spawn path never branches on the verb
 * beyond this table (design D1).
 */
interface WorkKindWords {
  /** Verb rendered in notices (`index` / `sync`). */
  verb: string
  /** Human name for the background work in the not-completed notice. */
  workLabel: string
  /** Recorded `*-started` action kind (lifecycle-state ACTIVITY_BY_START). */
  startedKind: 'indexing-started' | 'rebuild-started' | 'drift-sync-started'
  /** Recorded `*-settled` action kind (clears the activity marker). */
  settledKind: 'indexing-settled' | 'rebuild-settled' | 'drift-sync-settled'
}

const WORK_KIND_WORDS: Readonly<Record<IndexWorkKind, WorkKindWords>> = Object.freeze({
  indexing: {
    verb: 'index',
    workLabel: 'index command',
    startedKind: 'indexing-started',
    settledKind: 'indexing-settled',
  },
  rebuilding: {
    verb: 'index',
    workLabel: 'index command',
    startedKind: 'rebuild-started',
    settledKind: 'rebuild-settled',
  },
  syncing: {
    verb: 'sync',
    workLabel: 'incremental sync',
    startedKind: 'drift-sync-started',
    settledKind: 'drift-sync-settled',
  },
})

/**
 * Start one background index action (create / incremental / force rebuild /
 * incremental sync) through the shared runner (design D1: no duplicated
 * spawn logic): deduplicated against in-flight work, progress state recorded
 * into the lifecycle store, and a lock conflict surfaced as the one-time
 * busy notice (design D3 — reuse busy.ts). Fire-and-forget: the caller never
 * awaits cgc completion; the settled outcome records into state for
 * downstream surfaces (`/cgc status`). Returns false — and notifies — when
 * nothing was started (unavailable runner, in-flight work, spawn failure);
 * the caller then reports no progress.
 */
function startIndexWork(
  ctx: { cwd: string; ui: CgcCommandUi },
  deps: CgcCommandDependencies,
  args: readonly string[],
  kind: IndexWorkKind,
  startedDetail: string,
): boolean {
  const words = WORK_KIND_WORDS[kind]
  const runner = deps.runner
  if (runner === undefined) {
    notify(
      ctx,
      cgcUnavailableNotice(
        ctx.cwd,
        words.verb,
        'the cgc command runner is not available (cgc missing or not configured)',
      ),
      'warning',
    )
    return false
  }

  // Command-layer dedup (the runner additionally dedups identical
  // invocations): a workspace already running cgc work does not get a second
  // spawn from this surface. A sync JOINS the in-flight run instead of
  // duplicating it (task 2.3) — the same incremental `cgc index .` command
  // is already satisfying it; index actions just report the running work.
  if (runner.isInFlight(ctx.cwd)) {
    notify(
      ctx,
      kind === 'syncing' ? syncJoinInFlightNotice(ctx.cwd) : indexAlreadyInFlightNotice(ctx.cwd),
      'info',
    )
    return false
  }

  let started: Promise<CgcCommandResult>
  try {
    started = runner.run(ctx.cwd, { args })
  } catch (error) {
    notify(
      ctx,
      cgcUnavailableNotice(
        ctx.cwd,
        words.verb,
        `could not spawn cgc: ${error instanceof Error ? error.message : String(error)}`,
      ),
      'error',
    )
    return false
  }

  try {
    deps.recordAction?.({
      kind: words.startedKind,
      cwd: ctx.cwd,
      detail: startedDetail,
      ok: null,
    })
  } catch {
    // Fail-open: state recording must never break the command.
  }

  // Settle: record the outcome into state and surface the one-time busy
  // notice on a lock conflict (design D3 — identical to the gate's
  // skip-as-busy policy, reusing busy.ts). The runner resolves runtime
  // failures, so the settle chain can never reject; the safety net keeps an
  // unforeseen defect from surfacing as an unhandled rejection.
  started
    .then((result) => {
      if (result.code === 'BUSY') {
        notify(ctx, buildBusyNotice(ctx.cwd, result.message), 'warning')
        try {
          deps.recordAction?.({
            kind: 'busy-skipped',
            cwd: ctx.cwd,
            detail: `${words.workLabel} reported a lock conflict; skipped as busy (${result.message})`,
            ok: null,
          })
        } catch {
          // Fail-open.
        }
        return
      }
      try {
        deps.recordAction?.({
          kind: words.settledKind,
          cwd: ctx.cwd,
          detail: result.message,
          ok: result.ok,
        })
      } catch {
        // Fail-open.
      }
      if (!result.ok) {
        notify(
          ctx,
          `cgc ${words.verb}: the background ${words.workLabel} did not complete (${result.code.toLowerCase()}): ${result.message}`,
          'warning',
        )
      }
    })
    .catch(() => {
      // Fail-open: the settle chain must never surface an unhandled rejection.
    })
  return true
}

/**
 * `/cgc index` handler (task 2.2). Two paths, both through the shared runner:
 *
 *   - creation / incremental (no `--force`): an unindexed workspace follows
 *     the change-1 auto-create consent gate (config `lifecycle.autoCreate`) —
 *     a closed gate declines with a notice and spawns nothing (design D2:
 *     creation follows the opt-in; there is no second auto-create
 *     confirmation). Indexed workspaces run the non-destructive incremental
 *     `cgc index .` freely.
 *   - force (`--force`): runs only behind explicit confirmation
 *     (confirmForceRebuild, ADR-0003); a decline notifies and stops —
 *     nothing is ever spawned on a declined gate.
 *
 * Work is triggered in the background — the handler never awaits cgc
 * completion — with progress state recorded into the lifecycle store.
 */
async function handleIndexCommand(
  ctx: ExtensionCommandContext,
  rest: string,
  deps: CgcCommandDependencies,
): Promise<void> {
  const { force, unknown } = parseIndexOptions(rest)
  if (unknown.length > 0) {
    notify(ctx, indexUnknownOptionNotice(unknown), 'info')
    return
  }

  if (force) {
    const granted = await confirmForceRebuild(ctx, ctx.cwd)
    if (!granted) {
      notify(ctx, forceRebuildDeclinedNotice(ctx.cwd), 'info')
      return
    }
    const args = [...DEFAULT_SYNC_ARGS, INDEX_FORCE_FLAG]
    const started = startIndexWork(
      ctx,
      deps,
      args,
      'rebuilding',
      'background index rebuild started by /cgc index --force (previous index is being replaced)',
    )
    if (started) {
      notify(ctx, indexStartedNotice(ctx.cwd, args, 'rebuild'), 'info')
    }
    return
  }

  // Creation / incremental path. Unindexed workspaces are consent-gated by
  // the change-1 auto-create opt-in (design D2); indexed workspaces run the
  // same incremental `cgc index .` freely — it is the non-destructive
  // reconcile the CLI performs by default.
  const indexed = isWorkspaceIndexed(ctx.cwd)
  if (!indexed && deps.lifecycle?.autoCreate !== true) {
    notify(ctx, indexCreationDeclinedNotice(ctx.cwd), 'info')
    try {
      deps.recordAction?.({
        kind: 'unindexed-notice',
        cwd: ctx.cwd,
        detail:
          'index creation declined by /cgc index: lifecycle.autoCreate is off; no cgc command ran',
        ok: null,
      })
    } catch {
      // Fail-open: state recording must never break the command.
    }
    return
  }

  const args = [...DEFAULT_SYNC_ARGS]
  const mode = indexed ? 'incremental' : 'create'
  const startedDetail = indexed
    ? 'background incremental index run started by /cgc index'
    : 'background index creation started by /cgc index (lifecycle.autoCreate on)'
  const started = startIndexWork(ctx, deps, args, 'indexing', startedDetail)
  if (started) {
    notify(ctx, indexStartedNotice(ctx.cwd, args, mode), 'info')
  }
}

/**
 * `/cgc sync` handler (task 2.3). Sync IS the incremental `cgc index .`
 * command — the non-destructive reconcile the CLI performs by default —
 * triggered through the SAME shared spawn path as index (design D1: no
 * duplicated detection/consent/spawn logic), so the runner's per-workspace
 * dedup means a sync issued while the session-start gate's sync (or any
 * index work) is already running JOINS that in-flight run: no duplicate
 * command is spawned (design "user triggers sync while already syncing"
 * risk). Non-destructive, it runs without confirmation (design D2); an
 * embedded-database lock exits cleanly with the one-time busy notice
 * (design D3 — buildBusyNotice, reused from busy.ts); and an unindexed
 * workspace follows the change-1 auto-create gate exactly like `/cgc index`
 * creation (design D2: creation is opt-in; there is no second auto-create
 * confirmation dialog). Work is triggered in the background — the handler
 * never awaits cgc completion — with progress state recorded as
 * `drift-sync-started`, so `/cgc status` shows activity "syncing" while it
 * runs.
 */
async function handleSyncCommand(
  ctx: ExtensionCommandContext,
  rest: string,
  deps: CgcCommandDependencies,
): Promise<void> {
  // Sync takes no options: refuse an unexpected argument with usage
  // guidance instead of silently spawning something unexpected.
  const restTrimmed = rest.trim()
  if (restTrimmed.length > 0) {
    notify(ctx, syncUnknownArgumentNotice(restTrimmed.split(/\s+/)[0] ?? restTrimmed), 'info')
    return
  }

  // The same creation gate as `/cgc index` (design D2): sync on an
  // unindexed workspace would be an index creation, which is opt-in
  // (config `lifecycle.autoCreate`) — a closed gate declines with a notice
  // and spawns nothing.
  const indexed = isWorkspaceIndexed(ctx.cwd)
  if (!indexed && deps.lifecycle?.autoCreate !== true) {
    notify(ctx, syncDeclinedNotice(ctx.cwd), 'info')
    try {
      deps.recordAction?.({
        kind: 'unindexed-notice',
        cwd: ctx.cwd,
        detail:
          'incremental sync declined by /cgc sync: the workspace is unindexed and lifecycle.autoCreate is off; no cgc command ran',
        ok: null,
      })
    } catch {
      // Fail-open: state recording must never break the command.
    }
    return
  }

  const args = [...DEFAULT_SYNC_ARGS]
  const started = startIndexWork(
    ctx,
    deps,
    args,
    'syncing',
    'background incremental drift sync started by /cgc sync',
  )
  if (started) {
    notify(ctx, syncStartedNotice(ctx.cwd, args), 'info')
  }
}

// ---------------------------------------------------------------------------
// Doctor command (task 2.4)
// ---------------------------------------------------------------------------

/**
 * The `cgc doctor` command line — the read-only diagnostic verb (spec 2.4:
 * "Run diagnostics to check system health and configuration"). Doctor is
 * non-destructive (design D2: it runs without confirmation) and records no
 * lifecycle state (spec: it performs no state changes): it is triggered
 * through the shared runner in the background and its settled output is
 * rendered through the shared output-hygiene pipeline.
 */
export const DOCTOR_ARGS: readonly string[] = ['doctor']

/**
 * The started notice for a background doctor run: the handler returns
 * immediately (no inline await — design risk line: commands trigger
 * background work), and the rendered diagnostics arrive with the settled
 * run.
 */
export function doctorStartedNotice(cwd: string, args: readonly string[]): string {
  return `cgc doctor: diagnostics started in the background for ${cwd} (cgc ${args.join(' ')}).`
}

/**
 * The usage notice for `/cgc doctor` argument tokens: doctor takes no
 * options, so an unexpected argument is refused with usage guidance instead
 * of silently spawning something unexpected (same fail-safe as sync).
 */
export function doctorUnknownArgumentNotice(argument: string): string {
  return `cgc doctor: unrecognized argument \`${argument}\`; syntax is /cgc doctor — nothing was run.`
}

/**
 * Surface one settled diagnostic-style run (doctor/report, task 2.4): the
 * captured output is rendered through the shared output-hygiene pipeline
 * (design D4 — control-stripped, size-bounded with an explicit truncation
 * marker) and the runner-level outcome is surfaced alongside it ("no
 * semantic parsing of doctor output beyond success/failure"). A `BUSY`
 * outcome is handled by the caller (design D3's one-time busy notice),
 * never here.
 */
function notifySettledRunOutput(
  ctx: { cwd: string; ui: CgcCommandUi },
  verb: string,
  result: CgcCommandResult,
  label: string,
): void {
  const parts = [result.stdout, result.stderr].filter((part) => part.length > 0)
  const rendered = parts.length > 0 ? renderCommandText(parts.join('\n'), { label }) : null
  if (result.ok) {
    if (rendered !== null) {
      notify(ctx, rendered, 'info')
    } else {
      notify(ctx, `cgc ${verb}: the command completed (${result.code.toLowerCase()}).`, 'info')
    }
    return
  }
  const failure = `cgc ${verb}: the command did not complete (${result.code.toLowerCase()}): ${result.message}`
  notify(ctx, rendered !== null ? `${failure}\n${rendered}` : failure, 'warning')
}

/**
 * `/cgc doctor` handler (task 2.4). Runs the read-only `cgc doctor` command
 * through the shared runner (design D1 — no duplicated spawn logic) in the
 * background and renders the settled output with bounded size and cleaned
 * formatting (design D4). Non-destructive, it runs without confirmation
 * (design D2) and records no lifecycle state (spec: doctor performs no state
 * changes). An embedded-database lock surfaces as the one-time busy notice
 * (design D3 — buildBusyNotice, reused from busy.ts); every other settle
 * renders the output and surfaces the runner-level outcome. The handler
 * never throws and never awaits cgc completion inline.
 */
async function handleDoctorCommand(
  ctx: ExtensionCommandContext,
  rest: string,
  deps: CgcCommandDependencies,
): Promise<void> {
  // Doctor takes no options: refuse an unexpected argument with usage
  // guidance instead of silently spawning something unexpected.
  const restTrimmed = rest.trim()
  if (restTrimmed.length > 0) {
    notify(ctx, doctorUnknownArgumentNotice(restTrimmed.split(/\s+/)[0] ?? restTrimmed), 'info')
    return
  }

  const runner = deps.runner
  if (runner === undefined) {
    notify(
      ctx,
      cgcUnavailableNotice(
        ctx.cwd,
        'doctor',
        'the cgc command runner is not available (cgc missing or not configured)',
      ),
      'warning',
    )
    return
  }

  let started: Promise<CgcCommandResult>
  try {
    started = runner.run(ctx.cwd, { args: DOCTOR_ARGS })
  } catch (error) {
    notify(
      ctx,
      cgcUnavailableNotice(
        ctx.cwd,
        'doctor',
        `could not spawn cgc: ${error instanceof Error ? error.message : String(error)}`,
      ),
      'error',
    )
    return
  }

  // Settle: render the diagnostics through the shared pipeline (design D4),
  // or surface the one-time busy notice on a lock conflict (design D3). The
  // runner resolves runtime failures, so the settle chain can never reject;
  // the safety net keeps an unforeseen defect from surfacing as an unhandled
  // rejection. Nothing here records state (spec: doctor performs no state
  // changes).
  started
    .then((result) => {
      if (result.code === 'BUSY') {
        notify(ctx, buildBusyNotice(ctx.cwd, result.message), 'warning')
        return
      }
      notifySettledRunOutput(ctx, 'doctor', result, 'doctor')
    })
    .catch(() => {
      // Fail-open: the settle chain must never surface an unhandled rejection.
    })

  notify(ctx, doctorStartedNotice(ctx.cwd, DOCTOR_ARGS), 'info')
}

// ---------------------------------------------------------------------------
// Report command (task 2.4)
// ---------------------------------------------------------------------------

/** The `--output` flag naming the exact report destination (cli/main.py:1945). */
export const REPORT_OUTPUT_FLAG = '--output'

/**
 * The report command line for one confirmed destination: `cgc report
 * --output <absolute path>`. CGC's docs name the report FILE but not where
 * it is written (validate.md), and the CLI writes to its process cwd unless
 * `--output` is given (verified empirically: cli/main.py:1945) — so the
 * extension resolves an ABSOLUTE destination and passes it via `--output` so
 * the confirmed path is exactly what is written (spec: the report file
 * exists at the confirmed destination path).
 */
export function reportArgs(destination: string): readonly string[] {
  return ['report', REPORT_OUTPUT_FLAG, destination]
}

/**
 * Resolve the report destination for a workspace: the documented filename
 * joined onto the SESSION cwd (never process.cwd()) as an absolute path.
 */
export function resolveReportDestination(cwd: string): string {
  return join(cwd, CGC_REPORT_FILENAME)
}

/**
 * The started notice for a background report run, naming the exact
 * destination that was confirmed and the exact command that writes it.
 */
export function reportStartedNotice(
  cwd: string,
  args: readonly string[],
  destination: string,
): string {
  return `cgc report: report generation started in the background for ${cwd}; ${destination} will be written on completion (cgc ${args.join(' ')}).`
}

/**
 * The usage notice for `/cgc report` argument tokens: report takes no
 * options — an unexpected argument is refused with usage guidance instead of
 * silently writing something unexpected (same fail-safe as sync).
 */
export function reportUnknownArgumentNotice(argument: string): string {
  return `cgc report: unrecognized argument \`${argument}\`; syntax is /cgc report — nothing was run.`
}

/**
 * Start one background report generation through the shared runner (design
 * D1): the confirmed destination is passed via `--output` so the written
 * path is exactly the confirmed one; progress state is recorded
 * (`report-started`/`report-settled`, so `/cgc status` shows the last
 * action); and a lock conflict surfaces as the one-time busy notice (design
 * D3 — buildBusyNotice, reused from busy.ts). Fire-and-forget: the caller
 * never awaits cgc completion; the settled output is rendered through the
 * shared output-hygiene pipeline. Returns false — and notifies — when
 * nothing was started (unavailable runner, spawn failure); the caller then
 * reports no progress.
 */
function startReportWork(
  ctx: { cwd: string; ui: CgcCommandUi },
  deps: CgcCommandDependencies,
  args: readonly string[],
): boolean {
  const runner = deps.runner
  if (runner === undefined) {
    notify(
      ctx,
      cgcUnavailableNotice(
        ctx.cwd,
        'report',
        'the cgc command runner is not available (cgc missing or not configured)',
      ),
      'warning',
    )
    return false
  }

  let started: Promise<CgcCommandResult>
  try {
    started = runner.run(ctx.cwd, { args })
  } catch (error) {
    notify(
      ctx,
      cgcUnavailableNotice(
        ctx.cwd,
        'report',
        `could not spawn cgc: ${error instanceof Error ? error.message : String(error)}`,
      ),
      'error',
    )
    return false
  }

  try {
    deps.recordAction?.({
      kind: 'report-started',
      cwd: ctx.cwd,
      detail: `background report generation started by /cgc report; writing to ${args[args.length - 1] ?? ''}`,
      ok: null,
    })
  } catch {
    // Fail-open: state recording must never break the command.
  }

  // Settle: record the outcome into state and surface the one-time busy
  // notice on a lock conflict (design D3 — identical to the gate's
  // skip-as-busy policy, reusing busy.ts). The runner resolves runtime
  // failures, so the settle chain can never reject; the safety net keeps an
  // unforeseen defect from surfacing as an unhandled rejection.
  started
    .then((result) => {
      if (result.code === 'BUSY') {
        notify(ctx, buildBusyNotice(ctx.cwd, result.message), 'warning')
        try {
          deps.recordAction?.({
            kind: 'busy-skipped',
            cwd: ctx.cwd,
            detail: `report generation reported a lock conflict; skipped as busy (${result.message})`,
            ok: null,
          })
        } catch {
          // Fail-open.
        }
        return
      }
      try {
        deps.recordAction?.({
          kind: 'report-settled',
          cwd: ctx.cwd,
          detail: result.message,
          ok: result.ok,
        })
      } catch {
        // Fail-open.
      }
      notifySettledRunOutput(ctx, 'report', result, 'report')
    })
    .catch(() => {
      // Fail-open: the settle chain must never surface an unhandled rejection.
    })
  return true
}

/**
 * `/cgc report` handler (task 2.4). Report writes a file into the workspace,
 * so it runs ONLY behind explicit in-session confirmation (design D2 /
 * ADR-0003): the prompt names the exact resolved destination path, and a
 * decline notifies and stops — no `cgc report` command ever runs on a
 * declined gate and no file is written (spec: "Report declined"). On
 * confirmation the generation runs through the shared runner in the
 * background with `--output` set to the confirmed absolute path (so the
 * confirmed path is exactly what is written), and the settled output is
 * rendered bounded and cleaned. The handler never throws and never awaits
 * cgc completion inline.
 */
async function handleReportCommand(
  ctx: ExtensionCommandContext,
  rest: string,
  deps: CgcCommandDependencies,
): Promise<void> {
  // Report takes no options: refuse an unexpected argument with usage
  // guidance instead of silently writing something unexpected.
  const restTrimmed = rest.trim()
  if (restTrimmed.length > 0) {
    notify(ctx, reportUnknownArgumentNotice(restTrimmed.split(/\s+/)[0] ?? restTrimmed), 'info')
    return
  }

  // Resolve the exact destination and confirm it BEFORE anything runs
  // (spec: "the extension confirms the exact path before writing").
  const destination = resolveReportDestination(ctx.cwd)
  const granted = await confirmReportWrite(ctx, destination)
  if (!granted) {
    notify(ctx, reportWriteDeclinedNotice(destination), 'info')
    return
  }

  const args = reportArgs(destination)
  const started = startReportWork(ctx, deps, args)
  if (started) {
    notify(ctx, reportStartedNotice(ctx.cwd, args, destination), 'info')
  }
}

const VERB_HANDLERS: Record<CgcSubcommandVerb, VerbHandler> = {
  // Task 1.2: the status renderer. Passive by construction (ADR-0004): it
  // reads lifecycle state and the runner's in-flight map and renders; it
  // never spawns cgc and performs no maintenance work.
  status: (ctx, _rest, deps) => {
    notify(ctx, renderStatusText(buildStatusView(ctx.cwd, deps)), 'info')
  },
  // Task 2.2: `/cgc index` — creation honors the change-1 auto-create gate;
  // `--force` runs only behind explicit confirmation; work is spawned through
  // the shared runner in the background with recorded progress state.
  index: async (ctx, rest, deps) => {
    await handleIndexCommand(ctx, rest, deps)
  },
  // Task 2.3: `/cgc sync` — the incremental `cgc index .` trigger through
  // the same shared runner path: dedup joins an in-flight run instead of
  // spawning a duplicate, busy locks exit with the one-time notice, and
  // unindexed workspaces follow the auto-create gate.
  sync: async (ctx, rest, deps) => {
    await handleSyncCommand(ctx, rest, deps)
  },
  // Task 2.4: `/cgc doctor` — the read-only diagnostic trigger through the
  // shared runner: runs without confirmation, records no state, and renders
  // the settled output bounded and cleaned (a busy lock exits with the
  // one-time notice).
  doctor: async (ctx, rest, deps) => {
    await handleDoctorCommand(ctx, rest, deps)
  },
  // Task 2.4: `/cgc report` — file-writing, so it runs only behind explicit
  // confirmation naming the exact destination; on confirmation the generation
  // runs in the background through the shared runner with `--output` set to
  // the confirmed absolute path, and the settled output is rendered bounded
  // and cleaned.
  report: async (ctx, rest, deps) => {
    await handleReportCommand(ctx, rest, deps)
  },
}

/** Split an invocation's argument string into the first-token verb and the rest. */
function parseInvocation(args: string): { verb: CgcSubcommandVerb | null; rest: string } {
  const trimmed = args.trim()
  const space = trimmed.indexOf(' ')
  const head = space === -1 ? trimmed : trimmed.slice(0, space)
  const rest = space === -1 ? '' : trimmed.slice(space + 1).trim()
  const verb =
    head.length === 0 ? null : (CGC_SUBCOMMANDS.find((s) => s.verb === head)?.verb ?? null)
  return { verb, rest }
}

/**
 * Dispatch one `/cgc …` invocation to its verb handler. Never throws, never
 * blocks: every branch is guarded and no verb awaits cgc completion inline.
 * The status verb reads the injected dependency surface; index and sync
 * (2.2/2.3) wire the runner + consent + state surfaces; doctor/report (2.4)
 * trigger diagnostic/reporting work through the shared runner and render the
 * settled output through the shared output-hygiene pipeline.
 */
export async function handleCgcInvocation(
  args: string,
  ctx: ExtensionCommandContext,
  deps: CgcCommandDependencies = {},
): Promise<void> {
  try {
    const { verb, rest } = parseInvocation(args)
    if (verb === null) {
      notify(ctx, usageText(), 'info')
      return
    }
    await VERB_HANDLERS[verb](ctx, rest, deps)
  } catch {
    // Fail-open: a handler defect must surface as a notice, never as a crash
    // or a blocked session (spec: "Fail-open command behavior").
    notify(ctx, 'cgc: the command failed unexpectedly; nothing was run.', 'error')
  }
}

/**
 * Register the `/cgc` command against the Pi extension API (task 1.1), wiring
 * the optional dependency surface (task 1.2) into the dispatch handlers.
 *
 * One registration, bare name `cgc` — so pi resolves `/cgc …` without any
 * `:1` suffix — whose handler dispatches to the five subcommands. Fail-open:
 * a throwing registration API must never break extension load (the extension
 * degrades to no commands, exactly like the gate).
 */
export function registerCgcCommands(pi: ExtensionAPI, deps: CgcCommandDependencies = {}): void {
  try {
    pi.registerCommand(CGC_COMMAND_NAME, {
      description: 'CodeGraphContext workspace commands (status, index, sync, doctor, report)',
      getArgumentCompletions: (prefix) => {
        const items = CGC_SUBCOMMANDS.map((spec) => ({
          value: spec.verb,
          label: spec.verb,
          description: spec.description,
        }))
        const filtered =
          prefix.length === 0 ? items : items.filter((item) => item.value.startsWith(prefix))
        return filtered.length > 0 ? filtered : null
      },
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        await handleCgcInvocation(args, ctx, deps)
      },
    })
  } catch {
    // Fail-open: registration must never throw out of extension load.
  }
}
