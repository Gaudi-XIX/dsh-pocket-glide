import { randomUUID } from 'node:crypto'

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
 * It stays at 6 here for one reason, and it is a cross-file reason: the mobile
 * field in `lib/pages.js` is `maxlength="6" pattern="\d{6}"` on BOTH the pairing
 * PIN page and the reconnect page. Issuing a longer password than the phone can
 * type would make a fresh tunnel pairing impossible to complete (and a durable
 * reset would lock the user out of their own password), so the width moves only
 * together with that field — see the seam note in the change handoff.
 *
 * The strength that does not need the phone to change is the lockout: ten
 * failures on one key now put a wall up that no sliding window takes down.
 */
export const PAIRING_PIN_DIGITS = 6
/** `randomInt` upper bound for {@link PAIRING_PIN_DIGITS}. */
export const PAIRING_PIN_SPACE = 10 ** PAIRING_PIN_DIGITS

/**
 * A password already on disk stays usable across a width change, so raising
 * {@link PAIRING_PIN_DIGITS} never silently invalidates a paired phone's
 * durable password — and an older build reading a newer file is just as safe.
 */
export const PAIRING_PIN_MIN_DIGITS = 6
export const PAIRING_PIN_MAX_DIGITS = 12
/** Pattern the persisted password has to match to be loaded or saved at all. */
export const PAIRING_PIN_PATTERN = new RegExp(`^\\d{${PAIRING_PIN_MIN_DIGITS},${PAIRING_PIN_MAX_DIGITS}}$`)

export const PIN_FAIL_WINDOW_MS = 10 * 60 * 1000
export const PIN_FAIL_PER_IP = 5
export const PIN_FAIL_GLOBAL = 20
/**
 * Failures on one limit key after which the key is locked until the desktop
 * changes the password (reset / consent off / revoke) or the bridge restarts.
 * A `Retry-After` alone only slowed a scripted guesser down; a window that
 * keeps sliding its own stamps never closed.
 */
export const PIN_FAIL_HARD_LOCK = 10
/** First lockout a limited key is told about, in seconds. */
export const PIN_FAIL_BASE_SECONDS = 15
/** Ceiling of one backoff step, in seconds. */
export const PIN_FAIL_MAX_SECONDS = 15 * 60
/** How long a hard-locked key stays locked; cleared by a desktop password action. */
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

/** Lifetime of the one-time `/desktop?k=` bootstrap token. */
export const DESKTOP_BOOTSTRAP_TTL_MS = 10 * 60 * 1000

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
  }
}

/** Methods whose request bodies may carry base64 data and use the large tier. */
export const LARGE_BODY_METHODS = new Set(['file.upload', 'session.prompt'])

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
 * origin (an `text/html` answer would otherwise run on the bridge's own
 * origin, where every RPC is same-origin).
 */
export const INLINE_ATTACHMENT_TYPES = ['image/']

export const RPC_ALLOWLIST = new Set([...Object.keys(HARNESS_ENDPOINTS), 'session.history', 'workspace.list'])
