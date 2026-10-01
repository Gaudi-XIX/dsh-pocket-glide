// The phone downloads raw harness records. Three fields in them are provably
// unread by any client code, and together they were ~70% of a real 200-record
// page (785 KB measured on a production session). Dropping them must not touch
// anything the renderer reads.
import test from 'node:test'
import assert from 'node:assert/strict'
import { compactSessionRecords, compactSessionFrame, stripRecordsThrough } from '../lib/bridge.js'

const assistantMessage = {
  type: 'assistant/message',
  seq: 10,
  time: 1,
  data: {
    step: 2,
    turn: 1,
    stream: [{ type: 'reasoning-chunks', dt: [1, 2, 3] }],
    usage: { inputTokens: 5 },
    message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'edit', arguments: '{}' }] }
  }
}
const toolResult = {
  type: 'tool/result',
  seq: 11,
  data: { step: 2, turn: 1, meta: { shape: 'matches', files: [{ path: 'a.js' }] }, message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] } }
}
const requestHeader = { type: 'request/header', seq: 12, data: { header: { tools: [{ name: 'edit' }] }, reason: 'first' } }

test('the projection drops only the fields no client code reads', () => {
  const raw = [assistantMessage, toolResult, requestHeader]
  const compact = compactSessionRecords(raw)

  assert.equal('stream' in compact[0].data, false)
  assert.equal('meta' in compact[1].data, false)
  assert.equal('header' in compact[2].data, false)

  // Everything the renderer touches survives untouched.
  assert.deepEqual(compact[0].data.message, assistantMessage.data.message)
  assert.deepEqual(compact[0].data.step, 2)
  assert.deepEqual(compact[1].data.message, toolResult.data.message)
  assert.deepEqual(compact[2].data.reason, 'first')
  assert.equal(compact[0].seq, 10)
  assert.equal(compact[1].type, 'tool/result')

  // Usage is small and not worth the risk of removing.
  assert.deepEqual(compact[0].data.usage, { inputTokens: 5 })

  // The input is never mutated: the same records go to the desktop path.
  assert.deepEqual(raw[0].data.stream, [{ type: 'reasoning-chunks', dt: [1, 2, 3] }])
  assert.deepEqual(raw[1].data.meta.files, [{ path: 'a.js' }])
  assert.deepEqual(raw[2].data.header.tools, [{ name: 'edit' }])
})

test('the projection also reaches records wrapped in an event envelope', () => {
  const compact = compactSessionRecords([{ type: 'event', event: assistantMessage }])

  assert.equal('stream' in compact[0].event.data, false)
  assert.deepEqual(compact[0].event.data.message, assistantMessage.data.message)
})

test('the projection leaves non-record values alone', () => {
  assert.deepEqual(compactSessionRecords([null, 'x', 3]), [null, 'x', 3])
  assert.equal(compactSessionRecords(undefined), undefined)
})

test('a snapshot frame carries the same projection', () => {
  const compact = compactSessionFrame({ type: 'snapshot', records: [assistantMessage], projections: {}, hasMore: false })

  assert.equal('stream' in compact.records[0].data, false)
  assert.deepEqual(compact.projections, {})
  assert.equal(compact.hasMore, false)
})

test('records the phone already has are dropped from the opening snapshot', () => {
  const frame = { type: 'snapshot', records: [{ seq: 1 }, { seq: 5 }, { seq: 9 }] }
  const filtered = stripRecordsThrough(frame, 5)

  assert.deepEqual(filtered.records, [{ seq: 9 }])
})

test('a fully covered snapshot is still sent, empty, so the phone knows the stream is live', () => {
  const frame = { type: 'snapshot', records: [{ seq: 1 }, { seq: 2 }] }
  const filtered = stripRecordsThrough(frame, 5)

  assert.deepEqual(filtered.records, [])
  assert.equal(filtered.type, 'snapshot')
})

test('a durable event the phone already has is dropped entirely', () => {
  assert.equal(stripRecordsThrough({ type: 'assistant/chunk', seq: 4, data: 'x' }, 5), null)
  assert.deepEqual(stripRecordsThrough({ type: 'assistant/chunk', seq: 6, data: 'x' }, 5), { type: 'assistant/chunk', seq: 6, data: 'x' })
})

test('no sinceSeq means the full page, as before', () => {
  const frame = { type: 'snapshot', records: [{ seq: 1 }, { seq: 2 }] }

  assert.equal(stripRecordsThrough(frame, -1), frame)
})
