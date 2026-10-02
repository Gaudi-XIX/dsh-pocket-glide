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
