// Shared test helpers: boot the real LanMobileBridge on an OS-assigned port,
// pair real mobile/desktop cookies, and run a minimal dependency-free fake
// Harness (HTTP + a tiny RFC 6455 WebSocket mux) only where a Harness call is
// actually exercised. Node built-ins only — no extra npm dependencies.
import http from 'node:http'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { LanMobileBridge } from '../lib/bridge.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function collectBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', (c) => chunks.push(c))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

/**
 * Minimal fetch-like request over node:http with `agent: false`. Every call
 * opens a fresh connection that is closed when the response finishes — no
 * keep-alive pool. undici's global fetch pool would otherwise hand a later
 * bridge a stale idle socket to a just-recycled ephemeral port (Windows
 * reassigns freed ports in strict alternation), causing ECONNRESET.
 * Redirects are never followed (equivalent to redirect: 'manual').
 */
export function httpFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const headers = { ...(options.headers ?? {}) }
    if (options.body != null) {
      headers['content-length'] = Buffer.byteLength(String(options.body))
    }
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: options.method ?? 'GET',
        headers,
        agent: false,
      },
      (res) => {
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: {
            get: (name) => {
              const value = res.headers[String(name).toLowerCase()]
              return Array.isArray(value) ? value[0] : (value ?? null)
            },
          },
          text: async () => (await collectBody(res)).toString('utf8'),
          json: async () => JSON.parse((await collectBody(res)).toString('utf8')),
          get body() {
            return Readable.toWeb(res)
          },
        })
      }
    )
    req.on('error', reject)
    if (options.body != null) req.write(options.body)
    req.end()
  })
}

// start() prefers DSH_MOBILE_PORT over options.port; neutralise it so the
// suite is deterministic even if the environment exports a fixed port.
process.env.DSH_MOBILE_PORT = ''

/** Log lines that prove a bridge↔harness transport failure (see lib/bridge.js). */
const TRANSPORT_FAILURE_FRAGMENTS = [
  'harness call dropped',
  'harness transport failed',
  'harness answered ',
  'harness envelope unreadable',
  'harness rpc answer mismatched',
]

/**
 * Start a real bridge on an ephemeral port.
 * @param {{ harness?: 'fake', harnessOptions?: object, bridgeOptions?: object }} [opts]
 *   bridgeOptions: extra LanMobileBridge options (e.g. { sseStatusMs: 25 }).
 *   The returned `logs` and `transportFailures()` are ONLY-augment additions:
 *   a caller-supplied `bridgeOptions.log` is still invoked (merge, never override).
 */
export async function startBridge(opts = {}) {
  const harness = opts.harness === 'fake' ? await startFakeHarness(opts.harnessOptions) : null
  // Collect the bridge's own log lines into an array readable after stop(), while
  // still forwarding to a caller-supplied logger.
  const logs = []
  const callerLog = opts.bridgeOptions?.log
  const bridge = new LanMobileBridge({
    harnessUrl: () => (harness ? harness.url : 'http://127.0.0.1:9'),
    innerAuth: { ready: async () => undefined, invalidate: () => {} },
    locale: 'zh',
    port: 0,
    pairingPinStore: { load: () => ({}), save: () => true },
    tunnelLog: () => {},
    // Empty polls answer at once under test. Production holds them (EVENT_HOLD_MS)
    // so a tunnel phone hears about new work immediately; leaving that on here would
    // make every "this cursor is at the tip, answer empty" assertion wait out the
    // ceiling instead of asserting on it. A test that wants the hold opts in with
    // `bridgeOptions: { eventHoldMs: … }`.
    eventHoldMs: 0,
    ...(opts.bridgeOptions ?? {}),
    log: (level, message) => {
      logs.push({ level, message })
      callerLog?.(level, message)
    },
  })
  const snap = await bridge.start()
  assert.notEqual(snap.port, 43127, 'bridge must not bind the hardcoded default')
  const base = `http://127.0.0.1:${snap.port}`

  /** Complete real LAN pairing; returns the raw `dsh_mobile=...` cookie. */
  async function pairMobile(userAgent = 'PocketTest/1.0') {
    const token = new URL(snap.pairingUrl).searchParams.get('token')
    const res = await httpFetch(`${base}/pair?token=${token}`, {
      headers: { 'user-agent': userAgent },
    })
    assert.equal(res.status, 302)
    const setCookie = res.headers.get('set-cookie') ?? ''
    return setCookie.split(';')[0]
  }

  /**
   * Complete the full tunnel pairing funnel over the cf-connecting-ip + cf-ray
   * header seam: seed the ephemeral PIN, verify, take the desktop approval
   * when the device is new, and poll. Returns the raw `dsh_mobile=...` cookie —
   * from the poll when the desktop confirmed, from the verify response itself
   * when the device registry restored a known device (pending: false).
   */
  async function pairMobileTunnel(userAgent = 'PocketTest/1.0', pin = '123456') {
    const tunnelHeaders = {
      'user-agent': userAgent,
      'cf-connecting-ip': '203.0.113.7',
      'cf-ray': '8c1a-pair-tunnel-SJC',
      origin: base,
    }
    bridge.ephemeralPin = pin
    bridge.ephemeralPinExpiresAt = Date.now() + 5 * 60_000
    const verify = await httpFetch(`${base}/pair/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tunnelHeaders },
      body: JSON.stringify({ pin }),
    })
    assert.equal(verify.status, 200)
    const verified = await verify.json()
    assert.equal(verified.ok, true)
    let cookie
    if (verified.pending === true) {
      const desktop = await pairDesktop()
      const approved = await approvePendingPairing(verified.confirmId, desktop)
      assert.equal(approved.status, 200)
      const poll = await pollPendingPairing(verified.confirmId, tunnelHeaders)
      assert.equal(poll.status, 200)
      assert.equal((await poll.json()).approved, true)
      cookie = (poll.headers.get('set-cookie') ?? '').split(';')[0]
    } else {
      // Restored from the device registry: the verify response carried the
      // fresh cookie itself (no desktop round trip by design).
      cookie = (verify.headers.get('set-cookie') ?? '').split(';')[0]
    }
    assert.match(cookie, /^dsh_mobile=/)
    return cookie
  }

  /** Real loopback one-time desktop bootstrap; returns `dsh_desktop=...`. */
  async function pairDesktop() {
    const boot = await httpFetch(bridge.createDesktopUrl())
    assert.equal(boot.status, 303)
    return (boot.headers.get('set-cookie') ?? '').split(';')[0]
  }

  /** Desktop-side verdict on one pending pairing (design #4a approve flow). */
  async function approvePendingPairing(confirmId, desktopCookie, approve = true) {
    return httpFetch(`${base}/desktop/pair/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktopCookie },
      body: JSON.stringify({ id: confirmId, approve }),
    })
  }

  /** The phone's poll for its pairing verdict. */
  async function pollPendingPairing(confirmId, headers = {}) {
    return httpFetch(`${base}/pair/pending?confirmId=${encodeURIComponent(confirmId)}`, { headers })
  }

  async function stop() {
    await bridge.stop()
    if (harness) await harness.stop()
  }

  /** The transport-failure classes seen on the bridge log, oldest first. */
  function transportFailures() {
    return logs
      .filter(({ message }) => TRANSPORT_FAILURE_FRAGMENTS.some((f) => message.includes(f)))
      .map(({ level, message }) => `[${level}] ${message}`)
  }

  return { bridge, snap, base, harness, pairMobile, pairMobileTunnel, pairDesktop, approvePendingPairing, pollPendingPairing, stop, logs, transportFailures }
}

// ---------------------------------------------------------------------------
// Minimal fake Harness
// ---------------------------------------------------------------------------

/** Send one unmasked server-to-client text frame. */
function wsSendText(socket, value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  }
  socket.write(Buffer.concat([header, payload]))
}

/**
 * Drain masked client frames from one upgraded socket.
 * @param {(text: string) => void} onText
 */
function wsReadFrames(socket, onText) {
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      if (buffer.length < 2) return
      const opcode = buffer[0] & 0x0f
      const masked = Boolean(buffer[1] & 0x80)
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      let mask
      if (masked) {
        if (buffer.length < offset + 4) return
        mask = buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (buffer.length < offset + length) return
      const payload = Buffer.from(buffer.subarray(offset, offset + length))
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      buffer = buffer.subarray(offset + length)
      if (opcode === 0x8) {
        socket.end()
        return
      }
      if (opcode === 0x9) {
        socket.write(Buffer.from([0x8a, 0x00]))
        continue
      }
      if (opcode === 0x1 || opcode === 0x0) onText(payload.toString('utf8'))
    }
  })
}

/**
 * @param {{
 *   frames?: unknown[],
 *   record?: (args: unknown) => void,
 *   respond?: (pathname: string, args: unknown, body: unknown) => unknown,
 *   get?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) => boolean|void|Promise<boolean|void>,
 * }} [options]
 *   frames: durable `value` items to push on a session/follow open, then end.
 *   record: captures the args of POST /api/session/prompt.
 *   respond: per-POST override; return an envelope `result`
 *     ({ok:true,value} or {ok:false,error:{message}}), undefined for default.
 *   get: handles GET/HEAD requests (e.g. /api/session.export); truthy = handled.
 */
export function startFakeHarness(options = {}) {
  const wsSockets = new Set()
  const records = { promptArgs: undefined, lastBody: undefined, calls: [] }

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url ?? '/', 'http://fake-harness')
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (options.get && (await options.get(req, res, parsedUrl))) return
      res.writeHead(404, { 'Connection': 'close' }).end()
      return
    }
    if (req.method !== 'POST' || !parsedUrl.pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Connection': 'close' }).end()
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    records.lastBody = body
    records.calls.push({ url: parsedUrl.pathname, args: body.payload?.args })
    if (parsedUrl.pathname === '/api/session/prompt') {
      records.promptArgs = body.payload?.args
      options.record?.(body.payload?.args)
    }
    const override = options.respond?.(parsedUrl.pathname, body.payload?.args, body)
    if (override !== undefined) {
      res.writeHead(200, { 'content-type': 'application/json', 'Connection': 'close' })
      res.end(JSON.stringify({ rpcId: body.rpcId, result: override }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'Connection': 'close' })
    res.end(JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value: { echoed: true } } }))
  })

  // The fake harness wants no socket reuse across bridge calls, so a later call
  // can never be handed a dead or recycled socket (same reason helpers.httpFetch
  // uses `agent: false`). Two parts, and only one of them is what closes a
  // socket: the `Connection: close` header above tells the peer to hang up,
  // while `keepAliveTimeout = 0` DISABLES the server-side idle timeout — a
  // probed keep-alive client still holds one live idle socket under it, exactly
  // as under the 5000ms default. Set both; do not read either as sufficient.
  server.keepAliveTimeout = 0

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    wsSockets.add(socket)
    socket.on('close', () => wsSockets.delete(socket))
    socket.on('error', () => wsSockets.delete(socket))
    wsReadFrames(socket, (text) => {
      let message
      try {
        message = JSON.parse(text)
      } catch {
        return
      }
      // Full-stack session/follow: reply with the prepared durable items on
      // the bridge's own streamId, then close with end (no invented replay).
      if (message?.type === 'open' && message.endpoint === 'session/follow' && options.frames) {
        for (const value of options.frames) {
          wsSendText(socket, { type: 'item', streamId: message.streamId, value })
        }
        wsSendText(socket, { type: 'end', streamId: message.streamId })
      }
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`
      resolve({
        url,
        records,
        stop: () =>
          new Promise((done) => {
            for (const socket of wsSockets) socket.destroy()
            wsSockets.clear()
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}
