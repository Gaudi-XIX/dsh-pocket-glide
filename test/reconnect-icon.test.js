// WP-BRIDGE-EXTRA K-1 / SEAM-3 (the bridge half of a two-part fix).
//
// The recovery page (`/disconnected`, both `/reconnect` branches, and the
// unauthenticated landing on `GET /`) is rendered for a phone that has NOT paired —
// that is its entire audience. Branding routes (`/brand-logo/*`, `/app-icon`) are
// gated to paired devices since B1/M15, so an `<img>` pointing at one of them is a
// guaranteed 401 and an empty slot on exactly the page where the user is already lost.
//
// The consumer half landed in `1cbfd41`: the renderer emits the image only when the
// caller passes `options.icon`, otherwise a text brand row. This file pins the
// producer: the bridge already holds `this.iconDataUri` — the same value the pairing
// page and the app document hand over — and has to offer it at every exit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { startBridge, httpFetch } from './helpers.js'

const readFileSource = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8')
const MARKER = 'data:image/png;base64,RVhUUkEtaWNvbg=='

/** The four bridge exits of the recovery page, keyed by what they answer. */
const EXITS = [
  { name: '/disconnected', path: '/disconnected', headers: {}, expect: 'the disconnected page' },
  { name: '/reconnect (lan, nothing to resume)', path: '/reconnect', headers: {}, expect: 'the rescan card' },
  {
    name: '/reconnect (tunnel, no password accepted)',
    path: '/reconnect',
    // Carrier headers are how a request is put on the tunnel path from loopback
    // without a carrier running — the same technique the B1 origin test uses.
    headers: { 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'exit-three' },
    expect: 'the expired-tunnel card',
  },
  { name: 'GET / (unauthorised landing)', path: '/', headers: {}, expect: 'the landing card' },
]

test('K-1: every bridge exit hands the recovery page the icon it already holds', async () => {
  const source = await readFileSource('lib/bridge.js')
  const starts = [...source.matchAll(/renderMobileReconnectPage\(this\.locale\(\)/g)]
  // A number, not a minimum: a fifth exit is a new page that has to be wired too.
  assert.equal(starts.length, 4, 'the recovery renderer has four bridge exits')
  let withIcon = 0
  for (const match of starts) {
    const tail = source.slice(match.index, source.indexOf(' }))', match.index))
    assert.ok(tail.length > 0 && tail.length < 600, `the exit at ${match.index} was not sliceable`)
    if (/\bicon: this\.iconDataUri\b/.test(tail)) withIcon += 1
  }
  assert.equal(withIcon, starts.length, 'an exit that withholds the icon leaves the handset a missing brand image')
})

test('K-1: with an icon in hand all four exits render it, and none renders a gated route', async () => {
  const t = await startBridge()
  try {
    // The icon is decoded from disk by the host path; the page only ever sees the
    // string the bridge hands over, so that string is set directly here.
    t.bridge.iconDataUri = MARKER
    // Take the tunnel branch off its other exit: with a password in hand the
    // bridge answers /reconnect with the PIN page instead of the expired card.
    t.bridge.ephemeralPin = undefined
    t.bridge.ephemeralPinExpiresAt = undefined
    for (const exit of EXITS) {
      const res = await httpFetch(`${t.base}${exit.path}`, { headers: exit.headers })
      const body = await res.text()
      assert.equal(res.status, 200, `${exit.name} answers locally (${exit.expect})`)
      assert.ok(body.includes(MARKER), `${exit.name} must carry the icon the bridge holds`)
      assert.doesNotMatch(body, /src="\/brand-logo\//, `${exit.name} must not point an unpaired phone at a gated route`)
      assert.doesNotMatch(body, /src="\/app-icon"/, `${exit.name} must not point an unpaired phone at a gated route`)
    }
  } finally {
    await t.stop()
  }
})

test('K-1: with no icon in hand the page degrades to the text row, never to a gated route', async () => {
  const t = await startBridge()
  try {
    // The helper boots without an icon path, so this is the real half-built state:
    // nothing to hand over, and the consumer must not invent a URL for it.
    assert.equal(t.bridge.iconDataUri, null, 'no icon source configured for this bridge')
    for (const exit of EXITS) {
      const res = await httpFetch(`${t.base}${exit.path}`, { headers: exit.headers })
      const body = await res.text()
      assert.equal(res.status, 200, exit.name)
      assert.doesNotMatch(body, /src="\/brand-logo\//, `${exit.name} falls back to text, not to a gated image`)
      assert.match(body, /DSH Pocket/, `${exit.name} still names the product without an image`)
    }
  } finally {
    await t.stop()
  }
})

test('K-1: offering the icon changes nothing about who may see these pages', async () => {
  const t = await startBridge()
  try {
    t.bridge.iconDataUri = MARKER
    const before = t.bridge.sessions.size
    for (const exit of EXITS) {
      const res = await httpFetch(`${t.base}${exit.path}`, { headers: exit.headers })
      await res.text()
      assert.equal(res.headers.get('set-cookie'), null, `${exit.name} issues no session to a stranger`)
    }
    assert.equal(t.bridge.sessions.size, before, 'and mints no session either — this is a rendering change')
    // The gate on the asset routes themselves is untouched (B1/M15).
    assert.notEqual((await httpFetch(`${t.base}/brand-logo/light`)).status, 200, 'branding stays gated')
  } finally {
    await t.stop()
  }
})
