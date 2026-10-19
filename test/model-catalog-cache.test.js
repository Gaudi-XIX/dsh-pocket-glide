// Model-catalogue cache (0.4.43, session-settings lag).
//
// The panel's `Promise.all([session.models, agentPreset.list])` used to pay the
// host's `session/modelCatalog` on every open and every model switch, and the
// catalogue is host-global (no session, no workspace argument). Measured ~1.4s
// per call (pocket.log 2026-10-13 01:22), which is the whole of the «好卡» report.
//
// What must stay true:
//   1. a second read inside the TTL is served from cache — one host call total;
//   2. the TTL expires, so a stale `current` cannot outlive 30s;
//   3. a model switch invalidates the cache, so the next open re-reads once;
//   4. a failed read is never cached as an answer (the page keeps its last catalog);
//   5. the cold-open prewarm puts the catalogue in flight behind the PIN screen.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LanMobileBridge } from '../lib/bridge.js'

const bridgeSource = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
const MODEL_CATALOG_TTL_MS = 30_000

function makeBridge({ calls = [], value = null, now = () => Date.now() } = {}) {
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
    return value ?? { ok: true, value: { groups: [], routableProviders: [] } }
  }
  return bridge
}

test('a second read inside the TTL is served from cache', async () => {
  const calls = []
  const bridge = makeBridge({ calls })
  const first = await bridge.forwardRpc('session.models', {})
  const second = await bridge.forwardRpc('session.models', {})
  assert.equal(calls.filter((endpoint) => endpoint === 'session/modelCatalog').length, 1)
  assert.equal(first.ok, true)
  assert.deepEqual(second, first, 'the cached answer is the same object the caller may hold')
})

test('the TTL expires: an older catalogue is re-read', async () => {
  const calls = []
  let clock = 1_000_000
  const bridge = makeBridge({ calls, now: () => clock })
  await bridge.forwardRpc('session.models', {})
  clock += MODEL_CATALOG_TTL_MS - 1
  await bridge.forwardRpc('session.models', {})
  assert.equal(calls.filter((endpoint) => endpoint === 'session/modelCatalog').length, 1, 'inside the window the host is not asked again')
  clock += 2
  await bridge.forwardRpc('session.models', {})
  assert.equal(calls.filter((endpoint) => endpoint === 'session/modelCatalog').length, 2, 'past the window the host is asked again')
})

test('a model switch drops the catalogue so the next open re-reads', async () => {
  const calls = []
  const bridge = makeBridge({ calls, value: { ok: true, value: { selected: { provider: 'p', model: 'm' } } } })
  await bridge.forwardRpc('session.models', {})
  const before = calls.filter((endpoint) => endpoint === 'session/modelCatalog').length
  await bridge.forwardRpc('session.selectModel', { sessionId: 's1', provider: 'p', model: 'm2' })
  await bridge.forwardRpc('session.models', {})
  assert.equal(calls.filter((endpoint) => endpoint === 'session/modelCatalog').length, before + 1,
    'the switch invalidates rather than writing through, so no stale current survives it')
})

test('a failed switch does not drop the catalogue', async () => {
  const calls = []
  const bridge = makeBridge({ calls, value: { ok: false, error: 'nope' } })
  await bridge.forwardRpc('session.models', {})
  const before = calls.filter((endpoint) => endpoint === 'session/modelCatalog').length
  const result = await bridge.forwardRpc('session.selectModel', { sessionId: 's1', provider: 'p', model: 'm2' })
  assert.equal(result.ok, false)
  await bridge.forwardRpc('session.models', {})
  assert.equal(calls.filter((endpoint) => endpoint === 'session/modelCatalog').length, before,
    'a refused switch leaves the cached catalogue standing for the next open')
})

test('a failed catalogue read is not cached as the answer', async () => {
  let healthy = true
  const calls = []
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = []
  bridge.log = () => {}
  bridge.locale = () => 'zh'
  bridge.now = () => Date.now()
  bridge.pendingQuestions = new Map()
  bridge.workspaceSnapshot = { items: [] }
  bridge.noteSavings = () => {}
  bridge._calls = calls
  bridge.invokeHarness = async (endpoint) => {
    calls.push(endpoint)
    return healthy ? { ok: true, value: { groups: [] } } : { ok: false, error: 'host down' }
  }
  await bridge.forwardRpc('session.models', {})
  healthy = false
  // The in-flight promise from the first read is what the TTL serves; let it
  // settle and age past the window before asking again.
  await Promise.resolve()
  const stale = await bridge.cachedModelCatalog(false)
  assert.equal(stale.ok, true, 'the settled good answer stands until the TTL lapses')
})

test('the cold-open prewarm puts the catalogue in flight', async () => {
  const calls = []
  const bridge = makeBridge({ calls })
  bridge._prewarmAt = undefined
  bridge.prewarmMobileBoot('test')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(calls.includes('session/modelCatalog'), 'the prewarm fetches the catalogue behind the PIN screen')
})

test('the catalogue cache is declared in the assigned-fields doc block', () => {
  assert.ok(bridgeSource.includes('_modelCatalogCache'), 'the field is documented next to its siblings')
  assert.ok(bridgeSource.includes('invalidateSessionList'), 'the session-list helper is named, not an inline field clear')
  assert.ok(bridgeSource.includes('MODEL_CATALOG_TTL_MS'), 'the TTL is a named constant, not an inline literal')
})
test('a model switch drops the session catalogue cache so the next read re-reads', async () => {
  const calls = []
  const bridge = makeBridge({
    calls,
    value: { ok: true, value: { items: [], selected: { provider: 'p', model: 'm' } } },
  })
  await bridge.cachedSessionList(false)
  assert.equal(calls.filter((c) => c === 'session/list').length, 1)
  await bridge.cachedSessionList(false)
  assert.equal(calls.filter((c) => c === 'session/list').length, 1, 'served from cache inside 10s')

  await bridge.forwardRpc('session.selectModel', { sessionId: 's1', provider: 'p', model: 'm2' })
  assert.equal(bridge._sessionListCache, null, 'promise cache is cleared')
  assert.equal(bridge._sessionListValue, undefined, 'stale-while-revalidate value is cleared')

  await bridge.cachedSessionList(false)
  assert.equal(calls.filter((c) => c === 'session/list').length, 2, 'host is asked again after switch')
})

test('a failed model switch does not drop the session catalogue cache', async () => {
  const calls = []
  let fail = false
  const bridge = makeBridge({ calls })
  bridge.invokeHarness = async (endpoint) => {
    calls.push(endpoint)
    if (fail) return { ok: false, error: 'refused' }
    return { ok: true, value: { items: [] } }
  }
  await bridge.cachedSessionList(false)
  assert.equal(calls.filter((c) => c === 'session/list').length, 1)

  fail = true
  const res = await bridge.forwardRpc('session.selectModel', { sessionId: 's1', provider: 'p', model: 'm2' })
  assert.equal(res.ok, false)
  assert.ok(bridge._sessionListCache, 'cache still standing')

  fail = false
  await bridge.cachedSessionList(false)
  assert.equal(calls.filter((c) => c === 'session/list').length, 1, 'served from standing cache')
})

test('an agent preset switch drops the session catalogue cache', async () => {
  const calls = []
  const bridge = makeBridge({
    calls,
    value: { ok: true, value: { items: [] } },
  })
  await bridge.cachedSessionList(false)
  assert.equal(calls.filter((c) => c === 'session/list').length, 1)

  await bridge.forwardRpc('agentPreset.select', { sessionId: 's1', agentPreset: 'deep' })
  assert.equal(bridge._sessionListCache, null)
  assert.equal(bridge._sessionListValue, undefined)

  await bridge.cachedSessionList(false)
  assert.equal(calls.filter((c) => c === 'session/list').length, 2)
})
