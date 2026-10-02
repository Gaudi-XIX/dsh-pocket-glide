/**
 * Integration probe: load @defws/dsh-pocket onto the REAL dsh-host-webserver that
 * ships inside the official DSH payload.
 *
 * What the unit suite already covers: everything the plugin does on its own —
 * `test/*.test.js` boots the real bridge against a fake harness on an OS-assigned
 * port. What this file proves instead is the PRODUCTION CONTRACT of the host half:
 *
 *   - the route objects the plugin hands to `webServer.register()` are accepted by
 *     the official `register()` (kind/path shape, and the disposer it returns),
 *   - the official 404-until-claimed behaviour still applies to paths the plugin
 *     does not claim — including the retired `/phone*` family,
 *   - duplicate `(kind, path)` registration throws the official error,
 *   - unclaimed WebSocket upgrades are destroyed by the real handler, not crashed,
 *   - the node half opens no upgrade route of its own (design 禁令 4: the stream is
 *     SSE, there is no second WebSocket server here),
 *   - disposing the plugin's effect removes its routes while the listener lives.
 *
 * The plugin's own surface, restated because it changed with the pocket rewrite:
 *   - the browser half is `client/client.js` (the sidebar footer action); it is NOT
 *     part of this probe — there is no client runtime in Node,
 *   - the node half claims exactly TWO prefix routes on the host web server:
 *     `/desktop` (the pairing surface, proxied to the bridge) and `/brand-logo`,
 *   - the bridge is an INDEPENDENT `node:http` server that `apply()` starts inside
 *     its own effect; that is why the phone page lives on the bridge's port and
 *     why the host listener only ever sees those two prefixes.
 *
 * Nothing here restarts the host, installs packages, or goes beyond loopback.
 * It is NOT matched by `test/*.test.js`, so `npm test` never picks it up; run it as
 * `npm run test:real-webserver`.
 *
 * Requirements:
 *   - an unpacked official payload. Default root:
 *     F:\\defws\\tmp\\20260926-official-dsh-desktop\\official-files\\dsh\\node_modules
 *     Override with DSH_OFFICIAL_MODULES. If the entry files are missing the probe
 *     exits non-zero naming the path it wanted — it never fakes a pass.
 *   - that root sits under tmp/ by workspace convention: re-creatable, not kept
 *     forever, so a red run here may simply mean the payload extraction is gone.
 *
 * Side effect worth knowing: loading lib/index.js builds the file logger, which
 * appends to the real `~/.dsh/pocket/logs/pocket.log`. Point DSH_HOME somewhere
 * throwaway first if you would rather not mix these lines into the live log:
 *   DSH_HOME=<empty dir> npm run test:real-webserver
 */

import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const libDir = path.join(pluginRoot, 'lib')

// The official payload this probe reads the webserver source from.
const OFFICIAL_ROOT =
  process.env.DSH_OFFICIAL_MODULES?.trim() ||
  'F:\\defws\\tmp\\20260926-official-dsh-desktop\\official-files\\dsh\\node_modules'
const WEBSERVER_ENTRY = path.join(OFFICIAL_ROOT, '@deepseek-ai', 'dsh-host-webserver', 'lib', 'index.js')
const CORDIS_ENTRY = path.join(OFFICIAL_ROOT, '@deepseek-ai', 'cordis', 'lib', 'index.js')

/** The two prefixes the node half claims on the host web server. */
const EXPECTED_PREFIXES = ['/desktop', '/brand-logo']

const results = []
/** Teardown effects opened by the official service itself. */
const hostTeardowns = []
/** Teardown effects opened by the plugin (lib/index.js calls ctx.effect(fn) unlabeled). */
const pluginTeardowns = []
const registrations = []
const registerDisposers = []
const upgrades = []
const warnings = []
const errors = []

function check(label, pass, detail) {
  results.push({ label, pass, detail })
  const mark = pass ? 'PASS' : 'FAIL'
  const suffix = detail === undefined ? '' : ` — ${detail}`
  console.log(`  [${mark}] ${label}${suffix}`)
}

function toFileUrl(filePath) {
  return pathToFileURL(filePath).href
}

async function main() {
  console.log('== loading the real dsh-host-webserver ==')
  for (const entry of [WEBSERVER_ENTRY, CORDIS_ENTRY]) {
    if (!fs.existsSync(entry)) {
      console.error(`MISSING ${entry}`)
      console.error('This probe only runs where an official payload is unpacked.')
      console.error('Point DSH_OFFICIAL_MODULES at a node_modules root that holds it, or re-extract the one above.')
      process.exitCode = 1
      return
    }
  }
  const webserverModule = await import(toFileUrl(WEBSERVER_ENTRY))
  const WebServer = webserverModule.WebServer ?? webserverModule.default
  if (typeof WebServer !== 'function') {
    console.error('the official module did not export a WebServer class')
    process.exitCode = 1
    return
  }
  console.log(`  loaded WebServer from ${WEBSERVER_ENTRY}`)

  // --- the smallest cordis-shaped ctx the official service accepts ----------
  // dsh-host-webserver reads ctx.logger.* and registers a teardown through
  // ctx.effect; its constructor also runs the cordis Service base, which wants
  // ctx.reflect.provide — a no-op is enough outside a real container.
  const makeCtx = (sink) => ({
    logger: {
      info: () => {},
      debug: () => {},
      warn: (message) => { warnings.push(String(message)) },
      error: (message) => { errors.push(String(message)) },
    },
    reflect: { provide: () => {} },
    effect: (fn, label) => {
      const disposed = fn()
      const disposer = typeof disposed === 'function' ? disposed : () => {}
      sink.push({ label: label === undefined ? '(unlabeled)' : String(label), disposer })
      return disposer
    },
  })

  // --- boot the real server, then hand the SAME instance to the plugin ------
  // Listening is the cordis lifecycle hook [Service.init](), not a public
  // listen() method; the hook resolves once the socket is bound.
  const webServerCtx = makeCtx(hostTeardowns)
  const webServer = new WebServer(webServerCtx, { host: '127.0.0.1', port: 0, compression: 'none' })
  const cordis = await import(toFileUrl(CORDIS_ENTRY))
  const initHook = cordis.Service?.init ?? cordis.default?.init
  if (typeof initHook !== 'symbol') {
    console.error('could not resolve the cordis Service.init lifecycle symbol')
    process.exitCode = 1
    return
  }
  await initWebServer(webServer, initHook)
  const port = Number(webServer.port ?? webServer.listenedPort)
  check('real webserver listens on an ephemeral port', Number.isFinite(port) && port > 0, `port=${port}`)

  const pluginApply = (await import(toFileUrl(path.join(libDir, 'index.js')))).apply
  if (typeof pluginApply !== 'function') {
    console.error('lib/index.js exposes no apply(ctx) — this probe drives the node half only')
    process.exitCode = 1
    return
  }

  // Record what the plugin registers without fabricating a stand-in for the real
  // service: own properties on the instance shadow the prototype methods, and
  // everything else (the `port` accessor included) still resolves on the real
  // object. Each shim delegates immediately and restores nothing — this process
  // exists only to run this probe.
  const realRegister = webServer.register.bind(webServer)
  webServer.register = (route) => {
    registrations.push(route)
    const disposer = realRegister(route)
    registerDisposers.push(disposer)
    return disposer
  }
  let upgradeSeen = false
  if (typeof webServer.registerUpgrade === 'function') {
    const realRegisterUpgrade = webServer.registerUpgrade.bind(webServer)
    webServer.registerUpgrade = (route) => {
      upgradeSeen = true
      upgrades.push(route)
      return realRegisterUpgrade(route)
    }
  }

  const stored = {}
  const pluginCtx = {
    logger: webServerCtx.logger,
    webServer,
    connection: { authenticatedUrl: (base) => `${base}?token=fake-launch-token` },
    effect: makeCtx(pluginTeardowns).effect,
    // lib/index.js consumes `connection` + `webServer` through ctx.inject (soft
    // dependency); a fake container resolves every requested dependency itself.
    inject(deps, callback) {
      for (const dep of deps) {
        if (pluginCtx[dep] === undefined) throw new Error(`probe ctx cannot supply ${String(dep)}`)
      }
      return callback(pluginCtx)
    },
    set: (key, value) => { stored[key] = value },
  }

  console.log('== applying the plugin onto the real webserver ==')
  pluginApply(pluginCtx)

  // --- 1. the plugin claims exactly the two host-side prefixes --------------
  const claimed = registrations.map((route) => `${route.kind}:${route.path}`).sort()
  const expected = EXPECTED_PREFIXES.map((p) => `prefix:${p}`).sort()
  check(
    'node half registers exactly prefix:/desktop and prefix:/brand-logo',
    JSON.stringify(claimed) === JSON.stringify(expected),
    claimed.join(', ') || '(nothing registered)',
  )
  check(
    'official register() returned a disposer per claimed route',
    registrations.length === 2 && registerDisposers.length === 2 && registerDisposers.every((d) => typeof d === 'function'),
    `disposers=${registerDisposers.map((d) => typeof d).join(', ') || '(none)'}`,
  )
  check(
    'the retired /phone* family is not claimed on the host listener',
    !registrations.some((route) => String(route.path).startsWith('/phone')),
    `registrations=${registrations.length}`,
  )

  const base = `http://127.0.0.1:${port}`

  // --- 2. unclaimed path -> 404 (official behaviour, before any fallback) ----
  const unclaimed = await request(`${base}/nope`)
  check('unclaimed path returns 404', unclaimed.status === 404, `status=${unclaimed.status}`)
  const retired = await request(`${base}/phone`)
  check('GET /phone is 404 on the host listener now', retired.status === 404, `status=${retired.status}`)

  // --- 3. duplicate (kind, path) must throw the official error ---------------
  const first = registrations[0]
  let duplicateError
  if (first) {
    try { realRegister({ kind: first.kind, path: first.path, handler: () => {} }) }
    catch (error) { duplicateError = error }
  }
  check('duplicate (kind,path) throws', duplicateError instanceof Error, duplicateError?.message)

  // --- 4. /desktop is routed by the official matcher into the plugin handler -
  // The handler proxies to the bridge, which may still be coming up: a proxied
  // 200/403 (pairing page / refused) or the documented 503 all prove the official
  // register/match chain handed this request to the plugin rather than 404-ing it.
  const desktop = await request(`${base}/desktop`)
  check(
    'GET /desktop is served by the plugin through the official matcher',
    [200, 403, 503].includes(desktop.status),
    `status=${desktop.status} body=${desktop.body.slice(0, 60)}`,
  )
  if (desktop.status === 503) {
    console.log('    (bridge not ready yet — the proxy answered "Pocket bridge is not ready.")')
  }

  // --- 5. unclaimed WS upgrade is destroyed, not crashed ---------------------
  const upgrade = await probeUpgrade(port, '/not-a-registered-ws')
  check('unknown upgrade path gets no 101', !upgrade.upgraded, 'socket closed')
  check(
    'node half opens no WebSocket upgrade of its own',
    !upgradeSeen,
    upgradeSeen ? `count=${upgrades.length}` : 'count=0',
  )

  // --- 6. teardown removes the plugin routes, listener survives -------------
  for (const entry of pluginTeardowns) entry.disposer()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const afterDispose = await request(`${base}/desktop`)
  // A status line at all (rather than ECONNREFUSED) is what proves the official
  // listener is still up while the plugin's routes are gone.
  check('desktop route unregistered after teardown', afterDispose.status === 404, `status=${afterDispose.status}`)
  const brandAfterDispose = await request(`${base}/brand-logo/light`)
  check('brand-logo route unregistered after teardown', brandAfterDispose.status === 404, `status=${brandAfterDispose.status}`)

  for (const entry of hostTeardowns.reverse()) entry.disposer()
  await new Promise((resolve) => setTimeout(resolve, 50))

  if (stored.pocket !== undefined) {
    console.log('  note: the node half still ctx.set("pocket", …); that service has no consumer (audit item M1).')
  }
  console.log(`  warnings: ${warnings.length}, errors: ${errors.length}`)
  for (const message of errors.slice(0, 5)) console.log(`    error: ${message.slice(0, 160)}`)

  const failed = results.filter((r) => !r.pass)
  console.log(`\nREAL WEBSERVER ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`)
  if (failed.length > 0) process.exitCode = 1
}

/* --------------------------------- helpers -------------------------------- */

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method ?? 'GET', headers: options.headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', (error) => resolve({ status: 0, headers: {}, body: String(error?.message ?? error) }))
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
    const finish = () => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ upgraded })
    }
    const timer = setTimeout(finish, 1500)
    socket.on('data', (chunk) => {
      if (chunk.toString('latin1').startsWith('HTTP/1.1 101')) upgraded = true
      finish()
    })
    socket.on('error', finish)
    socket.on('close', () => { clearTimeout(timer); resolve({ upgraded }) })
  })
}

/**
 * Drive the official service into its listening state.
 *
 * `listen` is a cordis lifecycle hook (`async [Service.init]()`), so the callable
 * key is that symbol rather than a method name. Some payload revisions expose a
 * plain `listen()`; try the symbol first, then fall back.
 */
async function initWebServer(webServer, initHook) {
  // [Service.init] is a prototype method, reachable even though it is not an own
  // property of the instance.
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

// The bridge keeps the loop alive until its effect is disposed; the probe tears
// that down on the success path, and a failure path is allowed to exit non-zero.
process.on('uncaughtException', (error) => { console.error('uncaught:', error); process.exitCode = 1 })
