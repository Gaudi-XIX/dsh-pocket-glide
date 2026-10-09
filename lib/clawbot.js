/**
 * WeChat ClawBot / iLink Bot client for DSH Pocket.
 *
 * Implements the official Tencent WeChat iLink bot protocol for direct
 * notification delivery without third-party push aggregators:
 * - QR code login & pairing: /ilink/bot/get_bot_qrcode -> /ilink/bot/get_qrcode_status
 * - Channel activation: /ilink/bot/msg/notifystart
 * - Message polling & context_token acquisition: /ilink/bot/getupdates
 * - Outbound notification messages: /ilink/bot/sendmessage (no /msg/ segment)
 */

import { randomInt, randomUUID } from 'node:crypto'

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const ILINK_CHANNEL_VERSION = '2.4.6'
export const ILINK_BOT_APP_ID = 'bot'
/** Client version encoded as 0x00MMNNPP: (2 << 16) | (4 << 8) | 6 = 132102 */
export const ILINK_CLIENT_VERSION = 132102
export const ILINK_AUTH_TYPE = 'ilink_bot_token'

/**
 * X-WECHAT-UIN: random uint32 as decimal string, then base64-encoded.
 * @returns {string}
 */
export function randomUin() {
  const num = randomInt(0, 0xffffffff)
  return Buffer.from(String(num), 'utf8').toString('base64')
}

/**
 * Request headers required for all authenticated iLink CGI endpoints.
 * @param {string} botToken
 * @returns {Record<string, string>}
 */
export function buildIlinkHeaders(botToken) {
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': ILINK_AUTH_TYPE,
    'Authorization': `Bearer ${botToken}`,
    'X-WECHAT-UIN': randomUin(),
    'iLink-App-Id': ILINK_BOT_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION)
  }
}

/**
 * Retrieve a login QR code from iLink.
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 * @returns {Promise<{ ok: true, qrcode: string, url: string } | { ok: false, error: string }>}
 */
export async function getBotQrCode(options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const baseUrl = options.baseUrl || ILINK_BASE_URL
  const url = `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`
  try {
    const res = await fetchImpl(url)
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` }
    }
    const data = await res.json()
    if (data.ret !== 0) {
      return { ok: false, error: data.errmsg || `ret ${data.ret}` }
    }
    if (typeof data.qrcode !== 'string' || typeof data.qrcode_img_content !== 'string') {
      return { ok: false, error: 'Malformed response from iLink get_bot_qrcode' }
    }
    return { ok: true, qrcode: data.qrcode, url: data.qrcode_img_content }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : 'Error' }
  }
}

/**
 * Poll the scan / confirmation status of a bot QR code.
 * @param {string} qrcode
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: true, status: string, botToken?: string, userId?: string, botId?: string, baseUrl?: string } | { ok: false, error: string, status?: string }>}
 */
export async function pollBotQrStatus(qrcode, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const baseUrl = options.baseUrl || ILINK_BASE_URL
  const signal = options.signal
  const url = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
  try {
    const res = await fetchImpl(url, { signal })
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` }
    }
    const data = await res.json()
    if (data.ret !== 0) {
      return { ok: false, error: data.errmsg || `ret ${data.ret}`, status: data.status }
    }
    return {
      ok: true,
      status: data.status || 'wait',
      botToken: data.bot_token || '',
      userId: data.ilink_user_id || '',
      botId: data.ilink_bot_id || '',
      baseUrl: data.baseurl || ''
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : 'Error' }
  }
}

/**
 * Activate the bot message session. Must be called before sendmessage or getupdates.
 * @param {string} botToken
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 * @returns {Promise<boolean>}
 */
export async function notifyStart(botToken, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const baseUrl = options.baseUrl || ILINK_BASE_URL
  const signal = options.signal
  const url = `${baseUrl}/ilink/bot/msg/notifystart`
  const body = JSON.stringify({
    base_info: {
      channel_version: ILINK_CHANNEL_VERSION,
      bot_agent: 'dsh-pocket'
    }
  })
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: buildIlinkHeaders(botToken),
      body,
      signal
    })
    if (!res.ok) return false
    const data = await res.json().catch(() => ({}))
    return data.ret === 0 || data.ret === undefined
  } catch {
    return false
  }
}

/**
 * Poll for new messages from WeChat users via iLink getupdates.
 * @param {string} botToken
 * @param {string} [buf]
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string, timeout?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: true, buf: string, msgs: Array<{ from_user_id?: string, context_token?: string, item_list?: unknown[] }> } | { ok: false, error: string }>}
 */
export async function getUpdates(botToken, buf = '', options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const baseUrl = options.baseUrl || ILINK_BASE_URL
  const timeout = options.timeout ?? 30
  const signal = options.signal
  const url = `${baseUrl}/ilink/bot/getupdates`
  const body = JSON.stringify({
    get_updates_buf: buf,
    timeout,
    base_info: {
      channel_version: ILINK_CHANNEL_VERSION,
      bot_agent: 'dsh-pocket'
    }
  })
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: buildIlinkHeaders(botToken),
      body,
      signal
    })
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` }
    }
    const data = await res.json().catch(() => null)
    if (!data || (data.ret !== undefined && data.ret !== 0)) {
      return { ok: false, error: data?.errmsg || `ret ${data?.ret || 'unknown'}` }
    }
    return {
      ok: true,
      buf: data.get_updates_buf || buf,
      msgs: Array.isArray(data.msgs) ? data.msgs : []
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : 'Error' }
  }
}

/**
 * Send an outbound text message to a WeChat user via iLink sendmessage.
 * @param {string} botToken
 * @param {{ contextToken: string, toUserId?: string, text: string }} params
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function sendTextMessage(botToken, { contextToken, toUserId = '', text }, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const baseUrl = options.baseUrl || ILINK_BASE_URL
  const signal = options.signal
  // Real iLink path: only notifystart carries the /msg/ segment; sendmessage
  // does not (verified against ilink-hub's upstream client).
  const url = `${baseUrl}/ilink/bot/sendmessage`
  const body = JSON.stringify({
    msg: {
      context_token: contextToken,
      to_user_id: toUserId,
      from_user_id: '',
      message_type: 2,
      message_state: 2,
      client_id: `dsh-pocket:${randomUUID()}`,
      item_list: [
        {
          item_type: 1,
          text_item: {
            text
          }
        }
      ]
    },
    base_info: {
      channel_version: ILINK_CHANNEL_VERSION,
      bot_agent: 'dsh-pocket'
    }
  })
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: buildIlinkHeaders(botToken),
      body,
      signal
    })
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` }
    }
    const responseText = await res.text().catch(() => '')
    if (!responseText || responseText.trim().length === 0) {
      return { ok: true }
    }
    try {
      const data = JSON.parse(responseText)
      if (data.ret !== undefined && data.ret !== 0) {
        return { ok: false, error: data.errmsg || `ret ${data.ret}` }
      }
    } catch {
      // Unparseable body with HTTP 200 treated as ok per iLink conventions
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : 'Error' }
  }
}
