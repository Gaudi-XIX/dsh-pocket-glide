// Interleaved transcript arrangement (change 2026-10-08-feat-pocket-subagent-status-visibility):
// the desktop renders a turn as 过程 → 回复 → 过程 → 回复 → …, cutting on the first
// reply-content block of each step (non-empty text / image / file, reasoning and
// tool calls never cut). The old pocket grouping emitted the whole round's process
// first and stacked every text bubble after it, discarding arrival order.
//
// WHITE-BOX: run the page's own visibleMessages against synthetic frames, the same
// way transcript-order.test.js does. These tests are the mutation proof: reverting
// the single-pass flush back to the round-level grouping fails INTERLEAVE-1 (order)
// and INTERLEAVE-4 (segments), not just a string anchor.
//
// MERGE-* at the bottom is the second half of the same contract (user decision
// 2026-10-10, plan A): a step's LEADING reasoning no longer emits as its own item —
// it heads the reply it produced, inside that message.
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

function buildSandbox() {
  const { js } = mobilePageAssets({ locale: 'zh' })
  const names = ['eventSeq', 'contentBlocks', 'stepKey', 'visibleMessages']
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  return new Function(
    `${body}
     return { visibleMessages }`,
  )()
}

function userEvent(seq, text) {
  return {
    event: { seq, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } },
  }
}

function textChunk(seq, turn, step, text) {
  return { event: { seq, type: 'assistant/chunk', data: { turn, step, chunk: { type: 'text-delta', index: 0, text } } } }
}

function toolCall(seq, turn, step, callId, name) {
  return { event: { seq, type: 'tool/call', data: { turn, step, callId, name, arguments: { q: name } } } }
}

function toolResult(seq, turn, step, callId) {
  return {
    event: { seq, type: 'tool/result', data: { turn, step, message: { content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }] } } },
  }
}

function turnEnd(seq, turn) {
  return { event: { seq, type: 'turn/end', data: { turn } } }
}

function shape(rendered) {
  return rendered.map((message) => {
    if (message.role !== 'assistant') return message.role
    if (message.turnProcess) return `process${message.segment === undefined ? '' : '#' + message.segment}`
    return 'reply:' + message.blocks.map((block) => block.text || block.kind).join('|')
  })
}

test('INTERLEAVE-1 segments alternate with replies in arrival order', () => {
  const sandbox = buildSandbox()
  const events = [
    userEvent(1, '跑两步'),
    toolCall(2, 1, 1, 'c1', 'read_file'),
    toolResult(3, 1, 1, 'c1'),
    textChunk(4, 1, 1, '第一步完成'),
    toolCall(5, 1, 2, 'c2', 'edit_file'),
    toolResult(6, 1, 2, 'c2'),
    textChunk(7, 1, 2, '第二步也完成'),
    turnEnd(8, 1),
  ]
  const out = sandbox.visibleMessages(events)
  assert.deepEqual(
    shape(out),
    ['user', 'process#0', 'reply:第一步完成', 'process#1', 'reply:第二步也完成'],
    'each reply cuts the process group; the next tool call opens a new segment',
  )
})

test('INTERLEAVE-2 a text block inside a tool step still cuts before the next tool', () => {
  // Same step produces text then a tool call (streaming order): the reply is the
  // text, and the tool after it must open the NEXT group, not ride before the text.
  const sandbox = buildSandbox()
  const events = [
    userEvent(1, '问'),
    textChunk(2, 1, 1, '先说结论'),
    toolCall(3, 1, 1, 'c1', 'read_file'),
    turnEnd(4, 1),
  ]
  const out = sandbox.visibleMessages(events)
  assert.deepEqual(shape(out), ['user', 'reply:先说结论', 'process#0'], 'arrival order survives the same-node case')
})

test('INTERLEAVE-3 a reasoning-only turn renders one process group and no reply', () => {
  const sandbox = buildSandbox()
  const events = [
    userEvent(1, '问'),
    toolCall(2, 1, 1, 'c1', 'read_file'),
    turnEnd(3, 1),
  ]
  const out = sandbox.visibleMessages(events)
  assert.deepEqual(shape(out), ['user', 'process#0'], 'no reply block ever appears')
  assert.equal(out[1].messageTime, undefined, 'no reply, no clock')
  assert.equal(out[1].usage, undefined, 'no reply, no pill')
})

test('INTERLEAVE-4 the pill and the clock still ride only the final reply of the turn', () => {
  const sandbox = buildSandbox()
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
  const events = [
    userEvent(1, '问'),
    toolCall(2, 1, 1, 'c1', 'read_file'),
    textChunk(3, 1, 1, '中间回复'),
    toolCall(4, 1, 2, 'c2', 'edit_file'),
    { event: { seq: 5, time: 1730000000000, type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '最终回复' }] }, usage } } },
    turnEnd(6, 1),
  ]
  const out = sandbox.visibleMessages(events)
  const billed = out.filter((message) => message.usage !== undefined)
  assert.equal(billed.length, 1, 'exactly one bubble carries the pill')
  assert.equal(billed[0].blocks[0].text, '最终回复', 'and it is the final reply, not the first')
  assert.ok(billed[0].messageTime, 'the clock rides the same bubble')
})

test('INTERLEAVE-5 a reply-cut segment is history; only the open tail group stays live', () => {
  const sandbox = buildSandbox()
  const events = [
    userEvent(1, '问'),
    toolCall(2, 1, 1, 'c1', 'read_file'),
    textChunk(3, 1, 1, '说到一半'),
    toolCall(4, 1, 2, 'c2', 'edit_file'),
  ]
  const out = sandbox.visibleMessages(events)
  assert.deepEqual(shape(out).slice(1), ['process#0', 'reply:说到一半', 'process#1'], 'cut group, streaming reply, accumulating tail')
  assert.equal(out[1].streaming, false, 'a segment the reply already cut is folded even while the turn is open')
  assert.equal(out[2].streaming, true, 'the open reply keeps its streaming flag')
  assert.equal(out[3].streaming === undefined || out[3].streaming === true, true, 'the tail group after the reply is the live one')
  assert.equal(out[3].segment, 1, 'the tail is a new segment')
})

test('INTERLEAVE-6 a closed turn renders every segment collapsed', () => {
  const sandbox = buildSandbox()
  const events = [
    userEvent(1, '问'),
    toolCall(2, 1, 1, 'c1', 'read_file'),
    textChunk(3, 1, 1, '回复'),
    toolCall(4, 1, 2, 'c2', 'edit_file'),
    turnEnd(5, 1),
  ]
  const out = sandbox.visibleMessages(events)
  assert.deepEqual(shape(out), ['user', 'process#0', 'reply:回复', 'process#1'], 'trailing tool-only segment survives turn/end')
  assert.equal(out[1].streaming, false, 'flushed segment is collapsed')
  assert.equal(out[3].streaming, false, 'and so is the tail once the turn closes')
})

// ---------------------------------------------------------------------------
// MERGE (user decision 2026-10-10, plan A over a spacing-only patch). The Host ships
// a step as [reasoning, text, tool-call] — counted on two live local sessions, 97 and 6
// records of that shape at 2026-10-10 16:4x — and feeding those records through the
// shipped renderer emitted `[text] [reasoning] [text]`: the fold sat under the reply
// ABOVE it, which is the report. So one step's leading reasoning now heads its own reply.
// ---------------------------------------------------------------------------

const think = (text) => ({ type: 'reasoning', text })
const say = (text) => ({ type: 'text', text })

function stepMessage(seq, turn, step, content) {
  return { event: { seq, type: 'assistant/message', data: { turn, step, message: { content } } } }
}

test('MERGE-1 a reasoning+text step is ONE message with the thought as its head', () => {
  const sandbox = buildSandbox()
  const out = sandbox.visibleMessages([
    userEvent(1, '问'),
    stepMessage(2, 1, 1, [think('先想一层'), say('第一段答复')]),
    stepMessage(3, 1, 2, [think('再想一层'), say('第二段答复')]),
    turnEnd(4, 1),
  ])
  assert.deepEqual(
    shape(out),
    ['user', 'reply:先想一层|第一段答复', 'reply:再想一层|第二段答复'],
    'the shape this replaced was reply / reasoning-item / reply / reasoning-item — no orphan item between answers',
  )
  assert.deepEqual(out[1].blocks.map((b) => b.kind), ['reasoning', 'text'], 'one message, thought first')
  assert.ok(out[1].openKey, 'and the fold still owns an open-state key')
  assert.notEqual(out[1].openKey, out[2].openKey, 'two merged replies do not share one fold key')
})

test('MERGE-2 thought with no reply of its own still rides the process card', () => {
  // The fallback must not change: a thinking-only stretch joins the accumulated group.
  // It is emitted as an assistant/message with NO step (stepKey then misses the tool
  // call's `1:1` key and opens a fresh node), which is how the record leg actually
  // reaches the page — with a step it would merge, and MERGE-1 already covers that.
  const sandbox = buildSandbox()
  const out = sandbox.visibleMessages([
    userEvent(1, '问'),
    toolCall(2, 1, 1, 'c1', 'read_file'),
    stepMessage(3, 1, undefined, [think('边看边想')]),
    textChunk(4, 1, 2, '查完了'),
    turnEnd(5, 1),
  ])
  assert.deepEqual(shape(out).slice(1), ['process#0', 'reply:查完了'], 'the thought folded into the card, the reply stands alone')
  assert.ok(out[1].blocks.some((b) => b.kind === 'reasoning'), 'and nothing was dropped to make the shape pretty')
})

test('MERGE-3 reasoning that FOLLOWS its own reply is not dragged above it', () => {
  // Arrival order is honoured: only reasoning that LEADS the step attaches. A model
  // that keeps thinking after answering really did think later, so it stays below —
  // this is the one shape the merge deliberately leaves alone.
  const sandbox = buildSandbox()
  const out = sandbox.visibleMessages([
    userEvent(1, '问'),
    stepMessage(2, 1, 1, [say('答复在此'), think('答完还在想')]),
    turnEnd(3, 1),
  ])
  assert.deepEqual(shape(out), ['user', 'reply:答复在此', 'reply:答完还在想'], 'the reply first, the later thought after it')
  assert.deepEqual(out[1].blocks.map((b) => b.kind), ['text'], 'the reply did not swallow the later thought')
})

test('MERGE-4 a tool that follows its own narration still opens the next segment', () => {
  // [reasoning, text, tool-call] — the shape the Host actually ships.
  const sandbox = buildSandbox()
  const out = sandbox.visibleMessages([
    userEvent(1, '问'),
    stepMessage(2, 1, 1, [think('想一想'), say('我这就去查'), ]),
    toolCall(3, 1, 1, 'c1', 'grep'),
    toolResult(4, 1, 1, 'c1'),
    stepMessage(5, 1, 2, [think('又一想'), say('查到了')]),
    turnEnd(6, 1),
  ])
  assert.deepEqual(
    shape(out),
    ['user', 'reply:想一想|我这就去查', 'process#0', 'reply:又一想|查到了'],
    'thought+narration in one message, then the tool segment, then the next merged reply',
  )
})
