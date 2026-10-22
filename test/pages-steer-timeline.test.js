// 2026-10-22, second round on the 「手机 Pocket 消息显示重构」 thread
// (session-7ad97a26). Two live reports are pinned here against the page's own
// functions, so reverting either fix turns a real assertion red:
//
//   ① 「重启了，但是不对，这个时间每次返回主页再进去对话框里面，就会刷新成 1 秒。
//      这个问题呢？」— 返回主页/再进会话会重建整页，跑着的回合被重新见到一次
//      turn/start，旧实现每次都把计时起点设成 Date.now()，于是 ANY running turn
//      read 1s again. The fix anchors on the span between two HOST records (turn
//      start → newest record in hand) and spends that span on the phone's clock.
//      Only a span crosses machines; no absolute host stamp meets Date.now().
//
//   ② 「然后排队的消息就是插入的消息吧，位置依然是不对的」— a steer is spliced
//      into the running turn, so its seq sits inside it. The old ordering pass
//      tried to relocate the bubble by timestamp and lifted it over the whole
//      process card above it. The fix splices the bubble into the turn at the
//      point its own record arrived and cuts the process run there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

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

// ---------------------------------------------------------------------------
// Transcript sandbox: the page's own visibleMessages, no DOM.
// ---------------------------------------------------------------------------

function buildTranscriptSandbox() {
  const { js } = mobilePageAssets({ locale: 'zh' })
  const names = ['eventSeq', 'contentBlocks', 'turnKeyOf', 'stepKey', 'visibleMessages', 'orderUserBubblesByTime']
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  return new Function(
    `${body}
     let turnElapsedByTurn=new Map(),turnRetryMax=new Map(),turnElapsedAt=0,turnElapsedHostStart=0,turnElapsedTurn=null,turnRetry=null;
     const L={turnError:'error',turnAborted:'aborted',turnBlocked:'blocked',turnMaxTokens:'max',turnInterrupted:'interrupted',retryFailed:'retried {n}'};
     return { visibleMessages }`,
  )()
}

const userAt = (seq, time, text) => ({
  event: { seq, time, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } },
})

const turnStart = (seq, time, turn) => ({ event: { seq, time, type: 'turn/start', data: { turn } } })

const turnEnd = (seq, time, turn) => ({ event: { seq, time, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } } })

const toolCall = (seq, time, turn, step, callId, name) => ({
  event: { seq, time, type: 'tool/call', data: { turn, step, callId, name, arguments: { q: name } } },
})

const toolResult = (seq, time, turn, step, callId) => ({
  event: {
    seq,
    time,
    type: 'tool/result',
    data: { turn, step, callId, name: 'read_file', message: { toolCallId: callId, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }] } },
  },
})

const answerAt = (seq, time, turn, step, text) => ({
  event: { seq, time, type: 'assistant/message', data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] } } },
})

function shape(rendered) {
  return rendered.map((message) => {
    if (message.role === 'user') return 'user'
    if (message.turnProcess) return `process#${message.segment}`
    const text = (message.blocks || []).map((block) => block.text || '').join('')
    return `reply:${text}`
  })
}

test('STEER-3 a steer cuts the process run where its record arrived', () => {
  const sandbox = buildTranscriptSandbox()
  const rendered = sandbox.visibleMessages([
    turnStart(1, 1_000, 1),
    toolCall(2, 2_000, 1, 1, 'c1', 'read_file'),
    toolResult(3, 3_000, 1, 1, 'c1'),
    userAt(4, 4_000, '途中插话'),
    toolCall(5, 5_000, 1, 2, 'c2', 'write_file'),
    toolResult(6, 6_000, 1, 2, 'c2'),
    answerAt(7, 7_000, 1, 3, '收工'),
    turnEnd(8, 8_000, 1),
  ])
  assert.deepEqual(
    shape(rendered),
    ['process#0', 'user', 'process#1', 'reply:收工'],
    'work before the bubble is one card, work after it is the next one',
  )
  assert.equal(rendered[1]._inTurn, true, 'the bubble is marked as belonging to the open turn')
  assert.equal(rendered[1].blocks[0].text, '途中插话')
})

test('STEER-4 a steer whose record predates the run lands above that run', () => {
  // Typed before the turn started, spliced into it afterwards: the record is older
  // than the tool work above it, so it belongs above that work — the 2026-10-19
  // contract, now served by the same insertion pass instead of a relocation.
  const sandbox = buildTranscriptSandbox()
  const rendered = sandbox.visibleMessages([
    turnStart(1, 1_000, 1),
    toolCall(2, 9_000, 1, 1, 'c1', 'read_file'),
    toolResult(3, 9_100, 1, 1, 'c1'),
    userAt(4, 2_000, '排队时写的'),
  ])
  assert.deepEqual(shape(rendered), ['user', 'process#0'], 'the bubble goes back to its own moment')
})

test('STEER-5 a steer that arrived after the last card stays after it', () => {
  const sandbox = buildTranscriptSandbox()
  const rendered = sandbox.visibleMessages([
    turnStart(1, 1_000, 1),
    toolCall(2, 2_000, 1, 1, 'c1', 'read_file'),
    toolResult(3, 2_100, 1, 1, 'c1'),
    userAt(4, 5_000, '后来的话'),
  ])
  assert.deepEqual(shape(rendered), ['process#0', 'user'], 'never hoisted over the work above it')
})

test('STEER-6 the 2026-10-19 relocation contract survives for rows outside a turn', () => {
  // No turn/start in the window: the bubble is a top-level row and the old
  // by-clock relocation still has to lift it over the newer answer.
  const sandbox = buildTranscriptSandbox()
  const rendered = sandbox.visibleMessages([
    userAt(1, 1_000, '第一问'),
    answerAt(2, 5_000, 1, 1, '第一答'),
    userAt(3, 3_000, '排队时写的'),
  ])
  assert.deepEqual(shape(rendered), ['user', 'user', 'reply:第一答'], 'the late bubble returns above the newer answer')
  assert.equal(rendered[1]._inTurn, undefined, 'it is not an inline row')
})

test('STEER-7 three steers keep the reading order of the work around them', () => {
  const sandbox = buildTranscriptSandbox()
  const rendered = sandbox.visibleMessages([
    turnStart(1, 1_000, 1),
    toolCall(2, 2_000, 1, 1, 'c1', 'read_file'),
    toolResult(3, 2_500, 1, 1, 'c1'),
    userAt(4, 3_000, '第一次插话'),
    toolCall(5, 4_000, 1, 2, 'c2', 'read_file'),
    userAt(6, 5_000, '第二次插话'),
    toolCall(7, 6_000, 1, 3, 'c3', 'run_command'),
    userAt(8, 7_000, '第三次插话'),
    answerAt(9, 8_000, 1, 4, '全部做完'),
  ])
  assert.deepEqual(
    shape(rendered),
    ['process#0', 'user', 'process#1', 'user', 'process#2', 'user', 'reply:全部做完'],
    'a card, a bubble, a card, a bubble — never one card with every bubble stacked on top',
  )
})

// ---------------------------------------------------------------------------
// Clock sandbox: the page's run-state functions with a controllable wall clock.
// ---------------------------------------------------------------------------

function buildClockSandbox(startNow) {
  const { js } = mobilePageAssets({ locale: 'zh' })
  const names = [
    'eventSeq',
    'eventTimeOf',
    'clearAwaitingTurn',
    'armAwaitingTurn',
    'expireAwaitingTurn',
    'noteTurnBoundary',
    'updateRunning',
    'clearTurnRunningWatch',
    'expireTurnRunning',
    'confirmTurnRunning',
    'finishTurnConfirm',
    'watchTurnRunning',
  ]
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  return new Function(
    `let now=${startNow};const Date={now:()=>now};
     const AWAITING_TURN_MAX_MS=9000,TURN_RUNNING_IDLE_MAX_MS=60000
     let awaitingTurnSeq=null,awaitingTurnTimer=null,agentRunning=false,lastHistoryKey='',activeSession='s1'
     let turnRunningSeq=-1,turnRunningOpen=false,turnRunningSeenSeq=-1,turnRunningTimer=null,turnRunningConfirming=false,pendingQuestion=null
     let stopPending=false,turnElapsedAt=0,turnElapsedHostStart=0,turnElapsedTurn=null,turnRetry=null
     const turnElapsedByTurn=new Map(),turnRetryMax=new Map()
     const stopTurnStatusTimer=()=>{}
     const setTimeout=()=>1,clearTimeout=()=>{}
     function syncPromptUi(){} function syncTurnStatus(){} function schedulePoll(){}
     function rpc(){return Promise.resolve({items:[]})}
     ${body}
     return {
       update(events){updateRunning(events)},
       advance(ms){now+=ms},
       elapsed(){return Date.now()-turnElapsedAt},
       spent(key){return turnElapsedByTurn.get(key)},
       clock(){return {turnElapsedAt,turnElapsedHostStart,turnElapsedTurn,turnRunningOpen}},
     }`,
  )()
}

const runningTurn = (hostStart, hostLatest) => [
  turnStart(1, hostStart, 1),
  toolCall(2, hostStart + 1_000, 1, 1, 'c1', 'read_file'),
  toolResult(3, hostLatest, 1, 1, 'c1'),
]

test('CLOCK-1 re-entering the conversation no longer restarts a 10-minute turn at 1s', () => {
  // The page is rebuilt from the log: turn/start is met again, then the newest
  // record. 600s of host span is already behind the turn; the clock must show it.
  const hostStart = 1_700_000_000_000
  const sandbox = buildClockSandbox(9_000_000)
  sandbox.update(runningTurn(hostStart, hostStart + 600_000))
  assert.equal(sandbox.elapsed(), 600_000, 'the first paint of the rebuilt page shows the real elapsed span')
  const shown = sandbox.clock()
  assert.equal(shown.turnRunningOpen, true, 'and the turn still reads as running')
  assert.equal(shown.turnElapsedHostStart, hostStart, 'the anchor keeps the host start stamp it measured from')

  // Same events, a page opened ten minutes later: still 600s, not 1s and not 1200s.
  const later = buildClockSandbox(9_600_000)
  later.update(runningTurn(hostStart, hostStart + 600_000))
  assert.equal(later.elapsed(), 600_000, 'the phone clock never enters the span')
})

test('CLOCK-2 between host records the clock keeps ticking on the phone', () => {
  const hostStart = 1_700_000_000_000
  const sandbox = buildClockSandbox(9_000_000)
  sandbox.update(runningTurn(hostStart, hostStart + 600_000))
  sandbox.advance(3_000)
  assert.equal(sandbox.elapsed(), 603_000, 'a quiet minute still advances — that is what proves the turn is not stuck')
})

test('CLOCK-3 a replayed poll never rewinds the clock', () => {
  // The poll re-delivers the same window; a naive re-anchor would snap the display
  // back to the last record. Elapsed time is monotonic, so it must not.
  const hostStart = 1_700_000_000_000
  const sandbox = buildClockSandbox(9_000_000)
  sandbox.update(runningTurn(hostStart, hostStart + 600_000))
  sandbox.advance(3_000)
  sandbox.update(runningTurn(hostStart, hostStart + 600_000))
  assert.equal(sandbox.elapsed(), 603_000, 'the same batch cannot take time away')
  sandbox.update(runningTurn(hostStart, hostStart + 700_000))
  assert.equal(sandbox.elapsed(), 700_000, 'a newer record that proves more time passed moves it forward')
})

test('CLOCK-4 a host whose clock is decades away still yields the right span', () => {
  // 1970-stamped records with the phone in 2026 — the comparison that used to pin
  // the status is gone; only the difference of the two host stamps is spent.
  const sandbox = buildClockSandbox(9_000_000)
  sandbox.update(runningTurn(1_000, 601_000))
  assert.equal(sandbox.elapsed(), 600_000, 'a 1970 host stamp cannot pin or reset the phone clock')
})

test('CLOCK-5 turn/end stores the exact span the host recorded', () => {
  const hostStart = 1_700_000_000_000
  const sandbox = buildClockSandbox(9_000_000)
  sandbox.update(runningTurn(hostStart, hostStart + 600_000))
  sandbox.advance(5_000)
  sandbox.update([turnEnd(9, hostStart + 700_000, 1)])
  assert.equal(sandbox.spent('1'), 700_000, 'the finished turn keeps the host-measured total, not the poll-skewed one')
  assert.equal(sandbox.clock().turnElapsedAt, 0, 'and the live clock is released')
  assert.equal(sandbox.clock().turnElapsedHostStart, 0, 'with its anchor')
})
