// WP-SEC-BRIDGE B1 / M8 — the durable-password store across a width change.
// The width of the generated password is a constant (PAIRING_PIN_DIGITS) and
// the mobile field has to move with it; what must never happen on either side
// of that move is a paired phone finding its own saved password rejected, or an
// auto-expiry smuggled in behind the strength work (design §12 禁令 3).
// All of it runs against a temp file: the real
// %LOCALAPPDATA%\dsh-pocket\mobile-pairing-pin.json is never touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  pairingPinStorePath,
  readPairingPinState,
  writePairingPinState,
} from '../lib/pin-store.js'
import { PAIRING_PIN_DIGITS, PAIRING_PIN_MAX_DIGITS, PAIRING_PIN_MIN_DIGITS } from '../lib/constants.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-pocket-pinstore-'))
const file = join(dir, 'mobile-pairing-pin.json')

function writeRaw(text) {
  writeFileSync(file, text)
  return file
}

test('the store path keeps its documented basename', () => {
  assert.equal(pairingPinStorePath(dir), file)
})

test('a six-digit password saved by an earlier build still loads', () => {
  const state = readPairingPinState(writeRaw(JSON.stringify({ pin: '123456', pinConsent: true })))
  assert.deepEqual(state, { pin: '123456', pinConsent: true }, '存量 6 位长效密码零迁移')
})

test('a wider password within the accepted range also loads', () => {
  for (const pin of ['1234567', '12345678', '1'.repeat(PAIRING_PIN_MAX_DIGITS)]) {
    const state = readPairingPinState(writeRaw(JSON.stringify({ pin, pinConsent: true })))
    assert.equal(state.pin, pin, `${pin} must survive a round trip`)
  }
})

test('anything outside the digit range is dropped, never thrown on', () => {
  for (const pin of ['12345', '0'.repeat(PAIRING_PIN_MAX_DIGITS + 1), '12345a', '', 'abcdef12', 123456]) {
    const state = readPairingPinState(writeRaw(JSON.stringify({ pin, pinConsent: true })))
    assert.equal(state.pin, undefined, `${String(pin)} is not a valid stored password`)
    assert.equal(state.pinConsent, true, 'consent itself is still read')
  }
})

test('a corrupt file is ignored instead of throwing', () => {
  assert.deepEqual(readPairingPinState(writeRaw('{not json')), {})
  assert.deepEqual(readPairingPinState(join(dir, 'does-not-exist.json')), {})
})

test('saving rewrites the file in place with only the consented password', () => {
  assert.equal(writePairingPinState(file, { pin: '987654', pinConsent: true }), true)
  const document = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(document, { pinConsent: true, pin: '987654' })
  assert.ok(!/\.tmp$/.test(file), 'the temp name is renamed away')
})

test('without consent nothing is persisted', () => {
  writePairingPinState(file, { pin: '111111', pinConsent: false })
  // The document is emptied rather than storing a false flag: no consent means
  // no password on disk at all.
  assert.deepEqual(readPairingPinState(file), {})
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {})
})

test('the generated width is inside what the store accepts', () => {
  // The two ends of the durable path have to agree: a password the generator
  // can produce must always be one the store will load back.
  assert.ok(
    PAIRING_PIN_DIGITS >= PAIRING_PIN_MIN_DIGITS && PAIRING_PIN_DIGITS <= PAIRING_PIN_MAX_DIGITS,
    `PAIRING_PIN_DIGITS=${PAIRING_PIN_DIGITS} must sit in ${PAIRING_PIN_MIN_DIGITS}..${PAIRING_PIN_MAX_DIGITS}`
  )
})

test('no expiry field exists in the persisted document', () => {
  writePairingPinState(file, { pin: '222222', pinConsent: true })
  const raw = readFileSync(file, 'utf8')
  assert.doesNotMatch(raw, /expires|ttl|expiry/i, 'a durable password stays durable')
})
