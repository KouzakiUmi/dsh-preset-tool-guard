// 校验 dsh-preset-tool-guard 的 profile 补丁：YAML 能否解析、preset 声明与白名单结构是否
// 正常、白名单里的名字能否在当前工具清单里命中。
//
// 用法：
//   node check-patch.cjs [profile 目录] [工具清单 JSON] [--strict]
//
//   profile 目录   默认 $DSH_HOME/profiles/desktop（DSH_HOME 缺省 ~/.dsh）；相对路径按 cwd 解析
//   工具清单 JSON  默认 $DSH_HOME/tmp-guard-tools.json（不存在则跳过名字比对）
//   --strict       把"白名单里有名字不在工具清单里"也算作失败（默认只警告）
//
// 工具清单接受两种形状，可直接用 cordis_inspect_query 的结果：
//   - { "tools": [ { "name": "read", ... }, ... ] }   ← host / Tool / listTools 原样导出
//   - [ "read", "write", ... ]                        ← 已经映射成名字数组
//
// 退出码：0 = 通过；1 = 解析失败、结构不合格、清单形状无法识别，或 --strict 下有缺名。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const positional = argv.filter((value) => value !== '--strict');

const problems = [];
const warnings = [];
const fail = (message) => problems.push(message);
const warn = (message) => warnings.push(message);

const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh');

const profileDir = path.resolve(positional[0] ?? path.join(dshHome, 'profiles', 'desktop'));
const toolsPath = path.resolve(positional[1] ?? path.join(dshHome, 'tmp-guard-tools.json'));

let yaml;
try {
  yaml = require(path.join(profileDir, 'node_modules', 'js-yaml'));
} catch (error) {
  console.error(`无法从 ${profileDir}\\node_modules 加载 js-yaml：${error.message}`);
  process.exit(1);
}

const jsType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __jsExpr: data }),
});

const target = path.join(profileDir, 'cordis.patch.yml');
if (!fs.existsSync(target)) {
  console.error(`找不到补丁文件：${target}`);
  process.exit(1);
}

let doc;
try {
  doc = yaml.load(fs.readFileSync(target, 'utf8'), { schema: yaml.DEFAULT_SCHEMA.extend([jsType]) });
} catch (error) {
  console.error('YAML 解析失败：', error.message);
  process.exit(1);
}
if (!Array.isArray(doc)) {
  console.error(`顶层不是数组（是 ${typeof doc}），无法作为 Loader 补丁`);
  process.exit(1);
}
console.log(`patch rows: ${doc.length}（${target}）`);

const flat = [];
for (const row of doc) {
  if (row && Array.isArray(row.insert)) flat.push(...row.insert);
  else if (row && row.id) flat.push(row);
}

const presets = flat.filter((row) => row && row.config && typeof row.config.id === 'string' && Array.isArray(row.config.plugins));
for (const preset of presets) {
  const ids = preset.config.plugins.map((plugin) => (plugin && plugin.id) || '?');
  console.log(`preset "${preset.config.id}"（${preset.config.name ?? '-'}，order=${preset.config.order ?? '-'}）plugins=${ids.length}: ${ids.join(', ')}`);
}
if (presets.length === 0) fail('补丁里没有任何 preset 声明（缺少带 config.plugins 的条目）');

const guard = flat.find((row) => row && row.id === 'preset-tool-guard');
if (guard === undefined) {
  fail('补丁里没有 preset-tool-guard 配置段');
} else {
  const cfg = guard.config && typeof guard.config === 'object' ? guard.config : {};
  const allowlists = cfg.allowlists && typeof cfg.allowlists === 'object' && !Array.isArray(cfg.allowlists)
    ? cfg.allowlists
    : {};
  const counts = {};
  for (const [preset, list] of Object.entries(allowlists)) {
    counts[preset] = Array.isArray(list) ? list.length : `NOT-ARRAY(${typeof list})`;
    if (!Array.isArray(list)) fail(`allowlists.${preset} 不是数组`);
    else if (list.length === 0) warn(`allowlists.${preset} 是空数组：会作为"显式空白名单"，与可限制集合无交集时插件放弃掩码并告警`);
  }
  console.log('preset-tool-guard ->', JSON.stringify({
    allowlistCounts: counts,
    dryRun: cfg.dryRun,
    report: cfg.report,
    reportFile: cfg.reportFile,
    deny: cfg.deny,
    denyPrefixes: cfg.denyPrefixes,
    disableGroups: cfg.disableGroups,
  }));
  if ('dryRun' in cfg && cfg.dryRun !== true && cfg.dryRun !== false) fail('dryRun 不是布尔值');

  if (fs.existsSync(toolsPath)) {
    let known = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(toolsPath, 'utf8'));
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        known = new Set(parsed);
      } else if (parsed && Array.isArray(parsed.tools)) {
        const names = parsed.tools.map((tool) => tool && tool.name).filter((name) => typeof name === 'string');
        if (names.length === 0) fail('清单里的 tools 数组没有任何带 name 的条目');
        else known = new Set(names);
      } else {
        fail(`无法识别工具清单形状（${toolsPath}）：既不是字符串数组，也没有 tools 数组`);
      }
    } catch (error) {
      fail(`工具清单不是合法 JSON（${toolsPath}）：${error.message}`);
    }

    if (known !== null) {
      console.log(`工具清单：${known.size} 个名字（${toolsPath}）`);
      for (const [preset, list] of Object.entries(allowlists)) {
        if (!Array.isArray(list)) continue;
        const missing = list.filter((name) => !known.has(name));
        if (missing.length === 0) {
          console.log(`allowlists.${preset}: ${list.length} 个名字全部命中`);
        } else {
          const text = `allowlists.${preset} 有 ${missing.length} 个名字不在工具清单里：${missing.join(', ')}`;
          if (strict) fail(text);
          else warn(`${text}（该名字可能属于其他平台或当前未挂载；确认后可从白名单移除，或用 --strict 让它变成失败）`);
        }
      }
    }
  } else {
    console.log(`未找到工具清单（${toolsPath}），跳过名字比对`);
  }
}

for (const message of warnings) console.warn(`warn: ${message}`)
if (problems.length > 0) {
  console.error('\n发现问题：');
  for (const message of problems) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(strict ? '\nOK：结构、名字检查通过（strict）' : '\nOK：结构与名字比对通过')
