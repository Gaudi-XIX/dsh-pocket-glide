// P0-2 (2026-11-04): `session.list` takes a `sessionIds` filter, so a chat
// window can ask for the one session it opened plus that session's subagent
// children instead of the whole catalogue (~195 KB across a tunnel).
//
// What must stay true:
//   1. the filter answers the target row AND its subagent children — the
//      capsule (lib/pages.js, splitSubagentRows) needs the child rows;
//   2. a filter that is not an array of strings is refused with the existing
//      invalid-arguments code, never answered as "no sessions";
//   3. the fingerprint stays a stamp of the WHOLE catalogue: a filtered answer
//      that carried its own subset's stamp would poison the landing's
//      no-repaint check (the page stores that stamp in sessionStorage and
//      hands it forward — see test/landing-fingerprint.test.js).
//
// No real Host is started here: the fake harness answers `/api/session/list`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, httpFetch } from './helpers.js'

const TARGET = 'session-target'
const CHILD = 'session-child'
const OTHER = 'session-other'

const rows = () => [
  { sessionId: TARGET, workspaceId: 'w1', updatedAt: 1001, projections: { asOfSeq: 10 } },
  { sessionId: CHILD, workspaceId: 'w1', updatedAt: 1002, origin: 'subagent', parentSessionId: TARGET, projections: { asOfSeq: 10 } },
  { sessionId: OTHER, workspaceId: 'w1', updatedAt: 1003, projections: { asOfSeq: 10 } },
]

const harness = {
  respond: (pathname) => {
    if (pathname === '/api/session/list') return { ok: true, value: { items: rows() } }
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

function list(t, cookie, payload = {}) {
  return httpFetch(`${t.base}/api/rpc`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'session.list', payload })
  })
}

test('A5 the filter answers the target row and nothing else', async () => {
  await withBridge(async (t, cookie) => {
    const res = await list(t, cookie, { sessionIds: [TARGET] })
    assert.equal(res.status, 200)
    const answer = await res.json()
    assert.equal(answer.ok, true)
    const items = answer.value.items
    assert.ok(items.length > 0, 'the target must be in the answer')
    assert.ok(items.some((item) => item.sessionId === TARGET), 'the target row travels')
    assert.ok(
      items.every((item) => item.sessionId === TARGET || item.parentSessionId === TARGET),
      'no row outside the target tree may travel'
    )
    assert.ok(!items.some((item) => item.sessionId === OTHER), 'an unrelated row is filtered out')
  })
})

test('A6 the subagent child of the target travels in the same answer', async () => {
  await withBridge(async (t, cookie) => {
    const answer = await (await list(t, cookie, { sessionIds: [TARGET] })).json()
    const child = answer.value.items.find((item) => item.sessionId === CHILD)
    assert.ok(child, 'the child row must travel')
    assert.equal(child.origin, 'subagent')
    assert.equal(child.parentSessionId, TARGET)
  })
})

test('A7 an empty filter answers nothing, and a filter of the wrong shape is refused', async () => {
  await withBridge(async (t, cookie) => {
    const empty = await (await list(t, cookie, { sessionIds: [] })).json()
    assert.equal(empty.ok, true)
    assert.equal(empty.value.items.length, 0, 'an empty filter matches nothing')

    const wrong = await list(t, cookie, { sessionIds: TARGET })
    assert.equal(wrong.status, 400)
    const refused = await wrong.json()
    assert.equal(refused.ok, false)
    assert.equal(refused.errorCode, '__bridge/invalid-arguments', 'the existing code, not a new one')
  })
})

test('A8 the fingerprint is the whole catalogue, filtered or not', async () => {
  await withBridge(async (t, cookie) => {
    const plain = await (await list(t, cookie, {})).json()
    const filtered = await (await list(t, cookie, { sessionIds: [TARGET] })).json()
    assert.equal(plain.value.items.length, 3, 'the unfiltered read still carries the catalogue')
    assert.equal(typeof plain.value.fingerprint, 'string')
    assert.equal(filtered.value.fingerprint, plain.value.fingerprint, 'a filtered answer must not carry its own stamp')
  })
})

test('A9 the unfiltered read is unchanged, and a filtered reader never claims not-modified', async () => {
  await withBridge(async (t, cookie) => {
    const plain = await (await list(t, cookie, {})).json()
    const again = await (await list(t, cookie, { fingerprint: plain.value.fingerprint })).json()
    assert.equal(again.value.notModified, true, 'the landing keeps its no-repaint channel')

    const filtered = await (await list(t, cookie, { sessionIds: [TARGET], fingerprint: plain.value.fingerprint })).json()
    assert.equal(filtered.value.notModified, undefined, 'a filtered reader must get its rows back')
    assert.ok(filtered.value.items.length > 0)
  })
})
