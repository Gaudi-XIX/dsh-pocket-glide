// Agent-preset cache + settings.describe routing (0.4.45, session-settings lag).
//
// The settings panel opens with `Promise.all([session.models, agentPreset.list])`,
// so the panel waits on whichever leg is slower. The catalogue gained a 30 s cache
// in 0.4.43; the preset leg and the settings/describe read were still paying a
// tunnel round trip on every open (settings.describe on every list refresh).
//
// What must stay true:
//   1. a second agentPreset.list inside the TTL is served from cache — one host call;
//   2. the TTL expires, so a desktop-side preset edit is picked up;
//   3. a preset selection invalidates the cache;
//   4. settings.describe rides the existing 5 s cachedSettings cache;
//   5. the preset cache is declared next to its siblings and reset on stop().
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LanMobileBridge } from '../lib/bridge.js'

const bridgeSource = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
const AGENT_PRESETS_TTL_MS = 30_000

function makeBridge({ calls = [], now = () => Date.now() } = {}) {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = []
  bridge.log = () => {}
  bridge.locale = () => 'zh'
  bridge.now = now
  bridge.pendingQuestions = new Map()
  bridge.workspaceSnapshot = { items: [] }
  bridge.noteSavings = () => {}
  bridge._calls = calls
  bridge.invokeHarness = async (endpoint) => {
    calls.push(endpoint)
    return { ok: true, value: { presets: [], namespaces: [] } }
  }
  return bridge
}

test('a second agentPreset.list inside the TTL is served from cache', async () => {
  const calls = []
  const bridge = makeBridge({ calls })
  const first = await bridge.forwardRpc('agentPreset.list', {})
  const second = await bridge.forwardRpc('agentPreset.list', {})
  assert.equal(calls.filter((endpoint) => endpoint === 'agentPresets/list').length, 1,
    'the panel opens once, the preset leg rides the cache')
  assert.equal(first.ok, true)
  assert.deepEqual(second, first, 'the cached answer is the same object the caller may hold')
})

test('the preset TTL expires: an older list is re-read', async () => {
  const calls = []
  let clock = 1_000_000
  const bridge = makeBridge({ calls, now: () => clock })
  await bridge.forwardRpc('agentPreset.list', {})
  clock += AGENT_PRESETS_TTL_MS - 1
  await bridge.forwardRpc('agentPreset.list', {})
  assert.equal(calls.filter((endpoint) => endpoint === 'agentPresets/list').length, 1, 'inside the window the host is not asked again')
  clock += 2
  await bridge.forwardRpc('agentPreset.list', {})
  assert.equal(calls.filter((endpoint) => endpoint === 'agentPresets/list').length, 2, 'past the window the host is asked again')
})

test('a preset selection drops the cached list', async () => {
  const calls = []
  const bridge = makeBridge({ calls })
  await bridge.forwardRpc('agentPreset.list', {})
  const before = calls.filter((endpoint) => endpoint === 'agentPresets/list').length
  await bridge.forwardRpc('agentPreset.select', { sessionId: 's1', agentPreset: 'p2' })
  await bridge.forwardRpc('agentPreset.list', {})
  assert.equal(calls.filter((endpoint) => endpoint === 'agentPresets/list').length, before + 1,
    'the switch invalidates rather than writing through')
})

test('settings.describe rides the 5s cachedSettings cache', async () => {
  const calls = []
  const bridge = makeBridge({ calls })
  await bridge.forwardRpc('settings.describe', {})
  await bridge.forwardRpc('settings.describe', {})
  assert.equal(calls.filter((endpoint) => endpoint === 'settings/describe').length, 1,
    'list refreshes stop paying the host on every pass')
})

test('the preset cache is declared next to its siblings and reset on stop', () => {
  assert.ok(bridgeSource.includes('_agentPresetsCache'), 'the field is documented next to its siblings')
  assert.ok(bridgeSource.includes('AGENT_PRESETS_TTL_MS'), 'the TTL is a named constant, not an inline literal')
  assert.match(bridgeSource, /this\._agentPresetsCache = undefined/, 'a bridge restart must not inherit the old preset list')
})
