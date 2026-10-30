// BOT→Pocket 过渡卡「读取会话列表」的数（用户 2026-10-30 第 8 条：
// 「bot切换到pocket的时候,会话数量显示有误」）。
//
// 用户看到的那个数来自 `pageWarmSummary('landing').rows`（BOT 侧 `lib/bot-page.js` 的
// `printCounts` 把它写进卡片第 1 格）。修之前它读的是 `_sessionListValue` 里那份**未过滤的
// 原件**——Host `session/list` 的全量行（本机注释自认 469 行 / ~195 KB 量级），而主页真正画
// 出来的只有其中「本工作区 + 置顶或 24 小时内」的那几十行。两侧不同源，量级差一个数量级。
//
// 现在的口径（判据 2，落点固定在 `pageWarmSummary` 的 landing 分支）：与 boot 交给页面的那份
// 同一套现成过滤——`withoutWorkspaceRows` + `bootVisibleRows`，调用侧先剔掉页面永不画的两类行
// （隐藏工作区的成员、`origin === 'subagent'` 的行）。两个公共函数本体一个分支都没加（第 7 条
// 用例拿 e46e979 的原文对比钉死）；也没有偏移量、没有 clamp（第 6 条用例）。
//
// 残差按判据 `.agents/docs/ui-unify-pocket-bot-20261030.md:300-321` 的三分类处置：
//   ① `blankRowVisible`（陈旧空白行）——**已闭合**：它和 `BLANK_ROW_VISIBLE_MS` 都是
//      `lib/pages.js` 的既有导出（`:201` / `:291`），桥侧 import 后直接调，零复制、不动
//      `lib/pages.js`。闭合用例见下面「陈旧空白行」与「地板」两条。
//   ② `lastMessageAtOf`（排序优先读手机 localStorage 的 `lastMessageAt`）——**登记，不可闭合**：
//      桥是服务端，读不到手机 localStorage。它经 `sortAtOf` 影响 24h 判定边界，是真计数残差。
//      闭合用例见「跨窗口」一条：`updatedAt` 与 `lastMessageAt` 同侧时两侧一致，差异为 0。
//   ③ `mergeBotParts`（同一 Bot 多 part 折叠）——**本轮不闭合，登记为下一批单**：折叠逻辑住在
//      页面投影里，注入要动 `lib/pages.js` 的导出/注入机制（属批次 A 写域）。方向固定为
//      **A ≥ B**（桥不折叠 → 多算）。留差用例见「多 part」一条，差异逐条可指认。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LanMobileBridge } from '../lib/bridge.js'
import { mobilePageAssets } from '../lib/pages.js'
import { preFixBaseline } from './helpers/pre-fix-baseline.mjs'

const DAY_MS = 86_400_000
// 固定时钟：24 小时窗口与 5 分钟新鲜度的边界都必须是确定值，不能跟着跑测试的时刻漂。
const NOW = 1_764_000_000_000
const RECENT = NOW - 60_000
const OLD = NOW - 10 * DAY_MS

const rowOf = (sessionId, at = NOW, extra = {}) => ({ sessionId, updatedAt: at, ...extra })

function makeBridge({ rows = [], items = [], pinnedSessionIds, hidden = 'w-bot', now = NOW } = {}) {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.log = () => {}
  bridge.now = () => now
  bridge._sessionListValue = { at: now, result: { ok: true, value: { items: rows } } }
  bridge.workspaceSnapshot = pinnedSessionIds ? { items, pinnedSessionIds } : { items }
  if (hidden !== null) bridge.botWorkspaceCache = { at: now, id: hidden }
  return bridge
}

// ---------------------------------------------------------------------------
// 页面侧镜像：真 `renderWorkspaces` + 它读的页面全局
// ---------------------------------------------------------------------------
// 判据 1 是 `A === B`：A 是桥的 `pageWarmSummary('landing').rows`，B 是主页真正画出来的
// `.task-row` 行数（`.agents/docs/ui-unify-pocket-bot-20261030.md:283-285`）。没有真机也要能
// 验 A 与 B，所以这里把**页面的渲染器本体**从构建产物里抽出来跑：一个函数都不是重写的。
//
// 抽取器同 `test/list-bounds.test.js:90-114`（brace-match + 重名 fail-loud）：`indexOf` 只命中
// 第一个同名定义，真函数前面若插一个同名 stub，本文件会静默测到假函数仍 GREEN——所以发现多个
// 同名定义时直接在抽取点抛错。
const js = mobilePageAssets({ locale: 'zh' }).js

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
    hits.length, 1,
    `${name} is defined ${hits.length} times in the asset (at ${hits.join(', ')}): the extractor would silently measure the FIRST one`,
  )
  const start = hits[0]
  // 参数列表先走完再数花括号：`unclaimedSessionIds(summaries, workspaces, options = {})`
  // 的默认值里就有 `{`，直接从 `{` 起数会在签名中间截断，抽出半截函数体。
  let i = source.indexOf('(', start)
  let paren = 0
  for (; i < source.length; i += 1) {
    if (source[i] === '(') paren += 1
    else if (source[i] === ')') {
      paren -= 1
      if (paren === 0) break
    }
  }
  let depth = 0
  for (let j = i; j < source.length; j += 1) {
    const char = source[j]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, j + 1)
    }
  }
  throw new Error(`unbalanced braces after ${name}`)
}

// 页面的常量从构建产物里抓，不手抄：常量若消失或变成非数字，本文件拒绝运行，而不是
// 静默测到另一个页面。
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

const L = js.match(/^const L=(\{.*\});/m)[1]
const UNREAD_OPEN_KEY = assetString(/UNREAD_OPEN_KEY='([^']+)'/, 'UNREAD_OPEN_KEY')
const LAST_MESSAGE_KEY = assetString(/LAST_MESSAGE_KEY='([^']+)'/, 'LAST_MESSAGE_KEY')
const UNREAD_RECENCY_MS = assetNumber(/UNREAD_RECENCY_MS=(\d+)/, 'UNREAD_RECENCY_MS')
const LAST_MESSAGE_MAX = assetNumber(/LAST_MESSAGE_MAX=(\d+)/, 'LAST_MESSAGE_MAX')
const BLANK_ROW_VISIBLE_MS = assetNumber(/BLANK_ROW_VISIBLE_MS=(\d+)/, 'BLANK_ROW_VISIBLE_MS')
const LIST_ROWS_MAX = assetNumber(/LIST_ROWS_MAX=(\d+)/, 'LIST_ROWS_MAX')
const WS_FLAGS_MAX = assetNumber(/WS_FLAGS_MAX=(\d+)/, 'WS_FLAGS_MAX')
const RECENT_WINDOW_MS = assetNumber(/RECENT_WINDOW_MS=(\d+)/, 'RECENT_WINDOW_MS')
const MORE_ROWS = assetNumber(/MORE_ROWS=(\d+)/, 'MORE_ROWS')
const TURN_RUNNING_IDLE_MAX_MS = assetNumber(/TURN_RUNNING_IDLE_MAX_MS=(\d+)/, 'TURN_RUNNING_IDLE_MAX_MS')
const SEND_TRUST_MS = assetNumber(/SEND_TRUST_MS=(\d+)/, 'SEND_TRUST_MS')
// 这个常量是正则字面量，`[^;]+` 会跨行吞掉后面整段函数体（实测），故只取到行尾。
const MERGE_LEGACY_FOLDER = js.match(/const MERGE_LEGACY_FOLDER=(\/[^\n]+\/)\n/)[1]

// `renderWorkspaces` 的整条依赖链，逐个从 asset 抽。名字与 `test/list-bounds.test.js:170-176`
// 的那份同源，另加折叠/投影三个（`mergeBotParts`/`visibleSessions`/`projectSessionRows`）——
// 判据 1 的 B 是**投影之后**的行数，少了这三个就测的不是主页。
const PAGE_NAMES = [
  'blankRowVisible', 'bootRangeCap', 'taskState', 'taskGlyph', 'pad2', 'formatMessageClock',
  'timeFor', 'titleFor', 'readOpenedMap', 'isSessionUnread', 'isNoticeUnread',
  'wsFlagOf', 'wsFlagClass', 'wsFlagRank', 'wsFlagsOf', 'wsFlagHtml', 'wsRunning', 'wsGlyphOf',
  'sessionModelLabel', 'readLastMessageMap', 'pruneLastMessageMap', 'noteSessionMessageAt',
  'lastMessageAtOf', 'lastMessageTimeOf', 'sortAtOf', 'pinRank', 'wsHeadTimeAt', 'renderWorkspaces',
  'tailTextOf', 'normalizeSelection', 'fieldText', 'esc',
  'mergeBotParts', 'visibleSessions', 'projectSessionRows', 'applyRunningMarks', 'ungroupedCards',
  // 归属的唯一算法：`ungroupedCards` 与桥侧 `pageWarmSummary` 读的是同一个纯函数
  // （判据 2：不许第二份过滤，收进公共函数）。少它，页面沙箱会 ReferenceError。
  'unclaimedSessionIds',
]

// 变量声明顺序照抄 asset：`projectSessionRows` 读 `pendingSendAt`/`pendingSend`/`activeSession`，
// `readLastMessageMap` 读 `lastMessageAt`——把这些放到 `sessionSummaries` 之后就是 TDZ 崩溃
// （实测 `Cannot access 'pendingSendAt' before initialization`）。
const PAGE_PRELUDE = [
  `const L=${L}`,
  `const UNREAD_OPEN_KEY=${JSON.stringify(UNREAD_OPEN_KEY)}`,
  `const UNREAD_RECENCY_MS=${UNREAD_RECENCY_MS}`,
  `const LAST_MESSAGE_KEY=${JSON.stringify(LAST_MESSAGE_KEY)}`,
  `const LAST_MESSAGE_MAX=${LAST_MESSAGE_MAX}`,
  `const BLANK_ROW_VISIBLE_MS=${BLANK_ROW_VISIBLE_MS}`,
  `const LIST_ROWS_MAX=${LIST_ROWS_MAX}`,
  `const WS_FLAGS_MAX=${WS_FLAGS_MAX}`,
  `const RECENT_WINDOW_MS=${RECENT_WINDOW_MS}`,
  `const MORE_ROWS=${MORE_ROWS}`,
  `const TURN_RUNNING_IDLE_MAX_MS=${TURN_RUNNING_IDLE_MAX_MS}`,
  `const SEND_TRUST_MS=${SEND_TRUST_MS}`,
  `const MERGE_LEGACY_FOLDER=${MERGE_LEGACY_FOLDER}`,
].join('\n')

const PAGE_BODY = PAGE_NAMES.map((name) => extractFunction(js, name)).join('\n')

const PAGE_TRAILER = [
  'const workspaces=fixture.workspaces',
  'const archivedSessionIds=[]',
  'const hiddenWsSessionIds=[]',
  'const hiddenWsListed=false',
  'const pinnedSessionIds=fixture.pinned',
  'const activeSession=null',
  'const pinBusy=new Set()',
  'const pendingSendAt=new Map()',
  'const pendingSend=new Map()',
  'let lastMessageAt={}',
  'let openedAtLedgerReady=true',
  'const sessionSummaries=projectSessionRows(fixture.rows)',
  // 判据读的是「展开全部工作区后」的行数（`.agents/docs/ui-unify-pocket-bot-20261030.md:284`），
  // 所以每张卡都算展开——未分组那一桶的 key 是空串，一并放进集合。
  "const expandedWsIds=new Set(fixture.workspaces.map((w)=>w.ungrouped?'':String(w.workspaceId??'')).concat(['']))",
  'const revealedLists=new Map()',
  'const $=()=>container',
  'const tailCache=new Map(),tailArmedAt={},tailPending=new Set()',
  // 尾巴预取是网络器官：空缓存 + 空转，就是「首页什么都没预取」的状态。
  'function requestVisibleTails(){}',
  'function requestTailBootRound(){}',
  'const store={}',
  "const localStorage={getItem:(key)=>store[key]||'{}',setItem:(key,value)=>{store[key]=String(value)}}",
  'return { paint(){ renderWorkspaces(); return container.innerHTML } }',
].join('\n')

// `Date` 走参数注入而不是读全局：页面读 `Date.now()`（`blankRowVisible` 的 5 分钟窗、
// `bootRangeCap` 的 24h 窗），桥读 `bridge.now()`。两侧必须同一个时刻，否则测的就不是同一瞬间
// 的两个数。注入一个只钉 `now()` 的子类，`new Date(stamp)` 仍然照常工作。
function paintLanding({ workspaces, rows, pinned = [], at = NOW }) {
  const host = { innerHTML: '' }
  const FakeDate = class extends Date {
    static now() {
      return at
    }
  }
  const make = new Function('fixture', 'container', 'Date', [PAGE_PRELUDE, PAGE_BODY, PAGE_TRAILER].join('\n'))
  const page = make({ workspaces, rows, pinned }, host, FakeDate)
  return page.paint()
}

// 判据 B 的读法：主页真正画出来的会话行。
const taskRows = (html) => (html.match(/<button class="task-row/g) || []).length

const day = (n) => NOW - n * DAY_MS
const minute = (n) => NOW - n * 60_000

// ---------------------------------------------------------------------------
// 判据 1：A === B（±0）
// ---------------------------------------------------------------------------
test('A === B: the card and the landing paint the same number of rows, read three times in a row', () => {
  // 判据 `.agents/docs/ui-unify-pocket-bot-20261030.md:317` 要求**必须**有这个用例：
  // 单 part、无陈旧空白行、所有行都不跨 24h 窗口边界 ⇒ `A === B` 精确相等，连采 3 次都相等。
  const rows = [
    rowOf('s-1', minute(50)), rowOf('s-2', minute(30)), rowOf('s-3', minute(10)),
    rowOf('s-4', day(3)), rowOf('s-5', day(9)),
  ]
  const items = [{ workspaceId: 'w-a', sessionIds: rows.map((row) => row.sessionId) }]
  const three = [1, 2, 3].map(() => {
    const A = makeBridge({ rows, items }).pageWarmSummary('landing').rows
    const B = taskRows(paintLanding({ workspaces: items, rows }))
    assert.equal(A, B, 'the card must report exactly the rows the landing paints (A === B, ±0)')
    return { A, B }
  })
  assert.deepEqual(three, [{ A: 3, B: 3 }, { A: 3, B: 3 }, { A: 3, B: 3 }],
    '3 rows are inside the 24h window; the two 3/9-day-old rows are behind the window edge on both sides')
  // 判据 `:286` 要的那个差值：修前读的是原件（5 行），页面只画 3 行。量级差就是用户看到的错。
  assert.notEqual(rows.length, three[0].A, 'the raw list (5) is not the number the page paints (3)')
})

test('the card reports the rows the landing will paint, not the raw list it was read from', () => {
  // 一个工作区，6 个会话：2 个在 24 小时内、4 个是十天前的。主页默认视图只画那 2 个
  // （`bootRangeCap` = 置顶 + 24 小时，地板 1 行），修之前卡片读的是原件的 6。
  const rows = [
    rowOf('s-1', OLD), rowOf('s-2', OLD), rowOf('s-3', OLD), rowOf('s-4', OLD),
    rowOf('s-5', RECENT), rowOf('s-6', RECENT - 1_000),
  ]
  const bridge = makeBridge({
    rows,
    items: [{ workspaceId: 'w-a', sessionIds: ['s-1', 's-2', 's-3', 's-4', 's-5', 's-6'] }],
  })
  const summary = bridge.pageWarmSummary('landing')
  assert.equal(summary.ready, true)
  assert.equal(summary.rows, 2, '2 rows are inside the 24h window; the other 4 are not painted by default')
  assert.notEqual(summary.rows, rows.length, 'the raw list length (6) is exactly the number the user saw as wrong')
  assert.equal(summary.workspaces, 1)
})

test('the count is the same read three times in a row', () => {
  // 判据 3 的桥侧那一半：同一个数字连采 3 次必须相等（±0）。这里的读法是纯函数式的——
  // 摘要只读缓存，不因为多读一次而变化。
  const bridge = makeBridge({
    rows: [rowOf('s-1', RECENT), rowOf('s-2', OLD)],
    items: [{ workspaceId: 'w-a', sessionIds: ['s-1', 's-2'] }],
  })
  const three = [1, 2, 3].map(() => bridge.pageWarmSummary('landing').rows)
  assert.deepEqual(three, [1, 1, 1], 'one of the two rows is inside 24h, and that does not drift')
})

// ---------------------------------------------------------------------------
// 残差① 已闭合：陈旧空白行
// ---------------------------------------------------------------------------
test('a stale blank row is hidden on both sides, so the difference is 0', () => {
  // 判据 `:319`：陈旧空白行必须**闭合后差异为 0**，不许留差。
  // 页面 `renderWorkspaces`(`lib/pages.js:2356`) 逐字
  // `.filter(s=>!s.blank||s.missingSummary!==true&&blankRowVisible(s,Date.now(),BLANK_ROW_VISIBLE_MS))`
  // ——只有 `blank===true` 的行受 5 分钟新鲜度约束。这里放三种行：有内容的旧行（不受约束）、
  // 10 分钟前的空白行（超窗，两侧都不画）、刚建的空白行（窗内，两侧都画）。
  const rows = [
    rowOf('s-content', minute(90)),
    rowOf('s-ghost', minute(10), { blank: true }),
    rowOf('s-new-blank', minute(1), { blank: true }),
  ]
  const items = [{ workspaceId: 'w-a', sessionIds: rows.map((row) => row.sessionId) }]
  const A = makeBridge({ rows, items }).pageWarmSummary('landing').rows
  const B = taskRows(paintLanding({ workspaces: items, rows }))
  assert.equal(A, 2, 'the content row plus the one blank row younger than BLANK_ROW_VISIBLE_MS')
  assert.equal(B, 2, 'the landing hides the same stale blank row')
  assert.equal(A, B, 'residual ① is closed: the stale blank row is not a difference between the two sides')
})

test('a row the page marked missingSummary is a ghost on both sides, however fresh it looks', () => {
  // 页面那一式的第二个条件（`s.missingSummary !== true`）：本地合成的幽灵行即使还「新」，
  // 也不画。页面侧幽灵行由 `renderWorkspaces` 的 `byId.get(id)||{…,blank:true,missingSummary:true}`
  // 造出来（`lib/pages.js`），桥侧的行来自 `session/list`，本来不会带这个标——所以这一条在
  // 桥侧是照抄页面的防御，不抄的话一旦真有带标的行流进来，桥会比页面多算一行且无从解释。
  // 用真实行显式带上 `missingSummary:true` 就能构造出这个分叉（下面的反向变异证明它承重）。
  const rows = [
    rowOf('s-content', minute(50)),
    rowOf('s-ghost', minute(1), { blank: true, missingSummary: true }),
  ]
  const items = [{ workspaceId: 'w-a', sessionIds: rows.map((row) => row.sessionId) }]
  const A = makeBridge({ rows, items }).pageWarmSummary('landing').rows
  const B = taskRows(paintLanding({ workspaces: items, rows }))
  assert.equal(B, 1, 'the landing never paints a missingSummary ghost, even one a minute old')
  assert.equal(A, 1, 'the bridge must not count it either')
  assert.equal(A, B)
})

test('a stale blank row does not eat the one-row floor of the window cap', () => {
  // 这一条钉的是**过滤必须在截断之前**（`lib/bridge.js` 里 `blankVisibleRows` 在
  // `bootVisibleRows` 之前）。反过来的话：整组都在 24h 外、且陈旧空白行是最新一行时，
  // 它先占掉 `Math.max(..., Math.min(members.length, 1))` 那个地板名额，桥留 1 行、
  // 页面留 0 行——①的「差 0」就不成立了。
  const rows = [rowOf('s-old', day(3)), rowOf('s-ghost', day(2), { blank: true })]
  const items = [{ workspaceId: 'w-a', sessionIds: ['s-old', 's-ghost'] }]
  const A = makeBridge({ rows, items }).pageWarmSummary('landing').rows
  const B = taskRows(paintLanding({ workspaces: items, rows }))
  assert.equal(B, 1, 'the landing keeps exactly the one old row the floor allows, and it is not the ghost')
  assert.equal(A, B, 'the floor is computed after the blank filter on both sides')
})

// ---------------------------------------------------------------------------
// 残差② 登记：跨 24h 窗口边界
// ---------------------------------------------------------------------------
test('rows straddling the 24h window edge are counted the same on both sides', () => {
  // 判据 `:319`：跨窗口这一类的差异必须**已经闭合后为 0**。
  // 两侧的窗口判据同源：页面 `bootRangeCap`(`lib/pages.js:2274`) 用
  // `sortAtOf(s) >= now - RECENT_WINDOW_MS`，桥 `bootVisibleRows`(`lib/bridge.js:1009`) 用
  // `stampOf(id) >= now - BOOT_RECENT_WINDOW_MS`，两个常量都是 86400000。
  // 残差② `lastMessageAtOf` 只有在「`updatedAt` 在窗外、手机侧的 `lastMessageAt` 在窗内」时才
  // 会造出差异——那是桥读不到 localStorage 的物理边界，不是本用例的构造。这里所有行都没有
  // 手机侧 `lastMessageAt`（沙箱的 `lastMessageAt` 表为空），两侧走同一条 `updatedAt` 判据。
  const rows = [
    rowOf('s-in', NOW - DAY_MS + 3_600_000), // 窗内，差 1 小时
    rowOf('s-out', NOW - DAY_MS - 3_600_000), // 窗外，差 1 小时
    rowOf('s-in2', NOW - DAY_MS + 60_000), // 窗内，贴着边
  ]
  const items = [{ workspaceId: 'w-a', sessionIds: rows.map((row) => row.sessionId) }]
  const A = makeBridge({ rows, items }).pageWarmSummary('landing').rows
  const B = taskRows(paintLanding({ workspaces: items, rows }))
  assert.equal(A, 2, 'two rows are inside the 24h window and one is outside')
  assert.equal(A, B, 'the window edge is read with the same rule on both sides')
})

// ---------------------------------------------------------------------------
// 残差③ 登记：多 part（本轮留差，方向固定 A ≥ B）
// ---------------------------------------------------------------------------
test('several parts of one Bot stay a known difference, and the bridge over-counts (A >= B)', () => {
  // 判据 `:311-313` + `:319`：只有「多 part」这一类允许本轮留差，方向固定 **A ≥ B**
  // （桥不折叠 → 多算），且多算的行必须能逐条指出来。
  // 页面 `mergeBotParts`(`lib/pages.js:1928`) 按 `botName` 折同一 Bot 的多个 part，只留最新一行；
  // 桥没有这一步。构造：`Helper` 两个 part（各一行）+ 一个普通会话。
  const rows = [
    rowOf('s-helper-old', minute(40), { projections: { values: { botName: 'Helper', title: 'helper' } } }),
    rowOf('s-helper-new', minute(5), { projections: { values: { botName: 'Helper', title: 'helper' } } }),
    rowOf('s-plain', minute(20), { projections: { values: { title: 'plain' } } }),
  ]
  const items = [{ workspaceId: 'w-a', sessionIds: rows.map((row) => row.sessionId) }]
  const A = makeBridge({ rows, items }).pageWarmSummary('landing').rows
  const B = taskRows(paintLanding({ workspaces: items, rows }))
  assert.equal(B, 2, 'the landing folds the two Helper parts into one row: Helper + plain')
  assert.equal(A, 3, 'the bridge does not fold, so it counts both parts')
  assert.equal(A - B, 1, 'the difference is exactly the one folded part')
  assert.ok(A >= B, 'residual ③ has a fixed direction: the bridge over-counts (A >= B), never under-counts')
})

// ---------------------------------------------------------------------------
// 既有口径守卫（隐藏工作区、subagent、置顶、无上限）
// ---------------------------------------------------------------------------
test('sessions of the hidden Bot-team workspace are never part of the number', () => {
  // 那个工作区在主页上是要藏起来的（用户 2026-10-24）：boot 把它的条目从快照里摘走，它的行
  // 就变成「没有卡认领」的孤儿行——而孤儿行 `bootVisibleRows` 是故意保留的。不在这里剔掉，
  // 过渡卡就会把用户关掉的那扇门里的会话数报回来。
  const bridge = makeBridge({
    rows: [rowOf('s-bot', RECENT), rowOf('s-1', RECENT)],
    items: [
      { workspaceId: 'w-bot', sessionIds: ['s-bot'] },
      { workspaceId: 'w-a', sessionIds: ['s-1'] },
    ],
    hidden: 'w-bot',
  })
  assert.equal(bridge.pageWarmSummary('landing').rows, 1, 'only the row the landing can paint is counted')
})

test('subagent rows are not counted, even in a workspace that holds nothing else', () => {
  // 页面第一步就把 subagent 行滤掉了（lib/pages.js:1883 `visibleSessions`）——它们不占卡片
  // 任何一行。w-c 只装了这样一行，修之前它会被当成「该工作区读了 1 行」报出去。
  const bridge = makeBridge({
    rows: [rowOf('s-1', RECENT), rowOf('s-sub', RECENT, { origin: 'subagent' })],
    items: [
      { workspaceId: 'w-a', sessionIds: ['s-1'] },
      { workspaceId: 'w-c', sessionIds: ['s-sub'] },
    ],
  })
  assert.equal(bridge.pageWarmSummary('landing').rows, 1)
})

test('a pinned row survives the window, and an unclaimed row is not painted at all', () => {
  // 置顶行不论多旧都在视图里（`bootRangeCap` 的 p 项）。
  //
  // 没有工作区认领的行（「未分组」那一桶）：用户 2026-10-30「隐藏就是两个工作区，未分组和
  // DSBOT」把那张卡从主页退场后，这些行在主页上一处也不落——桥侧这一格也不再数它们
  // （两侧读同一个 `unclaimedSessionIds`，判据 2）。所以这里期望 1 行，不是 2 行。
  const rows = [rowOf('s-pin', OLD), rowOf('s-old', OLD), rowOf('s-orp', OLD)]
  const items = [{ workspaceId: 'w-a', sessionIds: ['s-pin', 's-old'] }]
  const bridge = makeBridge({ rows, items, pinnedSessionIds: ['s-pin'] })
  const A = bridge.pageWarmSummary('landing').rows
  const B = taskRows(paintLanding({ workspaces: items, rows, pinned: ['s-pin'] }))
  assert.equal(A, 1, 'the pinned row; the old unpinned row is behind the window edge and the unclaimed row has no card to land on')
  assert.equal(A, B, 'and the landing paints exactly that one row')
})

test('a few hundred live rows are reported in full, not truncated to a round number', () => {
  // 判据 4：不许「减一个偏移量」也不许 clamp 到一个好看的上限。全部落在窗口内的行，一行不少。
  const sessionIds = Array.from({ length: 250 }, (_, i) => `s-${i}`)
  const bridge = makeBridge({
    rows: sessionIds.map((id, i) => rowOf(id, RECENT - i)),
    items: [{ workspaceId: 'w-a', sessionIds }],
  })
  const summary = bridge.pageWarmSummary('landing')
  assert.equal(summary.rows, 250)
  assert.notEqual(summary.rows, 200, '200 would be a ceiling, and there is none')
})

// ---------------------------------------------------------------------------
// 结构钉：落点在调用侧，公共函数本体不动，闭合用的是页面那份导出
// ---------------------------------------------------------------------------
test('the landing branch is wired to the shared filters, and the shared filters are untouched', () => {
  // 判据 2 的硬约束：口径必须落在那两个公共函数的调用侧，公共函数本体不加分支。
  // ①落点体内确实调用 `withoutWorkspaceRows` 与 `bootVisibleRows`；②没有任何 `rows: rows.length`
  // 式的原件读数残留；③没有偏移量／钳位补丁；④两个公共函数的正文与基提交 e46e979 逐字节相同。
  // ⑤残差①闭合走的是 `lib/pages.js` 的既有导出，不是桥侧抄一份。
  const source = readFileSync(fileURLToPath(new URL('../lib/bridge.js', import.meta.url)), 'utf8')
  const start = source.indexOf('  pageWarmSummary(page) {')
  assert.notEqual(start, -1, 'pageWarmSummary is where this batch says it is')
  const end = source.indexOf('\n  async warmPage(', start)
  assert.notEqual(end, -1, 'the landing branch ends where warmPage begins')
  const body = source.slice(start, end)
  assert.ok(body.includes('withoutWorkspaceRows(rows, hidden)'), 'the shared row filter is called, not re-implemented')
  assert.ok(body.includes('bootVisibleRows(blankVisibleRows'), 'the shared visibility window is called')
  assert.doesNotMatch(body, /rows:\s*rows\.length/, 'the raw list length is no longer a reading')
  assert.doesNotMatch(body, /rows\.length\s*-/, 'no offset is subtracted')
  assert.doesNotMatch(body, /Math\.min\(\s*200/, 'no ceiling is clamped in')

  // 残差①：页面那一式照抄，且用的正是页面导出的函数与常量。
  assert.ok(
    body.includes('blankRowVisible(row, now, BLANK_ROW_VISIBLE_MS)'),
    'residual ① is closed with the page\'s own exported helper and constant',
  )
  assert.ok(
    body.includes('row.missingSummary !== true'),
    'the missingSummary guard of lib/pages.js:2356 is carried over verbatim',
  )
  // 顺序：空白行过滤必须在 `bootVisibleRows` 之前（见上面「地板」用例）。
  assert.ok(
    body.indexOf('blankVisibleRows') < body.indexOf('bootVisibleRows(blankVisibleRows'),
    'the blank filter runs before the window cap, as it does on the page',
  )

  // 这两个名字必须来自 `./pages.js` 的命名 import——桥侧不许有第二份实现。
  // 逐个把 `import { … } from './pages.js'` 的花括号内容取出来（asset 那处是 `import * as`，
  // 不带花括号，天然不在候选里），并断言这样的命名 import 只有一处：多出一处意味着有人
  // 又开了一个 import 头，两个名字可能只落在其中一处而另一处漏掉。
  const namedPagesImports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/pages\.js'/g)]
  assert.equal(namedPagesImports.length, 1, 'exactly one named import from ./pages.js')
  const names = namedPagesImports[0][1].split(',').map((name) => name.trim()).filter(Boolean)
  assert.ok(names.includes('blankRowVisible'), 'blankRowVisible comes from ./pages.js, not a copy')
  assert.ok(names.includes('BLANK_ROW_VISIBLE_MS'), 'BLANK_ROW_VISIBLE_MS comes from ./pages.js, not a copy')
  // 反向：桥侧不许自己再写一份同名函数/常量（那正是判据 ① 禁止的「零复制的反面」）。
  assert.doesNotMatch(source, /function blankRowVisible\s*\(/, 'no local copy of blankRowVisible in lib/bridge.js')
  assert.doesNotMatch(source, /const BLANK_ROW_VISIBLE_MS\s*=/, 'no local copy of BLANK_ROW_VISIBLE_MS in lib/bridge.js')

  const baseline = preFixBaseline('e46e979', 'lib/bridge.js')
  if (!baseline) {
    // 读不到基线 ≠ 基线成立（test/helpers/pre-fix-baseline.mjs:11-14）：记未取证，不回退读工作树。
    return
  }
  const bodyOf = (text, signature) => {
    const at = text.indexOf(signature)
    assert.notEqual(at, -1, `${signature} is present`)
    const close = text.indexOf('\n}\n', at)
    assert.notEqual(close, -1, `${signature} closes at column 0`)
    return text.slice(at, close + 2)
  }
  assert.equal(
    bodyOf(source, 'function bootVisibleRows(rows, wsSnapshot, now) {'),
    bodyOf(baseline, 'function bootVisibleRows(rows, wsSnapshot, now) {'),
    'bootVisibleRows is shared with the landing: this batch may not add a branch to it'
  )
  assert.equal(
    bodyOf(source, 'function withoutWorkspaceRows(rows, workspaceId) {'),
    bodyOf(baseline, 'function withoutWorkspaceRows(rows, workspaceId) {'),
    'withoutWorkspaceRows is shared with the landing: this batch may not add a branch to it'
  )
})
