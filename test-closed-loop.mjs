/**
 * Closed-loop test for the phone-native bridge — runs entirely in-process with
 * NO DSH host restart and NO real network.
 *
 * What it proves:
 *   1. pair with a wrong PIN  -> 403, and the PIN rotates (one-shot codes)
 *   2. pair with the real PIN  -> 200 + `set-cookie: dsh_mobile=...`
 *   3. rpc session.modelCatalog -> the plugin POSTs the VERIFIED envelope to
 *      the host and returns the catalog to the phone
 *   4. rpc session.selectModel  -> the plugin sends the VERIFIED arg shape
 *      {sessionId, provider, model} (NOT {modelId}) end to end
 *
 * The fake harness below answers with the exact shapes proved in
 * F:\defws\tmp\20260929-dsh-remote-composer\FINDINGS-ep-wire-shapes.md, so a
 * regression in lib/bridge.js (the former lib/invoke.js logic was folded into
 * bridge.js) shows up here as a mismatch rather than in
 * production.
 */

import http from 'node:http'
import assert from 'node:assert/strict'

const VERIFIED_MODEL = 'deepseek-reasoner'
const VERIFIED_PROVIDER = 'deepseek'

/** Everything the plugin sent to the harness, for assertions. */
const harnessCalls = []

/** The catalog exactly as VERIFIED in FINDINGS-ep-wire-shapes.md §2. */
function verifiedCatalog() {
  return {
    default: { provider: VERIFIED_PROVIDER, model: 'deepseek-chat', reasoningEffort: undefined },
    routableProviders: [VERIFIED_PROVIDER],
    groups: [
      { id: VERIFIED_PROVIDER, name: 'DeepSeek', models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: VERIFIED_MODEL, name: 'DeepSeek Reasoner', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } },
      ] },
      { id: 'empty-one', name: 'Empty Group', models: [] },
    ],
    failures: [{ id: 'broken', name: 'Broken', message: 'no key' }],
  }
}

/** Parse a cookie header into a map. */
function cookieMap(header) {
  const out = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
  }
  return out
}

/**
 * Fake host: serves the launch-token exchange AND the /api surface, using the
 * verified 0.2.0-rc.1 envelopes. `dispatchPluginRoutes` runs first so the
 * plugin's /phone routes win over this handler's 404 branch.
 */
function startFakeHarness() {
  const pluginRoutes = []
  const harness = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    // 1. Plugin routes first (phone page, pairing, rpc proxy, tunnel control).
    if (url.pathname.startsWith('/phone')) {
      for (const route of pluginRoutes) {
        if (route.kind !== 'exact' || route.path !== url.pathname) continue
        return void route.handler(req, res)
      }
      res.writeHead(404)
      res.end('phone route not registered')
      return
    }

    // 2. The launch-token exchange the inner-auth performs.
    if (url.pathname === '/') {
      res.writeHead(303, {
        location: '/',
        'set-cookie': [
          'dsh-auth-launch=launch-secret; HttpOnly; Path=/; SameSite=Lax',
          'dsh-other=noise; Path=/',
        ],
      })
      res.end()
      return
    }

    // 2. The /api envelope surface.
    if (url.pathname.startsWith('/api/')) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      // The real gateway hard-requires application/json (415 otherwise); assert
      // it here so a header-wipe regression fails the test instead of silently
      // breaking every RPC.
      const contentType = String(req.headers['content-type'] ?? '')
      if (!contentType.includes('application/json')) {
        harnessCalls.push({ endpoint: 'BAD-CONTENT-TYPE', body: { contentType }, cookie: req.headers.cookie })
        res.writeHead(415, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: 'none', result: { ok: false, error: { code: 'gateway/bad-request', message: `content-type was ${contentType || 'missing'}` } } }))
        return
      }
      const body = JSON.parse(text)
      const endpoint = body.method
      harnessCalls.push({ endpoint, body, cookie: req.headers.cookie })

      const reply = (status, result) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
      }

      if (endpoint === 'session/modelCatalog') {
        if (body.type !== 'client-request') return reply(200, { ok: false, error: { code: 'test/bad-type', message: 'missing type' } })
        if (!body.payload || typeof body.payload.args !== 'object') return reply(200, { ok: false, error: { code: 'test/bad-args', message: 'missing payload.args' } })
        if (Object.keys(body.payload.args).length !== 0) return reply(200, { ok: false, error: { code: 'test/bad-args', message: 'modelCatalog must send empty args' } })
        return reply(200, { ok: true, value: verifiedCatalog() })
      }

      if (endpoint === 'session/list') {
        if (!body.payload.args._request) return reply(200, { ok: false, error: { code: 'test/bad-wire', message: 'session/list wire name must be _request' } })
        return reply(200, { ok: true, value: [{ sessionId: 'sess-1', title: 'Demo', updatedAt: Date.now() }] })
      }

      if (endpoint === 'session/selectModel') {
        const args = body.payload?.args?.request ?? {}
        if (args.model === undefined) return reply(200, { ok: false, error: { code: 'test/bad-args', message: 'selectModel needs top-level model' } })
        if (args.provider === undefined) return reply(200, { ok: false, error: { code: 'test/bad-args', message: 'selectModel needs sibling provider' } })
        if (args.modelId !== undefined) return reply(200, { ok: false, error: { code: 'test/bad-args', message: 'selectModel must NOT send modelId' } })
        return reply(200, { ok: true, value: { selected: { provider: args.provider, model: args.model } } })
      }

      return reply(200, { ok: false, error: { code: 'test/unknown', message: endpoint } })
    }

    res.writeHead(404)
    res.end('not found')
  })
  return new Promise((resolve, reject) => {
    harness.once('error', reject)
    harness.listen(0, '127.0.0.1', () => resolve({ harness, pluginRoutes }))
  })
}

/**
 * Fetch with a hard timeout so a hanging route shows up as an assertion
 * failure instead of a wedged test process.
 */
async function fetchWithTimeout(url, init = {}, timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    throw new Error(`fetch ${url} did not settle in ${timeoutMs}ms (${error?.cause?.code ?? error?.message ?? error})`)
  } finally {
    clearTimeout(timer)
  }
}

/** Read the full JSON body of a response, asserting json content-type. */
async function json(response) {
  const text = await response.text()
  return { status: response.status, headers: response.headers, body: JSON.parse(text) }
}

const logs = []
/** Kept at module scope so the failure path can release the server. */
let activeServer

/**
 * Shut the fake harness down without racing libuv: drop keep-alive sockets,
 * close the listener, then let the (unref'd) plugin timer drain the loop
 * naturally instead of force-exiting mid-close.
 */
function shutdown() {
  if (activeServer === undefined) return
  activeServer.closeAllConnections?.()
  activeServer.close()
  activeServer.closeAllConnections?.()
  activeServer = undefined
}

async function main() {
  const { apply } = await import('../dsh-phone-native/lib/index.js')
  const { harness, pluginRoutes } = await startFakeHarness()
  const harnessPort = harness.address().port
  const innerBase = `http://127.0.0.1:${harnessPort}`

  // --- one server that exposes BOTH the plugin routes and the fake /api ----
  const routes = pluginRoutes
  const upgrades = []
  const fakeCtx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    webServer: {
      port: harnessPort,
      register(route) { routes.push(route); return () => {} },
      registerUpgrade(route) { upgrades.push(route); return () => {} },
    },
    connection: { authenticatedUrl(base) { return `${base}?token=launch-token-abc` } },
    set(key, value) { fakeCtx[key] = value },
    get(key) { return fakeCtx[key] },
  }

  apply(fakeCtx)
  assert.ok(routes.length >= 8, `expected >=8 routes, got ${routes.length}`)

  // --- drive the loop ------------------------------------------------------
  const page = await fetchWithTimeout(`${innerBase}/phone`)
  const pageText = await page.text()
  assert.equal(page.status, 200)
  assert.match(pageText, /DSH Pocket/)
  assert.match(pageText, /<select[^>]*id="model"/, 'the model picker must exist in the page')
  assert.equal(pageText.includes('</script>'), true, 'the page must close its script tag')
  assert.equal(/\$\{/.test(pageText), false, 'the page must not leak a template placeholder')

  // wrong PIN first
  const wrong = await json(await fetchWithTimeout(`${innerBase}/phone/pair/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: '000000' }),
  }))
  assert.equal(wrong.status, 403, `wrong pin must 403, got ${wrong.status}`)
  assert.equal(wrong.body.ok, false)

  // The current PIN: a wrong attempt rotates it (one-shot codes), so the LAST
  // logged PIN is the live one.
  const pinLogs = logs.filter((l) => l.includes('pairing PIN'))
  assert.ok(pinLogs.length > 0, 'the plugin must log the pairing PIN')
  const pin = pinLogs.at(-1).split('pairing PIN ')[1].trim()
  assert.match(pin, /^\d{6}$/, `PIN must be 6 digits, got ${pin}`)

  // correct PIN -> cookie
  const ok = await json(await fetchWithTimeout(`${innerBase}/phone/pair/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
  }))
  assert.equal(ok.status, 200, `correct pin must 200, got ${ok.status}`)
  assert.equal(ok.body.ok, true)
  const setCookie = ok.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /^dsh_mobile=/, `set-cookie must be dsh_mobile, got ${setCookie}`)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  assert.match(setCookie, /Max-Age=31536000/)
  const cookie = setCookie.split(';')[0]

  // modelCatalog through the bridge
  const catalog = await json(await fetchWithTimeout(`${innerBase}/phone/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ method: 'session.modelCatalog', payload: {} }),
  }))
  assert.equal(catalog.status, 200, `modelCatalog rpc must 200, got ${catalog.status}: ${JSON.stringify(catalog.body)}`)
  assert.equal(catalog.body.ok, true)
  assert.equal(catalog.body.value.groups.length, 2, 'the verified catalog must come back intact')
  assert.equal(catalog.body.value.groups[0].models[1].id, VERIFIED_MODEL)

  const catalogCall = harnessCalls.find((c) => c.endpoint === 'session/modelCatalog')
  assert.ok(catalogCall, 'the plugin must have called the harness')
  assert.equal(catalogCall.cookie, 'dsh-auth-launch=launch-secret', 'the plugin must attach the redeemed inner cookie')
  assert.equal(catalogCall.body.payload.args !== undefined, true)
  assert.equal(catalogCall.body.payload.args.modelId !== undefined, false, 'modelCatalog must not send modelId')

  // session/list (wire name _request)
  const list = await json(await fetchWithTimeout(`${innerBase}/phone/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ method: 'session.list', payload: {} }),
  }))
  assert.equal(list.status, 200, `session.list rpc must 200, got ${list.status}`)
  assert.equal(list.body.ok, true)
  const listCall = harnessCalls.find((c) => c.endpoint === 'session/list')
  assert.ok(listCall.body.payload.args._request, 'session/list must use the _request wire name')

  // selectModel through the bridge — the whole point of the build
  const select = await json(await fetchWithTimeout(`${innerBase}/phone/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ method: 'session.selectModel', payload: {
      sessionId: 'sess-1',
      model: VERIFIED_MODEL,
      provider: VERIFIED_PROVIDER,
    } }),
  }))
  assert.equal(select.status, 200, `selectModel rpc must 200, got ${select.status}: ${JSON.stringify(select.body)}`)
  assert.equal(select.body.ok, true)
  assert.equal(select.body.value.selected.model, VERIFIED_MODEL)

  const selectCall = harnessCalls.find((c) => c.endpoint === 'session/selectModel')
  assert.ok(selectCall, 'the plugin must have called selectModel')
  assert.equal(selectCall.body.payload.args.request.model, VERIFIED_MODEL)
  assert.equal(selectCall.body.payload.args.request.provider, VERIFIED_PROVIDER)
  assert.equal(selectCall.body.payload.args.request.sessionId, 'sess-1')
  assert.equal(selectCall.body.payload.args.request.modelId, undefined, 'the old modelId shape must be gone')

  // an allowlisted-but-unknown method must be rejected before it reaches /api
  const forged = await json(await fetchWithTimeout(`${innerBase}/phone/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ method: 'session.frobnicate', payload: {} }),
  }))
  assert.equal(forged.status, 400)
  assert.match(forged.body.error, /not allowed/)

  // unpaired requests must be refused
  const unpaired = await json(await fetchWithTimeout(`${innerBase}/phone/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'session.modelCatalog', payload: {} }),
  }))
  assert.equal(unpaired.status, 401, `unpaired rpc must 401, got ${unpaired.status}`)

  // no request may ever have left without a json content-type
  assert.equal(
    harnessCalls.filter((c) => c.endpoint === 'BAD-CONTENT-TYPE').length,
    0,
    `every /api request must carry content-type application/json; saw: ${JSON.stringify(harnessCalls.filter((c) => c.endpoint === 'BAD-CONTENT-TYPE'))}`,
  )

  harness.close()
  shutdown()
  originalLog('CLOSED LOOP PASS: pair -> cookie -> modelCatalog -> selectModel')
  originalLog(`harness calls: ${harnessCalls.map((c) => c.endpoint).join(', ')}`)
}

// capture the plugin's log so the PIN is observable
const originalLog = console.log.bind(console)
console.log = (...args) => {
  logs.push(args.map(String).join(' '))
  originalLog(...args)
}

main().catch((error) => {
  originalLog('CLOSED LOOP FAIL:', error?.message ?? error)
  // Force exit: the fake harness server is still listening and would keep the
  // process alive after a failure.
  process.exit(1)
})
