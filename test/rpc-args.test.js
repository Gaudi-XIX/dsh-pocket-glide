// WP-SEC-BRIDGE B1 — the paging knobs a phone may hand the Host, the media type
// an attachment record may name, and the status code every input failure wears.
//
// Root cause this file exists to keep fixed: `typeof NaN === 'number'` is true.
// `session.history` used to read `maxMessages` / `beforeSeq` with that check and
// nothing else, so NaN, -1, 1e9 and 1.5 all went out to the Host's `session/page`
// verbatim (and the third fallback widened one again with `Math.max(max, 60)`) —
// one RPC from a paired phone was enough to make the desktop serialise an
// unbounded page.
// FULL-STACK over real HTTP against a real bridge + the fake Harness, so the
// assertions cover the route and not only the helper.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readNumericArgument, attachmentDisposition } from '../lib/bridge.js'
import { HISTORY_PAGE_DEFAULT_MESSAGES, HISTORY_PAGE_MAX_MESSAGES, SESSION_LIST_MAX_ROWS } from '../lib/constants.js'
import { startBridge, httpFetch } from './helpers.js'

async function rpc(t, cookie, body) {
  return httpFetch(`${t.base}/api/rpc`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** The list row that carries a cursor, plus an empty page for the read itself. */
const harnessWithCursor = {
  respond: (pathname) => {
    if (pathname === '/api/session/list') {
      return { ok: true, value: { items: [{ sessionId: 's1', projections: { asOfSeq: 10 } }] } }
    }
    if (pathname === '/api/session/page') return { ok: true, value: { records: [], hasMore: false } }
    return undefined
  },
}

test('readNumericArgument refuses every value `typeof x === "number"` used to wave through', () => {
  const spec = { name: 'maxMessages', fallback: 30, max: HISTORY_PAGE_MAX_MESSAGES }
  const rejected = [
    ['NaN', NaN],
    ['negative', -1],
    ['zero', 0],
    ['1e9', 1e9],
    ['float', 1.5],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['string digits', '30'],
    ['boolean', true],
    ['plain object', {}],
    ['array', [30]],
  ]
  for (const [label, value] of rejected) {
    const result = readNumericArgument(value, spec)
    assert.equal(result.ok, false, `${label} must be refused`)
    assert.match(result.error, /^maxMessages must be /)
  }
})

test('readNumericArgument keeps documented defaults and accepts the edges', () => {
  const spec = { name: 'maxMessages', fallback: 30, max: HISTORY_PAGE_MAX_MESSAGES }
  assert.deepEqual(readNumericArgument(undefined, spec), { ok: true, value: 30 }, '缺省走文档默认')
  assert.deepEqual(readNumericArgument(null, spec), { ok: true, value: 30 }, 'null 走默认，不是 NaN')
  assert.deepEqual(readNumericArgument(1, spec), { ok: true, value: 1 }, '下界')
  assert.deepEqual(readNumericArgument(HISTORY_PAGE_MAX_MESSAGES, spec), { ok: true, value: HISTORY_PAGE_MAX_MESSAGES }, '上界含')
  assert.equal(readNumericArgument(HISTORY_PAGE_MAX_MESSAGES + 1, spec).ok, false, '越上界拒绝')
  // A cursor offset is a different range: 0 is a legitimate position.
  const seq = { name: 'beforeSeq', fallback: undefined, min: 0, max: Number.MAX_SAFE_INTEGER }
  assert.deepEqual(readNumericArgument(0, seq), { ok: true, value: 0 })
  assert.equal(readNumericArgument(-1, seq).ok, false)
  assert.equal(readNumericArgument(1.5, seq).ok, false)
  assert.deepEqual(readNumericArgument(undefined, seq), { ok: true, value: undefined })
})

test('session.history out-of-window paging is a 400 and never reaches the Harness', async () => {
  const bad = [
    { maxMessages: -1 },
    { maxMessages: -30 },
    { maxMessages: 0 },
    { maxMessages: 1e9 },
    { maxMessages: 1e6 },
    { maxMessages: HISTORY_PAGE_MAX_MESSAGES + 1 },
    { maxMessages: 1.5 },
    { maxMessages: '30' },
    { maxMessages: true },
    { maxMessages: [30] },
    { beforeSeq: -1 },
    { beforeSeq: 1.5 },
    { beforeSeq: '5' },
    { beforeSeq: -1e9 },
  ]
  const t = await startBridge({ harness: 'fake', harnessOptions: harnessWithCursor })
  try {
    const cookie = await t.pairMobile()
    for (const payload of bad) {
      const before = t.harness.records.calls.length
      const res = await rpc(t, cookie, { method: 'session.history', payload: { sessionId: 's1', ...payload } })
      assert.equal(res.status, 400, JSON.stringify(payload))
      const body = await res.json()
      assert.equal(body.ok, false)
      assert.equal(body.errorCode, '__bridge/invalid-arguments', 'a distinct code, not host prose')
      assert.deepEqual(
        t.harness.records.calls.slice(before).filter((call) => call.url === '/api/session/page'),
        [],
        `no Host page call for ${JSON.stringify(payload)}`
      )
    }
  } finally {
    await t.stop()
  }
})

test('JSON has no NaN: the wire sends null, and null keeps the documented default', async () => {
  // Worth pinning next to the NaN guard: `JSON.stringify({maxMessages: NaN})`
  // produces `null`, so the in-process NaN case arrives over HTTP as null. It
  // must land on the default page size, never on an unbounded one.
  assert.equal(JSON.stringify({ maxMessages: NaN }), '{"maxMessages":null}')
  const t = await startBridge({ harness: 'fake', harnessOptions: harnessWithCursor })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, { method: 'session.history', payload: { sessionId: 's1', maxMessages: null } })
    assert.equal(res.status, 200)
    const pages = t.harness.records.calls.filter((call) => call.url === '/api/session/page')
    assert.ok(pages.length >= 1)
    assert.equal(pages[0].args.request.maxMessages, HISTORY_PAGE_DEFAULT_MESSAGES, 'default, not NaN, not unbounded')
    assert.ok(Number.isInteger(pages[0].args.request.maxMessages))
    // Same for the cursor: null means "no cursor", which the bounded default path
    // handles, and must not reach the Host as a number at all.
    const withNullCursor = await rpc(t, cookie, { method: 'session.history', payload: { sessionId: 's1', beforeSeq: null } })
    assert.equal(withNullCursor.status, 200)
    assert.ok(
      t.harness.records.calls
        .filter((call) => call.url === '/api/session/page')
        .every((call) => call.args.request.beforeSeq === undefined || Number.isInteger(call.args.request.beforeSeq)),
      'a null cursor never becomes a numeric one'
    )
  } finally {
    await t.stop()
  }
})


test('a well-formed session.history still reaches the Harness with the same numbers', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: harnessWithCursor })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, { method: 'session.history', payload: { sessionId: 's1', maxMessages: 25 } })
    assert.equal(res.status, 200)
    const page = t.harness.records.calls.filter((call) => call.url === '/api/session/page')
    assert.ok(page.length >= 1, 'the accepted call does go through')
    assert.equal(page[0].args.request.maxMessages, 25)
    // The widened fallback is bounded too, whatever the client asked for.
    for (const call of page) {
      assert.ok(call.args.request.maxMessages <= HISTORY_PAGE_MAX_MESSAGES, `bounded fallback, saw ${call.args.request.maxMessages}`)
    }
    const older = await rpc(t, cookie, { method: 'session.history', payload: { sessionId: 's1', beforeSeq: 4, maxMessages: 30 } })
    assert.equal(older.status, 200)
    const pull = t.harness.records.calls.filter((call) => call.args?.request?.beforeSeq === 4)
    assert.ok(pull.length >= 1, 'beforeSeq 0 以上原样转发')
  } finally {
    await t.stop()
  }
})

test('session.list limit is bounded the same way', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: harnessWithCursor })
  try {
    const cookie = await t.pairMobile()
    for (const limit of [-5, 0, 1e9, 2.5, '10', true, SESSION_LIST_MAX_ROWS + 1]) {
      const res = await rpc(t, cookie, { method: 'session.list', payload: { limit } })
      assert.equal(res.status, 400, `limit ${String(limit)} must be refused`)
      assert.equal((await res.json()).errorCode, '__bridge/invalid-arguments')
    }
    const ok = await rpc(t, cookie, { method: 'session.list', payload: { limit: 30 } })
    assert.equal(ok.status, 200)
    const absent = await rpc(t, cookie, { method: 'session.list', payload: {} })
    assert.equal(absent.status, 200, 'no limit still means the whole list')
    // NaN cannot survive JSON: it arrives as null and takes the default.
    const nulled = await rpc(t, cookie, { method: 'session.list', payload: { limit: null } })
    assert.equal(nulled.status, 200, 'null limit = default, never unbounded')
  } finally {
    await t.stop()
  }
})

test('session.history needs a string sessionId, and says so with 400', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: harnessWithCursor })
  try {
    const cookie = await t.pairMobile()
    for (const sessionId of [undefined, 42, '', {}, []]) {
      const res = await rpc(t, cookie, { method: 'session.history', payload: { sessionId } })
      assert.equal(res.status, 400, `sessionId ${JSON.stringify(sessionId)} must be refused`)
      assert.equal((await res.json()).errorCode, '__bridge/invalid-arguments')
    }
  } finally {
    await t.stop()
  }
})

test('bad interaction input is 400, not the bridge-wide 500', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const cases = [
      { method: 'interaction.pending', payload: {} },
      { method: 'interaction.pending', payload: { sessionId: 7 } },
      { method: 'interaction.answer', payload: { rpcId: 'r', sessionId: 's', answers: 'nope' } },
      { method: 'interaction.answer', payload: { answers: [] } },
      { method: 'interaction.cancel', payload: { rpcId: 'unknown-rpc', sessionId: 's' } },
    ]
    for (const body of cases) {
      const res = await rpc(t, cookie, body)
      assert.equal(res.status, 400, JSON.stringify(body))
      const text = await res.text()
      assert.ok(text.length > 0, 'a reason is given')
      assert.doesNotMatch(text, /Internal server error/, 'a validation failure is not reported as internal')
    }
  } finally {
    await t.stop()
  }
})

test('a transport-shaped Host failure leaves as 502, not as a bad request', async () => {
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile()
    // The default harness in helpers is 127.0.0.1:9 — nothing listens there.
    const res = await rpc(t, cookie, { method: 'session.list', payload: {} })
    assert.equal(res.status, 502)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.ok(['__bridge/transport', '__bridge/not-ready'].includes(body.errorCode), `got ${body.errorCode}`)
    assert.doesNotMatch(JSON.stringify(body), /Internal server error/)
  } finally {
    await t.stop()
  }
})

test('/api/boot failure never quotes the internal error text', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const secret = 'private-sessions-path'
    t.bridge.buildMobileBoot = async () => {
      throw new Error(`cannot read ${secret}`)
    }
    const res = await httpFetch(`${t.base}/api/boot`, { headers: { cookie } })
    assert.equal(res.status, 503)
    const text = await res.text()
    assert.deepEqual(JSON.parse(text), { ok: false, error: 'Boot failed.' })
    assert.ok(!text.includes(secret), 'the reason stays in the log')
  } finally {
    await t.stop()
  }
})

test('attachmentDisposition whitelists inline rendering', () => {
  assert.deepEqual(attachmentDisposition('image/png'), { contentType: 'image/png', download: false })
  assert.deepEqual(attachmentDisposition('IMAGE/WebP'), { contentType: 'image/webp', download: false })
  for (const hostile of ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/plain', '', 'not a type']) {
    const verdict = attachmentDisposition(hostile)
    assert.equal(verdict.contentType, 'application/octet-stream', `${hostile} must not render`)
    assert.equal(verdict.download, true)
  }
  assert.deepEqual(attachmentDisposition(undefined), { contentType: 'application/octet-stream', download: true })
})

test('an attachment whose record claims text/html is handed back as a download', async () => {
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/attachment'
          ? {
              ok: true,
              value: {
                attachment: { mediaType: 'text/html' },
                data: Buffer.from('<script>alert(1)</script>').toString('base64'),
              },
            }
          : undefined,
    },
  })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(`${t.base}/api/session-attachment?sessionId=s1&attachmentId=a1`, {
      headers: { cookie },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/octet-stream')
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment/)
    const body = await res.text()
    assert.ok(!res.headers.get('content-type').includes('text/html'))
    assert.equal(body, '<script>alert(1)</script>', 'bytes survive, the type does not')
  } finally {
    await t.stop()
  }
})
