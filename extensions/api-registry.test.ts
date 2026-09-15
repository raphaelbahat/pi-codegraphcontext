import { describe, expect, it } from 'bun:test'
import { ApiRegistryClient } from './api-registry'

const CWD = '/home/user/repo'

/** A record-only Response factory (bun's global Response). */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

/** Route-based fetch stand-in: keys are URL substrings. */
function makeFetch(routes: Record<string, (url: string) => Response | Error>): {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = (
    input,
    init,
  ) => {
    const url = String(input)
    calls.push({ url, init })
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        const response = handler(url)
        return response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
      }
    }
    return Promise.reject(new Error(`no route for ${url}`))
  }
  return { fetch: fetchImpl, calls }
}

/** Minimal TrackedChild stand-in: records kills and argv/env, no casts. */
class FakeProcess {
  argv: readonly string[] = []
  env: NodeJS.ProcessEnv = {}
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killedWith: string | null = null
  private closeListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []

  once(
    event: string,
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void {
    if (event === 'close') this.closeListeners.push(listener)
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killedWith = String(signal)
    // Signal death: exitCode stays null, signalCode set, close fires.
    if (this.exitCode === null) {
      this.signalCode = 'SIGTERM'
      this.emitClose(null)
    }
    return true
  }

  /** Simulate the process exiting by itself with the given code. */
  exitWith(code: number): void {
    this.exitCode = code
    this.emitClose(code)
  }

  private emitClose(code: number | null): void {
    for (const listener of this.closeListeners) listener(code, null)
  }

  get stillAlive(): boolean {
    return this.exitCode === null && this.signalCode === null
  }
}

function makeHarness(options: {
  routes: Record<string, (url: string) => Response | Error>
  env?: Record<string, string | undefined>
  spawnDeadlineMs?: number
  pollIntervalMs?: number
}) {
  const { fetch, calls } = makeFetch(options.routes)
  const spawned: FakeProcess[] = []
  const tracked: unknown[] = []
  let now = 0
  const client = new ApiRegistryClient({
    port: 8_000,
    env: options.env ?? {},
    ...(options.spawnDeadlineMs !== undefined ? { spawnDeadlineMs: options.spawnDeadlineMs } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    fetchImpl: fetch,
    spawnImpl: (argv, env) => {
      const child = new FakeProcess()
      child.argv = argv
      child.env = env
      spawned.push(child)
      return child
    },
    clock: () => now,
    delay: async (ms: number) => {
      now += ms
    },
    runner: {
      trackExternalChild: (child) => {
        tracked.push(child)
      },
    },
  })
  return { client, calls, spawned, tracked, clockNow: () => now }
}

describe('ApiRegistryClient', () => {
  it('api up + path found → found (no spawn, pre-existing server untouched)', async () => {
    const harness = makeHarness({
      routes: {
        '/health': () => jsonResponse({ status: 'ok' }),
        '/api/v1/query': () => jsonResponse({ records: [{ path: CWD }] }),
      },
    })
    const probe = await harness.client.probe(CWD)
    expect(probe.outcome).toBe('found')
    expect(probe.spawned).toBe(false)
    expect(probe.port).toBe(8_000)
    expect(harness.spawned).toHaveLength(0)
    expect(harness.tracked).toHaveLength(0)
    // The point lookup rides POST /api/v1/query with the indexed query.
    const query = harness.calls.find((c) => c.url.includes('/api/v1/query'))
    expect(query).toBeDefined()
    expect(query?.init?.method).toBe('POST')
    const body = JSON.parse(String(query?.init?.body)) as {
      query: string
      params: { path: string }
    }
    expect(body.query).toContain('MATCH (r:Repository {path: $path})')
    expect(body.params.path).toBe(CWD)
  })

  it('api up + path absent → absent', async () => {
    const harness = makeHarness({
      routes: {
        '/health': () => jsonResponse({ status: 'ok' }),
        '/api/v1/query': () => jsonResponse({ records: [] }),
      },
    })
    const probe = await harness.client.probe(CWD)
    expect(probe.outcome).toBe('absent')
    expect(probe.spawned).toBe(false)
  })

  it('query ERROR → the repositories JSON fallback decides', async () => {
    const harness = makeHarness({
      routes: {
        '/health': () => jsonResponse({ status: 'ok' }),
        '/api/v1/query': () => jsonResponse({ error: 'boom' }, 500),
        '/api/v1/repositories': () => jsonResponse([{ name: 'repo', path: CWD }]),
      },
    })
    const probe = await harness.client.probe(CWD)
    expect(probe.outcome).toBe('found')
    expect(probe.message).toContain('fallback')

    const absent = makeHarness({
      routes: {
        '/health': () => jsonResponse({ status: 'ok' }),
        '/api/v1/query': () => new Response('', { status: 500 }),
        '/api/v1/repositories': () => jsonResponse([{ path: '/elsewhere/repo' }]),
      },
    })
    expect((await absent.client.probe(CWD)).outcome).toBe('absent')
  })

  it('a prefix path in the repositories JSON does not false-positive (exact match)', async () => {
    const harness = makeHarness({
      routes: {
        '/health': () => jsonResponse({ status: 'ok' }),
        '/api/v1/query': () => new Response('', { status: 500 }),
        '/api/v1/repositories': () => jsonResponse([{ path: `${CWD}-old` }]),
      },
    })
    expect((await harness.client.probe(CWD)).outcome).toBe('absent')
  })

  it('api down + spawn success → the cypher lookup decides and the spawned server is terminated', async () => {
    let healthCalls = 0
    const harness = makeHarness({
      routes: {
        '/health': () => {
          healthCalls += 1
          // First call (pre-existing check) down; the spawned server comes up.
          return healthCalls === 1 ? new Error('ECONNREFUSED') : jsonResponse({ status: 'ok' })
        },
        '/api/v1/query': () => jsonResponse({ records: [{ path: CWD }] }),
      },
    })
    const probe = await harness.client.probe(CWD)
    expect(probe.outcome).toBe('found')
    expect(probe.spawned).toBe(true)
    expect(probe.port).toBe(8_000)
    expect(harness.spawned).toHaveLength(1)
    // Loopback-only argv, configured port first.
    expect(harness.spawned[0]?.argv).toEqual([
      'api',
      'start',
      '--host',
      '127.0.0.1',
      '--port',
      '8000',
    ])
    // The spawned server was registered with the runner and terminated after.
    expect(harness.tracked).toHaveLength(1)
    expect(harness.spawned[0]?.stillAlive).toBe(false)
  })

  it('spawn budget exhausted → failed (SPAWN_BUDGET_EXCEEDED), child terminated', async () => {
    const harness = makeHarness({
      routes: {
        '/health': () => new Error('ECONNREFUSED'),
      },
      spawnDeadlineMs: 6_000,
      pollIntervalMs: 200,
    })
    const probe = await harness.client.probe(CWD)
    expect(probe.outcome).toBe('failed')
    expect(probe.code).toBe('SPAWN_BUDGET_EXCEEDED')
    expect(harness.spawned.length).toBeGreaterThanOrEqual(1)
    // No healthy server ever came up; whatever was spawned is dead.
    expect(harness.spawned.every((child) => !child.stillAlive)).toBe(true)
    // The deadline was respected on the fake monotonic clock (≤ budget + poll).
    expect(harness.clockNow()).toBeLessThanOrEqual(6_000 + 200)
  })

  it('exit code 3 (bind conflict) retries on a new ephemeral port within the deadline', async () => {
    const spawned: FakeProcess[] = []
    let now = 0
    const fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = (
      input,
    ) => {
      const url = String(input)
      if (url.includes('/health')) {
        // Healthy only for spawns after the exit-3 conflict (the second
        // attempt onwards); everything before is ECONNREFUSED.
        return spawned.length >= 2
          ? Promise.resolve(jsonResponse({ status: 'ok' }))
          : Promise.reject(new Error('ECONNREFUSED'))
      }
      if (url.includes('/api/v1/query')) {
        return Promise.resolve(jsonResponse({ records: [{ path: CWD }] }))
      }
      return Promise.reject(new Error(`no route for ${url}`))
    }
    const client = new ApiRegistryClient({
      port: 8_000,
      env: {},
      fetchImpl,
      spawnImpl: (argv, env) => {
        const child = new FakeProcess()
        child.argv = argv
        child.env = env
        spawned.push(child)
        if (spawned.length === 1) {
          // First spawn: EADDRINUSE — the process exits with code 3 right
          // after the client attaches its close listener (microtask).
          queueMicrotask(() => child.exitWith(3))
        }
        return child
      },
      clock: () => now,
      delay: async (ms: number) => {
        now += ms
      },
      runner: { trackExternalChild: () => {} },
    })

    const probe = await client.probe(CWD)

    expect(probe.outcome).toBe('found')
    expect(spawned.length).toBeGreaterThanOrEqual(2)
    const second = spawned[1]
    expect(second).toBeDefined()
    // The retry used a fresh ephemeral port, still loopback-only.
    const secondPort = Number(second?.argv[5])
    expect(secondPort).toBeGreaterThanOrEqual(49_152)
    expect(secondPort).toBeLessThanOrEqual(65_535)
    expect(second?.argv[3]).toBe('127.0.0.1')
    // The whole phase respected the monotonic deadline.
    expect(now).toBeLessThanOrEqual(6_000)
  })

  it('user CGC_API_KEY passes through untouched (headers + spawned env)', async () => {
    const harness = makeHarness({
      routes: {
        '/health': () => jsonResponse({ status: 'ok' }),
        '/api/v1/query': () => jsonResponse({ records: [{ path: CWD }] }),
      },
      env: { CGC_API_KEY: 'user-secret-key' },
    })
    const probe = await harness.client.probe(CWD)
    expect(probe.outcome).toBe('found')
    expect(harness.client.key).toBe('user-secret-key')
    expect(harness.client.ephemeralKey).toBe(false)
    for (const call of harness.calls) {
      const headers = call.init?.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer user-secret-key')
      expect(headers['x-api-key']).toBe('user-secret-key')
    }
  })

  it('ephemeral key generated when no user key exists (and handed to the spawn env)', async () => {
    const harness = makeHarness({
      routes: {
        '/health': () => new Error('ECONNREFUSED'),
      },
      env: {},
      spawnDeadlineMs: 1_000,
      pollIntervalMs: 200,
    })
    const probe = await harness.client.probe(CWD)
    expect(harness.client.ephemeralKey).toBe(true)
    expect(harness.client.key).toMatch(/^[0-9a-f-]{36}$/)
    // The spawn env carries exactly the client's key.
    for (const child of harness.spawned) {
      expect(child.env.CGC_API_KEY).toBe(harness.client.key)
    }
    // The key never leaks into user-facing probe output.
    expect(probe.message).not.toContain(harness.client.key)
    expect(probe.code).not.toContain(harness.client.key)
  })
})
