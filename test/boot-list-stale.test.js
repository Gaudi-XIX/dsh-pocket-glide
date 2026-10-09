// Cold-open session-catalogue staleness (2026-10-09).
//
// The document used to await one Host RPC that returns EVERY session of EVERY
// workspace (~589ms measured, 469 rows / ~195 KB) while the boot keeps a single
// row plus the total. `session/list` accepts no filter and no limit, so the only
// way to stop paying for it on every open is to answer from the last good
// catalogue and re-fetch behind the response.
//
// What must stay true while that happens:
//   1. the stale stand-in only ever serves the cold-open document (staleOk);
//   2. it expires — an absent reader waits for the truth;
//   3. a failed read never becomes a stand-in;
//   4. serving stale still kicks the refresh, so the next reader is not stale;
//   5. a forced read ignores the stand-in entirely (fresh-session lookup path).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LanMobileBridge } from '../lib/bridge.js'

const bridgeSource = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
const STALE_MAX_MS = 120000

function makeBridge({ calls = [], value = null } = {}) {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = []
  bridge.log = () => {}
  bridge.locale = () => 'zh'
  bridge.now = () => Date.now()
  bridge.pendingQuestions = new Map()
  bridge.workspaceSnapshot = { items: [] }
  bridge.cachedSettings = async () => ({ ok: true, value: {} })
  bridge.noteSavings = () => {}
  bridge._calls = calls
  bridge.invokeHarness = async (endpoint) => {
    calls.push(endpoint)
    return value ?? { ok: true, value: { items: [{ sessionId: 'fresh', updatedAt: 5 }] } }
  }
  return bridge
}

const catalogue = (items, at = Date.now()) => ({ at, result: { ok: true, value: { items } } })

test('the first cold open waits: there is nothing to stand in yet', async () => {
  const calls = []
  const bridge = makeBridge({ calls })
  const result = await bridge.cachedSessionList(false, { staleOk: true })
  assert.equal(calls.length, 1, 'the host was asked exactly once')
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.items.map((i) => i.sessionId), ['fresh'])
})

test('an open past the 10s window answers from the last good catalogue and refreshes behind it', async () => {
  const calls = []
  const bridge = makeBridge({ calls })
  bridge._sessionListValue = catalogue([{ sessionId: 'yesterday', updatedAt: 1 }])
  const t0 = Date.now()
  const result = await bridge.cachedSessionList(false, { staleOk: true })
  assert.ok(Date.now() - t0 < 50, 'the stale answer is immediate, it did not await the host')
  assert.deepEqual(result.value.items.map((i) => i.sessionId), ['yesterday'], 'the stand-in is what got served')
  assert.equal(calls.length, 1, 'and the refresh still went out')
  await bridge._sessionListCache.promise
  assert.deepEqual(bridge._sessionListValue.result.value.items.map((i) => i.sessionId), ['fresh'],
    'the background read replaced the stand-in for the next reader')
})

test('the stale stand-in is offered to the cold-open document only', async () => {
  const calls = []
  const bridge = makeBridge({ calls })
  bridge._sessionListValue = catalogue([{ sessionId: 'yesterday', updatedAt: 1 }])
  const result = await bridge.cachedSessionList(false)
  assert.deepEqual(result.value.items.map((i) => i.sessionId), ['fresh'],
    'the list view and every other reader wait for the truth — never a stale row list')
  assert.equal(calls.length, 1)
})

test('a stand-in older than the window is refused: an absent reader gets the truth', async () => {
  const calls = []
  const bridge = makeBridge({ calls })
  bridge._sessionListValue = catalogue([{ sessionId: 'long-ago', updatedAt: 1 }], Date.now() - STALE_MAX_MS - 1000)
  assert.equal(bridge.sessionListStaleUsable(Date.now()), false, 'the window is closed')
  const result = await bridge.cachedSessionList(false, { staleOk: true })
  assert.deepEqual(result.value.items.map((i) => i.sessionId), ['fresh'], 'waited for the host')
  assert.equal(calls.length, 1)
  // the boundary itself stays open
  bridge._sessionListValue = catalogue([{ sessionId: 'edge', updatedAt: 1 }], Date.now() - STALE_MAX_MS + 2000)
  assert.equal(bridge.sessionListStaleUsable(Date.now()), true)
})

test('a failed read never becomes a stand-in', async () => {
  const calls = []
  const bridge = makeBridge({ calls, value: { ok: false, error: 'host down' } })
  const first = await bridge.cachedSessionList(false, { staleOk: true })
  assert.equal(first.ok, false)
  assert.equal(bridge._sessionListValue, undefined, 'a failed catalogue is not remembered')
  assert.equal(bridge.sessionListStaleUsable(Date.now()), false)
})

test('a good stand-in survives a later failed read', async () => {
  const calls = []
  const bridge = makeBridge({ calls })
  bridge._sessionListValue = catalogue([{ sessionId: 'good', updatedAt: 1 }])
  bridge.invokeHarness = async () => ({ ok: false, error: 'host down' })
  const result = await bridge.cachedSessionList(false, { staleOk: true })
  assert.deepEqual(result.value.items.map((i) => i.sessionId), ['good'], 'the document still opens')
  await bridge._sessionListCache.promise
  assert.equal(bridge._sessionListValue.result.value.items[0].sessionId, 'good',
    'and the failure did not overwrite what worked')
})

test('a forced read ignores the stand-in, the way the missing-session lookup needs', async () => {
  const calls = []
  const bridge = makeBridge({ calls })
  bridge._sessionListValue = catalogue([{ sessionId: 'stale', updatedAt: 1 }])
  const result = await bridge.cachedSessionList(true)
  assert.deepEqual(result.value.items.map((i) => i.sessionId), ['fresh'],
    'force means force: a freshly created session must be findable')
})

test('the boot path is the caller that asked for staleness', () => {
  // Source-level guard: exactly one call site opts in, and it is the document
  // build. If someone opts the list view in too, the reader would scroll stale rows.
  const opted = bridgeSource.split('\n').filter((line) => line.includes('staleOk: true'))
  assert.equal(opted.length, 1, 'one and only one caller may serve stale')
  assert.match(opted[0], /cachedSessionList\(false, \{ staleOk: true \}\)/)
  assert.match(opted[0], /this\.cachedSessionList/, 'inside the boot build, not some other route')
})
