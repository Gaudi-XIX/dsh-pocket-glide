// P2-7 (2026-11-04): an image that has not loaded yet collapsed to nothing, so
// a gallery of attachments made the transcript jump when the bytes arrived. The
// two image rules now replace aspect-ratio:auto with a 96px height floor; the
// picture still drives its own shape (no object-fit, no fixed aspect ratio).
import test from 'node:test'
import assert from 'node:assert/strict'

import { mobilePageAssets } from '../lib/pages.js'

const { css, js } = mobilePageAssets({ locale: 'zh' })

function rule(selector) {
  const at = css.indexOf(selector + '{')
  assert.notEqual(at, -1, `${selector} must exist in the shipped stylesheet`)
  const end = css.indexOf('}', at)
  return css.slice(at, end + 1)
}

test('B15 an inline attachment reserves its height before the bytes arrive', () => {
  const attach = rule('.attach-image img')
  assert.match(attach, /min-height:96px/, 'the image keeps a 96px floor while loading')
  assert.doesNotMatch(attach, /aspect-ratio/, 'aspect-ratio:auto was replaced, not duplicated')
  assert.doesNotMatch(attach, /object-fit/, 'no crop was introduced to get the floor')
})

test('B15 a markdown image reserves its height too', () => {
  const md = rule('.md-image')
  assert.match(md, /min-height:96px/, 'the markdown image keeps the same floor')
  assert.doesNotMatch(md, /aspect-ratio/)
})

test('B15 both image paths still defer their load', () => {
  const lazy = js.match(/<img loading="lazy"/g) || []
  assert.ok(lazy.length >= 2, `attach and markdown images both stay lazy (saw ${lazy.length})`)
})
