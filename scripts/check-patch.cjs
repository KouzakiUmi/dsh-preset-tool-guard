// 校验 dsh-preset-tool-guard 的 profile 补丁：YAML 能解析、preset 声明与白名单结构正确、
// 白名单里的名字都能在"当前工具清单"里命中。
//
// 用法：
//   node check-patch.cjs [profile 目录] [工具清单 JSON]
//   默认 profile 目录 = ~/.dsh/profiles/desktop
//   默认工具清单   = <profile 目录>/../..//tmp-guard-tools.json（存在才比对）
//
// 工具清单可用 cordis_inspect_query 的 host/Tool listTools 结果导出为 JSON 数组。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profileDir = process.argv[2] ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const toolsPath = process.argv[3];

const yaml = require(path.join(profileDir, 'node_modules', 'js-yaml'));

const jsType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __jsExpr: data }),
});

const target = path.join(profileDir, 'cordis.patch.yml');
const text = fs.readFileSync(target, 'utf8');

let doc;
try {
  doc = yaml.load(text, { schema: yaml.DEFAULT_SCHEMA.extend([jsType]) });
} catch (error) {
  console.error('YAML PARSE FAILED:', error.message);
  process.exit(1);
}

if (!Array.isArray(doc)) {
  console.error('TOP LEVEL NOT AN ARRAY:', typeof doc);
  process.exit(1);
}
console.log('patch rows:', doc.length);

const flat = [];
for (const row of doc) {
  if (row && Array.isArray(row.insert)) flat.push(...row.insert);
  else if (row && row.id) flat.push(row);
}

const full = flat.find((r) => r && r.id === 'preset-full');
const guard = flat.find((r) => r && r.id === 'preset-tool-guard');

if (full) {
  const cfg = full.config ?? {};
  const ids = Array.isArray(cfg.plugins) ? cfg.plugins.map((p) => p && p.id) : null;
  console.log('preset-full ->', JSON.stringify({ id: cfg.id, name: cfg.name, order: cfg.order, plugins: ids }));
} else {
  console.log('preset-full: NOT FOUND');
}

if (guard) {
  const cfg = guard.config ?? {};
  const counts = {};
  for (const [preset, list] of Object.entries(cfg.allowlists ?? {})) {
    counts[preset] = Array.isArray(list) ? list.length : `NOT-ARRAY(${typeof list})`;
  }
  console.log('preset-tool-guard ->', JSON.stringify({
    allowlistCounts: counts,
    dryRun: cfg.dryRun,
    report: cfg.report,
    reportFile: cfg.reportFile,
    groups: cfg.groups,
    deny: cfg.deny,
    denyPrefixes: cfg.denyPrefixes,
    disableGroups: cfg.disableGroups,
  }));
} else {
  console.log('preset-tool-guard: NOT FOUND');
}

const knownFile = toolsPath ?? path.join(os.homedir(), '.dsh', 'tmp-guard-tools.json');
if (guard && fs.existsSync(knownFile)) {
  const known = new Set(JSON.parse(fs.readFileSync(knownFile, 'utf8')));
  for (const [preset, list] of Object.entries(guard.config.allowlists ?? {})) {
    const missing = list.filter((n) => !known.has(n));
    console.log(`allowlists.${preset}: ${list.length} 个名字，不在工具清单里的：${missing.length ? missing.join(', ') : '(无)'}`);
  }
}
