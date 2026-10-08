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
 *  - innerAuth:          Process credential with `ready()`/`invalidate()`
 *  - pendingQuestions:   Map cleared on reconnect/base change/failure — every
 *                      path that clears it reports the loss (see
 *                      `clearPendingQuestions`)
 *  - pendingQuestionEvictions: () => number, the bridge's lifetime count of
 *                      questions the ceiling in `rememberPendingQuestion` threw
 *                      out — printed as `evictedLifetime=` so one line tells both
 *                      ways the table shrinks on its own, and says which of them
 *                      this line is about
 *  - log(level, message)
 *  - now():              timestamp for stability window
 *  - consumeMuxEnvelope(data): carrier-frame consumer
 *  - setEventClientId(id): flush event-stream client id on open
 *  - reportMuxState(up): live carrier state, for the status surface
 *
 * @param {Object} context
 * @param {() => string | undefined} context.harnessUrl
 * @param {{ ready(): Promise<string | undefined>, invalidate(): void }} context.innerAuth
 * @param {Map} context.pendingQuestions
 * @param {() => number} [context.pendingQuestionEvictions]
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
    pendingQuestionEvictions,
    log,
    now,
    consumeMuxEnvelope,
    setEventClientId,
    reportMuxState
  } = context

  /**
   * Which of the five paths below dropped the table. An enum, not prose, and not
   * an identity: it is the only part of the line that says WHY, so it has to be
   * greppable without saying anything about what was lost.
   * @typedef {'no-url' | 'no-base' | 'base-changed' | 'downlink-lost' | 'carrier-open'} ClearPath
   */

  /**
   * Drop the unanswered questions this downlink was holding, and say out loud
   * that it happened, and say which path did it.
   *
   * The table is a push-only projection: a question arrives as one `waterfall`
   * frame on this carrier and nothing rebuilds it. So every clear here destroys
   * a prompt the operator may still be looking at, and until now four of the
   * five paths did it in complete silence — which is what made "the question
   * walked off by itself" unreproducible. Worse, the silent one that fires on
   * every carrier drop ran BEFORE the path that had a line, so the table was
   * already empty by the time anything was counting it: the drop, not the open,
   * is what eats the questions (measured 10-08: three prompts lost through the
   * loop, zero lines written). All five paths report through here now.
   *
   * Counts and labels only, never an identity: the keys of this Map are the
   * Host's event ids and the prose of a question is not this log's to hold (the
   * same rule `lib/bridge.js` keeps on its refusal and eviction lines). A
   * conversation id is not a count either, so the per-session picture is
   * reduced to two numbers that are NOT each other: how many conversations
   * hold a lost prompt, and the largest pile inside one of them — the depth a
   * phone sees when several questions for one session stack up and only one of
   * them is ever offered. `dropped` is everything that went, including any
   * entry too malformed to name a session, so the three can disagree, and each
   * disagreement means something.
   *
   * An empty table logs nothing: this runs up to five times per reconnect cycle,
   * and the carrier flaps on the order of seconds, so a line per empty clear
   * would bury the lines that mean something.
   * @param {ClearPath} via
   * @returns {void}
   */
  const clearPendingQuestions = (via) => {
    const dropped = pendingQuestions.size
    if (dropped === 0) return
    let backlog = 0
    /** @type {Map<string, number>} */
    const perSession = new Map()
    for (const held of pendingQuestions.values()) {
      const sessionId = held !== null && typeof held === 'object' && typeof held.sessionId === 'string'
        ? held.sessionId
        : undefined
      if (sessionId === undefined) continue
      const piled = (perSession.get(sessionId) ?? 0) + 1
      perSession.set(sessionId, piled)
      if (piled > backlog) backlog = piled
    }
    const sessions = perSession.size
    const evictedLifetime = typeof pendingQuestionEvictions === 'function' ? pendingQuestionEvictions() : 0
    // Count, then drop, then report. The clear is what this call is FOR; the
    // line is a side effect of it. `log` here is an injected sink whose
    // contract is only `(level, message) => void` — nothing in this module's
    // contract says it cannot throw, and a sink that threw must not get to
    // decide whether the operator's prompts stay in a dead table.
    pendingQuestions.clear()
    log(
      'warn',
      `pending questions cleared via=${via} dropped=${String(dropped)} sessions=${String(sessions)} backlog=${String(backlog)} evictedLifetime=${String(evictedLifetime)}`
    )
  }

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
        clearPendingQuestions('no-url')
        await backOff()
        continue
      }
      if (!base) {
        // Nothing to follow, so nothing that could still be answered: the table
        // dies here too, and says so. This branch parks between rounds, but an
        // empty table writes no line, so it stays quiet unless it held something.
        clearPendingQuestions('no-base')
        await backOff()
        continue
      }
      if (base !== lastBase) {
        clearPendingQuestions('base-changed')
        // The process credential is bound to the authority that minted it
        // (normalized hostname + port), and `harnessUrl()` is re-read every
        // round: a Host that comes back on a different port hands out a launch
        // URL the cached cookie no longer matches. A base change therefore
        // drops the credential along with everything else this branch already
        // treats as stale — otherwise the downlink retries a cookie the Host
        // must refuse until the TTL expires ten minutes later. Redeeming again
        // is one loopback GET against a launch token that never rotates.
        innerAuth.invalidate()
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
        // This is the path that actually eats the operator's prompts: a question
        // can only arrive while the carrier is up, so a carrier that goes down
        // takes whatever it had just handed over with it, seconds before the
        // reopen below sees an empty table. Counted and named like every other
        // clear here.
        clearPendingQuestions('downlink-lost')
        // An attempt that never reached `open` is the only downlink failure
        // this side can still blame on the credential: the platform WebSocket
        // exposes no handshake status (npm `ws`'s `unexpected-response` event
        // does not exist on it), so a refused upgrade and a network fault are
        // indistinguishable from out here. Redeeming again costs one loopback
        // GET and is idempotent, so the retry below is never held back by a
        // cookie that was just rejected. A socket that DID open and then
        // dropped is a different story — a transient carrier fault whose
        // credential was demonstrably accepted — and is deliberately spared.
        if (openedAt === undefined) innerAuth.invalidate()
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
    const cookie = await innerAuth.ready(signal)
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: cookie === undefined ? {} : { cookie }
      })
      // The platform WebSocket (this module runs on the Node global, not on npm
      // `ws`) raises 'error' asynchronously when close() aborts a socket that is
      // still CONNECTING — exactly what finish() below does to unwind on abort.
      // cleanup() has already removed the real handleError listener by the time
      // that fires, so without a permanent sink here that self-inflicted error
      // becomes an unhandled 'error' event and crashes the process.
      // `streamSession` guards the same close pattern with the identical sink;
      // keep the two in lockstep.
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
        clearPendingQuestions('carrier-open')
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
