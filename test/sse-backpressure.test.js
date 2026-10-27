// SSE backpressure (audit D-P1-1).
//
// `lib/session-stream.js` used to call `response.write` nine times and never look
// at what came back. A phone on a tunnel that reads slowly — or an Android page
// that was backgrounded without closing its EventSource, which is how a page
// normally leaves — made the loopback carrier (always faster) push token frames
// into a buffer nothing drained, with no ceiling. These examples drive the real
// `streamSession` against a response whose `write` says "buffered" until the test
// says otherwise.
//
// What must hold:
//  - a live frame (token) that cannot be written is DROPPED, not queued: the Host
//    commits the durable event at the end of the turn, so nothing is lost;
//  - a durable frame (snapshot/event/failure/retry) is never dropped while the
//    phone is still reading: it waits for `drain`, in the order it was produced;
//  - a phone that never drains again ends the wait at the timeout instead of
//    pinning an unbounded buffer per session for the life of the process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { streamSession, SSE_DRAIN_TIMEOUT_MS } from '../lib/session-stream.js'

// ---------------------------------------------------------------------------
// A response that can be told to stop draining, exactly like a socket whose
// peer stopped reading.
// ---------------------------------------------------------------------------

function slowResponse() {
  const frames = []
  const response = Object.assign(new EventEmitter(), {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    destroyed: false,
    /** When false, `write` answers "buffered until drain" (Node's contract). */
    flowing: true,
    setHeader(name, value) {
      this.headers[name] = String(value)
    },
    flushHeaders() {},
    write(chunk) {
      if (!this.flowing) return false
      frames.push(String(chunk))
      return true
    },
    end() {
      this.writableEnded = true
    },
  })
  return { response, frames }
}

// ---------------------------------------------------------------------------
// A platform WebSocket the test drives frame by frame.
// ---------------------------------------------------------------------------

class DrivenSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  constructor() {
    this.readyState = DrivenSocket.CONNECTING
    this.listeners = new Map()
    this.sent = []
    queueMicrotask(() => {
      if (this.readyState !== DrivenSocket.CONNECTING) return
      this.readyState = DrivenSocket.OPEN
      this.emit('open', {})
    })
  }

  addEventListener(type, listener, options) {
    const entries = this.listeners.get(type) ?? []
    entries.push({ listener, once: Boolean(options?.once) })
    this.listeners.set(type, entries)
  }

  removeEventListener(type, listener) {
    const entries = this.listeners.get(type)
    if (!entries) return
    this.listeners.set(type, entries.filter((entry) => entry.listener !== listener))
  }

  emit(type, event) {
    for (const entry of [...(this.listeners.get(type) ?? [])]) {
      if (entry.once) this.removeEventListener(type, entry.listener)
      entry.listener(event)
    }
  }

  send(text) {
    this.sent.push(String(text))
  }

  close() {
    this.readyState = DrivenSocket.CLOSED
  }
}

let lastSocket
function installDrivenSocket() {
  const real = globalThis.WebSocket
  globalThis.WebSocket = class extends DrivenSocket {
    constructor(...args) {
      super(...args)
      lastSocket = this
    }
  }
  return () => {
    globalThis.WebSocket = real
  }
}

/** The smallest bridge surface `streamSession` reads, plus a short drain timeout. */
function harness({ drainTimeoutMs = SSE_DRAIN_TIMEOUT_MS } = {}) {
  const logs = []
  const bridge = {
    options: {
      harnessUrl: () => 'http://127.0.0.1:46999',
      innerAuth: { ready: async () => 'dsh-auth-test=1', invalidate: () => {} },
    },
    sessionStreamAborts: new Set(),
    // No status frame on a timer: these tests are about the frames under test.
    sseStatusMs: 3_600_000,
    sseDrainTimeoutMs: drainTimeoutMs,
    now: () => Date.now(),
    log: (level, message) => logs.push(`${level}: ${message}`),
    text: (res, status, body) => {
      res.statusCode = status
      res.end(body)
    },
    streamRetryDelayMs: () => 500,
    streamCooldownMs: () => 0,
    noteStreamFailure: () => {},
    noteStreamSuccess: () => {},
    buildStatusPayload: async () => ({}),
  }
  const request = Object.assign(new EventEmitter(), {})
  return { bridge, request, logs }
}

/** Open a stream and hand back the socket it is following the Host on. */
async function openedStream(t, options) {
  const restore = installDrivenSocket()
  t.after(restore)
  const { bridge, request, logs } = harness(options)
  const { response, frames } = slowResponse()
  // The socket this stream opens is the one that appears AFTER this call: an
  // earlier test's socket is still the module-level `lastSocket` until then, and
  // its listeners were removed by that test's cleanup.
  const before = lastSocket
  const running = streamSession(bridge, request, response, 'sess-backpressure')
  await until(() => lastSocket !== before && lastSocket.sent.length > 0, 'the stream to open its carrier')
  const socket = lastSocket
  const streamId = JSON.parse(socket.sent[0]).streamId
  // The opening cadence frame is written before the carrier opens, so a test
  // that starts driving frames must see it first; give the write a turn to land
  // so `frames[0]` assertions below mean what they say.
  await settle(0)
  /** Deliver one Host frame the way the mux would. */
  const deliver = (value) => socket.emit('message', { data: JSON.stringify({ type: 'item', streamId, value }) })
  const end = () => {
    socket.emit('message', { data: JSON.stringify({ type: 'end', streamId }) })
    return running
  }
  return { response, frames, logs, deliver, end }
}

/** A token frame: the live channel. */
const tokenFrame = (text) => ({ type: 'assistant-stream', frame: { type: 'chunk', revision: 'r1', index: 0, chunk: { text } } })
/** Any other item is a durable record. */
const durableEvent = (text) => ({ type: 'assistant/message', text })

/** Let the timers and microtasks behind an awaited push run. */
const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait until `predicate` holds. The stream opens its carrier from inside an
 * await chain, so how many turns that takes is not a number a test should
 * hard-code — `open` is driven by the socket itself, so this always resolves.
 */
async function until(predicate, what) {
  for (let tick = 0; tick < 400; tick += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`never saw ${what}`)
}

test('a phone that stopped reading loses live frames and keeps the durable ones', async (t) => {
  const { response, frames, deliver, end } = await openedStream(t)
  await settle()
  assert.equal(frames[0], 'retry: 500\n\n', 'the stream opened normally')

  // The phone stops reading, then the Host streams a turn.
  response.flowing = false
  deliver(tokenFrame('a'))
  deliver(tokenFrame('b'))
  deliver(durableEvent('the answer'))
  await settle()

  assert.equal(frames.filter((frame) => frame.startsWith('event: token')).length, 0, 'token frames are dropped rather than queued')
  assert.equal(frames.filter((frame) => frame.startsWith('event: event')).length, 0, 'the durable frame behind them waits instead of piling up')

  // The phone reads again: the durable frame goes out once it can.
  response.flowing = true
  response.emit('drain')
  await settle()
  const written = frames.filter((frame) => frame.startsWith('event: event'))
  assert.equal(written.length, 1, 'the committed event is delivered once the phone reads')
  assert.match(written[0], /the answer/)

  await end()
  assert.equal(response.writableEnded, true)
})

test('a phone that keeps up loses nothing, live or durable', async (t) => {
  const { frames, logs, deliver, end } = await openedStream(t)
  await settle()
  deliver(tokenFrame('hel'))
  deliver(tokenFrame('lo'))
  deliver(durableEvent('hello'))
  await settle()

  assert.equal(frames.filter((frame) => frame.startsWith('event: token')).length, 2, `both live frames reach a phone that is reading: ${JSON.stringify(frames)}`)
  assert.equal(frames.filter((frame) => frame.startsWith('event: event')).length, 1)
  assert.deepEqual(logs.filter((line) => line.includes('not being read')), [], 'and nothing is reported as dropped')

  await end()
})

test('a phone that never reads again ends the wait at the drain timeout', async (t) => {
  const { response, frames, logs, deliver, end } = await openedStream(t, { drainTimeoutMs: 30 })
  await settle()
  response.flowing = false
  deliver(durableEvent('never seen'))
  await settle(80)

  assert.equal(frames.filter((frame) => frame.startsWith('event: event')).length, 0, 'the frame is not written into a dead socket')
  assert.ok(
    logs.some((line) => line.includes('gave up on a phone that stopped reading')),
    `the wait ends with a log line naming the reason: ${JSON.stringify(logs)}`,
  )

  response.flowing = true
  await end()
})
