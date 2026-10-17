// coverage #7 connectedDevices seam (FULL-STACK over real HTTP) and the
// pages.js device-label escaping (logic/render level). pages.js is plain ESM
// and importable under Node without a DOM: renderers return strings.
//
// 2026-10-08 move-pocket-devices-into-mode-bar §10.4 R-7: the device list now
// lives in the new device panel (client-rendered by deviceCardHtml), and the
// revoke button carries a `class="is-danger"` marker. The anchors below are
// re-anchored to what the renderer actually emits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

// The pairing page polls ONE route per tick (2026-10-17). That only works while
// this payload keeps carrying what /desktop/status carried, so the contract is
// pinned here rather than left to the page to discover at runtime.
test('the tunnel payload is a superset of /desktop/status: the pairing page polls once', async () => {
  const t = await startBridge()
  try {
    const desktopCookie = await t.pairDesktop()
    const status = await (await httpFetch(`${t.base}/desktop/status`, { headers: { Cookie: desktopCookie } })).json()
    const tunnel = await (await httpFetch(`${t.base}/desktop/tunnel/status`, { headers: { Cookie: desktopCookie } })).json()
    for (const key of ['connected', 'connectedDevices', 'pendingPairings']) {
      assert.ok(key in tunnel, `the one-request poll needs ${key} on the tunnel payload`)
      assert.deepEqual(tunnel[key], status[key], `${key} must agree between the two routes`)
    }
  } finally {
    await t.stop()
  }
})

test('the pairing page issues one poll request per tick, and the tick is 2s', () => {
  const page = renderDesktopPairingPage({ locale: 'zh', pairingUrl: 'http://127.0.0.1:1/pair?token=x', pairingPin: '12345678' })
  const pollBody = page.slice(page.indexOf('async function poll()'), page.indexOf('setInterval(poll,'))
  assert.match(pollBody, /fetch\('\/desktop\/tunnel\/status'\)/, 'it asks for the merged payload')
  assert.ok(!pollBody.includes("fetch('/desktop/status')"), 'and it no longer pays a second round trip for the same tick')
  assert.match(page, /setInterval\(poll,2000\)/, 'an 800ms tick was 2.5 polls a second for a page nobody watches that closely')
})

test('HTML inside a device card label is escaped', () => {
  const malicious = '<img src=x onerror=alert(1)>'
  const { deviceCardHtml } = extractDeviceRenderer()
  const card = deviceCardHtml({ id: 'd1', label: malicious, remoteAddress: '127.0.0.1', permission: 'lan', online: true, issuedAt: Date.now(), expiresAt: Date.now() + 1000 })
  assert.match(card, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.ok(!card.includes(malicious), 'raw executable HTML must not appear')
})

// ---------------------------------------------------------------------------
// WP-1 #3a (change 2026-10-05-feat-pocket-mobile-ux-batch), re-anchored by
// 2026-10-08-move-pocket-devices-into-mode-bar §10.4 R-7: the device list now
// lives in the new device panel (client-rendered by deviceCardHtml), so the
// rendered-shape pins move from the old row to the panel card renderer.
// ---------------------------------------------------------------------------

function extractDeviceRenderer() {
  // Pull the panel card renderer + its string helpers out of the pages.js
  // source, with a T stub and small escHtml/formatTimestamp stand-ins. The
  // rendered zh page is returned too so copy assertions pin what actually
  // ships to the browser.
  const page = renderDesktopPairingPage({ locale: 'zh', pairingUrl: 'http://127.0.0.1/pair?token=x', qrSvg: '' })
  const names = [
    'deviceState', 'devicePermBadge', 'devicePermLabel',
    'deviceCredLabel', 'deviceFirstSeen', 'deviceLastSeen', 'deviceCardHtml',
  ]
  const body = names.map((name) => extractPageFunction(PAGES_SOURCE, name)).join('\n')
  // B: the stub values below are read off lib/pages.js's real factory strings
  // (2026-10-08 re-anchor). devicePermLabel returns the TARGET state, not the
  // current one — if this stub ever drifts from the factory value the
  // permission-direction watchdog in device-panel-exec.test.js goes blind.
  const T = {
    devOnline: '在线', devOffline: '离线',
    devPermLan: '仅本地', devPermWan: '本地+公网',
    devMakeLan: '切为仅本地', devMakeWan: '开启公网',
    devCredExpired: '{d}（已过期）',
    devFingerprint: '指纹', devFirstPaired: '首次配对',
    devCredExpiry: '凭证到期', devLastSeen: '最后上线', devNeverSeen: '未记录',
    devPermBadge: '通道权限：{v}',
    devExtend: '延长30天',
    revoke: '吊销',
  }
  const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const formatTimestamp = (v) => {
    const d = new Date(v); const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  const deviceCardHtml = new Function('T', 'escHtml', 'formatTimestamp', `${body}\nreturn deviceCardHtml`)(T, escHtml, formatTimestamp)
  return { deviceCardHtml, page, T }
}

test('each connected device card renders a revoke handle carrying its derived id', () => {
  const { deviceCardHtml, page } = extractDeviceRenderer()
  const card = deviceCardHtml({ id: 'dev-abc123', label: 'Pocket/1.0 · dev-abc123', remoteAddress: '127.0.0.1', permission: 'lan', online: true, issuedAt: Date.now(), expiresAt: Date.now() + 1000 })
  // The revoke button now carries the danger marker between data-action and
  // data-id (the two-step armed contract is what makes it a danger action).
  assert.match(card, /data-action="revoke-device" class="is-danger" data-id="dev-abc123"/,
    'the revoke handle carries the danger marker next to its id')
  assert.match(card, /吊销/)
  assert.match(page, /确认吊销/, 'the armed copy ships with the page')
  // There is no title attribute on the new card's revoke button; the armed
  // consequence copy lives in the page script's T table (revokeConfirm) and is
  // injected inline by revokeDevice(). This pins the payload string itself.
  assert.match(page, /吊销后该手机需重新配对/, 'the armed consequence copy ships in the T payload')
  assert.match(page, /revokeDevice\(/, 'the armed handler is in the page script')
  assert.match(page, /desktop\/revoke/, 'the handler POSTs the revoke endpoint')
})

test('a hostile device id is escaped in the revoke handle and the card', () => {
  const { deviceCardHtml } = extractDeviceRenderer()
  const hostileId = 'x" onmouseover="alert(1)'
  const card = deviceCardHtml({ id: hostileId, label: 'evil<label>', remoteAddress: '1.2.3.4', permission: 'lan', online: true, issuedAt: Date.now(), expiresAt: Date.now() + 1000 })
  assert.ok(!card.includes('onmouseover="alert(1)"'), 'the id must not survive unescaped')
  assert.match(card, /data-id="x&quot; onmouseover=&quot;alert\(1\)"/)
  assert.ok(!card.includes('<label>'), 'the label must be escaped too')
})

test('a device without an id (old payload) renders without a revoke handle', () => {
  const { deviceCardHtml } = extractDeviceRenderer()
  const card = deviceCardHtml({ label: 'Pocket/1.0', remoteAddress: '127.0.0.1', permission: 'lan', online: true, issuedAt: Date.now(), expiresAt: Date.now() + 1000 })
  assert.ok(!card.includes('data-action="revoke-device"'), 'no handle without a namable id')
  assert.ok(!card.includes('data-action="device-extend"'), 'no action handle without a namable id')
})

test('the mode bar carries the third key: a mode-devices handle that stays enabled', () => {
  const connected = renderDesktopPairingPage({
    locale: 'zh',
    connected: true,
    pairingUrl: 'http://127.0.0.1/pair?token=x',
    qrSvg: '',
  })
  assert.match(connected, /data-action="mode-devices"/, 'the third mode key ships with the page')
  assert.match(connected, /设备与通知/, 'the key copy is the agreed user wording')
  const btnDevices = connected.match(/<button id="btnDevices"[^>]*>/)
  assert.ok(btnDevices, 'the device key renders as its own button')
  assert.ok(!btnDevices[0].includes('disabled'), 'the device key is not gated on the connection state')
  // M-4: the old /device-view/ scan was true for any occurrence (CSS and JS
  // both spell it). Read the actual body tag so the assertion has teeth.
  const bodyTag = (connected.match(/<body class="([^"]*)"/) ?? [])[1]
  assert.ok(bodyTag && bodyTag.split(/\s+/).includes('device-view'),
    `the connected body carries the device-view class, got body class="${bodyTag}"`)
  const disconnected = renderDesktopPairingPage({
    locale: 'en',
    pairingUrl: 'http://127.0.0.1/pair?token=x',
    qrSvg: '',
  })
  const btnDevicesOff = disconnected.match(/<button id="btnDevices"[^>]*>/)
  assert.ok(btnDevicesOff, 'the device key renders in every mode')
  assert.ok(!btnDevicesOff[0].includes('active'), 'it is not the active view before pairing')
  assert.match(disconnected, /class="mode-panel"/, 'the mode panel shell is intact')
  assert.doesNotMatch(disconnected, /body class="[^"]*device-view/, 'only the connected page declares the device view')
})

// 2026-10-10: the task-notification panel used to be emitted INSIDE
// `.pairing-content`, which the connected state hid outright — so on a paired
// desktop (the everyday state) the notification block was in the DOM but never
// visible. That hiding rule is gone (2026-10-12: a live phone may not lock the
// page), but the sibling requirement stands on its own: the devices view hides
// `.pairing-content` as a whole, so anything trapped in it still disappears with it.
function ancestorChainOf(html, id) {
  const at = html.indexOf(`id="${id}"`)
  assert.notEqual(at, -1, `#${id} is rendered`)
  const stack = []
  const re = /<(\/?)(div|body)\b([^>]*)>/g
  let m
  while ((m = re.exec(html.slice(0, at)))) {
    const [full, slash, tag, attrs] = m
    if (full.endsWith('/>')) continue
    if (!slash) {
      stack.push(`${tag}${(attrs.match(/class="([^"]*)"/) ?? [, ''])[1] ? '.' + (attrs.match(/class="([^"]*)"/) ?? [, ''])[1].split(' ')[0] : ''}`)
    } else {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].startsWith(tag)) { stack.length = i; break }
      }
    }
  }
  return stack
}

test('the notification panel is not a descendant of the pairing container', () => {
  for (const connected of [true, false]) {
    const page = renderDesktopPairingPage({
      locale: 'zh',
      connected,
      pairingUrl: 'http://127.0.0.1/pair?token=x',
      qrSvg: '',
    })
    const chain = ancestorChainOf(page, 'notifyPanel')
    assert.ok(!chain.includes('div.pairing-content'),
      `connected=${connected}: #notifyPanel must not live under .pairing-content (${chain.join(' > ')})`)
    assert.ok(chain.includes('div.wrap'), `#notifyPanel stays inside .wrap (${chain.join(' > ')})`)
  }
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

// ---------------------------------------------------------------------------
// R1 reflux (change 2026-10-07-fix-pocket-r1-reflux-batch, item 1) — re-anchored
// by 2026-10-08-move-pocket-devices-into-mode-bar §10.4 R-7: the device list no
// longer repaints on the 800ms status poll (the old row was deleted), it is
// re-rendered only on demand via loadDevicePanel. So the armed two-step revoke
// can no longer be wiped by background polling. The pin that survives is the
// invariant that NOTHING in poll / applyTunnelPayload / the 1s tick touches
// the device panel — the armed state has no repaint path to fight.
// ---------------------------------------------------------------------------

const PAGES_SOURCE = readFileSync(new URL('../lib/pages.js', import.meta.url), 'utf8')

function extractPageFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the pages.js source`)
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const char = source[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${name}`)
}

test('AC1.1 the device panel has no poll-driven repaint path that can wipe an armed revoke', () => {
  // poll() and applyTunnelPayload() are the two background writers; the armed
  // handle on the new panel must survive because neither of them repaints it.
  for (const name of ['poll', 'applyTunnelPayload']) {
    const fn = extractPageFunction(PAGES_SOURCE, name)
    assert.ok(!/deviceList|devicePanel|loadDevicePanel/.test(fn),
      `${name} must not repaint the device panel (no path to wipe an armed revoke)`)
  }
})

test('AC1.2 the device panel reparts only through loadDevicePanel', () => {
  // The on-demand re-render is loadDevicePanel — the single writer of
  // #deviceList contents.
  const loader = extractPageFunction(PAGES_SOURCE, 'loadDevicePanel')
  assert.match(loader, /deviceList/, 'loadDevicePanel owns the panel re-render')
  const retrier = extractPageFunction(PAGES_SOURCE, 'retryLoadDevicePanel')
  assert.match(retrier, /loadDevicePanel/, 'retry re-runs the panel load')
})
