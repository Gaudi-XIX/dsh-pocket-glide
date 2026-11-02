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
//   A6  答复失败（ok:false / fetch reject）收卡离场：卡上写明失败、不写「已就绪」，
//       随即收卡并 replace 到 /bot。原契约是「失败不离开页面」，716 判据 R15-8.1 有意
//       改写它——本节断言按新契约改写，不是被弱化（逐条清单见交付报告）。
//   A7  答复永不到达：2000ms（桥侧 pageCueWaitMs=1500 + 500 余量）到点同样收卡离场
//       （R15-8.1），并且只导航这一次。
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
    // blank 行（Pocket→BOT 卡前三格）在真机 markup 里带 `data-blank="1"` 且内容为空：
    // ladderRun 的挂载兜底认这个标记，不把「0＋单位」写进去。
    const dataset = slot.blank === true ? { unit: slot.unit, blank: '1' } : { unit: slot.unit }
    const cell = { textContent: slot.start || '', dataset, _final: false, _scan: null }
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

  // 挂载那一帧：前三格留白（blank 行不写「0＋单位」——判据 R14-3.2/3 禁止先画 0 再改真值），
  // 末行保留自己的占位词，扫描已经起了。
  assert.equal(h.rows[0].querySelector('.bsc').textContent, '', '读数没到之前第一格必须留白')
  assert.equal(h.rows[1].querySelector('.bsc').textContent, '', '读数没到之前第二格必须留白')
  assert.equal(h.rows[2].querySelector('.bsc').textContent, '', '读数没到之前第三格必须留白')
  assert.equal(h.rows[3].querySelector('.bsc').textContent, '准备中', '末行仍写自己的占位词')
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
  assert.equal(h.rows[0].querySelector('.bsc').textContent, '', 'cue 没到，第一格一直是留白——不许退回「0 个 BOT」这种占位读数')
  assert.equal(h.rows[1].querySelector('.bsc').textContent, '', '第二格同样一直留白')
  assert.equal(h.rows[2].querySelector('.bsc').textContent, '', '第三格同样一直留白')
  assert.deepEqual(h.navigations, [])
  assert.equal(h.failRow.hidden, true, '还在等 cue，不是失败')

  // cue 落地：已亮起的行按顺序补上摘要里的数，末行写成「已就绪」。
  h.answer()
  await h.flush()
  assert.equal(h.rows[0].querySelector('.bsc').textContent, '2 个 BOT')
  assert.equal(h.rows[1].querySelector('.bsc').textContent, '3 个群', '第二格取自摘要的 rooms')
  assert.equal(h.rows[2].querySelector('.bsc').textContent, '5 条消息', '第三格取自答复里的摘要字段 messages，不是页面自己读到的条数')
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

test('答复失败（fetch reject）时收卡离场：卡不再留在屏上，也不写「已就绪」', async () => {
  const h = harness({ cue: 'reject' })
  h.start()
  h.click()
  await h.flush()

  assert.deepEqual(h.navigations, ['/bot'], '失败必须离场（R15-8.1）')
  assert.equal(h.overlay.hidden, true, '失败必须收卡（R15-8.1）')
  assert.equal(h.failRow.hidden, false, '失败行仍按 R15-4.5 的唯一文案来源写明原因')
  assert.match(h.failRow.textContent, /再试一次/)
  assert.ok(!h.rows[3].querySelector('.bsc').textContent.includes('已就绪'))
})

test('答复被桥拒绝（ok:false）同样收卡离场', async () => {
  const h = harness({ cue: 'not-ok' })
  h.start()
  h.click()
  await h.flush()

  assert.deepEqual(h.navigations, ['/bot'], '回包 ok!==true 是失败判定，必须离场（R15-8.1）')
  assert.equal(h.overlay.hidden, true, '并且收卡（R15-8.1）')
  assert.equal(h.failRow.hidden, false)
  assert.ok(!h.rows[3].querySelector('.bsc').textContent.includes('已就绪'))
})

test('回包里没有可用摘要（ready:false）同样收卡离场，不在末行干等', async () => {
  const h = harness({ cue: 'manual' })
  h.start()
  h.click()
  for (let step = 0; step < ROWS.length; step += 1) h.tick(70)
  await h.flush()
  assert.deepEqual(h.navigations, [], 'cue 还没回，卡还在等')

  // 答复是冷的（ready 非 true、无一个真数字）：四格都不可能成值。旧实现把它记进
  // cueSummary，阶梯停在末行等一个永远不会来的值，而看门狗已被清掉——那也是一条滞留路。
  h.answer({ ready: false, workspaces: null, sessions: null, messages: null, bots: null, botSessions: null, rooms: null })
  await h.flush()

  assert.deepEqual(h.navigations, ['/bot'], '无可用摘要是失败判定，必须离场（R15-8.1）')
  assert.equal(h.overlay.hidden, true, '并且收卡（R15-8.1）')
  assert.ok(!h.rows[0].querySelector('.bsc').textContent, '冷摘要的第一格仍留白，不落 0')
  assert.ok(!h.rows[3].querySelector('.bsc').textContent.includes('0'), '末格不许出现字符串 0')
  for (const row of h.rows) {
    assert.ok(!row.querySelector('.bsc').textContent.includes('未就绪'), '卡上任何一格都不许出现「未就绪」')
  }
})

test('答复永不到达：2000ms 到点收卡离场，不在卡上留人', async () => {
  const h = harness({ cue: 'never' })
  h.start()
  h.click()
  await h.flush()

  assert.deepEqual(h.navigations, [])
  assert.equal(h.overlay.hidden, false, '还没到 2000ms，卡还在等——不是提前失败')
  assert.equal(h.failRow.hidden, true, '还没到 2000ms，不该提前报错')
  h.tick(1999)
  assert.equal(h.failRow.hidden, true)
  assert.deepEqual(h.navigations, [], '到点之前不导航')
  h.tick(1)
  assert.equal(h.failRow.hidden, false, '到 2000ms 必须报错')
  assert.match(h.failRow.textContent, /准备超时/)
  assert.equal(h.overlay.hidden, true, '到点必须收卡（R15-8.1）')
  assert.deepEqual(h.navigations, ['/bot'], '到点必须离场（R15-8.1）')

  h.tick(5000)
  assert.deepEqual(h.navigations, ['/bot'], '离场只发生一次，之后不再重复导航')
  assert.equal(h.failRow.hidden, false)
  assert.ok(!h.rows[3].querySelector('.bsc').textContent.includes('已就绪'))
  // 判据 V5/R15-8.3：这一帧与之后任何一帧都不许出现「未就绪」，末格也不许出现字符串 0——
  // 收口是收卡离场＋#switchFail 显形，不是拿一个假读数把卡填满（R15-3.2/3.3 删掉了
  // 「未就绪」那条路：旧实现到点会往末格写它，失败收口还会把 0 补上去）。
  for (const row of h.rows) {
    assert.ok(!row.querySelector('.bsc').textContent.includes('未就绪'), '卡上任何一格都不许出现「未就绪」')
  }
  assert.ok(!h.rows[3].querySelector('.bsc').textContent.includes('0'), '末格不许出现字符串 0')
})
