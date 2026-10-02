// WP-BRIDGE-EXTRA S7 + S8 — the two maps that could only ever grow.
//
// S7 `_sessionCursors`  caches one Host projection cursor per conversation. It was
//    written on every history read and removed nowhere except `stop()`, and it sat
//    outside `sweepExpiredSessions()` — so a bridge that lived through a long
//    workspace walk kept one entry per conversation for the life of the process.
//
// S8 `pendingQuestions` holds the interactions a phone may still answer. Entries left
//    when the answer or a cancel frame came back; a handset that simply walked away
//    from a question left its entry for the rest of the session, and a Host that
//    re-issues questions without settling them grows the table without end.
//
// Both are fixed as a CEILING WITH EVICTION, not as an expiry. A question that is
// still on screen is still answerable however long it has been there (that is the
// product semantics of an interaction the user may come back to), and a cursor is
// re-derived from the session list the moment it is needed again — so neither map
// gets a TTL, and one of the assertions below exists precisely to fail if anyone
// adds one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, httpFetch } from './helpers.js'
import * as constants from '../lib/constants.js'

const SESSION_CURSOR_MAX = constants.SESSION_CURSOR_MAX
const PENDING_QUESTIONS_MAX = constants.PENDING_QUESTIONS_MAX

/**
 * A fake Harness whose session list carries a distinct cursor per row, so a history
 * read for conversation N learns — and caches — cursor N.
 */
const walkHarness = (count) => ({
  respond: (pathname) => {
    if (pathname === '/api/session/list') {
      return {
        ok: true,
        value: {
          items: Array.from({ length: count }, (_unused, index) => ({
            sessionId: `walk-${index}`,
            updatedAt: index,
            projections: { asOfSeq: 1000 + index },
          })),
        },
      }
    }
    if (pathname === '/api/session/page') return { ok: true, value: { records: [], hasMore: false } }
    return undefined
  },
})

async function historyRead(t, cookie, sessionId) {
  const res = await httpFetch(`${t.base}/api/rpc`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'session.history', payload: { sessionId, beforeSeq: 5, maxMessages: 30 } }),
  })
  return res
}

/** One question, in the carrier shape `consumeMuxEnvelope` reads. */
function questionFrame(eventId, sessionId) {
  return JSON.stringify({
    type: 'item',
    streamId: 'mobile-events',
    value: {
      type: 'waterfall',
      event: 'user-questions/request',
      eventId,
      agentId: sessionId,
      request: {
        questions: [{ id: 'q1', question: 'Which one?', options: [{ label: 'a' }, { label: 'b' }] }],
      },
    },
  })
}

// ---------------------------------------------------------------------------
// S7 — the history cursor cache
// ---------------------------------------------------------------------------

test('S7/S8: both ceilings are declared constants, not numbers buried in a branch', () => {
  assert.equal(typeof SESSION_CURSOR_MAX, 'number', 'lib/constants.js must declare SESSION_CURSOR_MAX')
  assert.equal(typeof PENDING_QUESTIONS_MAX, 'number', 'lib/constants.js must declare PENDING_QUESTIONS_MAX')
  assert.ok(Number.isInteger(SESSION_CURSOR_MAX) && SESSION_CURSOR_MAX > 0)
  assert.ok(Number.isInteger(PENDING_QUESTIONS_MAX) && PENDING_QUESTIONS_MAX > 0)
})

test('S7: walking conversations does not grow the cursor cache past its ceiling', async () => {
  const walked = SESSION_CURSOR_MAX + 6
  const t = await startBridge({ harness: 'fake', harnessOptions: walkHarness(walked) })
  try {
    const cookie = await t.pairMobile('PocketCursorWalk/1.0')
    for (let index = 0; index < walked; index += 1) {
      const res = await historyRead(t, cookie, `walk-${index}`)
      assert.equal(res.status, 200, `conversation ${index} is answered`)
      assert.ok(
        (t.bridge._sessionCursors?.size ?? 0) <= SESSION_CURSOR_MAX,
        `the cache passed its ceiling after ${index + 1} conversations`,
      )
    }
    assert.equal(t.bridge._sessionCursors.size, SESSION_CURSOR_MAX, 'and it filled to exactly the ceiling')
    assert.equal(t.bridge._sessionCursors.has(`walk-${walked - 1}`), true, 'the conversation just read is cached')
    assert.equal(t.bridge._sessionCursors.has('walk-0'), false, 'the first one walked past is what gave way')
    // The values stay what they always were: one sequence number per conversation.
    for (const value of t.bridge._sessionCursors.values()) {
      assert.equal(typeof value, 'number', 'a cached cursor is still just a sequence number')
    }
  } finally {
    await t.stop()
  }
})

test('S7: sweepExpiredSessions covers the cursor cache, and does nothing when it is under the ceiling', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: walkHarness(3) })
  try {
    // Overfill it the way a long-lived bridge does, then run the sweep the bridge
    // already runs on session issue and on every status read.
    t.bridge._sessionCursors = new Map(
      Array.from({ length: SESSION_CURSOR_MAX * 2 + 5 }, (_unused, index) => [`s${index}`, index]),
    )
    t.bridge.sweepExpiredSessions()
    assert.equal(t.bridge._sessionCursors.size, SESSION_CURSOR_MAX, 'the sweep bounds it')
    assert.equal(t.bridge._sessionCursors.has(`s${SESSION_CURSOR_MAX * 2 + 4}`), true, 'the newest survive')

    // Under the ceiling a sweep deletes nothing: this is a bound, not a lifetime.
    const quiet = new Map([['keep-a', 1], ['keep-b', 2]])
    t.bridge._sessionCursors = quiet
    t.bridge.sweepExpiredSessions()
    assert.equal(t.bridge._sessionCursors.size, 2, 'an under-ceiling cache is left alone')
    const clock = t.bridge.now()
    t.bridge.now = () => clock + 365 * 24 * 60 * 60 * 1000
    t.bridge.sweepExpiredSessions()
    assert.equal(t.bridge._sessionCursors.size, 2, 'age alone must not retire a cursor — that would be a new TTL')
  } finally {
    await t.stop()
  }
})

test('S7: a conversation read again is kept against the eviction order', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: walkHarness(4) })
  try {
    const cookie = await t.pairMobile('PocketCursorLru/1.0')
    t.bridge._sessionCursors = new Map(
      Array.from({ length: SESSION_CURSOR_MAX }, (_unused, index) => [`old-${index}`, index]),
    )
    // Read one of the OLD conversations (its row is in the fake list too only for
    // walk-*, so the re-learn lands on the touched key) and then one new one: the
    // entry that was just used must be the last thing anyone evicts, and the oldest
    // untouched one must be the first.
    t.bridge.rememberSessionCursor('old-0', 7)
    assert.equal(t.bridge._sessionCursors.size, SESSION_CURSOR_MAX, 're-membering a known conversation does not grow the table')
    t.bridge.rememberSessionCursor('walk-0', 1000)
    assert.equal(t.bridge._sessionCursors.size, SESSION_CURSOR_MAX, 'a new conversation lands inside the ceiling')
    assert.equal(t.bridge._sessionCursors.has('old-0'), true, 'the entry just used is not the one evicted')
    assert.equal(t.bridge._sessionCursors.has(`old-1`), false, 'the oldest untouched entry is')
    assert.equal(t.bridge._sessionCursors.get('walk-0'), 1000, 'and the freshly learned cursor is cached verbatim')

    const res = await historyRead(t, cookie, 'walk-1')
    assert.equal(res.status, 200)
    assert.equal(t.bridge._sessionCursors.has('walk-1'), true, 'the read path goes through the same bounded door')
    assert.equal(t.bridge._sessionCursors.size, SESSION_CURSOR_MAX, 'without ever passing the ceiling')
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// S8 — the pending-question table
// ---------------------------------------------------------------------------

test('S8: unanswered questions are bounded, and the ceiling does not drop what is in use', async () => {
  const t = await startBridge()
  try {
    const total = PENDING_QUESTIONS_MAX + 7
    for (let index = 0; index < total; index += 1) {
      t.bridge.consumeMuxEnvelope(questionFrame(`q-${index}`, `sess-${index}`))
      assert.ok(t.bridge.pendingQuestions.size <= PENDING_QUESTIONS_MAX, 'the table has a ceiling now')
    }
    assert.equal(t.bridge.pendingQuestions.size, PENDING_QUESTIONS_MAX, 'and it filled to exactly the ceiling')
    assert.equal(t.bridge.pendingQuestions.has(`q-${total - 1}`), true, 'the newest question is still answerable')
    assert.equal(t.bridge.pendingQuestions.has('q-0'), false, 'the oldest unanswered one gave way')

    // Reading a question keeps it: the handset looking at it must not be the next victim.
    const before = t.bridge.pendingQuestions.size
    t.bridge.assertPendingQuestion(`q-${PENDING_QUESTIONS_MAX}`, `sess-${PENDING_QUESTIONS_MAX}`)
    t.bridge.consumeMuxEnvelope(questionFrame('q-extra', 'sess-extra'))
    assert.equal(t.bridge.pendingQuestions.size, before, 'no growth past the ceiling')
    assert.equal(t.bridge.pendingQuestions.has('q-extra'), true)
    assert.equal(t.bridge.pendingQuestions.has('q-0'), false, 'and an evicted question stays evicted')

    // The pending record keeps its shape — no expiry field was smuggled in.
    const held = t.bridge.pendingQuestions.get('q-extra')
    assert.equal(held.expiresAt, undefined, 'a question carries no deadline')
    assert.deepEqual(Object.keys(held).sort(), ['questions', 'rpcId', 'sessionId'])
  } finally {
    await t.stop()
  }
})

test('S8: a question survives any number of sweeps — time is not the eviction rule', async () => {
  const t = await startBridge()
  try {
    t.bridge.consumeMuxEnvelope(questionFrame('q-keep', 'sess-keep'))
    assert.equal(t.bridge.pendingQuestions.size, 1)
    const clock = t.bridge.now()
    t.bridge.now = () => clock
    for (let day = 0; day < 400; day += 1) {
      t.bridge.now = () => clock + day * 24 * 60 * 60 * 1000
      t.bridge.sweepExpiredSessions()
    }
    assert.equal(t.bridge.pendingQuestions.has('q-keep'), true, 'unanswered a year later is still unanswered, not gone')
    assert.equal(t.bridge.assertPendingQuestion('q-keep', 'sess-keep').rpcId, 'q-keep', 'and the phone can still answer it')
  } finally {
    await t.stop()
  }
})

test('S8: the retirement paths are unchanged — cancel and settle still drop exactly their own entry', async () => {
  const t = await startBridge()
  try {
    t.bridge.consumeMuxEnvelope(questionFrame('q-a', 'sess-a'))
    t.bridge.consumeMuxEnvelope(questionFrame('q-b', 'sess-b'))
    assert.equal(t.bridge.pendingQuestions.size, 2)
    t.bridge.consumeMuxEnvelope(JSON.stringify({
      type: 'item',
      streamId: 'mobile-events',
      value: { type: 'cancel', eventId: 'q-a' },
    }))
    assert.equal(t.bridge.pendingQuestions.has('q-a'), false, 'a cancel retires its own question')
    assert.equal(t.bridge.pendingQuestions.has('q-b'), true, 'and only its own')
    assert.equal(t.bridge.pendingQuestions.size, 1)
    // A re-issued question with the same id refreshes the entry rather than doubling it.
    t.bridge.consumeMuxEnvelope(questionFrame('q-b', 'sess-b'))
    assert.equal(t.bridge.pendingQuestions.size, 1, 'a duplicate event id does not add a second row')
  } finally {
    await t.stop()
  }
})
