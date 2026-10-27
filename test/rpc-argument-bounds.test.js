// Audit B2 P1-4 (2026-10-27): the pass-through RPC methods had no argument
// check at all — `forwardRpc` took `typeof payload === 'object'` as the whole
// contract. Three things rode that gap: an id of any length, a body of up to
// 25 MB of arbitrary JSON (`session.updateQueue` sits in the large tier), and an
// attachment list that was only checked for being an array. The Host validates
// and refuses, but its refusal prose is what the phone then shows — the same
// leak the restart 502 sentence closed.
//
// The repair is a set of BOUNDS, not a whitelist: a key a future Host adds must
// still travel (dropping it would be the worse failure — the Host would answer
// as if the caller had never sent it), while a wrongly typed or absurdly long
// value is refused here, where the answer can name the field.
//
// The fake Harness records every call it receives, so the strongest assertion
// available is not "the bridge answered 400" but "the Host never heard of it".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { httpFetch, startBridge } from './helpers.js'

/** The stable code the phone keys on for a bridge-side argument refusal. */
const INVALID_ARGUMENTS_CODE = '__bridge/invalid-arguments'

/** One RPC as the phone sends it. */
function rpc(t, cookie, method, payload) {
  return httpFetch(`${t.base}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ method, payload })
  })
}

/** Every call the fake Harness saw on one route, oldest first. */
function hostCalls(t, pathname) {
  return t.harness.records.calls.filter((call) => call.url === pathname)
}

test('an id longer than the bound is refused at the bridge, and the Host never sees it', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, 'session.selectModel', {
      sessionId: 's'.repeat(200),
      provider: 'p',
      model: 'm'
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.errorCode, INVALID_ARGUMENTS_CODE)
    assert.match(body.error, /sessionId must be at most 128 characters/)
    assert.equal(hostCalls(t, '/api/session/selectModel').length, 0, 'the Host was never asked')
  } finally {
    await t.stop()
  }
})

test('a control character in an id is refused: it would forge a line in a log', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, 'session.cancel', { sessionId: 's1\nrpc failed trace=fake' })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.errorCode, INVALID_ARGUMENTS_CODE)
    assert.match(body.error, /must not carry control characters/)
    assert.equal(hostCalls(t, '/api/session/cancel').length, 0)
  } finally {
    await t.stop()
  }
})

test('a missing id is refused instead of forwarded as undefined', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, 'session.create', {})
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.errorCode, INVALID_ARGUMENTS_CODE)
    assert.match(body.error, /workspaceId must be a non-empty string/)
    assert.equal(hostCalls(t, '/api/session/create').length, 0)
  } finally {
    await t.stop()
  }
})

test('a queued-inbox write refuses an action that is not an object at all', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const absent = await rpc(t, cookie, 'session.updateQueue', { sessionId: 's1', itemId: 'q1' })
    assert.equal(absent.status, 400)
    assert.match((await absent.json()).error, /action must be an object/)

    const scalar = await rpc(t, cookie, 'session.updateQueue', {
      sessionId: 's1',
      itemId: 'q1',
      action: 'remove'
    })
    assert.equal(scalar.status, 400)
    assert.match((await scalar.json()).error, /action must be an object/)
    assert.equal(hostCalls(t, '/api/session/updateQueue').length, 0)
  } finally {
    await t.stop()
  }
})

test('a queued-inbox write refuses an action kind the dock never sends', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, 'session.updateQueue', {
      sessionId: 's1',
      itemId: 'q1',
      action: { kind: 'delete-everything' }
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.errorCode, INVALID_ARGUMENTS_CODE)
    assert.match(body.error, /action\.kind must be/)
    assert.equal(hostCalls(t, '/api/session/updateQueue').length, 0)
  } finally {
    await t.stop()
  }
})

test('a queued-inbox edit refuses content parts that are not objects', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, 'session.updateQueue', {
      sessionId: 's1',
      itemId: 'q1',
      action: { kind: 'edit', content: ['just a string'] }
    })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /action\.content items must be objects/)
    assert.equal(hostCalls(t, '/api/session/updateQueue').length, 0)
  } finally {
    await t.stop()
  }
})

test('a slash command refuses an attachment list of scalars', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, 'command.execute', {
      sessionId: 's1',
      line: '/goal ship it',
      submittedAttachments: [1, 2, 3]
    })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /submittedAttachments items must be objects/)
    assert.equal(hostCalls(t, '/api/commands/execute').length, 0)
  } finally {
    await t.stop()
  }
})

test('a slash command that sends no attachment list still reaches the Host', async () => {
  // The page spreads `submittedAttachments` in only when the command takes
  // attachments, so an absent list is the ordinary path — and the bridge fills
  // the empty array the Host reads unconditionally. A bound that demanded the
  // key would refuse every plain `/compact`.
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, 'command.execute', { sessionId: 's1', line: '/compact' })
    assert.equal(res.status, 200)
    const calls = hostCalls(t, '/api/commands/execute')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args.submittedAttachments, [])
  } finally {
    await t.stop()
  }
})

test('an upload refuses a non-string name, and a name longer than a filename can be', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const notString = await rpc(t, cookie, 'file.upload', {
      sessionId: 's1',
      data: 'AAAA',
      name: 42
    })
    assert.equal(notString.status, 400)
    assert.match((await notString.json()).error, /name must be a non-empty string/)

    const tooLong = await rpc(t, cookie, 'file.upload', {
      sessionId: 's1',
      data: 'AAAA',
      name: 'n'.repeat(300)
    })
    assert.equal(tooLong.status, 400)
    assert.match((await tooLong.json()).error, /name must be at most 255 characters/)
    assert.equal(hostCalls(t, '/api/fileUploads/upload').length, 0)
  } finally {
    await t.stop()
  }
})

test('a payload nested past the depth bound is refused before it reaches the Host', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    let deep = { leaf: true }
    for (let i = 0; i < 10; i += 1) deep = { down: deep }
    const res = await rpc(t, cookie, 'session.selectModel', {
      sessionId: 's1',
      provider: 'p',
      model: 'm',
      extra: deep
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.errorCode, INVALID_ARGUMENTS_CODE)
    assert.match(body.error, /must not nest deeper than 6 levels/)
    assert.equal(hostCalls(t, '/api/session/selectModel').length, 0)
  } finally {
    await t.stop()
  }
})

test('a payload spending its 25 MB on keys is refused', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const wide = {}
    for (let i = 0; i < 5000; i += 1) wide[`k${i}`] = i
    const res = await rpc(t, cookie, 'session.updateQueue', {
      sessionId: 's1',
      itemId: 'q1',
      action: { kind: 'remove' },
      extra: wide
    })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /must not carry more than 4096 keys/)
    assert.equal(hostCalls(t, '/api/session/updateQueue').length, 0)
  } finally {
    await t.stop()
  }
})

test('the bound is not a whitelist: an unknown key still travels to the Host', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpc(t, cookie, 'session.selectModel', {
      sessionId: 's1',
      provider: 'p',
      model: 'm',
      // A field this bridge has never heard of. Dropping it would make the Host
      // answer as if the caller had never sent it — worse than forwarding it.
      somethingTheHostAddedLater: { nested: true }
    })
    assert.equal(res.status, 200)
    const calls = hostCalls(t, '/api/session/selectModel')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args.request.somethingTheHostAddedLater, { nested: true })
  } finally {
    await t.stop()
  }
})

test('the goal verbs take an absent ref but refuse a non-integer revision', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const bad = await rpc(t, cookie, 'goals.pause', {
      sessionId: 's1',
      ref: { id: 'g1', revision: '3' }
    })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /ref\.revision must be a non-negative integer/)
    assert.equal(hostCalls(t, '/api/goals/pause').length, 0)

    // No ref at all stays allowed: the Host's own GOAL_STALE_REVISION answer is
    // the authority on whether it may be omitted.
    const absent = await rpc(t, cookie, 'goals.resume', { sessionId: 's1' })
    assert.equal(absent.status, 200)
    assert.equal(hostCalls(t, '/api/goals/resume').length, 1)
  } finally {
    await t.stop()
  }
})

test('the check is additive: a method outside the table is still bounded by the walk', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    let deep = { leaf: true }
    for (let i = 0; i < 10; i += 1) deep = { down: deep }
    // `session.history` checks its own numeric fields and has no table entry;
    // the depth walk still applies, which is the point of running it for every
    // method rather than only the ones with a per-field check.
    const res = await rpc(t, cookie, 'session.history', { sessionId: 's1', extra: deep })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /must not nest deeper than 6 levels/)
  } finally {
    await t.stop()
  }
})
