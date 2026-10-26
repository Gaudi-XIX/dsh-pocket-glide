// tools/shell-bytes.mjs — measure the mobile shell bytes from a git commit tree
// or the working tree. Any shell byte count that goes into a commit message or
// CHANGELOG must come from this script, not from a dirty-worktree reading
// (2026-10-24 W2a: the 391,053 reading was a dirty-tree number, the real value
// was 291,320).
//
// Usage: node tools/shell-bytes.mjs [--rev <git rev>] [--json]
//
// Default (no --rev): measure the working tree as-is.
// With --rev: export lib/** and package.json from the commit via
//   git show <rev>:<path> (NOT git archive — it applies CRLF conversion, which
//   is exactly the W3 trap) into a temp dir, then import the exported
//   lib/pages.js so the numbers reflect what the commit actually ships.
//
// Output is plain ASCII on purpose: the Windows console may be GBK and emoji
// would crash the print. Exits non-zero when measuring/importing fails.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const args = process.argv.slice(2)
let rev = null
let jsonOut = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--rev') { rev = args[i + 1]; i++ }
  else if (args[i] === '--json') jsonOut = true
  else { console.error(`unknown argument: ${args[i]}`); process.exit(2) }
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

function git(argsOut) {
  const r = spawnSync('git', argsOut, { cwd: repoRoot, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`git ${argsOut.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`)
  }
  return r.stdout
}

function fail(reason) {
  if (jsonOut) console.log(JSON.stringify({ ok: false, error: String(reason) }))
  else console.error(`shell-bytes: ${reason}`)
  process.exit(1)
}

// Which paths the shell build actually consumes. If lib/pages.js gains another
// import this list must follow it — the import below fails loudly if something
// is missing, so a stale list cannot produce silent wrong numbers.
const EXPORT_DIRS = ['lib', 'test']
const EXPORT_FILES = ['package.json']

let cleanup = null
try {
  let srcRoot = repoRoot
  if (rev !== null) {
    git(['rev-parse', '--verify', `${rev}^{commit}`]) // fail fast on a bad rev
    srcRoot = fs.mkdtempSync(path.join(tmpdir(), 'shell-bytes-'))
    cleanup = srcRoot
    const listed = git(['ls-tree', '-r', '--name-only', '-z', rev]).split('\0').filter(Boolean)
    let exported = 0
    for (const p of listed) {
      const inScope =
        EXPORT_FILES.includes(p) ||
        EXPORT_DIRS.some((d) => p === d || p.startsWith(d + '/'))
      if (!inScope) continue
      // Buffer form: shell text is UTF-8 and must land byte-exact (a UTF-8
      // round-trip through spawnSync's default encoding can also mangle it,
      // and we must not re-apply any EOL conversion).
      const buf = spawnSync('git', ['show', `${rev}:${p}`], {
        cwd: repoRoot,
        maxBuffer: 64 * 1024 * 1024,
      })
      if (buf.status !== 0) {
        throw new Error(`git show ${rev}:${p} failed: ${(buf.stderr || '').toString().trim()}`)
      }
      const dest = path.join(srcRoot, ...p.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, buf.stdout)
      exported++
    }
    if (exported === 0) fail(`no lib/** files exported from ${rev}`)
  }

  const pagesUrl = pathToFileURL(path.join(srcRoot, 'lib', 'pages.js')).href
  let assets
  try {
    const mod = await import(pagesUrl)
    assets = mod.mobilePageAssets
  } catch (err) {
    fail(`importing lib/pages.js (${rev ?? 'worktree'}) failed: ${err && err.stack ? err.stack : err}`)
  }
  if (typeof assets !== 'function') {
    fail(`lib/pages.js (${rev ?? 'worktree'}) does not export mobilePageAssets`)
  }

  const budgetSrc = fs.readFileSync(
    rev === null
      ? path.join(repoRoot, 'test', 'mobile-assets.test.js')
      : path.join(srcRoot, 'test', 'mobile-assets.test.js'),
    'utf8'
  )
  const budgetMatch = budgetSrc.match(/ASSET_BUDGET_BYTES\s*=\s*([\d_]+)/)
  if (!budgetMatch) fail('could not grep ASSET_BUDGET_BYTES from test/mobile-assets.test.js')
  const budget = Number(budgetMatch[1].replace(/_/g, ''))

  const locales = {}
  for (const locale of ['zh', 'en']) {
    const { css, js } = assets({ locale })
    const cssBytes = Buffer.byteLength(css)
    const jsBytes = Buffer.byteLength(js)
    locales[locale] = {
      css: cssBytes,
      js: jsBytes,
      total: cssBytes + jsBytes,
      budget,
      headroom: budget - (cssBytes + jsBytes),
    }
  }

  const result = { ok: true, rev: rev ?? 'worktree', locales }
  if (jsonOut) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`shell bytes (${rev ?? 'working tree'}), budget ${budget} B:`)
    for (const [locale, m] of Object.entries(locales)) {
      console.log(
        `  ${locale}: css ${m.css} + js ${m.js} = ${m.total} B, headroom ${m.headroom} B`
      )
    }
  }
} catch (err) {
  fail(err && err.message ? err.message : err)
} finally {
  if (cleanup) {
    try { fs.rmSync(cleanup, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}
