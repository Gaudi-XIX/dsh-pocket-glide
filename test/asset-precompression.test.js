// The two content-addressed shell assets (`/app.css`, `/app.js`) are sent
// compressed when the client asks for brotli or gzip and the `h` in the URL is
// the hash of exactly those bytes. Everything here goes through a real
// `createServer()` + real socket: the 2026-10-01 regression (`test/boot-landing.test.js`)
// is pinned at the `html()` function level, which is precisely why it cannot
// prove that no HTTP path compresses the document. AC4 below closes that gap.
//
// The document and the event stream must stay plain at the origin. Only these
// two assets are compressed, and only when the URL names their own hash.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { mobilePageAssets } from '../lib/pages.js'
import { precompressAssets, preferredEncoding } from '../lib/asset-compression.js'
import { startBridge, httpFetch } from './helpers.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readRepo = (path) => readFileSync(join(ROOT, path), 'utf8')

const compressionSource = readRepo('lib/asset-compression.js')
const bridgeSource = readRepo('lib/bridge.js')

const shell = (locale) => mobilePageAssets({ locale })
// The document route that follows the asset branch: the branch under test ends
// here. Indented by four spaces so the paired-phone block's narrower nesting
// cannot match first.
const DOCUMENT_ROUTE = "\n    if (request.method === 'GET' && url.pathname === '/') {"
const documentRouteAt = () => {
  const at = bridgeSource.indexOf(DOCUMENT_ROUTE)
  assert.ok(at > 0, 'the document route must still follow the asset branch')
  return at
}
const plainBytes = (locale, kind) => Buffer.from(kind === 'css' ? shell(locale).css : shell(locale).js, 'utf8')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const bodyBytes = async (res) => Buffer.from(await new Response(res.body).arrayBuffer())
const hashOf = (url) => new URL(url, 'http://placeholder.invalid').searchParams.get('h')

/** The asset URL the page itself would use, with the bridge's own hash. */
function assetUrl(kind, locale = 'zh') {
  const { urls } = shared.bridge.mobileAssetBodies(locale)
  return kind === 'css' ? urls.cssUrl : urls.jsUrl
}

let shared

before(async () => {
  shared = await startBridge()
  shared.cookie = await shared.pairMobile()
})

after(async () => {
  await shared?.stop()
})

/** One request for an asset, with an explicit accept-encoding (null = none). */
function fetchAsset(path, acceptEncoding, cookie = shared.cookie) {
  const headers = {}
  if (cookie !== null) headers.cookie = cookie
  if (acceptEncoding !== null) headers['accept-encoding'] = acceptEncoding
  return httpFetch(`${shared.base}${path}`, { headers })
}

// ---------------------------------------------------------------------------
// T1 — the products themselves
// ---------------------------------------------------------------------------

test('AC1.1 the products come from node:crypto and node:zlib only', () => {
  assert.match(compressionSource, /export function precompressAssets/, 'precompressAssets must be exported')
  const compressorLines = compressionSource.split('\n').filter((line) => /brotliCompressSync|gzipSync/.test(line))
  assert.ok(compressorLines.length >= 2, `expected both compressors in use, saw ${compressorLines.length} lines`)

  const specifiers = [
    ...compressionSource.matchAll(/\bfrom\s+'([^']+)'/g),
    ...compressionSource.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)
  ].map((match) => match[1])
  assert.ok(specifiers.length >= 2, 'both modules must be imported')
  for (const specifier of specifiers) {
    assert.match(specifier, /^node:(zlib|crypto)$/, `only node:zlib / node:crypto may be imported, saw ${specifier}`)
  }
})

test('AC1.2 brotli is pinned at quality 9, not 11', () => {
  // br-11 saves ~7 KB per language for ~400 ms of synchronous construction per
  // language; br-9 is the decision (design §0.1-3 / §8-R5), so pin it.
  assert.match(compressionSource, /BROTLI_PARAM_QUALITY\]?\s*:\s*9/, 'BROTLI_PARAM_QUALITY must be 9')
})

test('AC1.3 no dependency was added', () => {
  const pkg = JSON.parse(readRepo('package.json'))
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['pngjs'])
})

test('AC1.4 brotli-9 clears the br tier and gzip-9 clears the gzip tier', () => {
  // LEAD's call (2026-10-24 17:3x): the two tiers, each judged on its own
  // product — gzip ≤ 120 KB, brotli ≤ 100 KB. The old single ≤110 KB number only
  // ever held for brotli (gzip-9 is ~113.5 KB), so assert the tiers, not a total.
  for (const locale of ['zh', 'en']) {
    const bodies = shell(locale)
    const entry = precompressAssets({ locale, css: bodies.css, js: bodies.js }).get(`js@${locale}`)
    assert.ok(entry.br.length <= 100 * 1024, `${locale} brotli must be ≤ 100 KB, got ${entry.br.length}`)
    assert.ok(entry.gzip.length <= 120 * 1024, `${locale} gzip must be ≤ 120 KB, got ${entry.gzip.length}`)
    // The shape of the decision, so a regression to a weak quality setting dies
    // here rather than in a hand-measured table: brotli is the tier that fits
    // under 110 KB, and it must stay clearly below gzip.
    // 2026-10-24 W2a（剥注释）之后，原来的「gzip > 110 KB」绝对值断言失效——zh gzip
    //   从 116,630 掉到 67,143 B，已稳在 110 KB 以下（br 59,422 B）。brotli 那条
    //   ≤110 KB 仍在（59,422 B），但 gzip 侧不再有任何绝对值可钉。改钉不绑定具体
    //   字节的形状：gzip 必须比 br 大出一个可测量的裕度（br 9 与 gzip 9 的压缩率
    //   差距，实测比值 1.13×，取 1.05 作下限，给未来调参留余量而不放过「gzip 反而
    //   更小」这种回归）。
    assert.ok(entry.br.length < 110 * 1024, `${locale} brotli must stay under 110 KB`)
    assert.ok(entry.gzip.length > entry.br.length * 1.05, `${locale} gzip must stay measurably above brotli (gzip ${entry.gzip.length} vs br ${entry.br.length})`)
    assert.ok(entry.br.length < entry.gzip.length, `brotli must beat gzip (${locale})`)
    assert.ok(entry.br.length < entry.identity.length, 'compression must actually shrink the asset')
  }
})

test('AC1.5 the URL hash is the sha256 of exactly the bytes we compressed', () => {
  for (const kind of ['css', 'js']) {
    const entry = shared.bridge.precompressed.get(`${kind}@zh`)
    assert.ok(entry, `${kind}@zh must be built at construction`)
    assert.equal(entry.sha256, hashOf(assetUrl(kind)), `the ${kind} URL hash and the product digest must be identical`)
    assert.equal(entry.sha256.length, 12)
    assert.equal(sha256(entry.identity).slice(0, 12), entry.sha256)
    assert.deepEqual(entry.identity, plainBytes('zh', kind), 'the product is built from the bytes the route serves')
  }
})

test('AC1.6 zh and en scripts are kept apart while both share one stylesheet', () => {
  const zh = shared.bridge.precompressed.get('js@zh')
  const en = shared.bridge.precompressed.get('js@en')
  const zhCss = shared.bridge.precompressed.get('css@zh')
  const enCss = shared.bridge.precompressed.get('css@en')

  assert.notEqual(zh.sha256, en.sha256, 'the two locales have different scripts, so different hashes')
  assert.notEqual(zh.identity.length, en.identity.length)
  assert.notEqual(zh.br.toString('base64'), en.br.toString('base64'), 'one locale must never be served the other locale\'s product')
  assert.equal(zhCss.sha256, enCss.sha256, 'both locales render the same stylesheet')
  assert.deepEqual(zhCss.identity, enCss.identity)
  assert.equal(shared.bridge.precompressed.size, 4, 'two kinds by two locales')
})

// ---------------------------------------------------------------------------
// T2 — choosing a product over the real HTTP stack
// ---------------------------------------------------------------------------

test('AC2.1 a client that asks for br gets brotli, and it decodes to the asset', async () => {
  const res = await fetchAsset(assetUrl('js'), 'br, gzip')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-encoding'), 'br')
  const body = await bodyBytes(res)
  assert.deepEqual(zlib.brotliDecompressSync(body), plainBytes('zh', 'js'))
  assert.equal(body.length, shared.bridge.precompressed.get('js@zh').br.length)
})

test('AC2.2 a client that only asks for gzip gets gzip, with a matching length', async () => {
  const res = await fetchAsset(assetUrl('js'), 'gzip')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-encoding'), 'gzip')
  const body = await bodyBytes(res)
  const product = shared.bridge.precompressed.get('js@zh').gzip
  assert.equal(body.length, product.length)
  assert.equal(Number(res.headers.get('content-length')), product.length)
  assert.deepEqual(zlib.gunzipSync(body), plainBytes('zh', 'js'))
})

test('AC2.3 deflate or no accept-encoding at all yields the plain bytes', async () => {
  const expected = plainBytes('zh', 'js')
  for (const acceptEncoding of ['deflate', null]) {
    const res = await fetchAsset(assetUrl('js'), acceptEncoding)
    assert.equal(res.status, 200, `status for ${String(acceptEncoding)}`)
    assert.equal(res.headers.get('content-encoding'), null, `no content-encoding for ${String(acceptEncoding)}`)
    assert.deepEqual(await bodyBytes(res), expected)
  }
})

test('AC2.4 vary: accept-encoding is sent for all three shapes', async () => {
  // Unconditional, including the identity answer: otherwise an intermediary can
  // hand the plain bytes to a client that asked for br and reproduce the
  // 2026-10-01 shape -- a header and a body that disagree.
  for (const acceptEncoding of ['br, gzip', 'gzip', 'deflate', null]) {
    const res = await fetchAsset(assetUrl('js'), acceptEncoding)
    assert.match(String(res.headers.get('vary')), /accept-encoding/i, `vary missing for ${String(acceptEncoding)}`)
  }
})

test('AC2.4b vary is sent even when the request cannot be compressed', async () => {
  // Unconditional on purpose (design §5-3): a missing or wrong `h` answers with
  // the plain bytes, and that answer still has two possible shapes, so every hop
  // that stores it has to know which one it stored.
  for (const path of ['/app.js?l=zh', '/app.js?l=zh&h=deadbeefcafe']) {
    const res = await fetchAsset(path, 'br, gzip')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-encoding'), null)
    assert.match(String(res.headers.get('vary')), /accept-encoding/i, `vary missing for ${path}`)
  }
})

test('AC2.5 the existing cache headers are untouched (and no ETag)', async () => {
  for (const kind of ['css', 'js']) {
    const res = await fetchAsset(assetUrl(kind), 'br, gzip')
    assert.equal(res.headers.get('cache-control'), 'private, max-age=604800')
    assert.equal(res.headers.get('etag'), null, 'this card does not add a freshness dialect')
  }
})

test('AC2.6 the two encodings are genuinely different bytes, each with its own length', async () => {
  const br = await fetchAsset(assetUrl('js'), 'br, gzip')
  const gzip = await fetchAsset(assetUrl('js'), 'gzip')
  const brBody = await bodyBytes(br)
  const gzipBody = await bodyBytes(gzip)
  assert.notDeepEqual(brBody, gzipBody, 'a fixed product would ignore accept-encoding')
  assert.equal(Number(br.headers.get('content-length')), brBody.length)
  assert.equal(Number(gzip.headers.get('content-length')), gzipBody.length)
})

// ---------------------------------------------------------------------------
// T3 — the URL hash has to match, and locale has to align
// ---------------------------------------------------------------------------

test('AC3.1 no h means the plain bytes with 200', async () => {
  const res = await fetchAsset('/app.js?l=zh', 'br, gzip')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-encoding'), null)
  assert.deepEqual(await bodyBytes(res), plainBytes('zh', 'js'))
})

test('AC3.2 a wrong h still answers 200 with the plain bytes, never 404', async () => {
  const res = await fetchAsset('/app.js?l=zh&h=deadbeefcafe', 'br, gzip')
  assert.equal(res.status, 200, 'the h parameter must not gain a status-code meaning')
  assert.equal(res.headers.get('content-encoding'), null)
  assert.deepEqual(await bodyBytes(res), plainBytes('zh', 'js'))
})

test('AC3.3 each locale decompresses to its own script, and a missing l is zh', async () => {
  const zh = await fetchAsset(assetUrl('js', 'zh'), 'br')
  const en = await fetchAsset(assetUrl('js', 'en'), 'br')
  const zhBody = zlib.brotliDecompressSync(await bodyBytes(zh))
  const enBody = zlib.brotliDecompressSync(await bodyBytes(en))
  assert.equal(sha256(zhBody), sha256(plainBytes('zh', 'js')))
  assert.equal(sha256(enBody), sha256(plainBytes('en', 'js')))
  assert.notEqual(sha256(zhBody), sha256(enBody))

  const fallback = await fetchAsset(`/app.js?h=${hashOf(assetUrl('js', 'zh'))}`, 'br')
  assert.equal(fallback.headers.get('content-encoding'), 'br')
  assert.equal(sha256(zlib.brotliDecompressSync(await bodyBytes(fallback))), sha256(plainBytes('zh', 'js')))
})

test('AC3.4 /app.css negotiates the same three shapes', async () => {
  const expected = plainBytes('zh', 'css')
  const br = await fetchAsset(assetUrl('css'), 'br, gzip')
  assert.equal(br.headers.get('content-encoding'), 'br')
  assert.deepEqual(zlib.brotliDecompressSync(await bodyBytes(br)), expected)

  const gzip = await fetchAsset(assetUrl('css'), 'gzip')
  assert.equal(gzip.headers.get('content-encoding'), 'gzip')
  assert.deepEqual(zlib.gunzipSync(await bodyBytes(gzip)), expected)

  const identity = await fetchAsset(assetUrl('css'), 'identity')
  assert.equal(identity.headers.get('content-encoding'), null)
  assert.deepEqual(await bodyBytes(identity), expected)
})

test('AC3.5 the h parameter is read in exactly one place, inside the asset branch', () => {
  const reads = [...bridgeSource.matchAll(/searchParams\.get\('h'\)/g)]
  assert.equal(reads.length, 1, 'one read point, inside the asset branch')
  assert.ok(reads[0].index > bridgeSource.indexOf("url.pathname === '/app.css'"))
  assert.ok(reads[0].index < documentRouteAt())
})

// ---------------------------------------------------------------------------
// T4 — the 2026-10-01 shape: the document is never compressed, over HTTP
// ---------------------------------------------------------------------------

test('AC4.1 over a real socket the document is plain and uncacheable', async () => {
  const compressed = await httpFetch(`${shared.base}/`, { headers: { cookie: shared.cookie, 'accept-encoding': 'br, gzip' } })
  assert.equal(compressed.status, 200)
  assert.equal(compressed.headers.get('cache-control'), 'no-store')
  assert.equal(compressed.headers.get('content-encoding'), null)
  const withHeader = (await bodyBytes(compressed)).toString('utf8')
  assert.match(withHeader, /<!doctype html/i, 'the body must still be the document itself')

  const plain = await httpFetch(`${shared.base}/`, { headers: { cookie: shared.cookie } })
  assert.equal(plain.headers.get('content-encoding'), null)
  const withoutHeader = (await bodyBytes(plain)).toString('utf8')

  // The document is not byte-stable across requests by design: every render gets
  // a fresh CSP nonce. So compare every byte outside the nonce values, and prove
  // the normalisation is real by finding nonces to normalise.
  const noncePattern = /nonce="[^"]*"/g
  assert.ok(withHeader.match(noncePattern)?.length, 'the document carries a per-request nonce')
  assert.equal(withHeader.replace(noncePattern, 'nonce=""'), withoutHeader.replace(noncePattern, 'nonce=""'),
    'asking for compression must not change the document')
})

test('AC4.2 content-encoding lives only in the asset branch, never in html()/text()/json()', () => {
  const hits = [...bridgeSource.matchAll(/content-encoding/g)]
  assert.equal(hits.length, 1, 'the bridge sets content-encoding in exactly one place')
  const branchStart = bridgeSource.indexOf("url.pathname === '/app.css'")
  const branchEnd = documentRouteAt()
  assert.ok(hits[0].index > branchStart && hits[0].index < branchEnd, 'and that place is the asset branch')

  for (const method of ['html', 'text', 'json']) {
    const start = bridgeSource.indexOf(`\n  ${method}(response`)
    assert.ok(start > 0, `${method}() must still exist`)
    const body = bridgeSource.slice(start, bridgeSource.indexOf('\n  }\n', start))
    assert.ok(!body.includes('content-encoding'), `${method}() must not compress`)
  }
})

test('AC4.3 nothing outside the asset route touches content-encoding', () => {
  // The stream is where a compressed body would be worst: `text/event-stream`
  // is framed by newlines on the client, and the document route is the scene of
  // the 2026-10-01 regression. Neither file may mention the header at all.
  assert.ok(!readRepo('lib/session-stream.js').includes('content-encoding'))
  for (const file of readdirSync(join(ROOT, 'lib'))) {
    if (!file.endsWith('.js') || file === 'bridge.js') continue
    assert.ok(
      !readFileSync(join(ROOT, 'lib', file), 'utf8').includes('content-encoding'),
      `${file} must not set content-encoding`
    )
  }
})

// ---------------------------------------------------------------------------
// T5 — missing products degrade to the plain bytes, never to an error
// ---------------------------------------------------------------------------

test('AC5.1 a failing compressor yields a missing product, never a throw', () => {
  const original = zlib.brotliCompressSync
  let products
  try {
    zlib.brotliCompressSync = () => {
      throw new Error('brotli unavailable')
    }
    products = precompressAssets({ locale: 'zh', css: shell('zh').css, js: shell('zh').js })
  } finally {
    zlib.brotliCompressSync = original
  }
  for (const key of ['css@zh', 'js@zh']) {
    const entry = products.get(key)
    assert.ok(entry, `${key} must still exist so gzip keeps working`)
    assert.equal(entry.br, null, `${key} has no brotli product`)
    assert.ok(Buffer.isBuffer(entry.gzip), `${key} keeps its gzip product`)
    assert.deepEqual(zlib.gunzipSync(entry.gzip), entry.identity)
    assert.equal(sha256(entry.identity).slice(0, 12), entry.sha256)
  }

  // A source that cannot be compressed at all makes its key null, and only it.
  const partial = precompressAssets({ locale: 'zh', css: null, js: shell('zh').js })
  assert.equal(partial.get('css@zh'), null)
  assert.ok(partial.get('js@zh'))
})

test('AC5.2 a bridge with no products answers 200 with the plain bytes', async () => {
  const saved = shared.bridge.precompressed
  shared.bridge.precompressed = new Map()
  try {
    const res = await fetchAsset(assetUrl('js'), 'br, gzip')
    assert.equal(res.status, 200, 'a missing product is not a 500 or a 404')
    assert.equal(res.headers.get('content-encoding'), null)
    assert.deepEqual(await bodyBytes(res), plainBytes('zh', 'js'))
  } finally {
    shared.bridge.precompressed = saved
  }
})

test('AC5.3 the hash may match while both products are missing', async () => {
  const saved = shared.bridge.precompressed
  const identity = plainBytes('zh', 'js')
  shared.bridge.precompressed = new Map([
    ['js@zh', { identity, sha256: hashOf(assetUrl('js')), gzip: null, br: null }]
  ])
  try {
    const res = await fetchAsset(assetUrl('js'), 'br, gzip')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-encoding'), null)
    assert.deepEqual(await bodyBytes(res), identity)
  } finally {
    shared.bridge.precompressed = saved
  }
})

test('AC5.4 a bridge whose brotli failed still answers gzip to a br client', async () => {
  // A host built without brotli still serves gzip (lib/asset-compression.js
  // header): the route must pick the best product it actually holds, not the
  // best one the client asked for.
  const saved = shared.bridge.precompressed
  const real = saved.get('js@zh')
  shared.bridge.precompressed = new Map([
    ['js@zh', { identity: real.identity, sha256: real.sha256, gzip: real.gzip, br: null }]
  ])
  try {
    const res = await fetchAsset(assetUrl('js'), 'br, gzip')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-encoding'), 'gzip', 'fall back to the product this bridge holds')
    assert.deepEqual(zlib.gunzipSync(await bodyBytes(res)), plainBytes('zh', 'js'))
  } finally {
    shared.bridge.precompressed = saved
  }
})

// ---------------------------------------------------------------------------
// T6 — the switch, and what "off" means
// ---------------------------------------------------------------------------

test('AC6.1 only an explicit 0 turns the switch off', async () => {
  for (const value of [undefined, '1', 'false']) {
    if (value === undefined) delete process.env.DSH_POCKET_PRECOMPRESS
    else process.env.DSH_POCKET_PRECOMPRESS = value
    const res = await fetchAsset(assetUrl('js'), 'br, gzip')
    assert.equal(res.headers.get('content-encoding'), 'br', `switch ${String(value)} must stay on`)
  }
  delete process.env.DSH_POCKET_PRECOMPRESS
})

test('AC6.2 with the switch off a freshly built bridge is byte-identical to today', async () => {
  process.env.DSH_POCKET_PRECOMPRESS = '0'
  let fresh
  try {
    // A new instance, built while the switch reads off: the read happens at the
    // request, so no module-level cache can make this pass by accident.
    fresh = await startBridge()
    const cookie = await fresh.pairMobile()
    const url = fresh.bridge.mobileAssetBodies('zh').urls.jsUrl
    const res = await httpFetch(`${fresh.base}${url}`, { headers: { cookie, 'accept-encoding': 'br, gzip' } })

    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-encoding'), null)
    assert.equal(res.headers.get('vary'), null, 'vary belongs to the switch, not to the route')
    assert.equal(res.headers.get('etag'), null)
    assert.match(String(res.headers.get('content-type')), /application\/javascript/)
    assert.equal(res.headers.get('cache-control'), 'private, max-age=604800')
    const body = await bodyBytes(res)
    assert.equal(sha256(body), sha256(Buffer.from(fresh.bridge.mobileAssetBodies('zh').js, 'utf8')))
    assert.equal(body.toString('utf8'), fresh.bridge.mobileAssetBodies('zh').js)
  } finally {
    delete process.env.DSH_POCKET_PRECOMPRESS
    await fresh?.stop()
  }
})

test('AC6.3 the switch is read at exactly one place in lib/', () => {
  const hits = readdirSync(join(ROOT, 'lib'))
    .filter((file) => file.endsWith('.js'))
    .map((file) => [file, (readFileSync(join(ROOT, 'lib', file), 'utf8').match(/DSH_POCKET_PRECOMPRESS/g) ?? []).length])
    .filter(([, count]) => count > 0)
  assert.deepEqual(hits, [['bridge.js', 1]], 'no module-level constant, no second read point')
})

// ---------------------------------------------------------------------------
// T7 — structure: the products are the shell, and the shell did not move
// ---------------------------------------------------------------------------

test('AC7.6 the product is the current shell, rendered exactly once per bridge', () => {
  // Structural form of "this card changes no shell byte": whatever the shell is
  // today, the product is built from exactly those bytes (so the compressed
  // route and the plain route can never disagree), and the precompressed map is
  // built at construction, before any request.
  for (const locale of ['zh', 'en']) {
    const bodies = shell(locale)
    for (const [kind, source] of [['css', bodies.css], ['js', bodies.js]]) {
      const entry = shared.bridge.precompressed.get(`${kind}@${locale}`)
      assert.ok(entry, `${kind}@${locale} built at construction`)
      assert.deepEqual(entry.identity, Buffer.from(source, 'utf8'))
      assert.equal(entry.sha256, hashOf(`${assetUrl(kind, locale)}`))
    }
  }
  assert.equal(preferredEncoding('BR, gzip', { br: true, gzip: true }), 'br')
  assert.equal(preferredEncoding('br;q=0, gzip', { br: true, gzip: true }), 'br', 'q-weights are deliberately ignored')
  assert.equal(preferredEncoding('*', { br: true, gzip: true }), null, 'wildcards do not opt into compression')
  assert.equal(preferredEncoding('gzip', { br: true, gzip: false }), null, 'never send a shape the client did not accept')
})
