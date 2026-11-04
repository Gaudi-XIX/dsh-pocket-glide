// Task 3 (2026-11-03 pocket-question-and-bot-rooms-parity) / T2: the three
// `bot:<section>` cards are built by `botStage()` from three different Host shapes, and
// the question card is then filed under one of two keys. The old cases fed a hand-made
// `botId`; these feed the REAL `botStage()` output, so a drift in what the Host sends
// (a room that suddenly carries `sessionId`, a Bot row that loses it) shows up here
// instead of on the phone.
//
// `botStage` is imported from the module; `pendingCardFor` and `submitQuestionAnswers`
// are lifted verbatim from the page the phone receives, so a fix that never reaches the
// shell cannot pass.
import test from 'node:test'
import assert from 'node:assert/strict'
import { botStage, renderMobilePage } from '../lib/pages.js'

const html = renderMobilePage({ locale: 'zh' })
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

const lift = (start, end) => {
  const from = script.indexOf(start)
  assert.ok(from >= 0, `missing anchor in the shipped page: ${start}`)
  const to = script.indexOf(end, from)
  assert.ok(to > from, `missing end anchor in the shipped page: ${end}`)
  return script.slice(from, to)
}

const RESOLVER = lift('function pendingCardFor(', 'function countdownText(')
const SUBMIT = lift('async function submitQuestionAnswers(', 'async function cancelQuestionRequest(')
const DRAFT = 'function questionDraft(question){return questionDrafts[question.id]||(questionDrafts[question.id]={selected:[],custom:"",skipped:false})}'

// eslint-disable-next-line no-new-func
const pendingCardFor = new Function(`${RESOLVER};return pendingCardFor;`)()

/**
 * The submit path: a card in hand, a draft in hand, and a recorder instead of the wire.
 * Every `rpc` call keeps its name and its argument object untouched so the assertion can
 * be about the payload itself, not about "some field was there".
 */
function submitter(card, draft) {
  const sent = []
  const errors = []
  // eslint-disable-next-line no-new-func
  const build = new Function(
    'rpc', 'renderQuestionComposer', 'loadListData', 'loadHistory', 'showError', 'L',
    `let pendingQuestion=null,questionBusy=false,questionDrafts={},lastHistoryKey=''
     ${DRAFT}
     ${SUBMIT}
     return {
       set card(v){pendingQuestion=v},
       set draft(v){questionDrafts[v.id]=v},
       submitQuestionAnswers,
     }`,
  )
  const api = build(
    async (method, payload) => { sent.push({ method, payload }); return {} },
    () => {},
    async () => {},
    async () => {},
    (where, error) => errors.push({ where, error }),
    { questionLateClosed: 'late' },
  )
  api.card = card
  api.draft = draft
  return { api, sent, errors }
}

const LABELS = { mainBot: '主 Bot', otherBots: '其他 Bot', rooms: '房间', tagMain: '主', tagNoModel: '无模型' }

/** Run the real builder and hand back its three cards plus the rows it folded in. */
function stage(team) {
  const summaries = []
  const cards = botStage(team, summaries, LABELS)
  const cardOf = (section) => cards.find((card) => card.botSection === section)
  return { cards, cardOf, summaries }
}

const botA = { id: 'bot-a', sessionId: 'sess-main', name: '主脑', model: 'deepseek/chat' }
const botB = { id: 'bot-b', sessionId: 'sess-other', name: '副手', model: 'deepseek/chat' }
const roomOne = { id: 'room-1', name: '投标群', running: true }

const questionOf = (item) => ({ questions: { count: 1, items: [item] } })

test('AC2.1: each of the three sections resolves its own question, field by field', () => {
  const { cardOf } = stage({ bots: [botA, botB], rooms: [roomOne], mainBotIds: ['bot-a'] })
  const main = cardOf('main')
  const other = cardOf('other')
  const room = cardOf('room')
  assert.equal(main.sessionIds.length, 1)
  assert.equal(main.sessionIds[0], 'sess-main', 'a main Bot row is filed under its sessionId')
  assert.equal(other.sessionIds[0], 'sess-other')
  assert.equal(room.sessionIds[0], 'room-1', 'a room row is filed under its room id')

  const cases = [
    { section: 'main', id: 'sess-main', item: { botId: 'bot-a', sessionId: 'sess-main', questionId: 'q-main', question: 'Main?' } },
    { section: 'other', id: 'sess-other', item: { botId: 'bot-b', sessionId: 'sess-other', questionId: 'q-other', question: 'Other?' } },
    { section: 'room', id: 'room-1', item: { botId: 'room-1', questionId: 'q-room', question: 'Room?' } },
  ]
  for (const { section, id, item } of cases) {
    const card = pendingCardFor(null, { values: {} }, questionOf(item), id)
    assert.ok(card, `${section}: a question in this section resolves`)
    assert.equal(card.rpcId, 'bot:' + item.questionId, `${section}: the rpcId names the question`)
    assert.equal(card.bot, true, `${section}: a Bot card is a Bot card`)
    assert.equal(card.sessionId, id, `${section}: the payload key is this section's row id`)
    assert.equal(card.questions.length, 1, `${section}: exactly the one question that matched`)
  }
})

test('AC2.2: the room key falls back in two layers, hit and payload', () => {
  const item = { botId: 'room-1', questionId: 'q-room', question: 'Room?' }
  assert.equal(Object.hasOwn(item, 'sessionId'), false, 'the room item carries no sessionId at all')
  const viaBotId = pendingCardFor(null, { values: {} }, questionOf(item), 'room-1')
  assert.ok(viaBotId, 'the hit key is it.botId === sessionId')
  assert.equal(viaBotId.sessionId, 'room-1', 'and the payload key falls back to the active session')
  const withOwn = { ...item, sessionId: 'room-own' }
  const own = pendingCardFor(null, { values: {} }, questionOf(withOwn), 'room-1')
  assert.equal(own.sessionId, 'room-own', 'when the item carries its own sessionId, that one wins')
})

test('AC2.3: the room payload reaches bot.answer verbatim, and an empty draft dismisses', async () => {
  const { cardOf } = stage({ bots: [], rooms: [roomOne], mainBotIds: [] })
  const card = pendingCardFor(null, { values: {} }, questionOf({ botId: 'room-1', questionId: 'q-room', question: 'Room?' }), cardOf('room').sessionIds[0])
  const answered = submitter(card, { id: card.questions[0].id, selected: ['A'], custom: '', skipped: false })
  await answered.api.submitQuestionAnswers()
  assert.deepEqual(answered.sent, [
    { method: 'bot.answer', payload: { sessionId: 'room-1', questionId: 'q-room', answer: { selected: ['A'] } } },
  ], 'the room id travels through as the sessionId, untouched')

  const dismissed = submitter(card, { id: card.questions[0].id, selected: [], custom: '', skipped: true })
  await dismissed.api.submitQuestionAnswers()
  assert.deepEqual(dismissed.sent, [
    { method: 'bot.dismiss', payload: { sessionId: 'room-1' } },
  ], 'nothing chosen is a dismiss, and it carries only the sessionId')
})

test('AC2.4: with all three lists empty the three cards are still pushed', () => {
  const { cards } = stage({ bots: [], rooms: [], mainBotIds: [] })
  assert.deepEqual(cards.map((card) => card.botSection), ['main', 'other', 'room'])
  assert.deepEqual(cards.map((card) => card.sessionIds), [[], [], []], 'an empty section still renders its card')
  assert.deepEqual(cards.map((card) => card.workspaceId), ['bot:main', 'bot:other', 'bot:room'])
})

test('AC2.6: the shape read is anchored in the builder the phone ships', () => {
  assert.ok(
    botStage.toString().includes('for(const room of team.rooms||[])'),
    'the room loop is what makes a room row a room id and not a sessionId',
  )
  assert.equal(script.split('for(const room of team.rooms||[])').length - 1, 1, 'exactly one such loop in the shipped js')
  const { cardOf } = stage({ bots: [botA], rooms: [roomOne], mainBotIds: ['bot-a'] })
  assert.equal(cardOf('room').sessionIds[0], 'room-1')
  assert.equal(Object.hasOwn(roomOne, 'sessionId'), false, 'and the Host room object really has no sessionId')
})
