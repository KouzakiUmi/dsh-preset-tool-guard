/**
 * dsh-preset-tool-guard —— 按 Agent 的 preset 施加工具可见性掩码。
 *
 * 背景：DSH 的工具解析顺序是 `agent → preset → global`，工具注册表按作用域链
 * 合并。preset 组合只负责挂载自己的行，**不会**限制从 global 层继承来的工具，
 * 所以任何装在 host 层的插件（CUA 桌面操作、MCP、图像生成…）都会出现在每个
 * preset 的模型工具面里，把请求前缀撑到几十 K tokens。
 *
 * 本插件只做一件事：在 `agent/created` 时读出该 Agent 实际组合出的 preset，
 * 在该 Agent **自己的作用域**上调用官方 `ctx.tools.restrict()` 打一层掩码。
 * 掩码是真实的（分发层同样生效，被掩掉的调用得到 UNKNOWN_TOOL），且只影响这
 * 一个作用域，其它 preset 的会话完全不受影响；被掩掉的提供方仍然挂载着。
 *
 * 本机核心 0.2.0-rc.2 的 API 约束（见 @deepseek-ai/dsh-tools 的 ToolRuntime）：
 *   - `restrict({ allow?, deny? })` 必须在 scoped context（agent.ctx）上调用，
 *     全局上下文调用会抛错；allow 与 deny 同时给出时取交集；
 *   - filter 在注册时**快照**：`allow` 只保留当时列出的名字，之后才注册到继承层的
 *     名字不会被自动放行（fail-closed 的由来，也是"留名作防御"不成立的原因）；
 *   - filter 里的名字若不在该作用域"可限制集合"内会抛错，因此这里一律先探测
 *     再构造，缺名只跳过并记入报告，绝不因为一个改名就让 Agent 创建失败；
 *   - 保留名 `run_code`（PTC 呈现通道）既不能被掩码，也不能出现在 filter 里；
 *   - 掩码只作用于"继承面"（global + 祖先作用域），不作用于该 Agent 自己注册的层。
 *
 * 生命周期：掩码随 Agent 作用域自动回收；本插件另外保存 `restrict()` 返回的
 * disposer，用于 ①preset 在空白会话中切换后重新施加（上游 recompose 只做
 * bind/rebind，不重发 agent/created）②插件卸载时撤销，避免"插件没了、掩码还在"。
 *
 * 报告：每个 Agent 一行，走宿主 logger 与（默认开启的）报告文件。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** PTC 呈现通道的保留名：不能出现在 filter 里，也不会被掩码。 */
const RESERVED_TOOL = 'run_code'

/** 粗估 token 用量时每 token 折合的 schema 字节数（量级口径）。 */
const BYTES_PER_TOKEN = 3.6

export const name = 'preset-tool-guard'

/** 只强依赖工具注册表；preset 身份与 Agent 查找经可选服务读取。 */
export const inject = ['tools']

function asNames(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.length > 0)
}

function normalizeGroups(value) {
  const groups = new Map()
  if (value === null || typeof value !== 'object') return groups
  for (const [id, spec] of Object.entries(value)) {
    if (spec === null || typeof spec !== 'object') continue
    groups.set(id, {
      names: asNames(spec.names),
      prefix: typeof spec.prefix === 'string' && spec.prefix.length > 0 ? spec.prefix : undefined,
    })
  }
  return groups
}

/** 展开开头的 `~` / `~/`，让配置里写 `~/.dsh/...` 也能落到真实 home。 */
export function expandHome(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/** 默认报告文件：$DSH_HOME/logs/preset-tool-guard.log（DSH_HOME 缺省为 ~/.dsh）。 */
export function defaultReportFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'logs', 'preset-tool-guard.log')
}

/**
 * 解析报告文件设置：未提供 -> 默认路径；false / 空串 -> 关闭文件报告。
 * @returns 绝对路径（已展开 `~`），或 undefined 表示不写文件。
 */
export function resolveReportFile(value) {
  if (value === false || value === '') return undefined
  if (typeof value === 'string') return expandHome(value)
  return defaultReportFile()
}

/** 把 profile 传入的原始 config 规范化为内部结构（非法字段忽略，不抛错）。 */
export function normalizeConfig(raw) {
  const cfg = raw !== null && typeof raw === 'object' ? raw : {}
  const allowlists = new Map()
  if (cfg.allowlists !== null && typeof cfg.allowlists === 'object') {
    for (const [preset, list] of Object.entries(cfg.allowlists)) {
      // 空数组是**显式空白名单**（保留零个继承工具），与"没配这个 preset"不同。
      // 若与可限制集合无交集，下面会放弃掩码并告警，不会真的清空工具面。
      if (Array.isArray(list)) allowlists.set(preset, asNames(list))
    }
  }
  return {
    allowlists,
    groups: normalizeGroups(cfg.groups),
    disableGroups: asNames(cfg.disableGroups),
    deny: asNames(cfg.deny),
    denyPrefixes: asNames(cfg.denyPrefixes),
    skipUncomposed: cfg.skipUncomposed !== false,
    report: cfg.report !== false,
    dryRun: cfg.dryRun === true,
    reportFile: resolveReportFile(cfg.reportFile),
  }
}

/** 报告出口：logger 之外再落一份文件，写失败即永久降级为仅 logger。 */
function makeReporter(ctx, file) {
  if (file === undefined) return () => {}
  let dirReady = false
  let disabled = false
  return (line) => {
    if (disabled) return
    try {
      if (!dirReady) {
        mkdirSync(dirname(file), { recursive: true })
        dirReady = true
      }
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch (error) {
      disabled = true
      ctx.logger.warn(`preset-tool-guard: 报告文件不可写（${file}），后续只走 logger：${String(error)}`)
    }
  }
}

/**
 * 该 Agent 作用域里"可被限制"的工具名集合。
 *
 * `view()` 不是 Service 契约承诺的公开方法，所以先做能力探测；一旦不可用就返回
 * null —— **不做**退回 `schemas()`：两者集合语义不同（`schemas()` 含 Agent 自身层
 * 与保留传输名，把这些名字写进 filter 会让整个 `restrict()` 被拒绝），那样的
 * "兼容回退"只会静默改变行为。
 * @returns Set<string>，或 null 表示无法可靠取得可限制集合。
 */
function restrictableNames(tools, agent) {
  if (typeof tools.view !== 'function') return null
  try {
    const view = tools.view(agent)
    if (view !== null && typeof view === 'object' && view.restrictableNames instanceof Set) {
      return view.restrictableNames
    }
  } catch {
    return null
  }
  return null
}

/** 该 Agent 当前可见的全部工具名，用于把"不可掩码"的名字分成自身层与未注册。 */
function visibleNames(tools, agent) {
  try {
    return new Set(tools.schemas(agent).map((schema) => schema.name))
  } catch {
    return new Set()
  }
}

/** 每个可见工具的 schema 大小（UTF-8 字节），用于量化省下的请求前缀。 */
function schemaBytes(tools, agent) {
  const bytes = new Map()
  try {
    for (const schema of tools.schemas(agent)) {
      try {
        bytes.set(schema.name, Buffer.byteLength(JSON.stringify(schema), 'utf8'))
      } catch {
        // 不可序列化的 schema 不参与计量。
      }
    }
  } catch {
    // schema 投影不可用时不计量。
  }
  return bytes
}

/** 全局兜底规则：deny / denyPrefixes / disableGroups 命中即隐藏。 */
function bottomRule(cfg, toolName) {
  if (cfg.deny.includes(toolName)) return 'deny'
  for (const prefix of cfg.denyPrefixes) {
    if (toolName.startsWith(prefix)) return `prefix:${prefix}`
  }
  for (const groupId of cfg.disableGroups) {
    const group = cfg.groups.get(groupId)
    if (group === undefined) continue
    if (group.names.includes(toolName)) return `group:${groupId}`
    if (group.prefix !== undefined && toolName.startsWith(group.prefix)) return `group:${groupId}`
  }
  return undefined
}

function readPresetId(ctx, agent) {
  const presets = ctx.get('agentPresets')
  if (presets === undefined || presets === null) return undefined
  if (typeof presets.composedPreset !== 'function') return undefined
  try {
    const id = presets.composedPreset(agent.ctx)
    return typeof id === 'string' && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * 为一个 Agent 计算并施加掩码。
 * @returns {{ line?: string, remove: (() => void) | null }}
 *   line 是报告文本（可能为 undefined，表示无内容可报）；remove 是该限制的
 *   disposer，未施加掩码时为 null。
 */
function guardAgent(ctx, cfg, agent) {
  const tools = ctx.tools
  if (tools === undefined || tools === null) throw new Error('工具注册表服务不可用')

  const presetId = readPresetId(ctx, agent)
  const restrictable = restrictableNames(tools, agent)
  if (restrictable === null) {
    const line = `preset-tool-guard: 无法取得该作用域的可限制集合（ToolRuntime.view 不可用），本次跳过掩码`
      + ` agent="${agent.id}" preset="${presetId ?? '(未组合)'}"`
    ctx.logger.warn(line)
    return { line, remove: null }
  }

  const bytes = schemaBytes(tools, agent)

  // 一、全局兜底：deny / denyPrefixes / disableGroups。对所有 Agent 生效，包括没有
  //     组合 preset 的（skipUncomposed 只关掉白名单，不关兜底规则）。
  const bottom = new Map()
  for (const toolName of restrictable) {
    const rule = bottomRule(cfg, toolName)
    if (rule !== undefined) bottom.set(toolName, rule)
  }

  // 二、preset 白名单：命中的 preset 只保留列出的继承工具。
  const declared = presetId !== undefined ? cfg.allowlists.get(presetId) : undefined
  const isAllowlist = declared !== undefined
  const allow = []
  const unknown = []
  if (isAllowlist) {
    for (const toolName of declared) {
      if (toolName === RESERVED_TOOL) continue
      if (restrictable.has(toolName)) allow.push(toolName)
      else unknown.push(toolName)
    }
    if (allow.length === 0) {
      const line = `preset-tool-guard: preset "${presetId}" 的白名单与该作用域可限制工具没有交集，放弃本次掩码（避免把工具面清空）`
      ctx.logger.warn(line)
      return { line, remove: null }
    }
  }

  const hidden = new Set()
  if (isAllowlist) {
    const allowed = new Set(allow)
    for (const toolName of restrictable) if (!allowed.has(toolName)) hidden.add(toolName)
  }
  for (const toolName of bottom.keys()) hidden.add(toolName)

  const hiddenBytes = [...hidden].reduce((sum, toolName) => sum + (bytes.get(toolName) ?? 0), 0)
  let totalBytes = 0
  for (const size of bytes.values()) totalBytes += size
  const percent = totalBytes > 0 ? (hiddenBytes / totalBytes) * 100 : 0
  const tokens = Math.round(hiddenBytes / BYTES_PER_TOKEN)

  const label = presetId ?? '(未组合)'
  const ruleCounts = new Map()
  for (const rule of bottom.values()) ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + 1)
  const ruleText = ruleCounts.size > 0
    ? ` [${[...ruleCounts].map(([rule, count]) => `${rule}=${count}`).join(', ')}]`
    : ''

  const visible = visibleNames(tools, agent)
  const ownLayerNames = unknown.filter((toolName) => visible.has(toolName))
  const absentNames = unknown.filter((toolName) => !visible.has(toolName))
  const driftText = unknown.length > 0
    ? `；白名单里 ${unknown.length} 个名字此刻不可掩码`
      + (ownLayerNames.length > 0 ? `：${ownLayerNames.length} 个属 agent 自身层（恒可见）[${ownLayerNames.join(', ')}]` : '')
      + (absentNames.length > 0 ? `${ownLayerNames.length > 0 ? '；' : '：'}${absentNames.length} 个当前未注册（插件未连接或已改名）[${absentNames.join(', ')}]` : '')
    : ''
  const verb = cfg.dryRun ? 'would exclude' : 'excluded'
  const line = `preset-tool-guard: ${verb} ${hidden.size}/${restrictable.size} inherited names`
    + ` (${hiddenBytes} of ${totalBytes} utf8 schema bytes, ${percent.toFixed(1)}%, ~${tokens} tokens)`
    + ` agent="${agent.id}" preset="${label}" mode=${isAllowlist ? 'allowlist' : 'bottom'}${ruleText}${driftText}`

  if (cfg.dryRun) return { line, remove: null }

  // 没有任何要施加的内容：allowlist 与兜底规则都为空时才跳过。
  // 注意：allowlist 命中时**即使当前没有可排除的名字，也要安装掩码**——`allow` 是
  // 注册时快照，只有装上了，之后注册到继承层的新工具才会被持续排除（fail-closed）。
  if (!isAllowlist && bottom.size === 0) {
    return {
      line: cfg.report
        ? `preset-tool-guard: preset="${label}" 无需掩码（可见 ${restrictable.size} 个可限制名字）agent="${agent.id}"`
        : undefined,
      remove: null,
    }
  }

  const filter = isAllowlist
    ? { allow, ...(bottom.size > 0 ? { deny: [...bottom.keys()] } : {}) }
    : { deny: [...bottom.keys()] }
  // 必须在 Agent 自己的作用域上调用：restrict 用 scopeOf(ctx) 判定作用域。
  const disposer = agent.ctx.tools.restrict(filter)
  return { line, remove: typeof disposer === 'function' ? disposer : null }
}

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const covered = [...cfg.allowlists.keys()]
  const report = makeReporter(ctx, cfg.reportFile)
  const banner = `preset-tool-guard: 已加载 dryRun=${cfg.dryRun} report=${cfg.report}`
    + ` 白名单覆盖 preset=[${covered.join(', ')}]`
    + ` 兜底 deny=${cfg.deny.length} denyPrefixes=${cfg.denyPrefixes.length} disableGroups=[${cfg.disableGroups.join(', ')}]`
    + ` 报告文件=${cfg.reportFile ?? '(关闭)'}`
  ctx.logger.info(banner)
  report(banner)

  /** agentId -> 该 Agent 当前限制的 disposer。 */
  const applied = new Map()

  const release = (agentId) => {
    const disposer = applied.get(agentId)
    if (disposer === undefined) return
    applied.delete(agentId)
    try {
      disposer()
    } catch (error) {
      ctx.logger.warn(`preset-tool-guard: 撤销 agent "${agentId}" 的旧掩码失败：${String(error)}`)
    }
  }

  /** 先撤销旧限制再施加（restrictions 取交集，不撤旧就无法放宽）。 */
  const applyFor = (agent) => {
    release(agent.id)
    const { line, remove } = guardAgent(ctx, cfg, agent)
    if (remove !== null) applied.set(agent.id, remove)
    return line
  }

  const announce = (line) => {
    if (line === undefined || !cfg.report) return
    ctx.logger.info(line)
    report(line)
  }

  // 插件卸载时撤销所有仍存活的掩码，避免"插件没了、掩码还在"。
  ctx.effect(() => () => {
    for (const agentId of [...applied.keys()]) release(agentId)
  })

  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    try {
      announce(applyFor(agent))
    } catch (error) {
      // 绝不让掩码失败影响 Agent 创建。
      const line = `preset-tool-guard: agent "${agent.id}" 的掩码失败，已跳过：${String(error)}`
      ctx.logger.warn(line)
      report(line)
    }
  })

  // 空白会话切换 preset：上游 recompose 只做 bind/rebind、不重发 agent/created，
  // 这里按事件重新施加，否则会继续沿用旧 preset 的掩码。
  ctx.on('agent-preset/selected', (sessionId) => {
    try {
      const agents = ctx.get('agents')
      const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
      if (agent === undefined || agent === null) return
      announce(applyFor(agent))
    } catch (error) {
      ctx.logger.warn(`preset-tool-guard: 切换 preset 后重新施加掩码失败（${String(sessionId)}）：${String(error)}`)
    }
  })

  // Agent 消失时显式释放（作用域销毁本身也会回收）。
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    release(agent.id)
  })
}
