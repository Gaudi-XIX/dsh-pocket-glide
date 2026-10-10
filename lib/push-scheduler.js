/**
 * The push envelope: how a batch of low-urgency notifications waits for a bus
 * without ever being left at the stop, and how high-urgency ones never queue at
 * all (design 0.4.12).
 *
 * Why this exists. One inbound WeChat message buys ten outbound pushes, so the
 * notifier's real budget is the quota, not bandwidth. The shipped behaviour
 * fired one push per settled session straight from the poll loop, so a busy
 * minute — a fleet handing back, a restart re-baselining a list — burned the
 * whole quota in one tick (live trace 2026-10-10 09:34:23: 13 sends in one
 * second, 12 refused) and then every *important* notice after it was silently
 * dropped. Batch the cheap ones, and the same quota carries far more news.
 *
 * The philosophy is a flight schedule, not a fixed interval:
 *  - **last bus**: a departure is triggered by *quiet* (75 s since the last
 *    arrival) rather than by a timer started at the first — a two-item batch
 *    that stops growing leaves promptly;
 *  - **hard cap**: the oldest passenger is never held past 180 s, so a
 *    continuous stream still departs on schedule;
 *  - **full flight**: 4 items leave at once, no waiting;
 *  - **hitchhiking**: whenever anything else is sent anyway, the envelope rides
 *    with it at no extra cost.
 *
 * Priority is decided by the caller (a human judgement about what the user is
 * waiting for), this module only does the mechanical part:
 *  - `urgent` — arrive-and-answer notices and stop/error notices. They never
 *    wait for a bus: they are sent immediately, and a failed one is *kept* for
 *    retry instead of dropped, which is what "the quota was gone" must mean for
 *    the notices the user cannot afford to miss.
 *  - `batch` — completion notices: merged into one message per departure,
 *    deduplicated per session (the newest fact about a session wins).
 *
 * No clock is read here and nothing is thrown: `now` comes in as an argument,
 * and every decision is returned so the bridge (and a test) can drive it.
 */

/** High urgency: send now, retry on failure, never merged. */
export const PUSH_URGENT = 'urgent'
/** Ordinary news: merged into the next departure, deduplicated per session. */
export const PUSH_BATCH = 'batch'

const EMPTY = Object.freeze([])

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * A bounded push envelope.
 *
 * @param {{
 *   batchMax?: number        items that fill a flight (depart at once)
 *   batchHoldMs?: number     longest the oldest item may be held
 *   batchQuietMs?: number    silence since the last arrival that ends a flight's wait
 *   urgentMax?: number       kept urgent items before the oldest is dropped
 * }} [limits]
 */
export function createPushEnvelope(limits = {}) {
  const batchMax = Number.isFinite(limits.batchMax) && limits.batchMax > 0 ? Math.floor(limits.batchMax) : 4
  const batchHoldMs = Number.isFinite(limits.batchHoldMs) && limits.batchHoldMs > 0 ? limits.batchHoldMs : 180_000
  const batchQuietMs = Number.isFinite(limits.batchQuietMs) && limits.batchQuietMs > 0 ? limits.batchQuietMs : 75_000
  const urgentMax = Number.isFinite(limits.urgentMax) && limits.urgentMax > 0 ? Math.floor(limits.urgentMax) : 8

  /** @type {{ title: string, body: string }[]} */
  const urgent = []
  /** Deduplicated by key (a session id): insertion order is departure order. */
  const batch = new Map()
  /** When the most recent batch item arrived — the last-bus clock. */
  let lastArrivalAt = 0

  /**
   * Queue one notification.
   * @param {string} kind {@link PUSH_URGENT} or {@link PUSH_BATCH}
   * @param {{ key?: string, title: string, body: string }} item
   * @param {number} now
   * @returns {boolean} true when the item was taken into the envelope
   */
  function add(kind, item, now) {
    const title = text(item?.title)
    const body = text(item?.body)
    if (!title && !body) return false
    if (kind === PUSH_URGENT) {
      urgent.push({ title, body })
      while (urgent.length > urgentMax) urgent.shift()
      return true
    }
    // Completion news is per-session: a session that settles twice says one
    // thing twice, and the second is the true one. Same key → same slot,
    // refreshed content (the passenger, not the seat, is replaced).
    const key = text(item?.key) || `t:${title}`
    batch.delete(key)
    batch.set(key, { key, title, body, at: now })
    lastArrivalAt = now
    return true
  }

  /**
   * Is a batch departure due? Checked by the caller on its own tick.
   *
   * Full flight → go. Silence since the last arrival → go (the last bus; this is
   * why a lone completion is not held for a whole fixed window). Oldest item at
   * its cap → go, however busy the stream is.
   * @param {number} now
   * @returns {boolean}
   */
  function due(now) {
    if (batch.size === 0) return false
    if (batch.size >= batchMax) return true
    if (Number.isFinite(now) && now - lastArrivalAt >= batchQuietMs) return true
    const oldest = batch.values().next().value
    const firstAt = oldest?.at
    if (Number.isFinite(firstAt) && now - firstAt >= batchHoldMs) return true
    return false
  }

  /**
   * Take everything waiting. Both lists are cleared; the caller is responsible
   * for putting a *failed* urgent item back with {@link add}, which is how an
   * arrive-and-answer notice survives a spent quota.
   * @param {number} now
   * @returns {{ urgent: { title: string, body: string }[], batch: { title: string, body: string }[] }}
   */
  function take(now) {
    const drainedUrgent = urgent.length > 0 ? urgent.splice(0, urgent.length) : EMPTY
    const drainedBatch = []
    if (batch.size > 0) {
      for (const entry of batch.values()) drainedBatch.push(entry)
      batch.clear()
      lastArrivalAt = 0
    }
    void now
    return { urgent: drainedUrgent, batch: drainedBatch }
  }

  /** @param {number} now @returns {number} how long the oldest batch item has waited */
  function oldestWaitMs(now) {
    const oldest = batch.values().next().value
    if (!oldest || !Number.isFinite(oldest.at) || !Number.isFinite(now)) return 0
    return Math.max(0, now - oldest.at)
  }

  return {
    add,
    due,
    take,
    oldestWaitMs,
    get urgentCount() {
      return urgent.length
    },
    get batchCount() {
      return batch.size
    }
  }
}

/**
 * Merge a batch departure into one notification: one settled session keeps the
 * per-session shape (title is the session, body says why), two or more become a
 * list under a counting title. Titles are capped so a long fleet cannot grow
 * the message without bound.
 *
 * @param {{ title: string, body: string }[]} items
 * @param {{ titleMax?: number, listMax?: number }} [shape]
 * @returns {{ title: string, body: string }}
 */
export function mergeBatchItems(items, shape = {}) {
  const titleMax = Number.isFinite(shape.titleMax) ? shape.titleMax : 60
  const listMax = Number.isFinite(shape.listMax) ? shape.listMax : 8
  const list = Array.isArray(items) ? items.filter((item) => item && (text(item.title) || text(item.body))) : []
  if (list.length === 0) return { title: '', body: '' }
  if (list.length === 1) return { title: list[0].title, body: list[0].body }

  const shown = list.slice(0, listMax)
  const hidden = list.length - shown.length
  const lines = shown.map((item) => `· ${item.title}${item.body ? `：${item.body}` : ''}`)
  if (hidden > 0) lines.push(`· …另有 ${hidden} 个`)
  const subjects = [...new Set(list.map((item) => text(item.body)).filter(Boolean))]
  const what = subjects.length === 1 ? subjects[0] : '有更新'
  return {
    title: `${list.length} 个会话${what}`.slice(0, titleMax),
    body: lines.join('\n')
  }
}
