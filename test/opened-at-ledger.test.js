// The read-ledger sync (0.4.33): each phone mirrors its
// `dsh-pocket-opened-at` map up to `POST /api/opened-at`, the bridge keeps one
// ledger per device fingerprint, and the cold-open census counts
// 「推进完了但消息还没有读」 over the REQUESTING device's copy. This file pins the
// whole chain — store round-trip, per-device isolation, the upload route, and
// the landing decision that was the 2026-10-12 report's actual complaint
// (three finished-unread conversations; the bridge counted 1 and jumped).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { httpFetch, startBridge } from './helpers.js'
import {
  createDefaultOpenedAtStore,
  openedAtStorePath,
  readOpenedAtDocument,
  sanitizeOpenedAtLedger,
  writeOpenedAtDocument,
} from '../lib/opened-at-store.js'

function tempDataDir() {
  return mkdtempSync(join(tmpdir(), 'pocket-opened-at-'))
}

const MINUTE = 60 * 1000
const ago = (minutes) => Date.now() - Math.round(minutes * MINUTE)
// Finished 9 minutes ago, nothing running, no error, nobody asking: exactly the
// 「推进完了但消息还没有读」 shape. `updatedRecent` matters — these must sit inside
// the never-opened recency window for the census below.
const quietRow = (id) => ({ sessionId: id, updatedAt: ago(9), running: false, blank: false })

// ----------------------------------------------------------------- the store

test('sanitize keeps only sane ledger entries and prunes to the oldest', () => {
  const now = Date.now()
  const clean = sanitizeOpenedAtLedger({
    good: now - 1000,
    zero: 0,
    negative: -5,
    float: 1.5,
    notANumber: 'x',
    futureSkew: now + 4 * 60 * 1000,
    tooFarFuture: now + 60 * 60 * 1000,
    '': now,
    [ 'x'.repeat(201) ]: now,
  }, now)
  assert.deepEqual(clean, { good: now - 1000, futureSkew: now + 4 * 60 * 1000 },
    'a positive whole timestamp within clock-skew is the whole whitelist')

  const flood = {}
  for (let i = 0; i < 600; i += 1) flood['s' + i] = now - i * 1000
  assert.equal(Object.keys(sanitizeOpenedAtLedger(flood, now)).length, 500)
  const kept = sanitizeOpenedAtLedger(flood, now)
  assert.equal(kept.s0, now, 'the newest entries survive the cap')
  assert.equal(kept.s599, undefined, 'the oldest go first')
})

test('the document round-trips and a corrupt file reads as empty', () => {
  const dataDir = tempDataDir()
  try {
    const store = createDefaultOpenedAtStore(dataDir)
    assert.deepEqual(store.load().devices, {}, 'a missing file is an empty census, not an error')

    const document_ = { version: 1, savedAt: 1234, devices: { fp1: { s1: 42 } } }
    assert.equal(store.save(document_), true)
    assert.deepEqual(readOpenedAtDocument(store.filePath), document_)

    writeFileSync(store.filePath, 'not json at all', 'utf8')
    assert.deepEqual(readOpenedAtDocument(store.filePath).devices, {}, 'garbage is ignored, never thrown')

    writeFileSync(store.filePath, '{"devices":{"fp2":{"a":-3,"b":0}}}', 'utf8')
    const repaired = readOpenedAtDocument(store.filePath)
    assert.deepEqual(repaired.devices, {}, 'a ledger with zero sane entries does not survive the read')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// --------------------------------------------------- the bridge's ledger half

test('the upload persists per device and survives a new bridge over the same store', async () => {
  const dataDir = tempDataDir()
  try {
    const filePath = openedAtStorePath(dataDir)
    const ledger = { a: ago(60), b: ago(60) }
    const first = await startBridge({ bridgeOptions: { openedAtStore: createDefaultOpenedAtStore(dataDir) } })
    try {
      first.bridge.noteOpenedAtLedger('fp-phone', ledger)
      first.bridge.flushOpenedAtPersist()
      assert.equal(existsSync(filePath), true, 'the flush lands the document on disk')
      assert.deepEqual(readOpenedAtDocument(filePath).devices['fp-phone'], ledger)
      assert.deepEqual(first.bridge.openedAtLedgerFor({ headers: {} }), {},
        'an unidentified request has no ledger, so it can never read another phone\'s')
    } finally {
      await first.stop()
    }

    // The restart boundary the whole feature exists for: a NEW store instance
    // (what a desktop restart constructs) reads the same document back.
    const reopened = createDefaultOpenedAtStore(dataDir).load()
    assert.deepEqual(reopened.devices['fp-phone'], ledger, 'a restart must not forget what was read')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------ the route, over HTTP

test('the upload route stores per device, refuses garbage, and the landing obeys the synced ledger', async () => {
  const dataDir = tempDataDir()
  try {
    const first = await startBridge({ bridgeOptions: { openedAtStore: createDefaultOpenedAtStore(dataDir) } })
    try {
      const { bridge, base } = first
      const cookie = await first.pairMobile('LandingCensus/1.0')
      // Four quiet, fresh finishes: over the threshold before anything syncs.
      bridge.workspaceSnapshot = { items: [] }
      bridge.cachedSessionList = async () => ({
        ok: true,
        value: { items: [quietRow('a'), quietRow('b'), quietRow('c'), quietRow('d')] },
      })

      const headers = { cookie, origin: base, 'content-type': 'application/json' }
      const doc = await httpFetch(`${base}/`, { headers: { cookie } })
      assert.doesNotMatch(await doc.text(), /<body class="chat-open">/,
        'four fresh unread finishes crowd the landing before any ledger exists')

      const bad = await httpFetch(`${base}/api/opened-at`, { method: 'POST', headers, body: 'not json' })
      assert.equal(bad.status, 400, 'a hostile body is refused, never parsed into trust')

      const wrong = await httpFetch(`${base}/api/opened-at`, { method: 'POST', headers, body: JSON.stringify({ openedAt: 'a string' }) })
      assert.equal(wrong.status, 400, 'a ledger that is not a map is refused')

      const cross = await httpFetch(`${base}/api/opened-at`, {
        method: 'POST',
        headers: { ...headers, origin: 'https://evil.example' },
        body: JSON.stringify({ openedAt: {} }),
      })
      assert.equal(cross.status, 403, 'cross-site uploads are refused at the same gate as every other POST')

      const upload = await httpFetch(`${base}/api/opened-at`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ openedAt: { a: ago(1), b: ago(1), c: ago(1), d: ago(1) } }),
      })
      assert.equal(upload.status, 200)
      assert.deepEqual(await upload.json(), { ok: true, entries: 4 })
      bridge.flushOpenedAtPersist()

      const doc2 = await httpFetch(`${base}/`, { headers: { cookie } })
      const markup2 = await doc2.text()
      assert.match(markup2, /<body class="chat-open">/,
        'the same list, all four synced as read → the landing is calm and opens the newest')
      assert.match(first.logs.map((l) => l.message).join('\n'), /ledger=4/,
        'the doc line names the ledger size, so a real-device check can see the sync landed')
    } finally {
      await first.stop()
    }

    // Restart over the same data directory: the ledger must outlive the process,
    // and a DIFFERENT device (other UA → other fingerprint) must not inherit it.
    const second = await startBridge({ bridgeOptions: { openedAtStore: createDefaultOpenedAtStore(dataDir) } })
    try {
      const { bridge, base } = second
      bridge.workspaceSnapshot = { items: [] }
      bridge.cachedSessionList = async () => ({
        ok: true,
        value: { items: [quietRow('a'), quietRow('b'), quietRow('c'), quietRow('d')] },
      })

      const samePhone = await second.pairMobile('LandingCensus/1.0')
      const doc = await httpFetch(`${base}/`, { headers: { cookie: samePhone } })
      assert.match(await doc.text(), /<body class="chat-open">/,
        'a restart keeps the read ledger — the cold open IS the after-restart navigation')

      const otherPhone = await second.pairMobile('OtherHandset/2.0')
      const otherDoc = await httpFetch(`${base}/`, { headers: { cookie: otherPhone } })
      assert.doesNotMatch(await otherDoc.text(), /<body class="chat-open">/,
        'and another device with no synced ledger still sees four waiting conversations')
    } finally {
      await second.stop()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
