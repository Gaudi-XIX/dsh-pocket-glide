// Test-anchor hardening for the R1 audit report items P-3 and P-4, landed by
// change 2026-10-07-fix-pocket-r1-reflux-batch (sixth audit report, 2026-10-05).
//
// P-3 pins the LAN plaintext-HTTP warning on both surfaces that ship it (the
// mobile reconnect page and the desktop pairing page), zh and en. The copy is
// the user's only signal that LAN mode is not encrypted, so a rewording that
// drops the phrase must fail here instead of silently leaving phones (and the
// desktop operator) unaware.
//
// P-4 pins the tar extraction call literal in lib/tunnel.js: `windowsHide`
// keeps an archive-extraction console window from flashing on Windows while
// the cloudflared asset is unpacked. The lock is deliberately loose — one
// line, option presence only — so adjacent argument changes (timeout, flags)
// do not break the anchor.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderMobileReconnectPage, renderDesktopPairingPage } from '../lib/pages.js'

test('P-3 the LAN plaintext warning ships on both surfaces in both locales', () => {
  const cases = [
    ['zh', '局域网模式采用明文 HTTP 传输'],
    ['en', 'LAN mode uses plaintext HTTP'],
  ]
  for (const [locale, phrase] of cases) {
    const reconnect = renderMobileReconnectPage(locale, 'lan')
    assert.ok(reconnect.includes(phrase), `the reconnect page (${locale}) must carry "${phrase}"`)
    const pairing = renderDesktopPairingPage({ locale, pairingUrl: 'http://127.0.0.1/pair?token=x', pairingPin: '123456' })
    assert.ok(pairing.includes(phrase), `the pairing page (${locale}) must carry "${phrase}"`)
  }
})

test("P-4 the cloudflared tar extraction hides its console window on Windows", () => {
  const source = readFileSync(new URL('../lib/tunnel.js', import.meta.url), 'utf8')
  const line = source.split('\n').find((candidate) => candidate.includes("execFile('tar'"))
  assert.ok(line, "an execFile('tar' call must exist in lib/tunnel.js")
  assert.ok(line.includes('windowsHide: true'), 'the tar call must pass windowsHide: true')
})
