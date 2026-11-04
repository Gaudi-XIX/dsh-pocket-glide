// Task 2 (2026-11-03 pocket-question-and-bot-rooms-parity): the phone's countdown
// reaching zero is settled by the CLIENT, not by the Host. `interaction.timeout`
// rejects the forwarded request with ASK_TIMED_OUT; the Host turns that into a
// pending result, so the model keeps working and the card does NOT leave the
// table — it becomes a `continued` card that can still be answered by call id
// (`question.answer`). Both halves are checked here against the wire the Host
// actually sees, because the phone cannot prove either on its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, httpFetch } from './helpers.js'

/** Poll `predicate` until it holds, or give up after `limitMs`. */
async function waitFor(predicate, limitMs = 5000) {
  const until = Date.now() + limitMs
  while (Date.now() < until) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

/** One `user-questions/request` event frame, wait carried at request level. */
function questionFrame(eventId, sessionId, request) {
  return JSON.stringify({
    type: 'item',
    streamId: 'mobile-events',
    value: {
      type: 'waterfall',
      event: 'user-questions/request',
      eventId,
      agentId: sessionId,
      request
    }
  })
}

/** Call the bridge's own JSON-RPC route as a paired handset. */
async function rpc(t, cookie, method, payload) {
  const response = await httpFetch(`${t.base}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ method, payload })
  })
  return { status: response.status, body: await response.json() }
}

test('D2/D5: a countdown that reaches zero rejects with ASK_TIMED_OUT and keeps the card answerable', async () => {
  const results = []
  const answers = []
  const projection = {
    values: {
      userQuestions: {
        active: [{ callId: 'call-1', state: 'continued', questions: [{ id: 'q1' }] }]
      }
    }
  }
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname, args) => {
        if (pathname === '/api/$events/result') {
          results.push(args)
          return { ok: true, value: {} }
        }
        if (pathname === '/api/userQuestions/answer') {
          answers.push(args)
          return { ok: true, value: true }
        }
        if (pathname === '/api/session/projections') return { ok: true, value: projection }
        return undefined
      }
    }
  })
  try {
    const cookie = await t.pairMobile('PocketTimeout/1.0')
    assert.ok(await waitFor(() => t.bridge.muxConnected === true), 'the carrier came up')
    t.bridge.eventClientId = 'client-generation-1'
    t.bridge.consumeMuxEnvelope(
      questionFrame('evt-1', 'sess-1', {
        questions: [{ id: 'q1', question: 'Ship it?', options: [{ label: 'Yes' }] }],
        wait: { callId: 'call-1', timed: true }
      })
    )
    const pending = await rpc(t, cookie, 'interaction.pending', { sessionId: 'sess-1' })
    assert.equal(pending.body.value?.rpcId, 'evt-1', 'the card is on the table with its wait')
    assert.deepEqual(pending.body.value?.wait, { callId: 'call-1', timed: true })

    const timedOut = await rpc(t, cookie, 'interaction.timeout', { rpcId: 'evt-1', sessionId: 'sess-1' })
    assert.equal(timedOut.status, 200, JSON.stringify(timedOut.body))
    assert.deepEqual(timedOut.body, { ok: true, value: { timedOut: true } })
    assert.equal(results.length, 1, 'exactly one rejection went to the Host')
    assert.deepEqual(
      results[0].outcome,
      {
        kind: 'rejected',
        error: {
          name: 'UserQuestionError',
          message: 'ask_user_question timed out before the user answered',
          code: 'ASK_TIMED_OUT'
        }
      },
      'the Host is told ASK_TIMED_OUT, not that the user cancelled'
    )

    // The card stays: the Host answers the rejection with a pending result, and
    // `interaction.pending` is about live requests — so "no pending" here is the
    // expected state, not a lost card.
    const after = await rpc(t, cookie, 'interaction.pending', { sessionId: 'sess-1' })
    assert.deepEqual(after.body, { ok: true, value: null })
    assert.equal(t.bridge.pendingQuestions.size, 0)

    // …and the projection still carries it as `continued`, which is the only
    // place the phone can learn it from afterwards. The bridge must not filter it.
    const continued = await rpc(t, cookie, 'session.projections', { sessionId: 'sess-1' })
    assert.equal(continued.status, 200)
    assert.deepEqual(
      continued.body.value?.values?.userQuestions?.active?.[0],
      { callId: 'call-1', state: 'continued', questions: [{ id: 'q1' }] }
    )

    const answered = await rpc(t, cookie, 'question.answer', {
      sessionId: 'sess-1',
      callId: 'call-1',
      answers: [{ id: 'q1', selected: ['Yes'] }]
    })
    assert.equal(answered.status, 200, JSON.stringify(answered.body))
    assert.deepEqual(answered.body, { ok: true, value: { closed: true } })
    assert.deepEqual(answers[0], {
      agent: 'sess-1',
      callId: 'call-1',
      answer: { answers: [{ id: 'q1', selected: ['Yes'] }] }
    })
  } finally {
    await t.stop()
  }
})

test('D5: a continued answer reports closed faithfully, and a non-boolean is refused', async () => {
  let reply = false
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => (pathname === '/api/userQuestions/answer' ? { ok: true, value: reply } : undefined)
    }
  })
  try {
    const cookie = await t.pairMobile('PocketTimeout/2.0')
    const refused = await rpc(t, cookie, 'question.answer', {
      sessionId: 'sess-2',
      callId: 'call-2',
      answers: [{ id: 'q1', selected: [] }]
    })
    assert.equal(refused.status, 200)
    assert.deepEqual(refused.body, { ok: true, value: { closed: false } })
    reply = true
    const accepted = await rpc(t, cookie, 'question.answer', {
      sessionId: 'sess-2',
      callId: 'call-2',
      answers: [{ id: 'q1', selected: [] }]
    })
    assert.equal(accepted.status, 200)
    assert.deepEqual(accepted.body, { ok: true, value: { closed: true } })
    // A Host that answers with something other than a boolean is not a "still
    // open" verdict: the bridge must not round it down to `closed:false`.
    reply = 'yes'
    const unshaped = await rpc(t, cookie, 'question.answer', {
      sessionId: 'sess-2',
      callId: 'call-2',
      answers: [{ id: 'q1', selected: [] }]
    })
    assert.equal(unshaped.status, 400)
    assert.equal(unshaped.body.ok, false)
    assert.match(unshaped.body.error, /closed flag/)
  } finally {
    await t.stop()
  }
})

test('D2: the timeout only applies to a request that is still pending, and says so', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile('PocketTimeout/3.0')
    const refused = await rpc(t, cookie, 'interaction.timeout', { rpcId: 'evt-gone', sessionId: 'sess-3' })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.ok, false)
    assert.match(refused.body.error, /no longer pending/)
    // Bad input never reaches the bridge's 500 either.
    const malformed = await rpc(t, cookie, 'question.answer', { sessionId: 'sess-3', callId: 'call-3', answers: 'nope' })
    assert.equal(malformed.status, 400)
    assert.equal(malformed.body.ok, false)
  } finally {
    await t.stop()
  }
})
