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
