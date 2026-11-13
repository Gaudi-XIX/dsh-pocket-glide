/**
 * Persistent pairing-PIN store.
 *
 * Hand-ported (TS -> ESM, no build) from the data-element app's
 * `src/main/mobile/pairing-pin-store.ts` (2026-09-29).
 *
 * The PIN is only persisted when the desktop user has consented to a persistent
 * PIN (`pinConsent === true`); otherwise nothing is written and the bridge
 * keeps an ephemeral 5-minute PIN in memory.
 *
 * Only a digest of the password reaches the disk. A file that held the digits
 * themselves made "someone copies the file" and "someone learns the password"
 * the same event, and the password is the root credential of every pairing
 * (audit D-P1-2). The file keeps a PBKDF2-SHA256 digest over a per-file random
 * salt, and a pre-digest file — the shape every machine on this build already
 * has — is still read, so no already-paired phone is asked for its password
 * again just because the build changed. The next save upgrades that file; see
 * `writePairingPinState`.
 *
 * @typedef {object} PairingPinState
 * @property {string} [pin]        pairing password, digits only — memory only, never written
 * @property {boolean} [pinConsent]
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes, randomUUID, pbkdf2Sync, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { PAIRING_PIN_PATTERN, dshHomeOverridden, pocketDataDir } from './constants.js'

/**
 * Absolute path of the PIN file inside a plugin data directory.
 * Faithful to dataelement's `mobile-pairing-pin.json` basename.
 *
 * @param {string} dataDir
 * @returns {string}
 */
export function pairingPinStorePath(dataDir) {
  return join(dataDir, 'mobile-pairing-pin.json')
}

/**
 * The data directory this plugin WRITES to (R12/Q8).
 *
 * `DSH_HOME` in force → `<DSH_HOME>/pocket`: an isolated run — a debug clone, an
 * automated check — keeps its durable password inside the tree the operator
 * chose, which is the whole point of the item.
 *
 * No override → exactly where the machine's file already is. This is a deliberate
 * asymmetry and the reading of the two mandates it has to satisfy at once:
 * 「DSH_HOME 优先」 is honoured by the override, 「不得搬家存量真机数据、不得让已配对
 * 设备失效」 is honoured by never changing the default location. Moving the default
 * would also have moved every test's write into `~/.dsh`, which is precisely the
 * kind of real-machine touch this item exists to prevent (one of this package's
 * own suites did write into the real cache before the rule was settled).
 *
 * @returns {string}
 */
export function defaultDataDir() {
  return dshHomeOverridden() ? pocketDataDir() : legacyDataDir()
}

/**
 * Where this file lived before the data root was unified: the `dsh-pocket` /
 * `.dsh-pocket` directories the retired `@defws/dsh-pocket` build wrote to
 * (package renamed to `dsh-pocket-glide`, 2026-10-26). The directory literals
 * stay verbatim on purpose: they name the legacy location, not this package.
 * @returns {string}
 */
export function legacyDataDir() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'dsh-pocket')
  }
  return join(homedir(), '.dsh-pocket')
}

/**
 * Files a read may consult, in priority order (R12/Q8).
 *
 * `DSH_HOME` set → the isolated path ALONE. Falling back to the machine's own
 * store from inside an isolated run is the bug this closes: it would hand a
 * debug clone the real long-lived password.
 * `DSH_HOME` unset → the machine's file first, then the unified root, so a
 * password written by an override run is still found once the override is gone.
 *
 * @returns {string[]}
 */
export function pairingPinReadPaths() {
  const primary = pairingPinStorePath(defaultDataDir())
  if (dshHomeOverridden()) return [primary]
  const unified = pairingPinStorePath(pocketDataDir())
  return unified === primary ? [primary] : [primary, unified]
}

/**
 * Where a save goes: the first entry of `pairingPinReadPaths()`, i.e. the
 * isolated root under a `DSH_HOME` override and the machine's own location
 * otherwise. Never a third place, and never the fallback rung — writing to the
 * fallback would be the relocation this item forbids.
 * @returns {string}
 */
export function pairingPinWritePath() {
  return pairingPinReadPaths()[0]
}

/**
 * The file a read will use right now: the first candidate that exists, or the
 * write path when nothing has been written anywhere yet.
 * @returns {string}
 */
export function resolvePairingPinPath() {
  const candidates = pairingPinReadPaths()
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

/**
 * A persisted password is a digest, never the digits.
 *
 * `digest` is `<hash>-<salt>-<hex>`: three parts, so the file says how an old
 * record was made as well as what it is. `live` is the plaintext a legacy file
 * held — memory only, and never written back (see `writePairingPinState`):
 * upgrading the file under a running bridge would keep the password alive in a
 * second place for the rest of that process's life, which is the state this
 * change exists to end.
 *
 * @typedef {object} PairingPinRecord
 * @property {string} [digest]
 * @property {boolean} [pinConsent]
 * @property {string} [live]
 * @property {boolean} [legacy]  the plaintext above came from a pre-digest file
 */

// ~100 ms on one core of the machine this bridge runs on, and the pairing route
// is rate limited anyway. Raising this costs pairing once per device, not per
// session.
const PAIRING_PIN_HASH_ITERATIONS = 200_000
// The label is part of the pattern: a record saying `md5-…` would match a laxer
// regex and then be derived as sha256, i.e. read as "no password" while looking
// valid. Only the one scheme this file writes is a digest at all.
const DIGEST_LABEL = 'sha256'
const PAIRING_PIN_HASH_PATTERN = new RegExp(`^${DIGEST_LABEL}-(?:[A-Za-z0-9+/]+={0,2})?-([0-9a-f]{64})$`)

/**
 * The digest of one password under one salt.
 * @param {string} pin
 * @param {string} salt base64
 * @param {number} [iterations]
 * @returns {string}
 */
export function pairingPinDigest(pin, salt, iterations = PAIRING_PIN_HASH_ITERATIONS) {
  return `${DIGEST_LABEL}-${salt}-${pbkdf2Sync(pin, salt, iterations, 32, 'sha256').toString('hex')}`
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isDigest(value) {
  return typeof value === 'string' && PAIRING_PIN_HASH_PATTERN.test(value)
}

/**
 * Read and validate the stored PIN state.
 * A corrupt/illegal file is ignored (returns {}), never throws.
 *
 * The shape test is the range constant, not a literal 6: a password written by
 * an earlier build stays usable after the generator gets wider (and vice versa),
 * so raising the strength never logs an already-paired phone out on its own
 * upgrade. Nothing here expires anything — a consented password is meant to stay
 * valid until the desktop resets or cancels it.
 *
 * A record without a digest is a pre-digest file: its `pin` is handed back as
 * `live` (with `legacy: true`) so the bridge can still verify a password typed on
 * an already-paired phone.
 *
 * @param {string} filePath
 * @returns {PairingPinRecord}
 */
export function readPairingPinState(filePath) {
  try {
    const parsed = /** @type {{pin?: unknown, digest?: unknown, pinConsent?: unknown}} */ (JSON.parse(readFileSync(filePath, 'utf8')))
    /** @type {PairingPinRecord} */
    const state = {}
    if (isDigest(parsed.digest)) state.digest = parsed.digest
    else if (typeof parsed.pin === 'string' && PAIRING_PIN_PATTERN.test(parsed.pin)) {
      state.live = parsed.pin
      state.legacy = true
    }
    if (typeof parsed.pinConsent === 'boolean') state.pinConsent = parsed.pinConsent
    return state
  } catch {
    return {}
  }
}

/**
 * Whether the destination of a PIN write is a regular file we may repair.
 * A directory (or a reparse point resolving to one) is never a valid
 * destination, and must be refused before anything is chmod-ed.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isRegularPinDestination(filePath) {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

/**
 * Land the temporary file on its final name.
 *
 * A same-directory rename replaces an existing regular file on every platform
 * this bridge supports, so the destination is never removed first. The previous
 * build did `unlinkSync(filePath)` before the rename, which made a *transient*
 * rename failure (Windows keeps the target open for AV / the indexer, giving
 * EPERM) destroy the one durable password on disk — every already-paired phone
 * was then asked for a brand-new PIN. Here the original file survives untouched
 * until the rename itself succeeds.
 *
 * The single repair path is a read-only destination: its attribute is cleared
 * and the rename retried once. Anything else is rethrown so the caller reports
 * a failed write and keeps the old state.
 *
 * @param {string} temporary
 * @param {string} filePath
 * @returns {void}
 */
function commitPinFile(temporary, filePath) {
  try {
    renameSync(temporary, filePath)
    return
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
    if (!isRegularPinDestination(filePath)) throw error
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error
    chmodSync(filePath, 0o600)
    renameSync(temporary, filePath)
  }
}

/**
 * Atomically write the PIN state: a temporary file in the same directory, then
 * rename onto the final name. Only a consented state is persisted; anything
 * else writes an empty document.
 *
 * The requested `0o600` is enforced on POSIX. On Windows the mode bits are a
 * no-op (the file lands 0666 regardless) and the real protection is the
 * directory ACL on the data root, which grants full control only to SYSTEM,
 * Administrators and the owning user — no `Users`/`Everyone` entry.
 *
 * Three cases, and the third is the one that keeps this honest:
 * - a password was handed in → a fresh salt, a fresh digest, nothing else;
 * - consent was withdrawn → an empty document, so no digest survives it;
 * - nothing usable was handed in — the caller only restated consent, or passed
 *   the plaintext of a pre-digest record. The record already on disk is carried
 *   over instead of being emptied (a caller that forgets to pass the password
 *   must not log every paired phone out), and a pre-digest file is not touched
 *   at all: its digits stay exactly where an earlier build put them until the
 *   desktop resets the password. Every new consent, reset or toggle writes a
 *   digest-only document from its first byte.
 *
 * @param {string} filePath
 * @param {PairingPinState & { live?: string, digest?: string }} state
 * @returns {boolean} false when the write failed (caller treats as non-persisted)
 */
export function writePairingPinState(filePath, state) {
  /** @type {{pinConsent?: boolean, digest?: string}} */
  const document = {}
  if (state.pinConsent === true) {
    document.pinConsent = true
    if (typeof state.pin === 'string' && PAIRING_PIN_PATTERN.test(state.pin)) {
      const salt = randomBytes(16).toString('base64')
      document.digest = pairingPinDigest(state.pin, salt)
    } else if (isDigest(state.digest)) {
      document.digest = state.digest
    } else {
      // No credential came in. The record on disk is the only thing that can
      // admit a phone, so it is carried over rather than emptied: a caller that
      // only restates consent must not log every paired device out. A
      // pre-digest record cannot be restated at all, so that file is left byte
      // for byte as an earlier build wrote it.
      const existing = readPairingPinState(filePath)
      if (isDigest(existing.digest)) document.digest = existing.digest
      else if (typeof existing.live === 'string') return true
    }
  }
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 })
    commitPinFile(temporary, filePath)
    return true
  } catch {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      // The caller already treats a false return as a failed write.
    }
    return false
  }
}

/**
 * Whether `pin` is the password this record stands for.
 *
 * Checked against the digest: one derivation per candidate, and the recorded
 * hash's own salt is reused because a record only ever names one password.
 * Compares with `timingSafeEqual` so a wrong password costs the same time as a
 * right one.
 *
 * @param {PairingPinRecord} record
 * @param {string} pin
 * @returns {boolean}
 */
export function verifyPairingPin(record, pin) {
  if (typeof pin !== 'string' || pin === '') return false
  if (typeof record.live === 'string') {
    const shown = Buffer.from(pin)
    const kept = Buffer.from(record.live)
    return shown.length === kept.length && timingSafeEqual(shown, kept)
  }
  if (!isDigest(record.digest)) return false
  const parts = record.digest.split('-')
  const expected = Buffer.from(parts[2], 'hex')
  const actual = pbkdf2Sync(pin, parts[1], PAIRING_PIN_HASH_ITERATIONS, 32, 'sha256')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/**
 * @typedef {object} PairingPinStore
 * @property {() => PairingPinRecord} load
 * @property {(state: PairingPinState & { live?: string, digest?: string }) => boolean} save
 */

/**
 * Create a file-backed store at `filePath`.
 *
 * @param {string} filePath
 * @returns {PairingPinStore}
 */
export function createFilePairingPinStore(filePath) {
  return {
    load: () => readPairingPinState(filePath),
    save: (state) => writePairingPinState(filePath, state),
  }
}

/**
 * Create the default store at the machine's own pin location.
 *
 * With an explicit `dataDir` the store is exactly one file, as it always was.
 * Without one, the read follows `pairingPinReadPaths()` — the machine's own
 * file first, then the unified root — while a write lands at
 * `pairingPinWritePath()`: the machine's own location. Nothing is moved, nothing
 * is deleted, and a phone that paired against a password already on disk is not
 * asked for it again (R12/Q8).
 *
 * @param {string} [dataDir]
 * @returns {PairingPinStore & { filePath: string }}
 */
export function createDefaultPairingPinStore(dataDir) {
  if (typeof dataDir === 'string') {
    const filePath = pairingPinStorePath(dataDir)
    return { ...createFilePairingPinStore(filePath), filePath }
  }
  const writePath = pairingPinWritePath()
  return {
    load: () => readPairingPinState(resolvePairingPinPath()),
    save: (state) => writePairingPinState(writePath, state),
    /** The file a read is using right now — the legacy one until a save moves the answer forward. */
    get filePath() {
      return resolvePairingPinPath()
    },
  }
}
