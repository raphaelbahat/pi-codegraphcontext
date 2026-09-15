## 1. Config surface

- [x] 1.1 Add `cgc.api: { enabled: true, port: 8000 }` to `DEFAULT_CONFIG` and the `CgcConfig` type; add the `cgc.api.enabled` / `cgc.api.port` config keys with the `CGC_API_ENABLED` / `CGC_API_PORT` environment overrides.
- [x] 1.2 Parse `cgc.api` in the JSON config-file layer and the env layer with the shared conventions (lenient booleans; port must be an integer in 1–65535, else warning + fallback).
- [x] 1.3 Extend `extensions/config.test.ts`: defaults, env overrides, file-layer precedence, invalid-port warnings.

## 2. Teardown seam

- [x] 2.1 Add `CgcRunner.trackExternalChild(child)`: register a long-lived, externally spawned child in the runner's existing live-children set so `killAll()` / `terminateAllSync()` sweep it, and unregister it automatically when it closes.
- [x] 2.2 Test the seam: a tracked external child is terminated by both teardown sweeps and unregistered on close.

## 3. ApiRegistryClient

- [x] 3.1 Implement `extensions/api-registry.ts`: `GET /health` (500 ms cap), `POST /api/v1/query` with the indexed point lookup (5 s cap), `GET /api/v1/repositories` exact-path JSON fallback on query error; all timeouts via `AbortSignal`.
- [x] 3.2 Implement the spawn phase: `cgc api start --host 127.0.0.1 --port <port>` (configured port first, then random ephemeral 49152–65535), 200 ms health polling, exit-code-3 retry, 6 000 ms monotonic hard deadline; terminate our own spawned server when the probe resolves and on deadline expiry.
- [x] 3.3 Implement key handling: `CGC_API_KEY` pass-through or ephemeral `crypto.randomUUID()`; send `Authorization: Bearer` + `X-API-Key` on every request; hand the key to the spawned server via its environment; never log it.
- [x] 3.4 Inject the deterministic seams (fetch, spawn, clock, delay) and register spawned children with `trackExternalChild` when a runner is supplied.

## 4. Classifier and gate wiring

- [x] 4.1 Wire the marker-absent path in `extensions/classifier.ts`: API probe → `cgc list` fallback → doctrine mapping, with per-workspace caching and reason deciders `registry (cypher)` / `registry (cgc list)` (keeping the existing `registry override` wording on the CLI path).
- [x] 4.2 Pass the client from the gate's per-session classifier construction (`extensions/gate.ts`) and construct it in `extensions/index.ts` only when `cgc.api.enabled` and the runner exist; keep every construction fail-open.

## 5. Tests

- [x] 5.1 `extensions/api-registry.test.ts`: api-up found → clean; api-up absent → unindexed; query error → repositories JSON fallback; api-down + spawn success → cypher decides; spawn budget exhausted → `cgc list` fallback decides; exit-3 retries with new ports under the 6 s deadline (fake clock); user-key pass-through; ephemeral key generation; loopback `--host` in the spawn argv; marker-present never touches the API or registry; BUSY mapping.
- [x] 5.2 Extend `extensions/classifier.test.ts` with an injected API client stand-in covering the same decision paths end-to-end.
- [x] 5.3 Keep the entire existing suite green (851 tests) — the no-client construction path must behave byte-identically to the merged fix.

## 6. Documentation and verification

- [x] 6.1 README: `cgc.api` in the configuration reference and table, `CGC_API_PORT` / `CGC_API_ENABLED` env rows, an optional "CGC HTTP API" note under Requirements; refresh the test count.
- [x] 6.2 Run `openspec validate add-cgc-api-registry-probe --type change --strict` before implementation and again before commit.
- [x] 6.3 Run `bun test`, `bunx tsc --noEmit`, and the Biome checks; fix everything before commit.
