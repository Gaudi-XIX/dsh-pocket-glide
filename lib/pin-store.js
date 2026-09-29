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
 * @property {string} [pin]        6-digit PIN
 * @property {boolean} [pinConsent]
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

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
 * Default per-user data directory for this plugin.
 * Windows: %LOCALAPPDATA%\dsh-pocket ; elsewhere: ~/.dsh-pocket.
 *
 * @returns {string}
 */
export function defaultDataDir() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'dsh-pocket')
  }
  return join(homedir(), '.dsh-pocket')
}

/**
 * Read and validate the stored PIN state.
 * A corrupt/illegal file is ignored (returns {}), never throws.
 *
 * @param {string} filePath
 * @returns {PairingPinState}
 */
export function readPairingPinState(filePath) {
  try {
    const parsed = /** @type {{pin?: unknown, pinConsent?: unknown}} */ (JSON.parse(readFileSync(filePath, 'utf8')))
    /** @type {PairingPinState} */
    const state = {}
    if (typeof parsed.pin === 'string' && /^\d{6}$/.test(parsed.pin)) state.pin = parsed.pin
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
    if (typeof state.pin === 'string' && /^\d{6}$/.test(state.pin)) document.pin = state.pin
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
 * Create the default store in the per-user data directory.
 *
 * @param {string} [dataDir]
 * @returns {PairingPinStore & {filePath: string}}
 */
export function createDefaultPairingPinStore(dataDir = defaultDataDir()) {
  const filePath = pairingPinStorePath(dataDir)
  return { ...createFilePairingPinStore(filePath), filePath }
}
