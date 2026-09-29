/**
 * Harness RPC invocation for the phone bridge.
 *
 * The phone never talks to `/api/<ns>/<method>` itself — the bridge does, from
 * inside the host process, attaching its own redeemed browser-auth cookie.
 * The transport envelope is the ONLY thing that changed between the DSH
 * Desktop community build the original bridge targeted and the official
 * 0.2.0-rc.1 host: the endpoint NAMES are all still there verbatim (proved in
 * F:\defws\docs\dsh-desktop-mobile-bridge-recovered.md §4), but they now have
 * to be wrapped.
 *
 * ENVELOPE (proved by reading the live app.asar, report in
 * F:\defws\tmp\20260929-dsh-remote-composer\FINDINGS-ep-wire-shapes.md):
 *
 *   POST /api/<ns>/<method>
 *   content-type: application/json
 *   {
 *     "type": "client-request",
 *     "rpcId": "<unique id>",
 *     "method": "<ns>/<method>",        // MUST equal the path endpoint
 *     "payload": { "args": { ... } }
 *   }
 *
 *   response:
 *   { "type": "server-response", "rpcId": "<echoed id>",
 *     "result": { "ok": true, "value": ... }
 *             | { "ok": false, "error": { "code", "message", "details" } } }
 *
 * `rpcId` is echoed and MUST match, and the response carries a `type`
 * discriminator. Error results are NOT transport errors, which is why this
 * module throws on `result.ok !== true`.
 *
 * A successful response carrying binary attachments switches to
 * multipart/form-data (metadata part + `bytes-${index}` parts) — not handled
 * here, since the phone surface in this build is JSON-only.
 *
 * SOURCES
 *   F:\defws\docs\host-endpoint-map.md  — endpoint + offset map
 *   ...\x-dshdesktop-mobile\LanMobileBridge.js:984-1002 — original invokeHarness
 *   ...\FINDINGS-ep-wire-shapes.md       — verified request/response schemas
 */

import { randomUUID } from 'node:crypto'
import { withIdentityEncoding } from './http.js'

/** Default timeout for one harness call: 30 s, same as the original bridge. */
const INVOKE_TIMEOUT_MS = 30_000

/** Response envelope type discriminator (proved in FINDINGS-ep-wire-shapes.md §3). */
const RESPONSE_TYPE = 'server-response'

/**
 * One endpoint in the phone's RPC surface.
 *
 * `args` turns the phone's payload into the envelope's `args` object. The
 * shapes below are the VERIFIED typert schemas read out of app.asar, not
 * guesses — see the per-entry notes.
 */
const HARNESS_ENDPOINTS = {
  'session.prompt': {
    endpoint: 'session/prompt',
    // Verbatim from the recovered HARNESS_ENDPOINTS table.
    args: (payload) => ({ request: { requestId: randomUUID(), ...payload } }),
  },
  'session.cancel': {
    endpoint: 'session/cancel',
    // Verbatim from the recovered HARNESS_ENDPOINTS table.
    args: (payload) => ({ request: payload }),
  },
  'session.select': {
    // Reconstructed third row of the original table: `(payload) => ({ request: payload })`.
    endpoint: 'session/select',
    args: (payload) => ({ request: payload }),
  },
  'session.create': {
    endpoint: 'session/create',
    // wire name is `request` here.
    args: (payload) => ({ request: payload }),
  },
  'session.history': {
    // Two-step in the original bridge: follow the session list to learn its
    // asOfSeq, then read one page. Kept as a single call here for the minimal
    // loop; the page reads via session/page directly.
    endpoint: 'session/page',
    args: (payload) => ({ request: payload }),
  },
  'session.page': {
    endpoint: 'session/page',
    args: (payload) => ({ request: payload }),
  },
  'session.modelCatalog': {
    // parameters: [] — no args at all.
    endpoint: 'session/modelCatalog',
    args: () => ({}),
  },
  'session.selectModel': {
    endpoint: 'session/selectModel',
    /**
     * VERIFIED schema (app.asar offset 16523343, zod literal):
     *   sessionId:        z.intersection(z.string(), z.unknown()).readonly()
     *   provider:         z.string().readonly()
     *   model:            z.string().readonly()
     *   reasoningEffort:  z.string().readonly().optional()
     * The model is identified by the top-level `model` string, and `provider`
     * is REQUIRED as a sibling. There is no modelId / id / modelKey /
     * modelName. The wire name is `request` (NOT `_request`).
     */
    args: (payload) => ({
      request: {
        sessionId: payload.sessionId,
        provider: payload.provider,
        model: payload.model,
        ...(payload.reasoningEffort !== undefined
          ? { reasoningEffort: payload.reasoningEffort }
          : {}),
      },
    }),
  },
  'session.list': {
    endpoint: 'session/list',
    // Wire name is `_request` WITH the underscore here — do not mix it up
    // with the `request` wire name used by the other session endpoints.
    args: () => ({ _request: {} }),
  },
  'agentPresets.list': {
    endpoint: 'agentPresets/list',
    args: () => ({ _request: {} }),
  },
  'agentPresets.select': {
    endpoint: 'agentPresets/select',
    args: (payload) => ({ request: payload }),
  },
  'workspace.list': {
    endpoint: 'workspace/list',
    args: () => ({ _request: {} }),
  },
}

/** Every RPC method name the phone is allowed to call, for the route gate. */
export const RPC_ALLOWLIST = new Set(Object.keys(HARNESS_ENDPOINTS))

/**
 * Build a harness caller bound to one inner-auth credential and one loopback
 * base URL.
 *
 * @param base - `http://127.0.0.1:<port>` (no trailing slash).
 * @param auth - the inner-auth handle supplying the `name=value` cookie pair.
 */
export function createInvoker(base, auth) {
  /**
   * Invoke one harness endpoint.
   * @param endpoint - an `/api` path suffix registered in HARNESS_ENDPOINTS.
   * @param args - the already-shaped `args` object for the envelope.
   * @returns the unwrapped `value` of a successful result.
   */
  const invoke = async (endpoint, args) => {
    const rpcId = randomUUID()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), INVOKE_TIMEOUT_MS)
    try {
      const cookie = await auth.ready()
      // withIdentityEncoding MUST wrap the whole init: called bare it returns
      // an empty Headers plus accept-encoding, which would silently drop
      // content-type and the credential and get the request 415'd/401'd.
      const response = await fetch(`${base}/api/${endpoint}`, withIdentityEncoding({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cookie !== undefined ? { cookie } : {}),
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: endpoint,
          payload: { args },
        }),
        signal: controller.signal,
      }))
      if (response.status === 401 || response.status === 403) {
        // A stale credential (secret rotation, 30-day TTL) must not wedge every
        // later call: drop it so the next attempt re-redeems.
        auth.invalidate()
        throw new Error(`harness rejected the inner credential (${response.status}) for ${endpoint}`)
      }
      if (!response.ok) {
        throw new Error(`harness returned ${response.status} for ${endpoint}`)
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('application/json')) {
        // A multipart attachment response cannot be consumed here.
        throw new Error(`harness returned ${contentType || 'no content-type'} for ${endpoint}`)
      }
      const envelope = await response.json()
      if (envelope?.type !== RESPONSE_TYPE) {
        throw new Error(`harness replied with envelope type ${String(envelope?.type)} for ${endpoint}`)
      }
      if (envelope?.rpcId !== rpcId) {
        throw new Error(`harness replied with a mismatched rpcId for ${endpoint}`)
      }
      const result = envelope?.result
      if (result?.ok !== true) {
        const error = result?.error
        const code = error?.code !== undefined ? String(error.code) : 'unknown'
        const message = error?.message !== undefined ? String(error.message) : JSON.stringify(result)
        throw new Error(`${endpoint} failed (${code}): ${message}`)
      }
      return result.value
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Invoke a phone-facing RPC method by its allowlist name, shaping the args
   * through the endpoint's `args` transform.
   */
  const call = async (method, payload = {}) => {
    const spec = HARNESS_ENDPOINTS[method]
    if (spec === undefined) throw new Error(`method not in allowlist: ${method}`)
    const args = spec.args ? spec.args(payload) : payload
    return invoke(spec.endpoint, args)
  }

  return { invoke, call }
}

export { HARNESS_ENDPOINTS }
