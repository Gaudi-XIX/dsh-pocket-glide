// P1-6 (2026-11-04): a bot-to-bot relay used to arrive as a small event chip
// carrying the sender's name with a "· " prefix, and the phone had no way to
// click back to the bot that sent it. The relay head is now the same divider
// the transcript already draws between earlier parts, and the sender's name is
// the only thing it shows — the relayed body must never be re-printed as a
// message of its own.
import test from 'node:test'
import assert from 'node:assert/strict'

import { mobilePageAssets } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, `function ${name} must exist in the page source`)
  let i = source.indexOf('{', start)
  let depth = 0
  for (; i < source.length; i++) {
    const c = source[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return source.slice(start, i + 1) }
  }
  assert.fail(`function ${name} is never closed`)
}

// renderBlock reaches for a dozen renderers the relay branch never touches.
// A with-scope proxy satisfies every free name with an inert stub and hands the
// real esc to the branch under test, so the assertion measures the page's own
// markup without dragging the whole message renderer into the sandbox.
function buildRenderBlock() {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const real = { esc }
  const stub = () => ''
  const scope = new Proxy({}, { has: () => true, get: (_t, key) => (key in real ? real[key] : key === Symbol.unscopables ? undefined : stub) })
  return new Function('scope', `with(scope){ ${extractFunction(js, 'renderBlock')} return renderBlock }`)(scope)
}

const renderBlock = buildRenderBlock()

test('B12 a relay head renders as the transcript divider, not an event chip', () => {
  const html = renderBlock({ kind: 'divider', text: 'Pixel' }, false, 'relay-1')
  assert.equal(html, '<div class="earlier-divider"><span>Pixel</span></div>', 'exactly the divider the earlier-parts markup already uses')
  assert.doesNotMatch(html, /·/, 'no name prefix rides along any more')
  assert.doesNotMatch(html, /earlier-event/, 'and it is no longer an event chip')
})

test('B12 the divider escapes the name it is handed', () => {
  const html = renderBlock({ kind: 'divider', text: '<Pixel & Co>' }, false, 'relay-2')
  assert.equal(html, '<div class="earlier-divider"><span>&lt;Pixel &amp; Co&gt;</span></div>')
})

test('B14 the relay capsule stays deferred (L3 byte gate)', (t) => {
  // The capsule (a .subagent-row per relaying bot, labelled by the sender and
  // opening bots[].sessionId) measured ~684 B of shipped assets. With the lean
  // fix at 300998 B (zh) against an effective 301000 B gate, another 684 B is not
  // available, so design.md's L3 fallback applies: the divider ships, the
  // capsule waits for the budget decision. Nothing here is asserted as done.
  if (!js.includes('data-relay-peer')) {
    t.skip('deferred (L3): capsule needs ~684 B; shipped total is 300998 B against a 301000 B gate')
    return
  }
  assert.match(js, /data-relay-peer="'\+esc\(p\.sessionId\)\+'"/, 'the row opens bots[].sessionId, not the sender session id')
  assert.match(js, /relayPeers\.set\(row\.peer,who\)/, 'the label comes from the sender bot the row names')
})

test('B13 the relay row carries the sender name and nothing of the body', () => {
  const relay = js.match(/out\.push\(\{role:'event',blocks:\[\{kind:'divider',text:who\}\]/)
  assert.ok(relay, 'the relay row is built as a divider block')
  const branch = js.slice(js.indexOf("const who=String(s.senderName||s.name||'')"), js.indexOf("const who=String(s.senderName||s.name||'')") + 260)
  assert.doesNotMatch(branch, /s\.text|s\.body|s\.content/, 'the relayed body is never copied into the row')
  const fixture = 'relay-body-fixture-7f21'
  const html = renderBlock({ kind: 'divider', text: 'Pixel', body: fixture, text2: fixture }, false, 'relay-3')
  assert.equal(html.includes(fixture), false, 'a body attached to the block never reaches the DOM')
})
