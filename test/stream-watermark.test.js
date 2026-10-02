// 组 A 回归断言（change 2026-10-02-fix-pocket-audit-remediation / WP-A1）。
//
// The page script lives inside one template literal, so it cannot be imported.
// These tests follow the house pattern: pull the REAL function text out of the
// rendered asset (extractFunction / between) and run it against synthetic state,
// so a regression in the page goes red on a runner rather than on a phone.
//
// Covered here: AC-A1 (per-session watermark), A-3 (release on leave), AC-A5 (an
// empty snapshot is not the first frame), AC-A6 (an empty buffer may still pull
// history — BOTH gates, design D-A3), AC-A7 (three ways back out of an empty
// transcript, ending on a tappable retry). AC-A2 lives in
// test/pages-send-mode.test.js, AC-A3 in test/record-projection.test.js, AC-A4's
// full-stack half in test/sse-framing.test.js. The tasks checklist named a second
// new file (empty-buffer-bootstrap.test.js) that is NOT in this worker's exclusive
// file set, so those assertions were folded in here — see the handoff note.
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

function between(startAnchor, endAnchor) {
  const start = js.indexOf(startAnchor)
  const end = js.indexOf(endAnchor, start)
  assert.notEqual(start, -1, `anchor ${startAnchor} must exist in the page script`)
  assert.notEqual(end, -1, `anchor ${endAnchor} must exist in the page script`)
  return js.slice(start, end)
}

// The page's own label table, so the copy asserted below is the one the phone
// renders, not one this test brought along.
function pageLabels() {
  const line = js.match(/^const L=(\{.*\});/m)
  assert(line, 'the page label table must render as one JSON line')
  return JSON.parse(line[1])
}

const L = pageLabels()
const FAILED_BLOCK = /<div class="loading-failed">[\s\S]*?<\/div>/

function fakeBox(initial = '') {
  const box = { innerHTML: initial, scrollTop: 0, scrollHeight: 12, clientHeight: 400 }
  box.querySelector = (selector) => {
    if (selector === '.loading-failed' || selector === ':scope > .loading-failed') {
      const match = box.innerHTML.match(FAILED_BLOCK)
      return match ? { outerHTML: match[0] } : null
    }
    if (selector === '.message' && /class="message/.test(box.innerHTML)) return { outerHTML: '' }
    if (selector === '.loading' && /class="loading"/.test(box.innerHTML)) return { outerHTML: '' }
    if (selector === '.older-row' && /class="older-row/.test(box.innerHTML)) return { outerHTML: '' }
    return null
  }
  box.querySelectorAll = () => []
  return box
}

// ------------------------------------------------------------------------- AC-A1

function buildWatermarkSandbox() {
  const body = ['eventSeq', 'streamWatermark', 'noteHandoffCoverage']
    .map((name) => extractFunction(js, name))
    .join('\n')
  const make = new Function(`
    let handoffPainted=false
    const streamWatermarks=new Map()
    ${body}
    return {
      streamWatermark,
      noteHandoffCoverage,
      watermarks: streamWatermarks,
      get handoffPainted(){return handoffPainted},
    }
  `)
  return make()
}

test('AC-A1 a handoff watermark covers its own session only', () => {
  const sandbox = buildWatermarkSandbox()
  sandbox.noteHandoffCoverage({
    focus: { sessionId: 's1', history: { events: [{ event: { seq: 3 } }, { event: { seq: 9 } }, { event: { seq: 5 } }] } },
  })
  assert.equal(sandbox.streamWatermark('s1'), 9)
  assert.equal(sandbox.streamWatermark('other-session'), -1, '另一个会话不得继承 handoff 水位线')
  assert.equal(sandbox.watermarks.size, 1, 'the handoff leaves exactly one entry behind')
  assert.equal(sandbox.handoffPainted, true, 'and still marks the handoff as painted')
})

test('AC-A1 a session with no watermark gets the full snapshot', () => {
  const sandbox = buildWatermarkSandbox()
  assert.equal(sandbox.streamWatermark('never-opened'), -1)
  sandbox.noteHandoffCoverage({ focus: { sessionId: 's1', history: { events: [{ event: { seq: 4 } }] } } })
  sandbox.watermarks.delete('s1')
  assert.equal(sandbox.streamWatermark('s1'), -1, 'a released watermark means the whole window again')
})

test('AC-A1 the page-wide watermark is gone from the script', () => {
  assert.ok(!js.includes('streamSinceSeq'), 'no trace of the cross-session variable may survive')
  assert.ok(js.includes('const streamWatermarks=new Map()'), 'the map replaces it')
  assert.ok(js.includes('function streamWatermark(sessionId)'), 'and one accessor reads it')
})

// ---------------------------------------------------------------------------- A-3

test('A-3 leaving a session releases that session watermark', () => {
  const closing = between('function closeSessionStream()', 'function applyHistory(')
  assert.ok(closing.includes('streamWatermarks.delete(activeSession)'), 'the watermark goes with the stream')
  assert.ok(
    closing.indexOf('pendingSyncTimer=null;if(activeSession)streamWatermarks.delete(activeSession)') >= 0,
    'the release is the last thing closeSessionStream does',
  )
  assert.ok(
    js.includes('closeSessionStream();closeSessionSettings();activeSession=null'),
    'and it runs while activeSession still names the session being left',
  )
  assert.ok(
    js.includes('olderHasMore=false;olderBusy=false;olderExhausted=false;'),
    'the rest of the per-session reset is untouched',
  )
})

// ---------------------------------------------------------------------------- AC-A5

test('AC-A5 an emptied snapshot no longer counts as the first frame', () => {
  assert.match(js, /markStreamSnapshot\(incoming\.length>0\)/)
  assert.ok(!js.includes('markStreamSnapshot(true)'), '空快照不得再被当成首帧')
  assert.ok(js.includes("resolve('timeout'),900)"), 'the fallback timer it unblocks stays armed')
  assert.ok(js.includes('if(activeSession===id&&firstFrame!==true&&!handoffPainted)await loadHistory(true);'))
})

// ---------------------------------------------------------------------------- AC-A6

test('AC-A6 loadHistory AND applyHistory let history through while empty', () => {
  const loading = between('async function loadHistory(initial,force)', 'const FALLBACK_IMAGE_LIMITS')
  const applying = between('function applyHistory(value,pending,initial)', 'function flushStreamRender(')
  assert.ok(loading.includes('if(streamConnected&&transcriptHasContent()){'), 'the fetch gate counts an empty buffer')
  assert.ok(applying.includes('if(streamConnected&&transcriptHasContent()){'), 'the merge gate must agree, or the page is thrown away')
  assert.equal(js.split('streamConnected&&transcriptHasContent()').length - 1, 3, 'both gates plus the revision veto')
  assert.ok(
    loading.includes('if(streamConnected&&transcriptHasContent()&&streamRevision!==revision)'),
    'a snapshot that painted nothing must not veto the fetched page',
  )
  assert.ok(js.includes('function transcriptHasContent(){return Boolean(streamEvents.length||olderEvents.length)}'))
  assert.ok(!loading.includes('if(streamConnected){'), 'the old one-sided gate is gone')
  assert.ok(!applying.includes('if(streamConnected){'), 'and so is the one inside applyHistory')
})

test('AC-A6 an empty buffer pulls the head page without beforeSeq', () => {
  const older = between('async function fetchOlderPage()', 'async function loadOlder()')
  assert.ok(older.includes('anchorSeq<0'), 'the anchor-less case is handled, not abandoned')
  assert.ok(!older.includes('if(anchorSeq<0)return false'), 'no anchor must not mean nothing to do')
  assert.ok(older.includes("rpc('session.history',{sessionId,maxMessages:30})"), 'the head page carries no beforeSeq')
  assert.ok(older.includes('beforeSeq:anchorSeq'), 'and paging from a real anchor still works')
})

test('AC-A6 the head pull really goes out with no beforeSeq', async () => {
  // extractFunction anchors on the literal `function NAME(`, which for an async
  // function sits *after* the modifier — re-attach it or the body's awaits are a
  // SyntaxError.
  const source = 'async ' + extractFunction(js, 'fetchOlderPage')
  const make = new Function('box', `
    let olderBusy=false,olderRunBusy=false,olderHasMore=true,olderExhausted=false
    let activeSession='s1',olderEvents=[],streamEvents=[]
    const calls=[]
    const $=()=>box
    function oldestEventSeq(){return -1}
    function renderOlderButton(){}
    function windowEvents(){return []}
    function mergeEntries(list){return list}
    function visibleMessages(){return []}
    function messagesWithOptimistic(list){return list}
    function paintMessages(){}
    function showError(){}
    async function rpc(method,payload){calls.push({method,payload});return {events:[],hasMore:false}}
    ${source}
    return { run: fetchOlderPage, calls, state: () => ({ olderHasMore, olderExhausted }) }
  `)
  const sandbox = make(fakeBox())
  assert.equal(await sandbox.run(), true, 'an empty transcript must be able to pull a page')
  assert.deepEqual(sandbox.calls, [{ method: 'session.history', payload: { sessionId: 's1', maxMessages: 30 } }])
})

// ---------------------------------------------------------------------------- AC-A7

test('AC-A7 the older row shows while nothing is painted', () => {
  const row = between('function olderButtonHtml()', 'function paintMessages(')
  assert.ok(row.includes('&&transcriptHasContent()'), 'the row is only hidden over real content')
  assert.ok(!row.includes('if(!olderHasMore&&!olderEvents.length)return'), 'the empty-buffer veto is gone')
  const sandbox = buildPaintSandbox({ activeSession: 's1', olderHasMore: false, sessionBlank: false })
  assert.match(sandbox.olderButtonHtml(), /data-older="1"/, 'the tap target is there to be found')
  sandbox.setStream([{ event: { seq: 1 } }])
  assert.equal(sandbox.olderButtonHtml(), '', 'once content is painted the exhausted row hides again')
})

test('AC-A7 painting nothing names the wait instead of a blank page', () => {
  const sandbox = buildPaintSandbox({ activeSession: 's1', sessionBlank: false })
  sandbox.paintMessages([])
  assert.ok(sandbox.box.innerHTML.includes('class="loading"'), 'the skeleton says work is happening')
  assert.ok(sandbox.box.innerHTML.includes('正在同步会话内容…'), 'and names what it is waiting for')
  assert.equal(sandbox.box.innerHTML.includes(L.syncingChat), true, 'the copy is the page label, not a test copy')
  sandbox.setSessionBlank(true)
  sandbox.paintMessages([])
  assert.ok(!sandbox.box.innerHTML.includes('正在同步会话内容…'), 'a session the desktop reports blank is honestly empty')
})

test('AC-A7 the failed retry block survives an empty repaint', () => {
  const stalled = '<div class="loading-failed">消息没能加载出来<button class="older-row" data-reload="1">重试</button></div>'
  const sandbox = buildPaintSandbox({ activeSession: 's1', sessionBlank: false, innerHTML: stalled })
  sandbox.paintMessages([])
  assert.ok(sandbox.box.innerHTML.includes('data-reload="1"'), 'a stall keeps its button')
  assert.ok(!sandbox.box.innerHTML.includes('正在同步会话内容…'), 'it does not decay back into a bare wait')
})

test('AC-A7 the watchdog judges painted content and ends on a tappable retry', () => {
  const watchdog = between('function armSkeletonWatchdog(sessionId,attempt=0)', 'function schedulePoll()')
  assert.ok(watchdog.includes("querySelector('.message')"), 'it asks whether anything was painted')
  assert.ok(!watchdog.includes("querySelector('.loading')"), 'and no longer whether a skeleton is up')
  assert.ok(watchdog.includes('if(attempt>=3){showTranscriptRetry();return}'), 'three tries, then a button')
  assert.ok(watchdog.includes('||sessionBlank'), 'a blank session is not retried into a false failure')
  const sandbox = buildPaintSandbox({ activeSession: 's1', sessionBlank: false })
  sandbox.showTranscriptRetry()
  assert.match(sandbox.box.innerHTML, /data-reload="1"/, 'the retry block reuses the reload affordance')
  assert.match(sandbox.box.innerHTML, /class="loading-failed"/, 'and the failed-load styling')
})

function buildPaintSandbox(state = {}) {
  const body = [
    'transcriptHasContent',
    'olderButtonHtml',
    'loadingShell',
    'transcriptWaitHtml',
    'showTranscriptRetry',
    'paintMessages',
    'esc',
  ]
    .map((name) => extractFunction(js, name))
    .join('\n')
  const box = fakeBox(state.innerHTML || '')
  const make = new Function('box', `
    let activeSession=${JSON.stringify(state.activeSession ?? null)}
    let streamEvents=[],olderEvents=[],olderHasMore=${JSON.stringify(state.olderHasMore ?? false)}
    let olderBusy=false,olderRunBusy=false,sessionBlank=${JSON.stringify(state.sessionBlank ?? true)}
    let agentRunning=false,pendingQuestion=null
    const turnOpenState=new Map()
    const L=${JSON.stringify(L)}
    const $=()=>box
    function renderMessage(message){return '<div class="message '+message.role+'">'+(message.blocks||[]).map((b)=>b.text||'').join('')+'</div>'}
    ${body}
    return {
      olderButtonHtml, paintMessages, showTranscriptRetry, transcriptHasContent, transcriptWaitHtml,
      setStream(value){streamEvents=value},
      setSessionBlank(value){sessionBlank=value},
    }
  `)
  const sandbox = make(box)
  sandbox.box = box
  return sandbox
}
