// The strip that ships smaller bytes. Everything below runs against the real
// rendered blocks, not against a fixture, so a change in lib/pages.js that makes
// the premise false reds here instead of quietly corrupting the shell.
//
// The two guarantees under test:
//
//   1. The strip removes comments and nothing else — every surviving byte is a
//      byte that was already there, in the same order.
//   2. The premise that makes whole-line removal safe — the shipped script has no
//      string literal spanning a newline, so a comment marker at the start of a
//      line can never be inside a string.
//
// Plus the @keep escape hatch, asserted in both directions: the pointer comment
// survives, and the strip really would have deleted it without the marker.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets, stripAssetComments, SHIPPED_COMMENT_KEEP } from '../lib/pages.js'

const blocks = (locale) => {
  const { document } = mobilePageAssets({ locale })
  const css = document.match(/<style>([\s\S]*?)<\/style>/)
  const scripts = [...document.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  return {
    css: css ? css[1] : '',
    js: scripts.length ? scripts[scripts.length - 1][1] : ''
  }
}

test('the shipped asset is exactly the inline block with the strip applied', () => {
  for (const locale of ['zh', 'en']) {
    const raw = blocks(locale)
    const assets = mobilePageAssets({ locale })
    assert.equal(assets.css, stripAssetComments(raw.css, 'css'), `${locale} css`)
    assert.equal(assets.js, stripAssetComments(raw.js, 'js'), `${locale} js`)
  }
})

test('the strip actually removes shipped bytes, in both kinds', () => {
  for (const locale of ['zh', 'en']) {
    const raw = blocks(locale)
    const assets = mobilePageAssets({ locale })
    const saved = Buffer.byteLength(raw.css) + Buffer.byteLength(raw.js)
      - Buffer.byteLength(assets.css) - Buffer.byteLength(assets.js)
    assert.ok(
      saved > 90_000,
      `${locale} should shed roughly 100 KB, only shed ${saved} B — the strip may have stopped matching`
    )
  }
})

test('the strip is idempotent', () => {
  for (const locale of ['zh', 'en']) {
    const assets = mobilePageAssets({ locale })
    assert.equal(stripAssetComments(assets.css, 'css'), assets.css, `${locale} css`)
    assert.equal(stripAssetComments(assets.js, 'js'), assets.js, `${locale} js`)
  }
})

// AC2.2b ① — the naive JS block-comment pattern would eat the '__bridge/*'
// text that lives inside a line comment (the errorCode prose), and swallow every
// byte after it up to some stray close. The shipped bytes must prove that comment
// is gone while the code that followed it is untouched.
test("the '__bridge/*' line comment does not swallow the code after it", () => {
  const raw = blocks('zh')
  const { js } = mobilePageAssets({ locale: 'zh' })
  const literal = "'__bridge/*'"
  const rawAt = raw.js.indexOf(literal)
  assert.notEqual(rawAt, -1, 'the literal that fools a block-comment pattern must be in the raw block')
  const rawLineStart = raw.js.lastIndexOf('\n', rawAt - 1) + 1
  const rawLineEnd = raw.js.indexOf('\n', rawAt)
  assert.ok(
    /^[ \t]*\/\//.test(raw.js.slice(rawLineStart, rawLineEnd)),
    'the literal must sit on a whole-line comment — that is what makes a naive pattern unsafe'
  )
  // The comment itself is stripped…
  assert.ok(!js.includes(literal), 'the comment that carried the literal must be stripped')
  // …and so is the rest of that comment paragraph, while the real code that used
  // to follow it is untouched. The proof is the paragraph's own tail: a naive
  // block pattern would have opened at the literal and run to the next `*/`,
  // which sits far past this code.
  const tail = 'This map turns the families a reader can act on into a real'
  assert.ok(raw.js.includes(tail), 'the comment paragraph tail must exist in the raw block')
  assert.ok(!js.includes(tail), 'the comment paragraph must be stripped')
  const codeStart = raw.js.indexOf('const BRIDGE_TRANSPORT_CODES=')
  assert.ok(codeStart > rawAt, 'real code must follow the comment paragraph')
  const code = raw.js.slice(codeStart, codeStart + 200)
  assert.ok(js.includes(code), 'the code that followed the comment must survive byte for byte')
})

// AC2.2b ② — CSS block comments can hold stray braces. Stripping them must not
// change the brace balance, or a comment could silently unbalance a rule.
test('stripping CSS block comments leaves the brace balance alone', () => {
  for (const locale of ['zh', 'en']) {
    const raw = blocks(locale)
    const css = mobilePageAssets({ locale }).css
    const count = (s, ch) => s.split(ch).length - 1
    for (const ch of ['{', '}']) {
      assert.equal(count(css, ch), count(raw.css, ch), `${locale} ${ch} count changed`)
    }
    assert.equal(count(css, '{'), count(css, '}'), `${locale} braces must balance after the strip`)
  }
})

// AC2.2b ③ — the premise guard. A backtick or a trailing backslash in the
// shipped script would break the "a line-initial comment marker is never inside a
// string" argument, and the strip would then eat real code.
test('the shipped script has no backticks and no line continuations', () => {
  for (const locale of ['zh', 'en']) {
    const { js } = mobilePageAssets({ locale })
    assert.equal(js.split('`').length - 1, 0, `${locale} the shipped script must contain no template literal`)
    assert.equal(js.split('\\\n').length - 1, 0, `${locale} the shipped script must contain no line continuation`)
    assert.equal(js.split('\r').length - 1, 0, `${locale} the shipped script must be LF-only`)
  }
})

test('the stripped script still parses as a function body', () => {
  for (const locale of ['zh', 'en']) {
    const { js } = mobilePageAssets({ locale })
    assert.doesNotThrow(() => new Function(js), `${locale} the stripped script must still parse`)
  }
})

// The @keep whitelist. The pointer comment below is a real contract:
// test/send-pending-ledger.test.js matches its text in the shipped bytes, so a
// blanket strip would delete the only copy that travels with the code.
const KEEP_POINTER = '// Send ordering/owner contract'

test('the @keep whitelist survives the strip, marker included', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  const kept = js.split('\n').filter((line) => line.includes(SHIPPED_COMMENT_KEEP))
  assert.equal(kept.length, 1, `exactly one line carries the keep marker, got ${kept.length}`)
  assert.ok(kept[0].includes(KEEP_POINTER), 'the kept line must be the send-ordering pointer')
  // The pointer's text is still a whole-line comment, so a future reader can see
  // it is the marker doing the work and not an accident of position.
  assert.ok(/^\s*\/\//.test(kept[0]), 'the kept line must still be a whole-line comment')
})

test('the whitelist is what keeps the pointer: without the marker the strip drops it', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  const marked = js.split('\n').find((line) => line.includes(SHIPPED_COMMENT_KEEP))
  assert.ok(marked, 'the marked line must ship')
  const unmarked = marked.split(SHIPPED_COMMENT_KEEP).join('')
  assert.equal(stripAssetComments(`${unmarked}\nrealCode()\n`, 'js'), 'realCode()\n', 'dropping the marker must drop the comment')
  assert.equal(stripAssetComments(`${marked}\nrealCode()\n`, 'js'), `${marked}\nrealCode()\n`, 'keeping the marker must keep the comment')
})

test('the strip leaves trailing comments and JS block comments alone', () => {
  const raw = blocks('zh')
  // Trailing comments: the comment marker must not be the first thing on its line.
  const trailing = raw.js.split('\n').filter((line) => /[^\s/]/.test(line.slice(0, line.indexOf('//') + 2)))
    .filter((line) => !line.slice(0, 2).includes('//'))
  assert.ok(trailing.length > 0, 'the raw block must carry trailing comments for this test to mean anything')
  const assets = mobilePageAssets({ locale: 'zh' })
  const survivors = assets.js.split('\n').filter((line) => !/^[ \t]*\/\//.test(line) && line.includes('//'))
  assert.ok(survivors.length > 0, 'trailing comments must survive')
  // JS block comments: 2 of them, 626 B measured on 2026-10-24. They are small and
  // a naive pattern is unsafe, so they ship as they are.
  const codePositionBlocks = [...assets.js.matchAll(/\/\*[\s\S]*?\*\//g)]
    .filter((m) => {
      const lineStart = assets.js.lastIndexOf('\n', m.index - 1) + 1
      return !/^[ \t]*\/\//.test(assets.js.slice(lineStart, m.index + 2))
    })
  assert.equal(codePositionBlocks.length, 2, `the 2 genuine JS block comments must ship, got ${codePositionBlocks.length}`)
})
