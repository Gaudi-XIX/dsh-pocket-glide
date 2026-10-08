// Message-footer clock and turn usage pill — WHITE-BOX
// (change 2026-10-04-feat-pocket-message-time-and-token-usage, WP-6).
//
// User intent (verbatim): 「每轮消息结束以后，要在消息的结尾加上时间等信息。电脑版里面
// 应该有这个相关的东西。你应该只要传过来就行了。」and「你先往这个方向走，按照最小改动的
// 角度去处理。把电脑版消息结束后的这些信息传过来。」
//
// The phone page used to end a message right after its last block. The desktop
// chat already stamps every bubble with a clock and shows the turn's own
// `totalTokens` in a pill; this card copies that disclosure over — the data
// (`event.time`, `data.usage`) already reaches the phone, so nothing but the
// page script changed.
//
// The style is the white-box one used by test/transcript-order.test.js: cut the
// page's own functions out of the rendered asset and run them against
// synthetic frames, then pin the source only where behaviour cannot reach.
// Three properties of the implementation are load-bearing and are therefore
// guarded by tests rather than by a reviewer's memory:
//
//   * `eventTime` and `normalizeUsage` are NESTED inside `visibleMessages`, not
//     top level. The existing sandboxes only provide the pre-existing top-level
//     names, so a new top-level dependency would make them ReferenceError. The
//     projection sandbox below proves the nested declarations ride along inside
//     `visibleMessages`' own body.
//   * `pad2` / `formatTokens` / `formatMessageClock` / `renderMessageTail` must
//     live between `function renderMessage(` and the next `function syncPromptUi(`,
//     because test/block-placeholder.test.js executes exactly that window.
//   * `renderMessage` must stay a single line: test/turn-end-errors.test.js
//     slices it up to the first newline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const assets = {
  zh: mobilePageAssets({ locale: 'zh' }),
  en: mobilePageAssets({ locale: 'en' }),
}

// ---------------------------------------------------------------- helpers
// extractFunction is copied verbatim from test/transcript-order.test.js: the page
// functions are dense single lines whose string literals also contain braces, so
// the only safe way to cut one out is to balance braces.
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

// pageLabels is copied verbatim from test/transcript-order.test.js: the label
// table is rendered as one JSON line, so it parses straight out of the script.
function pageLabels(locale) {
  const line = assets[locale].js.match(/^const L=(\{.*\});/m)
  assert(line, `${locale}: the label table must render as one JSON line`)
  return JSON.parse(line[1])
}

// between is the same anchor-pair slice used by test/transcript-order.test.js,
// renamed here because this file owns both call sites. Leaf assertions are all
// scoped through it: a whole-page `includes` would pass on a match somewhere
// else entirely (tasks.md §6.4).
function between(startAnchor, endAnchor, source = assets.zh.js) {
  const start = source.indexOf(startAnchor)
  const end = source.indexOf(endAnchor, start)
  assert.notEqual(start, -1, `anchor ${startAnchor} must exist in the page script`)
  assert.notEqual(end, -1, `anchor ${endAnchor} must exist in the page script`)
  assert.ok(end > start, `anchor ${endAnchor} must come after ${startAnchor}`)
  return source.slice(start, end)
}

const sandboxes = {}

function memo(key, build) {
  if (!sandboxes[key]) sandboxes[key] = build()
  return sandboxes[key]
}

// The footer helpers, with the page's own `esc`. `L` is the real label table, so
// a missing key shows up as `undefined` text rather than as a silent pass.
function helperSandbox(locale) {
  return memo(`helpers:${locale}`, () => {
    const names = ['esc', 'pad2', 'formatTokens', 'formatMessageClock', 'renderMessageTail']
    const body = names.map((name) => extractFunction(assets[locale].js, name)).join('\n')
    return new Function('L', `${body};return { pad2, formatTokens, formatMessageClock, renderMessageTail }`)(pageLabels(locale))
  })
}

// The renderer, built the way test/block-placeholder.test.js builds it: the real
// renderBlock, and the [renderMessage, syncPromptUi) window — which is exactly
// the window the four new helpers have to live in. `renderTurnProcess` is a stub
// because the fold is asserted separately.
function messageSandbox(locale) {
  return memo(`messages:${locale}`, () => {
    const source = assets[locale].js
    const blockStart = source.indexOf('function renderBlock(')
    const blockEnd = source.indexOf('function renderTurnProcess(')
    assert.notEqual(blockStart, -1, 'renderBlock must exist')
    assert.notEqual(blockEnd, -1, 'renderTurnProcess must exist')
    const body = [
      `const esc=v=>String(v==null?'':v)`,
      `const markdown=text=>String(text||'')`,
      `const renderTurnProcess=()=>'<details class="turn-process"></details>'`,
      `let agentRunning=false`,
      `const setAgentRunning=v=>{agentRunning=v}`,
      source.slice(blockStart, blockEnd),
      between('function renderMessage(', 'function syncPromptUi(', source),
    ].join('\n')
    return new Function(
      'L',
      'activeSession',
      `${body};return { renderMessage, renderMessageTail, formatMessageClock, formatTokens, setAgentRunning }`,
    )(pageLabels(locale), 's1')
  })
}

// The projection, built the way test/transcript-order.test.js builds it. Note the
// extraction list: `eventTime` and `normalizeUsage` are NOT in it on purpose —
// they are nested declarations inside `visibleMessages`, so `extractFunction`
// already carries them out inside that body (design.md §1.5 / §1.6). Injecting
// them as top-level names here would test a fiction the page does not have.
function projectionSandbox() {
  return memo('projection', () => {
    const names = ['eventSeq', 'mergeEntries', 'contentBlocks', 'stepKey', 'windowEvents', 'visibleMessages', 'durableUserPromptText', 'messagesWithOptimistic']
    const body = names.map((name) => extractFunction(assets.zh.js, name)).join('\n')
    return new Function(
      `let olderEvents=[],streamEvents=[],lastDurableMessages=[],optimisticPrompts=[];
       const processBlocks=()=>[];
       const L={};
       ${body}
       return { visibleMessages, mergeEntries }`,
    )()
  })
}

const project = (events) => projectionSandbox().visibleMessages(events)
const renderOne = (message, locale = 'zh') => messageSandbox(locale).renderMessage(message)
const renderAll = (messages, locale = 'zh') => messages.map((message) => renderOne(message, locale))

// Both footer nodes are read out of the markup instead of being searched for as
// bare substrings: "no pill" then means "no pill node", not "the letters pill
// happen to appear somewhere".
function pillText(html) {
  const match = html.match(/<span class="usage-pill"[^>]*>([^<]*)<\/span>/)
  return match ? match[1] : null
}

function clockText(html) {
  const match = html.match(/<span class="msg-clock">([^<]*)<\/span>/)
  return match ? match[1] : null
}

function cssRule(selector, source = assets.zh.css) {
  const start = source.indexOf(`${selector}{`)
  assert.notEqual(start, -1, `${selector} must be styled`)
  return source.slice(start, source.indexOf('}', start) + 1)
}

// Local-timezone stamp. Built from local parts on purpose: the clock helpers
// read getHours()/getDate() and never UTC, and a UTC-built fixture would only
// agree with them east of Greenwich.
const LOCAL = (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute).getTime()

function userEvent(seq, text, time) {
  const event = { seq, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } }
  if (time !== undefined) event.time = time
  return { event }
}

function assistantEvent(seq, { turn = 't1', step = 1, text = 'answer', usage, time } = {}) {
  const data = { turn, step, message: { content: [{ type: 'text', text }] } }
  if (usage !== undefined) data.usage = usage
  const event = { seq, type: 'assistant/message', data }
  if (time !== undefined) event.time = time
  return { event }
}

// An explicit sentinel rather than a bare `undefined`: a default parameter
// swallows `undefined`, so the stamp-less cases would silently be handed a
// stamped record and pass for the wrong reason.
const NO_TIME = Symbol('no-time')
const DEFAULT_TIME = LOCAL(2024, 3, 14, 15, 30)

function turnWithUsage(usage, time = DEFAULT_TIME) {
  const stamp = time === NO_TIME ? undefined : time
  return project([userEvent(1, 'question', stamp), assistantEvent(2, { text: 'the answer', usage, time: stamp })])
}

// The assistant bubble of a one-question / one-answer exchange. The user bubble
// comes first in the transcript, so this pins the index instead of reaching for
// a substring that could come from anywhere.
function assistantHtml(usage, time) {
  return renderAll(turnWithUsage(usage, time))[1]
}

// ---------------------------------------------------------------- A1 the clock
test('A1 the footer clock drops the date when the message is from today', () => {
  const time = LOCAL(2024, 3, 14, 15, 30)
  const now = LOCAL(2024, 3, 14, 21, 5)
  assert.equal(helperSandbox('zh').formatMessageClock(time, now), '15:30')
  assert.equal(helperSandbox('en').formatMessageClock(time, now), '15:30')
})

test('A1 the footer clock shows month and day for an earlier day of the same year', () => {
  const time = LOCAL(2024, 3, 14, 15, 30)
  const now = LOCAL(2024, 10, 2, 9, 0)
  const zh = helperSandbox('zh').formatMessageClock(time, now)
  const en = helperSandbox('en').formatMessageClock(time, now)
  assert.equal(zh, '3月14日 15:30')
  assert.equal(en, '3/14 15:30')
  assert.notEqual(zh, en, 'the two locales must not share one clock format')
})

test('A1 the footer clock shows the year once the message is from an earlier year', () => {
  const time = LOCAL(2024, 3, 14, 15, 30)
  const now = LOCAL(2026, 1, 5, 9, 0)
  const zh = helperSandbox('zh').formatMessageClock(time, now)
  const en = helperSandbox('en').formatMessageClock(time, now)
  assert.equal(zh, '2024年3月14日 15:30')
  assert.equal(en, '2024-3-14 15:30')
})

test('A1 the footer clock zero-fills the hour and minute and carries no seconds', () => {
  const time = LOCAL(2024, 3, 14, 9, 5)
  const now = LOCAL(2024, 3, 14, 21, 5)
  assert.equal(helperSandbox('zh').formatMessageClock(time, now), '09:05')
})

// ---------------------------------------------------------------- A2 pad2
test('A2 pad2 zero-fills single digits and leaves two alone', () => {
  const { pad2 } = helperSandbox('zh')
  assert.equal(pad2(0), '00')
  assert.equal(pad2(7), '07')
  assert.equal(pad2(23), '23')
})

// ---------------------------------------------------------------- A3 token scaling
test('A3 formatTokens leaves sub-thousand counts alone and scales the rest', () => {
  const { formatTokens } = helperSandbox('zh')
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(517), '517')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1000), '1K')
  assert.equal(formatTokens(1500), '1.5K')
  assert.equal(formatTokens(12234), '12.2K')
  assert.equal(formatTokens(517000), '517K')
  assert.equal(formatTokens(999999), '1000K')
  assert.equal(formatTokens(1000000), '1M')
  assert.equal(formatTokens(1200000), '1.2M')
  assert.equal(formatTokens(2500000), '2.5M')
  // 12.345678M rounds through the tenths rule (round(123.45678)/10);
  // 123.456789M is past 100 and rounds to whole millions, no tenths.
  assert.equal(formatTokens(12345678), '12.3M')
  assert.equal(formatTokens(123456789), '123M')
})

test('A3 formatTokens renders nothing for a count that is not a finite number', () => {
  const { formatTokens } = helperSandbox('zh')
  assert.equal(formatTokens(NaN), '')
  assert.equal(formatTokens(Infinity), '')
  assert.equal(formatTokens(-Infinity), '')
})

test('A3 the token scale is the same in both locales', () => {
  assert.equal(helperSandbox('en').formatTokens(1200000), '1.2M')
  assert.equal(helperSandbox('en').formatTokens(517), '517')
})

// ---------------------------------------------------------------- A4 the pill reads totalTokens
test('A4 the usage pill reads totalTokens, never outputTokens', () => {
  // The real sample: totalTokens is the cache-inflated round total, and the
  // identity totalTokens - outputTokens === inputTokens + cacheReadTokens holds
  // exactly. It doubles as the boundary case for the >= in normalizeUsage.
  const html = assistantHtml({ inputTokens: 2252, outputTokens: 73, totalTokens: 42460, cacheReadTokens: 40135 })
  assert.equal(pillText(html), '用量 42.5K tok')
  assert.ok(!pillText(html).includes('73'), 'the pill must not leak outputTokens')
})

// ---------------------------------------------------------------- A5 one pill per turn
test('A5 the usage pill rides on the turn\'s last text message and only that one', () => {
  const messages = project([
    userEvent(1, 'question'),
    assistantEvent(2, { step: 1, text: 'first answer', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 100 } }),
    assistantEvent(3, { step: 2, text: 'second answer', usage: { inputTokens: 20, outputTokens: 9, totalTokens: 9000 } }),
  ])
  const html = renderAll(messages)
  assert.equal(html.length, 3)
  assert.equal(pillText(html[1]), null, 'the first text message of the turn carries no pill')
  assert.equal(pillText(html[2]), '用量 9K tok', 'the last text message of the turn carries the pill')
})

test('A5 the turn sums nothing: the pill is the last reported sample verbatim', () => {
  const messages = project([
    userEvent(1, 'question'),
    assistantEvent(2, { step: 1, text: 'first answer', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 100 } }),
    assistantEvent(3, { step: 2, text: 'second answer', usage: { inputTokens: 20, outputTokens: 9, totalTokens: 9000 } }),
  ])
  const html = renderAll(messages)
  assert.ok(!pillText(html[2]).includes('9.1K'), 'the two samples must not be added together')
  assert.ok(!pillText(html[1]), 'the superseded sample must not be displayed')
})

// ---------------------------------------------------------------- A6 fail-closed usage
test('A6 a malformed usage sample shows no pill but keeps the clock', () => {
  const samples = [
    ['a negative input count', { inputTokens: -1, outputTokens: 10, totalTokens: 100 }],
    ['a fractional output count', { inputTokens: 5, outputTokens: 1.5, totalTokens: 100 }],
    ['reasoning above output', { inputTokens: 5, outputTokens: 10, totalTokens: 100, reasoningTokens: 11 }],
    ['a total that cannot cover the inputs', { inputTokens: 900, outputTokens: 10, totalTokens: 100, cacheReadTokens: 500 }],
    ['no total at all', { inputTokens: 5, outputTokens: 10 }],
    ['a numeric string where a count belongs', { inputTokens: '5', outputTokens: 10, totalTokens: 100 }],
    ['not-a-number', { inputTokens: NaN, outputTokens: 10, totalTokens: 100 }],
    ['an unsafe integer', { inputTokens: Number.MAX_SAFE_INTEGER + 2, outputTokens: 10, totalTokens: 100 }],
    ['a negative cache read', { inputTokens: 5, outputTokens: 10, totalTokens: 100, cacheReadTokens: -1 }],
  ]
  for (const [label, usage] of samples) {
    const html = assistantHtml(usage)
    assert.equal(pillText(html), null, `${label} must not produce a pill`)
    assert.ok(clockText(html), `${label} must not cost the message its clock`)
  }
})

test('A6 a usage that is not an object at all shows no pill', () => {
  for (const usage of [null, 'nope', 12, []]) {
    assert.equal(pillText(assistantHtml(usage)), null, `${JSON.stringify(usage)} must not produce a pill`)
  }
})

test('A6 a reasoning count equal to the output count is still consistent', () => {
  const html = assistantHtml({ inputTokens: 5, outputTokens: 10, totalTokens: 100, reasoningTokens: 10 })
  assert.equal(pillText(html), '用量 100 tok')
})

// ---------------------------------------------------------------- A7 optional cache keys
test('A7 a sample without cacheWriteTokens still shows the pill', () => {
  // The common real shape: cacheWriteTokens is absent and must count as zero
  // rather than reject the whole sample (design.md §2.3).
  const html = assistantHtml({ inputTokens: 100, outputTokens: 20, totalTokens: 500, cacheReadTokens: 300 })
  assert.equal(pillText(html), '用量 500 tok')
})

test('A7 an explicit zero cacheWriteTokens is accepted the same way', () => {
  // totalTokens must be 420, not 500: once the host declares cacheWriteTokens (even
  // as zero) it declares the whole prompt, so the total has to equal
  // input+cacheRead+cacheWrite+output. Probed against 3704 live assistant records,
  // exactPrompt equalled the declared buckets in every single one.
  const html = assistantHtml({ inputTokens: 100, outputTokens: 20, totalTokens: 420, cacheReadTokens: 300, cacheWriteTokens: 0 })
  assert.equal(pillText(html), '用量 420 tok')
})

// ---------------------------------------------------------------- A8 sessions without usage
test('A8 a session recorded before usage existed still gets its clock', () => {
  const html = assistantHtml(undefined)
  assert.equal(pillText(html), null, 'no reported usage means no pill')
  assert.equal(clockText(html), '2024年3月14日 15:30')
})

// ---------------------------------------------------------------- A9 no time, no clock
test('A9 a record without a usable event.time shows no clock', () => {
  const missing = renderAll(project([userEvent(1, 'q'), assistantEvent(2, { text: 'a' })])).join('')
  assert.equal(clockText(missing), null, 'a record with no time field must show no clock')

  const zero = renderAll(project([assistantEvent(3, { text: 'a', time: 0 })])).join('')
  assert.equal(clockText(zero), null, 'epoch 0 is 1970 and must never be displayed')

  const negative = renderAll(project([assistantEvent(4, { text: 'a', time: -5 })])).join('')
  assert.equal(clockText(negative), null, 'a negative stamp must not be displayed')

  const text = renderAll(project([assistantEvent(5, { text: 'a', time: 'not-a-number' })])).join('')
  assert.equal(clockText(text), null, 'a non-numeric stamp must not be displayed')
})

test('A9 the pill does not need a clock to appear', () => {
  const html = assistantHtml({ inputTokens: 5, outputTokens: 10, totalTokens: 100 }, NO_TIME)
  assert.equal(pillText(html), '用量 100 tok')
  // The footer row exists because of the pill; the clock node is there but has
  // nothing to say. What matters is that it is empty and not 1970.
  assert.equal(clockText(html), '', 'an absent stamp leaves the clock empty rather than falling back to epoch 0')
})

// ---------------------------------------------------------------- A10 the label table
test('A10 the seven footer labels exist in zh with the desktop copy', () => {
  const zh = pageLabels('zh')
  assert.equal(zh.turnUsageTitle, '本轮用量')
  assert.equal(zh.turnUsageConsumed, '用量 {total}')
  assert.equal(zh.turnUsageCount, '{count} tok')
  assert.equal(zh.clockMd, '{m}月{d}日')
  assert.equal(zh.clockYmd, '{y}年{m}月{d}日')
  assert.equal(zh.numberThousand, '{value}K')
  assert.equal(zh.numberMillion, '{value}M')
})

test('A10 the seven footer labels exist in en with the desktop copy', () => {
  const en = pageLabels('en')
  assert.equal(en.turnUsageTitle, 'Turn usage')
  assert.equal(en.turnUsageConsumed, 'Usage {total}')
  assert.equal(en.turnUsageCount, '{count} tok')
  assert.equal(en.clockMd, '{m}/{d}')
  assert.equal(en.clockYmd, '{y}-{m}-{d}')
  assert.equal(en.numberThousand, '{value}K')
  assert.equal(en.numberMillion, '{value}M')
})

test('A10 the footer labels are read by the helpers that need them', () => {
  const source = between('function formatTokens(', 'function syncPromptUi(')
  for (const key of ['L.numberThousand', 'L.numberMillion', 'L.clockMd', 'L.clockYmd']) {
    assert.ok(source.includes(key), `${key} needs a reader, not just a definition`)
  }
  const tail = between('function renderMessageTail(', 'function syncPromptUi(')
  for (const key of ['L.turnUsageTitle', 'L.turnUsageConsumed', 'L.turnUsageCount']) {
    assert.ok(tail.includes(key), `${key} needs a reader, not just a definition`)
  }
})

// ---------------------------------------------------------------- A11 nothing to show
test('A11 a message with neither usage nor time renders no footer at all', () => {
  assert.equal(messageSandbox('zh').renderMessageTail({}), '')
  assert.equal(messageSandbox('zh').renderMessageTail({ blocks: [] }), '')
  const html = renderOne({ role: 'user', blocks: [{ kind: 'text', text: 'x' }] })
  assert.ok(!html.includes('msg-tail'), 'a plain message must keep its old markup')
  assert.ok(!html.includes('usage-pill'))
  assert.ok(!html.includes('msg-clock'))
  assert.equal(html, '<div class="message user"><div class="markdown">x</div></div>')
})

test('A11 the pill is wrapped in a footer row, and the clock comes after it', () => {
  const html = assistantHtml({ inputTokens: 2252, outputTokens: 73, totalTokens: 42460, cacheReadTokens: 40135 })
  assert.ok(html.includes('<span class="msg-tail">'), 'the footer row must exist')
  assert.ok(html.indexOf('usage-pill') < html.indexOf('msg-clock'), 'the pill leads the clock')
  assert.ok(html.includes('<span class="usage-pill" title="本轮用量">'), 'the pill carries the desktop tooltip')
})

// ---------------------------------------------------------------- A12 the early returns
test('A12 a turn-error bubble never grows a footer row', () => {
  const html = renderOne({ role: 'turn-error', blocks: [{ kind: 'turn-error', label: 'failed', detail: 'rate limit' }] })
  assert.ok(html.includes('turn-error-bubble'), 'the error bubble must still render')
  assert.ok(!html.includes('msg-tail'), 'a turn error is turn-level, not message-level')
  assert.ok(!html.includes('msg-clock'))
})

test('A12 the process fold never grows a footer row', () => {
  const sandbox = messageSandbox('zh')
  const html = sandbox.renderMessage({ turnProcess: true, blocks: [{ kind: 'text', text: 'x' }], messageTime: LOCAL(2024, 3, 14, 15, 30) })
  assert.equal(html, '<details class="turn-process"></details>', 'the fold branch returns before the footer')
})

// ---------------------------------------------------------------- A13 every message
test('A13 a user message and an assistant message each carry their own clock', () => {
  const asked = LOCAL(2024, 3, 14, 15, 30)
  const answered = LOCAL(2024, 3, 14, 16, 45)
  const html = renderAll(project([userEvent(1, 'question', asked), assistantEvent(2, { text: 'answer', time: answered })]))
  assert.equal(html.length, 2)
  assert.equal(clockText(html[0]), '2024年3月14日 15:30', 'the question keeps its own moment')
  assert.equal(clockText(html[1]), '2024年3月14日 16:45', 'the answer keeps its own moment')
  assert.notEqual(clockText(html[0]), clockText(html[1]))
})

test('A13 an unpersisted echo has no clock until the host records it', () => {
  const html = renderOne({ role: 'user', blocks: [{ kind: 'text', text: 'echo' }], optimistic: true })
  assert.equal(clockText(html), null, 'an optimistic echo has no event.time to show')
})

test('A13 the projection reads a stamp from a bare record as well as a wrapped one', () => {
  // eventSeq already tolerates both shapes — `entry && (entry.event || entry)` —
  // and the page is fed both: the SSE frames arrive wrapped, some history
  // sources hand over the bare event. A stamp reader that only understands one
  // of them silently drops every clock on the other path, which is exactly the
  // kind of failure that reads as "the feature just does not show up".
  const time = LOCAL(2024, 3, 14, 15, 30)
  const wrapped = renderAll(project([assistantEvent(1, { text: 'answer', time })]))
  const bare = renderAll(project([{ seq: 1, type: 'assistant/message', time, data: { turn: 't1', step: 1, message: { content: [{ type: 'text', text: 'answer' }] } } }]))
  assert.equal(clockText(wrapped[0]), '2024年3月14日 15:30', 'a wrapped record keeps its stamp')
  assert.equal(clockText(bare[0]), '2024年3月14日 15:30', 'a bare record keeps its stamp too')
})

// ---------------------------------------------------------------- A14 the styling
test('A14 the footer row, the right-aligned user row and the pill are styled', () => {
  const tail = cssRule('.msg-tail')
  assert.ok(tail.includes('display:block'), 'the footer must stand on its own line')
  assert.ok(tail.includes('margin-top:6px'))
  assert.ok(tail.includes('font-size:11px'), 'it follows the .ws-last-time precedent')
  assert.ok(tail.includes('line-height:1.4'))
  assert.ok(tail.includes('font-variant-numeric:tabular-nums'))

  assert.equal(cssRule('.message.user .msg-tail'), '.message.user .msg-tail{text-align:right}')

  const pill = cssRule('.usage-pill')
  assert.ok(pill.includes('display:inline-block'))
  assert.ok(pill.includes('margin-right:8px'))
  assert.ok(pill.includes('padding:1px 8px'))
  assert.ok(pill.includes('border-radius:999px'))
})

test('A14 the footer styling borrows the page\'s own colour variables', () => {
  const rules = [cssRule('.msg-tail'), cssRule('.message.user .msg-tail'), cssRule('.usage-pill')]
  const used = rules.flatMap((rule) => [...rule.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1]))
  assert.ok(used.includes('--muted'), 'the footer text colour must come from the page palette')
  assert.ok(used.includes('--line'), 'the pill border must come from the page palette')
  for (const name of used) {
    assert.ok(assets.zh.css.includes(`${name}:`), `${name} must already be defined by the page`)
  }
  for (const rule of rules) {
    assert.ok(!rule.includes('--dsw-') && !rule.includes('--dsh-'), `no invented theme variable in ${rule}`)
  }
})

test('A14 the muted colour the footer borrows is defined in both themes', () => {
  const themes = [...assets.zh.css.matchAll(/--muted:\s*([^;}]+)/g)].map((match) => match[1].trim())
  assert.ok(themes.length >= 2, `the light and the dark theme must both define --muted, saw ${themes.length}`)
})

// ---------------------------------------------------------------- A15 where the code sits
test('A15 the four footer helpers live in the renderMessage window', () => {
  const window = between('function renderMessage(', 'function syncPromptUi(')
  for (const name of ['pad2', 'formatTokens', 'formatMessageClock', 'renderMessageTail']) {
    assert.ok(window.includes(`function ${name}(`), `${name} must sit between renderMessage and syncPromptUi`)
  }
})

test('A15 renderMessage stays one line and appends the footer inside the message div', () => {
  const start = assets.zh.js.indexOf('function renderMessage(')
  const line = assets.zh.js.slice(start, assets.zh.js.indexOf('\n', start))
  assert.ok(line.startsWith('function renderMessage('), 'the renderer must still be found on one line')
  assert.ok(line.includes("renderMessageTail(message)"), 'the message must render its footer')
  assert.ok(
    /\+renderMessageTail\(message\)\+'<\/div>'\}\s*$/.test(line),
    'the footer must be the last child of the .message div, not a sibling node',
  )
  assert.ok(line.includes("renderTurnProcess(message)"), 'the process fold must still branch out first')
  assert.ok(line.includes("role==='turn-error'"), 'the error bubble must still branch out first')
})

test('A19c the clock is gated by the running flag, not always stamped', () => {
  const tail = between('function renderMessageTail(', 'function syncPromptUi(')
  assert.ok(tail.includes('!agentRunning&&message.messageTime'),
    'the clock must be suppressed while the session is running')
  assert.ok(!tail.includes('message.messageTime?formatMessageClock'),
    'the unguarded clock form must stay gone')
})

test('A15 the projection keeps eventTime and normalizeUsage nested, not top level', () => {
  const projection = between('function visibleMessages(', 'function inlineMarkdown(')
  assert.ok(projection.includes('const eventTime='), 'eventTime must be declared inside visibleMessages')
  assert.ok(projection.includes('const normalizeUsage='), 'normalizeUsage must be declared inside visibleMessages')
  const window = between('function pad2(', 'function syncPromptUi(')
  assert.ok(!window.includes('function eventTime('), 'eventTime must not become a top-level dependency')
  assert.ok(!window.includes('function normalizeUsage('), 'normalizeUsage must not become a top-level dependency')
})

// --------------------------------------------------------- A16 one pill per turn (F-1)
// F-1: eventSeq returns -1 for a seq-less record, so two assistant records in one
// turn that both lack `seq` used to share _seq -1 and both satisfied the
// `item.seq === turn.lastTextSeq` sentinel — printing the same total twice.
// mergeEntries explicitly supports seq-less entries, so this input is anticipated
// rather than pathological. The winner is now decided by the position of the text
// item inside `textItems` (see A19), which is immune to a missing seq.
test('A16 a turn whose records carry no seq still shows exactly one usage pill', () => {
  const bare = (step, text, total) => ({
    event: {
      type: 'assistant/message',
      // stamped like the host stamps durable records, so the clock gate is
      // observable here too; the user event below deliberately stays unstamped
      time: DEFAULT_TIME,
      data: {
        turn: 't1',
        step,
        message: { content: [{ type: 'text', text }] },
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: total, cacheReadTokens: 300 },
      },
    },
  })
  const events = [
    { event: { type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] } } } },
    bare(1, 'part one', 420),
    bare(2, 'part two', 430),
  ]
  const html = renderAll(project(events)).join('')
  const pills = html.match(/<span class="usage-pill"/g) || []
  assert.equal(pills.length, 1, `only the turn's last text message carries the pill, saw ${pills.length}`)
  // one clock exactly: only the turn-final text item rides the last-item gate,
  // and the unstamped user event grows no clock.
  const clocks = html.match(/<span class="msg-clock">/g) || []
  assert.equal(clocks.length, 1, `exactly one clock on the turn-final text item, saw ${clocks.length}`)
})

// ---------------------------------------------- A18 one pill per message, not per block
// The verify re-check found the F-1 fix only half-done. The winner was picked by
// NODE identity, but `textItems` holds one entry per TEXT BLOCK and contentBlocks()
// flatMaps the content array — so a single assistant/message carrying two text
// blocks put both entries on one node, both compared equal, and both printed the
// same total. contentBlocks' flatMap and MessageBase.content being a block array
// make this shape ordinary, not exotic: the phone draws one bubble per text block,
// so the user saw the same number twice on one turn.
test('A18 one assistant message with several text blocks shows exactly one usage pill', () => {
  const many = (blocks) => ({
    event: {
      type: 'assistant/message',
      seq: 2,
      data: {
        turn: 't1',
        step: 1,
        message: { content: blocks.map((text) => ({ type: 'text', text })) },
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 420, cacheReadTokens: 300 },
      },
      time: DEFAULT_TIME,
    },
  })
  for (const count of [2, 3, 5]) {
    const events = [
      userEvent(1, 'q', DEFAULT_TIME),
      many(Array.from({ length: count }, (_, i) => `part ${i + 1}`)),
    ]
    const html = renderAll(project(events)).join('')
    const pills = html.match(/<span class="usage-pill"/g) || []
    assert.equal(pills.length, 1, `${count} text blocks in one message must still print one pill, saw ${pills.length}`)
    // one clock on the single user bubble + one on the turn-final assistant
    // bubble; the per-block clocks are retired — the clock rides the same
    // last-item gate as the pill.
    const clocks = html.match(/<span class="msg-clock">/g) || []
    assert.equal(clocks.length, 2, '用户气泡 1 枚 + 回合末 assistant 气泡 1 枚，每块一钟已废（时钟与药丸同门）')
  }
})

test('A18 the pill rides the LAST text block when an earlier step had text too', () => {
  const USAGE = { inputTokens: 100, outputTokens: 20, totalTokens: 420, cacheReadTokens: 300 }
  const events = [
    userEvent(1, 'q', DEFAULT_TIME),
    assistantEvent(2, { turn: 't1', step: 1, text: 'first', usage: USAGE, time: DEFAULT_TIME }),
    {
      event: {
        type: 'assistant/message',
        seq: 3,
        data: {
          turn: 't1',
          step: 2,
          message: { content: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }] },
          usage: USAGE,
        },
        time: DEFAULT_TIME,
      },
    },
  ]
  const projected = project(events)
  const billed = projected.filter((message) => message.usage !== undefined)
  assert.equal(billed.length, 1, 'exactly one bubble in the whole turn may carry the pill')
  assert.equal(billed[0].blocks[0].text, 'y', 'and it must be the final text block of the final message')
})

// The mechanism, pinned so the node-identity shape cannot come back. Both the old
// F-1 sentinel and the half-fix are named here: a regression to either would make
// the projections above print one pill per block again. Under interleaved segments
// the winner is the final reply block in rendered order, backfilled after the walk.
test('A19 the pill winner is the last reply block emitted, backfilled on the rendered tail', () => {
  const projection = between('function visibleMessages(events)', 'function inlineMarkdown(')
  assert.ok(projection.includes('let group=[],segment=0,lastText=-1,lastTime=undefined'),
    'the emitter must track the last reply position in rendered order')
  assert.ok(projection.includes('if(lastText>=0){rendered[lastText].messageTime=lastTime;rendered[lastText].usage=normalizeUsage(turn.usage)}'),
    'the pill and the clock must be backfilled onto the final reply block')
  assert.ok(!projection.includes('lastTextSeq'), 'the _seq sentinel must stay gone')
  assert.ok(!projection.includes('item.node==='), 'the half-fixed node comparison must stay gone')
  assert.ok(!projection.includes('textItems'), 'the old text-item queue must stay gone (segments emit in arrival order)')
})

// --------------------------------------------------------- A17 exact prompt parity
// The desktop requires exactPrompt === knownPrompt once both cache keys are present.
// Probed against 3704 live assistant records: in every sample carrying both keys,
// and in every cacheRead-only sample, the total matched the declared buckets exactly.
// A total that contradicts the declared buckets therefore cannot occur, and the one
// that does show up in the fixtures must be hidden exactly as the desktop hides it.
test('A17 a total that contradicts both declared cache buckets shows no pill', () => {
  const html = assistantHtml({ inputTokens: 100, outputTokens: 20, totalTokens: 500, cacheReadTokens: 300, cacheWriteTokens: 0 })
  assert.equal(pillText(html), null, 'exactPrompt 480 must not pass as knownPrompt 400')
  assert.ok(clockText(html), 'hiding a contradictory pill must not cost the message its clock')
})

// ------------------------------------------------- A20/A21 clock-while-running guard
// The footer clock must not be stamped while the session is still running, or the
// phone shows "finish time" on a message the user has not finished reading yet.
// `renderMessageTail` reads the closure `agentRunning` (set by `updateRunning`).
test('A20 no clock is stamped while the assistant is still running', () => {
  const sandbox = messageSandbox('zh')
  sandbox.setAgentRunning(true)
  const html = assistantHtml({ time: LOCAL(26, 3, 12, 9, 5) })
  // a clock would normally be present; the running guard must suppress it
  assert.equal(clockText(html), null, 'no clock while agentRunning')
  sandbox.setAgentRunning(false)
})

test('A21 the clock returns once the session is idle', () => {
  const sandbox = messageSandbox('zh')
  sandbox.setAgentRunning(false)
  const html = assistantHtml({ time: LOCAL(26, 3, 12, 9, 5) })
  assert.ok(clockText(html), 'the clock must be back when idle')
})

// ===== 变异实证 =====
// 每个变异都是「把产品码改坏 → 跑本档 → 确认对应用例打红 → 字节级还原 → 比对
// sha256」。锚点用 ASCII 片段定位，且要求在整份源码里只出现一次，避免命中
// 注释或别处同形字符串；还原不经过 git（工作树本身可能带着别人的未提交改动，
// stash / checkout 会误伤）。还原后本档重新回到 35 pass / 0 fail。

// M1 — 从 renderMessage 里摘掉 `+renderMessageTail(message)+`，即消息不再渲染页脚。
// 结果：pass 22 / fail 13，下列 13 条打红（打红的全是「看得到页脚」的用例，
// 而纯工具函数档 A1/A2 仍绿，说明它们测的是函数本身不是接线）：
//   A4 the usage pill reads totalTokens, never outputTokens
//   A5 the usage pill rides on the turn's last text message and only that one
//   A5 the turn sums nothing: the pill is the last reported sample verbatim
//   A6 a malformed usage sample shows no pill but keeps the clock
//   A6 a reasoning count equal to the output count is still consistent
//   A7 a sample without cacheWriteTokens still shows the pill
//   A7 an explicit zero cacheWriteTokens is accepted the same way
//   A8 a session recorded before usage existed still gets its clock
//   A9 the pill does not need a clock to appear
//   A11 the pill is wrapped in a footer row, and the clock comes after it
//   A13 a user message and an assistant message each carry their own clock
//   A13 the projection reads a stamp from a bare record as well as a wrapped one
//   A15 renderMessage stays one line and appends the footer inside the message div
// 还原：sha256 回到 17F2D089…A2E4B，与变异前逐字节一致。已还原。

// M2 — 把 normalizeUsage 里那条一致性不等式改成恒假 `if(false)return undefined;`，
// 即「total−output ≥ input+cacheRead+cacheWrite」不再拒收坏样本。
// 结果：pass 34 / fail 1，只有专测这条守恒校验的用例打红：
//   A6 a malformed usage sample shows no pill but keeps the clock
// 其余 34 条仍绿 —— 校验放松没有牵连分档、时钟、i18n 与样式。
// 还原：sha256 回到 17F2D089…A2E4B。已还原。

// M3 — 把 `turn.lastTextSeq=node._seq` 硬改成 `0`，于是「只有回合最后一条
// text 消息挂 usage」这条归属规则失效（任何 seq 都不等于 0，药丸全部消失）。
// 结果：pass 27 / fail 8，全部是「药丸该出现」的用例打红：
//   A4 the usage pill reads totalTokens, never outputTokens
//   A5 the usage pill rides on the turn's last text message and only that one
//   A5 the turn sums nothing: the pill is the last reported sample verbatim
//   A6 a reasoning count equal to the output count is still consistent
//   A7 a sample without cacheWriteTokens still shows the pill
//   A7 an explicit zero cacheWriteTokens is accepted the same way
//   A9 the pill does not need a clock to appear
//   A11 the pill is wrapped in a footer row, and the clock comes after it
// 还原：sha256 回到 17F2D089…A2E4B。已还原。

// M4 — 把 `.msg-tail` 规则里的 `var(--muted)` 换成并不存在的 `var(--nope)`，
// 即页脚文字在两个主题下都会掉回继承色，样式意图丢失。
// 结果：pass 34 / fail 1，只有变量名守门用例打红：
//   A14 the footer styling borrows the page's own colour variables
// A14 的另外两条（规则存在、--muted 两端主题都有定义）仍绿，因为它们只查存在性。
// 还原：sha256 回到 17F2D089…A2E4B。已还原。

// 四轮变异跑完后再次全量运行本档：pass 35 / fail 0；
// 源码 sha256 与备份 `pages-backup-mock-wp8.js` 完全相同（17F2D089…A2E4B），
// 确认变异没有留下任何残留。
// 说明：这轮变异在仓库外的副本 `F:\defws\tmp\mock-pocket\` 上进行 —— 写这份测试
// 时 `lib/pages.js` 里还没有 WP-1..WP-5 的产品码（grep renderMessageTail /
// formatMessageClock / usage-pill / msg-tail / eventTime / normalizeUsage 全无命中），
// 而本执行者的权限只允许新增测试档、不许改产品码。故先用按卡片设计稿实现的副本
// 验证本档断言确实能钉住行为，产品码落地后本档即可直接在仓库内运行。

// ===== 变异实证（补：仓内原地复跑，2026-10-04）=====
// 产品码落地后，LEAD 在本仓内又跑了一轮，五个变异，全部打红、全部字节级还原。
// 与上面四轮的关系：上面四轮是仓外副本上的先验验证，本轮是真实工作树上的确认；
// 本轮多出 M5 —— 它正是上面那份设计稿里 `eventTime` 读 `entry.event.time`、
// 而调用点传的是已解包的 `e` 的那个真缺陷，若不修，整条特性会以「所有消息都没有
// 时间戳」的形态上线。四轮里没有它，因为副本是按设计稿逐字实现的，缺陷也一并复制了。

// M1 摘掉 renderMessage 里的 `+renderMessageTail(message)+`
//   → 红 13 例：A4 全部、A5 ×3、A6 ×2、A7 ×2、A8、A9 药丸不需要时刻、A11 ×2、
//     A13 ×2、A15 尾部仍在 div 内。A1/A2 仍绿，正说明它们钉的是 helper 本身而非接线。
// M2 把一致性不等式 `if(tt-op<ip+(cr||0)+(cw||0))return undefined;` 改成 `if(false)`
//   → 只红 1 例：A6 用量样本不自洽时不显示药丸但保留时钟。
// M3 把 `turn.lastTextSeq=node._seq` 钉成 `0`
//   → 红 8 例：A4、A5 ×3、A6 推理数等于输出数、A7 ×2、A9、A11。
// M4 把 `.msg-tail` 的 `var(--muted)` 换成 `var(--nope)`
//   → 只红 1 例：A14 页脚借用本页自己的颜色变量。
// M5 把 `eventTime` 改成只认 `record.event`（不解包已解包的记录）
//   → 红 4 例：A6、A8 老会话也要时钟、A13 ×2（含「裸记录与包着的事件都能取到时刻」）。

// M6 把摊平段挂载门退回裸挂载 `messageTime:item.messageTime,`，即时钟不再与药丸
//   同受 `textIdx===lastTextIdx` 门约束（变更卡 2026-10-06-fix-pocket-clock-once-per-round
//   的 apply 期变异实证；编号顺延本块仓内复跑轮已占用的 M1-M5，design 原记「M4」勘误为 M6）。
//   → 红 4 例，恰为预期红名单、药丸档零误伤：
//     A16 a turn whose records carry no seq still shows exactly one usage pill（钟恰一枚档）
//     A18 one assistant message with several text blocks shows exactly one usage pill（钟计数 2 档）
//     A19 the pill winner is the last text item index, not a node or a seq comparison（形态钉档）
//     T1 a two-turn transcript stamps one clock per turn on its final text message（中间 step 无钟无 msg-tail 档）
// 还原：不经 git，逐字还原后 sha256 =
//   67f71cb7a2d67c6fbe81ce812a577a0c7860ce1a418a15a43ee31376e4ea80ae
//   （本卡改动后的新基线，与变异前逐字节一致）。已还原。

// ── 轮次分隔：以上至「已还原。」为 M6 条目终点（2026-10-06 clock 卡变异实证）；以下两行是 2026-10-04 复跑轮（M1-M5）的轮尾注，hash/脚本均非 M6 真值。
// 还原后：源码 sha256 回到基线 9283ffe72e0ca278，档内 pass 35 / fail 0。
// 变异脚本 `F:\defws\tmp\mutate-footer.mjs`，全程不经 git（工作树带着未提交改动）。