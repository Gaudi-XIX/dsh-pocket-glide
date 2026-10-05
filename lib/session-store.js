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
 * [token, record] pairs; entries that are not a pair, carry a non-string
 * token or a non-object record are dropped individually, and every map is
 * capped at DEVICE_MAP_CAP so a hand-edited file cannot balloon memory.
 * Expiry is NOT applied here — the caller knows `now` and its own semantics.
 * @param {unknown} candidate
 * @returns {{ version: number, savedAt: number, sessions: Array<[string, object]>, suspended: Array<[string, object]>, resumable: Array<[string, object]> }}
 */
function sanitizeDocument(candidate) {
  const doc = { version: SESSIONS_DOC_VERSION, savedAt: 0, sessions: [], suspended: [], resumable: [] }
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
  return doc
}

/**
 * Read the stored document. A missing or corrupt file is an empty document,
 * never a throw.
 * @param {string} filePath
 */
export function readSessionsDocument(filePath) {
  try {
    return sanitizeDocument(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch {
    return sanitizeDocument(null)
  }
}

/**
 * Atomically write the document (same contract as writeSettingsDocument).
 * @param {string} filePath
 * @param {{ sessions: Map<string, object>, suspendedSessions: Map<string, object>, resumableSessions: Map<string, object>, savedAt?: number }} state
 * @returns {boolean} false when the write failed
 */
export function writeSessionsDocument(filePath, state) {
  const document = {
    version: SESSIONS_DOC_VERSION,
    savedAt: typeof state.savedAt === 'number' ? state.savedAt : Date.now(),
    sessions: [...state.sessions.entries()],
    suspended: [...state.suspendedSessions.entries()],
    resumable: [...state.resumableSessions.entries()],
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
 * @property {(now: number) => ReturnType<typeof sanitizeDocument>} load
 * @property {(state: Parameters<typeof writeSessionsDocument>[1]) => boolean} save
 */

/**
 * Create a file-backed store under an explicit data directory (tests pass a
 * temp dir; nothing then touches the machine's real data root).
 * @param {string} dataDir
 * @returns {SessionStore}
 */
export function createSessionStore(dataDir) {
  const filePath = sessionsStorePath(dataDir)
  return {
    load: (now) => {
      const doc = readSessionsDocument(filePath)
      // Expiry is applied at load with the caller's clock: a record past its
      // own expiresAt is exactly what a restart must not resurrect.
      const live = (entries) => entries.filter(([, record]) => typeof record.expiresAt !== 'number' || record.expiresAt > now)
      return { ...doc, sessions: live(doc.sessions), suspended: live(doc.suspended), resumable: live(doc.resumable) }
    },
    save: (state) => writeSessionsDocument(filePath, state),
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
