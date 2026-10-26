// The first message of a draft was the one send the phone never acknowledged.
// Everything visible — clearing the composer, flipping the send arrow to the
// stop square, painting the user's bubble — used to wait for the whole chain
// below (session.create, the buffered preset/model/permission calls, the
// realtime open, and finally session.prompt). That chain is a second of dead
// air on a cold draft, and a reader who cannot tell whether the tap landed taps
// again: two session.prompt calls for one message. The fix is ordering, not a
// debounce — take the text out of the composer and show the turn as started
// BEFORE awaiting anything, so the second tap finds an empty composer (nothing
// to send) and a page that already says "sending".
//
// A second tap during the create window is answered by the in-flight promise:
// ensureSession() shares one session.create between concurrent first actions,
// and this guard stops the followers before they even get that far.
//
// 2026-10-19: the owner id is TAKEN FROM that await, never re-read from
// activeSession afterwards. A back-tap landing inside ensureSession's buffered
// draft RPCs (applyDraftPending) ran showSessionList(), which nulls
// activeSession — the send then went out with sessionId:null, the host answered
// gateway/input-invalid, and the session create had already landed on disk, so
// the reader was left with a completely empty conversation (4 hits in the
// pocket log, all on 2026-10-18 — 02:57/03:05/14:54/15:31 UTC; the oldest one,
// session-9c510eda, is still human=0 on disk).
// change 2026-10-24-pocket-send-loss-and-tunnel-p0 / T2「A 组：发送生命周期记账」。
//
// 上面那 23 行是 `lib/pages.js` 里 `send()` 上方时序契约注释的**逐字搬迁**（T1，2026-10-24）：
// 壳脚本预算（`ASSET_BUDGET_BYTES=391_500`，test/mobile-assets.test.js:1104）只剩 79 B，而
// A 组要 +819 B（review-loop 的 F1 兜底修复再 +26 B），于是把「为什么先出泡再 await」「owner 为什么只从 await 取」这段邻域知识搬
// 到钉它的测试档头，源码侧只留一行指针（`// Send ordering/owner contract ...`）。信息零丢失，
// 体积换成断言：A0 用 sha256 钉住这 23 行，谁改动正文都得同步改常量。
//
// 本档钉的是「在途单账本」：发前落账、结果撤账、再进会话结账。它替换了失败门
// `optimisticPrompts.includes(optimistic)` —— 那个门在读者离页后恒假，于是「发出去了但没落账」
// 的发送在离页后既没有账、也没有提示、列表行也不标红，就是手机端「点了没反应」的现场。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mobilePageAssets } from '../lib/pages.js'

// 反向验证钩子：change 卡的 tests/reverse-a-group.mjs（B 组是 reverse-b-group.mjs）把渲染后的
// 壳脚本落成一份临时副本、逐项改坏，再用 SEND_LEDGER_ASSET 指过来复跑本档，证明每条断言都能变红。不设该变量时（正常
// 跑、全量跑）永远读 lib/pages.js 渲染出来的现役壳脚本。
const shipped = mobilePageAssets({ locale: 'zh' }).js
const js = process.env.SEND_LEDGER_ASSET
  ? readFileSync(process.env.SEND_LEDGER_ASSET, 'utf8')
  : shipped

// 常量一律从现役脚本里读回来，档里不抄第二份：抄本会悄悄过期。
const SEND_KEY = /const SEND_KEY='([^']+)'/.exec(js)[1]
const STALE_MS = Number(/Date\.now\(\)-\(item\.t\|\|0\)>([\d.e+]+)/.exec(js)[1])

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

// 页面代码是拼进 Function 体的：一个反引号或模板洞会把宿主字符串提前闭合，
// 报出来的错离改动现场十万八千里。
function assertSpliceable(text, label) {
  assert.ok(!text.includes('`'), `${label} must not carry a backtick`)
  assert.ok(!text.includes('${'), `${label} must not carry a template hole`)
}

const sendBody = extractFunction(js, 'send')
const helperBlock = between(js, 'const SEND_KEY=', 'async function send(')
const catchSlice = between(js, '}catch(e){stashTake(owner)', '}return}')

// ------------------------------------------------------------------------------- A0

const CONTRACT_SHA256 = 'c5104cef7eaae5bf70e5753b2b31c19aef5515ad3fd7fb214920c7c8d684c5c2'

test('A0 the send() ordering contract left the shell intact and is pinned here', () => {
  const own = readFileSync(fileURLToPath(new URL('./send-pending-ledger.test.js', import.meta.url)), 'utf8')
  const first = '// The first message of a draft was the one send the phone never acknowledged.'
  const at = own.indexOf(first)
  assert.notEqual(at, -1, 'the moved contract block must sit in this file, verbatim')
  const lines = own.slice(at).split('\n').slice(0, 23)
  assert.equal(lines[22], '// session-9c510eda, is still human=0 on disk).', 'all 23 lines travel together')
  assert.equal(
    createHash('sha256').update(lines.join('\n')).digest('hex'),
    CONTRACT_SHA256,
    'the contract text is byte-identical to the copy that left lib/pages.js',
  )
  // 源码侧只剩一行指针：不是「删了」，是「搬家」，所以这里连正反两面一起钉。
  assert.ok(!js.includes(first), 'the shell must not carry the block any more')
  assert.match(
    js,
    /\/\/ Send ordering\/owner contract \(2026-10-18\/19\) lives verbatim in the top header of test\/send-pending-ledger\.test\.js\./,
    'one pointer line stands in for it',
  )
})

// ------------------------------------------------------------------------------- A1

test('A1 the failure gate is "is the reader still on this session", not "is the bubble still in the array"', () => {
  assertSpliceable(sendBody, 'send')
  assert.ok(
    !sendBody.includes('optimisticPrompts.includes('),
    'includes() went false the moment the page left, which is exactly why an abandoned send reported nothing',
  )
  assert.ok(catchSlice.includes('stashTake(owner)'), 'the ledger is settled before any branch runs')
  assert.ok(catchSlice.includes('if(activeSession===owner)'), 'one gate: the page still owns the session')
  assert.ok(
    catchSlice.includes('optimistic.failed=true;stashSend(owner,optimistic)'),
    'an abandoned failure stays on the books as failed',
  )
  assert.ok(catchSlice.includes('showToast(L.streamDownFailed,3e3)'), 'and says so with the existing copy key')
})

test('A1b success settles the ledger before the leave-check, so no ghost entry survives a switch', () => {
  assert.ok(
    sendBody.includes('stashTake(owner);if(activeSession!==owner)return;clearSentDrafts();'),
    'stashTake must sit BEFORE the early return, or a send that finishes after the reader left stays booked forever',
  )
})

test('A1c the new code mints no copy key: L.sendFailed does not exist, L.streamDownFailed does', () => {
  assert.ok(!helperBlock.includes('L.sendFailed'), 'L.sendFailed is not in the table — it renders undefined')
  assert.ok(!catchSlice.includes('L.sendFailed'), 'the rewritten catch reuses L.streamDownFailed instead')
  assert.ok(helperBlock.includes('L.streamDownFailed'), 'resumeSend speaks with the shipped copy')
})

test('A1d applyRunningMarks paints a failed send red on the list row', () => {
  const marks = extractFunction(js, 'applyRunningMarks')
  assert.ok(marks.includes('if(!pendingSendAt.size&&!pendingSend.size)return rows'), 'the fast path learns about the new book')
  assert.ok(marks.includes('if(pendingSend.get(row.sessionId)?.failed)row.error=true'), 'row.error is the flag the row renderer already reads')
})

test('A1e entering a session settles what was booked while the reader was away', () => {
  const open = extractFunction(js, 'openSession')
  const reset = open.indexOf('resetOptimisticMessages()')
  const resume = open.indexOf('resumeSend(id)')
  assert.notEqual(reset, -1, 'openSession still clears the on-screen optimistic state')
  assert.notEqual(resume, -1, 'and settles the ledger after it')
  assert.ok(resume > reset, 'the order matters: clearing first would wipe what the settle is about to restore')
})

// ---------------------------------------------------------------------- behaviour A3–A7

// 真函数体 + 假世界。send() 是异步的、要 await 一次 RPC 才分叉，所以这里给 rpc 一个手动
// 结算的 promise（accept/reject），把「读者离页」插在 await 中间 —— 这正是真机上后台回落、
// 手势返回、系统回收页面的时序。
function buildSendSandbox(store = {}, initial = 'hello') {
  const body = 'async ' + extractFunction(js, 'send').replace(/^async\s+/, '')
  assertSpliceable(body, 'send')
  const make = new Function('box', 'store', `
    let activeSession='s1',agentRunning=false,busyEnter='queue',lastHistoryKey='chat:s1'
    let optimisticPrompts=[],sessionBlank=true,sendBusy=false,draftPending=null
    let pendingSend=new Map()
    const composerDrafts=[]
    let flight=null,sentCleared=0
    const rpcCalls=[]
    const errors=[]
    const painted=[]
    const localStorage={
      getItem:(key)=>(Object.prototype.hasOwnProperty.call(store,key)?store[key]:null),
      setItem:(key,value)=>{store[key]=String(value)},
      removeItem:(key)=>{delete store[key]},
    }
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
    function markRowRunning(){}
    function stopPendingSend(){}
    function syncSettingsControls(){}
    function syncPromptUi(){}
    function paintMessages(list){painted.push(list.length)}
    function messagesWithOptimistic(list){return list}
    function clearSentDrafts(){sentCleared+=1}
    function showError(id,error){errors.push({id,error})}
    function showToast(message){errors.push({id:'toast',error:{message}})}
    function encodedPromptBytes(){return 1}
    function rpcBodyCeilingFor(){return 1024}
    async function loadHistory(){}
    async function refreshActiveSessionSummary(){}
    const L={draftUploading:'uploading',draftFailed:'failed',attachNotAccepted:'no {command}',attachTooLarge:'too large',streamDownFailed:'desktop down'}
    ${extractFunction(js, 'attachFailureCopy')}
    const SEND_KEY=${JSON.stringify(SEND_KEY)}
    ${extractFunction(js, 'stashSend')}
    ${extractFunction(js, 'stashTake')}
    ${extractFunction(js, 'resumeSend')}
    ${body}
    async function rpc(method,payload){
      rpcCalls.push({method,payload})
      await new Promise((resolve,reject)=>{flight={resolve,reject}})
    }
    return {
      run:send,resume:resumeSend,ledger:()=>pendingSend,store:()=>store,rpcCalls,errors,L,painted,
      switchTo:(id)=>{activeSession=id;optimisticPrompts=[]},
      // 一次重画：messagesWithOptimistic()（lib/pages.js:895）会把在途项从数组里 filter 掉，
      // 读者却还在这一页。旧判据 optimisticPrompts.includes() 在这里恒假 —— 这就是 F3。
      repaint:()=>{optimisticPrompts=[]},
      accept:()=>flight.resolve(),
      reject:(error)=>flight.reject(error),
      value:()=>box.value,
      prompts:()=>optimisticPrompts.length,
      cleared:()=>sentCleared,
    }
  `)
  return make({ value: initial, style: {}, scrollHeight: 40 }, store)
}

// applyRunningMarks 读的是同一本账：把真的 Map 递进去，而不是造一份仿制品。
function buildMarksSandbox(pendingSend) {
  const body = extractFunction(js, 'applyRunningMarks')
  assertSpliceable(body, 'applyRunningMarks')
  const make = new Function('pendingSend', `
    let activeSession=null
    const pendingSendAt=new Map()
    const SEND_TRUST_MS=8000
    const TURN_RUNNING_IDLE_MAX_MS=1800000
    ${body}
    return applyRunningMarks
  `)
  return make(pendingSend)
}

test('A3 a send that fails after the reader left stays booked as failed, and is not stuffed into the new composer', async () => {
  const sandbox = buildSendSandbox()
  const flight = sandbox.run()
  assert.equal(sandbox.value(), '', 'the composer empties the moment the tap lands')
  sandbox.switchTo(null)
  sandbox.reject(new Error('offline'))
  await flight

  const row = JSON.parse(sandbox.store()[SEND_KEY + 's1'] || 'null')
  assert.ok(row, 'the ledger writes through to storage, so a reclaimed page can still find the send')
  assert.equal(row.failed, true, 'a failure after the reader left is recorded as failed')
  assert.equal(row.text, 'hello', 'and keeps the text it owes the reader')

  const toasts = sandbox.errors.filter((entry) => entry.id === 'toast')
  assert.equal(toasts.length, 1, 'exactly one report — silence here is the bug this change exists for')
  assert.equal(toasts[0].error.message, sandbox.L.streamDownFailed, 'with the shipped copy key, not an invented one')

  assert.equal(sandbox.value(), '', 'the half-written message of session A must not land in whatever session is on screen')
  assert.equal(sandbox.errors.filter((entry) => entry.id === 'chatError').length, 0, 'and the error line of the new session stays untouched')
  assert.equal(sandbox.prompts(), 0, 'the optimistic bubble is withdrawn either way')
})

// A3b 钉的是「门」这一行（review-loop F3）：读者没离页，但在途气泡被一次重画挤出数组
// （messagesWithOptimistic 的真实行为），失败回来时旧判据 optimisticPrompts.includes() 恒假，
// 会把「还在这一页」误判成「已经离页」。把门换回 includes 这一条必须变红。
test('A3b a repaint that prunes the in-flight bubble does not move the gate off the reader', async () => {
  const sandbox = buildSendSandbox()
  const flight = sandbox.run()
  sandbox.repaint()
  assert.equal(sandbox.prompts(), 0, 'the redraw prunes the in-flight bubble, exactly as messagesWithOptimistic does')

  sandbox.reject(new Error('offline'))
  await flight

  assert.equal(sandbox.value(), 'hello', 'the reader is still on this session, so the text comes back to the composer')
  assert.equal(
    sandbox.errors.filter((entry) => entry.id === 'chatError').length,
    1,
    'and the failure is reported on the page — the on-page branch, not the abandoned one',
  )
  assert.equal(
    sandbox.errors.filter((entry) => entry.id === 'toast').length,
    0,
    'the toast belongs to the left-page branch; an on-page failure speaks inline',
  )
  assert.equal(sandbox.store()[SEND_KEY + 's1'], undefined, 'and the ledger is settled, so nothing replays as failed later')
  assert.deepEqual(sandbox.painted.slice(-1), [0], 'the transcript is repainted without the withdrawn bubble')
})

test('A4 re-entering the session hands the text back once, and the books are clear afterwards', async () => {
  const sandbox = buildSendSandbox()
  const flight = sandbox.run()
  sandbox.switchTo(null)
  sandbox.reject(new Error('offline'))
  await flight

  // 清账之前，列表行先能看见「这一笔没落地」。
  const marks = buildMarksSandbox(sandbox.ledger())
  const rows = marks([{ sessionId: 's1', running: false }])
  assert.equal(rows[0].error, true, 'the row is painted red while the entry is still on the books')

  sandbox.resume('s1')
  assert.equal(sandbox.value(), 'hello', 'coming back gives the reader their text back')
  assert.equal(sandbox.store()[SEND_KEY + 's1'], undefined, 'and settles the books, so it cannot come back twice')
  assert.equal(sandbox.ledger().size, 0, 'in memory too')

  const after = marks([{ sessionId: 's1', running: false }])
  assert.equal(after[0].error, undefined, 'with the entry gone the row stops claiming a failure')
})

// A4b 钉 F1：页面被系统回收（模块状态全没了，localStorage 还在）之后重开，正文必须回来一次。
// 这正是 design.md 选 localStorage 当账本载体的唯一理由；resumeSend 若先结账再读存储，本档必红。
test('A4b a reclaimed page — module state gone, storage kept — still hands the text back once', async () => {
  const store = {}
  const first = buildSendSandbox(store)
  const flight = first.run()
  first.switchTo(null)
  first.reject(new Error('offline'))
  await flight
  assert.ok(store[SEND_KEY + 's1'], 'the abandoned failure was written through to storage')

  // 新的一次页面生命周期：内存账本空，只有 localStorage 活着。
  const revived = buildSendSandbox(store, '')
  assert.equal(revived.ledger().size, 0, 'nothing survives in memory across a page reclaim')
  assert.equal(revived.value(), '', 'and the fresh composer is empty')
  revived.resume('s1')
  assert.equal(revived.value(), 'hello', 'the reclaimed page hands the text back instead of losing it silently')
  assert.equal(revived.errors.filter((entry) => entry.id === 'toast').length, 1, 'and says why it came back')
  assert.equal(store[SEND_KEY + 's1'], undefined, 'then settles the books')

  revived.resume('s1')
  assert.equal(revived.errors.filter((entry) => entry.id === 'toast').length, 1, 'a second settle has nothing left, so no second toast')
})

test('A5 a send that succeeds after the reader left leaves no ghost entry behind', async () => {
  const sandbox = buildSendSandbox()
  const flight = sandbox.run()
  sandbox.switchTo('s2')
  sandbox.accept()
  await flight
  assert.equal(sandbox.ledger().size, 0, 'settled before the leave-check, so nothing is replayed on the next visit')
  assert.equal(sandbox.store()[SEND_KEY + 's1'], undefined, 'and nothing is left in storage')
  assert.equal(sandbox.cleared(), 0, 'while the draft box of the session on screen is left alone')
})

test('A6 an in-flight send survives a page switch: the unsettled bubble is re-attached on re-entry', async () => {
  const sandbox = buildSendSandbox()
  sandbox.run().catch(() => {})
  sandbox.switchTo('s2')
  sandbox.resume('s1')
  assert.equal(sandbox.prompts(), 1, 'the still-unconfirmed bubble comes back with the reader')
  assert.equal(sandbox.value(), '', 'a bubble that is still live must not also refill the composer')
})

test('A7 an entry older than the stale window is dropped: no bubble, no refill', async () => {
  const sandbox = buildSendSandbox()
  const flight = sandbox.run()
  sandbox.switchTo(null)
  sandbox.reject(new Error('offline'))
  await flight
  const entry = sandbox.ledger().get('s1')
  assert.ok(entry && entry.failed === true, 'the entry is there before we age it')
  entry.t = Date.now() - STALE_MS - 1000
  sandbox.resume('s1')
  assert.equal(sandbox.value(), '', 'a ten-minute-old failure is not the reader\'s text any more')
  assert.equal(sandbox.prompts(), 0, 'and no ghost bubble is raised for it')
})
