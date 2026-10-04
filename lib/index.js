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
 *   - filter 在注册时快照，之后不再随注册表变化；
 *   - filter 里的名字若不在该作用域"可限制集合"内会抛错，因此这里一律先探测
 *     再构造，缺名只跳过并记入报告，绝不因为一个改名就让 Agent 创建失败；
 *   - 保留名 `run_code`（PTC 呈现通道）既不能被掩码，也不能出现在 filter 里；
 *   - 掩码只作用于"继承面"（global + 祖先作用域），不作用于该 Agent 自己注册的层，
 *     所以子代理的回报工具等不会被误伤。
 *
 * 报告：每个 Agent 一行，同时走宿主 logger 与（默认开启的）报告文件，便于在没有
 * 实时日志通道时核对口径。见 README。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** PTC 呈现通道的保留名：不能出现在 filter 里，也不会被掩码。 */
const RESERVED_TOOL = 'run_code'

/** 粗估 token 用量时每 token 折合的 schema 字节数（量级口径）。 */
const BYTES_PER_TOKEN = 3.6

export const name = 'preset-tool-guard'

/** 只强依赖工具注册表；preset 身份经可选的 agentPresets 服务读取。 */
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

/** 默认报告文件：$DSH_HOME/logs/preset-tool-guard.log（DSH_HOME 缺省为 ~/.dsh）。 */
export function defaultReportFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'logs', 'preset-tool-guard.log')
}

/**
 * 解析报告文件设置：未提供 -> 默认路径；false / 空串 -> 关闭文件报告。
 * @returns 绝对路径，或 undefined 表示不写文件。
 */
export function resolveReportFile(value) {
  if (value === false || value === '') return undefined
  if (typeof value === 'string') return value
  return defaultReportFile()
}

/** 把 profile 传入的原始 config 规范化为内部结构（非法字段忽略，不抛错）。 */
export function normalizeConfig(raw) {
  const cfg = raw !== null && typeof raw === 'object' ? raw : {}
  const allowlists = new Map()
  if (cfg.allowlists !== null && typeof cfg.allowlists === 'object') {
    for (const [preset, list] of Object.entries(cfg.allowlists)) {
      const names = asNames(list)
      if (names.length > 0) allowlists.set(preset, names)
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

/** 该 Agent 作用域里"可被限制"的工具名集合。 */
function restrictableNames(tools, agent) {
  if (typeof tools.view === 'function') {
    try {
      const view = tools.view(agent)
      if (view !== null && typeof view === 'object' && view.restrictableNames instanceof Set) {
        return view.restrictableNames
      }
    } catch {
      // 视图探测不可用时退回 schema 投影。
    }
  }
  try {
    return new Set(tools.schemas(agent).map((schema) => schema.name))
  } catch {
    return new Set()
  }
}

/** 每个可见工具的 schema 字节数，用于量化省下的请求前缀。 */
function schemaBytes(tools, agent) {
  const bytes = new Map()
  try {
    for (const schema of tools.schemas(agent)) {
      try {
        bytes.set(schema.name, JSON.stringify(schema).length)
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
 * @returns 一行报告文本，或 undefined（无事可做 / 已跳过）。
 */
function guardAgent(ctx, cfg, agent) {
  const tools = ctx.tools
  if (tools === undefined || tools === null) throw new Error('工具注册表服务不可用')

  const presetId = readPresetId(ctx, agent)
  if (presetId === undefined && cfg.skipUncomposed) return undefined

  const restrictable = restrictableNames(tools, agent)
  if (restrictable.size === 0) return undefined

  const bytes = schemaBytes(tools, agent)

  // 一、全局兜底：所有 Agent 一律隐藏的组 / 名字。
  const bottom = new Map()
  for (const toolName of restrictable) {
    const rule = bottomRule(cfg, toolName)
    if (rule !== undefined) bottom.set(toolName, rule)
  }

  // 二、preset 白名单：命中即"只保留列出的"，其余继承来的工具全部掩掉。
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
      ctx.logger.warn(
        `preset-tool-guard: preset "${presetId}" 的白名单与该作用域可限制工具没有交集，本次已放弃掩码（避免把工具面清空）`,
      )
      return undefined
    }
  }

  const hidden = new Set()
  if (isAllowlist) {
    const allowed = new Set(allow)
    for (const toolName of restrictable) if (!allowed.has(toolName)) hidden.add(toolName)
  } else {
    for (const toolName of bottom.keys()) hidden.add(toolName)
  }

  const hiddenBytes = [...hidden].reduce((sum, toolName) => sum + (bytes.get(toolName) ?? 0), 0)
  let totalBytes = 0
  for (const size of bytes.values()) totalBytes += size
  const percent = totalBytes > 0 ? (hiddenBytes / totalBytes) * 100 : 0
  const tokens = Math.round(hiddenBytes / BYTES_PER_TOKEN)

  const label = presetId ?? '(未组合)'
  if (hidden.size === 0) {
    return cfg.report
      ? `preset-tool-guard: preset="${label}" 无需掩码（可见 ${restrictable.size} 个工具，${totalBytes} bytes）agent="${agent.id}"`
      : undefined
  }

  const ruleCounts = new Map()
  for (const rule of bottom.values()) ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + 1)
  const ruleText = ruleCounts.size > 0
    ? ` [${[...ruleCounts].map(([rule, count]) => `${rule}=${count}`).join(', ')}]`
    : ''
  let visibleAll = new Set()
  try { visibleAll = new Set(tools.schemas(agent).map((schema) => schema.name)) } catch { /* 投影不可用时不做区分 */ }
  const ownLayerNames = unknown.filter((toolName) => visibleAll.has(toolName))
  const absentNames = unknown.filter((toolName) => !visibleAll.has(toolName))
  const driftText = unknown.length > 0
    ? `；白名单里 ${unknown.length} 个名字此刻不可掩码`
      + (ownLayerNames.length > 0 ? `：${ownLayerNames.length} 个属 agent 自身层（恒可见）[${ownLayerNames.join(', ')}]` : '')
      + (absentNames.length > 0 ? `${ownLayerNames.length > 0 ? '；' : '：'}${absentNames.length} 个当前未注册（插件未连接或已改名）[${absentNames.join(', ')}]` : '')
    : ''
  const verb = cfg.dryRun ? 'would hide' : 'hid'
  const line = `preset-tool-guard: ${verb} ${hidden.size}/${restrictable.size} tools`
    + ` (${hiddenBytes} of ${totalBytes} schema bytes, ${percent.toFixed(1)}%, ~${tokens} tokens)`
    + ` agent="${agent.id}" preset="${label}" mode=${isAllowlist ? 'allowlist' : 'bottom'}${ruleText}${driftText}`

  if (cfg.dryRun) return line

  const filter = isAllowlist
    ? { allow, ...(bottom.size > 0 ? { deny: [...bottom.keys()] } : {}) }
    : { deny: [...bottom.keys()] }
  // 必须在 Agent 自己的作用域上调用：restrict 用 scopeOf(ctx) 判定作用域。
  agent.ctx.tools.restrict(filter)
  return line
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

  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    try {
      const line = guardAgent(ctx, cfg, agent)
      if (line !== undefined && cfg.report) {
        ctx.logger.info(line)
        report(line)
      }
    } catch (error) {
      // 绝不让掩码失败影响 Agent 创建。
      const line = `preset-tool-guard: agent "${agent.id}" 的掩码失败，已跳过：${String(error)}`
      ctx.logger.warn(line)
      report(line)
    }
  })
}
