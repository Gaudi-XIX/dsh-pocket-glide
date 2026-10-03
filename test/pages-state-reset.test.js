// WP-PAGES-B 状态机回归断言（change 2026-10-02-fix-pocket-audit-remediation）。
//
// The page script lives inside one template literal, so it cannot be imported.
// These tests follow the house pattern (test/stream-watermark.test.js): pull the
// REAL function text out of the rendered asset and run it against synthetic state,
// so a regression goes red on a runner rather than on a phone.
//
// Covered here: B-1 (a broken stream drops tokenStream), B-2 (an answer submit
// always releases questionBusy), B-3 (re-arming the snapshot settles the promise it
// replaces), B-4 (provisionalSession is declared before the boot IIFE reads it),
// B-5 (send() re-checks which session it is talking to), B-6 ($('cancel') cannot
// reject unhandled), B-7 (handoffPainted resets on the re-entry path), B-8 (the
// per-session close inventory, the two fill locks and the warm-cache bound) and the
// desktop pairing-page poll guard. B-9 lives in test/pages-input-hardening.test.js.
//
// Two anchors are deliberately slice-scoped, because a whole-file `includes`
// false-greens or false-reds here:
//   * B-5 — `const owner=activeSession` already occurs once inside loadHistory();
//   * the pairing-page poll — `document.hidden` occurs eight times across the file,
//     but the poll guard must be read only between renderDesktopPairingPage and
//     renderPairingPinPage.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mobilePageAssets } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })

// renderDesktopPairingPage is a desktop page: it is NOT part of the mobile asset
// bundle, so its poll guard has to be read off the module source instead.
const source = readFileSync(fileURLToPath(new URL('../lib/pages.js', import.meta.url)), 'utf8')

function extractFunction(text, name) {
  const start = text.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the rendered asset`)
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${name}`)
}

function between(text, startAnchor, endAnchor) {
  const start = text.indexOf(startAnchor)
  const end = text.indexOf(endAnchor, start)
  assert.notEqual(start, -1, `anchor ${startAnchor} must exist`)
  assert.notEqual(end, -1, `anchor ${endAnchor} must exist after it`)
  return text.slice(start, end)
}

// Page code is spliced into a Function body, so a stray backtick or template hole
// would close the harness string early and fail somewhere unrelated to the change.
function assertSpliceable(text, label) {
  assert.ok(!text.includes('`'), `${label} must not carry a backtick`)
  assert.ok(!text.includes('${'), `${label} must not carry a template hole`)
}

// ---------------------------------------------------------------------------- B-1

test('B-1 a broken stream drops the token text it was painting into', () => {
  const handler = js.match(/source\.onerror=\(\)=>\{([^}]*)\}/)
  assert.ok(handler, 'the stream failure handler must render as one statement')
  assert.ok(handler[1].includes('streamConnected=false'), 'the page must stop believing the stream is up')
  assert.ok(handler[1].includes('markStreamSnapshot(false)'), 'and hand the first frame back to the fetch path')
  assert.ok(handler[1].includes('tokenStream=null'), 'and drop the half-written answer before polling takes over')
  assert.ok(
    (js.match(/tokenStream=null/g) || []).length >= 3,
    'every path that drops a stream must also drop its token text',
  )
})

// ---------------------------------------------------------------------------- B-2

test('B-2 the answer lock is released on every path, not just the error branch', () => {
  for (const name of ['submitQuestionAnswers', 'cancelQuestionRequest']) {
    const body = 'async ' + extractFunction(js, name)
    assert.ok(
      body.includes('finally{questionBusy=false;renderQuestionComposer()}'),
      `${name} must release the lock in a finally so a delivered answer cannot strand the composer`,
    )
    assert.ok(
      !body.includes('catch(e){questionBusy=false'),
      `${name} must not release the lock only when it fails`,
    )
  }
})

function buildQuestionSandbox() {
  const body = ['syncPendingQuestion', 'submitQuestionAnswers']
    .map((name) => (name === 'submitQuestionAnswers' ? 'async ' : '') + extractFunction(js, name))
    .join('\n')
  assertSpliceable(body, 'the question submit pair')
  const make = new Function(`
    let pendingQuestion={rpcId:'r1',sessionId:'s1',questions:[{id:'q1',question:'Q',multiSelect:false}]}
    let questionBusy=false,questionIndex=0,questionDrafts={},lastHistoryKey='chat:s1'
    let answer=null
    const rpcCalls=[]
    const errors=[]
    function questionDraft(){return {selected:['A'],custom:''}}
    function renderQuestionComposer(){}
    function showError(id,error){errors.push({id,error})}
    async function rpc(method,payload){rpcCalls.push({method,payload});await new Promise((resolve,reject)=>{answer={resolve,reject}})}
    async function loadHistory(){}
    ${body}
    return {
      start:submitQuestionAnswers,
      redeliver:()=>syncPendingQuestion({rpcId:'r1',sessionId:'s1',questions:[{id:'q1',question:'Q',multiSelect:false}]}),
      accept:()=>answer.resolve(),
      reject:(error)=>answer.reject(error),
      busy:()=>questionBusy,
      rpcCalls,
      errors,
    }
  `)
  return make()
}

test('B-2 a delivered answer hands the composer back', async () => {
  const sandbox = buildQuestionSandbox()
  const flight = sandbox.start()
  assert.equal(sandbox.busy(), true, 'the lock is held while the answer is in flight')
  sandbox.accept()
  await flight
  assert.equal(sandbox.busy(), false, 'and released once the Host accepted it')
  assert.equal(sandbox.rpcCalls.length, 1)
  assert.equal(sandbox.rpcCalls[0].method, 'interaction.answer')
  assert.deepEqual(sandbox.errors, [])
})

test('B-2 a re-delivered question does not strand the lock', async () => {
  const sandbox = buildQuestionSandbox()
  const flight = sandbox.start()
  // The Host repeating the same rpcId must not reset questionBusy — that is exactly
  // the case the release has to survive, or the composer is busy for the rest of the visit.
  sandbox.redeliver()
  assert.equal(sandbox.busy(), true, 'the same question arriving again leaves the lock held')
  sandbox.accept()
  await flight
  assert.equal(sandbox.busy(), false, 'the answer still releases it')
})

test('B-2 a rejected answer releases the composer lock too', async () => {
  const sandbox = buildQuestionSandbox()
  const flight = sandbox.start()
  sandbox.reject(new Error('offline'))
  await flight
  assert.equal(sandbox.busy(), false)
  assert.equal(sandbox.errors.length, 1)
  assert.equal(sandbox.errors[0].id, 'questionError')
})

// ---------------------------------------------------------------------------- B-3

test('B-3 armStreamSnapshot releases the promise it replaces', () => {
  const body = extractFunction(js, 'armStreamSnapshot')
  assert.ok(
    body.indexOf('settleStreamSnapshot(false)') < body.indexOf('streamSnapshotReady=new Promise'),
    'the previous arm must be settled before the resolver is overwritten',
  )
  assert.equal(
    extractFunction(js, 'settleStreamSnapshot'),
    'function settleStreamSnapshot(ok){markStreamSnapshot(ok)}',
    'and settling means calling whatever resolver is currently armed',
  )
})

test('B-3 a second arm does not strand the first await on the fallback timer', async () => {
  const body = ['settleStreamSnapshot', 'armStreamSnapshot'].map((name) => extractFunction(js, name)).join('\n')
  assertSpliceable(body, 'the snapshot pair')
  const make = new Function(`
    let streamSnapshotReady=null,markStreamSnapshot=()=>{}
    ${body}
    return { arm:armStreamSnapshot, ready:()=>streamSnapshotReady }
  `)
  const sandbox = make()
  sandbox.arm()
  const first = sandbox.ready()
  sandbox.arm()
  const second = sandbox.ready()
  assert.notEqual(first, second, 'the second arm replaces the promise')
  assert.equal(await first, false, 'the replaced promise must settle as false, not hang until the 900ms fallback')
})

// ---------------------------------------------------------------------------- B-4

test('B-4 provisionalSession is declared before the boot IIFE reads it', () => {
  const declared = js.indexOf('provisionalSession=false')
  const boot = js.indexOf('const boot=takeHandoffBoot()')
  assert.notEqual(declared, -1, 'the flag must be initialised in the page-wide declaration chain')
  assert.notEqual(boot, -1, 'the boot IIFE must still read a handoff boot')
  assert.ok(declared < boot, 'a later declaration would leave the boot IIFE in its temporal dead zone')
  assert.equal(
    (js.match(/let provisionalSession/g) || []).length,
    0,
    'the flag must not be re-declared below the boot IIFE',
  )
  assert.ok(js.includes('provisionalSession=true'), 'the handoff path still marks the visit provisional')
  assert.ok(js.includes('if(!provisionalSession)return;'), 'and the first real gesture still drops the provisional claim')
})

// ---------------------------------------------------------------------------- B-5

test('B-5 send() re-checks the session it started for', () => {
  const body = between(js, 'async function send(){', 'function formatBytes(')
  assert.ok(body.includes('const owner=activeSession'), 'the send captures whose session it is')
  const guards = (body.match(/if\(activeSession!==owner\)return/g) || []).length
  assert.equal(guards, 2, 'both the success and the failure branch must re-check the session')
  // A whole-file lookup would be false-green: loadHistory() opens with the same line.
  assert.equal(
    (js.match(/const owner=activeSession/g) || []).length,
    2,
    'the trick here is that this line is not unique in the file, hence the slice above',
  )
})

function buildSendSandbox() {
  const body = 'async ' + extractFunction(js, 'send')
  assertSpliceable(body, 'send')
  const make = new Function('box', `
    let activeSession='s1',agentRunning=false,busyEnter='queue',lastHistoryKey='chat:s1'
    let optimisticPrompts=[],sessionBlank=true
    const composerDrafts=[]
    let flight=null,sentCleared=0
    const rpcCalls=[]
    const errors=[]
    const painted=[]
    function $(id){return box}
    function readyDrafts(){return []}
    function validateImagesReady(){}
    function slashExecuteName(){return ''}
    function attachmentParts(){return []}
    function submittedAttachmentParts(){return []}
    function draftSummary(){return ''}
    function latestEventSeq(){return 5}
    function currentTranscript(){return []}
    function durableUserPromptText(message){return String(message.text||'')}
    function armAwaitingTurn(){}
    function clearAwaitingTurn(){}
    function syncSettingsControls(){}
    function syncPromptUi(){}
    function paintMessages(list){painted.push(list.length)}
    function messagesWithOptimistic(list){return list}
    function clearSentDrafts(){sentCleared+=1}
    function showError(id,error){errors.push({id,error})}
    async function loadHistory(){}
    async function refreshActiveSessionSummary(){}
    async function rpc(method,payload){rpcCalls.push({method,payload});await new Promise((resolve,reject)=>{flight={resolve,reject}})}
    const L={draftUploading:'uploading',draftFailed:'failed',attachNotAccepted:'no {command}'}
    ${body}
    return {
      run:send,
      switchTo:(id)=>{activeSession=id},
      accept:()=>flight.resolve(),
      reject:(error)=>flight.reject(error),
      value:()=>box.value,
      prompts:()=>optimisticPrompts.length,
      cleared:()=>sentCleared,
      rpcCalls,
      errors,
    }
  `)
  return make({ value: 'hello', style: {}, scrollHeight: 40 })
}

test('B-5 a reply that lands after a session switch does not touch the new session', async () => {
  const sandbox = buildSendSandbox()
  const flight = sandbox.run()
  assert.equal(sandbox.value(), '', 'the composer empties the moment the send starts')
  sandbox.switchTo('s2')
  sandbox.accept()
  await flight
  assert.equal(
    sandbox.cleared(),
    0,
    'a reply for the session that was left must not clear the drafts of the one on screen',
  )
})

test('B-5 a failed send restores the text only into the session it belonged to', async () => {
  const stayed = buildSendSandbox()
  const landed = stayed.run()
  stayed.reject(new Error('offline'))
  await landed
  assert.equal(stayed.value(), 'hello', 'the text comes back while that session is still on screen')
  assert.equal(stayed.errors.length, 1)

  const moved = buildSendSandbox()
  const abandoned = moved.run()
  moved.switchTo('s2')
  moved.reject(new Error('offline'))
  await abandoned
  assert.equal(moved.value(), '', 'and stays out of the composer once the page moved on')
  assert.equal(moved.prompts(), 0, 'the optimistic bubble is withdrawn either way')
})

// ---------------------------------------------------------------------------- B-6

test('B-6 the cancel button cannot reject unhandled', () => {
  const handler = between(js, "$('cancel').onclick=async()=>{", "$('questionComposer').onclick=")
  assert.ok(handler.includes('if(!activeSession)return;'), 'a stale tap has nothing to stop')
  assert.ok(handler.includes('clearAwaitingTurn()'), 'the stop button takes the turn indicator down immediately')
  assert.ok(handler.includes("await rpc('session.cancel',{sessionId:activeSession})"), 'and still asks the Host')
  assert.match(
    handler,
    /try\{[\s\S]*?\}catch\(e\)\{showError\('chatError',e\)\}finally\{lastHistoryKey='';await loadHistory\(false\)\}/,
    'the RPC has to settle into a catch and a finally, or a failure leaves an unhandled rejection',
  )
})

// ---------------------------------------------------------------------------- B-7

test('B-7 a re-entry into the session already on screen drops the handoff claim', () => {
  // Anchored on the guard itself rather than on the function that follows it: the
  // next declaration is not a stable anchor, but this exact condition only occurs here.
  const start = js.indexOf('if(activeSession===id&&streamConnected&&!fromHistory)')
  assert.notEqual(start, -1, 'the re-entry guard must exist')
  const body = js.slice(start, start + 120)
  assert.ok(
    body.startsWith('if(activeSession===id&&streamConnected&&!fromHistory){handoffPainted=false;return}'),
    'the early exit must clear the handoff paint flag, or the fetch path stays vetoed for the rest of the visit',
  )
  assert.ok(
    !js.includes('&&!fromHistory)return;'),
    'the unconditional form of that early exit must be gone',
  )
  assert.ok(
    js.includes('if(activeSession===id&&streamConnected&&!fromHistory)'),
    'and the guard it belongs to is unchanged',
  )
})

// ---------------------------------------------------------------------------- B-8

test('B-8 closing a session empties the per-session state the next visit would inherit', () => {
  const body = extractFunction(js, 'closeSessionStream')
  assertSpliceable(body, 'closeSessionStream')
  const make = new Function(`
    let sessionStream=null,streamRenderFrame=null,pendingSyncTimer=null
    let tokenStream=null,streamConnected=false,streamEvents=[],olderEvents=[]
    let olderHasMore=false,olderBusy=false,olderExhausted=false
    let streamProjections=null,streamNeedsFullPaint=false,streamRevision=0
    let activeSession='s1',embeddedFocus={sessionId:'s1',history:{events:[]}}
    const turnOpenState=new Map(),streamWatermarks=new Map()
    function clearSkeletonWatchdog(){}
    function clearStreamStaleWatch(){}
    ${body}
    return {
      close:closeSessionStream,
      seed(){
        tokenStream={text:'half written'}
        streamConnected=true
        streamEvents=[{key:'a'}]
        olderEvents=[{key:'b'}]
        olderHasMore=true
        olderBusy=true
        olderExhausted=true
        streamProjections={items:[]}
        streamNeedsFullPaint=true
        streamRevision=9
        turnOpenState.set('turn:1',true)
        streamWatermarks.set('s1',42)
      },
      state:()=>({ tokenStream,streamConnected,streamEvents,olderEvents,olderHasMore,olderBusy,olderExhausted,
        streamProjections,streamNeedsFullPaint,streamRevision,turnOpenState,streamWatermarks,embeddedFocus }),
    }
  `)
  const sandbox = make()
  sandbox.seed()
  assert.equal(sandbox.state().streamEvents.length, 1, 'the seed must actually be in place')
  sandbox.close()
  const state = sandbox.state()
  assert.equal(state.tokenStream, null, 'the half-written answer goes')
  assert.equal(state.streamConnected, false)
  assert.deepEqual(state.streamEvents, [], 'the live window goes')
  assert.deepEqual(state.olderEvents, [], 'and the paged window with it')
  assert.equal(state.olderHasMore, false)
  assert.equal(state.olderBusy, false)
  assert.equal(state.olderExhausted, false)
  assert.equal(state.streamProjections, null)
  assert.equal(state.streamNeedsFullPaint, false)
  assert.equal(state.streamRevision, 0)
  assert.equal(state.turnOpenState.size, 0, 'the open/closed turn map is per session')
  assert.equal(state.streamWatermarks.has('s1'), false, 'and so is the watermark of the session being left')
  assert.equal(state.embeddedFocus, null, 'the handoff focus must not outlive the session it names')
})

test('B-8 the two fill locks release themselves instead of being cleared from outside', () => {
  const closing = extractFunction(js, 'closeSessionStream')
  assert.ok(
    !closing.includes('fillBusy=false') && !closing.includes('olderRunBusy=false'),
    'closeSessionStream must NOT clear a lock an in-flight fill still owns — that would let two fills overlap',
  )
  const filling = extractFunction(js, 'ensureTranscriptFilled')
  assert.ok(filling.includes('fillBusy=true'), 'the fill takes its own lock')
  assert.ok(filling.includes('finally{fillBusy=false}}'), 'and releases it in a finally, so a throw cannot pin it')
  const paging = extractFunction(js, 'loadOlder')
  assert.ok(paging.includes('olderRunBusy=true'), 'the paging path takes its own lock, inside the try')
  assert.ok(
    paging.includes('olderRunBusy=false;void ensureTranscriptFilled()'),
    'and releases it before refreshing the row',
  )
})

test('B-8 the warm session cache stays bounded and drops the least recently used entry', () => {
  const body = extractFunction(js, 'evictSessionCache')
  assertSpliceable(body, 'evictSessionCache')
  const make = new Function(`
    const SESSION_CACHE_MAX=4
    const sessionCache=new Map()
    ${body}
    return { cache:sessionCache, evict:evictSessionCache }
  `)
  const sandbox = make()
  for (const id of ['a', 'b', 'c', 'd', 'e']) sandbox.cache.set(id, { streamEvents: [] })
  assert.equal(sandbox.cache.size, 5)
  sandbox.evict()
  assert.equal(sandbox.cache.size, 4, 'the cache may not grow past SESSION_CACHE_MAX')
  assert.deepEqual([...sandbox.cache.keys()], ['b', 'c', 'd', 'e'], 'and it drops the oldest entry, not the newest')
})

test('B-8 the cache is touched on a warm open and trimmed when the list comes back', () => {
  assert.ok(
    js.includes('sessionCache.delete(activeSession);sessionCache.set(activeSession,cached)'),
    're-opening a cached session must make it the most recent, or the bound evicts what is on screen',
  )
  assert.ok(js.includes('evictSessionCache()'), 'and the list view is where the bound is applied')
})

// ------------------------------------------------------------------------ PB-poll

test('PB the pairing page poll cannot stack and skips a hidden tab', () => {
  const start = source.indexOf('function renderDesktopPairingPage(')
  const end = source.indexOf('export function renderPairingPinPage(', start)
  assert.ok(start >= 0 && end > start, 'the pairing page must still render between these two anchors')
  const region = source.slice(start, end)
  // Whole-file counts are useless here: `document.hidden` occurs eight times across
  // pages.js, so only the region above can tell the poll guard apart from the rest.
  assert.ok(region.includes('let pollBusy=false;'), 'the poll needs a re-entrancy latch')
  assert.match(
    region,
    /async function poll\(\)\{if\(pollBusy\)return;if\(document\.hidden\)return;pollBusy=true;try\{/,
    'the latch closes and the hidden-tab skip both guard the same call',
  )
  assert.ok(
    region.includes('setInterval(()=>{if(document.hidden)return;'),
    'the one-second countdown must not run against a backgrounded page',
  )
})
