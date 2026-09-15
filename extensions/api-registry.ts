// CGC HTTP API registry client (design D1–D3/D7 of
// openspec/changes/add-cgc-api-registry-probe).
//
// Answers the indexedness question for workspaces WITHOUT the
// `.codegraphcontext/` filesystem marker (a Kuzu-artifact; Neo4j / FalkorDB
// setups never have it) through CGC's HTTP API instead of the `cgc list` CLI
// spawn:
//
//   1. `GET /health` on 127.0.0.1:<port> (500 ms cap) — is an API already up?
//   2. `POST /api/v1/query` with the indexed point lookup
//      `MATCH (r:Repository {path: $path}) RETURN r LIMIT 1` (5 s cap) —
//      found / absent. `Repository.path` is UNIQUE-constrained and indexed,
//      so this is an O(1) exact-path answer on every backend driver.
//   3. On an unexpected query ERROR (never on a clean found/absent):
//      `GET /api/v1/repositories` and match the workspace path against the
//      parsed JSON string values.
//   4. If no API is reachable: SPAWN `cgc api start --host 127.0.0.1
//      --port <port>` — configured port first, then random ephemeral ports —
//      polling `/health` at a 200 ms interval, retrying on exit code 3 (bind
//      conflict), under a 6 000 ms monotonic hard deadline for the whole
//      phase. A spawned server that comes healthy serves the point lookup and
//      is terminated once the probe resolves; budget expiry also terminates
//      any spawned child and reports failure (the classifier then falls
//      through to the unchanged `cgc list` CLI probe).
//
// Security model (design D3): `CGC_API_KEY` passes through untouched when
// set; otherwise a random ephemeral key (`crypto.randomUUID()`) is generated
// and handed to the spawned server via its environment. Every request carries
// `Authorization: Bearer <key>` and `X-API-Key: <key>`. Spawned servers ALWAYS
// bind `127.0.0.1` — CGC's default `0.0.0.0` is network-exposed and we never
// expose. Spawned children register with the shared runner's existing child
// cleanup (trackExternalChild), so every teardown path sweeps them; the key
// is never logged and never appears in messages.
//
// Fail-safe contract: `probe` never throws and never reports a definite
// outcome on uncertainty — an unparseable response, a timeout, a spawn that
// never becomes healthy are all `failed` outcomes that route the classifier
// to the CLI fallback and its corrupt-adjacent unknown doctrine. All HTTP
// budgets ride `AbortSignal.timeout`; the spawn deadline rides an injectable
// monotonic clock.

import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { CgcRunner, TrackedChild } from './runner'

/** Result of one registry probe: the same outcome vocabulary as the CLI probe. */
export type ApiRegistryOutcome = 'found' | 'absent' | 'failed'

export interface ApiRegistryProbe {
  outcome: ApiRegistryOutcome
  /** Structured, coarse outcome code for diagnostics (never the API key). */
  code: string
  /** Human-readable, single-line description of the outcome. */
  message: string
  /** True when a server was spawned during this probe (own child; now dead). */
  spawned: boolean
  /** The port the deciding response came from, when one did. */
  port: number | null
}

export interface ApiRegistryClientOptions {
  /** cgc binary to spawn for `api start`; resolved against PATH like the runner's. */
  executable?: string
  /** Configured API port (from `cgc.api.port`); the first spawn attempt uses it. */
  port?: number
  /**
   * Environment for key resolution and the spawned server's base environment;
   * defaults to `process.env`. Injectable so tests never depend on host env.
   */
  env?: Record<string, string | undefined>
  /**
   * Explicit pass-through key override (highest precedence). When undefined,
   * `CGC_API_KEY` from the environment passes through; when neither exists,
   * an ephemeral `crypto.randomUUID()` key is generated.
   */
  userApiKey?: string
  /** Per-request budget for the health check, in ms (default 500). */
  healthTimeoutMs?: number
  /** Per-request budget for the Cypher point lookup, in ms (default 5 000). */
  queryTimeoutMs?: number
  /** Hard monotonic budget for the WHOLE spawn phase, in ms (default 6 000). */
  spawnDeadlineMs?: number
  /** Health-poll interval during the spawn phase, in ms (default 200). */
  pollIntervalMs?: number
  /**
   * The shared runner; when supplied, spawned children join its teardown
   * sweeps. Structural seam: only `trackExternalChild` is required.
   */
  runner?: Pick<CgcRunner, 'trackExternalChild'> | undefined
  /** Test seam: replace `fetch` (default: global fetch). Minimal structural shape — the platform fetch satisfies it. */
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  /**
   * Test seam: replace child-process spawn. Must return an object honoring
   * the {@link TrackedChild} surface the client uses (`once`, `kill`, exit
   * codes); the real `child_process.spawn` result satisfies it structurally.
   */
  spawnImpl?: (argv: readonly string[], env: NodeJS.ProcessEnv) => TrackedChild
  /** Test seam: monotonic clock in ms (default `Date.now`). */
  clock?: () => number
  /** Test seam: async delay (default a `setTimeout` sleep). */
  delay?: (ms: number) => Promise<void>
}

const CGC_API_KEY_ENV = 'CGC_API_KEY'
const LOOPBACK_HOST = '127.0.0.1'
const EPHEMERAL_PORT_MIN = 49_152
const EPHEMERAL_PORT_MAX = 65_535

const POINT_LOOKUP_QUERY = 'MATCH (r:Repository {path: $path}) RETURN r LIMIT 1'

/**
 * The single JSON-validation seam for every CGC API response (design D7's
 * parse-once-at-the-boundary rule): one guard, reused by every decoder
 * below. Nothing else in this module branches on runtime shapes.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Decode a `GET /health` body at its I/O boundary: `{"status":"ok"}` means
 * up; anything else (wrong shape, wrong status) means not up.
 */
function parseHealthBody(body: unknown): boolean {
  return isRecord(body) && body.status === 'ok'
}

/**
 * Decode a `POST /api/v1/query` body at its I/O boundary: the records array
 * (top-level array, `{records: [...]}`, or `{data: [...]}`), or null when
 * the shape is unrecognized — the caller then treats it as a query ERROR
 * and falls back (never a definite verdict on an unrecognized shape).
 */
function parseQueryBody(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body
  if (isRecord(body)) {
    if (Array.isArray(body.records)) return body.records
    if (Array.isArray(body.data)) return body.data
  }
  return null
}

/**
 * Decode a `GET /api/v1/repositories` body at its I/O boundary: every string
 * leaf value of the parsed document — the coarse, shape-agnostic way to look
 * for the workspace path without coupling to CGC's field names. The caller
 * matches EXACTLY (no substring, so a listed `/repo-old` never false-
 * positives `/repo`).
 */
function parseRepositoriesBody(body: unknown): string[] {
  const leaves: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      leaves.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (isRecord(value)) {
      for (const item of Object.values(value)) walk(item)
    }
  }
  walk(body)
  return leaves
}

interface SpawnAttemptResult {
  /** True when a spawned server became healthy on the returned port. */
  healthy: boolean
  port: number | null
  child: TrackedChild | null
}

export class ApiRegistryClient {
  private readonly executable: string
  private readonly port: number
  private readonly env: Record<string, string | undefined>
  private readonly apiKey: string
  private readonly keyIsEphemeral: boolean
  private readonly healthTimeoutMs: number
  private readonly queryTimeoutMs: number
  private readonly spawnDeadlineMs: number
  private readonly pollIntervalMs: number
  private readonly runner: Pick<CgcRunner, 'trackExternalChild'> | undefined
  private readonly fetchImpl: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>
  private readonly spawnImpl: (argv: readonly string[], env: NodeJS.ProcessEnv) => TrackedChild
  private readonly clock: () => number
  private readonly delay: (ms: number) => Promise<void>

  constructor(options: ApiRegistryClientOptions = {}) {
    this.executable = options.executable ?? 'cgc'
    this.port = options.port ?? 8_000
    this.env = options.env ?? { ...process.env }
    // Key model (design D3): explicit pass-through > CGC_API_KEY > ephemeral.
    const userKey = options.userApiKey ?? this.env[CGC_API_KEY_ENV]
    this.keyIsEphemeral = userKey === undefined || userKey.trim().length === 0
    this.apiKey = this.keyIsEphemeral ? randomUUID() : (userKey ?? randomUUID())
    this.healthTimeoutMs = options.healthTimeoutMs ?? 500
    this.queryTimeoutMs = options.queryTimeoutMs ?? 5_000
    this.spawnDeadlineMs = options.spawnDeadlineMs ?? 6_000
    this.pollIntervalMs = options.pollIntervalMs ?? 200
    this.runner = options.runner
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.spawnImpl =
      options.spawnImpl ??
      ((argv, env) =>
        nodeSpawn(this.executable, argv, {
          env,
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
        }))
    this.clock = options.clock ?? Date.now
    this.delay = options.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  /** The resolved auth key (test/diagnostics surface; never logged by the code). */
  get key(): string {
    return this.apiKey
  }

  /** True when the key was generated for this session rather than passed through. */
  get ephemeralKey(): boolean {
    return this.keyIsEphemeral
  }

  /** The loopback base URL for a port (exposed for tests). */
  private baseUrl(port: number): string {
    return `http://${LOOPBACK_HOST}:${port}`
  }

  /** Auth headers for every request (both accepted header forms, design D3). */
  private authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'x-api-key': this.apiKey,
    }
  }

  /**
   * Is a CGC API server healthy on this port? Bounded by an abort signal;
   * any failure (unreachable, non-OK, malformed body) is "not up" — never an
   * error to the caller.
   */
  private async healthUp(port: number): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl(port)}/health`, {
        method: 'GET',
        headers: this.authHeaders(),
        // SAFETY: standard RequestInit wiring — AbortSignal.timeout bounds
        // THIS HTTP request only; it never terminates a child process.
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      })
      if (!response.ok) return false
      return parseHealthBody(await response.json())
    } catch {
      return false
    }
  }

  /**
   * The indexed Cypher point lookup. Returns a definite verdict only from a
   * parseable response; anything else is `'error'` (repositories fallback).
   */
  private async cypherLookup(port: number, cwd: string): Promise<'found' | 'absent' | 'error'> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl(port)}/api/v1/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ query: POINT_LOOKUP_QUERY, params: { path: cwd } }),
        // SAFETY: standard RequestInit wiring — AbortSignal.timeout bounds
        // THIS HTTP request only; it never terminates a child process.
        signal: AbortSignal.timeout(this.queryTimeoutMs),
      })
      if (!response.ok) return 'error'
      const records = parseQueryBody(await response.json())
      if (records === null) return 'error'
      return records.length > 0 ? 'found' : 'absent'
    } catch {
      return 'error'
    }
  }

  /**
   * The `GET /api/v1/repositories` JSON fallback: the workspace path must
   * match a parsed string value EXACTLY (see parseRepositoriesBody).
   * Unparseable JSON is `'error'`.
   */
  private async repositoriesLookup(
    port: number,
    cwd: string,
  ): Promise<'found' | 'absent' | 'error'> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl(port)}/api/v1/repositories`, {
        method: 'GET',
        headers: this.authHeaders(),
        // SAFETY: standard RequestInit wiring — AbortSignal.timeout bounds
        // THIS HTTP request only; it never terminates a child process.
        signal: AbortSignal.timeout(this.queryTimeoutMs),
      })
      if (!response.ok) return 'error'
      return parseRepositoriesBody(await response.json()).includes(cwd) ? 'found' : 'absent'
    } catch {
      return 'error'
    }
  }

  /**
   * Terminate a client-spawned child: SIGTERM, SIGKILL after a grace period.
   * Synchronous best-effort; the runner's teardown sweeps are the hard path.
   */
  private terminateSpawned(child: TrackedChild): void {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      child.kill('SIGTERM')
      const enforce = setTimeout(() => {
        child.kill('SIGKILL')
      }, 1_000)
      enforce.unref?.()
      child.once('close', () => {
        clearTimeout(enforce)
      })
    } catch {
      // Fail-safe: teardown failures never break the probe; the runner's
      // sweeps still cover the child.
    }
  }

  /** Base environment for a spawned server: caller env plus the auth key. */
  private spawnEnv(): NodeJS.ProcessEnv {
    return { ...this.env, [CGC_API_KEY_ENV]: this.apiKey }
  }

  /** Spawn argv for one attempt: ALWAYS loopback, CGC's default is 0.0.0.0. */
  private spawnArgv(port: number): string[] {
    return ['api', 'start', '--host', LOOPBACK_HOST, '--port', String(port)]
  }

  private randomEphemeralPort(): number {
    const span = EPHEMERAL_PORT_MAX - EPHEMERAL_PORT_MIN + 1
    return EPHEMERAL_PORT_MIN + Math.floor(Math.random() * span)
  }

  /**
   * The bounded spawn phase (design D2): configured port first, then random
   * ephemeral ports; 200 ms health polling per attempt; exit code 3 (bind
   * conflict) or any other early exit retries with a new port; the WHOLE
   * phase lives under one monotonic deadline. On expiry the still-running
   * child (if any) is terminated and the phase reports exhausted.
   */
  private async spawnPhase(): Promise<SpawnAttemptResult> {
    const deadline = this.clock() + this.spawnDeadlineMs
    let port = this.port
    let spawned: TrackedChild | null = null

    while (this.clock() < deadline) {
      spawned = this.spawnImpl(this.spawnArgv(port), this.spawnEnv())
      this.runner?.trackExternalChild(spawned)

      // `code` is `number | null` (ChildProcess close contract); null only
      // means the child was killed by a signal — either way it exited.
      const closed = new Promise<number | null>((resolve) => {
        spawned?.once('close', (code) => resolve(code))
      })

      // Race: health success (bounded by the deadline), the deadline itself,
      // or an early child exit (bind conflict or otherwise) → next attempt.
      const outcome = await Promise.race([
        this.pollHealth(port, deadline).then((up) =>
          up ? ('healthy' as const) : ('deadline' as const),
        ),
        closed.then(() => 'exited' as const),
      ])

      if (outcome === 'healthy') {
        return { healthy: true, port, child: spawned }
      }
      if (outcome === 'deadline') {
        this.terminateSpawned(spawned)
        return { healthy: false, port: null, child: spawned }
      }
      // Early exit (code 3 = bind conflict, or any other failure): retry on
      // a fresh ephemeral port while budget remains.
      spawned = null
      port = this.randomEphemeralPort()
    }

    return { healthy: false, port: null, child: spawned }
  }

  /** Poll `/health` every `pollIntervalMs` until up or the deadline passes. */
  private async pollHealth(port: number, deadline: number): Promise<boolean> {
    while (this.clock() < deadline) {
      if (await this.healthUp(port)) return true
      await this.delay(this.pollIntervalMs)
    }
    return false
  }

  /**
   * Resolve indexedness for `cwd` through the CGC HTTP API (design D1). Never
   * throws; an outcome of `failed` sends the classifier to the `cgc list`
   * fallback with its corrupt-adjacent doctrine.
   */
  async probe(cwd: string): Promise<ApiRegistryProbe> {
    // Phase 1: is an API already up on the configured port (the user's own
    // server or a previous session's)? Never spawned, never terminated —
    // the extension touches only servers it started itself.
    const preExistingUp = await this.healthUp(this.port)
    if (preExistingUp) {
      return this.decideOnPort(this.port, cwd, false)
    }

    // Phase 2: spawn one under the hard deadline.
    const attempt = await this.spawnPhase()
    if (attempt.healthy && attempt.port !== null && attempt.child !== null) {
      const verdict = await this.decideOnPort(attempt.port, cwd, true)
      this.terminateSpawned(attempt.child)
      return verdict
    }

    return {
      outcome: 'failed',
      code: 'SPAWN_BUDGET_EXCEEDED',
      message: `cgc api could not be started or reached on ${LOOPBACK_HOST} within the ${this.spawnDeadlineMs}ms spawn budget`,
      spawned: attempt.child !== null,
      port: null,
    }
  }

  /** Cypher lookup + repositories fallback against one healthy port. */
  private async decideOnPort(
    port: number,
    cwd: string,
    spawned: boolean,
  ): Promise<ApiRegistryProbe> {
    const lookup = await this.cypherLookup(port, cwd)
    if (lookup === 'found') {
      return {
        outcome: 'found',
        code: 'OK',
        message: `the CGC API point lookup on port ${port} records ${cwd} as indexed`,
        spawned,
        port,
      }
    }
    if (lookup === 'absent') {
      return {
        outcome: 'absent',
        code: 'OK',
        message: `the CGC API point lookup on port ${port} does not list ${cwd}`,
        spawned,
        port,
      }
    }
    // Unexpected query ERROR (design D1 step 2): the repositories JSON
    // fallback decides with exact string matching. A clean found/absent from
    // the indexed point lookup never runs it.
    const fallback = await this.repositoriesLookup(port, cwd)
    if (fallback === 'found') {
      return {
        outcome: 'found',
        code: 'OK',
        message: `the CGC repositories endpoint on port ${port} records ${cwd} as indexed (query endpoint error fallback)`,
        spawned,
        port,
      }
    }
    if (fallback === 'absent') {
      return {
        outcome: 'absent',
        code: 'OK',
        message: `the CGC repositories endpoint on port ${port} does not list ${cwd} (query endpoint error fallback)`,
        spawned,
        port,
      }
    }
    return {
      outcome: 'failed',
      code: 'HTTP_ERROR',
      message: `the CGC API on port ${port} answered neither the point lookup nor the repositories fallback`,
      spawned,
      port,
    }
  }
}
