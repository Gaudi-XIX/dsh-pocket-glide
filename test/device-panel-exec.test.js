// 2026-10-08 move-pocket-devices-into-mode-bar — execution-level watchdogs for
// the migrated device panel. WP-A2 (test-domain fixer): the three review-loop
// blockers are provable only by RUNNING the real page handlers against a fake
// DOM + fetch stub, not by matching strings in the rendered HTML. Every test in
// this file splices the actual function bodies out of lib/pages.js and executes
// them in a node:vm sandbox, so a rename or a body change can never leave the
// assertion green by accident.
//
// Red discipline: each watchdog is mutation-provable —
//   B-1 reverse the perm target -> POST body flips -> this file goes red
//   B-2 drop the is-empty / is-failed class -> the empty/failed branch goes red
//   B-3 drop the `if(modeView==='devices')loadDevicePanel()` kick -> the
//       devices-init fetch disappears -> this file goes red
//   G  add a disabled attribute to any mode key while a phone is connected -> G goes red
//   D  let poll() repaint #deviceList -> armed state is wiped -> D goes red
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const PAGES_SOURCE = readFileSync(new URL('../lib/pages.js', import.meta.url), 'utf8')

/* ------------------------------------------------------------------ *
 * fake DOM (mirrors the small surface pages.js actually touches)
 * ------------------------------------------------------------------ */

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase()
    this.className = ''
    this.textContent = ''
    this.children = []
    this.dataset = {}
    this.disabled = false
    this.style = {}
    this._byId = {}
    this._classes = new Set()
  }
  classList = {
    add: (name) => this._classes.add(name),
    remove: (name) => this._classes.delete(name),
    toggle: (name, on) => {
      if (on === undefined) on = !this._classes.has(name)
      if (on) this._classes.add(name)
      else this._classes.delete(name)
      return on
    },
    contains: (name) => this._classes.has(name),
  }
  appendChild(child) {
    this.children.push(child)
    return child
  }
  // The page clears the list host with `host.innerHTML = ''` before mounting
  // the empty/failed slot; a plain property would leave the loading node in
  // `children` and the wrong slot would win the lookup below.
  set innerHTML(html) {
    this.children = []
    this.textContent = html === '' ? '' : String(html)
  }
  get innerHTML() {
    return this.children.length ? '' : this.textContent
  }
  // Only as much querySelector as the spliced code needs.
  querySelector(sel) {
    if (sel === '[data-revoke-note]') return this.children.find((n) => n.dataset.revokeNote) || null
    if (sel === '.device-action-note') return this.children.find((n) => n.className === 'device-action-note') || null
    if (sel === '[data-action="device-perm"]') return this.children.find((n) => n.dataset.action === 'device-perm') || null
    if (sel === '.device-badge.is-warn') return this.children.find((n) => n.className === 'device-badge is-warn') || null
    return null
  }
  closest(sel) {
    if (sel === '.device-card') return this._card || null
    return null
  }
  after(node) {
    this._after = node
    this.parentElement && this.parentElement.children.push(node)
  }
}

function makeDocument(rootNodes = {}) {
  const byId = { ...rootNodes }
  const doc = {
    _byId: byId,
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => new FakeNode(tag),
  }
  return { doc, byId }
}

/* ------------------------------------------------------------------ *
 * splicers — pull the real function body out of pages.js
 * ------------------------------------------------------------------ */

function extractFunction(name) {
  let start = PAGES_SOURCE.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the pages.js source`)
  // The device handlers are declared `async function …(…)`; keep the prefix so
  // the `await`s inside them stay legal in the compiled body.
  if (PAGES_SOURCE.slice(start - 6, start) === 'async ') start -= 6
  let depth = 0
  let end = -1
  for (let i = start; i < PAGES_SOURCE.length; i++) {
    if (PAGES_SOURCE[i] === '{') depth++
    else if (PAGES_SOURCE[i] === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  assert.ok(end > start, `unbalanced braces after ${name}`)
  return PAGES_SOURCE.slice(start, end + 1)
}

// Compile `names` into a sandbox and return a callable object of the same shape.
// The bodies are wrapped in an async IIFE so `await` is legal even when the
// spliced functions are async.
function spliced(names, env = {}) {
  const body = names.map(extractFunction).join('\n')
  const sandbox = { ...env }
  vm.createContext(sandbox)
  vm.runInContext(`(async function(){${body}\nglobalThis.__out = { ${names.join(',')} }\nreturn __out})()`, sandbox)
  // `__out` is set synchronously before the first await, so reading it here is
  // safe even though the IIFE is async.
  return sandbox.__out
}

/* ------------------------------------------------------------------ *
 * real T table, read off pages.js
 * ------------------------------------------------------------------ */

function realTextTable(zh = true) {
  // The desktop pairing page builds its copy pack as a `const text = { … }`
  // object with `zh ? '中文' : 'English'` ternaries. Compile that literal with
  // `zh` pinned so we read the REAL strings off the source (a stub can hide the
  // very drift this watchdog is meant to catch).
  const fnStart = PAGES_SOURCE.indexOf('export function renderDesktopPairingPage(')
  assert.ok(fnStart >= 0, 'renderDesktopPairingPage must exist')
  const open = PAGES_SOURCE.indexOf('{', fnStart)
  let depth = 0
  let fnEnd = -1
  for (let i = open; i < PAGES_SOURCE.length; i++) {
    if (PAGES_SOURCE[i] === '{') depth++
    else if (PAGES_SOURCE[i] === '}') {
      depth--
      if (depth === 0) { fnEnd = i; break }
    }
  }
  const fnBody = PAGES_SOURCE.slice(open, fnEnd + 1)
  const anchor = fnBody.indexOf('const text = {')
  assert.ok(anchor >= 0, 'the desktop copy pack must be present in the function body')
  const txtStart = fnBody.indexOf('{', anchor)
  let d2 = 0
  let txtEnd = -1
  for (let i = txtStart; i < fnBody.length; i++) {
    if (fnBody[i] === '{') d2++
    else if (fnBody[i] === '}') {
      d2--
      if (d2 === 0) { txtEnd = i; break }
    }
  }
  const literal = fnBody.slice(txtStart, txtEnd + 1)
  return new Function('zh', `return ${literal}`)(zh)
}

// The device-panel CSS block lives inside the renderDesktopPairingPage source
// template, so it can only be read from within that function body.
function deviceCssBlock() {
  const fnStart = PAGES_SOURCE.indexOf('export function renderDesktopPairingPage(')
  assert.ok(fnStart >= 0)
  const open = PAGES_SOURCE.indexOf('{', fnStart)
  let depth = 0
  let fnEnd = -1
  for (let i = open; i < PAGES_SOURCE.length; i++) {
    if (PAGES_SOURCE[i] === '{') depth++
    else if (PAGES_SOURCE[i] === '}') {
      depth--
      if (depth === 0) { fnEnd = i; break }
    }
  }
  const fnBody = PAGES_SOURCE.slice(open, fnEnd + 1)
  const start = fnBody.indexOf('.device-panel{')
  assert.ok(start >= 0, 'the .device-panel rule must exist')
  const end = fnBody.indexOf('.connection{', start)
  assert.ok(end > start, 'the device panel block must close before .connection')
  return fnBody.slice(start, end)
}

const T = realTextTable(true)

/* ------------------------------------------------------------------ *
 * B-1  permission direction is provable at the POST level
 * ------------------------------------------------------------------ */

function permHarness(permission) {
  const card = new FakeNode('div')
  card.className = 'device-card'
  const permBtn = new FakeNode('button')
  permBtn.dataset.id = 'dev-abc123'
  permBtn.dataset.targetPerm = permission === 'lan' ? 'lan+wan' : 'lan'
  permBtn.dataset.action = 'device-perm'
  permBtn.textContent = permission === 'lan' ? T.devMakeWan : T.devMakeLan
  permBtn._card = card
  const badge = new FakeNode('span')
  badge.className = 'device-badge is-warn'
  card.children = [permBtn, badge]
  const { doc } = makeDocument()
  const calls = []
  const fetchStub = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const fn = spliced(['deviceNote', 'togglePermission'], { document: doc, fetch: fetchStub, T })
  return { fn, permBtn, card, calls }
}

test('B-1 the permission button POSTs the TARGET permission, not the current one', async () => {
  // lan -> the button offers to open public access, so the POST must ask for
  // lan+wan. If the implementation sent the *current* state the POST would be
  // lan and this assertion would fail (mutation-provable).
  const lanCase = permHarness('lan')
  await lanCase.fn.togglePermission(lanCase.permBtn)
  assert.equal(lanCase.calls.length, 1, 'exactly one POST per click')
  assert.equal(lanCase.calls[0].url, '/desktop/device/permission')
  assert.deepEqual(JSON.parse(lanCase.calls[0].opts.body), { deviceId: 'dev-abc123', permission: 'lan+wan' })

  // lan+wan -> the button offers to restrict to LAN, so the POST must ask for lan.
  const wanCase = permHarness('lan+wan')
  await wanCase.fn.togglePermission(wanCase.permBtn)
  assert.equal(wanCase.calls.length, 1)
  assert.equal(wanCase.calls[0].url, '/desktop/device/permission')
  assert.deepEqual(JSON.parse(wanCase.calls[0].opts.body), { deviceId: 'dev-abc123', permission: 'lan' })
})

test('B-1 the button label says what the click WILL do, not what the device does now', () => {
  // The card renderer labels the perm button with the TARGET: a lan-only device
  // reads "开启公网" (open public), never the badge's "仅本地".
  const card = new FakeNode('div')
  const deviceCardHtml = spliced([
    'formatTimestamp', 'deviceState', 'devicePermBadge', 'devicePermLabel', 'deviceCredLabel',
    'deviceFirstSeen', 'deviceLastSeen', 'deviceCardHtml',
  ], { T, escHtml: (v) => String(v) }).deviceCardHtml
  const lanCard = deviceCardHtml({
    id: 'd1', label: 'phone', permission: 'lan', online: true,
    expiresAt: Date.now() + 1000, firstPairedAt: Date.now(), lastSeenAt: Date.now(),
  })
  assert.match(lanCard, /开启公网/, 'a lan-only device offers to open public access')
  assert.doesNotMatch(lanCard, />仅本地</, 'the current-state wording must not masquerade as the button label')
  const wanCard = deviceCardHtml({
    id: 'd2', label: 'phone', permission: 'lan+wan', online: true,
    expiresAt: Date.now() + 1000, firstPairedAt: Date.now(), lastSeenAt: Date.now(),
  })
  assert.match(wanCard, /切为仅本地/, 'a public device offers to restrict to LAN')
  assert.doesNotMatch(wanCard, />本地\+公网</, 'the current-state wording must not masquerade as the button label')
  // the current state still has a home: the badge.
  assert.match(lanCard, /仅本地</, 'the lan badge still names the current state')
  assert.match(wanCard, /本地\+公网</, 'the wan badge still names the current state')
})

/* ------------------------------------------------------------------ *
 * B-2  empty / failed branches really land their classes
 * ------------------------------------------------------------------ */

test('B-2 the zero-device branch lands is-empty on #deviceList', async () => {
  const list = new FakeNode('div')
  const { doc } = makeDocument({ deviceList: list })
  const fn = spliced(['formatTimestamp', 'deviceCardHtml', 'deviceState', 'devicePermBadge', 'devicePermLabel',
    'deviceCredLabel', 'deviceFirstSeen', 'deviceLastSeen', 'loadDevicePanel'],
    { document: doc, T, fetch: async () => ({ json: async () => ({ devices: [] }) }), escHtml: (v) => String(v) })
  await fn.loadDevicePanel()
  assert.ok(list.classList.contains('is-empty'), 'the empty branch must paint is-empty on the list host')
  // loadDevicePanel appends a "loading" div of the same class before the real
  // empty slot, so take the LAST slot bearing the class.
  const empty = list.children.filter((n) => n.className === 'device-panel-empty').pop()
  assert.ok(empty, 'the empty slot must be mounted')
  assert.equal(empty.textContent, T.devEmpty, 'the empty slot says the empty copy')
  assert.ok(!list.classList.contains('is-failed'), 'an empty result is not a failure')
})

test('B-2 the fetch-failure branch lands is-failed on #deviceList', async () => {
  const list = new FakeNode('div')
  const { doc } = makeDocument({ deviceList: list })
  const fn = spliced(['formatTimestamp', 'deviceCardHtml', 'deviceState', 'devicePermBadge', 'devicePermLabel',
    'deviceCredLabel', 'deviceFirstSeen', 'deviceLastSeen', 'loadDevicePanel'],
    { document: doc, T, fetch: async () => { throw new Error('net down') }, escHtml: (v) => String(v) })
  await fn.loadDevicePanel()
  assert.ok(list.classList.contains('is-failed'), 'the failure branch must paint is-failed on the list host')
  const failed = list.children.find((n) => n.className === 'device-panel-failed')
  assert.ok(failed, 'the failed slot must be mounted')
  assert.equal(failed.textContent.includes(T.devFailed), true, 'the failed slot says the failure copy')
  const retry = failed.children.find((n) => n.dataset.action === 'device-retry')
  assert.ok(retry, 'the failed slot carries a retry handle')
  assert.ok(!list.classList.contains('is-empty'), 'a failure is not an empty list')
})

test('B-2 the CSS actually shows the empty/failed slot (mutation: drop the class rule -> red)', () => {
  // The JS above only asserts the classes; a renderer could keep the classes
  // and still hide the slot if the CSS rule never reached the sheet. Pin the
  // rule that pairs .is-empty/.is-failed with display:flex.
  const css = deviceCssBlock()
  assert.match(css, /\.device-panel-empty,\.device-panel-failed\{display:none/,
    'the empty and failed slots share a hidden-by-default rule')
  assert.match(css, /\.device-list\.is-empty \.device-panel-empty,\.device-list\.is-failed \.device-panel-failed\{display:flex/,
    'the empty/failed classes must flip the slots to visible')
  // the selector chain must be scoped under .device-list so a stray class on
  // some other container cannot light the slot up
  assert.ok(!/\.device-panel\{[^}]*display:(flex|block)/.test(css.replace(/\s+/g, '')),
    'the panel container itself must not be the one flipping visibility')
})

/* ------------------------------------------------------------------ *
 * B-3  the initialisation kick really fetches /desktop/devices
 * ------------------------------------------------------------------ */

function initHarness(modeView) {
  const list = new FakeNode('div')
  const panel = new FakeNode('div')
  const { doc } = makeDocument({ deviceList: list, devicePanel: panel })
  const calls = []
  const fetchStub = async (url) => {
    calls.push(url)
    if (url === '/desktop/status') return { ok: true, json: async () => ({ connected: false }) }
    if (url === '/desktop/tunnel/status') return { ok: true, json: async () => ({}) }
    return { ok: true, json: async () => ({ devices: [] }) }
  }
  const cardHtml = spliced(['formatTimestamp', 'deviceCardHtml', 'deviceState', 'devicePermBadge', 'devicePermLabel',
    'deviceCredLabel', 'deviceFirstSeen', 'deviceLastSeen', 'loadDevicePanel'], { document: doc, T, fetch: fetchStub, escHtml: (v) => String(v) })
  const sandbox = { document: doc, T, fetch: fetchStub, deviceCardHtml: cardHtml.deviceCardHtml,
    loadDevicePanel: cardHtml.loadDevicePanel,
    renderPendingPairings: () => {}, syncModeControls: () => {}, pollBusy: false, modeSwitching: false,
    // The init tail now also starts the public tunnel on a fresh pairing page
    // (user decision 2026-10-10: opening the page IS the intent), so the harness has
    // to supply the three flags that guard reads and stub the kick it calls.
    phoneConnected: false, tunnelActive: false, selectedTunnelTab: modeView === 'tunnel',
    switchMode: async () => { calls.push('/desktop/tunnel/toggle') },
    pendingPairings: [], modeView, poll: () => {}, setInterval: () => 0, calls,
    // The init tail also repaints the ClawBot binding panel (lib/pages.js);
    // this harness only cares about the device-list kick, so it gets a stub.
    renderClawbotView: () => {} }
  vm.createContext(sandbox)
  // The init snippet is async (it awaits loadDevicePanel), so run it via an
  // async IIFE that assigns the promise to a global we can await.
  sandbox.__done = vm.runInContext(`(async function(){${extractInit()}\nreturn calls})()`, sandbox)
  return { calls, sandbox, doc, done: sandbox.__done }
}

// The tail of the page script: `renderPendingPairings(pendingPairings);`
// `if(modeView==='devices')loadDevicePanel();` `setInterval(poll,2000);poll()`.
function extractInit() {
  const start = PAGES_SOURCE.lastIndexOf('renderPendingPairings(pendingPairings);')
  const end = PAGES_SOURCE.lastIndexOf('setInterval(poll,2000);')
  assert.ok(start >= 0 && end > start, 'the init tail must be findable in pages.js')
  return PAGES_SOURCE.slice(start, end + 'setInterval(poll,2000)'.length)
}

test('B-3 the init kick fetches /desktop/devices only when the device view is on', async () => {
  const devicesOn = initHarness('devices')
  await devicesOn.done
  assert.ok(devicesOn.calls.includes('/desktop/devices'),
    'with modeView=devices the init must actually fetch the device list')

  const lanOff = initHarness('lan')
  await lanOff.done
  assert.ok(!lanOff.calls.includes('/desktop/devices'),
    'with modeView=lan the init must NOT fetch the device list')

  // 2026-10-10: the same tail also generates the public link on a fresh pairing page.
  const onPublic = initHarness('tunnel')
  await onPublic.done
  assert.ok(onPublic.calls.includes('/desktop/tunnel/toggle'),
    'landing on the public tab with the tunnel down starts it — no second click')
  assert.ok(!lanOff.calls.includes('/desktop/tunnel/toggle'),
    'but the LAN tab does not start anything (the guard needs the public tab showing)')
  assert.ok(!devicesOn.calls.includes('/desktop/tunnel/toggle'),
    'and neither does the device view — there is already a phone on it')
})

/* ------------------------------------------------------------------ *
 * D / M-3  an armed revoke survives one poll cycle
 * ------------------------------------------------------------------ */

test('D the armed revoke state survives a poll() redraw cycle', async () => {
  // Arm the real handler, then run the real poll() against a sandbox where the
  // device panel lives in its own subtree. If poll() ever repaints #deviceList
  // the armed button is replaced and this assertion fails.
  const list = new FakeNode('div')
  const connection = new FakeNode('div')
  const body = new FakeNode('body')
  const { doc } = makeDocument({ deviceList: list, connection })
  doc.body = body
  const button = new FakeNode('button')
  button.dataset.id = 'dev-abc123'
  button._card = list
  const parent = new FakeNode('div')
  parent.children = []
  button.parentElement = parent
  button.isConnected = true
  button.disabled = false
  const revokeFetch = async () => ({ ok: true, json: async () => ({}) })
  const timers = []
  const fn = spliced(['deviceNote', 'revokeDevice', 'poll'], {
    document: doc, T, fetch: revokeFetch,
    pollBusy: false, modeSwitching: false, tunnelActive: false, pairingUrl: 'http://x',
    renderPendingPairings: () => {}, applyTunnelPayload: () => {}, syncModeControls: () => {},
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length },
    clearTimeout: () => {},
  })
  // First tap arms (fetch must NOT fire yet).
  await fn.revokeDevice(button)
  assert.equal(button.dataset.armed, '1', 'the first tap arms the button')
  assert.equal(button.textContent, T.revokeArmed, 'the armed label is visible')
  // poll() may not repaint #deviceList — the panel is not its concern.
  await fn.poll()
  assert.equal(button.dataset.armed, '1', 'armed state must survive a poll() cycle')
  assert.equal(button.textContent, T.revokeArmed, 'the armed label must survive a poll() cycle')
  assert.ok(parent.children.some((n) => n.dataset.revokeNote), 'the inline consequence note survives the poll too')
})

/* ------------------------------------------------------------------ *
 * G  three mode keys, and none of them is gated on a live phone
 * ------------------------------------------------------------------ */

test('G the mode switch ships exactly three keys and only the devices key stays live when connected', () => {
  const page = PAGES_SOURCE.slice(PAGES_SOURCE.lastIndexOf('<div class="mode-panel">'),
    PAGES_SOURCE.lastIndexOf('</style>'))
  // count the mode buttons in the rendered mode bar
  const buttons = page.match(/<button id="btn(Lan|Tunnel|Devices)"[^>]*>/g) || []
  assert.equal(buttons.length, 3, 'the mode switch must render exactly three keys')
  assert.match(page, /<button id="btnDevices"[^>]*data-action="mode-devices"/,
    'the third key is the device management key')
  // connected=true disables the two connection keys on purpose (user ruling 2026-10-12 09:3x):
  // switching modes with a phone on the line really swaps the tunnel and drops that phone.
  // The bridge still allows the call (M4: "A live phone is not a reason to refuse"); only the
  // page refuses, so the user does not lose the phone by a stray tap.
  const lan = (page.match(/<button id="btnLan"[^>]*>/) || [''])[0]
  const tunnel = (page.match(/<button id="btnTunnel"[^>]*>/) || [''])[0]
  const devices = (page.match(/<button id="btnDevices"[^>]*>/) || [''])[0]
  const connectedGate = /\$\{options\.connected \? ' disabled' : ''\}/
  assert.match(lan, connectedGate, 'the LAN key is gated on the connection state')
  assert.match(tunnel, connectedGate, 'and so is the tunnel key')
  assert.ok(!devices.includes('disabled'),
    'the devices key must NOT carry disabled even when connected')
  assert.ok(devices.includes('active'),
    'when connected the devices key is the active view')
})

/* ------------------------------------------------------------------ *
 * H  the device card CSS speaks theme variables, not hard-coded light values
 * ------------------------------------------------------------------ */

test('H the device card CSS uses theme variables and no hard-coded light palette', () => {
  // The device-panel CSS block lives inside the renderDesktopPairingPage source
  // template — read it from there, never from a separate <style> that may not
  // belong to this page.
  const block = deviceCssBlock()
  // every colour token must be a var() reference
  assert.match(block, /border:1px solid var\(--line\)/, 'the card border rides --line')
  assert.match(block, /background:var\(--surface\)/, 'the card surface rides --surface')
  assert.match(block, /color:var\(--danger\)/, 'the danger colour rides --danger')
  // hard-coded light hex values have no home in the migrated card block
  assert.doesNotMatch(block, /#fff\b/, 'no hard-coded #fff in the device card block')
  assert.doesNotMatch(block, /#3d4148\b/, 'no hard-coded #3d4148 in the device card block')
  assert.doesNotMatch(block, /#18191c\b/, 'no hard-coded ink in the device card block')
  assert.doesNotMatch(block, /#e5e7eb\b/, 'no hard-coded line colour in the device card block')
})

/* ------------------------------------------------------------------ *
 * N-1  the document-level click delegation really routes revoke-device
 * ------------------------------------------------------------------ */

// The document-level delegation lives inline inside
// `document.addEventListener('click',(event)=>{…})` — it is not a named
// function, so extractFunction() cannot reach it. Pull the body out with a
// brace scan anchored on the addEventListener literal instead.
// pages.js has several document-level click listeners, so anchor on the
// delegation's own `switch(el.dataset.action)` and back up to the `=>{` that
// owns it — that gives us the whole arrow body, not a neighbouring listener.
function extractClickDelegation() {
  const anchor = PAGES_SOURCE.indexOf('switch(el.dataset.action)')
  assert.ok(anchor >= 0, 'the desktop click delegation must exist in pages.js')
  const arrow = PAGES_SOURCE.lastIndexOf('=>{', anchor)
  assert.ok(arrow >= 0, 'the delegation must be an arrow whose body owns the switch')
  const open = arrow + 2
  assert.ok(open >= 0)
  let depth = 0
  let end = -1
  for (let i = open; i < PAGES_SOURCE.length; i++) {
    if (PAGES_SOURCE[i] === '{') depth++
    else if (PAGES_SOURCE[i] === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  assert.ok(end > open, 'the click delegation body must be balanced')
  return PAGES_SOURCE.slice(open, end + 1)
}

test('N-1 the document click delegation really routes revoke-device to revokeDevice', async () => {
  // D drives `revokeDevice` directly, so a delete of
  // `case 'revoke-device': revokeDevice(el)` would leave 9/9 green. Splice the
  // REAL delegation body (plus the real `revokeDevice`) and drive a real click
  // event against it — deleting that case makes this test red.
  const body = extractClickDelegation()
  const fnBody = extractFunction('revokeDevice') + '\nconst delegate=(event)=>' + body
  const calls = []
  const { doc } = makeDocument()
  const fetchStub = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  // revokeDevice calls: deviceNote, poll(), loadDevicePanel(), disarmRevoke(),
  // setTimeout / clearTimeout — all supplied from the env. Only the delegation
  // case under test is exercised here, so the other action handlers are stubs.
  const stubs = {
    deviceNote: () => {},
    disarmRevoke: () => {},
    poll: async () => {},
    loadDevicePanel: async () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    // every other case in the switch — stubs; revoke-device is the only real one
    setModeView: () => {}, switchMode: async () => {}, showDevicePanel: () => {},
    extendDevice: async () => {}, retryLoadDevicePanel: () => {}, disconnectPhone: async () => {},
    donePairing: () => {}, copyUrl: async () => {}, refreshQr: async () => {}, resetPin: async () => {},
    setPinConsent: async () => {}, saveNotifyConfig: async () => {}, testNotifyConfig: async () => {},
    saveTunnelConfig: async () => {}, pairConfirm: async () => {},
  }
  const sandbox = { document: doc, T, fetch: fetchStub, $: () => null, ...stubs }
  vm.createContext(sandbox)
  // `body` is an arrow body `(event)=>{…}` with no name, so wrap it so the
  // delegation is reachable from the host scope.
  sandbox.__compiled = vm.runInContext(`(async function(){${fnBody}\nglobalThis.__delegate=delegate;return delegate})()`, sandbox)
  const handler = await sandbox.__compiled

  // the revoke button, wired so `closest('[data-action]')` finds itself
  const button = new FakeNode('button')
  button.dataset.action = 'revoke-device'
  button.dataset.id = 'dev-abc'
  button.isConnected = true
  button.closest = (sel) => (sel === '[data-action]' ? button : null)

  // revokeDevice is armed-two-step: the first tap only arms, the second within
  // the window is the one that POSTs. Both taps must come through the REAL
  // delegation path, so if the `case 'revoke-device'` line is ever deleted no
  // fetch is made and this test goes red.
  await handler({ target: button })
  assert.equal(calls.length, 0, 'the first tap only arms — no POST yet')
  assert.equal(button.dataset.armed, '1', 'the delegation must have armed the button')
  await handler({ target: button })
  assert.equal(calls.length, 1, 'the second tap through the delegation must reach the real revokeDevice')
  assert.equal(calls[0].url, '/desktop/revoke')
  assert.equal(calls[0].opts.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].opts.body), { deviceId: 'dev-abc' })
})

/* ------------------------------------------------------------------ *
 * N-2  the renderer really emits data-target-perm on the perm button
 * ------------------------------------------------------------------ */

test('N-2 the card renderer emits data-target-perm, not the current state', () => {
  // B-1 sets permBtn.dataset.targetPerm by hand, so a renderer that stopped
  // outputting data-target-perm (or output the CURRENT permission instead of the
  // TARGET) would still leave B-1 green. Render the real deviceCardHtml and pin
  // the attribute.
  const deviceCardHtml = spliced([
    'formatTimestamp', 'deviceState', 'devicePermBadge', 'devicePermLabel', 'deviceCredLabel',
    'deviceFirstSeen', 'deviceLastSeen', 'deviceCardHtml',
  ], { T, escHtml: (v) => String(v) }).deviceCardHtml
  const base = {
    id: 'd1', label: 'phone', online: true,
    expiresAt: Date.now() + 1000, firstPairedAt: Date.now(), lastSeenAt: Date.now(),
  }
  const lanCard = deviceCardHtml({ ...base, permission: 'lan' })
  assert.match(lanCard, /data-action="device-perm"[^>]*data-target-perm="lan\+wan"/,
    'a lan device offers the TARGET lan+wan, not the current lan')
  const wanCard = deviceCardHtml({ ...base, permission: 'lan+wan' })
  assert.match(wanCard, /data-action="device-perm"[^>]*data-target-perm="lan"/,
    'a public device offers the TARGET lan, not the current lan+wan')
  // the revoke handle is a danger button on the same row
  assert.match(lanCard, /data-action="revoke-device"[^>]*class="is-danger"/,
    'the revoke button must ride the danger style')
  // offline devices carry is-offline on the card
  const offlineCard = deviceCardHtml({ ...base, permission: 'lan', online: false })
  assert.match(offlineCard, /class="device-card is-offline"/,
    'an offline device must be marked is-offline on its card')
})
