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

    // Remove the obstacle. The NEXT line must rotate: only possible if the count
    // stayed honest (and is read from disk each line).
    rmSync(`${file}.1`, { recursive: true, force: true })
    logger.info('line after the obstacle went away')
    assert.ok(existsSync(`${file}.1`), 'rotation was retried as soon as the rename could succeed')
    assert.equal(statSync(`${file}.1`).isFile(), true)
    assert.match(readFileSync(`${file}.1`, 'utf8'), /first line after the ceiling/, 'the held-over lines went into the generation')
    assert.match(readFileSync(file, 'utf8'), /line after the obstacle went away/)
    assert.ok(statSync(file).size < 400 * 1024, 'the live file is back under the ceiling')
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
    assert.equal(stats.droppedLines, 0, 'and no line was lost')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a permanently broken rotation is bounded, and the drop is counted', () => {
  // The honest count alone would still let the file grow for ever if rotation
  // never worked. Four ceilings deep the logger drops lines and says so in
  // `stats()` rather than filling the user's disk.
  const root = tempRoot('pocket-filelog-ceiling-')
  try {
    const file = join(root, 'pocket.log')
    mkdirSync(`${file}.1`)
    seed(file, MAX_BYTES * 4 - 40)
    const logger = createFileLogger(file)
    const before = statSync(file).size
    logger.info('past every ceiling with rotation broken')
    const stats = logger.stats()
    assert.ok(stats.rotationFailures >= 1, 'the failed rename was recorded')
    assert.ok(stats.droppedLines >= 1, 'the line that could not be rotated in was dropped, not grown into')
    assert.equal(statSync(file).size, before, 'the file did not grow past the hard ceiling')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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
