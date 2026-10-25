// The boot ladder's counts climb 0→N instead of popping in whole (user
// 2026-10-20: "先显示数字，一个数字过一个数字，哒哒哒的效果"), every number belongs to
// exactly one row, and it is handed out the moment the ladder enters that row — not
// when the row finishes (user 2026-10-21: "应该一步一步来，我只单的前端显示，后端肯定
// 是提前加载"; 2026-10-22: "有没有可能刚进入那一行，就把后面对应的数字显示出来"). This
// drives the function the phone actually ships — pulled out of sharedStageScript() and
// run against a stub DOM — rather than re-asserting a string, because the whole point
// is the frame-by-frame behaviour: it must advance, must land exactly on the final
// value, must never hold a stage (it is fire-and-forget), must honour
// prefers-reduced-motion by writing the final value at once, and must keep a parked
// number invisible until its row comes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderMobileReconnectPage, renderPairingPinPage } from '../lib/pages.js'

const source = readFileSync(new URL('../lib/pages.js', import.meta.url), 'utf8')
const blockStart = source.indexOf('function sharedStageScript()')
const block = source.slice(blockStart, source.indexOf('export function renderMobileReconnectPage('))

// The organ lines, verbatim from the shipped block. The gate lives before
// COUNT_UP_MS, so the block is grabbed in three pieces around it.
const grab = (start, end) => {
  const from = block.indexOf(start)
  assert.ok(from >= 0, `missing anchor: ${start}`)
  const to = block.indexOf(end, from)
  assert.ok(to > from, `missing end anchor: ${end}`)
  return block.slice(from, to)
}
const ORGANS =
  grab('let ladderGated=false;', 'const COUNT_UP_MS=') +
  grab('const COUNT_UP_MS=', 'function setCount(') +
  grab('function setCount(', '\nconst rpc=')

// Build a bootSteps host with `rows` rows, each carrying one .boot-step-count span.
function makeWorld({ reduced = false } = {}) {
  const seeds = ['0 个工作区', '0 个会话', '0 条消息', '0', '0']
  const rows = Array.from({ length: 5 }, (_, i) => {
    const el = { textContent: seeds[i] }
    return { el, querySelector: (sel) => (sel === '.boot-step-count' ? el : null) }
  })
  const host = { children: rows }
  const document = { getElementById: (id) => (id === 'bootSteps' ? host : null) }
  const matchMedia = (q) => ({ matches: reduced && /reduce/.test(q) })
  let queue = []
  const requestAnimationFrame = (cb) => {
    queue.push(cb)
    return queue.length
  }
  // The scan ticks on setTimeout; keep those ticks in the same pump so a test can
  // walk the reel frame by frame instead of waiting on real time.
  const timers = []
  const setTimeoutShim = (cb) => {
    timers.push(cb)
    return timers.length
  }
  // A clock we control: each drain step advances by 90ms so the 450ms ladder is
  // walked in a handful of frames instead of real time.
  let now = 0
  const DateShim = { now: () => now }
  const run = new Function('document', 'matchMedia', 'requestAnimationFrame', 'setTimeout', 'Date', `${ORGANS};return {countUp,paintCount,releaseCount,setCount,stepCountEl,gateLadder,startRowScan,stopRowScan,countTailMessages}`)
  const api = run(document, matchMedia, requestAnimationFrame, setTimeoutShim, DateShim)
  const pump = (frames = 40) => {
    for (let i = 0; i < frames && (queue.length || timers.length); i += 1) {
      now += 90
      const batch = [...queue, ...timers]
      queue = []
      timers.length = 0
      for (const cb of batch) cb()
    }
  }
  return { api, rows, pump, text: (i) => rows[i].el.textContent }
}

const zhFmt = (v) => `${v} 个工作区`

test('a count climbs frame by frame and lands exactly on the final value', () => {
  const { api, pump, text } = makeWorld()
  api.countUp(api.stepCountEl(0), 7, zhFmt)
  // It has started moving but is not there yet on an early frame.
  pump(2)
  const mid = Number.parseInt(text(0), 10)
  assert.ok(mid > 0 && mid < 7, `mid-flight value should be between 0 and 7, saw "${text(0)}"`)
  // Run to the end of the ladder.
  pump(40)
  assert.equal(text(0), '7 个工作区', 'the last frame writes the exact final string')
})

test('reduced motion writes the final value at once, no animation', () => {
  const { api, pump, text } = makeWorld({ reduced: true })
  api.countUp(api.stepCountEl(1), 12, (v) => `${v} 个会话`)
  assert.equal(text(1), '12 个会话', 'final value lands before any frame runs')
  pump(5)
  assert.equal(text(1), '12 个会话', 'and does not change afterwards')
})

test('a measured zero is written directly (it is a real reading, not a missing field)', () => {
  const { api, pump, text } = makeWorld()
  api.countUp(api.stepCountEl(2), 0, zhFmt)
  assert.equal(text(2), '0 个工作区')
  pump(5)
  assert.equal(text(2), '0 个工作区')
})

test('countUp never throws when the row is gone (page already navigated away)', () => {
  const { api } = makeWorld()
  assert.doesNotThrow(() => api.countUp(null, 5, zhFmt))
  // Index past the ladder rows resolves to no element and is a silent no-op.
  assert.doesNotThrow(() => api.countUp(api.stepCountEl(99), 5, zhFmt))
})

test('setCount still writes a literal (the text labels: 已连接 / 就绪)', () => {
  const { api, pump, text } = makeWorld()
  api.setCount(4, '就绪')
  assert.equal(text(4), '就绪')
  pump(5)
  assert.equal(text(4), '就绪', 'a literal is not animated')
})

test('both bootstrap pages carry the climbing organs exactly once', () => {
  const count = (s, needle) => s.split(needle).length - 1
  for (const [name, html] of [
    ['reconnect', renderMobileReconnectPage('zh', 'lan', {})],
    ['pairing', renderPairingPinPage('zh', null, {})],
  ]) {
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
    assert.equal(count(scripts, 'function countUp('), 1, `${name}: one countUp definition`)
    assert.equal(count(scripts, 'function stepCountEl('), 1, `${name}: one stepCountEl definition`)
    assert.ok(count(scripts, 'countUp(stepCountEl(') >= 2, `${name}: at least the ws + session counts climb`)
  }
})

test('no odometer: the shipped block carries no countCrawl anywhere', () => {
  // The in-flight odometer is gone for good (user 2026-10-21: "数字都是一样的，
  // 并且数字明显是错的"). It counted frames, not records, and three of them started
  // in the same tick, so all three rows showed the same number. Re-adding it would
  // put the same lie back on the ladder.
  // 2026-10-25 修订：行打开时若真值未到，行右侧按该步**已确定的真实下界**（probe，
  // 由 countUp 记录在行元素上）爬数字，真值到达后收口——这是真读数下界，不是按时间
  // 自增的假里程表（用户 2026-10-23 m00001③：「到每一步开始的时候，右边就开始跳
  // 数字」）。禁的仍是 countCrawl 那种无下界的时间驱动计数；CRAWL_TICK_MS 只是
  // 爬升的节拍间隔，不是计数来源。
  assert.equal(source.includes('countCrawl'), false, 'countCrawl must not exist in lib/pages.js')
})

test('a count measured before its row is reached is parked, not painted', () => {
  const { api, pump, text } = makeWorld()
  api.gateLadder()
  api.countUp(api.stepCountEl(1), 9, (v) => `${v} 个会话`)
  pump(40)
  assert.equal(text(1), '0 个会话', 'the row still shows the seed the template ships — parked, never painted')
})

test('opening the gate hands the first row its number at once (that row is already lit)', () => {
  // Row 0 is the row the ladder shows from its first frame, so it must be readable
  // from that first frame too — "刚进入那一行，就把数字显示出来" (user 2026-10-22).
  const { api, pump, text } = makeWorld()
  api.gateLadder()
  api.countUp(api.stepCountEl(0), 2, zhFmt)
  pump(40)
  assert.equal(text(0), '2 个工作区', 'the first row is open, so its number is not held back')
})

test('releaseCount hands the parked number over, and the ladder order is kept', () => {
  const { api, pump, text } = makeWorld()
  api.gateLadder()
  api.countUp(api.stepCountEl(0), 2, zhFmt)
  api.countUp(api.stepCountEl(1), 30, (v) => `${v} 个会话`)
  api.countUp(api.stepCountEl(2), 10, (v) => `${v} 条消息`)
  pump(40)
  assert.deepEqual([text(1), text(2)], ['0 个会话', '0 条消息'], 'before its row the count stays at the template seed')
  assert.equal(text(0), '2 个工作区', 'the row the ladder is on shows its own number')
  api.releaseCount(1)
  pump(40)
  assert.equal(text(1), '30 个会话')
  assert.equal(text(2), '0 条消息', 'a row that has not been reached yet keeps its seed')
})

test('a row that opens before its answer is known starts a rolling count at once', () => {
  // 2026-10-25 用户口径（m00277）：「一开始就显示多少个什么绘画，那个数字就快速从 0
  // 飙到 9，不停地轮换，然后等到开始轮转以后，最终停到那个数字」——行一打开，右边
  // 立刻是滚动的数字，而不是先写个 0 干等，也不是最后一次性跳出真值。
  const { api, pump, text } = makeWorld()
  api.gateLadder()
  // 真值还没到手；单位由行模板自带（每个计数行出场就写着「0 个会话」= 自己那一行的量词）。
  api.releaseCount(2)
  assert.match(text(2), /^\d+ 条消息$/, 'the row shows a rolling number, not the bare seed')
  const seen = new Set([text(2)])
  for (let i = 0; i < 12; i += 1) {
    pump(1)
    seen.add(text(2))
  }
  assert.ok(seen.size >= 3, `the counter keeps moving while the answer is in flight, saw ${[...seen].join(' | ')}`)
  // 真值回来那一刻收口，停在真值上。
  api.countUp(api.stepCountEl(2), 37, (v) => `${v} 条消息`)
  pump(40)
  assert.equal(text(2), '37 条消息', 'the real reading wins the moment it lands')
  pump(20)
  assert.equal(text(2), '37 条消息', 'and stays there — the reel does not resume')
})

test('the rolling count sweeps 0..9 and wraps instead of climbing forever', () => {
  // 用户 m00277 原话是「从 0 飙到 9，不停地轮换」：一圈到 9 就回到 0，不是一味递增。
  // 这样它在真值回来之前既看得出“在动”，又不会被读成一个真实读数。
  const { api, pump, text } = makeWorld()
  api.gateLadder()
  api.countUp(api.stepCountEl(3), 0, (v) => `${v} 条消息`) // 先记下 formatter；真值 0 仍是真读数
  api.releaseCount(3)
  const nums = []
  for (let i = 0; i < 14; i += 1) {
    pump(1)
    nums.push(Number.parseInt(text(3), 10))
  }
  assert.ok(nums.includes(0), `the reel wraps back to 0, saw ${nums.join(',')}`)
  assert.ok(Math.max(...nums) <= 9, `the reel never passes 9, saw ${nums.join(',')}`)
})
test('the gate is off by default, so the app-shell path is unchanged', () => {
  const { api, pump, text } = makeWorld()
  api.countUp(api.stepCountEl(0), 3, zhFmt)
  pump(40)
  assert.equal(text(0), '3 个工作区', 'without gateLadder() the count paints at once')
})

test('both bootstrap pages gate the ladder and hand each row its number as it opens', () => {
  const count = (s, needle) => s.split(needle).length - 1
  for (const [name, html] of [
    ['reconnect', renderMobileReconnectPage('zh', 'lan', {})],
    ['pairing', renderPairingPinPage('zh', null, {})],
  ]) {
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
    assert.equal(count(scripts, 'gateLadder();'), 1, `${name}: the gate is opened once, before the reads go out`)
    assert.equal(count(scripts, 'const openRow=(n)=>{setStep(n);releaseCount(n)};'), 1, `${name}: entering a row is what opens it`)
    assert.equal(count(scripts, 'const stage=stageRunner(openRow);'), 1, `${name}: the runner drives rows through openRow`)
    assert.ok(count(scripts, 'await stage(') >= 3, `${name}: every row is walked one after another`)
    assert.equal(count(scripts, 'countCrawl('), 0, `${name}: no in-flight odometer`)
  }
})

test('the conversation row counts messages, not preloaded packs', () => {
  // "10 组消息" was the number of session tail packs in the boot payload; a reader
  // takes it as "ten messages" (user 2026-10-22: "不应该写 10 组消息，而是看能不能
  // 真实地把消息的条数写出来"). The row now counts the actual message records, by
  // the same rule the transcript itself uses — a turn's tool calls and its boundary
  // records are not messages.
  const { api } = makeWorld()
  const tails = {
    a: { events: [{ type: 'user/message' }, { type: 'assistant/message' }, { type: 'tool/call' }] },
    b: { events: [{ type: 'assistant/message' }, { type: 'turn/end' }, { type: 'assistant/chunk' }] },
    // Failed packs carry no conversation at all and must not be counted as one.
    c: { error: 'timeout' },
  }
  assert.equal(api.countTailMessages(tails), 3)
  assert.equal(api.countTailMessages({}), 0)
  assert.equal(api.countTailMessages(null), 0)
  assert.equal(api.countTailMessages({ a: { events: [] } }), 0)
  // The shipped pages use this exact helper for that row, and no longer count packs.
  for (const [name, html] of [
    ['reconnect', renderMobileReconnectPage('zh', 'lan', {})],
    ['pairing', renderPairingPinPage('zh', null, {})],
  ]) {
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
    assert.ok(scripts.includes('countTailMessages(parsed.tails)'), `${name}: the conversation row counts messages`)
    assert.equal(scripts.includes("' 组消息'"), false, `${name}: the pack wording is gone`)
    assert.ok(scripts.includes("' 条消息'"), `${name}: the row says how many messages`)
  }
})

test('the ladder rows start at 0, ready to crawl from the moment a row opens', () => {
  // 2026-10-25 用户改口径（m00001③ + 复核反馈）：「到每一步开始的时候，右边就开始
  // 跳数字」——行打开时立刻开始爬，答案后到再收口。行模板出厂预填 0（data-probe="0"），
  // 爬升器从 0 起步；真值由 countUp→paintCount 写入。
  const html = renderMobileReconnectPage('zh', 'lan', {})
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
  assert.match(
    script,
    /data-probe="0">0'\+\(units\[i\]\?units\[i\]\(\):''\)\+'<\/span>/,
    'the count span ships "0 + 这一行的量词" so the sweep reads "0 个工作区" from the first frame',
  )
  assert.match(script, /const units=\[ROW_UNIT\.workspace,ROW_UNIT\.sessionList,ROW_UNIT\.session/, 'each count row is handed its own unit')
})

// 2026-10-25 真机回归：ROW_UNIT 的量词工厂里写了页面变量 `zh`，而工厂是在
// **Node 侧**（生成页面时）求值的——`zh` 只活在生成的页面脚本里。于是点「连接」
// 的瞬间就抛 ReferenceError: zh is not defined（栈在 Array.workspace），阶梯一行都
// 出不来。上面那些用 stub DOM 拼器官的测试全绿，因为它们自己注入了变量；能抓住这
// 一类的只有「把页面真正出厂的脚本跑一遍」。这条守卫就把两页的脚本真跑一次。
test('the shipped page scripts run as-is: no reference to a variable that only exists later', () => {
  const pages = [
    ['reconnect', renderMobileReconnectPage('zh', 'lan', {})],
    ['reconnect-en', renderMobileReconnectPage('en', 'lan', {})],
    ['pairing', renderPairingPinPage('zh', null, {})],
    ['pairing-en', renderPairingPinPage('en', null, {})],
  ]
  for (const [name, html] of pages) {
    const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
    // 页面脚本是整体执行的（历史上的「停在 splash」就是脚本没跑起来）。这里只求
    // 求值到底：DOM 靠一个宽嘴 stub 顶着，任何 ReferenceError 都会在这里炸出来。
    const stub = new Proxy(function () {}, {
      get: (t, key) => {
        if (key === Symbol.toPrimitive || key === 'toString') return () => ''
        if (key === 'then') return undefined
        return stub
      },
      set: () => true,
      apply: () => stub,
      construct: () => stub,
    })
    const document = stub
    assert.doesNotThrow(
      () => new Function('document', 'window', 'navigator', 'location', 'fetch', 'requestAnimationFrame', 'matchMedia', 'setTimeout', script)(document, stub, stub, stub, stub, () => 0, () => ({ matches: true }), () => 0),
      `${name}: the page script must evaluate without a ReferenceError`,
    )
    // 量词工厂必须靠运行时的 ZH 判断，不能直接引用 `zh`。
    assert.equal(/:\(\)=>zh\?/.test(script), false, `${name}: the unit factories must not close over the page variable zh`)
    assert.match(script, /ROW_UNIT\.workspace/, `${name}: rows still carry their unit`)
  }
})
