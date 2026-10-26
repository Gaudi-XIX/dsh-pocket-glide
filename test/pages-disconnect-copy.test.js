// W4-收尾 任务A (change 2026-10-07-fix-pocket-disconnect-copy) — 断线原因语义化。
//
// The bridge stamps every failure family with a stable errorCode; until this change the
// phone read none of them past the transport family, so a closed session and a busy
// desktop rendered as the same generic failure. The page now carries STREAM_CODE_COPY,
// a map from the codes that actually exist (grep of lib/bridge.js + lib/pages.js, the
// set asserted below) to bilingual sentences, and falls back to the four generic tiers
// for every code outside it. The reconnect notice moved out of #chatError into a thin
// top bar, so the two surfaces never write each other's copy.
//
// House pattern: the page script lives inside one template literal and cannot be
// imported, so the organs are extracted from the rendered asset and run against
// synthetic state (error-visibility / mobile-assets style).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mobilePageAssets, renderMobilePage } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })
const { js: jsEn } = mobilePageAssets({ locale: 'en' })
const { css } = mobilePageAssets({ locale: 'zh' })
const BOOT = JSON.stringify({ ws: { items: [] }, sess: { items: [] } })

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the rendered asset`)
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

function pageLabels(source) {
  const line = source.match(/^const L=(\{.*\});/m)
  assert(line, 'the page label table must render as one JSON line')
  return JSON.parse(line[1])
}

const L = pageLabels(js)
const LEN = pageLabels(jsEn)

const CODE_COPY_LINE = js.match(/const STREAM_CODE_COPY=\{[^}]*\}/)[0]
const STREAM_CODE_COPY = JSON.parse(CODE_COPY_LINE.slice('const STREAM_CODE_COPY='.length).replace(/'/g, '"'))

function element(initial = '') {
  const el = {
    textContent: initial,
    hidden: true,
    attrs: {},
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
      toggle: () => {},
    },
    setAttribute: (name, value) => { el.attrs[name] = value },
    getAttribute: (name) => (name in el.attrs ? el.attrs[name] : null),
  }
  return el
}

function fakeContainers() {
  return {
    chatError: element(),
    reconnectBar: element(),
    listError: element(),
    settingsError: element(),
    questionError: element(),
    statusText: element(),
    status: element(),
    tunnelWarn: element(),
  }
}

const ORGANS = [
  'isStreamDownCopy',
  'isStreamCodeCopy',
  'streamCodeCopy',
  'importantChatCopy',
  'showError',
  'clearTransientError',
  'streamDownCopy',
  'paintStreamDown',
  'notifyStreamDown',
  'noteStreamRecovery',
  'setStatusCopy',
]

function buildNoticeSandbox(state = {}) {
  const containers = fakeContainers()
  const body = ORGANS.map((name) => extractFunction(js, name)).join('\n')
  const make = new Function(
    'containers',
    'document',
    'setTimeout',
    `
    let importantErrorActive=${JSON.stringify(Boolean(state.importantErrorActive))}
    let streamDownNoticeShown=${JSON.stringify(Boolean(state.streamDownNoticeShown))}
    let streamDownGraceTimer=null
    let streamDownRearmAt=0
    let streamConnected=${JSON.stringify(Boolean(state.streamConnected))}
    let lastStreamFrameAt=0
    const STREAM_DOWN_GRACE_MS=8000
    const STREAM_DOWN_COOLDOWN_MS=${Number(/STREAM_DOWN_COOLDOWN_MS=(\d+)/.exec(js)[1])},STREAM_DOWN_STABLE_MS=${Number(/STREAM_DOWN_STABLE_MS=(\d+)/.exec(js)[1])}
    let tunnelLinkActive=${JSON.stringify(Boolean(state.tunnelLinkActive))}
    ${CODE_COPY_LINE}
    const L=${JSON.stringify(L)}
    const $=(id)=>containers[id]
    ${body}
    return {
      showError, clearTransientError, notifyStreamDown, noteStreamRecovery, streamDownCopy, streamCodeCopy, isStreamCodeCopy, setStatusCopy,
      containers,
      get streamDownNoticeShown(){return streamDownNoticeShown},
    }
  `,
  )
  // The reconnect bar waits a grace window out before it speaks; the sandbox owns that
  // timer and runs anything short (the 8s grace) at once, so a synchronous test still
  // sees the bar the page would raise.
  return make(containers, state.document || { hidden: false }, (fn, ms) => { if ((ms || 0) < 10000) fn(); return 0 })
}

function renderedChatError(error, fallback) {
  const sandbox = buildNoticeSandbox()
  sandbox.showError('chatError', error, fallback)
  return sandbox.containers.chatError.textContent
}

// ------------------------------------------------------------- 实有码全集（grep 断言集）
//
// The card's acceptance names the grep result as the assertion set. Everything the
// bridge can put on the wire as `errorCode` is collected here from the source text;
// a new code added on the bridge side fails this test until it either gets a sentence
// in STREAM_CODE_COPY or is added to the documented-unmapped list with a reason.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const bridgeSource = readFileSync(join(REPO_ROOT, 'lib', 'bridge.js'), 'utf8')
const pagesSource = readFileSync(join(REPO_ROOT, 'lib', 'pages.js'), 'utf8')

function codesSeenInSources() {
  const found = new Set()
  for (const source of [bridgeSource, pagesSource]) {
    // Direct assignments: `errorCode: '__bridge/not-ready'`
    for (const m of source.matchAll(/errorCode:\s*'([^']+)'/g)) found.add(m[1])
    // Membership sets: TRANSPORT_ERROR_CODES / NOT_FOUND_CODES
    for (const m of source.matchAll(/CODES\s*=\s*new Set\(\[([^\]]*)\]\)/g)) {
      for (const c of m[1].matchAll(/'([^']+)'/g)) found.add(c[1])
    }
    // Plain `code: 'cancelled'`-shaped literals (Host rejection frames built locally).
    for (const m of source.matchAll(/(?:^|[,{\s])code:\s*'([a-z][a-z-]+)'/gm)) found.add(m[1])
    // The page's own comparisons: `e.errorCode==='session/agent-busy'` (the typeof
    // optional-chain in rpcFailure must not read as a code literal).
    for (const m of source.matchAll(/(?<!\?)\.errorCode==='([^']+)'/g)) found.add(m[1])
  }
  return found
}

// Codes with no user-facing sentence ON PURPOSE, each with the reason a reader would
// not be helped by one. Everything else found above must be in STREAM_CODE_COPY.
const UNMAPPED = new Map([
  ['__bridge/transport', 'already rendered as a dead request via rpcFailure (L.streamDownFailed)'],
  ['__bridge/rpc-mismatch', 'same transport family; a protocol lie is not a reader decision'],
  ['__bridge/invalid-arguments', 'a client bug: the bridge prose is the diagnosis, generic copy would hide it'],
  ['session/attachment-invalid', 'the attachment endpoint answers 404 text, never an RPC errorCode'],
  ['host-rejection', 'a log/probe class only — never placed on the wire as errorCode'],
])

test('every errorCode the sources can produce is mapped or documented-unmapped', () => {
  const seen = codesSeenInSources()
  assert.ok(seen.size >= 7, `the scan must find the real families, got ${JSON.stringify([...seen])}`)
  const missing = [...seen].filter((code) => !STREAM_CODE_COPY[code] && !UNMAPPED.has(code))
  assert.deepEqual(missing, [], 'a new errorCode appeared: add a sentence to STREAM_CODE_COPY (both locales) or justify it in UNMAPPED')
  const stale = [...Object.keys(STREAM_CODE_COPY)].filter((code) => !seen.has(code))
  assert.deepEqual(stale, [], 'a mapped code no longer exists in the sources: retire the sentence')
})

test('each mapped code resolves to a bilingual sentence with no jargon in it', () => {
  for (const [code, key] of Object.entries(STREAM_CODE_COPY)) {
    assert.ok(L[key], `zh copy missing for ${code} (key ${key})`)
    assert.ok(LEN[key], `en copy missing for ${code} (key ${key})`)
    for (const [locale, copy] of [['zh', L[key]], ['en', LEN[key]]]) {
      assert.ok(!/SSE|seq\b/i.test(copy), `${locale} copy for ${code} must not carry transport jargon`)
      assert.ok(!new RegExp(code.replace(/[*/]/g, '\\$&')).test(copy), `${locale} copy for ${code} must not print the raw code`)
    }
  }
})

// ------------------------------------------------------------------- 查表与回落

test('a mapped code names its reason in the banner, in both locales', () => {
  for (const code of Object.keys(STREAM_CODE_COPY)) {
    assert.equal(renderedChatError({ errorCode: code }), L[STREAM_CODE_COPY[code]], `zh ${code}`)
    assert.ok(L[STREAM_CODE_COPY[code]], 'zh key resolves')
    assert.ok(LEN[STREAM_CODE_COPY[code]], 'en key resolves')
  }
})

test('the mapped sentence stands as the important message (a clean poll cannot erase it)', () => {
  const sandbox = buildNoticeSandbox()
  sandbox.showError('chatError', { errorCode: 'session/not-found' })
  assert.equal(sandbox.containers.chatError.textContent, L.codeSessionGone)
  sandbox.clearTransientError('chatError')
  assert.equal(sandbox.containers.chatError.textContent, L.codeSessionGone, 'the standing guard keeps it')
})

test('an unmapped code keeps the bridge prose and a missing code keeps the tiers', () => {
  assert.equal(renderedChatError({ errorCode: 'gateway/service-unavailable', message: 'The gateway refused.' }), 'The gateway refused.', 'unmapped code: the failure message wins as before')
  assert.equal(renderedChatError({ message: '上一轮没能跑完' }), '上一轮没能跑完', 'no code: the message wins as before')
  assert.equal(renderedChatError(null, '指令执行失败'), '指令执行失败', 'fallback chain unchanged')
  assert.equal(renderedChatError(null), L.failed)
})

test('agent-busy keeps its special list-jump in loadHistory and gains a banner sentence elsewhere', () => {
  const loading = js.match(/if\(e&&e\.errorCode==='session\/agent-busy'\)\{void showSessionList\(\);return\}/)
  assert.ok(loading, 'the loadHistory intercept is untouched')
  assert.equal(renderedChatError({ errorCode: 'session/agent-busy' }), L.codeAgentBusy, 'other callers (send) get the sentence')
})

// --------------------------------------------------------- failure 帧的 code 查表

test('a host-error failure frame with a mapped code speaks the sentence instead of prose+code', () => {
  const source = extractFunction(js, 'streamFailureCopy')
  const make = new Function(
    `
    ${CODE_COPY_LINE}
    const L=${JSON.stringify(L)}
    ${source}
    return streamFailureCopy
  `,
  )()
  assert.equal(make({ reason: 'host-error', code: 'session/not-found', message: 'Remote stream failed.' }), L.codeSessionGone)
  // Unmapped codes keep yesterday's copy byte for byte, suffix included.
  assert.equal(
    make({ reason: 'transport', code: '__bridge/stream-transport' }),
    `${L.streamFailTransport} (__bridge/stream-transport)`,
    'transport reason keeps its generic copy and code suffix',
  )
  assert.equal(
    make({ reason: 'host-error', code: 'gateway/x', message: 'Remote stream failed.' }),
    `${L.streamFailHost} (gateway/x)`,
    'an unmapped host code keeps the known-reason copy + suffix',
  )
  assert.equal(
    make({ reason: 'host-error' }),
    L.streamFailHost,
    'a host error with no code still lands on the generic stream-failure sentence',
  )
})

// --------------------------------------------------------------- 重连条与错误分离

test('the reconnect bar ships in the document, weak by design, in both locales', () => {
  for (const [locale, page] of [['zh', renderMobilePage({ locale: 'zh', boot: BOOT, initialChat: true })], ['en', renderMobilePage({ locale: 'en', boot: BOOT, initialChat: true })]]) {
    assert.ok(page.includes('id="reconnectBar" class="reconnect-bar" role="status" aria-live="polite" hidden'), `${locale} bar markup with its own live region`)
  }
  assert.ok(css.includes('.reconnect-bar{position:fixed;left:0;right:0;top:0'), 'the bar is a top strip')
  assert.ok(css.includes('background:color-mix(in srgb,var(--paper) 70%,transparent)'), 'semi-transparent, visually weak')
  assert.ok(css.includes('font-size:11.5px'), 'thin copy, not a banner')
  assert.ok(css.includes('pointer-events:none'), 'not interactive — it resolves on recovery')
})

test('the reconnect copy and the error banner never share a surface', () => {
  const sandbox = buildNoticeSandbox({ tunnelLinkActive: true })
  sandbox.notifyStreamDown()
  assert.equal(sandbox.containers.reconnectBar.textContent, L.streamDownTunnel, 'the drop names the tunnel in the bar')
  assert.equal(sandbox.containers.chatError.textContent, '', 'the banner stays empty')

  // A real error, while the bar is up, goes to the banner only.
  sandbox.showError('chatError', { message: '指令执行失败' })
  assert.equal(sandbox.containers.chatError.textContent, '指令执行失败')
  assert.equal(sandbox.containers.reconnectBar.textContent, L.streamDownTunnel, 'the bar is untouched by errors')

  // And a disconnect error never writes the banner either.
  const fresh = buildNoticeSandbox()
  fresh.showError('chatError', { disconnected: true })
  assert.equal(fresh.containers.reconnectBar.textContent, L.disconnectedRetry)
  assert.equal(fresh.containers.reconnectBar.hidden, false, 'the bar becomes visible')
  assert.equal(fresh.containers.chatError.textContent, '')
})

test('a mapped-code copy is retired by the recovery guard release but not erased by it', () => {
  // Same V-4 semantics as the failure copy: the recovery releases the standing guard,
  // the next poll that answers may clear it — the recovery itself only retracts the
  // copies it (or the drop notice) wrote.
  const sandbox = buildNoticeSandbox()
  sandbox.showError('chatError', { errorCode: 'session/not-found' })
  sandbox.noteStreamRecovery()
  assert.equal(sandbox.containers.chatError.textContent, L.codeSessionGone, 'the recovery did not write it')
  sandbox.clearTransientError('chatError')
  assert.equal(sandbox.containers.chatError.textContent, '', 'so the next clean poll clears it')
})
