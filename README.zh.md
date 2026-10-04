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

前置要求：Node `^22.19` 或 `>=24`（见 `engines`），以及一个暴露 `ToolRuntime.restrict()` 与
`agent/created` 事件的 harness。

插件自带 `cordis.patch.yml`，安装即挂载。

```sh
# 任何 dsh CLI（TUI、web profile 等）
dsh plugin --profile <profile> add github:KouzakiUmi/dsh-preset-tool-guard

# 从本地目录安装
dsh plugin --profile <profile> add /path/to/dsh-preset-tool-guard
```

**DSH Desktop 的 PATH 里没有 `dsh`。** GUI 可执行文件是 Electron 壳，不是 CLI——把 `plugin …` 传给它
**不会**执行插件命令。请用它自带的终端 shim（已在 DSH Desktop `2.0.17-next` + 核心 `0.2.0-rc.2` 实测）：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& "C:\Program Files\DSH NEXT\DSH NEXT.exe" --expose-internals `
  "C:\Program Files\DSH NEXT\resources\app\lib\desktop-cli.js" `
  plugin --profile desktop add github:KouzakiUmi/dsh-preset-tool-guard
```

两种写法最终都落进 profile 目录里的 `pnpm`（`plugin` 会把参数转发给它），因此 `add` / `remove` /
`install` 的行为与预期一致。注意 `--profile` 是必填项；另外内置 `dsh` 会拒绝在 Electron 路径之外
启动名为 `desktop` 的 profile。

安装后**需要重启 DSH**：插件是 host 侧 bundle，运行中的进程仍持有旧的插件树；重启前创建的会话会保持它
启动时的工具面。

卸载请用同样的命令换成 `remove`，并从 profile 补丁里删掉 `preset-tool-guard` 配置段——只移除包行会留下
一段悬空配置。

> 尚未发布到 npm。

## 配置

插件自带的 patch 是保守默认（`dryRun: true`、没有白名单）。真正的配置写在你的 profile
`cordis.patch.yml` 里。Loader 对同一 entry id 的 config 是**整体替换**，所以要把关心的字段全部写全——
**包括 `dryRun`**：漏写它会落到代码默认值 `false`（即真的开始掩码）。

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
    # reportFile 可省略（默认 $DSH_HOME/logs/preset-tool-guard.log）。
    # 开头的 `~` 会被展开；绝对路径按原样使用。
    reportFile: C:/Users/you/.dsh/logs/preset-tool-guard.log
    dryRun: false
```

| 字段 | 代码默认值 | 含义 |
| --- | --- | --- |
| `allowlists` | `{}` | `{ presetId: [工具名…] }`。命中的 preset 只保留列出的**继承**工具，其余继承来的全部掩掉（fail-closed：之后注册到继承层的工具**不会**被放行，因为 filter 是快照）。空数组是"显式一个都不留"，不是"没配"——若它与可限制集合无交集，插件放弃掩码并告警，而不是把工具面清空。未列入的 preset 不套白名单，但仍受下面的 `deny` / 组规则约束。 |
| `deny` | `[]` | 所有 Agent 一律隐藏的精确工具名，无论有没有组合 preset。 |
| `denyPrefixes` | `[]` | 所有 Agent 一律隐藏的**裸前缀**（`startsWith` 语义，例如 `cua_driver_native__`）。 |
| `groups` | `{}` | 命名工具组：`{ 组名: { names: […], prefix: "…" } }`。 |
| `disableGroups` | `[]` | 被禁用的组，其成员对所有 Agent 隐藏。 |
| `skipUncomposed` | `true` | 对没有组合 preset 的 Agent 跳过**白名单**；`deny` 与组规则仍对它们生效。 |
| `report` | `true` | 每次（重新）施加都打一行报告。 |
| `reportFile` | `$DSH_HOME/logs/preset-tool-guard.log` | 报告追加到这个文件。`false` 或空串关闭文件输出；`~` 会被展开；省略该字段则用默认路径。 |
| `dryRun` | `false` | 只测量与报告，不改动任何工具面。调参时先开它。 |

## 工作原理

- 限制施加在 `agent.ctx`（该 Agent 自己的作用域）；`restrict()` 从调用上下文推导作用域，在普通
  （无作用域）上下文里会拒绝执行。
- **filter 在注册时快照。** 因此 `allow` 只持续放行它**那一刻**列出的名字；之后才出现在继承层的名字
  **不会**被放行。如果某个晚注册的提供方需要可见，请在它注册之后新建 Agent。
- 正因如此，白名单命中时**即使当前没有任何名字被排除，也会安装掩码**——这才挡住了将来注册到继承层的
  工具；跳过安装会把 fail-closed 策略悄悄变成 fail-open。
- 每个名字都会先与作用域的可限制集合求交：看不到的名字只跳过（绝不抛错），所以提供方升级改名只会表现为
  少省一些 + 报告里的一条提示，而不是起得来却坏掉的部署。
- `ToolRuntime.view()` 不在文档化的 Service 契约里。插件会做能力探测；一旦不可用就**跳过掩码并明确
  说明**，而**不**退回到 `schemas()`——两者的集合语义不同（schemas 含 Agent 自身层与保留传输名），
  把那些名字喂给 `restrict()` 会让整次调用失败。
- PTC 的保留传输名 `run_code` 永远不会写进 filter。
- 白名单与该作用域可限制工具**没有交集**时放弃掩码并告警。
- 所有失败路径都只记日志并返回；绝不阻塞 Agent 创建。
- **preset 切换被正确处理**：上游 `recompose`（空白会话切换 preset 时走它）只做重新绑定，**不会**重发
  `agent/created`。插件监听 `agent-preset/selected`，先撤销旧限制再重新施加——因为限制之间取交集，不能
  就地放宽。
- **掩码也有插件所有权**：`restrict()` 返回的 disposer 按 Agent 保存，在 Agent 销毁**以及插件自身卸载**
  时释放，因此配置重载不会在存活 Agent 上留下旧掩码。

## 报告

```
2026-10-04T12:34:56.789Z preset-tool-guard: excluded 114/168 inherited names (155810 of 199433 utf8 schema bytes, 78.1%, ~43281 tokens) agent="session-…" preset="standard" mode=allowlist
```

- 动词为 `excluded`（`dryRun` 下是 `would exclude`），并带 `mode=allowlist|bottom`。
- 计数与体积描述的是**继承面**：在"该作用域可限制的名字"里被排除掉多少个。可见工具数可能不同（见下面的
  两类例外）。
- 体积是序列化 schema 的 UTF-8 字节数，再按 3.6 字节/token 折算成粗略 token 估计——只表示量级，不是
  分词器测量值。
- 无需掩码时会打印 `无需掩码 / no mask needed`。
- 同一行会带 ISO 时间戳追加到 `reportFile`。宿主 logger 的输出通道不一定落到可读日志文件，所以文件才是
  可核对的记录。

在一台 desktop profile（核心 `0.2.0-rc.2`）上的实测：`standard` 的工具前缀从约 60K tokens 降到约
10.5K 的 schema；一个桌面操作驱动（62 个工具）、两个浏览器 MCP（55 个工具）与图像提供方被排除出日常
模式，同时仍在一个"不声明白名单"的 `full` 模式里完整可用。

## 有两类名字会保持可见

`restrict` 只掩蔽作用域**继承**的内容。两个后果值得先知道，再去提 issue：

1. **自身层注册。** 插件注册在 Agent 自己那一层上的工具不在过滤范围。本机 `subagent`、
   `list_subagent_models`、`schedule_*`、`cordis_inspect_*` 就是这样：白名单怎么写它们都可见。
   白名单**移除不了**这类工具——要关掉得去它自己的插件配置里关。
2. **当时尚未注册。** 提供方没连上、或在 Agent 创建时还没挂载的名字会被跳过。把它留在白名单里**也
   不能**为将来预留可见性（见上面的快照规则），只是避免出现名字冲突报错。

报告行会把这两种情况分开打印，不必靠猜。

## 开发

```sh
node scripts/check-patch.cjs [profile目录] [工具清单JSON] [--strict]
```

默认值：`profile目录` = `$DSH_HOME/profiles/desktop`，`工具清单JSON` = `$DSH_HOME/tmp-guard-tools.json`。
它会用支持 `!!js` 标签的解析器读取你的 profile 补丁，打印每个 `preset-*` 声明与各 preset 的白名单数量；
当工具清单文件存在时，还会报出白名单里"工具目录中不存在"的名字。

工具清单接受两种形状，因此 `cordis_inspect_query` 的原始结果可以直接落盘：

- `{ "tools": [ { "name": "read", … }, … ] }`（host / `Tool` / `listTools` 的输出）
- `[ "read", "write", … ]`

退出码：成功为 `0`；解析失败、补丁结构不合格、清单形状无法识别，或 `--strict` 下有缺名时为 `1`。
不加 `--strict` 时缺名只算警告——名字可能确实属于其他平台（自带补丁里的 `bash` 行在 Windows 上就是
禁用的）。

## 兼容性

已在 `@deepseek-ai/dsh-*` **0.2.0-rc.2** 上验证（Node `^22.19 || >=24`）。插件只在运行时通过
`ctx.get()` 读 `tools`、`agentPresets` 与 `agents`，加载时不 import 除 Node 内置模块以外的任何东西，
所以依赖面很小：`@deepseek-ai/cordis`（~4.x），加上一个暴露 `ToolRuntime.restrict()`、
`agent/created` 与 `agent-preset/selected` 的 harness。

## 许可

MIT，见 [LICENSE](LICENSE)。
