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

const LABELS = ['noWorkspaces', 'noTasksHint', 'newChat', 'untitled', 'clockMd', 'clockYmd', 'moreRows', 'wsNewDone', 'wsQuestion', 'wsError', 'pinSession', 'unpinSession', 'pinnedNotice', 'unpinnedNotice', 'pinFailed']
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
const listRuntime = ({ summaries = [], ledger = {}, activeSession = null, lastMsg = {}, pinned = [] } = {}) => {
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
    let pinnedSessionIds=${JSON.stringify(pinned)}
    let pinBusy=new Set()
    const $=(id)=>container
    const tailCache=new Map(),tailArmedAt={},tailPending=new Set()
    function requestVisibleTails(){}
    function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
    ${[
      'visibleSessions', 'blankRowVisible', 'taskState', 'taskGlyph', 'pad2',
      'formatMessageClock', 'timeFor', 'titleFor', 'renderWorkspaces', 'readOpenedMap', 'isSessionUnread',
      'isQuestionUnread',
      'wsFlagOf', 'wsFlagClass', 'wsFlagRank', 'wsFlagsOf', 'wsFlagHtml', 'wsRunning', 'wsGlyphOf', 'sessionModelLabel',
      'readLastMessageMap', 'pruneLastMessageMap', 'noteSessionMessageAt',
      'lastMessageAtOf', 'lastMessageTimeOf', 'sortAtOf', 'pinRank', 'wsHeadTimeAt',
      // T5: the renderer paints a tail line from the prefetch cache and hands the
      // visible rows to requestVisibleTails. The sandbox never fetches: an empty
      // cache and a no-op pull match a landing with nothing prefetched yet.
      'tailTextOf',
      'normalizeSelection', 'fieldText',
    ].map((name) => extractFunction(js, name)).join('\n')}
    let lastMessageAt=${JSON.stringify(lastMsg)}
    let openedLedgerRaw=${JSON.stringify(JSON.stringify(ledger))}
    localStorage={}
    localStorage.getItem=(key)=>{storageReads.n+=1;return key===LAST_MESSAGE_KEY?JSON.stringify(lastMsg):openedLedgerRaw}
    localStorage.setItem=(key,value)=>{writes.push([key,value])}
    return { renderWorkspaces, lastMessageTimeOf, sortAtOf, noteSessionMessageAt, lastMessageAtOf, writes, storageReads:()=>storageReads.n, clockWrites:()=>writes.filter(([k])=>k===LAST_MESSAGE_KEY).length, markup(){ renderWorkspaces(); return container.innerHTML } }  `)
  return make(
    [{ workspaceId: 'w1', title: 'DSH', sessionIds: summaries.map((row) => row.sessionId) }],
    summaries,
    new Set(['w1']),
    new Map(),
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

test('T2 an error the reader already saw stops nagging the head (2026-10-14 手机八问⑧)', () => {
  // User ruling (m00001⑧ + m00047): the failed session must not broadcast its
  // error forever — 「跟已完成一样」: unread error = red dot on the row (the
  // generic is-unread path already covers error rows), read error = quiet. The
  // glyph stays (taskGlyph is state truth, not a notice); only the HEAD pill is
  // gated on unread, so opening the chat (showSessionList stamps the ledger)
  // clears the nag without hiding that the last turn failed.
  const failed = [row({ sessionId: 'a', error: true, updatedAt: ago(1) })]
  assert.deepEqual(headFlags(listSandbox({ summaries: failed, ledger: {} })), [L.wsError], 'never opened + fresh failure → the head says so')
  assert.deepEqual(headFlags(listSandbox({ summaries: failed, ledger: { a: ago(30) } })), [L.wsError], 'opened BEFORE the failure → still unread')
  assert.deepEqual(headFlags(listSandbox({ summaries: failed, ledger: { a: ago(0.5) } })), [], 'opened AFTER the failure → read, quiet')
  assert.deepEqual(
    headFlags(listSandbox({ summaries: failed, ledger: { a: ago(0.5) }, activeSession: 'a' })),
    [],
    'and the focused row never badges itself',
  )
  const markup = listSandbox({ summaries: failed, ledger: { a: ago(0.5) } })
  assert.ok(markup.includes('task-row is-error'), 'the row still shows its error glyph — the fact is visible, the nag is gone')
})

test('a question the reader already opened stops nagging the head (2026-10-20 置顶规则)', () => {
  // User ruling (m00126②): 「置顶里面应该关注的是：没有看的、没有回答的提问……只要这些
  // 都已经点了，上面就不应该再显示」. The question badge used to be unconditional, so a
  // question the reader had seen (and every question asked while the turn stayed
  // running) nagged forever. A question is a running turn by construction, so it
  // cannot ride isSessionUnread — that helper returns false for running rows.
  const asking = [row({ sessionId: 'a', awaitingQuestion: true, updatedAt: ago(1) })]
  assert.equal(asking[0].running, undefined, 'the row is NOT flagged running — only awaiting')
  assert.deepEqual(headFlags(listSandbox({ summaries: asking, ledger: {} })), [L.wsQuestion], 'never opened → the head names it')
  assert.deepEqual(headFlags(listSandbox({ summaries: asking, ledger: { a: ago(30) } })), [L.wsQuestion], 'opened BEFORE the question landed → still unread')
  assert.deepEqual(headFlags(listSandbox({ summaries: asking, ledger: { a: ago(0.5) } })), [], 'opened AFTER it landed → read, quiet')
  assert.deepEqual(
    headFlags(listSandbox({ summaries: asking, ledger: { a: ago(0.5) }, activeSession: 'a' })),
    [],
    'and the chat being answered on screen never badges itself',
  )
  // Same gate holds when the question row also carries the running flag, which is
  // the shape that made isSessionUnread the wrong helper here.
  const runningAsk = [row({ sessionId: 'a', awaitingQuestion: true, running: true, updatedAt: ago(1) })]
  assert.deepEqual(headFlags(listSandbox({ summaries: runningAsk, ledger: { a: ago(0.5) } })), [], 'read running question → quiet')
  assert.deepEqual(headFlags(listSandbox({ summaries: runningAsk, ledger: { a: ago(30) } })), [L.wsQuestion], 'unread running question → still nags')
})

test('a sidebar head has only two fallback stories: in progress, or nothing running', () => {
  // User ruling (m00126③): 「最终的显示状态应该只有两种：要么是有正在进行的对话，要么是
  // 整个工作区完全没有正在进行的对话」. The old fallback leaked a ROW's state into the
  // head (states[0] → error/awaiting glyphs) as soon as any notice was read.
  const mixed = [
    row({ sessionId: 'a', error: true, updatedAt: ago(50) }),
    row({ sessionId: 'b', updatedAt: ago(51) }),
  ]
  const readAll = { a: ago(0.5), b: ago(0.5) }
  const markup = listSandbox({ summaries: mixed, ledger: readAll })
  assert.deepEqual(headFlags(markup), [], 'everything read → no notices')
  assert.ok(markup.includes('ws-last is-done'), 'and the head reports the only other state: nothing running')
  assert.ok(!markup.includes('ws-last is-error'), 'an error row does not become the head\'s story')
  assert.ok(!markup.includes('ws-last is-awaiting'), 'nor does a waiting row')
  // One row still running → the head says so, regardless of what the others are.
  const busy = [...mixed, row({ sessionId: 'c', running: true, updatedAt: ago(52) })]
  const busyMarkup = listSandbox({ summaries: busy, ledger: readAll })
  assert.ok(!busyMarkup.includes('ws-last is-done'), 'a running row anywhere stops the completion claim')
  assert.ok(!busyMarkup.includes('ws-last is-error'), 'and the head still does not adopt a row\'s error')
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
  assert.match(wsTime(markup), /^\d{2}:\d{2}$/, 'and so does its clock — absolute 24h wall clock (2026-10-13 unification)')
})

test('one busy row anywhere stops the head claiming the workspace is done (2026-10-16 四态裁定)', () => {
  // User ruling (m00001): 「只有当工作区里面任何一个对话都已经完成了，并且不在这 3 个状态
  // 里面时，才会显示"已完成"」. The old fallback read tasks[0] — newest row only — so a
  // workspace whose newest row had finished while an older one still ran painted a green
  // check. Nothing is unread here, so there are no badges to ride: the head glyph alone
  // decides, and it must say running.
  const markup = listSandbox({
    summaries: [row({ sessionId: 'fresh', updatedAt: ago(1) }), row({ sessionId: 'busy', running: true, updatedAt: ago(4) })],
    ledger: { fresh: ago(0.1), busy: ago(30) },
  })
  assert.deepEqual(headFlags(markup), [], 'every row already read — nothing to interrupt for')
  assert.ok(markup.includes('ws-last is-running'), 'the head falls back to the spinner, not the check')
  assert.ok(!markup.includes('ws-last is-done'), 'and never claims completion while a row still runs')
})

test('a workspace of only blank chats does not claim completion either', () => {
  // wsGlyphOf only says done when EVERY row is done: an all-blank workspace used to show
  // the newest row's dash, and a flat 「done」 there would be a new false positive.
  const markup = listSandbox({ summaries: [row({ sessionId: 'b1', blank: true }), row({ sessionId: 'b2', blank: true })], ledger: {} })
  assert.ok(!markup.includes('ws-last is-done'), 'no finished turn to report')
  assert.ok(markup.includes('ws-last is-blank'), 'the blank glyph stands (the newest row, as before)')
})

test('a notice comes with the newest row clock, and the notice rows keep their own glyphs', () => {
  const markup = listSandbox({
    summaries: [row({ sessionId: 'ask', awaitingQuestion: true, updatedAt: ago(2) }), row({ sessionId: 'done', updatedAt: ago(5) })],
    ledger: readLongAgo,
  })
  assert.deepEqual(headFlags(markup), [L.wsQuestion, L.wsNewDone], 'both notices are named')
  assert.match(wsTime(markup), /^\d{2}:\d{2}$/, 'the clock is NOT hidden by the notice (newest row, not oldest) — absolute 24h wall clock')
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
  assert.match(String((markup.match(/<time>([^<]*)<\/time>/) || [])[1]), /^\d{2}:\d{2}$/, 'no separator, no id — absolute 24h wall clock')
  const partial = listSandbox({
    summaries: [row({ sessionId: 'a', updatedAt: ago(0.2), projections: { values: { modelSelection: { next: { model: '' } } } } })],
  })
  assert.match(String((partial.match(/<time>([^<]*)<\/time>/) || [])[1]), /^\d{2}:\d{2}$/, 'a model id that is not a string renders nothing — absolute 24h wall clock')
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
  assert.match(wsTime(markup), /^\d{2}:\d{2}$/, 'and the head clock is that message, not the row that churned — absolute 24h wall clock')
})

test('a session this phone never opened still shows its host clock', () => {
  const markup = listSandbox({ summaries: [row({ sessionId: 'unopened', updatedAt: ago(4) })] })
  assert.match(wsTime(markup), /^\d{2}:\d{2}$/, 'no ledger entry means updatedAt, never a blank — absolute 24h wall clock')
})

// The clock answers "when did this workspace last speak". Pinning answers "which
// conversation do I want to read first" — a reading-order override, not a claim
// about time. It must never reach the header clock.
test('pinning an old conversation does not drag the header clock back with it', () => {
  // Verbatim (user, 2026-10-20):「手机 Pocket 各个工作区里显示的时间，会被置顶的会话所代替。
  // 如果我置顶了比如前天的会话，它就会只显示前天的时间……显示逻辑好像会被置顶顶掉」.
  // `tasks` is ordered pinned-first and only then by recency, so tasks[0] IS the
  // two-day-old pinned row here — the pre-fix head printed its clock.
  const stale = ago(60 * 48)
  const markup = listSandbox({
    summaries: [row({ sessionId: 'fresh', updatedAt: ago(2) }), row({ sessionId: 'pinnedOld', updatedAt: stale })],
    pinned: ['pinnedOld'],
  })
  assert.deepEqual(
    idsInOrder(markup).slice(0, 2).sort(),
    ['fresh', 'pinnedOld'],
    'both rows are listed, the pinned one first',
  )
  const clock = wsTime(markup)
  assert.ok(clock, 'the header still shows a clock')
  assert.equal(
    clock,
    wsTime(listSandbox({ summaries: [row({ sessionId: 'fresh', updatedAt: ago(2) })] })),
    'and it is the workspace\'s newest clock, identical to a workspace holding only that row — pinning changes nothing about it',
  )
  assert.notEqual(clock, wsTime(listSandbox({ summaries: [row({ sessionId: 'pinnedOld', updatedAt: stale })] })), 'not the pinned row\'s two-day-old clock')
})

test('the header clock follows the newest row even when that row is not pinned', () => {
  const markup = listSandbox({
    summaries: [row({ sessionId: 'fresh', updatedAt: ago(1) }), row({ sessionId: 'older', updatedAt: ago(30) })],
    pinned: ['older'],
  })
  const onlyFresh = wsTime(listSandbox({ summaries: [row({ sessionId: 'fresh', updatedAt: ago(1) })] }))
  assert.equal(wsTime(markup), onlyFresh, 'the unpinned newest row is what the header reads')
})

test('a workspace whose only real rows carry no clock still shows no header clock', () => {
  // Blank rows are filtered before this point and a placeholder summary must not
  // lend the header a fake clock, so the fallback is 0 and the span is dropped —
  // the old `tasks.length?` guard printed an empty <span> instead.
  const markup = listSandbox({ summaries: [{ sessionId: 'ghost', missingSummary: true, updatedAt: 0 }] })
  assert.ok(!markup.includes('ws-last-time'), 'no clock, no element')
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

// ------------------------------------------- 4. the pinned row rides to the top
//
// User intent (verbatim, 2026-10-13): 「我希望能够把'置顶不置顶'这个功能透传过来，别的绘画
// 管理功能倒是可以暂时不要」 — pass the desktop pin through to the phone list, nothing else.
// The host keeps pins as a per-workspace-registry id list (recent-first) and broadcasts it on
// the follow stream; the phone only has to ORDER by it, never re-rank by pin time. So the
// contract here is partition, not sort: a pinned row outranks an un-pinned one regardless of
// which clock is newer, and among unpinned rows the usual last-message order still holds.

test('a pinned row outranks a newer unpinned row — partition, not pin-time order', () => {
  const summaries = [
    row({ sessionId: 'loud', updatedAt: ago(1) }), // newest clock, not pinned
    row({ sessionId: 'quiet', updatedAt: ago(40) }), // old, but pinned on the desktop
  ]
  assert.deepEqual(idsInOrder(listSandbox({ summaries })), ['loud', 'quiet'], 'without a pin the clock decides the order')
  assert.deepEqual(idsInOrder(listSandbox({ summaries, pinned: ['quiet'] })), ['quiet', 'loud'], 'and the desktop pin wins over the clock')
})

test('several pins stay in their own last-message order — the pin only partitions', () => {
  // Desktop semantics: pinnedSessionIds is recent-first, but the sidebar sorts pinned
  // rows by their normal clock inside the pinned band. Ranking by pin time instead would
  // make the phone disagree with what the desktop shows.
  const markup = listSandbox({
    summaries: [
      row({ sessionId: 'p-old', updatedAt: ago(30) }),
      row({ sessionId: 'p-new', updatedAt: ago(2) }),
      row({ sessionId: 'free', updatedAt: ago(1) }),
    ],
    pinned: ['p-old', 'p-new'], // p-old was pinned most recently
  })
  assert.deepEqual(idsInOrder(markup), ['p-new', 'p-old', 'free'], 'the pinned band first, still clock-ordered inside it')
})

// ② of the 2026-10-14 handover (m02164): a failed session must stop nagging
// forever. 「有时候会话已经崩掉了，我无法解决，只能开新会话去解决。那那个错误
// 会话不一直在这儿吗？」 The ruling is 跟已完成一样 — the red dot on the row is the
// notice, and reading it clears it; after a day it stops interrupting at all.
test('⑧ an error older than the 24h window rests, and reading it clears it before that', () => {
  assert.deepEqual(
    headFlags(listSandbox({ summaries: [row({ sessionId: 'dead', error: true, updatedAt: ago(30 * 60) })] })),
    [],
    'never opened, but the failure is a full day old → old business, quiet (the 24h whole-page window)',
  )
  assert.deepEqual(
    headFlags(listSandbox({ summaries: [row({ sessionId: 'dead', error: true, updatedAt: ago(30 * 60) })] })),
    [],
    'and the row itself is outside the window too — nothing to dot',
  )
  assert.deepEqual(
    headFlags(listSandbox({
      summaries: [row({ sessionId: 'a', error: true, updatedAt: ago(1) })],
      ledger: { a: ago(0.5) },
      activeSession: 'a',
    })),
    [],
    'opened and focused → quiet',
  )
})

test('REQ2: pinned rows are exempt from the 24h window and do not evict recent rows', () => {
  // 用户 2026-10-15 REQ2：「置顶了以后就不再受 24 小时限制」。旧算法只数窗口内
  // 的行当显示上限，而 tasks 已按 pinRank 先排——于是两条超窗口的置顶行占掉名额，
  // 把窗口内的第三条普通会话挤进「还有 N 条」后面（置顶反而把该显示的藏了）。
  const recent = [
    row({ sessionId: 'r1', updatedAt: ago(10) }),
    row({ sessionId: 'r2', updatedAt: ago(20) }),
    row({ sessionId: 'r3', updatedAt: ago(30) }),
  ]
  const stalePins = [
    row({ sessionId: 'p1', updatedAt: ago(60 * 26) }),
    row({ sessionId: 'p2', updatedAt: ago(60 * 30) }),
  ]
  const markup = listSandbox({ summaries: [...recent, ...stalePins], pinned: ['p1', 'p2'] })
  const ids = [...markup.matchAll(/data-action="open" data-id="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(ids.slice(0, 2), ['p1', 'p2'], 'pins still sort first')
  assert.equal(ids.length, 5, 'every pin plus every in-window row is painted')
  assert.ok(!/data-action="more"/.test(markup), 'and nothing is hidden behind「还有 N 条」')
})

test('REQ2: an unpinned row outside the window still falls behind「还有 N 条」', () => {
  // 免限额只给置顶，普通旧会话照旧收口——否则「24 小时」这条用户要留的界限就没了
  // （m00057：用户留下了「更多」这条回到全表的路）。
  const markup = listSandbox({
    summaries: [row({ sessionId: 'fresh', updatedAt: ago(1) }), row({ sessionId: 'old', updatedAt: ago(60 * 26) })],
    pinned: [],
  })
  assert.match(markup, /data-action="more"/, 'the old unpinned row is collapsed')
  assert.match(markup, /data-id="fresh"/)
  assert.ok(!/data-id="old"/.test(markup), 'and it is not painted')
})

test('a pinned row paints beside every row and reports its state', () => {
  const markup = listSandbox({
    summaries: [row({ sessionId: 'a', updatedAt: ago(1) }), row({ sessionId: 'b', updatedAt: ago(2) })],
    pinned: ['a'],
  })
  const pins = [...markup.matchAll(/<button class="task-pin([^"]*)" data-action="pin" data-pin="([^"]+)" aria-label="([^"]+)" aria-pressed="([^"]+)"/g)]
    .map((m) => ({ cls: m[1].trim(), id: m[2], label: m[3], pressed: m[4] }))
  assert.equal(pins.length, 2, 'one pin button per row — and never inside the row button (a button cannot nest)')
  assert.deepEqual(pins.map((p) => p.id), ['a', 'b'], 'the pin carries its own session id')
  assert.deepEqual(pins.map((p) => p.pressed), ['true', 'false'], 'aria-pressed is the live pin state')
  assert.deepEqual(pins.map((p) => p.label), [L.unpinSession, L.pinSession], 'and the label offers the way back')
  assert.equal(pins[0].cls, 'is-pinned', 'the pinned row marks its button; the other carries no class')
  // The is-pinned class alone was not enough: the same outline glyph in the brand colour
  // still read as unpinned at 13 px on a phone (user, 2026-10-14: 「这个置顶的图标，点击与否没有差异」).
  // 2026-10-15 REQ1: 用户复报「差异性有点小了」——换成实心填充 + 品牌底色块（不是只换
  // 描边色），并给整行加 is-pinned-row 底色与左边框，让「置顶」在一屏里一眼可见。
  assert.match(css, /\.task-pin\{[^}]*color:var\(--muted\)/, 'the resting pin is the muted outline glyph')
  assert.match(css, /\.task-pin\.is-pinned\{[^}]*background:var\(--brand\)/, 'a pinned pin is a filled brand chip, not a recoloured outline')
  assert.match(css, /\.task-pin\.is-pinned svg path\{fill:currentColor/, 'and the glyph fills from the same currentColor')
  assert.match(css, /\.task-row\.is-pinned-row\{[^}]*background:var\(--pinRowBg\)/, 'the whole pinned row carries a tint, so the pin reads from the row too')
  assert.match(markup, /class="task-row is-[a-z]+(?: is-unread)? is-pinned-row"/, 'the pinned row is marked in the markup')
  // The row wrapper is a grid item of .task-list{display:grid}, so its default
  // min-width:auto is its min-content — and the title inside is white-space:nowrap.
  // One session title with a long unbreakable run (a path, 120 b's) therefore pushed
  // the single column to 1095 px on a 390 px phone: every row stretched, the 「还有 N 条」
  // pill followed it, and .ws-card{overflow:hidden} clipped the pin button off-screen
  // (user, 2026-10-14: 「对话的显示宽度发生了一些变化…就怕后面的那个置顶按钮也看不到了」;
  // only workspaces holding such a title showed it, which is why just defws looked broken).
  assert.match(css, /\.task-line\{[^}]*min-width:0/, 'the grid item may shrink below its min-content')
  assert.match(css, /\.task-pin:disabled\{[^}]*opacity:/, 'disabled pin dims during sync')
})

test('togglePin inverts pinned state optimistically, calls rpc, and restores on failure', async () => {
  const start = js.indexOf('async function togglePin(')
  const end = js.indexOf('function titleFor(', start)
  const fnStr = js.slice(start, end)

  let currentPinned = ['s1']
  const pinBusy = new Set()
  let rendered = 0
  const toasts = []
  let rpcShouldFail = false
  const rpcCalls = []
  const rpc = async (method, payload) => {
    rpcCalls.push({ method, payload })
    if (rpcShouldFail) throw new Error('network down')
    return { pinnedSessionIds: ['s2'] }
  }

  const makeToggle = new Function(
    'pinnedSessionIds_getter', 'pinnedSessionIds_setter',
    'pinBusy', 'renderWorkspaces', 'showToast', 'L', 'rpc',
    'let pinnedSessionIds = pinnedSessionIds_getter();' +
    fnStr +
    ';return async (id) => {' +
    '  const p = togglePin(id);' +
    '  pinnedSessionIds_setter(pinnedSessionIds);' +
    '  await p;' +
    '  pinnedSessionIds_setter(pinnedSessionIds);' +
    '};'
  )

  const toggle = makeToggle(
    () => currentPinned,
    (v) => { currentPinned = v },
    pinBusy,
    () => { rendered++ },
    (msg) => { toasts.push(msg) },
    L,
    rpc
  )

  // 1. Success case: unpin s1 optimistically and settle with RPC return
  await toggle('s1')
  assert.equal(rpcCalls.length, 1)
  assert.equal(rpcCalls[0].method, 'workspace.unpin')
  assert.deepEqual(currentPinned, ['s2'], 'settles with rpc response')
  assert.deepEqual(toasts, [L.unpinnedNotice])
  assert.equal(pinBusy.size, 0)

  // 2. Failure case: roll back to original pins
  rpcShouldFail = true
  rpcCalls.length = 0
  toasts.length = 0
  await toggle('s2')
  assert.equal(rpcCalls.length, 1)
  assert.equal(rpcCalls[0].method, 'workspace.unpin')
  assert.deepEqual(currentPinned, ['s2'], 'rolls back to original pins on error')
  assert.deepEqual(toasts, [L.pinFailed])
  assert.equal(pinBusy.size, 0)
})

test('action === "pin" locks revealedLists so unpinned older rows do not vanish', () => {
  assert.match(js, /else if\(action==='pin'\)\{e\.stopPropagation\(\);const rows=card\.querySelectorAll\('\.task-row'\)\.length;if\(wsId&&rows&&!revealedLists\.has\(wsId\)\)revealedLists\.set\(wsId,rows\);void togglePin\(btn\.dataset\.pin\)\}/)
})
