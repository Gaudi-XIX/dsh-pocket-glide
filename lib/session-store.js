/**
 * Persistent mobile sessions — the durable half of a pairing.
 *
 * A pairing issues the phone a 30-day cookie, but the session records backing
 * it used to live only in bridge memory, so every host restart silently
 * un-paired every handset: the phone came back with a perfectly valid cookie
 * and had to re-run the whole funnel (PIN, desktop confirmation, consent).
 * This store keeps the three session maps on disk so a restart is invisible
 * to a paired phone — the pairing result, not just the cookie, actually
 * lasts its month.
 *
 * The device registry (change 2026-10-07-feat-pocket-device-registry) rides
 * the same document as a fourth map: one durable profile per paired device,
 * keyed by its User-Agent fingerprint. The profile is what survives the
 * tunnel hostname rotating under the phone (a new origin means the old cookie
 * never comes back): with it, the PIN alone restores the device — credential
 * and public-access consent re-issued from the record, not re-asked.
 *
 * Persistence discipline follows lib/settings-store.js: same-directory
 * temporary file, atomic rename, `0600` on POSIX, directory created on
 * demand. The file holds the session tokens themselves (they ARE the
 * credential), so a corrupt or half-written read yields an empty slate rather
 * than a throw — a bridge that cannot read it simply asks its phones to pair
 * again, which is exactly the pre-store behaviour, never worse.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultDataDir } from './pin-store.js'
import { DEVICE_MAP_CAP } from './constants.js'

/** Basename of the sessions document inside the data directory. */
export const SESSIONS_FILE_NAME = 'mobile-sessions.json'

/** Document shape version; a mismatch reads as an empty slate. */
export const SESSIONS_DOC_VERSION = 1

/** @returns {string} absolute path of the sessions document */
export function sessionsStorePath(dataDir) {
  return join(dataDir, SESSIONS_FILE_NAME)
}

/**
 * Coerce a parsed file into the documented shape. Each map is a list of
 * [key, record] pairs; entries that are not a pair, carry a non-string
 * key or a non-object record are dropped individually, and every map is
 * capped at DEVICE_MAP_CAP so a hand-edited file cannot balloon memory.
 * Expiry is NOT applied here — the caller knows `now` and its own semantics.
 *
 * `devices` (the device registry, change 2026-10-07-feat-pocket-device-registry)
 * rides the SAME document as an ADDITIVE map keyed by the device fingerprint.
 * The document version stays 1 on purpose: an older build reading a newer file
 * matches the version and simply ignores the field it does not know, while this
 * build reading an older file finds no devices and the bridge rebuilds the
 * registry from the session records it can see (the compatibility migration).
 * A version bump here would read every existing pairing as an empty slate and
 * force the whole funnel back onto a working phone — exactly what this store
 * exists to prevent.
 * @param {unknown} candidate
 * @returns {{ version: number, savedAt: number, sessions: Array<[string, object]>, suspended: Array<[string, object]>, resumable: Array<[string, object]>, devices: Array<[string, object]> }}
 */
function sanitizeDocument(candidate) {
  const doc = { version: SESSIONS_DOC_VERSION, savedAt: 0, sessions: [], suspended: [], resumable: [], devices: [] }
  if (candidate === null || typeof candidate !== 'object') return doc
  if (candidate.version !== SESSIONS_DOC_VERSION) return doc
  doc.savedAt = typeof candidate.savedAt === 'number' ? candidate.savedAt : 0
  const readMap = (value) => {
    if (!Array.isArray(value)) return []
    const entries = []
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length !== 2) continue
      const [token, record] = pair
      if (typeof token !== 'string' || token.length === 0) continue
      if (record === null || typeof record !== 'object') continue
      entries.push([token, record])
      if (entries.length >= DEVICE_MAP_CAP) break
    }
    return entries
  }
  doc.sessions = readMap(candidate.sessions)
  doc.suspended = readMap(candidate.suspended)
  doc.resumable = readMap(candidate.resumable)
  doc.devices = readMap(candidate.devices)
  return doc
}

/**
 * Read the stored document. A missing or corrupt file is an empty document,
 * never a throw.
 * @param {string} filePath
 */
export function readSessionsDocument(filePath) {
  return readSessionsDocumentStatus(filePath).doc
}

/**
 * The same read, carrying a failure flag. `readFailed` is true only when an
 * occupant exists but could not be read (EBUSY / EPERM / EISDIR — any
 * non-ENOENT error): the in-memory maps are then an *unverified* empty state.
 * ENOENT is not a failure — a missing file is a genuinely empty store (the
 * first-install path), and the write guard below must not block it.
 * @param {string} filePath
 * @param {typeof readFileSync} [readFile] test seam; production reads from disk
 * @returns {{ doc: ReturnType<typeof sanitizeDocument>, readFailed: boolean }}
 */
function readSessionsDocumentStatus(filePath, readFile = readFileSync) {
  try {
    return { doc: sanitizeDocument(JSON.parse(readFile(filePath, 'utf8'))), readFailed: false }
  } catch (error) {
    const missing = /** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT'
    return { doc: sanitizeDocument(null), readFailed: !missing }
  }
}

/**
 * Atomically write the document (same contract as writeSettingsDocument).
 * `state.devices` is optional so callers from before the device registry (and
 * tests of the session maps alone) keep working; an absent map writes an empty
 * devices list.
 * @param {string} filePath
 * @param {{ sessions: Map<string, object>, suspendedSessions: Map<string, object>, resumableSessions: Map<string, object>, devices?: Map<string, object>, savedAt?: number }} state
 * @returns {boolean} false when the write failed
 */
export function writeSessionsDocument(filePath, state) {
  const document = {
    version: SESSIONS_DOC_VERSION,
    savedAt: typeof state.savedAt === 'number' ? state.savedAt : Date.now(),
    sessions: [...state.sessions.entries()],
    suspended: [...state.suspendedSessions.entries()],
    resumable: [...state.resumableSessions.entries()],
    devices: [...(state.devices ?? new Map()).entries()],
  }
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 })
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
 * @typedef {object} SessionStore
 * @property {(now: number) => { sessions: Array<[string, object]>, suspended: Array<[string, object]>, resumable: Array<[string, object]>, devices: Array<[string, object]> }} load
 * @property {(state: Parameters<typeof writeSessionsDocument>[1]) => boolean} save
 */

/**
 * Create a file-backed store under an explicit data directory (tests pass a
 * temp dir; nothing then touches the machine's real data root). `hooks.readFile`
 * is a test seam only — production passes nothing and reads straight from disk.
 *
 * Write guard: when the store loaded while an occupant held the file
 * unreadable, the maps hold an unverified empty state, and a save with nothing
 * to say is refused (`false`) so a transient lock cannot wipe the stored
 * tokens. The refusal boundary: it protects only that *unverified* emptiness.
 * Once the maps carry real state (a fresh pairing made while the file was
 * unreadable), saving proceeds and clears the flag — the stale file is already
 * unreadable at that point, and refusing would pin the new pairing to memory
 * only, which is worse. A refused save rides the bridge's existing
 * `session persist failed` warn; `flushSessionPersist` at stop() is refused
 * the same way, so the file survives and the next start retries the read.
 * @param {string} dataDir
 * @param {{ readFile?: typeof readFileSync }} [hooks]
 * @returns {SessionStore}
 */
export function createSessionStore(dataDir, hooks = {}) {
  const filePath = sessionsStorePath(dataDir)
  const readFile = hooks.readFile ?? readFileSync
  let unreadableAtLoad = false
  return {
    load: (now) => {
      const { doc, readFailed } = readSessionsDocumentStatus(filePath, readFile)
      unreadableAtLoad = readFailed
      // Expiry is applied at load with the caller's clock: a record past its
      // own expiresAt is exactly what a restart must not resurrect. Device
      // profiles age on the same rule — a profile past its credential expiry
      // is a full-funnel pairing again, which is the point of the expiry.
      const live = (entries) => entries.filter(([, record]) => typeof record.expiresAt !== 'number' || record.expiresAt > now)
      return {
        ...doc,
        sessions: live(doc.sessions),
        suspended: live(doc.suspended),
        resumable: live(doc.resumable),
        devices: live(doc.devices),
      }
    },
    save: (state) => {
      const empty =
        state.sessions.size === 0 &&
        state.suspendedSessions.size === 0 &&
        state.resumableSessions.size === 0 &&
        (state.devices === undefined || state.devices.size === 0)
      if (unreadableAtLoad && empty) return false
      unreadableAtLoad = false
      return writeSessionsDocument(filePath, state)
    },
  }
}

/**
 * The store the plugin actually runs with: the same data directory the
 * settings and pairing-pin stores use (`defaultDataDir()`, `DSH_HOME`
 * override respected).
 * @returns {SessionStore}
 */
export function createDefaultSessionStore() {
  return createSessionStore(defaultDataDir())
}
