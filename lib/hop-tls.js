// Whether THIS hop is TLS (P0-4, 2026-10-24).
//
// `Secure` is a promise about the connection the browser is speaking on, not
// about how the bridge happens to be configured. Three cookies ask that
// question (the desktop pairing cookie, the device session cookie, the consent
// cookie) and the answer used to come from a proxy: `connectionMode ===
// 'tunnel'` for the two device-facing ones, `isLoopbackAddress` for the desktop
// one. Both are wrong in the same direction — they describe the bridge's own
// mode or the socket's numeric address, not what the hop carried:
//
//   * tunnel mode + a LAN handset (192.168.x.x, plain HTTP): the mode said
//     "internet-facing", the hop was plaintext — `Secure` was added to a cookie
//     the browser will then refuse to store or send over http, i.e. a pairing
//     that silently does not stick (the bug this file exists for).
//   * a tunnel visitor whose request reached the bridge through the local host:
//     the hop is TLS and the cookie deserves `Secure`.
//
// Three pieces of evidence, strongest first:
//
//   1. `req.socket.encrypted === true` — the socket itself is TLS. Nothing to
//      argue with.
//   2. `cf-visitor` — Cloudflare stamps `{"scheme":"https"}` on what it
//      forwards, describing the handset→edge leg. Only Cloudflare sets it
//      truthfully, and it is the one signal a tunnel visitor carries.
//   3. tunnel mode with a loopback TCP peer — the request came from this host
//      through the carrier, so the only leg that matters (handset→edge) was
//      Cloudflare's, which is TLS.
//
// `x-forwarded-proto` is deliberately NOT evidence: any process on this machine
// can send that header, and it is exactly the header a handset-facing `Secure`
// decision must not be taken from.
//
// Everything here is pure and dependency-free so the bridge keeps its single
// import and the choice stays testable without a server.

/**
 * Default loopback predicate, used when the caller does not inject its own
 * (`lib/bridge.js` passes `isLoopbackAddress`, which is the same rule; the
 * export exists so this module never imports the bridge back).
 * @param {unknown} address
 * @returns {boolean}
 */
export function isLoopbackHop(address) {
  if (typeof address !== 'string') return false
  if (address === '::1') return true
  // The whole 127.0.0.0/8 block, and the v4-mapped spelling a dual-stack
  // listener reports for a v4 loopback peer — one rule for both stacks.
  const v4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
}

/**
 * @param {unknown} value A header value: string, string[] or undefined.
 * @returns {string | undefined}
 */
function firstHeaderValue(value) {
  if (Array.isArray(value)) {
    const first = value[0]
    return typeof first === 'string' ? first : undefined
  }
  return typeof value === 'string' ? value : undefined
}

/**
 * The scheme Cloudflare says the handset used, lowercased, or undefined.
 *
 * The header is JSON (`{"scheme":"https"}`); a malformed one is not TLS
 * evidence — it is silence, not a reason to guess.
 * @param {Record<string, unknown> | undefined} headers
 * @returns {'http' | 'https' | undefined}
 */
export function cfVisitorScheme(headers) {
  const raw = firstHeaderValue(headers?.['cf-visitor'])
  if (raw === undefined || raw === '') return undefined
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const scheme = parsed.scheme
  if (typeof scheme !== 'string') return undefined
  const normalized = scheme.trim().toLowerCase()
  return normalized === 'https' || normalized === 'http' ? normalized : undefined
}

/**
 * Is the hop this request arrived on TLS?
 *
 * @param {object} [input]
 * @param {{ encrypted?: boolean } | undefined} [input.socket] `request.socket`
 * @param {Record<string, unknown>} [input.headers] `request.headers`
 * @param {unknown} [input.remoteAddress] the TCP peer address
 * @param {'lan' | 'tunnel'} [input.connectionMode] the bridge's mode for this request
 * @param {(address: unknown) => boolean} [input.isLoopback] injected loopback rule
 * @returns {boolean}
 */
export function hopIsTls(input = {}) {
  const { socket, headers, remoteAddress, connectionMode, isLoopback } = input
  // 1. The socket is TLS. This is not an inference.
  if (socket?.encrypted === true) return true
  // 2. Cloudflare says the handset→edge leg was https.
  if (cfVisitorScheme(headers) === 'https') return true
  // 3. Tunnel mode with a loopback peer: the internet-facing leg was the
  //    carrier's, so it was TLS; only the local carrier→bridge hop is plain.
  if (connectionMode === 'tunnel') {
    const loopback = typeof isLoopback === 'function' ? isLoopback : isLoopbackHop
    return loopback(remoteAddress) === true
  }
  return false
}

/**
 * `'; Secure'` or `''` for a `Set-Cookie` header — the shape every call site
 * needs, so no site re-derives the test.
 *
 * @param {object} [request] the inbound request, or a plain bundle of the same
 *   three fields when the caller has no `IncomingMessage` to hand
 * @param {'lan' | 'tunnel'} [connectionMode] the bridge's mode for this request
 * @param {(address: unknown) => boolean} [isLoopback] injected loopback rule;
 *   the caller's own, when it has one, so the two agree by construction
 * @returns {string}
 */
export function hopSecureSuffix(request, connectionMode, isLoopback) {
  const socket = request?.socket
  return hopIsTls({
    socket,
    headers: request?.headers,
    remoteAddress: socket?.remoteAddress ?? request?.remoteAddress,
    connectionMode,
    isLoopback,
  })
    ? '; Secure'
    : ''
}
