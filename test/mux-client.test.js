// WP-AUTH-RETRY — the credential lifecycle of the two WebSocket consumers.
//
// The process credential the bridge redeems is minted for ONE authority: the
// host's `BrowserAuth` puts the normalized hostname + port into the cookie it
// signs. The mux downlink and the session stream both read that credential from
// the same cached `innerAuth`, and two things can make the cached copy wrong:
//
//   1. the harness base itself moves (`harnessUrl()` is re-read every round, so
//      a Host that comes back on another port hands out a launch URL the cached
//      cookie no longer matches), and
//   2. a carrier the Host refused — but the platform WebSocket the bridge runs
//      on (`lib/mux-client.js` uses the Node global, NOT npm `ws`) exposes no
//      handshake status, so a refused upgrade and a network fault are
//      indistinguishable from out here. A failure that happened before `open`
//      is therefore the only observable signal left for case 2.
//
// The tests below pin both, and just as importantly pin what must NOT redeem
// again: a carrier that opened and then dropped, a host refused follow, a phone
// that walked away, and the suppressed (backoff) stream all keep the credential,
// because in each of those the cookie was demonstrably accepted.
//
// The mock WebSocket is a plain recorder — the tests drive 'open'/'error'/'close'
// by hand so a single Node process exercises the handshake outcomes undici would
// only produce against a real Host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMuxMonitor } from '../lib/mux-client.js'
import { streamSession } from '../lib/session-stream.js'

// ---------------------------------------------------------------------------
// Fake platform WebSocket
// ---------------------------------------------------------------------------

/** Every socket the code under test constructed, oldest first. */
const sockets = []
/** Decides what one socket does, from its 1-based attempt number. */
let behaviour = () => 'fail'

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  constructor(url, options) {
    this.url = String(url)
    this.options = options
    this.readyState = FakeWebSocket.CONNECTING
    this.sent = []
    this.listeners = new Map()
    sockets.push(this)
    this.plan = behaviour(sockets.length, this)
    if (this.plan === 'fail') {
      // The Host refused the upgrade: undici surfaces that asynchronously, which
      // is why the listeners below exist by the time this runs.
      queueMicrotask(() => this.emit('error', {}))
    } else if (this.plan === 'close-without-error') {
      queueMicrotask(() => this.emit('close', {}))
    } else if (this.plan === 'open-then-fail') {
      queueMicrotask(() => {
        this.open()
        queueMicrotask(() => this.emit('error', {}))
      })
    } else if (this.plan === 'open-then-end') {
      // The Host accepts, and answers whatever logical stream the client opens,
      // in `send()` below.
      queueMicrotask(() => this.open())
    }
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open', {})
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
    // A snapshot: `once` listeners (and cleanup()) mutate the list while we walk it.
    for (const entry of [...(this.listeners.get(type) ?? [])]) {
      if (entry.once) this.removeEventListener(type, entry.listener)
      entry.listener(event)
    }
  }

  send(text) {
    this.sent.push(String(text))
    // 'open-then-end': answer the logical stream the client just opened with the
    // Host's normal end-of-follow frame, reusing the id it sent.
    if (this.plan !== 'open-then-end') return
    let streamId
    try {
      streamId = JSON.parse(String(text)).streamId
    } catch {
      return
    }
    if (typeof streamId !== 'string' || !streamId) return
    queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'end', streamId }) }))
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
  }
}

function installFakeWebSocket() {
  const real = globalThis.WebSocket
  globalThis.WebSocket = FakeWebSocket
  return () => {
    globalThis.WebSocket = real
  }
}

/** Longest a test waits for the fake socket to be constructed, in ms. */
const WAIT_MS = 5000

/** Spin until `predicate` holds, yielding to the event loop between checks. */
async function until(predicate) {
  const deadline = Date.now() + WAIT_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('the code under test never opened a socket')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Let the microtask + timer work queued behind the current step finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

// ---------------------------------------------------------------------------
// The mux downlink monitor
// ---------------------------------------------------------------------------

/**
 * One monitor over a scripted list of harness bases. `harnessUrl()` walks the
 * list and then returns undefined for every later round, so a run makes exactly
 * as many attempts as the list has entries and then parks in the `!base` branch.
 */
function muxHarness(bases) {
  const invalidations = []
  const logs = []
  const seen = {}
  let cursor = 0
  const monitor = createMuxMonitor({
    harnessUrl: () => (cursor < bases.length ? bases[cursor++] : undefined),
    innerAuth: {
      // F-3 (2026-10-07-fix-pocket-contract-minis): record the signal that
      // reaches innerAuth.ready so a test can assert it is forwarded verbatim.
      ready: async (signal) => {
        seen.readySignal = signal
        return 'dsh-auth-test=1'
      },
      invalidate: () => invalidations.push(1),
    },
    pendingQuestions: new Map(),
    log: (level, message) => logs.push(`${level}: ${message}`),
    now: () => Date.now(),
    consumeMuxEnvelope: () => {},
    setEventClientId: () => {},
    reportMuxState: () => {},
  })
  return { monitor, invalidations, logs, seen }
}

/** Drive `monitorMux` through `attempts` failures and return what it redeemed. */
async function muxRun(bases, attempts) {
  const start = sockets.length
  const harness = muxHarness(bases)
  const controller = new AbortController()
  const running = harness.monitor.monitorMux(controller.signal)
  try {
    await until(() => sockets.length - start >= attempts)
    await settle()
  } finally {
    controller.abort()
  }
  await running
  return { attempts: sockets.length - start, invalidations: harness.invalidations.length, logs: harness.logs }
}

test('a harness base that moved costs exactly one extra redemption', async () => {
  const restore = installFakeWebSocket()
  try {
    behaviour = () => 'fail'
    // Same base twice, then the base moves. Two refused downlinks redeem once
    // each in both runs (the never-opened rule), and the opening transition from
    // "no base seen yet" redeems once as well — so the stable run totals three.
    const stable = await muxRun(['http://127.0.0.1:41001', 'http://127.0.0.1:41001'], 2)
    const moved = await muxRun(['http://127.0.0.1:41001', 'http://127.0.0.1:41002'], 2)

    assert.equal(stable.attempts, 2, 'two downlink attempts were driven')
    assert.equal(moved.attempts, 2, 'and two for the run whose base moved')
    assert.equal(stable.invalidations, 3, 'two refusals plus the opening transition')
    assert.equal(moved.invalidations, stable.invalidations + 1, 'only the second base costs an extra redemption')
  } finally {
    restore()
  }
})

test('a carrier that never opened redeems again, with its existing failure text', async () => {
  const restore = installFakeWebSocket()
  try {
    behaviour = () => 'fail'
    const run = await muxRun(['http://127.0.0.1:42001'], 1)
    assert.equal(run.attempts, 1)
    // The opening transition plus the refusal: a carrier no Host ever accepted
    // is the one case where the cached cookie is the prime suspect.
    assert.equal(run.invalidations, 2)
    assert.ok(
      run.logs.some((line) => line === 'warn: mux downlink lost: Harness mux WebSocket failed.'),
      `the operator line is unchanged, saw ${JSON.stringify(run.logs)}`
    )
  } finally {
    restore()
  }
})

test('a carrier that opened and then dropped keeps the credential', async () => {
  const restore = installFakeWebSocket()
  try {
    behaviour = () => 'open-then-fail'
    const start = sockets.length
    const harness = muxHarness(['http://127.0.0.1:43001'])
    const controller = new AbortController()
    const running = harness.monitor.monitorMux(controller.signal)
    try {
      await until(() => sockets.length - start >= 1)
      await settle()
    } finally {
      controller.abort()
    }
    await running
    // The Host accepted the handshake, so the cookie was good: the drop is a
    // carrier fault and must not force a redemption.
    assert.equal(harness.invalidations.length, 1, 'only the opening transition redeemed')
    assert.ok(harness.logs.some((line) => line.includes('Harness mux WebSocket failed.')), 'the drop is still logged')
  } finally {
    restore()
  }
})

test('an abort while the carrier is still connecting keeps the credential', async () => {
  const restore = installFakeWebSocket()
  try {
    behaviour = () => 'hang'
    const start = sockets.length
    const harness = muxHarness(['http://127.0.0.1:44001'])
    const controller = new AbortController()
    const running = harness.monitor.monitorMux(controller.signal)
    await until(() => sockets.length - start >= 1)
    controller.abort()
    await running
    assert.equal(harness.invalidations.length, 1, 'shutdown is not a credential problem')
    assert.equal(harness.logs.length, 0, 'and it is not an operator warning either')
  } finally {
    restore()
  }
})

test('the carrier keeps its two failure texts and never redeems on its own', async () => {
  const restore = installFakeWebSocket()
  try {
    const harness = muxHarness([])
    const signal = new AbortController().signal
    behaviour = () => 'fail'
    await assert.rejects(
      harness.monitor.consumeMux('http://127.0.0.1:45001', signal),
      (error) => error instanceof Error && error.message === 'Harness mux WebSocket failed.'
    )
    behaviour = () => 'close-without-error'
    await assert.rejects(
      harness.monitor.consumeMux('http://127.0.0.1:45001', signal),
      (error) => error instanceof Error && error.message === 'Harness mux WebSocket closed.'
    )
    assert.equal(harness.seen.readySignal, signal, 'innerAuth.ready receives the exact signal consumeMux got (F-3)')
    assert.equal(harness.invalidations.length, 0, 'the monitor owns redemption, not the carrier')
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// The session stream
// ---------------------------------------------------------------------------

/** The smallest bridge surface `streamSession` actually reads. */
function sseHarness() {
  const frames = []
  const invalidations = []
  const state = { failures: 0, successes: 0, logs: [] }
  const response = {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    destroyed: false,
    setHeader(name, value) {
      this.headers[name] = String(value)
    },
    flushHeaders() {},
    write(chunk) {
      frames.push(String(chunk))
      return true
    },
    end() {
      this.writableEnded = true
    },
  }
  const request = { once() {}, removeListener() {} }
  const bridge = {
    options: {
      harnessUrl: () => 'http://127.0.0.1:46001',
      innerAuth: {
        ready: async () => 'dsh-auth-test=1',
        invalidate: () => invalidations.push(1),
      },
    },
    sessionStreamAborts: new Set(),
    sseStatusMs: 30_000,
    now: () => Date.now(),
    log: (level, message) => state.logs.push(`${level}: ${message}`),
    text: (res, status, body) => {
      res.statusCode = status
      res.end(body)
    },
    streamRetryDelayMs: () => 500,
    streamCooldownMs: () => 0,
    noteStreamFailure: () => {
      state.failures += 1
    },
    noteStreamSuccess: () => {
      state.successes += 1
    },
    buildStatusPayload: async () => ({}),
  }
  return { bridge, request, response, frames, invalidations, state }
}

/** The parsed body of the last `event: failure` frame, or undefined. */
function failureFrame(frames) {
  const frame = [...frames].reverse().find((entry) => entry.startsWith('event: failure\ndata: '))
  if (!frame) return undefined
  return JSON.parse(frame.slice('event: failure\ndata: '.length))
}

test('a session stream that never opened redeems again, and its frames are unchanged', async () => {
  const restore = installFakeWebSocket()
  try {
    behaviour = () => 'fail'
    const h = sseHarness()
    await streamSession(h.bridge, h.request, h.response, 'session-auth-1')

    // The phone asked for an SSE response and gets one: the status code and the
    // cadence frame are the contract, and neither changes here.
    assert.equal(h.response.statusCode, 200)
    assert.equal(h.frames[0], 'retry: 500\n\n')
    assert.deepEqual(failureFrame(h.frames), {
      message: 'Session stream could not reach the Host.',
      code: '__bridge/stream-transport',
      reason: 'transport',
      retryMs: 500,
    })
    assert.equal(h.frames.at(-1), 'retry: 500\n\n', 'the cadence is re-stated on the way out')
    assert.equal(h.invalidations.length, 1, 'the refused handshake drops the cached cookie')
    assert.equal(h.state.failures, 1, 'and it still counts as a stream failure')
  } finally {
    restore()
  }
})

test('a session stream that opened and then dropped keeps the credential', async () => {
  const restore = installFakeWebSocket()
  try {
    behaviour = () => 'open-then-fail'
    const h = sseHarness()
    await streamSession(h.bridge, h.request, h.response, 'session-auth-2')
    assert.equal(h.response.statusCode, 200)
    assert.equal(failureFrame(h.frames)?.code, '__bridge/stream-transport')
    assert.equal(h.invalidations.length, 0, 'the Host accepted the cookie, so the drop is not a credential fault')
    assert.equal(h.state.failures, 1)
  } finally {
    restore()
  }
})

test('a session stream the Host ends keeps the credential', async () => {
  const restore = installFakeWebSocket()
  try {
    behaviour = () => 'open-then-end'
    const h = sseHarness()
    await streamSession(h.bridge, h.request, h.response, 'session-auth-3')
    assert.equal(h.invalidations.length, 0, 'a clean follow is not a credential problem')
    assert.equal(h.state.successes, 1, 'and it clears the conversation backoff')
    assert.equal(h.state.failures, 0)
    assert.equal(failureFrame(h.frames), undefined, 'a clean end tells the phone nothing is wrong')
  } finally {
    restore()
  }
})

test('a suppressed stream never touches the credential', async () => {
  const restore = installFakeWebSocket()
  try {
    behaviour = () => 'fail'
    const start = sockets.length
    const h = sseHarness()
    h.bridge.streamCooldownMs = () => 1200
    await streamSession(h.bridge, h.request, h.response, 'session-auth-4')
    assert.equal(sockets.length - start, 0, 'a gated attempt never reaches the Host')
    assert.equal(h.invalidations.length, 0)
    assert.deepEqual(failureFrame(h.frames), {
      message: 'The Host is not accepting this stream yet.',
      code: '__bridge/stream-backoff',
      reason: 'backoff',
      retryInMs: 1200,
    })
  } finally {
    restore()
  }
})
