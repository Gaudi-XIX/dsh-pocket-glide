// WP-A2 回归断言（change 2026-10-02-fix-pocket-audit-remediation — P0-C 掉线可见 + 半开 SSE）。
//
// The page script lives inside one template literal and cannot be imported, so every
// assertion here pulls the REAL text out of the rendered asset (extractFunction /
// between) and runs it against synthetic state — the house pattern. Behaviour-level
// assertions come first because a literal-only assertion "passes" as soon as somebody
// renames the variable (LEAD §D).
//
// Covered: AC-C1 (a disconnect names itself), AC-C2 (a good poll cannot erase a better
// message), AC-C3 (a half-open stream is noticed and handed to the poll), AC-D4
// (tokenStream is dropped on disconnect and on snapshot), AC-X2 (handoffPainted cannot
// survive the same-session early exit), the one-notice-per-drop latch, the three
// disconnect tiers, the readable copy beside the status dot, checkConnection counting a
// non-OK answer as unreachable, the rpc errorCode consumer, and the pull gesture brought
// in line with the button and the auto-fill path (WP-A1's leftover asymmetry).
//
// File-ownership note for LEAD: the tasks checklist sends AC-X2 to
// test/stream-watermark.test.js and AC-D4 to test/empty-buffer-bootstrap.test.js.
// Neither file is writable by this worker (the first is WP-A1's committed guard set, the
// second was never created), so both assertions live here instead — the same
// disposition LEAD approved for WP-A1 in handoff/lead-decisions-1.md D-1. Nothing below
// depends on the file name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets, renderMobilePage } from '../lib/pages.js'
import { SSE_KEEPALIVE_MS, SSE_STATUS_MS } from '../lib/constants.js'

const { js } = mobilePageAssets({ locale: 'zh' })
const { js: jsEn } = mobilePageAssets({ locale: 'en' })
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

function between(startAnchor, endAnchor, source = js) {
  const start = source.indexOf(startAnchor)
  const end = source.indexOf(endAnchor, start)
  assert.notEqual(start, -1, `anchor ${startAnchor} must exist in the page script`)
  assert.notEqual(end, -1, `anchor ${endAnchor} must exist in the page script`)
  return source.slice(start, end)
}

// extractFunction counts braces from the signature, so a parameter with an object
// default (function rpc(method,payload={},timeoutMs)) closes the count early. For those
// the slice runs to the next definition instead — still the real text, just wider.
function extractUntil(name, endAnchor, source = js) {
  return between(`function ${name}(`, endAnchor, source).replace(/\s+$/, '')
}

// The page's own label tables, so every copy asserted below is what the phone renders.
function pageLabels(source) {
  const line = source.match(/^const L=(\{.*\});/m)
  assert(line, 'the page label table must render as one JSON line')
  return JSON.parse(line[1])
}

const L = pageLabels(js)
const LEN = pageLabels(jsEn)

function element(initial = '') {
  const classes = new Set()
  const el = {
    textContent: initial,
    hidden: true,
    attrs: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name) },
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

const NOTICE_ORGANS = [
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

// The flags the notice organs share. Every sandbox that runs one of them has to own
// them, or the page code throws on a missing global and the test proves nothing.
const CODE_COPY_LINE = js.match(/const STREAM_CODE_COPY=\{[^}]*\}/)[0]
// The reconnect cooldown and the stability window it re-arms on, read off the page so a
// sandbox cannot drift from the numbers the phone actually ships (2026-10-23).
const NOTICE_COOLDOWN_MS = Number(/STREAM_DOWN_COOLDOWN_MS=(\d+)/.exec(js)[1])
const NOTICE_STABLE_MS = Number(/STREAM_DOWN_STABLE_MS=(\d+)/.exec(js)[1])
const NOTICE_STATE = (state = {}) => `
    let importantErrorActive=${JSON.stringify(Boolean(state.importantErrorActive))}
    let streamDownNoticeShown=${JSON.stringify(Boolean(state.streamDownNoticeShown))}
    let streamDownGraceTimer=null
    let streamDownRearmAt=${Number(state.streamDownRearmAt) || 0}
    let streamConnected=${JSON.stringify(Boolean(state.streamConnected))}
    let lastStreamFrameAt=${Number(state.lastStreamFrameAt) || 0}
    const STREAM_DOWN_GRACE_MS=8000
    const STREAM_DOWN_COOLDOWN_MS=${NOTICE_COOLDOWN_MS},STREAM_DOWN_STABLE_MS=${NOTICE_STABLE_MS}
    let tunnelLinkActive=${JSON.stringify(Boolean(state.tunnelLinkActive))}
    ${CODE_COPY_LINE}
    const L=${JSON.stringify(L)}
    const $=(id)=>containers[id]
`

// showError, the disconnect notice and the transient-clear guard share the page flags
// importantErrorActive / streamDownNoticeShown / tunnelLinkActive, so the sandbox owns
// them exactly as the page does and the latch is exercised rather than described.
function buildNoticeSandbox(state = {}) {
  const containers = fakeContainers()
  const body = NOTICE_ORGANS.map((name) => extractFunction(js, name)).join('\n')
  // The reconnect bar now waits a grace window out before it speaks, so the sandbox
  // has to own that timer. Anything short (the 8s grace) runs at once; the 90s
  // auto-dismiss is left pending, which is what the pre-grace tests relied on.
  const make = new Function(
    'containers',
    'document',
    'setTimeout',
    `
    ${NOTICE_STATE(state)}
    ${body}
    return {
      showError, clearTransientError, notifyStreamDown, noteStreamRecovery, streamDownCopy, setStatusCopy,
      get importantErrorActive(){return importantErrorActive},
      get streamDownNoticeShown(){return streamDownNoticeShown},
      get streamDownRearmAt(){return streamDownRearmAt},
      set streamDownRearmAt(value){streamDownRearmAt=value},
      set tunnelLinkActive(value){tunnelLinkActive=value},
      containers,
    }
  `,
  )
  return make(containers, state.document || { hidden: false }, (fn, ms) => { if ((ms || 0) < 10000) fn(); return 0 })
}

// A timer that runs the grace at once would turn "8s later" into "now", which is exactly
// the state the phone is NOT in — and it would keep passing even if the grace were deleted.
// This sandbox keeps every timer pending and cancels by handle, so a test can sample INSIDE
// the window and then expire it itself.
function buildGraceSandbox(state = {}) {
  const containers = fakeContainers()
  const body = NOTICE_ORGANS.map((name) => extractFunction(js, name)).join('\n')
  const pending = []
  const make = new Function(
    'containers',
    'document',
    'setTimeout',
    'clearTimeout',
    'pending',
    `
    ${NOTICE_STATE(state)}
    ${body}
    return {
      notifyStreamDown, noteStreamRecovery, showError, streamDownCopy,
      get pending(){return pending},
      get streamDownNoticeShown(){return streamDownNoticeShown},
      get graceTimer(){return streamDownGraceTimer},
      containers,
    }
  `,
  )
  const world = make(
    containers,
    state.document || { hidden: false },
    (fn, ms) => { pending.push({ fn, ms, cancelled: false }); return pending.length },
    (id) => { const held = pending[id - 1]; if (held) held.cancelled = true },
    pending,
  )
  world.expire = () => { for (const held of pending) if (!held.cancelled) held.fn() }
  return world
}

// ------------------------------------------------------------------ grace window

test('a dropped frame stays silent inside the grace window', () => {
  const world = buildGraceSandbox()
  world.notifyStreamDown()
  assert.equal(world.containers.reconnectBar.hidden, true, 'nothing on screen inside the window')
  assert.equal(world.containers.reconnectBar.textContent, '')
  assert.equal(world.streamDownNoticeShown, false, 'and the latch stays free for the real drop')
  assert.equal(world.pending.length, 1, 'exactly one wait is armed')
  assert.equal(world.pending[0].ms, 8000, 'the window the page advertises')
})

test('the same drop speaks once the window expires', () => {
  const world = buildGraceSandbox()
  world.notifyStreamDown()
  world.expire()
  assert.equal(world.containers.reconnectBar.hidden, false)
  assert.equal(world.containers.reconnectBar.textContent, world.streamDownCopy())
  assert.equal(world.streamDownNoticeShown, true)
  assert.equal(world.graceTimer, null, 'the handle is dropped once it fires')
})

test('a frame that lands inside the window keeps the bar away for good', () => {
  const world = buildGraceSandbox()
  world.notifyStreamDown()
  world.noteStreamRecovery()
  world.expire()
  assert.equal(world.containers.reconnectBar.hidden, true, 'a recovered blip never paints')
  assert.equal(world.containers.reconnectBar.textContent, '')
  assert.equal(world.streamDownNoticeShown, false)
})

test('a refused RPC still paints at once — the grace is for frames, not for failures', () => {
  const world = buildGraceSandbox()
  world.showError('chatError', { disconnected: true })
  assert.equal(world.containers.reconnectBar.textContent, L.disconnectedRetry, 'no 8s wait on a real failure')
  assert.equal(world.containers.reconnectBar.hidden, false)
  assert.equal(world.pending.length, 0, 'and no wait is armed behind it')
})

// The mandated shape: what one rendered error line actually shows. A DISCONNECT is no
// longer an error-line copy (W4 separation): it lands in the top reconnect bar instead,
// so the two render helpers below keep the two surfaces apart on purpose.
function renderedError(error, fallback) {
  const sandbox = buildNoticeSandbox()
  sandbox.showError('chatError', error, fallback)
  return sandbox.containers.chatError.textContent
}

function renderedDisconnect(error) {
  const sandbox = buildNoticeSandbox()
  sandbox.showError('chatError', error)
  return sandbox.containers.reconnectBar.textContent
}

// ----------------------------------------------------------------------- AC-C1

test('AC-C1 a disconnect names itself in both locales', () => {
  assert.equal(L.disconnectedRetry, '连接已断开，正在重试…', 'the zh copy is the one the audit asked for')
  assert.equal(LEN.disconnectedRetry, 'Connection lost, retrying…', 'and the en branch exists beside it')
  assert.equal(renderedDisconnect({ disconnected: true }), '连接已断开，正在重试…')
  assert.equal(renderedDisconnect({ disconnected: true }), L.disconnectedRetry, 'the page label, not a test copy')
  // W4 separation: the reconnect state never occupies the error banner.
  assert.equal(renderedError({ disconnected: true }), '', 'the error banner stays empty for a reconnect')
})

test('AC-C1 no disconnected-to-empty mapping survives anywhere in the script', () => {
  // Acceptance criterion at source level. A rename would hide it from a variable check,
  // so the empty-string branch itself is what must be gone.
  assert.ok(!js.includes("error?.disconnected?'':"), 'the zh asset is clean')
  assert.ok(!jsEn.includes("error?.disconnected?'':"), 'the en asset is clean')
  assert.match(js, /function showError\(id,error,fallback\)\{const text=error\?\.disconnected\?L\.disconnectedRetry/)
})

test('AC-C1 every other showError branch is untouched', () => {
  assert.equal(renderedError({ message: '上一轮没能跑完' }), '上一轮没能跑完', 'a message still wins')
  assert.equal(renderedError(null, '指令执行失败'), '指令执行失败', 'then the caller fallback')
  assert.equal(renderedError(null), L.failed, 'and only then the generic failure')
  assert.equal(renderedError({ timeout: true, message: L.requestTimeout }), L.requestTimeout, 'a timeout is not a disconnect')
})

// ----------------------------------------------------------------------- AC-C2

test('AC-C2 a successful poll keeps the stream failure copy', () => {
  const sandbox = buildNoticeSandbox()
  const copy = `${L.streamFailure} (E_STREAM)`
  sandbox.showError('chatError', { message: copy, important: true })
  assert.equal(sandbox.importantErrorActive, true, 'a failed stream outranks a clean poll')
  sandbox.clearTransientError('chatError')
  assert.equal(sandbox.containers.chatError.textContent, copy, 'so the poll leaves it alone')
  assert.equal(sandbox.containers.chatError.textContent, '连接中断 (E_STREAM)', 'the copy the audit asked to keep')
})

test('AC-C2 loadHistory clears through the guard instead of an assignment', () => {
  const loading = between('async function loadHistory(initial,force)', 'const FALLBACK_IMAGE_LIMITS')
  assert.ok(loading.includes("clearTransientError('chatError')"), 'the success path asks the guard')
  assert.ok(!loading.includes("$('chatError').textContent=''"), 'a bare assignment would silence the disconnect again')
})

test('AC-C2 loadHistory stopped folding its own disconnect into a generic failure', () => {
  // Live probe 2026-10-03: with the RPC path broken, tapping send showed 请求失败 —
  // the catch below was passing `''` for a disconnected error, exactly the mapping
  // showError was fixed from doing.
  const loading = between('async function loadHistory(initial,force)', 'const FALLBACK_IMAGE_LIMITS')
  assert.ok(loading.includes("showError('chatError',e)"), 'the real error reaches showError')
  assert.ok(!loading.includes("e?.disconnected&&!e?.timeout?'':e"), 'the hand-rolled fold is gone')
})

test('AC-C2 the status poll clears through the same guard', () => {
  const checking = 'async ' + extractFunction(js, 'checkConnection')
  assert.ok(!checking.includes("$('chatError').textContent=''"), 'no bare erasure beside the dot')
  assert.equal((checking.match(/clearTransientError\('chatError'\)/g) || []).length, 2, 'both failure branches ask the guard')
})

test('AC-C2 an ordinary copy is still cleared, and only the named line is touched', () => {
  const sandbox = buildNoticeSandbox()
  sandbox.showError('chatError', { message: '指令执行失败' })
  assert.equal(sandbox.importantErrorActive, false, 'an ordinary failure is not a standing alarm')
  sandbox.containers.listError.textContent = '会话列表加载失败'
  sandbox.clearTransientError('chatError')
  assert.equal(sandbox.containers.chatError.textContent, '', 'the clean poll may clear it')
  assert.equal(sandbox.containers.listError.textContent, '会话列表加载失败', 'and nothing else is erased')
})

// V-4 (independent verify round, 2026-10-03): nothing pinned what the recovery path
// does to a standing copy it did not itself write. Pinning it settled two facts.
// First, L.disconnectedRetry IS one of the down copies (isStreamDownCopy names it),
// so the recovery frame retires a standing RPC disconnect by itself — that is the
// reachable interleave the first pass carried nowhere. Second, a copy outside that
// family (a failure frame's text: important, but not the outage notice) survives the
// recovery while the guard is still released, and releasing the guard is exactly what
// lets the next poll that answers clear it — keeping the guard instead would leave
// that copy on screen for good.
test('the recovery frame retires a standing RPC disconnect, not just its own notice (V-4)', () => {
  const sandbox = buildNoticeSandbox()
  sandbox.showError('chatError', { disconnected: true })
  assert.equal(sandbox.containers.reconnectBar.textContent, L.disconnectedRetry, 'the disconnect names itself (in the bar, W4 separation)')
  assert.equal(sandbox.containers.reconnectBar.hidden, false, 'and the bar is visible')

  sandbox.noteStreamRecovery()
  assert.equal(sandbox.containers.reconnectBar.textContent, '', 'but the recovery answers it, so it goes')
  assert.equal(sandbox.containers.reconnectBar.hidden, true, 'and the bar collapses with it')
  assert.equal(sandbox.importantErrorActive, false, 'and the guard goes with it')
})

test('a copy the recovery did not write survives it until a poll can answer for it (V-4 residual)', () => {
  const sandbox = buildNoticeSandbox()
  const failure = `${L.streamFailTransport} (E_STREAM)`
  sandbox.showError('chatError', { message: failure, important: true })
  assert.equal(sandbox.containers.chatError.textContent, failure, 'a failure frame states itself')
  assert.equal(sandbox.importantErrorActive, true, 'and is important')

  sandbox.noteStreamRecovery()
  assert.equal(
    sandbox.containers.chatError.textContent,
    failure,
    'the recovery only retracts the copy it wrote',
  )
  assert.equal(sandbox.importantErrorActive, false, 'while the guard it drops is what makes the copy retractable')

  sandbox.clearTransientError('chatError')
  assert.equal(sandbox.containers.chatError.textContent, '', 'so the next poll that answers may clear it')
})

test('the recovery still retires the outage notice it answered (V-4 companion)', () => {
  const sandbox = buildNoticeSandbox()
  sandbox.notifyStreamDown()
  assert.equal(sandbox.streamDownNoticeShown, true, 'the outage stands (latched)')
  assert.equal(sandbox.containers.reconnectBar.hidden, false, 'the bar is on screen')

  sandbox.noteStreamRecovery()
  assert.equal(sandbox.containers.reconnectBar.textContent, '', 'and the notice the recovery answered is gone')
  assert.equal(sandbox.containers.reconnectBar.hidden, true)
  assert.equal(sandbox.streamDownNoticeShown, false)
})

// ------------------------------------------------- 每轮断开最多一次（闩锁，不是绝对计数）

test('the disconnect notice speaks once per drop, and a new drop waits the cooldown out', () => {
  const sandbox = buildNoticeSandbox({ tunnelLinkActive: true })
  sandbox.notifyStreamDown()
  const first = sandbox.containers.reconnectBar.textContent
  assert.equal(first, L.streamDownTunnel, 'a tunnel drop names the tunnel')
  assert.equal(sandbox.containers.statusText.textContent, L.statusReconnecting, 'and the dot gains words')
  assert.equal(sandbox.containers.chatError.textContent, '', 'and never lands in the error banner (W4 separation)')
  assert.equal(sandbox.streamDownNoticeShown, true)
  // Further retry ticks of the same outage must not rewrite or stack the message.
  sandbox.containers.reconnectBar.textContent = '别的消息'
  sandbox.notifyStreamDown()
  assert.equal(sandbox.containers.reconnectBar.textContent, '别的消息', 'the latch swallowed the repeat')
  // The first frame that proves delivery closes the latch and retires the copy it answered.
  sandbox.containers.reconnectBar.textContent = first
  sandbox.noteStreamRecovery()
  assert.equal(sandbox.streamDownNoticeShown, false, 'recovered')
  assert.equal(sandbox.containers.reconnectBar.textContent, '', 'and the notice it answered is gone')
  assert.equal(sandbox.containers.statusText.textContent, L.statusConnected)
  // 2026-10-23: a bar that came back every ten seconds was the report. The same outage is
  // stated once per cooldown, so a link that keeps flapping stops interrupting the reader.
  assert.ok(sandbox.streamDownRearmAt > Date.now(), 'the recovery left the cooldown running')
  sandbox.notifyStreamDown()
  assert.equal(sandbox.containers.reconnectBar.hidden, true, 'a new drop inside the cooldown says nothing')
  sandbox.streamDownRearmAt = Date.now() - 1
  sandbox.notifyStreamDown()
  assert.equal(sandbox.containers.reconnectBar.textContent, L.streamDownTunnel, 'past the cooldown a drop speaks again')
})

test('the cooldown, not the frame, decides when the notice may speak again', () => {
  const sandbox = buildNoticeSandbox()
  sandbox.notifyStreamDown()
  assert.equal(sandbox.streamDownNoticeShown, true, 'the notice is latched through the outage')
  sandbox.noteStreamRecovery()
  assert.equal(sandbox.streamDownNoticeShown, false, 'and the recovery releases the latch')
  for (let round = 0; round < 3; round += 1) {
    sandbox.notifyStreamDown()
    sandbox.notifyStreamDown()
    assert.equal(sandbox.streamDownNoticeShown, false, 'but the cooldown keeps a flapping link quiet')
  }
  assert.equal(NOTICE_COOLDOWN_MS, 300000, 'five minutes between two statements of the same outage')
})

test('an outage that outlives its cooldown re-arms on twenty stable seconds', () => {
  const sandbox = buildNoticeSandbox()
  sandbox.notifyStreamDown()
  assert.equal(NOTICE_STABLE_MS, 20000, 'the stability window the page ships')
  sandbox.streamDownRearmAt = Date.now() - 1 // the outage outlasted its own cooldown
  sandbox.noteStreamRecovery()
  assert.ok(
    sandbox.streamDownRearmAt > Date.now() + NOTICE_STABLE_MS - 2000,
    'so the frame that ends it re-arms on stability, not on the frame itself',
  )
})

// ---------------------------------------------------------------- 断线原因三档标签

test('the three disconnect tiers exist in both locales and are picked by cause', () => {
  for (const [key, zh, en] of [
    ['streamDownTunnel', '远程链接断了，正在自动重试…', 'The remote link dropped, retrying on its own…'],
    ['streamDownHost', '桌面端处理较慢，正在等它回应…', 'The desktop is slow to answer; still waiting…'],
    ['streamDownBackground', '会话被移到后台，回到前台会自动继续', 'This chat moved to the background; it resumes when you return'],
  ]) {
    assert.equal(L[key], zh, `zh tier ${key}`)
    assert.equal(LEN[key], en, `en tier ${key}`)
  }
  assert.equal(buildNoticeSandbox().streamDownCopy(), L.streamDownHost, 'a LAN page blames the desktop')
  assert.equal(buildNoticeSandbox({ tunnelLinkActive: true }).streamDownCopy(), L.streamDownTunnel, 'a tunnel page blames the link')
  const hidden = buildNoticeSandbox({ document: { hidden: true }, tunnelLinkActive: true })
  assert.equal(hidden.streamDownCopy(), L.streamDownBackground, 'and a backgrounded tab says it moved to the background')
})

test('a repeated RPC timeout cannot flap the bar either — one cooldown for both writers (2026-10-23)', () => {
  const sandbox = buildNoticeSandbox()
  sandbox.showError('chatError', { disconnected: true })
  assert.equal(sandbox.containers.reconnectBar.hidden, false, 'the first timeout speaks')
  sandbox.noteStreamRecovery()
  assert.equal(sandbox.containers.reconnectBar.hidden, true, 'and the recovery retires it')
  sandbox.showError('chatError', { disconnected: true })
  assert.equal(sandbox.containers.reconnectBar.hidden, true, 'the next one inside the cooldown stays silent')
})

test('a slow desktop is not called a dropped connection (2026-10-23)', () => {
  const slow = buildNoticeSandbox({ streamConnected: true, lastStreamFrameAt: Date.now() })
  slow.showError('chatError', { disconnected: true })
  assert.equal(
    slow.containers.reconnectBar.textContent,
    L.streamDownHost,
    'a stream still delivering frames means the desktop is slow, not gone',
  )
  const gone = buildNoticeSandbox({ streamConnected: false })
  gone.showError('chatError', { disconnected: true })
  assert.equal(gone.containers.reconnectBar.textContent, L.disconnectedRetry, 'a silent stream is a dropped connection')
})

test('the tunnel tier comes from the status payload, not from a guess', () => {
  const warning = between('function renderTunnelWarning(expiresAt)', 'function formatDeviceExpiryTime')
  assert.ok(warning.includes('tunnelLinkActive=typeof expiresAt==='), 'the copy is derived from the frame it already reads')
  assert.ok(warning.includes('expiresAt>Date.now()'), 'and an expired link is not an active one')
})

// --------------------------------------------------------------------- #status 文案位

test('the status dot gained a readable copy slot beside it', () => {
  const zhPage = renderMobilePage({ locale: 'zh', boot: BOOT, initialChat: true })
  const enPage = renderMobilePage({ locale: 'en', boot: BOOT, initialChat: true })
  assert.match(zhPage, /<span id="statusText" class="status-text" aria-hidden="true">正在连接<\/span>/, 'the slot ships with the header')
  assert.match(enPage, /<span id="statusText" class="status-text" aria-hidden="true">Connecting<\/span>/, 'in both locales')
  assert.match(zhPage, /\.status-text\{/, 'and is styled instead of inheriting the dot')
  assert.ok(zhPage.includes('<div id="status" class="status connecting" role="status"'), 'the dot keeps its role')
  const setter = between('function setStatusCopy(text)', 'function renderTunnelWarning')
  assert.ok(setter.includes("$('statusText')"), 'the writer targets the slot only')
  const sandbox = buildNoticeSandbox()
  sandbox.setStatusCopy(L.statusDisconnected)
  assert.equal(sandbox.containers.statusText.textContent, '已断开')
  sandbox.setStatusCopy('')
  assert.equal(sandbox.containers.statusText.textContent, '', 'an empty copy is allowed')
})

test('the aria-label logic stayed where it was and the copy is written beside it', () => {
  const checking = 'async ' + extractFunction(js, 'checkConnection')
  // Four states since the three-status-light batch: green / degraded / red / red-catch.
  assert.equal((checking.match(/status\.setAttribute\('aria-label',/g) || []).length, 4, 'every branch still sets the label')
  assert.ok(between('function applyLiveStatus(body)', '(async()=>{').includes('setStatusCopy(L.statusConnected)'), 'the live status frame writes the copy too')
})

// -------------------------------------------------------------------- checkConnection

function buildConnectionSandbox(state = {}) {
  const containers = fakeContainers()
  const events = []
  const source = 'async ' + extractFunction(js, 'checkConnection')
  // checkConnection clears through clearTransientError, so the notice organs and their
  // flags have to be present in this sandbox too — otherwise the missing global would
  // throw inside the try and the test would measure the catch branch by accident.
  const organs = NOTICE_ORGANS.map((name) => extractFunction(js, name)).join('\n')
  const make = new Function(
    'containers',
    'fetch',
    'document',
    'location',
    'showUnreachableOverlay',
    'hideUnreachableOverlay',
    'applyInheritedSettings',
    'renderTunnelWarning',
    'renderDeviceExpiry',
    'setTimeout',
    `
    ${NOTICE_STATE(state)}
    ${organs}
    let lastLiveStatusAt=0,unreachableStreak=0
    function noteHostClock(){}
    ${source}
    return {
      checkConnection,
      notifyStreamDown,
      showError,
      containers,
      copy: () => containers.statusText.textContent,
      get unreachableStreak(){return unreachableStreak},
      set unreachableStreak(value){unreachableStreak=value},
      set lastLiveStatusAt(value){lastLiveStatusAt=value},
      get streamDownNoticeShown(){return streamDownNoticeShown},
      set streamDownNoticeShown(value){streamDownNoticeShown=value},
      get importantErrorActive(){return importantErrorActive},
    }
  `,
  )
  const sandbox = make(
    containers,
    state.fetch,
    state.document || { hidden: false },
    state.location || { replace: (target) => events.push(`replace:${target}`) },
    () => events.push('overlay'),
    () => events.push('hide-overlay'),
    () => {},
    () => {},
    () => {},
    // The reconnect bar waits a grace window out before it speaks; the sandbox owns that
    // timer and runs anything short (the 8s grace) at once, so a synchronous test still
    // sees the bar the page would raise.
    (fn, ms) => { if ((ms || 0) < 10000) fn(); return 0 },
  )
  sandbox.events = events
  return sandbox
}

const statusReply = (init) => async () => ({
  ok: init.ok,
  status: init.status,
  json: async () => init.body ?? {},
})

test('a non-OK answer from /api/status counts as unreachable and says so', async () => {
  const sandbox = buildConnectionSandbox({ fetch: statusReply({ ok: false, status: 500, body: {} }) })
  await sandbox.checkConnection()
  assert.equal(sandbox.unreachableStreak, 1, 'the !response.ok branch must accumulate the streak')
  assert.equal(sandbox.copy(), L.statusDisconnected, 'and the header reads 已断开')
  assert.ok(sandbox.containers.status.classList.contains('error-state'), 'the dot still turns red')
  await sandbox.checkConnection()
  await sandbox.checkConnection()
  assert.equal(sandbox.unreachableStreak, 3, 'three strikes, not an instant full-screen alarm')
  assert.ok(sandbox.events.includes('overlay'), 'the overlay arrives on the third')
})

test('the 401 path is byte-for-byte the old behaviour: redirect, no added notice', async () => {
  const sandbox = buildConnectionSandbox({ fetch: statusReply({ ok: false, status: 401, body: {} }) })
  await sandbox.checkConnection()
  assert.deepEqual(sandbox.events.filter((event) => event.startsWith('replace:')), ['replace:/disconnected'])
  assert.equal(sandbox.unreachableStreak, 0, 'a redirect is not an unreachable round')
  assert.equal(sandbox.events.includes('overlay'), false, 'and it stacks no prompt')
  assert.ok(!js.includes("location.replace('/disconnected');return}unreachableStreak"), 'the 401 return is not decorated')
})

test('the eight-second live-status exemption is still there (it is anti-flicker)', async () => {
  let calls = 0
  const sandbox = buildConnectionSandbox({
    fetch: async () => {
      calls += 1
      return { ok: true, status: 200, json: async () => ({}) }
    },
  })
  sandbox.lastLiveStatusAt = Date.now()
  await sandbox.checkConnection()
  assert.equal(calls, 0, 'a live status frame suppresses the poll')
})

test('a healthy poll does not shout over a standing stream notice', async () => {
  const sandbox = buildConnectionSandbox({ fetch: statusReply({ ok: true, status: 200, body: { settings: null } }) })
  sandbox.streamDownNoticeShown = true
  await sandbox.checkConnection()
  assert.equal(sandbox.unreachableStreak, 0, 'the bridge answered, so the transport is not unreachable')
  assert.equal(sandbox.copy(), L.statusReconnecting, 'but the words still say 重连中')
})

test('the status poll leaves a standing notice alone instead of blanking it', async () => {
  const sandbox = buildConnectionSandbox({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) })
  // The outage itself puts the copy on screen, exactly as the page does: through the
  // notice, which is what flags it as the message a later poll must not erase.
  sandbox.notifyStreamDown()
  sandbox.containers.listError.textContent = '会话列表加载失败'
  assert.equal(sandbox.containers.reconnectBar.textContent, L.streamDownHost, 'the notice is on screen')
  await sandbox.checkConnection()
  assert.equal(sandbox.containers.reconnectBar.textContent, L.streamDownHost, 'the outage poll leaves it alone')
  assert.equal(sandbox.streamDownNoticeShown, true, 'and the page still treats the drop as latched')
  assert.equal(sandbox.containers.listError.textContent, '', 'an ordinary list error is still cleared')
})

// ------------------------------------------------------------------------ AC-C3 (X2)

const staleLine = () => js.match(/const SSE_KEEPALIVE_MS=[^\n]*/)[0]

/**
 * RC-8 (2026-10-02 rescan): the page script cannot import `lib/constants.js` (it is
 * rendered into a `script` element as text), so the copy is technically
 * necessary. What was wrong is that this file pinned the COPY as a literal —
 * `assert.match(staleLine(), /const SSE_KEEPALIVE_MS=15000,.../)` — so changing
 * `SSE_KEEPALIVE_MS` in `lib/constants.js` would move the server keepalive
 * without moving the client watchdog, and every test stayed green. These helpers
 * parse the page's number and compare it to the constant instead.
 */
const pageKeepaliveMs = () => {
  const match = staleLine().match(/const SSE_KEEPALIVE_MS=(\d+)/)
  assert.ok(match, `the page must define its keepalive period; got ${JSON.stringify(staleLine())}`)
  return Number(match[1])
}
const pageStaleMultiplier = () => {
  const match = staleLine().match(/STREAM_STALE_MS=SSE_KEEPALIVE_MS\*(\d+)/)
  assert.ok(match, `the page threshold must be a multiple of its keepalive; got ${JSON.stringify(staleLine())}`)
  return Number(match[1])
}

test('AC-C3 every frame branch refreshes the staleness clock', () => {
  const open = between('function openSessionStream(sessionId)', 'async function showSessionList()')
  for (const branch of ['snapshot', 'event', 'token']) {
    const start = open.indexOf(`source.addEventListener('${branch}'`)
    assert.notEqual(start, -1, `the ${branch} listener must exist`)
    const next = open.indexOf("source.addEventListener('", start + 10)
    const slice = open.slice(start, next === -1 ? open.length : next)
    assert.ok(slice.includes('lastStreamFrameAt=Date.now()'), `the ${branch} listener must feed the clock`)
    assert.ok(slice.includes('noteStreamRecovery()'), `the ${branch} listener must also close the latch`)
  }
  // The status frame is the only periodic frame a healthy idle chat receives, so it
  // feeds the clock too — otherwise the watchdog would fire on every quiet conversation.
  const status = between("source.addEventListener('status'", "source.addEventListener('snapshot'")
  assert.ok(status.includes('lastStreamFrameAt=Date.now()'), 'the status branch feeds the clock as well')
})

test('AC-C3 the threshold is a multiple of the server keepalive period', () => {
  // RC-8: the copy is pinned to the CONSTANT, not to the digits it happened to
  // hold on the day this test was written.
  assert.equal(
    pageKeepaliveMs(),
    SSE_KEEPALIVE_MS,
    `the page copy must track lib/constants.js SSE_KEEPALIVE_MS (${SSE_KEEPALIVE_MS}); got ${pageKeepaliveMs()}`
  )
  assert.match(staleLine(), /const SSE_KEEPALIVE_MS=\d+,STREAM_STALE_MS=SSE_KEEPALIVE_MS\*\d+/, 'and the threshold is still expressed as a multiple')
  assert.ok(js.includes('},SSE_KEEPALIVE_MS)}'), 'the watch ticks on the keepalive period')
  // Deviation registered in the handoff: two keepalive cycles (30s) is the same length
  // as the status frame the page can actually see (lib/constants.js SSE_STATUS_MS), so
  // it would tear down every healthy idle chat twice a minute.
  const multiplier = pageStaleMultiplier()
  assert.ok(multiplier >= 4, `threshold must cover two status cycles, got ${multiplier} keepalive periods`)
  // RC-8 invariant: the threshold has to outlast at least two status frames,
  // otherwise a healthy idle chat is torn down. Derived from the constants, so a
  // change to either number is caught here rather than on a phone.
  const staleMs = pageKeepaliveMs() * multiplier
  assert.ok(
    staleMs >= SSE_STATUS_MS * 2,
    `the stale threshold (${staleMs}ms) must outlast two status frames (${SSE_STATUS_MS * 2}ms)`
  )
})

function buildStaleSandbox({ hidden = false, clock = 1_000 } = {}) {
  const containers = fakeContainers()
  const world = { clock, tick: null, calls: [], retryAt: null, retry: null }
  const body = ['streamDownCopy', 'paintStreamDown', 'notifyStreamDown', 'noteStreamRecovery', 'setStatusCopy', 'clearStreamStaleWatch', 'armStreamRetry', 'armStreamStaleWatch']
    .map((name) => extractFunction(js, name))
    .join('\n')
  const make = new Function(
    'containers',
    'document',
    'Date',
    'setInterval',
    'clearInterval',
    'setTimeout',
    'clearTimeout',
    'closeSessionStream',
    'schedulePoll',
    'openSessionStream',
    'world',
    `
    let activeSession='s1',streamConnected=true,sessionStream=null,lastStreamFrameAt=0,streamDownNoticeShown=false,streamDownGraceTimer=null,streamDownRearmAt=0,streamStaleTimer=null,streamRetryTimer=null,tunnelLinkActive=false,importantErrorActive=false
    const STREAM_DOWN_GRACE_MS=8000,STREAM_DOWN_COOLDOWN_MS=${NOTICE_COOLDOWN_MS},STREAM_DOWN_STABLE_MS=${NOTICE_STABLE_MS}
    ${staleLine()}
    const L=${JSON.stringify(L)}
    const $=(id)=>containers[id]
    function isStreamDownCopy(){return false}
    function importantChatCopy(){return false}
    ${body}
    return {
      armStreamStaleWatch,
      tick(){ if(typeof world.tick==='function') world.tick() },
      runRetry(){ if(typeof world.retry==='function') world.retry() },
      state: () => ({ lastStreamFrameAt, streamDownNoticeShown, armed: streamStaleTimer !== null, retryScheduled: world.retryAt !== null }),
    }
  `,
  )
  const sandbox = make(
    containers,
    { hidden },
    { now: () => world.clock },
    (callback) => { world.tick = callback; return 1 },
    () => { world.tick = null },
    // Short timers (the 8s reconnect grace) run at once so the stale drop still paints
    // the bar synchronously; the retry stays pending for the test to fire by hand.
    // The 8s grace runs at once here, and null is the handle production is left holding
    // once its callback has fired — returning an id would leave this sandbox claiming a
    // timer is still armed when the page has none.
    (callback, ms) => { if ((ms || 0) < 10000) { callback(); return null } world.retry = callback; world.retryAt = ms; return 2 },
    () => { world.retry = null; world.retryAt = null },
    () => world.calls.push('closeSessionStream'),
    () => world.calls.push('schedulePoll'),
    () => world.calls.push('openSessionStream'),
    world,
  )
  sandbox.world = world
  sandbox.containers = containers
  return sandbox
}

test('AC-C3 a half-open stream is dropped to the poll and reported once', () => {
  const sandbox = buildStaleSandbox()
  sandbox.armStreamStaleWatch('s1')
  assert.equal(typeof sandbox.world.tick, 'function', 'opening a stream arms the watch')
  assert.equal(sandbox.state().armed, true)
  sandbox.world.clock = 16_000
  sandbox.tick()
  assert.deepEqual(sandbox.world.calls, [], 'one keepalive period of silence is normal')
  sandbox.world.clock = 31_000
  sandbox.tick()
  assert.deepEqual(sandbox.world.calls, [], 'two periods is still normal — the page cannot see a ping')
  sandbox.world.clock = 61_001
  sandbox.tick()
  assert.deepEqual(sandbox.world.calls, ['closeSessionStream', 'schedulePoll'], 'beyond the threshold the stream yields to the poll')
  assert.equal(sandbox.containers.reconnectBar.textContent, L.streamDownHost, 'and the reason is on screen (the top bar, W4 separation)')
  assert.equal(sandbox.containers.chatError.textContent, '', 'the error banner stays free of the reconnect copy')
  assert.equal(sandbox.containers.statusText.textContent, L.statusReconnecting, 'and the dot says so too')
  assert.equal(sandbox.state().streamDownNoticeShown, true, 'the latch is what keeps it to one notice')
  // The line promises a retry, so one has to be scheduled — on the stale bound, not sooner.
  assert.equal(sandbox.state().retryScheduled, true, 'the downgrade arms a retry')
  assert.equal(sandbox.world.retryAt, 60_000, 'at the stale threshold as its cadence')
  sandbox.runRetry()
  assert.deepEqual(sandbox.world.calls, ['closeSessionStream', 'schedulePoll', 'openSessionStream'], 'and the retry re-opens the stream')
  // The interval itself is taken down by closeSessionStream — asserted separately at
  // source level below, because the stub here stands in for that function.
})

test('AC-C3 the retry does not fire on another session or a hidden tab', () => {
  const hidden = buildStaleSandbox({ hidden: true })
  hidden.armStreamStaleWatch('s1')
  hidden.world.clock = 61_001
  hidden.tick()
  assert.deepEqual(hidden.world.calls, [], 'a hidden tab is not declared stale')
  assert.equal(hidden.state().retryScheduled, false, 'and nothing is scheduled behind it')
})

test('AC-C3 closing the stream disarms the watch, so it cannot repeat', () => {
  const closing = between('function closeSessionStream(', 'function applyHistory(')
  assert.ok(closing.includes('clearStreamStaleWatch();'), 'no orphan interval after a session leaves')
  const armed = between('function armStreamStaleWatch(sessionId)', 'function showTranscriptRetry()', js)
  assert.ok(armed.startsWith('function armStreamStaleWatch(sessionId){clearStreamStaleWatch();'), 'and re-arming replaces the old watch')
})

test('AC-C3 a backgrounded tab holds the clock instead of reporting a false drop', () => {
  const watching = between('function armStreamStaleWatch(sessionId)', 'function loadingShell()')
  assert.ok(watching.includes('if(document.hidden){lastStreamFrameAt=Date.now();return}'), 'hidden means no verdict')
})

// --------------------------------------------------------------------- AC-D4 (X3-2)

test('AC-D4 a disconnect and a snapshot both drop the half-finished token bubble', () => {
  const onError = between('source.onerror=()=>{', 'armStreamStaleWatch(sessionId)')
  assert.ok(onError.includes('tokenStream=null'), 'otherwise a reconnect appends a second copy of the answer')
  assert.ok(onError.includes('notifyStreamDown()'), 'and the drop is finally visible')
  const snapshot = between("source.addEventListener('snapshot'", "source.addEventListener('event'")
  assert.ok(snapshot.includes('tokenStream=null'), 'a durable snapshot must not leave the partial behind')
})

// ----------------------------------------------------------------------- AC-X2 (X3-1)



// -------------------------------------- 三条更早消息的路径必须同构（WP-A1 残留不对称）

test('the pull gesture gates on the same condition as the button and the auto fill', () => {
  const gesture = between("box.addEventListener('touchstart'", "box.addEventListener('touchmove'")
  assert.ok(
    gesture.includes('if(!olderHasMore&&!olderEvents.length&&transcriptHasContent())return'),
    'an empty transcript must be allowed to start a pull',
  )
  assert.ok(!gesture.includes('if(!olderHasMore&&!olderEvents.length)return'), 'the old veto is gone')
  const row = between('function olderButtonHtml()', 'function paintMessages(')
  assert.ok(row.includes('if(!olderHasMore&&!olderEvents.length&&transcriptHasContent())return'), 'same gate as the older row')
  const fill = between('async function ensureTranscriptFilled()', 'function oldestEventSeq()')
  assert.ok(fill.includes('if(!olderHasMore&&transcriptHasContent())return'), 'and the auto fill agrees')
  assert.ok(fill.includes('(olderHasMore||!transcriptHasContent())'), 'the fill loop keeps running while nothing is painted')
})

// ------------------------------------------------------------------ X4-9 errorCode

function buildRpcSandbox(response) {
  const codesLine = js.match(/const BRIDGE_TRANSPORT_CODES=[^\n]*/)[0]
  const source = 'async ' + extractUntil('rpc', '// A dropped stream')
  const make = new Function('fetch', 'setTimeout', 'clearTimeout', `
    const L=${JSON.stringify(L)}
    const RPC_TIMEOUT_MS=12000,RPC_SLOW_TIMEOUT_MS=180000
    ${codesLine}
    ${extractFunction(js, 'rpcFailure')}
    ${source}
    return rpc
  `)
  return make(
    async () => response,
    () => 0,
    () => {},
  )
}

const rpcReply = (status, body, { broken = false } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => {
    if (broken) throw new TypeError('Unexpected token')
    return body
  },
})

test('the rpc consumer reads errorCode and names the transport family', async () => {
  const rpc = buildRpcSandbox(rpcReply(502, { ok: false, error: 'Harness is not reachable.', errorCode: '__bridge/transport' }))
  await assert.rejects(
    () => rpc('session.history', { sessionId: 's1' }),
    (error) => {
      assert.equal(error.message, L.streamDownHost, 'a desktop that cannot be reached is not a generic failure')
      assert.equal(error.errorCode, '__bridge/transport', 'and the code is carried for whoever asks next')
      return true
    },
  )
})

test('an unknown code keeps the bridge own words, and no code keeps the old copy', async () => {
  const refused = buildRpcSandbox(rpcReply(400, { ok: false, error: 'sessionId must be a string.', errorCode: '__bridge/invalid-arguments' }))
  await assert.rejects(
    () => refused('session.history', {}),
    (error) => {
      assert.equal(error.message, 'sessionId must be a string.', 'the bridge prose stays the answer')
      assert.equal(error.errorCode, '__bridge/invalid-arguments')
      return true
    },
  )
  const legacy = buildRpcSandbox(rpcReply(400, { ok: false, error: 'Session id is required.' }))
  await assert.rejects(() => legacy('session.history', {}), (error) => error.message === 'Session id is required.')
  const plain = buildRpcSandbox(rpcReply(400, {}, { broken: true }))
  await assert.rejects(() => plain('session.history', {}), (error) => error.message === L.failed, 'a body that is not json still falls back')
  const down = buildRpcSandbox(rpcReply(503, {}, { broken: true }))
  await assert.rejects(() => down('session.history', {}), (error) => error.message === L.streamDownHost, 'a plain-text 503 is the desktop family')
})

test('a successful rpc still returns its value and a 401 is still a disconnect', async () => {
  const ok = buildRpcSandbox(rpcReply(200, { ok: true, value: { events: [1] } }))
  assert.deepEqual(await ok('session.history', {}), { events: [1] })
  const unauthorized = buildRpcSandbox(rpcReply(401, { ok: false, error: 'Pair your phone again.' }))
  await assert.rejects(() => unauthorized('session.history', {}), (error) => error.disconnected === true, 'the 401 path is unchanged')
})

test('the page reads errorCode at all (the audit claimed zero consumers)', () => {
  assert.ok(js.includes('body?.errorCode'), 'rpcFailure reads the field')
  assert.ok(!js.includes("throw new Error(j.error||L.failed)"), 'the old collapse is gone')
})

// ------------------------------------- R1-audit P0 (change 2026-10-04-fix-pocket-r1-audit-batch)
//
// The token listener shipped referencing an undeclared `frame`, and the whole SSE
// suite above only ever COMPARED its text — the gap that let the P0 reach the
// baseline. These tests execute the real openSessionStream body (buildStaleSandbox
// house shape): the constructor's `new EventSource(...)` is injected as a fake that
// captures the registered listeners and replays frames synchronously, so a throw
// inside a listener escapes dispatch() and fails the test instead of hiding.

function buildStreamSandbox() {
  const containers = fakeContainers()
  const world = { sources: [], calls: { render: 0, sync: 0, loadHistory: 0 } }
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.handlers = Object.create(null)
      world.sources.push(this)
    }
    addEventListener(type, fn) {
      ;(this.handlers[type] ??= []).push(fn)
    }
    dispatch(type, data) {
      for (const fn of this.handlers[type] ?? []) fn({ data })
    }
    close() {}
  }
  const open = between('function openSessionStream(sessionId)', 'async function showSessionList()')
  const make = new Function(
    'EventSource',
    'world',
    `
    let activeSession='s1',sessionStream=null,tokenStream=null,streamConnected=false
    let streamEvents=[],streamProjections=null,streamRevision=0,lastStreamFrameAt=0
    let pendingQuestion=null
    const STREAM_EVENTS_CAP=400
    function armStreamSnapshot(){}
    function streamWatermark(){return -1}
    function subagentQuery(){return ''}
    function noteStreamRecovery(){}
    function applyLiveStatus(){}
    function mergeEntries(list){return list.slice()}
    function applyHistory(){}
    function markStreamSnapshot(){}
    function showSessionModel(){}
    function queueStreamRender(){world.calls.render+=1}
    function schedulePendingSync(){world.calls.sync+=1}
    function scheduleProjectionsSync(){}
    function loadHistory(){world.calls.loadHistory+=1}
    function showError(){}
    function streamFailureCopy(){return 'stream failed'}
    function notifyStreamDown(){}
    function schedulePoll(){}
    function armStreamStaleWatch(){}
    ${extractFunction(js, 'tokenChunkText')}
    // W4: the SSE listeners delegate to the shared frame bodies, so the sandbox needs
    // the real organs (and their watermark read) to keep exercising the same path.
    ${extractFunction(js, 'eventSeq')}
    const streamWatermarks=new Map()
    ${extractFunction(js, 'streamWatermark')}
    ${extractFunction(js, 'applyTokenFrame')}
    ${extractFunction(js, 'applyStreamEventFrame')}
    ${open}
    return {
      openSessionStream,
      get tokenStream(){return tokenStream},
      get streamEvents(){return streamEvents},
      get lastStreamFrameAt(){return lastStreamFrameAt},
      set activeSession(value){activeSession=value},
    }
  `,
  )
  const sandbox = make(FakeEventSource, world)
  sandbox.world = world
  sandbox.containers = containers
  return sandbox
}

test('R1-audit P0 the token listener really runs: start builds the bubble, chunk appends, end clears', () => {
  const sandbox = buildStreamSandbox()
  sandbox.openSessionStream('s1')
  const source = sandbox.world.sources.at(-1)
  assert.ok(source, 'the stream source was constructed')
  assert.match(source.url, /sessionId=s1/, 'the stream targets the opened session')

  source.dispatch('token', JSON.stringify({ type: 'start', revision: 1 }))
  assert.ok(sandbox.tokenStream, 'start builds the token bubble')
  assert.equal(sandbox.tokenStream.revision, 1)

  source.dispatch('token', JSON.stringify({ type: 'chunk', revision: 1, index: 0, chunk: '你' }))
  assert.equal(sandbox.tokenStream.text, '你', 'the chunk lands in the bubble text')
  assert.equal(sandbox.world.calls.render, 1, 'a render is queued for the new text')

  source.dispatch('token', JSON.stringify({ type: 'chunk', revision: 1, index: 0, chunk: '你' }))
  assert.equal(sandbox.tokenStream.text, '你', 'a replayed index is deduped, not appended twice')

  source.dispatch('token', JSON.stringify({ type: 'end', outcome: { kind: 'done' } }))
  assert.equal(sandbox.tokenStream, null, 'end clears the bubble')
  assert.equal(sandbox.world.calls.loadHistory, 0, 'a finished turn needs no history reload')
  assert.ok(sandbox.lastStreamFrameAt > 0, 'and every frame fed the staleness clock')
})

test('R1-audit P0 an abandoned turn drops the bubble and reloads the durable history', () => {
  const sandbox = buildStreamSandbox()
  sandbox.openSessionStream('s1')
  const source = sandbox.world.sources.at(-1)
  source.dispatch('token', JSON.stringify({ type: 'chunk', revision: 2, index: 0, chunk: '半截' }))
  source.dispatch('token', JSON.stringify({ type: 'end', outcome: { kind: 'abandoned' } }))
  assert.equal(sandbox.tokenStream, null, 'the half answer goes')
  assert.equal(sandbox.world.calls.loadHistory, 1, 'the durable record is pulled back')
})

test('R1-audit P0 frames for another session are ignored before any state changes', () => {
  const sandbox = buildStreamSandbox()
  sandbox.openSessionStream('s1')
  const source = sandbox.world.sources.at(-1)
  sandbox.activeSession = 's2'
  source.dispatch('token', JSON.stringify({ type: 'start', revision: 1 }))
  assert.equal(sandbox.tokenStream, null, 'the gating return runs first')
})

test('R1-audit P0 a corrupt snapshot or event frame is dropped, not fatal (item 5)', () => {
  const sandbox = buildStreamSandbox()
  sandbox.openSessionStream('s1')
  const source = sandbox.world.sources.at(-1)

  assert.doesNotThrow(() => source.dispatch('snapshot', 'not-json'), 'a corrupt snapshot frame must not throw')
  assert.equal(sandbox.streamEvents.length, 0, 'the frame is dropped whole')

  assert.doesNotThrow(() => source.dispatch('event', '{"event":'), 'a corrupt event frame must not throw')
  assert.equal(sandbox.streamEvents.length, 0, 'and the buffer is untouched')

  // A well-formed frame still gets through afterwards, so the drop is per-frame.
  assert.doesNotThrow(() => source.dispatch('event', JSON.stringify({ event: { type: 'model/selection' } })))
  assert.equal(sandbox.streamEvents.length, 1, 'the next good frame still lands')
})

// R1 reflux (change 2026-10-07-fix-pocket-r1-reflux-batch, item 2): the :empty
// collapse rule is what keeps an idle chat free of a phantom banner block —
// #chatError is position:fixed, so an uncollapsed empty element still occupies
// its slot above the composer. Structural lock for cd23147.
test('the empty #chatError banner is display:none by structural rule (cd23147 lock)', () => {
  const { css } = mobilePageAssets({ locale: 'zh' })
  assert.ok(
    css.includes('#chatError:empty{display:none}'),
    'an empty #chatError must collapse via the :empty rule — losing it resurrects the phantom banner block',
  )
})

// 2026-10-07-fix-pocket-banner-dismiss-and-ttl: the notice's third exit. The 90s
// deadline is armed inside showError itself, so this sandbox owns a fake clock to
// prove three things the browser gate cannot: that a timer is really scheduled, that
// firing it clears a standing notice, and that a newer notice is not killed by the
// older one's deadline.
function buildDeadlineSandbox() {
  const containers = fakeContainers()
  containers.chatError.getBoundingClientRect = () => ({ left: 60, right: 300, top: 700, bottom: 738, width: 240, height: 38 })
  const body = [...NOTICE_ORGANS, 'dismissChatNotice'].map((name) => extractFunction(js, name)).join('\n')
  let sandbox = null
  const make = new Function(
    'containers',
    'document',
    'setTimeout',
    `
    ${NOTICE_STATE()}
    let chatErrorTapZone=true
    const timers=[]
    ${body}
    return {
      showError, clearTransientError, dismissChatNotice, containers,
      get importantErrorActive(){return importantErrorActive},
      timers,
    }
  `,
  )
  // Node's timer handle carries unref(); the page feature-detects it (so a test process is
  // not held open by a 90s deadline), so the fake has to expose one to look like the host.
  // Short timers (the 8s reconnect grace) run at once and are not recorded — the deadline
  // assertions below are about the 90s one, which stays pending for the test to fire.
  sandbox = make(containers, { hidden: false }, (fn, delay) => {
    if ((delay || 0) < 10000) { fn(); return { unref() { return this } } }
    sandbox.timers.push({ fn, delay })
    return { unref() { return this } }
  })
  return sandbox
}

// W4 separation note: these three used to arm the deadline through a {disconnected}
// error; that copy moved to the reconnect bar (which has no deadline — it exits when
// recovery proves itself), so the deadline contract now runs on a standing IMPORTANT
// error, which is the same code path the deadline was built for.
const standingError = () => ({ message: `${L.streamFailure} (DEADLINE)`, important: true })

test('the standing notice carries a 90s deadline, and firing it retires the notice', () => {
  const sandbox = buildDeadlineSandbox()
  assert.equal(sandbox.timers.length, 0, 'writing a plain error arms no deadline')
  sandbox.showError('chatError', standingError())
  assert.equal(sandbox.containers.chatError.textContent, `${L.streamFailure} (DEADLINE)`)
  assert.equal(sandbox.timers.length, 1, 'a standing notice must arm exactly one deadline')
  assert.equal(sandbox.timers[0].delay, 90000, 'and it must be the page own 90s, not an inherited default')
  sandbox.timers[0].fn()
  assert.equal(sandbox.containers.chatError.textContent, '', 'the deadline must retire the notice it was armed for')
  assert.equal(sandbox.importantErrorActive, false, 'and must drop the flag the frame path also owns')
  assert.equal(sandbox.containers.statusText.textContent, L.statusConnected, 'and restore the status copy')
})

test('a deadline never kills a notice written after it', () => {
  const sandbox = buildDeadlineSandbox()
  sandbox.showError('chatError', standingError())
  sandbox.showError('chatError', { message: '第二轮失败', important: true })
  assert.equal(sandbox.timers.length, 2, 'each standing paint arms its own deadline')
  sandbox.timers[0].fn()
  assert.equal(sandbox.containers.chatError.textContent, '第二轮失败',
    'the older deadline must leave a newer copy standing (the reader has not read it yet)')
})

test('a banner already gone stays gone when its deadline fires', () => {
  const sandbox = buildDeadlineSandbox()
  sandbox.showError('chatError', standingError())
  assert.equal(sandbox.timers.length, 1)
  sandbox.dismissChatNotice(sandbox.containers.chatError, { clientX: 296 })
  assert.equal(sandbox.containers.chatError.textContent, '', 'the tap is the second exit')
  assert.doesNotThrow(() => sandbox.timers[0].fn(), 'the deadline must tolerate a banner that already left')
  assert.equal(sandbox.containers.chatError.textContent, '')
})

// W4 (fix-pocket-disconnect-copy): a disconnect still opens the bar, but it arms no
// deadline and sets no guard — its exits are the recovery frame and nothing else.
test('a disconnect writes the bar and arms no deadline at all', () => {
  const sandbox = buildDeadlineSandbox()
  sandbox.showError('chatError', { disconnected: true })
  assert.equal(sandbox.containers.reconnectBar.textContent, L.disconnectedRetry, 'the bar carries the copy')
  assert.equal(sandbox.containers.chatError.textContent, '', 'and the banner stays empty')
  assert.equal(sandbox.timers.length, 0, 'no 90s deadline for a reconnect notice')
})
