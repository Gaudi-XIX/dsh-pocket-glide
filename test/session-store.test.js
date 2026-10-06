// Durable sessions (lib/session-store.js): a pairing must survive a restart.
// The phone's cookie already lasts 30 days; before the store, the server-side
// session maps died with the process, so every host restart forced the whole
// PIN → desktop-confirm → consent funnel back onto a phone holding a perfectly
// valid cookie.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge, httpFetch } from './helpers.js'
import { createSessionStore, sessionsStorePath, SESSIONS_FILE_NAME } from '../lib/session-store.js'
import { MOBILE_COOKIE_TTL_MS } from '../lib/constants.js'

function tempDataDir() {
  return mkdtempSync(join(tmpdir(), 'pocket-sessions-'))
}

test('a pairing survives a full bridge restart; the phone never re-pairs', async () => {
  const dataDir = tempDataDir()
  try {
    const first = await startBridge({ bridgeOptions: { sessionStore: createSessionStore(dataDir) } })
    let cookie
    try {
      cookie = await first.pairMobile()
      // The debounced persist hangs off syncConnected; flush it now instead of
      // waiting the 500ms window.
      first.bridge.flushSessionPersist()
      assert.equal(first.bridge.sessions.size, 1)
    } finally {
      await first.stop()
    }

    // A new bridge process over the same data directory: the restored session
    // must authorize the phone's own cookie with no pairing funnel.
    const second = await startBridge({ bridgeOptions: { sessionStore: createSessionStore(dataDir) } })
    try {
      assert.equal(second.bridge.sessions.size, 1, 'the pairing record comes back')
      const res = await httpFetch(`${second.base}/api/status`, { headers: { cookie } })
      assert.equal(res.status, 200, 'the phone is in, no PIN asked')
    } finally {
      await second.stop()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('stop() persists instead of wiping: the file outlives the bridge', async () => {
  const dataDir = tempDataDir()
  try {
    const t = await startBridge({ bridgeOptions: { sessionStore: createSessionStore(dataDir) } })
    await t.pairMobile()
    await t.stop()
    const doc = JSON.parse(await import('node:fs').then((m) => m.readFileSync(sessionsStorePath(dataDir), 'utf8')))
    assert.equal(doc.sessions.length, 1, 'the pairing is on disk after stop')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('expired records are not resurrected by a restart', async () => {
  const dataDir = tempDataDir()
  try {
    const t = await startBridge({ bridgeOptions: { sessionStore: createSessionStore(dataDir) } })
    const now = t.bridge.now()
    writeFileSync(sessionsStorePath(dataDir), JSON.stringify({
      version: 1,
      savedAt: now,
      sessions: [
        ['live-token', { token: 'live-token', remoteAddress: '192.168.1.5', label: 'phone', issuedAt: now, expiresAt: now + MOBILE_COOKIE_TTL_MS }],
        ['dead-token', { token: 'dead-token', remoteAddress: '192.168.1.6', label: 'phone', issuedAt: now - MOBILE_COOKIE_TTL_MS, expiresAt: now - 1000 }],
      ],
      suspended: [],
      resumable: [],
    }))
    t.bridge.restorePersistedSessions()
    assert.ok(t.bridge.sessions.has('live-token'))
    assert.equal(t.bridge.sessions.has('dead-token'), false, 'an expired record stays dead')
    await t.stop()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a corrupt document reads as an empty slate, never a throw', async () => {
  const dataDir = tempDataDir()
  try {
    writeFileSync(join(dataDir, SESSIONS_FILE_NAME), '{not json at all')
    const t = await startBridge({ bridgeOptions: { sessionStore: createSessionStore(dataDir) } })
    try {
      assert.equal(t.bridge.sessions.size, 0)
      assert.equal(t.bridge.suspendedSessions.size, 0)
    } finally {
      await t.stop()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('the sanitizer drops malformed entries and caps each map at DEVICE_MAP_CAP', () => {
  const dataDir = tempDataDir()
  try {
    const entries = []
    for (let i = 0; i < 25; i++) entries.push([`t${i}`, { token: `t${i}`, expiresAt: 9e15 }])
    entries.push(['bad', 'not-an-object'], [['deeply', 'nested'], {}], ['', {}])
    writeFileSync(sessionsStorePath(dataDir), JSON.stringify({ version: 1, savedAt: 0, sessions: entries, suspended: [], resumable: [] }))
    const store = createSessionStore(dataDir)
    const doc = store.load(0)
    assert.equal(doc.sessions.length, 16, 'capped at DEVICE_MAP_CAP')
    assert.ok(doc.sessions.every(([token, record]) => typeof token === 'string' && typeof record === 'object'))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// R1 reflux (change 2026-10-07-fix-pocket-r1-reflux-batch, item 3): a read
// failure must never escalate into an empty-slate overwrite. A transient lock
// (AV scanner, indexer) used to load as empty maps indistinguishable from a
// genuinely absent file, and the next save wiped every pairing token. The
// store now flags "occupant exists but unreadable" and refuses an empty first
// save; ENOENT stays a genuine empty store (first-install path).
// ---------------------------------------------------------------------------

const emptyState = (savedAt = 0) => ({ sessions: new Map(), suspendedSessions: new Map(), resumableSessions: new Map(), savedAt })

test('AC3.1 an unreadable store refuses to overwrite a healthy document with an empty slate', () => {
  const dataDir = tempDataDir()
  try {
    const now = Date.now()
    const healthy = JSON.stringify({
      version: 1,
      savedAt: now,
      sessions: [
        ['kept-token', { token: 'kept-token', remoteAddress: '192.168.1.9', label: 'phone', issuedAt: now, expiresAt: now + MOBILE_COOKIE_TTL_MS }],
      ],
      suspended: [],
      resumable: [],
    })
    writeFileSync(sessionsStorePath(dataDir), healthy)

    const ebusy = () => {
      const error = new Error('boom')
      error.code = 'EBUSY'
      throw error
    }
    const store = createSessionStore(dataDir, { readFile: ebusy })
    const doc = store.load(now)
    assert.equal(doc.sessions.length, 0, 'a failed read still loads as empty maps (never a throw)')

    assert.equal(store.save(emptyState(now)), false, 'an empty first save after a failed read is refused')
    assert.equal(readFileSync(sessionsStorePath(dataDir), 'utf8'), healthy, 'the healthy document is untouched, byte for byte')

    const fresh = {
      sessions: new Map([['new-token', { token: 'new-token', remoteAddress: '192.168.1.9', label: 'phone', issuedAt: now, expiresAt: now + MOBILE_COOKIE_TTL_MS }]]),
      suspendedSessions: new Map(),
      resumableSessions: new Map(),
      savedAt: now,
    }
    assert.equal(store.save(fresh), true, 'real state may persist — the unreadable file is already stale (documented sacrifice)')
    assert.ok(readFileSync(sessionsStorePath(dataDir), 'utf8').includes('new-token'), 'and the new pairing is on disk')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('AC3.2 a directory squatting on the store path loads empty and keeps its first empty save refused', () => {
  const dataDir = tempDataDir()
  try {
    mkdirSync(sessionsStorePath(dataDir))
    const store = createSessionStore(dataDir)
    const doc = store.load(0)
    assert.equal(doc.sessions.length, 0, 'EISDIR reads as an empty slate, never a throw')
    assert.equal(store.save(emptyState()), false, 'the unverified empty state must not fight the occupant')
    assert.equal(statSync(sessionsStorePath(dataDir)).isDirectory(), true, 'the occupant is still exactly where it was')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('AC3.3 a missing file is a genuine empty store: the first empty save still writes', () => {
  const dataDir = tempDataDir()
  try {
    const store = createSessionStore(dataDir)
    const doc = store.load(0)
    assert.equal(doc.sessions.length, 0, 'absent file reads as empty')
    assert.equal(store.save(emptyState()), true, 'ENOENT is not a read failure — first-install saves are not blocked')
    assert.ok(existsSync(sessionsStorePath(dataDir)), 'the empty document landed on disk')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
