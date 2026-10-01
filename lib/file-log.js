/**
 * Minimal file logger for Pocket.
 *
 * Why this exists: the plugin node half runs as ELECTRON_RUN_AS_NODE and the
 * Cordis `ctx.logger` has no file transport, so pairing/tunnel failures left no
 * on-disk trace. This appends JSON lines to a per-user log file and never throws.
 *
 * Location: ~/.dsh/pocket/logs/pocket.log (DSH_HOME override respected)
 * Rotation: once the file exceeds MAX_BYTES it is renamed pocket.log.1 once.
 *
 * @typedef {object} PocketFileLogger
 * @property {string} path
 * @property {(message: string) => void} info
 * @property {(message: string) => void} warn
 * @property {(message: string) => void} error
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const MAX_BYTES = 512 * 1024

/**
 * DSH per-user data root, matching where other plugins keep their data
 * (e.g. ~/.dsh/mobile-access). DSH_HOME overrides the default ~/.dsh.
 *
 * @returns {string}
 */
export function defaultDshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/** @returns {string} */
export function defaultLogDir() {
  return join(defaultDshHome(), 'pocket', 'logs')
}

/**
 * @param {string} [filePath]
 * @returns {PocketFileLogger}
 */
export function createFileLogger(filePath = join(defaultLogDir(), 'pocket.log')) {
  let bytes = 0
  try {
    bytes = statSync(filePath).size
  } catch {
    bytes = 0
  }

  /** @param {'info'|'warn'|'error'} level @param {string} message */
  const write = (level, message) => {
    const line = `${JSON.stringify({ t: new Date().toISOString(), level, message })}\n`
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      if (bytes + line.length > MAX_BYTES) {
        try {
          if (existsSync(filePath)) renameSync(filePath, `${filePath}.1`)
        } catch {
          // best-effort rotation: a failed rename must not drop the log line
        }
        bytes = 0
      }
      appendFileSync(filePath, line)
      bytes += line.length
    } catch {
      // logging must never break the plugin
    }
  }

  return {
    path: filePath,
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}
