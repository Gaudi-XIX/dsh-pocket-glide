import { isRecord } from './projections.js'
import { MAX_PENDING_QUESTIONS, MAX_QUESTION_OPTIONS } from './questions.js'

/**
 * One answer batch for a question the Host already marked `continued` — the
 * card that outlived its countdown. Same shape as the request-side answers
 * (`{id, selected, custom?}`), but there is no forwarded event id to pair with:
 * the Host's `userQuestions/answer` keys the reply by call id, and it checks
 * the batch against the projection itself, so this side only guarantees the
 * shape and that each question is named at most once.
 *
 * It lives beside, not inside, `lib/questions.js`: the request side of a
 * question (the `wait` whitelist and the forwarded-answer parser) has its own
 * net-growth budget, and this reply path is a separate concern that would
 * otherwise spend it.
 * @param {unknown} value `payload.answers` from the RPC body
 * @returns {Array<{ id: string, selected: string[] }>}
 */
export function parseAnswerBatch(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PENDING_QUESTIONS) {
    throw new Error('Invalid question answers.')
  }
  const seen = new Set()
  const answers = value.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id) {
      throw new Error('Invalid question answer.')
    }
    if (seen.has(item.id)) throw new Error('Duplicate question answer.')
    seen.add(item.id)
    if (!Array.isArray(item.selected)) throw new Error('Invalid question answer.')
    const selected = item.selected.map((label) => {
      if (typeof label !== 'string') throw new Error('Invalid selected option.')
      return label
    })
    if (selected.length > MAX_QUESTION_OPTIONS) throw new Error('Too many selected options.')
    return { id: item.id, selected }
  })
  return answers
}
