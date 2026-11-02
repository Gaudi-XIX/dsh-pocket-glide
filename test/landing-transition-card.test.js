// Pocket → BOT 过渡卡的行为面（2026-10-29 用户报告：卡的第三行先出数、第一行还空着，
// 而且秒开时也要白停一下）。此前这张卡只有字符串锚（markup 在不在），谁也没跑过它的脚本；
// 这里把 renderMobilePage() 真正内联的那段 bootstrap 抽出来，喂给一个同构替身跑。
//
// 四条口径（来自任务卡 rounds[3].intentSnapshot §2）：
//   A3  行按数据到达逐行定稿——亮起第 k 行时第 k-1 行必须已定稿，卡上不存在「下面已划线、
//       上面还空着」；数字只有一个来源：桥端 page.cue 的 7 键摘要（判据 v7 §3 / 裁决 R6），
//       cue 没到之前四行都只滚动、不定稿。
//   A4  从点击到离开这整段时间，遮罩可见、四行都在 DOM（不许为秒开另开一条跳过卡的分支）。
//   A5  数据和答复都在手时不推任何固定等待，跑完微任务就交棒。
//   A6  答复失败（ok:false / fetch reject）fail-closed：卡上写明失败、不写「已就绪」、不跳转。
//   A7  答复永不到达：2000ms（桥侧 pageCueWaitMs=1500 + 500 余量）后报错，不跳转，之后也不自行放行。
import test from 'node:test'
import assert from 'node:assert/strict'
import { pocketToBotRows, renderMobilePage } from '../lib/pages.js'

const ROWS = pocketToBotRows(true)

// 页面上真正发出去的那段内联脚本。只有带 assets 时才注入，所以这里必须带 assets 渲染。
function landingDocument() {
  return renderMobilePage({
    locale: 'zh',
    boot: null,
    assets: { jsUrl: '/app.js', cssUrl: '/app.css' },
  })
}

function landingBootstrap() {
  const match = landingDocument().match(/<script>\(function\(\)\{([\s\S]*?)\}\)\(\)<\/script>/)
  assert.ok(match, '落地页必须内联过渡卡的 bootstrap 脚本')
  return match[1]
}

// 阶梯运行时住在 head 的内联经典脚本里（见 lib/pages.js renderMobilePage 的顺序说明：
// 外链 app.js 先于 bootstrap 执行，所以定义必须在 head）。浏览器先跑 head、再跑 bootstrap，
// 这里照同一顺序把两段拼进同一个函数体——省掉 head 那段，就会被 `ladderRun is not defined` 打红，
// 那正是真机冷开会发生的事。
function landingHead() {
  const blocks = [...landingDocument().matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const withLadder = blocks.find((body) => body.includes('function ladderRun('))
  assert.ok(withLadder, 'head 里必须有阶梯运行时的定义，否则外链 app.js 里的冷启动卡取不到它')
  return withLadder
}

/**
 * 一个够用的替身：录下每一次 is-active / is-done 的翻转（连带当时前一行的定稿状态）、
 * 用一个假时钟接管 setTimeout/setInterval，location.href 的赋值记成一次导航。
 */
function harness({
    cue = 'ok',
    value = { ready: true, workspaces: null, sessions: null, messages: 5, bots: 2, botSessions: 3, rooms: 3 },
    summaries = [{ botName: 'a' }, { botName: 'a' }, { botName: 'b' }]
  } = {}) {
  const navigations = []
  const timers = new Map()
  const log = { active: [], done: [] }
  let seq = 0
  let now = 0

  const rows = []
  for (let index = 0; index < ROWS.length; index += 1) {
    const slot = ROWS[index]
    const cell = { textContent: slot.start || '', dataset: { unit: slot.unit }, _final: false, _scan: null }
    const row = {
      index,
      _active: false,
      _done: false,
      _final: false,
      querySelector: (selector) => (selector === '.bsc' ? cell : null),
      classList: {
        toggle(name, force) {
          const on = Boolean(force)
          if (name === 'is-active') {
            if (on) log.active.push({ index, prevFinal: index > 0 ? rows[index - 1]._final === true : true })
            row._active = on
          }
          if (name === 'is-done') {
            if (on) log.done.push({ index, prevDone: index > 0 ? rows[index - 1]._done === true : true })
            row._done = on
          }
        },
        contains: (name) => (name === 'is-active' ? row._active : row._done),
      },
    }
    cell.parentElement = row
    rows.push(row)
  }

  const overlay = { hidden: true, querySelectorAll: (selector) => (selector === '.boot-step' ? rows : []) }
  const failRow = { hidden: true, textContent: '' }
  const handlers = { click: null, pageshow: null }
  const fab = { addEventListener: (type, fn) => { handlers[type] = fn } }

  const document = {
    getElementById(id) {
      if (id === 'switchOverlay') return overlay
      if (id === 'botFab') return fab
      if (id === 'switchFail') return failRow
      return null
    },
    createElement: () => ({ appendChild() {} }),
    head: { appendChild() {} },
    body: { appendChild() {} },
    documentElement: {},
  }

  const window = { __pocketAppReady: true, addEventListener: (type, fn) => { handlers[type] = fn } }
  const location = {
    _href: '',
    get href() { return this._href },
    set href(next) { this._href = next; navigations.push(next) },
    // Q4 起 Pocket 主页那一跳走 location.replace（替换历史条目而不是压栈）；
    // 落点与 href 相同，同样记进 navigations，断言强度不变。
    replace(next) { this._href = next; navigations.push(next) },
  }
  const navigator = { sendBeacon() {} }
  const getComputedStyle = () => ({ getPropertyValue: () => ' #4d6bfe' })

  function setTimeoutStub(fn, ms) {
    seq += 1
    timers.set(seq, { fn, at: now + (Number(ms) || 0) })
    return seq
  }
  function clearTimeoutStub(id) { timers.delete(id) }
  function setTimeoutNoop() { return 0 }

  let releaseCue = null
  const fetchStub =
    cue === 'reject'
      ? () => Promise.reject(new Error('offline'))
      : cue === 'never'
        ? () => new Promise(() => {})
        : cue === 'manual'
          ? () => new Promise((resolve) => { releaseCue = resolve })
          : cue === 'not-ok'
            ? () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) })
            : () => Promise.resolve({ json: () => Promise.resolve({ ok: true, value }) })

  const boot = new Function(
    'window', 'document', 'getComputedStyle', 'fetch', 'navigator', 'location',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
    'sessionSummaries',
    `${landingHead()}
${landingBootstrap()}`,
  )

  return {
    rows,
    overlay,
    failRow,
    navigations,
    log,
    start() {
      boot(
        window, document, getComputedStyle, fetchStub, navigator, location,
        setTimeoutStub, setTimeoutNoop, clearTimeoutStub, setTimeoutNoop,
        () => 0, summaries,
      )
      return handlers.click
    },
    click() { handlers.click({ preventDefault() {} }) },
    answer(summary = value) {
      if (!releaseCue) throw new Error('no cue request is in flight')
      const resolve = releaseCue
      releaseCue = null
      resolve({ json: () => Promise.resolve({ ok: true, value: summary }) })
    },
    // 只把微任务跑完，不动假时钟——用来区分「数据到齐就立刻走」和「等到某个定时器才走」。
    async flush() {
      for (let round = 0; round < 4; round += 1) await new Promise((resolve) => setImmediate(resolve))
    },
    tick(ms) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
    pending() { return timers.size },
  }
}

test('过渡卡逐行定稿：亮起第 k 行时第 k-1 行已经定稿，划线不可能倒着来', async () => {
  const h = harness()
  h.start()
  h.click()
  await h.flush()
  // Q1 起四行由同一份 ladderRun 逐档推（70ms 一档）：推到末行才拿到「已就绪」，
  // 「已就绪」落屏之后还要停 dwell 才交棒。
  for (let step = 0; step < ROWS.length; step += 1) h.tick(70)
  await h.flush()
  assert.deepEqual(h.navigations, [], '完成文案落屏之后仍在停留，不立刻走')
  h.tick(500)
  await h.flush()

  assert.ok(h.log.active.length > 0, '点击后至少有一行被点亮')
  for (const seen of h.log.active) {
    assert.equal(seen.prevFinal, true, `第 ${seen.index} 行被点亮时，第 ${seen.index - 1} 行还没定稿`)
  }
  for (const seen of h.log.done) {
    assert.equal(seen.prevDone, true, `第 ${seen.index} 行划掉时，第 ${seen.index - 1} 行还没划掉`)
  }
  assert.deepEqual(h.navigations, ['/bot'])
})

test('过渡卡：cue 未到之前一行都不定稿，到了才按阶梯顺序逐行定稿', async () => {
  const h = harness({ cue: 'manual' })
  h.start()
  h.click()

  // 挂载那一帧：四行都先写占位（非末行「0＋单位」、末行保留「准备中」），扫描已经起了。
  assert.equal(h.rows[0].querySelector('.bsc').textContent, '0 个 BOT')
  assert.ok(h.rows[0].querySelector('.bsc')._scan, '第一行在等读数时是滚着的')
  assert.equal(h.rows[0]._final, false)

  // 阶梯一路走到末行，cue 还没回：四行只滚动、一行都不许定稿（v7 §3 / R6）。
  for (let step = 0; step < ROWS.length; step += 1) h.tick(70)
  await h.flush()
  assert.deepEqual(
    h.rows.map((row) => row._final),
    [false, false, false, false],
    'cue 没到，卡上不许出现任何定稿读数'
  )
  assert.match(h.rows[0].querySelector('.bsc').textContent, /^\d+ 个 BOT$/, '仍停在滚动占位读数上')
  assert.deepEqual(h.navigations, [])
  assert.equal(h.failRow.hidden, true, '还在等 cue，不是失败')

  // cue 落地：已亮起的行按顺序补上摘要里的数，末行写成「已就绪」。
  h.answer()
  await h.flush()
  assert.equal(h.rows[0].querySelector('.bsc').textContent, '2 个 BOT')
  assert.equal(h.rows[1].querySelector('.bsc').textContent, '3 个群', '第二格取自摘要的 rooms')
  assert.equal(h.rows[2].querySelector('.bsc').textContent, '5 条消息', '第三格取自本次 /bot boot 的 previews 条数')
  assert.equal(h.rows[3].querySelector('.bsc').textContent, '已就绪')
  for (let index = 0; index < ROWS.length; index += 1) {
    assert.equal(h.rows[index]._final, true, `第 ${index} 行在 cue 到达后定稿`)
  }
})

test('过渡卡：数据与答复都在手时不推任何固定等待，逐档推完就交棒', async () => {
  const h = harness()
  h.start()
  h.click()
  await h.flush()
  for (let step = 0; step < ROWS.length; step += 1) h.tick(70)
  await h.flush()

  assert.deepEqual(h.navigations, [], '末行落屏之后还有一次 dwell，不是同一帧就走')
  h.tick(500)
  await h.flush()

  assert.deepEqual(h.navigations, ['/bot'])
  assert.equal(h.pending(), 0, '交棒时不应留下任何未清理的定时器（固定节拍、到点放行或扫描）')
})

test('过渡卡在交棒之前一直是可见的，四行也都在 DOM 里', async () => {
  const h = harness()
  h.start()
  h.click()

  assert.equal(h.overlay.hidden, false)
  assert.equal(h.rows.length, ROWS.length)
  assert.deepEqual(h.navigations, [], '这一帧还不该跳走')
})

test('答复失败（fetch reject）时 fail-closed：卡上写明失败、不写已就绪、不跳转', async () => {
  const h = harness({ cue: 'reject' })
  h.start()
  h.click()
  await h.flush()

  assert.deepEqual(h.navigations, [])
  assert.equal(h.failRow.hidden, false, '失败行必须显形')
  assert.match(h.failRow.textContent, /再试一次/)
  assert.ok(!h.rows[3].querySelector('.bsc').textContent.includes('已就绪'))
})

test('答复被桥拒绝（ok:false）同样 fail-closed', async () => {
  const h = harness({ cue: 'not-ok' })
  h.start()
  h.click()
  await h.flush()

  assert.deepEqual(h.navigations, [])
  assert.equal(h.failRow.hidden, false)
  assert.ok(!h.rows[3].querySelector('.bsc').textContent.includes('已就绪'))
})

test('答复永不到达：2000ms 后报错、不跳转，再等 5s 也不自行放行', async () => {
  const h = harness({ cue: 'never' })
  h.start()
  h.click()
  await h.flush()

  assert.deepEqual(h.navigations, [])
  assert.equal(h.failRow.hidden, true, '还没到 2000ms，不该提前报错')
  h.tick(1999)
  assert.equal(h.failRow.hidden, true)
  h.tick(1)
  assert.equal(h.failRow.hidden, false, '到 2000ms 必须报错')
  assert.match(h.failRow.textContent, /准备超时/)
  assert.deepEqual(h.navigations, [])

  h.tick(5000)
  assert.deepEqual(h.navigations, [], '报错之后不许自行放行')
  assert.equal(h.failRow.hidden, false)
  assert.ok(!h.rows[3].querySelector('.bsc').textContent.includes('已就绪'))
})
