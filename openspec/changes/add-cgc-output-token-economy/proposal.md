## Why

Every `cgc` invocation the extension makes returns terminal-oriented output: progress chatter, rich formatting, and — for commands like `doctor` and `report` — content that can echo file paths and source-adjacent strings. CGC's own documentation warns that indexed source can contain hardcoded secrets (it redacts them in bundles via `REDACT_SECRETS`, but CLI output is not redacted). Uncapped, unfiltered output floods the session transcript, wastes tokens, and can leak secrets into context. This change adds the extension's universal output policy to `pi-codegraphcontext`: one pipeline through which every wrapped `cgc` invocation's output flows.

## What Changes

- Bounded capture on the shared runner: output is size-capped at a configured budget, preserving the beginning AND end with an explicit truncation marker that names the original size (the head+tail pattern — both ends are informative for diagnostics).
- Spill-to-file on truncation: the full output is written to a session-scoped temp file outside the workspace; the truncation marker names that path so the agent or user can inspect it with their own tools; spill files are removed on session shutdown by the existing multi-path cleanup.
- Secret redaction in captured output (on by default, with an opt-out config): conservative, pattern-based redaction of secret-shaped strings (key/token/password assignments, high-entropy literals) before anything is rendered or injected — defense in depth on top of CGC's bundle-level `REDACT_SECRETS`, which does not cover CLI output.
- Control-sequence hygiene: ANSI/control sequences are stripped from captured output (formalizing the rendering rule introduced by the slash-commands change).
- Optional GCF passthrough (opt-in, default off): when configured and `gcf-python` is installed, the runner sets `CGC_OUTPUT_FORMAT=gcf` for invocations, per CGC's documented output-format support with clean fallback when unavailable.
- Config keys: `output.maxBytes` (default 16384), `output.spillToTemp` (default true), `output.redactSecrets` (default true, opt-out), `output.gcf` (default false) — each with environment-variable overrides.
- Applies to every runner invocation (probes, syncs, commands); the CGC MCP server's own output is untouched (it has its own GCF opt-in documented by CGC).

## Capabilities

### New Capabilities

- `cgc-output-economy`: the universal output policy for wrapped `cgc` invocations — bounded head+tail capture, spill-to-file on truncation, secret redaction, control-sequence stripping, and optional GCF passthrough — applied once in the shared runner.

### Modified Capabilities

(none — no existing capabilities; `openspec/specs/` is empty)

## Impact

- Extension package `pi-codegraphcontext`; modifies the shared runner's capture pipeline (the foundation from `add-cgc-session-lifecycle-gate`) — all current and future surfaces (gate, commands, HUD notices) inherit the policy without per-surface work.
- The slash-commands renderer (`add-cgc-slash-commands`) consumes the policy's cleaned output rather than implementing its own bounding (its design already anticipated this).
- No changes to CodeGraphContext, the MCP server, or MCP tool schemas; no agent-context content is introduced by this change (rendering into prompts remains governed by the guidance/proactive-injection contracts).
- Spill files live in the OS temp directory (never the workspace), carry restrictive permissions where the platform allows, and are session-scoped.
