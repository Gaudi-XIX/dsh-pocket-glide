// WP-PAGES-B B-9 输入加固断言（change 2026-10-02-fix-pocket-audit-remediation）。
//
// The pairing page is assembled by string concatenation, so every option that
// reaches it is stringified by escapeHtml(). That helper used to be
// `value.replace(...)` — a number, an object or undefined handed over by the bridge
// threw a TypeError inside the renderer, so the whole desktop page came back as an
// error instead of a pairing screen. These tests drive the REAL renderer with the
// hostile shapes the bridge can actually produce.
//
// The render is the regression: against the old escapeHtml every case below throws,
// so nothing here needs a new export.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderDesktopPairingPage } from '../lib/pages.js'

function pairingOptions(overrides = {}) {
  return {
    locale: 'zh',
    nonce: 'ab12cd34',
    pinConsent: false,
    pinExpiresAt: 0,
    connectedDevices: [],
    connected: false,
    tunnelActive: false,
    tunnelError: null,
    qrSvg: '<svg role="img"></svg>',
    tunnelLoading: false,
    pairingUrl: '',
    pairingPin: '',
    expiresAt: 0,
    tunnelProvider: '',
    ...overrides,
  }
}

function render(overrides, label) {
  let html
  assert.doesNotThrow(() => {
    html = renderDesktopPairingPage(pairingOptions(overrides))
  }, `the pairing page must still render with ${label}`)
  return html
}

test('B-9 the pairing page renders its ordinary shape', () => {
  const html = render({}, 'its ordinary options')
  assert.ok(html.length > 1000, 'and it is the real page, not an error body')
  assert.ok(html.includes('pairing-content'), 'the pairing area is still there')
})

test('B-9 a non-string pairing URL is stringified instead of throwing', () => {
  const html = render({ pairingUrl: 12345 }, 'a numeric pairing URL')
  assert.ok(html.includes('12345'), 'the value still reaches the page, as text')
  assert.ok(!html.includes('undefined'), 'and nothing stringifies to "undefined" on the way')
})

test('B-9 a non-string PIN is stringified instead of throwing', () => {
  const html = render({ pairingPin: 123456 }, 'a numeric PIN')
  assert.ok(html.includes('123456'))
})

test('B-9 a non-string tunnel error is escaped instead of throwing', () => {
  const html = render({ tunnelActive: true, tunnelError: { code: 1 } }, 'an object tunnel error')
  assert.ok(html.includes('[object Object]'), 'an unexpected shape is shown as text, never as markup')
  assert.ok(!html.includes('<object'), 'and it must not be able to open a tag')
})

test('B-9 a device card with hostile fields renders', () => {
  // The old connected-devices row is gone (2026-10-08 §10.4 R-2); the hostile
  // device shapes the bridge can produce now land in the new panel card
  // renderer deviceCardHtml — pinned here with the same intent as before.
  const source = readFileSync(new URL('../lib/pages.js', import.meta.url), 'utf8')
  const extract = (name) => {
    const start = source.indexOf(`function ${name}(`)
    assert.notEqual(start, -1, `${name} must exist in the pages.js source`)
    let depth = 0
    for (let i = start; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') {
        depth--
        if (depth === 0) return source.slice(start, i + 1)
      }
    }
    throw new Error(`unbalanced braces after ${name}`)
  }
  const names = ['deviceState', 'devicePermBadge', 'devicePermLabel', 'deviceCredLabel', 'deviceFirstSeen', 'deviceLastSeen', 'deviceCardHtml']
  const body = names.map(extract).join('\n')
  const T = {
    devOnline: '在线', devOffline: '离线', devPermLan: '仅本地', devPermWan: '本地+公网',
    devMakeLan: '仅本地', devMakeWan: '本地+公网', devCredExpired: '{d}（已过期）',
    devFingerprint: '指纹', devFirstPaired: '首次配对', devCredExpiry: '凭证到期',
    devLastSeen: '最后上线', devNeverSeen: '从未', devPermBadge: '通道权限：{v}',
    devExtend: '延长30天', revoke: '吊销',
  }
  const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const formatTimestamp = (v) => {
    const d = new Date(v); const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  const deviceCardHtml = new Function('T', 'escHtml', 'formatTimestamp', `${body}\nreturn deviceCardHtml`)(T, escHtml, formatTimestamp)
  const card = deviceCardHtml({ label: 7, remoteAddress: undefined, expiresAt: Date.now(), permission: 'lan', online: true })
  assert.ok(card.includes('>7<'), 'the numeric label still reaches the card name')
  assert.ok(!card.includes('undefined'), 'a missing address must not print the word undefined')
})

test('B-9 a missing QR payload does not take the page down', () => {
  assert.ok(render({ qrSvg: null }, 'a null QR payload').includes('pairing-content'))
  assert.ok(render({ qrSvg: 0 }, 'a numeric QR payload').includes('pairing-content'))
})

test('B-9 the escaping still holds for markup that arrives in the address line', () => {
  // tunnelActive: with the public tab pending there is no address to print at all
  // (pinned by the next test), so this arm has to render the live one.
  const html = render({ pairingUrl: '<script>alert(1)</script>', tunnelActive: true }, 'markup in the address line')
  assert.ok(html.includes('&lt;script&gt;'), 'the address is escaped on the way in')
  assert.ok(!html.includes('<script>alert'), 'so it cannot become a real script tag in the page')
})

test('B-9b the public tab with no tunnel yet shows neither a QR nor a LAN address', () => {
  // Landing on 公网 by default must not present the LAN URL as if it were the
  // public link (2026-10-10): no tunnel, nothing to encode.
  const html = render({ pairingUrl: 'http://192.168.1.5:43127/pair?token=abc', tunnelActive: false }, 'tunnel down')
  const address = html.match(/<div class="url([^"]*)" id="url">([^<]*)</)
  assert.ok(address, 'the address line is still rendered')
  assert.match(address[1], /is-pending/, 'and says it is pending')
  assert.ok(!address[2].includes('192.168.1.5'), 'the LAN address is not printed in it')
  assert.ok(/id="qrCode"[^>]*><\/div>/.test(html), 'the QR box is empty until the tunnel is online')
})
