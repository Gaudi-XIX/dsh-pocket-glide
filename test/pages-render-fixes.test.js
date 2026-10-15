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
  assert.equal(shown, 21, 'showError chatError call count: 17 baseline + the four draft flush reports (2026-10-15: applyDraftPending pushes preset/model/permission onto the session the moment it exists — a refused setting must be visible, not silently dropped)')
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
  const render = extractFunction(js, 'renderPlusPermission')
  const host = { innerHTML: '' }
  const src = `
    let plusView = 'permission'
    let streamProjections = null, sessionSummaries = [], activeSession = 's1'
    // 2026-10-15: permissionCurrent() reads the draft buffer first, and the sheet now
    // trims the dangerous preset out of a draft (no session). This splice is the
    // in-chat path, so the buffer stays null and all four options render.
    let draftPending = null
    const L = ${JSON.stringify({ plusBack: '返回', plusPermission: '权限', plusPermissionLoading: '正在读取权限预设…', plusRowCurrent: '使用中', plusCurrentPermission: '查看当前权限' })}
    const PLUS_ICONS = { permission: '<svg></svg>' }
    const PLUS_BACK_SVG = '<svg></svg>'
    const esc = (v) => String(v == null ? '' : v)
    const $ = () => host
    const plusSetSearch = () => {}
    const rpc = async () => { throw new Error('rpc down') }
    ${rowHtml}
    ${currentRead}
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
    // used to ship `desc:''` and now reports the active preset (or '—' when the
    // host has not answered), so an unreadable sheet cannot look blank (2026-10-14).
    assert.equal((html.match(/<span class="plus-row-desc"><\/span>/g) || []).length, 0,
      'no row ships an empty description — the current-permission slot falls back to the dash')
    assert.ok(html.includes('<span class="plus-row-desc">—</span>'),
      'with nothing to read, the current-permission row renders the dash')
  })
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
