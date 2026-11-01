// 冷启动卡（#bootOverlay）的计数口径——判据 L1／L2／L3。
//
// 真机上坏的是「读数从哪儿来」：
//   ① 卡上第二行报 78，同一时刻页面作用域里 sessionSummaries.length=402、DOM 里真正画出来
//      的会话行只有 4 行——取的是「payload 全量长度」这种和屏幕无关的数；
//   ② 这一趟 boot 没带 tails 时第三行把 0 定稿成读数，读到 0 与根本没读到在界面上无法区分。
//
// 取样点：出货页里冷启动卡那一段（`const bootOv=$('bootOverlay')` 起、`const boot=takeHandoffBoot()`
// 止）是在 renderWorkspaces() 画完之后才被调的（IIFE 末尾 `if(bootListPartial)…;ovData(boot?.tails);
// ovReady()`），所以直接读 DOM（`.ws-card`／`.task-row` 的 length）拿到的就是这一趟画完的样子，
// 与「画出来的行数」同口径：不在渲染函数里插桩，也不读 payload 数组的长度。
//
// 这里跑的是出货页里的真源码：head 注入的 `ladderRun` 定义 + 上面那一段卡片源码，两段都是从
// renderMobilePage() 的真输出里切出来的。替身只替 DOM／时钟／存储，不替逻辑；替身还特意把
// 402 行的 `sessionSummaries` 一起喂进去当诱饵——谁要退回去读 payload 长度，下面的断言立刻红。
// 三条用例都是行为断言（读 stubbed DOM 与阶梯行文本），不按源码正则断言。
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
  const end = block.indexOf('const boot=takeHandoffBoot()')
  assert.ok(end > start, '出货页里冷启动卡那一段的首尾锚点对不上')
  return block.slice(start, end)
}

// 每条阶梯行的替身：真页面里 ladderRun 通过 row.querySelector('.bsc') 拿格子，再用
// cell.dataset.unit / cell.textContent / cell._final / cell._scan 记账。
function fakeRows() {
  return ROWS.map((spec) => {
    const cell = {
      textContent: spec.start ? spec.start : '0' + spec.unit,
      dataset: { unit: spec.unit },
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

// 两趟会话、共 3 条消息（另带 1 条非消息事件，用来证明不是「数事件条数」）。
const TAILS = {
  'sess-a': { events: [{ event: { type: 'user/message' } }, { event: { type: 'assistant/message' } }] },
  'sess-b': { events: [{ type: 'assistant/message' }, { type: 'tool/output' }] },
}

function harness({ cards = 4, rows = 4, payloadWs = 4, payloadRows = 402 } = {}) {
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

test('L1 第一、二行取这一趟画出来的行数，不取 payload 全量长度', () => {
  const h = harness({ cards: 4, rows: 4, payloadWs: 4, payloadRows: 402 })
  try {
    assert.equal(h.overlay.hidden, false, '冷启动这一趟卡必须显形')
    h.ovData(TAILS)
    advance(h)
    assert.equal(h.ovState[0], 4, '第一行＝画出来的 4 张 .ws-card')
    assert.equal(h.ovState[1], 4, '第二行＝画出来的 4 行 .task-row，不是 payload 的 402 行')
    assert.equal(h.rows[0].cell.textContent, '4 个工作区')
    assert.equal(h.rows[1].cell.textContent, '4 个会话')
    assert.equal(h.rows[2].cell.textContent, '3 条消息')
    assert.equal(h.rows[0].cell._final, true)
    assert.equal(h.rows[1].cell._final, true)
    h.ovReady()
    assert.equal(h.rows[3].cell.textContent, '已就绪')
    h.tick(500)
    assert.equal(h.overlay.hidden, true, '末行写「已就绪」并停留之后才收卡')
  } finally {
    h.stop()
  }
})

test('L2 没拿到真值的行不落 0、末行不写「已就绪」、fail-closed 收卡', () => {
  const h = harness({ cards: 2, rows: 6 })
  try {
    h.ovData(undefined)
    advance(h)
    assert.equal(h.ovState[0], 2)
    assert.equal(h.ovState[1], 6)
    assert.equal(h.rows[1].cell.textContent, '6 个会话')
    assert.equal(h.ovState[2], -1, '这一趟没有 tails 就是 -1（未读到），不是 0')
    assert.equal(h.rows[2].cell._final, false, '第三行不许被定稿成 0')
    assert.equal(h.rows[2].row._done, false)
    assert.notEqual(h.rows[2].cell._scan, null, '第三行还在滚：读数没成立')
    h.ovReady()
    assert.equal(h.overlay.hidden, true, '还有行没读到真值 ⇒ halt 并收卡离场')
    assert.equal(h.rows[3].cell.textContent.includes('已就绪'), false, '末行不许写「已就绪」')
    assert.equal(h.rows[2].cell.textContent, '0 条消息', '收口时落回占位 0＋单位，不当读数')
  } finally {
    h.stop()
  }
})

test('读数跟着这一趟画出来的样子走：换 DOM 计数就换读数，payload 与 tails 各管各的', () => {
  const a = harness({ cards: 1, rows: 2, payloadWs: 9, payloadRows: 402 })
  try {
    a.ovData(TAILS)
    advance(a)
    assert.equal(a.ovState[0], 1)
    assert.equal(a.ovState[1], 2)
    assert.equal(a.ovState[2], 3)
    assert.equal(a.rows[0].cell.textContent, '1 个工作区')
  } finally {
    a.stop()
  }

  const b = harness({ cards: 7, rows: 9, payloadWs: 1, payloadRows: 2 })
  try {
    b.ovData({ only: { events: [{ event: { type: 'assistant/message' } }] } })
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
  const c = harness({ cards: 0, rows: 0, payloadWs: 4, payloadRows: 402 })
  try {
    c.ovData(TAILS)
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
