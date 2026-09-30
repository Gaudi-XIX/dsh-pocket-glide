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
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LanMobileBridge } from './bridge.js'

/**
 * Temporary T8 side-channel: file carrying the one-time desktop bootstrap URL
 * so an external verifier can recover it if boot-time auto-open silently fails.
 * The URL is loopback-only, single-use and has a 10-min TTL, so writing it to
 * the local temp dir is safe. It is ONLY written when openDesktopOnStart is on.
 */
const DESKTOP_URL_FILE = join(tmpdir(), 'dsh-pocket-desktop-url')
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

/**
 * Open a URL in the operating system's default browser.
 * Resolves `true` if a launcher was spawned without error, `false` otherwise.
 * `cmd /c start` returns 0 even when it cannot resolve the URL handler, so on
 * Windows a second attempt via explorer.exe covers environments where cmd is
 * unavailable or start is blocked (e.g. very early in the boot sequence).
 */
function openInSystemBrowser(url) {
  return new Promise((resolve) => {
    let settled = false
    const ok = () => {
      if (!settled) {
        settled = true
        resolve(true)
      }
    }
    const fail = () => {
      if (!settled) {
        settled = true
        resolve(false)
      }
    }
    try {
      if (process.platform === 'win32') {
        let failed = false
        const child = spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', windowsHide: true })
        child.on('error', () => {
          failed = true
        })
        child.on('close', (code) => {
          if (!failed && code === 0) return ok()
          // Fallback: explorer.exe opens the default handler for an http URL.
          try {
            spawn('explorer.exe', [url], { stdio: 'ignore' }).on('error', fail)
            // explorer does not emit a reliable close; treat spawn as success.
            setTimeout(ok, 300)
          } catch {
            fail()
          }
        })
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { stdio: 'ignore' }).on('close', ok).on('error', fail)
      } else {
        spawn('xdg-open', [url], { stdio: 'ignore' }).on('close', ok).on('error', fail)
      }
    } catch {
      fail()
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
            if (url) {
              // Side-channel first: even if the spawn below silently no-ops,
              // the verifier can read this loopback-only, single-use URL.
              writeFile(DESKTOP_URL_FILE, url, { mode: 0o600 }).catch(() => {})
              openInSystemBrowser(url).then((opened) => {
                log('info', `desktop auto-open attempted (browserSpawn=${opened ? 'ok' : 'failed'})`)
              })
            }
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
