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
import { renderMobileReconnectPage, renderPairingPinPage } from '../lib/pages.js'

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

function buildHarness({ html, rows = 4 } = {}) {
  const script = extractScript(html)
  const counts = []
  const children = Array.from({ length: rows }, () => {
    const count = stubElement()
    counts.push(count)
    return stubElement({ querySelector: (sel) => (sel === '.boot-step-count' ? count : null) })
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
        ? { items: [{ name: 'w1' }, { name: 'w2' }] }
        : body?.method === 'session.list'
          ? { items: [{ sessionId: 's1' }, { sessionId: 's2' }] }
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
  const factory = new Function(...names, `${script}\nreturn { rpc, countStepIndex, stepCountEl, T }`)
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
  assert.equal(counts[0].textContent, '2 个工作区')
})

test('reconnect page: session count lands on the second ladder row', async () => {
  const { api, counts } = buildHarness({ html: renderMobileReconnectPage('zh', 'tunnel', {}) })
  await api.rpc('session.list', { limit: 10 })
  assert.equal(counts[1].textContent, '2 个会话')
})

test('reconnect page: english locale counts in english', async () => {
  const { api, counts } = buildHarness({ html: renderMobileReconnectPage('en', 'tunnel', {}) })
  await api.rpc('workspace.list')
  assert.equal(counts[0].textContent, '2 ws')
})

test('PIN page: rpc() sends the request and maps rows for the five-step ladder', async () => {
  const { api, requests, counts } = buildHarness({ html: renderPairingPinPage('zh'), rows: 5 })
  assert.equal(api.countStepIndex('workspace.list'), 1)
  assert.equal(api.countStepIndex('session.list'), 2)
  await api.rpc('session.list', { limit: 10 })
  assert.equal(requests.filter((r) => r.body.method === 'session.list').length, 1)
  assert.equal(counts[2].textContent, '2 个会话')
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
    assert.ok(sites.length >= 2, 'expected the guided ladder to count at least two rows')
    for (const site of sites) {
      assert.match(site, /(?:\(|,)\s*(?:\(\s*v\s*\)|v)\s*=>/, `countUp() needs a formatter arrow, saw: ${site.slice(0, 90)}`)
    }
  }
})
