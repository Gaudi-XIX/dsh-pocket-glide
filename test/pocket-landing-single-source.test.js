// T4.2 N1/N2/N3 — the landing's list has exactly one source of truth.
//
// N1  stash-sourced handoff boot (sessionStorage 'dsh-pocket-glide-boot', the
//     payload the PIN card page handed off): partial=true BUT the gate must NOT
//     refill — the stash already is the list. rpc spy on workspace.list /
//     session.list / bot.team stays 0; the stash is consumed on read.
// N2  embedded source (window.__POCKET_BOOT__): partial=true refills once —
//     the suppression is stash-source-only, not a blanket kill of the refill.
// N3  cachedBoot source (sessionStorage 'dsh_pocket_boot_cache'): partial=true
//     refills too; with handoffBoot absent the gate degenerates to the old
//     unconditional form (boot!==handoffBoot is true when handoffBoot=null).
//     Static anchors pin the gate string and handoffBoot's single write site.
//
// Fixtures align with change/tests/out/boot-truth.json readings: wsItemsCount 5
// (bridge shape = 4 real + 1 '' ungrouped), emptyItemPresent true, ungrouped
// sessionTotal 8, sessPartial true, sessItemsLen 9, ungroupedIdsInTails 0,
// dsbotWsItems [] (team:[] ⇒ botStage cards=[]).
//
// design.md:27 shape conflict (registered in planning-context.md §10, verify
// judges): design says the stash现场 has ws.items WITHOUT a '' item, but the
// live probe read emptyItemPresent=true. Both shapes are covered here — the
// bridge shape ('' item present, head reads sessionTotal) and the page concat
// shape (no '' item ⇒ leftover>0 ⇒ synthetic card, head falls back to
// tasks.length, which equals leftover.length by construction) — and every
// reading is taken from the run, not from design.md.
// tails are omitted (production tailsKeysLen 4): this pins only the
// ungroupedIdsInTails=0 reading; a non-empty tailCache would add jt() timer
// legs that are not under test here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const js = mobilePageAssets({ locale: 'zh' }).js

const STASH_KEY = 'dsh-pocket-glide-boot'
const CACHE_KEY = 'dsh_pocket_boot_cache'
const GATE = 'if(bootListPartial&&boot!==handoffBoot)void fillListFromServer();'

const UNGROUPED_IDS = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8']
const mkRow = (sessionId, workspaceId) => ({ sessionId, workspaceId, updatedAt: 1 })
// 9 session rows: s1 claimed by w1, u1..u8 unclaimed (aligns sessItemsLen 9).
const sessItems = [mkRow('s1', 'w1'), ...UNGROUPED_IDS.map((id) => mkRow(id, ''))]
const realWsItems = [
  { workspaceId: 'w1', title: 'Alpha', sessionIds: ['s1'], sessionTotal: 1 },
  { workspaceId: 'w2', title: 'Beta', sessionIds: ['s2'], sessionTotal: 1 },
  { workspaceId: 'w3', title: 'Gamma', sessionIds: ['s3'], sessionTotal: 1 },
  { workspaceId: 'w4', title: 'Delta', sessionIds: ['s4'], sessionTotal: 1 },
]
// Bridge shape: the '' item is present and carries sessionTotal 8.
const bridgeWsItems = [...realWsItems, { workspaceId: '', ungrouped: true, title: '未分组', sessionIds: UNGROUPED_IDS, sessionTotal: 8 }]
// Page concat shape: no '' item; the synthetic card comes from leftover.
const concatWsItems = realWsItems

const partialBoot = (wsItems) => ({ ws: { items: wsItems }, sess: { items: sessItems, partial: true }, team: [] })

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, 'function ' + name + ' not found in asset')
  let i = src.indexOf('{', start)
  let depth = 0
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces extracting ' + name)
}

const makeSandbox = (opts = {}) => {
  const frames = []
  const rpcCalls = []
  const els = new Map()
  const makeEl = (id) => {
    const el = {
      id, textContent: '', hidden: false, value: '', checked: false, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {}, getAttribute: () => null, removeAttribute() {},
      addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
      focus() {}, blur() {}, scrollIntoView() {},
      querySelector: () => null, querySelectorAll: () => [],
      closest: () => null, contains: () => false, insertAdjacentHTML() {},
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, width: 0, height: 0 }),
      setSelectionRange() {},
      style: new Proxy(
        { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
        { set: () => true, get: (t, k) => (k in t ? t[k] : '') },
      ),
    }
    if (id === 'workspaces') {
      let html = ''
      Object.defineProperty(el, 'innerHTML', {
        get: () => html,
        set: (v) => { html = String(v); frames.push(String(v)) },
      })
    }
    return el
  }
  const $ = (id) => (typeof id === 'string' ? (els.get(id) ?? els.set(id, makeEl(id)).get(id)) : null)
  const storage = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)) },
      removeItem: (k) => m.delete(k),
      clear: () => m.clear(),
      key: (i) => [...m.keys()][i] ?? null,
      get length() { return m.size },
    }
  }
  const rpcPayloads = {
    'workspace.list': { items: opts.wsItems ?? concatWsItems },
    'session.list': { items: sessItems, partial: false },
    'bot.team': { bots: [], rooms: [], mainBotIds: [] },
  }
  const fetchStub = async (url, options) => {
    const u = String(url)
    if (u === '/api/rpc' && options && options.method === 'POST') {
      const body = JSON.parse(String(options.body))
      rpcCalls.push(body.method)
      if (opts.rpcReject) throw new Error('rpc-down')
      return { ok: true, status: 200, json: async () => ({ ok: true, value: rpcPayloads[body.method] ?? null }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }
  }
  const location = {
    search: '', hash: '', pathname: '/', href: 'http://127.0.0.1:9896/',
    origin: 'http://127.0.0.1:9896', replace() {}, assign() {}, reload() {},
  }
  const navigator = {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    platform: 'iPhone', maxTouchPoints: 5, language: 'zh-CN', onLine: true,
    serviceWorker: { register: async () => { throw new Error('no sw in sandbox') } },
    clipboard: { writeText: async () => {} },
  }
  const winListeners = new Map()
  const track = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, [])
    map.get(type).push(fn)
  }
  const timers = []
  const schedule = (fn) => { timers.push(fn); return timers.length }
  const window = {
    addEventListener: track(winListeners), removeEventListener() {},
    location, navigator,
    history: { replaceState() {}, pushState() {}, back() {}, length: 2 },
    localStorage: storage(), sessionStorage: storage(),
    innerWidth: 390, innerHeight: 800,
    visualViewport: { addEventListener() {}, height: 800, offsetTop: 0 },
    requestAnimationFrame: schedule, cancelAnimationFrame() {},
    setTimeout: schedule, clearTimeout() {}, setInterval: schedule, clearInterval() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    dispatchEvent: () => true,
  }
  if (opts.embeddedBoot) window.__POCKET_BOOT__ = opts.embeddedBoot
  if (opts.stash) window.sessionStorage.setItem(STASH_KEY, JSON.stringify(opts.stash))
  if (opts.cachedBoot) window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(opts.cachedBoot))

  const document = {
    getElementById: $,
    createElement: (tag) => makeEl('el-' + tag),
    createTextNode: () => ({}),
    documentElement: makeEl('html'), body: makeEl('body'), head: makeEl('head'),
    addEventListener: track(new Map()), removeEventListener() {},
    hidden: false, visibilityState: 'visible',
    querySelector: () => null, querySelectorAll: () => [],
    activeElement: null, title: '',
  }

  const run = async () => {
    globalThis.__fB = Promise.resolve(null) // the bridge-side handoff channel is absent here
    let syncError = null
    try {
      new Function(
        'document', 'window', 'location', 'navigator', 'localStorage', 'sessionStorage',
        'history', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame',
        'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
        'CSS', 'performance', 'Intl', 'matchMedia', 'getComputedStyle',
        'WebSocket', 'Event', 'CustomEvent', 'visualViewport',
        'innerWidth', 'innerHeight', 'alert', 'confirm',
        js,
      )(
        document, window, location, navigator, window.localStorage, window.sessionStorage,
        window.history, fetchStub, window.requestAnimationFrame, window.cancelAnimationFrame,
        window.setTimeout, window.clearTimeout, window.setInterval, window.clearInterval,
        { supports: () => false }, { now: () => 1000, timeOrigin: 0 }, Intl,
        window.matchMedia, window.getComputedStyle,
        function WS() { this.close = () => {}; this.addEventListener = () => {}; this.send = () => {} },
        class E {}, class E {}, window.visualViewport,
        390, 800, () => {}, () => false,
      )
    } catch (error) {
      syncError = error
    }
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
    return { syncError }
  }
  const count = (method) => rpcCalls.filter((m) => m === method).length
  const ungroupedCard = (html) => {
    const m = String(html).match(/<article class="ws-card" data-ws="">([\s\S]*?)<\/article>/)
    return m ? m[0] : ''
  }
  const headCount = (card) => {
    const m = String(card).match(/<span class="ws-last-time">(\d+)<\/span>/)
    return m ? m[1] : null
  }
  return { window, run, count, frames, ungroupedCard, headCount, rpcCalls, fetchStub }
}

let unhandled = 0
process.on('unhandledRejection', () => { unhandled += 1 })

test('N1 stash-sourced handoff boot: partial=true yet zero rpc, both payload shapes', async () => {
  for (const [shapeName, wsItems] of [['bridge', bridgeWsItems], ['concat', concatWsItems]]) {
    const sb = makeSandbox({ stash: partialBoot(wsItems) })
    const { syncError } = await sb.run()
    assert.equal(syncError, null, shapeName + ' shape threw during boot')
    assert.equal(sb.window.__pocketAppReady, true, shapeName + ' shape never reached the tail ready flag')
    // The refill gate is suppressed for the stash source (the r2 fix).
    assert.equal(sb.count('workspace.list'), 0, shapeName + ' shape: workspace.list refilled')
    assert.equal(sb.count('session.list'), 0, shapeName + ' shape: session.list refilled')
    assert.equal(sb.count('bot.team'), 0, shapeName + ' shape: bot.team refilled')
    // The stash is consumed on read — a later reload fetches its own payload.
    assert.equal(sb.window.sessionStorage.getItem(STASH_KEY), null, shapeName + ' shape: stash not consumed')
    // The ungrouped card painted collapsed with head count 8 in BOTH shapes.
    const card = sb.ungroupedCard(sb.frames[0] ?? '')
    assert.notEqual(card, '', shapeName + ' shape: no ungrouped card painted')
    assert.equal((sb.frames[0] ?? '').split('data-ws=""').length - 1, 1, shapeName + ' shape: data-ws="" not unique')
    assert.equal(sb.headCount(card), '8', shapeName + ' shape: ungrouped head count is not 8')
    assert.ok(/aria-expanded="false"/.test(card), shapeName + ' shape: ungrouped card not collapsed on first frame')
    assert.equal((card.match(/<button class="task-row/g) || []).length, 0, shapeName + ' shape: collapsed card painted rows')
    // First frame IS the stable frame: the repaint guard suppressed every later
    // identical write, so the head value never moved.
    assert.equal(sb.frames.length, 1, shapeName + ' shape: first frame != stable frame')
    assert.equal(sb.headCount(sb.ungroupedCard(sb.frames[sb.frames.length - 1])), '8', shapeName + ' shape: stable frame head moved')
  }
  // The concat-shape identity: tasks.length == leftover.length by construction,
  // so the head fallback reads the same 8 the bridge shape ships in sessionTotal.
  const claimed = new Set(concatWsItems.flatMap((w) => w.sessionIds))
  const leftover = sessItems.map((r) => r.sessionId).filter((id) => !claimed.has(id))
  assert.equal(leftover.length, 8, 'concat fixture: leftover is not 8')
})

test('N2 embedded source: partial=true refills exactly once', async () => {
  const sb = makeSandbox({ embeddedBoot: partialBoot(bridgeWsItems) })
  const { syncError } = await sb.run()
  assert.equal(syncError, null)
  assert.equal(sb.window.__pocketAppReady, true)
  assert.ok(sb.count('workspace.list') >= 1, 'embedded partial boot was suppressed')
  assert.ok(sb.count('session.list') >= 1, 'embedded partial boot was suppressed')
  assert.ok(sb.count('bot.team') >= 1, 'embedded partial boot was suppressed')
  assert.equal(sb.count('workspace.list'), 1, 'workspace.list refilled more than once')
  assert.equal(sb.count('session.list'), 1, 'session.list refilled more than once')
  assert.equal(sb.count('bot.team'), 1, 'bot.team refilled more than once')
  // The refill answer is non-partial and carries the same rows: the list is
  // stable after the refill, and the stash channel was never seeded.
  assert.equal(sb.window.sessionStorage.getItem(STASH_KEY), null)
  assert.equal(sb.headCount(sb.ungroupedCard(sb.frames[sb.frames.length - 1])), '8')
})

test('N3 cachedBoot source: partial=true refills; gate degenerates with handoffBoot absent', async () => {
  const sb = makeSandbox({ cachedBoot: partialBoot(bridgeWsItems) })
  const { syncError } = await sb.run()
  assert.equal(syncError, null)
  assert.equal(sb.window.__pocketAppReady, true)
  assert.ok(sb.count('workspace.list') >= 1, 'cachedBoot partial boot was suppressed')
  assert.ok(sb.count('session.list') >= 1, 'cachedBoot partial boot was suppressed')
  assert.ok(sb.count('bot.team') >= 1, 'cachedBoot partial boot was suppressed')
  assert.equal(sb.headCount(sb.ungroupedCard(sb.frames[sb.frames.length - 1])), '8')
  // Static anchors (shipped asset, field-name/property discrimination only):
  // the gate form is exactly the r2 form, the old form is gone, and
  // handoffBoot has exactly two write sites — the null init and the single
  // assignment inside takeHandoffBoot — so with an empty stash the gate's
  // boot!==handoffBoot is boot!==null, i.e. the old unconditional behaviour.
  assert.equal(js.split(GATE).length - 1, 1, 'gate string is not unique in the asset')
  assert.equal(js.split('if(bootListPartial)void fillListFromServer();').length - 1, 0, 'old gate form still present')
  const takeSrc = extractFunction(js, 'takeHandoffBoot')
  assert.ok(takeSrc.includes('handoffBoot=parsed'), 'takeHandoffBoot no longer writes handoffBoot')
  assert.equal(js.split('handoffBoot=parsed').length - 1, 1, 'handoffBoot has a second write site')
  assert.equal(js.split('let handoffBoot=null').length - 1, 1, 'handoffBoot declaration moved')
})

test('N-negative: rpc-down refill failure is swallowed, first frame survives, no unhandled rejection', async () => {
  const before = unhandled
  const sb = makeSandbox({ embeddedBoot: partialBoot(bridgeWsItems), rpcReject: true })
  const { syncError } = await sb.run()
  assert.equal(syncError, null)
  assert.equal(sb.window.__pocketAppReady, true)
  // assert.rejects (not assert.throws): the rejection is async, and this probe
  // also proves the stub is configured to reject before the negative case runs.
  await assert.rejects(sb.fetchStub('/api/rpc', { method: 'POST', body: '{}' }), /rpc-down/)
  assert.notEqual(sb.ungroupedCard(sb.frames[0] ?? ''), '', 'first frame lost on rpc failure')
  assert.equal(sb.headCount(sb.ungroupedCard(sb.frames[0])), '8')
  assert.equal(unhandled, before, 'an unhandled rejection escaped the boot IIFE')
})
