// Persist only when the document moved (2026-10-17).
//
// Why this exists: every bridge request ends in syncConnected() ->
// scheduleSessionPersist(), and a phone parked on the landing page polls for as
// long as its tab is open. The debounce merged those calls but still rewrote
// the whole durable document (session maps + device registry) every 500ms —
// hundreds of identical rewrites per hour, each one a temp file + rename, with
// the odd `session persist failed` warn when a transient lock hit one.
//
// What must stay true:
//   1. an unchanged document is not written at all;
//   2. a changed session record is written;
//   3. a changed device record is written (it rides the same document);
//   4. a failed save is retried on the next call, not remembered as done;
//   5. stop() forces a write at the restart boundary, where the maps are about
//      to be cleared and the file must be current whatever the stamp says;
//   6. savedAt alone never counts as a change.
//
// Reverse injection (run 2026-10-17, restored afterwards): making the
// comparison in saveSessionsIfChanged() unconditionally false (i.e. always
// "changed") turns cases 1 and 6 red; removing the `!saved` early return in
// case 4 makes case 4 red; dropping `force` from stop()'s flush turns case 5
// red.
import test from 'node:test'
import assert from 'node:assert/strict'
import { LanMobileBridge } from '../lib/bridge.js'
import { SESSION_PERSIST_DEBOUNCE_MS } from '../lib/constants.js'

/** A store double that records every save and can be told to fail. */
function makeStore({ fail = false } = {}) {
  const store = {
    saves: [],
    failing: fail,
    save(state) {
      store.saves.push(structuredClone(state))
      return !store.failing
    },
    load() {
      return { sessions: [], suspended: [], resumable: [], devices: [] }
    },
  }
  return store
}

function makeBridge({ store }) {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = []
  bridge.log = (level, message) => bridge.logs.push({ level, message })
  bridge.now = () => 1_700_000_000_000
  bridge.sessionStore = store
  bridge.sessionPersistTimer = undefined
  bridge.lastPersistFingerprint = undefined
  bridge.sessions = new Map()
  bridge.suspendedSessions = new Map()
  bridge.resumableSessions = new Map()
  bridge.devices = new Map()
  return bridge
}

/** Run the debounced persist to completion, then disarm. */
async function flushDebounced(bridge) {
  bridge.flushSessionPersist()
}

test('an unchanged document is never rewritten', async () => {
  const store = makeStore()
  const bridge = makeBridge({ store })
  bridge.sessions.set('s1', { sessionId: 's1', title: 'one', updatedAt: 10 })

  bridge.scheduleSessionPersist()
  await flushDebounced(bridge)
  assert.equal(store.saves.length, 1, 'the first pass writes the real state')

  // The real shape of the bug: a request funnels through a debounce that a
  // later flush takes over. Twenty rounds of that must stay silent.
  for (let i = 0; i < 20; i += 1) {
    bridge.scheduleSessionPersist()
    await flushDebounced(bridge)
  }
  assert.equal(store.saves.length, 1, 'twenty rounds on the same content wrote nothing')
})

test('savedAt alone is not a change: the stamp never makes an identical file dirty', async () => {
  const store = makeStore()
  const bridge = makeBridge({ store })
  bridge.sessions.set('s1', { sessionId: 's1', updatedAt: 10 })
  let clock = 1_700_000_000_000
  bridge.now = () => (clock += 500)
  bridge.saveSessionsIfChanged()
  bridge.scheduleSessionPersist()
  await flushDebounced(bridge)
  bridge.scheduleSessionPersist()
  await flushDebounced(bridge)
  assert.equal(store.saves.length, 1, 'a moving clock is not content')
})

test('a changed session record is written', async () => {
  const store = makeStore()
  const bridge = makeBridge({ store })
  bridge.sessions.set('s1', { sessionId: 's1', title: 'one', updatedAt: 10 })
  bridge.saveSessionsIfChanged()
  assert.equal(store.saves.length, 1)

  bridge.sessions.get('s1').updatedAt = 11
  bridge.saveSessionsIfChanged()
  assert.equal(store.saves.length, 2, 'an edited record is content, not noise')
})

test('a changed device record is written — it rides the same document', async () => {
  const store = makeStore()
  const bridge = makeBridge({ store })
  bridge.saveSessionsIfChanged()
  assert.equal(store.saves.length, 1)

  bridge.devices.set('d1', { deviceId: 'd1', lastSeenAt: 5 })
  bridge.saveSessionsIfChanged()
  assert.equal(store.saves.length, 2, 'a pairing while every session is idle must still land')
})

test('a re-inserted record is not a change: order alone does not rewrite', async () => {
  const store = makeStore()
  const bridge = makeBridge({ store })
  bridge.sessions.set('s1', { sessionId: 's1', updatedAt: 1 })
  bridge.sessions.set('s2', { sessionId: 's2', updatedAt: 2 })
  bridge.saveSessionsIfChanged()
  assert.equal(store.saves.length, 1)

  const first = bridge.sessions.get('s1')
  bridge.sessions.delete('s1')
  bridge.sessions.set('s1', first)
  bridge.saveSessionsIfChanged()
  assert.equal(store.saves.length, 1, 'same records, different Map order, same file')
})

test('a failed save is retried on the next call, never remembered as done', async () => {
  const store = makeStore({ fail: true })
  const bridge = makeBridge({ store })
  bridge.sessions.set('s1', { sessionId: 's1', updatedAt: 10 })

  bridge.saveSessionsIfChanged()
  assert.equal(store.saves.length, 1)
  assert.equal(bridge.lastPersistFingerprint, undefined, 'a failed write leaves no stamp')
  assert.ok(
    bridge.logs.some((entry) => entry.message === 'session persist failed'),
    'the refusal keeps its existing warn',
  )

  store.failing = false
  bridge.saveSessionsIfChanged()
  assert.equal(store.saves.length, 2, 'the retry went out')
  assert.notEqual(bridge.lastPersistFingerprint, undefined)

  bridge.saveSessionsIfChanged()
  assert.equal(store.saves.length, 2, 'and now the unchanged document is quiet again')
})

test('flushSessionPersist at stop() writes even when nothing moved', async () => {
  const store = makeStore()
  const bridge = makeBridge({ store })
  bridge.sessions.set('s1', { sessionId: 's1', updatedAt: 10 })
  bridge.saveSessionsIfChanged()
  assert.equal(store.saves.length, 1)

  // The teardown path forces the write: the maps get cleared right after, so
  // the file on disk has to be current whatever the stamp says.
  bridge.scheduleSessionPersist()
  assert.notEqual(bridge.sessionPersistTimer, undefined)
  assert.equal(bridge.flushSessionPersist({ force: true }), true)
  assert.equal(bridge.sessionPersistTimer, undefined, 'the timer is disarmed')
  assert.equal(store.saves.length, 2, 'stop() writes on principle, once, at exit')
})

test('a bare flush of an unchanged timer is silent but still disarms', async () => {
  const store = makeStore()
  const bridge = makeBridge({ store })
  bridge.sessions.set('s1', { sessionId: 's1', updatedAt: 10 })
  bridge.saveSessionsIfChanged()
  assert.equal(store.saves.length, 1)

  bridge.scheduleSessionPersist()
  assert.equal(bridge.flushSessionPersist(), false)
  assert.equal(bridge.sessionPersistTimer, undefined, 'the pending timer is not left to fire later')
  assert.equal(store.saves.length, 1, 'and the unchanged document stays on disk untouched')
})

test('the debounce still batches: many schedules in one window cost one write', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const store = makeStore()
  const bridge = makeBridge({ store })
  bridge.sessions.set('s1', { sessionId: 's1', updatedAt: 10 })
  for (let i = 0; i < 5; i += 1) bridge.scheduleSessionPersist()
  t.mock.timers.tick(SESSION_PERSIST_DEBOUNCE_MS)
  assert.equal(store.saves.length, 1, 'five schedules inside the window collapse to one write')
})
