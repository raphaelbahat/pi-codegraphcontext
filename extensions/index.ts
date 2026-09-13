// pi-codegraphcontext extension entry.
// Registered against the Pi extension API; the CGC lifecycle gate, config
// loading, and CLI-gap tools land via the OpenSpec changes (openspec/changes/add-cgc-*).
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  type CleanupEvent,
  type CleanupExtensionApi,
  installProcessCleanup,
  type ProcessCleanupHandle,
} from './cleanup'
import { type CgcCommandDependencies, registerCgcCommands } from './commands'
import { type ConfigResult, loadConfig } from './config'
import { type GateExtensionApi, LifecycleGate } from './gate'
import { type LifecycleActionInput, LifecycleStateStore } from './lifecycle-state'
import { CgcRunner } from './runner'
import { WorkspaceDetector } from './workspace'

let cachedConfig: ConfigResult | undefined
let cachedRunner: CgcRunner | undefined
let cachedCleanup: ProcessCleanupHandle | undefined
let cachedDetector: WorkspaceDetector | undefined
let cachedStateStore: LifecycleStateStore | undefined
let cachedGate: LifecycleGate | undefined

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
        api: pi as unknown as GateExtensionApi,
      })
      cachedGate.register()
    }
  } catch {
    // Fail-open: gate registration must never break extension load. Without
    // a registered gate the extension performs no lifecycle work — the
    // session proceeds normally (the availability/notice surface simply
    // does not engage).
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
  // No freshness provider is passed while add-cgc-freshness-drift-sync is
  // absent, so `/cgc status` omits the freshness section (specified
  // degradation). Fail-open: registration must never break extension load —
  // with a broken API the extension degrades to no commands.
  try {
    const dependencies: CgcCommandDependencies = {
      state: {
        snapshot: (cwd: string) =>
          cachedGate?.lifecycleStore()?.snapshot(cwd) ?? getLifecycleStateStore().snapshot(cwd),
        isInFlight: (cwd: string) => cachedRunner?.isInFlight(cwd) ?? false,
      },
      runner: cachedRunner,
      lifecycle: getConfig().config.lifecycle,
      recordAction: (input: LifecycleActionInput) => {
        const store = cachedGate?.lifecycleStore() ?? getLifecycleStateStore()
        try {
          store.recordAction(input)
        } catch {
          // Fail-open: recording must never break the command handlers.
        }
      },
    }
    registerCgcCommands(pi, dependencies)
  } catch {
    // Fail-open: command registration must never break extension load.
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
