// Coverage #6 SSE framing — FULL-STACK. The real bridge opens a WebSocket to
// the fake Harness mux and forwards session/follow items to the phone as a
// real text/event-stream response read over HTTP.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LanMobileBridge } from '../lib/bridge.js'
import { STREAM_RETRY_BASE_MS, STREAM_RETRY_CAP_MS } from '../lib/constants.js'
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
