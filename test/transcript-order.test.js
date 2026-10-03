// Transcript ordering / history paging — WHITE-BOX (extract the page functions
// and run them against synthetic event frames).
//
// Live reports 2026-10-02:
//   * "顺序有点乱掉" — an optimistically echoed prompt rendered *below* the answer
//     it triggered, because echoes were appended after the durable transcript.
//   * "再发一条消息，前面的消息就突然不见了" — a history page (the last 30
//     *records*, often less than one turn) was assigned over the live buffer.
//   * no way to reach older messages when the transcript is shorter than the
//     viewport.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets, renderMobilePage } from '../lib/pages.js'

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

function userEvent(seq, text) {
  return {
    event: { seq, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } },
  }
}

function chunkEvent(seq, turn, step, text) {
  return { event: { seq, type: 'assistant/chunk', data: { turn, step, chunk: { type: 'text-delta', index: 0, text } } } }
}

function buildSandbox() {
  const { js } = mobilePageAssets({ locale: 'zh' })
  const names = ['eventSeq', 'mergeEntries', 'contentBlocks', 'stepKey', 'windowEvents', 'visibleMessages', 'durableUserPromptText', 'messagesWithOptimistic']
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  return new Function(
    `let olderEvents=[],streamEvents=[],lastDurableMessages=[],optimisticPrompts=[];
     const processBlocks=()=>[];
     const L={};
     ${body}
     return {
       mergeEntries, visibleMessages, messagesWithOptimistic, windowEvents,
       setStream(value){streamEvents=value},
       setOptimistic(value){optimisticPrompts=value},
       render(){return messagesWithOptimistic(visibleMessages(windowEvents()))},
     }`,
  )()
}

test('the transcript stamps each rendered item with its event seq', () => {
  const sandbox = buildSandbox()
  sandbox.setStream([userEvent(1, '第一条'), chunkEvent(2, 1, 1, '回答一')])
  const rendered = sandbox.visibleMessages(sandbox.windowEvents())
  assert.equal(rendered.length, 2)
  assert.equal(rendered[0].role, 'user')
  assert.equal(rendered[0]._seq, 1)
  assert.equal(rendered[1].role, 'assistant')
  assert.equal(rendered[1]._seq, 2)
})

test('an echoed prompt is inserted at its seq position instead of below its answer', () => {
  const sandbox = buildSandbox()
  sandbox.setStream([userEvent(1, '第一条'), chunkEvent(2, 1, 1, '回答一'), chunkEvent(3, 2, 1, '回答二')])
  sandbox.setOptimistic([{ id: 'o1', text: '继续', summary: '', afterSeq: 1 }])
  const rendered = sandbox.render()
  assert.deepEqual(
    rendered.map((message) => message.blocks.map((block) => block.text).join('|')),
    ['第一条', '继续', '回答一', '回答二'],
    'the echo belongs between the prompt it answered and the next answer',
  )
  assert.equal(rendered[1].optimistic, true)
})

test('an echo is retired once the durable copy of that send arrives', () => {
  const sandbox = buildSandbox()
  sandbox.setStream([userEvent(1, '第一条'), chunkEvent(2, 1, 1, '回答一'), userEvent(3, '继续')])
  sandbox.setOptimistic([{ id: 'o1', text: '继续', summary: '', afterSeq: 1 }])
  const rendered = sandbox.render()
  assert.equal(rendered.filter((message) => message.optimistic).length, 0, 'the durable 继续 replaces the echo')
  assert.deepEqual(
    rendered.map((message) => message.blocks.map((block) => block.text).join('|')),
    ['第一条', '回答一', '继续'],
  )
})

test('a repeated prompt from an older page never retires a newer echo', () => {
  const sandbox = buildSandbox()
  // "继续" already appears earlier in the conversation and came back from a
  // paged-in history window; the tally-based rule mistook it for the echo's own
  // durable copy and left the echo glued to the bottom forever.
  sandbox.setStream([userEvent(2, '继续'), chunkEvent(3, 1, 1, '回答一')])
  sandbox.setOptimistic([{ id: 'o1', text: '继续', summary: '', afterSeq: 6 }])
  const rendered = sandbox.render()
  assert.equal(rendered.filter((message) => message.optimistic).length, 1, 'the echo must survive')
  assert.equal(rendered[rendered.length - 1].optimistic, true, 'and it is the newest thing on screen')
})

test('seq-less records keep their arrival position instead of jumping to the end', () => {
  const sandbox = buildSandbox()
  const merged = sandbox.mergeEntries([{ seq: 1, tag: 'a' }, { tag: 'x' }, { seq: 2, tag: 'b' }])
  assert.deepEqual(merged.map((entry) => entry.tag), ['a', 'x', 'b'])
})

test('mergeEntries dedupes by seq keeping the first copy', () => {
  const sandbox = buildSandbox()
  const merged = sandbox.mergeEntries([{ seq: 5, tag: 'first' }, { seq: 5, tag: 'second' }])
  assert.deepEqual(merged.map((entry) => entry.tag), ['first'])
})

test('AC-PERF a seq-less record keeps the same key across repaints and history paging', () => {
  const sandbox = buildSandbox()
  const batch = [{ seq: 1, tag: 'a' }, { tag: 'x1' }, { tag: 'x2' }, { seq: 2, tag: 'b' }, { tag: 'x3' }]
  sandbox.mergeEntries(batch)
  const keys1 = sandbox.mergeEntries.lastKeys
  sandbox.mergeEntries(batch)
  const keys2 = sandbox.mergeEntries.lastKeys
  assert.deepEqual(JSON.stringify(keys1), JSON.stringify(keys2), 'two repaints of the same batch agree on every key')

  // The defect this replaces: the key was anchored to the running max seq, so a
  // record that carries no seq changed key the moment a history page landed
  // above it and the transcript could jump.
  const stream = [{ seq: 100, tag: 's1' }, { tag: 'noSeq' }, { seq: 101, tag: 's2' }]
  const keyOf = (list, tag) => {
    const order = sandbox.mergeEntries(list).map((entry) => entry.tag)
    return sandbox.mergeEntries.lastKeys[order.indexOf(tag)]
  }
  const before = keyOf([{ seq: 1, tag: 'o1' }].concat(stream), 'noSeq')
  const after = keyOf([{ seq: 1, tag: 'o1' }, { seq: 2, tag: 'o2' }].concat(stream), 'noSeq')
  assert.equal(before, after, 'a prepended history page must not move a seq-less record key')
  assert.deepEqual(
    sandbox.mergeEntries([{ seq: 1, tag: 'o1' }, { seq: 2, tag: 'o2' }].concat(stream)).map((entry) => entry.tag),
    ['o1', 'o2', 's1', 'noSeq', 's2'],
    'and it still sits between its own neighbours',
  )
})

test('the history page is merged into the live buffer, never assigned over it', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  assert.ok(js.includes('streamEvents=mergeEntries(streamEvents.concat(fetched))'), 'history must append')
  assert.ok(!js.includes('streamEvents=fetched'), 'a short history page must not collapse the transcript')
  assert.ok(!js.includes('targetCount'), 'the text-tally echo rule must be gone')
  assert.ok(!js.includes('nextOptimisticTarget'), 'the text-tally echo rule must be gone')
})

test('a send repaints from the live buffer, not from a stale snapshot', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  assert.ok(js.includes('paintMessages(messagesWithOptimistic(currentTranscript()),true)'))
  assert.ok(!js.includes('paintMessages([...lastDurableMessages,...optimisticPrompts.map('))
})

test('the transcript offers a tap target for older messages', () => {
  const html = renderMobilePage({ locale: 'zh' })
  assert.ok(html.includes('data-older="1"'), 'the older row must be tappable')
  assert.ok(html.includes('data-reload="1"'), 'a failed first load must offer a retry')
  assert.ok(html.includes('class="older-row'), 'older-row CSS/markup must ship')
  // 2026-10-02 audit WP-A1 / A-7②: an empty transcript must not paint an empty
  // box, so the join moved behind the emptiness test. Rewritten from the old
  // literal `box.innerHTML=olderButtonHtml()+messages.map(renderMessage).join('')+status`
  // (change 2026-10-02-fix-pocket-audit-remediation, tasks WP-A1 A-7②) — the older
  // row still leads and the messages still follow it.
  assert.ok(html.includes("box.innerHTML=olderButtonHtml()+(messages.length?messages.map(renderMessage).join(''):transcriptWaitHtml(box))+status"))
  assert.ok(html.includes('function renderOlderButton()'), 'the row must be re-synced without a full repaint')
})

test('short transcripts keep pulling older pages until the viewport is filled', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  assert.ok(js.includes('async function ensureTranscriptFilled()'))
  // 2026-10-02 audit WP-A1 / A-7④: the one combined test conflated "there is
  // nothing older" with "the screen is already full", so an empty transcript was
  // never filled. Rewritten from `if(!olderHasMore||box.scrollHeight>box.clientHeight+8)return`
  // (change 2026-10-02-fix-pocket-audit-remediation) into the two separate reasons
  // to stop, and the loop condition now mirrors them.
  assert.ok(js.includes('if(box.scrollHeight>box.clientHeight+8)return'), 'fill only while short')
  assert.ok(js.includes('if(!olderHasMore&&transcriptHasContent())return'), 'stop only when nothing is missing')
  assert.ok(!js.includes('if(!olderHasMore||box.scrollHeight>box.clientHeight+8)return'), 'the combined early return is gone')
  assert.ok(js.includes('while(activeSession&&(olderHasMore||!transcriptHasContent())'), 'an empty buffer keeps filling')
  assert.ok(js.includes('pages<8'), 'the fill loop must be bounded')
  assert.ok(js.includes('const deadline=Date.now()+6000'), 'the fill loop needs a time budget')
  assert.ok(js.includes('void ensureTranscriptFilled()'), 'a finished page triggers the next fill')
  // 2026-10-02: the handoff path (paintInstantHistory) deliberately skips the
  // history RPC, and openSession's own call ran before the handoff had set
  // olderHasMore, so the fill loop was never armed on the normal phone boot
  // path: a short handoff left the chat half empty on a tall screen.
  assert.ok(js.includes('void ensureTranscriptFilled();return true}'), 'the embedded handoff must arm the fill loop')
  assert.ok(
    js.split('void ensureTranscriptFilled()').length - 1 >= 3,
    'fill must be armed at boot, after every page, and after openSession',
  )
  // The page size belongs to the transport, not to the layout: raising it to
  // "show more messages" is the treadmill the fix exists to avoid.
  assert.ok(js.includes('maxMessages:30'), 'history paging stays at 30 records')
  assert.ok(!js.includes('maxMessages:60'), 'the record page size is not raised to fake a screenful')
})

test('a blank skeleton is retried instead of being left on screen', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  assert.ok(js.includes('function armSkeletonWatchdog('), 'the skeleton needs a watchdog')
  // 2026-10-02 audit WP-A1 / A-7①: a painted transcript, not a skeleton still on
  // screen, is what tells the watchdog to stop — a failed load replaces the
  // skeleton with its own block, so the old anchor disarmed the retries exactly
  // when the user needed them. Rewritten from
  // `if(!$('messages').querySelector('.loading'))return`
  // (change 2026-10-02-fix-pocket-audit-remediation); a session the desktop
  // reports as blank needs no content, so it is not retried into a false failure.
  assert.ok(js.includes("if($('messages').querySelector('.message')||sessionBlank)return"), 'the watchdog stops once content paints')
  assert.ok(!js.includes("if(!$('messages').querySelector('.loading'))return"), 'the skeleton is no longer the stop signal')
  assert.ok(js.includes('if(attempt>=3){showTranscriptRetry();return}'), 'three silent retries end in a tappable retry')
  assert.ok(js.includes('armSkeletonWatchdog(id)'), 'openSession must arm it')
  assert.ok(js.includes('clearSkeletonWatchdog()'), 'leaving the session must disarm it')
  assert.ok(js.includes('if(!activeSession||(historyBusy&&!force))return'), 'the watchdog needs a forced retry path')
})

test('the todo dock reserves its height so the turn status is not covered', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  assert.ok(js.includes('function syncTodoHeight(host)'))
  assert.ok(js.includes("document.body.style.setProperty('--todo-h'"))
  assert.ok(js.includes('syncTodoHeight(host)'), 'renderTodoDock must publish its height')
})

// 2026-10-02 (second round): one page holds 30 *records*, which is routinely
// less than a single assistant bubble, so a tap on the older row could page in
// 30 records and still change nothing on screen — read by the user as "点了没反应".
// A tap must now keep pulling until an earlier *user* message actually appears.
test('a tap keeps pulling older pages until an earlier user message appears', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  assert.ok(js.includes('async function fetchOlderPage()'), 'the single-page primitive must exist')
  assert.ok(js.includes('async function loadOlder()'), 'the tap path must exist')
  assert.ok(js.includes('function olderUserCount()'), 'progress is measured in user messages, not records')
  assert.ok(js.includes('const before=olderUserCount()'))
  assert.ok(js.includes('if(olderUserCount()>before)break'), 'stop as soon as an earlier user message lands')
  assert.ok(js.includes('deadline=Date.now()+8000'), 'the multi-page pull needs a time budget')
  assert.ok(js.includes('pages<8'), 'the multi-page pull must be bounded')
  assert.ok(js.includes('function oldestEventSeq()'), 'the anchor must not assume windowEvents()[0] is oldest')
  assert.ok(js.includes('box.scrollTop=prevTop+(box.scrollHeight-prevHeight)'), 'paging in must keep the reading position')
  // The fill loop must call the single-page primitive: nesting loadOlder inside
  // its own 8-page loop would allow up to 64 requests.
  assert.ok(js.includes('if(!await fetchOlderPage())break'), 'the fill loop pages one at a time')
})

test('reaching the start of the conversation is final for the row', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  assert.ok(js.includes('olderExhausted'), 'exhaustion is remembered')
  assert.ok(js.includes('if(!olderHasMore)olderExhausted=true'), 'an empty page marks the start')
  assert.ok(
    js.includes('olderHasMore=olderExhausted?false:olderHasMore||value.hasMore===true'),
    'a poll may arm the row, but never re-arm it after the start was reached',
  )
  assert.ok(js.includes('olderHasMore=false;olderBusy=false;olderExhausted=false;'), 'leaving the session resets it')
})

// AC-PERF the exhausted latch must survive a re-entry without ever becoming a
// wall: it is restored with the session it belongs to, cleared when a fresh
// snapshot arrives, and every paging gate lets an empty transcript through it so
// the bootstrap path can still pull the first page.
test('AC-PERF the exhausted latch follows its session and never blocks an empty buffer', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })

  // Restored with the cache it was stored in, and dropped when the handoff
  // snapshot supersedes it — a latch that outlived its session would disable the
  // row in a conversation that was never exhausted.
  assert.ok(
    js.includes('olderHasMore=cached.olderHasMore;olderExhausted=cached.olderExhausted===true;'),
    'the cached latch comes back with its own session',
  )
  assert.ok(
    js.includes('olderHasMore=embeddedFocus.history.hasMore===true;olderExhausted=false;'),
    'a fresh handoff snapshot clears it',
  )

  // The latch only ever closes the row for a session that has real content; an
  // empty buffer keeps all three gates open, which is the bootstrap A-7③④ relies on.
  const gates = [
    ['the fill loop', 'if(!olderHasMore&&transcriptHasContent())return'],
    ['the page fetch', 'if(olderBusy||!activeSession||(!olderHasMore&&transcriptHasContent()))return false'],
    ['the multi-page pull', 'if(olderRunBusy||!activeSession||(!olderHasMore&&transcriptHasContent()))return false'],
  ]
  for (const [why, gate] of gates) assert.ok(js.includes(gate), `${why} exempts an empty transcript: ${gate}`)
  assert.ok(
    js.includes('while(activeSession&&(olderHasMore||!transcriptHasContent())&&pages<8'),
    'and the fill loop keeps paging while nothing is painted',
  )

  // Once the start is reached the latch can only be armed by a later fetch, never
  // by a poll that reports more.
  assert.ok(
    js.includes('if(!olderHasMore)olderExhausted=true'),
    'only a real empty page sets it',
  )
  assert.equal(js.split('olderExhausted=true').length - 1, 1, 'nothing else sets it')
  assert.ok(
    js.includes('olderHasMore=olderExhausted?false:olderHasMore||value.hasMore===true'),
    'the poll honours the latch',
  )
})

test('the list follows the finger and springs back without the old ring', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  const html = renderMobilePage({ locale: 'zh' })
  assert.ok(html.includes('#messages.pulling,#messages.animating{will-change:transform}'))
  assert.ok(html.includes('#messages.animating{transition:transform .24s cubic-bezier(.22,1,.36,1)}'))
  assert.ok(js.includes('MAXPULL=88'), 'the pull is clamped')
  assert.ok(js.includes('HOLD=44'), 'the list stays held down while a page is in flight')
  assert.ok(js.includes("box.style.transform=px?'translateY('+px+'px)':''"), 'the list tracks the finger')
  assert.ok(js.includes("box.addEventListener('transitionend'"), 'the transform is released at rest')
  assert.ok(js.includes("if(!active)box.classList.remove('animating')},320)"), 'the resting class is dropped even when no transition frame arrives')
  assert.ok(!js.includes('pullIndicator'), 'the second spinner stays deleted')
  assert.ok(!js.includes('pull-ring'), 'the ring stays deleted')
})

test('one back action always leaves the chat view', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  assert.ok(js.includes('async function openSession(id,title,fromHistory=false,pushHistory=true)'), 'the opener knows who pushed the entry')
  assert.ok(
    js.includes("if(pushHistory)history.pushState(entry,'');else history.replaceState(entry,'')"),
    'an automatic jump rewrites the current entry instead of stacking a second chat entry',
  )
  assert.ok(
    js.includes("if(document.body.classList.contains('chat-open')){history.replaceState({view:'sessions'},'');showSessionList();return}"),
    'a stale duplicate chat entry collapses to the session list instead of reopening the same chat',
  )
  assert.ok(js.includes("history.state?.view==='chat'&&history.length>1"), 'a single-entry stack does not press a dead back button')
  assert.ok(js.includes('await openSession(target.sessionId,titleFor(target),false,false)'), 'the resume jump does not push history')
  assert.ok(
    js.includes('await openSession(nextFocus.sessionId,titleFor(nextFocus),false,false)'),
    'the boot reconcile jump does not push history',
  )
  assert.ok(js.includes('await openSession(created.sessionId)'), 'creating a session stays user-initiated, so it still pushes history')
  assert.ok(js.includes('void openSession(btn.dataset.id)'), 'opening a session row stays user-initiated, so it still pushes history')
})

test('handleHistory leaves the chat when a stale chat entry arrives while it is already open', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  const source = extractFunction(js, 'handleHistory')

  const harness = chatOpen => {
    const calls = { opened: [], replaced: [], listed: 0 }
    const document = { body: { classList: { contains: name => chatOpen && name === 'chat-open' } } }
    const history = { replaceState: (state, url) => { calls.replaced.push([state, url]) } }
    const openSession = (id, title, fromHistory) => { calls.opened.push([id, title, fromHistory]) }
    const showSessionList = () => { calls.listed += 1 }
    const handleHistory = new Function(
      'document',
      'history',
      'openSession',
      'showSessionList',
      `${source}; return handleHistory;`,
    )(document, history, openSession, showSessionList)
    return { calls, handleHistory }
  }

  // The reported dead gesture: a stale {view:'chat'} entry pops while the chat is already on
  // screen. Reopening the same session repainted an identical view, so back looked like a no-op.
  const open = harness(true)
  open.handleHistory({ view: 'chat', sessionId: 's1', title: 'T' })
  assert.deepEqual(open.calls.opened, [], 'the same chat must not be reopened')
  assert.equal(open.calls.listed, 1, 'the session list is shown instead')
  assert.deepEqual(open.calls.replaced, [[{ view: 'sessions' }, '']], 'the stale entry is rewritten so the next back still works')

  // A genuine forward navigation into a chat, arriving while the list is on screen.
  const listed = harness(false)
  listed.handleHistory({ view: 'chat', sessionId: 's1', title: 'T' })
  assert.deepEqual(listed.calls.opened, [['s1', 'T', true]], 'a real back into a chat still opens it')
  assert.equal(listed.calls.listed, 0)
  assert.deepEqual(listed.calls.replaced, [])

  // The sessions entry, and a missing state, both land on the list.
  for (const state of [{ view: 'sessions' }, null]) {
    const plain = harness(true)
    plain.handleHistory(state)
    assert.equal(plain.calls.listed, 1, 'the sessions entry shows the list')
    assert.deepEqual(plain.calls.opened, [])
    assert.deepEqual(plain.calls.replaced, [])
  }
})

// 2026-10-02 live report: from a freshly reconnected chat, the browser's own edge
// swipe left the app instead of returning to the workspace list. The in-app back
// button can compensate with history.length>1, the edge swipe cannot — so a boot
// that adopts the conversation must already have a list entry underneath it.
test('a boot straight into the conversation keeps a workspace entry under it', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  assert.ok(js.includes("history.replaceState({view:'sessions'},'')"), 'the landing entry is a sessions entry')
  assert.ok(
    js.includes("if(document.body.classList.contains('chat-open'))history.pushState({view:'sessions'},'')"),
    'the adopted chat view needs a second sessions entry below it, or a swipe leaves the app',
  )
})

// 2026-10-02 live report: reconnecting to an already-paired phone lands on a chat
// whose transcript arrives one tunnel round trip later (the desktop deliberately
// keeps it out of the document), and three bare skeleton bars read as a freeze.
test('the transcript wait names itself instead of showing bare grey bars', () => {
  const { js, css } = mobilePageAssets({ locale: 'zh' })
  assert.ok(js.includes('function loadingShell()'), 'the waiting state needs one source')
  assert.ok(js.includes('\'<p class="loading-hint">\'+L.syncingChat+\'</p>'), 'the hint is part of it')
  assert.ok(js.includes('syncingChat'), 'the copy is localized like the rest of the page')
  assert.ok(js.includes('正在同步会话内容…'), 'the zh copy matches the pairing steps verbatim')
  assert.equal(
    js.split('loadingShell()').length - 1,
    // 2026-10-02 audit WP-A1 / A-7②: raised from 3. An empty repaint needs the
    // same named wait as the first paint, so transcriptWaitHtml() joined the two
    // existing call sites (change 2026-10-02-fix-pocket-audit-remediation).
    4,
    'the helper and its three call sites (first paint, failed-load retry, empty repaint)',
  )
  assert.ok(!js.includes('$(\'messages\').innerHTML=\'<div class="loading">'), 'no anonymous skeleton block survives')
  assert.ok(css.includes('.loading-hint{'), 'the hint needs its own style')
})
// ============================================================================
// WP-A3 (change 2026-10-02-fix-pocket-audit-remediation): M6 the thinking
// status, M17 the echoed prompt, K-3 the pull lock, J-1 the three ways to
// reach older messages. Same white-box style as above: run the page's own
// functions against synthetic frames, and pin the source where behaviour
// cannot reach.
// ============================================================================

function betweenA3(startAnchor, endAnchor, source = mobilePageAssets({ locale: 'zh' }).js) {
  const start = source.indexOf(startAnchor)
  const end = source.indexOf(endAnchor, start)
  assert.notEqual(start, -1, `anchor ${startAnchor} must exist in the page script`)
  assert.notEqual(end, -1, `anchor ${endAnchor} must exist in the page script`)
  assert.ok(end > start, `anchor ${endAnchor} must come after ${startAnchor}`)
  return source.slice(start, end)
}

function pageLabels(locale) {
  const line = mobilePageAssets({ locale }).js.match(/^const L=(\{.*\});/m)
  assert(line, `${locale}: the label table must render as one JSON line`)
  return JSON.parse(line[1])
}

// ------------------------------------------------------------ M6 the thinking status

function buildRunningSandbox() {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const bound = Number((js.match(/AWAITING_TURN_MAX_MS=(\d+)/) || [])[1])
  assert(bound > 0, 'the page declares its fallback bound')
  const idle = Number((js.match(/TURN_RUNNING_IDLE_MAX_MS=(\d+)/) || [])[1])
  assert(idle > 0, 'the page declares the idle bound the run state retires on')
  const names = ['eventSeq', 'clearAwaitingTurn', 'armAwaitingTurn', 'expireAwaitingTurn', 'noteTurnBoundary', 'updateRunning', 'clearTurnRunningWatch', 'expireTurnRunning', 'watchTurnRunning']
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  return new Function(`
    const AWAITING_TURN_MAX_MS=${bound}
    const TURN_RUNNING_IDLE_MAX_MS=${idle},idle=TURN_RUNNING_IDLE_MAX_MS
    let awaitingTurnSeq=null,awaitingTurnTimer=null,agentRunning=false,lastHistoryKey='',activeSession='s1',turnRunningSeq=-1,turnRunningOpen=false,turnRunningSeenSeq=-1,turnRunningTimer=null,pendingQuestion=null
    const calls=[]
    const setTimeout=(fn,ms)=>{calls.push(['timeout',ms]);return 1}
    const clearTimeout=handle=>{calls.push(['clear',handle])}
    function syncPromptUi(){calls.push(['prompt'])}
    function syncTurnStatus(){calls.push(['status'])}
    function schedulePoll(){calls.push(['poll'])}
    ${body}
    return {
      arm(value){armAwaitingTurn(value)},
      update(events){updateRunning(events)},
      expire(){expireAwaitingTurn()},
      expireTurn(){expireTurnRunning()},
      setQuestion(value){pendingQuestion=value},
      idle,
      state:()=>({awaitingTurnSeq,awaitingTurnTimer,agentRunning,lastHistoryKey,turnRunningSeq,turnRunningOpen,turnRunningSeenSeq,turnRunningTimer,pendingQuestion}),
      calls,
    }
  `)()
}

test('M6 the wait is judged on the session log, never on two clocks', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const slice = betweenA3('function updateRunning(events)', 'function todoProgress(', js)
  assert.ok(slice.includes('eventSeq(entry)>awaitingTurnSeq'), 'the judgement is a seq comparison')
  assert.ok(!slice.includes('event.time'), 'no host timestamp is read here at all')
  assert.ok(!js.includes('awaitingTurnStartedAt'), 'the wall-clock slot is gone from the page')
  assert.ok(!js.includes('Date.now()-1000'), 'and so is the expression that armed it')
  const send = betweenA3('async function send()', 'function formatBytes(n)', js)
  assert.ok(send.includes('armAwaitingTurn(afterSeq)'), 'send records the watermark the boundary is compared with')
})

test('M6 a turn boundary above the watermark ends the wait even when the host clock is decades off', () => {
  const sandbox = buildRunningSandbox()
  sandbox.arm(5)
  // time: 1 is 1970 on any host. The retired version compared that with the
  // phone's own Date.now(), so it never matched and the status stayed pinned.
  sandbox.update([{ event: { seq: 6, type: 'turn/start', time: 1 } }])
  assert.equal(sandbox.state().awaitingTurnSeq, null, 'the seq judgement consumed the wait')
  assert.equal(sandbox.state().agentRunning, true, 'and the turn is running because it says so')
  assert.ok(sandbox.calls.some((call) => call[0] === 'clear'), 'the fallback timer is cancelled with it')
  sandbox.update([{ event: { seq: 7, type: 'turn/end', time: 1 } }])
  assert.equal(sandbox.state().agentRunning, false, 'turn/end ends the turn without any clock')
})

test('M6 a turn boundary at or below the watermark does not end the wait', () => {
  const sandbox = buildRunningSandbox()
  sandbox.arm(10)
  sandbox.update([{ event: { seq: 3, type: 'turn/start' } }])
  assert.notEqual(sandbox.state().awaitingTurnSeq, null, 'an older turn/start is not the answer to this send')
  assert.equal(sandbox.state().agentRunning, true)
})

test('M6 an unreachable judgement still clears, within the 8-10s band', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const bound = Number((js.match(/AWAITING_TURN_MAX_MS=(\d+)/) || [])[1])
  assert.ok(bound >= 8000 && bound <= 10000, 'the unconditional fallback is bounded by the card')
  const sandbox = buildRunningSandbox()
  sandbox.arm(4)
  assert.ok(sandbox.calls.some((call) => call[0] === 'timeout' && call[1] === bound), 'arming starts the watchdog')
  sandbox.expire()
  const after = sandbox.state()
  assert.equal(after.awaitingTurnSeq, null, 'the watchdog clears the wait')
  assert.equal(after.agentRunning, false, 'and the thinking status with it')
  assert.equal(after.lastHistoryKey, '', 'so the next poll repaints instead of skipping it')
  assert.ok(sandbox.calls.some((call) => call[0] === 'status'), 'the status node comes off screen')
  assert.ok(sandbox.calls.some((call) => call[0] === 'prompt'), 'and the send/cancel pair is put back')
  assert.ok(sandbox.calls.some((call) => call[0] === 'poll'), 'the poll is re-armed at the idle rate')
})

// ------------------------------------------------------- BUG1 the run state is monotonic

test('BUG1 trimming the event window cannot end a turn that is still open', () => {
  const sandbox = buildRunningSandbox()
  sandbox.update([{ event: { seq: 10, type: 'turn/start', time: 1 } }])
  assert.equal(sandbox.state().agentRunning, true, 'the turn opens with its own boundary in the window')
  // This is the regression: the window has since dropped everything but chunks, so a
  // re-scan of it can no longer see the turn/start, and the status used to vanish.
  sandbox.update([{ event: { seq: 35, type: 'assistant/chunk', time: 1 } }])
  assert.equal(sandbox.state().agentRunning, true, 'a window without its turn/start still says running')
  assert.equal(sandbox.state().turnRunningSeq, 10, 'the high-water mark keeps the newest boundary it saw')
  sandbox.update([{ event: { seq: 40, type: 'turn/end', time: 1 } }])
  assert.equal(sandbox.state().agentRunning, false, 'the turn ends when its own boundary arrives')
})

test('BUG1 an out-of-order older boundary never rewinds the turn', () => {
  const sandbox = buildRunningSandbox()
  sandbox.update([{ event: { seq: 40, type: 'turn/end', time: 1 } }])
  assert.equal(sandbox.state().agentRunning, false, 'the newest boundary closed the turn')
  sandbox.update([{ event: { seq: 12, type: 'turn/end', time: 1 } }])
  sandbox.update([{ event: { seq: 13, type: 'turn/start', time: 1 } }])
  assert.equal(sandbox.state().agentRunning, false, 'a replayed older boundary is ignored')
  assert.equal(sandbox.state().turnRunningSeq, 40, 'the mark only moves forward')
  sandbox.update([{ event: { seq: 41, type: 'turn/start', time: 1 } }])
  assert.equal(sandbox.state().agentRunning, true, 'a strictly newer boundary still opens the next turn')
})

test('BUG1 the run state reads a high-water mark, not the visible window', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const update = betweenA3('function updateRunning(events)', 'function todoProgress(', js)
  assert.ok(update.includes('noteTurnBoundary(entry)'), 'every boundary feeds the high-water mark')
  assert.ok(
    /agentRunning=turnRunningOpen\|\|awaitingTurnSeq!==null/.test(update),
    'the run state reads the mark and the wait instead of re-scanning the window'
  )
  const mark = betweenA3('function noteTurnBoundary(entry)', 'function updateRunning(events)', js)
  assert.ok(mark.includes('if(seq<turnRunningSeq)return'), 'an older boundary never rewinds the mark')
  assert.ok(mark.includes("turnRunningOpen=type==='turn/start'"), 'the open flag follows the newest boundary')
  const watchdog = betweenA3('function expireAwaitingTurn()', 'function noteTurnBoundary(entry)', js)
  assert.ok(watchdog.includes('turnRunningSeq=-1'), 'the watchdog resets the mark with the wait')
  assert.ok(watchdog.includes('turnRunningOpen=false'), 'and closes it')
})

// ------------------------------------------------------------- WD the run watchdog

test('WD1 an idle log retires the run state and raises the mark to what it saw', () => {
  const sandbox = buildRunningSandbox()
  sandbox.update([{ event: { seq: 10, type: 'turn/start' } }])
  sandbox.update([{ event: { seq: 35, type: 'assistant/chunk' } }])
  assert.equal(sandbox.state().turnRunningOpen, true, 'the log is still moving, so the turn is still open')
  sandbox.calls.length = 0
  sandbox.expireTurn()
  const after = sandbox.state()
  assert.equal(after.turnRunningOpen, false, 'an idle log closes the turn instead of pinning the thinking status')
  assert.equal(after.agentRunning, false, 'and the status itself leaves with it')
  assert.equal(after.turnRunningSeq, 35, 'the mark is raised to the newest seq the log ever showed')
  assert.equal(after.lastHistoryKey, '', 'so the next poll repaints instead of skipping it')
  assert.ok(sandbox.calls.some((call) => call[0] === 'status'), 'the status node comes off screen')
  assert.ok(sandbox.calls.some((call) => call[0] === 'prompt'), 'and the send/cancel pair is put back')
  assert.ok(sandbox.calls.some((call) => call[0] === 'poll'), 'the poll is re-armed at the idle rate')
})

test('WD2 the raised mark is sticky: a replayed window cannot reopen the turn', () => {
  const sandbox = buildRunningSandbox()
  sandbox.update([{ event: { seq: 10, type: 'turn/start' } }])
  sandbox.update([{ event: { seq: 35, type: 'assistant/chunk' } }])
  sandbox.expireTurn()
  // The same window as before, replayed by the history poll. Its turn/start now sits
  // below the mark the expiry left behind, so it is not a new turn and must not count.
  sandbox.update([{ event: { seq: 10, type: 'turn/start' } }])
  sandbox.update([{ event: { seq: 35, type: 'assistant/chunk' } }])
  assert.equal(sandbox.state().turnRunningOpen, false, 'a replayed turn/start below the mark changes nothing')
  assert.equal(sandbox.state().agentRunning, false, 'so the status does not come back on the replay')
  sandbox.update([{ event: { seq: 41, type: 'turn/start' } }])
  assert.equal(sandbox.state().agentRunning, true, 'a strictly newer boundary still opens the next turn')
})

test('WD3 the clock only restarts on real progress, never on a repeated seq', () => {
  const sandbox = buildRunningSandbox()
  sandbox.arm(20)
  sandbox.update([{ event: { seq: 21, type: 'turn/start' } }])
  assert.ok(
    sandbox.calls.some((call) => call[0] === 'timeout' && call[1] === sandbox.idle),
    'a wait that ends on a real boundary hands the turn over to the idle bound'
  )
  assert.equal(sandbox.state().awaitingTurnSeq, null, 'and the wait itself is consumed')
  sandbox.update([{ event: { seq: 35, type: 'assistant/chunk' } }])
  assert.ok(sandbox.calls.some((call) => call[0] === 'clear'), 'progress restarts the clock')
  assert.ok(sandbox.calls.some((call) => call[0] === 'timeout' && call[1] === sandbox.idle), 'and arms it again')
  sandbox.calls.length = 0
  sandbox.update([{ event: { seq: 35, type: 'assistant/chunk' } }])
  assert.ok(!sandbox.calls.some((call) => call[0] === 'timeout'), 'the same seq is not progress')
  assert.ok(!sandbox.calls.some((call) => call[0] === 'clear'), 'and it does not touch the clock either')
})

test('WD4 the watch stays off while a wait or a question owns the turn', () => {
  const sandbox = buildRunningSandbox()
  sandbox.update([{ event: { seq: 50, type: 'turn/start' } }])
  sandbox.calls.length = 0
  sandbox.setQuestion('do it?')
  sandbox.update([{ event: { seq: 51, type: 'assistant/chunk' } }])
  assert.ok(
    !sandbox.calls.some((call) => call[0] === 'timeout' && call[1] === sandbox.idle),
    'a turn parked on an open question is not an idle turn'
  )
  assert.equal(sandbox.state().turnRunningOpen, true, 'and the turn stays open while the question is up')
  sandbox.setQuestion(null)
  sandbox.update([{ event: { seq: 52, type: 'assistant/chunk' } }])
  assert.ok(
    sandbox.calls.some((call) => call[0] === 'timeout' && call[1] === sandbox.idle),
    'answering the question hands the turn back to the watch'
  )
  // The other gate: a wait this phone started is still on its own clock, so a stale
  // boundary that arrives under it cannot be read as this turn having gone idle.
  sandbox.arm(60)
  sandbox.update([{ event: { seq: 61, type: 'turn/start' } }])
  sandbox.arm(70)
  sandbox.calls.length = 0
  sandbox.update([{ event: { seq: 5, type: 'turn/end' } }])
  assert.ok(
    !sandbox.calls.some((call) => call[0] === 'timeout'),
    'a boundary below the watermark of an unsettled wait is not an idle turn'
  )
})

test('WD5 a question that owns the turn keeps the status up even when the idle bound fires without a scan in between', () => {
  const sandbox = buildRunningSandbox()
  sandbox.update([{ event: { seq: 10, type: 'turn/start' } }])
  sandbox.calls.length = 0
  sandbox.setQuestion('do it?')
  sandbox.expireTurn()
  const after = sandbox.state()
  assert.equal(after.turnRunningOpen, true, 'a question that owns the turn is not an idle turn, so the thinking status stays up')
  assert.equal(after.agentRunning, true, 'and the run status stays with it')
  assert.equal(after.turnRunningTimer, null, 'the timer is cleared, not left dangling')
})

// ------------------------------------------------------------------ M17 the echo

test('M17 an older message with the same text never retires a fresh echo', () => {
  const sandbox = buildSandbox()
  // Sent from an empty buffer: the watermark is -1, so every earlier turn looks
  // like a candidate. Repeating "继续" is the case that hit this daily.
  sandbox.setStream([userEvent(2, '继续'), chunkEvent(3, 1, 1, '回答一'), userEvent(4, '继续')])
  sandbox.setOptimistic([{ id: 'o1', text: '继续', summary: '', afterSeq: -1 }])
  const rendered = sandbox.render()
  assert.equal(rendered.filter((message) => message.optimistic).length, 1, 'the echo is still on screen')
})

test('M17 two same-text candidates cannot single out the echo either', () => {
  const sandbox = buildSandbox()
  sandbox.setStream([userEvent(2, '继续'), userEvent(3, '继续')])
  sandbox.setOptimistic([{ id: 'o1', text: '继续', summary: '', afterSeq: -1 }])
  assert.equal(sandbox.render().filter((message) => message.optimistic).length, 1, 'the AC-M17 shape verbatim')
})

test('M17 an ambiguous candidate set above a real watermark keeps the echo too', () => {
  const sandbox = buildSandbox()
  sandbox.setStream([userEvent(1, '第一条'), userEvent(5, '继续'), userEvent(6, '继续')])
  sandbox.setOptimistic([{ id: 'o1', text: '继续', summary: '', afterSeq: 1 }])
  assert.equal(sandbox.render().filter((message) => message.optimistic).length, 1, 'two copies after the watermark is not proof of one')
})

test('M17 the first message of a session still retires on its durable copy', () => {
  const sandbox = buildSandbox()
  // The watermark here is -1 because the buffer was empty at send time — which is
  // also true for the very first prompt of a brand new chat. Retiring nothing in
  // that case would leave every new conversation showing its first message twice,
  // so the send records how many copies of that text were already on screen.
  sandbox.setStream([userEvent(0, '你好'), chunkEvent(1, 1, 1, '回答')])
  sandbox.setOptimistic([{ id: 'o1', text: '你好', summary: '', afterSeq: -1, sameTextAtSend: 0 }])
  const rendered = sandbox.render()
  assert.equal(rendered.filter((message) => message.optimistic).length, 0, 'the durable copy replaces the echo')
  assert.deepEqual(rendered.map((message) => message.blocks.map((block) => block.text).join('|')), ['你好', '回答'])
})

test('M17 the watermark advances, so a kept echo still retires when its copy lands', () => {
  const sandbox = buildSandbox()
  // Paint one: the reveal brings two older copies of the same text and no copy of
  // this send. The echo must survive that.
  sandbox.setStream([userEvent(2, '继续'), userEvent(4, '继续')])
  sandbox.setOptimistic([{ id: 'o1', text: '继续', summary: '', afterSeq: -1 }])
  assert.equal(sandbox.render().filter((message) => message.optimistic).length, 1, 'nothing newer than the watermark yet')
  // Paint two: the host appends this send's own durable copy, newer than anything
  // the phone has seen. Without an advancing watermark the echo would sit there as
  // a duplicate bubble for the rest of the visit — measured on the real page.
  sandbox.setStream([userEvent(2, '继续'), userEvent(4, '继续'), userEvent(11, '继续')])
  const second = sandbox.render()
  assert.equal(second.filter((message) => message.optimistic).length, 0, 'the strictly newer copy retires it')
  assert.deepEqual(
    second.map((message) => message.blocks.map((block) => block.text).join('|')),
    ['继续', '继续', '继续'],
  )
})

test('M17 the send records what retirement needs', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const send = betweenA3('async function send()', 'function formatBytes(n)', js)
  assert.ok(send.includes('sameTextAtSend=currentTranscript().reduce('), 'the same-text count is taken at send time')
  assert.ok(send.includes('sameTextAtSend,afterSeq}'), 'and travels with the echo')
  const echo = betweenA3('function messagesWithOptimistic(durable)', 'function latestEventSeq()', js)
  assert.ok(echo.includes('return!(matches===1&&(floor>=0||item.sameTextAtSend===0))'), 'retirement is the narrow rule, not the first match')
  assert.ok(echo.includes('const floor=item.afterSeq'), 'the gate reads the watermark as it was before this paint')
  assert.ok(echo.includes('item.afterSeq=newest'), 'and the watermark then moves up to what the phone has seen')
  assert.ok(!echo.includes('!durable.some('), 'and the "any match wins" filter is gone')
})

// ----------------------------------------------------- K-3 / J-1 the older window

function buildPullSandbox(opts) {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const source = 'async ' + extractFunction(js, 'loadOlder')
  return new Function('opts', `
    let olderRunBusy=false,olderHasMore=${String(opts.olderHasMore ?? false)},activeSession='s1'
    let streamEvents=[],olderEvents=[]
    const calls=[]
    function transcriptHasContent(){return Boolean(streamEvents.length||olderEvents.length)}
    function windowEvents(){return []}
    function olderUserCount(){return 0}
    function renderOlderButton(){calls.push('row');if(opts.throwOnRow)throw new Error('the older row cannot be drawn')}
    async function fetchOlderPage(){calls.push('page');return opts.pageReturnsTrue===true}
    async function ensureTranscriptFilled(){calls.push('fill')}
    function showError(){calls.push('error')}
    ${source}
    return { run: loadOlder, calls, state: () => ({ olderRunBusy }) }
  `)(opts)
}

function buildPageFetchSandbox(opts) {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const source = 'async ' + extractFunction(js, 'fetchOlderPage')
  return new Function('opts', `
    let olderBusy=false,olderHasMore=${String(opts.olderHasMore ?? false)},olderExhausted=false,activeSession='s1'
    let streamEvents=[],olderEvents=[]
    const calls=[],rpcCalls=[]
    const box={scrollHeight:120,clientHeight:80,scrollTop:0,insertAdjacentHTML(){},querySelector(){return null}}
    const $=()=>box
    function transcriptHasContent(){return Boolean(streamEvents.length||olderEvents.length)}
    function oldestEventSeq(){return -1}
    function renderOlderButton(){calls.push('row');if(opts.throwOnRow)throw new Error('the older row cannot be drawn')}
    function windowEvents(){return []}
    function mergeEntries(list){return list}
    function visibleMessages(){return []}
    function messagesWithOptimistic(list){return list}
    function paintMessages(){}
    function showError(){calls.push('error')}
    async function rpc(method,payload){rpcCalls.push({method,payload});return {events:[],hasMore:false}}
    ${source}
    return { run: fetchOlderPage, calls, rpcCalls, state: () => ({ olderBusy, olderHasMore, olderExhausted }) }
  `)(opts)
}

function buildRowSandbox(state) {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const body = ['olderButtonHtml', 'transcriptHasContent'].map((name) => extractFunction(js, name)).join('\n')
  return new Function('L', `
    const esc=v=>String(v==null?'':v)
    let activeSession='s1',olderHasMore=${String(state.olderHasMore ?? false)},olderBusy=false,olderRunBusy=false
    let streamEvents=${JSON.stringify(state.streamEvents ?? [])},olderEvents=${JSON.stringify(state.olderEvents ?? [])}
    ${body}
    return olderButtonHtml
  `)(pageLabels('zh'))
}

test('K-3 a broken older row still releases the pull lock, and the page lock with it', async () => {
  const pull = buildPullSandbox({ throwOnRow: true })
  await assert.rejects(() => pull.run(), 'the failure still reaches the caller')
  assert.equal(pull.state().olderRunBusy, false, 'but the lock is not left pinned — that disabled every later pull for the visit')
  assert.deepEqual(pull.calls, ['row', 'fill', 'row', 'error'], 'released, refilled, then reported')

  const page = buildPageFetchSandbox({ throwOnRow: true, olderHasMore: true })
  assert.equal(await page.run(), false, 'its own catch reports the failure')
  assert.equal(page.state().olderBusy, false, 'so the row cannot stay stuck in its busy shape')
})

test('K-3 both locks are taken inside the try, so a throw before the first await cannot strand them', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const pull = betweenA3('async function loadOlder()', 'function syncTurnStatus()', js)
  assert.ok(pull.indexOf('olderRunBusy=true') > pull.indexOf('try{'), 'the lock is acquired after the try opens')
  assert.ok(pull.indexOf('olderRunBusy=false') < pull.indexOf('renderOlderButton()', pull.indexOf('olderRunBusy=false')), 'and released before the row is refreshed')
  assert.ok(pull.includes('olderRunBusy=false;void ensureTranscriptFilled();try{renderOlderButton()}'), 'the release comes first, then anything that can still throw')
  assert.ok(pull.indexOf('olderRunBusy=false') > pull.indexOf('finally{'), 'and it is the finally that does it, not the happy path')
  const page = betweenA3('async function fetchOlderPage()', 'async function loadOlder()', js)
  assert.ok(page.indexOf('olderBusy=true') > page.indexOf('try{'), 'same for the single-page pull')
  assert.ok(page.includes('finally{olderBusy=false;try{renderOlderButton()}catch'), 'and its refresh cannot outlive the release')
})

test('J-1 with nothing painted, all three ways to reach older messages get a page', async () => {
  // The button, the automatic fill and the drag gesture all funnel into these two
  // functions, whose first line still demanded olderHasMore — so an empty
  // transcript could enter every path and fetch nothing.
  const page = buildPageFetchSandbox({ olderHasMore: false })
  assert.equal(await page.run(), true, 'the pull runs and reports a page')
  assert.deepEqual(page.rpcCalls, [{ method: 'session.history', payload: { sessionId: 's1', maxMessages: 30 } }], 'the head page, with no beforeSeq')

  const pull = buildPullSandbox({ olderHasMore: false })
  assert.equal(await pull.run(), false, 'no earlier user message came in, so the multi-page pull stops')
  assert.ok(pull.calls.includes('page'), 'but it did reach the page fetch')

  const html = buildRowSandbox({ olderHasMore: false })()
  assert.match(html, /data-older="1"/, 'the row is there')
  assert.ok(!html.includes('disabled'), 'and it is tappable while nothing is painted')
  assert.ok(html.includes(pageLabels('zh').olderMore), 'promising more messages, not the start of the conversation')

  const js = mobilePageAssets({ locale: 'zh' }).js
  const gesture = betweenA3("box.addEventListener('touchstart'", "box.addEventListener('touchmove'", js)
  assert.ok(gesture.includes('if(!olderHasMore&&!olderEvents.length&&transcriptHasContent())return'), 'the drag opens on the same condition as the row')
})

test('J-1 an exhausted conversation with pages already pulled goes back to being inert', () => {
  const html = buildRowSandbox({ olderHasMore: false, streamEvents: [{ event: { seq: 4 } }], olderEvents: [{ event: { seq: 1 } }] })()
  assert.ok(html.includes('disabled'), 'nothing older is left to ask for')
  assert.ok(html.includes(pageLabels('zh').olderStart), 'and the row says so')
})

test('J-1 every layer of the pull agrees on the same emptiness test', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const gates = [
    ['the row hides only over real content', 'if(!olderHasMore&&!olderEvents.length&&transcriptHasContent())return'],
    ['the fill loop obeys it', 'if(!olderHasMore&&transcriptHasContent())return'],
    ['the page fetch obeys it', 'if(olderBusy||!activeSession||(!olderHasMore&&transcriptHasContent()))return false'],
    ['the multi-page pull obeys it', 'if(olderRunBusy||!activeSession||(!olderHasMore&&transcriptHasContent()))return false'],
  ]
  for (const [why, gate] of gates) assert.ok(js.includes(gate), `${why}: ${gate}`)
  assert.equal(js.split('if(!olderHasMore&&!olderEvents.length&&transcriptHasContent())return').length - 1, 2, 'the row and the drag gesture share one condition')
  assert.ok(!js.includes('while(activeSession&&olderHasMore&&pages<8'), 'the pull loop no longer demands olderHasMore alone')
  assert.ok(!js.includes('if(olderBusy||!activeSession||!olderHasMore)return false'), 'the silent veto is gone from the page fetch')
  assert.ok(!js.includes('if(olderRunBusy||!activeSession||!olderHasMore)return false'), 'and from the multi-page pull')
})
