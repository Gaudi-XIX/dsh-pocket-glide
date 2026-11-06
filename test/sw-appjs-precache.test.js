// The service worker must precache /app.js and /app.css at install time and
// answer their fetches from that cache (ignoreSearch), so a cold phone paints
// the first frame even when the tunnel is gone. The bridge keeps serving the
// assets itself with a `cache=net` asset log line — a SW hit never reaches it.
//
// T5.2 coverage note (honest downgrade): the first-frame boot-error block is
// asserted on its TEXT structure (tag=bootErr plus the src=/msg=/ready= fields,
// and its position before the first external <script src=>), then executed in a
// `new Function` sandbox that fires `window.onerror` / `__pocketBootErr` and
// checks the sendBeacon payload. NOT covered: a real browser error event
// bubbling through capture phase (needs a DOM) — that stays a live-device
// walkthrough item, not a unit test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMobilePage, renderServiceWorker } from '../lib/pages.js'

const boot = JSON.stringify({ ws: { items: [] }, sess: { items: [] } })
const sw = renderServiceWorker('pocket-test')
const splitPage = renderMobilePage({
  locale: 'zh',
  boot,
  icon: null,
  initialChat: true,
  assets: { cssUrl: '/app.css?h=deadbeef', jsUrl: '/app.js?l=zh&h=deadbeef' },
})

// The worker calls cache.put/match with both Request objects and bare paths
// (the offline page and the shell key are strings), so accept either.
const pathOf = (req) => (typeof req === 'string' ? req : new URL(req.url).pathname)

function makeEnv({ fetchImpl }) {
  const handlers = {}
  let cache = null
  const caches = { open: async () => cache }
  const self = {
    addEventListener: (t, h) => { handlers[t] = h },
    location: { origin: 'https://x' },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  }
  const netFetches = []
  const fetch = (...args) => { netFetches.push(args[0]); return fetchImpl(...args) }
  new Function('self', 'caches', 'fetch', 'Response', 'URL', 'performance', 'console', sw)(
    self, caches, fetch, Response, URL, { now: () => 0 }, console)

  const store = new Map()
  const calls = { put: [], match: [] }
  cache = {
    store,
    calls,
    async put(req, res) {
      const p = pathOf(req)
      store.set(p, res)
      calls.put.push(p)
    },
    async match(req, opts = {}) {
      const p = pathOf(req)
      calls.match.push({ pathname: p, opts })
      return store.get(p)
    },
  }

  return {
    handlers,
    netFetches,
    cache: () => cache,
    async install() {
      const pending = []
      handlers.install({ waitUntil: (p) => pending.push(Promise.resolve(p)) })
      await Promise.all(pending)
    },
    async dispatch(request) {
      let answered
      const promises = []
      handlers.fetch({
        request,
        waitUntil: (p) => promises.push(Promise.resolve(p)),
        respondWith: (p) => { answered = Promise.resolve(p) },
      })
      await Promise.all(promises)
      const res = await answered
      // cache.put is fired without await on the miss path; let it land.
      await new Promise((r) => setImmediate(r))
      return res
    },
  }
}

test('T5.1 the worker text precaches both assets and marks the asset path', () => {
  const install = sw.match(/addEventListener\('install'[\s\S]*?skipWaiting/)[0]
  assert.match(install, /APP_JS/, 'install iterates the app script')
  assert.match(install, /APP_CSS/, 'install iterates the stylesheet')
  assert.match(sw, /ignoreSearch:true/, 'asset fetches match ignoring the hash query')
  assert.match(sw, /ignoreVary:true/, 'the match ignores Vary so a stored plain copy answers a compressed-negotiated request')
  assert.match(sw, /tag:'asset'/, 'a cache hit reports itself via /__diag')
  assert.match(sw, /cache=sw/, 'the SW-hit marker exists in the worker')
})

test('T5.1 install writes /app.js and /app.css into the cache', async () => {
  const env = makeEnv({ fetchImpl: async () => new Response('body', { status: 200 }) })
  await env.install()
  const puts = env.cache().calls.put
  assert.ok(puts.includes('/app.js'), `expected /app.js in ${puts.join(',')}`)
  assert.ok(puts.includes('/app.css'), `expected /app.css in ${puts.join(',')}`)
  assert.ok(puts.includes('/__offline__'), 'the offline page is still precached')
})

test('T5.1 one asset failing to fetch does not reject the install', async () => {
  const env = makeEnv({
    fetchImpl: async (url) => {
      if (String(url).includes('/app.css')) throw new Error('tunnel down')
      return new Response('js', { status: 200 })
    },
  })
  await env.install() // must resolve
  const puts = env.cache().calls.put
  assert.ok(puts.includes('/app.js'), 'the healthy asset is still cached')
  assert.ok(!puts.includes('/app.css'), 'the failed asset is not cached')
})

test('T5.1 a cache hit answers /app.js without touching the network', async () => {
  const env = makeEnv({ fetchImpl: async () => new Response('cached-js', { status: 200 }) })
  await env.install()
  env.cache().calls.match.length = 0
  env.netFetches.length = 0
  const res = await env.dispatch(new Request('https://x/app.js?l=zh&h=deadbeef&fresh=123'))
  const [call] = env.cache().calls.match
  assert.deepEqual(call.opts, { ignoreSearch: true, ignoreVary: true }, 'the match must ignore the query and the stored copy\'s Vary header')
  assert.equal(call.pathname, '/app.js')
  assert.equal(await res.text(), 'cached-js', 'the cached copy is returned')
  assert.ok(!env.netFetches.some((u) => String(u).includes('/app.js')), 'no network fetch for the asset')
})

test('T5.1 a miss goes to the network and stores the ok response', async () => {
  const env = makeEnv({ fetchImpl: async () => new Response('fresh-js', { status: 200 }) })
  const res = await env.dispatch(new Request('https://x/app.js?l=zh&h=fff'))
  assert.equal(await res.text(), 'fresh-js')
  assert.ok(env.cache().calls.put.includes('/app.js'), 'the fetched asset is stored for next time')
})

test('T5.1 a non-GET request falls through to the network untouched', async () => {
  const env = makeEnv({ fetchImpl: async () => new Response('x', { status: 200 }) })
  let responded = false
  const promises = []
  env.handlers.fetch({
    request: new Request('https://x/__diag', { method: 'POST', body: '{}' }),
    waitUntil: (p) => promises.push(Promise.resolve(p)),
    respondWith: () => { responded = true },
  })
  await Promise.all(promises)
  assert.equal(responded, false, 'the worker does not answer a POST /__diag itself')
  assert.equal(env.cache().calls.put.length, 0, 'and stores nothing for it')
})

test('T5.2 the head installs the boot-error reporter before the external script', () => {
  assert.match(splitPage, /tag:'bootErr'/)
  assert.match(splitPage, /src='\+src\+' msg='\+msg\+' ready='\+document\.readyState/,
    'the detail carries src, msg and ready')
  const reporter = splitPage.indexOf("tag:'bootErr'")
  const firstExternal = splitPage.indexOf('<script src=')
  assert.ok(firstExternal > 0, 'the split page references the external app script')
  assert.ok(reporter >= 0 && reporter < firstExternal, 'the reporter is installed before app.js loads')
})

test('T5.2 __pocketBootErr reports through sendBeacon (sandboxed)', () => {
  const body = splitPage.match(/<script[^>]*>(\(function\(\)\{\s*var report=[\s\S]*?\}\)\(\);)<\/script>/)[1]
  const beacons = []
  const win = { addEventListener: () => {} }
  const navigator = { sendBeacon: (url, data) => { beacons.push({ url, data }); return true } }
  const document = { readyState: 'loading' }
  const report = new Function('window', 'navigator', 'document', `${body};return window.__pocketBootErr`)(win, navigator, document)

  report({ target: { src: '/app.js?l=zh&h=deadbeef' }, type: 'error' })
  const [call] = beacons
  assert.equal(call.url, '/__diag')
  const payload = JSON.parse(call.data)
  assert.equal(payload.tag, 'bootErr')
  assert.match(payload.detail, /src=\/app\.js\?l=zh&h=deadbeef/)
  assert.match(payload.detail, /msg=error/)
  assert.match(payload.detail, /ready=loading/)
})

test('T5.3 the bridge logs the asset line with cache=net on a network hit', async () => {
  const { startBridge, httpFetch } = await import('./helpers.js')
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(`${t.base}/app.js?l=zh&h=x`, { headers: { cookie } })
    assert.equal(res.status, 200)
    const messages = t.logs.map((l) => l.message)
    const line = messages.find((m) => m.startsWith('asset /app.js'))
    assert.ok(line, `expected an asset log line, saw: ${JSON.stringify(messages.slice(-5))}`)
    assert.match(line, /asset \/app\.js bytes=\d+ ms=\d+ h=x enc=\S+ cache=net/)
  } finally {
    await t.stop()
  }
})