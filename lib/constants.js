import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The DSH per-user data root: `DSH_HOME` when it is set, otherwise `~/.dsh`.
 *
 * This is the single source for that rule (R12/Q8). It used to live only in
 * `lib/file-log.js`, while the pairing-password store and the tunnel cache each
 * resolved their own location out of `%LOCALAPPDATA%` — so a run isolated by
 * setting `DSH_HOME` (the way a debug clone or this repo's own test gate
 * separates itself) still read and wrote the REAL machine's long-lived pairing
 * password, and every "our tests never touch real data" claim was false.
 * @returns {string}
 */
export function defaultDshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/**
 * True when an isolated data root is in force. Callers must then treat the
 * pre-unification per-user directories as not theirs: reading them would put a
 * real machine's durable pairing password into an isolated run.
 * @returns {boolean}
 */
export function dshHomeOverridden() {
  return Boolean(process.env.DSH_HOME?.trim())
}

/**
 * Where Pocket keeps its own files under the data root.
 * @param {...string} segments
 * @returns {string}
 */
export function pocketDataDir(...segments) {
  return join(defaultDshHome(), 'pocket', ...segments)
}

export const MAX_BODY_BYTES = 64 * 1024
/**
 * Upper tier for RPCs whose payload carries base64 file data.
 * The host caps a raw upload at 25MB; base64 inflates bytes by 4/3, so the
 * accepted request ceiling is 25MB × 1.4.
 */
export const LARGE_BODY_BYTES = Math.ceil(25 * 1024 * 1024 * 1.4)
export const PAIRING_TTL_MS = 5 * 60 * 1000
export const PIN_TTL_MS = PAIRING_TTL_MS

/**
 * Length of the pairing password. Numeric on purpose: the phone's password
 * field keeps `inputmode=numeric`, and the desktop panel renders the value on
 * one line, so length — not alphabet — is the dial that widens the search
 * space.
 *
 * The width itself is 6 — short enough to read off the desktop panel and type
 * on a phone keypad in one glance (2026-10-10: it used to be 8, which users
 * kept mistyping). What makes that safe to change is a different constant:
 * the mobile field in `lib/pages.js` accepts the whole compatible range
 * (`maxlength="12" pattern="\d{6,12}"`) on BOTH the pairing PIN page and the
 * reconnect page, so a phone that still holds an older 6-to-12-digit durable
 * password pairs just as well as a freshly issued 6-digit one, and a phone that
 * typed 8 digits last week is not locked out either. Moving this
 * value is therefore a one-file change — the only way to break it again is
 * to narrow that field down to exactly this width, which `test/pin-field-width`
 * pins against. See the seam note in the change handoff.
 *
 * The strength that does not need the phone to change is the lockout: ten
 * failures on one key now put a wall up that no sliding window takes down.
 */
export const PAIRING_PIN_DIGITS = 6
/** `randomInt` upper bound for {@link PAIRING_PIN_DIGITS}. */
export const PAIRING_PIN_SPACE = 10 ** PAIRING_PIN_DIGITS

/**
 * A password already on disk stays usable across a width change, so moving
 * {@link PAIRING_PIN_DIGITS} never silently invalidates a paired phone's
 * durable password — and an older build reading a newer file is just as safe.
 * The floor stays at 6 — the narrowest width this build has ever issued — so
 * every durable password on disk is admissible, while the ceiling leaves room
 * for a future width to be raised without a migration.
 */
export const PAIRING_PIN_MIN_DIGITS = 6
export const PAIRING_PIN_MAX_DIGITS = 12
/** Pattern the persisted password has to match to be loaded or saved at all. */
export const PAIRING_PIN_PATTERN = new RegExp(`^\\d{${PAIRING_PIN_MIN_DIGITS},${PAIRING_PIN_MAX_DIGITS}}$`)

export const PIN_FAIL_WINDOW_MS = 10 * 60 * 1000
export const PIN_FAIL_PER_IP = 5
export const PIN_FAIL_GLOBAL = 20
/**
 * Failures on one limit key after which the key is hard-locked for a fixed
 * PIN_FAIL_LOCKOUT_MS wall: while locked, the verify pre-check answers 429
 * before a failure is counted, so attempts never re-arm the clock. A desktop
 * password action (reset / consent toggle) clears the lock early, and a
 * restart clears it trivially (the state lives in memory). A `Retry-After`
 * alone only slowed a scripted guesser down; a window that keeps sliding its
 * own stamps never closed.
 */
export const PIN_FAIL_HARD_LOCK = 10
/** First lockout a limited key is told about, in seconds. */
export const PIN_FAIL_BASE_SECONDS = 15
/** Ceiling of one backoff step, in seconds. */
export const PIN_FAIL_MAX_SECONDS = 15 * 60
/** How long a hard-locked key stays locked; expires on its own, or is cleared early by a desktop password action. */
export const PIN_FAIL_LOCKOUT_MS = 15 * 60 * 1000
/** Distinct limit keys held before the least recently used ones are dropped. */
export const PIN_FAIL_KEYS_MAX = 512
/** Sessions, suspended and resumable device maps. */
export const DEVICE_MAP_CAP = 16
/**
 * How recently a LAN device has to have been seen for its address to be taken
 * as proof of identity when it presents no cookie. The cookie path is
 * unaffected; this only closes "any process on that address, forever".
 */
export const LAN_ADDRESS_WINDOW_MS = 60 * 1000
export const MUX_RECONNECT_MS = 500
export const MUX_RECONNECT_CAP_MS = 30_000

/**
 * Mobile session cookie lifetime.
 * Changed from the source's one year (Max-Age=31536000) to 30 days.
 */
export const MOBILE_COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Debounce for the durable-session write (lib/session-store.js). Session
 * changes arrive one request at a time; a burst of pairing/reconnect traffic
 * must cost one disk write, not one per request. Deliberately well under any
 * human-visible interval — a restart inside this window only loses the last
 * few hundred milliseconds of pairing state, and stop() flushes synchronously.
 */
export const SESSION_PERSIST_DEBOUNCE_MS = 500

/**
 * Desktop pairing-session cookie lifetime. The pairing window is a long-lived
 * surface (it sits open across many five-minute pairing tokens), so this is a
 * working day rather than the session's own life; past it the desktop re-redeems
 * its one-time `/desktop?k=` link.
 */
export const DESKTOP_COOKIE_TTL_MS = 12 * 60 * 60 * 1000

/**
 * Bounds on the paging arguments a phone may ask `session.history` to fetch.
 * `typeof NaN === 'number'` is true, so a bare type check let NaN, negatives
 * and 1e9 through to the Host's `session/page` verbatim, and the third
 * fallback attempt then widened them with `Math.max(max, 60)` — one RPC was
 * enough to make the desktop serialise an unbounded page.
 * A value outside these bounds is refused with 400 rather than silently
 * clamped, so "load older" never quietly starts fetching a smaller page.
 */
export const HISTORY_PAGE_DEFAULT_MESSAGES = 30
export const HISTORY_PAGE_MAX_MESSAGES = 200
/** Same guard for the `session.list` row cap and the backwards-page cursor. */
export const SESSION_LIST_MAX_ROWS = 500
/** A log offset: a non-negative integer, `0` being a legitimate value. */
export const SESSION_SEQ_MAX = Number.MAX_SAFE_INTEGER

/**
 * How many history cursors the bridge remembers — one per conversation the
 * phone has paged through since it started. A cursor is an optimisation and
 * never a fact: dropping one only costs re-resolving it from the session list
 * the caller is holding anyway. So this is a CEILING with least-recently-read
 * eviction, deliberately not a TTL — no cursor is retired for having existed
 * too long, and nothing here changes when a cursor is considered valid.
 */
export const SESSION_CURSOR_MAX = 128

/**
 * Minimum spacing between two cold-path prewarms (2026-10-10: the connect page is
 * supposed to arrive with its content already loading). The unauthenticated connect
 * page and the tunnel-start event both ask the bridge to put the session catalogue
 * in flight ahead of the phone, because the one expensive Host read on the cold path
 * is exactly that catalogue (measured 2026-10-09: 469 rows / ~195 KB / 465-719 ms).
 * The read is loopback-cheap but not free, so a page reload or a flapping tunnel
 * must not stampede the Host.
 */
export const POCKET_PREWARM_MIN_MS = 20_000

/**
 * How many unanswered interactions the bridge holds.
 *
 * A question stays answerable while it is on the phone's screen, whatever the
 * clock says, so this table gets a ceiling and eviction rather than an expiry:
 * adding a deadline here would silently turn “come back and answer it later”
 * into “that question expired”, which is a product change and not this card's.
 * Past the ceiling the least recently looked-at question gives way; the phone
 * then gets the same “no longer pending” answer a settled question would give.
 */
export const PENDING_QUESTIONS_MAX = 64

/** Lifetime of the one-time `/desktop?k=` bootstrap token. */
export const DESKTOP_BOOTSTRAP_TTL_MS = 10 * 60 * 1000

/** How often the completion notifier polls the Host session list for a running→done edge. */
export const NOTIFY_POLL_MS = 30_000
/**
 * A phone page this fresh is treated as LIVE, and live pages are never pushed to:
 * whatever the notice would say is already visible on the page in real time (user
 * 2026-10-12: 「只要停留在 Pocket 手机的前台页面…就不通知了」). The liveness evidence
 * is the existing auth cadence — the page's long event poll re-authenticates every
 * few seconds (EVENT_HOLD_MS rhythm), and hiding the tab pauses that poll
 * (visibilitychange → pauseEventPolling), so a stale lastSeenAt means "not watching".
 * 30s ≈ three poll periods: fresh enough to suppress while watching, quick enough
 * that a backgrounded phone misses at most one 30s notify tick before pushes resume.
 */
export const MOBILE_LIVE_FRESH_MS = 30_000
/** Push channels lib/notify.js knows how to deliver; the settings endpoint refuses the rest. */
export const NOTIFY_CHANNELS = ['off', 'serverchan', 'bark', 'wxpusher', 'clawbot']

/**
 * Idle gap between two ClawBot (iLink) getupdates polls that returned nothing.
 *
 * A real getupdates holds the request for its `timeout` seconds, so an empty
 * batch has already waited on the server. A stubbed endpoint (tests) or a
 * degraded one answers instantly, and without a floor the poll loop would spin
 * the event loop. This is a floor between attempts, not a rate limit: a batch
 * that carried messages is polled again immediately.
 */
export const CLAWBOT_IDLE_POLL_MS = 1000

/**
 * Outbound pushes a WeChat ClawBot may send per inbound message from the user.
 *
 * The iLink protocol does not carry a TTL for `context_token`: the limit is a
 * quota, refreshed by the next inbound message. WeChat documents it as "every 10
 * messages sent, the user must start a conversation again" (plus once per 24h),
 * and a controlled experiment on this machine measured exactly that — one
 * inbound message bought 10 sends (the "channel ready" acknowledgement burned
 * the first), the 11th came back `ret=-2 prepare failed`. So `prepare failed`
 * means "no quota / no token", never "the token timed out".
 *
 * The number is the user's, not ours: it rides along in the push text as
 * 「第 N/10 条」so they can see the quota draining and know when to answer a
 * message in WeChat. A probe script sharing the same bot account burns the same
 * quota, which is why an in-process counter is a label and not a guarantee.
 */
export const CLAWBOT_QUOTA_LIMIT = 10

/**
 * Longest tunnel hostname, in characters, that Pocket accepts — from the
 * desktop panel endpoint and from a hand-edited settings file alike. This is
 * NOT the DNS wire cap (253, enforced by the shape check in lib/bridge.js);
 * it is the pairing-QR budget: the QR encodes `https://<hostname>/pair?token=<43>`,
 * a fixed 63 bytes plus the hostname, and the largest QR version the renderer
 * supports tops out at exactly 213 bytes (lib/qr-svg.js BYTE_CAPACITY at
 * MAX_VERSION, ECL-M) — so 63 + 150 = 213. Every cap site (settings-store read
 * and merge, the panel endpoint's explicit 400) reads this one constant, and
 * the coupling test in test/tunnel.test.js fails if the QR side drifts. Raising
 * this value is a two-file change: here AND the QR capacity in lib/qr-svg.js,
 * together.
 */
export const TUNNEL_HOSTNAME_MAX_LENGTH = 150

/**
 * How long a PIN-verified phone waits for the desktop to approve its pairing,
 * and the poll cadence the bridge hands the phone for `/pair/pending`.
 */
export const PAIR_CONFIRM_TTL_MS = 60_000
export const PAIR_POLL_AFTER_MS = 2000

/**
 * The public-access acknowledgement cookie (design #3c): set once by
 * `POST /consent/accept`, checked by the tunnel-side gate for a year.
 */
export const CONSENT_COOKIE = 'dsh_consent'
export const CONSENT_MAX_AGE_S = 31536000

/**
 * Build the per-response Content Security Policy.
 *
 * `'self'` on `style-src`/`script-src` is what lets the app load its own hashed
 * stylesheet and script (/app.css, /app.js). Inline scripts are authorized by
 * the request's nonce instead of `'unsafe-inline'`; the same nonce is passed to
 * the page renderers, so every inline opening tag carries it. Without it a
 * phone renders the bare markup — no styling, no behaviour (observed live
 * 2026-10-01, right after the shell was split into assets).
 *
 * @param {string} nonce
 * @returns {string}
 */
export function buildContentSecurityPolicy(nonce) {
  return `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'`
}

/** SSE keepalive comment interval for forwarded session streams. */
export const SSE_KEEPALIVE_MS = 15_000

/**
 * Reconnect cadence a phone is told to use for a session stream, and the ceiling
 * it may be pushed to after repeated failures (§3 / X4③).
 *
 * The field used to be a constant `retry: 500`, and every reconnect that follows
 * it opens another carrier WebSocket into the Host. While the Host was down that
 * turned one idle phone into two WebSocket attempts a second, forever, with
 * nothing on disk to explain where the traffic came from. Escalating the number
 * the browser already obeys is the smallest shape that stops it: the value stays
 * 500 for a session that has never failed, so the healthy path is byte-identical
 * to before.
 */
export const STREAM_RETRY_BASE_MS = 500
export const STREAM_RETRY_CAP_MS = 15_000
/** How many conversations' reconnect state one bridge keeps before the oldest go. */
export const STREAM_BACKOFF_KEYS_MAX = 128

/**
 * Default cadence of the connection-state frames pushed down a session stream.
 * The phone skips its HTTP status poll while these keep arriving, so this
 * replaces the old round trip; the settings underneath are cached, so the
 * frames cost no harness traffic of their own. Overridable per bridge via the
 * `sseStatusMs` constructor option (tests use a small value).
 */
export const SSE_STATUS_MS = 30_000

/** Gateway stream carrier: one WebSocket multiplexing every logical stream. */
export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'
/** Gateway-internal stream delivering forwarded Cordis events. */
export const REMOTE_EVENT_STREAM_ENDPOINT = '$events'
/** Gateway-internal unary endpoint settling one forwarded event. */
export const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'
/** Waterfall event a Host raises when it needs an answer from the user. */
export const USER_QUESTION_EVENT = 'user-questions/request'
export const EVENT_STREAM_ID = 'mobile-events'
export const WORKSPACE_STREAM_ID = 'mobile-workspaces'
export const MUX_STABLE_MS = 5_000

/**
 * Mobile method name to the Host endpoint that serves it.
 *
 * 0.1.2-alpha.1 deleted `dsh-host-apiproxy`, whose string-keyed `/api/<name>`
 * routes this bridge was written against, and moved the same operations onto
 * Typert Remote. The transport is unchanged — same `/api` prefix, same
 * client-request envelope — but an endpoint is now `<namespace>/<method>` and
 * its payload carries named args rather than a bare object. Several shapes
 * moved too, so each entry owns its own translation instead of a blanket
 * rename.
 *
 * The mobile page's vocabulary is deliberately left alone: it is served from
 * this file, but a phone may still be holding an older page.
 */
export const HARNESS_ENDPOINTS = {
  'agentPreset.list': { endpoint: 'agentPresets/list', args: () => ({}) },
  // The preset selector is keyed by agent id, which for a top-level session is
  // the session id the mobile page already sends.
  'agentPreset.select': {
    endpoint: 'agentPresets/select',
    args: (payload) => ({ agentId: payload.sessionId, agentPreset: payload.agentPreset })
  },
  'session.list': { endpoint: 'session/list', args: () => ({ _request: {} }) },
  // The catalog is no longer per-session: it describes what the Host can route
  // to, so it takes no arguments and the page's sessionId is dropped.
  'session.models': { endpoint: 'session/modelCatalog', args: () => ({}) },
  'session.selectModel': {
    endpoint: 'session/selectModel',
    args: (payload) => ({ request: payload })
  },
  'session.create': { endpoint: 'session/create', args: (payload) => ({ request: payload }) },
  'session.prompt': {
    endpoint: 'session/prompt',
    // requestId must come last so a client payload cannot pin/override it.
    args: (payload) => ({ request: { ...payload, requestId: randomUUID() } })
  },
  'session.cancel': { endpoint: 'session/cancel', args: (payload) => ({ request: payload }) },
  // No-arg call returning every settings namespace at once; the page only reads
  // ui-conversation.busyEnter and ui-chat.transcriptView / performanceUsage.
  'settings.describe': { endpoint: 'settings/describe', args: () => ({}) },
  // Slash-command execution: compact / permission / goal / plan / feedback.
  // The host receives the agent (session) id, the raw line, and, only when the
  // composer actually holds drafts, the submitted image/file attachments.
  'command.execute': {
    endpoint: 'commands/execute',
    // submittedAttachments is always forwarded (empty array for plain
    // invocations): the host handler reads `.length` unconditionally and an
    // omitted parameter throws before the command runs.
    args: (payload) => ({
      agentId: payload.sessionId,
      line: payload.line,
      submittedAttachments: Array.isArray(payload.submittedAttachments)
        ? payload.submittedAttachments
        : []
    })
  },
  // Generic (non-image) file upload: the base64 payload rides the large body
  // tier (see LARGE_BODY_BYTES). `name` is forwarded only when provided.
  'file.upload': {
    endpoint: 'fileUploads/upload',
    args: (payload) => ({
      agentId: payload.sessionId,
      request: { data: payload.data, ...(payload.name ? { name: payload.name } : {}) }
    })
  },
  // Permission preset catalog (options/defaultPreset/currentPreset); no args.
  // Best-effort: the mobile permission row falls back to the three standard
  // names if the host does not expose this service.
  'permissionPresets.catalog': { endpoint: 'permissionPresets/catalog', args: () => ({}) },
  // Slash-menu catalogs. `skills/list` declares a single json-wire param named
  // `request` (Typert wraps it), while `commands/list` scopes on the agent
  // lookup, whose wire name is `agentId` — passed flat.
  'skills.list': {
    endpoint: 'skills/list',
    args: (payload) => ({ request: { sessionId: payload.sessionId } })
  },
  'commands.list': {
    endpoint: 'commands/list',
    args: (payload) => ({ agentId: payload.sessionId })
  },
  // Live projection values for one session (the inbox queue, goal state,
  // todos, model selection, ...). The page already reads them off history
  // pages and stream snapshots; this endpoint is the light in-between refresh
  // that keeps the queue dock and goal bar current while a turn is running
  // (see the projections sync debounce in the page).
  'session.projections': {
    endpoint: 'session/projections',
    // The host declares a single json param named `request` wrapping
    // `{ sessionId }` (live-probed 2026-10-05: a flat sessionId 400s with
    // `missing "request"`).
    args: (payload) => ({ request: { sessionId: payload.sessionId } })
  },
  // Edit / recall / steer one queued inbox item while its turn is still
  // pending — the desktop QueueDock's row actions, passed through. The whole
  // call rides a single json param named `request` (Typert wrap, verified in
  // the host's endpoint catalog).
  'session.updateQueue': {
    endpoint: 'session/updateQueue',
    args: (payload) => ({ request: payload })
  },
  // GoalBar verbs — pause / resume / clear / edit the session's long-running
  // goal. Flat args (typert descriptors, probed 2026-10-09 from the host
  // catalog): a plain agentId plus the CAS `ref` {id,revision} read from the
  // goal projection at call time; edit additionally carries the json
  // `request` ({objective}). A stale ref is the host's guard
  // (GOAL_STALE_REVISION), not ours — the page just re-syncs.
  'goals.pause': {
    endpoint: 'goals/pause',
    args: (payload) => ({ agentId: payload.sessionId, ref: payload.ref })
  },
  'goals.resume': {
    endpoint: 'goals/resume',
    args: (payload) => ({ agentId: payload.sessionId, ref: payload.ref })
  },
  'goals.clear': {
    endpoint: 'goals/clear',
    args: (payload) => ({ agentId: payload.sessionId, ref: payload.ref })
  },
  'goals.edit': {
    endpoint: 'goals/edit',
    args: (payload) => ({ agentId: payload.sessionId, ref: payload.ref, request: payload.request })
  },
  // Pin / unpin one session in the workspace registry — the desktop sidebar's
  // pin, passed through (2026-10-13, the phone had always dropped the field).
  // The host declares a single json param named `request` wrapping `{ sessionId }`
  // (asar typert descriptor read 2026-10-13: WorkspacePinSessionRequest), and the
  // result carries the FULL latest `pinnedSessionIds` set, so the page applies the
  // return value instead of waiting for a follow frame.
  'workspace.pin': {
    endpoint: 'workspace/pinSession',
    args: (payload) => ({ request: { sessionId: payload.sessionId } })
  },
  'workspace.unpin': {
    endpoint: 'workspace/unpinSession',
    args: (payload) => ({ request: { sessionId: payload.sessionId } })
  }
}

/**
 * Methods whose request bodies may carry base64 data and use the large tier.
 *
 * `command.execute` belongs here for the same reason as `session.prompt`: the
 * page forwards the composer's image drafts as `submittedAttachments` when the
 * command is `/goal` or `/plan`, so the body carries the same base64 an
 * ordinary prompt does. Leaving it in the 64 KB tier refused every attachment
 * that rode a command with `Request body is too large.` (the phone showed its
 * optimistic row and then dropped it again), which is exactly the failure the
 * 2026-10-06 pocket investigation traced.
 *
 * `session.updateQueue` stays in the large tier as defensive headroom: its
 * `action` may in principle carry a `content` array, but the phone's edit path
 * sends plain text only today (the edit button is hidden on rows that already
 * carry images or files), so no live request rides this tier with image data.
 */
export const LARGE_BODY_METHODS = new Set([
  'file.upload',
  'session.prompt',
  'command.execute',
  'session.updateQueue'
])

/** Resolve the per-method read ceiling. */
export function bodyLimitForMethod(method) {
  return LARGE_BODY_METHODS.has(method) ? LARGE_BODY_BYTES : MAX_BODY_BYTES
}

/**
 * How much of an RPC body may be buffered before its `method` key has to have
 * shown up. The mobile envelope always opens with the method, so a body that
 * hides it behind this much padding is not this client's own request — and the
 * ceiling it is asking for cannot be resolved any earlier.
 */
export const RPC_METHOD_PROBE_BYTES = 2048

/**
 * How long a refused RPC body may keep draining before the 413 is answered
 * anyway. Node destroys a socket whose response finishes over an unfinished
 * request, so answering at once resets a peer that still has bytes to send and
 * it never reads the status. The refused body is dropped at the socket layer
 * either way — it is never buffered — this only bounds how long the answer
 * waits for a client that has stopped sending.
 */
export const RPC_REFUSAL_DRAIN_MS = 250

/**
 * Prefixes an attachment's media type has to carry to be served inline.
 * The type comes straight off the Host's stored record, so anything outside
 * this set is handed back as a download instead of being rendered under this
 * origin (a `text/html` answer would otherwise run on the bridge's own
 * origin, where every RPC is same-origin).
 */
export const INLINE_ATTACHMENT_TYPES = ['image/']

// interaction.pending / interaction.answer / interaction.cancel are dispatched
// before this set is ever consulted (the question branch in handle(), bridge.js
// :2677-2695), so their absence here is deliberate — adding them would only
// invite a second dispatch path (bridge-review pins this set's size).
export const RPC_ALLOWLIST = new Set([...Object.keys(HARNESS_ENDPOINTS), 'session.history', 'workspace.list'])

/**
 * Map a Host tool name onto the step-process activity category the mobile page
 * narrates it with ("正在读取文件" / "已读取文件" / …).
 *
 * This is a verbatim port of the Host client's own `activity(name)` mapping
 * (app.asar lib/types/client/conversation-nodes/process-activity.js, read
 * 2026-10-07) so the phone speaks the same verb language as the desktop panel:
 * exact names first, then the wildcard families the Host actually registers
 * (`*_inspect` search views, `terminal_*` command surfaces, `subagent_*`
 * coordination calls), and finally the generic "tools" bucket for anything
 * a plugin invents tomorrow. The function must stay dependency-free — it is
 * serialized into the phone page with `.toString()` and runs in the browser.
 * @param {unknown} name - raw tool name off a `tool/call` event
 * @returns {'read'|'readImage'|'search'|'write'|'edit'|'commands'|'code'|'webSearch'|'webFetch'|'subagents'|'plan'|'questions'|'tools'}
 */
export function toolActivityCategory(name) {
  const n = String(name || '')
  if (n === 'read') return 'read'
  if (n === 'read_image') return 'readImage'
  if (n === 'grep' || n === 'glob' || n.endsWith('_inspect')) return 'search'
  if (n === 'write') return 'write'
  if (n === 'edit' || n === 'apply_patch') return 'edit'
  if (['bash', 'pwsh', 'exec_command', 'write_stdin'].includes(n) || n.startsWith('terminal_')) return 'commands'
  if (n === 'run_code') return 'code'
  if (n === 'web_search') return 'webSearch'
  if (n === 'web_fetch') return 'webFetch'
  if (n === 'subagent' || n.startsWith('subagent_')) return 'subagents'
  if (['todo_write', 'create_goal', 'update_goal', 'get_goal'].includes(n)) return 'plan'
  if (n === 'ask_user_question' || n === 'request_user_input') return 'questions'
  return 'tools'
}
