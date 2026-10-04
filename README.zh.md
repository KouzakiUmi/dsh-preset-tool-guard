# dsh-preset-tool-guard

**给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）用的「按 preset 控制工具可见性」插件。**

在 host 层挂一次即可。它监听 `agent/created`，读出该 Agent 实际组合出的 preset，然后用官方的
`ctx.tools.restrict()` 在**该 Agent 自己的作用域**上打一层掩码——每个 preset 只暴露它该有的工具，
而重型提供方保持挂载、原样可用。

[English documentation: README.md](README.md)

---

## 它解决什么问题

`dsh` 的工具解析顺序是 `agent → preset → global`。preset 组合只挂载自己的行，**不会**限制从全局层
继承来的工具。于是任何挂在 host 层的插件——桌面操作驱动、浏览器 MCP、图像提供方——都会出现在**每一个**
preset 的模型工具目录里，包括那些本来只打算暴露两三个工具的极简模式。

把这些提供方直接关掉不是答案：能力会一起消失，而且影响所有 preset 与所有会话。上游关于 preset 这一半的
讨论见 [deepseek-ai/deepseek-harness#5786](https://github.com/deepseek-ai/deepseek-harness/discussions/5786)。

`ctx.tools.restrict({ allow, deny })` 是官方给出的、按 Agent 作用域生效的答案：掩码只作用于该作用域
**继承**的东西（全局层与每一层祖先作用域），永不作用于该作用域自己注册的内容。本插件把这个接口接到
preset 生命周期上。

## 它改变了什么

| 项目 | 效果 |
| --- | --- |
| 模型侧工具 schema（每次请求的前缀） | 被掩掉的工具消失 |
| PTC 模式的 SDK 面 | 同样消失（两个投影读的是同一份视图） |
| 分发 | 被掩掉的调用返回 `UNKNOWN_TOOL`——是真掩码，不是展示层过滤 |
| 其它 Agent / preset | 不受影响（限制是按作用域隔离的） |
| 提供方插件本身 | 仍然挂载；你保留的能力照常工作 |

## 安装

插件自带 `cordis.patch.yml`，安装即挂载。

```sh
# 从 GitHub 安装
dsh plugin --profile <profile> add github:KouzakiUmi/dsh-preset-tool-guard

# 从本地目录安装
dsh plugin --profile <profile> add /path/to/dsh-preset-tool-guard
```

DSH Desktop（`dsh-desktop-next` 壳）会把命令行参数转发给内置的 `dsh` CLI：

```powershell
& "C:\Program Files\DSH NEXT\DSH NEXT.exe" plugin --profile desktop add github:KouzakiUmi/dsh-preset-tool-guard
```

> 尚未发布到 npm。

## 配置

插件自带的 patch 是保守默认（`dryRun: true`、没有白名单）。真正的配置写在你的 profile
`cordis.patch.yml` 里。Loader 对同一 entry id 的 config 是**整体替换**，所以要把关心的字段全部写全：

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

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `allowlists` | `{}` | `{ presetId: [工具名…] }`。命中的 preset **只保留**列出的工具，其余继承来的全部掩掉（fail-closed：新装插件的新工具不会泄漏进该 preset）。不在这个表里的 preset 完全不受影响。 |
| `deny` | `[]` | 所有 Agent 一律隐藏的精确工具名。 |
| `denyPrefixes` | `[]` | 所有 Agent 一律隐藏的命名空间前缀（例如 `cua_driver_native__`）。 |
| `groups` | `{}` | 命名工具组：`{ 组名: { names: [...], prefix: "..." } }`。 |
| `disableGroups` | `[]` | 被禁用的组，其成员对所有 Agent 隐藏。 |
| `skipUncomposed` | `true` | 没有组合 preset 的 Agent 不套白名单（`deny` 与组规则不受此开关影响）。 |
| `report` | `true` | 每个新建 Agent 打一行报告。 |
| `reportFile` | `$DSH_HOME/logs/preset-tool-guard.log` | 报告追加到这个文件。`false` 或空串关闭文件输出。 |
| `dryRun` | `false` | 只测量与报告，不改动任何工具面。调参时先开它。 |

## 工作原理

- 限制施加在 `agent.ctx` 上，也就是该 Agent 自己的作用域；`restrict()` 从调用上下文推导作用域，
  在普通（无作用域）上下文里会拒绝执行。
- filter 在注册时快照。
- 每个名字都会先与作用域的可限制集合求交：看不到的名字只跳过（绝不抛错），所以提供方升级改名只会
  表现为少省一些 + 报告里的一条提示，而不会让部署起不来。
- PTC 的保留传输名 `run_code` 永远不会写进 filter。
- 白名单与该作用域可限制工具**没有交集**时放弃掩码并告警，而不是把工具面清空。
- 所有失败路径都只记日志并返回；绝不阻塞 Agent 创建。

## 报告

```
preset-tool-guard: hid 119/168 tools (161434 of 199433 schema bytes, 80.9%, ~44843 tokens)
  agent="..." preset="standard" mode=allowlist
```

本机 desktop profile 的实测：`standard` 的工具前缀从约 60K tokens 降到约 10.5K 的 schema
（GUI 显示 11.6K）；一个桌面操作驱动（62 个工具）、两个浏览器 MCP（55 个工具）与图像提供方被掩出
日常模式，同时仍在一个"不声明白名单"的 `full` 模式里完整可用。

## 有两类名字会保持可见

`restrict` 只掩蔽作用域**继承**的内容。两个后果值得先知道，再去提 issue：

1. **自身层注册。** 插件注册在 Agent 自己那一层上的工具不在过滤范围。本机 `subagent`、
   `list_subagent_models`、`schedule_*`、`cordis_inspect_*` 就是这样：白名单怎么写它们都可见。
   若这类工具必须消失，得在它自己的插件配置里关——白名单做不到。
2. **尚未注册。** 提供方没连上、或在 `agent/created` 时还没挂载的名字会被跳过。这类名字建议仍然
   留在白名单里作为防御：万一它将来改成通过继承层注册，白名单会继续放行。

报告行会把这两种情况分开打印，不必靠猜。

## 开发

```sh
node scripts/check-patch.cjs [profileDir] [toolsJson]
```

用支持 `!!js` 标签的解析器读取你的 profile 补丁，打印解析出的 `preset-*` 声明与各 preset 的白名单
数量；如果给了工具名 JSON 数组，还会报出白名单里"当前工具目录中不存在"的名字。工具目录可以用
`cordis_inspect_query`（host / `Tool` / `listTools`）导出。

## 兼容性

已在 `@deepseek-ai/dsh-*` **0.2.0-rc.2** 上验证。插件只在运行时通过 `ctx.get()` 读 `tools` 与
`agentPresets`，加载时不 import 除 Node 内置模块以外的任何东西，所以依赖面很小：`@deepseek-ai/cordis`
（~4.x），加上一个暴露 `ToolRuntime.restrict()` 与 `agent/created` 事件的 harness。

## 许可

MIT，见 [LICENSE](LICENSE)。
