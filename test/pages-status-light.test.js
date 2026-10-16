// WP-1 pages status-light + optimistic-create pins (change
// 2026-10-05-feat-pocket-mobile-ux-batch). Source-level like the other page
// pins: the mobile page script is plain text, so the organs under test are
// spliced into a Function body with stubbed DOM helpers ("page code spliceable
// into a Function body", the mobile-assets / turn-watchdog pattern).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mobilePageAssets,
  reconcileProvisionalSession,
  spliceProvisionalSession,
} from '../lib/pages.js'

function extractFunction(source, name) {
  const head = `function ${name}(`
  const start = source.indexOf(head)
  assert.notEqual(start, -1, `function ${name} must exist in the page`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const char = source[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${name}`)
}

function fakeElement(id) {
  const classes = new Set()
  const attrs = {}
  const element = {
    id,
    textContent: '',
    classes,
    attrs,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => {
        if (force === undefined) force = !classes.has(name)
        if (force) classes.add(name)
        else classes.delete(name)
        return force
      },
      contains: (name) => classes.has(name),
    },
    setAttribute: (name, value) => { attrs[name] = value },
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
  }
  return element
}

// Build a callable applyLiveStatus + setStatusCopy pair over a stub DOM.
function buildStatusOrgans(locale) {
  const js = mobilePageAssets({ locale }).js
  const elements = new Map()
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id))
    return elements.get(id)
  }
  const calls = { hiddenOverlay: 0, settings: undefined, tunnel: 'sentinel', device: undefined }
  const factory = new Function(
    '$',
    'L',
    'lastLiveStatusAt',
    'unreachableStreak',
    'hideUnreachableOverlay',
    'applyInheritedSettings',
    'renderTunnelWarning',
    'renderDeviceExpiry',
    extractFunction(js, 'applyLiveStatus') + '\n' + extractFunction(js, 'setStatusCopy') + '\nreturn { applyLiveStatus, setStatusCopy }'
  )
  const organs = factory(
    $,
    {
      statusConnected: '已连接',
      statusDisconnected: '已断开',
      statusReconnecting: '重连中',
      statusDegraded: '宿主未响应',
    },
    0,
    0,
    () => { calls.hiddenOverlay += 1 },
    (settings) => { calls.settings = settings },
    (expiresAt) => { calls.tunnel = expiresAt },
    (body) => { calls.device = body },
  )
  return { organs, $, elements, calls }
}

test('#1b applyLiveStatus: a hostReachable:true frame paints green, as before', () => {
  const { organs, $ } = buildStatusOrgans('zh')
  organs.applyLiveStatus({ hostReachable: true, settings: { transcriptView: 'compact' } })
  const status = $('status')
  assert.ok(!status.classList.contains('degraded'), 'green means no degraded class')
  assert.ok(!status.classList.contains('error-state'))
  assert.ok(!status.classList.contains('connecting'))
  assert.equal($('statusText').textContent, '已连接')
  assert.equal(status.getAttribute('aria-label'), '已连接')
})

test('#1b applyLiveStatus: a hostReachable:false frame paints yellow (degraded)', () => {
  const { organs, $ } = buildStatusOrgans('zh')
  organs.applyLiveStatus({ hostReachable: false })
  const status = $('status')
  assert.ok(status.classList.contains('degraded'), 'the degraded class must be set')
  assert.ok(!status.classList.contains('error-state'), 'yellow is not red')
  assert.ok(!status.classList.contains('connecting'))
  assert.equal($('statusText').textContent, '宿主未响应')
  assert.equal(status.getAttribute('aria-label'), '宿主未响应')
})

test('#1b applyLiveStatus: a frame without the field keeps the legacy green behaviour', () => {
  const { organs, $ } = buildStatusOrgans('zh')
  organs.applyLiveStatus({ settings: null })
  const status = $('status')
  assert.ok(!status.classList.contains('degraded'), 'old payloads must not turn the light yellow')
  assert.equal($('statusText').textContent, '已连接')
  assert.equal(status.getAttribute('aria-label'), '已连接')
})

test('#1b applyLiveStatus: muxConnected is read-adjacent but never renders on the phone', () => {
  const { organs, $ } = buildStatusOrgans('zh')
  organs.applyLiveStatus({ hostReachable: false, muxConnected: true, devicesConnected: 2 })
  const status = $('status')
  assert.ok(status.classList.contains('degraded'), 'mux state does not change the three-state outcome')
  assert.equal($('statusText').textContent, '宿主未响应')
  // The desktop-side counters must not leak into the phone's status copy.
  assert.ok(!$('statusText').textContent.includes('2'))
})

test('#1b the three-state fixtures ship in the page: CSS class, i18n key zh+en, wiring', () => {
  const zh = mobilePageAssets({ locale: 'zh' })
  const en = mobilePageAssets({ locale: 'en' })
  assert.match(zh.css, /\.status\.degraded\{background:#c08400;animation:none\}/)
  for (const [label, assets] of [['zh', zh], ['en', en]]) {
    const js = assets.js
    const count = js.split('"statusDegraded":').length - 1
    assert.equal(count, 1, `the L table must declare statusDegraded exactly once (${label})`)
    assert.match(js, /setStatusCopy\(L\.statusDegraded\)/, `the degraded copy must be wired (${label})`)
  }
  assert.match(zh.js, /宿主未响应/)
  assert.match(en.js, /Host unreachable/)
})

// ---------------------------------------------------------------------------
// #4c optimistic creation — pure functions (imported above) and the inline
// seam in the page script.
// ---------------------------------------------------------------------------

test('#4c spliceProvisionalSession inserts first, purely, idempotently', () => {
  const ids = ['a', 'b']
  const once = spliceProvisionalSession(ids, 'pending:1')
  assert.deepEqual(once, ['pending:1', 'a', 'b'])
  assert.deepEqual(ids, ['a', 'b'], 'the input array must be untouched')
  const twice = spliceProvisionalSession(once, 'pending:1')
  assert.deepEqual(twice, ['pending:1', 'a', 'b'], 'a repeat call must not duplicate the provisional id')
  assert.deepEqual(spliceProvisionalSession([], 'pending:2'), ['pending:2'])
})

test('#4c reconcileProvisionalSession replaces in place and dedupes a known realId', () => {
  const ids = ['pending:1', 'a', 'b']
  assert.deepEqual(reconcileProvisionalSession(ids, 'pending:1', 'real'), ['real', 'a', 'b'])
  assert.deepEqual(ids, ['pending:1', 'a', 'b'], 'the input array must be untouched')
  // The server snapshot already lists the real session: only the ghost goes.
  assert.deepEqual(reconcileProvisionalSession(['a', 'real', 'pending:1'], 'pending:1', 'real'), ['a', 'real'])
  assert.deepEqual(reconcileProvisionalSession(['pending:1'], 'pending:1', 'real'), ['real'])
})

// 0.4.31: tapping "+" no longer creates a Host session. It used to, so a tap
// followed by no message and a walk back left an untitled row that would not
// go away. The two pure organs above stay inlined (the ghost-row fallback still
// reads them) but the tap must not consume them: ensureSession is the page's
// only session.create caller.
test('draft creation: "+" mints nothing; ensureSession is the only session.create caller', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const draft = extractFunction(js, 'startDraftChat')
  assert.doesNotMatch(draft, /session\.create/, 'opening a draft must not reach the Host')
  assert.match(draft, /draftWorkspaceId=workspaceId/, 'the draft remembers its workspace')
  const ensure = extractFunction(js, 'ensureSession')
  assert.match(ensure, /rpc\('session\.create'/, 'the session is minted on first real use')
  assert.match(ensure, /if\(activeSession\)return activeSession/, 'a materialized draft never re-creates')
  assert.match(js, /startDraftChat\(wsId\)/, 'the + button is wired to the draft, not to a create')
  // The actions that mean "this draft is in use" must materialize first.
  // 2026-10-16（首次发送延迟）：send() 的材质化不再走早退分支，而是把它当作失败
  // 的一条路径——`if(!activeSession&&!(await ensureSession()))throw new Error(...)`，
  // 由外层 catch 统一回滚乐观气泡、解锁运行态并把正文放回输入框。断言按语义钉：
  // send 里必须出现 ensureSession 的 await，且该调用仍受「没有活跃会话」守卫。
  const sendBody = extractFunction(js, 'send')
  assert.match(sendBody, /if\(!activeSession&&!\(await ensureSession\(\)\)\)throw/,
    'a draft send materializes the session inside the rollback path')
  assert.match(sendBody, /await ensureSession\(\)/)
  assert.match(extractFunction(js, 'uploadGenericFile'), /await ensureSession\(\)/)
  assert.match(extractFunction(js, 'retryDraft'), /await ensureSession\(\)/)
  // 2026-10-15 反转：打开设置面板**不再**建会话。旧断言要求这里出现
  // `const sessionId=await ensureSession()`，而那正是幽灵会话的入口——用户在草稿里
  // 只改设置就返回，宿主盘上留下一个永远没有消息的空会话（实证 session-10f1f2b6-…d3d，
  // 822B 只有 permission/preset 与 agent-preset/selected，零条消息），主页于是多一个
  // 「未命名对话」占位。模型/预设目录本就是宿主全局的，草稿态问得到；选中项先进
  // draftPending，由 ensureSession 成功返回前统一补发。
  const settings = extractFunction(js, 'openSessionSettings')
  assert.doesNotMatch(settings, /ensureSession/, 'opening the settings panel must not mint a session')
  assert.match(settings, /const sessionId=activeSession\|\|null/, 'a draft settings open works without an id')
  assert.match(extractFunction(js, 'ensureSession'), /await applyDraftPending\(created\.sessionId\)/,
    'the buffered draft choices are flushed onto the session the instant it exists')
  // send() 不再另发一次 flush：flush 已织进 ensureSession 的创建链里（同一条 promise），
  // 而 send/upload/retry 全部先 await ensureSession()。再等一次会给同步段多拍一帧，
  // B-5 的「发送一开始输入框即清空」正是靠这一帧时序钉住的（2026-10-15）。
  // 2026-10-15 的反面同样成立：send() 的同步段必须留在 await 之前——它现在是
  // 「发送中」的全部可见证据（清空输入框、画乐观气泡、翻转发送钮/停止钮），
  // 见 test/pages-send-latency.test.js。
  assert.doesNotMatch(sendBody, /applyDraftPending/)
})

test('#4c renderWorkspaces paints a provisional row with the spin state and a title fallback', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const render = extractFunction(js, 'renderWorkspaces')
  assert.match(render, /s\.provisional/)
  assert.match(render, /L\.newChat/, 'L.newChat is the aria/title fallback while creating')
})
