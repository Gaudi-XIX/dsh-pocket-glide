// change 2026-11-10-bugfix-pocket-ladder-and-hidden-restore 的 ③(a)(b)(c) + ④。
//
// 判据（intent.md:52 / :61, tasks.md T4.1-T4.3）：纯函数实跑，不改运行态；喂
// botStage(team,summaries,labels) 与渲染层两份模拟数据。被测对象是从
// mobilePageAssets().js 按大括号配平抽出的真 renderWorkspaces —— 本文件不重写
// 任何渲染/分支逻辑，替身只补 DOM 与网络器官。删掉页侧过滤、折叠入口或 cap 放行
// 任一处，下面的断言就会转红（反向变异）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets, botStage } from '../lib/pages.js'

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

const L = JSON.parse(js.match(/^const L=(\{.*\});/m)[1])
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
function paint({ workspaces, summaries, expanded = [], hiddenExpanded = false }) {
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
    if(fixture.hiddenExpanded)revealedLists.set('bot:other#hidden',1)
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
  return make({ workspaces, summaries, expanded, hiddenExpanded }, host).paint()
}

const team = (hiddenId = null) => ({
  mainBotIds: ['m1'],
  bots: [
    { id: 'm1', sessionId: 's-main', name: '主', hidden: false },
    { id: 'b1', sessionId: 's-a', name: 'A', hidden: hiddenId === 'b1' },
    { id: 'b2', sessionId: 's-b', name: 'B', hidden: hiddenId === 'b2' },
    { id: 'b3', sessionId: 's-c', name: 'C', hidden: hiddenId === 'b3' },
  ],
  rooms: [{ id: 'room-1', name: '群' }],
})
const teamSummaries = () => ['s-main', 's-a', 's-b', 's-c', 'room-1'].map((id) => sum(id))
const expandedBotCards = ['bot:main', 'bot:other', 'bot:room']

test('③(a) 全 hidden:false 且全超 24h：这些 BOT 全部出现在「其他 BOT」可见行', () => {
  const cards = botStage(team(), teamSummaries(), L)
  const other = cards.find((c) => c.botSection === 'other')
  assert.deepEqual(other.sessionIds, ['s-a', 's-b', 's-c'], '投影层先拿到三行')
  assert.deepEqual(other.hiddenBots, [], '没有隐藏成员 ⇒ 折叠入口不该有数据')

  const html = paint({ workspaces: cards, summaries: teamSummaries(), expanded: expandedBotCards })
  const otherHtml = cardHtml(html, 'bot:other')
  assert.deepEqual(ROW_IDS(otherHtml), ['s-a', 's-b', 's-c'],
    '删掉 cap 对 BOT 卡的放行，bootRangeCap 会把 24h 外的三行裁成「还留一个」')
  assert.ok(!otherHtml.includes('data-hidden-toggle'), '无隐藏成员不画折叠入口')
  assert.ok(!cardHtml(html, 'bot:main').includes('data-hidden-toggle'))
  assert.ok(!cardHtml(html, 'bot:room').includes('data-hidden-toggle'))
})

test('③(b) 仅一个 hidden:true：只有它折进「显示 1 个隐藏 BOT」，其余照常可见', () => {
  const cards = botStage(team('b2'), teamSummaries(), L)
  const other = cards.find((c) => c.botSection === 'other')
  assert.deepEqual(other.hiddenBots.map((b) => b.sessionId), ['s-b'], '隐藏成员只挂在 other 卡')
  assert.deepEqual(other.sessionIds, ['s-a', 's-c'], '隐藏 BOT 不占可见行')
  assert.deepEqual(cards.filter((c) => c.botSection !== 'other').flatMap((c) => c.hiddenBots), [])

  const html = paint({ workspaces: cards, summaries: teamSummaries(), expanded: expandedBotCards })
  const otherHtml = cardHtml(html, 'bot:other')
  assert.ok(otherHtml.includes('data-hidden-toggle="1"'), '卡底恢复折叠入口')
  assert.ok(otherHtml.includes('显示 1 个隐藏 BOT'), 'N=hidden===true 计数，不认时间窗')
  assert.deepEqual(ROW_IDS(otherHtml), ['s-a', 's-c'], '只有 s-b 被折进去')
  assert.ok(!cardHtml(html, 'bot:main').includes('data-hidden-toggle'))
  assert.ok(!cardHtml(html, 'bot:room').includes('data-hidden-toggle'))

  const opened = paint({ workspaces: cards, summaries: teamSummaries(), expanded: expandedBotCards, hiddenExpanded: true })
  const openedOther = cardHtml(opened, 'bot:other')
  assert.ok(ROW_IDS(openedOther).includes('s-b'), '展开态把隐藏 BOT 的行放回来')
  assert.ok(openedOther.includes('收起隐藏 BOT'), '同一按钮可收起')
})

test('③(c) 主 BOT 区与群聊区在两例都不出现折叠入口', () => {
  for (const hiddenId of [null, 'b2']) {
    const cards = botStage(team(hiddenId), teamSummaries(), L)
    const html = paint({ workspaces: cards, summaries: teamSummaries(), expanded: expandedBotCards })
    for (const section of ['bot:main', 'bot:room']) {
      assert.ok(!cardHtml(html, section).includes('data-hidden-toggle'),
        `hiddenId=${hiddenId}: ${section} 不许出现折叠入口`)
    }
    assert.equal((html.match(/data-hidden-toggle/g) || []).length, hiddenId ? 1 : 0,
      '整页至多一个折叠入口，且只在 other 卡')
  }
})

test('④ 未分组桶首帧落地但默认折叠（2026-11-11 单按 intent §3.1 反转 m00030 的「整卡不画」：卡要画、首帧折、数字随行）', () => {
  const workspaces = [{ workspaceId: 'ws-a', sessionIds: ['w1'], title: '工作区 A', path: '/ws-a' }]
  const summaries = [sum('w1'), sum('orphan')]
  const html = paint({ workspaces, summaries, expanded: ['ws-a'] })
  assert.ok(html.includes('data-ws="ws-a"'), '工作区卡照常画')
  assert.ok(html.includes('data-ws=""'), '未分组桶首帧落地（D1）')
  const un = cardHtml(html, '')
  assert.ok(un.includes('aria-expanded="false"'), 'D2：未分组卡首帧默认折叠')
  assert.equal((un.match(/class="task-row/g) || []).length, 0, 'D2：折叠态不画行')
  assert.ok(un.includes('未分组') && un.includes('>1<'), 'D3：卡头只留标题＋会话数量（桶内 1 行）')
  assert.equal((un.match(/ws-last-time/g) || []).length, 1, 'D3：数字只此一格')
})
