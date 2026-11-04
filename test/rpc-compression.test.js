// P0-1 (2026-11-04): the `/api/rpc` answer is the one JSON body big enough to
// be worth compressing — a whole session list is ~195 KB of JSON, and it
// crosses a public tunnel. Everything here goes through a real socket, so the
// assertions cover the route and not just a helper.
//
// What must stay true:
//   1. a caller that asks for br gets br, and it decodes to the same JSON;
//   2. a caller that asks for nothing gets the plain body and no
//      `content-encoding` — a header and a body must never disagree;
//   3. `DSH_POCKET_PRECOMPRESS=0` turns the whole path back to identity without
//      a code change (the switch is read per request, lib/bridge.js:10971);
//   4. only this one route gains compression. `/api/status` stays plain, the
//      document keeps its `sendHtml` shape, the assets keep their own
//      hash-checked branch, and a failed rpc stays plain too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { startBridge, httpFetch } from './helpers.js'

const bodyBytes = async (res) => Buffer.from(await new Response(res.body).arrayBuffer())

// A row fat enough that one of them clears the 4 KB floor on its own. Only the
// allowlisted projection values survive compaction whole, and `todos` is bounded
// by entry count rather than bytes (lib/projections.js:90-92), so the fat lives
// there on purpose.
const LONG = 'x'.repeat(200)
const fatValues = () => ({
  title: LONG,
  todos: Array.from({ length: 40 }, (_, index) => ({ content: LONG, status: 'pending', index })),
  modelSelection: { provider: 'p', model: LONG, reasoningEffort: 'high' },
  permissions: { currentValue: LONG },
  imageLimits: { maxImageBytes: 1048576, note: LONG }
})
const fatRow = (sessionId, updatedAt) => ({
  sessionId,
  workspaceId: 'w1',
  updatedAt,
  projections: { asOfSeq: 10, updatedAt, values: fatValues() }
})

const harness = {
  respond: (pathname) => {
    if (pathname === '/api/session/list') {
      return { ok: true, value: { items: [fatRow('s1', 1001), fatRow('s2', 1002), fatRow('s3', 1003)] } }
    }
    return undefined
  }
}

async function withBridge(run) {
  const t = await startBridge({ harness: 'fake', harnessOptions: harness })
  const cookie = await t.pairMobile()
  try {
    return await run(t, cookie)
  } finally {
    await t.stop()
  }
}

/** One rpc call with an explicit accept-encoding (null = none, like a test tool). */
function rpc(t, cookie, body, acceptEncoding = null) {
  const headers = { cookie, 'content-type': 'application/json' }
  if (acceptEncoding !== null) headers['accept-encoding'] = acceptEncoding
  return httpFetch(`${t.base}/api/rpc`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

// The body A1 names: one row only, so the floor is cleared by that row alone.
const LIST_ONE = { method: 'session.list', payload: { limit: 1 } }

test('A1 br is negotiated on the rpc answer and decodes to the same JSON', async () => {
  await withBridge(async (t, cookie) => {
    const res = await rpc(t, cookie, LIST_ONE, 'br')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-encoding'), 'br')
    const wire = await bodyBytes(res)
    assert.equal(Number(res.headers.get('content-length')), wire.length, 'content-length is the compressed length')
    assert.match(String(res.headers.get('vary')), /accept-encoding/i, 'every hop that stores it must know both shapes')
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
    const decoded = JSON.parse(zlib.brotliDecompressSync(wire).toString('utf8'))
    assert.equal(decoded.ok, true)
    assert.equal(decoded.value.items.length, 1, 'the answer is the same JSON, limit still trims')
  })
})

test('A2 no accept-encoding means no content-encoding and a parseable body', async () => {
  await withBridge(async (t, cookie) => {
    const res = await rpc(t, cookie, LIST_ONE)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-encoding'), null)
    assert.equal((await res.json()).ok, true, 'the plain body parses directly')
  })
})

test('A3 DSH_POCKET_PRECOMPRESS=0 answers identity even when br is asked for', async () => {
  const previous = process.env.DSH_POCKET_PRECOMPRESS
  process.env.DSH_POCKET_PRECOMPRESS = '0'
  try {
    await withBridge(async (t, cookie) => {
      const res = await rpc(t, cookie, LIST_ONE, 'br')
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-encoding'), null, 'the switch wins over accept-encoding')
      assert.equal((await res.json()).ok, true)
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_POCKET_PRECOMPRESS
    else process.env.DSH_POCKET_PRECOMPRESS = previous
  }
})

test('A4 only /api/rpc compresses: status, document, assets and failures keep their shapes', async () => {
  await withBridge(async (t, cookie) => {
    const status = await httpFetch(`${t.base}/api/status`, { headers: { cookie, 'accept-encoding': 'br, gzip' } })
    assert.equal(status.status, 200)
    assert.equal(status.headers.get('content-encoding'), null, '/api/status must stay plain')
    assert.equal(typeof JSON.parse(await status.text()), 'object', 'and still be JSON')

    // The document already compressed through sendHtml before this card; what
    // this card must not do is change that shape or take it over.
    const document = await httpFetch(`${t.base}/`, { headers: { cookie, 'accept-encoding': 'br' } })
    assert.equal(document.status, 200)
    assert.equal(document.headers.get('content-encoding'), 'br')
    assert.match(zlib.brotliDecompressSync(await bodyBytes(document)).toString('utf8'), /<html/i)

    // No `h`, so the asset branch answers the plain bytes with 200 (unchanged).
    const asset = await httpFetch(`${t.base}/app.js?l=zh`, { headers: { cookie, 'accept-encoding': 'br' } })
    assert.equal(asset.status, 200)
    assert.equal(asset.headers.get('content-encoding'), null, 'the asset branch keeps its own negotiation')
    assert.match(String(asset.headers.get('content-type')), /javascript/)

    // Failures stay on `json()`: a 400 is small and carries no negotiated shape.
    const failed = await rpc(t, cookie, { method: 'session.list', payload: { sessionIds: 'nope' } }, 'br')
    assert.equal(failed.status, 400)
    assert.equal(failed.headers.get('content-encoding'), null, 'a refusal is never compressed')
    assert.equal((await failed.json()).ok, false)
  })
})

test('A4b the same answer compresses once per shape (the memo is keyed by encoding and bytes)', async () => {
  await withBridge(async (t, cookie) => {
    const first = await rpc(t, cookie, LIST_ONE, 'gzip')
    const second = await rpc(t, cookie, LIST_ONE, 'gzip')
    assert.equal(first.headers.get('content-encoding'), 'gzip')
    assert.equal(second.headers.get('content-encoding'), 'gzip')
    assert.equal(Number(second.headers.get('content-length')), Number(first.headers.get('content-length')), 'a repeat request is served from the memo')
    assert.equal(JSON.parse(zlib.gunzipSync(await bodyBytes(second)).toString('utf8')).ok, true)
  })
})
