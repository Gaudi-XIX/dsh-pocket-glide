// Coverage #6 SSE framing — FULL-STACK. The real bridge opens a WebSocket to
// the fake Harness mux and forwards session/follow items to the phone as a
// real text/event-stream response read over HTTP.
import { test } from 'node:test'
import assert from 'node:assert/strict'
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

    // Initial SSE retry directive.
    assert.match(raw, /retry: 500\n\n/)

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
