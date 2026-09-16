// pi-codegraphcontext extension entry.
// Registered against the Pi extension API; the CGC lifecycle gate, config
// loading, and CLI-gap tools land via the OpenSpec changes (openspec/changes/add-cgc-*).
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { ApiRegistryClient } from './api-registry'
import {
  type CleanupEvent,
  type CleanupExtensionApi,
  installProcessCleanup,
  type ProcessCleanupHandle,
} from './cleanup'
import {
  type CliGapToolDependencies,
  type CliGapToolsApi,
  createBundleExportExecutor,
  createContextExecutor,
  createDoctorExecutor,
  registerCliGapTools,
} from './cli-gap-tools'
import { type CgcCommandDependencies, registerCgcCommands } from './commands'
import { type ConfigResult, loadConfig } from './config'
import {
  FreshnessDriftObserver,
  type FreshnessExtensionApi,
  getFreshnessStateStore,
} from './freshness'
import { type GateExtensionApi, LifecycleGate } from './gate'
import {
  type GuidanceInjectionApi,
  GuidanceInjector,
  type GuidanceSkillDiscoverApi,
  GuidanceSkillExposure,
} from './guidance'
import { type LifecycleActionInput, LifecycleStateStore } from './lifecycle-state'
import {
  CoverageNoteInjector,
  DriftSteerInjector,
  type ProactiveInjectionApi,
  ResultAnnotator,
} from './proactive'
import { CgcRunner } from './runner'
import { StatusHud, type StatusHudExtensionApi } from './status-hud'
import { WorkspaceDetector } from './workspace'

let cachedConfig: ConfigResult | undefined
let cachedRunner: CgcRunner | undefined
let cachedCleanup: ProcessCleanupHandle | undefined
let cachedApiRegistry: ApiRegistryClient | undefined
let cachedDetector: WorkspaceDetector | undefined
let cachedStateStore: LifecycleStateStore | undefined
let cachedGate: LifecycleGate | undefined
let cachedFreshnessObserver: FreshnessDriftObserver | undefined
let cachedCoverageInjector: CoverageNoteInjector | undefined
let cachedGuidanceInjector: GuidanceInjector | undefined
let cachedGuidanceSkillExposure: GuidanceSkillExposure | undefined
let cachedDriftSteerInjector: DriftSteerInjector | undefined
let cachedResultAnnotator: ResultAnnotator | undefined
let cachedStatusHud: StatusHud | undefined

/**
 * Resolved extension configuration (defaults <- config files <- env overrides).
 * Safe to call repeatedly; the result is cached for the process lifetime.
 */
export function getConfig(): ConfigResult {
  cachedConfig ??= loadConfig()
  return cachedConfig
}

/**
 * The extension's cgc runner (created on first extension registration). Every
 * cgc spawn goes through it, which is what makes the multi-path teardown
 * guarantee enforceable: the cleanup paths only need to sweep this runner's
 * tracked children.
 */
export function getRunner(): CgcRunner | undefined {
  return cachedRunner
}

/**
 * The extension's per-process workspace detector (created alongside the
 * runner). Its probe cache is per detector instance; session-scoped detectors
 * are created by the gate (2.2+) so the one-shot-per-session guarantee holds,
 * while this accessor provides a process-lifetime fallback for surfaces that
 * run outside a gate-managed session.
 */
export function getWorkspaceDetector(): WorkspaceDetector | undefined {
  return cachedDetector
}

/**
 * The extension's lifecycle-state store (task 3.1): the read-only state
 * surface that the downstream campaign changes render — the status HUD
 * (add-cgc-status-hud) subscribes to snapshots, the slash commands
 * (add-cgc-slash-commands) read them on demand. Registers no tools and
 * spawns nothing; the CGC MCP server remains the only query engine
 * (ADR 0001).
 *
 * The gate (3.2) creates one store per session and feeds it from the
 * classifier and gate paths; this accessor provides the process-lifetime
 * fallback for surfaces that run outside a gate-managed session. Safe to
 * call repeatedly; the instance is cached for the process lifetime.
 */
export function getLifecycleStateStore(): LifecycleStateStore {
  cachedStateStore ??= new LifecycleStateStore()
  return cachedStateStore
}

/**
 * Teardown diagnostics for the multi-path cleanup (later surfaces read this).
 */
export function getCleanupEvents(): readonly CleanupEvent[] {
  return cachedCleanup?.events ?? []
}

export default function piCodegraphcontext(pi: ExtensionAPI): void {
  // Warm the config cache so warnings surface once at load. Config problems
  // never break extension load: this stays fail-open and never throws.
  try {
    getConfig()
  } catch {
    cachedConfig = undefined
  }

  // One runner per extension process; every cgc spawn must go through it.
  try {
    const config = getConfig().config
    cachedRunner ??= new CgcRunner({
      executable: config.cgc.executable,
      defaultTimeoutMs: config.cgc.timeoutMs,
      spillToTemp: config.output.spillToTemp,
      redactSecrets: config.output.redactSecrets,
      gcfOutput: config.output.gcf,
    })
    cachedCleanup ??= installProcessCleanup(cachedRunner, {
      // ExtensionAPI's overloaded `on` is structurally wider than the minimal
      // seam type; the cast narrows the surface the cleanup module may touch.
      api: pi as unknown as CleanupExtensionApi,
    })
    cachedDetector ??= new WorkspaceDetector({
      runner: cachedRunner,
      versionProbeTimeoutMs: config.cgc.versionProbeTimeoutMs,
    })
    // add-cgc-api-registry-probe (task 4.2): the CGC HTTP API registry
    // client for the marker-absent indexedness probe chain, built only
    // when `cgc.api.enabled` and the runner exist. Loopback-only spawning,
    // bounded budgets, spawned children registered with the runner's
    // existing teardown sweeps. Construction failure leaves it undefined —
    // the classifier's `cgc list` fallback then decides alone (fail-open).
    // SAFETY: the ternary's branches are fully typed (ApiRegistryClient | undefined);
    // the assignment's completion value is deliberately unused — this is a
    // memoization statement, not a value expression.
    cachedApiRegistry ??= config.cgc.api.enabled
      ? new ApiRegistryClient({
          executable: config.cgc.executable,
          port: config.cgc.api.port,
          runner: cachedRunner,
        })
      : undefined
  } catch {
    // Fail-open: registration must never throw. Teardown degrades to the
    // runner's per-command timeout and abort-signal paths.
  }

  // Task 3.2: the lifecycle gate. Registered only when the runner exists (a
  // failed runner means no gate can spawn anything — the extension degrades
  // to doing nothing, which is the point of fail-open). The gate wires
  // `session_start` / `session_shutdown` hooks that run the five-state
  // lifecycle state machine off `ctx.cwd` (never `process.cwd()`), guarded
  // so no hook body can ever throw, block, or interrupt the agent loop.
  try {
    if (cachedRunner !== undefined) {
      cachedGate ??= new LifecycleGate({
        runner: cachedRunner,
        config: getConfig().config,
        // SAFETY: pi's ExtensionAPI structurally satisfies the GateExtensionApi
        // seam (the same `on(event, handler)` surface) — the narrow interface
        // exists so the gate can be tested with a stub; pi's own object is
        // duck-typed by design of pi's extension API.
        api: pi as unknown as GateExtensionApi,
        apiRegistry: cachedApiRegistry,
      })
      cachedGate.register()
    }
  } catch {
    // Fail-open: gate registration must never break extension load. Without
    // a registered gate the extension performs no lifecycle work — the
    // session proceeds normally (the availability/notice surface simply
    // does not engage).
  }

  // Task 1.3 (add-cgc-freshness-drift-sync): the freshness drift observer.
  // Registers the harness `tool_call` subscription (docs/extensions.md — the
  // only drift signal the harness documents; no file-edit event exists) that
  // marks the session workspace possibly-stale on the first observed
  // file-modifying tool call, debouncing bursts, with zero detection spawns
  // (design D1; the state it feeds lives in the shared
  // `getFreshnessStateStore()`). Task 2.1 wires the lazy auto-sync path:
  // the first drift mark of a session triggers ONE background incremental
  // `cgc index .` through the shared runner (design D2), capped at
  // `freshness.maxSyncsPerSession` per session (design D3); the runner's
  // dedup joins an already-in-flight identical sync instead of re-spawning,
  // and the runner injects the worktree `--context` before dedup. Fail-closed
  // worktree gate: a workspace the gate reports blocked records no freshness
  // state (the same surface the spawning verbs honor), and the `tool_call`
  // handler can never block a tool — it always returns undefined and never
  // touches `event.input` (docs/extensions.md behavior guarantees).
  // Registered AFTER the gate so the session cwd it captures is the gate's.
  // Fail-open: registration must never break extension load — without an
  // observer the freshness seams degrade to "capability not present"
  // (freshnessFor / freshness return null); without a runner the observer
  // degrades to observation-only (no automatic syncs ever spawn).
  try {
    cachedFreshnessObserver ??= new FreshnessDriftObserver({
      store: getFreshnessStateStore(),
      worktreeBlockFor: (cwd: string) => cachedGate?.worktreeBlockFor(cwd) ?? null,
      runner: cachedRunner,
      autoSync: getConfig().config.freshness.autoSync,
      maxSyncsPerSession: getConfig().config.freshness.maxSyncsPerSession,
      // Task 2.4: the opt-in continuous watcher (design D2 — off by default).
      watch: getConfig().config.freshness.watch,
      api: pi as unknown as FreshnessExtensionApi,
    })
    cachedFreshnessObserver.register()
  } catch {
    // Fail-open: observer registration must never break extension load.
  }

  // Tasks 1.2–1.3 (add-cgc-status-hud): the one-line lifecycle chip. Renders
  // the active session's lifecycle state from the gate's per-session store
  // (fallback: the process-lifetime store) — subscribe-only, event-driven
  // with debounce coalescing, zero spawns and zero polling (ADR 0001 / ADR
  // 0004). Registered AFTER the gate so the gate's session_start handler runs
  // first and the per-session store exists when this HUD resolves it; without
  // a gate the HUD still renders from the fallback store. The `freshnessFor`
  // provider is wired when the freshness drift observer (task 1.3,
  // add-cgc-freshness-drift-sync) is registered: the chip then merges a
  // worse-than-fresh marker from the shared freshness store (the
  // `FreshnessHudStore` seam — subscribe + snapshot). Without the observer
  // the provider returns null and the chip renders lifecycle-only (the
  // specified degradation, unchanged).
  // Fail-open: registration must never break extension load.
  try {
    cachedStatusHud ??= new StatusHud({
      storeFor: (_cwd: string) => cachedGate?.lifecycleStore() ?? getLifecycleStateStore(),
      freshnessFor: (_cwd: string) =>
        cachedFreshnessObserver === undefined ? null : getFreshnessStateStore(),
      api: pi as unknown as StatusHudExtensionApi,
    })
    cachedStatusHud.register()
  } catch {
    // Fail-open: HUD registration must never break extension load. Without a
    // registered HUD the extension performs no status rendering — the session
    // proceeds normally.
  }

  // Task 1.1 (add-cgc-slash-commands): the five human-facing `/cgc` commands.
  // One `registerCommand("cgc", …)` whose handler dispatches on the first
  // argument (pi parses invocations at the first space, so `/cgc status`
  // resolves name `cgc` with args `status`). Task 1.2 wires the read-only
  // state surface for the status renderer: the gate's per-session lifecycle
  // store (`lifecycleStore()`) with the process-lifetime store as fallback,
  // plus the shared runner's in-flight read — status stays a passive renderer
  // (ADR-0004: no spawns, no polling; the runner read is synchronous and
  // spawn-free). Task 2.2 wires the action surface for `/cgc index`: the
  // shared runner (spawn + dedup), the change-1 auto-create consent gate, and
  // progress-state recording into the same store the status renderer reads.
  // Task 1.3 (add-cgc-freshness-drift-sync) wires the read-only freshness
  // surface for the status renderer: when the drift observer is registered
  // it consumes the shared store's snapshot (design D5, structurally the
  // `CgcFreshnessSummary` seam); without it the provider returns null and
  // `/cgc status` omits the freshness section (specified degradation).
  // Fail-open: registration must never break extension load —
  // with a broken API the extension degrades to no commands.
  try {
    const dependencies: CgcCommandDependencies = {
      state: {
        snapshot: (cwd: string) =>
          cachedGate?.lifecycleStore()?.snapshot(cwd) ?? getLifecycleStateStore().snapshot(cwd),
        isInFlight: (cwd: string) => cachedRunner?.isInFlight(cwd) ?? false,
      },
      runner: cachedRunner,
      // feat/status-index-info: the API registry client for the status view's
      // passive indexedness answer — the same probe seam the gate and the
      // classifier receive (undefined when the API is disabled or construction
      // failed → the status's `cgc list` fallback then decides, then unknown).
      apiRegistry: cachedApiRegistry,
      lifecycle: getConfig().config.lifecycle,
      // Task 1.3 (add-cgc-freshness-drift-sync): the read-only freshness view
      // for the status renderer — the shared store's snapshot, structurally
      // the `CgcFreshnessSummary` seam. Null (observer absent) → the status
      // omits the freshness section (specified degradation).
      freshness: (cwd: string) =>
        cachedFreshnessObserver === undefined ? null : getFreshnessStateStore().snapshot(cwd),
      // Task 2.3's fail-closed tool-use surface: the gate's session resolves
      // the current worktree isolation block (isolate mode only). Null for
      // `off` mode / before the first session — the spawning verbs then
      // behave exactly as before (zero change outside isolate mode). A
      // blocked workspace (identity mismatch or no verified mapping) gets no
      // /cgc index|sync|doctor|report spawn: without a verified `--context`
      // the command would silently fall into CGC's default context.
      worktreeBlock: (cwd: string) => cachedGate?.worktreeBlockFor(cwd) ?? null,
      recordAction: (input: LifecycleActionInput) => {
        const store = cachedGate?.lifecycleStore() ?? getLifecycleStateStore()
        try {
          store.recordAction(input)
        } catch {
          // Fail-open: recording must never break the command handlers.
        }
      },
      // Task 2.2 (add-cgc-proactive-context-injection): the result-annotation
      // seam. When the opt-in tier is enabled and the session observes
      // staleness, every extension-owned command notification is decorated
      // with the one-line freshness annotation (see the ResultAnnotator
      // wiring below); otherwise this is an identity — zero change. The
      // closure is evaluated per notification, so it reads the annotator
      // instance assigned later in this registration pass.
      annotateResult: (text: string) => cachedResultAnnotator?.annotate(text) ?? text,
    }
    registerCgcCommands(pi, dependencies)
  } catch {
    // Fail-open: command registration must never break extension load.
  }

  // Task 1.1 (add-cgc-cli-gap-tools): the three CLI-gap tools
  // (cgc_bundle_export, cgc_context, cgc_doctor). Registered ONLY when
  // `tools.cliGap.enabled` is true — the default; the
  // CGC_TOOLS_CLI_GAP_ENABLED environment override takes precedence over the
  // config key (design D2). When disabled, no CLI-gap tool exists in the
  // tool catalog at all. Task 1.2 wires the cgc_bundle_export executor and
  // task 1.3 wires the cgc_context executor (list/create/delete/set-default;
  // delete behind the ADR-0003 confirmation) through the shared runner
  // (argument-array spawn, session cwd, consent layer, output policy);
  // task 1.4 wires the cgc_doctor executor (read-only diagnostics through
  // the same runner). When no runner exists (its construction failed), the
  // executors are not supplied and the tools fail closed — nothing can spawn
  // anyway.
  // Fail-open: registration must never break extension load.
  try {
    if (getConfig().config.tools.cliGap.enabled) {
      const cliGapDeps: CliGapToolDependencies = {}
      if (cachedRunner !== undefined) {
        cliGapDeps.bundleExport = createBundleExportExecutor({ runner: cachedRunner })
        cliGapDeps.context = createContextExecutor({ runner: cachedRunner })
        cliGapDeps.doctor = createDoctorExecutor({ runner: cachedRunner })
      }
      registerCliGapTools(pi as unknown as CliGapToolsApi, cliGapDeps)
    }
  } catch {
    // Fail-open: tool registration must never break extension load. Without
    // the surface the extension degrades to the remaining surfaces only.
  }

  // Task 1.3 (add-cgc-proactive-context-injection): the session-start
  // coverage note. One-shot per session via `before_agent_start` — the same
  // documented system-prompt mechanism as the routing card (change 2 D4):
  // the handler appends the capped coverage note to the chained system
  // prompt exactly once, on the first turn where the ADR-0002 readiness
  // predicate holds and the gate's cached classification is available. Gated
  // on `proactive.sessionNote` (default on, design D1). The note is built
  // exclusively from the gate's cached classification (`lastClassification`
  // → `coverageNoteSourceFrom`; zero spawns, ADR 0001) and the session cwd
  // (never process.cwd()). Fail-open: registration must never break
  // extension load; without a gate the provider returns null and the tier
  // degrades to silence.
  try {
    cachedCoverageInjector ??= new CoverageNoteInjector({
      sessionNote: getConfig().config.proactive.sessionNote,
      sourceFor: (cwd: string) => cachedGate?.lastClassification(cwd) ?? null,
      api: pi as unknown as ProactiveInjectionApi,
    })
    cachedCoverageInjector.register()
  } catch {
    // Fail-open: injection registration must never break extension load.
  }

  // Task 2.2 (add-cgc-agent-routing-guidance): the always-on routing card.
  // One-shot per session via `before_agent_start` — the handler appends the
  // static, version-scoped card to the CHAINED system prompt exactly once, on
  // the first turn where guidance is ready (ADR-0002: `cgc` available AND the
  // workspace index exists or is being created; an index created later in the
  // session still injects, at most once). Non-configurable by design D2: no
  // config key and no off switch — the only removal path is disabling the
  // extension. Reads the gate's per-session lifecycle snapshot (with the
  // process-lifetime store as fallback) — zero spawns (ADR 0001). Fail-open:
  // registration must never break extension load.
  try {
    cachedGuidanceInjector ??= new GuidanceInjector({
      snapshotFor: (cwd: string) =>
        cachedGate?.lifecycleStore()?.snapshot(cwd) ?? getLifecycleStateStore().snapshot(cwd),
      routingSkillPointer: getConfig().config.guidance.routingSkill,
      api: pi as unknown as GuidanceInjectionApi,
    })
    cachedGuidanceInjector.register()
  } catch {
    // Fail-open: guidance injection registration must never break extension load.
  }

  // Task 2.4 (add-cgc-agent-routing-guidance): the routing skill (default on,
  // opt-out). The deep skill ships inside the package (`skills/cgc-routing`)
  // and is contributed at discovery whenever `guidance.routingSkill` is
  // enabled — readiness deliberately does NOT gate discovery (pi fires
  // `resources_discover` before the gate records any snapshot: gating there
  // made the skill invisible on every fresh session). Readiness gates the
  // agent-side pointer on the injected card instead, per turn. Fail-open:
  // registration must never break extension load.
  try {
    cachedGuidanceSkillExposure ??= new GuidanceSkillExposure({
      enabled: getConfig().config.guidance.routingSkill,
      api: pi as unknown as GuidanceSkillDiscoverApi,
    })
    cachedGuidanceSkillExposure.register()
  } catch {
    // Fail-open: skill exposure registration must never break extension load.
  }

  // Task 2.1 (add-cgc-proactive-context-injection): the opt-in drift-steer
  // tier. One agent-facing steer per fresh → possibly-stale freshness
  // episode, naming the staleness and the `/cgc sync` option, delivered
  // through the same documented before_agent_start prompt mechanism as the
  // coverage note (design D3/D5). Gated on `proactive.driftSteers` (default
  // off — never fires when disabled, and a disabled tier subscribes to
  // nothing). The freshness capability (add-cgc-freshness-drift-sync) is not
  // installed, so no `freshnessFor` provider is passed and the tier observes
  // no transitions — the specified degradation (the seam exists; change 7
  // wires the real store). Same shared readiness predicate and fail-open
  // registration posture as the coverage note.
  try {
    cachedDriftSteerInjector ??= new DriftSteerInjector({
      driftSteers: getConfig().config.proactive.driftSteers,
      sourceFor: (cwd: string) => cachedGate?.lastClassification(cwd) ?? null,
      api: pi as unknown as ProactiveInjectionApi,
    })
    cachedDriftSteerInjector.register()
  } catch {
    // Fail-open: steer registration must never break extension load.
  }

  // Task 2.2 (add-cgc-proactive-context-injection): the opt-in
  // result-annotation tier. One-line freshness annotation appended to
  // outputs the extension itself produces (slash-command renders), reached
  // through the `annotateResult` dependency wired into the commands surface
  // above — the commands notify choke point applies it to every
  // extension-owned command output. Gated on `proactive.resultAnnotations`
  // (default off — never annotates when disabled, and a disabled tier
  // subscribes to nothing). The freshness capability
  // (add-cgc-freshness-drift-sync) is not installed, so no `freshnessFor`
  // provider is passed and the tier observes no staleness — `annotate` is an
  // identity, the specified degradation (the seam exists; change 7 wires the
  // real store, and end-to-end annotation firing then activates). CGC MCP
  // server results are never touched (design D4 / ADR-0009). Same shared
  // readiness predicate and fail-open registration posture as the other
  // tiers.
  try {
    cachedResultAnnotator ??= new ResultAnnotator({
      resultAnnotations: getConfig().config.proactive.resultAnnotations,
      sourceFor: (cwd: string) => cachedGate?.lastClassification(cwd) ?? null,
      api: pi as unknown as ProactiveInjectionApi,
    })
    cachedResultAnnotator.register()
  } catch {
    // Fail-open: annotator registration must never break extension load.
  }

  // The lifecycle gate (session_start) is registered by the CGC lifecycle
  // gate above (`cachedGate`); the state it produces is exposed via its
  // `lifecycleStore()` (per-session) plus the `getLifecycleStateStore()`
  // fallback for surfaces that run outside a gate-managed session. No graph
  // query tools are registered by this extension — the CGC MCP server
  // remains the query engine (ADR 0001). The entry stays fail-open: it never
  // throws during load or registration.
  void pi
}
