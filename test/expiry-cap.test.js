// Coverage #2 cookie/session expiry enforcement and #3 device-map cap.
// Expiry: FULL-STACK (real HTTP + real eviction in bridge.sessions).
// Cap: exercises the real bridge.capDeviceMap helper directly (logic/unit),
// plus its effect on real sessions and resumableSessions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { LanMobileBridge } from '../lib/bridge.js'
import { startBridge, httpFetch } from './helpers.js'

const capDeviceMap = LanMobileBridge.prototype.capDeviceMap

/** Only the set-cookie header is read from these mock responses. */
function mockResponse() {
  const headers = {}
  return {
    headers,
    setHeader(name, value) {
      headers[name] = value
    },
  }
}

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

// ---------------------------------------------------------------------------
// WP-SEC-BRIDGE B1 / M4 — behind the tunnel a device is retired by its own
// token, never by "address + label".
// ---------------------------------------------------------------------------

test('M4: in tunnel mode a new pairing does not retire another device that shares the carrier address', async () => {
  const t = await startBridge()
  try {
    const ua = 'Mozilla/5.0 (Linux; Android 12; NOH-AN00)'
    // First handset: no cookie yet, so the bridge mints one. That cookie is the
    // only thing that identifies this device from here on.
    const firstResponse = mockResponse()
    t.bridge.issueSessionCookie({ headers: { 'user-agent': ua } }, firstResponse, '203.0.113.7', 'tunnel')
    assert.equal(t.bridge.sessions.size, 1)
    const firstCookie = (firstResponse.headers['set-cookie'] ?? '').split(';')[0]
    assert.match(firstCookie, /^dsh_mobile=/)
    const firstToken = firstCookie.split('=')[1]

    // A second handset behind the same carrier egress with the same stock User-
    // Agent. Address + label used to retire the first entry here — behind a
    // tunnel those two are shared by a whole cell of phones, so a re-pair kicked
    // an unrelated device out for the cookie's full 30 days.
    const secondResponse = mockResponse()
    t.bridge.issueSessionCookie({ headers: { 'user-agent': ua } }, secondResponse, '203.0.113.7', 'tunnel')
    assert.equal(t.bridge.sessions.size, 2, 'address + UA is not identity in tunnel mode')
    assert.notEqual((secondResponse.headers['set-cookie'] ?? '').split(';')[0], firstCookie)
    assert.ok(t.bridge.sessions.has(firstToken), 'the first device keeps its session')

    // The device that comes back holding its own cookie is recognised by it, and
    // does not add a second entry.
    const again = mockResponse()
    t.bridge.issueSessionCookie({ headers: { cookie: firstCookie, 'user-agent': ua } }, again, '203.0.113.7', 'tunnel')
    assert.equal((again.headers['set-cookie'] ?? '').split(';')[0], firstCookie, 'the token it holds is the token it gets')
    assert.equal(t.bridge.sessions.size, 2)
  } finally {
    await t.stop()
  }
})

test('M4: every device map a disconnect writes is capped', async () => {
  const t = await startBridge()
  try {
    const desktop = await t.pairDesktop()
    // 20 pairings, each on its own address so the LAN retirement does not merge
    // them, then one disconnect: suspendedSessions used to grow uncapped there.
    for (let i = 0; i < 20; i++) {
      t.bridge.rotatePairingToken()
      const token = new URL(t.bridge.snapshot().pairingUrl).searchParams.get('token')
      const res = await httpFetch(`${t.base}/pair?token=${token}`, {
        headers: { 'user-agent': `PocketDevice-${i}/1.0` },
      })
      assert.equal(res.status, 302)
    }
    assert.equal(t.bridge.sessions.size, 16, 'sessions respects the cap')
    const disconnect = await httpFetch(`${t.base}/desktop/disconnect`, {
      method: 'POST',
      headers: { Cookie: desktop },
    })
    assert.equal(disconnect.status, 200)
    assert.equal(t.bridge.suspendedSessions.size, 16, 'suspendedSessions respects the cap')
    assert.equal(t.bridge.resumableSessions.size, 16, 'resumableSessions respects the cap')
    assert.equal(t.bridge.sessions.size, 0)
  } finally {
    await t.stop()
  }
})
