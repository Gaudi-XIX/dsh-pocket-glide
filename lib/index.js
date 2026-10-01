/**
 * Pocket DSH — host plugin entry (composition root).
 *
 * Minimal, phone-native remote control for DSH. This file contains NO pairing
 * UI of its own; it only wires the hand-ported dataelement LanMobileBridge
 * (lib/bridge.js) into the host lifecycle:
 *
 *   - waits for the `connection` + `webServer` services (soft: via ctx.inject,
 *     so a missing service never blocks host boot),
 *   - builds the process credential (lib/inner-auth.js: one-time launch-token
 *     redemption → authority-bound `dsh-auth-` cookie),
 *   - builds the persistent PIN store (lib/pin-store.js),
 *   - owns one bridge inside `ctx.effect`: started on activation, fully stopped
 *     (tunnel, mux, sockets) on dispose,
 *   - re-serves the bridge's desktop pairing surface (dataelement's
 *     renderDesktopPairingPage: colours, dark mode, QR, WiFi/internet switch,
 *     pairing password) at the APPLICATION origin, so the host GUI can show it
 *     in an in-app iframe without any cross-origin or cookie problem.
 *
 * Why the last point matters: the GUI renders at `dsh-app://app`, whose
 * protocol handler forwards every non-asset path to this web server with the
 * host cookie. Framing `http://127.0.0.1:43127/desktop` directly would be a
 * cross-site frame — SameSite=Strict cookies are withheld there, so the page's
 * own `/desktop/status` polls would 403. Proxying through the app origin keeps
 * everything same-origin; the bridge's desktop cookie is injected on the
 * loopback hop, so the browser never needs it.
 *
 * The bridge itself stays an INDEPENDENT node:http server on 0.0.0.0:43127
 * (EADDRINUSE → 43128; env DSH_MOBILE_PORT), deliberately NOT mounted on
 * ctx.webServer, which is loopback-only. LAN is kept exactly as in
 * dataelement; the Cloudflare quick tunnel is the public path.
 *
 * NOTE: a host-internal BrowserWindow (dataelement's showMobilePairing) is not
 * reachable here — the plugin node half runs as ELECTRON_RUN_AS_NODE and the
 * official exe fuse rejects external entry scripts. Hence the in-app iframe.
 */

import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { dirname, join } from 'node:path'
import { LanMobileBridge } from './bridge.js'
import { createInnerAuth } from './inner-auth.js'
import { createDefaultPairingPinStore } from './pin-store.js'
import { createFileLogger } from './file-log.js'

/** Loader id — must match the insert id in cordis.patch.yml. */
export const name = 'pocket'

/**
 * Deliberately empty: `connection`/`webServer` are consumed with ctx.inject
 * below (soft dependency, never blocks boot) and `logger` is a Context
 * property, not a service.
 */
export const inject = []

/** Log through the host logger without ever throwing. */
function makeLog(ctx) {
  return (level, message) => {
    try {
      ctx?.logger?.[level]?.(`pocket: ${message}`)
    } catch {
      /* logging must never break the plugin */
    }
  }
}

/** The desktop pairing page and its JSON endpoints, all under one prefix. */
const PAIRING_ROUTE = '/desktop'
/** Brand marks the pairing page renders in its header. */
const BRAND_ROUTE = '/brand-logo'

/**
 * The app icon doubles as the pairing page's brand mark: the page renders it
 * in a 39x22 box with object-fit: contain.
 * @returns {{ light: string, dark: string } | undefined}
 */
function resolveBrandLogos() {
  const icon = resolveAppIcon()
  return icon ? { light: icon, dark: icon } : undefined
}

/**
 * Absolute path to the bundled app icon used for the inline data-URI and the
 * `/app-icon` fallback route.
 * @returns {string | undefined}
 */
function resolveAppIcon() {
  try {
    const icon = join(dirname(process.execPath), 'resources', 'icon.png')
    if (existsSync(icon)) return icon
  } catch {
    /* branding is cosmetic: never let it affect activation */
  }
  return undefined
}

/**
 * Forward one already-authenticated app-origin request to the bridge, injecting
 * the desktop session cookie so the bridge's own access rules stay intact.
 * The bridge is the single source of truth for every pairing response.
 * @param {LanMobileBridge} instance
 * @param {ReturnType<typeof makeLog>} log
 */
function createPairingProxy(instance, log) {
  return (req, res) => {
    // Browser-driven cross-site requests are rejected exactly as the bridge
    // would; the app's protocol handler strips Fetch Metadata, so genuine app
    // traffic arrives without it.
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Cross-site request rejected.')
      return
    }
    const port = instance.port
    if (!port || !instance.server) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Pocket bridge is not ready.')
      return
    }

    const headers = { ...req.headers }
    // The loopback hop carries no ambient cookies or fetch metadata: the proxy
    // speaks for the desktop, authenticated by the session cookie below.
    for (const name of [
      'host',
      'origin',
      'referer',
      'cookie',
      'sec-fetch-site',
      'sec-fetch-mode',
      'sec-fetch-dest',
      'sec-fetch-user',
      'connection',
      'keep-alive',
    ]) {
      delete headers[name]
    }
    headers.cookie = `dsh_desktop=${instance.desktopSessionToken}`

    const upstream = httpRequest(
      { host: '127.0.0.1', port, method: req.method, path: req.url, headers },
      (up) => {
        const outgoing = { ...up.headers }
        // Framing is the whole point here; hop-by-hop headers are re-derived.
        delete outgoing['x-frame-options']
        delete outgoing['transfer-encoding']
        delete outgoing.connection
        delete outgoing['keep-alive']
        res.writeHead(up.statusCode ?? 502, outgoing)
        up.pipe(res)
      }
    )
    upstream.on('error', (error) => {
      log('error', `pairing proxy failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end('Pocket bridge is unavailable.')
    })
    req.pipe(upstream)
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 * @param {'zh'|'en'} [config.locale='zh']
 * @param {number} [config.port]
 */
export function apply(ctx, config = {}) {
  const hostLog = makeLog(ctx)
  // The Cordis logger has no file transport in the node half; mirror every
  // Pocket log line to a rotating file so pairing/tunnel failures are traceable.
  const fileLog = createFileLogger()
  /** @type {(level: 'info'|'warn'|'error', message: string) => void} */
  const log = (level, message) => {
    try { hostLog(level, message) } catch { /* host logging is best-effort */ }
    try { fileLog[level]?.(message) } catch { /* file logging is best-effort */ }
  }
  const locale = config.locale === 'en' ? 'en' : 'zh'

  ctx.inject(['connection', 'webServer'], (hostCtx) => {
    // The bridge always speaks to the host by its loopback authority name:
    // the dsh-auth cookie is authority-bound.
    const harnessUrl = () => `http://127.0.0.1:${String(hostCtx.webServer.port)}`
    const launchUrl = () =>
      hostCtx.connection.authenticatedUrl(
        `http://127.0.0.1:${String(hostCtx.webServer.port)}`
      )

    const innerAuth = createInnerAuth(launchUrl)
    const pairingPinStore = createDefaultPairingPinStore()

    hostCtx.effect(() => {
      /** @type {LanMobileBridge | undefined} */
      let bridge
      let disposed = false

      const instance = new LanMobileBridge({
        harnessUrl,
        innerAuth,
        locale,
        port: config.port,
        pairingPinStore,
        brandLogoPaths: resolveBrandLogos(),
        appIconPath: resolveAppIcon(),
        tunnelLog: (message) => log('info', message),
        log,
      })
      bridge = instance

      const proxy = createPairingProxy(instance, log)
      /** @type {Array<() => void>} */
      const disposeRoutes = []
      // A route collision must never fail activation: the plugin degrading to
      // "no pairing page" is recoverable, a failed host boot is not.
      for (const path of [PAIRING_ROUTE, BRAND_ROUTE]) {
        try {
          disposeRoutes.push(hostCtx.webServer.register({ kind: 'prefix', path, handler: proxy }))
        } catch (error) {
          log(
            'error',
            `cannot claim ${path}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }

      instance
        .start()
        .then((snapshot) => {
          if (disposed) return
          hostCtx.set('pocket', {
            snapshot: () => instance.snapshot(),
            toggleTunnel: (enable) => instance.toggleTunnel(enable),
          })
          log(
            'info',
            `Pocket bridge ready on 0.0.0.0:${String(snapshot.port)} ` +
              `(pairing page: ${PAIRING_ROUTE})`
          )
        })
        .catch((error) => {
          log('error', `bridge failed to start: ${error instanceof Error ? error.message : String(error)}`)
        })

      return () => {
        disposed = true
        for (const disposeRoute of disposeRoutes) {
          try {
            disposeRoute()
          } catch {
            /* route teardown must not block stop */
          }
        }
        const live = bridge
        bridge = undefined
        // stop() is idempotent and tears down tunnel + mux + all sockets.
        return live?.stop().catch((error) => {
          log('error', `error during bridge stop: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    }, 'pocket: bridge lifecycle')
  })
}

export default apply
