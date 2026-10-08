/**
 * The inner browser credential for the phone bridge. Every request the bridge
 * makes to the host's own `/api` surface re-issues to 127.0.0.1, where the
 * connection plugin's route enforces the harness browser-auth cookie — an
 * authority-bound signed cookie with no loopback exemption on this cohort
 * line, so a phone's own cookie can never satisfy the inner check. The
 * plugin therefore redeems its own launch token (the same one-time exchange
 * every paired device's first navigation performs) and attaches the resulting
 * cookie to inner requests.
 *
 * Ported from the `inner-auth.ts` module of an earlier phone-bridge prototype
 * (which carries the original implementation and rationale comments).
 */

/** Browser-auth credential the bridge attaches to loopback-bound requests. */

/** The harness browser-auth cookie name prefix (see dsh-client-connection). */
const BROWSER_AUTH_COOKIE_PREFIX = 'dsh-auth-'

/**
 * Deadline for one launch-token redemption.
 *
 * Without it a redemption that never answers pins its caller forever: `ready()`
 * hands out the same pending promise, so the mux carrier never installs its
 * socket, `invalidate()` cannot clear an in-flight exchange, and the mux
 * monitor never lands (which also leaves `bridge.stop()` waiting and the
 * `muxTask` slot occupied). 30 s is the same magnitude the bridge already uses
 * for a harness call.
 */
export const INNER_AUTH_TIMEOUT_MS = 30_000

/**
 * How long the bridge trusts its own copy of the browser-auth cookie.
 *
 * The host cookie is valid for 30 days by default, and the launch token is
 * stable for the life of the host process, so re-redeeming is cheap and
 * idempotent. Holding the copy for only ten minutes means a host-side rotation
 * (restart, credential reset, a re-minted secret) is picked up within a bounded
 * window by *every* consumer — including the mux carrier and the session
 * stream, which await `ready()` directly and have no 401 retry of their own.
 * Before this the cached value had no age at all and those paths kept
 * presenting a credential the host had already rejected.
 */
export const INNER_AUTH_TTL_MS = 10 * 60 * 1000

/**
 * Build the inner-auth handle.
 * @param launchUrl - the launch-token URL for the inner loopback authority
 *   (the connection service's authenticatedUrl of `http://127.0.0.1:<port>/`),
 *   or undefined when the connection service or port is unavailable.
 * @param fetchImpl - injectable fetch (tests).
 * @param {object} [options]
 * @param {number} [options.ttlMs] how long a redeemed cookie stays fresh
 *   (tests shorten it; production uses INNER_AUTH_TTL_MS).
 */
export function createInnerAuth(launchUrl, fetchImpl = fetch, { ttlMs = INNER_AUTH_TTL_MS } = {}) {
  let cached
  let cachedAt = 0
  let inflight
  // Bumped by invalidate(). A redemption that was already in flight when the
  // host rejected its credential belongs to an older generation and must not
  // write its value back into `cached`.
  let generation = 0

  const redeem = async (signal) => {
    const url = launchUrl()
    if (url === undefined) return undefined
    // The exchange always carries its own deadline; a caller that has an abort
    // signal (the mux monitor does) can cancel it as well. AbortSignal.timeout
    // uses an unref'd timer, so a pending deadline never keeps the process
    // alive on its own.
    const deadline = AbortSignal.timeout(INNER_AUTH_TIMEOUT_MS)
    const abort = signal === undefined ? deadline : AbortSignal.any([deadline, signal])
    try {
      // redirect: 'manual' keeps the 303's set-cookie readable instead of
      // following it; the exchange itself is a plain GET with the token in
      // the query, exactly what a first browser visit performs.
      const response = await fetchImpl(url, { redirect: 'manual', signal: abort })
      const raw = response.headers.get('set-cookie')
      if (raw === null) return undefined
      // Several cookies may be set in one header, separated by ", ". A naive
      // comma split breaks on attributes like `Expires=Wed, 29 Sep 2026 ...`;
      // split only where ", " is followed by a cookie name immediately joined
      // to "=" (attribute values never start that way).
      const entries = splitSetCookieHeader(raw)
      const entry = entries
        .map((part) => part.trim())
        .find((part) => part.startsWith(BROWSER_AUTH_COOKIE_PREFIX))
      if (entry === undefined) return undefined
      const pair = entry.split(';')[0]?.trim()
      return pair !== undefined && pair.includes('=') ? pair : undefined
    } catch {
      // Includes the deadline firing and a caller abort. Returning undefined is
      // the established "no credential this round" signal; callers (the mux
      // monitor) back off and ask again, they do not spin on it.
      return undefined
    }
  }

  return {
    /**
     * Resolve the browser-auth cookie, redeeming it once on demand.
     *
     * A cached copy older than the TTL is re-redeemed, so a host-side rotation
     * is picked up without the caller having to observe a 401 first. A failure
     * (including the deadline) resolves to undefined and clears the in-flight
     * slot, so the next call may try again instead of being pinned to a promise
     * that will never settle.
     *
     * @param {AbortSignal} [signal] optional cancellation. It is attached to
     *   the redemption this call starts; a call that joins an exchange someone
     *   else already started only observes it.
     * @returns {Promise<string | undefined>}
     */
    ready(signal) {
      if (cached !== undefined && Date.now() - cachedAt < ttlMs) return Promise.resolve(cached)
      if (signal?.aborted === true) return Promise.resolve(undefined)
      if (inflight === undefined) {
        const started = generation
        inflight = redeem(signal).then((value) => {
          if (generation === started) {
            if (value !== undefined) {
              cached = value
              cachedAt = Date.now()
            }
            inflight = undefined
          }
          return value
        }, () => {
          if (generation === started) inflight = undefined
          return undefined
        })
      }
      return inflight
    },
    /**
     * Discard the cached credential — and any exchange still in flight. The
     * generation bump is what makes this work while a redemption is pending:
     * when that older exchange settles it no longer repopulates the cache with
     * the very credential the host just rejected.
     */
    invalidate() {
      generation += 1
      cached = undefined
      cachedAt = 0
      inflight = undefined
    },
  }
}

/**
 * Split a possibly combined `Set-Cookie` response header into individual
 * cookie strings. Cookie pairs are separated by ", ", but attribute values
 * such as `Expires=Wed, 29 Sep 2026 00:00:00 GMT` contain the same sequence;
 * a boundary counts only when followed by a cookie-name token joined directly
 * to "=".
 * @param {string} raw
 * @returns {string[]}
 */
function splitSetCookieHeader(raw) {
  return raw.split(/,\s*(?=[A-Za-z0-9!#$%&'*+.^_`|~-]+=)/)
}
