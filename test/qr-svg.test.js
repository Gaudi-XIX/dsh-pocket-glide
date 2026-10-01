// Self-contained QR encoder (lib/qr-svg.js) correctness.
//
// Matrix fixtures are generated from the reference `qrcode` package by
// tools/gen-qr-fixtures.mjs (dev-only) and committed as
// test/fixtures/qr-matrices.json. This test never imports qrcode, so it keeps
// passing once that dependency is removed. Exact matrix equality (not a fuzzy
// comparison) is what guarantees the symbols remain scannable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodeQr, renderQrSvg } from '../lib/qr-svg.js'

const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/qr-matrices.json', import.meta.url), 'utf8'),
)

for (const fixture of fixtures.cases) {
  test(`matrix matches reference: ${fixture.name}`, () => {
    const result = encodeQr(fixture.text)
    assert.equal(result.version, fixture.version, 'selected version')
    assert.equal(result.size, fixture.size, 'symbol size')
    assert.equal(result.modules.length, fixture.size * fixture.size)
    assert.deepEqual(Array.from(result.modules), Array.from(fixture.bits, Number))
  })
}

test('SVG: standalone markup with width/height/viewBox and one rect per dark module', () => {
  const fixture = fixtures.cases.find((c) => c.name === 'ascii-short')
  const svg = renderQrSvg(fixture.text)

  assert.equal(typeof svg, 'string')
  // innerHTML-compatible: no XML declaration or doctype.
  assert.ok(!svg.startsWith('<?xml'), 'no XML declaration')
  assert.ok(!/<!doctype/i.test(svg), 'no doctype')
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, /width="260" height="260"/)
  assert.match(svg, new RegExp(`viewBox="0 0 ${fixture.size + 2} ${fixture.size + 2}"`))
  assert.match(svg, /shape-rendering="crispEdges"/)
  assert.match(svg, /<\/svg>$/)

  // Exactly one background rect plus one rect per dark module.
  const darkCount = fixture.bits.split('').filter((b) => b === '1').length
  assert.equal((svg.match(/<rect\b/g) || []).length, darkCount + 1)
  assert.match(svg, /<rect[^>]*fill="#ffffff"\/>/)
})

test('SVG: options.width and options.margin are honored', () => {
  const text = fixtures.cases.find((c) => c.name === 'ascii-short').text
  const { size } = encodeQr(text)

  const svg = renderQrSvg(text, { width: 480, margin: 4 })
  assert.match(svg, /width="480" height="480"/)
  const extent = size + 8
  assert.match(svg, new RegExp(`viewBox="0 0 ${extent} ${extent}"`))
  // Module rects are offset by the (quiet-zone) margin.
  assert.match(svg, new RegExp(`<rect x="4" y="4" width="1" height="1"`))
})

test('SVG: margin 0 places modules at the origin', () => {
  const text = fixtures.cases.find((c) => c.name === 'ascii-short').text
  const svg = renderQrSvg(text, { margin: 0 })
  assert.match(svg, /<rect x="0" y="0" width="1" height="1"/)
})

test('empty and multibyte UTF-8 inputs render', () => {
  const empty = fixtures.cases.find((c) => c.name === 'empty')
  assert.equal(renderQrSvg(empty.text).length > 0, true)

  const chinese = fixtures.cases.find((c) => c.name === 'utf8-chinese')
  const svg = renderQrSvg(chinese.text)
  assert.match(svg, new RegExp(`viewBox="0 0 ${chinese.size + 2} ${chinese.size + 2}"`))
})

test('overflow past version 10 throws', () => {
  // Version 10 / level M holds 213 UTF-8 bytes in byte mode.
  assert.equal(encodeQr('a'.repeat(213)).version, 10)
  assert.throws(() => encodeQr('a'.repeat(214)), /too long/i)
})

test('every mask pattern is a valid deterministic choice per input', () => {
  // Mask selection is covered transitively by exact matrix equality; here just
  // assert the reported pattern is in range and stable across calls.
  for (const fixture of fixtures.cases) {
    const first = encodeQr(fixture.text)
    const second = encodeQr(fixture.text)
    assert.ok(Number.isInteger(first.maskPattern))
    assert.ok(first.maskPattern >= 0 && first.maskPattern <= 7)
    assert.equal(first.maskPattern, second.maskPattern)
  }
})
