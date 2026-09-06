## 1. Command registration and rendering

- [ ] 1.1 Register the five commands (`/cgc status`, `/cgc index`, `/cgc sync`, `/cgc doctor`, `/cgc report`) through Pi's documented command-registration API, pinned from the installed `docs/extensions.md` during implementation.
- [ ] 1.2 Implement the status renderer: workspace, lifecycle state, last action, running-work progress, and the freshness section rendered only when the freshness capability is present (specified degradation otherwise).
- [ ] 1.3 Implement the shared output-hygiene renderer: size-bounded output with head+tail preservation and an explicit truncation marker, control-sequence stripping, applied to `doctor` and `report` output.

## 2. Consent and action handlers

- [ ] 2.1 Implement the consent layer per ADR-0003: explicit in-session confirmation for force rebuild (naming the replace effect) and for report (naming the confirmed destination path — filename per CGC docs; location verified empirically per validate.md); no skip-confirmation option for these actions.
- [ ] 2.2 Implement `/cgc index`: creation path honoring the auto-create consent gate; force path behind confirmation; work triggered through the shared runner in the background with progress state.
- [ ] 2.3 Implement `/cgc sync`: incremental index trigger with runner deduplication (joins an in-flight sync rather than duplicating it) and skip-as-busy notice on embedded-database locks.
- [ ] 2.4 Implement `/cgc doctor` and `/cgc report` (post-confirmation) through the shared runner with bounded, cleaned output rendering.

## 3. Guardrails and verification

- [ ] 3.1 Enforce the destructive-verb exclusion: no command maps to CGC deletion/cleanup operations; assert in a test over the registered command list.
- [ ] 3.2 Test fail-open behavior: commands report unavailability when `cgc` is missing; handler errors never crash or block the session.
- [ ] 3.3 Verify all scenarios in `specs/cgc-slash-commands/spec.md` against the implementation.
- [ ] 3.4 Run `openspec validate add-cgc-slash-commands --type change --strict` before archive.
