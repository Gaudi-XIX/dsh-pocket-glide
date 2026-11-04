// Task 3 (2026-11-03 pocket-question-and-bot-rooms-parity): a Bot question card and a
// Host pending question travel on different roads — the Bot's arrives with the team
// view, keyed by `sessionId`, and the Bot room id is sometimes the bot's own. AC9 asks
// for the resolution rule itself: which source wins, and that a Bot card never gets a
// deadline (the Host's Bot questions carry no `wait`, so a countdown would be invented).
//
// The resolver is lifted verbatim from the page the phone receives, so a fix that never
// reaches the shell cannot pass here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMobilePage } from '../lib/pages.js'

const html = renderMobilePage({ locale: 'zh' })
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

const from = script.indexOf('function pendingCardFor(')
assert.ok(from >= 0, 'the shipped page must carry the card resolver')
const to = script.indexOf('function countdownText(', from)
assert.ok(to > from, 'the resolver ends where the countdown text starts')
const RESOLVER = script.slice(from, to)

// eslint-disable-next-line no-new-func
const pendingCardFor = new Function(`${RESOLVER};return pendingCardFor;`)()

const hostPending = {
  rpcId: 'evt-1',
  sessionId: 'sess-1',
  wait: { callId: 'c1', timed: true },
  questions: [{ id: 'q1', question: 'Proceed?' }],
}

const continuedProjection = {
  values: {
    userQuestions: {
      active: [{ callId: 'c9', state: 'continued', questions: [{ id: 'q9', question: 'Late?', detail: 'still open' }] }],
    },
  },
}

const teamWith = (item) => ({ questions: { count: 1, items: [item] } })
const botItem = { botId: 'bot-a', sessionId: 'bot-sess-1', questionId: 'q-1', question: 'Which one?', options: ['A', 'B'] }

test('AC9: the Host pending question wins while it is live', () => {
  const card = pendingCardFor(hostPending, continuedProjection, teamWith(botItem), 'sess-1')
  assert.equal(card.rpcId, 'evt-1')
  assert.equal(card.wait.callId, 'c1', 'the live card keeps its claim')
})

test('AC9: a continued projection card is rebuilt with the callId as its rpcId', () => {
  const card = pendingCardFor(null, continuedProjection, teamWith(botItem), 'sess-1')
  assert.equal(card.rpcId, 'uq:c9')
  assert.equal(card.continued, true)
  assert.deepEqual(card.wait, { callId: 'c9', timed: true }, 'a continued card can still be answered')
  assert.deepEqual(card.questions, [{ id: 'q9', question: 'Late?', detail: 'still open' }], 'the row keeps what the card renders')
})

test('AC9: a Bot question matches on its sessionId and carries no deadline', () => {
  const card = pendingCardFor(null, { values: {} }, teamWith(botItem), 'bot-sess-1')
  assert.equal(card.rpcId, 'bot:q-1')
  assert.equal(card.bot, true)
  assert.equal(card.sessionId, 'bot-sess-1')
  assert.equal(Object.hasOwn(card, 'wait'), false, 'the Host sends no wait for Bot questions')
  assert.equal(Object.hasOwn(card, 'countdown'), false)
})

test('AC9: a Bot room addressed by the bot id finds the same card', () => {
  const card = pendingCardFor(null, { values: {} }, teamWith(botItem), 'bot-a')
  assert.ok(card, 'the bot id is one of the two keys a Bot card is filed under')
  assert.equal(card.rpcId, 'bot:q-1')
})

test('a room with no question of its own gets no card, whatever else is pending', () => {
  assert.equal(pendingCardFor(null, { values: {} }, teamWith(botItem), 'sess-other'), null)
  assert.equal(pendingCardFor(null, null, null, 'sess-1'), null)
})

test('a continued row for another call never shows up in this room', () => {
  const other = { rpcId: 'evt-2', sessionId: 'other-sess', questions: [{ id: 'q1', question: 'x' }] }
  assert.equal(pendingCardFor(other, { values: {} }, null, 'sess-1'), null)
  assert.equal(pendingCardFor(hostPending, { values: {} }, null, 'sess-2'), null, 'a pending question belongs to one session')
})
