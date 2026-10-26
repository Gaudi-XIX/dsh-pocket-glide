// WD the run watchdog — source pins for the bounded retirement of the turn high-water.
//
// This file is deliberately source-level: it reads the mobile page as text and pins the
// shape of the code. The behaviour cases (WD1..WD4) live in transcript-order.test.js,
// next to the sandbox that already executes these functions — that sandbox needs a
// Function body, and this file must not build one.
//
// Anchors are symbol anchors (`function name(`), never line numbers: line anchors drift
// with every neighbouring commit, symbol anchors do not.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

function between(startAnchor, endAnchor, source = mobilePageAssets({ locale: 'zh' }).js) {
  const start = source.indexOf(startAnchor)
  assert.notEqual(start, -1, `anchor ${startAnchor} must exist in the page`)
  const end = source.indexOf(endAnchor, start + startAnchor.length)
  assert.notEqual(end, -1, `anchor ${endAnchor} must exist after ${startAnchor}`)
  return source.slice(start, end)
}

function extractFunction(source, name) {
  const head = `function ${name}(`
  const start = source.indexOf(head)
  assert.notEqual(start, -1, `function ${name} must exist in the page`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const char = source[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${name}`)
}

test('WD the idle bound the page ships is a judgement value inside the accepted band', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const idle = Number((js.match(/TURN_RUNNING_IDLE_MAX_MS=(\d+)/) || [])[1])
  assert.ok(Number.isFinite(idle) && idle > 0, 'the page declares TURN_RUNNING_IDLE_MAX_MS')
  assert.ok(
    idle >= 300000 && idle <= 900000,
    `the idle bound must stay inside the accepted 5..15 minute band, got ${idle}`,
  )
})

test('WD the watch arms on the page own bound, and only off a log that moved', () => {
  const watch = between('function watchTurnRunning(maxSeq)', 'function updateRunning(events)')
  assert.ok(
    watch.includes('setTimeout(expireTurnRunning,TURN_RUNNING_IDLE_MAX_MS)'),
    'the watch is armed once, on the bound the page itself declares',
  )
  assert.ok(watch.includes('maxSeq>turnRunningSeenSeq'), 'progress is the only thing that restarts the clock')
  assert.ok(
    watch.includes('awaitingTurnSeq!==null') && watch.includes('pendingQuestion!==null'),
    'both gates hold the watch off: an unended wait and an open question each own the turn',
  )
  assert.ok(!watch.includes('event.time'), 'no host timestamp is read by the watch')
})

test('WD the watch is called where the run state is decided, on every event seq', () => {
  const update = between('function updateRunning(events)', 'function todoProgress(')
  assert.ok(update.includes('watchTurnRunning(maxSeq)'), 'every scan of the log calls the watch')
  assert.ok(update.includes('noteTurnBoundary(entry)'), 'and every boundary still feeds the high-water mark')
  assert.ok(update.includes('eventSeq(entry)>awaitingTurnSeq'), 'the wait judgement is untouched')
  assert.match(
    update,
    /agentRunning=turnRunningOpen\|\|awaitingTurnSeq!==null/,
    'the run state still reads the mark and the wait instead of re-scanning the window',
  )
  const collect = update.indexOf('const seq=eventSeq(entry);if(seq>maxSeq)maxSeq=seq;')
  const filter = update.indexOf("if(t!=='turn/start'&&t!=='turn/end')continue;")
  assert.notEqual(collect, -1, 'every event contributes its seq, not only the boundaries')
  assert.ok(
    filter !== -1 && collect < filter,
    'the seq is counted before the boundary-only filter can skip the event — a turn with chunks but no new boundary is not a silent turn',
  )
  assert.ok(!update.includes('event.time'), 'no host timestamp is read here either')
})

test('WD retirement raises the mark, asks the host, and closes only on a host that agrees', () => {
  // The bound itself no longer decides anything: it raises the mark and fires a consult.
  // Silence in the phone log is not evidence the turn ended (a long tool call or a busy
  // subagent goes quiet while the host still works), which is what took the stop button
  // away on 2026-10-13. So the three lines that retire the run state live in the answer
  // handler, not in the bound.
  const expire = between('function expireTurnRunning()', 'function confirmTurnRunning(')
  assert.ok(
    expire.includes('if(turnRunningSeenSeq>turnRunningSeq)turnRunningSeq=turnRunningSeenSeq'),
    'the mark is raised to the newest seq the log showed, so a replay of the same window cannot reopen the turn',
  )
  assert.ok(!expire.includes('turnRunningOpen=false'), 'the bound no longer closes the turn on its own')
  assert.ok(expire.includes('turnRunningConfirming=true'), 'the consult is marked in flight so the next bound cannot stack another')
  assert.ok(expire.includes('confirmTurnRunning(turnRunningSeenSeq)'), 'and the consult carries the seq the log had reached')
  const consult = between('function confirmTurnRunning(', 'function finishTurnConfirm(')
  assert.ok(consult.includes("rpc('session.list'"), 'the verdict comes from the host row, the same source the list page reads')
  assert.ok(consult.includes('.catch(()=>finishTurnConfirm(seenAtStart,false))'), 'a bridge that cannot answer falls back to retiring — the status must not pin forever')
  const finish = between('function finishTurnConfirm(', 'function watchTurnRunning(maxSeq)')
  assert.ok(finish.includes('if(turnRunningSeenSeq>seenAtStart){watchTurnRunning(turnRunningSeenSeq);return}'), 'progress seen during the round trip voids a verdict about the old silence')
  assert.ok(finish.includes('if(busy){'), 'the host saying "still running" keeps the turn open')
  assert.ok(finish.includes('turnRunningOpen=false'), 'and only the other answer closes it')
  assert.ok(finish.includes('agentRunning=awaitingTurnSeq!==null'), 'the run state is re-derived, not forced false')
  assert.ok(finish.includes("lastHistoryKey=''"), 'and the history key is dropped so the next poll repaints')
})

test('WD the literals the earlier cards pinned are still intact and still single', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const mark = between('function noteTurnBoundary(entry)', 'function updateRunning(events)')
  assert.ok(mark.includes('if(seq<turnRunningSeq)return'), 'an older boundary still never rewinds the mark')
  assert.ok(mark.includes("turnRunningOpen=type==='turn/start'"), 'the open flag still follows the newest boundary')
  assert.ok(mark.includes('clearTurnRunningWatch()'), 'a fresh turn restarts the watch instead of inheriting the old one')
  assert.equal(
    js.split('agentRunning=turnRunningOpen||awaitingTurnSeq!==null').length - 1,
    1,
    'the verdict line exists exactly once',
  )
  assert.ok(!js.includes('awaitingTurnStartedAt'), 'the wall-clock slot stays gone from the page')
  assert.ok(!js.includes('Date.now()-1000'), 'and so does the expression that armed it')
})

test('WD the new page code is spliceable into a Function body', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  for (const name of ['clearTurnRunningWatch', 'expireTurnRunning', 'watchTurnRunning']) {
    const body = extractFunction(js, name)
    assert.ok(!body.includes('`'), `${name} must not carry a backtick`)
    assert.ok(!body.includes('${'), `${name} must not carry a template hole`)
  }
})
