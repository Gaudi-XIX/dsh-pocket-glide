// The tail window (2026-10-20 m01424④: 「不固定条数，以填满一个屏幕为准；最后一个
// 消息很长就全加载」). This replaces the fixed 8 records that used to ride in every
// preload pack. What must stay true:
//   1. the newest assistant reply is NEVER cut, however long it is — a fat answer
//      is exactly one screen, and truncating it would buy the bytes by destroying
//      the thing the preload exists to show;
//   2. the user prompt that produced that reply travels with it, so an answer read
//      on its own is not contextless;
//   3. the rest of the window is topped up backwards until one screen of text has
//      been reached, so a run of one-liners fills a screen instead of shipping a
//      fixed row count that fills nothing;
//   4. records are selected whole — the fit decides how many travel, never how
//      much of one travels.
// The budget is measured in laid-out columns (CJK = 2, everything else = 1) plus a
// per-record floor, because a tool row now ships a title alone and would otherwise
// read as free and stack thirty of them onto one "screen".
import test from 'node:test'
import assert from 'node:assert/strict'
import { fitTailToScreen } from '../lib/bridge.js'

const BUDGET = 1400

function record(seq, type, text) {
  const entry = { seq, type, data: {} }
  if (type === 'user/message') entry.data.message = { source: { kind: 'user' }, content: [{ type: 'text', text }] }
  else if (type === 'assistant/message') entry.data.message = { content: [{ type: 'text', text }] }
  else entry.data.message = { content: [{ type: 'tool-result', toolCallId: 'c' + seq, content: [] }] }
  return entry
}
const seqsOf = (window) => window.map((entry) => (entry && typeof entry === 'object' ? entry.seq : entry))

test('a conversation that already fits the screen is returned whole', () => {
  const page = [
    record(1, 'user/message', 'hi'),
    record(2, 'assistant/message', 'hello'),
    record(3, 'user/message', 'one more'),
    record(4, 'assistant/message', 'sure')
  ]
  assert.deepEqual(seqsOf(fitTailToScreen(page, BUDGET)), [1, 2, 3, 4], 'nothing to trim: the whole page is one screen')
})

test('the newest reply is kept whole even when it alone exceeds the budget', () => {
  const page = [
    record(1, 'user/message', 'summarise'),
    record(2, 'assistant/message', 'x'.repeat(BUDGET * 2))
  ]
  const window = fitTailToScreen(page, BUDGET)
  assert.deepEqual(seqsOf(window), [1, 2], 'the answer is never cut — not by characters, not by row count')
  assert.equal(window[1].data.message.content[0].text.length, BUDGET * 2, 'and it arrives untruncated')
})

test('a page with only the oversized answer ships just the answer', () => {
  const page = [record(1, 'assistant/message', 'y'.repeat(BUDGET * 3))]
  assert.deepEqual(seqsOf(fitTailToScreen(page, BUDGET)), [1])
})

test('one-liners are topped up until the screen is full, then older rows stop', () => {
  // 40 one-line turns ≈ 4 300 columns, about three screens.
  const page = []
  for (let seq = 1; seq <= 40; seq += 1) {
    page.push(record(seq, seq % 2 ? 'user/message' : 'assistant/message', 'a'.repeat(100)))
  }
  const window = fitTailToScreen(page, BUDGET)
  const used = seqsOf(window).reduce((total, seq) => total + 124, 0)

  assert.ok(used >= BUDGET, `the window fills at least one screen, used ${used} of ${BUDGET}`)
  assert.ok(used - 124 < BUDGET, 'and it stops one record later — no record beyond the screen')
  assert.deepEqual(
    seqsOf(window),
    [29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40],
    'the window is a suffix of the page, oldest first'
  )
})

test('records between the answer and its prompt are carried too', () => {
  // The turn reads: prompt → tool → answer. The tool must not be dropped out of
  // the middle, or the transcript would show an answer that came from nowhere.
  const page = [
    record(1, 'user/message', 'fix the file'),
    record(2, 'tool/result', ''),
    record(3, 'assistant/message', 'done')
  ]
  assert.deepEqual(seqsOf(fitTailToScreen(page, BUDGET)), [1, 2, 3])
})

test('a page with no assistant reply at all still answers with something', () => {
  const page = [
    record(1, 'user/message', 'still working on it'),
    record(2, 'tool/result', '')
  ]
  const window = fitTailToScreen(page, BUDGET)
  assert.deepEqual(seqsOf(window), [1, 2], 'the last thing that happened is the anchor when there is no reply')
})

test('the window is ordered by seq, and a seq-less row rides at the tail', () => {
  const seqless = { type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'no seq' }] } } }
  const page = [record(3, 'assistant/message', 'x'.repeat(BUDGET * 2)), seqless, record(1, 'user/message', 'go')]

  const window = fitTailToScreen(page, BUDGET)
  assert.deepEqual(seqsOf(window), [1, 3, undefined], 'the seq-less row cannot be ordered, so it rides last rather than shuffling in')
})

test('a tool row costs real screen, so a page of empty tool rows cannot fill one', () => {
  // A stripped tool row carries no prose, so a naive prose-only budget would read
  // it as free and pack dozens onto one screen. The per-record floor is what stops
  // that; the floor is asserted indirectly, through how many rows fit.
  const page = []
  for (let seq = 1; seq <= 200; seq += 1) page.push(record(seq, 'tool/result', ''))
  const window = fitTailToScreen(page, BUDGET)
  const rows = window.length

  assert.ok(rows < 60, `the floor keeps a page of empty rows under one screen, filled ${rows} rows`)
  assert.ok(rows * 24 >= BUDGET, 'and it still fills the screen — the floor is what pays for each row')
})

test('the input page is never mutated', () => {
  const page = [record(1, 'user/message', 'a'.repeat(300)), record(2, 'assistant/message', 'b'.repeat(BUDGET * 2))]
  const before = JSON.parse(JSON.stringify(page))

  fitTailToScreen(page, BUDGET)
  assert.deepEqual(page, before, 'the same records still go to the desktop path')
})

test('empty and junk input answer with an empty window', () => {
  assert.deepEqual(fitTailToScreen([], BUDGET), [])
  assert.deepEqual(fitTailToScreen(null, BUDGET), [])
  assert.deepEqual(fitTailToScreen(undefined, BUDGET), [])
  assert.deepEqual(fitTailToScreen('nope', BUDGET), [])
  assert.deepEqual(fitTailToScreen([null, 3, 'x'], BUDGET), [null, 3, 'x'], 'non-record rows pass through untouched')
})

test('the default budget is one screen, and a real fat reply still lands whole', () => {
  // The shape the ruling was written against: one very long answer at the end of
  // an otherwise quiet session. No budget argument means the shipped default.
  const page = [
    record(1, 'user/message', '整理一下这次的结论'),
    record(2, 'assistant/message', '结论'.repeat(400) + '。' + '下'.repeat(2000))
  ]
  const window = fitTailToScreen(page)

  assert.equal(window.length, 2, 'the prompt and its answer travel together')
  assert.equal(window[1].data.message.content[0].text.length, 400 * 2 + 1 + 2000, 'and the answer is whole')
})
