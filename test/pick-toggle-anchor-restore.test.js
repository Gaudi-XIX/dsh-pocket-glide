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

function buildRestore(rows, boxTop = 0, opts = {}) {
  const marks = []
  const box = {
    isConnected: true,
    scrollTop: 100,
    scrollHeight: 2000,
    clientHeight: 700,
    __settleTurn: 0,
    querySelectorAll() { return rows },
    getBoundingClientRect() { return { top: boxTop } },
  }
  const timers = []
  const schedule = opts.chain
    ? (fn) => { timers.push(fn); return timers.length }
    : () => {}
  const make = new Function('$', 'probeMark', 'followStream', 'setTimeout', 'SCROLL_FOLLOW_PX', `${RESTORE};return restoreTranscriptAnchor`)
  // tries 传 0，重试链不进 setTimeout，测的就是当下这一次写入决策。
  // 传 opts.chain 时 $ 必须回同一个 box：重试链的守卫要读 live.__settleTurn（新造一个对象就对不上令牌）。
  const restore = make(() => box, (tag) => marks.push(tag), false, schedule, 120)
  return { restore, box, marks, timers, tick: () => timers.shift()() }
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

// R1（用户 m00002「还是有页面跳跃」）：120ms×3 的重试链原来无条件把锚点写回去，
// 读者在这 360ms 内的滚动被逐次覆盖。真机 4 组、每组 3–4 次 rs，间隔恒 116–126ms。
test('anchor restore: 重试之间读者自己挪走了且离开跟随带时不再拽回', () => {
  const s = buildRestore([row(10), row(200), row(320)], 0, { chain: true })
  s.restore(s.box, { index: 1, offset: 50 }, 3) // delta = 150 ⇒ 写到 250
  assert.equal(s.box.scrollTop, 250)
  assert.deepEqual(s.marks, ['rs'])
  s.marks.length = 0
  // 读者在 120ms 内上滑到 900（sh 2000 − 900 − ch 700 = 400 > 120 ⇒ 确实离开底带）。
  s.box.scrollTop = 900
  s.tick()
  assert.equal(s.box.scrollTop, 900, 'the reader keeps his position')
  assert.deepEqual(s.marks, ['rx'], 'and the escape is stamped')
  assert.equal(s.timers.length, 0, 'the chain terminates — no further pull')
})

test('anchor restore: 重试之间只是被布局钳位（仍在底带内）时照旧校正', () => {
  const s = buildRestore([row(10), row(200), row(320)], 0, { chain: true })
  s.restore(s.box, { index: 1, offset: 50 }, 3) // 写到 250
  s.marks.length = 0
  // 内容塌陷/视口变高把 scrollTop 钳到 240：距上次写入 <2px 门槛之外但仍在底带内
  // （2000−240−700=1060 > 120 不成立才走这条——所以用离底 60 的几何）。
  s.box.scrollHeight = 1000
  s.box.scrollTop = 240
  s.tick() // 距上次写入 10px、离底 1000−240−700=60 ≤ 120 ⇒ 继续校正
  assert.deepEqual(s.marks, ['rs'], 'a clamp is not a reader gesture')
  assert.equal(s.box.scrollTop, 240 + (200 - 0 - 50), 're-measured against the current layout')
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
    isConnected: true,
    scrollTop: 100,
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

// ─── 4) settleTailStick 的读者出口（m02164③ 三轮返工）───────────────────
//
// 贴底链每 120ms 写一次底，每轮都给 programmaticScroll 的 250ms 静默窗续期，
// 于是滚动监听里 followStream 永不重判：读者往上滑的动作被吞掉，下一 tick 又被
// 钉回底＝橡皮筋（用户 2026-10-15 口述「滑动的时候有跳动」）。本壳写的是底
// （scrollTop = scrollHeight），所以「内容长高」只增 scrollHeight 不动 scrollTop，
// scrollTop 变小只可能是读者动过手——这就是出口的判据。
// 判据不能只看「变小」：视口变高时浏览器会把 scrollTop 往新的最大值钳一次（实测
// 450→735 时 1541→1256），那不是读者的意图，所以再加「离底已超 SCROLL_FOLLOW_PX」。
const TAILSTICK = slice(js, 'function settleTailStick(box,tries,turn,pinned){', '// 返工③补')
const SCROLL_FOLLOW_PX = Number(js.match(/const SCROLL_FOLLOW_PX=(\d+),/)[1])

function buildTailStick(start) {
  const marks = []
  const timers = []
  const box = { scrollTop: start, scrollHeight: 2000, clientHeight: 700, isConnected: true, __settleTurn: 0 }
  const make = new Function(
    '$', 'probeMark', 'setTimeout', 'readTranscriptAnchor', 'programmaticScroll', 'SCROLL_FOLLOW_PX',
    `let followStream=true,transcriptAnchor=null;` +
    `${TAILSTICK};return {settleTailStick,follow:()=>followStream,anchor:()=>transcriptAnchor}`
  )
  const api = make(
    () => box,
    (tag) => marks.push(tag),
    (fn) => { timers.push(fn) },
    (b) => ({ index: 0, offset: b.scrollTop }),
    () => {},
    SCROLL_FOLLOW_PX
  )
  return { ...api, box, marks, timers, tick: () => timers.shift()() }
}

test('tail stick: 首趟没有 pinned，照旧钉到底并带着写下的值继续', () => {
  const s = buildTailStick(1000)
  s.settleTailStick(s.box, 4)
  assert.equal(s.timers.length, 1, 'the entry pass only schedules — the paint wrote the bottom before it')
  s.tick()
  assert.equal(s.box.scrollTop, 2000, 're-stuck to the bottom')
  assert.deepEqual(s.marks, ['ts'])
  s.tick()
  assert.deepEqual(s.marks, ['ts', 'ts'], 'and each pass stamps, carrying the value it wrote')
})

// R4（2026-10-20 m01972「刚刚又跳了」）：入口那趟不带 pinned，读者出口从第二趟才生效，
// 于是贴底写后 120ms 内读者一滑走就被钉回去一次＝橡皮筋（真机 22:42:34
// `sc…→4577 jk@737279|551 ts@737279|5128`，123ms 后 `rl` 才解除）。
// 现在入口把「此刻的 scrollTop」记成 pinned（调用它的那次贴底写刚写完这个值），
// 首趟就能比对；内容长高只增 scrollHeight 不动 scrollTop，所以合法重钉不受影响。
test('tail stick: 入口即记下 pinned——贴底写后第一趟读者已滑走就不再钉回', () => {
  const s = buildTailStick(1000)
  s.settleTailStick(s.box, 4)
  const queuedBefore = s.timers.length
  s.box.scrollTop = 500 // 读者在 120ms 窗内滑走
  s.tick()
  assert.equal(s.follow(), false, 'the escape fires on the first pass, not the second')
  assert.deepEqual(s.marks, ['rl'], 'and it is stamped')
  assert.equal(s.box.scrollTop, 500, 'the reader keeps his position — the first pass does not re-stick')
  assert.equal(s.timers.length, queuedBefore - 1, 'the chain terminates on the first pass')
})

test('tail stick: 读者把页面拽离底部时链条自己解除跟随并终止', () => {
  const s = buildTailStick(1000)
  s.settleTailStick(s.box, 4)
  s.tick() // 写入 pinned = 2000
  s.marks.length = 0
  const queuedBefore = s.timers.length
  // 读者上滑：scrollTop 比上次写入值小，且离底远超 SCROLL_FOLLOW_PX。
  s.box.scrollTop = 500
  s.tick()
  assert.equal(s.follow(), false, 'the follow is dropped, not re-armed behind his back')
  assert.notEqual(s.anchor(), null, 'the row he is reading becomes the anchor for a later repaint')
  assert.deepEqual(s.marks, ['rl'], 'and the escape is stamped')
  assert.equal(s.timers.length, queuedBefore - 1, 'the chain terminates — it does not schedule another pull')
  assert.equal(s.box.scrollTop, 500, 'the reader keeps his position — no write happened on the escape pass')
})

test('tail stick: 视口变高把 scrollTop 钳小时不解除跟随', () => {
  const s = buildTailStick(1000)
  s.settleTailStick(s.box, 4)
  s.tick() // 写入 pinned = 2000（超界的值，浏览器随即钳回最大可滚位）
  // 浏览器钳位＝scrollHeight-clientHeight，仍在跟随带内（实测 450→735 时 1541→1256）：
  // 那不是读者的意图。
  s.box.scrollTop = 2000 - 700
  s.tick()
  assert.equal(s.follow(), true, 'a clamp is not a reader gesture')
  assert.equal(s.box.scrollTop, 2000, 'the stick keeps him at the bottom it promised')
  assert.deepEqual(s.marks, ['ts', 'ts'])
})

test('tail stick: 塌盒（无可滚范围）时一个字都不写', () => {
  const s = buildTailStick(1000)
  s.box.scrollHeight = 700
  s.box.clientHeight = 700
  s.settleTailStick(s.box, 4)
  s.tick()
  assert.equal(s.box.scrollTop, 1000)
  assert.deepEqual(s.marks, [])
})

// ─── 5) settlePromptJump 进了互斥令牌（第四条链，此前游离在外）────────────
// 点 ↑ 起一条 100ms×4 的重瞄链；它不认令牌，于是点 ↓ 之后两股相反的写入交替——
// 用户 2026-10-15 口述「点那个上下按钮的时候也有跳动」。现在入口夺令牌（后上膛者赢），
// 重试回来发现令牌已被夺走就终止自己。
const PROMPTJUMP = slice(js, 'function settlePromptJump(box,anchor,tries){', "// ↑ 只跳转、不再顺手拉历史")

function buildPromptJump() {
  const marks = []
  const timers = []
  const box = { scrollTop: 0, isConnected: true, __settleTurn: 0, getBoundingClientRect: () => ({ top: 0 }) }
  const anchor = { isConnected: true, getBoundingClientRect: () => ({ top: 300 }) }
  const make = new Function(
    'probeMark', 'setTimeout', 'programmaticScroll', 'JUMP_PROMPT_PAD_PX',
    `${PROMPTJUMP};return settlePromptJump`
  )
  const settlePromptJump = make(
    (tag) => marks.push(tag),
    (fn) => { timers.push(fn) },
    () => {},
    Number(js.match(/JUMP_PROMPT_PAD_PX=(\d+);/)[1])
  )
  return { settlePromptJump, box, anchor, marks, timers, tick: () => timers.shift()() }
}

test('prompt jump: 首趟就写入，后续每趟带 pj 标记', () => {
  const s = buildPromptJump()
  s.settlePromptJump(s.box, s.anchor, 4)
  assert.equal(s.box.scrollTop, 300 - 54, 'delta 300-0-54 = 246 written')
  assert.deepEqual(s.marks, ['pj'])
  assert.equal(s.timers.length, 1, 'and the re-measure is scheduled')
})

test('prompt jump: 别人夺走令牌后重瞄链立刻终止，不再改 scrollTop', () => {
  const s = buildPromptJump()
  s.settlePromptJump(s.box, s.anchor, 4)
  const written = s.box.scrollTop
  s.marks.length = 0
  // 等价于读者随后按了 ↓：handler 里 box.__settleTurn 自增夺令牌（后上膛者赢）。
  s.box.__settleTurn += 1
  s.box.scrollTop = 5000
  s.tick()
  assert.equal(s.box.scrollTop, 5000, 'the stale chain must not drag him back')
  assert.deepEqual(s.marks, ['pj'], 'only the termination is stamped')
  assert.equal(s.timers.length, 0, 'and it does not schedule another pass')
})

