// 2026-10-08-fix-pocket-question-lost-on-reconnect — the three terminal pins.
//
// What was broken (measured, not reasoned — given G1/G2 in the card's table, so
// they are not re-derived here):
//
//   G1  `lib/mux-client.js` ran `pendingQuestions.clear()` on EVERY `handleOpen`
//       (first connect and every reconnect), and that table is Pocket's only copy
//       of an unanswered question: it is filled by one pushed `waterfall` frame
//       and nothing rebuilds it. So a carrier that flaps every second or two
//       erased whatever the operator had on screen, and the log said nothing.
//   G2  `interaction.pending` took the FIRST row of a session in insertion order.
//       A second question raised for the same conversation was therefore never
//       returned while the first went unanswered — the phone polled, was handed
//       the older row, and the newer prompt hid behind it forever.
//
// The fix is visibility, not recovery: a question lost to a reconnect stays lost
// (the Host's gateway refuses an answer from a client generation that never
// received the event, and the projection carries no event id to answer with —
// G4/G5). So these tests pin the three things this card owns: the clear announces
// itself with counts only; the newest question of a session is the one offered,
// and the hidden one resurfaces once the newest is answered; the ceiling's own
// evictions join that same line without the table learning anything about time.
//
// Written the way 0.3.1's terminal tests are: assert the END STATE — the line
// that exists, the row that comes back — never "the function was called", and ban
// the forbidden content at character level so it cannot ride along on a later
// edit. Each assertion was checked by mutation (tasks.md 门禁): delete the log →
// A1 red; hand back the first row instead of the last → A2 red; give an entry a
// deadline → A3 red.
//
// Round 2 (review B-1 / G10 / G11) added the pins the first round was missing, and
// they are the ones that carry this card:
//   A1b drives the REAL `monitorMux` loop with questions arriving as carrier
//       frames, because the drop — not the reopen — is what eats them; an open over
//       the table it just emptied must stay silent. Delete the counted clear from
//       the downlink branch and A1b is red with zero lines; let an empty clear
//       write a line and it is red with two.
//   A1c pins the label each of the three other paths reports, plus the count of
//       rows that name no conversation. Rewire any label and its case is red.
//   A2b pins the terminal state of a FAILED answer attempt: the question that
//       could not be answered is back behind the one it was hiding. Put the
//       re-insert of `assertPendingQuestion` back and ① is red; drop the slot
//       restore from `respondToQuestion` and ② is red while ① stays green.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge, httpFetch } from './helpers.js'
import { createMuxMonitor } from '../lib/mux-client.js'
import { createFileLogger } from '../lib/file-log.js'
import { PENDING_QUESTIONS_MAX } from '../lib/constants.js'

/**
 * The one line every clear path writes, as a closed shape: a `via=` label out of
 * a fixed enum, then digits, then nothing. Closing the enum is what makes the
 * label testable — a path that reports itself as something else, or as nothing,
 * is red here rather than merely harder to grep in the field.
 */
const CLEAR_LINE = /^pending questions cleared via=(?:no-url|no-base|base-changed|downlink-lost|carrier-open) dropped=\d+ sessions=\d+ backlog=\d+ evictedLifetime=\d+$/

/** Every line the bridge wrote that reports a cleared table. */
function clearLines(logs) {
  return logs.filter((entry) => entry.message.startsWith('pending questions cleared'))
}

/** One unanswered question, in the carrier shape `consumeMuxEnvelope` reads. */
function questionFrame(eventId, sessionId, prose) {
  return JSON.stringify({
    type: 'item',
    streamId: 'mobile-events',
    value: {
      type: 'waterfall',
      event: 'user-questions/request',
      eventId,
      agentId: sessionId,
      request: {
        questions: [{ id: 'q1', question: prose, options: [{ label: 'left' }, { label: 'right' }] }],
      },
    },
  })
}

// ---------------------------------------------------------------------------
// The carrier this card hangs on: a socket that opens, then hangs up.
//
// `handleOpen` is the code under test, so the honest way in is to let a carrier
// open for real through the bridge's own mux monitor. The monitor reads the
// platform WebSocket global at call time, so one fake installed around the drive
// is enough; the close that follows the open is what lets `consumeMux` settle
// instead of parking forever.
//
// The fake also has to be able to STAY up: the path that actually eats the
// questions is the drop, not the open (see A1b), and a carrier that hangs up on
// its own two microtasks later can never be handed a `waterfall` frame — which
// is the only way a question ever arrives. Hence `autoClose` and `hangUp()`.
// ---------------------------------------------------------------------------

/** @type {FakeCarrier[]} */
let carriers = []

class FakeCarrier {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  /** When false a carrier stays up until the test hangs it up. */
  static autoClose = true

  constructor(url, options) {
    this.url = String(url)
    this.options = options
    this.readyState = FakeCarrier.CONNECTING
    this.sent = []
    this.listeners = new Map()
    carriers.push(this)
    queueMicrotask(() => {
      this.readyState = FakeCarrier.OPEN
      this.emit('open', {})
    })
    if (FakeCarrier.autoClose) {
      queueMicrotask(() => queueMicrotask(() => this.emit('close', {})))
    }
  }

  /** Hang up from the far end, the way a real carrier does. */
  hangUp() {
    this.emit('close', {})
  }

  addEventListener(type, listener, options) {
    const entries = this.listeners.get(type) ?? []
    entries.push({ listener, once: Boolean(options?.once) })
    this.listeners.set(type, entries)
  }

  removeEventListener(type, listener) {
    const entries = this.listeners.get(type)
    if (!entries) return
    this.listeners.set(type, entries.filter((entry) => entry.listener !== listener))
  }

  emit(type, event) {
    // A snapshot: `once` listeners (and cleanup()) mutate the list while walking.
    for (const entry of [...(this.listeners.get(type) ?? [])]) {
      if (entry.once) this.removeEventListener(type, entry.listener)
      entry.listener(event)
    }
  }

  send(text) {
    this.sent.push(String(text))
  }

  close() {
    this.readyState = FakeCarrier.CLOSED
  }
}

function installFakeCarrier() {
  const real = globalThis.WebSocket
  globalThis.WebSocket = FakeCarrier
  carriers = []
  FakeCarrier.autoClose = true
  return () => {
    globalThis.WebSocket = real
    carriers = []
    FakeCarrier.autoClose = true
  }
}

/**
 * Drive one real `handleOpen` and return the carrier that answered it. The
 * rejection is the scripted hang-up, not a fault: it is how the drive ends.
 * @param {Awaited<ReturnType<typeof startBridge>>} t
 * @returns {Promise<FakeCarrier>}
 */
async function driveCarrierOpen(t) {
  await assert.rejects(
    t.bridge.muxMonitor.consumeMux(t.harness.url, new AbortController().signal),
    (error) => error instanceof Error && error.message === 'Harness mux WebSocket closed.',
    'the scripted carrier opened and then hung up'
  )
  const built = carriers.at(-1)
  assert.ok(built, 'the drive built a carrier')
  assert.equal(built.readyState, FakeCarrier.CLOSED, 'and the drive reached the end of its life')
  return built
}

/** Resolve true once `predicate` holds, false if it never did inside `limitMs`. */
async function waitFor(predicate, limitMs = 5000) {
  const deadline = Date.now() + limitMs
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return true
}

/** POST one bridge RPC method over the mobile cookie and read the answer. */
async function rpc(t, cookie, method, payload) {
  const res = await httpFetch(`${t.base}/api/rpc`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ method, payload }),
  })
  return { status: res.status, body: await res.json() }
}

// ---------------------------------------------------------------------------
// A1 — the clear announces itself: exactly one line, counts, no identity
// ---------------------------------------------------------------------------

test('A1: a reconnect that wipes unanswered questions writes exactly one counted line, and nothing identifying', async () => {
  const restore = installFakeCarrier()
  const t = await startBridge({ harness: 'fake' })
  try {
    // Three unanswered: two piled into one conversation and one in another. So
    // 3 are lost, they sit in 2 conversations, and the deepest pile is 2 — which
    // is exactly the occlusion G2 measured, now visible as a number. Three
    // different numbers, because three numbers that are always equal would tell
    // an operator nothing they could not get from any one of them.
    const eventId = 'evt-9d2f4c1a-secret'
    const prose = 'SECRET-PROSE-which-one-do-you-mean'
    t.bridge.consumeMuxEnvelope(questionFrame(eventId, 'sess-alpha', prose))
    t.bridge.consumeMuxEnvelope(questionFrame('evt-second-in-line', 'sess-alpha', 'the second one?'))
    t.bridge.consumeMuxEnvelope(questionFrame('evt-other-session', 'sess-beta', 'the third one?'))
    assert.equal(t.bridge.pendingQuestions.size, 3, 'three questions are on the table')
    const before = t.logs.length

    await driveCarrierOpen(t)

    const added = t.logs.slice(before)
    const lines = clearLines(added)
    assert.equal(
      lines.length,
      1,
      `exactly one line, not zero and not two: ${JSON.stringify(added.map((entry) => entry.message))}`
    )
    assert.equal(lines[0].level, 'warn', 'a question lost under the operator is not informational')
    assert.match(
      lines[0].message,
      CLEAR_LINE,
      'the line is closed over: labels and digits only, so neither an id nor prose can ride along'
    )
    assert.equal(
      lines[0].message,
      'pending questions cleared via=carrier-open dropped=3 sessions=2 backlog=2 evictedLifetime=0',
      'the counts say what was lost and the label says which path lost it'
    )
    // The rule itself, stated beside the shape that enforces it.
    for (const forbidden of [eventId, prose, 'sess-alpha', 'sess-beta', 'second', 'SECRET']) {
      assert.ok(!lines[0].message.includes(forbidden), `the log must not carry ${JSON.stringify(forbidden)}`)
    }
    assert.equal(t.bridge.pendingQuestions.size, 0, 'and the table really was emptied')

    // A second open over an empty table says nothing. The carrier flaps on the
    // order of seconds, so silence here is what keeps the line above findable.
    const after = t.logs.length
    await driveCarrierOpen(t)
    assert.equal(clearLines(t.logs.slice(after)).length, 0, 'an empty clear is not an event')
  } finally {
    await t.stop()
    restore()
  }
})

// ---------------------------------------------------------------------------
// A2 — the newest question of a session is the one offered, and answering it
//      uncovers the one that was hiding behind it
// ---------------------------------------------------------------------------

test('A2: interaction.pending offers the newest unanswered question of that session, and falls back to the hidden one once it is answered', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile('PocketLatest/1.0')
    // Pairing is what arms the downlink monitor (a carrier only runs for a
    // paired handset), and its first open clears the table. Seed only after that
    // open, so what this test reads is the state it built and not a race with it.
    assert.ok(
      await waitFor(() => t.bridge.muxConnected === true),
      'the carrier came up before the table was seeded'
    )

    // Same conversation, two questions, older first — the order G2 measured.
    t.bridge.consumeMuxEnvelope(questionFrame('evt-older', 'sess-stack', 'the older one?'))
    t.bridge.consumeMuxEnvelope(questionFrame('evt-newer', 'sess-stack', 'the newer one?'))
    assert.equal(t.bridge.pendingQuestions.size, 2, 'both are held for the answer')
    // The client generation an answer quotes. The `ready` frame that normally
    // carries it is the Host's own, and the fake harness never sends one.
    t.bridge.eventClientId = 'client-generation-1'

    const firstRead = await rpc(t, cookie, 'interaction.pending', { sessionId: 'sess-stack' })
    assert.equal(firstRead.status, 200)
    assert.equal(firstRead.body.ok, true)
    assert.equal(
      firstRead.body.value?.rpcId,
      'evt-newer',
      `the newest question is the one on screen, saw ${JSON.stringify(firstRead.body.value?.rpcId)}`
    )

    // Answer the newest, over the same RPC the handset uses.
    const answered = await rpc(t, cookie, 'interaction.answer', {
      rpcId: 'evt-newer',
      sessionId: 'sess-stack',
      answers: [{ id: 'q1', selected: ['left'] }],
    })
    assert.equal(answered.body.ok, true, `the answer was accepted: ${JSON.stringify(answered.body)}`)
    assert.equal(t.bridge.pendingQuestions.has('evt-newer'), false, 'a settled question leaves the table')

    // The half that separates "hands back the tail" from "hands back nothing":
    // the question that hid behind the answered one is now the one offered.
    const secondRead = await rpc(t, cookie, 'interaction.pending', { sessionId: 'sess-stack' })
    assert.equal(secondRead.body.value?.rpcId, 'evt-older', 'the hidden question resurfaces — it was never skipped')

    // A conversation nothing was asked about is still null, not a stranger's row.
    const other = await rpc(t, cookie, 'interaction.pending', { sessionId: 'sess-unrelated' })
    assert.equal(other.body.value, null, 'no session borrows the question of another')
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// A3 — the ceiling's own losses ride the same single line, and the table still
//      knows nothing about time
// ---------------------------------------------------------------------------

test('A3: ceiling evictions join that same one line, and no deadline entered the table with them', async () => {
  const restore = installFakeCarrier()
  const t = await startBridge({ harness: 'fake' })
  try {
    // Build a table whose numbers cannot be confused with each other: 57
    // questions each in a conversation of its own, then a deep pile of 5 and a
    // shallow pile of 2 in two named conversations, then 3 more singles — and it
    // is those last 3 that push the table past its ceiling and make it give way.
    /** Ask `count` questions, all of them in `sessionId`. */
    const ask = (count, sessionId, from) => {
      for (let index = 0; index < count; index += 1) {
        t.bridge.consumeMuxEnvelope(
          questionFrame(`evt-${sessionId}-${String(from + index)}`, sessionId, `prose of question ${String(from + index)}?`)
        )
      }
    }
    const singles = PENDING_QUESTIONS_MAX - 7
    for (let index = 0; index < singles; index += 1) {
      t.bridge.consumeMuxEnvelope(
        questionFrame(`evt-alone-${String(index)}`, `sess-alone-${String(index)}`, `prose of a single question ${String(index)}?`)
      )
    }
    ask(5, 'sess-deep', 100)
    ask(2, 'sess-shallow', 200)
    assert.equal(t.bridge.pendingQuestions.size, PENDING_QUESTIONS_MAX, 'the table filled to exactly its ceiling')
    assert.equal(t.bridge.pendingQuestionEvictions, 0, 'and nothing was thrown out yet')
    ask(3, 'sess-late', 300)

    assert.equal(t.bridge.pendingQuestions.size, PENDING_QUESTIONS_MAX, 'the ceiling held')
    assert.equal(
      t.bridge.pendingQuestionEvictions,
      3,
      'the count of what the ceiling threw out is kept where the downlink can read it'
    )

    // The two pins this repo already has, restated here so a deadline added to an
    // entry turns THIS file red too: the pile is bounded by a ceiling, never by a
    // clock. A question the operator may still come back to has no expiry, and
    // being able to report it is not a licence to retire it.
    const held = t.bridge.pendingQuestions.get('evt-sess-late-302')
    assert.ok(held, 'the newest question is one of the three the ceiling made room for')
    assert.equal(held.expiresAt, undefined, 'an entry carries no deadline')
    assert.deepEqual(Object.keys(held).sort(), ['questions', 'rpcId', 'sessionId'], 'and no timekeeping field snuck in')
    const clock = t.bridge.now()
    t.bridge.now = () => clock + 400 * 24 * 60 * 60 * 1000
    t.bridge.sweepExpiredSessions()
    t.bridge.now = () => clock
    assert.equal(
      t.bridge.pendingQuestions.size,
      PENDING_QUESTIONS_MAX,
      'a question survives any number of sweeps — time is not the eviction rule'
    )

    const before = t.logs.length
    await driveCarrierOpen(t)

    const lines = clearLines(t.logs.slice(before))
    assert.equal(
      lines.length,
      1,
      `the backlog and the eviction count share one line, saw ${JSON.stringify(t.logs.slice(before).map((entry) => entry.message))}`
    )
    assert.match(lines[0].message, CLEAR_LINE)
    // 64 rows survived into the reconnect, spread over 57 conversations (the
    // ceiling had already taken the three oldest, each of which held a conversation
    // of its own), the deepest pile inside one conversation being the 5; and the 3
    // the ceiling had dropped over the life of the bridge are named in the same
    // breath — one grep covers both ways this table shrinks by itself.
    assert.equal(
      lines[0].message,
      `pending questions cleared via=carrier-open dropped=${String(PENDING_QUESTIONS_MAX)} sessions=57 backlog=5 evictedLifetime=3`
    )
    for (const forbidden of ['evt-alone-0', 'evt-sess-deep-100', 'sess-deep', 'sess-shallow', 'prose of question 100']) {
      assert.ok(!lines[0].message.includes(forbidden), `no identity rides the counted line: ${JSON.stringify(forbidden)}`)
    }
  } finally {
    await t.stop()
    restore()
  }
})

// ---------------------------------------------------------------------------
// A2b — a failed answer attempt must not leave its question in front of the one
//       it was hiding (the occlusion this card's own "take the newest" read
//       re-introduced: given G11)
// ---------------------------------------------------------------------------

test('A2b: an answer attempt that fails does not leave its question sitting in front of the one it was hiding', async () => {
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      // The Host refuses: this is the G4 case — the answer does not land and the
      // question stays on the table, where the phone will keep being shown it.
      respond: (pathname) => (pathname === '/api/$events/result'
        ? { ok: false, error: { message: 'the answer did not land' } }
        : undefined),
    },
  })
  try {
    const cookie = await t.pairMobile('PocketRefused/1.0')
    assert.ok(
      await waitFor(() => t.bridge.muxConnected === true),
      'the carrier came up before the table was seeded'
    )
    // Older first, newer second — the arrival order that makes the older one
    // invisible while the newer is offered.
    t.bridge.consumeMuxEnvelope(questionFrame('evt-blocked', 'sess-refuse', 'the one the phone is stuck on?'))
    t.bridge.consumeMuxEnvelope(questionFrame('evt-hidden', 'sess-refuse', 'the one behind it?'))
    assert.equal(t.bridge.pendingQuestions.size, 2, 'both are held')
    assert.deepEqual(
      [...t.bridge.pendingQuestions.keys()],
      ['evt-blocked', 'evt-hidden'],
      'and the queue reads in arrival order before anyone tries to answer'
    )

    // ① The attempt never reaches the Host (no client generation yet — exactly the
    // state a phone is in right after a reconnect, which is when G11 was found).
    assert.equal(t.bridge.eventClientId, undefined, 'nothing can land in this phase')
    const atTheGate = await rpc(t, cookie, 'interaction.answer', {
      rpcId: 'evt-blocked',
      sessionId: 'sess-refuse',
      answers: [{ id: 'q1', selected: ['left'] }],
    })
    assert.equal(atTheGate.status, 400, 'the phone is told it did not work')
    assert.equal(atTheGate.body.ok, false)
    const afterGate = await rpc(t, cookie, 'interaction.pending', { sessionId: 'sess-refuse' })
    assert.equal(
      afterGate.body.value?.rpcId,
      'evt-hidden',
      'an attempt that never left the bridge must not reorder the queue'
    )
    assert.equal(t.bridge.pendingQuestions.has('evt-blocked'), true, 'a refused answer does not drop the question')
    assert.deepEqual(
      [...t.bridge.pendingQuestions.keys()],
      ['evt-blocked', 'evt-hidden'],
      'the table is in the order it was in'
    )

    // ② The attempt DOES reach the Host and comes back refused. This is the path
    // that legitimately bumps the entry — while the call is outstanding the ceiling
    // must not take it out from under the phone — so the bump has to be given BACK,
    // to the slot it came from, or this question sits at the newest end for ever and
    // hides its own session again.
    t.bridge.eventClientId = 'client-generation-1'
    const refused = await rpc(t, cookie, 'interaction.answer', {
      rpcId: 'evt-blocked',
      sessionId: 'sess-refuse',
      answers: [{ id: 'q1', selected: ['left'] }],
    })
    assert.equal(refused.status, 400, 'the Host said no')
    assert.equal(refused.body.ok, false)
    assert.deepEqual(
      [...t.bridge.pendingQuestions.keys()],
      ['evt-blocked', 'evt-hidden'],
      'the slot the bump came from is the slot it went back to'
    )
    const afterRefusal = await rpc(t, cookie, 'interaction.pending', { sessionId: 'sess-refuse' })
    assert.equal(
      afterRefusal.body.value?.rpcId,
      'evt-hidden',
      'the question that can still be reached is the one on screen'
    )
    // Restoring a position is not a licence to restamp the record.
    const held = t.bridge.pendingQuestions.get('evt-blocked')
    assert.deepEqual(
      Object.keys(held).sort(),
      ['questions', 'rpcId', 'sessionId'],
      'no field was added to the entry while its slot moved'
    )
    assert.equal(held.expiresAt, undefined, 'and no deadline came in with the shuffle')
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// A1b — the terminal state B-1 said was missing: the real `monitorMux` reconnect
//       loop, questions arriving on carrier frames, and the DROP eating them
// ---------------------------------------------------------------------------

/**
 * Drive the bridge's own `monitorMux` (not one hand-built `consumeMux` call) over
 * a carrier that stays up, hand it two questions as `waterfall` frames, then hang
 * the carrier up.
 *
 * This is the shape production is in. Questions can only arrive while the carrier
 * is up, so the table is ALWAYS empty by the time the next `handleOpen` runs:
 * measuring the open alone was measuring a state the field never reaches, which is
 * how the first version of A1 went green while the log line it pinned appeared zero
 * times in a real flap (review B-1, given G10).
 */
test('A1b: the drop, not the reopen, is what eats the questions — and driving the real reconnect loop says so exactly once', async () => {
  const restore = installFakeCarrier()
  FakeCarrier.autoClose = false
  // N-1: the same line read out of the file an operator actually greps.
  const logDir = mkdtempSync(join(tmpdir(), 'pocket-clear-line-'))
  const logPath = join(logDir, 'pocket.log')
  const fileLog = createFileLogger(logPath)
  const t = await startBridge({
    harness: 'fake',
    bridgeOptions: { log: (level, message) => fileLog[level]?.(message) },
  })
  try {
    // One driver only. The bridge arms its own monitor when a handset pairs and
    // nothing here pairs; if that ever changes, this drive races a second monitor
    // over the same table and the line count stops meaning anything.
    assert.equal(t.bridge.muxTask, undefined, 'no bridge-side downlink is running for this drive')

    const controller = new AbortController()
    const running = t.bridge.muxMonitor.monitorMux(controller.signal)
    try {
      assert.ok(await waitFor(() => carriers.length >= 1), 'the loop built a carrier')
      // Not `bridge.muxConnected`: that flag is gated on the bridge having armed
      // its own downlink (`noteMuxState` reads `muxAbort`), and this drive is the
      // monitor's, not the bridge's. The carrier's own state is what matters here.
      const first = carriers[0]
      assert.ok(await waitFor(() => first.readyState === FakeCarrier.OPEN), 'and the carrier came up')
      assert.equal(first.sent.length, 2, 'both logical streams were opened on it')
      assert.equal(clearLines(t.logs).length, 0, 'the two clears of the opening round were empty, so they said nothing')

      // Arrival through the carrier, the only way a question ever arrives. NOT
      // `pendingQuestions.set()` — hand-writing the table is what let the old A1
      // test an unreachable state.
      first.emit('message', { data: questionFrame('evt-loop-older', 'sess-loop', 'SECRET-LOOP-A which one?') })
      first.emit('message', { data: questionFrame('evt-loop-newer', 'sess-loop', 'SECRET-LOOP-B or that one?') })
      assert.equal(t.bridge.pendingQuestions.size, 2, 'the frames reached the table through the live carrier')

      const before = t.logs.length
      first.hangUp()
      assert.ok(await waitFor(() => clearLines(t.logs.slice(before)).length === 1), 'the drop announced itself')

      const lines = clearLines(t.logs.slice(before))
      assert.equal(
        lines.length,
        1,
        `exactly one line for a non-empty clear, saw ${JSON.stringify(t.logs.slice(before).map((entry) => entry.message))}`
      )
      assert.equal(lines[0].level, 'warn')
      assert.match(lines[0].message, CLEAR_LINE)
      assert.equal(
        lines[0].message,
        'pending questions cleared via=downlink-lost dropped=2 sessions=1 backlog=2 evictedLifetime=0',
        'the loss is counted and the path that caused it is named'
      )
      assert.equal(t.bridge.pendingQuestions.size, 0, 'the table the operator was looking at is gone')
      assert.equal(
        t.logs.slice(before).filter((entry) => entry.message.startsWith('mux downlink lost')).length,
        1,
        'the cause line and the counted line are two lines, and both are there'
      )
      for (const forbidden of ['evt-loop-older', 'evt-loop-newer', 'sess-loop', 'SECRET']) {
        assert.ok(!lines[0].message.includes(forbidden), `the drop line must not carry ${JSON.stringify(forbidden)}`)
      }

      // The characters reach the file, not just the in-memory collector: this card
      // promises "一行可 grep 的记录" in `pocket.log`.
      const onDisk = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((entry) => typeof entry.message === 'string' && entry.message.startsWith('pending questions cleared'))
      assert.equal(onDisk.length, 1, 'one line on disk')
      assert.equal(onDisk[0].message, lines[0].message, 'the file carries what the bridge reported, verbatim')
      assert.equal(onDisk[0].level, 'warn')

      // And the reopen that follows 500ms later: it clears a table that is already
      // empty, so it adds nothing. Before this fix the loop wrote ZERO lines here;
      // a loop that wrote one per flap would bury the one that matters. Both halves
      // of that are the point — the total is still one after a second open.
      assert.ok(await waitFor(() => carriers.length >= 2), 'the loop reopened the downlink')
      assert.equal(
        clearLines(t.logs.slice(before)).length,
        1,
        'the reopen over the empty table is not an event — the drop line stays the only record of the loss'
      )
    } finally {
      controller.abort()
      await running
    }
  } finally {
    await t.stop()
    restore()
    rmSync(logDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// A1c — the other three paths that used to clear in silence each report their
//       own name. Driven against `createMuxMonitor` directly (no HTTP, no
//       carrier needed for three of them): what is pinned here is the LABEL
//       routing and the counting of rows that name no conversation. The real
//       arrival path and the real loop are A1b.
// ---------------------------------------------------------------------------

/**
 * @param {string} rpcId
 * @param {string} sessionId
 */
function heldRow(rpcId, sessionId) {
  return { rpcId, sessionId, questions: [] }
}

/**
 * @param {() => string | undefined} harnessUrl
 * @param {(level: string, message: string) => void} [sink] defaults to a collector
 */
function bareMux(harnessUrl, sink) {
  const logs = []
  const pendingQuestions = new Map()
  const monitor = createMuxMonitor({
    harnessUrl,
    innerAuth: { ready: async () => undefined, invalidate: () => {} },
    pendingQuestions,
    log: sink ?? ((level, message) => logs.push({ level, message })),
    now: () => Date.now(),
    consumeMuxEnvelope: () => {},
    setEventClientId: () => {},
  })
  return { monitor, logs, pendingQuestions }
}

/**
 * Fill the table with rows the three counters cannot agree about: 5 entries lost,
 * only 3 of which name a conversation, and those spread over 2 conversations with
 * a deepest pile of 2. Two of the five are rows this side never writes (a Host
 * envelope can only produce records), so they also pin the malformed guard — with
 * it removed, the clear throws instead of counting.
 * @param {ReturnType<typeof bareMux>} mux
 */
function seedBare(mux) {
  mux.pendingQuestions.set('row-a', heldRow('row-a', 'sess-one'))
  mux.pendingQuestions.set('row-b', heldRow('row-b', 'sess-one'))
  mux.pendingQuestions.set('row-c', heldRow('row-c', 'sess-two'))
  mux.pendingQuestions.set('row-junk-null', null)
  mux.pendingQuestions.set('row-junk-text', 'not a record')
}

/**
 * Run `monitorMux` until it has reported one clear, then stop it.
 * @param {ReturnType<typeof bareMux>} mux
 */
async function firstClearLine(mux) {
  const controller = new AbortController()
  const running = mux.monitor.monitorMux(controller.signal)
  try {
    assert.ok(await waitFor(() => clearLines(mux.logs).length > 0), 'the monitor reached a clear of a non-empty table')
  } finally {
    controller.abort()
    await running
  }
  const lines = clearLines(mux.logs)
  assert.equal(lines.length, 1, `one line per non-empty clear, saw ${JSON.stringify(lines.map((entry) => entry.message))}`)
  return lines[0]
}

test('A1c: each downlink path that drops the table names itself, and rows that name no conversation still count as lost', async () => {
  const restore = installFakeCarrier()
  try {
    const cases = [
      { label: 'no-url', harnessUrl: () => { throw new Error('the host is tearing down') } },
      { label: 'no-base', harnessUrl: () => undefined },
      { label: 'base-changed', harnessUrl: () => 'http://127.0.0.1:47001' },
    ]
    for (const one of cases) {
      const mux = bareMux(one.harnessUrl)
      seedBare(mux)
      const line = await firstClearLine(mux)
      assert.equal(line.level, 'warn', `${one.label}: losing prompts is not informational`)
      assert.match(line.message, CLEAR_LINE, `${one.label}: the shape stays closed over the enum`)
      assert.equal(
        line.message,
        `pending questions cleared via=${one.label} dropped=5 sessions=2 backlog=2 evictedLifetime=0`,
        `${one.label}: the label is the only thing that tells these paths apart, so it has to be on the line`
      )
      assert.equal(mux.pendingQuestions.size, 0, `${one.label}: and the table it counted was the thing dropped`)
      if (one.label === 'no-base') {
        // This branch never had a line of any kind before this card — the counted
        // clear is the whole record that a table went out on this path.
        assert.equal(mux.logs.length, 1, 'no-base has no cause line: this counted line is all it says')
      }
    }

    // M-1, pinned rather than argued about. The clear is what this call is FOR and
    // the line is a side effect of it, so a sink that throws must not get to veto
    // the clear. The context contract for `log` is only `(level, message) => void`
    // — it says nothing about throwing or not, and the fact that today's injected
    // implementation happens to be triple-wrapped is a property of that
    // implementation, not something this module may lean on.
    //
    // Mutation that proves THIS assertion: move `pendingQuestions.clear()` back
    // below the `log(...)` call. The line still gets written and every count still
    // matches, so nothing else notices — only this assertion goes red, with the
    // five rows still sitting in a table whose downlink is already gone.
    const hostile = bareMux(
      () => 'http://127.0.0.1:47002',
      () => {
        throw new Error('the sink is broken')
      }
    )
    seedBare(hostile)
    const controller = new AbortController()
    const running = hostile.monitor.monitorMux(controller.signal)
    try {
      await assert.rejects(
        () => running,
        (error) => error instanceof Error && error.message === 'the sink is broken',
        'a throwing sink still surfaces rather than being swallowed'
      )
    } finally {
      controller.abort()
    }
    assert.equal(
      hostile.pendingQuestions.size,
      0,
      'a broken log sink is not allowed to keep the prompts in a dead table'
    )
  } finally {
    restore()
  }
})

