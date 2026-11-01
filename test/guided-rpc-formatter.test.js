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
  rows = 4,
  workspaces = [{ name: 'w1' }, { name: 'w2' }],
  sessions = [
    { sessionId: 's1', updatedAt: Date.now() },
    { sessionId: 's2', updatedAt: Date.now() }
  ],
  pinned = []
} = {}) {
  const script = extractScript(html)
  const counts = []
  // The shipped pages seed every counted row with "0 + 它的量词"; the harness
  // mirrors that so "rpc() does not paint" is observable as "the seed is intact".
  const seeds = ['0 个工作区', '0 个会话', '0 条消息', '0', '0']
  const children = Array.from({ length: rows }, (_, i) => {
    const count = stubElement({ textContent: seeds[i] || '0' })
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
  const factory = new Function(...names, `${script}\nreturn { rpc, paintStageSums, stepCountEl, T }`)
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

test('reconnect page: workspace count lands on the first ladder row', async () => {
  const { api, counts } = buildHarness({ html: renderMobileReconnectPage('zh', 'tunnel', {}) })
  await api.rpc('workspace.list')
  assert.equal(counts[0].textContent, '0 个工作区', 'rpc() reads the list, it does not paint the ladder (v7 §3)')
  api.paintStageSums({ workspaces: 2, sessions: 2 })
  assert.equal(counts[0].textContent, '2 个工作区')
})

test('reconnect page: session count lands on the second ladder row', async () => {
  const { api, counts } = buildHarness({ html: renderMobileReconnectPage('zh', 'tunnel', {}) })
  await api.rpc('session.list', { limit: 10 })
  assert.equal(counts[1].textContent, '0 个会话', 'rpc() reads the list, it does not paint the ladder (v7 §3)')
  api.paintStageSums({ workspaces: 2, sessions: 2 })
  assert.equal(counts[1].textContent, '2 个会话')
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
  assert.equal(counts[0].textContent, '0 个工作区', 'rpc() reads the list, it does not paint the ladder (v7 §3)')
  api.paintStageSums({ workspaces: 2, sessions: 2 })
  assert.equal(counts[0].textContent, '2 ws')
})

test('PIN page: rpc() sends the request, and the five-step ladder maps rows 1..3', async () => {
  const { api, requests, counts } = buildHarness({ html: renderPairingPinPage('zh'), rows: 5 })
  await api.rpc('session.list', { limit: 10 })
  assert.equal(requests.filter((r) => r.body.method === 'session.list').length, 1)
  assert.deepEqual(
    counts.map((count) => count.textContent),
    ['0 个工作区', '0 个会话', '0 条消息', '0', '0'],
    'rpc() does not paint: the summary does (v7 §3)'
  )
  api.paintStageSums({ workspaces: 2, sessions: 3, messages: 5 })
  assert.equal(counts[1].textContent, '2 个工作区', 'the PIN ladder starts counting on its second row')
  assert.equal(counts[2].textContent, '3 个会话')
  assert.equal(counts[3].textContent, '5 条消息', 'the "reading the conversation" row shows the summary messages')
  assert.equal(counts[0].textContent, '0 个工作区', 'the connection row never takes a count')

  const reconnect = buildHarness({ html: renderMobileReconnectPage('zh', 'tunnel', {}), rows: 4 })
  reconnect.api.paintStageSums({ workspaces: 2, sessions: 3, messages: 5 })
  assert.equal(reconnect.counts[0].textContent, '2 个工作区', 'the four-row ladder still counts from row 0')
  assert.equal(reconnect.counts[1].textContent, '3 个会话')
  assert.equal(reconnect.counts[2].textContent, '5 条消息')
  assert.equal(reconnect.counts[3].textContent, '0', 'its last row is the preparing label, not a count')
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
