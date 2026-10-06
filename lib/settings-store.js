/**
 * Persistent mobile-bridge settings (completion-notify channel, named-tunnel
 * credentials) — one JSON document under the plugin data directory.
 *
 * Persistence discipline follows lib/pin-store.js: same-directory temporary
 * file, atomic rename, `0600` on POSIX, directory created on demand. The file
 * holds secrets (the notify key, the Cloudflare tunnel token), so a corrupt or
 * half-written read falls back to the safe defaults rather than throwing —
 * a bridge that cannot read its settings simply runs with notifications off
 * and quick tunnels, which is the behaviour the document existed to change.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultDataDir } from './pin-store.js'
import { NOTIFY_CHANNELS } from './constants.js'

/** Basename of the settings document inside the data directory. */
export const SETTINGS_FILE_NAME = 'mobile-bridge-settings.json'

/** Longest secret value (notify key / tunnel token) the store accepts. */
export const SETTINGS_SECRET_MAX = 256

/** @returns {string} absolute path of the settings document */
export function settingsStorePath(dataDir) {
  return join(dataDir, SETTINGS_FILE_NAME)
}

/**
 * The document a fresh (or corrupt) store reads as. Both sections exist so
 * callers can index `doc.notify.channel` / `doc.tunnel.token` without guards.
 * @returns {{ notify: { channel: string, key: string, enabled: boolean }, tunnel: { token: string, hostname: string } }}
 */
export function defaultSettingsDocument() {
  return {
    notify: { channel: 'off', key: '', enabled: false },
    tunnel: { token: '', hostname: '' }
  }
}

/** A secret string is kept verbatim when within bounds, dropped otherwise. */
function sanitizeSecret(value) {
  if (typeof value !== 'string') return ''
  if (value.length === 0 || value.length > SETTINGS_SECRET_MAX) return ''
  return value
}

/**
 * Coerce anything a read (or a hand-edited file) produced into the documented
 * shape. Unknown values fall back to their defaults field by field, so one bad
 * key never discards a good tunnel hostname next to it.
 */
function sanitizeDocument(candidate) {
  const doc = defaultSettingsDocument()
  if (candidate === null || typeof candidate !== 'object') return doc
  const notify = candidate.notify
  if (notify !== null && typeof notify === 'object') {
    if (typeof notify.channel === 'string' && NOTIFY_CHANNELS.includes(notify.channel)) {
      doc.notify.channel = notify.channel
    }
    doc.notify.key = sanitizeSecret(notify.key)
    doc.notify.enabled = notify.enabled === true
  }
  const tunnel = candidate.tunnel
  if (tunnel !== null && typeof tunnel === 'object') {
    doc.tunnel.token = sanitizeSecret(tunnel.token)
    if (typeof tunnel.hostname === 'string' && tunnel.hostname.length <= 150) {
      doc.tunnel.hostname = tunnel.hostname
    }
  }
  return doc
}

/**
 * Read and sanitize the stored document. A missing or corrupt file is the
 * default document, never a throw.
 * @param {string} filePath
 */
export function readSettingsDocument(filePath) {
  try {
    return sanitizeDocument(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch {
    return defaultSettingsDocument()
  }
}

/**
 * Atomically write the document: temporary file in the same directory, then
 * rename onto the final name. The original file survives a failed rename.
 * `0600` is enforced on POSIX; on Windows the mode bits are a no-op and the
 * data-root ACL is the protection (same trade as pin-store).
 * @param {string} filePath
 * @param {object} document
 * @returns {boolean} false when the write failed
 */
export function writeSettingsDocument(filePath, document) {
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
 * @typedef {object} SettingsStore
 * @property {() => ReturnType<typeof defaultSettingsDocument>} load
 * @property {(patch: { notify?: Partial<ReturnType<typeof defaultSettingsDocument>['notify']>, tunnel?: Partial<ReturnType<typeof defaultSettingsDocument>['tunnel']> }) => boolean} save
 */

/**
 * Create a file-backed store under an explicit data directory (tests pass a
 * temp dir; nothing then touches the machine's real data root).
 * @param {string} dataDir
 * @returns {SettingsStore}
 */
export function createSettingsStore(dataDir) {
  const filePath = settingsStorePath(dataDir)
  return {
    load: () => readSettingsDocument(filePath),
    save: (patch) => {
      if (patch === null || typeof patch !== 'object') return false
      const next = readSettingsDocument(filePath)
      if (patch.notify !== null && typeof patch.notify === 'object') {
        // The notify endpoint always sends the whole section; a section-replace
        // is then exactly the configured state, with no stale field left over.
        next.notify = sanitizeDocument({ notify: patch.notify }).notify
      }
      if (patch.tunnel !== null && typeof patch.tunnel === 'object') {
        // The tunnel section arrives partial ({token?, hostname?}): merge only
        // the fields the caller named, so saving a token alone cannot wipe a
        // hostname that is still wanted. An empty string clears its field.
        if (typeof patch.tunnel.token === 'string') next.tunnel.token = sanitizeSecret(patch.tunnel.token)
        if (
          typeof patch.tunnel.hostname === 'string' &&
          patch.tunnel.hostname.length <= 150
        ) {
          next.tunnel.hostname = patch.tunnel.hostname
        }
      }
      return writeSettingsDocument(filePath, next)
    }
  }
}

/**
 * The store the plugin actually runs with: the same data directory
 * `defaultDataDir()` already picked for the pairing password (R12/Q8 —
 * `DSH_HOME` override wins, the machine's own location is never moved).
 * @returns {SettingsStore}
 */
export function createDefaultSettingsStore() {
  return createSettingsStore(defaultDataDir())
}
