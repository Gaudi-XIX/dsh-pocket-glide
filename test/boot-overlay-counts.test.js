// 冷启动卡（#bootOverlay）的计数口径——判据 L1／L2／L3。
//
// 真机上坏的是「读数从哪儿来」：
//   ① 卡上第二行报 78，同一时刻页面作用域里 sessionSummaries.length=402、DOM 里真正画出来
//      的会话行只有 4 行——取的是「payload 全量长度」这种和屏幕无关的数；
//   ② 这一趟 boot 没带 tails 时第三行把 0 定稿成读数，读到 0 与根本没读到在界面上无法区分。
//
// 取样点：出货页里冷启动卡那一段（`const bootOv=$('bootOverlay')` 起、`if(handoff){applyBootData(boot)`
// 止）读的是 **boot 载荷下发的 `stageSummary`**（判据 v7 §3/§4：四张卡同一份摘要，页面不许再数
// DOM）。这一条是裁决 R3 改的：旧口径「直接读 .ws-card／.task-row 的 length」在读数要跟摘要
// 一致的契约下已不成立——页面只许「确认」，DOM 与摘要不一致时以摘要为准。
//
// 这里跑的是出货页里的真源码：head 注入的 `ladderRun` 定义 + 上面那一段卡片源码，两段都是从
// renderMobilePage() 的真输出里切出来的。替身只替 DOM／时钟／存储，不替逻辑；替身仍把画出来的
// `.ws-card`／`.task-row` 数量与 402 行的 `sessionSummaries` 一起喂进去当诱饵——谁要退回去数
// DOM 或 payload 长度，下面的断言立刻红（最后一条用例专门把 DOM 与摘要摆成相反的读数）。
// 用例都是行为断言（读 stubbed DOM 与阶梯行文本），不按源码正则断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { botToPocketRows, renderMobilePage, renderMobileReconnectPage, renderPairingPinPage } from '../lib/pages.js'

const ROWS = botToPocketRows(true)
const SHIPPED = renderMobilePage({ locale: 'zh', boot: null })

function blocks() {
  return [...SHIPPED.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1])
}

function ladderSource() {
  const block = blocks().find((source) => source.includes('function ladderRun('))
  assert.ok(block, '出货页里找不到 ladderRun 的定义')
  return block
}

function cardSource() {
  const block = blocks().find((source) => source.includes("const bootOv=$('bootOverlay')"))
  assert.ok(block, '出货页里找不到冷启动卡那一段')
  const start = block.indexOf("const bootOv=$('bootOverlay')")
  // 判据 R15-2.2(乙)：这一段现在还要读 `boot.stageSummary` 来决定露不露卡，所以取样必须
  // 把 `const boot=…`／`const ovSummary=…`／`ovLadder`…`ovFail` 整段括进来；切到
  // `if(handoff){applyBootData(boot)` 为止（再往后是本页自己的加载流程，不属于这张卡）。
  const end = block.indexOf('if(handoff){applyBootData(boot)')
  assert.ok(end > start, '出货页里冷启动卡那一段的首尾锚点对不上')
  return block.slice(start, end)
}

// 每条阶梯行的替身：真页面里 ladderRun 通过 row.querySelector('.bsc') 拿格子，再用
// cell.dataset.unit / cell.textContent / cell._final / cell._scan 记账。
function fakeRows() {
  return ROWS.map((spec) => {
    const cell = {
      // 判据 R15-1.1/1.2：带 `blank` 的格子在出货 markup 里出生就是空的、只带
      // `data-blank="1"`，挂载兜底认这个标记才不写「0＋单位」。替身照抄——否则
      // 「摘要未到不成值」这条在替身里永远测不出（P1-5：替身不许比真机宽松）。
      textContent: spec.blank ? '' : (spec.start ? spec.start : '0' + spec.unit),
      dataset: spec.blank ? { unit: spec.unit, blank: '1' } : { unit: spec.unit },
      _final: false,
      _scan: null,
    }
    const row = {
      _final: false,
      _active: false,
      _done: false,
      querySelector: (sel) => (sel === '.bsc' ? cell : null),
      classList: {
        toggle: (name, on) => {
          if (name === 'is-active') row._active = !!on
          else if (name === 'is-done') row._done = !!on
        },
        contains: (name) => (name === 'is-active' ? row._active : row._done),
      },
    }
    return { spec, row, cell }
  })
}

// 四张卡读的就是这一份：ready + 六格数字（判据 v7 §3 的七键里本页适用的七个）。
// bots+rooms=botSessions 一并钉进夹具：第 0 行只读 botSessions 单键，卡片不自己加。
const SUMMARY = { ready: true, workspaces: 4, sessions: 4, messages: 3, bots: 2, botSessions: 3, rooms: 1 }

function harness({ cards = 4, rows = 4, payloadWs = 4, payloadRows = 402, bootPayload = { stageSummary: SUMMARY } } = {}) {
  const timers = new Map()
  let seq = 0
  let now = 0
  const setTimeoutStub = (fn, ms) => {
    const id = ++seq
    timers.set(id, { at: now + (ms || 0), fn })
    return id
  }
  const clearTimeoutStub = (id) => timers.delete(id)
  const tick = (ms) => {
    const end = now + (ms || 0)
    for (let guard = 0; guard < 10000; guard += 1) {
      let next = null
      for (const [id, timer] of timers) {
        if (timer.at <= end && (next === null || timer.at < timers.get(next).at)) next = id
      }
      if (next === null) break
      const timer = timers.get(next)
      timers.delete(next)
      now = Math.max(now, timer.at)
      timer.fn()
    }
    now = end
  }

  const slots = fakeRows()
  const overlay = {
    hidden: true,
    querySelectorAll: (sel) => (sel === '.boot-step' ? slots.map((slot) => slot.row) : []),
  }
  const store = new Map()
  const sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
  // 「这一趟画出来的样子」：真页面先 renderWorkspaces() 再读 DOM，替身把画出来的行数做成
  // harness 的入参，读的那一刻是多少就是多少。
  const painted = { cards, rows }
  const documentStub = {
    getElementById: (id) => (id === 'bootOverlay' ? overlay : null),
    querySelectorAll: (sel) => new Array(sel === '.ws-card' ? painted.cards : sel === '.task-row' ? painted.rows : 0),
  }
  const $ = (id) => documentStub.getElementById(id)

  const body = `${ladderSource()}\n${cardSource()}\nreturn {ovData,ovReady,ovFail,ovState,ovLadder}`
  const make = new Function(
    '$',
    'setTimeout',
    'clearTimeout',
    'sessionStorage',
    'document',
    'workspaces',
    'sessionSummaries',
    // 判据 R15-2.2(乙) 起，这一段卡片源码还要问 boot 要 `stageSummary`：替身照真机
    // 把「这一趟的 boot 载荷」喂进去（冷启动那趟走的正是 takeHandoffBoot 这条 stash）。
    'window',
    'takeHandoffBoot',
    'cachedBoot',
    body,
  )
  // workspaces / sessionSummaries 是诱饵：真页面作用域里这两个数是 payload 全量，卡片不该读它们。
  const api = make(
    $,
    setTimeoutStub,
    clearTimeoutStub,
    sessionStorage,
    documentStub,
    new Array(payloadWs).fill({}),
    new Array(payloadRows).fill({ botName: 'x' }),
    {},
    () => bootPayload,
    null,
  )

  return {
    ...api,
    rows: slots,
    overlay,
    tick,
    paint: (p) => {
      if (p.cards !== undefined) painted.cards = p.cards
      if (p.rows !== undefined) painted.rows = p.rows
    },
    stop: () => timers.clear(),
  }
}

function advance(h, beats = 4) {
  for (let k = 0; k < beats; k += 1) h.tick(70)
}

test('L1 第一、二行取本次 boot 摘要的行数，不取 payload 全量长度', () => {
  const h = harness({ cards: 4, rows: 4, payloadWs: 4, payloadRows: 402 })
  try {
    assert.equal(h.overlay.hidden, false, '冷启动这一趟卡必须显形')
    // 判据 1／3a：露卡那一帧三格就是摘要真值——不 tick、不等 70ms 阶梯。
    assert.equal(h.rows[0].cell.textContent, '3 个 BOT 与群', '第 0 行＝三区画出行数合计（只读 botSessions 单键，bots 2 + rooms 1）')
    assert.equal(h.rows[1].cell.textContent, '4 个工作区', '露卡那一帧工作区格就是真值（判据 1／3a）')
    assert.equal(h.rows[2].cell.textContent, '4 个会话', '露卡那一帧会话格就是真值')
    assert.equal(h.rows[3].cell.textContent, '3 条消息', '露卡那一帧消息格就是真值')
    assert.equal(h.rows[0].cell._final, true, 'BOT 与群格出生即定稿')
    assert.equal(h.rows[1].cell._final, true, '工作区格出生即定稿')
    assert.equal(h.rows[2].cell._final, true, '会话格出生即定稿')
    assert.equal(h.rows[3].cell._final, true, '消息格出生即定稿')
    assert.equal(h.rows[4].cell.textContent.includes('已就绪'), false, '出生不写末行')
    assert.equal(h.ovState[0], 3, '第 0 槽＝boot 摘要的 botSessions（bots 2 + rooms 1）')
    assert.equal(h.ovState[1], 4, '第 1 槽＝boot 摘要的 4 张 .ws-card')
    assert.equal(h.ovState[2], 4, '第 2 槽＝boot 摘要的 4 行 .task-row，不是 payload 的 402 行')
    h.ovReady()
    assert.equal(h.rows[4].cell.textContent, '已就绪')
    h.tick(500)
    assert.equal(h.overlay.hidden, true, '末行写「已就绪」并停留之后才收卡')
  } finally {
    h.stop()
  }
})

test('L2 出生即真值、末格未就绪前不成值、fail-closed 收卡不补 0', () => {
  const h = harness({ cards: 2, rows: 6 })
  try {
    // 判据 1／3a：门内有可用摘要 ⇒ 前三格在露卡那一帧就是真值，不需要任何 tick。
    assert.equal(h.overlay.hidden, false, '有可用摘要就露卡')
    assert.equal(h.rows[0].cell.textContent, '3 个 BOT 与群')
    assert.equal(h.rows[1].cell.textContent, '4 个工作区')
    assert.equal(h.rows[2].cell.textContent, '4 个会话')
    assert.equal(h.rows[3].cell.textContent, '3 条消息')
    assert.equal(h.ovState[4], -1, '第 5 格（就绪文案）未就绪前不写')
    assert.equal(h.rows[4].cell.textContent.includes('已就绪'), false, '末行不许写「已就绪」')
    // 纵深防御的 fail-closed 路（经过门内写数后公开路径已不可达，靠改写替身状态覆盖）：
    // 四格里缺一格 ⇒ halt 收卡、不写「已就绪」、已定稿的读数不被补写成占位 0（判据 R15-5）。
    h.ovState[3] = -1
    h.ovReady()
    assert.equal(h.overlay.hidden, true, '还有行没读到真值 ⇒ halt 并收卡离场')
    assert.equal(h.rows[4].cell.textContent.includes('已就绪'), false, '末行不许写「已就绪」')
    assert.equal(h.rows[3].cell.textContent, '3 条消息', '收口时不许改写已定稿的读数，也不补写占位 0')
  } finally {
    h.stop()
  }
})

test('没有可用摘要的那一趟不显示冷启动卡，四格一格都不成值（判据 R15-2.2 乙）', () => {
  // 重新进那趟（shell 形状）只有 stageSummary 可用：字段整块缺失、ready:false、三格缺一、
  // 或某一格不是数，都不许露这张卡——宁可不显示，也不显示一张写假值的卡。旧实现只数
  // 「有没有 .boot-step 行」，于是这样一趟会露出三格 0＋末格 ovFail 补写的字符串 0。
  const bad = [
    ['摘要整块缺失', {}],
    ['ready 为 false（冷摘要）', { stageSummary: { ready: false, workspaces: 0, sessions: 0, messages: 0 } }],
    ['三格缺一', { stageSummary: { ready: true, workspaces: 1, sessions: 2 } }],
    ['有一格不是数', { stageSummary: { ready: true, workspaces: '1', sessions: 2, messages: 3 } }],
  ]
  for (const [why, bootPayload] of bad) {
    const h = harness({ bootPayload })
    try {
      assert.equal(h.overlay.hidden, true, `${why}：这张卡不该显形`)
      assert.equal(h.ovLadder, null, `${why}：没有可用摘要就没有阶梯在跑`)
      h.tick(2000)
      assert.equal(h.overlay.hidden, true, `${why}：不会过一会儿又自己露出来`)
      assert.deepEqual(h.ovState, [-1, -1, -1, -1, -1], `${why}：五格一格都不许被写成读数`)
    } finally {
      h.stop()
    }
  }
})

test('读数跟着摘要走：页面画了几行都不改卡上的数，payload 与摘要各管各的', () => {
  const a = harness({ cards: 1, rows: 2, payloadWs: 9, payloadRows: 402, bootPayload: { stageSummary: { ready: true, workspaces: 1, sessions: 2, messages: 3, bots: 4, botSessions: 5, rooms: 1 } } })
  try {
    advance(a)
    assert.equal(a.ovState[0], 5)
    assert.equal(a.ovState[1], 1)
    assert.equal(a.ovState[2], 2)
    assert.equal(a.ovState[3], 3)
    assert.equal(a.rows[1].cell.textContent, '1 个工作区')
  } finally {
    a.stop()
  }

  const b = harness({ cards: 7, rows: 9, payloadWs: 1, payloadRows: 2, bootPayload: { stageSummary: { ready: true, workspaces: 7, sessions: 9, messages: 1, bots: 2, botSessions: 3, rooms: 1 } } })
  try {
    advance(b)
    assert.equal(b.ovState[0], 3)
    assert.equal(b.ovState[1], 7)
    assert.equal(b.ovState[2], 9)
    assert.equal(b.ovState[3], 1)
    assert.equal(b.rows[2].cell.textContent, '9 个会话')
    assert.equal(b.rows[3].cell.textContent, '1 条消息')
  } finally {
    b.stop()
  }

  // 空工作区那条出口：读出来就是 0，0 是这一趟的真实读数（与 L2 的 -1 区分开）。
  const c = harness({ cards: 0, rows: 0, payloadWs: 4, payloadRows: 402, bootPayload: { stageSummary: { ready: true, workspaces: 0, sessions: 0, messages: 3, bots: 0, botSessions: 0, rooms: 0 } } })
  try {
    advance(c)
    assert.equal(c.ovState[0], 0)
    assert.equal(c.ovState[1], 0)
    assert.equal(c.ovState[2], 0)
    assert.equal(c.ovState[3], 3)
    assert.equal(c.rows[1].cell.textContent, '0 个工作区')
    assert.equal(c.rows[2].cell.textContent, '0 个会话')
  } finally {
    c.stop()
  }
})

test('反方向：DOM 画的与摘要不一致时，卡上只认摘要', () => {
  // 判据 v7 §3：页面侧只许「确认」（不一致以摘要为准 + 控制台留痕），不许反过来拿 DOM 顶数。
  // 替身故意让画出来的卡片/行数与摘要完全相反，读数必须仍是摘要那三个数。
  const h = harness({ cards: 99, rows: 99, payloadWs: 1, payloadRows: 1, bootPayload: { stageSummary: { ready: true, workspaces: 2, sessions: 3, messages: 5, bots: 4, botSessions: 6, rooms: 2 } } })
  try {
    advance(h)
    assert.equal(h.ovState[0], 6, '摘要说 6 个 BOT 与群，DOM 画的 99 张不算数')
    assert.equal(h.ovState[1], 2, '摘要说 2 个工作区，DOM 画的 99 张不算数')
    assert.equal(h.ovState[2], 3, '摘要说 3 行会话，DOM 画的 99 行不算数')
    assert.equal(h.ovState[3], 5, '摘要说 5 条消息')
    assert.equal(h.rows[0].cell.textContent, '6 个 BOT 与群')
    assert.equal(h.rows[1].cell.textContent, '2 个工作区')
    assert.equal(h.rows[2].cell.textContent, '3 个会话')
    assert.equal(h.rows[3].cell.textContent, '5 条消息')
  } finally {
    h.stop()
  }
})

// ---------------------------------------------------------------------------
// T7 单测 4：三面行序与行数（同一个表，三个面各自的行集）
// ---------------------------------------------------------------------------

/** 页面脚本里序列化的那张行表（唯一来源就是 lib/pages.js 的文案表）。 */
function stageRowsOfPage(html) {
  const at = html.indexOf('const STAGE_ROWS=')
  assert.ok(at > 0, '每一面都从同一个表派生出自己的行集')
  const end = html.indexOf(';const labels=', at)
  assert.ok(end > at, '行集紧跟着就是 labels 的推导')
  return JSON.parse(html.slice(at + 'const STAGE_ROWS='.length, end))
}

const ROW_LABELS = [
  '同步 BOT 与群',
  '同步工作区',
  '同步会话列表',
  '同步消息数量',
  '准备页面',
]

test('单测 4：主页启动卡 5 行，标签逐字且按表序', () => {
  const rows = botToPocketRows(true)
  assert.deepEqual(rows.map((row) => row.label), ROW_LABELS, '主页是五行：BOT 与群在最前，准备页面在最后')
  assert.equal(rows.length, 5, '行数由表长决定，不是写死的 4')
  const html = renderMobilePage({ locale: 'zh', boot: null })
  const painted = [...html.matchAll(/<div class="boot-step[^"]*"><span class="boot-step-label">([^<]*)<\/span>/g)]
    .map((m) => m[1])
  assert.deepEqual(painted, ROW_LABELS, '出货文档里真的画了这五行，顺序一致')
  const units = [...html.matchAll(/class="bsc" data-unit="([^"]*)"/g)].map((m) => m[1])
  assert.deepEqual(units, [' 个 BOT 与群', ' 个工作区', ' 个会话', ' 条消息', ''],
    '每一格带着自己那行的量词；末行没有量词（它是「准备页面」，不数东西）')
})

test('单测 4：PIN 页 6 行＝连接行 + 五行表', () => {
  const html = renderPairingPinPage('zh')
  const rows = stageRowsOfPage(html)
  assert.deepEqual(rows.map((row) => row.label), ROW_LABELS, 'PIN 也吃同一张表')
  assert.ok(html.includes('"stepServer":"正在连接服务器"'), '连接行是 PIN 面独有的那一行，文案仍是原文')
  const labelsSource = html.slice(html.indexOf('const labels='), html.indexOf('const lastRow='))
  assert.ok(/stepServer/.test(labelsSource), 'labels 的第一项是连接行')
  assert.ok(/STAGE_ROWS\.map/.test(labelsSource), '其余 5 行从表里来，不是手抄')
  assert.equal(6, rows.length + 1, '连接行 + 表五行 = 六行阶梯')
})

test('单测 4：重连页 5 行＝表本身，没有连接行', () => {
  const html = renderMobileReconnectPage('zh')
  const rows = stageRowsOfPage(html)
  assert.deepEqual(rows.map((row) => row.label), ROW_LABELS, '重连面与主页同一组标签')
  assert.equal(rows.length, 5, '五行的阶梯')
  assert.equal(/"stepServer":/.test(html), false, '重连面没有连接行——那是 PIN 面独有的')
  const labelsSource = html.slice(html.indexOf('const labels='), html.indexOf('const lastRow='))
  assert.ok(/STAGE_ROWS\.map/.test(labelsSource), 'labels 直接由表推出')
  assert.equal(/stepWorkspace|stepSessionList|stepSession|stepPrepare/.test(labelsSource), false,
    '四条手抄的 step* 已经退场，行文案只有表一个来源')
})

test('单测 4：三面的数字格落在自己那一行（PIN 2..4，重连 1..3）', () => {
  for (const [html, base] of [
    [renderPairingPinPage('zh'), 2],
    [renderMobileReconnectPage('zh'), 1],
  ]) {
    const table = stageRowsOfPage(html)
    // 这一面真正画出来的标签序列：PIN 在表前多一行连接行，重连没有。
    const labels = /"stepServer":/.test(html) ? ['正在连接服务器', ...table.map((row) => row.label)] : table.map((row) => row.label)
    assert.equal(labels[0], base === 2 ? '正在连接服务器' : '同步 BOT 与群', 'BOT 与群那一行在表首；PIN 的连接行在它前面')
    const botRow = labels.indexOf('同步 BOT 与群')
    assert.equal(botRow, base - 1, `BOT 与群那一行是第 ${base - 1} 格，工作区紧跟在它后面`)
    for (const [offset, label] of ['同步工作区', '同步会话列表', '同步消息数量'].entries()) {
      assert.equal(labels[base + offset], label, `第 ${base + offset} 格是「${label}」`)
      const unit = table.find((row) => row.label === label).unit
      assert.ok(unit && unit.length > 0, `「${label}」这一格带量词（它数东西）`)
    }
    assert.equal(labels[labels.length - 1], '准备页面', '末行永远是准备页面')
  }
})
