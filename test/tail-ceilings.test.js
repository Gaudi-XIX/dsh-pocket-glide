// R13-1.7: the page-side pack ceiling and the bridge-side record ceiling are one
// number. TAIL_PACK_MAX is a local inside the page script, so it cannot be
// imported; the repo's established read is to scrape the built asset (same as
// test/landing-attention.test.js:53 does for RECENT_WINDOW_MS). That read only
// works while the template keeps the form `TAIL_PACK_MAX=<plain number>;`
// (lib/pages.js), which is why the template interpolates the digit directly.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'
import { TAIL_MAX_RECORDS } from '../lib/constants.js'

test('the page-side tail cap and the bridge-side record ceiling are one value', () => {
  for (const locale of ['zh', 'en']) {
    const asset = mobilePageAssets({ locale }).js
    const hit = asset.match(/TAIL_PACK_MAX=(\d+)/)
    assert.ok(hit, `the ${locale} page script still ships a plain-number TAIL_PACK_MAX`)
    assert.equal(
      Number(hit[1]),
      TAIL_MAX_RECORDS,
      'the page-side tail cap and the bridge-side record ceiling are one value'
    )
  }
})
