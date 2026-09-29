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
 * Ported verbatim from F:\defws\dsh-remote-web-ui-fork\src\inner-auth.ts
 * (which itself carries the original implementation + rationale comments).
 */

/** Browser-auth credential the bridge attaches to loopback-bound requests. */

/** The harness browser-auth cookie name prefix (see dsh-client-connection). */
const BROWSER_AUTH_COOKIE_PREFIX = 'dsh-auth-'

/**
 * Build the inner-auth handle.
 * @param launchUrl - the launch-token URL for the inner loopback authority
 *   (the connection service's authenticatedUrl of `http://127.0.0.1:<port>/`),
 *   or undefined when the connection service or port is unavailable.
 * @param fetchImpl - injectable fetch (tests).
 */
export function createInnerAuth(launchUrl, fetchImpl = fetch) {
  let cached
  let inflight

  const redeem = async () => {
    const url = launchUrl()
    if (url === undefined) return undefined
    try {
      // redirect: 'manual' keeps the 303's set-cookie readable instead of
      // following it; the exchange itself is a plain GET with the token in
      // the query, exactly what a first browser visit performs.
      const response = await fetchImpl(url, { redirect: 'manual' })
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
      return undefined
    }
  }

  return {
    ready() {
      if (cached !== undefined) return Promise.resolve(cached)
      inflight ??= redeem().then((value) => {
        if (value !== undefined) cached = value
        inflight = undefined
        return value
      }, () => {
        inflight = undefined
        return undefined
      })
      return inflight
    },
    invalidate() {
      cached = undefined
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
