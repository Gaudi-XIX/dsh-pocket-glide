// Task 3 (2026-11-03 pocket-question-and-bot-rooms-parity): the countdown the phone
// shows is its own clock over one Host frame, so what matters is the state machine —
// freeze while a finger is on the card, restart where it stopped, hold on 「慢慢回答」,
// and settle exactly once when it reaches zero (AC7). AC6 is the cheap half: the
// shipped page actually carries the markup and the words.
//
// The functions are lifted verbatim out of the page HTML the phone receives, so a
// change that only exists in this repo's source but never reaches the shell fails here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMobilePage } from '../lib/pages.js'

const html = renderMobilePage({ locale: 'zh' })
// 首帧裁决（2026-11-06）也是一段文档脚本，但它自带运行时副作用（读 window/document、
// 挂定时器），不属于「可原样拎出来跑的函数」。取样时把它排除，跨度与之前一致。
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .filter((body) => !body.includes('window.__fB='))
  .join('\n')

const grab = (start, end) => {
  const from = script.indexOf(start)
  assert.ok(from >= 0, `missing anchor in the shipped page: ${start}`)
  const to = script.indexOf(end, from)
  assert.ok(to > from, `missing end anchor in the shipped page: ${end}`)
  return script.slice(from, to)
}

// The clock organs, then the three gestures that move it (engageQuestion/release are
// covered by the bridge tests; here the claim itself is replaced by a recorder).
const CLOCK = grab('function countdownText(', 'function engageQuestion(')
const GESTURES = grab('function holdQuestionFocus(', 'function syncPendingQuestion(')
// The pointer / draft / visibility wiring, lifted the same way. It sits outside the
// block MIN-7 lifts, so it gets its own harness (AC1.1–AC1.5, AC1.7).
const WIRING = grab("$('questionComposer').onpointerdown=", 'let unreachableStreak=0')

const LABELS = {
  questionContinued: '已继续工作，仍可回答',
  questionTimeKept: '不催，慢慢来',
  questionEngaged: '正在作答，已停表',
  questionTimeLeft: '剩余 {m}:{s}',
}

/**
 * A page-side world with a hand-cranked clock: the shipped functions run against it,
 * and every RPC the page would have sent lands in `sent`.
 */
function world({ hidden = false, card } = {}) {
  let now = 1_000_000
  let intervals = 0
  const sent = []
  const released = []
  const cleared = []
  const state = {
    pendingQuestion: card,
    questionTimer: null,
    claimedWaits: new Set(),
  }
  // eslint-disable-next-line no-new-func
  const build = new Function(
    'state', 'L', 'document', 'rpc', 'releaseQuestionWait', 'renderQuestionComposer',
    'now', 'Date', 'setInterval', 'clearInterval',
    `${CLOCK}\n${GESTURES}
     let pendingQuestion = state.pendingQuestion
     let questionTimer = null
     const claimedWaits = state.claimedWaits
     return {
       set card(v) { pendingQuestion = v },
       get card() { return pendingQuestion },
       get timer() { return questionTimer },
       countdownText, questionTick, questionHeldStop, syncQuestionTicker,
       holdQuestionFocus, releaseQuestionFocus, takeQuestionTime,
     }`,
  )
  const api = build(
    state,
    LABELS,
    { get hidden() { return hidden }, querySelector: () => null },
    (method, payload) => { sent.push({ method, payload }); return { catch: () => {} } },
    (card) => released.push(card && card.wait && card.wait.callId),
    () => {},
    () => now,
    { now: () => now },
    () => { intervals += 1; return intervals },
    (id) => { cleared.push(id) },
  )
  return {
    api,
    state,
    sent,
    released,
    get now() { return now },
    advance(ms) { now += ms; return now },
    get intervals() { return intervals },
  }
}

/** A live card held from a Host frame of `remainingMs`. `held` is the freeze stop. */
function liveCard(remainingMs = 60_000, held = '') {
  return {
    rpcId: 'evt-1',
    sessionId: 'sess-1',
    wait: { callId: 'c1', timed: true },
    questions: [{ id: 'q1', question: 'Proceed?' }],
    countdown: { running: true, paused: false, continued: false, fired: false, remainingMs, deadline: 1_000_000 + remainingMs, held },
  }
}

/** A card from before `held` existed: the shipped default must treat it as ''. */
function liveCardWithoutHeld(remainingMs = 60_000) {
  const card = liveCard(remainingMs)
  delete card.countdown.held
  return card
}

/**
 * The wiring harness: the pointer / draft / visibility entry points run against the
 * same hand-cranked clock, with `#questionComposer` stubbed as a bare element and
 * `document.hidden` switchable so a lock screen can be simulated.
 */
function wired({ card, hidden = false } = {}) {
  const w = world({ card, hidden })
  const box = {}
  const visibility = { hidden }
  // eslint-disable-next-line no-new-func
  const build = new Function(
    '$', 'document', 'pendingQuestion', 'holdQuestionFocus', 'releaseQuestionFocus',
    'questionHeldStop', 'syncQuestionTicker', 'paintQuestionCountdown', 'Date',
    `${WIRING}
     return { syncQuestionVisibility, engageQuestionCard, box: $('questionComposer') }`,
  )
  const api = build(
    () => box,
    { get hidden() { return visibility.hidden } },
    w.api.card,
    w.api.holdQuestionFocus,
    w.api.releaseQuestionFocus,
    w.api.questionHeldStop,
    () => {},
    () => {},
    { now: () => w.now },
  )
  return {
    w, api, box,
    hide() { visibility.hidden = true }, show() { visibility.hidden = false },
  }
}

// AC6 is about the renderer itself, not about the page happening to contain the
// attribute somewhere else: calling the shipped `questionCardHtml` with and without
// the two options is what tells a deleted emission line from a present one.
const CARD = grab('function questionCardHtml(', 'function renderQuestionComposer(')
// eslint-disable-next-line no-new-func
const renderQuestionCard = new Function('esc', 'markdown', `${CARD}\nreturn questionCardHtml`)(
  (value) => String(value),
  (value) => String(value)
)
const CARD_LABELS = { ...LABELS, takeTime: '慢慢回答', questionNeeded: '需要你决定', questionProgress: '题' }

test('AC6: the shipped renderer emits the countdown span and the take-time button only when asked', () => {
  const question = { id: 'q1', question: 'Proceed?', options: [] }
  const live = renderQuestionCard(question, { selected: [] }, 0, 1, {
    labels: CARD_LABELS,
    countdown: '剩余 1:05',
    takeTime: true
  })
  assert.ok(
    live.includes('<span class="question-countdown" data-question-countdown>剩余 1:05</span>'),
    'a running clock emits its span with the caller\'s text'
  )
  assert.ok(
    live.includes('<button data-question-action="take-time">慢慢回答</button>'),
    'a timed card emits the take-time action'
  )
  const bare = renderQuestionCard(question, { selected: [] }, 0, 1, { labels: CARD_LABELS })
  assert.ok(!bare.includes('data-question-countdown'), 'a card without a clock emits no countdown span')
  assert.ok(!bare.includes('data-question-action="take-time"'), 'a card without a clock emits no take-time action')
})

test('AC6 (whole page): the shipped page still wires the clock and the two states', () => {
  assert.ok(html.includes('questionTick('), 'the page runs the clock')
  assert.ok(html.includes('已继续工作，仍可回答'), 'the continued state has a zh word')
})

test('AC7①: a finger on the card freezes the reading, and it does not settle while frozen', () => {
  const w = world({ card: liveCard() })
  w.api.syncQuestionTicker()
  w.api.holdQuestionFocus()
  const cd = w.api.card.countdown
  assert.equal(cd.running, false, 'the clock stops')
  const frozen = cd.remainingMs
  assert.equal(frozen, 60_000, 'the remaining time is kept as it was')
  w.advance(120_000)
  w.api.questionTick(w.now)
  assert.equal(w.api.card.continued, undefined, 'a frozen card never settles')
  assert.equal(w.sent.length, 0, 'nothing is sent while the finger is down')
})

test('AC7②: letting go restarts the clock from the remaining time, not from the deadline', () => {
  const w = world({ card: liveCard() })
  w.api.holdQuestionFocus()
  w.advance(5_000)
  w.api.releaseQuestionFocus()
  const cd = w.api.card.countdown
  assert.equal(cd.running, true, 'the clock runs again')
  assert.equal(cd.deadline, w.now + 60_000, 'the deadline is rebuilt from the frozen remainder')
})

test('MIN-7: the shipped document delegates focusin → hold and focusout → release', () => {
  const w = world({ card: liveCard() })
  w.api.syncQuestionTicker()
  const DELEGATION = grab("document.addEventListener('focusin'", "$('questionComposer').oninput")
  const listeners = {}
  // eslint-disable-next-line no-new-func
  new Function('document', 'holdQuestionFocus', 'releaseQuestionFocus', DELEGATION)(
    { addEventListener: (type, fn) => { listeners[type] = fn } },
    w.api.holdQuestionFocus,
    w.api.releaseQuestionFocus
  )
  assert.equal(typeof listeners.focusin, 'function', 'the page wires focusin')
  assert.equal(typeof listeners.focusout, 'function', 'the page wires focusout')
  listeners.focusin({ target: { closest: () => ({}) } })
  assert.equal(w.api.card.countdown.running, false, 'focus inside the shell freezes the clock')
  assert.equal(w.api.card.countdown.deadline, undefined, 'the deadline is dropped while frozen')
  listeners.focusout({ relatedTarget: null })
  assert.equal(w.api.card.countdown.running, true, 'focus leaving the shell resumes it')
  assert.equal(w.api.card.countdown.deadline, w.now + 60_000, 'it resumes from the frozen remainder')
})

// AC1.1 — the same assertion carries both sides of the first tap, so a missing or
// inverted write fails on one of the four fields rather than reading as "no change".
test('AC1.1: the first pointer-down on the answer surface is a state change, not a redraw', () => {
  const h = wired({ card: liveCard(60_000) })
  const before = { ...h.w.api.card.countdown }
  h.box.onpointerdown()
  const after = h.w.api.card.countdown
  assert.equal(before.held, '', 'a fresh card is not frozen')
  assert.equal(before.running, true, 'a fresh card is counting')
  assert.equal(typeof before.deadline, 'number', 'a fresh card counts to a deadline')
  assert.equal(before.remainingMs, 60_000, 'a fresh card starts from the Host frame')
  assert.equal(after.held, 'focus', 'the tap names the stop')
  assert.equal(after.running, false, 'the clock stops')
  assert.equal(after.deadline, undefined, 'the deadline is dropped')
  assert.ok(after.remainingMs > 0 && after.remainingMs <= 60_000, 'the remainder is kept, not zeroed')
})

// AC1.2 — two full in/out rounds. The second exit rebuilds the deadline from the
// remainder at that instant, and gives back no more time than the first exit did.
test('AC1.2: a second tap-in/tap-out pair re-derives the deadline from the remainder', () => {
  const h = wired({ card: liveCard(60_000) })
  h.box.onpointerdown()
  h.w.advance(5_000)
  h.box.onpointerleave()
  const firstExitRemainder = h.w.api.card.countdown.remainingMs
  assert.equal(h.w.api.card.countdown.deadline, h.w.now + 60_000, 'the first exit rebuilds its deadline')
  h.box.onpointerdown()
  h.w.advance(7_000)
  h.box.onpointerleave()
  const after = h.w.api.card.countdown
  assert.equal(after.deadline, h.w.now + after.remainingMs, 'the second exit re-derives from the remainder')
  assert.ok(after.remainingMs <= firstExitRemainder, 'no time is given back between rounds')
})

// AC1.3 — the draft stop is the one that never comes back: neither pointer-out nor
// blur re-arms the clock, and pushing past the old deadline sends nothing.
test('AC1.3: touching the draft engages the card for good, and it never times out', () => {
  const h = wired({ card: liveCard(60_000) })
  h.box.onpointerdown()
  assert.equal(h.w.api.card.countdown.held, 'focus', 'the tap still freezes first')
  h.api.engageQuestionCard()
  assert.equal(h.w.api.card.countdown.held, 'engage', 'the draft replaces the pointer stop')
  assert.equal(h.w.api.card.countdown.deadline, undefined, 'no deadline survives engage')
  h.box.onpointerleave()
  h.w.api.releaseQuestionFocus()
  h.api.syncQuestionVisibility()
  assert.equal(h.w.api.card.countdown.deadline, undefined, 'coming back does not restart an engaged card either')
  h.w.advance(600_000)
  h.w.api.questionTick(h.w.now)
  assert.equal(h.w.api.card.continued, undefined, 'an engaged card never settles on its own')
  assert.deepEqual(h.w.sent, [], 'engage is local: no waitRelease, no timeout')
})

// AC1.5 — two hidden/visible rounds. A pointer-held card resumes; an engaged one does
// not, in either round. (The pointer test that desktop's refocus makes is folded into
// releaseQuestionFocus's guard instead of a separate "is the finger still down" flag.)
test('AC1.5: coming back from hidden restores a pointer-held card and never an engaged one', () => {
  const held = wired({ card: liveCard(60_000) })
  held.box.onpointerdown()
  for (const round of [1, 2]) {
    held.show()
    held.api.syncQuestionVisibility()
    assert.equal(held.w.api.card.countdown.running, true, `round ${round}: the pointer-held card resumes`)
    assert.equal(held.w.api.card.countdown.held, '', `round ${round}: the stop is cleared`)
    assert.ok(Number.isFinite(held.w.api.card.countdown.deadline), `round ${round}: with a rebuilt deadline`)
    held.hide()
    held.api.syncQuestionVisibility()
    assert.equal(held.w.api.card.countdown.running, false, `round ${round}: hidden freezes again`)
    assert.equal(held.w.api.card.countdown.held, 'focus', `round ${round}: named as the pointer stop`)
  }
  const engaged = wired({ card: liveCard(60_000) })
  engaged.api.engageQuestionCard()
  for (const round of [1, 2]) {
    engaged.show()
    engaged.api.syncQuestionVisibility()
    assert.equal(engaged.w.api.card.countdown.deadline, undefined, `round ${round}: engage survives visibility`)
    assert.equal(engaged.w.api.card.countdown.held, 'engage', `round ${round}: still named engaged`)
  }
})

// AC1.5 (registration) and the wiring the page actually ships: exactly one
// visibilitychange listener exists, and it calls the sync on every change.
test('AC1.5: the shipped page keeps exactly one visibilitychange listener, wired to the sync', () => {
  const registrations = script.split("document.addEventListener('visibilitychange'").length - 1
  assert.equal(registrations, 1, 'the visibilitychange anchor stays unique in the shipped js')
  assert.ok(script.includes('function syncQuestionVisibility(){'), 'the shipped page carries the sync')
  assert.ok(
    script.includes("document.addEventListener('visibilitychange',()=>{syncQuestionVisibility();"),
    'the existing handler calls the sync on every visibility change'
  )
})

// AC1.7 — the card shape that predates the new field must drive every entry point
// exactly as it did before: no throw, no phantom fourth stop.
test('AC1.7: a card with no held field behaves like before the field existed', () => {
  const h = wired({ card: liveCardWithoutHeld(60_000) })
  assert.equal(h.w.api.card.countdown.held, undefined, 'this card really has no field')
  h.box.onpointerdown()
  assert.equal(h.w.api.card.countdown.running, false, 'the tap still freezes')
  h.box.onpointerleave()
  assert.equal(h.w.api.card.countdown.running, true, 'and leaving still resumes')
  h.api.engageQuestionCard()
  assert.equal(h.w.api.card.countdown.deadline, undefined, 'the draft still engages')
  h.w.advance(600_000)
  h.w.api.questionTick(h.w.now)
  assert.equal(h.w.api.card.continued, undefined, 'no phantom stop settles it')
  assert.deepEqual(h.w.sent, [], 'and nothing goes on the wire')
})

// The third stop gets its own words, and it is not the deliberate one.
test('the engaged word is distinct from the paused word and the countdown', () => {
  const w = world({ card: liveCard(65_000) })
  w.api.card.countdown.held = 'engage'
  assert.equal(w.api.countdownText(w.api.card.countdown), LABELS.questionEngaged)
  w.api.card.countdown.held = ''
  assert.equal(w.api.countdownText(w.api.card.countdown), '剩余 1:05', 'clearing the stop returns the clock words')
})

test('AC7③: 慢慢回答 stops the clock for good without telling the Host', () => {
  const w = world({ card: liveCard() })
  w.api.takeQuestionTime()
  const cd = w.api.card.countdown
  assert.equal(cd.paused, true)
  assert.equal(cd.running, false)
  w.advance(600_000)
  w.api.questionTick(w.now)
  assert.equal(w.api.card.continued, undefined, 'a paused card never settles on its own')
  assert.deepEqual(w.sent, [], 'pausing is local: no waitRelease, no timeout')
})

test('AC7④: reaching zero settles once, keeps the card, and flips it to continued', () => {
  const w = world({ card: liveCard(2_000) })
  w.advance(2_000)
  const settled = w.api.questionTick(w.now)
  assert.equal(settled.fired, true, 'the tick that reaches zero reports the firing')
  const card = w.api.card
  assert.equal(card.continued, true, 'the card says the model moved on')
  assert.notEqual(card, null, 'the card stays on screen so a late answer is still possible')
  assert.equal(w.sent.length, 1, 'exactly one timeout, not a stream of them')
  assert.equal(w.sent[0].method, 'interaction.timeout')
  assert.equal(w.sent[0].payload.rpcId, 'evt-1')
  w.advance(5_000)
  const repeated = w.api.questionTick(w.now)
  assert.equal(repeated.fired, false, 'a settled card reports fired:false from the second tick on')
  assert.equal(w.sent.length, 1, 'a second tick does not settle it again')
  assert.equal(w.api.countdownText(card.countdown), LABELS.questionContinued)
})

test('AC7⑤: a hidden tab keeps no ticker running', () => {
  const w = world({ card: liveCard(), hidden: true })
  w.api.syncQuestionTicker()
  assert.equal(w.intervals, 0, 'no interval is armed while the page is hidden')
  assert.equal(w.state.questionTimer, null)
})

test('the paused and pending words come from the countdown state', () => {
  const w = world({ card: liveCard(65_000) })
  assert.equal(w.api.countdownText(w.api.card.countdown), '剩余 1:05')
  w.api.takeQuestionTime()
  assert.equal(w.api.countdownText(w.api.card.countdown), LABELS.questionTimeKept)
  assert.equal(w.api.countdownText(undefined), '', 'no countdown, no words')
})
