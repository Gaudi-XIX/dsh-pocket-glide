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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { buildIconDataUri } from '../lib/icon.js'
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

// ---------------------------------------------------------------------------
// WP-RESCAN-A / R-T7 + R-T8 — the producer's own geometry and alpha handling.
// R-T7 (probe-03): `const S = src.width` was the stride, the y-clamp bound AND
// the scale edge, so a 200x100 source produced 96x96 with 4608 opaque + 4608
// fully transparent pixels (the lower half was lost), and a 100x200 source never
// sampled rows 100..199.
// R-T8 (probe-08): a straight-channel bilinear average across a transparency
// edge pulls colour out of pixels that are not there — 142/9216 pixels off by
// more than 8 levels, worst channel 63.67.
// ---------------------------------------------------------------------------

const PNGJS = await import(pathToFileURL(createRequire(import.meta.url).resolve('pngjs')).href)

/** Decode a data URI produced by buildIconDataUri. */
function decodeDataUri(uri) {
  const base64 = uri.slice(uri.indexOf(',') + 1)
  return PNGJS.PNG.sync.read(Buffer.from(base64, 'base64'))
}

/** Write a PNG fixture and return its path inside `dir`. */
function writePng(dir, name, width, height, fill) {
  const png = new PNGJS.PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const [r, g, b, a] = fill(x, y)
      png.data[o] = r
      png.data[o + 1] = g
      png.data[o + 2] = b
      png.data[o + 3] = a
    }
  }
  const file = join(dir, name)
  writeFileSync(file, PNGJS.PNG.sync.write(png))
  return file
}

/** @returns {{r: number, g: number, b: number, a: number}} pixel at (x, y). */
function pixel(png, x, y) {
  const o = (y * png.width + x) * 4
  return { r: png.data[o], g: png.data[o + 1], b: png.data[o + 2], a: png.data[o + 3] }
}

test('R-T7: a non-square source keeps its aspect ratio instead of losing half of itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-icon-geometry-'))
  try {
    // 200x100, opaque red everywhere. The old code emitted 96x96 and the bottom
    // half was transparent (it clamped y to width-1 = 199 but stepped by 2.08).
    const wide = writePng(dir, 'wide.png', 200, 100, () => [255, 0, 0, 255])
    const wideIcon = decodeDataUri(await buildIconDataUri(wide))
    assert.equal(wideIcon.width, 96, 'the long edge is bounded at 96')
    assert.equal(wideIcon.height, 48, 'and the short edge follows the source aspect ratio')
    for (let y = 0; y < wideIcon.height; y++) {
      for (let x = 0; x < wideIcon.width; x++) {
        const px = pixel(wideIcon, x, y)
        assert.equal(px.a, 255, `every pixel is opaque at ${x},${y} — the old code left the lower half transparent`)
        assert.ok(px.r > 240 && px.g < 15 && px.b < 15, `and still red at ${x},${y}`)
      }
    }

    // The transpose: 100x200. The old code emitted 96x96 and never sampled rows
    // 100..199 at all.
    const tall = writePng(dir, 'tall.png', 100, 200, (x, y) => (y < 100 ? [0, 0, 255, 255] : [0, 255, 0, 255]))
    const tallIcon = decodeDataUri(await buildIconDataUri(tall))
    assert.equal(tallIcon.width, 48, 'the short edge of a tall source is 48')
    assert.equal(tallIcon.height, 96, 'and the long edge is 96')
    assert.ok(pixel(tallIcon, 24, 24).b > 240, 'the top half is the source top half (blue)')
    assert.ok(pixel(tallIcon, 24, 72).g > 240, 'and the bottom half is the source bottom half (green) — rows 100..199 were sampled')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R-T7: a small or square source is not upscaled, and stays byte-identical', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-icon-square-'))
  try {
    const square = writePng(dir, 'square.png', 1024, 1024, (x, y) => [x % 256, y % 256, (x + y) % 256, 255])
    const icon = decodeDataUri(await buildIconDataUri(square))
    assert.equal(icon.width, 96, 'a large square still lands at 96x96')
    assert.equal(icon.height, 96, 'with the same aspect ratio it started with')

    // The byte-identical half of the claim: an opaque square source has no alpha
    // edges, so premultiplied and straight interpolation agree exactly.
    const small = writePng(dir, 'small.png', 32, 32, (x, y) => [x * 8, y * 8, 128, 255])
    const smallIcon = decodeDataUri(await buildIconDataUri(small))
    assert.equal(smallIcon.width, 32, 'a source smaller than the cap is not blown up')
    assert.equal(smallIcon.height, 32, 'in either direction')
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const px = pixel(smallIcon, x, y)
        assert.equal(px.a, 255, 'fully opaque sources stay fully opaque')
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R-T8: interpolation does not pull colour out of transparent pixels', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-icon-alpha-'))
  try {
    // A red disc on a fully transparent background whose RGB is BLACK (the
    // standard "transparent pixels carry no colour" encoding). Averaging straight
    // channels drags that black into the edge; premultiplied averaging cannot.
    const source = writePng(dir, 'disc.png', 200, 200, (x, y) => {
      const dx = x - 99.5
      const dy = y - 99.5
      return Math.hypot(dx, dy) <= 80 ? [255, 0, 0, 255] : [0, 0, 0, 0]
    })
    const icon = decodeDataUri(await buildIconDataUri(source))
    let worst = 0
    let damaged = 0
    for (let y = 0; y < icon.height; y++) {
      for (let x = 0; x < icon.width; x++) {
        const px = pixel(icon, x, y)
        if (px.a === 0) continue
        // Any partially or fully covered pixel must be a shade of the source red:
        // its green/blue channels may never rise above the noise floor.
        const deviation = Math.max(px.g, px.b)
        worst = Math.max(worst, deviation)
        if (deviation > 8) damaged += 1
      }
    }
    assert.equal(damaged, 0, `no covered pixel was contaminated by the transparent black: worst channel ${worst}`)

    // And the edge really is soft: a hard disc has partial alpha at the rim.
    const edge = [...Array(icon.width).keys()].some((x) => {
      const px = pixel(icon, x, Math.floor(icon.height / 2))
      return px.a > 0 && px.a < 255
    })
    assert.ok(edge, 'the resample produced antialiased alpha at the rim')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R-T8: the real host icon still builds, and the square-source output is unchanged', async () => {
  // The regression the R-T8/R-T7 changes could have caused: the machine's real
  // app icon is a 1024x1024 square with alpha. Its data URI must still build and
  // must still be a plausible PNG (baseline before the change: 10554 chars).
  const hostIcon = 'D:\\DSH\\resources\\icon.png'
  if (!existsSync(hostIcon)) return
  const uri = await buildIconDataUri(hostIcon)
  assert.ok(typeof uri === 'string' && uri.startsWith('data:image/png;base64,'), 'the host icon still yields a data URI')
  const decoded = decodeDataUri(uri)
  assert.equal(decoded.width, 96, 'the host icon is square, so it is still 96x96')
  assert.equal(decoded.height, 96, 'in both directions')
  assert.ok(uri.length > 8000, `the icon is still a real image, not a blank one (${uri.length} chars)`)
})
