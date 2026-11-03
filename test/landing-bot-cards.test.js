// 落地页三张 BOT 前置卡的行为终点——把 change 2026-11-02-feature-pocket-page-refactor
// 的 AC2.2 / AC2.3 / AC3.2 / AC3.4 钉成可执行断言（tasks.md:98 / :100 / :131 / :135）。
//
// 为什么单开一个文件：实现线把 BOT 卡摊进了 `workspaces`（`botStage` 投影 + `renderWorkspaces`
// 同一份模板），但只留了实现、没有可执行判据——`grep -rn botStage test/` 命中 0。
// 「宿主真值优先」「读失败不画」「顺序恒定」「交互同一套」这四条恰恰是这次重构最容易被改坏的
// 地方（谁都能顺手把 `botStage(team).concat(workspaces)` 写成 `workspaces.concat(botStage(team))`）。
//
// 房规（与 test/list-bounds.test.js 的 paintList、test/message-blocks.test.js 的切片同款）：
// 被测对象是**出货壳里的真函数**——从 `mobilePageAssets()` 的 js 里按大括号配平抽出来，
// 连同它读的页面常量一起塞进 `new Function` 沙箱跑；本文件不重写任何一条渲染或分支逻辑，
// 替身只补 DOM 与网络器官（`$()`、`localStorage`、`requestVisibleTails` 之类）。
// L 表从壳里现取（asset 里那一行 `const L=…`），不硬编码任何中文文案。
//
// 本文件 test-only、0 壳字节（test/** 不进 page asset）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })

// ---------------------------------------------------------------- 切片原语

/** 从出货产物里按名字切一个函数（大括号配平）。重名即拒——否则抽到的是别人的桩。 */
function extractFunction(source, name) {
  const token = `function ${name}(`
  const hits = []
  let at = source.indexOf(token)
  while (at !== -1) {
    hits.push(at)
    at = source.indexOf(token, at + 1)
  }
  assert.notEqual(hits.length, 0, `${name} must exist in the rendered asset`)
  assert.equal(
    hits.length,
    1,
    `${name} is defined ${hits.length} times in the asset (at ${hits.join(', ')}): the extractor would silently take the FIRST one`,
  )
  const start = hits[0]
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

/** 切一个「`obj.prop = e => { … }`」形状的匿名箭头（`$('workspaces').onclick=`）。 */
function sliceArrow(source, marker) {
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, `${marker} must be present in the shipped landing page js`)
  let i = source.indexOf('=>', at)
  i = source.indexOf('{', i)
  let depth = 0
  let str = null
  for (; i < source.length; i += 1) {
    const ch = source[i]
    if (str) {
      if (ch === '\\') i += 1
      else if (ch === str) str = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(at + marker.length, i + 1)
    }
  }
  assert.fail(`unbalanced braces after ${marker}`)
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

// 页面自己的数字/Storage 键：也从壳里现取。常量消失或变身时沙箱拒绝跑，
// 而不是悄悄按别的值渲染（同一套口径见 test/list-bounds.test.js:131-140）。
const UNREAD_OPEN_KEY = assetString(/UNREAD_OPEN_KEY='([^']+)'/, 'UNREAD_OPEN_KEY')
const LAST_MESSAGE_KEY = assetString(/LAST_MESSAGE_KEY='([^']+)'/, 'LAST_MESSAGE_KEY')
const UNREAD_RECENCY_MS = assetNumber(/UNREAD_RECENCY_MS=(\d+)/, 'UNREAD_RECENCY_MS')
const LAST_MESSAGE_MAX = assetNumber(/LAST_MESSAGE_MAX=(\d+)/, 'LAST_MESSAGE_MAX')
const BLANK_ROW_VISIBLE_MS = assetNumber(/BLANK_ROW_VISIBLE_MS=(\d+)/, 'BLANK_ROW_VISIBLE_MS')
const LIST_ROWS_MAX = assetNumber(/LIST_ROWS_MAX=(\d+)/, 'LIST_ROWS_MAX')
const WS_FLAGS_MAX = assetNumber(/WS_FLAGS_MAX=(\d+)/, 'WS_FLAGS_MAX')
const RECENT_WINDOW_MS = assetNumber(/RECENT_WINDOW_MS=(\d+)/, 'RECENT_WINDOW_MS')

// 页面自己的 L 表：现取，不照抄文案（改文案不该改红这个文件）。
const L = JSON.parse(js.match(/^const L=(\{.*\});/m)[1])
for (const key of ['mainBot', 'otherBots', 'rooms', 'tagMain', 'tagNoModel', 'emptySection']) {
  assert.equal(typeof L[key], 'string', `L.${key} 必须仍在壳里（botStage 的段标题/小标签取这几个键）`)
}
const MORE_ROWS = assetNumber(/MORE_ROWS=(\d+)/, 'MORE_ROWS')

// ---------------------------------------------------------------- 真 botStage

const BOT_STAGE = new Function(`${extractFunction(js, 'botStage')}\nreturn botStage`)()
// 生产那一句拼装（lib/pages.js:2246）：从壳里**取出来执行**，不照抄一份。
// 抄一份等于把「BOT 卡排在前面」这条判据钉在测试自己身上——实现把 concat 换向它照样绿。
// 取法故意宽（只要是 `workspaces=<…botStage…>;` 这一句就取），因为**顺序由渲染结果判**，
// 不由字符串长相判：换向的实现在这里照样被取出来跑，然后被下面的卡序断言抓住。
const CONCAT_STMT = (js.match(/workspaces=[^;]*botStage[^;]*;/) || [null])[0]

// ---------------------------------------------------------------- 夹具

const MINUTE = 60 * 1000
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()
const ago = (ms) => NOW - ms
/** 会话行＝lib/projections.js 交给列表的形状；blank:false = 有内容的会话。 */
const sum = (sessionId, updatedAt, title) => ({
  sessionId,
  updatedAt,
  blank: false,
  projections: { values: { title } },
})
/** 一张工作区卡（`botStage` 只管 BOT 那三张，工作区卡由页面原有那条路供）。 */
const wsCard = (workspaceId, sessionIds, title) => ({ workspaceId, sessionIds, title, path: `/${workspaceId}` })

const CARD_IDS = (html) => [...html.matchAll(/data-ws="([^"]+)"/g)].map((m) => m[1])
const ROW_IDS = (html) => [...html.matchAll(/data-action="open" data-id="([^"]+)"/g)].map((m) => m[1])
/** 取一张卡的 markup 片段（按 document order 切 article）。 */
function cardHtml(html, id) {
  const at = html.indexOf(`data-ws="${id}"`)
  assert.notEqual(at, -1, `card ${id} must be in the painted list`)
  return html.slice(html.lastIndexOf('<article', at), html.indexOf('</article>', at))
}

// ---------------------------------------------------------------------------
// 主页列表沙箱：真 renderWorkspaces + 真 botStage + 它们读的页面全局
// ---------------------------------------------------------------------------
// Mirrors test/list-bounds.test.js:167 paintList（「renderWorkspaces 会伸手要的每一个函数」
// 是那边验证过的集合）。唯一的不同：这里的 `workspaces` 由**生产那一行**拼出来——
// lib/pages.js:2246 `workspaces=botStage(teamState,sessionSummaries,L).concat(workspaces)`。
function paintLanding({ team, workspaces: baseCards, summaries, expanded = [] }) {
  const host = { innerHTML: '' }
  const names = [
    'esc', 'botStage',
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
    const sessionSummaries=fixture.summaries
    const teamState=fixture.team
    let workspaces=fixture.workspaces
    ${CONCAT_STMT || `throw new Error('AC3.2: 落地页 boot 里找不到 workspaces=<…botStage…>; 这句拼装')`}
    const expandedWsIds=new Set(fixture.expanded), revealedLists=new Map()
    const pinnedSessionIds=[], activeSession=null
    const pinBusy=new Set()
    let openedAtLedgerReady=true
    const $=()=>container
    // 尾包预取是网络器官：空缓存 + no-op 拉取正是「没预取到任何东西」的落地态。
    const tailCache=new Map(),tailArmedAt={},tailPending=new Set()
    function requestVisibleTails(){}
    function requestTailBootRound(){}
    // 未分组桶由 ungroupedCards() 定义；本文件只管 BOT 卡与工作区卡，那一桶有自己的文件
    // （test/ungrouped-heading.test.js 抽的是真函数）。
    function ungroupedCards(){return workspaces}
    const store={}
    const localStorage={getItem:(key)=>store[key]||'{}',setItem:(key,value)=>{store[key]=String(value)}}
    ${body}
    return { paint(){ renderWorkspaces(); return container.innerHTML } }
  `,
  )
  const page = make({ team, workspaces: baseCards, summaries, expanded }, host)
  return page.paint()
}

// ---------------------------------------------------------------------------
// AC2.2 宿主真值优先
// ---------------------------------------------------------------------------

test('AC2.2：同一 sessionId 同时在 session.list 与 bot.team 时，行取 session.list 的真值（bot.team 不覆盖）', () => {
  const summaries = [
    { sessionId: 'b1', updatedAt: 111, blank: false, error: true, projections: { values: { title: '宿主标题' } } },
    sum('w1', 5, '工作区里的会话'),
  ]
  const team = {
    mainBotIds: ['b1'],
    bots: [
      // 同一个 sessionId：bot.team 带一个明显更「新」的 updatedAt 和另一个名字。
      { id: 'b1', sessionId: 'b1', name: 'bot.team 的名字', model: 'deepseek/chat', updatedAt: 999999, working: true },
      // 不在行表里的 id 才是补缺对象。
      { id: 'b2', sessionId: 's-new', name: '只有 bot.team 知道的会话', updatedAt: 777 },
    ],
    rooms: [{ id: 'room-1', name: '设计群', updatedAt: 888888 }],
  }
  const before = summaries.length
  const cards = BOT_STAGE(team, summaries, L)

  const b1 = summaries.find((r) => r.sessionId === 'b1')
  assert.equal(b1.updatedAt, 111, 'AC2.2 在表里的行必须保住宿主真值 111，不许被 bot.team 的 999999 覆盖')
  assert.equal(b1.error, true, 'AC2.2 邻字段也不覆盖：error 仍是宿主那一份')
  assert.equal(b1.projections.values.title, '宿主标题', '已有标题不被 bot.team 的名字改写')
  assert.equal(b1.botTag, L.tagMain, 'botTag 是页面自己的装饰（主 BOT 的行带「主」）')
  assert.equal(b1.running, true, 'bot.team 说它在工作 ⇒ 补上 running（这一格页面才有资格写）')

  const fresh = summaries.find((r) => r.sessionId === 's-new')
  assert.ok(fresh, 'AC2.2 反向：不在行表里的 bot.sessionId 必须追加补缺行')
  assert.equal(fresh.updatedAt, 0, 'AC2.2 补缺行的 updatedAt 是 0——bot.team 的 777 不是宿主真值，不许冒充')
  assert.equal(summaries.length, before + 2, 'AC2.2 只补缺：新增的恰好是 s-new 与 room-1 两行')
  assert.deepEqual(
    summaries.slice(before).map((r) => r.sessionId),
    ['s-new', 'room-1'],
    'AC2.2 追加的是「不在行表里」的那两个 id，且在表里的 b1 没有被重复插入',
  )
  assert.equal(fresh.projections.values.title, '只有 bot.team 知道的会话', '补缺行带上 bot 名字（它自己没有标题）')

  const room = summaries.find((r) => r.sessionId === 'room-1')
  assert.equal(room.updatedAt, 0, 'AC2.2 群同理：没有 session.list 行时 updatedAt 是 0，不是 team 的 888888')
  assert.deepEqual(cards.map((c) => c.botSection), ['main', 'other', 'room'], 'AC2.2 三个段都成卡')
})

// ---------------------------------------------------------------------------
// AC2.3 读失败不画 BOT 卡
// ---------------------------------------------------------------------------

test('AC2.3：bot.team 读失败时三张 BOT 卡一张不画，工作区卡与行照常画', () => {
  // 第一段：投影层的契约。四种「没有可用 team」的取值都必须零卡、零伪造行。
  for (const bad of [null, undefined, 'nope', { ok: false }]) {
    const summaries = [sum('w1', ago(MINUTE), '工作区里的会话')]
    const snapshot = JSON.stringify(summaries)
    const cards = BOT_STAGE(bad, summaries, L)
    assert.deepEqual(cards, [], `team=${JSON.stringify(bad)} 必须零卡（不伪造 0 条会话的 BOT 卡）`)
    assert.equal(JSON.stringify(summaries), snapshot, `team=${JSON.stringify(bad)} 不得往行表里塞任何行`)
  }

  // 第二段：渲染结果。`{ok:false}` 正是假宿主让 /api/bot 回的那个形状——页面侧
  // （lib/pages.js:2246 `b.team && typeof b.team === 'object'`）把它当对象收下，落到
  // botStage 的空段路径 ⇒ 零卡；工作区卡与它的行必须原样还在。
  const summaries = [sum('w1', ago(MINUTE), '工作区里的会话')]
  const html = paintLanding({
    team: { ok: false },
    workspaces: [wsCard('ws-a', ['w1'], '工作区 A')],
    summaries,
    expanded: ['ws-a'],
  })
  assert.deepEqual(CARD_IDS(html), ['ws-a'], 'AC2.3 只剩工作区卡，没有任何 bot: 卡')
  assert.deepEqual(ROW_IDS(html), ['w1'], 'AC2.3 工作区卡的行照常画')
  assert.ok(!html.includes('data-ws="bot:'), 'AC2.3 三张 BOT 卡一张都不许出现')
})

// ---------------------------------------------------------------------------
// AC3.2 顺序不变量
// ---------------------------------------------------------------------------

test('AC3.2：卡片顺序恒为 [主 BOT, 其他 BOT, 群, …各工作区…]', () => {
  // 沙箱里执行的就是生产那一句（不是复刻件）；它被改名或搬走就必须在这里现形。
  assert.ok(
    CONCAT_STMT,
    'AC3.2 lib/pages.js:2246 的拼装式必须仍存在（`workspaces=<…botStage…>;`）——本文件的沙箱执行的就是它',
  )

  const team = {
    mainBotIds: ['b-main'],
    bots: [
      { id: 'b-main', sessionId: 's-main', name: '主 BOT' },
      { id: 'b-other', sessionId: 's-other', name: '其他 BOT', role: 'editor' },
      { id: 'b-hidden', sessionId: 's-hidden', name: '折叠掉的', hidden: true },
    ],
    rooms: [{ id: 'room-1', name: '设计群' }],
  }
  const html = paintLanding({
    team,
    workspaces: [wsCard('ws-a', ['w1'], '工作区 A'), wsCard('ws-b', ['w2'], '工作区 B')],
    summaries: [
      sum('s-main', ago(2 * MINUTE), 'BOT 私聊'),
      sum('s-other', ago(3 * MINUTE), '另一个 BOT'),
      sum('room-1', ago(4 * MINUTE), '群'),
      sum('w1', ago(5 * MINUTE), 'a1'),
      sum('w2', ago(6 * MINUTE), 'b1'),
    ],
    expanded: ['bot:main', 'bot:other', 'bot:room', 'ws-a', 'ws-b'],
  })

  assert.deepEqual(
    CARD_IDS(html),
    ['bot:main', 'bot:other', 'bot:room', 'ws-a', 'ws-b'],
    'AC3.2 顺序必须是 主 BOT → 其他 BOT → 群 → 各工作区（读 #workspaces 里 article.ws-card 的 document order）',
  )
  assert.deepEqual(ROW_IDS(cardHtml(html, 'bot:main')), ['s-main'], 'AC3.2 主 BOT 卡只装它自己那一行')
  assert.deepEqual(ROW_IDS(cardHtml(html, 'bot:other')), ['s-other'], 'AC3.2 其他 BOT 段')
  assert.deepEqual(ROW_IDS(cardHtml(html, 'bot:room')), ['room-1'], 'AC3.2 群段的行以群 id 为会话 id')
  assert.ok(
    !ROW_IDS(html).includes('s-hidden'),
    'AC3.2 bot.hidden===true 的折叠语义照旧：那行不进任何卡（若进了，bot:main 就会有两行）',
  )
})

// ---------------------------------------------------------------------------
// AC3.4 交互同一套
// ---------------------------------------------------------------------------

/** 只记录效果的 handler 沙箱：真 `$('workspaces').onclick` 箭头 + 各分支的替身。 */
function clickEffects() {
  const state = { effects: [], expanded: new Set(), revealed: new Map() }
  const make = new Function(
    'state',
    `
    const MORE_ROWS=${MORE_ROWS}
    const effects=state.effects, expandedWsIds=state.expanded, revealedLists=state.revealed
    const startDraftChat=(id)=>effects.push('new:'+id)
    const renderWorkspaces=()=>effects.push('render')
    const togglePin=(id)=>effects.push('pin:'+id)
    const openSession=(id)=>effects.push('open:'+id)
    const onWorkspacesClick=(${sliceArrow(js, "$('workspaces').onclick=")})
    return (action, wsId, dataset, rows) => {
      const cardEl={ dataset:{ ws:wsId }, querySelectorAll:(sel)=>(sel==='.task-row'?Array.from({length:rows},()=>({})):[]) }
      const btn={ dataset:Object.assign({ action:action },dataset) }
      onWorkspacesClick({
        target:{ closest:(sel)=>(sel==='.ws-card'?cardEl:sel==='button[data-action]'?btn:null) },
        stopPropagation:()=>{},
      })
    }
    `,
  )
  return { ...state, click: make(state) }
}

test('AC3.4：BOT 卡的 toggle/more/pin 与工作区卡走同一套选择器与同一条分支', () => {
  const stale = (id, days) => sum(id, ago(days * DAY), id) // 全在 24h 窗外 ⇒ 窗内只剩地板 1 行，「更多」必然出现

  // 第一段：markup 面。真 renderWorkspaces 画出来的两类卡都得带同一组
  // `.ws-toggle` / `.task-pin` / `.older-row` 选择器与同一组 data-action 值。
  const html = paintLanding({
    team: {
      mainBotIds: ['b-main'],
      bots: [
        { id: 'b-main', sessionId: 's-main', name: '主 BOT' },
        // 「其他 BOT」段放两个 bot：BOT 卡的一行＝一个 bot 的一个会话，所以只有
        // 多 bot 的段才会出现「更多」（单行卡没有「更多」可点，那是对的）。
        { id: 'b-o1', sessionId: 's-o1', name: '其他 BOT 一' },
        { id: 'b-o2', sessionId: 's-o2', name: '其他 BOT 二' },
      ],
      rooms: [],
    },
    workspaces: [wsCard('ws-a', ['w1', 'w2', 'w3'], '工作区 A')],
    summaries: [stale('s-main', 3), stale('s-o1', 3), stale('s-o2', 4), stale('w1', 3), stale('w2', 4), stale('w3', 5)],
    expanded: ['bot:other', 'ws-a'],
  })
  assert.deepEqual(
    CARD_IDS(html),
    ['bot:main', 'bot:other', 'bot:room', 'ws-a'],
    'AC3.4 相关卡都在（群段为空也画一张群聊卡：用户 m00236② 看不到群分组）',
  )
  // 判据 C4：真读成立就推三段卡；空段不是「不画」，而是一张带空态行的卡。
  assert.ok(
    cardHtml(html, 'bot:room').includes('data-empty-section="room"'),
    'AC3.4 空群段画的是带空态钩子的群聊卡，不是一个静默的缺席',
  )
  assert.ok(
    cardHtml(html, 'bot:room').includes(L.rooms + L.emptySection.replace('{name}', '')),
    'AC3.4 空态行文案取 L.emptySection、段名取该卡标题',
  )
  assert.deepEqual(ROW_IDS(cardHtml(html, 'bot:other')), ['s-o1'], 'AC3.4 其他 BOT 段真画两行时窗内只显 1 行')
  assert.deepEqual(ROW_IDS(cardHtml(html, 'ws-a')), ['w1'], 'AC3.4 工作区卡同一把尺：窗内 1 行、其余在「更多」后')
  for (const id of ['bot:other', 'ws-a']) {
    const card = cardHtml(html, id)
    assert.ok(card.includes('class="ws-toggle" data-action="toggle"'), `${id} 的 toggle 与工作区卡同形`)
    assert.ok(card.includes('data-action="pin" data-pin="'), `${id} 的 pin 与工作区卡同形`)
    assert.ok(card.includes('class="older-row" data-action="more"'), `${id} 的「更多」与工作区卡同形`)
  }
  assert.ok(!cardHtml(html, 'bot:main').includes('ws-new'), 'AC3.4 BOT 卡不画「+」（那颗只对工作区有意义）')
  assert.ok(cardHtml(html, 'ws-a').includes('class="ws-new"'), 'AC3.4 工作区卡照旧画「+」')

  // 第二段：行为面。两条通道各点同一组动作，记录到的效果必须同形——
  // 「同一套交互」这句判据说的就是这个。行数从上面真画出来的卡里读，
  // 不是拍一个常数，于是 markup 面与行为面锁在同一个读数上。
  const rowsIn = (id) => ROW_IDS(cardHtml(html, id)).length
  const drive = (wsId) => {
    const rows = rowsIn(wsId)
    const s = clickEffects()
    s.click('toggle', wsId, {}, rows)
    const afterFirstToggle = s.expanded.has(wsId)
    s.click('toggle', wsId, {}, rows)
    const expandedAfterTwice = s.expanded.has(wsId)
    s.click('more', wsId, {}, rows)
    const revealedAfterMore = s.revealed.get(wsId)
    s.click('pin', wsId, { pin: `${wsId}::row` }, rows)
    const revealedAfterPin = s.revealed.get(wsId)
    return {
      rows,
      branchNames: s.effects.map((e) => e.split(':')[0]),
      effects: s.effects,
      afterFirstToggle,
      expandedAfterTwice,
      revealedAfterMore,
      revealedAfterPin,
    }
  }

  const bot = drive('bot:other')
  const ws = drive('ws-a')
  assert.deepEqual(
    bot.effects,
    ['render', 'render', 'render', 'pin:bot:other::row'],
    'AC3.4 分支真的走到了：两次 toggle + 一次 more 各重画一次列表，pin 只把 id 交出去、不重画',
  )
  assert.deepEqual(ws.effects, ['render', 'render', 'render', 'pin:ws-a::row'], 'AC3.4 工作区卡同一串')
  assert.deepEqual(bot.branchNames, ws.branchNames, 'AC3.4 两条通道走的分支序列相同')
  assert.deepEqual(
    { a: bot.afterFirstToggle, b: bot.expandedAfterTwice, c: bot.revealedAfterMore, d: bot.revealedAfterPin },
    { a: ws.afterFirstToggle, b: ws.expandedAfterTwice, c: ws.revealedAfterMore, d: ws.revealedAfterPin },
    'AC3.4 两类卡的状态迁移逐字相同（展开→收起、「更多」加行、pin 不动已披露行数）',
  )
  assert.equal(bot.afterFirstToggle, true, 'AC3.4 toggle 第一次展开')
  assert.equal(bot.expandedAfterTwice, false, 'AC3.4 toggle 第二次收起')
  assert.equal(bot.revealedAfterMore, bot.rows + MORE_ROWS, 'AC3.4 「更多」把已披露行数加上 MORE_ROWS')
  assert.equal(bot.revealedAfterMore, ws.revealedAfterMore, 'AC3.4 两类卡的「更多」加同一个量')
  assert.equal(bot.revealedAfterPin, bot.rows + MORE_ROWS, 'AC3.4 pin 不覆盖已披露行数')
})