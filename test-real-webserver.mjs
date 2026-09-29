/**
 * Integration test: mount @defws/dsh-phone-native on the REAL
 * dsh-host-webserver that ships inside the official DSH payload.
 *
 * test-closed-loop.mjs proves the plugin's own logic against a mock webServer.
 * This file proves the production contract instead: my route objects are
 * accepted by the official register()/match() implementation, the official
 * 404-until-registered behaviour applies, duplicate registration throws, and
 * unclaimed WebSocket upgrades are destroyed by the real handler.
 *
 * Nothing here restarts the host, installs packages, or touches the network.
 *
 * Usage: node F:\defws\dsh-phone-native\test-real-webserver.mjs
 */

import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const libDir = path.join(pluginRoot, 'lib')

// The official payload we read the webserver source from. See README.md.
const OFFICIAL_ROOT = 'F:\\defws\\tmp\\20260926-official-dsh-desktop\\official-files\\dsh\\node_modules'
const WEBSERVER_ENTRY = path.join(OFFICIAL_ROOT, '@deepseek-ai', 'dsh-host-webserver', 'lib', 'index.js')

const results = []
const teardowns = []
const warnings = []
const errors = []
function check(label, pass, detail) {
  results.push({ label, pass, detail })
  const mark = pass ? 'PASS' : 'FAIL'
  const suffix = detail === undefined ? '' : ` — ${detail}`
  console.log(`  [${mark}] ${label}${suffix}`)
}

async function main() {
  console.log('== loading the real dsh-host-webserver ==')
  if (!fs.existsSync(WEBSERVER_ENTRY)) {
    console.error(`MISSING ${WEBSERVER_ENTRY}`)
    console.error('This test only runs where the official payload is present.')
    process.exitCode = 1
    return
  }
  const webserverModule = await import(pathToFileURL(WEBSERVER_ENTRY))
  const WebServer = webserverModule.WebServer ?? webserverModule.default
  if (typeof WebServer !== 'function') {
    console.error('the official module did not export a WebServer class')
    process.exitCode = 1
    return
  }
  console.log(`  loaded WebServer from ${WEBSERVER_ENTRY}`)

  // --- the smallest cordis-shaped ctx the official service accepts ----------
  // dsh-host-webserver/lib/index.js reads ctx.logger.warn/error and registers a
  // teardown through ctx.effect, so both must exist. Its constructor also runs
  // the cordis Service base, which requires ctx.reflect.provide (cordis
  // lib/index.js:1782) — a no-op is enough outside a real container.
  const makeCtx = () => ({
    logger: {
      warn: (message) => { warnings.push(String(message)) },
      error: (message) => { errors.push(String(message)) },
    },
    reflect: { provide: () => {} },
    effect: (fn, label) => {
      const disposed = fn()
      const disposer = typeof disposed === 'function' ? disposed : () => {}
      teardowns.push({ label: String(label), disposer })
      return disposer
    },
  })

  // --- boot the real server, then hand the SAME instance to my plugin --------
  // Listening is the cordis lifecycle hook [Service.init]() (webserver
  // lib/index.js:228), not a public listen() method. The hook resolves once the
  // socket is bound, and it registers its own teardown effect.
  const config = { host: '127.0.0.1', port: 0, compression: 'none' }
  const webServerCtx = makeCtx()
  const webServer = new WebServer(webServerCtx, config)
  const cordis = await import(pathToFileURL(path.join(OFFICIAL_ROOT, '@deepseek-ai', 'cordis', 'lib', 'index.js')))
  const initHook = cordis.Service?.init ?? cordis.default?.init
  if (typeof initHook !== 'symbol') {
    console.error('could not resolve the cordis Service.init lifecycle symbol')
    process.exitCode = 1
    return
  }
  await webServerinitHookFallback(webServer, initHook)
  const port = Number(webServer.port ?? webServer.listenedPort)
  check('real webserver listens on an ephemeral port', Number.isFinite(port) && port > 0, `port=${port}`)

  const pluginApply = (await import(pathToFileURL(path.join(libDir, 'index.js')))).apply

  // The plugin only needs webServer.port/register/registerUpgrade,
  // connection.authenticatedUrl, effect, set and logger from ctx.
  const stored = {}
  const pluginCtx = {
    get logger() { return webServerCtx.logger },
    get webServer() { return webServer },
    get connection() {
      return {
        authenticatedUrl: (base) => `${base}?token=fake-launch-token`,
      }
    },
    effect: (fn, label) => {
      const disposed = fn()
      const disposer = typeof disposed === 'function' ? disposed : () => {}
      teardowns.push({ label: String(label), disposer })
      return disposer
    },
    set: (key, value) => { stored[key] = value },
  }

  console.log('== applying the plugin onto the real webserver ==')
  pluginApply(pluginCtx)
  const registered = stored['phone-native']
  check('plugin applied without throwing', registered !== undefined)
  check('plugin exposed its public surface', registered && typeof registered.status === 'function')

  const base = `http://127.0.0.1:${port}`

  // --- 1. unregistered path -> 404 (official behaviour, before my fallback) --
  // None of my routes claim /nope, and no fallback is registered, so this is
  // pure official surface: proves I am not accidentally claiming a prefix.
  const unclaimed = await request(`${base}/nope`)
  check('unclaimed path returns 404', unclaimed.status === 404, `status=${unclaimed.status}`)

  // --- 2. duplicate registration must throw the official error --------------
  // (kind, path) uniqueness is enforced by the real register().
  const dup = stored['phone-native'].routes[0]
  let duplicateError
  try { webServer.register({ kind: dup.kind, path: dup.path, handler: dup.handler }) } catch (e) { duplicateError = e }
  check('duplicate (kind,path) throws', duplicateError instanceof Error, duplicateError?.message)

  // --- 3. my routes are reachable through the real matcher -------------------
  const page = await request(`${base}/phone`)
  check('GET /phone answered by the real router', page.status === 401 || page.status === 200, `status=${page.status}`)

  // --- 4. unclaimed WS upgrade is destroyed, not crashed --------------------
  // The official upgrade handler only honours its upgrades table and calls
  // socket.destroy() for anything else. A destroyed socket surfaces as a
  // socket 'close' with no HTTP response — assert we get no 101 and no crash.
  const upgrade = await probeUpgrade(port, '/not-a-registered-ws')
  check('unknown upgrade path gets no 101', !upgrade.upgraded, 'socket closed')

  // --- 5. teardown leaves nothing behind ------------------------------------
  // Disposing must remove MY routes while the real listener stays up. Note the
  // teardowns array also holds the webserver's own "webServer.listen" effect
  // (registered by [Service.init]) — disposing that one closes the listener,
  // so only this plugin's effects are disposed for this assertion, and the
  // server is shut down explicitly at the very end.
  const pluginTeardowns = teardowns.filter((entry) => entry.label.startsWith('phone-native:'))
  check('plugin registered the expected effects', pluginTeardowns.length === 3, `count=${pluginTeardowns.length}`)
  for (const entry of pluginTeardowns) entry.disposer()
  await new Promise((r) => setTimeout(r, 50))
  const afterDispose = await request(`${base}/phone`)
  check('phone route unregistered after teardown', afterDispose.status === 404, `status=${afterDispose.status}`)

  // Close the listener cleanly so the process can exit without a lingering handle.
  const listenerEffect = teardowns.find((entry) => entry.label === 'webServer.listen')
  listenerEffect?.disposer()
  await new Promise((r) => setTimeout(r, 50))

  console.log('== warnings / errors captured ==')
  console.log(`  warnings: ${warnings.length}, errors: ${errors.length}`)

  const failed = results.filter((r) => !r.pass)
  console.log(`\nREAL WEBSERVER ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`)
  if (failed.length > 0) process.exitCode = 1
}

/* --------------------------------- helpers -------------------------------- */

function pathToFileURL(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, '/')
  return new URL(`file://${resolved.startsWith('/') ? '' : '/'}${resolved}`)
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method ?? 'GET', headers: options.headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

function probeUpgrade(port, pathname) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
      )
    })
    let upgraded = false
    let sawHttp = false
    const finish = () => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ upgraded, sawHttp })
    }
    const timer = setTimeout(finish, 1500)
    socket.on('data', (chunk) => {
      const text = chunk.toString('latin1')
      if (text.startsWith('HTTP/1.1 101')) { upgraded = true; sawHttp = true }
      else if (/^HTTP\/1\.1 \d{3}/.test(text)) sawHttp = true
      finish()
    })
    socket.on('error', finish)
    socket.on('close', () => { clearTimeout(timer); resolve({ upgraded, sawHttp }) })
  })
}

/**
 * Drive the official service into its listening state.
 *
 * `listen` is a cordis lifecycle hook (`async [Service.init]()` at
 * lib/index.js:228), so the callable key is that symbol rather than `listen`.
 * Some payload revisions expose a plain `listen()`; try the symbol first and
 * fall back.
 */
async function webServerinitHookFallback(webServer, initHook) {
  // [Service.init] is a prototype method, so it is reachable directly even
  // though it is not an own property of the instance.
  if (typeof webServer[initHook] === 'function') return webServer[initHook]()
  for (const key of ['listen', 'start']) {
    if (typeof webServer[key] === 'function') return webServer[key]()
  }
  throw new Error('the official WebServer exposes neither [Service.init]() nor a public listen()/start()')
}

main().catch((error) => {
  console.error('REAL WEBSERVER test crashed:', error)
  process.exitCode = 1
})

// Let the process exit on its own; nothing here keeps the loop alive.
process.on('uncaughtException', (e) => { console.error('uncaught:', e); process.exitCode = 1 })
