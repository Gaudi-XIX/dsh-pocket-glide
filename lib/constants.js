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
export const PIN_FAIL_WINDOW_MS = 10 * 60 * 1000
export const PIN_FAIL_PER_IP = 5
export const PIN_FAIL_GLOBAL = 20
export const MUX_RECONNECT_MS = 500
export const MUX_RECONNECT_CAP_MS = 30_000

/**
 * Mobile session cookie lifetime.
 * Changed from the source's one year (Max-Age=31536000) to 30 days.
 */
export const MOBILE_COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000

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
    args: (payload) => ({
      agentId: payload.sessionId,
      line: payload.line,
      ...(payload.submittedAttachments?.length
        ? { submittedAttachments: payload.submittedAttachments }
        : {})
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
  'permissionPresets.catalog': { endpoint: 'permissionPresets/catalog', args: () => ({}) }
}

/** Methods whose request bodies may carry base64 data and use the large tier. */
export const LARGE_BODY_METHODS = new Set(['file.upload', 'session.prompt'])

/** Resolve the per-method read ceiling. */
export function bodyLimitForMethod(method) {
  return LARGE_BODY_METHODS.has(method) ? LARGE_BODY_BYTES : MAX_BODY_BYTES
}

export const RPC_ALLOWLIST = new Set([...Object.keys(HARNESS_ENDPOINTS), 'session.history', 'workspace.list'])
