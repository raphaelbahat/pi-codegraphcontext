# pi-codegraphcontext

Pi coding-agent extension for CodeGraphContext (CGC). It wraps the `cgc`
binary for agent use, covering the index lifecycle gate, freshness sync, agent
routing guidance, status surfaces, and the CLI-gap tools below.

## Configuration

Configuration is resolved in this order (each layer overrides the previous one):

1. Built-in defaults
2. Optional JSON config files — global `~/.pi/agent/cgc.json`, then project `.pi/cgc.json` (project wins on conflict)
3. Environment-variable overrides (for headless/CI setups)

Only keys present in a config file are applied; invalid values are skipped with
a warning and fall back to the lower layer.

### CLI-gap tools: `tools.cliGap.enabled`

The three CLI-gap tools — `cgc_bundle_export`, `cgc_context`, and `cgc_doctor`
— fill gaps in the CGC MCP catalog (bundle export, named-context management,
and diagnostics) by wrapping the documented `cgc bundle export`, `cgc context`,
and `cgc doctor` verbs.

- **Default:** `true` — the tools are registered.
- Set to `false` to opt out: no CLI-gap tool exists in the tool catalog at all.
- One flag gates all three tools; there are no per-tool flags.

Example `.pi/cgc.json`:

```json
{
  "tools": {
    "cliGap": {
      "enabled": false
    }
  }
}
```

**Environment override:** `CGC_TOOLS_CLI_GAP_ENABLED` takes precedence over
the config key. Boolean values accept `1`/`true`/`yes`/`on` and
`0`/`false`/`no`/`off`.

```sh
export CGC_TOOLS_CLI_GAP_ENABLED=false
```