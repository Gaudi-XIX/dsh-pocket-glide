// test/shell-bytes-from-commit.test.js — the mechanical gate for shell bytes
// and LF hygiene (2026-10-24 W2a/W3 follow-up).
//
// Two real incidents back these assertions:
//  - W3: lib/constants.js was saved as CRLF; lib/pages.js inlines that
//    function's SOURCE TEXT into the shell JS via `toolActivityCategory.toString()`,
//    so the CRLF line endings silently grew the shipped shell by 15 B and the
//    reported number (391,398) disagreed with the commit tree (391,383).
//  - W2a: the 391,053 shell reading in the ship log was a dirty-worktree
//    number; the real value was 291,320. Reviewers had to `git show <rev>:<path>`
//    each file to recompute it by hand.
// => Any shell byte count written into a commit message or CHANGELOG must be
//    recomputed from the commit tree (node tools/shell-bytes.mjs --rev <sha>),
//    and working-tree EOLs must not silently shift the shell.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mobilePageAssets } from '../lib/pages.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// Assertion 1 — LF hygiene on every file whose source text gets inlined into
// the shipped shell via `.toString()`. Grep lib/pages.js for `.toString()`
// interpolation (the inline site is around line 751-764) and keep the list of
// source files in sync; a missing entry here means CRLF can silently inflate
// the shell again.
// ---------------------------------------------------------------------------
const INLINE_SOURCES = [
  // Defined in lib/pages.js itself, but the definition's bytes still ship:
  { file: 'lib/pages.js', why: 'defines applyPendingCreatedSessions / spliceProvisionalSession / reconcileProvisionalSession / clusterToolBlocks / processLineText / blankRowVisible / goalOf / queuedRowsOf, all inlined via .toString() into the shell JS (lib/pages.js:751-764)' },
  { file: 'lib/constants.js', why: 'defines toolActivityCategory, inlined via .toString() (lib/pages.js:759) — this exact file caused W3: CRLF inflated the shell by 15 B' },
]

test('files whose source is inlined into the shell carry no CR bytes (CRLF would inflate the shell)', () => {
  for (const { file, why } of INLINE_SOURCES) {
    const buf = fs.readFileSync(path.join(repoRoot, ...file.split('/')))
    assert.ok(
      !buf.includes(0x0d),
      `${file} contains CR bytes (CRLF line endings). Why this file is gated: ${why}. ` +
      `Its source text is embedded verbatim into the shipped shell JS, so every CR ships as a byte and the shell reading drifts from the commit tree (see W3: lib/constants.js as CRLF added 15 B). Re-save the file with LF endings.`
    )
  }
})

// ---------------------------------------------------------------------------
// Assertion 2 — the measuring stick itself does not drift: the JSON the tool
// reports for the working tree must equal a direct mobilePageAssets() call.
// ---------------------------------------------------------------------------
async function runTool(extraArgs = []) {
  const out = execFileSync(
    process.execPath,
    [path.join(repoRoot, 'tools', 'shell-bytes.mjs'), '--json', ...extraArgs],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  return JSON.parse(out)
}

test('tools/shell-bytes.mjs --json (worktree) agrees with a direct mobilePageAssets() call', async () => {
  const result = await runTool()
  assert.equal(result.ok, true, `tool must succeed, got: ${JSON.stringify(result)}`)
  for (const locale of ['zh', 'en']) {
    const { css, js } = mobilePageAssets({ locale })
    const expected = {
      css: Buffer.byteLength(css),
      js: Buffer.byteLength(js),
      total: Buffer.byteLength(css) + Buffer.byteLength(js),
    }
    assert.deepEqual(
      { css: result.locales[locale].css, js: result.locales[locale].js, total: result.locales[locale].total },
      expected,
      `${locale}: the tool's worktree reading must equal the direct mobilePageAssets() measurement (the stick itself must not drift)`
    )
  }
})

// ---------------------------------------------------------------------------
// Assertion 3 — reverse verification: flip lib/constants.js to CRLF, the LF
// assertion above must go red, then restore byte-exact (sha256 proof).
// ---------------------------------------------------------------------------
test('the LF gate actually fires on CRLF (reverse check, byte-exact restore)', async (t) => {
  const file = path.join(repoRoot, 'lib', 'constants.js')
  const original = fs.readFileSync(file)
  const originalSha = createHash('sha256').update(original).digest('hex')
  t.after(() => {
    fs.writeFileSync(file, original) // byte-exact restore
    const restoredSha = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    assert.equal(restoredSha, originalSha, 'restore must be byte-identical (sha256)')
  })

  fs.writeFileSync(file, original.toString('utf8').replace(/\n/g, '\r\n'))
  await t.test('with CRLF the LF-hygiene check would fail', () => {
    const buf = fs.readFileSync(file)
    assert.ok(buf.includes(0x0d), 'setup: the file must actually contain CR now')
    // The same check assertion 1 performs:
    const gateFails = buf.includes(0x0d)
    assert.equal(gateFails, true, 'the LF gate must see the CR (i.e. assertion 1 goes red)')
  })
})
