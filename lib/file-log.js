/**
 * Minimal file logger for Pocket.
 *
 * Why this exists: the plugin node half runs as ELECTRON_RUN_AS_NODE and the
 * Cordis `ctx.logger` has no file transport, so pairing/tunnel failures left no
 * on-disk trace. This appends JSON lines to a per-user log file and never throws.
 *
 * Location: ~/.dsh/pocket/logs/pocket.log (DSH_HOME override respected)
 * Rotation: once the live file exceeds MAX_BYTES it is shifted down a numbered
 * cascade — pocket.log -> .1, .1 -> .2, .2 -> .3, oldest dropped (ROTATIONS).
 * The previous single-generation rename destroyed the generation before it every
 * time it ran (probe-02: 1113 of 3000 lines unrecoverable after one rotation),
 * so "keep a rotated copy" was true for exactly one cycle.
 *
 * The byte count that drives rotation is read FROM DISK on every line, not
 * accumulated in this logger (X4⑥): two host processes can share one
 * `pocket.log`, and a per-process counter meant each of them believed the file
 * was as small as its own writes — so the file grew past every ceiling while
 * both counted happily. A failed rename likewise keeps the real size: the count
 * is what makes the next line try again.
 *
 * Every failure path is COUNTED (R-T5): the outer catch is still there — logging
 * may never break the plugin — but it now records `writeFailures` and the first
 * `lastWriteError` instead of swallowing them into a silent no-op, and warns
 * once so an operator has a chance to see it. probe-12 A/B: a log directory
 * occupied by a regular file, and a read-only file, both produced 50 writes and
 * `stats()` reporting all zeros with nothing on disk.
 *
 * @typedef {object} PocketFileLoggerStats
 * @property {number} bytes on-disk size of the live file right now
 * @property {number} rotationFailures renames that did not happen
 * @property {number} rotated successful rotations
 * @property {number} droppedLines lines refused because the file was already past MAX_CEILING_BYTES
 * @property {number} truncatedLines lines shortened to MAX_LINE_BYTES
 * @property {number} writeFailures mkdir/append/stat failures (never content)
 * @property {string|null} lastWriteError first failure, `CODE: message`, message clipped to 200 chars
 *
 * @typedef {object} PocketFileLogger
 * @property {string} path
 * @property {(message: string) => void} info
 * @property {(message: string) => void} warn
 * @property {(message: string) => void} error
 * @property {() => PocketFileLoggerStats} stats
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
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
 * Generations kept beside the live file. Three is what makes the cascade worth
 * having: one generation of history is not history (probe-02).
 */
const ROTATIONS = 3
/**
 * Hard cap on ONE line. A single 2 MiB message used to be dropped outright — and
 * because the file did not exist yet, the drop also meant the log file was never
 * created at all (probe-02 tail: `droppedLines: 1`, `exists=false bytes=0`).
 * Truncating the `message` field keeps the line valid JSON and keeps the event.
 */
const MAX_LINE_BYTES = 32 * 1024
/** Appended to a message that had to be shortened. */
const TRUNCATION_SUFFIX = '…[truncated]'
/** How much of an error message `lastWriteError` keeps (never file content). */
const ERROR_TEXT_LIMIT = 200

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

/** @param {string} candidate @returns {boolean} true only for a regular file. */
function isFile(candidate) {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** @returns {string} */
export function defaultLogDir() {
  return join(defaultDshHome(), 'pocket', 'logs')
}

/**
 * Shift the numbered cascade down one and hand `.1` to the live file.
 *
 * Only regular files are moved: an obstacle that is not a file (the portable way
 * to make rotation fail in a test) must keep blocking rotation instead of being
 * relocated out of the way, because a blocked rotation that silently "succeeds"
 * is exactly the accounting lie this module exists to avoid.
 *
 * @param {string} filePath
 */
function rotateGenerations(filePath) {
  const oldest = `${filePath}.${ROTATIONS}`
  if (isFile(oldest)) rmSync(oldest, { force: true })
  for (let generation = ROTATIONS - 1; generation >= 1; generation -= 1) {
    const from = `${filePath}.${generation}`
    if (!isFile(from)) continue
    renameSync(from, `${filePath}.${generation + 1}`)
  }
  renameSync(filePath, `${filePath}.1`)
}

/**
 * One JSON line, shortened to MAX_LINE_BYTES by clipping the `message` field —
 * never by cutting the serialized line, which would leave invalid JSON behind.
 * @param {string} t @param {string} level @param {string} message
 * @returns {{ line: string, truncated: boolean }}
 */
function buildLine(t, level, message) {
  const full = `${JSON.stringify({ t, level, message })}\n`
  if (Buffer.byteLength(full, 'utf8') <= MAX_LINE_BYTES) return { line: full, truncated: false }
  const make = (length) => `${JSON.stringify({ t, level, message: message.slice(0, length) + TRUNCATION_SUFFIX })}\n`
  let lo = 0
  let hi = message.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (Buffer.byteLength(make(mid), 'utf8') <= MAX_LINE_BYTES) lo = mid
    else hi = mid - 1
  }
  return { line: make(lo), truncated: true }
}

/**
 * @param {string} [filePath]
 * @returns {PocketFileLogger}
 */
export function createFileLogger(filePath = join(defaultLogDir(), 'pocket.log')) {
  /** @type {PocketFileLoggerStats} */
  const stats = {
    rotationFailures: 0,
    rotated: 0,
    droppedLines: 0,
    truncatedLines: 0,
    writeFailures: 0,
    lastWriteError: null,
  }

  // `mkdirSync` used to run on EVERY line (measured 0.358 ms/line, probe-12 C).
  // It is memoized instead; a failed attempt keeps retrying, which is the rare
  // path and the one where each attempt must be counted rather than hidden.
  let dirReady = false
  let warned = false

  const noteFailure = (error) => {
    stats.writeFailures += 1
    if (stats.lastWriteError === null) {
      const code = typeof error?.code === 'string' ? error.code : 'ERR'
      const text = typeof error?.message === 'string' ? error.message : String(error)
      // Codes and messages only — a log message can carry a pairing code, and an
      // error object can carry the content that failed to be written.
      stats.lastWriteError = `${code}: ${text.slice(0, ERROR_TEXT_LIMIT)}`
    }
    if (warned) return
    warned = true
    const text = `pocket file log cannot write ${filePath}: ${stats.lastWriteError}`
    try {
      process.emitWarning(text)
    } catch {
      // Under ELECTRON_RUN_AS_NODE the warning channel is easy to lose; one line
      // on stderr is the fallback the host actually surfaces.
      try {
        process.stderr.write(`[dsh-pocket] ${text}\n`)
      } catch {
        // Nothing left to report with.
      }
    }
  }

  const ensureDir = () => {
    if (dirReady) return true
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      dirReady = true
      return true
    } catch (error) {
      noteFailure(error)
      return false
    }
  }

  /**
   * Append, and re-establish the directory once if it went away underneath us.
   * The memoized `dirReady` is a fast path, not a claim about the world: a
   * cleaner (or a moved data root) can remove the directory mid-run, and the
   * logger must heal instead of failing for ever on a stale flag.
   * @param {string} line
   */
  const appendLine = (line) => {
    try {
      appendFileSync(filePath, line)
      return
    } catch (error) {
      dirReady = false
      if (!ensureDir()) return // ensureDir already counted this failure
      try {
        appendFileSync(filePath, line)
      } catch (retryError) {
        noteFailure(retryError)
      }
    }
  }

  /** @param {'info'|'warn'|'error'} level @param {string} message */
  const write = (level, message) => {
    try {
      if (!ensureDir()) return
      const { line, truncated } = buildLine(new Date().toISOString(), level, message)
      if (truncated) stats.truncatedLines += 1
      const bytes = bytesOnDisk(filePath)
      if (bytes + Buffer.byteLength(line, 'utf8') > MAX_BYTES && existsSync(filePath)) {
        // best-effort rotation: a failed rename must not drop the log line, and
        // must not make this logger believe the file is empty either.
        try {
          rotateGenerations(filePath)
          stats.rotated += 1
        } catch {
          stats.rotationFailures += 1
        }
      }
      if (bytesOnDisk(filePath) > MAX_CEILING_BYTES) {
        // Rotation has been failing and the file is already four ceilings deep.
        // The test is on the FILE, not on "this line would not fit": the old
        // arithmetic dropped the very first line of a fresh log when that line
        // was large, so the file was never created and the event was lost for
        // good. Dropping now costs at most one line of overshoot.
        stats.droppedLines += 1
        return
      }
      appendLine(line)
    } catch (error) {
      noteFailure(error)
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