// WP-OPS-BRIDGE B2 / X4⑥ — the file logger's rotation accounting, plus the
// R12/Q8 data root that the LEAD pulled into this first batch.
//
// Why each case exists:
//  * `rename` used to leave the byte counter at 0, so a failed rotation made the
//    logger believe a 512KB file was empty — silent, unbounded growth reported as
//    if it were bounded.
//  * The count was per-logger, so two host processes sharing one pocket.log each
//    tracked only their own lines and neither ever rotated the other's.
//  * `DSH_HOME` was honoured by this module only: an "isolated" run still read
//    and wrote the machine's real durable pairing password.
// All paths here are temp directories; nothing real is touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createFileLogger } from '../lib/file-log.js'
import { defaultDshHome, pocketDataDir } from '../lib/constants.js'
import {
  createDefaultPairingPinStore,
  pairingPinReadPaths,
  pairingPinStorePath,
  readPairingPinState,
} from '../lib/pin-store.js'

const MAX_BYTES = 512 * 1024
const ENV_KEYS = ['DSH_HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'HOME']

function saveEnv() {
  const saved = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  return saved
}

function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}

function tempRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Put `bytes` of unrelated content in the log file without using the logger. */
function seed(filePath, bytes) {
  const chunk = Buffer.from('y'.repeat(1024), 'utf8')
  const parts = []
  for (let written = 0; written < bytes; written += chunk.length) parts.push(chunk)
  writeFileSync(filePath, Buffer.concat(parts).subarray(0, bytes))
  return bytes
}

test('a fresh logger rotates on its first write when the file is already over the ceiling', () => {
  // Two host processes sharing one pocket.log: process B opens after A has
  // filled the file. A per-logger counter would start B at zero and never
  // rotate, which is how the audit found the log growing past every stated
  // ceiling while both writers counted happily.
  const root = tempRoot('pocket-filelog-shared-')
  try {
    const file = join(root, 'pocket.log')
    seed(file, 520 * 1024)
    const late = createFileLogger(file)
    late.info('from the second process')
    assert.ok(existsSync(`${file}.1`), 'the bytes another process wrote were rotated, not appended to')
    assert.ok(statSync(`${file}.1`).size >= 520 * 1024, 'the generation kept the other process bytes')
    assert.match(readFileSync(file, 'utf8'), /from the second process/, 'and this process line was still written')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed rename keeps the real count and retries on the next line', () => {
  // `rename` onto an existing DIRECTORY fails on every platform: the portable
  // way to make rotation fail once. The old code zeroed the counter here, so the
  // file went on growing under a logger that believed it had just been truncated.
  // The cascade must keep this property: a non-file obstacle blocks the shift
  // instead of being moved out of the way by a "helpful" cleanup.
  const root = tempRoot('pocket-filelog-renamefail-')
  try {
    const file = join(root, 'pocket.log')
    mkdirSync(`${file}.1`)
    seed(file, 513 * 1024)
    const logger = createFileLogger(file)
    const before = statSync(file).size
    logger.info('first line after the ceiling')
    assert.match(readFileSync(file, 'utf8'), /first line after the ceiling/, 'a failed rotation never costs a log line')
    assert.ok(statSync(file).size > before, 'the count on disk kept growing — the logger did not believe the file was empty')
    assert.equal(statSync(`${file}.1`).isDirectory(), true, 'the blocked generation is still the directory')
    assert.ok(logger.stats().rotationFailures >= 1, 'and the failure is visible instead of silent')
    assert.equal(logger.stats().rotated, 0, 'nothing was counted as rotated')

    // Remove the obstacle. The NEXT line must rotate: only possible if the count
    // stayed honest (and is read from disk each line).
    rmSync(`${file}.1`, { recursive: true, force: true })
    logger.info('line after the obstacle went away')
    assert.ok(existsSync(`${file}.1`), 'rotation was retried as soon as the rename could succeed')
    assert.equal(statSync(`${file}.1`).isFile(), true)
    assert.match(readFileSync(`${file}.1`, 'utf8'), /first line after the ceiling/, 'the held-over lines went into the generation')
    assert.match(readFileSync(file, 'utf8'), /line after the obstacle went away/)
    assert.ok(statSync(file).size < 400 * 1024, 'the live file is back under the ceiling')
    assert.equal(logger.stats().rotated, 1, 'and the successful rotation is counted too')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// R-T4 — rotation destroyed the generation before it.
// probe-02: 3000 lines × ~400 chars -> live 364554 B, `.1` 524223 B, and 1113
// lines (MARK-1113..MARK-2225) gone after the SECOND rotation; MARK-0000 was
// already unrecoverable. "Keeps one rotated copy" was true for one cycle only.
// ---------------------------------------------------------------------------

test('R-T4: rotation keeps three generations instead of destroying the previous one', () => {
  const root = tempRoot('pocket-filelog-generations-')
  try {
    const file = join(root, 'pocket.log')
    const logger = createFileLogger(file)
    const markers = ['MARK-A', 'MARK-B', 'MARK-C', 'MARK-D', 'MARK-E']
    for (const [index, marker] of markers.entries()) {
      // A distinguishable over-ceiling generation, then one line to trigger it.
      const head = Buffer.from(`${marker}\n`, 'utf8')
      writeFileSync(file, Buffer.concat([head, Buffer.alloc(MAX_BYTES + 1024 - head.length, 0x79)]))
      logger.info(`line after ${marker}`)
      assert.equal(logger.stats().rotated, index + 1, `rotation ${index + 1} happened`)
    }

    // Five generations written, three kept: .1 is the newest rotated one and .3
    // the oldest survivor. The single-generation rename kept exactly one — after
    // five rotations it would hold MARK-E alone and MARK-C/MARK-D would be gone.
    const contentOf = (candidate) => (existsSync(candidate) ? readFileSync(candidate, 'utf8') : '')
    assert.match(contentOf(`${file}.1`), /MARK-E/, '.1 is the newest generation')
    assert.doesNotMatch(contentOf(`${file}.1`), /MARK-D/, 'and it is not also holding the one before it')
    assert.match(contentOf(`${file}.2`), /MARK-D/, '.2 is the generation before that')
    assert.match(contentOf(`${file}.3`), /MARK-C/, '.3 survived three later rotations — the old code lost it on the second')
    assert.doesNotMatch(contentOf(file), /^MARK-[A-E]$/m, 'the live file only holds lines written after the last rotation')
    assert.ok(statSync(file).size < MAX_BYTES, 'and the rotated-away bulk is not still sitting in it')
    assert.match(contentOf(file), /line after MARK-E/)
    assert.ok(!existsSync(`${file}.4`), 'the cascade is bounded — nothing beyond the kept generations')
    assert.ok(!existsSync(join(root, 'pocket.log.1.1')), 'the cascade renames whole names, it does not nest them')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R-T4: a stray non-file at a generation name blocks that shift but never deletes anything', () => {
  // The bounded cleanup may only remove regular files it recognises by name. A
  // directory sitting at `.3` must not be recursively deleted by a logger.
  const root = tempRoot('pocket-filelog-generations-dir-')
  try {
    const file = join(root, 'pocket.log')
    mkdirSync(`${file}.3`)
    writeFileSync(join(`${file}.3`, 'keep.txt'), 'do not delete me')
    seed(file, 513 * 1024)
    const logger = createFileLogger(file)
    logger.info('rotate with a directory parked at the oldest generation')
    assert.equal(existsSync(join(`${file}.3`, 'keep.txt')), true, 'a directory at a generation name is left alone')
    assert.ok(existsSync(`${file}.1`), 'the rest of the cascade still moved down')
    assert.ok(logger.stats().rotated >= 1, 'and the rotation that did happen is counted')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// R-T5 — the bare outer catch swallowed mkdir/append failures with zero trace.
// probe-12 A: the log DIRECTORY path occupied by a regular file + 50 writes ->
// stats() all zeros, nothing on disk. B: a read-only file -> the same.
// C: 5000 lines took 1788 ms (0.358 ms/line) because mkdirSync ran per line.
// ---------------------------------------------------------------------------

test('R-T5: a log directory that cannot be created is counted, not silently ignored', () => {
  const root = tempRoot('pocket-filelog-baddir-')
  try {
    const blocker = join(root, 'logs')
    writeFileSync(blocker, 'a regular file where the directory should go')
    const file = join(blocker, 'pocket.log')
    const logger = createFileLogger(file)
    for (let index = 0; index < 50; index += 1) logger.info(`write ${index}`)
    const stats = logger.stats()
    assert.equal(existsSync(file), false, 'nothing could be written — the directory is a file')
    assert.equal(stats.writeFailures, 50, 'every failed write is counted, not swallowed')
    assert.match(stats.lastWriteError, /^[A-Z]+: /, `the first failure is kept as CODE: message (${stats.lastWriteError})`)
    assert.ok(stats.lastWriteError.length <= 210, 'and the message is clipped, not the whole error')
    assert.equal(stats.droppedLines, 0, 'a write failure is not a rotation drop')
    assert.equal(stats.bytes, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R-T5: a failing append is counted once per line and never re-warns', () => {
  const root = tempRoot('pocket-filelog-appendfail-')
  const warnings = []
  const onWarning = (warning) => warnings.push(String(warning.message ?? warning))
  try {
    const file = join(root, 'pocket.log')
    const logger = createFileLogger(file)
    logger.info('this one works and creates the file')
    // A directory at the live path makes every later appendFileSync fail
    // (EISDIR/EPERM), which is the failure the bare catch used to eat.
    rmSync(file, { force: true })
    mkdirSync(file)
    process.on('warning', onWarning)
    for (let index = 0; index < 5; index += 1) logger.info(`cannot land ${index}`)
    process.off('warning', onWarning)
    const stats = logger.stats()
    assert.equal(stats.writeFailures, 5, 'each failed append is counted')
    assert.ok(stats.lastWriteError !== null, 'and the error is kept for the next reader')
    assert.ok(warnings.filter((text) => text.includes('pocket file log cannot write')).length <= 1, `warned at most once: ${JSON.stringify(warnings)}`)
    assert.equal(stats.rotated, 0, 'no rotation was involved')
  } finally {
    process.off('warning', onWarning)
    rmSync(root, { recursive: true, force: true })
  }
})

test('R-T5: the logger heals when its directory disappears mid-run, and counts the failure once', () => {
  // `dirReady` is a fast path, not a claim about the world: the data root can be
  // moved or cleaned underneath a long-lived host process. The old code ran
  // `mkdirSync` per line (0.358 ms/line, probe-12 C); the memoized version must
  // still notice the directory is gone and rebuild it rather than failing for
  // ever on a stale flag.
  const root = tempRoot('pocket-filelog-mkdir-')
  try {
    const dir = join(root, 'logs')
    const file = join(dir, 'pocket.log')
    const logger = createFileLogger(file)
    logger.info('first')
    assert.equal(logger.stats().writeFailures, 0, 'the first write established the directory')

    // Replace the directory with a regular file: appends fail, and the heal
    // attempt cannot succeed either. Exactly one failure is recorded for the
    // line, not two (the retry must not double-count).
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, 'now a file')
    logger.info('second')
    assert.equal(logger.stats().writeFailures, 1, 'one failed line is counted once')

    // Remove the obstacle: the NEXT line must heal and land, not stay broken.
    rmSync(dir, { force: true })
    logger.info('third')
    const stats = logger.stats()
    assert.equal(stats.writeFailures, 1, 'the healed write is not a failure')
    assert.match(readFileSync(file, 'utf8'), /third/, 'the line written after the directory was rebuilt landed')
    assert.ok(!readFileSync(file, 'utf8').includes('second'), 'the line that could not land was not silently invented later')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// R-T11 — one over-long line dropped the event AND, on a fresh logger, meant the
// file was never created. probe-02 tail: one >2 MiB message -> droppedLines: 1,
// exists=false bytes=0; a following normal line then created an 82-byte file.
// ---------------------------------------------------------------------------

test('R-T11: an over-long line is truncated and kept, and the file is still created', () => {
  const root = tempRoot('pocket-filelog-truncate-')
  try {
    const file = join(root, 'pocket.log')
    const logger = createFileLogger(file)
    const huge = `HEAD${'h'.repeat(3 * 1024 * 1024)}TAIL`
    logger.info(huge)
    const stats = logger.stats()
    assert.equal(existsSync(file), true, 'the file is created even for an over-long message')
    assert.equal(stats.droppedLines, 0, 'the line is no longer thrown away')
    assert.equal(stats.truncatedLines, 1, 'and the truncation is visible in stats()')
    assert.equal(stats.writeFailures, 0, 'truncating is not a write failure')
    const written = readFileSync(file, 'utf8')
    const parsed = JSON.parse(written.trim())
    assert.equal(parsed.level, 'info', 'the JSON line is still valid')
    assert.ok(parsed.message.startsWith('HEAD'), 'the beginning of the message is kept')
    assert.ok(parsed.message.endsWith('…[truncated]'), `and the cut is announced: ${parsed.message.slice(-20)}`)
    assert.ok(Buffer.byteLength(written, 'utf8') <= 32 * 1024 + 64, `one line stays bounded: ${Buffer.byteLength(written, 'utf8')} bytes`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R-T11: a line is dropped only once the FILE is already past the hard ceiling', () => {
  const root = tempRoot('pocket-filelog-drop-')
  try {
    const file = join(root, 'pocket.log')
    mkdirSync(`${file}.1`)
    seed(file, MAX_BYTES * 4 - 40)
    const logger = createFileLogger(file)
    const before = statSync(file).size
    // One bounded line onto a file that is already past the ceiling: it is
    // written (the file overshoots by at most that line), NOT dropped — the old
    // arithmetic tested `bytes + line.length`, which is how a large first line
    // on a fresh log meant "drop the event and never create the file at all".
    logger.info('over the ceiling but the file exists')
    const after = logger.stats()
    assert.equal(after.droppedLines, 0, 'the file was not yet past the ceiling, so nothing is dropped')
    assert.equal(after.writeFailures, 0, 'and the write landed')
    assert.ok(statSync(file).size > before, 'the line was written')

    // Now push the file past the ceiling and confirm the next line IS dropped.
    seed(file, MAX_BYTES * 4 + 1024)
    const ceiling = statSync(file).size
    logger.info('this one has to go')
    const dropped = logger.stats()
    assert.ok(dropped.droppedLines >= 1, 'past the ceiling the line is refused instead of growing the file')
    assert.equal(statSync(file).size, ceiling, 'and the file does not grow further')
    assert.ok(dropped.rotationFailures >= 1, 'the blocked rotation is still counted')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R-T11: a fresh log gets its first line even when the file is gone and rotation is broken', () => {
  // The exact probe-02 tail: one over-long message on a brand-new logger used to
  // be dropped, and because the file did not exist the drop also meant the log
  // file was never created (exists=false bytes=0).
  const root = tempRoot('pocket-filelog-fresh-')
  try {
    const file = join(root, 'pocket.log')
    mkdirSync(`${file}.1`)
    const logger = createFileLogger(file)
    logger.info('x'.repeat(3 * 1024 * 1024))
    assert.equal(existsSync(file), true, 'the log file exists after one huge message')
    assert.equal(logger.stats().droppedLines, 0, 'and the message was not dropped')
    assert.equal(logger.stats().truncatedLines, 1, 'it was truncated to the line cap instead')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('stats reports the on-disk size and a rotation that never happened', () => {
  const root = tempRoot('pocket-filelog-stats-')
  try {
    const file = join(root, 'pocket.log')
    seed(file, 50 * 1024)
    const logger = createFileLogger(file)
    logger.info('one more line')
    const stats = logger.stats()
    assert.ok(stats.bytes >= 50 * 1024, 'the bytes include what another writer put there')
    assert.equal(stats.rotationFailures, 0, 'nothing was attempted, so nothing failed quietly')
    assert.equal(stats.rotated, 0, 'and no rotation happened')
    assert.equal(stats.droppedLines, 0, 'and no line was lost')
    assert.equal(stats.truncatedLines, 0, 'nor shortened')
    assert.equal(stats.writeFailures, 0, 'and every write landed')
    assert.equal(stats.lastWriteError, null, 'so there is no error to report')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// The old "a permanently broken rotation is bounded" case lived here; R-T11
// changed what "bounded" means (the file is the bound, not the incoming line),
// so its scenario now lives in the R-T11 test below with the new semantics.

// ---------------------------------------------------------------------------
// R12 / Q8 (LEAD C-4): one data root for the log, the pairing password and the
// tunnel cache. Isolation has to be real, and the machine's existing durable
// password has to survive the unification in place.
// ---------------------------------------------------------------------------

test('DSH_HOME in force: the isolated root is the only thing Pocket touches', () => {
  const isolated = tempRoot('pocket-dshhome-')
  const fakeLegacy = tempRoot('pocket-legacy-')
  const fakeHome = tempRoot('pocket-home-')
  const saved = saveEnv()
  try {
    // A durable password sitting where the pre-unification store kept it.
    const legacyPin = pairingPinStorePath(join(fakeLegacy, 'dsh-pocket'))
    mkdirSync(dirname(legacyPin), { recursive: true })
    writeFileSync(legacyPin, JSON.stringify({ pin: '246810', pinConsent: true }))

    process.env.DSH_HOME = isolated
    process.env.LOCALAPPDATA = fakeLegacy
    process.env.XDG_CACHE_HOME = fakeLegacy
    process.env.USERPROFILE = fakeHome
    process.env.HOME = fakeHome

    assert.equal(defaultDshHome(), isolated, 'DSH_HOME wins over the home fallback')
    assert.equal(pocketDataDir(), join(isolated, 'pocket'), 'one resolver for all three consumers')

    const paths = pairingPinReadPaths()
    assert.deepEqual(paths, [join(isolated, 'pocket', 'mobile-pairing-pin.json')], 'under an override the isolated file is the only candidate')
    assert.ok(!paths.some((candidate) => candidate.startsWith(fakeLegacy)), 'no legacy path appears in the candidates')
    assert.ok(!paths.some((candidate) => candidate.startsWith(fakeHome)), 'nor the home fallback')

    const store = createDefaultPairingPinStore()
    assert.equal(store.filePath, paths[0])
    assert.deepEqual(store.load(), {}, 'the machine password was NOT read into the isolated run')
    assert.equal(readPairingPinState(legacyPin).pin, '246810', 'the isolated store did not read the machine one')
    assert.equal(existsSync(join(fakeHome, '.dsh')), false, 'and nothing reached the home fallback either')

    assert.equal(store.save({ pin: '135790', pinConsent: true }), true)
    assert.deepEqual(store.load(), { pin: '135790', pinConsent: true })
    assert.equal(readPairingPinState(legacyPin).pin, '246810', 'a save under an override never rewrites the machine copy')

    const logger = createFileLogger()
    assert.equal(logger.path, join(isolated, 'pocket', 'logs', 'pocket.log'), 'the log lives under the same override')
    logger.info('written under the override')
    assert.match(readFileSync(logger.path, 'utf8'), /written under the override/)
    assert.equal(existsSync(join(fakeHome, '.dsh', 'pocket')), false, 'no fallback root was created')
  } finally {
    restoreEnv(saved)
    rmSync(isolated, { recursive: true, force: true })
    rmSync(fakeLegacy, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('no DSH_HOME: the password stays exactly where it is, and the phone keeps working', () => {
  const fakeHome = tempRoot('pocket-home-compat-')
  const fakeLegacy = tempRoot('pocket-legacy-compat-')
  const saved = saveEnv()
  try {
    delete process.env.DSH_HOME
    process.env.LOCALAPPDATA = fakeLegacy
    process.env.XDG_CACHE_HOME = fakeLegacy
    process.env.USERPROFILE = fakeHome
    process.env.HOME = fakeHome

    const legacyPin = pairingPinStorePath(join(fakeLegacy, 'dsh-pocket'))
    mkdirSync(dirname(legacyPin), { recursive: true })
    writeFileSync(legacyPin, JSON.stringify({ pin: '246810', pinConsent: true }))

    const store = createDefaultPairingPinStore()
    assert.equal(store.filePath, legacyPin, 'the durable password is found where it already is')
    assert.deepEqual(store.load(), { pin: '246810', pinConsent: true }, 'so a paired phone is not asked to pair again')
    assert.equal(existsSync(join(fakeHome, '.dsh', 'pocket', 'mobile-pairing-pin.json')), false, 'reading migrates nothing')

    assert.equal(store.save({ pin: '246810', pinConsent: true }), true)
    assert.equal(store.filePath, legacyPin, 'and a save without an override stays in the machine location — no relocation')
    assert.equal(existsSync(join(fakeHome, '.dsh', 'pocket', 'mobile-pairing-pin.json')), false, 'nothing was copied into the unified root either')
    assert.deepEqual(readPairingPinState(legacyPin), { pin: '246810', pinConsent: true }, 'the file was rewritten in place, not moved')
    assert.deepEqual(store.load(), { pin: '246810', pinConsent: true }, 'the paired phone still authenticates')
  } finally {
    restoreEnv(saved)
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(fakeLegacy, { recursive: true, force: true })
  }
})

test('a password written by an override run is still found once the override is gone', () => {
  // The fallback rung of the read order: unified last, machine first. Without it
  // a machine that once ran `DSH_HOME=~/.dsh` would lose its own password the
  // moment somebody cleared the variable.
  const fakeHome = tempRoot('pocket-home-fallback-')
  const fakeLegacy = tempRoot('pocket-legacy-fallback-')
  const isolated = join(fakeHome, '.dsh')
  const saved = saveEnv()
  try {
    process.env.DSH_HOME = isolated
    process.env.LOCALAPPDATA = fakeLegacy
    process.env.XDG_CACHE_HOME = fakeLegacy
    const store = createDefaultPairingPinStore()
    assert.equal(store.save({ pin: '864213', pinConsent: true }), true)
    assert.equal(store.filePath, join(isolated, 'pocket', 'mobile-pairing-pin.json'), 'written under the override')

    delete process.env.DSH_HOME
    process.env.USERPROFILE = fakeHome
    process.env.HOME = fakeHome
    assert.equal(pairingPinReadPaths()[0], pairingPinStorePath(join(fakeLegacy, 'dsh-pocket')), 'machine location first')
    const back = createDefaultPairingPinStore()
    assert.deepEqual(back.load(), { pin: '864213', pinConsent: true }, 'read back through the fallback rung')
  } finally {
    restoreEnv(saved)
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(fakeLegacy, { recursive: true, force: true })
  }
})

test('the fallback order is DSH_HOME then ~/.dsh, with no third per-platform root', () => {
  const saved = saveEnv()
  try {
    delete process.env.DSH_HOME
    assert.equal(defaultDshHome(), join(homedir(), '.dsh'), 'the reference order file-log always used')
    process.env.DSH_HOME = '   '
    assert.equal(defaultDshHome(), join(homedir(), '.dsh'), 'a blank DSH_HOME is not a location')
    process.env.DSH_HOME = '/tmp/definitely-not-a-dsh-root'
    assert.equal(defaultDshHome(), '/tmp/definitely-not-a-dsh-root')
    assert.equal(pocketDataDir('logs'), join('/tmp/definitely-not-a-dsh-root', 'pocket', 'logs'))
  } finally {
    restoreEnv(saved)
  }
})
