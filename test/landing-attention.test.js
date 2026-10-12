// Landing discipline: a crowded workspace is not chosen for the user.
//
// User rule (verbatim, 2026-10-12): 「如果满足以下条件的对话超过两个：1. 正在活跃
// （即正在推进）；2. 推进完了但消息还没有读；3. 有提问需求；4. 有错误的。只要满足上述
// 条件的对话超过两个，进来以后就只停留在工作区页面（原来是随便进一个，对吧？）」
//
// The rule is enforced on BOTH sides of the wire, and this file runs the real
// pickers rather than matching literals: the boundary is a comparison, and
// 「two opens, three does not」 cannot be told apart by a string.
//
//   - the bridge (`pickFocusItem` / the document's `initialChat`) knows running,
//     failed and waiting-on-an-answer. It cannot know 「finished but unread」 —
//     that ledger is each phone's own localStorage — so it publishes its count as
//     `sess.attention` instead of deciding alone;
//   - the page (`pickFocusSession`) adds the unread term over the rows it holds and
//     takes `max(own, bridge)`, never a sum: both counts cover overlapping rows.
//
// Cases 5-8 are the reason the split exists: three quietly finished conversations
// are invisible to the bridge, and are exactly the situation the user named.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LanMobileBridge } from '../lib/bridge.js'
import { LANDING_ATTENTION_MAX, landingAttention } from '../lib/projections.js'
import { mobilePageAssets } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })

const MINUTE = 60 * 1000
const ago = (minutes) => Date.now() - Math.round(minutes * MINUTE)

// ---------------------------------------------------------------- bridge side
function makeBridge(overrides = {}) {
  const logs = []
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = logs
  bridge.log = (level, message) => logs.push(`${level}: ${message}`)
  bridge.locale = () => 'zh'
  bridge.iconDataUri = null
  bridge.now = () => Date.now()
  bridge.html = (response, markup) => {
    response.markup = markup
    return markup
  }
  // A waiting question is a BRIDGE fact, not a host row field: buildMobileBoot
  // stamps `awaitingQuestion` from this map over whatever the row carried, so a
  // fixture that only edited the row would silently count one fewer conversation.
  bridge.pendingQuestions = new Map(
    (overrides.pending ?? []).map((sessionId) => [sessionId, { sessionId }]),
  )
  bridge.workspaceSnapshot = { items: [] }
  bridge.cachedSettings = async () => ({ ok: true, value: {} })
  bridge.cachedSessionList = async () => ({ ok: true, value: { items: overrides.items ?? [] } })
  bridge.invokeHarness = overrides.invokeHarness ?? (async () => ({ ok: false, error: 'not stubbed' }))
  return bridge
}

const pick = LanMobileBridge.prototype.pickFocusItem
const running = (id, at) => ({ sessionId: id, updatedAt: at ?? ago(1), running: true })
const awaiting = (id, at) => ({ sessionId: id, updatedAt: at ?? ago(2), awaitingQuestion: true })
const failed = (id, at) => ({ sessionId: id, updatedAt: at ?? ago(3), error: 'boom' })
const quiet = (id, at) => ({ sessionId: id, updatedAt: at ?? ago(9) })

test('two waiting conversations still open one, three do not', () => {
  // The boundary the user set is 「超过两个」 — strictly more than two. Two live
  // conversations still land in the newest of them; a third one parks the phone
  // on the workspace page instead of picking a fighter.
  const two = [running('r1'), awaiting('q1'), quiet('old')]
  assert.equal(pick.call({}, two).sessionId, 'q1', 'two waiting still land somewhere (an answer owed wins)')
  const three = [running('r1'), awaiting('q1'), failed('e1'), quiet('old')]
  assert.equal(pick.call({}, three), null, 'a third one stops the landing from choosing')
})

test('the count counts the four cases and nothing else', () => {
  assert.equal(landingAttention([running('a'), awaiting('b'), failed('c')]), 3)
  assert.equal(landingAttention([running('a', 0), { ...running('d'), descendantRunning: true }]), 2,
    'a parent whose child is still working is 正在推进 too')
  assert.equal(landingAttention([quiet('a'), quiet('b'), quiet('c')]), 0,
    'finished-but-unread is not the bridge call to make')
  assert.equal(landingAttention(undefined), 0)
})

test('a row the phone may not open cannot crowd the landing', () => {
  // Subagent rows are another session's tool, blank shells have nothing in them.
  // They are excluded from the count by the SAME predicate as the picker, so a
  // house full of subagents does not park the phone out of proportion.
  const subagents = [
    { sessionId: 's1', updatedAt: ago(1), origin: 'subagent', running: true },
    { sessionId: 's2', updatedAt: ago(2), origin: 'subagent', running: true },
    { sessionId: 's3', updatedAt: ago(3), origin: 'subagent', running: true },
    quiet('real'),
  ]
  assert.equal(pick.call({}, subagents).sessionId, 'real')
})

test('the boot payload carries the count, and a crowded one ships no focus', async () => {
  const threeLive = { items: [running('r1'), awaiting('q1'), failed('e1')], pending: ['q1'] }
  const bridge = makeBridge(threeLive)
  const payload = await bridge.buildMobileBoot({ history: false, listLimit: 12 })

  assert.equal(payload.sess.attention, 3)
  assert.equal('focus' in payload, false, 'no focus session, so no embedded history either')
  assert.equal(bridge._bootDiag.attention, 3)
  assert.equal(bridge._bootDiag.reason, 'attention=3', 'the log names the rule that stood down')

  const calm = makeBridge({ items: [running('r1'), awaiting('q1')], pending: ['q1'] })
  const calmPayload = await calm.buildMobileBoot({ history: false, listLimit: 12 })
  assert.equal(calmPayload.sess.attention, 2)
  assert.equal(calm._bootDiag.candidate, 'q1', 'two still focuses one')
  assert.equal(calm._bootDiag.reason, 'history-deferred', 'the document defers the history, as before')
})

test('a crowded workspace paints the workspace page, not a chat skeleton', async () => {
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value } }
  const bridge = makeBridge({ items: [running('r1'), awaiting('q1'), failed('e1')], pending: ['q1'] })
  const markup = await bridge.renderMobilePage(
    { url: '/', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:43127' } },
    response,
    'nonce-value',
  )

  assert.doesNotMatch(markup, /<body class="chat-open">/, 'first paint is the workspace page')
  assert.match(bridge.logs.join('\n'), /initialChat=false/)
  assert.match(bridge.logs.join('\n'), /attention=3/, 'the doc line proves which rule fired')
  assert.ok(markup.includes('"attention":3'), 'the phone is told the same number')

  const busy2 = makeBridge({ items: [running('r1'), awaiting('q1')] })
  const calm = await busy2.renderMobilePage(
    { url: '/', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:43127' } },
    { headers: {}, setHeader() {} },
    'nonce-value',
  )
  assert.match(calm, /<body class="chat-open">/, 'the fast first paint is untouched below the threshold')
})

test('the boot payload ships a page of rows, not one row, so the phone can judge unread', async () => {
  // 「推进完了但消息还没有读」 is only decidable where the read ledger lives. With a
  // single row the phone could not add its own term at all, so both cold-open
  // paths now ship the same page of rows — the newest ones, where an unread
  // finish still is (469 rows measured 195 KB, which is why it stays a page).
  const rows = []
  for (let i = 0; i < 20; i += 1) rows.push(quiet('q' + i, ago(i + 1)))
  const bridge = makeBridge({ items: rows })
  const payload = await bridge.buildMobileBoot({ history: false, listLimit: 12 })

  assert.equal(payload.sess.items.length, 12)
  assert.equal(payload.sess.partial, true)
  assert.equal(payload.sess.total, 20, 'a page says it is a page')
  assert.equal(payload.sess.attention, 0)

  const source = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
  const calls = source.match(/buildMobileBoot\(\{[^)]*\}\)/g) ?? []
  assert.ok(calls.length >= 2, 'both cold-open routes build the payload')
  for (const call of calls) {
    assert.match(call, /listLimit: LANDING_LIST_ROWS/, `a cold-open route still ships one row: ${call}`)
  }
})

// ------------------------------------------------------------------ page side
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the rendered page script`)
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

const PAGE_THRESHOLD = Number(js.match(/LANDING_ATTENTION_MAX=(\d+)/)[1])
test('the two sides ship one threshold', () => {
  assert.equal(PAGE_THRESHOLD, LANDING_ATTENTION_MAX, 'the page constant is injected, not retyped')
})

function pageSandbox({ summaries = [], ledger = {}, activeSession = null, attention = 0 } = {}) {
  const make = new Function(
    'sessionSummaries', 'activeSession', 'bootAttention', 'localStorage', `
    const LANDING_ATTENTION_MAX=${PAGE_THRESHOLD}
    const UNREAD_OPEN_KEY='dsh-pocket-opened-at'
    const $=(id)=>({textContent:''})
    ${[
      'readOpenedMap', 'isSessionUnread', 'taskState', 'wsFlagOf', 'wsFlagClass', 'wsFlagRank',
      'needsAttention', 'landingBusy', 'pickFocusSession',
    ].map((name) => extractFunction(js, name)).join('\n')}
    return { landingBusy, pickFocusSession }
  `)
  return make(summaries, activeSession, attention, {
    getItem: () => JSON.stringify(ledger),
    setItem: () => {},
  })
}

const readRow = (id, over) => ({ sessionId: id, updatedAt: ago(2), blank: false, ...over })
const readLongAgo = Object.fromEntries(['a', 'b', 'c', 'd', 'q1', 'q2'].map((id) => [id, ago(60)]))

test('three finished-but-unread conversations stop the landing, two do not', () => {
  // The case the bridge cannot see at all: nothing running, nothing failed, nobody
  // asking — three conversations that simply finished while the phone was away.
  const three = [readRow('a'), readRow('b'), readRow('c')]
  assert.equal(pageSandbox({ summaries: three, ledger: readLongAgo }).pickFocusSession(), null,
    'three unread finishes park the phone on the workspace page')
  const two = [readRow('a', { updatedAt: ago(6) }), readRow('b', { updatedAt: ago(2) })]
  assert.equal(pageSandbox({ summaries: two, ledger: readLongAgo }).pickFocusSession().sessionId, 'b',
    'two still opens the newest of them')
})

test('a conversation the phone has read since its last activity is not waiting', () => {
  const read = { a: ago(1), b: ago(1), c: ago(1) }
  const summaries = [readRow('a', { updatedAt: ago(30) }), readRow('b', { updatedAt: ago(30) }), readRow('c', { updatedAt: ago(30) })]
  assert.ok(pageSandbox({ summaries, ledger: read }).pickFocusSession(),
    'rows opened after they finished do not crowd the landing')
})

test('the bridge count is a floor, and the two counts are never added', () => {
  // own=2, bridge=2 → max 2 → still lands somewhere. A sum would read 4 and park
  // the phone on the list while nothing is actually crowded.
  const ownTwo = [readRow('a'), running('r1')]
  assert.equal(pageSandbox({ summaries: ownTwo, ledger: readLongAgo, attention: 0 }).landingBusy(), false)
  assert.ok(pageSandbox({ summaries: ownTwo, ledger: readLongAgo, attention: 2 }).pickFocusSession(),
    'two on either side is not three')
  assert.equal(pageSandbox({ summaries: ownTwo, ledger: readLongAgo, attention: 3 }).pickFocusSession(), null,
    'a live conversation deeper in the list reaches the phone only through the bridge number')
  assert.equal(pageSandbox({ summaries: [readRow('a', { updatedAt: ago(30) })], ledger: {}, attention: 3 }).pickFocusSession(), null,
    'and the floor holds when the page of rows shows nothing worth flagging')
})

test('the row the user is looking at is not waiting for them', () => {
  // The same session open on screen must not count itself into the crowd.
  const three = [readRow('a'), readRow('b'), readRow('c')]
  const focused = pageSandbox({ summaries: three, ledger: readLongAgo, activeSession: 'c' })
  assert.equal(focused.landingBusy(), false, 'reading one of the three leaves two waiting')
})

test('the page keeps the badge as its own definition of waiting', () => {
  const body = extractFunction(js, 'needsAttention')
  assert.match(body, /wsFlagOf\(s,openedAt,activeId\)!==null/, 'the workspace badge is the single definition')
  assert.match(body, /taskState\(s\)==='running'/, 'plus the one state the badge deliberately does not paint')
})
