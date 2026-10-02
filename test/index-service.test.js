// WP-OPS-BRIDGE B2 / M1 + B2-R8 — the composition root, driven through a fake
// cordis container.
//
// M1 is the one item in this package whose symptom was the LOG itself: the
// plugin registered a `pocket` service it never declares (`export const provide`
// has zero hits in this tree), the host rejected the registration, and the
// rejection fell into a trailing `.catch()` on the start promise that blamed the
// bridge for failing to start. The result was a wall of false `bridge failed to
// start` lines on every launch, in the one place an operator looks when the
// phone cannot connect — so the diagnosis channel was actively lying.
//
// B2-R8 is the other half of the same complaint: when the listener really did
// fail (a `DSH_MOBILE_PORT` or an explicit port that collides — the +1 retry
// only covers 43127/43128 on the first attempt), the desktop iframe got
// "Pocket bridge is not ready." with no port and no errno in it.
//
// Everything here runs against a temp DSH_HOME and an ephemeral port; the real
// data root and the real product ports are never touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, notReadyBody, describeListenFailure } from '../lib/index.js'
import { defaultDshHome } from '../lib/constants.js'

const indexSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

/** Neutralise `DSH_MOBILE_PORT`, which would otherwise outrank the test port. */
const savedDshMobilePort = process.env.DSH_MOBILE_PORT
process.env.DSH_MOBILE_PORT = ''

function waitFor(predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const tick = () => {
      if (predicate()) return resolve(true)
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('condition never became true'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

/**
 * The smallest container that behaves like cordis here: `inject` runs its
 * callback, `effect` runs its setup and keeps the disposer, and `set` REJECTS a
 * service nobody provides — which is what the removed registration used to hit.
 * @param {{ providedServices?: string[] }} [options]
 */
function fakeContainer(options = {}) {
  const lines = []
  const provided = []
  const routes = []
  const hostCtx = {
    logger: {
      info: (message) => lines.push(`info ${message}`),
      warn: (message) => lines.push(`warn ${message}`),
      error: (message) => lines.push(`error ${message}`),
    },
    set(name, value) {
      provided.push(name)
      if (!options.providedServices?.includes(name)) {
        throw new TypeError(`Service "${name}" is not provided by this plugin`)
      }
      hostCtx.services[name] = value
    },
    inject(_deps, callback) {
      callback(hostCtx)
    },
    services: {},
    connection: {
      authenticatedUrl: (url) => `${url}/?token=<launch>`,
    },
    webServer: {
      port: 19387,
      register(route) {
        routes.push(route)
        return () => {
          route.disposed = true
        }
      },
    },
    effect(setup) {
      const dispose = setup()
      hostCtx.disposers.push(dispose)
      return dispose
    },
    disposers: [],
  }
  const ctx = {
    logger: hostCtx.logger,
    inject(_deps, callback) {
      callback(hostCtx)
    },
  }
  return { ctx, hostCtx, lines, provided, routes }
}

test('M1: the composition root registers no pocket service', () => {
  // The judgment this item was written against.
  assert.doesNotMatch(indexSrc, /hostCtx\.set\('pocket'/)
  assert.doesNotMatch(indexSrc, /\.set\(\s*['"]pocket['"]/)
  // And the reason it had no consumer: nothing declares the provider, and the
  // plugin still claims no services at all.
  assert.doesNotMatch(indexSrc, /^export const provide\b/m)
  assert.match(indexSrc, /export const inject = \[\]/)
})

/** Tear down whatever `apply()` registered. */
async function dispose(container) {
  if (!container) return
  for (const teardown of container.hostCtx.disposers) {
    try {
      await teardown?.()
    } catch {
      /* the disposer is best effort in a test */
    }
  }
}

test('M1: a successful start produces zero error lines', async () => {
  // Before the fix this is where 47 false `bridge failed to start` lines per
  // launch came from: the ready path threw and the trailing catch called it a
  // start failure. "no error-level line at all" is the whole item.
  const root = mkdtempSync(join(tmpdir(), 'pocket-index-ok-'))
  const savedDshHome = process.env.DSH_HOME
  const container = fakeContainer()
  try {
    process.env.DSH_HOME = root
    apply(container.ctx, { locale: 'zh', port: 0 })
    await waitFor(() => container.lines.some((line) => line.includes('Pocket bridge ready')))
    assert.deepEqual(
      container.lines.filter((line) => line.startsWith('error ')),
      [],
      `the ready path must not log an error: ${container.lines.join(' | ')}`
    )
    assert.ok(
      !container.lines.some((line) => line.includes('bridge failed to start')),
      'a bridge that is listening is not described as failed'
    )
    assert.deepEqual(container.provided, [], 'nothing was set on the container')
    // The ready line names the port it actually bound and the pairing surface.
    const ready = container.lines.find((line) => line.includes('Pocket bridge ready'))
    assert.match(ready, /0\.0\.0\.0:\d+/, 'the bound port is reported')
    assert.match(ready, /\/desktop/, 'the pairing page prefix is reported')
    assert.equal(defaultDshHome(), root, 'the run stayed inside the isolated data root')
  } finally {
    await dispose(container)
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    rmSync(root, { recursive: true, force: true })
  }
})

test('B2-R8: a real listen failure is told as one, with the port and the errno', async () => {
  // Occupy an ephemeral port, then ask the bridge to bind exactly that one. The
  // +1 retry does not apply here (it only covers 43127/43128 on the first
  // attempt), so this is the "set DSH_MOBILE_PORT and get a dead iframe" path.
  const root = mkdtempSync(join(tmpdir(), 'pocket-index-busy-'))
  const savedDshHome = process.env.DSH_HOME
  const squatter = createServer()
  let container
  try {
    const busyPort = await new Promise((resolve) => {
      // Squat the WILDCARD, not 127.0.0.1: Windows lets a specific-address bind
      // coexist with a later 0.0.0.0 bind, so the conflict the bridge must hit
      // has to be set up on the same address it uses.
      squatter.listen(0, '0.0.0.0', () => resolve(squatter.address().port))
    })
    process.env.DSH_HOME = root
    container = fakeContainer()
    apply(container.ctx, { locale: 'zh', port: busyPort })
    await waitFor(() => container.lines.some((line) => line.includes('bridge failed to start')))

    const failure = container.lines.filter((line) => line.includes('bridge failed to start'))
    assert.equal(failure.length, 1, 'exactly one line, on the one path that can say it')
    assert.match(failure[0], /EADDRINUSE/, 'the errno is in the log')

    // The desktop surface now repeats both facts instead of a dead end.
    const handler = container.routes.find((route) => route.path === '/desktop')?.handler
    assert(handler, 'the pairing route was registered')
    const answered = fakeResponse()
    handler({ method: 'GET', url: '/desktop', headers: {} }, answered)
    assert.equal(answered.statusCode, 503)
    assert.match(answered.body, /Pocket bridge is not ready/, 'the fixed sentence is still there')
    assert.ok(answered.body.includes(String(busyPort)), `the body names the port it tried: ${answered.body}`)
    assert.match(answered.body, /EADDRINUSE/, 'and the errno')
  } finally {
    await dispose(container)
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    await new Promise((resolve) => squatter.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})

test('B2-R8: the not-ready body stays generic when nothing is known', () => {
  // A bridge that is merely still starting must not be described as a failure:
  // there is no port and no errno to report yet.
  assert.equal(notReadyBody(undefined), 'Pocket bridge is not ready.')
  assert.equal(notReadyBody({}), 'Pocket bridge is not ready.')
  assert.equal(notReadyBody({ port: 0 }), 'Pocket bridge is not ready.')
  // Only an errno-shaped token is allowed into the body: no message, no path.
  assert.deepEqual(describeListenFailure(new Error('listen EADDRINUSE: whatever /C/private')), {})
  assert.deepEqual(describeListenFailure({ listenPort: 43127, listenErrno: 'EACCES' }), { port: 43127, errno: 'EACCES' })
  assert.deepEqual(describeListenFailure({ listenPort: 70000, listenErrno: 'eaddrinuse' }), {})
  assert.deepEqual(describeListenFailure('a string'), {})
  assert.deepEqual(describeListenFailure(undefined), {})
  assert.equal(notReadyBody({ port: 43128, errno: 'EACCES' }), 'Pocket bridge is not ready (port 43128, EACCES).')
})

test('B2-R8: a Node listen error carries what the body needs', async () => {
  // The shape the annotation depends on is asserted rather than assumed: the
  // bridge stamps `listenPort`/`listenErrno` where it rethrows.
  const root = mkdtempSync(join(tmpdir(), 'pocket-index-shape-'))
  const savedDshHome = process.env.DSH_HOME
  const squatter = createServer()
  const { LanMobileBridge } = await import('../lib/bridge.js')
  let bridge
  try {
    const busyPort = await new Promise((resolve) => {
      // Squat the WILDCARD, not 127.0.0.1: Windows lets a specific-address bind
      // coexist with a later 0.0.0.0 bind, so the conflict the bridge must hit
      // has to be set up on the same address it uses.
      squatter.listen(0, '0.0.0.0', () => resolve(squatter.address().port))
    })
    process.env.DSH_HOME = root
    bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:9',
      innerAuth: { ready: async () => undefined, invalidate: () => {} },
      port: busyPort,
      pairingPinStore: { load: () => ({}), save: () => true },
    })
    const error = await bridge.start().then(() => null, (caught) => caught)
    assert(error, 'binding a taken port fails fast, it is not retried')
    assert.equal(error.listenPort, busyPort, 'the port that was attempted is on the error')
    assert.equal(error.listenErrno, 'EADDRINUSE', 'and so is the errno')
    assert.match(notReadyBody(describeListenFailure(error)), new RegExp(String(busyPort)))
  } finally {
    // A started-but-unstopped bridge keeps the test process alive for ever.
    await bridge?.stop()
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    await new Promise((resolve) => squatter.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})

test('the proxy still refuses cross-site traffic before anything else', async () => {
  // §5 invariant: `createPairingProxy` deletes the inbound cookie and injects the
  // desktop session itself, and a browser-driven cross-site POST is refused
  // without ever reaching the bridge. The refusal must not move.
  const root = mkdtempSync(join(tmpdir(), 'pocket-index-cross-site-'))
  const savedDshHome = process.env.DSH_HOME
  const container = fakeContainer()
  try {
    process.env.DSH_HOME = root
    apply(container.ctx, { locale: 'zh', port: 0 })
    await waitFor(() => container.lines.some((line) => line.includes('Pocket bridge ready')))
    const handler = container.routes.find((route) => route.path === '/desktop')?.handler
    assert(handler, 'the pairing route was registered')
    const answered = fakeResponse()
    handler({ method: 'POST', url: '/desktop/pin/consent', headers: { 'sec-fetch-site': 'cross-site' } }, answered)
    assert.equal(answered.statusCode, 403)
    assert.match(answered.body, /Cross-site request rejected\./)
  } finally {
    await dispose(container)
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    rmSync(root, { recursive: true, force: true })
  }
})

/** Minimal stand-in for `ServerResponse` on the paths the proxy can take early. */
function fakeResponse() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      this.headersSent = true
      return this
    },
    end(chunk) {
      this.headersSent = true
      if (typeof chunk === 'string') this.body = chunk
      return this
    },
  }
}

test.afterEach(() => {
  process.env.DSH_MOBILE_PORT = savedDshMobilePort ?? ''
})
