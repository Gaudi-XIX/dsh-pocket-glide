// The boot ladder's counts are written once, when the bridge's summary lands and the
// ladder has reached that row (user 2026-10-21: "应该一步一步来，我只单的前端显示，后端
// 肯定是提前加载"; 2026-10-22: "有没有可能刚进入那一行，就把后面对应的数字显示出来"). Every
// number belongs to exactly one row, and a cell stays blank until its reading is known:
// no rolling sequence, no tween, no 0 seed (2026-11-03 user m00236①(a): "它会先显示一遍
// 000 已就绪，然后突然又把数字弹出来"). This drives the function the phone actually
// ships — pulled out of sharedStageScript() and run against a stub DOM — rather than
// re-asserting a string, because the whole point is the frame-by-frame behaviour: a
// reading must land exactly once, must never be invented, and a parked number must stay
// invisible until its row comes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { countTailMessages, renderMobileReconnectPage, renderPairingPinPage } from '../lib/pages.js'

const source = readFileSync(new URL('../lib/pages.js', import.meta.url), 'utf8')
const blockStart = source.indexOf('function sharedStageScript()')
const block = source.slice(blockStart, source.indexOf('export function renderMobileReconnectPage('))

// The organ lines, verbatim from the shipped block. The gate lives before
// The organ lines, sliced out of the shipped block in one piece: from the ladder gate
// down to the RPC helper sits every count organ there is.
const grab = (start, end) => {
  const from = block.indexOf(start)
  assert.ok(from >= 0, `missing anchor: ${start}`)
  const to = block.indexOf(end, from)
  assert.ok(to > from, `missing end anchor: ${end}`)
  return block.slice(from, to)
}
const ORGANS = grab('let ladderGated=false;', 'const rpc=async(')
// Build a bootSteps host with `rowCount` rows, each carrying one .bsc span.
function makeWorld({ reduced = false, rowCount = 5 } = {}) {
  // 出厂模板的出生文本是空串（判据 C1.1）——未成值的格子从头到尾留白，所以桩也留白。
  const rows = Array.from({ length: rowCount }, () => {
    const el = { textContent: '' }
    return { el, querySelector: (sel) => (sel === '.bsc' ? el : null) }
  })
  const host = { children: rows }
  const document = { getElementById: (id) => (id === 'bootSteps' ? host : null) }
  const matchMedia = (q) => ({ matches: reduced && /reduce/.test(q) })
  let queue = []
  const requestAnimationFrame = (cb) => {
    queue.push(cb)
    return queue.length
  }
  // Nothing schedules frames or ticks any more (判据 C1.2); the pump stays so a test
  // can prove that no queued callback ever moves a cell.
  const timers = []
  const setTimeoutShim = (cb) => {
    timers.push(cb)
    return timers.length
  }
  // A clock we control: each drain step advances by 90ms so the 450ms ladder is
  // walked in a handful of frames instead of real time.
  let now = 0
  const DateShim = { now: () => now }
  const run = new Function('document', 'matchMedia', 'requestAnimationFrame', 'setTimeout', 'Date', `${ORGANS};return {countUp,paintCount,releaseCount,setCount,stepCountEl,gateLadder,paintStageSums,sumsReady}`)
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

test('a reading is written once — no tween, no intermediate value', () => {
  const { api, pump, text } = makeWorld()
  api.countUp(api.stepCountEl(0), 7, zhFmt)
  assert.equal(text(0), '7 个工作区', 'the final text lands on the spot')
  // 判据 C1.2：禁补间——真值之后没有任何一帧把它改回中间值。
  pump(40)
  assert.equal(text(0), '7 个工作区', 'and no later frame rewrites it')
})
test('a reading lands before any frame runs, with no animation to wait for', () => {
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
    assert.equal(count(scripts, 'function paintStageSums('), 1, `${name}: one place paints the summary onto the ladder`)
    assert.ok(count(scripts, 'paintStageSums(') >= 2, `${name}: that one place is actually wired into the page`)
    assert.ok(scripts.includes('sum.workspaces') && scripts.includes('sum.sessions') && scripts.includes('sum.messages'), `${name}: all three counted rows come from the summary`)
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
  assert.equal(text(1), '', 'the row stays blank until its reading is known — parked, never painted')
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
  assert.deepEqual([text(1), text(2)], ['', ''], 'before its row the count stays blank — there is no seed to show')
  assert.equal(text(0), '2 个工作区', 'the row the ladder is on shows its own number')
  api.releaseCount(1)
  pump(40)
  assert.equal(text(1), '30 个会话')
  assert.equal(text(2), '', 'a row that has not been reached yet stays blank')
})

test('a row that opens before its answer is known stays blank until the reading lands', () => {
  // 2026-10-25 的用户口径曾要求「行一打开就开始滚数字」，2026-11-03 用户又报「先显示一遍
  // 000 再弹真值」——滚动序列与假种子一并砍掉（判据 C1）：真值没到就留白，真值一到
  // 一次写成，此后不再变。
  const { api, pump, text } = makeWorld()
  api.gateLadder()
  api.releaseCount(2)
  assert.equal(text(2), '', 'no number before the reading exists')
  for (let i = 0; i < 12; i += 1) pump(1)
  assert.equal(text(2), '', 'and no timer invents one while the answer is in flight')
  api.countUp(api.stepCountEl(2), 37, (v) => `${v} 条消息`)
  assert.equal(text(2), '37 条消息', 'the real reading is written once, the moment it lands')
  pump(40)
  assert.equal(text(2), '37 条消息', 'and stays there — nothing resumes')
})
test('the shared block ships no rolling counter and no probe bookkeeping', () => {
  // 判据 C1.1/C1.2/C1.3：0→9 轮换、补间、两个引导页计数格出厂预填的 0 全部删净。
  // 这里钉「现存的那条写数字的路」：计数写入器体内既没有帧、也没有定时器。
  const body = block.slice(block.indexOf('function paintCount('), block.indexOf('function countUp('))
  assert.ok(body.length > 0, 'the count writer is in the shipped block')
  assert.equal(/requestAnimationFrame|setTimeout/.test(body), false, 'the count writer neither tweens nor schedules')
  // 计数格出厂不带任何 data-* 标记：旧探针标记或将来任何新标记都会在这里现形。
  for (const [name, html] of [
    ['reconnect', renderMobileReconnectPage('zh', 'lan', {})],
    ['pairing', renderPairingPinPage('zh', null, {})],
  ]) {
    const spans = [...html.matchAll(/<span class="bsc"[^>]*>/g)].map((m) => m[0])
    assert.ok(spans.length > 0, `${name}: the counted cells ship`)
    for (const span of spans) assert.equal(/data-/.test(span), false, `${name}: a counted cell ships no marker`)
  }
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
    assert.equal(
      count(scripts, 'const openRow=(n)=>{setStep(n);if(n===lastRow)return;releaseCount(n)};'),
      1,
      `${name}: entering a row is what opens it — a row with no reading yet stays blank`,
    )
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
  assert.equal(countTailMessages(tails), 3)
  assert.equal(countTailMessages({}), 0)
  assert.equal(countTailMessages(null), 0)
  assert.equal(countTailMessages({ a: { events: [] } }), 0)
  // The shipped pages use this exact helper for that row, and no longer count packs.
  for (const [name, html] of [
    ['reconnect', renderMobileReconnectPage('zh', 'lan', {})],
    ['pairing', renderPairingPinPage('zh', null, {})],
  ]) {
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
    assert.equal(scripts.includes('countTailMessages'), false, `${name}: the page does not count messages itself (v7 §3)`)
    assert.equal(scripts.includes("' 组消息'"), false, `${name}: the pack wording is gone`)
    assert.ok(scripts.includes("' 条消息'"), `${name}: the row says how many messages`)
  }
  // The row takes its number from the boot payload's stageSummary — one summary,
  // one field, painted on the row the summary owns: index 3 on the 5-row PIN
  // ladder, index 2 on the 4-row reconnection ladder (R8-0).
  const bootPayload = { stageSummary: { ready: true, workspaces: 2, sessions: 3, messages: 5, bots: 4, botSessions: 6, rooms: 2 } }
  const pin = makeWorld({ reduced: true, rowCount: 6 })
  pin.api.paintStageSums(bootPayload.stageSummary)
  assert.equal(pin.text(1), '6 bots & groups', 'the PIN ladder paints the bot zones on its second row')
  assert.equal(pin.text(2), '2 ws', 'the PIN ladder paints workspaces on its third row')
  assert.equal(pin.text(3), '3 sess', 'and sessions on its fourth row')
  assert.equal(pin.text(4), '5 msg', 'its "reading the conversation" row shows stageSummary.messages itself')
  const reconnect = makeWorld({ reduced: true, rowCount: 5 })
  reconnect.api.paintStageSums(bootPayload.stageSummary)
  assert.equal(reconnect.text(0), '6 bots & groups', 'the reconnection ladder starts counting on row 0')
  assert.equal(reconnect.text(1), '2 ws', 'workspaces on row 1')
  assert.equal(reconnect.text(2), '3 sess', 'sessions on row 2')
  assert.equal(reconnect.text(3), '5 msg', 'and shows stageSummary.messages on row 3')
})

test('the ladder rows are born blank — no 0 seed, no probe marker', () => {
  // 判据 C1.1/C1.3（2026-11-03 用户 m00236①(a)：「先显示一遍 000 再弹真值」）：三个计数格
  // 从渲染到真值到达之前 textContent 恒为空串，出厂模板里没有 0 预填、计数格上没有任何标记；
  // 末行仍是「准备中」/preparing——它没有数字可写。
  const html = renderMobileReconnectPage('zh', 'lan', {})
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
  assert.ok(
    script.includes("(i===lastRow?(ZH?'准备中':'preparing'):'')"),
    'counted rows are born with an empty cell and the last row says 准备中',
  )
  const spans = [...html.matchAll(/<span class="bsc"[^>]*>/g)].map((m) => m[0])
  assert.ok(spans.length > 0, 'the counted cells ship')
  for (const span of spans) assert.equal(/data-/.test(span), false, 'a counted cell ships bare — the probe marker is gone for good')
  assert.equal(script.includes("'0'+(units[i]"), false, 'no row template pre-fills 0')
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
    assert.match(script, /ROW_UNIT\[unit\]\(\)/, `${name}: a row's unit still comes from the runtime unit factory`)
  }
})

test('each guide page records the boot before it hands over, exactly once', () => {
  // 判据 C3（用户 m00236①(b)：PIN 之后又插一张卡 ⇒ 一次冷启动两张卡）：两个引导页都在
  // 那次 location.replace('/') 紧前方写一次 pocketBootedAt，而且只在阶梯真正走完的路径上。
  for (const [name, html] of [
    ['reconnect', renderMobileReconnectPage('zh', 'lan', {})],
    ['pairing', renderPairingPinPage('zh', null, {})],
  ]) {
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
    assert.equal(scripts.split('markBooted()').length - 1, 2, `${name}: the shared block defines it and the hand-off calls it`)
    assert.equal(scripts.split('function markBooted()').length - 1, 1, `${name}: one definition only`)
    assert.equal(scripts.split('markBooted();').length - 1, 1, `${name}: exactly one hand-off calls it`)
    assert.ok(scripts.lastIndexOf("location.replace('/')") > scripts.lastIndexOf('markBooted()'), `${name}: the mark is written before the hand-off, never after it`)
  }
})
