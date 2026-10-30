// JSON embedded in an inline <script> must not be able to close the tag.
//
// Live bug 2026-10-01: a session summary quoted this plugin's own source, so the
// boot payload contained `</script>`, the HTML parser closed the tag early and
// the rest of the payload was rendered onto the phone screen as a wall of text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import {
  mobilePageAssets,
  renderConsentPage,
  renderDesktopPairingPage,
  renderMobilePage,
  renderMobileReconnectPage,
  renderPairingPinPage
} from '../lib/pages.js'
import { BOT_PAGE_JS } from '../lib/bot-page.js'

// The reconnect handoff and the pairing page used to carry their own copy of the
// same five stage functions. They now pull one block from `sharedStageScript()`,
// so every organ below must exist exactly once in the source and once per page.
const SHARED_ORGANS = [
  // 2026-10-29：首行的 STEP_DWELL_MS=200 已删（阶梯不再有固定节拍，改由各腿读回结果
  // 驱动推进，见 lib/pages.js 里 stageRunner 的注释）。锚跟着改成剩下的那条常量——
  // 改锚不改结构：仍然要求这段共享源码只存在一份、每页各内联一次。
  'const FETCH_TIMEOUT_MS=10000;',
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
  // 四段：boot + 外链 asset + 文档级提问卡 markup（head）+ bootstrap。
  assert.equal((html.match(/<script/g) ?? []).length, 4, 'boot + asset + card markup + bootstrap, nothing more')
  assert.equal((html.match(/<\/script>/g) ?? []).length, 4)
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
  assert.equal(occurrences(source, 'const stage=stageRunner(openRow);'), 2, 'each page keeps its own binding')
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
  assert.equal(occurrences(reconnect, 'const stage=stageRunner(openRow);'), 1)
  assert.equal(occurrences(pairing, 'const stage=stageRunner(openRow);'), 1)
})

// Every page script here is a JS template literal that EMITS JavaScript, so an edit
// can leave lib/pages.js itself perfectly valid while the phone gets a page that
// parses to nothing — and no byte-level or string-level assertion notices. Caught
// live 2026-10-10: a `Promise.all([...])` batch of handoff stages shipped one
// unbalanced paren on the PIN page only, with the whole suite green.
test('PARSE: every inline script of every phone page actually parses', () => {
  const pages = {
    'app document': renderMobilePage({ locale: 'zh', boot: JSON.stringify({ ws: { items: [] }, sess: { items: [] } }), initialChat: true }),
    'app document (en)': renderMobilePage({ locale: 'en', boot: null, initialChat: false }),
    'pairing pin page': renderPairingPinPage('zh', null, {}),
    'pairing pin page (en)': renderPairingPinPage('en', null, {}),
    'reconnect (tunnel)': renderMobileReconnectPage('zh', 'tunnel', {}),
    'reconnect (lan)': renderMobileReconnectPage('en', 'lan', {}),
    'desktop pairing': renderDesktopPairingPage({ locale: 'zh', pairingUrl: 'https://x', pairingPin: '12345678' }),
    'consent': renderConsentPage('zh', { next: '/?x=1' })
  }
  let blocks = 0
  for (const [name, html] of Object.entries(pages)) {
    for (const body of scriptBodies(html)) {
      if (!body.trim()) continue
      blocks += 1
      try {
        new vm.Script(body, { filename: `${name} block ${blocks}` })
      } catch (error) {
        assert.fail(`${name} ships a script the browser cannot parse: ${error.message}`)
      }
    }
  }
  assert.ok(blocks >= 8, `the guard must cover the real page set, saw ${blocks} blocks`)

  // The cached shell is the same hazard one layer down: it is a template too.
  for (const locale of ['zh', 'en']) {
    const { js } = mobilePageAssets({ locale })
    try {
      new vm.Script(js, { filename: `app.js ${locale}` })
    } catch (error) {
      assert.fail(`the ${locale} shell asset does not parse: ${error.message}`)
    }
  }

  // The bot page's script is served on its own route (/bot.js), so it never
  // reaches the inline-block walk above — yet it is built the same way (a
  // String.raw template that emits JavaScript) and took the shared markdown
  // injection on 2026-10-27, so it gets the same parse gate.
  try {
    new vm.Script(BOT_PAGE_JS, { filename: 'bot.js' })
  } catch (error) {
    assert.fail(`the bot page script does not parse: ${error.message}`)
  }
})

// 阶梯的<定义位置>是这份文档能不能跑的前提，不只是字节问题。
//
// 带 assets 的文档里，外链 app.js 一定排在 bootstrap 之前，而经典脚本按文档顺序执行；
// app.js 本体（lib/pages.js 主脚本）里的冷启动卡在顶层就调 `ladderRun({...})`。所以阶梯
// 一旦只住在 bootstrap 里（commit d0449d3 的做法），真机冷开时 app.js 先跑，抛
// `ReferenceError: ladderRun is not defined`，catch 里 ovFail() 又撞上 `ovLadder` 的 TDZ
// 抛出第二个错，async IIFE reject，loadListData/renderWorkspaces 再也不会执行，而
// `window.__pocketAppReady=true` 照常置位——遮罩永久停在「正在打开 Pocket」，列表空白。
//
// 三条既有测试都看不见它：handoff-boot-dedup 只称字节，landing-transition-card 只把
// bootstrap 抽出来跑（主脚本被替身掉），bot-page 只对字符串做 match。这条测试钉的是
// 顺序本身：定义必须出现在外链 script 标签之前，且全文只有一份定义。
test('the ladder is defined before the external app.js that already calls it', () => {
  for (const locale of ['zh', 'en']) {
    const assets = mobilePageAssets({ locale })
    const urls = { cssUrl: `/app.css?l=${locale}&h=000000000000`, jsUrl: `/app.js?l=${locale}&h=000000000000` }
    const html = renderMobilePage({ locale, assets: urls })

    assert.equal(
      occurrences(html, 'function ladderRun('),
      1,
      `${locale}: the ladder must ship exactly once in the shipped document`
    )
    const defined = html.indexOf('function ladderRun(')
    const external = html.indexOf(`<script src="${urls.jsUrl}"`)
    assert.ok(external > 0, `${locale}: the shipped document must load the app.js asset`)
    assert.ok(
      defined >= 0 && defined < external,
      `${locale}: the ladder definition (at ${defined}) must precede the app.js tag (at ${external}); classic scripts run in document order, so app.js would otherwise call an undefined ladderRun and leave the phone on a dead overlay`
    )

    // 定义在 head 的内联经典脚本里，不是 IIFE 内部，所以顶层 function 就是全局：
    // app.js 与 bootstrap 两边的调用都不需要 window 挂载，也不许再加一份副本。
    assert.equal(
      occurrences(html, 'window.ladderRun='),
      0,
      `${locale}: the ladder is a head-level function, so no window export may carry a second copy`
    )
    // 被证明的是「调用方在外链资产里」这件事本身，否则上面那条顺序断言会空转。
    assert.ok(
      assets.js.includes('ladderRun({'),
      `${locale}: the app.js asset is the caller this ordering protects, and it calls the ladder at top level`
    )
    assert.equal(
      occurrences(assets.js, 'function ladderRun('),
      0,
      `${locale}: the asset must not redefine the ladder; one definition, in the document head`
    )
  }
})
