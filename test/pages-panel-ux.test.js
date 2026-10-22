// WP-1 pages-panel-ux pins (change 2026-10-05-feat-pocket-mobile-ux-batch):
// the new render surfaces of lib/pages.js at source/render level — the PWA
// manifest, the consent page and the desktop panel's three new sections.
// pages.js is plain ESM and importable under Node without a DOM: renderers
// return strings.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  renderConsentPage,
  renderDesktopPairingPage,
  renderManifestJson,
  renderPairingPinPage,
  renderMobileReconnectPage,
} from '../lib/pages.js'

// ---------------------------------------------------------------------------
// #1a PWA manifest — parseable, and the icon sizes literal matches what the
// /app-icon route serves (the raw appIconPath file, measured 1024x1024 on the
// real machine at apply time). The assertion follows the value: change both
// together if the bundled icon ever changes.
// ---------------------------------------------------------------------------

test('renderManifestJson returns a parseable manifest with the pinned fields', () => {
  const manifest = JSON.parse(renderManifestJson())
  assert.equal(manifest.name, 'DSH Pocket')
  assert.equal(manifest.short_name, 'Pocket')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.display, 'standalone')
  assert.ok(Array.isArray(manifest.icons), 'icons must be an array')
  assert.ok(manifest.icons.length > 0, 'icons must not be empty')
  const icon = manifest.icons[0]
  assert.equal(icon.src, '/app-icon')
  assert.equal(icon.type, 'image/png')
  assert.equal(icon.purpose, 'any')
  assert.match(icon.sizes, /^\d+x\d+$/, 'sizes must be a concrete WxH declaration')
  assert.equal(icon.sizes, '1024x1024', 'sizes must match the measured app-icon; re-measure and change both together')
})

// ---------------------------------------------------------------------------
// #3c consent page — the tunnel-gate card.
// ---------------------------------------------------------------------------

test('renderConsentPage renders the risk checkbox, the submit form and passes next through', () => {
  const zh = renderConsentPage('zh', { next: '/?x=1' })
  assert.match(zh, /公网访问确认/)
  assert.match(zh, /我明白这条链接别人也能打开/)
  assert.match(zh, /<form[^>]*action="\/consent\/accept"/)
  assert.match(zh, /<input type="hidden" name="next" value="\/\?x=1">/)
  assert.match(zh, /type="checkbox"[^>]*required/)
  const en = renderConsentPage('en', { next: '/sessions' })
  assert.match(en, /Public Access Confirmation/)
  assert.match(en, /anyone with this link can open it/)
  assert.match(en, /<input type="hidden" name="next" value="\/sessions">/)
})

test('renderConsentPage escapes the next parameter and ships no inline script', () => {
  const html = renderConsentPage('zh', { next: '/"><script>' })
  assert.ok(!html.includes('"><script>'), 'a hostile next must not survive unescaped')
  assert.match(html, /value="\/&quot;&gt;&lt;script&gt;"/)
  // A plain form POST needs no script, so no CSP nonce carrier exists — script
  // policy on the tunnel gate cannot break this page.
  assert.ok(!html.includes('<script'), 'the consent page is script-free')
})

test('renderConsentPage defaults next to / when omitted', () => {
  const html = renderConsentPage('en')
  assert.match(html, /<input type="hidden" name="next" value="\/">/)
})

// ---------------------------------------------------------------------------
// #4a PIN page — the desktop-confirmation wait (pending pairing state machine).
// ---------------------------------------------------------------------------

test('the PIN page knows the pending-pairing wait: copy keys and the polling organ', () => {
  for (const locale of ['zh', 'en']) {
    const html = renderPairingPinPage(locale, null, {})
    assert.match(html, /"confirmWait":/)
    assert.match(html, /"confirmDenied":/)
    assert.match(html, /\/pair\/pending\?confirmId=/, 'the polling endpoint must be fetched')
    assert.match(html, /awaitPairConfirmation/, 'the shared wait organ must be in the page')
  }
  const zh = renderPairingPinPage('zh', null, {})
  assert.match(zh, /请在电脑上确认接入/)
  assert.match(zh, /桌面端已拒绝接入/)
})

test('the reconnect page shares the pending-pairing wait organ (same /pair/verify contract)', () => {
  for (const locale of ['zh', 'en']) {
    const html = renderMobileReconnectPage(locale, 'tunnel', {})
    assert.match(html, /"confirmWait":/)
    assert.match(html, /"confirmDenied":/)
    assert.match(html, /awaitPairConfirmation/)
  }
})

// ---------------------------------------------------------------------------
// Desktop panel: #2 notification section, #3b named-tunnel section, #4a pending
// pairing cards — all fed by the D2 options contract (notifyConfig /
// tunnelConfig / pendingPairings, verbatim names).
// ---------------------------------------------------------------------------

const baseDesktopOptions = {
  locale: 'zh',
  qrSvg: '<svg></svg>',
  pairingUrl: 'http://127.0.0.1/pair?token=x',
  expiresAt: Date.now() + 60_000,
}

test('the desktop page renders the notification section from the notifyConfig contract', () => {
  const html = renderDesktopPairingPage({
    ...baseDesktopOptions,
    notifyConfig: { channel: 'serverchan', enabled: true, keyMasked: 'SC…a1b2' },
  })
  assert.match(html, /data-action="notify-save"/)
  assert.match(html, /data-action="notify-test"/)
  assert.match(html, /任务通知/)
  assert.match(html, /<option value="serverchan"/, 'the saved channel is one of the options')
  assert.match(html, /<option value="off"/)
  assert.match(html, /<option value="bark"/)
  assert.match(html, /<option value="wxpusher"/)
  assert.match(html, /placeholder="SC…a1b2"/, 'the key is injected as a masked placeholder only')
  assert.match(html, /id="notifyEnabled"[^>]*checked/, 'the enabled flag is pre-checked')
})

test('the desktop page renders the named-tunnel section from the tunnelConfig contract', () => {
  const html = renderDesktopPairingPage({
    ...baseDesktopOptions,
    tunnelConfig: { tokenMasked: 'cf…token', hostname: 'pocket.example.com' },
  })
  assert.match(html, /data-action="tunnel-config-save"/)
  assert.match(html, /固定域名/)
  assert.match(html, /placeholder="cf…token"/, 'the token is injected as a masked placeholder only')
  assert.match(html, /id="tunnelHostname"[^>]*value="pocket\.example\.com"/)
})

test('the desktop page renders pending pairing cards with allow/deny handles', () => {
  const html = renderDesktopPairingPage({
    ...baseDesktopOptions,
    pendingPairings: [
      { id: 'p1', label: 'Pixel 9', remoteAddress: '203.0.113.7', expiresAt: Date.now() + 30_000 },
    ],
  })
  assert.match(html, /待确认接入/)
  assert.match(html, /data-action="pair-approve" data-id="p1"/)
  assert.match(html, /data-action="pair-deny" data-id="p1"/)
  assert.match(html, /Pixel 9/)
  assert.match(html, /203\.0\.113\.7/)
})

test('pending pairing fields are HTML-escaped in the desktop page', () => {
  const html = renderDesktopPairingPage({
    ...baseDesktopOptions,
    pendingPairings: [
      { id: 'x" onmouseover="alert(1)', label: '<b>evil</b>', remoteAddress: '1.2.3.4', expiresAt: Date.now() + 30_000 },
    ],
  })
  assert.ok(!html.includes('<b>evil</b>'), 'the label must be escaped')
  assert.ok(!html.includes('onmouseover="alert(1)"'), 'the id must be escaped')
})

test('the desktop page degrades gracefully without the new options fields', () => {
  // Existing callers (and existing tests) pass none of the three new fields.
  const html = renderDesktopPairingPage({ ...baseDesktopOptions })
  assert.match(html, /data-action="notify-save"/)
  assert.match(html, /data-action="tunnel-config-save"/)
  // The handler source lives in the page script regardless; only the rendered
  // markup before the script must stay card-free.
  const markup = html.slice(0, html.indexOf('<script'))
  assert.ok(!markup.includes('data-action="pair-approve"'), 'no pending card without pendingPairings')
  assert.ok(!markup.includes('id="notifyKey" value='), 'the key input never carries a value')
  assert.ok(!markup.includes('id="tunnelToken" value='), 'the token input never carries a value')
})

test('the new panel i18n keys exist in both locales side by side', () => {
  const zh = renderDesktopPairingPage({ ...baseDesktopOptions, locale: 'zh' })
  const en = renderDesktopPairingPage({ ...baseDesktopOptions, locale: 'en' })
  for (const key of [
    'notifyHeading',
    'notifyChannelLabel',
    'notifyChannelOff',
    'notifyKeyLabel',
    'notifyEnabled',
    'notifySave',
    'notifyTest',
    'notifySaved',
    'notifyTestSent',
    'notifyTestFailed',
    'notifySaveFailed',
    'tunnelConfigHeading',
    'tunnelTokenLabel',
    'tunnelHostnameLabel',
    'tunnelConfigSaved',
    'tunnelConfigFailed',
    'pairRequest',
    'pairAllow',
    'pairDeny',
    'revoke',
    'revokeConfirm',
    'revokeArmed',
  ]) {
    assert.match(zh, new RegExp(`"${key}":`), `${key} must exist in the zh text table`)
    assert.match(en, new RegExp(`"${key}":`), `${key} must exist in the en text table`)
  }
  assert.match(zh, /允许/)
  assert.match(en, /Allow/)
  assert.match(zh, /吊销/)
  assert.match(en, /Revoke/)
})

// ---------------------------------------------------------------------------
// 「进页面就把内容预先加载好」 (2026-10-10). The phone lands on a connection page
// (PIN or reconnect) and then waits. Everything that can start without the
// PIN must start at page load instead, and the reads that cannot must go out
// together rather than one tunnel round trip at a time.
// ---------------------------------------------------------------------------

test('both connection pages warm the shell the moment they load', () => {
  const pin = renderPairingPinPage('zh', null)
  const reconnect = renderMobileReconnectPage('zh', 'tunnel')
  for (const [name, html] of [['pairing', pin], ['reconnect', reconnect]]) {
    assert.match(html, /const shellReady=\(async\(\)=>/, `${name} starts the shell download at page level`)
    assert.ok(!html.includes('const prefetch='), `${name} no longer defers the warm-up into the handoff`)
    assert.match(html, /Promise\.all\(\[shellReady/, `${name} waits on that page-level warm-up, not a second copy`)
  }
})

test('the handoff reads go out in one batch, and the ladder only ever climbs', () => {
  const pin = renderPairingPinPage('zh', null)
  const reconnect = renderMobileReconnectPage('zh', 'tunnel')
  // workspace + session list + boot are independent, and the bridge dedupes the
  // catalogue itself: three serial round trips become one. They are built up front
  // (the backend starts loading them all at once — user 2026-10-21: "后端肯定是
  // 提前加载"), then awaited row by row so the ladder walks one row at a time and a
  // row's number is opened the instant the ladder enters it (2026-10-22).
  for (const [name, html] of [['pairing', pin], ['reconnect', reconnect]]) {
    assert.match(html, /const reads=\[\s*withRetry\(\(\)=>rpc\('workspace\.list'\)\)/, `${name} builds all three reads up front`)
    assert.match(html, /reads\.forEach\(p=>p\.catch\(\(\)=>\{\}\)\)/, `${name} disarms the not-yet-awaited legs`)
    assert.match(html, /await stage\(\d,\s*\(\)=>reads\[\d\]\)/, `${name} walks the rows in order`)
    assert.match(html, /const openRow=\(n\)=>\{setStep\(n\);releaseCount\(n\)\};/, `${name} opens a row's number as the ladder enters it`)
    assert.match(html, /const stage=stageRunner\(openRow\);/, `${name} the runner drives the rows through openRow`)
    assert.match(html, /gateLadder\(\)/, `${name} opens the count gate before the reads go out`)
  }
  // Rows are awaited in index order, so a late answer can never light a later row
  // first; the runner still only advances, which is what keeps the ladder monotone.
  for (const [name, html] of [['pairing', pin], ['reconnect', reconnect]]) {
    assert.match(html, /if\(index\+1>high\)\{high=index\+1;setStep\(index\+1\)\}/, `${name} stageRunner only advances`)
  }
  const source = readFileSync(new URL('../lib/pages.js', import.meta.url), 'utf8')
  assert.equal(source.split('const stageRunner=(setStep)=>{').length - 1, 1, 'one copy of the stage runner, shared')
})

// ---------------------------------------------------------------------------
// 「点进去就要生成网络连接」（用户 2026-10-10）：开机自启被明确否决，但打开配对页这个
// 动作本身就是意图——所以页面加载即自己起公网隧道，不必再点第二次。
// ---------------------------------------------------------------------------

test('opening the pairing page generates the public link by itself', () => {
  const fresh = renderDesktopPairingPage({ locale: 'zh', pairingUrl: 'http://127.0.0.1:1/pair?token=x', pairingPin: '12345678' })
  const taken = renderDesktopPairingPage({ locale: 'zh', pairingUrl: 'https://x', pairingPin: '12345678', tunnelActive: true, connected: true })
  const guard = 'if(!phoneConnected&&selectedTunnelTab&&!tunnelActive)void switchMode(true);'
  assert.ok(fresh.includes(guard), 'the page starts the tunnel on load')
  assert.ok(fresh.indexOf(guard) < fresh.indexOf('setInterval(poll,2000)'), 'it fires before the first status poll, not after it')
  assert.match(fresh, /tunnelActive=false/, 'a fresh pairing page renders with the tunnel down…')
  // phoneConnected is interpolated raw, so "no phone yet" is `undefined` — falsy, which
  // is what the guard reads; a real pairing pins it to true (the `taken` render below).
  assert.match(fresh, /phoneConnected=(undefined|false)/, '…and with no phone on it, which is exactly when it must fire')
  assert.ok(taken.includes(guard), 'the same guard ships in every render — the runtime flags decide')
  assert.match(taken, /tunnelActive=true/, 'with the tunnel up there is nothing to start…')
  assert.match(taken, /phoneConnected=true/, '…and a paired phone stops it dead either way')
})
