// 提问「没人答却返回空答案」复现件（change 2026-10-08-probe-question-empty-answer）。
//
// 动因：会话记录实测出 17 次 ask_user_question 返回 `{"answers":[{"id":"…","selected":[]}]}`，
// 空 selected 在宿主协议里的语义是「用户显式跳过」，所以 agent 拿到就继续干活 —— 操作者那边
// 看到的现象是「我没看到提问，它自己回答了」（现象报告见本仓 issue tracker，关键词「question auto-advance」）。
//
// 本文件要回答的只有一个问题：**代码里是否存在一条「没有用户手势也能提交」的路径？**
// 等待时长的实测分布（10s … 7h，不聚集在任何固定值）已经排除了定时器，但那是统计论证；
// 这里用页面真代码给出可复跑的构造性证明：把真实的 onclick handler 与真实的
// advanceQuestion/submitQuestionAnswers 文本抽进沙箱（house pattern，见 error-visibility.test.js 头部），
// 逐条喂入所有可能命中 questionComposer 的点击形态，断言 rpc('interaction.answer') 只在
// 「命中 [data-question-action=skip] 且这是最后一题」时发出。
//
// renderQuestionComposer 在本沙箱里是 stub，这是有意的：它只写 host.innerHTML，不参与提交判定；
// 上面那句「唯一入口」的命题只由 handler + advanceQuestion + submitQuestionAnswers 决定。
// 而真实按钮条的**结构**由最后一条断言打在渲染源文本上（skip 与 continue 直接相邻），
// 因为误点的物理可能性是这件事的另一半，不能只靠读码口头承认。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })

// The page's OWN label table, so every copy asserted below is what the phone renders
// (house pattern from error-visibility.test.js — a hand-copied table drifts).
const L = JSON.parse(js.match(/^const L=(\{.*\});/m)[1])
// Not a copy check — the adjacency claim in P-9 only means something if these are two
// different actions the operator can tell apart while their targets cannot be.
assert.ok(L.skip && L.submitAnswer && L.next, 'the bar needs all three labels')
assert.notEqual(L.skip, L.submitAnswer, 'skip and submit are different actions')

// extractFunction counts braces from the signature, so a parameter with an object default
// (`advanceQuestion(skip=false)`) closes the count early. For those the slice runs to the
// next definition instead — still the REAL text, just wider.
function slice(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle)
  assert.notEqual(start, -1, `${startNeedle} must exist in the rendered asset`)
  const end = source.indexOf(endNeedle, start)
  assert.notEqual(end, -1, `${endNeedle} must follow ${startNeedle}`)
  return source.slice(start, end)
}

const DRAFT = slice(js, 'function questionDraft(', 'function renderQuestionComposer(')
const SYNC = slice(js, 'function syncPendingQuestion(', 'function advanceQuestion(')
const ADVANCE = slice(js, 'function advanceQuestion(', 'async function submitQuestionAnswers(')
const SUBMIT = slice(js, 'async function submitQuestionAnswers(', 'async function cancelQuestionRequest(')
const CANCEL = slice(js, 'async function cancelQuestionRequest(', "function taskState(")
const HANDLER = slice(js, "$('questionComposer').onclick=", "$('questionComposer').oninput=")
const KEYDOWN = slice(js, "$('questionComposer').onkeydown=", "document.addEventListener('click'")

// The page-level state every one of those organs reads or writes. Names and initial values
// are copied from the page's own declaration line so the sandbox cannot drift from it.
const STATE = `
    let pendingQuestion=null,questionIndex=0,questionDrafts={},questionBusy=false
    let activeSession='s1',lastHistoryKey='kept',agentRunning=false
`

function fakeBox(name = '') {
  const el = {
    name,
    textContent: '',
    value: '',
    hidden: false,
    innerHTML: '',
    dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    closest: (sel) => (el.dataset.__matches === sel ? el : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  return el
}

/**
 * A click target that reports itself as the nth button of the composer bar.
 * @param {string|null} action - the value a `[data-question-action]` lookup should find.
 * @param {number|null} optionIndex - the value a `[data-option-index]` lookup should find.
 */
function target(action = null, optionIndex = null) {
  return {
    id: action === null && optionIndex === null ? 'questionCustom' : '',
    value: '',
    closest: (selector) => {
      if (selector === '[data-option-index]') return optionIndex === null ? null : { dataset: { optionIndex: String(optionIndex) } }
      if (selector === '[data-question-action]') return action === null ? null : { dataset: { questionAction: action } }
      return null
    },
  }
}

/**
 * Run the REAL page organs against synthetic state.
 * @param {{questions: unknown[], index?: number}} setup - the pending batch on screen.
 */
function build(setup) {
  const sent = []
  const boxes = { questionCustom: fakeBox('questionCustom'), questionError: fakeBox('questionError') }
  const make = new Function(
    'rpc', 'loadHistory', 'showError', 'renderQuestionComposer', 'box', 'document', 'setTimeout', 'sent',
    `
    ${STATE}
    const L=${JSON.stringify(L)}
    const $=(id)=>box[id]
    ${DRAFT}
    ${SYNC}
    ${ADVANCE}
    ${SUBMIT}
    ${CANCEL}
    const handler=${HANDLER.replace("$('questionComposer').onclick=", '')}
    const keydown=${KEYDOWN.replace("$('questionComposer').onkeydown=", '')}
    return { handler, keydown, sync: syncPendingQuestion, advance: advanceQuestion, draft: questionDraft, sent,
      get busy(){return questionBusy}, get index(){return questionIndex}, get drafts(){return questionDrafts},
      get error(){return box.questionError.textContent}, get lastKey(){return lastHistoryKey},
    };
    `
  )
  const api = make(
    async (method, payload) => { sent.push({ method, payload }); return { ok: true } },
    async () => {},
    () => {},
    () => {},
    boxes,
    { hidden: false, body: { classList: { add() {}, remove() {} } }, addEventListener() {} },
    setTimeout,
    sent,
  )
  // Deliver the batch the way the page does — through syncPendingQuestion, from a null start.
  // Hand-setting pendingQuestion is what made the first draft of this file lie: with the batch
  // absent, advanceQuestion returned at its own entry guard, so every "did not send" assertion
  // passed for the wrong reason. P-4/P-6/P-7 are the counterweight — they require a send to
  // actually happen, so the negative cases below only stay green while the path is live.
  api.sync({ rpcId: 'r1', sessionId: 's1', questions: setup.questions })
  return api
}

const ONE = { questions: [{ id: 'final', question: '这份定稿可以开工了吗？', options: [{ label: '可以（推荐）' }, { label: '不对，我要改' }] }] }
const TWO = { questions: [{ id: 'scope', question: '范围' }, { id: 'restart', question: '重启方式' }] }

const answersSent = (page) => page.sent.filter((s) => s.method === 'interaction.answer')

// ---------------------------------------------------------- 命题一：零手势不提交

test('P-1 a question that arrives and is merely waited on sends no answer at all', () => {
  // This is the exact shape of the operator complaint: the batch lands, nobody touches it,
  // the host nevertheless receives an answer. The page code says it cannot happen.
  const page = build({ ...ONE })
  assert.equal(answersSent(page).length, 0, 'syncing a pending batch is not an answer')
  page.handler({ target: target(null, null) })
  assert.equal(answersSent(page).length, 0, 'a click inside the bar that hits no control answers nothing')
})

test('P-2 clicking the custom box, the spacer or a label answers nothing', () => {
  const page = build({ ...ONE })
  for (const t of [target(), target(null, null), { id: 'questionCustom', value: '', closest: () => null }]) {
    page.handler({ target: t })
  }
  assert.equal(answersSent(page).length, 0, 'no non-action element may settle a batch')
  assert.equal(page.sent.filter((s) => s.method === 'interaction.cancel').length, 0, 'and none may cancel it')
})

test('P-3 submitting with nothing chosen is refused by the page, not sent empty', () => {
  // The continue branch is the one a user reaches for without reading; the guard there is
  // why an unanswered click cannot become a silent skip.
  const page = build({ ...ONE })
  page.handler({ target: target('continue') })
  assert.equal(answersSent(page).length, 0, 'the guard holds')
  assert.equal(page.error, L.chooseAnswer, 'and it tells the operator why')
})

test('P-4 skip is the ONLY gesture that produces an empty selected', () => {
  const page = build({ ...ONE })
  page.handler({ target: target('skip') })
  const sent = answersSent(page)
  assert.equal(sent.length, 1, 'skip on the last question settles the batch')
  assert.deepEqual(sent[0].payload.answers, [{ id: 'final', selected: [] }], 'and that is the empty answer the host logs show')
  assert.equal(JSON.stringify(sent[0].payload).includes('custom'), false, 'with no custom field to soften it')
})

test('P-5 skipping every question of a batch sends all-empty, in one click per question', () => {
  // Reproduces the 2026-10-01 22:11:05 shape: two questions, both empty. Two skips, not one
  // gesture — which is what makes the adjacent skip/submit buttons the suspect, not a timer.
  const page = build({ ...TWO })
  page.handler({ target: target('skip') })
  assert.equal(answersSent(page).length, 0, 'a skip before the last question only advances')
  assert.equal(page.index, 1, 'and moves the operator to question two')
  page.handler({ target: target('skip') })
  const sent = answersSent(page)
  assert.equal(sent.length, 1, 'the second skip settles')
  assert.deepEqual(sent[0].payload.answers.map((a) => a.selected), [[], []], 'both empty')
})

test('P-6 an option then submit never looks like a skip', () => {
  const page = build({ ...ONE })
  page.handler({ target: target(null, 1) })
  page.handler({ target: target('continue') })
  const sent = answersSent(page)
  assert.equal(sent.length, 1, 'the batch settles once')
  assert.deepEqual(sent[0].payload.answers, [{ id: 'final', selected: ['不对，我要改'] }])
})

test('P-7 cancel is a cancel, never an answer', () => {
  const page = build({ ...ONE })
  page.handler({ target: target('cancel') })
  assert.equal(answersSent(page).length, 0, 'cancel sends no answers')
  assert.equal(page.sent.filter((s) => s.method === 'interaction.cancel').length, 1, 'it settles through its own method')
})

test('P-8 once busy, every further gesture is inert — so a double tap cannot re-settle', () => {
  const page = build({ ...ONE })
  page.handler({ target: target('skip') })
  page.handler({ target: target('skip') })
  page.handler({ target: target('continue') })
  assert.equal(answersSent(page).length, 1, 'the batch settles exactly once per user intent')
})

// ------------------------------------------- 命题二的另一半：误点在物理上成立

test('P-9 the rendered bar puts 跳过 directly against the submit button', () => {
  // No gap, no separator, both at the right end of the row, and the left-hand slot is
  // cancel/previous. On a 390px handset that is a two-button cluster whose labels are
  // three characters apart in meaning and one tap apart in position.
  const start = js.indexOf('<div class="question-actions">')
  assert.notEqual(start, -1, 'the action bar must render from a single literal')
  const bar = js.slice(start, start + 700)
  const skipAt = bar.indexOf('data-question-action="skip"')
  const contAt = bar.indexOf('data-question-action="continue"')
  assert.ok(skipAt >= 0 && contAt > skipAt, 'both buttons render, skip first')
  // The gap between the two closing/opening tags is the whole inter-button space. Anything
  // in it would be markup the tap has to cross; empty means they touch.
  const gap = bar.slice(bar.indexOf('</button>', skipAt) + '</button>'.length, contAt - '<button class="submit-answer" '.length)
  assert.equal(gap.trim(), '', `nothing may separate 跳过 from 提交; found: ${JSON.stringify(gap)}`)
  assert.ok(bar.includes('<span class="spacer"></span>'), 'the right-hand cluster sits after the spacer')
})

test('P-11 the phone needs a chord, not a bare Enter, to advance a question', () => {
  // Added after the operator reported "I touched nothing and it skipped through all of them".
  // That symptom is the DESKTOP card: dsh-client-ui-user-questions puts an onKeyDown on the
  // answer field that fires continueFlow() on a bare Enter, AND auto-focuses that field when
  // there is no countdown (i.e. in the legacy mode this build actually runs), AND pre-selects
  // the recommended option into the draft — so repeated Enters page through and the last one
  // submits without the operator ever aiming at a button.
  // The phone deliberately requires Ctrl/Cmd+Enter for the same step. This pin exists so that
  // nobody "aligns" the two by dropping the chord: on a handset an Enter that settles a
  // question is a misfire waiting to happen under the soft keyboard.
  assert.ok(KEYDOWN.includes("e.key==='Enter'"), 'the composer has its own key handler')
  assert.match(KEYDOWN, /\(e\.metaKey\|\|e\.ctrlKey\)/, 'Enter must be gated behind a chord')
})

test('P-12 a bare Enter at the answer field settles nothing; the chord stops at the guard', () => {
  const page = build({ ...ONE })
  const at = { id: 'questionCustom', value: '' }
  page.keydown({ target: at, key: 'Enter', ctrlKey: false, metaKey: false, isComposing: false, keyCode: 13, preventDefault() {} })
  assert.equal(answersSent(page).length, 0, 'a bare Enter never settles a batch on the phone')
  page.keydown({ target: at, key: 'Enter', ctrlKey: true, metaKey: false, isComposing: false, keyCode: 13, preventDefault() {} })
  assert.equal(answersSent(page).length, 0, 'and even the chord halts at the choose-something guard')
})

test('P-10 nothing in the page settles a batch from a timer or a stream frame', () => {
  // The statistical argument in the report, stated as a code-level prohibition: the only
  // callers of submitQuestionAnswers are the two advanceQuestion exits. If a third appears,
  // this fails and points at it.
  const sites = [...js.matchAll(/submitQuestionAnswers\(\)/g)]
  assert.equal(sites.length, 2, 'advanceQuestion(false) and advanceQuestion(true) — no third caller')
  // A call-count pin alone is not enough — the real danger is one of these two callers being
  // reached WITHOUT a gesture. Every call site lives inside advanceQuestion's own body, so the
  // 120 chars preceding each are scanned for the shape an auto-submit regression takes: a timer
  // or an event listener wrapping it. Measured against the real page this never fires; it DOES
  // fire on `setTimeout(()=>{submitQuestionAnswers()},120000)` (tools/mutation check).
  // An earlier form, /setTimeout\([^)]*submitQuestionAnswers/, could not catch that at all —
  // the arrow function's own ')' ended the character class, so the clause was silently true
  // whatever the page did. A guard that cannot fail is not a guard.
  const driven = sites
    .map((m) => js.slice(Math.max(0, m.index - 120), m.index))
    .filter((back) => /setTimeout\(|setInterval\(|addEventListener\(/.test(back))
  assert.deepEqual(driven, [], 'no submit call site may sit behind a timer or a listener')
})
