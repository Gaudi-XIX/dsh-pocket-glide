// 判据第 6 条的行为面（2026-10-30 UI 统一卡，批次 A）。
//
// 静态 grep 只能证明「代码里写着 已就绪」「setCount 写了一行」，证明不了：
//   6B  末行落完成文字后 200 ms 再读，屏上仍是那四个字（没有任何东西能把它盖回去）；
//   6C  is-active 单调不减、步长 ≤ 1、同时只有一行；三条腿仍然同时出发（没被串行化）；
//   6D  跳转时刻与完成文字时刻差 ≥ 500 ms（停留是独立等待，不是拿帧同步凑出来的）。
//
// 所以这里不重写阶梯，而是把**页面实际出厂的脚本**里那两段真代码取出来跑：
// sharedStageScript() 的器官（gateLadder / stepCountEl / countUp / sumsReady /
// releaseCount / setCount / stageRunner …）与重连页的 runStages()，
// 挂在一个只有 4 行的替身 DOM 与一台手动时钟上。断言读的是 class 变更事件序列与
// 文字内容，不是字符串匹配。
import test from 'node:test'
import assert from 'node:assert/strict'
import { countTailMessages, renderMobileReconnectPage, renderPairingPinPage } from '../lib/pages.js'

const html = renderMobileReconnectPage('zh', 'lan', {})
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

const grab = (start, end) => {
  const from = script.indexOf(start)
  assert.ok(from >= 0, `missing anchor in the shipped page: ${start}`)
  const to = script.indexOf(end, from)
  assert.ok(to > from, `missing end anchor in the shipped page: ${end}`)
  return script.slice(from, to)
}
// 器官整段切出来：从阶梯闸门到 RPC 助手之间就是全部计数器官，与 boot-count-up.test.js 同法。
const ORGANS = grab('let ladderGated=false;', 'const rpc=async(')
const STAGE_RUNNER = grab('const stageRunner=(setStep)', 'async function verifyPin(')
// The shipped runner, lifted verbatim: the page calls it as `stageRunner(openRow)`.
const makeStageRunner = new Function(`${STAGE_RUNNER};return stageRunner;`)()

const STAGES_START = 'async function runStages(){'
const STAGES_END = "location.replace('/');}"
const stagesFrom = script.indexOf(STAGES_START)
assert.ok(stagesFrom >= 0, 'the shipped reconnect page must carry runStages()')
const stagesTo = script.indexOf(STAGES_END, stagesFrom)
assert.ok(stagesTo > stagesFrom, 'runStages() must end on its navigation line')
const RUN_STAGES = script.slice(stagesFrom, stagesTo + STAGES_END.length)

/**
 * Run a page's own template expression (the `stepsHost.innerHTML=…` line) and read back
 * the rows it paints — the shipped code, not a re-implementation of it.
 * @param {string} body the page's shipped script
 * @returns {{label: string, count: string, active: boolean, unit: string}[]}
 */
function templateRows(body) {
  // 行集现在从文案表来（const STAGE_ROWS=…），切片必须把那段声明一起括进来。
  const rowsAt = body.indexOf('const STAGE_ROWS=')
  const labelsAt = rowsAt >= 0 ? rowsAt : body.indexOf('const labels=')
  const innerAt = body.indexOf('stepsHost.innerHTML=')
  assert.ok(labelsAt >= 0 && innerAt > labelsAt, 'the page paints its rows from a template expression')
  const decls = body.slice(labelsAt, innerAt)
  const exprEnd = body.indexOf(".join('');", innerAt)
  assert.ok(exprEnd > innerAt, 'the template expression ends on .join(...)')
  const expr = body.slice(innerAt, exprEnd + ".join('');".length)
  let painted = ''
  const host = { set innerHTML(v) { painted = v }, get innerHTML() { return painted }, classList: { add: () => {} } }
  const stepsHost = host
  const T = { stepServer: '连接桌面端', stepWorkspace: '读取工作区', stepSessionList: '读取会话列表', stepSession: '读取会话消息', stepPrepare: '正在准备页面' }
  // eslint-disable-next-line no-new-func
  new Function('stepsHost', 'ZH', 'T', `${decls}${expr};`)(stepsHost, true, T)
  const labels = [...painted.matchAll(/<span class="boot-step-label">([^<]*)<\/span>/g)].map((m) => m[1])
  const counts = [...painted.matchAll(/<span class="bsc"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1])
  const actives = [...painted.matchAll(/<div class="boot-step([^"]*)">/g)].map((m) => m[1].includes('is-active'))
  assert.equal(counts.length, labels.length, `every row carries one count span (${labels.length} rows)`)
  const rows = labels.map((label, i) => ({ label, count: counts[i], active: Boolean(actives[i]) }))
  return { rows, markup: painted }
}

/** The reconnect page's own template markup, painted once at module load. */
const RECONNECT_TEMPLATE = templateRows(script)

// ---------------------------------------------------------------------------
// 替身世界：4 行阶梯 + 手动时钟 + 事件账本
// ---------------------------------------------------------------------------

/** The four rows the shipped template paints, taken from the template itself. */
function parseTemplate(markup) {
  const labels = [...markup.matchAll(/<span class="boot-step-label">([^<]*)<\/span>/g)].map((m) => m[1])
  const counts = [...markup.matchAll(/<span class="bsc"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1])
  const actives = [...markup.matchAll(/<div class="boot-step([^"]*)">/g)].map((m) => m[1].includes('is-active'))
  assert.equal(labels.length, 5, `the reconnect ladder has five rows, saw ${labels.length}`)
  assert.equal(counts.length, labels.length)
  return labels.map((label, i) => ({ label, count: counts[i], active: Boolean(actives[i]) }))
}

function makeWorld({ tails = { a: { events: [{ type: 'user/message' }, { type: 'assistant/message' }] } }, delays = {} } = {}) {
  const clock = { now: 0, timers: [], seq: 0 }
  const events = []
  const calls = []
  const failReasons = []
  const nav = { at: null, url: null }
  // 判据 C3：markBooted 由页面在跳转前调用一次，这里只记账，不看它怎么写盘。
  const marks = []

  const fakeSetTimeout = (cb, ms = 0) => {
    const timer = { at: clock.now + Number(ms || 0), cb, id: (clock.seq += 1) }
    clock.timers.push(timer)
    return timer
  }
  const fakeClearTimeout = (timer) => {
    const i = clock.timers.indexOf(timer)
    if (i >= 0) clock.timers.splice(i, 1)
  }
  const fakeRaf = (cb) => fakeSetTimeout(cb, 16)

  // The ladder rows: each carries one .bsc cell, and every class change is booked.
  const buildRow = ({ label, count, active }, index) => {
    const classes = new Set(active ? ['is-active'] : [])
    const cell = { textContent: count, _released: false, _pending: null }
    const row = {
      label,
      cell,
      classes,
      querySelector: (sel) => (sel === '.bsc' ? cell : null),
      classList: {
        toggle: (name, force) => {
          const next = force === undefined ? !classes.has(name) : Boolean(force)
          if (next) classes.add(name)
          else classes.delete(name)
          events.push({ kind: 'class', row: index, name, on: next, at: clock.now })
          return next
        },
        add: (name) => { classes.add(name); events.push({ kind: 'class', row: index, name, on: true, at: clock.now }) },
        remove: (name) => { classes.delete(name); events.push({ kind: 'class', row: index, name, on: false, at: clock.now }) },
      },
    }
    return row
  }
  // Start on the rows the page's own template paints, so a test can touch the ladder
  // before runStages() runs (runStages re-paints them from the same template anyway).
  let rows = RECONNECT_TEMPLATE.rows.map(buildRow)
  const host = {
    classList: { add: () => {}, remove: () => {} },
    get children() { return rows },
    set innerHTML(markup) {
      rows = parseTemplate(markup).map(buildRow)
    },
    get innerHTML() { return '' },
  }
  const status = { hidden: true, textContent: '', after: () => {}, remove: () => {} }
  const elements = { bootSteps: host, status }
  const documentStub = {
    getElementById: (id) => elements[id] || null,
    createElement: () => ({
      id: '', className: '', type: '', textContent: '',
      style: {}, dataset: {},
      addEventListener: () => {}, remove: () => {}, after: () => {},
    }),
    addEventListener: () => {},
  }
  const storage = new Map()
  const sessionStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
  }

  const matchMedia = () => ({ matches: false })
  const DateShim = { now: () => clock.now }

  const run = new Function(
    'document', 'matchMedia', 'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'Date',
    `${ORGANS};return {countUp,paintCount,releaseCount,setCount,stepCountEl,gateLadder,paintStageSums,sumsReady}`,
  )
  const api = run(documentStub, matchMedia, fakeRaf, fakeSetTimeout, fakeClearTimeout, DateShim)

  const T = {
    stepWorkspace: '读取工作区',
    stepSessionList: '读取会话列表',
    stepSession: '读取会话消息',
    stepPrepare: '正在准备页面',
    openFailed: '页面打开失败，请点重新连接重试。',
    superseded: '这条连接已被别的页面接管，请重新输入密码。',
    timeout: '网络超时，请检查手机网络后重试。',
    stageFailed: '页面没打开成功，请点重试。',
    retry: '重新连接',
  }
  const ROW_UNIT = { bots: () => ' 个 BOT 与群', workspace: () => ' 个工作区', sessionList: () => ' 个会话', session: () => ' 条消息' }

  // R2.7.2：每格数字随它自己那条腿的回包到达——真页面的 rpc() 收到 `stage` 就地交给
  // paintStageSums，这里照同一个协议回包，才能断言「哪一格的数在哪个时刻成值」。
  const STAGE = {
    'bot.team': { bots: 2, botSessions: 3, rooms: 1 },
    'workspace.list': { workspaces: 3 },
    'session.list': { sessions: 2 },
  }
  const read = (method, value) => {
    // The call is booked when it LEAVES, not when it answers — 6C is about the three
    // legs going out together, so an answer that arrives later must not look like a
    // later departure.
    calls.push({ method, at: clock.now })
    return new Promise((resolve) => {
      fakeSetTimeout(() => {
        if (STAGE[method]) api.paintStageSums(STAGE[method])
        resolve({ ok: true, value: {} })
      }, delays[method] === undefined ? 0 : delays[method])
    })
  }

  const fetchStub = () => {
    calls.push({ method: 'boot', at: clock.now })
    return new Promise((resolve) => {
      fakeSetTimeout(() => {
        resolve({
          ok: true,
          json: async () => ({
            ws: { items: [] },
            sess: { items: [] },
            tails,
            // 判据 v7 §3：冷开页的卡片读这一份（裁决 R7：替身补 stageSummary，断言文本不动）。
            stageSummary: { ready: true, workspaces: 3, sessions: 2, messages: countTailMessages(tails), bots: 2, botSessions: 3, rooms: 1 },
          }),
        })
      }, delays.boot === undefined ? 0 : delays.boot)
    })
  }

  const location = { replace: (url) => { nav.at = clock.now; nav.url = url; calls.push({ method: 'replace', at: clock.now }) } }
  const fail = (message) => { failReasons.push({ message, at: clock.now }) }

  const deps = [
    'document', 'location', 'fetch', 'sessionStorage', 'setTimeout', 'clearTimeout', 'requestAnimationFrame',
    '$', 'ROW_UNIT', 'T', 'ZH', 'releaseCount', 'stageRunner', 'gateLadder', 'sumsReady', 'markBooted',
    'withRetry', 'rpc', 'withTimeout', 'FETCH_TIMEOUT_MS', 'bgTails',
    'paintStageSums', 'countUp', 'stepCountEl', 'setCount', 'shellReady', 'SHELL_ASSETS', 'diag', 'fail',
  ]
  const values = [
    documentStub, location, fetchStub, sessionStorage, fakeSetTimeout, fakeClearTimeout, fakeRaf,
    (id) => elements[id] || null, ROW_UNIT, T, true, api.releaseCount, makeStageRunner, api.gateLadder, api.sumsReady, () => { marks.push(clock.now) },
    async (fn) => fn(), (method) => read(method, { workspaces: 3, sessions: 2 }), async (p) => p, 8000,
    // R4.1：尾包腿自己带 messages（真页面的 bgTails 走 rpc，stage 由 rpc 交给
    // paintStageSums），替身在这里照同一个协议把这一格交出去。
    async () => {
      const messages = countTailMessages(tails)
      api.paintStageSums({ messages })
      return { tails, messages }
    },
    api.paintStageSums, api.countUp, api.stepCountEl, api.setCount, Promise.resolve(), {},
    () => {}, fail,
  ]
  const runner = new Function(...deps, `${RUN_STAGES}\nreturn runStages;`)
  const runStages = runner(...values)

  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const advance = async (ms) => {
    const target = clock.now + ms
    for (let guard = 0; guard < 400; guard += 1) {
      await flush()
      const due = clock.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      clock.timers.splice(clock.timers.indexOf(due), 1)
      if (due.at > clock.now) clock.now = due.at
      due.cb()
    }
    if (target > clock.now) clock.now = target
    await flush()
  }

  return { clock, events, calls, nav, marks, failReasons, api, rows: () => rows, advance, runStages, text: (i) => rows[i].cell.textContent }
}

test('6C the ladder lights one row at a time, never backwards, never skipping', async () => {
  const w = makeWorld({ delays: { 'workspace.list': 120, 'session.list': 240, boot: 360 } })
  const pending = w.runStages()
  await w.advance(1400)
  await pending.catch(() => {})

  const activeEvents = w.events.filter((e) => e.name === 'is-active')
  // Row 0 ships lit in the template; from then on the lit row only moves forward by one.
  const litOrder = []
  for (const e of activeEvents) if (e.on) litOrder.push(e.row)
  assert.deepEqual(litOrder, [1, 2, 3, 4], `the lit row walks 0→1→2→3→4, saw ${JSON.stringify(litOrder)}`)

  // At every booked moment at most one row is lit, and the ladder never un-lights the
  // row it has reached while lighting an earlier one.
  const active = new Set([0])
  for (const e of activeEvents) {
    if (e.on) active.add(e.row)
    else active.delete(e.row)
    assert.ok(active.size <= 1, `row ${e.row} change left ${active.size} rows lit at ${e.at} ms`)
  }

  // 6C also says the legs still leave together: the ladder paces the display, not
  // the reads. All four must be in flight at t=0 (bot.team 那条腿给三区 id 用).
  const starts = w.calls.filter((c) => c.method !== 'replace')
  assert.deepEqual(starts.map((c) => c.method).sort(), ['boot', 'bot.team', 'session.list', 'workspace.list'])
  for (const c of starts) assert.equal(c.at, 0, `${c.method} must leave at once, left at ${c.at} ms`)
})

test('6C2 each row waits for its own leg, and lights exactly when that leg answers', async () => {
  // 判据 R2.2：行与腿一一对应——第 1 行等 bot.team、第 2 行等工作区、第 3 行等会话列表、
  // 第 4 行（消息数量）等尾包腿。四条腿按 20/40/90/260 ms 错开：若实现退回成「等最慢
  // 一条再连跳」，四行会挤在同一时刻亮。
  const delays = { 'bot.team': 20, 'workspace.list': 40, 'session.list': 90, boot: 260 }
  const w = makeWorld({ delays })
  const pending = w.runStages()
  await w.advance(2000)
  await pending.catch(() => {})

  const lit = w.events.filter((e) => e.name === 'is-active' && e.on).map((e) => ({ row: e.row, at: e.at }))
  assert.deepEqual(lit.map((e) => e.row), [1, 2, 3, 4], 'the lit row still walks forward one at a time')
  const times = lit.map((e) => e.at)
  assert.equal(times[0], 20, `row 1 (bots) lights on bot.team's own answer (20 ms), saw ${times[0]}`)
  assert.equal(times[1], 40, `row 2 (workspace) lights on the workspace leg's own answer (40 ms), saw ${times[1]}`)
  assert.equal(times[2], 90, `row 3 (sessions) lights on the session leg's own answer (90 ms), saw ${times[2]}`)
  assert.ok(times[3] >= 260, `row 4 (messages) waits for the tail leg (260 ms), lit at ${times[3]}`)
})

test('6B the last row keeps its completion text 200 ms after it lands', async () => {
  const w = makeWorld({ delays: { 'workspace.list': 120, 'session.list': 240, boot: 360 } })
  const pending = w.runStages()
  // Walk until the completion text is written, then read it 200 ms later.
  let readyAt = null
  for (let step = 0; step < 200 && readyAt === null; step += 1) {
    await w.advance(20)
    if (w.text(4) === '已就绪') readyAt = w.clock.now
  }
  assert.ok(readyAt !== null, 'the last row must land on 已就绪')
  await w.advance(200)
  assert.equal(w.text(4), '已就绪', '200 ms after landing, the row still says 已就绪 (no scan took it back)')
  await w.advance(600)
  await pending.catch(() => {})
})

test('6B no timer invents a number: every cell goes from blank straight to its reading', async () => {
  const w = makeWorld()
  const pending = w.runStages()
  const seen = [[], [], [], [], []]; for (let i = 0; i < 5; i += 1) seen[i].push(w.text(i))
  for (let step = 0; step < 120; step += 1) {
    await w.advance(20)
    for (let i = 0; i < 5; i += 1) if (!seen[i].includes(w.text(i))) seen[i].push(w.text(i))
  }
  await pending.catch(() => {})
  // 判据 C1（用户 m00236①(a)「先显示一遍 000 再弹真值」）：整条阶梯跑完，每一格都只在
  // 真值到达的那一刻从空串变成读数——没有 0 预填，没有滚动序列，也没有第二次数值。
  const msgs = countTailMessages({ a: { events: [{ type: 'user/message' }, { type: 'assistant/message' }] } })
  assert.deepEqual(seen[0], ['', '3 bots & groups'], 'row 0 goes straight from blank to its reading (shipped unit factory, ZH undefined here)')
  assert.deepEqual(seen[1], ['', '3 ws'], 'row 1 goes straight from blank to its reading')
  assert.deepEqual(seen[2], ['', '2 sess'], 'row 2 goes straight from blank to its reading')
  assert.deepEqual(seen[3], ['', `${msgs} msg`], 'row 3 goes straight from blank to its reading')
  assert.deepEqual(seen[4], ['准备中', '已就绪'], 'the last row goes from the prepare wording straight to 已就绪')
})
test('6D navigation waits at least 500 ms after the completion text', async () => {
  const w = makeWorld({ delays: { 'workspace.list': 120, 'session.list': 240, boot: 360 } })
  const pending = w.runStages()
  await w.advance(1400)
  await pending.catch(() => {})

  let readyAt = null
  // Rebuild the timeline from the class/text bookkeeping: the completion write is the
  // first moment row 3 stops being the prepare row.
  for (const e of w.events) {
    if (e.name === 'is-active' && e.on && e.row === 4) readyAt = e.at
  }
  // The text write happens inside stage(3), i.e. after the row is lit.
  const navAt = w.nav.at
  assert.ok(navAt !== null, 'the page navigates once the ladder finishes')
  assert.equal(w.nav.url, '/')
  assert.ok(navAt - readyAt >= 500, `dwell ${navAt - readyAt} ms must be ≥ 500 ms (lit at ${readyAt}, navigated at ${navAt})`)
  // And the dwell is the page's own fixed wait, not an accident of the frame sync.
  assert.ok(navAt - readyAt <= 1400, `dwell ${navAt - readyAt} ms should stay near the fixed 500 ms`)
})

test('6D the pairing page orders the same three beats: completion, fixed dwell, navigation', () => {
  const page = renderPairingPinPage('zh', null, {})
  const body = [...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
  const ready = body.indexOf("if(sumsReady())setCount(lastRow,ZH?'已就绪':'ready')")
  const dwell = body.indexOf('await new Promise(r=>setTimeout(r,500))', ready)
  const nav = body.indexOf("location.replace('/')", dwell)
  assert.ok(ready >= 0, 'the pairing page writes 已就绪 on its sixth row')
  assert.ok(dwell > ready, 'a fixed 500 ms wait follows the completion text')
  assert.ok(nav > dwell, 'and the navigation comes after that wait, not before it')
})

test('6A both pages ship blank counted rows and the prepare wording on their last row', () => {
  for (const [name, page, rows] of [
    ['reconnect', renderMobileReconnectPage('zh', 'lan', {}), 5],
    ['pairing', renderPairingPinPage('zh', null, {}), 6],
  ]) {
    const body = [...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
    assert.ok(body.includes('const lastRow=labels.length-1;'), `${name}: the last row is derived, not hardcoded`)
    // 判据 C1.1/C1.3：计数的格子出生即空串，末行照旧「准备中」；模板里没有 0 预填，计数格
    // 上也没有任何 data-* 标记。
    assert.ok(
      body.includes("(i===lastRow?(ZH?'准备中':'preparing'):'')"),
      `${name}: counted rows open blank and the last row opens on 准备中`,
    )
    const spans = [...page.matchAll(/<span class="bsc"[^>]*>/g)].map((m) => m[0])
    assert.ok(spans.length > 0, `${name}: the counted cells ship`)
    for (const span of spans) assert.equal(/data-/.test(span), false, `${name}: a counted cell ships no marker`)
    // Run the page's own template expression and read the rows it paints.
    const painted = templateRows(body).rows
    assert.equal(painted.length, rows, `${name}: ${rows} rows`)
    assert.equal(painted[rows - 1].count, '准备中', `${name}: the last row opens with 准备中, saw "${painted[rows - 1].count}"`)
    for (let i = 0; i < rows - 1; i += 1) {
      assert.equal(painted[i].count, '', `${name}: row ${i} opens blank, saw "${painted[i].count}"`)
    }
  }
})

test('6E a cold boot marks itself once, on the hand-off path, before it navigates', async () => {
  // 判据 C3（用户 m00236①(b)：一次冷启动插了第二张卡）：标记只在阶梯真正走完的那条
  // 路径上写一次，且落在 location.replace('/') 之前。
  const w = makeWorld({ delays: { 'workspace.list': 120, 'session.list': 240, boot: 360 } })
  const pending = w.runStages()
  await w.advance(1400)
  await pending.catch(() => {})
  assert.equal(w.marks.length, 1, 'the boot is recorded exactly once')
  assert.ok(w.nav.at !== null, 'the ladder still hands over')
  assert.ok(w.marks[0] <= w.nav.at, `the mark (${w.marks[0]} ms) must land before the hand-off (${w.nav.at} ms)`)
})
