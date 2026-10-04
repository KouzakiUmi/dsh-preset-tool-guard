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

Requirements: Node `^22.19` or `>=24` (see `engines`), and a harness that exposes
`ToolRuntime.restrict()` plus the `agent/created` event.

The package ships its own `cordis.patch.yml`, so installing it mounts the plugin row.

```sh
# any dsh CLI (TUI, web profile, …)
dsh plugin --profile <profile> add github:KouzakiUmi/dsh-preset-tool-guard

# from a local checkout
dsh plugin --profile <profile> add /path/to/dsh-preset-tool-guard
```

**DSH Desktop has no `dsh` on PATH.** The GUI executable is the Electron shell, not the CLI — passing
`plugin …` to it does *not* run a plugin command. Use the terminal shim that the desktop ships
(verified on DSH Desktop `2.0.17-next`, core `0.2.0-rc.2`):

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& "C:\Program Files\DSH NEXT\DSH NEXT.exe" --expose-internals `
  "C:\Program Files\DSH NEXT\resources\app\lib\desktop-cli.js" `
  plugin --profile desktop add github:KouzakiUmi/dsh-preset-tool-guard
```

Both forms end up in `pnpm` inside the profile directory (`plugin` forwards its arguments to pnpm), so
`add` / `remove` / `install` all behave as you expect. Note that `--profile` is mandatory, and that the
bundled `dsh` refuses to boot a profile literally named `desktop` outside the Electron path.

Then **restart DSH**: the plugin is a host-side bundle, so the running process keeps its old tree.
Sessions created before the restart keep the tool surface they started with.

To remove it, run the same command with `remove`, and delete the `preset-tool-guard` entry from your
profile patch (see below). Removing the package row alone leaves a dangling config block.

> Not published to npm yet.

## Configure

The plugin's own patch ships a conservative default (`dryRun: true`, no allowlists). Put the real
configuration in your profile's `cordis.patch.yml`. Loader config for the same entry id is **replaced
wholesale**, so restate every field you care about — including `dryRun`, which otherwise falls back to
the code default `false` (masking enabled).

```yaml
- id: preset-tool-guard
  config:
    allowlists:
      minimal: [bash, pwsh, str_replace_editor]
      standard: [read, write, edit, glob, grep, pwsh, skill, todo_write, web_search, memory_recall]
      text: [read, write, edit, glob, grep, pwsh, grok_imagine_edit]
    deny: []
    denyPrefixes: []
    groups: {}
    disableGroups: []
    skipUncomposed: true
    report: true
    # reportFile may be omitted (defaults to $DSH_HOME/logs/preset-tool-guard.log).
    # A leading `~` is expanded; an absolute path is used as-is.
    reportFile: C:/Users/you/.dsh/logs/preset-tool-guard.log
    dryRun: false
```

| Field | Default in code | Meaning |
| --- | --- | --- |
| `allowlists` | `{}` | `{ presetId: [toolName, …] }`. A matching preset keeps **only** the listed inherited tools; every other inherited tool is masked (fail-closed: a tool registered later on an inherited layer is *not* admitted, because the filter is a snapshot). An empty array is a deliberate "keep nothing" list, not "unconfigured" — if it cannot intersect the restrictable set, the plugin aborts the mask with a warning instead of blanking the tool surface. Presets absent from this map get no allowlist, but still receive the `deny` / group rules below. |
| `deny` | `[]` | Exact tool names removed from every agent, composed preset or not. |
| `denyPrefixes` | `[]` | Plain `startsWith` prefixes removed from every agent (e.g. `cua_driver_native__`). |
| `groups` | `{}` | Named groups: `{ groupId: { names: […], prefix: "…" } }`. |
| `disableGroups` | `[]` | Group ids whose members are removed from every agent. |
| `skipUncomposed` | `true` | Skip the **allowlist** for agents with no composed preset. The `deny` / group half still applies to them. |
| `report` | `true` | One report line per (re)application. |
| `reportFile` | `$DSH_HOME/logs/preset-tool-guard.log` | Append reports here. `false` or `""` disables file output. `~` is expanded; omit the field to use the default. |
| `dryRun` | `false` | Measure and report only; change nothing. Start here when tuning. |

## How it works

- The restriction is applied on `agent.ctx` — the agent's own scope. `restrict()` derives the scope
  from the calling context and refuses to run from a plain (unscoped) one.
- **The filter is snapshotted at registration.** `allow` therefore keeps admitting only the names it
  listed *at that moment*; a name that appears later on an inherited layer is **not** admitted. If you
  need a late-registering provider to be visible, create a new agent after it registers.
- For that reason an allowlist match installs its mask **even when nothing is currently excluded** —
  that is what keeps future inherited tools out. Skipping the install would silently turn a fail-closed
  policy into a fail-open one.
- Names are resolved against the scope's restrictable set **before** the call: a name the agent cannot
  see is skipped (never thrown), so a provider upgrade that renames a tool degrades to a smaller saving
  plus a report note, not to a startable-but-broken deployment.
- `ToolRuntime.view()` is not part of the documented Service contract. The plugin probes it and, if it
  is unavailable, **skips masking and says so** rather than falling back to `schemas()` — the two sets
  differ (schemas include the agent's own layer and the reserved transport name), and feeding those
  names to `restrict()` would make the whole call fail.
- The reserved PTC transport `run_code` is never written into a filter.
- An allowlist that intersects the restrictable set to nothing aborts the mask with a warning.
- Every failure path logs and returns; agent creation is never blocked.
- **Preset switches are handled.** Upstream `recompose` (used when a blank session changes preset) only
  rebinds the mount — it does not re-emit `agent/created`. The plugin listens for
  `agent-preset/selected`, releases the previous restriction and re-applies, because restrictions
  intersect and cannot be widened in place.
- **The mask has plugin ownership too.** `restrict()`'s disposer is kept per agent and released when the
  agent is disposed *and* when the plugin itself unloads, so a config reload cannot leave a stale mask
  behind on a live agent.

## Reporting

```
2026-10-04T12:34:56.789Z preset-tool-guard: excluded 114/168 inherited names (155810 of 199433 utf8 schema bytes, 78.1%, ~43281 tokens) agent="session-…" preset="standard" mode=allowlist
```

- `excluded` / `would exclude` (the latter under `dryRun`), and `mode=allowlist|bottom`.
- Counts and sizes describe the **inherited surface**: names the restriction excludes out of the names
  the scope could restrict. Visible-tool counts can differ (see the two exceptions below).
- Sizes are UTF-8 bytes of the serialized schema, converted to a rough token estimate at 3.6 bytes per
  token — a magnitude, not a tokenizer measurement.
- On a no-op it prints `无需掩码 / no mask needed` instead.
- The same line is appended to `reportFile` with an ISO timestamp. The host logger's output channel is
  not necessarily a readable log file, so the file is the reliable record.

Measured on a desktop profile (core `0.2.0-rc.2`): `standard` went from roughly 60K tokens of tool
prefix to about 10.5K of schema, with a computer-use driver (62 tools), two browser MCP servers (55
tools) and image providers excluded from the everyday presets — and still fully available in a `full`
preset that simply declares no allowlist.

## Two ways a name stays visible

`restrict` masks only what a scope **inherits**. Two consequences are worth knowing before you file a
bug:

1. **Self-layer registrations.** Tools a plugin registers on the agent's *own* layer are outside the
   filter. On one machine `subagent`, `list_subagent_models`, `schedule_*` and `cordis_inspect_*`
   behave this way: they stay visible no matter what the allowlist says. An allowlist cannot remove
   them — turn such a tool off in its own plugin's configuration.
2. **Not registered at that moment.** A name whose provider is not connected, or not yet mounted when
   the agent is created, is skipped. Keeping it in the allowlist does **not** reserve visibility for
   later either (see the snapshot rule above); it only avoids a name-collision error.

The report line separates the two cases so you can tell them apart without guessing.

## Development

```sh
node scripts/check-patch.cjs [profileDir] [toolsJson] [--strict]
```

Defaults: `profileDir` = `$DSH_HOME/profiles/desktop`, `toolsJson` =
`$DSH_HOME/tmp-guard-tools.json`. It parses your profile patch with the `!!js` tag supported, prints
every `preset-*` declaration and the per-preset allowlist sizes, and — when the tool catalog file
exists — reports allowlist names the catalog does not contain.

The catalog file accepts either shape, so a raw `cordis_inspect_query` result can be written to disk
as-is:

- `{ "tools": [ { "name": "read", … }, … ] }` (host / `Tool` / `listTools` output)
- `[ "read", "write", … ]`

Exit code is `0` on success and `1` on a parse failure, a structurally invalid patch, an unrecognizable
catalog shape, or (with `--strict`) a missing tool name. Without `--strict`, missing names are warnings
— names can legitimately be absent on another platform (the shipped `bash` row is Windows-disabled).

## Compatibility

Verified on `@deepseek-ai/dsh-*` **0.2.0-rc.2** (Node `^22.19 || >=24`). The plugin reads `tools`,
`agentPresets` and `agents` through `ctx.get()` at runtime and imports nothing at load time except Node
builtins, so the peer surface is small: `@deepseek-ai/cordis` (~4.x) plus a harness exposing
`ToolRuntime.restrict()`, `agent/created` and `agent-preset/selected`.

## License

MIT — see [LICENSE](LICENSE).
