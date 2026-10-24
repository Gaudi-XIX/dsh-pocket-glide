// 主页会话列表与转写各自的「上界」——把 card 2026-10-24-pocket-list-virtualization
// （W6）design.md §4 的判据钉成可执行断言。**本文件不新增任何产品行为**（test-only，
// 0 壳字节）：它只测「生产函数现在会画出多少 DOM」，不改一行渲染代码。
//
// 为什么不做虚拟化（design.md §0，planner + LEAD 已裁，别推翻）：
//   主页列表已经有界，而且是三重：24 h 时间窗（bootRangeCap）+ 折叠卡画 0 行 +
//   每次「更多」只加 MORE_ROWS=10 行。典型日实测 12 行 / 161 节点 / 10.8 KB。病态日
//   （500 个会话都在 24 h 内更新）的根因是「没有计数上限」，不是「渲染方式」：压到
//   161 那一档，虚拟化要 1.5–3.5 KB 壳，加一个计数常量只要 51 B。同一效果不买贵 30–70
//   倍的那条路（壳余量只有三位数字节）。故本卡交付＝判据落档 + 这五条上界断言。
//
// ⚠️ LB-4 是「触发判据」，不是「认可现状」，更不是验收目标。
//    设计卡实测：500 个全新鲜会话 ⇒ 500 行 / 6,017 元素节点 / 410 KB 一次刷新。
//    **这是上界触发线：红了就说明有人把病态日放进来了（或者加了/撤了上限），
//    该开一张「近日行数上限 RECENT_ROWS_MAX」小卡（design.md §2 的 C2，51 B），
//    不许抬高本文件的阈值。** 真机上出现 500 行级别的一次刷新（或任一次刷新
//    innerHTML > 200 KB）同样是这条触发线。
//
// 房规（house pattern，不 mock、不绕 server）：
//   - 被测对象是**渲染出的生产代码**：从 lib/pages.js 的 built asset 里按 brace-match
//     抽出真函数，塞进 `new Function` 沙箱跑（test/workspace-head-notices.test.js 的
//     listSandbox、test/pages-process-render.test.js:512 的 messageSandbox 是同一范式）。
//   - 断言的量是这两个真函数**产出**的 DOM：行数 = `taskRows()` 数 `<button class="task-row"`，
//     元素节点 = `elementNodes()` 数 `/<[a-zA-Z][a-zA-Z0-9-]*/`，字节 = `Buffer.byteLength`。
//     不是拿手写数字比手写数字——改渲染就会在读数上现形。
//   - 不经过宿主 DOM，所以读数是「生产函数会产出多少节点」的下界：浏览器插进去的
//     匿名盒/阴影节点不在其中（design.md §6 第 3 条），真实 DOM 只会更多。
//   - 转写侧只跑 `renderMessage` 的合并（paintMessages:1745 的内层就是
//     `messages.map(renderMessage).join('')`）；滚动/锚点/贴底那套几何件与本判据无关，
//     不搬进沙箱（搬进来只会让断言依赖 stub 而不是渲染）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })

// ---------------------------------------------------------------------------
// 阈值（集中在此，改之前先读 design.md §4；数字来源＝设计卡 2026-10-24 的沙箱实测）
// ---------------------------------------------------------------------------
// 量法同本文件头注释：真函数 + new Function 沙箱 + 同一个节点正则 + Buffer.byteLength。
// 每组阈值的余量都是「实测 × 一个窄余量」，够挡住形态翻倍，又不给日常漂移留幻觉。
const LIST_BOUNDS = {
  // 两张卡全折叠：实测 0 行 / 32 节点 / 1.8 KB（design.md §4 记 18 节点/单卡）。折叠
  // 就不该建行——这条红了说明折叠路径开始预渲染。
  collapsedMaxRows: 0,
  collapsedMaxNodes: 40,
  // 702 个会话全部 3 天前 ⇒ 窗内只剩地板 1 行：实测 1 行 / 30 节点 / 2.0 KB
  // （design.md §4 记 48 节点 / 3.1 KB）。**这条钉住 24 h 时间窗**：撤掉窗口、改回
  // 「全量列表」就会红。
  staleMaxRows: 1,
  staleMaxNodes: 60,
  staleMaxBytes: 4 * 1024,
  // 40 个 24 h 内会话 ⇒ 展开：实测 40 行 / 495 节点 / 34.1 KB
  // （design.md §4 记 40 行 / 515 节点 / 34.8 KB）。钉住「非折叠必须全显」
  // （用户 m00001③ / m00073：24 h 内的每一个会话都要看得见，不许再套 25 行上限）。
  freshFortyRows: 40,
  freshFortyMaxNodes: 800,
  freshFortyMaxBytes: 40 * 1024,
  // 500 个全新鲜（宿主 SESSION_LIST_MAX_ROWS=500 打满）⇒ 展开：实测 500 行 /
  // 6,015 节点 / 417 KB（design.md §4 记 6,017 节点 / 410 KB，同一量法同日复测，
  // 差异来自标题字符与 i18n 尾串）。
  // ⚠️ 上界触发线，不是验收目标，不许抬（见文件头 LB-4 那段）。
  freshFiveHundredRows: 500,
  freshFiveHundredMaxNodes: 6500,
  freshFiveHundredMaxBytes: 450 * 1024,
  // 转写：30 条 turn 行 ⇒ 实测 450 节点（design.md §1.2 记 450 / 23.6 KB）；
  // 112 条 ⇒ 实测 1,680（记 1,680 / 88.2 KB）。一行 turn 的 DOM 是 15 个元素
  // （思考 9 + 过程行 4 + 正文 2 里按现在的形状正好 15），工具多寡不改变节点数
  // （整轮的工具折成一条 flat line），所以这条钉的是「每条 ≤15 节点」这一阶：
  // 渲染改动若把每行翻倍（例如给每行加外层壳、把折叠换回 details 列表），必红。
  transcript30MaxNodes: 500,
  transcript112MaxNodes: 1900,
}

const LB4_TRIGGER =
  '这是上界触发线（design.md §4 LB-4），不是验收目标：红了该开一张「近日行数上限 RECENT_ROWS_MAX」小卡（C2，51 B），不许抬高阈值。'

// ---------------------------------------------------------------------------
// 量具
// ---------------------------------------------------------------------------
// Brace-match extractor（transcript-order house pattern）。
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

// The page's own numbers, scraped out of the built asset instead of copied by hand:
// if a constant disappears (or turns non-numeric) the sandbox refuses to run rather
// than silently measuring a different page.
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
const UNREAD_OPEN_KEY = assetString(/UNREAD_OPEN_KEY='([^']+)'/, 'UNREAD_OPEN_KEY')
const LAST_MESSAGE_KEY = assetString(/LAST_MESSAGE_KEY='([^']+)'/, 'LAST_MESSAGE_KEY')
const UNREAD_RECENCY_MS = assetNumber(/UNREAD_RECENCY_MS=(\d+)/, 'UNREAD_RECENCY_MS')
const LAST_MESSAGE_MAX = assetNumber(/LAST_MESSAGE_MAX=(\d+)/, 'LAST_MESSAGE_MAX')
const BLANK_ROW_VISIBLE_MS = assetNumber(/BLANK_ROW_VISIBLE_MS=(\d+)/, 'BLANK_ROW_VISIBLE_MS')
const LIST_ROWS_MAX = assetNumber(/LIST_ROWS_MAX=(\d+)/, 'LIST_ROWS_MAX')
const WS_FLAGS_MAX = assetNumber(/WS_FLAGS_MAX=(\d+)/, 'WS_FLAGS_MAX')
const RECENT_WINDOW_MS = assetNumber(/RECENT_WINDOW_MS=(\d+)/, 'RECENT_WINDOW_MS')
const MORE_ROWS = assetNumber(/MORE_ROWS=(\d+)/, 'MORE_ROWS')

// What the user actually pays for: one element per `<tag` in the painted string.
const elementNodes = (html) => (html.match(/<[a-zA-Z][a-zA-Z0-9-]*/g) || []).length
// One row per conversation, counted on the real row button — not on a wrapper.
const taskRows = (html) => (html.match(/<button class="task-row/g) || []).length
const bytesOf = (html) => Buffer.byteLength(html)

const MINUTE = 60 * 1000
// Time is read by real page code, so the fixtures speak its units: epoch ms, counted
// back from now.
const ago = (minutes) => Date.now() - Math.round(minutes * MINUTE)

// rows: the summary shape lib/projections.js hands the list. `blank:false` = a
// conversation with content; `updatedAt` is the host's stamp the window reads.
const summary = (sessionId, updatedAt, title) => ({ sessionId, updatedAt, blank: false, projections: { values: { title } } })
const freshRow = (i) => summary(`s${i}`, ago(i % 600), `t${i}`) // all inside 24 h
const staleRow = (i) => summary(`o${i}`, ago(3 * 24 * 60), `t${i}`) // all 3 days old

// ---------------------------------------------------------------------------
// 主页列表沙箱：真 renderWorkspaces + 它读的页面全局
// ---------------------------------------------------------------------------
// Mirrors test/workspace-head-notices.test.js's listSandbox (the proven set: every
// function renderWorkspaces reaches for, spliced from the built asset, driven by
// synthetic rows). Nothing here re-implements a renderer: the only code in the
// sandbox that is not from the asset is the constant/PIN wiring and the DOM stubs
// (localStorage, $()).
function paintList({ workspaces, summaries, expanded = [], pinned = [], revealed = [] }) {
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
    const workspaces=fixture.workspaces, sessionSummaries=fixture.summaries
    const expandedWsIds=new Set(fixture.expanded), revealedLists=new Map(fixture.revealed)
    const pinnedSessionIds=fixture.pinned, activeSession=null
    const pinBusy=new Set()
    let openedAtLedgerReady=true
    const $=()=>container
    // The tail prefetch is a network organ; the landing calls it after every paint.
    // Empty cache + no-op pull is exactly the landing-with-nothing-prefetched state.
    const tailCache=new Map(),tailArmedAt={},tailPending=new Set()
    function requestVisibleTails(){}
    function requestTailBootRound(){}
    function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
    const store={}
    const localStorage={getItem:(key)=>store[key]||'{}',setItem:(key,value)=>{store[key]=String(value)}}
    ${body}
    return { paint(){ renderWorkspaces(); return container.innerHTML } }
  `,
  )
  const page = make({ workspaces, summaries, expanded, pinned, revealed }, host)
  return page.paint()
}

// ---------------------------------------------------------------------------
// 转写沙箱：真 renderMessage + 它读的页面全局
// ---------------------------------------------------------------------------
// Same set as test/pages-process-render.test.js:512 messageSandbox: the real
// renderers over a stubbed DOM-free neighbourhood (nothing on this path touches
// markdown beyond the page's own esc).
function paintTranscript(rows) {
  const names = [
    'toolActivityCategory', 'processLineText', 'clusterToolBlocks', 'renderBlock',
    'processRows', 'processLineHtml', 'renderProcessLine', 'renderMessage',
  ]
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  const sandbox = new Function(
    'L',
    'activeSession',
    `
    const esc=v=>String(v==null?'':v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
    const markdown=text=>String(text||'')
    function activityIcon(){return '<i class="icon"></i>'}
    function activityChevron(){return '<c></c>'}
    function reasoningSummary(){return ''}
    const turnOpenState=new Map()
    const pendingQuestion=null
    function renderMessageTail(){return ''}
    ${body}
    return { renderMessage }
  `,
  )(L, 's1')
  // paintMessages:1745 paints exactly this join; the surround (older row, wait
  // hint, status line) is bounded by its own organs and not part of this bound.
  return rows.map((row) => sandbox.renderMessage(row)).join('')
}

// One painted transcript row as the page groups it (visibleMessages:1191): a turn
// is a flat run of thinking + tool work + reply, drawn as ONE row. 15 elements.
// Tool density rides inside the one flat process line, so 1 tool and 4 tools cost
// the same nodes — the fixture mixes both to keep that true rather than assumed.
const turnRow = (i) => {
  const tools = i % 3 === 0 ? ['read', 'bash', 'edit', 'grep'] : i % 3 === 1 ? ['read'] : ['read', 'bash']
  return {
    role: 'assistant',
    turnProcess: true,
    turnKey: `t${i}`,
    segment: 0,
    streaming: false,
    _seq: i,
    blocks: [
      { kind: 'reasoning', text: '先看一眼再改' },
      ...tools.map((name) => ({ kind: 'tool', name, status: 'done', args: {} })),
      { kind: 'text', text: '改好了' },
    ],
  }
}
const turnRows = (count) => Array.from({ length: count }, (_, i) => turnRow(i))

// ---------------------------------------------------------------------------
// LB-1 … LB-4：主页列表
// ---------------------------------------------------------------------------
test('LB-1: a collapsed card builds no rows at all', () => {
  const html = paintList({
    workspaces: [
      { workspaceId: 'w1', title: 'pocket', sessionIds: ['a1', 'a2'] },
      { workspaceId: 'w2', title: 'flow-plugin', sessionIds: ['b1'] },
    ],
    summaries: [summary('a1', ago(5), 'a1'), summary('a2', ago(40), 'a2'), summary('b1', ago(90), 'b1')],
    expanded: [],
  })
  assert.equal(taskRows(html), LIST_BOUNDS.collapsedMaxRows, `collapsed cards must paint no rows (measured ${taskRows(html)})`)
  // Not "no chrome at all": a folded card still paints its「更多 N 行」door into the
  // window (production computes `rest` from `shown`, and `shown` is empty while
  // folded). What it must not paint is a row or a row wrapper — that is what this
  // asserts, and why the collapsed node ceiling is 40 and not 18-per-card.
  assert.ok(!html.includes('class="task-line"'), 'a folded card must not build the row wrapper either')
  const nodes = elementNodes(html)
  assert.ok(
    nodes <= LIST_BOUNDS.collapsedMaxNodes,
    `LB-1: ${nodes} element nodes for two folded cards exceeds ${LIST_BOUNDS.collapsedMaxNodes} — folding must not pre-render rows or row chrome (design.md §4: 18 nodes per folded card, 2026-10-24)`,
  )
})

test('LB-2: the 24 h window is what keeps 702 old sessions off the page', () => {
  // The 2026-10-10 incident shape: 436 + 266 sessions, every one of them 3 days
  // old, one workspace expanded. The window leaves the floor row (the newest
  // conversation is always visible) and parks the other 701 behind「更多」.
  const summaries = Array.from({ length: 702 }, (_, i) => staleRow(i))
  const html = paintList({
    workspaces: [{ workspaceId: 'w1', title: 'pocket', sessionIds: summaries.map((row) => row.sessionId) }],
    summaries,
    expanded: ['w1'],
  })
  assert.equal(
    taskRows(html),
    LIST_BOUNDS.staleMaxRows,
    `702 sessions all older than RECENT_WINDOW_MS (${RECENT_WINDOW_MS} ms) must paint exactly ${LIST_BOUNDS.staleMaxRows} row — the floor row; ${taskRows(html)} rows means the window was dropped`,
  )
  assert.ok(html.includes('older-row'), 'and the 701 waiting rows stay reachable through the「更多」row')
  const nodes = elementNodes(html)
  assert.ok(nodes <= LIST_BOUNDS.staleMaxNodes, `LB-2: ${nodes} element nodes exceeds ${LIST_BOUNDS.staleMaxNodes} — the 24 h window is the only thing keeping an all-stale workspace small (design.md §4)`)
  const bytes = bytesOf(html)
  assert.ok(bytes <= LIST_BOUNDS.staleMaxBytes, `LB-2: ${bytes} B of innerHTML exceeds ${LIST_BOUNDS.staleMaxBytes} B for an all-stale workspace`)
})

test('LB-3: every conversation inside the window is painted when the card is expanded', () => {
  // User ruling m00001③ / m00073: no 25-row cap any more — inside 24 h, every
  // conversation is visible. This is the assertion that refuses to bring the
  // retired LIST_ROWS_MAX back as a display cap.
  const summaries = Array.from({ length: 40 }, (_, i) => freshRow(i))
  const html = paintList({
    workspaces: [{ workspaceId: 'w1', title: 'pocket', sessionIds: summaries.map((row) => row.sessionId) }],
    summaries,
    expanded: ['w1'],
  })
  assert.equal(
    taskRows(html),
    LIST_BOUNDS.freshFortyRows,
    `40 sessions inside RECENT_WINDOW_MS must paint 40 rows when expanded, got ${taskRows(html)} — a smaller number means a row cap came back (LIST_ROWS_MAX is retired)`,
  )
  const nodes = elementNodes(html)
  assert.ok(nodes <= LIST_BOUNDS.freshFortyMaxNodes, `LB-3: ${nodes} element nodes exceeds ${LIST_BOUNDS.freshFortyMaxNodes} for 40 rows (design.md §4: 515 nodes / 34.8 KB, 2026-10-24)`)
  const bytes = bytesOf(html)
  assert.ok(bytes <= LIST_BOUNDS.freshFortyMaxBytes, `LB-3: ${bytes} B of innerHTML exceeds ${LIST_BOUNDS.freshFortyMaxBytes} B for 40 rows`)
})

test('LB-4: the pathological day is a recorded ceiling, not an accepted state', () => {
  // 500 = the host's own SESSION_LIST_MAX_ROWS, i.e. the most the page can ever be
  // handed. This is the worst case the current design allows, and the numbers below
  // are what it costs today. See the file header: red here is a trigger, not a
  // regression in this test.
  const summaries = Array.from({ length: 500 }, (_, i) => freshRow(i))
  const html = paintList({
    workspaces: [{ workspaceId: 'w1', title: 'pocket', sessionIds: summaries.map((row) => row.sessionId) }],
    summaries,
    expanded: ['w1'],
  })
  const rows = taskRows(html)
  const nodes = elementNodes(html)
  const bytes = bytesOf(html)
  assert.equal(
    rows,
    LIST_BOUNDS.freshFiveHundredRows,
    `${rows} rows painted for 500 fresh sessions (expected ${LIST_BOUNDS.freshFiveHundredRows}). ${LB4_TRIGGER}`,
  )
  assert.ok(
    nodes <= LIST_BOUNDS.freshFiveHundredMaxNodes,
    `LB-4: 500 fresh sessions produced ${nodes} element nodes (measured 2026-10-24: 6,017 nodes / 410 KB), over the recorded ceiling of ${LIST_BOUNDS.freshFiveHundredMaxNodes}. ` +
      `一次刷新把 500 行全画出来就是病态日信号：${LB4_TRIGGER}`,
  )
  assert.ok(
    bytes <= LIST_BOUNDS.freshFiveHundredMaxBytes,
    `LB-4: 500 fresh sessions produced ${bytes} B of innerHTML (measured 2026-10-24: 410 KB), over the recorded ceiling of ${LIST_BOUNDS.freshFiveHundredMaxBytes} B. ${LB4_TRIGGER}`,
  )
})

// ---------------------------------------------------------------------------
// LB-5：转写
// ---------------------------------------------------------------------------
test('LB-5: the transcript costs ~15 nodes per row, and a long one only grows by rows', () => {
  const page = paintTranscript(turnRows(30))
  const nodes30 = elementNodes(page)
  assert.ok(
    nodes30 <= LIST_BOUNDS.transcript30MaxNodes,
    `LB-5: 30 painted rows produced ${nodes30} element nodes, over ${LIST_BOUNDS.transcript30MaxNodes} (design.md §1.2: 450 nodes / 23.6 KB for a 30-record page, 2026-10-24) — the per-row shape doubled`,
  )
  const long = paintTranscript(turnRows(112))
  const nodes112 = elementNodes(long)
  assert.ok(
    nodes112 <= LIST_BOUNDS.transcript112MaxNodes,
    `LB-5: 112 painted rows produced ${nodes112} element nodes, over ${LIST_BOUNDS.transcript112MaxNodes} (design.md §1.2: 1,680 nodes / 88.2 KB, the 2026-10-15 真机 case) — a row is no longer the ~15-node shape`,
  )
  // The bound is linear in rows, not in tools: a tool-heavy row costs the same as a
  // light one because the whole run folds into one flat line. If that ever changes,
  // the 112-row number above catches it; this equality is the cheap witness.
  const light = elementNodes(paintTranscript([turnRow(1)]))
  const heavy = elementNodes(paintTranscript([turnRow(0)]))
  assert.equal(heavy, light, 'tool density still rides inside one flat process line, not one node per tool')
})
