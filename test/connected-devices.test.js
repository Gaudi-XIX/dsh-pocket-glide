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
