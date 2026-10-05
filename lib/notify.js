/**
 * Outbound completion notifications (design #2): one call, three push
 * channels, fire-and-forget from the caller.
 *
 * The secrecy contract (design D6) is absolute and shape-only: a failure note
 * names the HTTP status or the error CLASS NAME and nothing else. Error
 * messages are deliberately not logged — a fetch failure message can quote the
 * URL it was given, and both the ServerChan and Bark URLs carry the key in the
 * path/query. The same rule masks every readback (`maskKey`).
 */

/** Default hard cap on one push delivery. */
const NOTIFY_TIMEOUT_MS = 8000

/**
 * Mask a secret for readback and logs: short keys are hidden outright, longer
 * ones keep just enough to tell two keys apart.
 * @param {unknown} key
 * @returns {string}
 */
export function maskKey(key) {
  if (typeof key !== 'string' || key.length === 0) return ''
  if (key.length <= 8) return '•'.repeat(key.length)
  return `${key.slice(0, 2)}…${key.slice(-4)}`
}

/** @param {unknown} value */
function enc(value) {
  return encodeURIComponent(String(value))
}

/** The error class name only — never `error.message`, which can carry a URL. */
function errorClassName(error) {
  if (error instanceof Error && error.name) return error.name
  return 'Error'
}

/**
 * Deliver one notification. Never throws: every failure is reported through
 * `log('warn', …)` and answered as `false`, so a dead push channel cannot turn
 * into an unhandled rejection on a fire-and-forget call site.
 *
 * @param {{ channel?: unknown, key?: unknown, enabled?: boolean }} config the notify section of the settings document
 * @param {string} title notification title (first line on most channels)
 * @param {string} body notification body
 * @param {{
 *   fetchImpl?: typeof fetch
 *   timeoutMs?: number
 *   log?: (level: 'info' | 'warn' | 'error', message: string) => void
 * }} [hooks]
 * @returns {Promise<boolean>} true when the channel answered 2xx
 */
export async function notifySend(config, title, body, hooks = {}) {
  const { fetchImpl = fetch, timeoutMs = NOTIFY_TIMEOUT_MS, log } = hooks
  const channel = typeof config?.channel === 'string' ? config.channel : 'off'
  const key = typeof config?.key === 'string' ? config.key : ''
  if (channel === 'off' || key === '') return false

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    let response
    if (channel === 'serverchan') {
      response = await fetchImpl(
        `https://sctapi.ftqq.com/${enc(key)}.send?title=${enc(title)}&desp=${enc(body)}`,
        { signal: controller.signal }
      )
    } else if (channel === 'bark') {
      // Every path segment is encoded on its own: a raw `/` in a title would
      // silently become a second path segment on the Bark API.
      response = await fetchImpl(
        `https://api.day.app/${enc(key)}/${enc(title)}/${enc(body)}`,
        { signal: controller.signal }
      )
    } else if (channel === 'wxpusher') {
      response = await fetchImpl('https://wxpusher.zjiecode.com/api/send/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appToken: key, summary: title, content: body, contentType: 1 }),
        signal: controller.signal
      })
    } else {
      return false
    }
    if (!response.ok) {
      log?.('warn', `notify send failed: HTTP ${response.status}`)
      return false
    }
    // Drain the (tiny) answer so the socket is released at once.
    await response.text().catch(() => '')
    return true
  } catch (error) {
    log?.('warn', `notify send failed: ${errorClassName(error)}`)
    return false
  } finally {
    clearTimeout(timer)
  }
}
