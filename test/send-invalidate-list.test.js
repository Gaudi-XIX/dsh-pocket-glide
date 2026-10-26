// A send must not leave the session-catalogue cache standing (0.4.50).
//
// Repro the user reported: send, then return to the landing before the message
// grows a clock — the row looks like nothing was sent. The Host stamps the row's
// `updatedAt` with the user-message time in the same synchronous stack that
// appends the event (dsh-api-session-controller list.js:316-318 + :29-37, see
// docs/调查报告-宿主updatedAt推进时机-20261018.md), so the truth is on the host
// the moment the prompt is accepted. What is NOT new is the bridge's answer:
// `session.list` is served from the 10 s promise window (cachedSessionList), and
// the send used to route through the generic fallthrough without dropping it —
// so the landing read that follows a send got the pre-send row back, and the
// page's three home readings (clock / sort / tails stamp) all froze on it until
// the 60 s list poll outlived the window.
// Full mechanism: docs/调查报告-pocket发送后返回主页已发送不真实显示-20261018.md.
//
// What must stay true:
//   1. an accepted session.prompt drops the catalogue cache;
//   2. an accepted command.execute does the same (same write, different hat);
//   3. a REJECTED prompt keeps the cache (nothing was written, no reason to pay);
//   4. an unrelated fallthrough write (session.cancel) keeps the cache — the
//      invalidation is scoped to the two send methods, not sprayed over the route;
//   5. the call-site count is pinned so the repair cannot be silently dropped.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LanMobileBridge } from '../lib/bridge.js'

const bridgeSource = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')

function makeBridge({ calls = [], ok = true } = {}) {
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
    if (!ok && endpoint !== 'session/list') return { ok: false, error: 'host rejection' }
    return { ok: true, value: { items: [{ sessionId: 's1', updatedAt: 1 }] } }
  }
  return bridge
}

// Warm the catalogue through the RPC the page actually uses, so the cache holds
// a real pre-send row.
async function warm(bridge) {
  await bridge.forwardRpc('session.list', {})
  return bridge._calls.filter((e) => e === 'session/list').length
}

const listCalls = (bridge) => bridge._calls.filter((e) => e === 'session/list').length

test('an accepted prompt drops the catalogue cache: the next list read re-asks the Host', async () => {
  const calls = []
  const bridge = makeBridge({ calls })
  const before = await warm(bridge)
  await bridge.forwardRpc('session.prompt', { sessionId: 's1', content: 'hi' })
  const result = await bridge.cachedSessionList(false)
  assert.equal(listCalls(bridge), before + 1,
    'the read after a send re-fetches instead of answering from the 10s window')
  assert.ok(result.ok)
})

test('the same read without a send stays in the window (the cache still does its job)', async () => {
  const calls = []
  const bridge = makeBridge({ calls })
  const before = await warm(bridge)
  await bridge.cachedSessionList(false)
  assert.equal(listCalls(bridge), before,
    'nothing was written, so the promise window is still served — the fix did not become a no-cache')
})

test('an accepted command.execute drops the cache the same way', async () => {
  const calls = []
  const bridge = makeBridge({ calls })
  const before = await warm(bridge)
  await bridge.forwardRpc('command.execute', { sessionId: 's1', line: '/compact' })
  await bridge.cachedSessionList(false)
  assert.equal(listCalls(bridge), before + 1, 'slash commands write the transcript too')
})

test('a rejected prompt keeps the cache: no invalidation without a write', async () => {
  const calls = []
  const bridge = makeBridge({ calls, ok: false })
  await warm(bridge)
  const rejected = await bridge.forwardRpc('session.prompt', { sessionId: 's1', content: 'hi' })
  assert.equal(rejected.ok, false, 'the send failed')
  const before = listCalls(bridge)
  await bridge.cachedSessionList(false)
  assert.equal(listCalls(bridge), before, 'the failed send did not cost a re-read')
})

test('an unrelated fallthrough write keeps the cache', async () => {
  const calls = []
  const bridge = makeBridge({ calls })
  const before = await warm(bridge)
  await bridge.forwardRpc('session.cancel', { sessionId: 's1' })
  await bridge.cachedSessionList(false)
  assert.equal(listCalls(bridge), before,
    'the invalidation is scoped to the two send methods — not sprayed over every route')
})

test('the send branch lives above the generic fallthrough', () => {
  const at = bridgeSource.indexOf("if (method === 'session.prompt' || method === 'command.execute')")
  assert.ok(at >= 0, 'the send branch is gone from forwardRpc')
  assert.ok(at < bridgeSource.indexOf('const route = HARNESS_ENDPOINTS[method]', at),
    'it intercepts before the fallthrough, so the send can no longer bypass it')
})

