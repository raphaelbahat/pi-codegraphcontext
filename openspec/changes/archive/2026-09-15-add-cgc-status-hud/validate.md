# Task Validation: add-cgc-status-hud

- Validated against: live framework/library/tool documentation
- Validation date: 2026-09-06
- Verdict: READY

Validation method: one read-only validator (single technology group — all claims are Pi-harness surface claims; this change spawns nothing) checked every externally-observable claim in tasks.md against the locally installed Pi documentation (`@earendil-works/pi-coding-agent`, bundled docs — authoritative for the installed version).

Approved precision fix applied: the validator pinned the mode guard — `ctx.hasUI` is true in RPC mode, so the TUI-only display must guard on `ctx.mode === "tui"`. With user approval (established corrections policy), design.md D4 and the Open Questions entry were updated to pin `ctx.ui.setStatus`/`ctx.ui.setFooter`, `ctx.ui.notify`, and the mode guard. No verdict changed.

---

## INVALID — requires revision

None.

---

## VALID — confirmed

### 1.2

- The persistent status chip has documented surfaces: `ctx.ui.setStatus(key, text)` renders persistent footer status until cleared, and `ctx.ui.setFooter(renderFn)` can replace the built-in footer entirely — both documented extension-UI surfaces with bundled examples (`status-line.ts`, `custom-footer.ts`).
  - Evidence: `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` ("Widgets, Status, and Footer", lines ~2586–2625; line 167; examples table ~2983–2986)

### 1.4

- One-time notices have a documented mechanism: `ctx.ui.notify(message, "info" | "warning" | "error")`, fire-and-forget, working in both TUI and RPC modes.
  - Evidence: `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (line 12, line 2532, `hasUI` notes ~974)

### 1.5

- Run-mode detection is documented: `ctx.mode` (`"tui" | "rpc" | "json" | "print"`) and `ctx.hasUI`. Important nuance pinned into the design: `ctx.hasUI` is TRUE in RPC (headless) mode, so the TUI-only chip must guard on `ctx.mode === "tui"` (the docs' recommended guard for terminal-only rendering); UI methods are no-ops in JSON mode.
  - Evidence: `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (lines ~970–980; mode behavior table ~2928–2936)

### 1.6 (supporting)

- The passivity boundary (no spawns, no polling from display code) is design-internal; nothing in the documented Pi UI APIs requires or invites invocations, and the structural no-runner-access assertion remains implementable as specified.

### 2.5

- `openspec validate <item> --type <type> --strict` matches the installed OpenSpec CLI usage exactly.
  - Evidence: `openspec validate --help` (verified 2026-09-06; same CLI verified for change 1)

---

## Fixes needed

None outstanding. (The validator-prescribed mode-guard correction was applied to design.md with user approval under the established corrections policy.)

---

## Verdict

`VERDICT: READY`

> **Re-validated 2026-09-07** after the disposition pass revised tasks.md and sibling artifacts — `openspec validate --type change --strict` passed; the READY verdict below is re-confirmed as of this date.
