import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

function host(config, initial = ['safe', 'blocked']) {
  const events = new Map(), effects = [], warnings = [], masks = new Set()
  const inherited = new Set(initial), own = new Set(['own_tool'])
  let preset = 'minimal', calls = 0
  const emit = (name, ...args) => events.get(name)?.(...args)
  const visible = name => own.has(name) || (inherited.has(name)
    && [...masks].every(f => (!f.allow || f.allow.includes(name)) && !f.deny?.includes(name)))
  const agent = { id: 'one', ctx: { tools: { restrict(filter) {
    calls++
    assert.ok(calls < 100, 'tools/change must not recurse')
    for (const name of [...filter.allow ?? [], ...filter.deny ?? []]) {
      assert.ok(inherited.has(name), `unknown inherited name: ${name}`)
    }
    masks.add(filter)
    emit('tools/change')
    return () => { masks.delete(filter); emit('tools/change') }
  } } } }
  const tools = {
    view: () => ({ restrictableNames: new Set(inherited) }),
    schemas: () => [...inherited, ...own].filter(visible).map(name => ({ name })),
  }
  const ctx = { tools, logger: { info() {}, warn: line => warnings.push(line) },
    get: name => name === 'agents' ? { list: () => [agent], get: () => agent }
      : name === 'agentPresets' ? { composedPreset: () => preset } : undefined,
    on: (name, handler) => events.set(name, handler),
    effect: fn => effects.push(fn()),
  }
  apply(ctx, { ...config, reportFile: false })
  return { visible, warnings, masks, emit, agent,
    add(name) { inherited.add(name); emit('tools/change') },
    select(name) { preset = name; emit('agent-preset/selected', agent.id) },
    unload() { for (const fn of effects) fn() },
  }
}

for (const list of [[], ['renamed_tool'], ['own_tool'], ['run_code']]) {
  test(`unusable allowlist ${JSON.stringify(list)} retains bottom rules`, () => {
    const h = host({ allowlists: { minimal: list }, deny: ['blocked'] })
    assert.equal(h.visible('blocked'), false)
    assert.equal(h.visible('safe'), true)
    assert.equal(h.visible('own_tool'), true)
    assert.equal(h.warnings.length, 1)
  })
}

test('late exact, prefix and group denials apply without refreshing allowlist', () => {
  const h = host({ allowlists: { minimal: ['safe', 'later_allowed'] },
    deny: ['later_denied'], denyPrefixes: ['mcp_'],
    groups: { browser: { names: ['browser_exact'], prefix: 'browser_' } }, disableGroups: ['browser'] })
  for (const name of ['later_allowed', 'later_denied', 'mcp_new', 'browser_exact', 'browser_new']) {
    h.add(name)
    assert.equal(h.visible(name), false)
  }
  const count = h.masks.size
  h.emit('tools/change')
  assert.equal(h.masks.size, count)
  h.select('full')
  assert.equal(h.visible('later_allowed'), true)
  assert.equal(h.visible('mcp_new'), false)
  h.unload()
  assert.equal(h.masks.size, 0)
  assert.equal(h.visible('mcp_new'), true)
})

test('bottom-only agent hides late tools even when no initial rule matches', () => {
  const h = host({ denyPrefixes: ['mcp_'] }, ['safe'])
  h.add('mcp_new')
  assert.equal(h.visible('mcp_new'), false)
  assert.equal(h.visible('safe'), true)
  h.emit('agent/disposed', { agent: h.agent })
  assert.equal(h.masks.size, 0)
  h.add('mcp_other')
  assert.equal(h.masks.size, 0)
})

test('dry run never installs a mask, including late tools', () => {
  const h = host({ dryRun: true, denyPrefixes: ['mcp_'] })
  h.add('mcp_new')
  assert.equal(h.visible('mcp_new'), true)
  assert.equal(h.masks.size, 0)
})

test('empty allowlist retains late bottom-rule monitoring', () => {
  const h = host({ allowlists: { minimal: [] }, denyPrefixes: ['mcp_'] })
  h.add('mcp_new')
  assert.equal(h.visible('mcp_new'), false)
})
