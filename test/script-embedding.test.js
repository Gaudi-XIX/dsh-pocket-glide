// JSON embedded in an inline <script> must not be able to close the tag.
//
// Live bug 2026-10-01: a session summary quoted this plugin's own source, so the
// boot payload contained `</script>`, the HTML parser closed the tag early and
// the rest of the payload was rendered onto the phone screen as a wall of text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMobilePage, renderPairingPinPage } from '../lib/pages.js'

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
