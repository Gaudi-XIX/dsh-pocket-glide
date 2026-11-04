// Task 4 (2026-11-03 pocket-question-and-bot-rooms-parity): the Bot team's own
// question cards never travel the Host's `user-questions/request` waterfall, so
// `pushPendingQuestionNotice` never hears about them and the phone showed "N
// questions waiting" with no notification. The Bot view is polled already (the
// landing reads `bot.team` on its list refresh), so the arrival rides that read:
// the first read only primes the table — a phone opening the page must not be
// buzzed for every card that was already open — and later reads announce the
// cards that are new. The key is `bot:<questionId>` so it can never collide with
// a waterfall event id.
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

/** Call the bridge's own JSON-RPC route as a paired handset. */
async function rpc(t, cookie, method, payload) {
  const response = await httpFetch(`${t.base}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ method, payload })
  })
  return { status: response.status, body: await response.json() }
}

/** A ds-bot `state` answer holding exactly the given question cards. */
function stateWith(questions) {
  return {
    ok: true,
    value: {
      bots: [
        { id: 'bot-a', name: '阿甲', sessionId: 'bot-sess-1' },
        { id: 'bot-b', name: '阿乙', sessionId: 'bot-sess-2' }
      ],
      members: [],
      groups: [],
      rooms: [],
      approvals: [],
      questions
    }
  }
}

test('D7: a Bot question is announced once, on the poll that first sees it, never on the priming read', async () => {
  let cards = { 'bot-a': { id: 'q-1', question: 'Which release?', options: [{ label: 'A' }] } }
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      botRespond: (endpoint) => (endpoint === 'state' ? stateWith(cards) : { ok: true, value: {} })
    }
  })
  const announced = []
  try {
    const cookie = await t.pairMobile('PocketBotNotice/1.0')
    assert.ok(await waitFor(() => t.bridge.muxConnected === true), 'the carrier came up')
    // Captured at the one door the notice leaves by, so the assertion is about
    // what was announced, not about which transport it would have taken.
    t.bridge.pushPendingQuestionNotice = (eventId, pending) => {
      announced.push({ eventId, pending })
    }
    const read = async () => {
      // The 5 s copy would otherwise answer a burst without a real Host read.
      t.bridge._botTeamValue = null
      return rpc(t, cookie, 'bot.team', {})
    }

    // ① The priming read: a card that was already open when the phone arrived.
    const first = await read()
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(announced.length, 0, 'the first read only primes: nobody is buzzed for work already waiting')

    // ② A genuinely new card on the next read.
    cards = {
      ...cards,
      'bot-b': { id: 'q-2', question: 'Which bot?', options: [{ label: 'B' }] }
    }
    await read()
    assert.equal(announced.length, 1, 'exactly one notice for the one new card')
    assert.equal(announced[0].eventId, 'bot:q-2', 'the key is the Bot question id, never a waterfall event id')
    assert.equal(announced[0].pending.rpcId, 'bot:q-2')
    assert.equal(announced[0].pending.sessionId, 'bot-sess-2', 'the notice names the Bot chat the card belongs to')
    assert.equal(announced[0].pending.questions[0].questionId, 'q-2')

    // ③ The same cards again: polling is not a reason to buzz twice.
    await read()
    assert.equal(announced.length, 1, 'a card already announced stays announced')

    // ④ Answered away and asked again: the id-left table forgets it, so a new
    //    card with the same id would be announced again rather than swallowed.
    cards = { 'bot-a': { id: 'q-1', question: 'Which release?', options: [{ label: 'A' }] } }
    await read()
    assert.equal(announced.length, 1, 'nothing new')
    assert.equal(t.bridge.botQuestionSeen.has('q-2'), false, 'the card that left the view is no longer remembered')
  } finally {
    await t.stop()
  }
})

test('D7/AC9: answering a Bot card goes to the Bot answer route and the card leaves the view it came from', async () => {
  const answers = []
  let cards = { 'bot-a': { id: 'q-1', question: 'Which release?', options: [{ label: 'A' }, { label: 'B' }] } }
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      botRespond: (endpoint, payload) => {
        if (endpoint === 'state') return stateWith(cards)
        if (endpoint === 'answer-question') {
          answers.push(payload)
          cards = {}
          return { ok: true, value: { answered: true } }
        }
        return { ok: true, value: {} }
      }
    }
  })
  try {
    const cookie = await t.pairMobile('PocketBotAnswer/1.0')
    assert.ok(await waitFor(() => t.bridge.muxConnected === true), 'the carrier came up')
    const before = await rpc(t, cookie, 'bot.team', {})
    assert.equal(before.body.value?.questions?.count, 1)
    assert.equal(before.body.value?.questions?.items?.[0]?.questionId, 'q-1')

    const answered = await rpc(t, cookie, 'bot.answer', {
      sessionId: 'bot-sess-1',
      questionId: 'q-1',
      answer: { selected: ['A'] }
    })
    assert.equal(answered.status, 200, JSON.stringify(answered.body))
    assert.deepEqual(answers, [
      { sessionId: 'bot-sess-1', questionId: 'q-1', answer: { selected: ['A'] } }
    ])

    const after = await rpc(t, cookie, 'bot.team', {})
    assert.equal(after.body.value?.questions?.count, 0, 'the answered card is gone from the very next read')
  } finally {
    await t.stop()
  }
})
