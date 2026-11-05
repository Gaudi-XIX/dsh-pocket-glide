// Regression lock (2026-10-21): the guided pages' rpc() built its boot-ladder
// formatter as a bare string (`zh?v+' 个工作区':v+' ws'`) instead of an arrow
// function, so every rpc() call threw `ReferenceError: v is not defined` before
// the request ever left the page. Both the reconnect page and the PIN page then
// dead-ended on "暂时无法连接桌面端" / "页面没打开成功" no matter how healthy the
// bridge was. The break shipped in e19957d and stayed invisible because a phone
// with a live session never renders these pages — only a phone that just lost its
// session does, which is exactly the moment reconnection has to work.
// This runs the generated page script (the same text the phone receives) against
// a stub DOM and asserts the request really goes out and the count lands.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bootRangeCap, renderMobileReconnectPage, renderPairingPinPage } from '../lib/pages.js'

function stubElement(extra = {}) {
  return {
    textContent: '',
    className: '',
    hidden: false,
    disabled: false,
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    focus() {},
    remove() {},
    ...extra
  }
}

function extractScript(render) {
  const match = render.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(match, 'page script missing')
  return match[1]
}

function buildHarness({
  html,
  rows = null,
  workspaces = [{ name: 'w1' }, { name: 'w2' }],
  sessions = [
    { sessionId: 's1', updatedAt: Date.now() },
    { sessionId: 's2', updatedAt: Date.now() }
  ],
  pinned = [],
  tailStage = null,
  tailMessages = 0
} = {}) {
  const script = extractScript(html)
  const counts = []
  // 出厂模板的计数格出生是空串、末行是「准备中」（判据 C1.1/C1.3）；夹具照抄，
  // 「rpc() 不画阶梯」就表现为「种子原样还在」，而不是手抄一份「0+量词」当种子。
  const rowsAt = script.indexOf('const STAGE_ROWS=')
  const rowsEnd = script.indexOf(';const labels=', rowsAt)
  assert.ok(rowsAt >= 0 && rowsEnd > rowsAt, 'the page serialises its stage rows')
  const STAGE_ROWS = JSON.parse(script.slice(rowsAt + 'const STAGE_ROWS='.length, rowsEnd))
  const leadingRow = /"stepServer":/.test(script)
  const total = rows === null ? STAGE_ROWS.length + (leadingRow ? 1 : 0) : rows
  const seeds = Array.from({ length: total }, () => '')
  seeds[total - 1] = /"stepServer":/.test(script) ? '准备中' : '准备中'
  const children = Array.from({ length: total }, (_, i) => {
    const count = stubElement({ textContent: seeds[i] })
    counts.push(count)
    return stubElement({ querySelector: (sel) => (sel === '.bsc' ? count : null) })
  })
  const elements = new Map()
  const element = (id) => {
    if (id === 'bootSteps') return stubElement({ children })
    if (!elements.has(id)) elements.set(id, stubElement())
    return elements.get(id)
  }
  const requests = []
  const fetchStub = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null
    requests.push({ url, body })
    if (body?.method === 'session.tails') {
      // 尾包腿的真回包形状（lib/bridge.js 的 session.tails 分支）：value 带 tails 与
      // messages，`stage` 才是 rpc() 那一跳要喂的格子。默认不给 stage（桥侧没下发），
      // 只有要看守 quiet 开关的用例才传 tailStage。
      const reply = { ok: true, value: { tails: { s1: { events: [] } }, messages: tailMessages } }
      if (typeof tailStage === 'number') reply.stage = { messages: tailStage }
      return { url: `http://bridge${url}`, status: 200, ok: true, async json() { return reply } }
    }
    const value =
      body?.method === 'workspace.list'
        ? { items: workspaces, pinnedSessionIds: pinned }
        : body?.method === 'session.list'
          ? { items: sessions }
          : {}
    return { url: `http://bridge${url}`, status: 200, ok: true, async json() { return { ok: true, value } } }
  }
  const scope = {
    document: {
      getElementById: element,
      querySelector: () => stubElement(),
      addEventListener() {},
      body: stubElement()
    },
    navigator: { serviceWorker: undefined, sendBeacon() { return true } },
    window: { addEventListener() {} },
    fetch: fetchStub,
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    sessionStorage: { setItem() {}, getItem: () => null },
    localStorage: { getItem: () => null, setItem() {} },
    location: { pathname: '/disconnected', hostname: 'bridge', href: 'http://bridge/disconnected', replace() {} },
    history: { replaceState() {} },
    setTimeout,
    clearTimeout,
    addEventListener() {},
    URL,
    JSON,
    Object,
    Array,
    Number,
    Math,
    Date,
    String,
    Boolean,
    Promise,
    Error
  }
  const names = Object.keys(scope)
  const factory = new Function(...names, `${script}\nreturn { rpc, paintStageSums, stepCountEl, T, bgTails }`)
  return { api: factory(...names.map((name) => scope[name])), requests, counts, script }
}

test('reconnect page: rpc() sends the request instead of throwing', async () => {
  const { api, requests } = buildHarness({ html: renderMobileReconnectPage('zh', 'tunnel', {}) })
  const value = await api.rpc('workspace.list')
  const workspaceCalls = requests.filter((r) => r.body.method === 'workspace.list')
  assert.equal(workspaceCalls.length, 1, 'rpc() must reach the bridge')
  assert.equal(workspaceCalls[0].url, '/api/rpc')
  assert.equal(value.items.length, 2)
})

test('reconnect page: workspace count lands on the second ladder row', async () => {
  const { api, counts } = buildHarness({ html: renderMobileReconnectPage('zh', 'tunnel', {}) })
  await api.rpc('workspace.list')
  assert.equal(counts[1].textContent, '', 'rpc() reads the list, it does not paint the ladder (v7 §3)')
  api.paintStageSums({ workspaces: 2, sessions: 2 })
  assert.equal(counts[1].textContent, '2 个工作区')
})

test('reconnect page: session count lands on the third ladder row', async () => {
  const { api, counts } = buildHarness({ html: renderMobileReconnectPage('zh', 'tunnel', {}) })
  await api.rpc('session.list', { limit: 10 })
  assert.equal(counts[2].textContent, '', 'rpc() reads the list, it does not paint the ladder (v7 §3)')
  api.paintStageSums({ workspaces: 2, sessions: 2 })
  assert.equal(counts[2].textContent, '2 个会话')
})

test('reconnect page: only the 24-hour window and the pins reach the session count', async () => {
  // 用户 2026-10-27：「冷启动时显示的会话数量有问题，上面显示 1000 多，这肯定是有问题的。
  // 它应该只显示我们规则里的 24 小时 + 置顶的数量」。这台机器攒了 6835 个历史会话，
  // items.length 读到 6835，而首页只会显示置顶与一天之内更新过的那几行。
  const now = Date.now()
  const stale = now - 3 * 24 * 60 * 60 * 1000
  const tasks = [
    { sessionId: 'old1', updatedAt: stale },
    { sessionId: 'old2', updatedAt: stale },
    { sessionId: 'pinned-old', updatedAt: stale },
    { sessionId: 'fresh1', updatedAt: now - 60_000 },
    { sessionId: 'fresh2', updatedAt: now - 120_000 }
  ]
  assert.equal(
    bootRangeCap(tasks, now, new Set(['pinned-old'])),
    3,
    'two fresh rows plus one pinned row, not the five the catalogue holds'
  )
})

test('reconnect page: an all-stale catalogue still counts one row', async () => {
  // 与主页 bootRangeCap 同一个地板：窗口里一行都没有时首页仍会显示至少一行，
  // 阶梯就该数 1，读者看到的数字要等于他接下来真看到的行数。
  const stale = Date.now() - 30 * 24 * 60 * 60 * 1000
  const tasks = [
    { sessionId: 'a', updatedAt: stale },
    { sessionId: 'b', updatedAt: stale }
  ]
  assert.equal(bootRangeCap(tasks, Date.now(), new Set()), 1, 'nothing inside the window still leaves the one row the landing paints')
})

test('reconnect page: subagent rows stay out of the session count', async () => {
  // 主页把这些行交给子代理栏（splitSubagentRows），它们不在会话列表里；
  // 阶梯数的是「首页会显示的行」。
  const now = Date.now()
  const tasks = [
    { sessionId: 'main1', updatedAt: now },
    { sessionId: 'sub1', origin: 'subagent', updatedAt: now },
    { sessionId: 'sub2', origin: 'subagent', updatedAt: now }
  ].filter((row) => row.origin !== 'subagent')
  assert.equal(bootRangeCap(tasks, now, new Set()), 1, 'subagent rows never reach the landing count')
})

test('reconnect page: english locale counts in english', async () => {
  const { api, counts } = buildHarness({ html: renderMobileReconnectPage('en', 'tunnel', {}) })
  await api.rpc('workspace.list')
  assert.equal(counts[1].textContent, '', 'rpc() reads the list, it does not paint the ladder (v7 §3)')
  api.paintStageSums({ workspaces: 2, sessions: 2 })
  assert.equal(counts[1].textContent, '2 ws')
})

test('PIN page: rpc() sends the request, and the six-row ladder maps rows 2..4', async () => {
  const { api, requests, counts } = buildHarness({ html: renderPairingPinPage('zh') })
  await api.rpc('session.list', { limit: 10 })
  assert.equal(requests.filter((r) => r.body.method === 'session.list').length, 1)
  assert.deepEqual(
    counts.map((count) => count.textContent),
    ['', '', '', '', '', '准备中'],
    'rpc() does not paint: the counted cells stay blank and the last row keeps 准备中 (v7 §3)'
  )
  api.paintStageSums({ workspaces: 2, sessions: 3, messages: 5 })
  assert.equal(counts[2].textContent, '2 个工作区', 'the PIN ladder starts counting on its third row')
  assert.equal(counts[3].textContent, '3 个会话')
  assert.equal(counts[4].textContent, '5 条消息', 'the "reading the conversation" row shows the summary messages')
  assert.equal(counts[0].textContent, '', 'the connection row never takes a count')
  assert.equal(counts[1].textContent, '', 'BOT 与群那一行只吃 botSessions，摘要没给就不动')
  api.paintStageSums({ workspaces: 2, sessions: 3, messages: 5, bots: 4, botSessions: 6, rooms: 2 })
  assert.equal(counts[1].textContent, '6 个 BOT 与群', 'botSessions 一到就落在 BOT 与群那一行')

  const reconnect = buildHarness({ html: renderMobileReconnectPage('zh', 'tunnel', {}) })
  reconnect.api.paintStageSums({ workspaces: 2, sessions: 3, messages: 5, bots: 4, botSessions: 6, rooms: 2 })
  assert.equal(reconnect.counts[0].textContent, '6 个 BOT 与群', 'the five-row ladder counts bots from row 0')
  assert.equal(reconnect.counts[1].textContent, '2 个工作区')
  assert.equal(reconnect.counts[2].textContent, '3 个会话')
  assert.equal(reconnect.counts[3].textContent, '5 条消息')
  assert.equal(reconnect.counts[4].textContent, '准备中', 'its last row is the preparing label, not a count')
})

test('the in-flight odometer is gone, so no row can show a numbers-only fake', () => {
  // countCrawl used to move each row on every animation frame from the instant the
  // request left. Three rows started in the same tick, so all three read the same
  // number, and that number was elapsed time rather than a count (user 2026-10-21:
  // "数字都是一样的，并且数字明显是错的"). Nothing may bring it back.
  for (const html of [renderMobileReconnectPage('zh', 'tunnel', {}), renderPairingPinPage('zh')]) {
    const script = extractScript(html)
    assert.equal(script.includes('countCrawl('), false, 'no countCrawl() call site may remain')
    assert.equal(script.includes('function countCrawl('), false, 'the odometer organ itself is deleted')
  }
})

test('every countUp() call site passes a formatter, never a bare expression', () => {
  // The formatter is what makes a raw reading readable ("2 个工作区" rather than a
  // naked 2); a bare expression here shipped once and put "undefined" on the ladder.
  for (const html of [renderMobileReconnectPage('zh', 'tunnel', {}), renderPairingPinPage('zh')]) {
    const script = extractScript(html)
    const sites = []
    for (let at = script.indexOf('countUp(stepCountEl('); at !== -1; at = script.indexOf('countUp(stepCountEl(', at + 1)) {
      // The formatter is the final argument, so it follows a comma straight after
      // the row lookup — a window is enough to see its shape without parsing JS.
      sites.push(script.slice(at, at + 90))
    }
    assert.ok(sites.length >= 1, 'expected the guided ladder to count its summary rows')
    assert.ok(
      script.includes('const suffix=ROW_UNIT[unit]();'),
      'each row derives its own unit formatter from ROW_UNIT'
    )
    for (const site of sites) {
      assert.match(
        site,
        /(?:\(|,)\s*(?:\(\s*[A-Za-z_$][\w$]*\s*\)|[A-Za-z_$][\w$]*)\s*=>/,
        `countUp() needs a formatter arrow, saw: ${site.slice(0, 90)}`
      )
    }
  }
})

// ---------------------------------------------------------------------------
// PIN 阶梯第 4 格的真值来源（change
// 2026-11-04-bugfix-pocket-pin-ladder-messages-and-reentry-hang）
// ---------------------------------------------------------------------------
//
// 首次配对的 PIN 页上，`bootPreloadIds()` 给不出任何 id，`bgTails()` 于是直接交回
// null（lib/pages.js 的 `if(ids.length===0)return null`）——`session.tails` 根本不发，
// 那一次 boot 里 `stage.messages` 也就没有第二个来源，第 4 格「同步消息数量」永远是空白。
// 修好的这一格接的是本次 `/api/boot` **自己算出来的** `stageSummary.messages`
// （桥侧 = countVisibleMessageUnits(tails)，见 lib/bridge.js 的 buildMobileBoot）。
// 下面执行的是出货脚本里那一条腿的原文，不是复述一遍。

/** 出货页里那条 boot 腿的原文（`withRetry(async()=>{const bootFetch=...return parsed})`）。 */
function bootLegSource(script) {
  const at = script.indexOf('withRetry(async()=>{const bootFetch=')
  assert.ok(at > 0, 'the boot leg must be shipped in the page script')
  const end = script.indexOf('return parsed})]', at)
  assert.ok(end > at, 'the boot leg ends where the reads table ends')
  return script.slice(at, end + 'return parsed})'.length)
}

/** Run that leg with the deps the page would hand it. */
async function runBootLeg(script, paintStageSums, { boot, bgPack = null, bgTails = null } = {}) {
  const storage = new Map()
  const fetches = []
  const run = new Function(
    'fetch', 'withTimeout', 'FETCH_TIMEOUT_MS', 'bgTails', 'paintStageSums', 'sessionStorage', 'withRetry',
    `return (${bootLegSource(script)})`
  )
  const value = await run(
    async (url) => {
      fetches.push(String(url))
      if (String(url).startsWith('/api/boot')) return boot
      return { ok: false, status: 404, json: async () => ({}) }
    },
    async (promise) => promise,
    10000,
    bgTails || (async () => bgPack),
    paintStageSums,
    { setItem: (key, text) => storage.set(key, String(text)), getItem: (key) => storage.get(key) ?? null },
    async (fn) => fn()
  )
  return { value, storage, fetches }
}

/** /api/boot 的成功回包；messages 就是本次 boot 的可见消息单位数。 */
const bootAnswer = (messages) => ({
  ok: true,
  async json() {
    return {
      ws: { items: [] },
      sess: { items: [] },
      tails: {},
      stageSummary: { ready: true, workspaces: 1, sessions: 2, messages, bots: 1, botSessions: 1, rooms: 0 },
      assets: null
    }
  }
})

test('PIN page: the boot leg paints row 4 from that boot summary — even with no tail packs', async () => {
  const { api, counts, script } = buildHarness({ html: renderPairingPinPage('zh') })
  const { value } = await runBootLeg(script, api.paintStageSums, { boot: bootAnswer(7), bgPack: null })
  assert.equal(counts[4].textContent, '7 条消息', 'the message row takes the boot summary number itself')
  assert.deepEqual(counts.slice(0, 4).map((count) => count.textContent), ['', '', '', ''], 'and no other row moves')
  assert.equal(counts[5].textContent, '准备中', 'the preparing row is not a count')
  assert.equal(value.stageSummary.messages, 7, 'the leg still hands the payload to the caller')
})

test('PIN page: a boot that never answers leaves row 4 blank — no 0 seed, no fake', async () => {
  const { api, counts, script } = buildHarness({ html: renderPairingPinPage('zh') })
  // 配对完成之前 /api/boot 就是 401；网络失败时更是 null。两种都不许先画一个 0。
  const { value } = await runBootLeg(script, api.paintStageSums, { boot: { ok: false, status: 401, json: async () => ({}) } })
  assert.equal(value, null, 'no payload, nothing to paint')
  assert.deepEqual(
    counts.map((count) => count.textContent),
    ['', '', '', '', '', '准备中'],
    'the ladder stays exactly as the template painted it'
  )
})

test('PIN page: row 4 takes its number once — a later summary cannot rewrite it', async () => {
  const { api, counts, script } = buildHarness({ html: renderPairingPinPage('zh') })
  await runBootLeg(script, api.paintStageSums, { boot: bootAnswer(9) })
  assert.equal(counts[4].textContent, '9 条消息')
  await runBootLeg(script, api.paintStageSums, { boot: bootAnswer(11) })
  assert.equal(counts[4].textContent, '9 条消息', 'cell._set: one value per cell, no second rewrite')
})

test('PIN page: the tail pack still merges into the stored boot, and row 4 keeps the boot number', async () => {
  const { api, counts, script } = buildHarness({ html: renderPairingPinPage('zh') })
  const { value, storage } = await runBootLeg(script, api.paintStageSums, {
    boot: bootAnswer(4),
    bgPack: { tails: { s1: { events: [] } }, messages: 40 }
  })
  assert.equal(counts[4].textContent, '4 条消息', 'row 4 is the boot summary, not the wider tail pack')
  assert.ok(value.tails.s1, 'the tail pack is still merged into the payload the app document reads')
  const stored = JSON.parse([...storage.values()][0])
  assert.ok(stored.tails.s1, 'and the merged payload is what lands in sessionStorage')
})

// ---------------------------------------------------------------------------
// quiet 抑制的执行级守卫（verify Major-1）
//
// 上面那条「尾包并进来、第 4 格仍是 boot 数」给 runBootLeg 传的是字面替身
// `async () => bgPack`，它把 quiet 形参和 rpc() 里 `if(y.stage&&!quiet)` 那一跳整个
// 绕开——把那行 `!quiet` 删掉，出货套件一条都不会红（verify 实测新增红 0 条）。
// 下面三条走**真** `bgTails(quiet)` → 真 `rpc()` 一跳，是这条不变量在出货侧的执行级
// 防线：删 `!quiet` 第 1、3 条恰红，第 2 条是配对阳性对照。
//
// 尾包腿的真回包形状与真 fetch 都走 buildHarness 的 tailStage 选项（见上）。

/** 三趟阶梯读落地（出货页同一条门），尾包腿这时才交得出非空集合。 */
async function settleStageReads(api) {
  await api.rpc('workspace.list')
  await api.rpc('session.list')
  await api.rpc('bot.team')
}

/**
 * 尾包腿用得上的夹具：两个会话被工作区认领——不认领的话 unclaimedSessionIds()
 * 会把它们整个划进 ungrouped，bootPreloadIds() 交回空集合，尾包腿根本不发；
 * `tailStage` 让桥侧回包带上 `stage`，quiet 开关就守在这一跳上。
 */
function tailLegHarness() {
  return buildHarness({
    html: renderPairingPinPage('zh'),
    workspaces: [{ name: 'w1', sessionIds: ['s1', 's2'] }],
    tailStage: 40,
    tailMessages: 40
  })
}

test('PIN page: the real tail leg stays quiet — its rpc hop must not paint row 4', async () => {
  const { api, counts, requests } = tailLegHarness()
  await settleStageReads(api)
  const pack = await api.bgTails(true)
  assert.equal(pack.messages, 40, 'the real bgTails did go out and come back')
  assert.equal(
    requests.filter((r) => r.body.method === 'session.tails').length,
    1,
    'and it went out through the real rpc wrapper, not a stub'
  )
  assert.deepEqual(
    counts.map((count) => count.textContent),
    ['', '', '', '', '', '准备中'],
    'quiet: the rpc hop paints nothing behind the boot leg\'s back'
  )
})

test('PIN page: the same real tail leg paints as soon as it is not asked to stay quiet', async () => {
  const { api, counts } = tailLegHarness()
  await settleStageReads(api)
  await api.bgTails()
  assert.equal(counts[4].textContent, '40 条消息', 'without quiet the rpc hop hands the ladder its own count')
})

test('PIN page: with the real tail leg in the chain row 4 still keeps the boot number', async () => {
  const { api, counts, script } = tailLegHarness()
  await settleStageReads(api)
  const { value, storage } = await runBootLeg(script, api.paintStageSums, {
    boot: bootAnswer(4),
    bgTails: api.bgTails
  })
  assert.equal(
    counts[4].textContent,
    '4 条消息',
    'the boot number, not the wider tail pack that came back through the real rpc hop'
  )
  assert.ok(value.tails.s1, 'the tail pack is still merged into the payload the app document reads')
  const stored = JSON.parse([...storage.values()][0])
  assert.ok(stored.tails.s1, 'and the merged payload is what lands in sessionStorage')
})
