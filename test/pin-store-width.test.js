// WP-SEC-BRIDGE B1 / M8 — the durable-password store across a width change.
// The width of the generated password is a constant (PAIRING_PIN_DIGITS) and
// the mobile field has to move with it; what must never happen on either side
// of that move is a paired phone finding its own saved password rejected, or an
// auto-expiry smuggled in behind the strength work (design §12 禁令 3).
// All of it runs against a temp file: the real
// %LOCALAPPDATA%\dsh-pocket-glide\mobile-pairing-pin.json is never touched.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  pairingPinDigest,
  pairingPinStorePath,
  readPairingPinState,
  verifyPairingPin,
  writePairingPinState,
} from '../lib/pin-store.js'
import { LanMobileBridge } from '../lib/bridge.js'
import { PAIRING_PIN_DIGITS, PAIRING_PIN_MAX_DIGITS, PAIRING_PIN_MIN_DIGITS } from '../lib/constants.js'

// A bridge whose only store is the record handed in — the question these tests
// ask is what the *verifier* does with a record, not what the file holds.
function pinBridge(record) {
  return new LanMobileBridge({
    harnessUrl: () => 'http://127.0.0.1:9',
    innerAuth: { ready: async () => undefined, invalidate: () => {} },
    pairingPinStore: { load: () => record, save: () => true },
    now: () => 10_000_000_000_000,
  })
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-pocket-glide-pinstore-'))
const file = join(dir, 'mobile-pairing-pin.json')

// 这只目录是模块级的（下面每一档都用它），所以回收只能挂在文件级钩子上。
// 以前没有钩子，每跑一轮全量测试就在 %TEMP% 留一个。
after(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })
})

function writeRaw(text) {
  writeFileSync(file, text)
  return file
}

test('the store path keeps its documented basename', () => {
  assert.equal(pairingPinStorePath(dir), file)
})

test('a six-digit password saved by an earlier build still loads', () => {
  const state = readPairingPinState(writeRaw(JSON.stringify({ pin: '123456', pinConsent: true })))
  // D-P1-2: a pre-digest file is read as a legacy record — the digits are handed
  // back in memory, flagged, and never written again.
  assert.deepEqual(state, { live: '123456', legacy: true, pinConsent: true }, '存量 6 位长效密码零迁移')
})

test('a wider password within the accepted range also loads', () => {
  for (const pin of ['1234567', '12345678', '1'.repeat(PAIRING_PIN_MAX_DIGITS)]) {
    const state = readPairingPinState(writeRaw(JSON.stringify({ pin, pinConsent: true })))
    assert.equal(state.live, pin, `${pin} must survive a round trip`)
  }
})

test('anything outside the digit range is dropped, never thrown on', () => {
  for (const pin of ['12345', '0'.repeat(PAIRING_PIN_MAX_DIGITS + 1), '12345a', '', 'abcdef12', 123456]) {
    const state = readPairingPinState(writeRaw(JSON.stringify({ pin, pinConsent: true })))
    assert.equal(state.live, undefined, `${String(pin)} is not a valid stored password`)
    assert.equal(state.pinConsent, true, 'consent itself is still read')
  }
})

test('saving rewrites the file in place with only the consented password', () => {
  assert.equal(writePairingPinState(file, { pin: '987654', pinConsent: true }), true)
  const document = JSON.parse(readFileSync(file, 'utf8'))
  // The file names the password by digest, never by value.
  assert.equal(document.pinConsent, true)
  assert.equal(document.pin, undefined, 'the digits do not reach the disk')
  assert.match(document.digest, /^sha256-[A-Za-z0-9+/]+={0,2}-[0-9a-f]{64}$/, 'digest is hash-salt-value')
  assert.ok(!readFileSync(file, 'utf8').includes('987654'), 'and not anywhere else in the document either')
  assert.ok(!/\.tmp$/.test(file), 'the temp name is renamed away')
})

test('a fresh write verifies its own password and refuses another', () => {
  writePairingPinState(file, { pin: '424242', pinConsent: true })
  const state = readPairingPinState(file)
  assert.equal(state.live, undefined, 'nothing plaintext comes back from a digest file')
  assert.equal(verifyPairingPin(state, '424242'), true)
  assert.equal(verifyPairingPin(state, '424243'), false)
  assert.equal(verifyPairingPin(state, ''), false)
})

test('each consent gets its own salt, so equal passwords do not look equal', () => {
  writePairingPinState(file, { pin: '555555', pinConsent: true })
  const first = readPairingPinState(file).digest
  writePairingPinState(file, { pin: '555555', pinConsent: true })
  const second = readPairingPinState(file).digest
  assert.notEqual(first, second, 'a reused salt would make the file a fingerprint anymore')
})

test('a legacy record is honoured in memory and never rewritten', () => {
  // D-P1-2's rollback rule: a legacy file carries no digest, so there is nothing
  // to write that would keep it working — deriving one needs the plaintext, and
  // dropping it would strand a running bridge. The digits stay on disk until the
  // desktop resets the password, and a save that only restates consent must not
  // quietly empty the record either.
  const legacy = join(dir, 'legacy-pin.json')
  writeFileSync(legacy, `${JSON.stringify({ pin: '246810', pinConsent: true }, undefined, 2)}\n`)
  const state = readPairingPinState(legacy)
  assert.equal(verifyPairingPin(state, '246810'), true, 'the paired phone still gets in')
  assert.equal(verifyPairingPin(state, '246811'), false)
  const before = readFileSync(legacy, 'utf8')
  assert.equal(writePairingPinState(legacy, { pinConsent: true }), true)
  assert.equal(readPairingPinState(legacy).live, '246810', 'the record survives a consent-only save')
  assert.equal(readFileSync(legacy, 'utf8'), before, 'and the file is not rewritten at all')
})

test('a new consent replaces a legacy file with a digest', () => {
  const legacy = join(dir, 'legacy-rotated.json')
  writeFileSync(legacy, `${JSON.stringify({ pin: '246810', pinConsent: true }, undefined, 2)}\n`)
  writePairingPinState(legacy, { pin: '112233', pinConsent: true })
  const raw = readFileSync(legacy, 'utf8')
  assert.ok(!raw.includes('246810') && !raw.includes('112233'), 'neither password is on disk')
  assert.equal(verifyPairingPin(readPairingPinState(legacy), '112233'), true)
  assert.equal(verifyPairingPin(readPairingPinState(legacy), '246810'), false, 'the old one is gone')
})

test('withdrawing consent leaves no digest behind', () => {
  writePairingPinState(file, { pin: '777777', pinConsent: true })
  assert.equal(writePairingPinState(file, { pinConsent: false }), true)
  assert.deepEqual(readPairingPinState(file), {})
})

test('a document whose digest is malformed is ignored', () => {
  // The digest is the only thing that can admit a phone, so a damaged one must
  // read as "no password", never as a wildcard.
  for (const digest of ['', 'sha256', 'sha256-x', `md5-abc-${'0'.repeat(64)}`, `sha256-abc-${'z'.repeat(64)}`]) {
    const state = readPairingPinState(writeRaw(JSON.stringify({ digest, pinConsent: true })))
    assert.equal(state.digest, undefined, `${digest} is not a digest`)
    assert.equal(verifyPairingPin(state, ''), false)
  }
})

test('a digest but no consent admits nobody', () => {
  // The consent flag is the only thing that turns a stored digest into a live
  // credential. A file that lost it (hand-edited, or half-written by something
  // else) must not leave the phone path open.
  const digest = pairingPinDigest('135790', 'c2FsdA==')
  writeRaw(JSON.stringify({ digest }))
  assert.equal(verifyPairingPin(readPairingPinState(file), '135790'), true, 'the digest itself still matches')
  const bridge = pinBridge({ digest })
  assert.equal(bridge.pairingPinMatches('135790'), false, 'but without consent it is not a credential')
})

test('a record that says consent is off is never consulted as one', () => {
  // `false` is not "absent": a bridge that tested for the flag's presence rather
  // than its value passed this file's password through while `readPairingPin`
  // reported consent off — a phone getting in against a panel that says no.
  const digest = pairingPinDigest('135790', 'c2FsdA==')
  const bridge = pinBridge({ digest, pinConsent: false })
  assert.equal(bridge.pairingPinMatches('135790'), false, 'explicit refusal is still a refusal')
})

test('a pre-digest file whose PIN the attempt does not match stays untouched', () => {
  const legacy = join(dir, 'legacy-untouched.json')
  writeFileSync(legacy, JSON.stringify({ pin: '135790', pinConsent: true }))
  const before = readFileSync(legacy, 'utf8')
  assert.equal(writePairingPinState(legacy, { pinConsent: true }), true)
  assert.equal(readFileSync(legacy, 'utf8'), before, 'a caller that brings no password changes nothing on disk')
})

test('a consent-only save keeps the stored digest', () => {
  writePairingPinState(file, { pin: '135790', pinConsent: true })
  const before = readFileSync(file, 'utf8')
  assert.equal(writePairingPinState(file, { pinConsent: true }), true)
  assert.equal(verifyPairingPin(readPairingPinState(file), '135790'), true, 'a caller that restates consent does not log the phone out')
  assert.equal(readFileSync(file, 'utf8'), before, 'nor does it rewrite the document to say the same thing')
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
    assert.equal(readPairingPinState(durable).live, '135790', 'and it still loads')
  } finally {
    closeSync(holder)
  }
  // The moment the destination is no longer held open the same write lands,
  // so the failure above was the rename and not a broken store.
  assert.equal(writePairingPinState(durable, { pin: '246801', pinConsent: true }), true)
  assert.equal(verifyPairingPin(readPairingPinState(durable), '246801'), true, 'and the new one takes over')
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
