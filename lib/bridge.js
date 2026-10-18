import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { Readable } from 'node:stream'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { spawn } from 'node:child_process'
import { startCloudflareNamedTunnel, startCloudflareQuickTunnel } from './tunnel.js'
import { notifySend, maskKey } from './notify.js'
import {
  getBotQrCode,
  pollBotQrStatus,
  notifyStart,
  getUpdates,
  sendTextMessage
} from './clawbot.js'
import { buildIconBytes, buildIconDataUri } from './icon.js'
import { renderQrSvg } from './qr-svg.js'
import {
  mobilePageAssets,
  renderByePage,
  renderDesktopPairingPage,
  renderMobilePage,
  renderMobileReconnectPage,
  renderPairingPinPage,
  renderServiceWorker
} from './pages.js'
// The two page renderers this bridge consumes across the WP-1/WP-2 file-domain
// boundary (design D1: `renderManifestJson` / `renderConsentPage`). A namespace
// import keeps this module loadable while those exports are landing in
// parallel; the routes that call them are the coupling point the integration
// batch greps on both sides.
import * as pocketPages from './pages.js'
import {
  buildContentSecurityPolicy,
  CLAWBOT_IDLE_POLL_MS,
  CLAWBOT_QUOTA_LIMIT,
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_S,
  DESKTOP_BOOTSTRAP_TTL_MS,
  DESKTOP_COOKIE_TTL_MS,
  DEVICE_MAP_CAP,
  EVENT_STREAM_ID,
  bodyLimitForMethod,
  HARNESS_ENDPOINTS,
  HISTORY_PAGE_DEFAULT_MESSAGES,
  HISTORY_PAGE_MAX_MESSAGES,
  INLINE_ATTACHMENT_TYPES,
  LARGE_BODY_BYTES,
  LAN_ADDRESS_WINDOW_MS,
  MAX_BODY_BYTES,
  MOBILE_COOKIE_TTL_MS,
  MOBILE_LIVE_FRESH_MS,
  SESSION_PERSIST_DEBOUNCE_MS,
  NOTIFY_CHANNELS,
  NOTIFY_POLL_MS,
  PAIRING_PIN_DIGITS,
  PAIRING_PIN_SPACE,
  PAIRING_TTL_MS,
  PAIR_CONFIRM_TTL_MS,
  PAIR_POLL_AFTER_MS,
  PENDING_QUESTIONS_MAX,
  PIN_FAIL_BASE_SECONDS,
  PIN_FAIL_GLOBAL,
  PIN_FAIL_HARD_LOCK,
  PIN_FAIL_KEYS_MAX,
  PIN_FAIL_LOCKOUT_MS,
  PIN_FAIL_MAX_SECONDS,
  PIN_FAIL_PER_IP,
  PIN_FAIL_WINDOW_MS,
  PIN_TTL_MS,
  REMOTE_EVENT_RESULT_ENDPOINT,
  RPC_ALLOWLIST,
  POCKET_PREWARM_MIN_MS,
  RPC_METHOD_PROBE_BYTES,
  RPC_REFUSAL_DRAIN_MS,
  SESSION_CURSOR_MAX,
  SESSION_LIST_MAX_ROWS,
  SESSION_SEQ_MAX,
  SSE_STATUS_MS,
  STREAM_BACKOFF_KEYS_MAX,
  STREAM_RETRY_BASE_MS,
  STREAM_RETRY_CAP_MS,
  TUNNEL_HOSTNAME_MAX_LENGTH,
  USER_QUESTION_EVENT,
  WORKSPACE_STREAM_ID
} from './constants.js'
import {
  applyDescendantRunning,
  applyWorkspaceFollowFrame,
  compactSessionRecords,
  compactSessionRows,
  isRecord,
  isWorkspaceSnapshot
} from './projections.js'
import { sanitizeOpenedAtLedger } from './opened-at-store.js'
import {
  inspectPendingQuestion,
  parseQuestionResponse,
  requiredStringField,
  validateQuestionAnswers
} from './questions.js'
import { streamSession as streamSessionStream, createSessionEventCollector, followAddressOf, EVENT_COLLECTOR_IDLE_MS, EVENT_COLLECTOR_SESSIONS_MAX, EVENT_HOLD_MS, withSessionErrors } from './session-stream.js'
import { createMuxMonitor } from './mux-client.js'

export { buildContentSecurityPolicy }
export {
  compactSessionFrame,
  compactSessionRecords,
  compactSessionRows,
  stripRecordsThrough
} from './projections.js'

// The cold-open payload used to ship the full session list. The landing had
// carried only a page of rows (was 12) and refilled in the background
// (bootListPartial -> fillListFromServer), and that two-stage paint made the
// list jump: a few rows first, then the full pinned+24h set. Shipping the whole
// list up front traded a heavier document for a single stable paint, and the
// user accepted the slower cold open for first-screen completeness.
//
// What the page actually stabilises on is the pinned+24h set, so that is what
// the document now carries (2026-10-17). Everything outside it is a row the
// page deliberately hides behind「更多」anyway — shipping it only made the
// document grow with the workspace's whole history. The page still receives the
// complete catalogue (sess.partial = true), so「更多」pages through it locally
// instead of paying a round trip, and the list fingerprint still covers every
// row: the landing's no-repaint check has to notice a change to a row it is
// currently hiding. The trim therefore cannot regress a visible first paint —
// same stable single paint, smaller document, and the size no longer tracks how
// much history the workspace has accumulated.

// Row cap for the sessions block of the cold-open document: pinEndedAt/pinned
// rows plus everything touched inside this window. Mirrors the page's own
// RECENT_WINDOW_MS (lib/pages.js) — the page is the one that decides what to
// paint, this only decides what travels.
const BOOT_RECENT_WINDOW_MS = 86400000


// /m00047「每个非折叠会话显示最后几条消息，不要再加载」). The landing wants one
// short line of the last message per visible row; pulling each through its own
// session.history would be N round-trips over a public tunnel. This is one RPC
// fan-out instead. 30 sessions covers a normal 24h window (the whole list rarely
// exceeds it); 4 in flight keeps a slow Host page call from turning the boot
// into a stampede; 8 messages is enough for the last bubble on both sides of a
// turn without dragging whole transcripts through the wire.
const TAILS_MAX_SESSIONS = 30
const TAILS_CONCURRENCY = 4
const TAIL_PAGE_MESSAGES = 8

// The read-ledger save is debounced because a sync ride every open and every
// cold boot; a restart boundary flushes it explicitly (see stop()). 1.5s loses
// at most the very last sync before a hard kill, and the cost of losing one is
// a session that reads as unread on the next cold open — noisy, never harmful.
const OPENED_AT_PERSIST_DEBOUNCE_MS = 1500

// The model catalogue (session/modelCatalog) is host-global and takes no
// arguments, so one cache serves every reader. Measured at ~1.4s per host call
// (pocket.log 2026-10-13 01:22); the page's settings panel asks for it on every
// open and every model switch.
const MODEL_CATALOG_TTL_MS = 30_000

// Agent presets (agentPresets/list) change only when the desktop edits them —
// rarer than a model switch — and the settings panel pairs this fetch with the
// catalogue in one Promise.all. A 30 s TTL stops the preset leg from paying a
// tunnel round trip on every panel open when the catalogue is already warm.
const AGENT_PRESETS_TTL_MS = 30_000

// Pull only the three desktop settings the mobile UI inherits. Anything missing
// falls back to the desktop defaults on the page, so a partial answer is fine.
function extractMobileSettings(describeValue) {
  const namespaces = Array.isArray(describeValue?.namespaces) ? describeValue.namespaces : []
  const byNs = new Map(namespaces.map((ns) => [String(ns.ns), ns.value || {}]))
  const conversation = byNs.get('ui-conversation') || {}
  const chat = byNs.get('ui-chat') || {}
  return {
    busyEnter: conversation.busyEnter === 'steer' ? 'steer' : 'queue',
    transcriptView: ['compact', 'standard', 'detailed', 'verbose'].includes(chat.transcriptView)
      ? chat.transcriptView
      : 'standard',
    performanceUsage: chat.performanceUsage === 'compact' ? 'compact' : 'detailed'
  }
}

/**
 * A number a phone is allowed to hand to the Host, or the reason it is not.
 *
 * `typeof NaN === 'number'` and `typeof 1e9 === 'number'` are both true, so a
 * bare type test — the previous guard on `maxMessages` / `beforeSeq` — let both
 * through and the third history attempt even widened one (`Math.max(max, 60)`).
 * Integrality and the range are what actually carry the bound here. An absent
 * argument keeps its documented default; an out-of-range one is refused rather
 * than silently clamped, so "load older" can never quietly fetch less.
 * @param {unknown} value
 * @param {{ name: string, fallback: number, min?: number, max: number }} spec
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
export function readNumericArgument(value, spec) {
  if (value === undefined || value === null) return { ok: true, value: spec.fallback }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, error: `${spec.name} must be an integer.` }
  }
  const min = spec.min ?? 1
  if (value < min || value > spec.max) {
    return { ok: false, error: `${spec.name} must be between ${min} and ${spec.max}.` }
  }
  return { ok: true, value }
}

// -- Completion judge (design #2 upgrade: activity criteria, not a flip) ----
//
// The shipped trigger pushed "任务已完成" on every running true→false edge,
// so the pause between two steps of one turn read as a completion. The
// criteria ported from dsh-mobile's task-notify (WP2 report §4.1) decide from
// the shape of the activity instead: how long the assistant had been working,
// how long it has been quiet since, and whether it is parked on a question.

/**
 * The dsh-mobile four thresholds, in bridge-poll terms. The bridge observes a
 * session only once per {@link NOTIFY_POLL_MS} tick, so any threshold shorter
 * than one tick is decided by the sampling, not by the clock — see the
 * HANDOFF for the exact conversion.
 */
export const NOTIFY_JUDGE_THRESHOLDS = Object.freeze({
  /** busy→idle must survive this long before "stopped" is believed. */
  graceMs: 10_000,
  /** After observed activity, this much silence judges "complete". */
  quietMs: 90_000,
  /** A busy run of at least this long that stops notifies immediately. */
  minBusyMs: 20_000,
  /** One unsettled wait lives at most this long, then settles anyway. */
  staleMs: 30 * 60_000
})

/** Wire cap carried over from the dsh-mobile notice format: the session-name
 * part of the push line. The status half is a constant this repo controls
 * (`已完成`/`出错了`/`待回答`/`卡在重试…`), so it needs no cap of its own — the
 * old body cap (200) retired with the quotaBody truncation it guarded. */
export const NOTIFY_TITLE_MAX = 80

/**
 * 推送的整条规则（0.4.31，用户 2026-10-11 定）：**有消息就推**。
 * 上一版（0.4.12–0.4.30）为了省微信那条「一条入站换 10 条出站」的额度，
 * 把完成通知装进邮包攒成一封、挂号信投不出去还留着补投；用户判定那套「搭车／
 * 班次／信封」概念太复杂，整体砍掉。现在判定到一次 settle（或收到一条提问）就当场发一封，
 * 发不出去就丢——「没推到的就没推到」，不重试、不补投、不落盘。
 * 判班仍是 30 秒轮询（{@link NOTIFY_POLL_MS}），区别只是轮到自己时不再攒着。
 */
/** Dedup table bound for "the same question pushes once", keyed by event id. */
export const NOTIFY_QUESTION_KEYS_MAX = 256

/**
 * 重试风暴检测的四个刻度（2026-10-12，用户令「昨晚的重试风暴能透传过去吗」）。
 *
 * 风暴的实况样本是 2026-10-11 夜：宿主对已停运压缩的无限重试——六个会话同时在
 * `compaction/start` → 403 `dsh_compaction_refused` 里打转（852/626/207/190/56/42 次，
 * 峰值一小时 328 次，最长 4.4 小时），整轮 turn 不落 `step/end` ⇒ 会话行整夜
 * `running:true` ⇒ 完成判定按设计够不着它（判定只管「停下来」）。检测 therefore
 * 主动去读：跑得太久的会话值得被看一眼记录尾部。
 *
 * 刻度都用昨晚实测校准：健康会话一小时压缩失败是零次，风暴是每分钟 3 次起步，
 * 所以 {@link RETRY_STORM_THRESHOLDS} 的阈值（10 分钟 3 次）离两边都很远。
 */
export const RETRY_STORM_THRESHOLDS = Object.freeze({
  /** A busy run younger than this is never probed: healthy turns finish inside it. */
  suspectAfterMs: 10 * 60_000,
  /** Only failures with an event `time` inside this window count toward the threshold. */
  windowMs: 10 * 60_000,
  /** Failed compactions / model retries within the window that mean "storm". */
  failMin: 3,
  /** One notice per storm: after a push the session re-probes no earlier than this. */
  cooldownMs: 30 * 60_000,
  /** Cheapest possible probe cadence for a suspect that is not (yet) storming —
   * one `session/page` round trip per suspect per tick would hammer the Host
   * from every 30s poll for every long-running session. */
  probeEveryMs: 5 * 60_000
})

/**
 * Count retry-storm failures in one `session/page` record slice. Pure.
 *
 * Two lanes count, one record each — never doubled:
 *  - `compaction/end` carrying `data.error` — the compaction loop's own verdict
 *    (the 2026-10-11 storm emitted 852 of these and **zero** `llm/retry`: a
 *    403-refused compaction call never reaches the llm retry policy);
 *  - `llm/retry` — the model lane's will-retry verdict. `llm/retry-started`
 *    (1:1 with it, verified on the 10-11 sample) and `assistant/attempt`
 *    error finishes (1:1 with it while retries continue) are deliberately NOT
 *    counted: they would multiply one failure into two or three and trip the
 *    threshold on a single unlucky request.
 *
 * Records arrive as the Host's wire entries (`{type:'event', event}`) or, for
 * convenience, bare events; both shapes are accepted. Events without a usable
 * `time` count (the Host stamps every record; missing stamps exist only in
 * tests and malformed rows) — a count that errs high on those is the safe side
 * for a detector whose downside is one extra push per cooldown.
 * @param {unknown} records the page's record slice
 * @param {number} now epoch ms
 * @param {number} windowMs failures older than this don't count
 * @returns {number}
 */
export function countRetryFailures(records, now, windowMs) {
  let count = 0
  for (const entry of Array.isArray(records) ? records : []) {
    const event = entry !== null && typeof entry === 'object' && entry.event
      ? entry.event
      : entry
    if (event === null || typeof event !== 'object') continue
    if (typeof event.time === 'number' && now - event.time > windowMs) continue
    if (event.type === 'compaction/end' && event.data?.error) count += 1
    else if (event.type === 'llm/retry') count += 1
  }
  return count
}

/**
 * The bridge's best read of when a session was last active, from one Host row.
 *
 * The Host stamps every row with an `updatedAt` (also mirrored under
 * `projections.updatedAt`); that timestamp is the truth the judge's quiet
 * clock runs on — it freezes the moment the turn's last event lands, so it
 * measures the assistant's silence, not the bridge's polling. `null` means
 * the row carried nothing usable and the judge falls back to what it saw.
 * @param {unknown} item
 * @returns {number | null}
 */
export function sessionActivityAt(item) {
  if (item === null || typeof item !== 'object') return null
  const direct = Number(item.updatedAt)
  if (Number.isFinite(direct) && direct > 0) return direct
  const projections = item.projections
  const mirrored = typeof projections === 'object' && projections !== null
    ? Number(projections.updatedAt)
    : NaN
  if (Number.isFinite(mirrored) && mirrored > 0) return mirrored
  return null
}

/**
 * The row's own verdict on "this session errored" — the same truth the desktop
 * GoalBar and the phone badge read (`error` / `lastError` / `status==='error'`,
 * exactly the fields the landing attention count has trusted in production
 * since 0.4.31). The notify settle uses it to pick between 已完成 and 出错了,
 * so the phone badge and the WeChat push can never disagree about what counts
 * as an error. It lives here rather than in projections.js because its only
 * consumer reads the RAW Host row the judge already samples — the compacted
 * phone row would drop a long `lastError` prose string outright.
 *
 * What deliberately does NOT travel is the error DETAIL: arbitrary prose, too
 * long for the one-line push, potentially secret-bearing (design D6). The fact
 * travels; the prose stays in the session.
 * @param {unknown} item a raw Host session row
 * @returns {boolean}
 */
export function sessionRowHasError(item) {
  if (item === null || typeof item !== 'object') return false
  return Boolean(item.error || item.lastError || item.status === 'error')
}

/**
 * @typedef {object} NotifyCompletionState
 * @property {boolean} active whether the previous sample saw the assistant running
 * @property {number | undefined} busySince when the current busy run was first observed
 * @property {boolean} longBusy the current/last busy run reached minBusyMs (stays armed
 *   through the flip until it fires or activity resumes)
 * @property {boolean} hostKnown whether a Host activity timestamp was ever seen this
 *   cycle — without one the flicker/completion distinction is not decidable
 * @property {number} lastActivityAt best-known time of the last assistant activity
 * @property {number | undefined} waitingSince when the current unsettled wait began
 * @property {boolean} notified a completion notice already went out for this settle
 */

/**
 * One completion-judge transition for one session. Pure: everything it reads
 * comes in through the arguments, everything it decides comes out in the
 * return, and `now` is a parameter so tests can drive the clock.
 *
 * The rules, ported from dsh-mobile:
 *  - a busy run that reached minBusyMs and stops → fire as soon as the stop
 *    has survived graceMs of quiet (immediate, no 90s wait);
 *  - any other stop → wait for quietMs of silence since the last activity;
 *  - a wait that drags on for staleMs settles anyway, so a session that keeps
 *    flickering short steps cannot stay silent forever;
 *  - a session that was already idle when first seen never fires (baseline),
 *    and after a fire nothing fires again until activity re-arms the state.
 *
 * A row with no usable activity timestamp degrades to the shipped behaviour —
 * fire on the flip — because with no quiet clock a step-pause and a real stop
 * are indistinguishable. The real Host stamps every row, so this path exists
 * for malformed rows and for the shipped test anchor, not for production.
 *
 * @param {NotifyCompletionState | undefined} prev
 * @param {{ running: boolean, activityAt: number | null }} sample
 * @param {number} now
 * @param {{ graceMs: number, quietMs: number, minBusyMs: number, staleMs: number }} [thresholds]
 * @returns {{ state: NotifyCompletionState, fire: boolean }}
 */
export function judgeSessionCompletion(prev, sample, now, thresholds = NOTIFY_JUDGE_THRESHOLDS) {
  if (prev === undefined) {
    // Baseline: only transitions notify, so a session already idle when the
    // watcher first sees it starts settled.
    const state = {
      active: sample.running,
      busySince: sample.running ? now : undefined,
      longBusy: false,
      hostKnown: sample.activityAt !== null,
      lastActivityAt: sample.activityAt ?? now,
      waitingSince: undefined,
      notified: !sample.running
    }
    return { state, fire: false }
  }

  if (sample.running) {
    const resumed = !prev.active
    const state = {
      active: true,
      busySince: resumed ? now : prev.busySince,
      longBusy: resumed ? false : prev.longBusy,
      hostKnown: prev.hostKnown || sample.activityAt !== null,
      // Host clock when offered (authoritative, freezes at the turn's last
      // event), else the observation itself. Both are epoch ms on this machine.
      lastActivityAt: Math.max(prev.lastActivityAt, sample.activityAt ?? now),
      waitingSince: undefined,
      notified: false
    }
    if (!resumed && state.busySince !== undefined && now - state.busySince >= thresholds.minBusyMs) {
      state.longBusy = true
    }
    return { state, fire: false }
  }

  // Idle.
  const freshActivity = sample.activityAt !== null && sample.activityAt > prev.lastActivityAt
  const state = {
    active: false,
    busySince: undefined,
    // Fresh activity on an already-idle session is a new, unobserved (hence
    // unproven) run: disarm. On the flip tick the fresh stamp is just the
    // turn's own last event — it must not disarm the run the running ticks
    // armed.
    longBusy: prev.active || !freshActivity ? prev.longBusy : false,
    hostKnown: prev.hostKnown || sample.activityAt !== null,
    lastActivityAt: Math.max(prev.lastActivityAt, sample.activityAt ?? -Infinity),
    waitingSince: prev.waitingSince,
    notified: freshActivity ? false : prev.notified
  }
  if (prev.active) {
    // The flip. Whether the run that just ended counts as long work is what
    // the running ticks proved: longBusy was armed only while the assistant
    // was still observed running past minBusyMs. Recomputing the span here
    // instead would count the idle time after the turn's real end as work.
    if (!state.hostKnown) {
      // No quiet clock to judge with: keep the shipped promptness.
      state.notified = true
      state.longBusy = false
      state.waitingSince = undefined
      return { state, fire: true }
    }
    if (prev.longBusy) {
      if (now - state.lastActivityAt >= thresholds.graceMs) {
        state.notified = true
        state.longBusy = false
        state.waitingSince = undefined
        return { state, fire: true }
      }
      // The turn ended less than a grace ago; one more idle tick confirms the
      // stop and fires then, rather than falling back to the 90s settle.
      state.waitingSince = now
      return { state, fire: false }
    }
    state.waitingSince = now
    return { state, fire: false }
  }

  if (state.notified) return { state, fire: false }
  const quiet = now - state.lastActivityAt
  const settle = () => {
    state.notified = true
    state.longBusy = false
    state.waitingSince = undefined
    return { state, fire: true }
  }
  if (state.longBusy && quiet >= thresholds.graceMs) return settle()
  if (quiet >= thresholds.quietMs) return settle()
  if (state.waitingSince !== undefined && now - state.waitingSince >= thresholds.staleMs) return settle()
  return { state, fire: false }
}

/**
 * Canonicalize a User-Agent to a stable "device + browser" identity (Option B).
 * Strips dynamic network parameters (NetType/WIFI, NetType/5G), process markers,
 * language tags, and ephemeral WebView build numbers so that one handset with
 * one browser stays ONE stable credential across network and minor version changes.
 *
 * @param {unknown} ua
 * @returns {string}
 */
export function canonicalDeviceAgent(ua) {
  if (typeof ua !== 'string' || ua.trim().length === 0) return 'no-agent'
  const trimmed = ua.trim()

  // Detect browser / client family
  let browser = ''
  if (/MicroMessenger/i.test(trimmed)) browser = 'MicroMessenger'
  else if (/HuaweiBrowser/i.test(trimmed)) browser = 'HuaweiBrowser'
  else if (/Edg(e|A|iOS)?/i.test(trimmed)) browser = 'Edge'
  else if (/MiuiBrowser|XiaoMi/i.test(trimmed)) browser = 'MiuiBrowser'
  else if (/HeyTapBrowser|OppoBrowser/i.test(trimmed)) browser = 'OppoBrowser'
  else if (/VivoBrowser/i.test(trimmed)) browser = 'VivoBrowser'
  else if (/QQBrowser/i.test(trimmed)) browser = 'QQBrowser'
  else if (/UCBrowser|UBrowser/i.test(trimmed)) browser = 'UCBrowser'
  else if (/Baidu/i.test(trimmed)) browser = 'BaiduBrowser'
  else if (/Firefox|FxiOS/i.test(trimmed)) browser = 'Firefox'
  else if (/Chrome|CriOS/i.test(trimmed)) browser = 'Chrome'
  else if (/Safari/i.test(trimmed) && !/Android/i.test(trimmed)) browser = 'Safari'

  const parenMatch = trimmed.match(/\(([^)]+)\)/)
  if (parenMatch) {
    const inside = parenMatch[1]
    let device = ''
    if (/Android/i.test(inside)) {
      const vMatch = inside.match(/Android\s*([\d.]+)?/i)
      const osVer = vMatch && vMatch[1] ? vMatch[1].split('.')[0] : ''
      const parts = inside.split(';').map((p) => p.trim())
      let model = ''
      for (const p of parts) {
        if (/^(Linux|U|wv|arm|x86|mips|[a-z]{2}(-[a-z]{2})?)$/i.test(p)) continue
        if (/^Android/i.test(p)) continue
        if (/^Build/i.test(p)) {
          if (!model) model = p.replace(/^Build\//i, '').trim()
          continue
        }
        model = p.replace(/\s*Build\/.*$/i, '').trim()
        break
      }
      device = `Android${osVer ? ` ${osVer}` : ''}${model ? `; ${model}` : ''}`
    } else if (/iPhone|iPad|iPod/i.test(inside)) {
      const type = inside.match(/iPhone|iPad|iPod/i)?.[0] ?? 'iOS'
      const verMatch = inside.match(/OS\s*([\d_]+)/i)
      const osVer = verMatch ? verMatch[1].split('_')[0] : ''
      device = `${type}${osVer ? `; iOS ${osVer}` : ''}`
    } else if (/Windows NT/i.test(inside)) {
      device = 'Windows'
    } else if (/Macintosh/i.test(inside)) {
      device = 'Macintosh'
    } else {
      device = inside.split(';')[0].trim()
    }
    return [device, browser].filter(Boolean).join('; ')
  }

  return trimmed
}

/**
 * Check if a legacy device label matches incoming canonical UA identity.
 * @param {string} legacyLabel
 * @param {string} incomingCanonical
 * @returns {boolean}
 */
export function isCompatibleLegacyProfile(legacyLabel, incomingCanonical) {
  if (typeof legacyLabel !== 'string' || typeof incomingCanonical !== 'string') return false
  const legacyCanonical = canonicalDeviceAgent(legacyLabel)
  if (!legacyCanonical || legacyCanonical === 'no-agent') return false
  if (legacyCanonical === incomingCanonical) return true
  const m1 = legacyCanonical.match(/Android\s*[\d.]*;\s*([^;]+)/i) || legacyCanonical.match(/iPhone|iPad/i)
  const m2 = incomingCanonical.match(/Android\s*[\d.]*;\s*([^;]+)/i) || incomingCanonical.match(/iPhone|iPad/i)
  if (m1 && m2 && m1[0] && m2[0] && m1[0].trim().toLowerCase() === m2[0].trim().toLowerCase()) {
    return true
  }
  return false
}

/**
 * Coarse device fingerprint: what the pairing page's User-Agent resolves to.
 * Option B: hashes the canonical "device model + browser family" identity,
 * impervious to WiFi/5G network flips and volatile build strings.
 * @param {unknown} userAgent
 * @returns {string}
 */
export function deviceFingerprint(userAgent) {
  if (typeof userAgent !== 'string' || userAgent.length === 0) return 'no-agent'
  const canonical = canonicalDeviceAgent(userAgent)
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 10)
}

/**
 * T6 (card 2026-10-14-feature-pocket-手机八问收敛, user m00001⑤「不要每次重拉，
 * 对比一下，有增量才更新」): the content hash of one projected session list.
 * The row objects this hashes are built by the same code path on every read
 * (compactSessionRows -> withSessionErrors -> awaitingQuestion), so the key
 * order — the thing JSON.stringify is sensitive to — is deterministic.
 * @param {any} items
 * @returns {string}
 */
function listFingerprint(items) {
  return createHash('sha256').update(JSON.stringify(items ?? null)).digest('base64url').slice(0, 10)
}

/**
 * The rows the landing paints before anyone taps「更多」: every pinned session
 * plus everything the phone touched inside BOOT_RECENT_WINDOW_MS.
 *
 * This mirrors `renderWorkspaces` in lib/pages.js, and the two must agree or the
 * page paints a workspace card that still has hidden rows and offers no「更多」.
 * The page's rule is, per card: pinned rows first, then rows whose `sortAtOf` is
 * inside the window, capped at (pinned + recent) but never below one row — so an
 * all-old workspace still shows its newest row. That is reproduced here over the
 * per-workspace membership the snapshot already carries.
 *
 * `sortAtOf` lives only in the page, so the ordering input is the row's own
 * `updatedAt`/`lastMessageAt`. Losing the page's "a session this phone opened
 * just now counts as recent" rule only ever ships a row the page then hides,
 * never the reverse, so a slight over-count here is harmless.
 *
 * Rows that belong to no workspace (or a workspace the snapshot has since
 * dropped) are kept: they are the ones the landing resolves to a synthetic
 * placeholder row, and dropping them would leave a blank card with no way back.
 * @param {any[]} rows
 * @param {any} wsSnapshot
 * @param {number} now
 * @returns {any[]}
 */
function bootVisibleRows(rows, wsSnapshot, now) {
  if (!Array.isArray(rows) || rows.length === 0) return []
  const byId = new Map(rows.map((row) => [row?.sessionId, row]))
  const pinned = new Set(
    Array.isArray(wsSnapshot?.pinnedSessionIds) ? wsSnapshot.pinnedSessionIds : []
  )
  const claimed = new Set()
  const keep = new Set()
  for (const workspace of Array.isArray(wsSnapshot?.items) ? wsSnapshot.items : []) {
    const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
    // The page partitions pinned rows to the front before applying its cap, and
    // breaks ties by recency (`pinRank(b)-pinRank(a)||sortAtOf(b)-sortAtOf(a)`),
    // so the cap has to be counted off that same order. Sorting on pinned alone
    // was not enough: a workspace holding one old and one fresh unpinned session
    // has a cap of 1, `slice(0,1)` then took whichever the catalogue happened to
    // list first — it shipped the STALE row and hid the fresh one, and the page
    // showed an old title with「更多」behind it (found 2026-10-17 on restart
    // verification). Pinned first, then newest first, exactly as the page does.
    const stampOf = (id) => Number(byId.get(id)?.updatedAt ?? byId.get(id)?.lastMessageAt ?? 0)
    const members = ids
      .filter((id) => byId.has(id))
      .sort((a, b) => (pinned.has(b) ? 1 : 0) - (pinned.has(a) ? 1 : 0) || stampOf(b) - stampOf(a))
    for (const id of ids) if (byId.has(id)) claimed.add(id)
    const pinnedCount = members.filter((id) => pinned.has(id)).length
    const recentCount = members.filter((id) => {
      if (pinned.has(id)) return false
      const at = Number(byId.get(id)?.updatedAt ?? byId.get(id)?.lastMessageAt ?? 0)
      return Number.isFinite(at) && at >= now - BOOT_RECENT_WINDOW_MS
    }).length
    const cap = Math.max(pinnedCount + recentCount, Math.min(members.length, 1))
    members.slice(0, cap).forEach((id) => keep.add(id))
  }
  const out = []
  for (const row of rows) {
    const id = row?.sessionId
    if (!claimed.has(id) || keep.has(id)) out.push(row)
  }
  return out
}

/**
 * Fingerprint of the payload a session persist would write, minus `savedAt`.
 *
 * The store writes the four maps as `[key, value]` pairs in Map insertion
 * order, so the fingerprint must be taken from the same shape to answer the
 * only question it is asked: "would this write change the file?" Sorting the
 * session half by key makes a re-inserted record compare equal to a record that
 * never moved; the rest keep the store's own ordering. Stamps inside records
 * (`updatedAt`, `openedAt`) still count as changes — they are content.
 *
 * @param {{ sessions: Map<string, object>, suspendedSessions: Map<string, object>, resumableSessions: Map<string, object>, devices?: Map<string, object> }} state
 * @returns {string}
 */
function persistFingerprint(state) {
  const sorted = (map) => [...(map ?? new Map()).entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const material = [
    sorted(state.sessions),
    sorted(state.suspendedSessions),
    sorted(state.resumableSessions),
    sorted(state.devices),
  ]
  return createHash('sha256').update(JSON.stringify(material)).digest('base64url')
}

/**
 * The key a pairing-password failure is counted under.
 *
 * Deliberately never derived from `x-forwarded-for`: that header is plain
 * client input on a listener any private host can reach, so each guess could
 * rename its own bucket and the counter never filled. In tunnel mode the only
 * address worth trusting is `cf-connecting-ip`, and only once
 * `requestConnectionMode` has already put the request on the local carrier
 * (loopback transport plus a tunnel hostname or a `cf-ray`); anywhere else the
 * socket peer is the whole key.
 * @param {string} transportAddress
 * @param {'lan' | 'tunnel'} connectionMode
 * @param {string | undefined} carrierAddress
 * @returns {string}
 */
export function pairingRateKey(transportAddress, connectionMode, carrierAddress) {
  if (connectionMode === 'tunnel' && carrierAddress) {
    return `tunnel:${normalizeRemoteAddress(carrierAddress)}`
  }
  return `socket:${transportAddress}`
}

/**
 * Resolve the ceiling an RPC body is read under.
 * @param {string | undefined} method the method the stream has revealed so far
 * @returns {number}
 */
function rpcBodyCeiling(method) {
  return method === undefined ? LARGE_BODY_BYTES : bodyLimitForMethod(method)
}

/**
 * Pull the `method` out of the leading bytes of the mobile RPC envelope.
 * The envelope the page builds always opens with it; anything that hides it
 * further in falls back to the large tier and is judged again after parsing.
 * @param {string} text
 * @returns {string | undefined}
 */
export function rpcMethodOf(text) {
  const match = /^\s*\{\s*"method"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
  return match?.[1]
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {number | undefined}
 */
function declaredBodyBytes(request) {
  const raw = firstHeaderValue(request.headers['content-length'])
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

const BODY_TOO_LARGE = 'Request body is too large.'

/**
 * Bridge-local argument-rejection code. It cannot collide with a Host
 * RemoteError code ('session/*', 'gateway/*'), so a caller can tell "the phone
 * asked for something out of bounds" from "the Host said no" without reading
 * prose.
 */
const INVALID_ARGUMENTS_CODE = '__bridge/invalid-arguments'

/** Transport-shaped failures: no Host envelope came back at all. */
const TRANSPORT_ERROR_CODES = new Set(['__bridge/not-ready', '__bridge/transport', '__bridge/rpc-mismatch'])

/**
 * Read a POST /api/rpc body under a ceiling picked as soon as the stream
 * reveals which method is being called, so a normal-tier method can never make
 * the bridge buffer the large tier (a 25 MB upload claimed by a 64 KB call used
 * to be fully read, concatenated, and only then refused).
 *
 * A refusal stops keeping bytes immediately and lets the rest drain at the
 * socket layer. It does not answer in the same tick: Node destroys a socket
 * whose response finishes over an unfinished request, which would reset a
 * cooperative peer before it could read the 413. The drain is bounded, so a
 * peer that stops sending still gets an answer.
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<string>}
 * @throws {Error} 'Request body is too large.'
 */
async function readRpcBody(request) {
  const declared = declaredBodyBytes(request)
  return await new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let bytes = 0
    let refused = false
    let settled = false
    /** Method name once the leading envelope has revealed one, for the log only. */
    let seenMethod
    // A declared size already inside the small tier needs no method to be read:
    // no tier is smaller than that, so there is nothing left to tighten.
    let decided = declared !== undefined && declared <= MAX_BODY_BYTES
    let ceiling = decided ? MAX_BODY_BYTES : LARGE_BODY_BYTES
    const refuse = () => {
      if (refused) return
      refused = true
      chunks.length = 0
      request.resume()
      request.once('end', giveAnswer)
      setTimeout(giveAnswer, RPC_REFUSAL_DRAIN_MS).unref?.()
    }
    const fail = () => {
      if (settled) return
      settled = true
      const refusal = new Error(BODY_TOO_LARGE)
      // The measured size is the whole diagnosis for a 413: without it an
      // operator cannot tell a 40 MB photo from a truncated upload, and the
      // phone is only ever told its call was too large. Both numbers are byte
      // counts, never content.
      refusal.observedBytes = bytes
      refusal.declaredBytes = declared
      refusal.method = seenMethod
      refusal.ceiling = ceiling
      reject(refusal)
    }
    const giveAnswer = () => {
      request.off('data', onData)
      request.off('end', onFinish)
      request.off('aborted', refuse)
      fail()
    }
    // Cheap while the ceiling is still open: the method name is only looked for
    // until it shows up or the probe window is passed, never per chunk after.
    const decide = () => {
      if (decided) return
      const method = rpcMethodOf(Buffer.concat(chunks).toString('utf8'))
      if (method !== undefined) {
        decided = true
        seenMethod = method
        ceiling = rpcBodyCeiling(method)
        if (bytes > ceiling || (declared !== undefined && declared > ceiling)) refuse()
        return
      }
      if (bytes > RPC_METHOD_PROBE_BYTES) decided = true
    }
    const onData = (chunk) => {
      if (refused) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      chunks.push(buffer)
      bytes += buffer.length
      if (bytes > ceiling) {
        refuse()
        return
      }
      decide()
    }
    const onFinish = () => {
      if (refused || settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    request.on('data', onData)
    request.on('end', onFinish)
    request.on('aborted', refuse)
    // No method name can make an envelope bigger than the largest tier legal,
    // so a declared size past it is refused without keeping a single body byte.
    if (declared !== undefined && declared > LARGE_BODY_BYTES) {
      refuse()
      return
    }
    decide()
  })
}

/**
 * Serve one stored attachment without letting the record's own media type pick
 * what this origin renders.
 * @param {unknown} mediaType
 * @returns {{ contentType: string, download: boolean }}
 */
export function attachmentDisposition(mediaType) {
  const value = typeof mediaType === 'string' ? mediaType.trim().toLowerCase() : ''
  // SVG is an image by name and a document by nature: inside an <img> it is
  // inert, but this route is also one the user can open directly, and a script
  // in an SVG then runs on this origin — where every RPC is same-origin and the
  // phone's cookie rides along. The one image type is therefore carved out.
  if (value === 'image/svg+xml') {
    return { contentType: 'application/octet-stream', download: true }
  }
  if (INLINE_ATTACHMENT_TYPES.some((prefix) => value.startsWith(prefix))) {
    return { contentType: value, download: false }
  }
  return { contentType: 'application/octet-stream', download: true }
}

// ---------------------------------------------------------------------------
// Session-file serving (change 2026-10-07-feat-pocket-image-file-capability).
// The phone cannot load a local path (`F:\...`) a produced picture or a
// `present` card points at, so the bridge re-serves exactly those files. The
// authorisation is the per-session known-path set below: only paths the
// session's own event stream surfaced are ever readable, everything else 404s.
// ---------------------------------------------------------------------------

/** One served file may be as large as the largest body this bridge accepts
 * back — a file that could not have travelled as an attachment is not served
 * inline either. */
const SESSION_FILE_MAX_BYTES = LARGE_BODY_BYTES
/** At most this many sessions keep a known-path set (insertion-order eviction). */
const SESSION_KNOWN_PATH_SETS_MAX = 16
/** At most this many paths per session; a pathological transcript stops
 * collecting rather than growing without bound. */
const SESSION_KNOWN_PATHS_MAX = 400
/** The markdown-image forms a produced file surfaces in message text:
 * `![alt](<F:\absolute path>)` and `![alt](F:\absolute path)`. */
const MD_IMAGE_PATH_RE = /!\[([^\]]*)\]\((?:<([^>]*)>|([^)\s]+))\)/g

/** Extension → media type for the files an agent actually presents. Deliberately
 * narrow: an unknown extension (`.html` included by omission) serves as a
 * download, never inline — `attachmentDisposition` decides from this type, and
 * only `image/*` renders on this origin. */
const SESSION_FILE_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp'],
  ['avif', 'image/avif'],
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['log', 'text/plain'],
  ['csv', 'text/csv'],
  ['json', 'application/json'],
  ['xml', 'application/xml'],
  ['pdf', 'application/pdf'],
  ['zip', 'application/zip'],
  ['mp4', 'video/mp4'],
  ['mov', 'video/quicktime'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
])

/**
 * The media type one session-file path is served as. Pure; exported for tests.
 * @param {unknown} path
 * @returns {string}
 */
export function sessionFileType(path) {
  const value = String(path ?? '')
  const dot = value.lastIndexOf('.')
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (dot <= slash) return 'application/octet-stream'
  return SESSION_FILE_TYPES.get(value.slice(dot + 1).toLowerCase()) ?? 'application/octet-stream'
}

/**
 * Collect every local path one event frame surfaces into `set`. Pure; exported
 * for tests. Handles every frame shape the two transports produce — a durable
 * host record (`{ event: … }` or bare), an item payload, or a snapshot carrying
 * a `records` array — because the collector and the history ladder hand their
 * frames over exactly as they got them.
 * @param {Set<string>} set
 * @param {unknown} frame
 * @returns {void}
 */
export function collectFilePaths(set, frame) {
  if (!isRecord(frame)) return
  if (Array.isArray(frame.records)) {
    for (const record of frame.records) collectFilePaths(set, record)
    return
  }
  const event = isRecord(frame.event) ? frame.event : frame
  const type = String(event.type ?? '').toLowerCase()
  const data = isRecord(event.data) ? event.data : {}
  if (type === 'deliverables/presented') {
    const files = Array.isArray(data.files) ? data.files : []
    for (const file of files) {
      if (set.size >= SESSION_KNOWN_PATHS_MAX) return
      if (isRecord(file) && typeof file.path === 'string' && file.path) set.add(file.path)
    }
    return
  }
  if (type !== 'assistant/message') return
  const message = isRecord(data.message) ? data.message : data
  if (!Array.isArray(message.content)) return
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    MD_IMAGE_PATH_RE.lastIndex = 0
    let match
    while ((match = MD_IMAGE_PATH_RE.exec(block.text))) {
      if (set.size >= SESSION_KNOWN_PATHS_MAX) return
      const path = match[2] || match[3] || ''
      if (path) set.add(path)
    }
  }
}

/**
 * The attributes of the desktop pairing cookie.
 *
 * The bootstrap itself only answers to loopback today, so the `Secure` branch
 * is a guard rather than a live path: it is what keeps the cookie honest if the
 * desktop surface ever becomes reachable off-box (through the tunnel hostname,
 * say), where this cookie alone opens mode switching, PIN reset and disconnect.
 * `Max-Age` is the part that matters now — without it the cookie is a session
 * cookie, and a pairing window that survives a browser restart keeps a bearer
 * credential in the jar indefinitely.
 * @param {string} transportAddress
 * @param {number} ttlMs
 * @returns {string}
 */
export function desktopCookieAttributes(transportAddress, ttlMs = DESKTOP_COOKIE_TTL_MS) {
  const secure = isLoopbackAddress(transportAddress) ? '' : '; Secure'
  return `HttpOnly; SameSite=Strict; Path=/${secure}; Max-Age=${Math.floor(ttlMs / 1000)}`
}

/**
 * The hostname shape a Cloudflare named tunnel may be pointed at (design #3b).
 * Checked both where the desktop saves the config and where the bridge picks
 * the tunnel mode, so a hand-edited settings file cannot launch a tunnel
 * against a malformed hostname. The 253 here is the DNS wire cap — a shape
 * concern; how LONG a hostname may be stored is a different, tighter limit
 * (TUNNEL_HOSTNAME_MAX_LENGTH in lib/constants.js, the pairing-QR budget)
 * enforced by the settings store and the panel endpoint.
 * @param {unknown} hostname
 * @returns {boolean}
 */
export function isValidTunnelHostname(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0 || hostname.length > 253) return false
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/i.test(hostname)
}

/**
 * The `next` target the consent page may hand back (design #3c): one slash,
 * then a path — never `//` or `/\`, which browsers read as protocol-relative
 * and which would turn the disclaimer into an open redirect.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeConsentNext(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.startsWith('/\\')
  )
}

/**
 * @typedef {Object} PairingFailureState
 * @property {number} count failures counted inside the current window
 * @property {number[]} stamps when each of them happened
 * @property {number} [lockedUntil] epoch ms of the end of a hard lockout
 */

/**
 * @typedef {Object} LanMobileBridgeOptions
 * @property {() => string | undefined} harnessUrl Base URL of the Harness, e.g. http://127.0.0.1:19387.
 * @property {{
 *   ready(): Promise<string | undefined>
 *   invalidate(): void
 * }} innerAuth Process credential: `ready()` resolves to a `dsh-auth-xxx=...` cookie pair.
 * @property {'en' | 'zh' | (() => 'en' | 'zh')} [locale]
 * @property {{ light: string, dark: string }} [brandLogoPaths]
 * @property {string} [appIconPath]
 * @property {number} [port]
 * @property {(port: number) => Promise<object>} [createCloudflareTunnel] Test seam for the tunnel instance.
 * @property {(message: string) => void} [tunnelLog]
 * @property {(level: 'info' | 'warn' | 'error', message: string) => void} [log] Log sink; absent → diagnostics are dropped.
 * @property {number} [sseStatusMs] Cadence (ms) of the connection-state frames; defaults to SSE_STATUS_MS.
 * @property {number} [eventCollectorIdleMs] Poll-collector teardown ceiling (ms without a
 *   poll); defaults to EVENT_COLLECTOR_IDLE_MS. Test seam.
 * @property {number} [eventCollectorSessionsMax] LRU bound on concurrent poll collectors;
 *   defaults to EVENT_COLLECTOR_SESSIONS_MAX. Test seam.
 * @property {number} [eventHoldMs] How long an empty `/api/session/events` poll is
 *   held before it answers; defaults to EVENT_HOLD_MS, `0` answers at once. Test seam.
 * @property {() => number} [now]
 * @property {() => void} [onReconnectRequested]
 * @property {(connected: boolean) => void} [onConnectedChange]
 * @property {{ load(): { pin?: string, pinConsent?: boolean }, save(state: { pin?: string, pinConsent?: boolean }): boolean }} [pairingPinStore]
 * @property {{ load(): object, save(patch: object): boolean }} [settingsStore] Notify
 *   channel + named-tunnel credentials (lib/settings-store.js). Absent → notify
 *   off, quick tunnels only.
 * @property {{ load(now: number): object, save(state: object): boolean }} [sessionStore] Durable
 *   session maps (lib/session-store.js). Absent → sessions are memory-only and a
 *   restart un-pairs every phone.
 * @property {{ load(): object, save(document: object): boolean }} [openedAtStore] Per-device
 *   read ledger (lib/opened-at-store.js). Absent → the landing census's unread
 *   term degrades to 「never opened recently」 and reads are forgotten on restart.
 * @property {typeof fetch} [notifyFetchImpl] Test seam for the push channels.
 * @property {string} [hostRestartScript] Absolute path to scripts/dsh-restart-now.ps1 (the
 *   arming script the 重启宿主 button calls; see requestHostRestart for why it must be a
 *   Task Scheduler round trip).
 * @property {(script: string) => Promise<void>} [hostRestartInvoker] Test seam replacing the
 *   powershell spawn in requestHostRestart.
 */

/**
 * @typedef {Object} ConnectedDevice
 * @property {string} label
 * @property {string} remoteAddress
 * @property {number} issuedAt
 * @property {number} expiresAt
 * @property {string} id Opaque device handle the desktop revokes by. Derived
 *   from the session token with the desktop's own secret, so a phone that knows
 *   its token cannot name another device, and the desktop never sees the token.
 */

/**
 * @typedef {Object} MobileSession
 * @property {string} token
 * @property {string} remoteAddress
 * @property {string} [label] Short device label derived from the pairing User-Agent.
 * @property {number} [issuedAt]
 * @property {number} [expiresAt]
 * @property {string} [fingerprint] Coarse User-Agent digest; second condition on
 *   the LAN same-address shortcut (see `authorized`).
 * @property {number} [lastSeenAt] Last request this device proved with its
 *   cookie. Bounds how long an address alone stands for the device.
 */

/**
 * One paired device's durable profile (change 2026-10-07-feat-pocket-device-registry).
 * Keyed by `fingerprint` in the registry map; persisted in the session store
 * document. The profile is the device's identity across tunnel hostname
 * rotations: the PIN alone restores it, and whatever it consented to stays
 * consented.
 * @typedef {Object} DeviceProfile
 * @property {string} fingerprint Coarse User-Agent digest — the registry key.
 *   Deliberately coarse: it is a recall key for a device the user re-authorizes
 *   with the pairing password, never itself a credential.
 * @property {string} [label] Human-readable name from the pairing User-Agent.
 * @property {number} firstPairedAt When this device first entered the registry.
 * @property {number} expiresAt The device's credential expiry — refreshed to a
 *   full TTL on every (re)pairing and by the desktop's extend action.
 * @property {number} [lastSeenAt] Last successful authentication.
 * @property {'lan' | 'lan+wan'} permission Channel grant: first connected over
 *   the LAN → 'lan' (public access refused); over the tunnel → 'lan+wan'.
 * @property {number} [publicConsentedAt] When this device accepted the
 *   public-access disclaimer. Present → the consent gate lets it through
 *   without the cookie.
 */

/**
 * @typedef {Object} LanMobileBridgeSnapshot
 * @property {boolean} running
 * @property {boolean} connected
 * @property {number} [port]
 * @property {string} [pairingUrl]
 * @property {string} [desktopUrl]
 * @property {number} [expiresAt]
 * @property {boolean} [tunnelActive]
 * @property {boolean} [tunnelLoading]
 * @property {string} [tunnelUrl]
 * @property {string} [tunnelProvider]
 * @property {string} [tunnelError]
 * @property {ConnectedDevice[]} connectedDevices
 */

/**
 * @typedef {'lan' | 'tunnel'} MobileConnectionMode
 */

/**
 * @typedef {Object} PairingPinView
 * @property {string} [pin]
 * @property {boolean} expired
 * @property {boolean} consent
 * @property {number} [expiresAt]
 */

export class LanMobileBridge {
  /** @type {import('node:http').Server | undefined} */
  server
  /** @type {number | undefined} */
  port
  /** @type {string | undefined} */
  pairingToken
  /** @type {number | undefined} */
  pairingExpiresAt
  /** @type {object | undefined} */
  tunnelInstance
  tunnelActive = false
  tunnelLoading = false
  /** @type {string | undefined} */
  tunnelError
  /** @type {Promise<void> | undefined} */
  tunnelLaunch
  /**
   * Synchronous host-exit handler that terminates the live cloudflared child
   * (M12). One at a time: armed by `armTunnelProcess`, removed when that tunnel
   * stops, so toggling the tunnel cannot accumulate listeners on the host.
   * @type {(() => void) | undefined}
   */
  tunnelExitCleanup
  /** @type {Map<string, MobileSession>} */
  sessions = new Map()
  /** Twin of resumableSessions — parked by the same two paths (see below). */
  /** @type {Map<string, MobileSession>} */
  suspendedSessions = new Map()
  /**
   * Sessions parked by a desktop disconnect or an unexpected tunnel death
   * (handleUnexpectedTunnelClose parks the same way). Reconnect will not
   * honor anything else.
   */
  /** @type {Map<string, MobileSession>} */
  resumableSessions = new Map()
  /**
   * The device registry (change 2026-10-07-feat-pocket-device-registry): one
   * durable profile per paired device, keyed by the User-Agent fingerprint.
   * This is the memory half; the disk half rides the session store document
   * (lib/session-store.js `devices`), loaded by restorePersistedSessions and
   * written by the same debounced persist as the session maps.
   * @type {Map<string, DeviceProfile>}
   */
  devices = new Map()
  /**
   * Live streaming responses per session token — the "kick offline" half of a
   * revoke. Registered by trackDeviceStream around the SSE wrapper only (the
   * poll fallback answers within one request, so there is nothing to kick);
   * entries remove themselves on response close and are destroyed by
   * revokeDevice.
   * @type {Map<string, Set<import('node:http').ServerResponse>>}
   */
  deviceStreams = new Map()
  pendingQuestions = new Map()
  /**
   * How many unanswered questions the ceiling in {@link rememberPendingQuestion}
   * has thrown out over the life of this bridge — a lifetime total, not a count of
   * the event it is printed beside. The downlink quotes it on every line it writes
   * when a table still holding prompts is dropped (lib/mux-client.js), under the
   * field name `evictedLifetime=` so nobody reads it as "N more just got evicted".
   * Counted and never named: the dropped keys are the Host's event ids. That single
   * grep answers "why is this question not on screen" both ways the table shrinks
   * without anyone answering.
   * @type {number}
   */
  pendingQuestionEvictions = 0
  /** @type {string | undefined} */
  ephemeralPin
  /** @type {number | undefined} */
  ephemeralPinExpiresAt
  pinFailuresByIp = new Map()
  pinFailuresGlobal = []
  tunnelExpectedStop = false
  /** @type {string | undefined} */
  lastTunnelProvider
  unexpectedlyClosed = false
  /** @type {number | undefined} */
  tunnelExpiresAt
  /** Client generation id from the event stream's `ready` frame; results quote it. */
  /** @type {string | undefined} */
  eventClientId
  /** Latest `workspace/follow` baseline, standing in for the removed unary list. */
  workspaceSnapshot
  /** @type {() => number} */
  now
  /** @type {AbortController | undefined} */
  muxAbort
  /** @type {Promise<void> | undefined} */
  muxTask
  sessionStreamAborts = new Set()
  /**
   * Per-session poll collectors backing `GET /api/session/events` (the tunnel
   * fallback). Created lazily by the first poll of a session, torn down after
   * the idle ceiling or by LRU — see lib/session-stream.js.
   * @type {Map<string, ReturnType<import('./session-stream.js').createSessionEventCollector>>}
   */
  sessionEventCollectors = new Map()
  /**
   * Release functions for the empty polls this bridge is currently holding open.
   * A holder is a live phone request: `stop()` must answer it rather than let it
   * sit out its ceiling against a bridge that is already gone.
   * @type {Set<() => void>}
   */
  eventHolds = new Set()
  /**
   * Per-session sets of local paths the session's own event stream has surfaced
   * (a `deliverables/presented` file, or a markdown image in an assistant
   * message). This set IS the authorisation of `GET /api/session-file`: a path
   * outside it answers 404, so the pairing cookie alone never buys a local-file
   * read. Memory only — never persisted, never logged; evicted by insertion
   * order past SESSION_KNOWN_PATH_SETS_MAX sessions and cleared with the bridge.
   * Assigned-not-declared (see the field ledger below): noteSessionFilePaths
   * mints the map on first use, the way every stub-exercised field here does.
   * @type {Map<string, Set<string>> | undefined}
   */
  /**
   * Per-conversation reconnect state for the phone's session stream:
   * consecutive Host-side failures and when the last one happened. Drives both
   * the `retry:` this bridge publishes and the gate that refuses an attempt that
   * arrives before that retry has elapsed (§3 backoff / X4③).
   * @type {Map<string, { failures: number, lastAt: number }>}
   */
  streamBackoff = new Map()
  lastConnected = false
  desktopSessionToken = randomBytes(32).toString('base64url')
  /** @type {string | undefined} */
  desktopBootstrapToken
  /** @type {number | undefined} */
  desktopBootstrapExpiresAt
  /** Memoized pairing-QR SVG keyed by pairing URL; cleared on token rotation. */
  qrSvgCache = new Map()
  /** First-read disk caches for the fixed process-lifetime image paths. */
  imageBufferCache = new Map()
  /**
   * The resized (≤96px) PNG the UI wants, held as bytes so `/app-icon?ui=1` can
   * serve it. `iconDataUri` is the same picture for the pages that must not make
   * an image round-trip; the app document does not qualify and used to inline it
   * three times per cold open.
   * @type {Buffer | null}
   */
  iconUiBytes = null
  /** @type {number | undefined} */
  sseStatusMs
  /**
   * Is the carrier WebSocket to the Host up RIGHT NOW? Set by the mux client on
   * open and on settle. `connected` in the status payload has always meant "this
   * bridge answered", which is why a phone could show a green dot over a frozen
   * conversation; this is the field that means what a dot is supposed to mean.
   */
  muxConnected = false
  /**
   * Last observation of the Host's own reachability, from the last completed
   * inner call — never a probe of its own, so it costs no extra traffic.
   * @type {{ at: number, ok: boolean, code: string | undefined } | undefined}
   */
  hostProbe
  /**
   * Pairings that passed the PIN but still wait for a desktop approve/deny
   * (design #4a). Keyed by the opaque confirmId the phone polls with.
   * @type {Map<string, { id: string, label: string, remoteAddress: string, createdAt: number, expiresAt: number, status: 'pending' | 'approved' | 'denied' }>}
   */
  pendingPairings = new Map()
  /** Per-IP 1s windows for the `/pair/pending` light limiter. */
  pendingPollCounts = new Map()
  /** Notify settings as of construction / the last desktop save. */
  notifyConfig = {
    channel: 'off',
    key: '',
    enabled: false,
    clawbot: { botToken: '', userId: '', contextToken: '' }
  }
  /** @type {AbortController | undefined} */
  clawbotAbort = undefined
  clawbotBuf = ''
  clawbotLoopRunning = false
  /** 本轮入站之后已占用的出站额度条数（见 {@link clawbotQuotaTail}）。 */
  clawbotQuotaUsed = 0
  /** Completion-judge state per session id at the previous notify tick. */
  notifyJudgeStates = new Map()
  /**
   * Retry-storm bookkeeping per session id: `{ nextProbeAt, coolingUntil }`.
   * Entry appears when a session first reads as storm-suspect (running past
   * `suspectAfterMs`) and is deleted the first tick it reads as settled — a
   * fresh storm starts from a clean slate, and a settled session never owes a
   * probe. Memory-only: a restart may re-announce an ongoing storm once, which
   * is the correct side to err on.
   * @type {Map<string, { nextProbeAt: number, coolingUntil: number }>}
   */
  retryStorms = new Map()
  /** Question event ids that already pushed an approval notice (dedup). */
  notifiedQuestionKeys = new Set()
  /**
   * 服务端说这一轮没额度了（`ret=-2 prepare failed`）时置位。置位期间不再发推送：
   * 每 30 秒再试一次也不会成功（要用户在微信回一句才行），只会多一行日志。
   * 任何一条入站消息都清掉它——那才是真正给额度续期的东西。
   * 它**不**扣着任何消息：推送是当场发的，发不出去就丢（用户 2026-10-11：没推到的就没推到）。
   */
  clawbotQuotaSpent = false
  /**
   * 上一次已经回给微信的那个隧道地址。只在内存里，不落盘——重启后第一次入站要再说
   * 一遍当前地址（那头手里的可能已经过期了），这正是我们想要的。
   * 作用：入站时隧道本来就在跑、地址也没变，就不必再回一条（省一条出站额度）。
   * @type {string}
   */
  clawbotDoorUrl = ''
  /** @type {import('node:timers').Timeout | undefined} */
  notifyTimer
  /** Durable session maps (lib/session-store.js); undefined = memory-only. */
  sessionStore = undefined
  /** @type {import('node:timers').Timeout | undefined} */
  sessionPersistTimer
  /**
   * Fingerprint of the last durable-document payload: every request funnels
   * through syncConnected() -> scheduleSessionPersist(), and almost none of
   * them change a session record, so without this the store rewrote an
   * unchanged document over and over. `savedAt` is excluded — it changes on
   * every call and would make the comparison always differ.
   */
  lastPersistFingerprint
  /** Per-device read ledger (lib/opened-at-store.js); undefined = memory-only. */
  openedAtStore = undefined
  /** @type {import('node:timers').Timeout | undefined} */
  openedAtPersistTimer
  /**
   * Assigned-not-declared fields (no class-field declarations, so an instance
   * carries no own-property for these until the assigning method runs):
   *   muxMonitor        — constructor; wraps the carrier connection (createMuxMonitor)
   *   iconDataUri       — start(); decoded app icon for the boot payload
   *   _sessionCursors   — rememberSessionCursor(); per-session history cursors
   *   _mobileAssets     — mobileAssetBodies(); hashed static shell per locale
   *   _sessionListCache — cachedSessionList(); 10s-TTL session catalogue promise,
   dropped by invalidateSessionList() when a session write (model or
   preset switch) changes what its rows carry
   *   _sessionListValue — fetchSessionList(); the last cleanly resolved catalogue,
   *                       the one the cold-open document stands in with while a
   *                       fresh one is fetched behind the response
   *   _settingsCache    — cachedSettings(); 5s-TTL settings promise
   *   _modelCatalogCache — cachedModelCatalog(); 30s-TTL model-catalogue promise,
   *                        dropped by invalidateModelCatalog() on a model switch
   *   _agentPresetsCache — cachedAgentPresets(); 30s-TTL agent-presets promise,
   *   _prewarmAt        — prewarmMobileBoot(); last cold-path warm start (throttle)
   *   _savingsAt        — noteSavings(); last-logged-at per label (60s floor)
   *   sessionKnownPaths — noteSessionFilePaths(); the session-file allowlist sets
   */

  /** @param {LanMobileBridgeOptions} options */
  constructor(options) {
    this.options = options
    this.now = options.now ?? Date.now
    this.sseStatusMs = options.sseStatusMs ?? SSE_STATUS_MS
    this.eventCollectorIdleMs = options.eventCollectorIdleMs ?? EVENT_COLLECTOR_IDLE_MS
    this.eventHoldMs = options.eventHoldMs ?? EVENT_HOLD_MS
    this.eventCollectorSessionsMax = options.eventCollectorSessionsMax ?? EVENT_COLLECTOR_SESSIONS_MAX
    this.sessionStore = options.sessionStore
    this.openedAtStore = options.openedAtStore
    this.readNotifyConfig()
    // ClawBot 额度计数落盘（用户 2026-10-12「重启不归零」）：本地计数是服务端额度的
    // 模拟，桥重启从 0 重数是它最大的漂移源——服务端那 10 条是跟着入站走的，不跟着
    // 桥的进程走。存进现成设置档的 notify.clawbot 节（诊断开关同一份文件），一个被
    // 覆盖写的整数，不膨胀。
    const savedQuota = this.options.settingsStore?.load?.()?.notify?.clawbot?.quotaUsed
    if (typeof savedQuota === 'number' && Number.isSafeInteger(savedQuota) && savedQuota > 0) {
      this.clawbotQuotaUsed = savedQuota
    }
    this.muxMonitor = createMuxMonitor({
      harnessUrl: () => this.options.harnessUrl(),
      innerAuth: this.options.innerAuth,
      pendingQuestions: this.pendingQuestions,
      pendingQuestionEvictions: () => this.pendingQuestionEvictions,
      log: (level, message) => this.log(level, message),
      now: () => this.now(),
      consumeMuxEnvelope: (data) => this.consumeMuxEnvelope(data),
      setEventClientId: (id) => { this.eventClientId = id },
      reportMuxState: (up) => this.noteMuxState(up)
    })
  }

  /**
   * Record the live carrier state and say so when it changes.
   *
   * The phone shows one dot for "connected", and until now the only thing it
   * could read was whether this bridge answered — so a Host that stopped
   * answering kept the dot green over a conversation that no longer moved. The
   * transitions are logged too: "green dot, frozen screen" is otherwise
   * unreproducible after the fact (X4⑤).
   * @param {boolean} up
   */
  noteMuxState(up) {
    const live = up === true && this.muxAbort !== undefined && !this.muxAbort.signal.aborted
    if (this.muxConnected === live) return
    this.muxConnected = live
    this.log('info', `mux carrier ${live ? 'up' : 'down'} sessions=${String(this.sessions.size)}`)
  }

  /**
   * What the phone should wait before it reconnects this conversation's stream.
   *
   * Every reconnect opens ANOTHER carrier WebSocket into the Host. The field was
   * a flat `retry: 500`, so a Host that refuses the follow turned one idle phone
   * into two attempts a second with nothing on disk to explain the traffic
   * (§3 backoff). Zero recorded failures — the state a fresh bridge and every
   * healthy conversation is in — still answers exactly 500.
   * @param {string} sessionId
   * @returns {number}
   */
  streamRetryDelayMs(sessionId) {
    const failures = this.streamBackoff.get(sessionId)?.failures ?? 0
    if (failures <= 0) return STREAM_RETRY_BASE_MS
    return Math.min(
      STREAM_RETRY_BASE_MS * 2 ** Math.min(failures, 10),
      STREAM_RETRY_CAP_MS
    )
  }

  /**
   * How long this conversation's stream must still be kept away from the Host.
   *
   * A phone that obeys the `retry:` it was told cannot arrive faster than that
   * anyway; this gate exists for the ones that do — a second tab, a reconnecting
   * EventSource after a hard navigation — because every one of those opens
   * ANOTHER carrier WebSocket into a Host that just refused it.
   *
   * The first failure never gates: a person pressing reload after one blip must
   * get an answer. From the second consecutive failure on, an attempt that
   * arrives inside the retry window this bridge published is answered from the
   * bridge instead of being forwarded.
   * @param {string} sessionId
   * @returns {number} 0 when the attempt may go through
   */
  streamCooldownMs(sessionId) {
    const state = this.streamBackoff.get(sessionId)
    if (state === undefined || state.failures < 2) return 0
    const wait = this.streamRetryDelayMs(sessionId) - (this.now() - state.lastAt)
    return wait > 0 ? wait : 0
  }

  /** @param {string} sessionId @returns {void} */
  noteStreamFailure(sessionId) {
    const previous = this.streamBackoff.get(sessionId)
    const state = { failures: (previous?.failures ?? 0) + 1, lastAt: this.now() }
    this.streamBackoff.delete(sessionId)
    this.streamBackoff.set(sessionId, state)
    while (this.streamBackoff.size > STREAM_BACKOFF_KEYS_MAX) {
      // One entry per conversation id: a phone walking a long workspace list must
      // not grow this without bound. Insertion order puts the least recently
      // touched conversation first. The bound is the constant that describes
      // THIS map: reusing the device-map cap made the reconnect state inherit a
      // number picked for a different collection, so the two could drift apart
      // without any test noticing.
      const oldest = this.streamBackoff.keys().next().value
      if (oldest === undefined) return
      this.streamBackoff.delete(oldest)
    }
    this.log('warn', `session stream backing off session=${sessionId} failures=${String(state.failures)} retryMs=${String(this.streamRetryDelayMs(sessionId))}`)
  }

  /** A stream that reached its normal end clears the conversation's backoff. @param {string} sessionId @returns {void} */
  noteStreamSuccess(sessionId) {
    this.streamBackoff.delete(sessionId)
  }

  /**
   * @param {'info'|'warn'|'error'} level
   * @param {string} message
   */
  log(level, message) {
    try {
      this.options.log?.(level, message)
    } catch {
      // logging must never break request handling
    }
  }

  // -- Completion notifications (design #2) ---------------------------------

  /** Re-read the notify section from the settings store into memory. */
  readNotifyConfig() {
    const section = this.options.settingsStore?.load()?.notify
    this.notifyConfig = {
      channel: NOTIFY_CHANNELS.includes(section?.channel) ? section.channel : 'off',
      key: typeof section?.key === 'string' ? section.key : '',
      enabled: section?.enabled === true,
      clawbot: section?.clawbot || { botToken: '', userId: '', contextToken: '' }
    }
  }

  /** The desktop-facing view of the notify settings: the key never leaves masked. */
  notifyConfigView() {
    const claw = this.notifyConfig.clawbot || {}
    return {
      channel: this.notifyConfig.channel,
      enabled: this.notifyConfig.enabled === true,
      keyMasked: maskKey(this.notifyConfig.key),
      clawbot: {
        bound: Boolean(claw.botToken || (this.notifyConfig.channel === 'clawbot' && this.notifyConfig.key)),
        hasContext: Boolean(claw.contextToken),
        userIdMasked: claw.userId ? maskKey(claw.userId) : ''
      }
    }
  }

  /** The tunnel section of the settings store, sanitized. */
  readTunnelConfig() {
    const section = this.options.settingsStore?.load()?.tunnel
    return {
      token: typeof section?.token === 'string' ? section.token : '',
      hostname: typeof section?.hostname === 'string' ? section.hostname.trim() : ''
    }
  }

  /** The desktop-facing view of the tunnel credentials: token masked only. */
  tunnelConfigView() {
    const tunnel = this.readTunnelConfig()
    return { tokenMasked: maskKey(tunnel.token), hostname: tunnel.hostname }
  }

  /** Is a push channel fully configured right now? The single notify gate. */
  notifyReady() {
    const { enabled, channel, key, clawbot } = this.notifyConfig
    if (enabled !== true || channel === 'off') return false
    if (channel === 'clawbot') {
      return Boolean(key || clawbot?.botToken) && Boolean(clawbot?.contextToken)
    }
    return key !== ''
  }

  /** Sleep that unrefs the timer and aborts immediately if the signal aborts. */
  abortableSleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      }
    })
  }

  /** Arm or disarm the ClawBot background updates watcher. */
  syncClawbotWatcher() {
    const isClawbot = this.notifyConfig.channel === 'clawbot' &&
                      this.notifyConfig.enabled === true &&
                      Boolean(this.notifyConfig.key || this.notifyConfig.clawbot?.botToken)
    if (isClawbot) {
      this.startClawbotWatcher()
    } else {
      this.stopClawbotWatcher()
    }
  }

  startClawbotWatcher() {
    if (this.clawbotLoopRunning) return
    this.clawbotLoopRunning = true
    const abort = new AbortController()
    this.clawbotAbort = abort

    const botToken = this.notifyConfig.key || this.notifyConfig.clawbot?.botToken
    if (!botToken) {
      this.clawbotLoopRunning = false
      return
    }
    const fetchImpl = this.options.notifyFetchImpl || fetch
    const baseUrl = this.options.clawbotBaseUrl

    ;(async () => {
      try {
        await notifyStart(botToken, { fetchImpl, baseUrl, signal: abort.signal })
      } catch {
        // ignore
      }

      while (!abort.signal.aborted && this.clawbotLoopRunning) {
        try {
          const res = await getUpdates(botToken, this.clawbotBuf, {
            fetchImpl,
            baseUrl,
            signal: abort.signal,
            timeout: 30
          })
          if (abort.signal.aborted || !this.clawbotLoopRunning) break
          if (!res.ok) {
            await this.abortableSleep(5000, abort.signal)
            continue
          }
          if (res.buf) {
            this.clawbotBuf = res.buf
          }
          // A real getupdates long-polls for `timeout` seconds, so an empty
          // batch already cost that wait. A stubbed or degraded endpoint can
          // answer instantly, and without this idle gap the loop would spin
          // hot on the event loop every time it does.
          if (!Array.isArray(res.msgs) || res.msgs.length === 0) {
            if (abort.signal.aborted || !this.clawbotLoopRunning) break
            await this.abortableSleep(CLAWBOT_IDLE_POLL_MS, abort.signal)
            continue
          }
          if (Array.isArray(res.msgs) && res.msgs.length > 0) {
            for (const msg of res.msgs) {
              // 续期挂在**每条入站**上，不挂在「令牌变了」上：同一条对话线可能反复给出
              // 同一个 context_token 字符串，那样下面那个 isNew 分支根本进不去，
              // 而微信侧的额度照样是每条入站重新给满 10 条（实测，见 clawbotQuotaTail）。
              this.refillClawbotQuota()
              const contextToken = msg.context_token
              const fromUserId = msg.from_user_id
              if (contextToken) {
                const currentClaw = this.notifyConfig.clawbot || {}
                const isNew = currentClaw.contextToken !== contextToken
                if (isNew || currentClaw.userId !== fromUserId) {
                  const nextClawbot = {
                    botToken,
                    userId: fromUserId || currentClaw.userId || '',
                    contextToken
                  }
                  const notify = {
                    channel: 'clawbot',
                    key: botToken,
                    enabled: this.notifyConfig.enabled,
                    clawbot: nextClawbot
                  }
                  this.options.settingsStore?.save({ notify })
                  this.readNotifyConfig()
                  this.syncNotifyWatcher()
                  this.log('info', 'clawbot context_token updated and persisted')

                  // 「通道已就绪」这封回执只在**第一次绑定**时发。
                  // 它本身要占一条额度（实测一条入站换 10 条，回执吃掉第 1 条，用户实际只有 9 条可用），
                  // 而续期时它已经没有任何信息量了——额度还剩几条每条推送都写着「（第 N/10 条）」，
                  // 再发一句「已就绪」等于白拿一次投递机会去说废话。用户 2026-10-10 拍的这条。
                  if (!currentClaw.contextToken) {
                    const ack = await sendTextMessage(
                      botToken,
                      {
                        contextToken,
                        toUserId: fromUserId || '',
                        text: '微信通知通道已就绪：任务完成、等待审批或连接地址变更会推到这里。' +
                          this.clawbotQuotaTail()
                      },
                      { fetchImpl, baseUrl, signal: abort.signal }
                    ).catch((error) => ({
                      ok: false,
                      error: error instanceof Error ? error.name : 'Error'
                    }))
                    // 这条握手消息发不出去 = 这一轮推不动了（额度已尽——实测一条入站换 10 条出站、
                    // 本条回执自己就占 1 条／缺令牌／参数被拒；`prepare failed` 不是计时器到期，别去找 TTL）。
                    // 此前被 `catch {}` 静默吞掉，日志里看不出通道已死，
                    // 表现为「配好了但永远收不到」。只记 ok/失败类名，不引述 errmsg
                    // （沿用 D6：失败理由不进日志，回显体不保证不含敏感串）。
                    if (ack.ok) {
                      this.log('info', 'clawbot ready notice sent')
                    } else {
                      this.log('warn', `clawbot ready notice failed ${ack.error}`)
                    }
                  }
                }
              }
            }
            // 「在微信说一句 → 桥把公网隧道拉起来（或发现已在跑）→ 把地址回给你」。
            // 这就是用户 2026-10-10 21:0x 要的那个「能打开的远程」的最小形态：
            // 不新增任何 HTTP 端点，桥也没有多出任何可以被动触发的入口——
            // 唯一的触发器是**一条经过认证的微信入站**（那条路上只有绑定的人能说话），
            // 而它调用的就是手机/桌面那个隧道开关背后的同一段逻辑 toggleTunnel。
            // 地址不是立刻就有（cloudflared 冷启动要下载），所以整段是异步的。
            //
            // **刻意的排法**：**排在 refillClawbotQuota 之后、且不 await**。
            //   放在 refill 之后是因为它要占用额度计数（下发一条就是花掉一条）；
            //   不 await 是因为入站循环是串行的，拉隧道要下载 cloudflared、秒级起步，
            //   await 它会把下一轮 getupdates 一起堵住。
            //   地址只要发出去就行，早一条晚一条不影响对错，循环立刻转下一轮。
            void this.ensureTunnelForInbound(fetchImpl, baseUrl, abort.signal)
          }
        } catch {
          if (abort.signal.aborted || !this.clawbotLoopRunning) break
          await this.abortableSleep(5000, abort.signal)
        }
      }
    })().catch(() => {})
  }

  /**
   * 微信入站 → 确保公网隧道在跑，并把地址回给说话的人。
   *
   * 这是「最小的远程入口」：桥本来就有隧道开关（桌面 UI 与手机页面按的是同一个
   * {@link toggleTunnel}），这里只是让**一条经过认证的微信入站**也能按下它。
   * 因此没有新增端点、没有新增本地文件、没有给 AI 任何工具——触发器只有一个，
   * 且那条路上只有绑定过的人能说话。
   *
   * 回话**只在地址真的换了（或压根没打开）时才发**。用户 2026-10-10 21:0x 问过
   * 「那正常发，他就每次返回地址吗？」——每次照抄一遍同一个地址是噪音，还白吃一条
   * 出站额度；而这一条入站刚续满的 10 条额度该留给邮包和真消息。
   * 所以只有三种情况回话：隧道没打开、报错、以及地址与上次回过的那个不同。
   * 把上次回过的地址记在内存里（`clawbotDoorUrl`），不落盘：重启后第一次入站会再说
   * 一遍当前地址，那是**想要的**——重启后微信那头手里的地址可能已经过期了。
   * @param {typeof fetch} fetchImpl
   * @param {string} baseUrl
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   */
  async ensureTunnelForInbound(fetchImpl, baseUrl, signal) {
    const config = this.notifyConfig
    if (config?.channel !== 'clawbot') return
    const claw = config.clawbot || {}
    const botToken = claw.botToken || claw.token || config.token
    const contextToken = claw.contextToken
    const toUserId = claw.userId || ''
    if (!botToken || !contextToken) return

    let url = ''
    let failure = ''
    try {
      const snapshot = await this.toggleTunnel(true)
      url = (snapshot?.tunnelUrl || this.tunnelInstance?.url || '') + (this.diagnosticsProbeEnabled() ? '/?probe=1' : '')
      if (!url) failure = snapshot?.tunnelError ? `：${snapshot.tunnelError}` : '，稍后再试'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log('warn', `inbound tunnel ensure failed: ${message}`)
      failure = `：${message}`
    }

    // 地址没变就**一个字都不发**（用户 2026-10-10 21:0x 问过「那正常发，他就每次返回
    // 地址吗？」）：回一条要吃掉这一轮入站刚续上的 10 条里的一条，还会占掉额度槽——省
    // 下来留给邮包和真消息。地址换了（新隧道＝新观众）才值得说一句。只有失败才每次都回：
    // 那本身就是用户要知道的答案，沉默会被当成消息丢了。就绪半句（用户 2026-10-12）：
    // quick tunnel 边缘注册有几秒窗口，地址一发过来就点偶尔打不开，先说明白。
    if (url && url === this.clawbotDoorUrl) return

    // 这条回话**占用同一条服务器额度**（一条入站换 10 条出站，服务器数的是所有出站），
    // 所以必须走同一本账（clawbotQuotaTail 预占计数）。2026-10-13 前它不计数：一次隧道
    // 换址的交接就让账本比服务器落后一条，此后「第 10 条捎话」永远差一条——额度耗尽的
    // 那条推送被服务端静默拒收，用户只看到消息停了、没有任何解释。计数对齐后，交接若
    // 恰好是本轮最后一条，捎话就搭这条车（它也是一条真微信消息，正是该说这话的时候）。
    const tail = this.clawbotQuotaTail()
    let text = url ? `Pocket 已打开：${url}\n打不开就等几秒再点` : `Pocket 隧道没打开${failure}`
    if (tail) text += tail
    if (url) this.clawbotDoorUrl = url

    const ack = await sendTextMessage(
      botToken,
      { contextToken, toUserId, text },
      { fetchImpl, baseUrl, signal }
    ).catch((error) => ({ ok: false, error: error instanceof Error ? error.name : 'Error' }))
    if (ack.ok) {
      this.log('info', 'inbound tunnel reply sent')
    } else {
      // 失败分类与 notify.js 的 clawbot 分支同规：服务端拒收（额度已尽）＝额度态本身，
      // 不回滚、挂起后续推送；传输丢失（服务端没收到、没扣额度）＝「没发出去的不算」，回滚。
      if (/prepare failed|invalid arguments|ret -2/i.test(String(ack.error || ''))) {
        this.markClawbotQuotaSpent()
      } else {
        this.rollbackClawbotQuota()
      }
      this.log('warn', `inbound tunnel reply failed ${ack.error}`)
    }
  }
  stopClawbotWatcher() {
    this.clawbotLoopRunning = false
    if (this.clawbotAbort) {
      this.clawbotAbort.abort()
      this.clawbotAbort = undefined
    }
  }

  /** Arm or disarm the notify poll to match the live config. */
  syncNotifyWatcher() {
    if (this.notifyReady()) this.startNotifyWatcher()
    else this.stopNotifyWatcher()
  }

  startNotifyWatcher() {
    if (this.notifyTimer) return
    this.notifyTimer = setInterval(() => {
      void this.pollNotifyRunning()
    }, NOTIFY_POLL_MS)
    this.notifyTimer.unref?.()
  }

  stopNotifyWatcher() {
    if (this.notifyTimer === undefined) return
    clearInterval(this.notifyTimer)
    this.notifyTimer = undefined
  }

  /**
   * 额度尾巴：判「这是额度内最后一条」，在那条的正文里捎一句话。
   *
   * 一条入站消息换 10 条出站——本机 2026-10-10 11:00 受控实验实测：就绪回执 + 9 条测试推送
   * 全部成功，第 11 条起服务端回 `ret=-2 prepare failed`；与微信官方「每下发 10 次需主动发一句」
   * 吻合。协议里**没有分钟级 TTL**（只列 `errcode -14` 会话过期），所以这不是计时器、是配额。
   *
   * 数字不再上屏（用户 2026-10-12 拍板）：本地计数是模拟——重启、独立探针、失败边界都会漂，
   * 漂一个没人消费的数字毫无价值。计数只剩一个职责：判 used === LIMIT（额度内最后一条），
   * 捎一句「额度用完，回微信回一句话续上」——必须在通道死掉**之前**说；用尽之后再推
   * 「额度用尽」是逻辑陷阱，那条恰好发不出去。超限后服务端会拒（onQuota 挂起），不再文案。
   *
   * 计数是**预占**：算尾巴时就 +1，不等发送结果——并发下「先算后发」会让两条撞出同一个序号。
   * 传输丢失（服务端没收到）经 onSendLost 回滚；额度拒绝不回滚（那次拒绝就是额度态本身）。
   * 计数落盘（{@link persistClawbotQuota}）：重启接着数，不再从 0 骗小。
   * @param {object} [config] 通知配置；非 clawbot 通道没有这份额度，返回空串（正文一字不改）
   * @returns {string}
   */
  clawbotQuotaTail(config = this.notifyConfig) {
    if (config?.channel !== 'clawbot') return ''
    this.clawbotQuotaUsed += 1
    this.persistClawbotQuota()
    if (this.clawbotQuotaUsed === CLAWBOT_QUOTA_LIMIT) {
      return `（额度用完，在微信回一句就续上）`
    }
    return ''
  }

  /**
   * 把当前计数写进设置档的 notify.clawbot 节。store 对 notify 节是字段级合并
   * （未提名的 channel/key/enabled 保留盘上值），但 clawbot 子节**提名即整体替换**——
   * 所以必须读-改-写带全 clawbot 字段：直接 save({clawbot:{quotaUsed}}) 会把
   * botToken/userId/contextToken 抹掉。没有存储时静默跳过，行为同旧版内存计数。
   */
  persistClawbotQuota() {
    try {
      const store = this.options.settingsStore
      if (!store?.load || !store?.save) return
      const section = store.load()?.notify?.clawbot || {}
      store.save({ notify: { clawbot: { ...section, quotaUsed: this.clawbotQuotaUsed } } })
    } catch {}
  }

  /** 传输丢失回滚：那条推送服务端根本没收到、没扣额度，「确认没发出去的不算」（用户 2026-10-12）。 */
  rollbackClawbotQuota() {
    if (this.clawbotQuotaUsed <= 0) return
    this.clawbotQuotaUsed -= 1
    this.persistClawbotQuota()
  }

  /**
   * 入站消息 ＝ 额度续期：计数归零、解除「已用完」的挂起。
   * 归零点是**入站**，不是时间、也不是重启（见 {@link clawbotQuotaTail}）。
   * @returns {void}
   */
  refillClawbotQuota() {
    this.clawbotQuotaUsed = 0
    this.clawbotQuotaSpent = false
    this.persistClawbotQuota()
  }

  /** 服务端判定本轮额度已尽：发车挂起，到下一次入站为止（重试也只会再吃一个拒）。 */
  markClawbotQuotaSpent() {
    if (this.clawbotQuotaSpent) return
    this.clawbotQuotaSpent = true
    this.log('warn', 'clawbot quota spent: holding notices until the next inbound message')
  }

  /**
   * 手机页的最后一次活性证据：注册表里最新的 lastSeenAt。页面活着时，事件长轮询
   * 每 ~8-10s 过一次认证刷一次（EVENT_HOLD_MS 节奏）；切后台页面自己停轮询
   * （visibilitychange → pauseEventPolling），锁屏/系统冻结同理——lastSeenAt 停刷即「不在看」。
   * @returns {number}
   */
  phoneLiveAt() {
    let latest = 0
    for (const device of this.devices.values()) {
      const seen = device.lastSeenAt ?? 0
      if (seen > latest) latest = seen
    }
    return latest
  }

  /**
   * 本次推送可带的入口 URL：当前活跃隧道的地址（诊断开着带 ?probe=1，与微信交接回执
   * 同一拼法）。隧道没跑就返回空串——那条推送不带链接行，行为与旧版一致。
   * 每次现取，不复用 clawbotDoorUrl（那是「上次交接过」的记忆，quick tunnel 换域名后过期）。
   * @returns {string}
   */
  noticeDoorUrl() {
    const base = this.tunnelInstance?.url || ''
    if (!base) return ''
    return base + (this.diagnosticsProbeEnabled() ? '/?probe=1' : '')
  }

  /**
   * 发一条推送 —— 有消息就推，当场推，推不出去就丢。
   *
   * 用户 2026-10-11 定：「有消息就推，不管是完成还是提问错误，只要有会话就推送。
   * 不要搞什么搭车不搭车、什么时间、什么信封……没推到的就没推到，也不用管了。」
   * 于是 0.4.12–0.4.30 那套邮包（攒批、班次表、落盘、补投）整体作废：这个方法就是
   * 一个 notifySend 加上额度记账，没有任何队列、没有等待、没有重试。
   *
   * 前台抑制（用户 2026-10-12）：手机页正开着且活着时，消息在页面上已经实时可见，
   * 推送是重复打扰——MOBILE_LIVE_FRESH_MS 内见过手机就跳过。旧注释「notifier 的
   * 整个场景就是手机页关着」从「事实」变成「闸门」：关着的页 lastSeenAt 停刷，照推。
   *
   * 每条推送自带入口 URL（用户 2026-10-12）：「看到消息肯定要看，肯定就要点链接，
   * 总不能每次都往上翻到第一次」——正文末尾另起一行放本次隧道地址（隧道没跑则不带）。
   *
   * 额度尾巴经 `quotaTail` 钩子递给 notify.js 的 clawbot 分支；传输丢失经 `onSendLost`
   * 回滚预占的计数（见 {@link clawbotQuotaTail}）。
   *
   * 唯一的闸门是 `clawbotQuotaSpent`：服务端已经说过这一轮没额度了（`ret=-2 prepare
   * failed`），再试也只是多一条拒收日志，所以直接返回——但它**不扣着任何消息**，
   * 消息本来就已经发出去了（或丢掉了），不像旧版那样留在包里等下一次入站。
   * @param {string} title 通知栏第一行的对象（会话名）
   * @param {string} body 正文（原因）
   * @returns {Promise<boolean>} 服务端是否受理
   */
  async sendNotice(title, body) {
    const config = this.notifyConfig
    if (!this.notifyReady()) return false
    // 「额度已尽」只属于 clawbot：中途换到 Server酱／Bark 之类没有额度的通道时，
    // 这个挂起标志再没有任何东西会清掉它（清它的入站消息只可能来自 clawbot），
    // 留着就会把后续推送全部静默吞掉。所以换道即解除。
    if (config.channel !== 'clawbot') this.clawbotQuotaSpent = false
    if (this.clawbotQuotaSpent) return false
    if (this.now() - this.phoneLiveAt() < MOBILE_LIVE_FRESH_MS) {
      this.log('info', `notify suppressed: phone page is live (${title})`)
      return false
    }
    const door = this.noticeDoorUrl()
    return notifySend(config, title, body, {
      fetchImpl: this.options.notifyFetchImpl,
      log: (level, message) => this.log(level, message),
      onQuota: () => this.markClawbotQuotaSpent(),
      quotaTail: () => this.clawbotQuotaTail(config),
      doorLine: () => door,
      onSendLost: () => this.rollbackClawbotQuota()
    })
  }

  /**
   * 一个 Host 会话行 → 推送标题里那个「会话名」。
   *
   * 名字在 **`item.projections.values.title`**，不在行顶层 `item.title`：宿主
   * rc.2 的 `session/list` 把标题放在 projection 值里（手机页 `titleFor()` 一直
   * 读的是这个位置，所以手机上看得到名字），而 0.4.10–0.4.30 的推送读的是
   * `item.title`——那个字段根本不存在，于是每条推送的标题都退化成字面量「会话」。
   * 这就是用户 2026-10-11「推送的会话没有名称，我看不到」的根因。
   *
   * 取不到就明说「会话」，**不许**把 sessionId 印到标题上冒充名字（用户 2026-10-11
   * 01:20 裁：「标题退化我看到了，这个是错的。应该是实际名称」）——一串机器 id 在
   * 通知栏里既读不出是谁、也搜不回去，比空着更难用。
   * @param {unknown} item
   * @returns {string}
   */
  sessionTitleOf(item) {
    const values = item?.projections?.values
    const candidates = [
      values?.title,
      values?.sessionTitle,
      values?.['session.title'],
      // 顶层字段仍然认：投影没来（或换了宿主版本）时它是唯一的线索。
      item?.title
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim().slice(0, NOTIFY_TITLE_MAX)
      }
    }
    return '会话'
  }

  /**
   * One notify tick: feed every Host session row through the completion judge
   * ({@link judgeSessionCompletion}) and push a notice for each `fire` it
   * returns (design D3 — a 30s poll, deliberately not the mux, because the
   * notifier's whole scenario is the phone page being closed). A list that
   * cannot be read is skipped silently: a missed notification must never
   * become log noise or a wrong one.
   * @returns {Promise<void>}
   */
  async pollNotifyRunning() {
    if (!this.notifyReady()) {
      this.stopNotifyWatcher()
      return
    }
    let result
    try {
      result = await this.cachedSessionList(false)
    } catch {
      return
    }
    if (!result?.ok) return
    const items = Array.isArray(result.value?.items)
      ? withSessionErrors(this, applyDescendantRunning(result.value.items))
      : []
    // A session parked on a question is not completing — it is waiting for the
    // operator (whose own notice went out the moment the question arrived).
    // Its judge state is carried unchanged so the answer's aftermath is still
    // judged on what happened, not on the pause the question caused.
    const awaiting = new Set(
      [...this.pendingQuestions.values()]
        .map((item) => item.sessionId)
        .filter((sessionId) => typeof sessionId === 'string')
    )
    const now = this.now()
    const states = new Map()
    for (const item of items) {
      if (item === null || typeof item !== 'object' || typeof item.sessionId !== 'string') continue
      // Subagent rows are invisible on the phone (visibleSessions filters them) and
      // their lifecycle is folded into the parent through descendantRunning; judging
      // them separately would push a completion notice for a row the phone never
      // shows (and a second notice for one turn). The question push is event-driven
      // and unaffected.
      if (item.origin === 'subagent') continue
      const sessionId = item.sessionId
      const prev = this.notifyJudgeStates.get(sessionId)
      const sample = {
        running: item.running === true || item.descendantRunning === true,
        activityAt: sessionActivityAt(item)
      }
      if (awaiting.has(sessionId)) {
        // Frozen, not advanced: letting the judge run here could settle the
        // state (quiet keeps accruing during a long wait), and a settled
        // session never notifies again — the answer's completion would be
        // silent. The pre-question state judges the aftermath instead.
        states.set(sessionId, prev ?? judgeSessionCompletion(undefined, sample, now).state)
        continue
      }
      const { state, fire } = judgeSessionCompletion(prev, sample, now)
      states.set(sessionId, state)
      if (fire) {
        // 推送形状（用户 m01400 定）：不喊「DSH Pocket」——通知本来就来自这里，
        // 再自报家门是废话；标题是**会话名**，正文是**原因**。会话名取不到时
        // 只说「会话」，不编一个像真名的占位。
        const sessionLabel = this.sessionTitleOf(item)
        // 出错还是完成，由行上的错误字段当场说（同一行、零新机制；判据与手机角标
        // 同源，见 sessionRowHasError）。错误详情刻意不出行——任意长文一行装不下，
        // 也不保证不带敏感串（D6）；出来的只是「出错了」这个事实。
        const verdict = sessionRowHasError(item) ? '出错了' : '已完成'
        // 判到一次 settle 就当场推一条（0.4.31 用户定：「有消息就推……没推到的就没推到」）。
        // 0.4.12–0.4.30 这里是把完成的通知塞进邮包等班次，理由是「一条入站只换 10 条额度，
        // 一批会话同时交活会把额度烧穿」——用户判定那套概念太复杂，整体砍掉。
        const delivered = await this.sendNotice(sessionLabel, verdict)
        if (!delivered) this.log('warn', `notify dropped: ${sessionLabel} ${verdict}`)
      }
    }
    this.notifyJudgeStates = states
    // Settled rows prune their storm bookkeeping; suspects get probed. Runs
    // after the state map is committed so the probe reads THIS tick's verdicts.
    await this.probeRetryStorms(items, states, now)
  }

  /**
   * The retry-storm half of a notify tick (2026-10-12): a session whose busy
   * run has outlived {@link RETRY_STORM_THRESHOLDS}suspectAfterMs gets its
   * record tail read (one `session/page` per {@link RETRY_STORM_THRESHOLDS}
   * probeEveryMs), and `failMin` failed compactions / model retries inside
   * `windowMs` push 卡在重试 once, then go quiet for cooldownMs. The whole
   * design point is thrift: a storm emits hundreds of failures an hour and the
   * WeChat pool is ten messages per inbound, so the push must fire once per
   * storm — never at the storm's own cadence.
   *
   * Settled sessions drop their entry here, so the next storm starts fresh;
   * the cooldown is what turns a 4-hour storm into at most a handful of
   * notices, with the quota gate (clawbotQuotaSpent) as the backstop when
   * several sessions storm one night and no inbound refills the pool.
   * @param {unknown[]} items the tick's session rows
   * @param {Map<string, NotifyCompletionState>} states the judge states just committed
   * @param {number} now epoch ms
   * @returns {Promise<void>}
   */
  async probeRetryStorms(items, states, now) {
    const T = RETRY_STORM_THRESHOLDS
    for (const item of items) {
      if (item === null || typeof item !== 'object' || typeof item.sessionId !== 'string') continue
      if (item.origin === 'subagent') continue
      const sessionId = item.sessionId
      const state = states.get(sessionId)
      if (state?.active !== true) {
        // Settled (or gone): the storm bookkeeping has nothing to say about a
        // session that is not running.
        this.retryStorms.delete(sessionId)
        continue
      }
      if (state.busySince === undefined || now - state.busySince < T.suspectAfterMs) continue
      let entry = this.retryStorms.get(sessionId)
      if (entry === undefined) {
        entry = { nextProbeAt: 0, coolingUntil: 0 }
        this.retryStorms.set(sessionId, entry)
      }
      if (now < entry.coolingUntil || now < entry.nextProbeAt) continue
      entry.nextProbeAt = now + T.probeEveryMs
      const failures = await this.probeSessionRetryFailures(item, now)
      // A failed read must never become a false all-clear NOR a false alarm:
      // skip the round, the next probe re-reads.
      if (failures < 0) continue
      if (failures < T.failMin) continue
      entry.coolingUntil = now + T.cooldownMs
      const sessionLabel = this.sessionTitleOf(item)
      // 形状同其它推送：状态在前的一行文本（notify.js clawbot 分支拼装）。
      const delivered = await this.sendNotice(sessionLabel, `卡在重试（${failures} 次）`)
      this.log(
        delivered ? 'info' : 'warn',
        `notify ${delivered ? 'sent' : 'dropped'}: ${sessionLabel} 卡在重试 ${failures} failures in ${String(Math.round(T.windowMs / 1000))}s`
      )
    }
  }

  /**
   * Read one session's newest records and count storm failures in the window.
   *
   * The probe is the boot-history RPC with the smallest legal window:
   * `maxMessages: 1` walks back to the newest message-producing event, and the
   * page comes back as a CONTIGUOUS event slice — compaction/retry records
   * don't count toward maxMessages but ride along inside the range (verified
   * against the host bundle 2026-10-12: paginate() slices, it doesn't filter).
   * A storm that runs after the turn's last message therefore arrives whole.
   * `throughSeq` is required by the host; the row's `projections.asOfSeq` —
   * the same list read this tick judged — pins it. Any failure (row without a
   * usable seq, host refusal, stale seq past the durable log) answers -1 and
   * the caller just skips the round.
   * @param {{ sessionId: string, projections?: unknown }} item
   * @param {number} now epoch ms
   * @returns {Promise<number>} failure count, or -1 when this round could not read
   */
  async probeSessionRetryFailures(item, now) {
    const throughSeq = Number(item.projections?.asOfSeq)
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) return -1
    let page
    try {
      page = await this.invokeHarness('session/page', {
        request: {
          address: { kind: 'session', sessionId: item.sessionId },
          throughSeq,
          maxMessages: 1
        }
      })
    } catch {
      return -1
    }
    if (!page?.ok || !Array.isArray(page.value?.records)) return -1
    return countRetryFailures(page.value.records, now, RETRY_STORM_THRESHOLDS.windowMs)
  }

  /**
   * Push "AI is waiting for your approval" the moment a question arrives.
   *
   * Fired from {@link rememberPendingQuestion} — the exact arrival point of a
   * pending question, so the notice does not wait for the next poll tick. The
   * same question pushes once, ever: the Host's event id is remembered in a
   * bounded table, so a reconnect replay of the same event stays silent. With
   * no channel configured this is a silent no-op before any state is touched
   * and before any log line — an unconfigured user must see nothing at all.
   * @param {string} eventId
   * @param {{ rpcId: string, sessionId: string, questions: unknown[] }} pending
   * @returns {void}
   */
  pushPendingQuestionNotice(eventId, pending) {
    if (!this.notifyReady()) return
    if (this.notifiedQuestionKeys.has(eventId)) return
    this.notifiedQuestionKeys.add(eventId)
    while (this.notifiedQuestionKeys.size > NOTIFY_QUESTION_KEYS_MAX) {
      const oldest = this.notifiedQuestionKeys.values().next().value
      if (oldest === undefined) break
      this.notifiedQuestionKeys.delete(oldest)
    }
    void (async () => {
      // The session title is the human-readable identifier. Best effort only —
      // a failed list read must not eat the push.
      const pickTitle = (list) => {
        if (!list?.ok) return ''
        const items = Array.isArray(list.value?.items) ? list.value.items : []
        const item = items.find((entry) =>
          entry !== null && typeof entry === 'object' && entry.sessionId === pending.sessionId
        )
        return item === undefined ? '' : this.sessionTitleOf(item)
      }
      let label = ''
      try {
        label = pickTitle(await this.cachedSessionList(false))
        // 列表里没有这一行（刚开的会话）时 label 会是兜底的「会话」而不是空串，
        // 所以这里判的是「还没拿到真名字」——真名字才值得再花一次列表 RPC。
        if (label === '会话') {
          // 缓存里没有这个名字就**强刷一次**再放弃（同一个先例见 sessionThroughCursor
          // 的 `cachedSessionList(true)`）。标题是这条推送唯一进通知栏第一行的字段，
          // 值钱的程度比一次列表 RPC 高得多。
          const refreshed = pickTitle(await this.cachedSessionList(true))
          if (refreshed !== '会话') label = refreshed
        }
      } catch {
        // garnish, not the meal
      }
      // 取不到名字就明说「会话」，**不许**把 sessionId 印到推送标题上冒充名字
      // （用户 2026-10-11 01:20 裁：「标题退化我看到了，这个是错的。应该是实际名称」）。
      // 一串机器 id 在通知栏里既读不出是谁、也搜不回去，比空着更难用；完成通知那一侧
      // 早就写着同样的口径（`sessionTitleOf()` 的兜底，「不编一个像真名的占位」）。
      const ident = label.slice(0, NOTIFY_TITLE_MAX)
      // 到了就投，投不出去就丢（0.4.31）：0.4.12–0.4.30 那条「这一轮没额度就留在手里，
      // 下一次入站第一件补投」的挂号信车道随邮包一起作废——用户定「没推到的就没推到」。
      // 文案 0.4.33 起用「待回答」（用户 2026-10-12 定）：微信横幅只显示一行，状态词
      // 短两个字，会话名就能多露两个字；与手机角标同词，两边一个口径。
      const delivered = await this.sendNotice(ident, '待回答')
      if (!delivered) this.log('warn', `notify dropped: ${ident} 待回答`)
    })().catch(() => {
      // notifySend already logs its own failures without the key; this guard
      // only keeps our own bookkeeping from ever surfacing as an unhandled
      // rejection.
    })
  }

  // -- Pairing desktop confirmation (design #4a) ----------------------------

  /** Drop pending pairings past their TTL. Invoked with the session sweep. */
  sweepPendingPairings() {
    const now = this.now()
    for (const [id, entry] of this.pendingPairings) {
      if (entry.expiresAt <= now) this.pendingPairings.delete(id)
    }
  }

  /**
   * The desktop-facing view: still-pending entries only, so an approve/deny
   * click makes the card disappear on the very next poll even before the
   * phone consumes the verdict.
   * @returns {{ id: string, label: string, remoteAddress: string, expiresAt: number }[]}
   */
  pendingPairingsView() {
    this.sweepPendingPairings()
    return [...this.pendingPairings.values()]
      .filter((entry) => entry.status === 'pending')
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        remoteAddress: entry.remoteAddress,
        expiresAt: entry.expiresAt
      }))
  }

  /**
   * The `/pair/pending` light limiter: five polls a second per IP (design #4a).
   * The poll carries no credential beyond a confirmId, so a probing client is
   * throttled before it can enumerate the id space at connection speed.
   * @param {string} remoteAddress
   * @returns {boolean} true when this poll must be refused
   */
  pendingPollLimited(remoteAddress) {
    const now = this.now()
    const entry = this.pendingPollCounts.get(remoteAddress)
    if (entry === undefined || now - entry.windowStart >= 1000) {
      this.pendingPollCounts.delete(remoteAddress)
      this.pendingPollCounts.set(remoteAddress, { windowStart: now, count: 1 })
      while (this.pendingPollCounts.size > PIN_FAIL_KEYS_MAX) {
        const oldest = this.pendingPollCounts.keys().next().value
        if (oldest === undefined) break
        this.pendingPollCounts.delete(oldest)
      }
      return false
    }
    entry.count += 1
    return entry.count > 5
  }

  // -- Public-access consent (design #3c) -----------------------------------

  /** @param {import('node:http').IncomingMessage} request */
  consentCookiePresent(request) {
    return this.cookieValue(request, CONSENT_COOKIE) === '1'
  }

  /**
   * The tunnel-side consent gate. Answers `true` when it HAS responded (a 303
   * to `/consent?next=…` was written and the caller must stop), `false` when
   * the request may proceed. LAN/loopback is untouched by construction: the
   * gate only fires in tunnel mode. The placement is immediately before the
   * `authorized()` pipeline — the pairing funnel (`/pair`, `/pair/verify`,
   * `/reconnect`) stays above it, so pairing itself never needs the cookie;
   * the disclaimer is answered once, on first entry into the app.
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {MobileConnectionMode} connectionMode
   * @param {URL} url
   * @returns {boolean}
   */
  handleConsentGate(request, response, connectionMode, url) {
    if (connectionMode !== 'tunnel') return false
    // The consent surface must be reachable from behind the gate itself, or
    // the gate would lock its own door.
    if (url.pathname === '/consent' || url.pathname === '/consent/accept') return false
    if (this.consentCookiePresent(request)) return false
    // A paired device that already accepted the disclaimer keeps that answer in
    // its registry profile — the cookie is origin-bound, so a tunnel hostname
    // rotation used to re-ask a question the device had already answered.
    if (this.devicePublicConsented(request)) return false
    response.statusCode = 303
    response.setHeader(
      'location',
      `/consent?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`
    )
    response.end()
    return true
  }

  // -- Device registry (change 2026-10-07-feat-pocket-device-registry) -------

  /**
   * The live session behind the request's own cookie, if any. Unlike
   * `authorized()` this is cookie-only by construction: both consumers (the
   * consent gate and the permission gate) only ever fire in tunnel mode, where
   * the cookie is the only credential there is.
   * @param {import('node:http').IncomingMessage} request
   * @returns {MobileSession | undefined}
   */
  liveMobileSession(request) {
    const token = this.mobileToken(request)
    if (!token) return undefined
    const session = this.sessions.get(token)
    if (session === undefined) return undefined
    if (session.expiresAt !== undefined && session.expiresAt <= this.now()) return undefined
    return session
  }

  /**
   * Has THIS device already accepted the public-access disclaimer? Read from
   * the registry profile, not the cookie: the profile survives every hostname
   * rotation, which is the entire point of moving the answer there.
   * @param {import('node:http').IncomingMessage} request
   * @returns {boolean}
   */
  /**
   * 诊断模式是否开着。读设置档的 `diagnostics.probe`（与 notify/tunnel 同一份文件，
   * 不新增第二份存储）。**默认关**：开着时手机每滑动 1.5 s 就往宿主日志回传一批滚动时序。
   * @returns {boolean}
   */
  diagnosticsProbeEnabled() {
    const doc = this.options.settingsStore?.load?.()
    return doc?.diagnostics?.probe === true
  }

  /** The desktop-facing view of the diagnostics setting (0.4.27 panel switch). */
  diagnosticsView() {
    return { probe: this.diagnosticsProbeEnabled() }
  }

  devicePublicConsented(request) {
    // 0.4.23：原来只认「活会话上的指纹」，可这个档案要服务的场景恰恰是**没有会话**的时候 ——
    // 隧道每次重启换随机域名，cookie 按 origin 存必然不在，于是这条记录既写不进也读不到
    // （实测两台设备的 publicConsentedAt 都是空，用户在微信里卡在须知页反复打转）。
    // 档案的 fingerprint 本来就是 `sha256(userAgent)` 前 10 位，没有会话也能从 UA 算出来，
    // 所以读写两头统一到同一口径：有会话用会话的，没有就从 UA 算。
    // **这不是放宽授权**：能不能进来的门（配对、渠道权限）在本函数之前就已经查过，
    // 这里只决定「免责须知还要不要问第二遍」。
    const fingerprint = this.liveMobileSession(request)?.fingerprint
      || deviceFingerprint(request.headers['user-agent'])
    const profile = this.deviceProfileMatch(fingerprint, request.headers['user-agent'])
    return typeof profile?.publicConsentedAt === 'number'
  }

  /**
   * The registry entry for a fingerprint, if it is still inside its credential
   * lifetime. An expired profile is removed on sight — a device returning
   * after its credential lapsed pairs as a new device (full funnel), which is
   * what the expiry means.
   * @param {string | undefined} fingerprint
   * @returns {DeviceProfile | undefined}
   */
  deviceProfileMatch(fingerprint, userAgent = undefined) {
    if (!fingerprint) return undefined
    const profile = this.devices.get(fingerprint)
    if (profile !== undefined) {
      if (typeof profile.expiresAt === 'number' && profile.expiresAt <= this.now()) {
        this.devices.delete(fingerprint)
        return undefined
      }
      return profile
    }
    // Backward compatibility: match any active legacy profile from the same canonical hardware/browser
    // so existing paired devices upgrade smoothly without forcing desktop re-confirmation.
    const incomingCanonical = typeof userAgent === 'string' ? canonicalDeviceAgent(userAgent) : ''
    for (const [id, legacy] of this.devices) {
      if (typeof legacy.expiresAt === 'number' && legacy.expiresAt <= this.now()) continue
      if (legacy.label && typeof legacy.label === 'string') {
        const legacyCanonical = canonicalDeviceAgent(legacy.label)
        const legacyFp = deviceFingerprint(legacy.label)
        const matched = legacyFp === fingerprint || (incomingCanonical && isCompatibleLegacyProfile(legacy.label, incomingCanonical))
        if (matched) {
          this.devices.delete(id)
          legacy.fingerprint = fingerprint
          legacy.label = incomingCanonical ? incomingCanonical.slice(0, 40) : legacyCanonical.slice(0, 40)
          this.devices.set(fingerprint, legacy)
          this.scheduleSessionPersist()
          return legacy
        }
      }
    }
    return undefined
  }

  /**
   * Create or refresh one device's profile. Creation happens at the moment a
   * session is minted for a device the registry does not know; the first
   * channel it arrived over decides its permission (user ruling: LAN first
   * contact → local only, tunnel first contact → local + public). A refresh
   * moves the sighting only — the credential deadline is ABSOLUTE (it belongs
   * to the device, not to this pairing), and only a genuinely lapsed profile
   * starts a new lifetime here. `firstPairedAt`, `permission` and
   * `publicConsentedAt` are kept; they belong to the device.
   * @param {string} fingerprint
   * @param {{ label?: string, permission?: 'lan' | 'lan+wan' }} known
   * @returns {DeviceProfile}
   */
  deviceProfileUpsert(fingerprint, { label, permission } = {}) {
    const now = this.now()
    const existing = this.devices.get(fingerprint)
    if (existing !== undefined) {
      // 绝对到期（用户 2026-10-11 01:20 裁：「cookie 就应该是绝对时间，怎么能每次刷新呢」）。
      // 重新配对/隧道恢复**不延长**凭证寿命：原来这里无脑写 now+TTL，注册表里的档案因此
      // 永远不会老，deviceProfileMatch 永远命中，/pair/verify 就永远走「免桌面确认直接发
      // cookie」那条分支——30 天变成「多久摸一次 PIN」的闹钟，而 PIN 本身不过期。
      // 只有两条路能把到期线推后：档案**确实已经过期**（按新设备重新起算，见下）、
      // 或桌面「延期」按钮（人工动作，另路）。
      if (typeof existing.expiresAt !== 'number' || !Number.isFinite(existing.expiresAt) || existing.expiresAt <= now) {
        existing.expiresAt = now + MOBILE_COOKIE_TTL_MS
      }
      existing.lastSeenAt = now
      if (label !== undefined) existing.label = label
      return existing
    }
    /** @type {DeviceProfile} */
    const profile = {
      fingerprint,
      ...(label !== undefined ? { label } : {}),
      firstPairedAt: now,
      expiresAt: now + MOBILE_COOKIE_TTL_MS,
      lastSeenAt: now,
      permission: permission === 'lan+wan' ? 'lan+wan' : 'lan',
    }
    // Same bound as every device map: the registry is capped, and the eviction
    // is FIFO by pairing order (the cap is a safety valve for a hand-forced
    // file, not a working set — DEVICE_MAP_CAP devices is far past real use).
    this.capDeviceMap(this.devices, fingerprint)
    this.devices.set(fingerprint, profile)
    return profile
  }

  // --------------------------------------------------------- the read ledger
  // The phone-side half of the landing rule (0.4.33): each device uploads its
  // 「which sessions have I opened, and when」 map, the bridge keeps one ledger
  // per fingerprint, and `sess.attention` is computed over the REQUESTING
  // device's copy. The document's initialChat decision therefore honours
  // 推进完了但消息还没有读 at the first byte, instead of embedding a chat the
  // page has to walk back out of when its own count disagrees (the 2026-10-12
  // report that started this). An unsynced device degrades to 「never opened
  // recently」, which errs toward parking on the workspace page — the safe side.

  openedAtDocument() {
    if (this._openedAtDoc === undefined) {
      this._openedAtDoc = this.openedAtStore?.load() ?? { version: 1, savedAt: 0, devices: {} }
    }
    return this._openedAtDoc
  }

  openedAtLedgerFor(request) {
    const fingerprint = this.liveMobileSession(request)?.fingerprint
    if (!fingerprint) return {}
    return this.openedAtDocument().devices[fingerprint] ?? {}
  }

  noteOpenedAtLedger(fingerprint, ledger) {
    const openedAtDoc = this.openedAtDocument()
    openedAtDoc.devices[fingerprint] = ledger
    openedAtDoc.savedAt = this.now()
    if (this.openedAtPersistTimer !== undefined) return
    this.openedAtPersistTimer = setTimeout(() => {
      this.openedAtPersistTimer = undefined
      this.flushOpenedAtPersist()
    }, OPENED_AT_PERSIST_DEBOUNCE_MS)
  }

  /** Same contract as flushSessionPersist: flush, and let stop() disarm after. */
  flushOpenedAtPersist() {
    if (this.openedAtPersistTimer !== undefined) {
      clearTimeout(this.openedAtPersistTimer)
      this.openedAtPersistTimer = undefined
    }
    if (this.openedAtStore === undefined) return
    this.openedAtStore.save(this.openedAtDocument())
  }

  /**
   * The desktop management surface's view of the registry — one row per
   * device profile, most recently seen first. Rows carry the profile handle
   * (`id` = the registry key) the three device actions revoke/extend/re-grant
   * by. The fingerprint is the row's identity by design (the management page
   * displays it); it never reaches the log.
   * @returns {Array<{ id: string, label: string, fingerprint: string, firstPairedAt: number, expiresAt: number, lastSeenAt: number, permission: 'lan' | 'lan+wan', consented: boolean, online: boolean }>}
   */
  pairedDevicesView() {
    return [...this.devices.values()]
      .sort((left, right) => (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0))
      .map((profile) => ({
        id: profile.fingerprint,
        label: profile.label ?? 'Phone',
        fingerprint: profile.fingerprint,
        firstPairedAt: profile.firstPairedAt ?? 0,
        expiresAt: profile.expiresAt ?? 0,
        lastSeenAt: profile.lastSeenAt ?? 0,
        permission: profile.permission === 'lan+wan' ? 'lan+wan' : 'lan',
        consented: typeof profile.publicConsentedAt === 'number',
        online: [...this.sessions.values()].some((session) => session.fingerprint === profile.fingerprint),
      }))
  }

  /**
   * Extend one device's credential to a full TTL from now — the desktop's
   * "延长" action. Both the profile and every live/parked session of the
   * device move together: extending only one half would either log the phone
   * out anyway (session) or keep the profile on a dead credential (registry).
   * @param {string} fingerprint
   * @returns {boolean} false when no such profile exists
   */
  extendDeviceProfile(fingerprint) {
    const profile = this.devices.get(fingerprint)
    if (profile === undefined) return false
    const expiresAt = this.now() + MOBILE_COOKIE_TTL_MS
    profile.expiresAt = expiresAt
    profile.lastSeenAt = this.now()
    for (const map of [this.sessions, this.suspendedSessions, this.resumableSessions]) {
      for (const session of map.values()) {
        if (session.fingerprint === fingerprint) session.expiresAt = expiresAt
      }
    }
    this.scheduleSessionPersist()
    return true
  }

  /**
   * Re-grant (or revoke) one device's public access. Takes effect on the very
   * next request: the enforcement point reads the live profile, not a stamp
   * copied onto the session at pairing time.
   * @param {string} fingerprint
   * @param {'lan' | 'lan+wan'} permission
   * @returns {boolean} false when no such profile exists
   */
  setDevicePermission(fingerprint, permission) {
    const profile = this.devices.get(fingerprint)
    if (profile === undefined) return false
    profile.permission = permission === 'lan+wan' ? 'lan+wan' : 'lan'
    this.scheduleSessionPersist()
    return true
  }

  /**
   * Retire every parked or live session of one fingerprint — the PIN-restore
   * path's counterpart of the LAN "stale session retired" rule. The registry
   * match is the ruling that this fingerprint IS one device, so a restore
   * replaces its previous entries instead of stacking a phantom per restart.
   * The presented token (when the phone still holds a live cookie) survives so
   * the plain re-submission keeps the token it already has.
   * @param {string} fingerprint
   * @param {string | undefined} keepToken
   * @returns {void}
   */
  retireSessionsOfFingerprint(fingerprint, keepToken) {
    if (!fingerprint) return
    for (const map of [this.sessions, this.suspendedSessions, this.resumableSessions]) {
      for (const [token, session] of [...map]) {
        if (token === keepToken) continue
        if (session.fingerprint === fingerprint) {
          this.kickDeviceStreams(token)
          map.delete(token)
        }
      }
    }
  }

  /**
   * Destroy the live streaming responses of one session token — the kick that
   * makes a revoke immediate. The phone's EventSource sees the socket die and
   * its next reconnect is answered 401: the credential is gone.
   * @param {string} token
   * @returns {void}
   */
  kickDeviceStreams(token) {
    const open = this.deviceStreams.get(token)
    if (open === undefined) return
    this.deviceStreams.delete(token)
    for (const response of open) {
      try {
        response.destroy()
      } catch {
        // A response that is already gone has nothing left to destroy.
      }
    }
  }

  /**
   * Attribute one long-lived response to the device that opened it, so a
   * revoke can end it the same moment it ends the credential. Registration
   * sits in the SSE wrapper (bridge side); the poll fallback is a plain
   * request/response and never tracked. Self-cleaning: the response's own
   * close event removes the entry, whatever end the stream met.
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @returns {void}
   */
  trackDeviceStream(request, response) {
    const token = this.mobileToken(request)
    if (!token) return
    let open = this.deviceStreams.get(token)
    if (open === undefined) {
      open = new Set()
      this.deviceStreams.set(token, open)
    }
    open.add(response)
    response.on('close', () => {
      const current = this.deviceStreams.get(token)
      if (current === undefined) return
      current.delete(response)
      if (current.size === 0) this.deviceStreams.delete(token)
    })
  }

  /**
   * The channel-permission enforcement point. Sits immediately after the
   * `authorized()` pipeline (spec: enforcement happens after authentication)
   * and only ever answers in tunnel mode — a 'lan' device on its home network
   * is exactly where its grant ends, and a 'lan+wan' device is welcome on both
   * channels by the same ruling (public access granted implies local access).
   *
   * A device with no profile is not restricted: that is the pre-registry
   * shape, and the restore migration exists precisely so real devices never
   * wear it.
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {MobileConnectionMode} connectionMode
   * @returns {boolean} true when the request was refused (403 written)
   */
  devicePermissionBlocked(request, response, connectionMode) {
    if (connectionMode !== 'tunnel') return false
    const session = this.liveMobileSession(request)
    const fingerprint = session?.fingerprint
    if (!fingerprint) return false
    const profile = this.devices.get(fingerprint)
    if (profile?.permission !== 'lan') return false
    const zh = this.locale() === 'zh'
    this.text(response, 403, zh
      ? '此设备未获公网权限，请在桌面端设备管理中开启。'
      : 'This device does not have public access. Enable it in the device list on the desktop.')
    return true
  }

  /** @returns {string | undefined} */
  createDesktopUrl() {
    if (!this.server || !this.port) return undefined
    this.desktopBootstrapToken = randomBytes(32).toString('base64url')
    this.desktopBootstrapExpiresAt = this.now() + DESKTOP_BOOTSTRAP_TTL_MS
    return `http://127.0.0.1:${this.port}/desktop?k=${this.desktopBootstrapToken}`
  }

  /** @returns {Promise<LanMobileBridgeSnapshot>} */
  async start() {
    if (this.server) {
      if (!this.pairingTokenValid()) {
        this.rotatePairingToken()
      }
      this.syncConnected()
      return this.snapshot()
    }
    this.rotatePairingToken()
    // Restore the durable session maps before anything observes the maps: a
    // paired phone's cookie must keep working across a host restart.
    this.restorePersistedSessions()
    this.server = this.createBridgeServer()
    // Port precedence: explicit env override, then the caller's option, then
    // the product default. `0` from the caller means "OS-assigned ephemeral
    // port" and must survive (tests rely on it); only an unset option falls
    // back to 43127.
    const envPort = Number(process.env.DSH_MOBILE_PORT)
    const preferredPort =
      Number.isInteger(envPort) && envPort > 0 ? envPort : (this.options.port ?? 43127)
    let chosenPort = preferredPort
    // Small retry loop: EADDRINUSE on 43127/43128 retries once on port+1.
    for (let attempt = 0; ; attempt += 1) {
      const server = this.server
      try {
        // `stop()` may have landed during the previous attempt: it captured and
        // closed that server and cleared `this.server`, so retrying here would
        // create a listener nobody owns. Settle instead of building one.
        if (!server) throw new Error('bridge was stopped before the listener came up')
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          // A `close()` that lands before the listen callback emits no `error`
          // at all — a promise watching only error/listening stays PENDING for
          // ever (probe-close-before-listen-callback). The close event is the
          // only signal that this listener will never come up, and without it a
          // `stop()` during startup left `start()` unresolved, so every caller
          // awaiting it — the plugin's dispose path included — hung on it.
          const onClose = () => reject(new Error('bridge was stopped before the listener came up'))
          server.once('close', onClose)
          server.listen(chosenPort, '0.0.0.0', () => {
            server.off('close', onClose)
            resolve()
          })
        })
        break
      } catch (error) {
        const retryable =
          error instanceof Error &&
          'code' in error &&
          error.code === 'EADDRINUSE' &&
          (chosenPort === 43127 || chosenPort === 43128) &&
          attempt === 0
        if (!retryable) {
          // Say WHICH port and WHY: the step to the next port only covers a
          // first-attempt collision on 43127/43128, so a `DSH_MOBILE_PORT` or an
          // explicit option that clashes just fails. Without these two fields the
          // desktop surface can only ever answer "Pocket bridge is not ready."
          // (B2-R8); with them it can name the port and the errno.
          if (error !== null && typeof error === 'object') {
            error.listenPort = chosenPort
            error.listenErrno = typeof error.code === 'string' ? error.code : undefined
          }
          throw error
        }
        // A server whose listen failed is replaced so the retry keeps the same
        // createServer -> listen structure as the first attempt.
        this.server = this.createBridgeServer()
        chosenPort += 1
      }
    }
    // Optional: `stop()` can clear `this.server` in the microtask between the
    // listen callback and this line, and reading `.address()` off undefined used
    // to turn a clean shutdown into a `Cannot read properties of undefined`.
    // Refusing to finish is the honest answer: a `start()` that raced a `stop()`
    // must not resolve with a port for a listener that is already gone.
    if (!this.server) throw new Error('bridge was stopped before the listener came up')
    const address = this.server.address()
    this.port = address && typeof address === 'object' ? address.port : chosenPort
    this.iconDataUri = await buildIconDataUri(this.options.appIconPath)
    // Same pixels, encoded the way an <img src> wants them: the app document names
    // `/app-icon?ui=1` instead of inlining this three times per cold open.
    this.iconUiBytes = await buildIconBytes(this.options.appIconPath)
    // A notify channel already enabled in the settings file resumes with the
    // bridge; a disabled one must not survive a stop/restart cycle either.
    this.syncNotifyWatcher()
    this.syncClawbotWatcher()
    this.syncConnected()
    return this.snapshot()
  }

  /**
   * @returns {import('node:http').Server}
   */
  createBridgeServer() {
    return createServer((request, response) => {
      void this.handle(request, response)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          this.log('error', `request ${request.method ?? '?'} ${request.url ?? '?'} failed: ${message}`)
          // Details stay in the server log only — the response body stays
          // generic so internal error text never reaches the phone.
          //
          // But if the handler already started the response there is no status
          // line left to write: the SSE paths flush headers before they can
          // still throw (a missing constant in the stream code did exactly this
          // in development), and `res.writeHead(500)` on a started response
          // throws a second, unrelated error while the phone sits on an empty
          // 200. End it instead — a closed stream is at least something the
          // phone's EventSource can see and reconnect from.
          if (response.headersSent) {
            if (!response.writableEnded) response.end()
            return
          }
          this.json(response, 500, { ok: false, error: 'Internal server error.' })
        })
        // Every session change is the result of a request: pairing approval,
        // reconnect, or disconnect. Reconciling here keeps the mux monitor and
        // the renderers in step without polling either of them.
        .finally(() => this.syncConnected())
    })
  }

  /** @returns {Promise<void>} */
  async stop() {
    const server = this.server
    this.server = undefined
    this.port = undefined
    this.pairingToken = undefined
    this.pairingExpiresAt = undefined
    this.desktopBootstrapToken = undefined
    this.desktopBootstrapExpiresAt = undefined
    // Wait for an in-flight launch so the tunnel it spawns is stopped below
    // instead of outliving the bridge (and the app).
    if (this.tunnelLaunch) {
      await this.tunnelLaunch.catch(() => undefined)
      this.tunnelLaunch = undefined
    }
    await this.stopCurrentTunnel()
    this.tunnelActive = false
    this.tunnelLoading = false
    this.tunnelError = undefined
    // Persist BEFORE the in-memory teardown, then disarm the persist path: the
    // clears below run syncConnected(), which would otherwise re-arm the
    // debounce and overwrite the good file with empty maps half a second later.
    // Stop is a restart boundary, not a logout — the disk keeps the pairings.
    // `force` because the maps are about to be cleared: the state on disk right
    // now is the one that has to survive, whether or not the stamp matches it.
    this.flushSessionPersist({ force: true })
    this.flushOpenedAtPersist()
    this.sessionStore = undefined
    this.openedAtStore = undefined
    this.sessions.clear()
    this.suspendedSessions.clear()
    this.resumableSessions.clear()
    this.pendingQuestions.clear()
    this.ephemeralPin = undefined
    this.ephemeralPinExpiresAt = undefined
    this.clearPinFailures()
    // The notify poll and the pairing-confirm table are bridge-lifetime state:
    // neither survives a stop, and a leftover timer would keep polling a Host
    // nobody is paired to.
    this.stopNotifyWatcher()
    this.stopClawbotWatcher()
    this.notifyConfig = {
      channel: 'off',
      key: '',
      enabled: false,
      clawbot: { botToken: '', userId: '', contextToken: '' }
    }
    this.notifyJudgeStates.clear()
    this.notifiedQuestionKeys.clear()
    this.pendingPairings.clear()
    this.pendingPollCounts.clear()
    this.clearTunnelDeathFlags()
    this.tunnelExpiresAt = undefined
    for (const abort of this.sessionStreamAborts) abort.abort()
    this.sessionStreamAborts.clear()
    // The per-device stream index dies with the sockets it points at.
    this.deviceStreams.clear()
    // The poll collectors are streams too: every follow they hold and every
    // retry they scheduled dies with the bridge. Their buffers are not state
    // worth carrying across a restart — a poller re-syncs on the new
    // generation the fresh collector hands out.
    for (const collector of this.sessionEventCollectors.values()) collector.stop()
    this.sessionEventCollectors.clear()
    // A held poll is a phone waiting on us. Releasing here covers the holder
    // whose collector was already evicted (a live collector wakes its own
    // waiters from stop() above); either way no request outlives the bridge.
    for (const release of [...this.eventHolds]) release()
    this.eventHolds.clear()
    // The known-path sets authorize local-file reads; they are observations of
    // the event streams that died above, not state a restarted bridge inherits.
    // The phone re-collects them from history on its next open.
    this.sessionKnownPaths?.clear()
    // Reconnecting state is worth as much as the streams themselves: a restart
    // must not inherit "this conversation failed twice, wait 2s" from the life of
    // the previous bridge.
    this.streamBackoff.clear()
    // The history cursors are observations of the Host's projection, not state
    // worth carrying across a restart of the bridge.
    this._sessionCursors = undefined
    this._agentPresetsCache = undefined
    // The other lazy fields survive a stop on purpose: muxMonitor is constructed
    // once and re-armed in place, _mobileAssets is a permanent cache of the
    // content-hashed static shell, and the rest are TTL-bounded, throttle maps,
    // or rebuilt by start().
    this.muxConnected = false
    this.hostProbe = undefined
    this.syncConnected()
    this.muxAbort?.abort()
    const muxTask = this.muxTask
    this.muxAbort = undefined
    this.muxTask = undefined
    if (muxTask) await muxTask.catch(() => undefined)
    if (!server) return
    // An in-flight mobile RPC can hold its socket for up to the 30s abort
    // timeout; close() alone waits for active connections to drain, which
    // would stall app shutdown. Drop every live socket explicitly.
    server.closeAllConnections()
    await new Promise((resolve) => server.close(() => resolve()))
  }

  /**
   * @param {boolean} [enable]
   * @returns {Promise<LanMobileBridgeSnapshot>}
   */
  async toggleTunnel(enable) {
    const targetState = enable !== undefined ? enable : !this.tunnelActive
    // A connected phone never blocks a mode switch. The guard used to be
    // `sessions.size > 0`, which in tunnel mode counted every handset sharing
    // one carrier egress address, so the desktop could not turn its own tunnel
    // off without disconnecting someone else's phone first.
    if (!targetState) {
      // Wait for an in-flight launch, then stop the tunnel it spawned:
      // otherwise the just-launched process is orphaned (or silently revives
      // the tunnel the user asked to disable).
      if (this.tunnelLaunch) {
        await this.tunnelLaunch.catch(() => undefined)
        this.tunnelLaunch = undefined
      }
      await this.stopCurrentTunnel()
      this.tunnelActive = false
      this.tunnelLoading = false
      this.tunnelError = undefined
      this.clearTunnelDeathFlags()
      this.tunnelExpiresAt = undefined
      return this.snapshot()
    }

    if (this.tunnelActive && this.tunnelInstance?.url) {
      return this.snapshot()
    }

    // A launch is already in flight (the cloudflared download alone can take
    // seconds): report the loading state instead of racing a second tunnel,
    // which would orphan the first cloudflared process.
    if (this.tunnelLaunch) {
      return this.snapshot()
    }

    this.tunnelLoading = true
    this.tunnelError = undefined
    const launch = this.launchTunnel()
    this.tunnelLaunch = launch
    try {
      await launch
      this.tunnelActive = true
      this.clearTunnelDeathFlags()
      this.armTunnelProcess(this.tunnelInstance)
      // A new tunnel URL is a new audience: whoever learned the previous
      // internet-facing link must not keep a password that still works on it.
      // The durable password the user opted into is deliberately untouched —
      // it outlives every tunnel (design §12 禁令 3), and rotating it would
      // break the promise the desktop panel makes about it.
      this.rotateEphemeralPinForTunnel()
    } catch (error) {
      this.tunnelActive = false
      this.tunnelError = error instanceof Error ? error.message : String(error)
      this.log('error', `tunnel launch failed: ${this.tunnelError}`)
    } finally {
      this.tunnelLoading = false
      if (this.tunnelLaunch === launch) this.tunnelLaunch = undefined
    }
    return this.snapshot()
  }

  /** @returns {Promise<void>} */
  async launchTunnel() {
    const port = this.port
    if (!port) throw new Error('Bridge is not running.')
    // Seam: Pinggy SSH fallback re-added in a later change (pinggy-tunnel.ts source available).
    this.tunnelInstance = await this.startCloudflareInstance(port)
    // The carrier is up, so the phone's first round trip should not also be the
    // bridge's first read of the session catalogue.
    this.prewarmMobileBoot('tunnel-up')
  }

  /**
   * @param {number} port
   * @returns {Promise<object>}
   */
  async startCloudflareInstance(port) {
    if (this.options.createCloudflareTunnel) return this.options.createCloudflareTunnel(port)
    // A saved token + hostname switch the carrier to a named tunnel with a
    // fixed name (design #3b); anything less keeps the quick tunnel. Read at
    // launch time so a config save applies to the very next toggle, and
    // re-validated here so a hand-edited settings file degrades to the quick
    // tunnel (with a log line) instead of launching against a broken hostname.
    const tunnel = this.readTunnelConfig()
    if (tunnel.token !== '' && isValidTunnelHostname(tunnel.hostname)) {
      return startCloudflareNamedTunnel({
        port,
        token: tunnel.token,
        hostname: tunnel.hostname.toLowerCase(),
        log: this.options.tunnelLog
      })
    }
    if (tunnel.token !== '' || tunnel.hostname !== '') {
      this.log('warn', 'named tunnel config incomplete or hostname invalid; falling back to a quick tunnel')
    }
    return startCloudflareQuickTunnel({ port, log: this.options.tunnelLog })
  }

  /** @returns {LanMobileBridgeSnapshot} */
  snapshot() {
    this.sweepExpiredSessions()
    if (!this.server || !this.port) {
      return { running: false, connected: this.sessions.size > 0, connectedDevices: this.connectedDevices() }
    }
    // The pairing token is single-use (consumed on approval) and short-lived.
    // Tunnel and listener state must stay visible regardless, otherwise the
    // desktop window loses the connection-mode UI right after a phone pairs.
    const tokenValid = this.pairingTokenValid()
    // 诊断模式（0.4.26 产品能力）：开着时，交给手机的公网入口一律带 ?probe=1 —— 页内埋点
    // 只认「URL 带 probe」或「同源 localStorage 仍在 6 小时期内」，所以每次换隧道域名都
    // 必须从这个链接进去一次才会上报。默认关：开着会持续往 pocket.log 回传滚动时序。
    const probeSuffix = this.diagnosticsProbeEnabled() ? '/?probe=1' : ''
    const address = preferredLanAddress()
    const pairingUrl =
      !tokenValid
        ? undefined
        : this.tunnelActive && this.tunnelInstance?.url
          ? `${this.tunnelInstance.url}${probeSuffix}`
          : address
            ? `http://${address}:${this.port}/pair?token=${this.pairingToken}`
            : undefined
    return {
      running: true,
      connected: this.sessions.size > 0,
      port: this.port,
      ...(tokenValid && pairingUrl ? { pairingUrl, expiresAt: this.pairingExpiresAt } : {}),
      desktopUrl: `http://127.0.0.1:${this.port}/desktop`,
      tunnelActive: this.tunnelActive,
      tunnelLoading: this.tunnelLoading,
      tunnelUrl: this.tunnelInstance?.url,
      tunnelProvider: this.tunnelInstance?.provider,
      tunnelError: this.tunnelError,
      connectedDevices: this.connectedDevices(),
      diagnostics: this.diagnosticsView()
    }
  }

  /** @returns {ConnectedDevice[]} */
  connectedDevices() {
    return [...this.sessions.entries()].map(([token, session]) => {
      const id = this.deviceIdOf(token)
      return {
        // Two handsets of the same model produced the same 40-character label,
        // which left a desktop with two phones it could not tell apart — and
        // no way to pick one to revoke. The id is only a display tail here; the
        // stored label stays the retirement key it has always been.
        label: `${session.label ?? 'Phone'} · ${id}`,
        remoteAddress: session.remoteAddress,
        issuedAt: session.issuedAt ?? 0,
        expiresAt: session.expiresAt ?? 0,
        id
      }
    })
  }

  rotatePairingToken() {
    this.pairingToken = randomBytes(32).toString('base64url')
    this.pairingExpiresAt = this.now() + PAIRING_TTL_MS
    this.qrSvgCache.clear()
  }

  /** @returns {boolean} */
  pairingTokenValid() {
    return Boolean(this.pairingToken && this.pairingExpiresAt && this.pairingExpiresAt >= this.now())
  }

  storedPinState() {
    return this.options.pairingPinStore?.load() ?? {}
  }

  /** @returns {PairingPinView} */
  readPairingPin() {
    const stored = this.storedPinState()
    if (stored.pinConsent === true) {
      return { pin: stored.pin, expired: false, consent: true }
    }
    if (this.ephemeralPin && this.ephemeralPinExpiresAt && this.ephemeralPinExpiresAt >= this.now()) {
      return {
        pin: this.ephemeralPin,
        expired: false,
        consent: false,
        expiresAt: this.ephemeralPinExpiresAt
      }
    }
    if (this.ephemeralPin && this.ephemeralPinExpiresAt && this.ephemeralPinExpiresAt < this.now()) {
      return { expired: true, consent: false, expiresAt: this.ephemeralPinExpiresAt }
    }
    return { expired: false, consent: false }
  }

  /** @returns {boolean} */
  tunnelPinAcceptsReconnect() {
    const view = this.readPairingPin()
    return Boolean(view.pin) && !view.expired
  }

  /** @returns {string} */
  generatePairingPin() {
    // Width is a constant, not a literal: the phone's password field, the two
    // hints that name the length, and this generator have to move together, and
    // a password already on disk stays valid across the move (see pin-store).
    return String(randomInt(0, PAIRING_PIN_SPACE)).padStart(PAIRING_PIN_DIGITS, '0')
  }

  /** @returns {string | undefined} */
  ensurePairingPin() {
    const stored = this.storedPinState()
    if (stored.pinConsent === true) {
      if (stored.pin) return stored.pin
      const pin = this.generatePairingPin()
      if (!this.options.pairingPinStore?.save({ pin, pinConsent: true })) return undefined
      this.ephemeralPin = undefined
      this.ephemeralPinExpiresAt = undefined
      return pin
    }
    const current = this.readPairingPin()
    if (current.pin && !current.expired) return current.pin
    this.ephemeralPin = this.generatePairingPin()
    this.ephemeralPinExpiresAt = this.now() + PIN_TTL_MS
    return this.ephemeralPin
  }

  /**
   * Re-issue the ephemeral pairing password the moment a tunnel comes up.
   *
   * A quick tunnel gets a new public URL every launch, but the password shown
   * against the previous one stayed valid for its whole five-minute window, and
   * whoever had both the old link and the old password could still pair. The
   * consented durable password is deliberately left alone: staying valid across
   * tunnels is the feature the desktop panel promises (§12 禁令 3).
   * @returns {void}
   */
  rotateEphemeralPinForTunnel() {
    if (this.storedPinState().pinConsent === true) return
    this.ephemeralPin = this.generatePairingPin()
    this.ephemeralPinExpiresAt = this.now() + PIN_TTL_MS
  }

  desktopPinFields() {
    const pin = this.tunnelActive ? this.ensurePairingPin() : undefined
    const view = this.readPairingPin()
    return {
      ...(pin ? { pairingPin: pin } : {}),
      pinConsent: view.consent,
      ...(view.consent || !view.expiresAt ? {} : { pinExpiresAt: view.expiresAt })
    }
  }

  /**
   * @param {string} left
   * @param {string} right
   * @returns {boolean}
   */
  pinsEqual(left, right) {
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /**
   * @param {number[]} stamps
   * @returns {number[]}
   */
  pruneFailures(stamps) {
    const cutoff = this.now() - PIN_FAIL_WINDOW_MS
    return stamps.filter((stamp) => stamp > cutoff)
  }

  /**
   * Current failure state of one limit key, with aged-out stamps dropped and the
   * key moved to the back of the map so the cap evicts idle keys first.
   * @param {string} key
   * @returns {PairingFailureState}
   */
  failureState(key) {
    const previous = this.pinFailuresByIp.get(key)
    const stamps = this.pruneFailures(previous?.stamps ?? [])
    const state = /** @type {PairingFailureState} */ ({ count: stamps.length, stamps })
    // A lockout is a wall, not a window: it survives its own stamps ageing out
    // and expires on its own when its time is up; only a desktop password
    // action (or a restart) takes it down early.
    if (previous?.lockedUntil !== undefined && previous.lockedUntil > this.now()) {
      state.lockedUntil = previous.lockedUntil
    }
    this.pinFailuresByIp.delete(key)
    this.pinFailuresByIp.set(key, state)
    return state
  }

  /**
   * Keep the key map itself bounded: a guesser that rotates the address it is
   * seen from must not be able to grow one Map entry per attempt forever.
   * @returns {void}
   */
  capFailureKeys() {
    while (this.pinFailuresByIp.size > PIN_FAIL_KEYS_MAX) {
      const idle = [...this.pinFailuresByIp.entries()].find(
        ([, state]) => state.count === 0 && state.lockedUntil === undefined
      )?.[0]
      const oldest = idle ?? this.pinFailuresByIp.keys().next().value
      if (oldest === undefined) return
      this.pinFailuresByIp.delete(oldest)
    }
  }

  /**
   * @param {string} key
   * @returns {number | undefined}
   */
  pinRetryAfterSeconds(key) {
    const state = this.failureState(key)
    const global = this.pruneFailures(this.pinFailuresGlobal)
    this.pinFailuresGlobal = global
    if (state.lockedUntil !== undefined) {
      return Math.max(1, Math.ceil((state.lockedUntil - this.now()) / 1000))
    }
    const limited = state.count >= PIN_FAIL_PER_IP || global.length >= PIN_FAIL_GLOBAL
    if (!limited) return undefined
    // Exponential from the soft limit (15s, 30s, 60s … capped at 15 min) on top
    // of whatever is left of the sliding window, so each wrong guess is worth
    // less than the last instead of resetting to the same short pause.
    const over = Math.max(0, state.count - PIN_FAIL_PER_IP)
    const backoff = Math.min(PIN_FAIL_MAX_SECONDS, PIN_FAIL_BASE_SECONDS * 2 ** over)
    const windowLeft = Math.ceil((state.stamps[0] + PIN_FAIL_WINDOW_MS - this.now()) / 1000)
    return Math.max(1, backoff, Number.isFinite(windowLeft) ? windowLeft : 1)
  }

  /**
   * @param {string} key
   * @returns {number}
   */
  recordPinFailure(key) {
    const state = this.failureState(key)
    state.stamps.push(this.now())
    state.count = state.stamps.length
    if (state.count >= PIN_FAIL_HARD_LOCK) state.lockedUntil = this.now() + PIN_FAIL_LOCKOUT_MS
    this.pinFailuresGlobal = this.pruneFailures(this.pinFailuresGlobal)
    this.pinFailuresGlobal.push(this.now())
    this.capFailureKeys()
    return this.pinRetryAfterSeconds(key) ?? 1
  }

  /**
   * Clear pairing-password failures.
   *
   * With a key, only that key: that is what one correct password earns. Without
   * one, everything — which is what the desktop resetting or turning off the
   * password means. A success never clears the global counter, or a client that
   * alternates one right answer with four wrong ones would hand itself a clean
   * slate on every pair it gets in.
   * @param {string} [key]
   * @returns {void}
   */
  clearPinFailures(key) {
    if (key !== undefined) {
      this.pinFailuresByIp.delete(key)
      return
    }
    this.pinFailuresByIp.clear()
    this.pinFailuresGlobal = []
  }

  revokeMobileSessions() {
    this.sessions.clear()
    this.suspendedSessions.clear()
    this.resumableSessions.clear()
    // A password reset (or a consent withdrawal) is the durable clean slate:
    // the registry goes with it, so every device — known or not — walks the
    // FULL funnel again (PIN, desktop confirmation, consent). Keeping profiles
    // here would let an old fingerprint skip the desktop on its next pairing,
    // which is exactly the assurance a reset is supposed to withdraw.
    this.devices.clear()
    this.rotatePairingToken()
    this.clearPinFailures()
    this.syncConnected()
  }

  /**
   * Fill the per-device fields on a session promoted from a placeholder or a
   * restored suspended session. Already-issued sessions keep their original
   * label and expiry.
   * @param {MobileSession} session
   * @param {import('node:http').IncomingMessage} request
   */
  stampSession(session, request) {
    if (session.issuedAt === undefined) {
      session.issuedAt = this.now()
      session.expiresAt = session.issuedAt + MOBILE_COOKIE_TTL_MS
    }
    if (session.label === undefined) {
      session.label = uaLabel(request.headers['user-agent'])
    }
    // The second condition on the LAN same-address shortcut. A session created
    // before this field existed simply never qualifies until it is seen with a
    // cookie again, which is the safe direction.
    if (session.fingerprint === undefined) {
      session.fingerprint = deviceFingerprint(request.headers['user-agent'])
    }
  }

  /**
   * Record that a device just proved itself with its own cookie: this is what
   * keeps its address usable as identity for the next minute without one.
   * The registry profile's sighting moves with it (spec: lastSeenAt refreshes
   * on every successful authentication) — an in-memory write riding the same
   * debounced persist the session maps already get, never its own disk write.
   * @param {MobileSession} session
   * @returns {void}
   */
  noteDeviceSeen(session) {
    session.lastSeenAt = this.now()
    const profile = session.fingerprint !== undefined ? this.devices.get(session.fingerprint) : undefined
    if (profile !== undefined) profile.lastSeenAt = session.lastSeenAt
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @returns {string}
   */
  deviceFingerprintOf(request) {
    return deviceFingerprint(request.headers['user-agent'])
  }

  /**
   * Opaque handle the desktop panel revokes one device by. Keyed with the
   * desktop session secret so it is not derivable from the pairing cookie a
   * phone holds, and short enough to live in a button's data attribute.
   * @param {string} token
   * @returns {string}
   */
  deviceIdOf(token) {
    return createHash('sha256')
      .update(`${this.desktopSessionToken}\u0000${token}`)
      .digest('base64url')
      .slice(0, 10)
  }

  /**
   * Log-safe alias for a registry key (the fingerprint) — the management
   * actions are addressed by it, and the fingerprint never reaches the log.
   * Keyed with the desktop secret the same way `deviceIdOf` is, so the alias
   * is stable within one bridge life and meaningless to anyone holding the
   * phone.
   * @param {string} fingerprint
   * @returns {string}
   */
  fingerprintTail(fingerprint) {
    return createHash('sha256')
      .update(`${this.desktopSessionToken}\u0000fp:${fingerprint}`)
      .digest('base64url')
      .slice(0, 10)
  }

  /**
   * Opaque handle of whoever sent this request, for a LOG LINE only.
   *
   * `/api/rpc` failure used to be unattributable: one URL carries fourteen
   * methods, so a desktop with a phone on it could see "rpc failed" and not
   * which handset or which call. The credential itself never goes into the log
   * (design §5); this is the same short id the desktop list shows.
   * @param {import('node:http').IncomingMessage} request
   * @returns {string}
   */
  deviceTail(request) {
    const held = this.mobileToken(request)
    if (held === undefined || held === '') return 'anonymous'
    return this.deviceIdOf(held)
  }

  /**
   * Keep a client-supplied name on one line and inside a sane length. Method
   * names and question ids arrive from a socket; a CRLF in a log line is a
   * forged entry, so anything outside the identifier alphabet is dropped.
   * @param {unknown} value
   * @param {number} [max]
   * @returns {string}
   */
  static safeName(value, max = 48) {
    if (typeof value !== 'string') return '-'
    const cleaned = value.replace(/[^A-Za-z0-9._/\-]/g, '')
    return cleaned.length === 0 ? '-' : cleaned.slice(0, max)
  }

  /**
   * Drop one device's session and every parked copy of it. The token is the
   * credential, so revoking is what actually ends a phone's access — a cookie
   * the desktop never sees is never handed to the browser to name.
   *
   * Two handles reach the same hard delete (change 2026-10-07-feat-pocket-
   * device-registry): the per-token derived id the live-device list has always
   * shown, and the registry key the paired-device management page shows. Both
   * end in the same place — sessions gone (kicked, not parked), and the
   * registry profile deleted too, so a revoked device re-pairs through the
   * FULL funnel (PIN, desktop confirmation, consent) no matter what UA it
   * presents. No tombstone: an unknown device answers like one that never
   * existed.
   * @param {string} id
   * @returns {boolean} true when something was revoked
   */
  revokeDevice(id) {
    if (typeof id !== 'string' || id.length === 0) return false
    /** Tokens of the matching entries, and the fingerprints they carried. Local only: never logged, never returned. */
    const matches = new Map()
    const collectByDeviceId = (map) => {
      for (const [token, session] of map) {
        if (this.deviceIdOf(token) === id) matches.set(token, session.fingerprint)
      }
    }
    collectByDeviceId(this.sessions)
    collectByDeviceId(this.suspendedSessions)
    collectByDeviceId(this.resumableSessions)
    // The management page names devices by the registry key: every session
    // carrying that fingerprint belongs to the same device and goes with it.
    const profile = this.devices.get(id)
    if (profile !== undefined) {
      const collectByFingerprint = (map) => {
        for (const [token, session] of map) {
          if (session.fingerprint === id) matches.set(token, session.fingerprint)
        }
      }
      collectByFingerprint(this.sessions)
      collectByFingerprint(this.suspendedSessions)
      collectByFingerprint(this.resumableSessions)
    }
    if (matches.size === 0 && profile === undefined) return false
    for (const token of matches.keys()) {
      this.kickDeviceStreams(token)
      this.sessions.delete(token)
      this.suspendedSessions.delete(token)
      this.resumableSessions.delete(token)
    }
    // Hard-delete the profile: directly when the revoke came in by registry
    // key; on the token path too, once no session sharing the fingerprint is
    // left (revoking the last session of a device must not leave a profile
    // that would let the PIN alone skip the funnel).
    // The log line names an alias, never the registry key itself.
    const logId = profile !== undefined ? this.fingerprintTail(id) : id
    if (profile !== undefined) {
      this.devices.delete(id)
    } else {
      const revokedFingerprints = new Set([...matches.values()].filter(Boolean))
      for (const fingerprint of revokedFingerprints) {
        const stillAround =
          [...this.sessions.values(), ...this.suspendedSessions.values(), ...this.resumableSessions.values()]
            .some((session) => session.fingerprint === fingerprint)
        if (!stillAround) this.devices.delete(fingerprint)
      }
    }
    this.log('info', `device revoked id=${logId} entries=${matches.size}`)
    this.syncConnected()
    return true
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {string} remoteAddress
   * @param {MobileConnectionMode} connectionMode
   */
  issueSessionCookie(request, response, remoteAddress, connectionMode) {
    this.sweepExpiredSessions()
    /** @type {string | undefined} token of the session restored from suspension */
    let revivedToken
    const label = uaLabel(request.headers['user-agent'])
    // The phone already holds a live cookie for this bridge, so it is the SAME
    // handset pairing again (a re-submitted PIN, a second tab, a reloaded scan
    // link). Re-issue the token it already has: minting a fresh one left the first
    // entry live for the remaining 30-day cookie lifetime while the phone could
    // never present it again, so the desktop counted one phone as two devices.
    const presented = this.mobileToken(request)
    if (presented && this.sessions.has(presented)) {
      const session = this.sessions.get(presented)
      this.stampSession(session, request)
      this.noteDeviceSeen(session)
      // Reading it is what makes it the newest entry: an active handset must not
      // be the first thing the 16-device cap throws out.
      this.touchDevice(this.sessions, presented)
      revivedToken = presented
    } else if (connectionMode === 'tunnel') {
      const existing = this.mobileToken(request)
      if (existing && this.suspendedSessions.has(existing)) {
        const session = this.suspendedSessions.get(existing)
        this.stampSession(session, request)
        this.noteDeviceSeen(session)
        this.capDeviceMap(this.sessions, existing)
        this.sessions.set(existing, session)
        this.suspendedSessions.delete(existing)
        this.resumableSessions.delete(existing)
        revivedToken = existing
      }
    } else {
      // Multiple same-IP suspended entries can exist after repeated
      // pair/disconnect cycles (and rememberMobileContext also parks anonymous
      // cookies there). Revive only the most recently issued entry: the phone
      // holds a cookie for that token, and reviving every match left the rest
      // in sessions as phantom devices for the full 30-day lifetime.
      /** @type {string | undefined} */
      let newestToken
      for (const [savedToken, session] of this.suspendedSessions) {
        if (session.remoteAddress !== remoteAddress) continue
        const newest = newestToken === undefined ? undefined : this.suspendedSessions.get(newestToken)
        if (newestToken === undefined || (session.issuedAt ?? 0) > (newest?.issuedAt ?? 0)) {
          newestToken = savedToken
        }
      }
      if (newestToken !== undefined) {
        const session = this.suspendedSessions.get(newestToken)
        this.stampSession(session, request)
        this.noteDeviceSeen(session)
        this.capDeviceMap(this.sessions, newestToken)
        this.sessions.set(newestToken, session)
        this.suspendedSessions.delete(newestToken)
        this.resumableSessions.delete(newestToken)
        revivedToken = newestToken
      }
    }
    const token = revivedToken ?? randomBytes(32).toString('base64url')
    if (revivedToken === undefined) {
      const issuedAt = this.now()
      // The phone cannot prove which live entry is its own here: its cookie is
      // gone (cleared storage, a fresh tunnel hostname, a switch to LAN). Retire
      // the same handset's older entry so re-pairing replaces the device instead
      // of counting it twice. Label + address is the narrowest key available —
      // and it is only available on the LAN, where the address really is that
      // one handset's interface. Behind a tunnel the address is the carrier's
      // shared egress and the label is a stock User-Agent string, so matching on
      // them would evict a different phone that happens to report the same pair;
      // a tunnel device is only ever retired by the token it presents.
      if (connectionMode === 'lan') {
        for (const [liveToken, session] of this.sessions) {
          if (session.remoteAddress === remoteAddress && session.label === label) {
            this.sessions.delete(liveToken)
            this.log('info', `stale session retired addr=${remoteAddress} label=${label}`)
          }
        }
      }
      this.capDeviceMap(this.sessions, token)
      this.sessions.set(token, {
        token,
        remoteAddress,
        label,
        fingerprint: deviceFingerprint(request.headers['user-agent']),
        issuedAt,
        expiresAt: issuedAt + MOBILE_COOKIE_TTL_MS
      })
      // A freshly minted credential is a (re)pairing: the registry re-issues
      // the device's profile lifetime, creating it — with the permission its
      // first channel implies — when this fingerprint has never been seen.
      const profile = this.deviceProfileUpsert(this.sessions.get(token).fingerprint, {
        label,
        permission: connectionMode === 'tunnel' ? 'lan+wan' : 'lan',
      })
      // 凭证的寿命以档案的绝对到期线为准；cookie 不许比它活得更久。
      const minted = this.sessions.get(token)
      if (minted !== undefined && typeof profile?.expiresAt === 'number' && Number.isFinite(profile.expiresAt)) {
        if (typeof minted.expiresAt !== 'number' || minted.expiresAt > profile.expiresAt) {
          minted.expiresAt = profile.expiresAt
        }
      }
    }
    this.pairingToken = undefined
    this.pairingExpiresAt = undefined
    const secure = connectionMode === 'tunnel' ? '; Secure' : ''
    // Max-Age 从这条凭证**真正的到期时刻**算出来，而不是每次写死满 30 天——
    // 否则设备早已过期的档案还会发出一条新 cookie。
    const cookieSession = this.sessions.get(token)
    const cookieExpiresAt = cookieSession?.expiresAt ?? this.now() + MOBILE_COOKIE_TTL_MS
    const maxAgeSeconds = Math.max(1, Math.round((cookieExpiresAt - this.now()) / 1000))
    response.setHeader(
      'set-cookie',
      `dsh_mobile=${token}; HttpOnly; SameSite=Strict; Path=/${secure}; Max-Age=${maxAgeSeconds}`
    )
    // Computed before the log line so the credential name never appears inside
    // a `${ }` hole: the invariant under test is that a log line prints no
    // token, and a boolean read of one is not a print of it.
    const reusesEntry = revivedToken !== undefined
    this.log('info', `device paired mode=${connectionMode} addr=${remoteAddress} label=${label} reused=${reusesEntry ? 1 : 0}`)
  }

  /** @returns {Promise<void>} */
  async stopCurrentTunnel() {
    if (!this.tunnelInstance) return
    this.tunnelExpectedStop = true
    try {
      await this.tunnelInstance.stop().catch(() => undefined)
    } finally {
      this.tunnelExpectedStop = false
      this.tunnelInstance = undefined
      // The tunnel is gone, so the reason to keep a host-exit listener is gone.
      // Leaving one behind would accumulate one closure per toggle for the life
      // of the host process.
      this.disarmHostExitCleanup()
    }
  }

  clearTunnelDeathFlags() {
    this.unexpectedlyClosed = false
    this.lastTunnelProvider = undefined
  }

  /** @param {object | undefined} instance */
  armTunnelProcess(instance) {
    if (!instance) return
    // The only provider this build launches is Cloudflare, whose quick tunnels
    // carry no TTL; the Pinggy expiry branch returns with that provider.
    this.tunnelExpiresAt = undefined
    instance.process?.once?.('close', () => {
      if (this.tunnelInstance !== instance) return
      if (this.tunnelExpectedStop) return
      this.handleUnexpectedTunnelClose(instance)
    })
    // M12: the carrier is a child process of the HOST. Stop() tears it down on
    // the normal path, but a plugin that never gets to dispose (the app is
    // closing, the renderer took the process with it) would otherwise leave a
    // cloudflared alive behind, holding a quick-tunnel URL that now points at
    // nothing — and every later launch adds another.
    this.armHostExitCleanup(instance)
  }

  /**
   * Terminate the live tunnel child if the host is going down around it.
   *
   * `exit` is the one event that still fires on a shutdown that skipped every
   * plugin dispose, and its handlers run synchronously — `kill` is synchronous,
   * so this works there. It is deliberately not a by-name sweep at startup:
   * `cloudflared` may be the user's own process serving something else, and
   * killing by image name would reach it.
   * @param {object} instance
   */
  armHostExitCleanup(instance) {
    const child = instance?.process
    if (!child || typeof child.kill !== 'function') return
    this.disarmHostExitCleanup()
    const cleanup = () => {
      if (this.tunnelExpectedStop) return
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      } catch {
        /* already gone before the host was */
      }
    }
    this.tunnelExitCleanup = cleanup
    process.on('exit', cleanup)
  }

  /** @returns {void} */
  disarmHostExitCleanup() {
    const cleanup = this.tunnelExitCleanup
    if (cleanup === undefined) return
    this.tunnelExitCleanup = undefined
    try {
      process.removeListener('exit', cleanup)
    } catch {
      /* a runtime without exit listeners is not a failure */
    }
  }

  /** @param {object} instance */
  handleUnexpectedTunnelClose(instance) {
    // X4⑦: the carrier dying took every phone session with it. That count is
    // the whole operational question — "how many handsets just got kicked" —
    // and it used to be thrown away in silence.
    const signedOut = this.sessions.size
    // The carrier dying is not the desktop ending the visit: every live session
    // is parked exactly the way /desktop/disconnect parks them, so the phone's
    // own cookie revives it on /reconnect. Only the pairing rotation is left out
    // — rotating is the deliberate-teardown semantic, and an unexpected death is
    // not deliberate.
    for (const [token, session] of this.sessions) {
      this.capDeviceMap(this.suspendedSessions, token)
      this.suspendedSessions.set(token, session)
      this.capDeviceMap(this.resumableSessions, token)
      this.resumableSessions.set(token, session)
    }
    const parked = this.suspendedSessions.size + this.resumableSessions.size
    this.log(
      'error',
      `tunnel closed unexpectedly provider=${instance.provider ?? '?'} url=${instance.url ?? '?'}` +
        ` signedOut=${String(signedOut)} parked=${String(parked)}`
    )
    this.lastTunnelProvider = instance.provider
    this.unexpectedlyClosed = true
    this.tunnelActive = false
    this.tunnelLoading = false
    this.tunnelExpiresAt = undefined
    this.tunnelInstance = undefined
    this.sessions.clear()
    // The carrier that was reporting this state is gone with it.
    this.noteMuxState(false)
    this.disarmHostExitCleanup()
    this.syncConnected()
  }

  /**
   * @param {LanMobileBridgeSnapshot} snapshot
   * @param {string} [qrSvg]
   * @returns {Record<string, unknown>}
   */
  desktopTunnelPayload(snapshot, qrSvg) {
    return {
      active: snapshot.tunnelActive,
      loading: snapshot.tunnelLoading,
      url: snapshot.tunnelUrl,
      provider: snapshot.tunnelProvider ?? this.lastTunnelProvider,
      error: snapshot.tunnelError,
      pairingUrl: snapshot.pairingUrl,
      qrSvg,
      expiresAt: snapshot.expiresAt,
      unexpectedlyClosed: this.unexpectedlyClosed,
      tunnelExpiresAt: this.tunnelExpiresAt,
      connectedDevices: this.connectedDevices(),
      diagnostics: this.diagnosticsView(),
      // The pairing page polls in one round per tick, not two: it needs the
      // "is a phone on me / is someone waiting to be let in" answer at the same
      // cadence as the QR, and paying a second request for three booleans was
      // pure overhead. Supersets /desktop/status, which stays for the surfaces
      // that only want the connection answer.
      connected: this.sessions.size > 0,
      pendingPairings: this.pendingPairingsView(),
      ...this.desktopPinFields()
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @returns {Promise<void>}
   */
  async handle(request, response) {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('x-frame-options', 'DENY')
    response.setHeader('referrer-policy', 'no-referrer')
    // One nonce per request: it authorizes this response's inline scripts and
    // is passed to the page renderers, so it must not be reused across
    // requests. Harmless on JSON/plain/asset routes that have no inline
    // scripts.
    const nonce = randomBytes(16).toString('base64url')
    response.setHeader('content-security-policy', buildContentSecurityPolicy(nonce))

    const transportAddress = normalizeRemoteAddress(request.socket.remoteAddress ?? '')
    if (!isPrivateAddress(transportAddress)) return this.text(response, 403, 'Private network only.')
    const connectionMode = this.requestConnectionMode(request, transportAddress)
    // Only `cf-connecting-ip` is ever read as the client's address, and only
    // once `requestConnectionMode` has put the request on the local carrier.
    // `x-forwarded-for` used to be the fallback: a plain client header on a
    // listener every private host can reach, so each pairing attempt could
    // rename the bucket it was counted in.
    const carrierAddress =
      connectionMode === 'tunnel' ? firstHeaderValue(request.headers['cf-connecting-ip']) : undefined
    const remoteAddress = carrierAddress
      ? normalizeRemoteAddress(carrierAddress)
      : transportAddress
    // The key PIN failures are counted under. In LAN mode that is the socket
    // peer — the address a neighbour cannot claim for itself.
    const rateKey = pairingRateKey(transportAddress, connectionMode, carrierAddress)
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

    if (request.method === 'GET' && url.pathname.startsWith('/brand-logo/')) {
      // Branding is decoration, but it is a read of a local file path over a
      // listener that the tunnel publishes: an unauthenticated probe could use
      // it to confirm a pocket bridge is behind an address, and `cache-control:
      // public` put the answer in every cache between here and the browser.
      if (!this.canReadBranding(request, remoteAddress, connectionMode)) {
        return this.text(response, 401, 'Pair your phone again.')
      }
      const variant = url.pathname === '/brand-logo/dark' ? 'dark' : 'light'
      const path = this.options.brandLogoPaths?.[variant]
      if (!path) return this.text(response, 404, 'Brand asset not found.')
      try {
        const body = await this.readCachedImage(path)
        response.statusCode = 200
        response.setHeader('content-type', 'image/png')
        response.setHeader('cache-control', 'public, max-age=3600')
        response.end(body)
      } catch {
        this.text(response, 404, 'Brand asset not found.')
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/app-icon') {
      if (!this.canReadBranding(request, remoteAddress, connectionMode)) {
        return this.text(response, 401, 'Pair your phone again.')
      }
      // `?ui=1` is the 96px version, and it is what the app document points at.
      // The raw file is 128 KB for a glyph that renders 22px; the document used to
      // pay for it three times over as inline base64 on every cold open. The bare
      // path keeps serving the raw 1024x1024 because the PWA manifest promises
      // exactly that size (test/pages-panel-ux.test.js ①) — do not swap them.
      // This branch reads `iconUiBytes` alone: those bytes only ever exist when a
      // source path was configured AND decoded, so it needs no path of its own.
      if (url.searchParams.get('ui') === '1' && this.iconUiBytes) {
        response.statusCode = 200
        response.setHeader('content-type', 'image/png')
        response.setHeader('cache-control', 'public, max-age=86400')
        response.end(this.iconUiBytes)
        return
      }
      const path = this.options.appIconPath
      if (!path) return this.text(response, 404, 'App icon not found.')
      try {
        const body = await this.readCachedImage(path)
        response.statusCode = 200
        response.setHeader('content-type', 'image/png')
        response.setHeader('cache-control', 'public, max-age=86400')
        response.end(body)
      } catch {
        this.text(response, 404, 'App icon not found.')
      }
      return
    }

    // PWA manifest (design #1a): served to a paired phone at the same gate as
    // the app itself, plus the tunnel-side consent door — a manifest is a
    // description of this origin and reaches nobody who has not been let in.
    if (request.method === 'GET' && url.pathname === '/manifest.json') {
      if (this.devicePermissionBlocked(request, response, connectionMode)) return
      if (this.handleConsentGate(request, response, connectionMode, url)) return
      if (!this.authorized(request, remoteAddress, connectionMode)) {
        return this.text(response, 401, 'Pair your phone again.')
      }
      response.statusCode = 200
      response.setHeader('content-type', 'application/manifest+json')
      response.end(pocketPages.renderManifestJson())
      return
    }

    // The service worker stays public on purpose: it is what a browser fetches
    // before it has anything to authenticate with, and it carries no data.
    if (request.method === 'GET' && url.pathname === '/sw.js') {
      response.statusCode = 200
      response.setHeader('content-type', 'application/javascript; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(renderServiceWorker(this.shellBuild()))
      return
    }

    if (request.method === 'GET' && url.pathname === '/desktop') {
      if (url.searchParams.has('k')) {
        await this.consumeDesktopBootstrap(url.searchParams.get('k'), transportAddress, response)
        return
      }
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifyTrustedOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      if (!this.server || !this.port) return this.text(response, 503, 'Bridge unavailable.')
      // The token is consumed once a phone pairs, and expires after five
      // minutes. The desktop window stays open across both: rotate so it
      // keeps showing a scannable code instead of a dead one (or a 503).
      if (!this.pairingTokenValid()) {
        this.rotatePairingToken()
      }
      const snapshot = this.snapshot()
      const connected = this.sessions.size > 0
      if (!snapshot.pairingUrl && !connected) return this.text(response, 503, 'Bridge unavailable.')
      const qrSvg = this.pairingQrSvg(snapshot.pairingUrl)
      const pin = this.desktopPinFields()
      return this.html(
        response,
        renderDesktopPairingPage({
          nonce,
          qrSvg,
          pairingUrl: snapshot.pairingUrl ?? '',
          expiresAt: snapshot.expiresAt ?? this.now(),
          locale: this.locale(),
          connected,
          tunnelActive: snapshot.tunnelActive,
          tunnelLoading: snapshot.tunnelLoading,
          tunnelProvider: snapshot.tunnelProvider ?? this.lastTunnelProvider,
          tunnelUrl: snapshot.tunnelUrl,
          tunnelError: snapshot.tunnelError,
          unexpectedlyClosed: this.unexpectedlyClosed,
          pairingPin: pin.pairingPin,
          pinConsent: pin.pinConsent,
          pinExpiresAt: pin.pinExpiresAt,
          tunnelExpiresAt: this.tunnelExpiresAt,
          // Cross-domain contracts (design D2): field names are pinned, the
          // desktop page consumes exactly these three shapes.
          notifyConfig: this.notifyConfigView(),
          tunnelConfig: this.tunnelConfigView(),
          diagnostics: this.diagnosticsView(),
          pendingPairings: this.pendingPairingsView()
        })
      )
    }

    if (request.method === 'GET' && url.pathname === '/desktop/status') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      this.sweepExpiredSessions()
      return this.json(response, 200, {
        connected: this.sessions.size > 0,
        connectedDevices: this.connectedDevices(),
        pendingPairings: this.pendingPairingsView()
      })
    }

    if (request.method === 'GET' && url.pathname === '/desktop/tunnel/status') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      // Same sweep the connection-only route runs: a page that polls this one
      // alone (the pairing page does) must still see expired sessions reaped
      // on its own beat.
      this.sweepExpiredSessions()
      const snapshot = this.snapshot()
      const qrSvg = this.pairingQrSvg(snapshot.pairingUrl)
      return this.json(response, 200, this.desktopTunnelPayload(snapshot, qrSvg))
    }

    if (request.method === 'POST' && url.pathname === '/desktop/pairing/rotate') {
      // Manual "refresh QR" must actually change the pairing link. The token
      // normally only rotates when it expires, so reloading the page within the
      // TTL redrew the identical QR/URL/countdown (user report 2026-10-01).
      // Rotate unconditionally here. Already-paired phones use a cookie, so
      // rotating the unused pairing token cannot drop an active phone.
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifyTrustedOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      this.rotatePairingToken()
      const next = this.snapshot()
      return this.json(response, 200, {
        ok: true,
        pairingUrl: next.pairingUrl ?? '',
        expiresAt: next.expiresAt ?? this.now()
      })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/pin/consent') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      let consent = false
      try {
        const parsed = JSON.parse(await readBody(request))
        consent = parsed.consent === true
      } catch {
        return this.json(response, 400, { ok: false, error: 'Invalid consent payload.' })
      }
      if (consent) {
        const pin = this.generatePairingPin()
        if (!this.options.pairingPinStore?.save({ pin, pinConsent: true })) {
          return this.json(response, 500, { ok: false, error: 'Unable to save the pairing password.' })
        }
        this.ephemeralPin = undefined
        this.ephemeralPinExpiresAt = undefined
        this.clearPinFailures()
      } else {
        const previous = this.storedPinState()
        if (!this.options.pairingPinStore?.save({ pinConsent: false })) {
          return this.json(response, 500, { ok: false, error: 'Unable to save the pairing password.' })
        }
        if (previous.pinConsent === true) this.revokeMobileSessions()
        this.ephemeralPin = undefined
        this.ephemeralPinExpiresAt = undefined
        this.ensurePairingPin()
      }
      const snapshot = this.snapshot()
      const qrSvg = this.pairingQrSvg(snapshot.pairingUrl)
      return this.json(response, 200, {
        ok: true,
        ...this.desktopTunnelPayload(snapshot, qrSvg)
      })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/pin/reset') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      if (this.storedPinState().pinConsent !== true) {
        return this.json(response, 400, { ok: false, error: 'A durable pairing password is not enabled.' })
      }
      const pin = this.generatePairingPin()
      if (!this.options.pairingPinStore?.save({ pin, pinConsent: true })) {
        return this.json(response, 500, { ok: false, error: 'Unable to save the pairing password.' })
      }
      this.revokeMobileSessions()
      const snapshot = this.snapshot()
      const qrSvg = this.pairingQrSvg(snapshot.pairingUrl)
      return this.json(response, 200, {
        ok: true,
        ...this.desktopTunnelPayload(snapshot, qrSvg)
      })
    }

    if (request.method === 'GET' && url.pathname === '/bye') {
      // 远程重启的告别页：手机页点确认后立即跳来。零 JS 静态纸，宿主死透也不吵；
      // 无鉴权——它是死的文字，没有任何能力。
      return this.html(response, renderByePage(this.locale()))
    }

    if (request.method === 'POST' && url.pathname === '/api/host/restart') {
      // 手机端远程重启（0.4.34）：主页头部电源钮 → 确认卡 → 这里。门与 /api/opened-at
      // 同类：同源＋在册手机会话。能驱动手机的人本就能发 prompt、建会话——配对漏斗
      // 就是这条能力的权限边界，重启宿主不比它更宽。
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      if (!this.liveMobileSession(request)) {
        return this.json(response, 401, { ok: false, error: 'Pair your phone again.' })
      }
      // 有会话在推进时默认拒绝（用户 2026-10-12 裁）；用户 2026-10-15 追加固
      // 制结束路径（REQ5②③）：force=true 时先对每个 busy 会话发 session.cancel，
      // 全部成功才继续重启——半成功（部分 cancel 失败）则 502 不重启，守卫不
      // 在猜的纪律不变。列表读不到同样拒绝。
      let force = false
      try { const parsed = JSON.parse(await readBody(request)); if (parsed && parsed.force === true) force = true } catch { /* no body or unparseable → non-force */ }
      const busy = await this.listBusySessions()
      if (busy === null) {
        return this.json(response, 502, { ok: false, error: 'Session list unavailable; restart refused.' })
      }
      if (busy.length > 0 && !force) {
        this.log('warn', `host restart refused: ${busy.length} session(s) running`)
        return this.json(response, 409, { ok: false, error: 'Sessions are running; restart refused.', busy })
      }
      if (busy.length > 0 && force) {
        this.log('info', `host restart force: cancelling ${busy.length} session(s)`)
        const results = await Promise.allSettled(busy.map((item) => this.invokeHarness('session/cancel', { request: { sessionId: item.sessionId } })))
        const failed = results.map((r, i) => (r.status === 'rejected' || !r.value?.ok) ? busy[i].sessionId : null).filter(Boolean)
        if (failed.length > 0) {
          this.log('error', `host restart force: ${failed.length}/${busy.length} cancel failed: ${failed.join(', ')}`)
          return this.json(response, 502, { ok: false, error: `Could not cancel ${failed.length} session(s).`, failed, busy })
        }
      }
      try {
        await this.requestHostRestart()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log('error', `host restart failed to arm: ${message}`)
        return this.json(response, 502, { ok: false, error: message })
      }
      this.log('info', 'host restart armed: DSH-ReviveOnce fires in ~8s, receipt is the WeChat push')
      return this.json(response, 200, { ok: true, delaySec: 8 })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/tunnel/toggle') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      // A live phone is not a reason to refuse: switching modes used to be
      // blocked whenever any session existed (M4). Devices are retired one at a
      // time by /desktop/revoke, or kept — switching to the tunnel does not
      // invalidate a LAN cookie, it only changes where new pairing happens.
      let enable
      try {
        const bodyText = await readBody(request)
        if (bodyText) {
          const parsed = JSON.parse(bodyText)
          if (typeof parsed.enable === 'boolean') enable = parsed.enable
        }
      } catch {}
      // Report an in-progress switch honestly instead of answering with the
      // current (stale) snapshot the desktop UI cannot render.
      if (enable === true && this.tunnelLoading && !this.tunnelActive) {
        return this.json(response, 409, {
          ok: false,
          error: 'A tunnel switch is already in progress.'
        })
      }
      let snapshot
      try {
        snapshot = await this.toggleTunnel(enable)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log('error', `tunnel toggle failed: ${message}`)
        return this.json(response, 502, { ok: false, error: 'Tunnel could not be switched.' })
      }
      const qrSvg = this.pairingQrSvg(snapshot.pairingUrl)
      return this.json(response, 200, {
        ok: !snapshot.tunnelError,
        ...this.desktopTunnelPayload(snapshot, qrSvg)
      })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/disconnect') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      // This parks, it does not revoke: the phone keeps its cookie and the LAN
      // recovery path hands the session back. That convenience is the point of
      // the button ("断开连接"), so it stays — the honest way to end a device is
      // /desktop/revoke below, and the durable escape hatch is a password reset.
      for (const [token, session] of this.sessions) {
        // An explicit disconnect drops the restart mark: from here on this
        // session is a manual park, and only the PIN / QR / reconnect funnel
        // may bring it back — not the cookie alone.
        delete session.parkedByRestart
        this.capDeviceMap(this.suspendedSessions, token)
        this.suspendedSessions.set(token, session)
        this.capDeviceMap(this.resumableSessions, token)
        this.resumableSessions.set(token, session)
      }
      this.sessions.clear()
      this.rotatePairingToken()
      this.syncConnected()
      return this.json(response, 200, { ok: true })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/revoke') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      /** @type {string | undefined} */
      let deviceId
      try {
        const parsed = JSON.parse(await readBody(request))
        if (typeof parsed.deviceId === 'string') deviceId = parsed.deviceId
      } catch {
        return this.json(response, 400, { ok: false, error: 'Invalid revoke payload.' })
      }
      if (deviceId === undefined) {
        return this.json(response, 400, { ok: false, error: 'A device id is required.' })
      }
      const revoked = this.revokeDevice(deviceId)
      if (!revoked) return this.json(response, 404, { ok: false, error: 'That device is not connected.' })
      const snapshot = this.snapshot()
      const qrSvg = this.pairingQrSvg(snapshot.pairingUrl)
      return this.json(response, 200, { ok: true, ...this.desktopTunnelPayload(snapshot, qrSvg) })
    }

    // -- Paired-device management (change 2026-10-07-feat-pocket-device-registry)
    // The registry view: one row per device the bridge has ever paired, live or
    // not — the desktop list above only ever showed connected handsets, which
    // is why a device that was offline could not be managed at all.
    if (request.method === 'GET' && url.pathname === '/desktop/devices') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      this.sweepExpiredSessions()
      return this.json(response, 200, { ok: true, devices: this.pairedDevicesView() })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/device/extend') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      let deviceId
      try {
        const parsed = JSON.parse(await readBody(request))
        if (typeof parsed.deviceId === 'string') deviceId = parsed.deviceId
      } catch {
        return this.json(response, 400, { ok: false, error: 'Invalid extend payload.' })
      }
      if (deviceId === undefined || deviceId.length === 0) {
        return this.json(response, 400, { ok: false, error: 'A device id is required.' })
      }
      if (!this.extendDeviceProfile(deviceId)) {
        return this.json(response, 404, { ok: false, error: 'That device is not paired.' })
      }
      // The alias is computed before the log line so the handle itself never
      // appears inside a `${ }` hole (the §5 invariant the B1 scan walks).
      const extendTail = this.fingerprintTail(deviceId)
      this.log('info', `device credential extended id=${extendTail}`)
      return this.json(response, 200, { ok: true, devices: this.pairedDevicesView() })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/device/permission') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      /** @type {{ deviceId?: unknown, permission?: unknown }} */
      let body
      try {
        body = JSON.parse(await readBody(request))
      } catch {
        return this.json(response, 400, { ok: false, error: 'Invalid permission payload.' })
      }
      if (typeof body.deviceId !== 'string' || body.deviceId.length === 0) {
        return this.json(response, 400, { ok: false, error: 'A device id is required.' })
      }
      if (body.permission !== 'lan' && body.permission !== 'lan+wan') {
        return this.json(response, 400, { ok: false, error: 'The permission must be "lan" or "lan+wan".' })
      }
      if (!this.setDevicePermission(body.deviceId, body.permission)) {
        return this.json(response, 404, { ok: false, error: 'That device is not paired.' })
      }
      // Takes effect on the next request: the enforcement point reads the live
      // profile, so no session surgery is needed here. Same alias discipline as
      // the extend route: the handle is named by an alias, never printed.
      const permissionTail = this.fingerprintTail(body.deviceId)
      const permissionWord = body.permission === 'lan+wan' ? 'lan+wan' : 'lan'
      this.log('info', `device permission set id=${permissionTail} permission=${permissionWord}`)
      return this.json(response, 200, { ok: true, devices: this.pairedDevicesView() })
    }

    if (request.method === 'GET' && url.pathname === '/desktop/notify') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      // The key never leaves this process except on the outbound push itself.
      return this.json(response, 200, { ok: true, ...this.notifyConfigView() })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/notify') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      /** @type {{ channel?: unknown, key?: unknown, enabled?: unknown }} */
      let body
      try {
        body = JSON.parse(await readBody(request))
      } catch {
        return this.json(response, 400, { ok: false, error: 'Invalid notify payload.' })
      }
      const channel = typeof body.channel === 'string' ? body.channel : ''
      if (!NOTIFY_CHANNELS.includes(channel)) {
        return this.json(response, 400, { ok: false, error: 'Unknown notification channel.' })
      }
      if (typeof body.enabled !== 'boolean') {
        return this.json(response, 400, { ok: false, error: 'The enabled flag must be a boolean.' })
      }
      // A named key replaces the stored one; an omitted key keeps it. Anything
      // presented must be a plausible secret length — this field rides URLs.
      let key = this.notifyConfig.key
      if (body.key !== undefined) {
        if (typeof body.key !== 'string' || body.key.trim().length === 0 || body.key.length > 256) {
          return this.json(response, 400, { ok: false, error: 'The key must be 1-256 characters.' })
        }
        key = body.key
      }
      if (body.enabled && channel !== 'off' && key === '') {
        return this.json(response, 400, { ok: false, error: 'A key is required for the selected channel.' })
      }
      const notify = { channel, key, enabled: body.enabled }
      if (!this.options.settingsStore?.save({ notify })) {
        return this.json(response, 500, { ok: false, error: 'Unable to save the notification settings.' })
      }
      this.readNotifyConfig()
      this.syncNotifyWatcher()
      this.syncClawbotWatcher()
      this.log('info', `notify settings saved channel=${channel} enabled=${body.enabled ? 1 : 0}`)
      return this.json(response, 200, { ok: true, ...this.notifyConfigView() })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/notify/test') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      // A failed test is an answer, not an error: the desktop shows
      // delivered:false and the reason lives in the log only (no key, no URL).
      // 形状同其它推送：不自报「DSH Pocket」家门，标题是对象、正文是原因。
      const testConfig = this.notifyConfig
      const delivered = await notifySend(
        testConfig,
        '通知测试',
        '这是一条测试通知，能收到就说明通道是通的',
        {
          fetchImpl: this.options.notifyFetchImpl,
          log: (level, message) => this.log(level, message),
          onQuota: () => this.markClawbotQuotaSpent(),
          quotaTail: () => this.clawbotQuotaTail(testConfig)
        }
      )
      return this.json(response, 200, {
        ok: true,
        delivered,
        // 额度已尽时 delivered 会是 false，这个字段让桌面能区分「发失败」和「这轮没额度了」。
        quotaSpent: this.clawbotQuotaSpent
      })
    }

    if (request.method === 'GET' && url.pathname === '/desktop/notify/clawbot/qr') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      const qrRes = await getBotQrCode({
        fetchImpl: this.options.notifyFetchImpl,
        baseUrl: this.options.clawbotBaseUrl
      })
      if (!qrRes.ok) {
        return this.json(response, 502, { ok: false, error: qrRes.error })
      }
      const qrSvg = renderQrSvg(qrRes.url, { width: 220, margin: 1 })
      return this.json(response, 200, {
        ok: true,
        qrcode: qrRes.qrcode,
        url: qrRes.url,
        qrSvg
      })
    }

    if (request.method === 'GET' && url.pathname === '/desktop/notify/clawbot/status') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      const qrcode = url.searchParams.get('qrcode') || ''
      if (!qrcode) {
        return this.json(response, 400, { ok: false, error: 'qrcode parameter is required.' })
      }
      const res = await pollBotQrStatus(qrcode, {
        fetchImpl: this.options.notifyFetchImpl,
        baseUrl: this.options.clawbotBaseUrl
      })
      if (res.ok && res.botToken) {
        const notify = {
          channel: 'clawbot',
          key: res.botToken,
          enabled: true,
          clawbot: {
            botToken: res.botToken,
            userId: res.userId || '',
            contextToken: ''
          }
        }
        this.options.settingsStore?.save({ notify })
        this.readNotifyConfig()
        this.syncClawbotWatcher()
        this.syncNotifyWatcher()
        this.log('info', 'clawbot paired via desktop qr')
      }
      return this.json(response, 200, {
        ok: res.ok,
        status: res.status || 'unknown',
        bound: Boolean(res.botToken),
        error: res.error
      })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/notify/clawbot/reset') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      const notify = {
        channel: 'off',
        key: '',
        enabled: false,
        clawbot: { botToken: '', userId: '', contextToken: '' }
      }
      this.options.settingsStore?.save({ notify })
      this.readNotifyConfig()
      this.syncClawbotWatcher()
      this.syncNotifyWatcher()
      this.log('info', 'clawbot reset via desktop')
      return this.json(response, 200, { ok: true, ...this.notifyConfigView() })
    }

    if (request.method === 'GET' && url.pathname === '/desktop/tunnel/config') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      return this.json(response, 200, { ok: true, ...this.tunnelConfigView() })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/tunnel/config') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      /** @type {{ token?: unknown, hostname?: unknown }} */
      let body
      try {
        body = JSON.parse(await readBody(request))
      } catch {
        return this.json(response, 400, { ok: false, error: 'Invalid tunnel config payload.' })
      }
      if (
        body.token !== undefined &&
        (typeof body.token !== 'string' || body.token.length > 256)
      ) {
        return this.json(response, 400, { ok: false, error: 'The token must be at most 256 characters.' })
      }
      if (
        body.hostname !== undefined &&
        (typeof body.hostname !== 'string' ||
          (body.hostname !== '' && !isValidTunnelHostname(body.hostname.trim())))
      ) {
        return this.json(response, 400, { ok: false, error: 'The hostname does not look like a tunnel hostname.' })
      }
      // The store caps the hostname at TUNNEL_HOSTNAME_MAX_LENGTH (settings-store
      // drops longer values on both merge and read); accepting more here made the
      // endpoint answer ok for a save that never happened. Refuse instead.
      if (typeof body.hostname === 'string' && body.hostname.trim().length > TUNNEL_HOSTNAME_MAX_LENGTH) {
        return this.json(response, 400, {
          ok: false,
          error: `The hostname must be at most ${TUNNEL_HOSTNAME_MAX_LENGTH} characters.`,
        })
      }
      /** @type {{ token?: string, hostname?: string }} */
      const tunnel = {}
      if (typeof body.token === 'string') tunnel.token = body.token
      if (typeof body.hostname === 'string') tunnel.hostname = body.hostname.trim()
      if (!this.options.settingsStore?.save({ tunnel })) {
        return this.json(response, 500, { ok: false, error: 'Unable to save the tunnel settings.' })
      }
      this.log('info', `tunnel config saved hostname=${tunnel.hostname ? LanMobileBridge.safeName(tunnel.hostname, 253) : '(cleared)'}`)
      return this.json(response, 200, { ok: true, ...this.tunnelConfigView() })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/diagnostics') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      /** @type {{ probe?: unknown }} */
      let body
      try {
        body = JSON.parse(await readBody(request))
      } catch {
        return this.json(response, 400, { ok: false, error: 'Invalid diagnostics payload.' })
      }
      // Strict boolean on purpose: a truthy string ("false") would turn the probe
      // on and start shipping the phone's scroll timings into pocket.log, which is
      // exactly the outcome the off state exists to prevent.
      if (typeof body.probe !== 'boolean') {
        return this.json(response, 400, { ok: false, error: 'probe must be a boolean.' })
      }
      if (!this.options.settingsStore?.save({ diagnostics: { probe: body.probe } })) {
        return this.json(response, 500, { ok: false, error: 'Unable to save the diagnostics setting.' })
      }
      this.log('info', `diagnostics probe ${body.probe ? 'enabled' : 'disabled'} via desktop`)
      return this.json(response, 200, { ok: true, ...this.diagnosticsView() })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/pair/confirm') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      /** @type {{ id?: unknown, approve?: unknown }} */
      let body
      try {
        body = JSON.parse(await readBody(request))
      } catch {
        return this.json(response, 400, { ok: false, error: 'Invalid confirm payload.' })
      }
      if (typeof body.id !== 'string' || typeof body.approve !== 'boolean') {
        return this.json(response, 400, { ok: false, error: 'A confirm id and an approve flag are required.' })
      }
      this.sweepPendingPairings()
      const entry = this.pendingPairings.get(body.id)
      // Unknown and already-consumed ids answer 404 alike: the desktop card is
      // gone by then either way.
      if (!entry || entry.status !== 'pending') {
        return this.json(response, 404, { ok: false, error: 'That pairing request is no longer pending.' })
      }
      entry.status = body.approve ? 'approved' : 'denied'
      this.log('info', `pairing request ${body.approve ? 'approved' : 'denied'} addr=${entry.remoteAddress}`)
      return this.json(response, 200, { ok: true })
    }

    if (request.method === 'GET' && url.pathname === '/disconnected') {
      // No cross-origin hop any more: an unauthenticated request off the
      // internal network used to be 302'd to whatever URL the carrier's stdout
      // produced. The local page says the same thing without handing a stranger
      // a redirect to an internet-exposed origin.
      this.prewarmMobileBoot('disconnect-page')
      return this.html(response, renderMobileReconnectPage(this.locale(), connectionMode, { assets: this.mobileAssetBodies(this.locale()).urls, nonce, icon: this.iconDataUri }))
    }

    if (request.method === 'GET' && url.pathname === '/reconnect') {
      if (connectionMode === 'tunnel') {
        if (this.tunnelPinAcceptsReconnect()) {
          this.prewarmMobileBoot('pair-page')
      return this.html(response, renderPairingPinPage(this.locale(), this.iconDataUri, { assets: this.mobileAssetBodies(this.locale()).urls, nonce }))
        }
        return this.html(response, renderMobileReconnectPage(this.locale(), 'tunnel', { expired: true, assets: this.mobileAssetBodies(this.locale()).urls, nonce, icon: this.iconDataUri }))
      }
      // The phone that was just disconnected still holds its cookie. Restoring
      // that one session does not admit a neighbor who only knows the port.
      if (this.resumeSuspendedMobileSession(request) || this.mobileSessionActive(request)) {
        return this.redirect(response, '/')
      }
      this.options.onReconnectRequested?.()
      return this.html(response, renderMobileReconnectPage(this.locale(), 'lan', { resumeUnavailable: true, assets: this.mobileAssetBodies(this.locale()).urls, nonce, icon: this.iconDataUri }))
    }

    if (request.method === 'POST' && url.pathname === '/pair/retry') {
      if (!this.verifySameOrigin(request)) {
        this.log('warn', `pair retry rejected: cross-site addr=${remoteAddress}`)
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      // A retry is issued by whoever is standing on the recovery page, paired or
      // not, so this is one of the unauthenticated paths: no cross-origin 302
      // out of it. The LAN/tunnel answers below already say what to do.
      if (connectionMode === 'tunnel') {
        this.options.onReconnectRequested?.()
        // Logged because this branch is a deliberate no-op: it only tells the
        // phone to ask for the PIN. Its absence from the log means the phone never
        // reached this route at all.
        this.log('info', `pair retry mode=tunnel addr=${remoteAddress} pinRequired=true`)
        return this.json(response, 200, { ok: true, pinRequired: true })
      }
      if (this.resumeSuspendedMobileSession(request) || this.mobileSessionActive(request)) {
        this.log('info', `pair retry mode=${connectionMode} addr=${remoteAddress} reconnected=true`)
        return this.json(response, 200, { ok: true, reconnected: true })
      }
      this.options.onReconnectRequested?.()
      this.log('info', `pair retry mode=${connectionMode} addr=${remoteAddress} rescan=true`)
      return this.json(response, 200, { ok: true, rescan: true })
    }

    if (request.method === 'GET' && url.pathname === '/pair') {
      if (this.authorized(request, remoteAddress, connectionMode)) {
        response.statusCode = 302
        response.setHeader('location', '/')
        response.end()
        return
      }
      if (!this.validPairingToken(url.searchParams.get('token'))) {
        // The scan link is single-use and expires after five minutes, but the
        // phone keeps it in its history and home-screen shortcut, so a bare 401
        // made that entry a permanent dead end: reloading only logged another
        // rejection. Forward to the recovery surface instead — /reconnect still
        // demands the PIN (tunnel) or a fresh scan (LAN) before any session is
        // issued, and it never redirects back to /pair, so this cannot loop.
        this.log('warn', `pair rejected: invalid or expired token addr=${remoteAddress} mode=${connectionMode} offering=recovery`)
        return this.redirect(response, '/reconnect')
      }
      // The one cross-origin hop that stays: it moves a request that already
      // carries a live, single-use pairing token onto the tunnel origin, so the
      // cookie it is about to be given is the Secure one. An unauthenticated
      // scan attempt is not migrated — it is sent to the recovery surface above.
      const migrationUrl = this.tunnelMigrationUrl(url, connectionMode)
      if (migrationUrl) return this.redirect(response, migrationUrl)
      if (connectionMode === 'lan') {
        this.issueSessionCookie(request, response, remoteAddress, 'lan')
        response.statusCode = 302
        response.setHeader('location', '/')
        response.end()
        return
      }
      this.prewarmMobileBoot('pair-page')
      return this.html(response, renderPairingPinPage(this.locale(), this.iconDataUri, { assets: this.mobileAssetBodies(this.locale()).urls, nonce }))
    }

    if (request.method === 'POST' && url.pathname === '/pair/verify') {
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      if (connectionMode !== 'tunnel') {
        return this.json(response, 400, { ok: false, error: 'PIN verification is only used for internet pairing.' })
      }
      const retryAfter = this.pinRetryAfterSeconds(rateKey)
      if (retryAfter) {
        // X4⑧: the pre-check answers 429 before it ever looks at what was
        // typed, so until now a run of guesses produced NO log line at all — the
        // brute-force attempt was silent exactly while it was happening. This
        // names the window and the state, never a candidate password.
        const bucket = this.pinFailuresByIp.get(rateKey)
        this.log(
          'warn',
          'pairing rate-limited: ' +
            `addr=${remoteAddress} mode=${connectionMode} attempts=${String(bucket?.count ?? 0)} ` +
            `locked=${bucket?.lockedUntil !== undefined ? 'yes' : 'no'} retryAfter=${String(retryAfter)}s`
        )
        response.setHeader('retry-after', String(retryAfter))
        return this.json(response, 429, { ok: false, error: 'Too many attempts.', retryAfter })
      }
      let pin = ''
      try {
        const parsed = JSON.parse(await readBody(request))
        pin = typeof parsed.pin === 'string' ? parsed.pin.trim() : ''
      } catch {
        pin = ''
      }
      const view = this.readPairingPin()
      if (!view.pin || view.expired || !this.pinsEqual(pin, view.pin)) {
        if (view.expired || !view.pin) {
          this.log('warn', `pin verify rejected: pin expired or missing addr=${remoteAddress}`)
          return this.json(response, 401, { ok: false, error: 'expired', rescan: true })
        }
        this.recordPinFailure(rateKey)
        this.log('warn', `pin verify rejected: wrong pin addr=${remoteAddress}`)
        const limited = this.pinRetryAfterSeconds(rateKey)
        if (limited) {
          response.setHeader('retry-after', String(limited))
          return this.json(response, 429, { ok: false, error: 'Too many attempts.', retryAfter: limited })
        }
        return this.json(response, 401, { ok: false, error: 'Invalid pairing password.' })
      }
      // One right answer buys this key its own headroom back, and nothing more:
      // clearing the global counter here is what let a scripted guesser trade a
      // correct pair every fifth attempt for a permanently reset slate.
      this.clearPinFailures(rateKey)
      // PIN 即恢复 (device registry): a fingerprint the registry already knows
      // is a device the operator has already paired once. The PIN is the
      // operator's presence proof, so the restore re-issues the credential
      // directly — no desktop-confirmation round trip, and the consent answer
      // recorded in the profile keeps the gate quiet afterwards (user ruling:
      // after the first pairing, a scan plus the password is the whole funnel).
      // The profile refresh rides issueSessionCookie; the device's older
      // entries retire so one physical phone stays one row on the desktop.
      const knownProfile = this.deviceProfileMatch(this.deviceFingerprintOf(request), request.headers['user-agent'])
      if (knownProfile !== undefined) {
        this.retireSessionsOfFingerprint(knownProfile.fingerprint, this.mobileToken(request))
        this.issueSessionCookie(request, response, remoteAddress, 'tunnel')
        this.log('info', `pin verify restored a paired device addr=${remoteAddress}`)
        return this.json(response, 200, { ok: true, pending: false })
      }
      // The PIN alone no longer completes the pairing (design #4a): the desktop
      // — the operator who showed the QR — confirms the device. Register the
      // pending confirmation; the phone polls /pair/pending and receives its
      // cookie only after the desktop approves. Nothing is issued on this
      // response on purpose.
      const confirmId = randomBytes(16).toString('base64url')
      this.pendingPairings.set(confirmId, {
        id: confirmId,
        label: uaLabel(request.headers['user-agent']),
        remoteAddress,
        createdAt: this.now(),
        expiresAt: this.now() + PAIR_CONFIRM_TTL_MS,
        status: 'pending'
      })
      this.log('info', `pin verify accepted: awaiting desktop confirmation addr=${remoteAddress}`)
      return this.json(response, 200, {
        ok: true,
        pending: true,
        confirmId,
        checkAfterMs: PAIR_POLL_AFTER_MS
      })
    }

    if (request.method === 'GET' && url.pathname === '/pair/pending') {
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      if (this.pendingPollLimited(remoteAddress)) {
        response.setHeader('retry-after', '1')
        return this.json(response, 429, { ok: false, error: 'Too many attempts.' })
      }
      this.sweepPendingPairings()
      const confirmId = url.searchParams.get('confirmId') ?? ''
      const entry = this.pendingPairings.get(confirmId)
      // Unknown, consumed and expired all answer the same (design D8): an
      // attacker must not be able to distinguish a real confirmId from a
      // guessed one, and a phone only needs to know "start over".
      if (!entry) return this.json(response, 200, { ok: false, reason: 'expired' })
      if (entry.expiresAt <= this.now()) {
        this.pendingPairings.delete(confirmId)
        return this.json(response, 200, { ok: false, reason: 'expired' })
      }
      if (entry.status === 'approved') {
        // One-shot: the verdict is consumed by the poll that collects it.
        this.pendingPairings.delete(confirmId)
        this.issueSessionCookie(request, response, remoteAddress, 'tunnel')
        return this.json(response, 200, { ok: true, approved: true })
      }
      if (entry.status === 'denied') {
        this.pendingPairings.delete(confirmId)
        return this.json(response, 200, { ok: false, reason: 'denied' })
      }
      return this.json(response, 200, {
        ok: true,
        pending: true,
        checkAfterMs: PAIR_POLL_AFTER_MS
      })
    }

    // Public-access consent (design #3c). The disclaimer page itself and its
    // accept endpoint sit above the gate — the gate must not lock its own door.
    if (request.method === 'GET' && url.pathname === '/consent') {
      const next = url.searchParams.get('next')
      return this.html(
        response,
        pocketPages.renderConsentPage(this.locale(), {
          next: isSafeConsentNext(next) ? next : '/',
          nonce
        })
      )
    }

    if (request.method === 'POST' && url.pathname === '/consent/accept') {
      if (!this.verifyConsentOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      const bodyText = await readBody(request)
      let next = url.searchParams.get('next')
      try {
        const parsed = JSON.parse(bodyText)
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.next === 'string') {
          next = parsed.next
        }
      } catch {
        // A plain form submit arrives urlencoded; parse it as one.
        const form = new URLSearchParams(bodyText)
        if (form.has('next')) next = form.get('next')
      }
      // Open-redirect guard: only a same-origin path survives; everything else
      // (including `//evil` and `/\evil`) falls back to the app root.
      const target = isSafeConsentNext(next) ? next : '/'
      const secure = connectionMode === 'tunnel' ? '; Secure' : ''
      response.setHeader(
        'set-cookie',
        `${CONSENT_COOKIE}=1; Max-Age=${CONSENT_MAX_AGE_S}; Path=/; SameSite=Lax${secure}`
      )
      // Migrate the answer into the device registry: the cookie is origin-bound
      // and dies with the tunnel hostname, while the profile survives every
      // rotation — this one POST is what makes the next scan PIN-only.
      // 0.4.23：写侧口径与读侧 `devicePublicConsented` 对齐（UA 可算，不必等有会话）。
      // 原来这里要求「已有活会话」才写得进去，而真实顺序永远是**先同意须知、后输 PIN 配对**，
      // 那一刻还没有会话 ⇒ 答案从未落到档案上 ⇒ 每换一个隧道域名就重新问一遍、
      // 而 WebView 不存 cookie 时看起来就是死循环。
      const consentingFingerprint = this.liveMobileSession(request)?.fingerprint
        || deviceFingerprint(request.headers['user-agent'])
      const consentingProfile = this.deviceProfileMatch(consentingFingerprint, request.headers['user-agent'])
      if (consentingProfile !== undefined && typeof consentingProfile.publicConsentedAt !== 'number') {
        consentingProfile.publicConsentedAt = this.now()
        this.scheduleSessionPersist()
      }
      response.statusCode = 303
      response.setHeader('location', target)
      response.end()
      return
    }

    // Channel permission (device registry) is checked before the consent gate:
    // a device without a public-access grant gets its 403 whether or not it has
    // answered the disclaimer — the consent page must not become a step in front
    // of a refusal it cannot fix.
    if (this.devicePermissionBlocked(request, response, connectionMode)) return

    if (this.handleConsentGate(request, response, connectionMode, url)) return

    if (!this.authorized(request, remoteAddress, connectionMode)) {
      this.rememberMobileContext(request, remoteAddress, connectionMode)
      if (!this.authorized(request, remoteAddress, connectionMode)) {
        if (request.method === 'GET' && url.pathname === '/') {
          // M16: this is the unauthenticated landing of a request that came in
          // off the internal network. It used to be bounced across origins to
          // the carrier URL; now it gets the local page that says the same
          // thing, and the 401 text path below keeps its shape for everything
          // else.
          // The phone is here, so its content starts loading now, bridge-side.
          // "fresh" only when it presents no live session: a phone that already
          // paired once and is coming back is genuinely reconnecting, and the
          // "Connection lost" wording is the truth there. The first-ever visit
          // has lost nothing and must not be alarmed.
          this.prewarmMobileBoot('landing')
          const fresh = !this.mobileSessionActive(request)
          return this.html(response, renderMobileReconnectPage(this.locale(), connectionMode, { assets: this.mobileAssetBodies(this.locale()).urls, nonce, icon: this.iconDataUri, fresh }))
        }
        return this.text(response, 401, 'Pair your phone again.')
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      return this.json(response, 200, await this.buildStatusPayload(request))
    }
    if (request.method === 'POST' && url.pathname === '/api/mobile-probe') {
      // 滚动时序埋点的收口（0.4.25 起常设）。要答的问题模拟答不了：键盘收回时「视口变高 ⇒ 浏览器钳
      // scrollTop ⇒ 锚点复原再推回去」在真机上到底是一段还是两段运动；而手机看不到控制台，
      // 只能把时间线写回宿主的 pocket.log。页面侧只有 armed 时才发，默认零行为。
      // 只接受同源 + 已鉴权手机会话；正文限 4 KB，字符白名单不含换行（换行会伪造出第二行日志）。
      if (!this.verifySameOrigin(request)) {
        // 失败必须留痕：「点了却没数据」同时可能是「没 armed」「被拒」「真没动」，静默就永远分不开。
        this.log('warn', `probe refused device=${this.deviceTail(request)}: cross-site`)
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      const probeBody = await new Promise((resolve) => {
        let acc = ''
        request.setEncoding('utf8')
        request.on('data', (chunk) => { if (acc.length < 4096) acc += String(chunk).slice(0, 4096 - acc.length) })
        request.on('end', () => resolve(acc))
        request.on('error', () => resolve(''))
      })
      const safeProbe = String(probeBody).replace(/[^0-9A-Za-z|/@.:\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4096)
      if (!safeProbe) {
        this.log('warn', `probe dropped device=${this.deviceTail(request)}: 正文清洗后为空`)
        return this.json(response, 200, { ok: true, logged: false })
      }
      const probeNow = this.now()
      if (this.mobileProbeSeenAt !== undefined && probeNow - this.mobileProbeSeenAt < 800) {
        return this.json(response, 200, { ok: true, logged: false, throttled: true })
      }
      this.mobileProbeSeenAt = probeNow
      this.log('info', `kbprobe device=${this.deviceTail(request)} ${safeProbe}`)
      return this.json(response, 200, { ok: true, logged: true })
    }
    if (request.method === 'GET' && url.pathname === '/api/opened-at') {
      // The ledger's pull half (0.4.35). The POST below only pushes, and the
      // browser wipes localStorage whenever the quick tunnel hands out a new
      // hostname — every hostname is a new origin, and a new origin starts with
      // an empty ledger, which is why a hostname change used to light up every
      // row as unread. The bridge keeps this device's ledger by fingerprint
      // regardless of hostname, so the page reads its own history back here.
      // Same gates as the POST: same origin only, and the ledger returned is
      // ALWAYS the requesting device's — never another phone's.
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      return this.json(response, 200, { ok: true, openedAt: this.openedAtLedgerFor(request) })
    }
    if (request.method === 'POST' && url.pathname === '/api/opened-at') {
      // The read-ledger upload (0.4.33). The landing census counts
      // 「推进完了但消息还没有读」 bridge-side now, so each phone mirrors its
      // dsh-pocket-opened-at map here and gets it back filtered by its own
      // fingerprint at the next boot. Same contract as the probe route: same
      // origin only, authenticated by the mobile session, body capped, and a
      // hostile body is refused — never parsed into trust. The upload is the
      // full map, not a delta: it is idempotent, needs no ordering guarantees
      // over a flapping tunnel, and a phone that wiped its localStorage can
      // clear its ledger by uploading an empty one.
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      const raw = await new Promise((resolve) => {
        let acc = ''
        request.setEncoding('utf8')
        request.on('data', (chunk) => { if (acc.length < 65536) acc += String(chunk).slice(0, 65536 - acc.length) })
        request.on('end', () => resolve(acc))
        request.on('error', () => resolve(''))
      })
      let ledger = null
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
            parsed.openedAt && typeof parsed.openedAt === 'object' && !Array.isArray(parsed.openedAt)) {
          ledger = sanitizeOpenedAtLedger(parsed.openedAt, this.now())
        }
      } catch {
        ledger = null
      }
      if (ledger === null) {
        return this.json(response, 400, { ok: false, error: 'Malformed ledger.' })
      }
      const fingerprint = this.liveMobileSession(request)?.fingerprint
      if (!fingerprint) return this.json(response, 401, { ok: false, error: 'Pair your phone again.' })
      this.noteOpenedAtLedger(fingerprint, ledger)
      return this.json(response, 200, { ok: true, entries: Object.keys(ledger).length })
    }
    if (request.method === 'GET' && url.pathname === '/api/boot') {
      // The cold-open payload, and the exact bytes the handoff fetches as its
      // "syncing conversation" stage: the phone then opens the app document
      // (which no longer carries this payload) and paints from memory.
      try {
        const started = this.now()
        // Same shape as the document's payload: both cold-open paths ship the
        // full session list so the landing test answers them identically.
        const openedAt = this.openedAtLedgerFor(request)
        const payload = await this.buildMobileBoot({ openedAt })
        if (!payload) return this.json(response, 503, { ok: false, error: 'Boot unavailable.' })
        // The handoff stashes these exact bytes and the app document boots from
        // them, so the transport has to ride here too — otherwise the second cold
        // open repeats the wrong-transport first stream.
        payload.mode = this.requestConnectionMode(request, normalizeRemoteAddress(request.socket?.remoteAddress ?? ''))
        const bytes = Buffer.byteLength(JSON.stringify(payload))
        const bootMs = this.now() - started
        if (bootMs >= 300) this.log('info', `boot ${bootMs}ms bytes=${bytes}`)
        return this.json(response, 200, payload)
      } catch (error) {
        // The reason belongs in the log; the body stays generic, the same way
        // the bridge-wide 500 does (HEAD `6b6a8fa`). An error message here can
        // carry a Host path or a rejected RemoteError text.
        this.log('warn', `boot failed: ${error?.message || error}`)
        return this.json(response, 503, { ok: false, error: 'Boot failed.' })
      }
    }
    if (request.method === 'GET' && (url.pathname === '/app.css' || url.pathname === '/app.js')) {
      const locale = url.searchParams.get('l') === 'en' ? 'en' : 'zh'
      const assets = this.mobileAssetBodies(locale)
      const isScript = url.pathname === '/app.js'
      const body = isScript ? assets.js : assets.css
      // Content-addressed by the hash in the URL the page used: the name changes
      // whenever this file does, so a long lifetime can never serve stale code.
      // The page still re-fetches with a fresh query when the copy it got back
      // was mangled — the phone has done that to a cached document before.
      response.statusCode = 200
      response.setHeader('content-type', isScript ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8')
      response.setHeader('cache-control', 'private, max-age=604800')
      response.end(body)
      return
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return this.renderMobilePage(request, response, nonce)
    }
    if (request.method === 'GET' && url.pathname === '/api/session-attachment') {
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      const sessionId = url.searchParams.get('sessionId')
      const attachmentId = url.searchParams.get('attachmentId')
      if (!sessionId || !attachmentId) return this.text(response, 400, 'Session id and attachment id are required.')
      return this.streamSessionAttachment(response, sessionId, attachmentId)
    }
    if (request.method === 'GET' && url.pathname === '/api/session-file') {
      // Same gate shape as the attachment route above: pairing (the authorised()
      // wrapper this route sits behind) plus the same-origin check. The path
      // argument is authorised against this session's known-path set inside
      // streamSessionFile — the route only refuses malformed requests here.
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      const sessionId = url.searchParams.get('sessionId')
      const filePath = url.searchParams.get('path')
      if (!sessionId || !filePath) return this.text(response, 400, 'Session id and path are required.')
      return this.streamSessionFile(response, sessionId, filePath)
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/api/session-export') {
      if (!this.verifySameOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) return this.text(response, 400, 'Session id is required.')
      return this.streamSessionExport(request, response, sessionId)
    }
    if (request.method === 'GET' && url.pathname === '/api/session/stream') {
      if (!this.verifyTrustedOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) return this.text(response, 400, 'Session id is required.')
      // `sinceSeq` says how far the phone's own copy already reaches (the
      // handoff payload): the opening snapshot then only carries newer records.
      const sinceParam = url.searchParams.get('sinceSeq')
      const sinceSeq = sinceParam === null ? -1 : Number(sinceParam)
      // A subagent child session is only readable through its durable parent
      // address; both query values travel verbatim to the Host, which re-checks
      // the pair against the child's own descriptor. Absent = ordinary session.
      const parentParam = url.searchParams.get('parentSessionId')
      const modeParam = url.searchParams.get('mode')
      const subagent = parentParam && modeParam ? { parentSessionId: parentParam, mode: modeParam } : null
      return this.streamSession(request, response, sessionId, Number.isFinite(sinceSeq) && sinceSeq >= 0 ? sinceSeq : -1, subagent)
    }
    if (request.method === 'GET' && url.pathname === '/api/session/events') {
      // Same gate trio as the stream route above — trusted origin, pairing
      // (inherited from the authorized() check this route sits behind), and
      // (in tunnel mode) the consent gate further up. Polling is the tunnel
      // fallback for the SSE stream, so it rides the identical security shape.
      if (!this.verifyTrustedOrigin(request)) {
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) return this.text(response, 400, 'Session id is required.')
      const sinceParam = url.searchParams.get('sinceSeq')
      const sinceSeq = sinceParam === null ? -1 : Number(sinceParam)
      // Same subagent pair as the stream route above; the tunnel-mode collector
      // needs the durable address exactly as much as the SSE leg does.
      const parentParam = url.searchParams.get('parentSessionId')
      const modeParam = url.searchParams.get('mode')
      const subagent = parentParam && modeParam ? { parentSessionId: parentParam, mode: modeParam } : null
      return this.sessionEvents(request, response, sessionId, Number.isFinite(sinceSeq) && sinceSeq >= 0 ? sinceSeq : -1, subagent)
    }
    if (request.method === 'POST' && url.pathname === '/api/rpc') {
      // One URL carries every mobile method, so every failure note on this route
      // names the method, the session, the handset and one per-request id: with
      // only `request POST /api/rpc failed` on disk there is no way to tie a
      // phone's complaint back to a call (X4②). No status code and no access
      // decision changes here — this is the log half of the audit only.
      const rpcTrace = randomUUID().slice(0, 8)
      const rpcDevice = this.deviceTail(request)
      if (!this.verifySameOrigin(request)) {
        this.log('warn', `rpc refused trace=${rpcTrace} device=${rpcDevice}: cross-site`)
        return this.json(response, 403, { ok: false, error: 'Cross-site request rejected.' })
      }
      // Read under a ceiling resolved from the method the stream has already
      // revealed. The old form always took the large tier (25 MB × 1.4) into
      // memory first and only applied the per-method limit after parsing, so one
      // normal call could make the desktop buffer and concat a full upload.
      /** @type {string} */
      let body
      try {
        body = await readRpcBody(request)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === BODY_TOO_LARGE) {
          // The client is usually still mid-write. Drain the rest at the socket
          // layer — the bytes are discarded, never concatenated — so the 413
          // reaches it instead of the connection being reset on the way out.
          // Closing early here would RST a peer that still has data to send.
          // The named method and ceiling are what turn "the phone says the
          // picture vanished" into one line of diagnosis: a body the method's
          // tier can never carry, versus an upload that was cut short. `-` means
          // that field was not observable on this path (a refusal on the
          // declared Content-Length happens before any method is read).
          const observed = typeof error?.observedBytes === 'number' ? error.observedBytes : '-'
          const declaredSize = typeof error?.declaredBytes === 'number' ? error.declaredBytes : '-'
          const method = typeof error?.method === 'string' ? error.method : '-'
          const ceiling = typeof error?.ceiling === 'number' ? error.ceiling : '-'
          this.log(
            'warn',
            `rpc body refused trace=${rpcTrace} device=${rpcDevice} bytes=${String(observed)} declared=${String(declaredSize)} method=${method} ceiling=${String(ceiling)}: ${message}`
          )
          request.resume()
          return this.json(response, 413, { ok: false, error: BODY_TOO_LARGE })
        }
        throw error
      }
      let input
      try {
        input = JSON.parse(body)
      } catch {
        this.log('warn', `rpc envelope unreadable trace=${rpcTrace} device=${rpcDevice}`)
        return this.json(response, 400, { ok: false, error: 'Malformed request body.' })
      }
      if (!isRecord(input)) {
        this.log('warn', `rpc envelope unreadable trace=${rpcTrace} device=${rpcDevice}`)
        return this.json(response, 400, { ok: false, error: 'Malformed request body.' })
      }
      const rpcName = LanMobileBridge.safeName(input.method ?? 'missing')
      const rpcSession = isRecord(input.payload)
        ? LanMobileBridge.safeName(input.payload.sessionId ?? '-', 64)
        : '-'
      if (typeof input.method === 'string' && Buffer.byteLength(body, 'utf8') > bodyLimitForMethod(input.method)) {
        this.log('warn', `rpc body over method ceiling trace=${rpcTrace} method=${rpcName} device=${rpcDevice}`)
        return this.json(response, 413, { ok: false, error: 'Request body is too large.' })
      }
      // Bad input is answered 400 and never reaches the bridge-wide 500. The
      // validators below throw (they are shared with the mux question path), so
      // their fixed messages are collected here rather than allowed to surface
      // as an internal error.
      try {
        if (input.method === 'interaction.pending') {
          const sessionId = requiredStringField(input.payload, 'sessionId')
          return this.json(response, 200, { ok: true, value: this.pendingQuestionFor(sessionId) })
        }
        if (input.method === 'interaction.answer') {
          const answer = parseQuestionResponse(input.payload)
          const pending = this.assertPendingQuestion(answer.rpcId, answer.sessionId)
          validateQuestionAnswers(pending, answer.answers)
          const result = await this.respondToQuestion(answer.rpcId, {
            kind: 'result',
            value: { answers: answer.answers }
          })
          if (!result.ok) this.log('warn', `rpc failed trace=${rpcTrace} method=${rpcName} session=${rpcSession} device=${rpcDevice} class=question`)
          return this.json(response, result.ok ? 200 : 400, result)
        }
        if (input.method === 'interaction.cancel') {
          const rpcId = requiredStringField(input.payload, 'rpcId')
          const sessionId = requiredStringField(input.payload, 'sessionId')
          this.assertPendingQuestion(rpcId, sessionId)
          const result = await this.respondToQuestion(rpcId, {
            kind: 'rejected',
            error: {
              name: 'Error',
              message: 'the user closed this question request',
              code: 'cancelled'
            }
          })
          if (!result.ok) this.log('warn', `rpc failed trace=${rpcTrace} method=${rpcName} session=${rpcSession} device=${rpcDevice} class=question`)
          return this.json(response, result.ok ? 200 : 400, result)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log('warn', `rpc input rejected trace=${rpcTrace} method=${rpcName} session=${rpcSession} device=${rpcDevice}: ${message}`)
        return this.json(response, 400, { ok: false, error: message })
      }
      if (typeof input.method !== 'string' || !RPC_ALLOWLIST.has(input.method)) {
        this.log('warn', `rpc method refused trace=${rpcTrace} method=${rpcName} device=${rpcDevice}`)
        return this.json(response, 403, { ok: false, error: 'RPC method is not available on mobile.' })
      }
      const result = await this.forwardRpc(input.method, input.payload ?? {})
      if (result.ok) return this.json(response, 200, result)
      // The attributable line: which call, against which session, from which
      // handset, in which failure class. The class is a code, never the Host's
      // prose — that prose can quote what the Host was given.
      const rpcClass = LanMobileBridge.safeName(result.errorCode ?? 'host-rejection', 64)
      this.log('warn', `rpc failed trace=${rpcTrace} method=${rpcName} session=${rpcSession} device=${rpcDevice} class=${rpcClass}`)
      // A transport-shaped failure is nobody's bad request: the Host was not
      // reachable, did not answer, or answered with something unreadable. It
      // used to leave as a 400, which told the phone its own call was wrong and
      // matched neither this route nor the export path's 502.
      if (typeof result.errorCode === 'string' && TRANSPORT_ERROR_CODES.has(result.errorCode)) {
        return this.json(response, 502, {
          ok: false,
          error: result.error || 'Harness is not reachable.',
          errorCode: result.errorCode
        })
      }
      return this.json(response, 400, result)
    }
    this.text(response, 404, 'Not found.')
  }

  /** @returns {'en' | 'zh'} */
  locale() {
    const value = this.options.locale
    return typeof value === 'function' ? value() : value ?? 'en'
  }

  /**
   * @param {string | null} candidate
   * @returns {boolean}
   */
  validPairingToken(candidate) {
    if (!candidate || !this.pairingToken || !this.pairingExpiresAt) return false
    if (this.now() > this.pairingExpiresAt) return false
    const left = Buffer.from(candidate)
    const right = Buffer.from(this.pairingToken)
    return left.length === right.length && timingSafeEqual(left, right)
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {string} remoteAddress
   * @param {MobileConnectionMode} connectionMode
   * @returns {boolean}
   */
  authorized(request, remoteAddress, connectionMode) {
    const token = this.mobileToken(request)
    if (token) {
      let record = this.sessions.get(token)
      if (record !== undefined) {
        if (record.expiresAt !== undefined && record.expiresAt <= this.now()) {
          this.sessions.delete(token)
          record = undefined
        } else {
          this.noteDeviceSeen(record)
          this.touchDevice(this.sessions, token)
          return true
        }
      }
      // A restart parks sessions instead of restoring them counted, but the
      // phone still holds a perfectly valid 30-day cookie for one of them.
      // Resuming exactly that parked token here keeps the pairing seamless
      // across a restart — narrower than the old restore: nothing the user
      // explicitly disconnected (no mark, see /desktop/disconnect) revives on
      // its own, and on the tunnel nothing revives at all.
      const parked = this.resumableSessions.get(token)
      if (record === undefined && parked !== undefined && parked.parkedByRestart === true) {
        if (parked.expiresAt === undefined || parked.expiresAt > this.now()) {
          this.resumableSessions.delete(token)
          this.suspendedSessions.delete(token)
          this.capDeviceMap(this.sessions, token)
          this.sessions.set(token, parked)
          this.noteDeviceSeen(parked)
          return true
        }
        this.resumableSessions.delete(token)
        this.suspendedSessions.delete(token)
      }
    }
    // Never an address-based shortcut on the tunnel: the address there is the
    // carrier's shared egress, so it names a whole cell of phones, not one.
    if (connectionMode === 'tunnel') return false
    // The LAN shortcut, in its narrowest honest form: the handset that just
    // proved itself with a cookie from this address, still carrying the same
    // User-Agent fingerprint. It used to be "this address has a session" — no
    // credential, no device match, no clock — which was a 30-day grant to
    // whichever process happened to share the IP (another browser on the same
    // machine, or anything behind the same NAT once the port was reachable).
    // The cookie path above is untouched, so the deliberate LAN convenience —
    // reviving a paired phone from its own cookie — behaves exactly as before.
    const fingerprint = this.deviceFingerprintOf(request)
    const since = this.now() - LAN_ADDRESS_WINDOW_MS
    return [...this.sessions.values()].some(
      (session) =>
        session.remoteAddress === remoteAddress &&
        session.fingerprint === fingerprint &&
        session.lastSeenAt !== undefined &&
        session.lastSeenAt >= since
    )
  }

  /**
   * Branding is served to the two surfaces that legitimately render it before a
   * phone exists: a paired handset's own cookie, and the desktop pairing window
   * (which reaches it either directly over loopback or through the host's
   * app-origin proxy, both of which carry `dsh_desktop`). Anyone else is told
   * to pair — `/sw.js` stays public, and none of this touches the cache headers
   * these routes already send.
   * @param {import('node:http').IncomingMessage} request
   * @param {string} remoteAddress
   * @param {MobileConnectionMode} connectionMode
   * @returns {boolean}
   */
  canReadBranding(request, remoteAddress, connectionMode) {
    if (this.authorized(request, remoteAddress, connectionMode)) return true
    const transportAddress = normalizeRemoteAddress(request.socket?.remoteAddress ?? '')
    return isLoopbackAddress(transportAddress) && this.hasDesktopSession(request)
  }

  /**
   * Lazy cleanup of aged-out mobile sessions. Invoked where sessions are
   * issued and where status is read, so expired records neither authorize
   * requests nor appear as connected devices.
   * @returns {void}
   */
  sweepExpiredSessions() {
    const now = this.now()
    for (const [token, session] of this.sessions) {
      if (session.expiresAt !== undefined && session.expiresAt <= now) this.sessions.delete(token)
    }
    for (const [token, session] of this.suspendedSessions) {
      if (session.expiresAt !== undefined && session.expiresAt <= now) this.suspendedSessions.delete(token)
    }
    for (const [token, session] of this.resumableSessions) {
      if (session.expiresAt !== undefined && session.expiresAt <= now) this.resumableSessions.delete(token)
    }
    // Device profiles age on the same beat: a profile past its credential
    // expiry stops answering the PIN-restore match (deviceProfileMatch also
    // self-defends; this is the bulk sweep that keeps the desktop list honest).
    for (const [fingerprint, profile] of this.devices) {
      if (profile.expiresAt !== undefined && profile.expiresAt <= now) this.devices.delete(fingerprint)
    }
    // Pending pairing confirmations age out on the same beat (design #4a):
    // an unanswered PIN approval is worth nothing after its TTL either.
    this.sweepPendingPairings()
    // The PIN-failure map is keyed by an address this bridge never chose, so it
    // ages on the same beat as the sessions it protects: empty buckets first,
    // then the oldest keys if a guesser keeps minting new ones.
    this.capFailureKeys()
    // The history cursors are keyed by conversation ids this bridge never chose
    // either, and they used to be the one map on this class that only ever grew:
    // written on every read, deleted by nothing but `stop()`. Same beat, same
    // bound — the ceiling, not an expiry (see SESSION_CURSOR_MAX).
    this.capSessionCursors()
  }

  /**
   * Evict the least recently used entry of a device-state map before inserting
   * a new token, mirroring the suspendedSessions cap so sessions/resumableSessions
   * never grow past {@link DEVICE_MAP_CAP} either.
   * @param {Map<string, MobileSession>} map
   * @param {string} incomingToken
   * @returns {void}
   */
  capDeviceMap(map, incomingToken) {
    if (!map.has(incomingToken) && map.size >= DEVICE_MAP_CAP) {
      const oldest = map.keys().next().value
      if (oldest) map.delete(oldest)
    }
  }

  /**
   * Mark a token as the most recently used entry of a device map by re-inserting
   * it. Map iteration order is insertion order, so without this the cap evicted
   * purely by age: sixteen re-pairs later, the one handset that was actually in
   * use every minute was the next thing thrown out.
   * @param {Map<string, MobileSession>} map
   * @param {string} token
   * @returns {void}
   */
  touchDevice(map, token) {
    const session = map.get(token)
    if (session === undefined) return
    map.delete(token)
    map.set(token, session)
  }

  /**
   * The remembered history cursor for one conversation.
   *
   * Reading is also a touch: insertion order is the eviction order, so without
   * the re-insert the conversation the phone is actually paging through would be
   * the first thing thrown out once the ceiling was reached — the same failure
   * `touchDevice` was written for.
   * @param {string} sessionId
   * @returns {number | undefined}
   */
  sessionCursor(sessionId) {
    const throughSeq = this._sessionCursors?.get(sessionId)
    if (typeof throughSeq !== 'number') return undefined
    this._sessionCursors.delete(sessionId)
    this._sessionCursors.set(sessionId, throughSeq)
    return throughSeq
  }

  /**
   * Remember one conversation's history cursor inside the ceiling.
   * @param {string} sessionId
   * @param {number} throughSeq
   * @returns {void}
   */
  rememberSessionCursor(sessionId, throughSeq) {
    if (!this._sessionCursors) this._sessionCursors = new Map()
    this._sessionCursors.delete(sessionId)
    this._sessionCursors.set(sessionId, throughSeq)
    this.capSessionCursors()
  }

  /**
   * Trim the cursor cache to {@link SESSION_CURSOR_MAX}, least recently read first.
   * @returns {void}
   */
  capSessionCursors() {
    while (this._sessionCursors !== undefined && this._sessionCursors.size > SESSION_CURSOR_MAX) {
      const oldest = this._sessionCursors.keys().next().value
      if (oldest === undefined) return
      this._sessionCursors.delete(oldest)
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @returns {string | undefined}
   */
  mobileToken(request) {
    return this.cookieValue(request, 'dsh_mobile')
  }

  /**
   * Restores one session the desktop disconnect suspended. Cookies that
   * `rememberMobileContext` recorded from an anonymous request are not eligible,
   * so a neighbor cannot mint a cookie and reconnect.
   * @param {import('node:http').IncomingMessage} request
   * @returns {boolean}
   */
  resumeSuspendedMobileSession(request) {
    const token = this.mobileToken(request)
    if (!token) return false
    const session = this.resumableSessions.get(token)
    if (!session) return false
    this.resumableSessions.delete(token)
    this.suspendedSessions.delete(token)
    this.capDeviceMap(this.sessions, token)
    this.sessions.set(token, session)
    this.noteDeviceSeen(session)
    return true
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @returns {boolean}
   */
  mobileSessionActive(request) {
    const token = this.mobileToken(request)
    if (!token || !this.sessions.has(token)) return false
    this.touchDevice(this.sessions, token)
    this.noteDeviceSeen(this.sessions.get(token))
    return true
  }

  /**
   * Take note of a phone that showed up on a LAN address without being
   * authorized yet.
   *
   * This never grants anything, and never used to be able to — until it wrote an
   * arbitrary, merely well-shaped `dsh_mobile` value straight into `sessions`
   * with a full 30-day expiry whenever the address already held a live session.
   * Any other process on that address (or anyone sharing its NAT egress) could
   * then present a cookie it had invented and be the paired device. Only tokens
   * the desktop has actually issued — and that a disconnect parked — are tracked
   * here, and only so their revival window stays honest.
   * @param {import('node:http').IncomingMessage} request
   * @param {string} remoteAddress
   * @param {MobileConnectionMode} connectionMode
   */
  rememberMobileContext(request, remoteAddress, connectionMode) {
    if (connectionMode === 'tunnel') return
    const token = this.mobileToken(request)
    if (!token) return
    const known = this.resumableSessions.get(token) ?? this.suspendedSessions.get(token)
    if (!known) return
    known.lastSeenAt = this.now()
    this.touchDevice(this.suspendedSessions, token)
    this.touchDevice(this.resumableSessions, token)
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {string} transportAddress
   * @param {import('node:http').ServerResponse} response
   * @returns {boolean}
   */
  rejectUnlessDesktop(request, transportAddress, response) {
    if (isLoopbackAddress(transportAddress) && this.hasDesktopSession(request)) return false
    this.text(response, 403, 'Desktop only.')
    return true
  }

  /**
   * @param {string | null} candidate
   * @param {string} transportAddress
   * @param {import('node:http').ServerResponse} response
   * @returns {boolean}
   */
  consumeDesktopBootstrap(candidate, transportAddress, response) {
    const expected = this.desktopBootstrapToken
    if (
      !isLoopbackAddress(transportAddress) ||
      !candidate ||
      !expected ||
      this.desktopBootstrapExpiresAt === undefined ||
      this.desktopBootstrapExpiresAt <= this.now() ||
      !this.pinsEqual(candidate, expected)
    ) {
      this.text(response, 403, 'Desktop only.')
      return false
    }
    this.desktopBootstrapToken = undefined
    this.desktopBootstrapExpiresAt = undefined
    // Bounded by Max-Age, and marked Secure on any non-loopback hop: this
    // cookie alone opens mode switching, PIN reset and disconnect.
    response.setHeader(
      'set-cookie',
      `dsh_desktop=${this.desktopSessionToken}; ${desktopCookieAttributes(transportAddress)}`
    )
    response.statusCode = 303
    response.setHeader('location', '/desktop')
    response.end()
    return true
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @returns {boolean}
   */
  hasDesktopSession(request) {
    const token = this.cookieValue(request, 'dsh_desktop')
    return Boolean(token && this.pinsEqual(token, this.desktopSessionToken))
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {string} name
   * @returns {string | undefined}
   */
  cookieValue(request, name) {
    const cookie = request.headers.cookie ?? ''
    return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie)?.[1]
  }

  /**
   * Named "same origin" but the check underneath is the lenient one
   * (verifyTrustedOrigin): Fetch-Metadata site values plus an Origin/Host
   * comparison, not a strict same-origin equivalence. Kept for its call sites.
   * @param {import('node:http').IncomingMessage} request
   * @returns {boolean}
   */
  verifySameOrigin(request) {
    return this.verifyTrustedOrigin(request)
  }

  /**
   * The consent accept is the one POST with no CSRF payoff: a forged submission
   * can only set the disclaimer cookie on a browser that never saw the page —
   * a favour, not an attack. Phone browsers in the wild (a Huawei build, live
   * 2026-10-05) answer this plain form POST with a Fetch-Metadata site value
   * stricter than same-origin, so the strict check between pairing and the app
   * surfaced as a bare JSON 403. Only an explicitly cross-site submission is
   * refused; everything else may through — there is no credential here to ride.
   * @param {import('node:http').IncomingMessage} request
   * @returns {boolean}
   */
  verifyConsentOrigin(request) {
    return firstHeaderValue(request.headers['sec-fetch-site']) !== 'cross-site'
  }

  /**
   * Rejects browser-driven cross-site requests (CSRF / drive-by) against the
   * loopback-only desktop surface. The pairing window's own navigations and
   * same-origin fetches pass; requests without Fetch Metadata and Origin
   * headers (local tooling, tests) pass as well. Returns false instead of
   * throwing so callers can answer 403 (a throw would surface as 500).
   * @param {import('node:http').IncomingMessage} request
   * @returns {boolean}
   */
  verifyTrustedOrigin(request) {
    const site = firstHeaderValue(request.headers['sec-fetch-site'])
    if (site && site !== 'same-origin' && site !== 'none') {
      // A refused POST used to leave nothing on disk: the phone showed the bare
      // 403 body and the log had no line to grep. These are hostnames, never
      // credentials, so naming them is safe and is the whole point.
      this.log('warn', `cross-site refused: fetch-site=${LanMobileBridge.safeName(site, 24)} origin-host=${LanMobileBridge.safeName(this.originHostOf(request) ?? '-', 96)} host=${LanMobileBridge.safeName(this.requestHostOf(request), 96)}`)
      return false
    }
    const origin = firstHeaderValue(request.headers.origin)
    const host = firstHeaderValue(request.headers.host)
    if (origin && host) {
      let originHost
      try {
        originHost = new URL(origin).host
      } catch {
        this.log('warn', `cross-site refused: origin unparseable origin=${LanMobileBridge.safeName(origin, 96)}`)
        return false
      }
      if (originHost !== host) {
        this.log('warn', `cross-site refused: origin mismatch origin-host=${LanMobileBridge.safeName(originHost, 96)} host=${LanMobileBridge.safeName(host, 96)}`)
        return false
      }
    }
    return true
  }

  /** @param {import('node:http').IncomingMessage} request @returns {string | undefined} */
  originHostOf(request) {
    const origin = firstHeaderValue(request.headers.origin)
    if (!origin) return undefined
    try {
      return new URL(origin).host
    } catch {
      return origin
    }
  }

  /** @param {import('node:http').IncomingMessage} request @returns {string} */
  requestHostOf(request) {
    return firstHeaderValue(request.headers.host) ?? '-'
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {string} transportAddress
   * @returns {MobileConnectionMode}
   */
  requestConnectionMode(request, transportAddress) {
    if (!isLoopbackAddress(transportAddress)) return 'lan'
    const host = (request.headers.host ?? '').split(':', 1)[0]?.toLowerCase() ?? ''
    const forwardedAddress = firstHeaderValue(request.headers['cf-connecting-ip'])
    const ray = firstHeaderValue(request.headers['cf-ray'])
    return isInternetTunnelHost(host) || Boolean(forwardedAddress && ray)
      ? 'tunnel'
      : 'lan'
  }

  /**
   * @param {URL} url
   * @param {MobileConnectionMode} connectionMode
   * @returns {string | undefined}
   */
  tunnelMigrationUrl(url, connectionMode) {
    if (connectionMode === 'tunnel' || !this.tunnelActive || !this.tunnelInstance?.url) return undefined
    return new URL(`${url.pathname}${url.search}`, this.tunnelInstance.url).toString()
  }

  /**
   * Call the Host with the process session cookie, re-requesting the
   * credential once and retrying once if the stored cookie stopped being accepted.
   * @param {URL} url
   * @param {RequestInit} init
   * @returns {Promise<Response>}
   */
  async harnessFetch(url, init) {
    // Every inner call goes out as JSON, GET included. The Host's `/api` surface
    // is a json-wire Remote gateway, and a body-less GET that declared no
    // content type was the one request on this path that left the bridge without
    // it — the same endpoint answered differently depending on whether the caller
    // remembered to set the header (REPO handoff: inner-auth end-to-end coverage
    // found zero tests on that invariant). Set here, once, so no call site can
    // forget it; a call site that declared its own type keeps its declaration.
    const headers = { ...(init.headers ?? {}) }
    const declared = Object.keys(headers).find((name) => name.toLowerCase() === 'content-type')
    if (declared === undefined) headers['content-type'] = 'application/json'
    const send = async (cookie) => fetch(url, {
      ...init,
      headers: { ...headers, ...(cookie === undefined ? {} : { cookie }) }
    })
    let response = await send(await this.options.innerAuth.ready())
    if (response.status === 401) {
      this.options.innerAuth.invalidate()
      this.cycleMux()
      const retry = await this.options.innerAuth.ready()
      if (retry !== undefined) {
        // This answer is being replaced, and nothing else can ever reach it. An
        // unread body holds its connection until the stream is collected, so the
        // discarded 401 is released here. When there is no credential to retry
        // with, this same response IS the answer, and its body belongs to the
        // caller — which is why the release is inside the branch and not above it.
        void response.body?.cancel()
        response = await send(retry)
      }
    }
    return response
  }

  /**
   * Close the live mux socket after the harness credential was invalidated so
   * it cannot keep carrying the dead cookie. Aborting the monitor also ends
   * its loop; once the task settles, syncConnected re-arms it (when a phone is
   * still paired) and the new socket opens with the fresh cookie.
   * @returns {void}
   */
  cycleMux() {
    const task = this.muxTask
    this.muxAbort?.abort()
    if (task === undefined) return
    task.finally(() => {
      if (this.server !== undefined) this.syncConnected()
    }).catch(() => undefined)
  }

  /**
   * The phone's static shell (CSS + the app script) with content hashes.
   *
   * @param {string} locale
   */
  mobileAssetBodies(locale) {
    if (!this._mobileAssets) this._mobileAssets = new Map()
    const cached = this._mobileAssets.get(locale)
    if (cached) return cached
    const blocks = mobilePageAssets({ locale })
    const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12)
    const assets = {
      css: blocks.css,
      js: blocks.js,
      urls: {
        cssUrl: `/app.css?h=${digest(blocks.css)}`,
        jsUrl: `/app.js?l=${locale}&h=${digest(blocks.js)}`
      }
    }
    this._mobileAssets.set(locale, assets)
    return assets
  }

  /**
   * The current shell's build identity: the CSS and the app script together.
   *
   * The service worker's cache name is derived from this, so a rebuilt shell
   * can never be served out of the previous build's cache. It must not include
   * the document's boot payload, which changes on every open.
   *
   * @returns {string}
   */
  shellBuild() {
    const { css, js } = mobilePageAssets({ locale: this.locale() })
    return createHash('sha256').update(css).update('\u0000').update(js).digest('hex').slice(0, 12)
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {string} nonce
   */
  async renderMobilePage(request, response, nonce) {
    // Piggyback the startup data onto the HTML response. Both reads stay on the
    // desktop loopback (fast); folding them in removes one whole tunnel round
    // trip before the phone can choose and open its focus session.
    let boot = null
    let payload = null
    // The landing is ALWAYS the workspace page (user 2026-10-12: 「默认点链接就进主
    // 页面」— the retired initialChat first-byte jump used to open a conversation
    // the reader never chose, and the pairing-handoff variant of it left a single
    // history entry so the edge swipe exited the app). The boot payload still rides
    // the document: the full session list is what makes the landing
    // complete from the first byte.
    try {
      const openedAt = this.openedAtLedgerFor(request)
      payload = await this.buildMobileBoot({ history: false, openedAt })
      if (payload) {
        // The document must know which transport it is on BEFORE it opens its
        // first realtime channel. `connectionMode` on the phone starts as 'lan'
        // and was only corrected by the first `/api/status` reply seconds later,
        // so a tunnel session opened an EventSource that a quick tunnel cannot
        // carry, sat on it until the ~30s teardown, and painted from the 900ms
        // history fallback instead of from the stream. Same detection the router
        // and the status payload already run.
        payload.mode = this.requestConnectionMode(request, normalizeRemoteAddress(request.socket?.remoteAddress ?? ''))
        boot = JSON.stringify(payload)
      }
    } catch (error) {
      this.log('warn', `mobile boot data unavailable: ${error?.message || error}`)
    }
    // The app document is only ever rendered for a paired phone, so its icon can
    // be a cached URL: `/app-icon` sits behind the same branding gate the document
    // itself passed, and the bytes live in the phone's image cache for 24h. The
    // recovery and PIN pages are the opposite case (an unpaired phone renders them
    // and cannot read a gated route), so those keep inlining the data URI.
    const icon = this.iconUiBytes ? '/app-icon?ui=1' : this.iconDataUri
    const html = renderMobilePage({ locale: this.locale(), boot, icon, initialChat: false, assets: this.mobileAssetBodies(this.locale()).urls, nonce })
    const ledgerSize = Object.keys(this.openedAtLedgerFor(request)).length
    this.log('info', `doc url=${String(request.url || '/')} bytes=${Buffer.byteLength(html)} boot=${payload ? 'embedded' : 'none'} ledger=${ledgerSize}`)
    // Never cacheable, and never compressed at the origin. 2026-10-01 cost two
    // broken rounds: a `max-age` window made the phone render a mangled copy the
    // browser replayed for the landing navigation, and origin gzip made it render
    // compressed bytes as text. Both dials stay off; the conversation payload now
    // travels through /api/boot and the tab's own memory instead.
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-pocket-cache', 'app')
    return this.html(response, html)
  }

  // Build the cold-open payload: workspace snapshot, session list and desktop
  // settings. Shared by the embedded HTML boot and /api/boot, which lets a
  // service-worker-cached shell reconcile in the background without waiting for
  // a full page download over the tunnel.
  //
  // The boot payload carries the rows the landing actually paints (pinned+24h)
  // so the first paint is still the final paint, plus the full catalogue in
  // `partial` for「更多」. See BOOT_RECENT_WINDOW_MS above.
  async buildMobileBoot(options = {}) {
    const t0 = this.now()
    const [wsResult, sessResult, settingsResult] = await Promise.all([
      Promise.resolve(isWorkspaceSnapshot(this.workspaceSnapshot)
        ? { ok: true, value: this.workspaceSnapshot }
        : { ok: false }),
      this.cachedSessionList(false, { staleOk: true }),
      this.cachedSettings(false).catch(() => ({ ok: false }))
    ])
    if (!wsResult.ok || !sessResult.ok) return null
    const awaiting = new Set(
      [...this.pendingQuestions.values()]
        .map((item) => item.sessionId)
        .filter((sessionId) => typeof sessionId === 'string')
    )
    const rawItems = Array.isArray(sessResult.value?.items)
      ? applyDescendantRunning(sessResult.value.items)
      : []
    // The bridge's own error tally rides on AFTER compaction: the host rows
    // carry no error field at all, so the follow streams are the only source,
    // and `compactSessionRows` keeps nothing it did not receive from the host.
    const rows = withSessionErrors(this, compactSessionRows(rawItems)).map((item) => ({
      ...item,
      awaitingQuestion: awaiting.has(item.sessionId)
    }))
    this.noteSavings('list', rawItems, rows)
    // `partial` keeps its old meaning — "the landing is about to get the full
    // catalogue in the background" — and here that is literally true: the
    // document ships only the rows the page paints on its own, the rest travel
    // alongside so「更多」pages through them without a round trip.
    const sess = {
      ...sessResult.value,
      items: bootVisibleRows(rows, wsResult.value, this.now()),
      partial: rows.length > 0
    }
    const settings = settingsResult.ok ? extractMobileSettings(settingsResult.value) : null
    return {
      ws: wsResult.value,
      sess,
      settings,
      // The hashed shell URLs travel with the payload, so the handoff can pull
      // the stylesheet and script into the phone's cache before it navigates —
      // otherwise the landing sat on an inert skeleton for one more tunnel round
      // trip (observed live 2026-10-01).
      assets: this.mobileAssetBodies(this.locale()).urls
    }
  }



  /**
   * One line per shape the history ladder tried (X4④).
   *
   * The ladder can burn three 30-second Host round trips while the phone's own
   * fetch gives up at 12s, and until now it wrote nothing: the operator saw a
   * timeout with no record of which shape ran, how long it took, or what came
   * back. The shape is described by the bounds it carried, never by content.
   * @param {'boot' | 'rpc'} stage
   * @param {number} index zero-based attempt index
   * @param {number} total attempts the ladder will make
   * @param {Record<string, unknown>} request the bounds sent to `session/page`
   * @param {number} ms elapsed for this attempt
   * @param {{ ok?: boolean, value?: unknown, error?: unknown } | undefined} page
   */
  noteHistoryAttempt(stage, index, total, request, ms, page) {
    const records = Array.isArray(page?.value?.records) ? page.value.records.length : -1
    const bounds = [
      typeof request.throughSeq === 'number' ? `throughSeq=${String(request.throughSeq)}` : 'throughSeq=none',
      typeof request.beforeSeq === 'number' ? `beforeSeq=${String(request.beforeSeq)}` : 'newest',
      `max=${String(request.maxMessages ?? '-')}`,
      request.turnWindow ? 'window' : 'plain',
    ].join(' ')
    const verdict = page?.ok !== true ? 'failed' : records < 0 ? 'shape-mismatch' : records === 0 ? 'empty' : 'ok'
    // An accepted first attempt on a fast Host is the overwhelmingly common
    // case and would only add noise to a file that caps at 512KB.
    if (verdict === 'ok' && index === 0 && ms < 1000) return
    this.log('info', `history attempt stage=${stage} n=${String(index + 1)}/${String(total)} ${bounds} ms=${String(ms)} records=${String(records)} verdict=${verdict}`)
  }

  /**
   * Shared, short-TTL cache of the Host session catalogue. Both `session.list`
   * and the history cursor lookup read one number from this same full list, so
   * polling history must not re-download the whole catalogue each time. A
   * missing cursor forces one refresh so freshly created sessions still load.
   *
   * @param {boolean} [force]
   * @param {{ staleOk?: boolean }} [options] `staleOk` lets the cold-open document
   *   answer from the last good catalogue while a fresh one is fetched behind the
   *   response; every other reader waits (or forces) for the truth.
   * @returns {Promise<{ ok: boolean, value?: any, error?: string }>}
   */
  async cachedSessionList(force = false, options = {}) {
    const now = Date.now()
    const cache = this._sessionListCache
    // A handoff runs verify -> workspace -> session list -> boot within a few
    // seconds of each other; a 10s window lets the boot build reuse the list the
    // previous stage just fetched instead of paying another ~550ms harness call.
    if (!force && cache && now - cache.at < 10000) return cache.promise
    // Stale-while-revalidate, asked for by the cold-open document only.
    // The Host call returns EVERY session of EVERY workspace (measured 2026-10-09:
    // 469 rows / ~195 KB / 465-719ms) and the document used to sit and wait for it
    // while keeping one row plus the total — `session/list` takes no filter and no
    // limit argument at all, so there is nothing cheaper to ask for. Standing the
    // last good catalogue in and re-fetching behind the response makes every open
    // but the first after a restart pay nothing. The stale window can only affect
    // which session auto-opens: the list view always fetches its own fresh rows.
    if (!force && options.staleOk && this.sessionListStaleUsable(now)) {
      const stale = this._sessionListValue
      this.fetchSessionListIntoCache(now)
      return Promise.resolve(stale.result)
    }
    return this.fetchSessionListIntoCache(now)
  }

  // A last good catalogue younger than this still names a session worth opening:
  // sessions are not created and abandoned by the minute, and the worst the stale
  // answer can do is auto-open the previous conversation. Beyond it the reader has
  // been away long enough that waiting for the truth is the better trade.
  sessionListStaleUsable(now) {
    const last = this._sessionListValue
    return !!(last && last.result?.ok && now - last.at < 120000)
  }

  fetchSessionList() {
    const promise = this.invokeHarness('session/list', { _request: {} })
    // Keep the last good value for the stale window: only a successful read may
    // stand in later, and a failed one must never poison it.
    promise.then((result) => {
      if (result && result.ok) this._sessionListValue = { at: Date.now(), result }
    }, () => {})
    return promise
  }

  fetchSessionListIntoCache(now) {
    const promise = this.fetchSessionList()
    this._sessionListCache = { at: now, promise }
    promise.catch(() => {})
    return promise
  }

  // --- the remote restart (0.4.34) ------------------------------------------
  // The phone home header's 重启宿主 button ends HERE, at arming the outsider.
  // DSH's whole process tree lives in one Windows Job Object, so nothing spawned
  // inside the host — this bridge included — can outlive it, and the only
  // reliable executioner is the Task Scheduler service. scripts/dsh-restart-now.ps1
  // packages exactly that: a one-shot DSH-ReviveOnce task firing in ~8s that
  // kills → relaunches → waits for ready → pushes 「Curiouser and curiouser!」 → deletes itself.
  // The button arms it and answers; the WeChat push is the only receipt.

  hostRestartScript() {
    return this.options.hostRestartScript || 'F:\\defws\\scripts\\dsh-restart-now.ps1'
  }

  requestHostRestart() {
    const invoker = this.options.hostRestartInvoker
    const script = this.hostRestartScript()
    if (typeof invoker === 'function') return Promise.resolve(invoker(script))
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true })
      let tail = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('restart script timed out after 15s'))
      }, 15000)
      child.stdout?.on('data', (chunk) => { tail = (tail + chunk).slice(-400) })
      child.stderr?.on('data', (chunk) => { tail = (tail + chunk).slice(-400) })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`restart script exited ${code}: ${tail.trim()}`))
      })
    })
  }

  /**
   * The restart guard's input: every session currently advancing, freshly read
   * (force — a destructive guard must not trust the 10s boot cache). Null means
   * the list could not be read and the caller must refuse rather than guess.
   * A wedged 「running」 row is deliberately NOT special-cased: the user ruled
   * (2026-10-12) that stuck sessions are ended by hand, not by this button.
   */
  async listBusySessions() {
    let result
    try {
      result = await this.cachedSessionList(true)
    } catch {
      return null
    }
    const rawItems = Array.isArray(result?.value?.items) ? applyDescendantRunning(result.value.items) : []
    return compactSessionRows(rawItems)
      .filter((item) => item && (item.running === true || item.descendantRunning === true))
      .map((item) => ({ sessionId: item.sessionId, title: this.sessionTitleOf(item), origin: item.origin }))
  }

  // The model catalogue is host-global and expensive (measured ~1.4s per call,
  // pocket.log 2026-10-13 01:22). The page used to pay it twice on every open of
  // the settings panel and again on every model switch, which is the whole of the
  // «好卡好卡好卡» report (0.4.36's walk-through). It is keyed to nothing — no
  // session, no workspace — so a single 30s-TTL cache serves every phone and
  // every panel, and the page's own refresh lands behind the paint as before.
  //
  // A model switch rewrites the catalogue's `current` and the host's global
  // default, so the write invalidates the cache rather than being written
  // through it: the next open re-reads and pays once, and no stale `current`
  // can outlive a switch.
  async cachedModelCatalog(force = false) {
    const now = this.now()
    const cache = this._modelCatalogCache
    if (!force && cache && now - cache.at < MODEL_CATALOG_TTL_MS) return cache.promise
    const promise = this.invokeHarness('session/modelCatalog', {})
    this._modelCatalogCache = { at: now, promise }
    promise.catch(() => {})
    return promise
  }

  invalidateModelCatalog() {
    this._modelCatalogCache = null
  }

  // Agent presets change only when the desktop edits them — far rarer than a
  // model switch. The settings panel pairs session.models with agentPreset.list
  // in one Promise.all; without a cache the preset fetch pays a tunnel round
  // trip on every open even when the catalogue is already warm.
  async cachedAgentPresets(force = false) {
    const now = this.now()
    const cache = this._agentPresetsCache
    if (!force && cache && now - cache.at < AGENT_PRESETS_TTL_MS) return cache.promise
    const promise = this.invokeHarness('agentPresets/list', {})
    this._agentPresetsCache = { at: now, promise }
    promise.catch(() => {})
    return promise
  }

  invalidateAgentPresets() {
    this._agentPresetsCache = null
  }

  // Drop the session-catalogue cache so the next reader re-reads the Host.
  // Both halves go: the promise window cachedSessionList() answers from, and
  // the last-good catalogue the stale-while-revalidate branch stands in with —
  // clearing only the first would delay the stale answer, not remove it.
  invalidateSessionList() {
    this._sessionListCache = null
    this._sessionListValue = undefined
  }

  // Settings change rarely; a longer TTL keeps the page's manual-refresh /
  // resume path from paying for settings on every pass while still picking up a
  // desktop-side change within a few seconds.
  async cachedSettings(force = false) {
    const now = Date.now()
    const cache = this._settingsCache
    if (!force && cache && now - cache.at < 5000) return cache.promise
    const promise = this.invokeHarness('settings/describe', {})
    this._settingsCache = { at: now, promise }
    promise.catch(() => {})
    return promise
  }

  /**
   * "内容预先加载好" (2026-10-10), bridge half. The connect page cannot read any
   * conversation data for a phone that has not paired yet — every content route is
   * pairing-gated by design, and that stays — so what can be moved off the critical
   * path is the BRIDGE's own cold read. A phone landing on the connect page, or a
   * tunnel that has just come up, puts the session catalogue and the settings
   * snapshot in flight here; by the time the PIN is verified the expensive Host read
   * is already done and `/api/boot` answers from the cache the handoff would have
   * waited for. Fire-and-forget, throttled, never awaited by a response.
   *
   * `staleOk` is the whole mechanism: a usable-but-older catalogue returns at once
   * and re-fetches behind it, and an in-flight read is shared, not doubled.
   *
   * @param {string} [trigger] named in the log line so a stampede is traceable
   */
  prewarmMobileBoot(trigger = 'page') {
    const now = this.now()
    if (this._prewarmAt !== undefined && now - this._prewarmAt < POCKET_PREWARM_MIN_MS) return
    this._prewarmAt = now
    const started = now
    Promise.all([
      this.cachedSessionList(false, { staleOk: true }).catch(() => {}),
      this.cachedSettings(false).catch(() => {}),
      this.cachedModelCatalog(false).catch(() => {}),
    ]).then(
      () => this.log('info', `prewarm trigger=${trigger} list=${this.now() - started}ms`),
      () => {}
    )
  }

  /**
   * Translate one mobile method onto its Host endpoint and drive it.
   *
   * `session.history` is the one call the page cannot express directly: the
   * Host replaced open-ended history reads with a cursor-bounded page, and
   * refuses a `throughSeq` past the session's own cursor. The cursor lives on
   * the session list row, so the read is two calls here rather than a
   * protocol the page has to learn.
   * @param {string} method
   * @param {unknown} payload
   * @returns {Promise<{ ok: boolean, value?: unknown, error?: string }>}
   */
  async forwardRpc(method, payload) {
    const fields = typeof payload === 'object' && payload !== null
      ? payload
      : {}

    if (method === 'workspace.list') {
      // The Host kept no unary workspace read: `workspace/follow` is a stream,
      // and its opening `baseline` frame is exactly the projection this call
      // used to return. The mux consumer keeps that baseline, so the answer is
      // whatever the carrier last observed.
      const snapshot = this.workspaceSnapshot
      if (!isWorkspaceSnapshot(snapshot)) return { ok: false, error: 'Harness workspaces are not loaded yet.' }
      return { ok: true, value: snapshot }
    }

    if (method === 'session.history') {
      const sessionId = fields.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { ok: false, error: 'sessionId must be a string.', errorCode: INVALID_ARGUMENTS_CODE }
      }
      // A subagent child is only readable through its durable parent address.
      // Both values are forwarded verbatim; the Host re-checks them against the
      // child's own descriptor, so a forged pair fails closed there
      // (`subagent/unauthorized`) exactly as an ordinary wrong id does.
      const subagentRaw = fields.subagent
      let subagent = null
      if (subagentRaw !== undefined && subagentRaw !== null) {
        const parentSessionId = subagentRaw && typeof subagentRaw === 'object' && typeof subagentRaw.parentSessionId === 'string'
          ? subagentRaw.parentSessionId
          : ''
        const mode = subagentRaw && typeof subagentRaw === 'object' && typeof subagentRaw.mode === 'string'
          ? subagentRaw.mode
          : ''
        if (!parentSessionId || !mode) {
          return { ok: false, error: 'subagent.parentSessionId and subagent.mode must be non-empty strings.', errorCode: INVALID_ARGUMENTS_CODE }
        }
        subagent = { parentSessionId, mode }
      }
      // Every paging knob below goes to the Host verbatim. They used to be
      // checked with `typeof x === 'number'` alone — which NaN, -1, 1e9 and
      // 1.5 all pass — so one RPC from a paired phone could ask the desktop to
      // serialise an unbounded page (and the third fallback widened it again
      // with `Math.max(maxMessages, 60)`).
      const maxMessagesArg = readNumericArgument(fields.maxMessages, {
        name: 'maxMessages',
        fallback: HISTORY_PAGE_DEFAULT_MESSAGES,
        max: HISTORY_PAGE_MAX_MESSAGES
      })
      if (!maxMessagesArg.ok) return { ok: false, error: maxMessagesArg.error, errorCode: INVALID_ARGUMENTS_CODE }
      const maxMessages = maxMessagesArg.value
      const beforeSeqArg = readNumericArgument(fields.beforeSeq, {
        name: 'beforeSeq',
        fallback: undefined,
        min: 0,
        max: SESSION_SEQ_MAX
      })
      if (!beforeSeqArg.ok) return { ok: false, error: beforeSeqArg.error, errorCode: INVALID_ARGUMENTS_CODE }
      const beforeSeq = beforeSeqArg.value
      // The Host's backwards-page cursor (throughSeq) only has to be a valid log
      // offset at or after the page we request. Once learned for a session it
      // stays valid for every older page, so cache it: pull-older never has to
      // re-download the global session list. The first open / RPC fallback still
      // resolves it from the list exactly once.
      let throughSeq = this.sessionCursor(sessionId)
      let projections = null
      if (typeof throughSeq !== 'number' || beforeSeq === undefined) {
        let listed = await this.cachedSessionList(false)
        if (!listed.ok) return listed
        let items = listed.value?.items ?? []
        let row = items.find((item) => item.sessionId === sessionId)
        // A fresh session may not be in the 1.5s-old cache yet: force one
        // refresh before giving up, rather than failing to open it.
        if (!row) {
          listed = await this.cachedSessionList(true)
          if (!listed.ok) return listed
          items = listed.value?.items ?? []
          row = items.find((item) => item.sessionId === sessionId)
        }
        projections = row?.projections
        throughSeq = projections?.asOfSeq
        if (typeof throughSeq !== 'number') return { ok: false, error: 'Harness has no cursor for this session.' }
        this.rememberSessionCursor(sessionId, throughSeq)
      }
      /** @type {Record<string, unknown>} */
      const baseRequest = { address: followAddressOf(sessionId, subagent), throughSeq }
      // One request shape per attempt, best first. 2026-10-01: the aligned
      // last-turn window can come back empty, and the phone then replaced the
      // conversation it had already painted with that empty page (blank chat).
      // An empty answer is therefore only accepted when no other shape has
      // records either.
      const pageRequests = []
      if (beforeSeq !== undefined) {
        // Pull-older: beforeSeq is the Host's exclusive backwards-page cursor,
        // and an empty page there is a real end-of-history.
        pageRequests.push({ ...baseRequest, maxMessages, turnWindow: { minMessages: 1, minTurns: 1 }, beforeSeq })
      } else {
        pageRequests.push({ ...baseRequest, maxMessages, turnWindow: { minMessages: 1, minTurns: 1 } })
        pageRequests.push({ ...baseRequest, maxMessages })
        // The fallback only ever widens up to the same bound the client could
        // have asked for; it is no longer an unbounded `Math.max(max, 60)`.
        pageRequests.push({
          ...baseRequest,
          maxMessages: Math.min(HISTORY_PAGE_MAX_MESSAGES, Math.max(maxMessages, 60))
        })
      }
      let value = null
      let failure = null
      for (const [index, pageRequest] of pageRequests.entries()) {
        const started = this.now()
        const page = await this.invokeHarness('session/page', { request: pageRequest })
        // attempt number, the cursor it carried, elapsed ms and what came back.
        // The phone aborts at 12s while this ladder can still be running its
        // second or third 30s call, so without the number there is no way to
        // tell "the Host is slow" from "the shape is wrong" (X4④).
        this.noteHistoryAttempt('rpc', index, pageRequests.length, pageRequest, this.now() - started, page)
        if (!page.ok) {
          failure = page
          continue
        }
        const candidate = page.value
        if (!Array.isArray(candidate?.records)) {
          failure = { ok: false, error: 'Harness returned invalid session history.' }
          continue
        }
        if (!value) value = candidate
        if (candidate.records.length) {
          value = candidate
          break
        }
      }
      if (!value) return failure ?? { ok: false, error: 'Harness returned invalid session history.' }
      // Harness 0.1.2 calls the durable entries `records` and serves
      // projections on the list row. Keep the stable mobile-page contract so
      // cached pages can still render messages, running state, and todos.
      const events = compactSessionRecords(value.records)
      this.noteRecordSavings(value.records, events)
      // The history page is the durable leg every open and every poll rides:
      // presented files and markdown images it carries join the session-file
      // allowlist here, so the phone's rendered images resolve in both
      // transports (the SSE realtime leg never crosses this file).
      this.noteSessionFilePaths(sessionId, value.records)
      return {
        ok: true,
        value: {
          events,
          projections,
          hasMore: value.hasMore === true
        }
      }
    }

    if (method === 'session.models') {
      return this.cachedModelCatalog(false)
    }

    // Presets change rarely; the cache stops the settings panel's Promise.all
    // from paying a fresh tunnel round trip on every open. A selection rewrite
    // invalidates it so the next read sees the new value.
    if (method === 'agentPreset.list') {
      return this.cachedAgentPresets(false)
    }

    if (method === 'agentPreset.select') {
      const result = await this.invokeHarness(
        HARNESS_ENDPOINTS[method].endpoint,
        HARNESS_ENDPOINTS[method].args(fields)
      )
      if (result.ok) {
        this.invalidateAgentPresets()
        this.invalidateSessionList()
      }
      return result
    }

    // settings/describe has a 5 s cache already (cachedSettings); route the RPC
    // through it so list-page refreshes stop hitting the Host on every pass.
    if (method === 'settings.describe') {
      return this.cachedSettings(false)
    }

    // A model switch rewrites the catalogue's `current` and the host's global
    // default. The cached catalogue is the page's source of truth for the
    // selection rows, so it is dropped here rather than answered from: the next
    // open re-reads once and no stale `current` survives a switch.
    if (method === 'session.selectModel') {
      const result = await this.invokeHarness(
        HARNESS_ENDPOINTS[method].endpoint,
        HARNESS_ENDPOINTS[method].args(fields)
      )
      if (result.ok) {
        this.invalidateModelCatalog()
        this.invalidateAgentPresets()
        this.invalidateSessionList()
      }
      return result
    }

    if (method === 'session.list') {
      const result = await this.cachedSessionList(false)
      if (!result.ok) return result
      const awaiting = new Set(
        [...this.pendingQuestions.values()]
          .map((item) => item.sessionId)
          .filter((sessionId) => typeof sessionId === 'string')
      )
      const all = Array.isArray(result.value?.items)
        ? applyDescendantRunning(result.value.items)
        : null
      const rows = all
        ? withSessionErrors(this, compactSessionRows(all)).map((item) => ({
            ...item,
            awaitingQuestion: awaiting.has(item.sessionId)
          }))
        : result.value?.items
      if (all) this.noteSavings('list', all, rows)
      // `limit` lets a caller that only needs the newest rows (the handoff's
      // "syncing session list" stage) avoid pulling the whole list: 469 sessions
      // is ~195 KB even after the row projection.
      const limitArg = readNumericArgument(fields.limit, {
        name: 'limit',
        fallback: 0,
        min: 1,
        max: SESSION_LIST_MAX_ROWS
      })
      if (!limitArg.ok) return { ok: false, error: limitArg.error, errorCode: INVALID_ARGUMENTS_CODE }
      const limit = limitArg.value
      const items = limit && Array.isArray(rows)
        ? [...rows].sort((a, b) => (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0)).slice(0, limit)
        : rows
      // T6: when the phone already holds exactly these rows, say so instead of
      // shipping them again. The Host read above still happens (the phone asked
      // for truth about new/changed sessions), but the answer that costs the
      // most is the payload: a full list is ~195 KB and a public cloudflare
      // tunnel turns that into seconds. (user m00001⑤)
      // The fingerprint covers the FULL catalogue (rows), never the trimmed
      // slice — a limited reader must always get real items back.
      const fingerprint = listFingerprint(rows)
      if (limit === 0 && items !== result.value?.items && typeof fields.fingerprint === 'string' && fields.fingerprint === fingerprint) {
        return { ok: true, value: { notModified: true, fingerprint } }
      }
      return { ok: true, value: { ...result.value, items, fingerprint } }
    }

    if (method === 'session.tails') {
      // Batch tail prefetch for the landing (card 2026-10-14-feature-pocket-
      // 手机八问收敛, user m00001④「每个非折叠的会话至少把最后几条消息显示出来」
      // + m00047「显示谁拉谁、只拉有变化的」). The page decides which sessions
      // are worth asking; this answers all of them in one round-trip instead of
      // one session.history per row (a public tunnel makes N trips N seconds).
      // A per-session failure is a marker inside the payload, never a failed
      // response — the landing paints rows whether or not a tail came.
      const requested = Array.isArray(fields.sessions)
        ? [...new Set(fields.sessions.filter((id) => typeof id === 'string' && id.length > 0))]
        : []
      if (requested.length === 0) return { ok: true, value: { tails: {} } }
      const ids = requested.slice(0, TAILS_MAX_SESSIONS)
      const listed = await this.cachedSessionList(false)
      if (!listed.ok) return listed
      const items = Array.isArray(listed.value?.items) ? applyDescendantRunning(listed.value.items) : []
      const byId = new Map(items.filter((item) => item && typeof item.sessionId === 'string').map((item) => [item.sessionId, item]))
      // 2026-10-18 (m00002): the cached list is 10s old, and the phone only re-arms a
      // row when a fetch SUCCEEDS — so a row the cache missed (a session the desktop
      // created after the last refresh) or a row whose projection has not arrived yet
      // was a permanent dead end: every open of that chat paid the full history read.
      // One forced refetch per batch — the same escape the history leg uses when its
      // cursor is missing (session.history) — then the markers below stay the answer
      // for a row even a fresh list cannot serve. The phone's TAIL_RETRY_MAX bounds
      // how often a hopeless row can ask at all.
      const needy = ids.some((sessionId) => {
        const row = byId.get(sessionId)
        return !row || typeof row.projections?.asOfSeq !== 'number'
      })
      if (needy) {
        const forced = await this.cachedSessionList(true)
        if (forced.ok) {
          const forcedItems = Array.isArray(forced.value?.items) ? applyDescendantRunning(forced.value.items) : []
          for (const item of forcedItems) {
            if (item && typeof item.sessionId === 'string') byId.set(item.sessionId, item)
          }
        }
      }
      const tails = {}
      let next = 0
      // Tiny worker pool: the Host's session/page is the slow leg, so four at a
      // time bounds the fan-out without serialising 30 of them.
      const worker = async () => {
        for (;;) {
          const index = next++
          if (index >= ids.length) return
          const sessionId = ids[index]
          const row = byId.get(sessionId)
          if (!row) {
            tails[sessionId] = { error: 'unknown' }
            continue
          }
          const throughSeq = row.projections?.asOfSeq
          if (typeof throughSeq !== 'number') {
            tails[sessionId] = { error: 'no-cursor' }
            continue
          }
          // Same two shapes the history ladder tries first (aligned last turn,
          // then a plain page); the third, wider fallback is for an open
          // transcript, not for a line of preview text.
          const base = { address: followAddressOf(sessionId, null), throughSeq }
          let answer = null
          for (const request of [
            { ...base, maxMessages: TAIL_PAGE_MESSAGES, turnWindow: { minMessages: 1, minTurns: 1 } },
            { ...base, maxMessages: TAIL_PAGE_MESSAGES }
          ]) {
            const page = await this.invokeHarness('session/page', { request })
            if (!page.ok) continue
            const records = Array.isArray(page.value?.records) ? page.value.records : []
            if (!answer) answer = { updatedAt: Number(row.updatedAt) || 0, events: compactSessionRecords(records) }
            if (records.length) {
              answer = { updatedAt: Number(row.updatedAt) || 0, events: compactSessionRecords(records) }
              break
            }
          }
          tails[sessionId] = answer ?? { error: 'page-failed' }
        }
      }
      await Promise.all(Array.from({ length: Math.min(TAILS_CONCURRENCY, ids.length) }, worker))
      return { ok: true, value: { tails } }
    }

    // A prompt (or a slash command, which is the same write wearing a different
    // hat) makes the Host stamp the row's `updatedAt` with the user-message time
    // — that advances in the same synchronous stack that appends the event, not
    // at turn end. But the next `session.list` would still be answered from the
    // 10 s promise window, so a phone that sends and immediately returns to the
    // landing paints the pre-send row: stale clock, stale sort, and the ledger
    // has nothing yet either (the optimistic bubble carries no messageTime, and
    // the tails skip running rows). All three home-row readings freeze until the
    // 60 s list poll outlives the window (docs/调查报告-pocket发送后返回主页已发送不真实显示-20261018.md).
    // Drop the window on an accepted write so the next read re-asks the Host.
    // This is the same repair the preset/model switches already apply (:6173,
    // :6196) — no new timer, no second cache.
    if (method === 'session.prompt' || method === 'command.execute') {
      const result = await this.invokeHarness(
        HARNESS_ENDPOINTS[method].endpoint,
        HARNESS_ENDPOINTS[method].args(fields)
      )
      if (result.ok) this.invalidateSessionList()
      return result
    }

    const route = HARNESS_ENDPOINTS[method]
    if (route === undefined) return { ok: false, error: 'RPC method is not available on mobile.' }
    return this.invokeHarness(route.endpoint, route.args(fields))
  }

  /**
   * @param {string} endpoint
   * @param {Record<string, unknown>} args
   * @returns {Promise<{ ok: boolean, value?: unknown, error?: string }>}
   */
  async invokeHarness(endpoint, args) {
    const result = await this.invokeHarnessCall(endpoint, args)
    // Every inner call is a reachability observation, so the status surface can
    // say whether the HOST is answering without spending a probe round trip of
    // its own. `null` in the payload means "nothing has been observed yet".
    this.hostProbe = {
      at: this.now(),
      ok: result.ok === true,
      code: result.ok === true ? undefined : result.errorCode ?? 'host-rejection'
    }
    return result
  }

  /**
   * Is the Host answering right now, as far as the last inner call showed?
   * `true` / `false` only when something has actually been observed; `null`
   * means no observation yet, which a caller must not read as "unreachable".
   * A probe older than the settings cache window is a stale answer, so it is
   * reported as unknown rather than kept as fact.
   * @returns {{ reachable: boolean | null, ageMs: number | null, code: string | null }}
   */
  hostReachability() {
    const probe = this.hostProbe
    if (!probe) return { reachable: null, ageMs: null, code: null }
    const ageMs = Math.max(0, this.now() - probe.at)
    // `cachedSettings` re-asks after 5s and `cachedSessionList` after 10s, so an
    // answer younger than the longer of the two is still the live one.
    if (ageMs > 10_000) return { reachable: null, ageMs, code: probe.code ?? null }
    return { reachable: probe.ok, ageMs, code: probe.code ?? null }
  }

  /**
   * The Host call itself. Four failure classes, one log line each (X4①):
   * no harness URL yet, transport, unreadable/mismatched envelope, and a Host
   * rejection that was perfectly understood and simply refused.
   * @param {string} endpoint
   * @param {Record<string, unknown>} args
   * @returns {Promise<{ ok: boolean, value?: unknown, error?: string }>}
   */
  async invokeHarnessCall(endpoint, args) {
    const base = this.options.harnessUrl()
    if (!base) {
      // '__bridge/*' codes are bridge-local and cannot collide with Host
      // RemoteError codes ('session/*', 'gateway/*').
      //
      // X4①: every failure class says so on the log. Before this, a phone that
      // "could not send its message" because the desktop had not come up yet
      // left nothing on disk at all, and the one thing an operator needed —
      // which of the four classes this was — was exactly what was missing.
      this.log('warn', `harness call dropped endpoint=${endpoint}: no harness URL yet`)
      return { ok: false, error: 'Harness is not ready.', errorCode: '__bridge/not-ready' }
    }
    const rpcId = randomUUID()
    /** @type {Response} */
    let response
    try {
      response = await this.harnessFetch(new URL(`/api/${endpoint}`, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
        signal: AbortSignal.timeout(30_000)
      })
    } catch (error) {
      // The Host never answered: connection refused, a socket died mid-request,
      // or the 30s signal fired. Everything a transport failure can say is in
      // the log; the phone only ever gets the fixed pair back, so a Host path or
      // a fetch-internal message cannot ride out through a 400/502 body.
      this.log('warn', `harness transport failed endpoint=${endpoint} rpcId=${rpcId}: ${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, error: 'Harness is not reachable.', errorCode: '__bridge/transport' }
    }
    if (!response.ok) {
      // The transport carried something, and what it carried was an HTTP
      // failure — a proxy in front of the Host, a route the gateway refused,
      // a 5xx of the Host's own. Distinct class, distinct line: "the phone's
      // call was wrong" is not what this says.
      this.log('warn', `harness answered ${String(response.status)} endpoint=${endpoint} rpcId=${rpcId}`)
      // Nothing downstream will ever see this response: the phone is handed the
      // fixed pair below instead. While the host is refusing service every poll
      // from every handset lands here, and an unread body holds its connection
      // until the stream is collected, so the refusal is released on the way out.
      void response.body?.cancel()
      return { ok: false, error: `Harness transport returned HTTP ${response.status}.`, errorCode: '__bridge/transport' }
    }
    /** @type {{ rpcId?: unknown, result?: { ok?: boolean, value?: unknown, error?: { message?: unknown, code?: unknown } } }} */
    let envelope
    try {
      envelope = await response.json()
    } catch (error) {
      // A 200 whose body is not the envelope (an HTML error page off a proxy, a
      // truncated stream) is the same class of failure as a dead socket: it is
      // this bridge's problem, not the phone's, and not a Host rejection.
      this.log('warn', `harness envelope unreadable endpoint=${endpoint} rpcId=${rpcId}: ${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, error: 'Harness returned an unreadable answer.', errorCode: '__bridge/transport' }
    }
    if (envelope.rpcId !== rpcId) {
      // The answer is not for this call: a shared or recycled connection handed
      // back somebody else's envelope. Loud on purpose — this class is a
      // transport-layer lie, not a declined request.
      this.log('error', `harness rpc answer mismatched endpoint=${endpoint} rpcId=${rpcId}`)
      return { ok: false, error: 'Harness RPC response did not match the request.', errorCode: '__bridge/rpc-mismatch' }
    }
    if (envelope.result?.ok !== true) {
      const hostError = envelope.result?.error
      const message = typeof hostError?.message === 'string'
        ? hostError.message
        : 'Harness rejected the request.'
      /** @type {{ ok: false, error: string, errorCode?: string }} */
      const failure = { ok: false, error: message }
      // The Host serialises RemoteError as { code, message, details }; keep the
      // stable code so callers can distinguish not-found from other failures.
      if (typeof hostError?.code === 'string') failure.errorCode = hostError.code
      // The fourth class: the Host is reachable, answered, and said no. Only the
      // stable code is logged — the message is the Host's prose and may quote
      // what it was given.
      this.log('warn', `harness rejected endpoint=${endpoint} rpcId=${rpcId} code=${failure.errorCode ?? 'uncoded'}`)
      return failure
    }
    return { ok: true, value: envelope.result.value }
  }

  /**
   * Serve one stored session attachment to the same-origin phone. The Host RPC
   * returns the attachment record plus base64 bytes; the bytes are decoded
   * here and written with the Host-registered media type. Never publicly
   * cached: access stays scoped to the paired cookie.
   * @param {import('node:http').ServerResponse} response
   * @param {string} sessionId
   * @param {string} attachmentId
   * @returns {Promise<void>}
   */
  async streamSessionAttachment(response, sessionId, attachmentId) {
    /** @type {{ ok: boolean, value?: unknown, errorCode?: string }} */
    let result
    try {
      result = await this.invokeHarness('session/attachment', {
        request: { sessionId, attachmentId }
      })
    } catch (error) {
      // A transport/network failure (no envelope at all) is a service problem,
      // never a missing attachment.
      this.log('error', `session attachment proxy failed: ${error instanceof Error ? error.message : String(error)}`)
      return this.text(response, 502, 'Attachment is not available right now.')
    }
    if (!result.ok) {
      // Host not-found-class RemoteError codes mean the attachment genuinely
      // does not exist: the session was disposed ('session/not-found') or the
      // id is not referenced / unreadable ('session/attachment-invalid',
      // reason ATTACHMENT_NOT_REFERENCED). Every other Host code (gateway/*,
      // transport-shaped failures carrying a code) is a 502 service failure.
      const NOT_FOUND_CODES = new Set(['session/not-found', 'session/attachment-invalid'])
      if (result.errorCode && !NOT_FOUND_CODES.has(result.errorCode)) {
        return this.text(response, 502, 'Attachment is not available right now.')
      }
      // No structured code (older Host envelopes or plain error doubles): the
      // failure class is unknown, so conservatively keep 404 rather than turn
      // genuine not-found answers into server errors.
      return this.text(response, 404, 'Attachment is not available.')
    }
    const value = result.value
    const data = typeof value?.data === 'string' ? value.data : ''
    // The record's own media type is not a permission to render. It comes off
    // the Host's attachment row, and anything outside the inline whitelist is
    // handed back as a download: a `text/html` answer served here would run on
    // this origin, where every RPC is same-origin and the phone's cookie rides
    // along. `nosniff` alone does not stop a declared type from being rendered.
    const { contentType, download } = attachmentDisposition(value?.attachment?.mediaType)
    const bytes = Buffer.from(data, 'base64')
    response.setHeader('content-type', contentType)
    if (download) {
      // The Host's attachment row carries the real file name; a fixed
      // "attachment" made every saved file look the same on the phone. The
      // name is untrusted data on this origin, so a header-breaking quote is
      // dropped rather than escaped: a quote in the middle of a filename is
      // not worth a forged header.
      const name = typeof value?.attachment?.name === 'string' ? value.attachment.name : ''
      const safe = name.replace(/["\r\n]/g, '')
      const filename = safe.length ? safe : 'attachment'
      response.setHeader('content-disposition', `attachment; filename="${filename}"`)
    }
    response.setHeader('cache-control', 'private, no-store')
    response.setHeader('content-length', String(bytes.length))
    response.end(bytes)
  }

  /**
   * Serve one local file this session's own event stream has surfaced — a
   * `deliverables/presented` entry, or a markdown image an assistant message
   * carried. The phone cannot load `F:\…` paths itself; the desktop web app
   * can, and this endpoint is the bridge's stand-in for that.
   *
   * The authorisation is the known-path set, and it is the whole red line: a
   * path the session's event stream never mentioned answers 404, so the
   * pairing cookie alone never buys a read of arbitrary local files. The set
   * is matched verbatim (the phone echoes back the exact string it saw), the
   * file must still exist and fit the attachment-class ceiling, and the served
   * media type goes through `attachmentDisposition` — so an `.html` sitting
   * next to a presented `.png` downloads instead of rendering on this origin.
   *
   * Nothing about the path is ever logged: local disk topology is not log
   * material, and the failure bodies below are fixed strings for the same
   * reason the bridge-wide 500 is.
   * @param {import('node:http').ServerResponse} response
   * @param {string} sessionId
   * @param {string} requestedPath
   * @returns {Promise<void>}
   */
  async streamSessionFile(response, sessionId, requestedPath) {
    const allowed = this.sessionKnownPaths?.get(sessionId)
    if (!allowed || !allowed.has(requestedPath) || requestedPath.includes('\0')) {
      return this.text(response, 404, 'File is not available.')
    }
    let info
    try {
      info = await stat(requestedPath)
    } catch {
      return this.text(response, 404, 'File is not available.')
    }
    if (!info.isFile()) return this.text(response, 404, 'File is not available.')
    if (info.size > SESSION_FILE_MAX_BYTES) {
      return this.text(response, 413, 'File is too large to serve.')
    }
    let bytes
    try {
      bytes = await readFile(requestedPath)
    } catch {
      return this.text(response, 404, 'File is not available.')
    }
    const { contentType, download } = attachmentDisposition(sessionFileType(requestedPath))
    response.setHeader('content-type', contentType)
    if (download) {
      // Same header discipline as the attachment route: a quote in the middle
      // of a filename is dropped, not escaped into the header.
      const safe = basename(requestedPath).replace(/["\r\n]/g, '')
      const filename = safe.length ? safe : 'file'
      response.setHeader('content-disposition', `attachment; filename="${filename}"`)
    }
    response.setHeader('cache-control', 'private, no-store')
    response.setHeader('content-length', String(bytes.length))
    response.end(bytes)
  }

  /**
   * Record every local path these event frames surface for `sessionId` — the
   * allowlist `streamSessionFile` serves from. Insertion-order eviction keeps
   * the map bounded; per-session growth stops at SESSION_KNOWN_PATHS_MAX.
   * Accepts durable records, item payloads, and `{ records: [...] }` snapshots
   * alike (collectFilePaths normalises the shapes).
   * @param {string} sessionId
   * @param {unknown[]} frames
   * @returns {void}
   */
  noteSessionFilePaths(sessionId, frames) {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || !Array.isArray(frames)) return
    if (!this.sessionKnownPaths) this.sessionKnownPaths = new Map()
    let set = this.sessionKnownPaths.get(sessionId)
    if (!set) {
      set = new Set()
      this.sessionKnownPaths.set(sessionId, set)
      while (this.sessionKnownPaths.size > SESSION_KNOWN_PATH_SETS_MAX) {
        const oldest = this.sessionKnownPaths.keys().next().value
        this.sessionKnownPaths.delete(oldest)
      }
    }
    for (const frame of frames) collectFilePaths(set, frame)
  }

  /**
   * Proxy the Host's session-export ZIP. Unlike RPC forwarding this route is a
   * plain GET (the desktop anchor hits the same URL directly): the process
   * cookie is attached via harnessFetch, and only the fixed query is ever
   * forwarded — no client-controlled paths or parameters.
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async streamSessionExport(request, response, sessionId) {
    const base = this.options.harnessUrl()
    if (!base) return this.text(response, 503, 'Harness is not ready.')
    const target = new URL('/api/session.export', base)
    target.searchParams.set('sessionId', sessionId)
    target.searchParams.set('includeDescendants', 'true')
    let upstream
    try {
      upstream = await this.harnessFetch(target, {
        method: request.method,
        signal: AbortSignal.timeout(120_000)
      })
    } catch (error) {
      // The fetch itself rejects when the transport dies (connection refused,
      // socket closed after response head, timeout): no upstream response can
      // be proxied, so answer 502 instead of letting it escape as a 500.
      this.log('error', `session export request failed: ${error instanceof Error ? error.message : String(error)}`)
      return this.text(response, 502, 'Export is not available right now.')
    }
    if (!upstream.ok) {
      // A 5xx from the Host is its internal failure: the text it writes there
      // can carry a path, a stack line or a service name, and this route is
      // reachable from a phone. Same rule as the bridge-wide 500 and the
      // attachment proxy — the class stays visible, the content does not.
      if (upstream.status >= 500) {
        this.log('warn', `session export upstream ${upstream.status}`)
        // Same reason as the RPC transport branch: this body is replaced by the
        // generic refusal and is never forwarded, so it is released here.
        void upstream.body?.cancel()
        return this.text(response, 502, 'Export is not available right now.')
      }
      response.statusCode = upstream.status
      response.end(await upstream.text().catch(() => ''))
      return
    }
    const contentType = upstream.headers.get('content-type')
    if (contentType) response.setHeader('content-type', contentType)
    const disposition = upstream.headers.get('content-disposition')
    if (disposition) response.setHeader('content-disposition', disposition)
    response.setHeader('cache-control', 'private, no-store')
    if (request.method === 'HEAD' || upstream.body === null) {
      response.end()
      return
    }
    // Keep the readable reference so an upstream failure can be handled
    // explicitly instead of surfacing as an unhandled stream error (Minor-4).
    const upstreamReadable = Readable.fromWeb(upstream.body)
    upstreamReadable.on('error', (error) => {
      this.log('error', `session export upstream failed: ${error instanceof Error ? error.message : String(error)}`)
      // A 502 is only possible before headers went out. Once piping started
      // (headersSent) the status line cannot change, so destroy to clean up.
      if (!response.headersSent) {
        response.statusCode = 502
        response.end('Export is not available right now.')
      } else {
        response.destroy(error)
      }
    })
    response.on('error', () => {
      // Phone disconnected mid-transfer: tear down the upstream to avoid a
      // dangling read and backpressure leaks.
      if (!upstreamReadable.destroyed) upstreamReadable.destroy()
    })
    upstreamReadable.pipe(response)
  }

  /**
   * Reconciles everything that depends on a phone being attached. The mux
   * downlink exists purely to track questions raised for a mobile client, so
   * running it with no client meant reconnecting twice a second, forever, on
   * every desktop that never used the feature.
   */
  syncConnected() {
    const connected = this.sessions.size > 0
    if (connected) this.startMuxMonitor()
    else this.muxAbort?.abort()
    // Every session change funnels through here (the server's per-request
    // `.finally` plus every revoke/park path), so this is the one place a
    // debounced persist needs to hang off of. A restart that lands mid-debounce
    // loses only the debounce window; stop() flushes synchronously.
    this.scheduleSessionPersist()
    if (connected === this.lastConnected) return
    this.lastConnected = connected
    // Reconciliation runs off the request path, so a throwing observer must not
    // turn into an unhandled rejection that fails the request behind it.
    try {
      this.options.onConnectedChange?.(connected)
    } catch {
      // A renderer that went away mid-broadcast is not the bridge's problem.
    }
  }

  startMuxMonitor() {
    if (this.muxTask) return
    const abort = new AbortController()
    this.muxAbort = abort
    // `.catch()` BEFORE `.finally()`. The monitor is built to run until the
    // signal aborts, so anything that reaches this promise escaped its loop —
    // and this plugin lives inside the host process, where an unhandled
    // rejection is the host's problem, not just the plugin's. It was also a
    // one-way door: a rejected task left `muxTask` set forever, so every later
    // `startMuxMonitor()` returned at the guard above and the question downlink
    // never came back for the rest of the session (M5).
    this.muxTask = this.muxMonitor.monitorMux(abort.signal)
      .catch((error) => {
        this.log('error', `mux monitor escaped its loop: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (this.muxAbort === abort) {
          this.muxAbort = undefined
          this.muxTask = undefined
        }
      })
  }

  // -- Durable sessions (lib/session-store.js) -------------------------------

  /**
   * Re-arm the debounced persist. Failures are logged once per attempt and
   * never block the request that caused the change: an unwritable data root
   * degrades to the pre-store behaviour (phones re-pair after a restart),
   * which is not this request's problem to answer.
   * @returns {void}
   */
  scheduleSessionPersist() {
    if (this.sessionStore === undefined) return
    if (this.sessionPersistTimer !== undefined) return
    this.sessionPersistTimer = setTimeout(() => {
      this.sessionPersistTimer = undefined
      this.saveSessionsIfChanged()
    }, SESSION_PERSIST_DEBOUNCE_MS)
  }

  /**
   * Write the durable document only if its content actually moved.
   *
   * Every request ends in syncConnected() -> scheduleSessionPersist(), and a
   * phone parked on the landing page polls for as long as the tab is open, so
   * the debounce alone kept rewriting an identical 200 KB+ document every
   * half second. The fingerprint is the document minus `savedAt`; a failed
   * save leaves the stamp untouched so the next call retries it.
   *
   * @param {{ force?: boolean }} [options] force writes regardless of the stamp
   * @returns {boolean} true when a write happened
   */
  saveSessionsIfChanged(options = {}) {
    if (this.sessionStore === undefined) return false
    const state = {
      sessions: this.sessions,
      suspendedSessions: this.suspendedSessions,
      resumableSessions: this.resumableSessions,
      devices: this.devices,
    }
    const fingerprint = persistFingerprint(state)
    if (options.force !== true && fingerprint === this.lastPersistFingerprint) return false
    const saved = this.sessionStore.save({ ...state, savedAt: this.now() })
    if (!saved) {
      this.log('warn', 'session persist failed')
      return false
    }
    this.lastPersistFingerprint = fingerprint
    return true
  }

  /**
   * Load the durable session maps — and the device registry that rides the
   * same document. Called once from start(): expired records are dropped by
   * the store against this bridge's clock, the maps are capped by the store's
   * sanitizer, and a corrupt or absent file reads as empty — the pre-store
   * behaviour, never a throw.
   *
   * Compatibility migration (change 2026-10-07-feat-pocket-device-registry):
   * pairings that predate the registry have no profile, so one is built from
   * each restored record's own fields — nothing is re-asked, nothing is
   * re-paired. The migrated permission is 'lan+wan' and the migrated consent
   * stamp is the record's own history. This is a **continuity assumption**,
   * not a recorded fact: a LAN-first device never saw the disclaimer page,
   * yet it still migrates as consented — the alternative (defaulting to 'lan')
   * would turn a working phone's next tunnel visit into a 403 the user never
   * asked for. Auditor note 2026-10-08: accepted as smoothness-over-strictness.
   * @returns {void}
   */
  restorePersistedSessions() {
    if (this.sessionStore === undefined) return
    try {
      const doc = this.sessionStore.load(this.now())
      for (const [key, entries] of [['suspendedSessions', doc.suspended], ['resumableSessions', doc.resumable]]) {
        for (const [token, record] of entries) {
          const map = this[key]
          this.capDeviceMap(map, token)
          map.set(token, record)
        }
      }
      // A session that was live when the previous process died parks instead of
      // coming back counted. /desktop/status answers from sessions.size, so a
      // record restored straight into `sessions` made the desktop report a
      // phone that is not there and left the QR behind a manual disconnect.
      // Parked records keep every revival path a manual disconnect has; the
      // parkedByRestart mark is what additionally lets the cookie path revive
      // without a re-pair — which a manual disconnect must never do, because
      // the user chose to end that session.
      for (const [token, record] of doc.sessions) {
        record.parkedByRestart = true
        this.capDeviceMap(this.suspendedSessions, token)
        this.suspendedSessions.set(token, record)
        this.capDeviceMap(this.resumableSessions, token)
        this.resumableSessions.set(token, record)
      }
      for (const [fingerprint, record] of doc.devices) {
        this.capDeviceMap(this.devices, fingerprint)
        this.devices.set(fingerprint, /** @type {DeviceProfile} */ (record))
      }
      // Migration: every restored session record without a profile gets one
      // built from its own fields. Runs before anything observes the registry.
      let migrated = 0
      const seen = new Set()
      for (const record of [...this.sessions.values(), ...this.suspendedSessions.values(), ...this.resumableSessions.values()]) {
        const fingerprint = record?.fingerprint
        if (typeof fingerprint !== 'string' || fingerprint.length === 0 || seen.has(fingerprint)) continue
        seen.add(fingerprint)
        if (this.devices.has(fingerprint)) continue
        migrated += 1
        this.devices.set(fingerprint, {
          fingerprint,
          ...(typeof record.label === 'string' && record.label ? { label: record.label } : {}),
          firstPairedAt: typeof record.issuedAt === 'number' ? record.issuedAt : (typeof record.lastSeenAt === 'number' ? record.lastSeenAt : this.now()),
          expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : this.now() + MOBILE_COOKIE_TTL_MS,
          lastSeenAt: typeof record.lastSeenAt === 'number' ? record.lastSeenAt : this.now(),
          permission: 'lan+wan',
          publicConsentedAt: typeof record.lastSeenAt === 'number' ? record.lastSeenAt : (typeof record.issuedAt === 'number' ? record.issuedAt : this.now()),
        })
      }
      const restored = this.sessions.size + this.suspendedSessions.size + this.resumableSessions.size
      if (restored > 0 || this.devices.size > 0) {
        this.log('info', `sessions restored from disk live=${this.sessions.size} suspended=${this.suspendedSessions.size} resumable=${this.resumableSessions.size} devices=${this.devices.size}${migrated > 0 ? ` migrated=${migrated}` : ''}`)
      }
      if (migrated > 0 || this.suspendedSessions.size > 0 || this.resumableSessions.size > 0) this.scheduleSessionPersist()
    } catch (error) {
      this.log('warn', `session restore failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Flush any pending debounced persist and stop the timer.
   *
   * Guarded by the same fingerprint as the debounced path: a timer armed by a
   * request that changed nothing must not turn into a write. `force` is for the
   * restart boundary — stop() persists before the in-memory teardown and has to
   * write even when the fingerprint is current, because the maps it has just
   * cleared are exactly what must not reach disk.
   *
   * @param {{ force?: boolean }} [options]
   * @returns {boolean} true when a write happened
   */
  flushSessionPersist(options = {}) {
    if (this.sessionPersistTimer !== undefined) {
      clearTimeout(this.sessionPersistTimer)
      this.sessionPersistTimer = undefined
    }
    if (this.sessionStore === undefined) return false
    return this.saveSessionsIfChanged({ force: options.force === true })
  }

  /**
   * Everything the phone used to learn from a 1.5s `/api/status` poll. It is now
   * also pushed down the session stream as a `status` frame, so a phone with a
   * live stream pays for zero reachability round trips.
   *
   * @param {import('node:http').IncomingMessage} request
   */
  async buildStatusPayload(request) {
    const body = {
      // `connected` has always meant "this bridge answered", and a phone may
      // still be holding a page that reads it, so its value is untouched. The
      // ambiguity is retired by naming the three things it was being made to
      // stand for: whether the Host is answering (`hostReachable`), whether the
      // event carrier is up (`muxConnected`), and whether any handset is
      // attached at all (`devicesConnected`) — the last one is what the desktop
      // surface's `connected` has meant all along (X4⑤).
      connected: true,
      muxConnected: this.muxConnected,
      devicesConnected: this.sessions.size > 0,
      // Which door THIS request came through — `lan` or `tunnel`, by the same
      // detection `handle()` runs. The phone reads it to pick its realtime
      // transport: SSE on `lan`, incremental polling on `tunnel` (where the
      // quick tunnel swallows every live SSE frame). It rides the SSE status
      // frame too, so a streaming phone notices a mode flip without a new
      // endpoint. Same computation as the router: socket address for the
      // loopback test, then the Host header / CF headers off the request.
      connectionMode: this.requestConnectionMode(request, normalizeRemoteAddress(request.socket?.remoteAddress ?? '')),
      tunnelProvider: this.tunnelInstance?.provider,
      tunnelExpiresAt: this.tunnelExpiresAt
    }
    // The session behind the caller's cookie exposes its own expiry.
    const held = this.mobileToken(request)
    const session = held ? this.sessions.get(held) : undefined
    if (session) {
      body.issuedAt = session.issuedAt
      body.expiresAt = session.expiresAt
    }
    // Piggyback live desktop settings so the phone tracks changes without a
    // separate poll; cachedSettings caps the harness round trips.
    try {
      const settingsResult = await this.cachedSettings(false)
      if (settingsResult.ok) body.settings = extractMobileSettings(settingsResult.value)
    } catch {
      body.settings = null
    }
    // `settings/describe` is the read that answers the question the phone cannot
    // ask on its own, so refresh the observation after it: the values above were
    // taken from the PREVIOUS call, which is the one that just told us whether
    // the Host is there.
    const after = this.hostReachability()
    body.hostReachable = after.reachable
    body.hostProbeAgeMs = after.ageMs
    body.hostProbeCode = after.code
    return body
  }

  /**
   * Forward one native Harness session/follow stream to an authenticated phone as SSE.
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {string} sessionId
   * @param {number} sinceSeq  Records at or below this sequence are already on
   *   the phone (it arrived through the handoff payload), so the opening
   *   snapshot only carries what is new. -1 sends everything.
   * @param {{ parentSessionId: string, mode: string } | null} [subagent] when
   *   given, the forwarded follow opens with the durable subagent address
   *   instead of the ordinary session one.
   * @returns {Promise<void>}
   */
  async streamSession(request, response, sessionId, sinceSeq = -1, subagent = null) {
    // Attribute the long-lived response to the device that opened it: this is
    // what a revoke kicks. The poll fallback answers within one request and is
    // deliberately not tracked.
    this.trackDeviceStream(request, response)
    return streamSessionStream(this, request, response, sessionId, sinceSeq, subagent)
  }

  /**
   * Answer one incremental poll for a session's realtime frames — the tunnel
   * fallback for the SSE stream, whose realtime leg a Cloudflare quick tunnel
   * swallows whole (2026-10-07 live probe). The frames come from this
   * session's poll collector (lib/session-stream.js), which holds the
   * bridge↔Host follow the tunnel never touches.
   *
   * The response is INCREMENTS ONLY: the collector drops the host's opening
   * snapshot on purpose, so durable state keeps flowing through boot/history
   * exactly as it does today.
   *
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {string} sessionId
   * @param {number} sinceSeq the caller's collector cursor (latestSeq of its
   *   previous answer); -1 = whatever the window holds
   * @param {{ parentSessionId: string, mode: string } | null} [subagent] when
   *   given, the collector's follow opens with the durable subagent address
   *   instead of the ordinary session one.
   * @returns {Promise<void>}
   */
  async sessionEvents(request, response, sessionId, sinceSeq = -1, subagent = null) {
    let base
    try {
      base = this.options.harnessUrl()
    } catch (error) {
      // Same host-teardown shape as the stream path: the getter throws while
      // the host is going away, and the answer names the endpoint class in the
      // log while the body stays generic.
      const detail = error instanceof Error ? error.message : String(error)
      this.log('warn', `session events has no harness to follow session=${sessionId}: ${detail}`)
      return this.text(response, 503, 'Harness is not ready.')
    }
    if (!base) return this.text(response, 503, 'Harness is not ready.')
    let collector = this.sessionEventCollectors.get(sessionId)
    if (collector && collector.idleMs() > this.eventCollectorIdleMs) {
      // The last poll is past the idle ceiling: nobody has been watching, so
      // the follow and its buffer are torn down. The next answer carries a new
      // generation, which is how a returning poller learns to re-sync.
      collector.stop()
      this.sessionEventCollectors.delete(sessionId)
      collector = undefined
    }
    if (!collector) {
      collector = createSessionEventCollector(this, sessionId, subagent)
      this.sessionEventCollectors.set(sessionId, collector)
      while (this.sessionEventCollectors.size > this.eventCollectorSessionsMax) {
        // LRU by last poll: the collector nobody has asked for the longest is
        // the one whose follow is worth least. Insertion order is not enough —
        // a phone alternating between two conversations must not evict the
        // one it is about to come back to.
        let oldestKey
        let oldestIdle = -1
        for (const [key, candidate] of this.sessionEventCollectors) {
          const idle = candidate.idleMs()
          if (idle > oldestIdle) {
            oldestIdle = idle
            oldestKey = key
          }
        }
        if (oldestKey === undefined) break
        this.sessionEventCollectors.get(oldestKey)?.stop()
        this.sessionEventCollectors.delete(oldestKey)
      }
    }
    collector.touch()
    let drained = collector.poll(sinceSeq)
    let live = collector.state()
    // Long-poll. An empty answer forces the phone back onto its 1.5–6 s ladder,
    // so an idle conversation burns tunnel round trips for nothing and a live one
    // reads up to 6 s behind. Holding the request inverts both: the frame that
    // lands answers it, and there are FEWER requests than the ladder was making.
    // Never armed when the follow itself is down — that empty answer IS the
    // outage notice, and the phone must have it now, not in eight seconds.
    let held = false
    if (!drained.events.length && !drained.overflow && live.connected && this.eventHoldMs > 0) {
      held = true
      await this.holdSessionEvents(request, collector, sinceSeq)
      if (request.destroyed || response.writableEnded || response.destroyed) return
      drained = collector.poll(sinceSeq)
      live = collector.state()
    }
    // Frames the tunnel poller is about to receive are frames this bridge has
    // seen: whatever local paths they surface join this session's known-path
    // set here, before the phone can ask to render any of them.
    if (drained.events.length) {
      this.noteSessionFilePaths(sessionId, drained.events.map((entry) => entry.frame))
    }
    return this.json(response, 200, {
      ok: true,
      // Which door this request came through — the same mode the status
      // payload publishes, so a poller can switch transports (poll ↔ SSE)
      // from either answer.
      mode: this.requestConnectionMode(request, normalizeRemoteAddress(request.socket?.remoteAddress ?? '')),
      generation: collector.generation,
      connected: live.connected,
      events: drained.events,
      latestSeq: drained.latestSeq,
      ...(drained.overflow ? { overflow: true } : {}),
      // `held` tells the phone this answer came out of a wait, not a poll: its
      // backoff ladder resets to the base cadence instead of climbing toward 6 s,
      // which is what makes the next request start while this one was the wait.
      ...(held ? { held: true } : {}),
      ...(live.failure ? { reason: live.failure } : {}),
    })
  }

  /**
   * Wait out one empty poll until the collector has news, the phone walks away,
   * or the ceiling expires. Every exit path releases every resource: the frame
   * watcher, the timer, the `close` listener, and the entry in
   * {@link eventHolds} — a leak in any of those means a socket nobody is waiting
   * for anymore, on a phone that is out of battery in a pocket.
   * @param {import('node:http').IncomingMessage} request
   * @param {ReturnType<typeof createSessionEventCollector>} collector
   * @param {number} sinceSeq
   * @returns {Promise<void>}
   */
  holdSessionEvents(request, collector, sinceSeq) {
    return new Promise((resolve) => {
      let settled = false
      /** @type {() => void} */
      let off = () => {}
      const finish = () => {
        if (settled) return
        settled = true
        off()
        clearTimeout(timer)
        request.removeListener('close', onClose)
        this.eventHolds.delete(finish)
        resolve()
      }
      off = collector.onFrames((reason) => {
        if (reason === 'stopped') finish()
        else if (collector.poll(sinceSeq).events.length) finish()
      })
      const timer = setTimeout(finish, this.eventHoldMs)
      timer.unref?.()
      const onClose = () => finish()
      request.once('close', onClose)
      this.eventHolds.add(finish)
    })
  }

  /**
   * Consume one carrier frame.
   *
   * Every logical stream shares this socket, so a frame is routed by its
   * `streamId` first. The event stream replaces the old `server-request`
   * envelopes: a question now arrives as a `waterfall` frame carrying its own
   * `eventId`, which is also the id the phone answers with, and the opening
   * `ready` frame names the generation every answer has to quote.
   * @param {string} data
   */
  consumeMuxEnvelope(data) {
    let frame
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    if (!isRecord(frame) || frame.type !== 'item') return
    const value = frame.value
    if (frame.streamId === WORKSPACE_STREAM_ID) {
      // The phone filters its session list by this snapshot. A session created
      // after connect arrives as an increment, so keeping only the opening
      // baseline hides it until the follow stream reconnects.
      if (isRecord(value)) this.workspaceSnapshot = applyWorkspaceFollowFrame(this.workspaceSnapshot, value)
      return
    }
    if (frame.streamId !== EVENT_STREAM_ID || !isRecord(value)) return
    if (value.type === 'ready' && typeof value.clientId === 'string') {
      this.eventClientId = value.clientId
      return
    }
    if (value.type === 'waterfall' && value.event === USER_QUESTION_EVENT) {
      const eventId = typeof value.eventId === 'string' ? value.eventId : undefined
      const request = isRecord(value.request) ? value.request : undefined
      // The Agent identity travels on the frame, not in the request: the
      // gateway strips the live Agent and the cancellation signal before the
      // request crosses the wire. For a top-level session that identity is the
      // session id, which is what the phone pairs its answer with.
      const agentId = typeof value.agentId === 'string' ? value.agentId : undefined
      if (!eventId || !request || !agentId) return
      const inspected = inspectPendingQuestion(eventId, { ...request, sessionId: agentId })
      if (!inspected.ok) {
        // Refused, and it says so. A set the phone never renders is a prompt
        // the operator waits on forever, and the previous behaviour was
        // silence: the parse returned undefined and the event was dropped with
        // nothing to grep. Reason and size only — the event id and the prose of
        // a question are the Host's, not this log's to hold.
        const size = inspected.count === undefined ? '' : ` count=${String(inspected.count)}`
        this.log('warn', `pending question refused reason=${inspected.reason}${size}`)
        return
      }
      this.rememberPendingQuestion(eventId, inspected.value)
      return
    }
    if (value.type === 'cancel' && typeof value.eventId === 'string') {
      this.pendingQuestions.delete(value.eventId)
    }
  }

  /**
   * The one question this handset should be shown for one conversation.
   *
   * The newest, not the first that was ever asked. Insertion order in this Map is
   * arrival order — `rememberPendingQuestion` deletes before it sets — so the tail
   * is the question that just landed. Reading the head instead made a second
   * question in the same session invisible for as long as the first one went
   * unanswered: the phone polled, was handed the older row, and the newer prompt
   * never appeared on screen at all. Measured 10-08 (four events in one session —
   * the later ones were never returned), which is half of why the operator saw
   * questions "jumping off by themselves".
   *
   * Answering is what makes this honest rather than a matter of taste: a settled
   * question leaves the table, so the next read falls back to the one that was
   * hidden behind it. No question is ever skipped — only the order in which they
   * reach the screen changes.
   * @param {string} sessionId
   * @returns {{ rpcId: string, sessionId: string, questions: unknown[] } | null}
   */
  pendingQuestionFor(sessionId) {
    /** @type {{ rpcId: string, sessionId: string, questions: unknown[] } | undefined} */
    let newest
    for (const held of this.pendingQuestions.values()) {
      if (held !== null && typeof held === 'object' && held.sessionId === sessionId) newest = held
    }
    return newest ?? null
  }

  /**
   * @param {string} rpcId
   * @param {string} sessionId
   * @returns {{ rpcId: string, sessionId: string, questions: unknown[] }}
   */
  assertPendingQuestion(rpcId, sessionId) {
    const pending = this.pendingQuestions.get(rpcId)
    if (!pending || pending.sessionId !== sessionId) {
      throw new Error('This question request is no longer pending.')
    }
    // Nothing is re-inserted here any more. Re-inserting on EVERY attempt made an
    // attempt that never landed a permanent one: the refused question sat at the
    // newest end of the arrival order, and because `pendingQuestionFor` offers the
    // newest, the question that had been hiding behind it went back under — the
    // occlusion this card removed for arrivals, re-introduced for refusals
    // (measured 10-08, card 2026-10-08-fix-pocket-question-lost-on-reconnect M-2).
    // The recency bump belongs to the window it was ever meant to protect, which
    // is the outstanding Host call, so it now lives in `respondToQuestion` — where
    // its undo is local.
    return pending
  }

  /**
   * The key that precedes one entry in arrival order, or `null` when it is first.
   * @param {string} eventId
   * @returns {string | null | undefined} undefined when the entry is not on the table
   */
  pendingQuestionPredecessor(eventId) {
    /** @type {string | null} */
    let before = null
    for (const key of this.pendingQuestions.keys()) {
      if (key === eventId) return before
      before = key
    }
    return undefined
  }

  /**
   * Put one entry back into the arrival slot it held.
   *
   * In place, never by replacing the Map: the same object is handed to the
   * downlink (`lib/mux-client.js`), which clears it, so a rebuilt Map would be a
   * table nothing else looks at. Only this entry moves; anything that arrived
   * while the call was outstanding keeps its own order. When the neighbour it was
   * sitting behind is gone (the ceiling took it during the call), the entry goes
   * to the front of the line instead of the back — a question whose answer the
   * Host refused is never the one a phone is shown ahead of its own session's
   * others.
   * @param {string} eventId
   * @param {string | null} predecessor
   * @returns {boolean} true when the order was changed
   */
  restorePendingQuestionSlot(eventId, predecessor) {
    const held = this.pendingQuestions.get(eventId)
    if (held === undefined) return false
    const keys = [...this.pendingQuestions.keys()]
    const at = keys.indexOf(eventId)
    const anchor = predecessor === null ? -1 : keys.indexOf(predecessor)
    if (at === anchor + 1) return false
    /** @type {[string, unknown][]} */
    const rest = []
    for (const [key, value] of this.pendingQuestions) {
      if (key !== eventId) rest.push([key, value])
    }
    this.pendingQuestions.clear()
    if (anchor < 0) {
      this.pendingQuestions.set(eventId, held)
      for (const [key, value] of rest) this.pendingQuestions.set(key, value)
      return true
    }
    for (const [key, value] of rest) {
      this.pendingQuestions.set(key, value)
      if (key === predecessor) this.pendingQuestions.set(eventId, held)
    }
    return true
  }

  /**
   * Hold one unanswered interaction inside {@link PENDING_QUESTIONS_MAX}.
   *
   * There is no deadline in here on purpose (see the constant): the table is
   * bounded because its keys come from the Host, not because a question is
   * assumed to be answered within some window.
   * @param {string} eventId
   * @param {{ rpcId: string, sessionId: string, questions: unknown[] }} pending
   * @returns {void}
   */
  rememberPendingQuestion(eventId, pending) {
    this.pendingQuestions.delete(eventId)
    this.pendingQuestions.set(eventId, pending)
    let evicted = 0
    while (this.pendingQuestions.size > PENDING_QUESTIONS_MAX) {
      const oldest = this.pendingQuestions.keys().next().value
      if (oldest === undefined) return
      this.pendingQuestions.delete(oldest)
      evicted += 1
    }
    if (evicted > 0) {
      // Counted, never named: the dropped keys are the Host's event ids and the
      // prose of a question is not this log's to hold.
      this.pendingQuestionEvictions += evicted
      this.log('warn', `pending questions table at ${String(PENDING_QUESTIONS_MAX)} evicted=${String(evicted)}`)
    }
    // An arrival is the moment the operator should hear about it — the
    // approval notice goes out here, not on a later poll tick.
    this.pushPendingQuestionNotice(eventId, pending)
  }

  /**
   * Settle one forwarded question.
   *
   * `/api/respond` went with the ApiProxy. A forwarded event is now settled
   * through the Gateway's own unary endpoint, which pairs the event with the
   * client generation that received it — so an answer sent after a reconnect
   * is refused rather than applied to a stale question.
   * @param {string} eventId
   * @param {Record<string, unknown>} outcome
   * @returns {Promise<{ ok: boolean, value?: unknown, error?: string }>}
   */
  async respondToQuestion(eventId, outcome) {
    const clientId = this.eventClientId
    if (clientId === undefined) return { ok: false, error: 'Harness event stream is not connected.' }
    // Being answered is being used, for exactly as long as the Host is deciding:
    // bump to the newest end so the ceiling cannot take this question out from
    // under the phone while its own answer is in flight. Held with its slot, so
    // a refusal can give that slot back — see `restorePendingQuestionSlot`.
    const held = this.pendingQuestions.get(eventId)
    const predecessor = held === undefined ? undefined : this.pendingQuestionPredecessor(eventId)
    if (held !== undefined && predecessor !== undefined) {
      this.pendingQuestions.delete(eventId)
      this.pendingQuestions.set(eventId, held)
    }
    const settled = await this.invokeHarness(REMOTE_EVENT_RESULT_ENDPOINT, {
      clientId,
      eventId,
      outcome
    })
    if (settled.ok) {
      this.pendingQuestions.delete(eventId)
      return settled
    }
    // Refused. The question is still unanswered, so it goes back exactly where it
    // was before this attempt: an answer that did not land must not leave the
    // queue reordered, or this entry — which the phone cannot get through — would
    // sit in front of its own session and hide the one it is holding back.
    if (predecessor !== undefined) this.restorePendingQuestionSlot(eventId, predecessor)
    return settled
  }

  /**
   * Report what a projection actually saved, at most once a minute. The numbers
   * are the ones the phone pays over the tunnel, so they belong in the log
   * rather than in a benchmark script.
   *
   * @param {string} label
   * @param {unknown[]} raw
   * @param {unknown} compacted
   */
  noteSavings(label, raw, compacted) {
    // Byte-measuring the boot/RPC payloads double-serializes them on hot
    // paths. Off by default; DSH_POCKET_DEBUG=1 restores the size report.
    if (process.env.DSH_POCKET_DEBUG !== '1') return
    const now = Date.now()
    if (!this._savingsAt) this._savingsAt = new Map()
    const last = this._savingsAt.get(label) ?? 0
    if (now - last < 60_000) return
    this._savingsAt.set(label, now)
    try {
      const before = Buffer.byteLength(JSON.stringify(raw))
      const after = Buffer.byteLength(JSON.stringify(compacted))
      this.log('info', `${label} ${raw.length} ${Math.round(before / 1024)}KB -> ${Math.round(after / 1024)}KB`)
    } catch {
      // A payload that cannot be measured must never break the response.
    }
  }

  /** @param {unknown[]} raw @param {unknown} compacted */
  noteRecordSavings(raw, compacted) {
    this.noteSavings('records', raw, compacted)
  }

  /**
   * Render the pairing QR once per pairing URL and memoize the SVG. The tunnel
   * status route is polled every 800ms; re-encoding the same URL on every poll
   * was pure CPU. The cache is cleared in rotatePairingToken (the URL changes)
   * and in revokeMobileSessions.
   * @param {string | null | undefined} pairingUrl
   * @returns {string}
   */
  pairingQrSvg(pairingUrl) {
    if (!pairingUrl) return ''
    const cached = this.qrSvgCache.get(pairingUrl)
    if (cached !== undefined) return cached
    const svg = renderQrSvg(pairingUrl, { width: 260, margin: 1 })
    this.qrSvgCache.set(pairingUrl, svg)
    return svg
  }

  /**
   * Read one fixed process-lifetime image path, caching the Buffer after the
   * first successful read. The brand-logo and app-icon paths never change for
   * the life of the process, so every later request skips disk entirely.
   * @param {string} path
   * @returns {Promise<Buffer>}
   */
  async readCachedImage(path) {
    const cached = this.imageBufferCache.get(path)
    if (cached !== undefined) return cached
    const body = await readFile(path)
    this.imageBufferCache.set(path, body)
    return body
  }

  html(response, body) {
    if (response.destroyed) return
    response.statusCode = 200
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(body)
  }

  /**
   * @param {import('node:http').ServerResponse} response
   * @param {string} location
   */
  redirect(response, location) {
    response.statusCode = 302
    response.setHeader('location', location)
    response.end()
  }

  /**
   * @param {import('node:http').ServerResponse} response
   * @param {number} status
   * @param {string} body
   */
  text(response, status, body) {
    if (response.destroyed) return
    response.statusCode = status
    response.setHeader('content-type', 'text/plain; charset=utf-8')
    response.end(body)
  }

  /**
   * @param {import('node:http').ServerResponse} response
   * @param {number} status
   * @param {unknown} body
   */
  json(response, status, body) {
    if (response.destroyed) return
    if (response.headersSent) {
      response.end()
      return
    }
    response.statusCode = status
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.end(JSON.stringify(body))
  }
}

/** Adapter descriptions / interface names that belong to VMs / tunnels rather than real LAN. */
const VIRTUAL_ADAPTER_PATTERN = /vbox|vmware|vethernet|wsl|hyper-v|docker|tailscale|zerotier|virtual/i
const LAN_ADDRESS_TTL_MS = 60_000

/**
 * Pick the best private IPv4 LAN address from local network interfaces,
 * skipping known virtual/tunnel adapters (WSL, Hyper-V, VMware, Docker, etc.).
 * Accepts an optional interfaces map for deterministic testing.
 * @param {Record<string, import('node:os').NetworkInterfaceInfo[] | undefined>} [interfaces]
 * @returns {string | undefined}
 */
export function findLanAddress(interfaces = networkInterfaces()) {
  // Pass 1: non-virtual adapters
  for (const [name, entries] of Object.entries(interfaces)) {
    if (VIRTUAL_ADAPTER_PATTERN.test(name)) continue
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateAddress(entry.address)) {
        return entry.address
      }
    }
  }
  // Pass 2: fallback to any private adapter if all are named with virtual keywords
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateAddress(entry.address)) {
        return entry.address
      }
    }
  }
  return undefined
}

/**
 * Parse the PowerShell `ip|description` output, dropping virtual adapters and
 * malformed lines. Exported for backward compatibility with existing tests.
 * @param {string} output
 * @returns {{ ip: string, description: string }[]}
 */
export function parseLanAdapterLines(output) {
  /** @type {{ ip: string, description: string }[]} */
  const entries = []
  for (const line of String(output).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf('|')
    if (separator === -1) continue
    const ip = trimmed.slice(0, separator).trim()
    const description = trimmed.slice(separator + 1).trim()
    if (!ip || VIRTUAL_ADAPTER_PATTERN.test(description)) continue
    entries.push({ ip, description })
  }
  return entries
}

/** @type {{ address: string | undefined, expiresAt: number }} */
const lanAddressCache = { address: undefined, expiresAt: 0 }

/** @returns {string | undefined} */
export function preferredLanAddress() {
  const now = Date.now()
  if (lanAddressCache.address !== undefined && lanAddressCache.expiresAt > now) {
    return lanAddressCache.address
  }
  const picked = findLanAddress()
  lanAddressCache.address = picked
  lanAddressCache.expiresAt = now + LAN_ADDRESS_TTL_MS
  return picked
}

/**
 * @param {string} address
 * @returns {string}
 */
export function normalizeRemoteAddress(address) {
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

/**
 * @param {string} address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  return address === '::1' || address === '127.0.0.1'
}

/**
 * @param {string} address
 * @returns {boolean}
 */
export function isPrivateAddress(address) {
  if (isLoopbackAddress(address)) return true
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true
  const match = /^172\.(\d+)\./.exec(address)
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true
  return /^f[cd][0-9a-f]{2}:/i.test(address) || /^fe8[0-9a-f]:/i.test(address)
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<string>}
 */
async function readBody(request, maxBytes = MAX_BODY_BYTES) {
  /** @type {Buffer[]} */
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * @param {string | string[] | undefined} value
 * @returns {string | undefined}
 */
function firstHeaderValue(value) {
  const first = Array.isArray(value) ? value[0] : value?.split(',', 1)[0]
  const normalized = first?.trim()
  return normalized || undefined
}

/**
 * @param {string} host
 * @returns {boolean}
 */
export function isInternetTunnelHost(host) {
  const normalized = host.toLowerCase().replace(/\.$/, '')
  return (
    (normalized.endsWith('.trycloudflare.com') && normalized !== 'api.trycloudflare.com') ||
    normalized.endsWith('.pinggy.link') ||
    normalized.endsWith('.pinggy-free.link') ||
    normalized.endsWith('.pinggy.online')
  )
}

/**
 * Short device label from the pairing request's User-Agent.
 * @param {unknown} ua
 * @returns {string}
 */
function uaLabel(ua) {
  if (typeof ua !== 'string' || ua.length === 0) return 'Phone'
  const canonical = canonicalDeviceAgent(ua)
  if (canonical && canonical !== ua && canonical !== 'no-agent') {
    return canonical.slice(0, 40)
  }
  return ua.slice(0, 40)
}
