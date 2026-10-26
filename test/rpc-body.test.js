// Coverage #4 POST /api/rpc body validation and #5 server-controlled requestId.
// FULL-STACK: real HTTP through the real bridge into the minimal fake Harness.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startBridge, httpFetch } from './helpers.js'
import { MAX_BODY_BYTES, LARGE_BODY_BYTES } from '../lib/constants.js'

async function rpc(t, cookie, body, headers = {}) {
  return httpFetch(`${t.base}/api/rpc`, {
    method: 'POST',
    headers: { cookie, ...headers },
    body,
  })
}

test('empty request body is rejected with 400 and a generic message', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, '')
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error, 'Malformed request body.')
  } finally {
    await t.stop()
  }
})

test('malformed JSON is rejected with 400 without leaking parser text', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, '{not json')
    assert.equal(res.status, 400)
    const text = await res.text()
    assert.match(text, /Malformed request body\./)
    // V8's native parser detail must not be surfaced.
    assert.doesNotMatch(text, /Unexpected token|Expected property|JSON\.parse/i)
  } finally {
    await t.stop()
  }
})

test('JSON array body is rejected with 400', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, '[1,2,3]')
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'Malformed request body.')
  } finally {
    await t.stop()
  }
})

test('JSON string literal body is rejected with 400', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, '"a plain string"')
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'Malformed request body.')
  } finally {
    await t.stop()
  }
})

test('normal-tier body over 64KB is rejected with 413', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const oversized = JSON.stringify({ method: 'settings.describe', payload: { pad: 'x'.repeat(70 * 1024) } })
    assert.ok(oversized.length > 64 * 1024)
    const res = await rpc(t, cookie, oversized, { 'content-type': 'application/json' })
    assert.equal(res.status, 413)
    assert.equal((await res.json()).error, 'Request body is too large.')
  } finally {
    await t.stop()
  }
})

test('well-formed object with an unknown method gets past parsing to the 403 allowlist', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, JSON.stringify({ method: 'not.a.real.method', payload: {} }), {
      'content-type': 'application/json',
    })
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error, 'RPC method is not available on mobile.')
  } finally {
    await t.stop()
  }
})

test('well-formed object without a method gets past parsing to the 403 allowlist', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, JSON.stringify({ payload: {} }), {
      'content-type': 'application/json',
    })
    assert.equal(res.status, 403)
  } finally {
    await t.stop()
  }
})

test('requestId is server-controlled: client requestId cannot survive', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const evilId = 'client-controlled-id-123'
    const res = await rpc(
      t,
      cookie,
      JSON.stringify({
        method: 'session.prompt',
        payload: {
          sessionId: 'sess-1',
          mode: 'queue',
          content: [{ type: 'text', text: 'hi' }],
          requestId: evilId,
        },
      }),
      { 'content-type': 'application/json' }
    )
    assert.equal(res.status, 200)
    // The special handler builds { request: { ...payload, requestId: <uuid> } }
    // with requestId spread LAST, so it overwrites any client value.
    const request = t.harness.records.promptArgs.request
    assert.notEqual(request.requestId, evilId)
    assert.match(request.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // Original payload fields survive alongside the server id.
    assert.equal(request.mode, 'queue')
    assert.equal(request.sessionId, 'sess-1')
    assert.deepEqual(request.content, [{ type: 'text', text: 'hi' }])
  } finally {
    await t.stop()
  }
})

test('an oversized body is refused before the bridge has taken the whole thing', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const url = new URL(`${t.base}/api/rpc`)
    const envelope = JSON.stringify({ method: 'settings.describe', payload: {} })
    // Declared one byte past the small tier. The answer must come from the
    // header, not from 64 KB of buffering: the body is never finished, so a
    // bridge that waits for every declared byte would sit here until the
    // watchdog below destroys the socket and this assertion fails on timeout.
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          agent: false,
          headers: {
            cookie,
            'content-type': 'application/json',
            'content-length': String(MAX_BODY_BYTES + 1),
          },
        },
        resolve
      )
      req.on('error', reject)
      req.write(envelope)
      setTimeout(() => req.destroy(new Error('the bridge waited for the declared body')), 4000)
    })
    assert.equal(res.statusCode, 413)
    const body = await new Promise((resolve) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => resolve(text))
    })
    assert.equal(JSON.parse(body).error, 'Request body is too large.')
  } finally {
    await t.stop()
  }
})

test('a method on the large tier is not refused by the small tier', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const url = new URL(`${t.base}/api/rpc`)
    // Same declared size, on the base64 tier: the ceiling has to follow the
    // method, or file.upload and session.prompt lose their big payloads.
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          agent: false,
          headers: {
            cookie,
            'content-type': 'application/json',
            'content-length': String(MAX_BODY_BYTES + 1),
          },
        },
        resolve
      )
      req.on('error', reject)
      req.write(JSON.stringify({ method: 'file.upload', payload: { sessionId: 's', data: 'x'.repeat(MAX_BODY_BYTES) } }))
      req.end()
    })
    assert.notEqual(res.statusCode, 413, `large tier must accept up to ${LARGE_BODY_BYTES} bytes`)
  } finally {
    await t.stop()
  }
})

test('valid allowlisted call is forwarded to the Harness and its result returned', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(
      t,
      cookie,
      JSON.stringify({ method: 'session.prompt', payload: { sessionId: 's', content: [] } }),
      { 'content-type': 'application/json' }
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// WP-OPS-BRIDGE B2 / X4④ — the history shape ladder is now an observable thing.
//
// The ladder can ask the Host three different shapes for the same page, each
// with its own 30 second timeout, while the phone's own fetch gives up at 12s.
// Nothing said which shape ran or how long it took, so "history timed out" on
// the phone was indistinguishable from "the shape is wrong", and a retry doubled
// the pressure on a Host that was already slow. One line per attempt, carrying
// the bounds that attempt sent (never the content), is the fix.
// ---------------------------------------------------------------------------

test('B2 X4④: every history attempt is logged with its bounds and its duration', async () => {
  const lines = []
  const emptyPages = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname, args) => {
        if (pathname === '/api/session/list') {
          return {
            ok: true,
            value: {
              items: [
                { sessionId: 'sess-ladder', updatedAt: 1, projections: { asOfSeq: 40 } },
              ],
            },
          }
        }
        if (pathname === '/api/session/page') {
          emptyPages.push(args.request)
          return { ok: true, value: { records: [], hasMore: false } }
        }
        return undefined
      },
    },
    bridgeOptions: { log: (level, message) => lines.push(`${level} ${message}`) },
  })
  try {
    const cookie = await t.pairMobile('PocketLadder/1.0')
    const res = await httpFetch(`${t.base}/api/rpc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'session.history', payload: { sessionId: 'sess-ladder', maxMessages: 30 } }),
    })
    assert.equal(res.status, 200, 'the ladder still answers; it is only no longer silent')

    const attempts = lines.filter((line) => line.includes('history attempt stage=rpc'))
    // Invariant, not an absolute: one line per Host page call the ladder made.
    assert.equal(
      attempts.length,
      emptyPages.length,
      `${String(attempts.length)} log lines for ${String(emptyPages.length)} Host page calls`
    )
    assert.ok(attempts.length >= 2, 'an empty newest page walks more than one shape')
    for (const line of attempts) {
      assert.match(line, /n=\d+\/\d+/, 'which attempt of how many')
      assert.match(line, /ms=\d+/, 'how long it took')
      assert.match(line, /throughSeq=\d+/, 'the cursor it carried (also the Q4 stale-ceiling channel)')
      assert.match(line, /verdict=(ok|empty|failed|shape-mismatch)/, 'and what came back')
    }
    assert.match(attempts[0], /n=1\//)
    assert.notEqual(attempts[0], attempts[1], 'two attempts logged the identical shape')
  } finally {
    await t.stop()
  }
})

test('B2 X4④: a fast accepted first attempt is not logged', async () => {
  // The one case where the ladder does exactly what it should on the first try.
  // Logging it would put three lines into a 512KB file for a healthy read, so
  // the ladder stays quiet while nothing is wrong — that is what keeps the
  // failure lines readable when something is.
  const lines = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => {
        if (pathname === '/api/session/list') {
          return {
            ok: true,
            value: {
              items: [
                { sessionId: 'sess-quick', updatedAt: 1, projections: { asOfSeq: 12 } },
              ],
            },
          }
        }
        if (pathname === '/api/session/page') {
          return { ok: true, value: { records: [{ seq: 12, type: 'user/message', data: {} }], hasMore: false } }
        }
        return undefined
      },
    },
    bridgeOptions: { log: (level, message) => lines.push(`${level} ${message}`) },
  })
  try {
    const cookie = await t.pairMobile('PocketQuick/1.0')
    const res = await httpFetch(`${t.base}/api/rpc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'session.history', payload: { sessionId: 'sess-quick', maxMessages: 30 } }),
    })
    assert.equal(res.status, 200)
    const attempts = lines.filter((line) => line.includes('history attempt'))
    assert.deepEqual(attempts, [], `a healthy first attempt logged: ${attempts.join(' | ')}`)
  } finally {
    await t.stop()
  }
})
