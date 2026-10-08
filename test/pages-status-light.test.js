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

test('#4c createSessionIn consumes the two pure organs, inlined into the page script', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  assert.match(js, /function spliceProvisionalSession\(sessionIds, localId\)/, 'the organ must be inlined verbatim')
  assert.match(js, /function reconcileProvisionalSession\(sessionIds, localId, realId\)/)
  const create = extractFunction(js, 'createSessionIn')
  assert.match(create, /spliceProvisionalSession\(/)
  assert.match(create, /reconcileProvisionalSession\(/)
  assert.match(create, /provisional:true/)
  assert.match(create, /pending:/, 'the local provisional id carries the pending: prefix')
})

test('#4c renderWorkspaces paints a provisional row with the spin state and a title fallback', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const render = extractFunction(js, 'renderWorkspaces')
  assert.match(render, /s\.provisional/)
  assert.match(render, /L\.newChat/, 'L.newChat is the aria/title fallback while creating')
})
