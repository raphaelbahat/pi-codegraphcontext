# cgc-index-lifecycle Delta

## MODIFIED Requirements

### Requirement: Safe execution and teardown of cgc invocations

Rule: Every `cgc` invocation the extension makes SHALL be sandboxed, cancellable, deduplicated, and cleaned up. Every extension-spawned `cgc` child SHALL additionally carry a pinned watcher-policy environment (`ENABLE_AUTO_WATCH=false`, merged over the inherited environment so every other variable is inherited unchanged), so a short-lived index run can never fork its own background watcher and block on it — the extension's watcher policy is owned by the extension, and the only watcher it sanctions is the opt-in managed `freshness.watch` child. The pin is inert on the managed watcher child (`cgc watch` never reads the variable), so `freshness.watch` behavior is unchanged.

#### Scenario: Indexing command runs to completion

- **GIVEN** the gate starts a `cgc` maintenance command
- **WHEN** the command finishes within its time budget
- **THEN** its output is captured with a bounded size, its result updates the reported index state, and no further invocations for the same workspace run in parallel with it

#### Scenario: Hung command is cancelled

- **GIVEN** a `cgc` maintenance command exceeds its time budget
- **WHEN** the budget expires
- **THEN** the command is cancelled, the state records a timeout, and the session is unaffected

#### Scenario: Session shuts down while work is in flight

- **GIVEN** the session ends while a `cgc` maintenance command or watcher started by the gate is running
- **WHEN** the session shuts down
- **THEN** all extension-spawned `cgc` processes are terminated through multiple cleanup paths, leaving no orphaned processes holding database locks

#### Scenario: Machine environment enables CGC auto-watch

- **GIVEN** the machine environment or CGC config sets `ENABLE_AUTO_WATCH=true`
- **WHEN** the extension spawns a short-lived `cgc index` run (a sync verb, the session-start sync, a freshness auto-sync, or an auto-create)
- **THEN** the child's environment carries `ENABLE_AUTO_WATCH=false`, the run finishes indexing and exits without forking a background watcher, and the invocation settles on its own instead of hanging

#### Scenario: Inherited environment is otherwise untouched

- **GIVEN** the extension spawns any `cgc` invocation
- **WHEN** the runner constructs the child environment
- **THEN** every environment variable other than `ENABLE_AUTO_WATCH` is inherited unchanged (including CGC's credential variables), and the pin is merged over the inherited values rather than replacing them

#### Scenario: Managed watcher child is unaffected by the pin

- **GIVEN** `freshness.watch` is enabled and the observer starts CGC's own `cgc watch .` as a managed child through the shared runner
- **WHEN** the runner applies the spawn environment pin
- **THEN** the watcher child starts and keeps watching normally, because `cgc watch` does not read `ENABLE_AUTO_WATCH` — the pin is inert on it