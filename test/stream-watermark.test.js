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
//
// WP-A1-FIXUP added the A-8 pair (AC-A8-1 / AC-A8-2), the reset inventory (AC-D7),
// the re-entry behaviour pin (AC-D1) and the SEAM-3 brand-row pins at the bottom of
// this file, in the same house style.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets, renderMobileReconnectPage, renderPairingPinPage } from '../lib/pages.js'

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
  assert.ok(older.includes("rpc('session.history',{sessionId,maxMessages:30,...(subagentView?{subagent:subagentView}:{})})"), 'the head page carries no beforeSeq (the subagent spread collapses when no subagent view is open)')
  assert.ok(older.includes('beforeSeq:anchorSeq'), 'and paging from a real anchor still works')
})

test('AC-A6 the head pull really goes out with no beforeSeq', async () => {
  // extractFunction anchors on the literal `function NAME(`, which for an async
  // function sits *after* the modifier — re-attach it or the body's awaits are a
  // SyntaxError.
  const source = 'async ' + extractFunction(js, 'fetchOlderPage')
  const make = new Function('box', `
    let olderBusy=false,olderRunBusy=false,olderHasMore=true,olderExhausted=false
    let activeSession='s1',olderEvents=[],streamEvents=[],subagentView=null
    const calls=[]
    const $=()=>box
    function oldestEventSeq(){return -1}
    function transcriptHasContent(){return Boolean(streamEvents.length||olderEvents.length)}
    function renderOlderButton(){}
    function windowEvents(){return []}
    function mergeEntries(list){return list}
    function visibleMessages(){return []}
    function messagesWithOptimistic(list){return list}
    function paintMessages(){}
    function showError(){}
    let transcriptAnchor=null,skipAnchorOnce=false
    function readTranscriptAnchor(){return null}
    function restoreTranscriptAnchor(){return false}
    // the pull re-aims the anchor once the page lands (older rows swap their 120px
    // estimate for real height); this sandbox paints nothing, so it is a no-op
    function settleOlderShift(){}
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
    'readTranscriptAnchor',
    'restoreTranscriptAnchor',
  ]
    .map((name) => extractFunction(js, name))
    .join('\n')
  const box = fakeBox(state.innerHTML || '')
  const make = new Function('box', `
    let activeSession=${JSON.stringify(state.activeSession ?? null)}
    let streamEvents=[],olderEvents=[],olderHasMore=${JSON.stringify(state.olderHasMore ?? false)}
    let olderBusy=false,olderRunBusy=false,olderExhausted=${JSON.stringify(state.olderExhausted ?? false)},sessionBlank=${JSON.stringify(state.sessionBlank ?? true)}
    let agentRunning=false,pendingQuestion=null
    let transcriptAnchor=null,skipAnchorOnce=false
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

// ---------------------------------------------------- A-8 / AC-D1 / AC-D7 (WP-A1-FIXUP)
//
// Group A had two independent causes for one visible symptom. The bridge-side cause is
// the per-session watermark; the page-side one (A-8) is a stale handoff snapshot that
// survived a session switch and was then ASSIGNED over the live buffer while the older
// window was cleared — so the messages that were on screen a moment ago vanished and
// only the newest turn was left. Fixing either cause alone lets the symptom back.

const staleAssign = 'streamEvents=embeddedFocus.history.events||[];olderEvents=[]'
const cacheAssign = 'streamEvents=cached.streamEvents;olderEvents=cached.olderEvents'


test('AC-A8-2 the instant-paint cache branch merges instead of overwriting', () => {
  // Negative and positive pinned as a pair (the repo-hygiene ⑤ form): deleting the bad
  // literal alone would let the next rewrite drift back into another whole-buffer assign.
  // The embedded branch of this pair retired with the handoff jump (0.4.36); the cache
  // branch is the one that still runs.
  assert.equal(js.split(staleAssign).length - 1, 0, 'the stale overwrite form is gone')
  assert.equal(js.split(cacheAssign).length - 1, 0, 'the cache branch merged too')
  assert.ok(js.includes('streamEvents=mergeEntries(streamEvents.concat(cached.streamEvents))'), 'the cached one merges by seq')
  assert.ok(
    js.includes('olderEvents=mergeEntries(olderEvents.concat(cached.olderEvents||[]))'),
    'the cache restores the older window instead of dropping it',
  )
  assert.match(
    between('function paintInstantSession(){', 'const cached=sessionCache.get(activeSession)'),
    /two independent/,
    'the reason is written next to the merge, not only in the change card',
  )
})

function buildInstantPaintSandbox() {
  const body = ['eventSeq', 'mergeEntries', 'windowEvents', 'paintInstantSession']
    .map((name) => extractFunction(js, name))
    .join('\n')
  const make = new Function(`
    let activeSession=null,olderHasMore=false,olderExhausted=false,streamProjections=null
    let streamEvents=[],olderEvents=[]
    const sessionCache=new Map()
    const painted=[]
    function paintInstantHistory(events){painted.push(events.map(eventSeq))}
    function ensureTranscriptFilled(){}
    ${body}
    return {
      painted,
      setActive(value){activeSession=value},
      setStream(value){streamEvents=value},
      setOlder(value){olderEvents=value},
      setCached(session,value){sessionCache.set(session,value)},
      read(){return {streamEvents,olderEvents}},
      paintInstantSession,
    }
  `)
  return make()
}

const seqs = (list) => list.map((entry) => entry.event.seq)


test('AC-D1 a cached visit keeps both older windows as well', () => {
  const sandbox = buildInstantPaintSandbox()
  sandbox.setActive('s2')
  sandbox.setCached('s2', {
    streamEvents: [{ event: { seq: 8 } }],
    olderEvents: [{ event: { seq: 3 } }],
    olderHasMore: false,
    olderExhausted: true,
    streamProjections: null,
  })
  sandbox.setStream([{ event: { seq: 7 } }])
  sandbox.setOlder([{ event: { seq: 4 } }])
  assert.equal(sandbox.paintInstantSession(), true, 'the cache branch is the one taken')
  assert.deepEqual(sandbox.painted[0], [3, 4, 7, 8], 'cached and freshly pulled history both stay')
  assert.deepEqual(seqs(sandbox.read().olderEvents), [3, 4], 'neither older window is dropped')
})

function buildCloseSandbox() {
  const body = ['streamWatermark', 'closeSessionStream'].map((name) => extractFunction(js, name)).join('\n')
  const make = new Function(`
    let activeSession=null,sessionStream=null,streamRenderFrame=null,pendingSyncTimer=null,projectionsSyncTimer=null
    let streamConnected=true,streamEvents=[],olderEvents=[],olderHasMore=true,olderBusy=true
    let olderExhausted=true,streamProjections={values:{}},streamRevision=7,tokenStream=null
    let fillBusy=false,olderRunBusy=false
    const streamWatermarks=new Map()
    const calls=[]
    function cancelAnimationFrame(){calls.push('raf')}
    function clearTimeout(){calls.push('timeout')}
    function clearSkeletonWatchdog(){calls.push('skeleton')}
    function clearStreamStaleWatch(){calls.push('stale')}
    ${body}
    return {
      calls,
      setActive(value){activeSession=value},
      setStreamStream(value){sessionStream=value},
      setFrames(id){streamRenderFrame=id},
      setPendingTimer(id){pendingSyncTimer=id},
      setWatermark(session,value){streamWatermarks.set(session,value)},
      setTokenStream(value){tokenStream=value},
      setBusyFlags(fill,olderRun){fillBusy=fill;olderRunBusy=olderRun},
      setBuffers(stream,older){streamEvents=stream;olderEvents=older},
      watermarkOf(session){return streamWatermark(session)},
      read(){return {sessionStream,streamRenderFrame,pendingSyncTimer,projectionsSyncTimer,streamConnected,streamEvents,
        olderEvents,olderHasMore,olderBusy,olderExhausted,streamProjections,streamRevision,
        tokenStream,fillBusy,olderRunBusy}},
      closeSessionStream,
    }
  `)
  return make()
}

test('AC-D7 the reset list, asserted at its present value', () => {
  const sandbox = buildCloseSandbox()
  sandbox.setActive('s1')
  sandbox.setWatermark('s1', 42)
  sandbox.setStreamStream({
    close() {
      sandbox.calls.push('source')
    },
  })
  sandbox.setFrames(11)
  sandbox.setPendingTimer(12)
  sandbox.setTokenStream({ text: 'half an answer' })
  sandbox.setBuffers([{ event: { seq: 5 } }], [{ event: { seq: 1 } }])
  sandbox.setBusyFlags(true, true)
  sandbox.closeSessionStream()
  const after = sandbox.read()
  assert.equal(sandbox.watermarkOf('s1'), -1, 'the per-session watermark is released')
  assert.equal(after.tokenStream, null, 'and the half-finished token buffer with it')
  assert.equal(after.sessionStream, null)
  assert.equal(after.streamConnected, false)
  assert.deepEqual(after.streamEvents, [])
  assert.deepEqual(after.olderEvents, [])
  assert.equal(after.olderHasMore, false)
  assert.equal(after.olderBusy, false)
  assert.equal(after.olderExhausted, false)
  assert.equal(after.streamProjections, null)
  assert.equal(after.streamRevision, 0)
  assert.equal(after.pendingSyncTimer, null)
  assert.equal(after.projectionsSyncTimer, null, 'the projections refresh timer dies with the stream too')
  assert.equal(after.streamRenderFrame, null)
  assert.deepEqual(sandbox.calls, ['source', 'raf', 'timeout', 'skeleton', 'stale'], 'every handle and timer it owns')
  // PRESENT VALUE, not a promise: the two fill loops still reset themselves inside their
  // own finally, so closeSessionStream does not clear them and an in-flight loop can keep
  // running against the session it started in. Registered for WP-PERF (X3-7) — read this
  // pair as "not done", never as "done".
  assert.equal(after.fillBusy, true, 'fillBusy is NOT reset here today')
  assert.equal(after.olderRunBusy, true, 'olderRunBusy is NOT reset here today')
  const closing = between('function closeSessionStream()', 'function applyHistory(')
  assert.ok(!closing.includes('fillBusy'), 'the source says the same')
  assert.ok(!closing.includes('olderRunBusy'), 'and so for the older-page loop')
  assert.ok(
    between('async function ensureTranscriptFilled()', 'function oldestEventSeq()').includes('finally{fillBusy=false}'),
    'the reset that does exist lives in the function that sets it',
  )
  assert.ok(
    between('async function loadOlder()', 'function syncTurnStatus()').includes('olderRunBusy=false'),
    'and the same holds for the older-page loop',
  )
})

// ---------------------------------------------------- SEAM-3 brand row on the mobile pages
//
// The wordmark routes sit behind the pairing gate, and the pages served to a phone that
// has NOT paired yet pointed their header images straight at them: a 401 and an empty
// header slot for exactly the audience that cannot fix it. Until the bridge hands the
// data URI over (WP-BRIDGE-EXTRA), these pages render a plain-text brand row instead of
// a broken image, and with an icon in hand they render that icon.

const GATED_BRAND = 'src="/brand-logo'
const ICON_URI = 'data:image/png;base64,AA=='

test('SEAM-3 the reconnect and disconnected pages emit no gated brand route', () => {
  // /disconnected is served by THIS renderer (lib/bridge.js routes both /reconnect and
  // /disconnected through renderMobileReconnectPage), so each shape the bridge uses is
  // checked: interactive LAN, tunnel, expired tunnel, no saved session, nonced.
  const variants = [
    renderMobileReconnectPage('zh', 'lan', {}),
    renderMobileReconnectPage('en', 'tunnel', {}),
    renderMobileReconnectPage('zh', 'tunnel', { expired: true }),
    renderMobileReconnectPage('zh', 'lan', { resumeUnavailable: true }),
    renderMobileReconnectPage('en', 'lan', { nonce: 'abc123' }),
  ]
  for (const html of variants) {
    assert.ok(!html.includes(GATED_BRAND), 'no image may point at a gated route')
    assert.ok(!html.includes('/brand-logo'), 'not even as an unused fallback string')
    assert.ok(html.includes('<div class="brand"><span>DSH Pocket</span></div>'), 'a text brand row stands in')
  }
})

test('SEAM-3 with an icon in hand the brand row renders it', () => {
  const html = renderMobileReconnectPage('zh', 'lan', { icon: ICON_URI })
  assert.ok(html.includes('src="' + ICON_URI + '"'), 'the data URI is what the phone loads')
  assert.ok(!html.includes(GATED_BRAND), 'and the gated route is still absent')
  const pin = renderPairingPinPage('zh', ICON_URI)
  assert.ok(pin.includes('src="' + ICON_URI + '"'), 'the twin PIN card renders its icon the same way')
  const bare = renderPairingPinPage('zh', null)
  assert.ok(!bare.includes('/brand-logo'), 'the twin drops its gated fallback too')
  assert.ok(!bare.includes('<img'), 'and shows no image at all when there is nothing to show')
})
