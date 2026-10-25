// W4-收尾 任务B (change 2026-10-07-feat-pocket-tunnel-stream-fallback, client half).
//
// The bridge half (card 1a) ships `GET /api/session/events` plus `connectionMode` on
// /api/status, the SSE status frame and every events answer. This file pins the phone
// half of that contract:
//   - mode 'tunnel' never constructs an EventSource; the page polls the events
//     endpoint instead (1.5s after frames, doubling on empty polls, 6s cap),
//   - the history RPC stays the durable backbone (streamConnected drops when the
//     poller cannot be trusted and returns when it can),
//   - resync triggers: new collector generation, overflow, recovery after failures,
//   - a mode flip switches transports WITHOUT blanking the transcript,
//   - visibilitychange pauses the poll; returning to the foreground polls at once.
//
// House pattern: the page script is a rendered string, so the organs are extracted and
// run against synthetic state with fake timers and a scripted fetch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the rendered asset`)
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const char = source[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${name}`)
}

const POLL_CONSTS = js.match(/const EVENTS_POLL_BASE_MS=[^\n]*/)[0]
const POLL_STATE = js.match(/let connectionMode='lan',eventPollTimer=[^\n]*/)[0]
// 哪些流式事件算「结构变了」是页面自己的判断，沙箱照抄原文而不是另写一份
// （两份判定漂移过：沙箱少抄一行，整批帧就一个都不往渲染器送）。
const FULL_PAINT_SET = js.match(/const FULL_PAINT_STREAM_EVENTS=[^\n]*/)[0]

function buildPollSandbox(state = {}) {
  const world = {
    fetchUrls: [],
    fetchQueue: [],
    timers: [],
    opened: [],
    closed: [],
    reruns: [],
    renders: 0,
    fullPaints: 0,
    pendingSyncs: 0,
    projectionsSyncs: 0,
    historyCalls: 0,
    notifyDown: 0,
    noteRecovery: 0,
    models: [],
    location: [],
    staleCleared: 0,
  }
  const setTimeoutFake = (fn, ms) => {
    const handle = { fn, ms, cleared: false }
    world.timers.push(handle)
    return handle
  }
  const clearTimeoutFake = (handle) => {
    if (handle) handle.cleared = true
  }
  const fireNext = async () => {
    const handle = world.timers.find((t) => !t.cleared && !t.done)
    assert.ok(handle, 'a live timer must exist to fire')
    handle.done = true
    handle.fn()
    await settle()
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  const reply = (init) => ({
    ok: (init.status ?? 200) < 300,
    status: init.status ?? 200,
    url: init.url ?? 'https://pocket.example/api/session/events',
    json: async () => init.body ?? {},
  })
  const fetchFake = async (url) => {
    world.fetchUrls.push(url)
    const next = world.fetchQueue.length ? world.fetchQueue.shift() : null
    if (next instanceof Error) throw next
    if (typeof next === 'function') return next()
    return next ?? reply({ body: { ok: true, mode: 'tunnel', generation: 'g1', connected: true, events: [], latestSeq: 0 } })
  }
  // extractFunction anchors on the literal `function NAME(`, which for an async
  // function sits *after* the modifier — re-attach it or the body's awaits are a
  // SyntaxError (the stream-watermark house note).
  const organs = ['stopEventPolling', 'pauseEventPolling', 'scheduleEventPoll', 'openEventPolling', 'openRealtime', 'setConnectionMode', 'reopenRealtime', 'applyTokenFrame', 'applyStreamEventFrame']
    .map((name) => extractFunction(js, name))
    .concat('async ' + extractFunction(js, 'pollSessionEvents'))
    .join('\n')
  const helpers = ['eventSeq', 'streamWatermark', 'tokenChunkText']
    .map((name) => extractFunction(js, name))
    .join('\n')
  const make = new Function(
    'fetch',
    'setTimeout',
    'clearTimeout',
    'location',
    'document',
    'world',
    `
    let activeSession=${JSON.stringify(state.activeSession ?? 's1')}
    let sessionStream=${state.sessionStream ? '{close(){world.closed.push("stream")}}' : 'null'}
    let streamConnected=${JSON.stringify(Boolean(state.streamConnected))}
    let tokenStream=null
    let lastStreamFrameAt=0
    let lastHistoryKey=''
    let streamEvents=${JSON.stringify(state.streamEvents ?? [])}
    let streamRevision=${state.streamRevision ?? 0}
    const STREAM_EVENTS_CAP=2000
    ${POLL_CONSTS}
    ${POLL_STATE}
    connectionMode=${JSON.stringify(state.mode ?? 'tunnel')}
    ${helpers}
    function noteHostClock(){}
    const streamWatermarks=new Map()
    function noteStreamRecovery(){world.noteRecovery+=1}
    function notifyStreamDown(){world.notifyDown+=1}
    function loadHistory(){world.historyCalls+=1}
    let pendingFrames=0
    let streamRenderFrame=null,streamNeedsFullPaint=false
    ${FULL_PAINT_SET}
    const requestAnimationFrame=(fn)=>{setImmediate(fn);return ++pendingFrames}
    const flushStreamRender=()=>{streamRenderFrame=null;streamNeedsFullPaint=false;world.renders+=1}
    // 与页面同形的排队器：整批帧只排一帧渲染，多出来的帧并进那一帧。
    function queueStreamRender(sessionId,fullPaint){streamNeedsFullPaint=streamNeedsFullPaint||fullPaint;world.lastFullPaint=!!streamNeedsFullPaint;if(streamRenderFrame!==null)return;streamRenderFrame=requestAnimationFrame(()=>flushStreamRender(sessionId))}
    function schedulePendingSync(){world.pendingSyncs+=1}
    function scheduleProjectionsSync(){world.projectionsSyncs+=1}
    function showSessionModel(entry){world.models.push(entry)}
    function clearStreamStaleWatch(){world.staleCleared+=1}
    function openSessionStream(id){world.opened.push(id)}
    function reopenSessionStream(){world.reruns.push('reopenSessionStream')}
    function armStreamSnapshot(){}
    function settleStreamSnapshot(ok){world.settled=ok}
    function subagentQuery(){return ''}
    ${organs}
    return {
      openRealtime, openEventPolling, pollSessionEvents, setConnectionMode, reopenRealtime, pauseEventPolling, stopEventPolling,
      batchRenders(){const n=world.renders;world.renders=0;world.lastFullPaint=null;return n},
      // requestAnimationFrame 在这里是 setImmediate：等一拍让排队的渲染真的跑完，再读计数。
      settlePaints(){return new Promise((resolve)=>setImmediate(resolve))},
      get lastBatchFullPaint(){return world.lastFullPaint},
      get connectionMode(){return connectionMode},
      set connectionMode(v){connectionMode=v},
      get eventPollSession(){return eventPollSession},
      get eventPollCursor(){return eventPollCursor},
      get eventPollGeneration(){return eventPollGeneration},
      get eventPollEmpty(){return eventPollEmpty},
      get eventPollTimer(){return eventPollTimer},
      get streamConnected(){return streamConnected},
      set streamConnected(v){streamConnected=v},
      get tokenStream(){return tokenStream},
      get streamEvents(){return streamEvents},
      get streamRevision(){return streamRevision},
      get lastStreamFrameAt(){return lastStreamFrameAt},
      setActive(v){activeSession=v},
    }
  `,
  )
  const sandbox = make(fetchFake, setTimeoutFake, clearTimeoutFake, { replace: (t) => world.location.push(t) }, { hidden: Boolean(state.hidden) }, world)
  sandbox.world = world
  sandbox.reply = reply
  sandbox.fireNext = fireNext
  sandbox.settle = settle
  return sandbox
}

const eventsReply = (body) => ({
  ok: true,
  status: 200,
  url: 'https://pocket.example/api/session/events',
  json: async () => ({ ok: true, mode: 'tunnel', generation: 'g1', connected: true, events: [], latestSeq: 0, ...body }),
})

// ------------------------------------------------------------------ 模式门

test('openRealtime on lan opens the SSE and never schedules a poll', () => {
  const sandbox = buildPollSandbox({ mode: 'lan' })
  sandbox.openRealtime('s1')
  assert.deepEqual(sandbox.world.opened, ['s1'], 'lan keeps the SSE path')
  assert.equal(sandbox.world.timers.length, 0, 'no polling timer on lan')
  assert.equal(sandbox.eventPollSession, null)
})

test('openRealtime on tunnel never builds an EventSource and polls at once', () => {
  const sandbox = buildPollSandbox({ mode: 'tunnel' })
  sandbox.openRealtime('s1')
  assert.deepEqual(sandbox.world.opened, [], 'tunnel must not open an SSE')
  assert.equal(sandbox.eventPollSession, 's1')
  assert.equal(sandbox.world.timers.length, 1, 'the first poll is scheduled immediately')
  assert.equal(sandbox.world.timers[0].ms, 0)
  assert.equal(sandbox.world.settled, false, 'the snapshot promise settles false so openSession goes to history at once')
})

// ------------------------------------------------------------------ 轮询节奏

test('the poll rhythm: frames pin 1.5s, empty rounds double, 6s cap, frames reset', async () => {
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  sandbox.openEventPolling('s1')
  const seen = []
  // Round 1 (scheduled at 0): empty.
  await sandbox.fireNext()
  seen.push(sandbox.world.timers.filter((t) => t.done).at(-1).ms)
  // Rounds 2..4: still empty.
  for (let i = 0; i < 3; i += 1) {
    await sandbox.fireNext()
    seen.push(sandbox.world.timers.filter((t) => t.done).at(-1).ms)
  }
  assert.deepEqual(seen, [0, 3000, 6000, 6000], '1.5s base doubles on empty polls and caps at 6s')
  // 一次工具回合里的 step/start、step/end、tool/result 只是往最后一条消息里追加内容：
  // 2026-10-22 起它们不再要求整屏重建（以前每个非 chunk 事件都整屏重排一次 #messages，
  // 真机 69 次工具 ⇒ 250ms 一拍的整屏闪）。只有结构真的变了的 turn/user 事件才整屏重建。
  sandbox.world.fetchQueue.push(eventsReply({
    events: [
      { seq: 1, kind: 'event', frame: { type: 'tool/result', seq: 3, data: {} } },
      { seq: 2, kind: 'event', frame: { type: 'step/start', seq: 4, data: {} } },
    ],
    latestSeq: 2,
  }))
  await sandbox.fireNext()
  assert.equal(sandbox.eventPollEmpty, 0)
  await sandbox.settlePaints()
  assert.equal(sandbox.lastBatchFullPaint, false, 'content-only frames patch the tail instead of repainting the transcript')
  const next = sandbox.world.timers.filter((t) => !t.done && !t.cleared).at(-1)
  assert.equal(next.ms, 1500, 'frames bring the poll straight back to 1.5s')
})

test('a structural frame in the same batch as content frames asks for the repaint', async () => {
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  sandbox.openEventPolling('s1')
  const sequence = ['tool/result', 'step/start', 'assistant/message', 'turn/end']
  sandbox.world.fetchQueue.push(eventsReply({
    events: sequence.map((type, i) => ({ seq: i + 1, kind: 'event', frame: { type, seq: i + 1, data: {} } })),
    latestSeq: sequence.length,
  }))
  // 2026-10-22：整批帧只排一帧渲染（首次 requestAnimationFrame 之前不再重复排队），
  // 所以下面三个用例都用 batchRenders() 读「排了几帧」。
  await sandbox.fireNext()
  await sandbox.settlePaints()
  assert.equal(sandbox.lastBatchFullPaint, true, 'turn/end is structural: the finished turn may have been regrouped')
  assert.equal(sandbox.batchRenders(), 1, 'still one frame of rendering for the batch')
})

test('a frame batch without structural frames keeps the tail patch', async () => {
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  sandbox.openEventPolling('s1')
  const sequence = ['tool/result', 'step/start', 'model/selection']
  sandbox.world.fetchQueue.push(eventsReply({
    events: sequence.map((type, i) => ({ seq: i + 1, kind: 'event', frame: { type, seq: i + 1, data: { provider: 'p', model: 'm' } } })),
    latestSeq: sequence.length,
  }))
  await sandbox.fireNext()
  await sandbox.settlePaints()
  assert.equal(sandbox.lastBatchFullPaint, false, 'content-only frames patch the tail instead of repainting the transcript')
  assert.equal(sandbox.batchRenders(), 1, 'still one frame of rendering for the batch')
})

test('the cursor starts at -1 and follows what the answer actually carried', async () => {
  // 2026-10-22：游标不再直接吃 latestSeq。latestSeq 是「交换机此刻的最新序号」，可能比这一批
  // 真正带回的帧和窗口里已有的帧都更靠前——真机上模型/工具事件与 assistant/chunk 走两条记录流，
  // 直接跳跃会把这一段事件永久留在窗口之外。跟随规则：latestSeq 与「本批 + 窗口」里已知的最大
  // 帧序号取小；批次里没有帧时只留 latestSeq（那是心跳）。
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  sandbox.openEventPolling('s1')
  await sandbox.fireNext()
  assert.match(sandbox.world.fetchUrls[0], /sinceSeq=-1$/, 'the first poll takes the whole window')
  sandbox.world.fetchQueue.push(eventsReply({ latestSeq: 41 }))
  await sandbox.fireNext()
  assert.match(sandbox.world.fetchUrls[1], /sinceSeq=0$/, 'a heartbeat lifted the cursor to its latestSeq')
  sandbox.world.fetchQueue.push(eventsReply({ events: [{ seq: 30, kind: 'event', frame: { type: 'turn/end', seq: 30, data: {} } }], latestSeq: 44 }))
  await sandbox.fireNext()
  assert.match(sandbox.world.fetchUrls[2], /sinceSeq=41$/, 'and continues from the previous cursor')
  assert.equal(sandbox.eventPollCursor, 41, 'a seq-hole is not crossed: the lagging frame stays in the window')
  sandbox.world.fetchQueue.push(eventsReply({ events: [{ seq: 44, kind: 'event', frame: { type: 'turn/end', seq: 44, data: {} } }], latestSeq: 44 }))
  await sandbox.fireNext()
  assert.equal(sandbox.eventPollCursor, 44, 'once the answer carries the frame the cursor moves on')
  await sandbox.fireNext()
  assert.match(sandbox.world.fetchUrls[4], /sinceSeq=44$/, 'the next round resumes from the frames it just took')
})

test('hidden tabs do not poll, and a poll for a session no longer active is dropped', async () => {
  const hidden = buildPollSandbox({ mode: 'tunnel', activeSession: 's1', hidden: true })
  await hidden.pollSessionEvents('s1')
  assert.equal(hidden.world.fetchUrls.length, 0, 'hidden means no fetch at all')
  const stale = buildPollSandbox({ mode: 'tunnel', activeSession: 's2' })
  await stale.pollSessionEvents('s1')
  assert.equal(stale.world.fetchUrls.length, 0, 'a background session is not polled')
})

test('a poll never re-enters itself while one answer is in flight', async () => {
  const pending = () => new Promise(() => {})
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  sandbox.world.fetchQueue.push(pending(), pending())
  // Deliberately NOT awaited: the in-flight poll is the fixture. A second call while
  // the first is still pending must be swallowed by the busy guard.
  void sandbox.pollSessionEvents('s1')
  await sandbox.settle()
  await sandbox.pollSessionEvents('s1')
  assert.equal(sandbox.world.fetchUrls.length, 1, 'the busy guard swallowed the second call')
})

// ------------------------------------------------------------------ 帧分发（双通道共用）

test('token frames build, grow and clear the bubble exactly as the SSE path does', async () => {
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  sandbox.openEventPolling('s1')
  sandbox.world.fetchQueue.push(eventsReply({
    events: [
      { seq: 1, kind: 'token', frame: { type: 'start', revision: 7 } },
      { seq: 2, kind: 'token', frame: { type: 'chunk', revision: 7, index: 0, chunk: '你' } },
      { seq: 3, kind: 'token', frame: { type: 'chunk', revision: 7, index: 0, chunk: '你' } },
    ],
    latestSeq: 3,
  }))
  await sandbox.fireNext()
  await sandbox.settlePaints()
  assert.equal(sandbox.tokenStream.text, '你', 'chunks append, replays dedupe')
  assert.equal(sandbox.batchRenders(), 1, 'two chunks, one frame of rendering')
  sandbox.world.fetchQueue.push(eventsReply({ events: [{ seq: 4, kind: 'token', frame: { type: 'end', outcome: { kind: 'done' } } }], latestSeq: 4 }))
  await sandbox.fireNext()
  assert.equal(sandbox.tokenStream, null, 'end clears the bubble')
})

test('event frames land in the stream window, bump the revision and hold the watermark', async () => {
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  sandbox.openEventPolling('s1')
  sandbox.world.fetchQueue.push(eventsReply({
    events: [
      { seq: 5, kind: 'event', frame: { type: 'user/message', seq: 9, data: {} } },
      { seq: 6, kind: 'event', frame: { type: 'model/selection', data: { provider: 'p', model: 'm' } } },
      { seq: 7, kind: 'event', frame: { event: { type: 'assistant/chunk', seq: 2, data: {} } } },
    ],
    latestSeq: 7,
  }))
  await sandbox.fireNext()
  assert.equal(sandbox.streamEvents.length, 3, 'durable records join the window (wrapped or bare)')
  assert.equal(sandbox.streamRevision, 3)
  assert.deepEqual(sandbox.world.models, [{ provider: 'p', model: 'm' }], 'model/selection reaches the model row')
  assert.equal(sandbox.world.pendingSyncs, 2, 'non-chunk frames schedule a pending sync (assistant/chunk honestly writes its own state)')
  assert.equal(sandbox.world.projectionsSyncs, 1, 'turn-relevant frames schedule a projections sync')
})

test('a held empty answer restarts the poll at once instead of climbing the ladder', async () => {
  // The bridge only sets `held` when it actually waited for something to happen.
  // Backing off from that would fight the long-poll: the point of holding is that
  // one request is essentially always open, so the phone must come straight back.
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  sandbox.openEventPolling('s1')
  await sandbox.fireNext()
  await sandbox.fireNext()
  sandbox.world.fetchQueue.push(eventsReply({ held: true }))
  await sandbox.fireNext()

  assert.equal(sandbox.eventPollEmpty, 0, 'a waited-on empty is not a quiet spell')
  const next = sandbox.world.timers.filter((t) => !t.done && !t.cleared).at(-1)
  assert.equal(next.ms, 1500, 'and the next poll goes out at the base cadence, not at the doubled one')
})

// ------------------------------------------------------------------ 重同步三触发

test('a new collector generation forces a history resync before cursors are trusted', async () => {
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  sandbox.openEventPolling('s1')
  await sandbox.fireNext() // generation g1, cursor 0
  sandbox.streamConnected = true
  sandbox.world.fetchQueue.push(eventsReply({ generation: 'g2', latestSeq: 3 }))
  await sandbox.fireNext()
  assert.equal(sandbox.world.historyCalls, 1, 'history is re-pulled')
  assert.equal(sandbox.streamConnected, false, 'the live flag waits for proof again')
  assert.equal(sandbox.eventPollGeneration, 'g2')
  sandbox.world.fetchQueue.push(eventsReply({ generation: 'g2', latestSeq: 4 }))
  await sandbox.fireNext()
  assert.equal(sandbox.world.historyCalls, 1, 'the same generation does not resync twice')
  assert.equal(sandbox.streamConnected, true, 'and a healthy answer restores the live flag')
})

test('an overflow answer resyncs the transcript the same way', async () => {
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  sandbox.openEventPolling('s1')
  await sandbox.fireNext()
  sandbox.world.fetchQueue.push(eventsReply({ overflow: true, latestSeq: 9 }))
  await sandbox.fireNext()
  assert.equal(sandbox.world.historyCalls, 1, 'trimmed frames are re-fetched, not skipped')
})

test('two consecutive failures drop the live flag, raise the notice, and recovery resyncs', async () => {
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  sandbox.openEventPolling('s1')
  await sandbox.fireNext()
  sandbox.streamConnected = true
  sandbox.world.fetchQueue.push(new Error('bridge gone'))
  await sandbox.fireNext()
  assert.equal(sandbox.streamConnected, true, 'one failure is a blip')
  assert.equal(sandbox.world.notifyDown, 0)
  sandbox.world.fetchQueue.push(new Error('bridge gone'))
  await sandbox.fireNext()
  assert.equal(sandbox.streamConnected, false, 'two strikes hand the transcript back to the history poll')
  assert.equal(sandbox.world.notifyDown, 1, 'and the outage is named once')
  sandbox.world.fetchQueue.push(eventsReply({ latestSeq: 8 }))
  await sandbox.fireNext()
  assert.equal(sandbox.world.historyCalls, 1, 'the first answer after failures resyncs')
  assert.equal(sandbox.world.noteRecovery >= 1, true, 'and the recovery retires the notice')
  assert.equal(sandbox.streamConnected, false, 'the resync round keeps the live flag down while history rebuilds')
  await sandbox.fireNext()
  assert.equal(sandbox.streamConnected, true, 'and a clean round restores it')
})

test('a poll answer with connected:false drops the live flag without a resync', async () => {
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  sandbox.openEventPolling('s1')
  await sandbox.fireNext()
  sandbox.streamConnected = true
  sandbox.world.fetchQueue.push(eventsReply({ connected: false }))
  await sandbox.fireNext()
  assert.equal(sandbox.streamConnected, false, 'the history poll returns to its active cadence')
  assert.equal(sandbox.world.historyCalls, 0, 'no resync: nothing was lost, the follow is just down')
  sandbox.world.fetchQueue.push(eventsReply({ connected: true }))
  await sandbox.fireNext()
  assert.equal(sandbox.streamConnected, true, 'and the flag returns with the carrier')
})

// ------------------------------------------------------------------ 门户与切换

test('a 401 walks to /disconnected and the consent gate walks to /consent', async () => {
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  sandbox.openEventPolling('s1')
  await sandbox.fireNext()
  sandbox.world.fetchQueue.push(sandbox.reply({ status: 401, body: {} }))
  await sandbox.fireNext()
  assert.deepEqual(sandbox.world.location, ['/disconnected'])
  const consented = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  consented.openEventPolling('s1')
  await consented.fireNext()
  consented.world.fetchQueue.push(consented.reply({ url: 'https://pocket.example/consent?next=/', body: '<html>' }))
  await consented.fireNext()
  assert.deepEqual(consented.world.location, ['/consent?next=/'], 'the consent gate is walked, not parsed as JSON')
})

test('a poll answer carrying mode:lan switches back to the SSE in the same tick', async () => {
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  sandbox.openEventPolling('s1')
  await sandbox.fireNext()
  sandbox.world.fetchQueue.push(eventsReply({ mode: 'lan', latestSeq: 2 }))
  await sandbox.fireNext()
  assert.deepEqual(sandbox.world.opened, ['s1'], 'the SSE takes over')
  assert.equal(sandbox.eventPollSession, null, 'the poller is torn down')
  assert.equal(sandbox.connectionMode, 'lan')
})

test('setConnectionMode flips transports without blanking the transcript', () => {
  const toTunnel = buildPollSandbox({ mode: 'lan', activeSession: 's1', sessionStream: true, streamConnected: true, streamEvents: [{ kept: true }] })
  toTunnel.setConnectionMode('tunnel')
  assert.deepEqual(toTunnel.world.closed, ['stream'], 'the SSE closes')
  assert.equal(toTunnel.eventPollSession, 's1', 'the poller takes over')
  assert.equal(toTunnel.streamEvents.length, 1, 'painted records survive the swap')
  assert.equal(toTunnel.streamConnected, false, 'the live flag belongs to the new leg now')
  assert.equal(toTunnel.tokenStream, null)
  const toLan = buildPollSandbox({ mode: 'tunnel', activeSession: 's1', streamEvents: [{ kept: true }] })
  toLan.openEventPolling('s1')
  toLan.setConnectionMode('lan')
  assert.deepEqual(toLan.world.opened, ['s1'])
  assert.equal(toLan.eventPollSession, null)
  assert.equal(toLan.streamEvents.length, 1)
  const same = buildPollSandbox({ mode: 'lan', activeSession: 's1' })
  same.setConnectionMode('lan')
  assert.deepEqual(same.world.opened, [], 'same mode is a no-op')
  assert.deepEqual(same.world.closed, [])
})

// ------------------------------------------------------------------ 可见性

test('visibility pauses the poll without losing the cursor, and the foreground polls at once', async () => {
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's1' })
  sandbox.openEventPolling('s1')
  await sandbox.fireNext()
  assert.equal(sandbox.eventPollCursor, 0, 'an answer with no frames leaves the cursor exactly where it was')
  sandbox.pauseEventPolling()
  assert.equal(sandbox.eventPollTimer, null, 'hidden: the timer is gone')
  assert.equal(sandbox.eventPollSession, 's1', 'the session and its cursor stay')
  sandbox.reopenRealtime()
  const next = sandbox.world.timers.filter((t) => !t.done && !t.cleared).at(-1)
  assert.equal(next.ms, 0, 'foreground: an immediate poll')
  // The LAN branch of reopen still reaches the SSE retry.
  const lan = buildPollSandbox({ mode: 'lan', activeSession: 's1' })
  lan.reopenRealtime()
  assert.deepEqual(lan.world.reruns, ['reopenSessionStream'])
})

test('reopenRealtime ignores a poller that belongs to another session', () => {
  const sandbox = buildPollSandbox({ mode: 'tunnel', activeSession: 's2' })
  sandbox.reopenRealtime()
  assert.equal(sandbox.world.timers.length, 0)
})

// ------------------------------------------------------------------ 接线源断言

test('the page is wired: openSession goes through openRealtime and the SSE listeners delegate', () => {
  const openSlice = js.slice(js.indexOf('async function openSession(id,title'), js.indexOf('function armSkeletonWatchdog'))
  assert.ok(openSlice.includes('openRealtime(id)'), 'openSession asks the dispatcher, not the SSE directly')
  const streamSlice = js.slice(js.indexOf('function openSessionStream(sessionId)'), js.indexOf('async function showSessionList()'))
  assert.ok(streamSlice.includes('applyStreamEventFrame(sessionId,frame)'), 'the event listener shares the poller frame body')
  assert.ok(streamSlice.includes('applyTokenFrame(sessionId,frame)'), 'and so does the token listener')
  const closing = js.slice(js.indexOf('function closeSessionStream('), js.indexOf('function applyHistory('))
  assert.ok(closing.includes("if(typeof stopEventPolling==='function')stopEventPolling()"), 'leaving a session stops the poller too')
  assert.ok(js.includes('pauseEventPolling();stopListPoll();return}'), 'hidden pauses the polls (events + the landing list clock)')
  assert.ok(js.includes('reopenRealtime();'), 'foreground goes through the dispatcher')
  const checking = 'async ' + extractFunction(js, 'checkConnection')
  const live = extractFunction(js, 'applyLiveStatus')
  for (const [name, organ] of [['checkConnection', checking], ['applyLiveStatus', live]]) {
    assert.ok(organ.includes("typeof body.connectionMode==='string'"), `${name} reads the mode field`)
    assert.ok(organ.includes("typeof setConnectionMode==='function'"), `${name} switches transports when it can`)
  }
  assert.match(POLL_CONSTS, /EVENTS_POLL_BASE_MS=1500,EVENTS_POLL_MAX_MS=6000,EVENTS_FETCH_TIMEOUT_MS=10000/, 'the card contract periods, verbatim')
})

test('the events fetch creates no second AbortController (single-controller pin)', () => {
  assert.equal(js.split('new AbortController()').length - 1, 1, 'the page still owns exactly one controller — the rpc timeout')
  assert.ok(js.includes('Promise.race([fetch(\'/api/session/events'), 'the poll ceiling is a race, not an abort')
})
