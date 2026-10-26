// Shell boot smoke — run the ENTIRE shipped app script once in a sandbox.
//
// Why this exists (card W5 aftermath, 2026-10-24): the 50+ unit tests each lift a
// single function into a sandbox, so a fatal regression that broke the script's
// own top-level assembly — `applyContentVisibility()` was wired before `const
// CV_ON=`, a classic-script TDZ ReferenceError that killed ~51 KB of assembly —
// stayed green. This test executes the shipped bytes start to finish and checks
// that the script reached its tail. It is NOT a behaviour test: a missing DOM
// capability is this shim's fault (add to the shim), the assertion only guards
// against the script's own wiring/reference errors.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const assets = mobilePageAssets({ locale: 'zh' })

// --- minimal DOM/global shim, exactly what the script's top level touches ---
const listeners = { win: new Map(), doc: new Map() }
const track = (map) => (type, fn) => {
  if (!map.has(type)) map.set(type, [])
  map.get(type).push(fn)
}

const makeEl = (id) => ({
  id, innerHTML: '', textContent: '', hidden: false, value: '', checked: false,
  dataset: {},
  style: new Proxy(
    { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    { set: () => true, get: (t, k) => (k in t ? t[k] : '') },
  ),
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  setAttribute() {}, getAttribute: () => null, removeAttribute() {},
  addEventListener(type, fn) { track(listeners.win)(id + ':' + type, fn) },
  removeEventListener() {},
  appendChild() {}, remove() {}, focus() {}, blur() {}, scrollIntoView() {},
  querySelector: () => null, querySelectorAll: () => [],
  closest: () => null, contains: () => false, insertAdjacentHTML() {},
  getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
  setSelectionRange() {},
})

const els = new Map()
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

const winListeners = new Map()
const docListeners = new Map()
const timers = []
const schedule = (fn) => { timers.push(fn); return timers.length }

const document = {
  getElementById: $,
  createElement: (tag) => makeEl('el-' + tag),
  createTextNode: () => ({}),
  documentElement: makeEl('html'),
  body: makeEl('body'),
  head: makeEl('head'),
  addEventListener: track(docListeners),
  removeEventListener() {},
  hidden: false,
  visibilityState: 'visible',
  querySelector: () => null,
  querySelectorAll: () => [],
  activeElement: null,
  title: '',
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
const fetchStub = async (url, options) => {
  const body = { ok: true, value: { ws: { items: [] }, sess: { items: [] }, items: [] } }
  return {
    ok: true, status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => 'application/json' },
  }
}
const window = {
  addEventListener: track(winListeners),
  removeEventListener() {},
  location, navigator,
  history: { replaceState() {}, pushState() {}, back() {}, length: 2 },
  localStorage: storage(), sessionStorage: storage(),
  innerWidth: 390, innerHeight: 800,
  visualViewport: { addEventListener() {}, height: 800, offsetTop: 0 },
  requestAnimationFrame: schedule, cancelAnimationFrame() {},
  setTimeout: schedule, clearTimeout() {}, setInterval: schedule, clearInterval() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  __POCKET_BOOT__: { ws: { items: [] }, sess: { items: [] } },
  dispatchEvent: () => true,
}

test('the whole shipped shell script runs to its tail without reference errors', async () => {
  let syncError = null
  try {
    new Function(
      'document', 'window', 'location', 'navigator', 'localStorage', 'sessionStorage',
      'history', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'CSS', 'performance', 'Intl', 'matchMedia', 'getComputedStyle',
      'WebSocket', 'Event', 'CustomEvent', 'visualViewport',
      'innerWidth', 'innerHeight', 'alert', 'confirm',
      assets.js,
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
  // The boot IIFE at the tail is async; let its awaited kicks settle.
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve))

  // ① The script reached its last line: the ready flag is set at the very tail
  //    of lib/pages.js's app script (`window.__pocketAppReady=true;`).
  assert.equal(syncError, null, `the shell threw during top-level execution: ${syncError?.stack ?? ''}`)
  assert.equal(window.__pocketAppReady, true, 'the script never reached its tail ready flag')
  // ② The guard that the W5 regression actually broke: applyContentVisibility()
  //    is wired right after `const CV_ON=` — a TDZ there kills everything after
  //    it, including every listener below.
  assert.ok(docListeners.get('visibilitychange'), 'the visibilitychange listener was never registered')
  // ③ History routing reached the wiring point.
  assert.ok(winListeners.get('popstate'), 'the popstate listener was never registered')
  // ④ Interaction sheets wired their document-level closers.
  assert.ok(docListeners.get('pointerdown'), 'pointerdown listeners were never registered')
  assert.ok(docListeners.get('keydown'), 'keydown listeners were never registered')
  // ⑤ Viewport/return wiring on window.
  assert.ok(winListeners.get('resize'), 'the resize listener was never registered')
  assert.ok(winListeners.get('pagehide'), 'the pagehide listener was never registered')
})
