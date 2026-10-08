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
