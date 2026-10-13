import { randomUUID } from 'node:crypto'
import { HISTORY_PAGE_DEFAULT_MESSAGES, REMOTE_STREAM_MUX_PATH, SSE_KEEPALIVE_MS } from './constants.js'
import { compactSessionFrame, isRecord, stripRecordsThrough, SESSION_ROW_TEXT_LIMIT } from './projections.js'

// ---------------------------------------------------------------------------
// Poll-collector constants. They live HERE, not in constants.js, because that
// file is owned by a parallel worker in this wave; the split is mechanical and
// a later housekeeping pass can move them without touching behavior.
// ---------------------------------------------------------------------------

/** A poll collector whose session stopped being polled is torn down after this long. */
export const EVENT_COLLECTOR_IDLE_MS = 30_000
/** At most this many sessions carry a poll collector at once (LRU by last poll). */
export const EVENT_COLLECTOR_SESSIONS_MAX = 8
/** Buffered entries per session before the oldest half is dropped. */
export const EVENTS_BUFFER_MAX_ENTRIES = 2000
/** Entries retained after a trim — the window a re-syncing client can still rewind into. */
const EVENTS_BUFFER_KEEP_ENTRIES = 1000
/**
 * How long an EMPTY poll is held before it answers.
 *
 * A poll that returns `[]` immediately forces the phone to come back on its
 * backoff ladder (1.5 s → 6 s), so an idle conversation pays a tunnel round trip
 * every few seconds for nothing, and a live one shows new text up to 6 s late.
 * Holding the request and letting the frame itself release it turns both around:
 * near-zero delivery latency, and fewer requests than the ladder was making.
 *
 * The ceiling must stay below the phone's own abandonment timer — the page races
 * every poll against `EVENTS_FETCH_TIMEOUT_MS` = 10 s (lib/pages.js) — with room
 * for the answer to travel back over the tunnel. Guarded as a relation, not a
 * pair of literals, in test/session-events.test.js.
 * `0` disables holding and restores the pre-2026-10-10 answer-at-once behaviour.
 */
export const EVENT_HOLD_MS = 8_000
/** Reconnect ladder for one collector's carrier follow (mirrors the SSE `retry:` idea). */
const EVENT_COLLECTOR_RETRY_BASE_MS = 500
const EVENT_COLLECTOR_RETRY_CAP_MS = 8000

/**
 * `turn/end` reason kinds the mobile transcript renders as an error banner
 * (`lib/pages.js` visibleMessages). Only `error` carries a host-side message we
 * can name, so only it RECORDS a mark; the rest must not CLEAR a mark either —
 * an aborted or blocked turn leaves the previous failure unresolved and a green
 * check would repeat the exact bug this projection fixes (requirement 5,
 * 2026-10-13). Anything else (`completed`, `forked`, an unrecognized kind) is a
 * normal end and clears the mark, so one error cannot stay forever.
 */
const TURN_END_ERRORISH_KINDS = new Set(['error', 'aborted', 'blocked', 'max-tokens', 'interrupted'])

/**
 * Parse one carrier envelope of a `session/follow` logical stream and classify
 * it. This is THE shared incremental-collection logic: the SSE path
 * (`streamSession`) and the polling collector (`createSessionEventCollector`)
 * both consume it, so the two can never disagree about what a follow frame is.
 *
 * The classification mirrors the SSE event vocabulary:
 *   - `assistant-stream` items  → `{ kind: 'token', frame }`   (the live token channel)
 *   - `snapshot` items          → `{ kind: 'snapshot', payload }` (compacted)
 *   - any other item            → `{ kind: 'event', payload }`   (compacted durable record)
 *   - `error` frames            → `{ kind: 'host-error', failure }` (failure is a record or null)
 *   - `end` frames              → `{ kind: 'end' }`
 *
 * Anything else — unparseable text, a frame belonging to another logical
 * stream, an unknown frame type — is `null`, exactly the frames the SSE path
 * has always ignored.
 *
 * The watermark (`stripRecordsThrough`) is deliberately NOT applied here: it
 * belongs to whoever consumes the classified frame, because each consumer
 * carries its own watermark (the SSE stream's fixed `sinceSeq`, or the poller's
 * per-request cursor).
 *
 * @param {string} text one carrier WebSocket text frame
 * @param {string} streamId the logical stream id this consumer opened
 * @returns {{ kind: 'token', frame: unknown } | { kind: 'snapshot', payload: unknown } | { kind: 'event', payload: unknown } | { kind: 'host-error', failure: unknown } | { kind: 'end' } | null}
 */
export function parseSessionFollowEnvelope(text, streamId) {
  let frame
  try { frame = JSON.parse(text) } catch { return null }
  if (!isRecord(frame) || frame.streamId !== streamId) return null
  if (frame.type === 'item') {
    const value = frame.value
    if (isRecord(value) && value.type === 'assistant-stream') {
      return { kind: 'token', frame: value.frame }
    }
    return {
      kind: isRecord(value) && value.type === 'snapshot' ? 'snapshot' : 'event',
      payload: compactSessionFrame(value),
    }
  }
  if (frame.type === 'error') {
    return { kind: 'host-error', failure: isRecord(frame.error) ? frame.error : null }
  }
  if (frame.type === 'end') return { kind: 'end' }
  return null
}

/**
 * Per-bridge record of the last FAILED `turn/end` seen for each watched
 * conversation, keyed by sessionId.
 *
 * Why it lives here and not in the host projection: the host's `session/list`
 * rows carry no error field at all — `summaryFor(session)` enumerates a fixed
 * field set with no `error`/`lastError`/`status`, and no projection key in the
 * error family exists. The only real error signal is the EVENT `turn/end` with
 * `reason.kind === 'error'`. So the bridge has to keep its own tally from the
 * follow streams it already consumes; nothing downstream can synthesize it later
 * (a cold boot with no live stream has nothing to derive from).
 *
 * A `WeakMap` keyed by the bridge instance keeps this per-bridge (and per-test)
 * without adding a field to the bridge class — the class field list is
 * documented in `lib/bridge.js` next to the other maps and is being edited by
 * another line right now.
 *
 * Bound: the conversations a phone can watch concurrently — twice
 * `EVENT_COLLECTOR_SESSIONS_MAX`, the cap that already bounds the live follow
 * set, so the tally cannot outgrow it in a phone walking a long workspace list.
 * Same shape as `LanMobileBridge#noteStreamFailure`: delete-then-set recency,
 * drop the oldest past the cap.
 */
/** @type {WeakMap<object, Map<string, { kind: string, text: string, at: number }>>} */
const sessionErrorStores = new WeakMap()
/** Maximum remembered per-session failures (twice the live-follow cap). */
const SESSION_ERROR_MAX = EVENT_COLLECTOR_SESSIONS_MAX * 2

/**
 * @param {object} bridge
 * @returns {Map<string, { kind: string, text: string, at: number }>}
 */
function sessionErrorStore(bridge) {
  let store = sessionErrorStores.get(bridge)
  if (store === undefined) {
    store = new Map()
    sessionErrorStores.set(bridge, store)
  }
  return store
}

/**
 * Classify one follow frame as a turn boundary. Pure — no bridge state.
 *
 * The frame shape is read from the host's own consumers rather than guessed:
 * `lib/pages.js` `visibleMessages` does
 * `const e = entry.event || entry, d = e.data || {}, t = String(e.type || '').toLowerCase()`
 * and then branches on `reason.kind` / `reason.error.message` / `reason.error.code`
 * (and `test/turn-end-errors.test.js` builds `{ event: { type: 'turn/end', data: { reason } } }`).
 * `compactSessionFrame` preserves `type`/`data` at the top level and `event` when
 * the host wrapped it, so both spellings are handled here.
 *
 * `error` is the only kind the host describes in words (message, then code), and
 * the only one the task names. The rest of the transcript's error banners —
 * `aborted`, `blocked`, `max-tokens`, `interrupted` — must not CLEAR a recorded
 * failure either: an aborted turn leaves the previous failure unresolved, and
 * clearing there would restore the exact green check this projection exists to
 * remove (requirement 5, 2026-10-13). They `keep` the mark. Everything else
 * (`completed`, `forked`, an unrecognized kind) is a normal end and clears, so
 * one error does not stay on the row forever.
 *
 * @param {unknown} payload
 * @returns {{ verdict: 'record', kind: 'error', text: string } | { verdict: 'clear' } | { verdict: 'keep' } | { verdict: 'none' }}
 */
export function classifyTurnEndFrame(payload) {
  if (!isRecord(payload)) return { verdict: 'none' }
  const rec = isRecord(payload.event) ? payload.event : payload
  if (String(rec.type ?? '').toLowerCase() !== 'turn/end') return { verdict: 'none' }
  const reason = isRecord(rec.data) && isRecord(rec.data.reason) ? rec.data.reason : {}
  const kind = String(reason.kind ?? 'completed')
  if (kind === 'error') {
    const err = isRecord(reason.error) ? reason.error : undefined
    const text = String(err?.message ?? err?.code ?? 'error')
    return { verdict: 'record', kind: 'error', text }
  }
  // A turn that ended in a state the transcript still renders as an error banner:
  // leave whatever mark exists, and invent nothing.
  if (TURN_END_ERRORISH_KINDS.has(kind)) return { verdict: 'keep' }
  return { verdict: 'clear' }
}

/**
 * Record (or clear) one conversation's last turn failure.
 *
 * @param {object} bridge
 * @param {string} sessionId
 * @param {unknown} payload a classified `event` frame payload
 * @returns {void}
 */
export function noteSessionTurnEnd(bridge, sessionId, payload) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  const verdict = classifyTurnEndFrame(payload)
  if (verdict.verdict === 'none' || verdict.verdict === 'keep') return
  const store = sessionErrorStore(bridge)
  if (verdict.verdict === 'clear') {
    store.delete(sessionId)
    return
  }
  store.delete(sessionId)
  store.set(sessionId, { kind: verdict.kind, text: verdict.text, at: bridge.now() })
  while (store.size > SESSION_ERROR_MAX) {
    const oldest = store.keys().next().value
    if (oldest === undefined) return
    store.delete(oldest)
  }
}

/**
 * Carry the bridge-side error onto already-compacted session rows.
 *
 * Applied AFTER `compactSessionRows`, on fresh copies of the rows it touches,
 * for two reasons: the compaction filter only keeps small scalar values from
 * the host's own key set (so anything stamped before it would be dropped), and
 * copying means nothing is ever written back into the cached host `session/list`
 * value that other consumers share. Rows without a failure keep their original
 * identity — `lastError` must not suddenly exist on every row.
 *
 * The mark travels as `lastError` (a plain string, the field `lib/pages.js`
 * `taskState`/`wsFlagOf`/`subagentStateOf` already test) plus a `bridgeError`
 * object carrying the truth behind it — the kind, the text and the moment — so a
 * later reader can tell a bridge-derived mark from a host field that never
 * exists. `lastError` is truncated to the same per-row text budget the
 * compaction gives every other string on the row.
 *
 * @param {object} bridge
 * @param {Record<string, unknown>[]} rows compacted session rows
 * @returns {Record<string, unknown>[]}
 */
export function withSessionErrors(bridge, rows) {
  const store = sessionErrorStores.get(bridge)
  if (store === undefined || store.size === 0) return rows
  return rows.map((row) => {
    if (!isRecord(row)) return row
    const entry = store.get(String(row.sessionId ?? ''))
    if (entry === undefined) return row
    return {
      ...row,
      lastError: entry.text.slice(0, SESSION_ROW_TEXT_LIMIT),
      bridgeError: { kind: entry.kind, text: entry.text, at: entry.at },
    }
  })
}

/**
 * Build the `session/follow` request address for one session read.
 *
 * A subagent child session cannot be addressed with the ordinary
 * `kind:'session'` shape — the Host owns those identities with subagent
 * routing and refuses every ordinary read (`session/agent-busy`). The durable
 * parent address `{ kind:'subagent', childSessionId, parentSessionId, mode }`
 * is the one shape it accepts (validateAddress, dsh-api-session-controller
 * history.js). Parent id and mode travel verbatim from the parent's own
 * `subagentCatalog` projection; the Host re-checks both against the child's
 * descriptor, so a forged pair still fails closed (`subagent/unauthorized`).
 *
 * @param {string} sessionId the session to follow (a subagent child's id when
 *   `subagent` is given)
 * @param {{ parentSessionId: string, mode: string } | null | undefined} subagent
 *   present only when the caller explicitly asked for the subagent address
 * @returns {Record<string, unknown>}
 */
export function followAddressOf(sessionId, subagent) {
  const parent = subagent && typeof subagent === 'object' ? subagent.parentSessionId : undefined
  const mode = subagent && typeof subagent === 'object' ? subagent.mode : undefined
  if (typeof parent === 'string' && parent !== '' && typeof mode === 'string' && mode !== '') {
    return { kind: 'subagent', childSessionId: sessionId, parentSessionId: parent, mode }
  }
  return { kind: 'session', sessionId }
}

/**
 * @param {import('./bridge.js').LanMobileBridge} bridge
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} sessionId
 * @param {number} sinceSeq  Records at or below this sequence are already on
 *   the phone (it arrived through the handoff payload), so the opening
 *   snapshot only carries what is new. -1 sends everything.
 * @param {{ parentSessionId: string, mode: string } | null} [subagent] when
 *   given, the follow opens with the durable subagent address instead of the
 *   ordinary session one (see {@link followAddressOf}).
 */
export async function streamSession(bridge, request, response, sessionId, sinceSeq = -1, subagent = null) {
  let base
  try {
    base = bridge.options.harnessUrl()
  } catch (error) {
    // Reading the harness URL is a call into the host surface: while the host is
    // tearing down, the injected service can already be gone. That TypeError used
    // to be answered by the bridge-wide 500, with nothing saying which
    // conversation asked (same shape as M5, on the stream path).
    const detail = error instanceof Error ? error.message : String(error)
    bridge.log('warn', `session stream has no harness to follow session=${sessionId}: ${detail}`)
    return bridge.text(response, 503, 'Harness is not ready.')
  }
  if (!base) return bridge.text(response, 503, 'Harness is not ready.')
  const cookie = await bridge.options.innerAuth.ready()
  const url = new URL(REMOTE_STREAM_MUX_PATH, base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const streamId = `mobile-session-${randomUUID()}`
  const abort = new AbortController()
  bridge.sessionStreamAborts.add(abort)

  response.statusCode = 200
  response.setHeader('content-type', 'text/event-stream; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('connection', 'keep-alive')
  response.flushHeaders()
  // The reconnect cadence the phone is told to use. A conversation that has never
  // failed still gets the original 500ms — nothing about the healthy path
  // changes — while one the Host keeps refusing gets a longer wait each time,
  // because every reconnect opens ANOTHER carrier WebSocket into it (X4③/§3).
  const retryMs = bridge.streamRetryDelayMs(sessionId)
  response.write(`retry: ${String(retryMs)}\n\n`)

  // From the second consecutive failure on, an attempt that arrives before the
  // retry window this bridge published is answered here instead of being
  // forwarded. The first failure never gates, so a person reloading after one
  // blip still gets a real answer. The status code stays 200 — this is still the
  // SSE response the phone asked for, and what it learns comes from a `failure`
  // frame rather than a new code (design §12 禁令 4: observability only).
  const gated = bridge.streamCooldownMs(sessionId)
  if (gated > 0) {
    const retryInMs = Math.round(gated)
    bridge.log('warn', `session stream suppressed session=${sessionId} retryInMs=${String(retryInMs)}`)
    response.write(`event: failure\ndata: ${JSON.stringify({ message: 'The Host is not accepting this stream yet.', code: '__bridge/stream-backoff', reason: 'backoff', retryInMs })}\n\n`)
    bridge.sessionStreamAborts.delete(abort)
    response.end()
    return
  }

  const openedAt = bridge.now()
  await new Promise((resolve) => {
    // SSE keepalive: a comment frame every 15s keeps proxies from idling the
    // response out. Cleared in cleanup() on abort/close.
    const keepAlive = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) response.write(': ping\n\n')
    }, SSE_KEEPALIVE_MS)
    // Connection state rides the stream the phone already holds open, so the
    // client can stop polling /api/status while its stream is healthy. Both
    // timers are unref'd: a test or a shutdown must never be held open by a
    // stream's housekeeping.
    keepAlive.unref?.()
    const statusFrames = setInterval(() => {
      if (response.destroyed || response.writableEnded) return
      bridge.buildStatusPayload(request).then((body) => {
        if (!response.destroyed && !response.writableEnded) response.write(`event: status\ndata: ${JSON.stringify(body)}\n\n`)
      }).catch(() => {})
    }, bridge.sseStatusMs)
    statusFrames.unref?.()

    let socket
    try {
      socket = new WebSocket(url, { headers: cookie === undefined ? {} : { cookie } })
    } catch (error) {
      // A stream that could not even be attempted still releases the abort it
      // registered (otherwise `stop()` waits on a stream that never existed) and
      // still tells the phone, instead of ending the response in silence.
      const detail = error instanceof Error ? error.message : String(error)
      bridge.log('warn', `session stream could not be opened session=${sessionId}: ${detail}`)
      bridge.sessionStreamAborts.delete(abort)
      bridge.noteStreamFailure(sessionId)
      if (!response.writableEnded) response.end()
      resolve()
      return
    }

    // The platform WebSocket (this module runs on the Node global, not on npm
    // `ws`) raises 'error' asynchronously when close() aborts a socket that is
    // still CONNECTING — exactly what finish() below does to unwind on abort.
    // cleanup() has already removed the real handleError listener by the time
    // that fires, so without a permanent sink here that self-inflicted error
    // becomes an unhandled 'error' event and crashes the process. consumeMux
    // guards the same close pattern with the identical sink; keep the two in
    // lockstep.
    socket.addEventListener('error', () => {})
    let settled = false
    // `sawOpen` separates "the Host refused the connection" from "the Host took
    // it and then dropped it"; `lastActivityAt` separates "silent but live" from
    // "frozen". Both belong in the log line because both are what an operator is
    // asked to explain.
    let sawOpen = false
    let lastActivityAt = openedAt

    const handleOpen = () => {
      sawOpen = true
      lastActivityAt = bridge.now()
      socket.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint: 'session/follow',
        payload: {
          args: {
            request: { address: followAddressOf(sessionId, subagent), maxMessages: HISTORY_PAGE_DEFAULT_MESSAGES, turnWindow: { minMessages: 1, minTurns: 1 }, assistantStream: true }
          }
        }
      }))
    }

    /**
     * End this stream, once.
     *
     * @param {{ reason?: string, code?: string, message?: string, hostCode?: string }} [outcome]
     *   `code` is this module's own vocabulary. A transport message is never
     *   repeated to the phone or to the log: it can carry the internal URL.
     * @returns {void}
     */
    const finish = (outcome = {}) => {
      if (settled) return
      settled = true
      const reason = typeof outcome.reason === 'string' ? outcome.reason : 'closed'
      const ms = bridge.now() - openedAt
      const sinceLastFrame = bridge.now() - lastActivityAt
      cleanup()
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
      if (outcome.code === 'stream-transport') {
        // The carrier went away without the Host ever ending the stream. Until
        // this branch existed that was a silent `response.end()`: the phone's
        // dot stayed green, the transcript stayed frozen, and the log had
        // nothing — the exact「绿点+冻结」shape the audit reported (X4③).
        bridge.noteStreamFailure(sessionId)
        bridge.log('warn', `session stream lost session=${sessionId} opened=${sawOpen ? 'yes' : 'no'} ms=${String(ms)} sinceLastFrame=${String(sinceLastFrame)}`)
        // A stream that never reached `open` is the only transport failure that
        // can still be a credential problem: the platform WebSocket exposes no
        // handshake status, so a refused upgrade is indistinguishable from a
        // network fault here. Dropping the cached cookie costs one loopback GET
        // and is idempotent, so the reconnect `retry:` below asks for is not
        // sent into the same refused handshake. A stream that DID open and then
        // dropped keeps the credential — it was demonstrably accepted.
        if (!sawOpen) bridge.options.innerAuth.invalidate()
        if (!response.writableEnded && !response.destroyed) {
          const nextRetry = bridge.streamRetryDelayMs(sessionId)
          response.write(`event: failure\ndata: ${JSON.stringify({ message: outcome.message ?? 'Session stream lost.', code: `__bridge/${outcome.code}`, reason: 'transport', retryMs: nextRetry })}\n\n`)
          // Re-stating the cadence on the way out is what makes the NEXT
          // reconnect wait; the value sent at open was already spent on this one.
          response.write(`retry: ${String(nextRetry)}\n\n`)
        }
      } else if (outcome.code === 'host-error') {
        // The Host answered and refused this follow. That is an answer, not a
        // lost carrier, so it does not feed the reconnect backoff — the phone was
        // told once and `retry:` stays where it was.
        bridge.log('warn', `session stream refused session=${sessionId} code=${outcome.hostCode ?? '?'} ms=${String(ms)}`)
      } else if (outcome.code === 'stream-clean') {
        // The Host ended the follow normally: whatever backoff this conversation
        // had accumulated is no longer evidence of anything.
        bridge.noteStreamSuccess(sessionId)
        bridge.log('info', `session stream ended session=${sessionId} reason=${reason} ms=${String(ms)}`)
      } else if (reason === 'client-close' || reason === 'aborted') {
        // The phone left, or the bridge is shutting its streams down. Nothing
        // backs off and nothing failed; this line is only the audit trail.
        bridge.log('info', `session stream closed session=${sessionId} reason=${reason} ms=${String(ms)}`)
      } else {
        bridge.log('info', `session stream ended session=${sessionId} reason=${reason} ms=${String(ms)} sinceLastFrame=${String(sinceLastFrame)}`)
      }
      if (!response.writableEnded) response.end()
      resolve()
    }

    const handleMessage = (event) => {
      lastActivityAt = bridge.now()
      const text = typeof event.data === 'string'
        ? event.data
        : Buffer.isBuffer(event.data) ? event.data.toString('utf8') : undefined
      if (!text) return
      // Envelope parse + item classification is the shared collector logic
      // (`parseSessionFollowEnvelope`) — the polling endpoint consumes the very
      // same function, so the two transports cannot drift apart.
      const parsed = parseSessionFollowEnvelope(text, streamId)
      if (!parsed) return
      if (parsed.kind === 'token') {
        // Token-level streaming channel. The host still emits the durable
        // committed event after the stream ends, so no replay is invented.
        response.write(`event: token\ndata: ${JSON.stringify(parsed.frame)}\n\n`)
      } else if (parsed.kind === 'snapshot' || parsed.kind === 'event') {
        const payload = stripRecordsThrough(parsed.payload, sinceSeq)
        // The bridge keeps its own per-session error tally, because the host's
        // `session/list` rows carry no error field at all (see
        // `sessionErrorStores`). Snapshots carry records, not the turn boundary
        // itself, so only the live `event` path records a failure; `pages.js`
        // strips the records out of snapshots for the same reason.
        if (parsed.kind === 'event') noteSessionTurnEnd(bridge, sessionId, payload)
        // `stripRecordsThrough` filters the records ARRAY against the
        // watermark and always returns a frame: a single durable event at or
        // below the watermark is deliberately let through (commit `ef3d6fe`,
        // audit §1 P0-A fix 3) so a `turn/end` or `assistant/message` is never
        // swallowed. There is therefore no null to guard against here, and the
        // old comment describing a dropped frame described a branch that does
        // not exist.
        response.write(`event: ${parsed.kind}\ndata: ${JSON.stringify(payload)}\n\n`)
      } else if (parsed.kind === 'host-error') {
        // A failed follow must reach the phone with its reason. The old code
        // treated error and end identically and just closed the SSE, so the
        // mobile UI sat on its last painted frame with no error (user report
        // 2026-10-01: "错误的信息没有传递到手机上").
        const failure = parsed.failure
        const message = failure && typeof failure.message === 'string' && failure.message
          ? failure.message
          : 'Remote stream failed.'
        const hostCode = typeof failure?.code === 'string' ? failure.code : undefined
        if (!response.writableEnded) {
          // `reason` is the locale-free key the phone can branch on; `message`
          // stays exactly as it was, because `lib/pages.js`'s failure listener
          // prints it verbatim and `importantChatCopy` keys off its prefix.
          response.write(`event: failure\ndata: ${JSON.stringify({ message, code: hostCode, reason: 'host-error' })}\n\n`)
        }
        finish({ reason: 'host-error', code: 'host-error', hostCode })
      } else {
        finish({ reason: 'host-end', code: 'stream-clean' })
      }
    }

    const handleClose = () => {
      // A close the Host asked for arrives as an `end` frame first, which already
      // settled this stream — so reaching here means the carrier died on its own.
      finish({ reason: 'socket-close', code: 'stream-transport', message: 'Session stream lost.' })
    }
    const handleError = () => {
      finish({ reason: 'socket-error', code: 'stream-transport', message: 'Session stream could not reach the Host.' })
    }
    // The two ways the PHONE side ends this stream. Named, so cleanup() can
    // remove the very functions that were registered: an inline arrow handed to
    // `once` is not removable by identity, and the listener would then outlive
    // the request it was attached to.
    const onPhoneAway = () => finish({ reason: 'client-close' })
    const onAbort = () => finish({ reason: 'aborted' })
    const cleanup = () => {
      clearInterval(keepAlive)
      clearInterval(statusFrames)
      request.removeListener('close', onPhoneAway)
      abort.signal.removeEventListener('abort', onAbort)
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('close', handleClose)
      socket.removeEventListener('error', handleError)
      bridge.sessionStreamAborts.delete(abort)
    }

    request.once('close', onPhoneAway)
    abort.signal.addEventListener('abort', onAbort, { once: true })
    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', handleClose, { once: true })
    socket.addEventListener('error', handleError, { once: true })
    if (abort.signal.aborted) finish({ reason: 'aborted' })
  })
}

// ---------------------------------------------------------------------------
// Poll collector — the tunnel-mode half of the realtime story.
//
// A Cloudflare quick tunnel swallows every realtime SSE frame after the opening
// snapshot (2026-10-07 live probe: local ping=3 status=1, tunnel ping=0
// status=0), so in tunnel mode the phone polls instead. The Host only PUSHES
// session frames over an open `session/follow`, and that follow rides the
// bridge↔Host carrier (loopback) — the leg Cloudflare never touches. So the
// bridge keeps one follow open per polled session and buffers the classified
// frames; each poll drains what arrived since the caller's cursor.
//
// One collector per session, created lazily by the first poll, kept alive by
// polls, torn down after EVENT_COLLECTOR_IDLE_MS without one (nobody is
// watching) or by LRU past EVENT_COLLECTOR_SESSIONS_MAX. The underlying follow
// reconnects on its own ladder, exactly the way the phone's EventSource would;
// the SSE backoff ladder (`streamBackoff`) is deliberately NOT shared, because
// collector retries must never gate or be gated by a phone's SSE reconnects.
// ---------------------------------------------------------------------------

/**
 * Create one session's poll collector.
 *
 * @param {import('./bridge.js').LanMobileBridge} bridge
 * @param {string} sessionId
 * @param {{ parentSessionId: string, mode: string } | null} [subagent] when
 *   given, the follow opens with the durable subagent address instead of the
 *   ordinary session one (see {@link followAddressOf}).
 * @returns {{
 *   generation: string,
 *   touch(): void,
 *   idleMs(): number,
 *   poll(sinceSeq: number): { events: { seq: number, kind: 'token' | 'event', frame: unknown }[], latestSeq: number, overflow: boolean },
 *   stop(): void,
 * }}
 *   `generation` names this buffer's lifetime: a fresh collector (after idle
 *   teardown, eviction, or a bridge restart) generates a new one, and a poller
 *   that sees a different generation must re-sync its transcript from
 *   history/boot before trusting cursors again.
 */
export function createSessionEventCollector(bridge, sessionId, subagent = null) {
  const generation = randomUUID()
  /** @type {{ seq: number, kind: 'token' | 'event', frame: unknown }[]} */
  const entries = []
  let latestSeq = 0
  let stopped = false
  let carrierUp = false
  /** @type {string | undefined} last locale-free failure class, surfaced to pollers */
  let lastFailure
  let socket
  let retryTimer
  /** AbortController of the attempt currently in flight, for stop(). */
  let currentAbort
  let failures = 0
  let lastPollAt = bridge.now()
  /**
   * Held pollers waiting for this buffer to gain a frame. A poll that answers
   * `[]` the instant it is asked makes the phone re-issue on its backoff ladder,
   * so an idle conversation costs one tunnel round trip every 1.5–6 s and a live
   * one is up to 6 s behind. These waiters are how the bridge turns that inside
   * out: it keeps the request, and the frame itself releases it.
   * @type {Set<() => void>}
   */
  const waiters = new Set()
  const wakeWaiters = (reason) => {
    for (const wake of [...waiters]) wake(reason)
  }

  const clearRetry = () => {
    if (retryTimer === undefined) return
    clearTimeout(retryTimer)
    retryTimer = undefined
  }

  const push = (kind, frame) => {
    latestSeq += 1
    entries.push({ seq: latestSeq, kind, frame })
    if (entries.length > EVENTS_BUFFER_MAX_ENTRIES) {
      // Amortized trim: drop the older half, keep one contiguous window. A
      // cursor left behind by a stalled poller no longer connects, which the
      // next answer says plainly (`overflow: true`) instead of silently.
      entries.splice(0, entries.length - EVENTS_BUFFER_KEEP_ENTRIES)
    }
    wakeWaiters('frame')
  }

  const open = async () => {
    if (stopped) return
    let base
    try {
      base = bridge.options.harnessUrl()
    } catch (error) {
      // Same host-teardown shape as the SSE path (M5): the getter can throw
      // while the host is going away. The retry ladder answers it quietly.
      const detail = error instanceof Error ? error.message : String(error)
      bridge.log('warn', `session events collector has no harness session=${sessionId}: ${detail}`)
      scheduleRetry()
      return
    }
    if (!base) {
      scheduleRetry()
      return
    }
    let cookie
    try {
      cookie = await bridge.options.innerAuth.ready()
    } catch {
      scheduleRetry()
      return
    }
    const url = new URL(REMOTE_STREAM_MUX_PATH, base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const streamId = `mobile-events-${randomUUID()}`
    const abort = currentAbort = new AbortController()
    bridge.sessionStreamAborts.add(abort)
    let settled = false
    const current = new WebSocket(url, { headers: cookie === undefined ? {} : { cookie } })
    socket = current
    // Same self-inflicted-'error' sink as every other carrier socket in this
    // codebase: close() during CONNECTING raises an async 'error' that would
    // crash the process without a permanent listener.
    current.addEventListener('error', () => {})

    const cleanup = () => {
      abort.signal.removeEventListener('abort', onAbort)
      current.removeEventListener('open', handleOpen)
      current.removeEventListener('message', handleMessage)
      current.removeEventListener('close', handleClose)
      bridge.sessionStreamAborts.delete(abort)
    }
    /** One carrier attempt is over, for any reason. */
    const finishAttempt = () => {
      if (settled) return
      settled = true
      carrierUp = false
      cleanup()
      if (current.readyState === WebSocket.CONNECTING || current.readyState === WebSocket.OPEN) current.close()
      if (socket === current) socket = undefined
    }
    const onAbort = () => finishAttempt()
    const handleOpen = () => {
      carrierUp = true
      failures = 0
      lastFailure = undefined
      current.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint: 'session/follow',
        payload: {
          args: {
            request: { address: followAddressOf(sessionId, subagent), maxMessages: HISTORY_PAGE_DEFAULT_MESSAGES, turnWindow: { minMessages: 1, minTurns: 1 }, assistantStream: true }
          }
        }
      }))
    }
    const handleMessage = (event) => {
      const text = typeof event.data === 'string'
        ? event.data
        : Buffer.isBuffer(event.data) ? event.data.toString('utf8') : undefined
      if (!text) return
      const parsed = parseSessionFollowEnvelope(text, streamId)
      if (!parsed) return
      if (parsed.kind === 'token') {
        push('token', parsed.frame)
      } else if (parsed.kind === 'event') {
        push('event', parsed.payload)
        // Same bridge-side error tally as the SSE path above (`streamSession`):
        // this is the one place a poll collector sees the host's `turn/end`.
        // A subagent child's failure is the CHILD's mark, not the parent row's.
        if (!subagent) noteSessionTurnEnd(bridge, sessionId, parsed.payload)
      } else if (parsed.kind === 'host-error') {
        // The Host answered and refused this follow. A refusal is not a
        // transport hiccup: retrying it on the ladder re-asks the same Host the
        // same question for as long as the phone watches the conversation (a
        // session it will not follow stays unfollowable — 117 attempts per five
        // minutes, forever). Record it, tell the pollers, and let the phone's
        // own backoff ladder decide when to re-open the collector; the idle
        // teardown still ends an unwatched one.
        lastFailure = 'host-error'
        bridge.log('warn', `session events collector refused session=${sessionId}`)
        // The refusal has to reach a held poll, and it has to read as a death:
        // the holder's contract is `'frame'` or `'stopped'`, and a bare
        // `'host-error'` would leave the wait sitting out its whole ceiling
        // before the phone learned anything. Stop the collector instead — the
        // phone then re-asks on its own ladder and gets a fresh one.
        stopped = true
        clearRetry()
        finishAttempt()
        wakeWaiters('stopped')
      } else if (parsed.kind === 'end') {
        // The Host ended this follow the way it ends any follow it will not
        // continue. A phone's EventSource would reconnect on its `retry:`;
        // the collector does the same on its own ladder — without counting a
        // clean end as a transport failure.
        finishAttempt()
        scheduleRetry()
      }
      // `snapshot` is deliberately dropped: the collector carries INCREMENTS
      // only. Durable state reaches the phone through boot/history; replaying
      // the host's opening snapshot into the buffer would only duplicate what
      // history already served (and the watermark here is cursor-based, not
      // seq-based, so a snapshot would leak to every poller).
    }
    const handleClose = () => {
      finishAttempt()
      if (stopped) return
      lastFailure = 'transport'
      bridge.log('warn', `session events collector lost session=${sessionId} failures=${String(failures + 1)}`)
      scheduleRetry()
    }
    abort.signal.addEventListener('abort', onAbort, { once: true })
    current.addEventListener('open', handleOpen)
    current.addEventListener('message', handleMessage)
    current.addEventListener('close', handleClose, { once: true })
    if (abort.signal.aborted) onAbort()
  }

  const scheduleRetry = () => {
    if (stopped || retryTimer !== undefined) return
    const wait = Math.min(
      EVENT_COLLECTOR_RETRY_BASE_MS * 2 ** Math.min(failures, 10),
      EVENT_COLLECTOR_RETRY_CAP_MS
    )
    failures += 1
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void open()
    }, wait)
    // A test or a shutdown must never be held open by a collector's housekeeping.
    retryTimer.unref?.()
  }

  // Kick the first follow open; every later open comes from the retry ladder.
  // Called after both `open` and `scheduleRetry` are initialized, so the async
  // body can never reach them inside their temporal dead zone.
  void open()

  return {
    generation,
    /** Mark the collector watched; called by every poll. @returns {void} */
    touch() {
      lastPollAt = bridge.now()
    },
    /** Milliseconds since the last poll. @returns {number} */
    idleMs() {
      return bridge.now() - lastPollAt
    },
    /**
     * Live carrier observation, answered alongside polls so the phone can tell
     * "no new frames" apart from "the follow is down".
     * @returns {{ connected: boolean, failure: string | undefined }}
     */
    state() {
      return { connected: carrierUp, failure: lastFailure }
    },
    /**
     * Drain everything buffered after the caller's cursor.
     *
     * @param {number} sinceSeq the caller's cursor (the latestSeq of its
     *   previous answer; -1 = give whatever the window holds). This is a
     *   COLLECTOR cursor, not a Host record seq — tokens carry no Host seq, so
     *   the poll protocol numbers every buffered frame itself.
     * @returns {{ events: { seq: number, kind: 'token' | 'event', frame: unknown }[], latestSeq: number, overflow: boolean }}
     *   `overflow: true` says the caller's cursor predates the retained window:
     *   frames were trimmed away, and the caller must re-sync its transcript
     *   from history/boot before continuing.
     */
    poll(sinceSeq) {
      const overflow = sinceSeq >= 0 && entries.length > 0 && sinceSeq < entries[0].seq - 1
      const events = overflow
        ? []
        : entries.filter((entry) => entry.seq > sinceSeq).map((entry) => ({ seq: entry.seq, kind: entry.kind, frame: entry.frame }))
      return { events, latestSeq, overflow }
    },
    /** Tear the collector down: no further opens, no retries, socket closed. @returns {void} */
    stop() {
      if (stopped) return
      stopped = true
      clearRetry()
      currentAbort?.abort()
      // A holder must not sit out its ceiling for a follow that no longer exists.
      wakeWaiters('stopped')
    },
    /**
     * Watch the buffer from outside. Called with `'frame'` when a frame lands OR
     * `'stopped'` when the collector dies, so a held poll always gets an answer —
     * never a request abandoned to a timeout because nobody told it the source
     * was gone.
     * @param {(reason: 'frame' | 'stopped') => void} wake
     * @returns {() => void} stop watching; the caller must run this on every
     *   exit path (frame, stop, timeout, client disconnect).
     */
    onFrames(wake) {
      waiters.add(wake)
      return () => { waiters.delete(wake) }
    },
  }
}
