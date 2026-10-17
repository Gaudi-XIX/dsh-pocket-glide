// The pairing password is six digits (2026-10-10: narrowed from eight, which
// users kept mistyping). What makes that safe is the phone field: it has to
// accept the whole compatible range that the
// persistence gate accepts (PAIRING_PIN_MIN_DIGITS..PAIRING_PIN_MAX_DIGITS),
// not exactly the width being issued today. A field narrowed to the issued
// width locks out every phone holding a durable password of the old width, so
// these tests pin the range from both ends instead of pinning the width.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  PAIRING_PIN_DIGITS,
  PAIRING_PIN_MAX_DIGITS,
  PAIRING_PIN_MIN_DIGITS,
  PAIRING_PIN_PATTERN,
  PAIRING_PIN_SPACE,
} from '../lib/constants.js'
import { renderDesktopPairingPage, renderMobileReconnectPage, renderPairingPinPage } from '../lib/pages.js'

const SOURCE = readFileSync(new URL('../lib/pages.js', import.meta.url), 'utf8')

// Inside the page template literal the pattern is written with an escaped
// backslash, so the string that lands in the HTML carries a single one.
const COMPATIBLE = `\\d{${PAIRING_PIN_MIN_DIGITS},${PAIRING_PIN_MAX_DIGITS}}`

function pinInput(html) {
  const element = html.match(/<input id="pin"[^>]*>/)
  assert.ok(element, 'a pairing page has to render the pairing input')
  const maxlength = element[0].match(/maxlength="(\d+)"/)
  const pattern = element[0].match(/pattern="([^"]*)"/)
  assert.ok(maxlength, 'the pairing input has to bound its length')
  assert.ok(pattern, 'the pairing input has to constrain its characters')
  return {
    maxlength: Number(maxlength[1]),
    pattern: pattern[1],
    accepts: (value) => new RegExp(`^(?:${pattern[1]})$`).test(value),
  }
}

const RECONNECT_ZH = renderMobileReconnectPage('zh', 'lan', {})
const RECONNECT_EN = renderMobileReconnectPage('en', 'tunnel', {})
const PIN_PAGE_ZH = renderPairingPinPage('zh', null)
const PIN_PAGE_EN = renderPairingPinPage('en', null)

const PAGES = [
  ['reconnect zh', RECONNECT_ZH],
  ['reconnect en', RECONNECT_EN],
  ['pin page zh', PIN_PAGE_ZH],
  ['pin page en', PIN_PAGE_EN],
]

test('the issued password is six digits', () => {
  // Deliberately a literal: this is the audit item, not a derivation.
  assert.equal(PAIRING_PIN_DIGITS, 6)
  assert.equal(PAIRING_PIN_SPACE, 10 ** PAIRING_PIN_DIGITS)
  assert.equal(PAIRING_PIN_SPACE - 1, 999999)
})

test('the issued width sits inside the range the field and the gate share', () => {
  assert.ok(
    PAIRING_PIN_DIGITS >= PAIRING_PIN_MIN_DIGITS && PAIRING_PIN_DIGITS <= PAIRING_PIN_MAX_DIGITS,
    `PAIRING_PIN_DIGITS=${PAIRING_PIN_DIGITS} must sit in ${PAIRING_PIN_MIN_DIGITS}..${PAIRING_PIN_MAX_DIGITS}`,
  )
  // The widest value the generator can draw still fits the field's length cap.
  assert.equal(String(PAIRING_PIN_SPACE - 1).length, PAIRING_PIN_DIGITS)
})

test('both pages accept every width a stored password can have', () => {
  for (const [name, html] of PAGES) {
    const field = pinInput(html)
    assert.equal(field.pattern, COMPATIBLE, `${name} constrains the password to the compatible range`)
    assert.ok(
      field.maxlength >= PAIRING_PIN_MAX_DIGITS,
      `${name} admits up to ${PAIRING_PIN_MAX_DIGITS} characters, found ${field.maxlength}`,
    )
    for (let width = PAIRING_PIN_MIN_DIGITS; width <= PAIRING_PIN_MAX_DIGITS; width += 1) {
      assert.ok(field.accepts('7'.repeat(width)), `${name} accepts a ${width}-digit password`)
    }
    assert.ok(!field.accepts('7'.repeat(PAIRING_PIN_MIN_DIGITS - 1)), `${name} refuses a too-short password`)
    assert.ok(!field.accepts('7'.repeat(PAIRING_PIN_MAX_DIGITS + 1)), `${name} refuses a too-long password`)
    assert.ok(!field.accepts('12345a'), `${name} refuses a non-numeric password`)
  }
})

test('the field is not narrowed to the width being issued', () => {
  const narrowed = `\\d{${PAIRING_PIN_DIGITS}}`
  for (const [name, html] of PAGES) {
    const field = pinInput(html)
    assert.notEqual(field.pattern, narrowed, `${name} must not demand exactly ${PAIRING_PIN_DIGITS} digits`)
    assert.notEqual(field.maxlength, PAIRING_PIN_DIGITS, `${name} must not cap at exactly ${PAIRING_PIN_DIGITS} characters`)
  }
  // The regression this guards: a phone typing a durable eight-digit password
  // issued by the previous width must still get through the field. The room for
  // it is the ceiling, not the floor — the floor sits at the issued width
  // because no build ever issued anything narrower.
  assert.equal(PAIRING_PIN_MAX_DIGITS > PAIRING_PIN_DIGITS, true)
  const field = pinInput(PAGES[0][1])
  assert.ok(field.accepts('123456'), 'a freshly issued six-digit password has to be typeable')
  assert.ok(field.accepts('12345678'), 'a stored eight-digit password from the old width still has to be typeable')
  assert.ok(!field.accepts('1234567890123'), 'a thirteen-digit value is out of range on both sides')
})

test('the field and the persistence gate describe the same range', () => {
  const gate = new RegExp(`^${COMPATIBLE}$`)
  assert.equal(gate.source, PAIRING_PIN_PATTERN.source)
  for (const sample of ['12345', '123456', '1234567', '12345678', '1'.repeat(12), '1'.repeat(13), 'abcdef12']) {
    assert.equal(gate.test(sample), PAIRING_PIN_PATTERN.test(sample), `${sample} is judged the same on both sides`)
  }
})

test('the pages do not spell the password width out', () => {
  assert.equal(RECONNECT_ZH.includes('显示的 6 位密码'), false)
  assert.equal(RECONNECT_EN.includes('the 6-digit password'), false)
  assert.equal(PIN_PAGE_ZH.includes('查看 6 位密码'), false)
  assert.equal(PIN_PAGE_EN.includes('the 6-digit password'), false)
  // The wording still has to tell the user where the password is.
  assert.ok(RECONNECT_ZH.includes('显示的密码即可继续'))
  assert.ok(RECONNECT_EN.includes('Enter the password shown in Pocket'))
  assert.ok(PIN_PAGE_ZH.includes('Pocket 窗口'))
  assert.ok(PIN_PAGE_EN.includes('Find the password in the Pocket window'))
})

test('the desktop panel shows a password as long as the one it issues', () => {
  const issued = '9'.repeat(PAIRING_PIN_DIGITS)
  const html = renderDesktopPairingPage({ locale: 'zh', pairingUrl: 'https://pocket.example.test', pairingPin: issued })
  const shown = html.match(/<div id="pinValue"[^>]*>([^<]*)<\/div>/)
  assert.ok(shown, 'the pairing panel has to render the password')
  assert.equal(shown[1], issued)
})

test('the widened field is the only form in the source', () => {
  const widenedLength = `maxlength="${PAIRING_PIN_MAX_DIGITS}"`
  const widenedPattern = `pattern="\\\\d{${PAIRING_PIN_MIN_DIGITS},${PAIRING_PIN_MAX_DIGITS}}"`
  assert.equal(SOURCE.split(widenedLength).length - 1, 2, 'exactly the two pairing inputs carry the length cap')
  assert.equal(SOURCE.split(widenedPattern).length - 1, 2, 'exactly the two pairing inputs carry the range')
  assert.equal(SOURCE.includes(`maxlength="${PAIRING_PIN_DIGITS}"`), false)
  assert.equal(SOURCE.includes(`pattern="\\\\d{${PAIRING_PIN_DIGITS}}"`), false)
  assert.equal(SOURCE.includes('6 位密码'), false)
  assert.equal(SOURCE.includes('6-digit password'), false)
})
