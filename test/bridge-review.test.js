// Bridge-side review fixes A–K (2026-10-01). Full-stack tests boot the real
// LanMobileBridge over HTTP; the unit-shaped tests call its methods directly
// on a minimally constructed instance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  LanMobileBridge,
  buildContentSecurityPolicy,
  desktopCookieAttributes,
  parseLanAdapterLines,
} from '../lib/bridge.js'
import { startBridge, httpFetch } from './helpers.js'

/** Source text of a repo file, for the structural invariants below. */
const readFileSource = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8')

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

/** A mock that also survives the paths that write a body (`text()` needs both). */
function fullMockResponse() {
  return {
    ...mockResponse(),
    statusCode: 0,
    end() {},
    destroyed: false,
    headersSent: false,
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

// ---------------------------------------------------------------------------
// WP-SEC-BRIDGE B1 — §5 已核对安全项，钉成断言而不是注释
// ---------------------------------------------------------------------------

test('B1: the allowlist does not grow, and every entry is still a named route', async () => {
  const { RPC_ALLOWLIST, HARNESS_ENDPOINTS } = await import('../lib/constants.js')
  // Two more entries than the Host routes would need are the bridge's own reads
  // (session.history, workspace.list); the set is closed, not open-ended.
  assert.equal(RPC_ALLOWLIST.size, Object.keys(HARNESS_ENDPOINTS).length + 2, 'no silent method added')
  assert.ok(!RPC_ALLOWLIST.has('session.delete'), 'destructive methods stay off the phone')
  assert.ok(!RPC_ALLOWLIST.has('system.exec'), 'no host-level escape hatch')
  for (const method of RPC_ALLOWLIST) {
    assert.ok(
      HARNESS_ENDPOINTS[method] || method === 'session.history' || method === 'workspace.list' || method.startsWith('interaction.'),
      `${method} has a translation`
    )
  }
})

test('B1: the bridge never registers an inbound upgrade or WebSocket server', async () => {
  const source = await readFileSource('lib/bridge.js')
  assert.doesNotMatch(source, /on\(['"]upgrade['"]/, 'no inbound upgrade listener')
  assert.doesNotMatch(source, /WebSocketServer|new WebSocket\(/, 'the mux is outbound only')
  assert.match(source, /createMuxMonitor/, 'the carrier stays the outbound monitor')
})

test('B1: the prompt request id is still spread last, so a client cannot pin it', async () => {
  const { HARNESS_ENDPOINTS } = await import('../lib/constants.js')
  const built = HARNESS_ENDPOINTS['session.prompt'].args({ sessionId: 's', requestId: 'client-id' })
  assert.notEqual(built.request.requestId, 'client-id')
  assert.match(built.request.requestId, /^[0-9a-f-]{36}$/)
})

test('B1: an unpaired request has no path to the Host RPC surface', async () => {
  // §5's headline safety conclusion was "未认证方无可达 host RPC 路径". The things
  // that could weaken it are the LAN same-address shortcut, the cookie-shaped
  // mint, and the tunnel fallback — so the reachability claim gets its own pin.
  // The fake Harness records every call it receives: it must record none of
  // these, which is stronger than checking a status code.
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => {
        if (pathname === '/api/session/list') return { ok: true, value: { items: [] } }
        if (pathname === '/api/session/page') return { ok: true, value: { records: [], hasMore: false } }
        return undefined
      },
    },
  })
  try {
    const forged = `dsh_mobile=${randomBytes(32).toString('base64url')}`
    const attempts = [
      { method: 'POST', path: '/api/rpc', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'session.prompt', payload: { sessionId: 's', content: [] } }) },
      { method: 'POST', path: '/api/rpc', headers: { 'content-type': 'application/json', cookie: forged }, body: JSON.stringify({ method: 'session.prompt', payload: { sessionId: 's', content: [] } }) },
      { method: 'GET', path: '/api/boot', headers: {} },
      { method: 'GET', path: '/api/status', headers: { cookie: forged } },
      { method: 'GET', path: '/api/session/stream?sessionId=s', headers: { cookie: forged } },
      { method: 'GET', path: '/api/session-attachment?sessionId=s&attachmentId=a', headers: { cookie: forged } },
      { method: 'GET', path: '/api/session-export?sessionId=s', headers: { cookie: forged } },
    ]
    const before = t.harness.records.calls.length
    for (const attempt of attempts) {
      const res = await httpFetch(`${t.base}${attempt.path}`, {
        method: attempt.method,
        headers: attempt.headers,
        ...(attempt.body ? { body: attempt.body } : {}),
      })
      assert.equal(res.status, 401, `${attempt.method} ${attempt.path} must be refused before any Host call`)
    }
    assert.deepEqual(t.harness.records.calls.slice(before), [], 'the Host saw nothing from an unpaired caller')

    // A paired phone on this address does not open the surface to its neighbours:
    // once the pairing has aged out of the LAN window, a cookie-less peer on the
    // same address — the case the old same-address fallback used to admit — gets
    // nothing at all.
    await t.pairMobile('PocketPeer/1.0')
    for (const session of t.bridge.sessions.values()) session.lastSeenAt = Date.now() - 60_001
    const afterPairing = t.harness.records.calls.length
    const stranger = await httpFetch(`${t.base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'session.list', payload: {} }),
    })
    assert.equal(stranger.status, 401, 'a cookie-less peer on the paired address gets nothing')
    assert.deepEqual(t.harness.records.calls.slice(afterPairing), [], 'and the Host never served it')
  } finally {
    await t.stop()
  }
})

test('B1: every log call is free of credential and payload interpolations', async () => {
  // §5 lists "20 处 this.log() 不落 PIN/token/cookie/正文" as an invariant to keep.
  // A comment cannot keep it; this walks every log line in the bridge and reads
  // what each one actually interpolates. Only the `${ }` holes count — the prose
  // around them may NAME a field precisely because it is not printing it
  // (`invalid or expired token addr=…`) — and only by the identifiers that hold a
  // secret, so `addr=${remoteAddress}` and `label=${label}` stay legal.
  const source = await readFileSource('lib/bridge.js')
  const secretNames = [
    'token',
    'tokens',
    'revivedToken',
    'newestToken',
    'liveToken',
    'incomingToken',
    'presented',
    'expected',
    'deviceId',
    'this\\.ephemeralPin',
    'this\\.pairingToken',
    'this\\.desktopSessionToken',
    'this\\.desktopBootstrapToken',
    'storedPin',
    'pairingPin',
    'pin',
    'cookie',
    'setCookie',
    'authorization',
    'conversation',
  ]
  const holeIsSecret = new RegExp(`\\$\\{[^}]*\\b(?:${secretNames.join('|')})\\b`)
  const lines = source.split(/\r?\n/)
  const offenders = lines
    .filter((line) => /this\.log\(/.test(line) && holeIsSecret.test(line))
    .map((line) => line.trim())
  assert.deepEqual(offenders, [], 'a log line is interpolating a credential or a payload')
  // Not vacuous: the audited log surface is still there.
  assert.ok(
    lines.filter((line) => /this\.log\(/.test(line)).length >= 20,
    'the audited log surface shrank'
  )
})

test('B1: no log line carries a PIN, a cookie value, or conversation text', async () => {
  const lines = []
  const t = await startBridge({
    harness: 'fake',
    bridgeOptions: { log: (level, message) => lines.push(`${level} ${message}`) },
  })
  try {
    const pinCookie = await t.pairMobile('PocketLogger/1.0')
    const token = pinCookie.split('=')[1]
    t.bridge.ephemeralPin = '424242'
    t.bridge.ephemeralPinExpiresAt = Date.now() + 60_000
    await httpFetch(`${t.base}/pair/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'x' },
      body: JSON.stringify({ pin: '000000' }),
    })
    const desktop = await t.pairDesktop()
    await httpFetch(`${t.base}/desktop/status`, { headers: { Cookie: desktop } })
    await httpFetch(`${t.base}/api/rpc`, {
      method: 'POST',
      headers: { cookie: pinCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'session.prompt', payload: { sessionId: 's', content: [{ type: 'text', text: 'a sentence that must never be logged' }] } }),
    })
    const blob = lines.join('\n')
    assert.doesNotMatch(blob, new RegExp(token), 'no session cookie value in the log')
    assert.doesNotMatch(blob, /424242/, 'no pairing password in the log')
    assert.doesNotMatch(blob, /must never be logged/, 'no conversation text in the log')
    assert.doesNotMatch(blob, /dsh_mobile=|dsh_desktop=/, 'no cookie pair in the log')
    // And the invariant is not vacuous: these calls did produce log lines.
    assert.ok(lines.length > 0, 'the bridge does log')
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// WP-SEC-BRIDGE B1 — M2 / M13 / M15 / M16 / M10
// ---------------------------------------------------------------------------

test('B1: authorized() is false for the same address in tunnel mode', async () => {
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile('PocketTunnel/1.0')
    const token = cookie.split('=')[1]
    assert.equal(t.bridge.authorized({ headers: { cookie } }, '127.0.0.1', 'lan'), true, 'the cookie path works')
    // A tunnel request with no cookie from the loopback address the bridge sees:
    // an address behind the carrier is never identity.
    assert.equal(t.bridge.authorized({ headers: {} }, '127.0.0.1', 'tunnel'), false, 'tunnel: no address shortcut')
    assert.equal(t.bridge.authorized({ headers: {} }, '203.0.113.7', 'tunnel'), false)
    // Even a cookie that is not this device's must not be traded for the address.
    assert.equal(t.bridge.authorized({ headers: { cookie: 'dsh_mobile=not-a-token' } }, '127.0.0.1', 'tunnel'), false)
    void token
  } finally {
    await t.stop()
  }
})

test('B1: the LAN address shortcut needs the same fingerprint and a recent sighting', async () => {
  const t = await startBridge()
  try {
    const ua = 'PocketNeighbour/1.0'
    const cookie = await t.pairMobile(ua)
    const token = cookie.split('=')[1]
    const asDevice = (agent) => ({ headers: { 'user-agent': agent } })
    // Never seen with a cookie: the address alone proves nothing.
    assert.equal(t.bridge.authorized(asDevice(ua), '127.0.0.1', 'lan'), false, 'no cookie yet means no sighting')
    // One authenticated request moves the sighting clock.
    assert.equal(t.bridge.authorized({ headers: { cookie, 'user-agent': ua } }, '127.0.0.1', 'lan'), true)
    assert.equal(t.bridge.authorized(asDevice(ua), '127.0.0.1', 'lan'), true, 'the handset that just proved itself')
    assert.equal(t.bridge.authorized(asDevice('PocketOther/9.9'), '127.0.0.1', 'lan'), false, 'a different agent on the same address')
    assert.equal(t.bridge.authorized(asDevice(ua), '10.1.2.3', 'lan'), false, 'a different address')
    // And it ages out.
    t.bridge.sessions.get(token).lastSeenAt = Date.now() - 60_001
    assert.equal(t.bridge.authorized(asDevice(ua), '127.0.0.1', 'lan'), false, 'the window is a minute, not thirty days')
  } finally {
    await t.stop()
  }
})

test('B1: a well-shaped invented cookie mints nothing', async () => {
  const t = await startBridge()
  try {
    await t.pairMobile('PocketReal/1.0')
    const before = t.bridge.suspendedSessions.size
    const forged = `dsh_mobile=${randomBytes(32).toString('base64url')}`
    t.bridge.rememberMobileContext({ headers: { cookie: forged } }, '127.0.0.1', 'lan')
    assert.equal(t.bridge.sessions.size, 1, 'no new live session')
    assert.equal(t.bridge.suspendedSessions.size, before, 'no new parked entry either')
    // Only tokens this bridge actually issued are tracked.
    const res = await httpFetch(`${t.base}/api/status`, { headers: { cookie: forged } })
    assert.equal(res.status, 401, 'shape is not a credential')
  } finally {
    await t.stop()
  }
})

test('B1: a disconnect is a park, and the parked token is the only one that revives', async () => {
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile('PocketPark/1.0')
    const token = cookie.split('=')[1]
    const desktop = await t.pairDesktop()
    await httpFetch(`${t.base}/desktop/disconnect`, { method: 'POST', headers: { Cookie: desktop } })
    assert.equal(t.bridge.sessions.size, 0)
    assert.equal(t.bridge.resumableSessions.has(token), true, 'the device the desktop disconnected is revivable')
    // Same address, forged cookie: nothing to revive, and nothing gets minted.
    const forged = `dsh_mobile=${randomBytes(32).toString('base64url')}`
    const denied = await httpFetch(`${t.base}/reconnect`, { headers: { cookie: forged } })
    assert.notEqual(denied.headers.get('location'), '/')
    assert.equal(t.bridge.sessions.size, 0)
    // The real device gets its session back.
    const revived = await httpFetch(`${t.base}/reconnect`, { headers: { cookie } })
    assert.equal(revived.status, 302)
    assert.equal(revived.headers.get('location'), '/')
    assert.equal(t.bridge.sessions.has(token), true)
  } finally {
    await t.stop()
  }
})

test('B1: brand assets are gated, the service worker is not', async () => {
  const path = join(tmpdir(), `dsh-pocket-brand-${randomBytes(4).toString('hex')}.png`)
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const t = await startBridge({
    bridgeOptions: { brandLogoPaths: { light: path, dark: path }, appIconPath: path },
  })
  try {
    // Unauthenticated.
    assert.notEqual((await httpFetch(`${t.base}/brand-logo/light`)).status, 200, 'brand logo needs a session')
    assert.notEqual((await httpFetch(`${t.base}/brand-logo/dark`)).status, 200)
    assert.notEqual((await httpFetch(`${t.base}/app-icon`)).status, 200, 'app icon needs a session')
    // The worker must stay reachable or the phone cannot install it at all.
    const worker = await httpFetch(`${t.base}/sw.js`)
    assert.equal(worker.status, 200, 'the service worker stays public')
    // A paired phone reads them.
    const cookie = await t.pairMobile('PocketBrand/1.0')
    assert.equal((await httpFetch(`${t.base}/brand-logo/light`, { headers: { cookie } })).status, 200)
    assert.equal((await httpFetch(`${t.base}/app-icon`, { headers: { cookie } })).status, 200)
    // And the desktop pairing page, which renders the brand mark without a phone
    // being paired yet, keeps working through its own session cookie.
    const desktop = await t.pairDesktop()
    assert.equal((await httpFetch(`${t.base}/brand-logo/dark`, { headers: { Cookie: desktop } })).status, 200)
    // The cache headers on these routes are not this change's to touch (§6).
    const paired = await httpFetch(`${t.base}/app-icon`, { headers: { cookie } })
    assert.equal(paired.headers.get('cache-control'), 'public, max-age=86400')
  } finally {
    await t.stop()
    rmSync(path, { force: true })
  }
})

test('B1: the desktop cookie is bounded, and marked Secure off loopback', async () => {
  const t = await startBridge()
  try {
    const res = await httpFetch(t.bridge.createDesktopUrl())
    const setCookie = res.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /^dsh_desktop=/)
    assert.match(setCookie, /Max-Age=\d+/, 'the desktop session expires rather than outliving the process')
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)
    assert.doesNotMatch(setCookie, /Secure/, 'over plain loopback http the flag would drop the cookie outright')
  } finally {
    await t.stop()
  }
  // The other branch is a property of the attributes, not of the route: the
  // bootstrap only answers to loopback today, so a Secure-marked cookie can
  // never be minted for an off-box reader — and if that surface ever opens, the
  // flag is already there.
  assert.match(desktopCookieAttributes('192.168.5.5'), /Secure/)
  assert.doesNotMatch(desktopCookieAttributes('::1'), /Secure/)
  assert.match(desktopCookieAttributes('127.0.0.1'), /Max-Age=\d+/)
  // A non-loopback transport is refused outright.
  const bridge = bareBridge({ now: () => Date.now() })
  const refused = fullMockResponse()
  assert.equal(bridge.consumeDesktopBootstrap('whatever', '192.168.5.5', refused), false)
  assert.equal(refused.headers['set-cookie'], undefined, 'nothing is issued to a non-loopback peer')
  assert.equal(refused.statusCode, 403)
})

test('B1: an unauthenticated internal request is not bounced across origins', async () => {
  const t = await startBridge({
    bridgeOptions: {
      createCloudflareTunnel: async () => ({
        url: 'https://test-tunnel.trycloudflare.com',
        provider: 'cloudflare',
        stop: async () => {},
        process: { once: () => {} },
      }),
    },
  })
  try {
    await t.bridge.toggleTunnel(true)
    assert.equal(t.bridge.tunnelActive, true)
    // LAN transport, tunnel hostname absent → connectionMode 'lan' with the
    // tunnel switched on: exactly the case that used to 302 to the carrier URL.
    for (const path of ['/', '/reconnect', '/disconnected']) {
      const res = await httpFetch(`${t.base}${path}`)
      assert.notEqual(res.status, 302, `${path} must not redirect off-origin`)
      assert.equal(res.headers.get('location'), null, `${path} carries no cross-origin target`)
      assert.equal(res.status, 200, `${path} answers with the local page`)
    }
    const retry = await httpFetch(`${t.base}/pair/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(retry.status, 200)
    assert.equal((await retry.json()).redirectUrl, undefined, 'the JSON recovery path carries no redirect either')
    // The pairing funnel is the one hop that stays, and it needs a live token.
    t.bridge.rotatePairingToken()
    const token = new URL(t.bridge.snapshot().pairingUrl).searchParams.get('token')
    const migrated = await httpFetch(`${t.base}/pair?token=${token}`)
    assert.equal(migrated.status, 302)
    assert.match(migrated.headers.get('location') ?? '', /^https:\/\/test-tunnel\.trycloudflare\.com\/pair/)
    const stale = await httpFetch(`${t.base}/pair?token=expired-token`)
    assert.equal(stale.headers.get('location'), '/reconnect', 'a stranger goes to the local recovery page')
  } finally {
    await t.stop()
  }
})
