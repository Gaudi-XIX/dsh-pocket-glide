// Design #3c — the public-access consent gate — and the /manifest.json route
// (design #1a, WP2-3). The gate only ever fires on the tunnel path; LAN and
// the pairing funnel above it are pinned untouched.
//
// The consent PAGE itself is rendered by lib/pages.js (WP-1, contract D1).
// While that export is landing in parallel, the page-dependent arms skip with
// an explicit marker instead of failing: the gate logic under test here does
// not depend on the renderer, and the integration batch re-runs the file once
// both halves are on the tree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as pocketPages from '../lib/pages.js'
import { isValidTunnelHostname, isSafeConsentNext } from '../lib/bridge.js'
import { startBridge, httpFetch } from './helpers.js'

const tunnelHeaders = {
  'cf-connecting-ip': '203.0.113.7',
  'cf-ray': '8c1a-consent-SJC',
}

const consentPageReady = typeof pocketPages.renderConsentPage === 'function'

test('consent gate: tunnel GET / without the cookie is sent to /consent with next', async () => {
  const t = await startBridge()
  try {
    const res = await httpFetch(`${t.base}/`, { headers: tunnelHeaders })
    assert.equal(res.status, 303)
    assert.equal(res.headers.get('location'), '/consent?next=%2F')
    // A deep link keeps its destination through the disclaimer.
    const deep = await httpFetch(`${t.base}/some/path?x=1`, { headers: tunnelHeaders })
    assert.equal(deep.status, 303)
    assert.equal(deep.headers.get('location'), `/consent?next=${encodeURIComponent('/some/path?x=1')}`)
  } finally {
    await t.stop()
  }
})

test('consent gate: accept sets the year cookie (Secure on tunnel) and returns to next', async () => {
  const t = await startBridge()
  try {
    // JSON body (the page's fetch) …
    const json = await httpFetch(`${t.base}/consent/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tunnelHeaders },
      body: JSON.stringify({ next: '/' }),
    })
    assert.equal(json.status, 303)
    assert.equal(json.headers.get('location'), '/')
    const setCookie = json.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /^dsh_consent=1/)
    assert.match(setCookie, /Max-Age=31536000/)
    assert.match(setCookie, /SameSite=Lax/)
    assert.match(setCookie, /Secure/, 'tunnel mode marks the cookie Secure')
    // … and a plain form submit (urlencoded) lands the same way.
    const form = await httpFetch(`${t.base}/consent/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...tunnelHeaders },
      body: 'next=%2Freconnect',
    })
    assert.equal(form.headers.get('location'), '/reconnect')
  } finally {
    await t.stop()
  }
})

test('consent gate: after accepting, the app is reached directly', async () => {
  const t = await startBridge()
  try {
    const accepted = await httpFetch(`${t.base}/consent/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tunnelHeaders },
      body: JSON.stringify({ next: '/' }),
    })
    const consent = (accepted.headers.get('set-cookie') ?? '').split(';')[0]
    const mobile = await t.pairMobile('PocketConsent/1.0')
    const res = await httpFetch(`${t.base}/`, {
      headers: { ...tunnelHeaders, cookie: `${mobile}; ${consent}` },
    })
    assert.equal(res.status, 200, 'past the gate, the app document is served')
    // And /api/status answers instead of bouncing.
    const status = await httpFetch(`${t.base}/api/status`, {
      headers: { ...tunnelHeaders, cookie: `${mobile}; ${consent}` },
    })
    assert.equal(status.status, 200)
  } finally {
    await t.stop()
  }
})

test('consent gate: next is validated against open redirects', async () => {
  const t = await startBridge()
  try {
    for (const evil of ['//evil.example', '/\\evil.example', 'https://evil.example', 'relative']) {
      const res = await httpFetch(`${t.base}/consent/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...tunnelHeaders },
        body: JSON.stringify({ next: evil }),
      })
      assert.equal(res.status, 303, `${evil} is still an accept`)
      assert.equal(res.headers.get('location'), '/', `${evil} falls back to the app root`)
    }
    assert.equal(isSafeConsentNext('/ok/path'), true)
    assert.equal(isSafeConsentNext('//ok'), false)
  } finally {
    await t.stop()
  }
})

test('consent gate: LAN is untouched, and the gate never locks its own door', async () => {
  const t = await startBridge()
  try {
    // LAN: no consent cookie anywhere, nothing redirects.
    const landing = await httpFetch(`${t.base}/`)
    assert.equal(landing.status, 200, 'the unauthenticated LAN landing stays local')
    const status = await httpFetch(`${t.base}/api/status`)
    assert.equal(status.status, 401, 'LAN auth is exactly as it was')
    // The gate's own surface answers without a cookie — in tunnel mode too.
    if (consentPageReady) {
      const page = await httpFetch(`${t.base}/consent`, { headers: tunnelHeaders })
      assert.equal(page.status, 200, 'the disclaimer page is reachable from behind the gate')
      assert.ok((await page.text()).includes('consent'), 'the page renders')
    } else {
      t.skip('renderConsentPage 尚未落树（WP-1 并行中）——页面臂待两域合树后随 I 批复跑')
    }
  } finally {
    await t.stop()
  }
})

test('manifest route: authed+consent double gate over the tunnel, 401 on LAN', async () => {
  const t = await startBridge()
  try {
    // LAN unauthenticated → plain 401 (no consent dance on the LAN).
    assert.equal((await httpFetch(`${t.base}/manifest.json`)).status, 401)
    // Tunnel without the consent cookie → the gate answers first.
    const gated = await httpFetch(`${t.base}/manifest.json`, { headers: tunnelHeaders })
    assert.equal(gated.status, 303)
    assert.equal(gated.headers.get('location'), '/consent?next=%2Fmanifest.json')
    // Authed + consented over the tunnel → the manifest.
    const accepted = await httpFetch(`${t.base}/consent/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tunnelHeaders },
      body: JSON.stringify({ next: '/' }),
    })
    const consent = (accepted.headers.get('set-cookie') ?? '').split(';')[0]
    const mobile = await t.pairMobile('PocketManifest/1.0')
    const res = await httpFetch(`${t.base}/manifest.json`, {
      headers: { ...tunnelHeaders, cookie: `${mobile}; ${consent}` },
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/manifest\+json/)
    const manifest = JSON.parse(await res.text())
    assert.equal(manifest.name, 'DSH Pocket')
    assert.equal(typeof manifest.short_name, 'string')
    assert.equal(manifest.start_url, '/')
    assert.equal(manifest.display, 'standalone')
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0)
  } finally {
    await t.stop()
  }
})

test('named-tunnel hostname shape and consent next share one validator set', () => {
  for (const good of ['phone.example.com', 'a-b.example.com', 'p1.example-c.d']) {
    assert.equal(isValidTunnelHostname(good), true, `${good} is a valid tunnel hostname`)
  }
  for (const bad of ['', 'example', '-lead.example.com', 'trail-.example.com', 'a b.example.com', `${'a'.repeat(254)}.com`]) {
    assert.equal(isValidTunnelHostname(bad), false, 'malformed hostnames are refused')
  }
})

// The accept POST is the one no-payoff form on the surface, and a live Huawei
// browser answered the plain form submit with a Fetch-Metadata site stricter
// than same-origin — a bare JSON 403 between pairing and the app. Arms: a
// same-site (and header-less) form goes through, an explicit cross-site form
 // stays refused, and the relaxation does NOT leak to the pay-off routes.
test('consent accept tolerates same-site form posts; cross-site stays out; strict routes do not budge', async () => {
  const t = await startBridge()
  try {
    const form = (site) => httpFetch(`${t.base}/consent/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': site, ...tunnelHeaders },
      body: 'next=%2F',
    })
    assert.equal((await form('same-site')).status, 303, 'same-site form submission is accepted')
    assert.equal((await form('same-origin')).status, 303)
    const cross = await form('cross-site')
    assert.equal(cross.status, 403)
    assert.equal((await cross.json()).error, 'Cross-site request rejected.')
    // The relaxation is scoped to the accept endpoint: the strict check itself
    // does not budge. same-site rides Strict cookies on the pay-off routes, so
    // it stays refused there — asserted at the unit seam, an HTTP probe would
    // first have to clear the gate and the 401 to reach the origin check.
    assert.equal(t.bridge.verifyTrustedOrigin({ headers: { 'sec-fetch-site': 'same-site' } }), false)
    assert.equal(t.bridge.verifyTrustedOrigin({ headers: { 'sec-fetch-site': 'same-origin' } }), true)
  } finally {
    await t.stop()
  }
})
