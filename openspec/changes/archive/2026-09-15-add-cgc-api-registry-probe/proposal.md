## Why

Commit e23643e (fix/registry-backed-indexedness) taught the session-start lifecycle classifier to consult the CGC repository registry (`cgc list`) when the filesystem marker (`.codegraphcontext/`) is absent — the marker is a Kuzu (bundled-backend) artifact and says nothing on Neo4j / FalkorDB setups. That fix works, but `cgc list` is a CLI spawn: it pays full process start + backend connection cost, and it parses a Rich-rendered table with a cell-boundary match. CGC also ships an HTTP API (`cgc api start`, prefix `/api/v1`) whose `POST /api/v1/query` runs the read-only-guarded `execute_cypher_query` against the live graph. A direct Cypher point lookup — `MATCH (r:Repository {path: $path}) RETURN r LIMIT 1` against the unique-indexed `Repository.path` property — is an O(1) answer with exact path semantics (no table parsing, no prefix false-positives), and it is backend-agnostic across all four CGC drivers.

This change layers that faster, more precise strategy on top of the merged fix: when the marker is absent, the classifier first tries the CGC HTTP API (health → Cypher point lookup → repositories JSON fallback); if no API server is reachable it spawns one itself under a hard deadline; and if the whole API path fails it falls back to the existing `cgc list` probe unchanged. The outcome doctrine is untouched: found → indexed (health probe decides clean/drift/corrupt), absent → `unindexed` notice, BUSY → `busy`, everything else → corrupt-adjacent fail-safe.

## What Changes

- A new injectable `ApiRegistryClient` (`extensions/api-registry.ts`) encapsulating:
  - `GET /health` (500 ms cap) on `127.0.0.1:<port>` — the cheap "is an API already up" check.
  - `POST /api/v1/query` with the indexed Cypher point lookup (5 s cap) — found / absent.
  - `GET /api/v1/repositories` JSON fallback (exact string match on parsed values) — only on an unexpected query ERROR, never on a clean found/absent.
  - A bounded spawn phase: when no API is reachable, spawn `cgc api start --host 127.0.0.1 --port <port>` (configured port first, then random ephemeral 49152–65535), poll `/health` at 200 ms, retry on exit code 3 (bind conflict), under a 6 000 ms monotonic hard deadline for the whole phase; budget expiry falls through to the CLI fallback.
  - Key handling: `process.env.CGC_API_KEY` passes through untouched; otherwise a random ephemeral key (`crypto.randomUUID()`) is generated, handed to the spawned server via its environment, and sent on every request (`Authorization: Bearer` + `X-API-Key`). Spawned servers ALWAYS bind `127.0.0.1` (CGC's default `0.0.0.0` is network-exposed; we never expose).
  - Spawned servers register with the shared runner's existing child cleanup (`killAll()` / `terminateAllSync()` sweep them at session shutdown; no orphans), and are terminated by the client itself once the probe resolves.
- Classifier wiring (marker-absent path only): API probe → `cgc list` fallback → doctrine mapping. The marker-present path NEVER consults the API or the registry (cheap path preserved). Reasons name the decider: `registry (cypher)` or `registry (cgc list)`; `registry override` wording is kept for the CLI path.
- Config surface: `cgc.api: { enabled: true, port: 8000 }` with env overrides `CGC_API_ENABLED` (boolean convention) and `CGC_API_PORT`; wired through `DEFAULT_CONFIG`, the file layer, the env layer, and documented in the README.
- No changes to CGC, no changes to the outcome doctrine, no new tools, no agent-facing routing changes (docs/agent-guide.md is gate-internal surface, unaffected).

## Capabilities

### New Capabilities

(none — this change modifies the existing `cgc-index-lifecycle` capability)

### Modified Capabilities

- `cgc-index-lifecycle`: the marker-absent indexedness resolution gains a bounded CGC HTTP API probe chain (health → Cypher point lookup → repositories fallback → on-demand loopback API server spawn under a hard deadline) ahead of the existing `cgc list` fallback, with loopback-only spawning, explicit key handling, and full child-process teardown.

## Impact

- Extension package `pi-codegraphcontext`: new `extensions/api-registry.ts`; edits to `extensions/classifier.ts`, `extensions/gate.ts` (per-session wiring), `extensions/index.ts` (construction + config), `extensions/config.ts`, `extensions/runner.ts` (external-child teardown seam), tests, README.
- Depends on verified CGC HTTP API facts: `cgc api start` (defaults `0.0.0.0:8000`, `--host`/`--port` flags, exit code 3 on `EADDRINUSE`), `GET /health` → `{"status":"ok"}`, `POST /api/v1/query` body `{"query","params"}` (read-only-guarded), `GET /api/v1/repositories`, and `Authorization: Bearer <key>` / `X-API-Key: <key>` when `CGC_API_KEY` is set.
- Graph-schema fact backing the point lookup: `Repository` nodes carry a UNIQUE constraint + INDEX on `r.path`; the query is indexed O(1) on every backend driver.
- Fails safe: every probe is bounded, the spawn phase has a hard deadline, uncertainty never maps to `drift`, and the `cgc list` fallback preserves the merged fix's behavior byte-for-byte.
