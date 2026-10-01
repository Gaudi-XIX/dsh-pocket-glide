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
  // state a phone sits in while it reads.
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(`${t.base}/api/session/stream?sessionId=sess-1`, { headers: { cookie } })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let raw = ''
    // The status frame arrives on its own cadence; the stream stays open.
    const deadline = Date.now() + 9000
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
