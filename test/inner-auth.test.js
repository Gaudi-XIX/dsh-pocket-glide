// WP-OPS-BRIDGE B2 / inner-auth end-to-end.
//
// Two invariants of the inner credential had ZERO coverage before this file,
// because the shared test harness stubs `innerAuth` as `ready: async () =>
// undefined`: the bridge's whole loop back into the Host ran with no cookie at
// all, so nothing on disk proved the chain works.
//
//   ① every bridge→Host request declares `content-type: application/json` — the
//      Host `/api` surface is a json-wire Remote gateway, and the body-less GET
//      (session export) used to be the one call that left without it;
//   ② the redeemed `dsh-auth-…` cookie NEVER travels back out to a phone — it is
//      a process credential that can call the Host directly, so leaking it in a
//      response header or body hands the handset (or anything that can read a
//      response) the desktop's own authority.
//
// Self-contained on purpose: `test/helpers.js` is shared with the pages chain
// while this change runs, and editing it would make both workers red at once.
// The fake Host and the fake container below belong to this file only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LanMobileBridge } from '../lib/bridge.js'
import { createInnerAuth } from '../lib/inner-auth.js'

const INNER_PAIR = 'dsh-auth-9f8e=INNER-CREDENTIAL-DO-NOT-LEAK'
const INNER_VALUE = 'INNER-CREDENTIAL-DO-NOT-LEAK'
const LAUNCH_TOKEN = 'launch-token-1'

/** fetch-shaped request over node:http with no keep-alive pool. */
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const headers = { ...(options.headers ?? {}) }
    if (options.body != null) headers['content-length'] = Buffer.byteLength(String(options.body))
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: options.method ?? 'GET',
        headers,
        agent: false,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: {
              get: (name) => {
                const value = res.headers[String(name).toLowerCase()]
                return Array.isArray(value) ? value[0] : (value ?? null)
              },
              raw: res.headers,
            },
            text: async () => body.toString('utf8'),
            json: async () => JSON.parse(body.toString('utf8')),
            bodyBytes: body,
          })
        })
      }
    )
    req.on('error', reject)
    if (options.body != null) req.write(options.body)
    req.end()
  })
}

/**
 * A Host that redeems a launch token into the browser-auth cookie and refuses
 * every `/api` call that does not carry it — the way the connection plugin does.
 * Records each inbound request so the assertions can read the wire, not the code.
 */
function startFakeHost() {
  /** @type {Array<{ method: string, path: string, headers: Record<string, string|string[]> }>} */
  const inbound = []
  let redemptions = 0

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://fake-host')
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      inbound.push({ method: req.method ?? '?', path: u.pathname, headers: req.headers })
      if (u.pathname === '/connection/launch' && u.searchParams.get('token') === LAUNCH_TOKEN) {
        redemptions += 1
        // Two cookies in one header, the second with an `Expires` that contains a
        // comma — the exact shape a naive split would break on.
        res.writeHead(303, {
          location: '/',
          'set-cookie': `${INNER_PAIR}; Path=/; HttpOnly; SameSite=Strict, other=1; Path=/; Expires=Wed, 29 Oct 2026 10:00:00 GMT`,
        })
        res.end()
        return
      }
      if (!u.pathname.startsWith('/api/')) {
        res.writeHead(404).end()
        return
      }
      const cookie = String(req.headers.cookie ?? '')
      if (!cookie.includes('dsh-auth-')) {
        // The inner check has no loopback exemption on this line: a phone cookie
        // cannot satisfy it, and the bridge has to present its own credential.
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }).end('browser auth required')
        return
      }
      // The Host endpoint is the dotted one; the phone-facing route is
      // `/api/session-export`. Both spellings matter to this file's assertions.
      if (u.pathname === '/api/session.export') {
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="s.zip"' })
        res.end(Buffer.from('ZIPBYTES'))
        return
      }
      let envelope = {}
      try {
        envelope = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        envelope = {}
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      const value = u.pathname === '/api/session/list'
        ? { items: [{ sessionId: 'sess-inner', updatedAt: 1, projections: { asOfSeq: 7 } }] }
        : u.pathname === '/api/session/page'
          ? { records: [{ seq: 1, type: 'user/message', data: {} }], hasMore: false }
          : u.pathname === '/api/settings/describe'
            ? { namespaces: [] }
            : {}
      res.end(JSON.stringify({ rpcId: envelope.rpcId, result: { ok: true, value } }))
    })
  })

  return new Promise((resolve) => {
    // The bridge opens its mux carrier as soon as a phone is paired. Refusing the
    // upgrade outright (rather than leaving the socket hanging) keeps that
    // monitor's failure path fast and deterministic; the carrier is not what this
    // file pins.
    server.on('upgrade', (_req, socket) => socket.destroy())
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${String(server.address().port)}`,
      inbound,
      redemptions: () => redemptions,
      stop: () => new Promise((done) => {
        server.closeAllConnections()
        server.close(() => done())
      }),
    }))
  })
}

/** Boot the real bridge with the REAL inner-auth chain against the fake Host. */
async function startRealChain(hostUrl) {
  const root = mkdtempSync(join(tmpdir(), 'pocket-inner-auth-'))
  const savedDshHome = process.env.DSH_HOME
  const savedDshMobilePort = process.env.DSH_MOBILE_PORT
  process.env.DSH_HOME = root
  process.env.DSH_MOBILE_PORT = ''
  const innerAuth = createInnerAuth(() => `${hostUrl}/connection/launch?token=${LAUNCH_TOKEN}`)
  const bridge = new LanMobileBridge({
    harnessUrl: () => hostUrl,
    innerAuth,
    locale: 'zh',
    port: 0,
    pairingPinStore: { load: () => ({}), save: () => true },
    tunnelLog: () => {},
  })
  const snapshot = await bridge.start()
  const base = `http://127.0.0.1:${String(snapshot.port)}`
  const token = new URL(snapshot.pairingUrl).searchParams.get('token')
  const paired = await request(`${base}/pair?token=${String(token)}`, { headers: { 'user-agent': 'PocketInnerAuth/1.0' } })
  const mobileCookie = String(paired.headers.get('set-cookie') ?? '').split(';')[0]
  // `/api/boot` refuses until a workspace baseline exists, and that baseline
  // rides the mux carrier — which this fake Host does not serve, because this
  // file pins the inner credential and not the carrier. Seeding the snapshot is
  // the only stub in here; the auth chain itself stays entirely real.
  bridge.workspaceSnapshot = { items: [] }

  async function stop() {
    await bridge.stop()
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    if (savedDshMobilePort === undefined) delete process.env.DSH_MOBILE_PORT
    else process.env.DSH_MOBILE_PORT = savedDshMobilePort
    rmSync(root, { recursive: true, force: true })
  }

  return { bridge, base, mobileCookie, innerAuth, stop }
}

test('inner-auth redeems the launch token and keeps only the browser-auth pair', async () => {
  const host = await startFakeHost()
  try {
    const innerAuth = createInnerAuth(() => `${host.url}/connection/launch?token=${LAUNCH_TOKEN}`)
    const cookie = await innerAuth.ready()
    assert.equal(cookie, INNER_PAIR, 'exactly the name=value pair, no attributes')
    assert.equal(await innerAuth.ready(), cookie, 'cached: the token is single-use and is not burned twice')
    assert.equal(host.redemptions(), 1, 'one redemption per credential')
    innerAuth.invalidate()
    assert(await innerAuth.ready(), 'and a re-issue works after invalidation')
    assert.equal(host.redemptions(), 2)
  } finally {
    await host.stop()
  }
})

test('every bridge→Host /api call carries the json content type and the inner cookie', async () => {
  const host = await startFakeHost()
  const chain = await startRealChain(host.url)
  try {
    const headers = { cookie: chain.mobileCookie, 'content-type': 'application/json' }
    const status = await request(`${chain.base}/api/status`, { headers })
    assert.equal(status.status, 200, 'the inner call succeeded, so the credential really was accepted')
    const boot = await request(`${chain.base}/api/boot`, { headers })
    assert.equal(boot.status, 200)
    const rpc = await request(`${chain.base}/api/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method: 'session.list', payload: {} }),
    })
    assert.equal(rpc.status, 200)
    const exportRes = await request(`${chain.base}/api/session-export?sessionId=sess-inner`, { headers })
    assert.equal(exportRes.status, 200)

    const inner = host.inbound.filter((entry) => entry.path.startsWith('/api/'))
    assert.ok(inner.length >= 4, `the Host was reached at least four times, saw ${String(inner.length)}`)
    for (const entry of inner) {
      const declared = Object.keys(entry.headers).find((name) => name.toLowerCase() === 'content-type')
      assert.equal(
        String(entry.headers[declared ?? '']).split(';')[0].trim(),
        'application/json',
        `${entry.method} ${entry.path} must declare the json wire it is speaking`,
      )
      assert.match(String(entry.headers.cookie ?? ''), /dsh-auth-/, `${entry.path} must carry the process credential`)
    }
    // Both verb shapes are covered: the RPC is a POST with a body, the export a
    // GET with none — the one that used to leave without a content type.
    assert.ok(inner.some((entry) => entry.method === 'GET'), 'a body-less GET is in the set being asserted')
  } finally {
    await chain.stop()
    await host.stop()
  }
})

test('the inner credential never travels back out to a phone', async () => {
  const host = await startFakeHost()
  const chain = await startRealChain(host.url)
  try {
    const headers = { cookie: chain.mobileCookie, 'content-type': 'application/json' }
    const surfaces = [
      await request(`${chain.base}/`, { headers }),
      await request(`${chain.base}/api/status`, { headers }),
      await request(`${chain.base}/api/boot`, { headers }),
      await request(`${chain.base}/api/rpc`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ method: 'session.list', payload: {} }),
      }),
      await request(`${chain.base}/api/session-export?sessionId=sess-inner`, { headers }),
    ]
    assert.ok(surfaces.every((entry) => entry.status < 500), `the surfaces answered, got ${surfaces.map((entry) => String(entry.status)).join(',')}`)
    for (const entry of surfaces) {
      const headerBlob = JSON.stringify(entry.headers.raw)
      assert.ok(!headerBlob.includes(INNER_VALUE), 'no response header carries the inner credential')
      assert.ok(!headerBlob.includes('dsh-auth-'), 'no response header carries the inner cookie name either')
      assert.ok(!entry.bodyBytes.includes(INNER_VALUE), 'no response body carries it')
      // What a phone IS handed stays exactly the two cookies it should have.
      const setCookie = String(entry.headers.get('set-cookie') ?? '')
      assert.ok(!/dsh-auth-/.test(setCookie), `the browser-auth cookie is never issued to a handset: ${setCookie}`)
    }
    // And the pairing surface the phone actually received only ever names its own cookie.
    assert.match(chain.mobileCookie, /^dsh_mobile=/)
  } finally {
    await chain.stop()
    await host.stop()
  }
})

test('a phone cookie presented to the Host surface is not the inner credential', async () => {
  // The reason the redemption exists: the bridge may not satisfy the inner check
  // by forwarding whatever the handset sent. Assert the Host sees the inner pair
  // even when the phone asked with a cookie that has no authority of its own.
  const host = await startFakeHost()
  const chain = await startRealChain(host.url)
  try {
    const rpc = await request(`${chain.base}/api/rpc`, {
      method: 'POST',
      headers: { cookie: 'dsh_mobile=not-a-real-session', 'content-type': 'application/json' },
    })
    assert.equal(rpc.status, 401, 'an unpaired handset gets refused by the bridge before any inner call')
    const inner = host.inbound.filter((entry) => entry.path.startsWith('/api/'))
    assert.deepEqual(inner, [], 'the Host was never asked to trust anything the phone presented')
  } finally {
    await chain.stop()
    await host.stop()
  }
})

// ---------------------------------------------------------------------------
// RA-1 / RA-4 (rescan-auth): the redemption must be bounded, and invalidating
// it must actually take effect.
//
// Before this change `redeem()` sent no signal and `ready()` handed out one
// promise that could stay pending forever, while `invalidate()` cleared only
// the settled cache — so a stalled exchange pinned every caller, could not be
// discarded, and its (already rejected) credential was written back into the
// cache the moment it did settle.
//
// `node --test` has no default per-test timeout, so every await on a possibly
// hung promise below is wrapped in a race against a local deadline: a
// regression fails the assertion instead of hanging the run.
// ---------------------------------------------------------------------------

/** Resolve to `{ settled, value }` instead of hanging when the promise never settles. */
function settlesWithin(promise, milliseconds) {
  return Promise.race([
    promise.then((value) => ({ settled: true, value })),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ settled: false }), milliseconds)
      timer.unref?.()
    }),
  ])
}

test('a redemption that never answers releases its caller instead of pinning it', async () => {
  // An honest stalled Host: the launch request is accepted and simply never
  // answered, so only the redemption deadline can end the wait. The production
  // deadline is 30 s; `AbortSignal.timeout` is a live, writable static that the
  // module reads at call time, so it is shortened for the test and restored.
  const held = []
  const server = http.createServer(() => {
    // Never respond.
  })
  server.on('connection', (socket) => held.push(socket))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const originalTimeout = AbortSignal.timeout
  AbortSignal.timeout = (milliseconds) => originalTimeout(Math.min(milliseconds, 50))
  try {
    const innerAuth = createInnerAuth(
      () => `http://127.0.0.1:${String(port)}/connection/launch?token=${LAUNCH_TOKEN}`,
    )
    const first = await settlesWithin(innerAuth.ready(), 2000)
    assert.equal(first.settled, true, 'the deadline ended the stalled redemption')
    assert.equal(first.value, undefined, 'a stalled redemption yields no credential, it does not throw')
    // The in-flight slot was cleared too, so the handle is usable rather than
    // permanently attached to a dead exchange.
    const second = await settlesWithin(innerAuth.ready(), 2000)
    assert.equal(second.settled, true, 'the next call is not stuck behind the dead exchange')
  } finally {
    AbortSignal.timeout = originalTimeout
    for (const socket of held) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the redemption always carries a deadline, and a caller signal joins it', async () => {
  /** @type {any} */
  let seen
  const innerAuth = createInnerAuth(
    () => 'http://inner.invalid/connection/launch?token=t',
    async (_url, init) => {
      seen = init
      return { headers: { get: () => null } }
    },
  )
  await innerAuth.ready()
  assert.ok(seen.signal instanceof AbortSignal, 'the exchange is always cancellable')

  const controller = new AbortController()
  const other = createInnerAuth(
    () => 'http://inner.invalid/connection/launch?token=t',
    async (_url, init) => {
      seen = init
      return { headers: { get: () => null } }
    },
  )
  await other.ready(controller.signal)
  controller.abort()
  assert.equal(seen.signal.aborted, true, 'the caller signal is combined into the redemption signal')

  const already = new AbortController()
  already.abort()
  assert.equal(await other.ready(already.signal), undefined, 'an already-aborted caller starts nothing')
})

test('invalidate() discards an exchange that is still in flight', async () => {
  let redemptions = 0
  /** @type {() => void} */
  let releaseFirst
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const innerAuth = createInnerAuth(
    () => `http://inner.invalid/connection/launch?token=${LAUNCH_TOKEN}`,
    async () => {
      redemptions += 1
      const mine = redemptions
      if (mine === 1) await firstGate
      return { headers: { get: () => `dsh-auth-g${String(mine)}=value-${String(mine)}` } }
    },
  )
  const stale = innerAuth.ready() // exchange #1, still pending
  innerAuth.invalidate() // the Host just rejected generation 1
  const fresh = innerAuth.ready() // must not join the rejected exchange
  releaseFirst()
  assert.equal(await fresh, 'dsh-auth-g2=value-2', 'invalidation started a fresh redemption')
  assert.equal(await stale, 'dsh-auth-g1=value-1', 'the older exchange still answers its own caller')
  assert.equal(redemptions, 2, 'exactly one new redemption, no concurrent duplicate')
  assert.equal(await innerAuth.ready(), 'dsh-auth-g2=value-2', 'the stale value did not repopulate the cache')
  assert.equal(redemptions, 2, 'and nothing was redeemed again')
})

test('a cached credential expires so the next call re-redeems', async () => {
  // RA-3 (rescan-auth): the cache used to have no age, so a consumer that has
  // no 401 retry of its own (the mux carrier, the session stream) kept
  // presenting a credential the Host had already rotated away.
  let redemptions = 0
  const innerAuth = createInnerAuth(
    () => `http://inner.invalid/connection/launch?token=${LAUNCH_TOKEN}`,
    async () => {
      redemptions += 1
      return { headers: { get: () => `dsh-auth-g${String(redemptions)}=value-${String(redemptions)}` } }
    },
    { ttlMs: 40 },
  )
  assert.equal(await innerAuth.ready(), 'dsh-auth-g1=value-1')
  assert.equal(await innerAuth.ready(), 'dsh-auth-g1=value-1', 'inside the TTL the copy is reused')
  assert.equal(redemptions, 1, 'so the single-use token is not burned on every call')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(await innerAuth.ready(), 'dsh-auth-g2=value-2', 'past the TTL it is re-redeemed')
  assert.equal(redemptions, 2, 'exactly once, not once per caller')
})

test('the cached credential is bounded well inside the host cookie lifetime', async () => {
  // The host issues the browser-auth cookie for 30 days by default. The bridge
  // must distrust its own copy long before the host would reject it, otherwise
  // a rotation leaves the retry-less consumers stuck on a dead credential.
  const { INNER_AUTH_TTL_MS, INNER_AUTH_TIMEOUT_MS } = await import('../lib/inner-auth.js')
  assert.ok(INNER_AUTH_TTL_MS > 0, 'there is a TTL at all')
  assert.ok(
    INNER_AUTH_TTL_MS < 24 * 60 * 60 * 1000,
    `the TTL is shorter than a day, saw ${String(INNER_AUTH_TTL_MS)}ms`,
  )
  assert.ok(INNER_AUTH_TIMEOUT_MS > 0, 'the redemption deadline is real')
  assert.ok(
    INNER_AUTH_TIMEOUT_MS <= 60_000,
    `the deadline is bounded, saw ${String(INNER_AUTH_TIMEOUT_MS)}ms`,
  )
})
