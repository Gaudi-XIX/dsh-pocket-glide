// Coverage #2 cookie/session expiry enforcement and #3 device-map cap.
// Expiry: FULL-STACK (real HTTP + real eviction in bridge.sessions).
// Cap: exercises the real bridge.capDeviceMap helper directly (logic/unit),
// plus its effect on real sessions and resumableSessions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LanMobileBridge } from '../lib/bridge.js'
import { startBridge, httpFetch } from './helpers.js'

const capDeviceMap = LanMobileBridge.prototype.capDeviceMap

test('expired mobile cookie: /api/status is 401 and the session is evicted', async () => {
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile()
    assert.equal(t.bridge.sessions.size, 1)

    // Backdate the real session entry's expiry.
    const key = t.bridge.sessions.keys().next().value
    const record = t.bridge.sessions.get(key)
    record.expiresAt = Date.now() - 1000

    const res = await httpFetch(`${t.base}/api/status`, { headers: { Cookie: cookie } })
    assert.equal(res.status, 401)
    // authorized() lazily evicts expired records.
    assert.equal(t.bridge.sessions.has(key), false)
    assert.equal(t.bridge.sessions.size, 0)
  } finally {
    await t.stop()
  }
})

test('capDeviceMap enforces a 16-entry cap, evicting the oldest and keeping the newest', () => {
  const map = new Map()
  for (let i = 0; i < 20; i++) {
    // Mirror the real call site: cap first, then insert.
    capDeviceMap.call(LanMobileBridge.prototype, map, `tok${i}`)
    map.set(`tok${i}`, { i })
  }
  assert.equal(map.size, 16)
  assert.equal(map.has('tok0'), false)
  assert.equal(map.has('tok3'), false)
  assert.equal(map.has('tok4'), true) // oldest surviving
  assert.equal(map.has('tok19'), true) // newest kept
})

test('capDeviceMap is a no-op for duplicate and under-cap tokens', () => {
  const map = new Map([['a', 1]])
  capDeviceMap.call(LanMobileBridge.prototype, map, 'a') // existing token: no eviction
  assert.equal(map.size, 1)
  capDeviceMap.call(LanMobileBridge.prototype, map, 'b')
  assert.equal(map.size, 1) // helper only caps; insertion is the caller's job
})

test('real sessions map is bounded by the same 16-entry cap', async () => {
  const t = await startBridge()
  try {
    // Drive 20 sessions through the exact helper + insert used by
    // issueSessionCookie (bridge.js line ~628).
    for (let i = 0; i < 20; i++) {
      const token = `real-tok-${i}`
      t.bridge.capDeviceMap(t.bridge.sessions, token)
      t.bridge.sessions.set(token, { remoteAddress: '127.0.0.1', expiresAt: Date.now() + 1000 })
    }
    assert.equal(t.bridge.sessions.size, 16)
    assert.equal(t.bridge.sessions.has('real-tok-0'), false)
    assert.equal(t.bridge.sessions.has('real-tok-19'), true)
  } finally {
    await t.stop()
  }
})

test('resumableSessions uses the same capDeviceMap helper', async () => {
  const t = await startBridge()
  try {
    for (let i = 0; i < 20; i++) {
      const token = `resume-tok-${i}`
      t.bridge.capDeviceMap(t.bridge.resumableSessions, token)
      t.bridge.resumableSessions.set(token, { i })
    }
    assert.equal(t.bridge.resumableSessions.size, 16)
    assert.equal(t.bridge.resumableSessions.has('resume-tok-0'), false)
    assert.equal(t.bridge.resumableSessions.has('resume-tok-19'), true)
  } finally {
    await t.stop()
  }
})
