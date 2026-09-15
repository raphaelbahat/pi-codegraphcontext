# Changelog

## [0.3.1](https://github.com/raphaelbahat/pi-codegraphcontext/compare/v0.3.0...v0.3.1) (2026-09-15)


### Bug Fixes

* release PR auto-merge lookup — the action's pr output field is 'number' (not 'prNumber') and the fallback must prefix-match the release-please head branch (the manifest component suffix made the exact name miss); PRs [#2](https://github.com/raphaelbahat/pi-codegraphcontext/issues/2)/[#3](https://github.com/raphaelbahat/pi-codegraphcontext/issues/3) stayed open because both paths silently failed ([c698bd6](https://github.com/raphaelbahat/pi-codegraphcontext/commit/c698bd65b383fb763b2237fad728f820317074b9))


### Miscellaneous Chores

* trigger 0.3.1 release ([5477026](https://github.com/raphaelbahat/pi-codegraphcontext/commit/54770269e64f8239375373c7e03b809501d20aef))

## [0.3.0](https://github.com/raphaelbahat/pi-codegraphcontext/compare/v0.2.0...v0.3.0) (2026-09-15)


### Features

* apply add-cgc-session-lifecycle-gate — 12/16 tasks implemented + verifier-marked (production run [#1](https://github.com/raphaelbahat/pi-codegraphcontext/issues/1), stopped for cost; 4 remaining tasks resume on the optimized pipeline) ([7d05580](https://github.com/raphaelbahat/pi-codegraphcontext/commit/7d05580af21db97cb4001d3fbb8970873c4ff027))
* apply add-cgc-session-lifecycle-gate — tasks 13-16 complete (16/16, run [#1](https://github.com/raphaelbahat/pi-codegraphcontext/issues/1) resume on tuned pipeline; final gate tests + revalidation) ([50f82f6](https://github.com/raphaelbahat/pi-codegraphcontext/commit/50f82f6df2a667c017aba4baac184ddecddfe6ec))
* apply add-cgc-slash-commands — 11/11 tasks complete (run [#2](https://github.com/raphaelbahat/pi-codegraphcontext/issues/2) continuation; host-executed strict validation per escalation answer; 303/303 tests, tsc clean) ([9193694](https://github.com/raphaelbahat/pi-codegraphcontext/commit/9193694f869ca819cd355101348133110b1830ba))
* apply add-cgc-slash-commands — 9/11 tasks implemented (run [#2](https://github.com/raphaelbahat/pi-codegraphcontext/issues/2); 303/303 tests, tsc clean) ([1ea5d56](https://github.com/raphaelbahat/pi-codegraphcontext/commit/1ea5d567d9d7ad4e630eff083620b64ff15381fc))
* apply campaign — 4 changes complete (status-hud, worktree-aware, proactive, cli-gap-tools); output-token-economy partial; 651 tests, tsc clean, 10 strict-valid ([67448e8](https://github.com/raphaelbahat/pi-codegraphcontext/commit/67448e895ab2f8497b6d166af63d70bc970bce0c))
* apply campaign — agent-guide 6/6 complete; agent-routing-guidance 8/11 partial; gitleaksignore: synthetic api_key fixtures from redaction tests ([49d34b6](https://github.com/raphaelbahat/pi-codegraphcontext/commit/49d34b6e51b5370975a3ce04fd8dba506d645cab))
* apply campaign — agent-routing-guidance 11/11 complete (task 3.3 host-verified: guidance-scenarios.test.ts maps all 10 spec scenarios; 844/844 tests, strict-valid) ([6045d32](https://github.com/raphaelbahat/pi-codegraphcontext/commit/6045d325559727daf93d7fb3a745b55927bea9b2))
* apply campaign — agent-routing-guidance 11/11 complete (task 3.3 host-verified: guidance-scenarios.test.ts maps all 10 spec scenarios; 844/844 tests, strict-valid); agent-guide 6/6 ([980473b](https://github.com/raphaelbahat/pi-codegraphcontext/commit/980473b719e3fa85d079e2401c69c2f4e874e41b))
* extension entry skeleton — production run [#1](https://github.com/raphaelbahat/pi-codegraphcontext/issues/1) partial work (add-cgc-session-lifecycle-gate task 1.x) ([3509499](https://github.com/raphaelbahat/pi-codegraphcontext/commit/350949923ef3e89a79fc3e9f440fe93566004659))

## [0.2.0](https://github.com/raphaelbahat/pi-codegraphcontext/compare/v0.1.0...v0.2.0) (2026-09-06)


### Features

* add toolchain — bun, biome, prek hooks, CI and release-please pipeline ([bb4d28b](https://github.com/raphaelbahat/pi-codegraphcontext/commit/bb4d28b2e609987c3a1f0648a7df599c669769d7))


### Bug Fixes

* add @types/bun and pin bun types for the TS 7 compiler ([0a90416](https://github.com/raphaelbahat/pi-codegraphcontext/commit/0a90416d6cd07d7684e68e2b80150ffa8414935b))
