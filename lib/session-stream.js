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
  const base = bridge.options.harnessUrl()
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
  response.write('retry: 500\n\n')

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
    const socket = new WebSocket(url, { headers: cookie === undefined ? {} : { cookie } })
    // `ws` raises 'error' asynchronously when close() aborts a still-CONNECTING
    // socket ("WebSocket was closed before the connection was established") —
    // exactly what finish() below does to unwind on abort. cleanup() has
    // already removed the real handleError listener by the time that fires,
    // so without a permanent sink here that self-inflicted error becomes an
    // unhandled 'error' event and crashes the process. consumeMux guards the
    // same close pattern with the identical sink; keep the two in lockstep.
    socket.addEventListener('error', () => {})
    let settled = false
    const cleanup = () => {
      clearInterval(keepAlive)
      clearInterval(statusFrames)
      request.removeListener('close', finish)
      abort.signal.removeEventListener('abort', finish)
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('close', handleClose)
      socket.removeEventListener('error', handleError)
      bridge.sessionStreamAborts.delete(abort)
    }
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
      if (!response.writableEnded) response.end()
      resolve()
    }
    const handleOpen = () => {
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
    const handleMessage = (event) => {
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
        if (!response.writableEnded) {
          response.write(`event: failure\ndata: ${JSON.stringify({ message, code: typeof failure?.code === 'string' ? failure.code : undefined })}\n\n`)
        }
        finish()
      } else if (frame.type === 'end') {
        finish()
      }
    }
    const handleClose = () => finish()
    const handleError = () => finish()
    request.once('close', finish)
    abort.signal.addEventListener('abort', finish, { once: true })
    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', handleClose, { once: true })
    socket.addEventListener('error', handleError, { once: true })
    if (abort.signal.aborted) finish()
  })
}
