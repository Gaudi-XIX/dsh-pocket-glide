// 两个 B 系 bug 的行为断言（复跑判据是行为，不是源码文本）。
//
// 1) 设置面板自绘列表「点了收不回」。根因在 togglePickField：第二次点同一字段时
//    settingsPick 已被清空，但循环体拿传进来的 field 做比较，等于把面板按「打开」
//    重写一遍——所以从 0.4.14 自绘列表落地起，关闭分支从未真正执行过。现在循环比对的
//    是 settingsPick（当前值），不是 field（本次点击值）。
// 2) 停在会话中上部阅读时，AI 推进来屏幕「抖一下就扯过去」。根因在 restoreTranscriptAnchor
//    的 Math.min(anchor.index, rows.length-1)：列表正在重渲、行数少于锚点记录时，索引被钳
//    到末行，拿一个和锚点毫无关系的行当基准写 scrollTop。真机取证（kbprobe，2026-10-11
//    19:47）：rs@19930 把 scrollTop 写到 188，当时真实位置 1151；120ms 后 rs@20050 写到 969，
//    写入瞬间 scrollHeight 只有 2274/3401，真实内容 3562+。现在行数不够就跳过这次写入，
//    交 120ms 重试等布局稳定，绝不照错行写。
//
// house pattern 见 question-no-gesture-no-submit.test.js 头部：把真实函数文本抽进沙箱跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })

function slice(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle)
  assert.notEqual(start, -1, `${startNeedle} must exist in the rendered asset`)
  const end = source.indexOf(endNeedle, start)
  assert.notEqual(end, -1, `${endNeedle} must follow ${startNeedle}`)
  return source.slice(start, end)
}

// ─── 1) togglePickField ────────────────────────────────────────────────

const TOGGLE = slice(js, 'function togglePickField(field){', 'function applyPick(field,value)')

function buildToggle() {
  const pickModel = { dataset: { pick: 'model' }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v } }
  const listModel = { dataset: { field: 'model' }, hidden: true, innerHTML: '' }
  const pickPreset = { dataset: { pick: 'preset' }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v } }
  const listPreset = { dataset: { field: 'preset' }, hidden: true, innerHTML: '' }
  const all = [pickModel, listModel, pickPreset, listPreset]
  const box = { querySelectorAll(sel) { return sel === '[data-pick],[data-field]' ? all : [] } }
  // T8: togglePickField now lazy-fills the list on first open instead of
  // pre-building every model button at render time. Inject a stub so the
  // sandbox can call pickRows without needing modelCatalog/presets.
  const make = new Function('$', 'pickRows', `let settingsPick='';${TOGGLE};return {togglePickField,peek:()=>settingsPick}`)
  const api = make(() => box, (field) => field + '-rows')
  return { ...api, pickModel, listModel, pickPreset, listPreset }
}

test('pick toggle: 再点一次同一字段把面板收回去', () => {
  const t = buildToggle()
  t.togglePickField('model')
  assert.equal(t.peek(), 'model')
  assert.equal(t.pickModel.attrs['aria-expanded'], true)
  assert.equal(t.listModel.hidden, false)
  // T8: the list is filled lazily on first open, not pre-built at render.
  assert.equal(t.listModel.dataset.built, '1')
  assert.equal(t.listModel.innerHTML, 'model-rows')
  t.togglePickField('model')
  assert.equal(t.peek(), '')
  assert.equal(t.pickModel.attrs['aria-expanded'], false)
  assert.equal(t.listModel.hidden, true)
})

test('pick toggle: 点开另一个字段时原来的收回去', () => {
  const t = buildToggle()
  t.togglePickField('model')
  t.togglePickField('preset')
  assert.equal(t.peek(), 'preset')
  assert.equal(t.pickModel.attrs['aria-expanded'], false)
  assert.equal(t.listModel.hidden, true)
  assert.equal(t.pickPreset.attrs['aria-expanded'], true)
  assert.equal(t.listPreset.hidden, false)
  // T8: preset list also filled lazily.
  assert.equal(t.listPreset.dataset.built, '1')
  assert.equal(t.listPreset.innerHTML, 'preset-rows')
})

// ─── 2) restoreTranscriptAnchor ────────────────────────────────────────

const RESTORE = slice(js, 'function restoreTranscriptAnchor(box,anchor,tries,turn){', '// 键盘收/放')

function buildRestore(rows, boxTop = 0) {
  const marks = []
  const box = {
    scrollTop: 100,
    __settleTurn: 0,
    querySelectorAll() { return rows },
    getBoundingClientRect() { return { top: boxTop } },
  }
  const make = new Function('$', 'probeMark', 'followStream', 'setTimeout', `${RESTORE};return restoreTranscriptAnchor`)
  // tries 传 0，重试链不进 setTimeout，测的就是当下这一次写入决策。
  const restore = make(() => ({ isConnected: true }), (tag) => marks.push(tag), false, () => {})
  return { restore, box, marks }
}

const row = (top) => ({ getBoundingClientRect: () => ({ top }) })

test('anchor restore: 行数少于锚点记录时不写 scrollTop（重渲中间态）', () => {
  const { restore, box, marks } = buildRestore([row(10), row(50), row(90)])
  const ok = restore(box, { index: 5, offset: 50 }, 0)
  assert.equal(ok, true)
  assert.equal(box.scrollTop, 100)
  assert.deepEqual(marks, [])
})

test('anchor restore: 锚点行还在且已偏离时照常回写', () => {
  const { restore, box, marks } = buildRestore([row(10), row(200), row(320)])
  restore(box, { index: 1, offset: 50 }, 0) // delta = 200-0-50 = 150
  assert.equal(box.scrollTop, 250)
  assert.deepEqual(marks, ['rs'])
})

test('anchor restore: 锚点行已对齐时不写', () => {
  const { restore, box, marks } = buildRestore([row(10), row(50), row(90)])
  restore(box, { index: 1, offset: 50 }, 0) // delta = 50-0-50 = 0
  assert.equal(box.scrollTop, 100)
  assert.deepEqual(marks, [])
})

// ─── 3) settleOlderShift ───────────────────────────────────────────────
//
// 补页（拉到顶边加载更早的历史）时视口会「跳几下」。根因是旧行带
// content-visibility:auto（.msg-hist，contain-intrinsic-size 每行按 120px 估算）：
// fetchOlderPage 拼完当场量到的 scrollHeight 是估的，对位按估值算；继续上滑时行被真渲染、
// 高度再变一次，视口就跟着动。所以拼完那一次对位不够，要在估值变真值的几个时点各重量一次。
//
// 与上面那条（restoreTranscriptAnchor）的分工：那条守的是「重渲中间态行数不足，别照错行写」，
// 这条守的是「行数齐了但高度还是估的，按当下真实布局重瞄」。两者共用 transcriptAnchor。

const SETTLE = slice(js, 'function settleOlderShift(box,anchor,tries,turn){', '// 键盘收/放')

// rows 可以是数组，也可以是函数（每次查询返回不同行高，模拟「估高→真高」）。
// $('messages') 默认返回 box 本身：settleOlderShift 第一道守卫就是 live!==box（会话已切走就不写）。
// 传 opts.realTimers=true 时用真 setTimeout，专门测「重试链自己会再量一次」那条路径。
function buildSettle(rowsOrFn, boxTop = 0, opts = {}) {
  const marks = []
  const box = {
    scrollTop: 100,
    isConnected: true,
    __settleTurn: 0,
    querySelectorAll() { return typeof rowsOrFn === 'function' ? rowsOrFn() : rowsOrFn },
    getBoundingClientRect() { return { top: boxTop } },
  }
  const timers = []
  const schedule = opts.realTimers
    ? (fn, ms) => { timers.push({ fn, ms }); return timers.length }
    : () => {}
  const make = new Function(
    '$', 'probeMark', 'setTimeout', 'readTranscriptAnchor',
    `let transcriptAnchor=null;` +
    `${SETTLE};return {settleOlderShift,peek:()=>transcriptAnchor}`
  )
  const api = make(
    () => (opts.staleBox ? { isConnected: true } : box),
    (tag) => marks.push(tag),
    schedule, // 传 tries=1：跑当下这一次、不进重试链（settleOlderShift 的守卫是 tries<=0 直接返回）
    (b) => ({ index: 0, offset: b.scrollTop })
  )
  return { ...api, box, marks, timers }
}

test('older settle: 行数不足时不动（和 restore 同一条纪律）', () => {
  const { settleOlderShift, box, marks } = buildSettle([row(10), row(50)])
  settleOlderShift(box, { index: 5, offset: 50 }, 1)
  assert.equal(box.scrollTop, 100)
  assert.deepEqual(marks, [])
})

test('older settle: 补进来的旧行把锚点顶下去时，按真实布局对回来', () => {
  const { settleOlderShift, box, marks } = buildSettle([row(10), row(230)])
  settleOlderShift(box, { index: 1, offset: 50 }, 1) // delta = 230-0-50 = 180
  assert.equal(box.scrollTop, 280)
  assert.deepEqual(marks, ['ol'])
})

test('older settle: 估高转真高只差几像素时不写（抖动是像素级）', () => {
  const { settleOlderShift, box, marks } = buildSettle([row(10), row(52)])
  settleOlderShift(box, { index: 1, offset: 50 }, 1) // delta = 2，未过 2px 门槛
  assert.equal(box.scrollTop, 100)
  assert.deepEqual(marks, [])
})

test('older settle: 写完立刻用当下布局重读锚点，重试链跟住真实高度', () => {
  let heights = [row(10), row(230)]
  const { settleOlderShift, peek, box } = buildSettle(() => heights)
  settleOlderShift(box, { index: 1, offset: 50 }, 1)
  assert.equal(box.scrollTop, 280)
  // readTranscriptAnchor 的桩返回 offset = 当下的 scrollTop ⇒ 锚点被重新读了。
  assert.deepEqual(peek(), { index: 0, offset: 280 })
})

test('older settle: 会话已切走（box 不是当前 #messages）时一个字都不写', () => {
  const { settleOlderShift, box, marks } = buildSettle([row(10), row(230)], 0, { staleBox: true })
  settleOlderShift(box, { index: 1, offset: 50 }, 1)
  assert.equal(box.scrollTop, 100)
  assert.deepEqual(marks, [])
})
