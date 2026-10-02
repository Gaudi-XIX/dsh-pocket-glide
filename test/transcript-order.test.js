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
  assert.ok(html.includes('box.innerHTML=olderButtonHtml()+messages.map(renderMessage).join(\'\')+status'))
  assert.ok(html.includes('function renderOlderButton()'), 'the row must be re-synced without a full repaint')
})

test('short transcripts keep pulling older pages until the viewport is filled', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  assert.ok(js.includes('async function ensureTranscriptFilled()'))
  assert.ok(js.includes('if(!olderHasMore||box.scrollHeight>box.clientHeight+8)return'), 'fill only while short')
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
  assert.ok(js.includes("if(!$('messages').querySelector('.loading'))return"), 'the watchdog stops once content paints')
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
