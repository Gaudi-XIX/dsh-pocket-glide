// The phone downloads raw harness records. Three fields in them are provably
// unread by any client code, and together they were ~70% of a real 200-record
// page (785 KB measured on a production session). Dropping them must not touch
// anything the renderer reads.
import test from 'node:test'
import assert from 'node:assert/strict'
import { compactSessionRecords, compactSessionFrame, stripRecordsThrough, compactSessionRows } from '../lib/bridge.js'

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

// ---------------------------------------------------------------------------
// Session-list rows: a row carries the session's whole turn history inside
// projections.values. The phone downloaded ~1 MB of that on every pairing
// (2026-10-01: the document it embedded was 878 KB).
// ---------------------------------------------------------------------------

const fatRow = {
  sessionId: 's1',
  workspaceId: 'w1',
  updatedAt: 1790820000000,
  blank: false,
  missingSummary: false,
  running: true,
  awaitingQuestion: false,
  agentPreset: 'standard',
  status: 'ok',
  subagentCatalog: [{ mode: 'one-shot', label: 'x'.repeat(120), id: 'abc' }],
  projections: {
    asOfSeq: 1548,
    values: {
      title: '清理外部插件',
      todos: [{ id: 't1', text: 'a', done: true }],
      modelSelection: { provider: 'p', model: 'm' },
      history: Array.from({ length: 40 }, (_, i) => ({ turn: i, prompt: 'p'.repeat(300), response: 'r'.repeat(600) })),
      longNote: 'n'.repeat(5000)
    }
  }
}

test('a session row keeps what the phone renders and drops the history blob', () => {
  const [row] = compactSessionRows([fatRow])

  // Everything the list, the focus picker and the settings panel read.
  assert.equal(row.sessionId, 's1')
  assert.equal(row.workspaceId, 'w1')
  assert.equal(row.updatedAt, 1790820000000)
  assert.equal(row.blank, false)
  assert.equal(row.missingSummary, false)
  assert.equal(row.running, true)
  assert.equal(row.awaitingQuestion, false)
  assert.equal(row.agentPreset, 'standard')
  assert.equal(row.status, 'ok')
  assert.equal(row.projections.asOfSeq, 1548)
  assert.equal(row.projections.values.title, '清理外部插件')
  assert.deepEqual(row.projections.values.todos, [{ id: 't1', text: 'a', done: true }])
  assert.deepEqual(row.projections.values.modelSelection, { provider: 'p', model: 'm' })

  // The bulk is gone.
  assert.equal(row.projections.values.history, undefined)
  assert.equal(row.projections.values.longNote, undefined)
  assert.equal(row.subagentCatalog, undefined)
  assert(Buffer.byteLength(JSON.stringify([row])) < 1024, 'a row must fit in a kilobyte')
})

test('the projection never mutates the list it was given', () => {
  compactSessionRows([fatRow])

  assert.equal(fatRow.projections.values.history.length, 40)
  assert.equal(fatRow.subagentCatalog.length, 1)
})

test('rows without projections and non-row values survive', () => {
  const rows = compactSessionRows([{ sessionId: 'x', updatedAt: 1 }, null, 'nope'])

  assert.deepEqual(rows[0], { sessionId: 'x', updatedAt: 1 })
  assert.equal(rows[1], null)
  assert.equal(rows[2], 'nope')
  assert.equal(compactSessionRows(undefined), undefined)
})
