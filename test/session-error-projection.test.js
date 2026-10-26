// Bridge-side session error projection (requirement 5, 2026-10-13).
//
// User report: 「会话的错误信息没有传到工作区页面的显示上。如果会话发生错误，
// 工作区页面里面显示的还是绿色的打勾『已完成』。」
//
// Attribution (already settled, not re-derived here): the host's `session/list`
// rows carry NO error field at all — `summaryFor(session)` enumerates a fixed
// field set with no error/lastError/status, and no projection key belongs to the
// error family. The only real error signal is the EVENT `turn/end` with
// `reason.kind === 'error'`, which the bridge sees in exactly one place per
// transport: the collector's `push('event', …)` and the SSE `handleMessage`.
//
// This file pins the projection that follows from that:
//   1. `classifyTurnEndFrame` reads the host's own payload shape (read out of
//      `lib/pages.js` visibleMessages, not guessed) and records ONLY
//      `reason.kind === 'error'`; a normal end clears the mark; the
//      transcript's other error banners keep it;
//   2. `withSessionErrors` puts the mark on compacted rows under the field the
//      page already tests (`lastError`) plus a `bridgeError` object with the
//      truth behind it — without inventing the key on clean rows;
//   3. BOTH consuming paths (cold-open boot and the `session.list` RPC) carry
//      it, and they carry it on rows the host itself never gave an error field.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'
import {
  classifyTurnEndFrame,
  noteSessionTurnEnd,
  withSessionErrors,
  EVENT_COLLECTOR_SESSIONS_MAX,
} from '../lib/session-stream.js'
import { SESSION_ROW_TEXT_LIMIT } from '../lib/projections.js'
import { startBridge, httpFetch } from './helpers.js'

const bridgeSource = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
const streamSource = readFileSync(new URL('../lib/session-stream.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// Unit half: the classifier. The frame shapes below are copied from the
// host-side consumers that already parse them — lib/pages.js visibleMessages
// (`const e = entry.event || entry, d = e.data || {}, reason.kind`) and
// test/turn-end-errors.test.js (`{ event: { type: 'turn/end', data: { reason } } }`).
// ---------------------------------------------------------------------------

test('classifier: a wrapped turn/end with an error reason records the message', () => {
  // The exact spelling test/turn-end-errors.test.js builds, and the spelling
  // compactSessionFrame preserves when the host wrapped the record.
  const verdict = classifyTurnEndFrame({
    event: { type: 'turn/end', turn: 1, data: { reason: { kind: 'error', error: { message: 'upstream 500', code: 'llm_failure' } } } },
  })
  assert.deepEqual(verdict, { verdict: 'record', kind: 'error', text: 'upstream 500' })
})

test('classifier: a bare turn/end frame reads the same fields at the top level', () => {
  const verdict = classifyTurnEndFrame({ type: 'turn/end', seq: 3, data: { reason: { kind: 'error', error: { code: 'llm_failure' } } } })
  assert.deepEqual(verdict, { verdict: 'record', kind: 'error', text: 'llm_failure' },
    'a failure with no message falls back to its code, exactly as the transcript bubble does')
})

test('classifier: an error with neither message nor code still records something nameable', () => {
  assert.deepEqual(classifyTurnEndFrame({ type: 'turn/end', data: { reason: { kind: 'error' } } }), { verdict: 'record', kind: 'error', text: 'error' })
})

test('classifier: a completed end clears the mark', () => {
  assert.deepEqual(classifyTurnEndFrame({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), { verdict: 'clear' })
})

test('classifier: an unrecognized kind is a normal end and clears', () => {
  assert.deepEqual(classifyTurnEndFrame({ type: 'turn/end', data: { reason: { kind: 'forked' } } }), { verdict: 'clear' })
})

test('classifier: the transcript error banners keep a recorded mark instead of clearing it', () => {
  // visibleMessages renders aborted/blocked/max-tokens/interrupted as error
  // bubbles too, so the row must not flip back to a green check on those.
  for (const kind of ['aborted', 'blocked', 'max-tokens', 'interrupted']) {
    assert.deepEqual(classifyTurnEndFrame({ type: 'turn/end', data: { reason: { kind } } }), { verdict: 'keep' }, kind)
  }
})

test('classifier: anything that is not a turn/end is ignored', () => {
  assert.equal(classifyTurnEndFrame({ type: 'user/message', data: { reason: { kind: 'error' } } }).verdict, 'none')
  assert.equal(classifyTurnEndFrame({ type: 'assistant/chunk', data: {} }).verdict, 'none')
  assert.equal(classifyTurnEndFrame(undefined).verdict, 'none')
  assert.equal(classifyTurnEndFrame('turn/end').verdict, 'none')
})

// ---------------------------------------------------------------------------
// The projection onto rows: a constructed row set (host rows carry no error
// field at all, which is the whole premise of the requirement).
// ---------------------------------------------------------------------------

const stubBridge = () => ({ now: () => 1700000000000 })

test('withSessionErrors: a recorded failure lands as lastError + bridgeError on the row', () => {
  const bridge = stubBridge()
  noteSessionTurnEnd(bridge, 'sess-err', { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } })
  const rows = withSessionErrors(bridge, [{ sessionId: 'sess-err', title: 'Broken' }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].lastError, 'boom')
  assert.deepEqual(rows[0].bridgeError, { kind: 'error', text: 'boom', at: 1700000000000 })
})

test('withSessionErrors: a clean row keeps its identity and never gains lastError', () => {
  const bridge = stubBridge()
  const clean = { sessionId: 'sess-ok', title: 'Fine' }
  noteSessionTurnEnd(bridge, 'sess-other', { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } })
  const rows = withSessionErrors(bridge, [clean])
  assert.equal(rows[0], clean, 'an untouched row is the very same object')
  assert.equal('lastError' in rows[0], false)
  assert.equal('bridgeError' in rows[0], false)
})

test('withSessionErrors: a normal end clears the row again', () => {
  const bridge = stubBridge()
  noteSessionTurnEnd(bridge, 'sess-x', { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } })
  assert.equal(withSessionErrors(bridge, [{ sessionId: 'sess-x' }])[0].lastError, 'boom')
  noteSessionTurnEnd(bridge, 'sess-x', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const rows = withSessionErrors(bridge, [{ sessionId: 'sess-x' }])
  assert.equal('lastError' in rows[0], false, 'one error must not stay green forever')
})

test('withSessionErrors: the mark survives compaction-sized text', () => {
  const bridge = stubBridge()
  const long = 'x'.repeat(SESSION_ROW_TEXT_LIMIT + 50)
  noteSessionTurnEnd(bridge, 'sess-long', { type: 'turn/end', data: { reason: { kind: 'error', error: { message: long } } } })
  const rows = withSessionErrors(bridge, [{ sessionId: 'sess-long' }])
  assert.equal(rows[0].lastError.length, SESSION_ROW_TEXT_LIMIT, 'truncated to the row text budget')
  assert.equal(rows[0].bridgeError.text.length, long.length, 'the truth keeps the whole text')
})

test('withSessionErrors: the store is per bridge, so nothing leaks between instances', () => {
  const a = stubBridge()
  const b = stubBridge()
  noteSessionTurnEnd(a, 'sess-1', { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } })
  assert.equal('lastError' in withSessionErrors(b, [{ sessionId: 'sess-1' }])[0], false)
})

test('withSessionErrors: an empty store answers with the very same array', () => {
  const rows = [{ sessionId: 'sess-1' }]
  assert.equal(withSessionErrors(stubBridge(), rows), rows)
})

test('withSessionErrors: the mark cannot grow without bound', () => {
  // Same bound reasoning as the backoff map: a phone walking a long workspace
  // list must not grow the tally forever. The oldest entry is evicted.
  const bridge = stubBridge()
  for (let i = 0; i < EVENT_COLLECTOR_SESSIONS_MAX * 2 + 3; i += 1) {
    noteSessionTurnEnd(bridge, `sess-${i}`, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: `boom ${i}` } } } })
  }
  const rows = withSessionErrors(bridge, Array.from({ length: EVENT_COLLECTOR_SESSIONS_MAX * 2 + 3 }, (_, i) => ({ sessionId: `sess-${i}` })))
  const marked = rows.filter((row) => 'lastError' in row)
  assert.equal(marked.length, EVENT_COLLECTOR_SESSIONS_MAX * 2, 'exactly the cap is remembered')
  assert.equal(marked[0].lastError, 'boom 3', 'the three oldest were evicted, not the newest')
})

// ---------------------------------------------------------------------------
// Full-stack half: the collector (polling transport) and the boot/session.list
// consumption paths. The follow harness mirrors test/session-events.test.js —
// accept the upgrade, stay silent until the test pushes.
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
        length = Number(buffer.readBigUInt64BE(8))
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
 * A carrier that keeps session/follow streams open until the test speaks, and
 * answers the bridge's HTTP RPCs with `respond`. One URL serves both halves
 * because the bridge uses one `harnessUrl()` for RPC and for follows — a
 * WebSocket-only harness makes every `session.list` read fail with 502 and the
 * boot answer 503, which says nothing about the projection under test.
 *
 * @param {{ respond?: (pathname: string, args: unknown, body: unknown) => unknown }} [options]
 *   respond: per-POST override; return an envelope `result`
 *   ({ok:true,value} or {ok:false,error:{message}}), undefined for the default echo.
 */
function startFollowHarness(options = {}) {
  let followOpens = 0
  let activeSocket
  let activeStreamId
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url ?? '/', 'http://fake-harness')
    if (req.method !== 'POST' || !parsedUrl.pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Connection': 'close' }).end()
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    const override = options.respond?.(parsedUrl.pathname, body.payload?.args, body)
    res.writeHead(200, { 'content-type': 'application/json', 'Connection': 'close' })
    res.end(JSON.stringify({ rpcId: body.rpcId, result: override ?? { ok: true, value: { echoed: true } } }))
  })
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

const errorFrame = { type: 'turn/end', seq: 7, data: { reason: { kind: 'error', error: { message: 'upstream exploded', code: 'llm_failure' } } } }
const okFrame = { type: 'turn/end', seq: 8, data: { reason: { kind: 'completed' } } }

/** The host's session/list answer: one row, no error field of any kind. */
const hostRows = (items) => () => ({ ok: true, value: { items } })

/** POST /api/rpc the way the phone's list view does. */
async function rpcList(t, cookie) {
  const res = await httpFetch(`${t.base}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ method: 'session.list', payload: {} }),
  })
  return { status: res.status, body: await res.json() }
}

test('full stack: a turn/end error reaches the session.list row the workspace page reads', async () => {
  const harness = await startFollowHarness({ respond: hostRows([{ sessionId: 's1', title: 'Real', updatedAt: 5, projections: { values: { title: 'Real' } } }]) })
  const t = await startBridge({ bridgeOptions: { harnessUrl: () => harness.url } })
  try {
    const cookie = await t.pairMobile('PocketErrorProjection/1.0')
    // First poll creates the collector and opens the follow.
    await httpFetch(`${t.base}/api/session/events?sessionId=s1&sinceSeq=-1`, { headers: { cookie } })
    await pollUntil(t.base, cookie, 's1', -1, () => harness.opens() >= 1)
    // The host's ONLY error signal.
    harness.push(errorFrame)
    await pollUntil(t.base, cookie, 's1', 0, (body) => body.events.length >= 1)

    const list = await rpcList(t, cookie)
    assert.equal(list.status, 200)
    const row = list.body.value.items.find((item) => item.sessionId === 's1')
    assert.equal(row.lastError, 'upstream exploded', 'the row the page renders carries the failure')
    assert.equal(row.bridgeError.kind, 'error')
    // The page's taskState/wsFlagOf judgement hits on this row.
    assert.equal(Boolean(row.lastError), true)
  } finally {
    await t.stop()
    await harness.stop()
  }
})

test('full stack: a completed end clears the row again', async () => {
  const harness = await startFollowHarness({ respond: hostRows([{ sessionId: 's1', title: 'Real', updatedAt: 5 }]) })
  const t = await startBridge({ bridgeOptions: { harnessUrl: () => harness.url } })
  try {
    const cookie = await t.pairMobile('PocketErrorProjection/1.0')
    await httpFetch(`${t.base}/api/session/events?sessionId=s1&sinceSeq=-1`, { headers: { cookie } })
    await pollUntil(t.base, cookie, 's1', -1, () => harness.opens() >= 1)
    harness.push(errorFrame)
    await pollUntil(t.base, cookie, 's1', 0, (body) => body.events.length >= 1)

    harness.push(okFrame)
    await pollUntil(t.base, cookie, 's1', 1, (body) => body.events.length >= 2)

    const list = await rpcList(t, cookie)
    assert.equal(list.status, 200)
    const row = list.body.value.items.find((item) => item.sessionId === 's1')
    assert.equal('lastError' in row, false, 'a healthy turn takes the green check back')
    assert.equal('bridgeError' in row, false)
  } finally {
    await t.stop()
    await harness.stop()
  }
})

test('full stack: the cold-open boot payload carries the same mark', async () => {
  const harness = await startFollowHarness({ respond: hostRows([{ sessionId: 's1', title: 'Real', updatedAt: 5 }]) })
  const t = await startBridge({ bridgeOptions: { harnessUrl: () => harness.url } })
  try {
    // `buildMobileBoot` refuses to answer without a workspace snapshot, exactly
    // like production after the first `workspace/follow` baseline arrived; the
    // shape is the host's own (an `items` array).
    t.bridge.workspaceSnapshot = { items: [] }
    const cookie = await t.pairMobile('PocketErrorProjection/1.0')
    await httpFetch(`${t.base}/api/session/events?sessionId=s1&sinceSeq=-1`, { headers: { cookie } })
    await pollUntil(t.base, cookie, 's1', -1, () => harness.opens() >= 1)
    harness.push(errorFrame)
    await pollUntil(t.base, cookie, 's1', 0, (body) => body.events.length >= 1)

    const boot = await httpFetch(`${t.base}/api/boot`, { headers: { cookie } })
    assert.equal(boot.status, 200)
    const row = (await boot.json()).sess.items.find((item) => item.sessionId === 's1')
    assert.equal(row.lastError, 'upstream exploded', 'a cold open shows the error too, not only a live list read')
    assert.equal(row.bridgeError.kind, 'error')
  } finally {
    await t.stop()
    await harness.stop()
  }
})

test('full stack: a subagent child failure does not stamp the parent row', () => {
  // The collector is opened with the subagent address when a child is watched;
  // its failure belongs to the child, which the page renders through its own
  // subagent panel. The parent workspace row must stay untouched.
  // Pinned at the hook that keeps that true: the collector skips the tally
  // entirely when it was opened with a subagent address, so a child's `turn/end`
  // can never be filed under the parent's id.
  assert.ok(
    streamSource.includes('if (!subagent) noteSessionTurnEnd(bridge, sessionId, parsed.payload)'),
    'a collector following a subagent child does not file the child failure under the parent'
  )
  const bridge = stubBridge()
  noteSessionTurnEnd(bridge, 'parent-sess', { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } })
  assert.equal(withSessionErrors(bridge, [{ sessionId: 'parent-sess' }])[0].lastError, 'boom',
    'a direct failure stamps the row — this is the baseline the hook guards')
})

// ---------------------------------------------------------------------------
// Source-level pins: the two consuming paths both wrap with the projection,
// and the projection happens AFTER compaction (where the host's own dead
// "errored" branch can never see it).
// ---------------------------------------------------------------------------

test('both consuming paths stamp after compaction', () => {
  const occurrences = bridgeSource.split('\n').filter((line) => line.includes('withSessionErrors(this, compactSessionRows('))
  assert.equal(occurrences.length, 2, 'the cold-open boot and the session.list RPC both carry the mark')
  assert.ok(bridgeSource.includes("import { streamSession as streamSessionStream"), 'the bridge still imports the stream module')
  assert.ok(bridgeSource.includes('withSessionErrors } from'), 'and the projection is imported from it')
})

test('both live transports feed the projection', () => {
  assert.ok(streamSource.includes('noteSessionTurnEnd(bridge, sessionId, payload)'), 'the SSE stream records a turn/end it forwards')
  assert.ok(streamSource.includes('noteSessionTurnEnd(bridge, sessionId, parsed.payload)'), 'the poll collector records the same event')
  // Only turn/end with an error kind can write; everything else is a classifier decision.
  assert.ok(streamSource.includes("if (String(rec.type ?? '').toLowerCase() !== 'turn/end') return { verdict: 'none' }"))
  assert.ok(streamSource.includes("if (kind === 'error')"))
})
