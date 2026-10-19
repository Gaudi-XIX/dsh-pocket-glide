/**
 * Persistent per-device read ledger (`mobile-opened-at.json`).
 *
 * The phone's landing rule (0.4.32) counts 「推进完了但消息还没有读」, and until
 * 0.4.33 only the phone could evaluate that term — its ledger was a private
 * localStorage map. That made the bridge embed a chat at the first byte and let
 * the page walk back out of it whenever the phone's own count disagreed, which
 * the user saw as the rule not working (2026-10-12: three finished-unread
 * conversations, bridge counted 1, phone jumped straight in).
 *
 * So the ledger now syncs up: each phone POSTs its map to `/api/opened-at`,
 * keyed here by the device fingerprint (the same coarse `sha256(userAgent)`
 * digest the device registry uses — stable across desktop restarts, which is
 * exactly the boundary the cold open crosses). Two handsets of the SAME model
 * share a fingerprint and therefore a ledger; opening on one marks read for the
 * other. That is the registry's own grain and was accepted there first.
 *
 * Shape on disk:
 *   { version: 1, savedAt: number, devices: { [fingerprint]: { [sessionId]: ts } } }
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultDataDir } from './pin-store.js'

export const OPENED_AT_FILE_NAME = 'mobile-opened-at.json'

/**
 * Entries kept per device. The phone prunes its own map to the 200 newest
 * (`UNREAD_OPEN_MAX` on the page); this cap only stops a hostile or buggy
 * client from growing the file without bound.
 */
export const OPENED_AT_LEDGER_MAX_ENTRIES = 500

/** A single ledger entry: a positive, sane, whole-number timestamp. */
const ENTRY_CEILING_SKEW_MS = 5 * 60 * 1000

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function openedAtStorePath(dataDir) {
  return join(dataDir, OPENED_AT_FILE_NAME)
}

/**
 * Keep only the rows a census may trust: string session ids of a sane length
 * mapping to positive whole timestamps no further than clock-skew in the
 * future. Newest timestamps win the prune, mirroring the page's own cap so a
 * synced ledger never resurrects entries the phone already dropped.
 *
 * @param {unknown} value
 * @param {number} [nowMs]
 * @returns {Record<string, number>}
 */
export function sanitizeOpenedAtLedger(value, nowMs = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  /** @type {{ id: string, ts: number }[]} */
  const entries = []
  for (const [id, ts] of Object.entries(value)) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) continue
    if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts <= 0) continue
    if (ts > nowMs + ENTRY_CEILING_SKEW_MS) continue
    entries.push({ id, ts })
  }
  if (entries.length > OPENED_AT_LEDGER_MAX_ENTRIES) {
    entries.sort((a, b) => b.ts - a.ts)
    entries.length = OPENED_AT_LEDGER_MAX_ENTRIES
  }
  /** @type {Record<string, number>} */
  const out = {}
  for (const { id, ts } of entries) out[id] = ts
  return out
}

/**
 * Read and validate the stored document. A corrupt or foreign-shaped file is
 * ignored (returns an empty census), never thrown — the ledger is an
 * optimisation on top of the page's own count, and losing it must never take
 * the bridge down.
 *
 * @param {string} filePath
 * @returns {{ version: number, savedAt: number, devices: Record<string, Record<string, number>> }}
 */
export function readOpenedAtDocument(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyDocument()
    const rawDevices = parsed.devices && typeof parsed.devices === 'object' && !Array.isArray(parsed.devices)
      ? parsed.devices
      : {}
    /** @type {Record<string, Record<string, number>>} */
    const devices = {}
    for (const [fingerprint, ledger] of Object.entries(rawDevices)) {
      if (typeof fingerprint !== 'string' || fingerprint.length === 0 || fingerprint.length > 64) continue
      const clean = sanitizeOpenedAtLedger(ledger)
      if (Object.keys(clean).length > 0) devices[fingerprint] = clean
    }
    return { version: 1, savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0, devices }
  } catch {
    return emptyDocument()
  }
}

function emptyDocument() {
  return { version: 1, savedAt: 0, devices: {} }
}

/**
 * Whether the destination of a write is a regular file we may replace. Same
 * rule, for the same reason, as the pairing-pin store: a directory (or a
 * reparse point resolving to one) is never a valid destination.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isRegularDestination(filePath) {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

/**
 * Land the temporary file on its final name, retrying once through the
 * read-only case. Windows keeps files open for AV / the indexer and a
 * transient rename then fails with EPERM; unlinking the target first (the
 * naive write) would destroy the only durable copy of the ledger at the exact
 * moment a restart boundary needs it. The pin store learned this in
 * production; this store is written by the same lesson.
 *
 * @param {string} temporary
 * @param {string} filePath
 * @returns {void}
 */
function commitFile(temporary, filePath) {
  try {
    renameSync(temporary, filePath)
    return
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
    if (!isRegularDestination(filePath)) throw error
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error
    chmodSync(filePath, 0o600)
    renameSync(temporary, filePath)
  }
}

/**
 * Atomically write the document: temporary file in the same directory, then a
 * rename onto the final name. Returns false when the write failed — the caller
 * keeps the in-memory ledger and simply tries again after the next sync.
 *
 * @param {string} filePath
 * @param {{ version: number, savedAt: number, devices: Record<string, Record<string, number>> }} document
 * @returns {boolean}
 */
export function writeOpenedAtDocument(filePath, document) {
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 })
    commitFile(temporary, filePath)
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
 * @typedef {object} OpenedAtStore
 * @property {() => { version: number, savedAt: number, devices: Record<string, Record<string, number>> }} load
 * @property {(document: { version: number, savedAt: number, devices: Record<string, Record<string, number>> }) => boolean} save
 */

/**
 * Create the store at the machine's own data root (or an explicit one —
 * `DSH_HOME` overrides flow through `defaultDataDir()`, same as the pairing
 * PIN and the session store). Unlike the PIN there is no legacy location to
 * fall back to: the file is born here.
 *
 * @param {string} [dataDir]
 * @returns {OpenedAtStore & { filePath: string }}
 */
export function createDefaultOpenedAtStore(dataDir) {
  const filePath = openedAtStorePath(typeof dataDir === 'string' ? dataDir : defaultDataDir())
  return {
    filePath,
    load: () => readOpenedAtDocument(filePath),
    save: (document) => writeOpenedAtDocument(filePath, document),
  }
}
