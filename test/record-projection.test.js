// The phone downloads raw harness records. Three fields in them are provably
// unread by any client code, and together they were ~70% of a real 200-record
// page (785 KB measured on a production session). Dropping them must not touch
// anything the renderer reads.
import test from 'node:test'
import assert from 'node:assert/strict'
import { compactSessionRecords, compactSessionFrame, stripRecordsThrough, compactSessionRows } from '../lib/bridge.js'
import { SESSION_ROW_ARRAY_MAX, SESSION_ROW_TEXT_LIMIT } from '../lib/projections.js'

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

// 2026-10-02 audit, P0-A (WP-A1 / A-4): a single durable event is NEVER swallowed
// by the watermark any more. seq is a per-session log offset on the host, so the
// seq the phone reports can belong to a different conversation entirely; dropping
// `turn/end` over that is far more expensive than repeating one frame, which the
// page already dedupes by seq. Only the arrays are filtered.
test('a durable event is passed through even at or below the watermark', () => {
  assert.deepEqual(stripRecordsThrough({ type: 'turn/end', seq: 4, data: {} }, 5), { type: 'turn/end', seq: 4, data: {} })
  assert.deepEqual(stripRecordsThrough({ type: 'assistant/chunk', seq: 6, data: 'x' }, 5), { type: 'assistant/chunk', seq: 6, data: 'x' })
})

// F-2 (2026-10-07-fix-pocket-contract-minis): the other side of the :183-187
// invariant — an entry WITHOUT a seq is treated as durable too. seqOf answers
// Infinity (not -1) for a missing seq, so `> sinceSeq` always holds and the
// entry survives every watermark. The old -1 answer let sinceSeq >= 0 silently
// swallow exactly those entries.
test('records arm: a mix of seq-bearing and seq-less entries keeps exactly the seq-less ones', () => {
  const filtered = stripRecordsThrough(
    {
      type: 'snapshot',
      records: [
        { seq: 1 },
        { seq: 2 },
        { event: { type: 'turn/end', data: {} } },
        { type: 'assistant/message' },
      ],
    },
    5
  )
  assert.deepEqual(
    filtered.records,
    [{ event: { type: 'turn/end', data: {} } }, { type: 'assistant/message' }],
    'the two seq-bearing entries are watermarked out, the two seq-less ones survive'
  )
})

test('events arm: a seq-less event survives the watermark too', () => {
  const filtered = stripRecordsThrough({ type: 'snapshot', events: [{ seq: 9 }, { foo: 'no-seq' }] }, 5)
  assert.deepEqual(filtered.events, [{ seq: 9 }, { foo: 'no-seq' }])
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

// ---------------------------------------------------------------------------
// RC-3 (2026-10-02 rescan): the allowlist named `todos` and `modelSelection` by
// intent, not by size, and `compactRowValues` `continue`d past the string cap
// for them — so an arbitrarily large array/object went to the phone whole, by
// reference. The cap must bite without changing the shape `lib/pages.js` reads:
// `updateTodos` needs an array of `{content: string, status: pending|in_progress|completed}`
// and `modelSelectionOf` needs `next.{provider,model}`.
// ---------------------------------------------------------------------------

test('RC-3: an oversized todos array is paged and its items keep content/status', () => {
  const todos = Array.from({ length: 3000 }, (_, i) => ({ content: `task ${i}`, status: 'pending', extra: 'x'.repeat(400) }))
  const [row] = compactSessionRows([{ ...fatRow, projections: { ...fatRow.projections, values: { ...fatRow.projections.values, todos } } }])
  const kept = row.projections.values.todos

  assert.ok(Array.isArray(kept), 'the shape stays an array')
  assert.equal(kept.length, SESSION_ROW_ARRAY_MAX, 'the array is cut to the page size')
  assert.ok(kept.length < todos.length, 'and it is smaller than what came in')
  assert.notEqual(kept, todos, 'no longer handed over by reference')
  assert.deepEqual(
    kept.map((item) => item.status),
    Array.from({ length: SESSION_ROW_ARRAY_MAX }, () => 'pending'),
    'every kept item still carries the status the dock counts'
  )
  assert.ok(kept.every((item) => typeof item.content === 'string' && item.content.length > 0), 'and the content the dock prints')
  // The phone's own filter (updateTodos) must still accept every item.
  assert.equal(
    kept.filter((item) => item && typeof item.content === 'string' && ['pending', 'in_progress', 'completed'].includes(item.status)).length,
    kept.length
  )
  assert.equal(todos.length, 3000, 'the list it was given is never mutated')
})

test('RC-3: modelSelection keeps next.{provider,model} and caps the rest', () => {
  const modelSelection = { next: { provider: 'p'.repeat(2000), model: 'm', reasoningEffort: 'high' }, catalogue: { deep: 'z'.repeat(50_000) } }
  const [row] = compactSessionRows([{ ...fatRow, projections: { ...fatRow.projections, values: { ...fatRow.projections.values, modelSelection } } }])
  const kept = row.projections.values.modelSelection

  assert.equal(kept.next.model, 'm', 'normalizeSelection reads the model')
  assert.equal(kept.next.provider.length, SESSION_ROW_TEXT_LIMIT, 'a long provider is capped, not dropped')
  assert.ok(kept.next.provider.length > 0, 'so the selection is still usable')
  assert.equal(kept.next.reasoningEffort, 'high', 'the effort survives')
  assert.ok(Buffer.byteLength(JSON.stringify(kept)) <= 1024, `the whole selection stays inside the byte budget, got ${Buffer.byteLength(JSON.stringify(kept))}`)
  assert.equal(modelSelection.next.provider.length, 2000, 'the value it was given is never mutated')
})

test('RC-3: a normal-sized row is byte-identical to what it was before the cap', () => {
  const values = { title: 'ab', todos: [{ content: 'a', status: 'completed' }], modelSelection: { next: { provider: 'p', model: 'm' } } }
  const [row] = compactSessionRows([{ sessionId: 's2', projections: { values } }])

  assert.deepEqual(row.projections.values, {
    title: 'ab',
    todos: [{ content: 'a', status: 'completed' }],
    modelSelection: { next: { provider: 'p', model: 'm' } }
  })
})

test('RC-3: a bounded row is orders of magnitude smaller than the raw one', () => {
  const raw = {
    sessionId: 's3',
    projections: {
      values: {
        todos: Array.from({ length: 3000 }, (_, i) => ({ content: `task ${i}`, status: 'pending' })),
        modelSelection: { next: { provider: 'p'.repeat(2000), model: 'm' } }
      }
    }
  }
  const [row] = compactSessionRows([raw])
  const ratio = JSON.stringify(row).length / JSON.stringify(raw).length

  assert.ok(ratio < 0.05, `a row this fat must collapse, got ratio ${ratio.toFixed(3)}`)
})

// 2026-10-02 audit, AC-D8: the host stamps every record with its own wall clock
// (`time`), and M6 now orders the transcript by seq instead of by that stamp. The
// stamp still has to survive the projection: neither a record's own `time` nor a
// `time` sitting on its `data` may be stripped, so a later edit to
// PHONE_RECORD_DROP_KEYS cannot silently take it away. The design called this the
// M6 premise guard; the first verify pass found it was the one acceptance item
// with no assertion behind it at all.
test('AC-D8: the projection never strips the host timestamp', () => {
  const frame = {
    type: 'snapshot',
    records: [{ type: 'turn/start', seq: 1, time: 123, data: { time: 456, turn: 1 } }],
    projections: {},
    hasMore: false
  }
  const compact = compactSessionFrame(frame)

  assert.equal(compact.records[0].time, 123, 'the record-level host stamp survives')
  assert.equal(compact.records[0].data.time, 456, 'and so does a data-level key the drop list must never name')
  assert.equal(compact.records[0].data.turn, 1, 'the projection still carries the turn the renderer reads')
  assert.deepEqual(frame.records[0].data, { time: 456, turn: 1 }, 'the frame it was handed is never mutated')
})
