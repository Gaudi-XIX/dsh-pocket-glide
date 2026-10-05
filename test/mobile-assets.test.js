// The mobile shell splits into a ~4 KB document plus the CSS and the app script,
// which the phone can then keep. The assets must be byte-identical to the blocks
// that used to travel inline, and the document must carry a bootstrap that
// notices a mangled cached copy (the phone turned a cached document into
// unreadable text once already).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mobilePageAssets,
  renderDesktopPairingPage,
  renderMobilePage,
  renderMobileReconnectPage,
  renderServiceWorker,
} from '../lib/pages.js'
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

test('the head carries the PWA manifest link next to the touch icon, inline and split alike', () => {
  const link = '<link rel="manifest" href="/manifest.json">'
  for (const document of [inline, split]) {
    const touch = document.indexOf('<link rel="apple-touch-icon"')
    const manifest = document.indexOf(link)
    assert.notEqual(manifest, -1, 'the manifest link must be in the head')
    assert.ok(manifest > touch, 'the manifest link sits after the apple-touch-icon link')
    assert.ok(manifest < document.indexOf('</head>'), 'and stays inside <head>')
  }
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

// ---------------------------------------------------------------------------
// WP-UI: the look, the reach, and the names a screen reader reads.
// These came out of the 2026-10-02 audit (section 3, "light and experience").
// The page has no DOM this runner could drive, so each contract is read out of
// the shipped text; the measurements behind them are recorded in the change's
// handoff, not re-derived here, except for the two contrast ratios which are
// cheap enough to recompute so that reverting a token turns this red.

const relLuminance = (hex) => {
  const channel = (pair) => {
    const value = parseInt(pair, 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const digits = hex.slice(1)
  return (
    0.2126 * channel(digits.slice(0, 2)) +
    0.7152 * channel(digits.slice(2, 4)) +
    0.0722 * channel(digits.slice(4, 6))
  )
}
const contrast = (a, b) => {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const tagOf = (html, needle) => {
  const at = html.indexOf(needle)
  assert.ok(at >= 0, `missing markup: ${needle}`)
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1)
}

test('AC-UI1 every control the audit measured small now clears the 44px floor', () => {
  const css = assets.css
  const raised = [
    '.head-icon{flex:none;display:grid;place-items:center;width:44px;height:44px;',
    '.settings-close{display:grid;place-items:center;width:44px;height:44px;',
    '.question-close{width:44px;height:44px;',
    '.back{display:grid;place-items:center;flex:none;width:44px;height:44px;',
    '.plus-trigger{display:grid;place-items:center;width:44px;min-width:44px;height:44px;',
    '.settings-trigger{display:grid;place-items:center;width:44px;min-width:44px;height:44px;',
    '.ws-new{flex:none;display:grid;place-items:center;width:44px;height:44px;',
    'button.primary{display:flex;align-items:center;justify-content:center;gap:6px;flex:none;min-width:68px;height:44px;',
    '.composer .primary,.primary.cancel{width:44px;min-width:44px;',
    '.composer textarea{flex:1;height:44px;min-height:44px;',
    '.plus-search-open{display:flex;align-items:center;gap:7px;width:100%;height:44px;',
    '.plus-filter{width:100%;height:44px;',
    '.todo-header{width:100%;height:44px;',
    '.setting-field select{width:100%;height:44px;',
    '.chat-toolbar{position:absolute;inset:0 0 auto;z-index:2;min-height:44px;',
    '.plus-search-cancel{flex:none;min-width:44px;min-height:44px;',
    '.plus-back{display:inline-flex;align-items:center;gap:4px;min-height:44px;',
    '.task-row{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;',
    '.slash-row{display:flex;align-items:center;gap:9px;width:100%;min-height:44px;',
    '.older-row{flex:none;align-self:center;min-height:44px;',
  ]
  for (const rule of raised) {
    assert.ok(css.includes(rule), `this rule must clear the 44px touch floor: ${rule}`)
  }

  // Deliberate exception. The delete control sits inside a 64px draft card that
  // is itself the way into the draft, and 44px would cover close to half of it
  // and steal that tap. 26px keeps it reachable without arming it by accident.
  assert.ok(
    css.includes('.draft-remove{position:absolute;top:3px;right:3px;width:26px;height:26px;'),
    'the destructive overlay stays smaller than the card it sits in',
  )
})

test('AC-UI2 the light palette reaches AA, and both themes own their error red', () => {
  const css = assets.css

  // Recompute the two ratios the audit flagged rather than trusting the token:
  // this is the assertion that fails if someone puts the old value back.
  assert.ok(contrast('#6b7076', '#ffffff') >= 4.5, 'muted text on white reaches AA')
  assert.ok(contrast('#6b7076', '#f7f8fa') >= 4.5, 'and stays there on the panel')
  assert.ok(contrast('#c62f3c', '#f7f8fa') >= 4.5, 'the light error red reaches AA on the panel')
  assert.ok(contrast('#ff9ba1', '#202023') >= 4.5, 'the dark error red reaches AA on the dark panel')
  assert.ok(contrast('#81858c', '#ffffff') < 4.5, 'the value this replaced was the reason for the change')
  assert.ok(contrast('#e34d59', '#f7f8fa') < 4.5, 'and so was the old error red')
  // A single light value cannot serve both themes; that is why danger is a token.
  assert.ok(contrast('#c62f3c', '#202023') < 4.5, 'the light red is unreadable on the dark panel')

  const light = css.slice(css.indexOf(':root{color-scheme:light'), css.indexOf('}', css.indexOf(':root{color-scheme:light')))
  assert.ok(light.includes('--muted:#6b7076'), 'the light muted token is the measured value')
  assert.ok(light.includes('--danger:#c62f3c'), 'error copy reads a token, not a literal')
  const dark = css.slice(css.indexOf(':root{color-scheme:dark'))
  assert.ok(dark.includes('--danger:#ff9ba1'), 'the dark theme carries its own red')

  // No text rule may paint the old red directly. The lookbehind matters:
  // 'border-color:#e34d59' contains the substring 'color:#e34d59'.
  assert.ok(
    !/[;{]color:#e34d59/.test(css),
    'no text rule still paints the old red, which fails AA on every light surface',
  )
  assert.ok(css.includes('color:var(--danger)'), 'the error copy uses the token')
})

test('AC-UI3 neither phone page forbids pinch zoom any more', () => {
  const app = inline
  const reconnect = renderMobileReconnectPage('zh', 'lan')
  for (const [name, html] of [['app', app], ['reconnect', reconnect]]) {
    assert.match(
      html,
      /<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover/,
      `${name} keeps the viewport meta`,
    )
    assert.ok(!html.includes('maximum-scale'), `${name} must not cap the zoom level at any scale`)
  }
})

test('AC-UI4 the reduced-motion block names the animations that actually run', () => {
  const css = assets.css
  const at = css.indexOf('@media(prefers-reduced-motion:reduce){')
  assert.ok(at >= 0, 'the app sheet still answers the preference')
  const block = css.slice(at, css.indexOf('}', css.indexOf('transition:none', at)) + 1)

  // The old rule targeted '.icon-button.refreshing svg', a class that does not
  // exist anywhere in the page while '.head-icon.spinning svg' does: a media
  // query that never matched. Every selector below is one that really animates.
  for (const live of [
    '.skeleton',
    '.status',
    '.head-icon.spinning svg',
    '.older-spin',
    '.is-running .spin',
    '.turn-status',
    '.todo-item[data-status=in_progress] .todo-glyph',
    '.plus-sheet',
    '.ws-chevron',
    '#messages.animating',
  ]) {
    assert.ok(block.includes(live), `${live} still animates for a user who asked it not to`)
  }
  assert.ok(!block.includes('.icon-button.refreshing'), 'the selector that matched nothing is gone')
})

test('AC-UI5 the three error lines announce themselves and the inputs have names', () => {
  const html = inline
  for (const id of ['chatError', 'listError', 'settingsError']) {
    const tag = tagOf(html, `id="${id}"`)
    assert.match(tag, /\brole="status"/, `${id} must be a live region`)
    assert.match(tag, /\baria-live="polite"/, `${id} must be politely live`)
  }
  assert.match(
    html,
    /<textarea id="prompt" rows="1" aria-label="[^"]+"/,
    'the composer has an accessible name',
  )
  assert.match(
    html,
    /<input id="plusFilter"[^>]*aria-label="[^"]+"/,
    'the sheet search field has an accessible name',
  )
  // The sheet claims aria-modal, so it must also be escapable by keyboard.
  assert.match(html, /<div[^>]+id="plusSheet"[^>]*aria-modal="true"/, 'the sheet is a modal')
})

test('AC-UI6 the sheet traps Tab and the failed-draft card is operable', () => {
  const js = assets.js
  const helpers = slice(js, 'function sheetFocusables(){', 'function openPlus(){')
  assert.ok(helpers.includes('function focusSheetStart(){'), 'the opener has something to move focus to')
  assert.ok(helpers.includes('function trapSheetFocus(event){'), 'and a trap to keep it in')
  assert.ok(helpers.includes("querySelectorAll('button:not([disabled])"), 'the trap enumerates real controls')
  assert.ok(helpers.includes('items[items.length-1]'), 'and knows the last one')
  assert.ok(helpers.includes('event.shiftKey'), 'so it cycles backwards too')

  assert.ok(
    slice(js, 'function openPlus(){', 'function closePlus(').includes('focusSheetStart()'),
    'opening the sheet moves focus inside it',
  )
  assert.ok(
    js.includes("if(e.key==='Tab'&&plusOpen()){trapSheetFocus(e);return}"),
    'Tab is trapped while the sheet is open',
  )
  assert.ok(
    js.includes("if(e.key!=='Escape'||!plusOpen())return;"),
    'and the Escape guard it was threaded into is unchanged',
  )

  // The retry card is a div in a strip with no buttons: it needs both a role
  // and its own key handling, or a keyboard user cannot retry an upload.
  assert.ok(js.includes('" role="button" tabindex="0">'), 'the retry card is reachable')
  assert.ok(
    js.includes("$('draftStrip').onkeydown=e=>{if(e.key!=='Enter'&&e.key!==' ')return;"),
    'and answers Enter and Space',
  )
})

test('AC-UI7 the QR is one image, zh-* is Chinese, and an unknown locale is not', () => {
  const pairing = renderDesktopPairingPage({ locale: 'zh', pairingUrl: 'https://x', pairingPin: '12345678' })
  assert.ok(
    pairing.includes('<div id="qrCode" role="img" aria-label="配对二维码">'),
    'the QR modules are announced as a single image',
  )
  const english = renderDesktopPairingPage({
    locale: 'en',
    pairingUrl: 'https://x',
    pairingPin: '12345678',
  })
  assert.ok(english.includes('aria-label="Pairing QR code"'), 'and named in English for an English page')

  for (const locale of ['zh-CN', 'zh-Hans']) {
    const variant = renderDesktopPairingPage({ locale, pairingUrl: 'https://x', pairingPin: '12345678' })
    assert.ok(variant.includes('aria-label="配对二维码"'), `${locale} must be treated as Chinese`)
  }
  const japanese = renderMobilePage({ locale: 'ja' })
  assert.ok(!japanese.includes('消息输入框'), 'an unsupported locale falls back to English, not Chinese')
  assert.ok(japanese.includes('aria-label="Message input"'), 'and it gets the English name instead')
})

test('AC-UI8 the two locale-only leaks the audit found are gone', () => {
  const js = assets.js
  assert.ok(js.includes('bits.join(L.draftJoin)'), 'the draft summary joins with a locale token')
  assert.ok(!js.includes("bits.join('，')"), 'not with a full-width comma an English reader cannot see')
  assert.ok(js.includes('"draftJoin":'), 'and the token is in the label table')
  // The permission row used to render the upload copy while it waited, so the
  // sheet said "uploading" about something it was only loading.
  assert.ok(
    js.includes(`plus-empty">'+esc(L.plusPermissionLoading)`),
    'the permission row has its own loading line',
  )
  assert.ok(
    !js.includes(`plus-empty">'+esc(L.draftUploading)`),
    'and no longer borrows the upload copy',
  )
})

// ---------------------------------------------------------------------------
// WP1 (change 2026-10-04-fix-pocket-r1-audit-batch, item 3): the shell has a
// size ceiling. This is an arrival-green guard — it does not fail on the code
// as inherited — so its red state is self-proven by temporarily setting
// ASSET_BUDGET_BYTES below the measured weight and watching it go red (2026-10-04,
// recorded in the change's progress log). Measure with Buffer.byteLength over
// mobilePageAssets({locale}); the historical measurement used to be baked into
// this comment and has since been removed — the assertion message below carries
// the live values on every run. Raise the constant deliberately if the shell
// must grow: the diff of this test is the receipt.
// ---------------------------------------------------------------------------

const ASSET_BUDGET_BYTES = 200_000

test('WP1 the shell assets stay inside the per-locale byte budget', () => {
  for (const locale of ['zh', 'en']) {
    const { css, js } = mobilePageAssets({ locale })
    const cssBytes = Buffer.byteLength(css)
    const jsBytes = Buffer.byteLength(js)
    const total = cssBytes + jsBytes
    assert.ok(
      total <= ASSET_BUDGET_BYTES,
      `${locale} shell assets weigh ${total} B (css ${cssBytes} B + js ${jsBytes} B), over the ${ASSET_BUDGET_BYTES} B budget — raise ASSET_BUDGET_BYTES deliberately if the growth is intended`
    )
  }
})

