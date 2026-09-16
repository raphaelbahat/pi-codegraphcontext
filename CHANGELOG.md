# Changelog

## [0.5.0](https://github.com/raphaelbahat/pi-codegraphcontext/compare/v0.4.2...v0.5.0) (2026-09-16)


### Features

* /cgc status answers "is this workspace indexed?" with a passive, source-labeled Index line ([90b3dfd](https://github.com/raphaelbahat/pi-codegraphcontext/commit/90b3dfdb109e389eb839b89f334c237a797c3506))

## [0.4.2](https://github.com/raphaelbahat/pi-codegraphcontext/compare/v0.4.1...v0.4.2) (2026-09-16)


### Bug Fixes

* type the extension-API seams' handler returns void (gate + guidance) — the handlers are fire-and-forget hooks; unknown-return declarations flagged by the pi-lens self-scan ([3a48183](https://github.com/raphaelbahat/pi-codegraphcontext/commit/3a48183aabc0f338866f5af28f7039c90ab1665c))

## [0.4.1](https://github.com/raphaelbahat/pi-codegraphcontext/compare/v0.4.0...v0.4.1) (2026-09-15)


### Bug Fixes

* the in-workflow npm publish checks out the release tag, not the triggering SHA (the trigger SHA predates the Release PR's version bump — it tried to publish 0.3.2 while v0.4.0 was the release); shellcheck-clean tag resolution ([70b5e3b](https://github.com/raphaelbahat/pi-codegraphcontext/commit/70b5e3b13f666e766fc6ec61e8a4951765d50765))

## [0.4.0](https://github.com/raphaelbahat/pi-codegraphcontext/compare/v0.3.2...v0.4.0) (2026-09-15)


### Features

* default guidance.routingSkill to true (opt-out) — the always-on card ships by default, hiding its deeper layer by default was inconsistent; the skill is advisory, lazy, ready-gated, and self-limiting ([d1cf0ed](https://github.com/raphaelbahat/pi-codegraphcontext/commit/d1cf0ed71898e8f38bf1f846eb38cf9f961d20ce))
* layer a bounded CGC HTTP API registry probe ahead of the cgc list fallback for marker-less indexedness ([03d1e37](https://github.com/raphaelbahat/pi-codegraphcontext/commit/03d1e37fcbcbeaa96d9003dd7862ba32d8b4074a))
* user-executable routing skill — discovery without the readiness race; agent-side pointer stays per-turn; PI_CODING_AGENT_DIR-aware global config ([291ee70](https://github.com/raphaelbahat/pi-codegraphcontext/commit/291ee70a72714743f3e3b3787f0ee9bb7e10865d))


### Bug Fixes

* classify indexedness via the CGC repository registry when the filesystem marker is absent (biome-formatted) ([2dfd9f8](https://github.com/raphaelbahat/pi-codegraphcontext/commit/2dfd9f89c82a2664bd7c50c319a4fcbae9bcfe84))
* npm publish rides the Release Please run — GITHUB_TOKEN-created releases do not fire release-event workflows, so the publish is gated on the post-merge invocation's releases_created (release-publish.yml remains for manually-created releases) ([3d15ced](https://github.com/raphaelbahat/pi-codegraphcontext/commit/3d15ced28f38fc1f3f8fe217a7f0a209a82e1fa9))
* SAFETY comments on the extension-API seam casts and the registry memoization (review-pass sweep of the pi-lens findings) ([1c38756](https://github.com/raphaelbahat/pi-codegraphcontext/commit/1c38756f030d831c24dfeec8ad192e698b804138))

## [0.3.2](https://github.com/raphaelbahat/pi-codegraphcontext/compare/v0.3.1...v0.3.2) (2026-09-15)


### Bug Fixes

* create the tag + GitHub Release in the same Release Please run — the merge push (GITHUB_TOKEN) does not trigger workflows, so the release was never created after the auto-merge; re-run the idempotent action post-merge, letting the release event fire npm publish ([83d7944](https://github.com/raphaelbahat/pi-codegraphcontext/commit/83d7944661bb6d163ff2629c0130ae07f95dfd31))

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
