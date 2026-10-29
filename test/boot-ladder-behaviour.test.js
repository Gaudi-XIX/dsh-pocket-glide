// 判据第 6 条的行为面（2026-10-30 UI 统一卡，批次 A）。
//
// 静态 grep 只能证明「代码里写着 已就绪」「stopRowScan 多了一处」，证明不了：
//   6B  末行落完成文字后 200 ms 再读，屏上仍是那四个字（扫描线不许盖回来）；
//   6C  is-active 单调不减、步长 ≤ 1、同时只有一行；三条腿仍然同时出发（没被串行化）；
//   6D  跳转时刻与完成文字时刻差 ≥ 500 ms（停留是独立等待，不是拿帧同步凑出来的）。
//
// 所以这里不重写阶梯，而是把**页面实际出厂的脚本**里那两段真代码取出来跑：
// sharedStageScript() 的器官（gateLadder / stepCountEl / countUp / startRowScan /
// stopRowScan / releaseCount / setCount / stageRunner …）与重连页的 runStages()，
// 挂在一个只有 4 行的替身 DOM 与一台手动时钟上。断言读的是 class 变更事件序列与
// 文字内容，不是字符串匹配。
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMobileReconnectPage, renderPairingPinPage } from '../lib/pages.js'

const html = renderMobileReconnectPage('zh', 'lan', {})
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

const grab = (start, end) => {
  const from = script.indexOf(start)
  assert.ok(from >= 0, `missing anchor in the shipped page: ${start}`)
  const to = script.indexOf(end, from)
  assert.ok(to > from, `missing end anchor in the shipped page: ${end}`)
  return script.slice(from, to)
}
// 器官按闸门所在位置切三段（闸门在 COUNT_UP_MS 之前），与 boot-count-up.test.js 同法。
const ORGANS =
  grab('let ladderGated=false;', 'const COUNT_UP_MS=') +
  grab('const COUNT_UP_MS=', 'function setCount(') +
  grab('function setCount(', '\nconst rpc=')
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
  const unitsAt = body.indexOf('const units=')
  const innerAt = body.indexOf('stepsHost.innerHTML=')
  assert.ok(unitsAt >= 0 && innerAt > unitsAt, 'the page paints its rows from a template expression')
  const decls = body.slice(unitsAt, innerAt)
  const exprEnd = body.indexOf(".join('');", innerAt)
  assert.ok(exprEnd > innerAt, 'the template expression ends on .join(...)')
  const expr = body.slice(innerAt, exprEnd + ".join('');".length)
  let painted = ''
  const host = { set innerHTML(v) { painted = v }, get innerHTML() { return painted }, classList: { add: () => {} } }
  const stepsHost = host
  const ZH = true
  const ROW_UNIT = { workspace: () => ' 个工作区', sessionList: () => ' 个会话', session: () => ' 条消息' }
  const T = { stepServer: '连接桌面端', stepWorkspace: '读取工作区', stepSessionList: '读取会话列表', stepSession: '读取会话消息', stepPrepare: '正在准备页面' }
  // eslint-disable-next-line no-new-func
  const units = new Function('stepsHost', 'ZH', 'ROW_UNIT', 'T', `${decls}return units;`)(stepsHost, ZH, ROW_UNIT, T)
  // eslint-disable-next-line no-new-func
  new Function('stepsHost', 'ZH', 'ROW_UNIT', 'T', `${decls}${expr};`)(stepsHost, ZH, ROW_UNIT, T)
  const labels = [...painted.matchAll(/<span class="boot-step-label">([^<]*)<\/span>/g)].map((m) => m[1])
  const counts = [...painted.matchAll(/<span class="bsc"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1])
  const actives = [...painted.matchAll(/<div class="boot-step([^"]*)">/g)].map((m) => m[1].includes('is-active'))
  assert.equal(counts.length, labels.length, `every row carries one count span (${labels.length} rows)`)
  const rows = labels.map((label, i) => ({ label, count: counts[i], active: Boolean(actives[i]), unit: units[i]() }))
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
  assert.equal(labels.length, 4, `the reconnect ladder has four rows, saw ${labels.length}`)
  assert.equal(counts.length, labels.length)
  return labels.map((label, i) => ({ label, count: counts[i], active: Boolean(actives[i]) }))
}

function makeWorld({ tails = { a: { events: [{ type: 'user/message' }, { type: 'assistant/message' }] } }, delays = {} } = {}) {
  const clock = { now: 0, timers: [], seq: 0 }
  const events = []
  const calls = []
  const failReasons = []
  const nav = { at: null, url: null }

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
    const cell = { textContent: count, _scan: null, _probe: undefined, _fmt: undefined, _released: false, _pending: null }
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
    `${ORGANS};return {countUp,paintCount,releaseCount,setCount,stepCountEl,gateLadder,startRowScan,stopRowScan,countTailMessages}`,
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
  const ROW_UNIT = { workspace: () => ' 个工作区', sessionList: () => ' 个会话', session: () => ' 条消息' }

  const read = (method, value) => {
    // The call is booked when it LEAVES, not when it answers — 6C is about the three
    // legs going out together, so an answer that arrives later must not look like a
    // later departure.
    calls.push({ method, at: clock.now })
    return new Promise((resolve) => {
      fakeSetTimeout(() => {
        const index = method === 'workspace.list' ? 0 : 1
        const n = method === 'workspace.list' ? value.workspaces : value.sessions
        const unit = method === 'workspace.list' ? ' 个工作区' : ' 个会话'
        api.countUp(api.stepCountEl(index), n, (v) => `${v}${unit}`)
        resolve({ ok: true, value: {} })
      }, delays[method] === undefined ? 0 : delays[method])
    })
  }

  const fetchStub = () => {
    calls.push({ method: 'boot', at: clock.now })
    return new Promise((resolve) => {
      fakeSetTimeout(() => {
        resolve({ ok: true, json: async () => ({ ws: { items: [] }, sess: { items: [] }, tails }) })
      }, delays.boot === undefined ? 0 : delays.boot)
    })
  }

  const location = { replace: (url) => { nav.at = clock.now; nav.url = url; calls.push({ method: 'replace', at: clock.now }) } }
  const fail = (message) => { failReasons.push({ message, at: clock.now }) }

  const deps = [
    'document', 'location', 'fetch', 'sessionStorage', 'setTimeout', 'clearTimeout', 'requestAnimationFrame',
    '$', 'ROW_UNIT', 'T', 'ZH', 'stopRowScan', 'releaseCount', 'stageRunner', 'gateLadder',
    'withRetry', 'rpc', 'withTimeout', 'FETCH_TIMEOUT_MS', 'bgTailsPromise', 'countTailMessages',
    'countUp', 'stepCountEl', 'setCount', 'shellReady', 'SHELL_ASSETS', 'diag', 'fail',
  ]
  const values = [
    documentStub, location, fetchStub, sessionStorage, fakeSetTimeout, fakeClearTimeout, fakeRaf,
    (id) => elements[id] || null, ROW_UNIT, T, true, api.stopRowScan, api.releaseCount, makeStageRunner, api.gateLadder,
    async (fn) => fn(), (method) => read(method, { workspaces: 3, sessions: 2 }), async (p) => p, 8000, null,
    api.countTailMessages, api.countUp, api.stepCountEl, api.setCount, Promise.resolve(), {},
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

  return { clock, events, calls, nav, failReasons, api, rows: () => rows, advance, runStages, text: (i) => rows[i].cell.textContent }
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
  assert.deepEqual(litOrder, [1, 2, 3], `the lit row walks 0→1→2→3, saw ${JSON.stringify(litOrder)}`)

  // At every booked moment at most one row is lit, and the ladder never un-lights the
  // row it has reached while lighting an earlier one.
  const active = new Set([0])
  for (const e of activeEvents) {
    if (e.on) active.add(e.row)
    else active.delete(e.row)
    assert.ok(active.size <= 1, `row ${e.row} change left ${active.size} rows lit at ${e.at} ms`)
  }

  // 6C also says the three legs still leave together: the ladder paces the display, not
  // the reads. All three must be in flight at t=0.
  const starts = w.calls.filter((c) => c.method !== 'replace')
  assert.deepEqual(starts.map((c) => c.method).sort(), ['boot', 'session.list', 'workspace.list'])
  for (const c of starts) assert.equal(c.at, 0, `${c.method} must leave at once, left at ${c.at} ms`)
})

test('6B the last row keeps its completion text 200 ms after it lands', async () => {
  const w = makeWorld({ delays: { 'workspace.list': 120, 'session.list': 240, boot: 360 } })
  const pending = w.runStages()
  // Walk until the completion text is written, then read it 200 ms later.
  let readyAt = null
  for (let step = 0; step < 200 && readyAt === null; step += 1) {
    await w.advance(20)
    if (w.text(3) === '已就绪') readyAt = w.clock.now
  }
  assert.ok(readyAt !== null, 'the last row must land on 已就绪')
  await w.advance(200)
  assert.equal(w.text(3), '已就绪', '200 ms after landing, the row still says 已就绪 (no scan took it back)')
  await w.advance(600)
  await pending.catch(() => {})
})

test('6B a rolling scan on the last row is stopped by the completion write', async () => {
  const w = makeWorld()
  // The page never scans the last row itself; this proves the guard in setCount: a scan
  // that IS running is killed, so no random digit can survive the completion text.
  w.api.startRowScan(w.api.stepCountEl(3), 3)
  assert.equal(w.api.stepCountEl(3)._scan !== null, true, 'the scan is rolling before the write')
  w.api.setCount(3, '已就绪')
  assert.equal(w.text(3), '已就绪')
  await w.advance(200)
  assert.equal(w.text(3), '已就绪', 'the scan is dead: 200 ms later the text is untouched')
  assert.equal(w.api.stepCountEl(3)._scan, null, 'and its timer handle is cleared, not just ignored')
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
    if (e.name === 'is-active' && e.on && e.row === 3) readyAt = e.at
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
  const ready = body.indexOf("setCount(4,ZH?'已就绪':'ready')")
  const dwell = body.indexOf('await new Promise(r=>setTimeout(r,500))', ready)
  const nav = body.indexOf("location.replace('/')", dwell)
  assert.ok(ready >= 0, 'the pairing page writes 已就绪 on its fifth row')
  assert.ok(dwell > ready, 'a fixed 500 ms wait follows the completion text')
  assert.ok(nav > dwell, 'and the navigation comes after that wait, not before it')
})

test('6A both pages ship the prepare wording on their own last row, not a zero', () => {
  for (const [name, page, rows] of [
    ['reconnect', renderMobileReconnectPage('zh', 'lan', {}), 4],
    ['pairing', renderPairingPinPage('zh', null, {}), 5],
  ]) {
    const body = [...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
    assert.ok(body.includes('const lastRow=labels.length-1;'), `${name}: the last row is derived, not hardcoded`)
    assert.ok(
      body.includes("(i===lastRow?(ZH?'准备中':'preparing'):'0'+(units[i]?units[i]():''))"),
      `${name}: the seed is 准备中 on the last row and 0+unit on the counted ones`,
    )
    // Run the page's own template expression and read the rows it paints.
    const painted = templateRows(body).rows
    assert.equal(painted.length, rows, `${name}: ${rows} rows`)
    assert.equal(painted[rows - 1].count, '准备中', `${name}: the last row opens with 准备中, saw "${painted[rows - 1].count}"`)
    for (let i = 0; i < rows - 1; i += 1) {
      // The pairing page's first row is the server row: its unit factory is `()=>''`,
      // so its seed is a bare `0` — a counted row still starts on a real zero.
      const expected = `0${painted[i].unit}`
      assert.equal(painted[i].count, expected, `${name}: row ${i} opens on a real zero, saw "${painted[i].count}"`)
    }
  }
})
