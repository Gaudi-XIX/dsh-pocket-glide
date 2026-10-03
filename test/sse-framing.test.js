// Coverage #6 SSE framing — FULL-STACK. The real bridge opens a WebSocket to
// the fake Harness mux and forwards session/follow items to the phone as a
// real text/event-stream response read over HTTP.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { LanMobileBridge } from '../lib/bridge.js'
import { STREAM_RETRY_BASE_MS, STREAM_RETRY_CAP_MS, STREAM_BACKOFF_KEYS_MAX, DEVICE_MAP_CAP, HISTORY_PAGE_DEFAULT_MESSAGES } from '../lib/constants.js'
import { startBridge, httpFetch } from './helpers.js'

const tokenFrame = { type: 'start', revision: 'r1' }
const chunkFrame = { type: 'chunk', revision: 'r1', index: 0, chunk: { text: 'hello' } }
const snapshot = { type: 'snapshot', records: [], projections: {} }
const durable = { type: 'assistant/chunk', data: 'x' }

const frames = [
  { type: 'assistant-stream', frame: tokenFrame },
  { type: 'assistant-stream', frame: chunkFrame },
  snapshot,
  durable,
]

test('SSE maps assistant-stream -> token, snapshot -> snapshot, other -> event', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: { frames } })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(`${t.base}/api/session/stream?sessionId=sess-1`, {
      headers: { cookie },
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let raw = ''
    // Read until the server ends the response after the end frame.
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      raw += decoder.decode(value, { stream: true })
    }

    // The reconnect cadence the stream opens with (K-7). It is a NUMBER, not the
    // number: the value became dynamic in WP-OPS-BRIDGE (`500 x 2^failures`, capped
    // at 15s), and this file stayed green only because a healthy conversation has
    // zero failures and the first frame therefore still read 500. So the frame is
    // pinned structurally here, and the two values that actually matter — 500 on a
    // clean conversation, and the escalation ladder — are pinned by name below.
    const opening = raw.match(/^retry: (\d+)\n\n/)
    assert.ok(opening, `the stream must open with a retry directive; got ${JSON.stringify(raw.slice(0, 40))}`)
    assert.equal(
      Number(opening[1]),
      t.bridge.streamRetryDelayMs('sess-1'),
      'the frame must state the cadence this bridge is actually publishing',
    )
    // Exactly one retry directive on a clean open: the escalation is written on the
    // way OUT (after a failure), never invented twice at the start.
    assert.equal(raw.match(/^retry: \d+\n\n/gm)?.length, 1, 'a healthy stream says its cadence once')

    // assistant-stream items are emitted on the named "token" channel.
    assert.match(raw, /event: token\ndata: \{"type":"start","revision":"r1"\}\n\n/)
    assert.match(raw, /event: token\ndata: \{"type":"chunk","revision":"r1","index":0,"chunk":\{"text":"hello"\}\}\n\n/)

    // Snapshot keeps its own event name.
    assert.match(raw, /event: snapshot\ndata: \{"type":"snapshot","records":\[\],"projections":\{\}\}\n\n/)

    // Any other durable value falls through to the generic "event" channel.
    assert.match(raw, /event: event\ndata: \{"type":"assistant\/chunk","data":"x"\}\n\n/)

    // Exactly two token frames, one snapshot, one event — no invented replay.
    assert.equal(raw.match(/event: token\n/g)?.length, 2)
    assert.equal(raw.match(/event: snapshot\n/g)?.length, 1)
    assert.equal(raw.match(/event: event\n/g)?.length, 1)
  } finally {
    await t.stop()
  }
})

test('the stream also carries connection state, so the phone stops polling', async () => {
  // No prepared frames: the fake Harness leaves the stream open, which is the
  // state a phone sits in while it reads. The bridge ticks status frames fast
  // (sseStatusMs) so the test never waits for the production 30s cadence.
  const t = await startBridge({ harness: 'fake', bridgeOptions: { sseStatusMs: 25 } })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(`${t.base}/api/session/stream?sessionId=sess-1`, { headers: { cookie } })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let raw = ''
    // The status frame arrives on its own (fast, test-only) cadence.
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && !raw.includes('event: status')) {
      const { value, done } = await reader.read()
      if (done) break
      raw += decoder.decode(value, { stream: true })
    }
    await reader.cancel().catch(() => {})

    const match = raw.match(/event: status\ndata: (\{[^\n]*\})\n\n/)
    assert(match, 'a status frame must reach the phone')
    const body = JSON.parse(match[1])
    assert.equal(body.connected, true)
    assert.equal(typeof body.expiresAt, 'number', 'the paired session expiry rides along')
    // No tunnel is running in this test, so tunnelExpiresAt is absent — the
    // client only reacts when it is a number.
  } finally {
    await t.stop()
  }
})

// AC-A4 (2026-10-02 audit, P0-A) — full-stack half. A stale sinceSeq is exactly
// what a page-wide watermark produces when the user switches session: every seq
// the new session logs is below it. Before the fix the bridge answered that with
// an emptied snapshot and silently dropped the session's own committed frames, so
// the phone sat on a blank transcript with a stream it believed was live.
test('a stale sinceSeq still delivers the session own committed frames', async () => {
  const pages = [
    { type: 'snapshot', records: [{ seq: 1, type: 'user/message', data: {} }, { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } }], projections: {} },
    { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } },
  ]
  const t = await startBridge({ harness: 'fake', harnessOptions: { frames: pages } })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(`${t.base}/api/session/stream?sessionId=sess-1&sinceSeq=9`, {
      headers: { cookie },
    })
    assert.equal(res.status, 200)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let raw = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      raw += decoder.decode(value, { stream: true })
    }

    // The array branch keeps filtering — the opening snapshot arrives, emptied.
    assert.match(raw, /event: snapshot\ndata: \{[^\n]*"records":\[\][^\n]*\}\n\n/, 'the snapshot must still reach the phone')
    // The single durable frame must NOT be swallowed by the watermark.
    assert.match(raw, /event: event\ndata: \{"type":"turn\/end","seq":3,"data":\{"reason":\{"kind":"completed"\}\}\}\n\n/, 'turn/end survives a watermark above its seq')
    assert.equal(raw.match(/event: event\n/g)?.length, 1)
    // RC-5 (2026-10-02 rescan): the frame carrying a single durable event at or
    // below the watermark is forwarded ON PURPOSE — `stripRecordsThrough` has no
    // `return null` (commit `ef3d6fe`, audit §1 P0-A fix 3). This assertion goes
    // red if someone "restores" the swallowed-frame guard.
    const streamSource = readFileSync(new URL('../lib/session-stream.js', import.meta.url), 'utf8')
    assert.doesNotMatch(streamSource, /payload\s*!==\s*null/, 'the dead null guard must not come back')
    assert.doesNotMatch(streamSource, /fully-superseded frame is dropped/, 'nor the comment describing a branch that does not exist')
    const projectionsSource = readFileSync(new URL('../lib/projections.js', import.meta.url), 'utf8')
    assert.doesNotMatch(projectionsSource, /return null/, 'stripRecordsThrough must keep returning a frame, never null')
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// RC-7 (2026-10-02 rescan): the bridge-side `failure` payload carried English
// prose and an internal code, and `lib/pages.js` prints `frame.message` verbatim
// on a Chinese UI. The session-stream half of the fix adds a locale-free
// `reason` key; `message` must stay byte-identical, because `importantChatCopy`
// keys off its prefix.
// ---------------------------------------------------------------------------

test('RC-7: a failure frame carries a locale-free reason key alongside the unchanged message', async () => {
  // No fake Harness: the carrier connect to 127.0.0.1:9 is refused, which is the
  // `stream-transport` path.
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile('PocketReason/1.0')
    const res = await httpFetch(`${t.base}/api/session/stream?sessionId=sess-reason`, { headers: { cookie } })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let raw = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      raw += decoder.decode(value, { stream: true })
    }
    const match = raw.match(/event: failure\ndata: (\{[^\n]*\})\n\n/)
    assert.ok(match, `a failure frame must reach the phone; got ${JSON.stringify(raw.slice(0, 200))}`)
    const frame = JSON.parse(match[1])
    assert.equal(frame.reason, 'transport', 'the phone can branch on a locale-free key instead of parsing English')
    assert.equal(frame.code, '__bridge/stream-transport', 'the existing internal code is untouched')
    // A refused connect reaches `handleError` rather than `handleClose`, so the
    // copy here is the `could not reach` variant — one of the two literals that
    // already existed. Neither was rewritten by this fix.
    assert.ok(
      ['Session stream lost.', 'Session stream could not reach the Host.'].includes(frame.message),
      `the message stays one of the original literals, got ${JSON.stringify(frame.message)}`
    )
    // Byte-identical means the exact string is still a literal in the module —
    // a rewritten message would not be found there.
    const source = readFileSync(new URL('../lib/session-stream.js', import.meta.url), 'utf8')
    assert.ok(source.includes(`'${frame.message}'`), 'the message on the wire is still the module literal')
    assert.equal(typeof frame.retryMs, 'number', 'the diagnostic retry hint still rides along')
  } finally {
    await t.stop()
  }
})

test('RC-7: the suppressed (backoff) failure carries its own reason key', async () => {
  // The backoff gate fires from the second consecutive failure on; two refused
  // attempts get there.
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile('PocketReason2/1.0')
    const readStream = async () => {
      const res = await httpFetch(`${t.base}/api/session/stream?sessionId=sess-reason2`, { headers: { cookie } })
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
    await readStream()
    await readStream()
    const suppressed = await readStream()
    const match = suppressed.match(/event: failure\ndata: (\{[^\n]*\})\n\n/)
    assert.ok(match, `the suppressed attempt must still answer; got ${JSON.stringify(suppressed.slice(0, 200))}`)
    const frame = JSON.parse(match[1])
    assert.equal(frame.reason, 'backoff', 'a suppressed stream says why without the phone parsing prose')
    assert.equal(frame.code, '__bridge/stream-backoff')
    assert.equal(frame.message, 'The Host is not accepting this stream yet.', 'the message is unchanged')
  } finally {
    await t.stop()
  }
})

test('SSE requires a sessionId', async () => {
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(`${t.base}/api/session/stream`, { headers: { cookie } })
    assert.equal(res.status, 400)
  } finally {
    await t.stop()
  }
})

test('SSE is rejected without a mobile cookie', async () => {
  const t = await startBridge()
  try {
    const res = await httpFetch(`${t.base}/api/session/stream?sessionId=sess-1`)
    assert.equal(res.status, 401)
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// K-7 (WP-BRIDGE-EXTRA) — the two facts the old literal `retry: 500` was standing
// in for, now pinned on their own terms. A constant here is a multiplier: every
// reconnect opens another carrier WebSocket, so the value has to grow while a
// conversation keeps failing, and it has to stop growing before it becomes the
// thing the user notices as "my phone is stuck".
// ---------------------------------------------------------------------------

test('K-7: a conversation with no recorded failure still opens at 500ms', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: { frames } })
  try {
    const cookie = await t.pairMobile('PocketRetry/1.0')
    assert.equal(t.bridge.streamRetryDelayMs('sess-1'), STREAM_RETRY_BASE_MS, 'nothing has failed on this bridge')
    const res = await httpFetch(`${t.base}/api/session/stream?sessionId=sess-1`, { headers: { cookie } })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let raw = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      raw += decoder.decode(value, { stream: true })
    }
    // The historical value, explicitly. This is the assertion that would have been
    // red the moment the dynamic cadence shipped with a different base — the right
    // place to notice, because this is the place the promise lives.
    assert.match(raw, /^retry: 500\n\n/, 'the first frame of a clean stream is still the 500ms cadence')
    assert.equal(STREAM_RETRY_BASE_MS, 500, 'and the base constant is that same 500')
  } finally {
    await t.stop()
  }
})

test('K-7: one recorded failure moves the published cadence, and the frame carries the new number', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: { frames } })
  try {
    const cookie = await t.pairMobile('PocketRetry2/1.0')
    // One failure: not gated (a person who reloads after a single blip must still
    // get a real answer), but the wait doubles. This is the case the literal in this
    // file used to hide — the stream opens with 1000 now, and would have been red.
    t.bridge.noteStreamFailure('sess-1')
    assert.equal(t.bridge.streamCooldownMs('sess-1'), 0, 'the first failure never gates')
    assert.equal(t.bridge.streamRetryDelayMs('sess-1'), STREAM_RETRY_BASE_MS * 2)
    const res = await httpFetch(`${t.base}/api/session/stream?sessionId=sess-1`, { headers: { cookie } })
    const raw = await new Promise(async (resolve) => {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let text = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
        if (/^retry: \d+\n\n/.test(text)) {
          resolve(text)
          reader.cancel().catch(() => {})
          return
        }
      }
      resolve(text)
    })
    assert.match(raw, /^retry: 1000\n\n/, 'the opening frame states the escalated cadence, not the constant')
  } finally {
    await t.stop()
  }
})

test('K-7: the ladder grows monotonically and plateaus at 15s — it never exceeds it', () => {
  const bridge = new LanMobileBridge({
    harnessUrl: () => 'http://127.0.0.1:9',
    innerAuth: { ready: async () => undefined, invalidate: () => {} },
    port: 0,
    pairingPinStore: { load: () => ({}), save: () => true },
    log: () => {},
  })
  const sessionId = 'sess-ladder'
  assert.equal(bridge.streamRetryDelayMs(sessionId), 500, 'clean')
  let previous = 500
  let plateauAt = -1
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    bridge.noteStreamFailure(sessionId)
    const delay = bridge.streamRetryDelayMs(sessionId)
    assert.ok(delay <= STREAM_RETRY_CAP_MS, `attempt ${attempt} exceeded the 15s ceiling (${delay})`)
    assert.ok(delay >= previous, `attempt ${attempt} shrank the wait (${previous} -> ${delay})`)
    if (delay === STREAM_RETRY_CAP_MS && plateauAt < 0) plateauAt = attempt
    previous = delay
  }
  assert.ok(plateauAt > 0, 'the ladder must reach the ceiling rather than grow without end')
  assert.equal(previous, STREAM_RETRY_CAP_MS, 'and it stays there')
  assert.equal(STREAM_RETRY_CAP_MS, 15_000, 'the ceiling is the documented 15 seconds')
  // A stream that came back clean retires the escalation entirely.
  bridge.noteStreamSuccess(sessionId)
  assert.equal(bridge.streamRetryDelayMs(sessionId), 500, 'recovery resets the cadence to the base')
})

// ---------------------------------------------------------------------------
// RC-2 (2026-10-02 rescan): `STREAM_BACKOFF_KEYS_MAX` was a dead knob. The
// constant existed with a docstring promising 128 slots, had zero consumers, and
// the eviction actually ran on `DEVICE_MAP_CAP` (16) — a number whose docstring
// is about the device/suspended-session maps. Past 16 failing conversations a
// still-reconnecting session's earned backoff was silently erased and its next
// transport failure restarted at the 500ms base, which is the traffic the ladder
// exists to suppress.
// ---------------------------------------------------------------------------

test('RC-2: the backoff map is bounded by STREAM_BACKOFF_KEYS_MAX, not by DEVICE_MAP_CAP', () => {
  const bridge = new LanMobileBridge({
    harnessUrl: () => 'http://127.0.0.1:9',
    innerAuth: { ready: async () => undefined, invalidate: () => {} },
    port: 0,
    pairingPinStore: { load: () => ({}), save: () => true },
    log: () => {},
  })
  // The two numbers must be genuinely different, or this test could not tell the
  // two bounds apart.
  assert.notEqual(STREAM_BACKOFF_KEYS_MAX, DEVICE_MAP_CAP, 'the documented slot count and the device cap are not the same number')
  assert.ok(STREAM_BACKOFF_KEYS_MAX > DEVICE_MAP_CAP, 'and the stream map is allowed more slots than the device maps')

  const ids = Array.from({ length: STREAM_BACKOFF_KEYS_MAX + 10 }, (_, i) => `sess-cap-${String(i).padStart(4, '0')}`)
  for (const id of ids) bridge.noteStreamFailure(id)

  assert.equal(bridge.streamBackoff.size, STREAM_BACKOFF_KEYS_MAX, 'the map stops at the documented bound')
  // Eviction is insertion-ordered: the oldest goes, the newest stays.
  assert.equal(bridge.streamBackoff.has(ids[0]), false, 'the earliest-failing conversation is the one evicted')
  assert.equal(bridge.streamBackoff.has(ids[ids.length - 1]), true, 'the most recent one is still tracked')
  // And the still-tracked ones keep the backoff they earned.
  assert.equal(bridge.streamRetryDelayMs(ids[ids.length - 1]), STREAM_RETRY_BASE_MS * 2, 'a tracked failure still escalates')
  assert.equal(bridge.streamRetryDelayMs(ids[0]), STREAM_RETRY_BASE_MS, 'an evicted one is back at the base')

  // The old bound must NOT be what is in force: at DEVICE_MAP_CAP slots this
  // conversation would already have been evicted.
  const survivor = ids[DEVICE_MAP_CAP + 1]
  assert.equal(bridge.streamBackoff.has(survivor), true, `slot ${DEVICE_MAP_CAP + 1} survives the documented bound but not the device one`)
})

// ---------------------------------------------------------------------------
// RC-4 (2026-10-02 rescan): `handleOpen` sent a second, hardcoded 30 while
// `HISTORY_PAGE_DEFAULT_MESSAGES = 30` already existed as the single source of
// truth for the history page. Two literals that happen to agree today drift
// silently. This test reads the real `session/follow` open frame off the wire.
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Accept one WebSocket upgrade and record every JSON text frame the client sends. */
function captureFollowOpens() {
  const opens = []
  const sockets = new Set()
  const server = http.createServer((_req, res) => res.writeHead(404).end())
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
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
    // Client frames are masked; decode just enough of RFC 6455 to read the text.
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
        const mask = masked ? buffer.subarray(offset, offset + 4) : null
        if (masked) offset += 4
        if (buffer.length < offset + length) return
        const payload = Buffer.from(buffer.subarray(offset, offset + length))
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
        buffer = buffer.subarray(offset + length)
        if (opcode !== 0x1 && opcode !== 0x0) continue
        try {
          opens.push(JSON.parse(payload.toString('utf8')))
        } catch {
          // not JSON — not ours
        }
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        opens,
        url: `http://127.0.0.1:${server.address().port}`,
        stop: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy()
            sockets.clear()
            server.close(() => done())
          }),
      })
    })
  })
}

test('RC-4: the follow window on the wire is HISTORY_PAGE_DEFAULT_MESSAGES, not a second literal', async () => {
  const capture = await captureFollowOpens()
  const t = await startBridge({ bridgeOptions: { harnessUrl: () => capture.url } })
  try {
    const cookie = await t.pairMobile('PocketFollow/1.0')
    const res = await httpFetch(`${t.base}/api/session/stream?sessionId=sess-follow`, { headers: { cookie } })
    const reader = res.body.getReader()
    const deadline = Date.now() + 4000
    // The carrier also opens `$events` and `workspace/follow` first, so wait for
    // the specific frame rather than for any frame at all.
    const sawFollow = () => capture.opens.some((frame) => frame.endpoint === 'session/follow')
    while (Date.now() < deadline && !sawFollow()) {
      const raced = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 100)),
      ])
      if (raced.timeout) continue
      if (raced.done) break
    }
    await reader.cancel().catch(() => {})

    const open = capture.opens.find((frame) => frame.endpoint === 'session/follow')
    assert.ok(open, `the bridge must open a session/follow on the carrier; got ${JSON.stringify(capture.opens)}`)
    assert.equal(
      open.payload.args.request.maxMessages,
      HISTORY_PAGE_DEFAULT_MESSAGES,
      'the follow window is the shared constant, so the two cannot drift'
    )
    assert.equal(open.payload.args.request.address.sessionId, 'sess-follow', 'and it follows the conversation that asked')
    assert.equal(open.payload.args.request.assistantStream, true, 'the token channel is still requested')

    // The wire value alone cannot prove the finding is fixed: the old literal and
    // the constant are both 30 today, so a revert would still read 30. What
    // distinguishes them is that the module must NAME the constant rather than
    // carry its own copy — which is the whole point of RC-4.
    const source = readFileSync(new URL('../lib/session-stream.js', import.meta.url), 'utf8')
    assert.match(source, /maxMessages: HISTORY_PAGE_DEFAULT_MESSAGES/, 'the follow window must reference the shared constant')
    assert.doesNotMatch(source, /maxMessages:\s*\d/, 'and must not carry a second numeric copy of it')
    assert.match(source, /HISTORY_PAGE_DEFAULT_MESSAGES[\s\S]*from '\.\/constants\.js'|import \{[^}]*HISTORY_PAGE_DEFAULT_MESSAGES[^}]*\} from '\.\/constants\.js'/, 'imported from constants.js, not redeclared locally')
    assert.doesNotMatch(source, /const HISTORY_PAGE_DEFAULT_MESSAGES/, 'no local shadow of the constant')
  } finally {
    await t.stop()
    await capture.stop()
  }
})
