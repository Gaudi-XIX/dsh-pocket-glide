// 首帧裁决卡的页面半场（AC-P1…P4）。文档里的那段脚本不进壳资产，所以这里把它拎出来
// 放进 vm 跑：DOM/时钟/信标全用桩，断言的仍是真脚本字节，不是另一套复刻逻辑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { mobilePageAssets, renderByePage, renderMobilePage } from '../lib/pages.js'

const BOOT = JSON.stringify({ ws: { items: [] }, sess: { items: [] } })
const COLD_LINES = ['宿主正在重启', '微信会收到一条推送', '<b>任意回复</b>']

function makeEl(tag = 'div') {
  return {
    tagName: tag,
    children: [],
    style: {},
    hidden: false,
    textContent: '',
    innerHTML: '',
    className: '',
    type: '',
    onclick: null,
    appendChild(child) { this.children.push(child); return child },
    addEventListener() {},
    contains() { return true },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 48 } }
  }
}

/** The first-frame script is the one that publishes the boot fallback promise. */
function verdictScript(html) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const script = scripts.find((body) => body.includes('window.__fB='))
  assert.ok(script, 'every document must carry the first-frame script')
  return script
}

function runVerdict(html, options = {}) {
  const script = verdictScript(html)
  const beacons = []
  const timers = []
  const fetchCalls = []
  const box = makeEl('div')
  box.hidden = true // the document ships `<div id="firstFrameVerdict" hidden>`
  const refresh = makeEl('button')
  const docState = { rows: options.rows ?? 0 }
  const rows = () => (docState.rows
    ? Array.from({ length: docState.rows }, () => ({ ...makeEl('article'), className: 'task-row' }))
    : [])
  const document = {
    readyState: 'loading',
    documentElement: makeEl('html'),
    querySelectorAll(selector) { return selector.includes('.task-row') ? rows() : [] },
    querySelector(selector) { return selector.includes('.task-row') ? rows()[0] ?? null : null },
    getElementById(id) {
      if (id === 'firstFrameVerdict') return box
      if (id === 'listRefresh') return refresh
      return null
    },
    createElement(tag) { return makeEl(tag) },
    addEventListener() {},
    elementFromPoint() { return rows()[0] ?? null }
  }
  const storage = new Map()
  const context = {
    document,
    navigator: {
      connection: { effectiveType: options.effectiveType ?? '4g' },
      sendBeacon(url, body) { beacons.push({ url, body: String(body) }); return true }
    },
    performance: { now: () => options.now ?? 5 },
    sessionStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null },
      setItem(key, value) { storage.set(key, String(value)) }
    },
    fetch(url) {
      fetchCalls.push(url)
      if (options.fetch === 'reject') return Promise.reject(new Error('offline'))
      return Promise.resolve({ ok: true, json: async () => (options.payload ?? JSON.parse(BOOT)) })
    },
    MutationObserver: class { observe() {} },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length },
    Promise, JSON, Math, Object, Array, String, Number, Error
  }
  context.window = context
  if (options.shape) context.__POCKET_BOOT_STATE__ = options.shape
  if (options.payload !== undefined) context.__POCKET_BOOT__ = options.payload
  vm.runInNewContext(script, context, { filename: 'first-frame.js' })
  // The boot-fallback race timer (4.5 s) is registered before the verdict timer.
  const limitTimer = timers[timers.length - 1]
  return { context, beacons, timers, limitTimer, box, refresh, docState, fetchCalls }
}

test('AC-P1 a thin document with no stash fetches /api/boot itself and settles painted', async () => {
  const html = renderMobilePage({
    locale: 'zh', boot: null, icon: null, initialChat: false, bootState: 'handoff',
    assets: { cssUrl: '/app.css?h=x', jsUrl: '/app.js?l=zh&h=x' }
  })
  const run = runVerdict(html, { shape: 'handoff', rows: 3 })
  assert.deepEqual(run.fetchCalls, ['/api/boot'], 'the thin document takes its own first fallback')
  assert.equal(run.limitTimer.ms, 5995, 'Wi-Fi limit: 6000 ms from the time origin')

  const payload = await run.context.__fB
  assert.ok(payload && payload.ws && payload.sess, 'the fallback resolves with a real boot payload')

  run.limitTimer.fn()
  assert.equal(run.beacons.length, 1)
  assert.match(run.beacons[0].body, /"tag":"first frame"/)
  assert.match(run.beacons[0].body, /rows=3 verdict=painted mode=handoff ms=5 hit=inRow/)
  assert.equal(run.box.hidden, true, 'a painted frame shows no failure face')
})

test('AC-P1b the shell prefers the fallback promise over the RPC leg', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const fallback = js.indexOf('const fb=await globalThis.__fB')
  const rpc = js.indexOf('}else{await loadListData()}')
  assert.ok(fallback > 0, 'the startup block awaits the head fallback')
  assert.ok(rpc > fallback, 'and it does so before deciding to run the RPC leg')
})

test('AC-P2 a thin document with everything offline settles failed with a visible face', async () => {
  const html = renderMobilePage({
    locale: 'zh', boot: null, icon: null, initialChat: false, bootState: 'handoff',
    assets: { cssUrl: '/app.css?h=x', jsUrl: '/app.js?l=zh&h=x' }
  })
  const run = runVerdict(html, { shape: 'handoff', rows: 0, fetch: 'reject' })
  await run.context.__fB
  run.limitTimer.fn()

  assert.match(run.beacons[0].body, /"tag":"first frame"/)
  assert.match(run.beacons[0].body, /rows=0 verdict=failed mode=handoff ms=/)
  assert.match(run.beacons[0].body, /hit=none/)
  assert.equal(run.box.hidden, false, 'the failure face must be visible')
  assert.equal(run.box.children[0].textContent, '这台手机这一趟没有连上宿主，列表拿不到。')
  assert.equal(run.box.children[1].textContent, '怎么拿新地址')
  assert.equal(run.refresh.style.display, 'none', 'cold never offers the refresh button')
})

test('AC-P3 the cold help expands to the same three lines /bye ships, and says refresh is useless', async () => {
  const html = renderMobilePage({
    locale: 'zh', boot: null, icon: null, initialChat: false, bootState: 'handoff',
    assets: { cssUrl: '/app.css?h=x', jsUrl: '/app.js?l=zh&h=x' }
  })
  const run = runVerdict(html, { shape: 'handoff', rows: 0, fetch: 'reject' })
  await run.context.__fB
  run.limitTimer.fn()

  const help = run.box.children[2]
  assert.equal(help.hidden, true, 'the three lines start collapsed')
  run.box.children[1].onclick()
  assert.equal(help.hidden, false, 'the tap expands them')
  assert.match(help.innerHTML, /刷新在这里没有用/)
  for (const line of COLD_LINES) assert.ok(help.innerHTML.includes(line), `missing cold line: ${line}`)

  // Same source as the /bye page (C1): every line the help shows is also on that page.
  const bye = renderByePage('zh')
  for (const line of COLD_LINES) assert.ok(bye.includes(line), `/bye lost the shared line: ${line}`)
})

test('AC-P4 a hot (payload-bearing) document shows no connecting copy and keeps the data retry', () => {
  const html = renderMobilePage({
    locale: 'zh', boot: BOOT, icon: null, initialChat: false, bootState: 'embedded',
    assets: { cssUrl: '/app.css?h=x', jsUrl: '/app.js?l=zh&h=x' }
  })
  // C2: the violation surface is visible text — the status slot must render empty when
  // the document already holds data, with no `connecting` class on the status dot.
  assert.match(html, /<div id="status" class="status" role="status"/)
  assert.match(html, /<span id="statusText" class="status-text" aria-hidden="true"><\/span>/)
  assert.match(html, /<button id="listRefresh"/, 'the data-level retry stays available')
  // The failure copy itself never mentions connecting: both faces are data-level.
  const script = verdictScript(html)
  assert.doesNotMatch(script, /连接/)
})
