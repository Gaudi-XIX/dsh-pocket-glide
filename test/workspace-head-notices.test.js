// Workspace head notices + the model name on every session row (0.4.31) — WHITE-BOX.
//
// User intent (verbatim, 2026-10-11): 「工作区里如果有"已完成但未读"的提示、"已提问"的提示
// 以及"错误"的提示，这三个提示如果有，就要在工作区名字的地方显示出来，而不是只要有正在
// 进行的对话，就全部用"正在进行"来代替。」and「每个会话下面不是有个时间吗？就沿着那个
// 时间的位置，用同样的字体字号，把该会话使用的模型名称显示出来。」
//
// Both changes land in the one function that paints the list (renderWorkspaces), so
// this file runs the REAL page functions against synthetic workspaces rather than
// matching literals: the old head took taskState(tasks[0]) — the newest row — which is
// exactly the bug (one running chat swallowed every other notice in the workspace), and a
// literal assertion could not tell "error ranks first" from "error happens to be first in
// the array".
import test from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const { js, css } = mobilePageAssets({ locale: 'zh' })

// ---------------------------------------------------------------- helpers
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the rendered asset`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    const char = source[i]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${name}`)
}

const label = (name) => {
  const line = js.match(/^const L=(\{.*\});/m)
  assert(line, 'the label table must render as one JSON line')
  const table = JSON.parse(line[1])
  assert.ok(typeof table[name] === 'string' && table[name], `L.${name} must ship copy`)
  return table[name]
}

const LABELS = ['noWorkspaces', 'noTasksHint', 'newChat', 'untitled', 'justNow', 'minute', 'hour', 'day', 'moreRows', 'wsNewDone', 'wsQuestion', 'wsError']
const L = Object.fromEntries(LABELS.map((name) => [name, label(name)]))

const MINUTE = 60 * 1000
// Time is read by real page code, so the fixture speaks the same units it does:
// epoch milliseconds, counted back from now (rounded — the ledger parser only
// accepts safe integers).
const ago = (minutes) => Date.now() - Math.round(minutes * MINUTE)

// listSandbox is the workspaceSandbox shape used by test/pages-scroll-anchors.test.js:
// the real renderer plus every page global it reads, driven by synthetic rows.
// `L` and UNREAD_OPEN_KEY are the page's OWN copies, so a renamed notice or a moved
// ledger key shows up here as a text mismatch instead of a silent pass.
const listRuntime = ({ summaries = [], ledger = {}, activeSession = null, lastMsg = {} } = {}) => {
  const host = { innerHTML: '' }
  const writes = []
  const storageReads = { n: 0 }
  const make = new Function(
    'workspaces', 'sessionSummaries', 'expandedWsIds', 'revealedLists', 'activeSession', 'container', 'localStorage', 'writes', 'storageReads', `
    const L=${JSON.stringify(L)}
    const UNREAD_OPEN_KEY='dsh-pocket-opened-at'
    const UNREAD_RECENCY_MS=${Number(js.match(/UNREAD_RECENCY_MS=(\d+)/)[1])}
    let openedAtLedgerReady=true
    const LAST_MESSAGE_KEY=${JSON.stringify(js.match(/LAST_MESSAGE_KEY='([^']+)'/)[1])}
    const LAST_MESSAGE_MAX=${Number(js.match(/LAST_MESSAGE_MAX=(\d+)/)[1])}
    const BLANK_ROW_VISIBLE_MS=${24 * 60 * 60 * 1000}
    const LIST_ROWS_MAX=${25}
    const WS_FLAGS_MAX=${Number(js.match(/WS_FLAGS_MAX=(\d+)/)[1])}
    const RECENT_WINDOW_MS=${Number(js.match(/RECENT_WINDOW_MS=(\d+)/)[1])}
    const $=(id)=>container
    function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
    ${[
      'visibleSessions', 'blankRowVisible', 'taskState', 'taskGlyph', 'relativeTime',
      'timeFor', 'titleFor', 'renderWorkspaces', 'readOpenedMap', 'isSessionUnread',
      'wsFlagOf', 'wsFlagClass', 'wsFlagRank', 'wsFlagsOf', 'wsFlagHtml', 'sessionModelLabel',
      'readLastMessageMap', 'pruneLastMessageMap', 'noteSessionMessageAt',
      'lastMessageAtOf', 'lastMessageTimeOf', 'sortAtOf',
      'normalizeSelection', 'fieldText',
    ].map((name) => extractFunction(js, name)).join('\n')}
    let lastMessageAt=${JSON.stringify(lastMsg)}
    let openedLedgerRaw=${JSON.stringify(JSON.stringify(ledger))}
    localStorage={}
    localStorage.getItem=(key)=>{storageReads.n+=1;return key===LAST_MESSAGE_KEY?JSON.stringify(lastMsg):openedLedgerRaw}
    localStorage.setItem=(key,value)=>{writes.push([key,value])}
    return { renderWorkspaces, lastMessageTimeOf, sortAtOf, noteSessionMessageAt, lastMessageAtOf, writes, storageReads:()=>storageReads.n, clockWrites:()=>writes.filter(([k])=>k===LAST_MESSAGE_KEY).length, markup(){ renderWorkspaces(); return container.innerHTML } }
  `)
  return make(
    [{ workspaceId: 'w1', title: 'DSH', sessionIds: summaries.map((row) => row.sessionId) }],
    summaries,
    new Set(['w1']),
    new Set(),
    activeSession,
    host,
    {},
    writes,
    storageReads,
  )
}
const row = (over) => ({ blank: false, updatedAt: ago(5), ...over })
// Every existing case reads the markup only; the clock-semantics cases below also
// reach into the runtime (to drive the real sortAtOf / lastMessageTimeOf).
const listSandbox = (over) => listRuntime(over).markup()
// Head notice text in the order it is painted — the badges render left to right.
const headFlags = (markup) => [...markup.matchAll(/<span class="ws-status is-\w+">([^<]*)<\/span>/g)].map((m) => m[1])
const wsTime = (markup) => (markup.match(/<span class="ws-last-time">([^<]*)<\/span>/) || [null, null])[1]
// An opened ledger entry only counts as unread when the row moved after it.
const readLongAgo = Object.fromEntries(['a', 'b', 'c', 'q', 'u', 'done', 'ask'].map((id) => [id, ago(30)]))

test('a running chat no longer hides the notices under it', () => {
  // The exact shape the report describes: newest row is running (old code painted
  // the running glyph and stopped), while an older row in the same workspace is
  // waiting on an answer.
  const markup = listSandbox({
    summaries: [row({ sessionId: 'busy', running: true, updatedAt: ago(1) }), row({ sessionId: 'ask', awaitingQuestion: true, updatedAt: ago(2) })],
  })
  assert.deepEqual(headFlags(markup), [L.wsQuestion], 'the workspace head names the waiting row')
  assert.ok(!markup.includes('ws-last is-running'), 'and the running glyph is not what the head falls back to')
})

test('rank: error beats question beats finished-unread', () => {
  const all = [
    row({ sessionId: 'a', error: true, updatedAt: ago(1) }),
    row({ sessionId: 'b', awaitingQuestion: true, updatedAt: ago(2) }),
    row({ sessionId: 'c', updatedAt: ago(3) }),
  ]
  assert.deepEqual(
    headFlags(listSandbox({ summaries: all, ledger: readLongAgo })),
    [L.wsError, L.wsQuestion],
    'the failed turn leads and the head shows every kind it found (capped by WS_FLAGS_MAX)',
  )
  const withoutError = all.filter((item) => item.sessionId !== 'a')
  assert.deepEqual(headFlags(listSandbox({ summaries: withoutError, ledger: readLongAgo })), [L.wsQuestion, L.wsNewDone], 'then a waiting turn, then the unread finish')
  const questionOnly = withoutError.filter((item) => item.sessionId !== 'b')
  assert.deepEqual(headFlags(listSandbox({ summaries: questionOnly, ledger: readLongAgo })), [L.wsNewDone], 'a quiet workspace with one unread row shows just that')
  // Put the last-ranked notice on the NEWEST row: if the head just mirrored the
  // array, the unread finish would be painted first. Rank is what orders them.
  const swapped = [
    row({ sessionId: 'c', updatedAt: ago(1) }),
    row({ sessionId: 'b', awaitingQuestion: true, updatedAt: ago(9) }),
  ]
  assert.deepEqual(headFlags(listSandbox({ summaries: swapped, ledger: readLongAgo })), [L.wsQuestion, L.wsNewDone], 'rank wins over recency')
})

test('finished-but-unread counts fresh finishes, read ones quiet down', () => {
  const summaries = [row({ sessionId: 'q', updatedAt: ago(1) }), row({ sessionId: 'u', updatedAt: ago(2) })]
  // 0.4.33: an absent ledger entry is 「never opened on this phone」, and a fresh
  // finish is unread by definition — the 2026-10-12 blind spot, closed.
  assert.deepEqual(headFlags(listSandbox({ summaries, ledger: {} })), [L.wsNewDone], 'never opened + fresh → unread')
  assert.deepEqual(headFlags(listSandbox({ summaries, ledger: { q: ago(30) } })), [L.wsNewDone], 'one row opened long ago and moved since — unread')
  assert.deepEqual(headFlags(listSandbox({ summaries, ledger: { q: ago(0.5), u: ago(0.5) } })), [], 'both opened after they last moved — quiet')
  assert.deepEqual(headFlags(listSandbox({ summaries: [row({ sessionId: 'u', running: true, updatedAt: ago(2) })], ledger: { u: ago(30) } })), [], 'a running row is not unread')
  assert.deepEqual(headFlags(listSandbox({ summaries, ledger: { q: ago(30), u: ago(30) }, activeSession: 'q' })), [L.wsNewDone], 'the focused row never dots itself, its neighbour still may')
  const ancient = [row({ sessionId: 'o1', updatedAt: ago(72 * 60) }), row({ sessionId: 'o2', updatedAt: ago(72 * 60) })]
  assert.deepEqual(headFlags(listSandbox({ summaries: ancient, ledger: {} })), [], 'never opened but ancient → old business, quiet')
})

test('a quiet workspace keeps exactly the head it had before', () => {
  const markup = listSandbox({ summaries: [row({ sessionId: 'q', updatedAt: ago(0.2) })], ledger: { q: ago(0.1) } })
  assert.deepEqual(headFlags(markup), [], 'nothing to interrupt for')
  assert.ok(markup.includes('ws-last is-done'), 'the newest-row glyph stays')
  assert.equal(wsTime(markup), L.justNow, 'and so does its clock')
})

test('a notice comes with the newest row clock, and the notice rows keep their own glyphs', () => {
  const markup = listSandbox({
    summaries: [row({ sessionId: 'ask', awaitingQuestion: true, updatedAt: ago(2) }), row({ sessionId: 'done', updatedAt: ago(5) })],
    ledger: readLongAgo,
  })
  assert.deepEqual(headFlags(markup), [L.wsQuestion, L.wsNewDone], 'both notices are named')
  assert.equal(wsTime(markup), '2' + L.minute, 'the clock is NOT hidden by the notice (newest row, not oldest)')
  assert.match(markup, /class="task-row is-awaiting( is-unread)?"[^>]*data-id="ask"/, 'the row still carries its own state glyph')
  assert.match(markup, /class="task-row is-done is-unread"[^>]*data-id="done"/, 'and so does the unread dot')
})

// ---------------------------------------------------- 2. the model on every row

test('each row names the model its session runs on, provider first (desktop parity)', () => {
  const markup = listSandbox({
    summaries: [
      row({ sessionId: 'a', updatedAt: ago(1), projections: { values: { modelSelection: { next: { provider: 'dsh', model: 'deepseek-chat' } } } } }),
      row({ sessionId: 'b', updatedAt: ago(2), projections: { values: { modelSelection: { next: { provider: 'dsh', model: 'deepseek-reasoner' } } } } }),
    ],
  })
  const clocks = [...markup.matchAll(/<time>([^<]*)<\/time>/g)].map((m) => m[1])
  assert.equal(clocks.length, 2, 'one clock line per row')
  assert.ok(clocks[0].endsWith(' · dsh/deepseek-chat'), `row a clock carries provider/model — got ${clocks[0]}`)
  assert.ok(clocks[1].endsWith(' · dsh/deepseek-reasoner'), `row b clock carries its own — got ${clocks[1]}`)
})

test('no selection projection means the clock stands alone (nothing invented)', () => {
  const markup = listSandbox({ summaries: [row({ sessionId: 'a', updatedAt: ago(0.2) })] })
  assert.equal((markup.match(/<time>([^<]*)<\/time>/) || [])[1], L.justNow, 'no separator, no id')
  const partial = listSandbox({
    summaries: [row({ sessionId: 'a', updatedAt: ago(0.2), projections: { values: { modelSelection: { next: { model: '' } } } } })],
  })
  assert.equal((partial.match(/<time>([^<]*)<\/time>/) || [])[1], L.justNow, 'a model id that is not a string renders nothing')
})

test('the model name rides the clock styling — same font, same size, one line', () => {
  const rule = css.slice(css.indexOf('.task-copy time{'), css.indexOf('}', css.indexOf('.task-copy time{')))
  assert.match(rule, /white-space:nowrap/, 'a long model id may not wrap the row')
  assert.match(rule, /text-overflow:ellipsis/, 'and it is cut, not pushed')
  assert.equal((rule.match(/font-size:10\.5px/g) || []).length, 1, 'the model inherits the one clock font-size (no second size is introduced)')
  assert.match(css, /\.ws-status\{[^}]*font-size:11px/, 'the head badge matches the head clock size')
  assert.match(css, /\.ws-flags\{/, 'notices share one flex band beside the workspace name')
})

test('the shipped page carries the notice copy in both locales', () => {
  for (const locale of ['zh', 'en']) {
    const assets = mobilePageAssets({ locale })
    const line = assets.js.match(/^const L=(\{.*\});/m)
    const table = JSON.parse(line[1])
    for (const name of ['wsNewDone', 'wsQuestion', 'wsError']) {
      assert.ok(typeof table[name] === 'string' && table[name], `${locale}: L.${name} must exist`)
    }
  }
})

// ------------------------------------------------- 3. the clock is the last message
//
// User intent (verbatim, 2026-10-12): 「现在对话里的每一条消息上都有时间了。在工作区里，请直接
// 读取对话下方显示的最后一个消息的时间，用作工作区里面会话显示的那个时间」. The host row owns
// no message time — it only has updatedAt, which also moves on tool traffic, todos and
// projections, and freezes the moment a turn's last event lands. So the phone stamps what
// it painted and falls back to updatedAt for a session it has never opened.

const idsInOrder = (markup) => [...markup.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1])

test('a row whose last message is newer outranks one whose host clock is newer', () => {
  // The failure this guards: stamping last-message clocks while still sorting on
  // updatedAt puts a visibly older row on top of the list.
  const markup = listSandbox({
    summaries: [
      row({ sessionId: 'churn', updatedAt: ago(1) }), // host clock new: tool traffic, no message since
      row({ sessionId: 'said', updatedAt: ago(6) }), // host clock old, but it just said something
    ],
    lastMsg: { churn: ago(30), said: ago(2) },
  })
  assert.deepEqual(idsInOrder(markup), ['said', 'churn'], 'the row that spoke last leads')
  assert.equal(wsTime(markup), '2' + L.minute, 'and the head clock is that message, not the row that churned')
})

test('a session this phone never opened still shows its host clock', () => {
  const markup = listSandbox({ summaries: [row({ sessionId: 'unopened', updatedAt: ago(4) })] })
  assert.equal(wsTime(markup), '4' + L.minute, 'no ledger entry means updatedAt, never a blank')
})

test('which bubble the row inherits: the last one that finished', () => {
  const { lastMessageTimeOf } = listRuntime()
  const settled = ago(3)
  assert.equal(lastMessageTimeOf([{ messageTime: settled }]), settled, 'one finished bubble is the row clock')
  assert.equal(
    lastMessageTimeOf([{ messageTime: settled }, { messageTime: ago(1), streaming: true }]),
    settled,
    'a still-streaming tail has no settled clock of its own — the row must not inherit it',
  )
  assert.equal(lastMessageTimeOf([{ messageTime: ago(9) }, { messageTime: settled }]), settled, 'the last bubble wins')
  assert.equal(lastMessageTimeOf([]), 0, 'nothing painted means no stamp at all')
  assert.equal(lastMessageTimeOf([{ messageTime: Number.MAX_SAFE_INTEGER + 10 }]), 0, 'a junk clock is refused, not rendered')
})

test('the ledger only moves forward, and one session cannot evict another', () => {
  // noteSessionMessageAt is monotonic: history arrives oldest-first and the tail
  // streams, so a re-paint that hands it an older clock must not roll the row's
  // stamp backwards. It writes through to localStorage under the phone's own key
  // (the map is rebuilt from storage on the next open).
  const rt = listRuntime({ lastMsg: { a: ago(3) } })
  const first = rt.clockWrites()
  const readsBefore = rt.storageReads()
  rt.noteSessionMessageAt('a', ago(9))
  assert.equal(rt.clockWrites(), first, 'an older clock is refused — no write')
  assert.equal(rt.storageReads(), readsBefore, 'and it does not even re-read the ledger to refuse it')
  assert.equal(rt.lastMessageAtOf({ sessionId: 'a' }), rt.lastMessageAtOf({ sessionId: 'a' }), 'and the stamp still reads')
  rt.noteSessionMessageAt('a', ago(1))
  assert.equal(rt.clockWrites(), first + 1, 'a newer clock is written once')
  const [key, payload] = rt.writes.filter(([k]) => k === 'dsh-pocket-last-msg-at').pop()
  assert.equal(key, 'dsh-pocket-last-msg-at', 'under the phone’s own key, not the unread ledger’s')
  assert.ok(JSON.parse(payload).a > 0, 'and it carries the clock it just accepted')
  rt.noteSessionMessageAt('', ago(1))
  rt.noteSessionMessageAt(null, ago(1))
  rt.noteSessionMessageAt('a', 0)
  assert.equal(rt.clockWrites(), first + 1, 'no session id or no clock writes nothing at all')
})