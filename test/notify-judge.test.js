// Completion-judge upgrade (2026-10-07-feat-pocket-notify-judge-upgrade): the
// notify trigger judges activity — dsh-mobile's four thresholds — instead of
// firing on every running true→false edge, and a question arrival pushes "AI
// is waiting for your approval" once per question, silently doing nothing
// when no channel is configured. The judge itself is a pure function, so the
// threshold rules are unit-tested on a hand-driven clock; the bridge tests
// cover the wiring (poll gating, question dedup, zero-config silence).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NOTIFY_MAILBAG,
  NOTIFY_JUDGE_THRESHOLDS,
  judgeSessionCompletion,
  sessionActivityAt,
} from '../lib/bridge.js'
import { startBridge } from './helpers.js'

const T = NOTIFY_JUDGE_THRESHOLDS
// 完成通知自 0.4.12 走合并车道：判到 settle 只进信封，发车由「凑满／末班车／封顶」
// 三条件决定。下面的桥测因此要显式把时钟推过末班车，而不是指望同一 tick 就出站。
const B = NOTIFY_MAILBAG
const REAL_KEY = 'SECRETKET1234567890AB'

/** Run one session through a list of [dtMs, sample] steps, collecting fires. */
function drive(steps, initialNow = 0) {
  let now = initialNow
  let state
  const fires = []
  for (const [dt, sample] of steps) {
    now += dt
    const result = judgeSessionCompletion(state, sample, now)
    state = result.state
    if (result.fire) fires.push(now)
  }
  return { fires, state }
}

const running = (activityAt = null) => ({ running: true, activityAt })
const idle = (activityAt = null) => ({ running: false, activityAt })

// ---------------------------------------------------------------------------
// Pure judge — the four thresholds
// ---------------------------------------------------------------------------

test('judge: a session already idle when first seen never fires, nor does the first sight of a run', () => {
  // Startup baseline: a long-idle session must not announce a completion the
  // bridge never observed.
  const { fires } = drive([
    [0, idle(500)],
    [T.quietMs, idle(500)],
    [T.staleMs, idle(500)]
  ])
  assert.deepEqual(fires, [])
  // And the first sight of a running session is a baseline too, not an edge.
  const first = drive([[0, running(1)]])
  assert.deepEqual(first.fires, [])
})

test('judge: a step flicker (short busy → idle → busy) never fires', () => {
  const { fires } = drive([
    [0, running(0)],
    [1_000, running(1_000)],          // still running 1s in: not long work
    [1_000, idle(1_500)],             // pause between steps: short run → wait
    [5_000, running(6_000)],          // activity resumes inside the quiet window
    [30_000, running(36_000)]
  ])
  assert.deepEqual(fires, [])
})

test('judge: a long busy run (≥20s observed) that stops fires immediately, not after the 90s settle', () => {
  // The run is seen running across a tick boundary (30s), which arms
  // longBusy; the turn's last event lands at t+45s and the next tick at t+60s
  // finds quiet already past the grace window.
  const { fires } = drive([
    [0, running(0)],
    [30_000, running(30_000)],
    [30_000, idle(45_000)]
  ])
  assert.equal(fires.length, 1)
})

test('judge: a long run whose turn ended inside the grace window waits one tick, then fires', () => {
  const { fires } = drive([
    [0, running(0)],
    [30_000, running(30_000)],
    [30_000, idle(59_500)],   // ended 500ms before the tick: not yet past grace
    [30_000, idle(59_500)]    // still idle: the stop is confirmed now
  ])
  assert.equal(fires.length, 1, 'exactly one notice, on the confirming tick')
})

test('judge: a short run settles after 90s of silence — and only once', () => {
  const { fires } = drive([
    [0, running(0)],
    [1_000, idle(800)],                    // short run → quiet wait
    [89_000, idle(800)],                   // 89s quiet: not yet
    [2_000, idle(800)],                    // 91s quiet: settle
    [60_000, idle(800)]                    // stays settled: no second notice
  ])
  assert.equal(fires.length, 1)
})

test('judge: activity observed only through updatedAt re-arms and settles like any run', () => {
  // A turn that starts and ends between two ticks is invisible to the running
  // bit; the Host row's frozen updatedAt is what tells the judge it happened.
  const { fires } = drive([
    [0, idle(1_000)],                      // baseline idle
    [30_000, idle(31_000)],                // a fast turn ran and finished
    [60_000, idle(31_000)],                // 60s quiet since it ended
    [31_000, idle(31_000)]                 // 91s quiet: settle, exactly once
  ])
  assert.equal(fires.length, 1)
})

test('judge: the 30min stale backstop settles a wait that flicker keeps resetting', () => {
  // Fresh activity keeps arriving (fast unobserved turns) so the quiet clock
  // never reaches 90s; the wait that began at the flip may not outlive 30min.
  const steps = [
    [0, running(0)],
    [1_000, idle(900)]                     // short run → wait begins here
  ]
  let at = 1_000
  while (at < 29 * 60_000) {
    at += 30_000
    steps.push([30_000, idle(at - 500)])   // activity 500ms before each tick
  }
  steps.push([60_000, idle(at + 59_500)])  // past the stale line: forced settle
  const { fires } = drive(steps)
  assert.equal(fires.length, 1, 'the stale backstop settles exactly once')
})

test('judge: a row with no activity timestamp degrades to the shipped flip behaviour', () => {
  // Without a quiet clock a step-pause and a real stop are indistinguishable;
  // the judge falls back to firing on the flip (the shipped anchor's path).
  const { fires } = drive([
    [0, running()],
    [1, idle()]                            // 1ms later: fired anyway
  ])
  assert.equal(fires.length, 1)
})

test('sessionActivityAt: the top-level stamp wins, the projections mirror backs it up, junk is null', () => {
  assert.equal(sessionActivityAt({ updatedAt: 123 }), 123)
  assert.equal(sessionActivityAt({ projections: { updatedAt: 456 } }), 456)
  assert.equal(sessionActivityAt({ updatedAt: 0, projections: { updatedAt: 456 } }), 456)
  assert.equal(sessionActivityAt({ updatedAt: 'nope' }), null)
  assert.equal(sessionActivityAt({}), null)
  assert.equal(sessionActivityAt(null), null)
})

// ---------------------------------------------------------------------------
// Bridge wiring
// ---------------------------------------------------------------------------

function notifyBridgeOptions(sent) {
  return {
    settingsStore: {
      load: () => ({ notify: { channel: 'bark', key: REAL_KEY, enabled: true } }),
      save: () => true
    },
    notifyFetchImpl: async (url) => {
      sent.push(String(url))
      return { ok: true, text: async () => '{}' }
    }
  }
}

test('bridge poll: a quiet settle fires once through the real poll path', async () => {
  const sent = []
  let clock = 1_000_000
  let items = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/list' ? { ok: true, value: { items } } : undefined
    },
    bridgeOptions: { ...notifyBridgeOptions(sent), now: () => clock }
  })
  try {
    const tick = async () => {
      t.bridge._sessionListCache = undefined
      await t.bridge.pollNotifyRunning()
    }
    items = [{ sessionId: 's1', running: true, title: '部署', updatedAt: clock }]
    await tick()
    assert.equal(sent.length, 0, 'baseline only')
    items = [{ sessionId: 's1', running: false, title: '部署', updatedAt: clock - 1_000 }]
    clock += 30_000
    await tick()
    assert.equal(sent.length, 0, '1s of quiet after a fresh turn: still working')
    clock += 91_000
    await tick()
    assert.equal(sent.length, 0, '90s of silence settles — into the envelope, not onto the wire')
    clock += B.rideMs
    await tick()
    assert.equal(sent.length, 1, 'the last bus departs and the settle is announced')
    assert.ok(sent[0].includes(encodeURIComponent('部署')))
    clock += 30_000
    await tick()
    assert.equal(sent.length, 1, 'no second notice')
  } finally {
    await t.stop()
  }
})

test('bridge poll: a session parked on a question never completes, and its aftermath still notifies', async () => {
  const sent = []
  let clock = 2_000_000
  let items = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/list' ? { ok: true, value: { items } } : undefined
    },
    bridgeOptions: { ...notifyBridgeOptions(sent), now: () => clock }
  })
  try {
    const tick = async () => {
      t.bridge._sessionListCache = undefined
      await t.bridge.pollNotifyRunning()
    }
    items = [{ sessionId: 's1', running: true, title: '部署', updatedAt: clock }]
    await tick()
    items = [{ sessionId: 's1', running: true, title: '部署', updatedAt: clock }]
    clock += 30_000
    await tick() // longBusy armed
    // The assistant parks on a question; the row goes idle and stays there.
    t.bridge.pendingQuestions.set('evt-1', { rpcId: 'r1', sessionId: 's1', questions: [] })
    items = [{ sessionId: 's1', running: false, title: '部署', updatedAt: clock }]
    clock += 30_000
    await tick()
    assert.equal(sent.length, 0, 'no completion while the operator is being asked')
    clock += 120_000
    await tick()
    assert.equal(sent.length, 0, 'a long question wait is still not a completion')
    // The question is answered; the frozen state judges the aftermath.
    t.bridge.pendingQuestions.clear()
    clock += 30_000
    await tick()
    assert.equal(sent.length, 0, 'the aftermath settles into the envelope')
    clock += B.rideMs
    await tick()
    assert.equal(sent.length, 1, 'the stop is announced once the question is gone')
  } finally {
    await t.stop()
  }
})

test('bridge poll: a frozen lead whose subagent still runs never notifies a false completion', async () => {
  // The report that started it (2026-10-08): the lead's own row goes running:false
  // the moment it hands control to a child, so the old single-row sample read the
  // fleet as idle and announced 任务已完成 while the child was still working. The
  // poll path now samples the aggregated flag (applyDescendantRunning) the same
  // projection feeds the phone pill, so the two can never disagree.
  const sent = []
  let clock = 3_000_000
  let items = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/list' ? { ok: true, value: { items } } : undefined
    },
    bridgeOptions: { ...notifyBridgeOptions(sent), now: () => clock }
  })
  try {
    const tick = async () => {
      t.bridge._sessionListCache = undefined
      await t.bridge.pollNotifyRunning()
    }
    items = [
      { sessionId: 'lead', running: true, title: '编队', updatedAt: clock },
      { sessionId: 'child', parentSessionId: 'lead', origin: 'subagent', running: true, updatedAt: clock }
    ]
    await tick()
    // The lead hands off control: its own row freezes, the child keeps working.
    items = [
      { sessionId: 'lead', running: false, title: '编队', updatedAt: clock - 1_000 },
      { sessionId: 'child', parentSessionId: 'lead', origin: 'subagent', running: true, updatedAt: clock }
    ]
    clock += 120_000
    await tick()
    assert.equal(sent.length, 0, 'a working child is not a completed lead')
    // The child settles: the fleet is done. quiet counts from the lead's last
    // activity (the handoff moment), so by now it already exceeds the grace
    // window and the next poll announces completion — for the lead only.
    // Before the subagent-row skip, the invisible child row judged its own
    // long-busy settle and pushed a second notice with a fallback title.
    items = [
      { sessionId: 'lead', running: false, title: '编队', updatedAt: clock },
      { sessionId: 'child', parentSessionId: 'lead', origin: 'subagent', running: false, updatedAt: clock }
    ]
    clock += 30_000
    await tick()
    assert.equal(sent.length, 0, 'the fleet settle is judged — and batched, not fired')
    clock += B.rideMs
    await tick()
    assert.equal(sent.length, 1, 'the settle fires for the lead once the fleet is done')
    assert.ok(sent[0].includes(encodeURIComponent('编队')), 'the notice names the lead, not the invisible child row')
    clock += 91_000
    await tick()
    assert.equal(sent.length, 1, 'and never fires twice for the same settle')
  } finally {
    await t.stop()
  }
})

test('bridge question push: one notice per question, identified by session title, silent when unconfigured', async () => {
  const sent = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/list'
          ? { ok: true, value: { items: [{ sessionId: 's1', running: false, title: '部署周报' }] } }
          : undefined
    },
    bridgeOptions: notifyBridgeOptions(sent)
  })
  const drain = () => new Promise((resolve) => setTimeout(resolve, 50))
  try {
    t.bridge.rememberPendingQuestion('evt-1', { rpcId: 'r1', sessionId: 's1', questions: [] })
    await drain()
    assert.equal(sent.length, 1, 'the arrival pushes immediately')
    assert.ok(sent[0].includes(encodeURIComponent('有问题需要你回答')), 'the notice names the wait')
    assert.ok(sent[0].includes(encodeURIComponent('部署周报')), 'the session title identifies it')
    // A reconnect replay of the same event id must stay silent.
    t.bridge.rememberPendingQuestion('evt-1', { rpcId: 'r1', sessionId: 's1', questions: [] })
    await drain()
    assert.equal(sent.length, 1, 'the same question pushes once, ever')
    // A genuinely new question (new event id) is a new wait.
    t.bridge.rememberPendingQuestion('evt-2', { rpcId: 'r2', sessionId: 's1', questions: [] })
    await drain()
    assert.equal(sent.length, 2)
    // The dedup table is bounded: the oldest key makes room, the newest stays.
    for (let i = 0; i < 256; i++) t.bridge.notifiedQuestionKeys.add(`k${String(i)}`)
    t.bridge.rememberPendingQuestion('evt-3', { rpcId: 'r3', sessionId: 's1', questions: [] })
    await drain()
    assert.equal(t.bridge.notifiedQuestionKeys.size, 256)
    assert.equal(t.bridge.notifiedQuestionKeys.has('k0'), false, 'oldest evicted')
    assert.equal(t.bridge.notifiedQuestionKeys.has('evt-3'), true, 'newest remembered')
  } finally {
    await t.stop()
  }

  // Zero-config: no channel, no key — the arrival is a silent no-op. No
  // fetch, no log line, and not even dedup state is touched.
  const sent2 = []
  const t2 = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/list' ? { ok: true, value: { items: [] } } : undefined
    },
    bridgeOptions: { notifyFetchImpl: async (url) => { sent2.push(String(url)) } }
  })
  try {
    const logsBefore = t2.logs.length
    t2.bridge.rememberPendingQuestion('evt-9', { rpcId: 'r9', sessionId: 's9', questions: [] })
    await drain()
    assert.equal(sent2.length, 0, 'nothing is sent')
    assert.equal(t2.bridge.notifiedQuestionKeys.size, 0, 'no dedup state for a dead channel')
    assert.equal(
      t2.logs.slice(logsBefore).some((entry) => entry.message.includes('notify')),
      false,
      'the no-op does not log'
    )
  } finally {
    await t2.stop()
  }
})
