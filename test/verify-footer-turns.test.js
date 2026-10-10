// Message-footer turn isolation — WHITE-BOX coverage added by the VERIFY stage
// of change 2026-10-04-feat-pocket-message-time-and-token-usage.
//
// test/turn-footer-meta.test.js pins the footer against a ONE-turn transcript:
// A5 drives a single turn that produces two `assistant/message` steps and
// asserts that only the LAST TEXT step carries the pill. Three properties of the
// same feature are therefore never exercised by that file, and all three are
// real coverage gaps rather than dead branches:
//
//   1. Turn ISOLATION. Nothing asserts that turn 1's pill cannot migrate onto
//      turn 2's last text message (or vice versa). `visibleMessages` keys turns
//      by `String(d.turn??'')` and carries `lastTextSeq` / `usage` on the turn
//      object, so a cross-turn leak would be invisible to a single-turn suite.
//   2. A USER message must never grow a pill. A13 pins that a user message gets
//      its own clock, but never that its `usage` stays absent — and the pill is
//      gated purely on `message.usage`.
//   3. A still-STREAMING assistant message must carry NEITHER a clock NOR a
//      pill. `eventTime` and `turn.usage` are both written only on the
//      `assistant/message` branch, so a bubble that is still receiving chunks is
//      expected to grow its footer only once the turn finalises. No shipped
//      assertion pins that absence.
//
// The projection sandbox is copied from test/turn-footer-meta.test.js on
// purpose: it stubs `processBlocks` and `L`, exactly as the shipped file does,
// so the turn-process fold stays out of these assertions and the three
// properties above are measured on the text messages alone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const assets = {
  zh: mobilePageAssets({ locale: 'zh' }),
  en: mobilePageAssets({ locale: 'en' }),
}

// Brace-balancing cut, copied from test/turn-footer-meta.test.js: the page
// functions are dense single lines whose string literals contain braces too.
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the rendered asset`)
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const char = source[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${name}`)
}

function pageLabels(locale) {
  const line = assets[locale].js.match(/^const L=(\{.*\});/m)
  assert(line, `${locale}: the label table must render as one JSON line`)
  return JSON.parse(line[1])
}

function between(startAnchor, endAnchor, source = assets.zh.js) {
  const start = source.indexOf(startAnchor)
  const end = source.indexOf(endAnchor, start)
  assert.notEqual(start, -1, `anchor ${startAnchor} must exist in the page script`)
  assert.notEqual(end, -1, `anchor ${endAnchor} must exist in the page script`)
  assert.ok(end > start, `anchor ${endAnchor} must come after ${startAnchor}`)
  return source.slice(start, end)
}

let cachedProjection = null
let cachedMessage = null

// `eventTime` and `normalizeUsage` are deliberately absent from this list: they
// are nested declarations inside `visibleMessages`, so the brace-balanced cut of
// that function already carries them out. Injecting them as top-level names would
// assert a fiction the page does not have.
function projectionSandbox() {
  if (cachedProjection) return cachedProjection
  const names = ['eventSeq', 'mergeEntries', 'contentBlocks', 'stepKey', 'windowEvents', 'visibleMessages', 'durableUserPromptText', 'messagesWithOptimistic']
  const body = names.map((name) => extractFunction(assets.zh.js, name)).join('\n')
  cachedProjection = new Function(
    `let olderEvents=[],streamEvents=[],lastDurableMessages=[],optimisticPrompts=[];
     const processBlocks=()=>[];
     const L={};
     ${body}
     return { visibleMessages }`,
  )()
  return cachedProjection
}

function messageSandbox(locale) {
  if (cachedMessage) return cachedMessage
  const source = assets.zh.js
  const blockStart = source.indexOf('function renderBlock(')
  const blockEnd = source.indexOf('function renderTurnProcess(')
  assert.notEqual(blockStart, -1, 'renderBlock must exist')
  assert.notEqual(blockEnd, -1, 'renderTurnProcess must exist')
  const body = [
    `const esc=v=>String(v==null?'':v)`,
    `const markdown=text=>String(text||'')`,
    `const renderTurnProcess=()=>'<details class="turn-process"></details>'`,
    `let agentRunning=false`,
    source.slice(blockStart, blockEnd),
    between('function renderMessage(', 'function syncPromptUi(', source),
  ].join('\n')
  cachedMessage = new Function(
    'L',
    'activeSession',
    `${body};return { renderMessage }`,
  )(pageLabels(locale), 's1')
  return cachedMessage
}

const project = (events) => projectionSandbox().visibleMessages(events)
const renderOne = (message) => messageSandbox('zh').renderMessage(message)

// Read the two footer nodes out of the markup instead of searching for bare
// substrings, so "no pill" means "no pill node", not "the letters pill happen to
// appear somewhere".
function pillText(html) {
  const match = html.match(/<span class="usage-pill"[^>]*>([^<]*)<\/span>/)
  return match ? match[1] : null
}

function clockText(html) {
  const match = html.match(/<span class="msg-clock">([^<]*)<\/span>/)
  return match ? match[1] : null
}

// The stamps are anchored to TODAY, not to a fixed past date, because
// `renderMessage` calls `formatMessageClock` without a `now` and the helper
// therefore compares against the real wall clock. A fixed 2024 fixture would
// make every assertion depend on which branch the current date selects. The
// clock's own formatting is pinned with an injected `now` by A1; what matters
// here is that each message carries a stamp and that the stamps differ between
// turns, so the assertions compare the two renderings instead of a literal.
const todayAt = (hour, minute) => {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute).getTime()
}
const T0 = todayAt(15, 30)
const T1 = todayAt(15, 31)

const usage = (totalTokens) => ({ inputTokens: 100, outputTokens: 10, totalTokens })

function userEvent(seq, text, time) {
  return { event: { seq, type: 'user/message', time, data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } } }
}

function assistantEvent(seq, { turn = 't1', step = 1, text = 'answer', usage: reported, time } = {}) {
  const data = { turn, step, message: { content: [{ type: 'text', text }] } }
  if (reported !== undefined) data.usage = reported
  return { event: { seq, type: 'assistant/message', data, time } }
}

// The chunk carries a real `time`, exactly as the host stamps every durable
// record. That makes the streaming assertion meaningful: the stamp IS available
// on the wire, and the footer must still be withheld until the turn finalises.
function chunkEvent(seq, { turn = 't1', step = 1, text = 'partial', index = 0, time = T0 } = {}) {
  return { event: { seq, type: 'assistant/chunk', time, data: { turn, step, chunk: { type: 'text-delta', index, text } } } }
}

// A two-question transcript: turn 1 produces TWO text steps and answers with the
// second step's total; turn 2 answers with 1.2K in one step. The two steps in
// turn 1 are what let "only the last text message carries the pill" be told apart
// from "every text message carries it".
const TWO_TURNS = [
  userEvent(1, 'first question', T0),
  assistantEvent(2, { turn: 't1', step: 1, text: 'first partial answer', usage: usage(100), time: T0 }),
  assistantEvent(3, { turn: 't1', step: 2, text: 'first final answer', usage: usage(9000), time: T0 }),
  userEvent(4, 'second question', T1),
  assistantEvent(5, { turn: 't2', step: 1, text: 'second answer', usage: usage(1234), time: T1 }),
]

test('T1 a two-turn transcript gives each turn its own pill on its own last text message', () => {
  const messages = project(TWO_TURNS)
  const htmls = messages.map((message) => renderOne(message))
  assert.equal(htmls.length, 5)
  // Turn 1 owns msgs 1-2; only its LAST text step is billed.
  assert.equal(pillText(htmls[0]), null)
  assert.equal(pillText(htmls[1]), null, "an earlier step of the turn must not be billed")
  assert.equal(pillText(htmls[2]), '用量 9K tok')
  // Turn 2 owns msg 4.
  assert.equal(pillText(htmls[3]), null)
  assert.equal(pillText(htmls[4]), '用量 1.2K tok')
  // Exactly two pills in the whole transcript: no turn re-states another's total.
  assert.equal(htmls.filter((html) => pillText(html) !== null).length, 2)
  assert.ok(!htmls[2].includes('1.2K'), 'turn 1 must not show turn 2 total')
  assert.ok(!htmls[4].includes('9K'), 'turn 2 must not show turn 1 total')
})

test('T1 a two-turn transcript stamps one clock per turn on its final text message', () => {
  const htmls = project(TWO_TURNS).map((message) => renderOne(message))
  // FLIPPED 2026-10-10 (甲案: 每个 AI 气泡各带一个时间). A mid-turn step used to be
  // clock-free because the clock shared the turn-final pill gate; now any landed bubble
  // stamps itself. The pill is still turn-final only (asserted above and in T2).
  assert.ok(clockText(htmls[1]), 'a mid-turn step carries its own clock now')
  assert.ok(htmls[1].includes('msg-tail'), 'so it renders a footer too')
  for (const idx of [0, 2, 3, 4]) assert.ok(clockText(htmls[idx]), `message ${idx} must still carry its clock`)
  // Same stamp -> same rendering; different turn -> different rendering.
  assert.equal(clockText(htmls[0]), clockText(htmls[2]), 'the question and its answer share one stamp')
  assert.equal(clockText(htmls[3]), clockText(htmls[4]), 'the question and its answer share one stamp')
  assert.notEqual(clockText(htmls[2]), clockText(htmls[4]), 'two turns must not share one clock')
})

test('T1 a user message never grows a usage pill, whatever its turn carries', () => {
  const messages = project(TWO_TURNS)
  const userMessages = messages.filter((message) => message.role === 'user')
  assert.equal(userMessages.length, 2)
  for (const message of userMessages) {
    const html = renderOne(message)
    assert.equal(pillText(html), null, 'a user message must never render a usage pill')
    // Its clock is the only footer content it is allowed to carry.
    assert.ok(clockText(html), 'a user message must still carry its clock')
  }
})

test('T1 a still-streaming assistant message carries neither a clock nor a pill', () => {
  // Only chunks so far: the turn has no `assistant/message`, so nothing is
  // finalised. The projection DOES emit the in-flight text bubble (the streamed
  // chunk is already a text block), which is exactly why this needs a guard: the
  // footer must not appear on it, because `eventTime` and `turn.usage` are only
  // ever written on the finalising branch.
  const streaming = project([
    userEvent(1, 'question', T0),
    chunkEvent(2, { turn: 't1', step: 1, text: 'half a sentence' }),
  ])
  assert.equal(streaming.length, 2)
  assert.equal(streaming[0].role, 'user')
  assert.equal(streaming[1].role, 'assistant')
  assert.equal(streaming[1].streaming, true)
  const assistantHtml = renderOne(streaming[1])
  assert.equal(pillText(assistantHtml), null, 'an in-flight message must not show a pill')
  assert.equal(clockText(assistantHtml), null, 'an in-flight message must not show a clock')
  // The user's own footer is unaffected.
  assert.ok(clockText(renderOne(streaming[0])))
})

test('T1 a finalised step grows its footer on the text message, not on the chunks', () => {
  // The same turn, this time closed by an `assistant/message`: exactly one pill,
  // on exactly one message, and that message is the one carrying the clock.
  const finalised = project([
    userEvent(1, 'question', T0),
    chunkEvent(2, { turn: 't1', step: 1, text: 'half a sentence' }),
    assistantEvent(3, { turn: 't1', step: 1, text: 'half a sentence and the rest', usage: usage(9000), time: T1 }),
  ])
  assert.equal(finalised.length, 2)
  const assistantHtml = renderOne(finalised[1])
  assert.equal(finalised[1].role, 'assistant')
  assert.equal(pillText(assistantHtml), '用量 9K tok')
  assert.ok(clockText(assistantHtml), 'the finalised message must carry a clock')
  assert.ok(clockText(assistantHtml).endsWith('15:31'), 'the clock must come from the finalising record')
  assert.equal(pillText(renderOne(finalised[0])), null)
})