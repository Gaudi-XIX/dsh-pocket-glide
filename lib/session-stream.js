import { randomUUID } from 'node:crypto'
import { REMOTE_STREAM_MUX_PATH, SSE_KEEPALIVE_MS } from './constants.js'
import { compactSessionFrame, isRecord, stripRecordsThrough } from './projections.js'

/**
 * @param {import('./bridge.js').LanMobileBridge} bridge
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} sessionId
 * @param {number} sinceSeq  Records at or below this sequence are already on
 *   the phone (it arrived through the handoff payload), so the opening
 *   snapshot only carries what is new. -1 sends everything.
 */
export async function streamSession(bridge, request, response, sessionId, sinceSeq = -1) {
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
    response.write(`event: failure\ndata: ${JSON.stringify({ message: 'The Host is not accepting this stream yet.', code: '__bridge/stream-backoff', retryInMs })}\n\n`)
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

    // `ws` raises 'error' asynchronously when close() aborts a still-CONNECTING
    // socket ("WebSocket was closed before the connection was established") —
    // exactly what finish() below does to unwind on abort. cleanup() has
    // already removed the real handleError listener by the time that fires,
    // so without a permanent sink here that self-inflicted error becomes an
    // unhandled 'error' event and crashes the process. consumeMux guards the
    // same close pattern with the identical sink; keep the two in lockstep.
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
            request: { address: { kind: 'session', sessionId }, maxMessages: 30, turnWindow: { minMessages: 1, minTurns: 1 }, assistantStream: true }
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
        if (!response.writableEnded && !response.destroyed) {
          const nextRetry = bridge.streamRetryDelayMs(sessionId)
          response.write(`event: failure\ndata: ${JSON.stringify({ message: outcome.message ?? 'Session stream lost.', code: `__bridge/${outcome.code}`, retryMs: nextRetry })}\n\n`)
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
      let frame
      try { frame = JSON.parse(text) } catch { return }
      if (!isRecord(frame) || frame.streamId !== streamId) return
      if (frame.type === 'item') {
        const value = frame.value
        if (isRecord(value) && value.type === 'assistant-stream') {
          // Token-level streaming channel. The host still emits the durable
          // committed event after the stream ends, so no replay is invented.
          response.write(`event: token\ndata: ${JSON.stringify(value.frame)}\n\n`)
        } else {
          const eventName = isRecord(value) && value.type === 'snapshot' ? 'snapshot' : 'event'
          const payload = stripRecordsThrough(compactSessionFrame(value), sinceSeq)
          // A fully-superseded frame is dropped, except the snapshot itself:
          // the phone must still learn that its stream is live.
          if (payload !== null) response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
        }
      } else if (frame.type === 'error') {
        // A failed follow must reach the phone with its reason. The old code
        // treated error and end identically and just closed the SSE, so the
        // mobile UI sat on its last painted frame with no error (user report
        // 2026-10-01: "错误的信息没有传递到手机上").
        const failure = isRecord(frame.error) ? frame.error : null
        const message = failure && typeof failure.message === 'string' && failure.message
          ? failure.message
          : 'Remote stream failed.'
        const hostCode = typeof failure?.code === 'string' ? failure.code : undefined
        if (!response.writableEnded) {
          response.write(`event: failure\ndata: ${JSON.stringify({ message, code: hostCode })}\n\n`)
        }
        finish({ reason: 'host-error', code: 'host-error', hostCode })
      } else if (frame.type === 'end') {
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
