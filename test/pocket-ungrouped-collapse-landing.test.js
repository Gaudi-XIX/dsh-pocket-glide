// change 2026-11-11-bugfix-pocket-ungrouped-collapse-and-pin-landing 的 ④（M4/D1-D4）与 ⑤（M5/D5）。
//
// 判据（intent.md §3.1 D1-D5、§6.1 M4/M5，tasks.md T4.1/T4.2）：
//   M4  真 renderWorkspaces + 真 ungroupedCards，喂 ungrouped:true sessionTotal:5——
//       首帧 data-ws="" 卡在、aria-expanded="false"、折叠可见区只标题＋一个数字 5、
//       .task-row 数 0；toggle 一次 → true + 5 行；再 toggle 回 false。
//   M5  bootPreloadIds 三例（未分组会话 / 隐藏工作区会话 / 正常会话）前两排除、
//       第三保留，导出签名 export function bootPreloadIds(input) 不变。
// 被测对象是从 mobilePageAssets().js 按大括号配平抽出的真函数——本文件不重写任何
// 渲染/分支逻辑，替身只补 DOM 与数据器官。删掉页侧折叠入口、卡头数字或预载排除
// 任一处，下面的断言就会转红（反向变异）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mobilePageAssets, bootPreloadIds } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()
const OLD = NOW - 3 * DAY

function extractFunction(source, name) {
  const token = `function ${name}(`
  const hits = []
  let at = source.indexOf(token)
  while (at !== -1) {
    hits.push(at)
    at = source.indexOf(token, at + 1)
  }
  assert.equal(hits.length, 1, `${name} must be defined exactly once in the shipped asset`)
  const start = hits[0]
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${name}`)
}

const L = JSON.parse(js.match(/^const L=(\{.*\});/m)[1])

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

const MORE_ROWS = assetNumber(/MORE_ROWS=(\d+)/, 'MORE_ROWS')
const UNREAD_OPEN_KEY = assetString(/UNREAD_OPEN_KEY='([^']+)'/, 'UNREAD_OPEN_KEY')
const UNREAD_RECENCY_MS = assetNumber(/UNREAD_RECENCY_MS=(\d+)/, 'UNREAD_RECENCY_MS')
const LAST_MESSAGE_KEY = assetString(/LAST_MESSAGE_KEY='([^']+)'/, 'LAST_MESSAGE_KEY')
const LAST_MESSAGE_MAX = assetNumber(/LAST_MESSAGE_MAX=(\d+)/, 'LAST_MESSAGE_MAX')
const BLANK_ROW_VISIBLE_MS = assetNumber(/BLANK_ROW_VISIBLE_MS=(\d+)/, 'BLANK_ROW_VISIBLE_MS')
const LIST_ROWS_MAX = assetNumber(/LIST_ROWS_MAX=(\d+)/, 'LIST_ROWS_MAX')
const WS_FLAGS_MAX = assetNumber(/WS_FLAGS_MAX=(\d+)/, 'WS_FLAGS_MAX')
const RECENT_WINDOW_MS = assetNumber(/RECENT_WINDOW_MS=(\d+)/, 'RECENT_WINDOW_MS')

const NAMES = [
  'esc', 'botStage', 'blankRowVisible', 'bootRangeCap', 'taskState', 'taskGlyph', 'pad2',
  'formatMessageClock', 'timeFor', 'titleFor', 'readOpenedMap', 'isSessionUnread',
  'isNoticeUnread', 'wsFlagOf', 'wsFlagClass', 'wsFlagRank', 'wsFlagsOf', 'wsFlagHtml',
  'wsRunning', 'wsGlyphOf', 'sessionModelLabel', 'readLastMessageMap', 'pruneLastMessageMap',
  'noteSessionMessageAt', 'lastMessageAtOf', 'lastMessageTimeOf', 'sortAtOf', 'pinRank',
  'wsHeadTimeAt', 'renderWorkspaces', 'tailTextOf', 'normalizeSelection', 'fieldText',
]

const sum = (sessionId, updatedAt = OLD) => ({
  sessionId, updatedAt, blank: false, projections: { values: { title: sessionId } },
})
const ROW_IDS = (html) => [...html.matchAll(/data-action="open" data-id="([^"]+)"/g)].map((m) => m[1])
function cardHtml(html, id) {
  const at = html.indexOf(`data-ws="${id}"`)
  assert.notEqual(at, -1, `card ${id} must be in the painted list`)
  return html.slice(html.lastIndexOf('<article', at), html.indexOf('</article>', at))
}

/** 真 renderWorkspaces + 真 ungroupedCards + 它们读的页面全局，喂 fixture 的 cards 与行表。 */
function paint({ workspaces, summaries, expanded = [] }) {
  const host = { innerHTML: '' }
  const body = NAMES.map((name) => extractFunction(js, name)).join('\n')
  const make = new Function('fixture', 'container', `
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
    const sessionSummaries=fixture.summaries
    let workspaces=fixture.workspaces
    const hiddenWsListed=false, hiddenWsSessionIds=[], archivedSessionIds=[]
    const expandedWsIds=new Set(fixture.expanded), revealedLists=new Map()
    const pinnedSessionIds=[], activeSession=null
    const pinBusy=new Set()
    let openedAtLedgerReady=true
    const $=()=>container
    const tailCache=new Map(),tailArmedAt={},tailPending=new Set()
    function requestVisibleTails(){}
    function requestTailBootRound(){}
    const store={}
    const localStorage={getItem:(key)=>store[key]||'{}',setItem:(key,value)=>{store[key]=String(value)}}
    ${extractFunction(js, 'unclaimedSessionIds')}
    ${extractFunction(js, 'ungroupedCards')}
    ${body}
    return { paint(){ renderWorkspaces(); return container.innerHTML } }
  `)
  return make({ workspaces, summaries, expanded }, host).paint()
}

// ---------------------------------------------------------------------------
// M4（tasks.md T4.1）：未分组桶首帧落地、默认折叠、卡头只留标题＋会话数量
// ---------------------------------------------------------------------------

test('M4 首帧：data-ws="" 未分组卡在、aria-expanded=false、.task-row 0、其余卡仍 true', () => {
  const workspaces = [
    { workspaceId: 'ws-a', title: '工作区 A', path: '/ws-a', sessionIds: ['w1'] },
    { ungrouped: true, sessionIds: ['o1', 'o2', 'o3', 'o4', 'o5'], title: '未分组', sessionTotal: 5 },
  ]
  const summaries = [sum('w1'), ...['o1', 'o2', 'o3', 'o4', 'o5'].map((id) => sum(id))]
  const html = paint({ workspaces, summaries, expanded: ['ws-a'] })

  assert.ok(html.includes('data-ws=""'), 'D1：首帧就有未分组卡')
  const un = cardHtml(html, '')
  assert.ok(un.includes('aria-expanded="false"'), 'D2：未分组卡首帧折叠')
  assert.ok(cardHtml(html, 'ws-a').includes('aria-expanded="true"'), 'D2：其余卡首帧仍展开')
  assert.equal((un.match(/class="task-row/g) || []).length, 0, 'D2：折叠态 .task-row 数为 0')
  assert.ok(!un.includes('data-action="new"'), 'D3：折叠态不画「+」按钮')
})

test('M4 折叠可见区：只标题＋一个数字 5（=sessionTotal，不画徽标/时间/旧值）', () => {
  const workspaces = [
    { workspaceId: 'ws-a', title: '工作区 A', path: '/ws-a', sessionIds: ['w1'] },
    { ungrouped: true, sessionIds: ['o1', 'o2', 'o3', 'o4', 'o5'], title: '未分组', sessionTotal: 5 },
  ]
  const summaries = [sum('w1'), ...['o1', 'o2', 'o3', 'o4', 'o5'].map((id) => sum(id))]
  const un = cardHtml(paint({ workspaces, summaries, expanded: ['ws-a'] }), '')

  assert.ok(un.includes('未分组'), 'D3：可见区含标题')
  assert.ok(un.includes('>5<'), 'D3：可见区含会话数量数字 5')
  assert.equal((un.match(/ws-last-time/g) || []).length, 1, 'D3：数字只此一格，不与时间/徽标并列')
  assert.ok(!un.includes('ws-flags') && !un.includes('ws-last is-'), 'D3：折叠态抑制其余 chip')
})

test('M4 toggle 一次：aria-expanded=true、真画 5 行、数字与真画量同源；再 toggle 回 false', () => {
  const workspaces = [
    { workspaceId: 'ws-a', title: '工作区 A', path: '/ws-a', sessionIds: ['w1'] },
    { ungrouped: true, sessionIds: ['o1', 'o2', 'o3', 'o4', 'o5'], title: '未分组', sessionTotal: 5 },
  ]
  // 展开态要真画 5 行：行必须在 bootRangeCap 的 24h 窗口内（OLD 会被裁到只留 1 行）。
  const summaries = [sum('w1'), ...['o1', 'o2', 'o3', 'o4', 'o5'].map((id) => sum(id, NOW))]

  const opened = cardHtml(paint({ workspaces, summaries, expanded: ['ws-a', ''] }), '')
  assert.ok(opened.includes('aria-expanded="true"'), 'D4：点开后展开')
  assert.deepEqual(ROW_IDS(opened), ['o1', 'o2', 'o3', 'o4', 'o5'], 'D3：点开真画 5 行')

  const closed = cardHtml(paint({ workspaces, summaries, expanded: ['ws-a'] }), '')
  assert.ok(closed.includes('aria-expanded="false"'), 'D4：再点回折叠')
  assert.equal((closed.match(/class="task-row/g) || []).length, 0, 'D4：折回后行数为 0')
})

test('M4 桥不下发 sessionTotal 时数字回落真画量（tasks.length），不先画 0 再跳值', () => {
  const workspaces = [
    { workspaceId: 'ws-a', title: '工作区 A', path: '/ws-a', sessionIds: ['w1'] },
    { ungrouped: true, sessionIds: ['o1', 'o2'], title: '未分组' },
  ]
  const summaries = [sum('w1'), sum('o1'), sum('o2')]
  const un = cardHtml(paint({ workspaces, summaries, expanded: ['ws-a'] }), '')

  assert.ok(un.includes('>2<'), 'D3：无 sessionTotal 时数字=真画行数 2')
})

// ---------------------------------------------------------------------------
// M5（tasks.md T4.2）：bootPreloadIds 三例——未分组/隐藏排除、正常保留、签名不变
// ---------------------------------------------------------------------------

test('M5 bootPreloadIds：未分组与隐藏工作区会话排除、正常会话保留、导出签名不变', () => {
  const now = Date.now()
  const fresh = (id, ageMs) => ({ sessionId: id, updatedAt: now - ageMs })
  const rows = [fresh('s-ungrouped', 1000), fresh('s-hidden', 2000), fresh('s-normal', 3000)]
  const input = {
    rows,
    pinnedIds: [],
    zones: {},
    ungroupedIds: ['s-ungrouped'],
    hiddenIds: ['s-hidden'],
    now,
    windowMs: DAY,
    cap: 10,
  }
  const got = bootPreloadIds(input)
  assert.deepEqual(got, ['s-normal'], '三例里只有正常会话保留，前两例仍排除')

  const src = readFileSync(new URL('../lib/pages.js', import.meta.url), 'utf8')
  assert.equal(src.includes('export function bootPreloadIds(input)'), true, '导出签名逐字不变')
  assert.match(bootPreloadIds.toString(), /^function bootPreloadIds\(input\) \{/, '运行态签名逐字不变')
})
