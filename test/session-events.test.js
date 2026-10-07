// GET /api/session/events — the tunnel-mode polling fallback (change
// 2026-10-07-feat-pocket-tunnel-stream-fallback, bridge half).
//
// A Cloudflare quick tunnel swallows every realtime SSE frame after the
// opening snapshot (2026-10-07 live probe), so tunnel-mode phones poll this
// endpoint instead of opening /api/session/stream. The endpoint answers from a
// per-session poll collector (lib/session-stream.js) that holds the
// bridge↔Host follow the tunnel never touches.
//
// The fake Harness in helpers.js answers a follow once and ends it, which
// would put the collector on its reconnect ladder mid-assertion. These tests
// therefore run a dedicated follow harness that accepts the upgrade and stays
// silent until the test pushes a frame — the same shape the real Host shows a
// live conversation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import {
  parseSessionFollowEnvelope,
  EVENTS_BUFFER_MAX_ENTRIES,
} from '../lib/session-stream.js'
import { startBridge, httpFetch } from './helpers.js'

// ---------------------------------------------------------------------------
// Unit half: the shared envelope classifier. Both transports (SSE and polling)
// consume this one function — the SSE framing suite pins the SSE side's bytes.
// ---------------------------------------------------------------------------

test('classifier: unparseable text, foreign stream ids and unknown types are null', () => {
  assert.equal(parseSessionFollowEnvelope('not json', 's1'), null)
  assert.equal(parseSessionFollowEnvelope('{"type":"item"}', 's1'), null, 'no streamId at all')
  assert.equal(parseSessionFollowEnvelope('{"type":"item","streamId":"other"}', 's1'), null)
  assert.equal(parseSessionFollowEnvelope(JSON.stringify({ type: 'ping', streamId: 's1' }), 's1'), null, 'unknown frame type')
})

test('classifier: token, snapshot, event, error and end map to the documented kinds', () => {
  const token = parseSessionFollowEnvelope(
    JSON.stringify({ type: 'item', streamId: 's1', value: { type: 'assistant-stream', frame: { type: 'chunk', text: 'hi' } } }),
    's1',
  )
  assert.deepEqual(token, { kind: 'token', frame: { type: 'chunk', text: 'hi' } })

  const snapshot = parseSessionFollowEnvelope(
    JSON.stringify({ type: 'item', streamId: 's1', value: { type: 'snapshot', records: [{ seq: 1 }], projections: {} } }),
    's1',
  )
  assert.equal(snapshot.kind, 'snapshot')

  const event = parseSessionFollowEnvelope(
    JSON.stringify({ type: 'item', streamId: 's1', value: { type: 'turn/end', seq: 3, data: {} } }),
    's1',
  )
  assert.equal(event.kind, 'event')

  const error = parseSessionFollowEnvelope(
    JSON.stringify({ type: 'error', streamId: 's1', error: { message: 'gone', code: 'not-found' } }),
    's1',
  )
  assert.deepEqual(error, { kind: 'host-error', failure: { message: 'gone', code: 'not-found' } })

  assert.deepEqual(parseSessionFollowEnvelope(JSON.stringify({ type: 'end', streamId: 's1' }), 's1'), { kind: 'end' })
})

// ---------------------------------------------------------------------------
// Minimal follow harness: accepts any WebSocket upgrade, records session/follow
// opens, and hands the test push()/endFollow() for the live stream. Node
// built-ins only, mirroring helpers.js's RFC 6455 corner.
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

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

/** Drain masked client frames; pings are answered, text is handed up. */
function wsReadFrames(socket, onText) {
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
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
 * A carrier that keeps session/follow streams open until the test speaks.
 * @returns {Promise<{ url: string, opens: () => number, push: (value: unknown) => void, endFollow: () => void, stop: () => Promise<void> }>}
 */
function startFollowHarness() {
  let followOpens = 0
  let activeSocket
  let activeStreamId
  const sockets = new Set()
  const server = http.createServer((_req, res) => res.writeHead(404).end())
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
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
    wsReadFrames(socket, (text) => {
      let message
      try {
        message = JSON.parse(text)
      } catch {
        return
      }
      if (message?.type === 'open' && message.endpoint === 'session/follow') {
        followOpens += 1
        activeSocket = socket
        activeStreamId = message.streamId
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        opens: () => followOpens,
        push: (value) => {
          if (activeSocket && activeStreamId !== undefined) {
            wsSendText(activeSocket, { type: 'item', streamId: activeStreamId, value })
          }
        },
        endFollow: () => {
          if (activeSocket && activeStreamId !== undefined) {
            wsSendText(activeSocket, { type: 'end', streamId: activeStreamId })
          }
        },
        stop: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy()
            sockets.clear()
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

/** Poll the events endpoint until `probe` says the answer is ready. */
async function pollUntil(base, cookie, sessionId, sinceSeq, probe, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await httpFetch(`${base}/api/session/events?sessionId=${encodeURIComponent(sessionId)}&sinceSeq=${sinceSeq}`, { headers: { cookie } })
    const body = await res.json()
    if (probe(body)) return { res, body }
    if (Date.now() > deadline) return { res, body }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const tunnelHeaders = {
  'cf-connecting-ip': '203.0.113.7',
  'cf-ray': '8c1a-events-SJC',
}

// ---------------------------------------------------------------------------
// Route gates — the same trio the stream route answers to.
// ---------------------------------------------------------------------------

test('events: a request without a sessionId is a 400', async () => {
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile('PocketEvents/1.0')
    const res = await httpFetch(`${t.base}/api/session/events`, { headers: { cookie } })
    assert.equal(res.status, 400)
  } finally {
    await t.stop()
  }
})

test('events: pairing is enforced — no mobile cookie, no events', async () => {
  const t = await startBridge()
  try {
    const res = await httpFetch(`${t.base}/api/session/events?sessionId=sess-1&sinceSeq=0`)
    assert.equal(res.status, 401)
  } finally {
    await t.stop()
  }
})

test('events: a cross-site origin is refused exactly like the stream route', async () => {
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile('PocketEvents/1.0')
    const res = await httpFetch(`${t.base}/api/session/events?sessionId=sess-1&sinceSeq=0`, {
      headers: { cookie, origin: 'https://evil.example' },
    })
    assert.equal(res.status, 403)
    assert.equal((await res.json()).ok, false)
  } finally {
    await t.stop()
  }
})

test('events: a bridge with no Harness answers 503 instead of pretending to poll', async () => {
  const t = await startBridge({ bridgeOptions: { harnessUrl: () => '' } })
  try {
    const cookie = await t.pairMobile('PocketEvents/1.0')
    const res = await httpFetch(`${t.base}/api/session/events?sessionId=sess-1&sinceSeq=0`, { headers: { cookie } })
    assert.equal(res.status, 503)
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// Mode disclosure — the field the phone switches transports on.
// ---------------------------------------------------------------------------

test('events: the status payload and the events answer both carry connectionMode (lan)', async () => {
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile('PocketEvents/1.0')
    const status = await httpFetch(`${t.base}/api/status`, { headers: { cookie } })
    assert.equal(status.status, 200)
    assert.equal((await status.json()).connectionMode, 'lan', 'a loopback request with no tunnel markers is lan')
    const events = await httpFetch(`${t.base}/api/session/events?sessionId=sess-1&sinceSeq=-1`, { headers: { cookie } })
    assert.equal(events.status, 200)
    assert.equal((await events.json()).mode, 'lan')
  } finally {
    await t.stop()
  }
})

test('events: a tunnel request (CF headers) reads tunnel — after the consent gate', async () => {
  const t = await startBridge()
  try {
    const accepted = await httpFetch(`${t.base}/consent/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tunnelHeaders },
      body: JSON.stringify({ next: '/' }),
    })
    const consent = (accepted.headers.get('set-cookie') ?? '').split(';')[0]
    // 改版(2026-10-07-feat-pocket-device-registry):配对走隧道——LAN 配出的
    // 设备档案权限「仅本地」,过隧道会被权限强制点 403(专测 device-registry.test.js)。
    const mobile = await t.pairMobileTunnel('PocketEvents/1.0')
    const cookie = `${mobile}; ${consent}`
    const status = await httpFetch(`${t.base}/api/status`, { headers: { ...tunnelHeaders, cookie } })
    assert.equal((await status.json()).connectionMode, 'tunnel', 'the same detection the router runs')
    // And without the consent cookie the poll never reaches the endpoint —
    // the gate bounces it, exactly like every other authenticated route.
    const gated = await httpFetch(`${t.base}/api/session/events?sessionId=sess-1&sinceSeq=0`, {
      headers: { ...tunnelHeaders, cookie: mobile },
    })
    assert.equal(gated.status, 303)
    assert.match(gated.headers.get('location') ?? '', /^\/consent\?next=/)
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// Incremental drain — cursor semantics, snapshot discipline, fan-out.
// ---------------------------------------------------------------------------

test('events: tokens and durable events flow out in order on a monotonic cursor; snapshots do not', async () => {
  const harness = await startFollowHarness()
  const t = await startBridge({ bridgeOptions: { harnessUrl: () => harness.url } })
  try {
    const cookie = await t.pairMobile('PocketEvents/1.0')
    // First poll creates the collector. The window starts empty — increments
    // only, no snapshot: durable state keeps flowing through boot/history.
    const first = await httpFetch(`${t.base}/api/session/events?sessionId=s1&sinceSeq=-1`, { headers: { cookie } })
    assert.equal(first.status, 200)
    const firstBody = await first.json()
    assert.equal(firstBody.ok, true)
    assert.equal(firstBody.events.length, 0)
    assert.equal(firstBody.latestSeq, 0)
    assert.equal(typeof firstBody.generation, 'string')
    assert.ok(firstBody.generation.length > 0)

    // Wait for the collector's follow to actually open before pushing.
    await pollUntil(t.base, cookie, 's1', -1, () => harness.opens() >= 1)

    harness.push({ type: 'assistant-stream', frame: { type: 'start', revision: 'r1' } }) // live token frame
    harness.push({ type: 'user/message', seq: 5, data: { text: 'hi' } }) // durable record
    harness.push({ type: 'snapshot', records: [{ seq: 9, type: 'turn/end', data: {} }], projections: {} }) // must be dropped

    const drained = await pollUntil(t.base, cookie, 's1', 0, (body) => body.events.length >= 2)
    assert.equal(drained.res.status, 200)
    assert.deepEqual(
      drained.body.events.map((entry) => entry.kind),
      ['token', 'event'],
      'one buffered frame per cursor step, in arrival order',
    )
    assert.deepEqual(drained.body.events[0].frame, { type: 'start', revision: 'r1' })
    assert.equal(drained.body.events[1].frame.seq, 5)
    assert.equal(drained.body.latestSeq, 2)
    assert.notEqual(drained.body.overflow, true)

    // A cursor at the tip answers empty, not with a replay.
    const quiet = await httpFetch(`${t.base}/api/session/events?sessionId=s1&sinceSeq=2`, { headers: { cookie } })
    assert.equal((await quiet.json()).events.length, 0)

    // The snapshot was never buffered: the cursor did not move for it.
    assert.equal(drained.body.latestSeq, 2, 'snapshot frames leave no cursor trace')

    // A second poller may rewind the whole window — fan-out by per-request
    // cursor, exactly what two phone tabs need.
    const rewind = await httpFetch(`${t.base}/api/session/events?sessionId=s1&sinceSeq=0`, { headers: { cookie } })
    assert.equal((await rewind.json()).events.length, 2)
  } finally {
    await t.stop()
    await harness.stop()
  }
})

test('events: a trimmed window answers overflow instead of silently missing frames', async () => {
  const harness = await startFollowHarness()
  const t = await startBridge({ bridgeOptions: { harnessUrl: () => harness.url } })
  try {
    const cookie = await t.pairMobile('PocketEvents/1.0')
    await httpFetch(`${t.base}/api/session/events?sessionId=s2&sinceSeq=-1`, { headers: { cookie } })
    await pollUntil(t.base, cookie, 's2', -1, () => harness.opens() >= 1)

    const total = EVENTS_BUFFER_MAX_ENTRIES + 10
    for (let i = 1; i <= total; i += 1) {
      harness.push({ type: 'note', seq: i, data: {} })
    }
    const settled = await pollUntil(t.base, cookie, 's2', 0, (body) => body.overflow === true)
    assert.equal(settled.body.overflow, true, 'a cursor below the retained window is named, not papered over')
    assert.equal(settled.body.events.length, 0)

    // A cursor inside the retained window answers normally, with the exact
    // contiguous slice it asks for.
    const tail = await httpFetch(`${t.base}/api/session/events?sessionId=s2&sinceSeq=${total - 3}`, { headers: { cookie } })
    const tailBody = await tail.json()
    assert.notEqual(tailBody.overflow, true, 'a cursor at the retained window is served, not refused')
    assert.equal(tailBody.events.length, 3, 'the last three frames are the exact slice asked for')
    assert.deepEqual(tailBody.events.map((entry) => entry.frame.seq), [total - 2, total - 1, total])
    assert.equal(tailBody.latestSeq, total)
  } finally {
    await t.stop()
    await harness.stop()
  }
})

// ---------------------------------------------------------------------------
// Collector lifecycle — reconnect on host end, idle teardown, LRU bound.
// ---------------------------------------------------------------------------

test('events: when the Host ends the follow, the collector reconnects and keeps its buffer', async () => {
  const harness = await startFollowHarness()
  const t = await startBridge({ bridgeOptions: { harnessUrl: () => harness.url } })
  try {
    const cookie = await t.pairMobile('PocketEvents/1.0')
    await httpFetch(`${t.base}/api/session/events?sessionId=s3&sinceSeq=-1`, { headers: { cookie } })
    await pollUntil(t.base, cookie, 's3', -1, () => harness.opens() >= 1)
    harness.push({ type: 'user/message', seq: 1, data: {} })

    harness.endFollow()
    // The phone's EventSource would reconnect on its retry cadence; the
    // collector does the same on its own ladder (base 500ms).
    const reopened = await pollUntil(t.base, cookie, 's3', 1, () => harness.opens() >= 2, 5000)
    assert.ok(harness.opens() >= 2, 'a host-end follow must come back')
    assert.equal(reopened.body.events.length, 0, 'the cursor is at the tip')

    // The buffer survived the reconnect: a rewind still sees the old frame,
    // under the SAME generation — the buffer outlives carrier attempts.
    const rewind = await httpFetch(`${t.base}/api/session/events?sessionId=s3&sinceSeq=0`, { headers: { cookie } })
    const rewindBody = await rewind.json()
    assert.equal(rewindBody.events.length, 1)
  } finally {
    await t.stop()
    await harness.stop()
  }
})

test('events: a session nobody polls for a while is torn down, and the next poll starts a fresh generation', async () => {
  const harness = await startFollowHarness()
  const t = await startBridge({ bridgeOptions: { harnessUrl: () => harness.url, eventCollectorIdleMs: 60 } })
  try {
    const cookie = await t.pairMobile('PocketEvents/1.0')
    const first = await httpFetch(`${t.base}/api/session/events?sessionId=s4&sinceSeq=-1`, { headers: { cookie } })
    const firstBody = await first.json()
    assert.equal(t.bridge.sessionEventCollectors.size, 1, 'the first poll created a collector')
    await pollUntil(t.base, cookie, 's4', -1, () => harness.opens() >= 1)
    harness.push({ type: 'user/message', seq: 1, data: {} })
    await pollUntil(t.base, cookie, 's4', 0, (body) => body.events.length >= 1)

    // Past the idle ceiling with no poll in between, the collector (follow and
    // buffer) is gone; the next answer is a brand-new window.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const fresh = await httpFetch(`${t.base}/api/session/events?sessionId=s4&sinceSeq=1`, { headers: { cookie } })
    const freshBody = await fresh.json()
    assert.notEqual(freshBody.generation, firstBody.generation, 'a new buffer announces itself')
    assert.equal(freshBody.latestSeq, 0, 'and the cursor started over')
    assert.equal(freshBody.events.length, 0)
    assert.equal(t.bridge.sessionEventCollectors.size, 1, 'exactly the fresh collector remains')
  } finally {
    await t.stop()
    await harness.stop()
  }
})

test('events: the collector map is LRU-bounded, and the least recently polled session goes', async () => {
  const harness = await startFollowHarness()
  const t = await startBridge({ bridgeOptions: { harnessUrl: () => harness.url, eventCollectorSessionsMax: 2 } })
  try {
    const cookie = await t.pairMobile('PocketEvents/1.0')
    await httpFetch(`${t.base}/api/session/events?sessionId=old&sinceSeq=-1`, { headers: { cookie } })
    await httpFetch(`${t.base}/api/session/events?sessionId=mid&sinceSeq=-1`, { headers: { cookie } })
    // Keep `mid` the freshest, then push the map past its bound with `new`.
    await httpFetch(`${t.base}/api/session/events?sessionId=mid&sinceSeq=-1`, { headers: { cookie } })
    await httpFetch(`${t.base}/api/session/events?sessionId=new&sinceSeq=-1`, { headers: { cookie } })
    assert.ok(t.bridge.sessionEventCollectors.size <= 2, `the map respects its bound (got ${t.bridge.sessionEventCollectors.size})`)
    assert.equal(t.bridge.sessionEventCollectors.has('old'), false, 'the least recently polled session was evicted')
    assert.equal(t.bridge.sessionEventCollectors.has('mid'), true)
    assert.equal(t.bridge.sessionEventCollectors.has('new'), true)
  } finally {
    await t.stop()
    await harness.stop()
  }
})

test('events: bridge stop tears every collector down with it', async () => {
  const harness = await startFollowHarness()
  const t = await startBridge({ bridgeOptions: { harnessUrl: () => harness.url } })
  const cookie = await t.pairMobile('PocketEvents/1.0')
  await httpFetch(`${t.base}/api/session/events?sessionId=s5&sinceSeq=-1`, { headers: { cookie } })
  await pollUntil(t.base, cookie, 's5', -1, () => harness.opens() >= 1)
  assert.equal(t.bridge.sessionEventCollectors.size, 1)
  await t.stop()
  assert.equal(t.bridge.sessionEventCollectors.size, 0, 'stop() stops and clears the collectors')
  await harness.stop()
})
