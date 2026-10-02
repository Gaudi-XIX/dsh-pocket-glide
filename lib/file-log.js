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
 * The byte count that drives rotation is read FROM DISK on every line, not
 * accumulated in this logger (X4⑥): two host processes can share one
 * `pocket.log`, and a per-process counter meant each of them believed the file
 * was as small as its own writes — so the file grew past every ceiling while
 * both counted happily. A failed rename likewise keeps the real size: the count
 * is what makes the next line try again.
 *
 * @typedef {object} PocketFileLogger
 * @property {string} path
 * @property {(message: string) => void} info
 * @property {(message: string) => void} warn
 * @property {(message: string) => void} error
 * @property {() => { bytes: number, rotationFailures: number, droppedLines: number }} stats
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultDshHome } from './constants.js'

// The data-root rule now has one owner (lib/constants.js, R12/Q8). Re-exported
// so a caller that used to reach it through this module still finds it.
export { defaultDshHome }

/** Rotation ceiling for one `pocket.log`. */
const MAX_BYTES = 512 * 1024
/**
 * What "rotation is not working" costs before lines start being dropped: four
 * times the ceiling. The ceiling makes rotation visible; this makes a permanently
 * broken rotation bounded, which is the failure the audit called silent growth.
 */
const MAX_CEILING_BYTES = MAX_BYTES * 4

/**
 * Size of the log on disk right now — the only number that can be trusted when
 * another process is writing to the same path.
 * @param {string} filePath
 * @returns {number}
 */
function bytesOnDisk(filePath) {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
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
  /** @type {{ rotationFailures: number, droppedLines: number }} */
  const stats = { rotationFailures: 0, droppedLines: 0 }

  /** @param {'info'|'warn'|'error'} level @param {string} message */
  const write = (level, message) => {
    const line = `${JSON.stringify({ t: new Date().toISOString(), level, message })}\n`
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      const bytes = bytesOnDisk(filePath)
      if (bytes + line.length > MAX_BYTES && existsSync(filePath)) {
        // best-effort rotation: a failed rename must not drop the log line, and
        // must not make this logger believe the file is empty either.
        try {
          renameSync(filePath, `${filePath}.1`)
        } catch {
          stats.rotationFailures += 1
        }
      }
      if (bytesOnDisk(filePath) + line.length > MAX_CEILING_BYTES) {
        // Rotation has been failing and the file is now four ceilings deep.
        // Dropping the line is the lesser failure than filling the disk.
        stats.droppedLines += 1
        return
      }
      appendFileSync(filePath, line)
    } catch {
      // logging must never break the plugin
    }
  }

  return {
    path: filePath,
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    stats: () => ({ bytes: bytesOnDisk(filePath), ...stats }),
  }
}
