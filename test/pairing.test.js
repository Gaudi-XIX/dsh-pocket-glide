// Coverage #1 pairing — FULL-STACK over real HTTP against a real bridge on an
// ephemeral port. Tunnel PIN path exercised in-process via the cf-connecting-ip
// + cf-ray header seam (no real public host required).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LanMobileBridge, pairingRateKey } from '../lib/bridge.js'
import { PAIRING_PIN_DIGITS } from '../lib/constants.js'
import { startBridge, httpFetch } from './helpers.js'

test('unpaired GET /api/status is rejected with 401', async () => {
  const t = await startBridge()
  try {
    const res = await httpFetch(`${t.base}/api/status`)
    assert.equal(res.status, 401)
  } finally {
    await t.stop()
  }
})

test('valid pairing token issues a hardened dsh_mobile cookie and redirects', async () => {
  const t = await startBridge()
  try {
    const token = new URL(t.snap.pairingUrl).searchParams.get('token')
    const res = await httpFetch(`${t.base}/pair?token=${token}`, {
      headers: { 'user-agent': 'PocketPair/2.0' },
    })
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/')
    const setCookie = res.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /^dsh_mobile=[^;]+/)
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)
    assert.match(setCookie, /Path=\//)
    assert.match(setCookie, /Max-Age=2592000/)
    // LAN pairing must not set the Secure attribute.
    assert.doesNotMatch(setCookie, /Secure/)
    // Pairing token is single-use.
    assert.equal(t.bridge.pairingToken, undefined)
  } finally {
    await t.stop()
  }
})

test('a bogus scan link recovers instead of dead-ending', async () => {
  const t = await startBridge()
  try {
    const res = await httpFetch(`${t.base}/pair?token=bogus-token-value`)
    // The scan link is single-use and expires in five minutes, but the phone keeps
    // it in its history and home-screen shortcut. A bare 401 made every reload a
    // dead end; /reconnect still demands a fresh pairing before any session.
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/reconnect')
    assert.equal(t.bridge.sessions.size, 0, 'a bogus token must never mint a session')
    assert.doesNotMatch(res.headers.get('set-cookie') ?? '', /dsh_mobile/)
  } finally {
    await t.stop()
  }
})

test('an expired scan link recovers instead of dead-ending', async () => {
  const t = await startBridge()
  try {
    t.bridge.pairingExpiresAt = Date.now() - 1000
    const token = new URL(t.snap.pairingUrl).searchParams.get('token')
    const res = await httpFetch(`${t.base}/pair?token=${token}`)
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/reconnect')
    assert.equal(t.bridge.sessions.size, 0, 'an expired token must never mint a session')
  } finally {
    await t.stop()
  }
})

const tunnelHeaders = {
  'cf-connecting-ip': '203.0.113.7',
  'cf-ray': '8c1a-test-SJC',
}

async function verifyPin(t, pin, headers = {}) {
  return httpFetch(`${t.base}/pair/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...tunnelHeaders, ...headers },
    body: JSON.stringify({ pin }),
  })
}

async function tunnelPinBridge(pin = '123456') {
  const t = await startBridge()
  // Consent is off with the fake store, so the PIN is the ephemeral one.
  t.bridge.ephemeralPin = pin
  t.bridge.ephemeralPinExpiresAt = Date.now() + 5 * 60_000
  return t
}

function cookieOf(res) {
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

/**
 * Take one PIN-verified pairing through the full desktop-confirmation flow
 * (design #4a): verify → pending → desktop approve → poll. Returns the verify
 * payload and the final poll response (whose Set-Cookie is the pairing cookie).
 */
async function completePairing(t, pin, verifyHeaders = {}, desktopCookie) {
  const verified = await verifyPin(t, pin, verifyHeaders)
  assert.equal(verified.status, 200)
  const verifiedBody = await verified.json()
  assert.equal(verifiedBody.ok, true)
  assert.equal(verifiedBody.pending, true)
  assert.equal(verified.headers.get('set-cookie'), null, 'verify itself must not issue a cookie')
  const approved = await t.approvePendingPairing(verifiedBody.confirmId, desktopCookie)
  assert.equal(approved.status, 200)
  const poll = await t.pollPendingPairing(verifiedBody.confirmId, verifyHeaders)
  assert.equal(poll.status, 200)
  return { verifiedBody, poll }
}

// ---------------------------------------------------------------------------
// 改版(2026-10-07-feat-pocket-device-registry):第二次配对同 UA 的手机已是
// 注册表里的已知设备,/pair/verify 直接换发凭证(pending:false),不再等桌面
// 确认。原断言「仍走 pending→approve→poll」随桌面确认跳过而反转;「一台手机
// 只占一个条目」的性质保留,由注册表匹配 + presented-cookie 复用共同保证。
// ---------------------------------------------------------------------------

test('re-pairing with the live cookie keeps one device instead of two', async () => {
  const t = await tunnelPinBridge()
  try {
    const desktop = await t.pairDesktop()
    const first = await completePairing(t, '123456', {}, desktop)
    assert.equal((await first.poll.json()).approved, true)
    const cookie = cookieOf(first.poll)
    assert.match(cookie, /^dsh_mobile=/)
    assert.equal(t.bridge.sessions.size, 1)
    const liveToken = [...t.bridge.sessions.keys()][0]
    // The second submit carries the cookie the first flow issued (same origin,
    // so SameSite=Strict still sends it). The registry knows the fingerprint,
    // so the verify answers restored — and the presented cookie is the token
    // that gets re-issued, not a second entry.
    const verified = await verifyPin(t, '123456', { cookie })
    assert.equal(verified.status, 200)
    const body = await verified.json()
    assert.equal(body.ok, true)
    assert.equal(body.pending, false, 'a known device is restored on the verify itself')
    assert.equal(cookieOf(verified), cookie, 'the phone keeps the token it already holds')
    assert.equal(t.bridge.sessions.size, 1, 'one handset must never occupy two entries')
    assert.ok(t.bridge.sessions.has(liveToken))
    assert.equal(t.bridge.pendingPairings.size, 0, 'no confirmation card either')
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// WP-SEC-BRIDGE B1 / M4 — the retirement key behind the tunnel is the device's
// own token, not "address + User-Agent".
//
// 原断言：一次「同 addr + 同 UA、不带 cookie」的隧道重连之后 `sessions.size === 1`
//         （'the same handset must replace its entry'）。
// 新断言：LAN 下仍为 1；隧道下为 2，且带 cookie 的重连仍复用同一 token。
// 为什么原断言钉的是错行为：隧道模式下 `remoteAddress` 是 cloudflared 出口
//   （cf-connecting-ip）——一台运营商出口地址后面是整批手机，而 `label` 只是
//   UA 前 40 字符，同型号两台完全一样。用这两个键退休"同一台手机"，实际会在
//   第二台同型号手机上机时踢掉第一台的有效会话。卡片裁定见 design §8–9 M4
//   「隧道模式用设备标识（cookie/token）而非 IP 判定退休」。
// ---------------------------------------------------------------------------

test('LAN re-pairing without a cookie still replaces that handset entry', async () => {
  const t = await startBridge()
  try {
    const ua = { 'user-agent': 'Mozilla/5.0 (Linux; Android 12; NOH-AN00)' }
    const pair = async () => {
      // The pairing token is single-use, so a second scan needs a fresh one.
      t.bridge.rotatePairingToken()
      const token = new URL(t.bridge.snapshot().pairingUrl).searchParams.get('token')
      const res = await httpFetch(`${t.base}/pair?token=${token}`, { headers: ua })
      assert.equal(res.status, 302)
      return (res.headers.get('set-cookie') ?? '').split(';')[0]
    }
    const first = await pair()
    assert.equal(t.bridge.sessions.size, 1)
    // Cleared storage on the LAN: address + UA is the narrowest key available
    // there, and a LAN address really is one interface of one handset.
    const second = await pair()
    assert.equal(t.bridge.sessions.size, 1, 'the same LAN handset must replace its entry')
    assert.notEqual(second, first, 'the replaced entry carries the new token')
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// 改版(2026-10-07-feat-pocket-device-registry)。原断言:同 addr + 同 UA、不带
// cookie 的隧道重配对「不退休原条目」(M4,sessions.size === 2)。新断言:该
// 情形按注册表指纹命中已知设备,PIN 即恢复并退休同指纹旧条目(sessions.size
// === 1)。M4 的安全内核原样保留并在下方单钉:地址 + UA 单独永远进不来——
// 恢复仍然必须先答对 PIN,答不对什么都不发生。
// ---------------------------------------------------------------------------

test('tunnel re-pairing without a cookie restores the known device and retires its old entry', async () => {
  const t = await tunnelPinBridge()
  try {
    const desktop = await t.pairDesktop()
    const ua = { 'user-agent': 'Mozilla/5.0 (Linux; Android 12; NOH-AN00)' }
    await completePairing(t, '123456', ua, desktop)
    assert.equal(t.bridge.sessions.size, 1)
    const oldToken = [...t.bridge.sessions.keys()][0]
    // Same carrier egress, same stock UA, no cookie — but the PIN, which is
    // the operator's presence proof. The registry match retires the stale
    // entry instead of stacking a phantom per restart.
    const verified = await verifyPin(t, '123456', ua)
    assert.equal(verified.status, 200)
    assert.equal((await verified.json()).pending, false)
    assert.match(cookieOf(verified), /^dsh_mobile=/)
    assert.equal(t.bridge.sessions.size, 1, 'one fingerprint, one device, one entry')
    assert.equal(t.bridge.sessions.has(oldToken), false, 'the stale entry is retired')
    assert.notEqual(cookieOf(verified).split('=')[1], oldToken, 'the phone carries the fresh token')
  } finally {
    await t.stop()
  }
})

test('M4 kernel: without the PIN, a shared egress address and a stock UA are still nothing', async () => {
  const t = await tunnelPinBridge()
  try {
    const desktop = await t.pairDesktop()
    const ua = { 'user-agent': 'Mozilla/5.0 (Linux; Android 12; NOH-AN00)' }
    await completePairing(t, '123456', ua, desktop)
    assert.equal(t.bridge.sessions.size, 1)
    // No cookie, no PIN knowledge: the wrong answer restores nothing.
    const wrong = await verifyPin(t, '000000', ua)
    assert.equal(wrong.status, 401)
    assert.equal(t.bridge.sessions.size, 1)
    assert.equal(t.bridge.pendingPairings.size, 0, 'a failed guess registers no confirmation card either')
  } finally {
    await t.stop()
  }
})

test('a different handset still gets its own device entry', async () => {
  const t = await tunnelPinBridge()
  try {
    const desktop = await t.pairDesktop()
    await completePairing(t, '123456', { 'user-agent': 'Mozilla/5.0 (Linux; Android 12; NOH-AN00)' }, desktop)
    await completePairing(t, '123456', { 'user-agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7)' }, desktop)
    assert.equal(t.bridge.sessions.size, 2, 'eviction must not merge two distinct phones')
  } finally {
    await t.stop()
  }
})

test('tunnel mode: wrong PIN is rejected', async () => {
  const t = await startBridge()
  try {
    // Seed a valid ephemeral PIN directly (same seam the tunnel bootstrap uses).
    t.bridge.ephemeralPin = '123456'
    t.bridge.ephemeralPinExpiresAt = Date.now() + 5 * 60_000
    const res = await verifyPin(t, '000000')
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'Invalid pairing password.')
  } finally {
    await t.stop()
  }
})

test('tunnel mode: PIN rate limit returns 429 after 5 failures per IP', async () => {
  const t = await startBridge()
  try {
    t.bridge.ephemeralPin = '123456'
    t.bridge.ephemeralPinExpiresAt = Date.now() + 5 * 60_000
    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await verifyPin(t, '000000')
      assert.equal(res.status, 401, `attempt ${attempt} should be 401`)
    }
    const limited = await verifyPin(t, '000000')
    assert.equal(limited.status, 429)
    const body = await limited.json()
    assert.equal(body.error, 'Too many attempts.')
    assert.ok(Number(limited.headers.get('retry-after')) >= 1)
    // Even the correct PIN is blocked while the window is open.
    const blocked = await verifyPin(t, '123456')
    assert.equal(blocked.status, 429)
  } finally {
    await t.stop()
  }
})

test('tunnel mode: expired PIN asks to rescan', async () => {
  const t = await startBridge()
  try {
    t.bridge.ephemeralPin = '123456'
    t.bridge.ephemeralPinExpiresAt = Date.now() - 1000
    const res = await verifyPin(t, '123456')
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'expired')
    assert.equal(body.rescan, true)
  } finally {
    await t.stop()
  }
})

test('tunnel mode: correct PIN pairs and cookie carries Secure', async () => {
  const t = await startBridge()
  try {
    t.bridge.ephemeralPin = '123456'
    t.bridge.ephemeralPinExpiresAt = Date.now() + 5 * 60_000
    const desktop = await t.pairDesktop()
    const { poll } = await completePairing(t, '123456', {}, desktop)
    const setCookie = poll.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /^dsh_mobile=/)
    // Tunnel pairing: the issued cookie carries Secure (the /pair/pending
    // handler issues in tunnel mode, whatever the transport of the poll).
    assert.match(setCookie, /Secure/)
    assert.equal(t.bridge.sessions.size, 1)
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// Design #4a — the pairing desktop-confirmation state machine (I-3 key check).
// Arms: ① verify pends without a cookie ② desktop sees the request ③ approve
// issues + consumes ④ deny ⑤ TTL ⑥ confirm needs the desktop ⑦ the LAN token
// path (helpers.pairMobile) is untouched — pinned by the LAN pairing tests
// above and in bridge-review.
// ---------------------------------------------------------------------------

test('pairing state machine: verify pends, desktop sees it, approve issues once', async () => {
  const t = await tunnelPinBridge()
  try {
    // ① verify → pending, never a cookie.
    const verified = await verifyPin(t, '123456')
    assert.equal(verified.status, 200)
    const body = await verified.json()
    assert.equal(body.pending, true)
    assert.equal(typeof body.confirmId, 'string')
    assert.equal(body.checkAfterMs, 2000)
    assert.equal(verified.headers.get('set-cookie'), null)
    assert.equal(t.bridge.sessions.size, 0, 'no session before the desktop approves')
    // ② the desktop status surface lists the request.
    const desktop = await t.pairDesktop()
    const status = await httpFetch(`${t.base}/desktop/status`, { headers: { Cookie: desktop } })
    const pending = (await status.json()).pendingPairings
    assert.equal(pending.length, 1)
    assert.equal(pending[0].id, body.confirmId)
    assert.equal(pending[0].remoteAddress, '203.0.113.7')
    assert.ok(typeof pending[0].label === 'string' && pending[0].label.length > 0)
    assert.equal(typeof pending[0].expiresAt, 'number')
    // ③ approve → the next poll issues the cookie and consumes the verdict.
    assert.equal((await t.approvePendingPairing(body.confirmId, desktop)).status, 200)
    const poll = await t.pollPendingPairing(body.confirmId)
    assert.equal((await poll.json()).approved, true)
    assert.match(poll.headers.get('set-cookie') ?? '', /^dsh_mobile=/)
    assert.equal(t.bridge.sessions.size, 1)
    // One-shot: a second poll on the consumed id is expired, not pending.
    const again = await t.pollPendingPairing(body.confirmId)
    assert.deepEqual(await again.json(), { ok: false, reason: 'expired' })
    assert.equal(again.headers.get('set-cookie'), null)
  } finally {
    await t.stop()
  }
})

test('pairing state machine: deny answers denied and issues nothing', async () => {
  const t = await tunnelPinBridge()
  try {
    const verified = await verifyPin(t, '123456')
    const { confirmId } = await verified.json()
    const desktop = await t.pairDesktop()
    assert.equal((await t.approvePendingPairing(confirmId, desktop, false)).status, 200)
    const poll = await t.pollPendingPairing(confirmId)
    assert.equal(poll.status, 200)
    assert.deepEqual(await poll.json(), { ok: false, reason: 'denied' })
    assert.equal(poll.headers.get('set-cookie'), null)
    assert.equal(t.bridge.sessions.size, 0)
    // The verdict was consumed by the poll that reported it.
    const again = await t.pollPendingPairing(confirmId)
    assert.deepEqual(await again.json(), { ok: false, reason: 'expired' })
  } finally {
    await t.stop()
  }
})

test('pairing state machine: an unanswered request expires with its TTL', async () => {
  const t = await tunnelPinBridge()
  try {
    const verified = await verifyPin(t, '123456')
    const { confirmId } = await verified.json()
    const desktop = await t.pairDesktop()
    // Advance the bridge clock past the 60s confirm window.
    t.bridge.now = () => Date.now() + 61_000
    const poll = await t.pollPendingPairing(confirmId)
    assert.deepEqual(await poll.json(), { ok: false, reason: 'expired' })
    assert.equal(poll.headers.get('set-cookie'), null)
    // The swept entry is gone from the desktop surface too.
    const status = await httpFetch(`${t.base}/desktop/status`, { headers: { Cookie: desktop } })
    assert.equal((await status.json()).pendingPairings.length, 0)
  } finally {
    await t.stop()
  }
})

test('pairing state machine: confirm demands the desktop session', async () => {
  const t = await tunnelPinBridge()
  try {
    const verified = await verifyPin(t, '123456')
    const { confirmId } = await verified.json()
    const refused = await httpFetch(`${t.base}/desktop/pair/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: confirmId, approve: true }),
    })
    assert.equal(refused.status, 403)
    // The request is still pending for the real desktop.
    const desktop = await t.pairDesktop()
    assert.equal((await t.approvePendingPairing(confirmId, desktop)).status, 200)
    // Unknown ids answer 404, consumed ones too.
    const unknown = await t.approvePendingPairing('no-such-id', desktop)
    assert.equal(unknown.status, 404)
  } finally {
    await t.stop()
  }
})

test('PIN verify outside tunnel mode is refused with 400', async () => {
  const t = await startBridge()
  try {
    const res = await httpFetch(`${t.base}/pair/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '123456' }),
    })
    assert.equal(res.status, 400)
  } finally {
    await t.stop()
  }
})

test('manual refresh: /desktop/pairing/rotate issues a new token within the TTL', async () => {
  const t = await startBridge()
  try {
    const desktopCookie = await t.pairDesktop()
    const oldToken = new URL(t.snap.pairingUrl).searchParams.get('token')

    const res = await httpFetch(`${t.base}/desktop/pairing/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktopCookie },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)

    // The bridge now holds a different token.
    const newToken = new URL(t.bridge.snapshot().pairingUrl).searchParams.get('token')
    assert.notEqual(newToken, oldToken)
    // The returned expiry is a full TTL out (the point of refreshing).
    const remaining = body.expiresAt - Date.now()
    assert.ok(remaining > 4 * 60_000, `expected fresh TTL, got ${remaining}ms`)
  } finally {
    await t.stop()
  }
})

test('rotate without a desktop session is rejected with 403', async () => {
  const t = await startBridge()
  try {
    const res = await httpFetch(`${t.base}/desktop/pairing/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(res.status, 403)
    // The token did not rotate.
    const token = new URL(t.bridge.snapshot().pairingUrl).searchParams.get('token')
    assert.equal(token, new URL(t.snap.pairingUrl).searchParams.get('token'))
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// WP-SEC-BRIDGE B1 / M8 + M9 — password strength and the rate-limit key.
// Invariant assertions only (parallel-write window: absolute counts are not
// reproducible, per design §14 b5).
// ---------------------------------------------------------------------------

/** A bridge with no server: for the generator and the failure bookkeeping. */
function bareBridge() {
  return new LanMobileBridge({
    harnessUrl: () => 'http://127.0.0.1:9',
    innerAuth: { ready: async () => undefined, invalidate: () => {} },
    pairingPinStore: { load: () => ({}), save: () => true },
    now: () => 10_000_000_000_000,
  })
}

test('M8: the generated password is a numeric string of the declared width', () => {
  // The shape every consumer may rely on. The width is the constant
  // PAIRING_PIN_DIGITS, and the phone's password field (its length and pattern,
  // in lib/pages.js) has to move with it — see the seam note in the handoff.
  const bridge = bareBridge()
  const shape = new RegExp(`^[0-9]{${PAIRING_PIN_DIGITS}}$`)
  const widths = new Set()
  for (let round = 0; round < 50; round++) {
    const pin = bridge.generatePairingPin()
    assert.match(pin, shape, `width ${PAIRING_PIN_DIGITS}, digits only`)
    assert.match(pin, /^[0-9A-Za-z]{6,}$/, 'never shorter than the field accepts')
    widths.add(pin.length)
  }
  assert.deepEqual([...widths], [PAIRING_PIN_DIGITS], 'one width, every round')
})

test('M8: a stored durable password short-circuits, whatever its width', () => {
  for (const pin of ['123456', '12345678']) {
    const bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9',
      innerAuth: { ready: async () => undefined, invalidate: () => {} },
      pairingPinStore: { load: () => ({ pin, pinConsent: true }), save: () => true },
      now: () => 10_000_000_000_000,
    })
    const view = bridge.readPairingPin()
    assert.equal(view.pin, pin, `${pin} must be read back as-is`)
    assert.equal(view.consent, true)
    assert.equal(view.expired, false, 'a durable password never expires on its own')
  }
})

test('M9: x-forwarded-for cannot rename the rate-limit bucket', async () => {
  const t = await startBridge()
  try {
    t.bridge.ephemeralPin = '123456'
    t.bridge.ephemeralPinExpiresAt = Date.now() + 5 * 60_000
    await verifyPin(t, '000000')
    const before = [...t.bridge.pinFailuresByIp.keys()]
    assert.equal(before.length, 1, 'the first failure creates exactly one key')
    for (let attempt = 1; attempt <= 4; attempt++) {
      await verifyPin(t, '000000', { 'x-forwarded-for': `10.7${attempt}.0.1` })
    }
    const after = [...t.bridge.pinFailuresByIp.keys()]
    assert.deepEqual(after, before, 'the forged header must not create or move a key')
  } finally {
    await t.stop()
  }
})

test('M9: the rate key is the socket peer in LAN mode and the carrier address in tunnel mode', () => {
  // In LAN mode the key is the socket peer; a carrier address must not be able
  // to move it. In tunnel mode the key is the carrier address the local cloudflared
  // reported (socket:127.0.0.1 would bucket every phone behind one tunnel).
  assert.equal(pairingRateKey('192.168.1.9', 'lan', undefined), 'socket:192.168.1.9')
  assert.equal(pairingRateKey('192.168.1.9', 'lan', '203.0.113.7'), 'socket:192.168.1.9')
  assert.equal(pairingRateKey('127.0.0.1', 'tunnel', '203.0.113.7'), 'tunnel:203.0.113.7')
  // No carrier address at all: fall back to the socket peer.
  assert.equal(pairingRateKey('127.0.0.1', 'tunnel', undefined), 'socket:127.0.0.1')
  // An IPv6-mapped carrier address is normalised the same way the address is.
  assert.equal(pairingRateKey('127.0.0.1', 'tunnel', '::ffff:203.0.113.7'), 'tunnel:203.0.113.7')
})

test('M9: a correct password clears its own key and leaves the global count', async () => {
  const t = await startBridge()
  try {
    t.bridge.ephemeralPin = '123456'
    t.bridge.ephemeralPinExpiresAt = Date.now() + 5 * 60_000
    await verifyPin(t, '000000')
    const key = [...t.bridge.pinFailuresByIp.keys()][0]
    assert.equal(t.bridge.pinFailuresGlobal.length, 1)
    // A success is worth something to the device that earned it, not to the
    // counter that watches every device.
    await verifyPin(t, '123456')
    assert.equal(t.bridge.pinFailuresByIp.has(key), false, 'its own bucket is cleared')
    assert.equal(t.bridge.pinFailuresGlobal.length, 1, 'the global count survives it')
    for (let attempt = 1; attempt <= 3; attempt++) await verifyPin(t, '000000')
    assert.ok(t.bridge.pinFailuresGlobal.length > 1, 'failures keep accumulating globally')
  } finally {
    await t.stop()
  }
})

test('M9: past the hard lock the wait grows and never opens on its own', async () => {
  const t = await startBridge()
  try {
    t.bridge.ephemeralPin = '123456'
    t.bridge.ephemeralPinExpiresAt = Date.now() + 5 * 60_000
    let waited = 0
    for (let attempt = 1; attempt <= 12; attempt++) {
      const res = await verifyPin(t, '000000')
      if (res.status === 429) waited = Math.max(waited, Number(res.headers.get('retry-after')))
    }
    assert.ok(waited > 60, `a backoff, not a fixed pause (saw ${waited}s)`)
    const locked = await verifyPin(t, '123456')
    assert.equal(locked.status, 429, 'the lock holds even the right answer out')
    // Only a desktop password action takes it down.
    t.bridge.clearPinFailures()
    const open = await verifyPin(t, '123456')
    assert.equal(open.status, 200, 'a desktop password action resets the gate')
  } finally {
    await t.stop()
  }
})

test('M9: the failure map itself is bounded', () => {
  const bridge = bareBridge()
  for (let i = 0; i < 1200; i++) bridge.recordPinFailure(`key-${i}`)
  assert.ok(bridge.pinFailuresByIp.size <= 600, `bounded map, saw ${bridge.pinFailuresByIp.size}`)
})

// ---------------------------------------------------------------------------
// Design #3c × #4a — the pairing funnel never answers the consent gate, so the
// first /api/rpc after pairing is 303 /consent. The phone walks the browser
// through /consent once and comes back; these pin the server half of that
// sequence (the gate must sit in front of the API, and one accept must clear
// it for the paired phone).
// ---------------------------------------------------------------------------

test('after pairing, the consent gate fronts /api/rpc until the disclaimer is accepted', async () => {
  const t = await tunnelPinBridge()
  try {
    const desktop = await t.pairDesktop()
    const { poll } = await completePairing(t, '123456', {}, desktop)
    const mobile = cookieOf(poll)
    assert.match(mobile, /^dsh_mobile=/)
    // The gate sits before the authorized() pipeline: a paired phone without
    // the consent cookie gets the 303, not the RPC answer.
    const gated = await httpFetch(`${t.base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: mobile, ...tunnelHeaders },
      body: JSON.stringify({ method: 'workspace.list', payload: {} }),
    })
    assert.equal(gated.status, 303)
    assert.equal(gated.headers.get('location'), '/consent?next=%2Fapi%2Frpc')
    // Accept once — the same POST the disclaimer page issues — and the same
    // call gets through the gate. It then fails at the RPC layer (no Host
    // baseline in the test rig), which is the point: the gate is behind us.
    const accepted = await httpFetch(`${t.base}/consent/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: mobile, ...tunnelHeaders },
      body: JSON.stringify({ next: '/' }),
    })
    assert.equal(accepted.status, 303)
    const consent = cookieOf(accepted)
    assert.match(consent, /^dsh_consent=1/)
    const through = await httpFetch(`${t.base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: `${mobile}; ${consent}`, ...tunnelHeaders },
      body: JSON.stringify({ method: 'workspace.list', payload: {} }),
    })
    assert.equal(through.status, 400)
    assert.equal((await through.json()).error, 'Harness workspaces are not loaded yet.')
  } finally {
    await t.stop()
  }
})
