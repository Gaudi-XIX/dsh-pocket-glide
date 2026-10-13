/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Keep the newest rows up to `limit`. The landing never opens a conversation by
 * itself any more (user 2026-10-12: 「默认点链接就进主页面」), so there is no focus
 * row to protect — the boot list is simply the newest page.
 *
 * @param {unknown[]} rows
 * @param {number} limit
 */
export function orderRowsForBoot(rows, limit) {
  return rows
    .filter((row) => isRecord(row))
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, Math.max(0, limit))
}

/**
 * How recent a session's last activity must be for 「this phone never opened it」
 * to still read as unread.
 *
 * A ledger entry is positive proof of a read; its ABSENCE is not proof of
 * anything (the phone may be newly paired, or its localStorage wiped), so the
 * absent-entry case falls back to recency: a conversation that finished within
 * the last two days and was never opened on this phone counts as waiting,
 * anything older stays quiet. Without the bound a wiped ledger would light up
 * every row the workspace ever produced.
 */
export const UNREAD_RECENCY_MS = 48 * 60 * 60 * 1000

/**
 * Whether `row` counts as 推进完了但还没有读 for one device's ledger.
 *
 * A running row is never "unread" (it is counted as running by the caller); a
 * row with no activity timestamp has nothing to be behind on. With a positive
 * ledger entry the test is exact: activity newer than the last open. Without
 * one, recency decides — see `UNREAD_RECENCY_MS`.
 *
 * @param {Record<string, unknown>} row
 * @param {unknown} openedAt the row's ledger timestamp for THIS device
 * @param {number} nowMs
 * @param {number} recencyMs
 * @returns {boolean}
 */
export function isRowUnread(row, openedAt, nowMs, recencyMs = UNREAD_RECENCY_MS) {
  if (!row || row.running === true) return false
  const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : 0
  if (updatedAt <= 0) return false
  const opened = typeof openedAt === 'number' && Number.isFinite(openedAt) && openedAt > 0 ? openedAt : 0
  if (!opened) return nowMs - updatedAt < recencyMs
  return updatedAt > opened
}

/**
 * Session-list rows as the phone needs them.
 *
 * A harness row carries a `projections.values` blob holding the session's whole
 * turn history (`prompt`/`response` per turn), the subagent catalogue and more —
 * measured live at ~1 MB for the list, which the phone re-downloaded on every
 * pairing (the 2026-10-01 "stuck after the last step" report: the document was
 * 878 KB because of it).
 *
 * The phone renders a row from: sessionId, workspaceId, updatedAt, the state
 * flags, agentPreset, and three projection values (title, todos, model
 * selection). Anything else is kept only while it is small — a short string, a
 * number, a boolean — so an undocumented flag still survives while the history
 * blobs do not.
 */
export const SESSION_ROW_VALUE_KEYS = new Set(['title', 'sessionTitle', 'session.title', 'todos', 'modelSelection'])
export const SESSION_ROW_TEXT_LIMIT = 200
// The allowlist above names keys by INTENT, not by size: `todos` and
// `modelSelection` are structured values, so the string cap never touched them
// and they went to the phone whole (measured: a 3000-entry `todos` array and a
// 2061-byte `modelSelection` both arrived intact, by reference). They are now
// bounded by shape as well — the array is cut to a page, every nested string to
// the same 200 characters, and a nested object to a byte budget — while the
// fields the phone actually reads (`item.content` / `item.status`, and
// `next.{provider,model,reasoningEffort}`) survive as they are.
export const SESSION_ROW_ARRAY_MAX = 50
export const SESSION_ROW_OBJECT_BYTES = 1024
export const SESSION_ROW_DEPTH_MAX = 3

function isSmallRowValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return true
  return typeof value === 'string' && value.length <= SESSION_ROW_TEXT_LIMIT
}

/**
 * Copy one allowlisted value with every dimension bounded. Strings are cut to
 * `SESSION_ROW_TEXT_LIMIT`, arrays to `SESSION_ROW_ARRAY_MAX` entries, objects to
 * `SESSION_ROW_OBJECT_BYTES`, and nesting to `SESSION_ROW_DEPTH_MAX`. Returns
 * `undefined` for a value that has no bounded form (a function, a symbol, or
 * anything past the depth limit), which the caller drops.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function boundedRowValue(value, depth = 0) {
  if (typeof value === 'string') return value.slice(0, SESSION_ROW_TEXT_LIMIT)
  if (isSmallRowValue(value)) return value
  if (depth >= SESSION_ROW_DEPTH_MAX) return undefined
  if (Array.isArray(value)) {
    return value.slice(0, SESSION_ROW_ARRAY_MAX).map((entry) => {
      const bounded = boundedRowValue(entry, depth + 1)
      return bounded === undefined ? null : bounded
    })
  }
  if (isRecord(value)) {
    /** @type {Record<string, unknown>} */
    const kept = {}
    let bytes = 2
    for (const [key, inner] of Object.entries(value)) {
      const bounded = boundedRowValue(inner, depth + 1)
      if (bounded === undefined) continue
      const size = key.length + JSON.stringify(bounded).length + 4
      if (bytes + size > SESSION_ROW_OBJECT_BYTES) continue
      bytes += size
      kept[key] = bounded
    }
    return kept
  }
  return undefined
}

export function compactRowValues(values) {
  if (!isRecord(values)) return values
  /** @type {Record<string, unknown>} */
  const kept = {}
  for (const [key, value] of Object.entries(values)) {
    if (SESSION_ROW_VALUE_KEYS.has(key)) {
      const bounded = boundedRowValue(value)
      if (bounded !== undefined) kept[key] = bounded
      continue
    }
    if (isSmallRowValue(value)) kept[key] = value
  }
  return kept
}

/**
 * @param {unknown} items
 * @returns {unknown}
 */
/**
 * Derive `descendantRunning` for every non-subagent row from the raw session
 * list: a subagent row (origin === 'subagent') with a parentSessionId whose
 * `running` is true marks its parent. The host reports running per session
 * only (`summaryFor()`), so a lead parked in `running:false` while its child
 * works would otherwise read as finished — the false-green-check report
 * (2026-10-08, docs/agents-visibility-and-false-done-20261008.md §3). One
 * implementation lives here and feeds the three row consumers (the
 * `session.list` RPC, `buildMobileBoot`, and the notify tick), so the page's
 * status pill and the phone notification can never disagree about what
 * "still working" means. The flag is a plain boolean, so the small-row
 * whitelist carries it to the phone untouched.
 *
 * Aggregation is one level deep, matching the desktop sidebar's own rule
 * (a visible row shares the ongoing loading of its *direct* running children
 * in dsh-client-ui-workspace). Rows are never mutated: the session list is
 * cached, so a parent is shallow-copied only when a child marks it — a stale
 * `descendantRunning` must never outlive the tick that produced it.
 *
 * @param {unknown} items raw host session rows (not yet compacted)
 * @returns {unknown} the same list with descendantRunning added to parents
 */
export function applyDescendantRunning(items) {
  if (!Array.isArray(items)) return items
  /** @type {Array<{ index: number, item: Record<string, unknown> }>} */
  const indexed = []
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (isRecord(item) && typeof item.sessionId === 'string') indexed.push({ index, item })
  }
  const positionBySessionId = new Map(indexed.map((entry) => [entry.item.sessionId, entry.index]))
  /** @type {Set<number>} */
  const dirty = new Set()
  for (const { index, item } of indexed) {
    if (item.origin !== 'subagent' || item.running !== true) continue
    const parentSessionId = item.parentSessionId
    if (typeof parentSessionId !== 'string' || parentSessionId === item.sessionId) continue
    const parentIndex = positionBySessionId.get(parentSessionId)
    if (parentIndex === undefined || parentIndex === index) continue
    dirty.add(parentIndex)
  }
  if (dirty.size === 0) return items
  return items.map((item, index) => (dirty.has(index) ? { ...item, descendantRunning: true } : item))
}

export function compactSessionRows(items) {
  if (!Array.isArray(items)) return items
  return items.map((item) => {
    if (!isRecord(item)) return item
    /** @type {Record<string, unknown>} */
    const row = {}
    for (const [key, value] of Object.entries(item)) {
      if (key === 'projections') continue
      if (isSmallRowValue(value)) row[key] = value
    }
    // Error signal must survive compaction (user report 2026-10-12: a session
    // that died on the host showed a green check on the phone). The common
    // error shape is a long `lastError` prose string, which fails
    // isSmallRowValue — the field was dropped whole, taskState read the row as
    // done, and the phone's green check contradicted the bridge's own notify
    // check (which reads the RAW row) pushing "出错了" for that same session.
    // Whatever else is dropped, a row the host flags as errored carries a
    // bounded lastError in the very field the phone's taskState already reads,
    // so the compact row can never disagree with the raw one about "errored".
    const errored = item.error != null || item.status === 'error' || (typeof item.lastError === 'string' && item.lastError !== '')
    if (errored && !row.error && !row.lastError && row.status !== 'error') {
      const prose = typeof item.lastError === 'string' && item.lastError !== ''
        ? item.lastError
        : typeof item.error === 'string' && item.error !== '' ? item.error : 'error'
      row.lastError = prose.slice(0, SESSION_ROW_TEXT_LIMIT)
    }
    const projections = item.projections
    if (isRecord(projections)) {
      /** @type {Record<string, unknown>} */
      const kept = {}
      if (typeof projections.asOfSeq === 'number') kept.asOfSeq = projections.asOfSeq
      if (typeof projections.updatedAt === 'number') kept.updatedAt = projections.updatedAt
      if (isRecord(projections.values)) kept.values = compactRowValues(projections.values)
      else if (projections.values !== undefined) kept.values = projections.values
      row.projections = kept
    } else if (projections !== undefined) {
      row.projections = projections
    }
    return row
  })
}

/**
 * Record fields the phone provably never reads, measured on production data
 * (a 200-record window of a real session: 785 KB total).
 *
 *  - `stream`:  the replayed token stream of a finished turn (592 KB, 75%) — the
 *               live channel carries tokens separately, and the client's
 *               renderer only ever looks at `assistant/chunk` records.
 *  - `meta`:    a tool result's file-match snippets (61 KB, 8%) — the client
 *               reads only `message.content[].toolCallId/isError/content`.
 *  - `header`:  the full request header incl. every tool schema (50 KB, 6%) —
 *               no client code touches a record's `header`.
 *
 * Dropping exactly these keeps the painted transcript byte-identical (verified
 * by rendering the same session from both shapes) while cutting ~90% of the
 * bytes the phone pulls for every session it opens.
 */
export const PHONE_RECORD_DROP_KEYS = ['stream', 'header', 'meta']

/**
 * Strip the phone-invisible bulk from one harness record without mutating it.
 *
 * @param {unknown} record
 * @returns {unknown}
 */
function compactPhoneRecord(record) {
  if (!isRecord(record)) return record
  /** @type {Record<string, unknown>} */
  const compact = { ...record }
  if (isRecord(record.event)) compact.event = compactPhoneRecord(record.event)
  if (isRecord(record.data)) {
    /** @type {Record<string, unknown>} */
    const data = { ...record.data }
    for (const key of PHONE_RECORD_DROP_KEYS) delete data[key]
    compact.data = data
  }
  return compact
}

/**
 * Drop the records a phone already has (sequence <= sinceSeq) from the arrays of
 * one SSE frame. Single durable events are always forwarded: a page-wide
 * watermark may be stale for this very session, and swallowing `turn/end` or
 * `assistant/message` costs far more than repeating one frame the client already
 * dedupes by seq (2026-10-02 audit, P0-A).
 *
 * @param {unknown} frame
 * @param {number} sinceSeq
 * @returns {unknown}
 */
export function stripRecordsThrough(frame, sinceSeq) {
  if (!isRecord(frame) || !(sinceSeq >= 0)) return frame
  const seqOf = (entry) => {
    const event = isRecord(entry) && isRecord(entry.event) ? entry.event : entry
    const seq = isRecord(event) ? event.seq : undefined
    return typeof seq === 'number' ? seq : Infinity
  }
  const keep = (list) => list.filter((entry) => seqOf(entry) > sinceSeq)
  if (Array.isArray(frame.records)) {
    const records = keep(frame.records)
    return records.length === frame.records.length ? frame : { ...frame, records }
  }
  if (Array.isArray(frame.events)) {
    const events = keep(frame.events)
    return events.length === frame.events.length ? frame : { ...frame, events }
  }
  return frame
}

/**
 * @param {unknown} records
 * @returns {unknown}
 */
export function compactSessionRecords(records) {
  if (!Array.isArray(records)) return records
  return records.map((record) => compactPhoneRecord(record))
}

/**
 * Compact one SSE frame: a `snapshot` carries the page records, an `event`
 * carries a single record (possibly wrapped).
 *
 * @param {unknown} frame
 * @returns {unknown}
 */
export function compactSessionFrame(frame) {
  if (!isRecord(frame)) return frame
  /** @type {Record<string, unknown>} */
  const compact = { ...frame }
  if (Array.isArray(frame.records)) compact.records = compactSessionRecords(frame.records)
  if (Array.isArray(frame.events)) compact.events = compactSessionRecords(frame.events)
  if (isRecord(frame.event)) compact.event = compactPhoneRecord(frame.event)
  return compact
}

/**
 * @typedef {{ items: unknown[] } & Record<string, unknown>} WorkspaceSnapshot
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isWorkspaceSnapshot(value) {
  return isRecord(value) && Array.isArray(value.items)
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function workspaceIdOf(value) {
  if (!isRecord(value) || typeof value.workspaceId !== 'string' || value.workspaceId.length === 0) return undefined
  return value.workspaceId
}

/**
 * Fold one `workspace/follow` frame into the snapshot `workspace.list` serves.
 *
 * The Host has no unary workspace read. The opening frame is a full baseline;
 * later frames are increments. Increments that arrive before a baseline are
 * ignored, because there is no projection to apply them to.
 * @param {unknown} snapshot
 * @param {Record<string, unknown>} frame
 * @returns {unknown}
 */
export function applyWorkspaceFollowFrame(snapshot, frame) {
  if (frame.type === 'baseline') return isWorkspaceSnapshot(frame.value) ? frame.value : snapshot
  const current = isWorkspaceSnapshot(snapshot) ? snapshot : undefined
  if (current === undefined) return snapshot
  if (frame.type === 'upsert') {
    const workspaceId = workspaceIdOf(frame.workspace)
    if (workspaceId === undefined || !isRecord(frame.workspace)) return snapshot
    const items = current.items.slice()
    const index = items.findIndex((item) => workspaceIdOf(item) === workspaceId)
    if (index >= 0) items[index] = frame.workspace
    else items.push(frame.workspace)
    return { ...current, items }
  }
  if (frame.type === 'remove') {
    const workspaceId = typeof frame.workspaceId === 'string' ? frame.workspaceId : undefined
    if (workspaceId === undefined || workspaceId.length === 0) return snapshot
    return {
      ...current,
      items: current.items.filter((item) => workspaceIdOf(item) !== workspaceId)
    }
  }
  if (frame.type === 'order' && Array.isArray(frame.workspaceIds)) {
    const rank = new Map()
    for (const [index, id] of frame.workspaceIds.entries()) {
      if (typeof id === 'string' && id.length > 0) rank.set(id, index)
    }
    const items = current.items.slice().sort((left, right) => {
      const leftRank = rank.get(workspaceIdOf(left) ?? '')
      const rightRank = rank.get(workspaceIdOf(right) ?? '')
      return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER)
    })
    return { ...current, items }
  }
  if (frame.type === 'archived' && Array.isArray(frame.archivedSessionIds)) {
    return { ...current, archivedSessionIds: frame.archivedSessionIds.slice() }
  }
  if (frame.type === 'pinned' && Array.isArray(frame.pinnedSessionIds)) {
    // Same fold as `archived` above: the Host broadcasts the full pinned id set
    // on every pin/unpin, so the frame replaces the field rather than patching it.
    // The `Array.isArray` guard keeps an older-shaped frame (no such field) a
    // no-op instead of a throw, and an absent field never writes `undefined` over
    // the ids the baseline carried.
    return { ...current, pinnedSessionIds: frame.pinnedSessionIds.slice() }
  }
  return snapshot
}
