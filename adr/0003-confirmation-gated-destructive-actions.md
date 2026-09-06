# ADR-0003: Destructive cgc actions require in-session confirmation; deletion verbs are never exposed

## Status

Proposed

## Date

2026-09-06

## Context

The `pi-codegraphcontext` extension exposes human-facing `/cgc` commands that trigger CodeGraphContext (CGC) maintenance actions. Among the CGC CLI verbs, some are non-destructive and cheap (`stats`, `doctor`, incremental `index`), one replaces an existing index (`index --force`), one writes a file into the workspace (`report` → `CGC_REPORT.md`), and some are destructive database operations (`delete`, `clean`) that CGC itself gates behind the `ALLOW_DB_DELETION` configuration because they remove data. Embedded graph backends are single-process, and the extension already commits to skip-as-busy rather than forcing (ADR-0001). The project's consent posture from the session-start lifecycle gate is that data-destroying actions never happen silently.

## Decision

The extension's command surface applies one consent model everywhere: read-only and non-destructive actions (status, doctor, incremental sync/index of changed files) run without confirmation; any action that replaces an existing index (force rebuild) or writes a file into the workspace (report) requires an explicit in-session confirmation naming the effect and, for writes, the destination path; and CGC verbs gated by `ALLOW_DB_DELETION` (repository deletion, database cleanup) are never exposed by the extension at all. Confirmations are skippable only by declining the action — there is no "don't ask again" option for destructive actions. Busy/lock conflicts surface as one-time notices, never as forced retries.

## Consequences

- Positive: the extension cannot surprise the user with data loss or unexpected file writes, regardless of which future surface (commands, status displays, optional future tools) triggers the action.
- Positive: the consent check lives in one shared layer, so new surfaces inherit it instead of re-deciding it.
- Positive: alignment with CGC's own safety design (deletion remains behind `ALLOW_DB_DELETION`, which the extension never sets or bypasses).
- Negative: two actions always cost one confirmation keystroke; accepted as the price of never-destructive-by-accident behavior.
- Negative: power users performing frequent rebuilds feel friction; the alternatives (config flag to skip confirmations) were considered and rejected as re-opening the silent-destruction risk.
- Follow-up: the status-HUD and proactive-injection changes must render, not bypass, this consent model; any future agent-facing convenience tools inherit the same rule.
