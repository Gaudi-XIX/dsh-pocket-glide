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

test('B-9 a device row with hostile fields renders', () => {
  const html = render(
    { connectedDevices: [{ label: 7, remoteAddress: undefined, expiresAt: Date.now() }] },
    'a numeric label and a missing address',
  )
  assert.ok(html.includes('7 ·'), 'the numeric label still reaches the row')
  assert.ok(!html.includes('undefined'), 'and a missing address must not print the word undefined')
})

test('B-9 a missing QR payload does not take the page down', () => {
  assert.ok(render({ qrSvg: null }, 'a null QR payload').includes('pairing-content'))
  assert.ok(render({ qrSvg: 0 }, 'a numeric QR payload').includes('pairing-content'))
})

test('B-9 the escaping still holds for markup that arrives in an option', () => {
  const html = render({ pairingUrl: '<script>alert(1)</script>' }, 'markup in an option')
  assert.ok(html.includes('&lt;script&gt;'), 'the option is escaped on the way in')
  assert.ok(!html.includes('<script>alert'), 'so it cannot become a real script tag in the page')
})
