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
import { botToPocketRows, renderMobilePage } from '../lib/pages.js'

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

// 四张卡读的就是这一份：ready + 三格数字（判据 v7 §3 的七键里本页适用的四个）。
const SUMMARY = { ready: true, workspaces: 4, sessions: 4, messages: 3 }

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
    assert.equal(h.rows[0].cell.textContent, '4 个工作区', '露卡那一帧第一格就是真值（判据 1／3a）')
    assert.equal(h.rows[1].cell.textContent, '4 个会话', '露卡那一帧第二格就是真值')
    assert.equal(h.rows[2].cell.textContent, '3 条消息', '露卡那一帧第三格就是真值')
    assert.equal(h.rows[0].cell._final, true, '第一格出生即定稿')
    assert.equal(h.rows[1].cell._final, true, '第二格出生即定稿')
    assert.equal(h.rows[2].cell._final, true, '第三格出生即定稿')
    assert.equal(h.rows[3].cell.textContent.includes('已就绪'), false, '出生不写末行')
    assert.equal(h.ovState[0], 4, '第一行＝boot 摘要的 4 张 .ws-card')
    assert.equal(h.ovState[1], 4, '第二行＝boot 摘要的 4 行 .task-row，不是 payload 的 402 行')
    h.ovReady()
    assert.equal(h.rows[3].cell.textContent, '已就绪')
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
    assert.equal(h.rows[0].cell.textContent, '4 个工作区')
    assert.equal(h.rows[1].cell.textContent, '4 个会话')
    assert.equal(h.rows[2].cell.textContent, '3 条消息')
    assert.equal(h.ovState[3], -1, '第 4 格（就绪文案）未就绪前不写')
    assert.equal(h.rows[3].cell.textContent.includes('已就绪'), false, '末行不许写「已就绪」')
    // 纵深防御的 fail-closed 路（经过门内写数后公开路径已不可达，靠改写替身状态覆盖）：
    // 前三格缺真值 ⇒ halt 收卡、不写「已就绪」、已定稿的读数不被补写成占位 0（判据 R15-5）。
    h.ovState[2] = -1
    h.ovReady()
    assert.equal(h.overlay.hidden, true, '还有行没读到真值 ⇒ halt 并收卡离场')
    assert.equal(h.rows[3].cell.textContent.includes('已就绪'), false, '末行不许写「已就绪」')
    assert.equal(h.rows[2].cell.textContent, '3 条消息', '收口时不许改写已定稿的读数，也不补写占位 0')
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
      assert.deepEqual(h.ovState, [-1, -1, -1, -1], `${why}：四格一格都不许被写成读数`)
    } finally {
      h.stop()
    }
  }
})

test('读数跟着摘要走：页面画了几行都不改卡上的数，payload 与摘要各管各的', () => {
  const a = harness({ cards: 1, rows: 2, payloadWs: 9, payloadRows: 402, bootPayload: { stageSummary: { ready: true, workspaces: 1, sessions: 2, messages: 3 } } })
  try {
    advance(a)
    assert.equal(a.ovState[0], 1)
    assert.equal(a.ovState[1], 2)
    assert.equal(a.ovState[2], 3)
    assert.equal(a.rows[0].cell.textContent, '1 个工作区')
  } finally {
    a.stop()
  }

  const b = harness({ cards: 7, rows: 9, payloadWs: 1, payloadRows: 2, bootPayload: { stageSummary: { ready: true, workspaces: 7, sessions: 9, messages: 1 } } })
  try {
    advance(b)
    assert.equal(b.ovState[0], 7)
    assert.equal(b.ovState[1], 9)
    assert.equal(b.ovState[2], 1)
    assert.equal(b.rows[1].cell.textContent, '9 个会话')
    assert.equal(b.rows[2].cell.textContent, '1 条消息')
  } finally {
    b.stop()
  }

  // 空工作区那条出口：读出来就是 0，0 是这一趟的真实读数（与 L2 的 -1 区分开）。
  const c = harness({ cards: 0, rows: 0, payloadWs: 4, payloadRows: 402, bootPayload: { stageSummary: { ready: true, workspaces: 0, sessions: 0, messages: 3 } } })
  try {
    advance(c)
    assert.equal(c.ovState[0], 0)
    assert.equal(c.ovState[1], 0)
    assert.equal(c.ovState[2], 3)
    assert.equal(c.rows[0].cell.textContent, '0 个工作区')
    assert.equal(c.rows[1].cell.textContent, '0 个会话')
  } finally {
    c.stop()
  }
})

test('反方向：DOM 画的与摘要不一致时，卡上只认摘要', () => {
  // 判据 v7 §3：页面侧只许「确认」（不一致以摘要为准 + 控制台留痕），不许反过来拿 DOM 顶数。
  // 替身故意让画出来的卡片/行数与摘要完全相反，读数必须仍是摘要那三个数。
  const h = harness({ cards: 99, rows: 99, payloadWs: 1, payloadRows: 1, bootPayload: { stageSummary: { ready: true, workspaces: 2, sessions: 3, messages: 5 } } })
  try {
    advance(h)
    assert.equal(h.ovState[0], 2, '摘要说 2 个工作区，DOM 画的 99 张不算数')
    assert.equal(h.ovState[1], 3, '摘要说 3 行会话，DOM 画的 99 行不算数')
    assert.equal(h.ovState[2], 5, '摘要说 5 条消息')
    assert.equal(h.rows[0].cell.textContent, '2 个工作区')
    assert.equal(h.rows[1].cell.textContent, '3 个会话')
    assert.equal(h.rows[2].cell.textContent, '5 条消息')
  } finally {
    h.stop()
  }
})
