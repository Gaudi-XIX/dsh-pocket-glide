// Task 1 (2026-11-03 pocket-question-and-bot-rooms-parity): the host's `askTimed`
// puts `wait: {callId, timed}` on the question REQUEST, so the phone can hold the
// countdown claim from the pending event alone. `inspectPendingQuestion` is the one
// gate every pending question passes through, so the field has to be let through
// there — but only as a whitelist: a usable string callId is required, `timed` is
// carried only when it is literally true, and a request without a usable wait must
// come out with no `wait` key at all (the phone treats "has wait" as "timed").
//
// The wait is one claim for the whole call, because every question of a call is
// answered by one submission, so it rides on the VALUE beside `questions`, not on
// each question. AC1 is written against exactly that path: `.value.wait`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectPendingQuestion } from '../lib/questions.js'

/** One request around a single `wait` value (or no wait at all). */
function requestWithWait(wait) {
  return {
    sessionId: 'sess-1',
    questions: [{ id: 'q1', question: 'Proceed?' }],
    ...(wait === undefined ? {} : { wait }),
  }
}

/** The accepted value, with the gate's own refusal surfaced. */
function valueOf(wait) {
  const result = inspectPendingQuestion('rpc-1', requestWithWait(wait))
  assert.equal(result.ok, true, `the request is accepted: ${JSON.stringify(result)}`)
  return result.value
}

test('a timed wait is carried as exactly {callId, timed:true}', () => {
  const wait = valueOf({ callId: 'c1', timed: true }).wait
  assert.deepEqual(wait, { callId: 'c1', timed: true })
  assert.deepEqual(Object.keys(wait), ['callId', 'timed'], 'no other key rides along')
})

test('an untimed wait carries the callId and no timed key at all', () => {
  const wait = valueOf({ callId: 'c1', timed: false }).wait
  assert.deepEqual(wait, { callId: 'c1' })
  assert.equal(Object.hasOwn(wait, 'timed'), false, 'timed:false is absence, not a false value')
})

test('a timed key that is not literally true is not carried as timed', () => {
  for (const timed of ['true', 1, {}, null]) {
    const wait = valueOf({ callId: 'c1', timed }).wait
    assert.deepEqual(wait, { callId: 'c1' }, `timed=${JSON.stringify(timed)} is not true`)
  }
})

test('a wait without a usable callId leaves no wait key', () => {
  for (const wait of [{ callId: 7 }, {}, { callId: null }, 'c1', 42, [], true]) {
    const value = valueOf(wait)
    assert.equal(Object.hasOwn(value, 'wait'), false, `wait=${JSON.stringify(wait)} is refused`)
  }
})

test('a request with no wait field comes out with no wait key', () => {
  const value = valueOf(undefined)
  assert.equal(Object.hasOwn(value, 'wait'), false)
  assert.deepEqual(Object.keys(value).sort(), ['questions', 'rpcId', 'sessionId'], 'the whitelist stays a whitelist')
})

test('extra fields on the host wait object are not forwarded', () => {
  const wait = valueOf({ callId: 'c1', timed: true, deadline: 12345, remainingMs: 88000 }).wait
  assert.deepEqual(wait, { callId: 'c1', timed: true }, 'only callId and timed cross the gate')
})

test('the questions themselves never grow a wait key, however the request names it', () => {
  const value = valueOf({ callId: 'c1', timed: true })
  assert.deepEqual(Object.keys(value.questions[0]).sort(), ['id', 'question'])
})

test('a refused request still refuses for its own reasons, wait or not', () => {
  const malformed = inspectPendingQuestion('rpc-1', {
    sessionId: 'sess-1',
    wait: { callId: 'c1', timed: true },
    questions: [{ id: 'q1', question: 'Proceed?' }, { id: 'q1', question: 'Again?' }],
  })
  assert.deepEqual(malformed, { ok: false, reason: 'duplicate-question-id' }, 'wait does not soften the other gates')
})
