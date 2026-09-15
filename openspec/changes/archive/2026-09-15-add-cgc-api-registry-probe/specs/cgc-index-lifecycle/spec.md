## ADDED Requirements

### Requirement: API-backed indexedness probe chain

Rule: When the workspace filesystem marker (`.codegraphcontext/`) is absent, the extension SHALL resolve indexedness through a bounded CGC HTTP API probe chain before falling back to the `cgc list` CLI probe: a health check, then a Cypher point lookup, then a repositories JSON fallback on query error, then an on-demand server spawn, then the unchanged CLI fallback. The marker-present path SHALL NOT consult the API or the registry.

#### Scenario: API is up and the path is indexed

- **GIVEN** a workspace without the filesystem marker whose repository path is registered in the CGC graph, with a CGC API server already reachable on the configured port
- **WHEN** the session-start classifier resolves indexedness
- **THEN** the Cypher point lookup finds the repository, the workspace is classified as indexed, the health probe decides clean/drift/corrupt exactly as for the marker-present path, and the reason names `registry (cypher)` as the decider

#### Scenario: API is up and the path is not indexed

- **GIVEN** a workspace without the filesystem marker whose repository path is absent from the CGC graph, with a CGC API server already reachable
- **WHEN** the session-start classifier resolves indexedness
- **THEN** the point lookup returns no records and the workspace is classified `unindexed` with the standard one-time notice, never mapped to any work-triggering state

#### Scenario: Query errors fall back to the repositories JSON

- **GIVEN** a reachable API server whose query endpoint returns an unexpected error (neither found nor absent)
- **WHEN** the session-start classifier resolves indexedness
- **THEN** the extension checks the parsed `GET /api/v1/repositories` JSON for the workspace path exactly, and that result decides indexedness with the same doctrine mapping

#### Scenario: No API is reachable and the spawn budget succeeds

- **GIVEN** no API server is reachable and the extension spawns one on loopback that becomes healthy within the spawn budget
- **WHEN** the session-start classifier resolves indexedness
- **THEN** the Cypher point lookup against the spawned server decides indexedness, the spawned server is terminated after the probe resolves, and no spawned process remains

#### Scenario: Spawn budget exhausted falls back to the CLI registry

- **GIVEN** no API server is reachable and the spawn phase cannot produce a healthy server before its hard deadline
- **WHEN** the session-start classifier resolves indexedness
- **THEN** the spawn phase stops at the deadline with any spawned child terminated, the existing `cgc list` probe decides indexedness unchanged, and the reason names `registry (cgc list)` as the decider

#### Scenario: Marker-present path never touches the API or registry

- **GIVEN** a workspace with `.codegraphcontext/` present
- **WHEN** the session-start classifier resolves indexedness
- **THEN** no HTTP request is made and no registry probe (API or CLI) runs — the cheap marker path is preserved

### Requirement: Bounded and secure API spawning

Rule: Every spawned CGC API server SHALL bind loopback only (`--host 127.0.0.1`), SHALL carry an authentication key (the user's `CGC_API_KEY` passed through untouched, or a generated ephemeral key sent via the server's environment), and the whole spawn phase SHALL run under a monotonic hard deadline with per-request timeouts via abort signals. Spawned servers SHALL be registered with the shared runner's child cleanup so no spawned process outlives the session.

#### Scenario: Loopback-only spawn argv

- **GIVEN** the extension spawns a CGC API server
- **WHEN** the child process is created
- **THEN** its arguments include `--host 127.0.0.1` and never bind a network-exposed interface

#### Scenario: User key passes through untouched

- **GIVEN** `CGC_API_KEY` is set in the extension's environment
- **WHEN** the client makes API requests and spawns a server
- **THEN** requests carry that exact key (`Authorization: Bearer` / `X-API-Key`) and the spawned server receives the same key via its environment — it is never replaced or regenerated

#### Scenario: Ephemeral key generated when no user key exists

- **GIVEN** `CGC_API_KEY` is not set
- **WHEN** the client makes API requests and spawns a server
- **THEN** a random ephemeral key is generated, sent on every request, and handed to the spawned server via its environment, and the key value never appears in user-facing reasons or notices

#### Scenario: Exit-code-3 conflicts retry on a new port within the deadline

- **GIVEN** a spawned server exits with code 3 (bind conflict) on the configured port
- **WHEN** the spawn phase continues
- **THEN** the next attempt uses a new port (configured port first, then random ephemeral ports), health is polled on each attempt, and all attempts together respect the monotonic hard deadline

#### Scenario: Teardown sweeps spawned servers

- **GIVEN** a spawned CGC API server is alive when the session shuts down, the process exits, or a termination signal arrives
- **WHEN** any teardown path runs
- **THEN** the spawned server is terminated together with the runner's other children, leaving no orphaned process

### Requirement: Doctrine mapping unchanged for API-decided outcomes

Rule: API probe outcomes SHALL map onto the existing lifecycle doctrine exactly as the CLI registry probe does: found → indexed (health probe decides), absent → `unindexed` notice, BUSY → `busy`, and any other failure → corrupt-adjacent unknown. Uncertainty SHALL never map to `drift` and SHALL never trigger automatic maintenance work.

#### Scenario: BUSY is not converted by the API path

- **GIVEN** the API path fails overall and the `cgc list` fallback reports a database lock conflict
- **WHEN** the session-start classifier resolves indexedness
- **THEN** the workspace is classified `busy`, not corrupt and not drift

#### Scenario: Total API path failure fails safe

- **GIVEN** the API path fails and the `cgc list` fallback is also inconclusive
- **WHEN** the session-start classifier resolves indexedness
- **THEN** the classification is corrupt-adjacent unknown, no action is taken without confirmation, and the reason states the failure

### Requirement: API probe configuration

Rule: The API probe chain SHALL be configurable through `cgc.api` (`enabled`, default true; `port`, default 8000) with environment-variable overrides (`CGC_API_ENABLED`, `CGC_API_PORT`) that take precedence over config files, validated with the shared warning-and-fallback conventions.

#### Scenario: Defaults enable the API path on port 8000

- **GIVEN** a default installation with no configuration
- **WHEN** the marker-absent path runs
- **THEN** the API probe chain is attempted against port 8000 before the CLI fallback

#### Scenario: Disabling the API path restores the CLI-only behavior

- **GIVEN** `cgc.api.enabled` is false (or `CGC_API_ENABLED=0`)
- **WHEN** the marker-absent path runs
- **THEN** no HTTP request or server spawn is attempted and the `cgc list` probe decides indexedness exactly as before this change

#### Scenario: Invalid port values are rejected with a warning

- **GIVEN** `CGC_API_PORT` or `cgc.api.port` holds a value outside 1–65535
- **WHEN** configuration is resolved
- **THEN** the value is skipped with a warning and the port falls back to the lower layer (default 8000)
