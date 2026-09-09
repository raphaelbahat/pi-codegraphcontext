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
import { type ConfigResult, loadConfig } from './config'
import { LifecycleStateStore } from './lifecycle-state'
import { CgcRunner } from './runner'
import { WorkspaceDetector } from './workspace'

let cachedConfig: ConfigResult | undefined
let cachedRunner: CgcRunner | undefined
let cachedCleanup: ProcessCleanupHandle | undefined
let cachedDetector: WorkspaceDetector | undefined
let cachedStateStore: LifecycleStateStore | undefined

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

  // The lifecycle gate (session_start) is registered by the remaining
  // add-cgc-* tasks; the state it produces is exposed via
  // `getLifecycleStateStore()` for the later status-HUD and slash-command
  // changes. No graph query tools are registered by this extension — the CGC
  // MCP server remains the query engine (ADR 0001). The entry stays fail-open:
  // it never throws during load or registration.
  void pi
}
