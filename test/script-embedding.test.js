// JSON embedded in an inline <script> must not be able to close the tag.
//
// Live bug 2026-10-01: a session summary quoted this plugin's own source, so the
// boot payload contained `</script>`, the HTML parser closed the tag early and
// the rest of the payload was rendered onto the phone screen as a wall of text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderMobilePage, renderMobileReconnectPage, renderPairingPinPage } from '../lib/pages.js'

// The reconnect handoff and the pairing page used to carry their own copy of the
// same five stage functions. They now pull one block from `sharedStageScript()`,
// so every organ below must exist exactly once in the source and once per page.
const SHARED_ORGANS = [
  'const STEP_DWELL_MS=180,FETCH_TIMEOUT_MS=10000;',
  'function withTimeout(promise,ms){',
  'function pinError(message){',
  'const rpc=async(method,payload={})=>{',
  'const stageRunner=(setStep)=>{',
  'async function verifyPin(pin){',
  'async function showPinOnDesktop(){'
]

function occurrences(haystack, needle) {
  let seen = 0
  let at = 0
  for (;;) {
    const found = haystack.indexOf(needle, at)
    if (found < 0) return seen
    seen += 1
    at = found + needle.length
  }
}

function scriptBodies(html) {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1])
}

const nastyBoot = JSON.stringify({
  ws: { items: [] },
  sess: { items: [{ sessionId: 's1', prompt: '看这段 </script><b>x</b> 和 \u2028 分隔符', response: '收到' }] },
  settings: null
})

test('the boot payload cannot close its own script tag', () => {
  const html = renderMobilePage({ locale: 'zh', boot: nastyBoot, icon: null, initialChat: true })

  assert(html.includes('\\u003c/script'), 'the payload must escape its angle brackets')
  assert.doesNotMatch(html, /"prompt":"[^"]*<\/script>/, 'no raw closing tag inside the payload')
  assert.equal((html.match(/<script/g) ?? []).length, (html.match(/<\/script>/g) ?? []).length)

  const payload = html.match(/<script>window\.__POCKET_BOOT__=([\s\S]*?)<\/script>/)
  assert(payload, 'the payload must still be one intact script block')
  const parsed = JSON.parse(payload[1])
  assert.equal(parsed.sess.items[0].prompt, '看这段 </script><b>x</b> 和 \u2028 分隔符', 'escaping must round-trip exactly')
})

test('the split document escapes it too', () => {
  const html = renderMobilePage({
    locale: 'zh',
    boot: nastyBoot,
    icon: null,
    initialChat: true,
    assets: { cssUrl: '/app.css?h=x', jsUrl: '/app.js?l=zh&h=x' }
  })

  assert(html.includes('\\u003c/script'))
  assert.equal((html.match(/<script/g) ?? []).length, 3, 'boot + asset + bootstrap, nothing more')
  assert.equal((html.match(/<\/script>/g) ?? []).length, 3)
})

test('the pairing page escapes the locale payload the same way', () => {
  const html = renderPairingPinPage('zh', null)

  assert.match(html, /const T=\{\{?/)
  assert.doesNotMatch(html, /\$\{JSON\.stringify/)
})

test('the two bootstrap pages share one copy of the stage script', () => {
  const source = readFileSync(new URL('../lib/pages.js', import.meta.url), 'utf8')

  assert.equal(occurrences(source, 'function sharedStageScript()'), 1, 'one definition, module scope')
  assert.equal(occurrences(source, '${sharedStageScript()}'), 2, 'both bootstrap pages pull it')
  for (const organ of SHARED_ORGANS) {
    assert.equal(occurrences(source, organ), 1, `${organ} must not be written twice`)
  }
  assert.equal(occurrences(source, 'const stage=stageRunner(setStep);'), 2, 'each page keeps its own binding')
})

test('the shared block obeys the page template rules', () => {
  const source = readFileSync(new URL('../lib/pages.js', import.meta.url), 'utf8')
  const start = source.indexOf('function sharedStageScript(')
  const block = source.slice(start, source.indexOf('export function renderMobileReconnectPage('))

  assert.ok(block.length > 400, 'the block must still hold the whole stage script')
  assert.equal(occurrences(block, '`'), 2, 'the block itself is one template literal')
  assert.doesNotMatch(block, /<script/i, 'no opening tag inside the page template')
  assert.doesNotMatch(block, /nonce/i, 'the nonce is the renderer own business')
  assert.doesNotMatch(block, /\son(click|error|load|input|change|submit|keydown|keyup|focus|blur|touchstart|touchend)=/, 'no inline handler')
})

test('both bootstrap pages carry the shared block exactly once', () => {
  const reconnect = scriptBodies(renderMobileReconnectPage('zh', 'lan', {})).join('\n')
  const pairing = scriptBodies(renderPairingPinPage('zh', null, {})).join('\n')

  for (const organ of SHARED_ORGANS) {
    assert.equal(occurrences(reconnect, organ), 1, `the reconnect page must carry ${organ} once`)
    assert.equal(occurrences(pairing, organ), 1, `the pairing page must carry ${organ} once`)
  }
  assert.equal(occurrences(reconnect, 'const stage=stageRunner(setStep);'), 1)
  assert.equal(occurrences(pairing, 'const stage=stageRunner(setStep);'), 1)
})
