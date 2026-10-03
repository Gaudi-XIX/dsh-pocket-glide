// The mobile shell splits into a ~4 KB document plus the CSS and the app script,
// which the phone can then keep. The assets must be byte-identical to the blocks
// that used to travel inline, and the document must carry a bootstrap that
// notices a mangled cached copy (the phone turned a cached document into
// unreadable text once already).
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMobilePage, mobilePageAssets, renderServiceWorker } from '../lib/pages.js'
import { startBridge, httpFetch } from './helpers.js'

const boot = JSON.stringify({ ws: { items: [] }, sess: { items: [] } })
const readBody = async (res) => await new Response(res.body).text()
const inline = renderMobilePage({ locale: 'zh', boot, icon: null, initialChat: true })
const assets = mobilePageAssets({ locale: 'zh' })
const split = renderMobilePage({
  locale: 'zh',
  boot,
  icon: null,
  initialChat: true,
  assets: { cssUrl: '/app.css?h=deadbeef', jsUrl: '/app.js?l=zh&h=deadbeef' }
})

test('the assets are exactly the blocks that used to be inline', () => {
  const css = inline.match(/<style>([\s\S]*?)<\/style>/)[1]
  const scripts = [...inline.matchAll(/<script>([\s\S]*?)<\/script>/g)]

  assert.equal(assets.css, css)
  assert.equal(assets.js, scripts[scripts.length - 1][1])
  assert.match(assets.js, /window\.__pocketAppReady=true;?\s*$/, 'the script must announce that it parsed')
})

test('the split document is small and keeps the per-open data inline', () => {
  assert(split.length * 10 < inline.length, `expected a far smaller document, got ${split.length} vs ${inline.length}`)
  assert.match(split, /<link rel="stylesheet" href="\/app\.css\?h=deadbeef">/)
  assert.match(split, /<script src="\/app\.js\?l=zh&h=deadbeef"><\/script>/)
  assert.doesNotMatch(split, /<style>/)
  assert.match(split, /window\.__POCKET_BOOT__=/, 'the boot payload still travels with the document')
  assert.match(split, /__pocketAppReady!==true/, 'the bootstrap must check the script really ran')
  assert.match(split, /--brand/, 'the bootstrap must check the stylesheet really applied')
  assert.match(split, /&fresh=/, 'a bad copy must be refetched with a cache-busting query')
})

test('without assets the document stays self-contained, as before', () => {
  assert.match(inline, /<style>/)
  assert.match(inline, /window\.__pocketAppReady=true;?\s*<\/script>/)
  assert.doesNotMatch(inline, /app\.js\?/)
})

test('the bridge serves the shell assets with a long private lifetime', async () => {
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile()

    const css = await httpFetch(`${t.base}/app.css?h=x`, { headers: { cookie } })
    assert.equal(css.status, 200)
    assert.match(css.headers.get('content-type') ?? '', /text\/css/)
    assert.match(css.headers.get('cache-control') ?? '', /private, max-age=\d+/)
    assert.match(await readBody(css), /\.composer/)

    const js = await httpFetch(`${t.base}/app.js?l=zh&h=x`, { headers: { cookie } })
    assert.equal(js.status, 200)
    assert.match(js.headers.get('content-type') ?? '', /javascript/)
    assert.match(await readBody(js), /__pocketAppReady/)

    // The document points at the hashed URLs of those two assets.
    const page = await httpFetch(`${t.base}/`, { headers: { cookie } })
    assert.equal(page.status, 200)
    const pageBody = await readBody(page)
    assert.match(pageBody, /<link rel="stylesheet" href="\/app\.css\?h=[0-9a-f]{12}">/)
    assert.match(pageBody, /<script src="\/app\.js\?l=zh&h=[0-9a-f]{12}"><\/script>/)
    assert(pageBody.length < 60000, `the phone document should be small, saw ${pageBody.length}`)

    // The page references its own assets, so the policy must allow them: a CSP
    // without 'self' on these directives renders bare, inert markup on a phone
    // (observed live 2026-10-01, right after the split).
    const csp = page.headers.get('content-security-policy') ?? ''
    assert.match(csp, /style-src[^;]*'self'/, 'style-src must allow the hashed stylesheet')
    assert.match(csp, /script-src[^;]*'self'/, 'script-src must allow the hashed script')

    // The handoff prefetches exactly these URLs, so the document must reference
    // them and nothing else — a mismatch means the phone re-downloads the shell
    // after the last step instead of painting at once.
    const urls = t.bridge.mobileAssetBodies('zh').urls
    assert(pageBody.includes(`<link rel="stylesheet" href="${urls.cssUrl}">`), `document must reference ${urls.cssUrl}`)
    assert(pageBody.includes(`<script src="${urls.jsUrl}"></script>`), `document must reference ${urls.jsUrl}`)
  } finally {
    await t.stop()
  }
})

test('the shell assets need a paired phone', async () => {
  const t = await startBridge()
  try {
    const res = await httpFetch(`${t.base}/app.js?l=zh&h=x`)
    assert.notEqual(res.status, 200)
  } finally {
    await t.stop()
  }
})

// A fixed cache name would survive an update: activate() only evicts keys that
// differ from its own, so the phone would be handed the previous build's
// document again after a restart. The worker's cache name must therefore follow
// the shell it caches.
test('the service worker cache name follows the shell build', async () => {
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(`${t.base}/sw.js`, { headers: { cookie } })
    assert.equal(res.status, 200)
    const body = await readBody(res)

    const build = t.bridge.shellBuild()
    assert.match(build, /^[0-9a-f]{12}$/)
    assert(body.includes(`const V='pocket-${build}'`), `worker must cache under pocket-${build}, saw ${body.slice(0, 120)}`)

    // Derived from the assets, never from the document's per-open boot payload.
    const assets = mobilePageAssets({ locale: 'zh' })
    assert.notEqual(t.bridge.shellBuild(), assets.css, 'the build must be a digest, not the CSS itself')

    // A build that is not a safe literal falls back to the static name instead
    // of injecting an arbitrary string into the worker source.
    assert.match(renderServiceWorker(), /const V='pocket-v3'/)
    assert.match(renderServiceWorker('9f2c1a4b7e01'), /const V='pocket-9f2c1a4b7e01'/)
    assert.match(renderServiceWorker("x';evil()//"), /const V='pocket-v3'/)
  } finally {
    await t.stop()
  }
})

// The page script has no imports of its own, so the memory and refill contracts
// it must keep can only be read out of its text. The slice helper keeps every
// check anchored to a named function rather than to a line number.
const slice = (js, start, end) => {
  const from = js.indexOf(start)
  assert.ok(from >= 0, `missing anchor: ${start}`)
  const to = js.indexOf(end, from + start.length)
  assert.ok(to > from, `missing end anchor: ${end}`)
  return js.slice(from, to)
}

// AC-PERF-cache + the resize half of M21: a long visit must not keep every warm
// transcript, and a keyboard that resizes the viewport must still top the
// transcript up — on every device, without turning the fallback into a per-frame
// driver of --app-height.
test('AC-PERF the session cache is bounded and the resize path refills the transcript', () => {
  const js = assets.js

  // The cap is a named constant, not a literal buried in the eviction loop.
  assert.match(js, /const SESSION_CACHE_MAX=\d+/, 'the cache cap is a named constant')

  // The warm cache is a Map, so its own insertion order is the recency order:
  // eviction must drop the front, and a hit must move the entry to the back.
  const evict = slice(js, 'function evictSessionCache()', 'function renderBlock(')
  assert.ok(evict.includes('while(sessionCache.size>max)'), 'eviction loops until the cache fits')
  assert.ok(evict.includes('sessionCache.keys().next().value'), 'eviction drops the oldest entry')
  assert.ok(evict.includes('sessionCache.delete('), 'eviction removes it')
  assert.ok(
    js.includes('sessionCache.delete(activeSession);sessionCache.set(activeSession,cached)'),
    'a cache hit re-inserts, which is the only recency signal a Map gives',
  )

  // Leaving a session is what trims the cache, after the outgoing entry is stored.
  const leaving = slice(js, 'async function showSessionList()', 'closeSessionSettings()')
  assert.ok(leaving.includes('evictSessionCache();'), 'leaving a session trims the cache')
  assert.ok(
    leaving.indexOf('evictSessionCache()') > leaving.indexOf('sessionCache.set('),
    'the outgoing transcript is stored before the cache is trimmed',
  )

  // The resize handler must reach the transcript fill on both branches: the Apple
  // branch drives --app-height first, every other device goes straight to the
  // fill, and neither calls ensureTranscriptFilled() inline (the debounce is the
  // whole point — a per-frame fill is the §5b ban).
  const viewport = slice(js, 'function scheduleViewportFill()', "document.addEventListener('visibilitychange'")
  assert.ok(viewport.includes('void ensureTranscriptFilled()'), 'the debounced fill reaches the transcript')
  assert.match(
    viewport,
    /function scheduleViewport\(\)\{if\(viewportRaf\)return;if\(!appleTouchDevice\)\{scheduleViewportFill\(\);return\}/,
    'the non-Apple branch refills without allocating a rAF or writing the height',
  )
  assert.match(
    viewport,
    /viewportRaf=requestAnimationFrame\(\(\)=>\{applyViewportHeight\(\);scheduleViewportFill\(\)\}\)/,
    'the Apple branch still drives the height, then refills',
  )
  assert.ok(js.includes("window.addEventListener('resize',scheduleViewport)"), 'the window resize is wired to it')
  assert.ok(
    js.includes("window.visualViewport?.addEventListener('resize',scheduleViewport)"),
    'and so is the visual viewport',
  )
  assert.ok(
    viewport.includes('viewportFillTimer=setTimeout(()=>{viewportFillTimer=null;'),
    'the fill is scheduled, never called straight from the resize handler',
  )
})

// AC-PERF-WS/abort. tasks.md:159 wanted this in test/sse-framing.test.js, which is
// outside this package's write set; it lands here as a source-level check plus a
// behavioural check of the two contracts that actually ship. The in-flight-RPC
// half is coupled to P-9: LEAD de-scoped the page-side session abort table, so
// there is no AbortError to assert — what ships is rpc()'s own timeout, and the
// discrimination is the timeout/disconnect pair plus the message, never
// instanceof. The reconnect half is the guard that keeps a live stream single.
test('AC-PERF an aborted RPC reports its own timeout and a reconnect never doubles the stream', async () => {
  const js = assets.js
  const labels = { requestTimeout: 'the request timed out', streamDownHost: 'host unreachable', failed: 'failed' }

  // --- the reconnect half: a retry must never open a second stream while one is
  // live, while the session still matches, or while the tab is hidden.
  const retrySource = slice(js, 'function armStreamRetry(sessionId)', 'function armStreamStaleWatch(sessionId)')
  const buildRetry = (state) => {
    const world = { opened: [], pending: null }
    const make = new Function(
      'setTimeout',
      'world',
      `
      let activeSession=world.activeSession,sessionStream=world.sessionStream,streamRetryTimer=null
      const STREAM_STALE_MS=60000
      const document={hidden:world.hidden}
      function openSessionStream(id){world.opened.push(id)}
      ${retrySource}
      return armStreamRetry
      `,
    )
    const arm = make((cb) => {
      world.pending = cb
      return 1
    }, { ...state, opened: world.opened })
    arm(state.armedFor)
    return world
  }
  const fireRetry = (state) => {
    const world = buildRetry(state)
    world.pending()
    return world.opened
  }
  assert.deepEqual(fireRetry({ armedFor: 's1', activeSession: 's1', sessionStream: {}, hidden: false }), [], 'a live stream is never doubled')
  assert.deepEqual(fireRetry({ armedFor: 's2', activeSession: 's1', sessionStream: null, hidden: false }), [], 'a stale timer for another session is dropped')
  assert.deepEqual(fireRetry({ armedFor: 's1', activeSession: 's1', sessionStream: null, hidden: true }), [], 'a hidden tab does not reconnect')
  assert.deepEqual(fireRetry({ armedFor: 's1', activeSession: 's1', sessionStream: null, hidden: false }), ['s1'], 'and the one legal case does retry')

  // The stale watch closes the stream before it schedules that retry, so the two
  // can never overlap.
  const watch = slice(js, 'function armStreamStaleWatch(sessionId)', 'function showTranscriptRetry()')
  assert.ok(
    watch.includes('closeSessionStream();schedulePoll();armStreamRetry(sessionId)'),
    'the stale path closes the stream, hands back to the poll, then re-arms',
  )

  // --- the abort half: exactly one controller, one timeout, and a fetch the
  // timeout cut short reported as a timeout rather than as a disconnect.
  const rpcSource = slice(js, 'async function rpc(', '// A dropped stream')
  assert.equal(js.split('new AbortController()').length - 1, 1, 'the page owns exactly one controller')

  const cleared = []
  const aborted = []
  const makeRpc = (fetchImpl) =>
    new Function(
      'fetch',
      'setTimeout',
      'clearTimeout',
      `
      const L=${JSON.stringify(labels)};
      const RPC_TIMEOUT_MS=12000,RPC_SLOW_TIMEOUT_MS=180000;
      const BRIDGE_TRANSPORT_CODES=['__bridge/not-ready','__bridge/transport','__bridge/rpc-mismatch'];
      ${slice(js, 'function rpcFailure(body,status)', 'async function rpc(')}
      ${rpcSource}
      return rpc
      `,
    )(
      fetchImpl,
      setTimeout,
      (timer) => {
        cleared.push(timer)
        clearTimeout(timer)
      },
    )

  const rpc = makeRpc(
    (url, opts) =>
      new Promise((resolve, reject) => {
        assert.equal(url, '/api/rpc', 'the page posts to the bridge')
        opts.signal.addEventListener('abort', () => {
          aborted.push(true)
          reject(new Error('AbortError'))
        })
      }),
  )
  await assert.rejects(
    () => rpc('session.history', { sessionId: 's1' }, 20),
    (e) => {
      assert.equal(e.timeout, true, 'a request the timeout cut short is marked as a timeout')
      assert.equal(e.disconnected, false, 'and never as a disconnect')
      assert.equal(e.message, labels.requestTimeout, 'the copy names the timeout')
      assert.equal(e.errorCode, undefined, 'the bridge never answered, so there is no errorCode')
      return true
    },
  )
  assert.equal(aborted.length, 1, 'the controller aborted the fetch')
  assert.equal(cleared.length, 1, 'and the timeout was cleared in the same finally')

  // P-9 is de-scoped: no page-side session abort table ships, and leaving a
  // session must not abort an in-flight RPC.
  assert.ok(!/sessionAbort|abortSession/i.test(js), 'no page-side session abort table ships')
  assert.ok(
    !slice(js, 'function closeSessionStream()', 'function applyHistory(').includes('abort('),
    'leaving a session does not abort in-flight RPCs',
  )
})
