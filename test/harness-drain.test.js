// WP-BRIDGE-EXTRA S2 — a Host answer the bridge throws away must be released.
//
// undici (the global fetch) does not return a connection to its pool until the
// response body has been consumed or cancelled. Two paths used to drop a non-2xx
// answer on the floor: `invokeHarnessCall` when the transport carried an HTTP
// failure, and `harnessFetch` when a 401 was replaced by its own retry. While the
// host answers `gateway/service-unavailable` every poll from every handset takes the
// first path, so the discarded bodies arrive at the failure rate of the phone.
//
// The mechanism is certain; the size of the damage (pool exhaustion, RPCs queueing
// behind it) is a hypothesis nobody has counted on a live host. So every assertion
// below pins the SHAPE — "the response this path decided to throw away is no longer
// left unread" — and never an absolute connection count.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge } from './helpers.js'

/**
 * A Response that records what became of its body.
 * `released` is true when the body was either read to the end or cancelled — both
 * hand the connection back; leaving it sitting there is the only leak.
 */
function tracked(status, body = '{"ok":false}') {
  const state = { cancelled: false }
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(body, 'utf8'))
      controller.close()
    },
  })
  const response = new Response(stream, { status })
  const cancel = response.body.cancel.bind(response.body)
  response.body.cancel = (reason) => {
    state.cancelled = true
    return cancel(reason)
  }
  return {
    response,
    state,
    get released() {
      return response.bodyUsed === true || state.cancelled === true
    },
  }
}

/** Replace the global fetch with prepared answers (restored by `restore`). */
function useFetchStub(queue) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const next = queue.shift()
    if (next === undefined) throw new Error(`fetch stub ran out of answers at ${String(url)}`)
    calls.push({ url: String(url), init })
    return next.response
  }
  return { calls, restore: () => { globalThis.fetch = real } }
}

test('S2: a non-2xx Host answer is released before the bridge drops it', async () => {
  const t = await startBridge()
  const lines = []
  t.bridge.log = (level, message) => lines.push(`${level} ${message}`)
  const failed = tracked(502)
  const stub = useFetchStub([failed])
  try {
    const result = await t.bridge.invokeHarnessCall('session/list', {})
    assert.equal(result.ok, false, 'the call still fails — this item is about the body, not the verdict')
    assert.equal(result.errorCode, '__bridge/transport', 'and it keeps the class B2 gave this branch')
    assert.ok(failed.released, 'a response nobody will ever read must be consumed or cancelled')
    // The B2 observability half of the same branch survives the fix.
    assert.ok(lines.some((line) => line.includes('harness answered 502')), lines.join(' | '))
  } finally {
    stub.restore()
    await t.stop()
  }
})

test('S2: a body being read is not cancelled out from under the reader', async () => {
  const t = await startBridge()
  const ok = tracked(200, JSON.stringify({ rpcId: 'not-the-one', result: { ok: true, value: 1 } }))
  const stub = useFetchStub([ok])
  try {
    // This lands on the rpcId-mismatch branch: the envelope was read, then thrown
    // away for a different reason. The point is that the new cancellation on the
    // non-2xx branch did not move ahead of the read.
    const result = await t.bridge.invokeHarnessCall('session/list', {})
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, '__bridge/rpc-mismatch')
    assert.equal(ok.state.cancelled, false, 'a read body is released by the read, not by a cancel')
    assert.ok(ok.released, 'and it is released either way')
  } finally {
    stub.restore()
    await t.stop()
  }
})

test('S2: the 401 that a retry replaces is released', async () => {
  const t = await startBridge()
  const denied = tracked(401, '{"error":"unauthorized"}')
  const accepted = tracked(200, '{"ok":true}')
  const stub = useFetchStub([denied, accepted])
  t.bridge.options.innerAuth = {
    ready: async () => 'dsh-auth-credential',
    invalidate: () => {},
  }
  try {
    const response = await t.bridge.harnessFetch(new URL('http://127.0.0.1:9/api/session/list'), {
      method: 'POST',
      body: '{}',
    })
    assert.equal(response, accepted.response, 'the retry is what the caller gets back')
    assert.ok(denied.released, 'the replaced 401 must not be dropped unread — nobody else can ever see it')
    assert.equal(stub.calls.length, 2, 'one send, one retry')
  } finally {
    stub.restore()
    await t.stop()
  }
})

test('S2: a 401 that IS the answer keeps its body for the caller', async () => {
  const t = await startBridge()
  const denied = tracked(401, '{"error":"unauthorized"}')
  const stub = useFetchStub([denied])
  // No credential to retry with: the 401 itself goes back to the caller.
  t.bridge.options.innerAuth = { ready: async () => undefined, invalidate: () => {} }
  try {
    const response = await t.bridge.harnessFetch(new URL('http://127.0.0.1:9/api/session/list'), {
      method: 'POST',
      body: '{}',
    })
    assert.equal(response, denied.response)
    assert.equal(denied.state.cancelled, false, 'ownership stays with the caller — never cancel what you return')
    assert.equal(await response.text(), '{"error":"unauthorized"}', 'and the body is still readable')
  } finally {
    stub.restore()
    await t.stop()
  }
})

test('S2: an upstream 5xx on the export proxy is released too', async () => {
  const t = await startBridge()
  const failed = tracked(500, 'boom at /internal/path')
  const lines = []
  t.bridge.log = (level, message) => lines.push(`${level} ${message}`)
  try {
    const written = { statusCode: 0, body: undefined }
    const response = {
      destroyed: false,
      headersSent: false,
      setHeader() {},
      end(chunk) {
        written.body = chunk
      },
    }
    t.bridge.harnessFetch = async () => failed.response
    await t.bridge.streamSessionExport({ method: 'GET' }, response, 'sess-1')
    assert.equal(written.body, 'Export is not available right now.', 'the generic 502 stays generic')
    assert.ok(failed.released, 'a host failure body is never forwarded, so it has to be released')
    assert.ok(lines.some((line) => line.includes('session export upstream 500')), lines.join(' | '))
  } finally {
    await t.stop()
  }
})
