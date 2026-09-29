/**
 * Pocket DSH — host plugin entry (composition root).
 *
 * Minimal, phone-native remote control for DSH. This file contains NO business
 * logic; it only wires the hand-ported dataelement LanMobileBridge
 * (lib/bridge.js) into the host lifecycle:
 *
 *   - waits for the `connection` + `webServer` services (soft: via ctx.inject,
 *     so a missing service never blocks host boot),
 *   - builds the process credential (lib/inner-auth.js: one-time launch-token
 *     redemption → authority-bound `dsh-auth-` cookie),
 *   - builds the persistent PIN store (lib/pin-store.js),
 *   - owns one bridge inside `ctx.effect`: started on activation, fully stopped
 *     (tunnel, mux, sockets) on dispose.
 *
 * The bridge is an INDEPENDENT node:http server on 0.0.0.0:43127 (EADDRINUSE →
 * 43128; env DSH_MOBILE_PORT), deliberately NOT mounted on ctx.webServer,
 * which is loopback-only. LAN is kept exactly as in dataelement; the Cloudflare
 * quick tunnel is the public path.
 */

import { spawn } from 'node:child_process'
import { LanMobileBridge } from './bridge.js'
import { createInnerAuth } from './inner-auth.js'
import { createDefaultPairingPinStore } from './pin-store.js'

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

/** Open a URL in the operating system's default browser (best effort). */
function openInSystemBrowser(url) {
  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', windowsHide: true })
          .on('close', () => resolve())
          .on('error', () => resolve())
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { stdio: 'ignore' }).on('close', () => resolve()).on('error', () => resolve())
      } else {
        spawn('xdg-open', [url], { stdio: 'ignore' }).on('close', () => resolve()).on('error', () => resolve())
      }
    } catch {
      resolve()
    }
  })
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 * @param {'zh'|'en'} [config.locale='zh']
 * @param {number} [config.port]
 * @param {boolean} [config.openDesktopOnStart=false] open the pairing panel in
 *   the system browser once when the bridge first starts.
 */
export function apply(ctx, config = {}) {
  const log = makeLog(ctx)
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
        tunnelLog: (message) => log('info', message),
      })
      bridge = instance

      instance
        .start()
        .then((snapshot) => {
          if (disposed) return
          hostCtx.set('pocket', {
            snapshot: () => instance.snapshot(),
            toggleTunnel: (enable) => instance.toggleTunnel(enable),
            desktopUrl: () => instance.createDesktopUrl(),
            openDesktop: async () => {
              const url = instance.createDesktopUrl()
              if (url) await openInSystemBrowser(url)
              return url
            },
          })
          log(
            'info',
            `Pocket bridge ready on 0.0.0.0:${String(snapshot.port)} ` +
              `(desktop panel: ${snapshot.desktopUrl ?? 'n/a'})`
          )
          if (config.openDesktopOnStart) {
            const url = instance.createDesktopUrl()
            if (url) void openInSystemBrowser(url)
          }
        })
        .catch((error) => {
          log('error', `bridge failed to start: ${error instanceof Error ? error.message : String(error)}`)
        })

      return () => {
        disposed = true
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
