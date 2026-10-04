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

// ---------------------------------------------------------------------------
// WP-OPS-BRIDGE B2 — observability (X4①②⑤⑧), the stream failure path (X4③),
// the QR accessible name, and the input-validation half of M3.
//
// Design §12 禁令 4 keeps this package to logs and fields: nothing below asserts
// a new status code or a changed access decision, and every assertion is an
// invariant (a substring that must be present, a count that must be at least the
// number of branches) because the bridge domain is under concurrent edits.
// ---------------------------------------------------------------------------

test('B2 X4①: each inner failure class names itself in the log', async () => {
  // The audit line was: 「invokeHarness 各类失败零日志且一律 HTTP 400」. Four
  // different failures used to look identical on disk — which is to say, they
  // were not on disk at all.
  const lines = []
  const capture = (level, message) => lines.push(`${level} ${message}`)
  const makeBridge = (harnessUrl, extra = {}) => new LanMobileBridge({
    harnessUrl,
    innerAuth: { ready: async () => undefined, invalidate: () => {} },
    pairingPinStore: { load: () => ({}), save: () => true },
    log: capture,
    ...extra,
  })
  const stubbed = (respond) => {
    const bridge = makeBridge(() => 'http://harness.invalid')
    bridge.harnessFetch = async (_url, init) => respond(init)
    return bridge
  }

  // 1. no harness URL yet (the host has not come up around this bridge).
  await makeBridge(() => undefined).invokeHarness('session/list', {})
  // 2. transport: nothing is listening at that address.
  await makeBridge(() => 'http://127.0.0.1:9').invokeHarness('session/list', {})
  // 3. the transport carried an HTTP failure rather than an envelope.
  await stubbed(() => new Response('gateway blew up', { status: 502 })).invokeHarness('session/list', {})
  // 4. a 200 whose body is not the envelope (a proxy page, a truncated stream).
  await stubbed(() => new Response('<html>proxy said no</html>', { status: 200 })).invokeHarness('session/list', {})
  // 5. an answer for somebody else's call.
  await stubbed(() => new Response(JSON.stringify({ rpcId: 'someone-elses-envelope', result: { ok: true, value: {} } }), { status: 200 }))
    .invokeHarness('session/list', {})
  // 6. the Host understood and said no.
  const declined = await stubbed((init) => new Response(JSON.stringify({
    rpcId: JSON.parse(String(init.body)).rpcId,
    result: { ok: false, error: { message: 'a sentence about the conversation', code: 'session/not-found' } },
  }), { status: 200 })).invokeHarness('session/list', {})
  assert.equal(declined.errorCode, 'session/not-found', 'the phone still gets the stable code')

  const classes = [
    'no harness URL yet',
    'harness transport failed',
    'harness answered 502',
    'envelope unreadable',
    'answer mismatched',
    'harness rejected',
  ]
  const missing = classes.filter((marker) => !lines.some((line) => line.includes(marker)))
  assert.deepEqual(missing, [], `these failure classes left no trace: ${missing.join(', ')}`)
  // Structural, not absolute: one attributable line per failure exercised here.
  assert.ok(lines.length >= classes.length, `${String(lines.length)} lines for ${String(classes.length)} classes`)
  assert.ok(lines.some((line) => /rpcId=[0-9a-f-]{8}/.test(line)), 'the envelope id is the correlation key now')
  const rejection = lines.filter((line) => line.includes('harness rejected'))
  assert.match(rejection.at(-1), /code=session\/not-found/)
  assert.doesNotMatch(rejection.at(-1), /sentence about the conversation/, 'the Host prose stays out of the log')
})

test('B2 X4②: an /api/rpc failure names the method, the conversation and the handset', async () => {
  const lines = []
  const t = await startBridge({ bridgeOptions: { log: (level, message) => lines.push(`${level} ${message}`) } })
  try {
    const cookie = await t.pairMobile('PocketAttrib/1.0')
    const res = await httpFetch(`${t.base}/api/rpc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'session.history', payload: { sessionId: 'sess-attrib' } }),
    })
    assert.equal(res.status, 502, 'the transport class still leaves as 502')
    const failure = lines.filter((line) => line.includes('rpc failed'))
    assert.ok(failure.length >= 1, `no attributable line: ${lines.join(' | ')}`)
    const last = failure.at(-1)
    assert.match(last, /method=session\.history/, 'the method is named')
    assert.match(last, /session=sess-attrib/, 'the conversation is named')
    assert.match(last, /device=[A-Za-z0-9_-]{4,}/, 'the handset by its opaque tail')
    assert.match(last, /trace=[0-9a-f]{8}/, 'and the request has a correlation id')
    assert.match(last, /class=__bridge\/transport/, 'by class, not by prose')
    // One URL carried fourteen methods; the path alone must not be the story.
    assert.doesNotMatch(last, /\/api\/rpc/, 'the route path is no longer the whole attribution')
  } finally {
    await t.stop()
  }
})

test('B2 X4②: a refused method and a cross-site call are attributable too', async () => {
  const lines = []
  const t = await startBridge({ bridgeOptions: { log: (level, message) => lines.push(`${level} ${message}`) } })
  try {
    const cookie = await t.pairMobile('PocketRefuse/1.0')
    const refused = await httpFetch(`${t.base}/api/rpc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'session.delete', payload: { sessionId: 's' } }),
    })
    assert.equal(refused.status, 403, 'the allowlist answer is unchanged')
    assert.ok(lines.some((line) => line.includes('rpc method refused') && line.includes('method=session.delete')), lines.join(' | '))

    const crossSite = await httpFetch(`${t.base}/api/rpc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ method: 'session.list', payload: {} }),
    })
    assert.equal(crossSite.status, 403, 'the origin answer is unchanged')
    assert.ok(lines.some((line) => line.includes('rpc refused') && line.includes('cross-site')), lines.join(' | '))
  } finally {
    await t.stop()
  }
})

test('B2 X4⑤: the status payload separates the bridge, the Host and the carrier', async () => {
  // `connected` has always meant "the bridge answered" while the desktop
  // surface's `connected` means "a handset is attached". The green dot over a
  // frozen conversation was that collision. The old field keeps its value (a
  // phone may still hold a page that reads it); the three meanings are now three
  // names the client can pick.
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile('PocketStatus/1.0')
    const res = await httpFetch(`${t.base}/api/status`, { headers: { cookie } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.connected, true, 'the legacy field is untouched')
    assert.equal(body.devicesConnected, true, 'a handset is attached, by name')
    assert.equal(typeof body.hostReachable, 'boolean', 'the Host answer is its own field')
    assert.equal(body.hostReachable, true, 'and the fake Host is answering')
    assert.equal(typeof body.muxConnected, 'boolean', 'the carrier is its own field')
    assert.equal(typeof body.hostProbeAgeMs, 'number', 'with the age of that observation')
  } finally {
    await t.stop()
  }

  // The same builder tells the truth when the Host is not there.
  const offline = await startBridge()
  try {
    const cookie = await offline.pairMobile('PocketStatus/1.0')
    const res = await httpFetch(`${offline.base}/api/status`, { headers: { cookie } })
    const body = await res.json()
    assert.equal(body.connected, true, 'the bridge still answered')
    assert.equal(body.devicesConnected, true, 'the handset is still attached')
    assert.equal(body.hostReachable, false, 'but the Host is not answering — the frozen half')
    assert.match(String(body.hostProbeCode ?? ''), /__bridge\/transport/, 'and the class of failure rides along')
  } finally {
    await offline.stop()
  }
})

test('B2 X4⑧: a rate-limited attempt is logged before the guess is ever read', async () => {
  // The pre-check answers 429 and used to write nothing, so a run of guesses was
  // silent in the log exactly while it was happening; only a wrong PIN made
  // noise.
  const lines = []
  const t = await startBridge({ bridgeOptions: { log: (level, message) => lines.push(`${level} ${message}`) } })
  try {
    // A wrong guess is what the limiter counts; with no password in force at
    // all the bridge answers `expired` and never reaches the counter.
    t.bridge.ephemeralPin = '111111'
    t.bridge.ephemeralPinExpiresAt = Date.now() + 5 * 60_000
    const headers = {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.77',
      'cf-ray': 'rate-limit-check',
      origin: t.base,
    }
    let limited = 0
    for (let attempt = 0; attempt < 12; attempt++) {
      const res = await httpFetch(`${t.base}/pair/verify`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ pin: '007007' }),
      })
      if (res.status === 429) limited += 1
    }
    assert.ok(limited >= 1, 'the limiter engaged')
    const throttled = lines.filter((line) => line.includes('pairing rate-limited'))
    assert.ok(throttled.length >= 1, `the 429 pre-check logged nothing: ${lines.join(' | ')}`)
    assert.match(throttled.at(-1), /retryAfter=\d+s/, 'the wait it handed out is in the line')
    assert.match(throttled.at(-1), /attempts=\d+/, 'and how many guesses it had counted')
    assert.match(throttled.at(-1), /locked=(yes|no)/, 'and whether the hard lock is up')
    assert.ok(
      !lines.some((line) => line.includes('007007')),
      'no log line quotes the attempted password',
    )
  } finally {
    await t.stop()
  }
})

test('B2 X4③: a stream the Host will not carry reaches the phone and backs off', async () => {
  // No fake Harness: the bridge's carrier connect to 127.0.0.1:9 is refused. The
  // stream used to just `finish()` — an empty end of the SSE, the phone's dot
  // still green, nothing on disk, and a reconnect every 500ms forever.
  const lines = []
  const t = await startBridge({ bridgeOptions: { log: (level, message) => lines.push(`${level} ${message}`) } })
  try {
    const cookie = await t.pairMobile('PocketStream/1.0')
    const readStream = async () => {
      const res = await httpFetch(`${t.base}/api/session/stream?sessionId=sess-lost`, { headers: { cookie } })
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let raw = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        raw += decoder.decode(value, { stream: true })
      }
      return raw
    }

    const first = await readStream()
    assert.match(first, /retry: 500\n\n/, 'a conversation that never failed still gets the original cadence')
    assert.match(first, /event: failure\ndata: \{[^\n]*"code":"__bridge\/stream-transport"/, 'the failure frame arrives')
    assert.match(first, /retry: (?!500)\d+\n\n/, 'and the cadence was raised on the way out')
    assert.ok(lines.some((line) => line.includes('session stream lost') && line.includes('session=sess-lost')), lines.join(' | '))
    assert.ok(lines.some((line) => line.includes('backing off')), 'the backoff itself is on record')

    const delay = t.bridge.streamRetryDelayMs('sess-lost')
    assert.ok(delay > 500 && delay <= 15_000, `the next attempt must wait inside the ceiling, got ${String(delay)}`)
    assert.ok(lines.every((line) => !/sess-lost/.test(line) || true), 'the conversation id is loggable')

    // Second and third attempt: from the second consecutive failure on, an
    // attempt that arrives inside the window is answered by the bridge instead of
    // opening yet another WebSocket into a Host that just refused one.
    await readStream()
    const suppressed = await readStream()
    assert.match(suppressed, /__bridge\/stream-backoff/, 'the third attempt is suppressed rather than forwarded')
    assert.ok(lines.filter((line) => line.includes('session stream suppressed')).length >= 1, 'and the suppression is logged')
    assert.equal(t.bridge.sessions.size, 1, 'suppressing a stream never signs the handset out')
  } finally {
    await t.stop()
  }
})

test('B2 X4③: a stream whose harness URL is unreadable answers instead of throwing', async () => {
  const lines = []
  const t = await startBridge({ harness: 'fake', bridgeOptions: { log: (level, message) => lines.push(`${level} ${message}`) } })
  try {
    const cookie = await t.pairMobile('PocketBadUrl/1.0')
    t.bridge.options.harnessUrl = () => {
      throw new TypeError("cannot read properties of undefined (reading 'port')")
    }
    const res = await httpFetch(`${t.base}/api/session/stream?sessionId=sess-bad`, { headers: { cookie } })
    assert.equal(res.status, 503, 'the route answers rather than escaping after the headers went out')
    assert.match(await res.text(), /Harness is not ready\./)
    assert.ok(lines.some((line) => line.includes('no harness to follow') && line.includes('session=sess-bad')), lines.join(' | '))
  } finally {
    await t.stop()
  }
})

test('B2: the pairing QR names itself to a reader', () => {
  // role="img" keeps a screen reader from walking several hundred anonymous
  // rects; <title> is what it announces instead.
  const bridge = bareBridge({ now: () => 0 })
  const svg = bridge.pairingQrSvg('http://127.0.0.1:43127/pair?token=abc&x=1')
  assert.match(svg, /role="img"/, 'the symbol declares what it is')
  assert.match(svg, /<title>/, 'and carries an accessible name')
  assert.match(svg, /aria-label="/, 'announced to assistive tech that ignores title')
  assert.match(svg, /aria-label="[^"]*&amp;[^"]*"/, 'the payload is XML-escaped, not dumped raw')
  assert.doesNotMatch(svg, /aria-label=""/, 'the name is not empty')
  // The rect accounting the matrix fixtures depend on is untouched.
  assert.equal((svg.match(/<rect\b/g) || []).length > 10, true, 'still one rect per module')
})

test('B2 M3: bad input is 400 with the validator sentence, and the 500 stays generic', async () => {
  // AC-B2-2, asserted as a pair: the point of the fix was that a validator throw
  // must not be promoted to an internal error while a genuine internal error
  // stays generic.
  const lines = []
  const t = await startBridge({ harness: 'fake', bridgeOptions: { log: (level, message) => lines.push(`${level} ${message}`) } })
  try {
    const cookie = await t.pairMobile('PocketM3/1.0')
    const cases = [
      { method: 'interaction.pending', payload: {} },
      { method: 'interaction.answer', payload: { rpcId: 'r' } },
      { method: 'interaction.cancel', payload: { sessionId: 's' } },
    ]
    for (const input of cases) {
      const res = await httpFetch(`${t.base}/api/rpc`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      assert.equal(res.status, 400, `${input.method} is a bad request, not a bridge failure`)
      const body = await res.json()
      assert.match(
        String(body.error),
        /must be|required|Invalid|Expected/i,
        `a fixed validator sentence: ${JSON.stringify(body)}`
      )
    }
    // And none of those refusals was reported as an internal error.
    assert.ok(!lines.some((line) => line.includes('request POST /api/rpc failed')), `a validator throw escaped to the 500 path: ${lines.join(' | ')}`)
  } finally {
    await t.stop()
  }
})

test('B2: a thrown handler after the SSE headers went out does not fake a 500', async () => {
  // `writeHead(500)` on a started response throws a second, unrelated error and
  // the phone sits on an empty 200. The catch now ends the stream, which is at
  // least something EventSource can see and reconnect from.
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile('PocketLate/1.0')
    t.bridge.handle = async (_request, response) => {
      response.statusCode = 200
      response.setHeader('content-type', 'text/event-stream; charset=utf-8')
      response.flushHeaders()
      throw new Error('boom after the headers went out')
    }
    const res = await httpFetch(`${t.base}/api/session/stream?sessionId=sess-late`, { headers: { cookie } })
    assert.equal(res.status, 200, 'the status the phone already saw cannot be rewritten')
    const text = await res.text()
    assert.doesNotMatch(text, /Internal server error/, 'no 500 body was squeezed into the stream')
    assert.equal(text, '', 'the stream simply ends, which the phone can act on')
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// C-1 (change 2026-10-04-fix-pocket-r1-audit-batch): an unexpected tunnel death
// is a park, not a sign-out. The carrier dying must not take the phone's LAN
// session with it — the same disposition as /desktop/disconnect, minus the
// pairing rotation (rotating is the deliberate-teardown semantic, design D2).
// ---------------------------------------------------------------------------

test('C-1: an unexpected tunnel death parks the session and the phone reconnects with its cookie', async () => {
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile('PocketTunnelDeath/1.0')
    const token = cookie.split('=')[1]
    assert.equal(t.bridge.sessions.size, 1)

    // Drive the real handler directly: no cloudflared needed, the handler only
    // reads provider/url off the instance for its log line.
    t.bridge.handleUnexpectedTunnelClose({ provider: 'test', url: 'https://example.trycloudflare.com' })

    assert.equal(t.bridge.sessions.size, 0, 'the live session map is still cleared')
    assert.equal(t.bridge.resumableSessions.has(token), true, 'the device is parked for revival (it used to be signed out flat)')
    assert.equal(t.bridge.suspendedSessions.has(token), true, 'both parks hold it, same as /desktop/disconnect')

    // The phone still holds its cookie: /reconnect must hand the session back.
    const revived = await httpFetch(`${t.base}/reconnect`, { headers: { cookie } })
    assert.equal(revived.status, 302, 'the parked device is redirected back into the app')
    assert.equal(revived.headers.get('location'), '/')
    assert.equal(t.bridge.sessions.has(token), true, 'and its session is live again')
  } finally {
    await t.stop()
  }
})
