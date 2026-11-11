// The「未分组」heading (user 2026-10-28).
//
// The desktop groups its session list by workspace and paints every session that
// belongs to none of them under `t("group.ungrouped")` — the host's own copy says
// so twice: `ProjectRowItem` labels a group with no `workspaceId` that way, and
// `delete.desc` promises a removed workspace's sessions「将显示在“未分组”下」.
// The phone had no such heading: `bootVisibleRows` keeps unclaimed rows on purpose
// (「they are the ones the landing resolves to a synthetic placeholder row」) and no
// card ever claimed them, so 1,075 of the live document's 1,087 rows reached the
// phone and were dropped on the last step.
//
// Two halves, tested where each lives:
//   bridge — it must hand over WHICH of the unclaimed rows are unclaimed only
//            because their workspace is hidden here (`hiddenSessionIds`), since
//            those look identical to genuinely orphaned rows on the page;
//   page   — `ungroupedCards()` must claim exactly「the rest」: not a workspace's,
//            not hidden, not archived.
import test from 'node:test'
import assert from 'node:assert/strict'
import { LanMobileBridge } from '../lib/bridge.js'
import { mobilePageAssets } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })
const { js: jsEn } = mobilePageAssets({ locale: 'en' })

const DAY = 24 * 60 * 60 * 1000
const row = (sessionId, updatedAt) => ({ sessionId, updatedAt, blank: false })

function makeBridge({ items, workspaceItems, pinnedSessionIds = [], hiddenId = null }) {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = []
  bridge.log = () => {}
  bridge.locale = () => 'zh'
  bridge.now = () => Date.now()
  bridge.pendingQuestions = new Map()
  bridge.noteSavings = () => {}
  bridge.workspaceSnapshot = { items: workspaceItems, pinnedSessionIds }
  bridge.cachedSettings = async () => ({ ok: true, value: {} })
  bridge.cachedSessionList = async () => ({ ok: true, value: { items } })
  bridge.mobileAssetBodies = () => ({ urls: {} })
  bridge.refreshBotWorkspaceId = async () => hiddenId
  return bridge
}

const WORKSPACE = 'w1'
const HIDDEN = 'bot-ws'

// The live shape (measured 2026-10-28): a workspace item carries its own
// `sessionIds` (235/67/19/6 across the four visible ones), and NO session row
// carries a `workspaceId` (0 of 1,087). A fixture that gave rows a workspaceId
// would let a filter that only reads rows pass here and do nothing on the phone.
const twoWorkspaces = [
  { workspaceId: WORKSPACE, title: 'defws', path: 'F:\\defws', sessionIds: ['a', 'b'] },
  { workspaceId: HIDDEN, title: 'DS Bot', path: 'F:\\DSBOT', sessionIds: ['bot1', 'bot2'] },
]

test('the bridge hands over the hidden membership, so the page can tell hidden from orphaned', async () => {
  const now = Date.now()
  const items = [row('a', now - 1000), row('bot1', now - 1000), row('orphan', now - 1000)]
  const bridge = makeBridge({ items, workspaceItems: twoWorkspaces, hiddenId: HIDDEN })
  const boot = await bridge.buildMobileBoot()

  assert.deepEqual(
    boot.ws.hiddenSessionIds?.slice().sort(),
    ['bot1', 'bot2'],
    'both sessions of the hidden workspace travel as ids: the page cannot derive them (rows carry no workspaceId)',
  )
  assert.equal(
    boot.ws.items.some((item) => item.workspaceId === HIDDEN),
    false,
    'and the hidden workspace itself still does not',
  )
})

test('nothing hidden, no field: a bridge with no hidden workspace ships no empty list', async () => {
  const now = Date.now()
  const items = [row('a', now - 1000)]
  const bridge = makeBridge({ items, workspaceItems: [twoWorkspaces[0]], hiddenId: null })
  const boot = await bridge.buildMobileBoot()

  assert.equal('hiddenSessionIds' in boot.ws, false, 'an empty set adds nothing to a 1.7 MB document')
})

// The other half of the same signal (Truth-Guard 2026-10-28 12:1x): a hidden
// workspace that IS resolved but whose item has not reached the snapshot yet (the
// carrier has only just connected) must still ship the field — an empty list — so
// the page knows something is hidden. Shipping nothing let those rows fall into
// the bucket, which is the one boundary the user asked not to break.
test('a hidden workspace with no resolved members yet ships an empty list, not nothing', async () => {
  const now = Date.now()
  const items = [row('a', now - 1000), row('orphan', now - 1000)]
  const bridge = makeBridge({ items, workspaceItems: [twoWorkspaces[0]], hiddenId: HIDDEN })
  const boot = await bridge.buildMobileBoot()

  assert.deepEqual(boot.ws.hiddenSessionIds, [],
    'the field says「something is hidden」; its emptiness says「not resolved yet」')
  assert.equal(boot.ws.items.some((item) => item.workspaceId === HIDDEN), false,
    'and the workspace itself is still not among the items')
})

// Regression (audit P1-1, 2026-10-24): the hidden ids used to be collected from
// the session rows (`row.workspaceId === hiddenId`), and the host sends no
// workspaceId on any row — so the set was always empty and the hidden workspace's
// pins were never stripped. The membership lives in the workspace item.
test('the hidden membership comes from the workspace item, not from the rows', () => {
  const bridge = makeBridge({ items: [{ sessionId: 'bot1' }], workspaceItems: twoWorkspaces, hiddenId: HIDDEN })
  const hidden = bridge.botWorkspaceHiddenSessions.call(bridge, HIDDEN)
  return hidden.then((ids) => {
    assert.deepEqual([...ids].sort(), ['bot1', 'bot2'], 'the item is the only place the host records membership')
  })
})

test('a pin inside the hidden workspace is dropped with it', async () => {
  const now = Date.now()
  const items = [row('a', now - DAY), row('bot1', now - DAY)]
  const bridge = makeBridge({
    items,
    workspaceItems: twoWorkspaces,
    pinnedSessionIds: ['a', 'bot1'],
    hiddenId: HIDDEN,
  })
  const boot = await bridge.buildMobileBoot()

  assert.deepEqual(boot.ws.pinnedSessionIds, ['a'], 'the Bot team cannot ride back in on the pin list')
})

// Brace-match, but starting after the parameter list: a signature with a default
// object (`options = {}`) closes the depth counter before the body opens, and the
// extractor would hand back a truncated header that `new Function` cannot compile.
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the rendered asset`)
  let i = source.indexOf('(', start)
  let paren = 0
  for (; i < source.length; i++) {
    if (source[i] === '(') paren++
    else if (source[i] === ')') {
      paren--
      if (paren === 0) break
    }
  }
  let depth = 0
  for (let j = i; j < source.length; j++) {
    const char = source[j]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return source.slice(start, j + 1)
    }
  }
  throw new Error(`unbalanced braces after ${name}`)
}

// The label table, taken from the rendered shell of the locale under test
// (house pattern, test/pages-process-render.test.js:36-40). The bucket card's
// title differs by locale, so it must never be written into the test as a
// literal: 未分组 for zh, Ungrouped for en.
function labels(locale) {
  const line = (locale === 'en' ? jsEn : js).match(/^const L=(\{.*\});/m)
  assert.ok(line, `${locale}: the label table must render as one JSON line`)
  return JSON.parse(line[1])
}

// The page's own function, run against the page's own state names: a fixture that
// re-implemented the difference here would stay green while the page did nothing.
function ungroupedCards({ workspaces, sessionSummaries, archivedSessionIds = [], hiddenWsSessionIds = [], hiddenWsListed = false, locale = 'zh' }) {
  const source = locale === 'en' ? jsEn : js
  const body = extractFunction(source, 'ungroupedCards')
  const make = new Function(
    'L',
    'workspaces',
    'sessionSummaries',
    'archivedSessionIds',
    'hiddenWsSessionIds',
    'hiddenWsListed',
    `${extractFunction(source, 'unclaimedSessionIds')}\n${body};return ungroupedCards()`,
  )
  return make(labels(locale), workspaces, sessionSummaries, archivedSessionIds, hiddenWsSessionIds, hiddenWsListed)
}

const summaries = (ids) => ids.map((sessionId) => ({ sessionId, updatedAt: 1, blank: false }))
const lastCard = (cards) => cards[cards.length - 1]
const hasUngrouped = (cards) => cards.some((card) => card.ungrouped === true)

// ---------------------------------------------------------------------------
// 渲染层：页面还画不画那张桶卡（用户 2026-10-30「隐藏就是两个工作区，未分组和DSBOT」）
// ---------------------------------------------------------------------------
// 归属仍由 ungroupedCards() 算（桥侧 pageWarmSummary 读同一个函数，两侧必须一致），
// 画不画在 renderWorkspaces 这一层判。沙箱与 test/list-bounds.test.js:167 paintList
// 同构，唯一差别：那支把 ungroupedCards 换成桩（它只测工作区卡），这里必须用真函数，
// 否则「桶卡不画」这条判据测的是桩而不是页面。
const L = labels('zh')
function assetNumber(pattern, label) {
  const hit = js.match(pattern)
  assert.ok(hit, `${label} must stay a plain number in the rendered asset`)
  return Number(hit[1])
}
function assetString(pattern, label) {
  const hit = js.match(pattern)
  assert.ok(hit, `${label} must stay on the rendered asset`)
  return hit[1]
}
const UNREAD_OPEN_KEY = assetString(/UNREAD_OPEN_KEY='([^']+)'/, 'UNREAD_OPEN_KEY')
const LAST_MESSAGE_KEY = assetString(/LAST_MESSAGE_KEY='([^']+)'/, 'LAST_MESSAGE_KEY')
const UNREAD_RECENCY_MS = assetNumber(/UNREAD_RECENCY_MS=(\d+)/, 'UNREAD_RECENCY_MS')
const LAST_MESSAGE_MAX = assetNumber(/LAST_MESSAGE_MAX=(\d+)/, 'LAST_MESSAGE_MAX')
const BLANK_ROW_VISIBLE_MS = assetNumber(/BLANK_ROW_VISIBLE_MS=(\d+)/, 'BLANK_ROW_VISIBLE_MS')
const LIST_ROWS_MAX = assetNumber(/LIST_ROWS_MAX=(\d+)/, 'LIST_ROWS_MAX')
const WS_FLAGS_MAX = assetNumber(/WS_FLAGS_MAX=(\d+)/, 'WS_FLAGS_MAX')
const RECENT_WINDOW_MS = assetNumber(/RECENT_WINDOW_MS=(\d+)/, 'RECENT_WINDOW_MS')
const MORE_ROWS = assetNumber(/MORE_ROWS=(\d+)/, 'MORE_ROWS')

const taskRows = (html) => (html.match(/<button class="task-row/g) || []).length

function paintPage({ workspaces, sessionSummaries, hiddenWsSessionIds = [], archivedSessionIds = [], expanded = [] }) {
  const host = { innerHTML: '' }
  const names = [
    'blankRowVisible', 'bootRangeCap', 'taskState', 'taskGlyph', 'pad2', 'formatMessageClock',
    'timeFor', 'titleFor', 'readOpenedMap', 'isSessionUnread', 'isNoticeUnread',
    'wsFlagOf', 'wsFlagClass', 'wsFlagRank', 'wsFlagsOf', 'wsFlagHtml', 'wsRunning', 'wsGlyphOf',
    'sessionModelLabel', 'readLastMessageMap', 'pruneLastMessageMap', 'noteSessionMessageAt',
    'lastMessageAtOf', 'lastMessageTimeOf', 'sortAtOf', 'pinRank', 'wsHeadTimeAt', 'renderWorkspaces',
    'tailTextOf', 'normalizeSelection', 'fieldText',
  ]
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  const make = new Function(
    'fixture',
    'container',
    `
    const L=${JSON.stringify(L)}
    const UNREAD_OPEN_KEY=${JSON.stringify(UNREAD_OPEN_KEY)}
    const UNREAD_RECENCY_MS=${UNREAD_RECENCY_MS}
    const LAST_MESSAGE_KEY=${JSON.stringify(LAST_MESSAGE_KEY)}
    const LAST_MESSAGE_MAX=${LAST_MESSAGE_MAX}
    const BLANK_ROW_VISIBLE_MS=${BLANK_ROW_VISIBLE_MS}
    const LIST_ROWS_MAX=${LIST_ROWS_MAX}
    const WS_FLAGS_MAX=${WS_FLAGS_MAX}
    const RECENT_WINDOW_MS=${RECENT_WINDOW_MS}
    const MORE_ROWS=${MORE_ROWS}
    const workspaces=fixture.workspaces, sessionSummaries=fixture.sessionSummaries
    // hiddenWsListed=false = 「这一页没有隐藏工作区」。页面的早退条件是
    // hiddenWsListed && 隐藏成员为空 ⇒ 字段在场但为空时直接返回工作区、根本不建桶。
    // 沙箱若把字段设成「在场且为空」，桶就永远算不出来，renderWorkspaces 的过滤
    // 也就无从被测到——这里要的是「桶真被算出来，再被滤掉」。
    const hiddenWsListed=false, hiddenWsSessionIds=fixture.hiddenWsSessionIds
    const archivedSessionIds=fixture.archivedSessionIds
    const expandedWsIds=new Set(fixture.expanded), revealedLists=new Map()
    const pinnedSessionIds=[], activeSession=null
    const pinBusy=new Set()
    let openedAtLedgerReady=true
    const $=()=>container
    const tailCache=new Map(),tailArmedAt={},tailPending=new Set()
    function requestVisibleTails(){}
    function requestTailBootRound(){}
    function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
    const store={}
    const localStorage={getItem:(key)=>store[key]||'{}',setItem:(key,value)=>{store[key]=String(value)}}
    ${extractFunction(js, 'unclaimedSessionIds')}
    ${extractFunction(js, 'ungroupedCards')}
    ${body}
    return { paint(){ renderWorkspaces(); return container.innerHTML } }
  `,
  )
  return make({ workspaces, sessionSummaries, hiddenWsSessionIds, archivedSessionIds, expanded }, host).paint()
}

test('an unclaimed session is still the bucket’s row set, and the claimed ones stay where they are', () => {
  const cards = ungroupedCards({
    workspaces: [{ workspaceId: WORKSPACE, title: 'defws', sessionIds: ['a'] }],
    sessionSummaries: summaries(['a', 'orphan1', 'orphan2']),
  })

  assert.equal(hasUngrouped(cards), true, 'the attribution stays computed: the bridge counts rows with this same function')
  const bucket = lastCard(cards)
  assert.equal(bucket.ungrouped, true)
  assert.deepEqual(bucket.sessionIds, ['orphan1', 'orphan2'], 'exactly the rows no workspace claims')
  assert.deepEqual(cards[0].sessionIds, ['a'], 'and the workspace card is untouched')
  assert.equal(cards.length, 2, 'the bucket still rides beside the workspaces; painting it is decided in renderWorkspaces')
})

test('the bucket sorts last, the way the desktop paints the leftovers after the workspaces', () => {
  const cards = ungroupedCards({
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['a'] },
      { workspaceId: 'w2', sessionIds: ['b'] },
    ],
    sessionSummaries: summaries(['a', 'b', 'orphan']),
  })

  assert.deepEqual(
    cards.map((card) => card.ungrouped === true),
    [false, false, true],
  )
})

test('a hidden workspace\u2019s sessions do not leak in under the new heading', () => {
  const cards = ungroupedCards({
    workspaces: [{ workspaceId: WORKSPACE, sessionIds: ['a'] }],
    sessionSummaries: summaries(['a', 'bot1', 'orphan']),
    hiddenWsSessionIds: ['bot1', 'bot2'],
  })

  assert.deepEqual(
    lastCard(cards).sessionIds,
    ['orphan'],
    'the Bot team\u2019s sessions are HIDDEN, not ungrouped (user 2026-10-24)',
  )
})

test('archived sessions stay out of the bucket, as they stay out of a workspace card', () => {
  const cards = ungroupedCards({
    workspaces: [{ workspaceId: WORKSPACE, sessionIds: ['a'] }],
    sessionSummaries: summaries(['a', 'orphan', 'archived1']),
    archivedSessionIds: ['archived1'],
  })

  assert.deepEqual(lastCard(cards).sessionIds, ['orphan'])
})

test('every row accounted for: no bucket at all rather than an empty card', () => {
  const cards = ungroupedCards({
    workspaces: [{ workspaceId: WORKSPACE, sessionIds: ['a', 'b'] }],
    sessionSummaries: summaries(['a', 'b']),
  })

  assert.equal(hasUngrouped(cards), false, 'an empty heading would be furniture, not information')
})

test('a page with no workspaces at all still shows nothing invented', () => {
  const cards = ungroupedCards({ workspaces: [], sessionSummaries: summaries([]) })
  assert.deepEqual(cards, [], 'nothing to claim and nothing to claim it with')
  assert.equal(hasUngrouped(cards), false)
})

// Truth-Guard 2026-10-28 12:1x: an empty set used to ship no field, so the page
// could not tell「nothing is hidden」from「something is hidden and its members are
// not resolved yet」— and in that window the hidden workspace's rows fell straight
// into the new heading. Fail-closed: the field is present, the bucket stays away.
test('a hidden workspace whose members are not resolved yet paints no bucket at all', () => {
  const cards = ungroupedCards({
    workspaces: [{ workspaceId: WORKSPACE, sessionIds: ['a'] }],
    sessionSummaries: summaries(['a', 'bot1', 'orphan']),
    hiddenWsSessionIds: [],
    hiddenWsListed: true,
  })

  assert.equal(hasUngrouped(cards), false,
    'those rows look exactly like orphans here — paint nothing rather than leak the exclusion')
})

test('and a resolved hidden membership still paints the bucket, minus those rows', () => {
  const cards = ungroupedCards({
    workspaces: [{ workspaceId: WORKSPACE, sessionIds: ['a'] }],
    sessionSummaries: summaries(['a', 'bot1', 'orphan']),
    hiddenWsSessionIds: ['bot1'],
    hiddenWsListed: true,
  })

  assert.deepEqual(lastCard(cards).sessionIds, ['orphan'])
})

// The two strings a phone user actually reads. The dictionary is already
// serialised by the time it reaches the asset, so the label is pinned in its
// shipped form rather than in its source form.
test('the heading is the desktop\u2019s own wording in both locales', () => {
  const zh = mobilePageAssets({ locale: 'zh' }).js
  const en = mobilePageAssets({ locale: 'en' }).js
  assert.ok(zh.includes('"ungrouped":"未分组"'), 'zh: the host dictionary calls it 未分组 (group.ungrouped)')
  assert.ok(en.includes('"ungrouped":"Ungrouped"'), 'en: and Ungrouped (group.ungrouped, en dictionary)')
})

// 用户 2026-11-02 判据④：「未分组恢复显示」——屏蔽对象只剩 F:\DSBOT 一个工作区，
// 未分组的行重新有卡可落（此前 2026-10-30 曾把整张桶卡退场，本轮反转回来）。
// 这条断言跑的是真 renderWorkspaces + 真 ungroupedCards（不是源码切片）：切片在
// 分支被删之后只会恒真，测不出页面到底画了什么。
// 测试意图取代（2026-11-11 本单 m00030 反转 m00110，见本 change intent.md §2.1）：
// 未分组桶卡恢复落地、首帧默认折叠（D1/D2），卡头数量 = sessionTotal 或真画行数（D3）。
// 旧 m00110 判据「整张退场」的注释逐字留在上面，判据正本不改；本段两例按新判据重写，
// 「隐藏成员不透传」这条负载断言原样保留。
test('m00030 判据④：未分组桶卡首帧落地、默认折叠，orphan 行不落进工作区卡', () => {
  const html = paintPage({
    workspaces: [{ workspaceId: WORKSPACE, title: 'defws', path: 'F:\\\\\\\\defws', sessionIds: ['a'] }],
    sessionSummaries: summaries(['a', 'orphan1', 'orphan2']),
    expanded: [WORKSPACE],
  })

  assert.equal(
    (html.match(/<article class="ws-card/g) || []).length,
    2,
    'm00030 反转 m00110：未分组桶卡落地，与工作区卡同画',
  )
  assert.equal((html.match(/data-ws=""/g) || []).length, 1,
    'intent §3.1 D1：首帧有 data-ws="" 未分组卡')
  assert.equal((html.match(/aria-expanded="false"/g) || []).length, 1,
    'intent §3.1 D2：fixture 未预展开时未分组卡首帧折叠')
  assert.equal(taskRows(html), 1,
    'intent §3.1 D2：折叠卡不画行；工作区卡那 1 行照旧')
  assert.ok(html.includes('<span class="ws-last-time">2</span>'),
    'intent §3.1 D3：折叠可见区只有标题＋一个数量数字 2（= 桶里 orphan1/orphan2）')
  assert.ok(html.includes('defws'), 'the workspace card itself still renders, header and all')
})

// 同一条判据的另一半：屏蔽对象收窄到 F:\\DSBOT 一个工作区，它自己的行仍不得
// 以「未分组」的名义透传出来——隐藏成员的 id 到场时必须把那些行从桶里剔除。
test('the F:\\DSBOT workspace stays hidden: its rows never leak in as ungrouped', () => {
  const html = paintPage({
    workspaces: [{ workspaceId: WORKSPACE, title: 'defws', path: 'F:\\\\\\\\defws', sessionIds: ['a'] }],
    sessionSummaries: summaries(['a', 'orphan1', 'bot1']),
    expanded: [WORKSPACE],
    hiddenWsSessionIds: ['bot1'],
  })

  assert.equal((html.match(/<article class="ws-card/g) || []).length, 2,
    'm00030 反转 m00110：未分组桶卡落地，工作区卡＋未分组卡各一张')
  assert.equal((html.match(/data-ws=""/g) || []).length, 1,
    '未分组卡恰一张')
  assert.ok(html.includes('<span class="ws-last-time">1</span>'),
    '桶里只剩 orphan1：数量数字成值 1 次且等于真画量')
  assert.equal(taskRows(html), 1,
    '真正未认领的 orphan1 折叠不成行，工作区卡那 1 行照旧')
  assert.equal(
    (html.match(/bot1/g) || []).length,
    0,
    'the hidden F:\\DSBOT row is neither shown nor relabelled as ungrouped',
  )
})

test('the landing stores the hidden membership the bridge sends, and whether it was sent at all', () => {
  assert.match(
    js,
    /hiddenWsListed=Array\.isArray\(ws\.hiddenSessionIds\)/,
    'applyBootData is the one door every list answer comes through (boot, loadListData, fillListFromServer)',
  )
  assert.match(
    js,
    /hiddenWsSessionIds=hiddenWsListed\?ws\.hiddenSessionIds\.filter/,
    'presence is the signal: an empty list still means「something is hidden」',
  )
})
