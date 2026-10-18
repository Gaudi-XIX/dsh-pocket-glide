// Batch tail prefetch (session.tails) — card 2026-10-14-feature-pocket-手机八问收敛 T5.
//
// The landing paints one line of the last message per visible row. Doing that
// with one session.history per row is N round-trips over a public tunnel, so the
// bridge answers a whole screen in one RPC: session.tails({sessions}). What must
// stay true:
//   1. a per-session problem is a marker inside the payload, never a failed
//      response — the rows paint whether or not a tail came;
//   2. the fan-out is bounded (30 sessions, 4 in flight at a time);
//   3. the page-shaped answer is {updatedAt, events} with the same record
//      compaction the transcript leg ships;
//   4. the aligned-turn ladder (turnWindow first, plain page as the fallback)
//      still applies, and an empty first shape does not discard a good second.
import test from 'node:test'
import assert from 'node:assert/strict'
import { LanMobileBridge } from '../lib/bridge.js'

const MIN = 60 * 1000

function userRecord(text, time) {
  return { seq: 1, event: { type: 'user/message', time, data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] }, stream: 'x', header: 'h', meta: 'm' } } }
}

function makeBridge({ items = [], pages = null, pageDelay = 0, refreshed = null } = {}) {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = []
  bridge.log = () => {}
  bridge.locale = () => 'zh'
  bridge.now = () => Date.now()
  bridge.pendingQuestions = new Map()
  bridge.workspaceSnapshot = { items: [] }
  bridge.noteSavings = () => {}
  const calls = []
  bridge._pageCalls = calls
  let active = 0
  let maxActive = 0
  bridge._maxActive = () => maxActive
  const listCalls = []
  bridge._listCalls = listCalls
  bridge.cachedSessionList = async (force = false) => {
    listCalls.push(force === true)
    const source = force && refreshed !== null ? refreshed : items
    return { ok: true, value: { items: source } }
  }
  bridge.invokeHarness = async (endpoint, args) => {
    assert.equal(endpoint, 'session/page')
    calls.push(args.request)
    active += 1
    if (active > maxActive) maxActive = active
    if (pageDelay) await new Promise((r) => setTimeout(r, pageDelay))
    active -= 1
    const answer = typeof pages === 'function' ? pages(args.request) : pages
    return answer ?? { ok: true, value: { records: [userRecord('tail-' + args.request.address.sessionId, Date.now() - MIN)] } }
  }
  return bridge
}

test('empty and junk session lists answer with an empty payload, not an error', async () => {
  const bridge = makeBridge()
  assert.deepEqual(await bridge.forwardRpc('session.tails', {}), { ok: true, value: { tails: {} } })
  assert.deepEqual(await bridge.forwardRpc('session.tails', { sessions: [] }), { ok: true, value: { tails: {} } })
  assert.deepEqual(await bridge.forwardRpc('session.tails', { sessions: [1, null, '', {}] }), { ok: true, value: { tails: {} } })
  assert.equal(bridge._pageCalls.length, 0, 'nothing to look up means the Host was not touched')
})

test('a tail answer carries the row stamp and compacted records', async () => {
  const at = Date.now() - 5 * MIN
  const bridge = makeBridge({ items: [{ sessionId: 'a', updatedAt: at, projections: { asOfSeq: 42 } }] })
  const result = await bridge.forwardRpc('session.tails', { sessions: ['a'] })
  assert.equal(result.ok, true)
  const entry = result.value.tails.a
  assert.equal(entry.updatedAt, at)
  assert.equal(entry.events.length, 1)
  assert.equal(entry.events[0].event.data.stream, undefined, 'PHONE_RECORD_DROP_KEYS are gone from the wrapped event, same leg as the transcript')
  assert.ok(entry.events[0].event.data.message, 'the message itself survives compaction')
  assert.equal(bridge._pageCalls[0].throughSeq, 42, 'the cursor comes from the list projection')
  assert.deepEqual(bridge._pageCalls[0].turnWindow, { minMessages: 1, minTurns: 1 }, 'the aligned-turn shape is tried first')
})

test('an unknown session and a cursorless row are markers, not failures', async () => {
  const bridge = makeBridge({ items: [{ sessionId: 'nocursor', updatedAt: 1 }] })
  const result = await bridge.forwardRpc('session.tails', { sessions: ['ghost', 'nocursor'] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.tails.ghost, { error: 'unknown' })
  assert.deepEqual(result.value.tails.nocursor, { error: 'no-cursor' })
  assert.equal(bridge._pageCalls.length, 0, 'neither row reached the Host')
  assert.deepEqual(bridge._listCalls, [false, true], 'a hopeless row gets exactly one forced refetch, no more')
})

// 2026-10-18 (m00002): the page-side stamp only re-arms on a SUCCESS, so a row the
// 10s-old cached list missed — a session created on the desktop after the last
// refresh — was a permanent dead end: every open paid the full history read. The
// batch now forces one refetch when any asked row cannot be served from the cache.
test('a row missing from the cached list is re-asked once from a forced refresh', async () => {
  const at = Date.now() - MIN
  const bridge = makeBridge({
    items: [],
    refreshed: [{ sessionId: 'fresh', updatedAt: at, projections: { asOfSeq: 77 } }]
  })
  const result = await bridge.forwardRpc('session.tails', { sessions: ['fresh'] })
  assert.deepEqual(bridge._listCalls, [false, true], 'cached miss forced exactly one refetch')
  const entry = result.value.tails.fresh
  assert.equal(entry.updatedAt, at)
  assert.equal(entry.events.length, 1, 'the forced list gave the row a cursor and the tail came back')
  assert.equal(bridge._pageCalls[0].throughSeq, 77, 'the cursor comes from the refreshed row')
})

test('a ready batch never pays the forced refetch', async () => {
  const bridge = makeBridge({ items: [{ sessionId: 'a', updatedAt: 1, projections: { asOfSeq: 5 } }] })
  await bridge.forwardRpc('session.tails', { sessions: ['a'] })
  assert.deepEqual(bridge._listCalls, [false], 'no needy row, no extra Host list call')
})

test('every page shape failing marks the row and keeps the response good', async () => {
  const bridge = makeBridge({
    items: [{ sessionId: 'a', updatedAt: 1, projections: { asOfSeq: 2 } }],
    pages: { ok: false, error: 'host down' }
  })
  const result = await bridge.forwardRpc('session.tails', { sessions: ['a'] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.tails.a, { error: 'page-failed' })
  assert.equal(bridge._pageCalls.length, 2, 'both ladder shapes were tried before giving up on the row')
})

test('an empty aligned turn falls back to the plain page instead of shipping nothing', async () => {
  const bridge = makeBridge({
    items: [{ sessionId: 'a', updatedAt: 7, projections: { asOfSeq: 9 } }],
    pages: (request) => (request.turnWindow
      ? { ok: true, value: { records: [] } }
      : { ok: true, value: { records: [userRecord('late', 11)] } })
  })
  const result = await bridge.forwardRpc('session.tails', { sessions: ['a'] })
  const entry = result.value.tails.a
  assert.equal(entry.updatedAt, 7)
  assert.equal(entry.events.length, 1, 'the fallback page is what got shipped')
  assert.equal(bridge._pageCalls.length, 2)
})

test('the fan-out is bounded: 30 sessions and 4 in flight', async () => {
  const items = []
  const ids = []
  for (let i = 0; i < 40; i += 1) {
    items.push({ sessionId: 's' + i, updatedAt: i + 1, projections: { asOfSeq: i + 1 } })
    ids.push('s' + i)
  }
  const bridge = makeBridge({ items, pageDelay: 5 })
  const result = await bridge.forwardRpc('session.tails', { sessions: ids })
  const answered = Object.keys(result.value.tails)
  assert.equal(answered.length, 30, 'the batch cap trims the ask')
  assert.ok(bridge._maxActive() <= 4, 'at most four Host pages run at once, saw ' + bridge._maxActive())
  assert.equal(bridge._pageCalls.length, 30)
})

test('duplicate ids are answered once', async () => {
  const bridge = makeBridge({ items: [{ sessionId: 'a', updatedAt: 1, projections: { asOfSeq: 1 } }] })
  const result = await bridge.forwardRpc('session.tails', { sessions: ['a', 'a', 'a'] })
  assert.equal(Object.keys(result.value.tails).length, 1)
  assert.equal(bridge._pageCalls.length, 1)
})
