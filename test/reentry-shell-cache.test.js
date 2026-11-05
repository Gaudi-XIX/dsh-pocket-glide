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
import { renderServiceWorker, botStage } from '../lib/pages.js'
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
    assert.ok(shell.length <= 65_536, `壳 ${shell.length} B 必须落在 64 KB 档（K2），远小于 ${embedded.length} B`)
    // K5：行集的三个数只有一个来源（`paintRows`），壳自己就得自证这一点。
    assert.equal(boot.sess.items.length, boot.stageSummary.sessions, 'sess.items 与摘要的 sessions 必须同数')
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

// --- the shipped rows are the painted rows, one source ----------------------

test('K5 the shell ships exactly the rows its cards paint — no id twice, no id missing', async () => {
  const { t, cookie } = await readyBridge()
  try {
    const boot = embeddedBoot(await (await httpFetch(t.base + '/?revalidate=1', { headers: { cookie } })).text())
    const ids = boot.sess.items.map((row) => row.sessionId)
    assert.equal(new Set(ids).size, ids.length, 'sess.items 里一个 id 只出现一次')
    assert.equal(ids.length, boot.stageSummary.sessions, 'sess.items.length === stageSummary.sessions')

    const wsIds = boot.ws.items.flatMap((item) => item.sessionIds || [])
    for (const item of boot.ws.items) {
      assert.ok(Array.isArray(item.sessionIds), `${item.workspaceId}: 卡片带 sessionIds`)
      assert.ok(item.sessionIds.length <= item.sessionTotal, `${item.workspaceId}: 留着的 id 不超过原成员数`)
      assert.ok(item.sessionIds.every((id) => ids.includes(id)), `${item.workspaceId}: 卡上的 id 必须都在行集里`)
    }
    // BOT 三区的 id 由 `team` 推出来（页面用同一个 `botStage`），工作区卡不许再列一遍。
    const botIds = botStage(boot.team, [], { mainBot: '', otherBots: '', rooms: '' })
      .flatMap((card) => card.sessionIds || [])
    const overlap = botIds.filter((id) => wsIds.includes(id))
    assert.deepEqual(overlap, [], `BOT 会话只在 BOT 卡里出现一次：${overlap.join(', ')}`)
    const ungrouped = ids.filter((id) => !wsIds.includes(id) && !botIds.includes(id))
    assert.equal(wsIds.length + botIds.length + ungrouped.length, ids.length,
      '每张卡画的行数 + 未分组 = 行集总数（卡片数字与画出来的行同源）')
    assert.ok(ungrouped.length <= ids.length, '未分组只是行集里的一桶，不会另生行')
  } finally {
    await t.stop()
  }
})

// --- the worker really stores it -------------------------------------------

function swHarness({ respond, fireTimers = false } = {}) {
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
  // `fireTimers` 让 SHELL_WAIT_MS 那道闸真的落下（默认只记录、不触发）：只有让它落下来，
  // 才能测「导航等了 10s 放弃之后，晚到的答案还写不写缓存」这件事。
  const setTimeoutStub = fireTimers
    ? (fn, ms) => { queueMicrotask(() => { try { fn() } catch {} }); return ms }
    : (fn, ms) => ms
  new Function('self', 'caches', 'Response', 'fetch', 'URL', 'setTimeout', renderServiceWorker())(
    selfStub, cachesStub, Response, fetchStub, URL, setTimeoutStub,
  )
  let answered = null
  const dispatch = async (request, { wait = true } = {}) => {
    answered = null
    const waitings = []
    await listeners.fetch({
      request,
      respondWith: (p) => { answered = p },
      waitUntil: (p) => { waitings.push(Promise.resolve(p).catch(() => {})) },
    })
    if (wait) await Promise.all(waitings)
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

// --- 缓存优先 / 写缓存解耦 / 空壳不是壳（K1 K3 K4）-------------------------

const nav = () => ({ method: 'GET', mode: 'navigate', url: 'https://pocket.test/' })
const rowShell = (id = 's1') =>
  `<html><script>window.__POCKET_BOOT__={"ws":{"items":[]},"sess":{"items":[{"sessionId":"${id}"}]}}</script></html>`

test('K1 a stored row shell answers the re-entry without waiting on the network', async () => {
  const html = rowShell()
  const sw = swHarness({ respond: () => new Promise(() => {}) })
  sw.store.set('pocket-v3', new Map([
    ['/__shell__', new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })],
  ]))
  await sw.install()
  // `wait: false` 是这一条的全部：waitUntil 里那次复验永远不会回来，而导航已经拿到答案。
  const answer = await Promise.race([
    sw.dispatch(nav(), { wait: false }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('the navigation waited on the network')), 500)),
  ])
  assert.equal(await answer.text(), html, '缓存里的行集就是答案，不等这一次网络')
})

test('K3 an answer that arrives after the navigation gave up still lands in the cache', async () => {
  const html = rowShell('s-late')
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const sw = swHarness({
    fireTimers: true,
    respond: () => gate.then(() => new Response(html, {
      status: 200, headers: { 'x-pocket-cache': 'app', 'content-type': 'text/html' },
    })),
  })
  await sw.install()
  const first = await sw.dispatch(nav())
  assert.match(await first.text(), /网络不可用/, '10 秒闸落下来 ⇒ 这一趟退到离线页')
  assert.equal(sw.store.get('pocket-v3').has('/__shell__'), false, '闸落下时缓存里还没有壳')

  release()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const stored = sw.store.get('pocket-v3').get('/__shell__')
  assert.ok(stored, '晚到的答案照样写盘：写缓存与导航等不等解耦（三连重进靠它收敛）')
  assert.match(await stored.text(), /s-late/)
})

test('K4 an empty shell already in the cache is not a document: refetch, then the offline page', async () => {
  // 2026-11-05 那次死锁留下的正是这种壳：只有七键摘要，一行都画不出来。
  const empty = '<html><script>window.__POCKET_BOOT__={"stageSummary":{"ready":true,"sessions":20}}</script></html>'
  const sw = swHarness({ respond: () => { throw new TypeError('network down') } })
  sw.store.set('pocket-v3', new Map([
    ['/__shell__', new Response(empty, { status: 200, headers: { 'content-type': 'text/html' } })],
  ]))
  await sw.install()
  const body = await (await sw.dispatch(nav())).text()
  assert.match(body, /网络不可用/, '空壳不算壳：现取失败就退离线页，不拿空壳顶替')
  assert.doesNotMatch(body, /"stageSummary"/, '画不出列表的空壳不会被当成答案交出去')
})

test('K2 a heavy row set is cut to the shell budget and the three numbers still agree', async () => {
  const bigRows = []
  for (let i = 0; i < 60; i += 1) {
    bigRows.push({
      sessionId: `h-${String(i).padStart(2, '0')}`,
      updatedAt: Date.now() - 60_000,
      projections: {
        values: {
          title: `重行 ${i}`,
          // 每条 ~1.6 KB：60 条远超 45 000，逼出 fitShellBudget 的裁行分支。
          todos: Array.from({ length: 8 }, () => ({ text: 'x'.repeat(200), status: 'open' })),
        },
      },
    })
  }
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/list' ? { ok: true, value: { items: bigRows } } : undefined,
      // 七数门要求 bots/botSessions/rooms 都是数字：没有 roster 时壳根本不会带 boot，
      // 那样这条用例测的就不是预算护栏了（K4 已经单独钉住「空壳不算壳」）。
      botRespond: (endpoint) => (endpoint === 'state' ? { ok: true, value: ROSTER_VALUE } : undefined),
    },
  })
  try {
    t.bridge.workspaceSnapshot = {
      items: [{ workspaceId: 'w-a', name: 'A', paths: [], sessionIds: bigRows.map((row) => row.sessionId) }],
      pinnedSessionIds: [],
    }
    const cookie = await t.pairMobile()
    await httpFetch(t.base + '/', { headers: { cookie } })
    const shell = await (await httpFetch(t.base + '/?revalidate=1', { headers: { cookie } })).text()
    const boot = embeddedBoot(shell)
    assert.ok(boot, `重行集文档里没有 boot：${shell.slice(0, 300)}`)
    const bootBytes = Buffer.byteLength(JSON.stringify(boot))
    assert.ok(shell.length <= 65_536, `壳 ${shell.length} B 必须 ≤ 65 536`)
    assert.ok(bootBytes <= 45_000, `boot ${bootBytes} B 必须 ≤ 45 000（壳自己的那半预算）`)
    assert.equal(boot.sess.items.length, boot.stageSummary.sessions, '裁行之后 sess.items 与摘要仍同数')
    assert.ok(boot.sess.items.length < bigRows.length, '重行集确实被护栏裁过（否则这条用例没测到护栏）')
    assert.ok(boot.ws.items.every((item) => item.sessionIds.length <= boot.sess.items.length), '卡上的 id 随被裁的行一起缩')
  } finally {
    await t.stop()
  }
})
