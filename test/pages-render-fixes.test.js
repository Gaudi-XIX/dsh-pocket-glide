// R3 audit batch (change 2026-10-07-fix-pocket-r3-audit-batch) — character-layer
// invariants for the rendering/copy fixes T1-T6. House pattern: the page script
// lives inside one template literal, so every assertion reads the REAL rendered
// asset (mobilePageAssets / renderMobileReconnectPage / renderDesktopPairingPage)
// and, where behaviour matters, splices the real function out and runs it against
// synthetic state (error-visibility.test.js precedent).
//
// Red-first discipline: the CSS/copy assertions below were written against the
// BASELINE tree (d51a8c1) and ran red there; each green flip corresponds to one
// fix landing. Geometry layer (the part a string can never prove) lives in
// test/dom/pages-geometry.mjs — gated, real browser, 390x844.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preFixBaseline } from './helpers/pre-fix-baseline.mjs'
import {
  mobilePageAssets,
  renderMobileReconnectPage,
  renderDesktopPairingPage,
} from '../lib/pages.js'

const { css, js } = mobilePageAssets({ locale: 'zh' })
const { css: cssEn, js: jsEn } = mobilePageAssets({ locale: 'en' })

function pageLabels(source) {
  const line = source.match(/^const L=(\{.*\});/m)
  assert(line, 'the page label table must render as one JSON line')
  return JSON.parse(line[1])
}
const L = pageLabels(js)
const LEN = pageLabels(jsEn)

// CSS rule reader: `#chatError{...}` -> the declarations body, asserted missing
// when absent (red baseline). Only first occurrence is needed; every selector
// this file reads is unique in the stylesheet.
function cssRule(source, selector) {
  const start = source.indexOf(selector + '{')
  if (start === -1) return null
  const open = source.indexOf('{', start)
  const close = source.indexOf('}', open)
  return source.slice(open + 1, close)
}

// CSS specificity comparator (classes, elements) — encoded explicitly so the
// T2 ordering claim never depends on a browser to be true.
function specificity(selector) {
  const classes = (selector.match(/\.[A-Za-z0-9_-]+/g) || []).length
  const elements = (selector.match(/(^|[\s>+~])([a-z][a-z0-9]*)(?=$|[\s>+~:,])/g) || []).length
  return { classes, elements }
}
function strictlyHigher(a, b) {
  return a.classes > b.classes || (a.classes === b.classes && a.elements > b.elements)
}

// Brace-matching function extractor (error-visibility house pattern). Keeps an
// `async` prefix when present — a stripped prefix turns every await inside into
// a SyntaxError instead of a behaviour assertion.
function extractFunction(source, name) {
  let start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the source`)
  if (source.slice(start - 6, start) === 'async ') start -= 6
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const char = source[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${name}`)
}

function betweenA3(start, end, source) {
  const a = source.indexOf(start)
  assert.notEqual(a, -1, `${start} must exist`)
  const b = source.indexOf(end, a + start.length)
  assert.notEqual(b, -1, `${end} must follow ${start}`)
  return source.slice(a, b)
}

// --------------------------------------------------------------- T1 chatError

test('T1 the #chatError rule lookup cannot be satisfied by prose', () => {
  // cssRule() finds the first '#chatError{' substring, so a stylesheet comment that spells
  // the selector would let this whole block assert against a comment instead of the rule.
  // Found the hard way while adding the dismiss rules; this makes the lookup honest.
  // A comment may still *name* the element — only the `{` next to it is the trap.
  const at = css.indexOf('#chatError{')
  assert.notEqual(at, -1, 'the #chatError rule must exist')
  const openedAt = css.lastIndexOf('/*', at)
  const closedAt = css.lastIndexOf('*/', at)
  assert.ok(openedAt === -1 || closedAt > openedAt, `the first #chatError rule must not sit inside a block comment (at ${at})`)
  assert.match(cssRule(css, '#chatError'), /position:fixed/, 'and the lookup must reach the real declarations')
})

test('T1 the chat error banner is a positioned card, not a bottom-of-flex orphan', () => {
  const rule = cssRule(css, '#chatError')
  assert.ok(rule, 'a #chatError id rule must exist in the stylesheet (red at baseline)')
  assert.match(rule, /position:fixed/, 'the banner must leave the flex flow')
  assert.match(rule, /z-index:/, 'the banner must declare its stacking level')
  // The composer lets the message area pass via this exact var stack; the banner
  // reuses it as its bottom anchor so the two never share a band. --todo-h joined
  // the stack in 2026-10-07-fix-pocket-r2-pages-batch (W2): the todo dock is a
  // composer sibling, so the banner must clear it too. --composer-h replaced the
  // hardcoded 84px in 2026-10-07-fix-pocket-banner-dismiss-and-ttl: the band is
  // measured (syncComposerHeight), so a textarea grown to its 150px ceiling no
  // longer leaves the banner pinned over the input.
  assert.match(rule, /calc\(var\(--composer-h\) \+ var\(--todo-h\) \+ var\(--queue-h\) \+ var\(--tunnel-warn-h\)\)/,
    'the bottom anchor must reuse the composer clearance stack (measured band, todo dock included)')
  // Readable card, not bare danger text floating over content.
  assert.match(rule, /background:/, 'the banner must carry a readable backdrop')
})

test('T1 (r2-W2) the banner stack and the standalone base tier share one --todo-h formula', () => {
  const chatError = cssRule(css, '#chatError')
  const mediaAt = css.indexOf('@media(display-mode:standalone){')
  assert.notEqual(mediaAt, -1, 'the standalone media block must exist')
  const standaloneRule = cssRule(css.slice(mediaAt), '.chat-open .messages')
  assert.ok(standaloneRule, 'the standalone base tier must exist')
  const bottom = (chatError.match(/bottom:(calc\([^;]*\));/) || [])[1]
  const padding = (standaloneRule.match(/padding-bottom:(calc\([^;]*\))/) || [])[1]
  assert.ok(bottom && padding, 'both rules carry a calc() clearance anchor')
  assert.equal(bottom, padding, 'the banner formula must stay identical to the standalone base tier it came from (anti-fork)')
  assert.match(bottom, /var\(--todo-h\)/, 'both carry the todo dock clearance')
  assert.match(bottom, /var\(--composer-h\)/, 'both carry the measured composer band')
  // negative guard: the hardcoded band must never come back in any tier
  assert.doesNotMatch(css, /calc\(84px \+ env\(safe-area-inset-bottom\)/,
    'the hardcoded composer band must stay swept from the sheet')
  assert.doesNotMatch(css, /calc\(84px \+ var\(--todo-h\)/, 'nor the hardcoded band without env()')
})

test('T1 the shared .error class is untouched (listError keeps document flow)', () => {
  assert.ok(css.includes('.error{color:var(--danger);font-size:13px;margin:8px 0}'),
    'the .error rule must stay byte-identical (D1: only the id selector moves)')
})

test('T1 showError/clearTransientError chatError call sites unchanged (zero JS drift)', () => {
  const shown = (js.match(/showError\('chatError'/g) || []).length
  const cleared = (js.match(/clearTransientError\('chatError'/g) || []).length
  // 12 baseline + ensureSession()'s create-failure report (2026-10-12 draft new-chat):
  // a "+" draft whose session cannot be minted must say so on the chat error line —
  // the list banner it used to hit is no longer where the tap happens. Not drift.
  // 2026-10-16 (首次发送延迟): send() reports two more failures on the same line.
  // The create window closed BEFORE the first await, so the pre-flight checks that
  // used to return silently — an attachment still uploading, an image whose draft
  // never finished — now have to speak, or the tap looks swallowed; and the create
  // itself unwinds through send()'s own catch instead of ensureSession()'s.
  // 2026-10-21 earlier-parts: fetchEarlierPage reports a failed bot.earlier call
  // on the same chat error line — an additive call site, not drift.
  assert.equal(shown, 24, 'showError chatError call count: 21 + the two new send() failure reports (2026-10-16: the pre-flight rejection and the materialize-and-send rollback) + 1 earlier-parts fetch failure (2026-10-21)')
  // 3 baseline sites + the banner dismiss (2026-10-07-fix-pocket-banner-dismiss-and-ttl):
  // the tap-the-right-end exit must leave through the same guard as the frame exit, so it
  // is a fourth call site by construction, not a drift.
  assert.equal(cleared, 4, 'clearTransientError chatError call count: 3 baseline + 1 dismiss')
})

// ------------------------------------------------------- T2 queue-edit-box

test('T2 the queue edit box outranks .composer textarea by specificity', () => {
  const rule = cssRule(css, '.composer .queue-edit-box')
  assert.ok(rule, 'the edit box rule must be scoped under .composer (red at baseline)')
  assert.match(rule, /min-height:64px/)
  assert.match(rule, /font-size:13px/)
  assert.match(rule, /border:1px solid var\(--line\)/)
  assert.match(rule, /resize:vertical/, 'vertical resize must be back in effect')
  // No orphan (0,1,0) rule may survive alongside the scoped one.
  assert.doesNotMatch(css, /(^|[;}])\.queue-edit-box\{/,
    'the unscoped .queue-edit-box rule must be gone, not duplicated')
  assert.ok(
    strictlyHigher(specificity('.composer .queue-edit-box'), specificity('.composer textarea')),
    `(0,2,0) must strictly beat (0,1,1), got ${JSON.stringify(specificity('.composer .queue-edit-box'))} vs ${JSON.stringify(specificity('.composer textarea'))}`,
  )
})

test('T2 the main prompt textarea styling has zero drift', () => {
  const rule = cssRule(css, '.composer textarea')
  assert.ok(rule)
  assert.match(rule, /min-height:44px/)
  assert.match(rule, /font-size:16px/)
  assert.match(rule, /background:transparent/)
  assert.match(rule, /resize:none/)
  // markup lock rides along (goal-queue-dock.test.js owns the deeper one).
  assert.match(js, /<textarea class="queue-edit-box" data-queue-edit-text>/)
})

// ---------------------------------------------------------- T3 queue-list

test('T3 queue rows shrink below their content instead of stretching the list', () => {
  const rule = cssRule(css, '.queue-item')
  assert.ok(rule)
  assert.match(rule, /min-width:0/, 'grid items need min-width:0 or long text widens the grid (red at baseline)')
  // regression anchors: the ellipsis and the cap stay in place
  const text = cssRule(css, '.queue-text')
  assert.ok(text && /text-overflow:ellipsis/.test(text), '.queue-text keeps its ellipsis')
  const list = cssRule(css, '.queue-list')
  assert.ok(list && /max-height:180px/.test(list), '.queue-list keeps its cap')
})

// ------------------------------------------------- T4 plus panel + question copy

test('T4 the plus-panel back buttons say back, not the section they leave', () => {
  const lzh = L
  const len = LEN
  assert.equal(lzh.plusBack, '返回')
  assert.equal(len.plusBack, 'Back')
  // three markup sites (file view 1 + permission view 2) plus one selector in
  // the plusBody click handler — four occurrences of the attribute in total
  const sites = (js.match(/data-plus-back/g) || []).length
  assert.equal(sites, 4, 'the back wiring must stay at its 3 markup sites + 1 handler selector')
  assert.equal((js.match(/\+PLUS_BACK_SVG\+'<span>'\+esc\(L\.plusBack\)/g) || []).length, 3,
    'every back button carries the chevron and the back label')
  assert.doesNotMatch(js, /esc\(L\.plusSectionAdd\)<\/button>/, 'the file back button must not masquerade as 「添加」')
  assert.doesNotMatch(js, /esc\(L\.plusSectionCommands\)<\/button>/, 'the permission back buttons must not masquerade as 「指令」')
  // the section titles themselves stay (renderPlusRoot still heads both groups)
  assert.ok(js.includes('L.plusSectionAdd'), 'section titles stay in the root view')
  assert.ok(js.includes('L.plusSectionCommands'), 'section titles stay in the root view')
})

test('T4 fallback permission presets speak human, danger is marked, ids are not names', () => {
  for (const id of ['read-only', 'workspace-write', 'danger-full-access']) {
    assert.doesNotMatch(js, new RegExp(`name:'${id}'`), `${id} must not be the display name (zh)`)
    assert.doesNotMatch(jsEn, new RegExp(`name:'${id}'`), `${id} must not be the display name (en)`)
    assert.doesNotMatch(js, new RegExp(`name:${id}`), `${id} bare must not be the display name either`)
  }
  assert.ok(js.includes('只读（推荐起步）'), 'zh fallback names the first preset in plain words')
  assert.ok(js.includes('完全放开'), 'zh fallback names the danger preset in plain words')
  assert.ok(jsEn.includes('Read-only'), 'en fallback names its presets too')
  // the value slot is the id's only legitimate home
  assert.ok(js.includes("value:'danger-full-access'"), 'the preset id survives as the command payload')
  assert.match(js, /danger:true/, 'the danger preset carries its marker')
  assert.ok(css.includes('.plus-row-danger'), 'the danger marker has a rendered colour')
  assert.ok(js.includes('plus-row-danger'), 'rowHtml renders the danger marker')
  // catalog success path: the name/desc pass-through is untouched
  assert.ok(js.includes('title:o.name||o.value'), 'catalog names still win when present')
})

// ---------------------------------- r2 batch: NF-1 + C5 (2026-10-07-fix-pocket-r2-pages-batch)

test('NF-1 (r2) the fallback permission presets still describe themselves when rpc is down', () => {
  // Behavioural splice (error-visibility house pattern): the real
  // renderPlusPermission runs against a dead rpc so the fallback options render.
  // NF-1 was the fallback array speaking `desc:` while the rowHtml contract reads
  // `o.description` — every description came out empty on the failure path.
  const rowHtml = extractFunction(js, 'rowHtml')
  const currentRead = extractFunction(js, 'permissionCurrent')
  const sheet = extractFunction(js, 'renderPermissionSheet')
  const render = extractFunction(js, 'renderPlusPermission')
  const host = { innerHTML: '' }
  const src = `
    let plusView = 'permission'
    let streamProjections = null, sessionSummaries = [], activeSession = 's1'
    // 2026-10-15: permissionCurrent() reads the draft buffer first, and the sheet now
    // trims the dangerous preset out of a draft (no session). This splice is the
    // in-chat path, so the buffer stays null and all four options render.
    let draftPending = null
    // 2026-10-16: both stay empty while rpc is down — permissionCurrent() then falls
    // through to the host default, which is exactly the unreadable case under test.
    let permissionDefault = ''
    let permissionOptions = []
    const L = ${JSON.stringify({ plusBack: '返回', plusPermission: '权限', plusPermissionLoading: '正在读取权限预设…', plusRowCurrent: '使用中', plusCurrentPermission: '查看当前权限' })}
    const PLUS_ICONS = { permission: '<svg></svg>' }
    const PLUS_BACK_SVG = '<svg></svg>'
    const esc = (v) => String(v == null ? '' : v)
    const $ = () => host
    const plusSetSearch = () => {}
    const rpc = async () => { throw new Error('rpc down') }
    ${rowHtml}
    ${currentRead}
    ${sheet}
    ${render}
    return renderPlusPermission().then(() => host.innerHTML)
  `
  return new Function('host', src)(host).then((html) => {
    for (const desc of ['适合先看看 AI 的动作', 'AI 可以改工作区里的文件', '不再询问，直接执行']) {
      assert.ok(html.includes(desc), `the zh fallback description reaches the sheet: ${desc}`)
    }
    assert.equal((html.match(/class="plus-row-desc"/g) || []).length, 4,
      'three fallback rows + the current-permission row render a desc slot')
    // negative guard: no desc slot is empty any more — the current-permission row
    // used to ship `desc:''` and now reports the active preset, so an unreadable
    // sheet cannot look blank (2026-10-14).
    assert.equal((html.match(/<span class="plus-row-desc"><\/span>/g) || []).length, 0,
      'no row ships an empty description — the current-permission slot always speaks')
    // 2026-10-16: the dash is gone from that slot. With rpc down there is no host
    // default either, so the row says it is still loading — the honest state. A dash
    // read as "you have no permission preset", which is what the live report saw.
    assert.equal((html.match(/—/g) || []).length, 0,
      'the current-permission row no longer renders a bare em dash')
    assert.ok(html.includes('<span class="plus-row-desc">' + '正在读取权限预设…' + '</span>'),
      'with nothing readable the current-permission row says it is still loading')
  })
})

test('NF-1b (2026-10-16) the permission sheet falls back to the HOST default, not a dash', () => {
  // The live report: 「模式和权限…显示的都是个横杠…点开权限后，没有任何高亮」.
  // Root cause: permissionPresets.catalog also answers defaultPreset, and the sheet
  // dropped it — so a session whose permission projection had not landed yet had no
  // current value at all, and no row could match. permissionCurrent() now ends at the
  // host default, which is the truth for "nothing pinned yet".
  const currentRead = extractFunction(js, 'permissionCurrent')
  const src = `
    let streamProjections = null, sessionSummaries = [], activeSession = 's1'
    let draftPending = null
    let permissionDefault = 'workspace-write'
    ${currentRead}
    return permissionCurrent()
  `
  assert.equal(new Function(src)(), 'workspace-write',
    'with no projection anywhere the host defaultPreset is what the sheet reports')

  // and the catalog call must actually keep it
  const render = extractFunction(js, 'renderPlusPermission')
  assert.match(render, /permissionDefault\s*=\s*typeof value\?\.defaultPreset==='string'\?value\.defaultPreset:''/,
    'renderPlusPermission stores defaultPreset from the catalog answer')

  // the loading/dash contract is shared with NF-1 above: renderPermissionSheet must
  // speak when current is empty rather than paint '—'
  const sheet = extractFunction(js, 'renderPermissionSheet')
  assert.doesNotMatch(sheet, /current\|\|'—'/,
    'renderPermissionSheet never ships the bare dash for the current row')
})

test('C5 (r2) the L table carries no dead unit/effort keys', () => {
  for (const key of ['runningUnit', 'awaitingUnit', 'defaultEffort']) {
    assert.ok(!(key in L), `${key} is gone from the zh table`)
    assert.ok(!(key in LEN), `${key} is gone from the en table`)
    assert.doesNotMatch(js, new RegExp(`L\\.${key}\\b`), `no consumer references L.${key}`)
  }
  // the model-catalog data field with the same name is a different organ and stays
  assert.match(js, /reasoning\??\.defaultEffort/, 'the model catalog reasoning.defaultEffort stays untouched')
})

test('T4 presetLocked speaks Chinese, the sister sentence is untouched', () => {
  assert.equal(L.presetLocked, '发送首条消息后，预设将锁定。')
  assert.equal(LEN.presetLocked, 'Preset is locked after the first message.', 'en stays as shipped')
  assert.equal(L.presetEditable, '仅可在发送第一条消息前更改。', 'sister anchor zero diff (zh)')
  assert.equal(LEN.presetEditable, 'Can be changed before the first message only.', 'sister anchor zero diff (en)')
  assert.ok(!css.includes('Preset 已锁定') && !js.includes('Preset 已锁定'),
    'the old zh wording must be swept from the page')
})

test('T4 multi-select questions ask their own question', () => {
  assert.equal(L.chooseAnswer, '请选择一个选项、输入回答，或跳过。', 'single-select copy zero drift')
  assert.equal(L.chooseAnswerMulti, '可选择多个选项、输入回答，或跳过。')
  assert.equal(LEN.chooseAnswerMulti, 'You can select multiple options, enter an answer, or skip.')
  assert.equal((js.match(/question\.multiSelect\?L\.chooseAnswerMulti:L\.chooseAnswer/g) || []).length, 1,
    'exactly one branch picks the copy by multiSelect')
  assert.equal((js.match(/请选择一个选项/g) || []).length, 1, 'the old copy survives only inside the single-select branch')
})

test('T4 the L table stays locale-balanced', () => {
  assert.equal(Object.keys(L).length, Object.keys(LEN).length,
    'zh and en must ship the same key set')
  for (const key of Object.keys(L)) {
    assert.ok(key in LEN, `en is missing key ${key}`)
  }
})

// ------------------------------------------------- T5 tunnel exit + 413 mapping

test('T5 a tunnel failure offers the way back, a lan failure keeps its retry button', () => {
  const tunnelHtml = renderMobileReconnectPage('zh', 'tunnel', {})
  const lanHtml = renderMobileReconnectPage('zh', 'lan', {})
  assert.match(tunnelHtml, /const TUNNEL=true/, 'the tunnel page tells its script the mode')
  assert.match(lanHtml, /const TUNNEL=false/, 'the lan page tells its script the mode too')
  assert.match(tunnelHtml, /回电脑旁重新扫码/, 'zh tunnel exit copy ships')
  assert.match(renderMobileReconnectPage('en', 'tunnel', {}), /Rescan at the computer/, 'en tunnel exit copy ships')
  // The copy itself legitimately rides the shared T table on both modes; the
  // lan exclusion (no link rendered) is asserted behaviourally in the next test.
  // :1388 showRetry is a server-side expression — its rendered contract is the
  // retry button's presence: lan gets one, tunnel never does.
  assert.doesNotMatch(tunnelHtml, /id="retryBtn"/, 'tunnel mode ships no retry button')
  assert.match(lanHtml, /id="retryBtn"/, 'lan mode keeps its retry button')
})

test('T5b a first-time phone is not told its connection was lost', () => {
  const fresh = renderMobileReconnectPage('zh', 'tunnel', { fresh: true })
  const returning = renderMobileReconnectPage('zh', 'tunnel', {})
  assert.match(fresh, /<h1 id="heading">连接 Pocket<\/h1>/, 'the landing page of a never-paired phone names the action')
  assert.doesNotMatch(fresh, /连接已断开/, 'no false alarm on the very first visit')
  assert.match(returning, /<h1 id="heading">连接已断开<\/h1>/, 'a phone that did lose its session still gets the loss wording')
})

test('T5 fail() paints the /disconnected exit only in tunnel mode', () => {
  const tunnelHtml = renderMobileReconnectPage('zh', 'tunnel', {})
  const lanHtml = renderMobileReconnectPage('zh', 'lan', {})
  const runFail = (html, tunnel) => {
    const src = `
      let created = null
      const els = { status: { textContent: '', hidden: true, after(el) { created = el } }, retryBtn: ${tunnel} ? null : { hidden: true } }
      const T = { tunnelExit: '回电脑旁重新扫码' }
      const TUNNEL = ${tunnel}
      const $ = (id) => els[id]
      const document = { createElement() { return { id: '', href: '', textContent: '', style: { cssText: '' } } } }
      ${extractFunction(html, 'fail')}
      fail('boom')
      return { status: els.status, btn: els.retryBtn, created }
    `
    return new Function(src)()
  }
  const tunnelRun = runFail(tunnelHtml, true)
  assert.equal(tunnelRun.created.href, '/disconnected', 'tunnel fail renders the exit link')
  assert.equal(tunnelRun.created.textContent, '回电脑旁重新扫码')
  assert.equal(tunnelRun.created.id, 'tunnelExit')
  assert.equal(tunnelRun.status.textContent, 'boom', 'the red status line stays')
  assert.equal(tunnelRun.btn, null, 'tunnel has no retry button to show')
  const lanRun = runFail(lanHtml, false)
  assert.equal(lanRun.created, null, 'lan fail must not render the exit link')
  assert.equal(lanRun.btn.hidden, false, 'lan fail still reveals the retry button')
})

test('T5 too-large failures map through one helper, and the copy says what to do next', () => {
  assert.equal((js.match(/\/too large\/i/g) || []).length, 1,
    'the too-large regex must be defined exactly once (inside the helper)')
  const attachFailureCopy = new Function(`${extractFunction(js, 'attachFailureCopy')};const L=${JSON.stringify(L)};return attachFailureCopy`)()
  // behavioural: the bridge 413 sentence lands on the zh copy, not the english raw
  assert.equal(attachFailureCopy({ message: 'Request body is too large.' }), L.attachTooLarge)
  assert.equal(attachFailureCopy({ message: 'boom' }), 'boom', 'other failures keep their own words')
  assert.equal(attachFailureCopy(), L.failed, 'nothing at all falls back to the generic copy')
  // consumers: both draft catches, and send() keeping its disconnected semantics
  assert.equal((js.match(/draft\.error=attachFailureCopy\(e\)/g) || []).length, 2,
    'uploadGenericFile and retryDraft catches both consume the helper')
  assert.match(js, /const copy=attachFailureCopy\(e\);if\(copy===L\.attachTooLarge\)e=new Error\(copy\)/,
    'send() maps through the helper without dropping e.disconnected')
  assert.match(L.attachTooLarge, /请换用更小的文件后重试/, 'zh copy carries the next step')
  assert.match(LEN.attachTooLarge, /smaller file/, 'en copy carries the next step')
  assert.doesNotMatch(L.attachTooLarge, /\d+\s*MB/, 'no hardcoded server limit in the copy')
  assert.doesNotMatch(LEN.attachTooLarge, /\d+\s*MB/)
})

// --------------------------------------------------------- T6 ML1/ML2/ML3/M-1

test('T6 the QR countdown speaks minutes past 90s and never says 秒后刷新', () => {
  const zhHtml = renderDesktopPairingPage({ locale: 'zh', pairingUrl: 'http://x', qrSvg: '' })
  const enHtml = renderDesktopPairingPage({ locale: 'en', pairingUrl: 'http://x', qrSvg: '' })
  assert.match(zhHtml, /约 \{n\} 分钟后失效/)
  assert.match(zhHtml, /\{n\} 秒后失效/)
  assert.match(enHtml, /Expires in about \{n\} min/)
  assert.doesNotMatch(zhHtml, /秒后刷新/, 'the old seconds wording must be swept')
  assert.doesNotMatch(enHtml, /refreshes in/, 'the old en wording must be swept')
  assert.doesNotMatch(zhHtml, /T\.refresh/, 'the old key must be gone')
  assert.doesNotMatch(zhHtml, /T\.seconds/, 'the old key must be gone')

  // behavioural: drive the real 1s tick against a sandbox (the body is spliced
  // out of the real page so a rename cannot hollow this assertion)
  const tick = (html, secondsLeft, T, pairingUrl) => {
    const start = html.indexOf('setInterval(()=>{if(document.hidden)return')
    assert.notEqual(start, -1)
    const bodyStart = html.indexOf('{', start)
    let depth = 0
    let end = -1
    for (let i = bodyStart; i < html.length; i++) {
      if (html[i] === '{') depth++
      else if (html[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    const body = html.slice(bodyStart + 1, end)
    const sandbox = {
      texts: [],
      reloaded: 0,
      els: { qrRefreshBtn: { disabled: false } },
      T,
      pairingUrl,
      phoneConnected: false,
      modeSwitching: false,
      pendingPairings: [],
      renderPinHint() {},
      document: { hidden: false },
      reload() { this.reloaded += 1 },
    }
    const fn = new Function('sandbox', 'end', `
      const T = sandbox.T, pairingUrl = sandbox.pairingUrl, phoneConnected = sandbox.phoneConnected,
        modeSwitching = sandbox.modeSwitching, pendingPairings = sandbox.pendingPairings,
        renderPinHint = () => sandbox.renderPinHint(),
        location = { reload: () => sandbox.reload() }
      // the tick body declares its own expiresText/refreshBtn from getElementById
      const store = {}
      const document = { hidden: false, getElementById(id) {
        if (!store[id]) store[id] = { disabled: false, set textContent(v) { sandbox.texts.push(String(v)) }, get textContent() { return '' } }
        return store[id]
      } }
      ${body}
    `)
    fn(sandbox, Date.now() + secondsLeft * 1000)
    return sandbox
  }
  const zhT = { expired: '二维码已过期，正在自动刷新…', expiresMinutes: '约 {n} 分钟后失效', expiresSeconds: '{n} 秒后失效' }
  const minuteRun = tick(zhHtml, 95, zhT, 'http://x')
  assert.match(minuteRun.texts.join(''), /约 \d+ 分钟后失效/, '95s reads as minutes')
  assert.match(minuteRun.texts.join(''), /约 2 分钟后失效/, '95s ceils to 2 minutes')
  assert.doesNotMatch(minuteRun.texts.join(''), /\d{3,}\s*秒后/, 'no three-digit seconds anywhere')
  const secondRun = tick(zhHtml, 45, zhT, 'http://x')
  assert.match(secondRun.texts.join(''), /45 秒后失效/, '45s keeps seconds but says expiry')
  assert.doesNotMatch(secondRun.texts.join(''), /刷新/, 'no refresh wording at second level either')
  const enRun = tick(enHtml, 95, { expired: 'x', expiresMinutes: 'Expires in about {n} min', expiresSeconds: 'Expires in {n}s' }, 'http://x')
  assert.match(enRun.texts.join(''), /Expires in about 2 min/, 'en minutes copy renders')
})

test('T6 the armed revoke states its consequence in the row, not only in title', () => {
  const html = renderDesktopPairingPage({
    locale: 'zh',
    pairingUrl: 'http://127.0.0.1/pair?token=x',
    qrSvg: '',
  })
  // behavioural: arm the real handler against a fake row
  const src = `
    const created = []
    const T = { revoke: '吊销', revokeArmed: '确认吊销', revokeConfirm: '吊销后该手机需重新配对。确认吊销？' }
    const document = { createElement() { return { className: '', dataset: {}, textContent: '', remove() { this.removed = true } } } }
    const parent = { children: [], querySelector(sel) { return this.children.find((n) => sel === '[data-revoke-note]' && n.dataset.revokeNote) || null } }
    const button = {
      dataset: {}, classList: { add() {}, remove() {} }, textContent: '吊销', title: T.revokeConfirm,
      parentElement: parent,
      after(el) {
        el.dataset.revokeNote = '1'
        el.remove = () => { const at = parent.children.indexOf(el); if (at >= 0) parent.children.splice(at, 1) }
        parent.children.push(el)
      },
    }
    ${extractFunction(html, 'disarmRevoke')}
    ${extractFunction(html, 'revokeDevice')}
    return (async () => {
      await revokeDevice(button)
      const state = { text: button.textContent, title: button.title, note: parent.children[0] || null }
      disarmRevoke(button)
      return { state, afterText: button.textContent, afterTitle: button.title, noteRemoved: !parent.children.length }
    })()
  `
  return new Function(src)().then((result) => {
    assert.equal(result.state.text, '确认吊销', 'the armed label is untouched (connected-devices lock)')
    assert.ok(result.state.note, 'arming inserts an inline note')
    assert.equal(result.state.note.className, 'pin-hint', 'the note rides the pin-hint family style')
    assert.equal(result.state.note.textContent, '吊销后该手机需重新配对。确认吊销？', 'the note carries the confirm copy outside title')
    assert.equal(result.state.title, '吊销后该手机需重新配对。确认吊销？', 'the title attribute stays (dual channel)')
    assert.equal(result.afterText, '吊销', 'disarm restores the label')
    assert.equal(result.noteRemoved, true, 'disarm removes the inline note')
  })
})

test('T6 the permission row description speaks plain language', () => {
  assert.equal(L.plusPermissionDesc, '控制 AI 能自己做多少事：只读 / 工作区可写 / 完全放开')
  assert.equal(LEN.plusPermissionDesc, 'Control how much the AI can do on its own: read-only / workspace-write / full access')
  assert.ok(!js.includes('沙箱模式与审批策略'), 'the old sandbox jargon must be swept (zh)')
  assert.ok(!jsEn.includes('sandbox & approval'), 'the old jargon must be swept (en)')
})

test('T6 the named-tunnel panel hints where ingress must point', () => {
  const zhHtml = renderDesktopPairingPage({ locale: 'zh', pairingUrl: 'http://x', qrSvg: '' })
  const enHtml = renderDesktopPairingPage({ locale: 'en', pairingUrl: 'http://x', qrSvg: '' })
  // 2026-10-12: the tunnel panel was lifted out of #deviceExtras (nested there, its
  // .show asked for the tunnel view while its parent only ever opened in the devices
  // view, so it was unreachable in every state). It is now a top-level block, and
  // #deviceExtras is the next sibling — slice on that instead of on <script>, or the
  // slice would swallow the notify/diag panels and grade the wrong block.
  const panelStart = zhHtml.indexOf('<div id="tunnelConfigPanel"')
  const panelEnd = zhHtml.indexOf('<div id="deviceExtras"', panelStart)
  assert.notEqual(panelStart, -1)
  assert.notEqual(panelEnd, -1)
  const panel = zhHtml.slice(panelStart, panelEnd)
  const hostAt = panel.indexOf('id="tunnelHostname"')
  const saveAt = panel.indexOf('data-action="tunnel-config-save"')
  assert.notEqual(hostAt, -1)
  // The hint ships the Cloudflare console as a real link (2026-10-10): the
  // operator should click through, not copy a URL out of a sentence. The
  // bridge port stays a placeholder because it is only known at runtime.
  const hintAt = panel.indexOf('one.dash.cloudflare.com')
  assert.notEqual(hintAt, -1, 'the zh hint links into the Cloudflare console')
  assert.ok(hintAt > hostAt, 'the hint sits after the hostname input')
  assert.ok(hintAt < saveAt, 'and before the save actions')
  assert.match(panel, /<a href="https:\/\/one\.dash\.cloudflare\.com\/"[^>]*>Cloudflare Zero Trust<\/a>/, 'the link is an anchor, not escaped text')
  assert.match(panel, /127\.0\.0\.1/, 'the loopback target is still named')
  const enStart = enHtml.indexOf('<div id="tunnelConfigPanel"')
  const enPanel = enHtml.slice(enStart, enHtml.indexOf('<div id="deviceExtras"', enStart))
  assert.match(enPanel, /<a href="https:\/\/one\.dash\.cloudflare\.com\/"[^>]*>Cloudflare Zero Trust<\/a>/, 'en hint links too')
  assert.doesNotMatch(zhHtml, /127\.0\.0\.1:\d{2,5}</, 'no hardcoded bridge port in the rendered page')
})

// 2026-10-16 用户裁定：「在手机 pocket 推理强度的那一面打个括号，写上"桌面端指定"，
// 然后就不给选择的空间得了」。理由（取证，别把这段当历史账删掉）：宿主 selectionFor()
// 每次 system-prompt/assemble 都用 model/selection 事件重算 picked，而桌面端模型菜单
// 关闭时会提交一次（selectionOf 用本地快照 / 目录 defaultEffort 补值），于是手机上选的
// 档约 2 秒后被盖回去——session-191fcc40 seq=22 15:30:00 medium → seq=23 15:30:02 high，
// qoder 线 session-8226f15b seq=6338→6339 同形。给一个注定被覆盖的按钮比不给更糟。
test('E1 the effort row is a read-only value that names the desktop as its source', () => {
  assert.equal(L.reasoningEffortFixed, '由桌面端指定')
  assert.equal(LEN.reasoningEffortFixed, 'Set by the desktop app')

  // 只读行不带任何可点的东西：没有 setting-pick 按钮、没有 setting-list 容器。
  const row = extractFunction(js, 'settingReadonlyHtml')
  assert.match(row, /class="setting-value"/, 'the value ships in its own span')
  assert.doesNotMatch(row, /data-pick|data-field|setting-list|setting-opt|button/,
    'a read-only row must not ship a button or a picker list')

  // effort 行现在走只读渲染，并且标签带来源说明。
  const render = extractFunction(js, 'renderSessionSettings')
  assert.match(render, /settingReadonlyHtml\(L\.reasoningEffort,L\.reasoningEffortFixed/,
    'the effort row is rendered read-only, labelled with its source')
  assert.doesNotMatch(render, /settingFieldHtml\('effort'/,
    'the effort row must not be a picker any more')

  // 选择器与提交路径整体退场：列表分支、草稿覆盖参数、RPC 里的 effort 全都不在了。
  const pick = extractFunction(js, 'pickRows')
  assert.doesNotMatch(pick, /field==='effort'/, 'pickRows no longer builds an effort list')
  assert.doesNotMatch(pick, /effortValue|effortsOf/, 'and no longer reads the effort value')
  const apply = extractFunction(js, 'applyPick')
  assert.doesNotMatch(apply, /effort/, 'applyPick has no effort arm left')
  const select = extractFunction(js, 'selectModel')
  assert.doesNotMatch(select, /effort/i, 'selectModel never submits a reasoning effort')
  assert.match(select, /rpc\('session\.selectModel',\{sessionId:activeSession,provider,model\}\)/,
    'the model RPC carries provider+model only')
  assert.doesNotMatch(extractFunction(js, 'draftSetModel'), /effort/i,
    'the draft buffer carries no effort either')
  assert.doesNotMatch(js, /effortPick/, 'the effortPick state is gone')
})

test('E2 the read-only effort row still tells the truth about the current value', () => {
  // 值仍照实显示（另一端改了档就显示新档）；解析顺序保持：会话选择 → 目录默认 → 首档。
  const value = extractFunction(js, 'effortValue')
  assert.match(value, /currentSelection\(\)\.reasoningEffort/, 'an explicit selection wins')
  assert.match(value, /reasoning\?\.defaultEffort/, 'the catalogue default is the next tier')
  assert.match(value, /ids\[0\]/, 'the first listed effort is the last resort')
  const label = extractFunction(js, 'effortLabel')
  assert.match(label, /effortsOf\(entry\)\.find\(item=>item\.id===id\)\?\.name/, 'the label is the catalogue name')
  assert.match(label, /fieldText\(/, 'a blank catalogue name falls back to the id')
  // 只读不等于不刷新：流事件仍会重画面板，值跟着走。
  const show = extractFunction(js, 'showSessionModel')
  assert.match(show, /renderSessionSettings\(\)/, 'the live model/selection event still repaints')
})

test('DM-1 dark mode protects night vision: primary/send buttons, cancel, settings and dialogs avoid glaring white', () => {
  // 1. 深色模式媒体查询覆盖，消除夜间纯白发光
  const darkBlockStart = css.indexOf('@media(prefers-color-scheme:dark)')
  assert.ok(darkBlockStart >= 0, 'mobile CSS owns a dark-mode media query')
  const darkContent = css.slice(darkBlockStart)

  // 发送按钮启用时走品牌蓝，禁用时走默认 surface，彻底消除白炽光
  assert.match(darkContent, /\.composer \.primary:not\(:disabled\)\{background:var\(--brand\);border-color:var\(--brand\);color:#fff\}/,
    'dark-mode send button uses brand accent with white arrow, not glaring ink')
  assert.match(darkContent, /\.composer \.primary:disabled\{background:var\(--surface\);border-color:var\(--line\);color:var\(--muted\);box-shadow:none\}/,
    'dark-mode disabled send button avoids white glare with muted surface')
  // 停止生成按钮走暗底危险色
  assert.match(darkContent, /\.primary\.cancel\{background:color-mix\(in srgb,var\(--danger\) 16%,var\(--card\)\)/,
    'dark-mode cancel/stop button uses dark card tinted with danger red')
  // 会话设置展开态避免白球
  assert.match(darkContent, /\.settings-trigger\[aria-expanded=true\]\{border-color:var\(--brand\);background:var\(--hover\);color:var\(--brand\)\}/,
    'dark-mode settings trigger expanded state avoids solid white')
  // 提问弹窗主提交按钮
  assert.match(darkContent, /\.question-actions \.submit-answer\{border-color:var\(--brand\);background:var\(--brand\);color:#fff\}/,
    'dark-mode question submit button uses brand accent')
  // 提问选项选中态
  assert.match(darkContent, /\.question-option\.selected \.option-control\{border-color:var\(--brand\);background:var\(--brand\);color:#fff\}/,
    'dark-mode question option selected control uses brand accent')
  // 浮层提示 toast 走深灰微光
  assert.match(darkContent, /\.toast\{background:#232428;color:var\(--ink\);border:1px solid var\(--line\)/,
    'dark-mode toast uses dark elevated pill instead of stark white capsule')

  // 2. 白天模式基准保持不变，保证白天高对比度与易读性
  assert.ok(css.includes('button.primary{display:flex;align-items:center;justify-content:center;gap:6px;flex:none;min-width:68px;height:44px;border:1px solid var(--ink);border-radius:13px;padding:0 11px 0 13px;background:var(--ink);color:var(--paper);'),
    'daytime light mode retains black button with white text for maximum readability')
  assert.ok(css.includes('.composer .primary,.primary.cancel{width:44px;min-width:44px;border-radius:50%;padding:0;background:var(--ink);border-color:var(--ink)}'),
    'daytime composer send button retains crisp black background')

  // 3. 移动端重连页面在深色模式下同样消除全屏大白块
  const reconnectZh = renderMobileReconnectPage('zh', 'lan')
  assert.ok(
    reconnectZh.includes('.primary,#pinSubmit{background:var(--brand);border-color:var(--brand);color:#fff}'),
    'reconnect page primary and pinSubmit buttons use brand accent under dark mode',
  )
})

test('E3 model and preset selections write through to session row projections immediately', () => {
  // selectModel 成功后就地写入 sessionSummaries 该行 projections.values.modelSelection.next，
  // 杜绝 10s 缓存窗口内 reopen 设置面板时被旧 summary 盖回。
  const select = extractFunction(js, 'selectModel')
  assert.match(select, /sessionRowValues\(activeSession\)/, 'selectModel writes through to row values')
  assert.match(select, /modelSelection\s*=\s*\{.*next:\s*\{/, 'modelSelection.next is updated with the new selection')

  // selectPreset 不再就地回写：行回写只服务 model 选择（本次报障范围），
  // preset 的行更新由桥侧 invalidateSessionList() 负责，页面侧保持既有形状。
  const preset = extractFunction(js, 'selectPreset')
  assert.doesNotMatch(preset, /sessionRowValues/, 'the page no longer writes the preset row; the bridge drops the cache instead')

  // sessionRowValues helper 存在且返回 values 容器
  const helper = extractFunction(js, 'sessionRowValues')
  assert.match(helper, /sessionSummaries\.find/, 'looks up the session in sessionSummaries')
  assert.match(helper, /r\.projections.*p\.values/, 'navigates or builds projections.values')
})

// B2 (user m00788): after a switch the settings panel must not snap back to the
// previous model. The Host answer is pushed into the row the page already holds,
// because session.list is served from the bridge's 10s window and rows are never
// re-read while a chat is open (the page-side poll bails when activeSession is set).
test('B2 a successful model switch writes the selection into the held row', () => {
  const select = extractFunction(js, 'selectModel')
  assert.match(select, /v\.modelSelection=\{?\.\.\.v\.modelSelection,next:\{\.\.\.selected\}\}?/,
    'the Host answer lands on modelSelection.next, the field the page actually reads')
  const rowValues = extractFunction(js, 'sessionRowValues')
  assert.match(rowValues, /sessionSummaries\.unshift\(/, 'a row that is not held yet is created, like markRowRunning does')
  assert.match(rowValues, /r\.projections=\(/, 'the row gets a projections object before its values are written')
  assert.match(rowValues, /return p\.values=/, 'the write targets the row values the projection reader walks')
  assert.doesNotMatch(select, /effort/i, 'the switch still never submits a reasoning effort')
})

// BUG-2 (user m00002 第 2 条「在正在进行的会话里面，更新切换模型好像不行」)：
// 草稿缓冲（draftPending）原本对任何状态都优先：只要缓冲里有 model/preset，运行中会话的
// 设置面板显示的就是草稿里选过的那个（openSessionSettings 还会把它写进 modelCatalog.current），
// 而草稿态点选只进缓冲、当场不发 RPC，却弹与真切换同一条「会话设置已更新」⇒ 看着切了、实际没动。
// 修法：缓冲只在没有活动会话（真正的草稿态）时说话；缓冲命中弹「待生效」文案，不再冒充实况。
test('BUG2 the draft buffer never speaks for a live session and never claims a live update', () => {
  const model = extractFunction(js, 'draftModelSelection')
  assert.match(model, /!activeSession&&draftPending&&draftPending\.model/,
    'the buffered model only wins while no session is active')
  assert.match(extractFunction(js, 'draftAgentPreset'), /!activeSession&&draftPending&&draftPending\.preset/,
    'the buffered preset is draft-scoped too')
  assert.match(extractFunction(js, 'renderSessionSettings'), /!activeSession&&draftPending&&draftPending\.preset/,
    'the preset row falls back to the buffer only in a draft')
  assert.match(extractFunction(js, 'permissionCurrent'), /!activeSession&&draftPending&&draftPending\.permission/,
    'the permission sheet marks the buffered preset as current only in a draft')
  for (const name of ['draftSetModel', 'draftSetPreset', 'draftSetPermission']) {
    const setter = extractFunction(js, name)
    assert.match(setter, /showToast\(L\.settingsPending\)/, `${name} announces a pending pick`)
    assert.doesNotMatch(setter, /showToast\(L\.settingsUpdated\)/, `${name} must not reuse the applied copy`)
  }
  assert.doesNotMatch(extractFunction(js, 'draftSetPreset'), /currentPreset=next/,
    'a draft pick must not overwrite the current-session preset variable')
  assert.ok(L.settingsPending && LEN.settingsPending, 'both locales carry the pending copy')
  assert.notEqual(L.settingsPending, L.settingsUpdated, 'the pending copy is distinct from the applied one')
})

// BUG-3 / BUG-4 (user m01210「乐观加载碰到排队消息时明显有问题」「发送按钮没有把停止按钮顶掉……」)：
// send() 在 RPC 之前就乐观入列，而 agentRunning 时 session.prompt 的 mode 是 busyEnter（"queue"）——
// 这条消息在宿主侧只进 inbox，不是 transcript 事件，却同时被画成会话气泡（messagesWithOptimistic
// 只看文本相似度、完全不看 inbox 投影）⇒ 同一句话在气泡和队列坞各出现一次，看着像已投递。
// 修法：乐观气泡只在真正空闲的发送里画（item.queued 跳过），队列坞本来就是它的呈现位。
// 按钮同源：syncPromptUi 只按 canSend 决定 send 显隐，cancel 只看 agentRunning ⇒ 打字时两个都在，
// 输入框长高把 send 挤到中间/左边、cancel 在右，一滑就误触停止。修法：有待发内容即只显发送。
test('BUG3 a prompt queued behind a running turn is not painted as a transcript bubble', () => {
  const echo = extractFunction(js, 'messagesWithOptimistic')
  assert.match(echo, /if\(item\.queued\)continue;/,
    'the queued echo is not spliced into the transcript')
  const send = betweenA3('async function send()', 'function formatBytes(n)', js)
  assert.match(send, /queued:agentRunning\}/,
    'a send into a running turn records that it went to the inbox, not the transcript')
})

test('BUG4 a typed draft takes the stop button\'s place instead of sitting beside it', () => {
  const ui = extractFunction(js, 'syncPromptUi')
  assert.match(ui, /cancel\.hidden=!agentRunning\|\|canSend/,
    'while there is something to send, the stop button must yield to the send button')
  assert.match(ui, /\$\('send'\)\.hidden=agentRunning&&!canSend/,
    'the send button still only shows when it actually has something to send')
})

// Red-first: these three assertions must hold on the pre-fix baseline page source,
// where the queued echo and the always-on stop button are exactly what the user
// reported. This keeps the two tests below honest — if the guard strings ever
// disappear again, this fails before they can silently pass.
//
// 基线钉在不可变的前置提交上，而不是 HEAD：本批六 bug 修复＝8de3463，其父 f8e1669
// 是「修复落地之前那一次提交」。红先证据必须钉在这一个 sha 上——钉 HEAD 会随
// 每次提交腐烂（修复一落进 HEAD 断言就自相矛盾），钉 HEAD~1 会随新提交漂移。
// The pinned commit lives only in the development repository: the published tree was
// squashed into a fresh root, so this baseline cannot be read there. "Unreadable" is
// not the same as "holds", so the test skips with its reason instead of passing.
test('RED (against f8e1669) the BUG3/BUG4 guards are absent on the committed page source', (t) => {
  const preFix = preFixBaseline('f8e1669', 'lib/pages.js')
  if (preFix === null) {
    t.skip('f8e1669 is not in this history (the published tree was squashed into a fresh root)')
    return
  }
  assert.ok(preFix.includes('cancel.hidden=!agentRunning;'), 'the pre-fix baseline lets the stop button sit beside a typed draft')
  assert.ok(!preFix.includes('queued:agentRunning'), 'the pre-fix baseline cannot tell a queued send from a plain one')
  assert.ok(!preFix.includes('if(item.queued)continue'), 'the pre-fix baseline splices every echo into the transcript')
})

// The two tests above pin the source words; these run the REAL functions out of
// the rendered page against synthetic state, so a refactor that keeps the words
// but breaks the guard fails here. Precedent: test/pages-state-reset.test.js
// buildSendSandbox().
function buildQueueSendSandbox(opts) {
  const body = 'async ' + extractFunction(js, 'send').replace(/^async\s+/, '')
  const echo = extractFunction(js, 'messagesWithOptimistic').replace(/^async\s+/, '')
  const make = new Function('box', `
    let activeSession='s1',agentRunning=${String(opts && opts.agentRunning === true)},busyEnter='queue',sendBusy=false,sessionBlank=false
    let optimisticPrompts=[],lastHistoryKey='',composerDrafts=[]
    const rpcCalls=[],toasts=[],errors=[]
    let flight=null
    async function ensureSession(){return activeSession}
    async function applyDraftPending(){}
    function $(id){return id==='prompt'?box:{value:'',hidden:false,disabled:false,style:{},innerHTML:''}}
    function readyDrafts(){return []}
    function validateImagesReady(){}
    function slashExecuteName(){return ''}
    function attachmentParts(){return []}
    function submittedAttachmentParts(){return []}
    function draftSummary(){return ''}
    function latestEventSeq(){return 5}
    function durableUserPromptText(message){return String((message.blocks&&message.blocks[0]&&message.blocks[0].text)||message.text||'')}
    // 2026-10-20 promptShape 进入退休判据（见 test/pages-optimistic-retirement.test.js），
    // 沙箱必须把它一并注入，否则 echo filter 会在 ReferenceError 上炸，而不是退休。
    ${extractFunction(js, 'promptShape')}
    function armAwaitingTurn(){}
    function clearAwaitingTurn(){}
    function markRowRunning(){}
    function syncSettingsControls(){}
    function syncPromptUi(){}
    function paintMessages(){}
    function clearSentDrafts(){}
    function showError(id,error){errors.push({id,error})}
    function showToast(message){toasts.push(message)}
    function encodedPromptBytes(){return 1}
    function rpcBodyCeilingFor(){return 1024}
    async function loadHistory(){}
    async function refreshActiveSessionSummary(){}
    async function rpc(method,payload){rpcCalls.push({method,payload});await new Promise((resolve)=>{flight=resolve})}
    function currentTranscript(){return []}
    const L={sendFailed:'send failed',draftUploading:'uploading',draftFailed:'failed',attachNotAccepted:'no {command}',attachTooLarge:'too large'}
    ${extractFunction(js, 'attachFailureCopy')}
    ${echo}
    ${body}
    return {run:send,accept:()=>flight(),rpcCalls,toasts,errors,bubbles:()=>messagesWithOptimistic([]).length}
  `)
  return make({ value: 'hello', style: {}, scrollHeight: 40 })
}

test('BUG3 a send into a running turn is queued host-side and never drawn as a bubble', async () => {
  const sandbox = buildQueueSendSandbox({ agentRunning: true })
  sandbox.run().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(sandbox.rpcCalls.length, 1, 'the send still reaches the host')
  assert.equal(sandbox.rpcCalls[0].payload.mode, 'queue', 'a turn that is running takes mode=queue')
  assert.equal(sandbox.bubbles(), 0, 'and the queued text must not appear in the transcript box')
  sandbox.accept()
})

test('BUG3 a send into an idle session still paints its own bubble', async () => {
  const sandbox = buildQueueSendSandbox({ agentRunning: false })
  sandbox.run().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(sandbox.bubbles(), 1, 'the ordinary echo is still drawn while the answer is pending')
  sandbox.accept()
})

// BUG-2 行为沙箱：真跑 selectModel / showSessionModel / renderSessionSettings /
// pickRows，用一份合成 modelCatalog + 合成 streamProjections（故意持有旧模型 deepseek-v3，
// 即修复前「上面」显示的那个陈旧值）。断言走两个真实显示出口：renderSessionSettings 产出的
// 字段按钮文本、pickRows 产出的 is-on 行。
function buildModelSelectionSandbox(opts) {
  const body = 'async ' + extractFunction(js, 'selectModel').replace(/^async\s+/, '')
  const show = extractFunction(js, 'showSessionModel')
  const render = extractFunction(js, 'renderSessionSettings')
  const rows = extractFunction(js, 'pickRows')
  const settingsHost = { innerHTML: '', hidden: false, querySelectorAll: () => [] }
  const make = new Function('box', `
    let activeSession='s1',settingsBusy=${String(!!(opts && opts.settingsBusy))},settingsPick=''
    let sessionSelection=null,sessionSummaries=[],streamProjections={values:{modelSelection:{next:{provider:'deepseek',model:'deepseek-v3'}}}}
    let presets=[],currentPreset=null,draftPending=null
    const catalog={
      groups:[{id:'openrouter',models:[
        {id:'deepseek-v3',name:'DeepSeek V3'},
        {id:'gemini-2.5-pro',name:'Gemini 2.5 Pro',reasoning:{efforts:['low','high'],defaultEffort:'high'}}
      ]}],
      routableProviders:['openrouter'],
      current:{provider:'deepseek',model:'deepseek-v3'},
      default:{provider:'deepseek',model:'deepseek-v3'}
    }
    let modelCatalog=null
    const L={model:'模型',reasoningEffort:'推理强度',reasoningEffortFixed:'固定为',noModels:'当前没有可选模型',settingsLoading:'加载中',settingsUpdated:'会话设置已更新'}
    function $(id){return id==='sessionSettings'?box:{hidden:true,innerHTML:'',querySelectorAll:()=>[],setAttribute(){},dataset:{}}}
    function esc(value){return String(value)}
    function settingsHead(){return ''}
    function showToast(){}
    function showError(){}
    function syncSettingsControls(){}
    function normalizeSelection(value){if(!value||typeof value!=='object')return null;const provider=typeof value.provider==='string'?value.provider:'',model=typeof value.model==='string'?value.model:'';if(!provider||!model)return null;return{provider,model,...(typeof value.reasoningEffort==='string'&&value.reasoningEffort?{reasoningEffort:value.reasoningEffort}:{})}}
    function sameModelSelection(a,b){return !!a&&!!b&&a.provider===b.provider&&a.model===b.model&&(a.reasoningEffort||'')===(b.reasoningEffort||'')}
    function modelSelectionOf(projections){return normalizeSelection(projections&&projections.values&&projections.values.modelSelection&&projections.values.modelSelection.next)}
    function modelEntryOf(provider,model){const group=(modelCatalog&&modelCatalog.groups||[]).find(item=>item.id===provider);const entry=group?group.models.find(item=>item.id===model):null;return{group,model:entry}}
    function effortsOf(entry){return entry&&entry.model&&entry.model.reasoning&&Array.isArray(entry.model.reasoning.efforts)?entry.model.reasoning.efforts:[]}
    function effortLabel(entry){return effortValue(entry)}
    function currentSelection(){return sessionSelection??{}}
    function draftModelSelection(){if(!activeSession&&draftPending&&draftPending.model)return{...draftPending.model};return sessionSelection??modelSelectionOf(streamProjections)}
    function draftAgentPreset(){return null}
    function presetIsLocked(){return false}
    function presetLabel(preset){return preset&&preset.id||''}
    function fieldText(value,fallback){const clean=String(value??'').replace(/\\s+/g,' ').trim();return clean||String(fallback??'')}
    ${extractFunction(js, 'settingFieldHtml')}
    ${extractFunction(js, 'settingReadonlyHtml')}
    ${extractFunction(js, 'effortValue')}
    function sessionRowValues(id){let row=sessionSummaries.find(item=>item.sessionId===id);if(!row){row={sessionId:id,updatedAt:0,blank:false,awaitingQuestion:false,values:{}};sessionSummaries.unshift(row)}return row.values}
    async function rpc(method,payload){if(method==='session.selectModel')return{selected:{provider:payload.provider,model:payload.model}};return{}}
    ${show}
    ${render}
    ${rows}
    ${body}
    return {
      async selectModel(){
        modelCatalog=catalog
        await selectModel(modelEntryOf('openrouter','gemini-2.5-pro'))
        return this
      },
      hostEvent(selection){modelCatalog=catalog;showSessionModel(selection);return this},
      fieldText(){modelCatalog=catalog;renderSessionSettings();const match=box.innerHTML.match(/data-pick="model"[^>]*><span>([^<]*)</);return match?match[1]:''},
      highlightedRow(){modelCatalog=catalog;const html=pickRows('model');const match=html.match(/class="setting-opt is-on" data-value="([^"]*)"/);return match?match[1]:''},
      rowSelection(){const row=sessionSummaries.find(item=>item.sessionId==='s1');return row&&row.values&&row.values.modelSelection?row.values.modelSelection.next:null}
    }
  `)
  return make(settingsHost)
}

// BUG-2 第二条症状（user m00002：「切换的那一瞬间只在下拉栏里显示已切换，不会在上面显示；
// 只有发了消息以后才会」）：「当前模型」原本有两个事实源——下拉列表高亮读
// modelCatalog.current（selectModel 一成功就乐观写入，点完立刻亮），字段按钮文本经
// draftModelSelection() 回落 streamProjections 的宿主投影快照（只在 projections 同步/历史帧
// 刷新）。于是同一面板里两处显示不同值，且要等发消息触发 turn/start → scheduleProjectionsSync
// 才对齐。修法＝单一事实源：页面级 sessionSelection 承载当前选择，宿主投影、model/selection
// 流事件与 selectModel 成功回包都汇到它（showSessionModel 是唯一写入口），所有显示点读同一个
// currentSelection()。下面两条跑真函数：一条钉住写入面（回包必须同时改字段文本与列表高亮），
// 一条钉住事件面（宿主在途事件不得被 settingsBusy 吞掉）。
test('BUG2 a live model switch paints the field text and the list highlight from one source', async () => {
  const sandbox = buildModelSelectionSandbox({ settingsBusy: false })
  await sandbox.selectModel()
  assert.equal(sandbox.fieldText(), 'Gemini 2.5 Pro',
    'the field button names the switched model immediately — no waiting for a send')
  assert.equal(sandbox.highlightedRow(), 'openrouter\u001fgemini-2.5-pro',
    'and the pick list highlights that same row from the same source')
  assert.deepEqual(sandbox.rowSelection(), { provider: 'openrouter', model: 'gemini-2.5-pro' },
    'the session row projection still records the switch for the workspace list')
})

test('BUG2 a host model/selection event lands while a switch is in flight', async () => {
  const sandbox = buildModelSelectionSandbox({ settingsBusy: true })
  sandbox.hostEvent({ provider: 'openrouter', model: 'deepseek-v3.2' })
  assert.equal(sandbox.fieldText(), 'deepseek-v3.2',
    'the authoritative host value is not dropped because a page-initiated switch is still in flight')
})

// The two tests above run the real functions; these pin the words that keep the
// one-source model in place. `settingsBusy` may only gate the submit entry (so a
// double tap cannot fire two RPCs), never the host's authoritative value: that
// gate is what made「点了没反应」与「上面不更新」两个症状同时出现。
test('BUG2 the page holds one current selection, not a catalog shadow copy', () => {
  assert.match(js, /sessionSelection=null,modelCatalog=null/,
    'the current selection lives in its own page state variable')
  assert.match(extractFunction(js, 'showSessionModel'), /sessionSelection=next/,
    'the host event, the settings refresh and the switch echo all write the same variable')
  assert.doesNotMatch(extractFunction(js, 'showSessionModel'), /settingsBusy/,
    'no in-flight page switch may swallow the host authoritative value')
  assert.doesNotMatch(extractFunction(js, 'showSessionModel'), /modelCatalog\.current/,
    'the catalog keeps only directory data; the shadow copy is gone')
  for (const name of ['refreshSessionSettings', 'openSessionSettings', 'selectModel']) {
    assert.doesNotMatch(extractFunction(js, name), /modelCatalog\.current=/,
      `${name} must not keep a second copy of the current selection on the catalog`)
  }
  assert.match(extractFunction(js, 'currentSelection'), /return sessionSelection\?\?{}/,
    'every display point reads the one source')
  assert.match(extractFunction(js, 'closeSessionStream'), /streamProjections=null;sessionSelection=null/,
    'leaving a session drops its selection with the rest of the per-session state')
})
