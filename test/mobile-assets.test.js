// The mobile shell splits into a ~4 KB document plus the CSS and the app script,
// which the phone can then keep. The assets must be byte-identical to the blocks
// that used to travel inline, and the document must carry a bootstrap that
// notices a mangled cached copy (the phone turned a cached document into
// unreadable text once already).
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMobilePage, mobilePageAssets } from '../lib/pages.js'
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
