// Coverage #7 connectedDevices seam (FULL-STACK over real HTTP) and the
// pages.js device-label escaping (logic/render level). pages.js is plain ESM
// and importable under Node without a DOM: renderers return strings.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, httpFetch } from './helpers.js'
import { renderDesktopPairingPage } from '../lib/pages.js'

test('after pairing /desktop/status returns connectedDevices with per-device fields', async () => {
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile('PocketDevice/9.9')
    assert.match(cookie, /^dsh_mobile=/)
    const desktopCookie = await t.pairDesktop()

    const res = await httpFetch(`${t.base}/desktop/status`, { headers: { Cookie: desktopCookie } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.connected, true)
    assert.ok(Array.isArray(body.connectedDevices))
    assert.equal(body.connectedDevices.length, 1)
    const device = body.connectedDevices[0]
    assert.equal(typeof device.label, 'string')
    assert.equal(device.remoteAddress, '127.0.0.1')
    assert.equal(typeof device.issuedAt, 'number')
    assert.equal(typeof device.expiresAt, 'number')
    assert.ok(device.expiresAt > device.issuedAt)
  } finally {
    await t.stop()
  }
})

test('desktop tunnel payload endpoint also includes connectedDevices', async () => {
  const t = await startBridge()
  try {
    await t.pairMobile()
    const desktopCookie = await t.pairDesktop()

    const res = await httpFetch(`${t.base}/desktop/tunnel/status`, { headers: { Cookie: desktopCookie } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body.connectedDevices))
    assert.equal(body.connectedDevices.length, 1)
    for (const device of body.connectedDevices) {
      assert.ok('label' in device && 'remoteAddress' in device && 'issuedAt' in device && 'expiresAt' in device)
    }
  } finally {
    await t.stop()
  }
})

test('HTML inside a connected device label is escaped in the desktop pairing page', () => {
  const malicious = '<img src=x onerror=alert(1)>'
  const html = renderDesktopPairingPage({
    locale: 'zh',
    connectedDevices: [
      { label: malicious, remoteAddress: '127.0.0.1', issuedAt: Date.now(), expiresAt: Date.now() + 1000 },
    ],
    pairingUrl: 'http://127.0.0.1/pair?token=x',
    qrSvg: '',
  })
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.ok(!html.includes(malicious), 'raw executable HTML must not appear')
})

test('desktop /desktop/status is forbidden without a desktop session', async () => {
  const t = await startBridge()
  try {
    const res = await httpFetch(`${t.base}/desktop/status`)
    // Desktop routes require the dsh_desktop cookie / bootstrap.
    assert.ok([401, 403].includes(res.status))
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// WP-SEC-BRIDGE B1 / M14 — the device cap is LRU, not FIFO.
// ---------------------------------------------------------------------------

test('M14: touching a device moves it to the back of the eviction line', async () => {
  const t = await startBridge()
  try {
    const map = t.bridge.sessions
    for (let i = 0; i < 16; i++) map.set(`tok${i}`, { token: `tok${i}`, remoteAddress: '127.0.0.1' })
    // The oldest entry is still in use: a request carrying its cookie must save
    // it from the eviction that FIFO would have applied.
    t.bridge.touchDevice(map, 'tok0')
    t.bridge.capDeviceMap(map, 'tok16')
    map.set('tok16', { token: 'tok16', remoteAddress: '127.0.0.1' })
    assert.equal(map.has('tok0'), true, 'the touched entry survives')
    assert.equal(map.has('tok1'), false, 'the next-oldest entry is the one that goes')
    assert.equal(map.size, 16)
  } finally {
    await t.stop()
  }
})

test('M14: a live phone is not evicted by fifteen other devices pairing behind it', async () => {
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile('PocketLive/1.0')
    const liveToken = cookie.split('=')[1]
    for (let i = 0; i < 15; i++) {
      t.bridge.capDeviceMap(t.bridge.sessions, `filler-${i}`)
      t.bridge.sessions.set(`filler-${i}`, { token: `filler-${i}`, remoteAddress: '10.0.0.1' })
    }
    // The phone asks something with its cookie: that is the "hit" FIFO ignored.
    const status = await httpFetch(`${t.base}/api/status`, { headers: { cookie } })
    assert.equal(status.status, 200)
    // One slot left, so the next insert evicts — and it must not evict the phone.
    t.bridge.capDeviceMap(t.bridge.sessions, 'filler-15')
    t.bridge.sessions.set('filler-15', { token: 'filler-15', remoteAddress: '10.0.0.1' })
    assert.equal(t.bridge.sessions.size, 16)
    assert.equal(t.bridge.sessions.has(liveToken), true, 'the paired phone keeps its session')
    assert.equal(t.bridge.sessions.has('filler-0'), false, 'the least recently used filler goes first')
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// WP-SEC-BRIDGE B1 / M2 — a device can be revoked by name, and only itself.
// ---------------------------------------------------------------------------

test('M2: revoking one device drops its cookie and leaves the other phone alone', async () => {
  const t = await startBridge()
  try {
    // The pairing token is single-use, so each handset needs a fresh one.
    const pair = async (userAgent) => {
      t.bridge.rotatePairingToken()
      const token = new URL(t.bridge.snapshot().pairingUrl).searchParams.get('token')
      const res = await httpFetch(`${t.base}/pair?token=${token}`, { headers: { 'user-agent': userAgent } })
      assert.equal(res.status, 302)
      return (res.headers.get('set-cookie') ?? '').split(';')[0]
    }
    const first = await pair('PocketOne/1.0')
    const second = await pair('PocketTwo/2.0')
    assert.notEqual(first, second, 'two handsets, two cookies')
    assert.equal(t.bridge.sessions.size, 2)
    const desktopCookie = await t.pairDesktop()

    const before = await httpFetch(`${t.base}/desktop/status`, { headers: { Cookie: desktopCookie } })
    const devices = (await before.json()).connectedDevices
    assert.equal(devices.length, 2)
    assert.ok(devices.every((device) => typeof device.id === 'string' && device.id.length > 0), 'each device is namable')
    assert.ok(
      devices.every((device) => device.label.includes(device.id)),
      'the label carries a distinguishing tail (same-model phones used to be identical)'
    )
    const tokenOf = (cookie) => cookie.split('=')[1]
    assert.notEqual(tokenOf(first), tokenOf(second))
    assert.ok(
      devices.every((device) => device.id !== tokenOf(first) && device.id !== tokenOf(second)),
      'the revoke handle is not the session cookie the phone bears'
    )

    const target = devices.find((device) => device.label.startsWith('PocketOne/'))
    const kept = devices.find((device) => device.label.startsWith('PocketTwo/'))
    assert.ok(target && kept, 'both handsets are listed by label')

    const revoke = await httpFetch(`${t.base}/desktop/revoke`, {
      method: 'POST',
      headers: { Cookie: desktopCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: target.id }),
    })
    assert.equal(revoke.status, 200)

    const revokedRes = await httpFetch(`${t.base}/api/status`, { headers: { cookie: first } })
    assert.equal(revokedRes.status, 401, 'the revoked device no longer authenticates')
    const otherRes = await httpFetch(`${t.base}/api/status`, { headers: { cookie: second } })
    assert.equal(otherRes.status, 200, 'the other phone is untouched')
    const after = await httpFetch(`${t.base}/desktop/status`, { headers: { Cookie: desktopCookie } })
    const remaining = (await after.json()).connectedDevices
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].id, kept.id, 'only the named device left the list')
  } finally {
    await t.stop()
  }
})

test('M2: revoke needs a desktop session, and an unknown id says so', async () => {
  const t = await startBridge()
  try {
    const noCookie = await httpFetch(`${t.base}/desktop/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'whatever' }),
    })
    assert.equal(noCookie.status, 403, 'a phone cannot revoke devices')

    const desktopCookie = await t.pairDesktop()
    const unknown = await httpFetch(`${t.base}/desktop/revoke`, {
      method: 'POST',
      headers: { Cookie: desktopCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'no-such-device' }),
    })
    assert.equal(unknown.status, 404)
    const malformed = await httpFetch(`${t.base}/desktop/revoke`, {
      method: 'POST',
      headers: { Cookie: desktopCookie, 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(malformed.status, 400, 'bad input is 400, not the bridge-wide 500')
  } finally {
    await t.stop()
  }
})

test('M2: revoking the last device frees the connection mode switch', async () => {
  const t = await startBridge()
  try {
    await t.pairMobile('PocketLast/1.0')
    const desktopCookie = await t.pairDesktop()
    const status = await httpFetch(`${t.base}/desktop/status`, { headers: { Cookie: desktopCookie } })
    const [device] = (await status.json()).connectedDevices
    const revoke = await httpFetch(`${t.base}/desktop/revoke`, {
      method: 'POST',
      headers: { Cookie: desktopCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: device.id }),
    })
    assert.equal(revoke.status, 200)
    assert.equal(t.bridge.sessions.size, 0)
    assert.equal(t.bridge.suspendedSessions.size, 0, 'revocation is not a park: nothing is left to revive')
    assert.equal(t.bridge.resumableSessions.size, 0)
  } finally {
    await t.stop()
  }
})
