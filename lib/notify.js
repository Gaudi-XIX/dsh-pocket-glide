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

/**
 * Default hard cap on one push delivery.
 *
 * 8s was too tight for the channel this machine actually uses: 本机实测 2026-10-09
 * 一次真发送单程 2442 ms，而**走本地代理**（`HTTPS_PROXY` → 127.0.0.1:12450）冷连接
 * 那一趟超过 8 秒，桌面「测试」就报了 `notify send failed: AbortError`（热的代理路径
 * 2.66 s、直连 0.32 s 都在旧的 8s 内）。这是**首个请求的 TLS+CONNECT 冷启动**，不是
 * 服务慢，所以放余量而不是加重试：一条通知值得迟到，不值得被一次握手抖动吃掉。
 */
const NOTIFY_TIMEOUT_MS = 15000

import { sendTextMessage } from './clawbot.js'

const WXPUSHER_SEND_URL = 'https://wxpusher.zjiecode.com/api/send/message'
const WXPUSHER_SIMPLE_PUSH_URL = 'https://wxpusher.zjiecode.com/api/send/message/simple-push'
/** WxPusher body codes: 1000 is the only "delivered". */
const WXPUSHER_CODE_OK = 1000
/** Server酱（Turbo）body codes: 0 is the only "delivered"（见下方 serverchan 分支）. */
const SERVERCHAN_CODE_OK = 0
/** WxPusher keeps `summary` to one banner line; cap it before it leaves. */
const WXPUSHER_SUMMARY_MAX = 100
/**
 * A personal Simple Push Token is `SPT_…` (real-world shape, underscore) — the
 * docs' prose once showed `spt.` (dot), and both reach the same simple-push
 * API, so either prefix reads as a personal token; anything else is appToken.
 * Misrouting a real `SPT_` token to the classic API answers 1001
 * `appToken不正确` (live hit 2026-10-09), hence the tolerant match.
 */
const WXPUSHER_SPT_PREFIX = /^spt[._]/i

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
      // The key's shape picks the endpoint: an `SPT_`/`spt.` personal token
      // goes to the simple-push API (no app, no uid — the personal-setup
      // path); anything else stays an appToken on the classic send API. Both answer
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
    } else if (channel === 'clawbot') {
      const claw = config?.clawbot || {}
      const contextToken = claw.contextToken
      const toUserId = claw.userId || ''
      if (!contextToken) {
        log?.('warn', 'notify send failed: clawbot context_token missing')
        return false
      }
      const text = `${title}\n\n${body}`
      const result = await sendTextMessage(key, { contextToken, toUserId, text }, {
        fetchImpl,
        signal: controller.signal
      })
      if (!result.ok) {
        const detail = scrubKey(result.error, key)
        log?.('warn', `notify send failed: clawbot ${detail}`)
        return false
      }
      if (/^[0-9]+$/.test(result.messageId)) {
        log?.('info', `notify sent: clawbot ok message_id=${result.messageId}`)
      } else {
        log?.('info', 'notify sent: clawbot ok')
      }
      return true
    } else {
      return false
    }
    if (!response.ok) {
      log?.('warn', `notify send failed: HTTP ${response.status}`)
      return false
    }
    // Drain the (tiny) answer so the socket is released at once.
    const text = await response.text().catch(() => '')
    if (channel === 'serverchan') {
      // Server酱 answers HTTP 200 even for a business failure, so `response.ok`
      // alone was a false success. 本机实测 2026-10-09：错 Key 回 200 + `{code:40001}`，
      // 成功回 200 + `{code:0,message,data:{pushid,readkey,error,errno}}`。判据与
      // wxpusher 拉平 —— 只有 body `code === 0` 才算送达。只记 code，不记 message/data
      // （沿用 D6：失败理由不进日志，回显体不保证不含敏感串）。
      let verdict = null
      try {
        verdict = JSON.parse(text)
      } catch {
        verdict = null
      }
      if (!verdict || typeof verdict !== 'object' || verdict.code !== SERVERCHAN_CODE_OK) {
        const code = verdict && typeof verdict === 'object' ? verdict.code : 'unreadable'
        log?.('warn', `notify send failed: serverchan code=${code}`)
        return false
      }
      return true
    }
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
