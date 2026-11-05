// App-shell cache must be able to paint the list on its own (change
// 2026-11-05-bugfix-pocket-reentry-shell-cache-deadlock, J3 option ①).
//
// The live failure: closing the PWA clears sessionStorage, and the NEXT open was
// answered from a cached shell that carried only the seven-number stageSummary —
// no workspace or session rows at all. The page therefore had no `ws`/`sess`, fell
// into `await loadListData()`, and that is the five-leg path that did not deliver
// under the tunnel. The fix is that the document the worker caches ships the same
// rows the landing paints (still without the tails bundle), so `takeHandoffBoot`
// finds a real payload and the first frame is the list.
//
// Proven in two halves, because neither half alone is the contract:
//   1. the REAL bridge really answers `/?revalidate=1` with rows in the document
//      (and still with neither tails nor the embedded payload's bytes);
//   2. the REAL service worker script really puts that document into `/__shell__`,
//      so the next cold open reads rows out of the cache.
// House pattern as in pages-scroll-anchors: the worker runs for real through
// `new Function` against a stubbed Cache/fetch world — no browser needed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderServiceWorker } from '../lib/pages.js'
import { startBridge, httpFetch } from './helpers.js'

const ROSTER_MAIN = { id: 'b-main', name: '主 Bot' }
const ROSTER_OTHERS = [{ id: 'b2', name: '副 Bot' }]
const ROSTER_ROOMS = [{ id: 'r1', name: '群一' }]
const ROSTER_SESSIONS = ['s-main', 's-other-1', 's-room-1']
const ROSTER_ROWS = ROSTER_SESSIONS.map((sessionId) => ({ sessionId, updatedAt: Date.now() - 60_000 }))
const ROSTER_VALUE = {
  workspaceId: 'w-bot',
  mainBotIds: [ROSTER_MAIN.id],
  bots: [ROSTER_MAIN, ...ROSTER_OTHERS],
  rooms: ROSTER_ROOMS,
}

function embeddedBoot(html) {
  const match = html.match(/window\.__POCKET_BOOT__=([\s\S]*?)<\/script>/)
  return match ? JSON.parse(match[1]) : null
}

/** 真桥：假 harness 供会话行 + roster state，快照给工作区卡。 */
async function readyBridge() {
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/list' ? { ok: true, value: { items: ROSTER_ROWS } } : undefined,
      botRespond: (endpoint) => (endpoint === 'state' ? { ok: true, value: ROSTER_VALUE } : undefined),
    },
  })
  t.bridge.workspaceSnapshot = {
    items: [{ workspaceId: 'w-mine', name: 'Mine', paths: [], sessionIds: ROSTER_SESSIONS }],
    pinnedSessionIds: [],
  }
  const cookie = await t.pairMobile()
  // 走一趟普通文档：`_sessionListValue` / `_landingMessages` 是那一趟落进缓存的 held 值。
  await httpFetch(t.base + '/', { headers: { cookie } })
  t.bridge._botTeamValue = undefined
  t.bridge.botWorkspaceCache = undefined
  t.bridge.botRosterFlight = null
  return { t, cookie }
}

test('J3 the revalidated shell ships the rows the landing paints, and no tails', async () => {
  const { t, cookie } = await readyBridge()
  try {
    const shellRes = await httpFetch(t.base + '/?revalidate=1', { headers: { cookie } })
    assert.equal(shellRes.status, 200)
    assert.equal(shellRes.headers.get('x-pocket-cache'), 'app', '壳仍是 app-shell 候选')
    const shell = await shellRes.text()
    const boot = embeddedBoot(shell)
    assert.ok(boot, '七数门全绿 ⇒ 文档里必须有 boot')
    // 这两格就是「首帧能不能画出列表」的全部条件（pages.js:3654 handoff 判据）。
    assert.equal(typeof boot.ws, 'object', '工作区行集随壳下发')
    assert.equal(typeof boot.sess, 'object', '会话行集随壳下发')
    assert.ok(Array.isArray(boot.sess.items), 'sess.items 是页面直接铺的行数组')
    assert.ok(boot.sess.items.length > 0, '行集非空——空数组等于没修')
    assert.equal('tails' in boot, false, '尾巴包仍不随壳下发（体积与卡顿的那道门）')
    assert.equal(typeof boot.stageSummary, 'object', '七键摘要仍在，加载卡不改形状')
    assert.equal(boot.stageSummary.ready, true)

    // 体积：壳必须远小于 embedded 全量（288 KB 那趟），否则 J2「重进不该更慢」失守。
    const embedded = await (await httpFetch(t.base + '/', { headers: { cookie } })).text()
    assert.ok(embedded.length > shell.length, '全量文档比壳大')
    assert.ok(shell.length < 120_000, `壳 ${shell.length} B 必须留在小档，远小于 ${embedded.length} B`)
  } finally {
    await t.stop()
  }
})

test('J3 every document marked x-pocket-cache: app carries rows (no payload-less shell)', async () => {
  const { t, cookie } = await readyBridge()
  try {
    for (const path of ['/', '/?revalidate=1']) {
      const res = await httpFetch(t.base + path, { headers: { cookie } })
      if (res.headers.get('x-pocket-cache') !== 'app') continue
      const boot = embeddedBoot(await res.text())
      assert.ok(boot, `${path}: 带缓存标记就必须有 boot`)
      assert.equal(typeof boot.ws, 'object', `${path}: 带标记的文档不许缺 ws`)
      assert.equal(typeof boot.sess, 'object', `${path}: 带标记的文档不许缺 sess`)
    }
  } finally {
    await t.stop()
  }
})

// --- the worker really stores it -------------------------------------------

function swHarness({ respond } = {}) {
  const listeners = {}
  const store = new Map()
  const cachesStub = {
    async open(name) {
      let bucket = store.get(name)
      if (!bucket) { bucket = new Map(); store.set(name, bucket) }
      return {
        async put(key, res) { bucket.set(String(key), res) },
        async match(key) { return bucket.get(String(key)) },
      }
    },
    async keys() { return [...store.keys()] },
    async delete(name) { return store.delete(name) },
  }
  const selfStub = {
    location: { origin: 'https://pocket.test' },
    addEventListener: (type, fn) => { listeners[type] = fn },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  }
  const fetchStub = async (input) => respond(String(input))
  new Function('self', 'caches', 'Response', 'fetch', 'URL', 'setTimeout', renderServiceWorker())(
    selfStub, cachesStub, Response, fetchStub, URL, (fn, ms) => ms,
  )
  let answered = null
  const dispatch = async (request) => {
    answered = null
    const waitings = []
    await listeners.fetch({
      request,
      respondWith: (p) => { answered = p },
      waitUntil: (p) => { waitings.push(Promise.resolve(p).catch(() => {})) },
    })
    await Promise.all(waitings)
    return answered ? await answered : undefined
  }
  return { install: async () => { await listeners.install({ waitUntil: (p) => p }) }, dispatch, store }
}

test('J3 the worker writes that shell into /__shell__, so a cold open reads rows from cache', async () => {
  const html = '<html><script>window.__POCKET_BOOT__={"ws":{"items":[]},"sess":{"items":[{"sessionId":"s1"}]}}</script></html>'
  const sw = swHarness({
    respond: () => new Response(html, { status: 200, headers: { 'x-pocket-cache': 'app', 'content-type': 'text/html' } }),
  })
  await sw.install()
  const first = await sw.dispatch({ method: 'GET', mode: 'navigate', url: 'https://pocket.test/' })
  assert.equal(await first.text(), html, '网络活着时给出这一份')
  const bucket = sw.store.get('pocket-v3')
  // The worker keys the shell by the bare path constant it ships (`/__shell__`),
  // not by an absolute URL — that is the same key `cache.match(SHELL)` reads.
  const stored = bucket && bucket.get('/__shell__')
  assert.ok(stored, '带 x-pocket-cache: app 的文档被写进 /__shell__')
  assert.match(await stored.text(), /"sess":\{"items":\[\{"sessionId"/, '缓存里的正文带行集，关掉重进能画')
})
