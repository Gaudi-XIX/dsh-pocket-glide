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
import { createDefaultSettingsStore } from './settings-store.js'
import { createDefaultSessionStore } from './session-store.js'
import { createDefaultMailbagStore } from './mailbag-store.js'
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
 * The body a desktop request gets while the bridge has no listener.
 *
 * The port and the errno ARE the message. `LanMobileBridge.start()` only steps
 * to the next port for a first-attempt `EADDRINUSE` on 43127/43128, so a
 * `DSH_MOBILE_PORT` or an explicit option that collides simply fails — and the
 * iframe was left with the words "Pocket bridge is not ready.", which tell an
 * operator nothing about which port or why. Both values come from the bridge's
 * own listen attempt, never from client input.
 * @param {{ port?: number, errno?: string } | undefined} failure
 * @returns {string}
 */
export function notReadyBody(failure) {
  const parts = []
  if (typeof failure?.port === 'number' && failure.port > 0) parts.push(`port ${String(failure.port)}`)
  if (typeof failure?.errno === 'string' && failure.errno) parts.push(failure.errno)
  return parts.length === 0
    ? 'Pocket bridge is not ready.'
    : `Pocket bridge is not ready (${parts.join(', ')}).`
}

/**
 * Port + errno of a failed `listen()`, the two facts `notReadyBody` needs. The
 * bridge attaches `listenPort`/`listenErrno` where it rethrows; anything else
 * stays undefined so the body falls back to the generic sentence rather than
 * inventing a diagnosis.
 * @param {unknown} error
 * @returns {{ port?: number, errno?: string }}
 */
export function describeListenFailure(error) {
  /** @type {{ port?: number, errno?: string }} */
  const failure = {}
  if (!error || typeof error !== 'object') return failure
  const port = /** @type {any} */ (error).listenPort ?? /** @type {any} */ (error).port
  if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535) failure.port = port
  const errno = /** @type {any} */ (error).listenErrno ?? /** @type {any} */ (error).code
  if (typeof errno === 'string' && /^[A-Z][A-Z0-9_]*$/.test(errno)) failure.errno = errno
  return failure
}

/**
 * Forward one already-authenticated app-origin request to the bridge, injecting
 * the desktop session cookie so the bridge's own access rules stay intact.
 * The bridge is the single source of truth for every pairing response.
 * @param {LanMobileBridge} instance
 * @param {ReturnType<typeof makeLog>} log
 * @param {() => { port?: number, errno?: string } | undefined} [listenFailure]
 *   Why the listener is missing, when the bridge knows it (a failed `listen()`).
 */
function createPairingProxy(instance, log, listenFailure = () => undefined) {
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
      res.end(notReadyBody(listenFailure()))
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

  /**
   * One summary line when the file log has been failing, emitted at the one
   * moment that already exists — teardown — so it costs no timer and no poll.
   *
   * `lib/file-log.js` counts its own failures (R-T5) but nothing ever read the
   * counters, so a log that had silently stopped accepting lines looked exactly
   * like a healthy one. Only abnormal counters are reported: `bytes` is not a
   * fault, and an all-zero reading is the healthy case and stays silent. The
   * whole read is best-effort, in the same spirit as the write path — a health
   * check must never be the thing that breaks a teardown.
   */
  const reportFileLogHealth = () => {
    try {
      const stats = fileLog.stats()
      const abnormal = [
        ['writeFailures', stats.writeFailures],
        ['rotationFailures', stats.rotationFailures],
        ['droppedLines', stats.droppedLines],
        ['truncatedLines', stats.truncatedLines],
      ].filter(([, count]) => typeof count === 'number' && count > 0)
      if (abnormal.length === 0) return
      const counts = abnormal.map(([name, count]) => `${name}=${String(count)}`).join(' ')
      const lastWriteError =
        typeof stats.lastWriteError === 'string' && stats.lastWriteError
          ? ` lastWriteError=${stats.lastWriteError}`
          : ''
      log('warn', `pocket file log degraded: ${counts}${lastWriteError}`)
    } catch {
      /* file logging is best-effort: a health read must never break teardown */
    }
  }

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
    // Notify channel + named-tunnel credentials, same data root as the PIN
    // (createDefaultSettingsStore): construction does no I/O, the bridge reads
    // it lazily and never throws on a missing file.
    const settingsStore = createDefaultSettingsStore()
    // Durable session maps, same data root: a host restart must not un-pair
    // every phone and force the whole PIN/confirm/consent funnel again.
    const sessionStore = createDefaultSessionStore()
    // 邮包（攒着没寄的完成通知）同数据根。它必须跨重启：这只包存在的理由就是
    // 「这一轮微信额度用完了，等下一次入站再寄」，而下一次往往在宿主重启之后。
    const mailbagStore = createDefaultMailbagStore()

    hostCtx.effect(() => {
      /** @type {LanMobileBridge | undefined} */
      let bridge
      let disposed = false
      /**
       * Why there is no listener, recorded only when a `listen()` really failed.
       * The proxy reads it so the desktop 503 can name the port and the errno
       * instead of leaving the operator a sentence with no diagnosis in it.
       * @type {{ port?: number, errno?: string } | undefined}
       */
      let listenFailure

      const instance = new LanMobileBridge({
        harnessUrl,
        innerAuth,
        locale,
        port: config.port,
        pairingPinStore,
        settingsStore,
        sessionStore,
        mailbagStore,
        brandLogoPaths: resolveBrandLogos(),
        appIconPath: resolveAppIcon(),
        tunnelLog: (message) => log('info', message),
        log,
      })
      bridge = instance

      const proxy = createPairingProxy(instance, log, () => listenFailure)
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

      // There is deliberately no `pocket` service registration here (no
      // hostCtx set of that provider name). This plugin
      // never declares that provider — the `provide` export does not exist in
      // this source tree — no other bundle asks for a `pocket` service, and the
      // host surface has no `ctx.pocket` / `pocket.status` consumer — so the
      // registration was rejected on every single launch, the rejection landed
      // in the old trailing `.catch()`, and that catch blamed the bridge for a
      // start that had already succeeded. Several dozen false
      // "bridge failed to start" lines per boot were the only thing in the log
      // an operator would find, and they were all wrong.
      //
      // Two-armed `then(onFulfilled, onRejected)` instead of `then().catch()`:
      // "bridge failed to start" is now said on exactly one path — `start()`
      // itself rejecting, i.e. the listener genuinely not coming up.
      instance.start().then(
        (snapshot) => {
          try {
            if (disposed) return
            listenFailure = undefined
            log(
              'info',
              `Pocket bridge ready on 0.0.0.0:${String(snapshot.port)} ` +
                `(pairing page: ${PAIRING_ROUTE})`
            )
          } catch (error) {
            log(
              'error',
              `bridge is listening, but the ready path failed: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        },
        (error) => {
          // Symmetric with the fulfilled arm: once the effect has been disposed,
          // a late rejection is a teardown artefact, not a diagnosis. `stop()`
          // can land between the listen attempt and its continuation, and the
          // error it produces is about a server nobody is listening for any
          // more — logging it would put a false `bridge failed to start` back in
          // the one channel this package exists to keep honest. The guard is
          // conditional: a real failure that arrives while the bridge is live
          // still records `listenFailure` and still logs.
          if (disposed) return
          listenFailure = describeListenFailure(error)
          log(
            'error',
            `bridge failed to start: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      )

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
        if (!live) {
          reportFileLogHealth()
          return undefined
        }
        // stop() is idempotent and tears down tunnel + mux + all sockets. The
        // health read runs after it so the stop's own line is counted too.
        return live
          .stop()
          .catch((error) => {
            log('error', `error during bridge stop: ${error instanceof Error ? error.message : String(error)}`)
          })
          .then(() => reportFileLogHealth())
      }
    }, 'pocket: bridge lifecycle')
  })
}

export default apply
