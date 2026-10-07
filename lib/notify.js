/**
 * Outbound completion notifications (design #2): one call, three push
 * channels, fire-and-forget from the caller.
 *
 * The secrecy contract (design D6) is absolute and shape-only: a failure note
 * names the HTTP status or the error CLASS NAME and nothing else. Error
 * messages are deliberately not logged — a fetch failure message can quote the
 * URL it was given, and both the ServerChan and Bark URLs carry the key in the
 * path/query. The same rule masks every readback (`maskKey`).
 *
 * One deliberate exception, scoped to WxPusher: it reports business failures
 * (a bad token, no subscribed user) as HTTP 200 with a body `{code, msg}` —
 * only body `code === 1000` means delivered, so `response.ok` alone was the
 * old "200 but not delivered" false success. The failure note may quote that
 * peer-supplied `msg` because it is the peer's own verdict, not our secret —
 * and even there, any occurrence of the key inside the message is masked
 * before it is logged.
 */

/** Default hard cap on one push delivery. */
const NOTIFY_TIMEOUT_MS = 8000

const WXPUSHER_SEND_URL = 'https://wxpusher.zjiecode.com/api/send/message'
const WXPUSHER_SIMPLE_PUSH_URL = 'https://wxpusher.zjiecode.com/api/send/message/simple-push'
/** WxPusher body codes: 1000 is the only "delivered". */
const WXPUSHER_CODE_OK = 1000
/** WxPusher keeps `summary` to one banner line; cap it before it leaves. */
const WXPUSHER_SUMMARY_MAX = 100
/** A personal Simple Push Token is `spt.…`; anything else reads as an appToken. */
const WXPUSHER_SPT_PREFIX = /^spt\./i

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
 * The WxPusher failure note quotes the peer's `msg` for diagnosis; this keeps
 * the secrecy contract intact should the peer ever echo the token back.
 * @param {string} text
 * @param {string} key
 * @returns {string}
 */
function scrubKey(text, key) {
  if (typeof text !== 'string' || text === '' || key === '') return ''
  return text.split(key).join('••••')
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
 * @returns {Promise<boolean>} true when the channel accepted the push — 2xx,
 *   and for WxPusher also the body's business code 1000
 */
export async function notifySend(config, title, body, hooks = {}) {
  if (config?.enabled === false) return false
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
      // The key's shape picks the endpoint: an `spt.` personal token goes to
      // the simple-push API (no app, no uid — the personal-setup path);
      // anything else stays an appToken on the classic send API. Both answer
      // the same `{code, msg}` envelope, so the verdict check below covers
      // both — that check is what kills the old false success.
      const isSpt = WXPUSHER_SPT_PREFIX.test(key)
      response = await fetchImpl(isSpt ? WXPUSHER_SIMPLE_PUSH_URL : WXPUSHER_SEND_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(isSpt ? { spt: key } : { appToken: key }),
          summary: String(title).slice(0, WXPUSHER_SUMMARY_MAX),
          content: body,
          contentType: 1
        }),
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
    const text = await response.text().catch(() => '')
    if (channel === 'wxpusher') {
      let verdict = null
      try {
        verdict = JSON.parse(text)
      } catch {
        verdict = null
      }
      if (!verdict || typeof verdict !== 'object' || verdict.code !== WXPUSHER_CODE_OK) {
        // The remote msg is untrusted prose: strip control characters and cap
        // its length before it can reach the log (a hijacked endpoint must not
        // be able to forge multi-line log rows or bloat the file).
        const raw = typeof verdict?.msg === 'string' ? verdict.msg : ''
        const safeMsg = raw.replace(/[\r\n\t\x00-\x1f]/g, ' ').slice(0, 160)
        const detail =
          verdict && typeof verdict === 'object'
            ? `wxpusher code=${verdict.code}${safeMsg !== '' ? ` ${scrubKey(safeMsg, key)}` : ''}`
            : 'wxpusher code unreadable (HTTP 200, body not the expected JSON)'
        log?.('warn', `notify send failed: ${detail}`)
        return false
      }
    }
    return true
  } catch (error) {
    log?.('warn', `notify send failed: ${errorClassName(error)}`)
    return false
  } finally {
    clearTimeout(timer)
  }
}
