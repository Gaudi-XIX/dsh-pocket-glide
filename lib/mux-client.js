import {
  EVENT_STREAM_ID,
  MUX_RECONNECT_CAP_MS,
  MUX_RECONNECT_MS,
  MUX_STABLE_MS,
  REMOTE_EVENT_STREAM_ENDPOINT,
  REMOTE_STREAM_MUX_PATH,
  WORKSPACE_STREAM_ID
} from './constants.js'

/**
 * Standalone mux downlink factory. The context exposes:
 *  - harnessUrl():       Base URL getter
 *  - innerAuth:          Process credential with `ready()`
 *  - pendingQuestions:   Map cleared on reconnect/base change/failure
 *  - log(level, message)
 *  - now():              timestamp for stability window
 *  - consumeMuxEnvelope(data): carrier-frame consumer
 *  - setEventClientId(id): flush event-stream client id on open
 *  - reportMuxState(up): live carrier state, for the status surface
 *
 * @param {Object} context
 * @param {() => string | undefined} context.harnessUrl
 * @param {{ ready(): Promise<string | undefined> }} context.innerAuth
 * @param {Map} context.pendingQuestions
 * @param {(level: string, message: string) => void} context.log
 * @param {() => number} context.now
 * @param {(data: string) => void} context.consumeMuxEnvelope
 * @param {(id: string | undefined) => void} context.setEventClientId
 * @param {(up: boolean) => void} [context.reportMuxState]
 * @returns {{ monitorMux: (signal: AbortSignal) => Promise<void>, consumeMux: (base: string, signal: AbortSignal, onOpen?: () => void) => Promise<void> }}
 */
export function createMuxMonitor(context) {
  const {
    harnessUrl,
    innerAuth,
    pendingQuestions,
    log,
    now,
    consumeMuxEnvelope,
    setEventClientId,
    reportMuxState
  } = context

  /**
   * @param {number} milliseconds
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   */
  const waitFor = (milliseconds, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const timeout = setTimeout(done, milliseconds)
      function done() {
        clearTimeout(timeout)
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
    })

  /**
   * @param {{
   *   open(): void
   *   close(): void
   * }} [onState] Live-carrier state, read by `/api/status` so the phone can tell
   *   "the bridge answered" apart from "the Host is actually reachable".
   * @returns {Promise<void>}
   */
  /** @param {AbortSignal} signal @returns {Promise<void>} */
  async function monitorMux(signal) {
    let lastBase
    // A Harness that never accepts the downlink used to be retried at a flat
    // 500ms for as long as the app ran. Backing off turns a permanent failure
    // into two attempts a minute instead of a hundred.
    let backoffMs = MUX_RECONNECT_MS
    const backOff = async () => {
      await waitFor(backoffMs, signal)
      backoffMs = Math.min(backoffMs * 2, MUX_RECONNECT_CAP_MS)
    }

    while (!signal.aborted) {
      // Getting the base URL is a call into the host surface, not a read of a
      // local string: while the host is tearing down, the injected `webServer`
      // can already be gone and the getter throws. Outside this try that threw
      // straight out of `monitorMux`, which the bridge awaited through no
      // handler of its own — an unhandled rejection in the host process (M5).
      let base
      try {
        base = harnessUrl()
      } catch (error) {
        if (signal.aborted) return
        log('warn', `mux has no harness URL to follow${error instanceof Error ? `: ${error.message}` : ''}`)
        pendingQuestions.clear()
        await backOff()
        continue
      }
      if (!base) {
        pendingQuestions.clear()
        await backOff()
        continue
      }
      if (base !== lastBase) {
        pendingQuestions.clear()
        lastBase = base
        backoffMs = MUX_RECONNECT_MS
      }
      let openedAt
      try {
        await consumeMux(base, signal, () => {
          openedAt = now()
        })
        backoffMs = MUX_RECONNECT_MS
      } catch (error) {
        if (signal.aborted) return
        log('warn', `mux downlink lost${error instanceof Error ? `: ${error.message}` : ''}`)
        pendingQuestions.clear()
        // A connection that held for a while and then dropped is a transient
        // fault, not a Harness that refuses the downlink: retry promptly.
        if (openedAt !== undefined && now() - openedAt >= MUX_STABLE_MS) {
          backoffMs = MUX_RECONNECT_MS
        }
        await backOff()
      }
    }
  }

  /**
   * @param {string} base
   * @param {AbortSignal} signal
   * @param {() => void} [onOpen]
   * @returns {Promise<void>}
   */
  async function consumeMux(base, signal, onOpen) {
    // 0.1.2-alpha.1 replaced the event mux with the Gateway stream carrier:
    // one WebSocket multiplexing logical streams, each opened by name. The
    // forwarded-event stream is `$events`, and the upgrade itself is
    // authenticated, so it carries the same session cookie as the unary calls.
    const url = new URL(REMOTE_STREAM_MUX_PATH, base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const cookie = await innerAuth.ready()
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: cookie === undefined ? {} : { cookie }
      })
      // `ws` raises 'error' asynchronously when close() aborts a still-CONNECTING
      // socket ("WebSocket was closed before the connection was established") —
      // exactly what finish() below does to unwind on abort. cleanup() has
      // already removed the real handleError listener by the time that fires,
      // so without a permanent sink here that self-inflicted error becomes an
      // unhandled 'error' event and crashes the process.
      socket.addEventListener('error', () => {})
      let settled = false
      const cleanup = () => {
        signal.removeEventListener('abort', handleAbort)
        socket.removeEventListener('open', handleOpen)
        socket.removeEventListener('message', handleMessage)
        socket.removeEventListener('close', handleClose)
        socket.removeEventListener('error', handleError)
      }
      const finish = (error) => {
        if (settled) return
        settled = true
        cleanup()
        reportMuxState?.(false)
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
          socket.close()
        }
        if (error) reject(error)
        else resolve()
      }
      const handleAbort = () => finish()
      const handleOpen = () => {
        onOpen?.()
        reportMuxState?.(true)
        pendingQuestions.clear()
        setEventClientId(undefined)
        // Two logical streams share this carrier: the forwarded events that
        // raise questions, and the workspace projection whose opening
        // `baseline` frame is the list the Host no longer serves unary.
        socket.send(JSON.stringify({
          type: 'open',
          streamId: EVENT_STREAM_ID,
          endpoint: REMOTE_EVENT_STREAM_ENDPOINT,
          payload: { args: {} }
        }))
        socket.send(JSON.stringify({
          type: 'open',
          streamId: WORKSPACE_STREAM_ID,
          endpoint: 'workspace/follow',
          payload: { args: {} }
        }))
      }
      const handleMessage = (event) => {
        const data = event.data
        if (typeof data === 'string') consumeMuxEnvelope(data)
        else if (Buffer.isBuffer(data)) consumeMuxEnvelope(data.toString('utf8'))
      }
      const handleClose = () => {
        finish(signal.aborted ? undefined : new Error('Harness mux WebSocket closed.'))
      }
      const handleError = () => finish(new Error('Harness mux WebSocket failed.'))
      socket.addEventListener('open', handleOpen)
      socket.addEventListener('message', handleMessage)
      socket.addEventListener('close', handleClose, { once: true })
      socket.addEventListener('error', handleError, { once: true })
      signal.addEventListener('abort', handleAbort, { once: true })
      if (signal.aborted) handleAbort()
    })
  }

  return { monitorMux, consumeMux }
}
