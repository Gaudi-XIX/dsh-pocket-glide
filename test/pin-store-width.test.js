// WP-SEC-BRIDGE B1 / M8 — the durable-password store across a width change.
// The width of the generated password is a constant (PAIRING_PIN_DIGITS) and
// the mobile field has to move with it; what must never happen on either side
// of that move is a paired phone finding its own saved password rejected, or an
// auto-expiry smuggled in behind the strength work (design §12 禁令 3).
// All of it runs against a temp file: the real
// %LOCALAPPDATA%\dsh-pocket\mobile-pairing-pin.json is never touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

// ---------------------------------------------------------------------------
// RA-2 (rescan-auth): a failed rename must not destroy the stored password.
//
// The previous build removed the destination *before* the rename, so any
// transient rename failure (on Windows the destination is briefly held open by
// a scanner or the indexer, which surfaces as EPERM) left no password on disk
// at all — every already-paired phone was then asked for a brand-new PIN.
//
// `node:fs` cannot be stubbed here: `pin-store.js` imports `renameSync` as an
// ESM named binding, and patching the `node:fs` module object is invisible to
// it (measured: the module still made the real call). So the failure has to be
// a real filesystem condition. Holding an open handle on the destination is
// the deterministic one: rename then throws EPERM and the destination content
// survives.
// ---------------------------------------------------------------------------

test('a failed rename leaves the stored password untouched and reports false', () => {
  const durable = join(dir, 'durable-pin.json')
  writeFileSync(durable, JSON.stringify({ pin: '135790', pinConsent: true }))
  const holder = openSync(durable, 'r')
  try {
    assert.equal(
      writePairingPinState(durable, { pin: '246801', pinConsent: true }),
      false,
      'a rename that cannot land is a failed write, not a successful one'
    )
    assert.deepEqual(
      JSON.parse(readFileSync(durable, 'utf8')),
      { pin: '135790', pinConsent: true },
      'the previously stored password is still there'
    )
    assert.equal(readPairingPinState(durable).pin, '135790', 'and it still loads')
  } finally {
    closeSync(holder)
  }
  // The moment the destination is no longer held open the same write lands,
  // so the failure above was the rename and not a broken store.
  assert.equal(writePairingPinState(durable, { pin: '246801', pinConsent: true }), true)
  assert.equal(readPairingPinState(durable).pin, '246801')
})

test('the write documents where 0600 actually holds', () => {
  // RA-6 (rescan-auth): `{ mode: 0o600 }` is a no-op on Windows — the file
  // lands 0666 and the real protection is the directory ACL. The doc comment
  // must not keep claiming an unconditional 0600.
  const source = readFileSync(new URL('../lib/pin-store.js', import.meta.url), 'utf8')
  const start = source.indexOf('Atomically write the PIN state')
  const end = source.indexOf('export function writePairingPinState')
  assert.ok(start !== -1 && end > start, 'the write function carries a doc comment')
  const doc = source.slice(start, end)
  assert.match(doc, /POSIX/i, 'the doc names the platform where 0600 is enforced')
  assert.match(doc, /Windows/i, 'and the platform where it is not')
  assert.match(doc, /ACL/i, 'and what actually protects the file there')
})

test('a write leaves no temporary file behind, successful or not', () => {
  const scratch = join(dir, 'scratch-pin.json')
  writeFileSync(scratch, JSON.stringify({ pin: '111222', pinConsent: true }))
  const holder = openSync(scratch, 'r')
  try {
    assert.equal(writePairingPinState(scratch, { pin: '333444', pinConsent: true }), false)
  } finally {
    closeSync(holder)
  }
  assert.equal(writePairingPinState(scratch, { pin: '333444', pinConsent: true }), true)
  const leftovers = readdirSync(dir).filter((name) => name.startsWith('scratch-pin.json.') && name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], 'no temporary file survives either path')
})
