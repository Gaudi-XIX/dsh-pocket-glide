// Bridge-side review fixes A–K (2026-10-01). Full-stack tests boot the real
// LanMobileBridge over HTTP; the unit-shaped tests call its methods directly
// on a minimally constructed instance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  LanMobileBridge,
  buildContentSecurityPolicy,
  parseLanAdapterLines,
} from '../lib/bridge.js'
import { startBridge, httpFetch } from './helpers.js'

/** A bridge instance that never starts a server, for direct method tests. */
function bareBridge(options = {}) {
  return new LanMobileBridge({ ...options })
}

function mockResponse() {
  const headers = {}
  return {
    headers,
    setHeader(name, value) {
      headers[name] = value
    },
  }
}

// ---------------------------------------------------------------------------
// A. Phantom device fix
// ---------------------------------------------------------------------------

test('A full-stack: disconnect then re-pair leaves exactly one connected device', async () => {
  const t = await startBridge()
  try {
    // Pair through the LAN pairing URL itself (not the loopback base): the
    // session is then keyed to the LAN-side remote address, exactly as it is
    // for a physical phone scanning the QR.
    const pairThrough = async (cookie) => {
      const pairingUrl = t.bridge.snapshot().pairingUrl
      const headers = { 'user-agent': 'PocketDevice/1.0' }
      if (cookie) headers.Cookie = cookie
      return httpFetch(pairingUrl, { headers })
    }

    const first = await pairThrough()
    assert.equal(first.status, 302)
    const mobileCookie = (first.headers.get('set-cookie') ?? '').split(';')[0]
    const originalToken = mobileCookie.split('=')[1]
    const desktopCookie = await t.pairDesktop()

    const disconnect = await httpFetch(`${t.base}/desktop/disconnect`, {
      method: 'POST',
      headers: { Cookie: desktopCookie },
    })
    assert.equal(disconnect.status, 200)
    assert.equal(t.bridge.sessions.size, 0)
    assert.equal(t.bridge.suspendedSessions.size, 1)

    // The phone scans the (rotated) pairing link while still holding its
    // old cookie. The suspended session is revived under that old token.
    const rePair = await pairThrough(mobileCookie)
    assert.equal(rePair.status, 302)
    assert.equal(t.bridge.sessions.size, 1)
    assert.equal(t.bridge.suspendedSessions.size, 0, 'no phantom revived entry')
    // The cookie carries the revived token, not a newly minted one.
    assert.equal((rePair.headers.get('set-cookie') ?? '').split(';')[0], `dsh_mobile=${originalToken}`)

    const devices = async () => {
      const res = await httpFetch(`${t.base}/desktop/status`, { headers: { Cookie: desktopCookie } })
      assert.equal(res.status, 200)
      return (await res.json()).connectedDevices
    }
    assert.equal((await devices()).length, 1, 'one device immediately after re-pair')
    assert.equal((await devices()).length, 1, 'one device after another request')
  } finally {
    await t.stop()
  }
})

test('A LAN: only the most recently issued same-IP suspended entry is revived', () => {
  const bridge = bareBridge()
  const olderToken = randomBytes(32).toString('base64url')
  const newerToken = randomBytes(32).toString('base64url')
  bridge.suspendedSessions.set(olderToken, {
    token: olderToken,
    remoteAddress: '127.0.0.1',
    issuedAt: 1000,
  })
  bridge.suspendedSessions.set(newerToken, {
    token: newerToken,
    remoteAddress: '127.0.0.1',
    issuedAt: 2000,
  })
  bridge.suspendedSessions.set('other-ip', {
    token: 'other-ip',
    remoteAddress: '192.168.1.9',
    issuedAt: 3000,
  })
  const response = mockResponse()
  bridge.issueSessionCookie(
    { headers: { 'user-agent': 'PocketDevice/1.0' } },
    response,
    '127.0.0.1',
    'lan'
  )
  assert.equal(bridge.sessions.size, 1)
  assert.ok(bridge.sessions.has(newerToken), 'the newest entry is the revived session')
  assert.equal(bridge.suspendedSessions.size, 2, 'older and other-IP entries stay suspended')
  assert.ok(bridge.suspendedSessions.has(olderToken))
  assert.ok(bridge.suspendedSessions.has('other-ip'))
  assert.equal(response.headers['set-cookie'].split(';')[0], `dsh_mobile=${newerToken}`)
})

test('A tunnel: the cookie-matched suspended entry is revived without a new session', () => {
  const bridge = bareBridge()
  const token = randomBytes(32).toString('base64url')
  bridge.suspendedSessions.set(token, { token, remoteAddress: '203.0.113.7', issuedAt: 1000 })
  const response = mockResponse()
  bridge.issueSessionCookie(
    { headers: { cookie: `dsh_mobile=${token}`, 'user-agent': 'PocketDevice/1.0' } },
    response,
    '203.0.113.7',
    'tunnel'
  )
  assert.equal(bridge.sessions.size, 1)
  assert.ok(bridge.sessions.has(token))
  assert.equal(bridge.suspendedSessions.size, 0)
  assert.equal(response.headers['set-cookie'].split(';')[0], `dsh_mobile=${token}`)
  assert.match(response.headers['set-cookie'], /Secure/)
})

// ---------------------------------------------------------------------------
// B. 403 not 500
// ---------------------------------------------------------------------------

test('B: verifyTrustedOrigin returns a boolean instead of throwing', () => {
  const bridge = bareBridge()
  const req = (headers) => ({ headers })
  assert.equal(bridge.verifyTrustedOrigin(req({ 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(bridge.verifyTrustedOrigin(req({ 'sec-fetch-site': 'same-origin' })), true)
  assert.equal(
    bridge.verifyTrustedOrigin(req({ origin: 'http://evil.example', host: '127.0.0.1:43127' })),
    false
  )
  assert.equal(
    bridge.verifyTrustedOrigin(req({ origin: 'http://127.0.0.1:43127', host: '127.0.0.1:43127' })),
    true
  )
  // A malformed Origin used to throw out of new URL() and surface as 500.
  assert.equal(bridge.verifyTrustedOrigin(req({ origin: 'http://%%%', host: '127.0.0.1' })), false)
  assert.equal(bridge.verifyTrustedOrigin(req({})), true)
})

test('B full-stack: a cross-site POST gets 403, not 500', async () => {
  const t = await startBridge()
  try {
    // A CSRF carries the victim's existing cookie automatically; the forged
    // sec-fetch-site is what must stop it.
    const cookie = await t.pairMobile()
    const res = await httpFetch(`${t.base}/api/rpc`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(res.status, 403)
    assert.deepEqual(await res.json(), { ok: false, error: 'Cross-site request rejected.' })
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// C. Desktop bootstrap is awaited / single-use
// ---------------------------------------------------------------------------

test('C: the one-time desktop bootstrap cannot be consumed twice', async () => {
  const t = await startBridge()
  try {
    const desktopUrl = t.bridge.createDesktopUrl()
    const first = await httpFetch(desktopUrl)
    assert.equal(first.status, 303)
    const second = await httpFetch(desktopUrl)
    assert.equal(second.status, 403, 'a missed await used to let the token race')
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// D. Windows LAN address picking
// ---------------------------------------------------------------------------

test('D: parseLanAdapterLines parses, trims and filters virtual adapters', () => {
  const output = [
    '192.168.1.20|Intel(R) Ethernet Connection I219-V',
    '10.0.2.15|VirtualBox Host-Only Ethernet Adapter',
    '172.20.0.1|Hyper-V Virtual Ethernet Adapter',
    '100.64.0.5|Tailscale Tunnel',
    '   192.168.56.1 | VMware Virtual Ethernet Adapter   ',
    '',
    'garbage line without separator',
    '10.1.1.5|Realtek PCIe GbE Family Controller',
  ].join('\r\n')
  const entries = parseLanAdapterLines(output)
  assert.deepEqual(
    entries.map(({ ip }) => ip),
    ['192.168.1.20', '10.1.1.5']
  )
  assert.equal(entries[0].description, 'Intel(R) Ethernet Connection I219-V')
})

// ---------------------------------------------------------------------------
// E. Sweep covers suspended and resumable maps
// ---------------------------------------------------------------------------

test('E: sweepExpiredSessions also evicts suspended and resumable entries', () => {
  const bridge = bareBridge({ now: () => 10_000 })
  for (const mapName of ['sessions', 'suspendedSessions', 'resumableSessions']) {
    bridge[mapName].set('alive', { expiresAt: 20_000 })
    bridge[mapName].set('dead', { expiresAt: 5_000 })
    bridge[mapName].set('no-expiry', {})
  }
  bridge.sweepExpiredSessions()
  for (const mapName of ['sessions', 'suspendedSessions', 'resumableSessions']) {
    assert.deepEqual([...bridge[mapName].keys()], ['alive', 'no-expiry'], mapName)
  }
})

// ---------------------------------------------------------------------------
// F. QR replacement and memo
// ---------------------------------------------------------------------------

test('F: pairingQrSvg renders via qr-svg and memoizes per URL', () => {
  const bridge = bareBridge({ now: () => 0 })
  assert.equal(bridge.pairingQrSvg(''), '')
  assert.equal(bridge.pairingQrSvg(undefined), '')
  const url = 'http://127.0.0.1:43127/pair?token=abc'
  const svg = bridge.pairingQrSvg(url)
  assert.match(svg, /^<svg /)
  assert.equal(bridge.pairingQrSvg(url), svg, 'second call serves the memoized SVG')
  assert.equal(bridge.qrSvgCache.size, 1)
  bridge.rotatePairingToken()
  assert.equal(bridge.qrSvgCache.size, 0, 'token rotation invalidates the QR memo')
})

test('F: revokeMobileSessions invalidates the QR memo', () => {
  const bridge = bareBridge({ now: () => 0 })
  bridge.qrSvgCache.set('x', '<svg></svg>')
  bridge.revokeMobileSessions()
  assert.equal(bridge.qrSvgCache.size, 0)
})

// ---------------------------------------------------------------------------
// G. Image buffer caches
// ---------------------------------------------------------------------------

test('G: readCachedImage reads disk once and serves the Buffer thereafter', async () => {
  const bridge = bareBridge()
  const path = join(tmpdir(), `dsh-pocket-icon-${randomBytes(6).toString('hex')}.png`)
  const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
  writeFileSync(path, body)
  try {
    const first = await bridge.readCachedImage(path)
    assert.ok(first.equals(body))
    rmSync(path)
    const second = await bridge.readCachedImage(path)
    assert.ok(second.equals(body), 'deleted file is still served from cache')
    assert.equal(bridge.imageBufferCache.size, 1)
  } finally {
    rmSync(path, { force: true })
  }
})

// ---------------------------------------------------------------------------
// H. noteSavings debug gate
// ---------------------------------------------------------------------------

test('H: noteSavings is a no-op unless DSH_POCKET_DEBUG=1', () => {
  const previous = process.env.DSH_POCKET_DEBUG
  delete process.env.DSH_POCKET_DEBUG
  try {
    const bridge = bareBridge()
    bridge.noteSavings('list', [1, 2, 3], [1])
    assert.equal(bridge._savingsAt, undefined, 'no bookkeeping on hot paths')

    process.env.DSH_POCKET_DEBUG = '1'
    bridge.noteSavings('list', [1, 2, 3], [1])
    assert.ok(bridge._savingsAt instanceof Map)
  } finally {
    if (previous === undefined) delete process.env.DSH_POCKET_DEBUG
    else process.env.DSH_POCKET_DEBUG = previous
  }
})

// ---------------------------------------------------------------------------
// I. SSE status cadence
// ---------------------------------------------------------------------------

test('I: sseStatusMs defaults to 30000 and honors the constructor option', () => {
  assert.equal(bareBridge().sseStatusMs, 30_000)
  assert.equal(bareBridge({ sseStatusMs: 25 }).sseStatusMs, 25)
})

// ---------------------------------------------------------------------------
// K. Per-request CSP nonce
// ---------------------------------------------------------------------------

test('K: the mobile page inline scripts carry the CSP nonce, per request', async () => {
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile()

    const readPage = async () => {
      const res = await httpFetch(`${t.base}/`, { headers: { Cookie: cookie } })
      assert.equal(res.status, 200)
      const csp = res.headers.get('content-security-policy') ?? ''
      const match = csp.match(/script-src 'self' 'nonce-([^']+)'/)
      assert.ok(match, 'CSP must carry a script nonce')
      assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"), 'no unsafe-inline for scripts')
      return { nonce: match[1], html: await res.text() }
    }

    const first = await readPage()
    // Every inline script tag carries the nonce; src-only tags are untouched.
    for (const tag of first.html.match(/<script\b[^>]*>/g) ?? []) {
      if (!/\bsrc=/.test(tag)) assert.match(tag, new RegExp(`nonce="${first.nonce}"`))
    }

    const second = await readPage()
    assert.notEqual(second.nonce, first.nonce, 'a fresh nonce is generated per request')
  } finally {
    await t.stop()
  }
})

test('K: the desktop polling script carries the same nonce as the CSP header', async () => {
  const t = await startBridge()
  try {
    const desktopCookie = await t.pairDesktop()
    const res = await httpFetch(`${t.base}/desktop`, { headers: { Cookie: desktopCookie } })
    assert.equal(res.status, 200)
    const csp = res.headers.get('content-security-policy') ?? ''
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1]
    assert.ok(nonce)
    const html = await res.text()
    assert.match(html, new RegExp(`<script nonce="${nonce}">let end=`))
  } finally {
    await t.stop()
  }
})

test('K: buildContentSecurityPolicy keeps the other directives and nonces scripts', () => {
  const policy = buildContentSecurityPolicy('YWJjZA')
  assert.equal(policy, "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-YWJjZA'; img-src 'self' data:; connect-src 'self'")
})

// ---------------------------------------------------------------------------
// L. Generic 500 body
// ---------------------------------------------------------------------------

test('L: the bridge-wide 500 returns a generic body, never the raw error', async () => {
  const t = await startBridge()
  try {
    t.bridge.handle = async () => {
      throw new Error('secret-internal-detail: C:\\Users\\toast\\.dsh\\profiles\\desktop')
    }
    const res = await httpFetch(`${t.base}/api/status`)
    assert.equal(res.status, 500)
    const body = await res.text()
    assert.deepEqual(JSON.parse(body), { ok: false, error: 'Internal server error.' })
    assert.ok(!body.includes('secret-internal-detail'), 'raw error text must not leak into the body')
  } finally {
    await t.stop()
  }
})
