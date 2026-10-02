/**
 * Persistent pairing-PIN store.
 *
 * Hand-ported (TS -> ESM, no build) from
 * F:\defws\tmp\20260929-dataelement-main\src\main\mobile\pairing-pin-store.ts.
 *
 * The PIN is only persisted when the desktop user has consented to a persistent
 * PIN (`pinConsent === true`); otherwise nothing is written and the bridge
 * keeps an ephemeral 5-minute PIN in memory.
 *
 * @typedef {object} PairingPinState
 * @property {string} [pin]        pairing password, digits only
 * @property {boolean} [pinConsent]
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
 * Where this file lived before the data root was unified:
 * Windows `%LOCALAPPDATA%\dsh-pocket`, elsewhere `~/.dsh-pocket`.
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
 * Read and validate the stored PIN state.
 * A corrupt/illegal file is ignored (returns {}), never throws.
 *
 * The shape test is the range constant, not a literal 6: a password written by
 * an earlier build stays usable after the generator gets wider (and vice versa),
 * so raising the strength never logs an already-paired phone out on its own
 * upgrade. Nothing here expires anything — a consented password is meant to stay
 * valid until the desktop resets or cancels it.
 *
 * @param {string} filePath
 * @returns {PairingPinState}
 */
export function readPairingPinState(filePath) {
  try {
    const parsed = /** @type {{pin?: unknown, pinConsent?: unknown}} */ (JSON.parse(readFileSync(filePath, 'utf8')))
    /** @type {PairingPinState} */
    const state = {}
    if (typeof parsed.pin === 'string' && PAIRING_PIN_PATTERN.test(parsed.pin)) state.pin = parsed.pin
    if (typeof parsed.pinConsent === 'boolean') state.pinConsent = parsed.pinConsent
    return state
  } catch {
    return {}
  }
}

/**
 * Atomically write the PIN state (tmp file in same dir -> rename), mode 0600.
 * Only a consented state is persisted; anything else writes an empty document.
 *
 * @param {string} filePath
 * @param {PairingPinState} state
 * @returns {boolean} false when the write failed (caller treats as non-persisted)
 */
export function writePairingPinState(filePath, state) {
  /** @type {PairingPinState} */
  const document = {}
  if (state.pinConsent === true) {
    document.pinConsent = true
    if (typeof state.pin === 'string' && PAIRING_PIN_PATTERN.test(state.pin)) document.pin = state.pin
  }
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 })
    if (existsSync(filePath)) unlinkSync(filePath)
    renameSync(temporary, filePath)
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
 * @typedef {object} PairingPinStore
 * @property {() => PairingPinState} load
 * @property {(state: PairingPinState) => boolean} save
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
 * Create the default store in the unified per-user data directory.
 *
 * With an explicit `dataDir` the store is exactly one file, as it always was.
 * Without one, the read follows `pairingPinReadPaths()` — the unified root, and
 * on a machine with no `DSH_HOME` set the pre-unification location as a
 * fallback — while a write lands in the unified root. Nothing is moved, nothing
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
