// WP-RESCAN-B / RA-5: a pending question set is carried whole or not at all.
//
// The rescan probe measured a host payload of 25 questions / 60 options being
// silently trimmed to 20 / 50 by `parsePendingQuestion`. The phone then answered
// the prefix and the host ACCEPTED a partial submission that looked complete,
// because the validator only compares counts. Options past the cap were worse
// than invisible: answering one was rejected as "Answer contains an unknown
// option." A duplicate question id was worse still — answers are keyed by id, so
// every submission (including an all-skip one) was rejected as a duplicate.
//
// These assertions are behavioral: they feed real payload shapes through the
// exported parsers and read the returned structure, not the source text. The one
// source-level check is slice-limited to the function body.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LanMobileBridge } from '../lib/bridge.js'
import { EVENT_STREAM_ID, USER_QUESTION_EVENT } from '../lib/constants.js'
import {
  MAX_PENDING_QUESTIONS,
  MAX_QUESTION_OPTIONS,
  inspectPendingQuestion,
  parsePendingQuestion,
  parseQuestionResponse,
  validateQuestionAnswers,
} from '../lib/questions.js'

/** A question set of the measured shape, sized to whatever the caller needs. */
function questionSet(count, optionsPerQuestion = 0) {
  return {
    sessionId: 'sess-1',
    questions: Array.from({ length: count }, (_, index) => ({
      id: `q${String(index + 1)}`,
      question: `Question ${String(index + 1)}?`,
      ...(optionsPerQuestion > 0
        ? {
            options: Array.from({ length: optionsPerQuestion }, (_o, o) => ({
              label: `opt-${String(o + 1)}`,
              description: `description ${String(o + 1)}`,
            })),
          }
        : {}),
    })),
  }
}

test('a 25-question payload is carried whole, not trimmed to 20', () => {
  const parsed = parsePendingQuestion('rpc-1', questionSet(25))
  assert.ok(parsed, 'the set is accepted')
  assert.equal(parsed.questions.length, 25, 'every question survives')
  assert.deepEqual(
    parsed.questions.map((entry) => entry.id),
    Array.from({ length: 25 }, (_, index) => `q${String(index + 1)}`),
    'and in order, with no tail dropped',
  )
  // The measured failure: 20 answers were accepted for a 25-question request.
  assert.equal(parsed.questions.length, questionSet(25).questions.length, 'the count matches the request')
})

test('a 60-option payload keeps every option answerable', () => {
  const parsed = parsePendingQuestion('rpc-1', questionSet(1, 60))
  assert.ok(parsed, 'the set is accepted')
  const options = parsed.questions[0].options
  assert.equal(options.length, 60, 'no option is dropped')
  assert.equal(options[59].label, 'opt-60', 'the last option is present and therefore selectable')
  assert.equal(options[59].description, 'description 60')
  // And it round-trips through validation instead of reading as unknown.
  assert.doesNotThrow(() =>
    validateQuestionAnswers(parsed, [{ id: 'q1', selected: ['opt-60'] }]),
  )
})

test('a set past the bound is refused outright, never silently shortened', () => {
  const parsed = parsePendingQuestion('rpc-1', questionSet(MAX_PENDING_QUESTIONS + 1))
  assert.equal(parsed, undefined, 'no subset is produced')
})

test('a question past the option bound is refused outright', () => {
  const parsed = parsePendingQuestion('rpc-1', questionSet(1, MAX_QUESTION_OPTIONS + 1))
  assert.equal(parsed, undefined, 'no partially-optioned question is produced')
})

test('a malformed entry refuses the whole set rather than skipping it', () => {
  const payload = questionSet(3)
  // The middle question is unusable. Skipping it would leave q1 and q3, which
  // the answer validator compares by count — a silently different question set.
  payload.questions[1] = { id: 'q2' }
  assert.equal(parsePendingQuestion('rpc-1', payload), undefined)
})

test('a duplicate question id refuses the set, since answers are keyed by id', () => {
  const payload = questionSet(2)
  payload.questions[1].id = payload.questions[0].id
  const parsed = parsePendingQuestion('rpc-1', payload)
  assert.equal(parsed, undefined, 'the ambiguous set never reaches the phone')
})

test('an empty or shapeless payload still yields nothing', () => {
  assert.equal(parsePendingQuestion('rpc-1', { sessionId: 's', questions: [] }), undefined)
  assert.equal(parsePendingQuestion('rpc-1', { sessionId: 's' }), undefined)
  assert.equal(parsePendingQuestion('rpc-1', { questions: [] }), undefined)
})

test('the response side accepts as many answers as the request side carries', () => {
  const pending = parsePendingQuestion('rpc-1', questionSet(MAX_PENDING_QUESTIONS))
  assert.ok(pending, 'a full-size set is carried')
  const answers = pending.questions.map((entry) => ({ id: entry.id, selected: [] }))
  const parsed = parseQuestionResponse({ rpcId: 'rpc-1', sessionId: 'sess-1', answers })
  assert.equal(parsed.answers.length, MAX_PENDING_QUESTIONS, 'a full batch is not rejected by a smaller cap')
  assert.doesNotThrow(() => validateQuestionAnswers(pending, parsed.answers), 'and it validates')
  assert.throws(
    () => parseQuestionResponse({
      rpcId: 'rpc-1',
      sessionId: 'sess-1',
      answers: [...answers, { id: 'extra', selected: [] }],
    }),
    /Invalid question answers\./,
    'one answer past the bound is still refused',
  )
})

test('the two caps cannot drift apart', () => {
  // A smaller answers cap than the questions cap would make a carried set
  // unanswerable; a larger one would let a phone submit answers to questions
  // the bridge never sent.
  const pending = parsePendingQuestion('rpc-1', questionSet(MAX_PENDING_QUESTIONS))
  assert.ok(pending)
  assert.doesNotThrow(() =>
    parseQuestionResponse({
      rpcId: 'rpc-1',
      sessionId: 'sess-1',
      answers: pending.questions.map((entry) => ({ id: entry.id, selected: [] })),
    }),
  )
})

test('the parse no longer trims by slicing', () => {
  // Slice-limited source check: the body of parsePendingQuestion must not cut
  // the question list or the option list. Global `includes` on the whole file
  // is deliberately avoided (other functions legitimately slice).
  const source = readFileSync(new URL('../lib/questions.js', import.meta.url), 'utf8')
  const start = source.indexOf('export function parsePendingQuestion')
  const end = source.indexOf('export function parseQuestionResponse')
  assert.ok(start !== -1 && end > start, 'both anchors were found')
  const body = source.slice(start, end)
  assert.ok(!/\.slice\(/.test(body), `the parser must not trim its input, saw: ${body.match(/[^\n]*\.slice\([^\n]*/)?.[0] ?? ''}`)
})

test('the answer validator still refuses the shapes it always did', () => {
  const pending = parsePendingQuestion('rpc-1', questionSet(2, 2))
  assert.ok(pending)
  assert.throws(() => validateQuestionAnswers(pending, []), /Every question needs an answer or skip\./)
  assert.throws(
    () => validateQuestionAnswers(pending, [
      { id: 'q1', selected: ['opt-1'] },
      { id: 'q1', selected: ['opt-1'] },
    ]),
    /Duplicate question answer\./,
  )
  assert.throws(
    () => validateQuestionAnswers(pending, [
      { id: 'q1', selected: ['opt-9'] },
      { id: 'q2', selected: ['opt-1'] },
    ]),
    /Answer contains an unknown option\./,
  )
  assert.throws(
    () => validateQuestionAnswers(pending, [
      { id: 'q1', selected: ['opt-1', 'opt-2'] },
      { id: 'q2', selected: ['opt-1'] },
    ]),
    /Only one option can be selected\./,
  )
})

test('a multi-select question still accepts several options', () => {
  const payload = questionSet(1, 3)
  payload.questions[0].multiSelect = true
  const pending = parsePendingQuestion('rpc-1', payload)
  assert.ok(pending)
  assert.doesNotThrow(() =>
    validateQuestionAnswers(pending, [{ id: 'q1', selected: ['opt-1', 'opt-2', 'opt-3'] }]),
  )
})

test('custom text is kept only when it carries something', () => {
  const parsed = parseQuestionResponse({
    rpcId: 'rpc-1',
    sessionId: 'sess-1',
    answers: [
      { id: 'q1', selected: [], custom: '  typed  ' },
      { id: 'q2', selected: [], custom: '   ' },
    ],
  })
  assert.equal(parsed.answers[0].custom, '  typed  ')
  assert.equal('custom' in parsed.answers[1], false, 'whitespace-only text is not an answer')
})

// WP-QUESTION-LOG / RA-5 observability: a refused set is refused OUT LOUD.
//
// The rescan found the last silent path in this file's story: `consumeMuxEnvelope`
// called the parser, got `undefined`, and returned — no log, no counter, no
// trace. A question the phone never renders is a prompt the operator waits on
// forever. `inspectPendingQuestion` exists so the refusal can name itself.
//
// The log discipline is the other half of the assertion: reason and size only.
// The Host's event id and the prose of a question are not this log's to hold,
// matching the precedent already set by `rememberPendingQuestion`.

/** A bridge reduced to what `consumeMuxEnvelope` touches on the question path. */
function fakeBridge() {
  const logs = []
  return {
    logs,
    bridge: {
      pendingQuestions: new Map(),
      log(level, message) {
        logs.push({ level, message })
      },
      rememberPendingQuestion(eventId, pending) {
        this.pendingQuestions.set(eventId, pending)
      },
    },
  }
}

/** One forwarded `user-questions/request` waterfall item, as the Host emits it. */
function questionEnvelope(eventId, request) {
  return JSON.stringify({
    type: 'item',
    streamId: EVENT_STREAM_ID,
    value: {
      type: 'waterfall',
      event: USER_QUESTION_EVENT,
      eventId,
      agentId: 'sess-1',
      request,
    },
  })
}

test('a refusal names its reason, and the wrapper still says undefined', () => {
  const payloads = [
    { reason: 'session', payload: { questions: [] } },
    { reason: 'session', payload: { sessionId: 7, questions: [] } },
    { reason: 'empty-question-set', payload: { sessionId: 's', questions: [] } },
    { reason: 'empty-question-set', payload: { sessionId: 's' } },
    {
      reason: 'too-many-questions',
      payload: questionSet(MAX_PENDING_QUESTIONS + 1),
      count: MAX_PENDING_QUESTIONS + 1,
    },
    {
      reason: 'too-many-options',
      payload: questionSet(1, MAX_QUESTION_OPTIONS + 1),
      count: MAX_QUESTION_OPTIONS + 1,
    },
    { reason: 'malformed-question', payload: { sessionId: 's', questions: [{ id: 'q1' }] } },
    {
      reason: 'duplicate-question-id',
      payload: {
        sessionId: 's',
        questions: [
          { id: 'q1', question: 'first?' },
          { id: 'q1', question: 'second?' },
        ],
      },
    },
    {
      reason: 'malformed-option',
      payload: { sessionId: 's', questions: [{ id: 'q1', question: 'a?', options: [{ description: 'no label' }] }] },
    },
  ]
  const seen = new Set()
  for (const item of payloads) {
    const inspected = inspectPendingQuestion('rpc-1', item.payload)
    assert.equal(inspected.ok, false, `expected a refusal for ${item.reason}`)
    assert.equal(inspected.reason, item.reason)
    assert.equal('value' in inspected, false, 'a refusal carries no value')
    if (item.count !== undefined) assert.equal(inspected.count, item.count)
    assert.equal(parsePendingQuestion('rpc-1', item.payload), undefined, 'the wrapper is unchanged')
    seen.add(inspected.reason)
  }
  assert.deepEqual(
    [...seen].sort(),
    ['duplicate-question-id', 'empty-question-set', 'malformed-option', 'malformed-question', 'session', 'too-many-options', 'too-many-questions'],
    'every refusal path is reachable and named',
  )
})

test('a carried set reports ok with the same value the wrapper returns', () => {
  const payload = questionSet(2, 2)
  const inspected = inspectPendingQuestion('rpc-1', payload)
  assert.equal(inspected.ok, true)
  assert.deepEqual(inspected.value, parsePendingQuestion('rpc-1', payload))
  assert.equal(inspected.value.questions.length, 2)
})

test('the bridge logs a refused question exactly once, with no identity in it', () => {
  const { bridge, logs } = fakeBridge()
  const eventId = 'evt-secret-9d2f'
  const prose = 'SECRET-PROSE'
  // Two questions sharing one id: refused, and the payload still carries prose
  // and an id the log must not repeat.
  LanMobileBridge.prototype.consumeMuxEnvelope.call(
    bridge,
    questionEnvelope(eventId, {
      questions: [
        { id: 'q1', question: prose },
        { id: 'q1', question: 'second?' },
      ],
    }),
  )
  assert.equal(logs.length, 1, 'exactly one line, not zero and not two')
  assert.equal(logs[0].level, 'warn')
  assert.match(logs[0].message, /reason=duplicate-question-id/)
  assert.ok(!logs[0].message.includes(eventId), 'the Host event id is not this log to hold')
  assert.ok(!logs[0].message.includes(prose), 'nor is the prose of a question')
  assert.equal(bridge.pendingQuestions.size, 0, 'a refused set is not remembered')
})

test('a size refusal states the count, and a carried set logs nothing', () => {
  const { bridge, logs } = fakeBridge()
  LanMobileBridge.prototype.consumeMuxEnvelope.call(bridge, questionEnvelope('evt-1', questionSet(MAX_PENDING_QUESTIONS + 1)))
  assert.equal(logs.length, 1)
  assert.match(logs[0].message, new RegExp(`reason=too-many-questions count=${String(MAX_PENDING_QUESTIONS + 1)}`))
  assert.equal(bridge.pendingQuestions.size, 0)

  const carried = fakeBridge()
  LanMobileBridge.prototype.consumeMuxEnvelope.call(carried.bridge, questionEnvelope('evt-2', questionSet(2)))
  assert.equal(carried.logs.length, 0, 'a carried set is not an event')
  assert.equal(carried.bridge.pendingQuestions.size, 1, 'and it is held for the answer')
})