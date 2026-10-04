# dsh-preset-tool-guard

**Per-preset tool visibility for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).**

Mount it once at the host level. It watches `agent/created`, reads the preset that agent actually
composed, and applies the official `ctx.tools.restrict()` seam on **that agent's own scope** — so each
preset exposes only the tools it should, while the heavy providers stay mounted and untouched.

[简体中文说明见 README.zh.md](README.zh.md)

---

## The problem

`dsh` resolves tools along `agent → preset → global`. A preset composition mounts its own rows; it
**does not** restrict what is inherited from the global layer. So any plugin mounted at the host level
— a computer-use driver, browser MCP servers, image providers — shows up in the model's tool catalog of
**every** preset, including `minimal` ones that were designed to expose two or three tools.

Disabling those providers is not the answer: you lose the capabilities entirely, and it affects every
preset and session. The upstream discussion for the preset half of this is
[deepseek-ai/deepseek-harness#5786](https://github.com/deepseek-ai/deepseek-harness/discussions/5786).

`ctx.tools.restrict({ allow, deny })` is the public, agent-scoped answer: a restriction masks what the
scope **inherits** (the global layer and every ancestor scope layer) and never what the scope registers
itself. This plugin wires that seam into the preset lifecycle.

## What it changes

| | Effect |
| --- | --- |
| Model-facing tool schemas (the per-request prefix) | the masked tools are gone |
| PTC mode SDK surface | gone as well (both projections read the same view) |
| Dispatch | masked calls return `UNKNOWN_TOOL` — a real mask, not a presentation filter |
| Other agents / presets | unaffected; a restriction is per scope |
| The provider itself | still mounted; every capability you kept keeps working |

## Install

The package ships its own `cordis.patch.yml`, so installing it mounts the plugin row.

```sh
# from GitHub
dsh plugin --profile <profile> add github:KouzakiUmi/dsh-preset-tool-guard

# from a local checkout
dsh plugin --profile <profile> add /path/to/dsh-preset-tool-guard
```

DSH Desktop (the `dsh-desktop-next` shell) forwards CLI arguments to the packaged `dsh` CLI:

```powershell
& "C:\Program Files\DSH NEXT\DSH NEXT.exe" plugin --profile desktop add github:KouzakiUmi/dsh-preset-tool-guard
```

> Not published to npm yet.

## Configure

The plugin's own patch ships a conservative default (`dryRun: true`, no allowlists). Put the real
configuration in your profile's `cordis.patch.yml`. Loader config for the same entry id is **replaced
wholesale**, so restate every field you care about:

```yaml
- id: preset-tool-guard
  config:
    allowlists:
      minimal: [bash, pwsh, str_replace_editor]
      standard: [read, write, edit, glob, grep, pwsh, skill, todo_write, web_search, ...]
      text: [read, write, edit, glob, grep, pwsh, grok_imagine_edit, ...]
    deny: []
    denyPrefixes: []
    groups: {}
    disableGroups: []
    skipUncomposed: true
    report: true
    reportFile: ~/.dsh/logs/preset-tool-guard.log
    dryRun: false
```

| Field | Default | Meaning |
| --- | --- | --- |
| `allowlists` | `{}` | `{ presetId: [toolName, ...] }`. A matching preset keeps **only** the listed tools; every other inherited tool is masked (fail-closed: a newly installed plugin's tools will not leak into that preset). Presets absent from this map are untouched. |
| `deny` | `[]` | Exact tool names removed from every agent. |
| `denyPrefixes` | `[]` | Namespace prefixes removed from every agent (e.g. `cua_driver_native__`). |
| `groups` | `{}` | Named groups: `{ groupId: { names: [...], prefix: "..." } }`. |
| `disableGroups` | `[]` | Group ids whose members are removed from every agent. |
| `skipUncomposed` | `true` | Agents with no composed preset get no allowlist (the `deny` / group half still applies). |
| `report` | `true` | One report line per created agent. |
| `reportFile` | `$DSH_HOME/logs/preset-tool-guard.log` | Append reports to this file. `false` or `""` disables file output. |
| `dryRun` | `false` | Measure and report only; change nothing. Start here when tuning. |

## How it works

- The restriction is applied on `agent.ctx` — the agent's own scope. `restrict()` derives the scope
  from the calling context and refuses to run from a plain (unscoped) one.
- The filter is snapshotted at registration.
- Names are resolved against the scope's restrictable set **before** the call: a name the agent cannot
  see is skipped (never thrown), so a provider upgrade that renames a tool degrades to a smaller saving
  plus a report note, not to an unstartable deployment.
- The reserved PTC transport `run_code` is never written into a filter.
- An allowlist that intersects the restrictable set to nothing aborts the mask with a warning, instead
  of blanking the tool surface.
- Every failure path logs and returns; agent creation is never blocked.

## Reporting

```
preset-tool-guard: hid 119/168 tools (161434 of 199433 schema bytes, 80.9%, ~44843 tokens)
  agent="..." preset="standard" mode=allowlist
```

Measured on this machine with a desktop profile: `standard` went from roughly 60K tokens of tool
prefix to about 10.5K of schema (the GUI reported 11.6K), with a computer-use driver (62 tools), two
browser MCP servers (55 tools) and image providers masked out of the everyday presets — and still fully
available in a `full` preset that simply declares no allowlist.

## Two ways a name stays visible

`restrict` masks only what a scope **inherits**. Two consequences are worth knowing before you file a
bug:

1. **Self-layer registrations.** Tools a plugin registers on the agent's *own* layer are outside the
   filter. On this machine `subagent`, `list_subagent_models`, `schedule_*` and `cordis_inspect_*`
   behave this way: they stay visible no matter what the allowlist says. If a tool like that must not
   appear, turn it off in its own plugin's configuration — an allowlist cannot remove it.
2. **Not registered (yet).** A name whose provider is not connected, or not yet mounted at
   `agent/created`, is skipped. Keep such names in the allowlist anyway as defence: if that plugin
   later registers through an inherited layer, the allowlist keeps admitting it.

The report line separates the two cases so you can tell them apart without guessing.

## Development

```sh
node scripts/check-patch.cjs [profileDir] [toolsJson]
```

Parses your profile patch with the `!!js` tag supported, prints the parsed `preset-*` declaration and
the per-preset allowlist sizes, and — if you pass a JSON array of tool names — reports allowlist names
that the live tool catalog does not contain. The tool catalog can be exported from
`cordis_inspect_query` (host / `Tool` / `listTools`).

## Compatibility

Verified on `@deepseek-ai/dsh-*` **0.2.0-rc.2**. The plugin reads `tools` and `agentPresets` through
`ctx.get()` at runtime and imports nothing at load time except Node builtins, so the peer surface is
small: `@deepseek-ai/cordis` (~4.x) plus a harness that exposes `ToolRuntime.restrict()` and the
`agent/created` event.

## License

MIT — see [LICENSE](LICENSE).
