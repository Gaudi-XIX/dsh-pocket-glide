// Coverage #4 POST /api/rpc body validation and #5 server-controlled requestId.
// FULL-STACK: real HTTP through the real bridge into the minimal fake Harness.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, httpFetch } from './helpers.js'

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
