import { isRecord } from './projections.js'

/**
 * Bounds on a pending question set.
 *
 * These exist so a malformed or hostile host payload cannot allocate without
 * limit — they are NOT a trimming device. A measured host payload carried 25
 * questions and 60 options, and the previous caps (20 / 50) silently dropped
 * the tail: the phone answered a prefix, and the host received a partial batch
 * that looked complete (`20-answer submit : ACCEPTED (silently partial)`).
 *
 * `parsePendingQuestion` therefore emits either the whole set or nothing at
 * all, and `parseQuestionResponse` accepts exactly as many answers as the
 * request side can carry, so the two caps cannot drift apart.
 */
export const MAX_PENDING_QUESTIONS = 100
export const MAX_QUESTION_OPTIONS = 200

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function requiredStringField(value, field) {
  if (!isRecord(value) || typeof value[field] !== 'string' || !value[field]) {
    throw new Error(`Invalid ${field}.`)
  }
  return value[field]
}

/**
 * Parse a pending question event into the shape the phone renders.
 *
 * Full or nothing: if the payload carries more questions than the bound, more
 * options than the bound, a malformed entry, or a duplicate question id, the
 * result is `undefined` rather than a subset. A subset is worse than no
 * question at all, because the answer validator compares counts — a trimmed
 * set is answered as if it were the entire list, and the host then receives a
 * partial submission indistinguishable from a complete one. (A duplicate id is
 * refused for a sharper reason: answers are keyed by id, so such a set rejects
 * every submission, including an all-skip one, as a duplicate.)
 *
 * @param {string} rpcId
 * @param {Record<string, unknown>} payload
 * @returns {{ rpcId: string, sessionId: string, questions: Array<Record<string, unknown>> } | undefined}
 */
export function parsePendingQuestion(rpcId, payload) {
  if (typeof payload.sessionId !== 'string' || !Array.isArray(payload.questions)) return undefined
  if (payload.questions.length > MAX_PENDING_QUESTIONS) return undefined
  /** @type {Array<Record<string, unknown>>} */
  const questions = []
  const seenIds = new Set()
  for (const item of payload.questions) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.question !== 'string') return undefined
    if (seenIds.has(item.id)) return undefined
    seenIds.add(item.id)
    /** @type {Record<string, unknown>} */
    const question = { id: item.id, question: item.question }
    if (typeof item.detail === 'string') question.detail = item.detail
    if (typeof item.header === 'string') question.header = item.header
    if (typeof item.multiSelect === 'boolean') question.multiSelect = item.multiSelect
    if (typeof item.intent === 'string') question.intent = item.intent
    if (Array.isArray(item.options)) {
      if (item.options.length > MAX_QUESTION_OPTIONS) return undefined
      /** @type {Array<{ label: string, description?: string }>} */
      const options = []
      for (const option of item.options) {
        if (!isRecord(option) || typeof option.label !== 'string') return undefined
        options.push({
          label: option.label,
          ...(typeof option.description === 'string' ? { description: option.description } : {})
        })
      }
      question.options = options
    }
    questions.push(question)
  }
  if (!questions.length) return undefined
  return { rpcId, sessionId: payload.sessionId, questions }
}

/**
 * @param {unknown} value
 * @returns {{ rpcId: string, sessionId: string, answers: Array<Record<string, unknown>> }}
 */
export function parseQuestionResponse(value) {
  const rpcId = requiredStringField(value, 'rpcId')
  const sessionId = requiredStringField(value, 'sessionId')
  // Same bound as the request side: a question set the bridge was willing to
  // carry must be answerable in one response.
  if (!isRecord(value) || !Array.isArray(value.answers) || value.answers.length > MAX_PENDING_QUESTIONS) {
    throw new Error('Invalid question answers.')
  }
  const answers = value.answers.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !Array.isArray(item.selected)) {
      throw new Error('Invalid question answer.')
    }
    const selected = item.selected.map((label) => {
      if (typeof label !== 'string') throw new Error('Invalid selected option.')
      return label
    })
    if (selected.length > MAX_QUESTION_OPTIONS) throw new Error('Too many selected options.')
    return {
      id: item.id,
      selected,
      ...(typeof item.custom === 'string' && item.custom.trim() ? { custom: item.custom } : {})
    }
  })
  return { rpcId, sessionId, answers }
}

/**
 * @param {{ questions: Array<{ id: string, options?: Array<{ label: string }>, multiSelect?: boolean }> }} pending
 * @param {Array<{ id: string, selected: string[] }>} answers
 */
export function validateQuestionAnswers(pending, answers) {
  if (answers.length !== pending.questions.length) throw new Error('Every question needs an answer or skip.')
  const answerById = new Map(answers.map((answer) => [answer.id, answer]))
  if (answerById.size !== answers.length) throw new Error('Duplicate question answer.')
  for (const question of pending.questions) {
    const answer = answerById.get(question.id)
    if (!answer) throw new Error('Every question needs an answer or skip.')
    const allowed = new Set((question.options ?? []).map((option) => option.label))
    if (answer.selected.some((label) => !allowed.has(label))) {
      throw new Error('Answer contains an unknown option.')
    }
    if (!question.multiSelect && answer.selected.length > 1) {
      throw new Error('Only one option can be selected.')
    }
  }
}
