// Every inline <script> the bridge serves must carry the per-request nonce once
// the CSP drops script-src 'unsafe-inline'. An omitted nonce must leave the
// output byte-identical to the pre-nonce markup.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  renderMobilePage,
  renderDesktopPairingPage,
  renderPairingPinPage,
  renderMobileReconnectPage,
  renderServiceWorker,
  mobilePageAssets
} from '../lib/pages.js'

const nonce = 'cDJzLW5vbmNlXzAxMjM0NTY3ODk'
const boot = JSON.stringify({ ws: { items: [] }, sess: { items: [] } })

const openingScriptTags = (html) => [...html.matchAll(/<script(?:\s[^>]*)?>/g)].map((match) => match[0])

test('mobile page with a nonce tags every inline script', () => {
  const html = renderMobilePage({ locale: 'zh', boot, initialChat: true, nonce })
  const tags = openingScriptTags(html)

  assert.equal(tags.length, 2, 'boot payload + app script')
  for (const tag of tags) {
    assert.match(tag, new RegExp(` nonce="${nonce}"`), `${tag} carries the nonce`)
  }
})

test('split mobile page keeps extraction working and nonces the bootstrap', () => {
  const html = renderMobilePage({
    locale: 'zh',
    boot,
    initialChat: true,
    nonce,
    assets: { cssUrl: '/app.css?h=deadbeef', jsUrl: '/app.js?l=zh&h=deadbeef' }
  })

  assert.match(html, /<script src="\/app\.js\?l=zh&h=deadbeef"><\/script>/, 'the external tag stays as-is')
  assert.match(html, new RegExp(`<script nonce="${nonce}">\\(function\\(\\)\\{`), 'the bootstrap is nonced')
  assert.match(html, new RegExp(`<script nonce="${nonce}">window\\.__POCKET_BOOT__=`), 'the boot payload is nonced')
  assert.doesNotMatch(html, /<style>/, 'the split still removes the inline style block')
  assert.equal((html.match(/nonce/g) ?? []).length, 2, 'boot payload + bootstrap only')
})

test('mobile assets stay nonce-free', () => {
  const assets = mobilePageAssets({ locale: 'zh' })
  assert.doesNotMatch(assets.js, /nonce/)
  assert.doesNotMatch(assets.css, /nonce/)
})

test('desktop pairing page with a nonce tags its polling script', () => {
  const options = { locale: 'en', pairingUrl: 'http://127.0.0.1/pair?token=x', qrSvg: '', nonce }
  const html = renderDesktopPairingPage(options)
  const tags = openingScriptTags(html)

  assert.equal(tags.length, 1)
  assert.match(tags[0], new RegExp(` nonce="${nonce}"`))
})

test('pairing pin page with a nonce tags its boot-stage script', () => {
  const html = renderPairingPinPage('zh', null, { nonce })
  const tags = openingScriptTags(html)

  assert.equal(tags.length, 1)
  assert.match(tags[0], new RegExp(` nonce="${nonce}"`))
})

test('interactive reconnect page with a nonce tags its guided-flow script', () => {
  const html = renderMobileReconnectPage('zh', 'lan', { nonce })
  const tags = openingScriptTags(html)

  assert.equal(tags.length, 1)
  assert.match(tags[0], new RegExp(` nonce="${nonce}"`))
})

test('terminal reconnect variants stay script-free', () => {
  for (const options of [{ expired: true }, { resumeUnavailable: true }]) {
    const html = renderMobileReconnectPage('zh', 'lan', { ...options, nonce })
    assert.doesNotMatch(html, /<script/, JSON.stringify(options))
    assert.doesNotMatch(html, /nonce/, JSON.stringify(options))
  }
})

test('interactive reconnect page renders the guided restore flow', () => {
  const assets = { cssUrl: '/app.css?h=deadbeef', jsUrl: '/app.js?l=zh&h=deadbeef' }
  const html = renderMobileReconnectPage('en', 'lan', { nonce, assets })

  assert.match(html, /id="retryBtn"[^>]*data-action="retry"/, 'manual retry button exists')
  assert.match(html, /if\(MODE==='auto'\)startRetry\(\);/, 'reconnection auto-starts on load')
  assert.match(html, /fetch\('\/pair\/retry'/, 'calls the restore endpoint')
  assert.match(html, /id="pinBox" hidden/, 'PIN branch host is hidden until requested')
  assert.match(html, /<form data-form="pin"/, 'PIN form posts through the guided flow')
  assert.doesNotMatch(html, /\son(click|change|submit)=/, 'no CSP-blocked inline event attributes')
  assert.match(html, /fetch\('\/pair\/verify'/, 'PIN branch verifies through the pairing endpoint')
  assert.match(html, /rpc\('workspace\.list'\)/, 'stage 1 syncs the workspace')
  assert.match(html, /rpc\('session\.list',\{limit:SESSION_LIST_ROWS\}\)/, 'stage 2 syncs 30 sessions')
  assert.match(html, /fetch\('\/api\/boot'/, 'stage 3 fetches the boot payload')
  assert.match(html, /sessionStorage\.setItem\('dsh-pocket-boot'/, 'boot payload is stashed for handoff')
  assert.match(html, /location\.replace\('\/'\)/, 'the flow hands off to the app document')
  assert.match(html, /SHELL_ASSETS=\{"cssUrl":"\/app\.css\?h=deadbeef","jsUrl":"\/app\.js\?l=zh&h=deadbeef"\}/, 'asset URLs are embedded for prefetching')
  assert.match(html, /SESSION_LIST_ROWS=30/, 'session prefetch limit is baked in')
})

test('tunnel reconnect page renders the same guided flow', () => {
  const html = renderMobileReconnectPage('zh', 'tunnel', { nonce })

  assert.match(html, /if\(MODE==='auto'\)startRetry\(\);/)
  assert.match(html, /fetch\('\/pair\/retry'/)
  assert.match(html, /id="pinBox" hidden/)
})

test('PIN pairing page delegates its form and show-pin control', () => {
  const html = renderPairingPinPage('zh', null)

  assert.doesNotMatch(html, /\son(click|change|submit)=/, 'CSP blocks inline event attributes')
  assert.match(html, /<form data-form="pin"/, 'form submit is delegated')
  assert.match(html, /data-action="show-pin"/, 'show-on-desktop control is delegated')
})

test('desktop pairing page delegates every control instead of inline handlers', () => {
  const options = { locale: 'zh', pairingUrl: 'http://127.0.0.1/pair?token=x', qrSvg: '' }
  const html = renderDesktopPairingPage(options)

  assert.doesNotMatch(html, /\son(click|change|submit)=/, 'CSP blocks inline event attributes')
  for (const action of ['mode-lan', 'mode-tunnel', 'disconnect', 'done', 'copy', 'refresh', 'reset', 'consent-off']) {
    assert.match(html, new RegExp(`data-action="${action}"`), `${action} control is delegated`)
  }
  assert.match(html, /data-action="consent"/, 'PIN consent checkbox is delegated')
  assert.match(html, /document\.addEventListener\('click'/, 'click delegation is wired')
  assert.match(html, /document\.addEventListener\('change'/, 'change delegation is wired')
})

test('the nonce is escaped for the attribute', () => {
  const weird = 'a<b>&"\'c'
  const html = renderPairingPinPage('en', null, { nonce: weird })

  assert.ok(!html.includes(weird), 'the raw nonce must not appear')
  assert.match(html, / nonce="a&lt;b&gt;&amp;&quot;&#39;c"/)
})

test('no nonce means byte-identical output for every renderer', () => {
  assert.equal(
    renderMobilePage({ locale: 'zh', boot, initialChat: true }),
    renderMobilePage({ locale: 'zh', boot, initialChat: true, nonce: null })
  )
  assert.equal(
    renderMobileReconnectPage('zh', 'lan'),
    renderMobileReconnectPage('zh', 'lan', { nonce: null })
  )

  const pairingOptions = { locale: 'en', pairingUrl: 'http://127.0.0.1/pair?token=x', qrSvg: '' }
  assert.equal(
    renderDesktopPairingPage(pairingOptions),
    renderDesktopPairingPage({ ...pairingOptions, nonce: null })
  )
  assert.equal(
    renderPairingPinPage('zh', null),
    renderPairingPinPage('zh', null, { nonce: null })
  )

  for (const html of [
    renderMobilePage({ locale: 'zh', boot, initialChat: true }),
    renderDesktopPairingPage(pairingOptions),
    renderPairingPinPage('zh', null),
    renderMobileReconnectPage('zh', 'lan')
  ]) {
    assert.doesNotMatch(html, /nonce/, 'nothing nonce-related leaks when no nonce is passed')
  }
})

test('service worker output carries no nonce', () => {
  assert.doesNotMatch(renderServiceWorker(), /nonce/)
})
