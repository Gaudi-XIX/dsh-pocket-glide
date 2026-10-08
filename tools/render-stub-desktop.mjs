// Render-layer verification stub for the DESKTOP PAIRING page (lib/pages.js →
// renderDesktopPairingPage). The sibling tool render-stub.mjs only renders the
// mobile page (it imports mobilePageAssets), so the /desktop surface has never
// had a browser-openable artifact — which is how B-1/B-2/B-3 (inverted access
// toggle, invisible empty/failed copy, panel that never loads on open) survived
// three green character-level self-checks.
//
// This is deliberately a PURE RENDER + STUB API tool. It never instantiates
// LanMobileBridge: the bridge persists pairings to mobile-sessions.json, and
// putting a second writer on that file to satisfy a visual check would risk the
// live pairing state of the pocket process that is running right now. Nothing
// here touches disk. All state lives in this process and resets when the
// document is requested again.
//
// Run:            node tools/render-stub-desktop.mjs [--port 4398] [--state
//                 devices] [--locale zh] [--verbose] [--quiet] [--help]
// Then open       http://127.0.0.1:4398/  (index page listing every state)
// Port 4398 by default so it never collides with render-stub.mjs on 4399.
//
// States (switch with ?s=<name> on /desktop, or --state at launch):
//   devices    3 paired devices: online/offline mix, one 'lan', one 'lan+wan',
//              one with an expired credential.            → B-1 target state
//   empty      registry is empty (never paired).         → B-2 / copy 还没有…
//   fail       GET /desktop/devices → 500 with a NON-JSON body: the page does
//              not read r.ok, so only an unparseable body reaches the catch
//              branch that renders 「设备列表加载失败」 + 「重试」.
//   failjson   GET /desktop/devices → 500 with a JSON body {ok:false}: the
//              shipped loadDevicePanel() treats it as an EMPTY LIST, so the
//              error copy and the retry button never appear. Kept as a separate
//              state on purpose — the two failure flavours look different.
//   connected  connected:true → panel is `show` at open.  → B-3 target state
//   tunnel     tunnelActive:true + pairingPin → QR/pin/tunnel branch. (bonus)
//   pairing    one pending pair request → 允许/拒绝 round trip. (bonus)
//
// Every mutation endpoint records into this process's in-memory registry and the
// next GET /desktop/devices reflects it, so 切权限 / 延长 / 吊销 can be clicked
// for real and observed to do something (or to do nothing, which is the B-1
// finding). GET /__stub/world dumps that state for a no-browser check.
//
// The page's own CSP/nonce handling is not reproduced: no CSP header is set and
// no nonce is passed, so the shipped inline <script> runs. This tool injects no
// inline event attributes of its own.
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderDesktopPairingPage as startupRender } from '../lib/pages.js'
import { renderQrSvg } from '../lib/qr-svg.js'

// The renderer is read from disk per document request, and re-imported when the
// file changed. This tool exists to verify a page that other workers are
// actively editing; pinning the module at startup would show the browser a
// different tree than the one on disk, which is exactly the kind of evidence
// mismatch that let B-1/B-2/B-3 through in the first place. --frozen opts out.
const FROZEN = process.argv.includes('--frozen')
const PAGES_FILE = fileURLToPath(new URL('../lib/pages.js', import.meta.url))
const shaOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
let renderFn = startupRender
let pagesSha = shaOf(PAGES_FILE)

async function currentRenderer() {
  if (FROZEN) return { fn: renderFn, sha: pagesSha }
  const sha = shaOf(PAGES_FILE)
  if (sha !== pagesSha) {
    pagesSha = sha
    const fresh = await import('../lib/pages.js?seen=' + sha.slice(0, 16))
    renderFn = fresh.renderDesktopPairingPage
    console.log('re-imported lib/pages.js — it changed on disk. sha256=' + sha.slice(0, 16))
  }
  return { fn: renderFn, sha: pagesSha }
}

function pagesBuild() {
  let mtime = 0
  try {
    mtime = statSync(PAGES_FILE).mtimeMs
  } catch { /* unreadable: report 0 */ }
  return { pagesSha, mtime, frozen: FROZEN }
}

const DAY = 86400000
const argv = process.argv

function flagValue(name, fallback) {
  const i = argv.indexOf(name)
  const v = i === -1 ? undefined : argv[i + 1]
  return v && !v.startsWith('--') ? v : fallback
}

const portFlag = Number(flagValue('--port', '4398'))
const PORT = Number.isFinite(portFlag) && portFlag > 0 ? portFlag : 4398
const QUIET = argv.includes('--quiet')
const VERBOSE = argv.includes('--verbose')
const DEFAULT_LOCALE = /^en/i.test(String(flagValue('--locale', 'zh'))) ? 'en' : 'zh'

const STATE_NAMES = ['devices', 'empty', 'fail', 'failjson', 'connected', 'tunnel', 'pairing']
if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    'usage: node tools/render-stub-desktop.mjs [--port 4398] [--state ' + STATE_NAMES.join('|') + '] [--locale zh|en] [--verbose] [--quiet] [--frozen]',
    '',
    '  index page (all states, both locales): http://127.0.0.1:' + PORT + '/',
    '  a state directly:                      http://127.0.0.1:' + PORT + '/desktop?s=devices',
    '  machine-readable stub state:           http://127.0.0.1:' + PORT + '/__stub/world',
    '',
    'Dark mode is not a URL: emulate it in the browser (Chrome DevTools > More',
    'tabs > Rendering > "Emulate CSS media feature prefers-color-scheme" > dark).',
  ].join('\n'))
  process.exit(0)
}
const stateFlag = String(flagValue('--state', 'devices'))
if (!STATE_NAMES.includes(stateFlag)) {
  console.error('unknown --state "' + stateFlag + '"; pick one of: ' + STATE_NAMES.join(', '))
  process.exit(1)
}

// ---------------------------------------------------------------- stub world
// Field names are copied from LanMobileBridge#pairedDevicesView() so a row here
// is shaped exactly like what the real bridge answers on GET /desktop/devices:
// { id, label, fingerprint, firstPairedAt, expiresAt, lastSeenAt, permission,
//   consented, online }. id === fingerprint by design. options.connectedDevices
// is NOT part of this stub: renderDesktopPairingPage no longer reads it (the
// card deleted that row), the list is fetched.
function deviceRow(id, label, extra) {
  const now = Date.now()
  return {
    id,
    label,
    fingerprint: id,
    firstPairedAt: now - 40 * DAY,
    expiresAt: now + 30 * DAY,
    lastSeenAt: now - 30 * 1000,
    permission: 'lan',
    consented: false,
    online: false,
    ...extra,
  }
}

function lanPairingUrl(token) {
  return 'http://127.0.0.1:' + PORT + '/pair?token=' + token
}

function buildWorld(state) {
  const now = Date.now()
  const world = {
    state,
    devices: [
      deviceRow('stub-fp-iphone15pro-0001', 'iPhone 15 Pro', {
        online: true,
        permission: 'lan+wan',
        consented: true,
        firstPairedAt: now - 40 * DAY,
        expiresAt: now + 12 * DAY,
        lastSeenAt: now - 20 * 1000,
      }),
      deviceRow('stub-fp-pixel8-0000000002', 'Pixel 8', {
        online: false,
        permission: 'lan',
        firstPairedAt: now - 18 * DAY,
        expiresAt: now + 6 * DAY,
        lastSeenAt: now - 3 * DAY,
      }),
      deviceRow('stub-fp-ipadmini-0000000003', 'iPad mini（凭证已过期）', {
        online: false,
        permission: 'lan',
        firstPairedAt: now - 120 * DAY,
        expiresAt: now - 3600000,
        lastSeenAt: now - 9 * DAY,
      }),
    ],
    pendingPairings: [],
    connected: false,
    tunnelActive: false,
    tunnelLoading: false,
    tunnelProvider: null,
    tunnelUrl: '',
    tunnelError: '',
    pairingUrl: lanPairingUrl('stublantoken00000000000000000001'),
    expiresAt: now + 5 * 60000,
    pairingPin: '',
    pinConsent: false,
    pinExpiresAt: null,
    notifyConfig: { channel: 'off', enabled: false, keyMasked: '' },
    tunnelConfig: { tokenMasked: '', hostname: '' },
    failDevices: null,
    pinRotate: 0,
  }
  if (state === 'empty') world.devices = []
  if (state === 'fail') world.failDevices = 'text'
  if (state === 'failjson') world.failDevices = 'json'
  if (state === 'connected') {
    world.connected = true
    world.devices = world.devices.map((row, index) => (index === 0 ? { ...row, online: true } : row))
  }
  if (state === 'tunnel') {
    world.tunnelActive = true
    world.tunnelLoading = false
    world.tunnelProvider = 'cloudflare'
    world.tunnelUrl = 'https://stub-demo-tunnel.trycloudflare.com'
    world.pairingUrl = world.tunnelUrl + '/pair?token=stubtunneltoken0000000000000000002'
    world.pairingPin = '202610'
    world.tunnelConfig = { tokenMasked: '*****2610', hostname: 'stub-desk.example.com' }
  }
  if (state === 'pairing') {
    world.pendingPairings = [{
      id: 'stub-pair-req-1',
      label: 'Galaxy S24',
      remoteAddress: '192.0.2.24',
      expiresAt: now + 90000,
    }]
  }
  return world
}

let world = buildWorld(stateFlag)

function devicesView() {
  return world.devices.map((row) => ({ ...row }))
}

function tunnelPayload() {
  return {
    active: world.tunnelActive,
    loading: world.tunnelLoading,
    url: world.tunnelUrl,
    provider: world.tunnelProvider,
    error: world.tunnelError,
    pairingUrl: world.pairingUrl,
    qrSvg: qrFor(world.pairingUrl),
    expiresAt: world.expiresAt,
    unexpectedlyClosed: false,
    pinConsent: world.pinConsent,
    pinExpiresAt: world.pinExpiresAt,
    ...(world.pairingPin ? { pairingPin: world.pairingPin } : {}),
  }
}

function qrFor(url) {
  if (!url) return ''
  try {
    return renderQrSvg(url, { width: 220 })
  } catch {
    // A QR encoder that refuses a payload must not blank the whole page: the
    // box stays, the URL line still carries the link.
    return '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><rect width="220" height="220" fill="#fff"/><text x="110" y="115" font-size="12" text-anchor="middle" fill="#18191c">QR unavailable</text></svg>'
  }
}

// ------------------------------------------------------------------ render
function pageOptions(locale) {
  return {
    locale,
    qrSvg: qrFor(world.pairingUrl),
    pairingUrl: world.pairingUrl,
    expiresAt: world.expiresAt,
    connected: world.connected,
    tunnelActive: world.tunnelActive,
    tunnelLoading: world.tunnelLoading,
    tunnelProvider: world.tunnelProvider,
    tunnelError: world.tunnelError,
    pairingPin: world.pairingPin,
    pinConsent: world.pinConsent,
    pinExpiresAt: world.pinExpiresAt,
    notifyConfig: { ...world.notifyConfig },
    tunnelConfig: { ...world.tunnelConfig },
    pendingPairings: world.pendingPairings.map((item) => ({ ...item })),
  }
}

const STATE_NOTES = [
  ['devices', '有设备', '点「设备与通知」应出现 3 张卡。每台「切权限」键的文案必须与它当前通道相反（lan 那台＝「开启公网」，lan+wan 那台＝「切为仅本地」），点一次就真的改状态 → B-1 目验点；已过期那台的「凭证到期」行应是红字并带（已过期）。'],
  ['empty', '零设备', '点第三键 → 「还没有已配对的设备。」必须看得见（B-2 目验点：显隐规则挂在 .device-list.is-empty 上，与 JS 加类的元素同一片）。看不见就是 B-2 回归。'],
  ['fail', '取数失败(非 JSON)', '点第三键 → 「设备列表读取失败。」+「重试」应可见可点；桩是首点失败、再点成功（data-action="device-retry" 走事件委托，CSP 下可用）。'],
  ['failjson', '取数失败(JSON)', '同一次 500 但带 JSON body：loadDevicePanel 不读 r.ok，这条路径显示的是零设备文案而不是错误文案 —— 目验时请分清这两态。'],
  ['connected', '手机已连接', '开屏不点任何东西就应看见设备卡（B-3 目验点：init 里带了 modeView 为 devices 时的 loadDevicePanel() 调用）。开屏空白就是回归。同时确认第三键未被 connected 禁用、WiFi/互联网两键被禁用。'],
  ['tunnel', '互联网模式', 'QR 换成隧道 URL、连接密码面板显示、局域网风险提示 hidden；密码的「取消长效密码/重置」可点。'],
  ['pairing', '待确认接入', '「待确认接入」卡片可见，允许/拒绝可点：允许会真的新增一行设备（内存态）。'],
]

function indexHtml() {
  const row = (state, title, note) => {
    const cell = (locale) => '<a href="/desktop?s=' + state + '&locale=' + locale + '">/desktop?s=' + state + '&locale=' + locale + '</a>'
    return '<tr><td><strong>' + title + '</strong><br><code>' + state + '</code></td><td>' + cell('zh') + '<br>' + cell('en') + '</td><td>' + note + '</td></tr>'
  }
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    '<title>桌面配对页渲染目验桩</title><style>' +
    'body{font:14px/1.6 -apple-system,"Segoe UI",sans-serif;margin:0;padding:24px;background:#f7f8fa;color:#18191c}' +
    'main{max-width:900px;margin:auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:20px 24px}' +
    'h1{font-size:20px;margin:0 0 6px}code{font-family:ui-monospace,Menlo,monospace;font-size:12px}' +
    'a{color:#4d6bfe}table{border-collapse:collapse;width:100%;margin-top:14px}' +
    'td,th{border:1px solid #e5e7eb;padding:8px 10px;text-align:left;vertical-align:top}' +
    'th{font-size:12px;color:#6b7076}ol{padding-left:20px}' +
    '</style></head><body><main>' +
    '<h1>桌面配对页渲染目验桩 · render-stub-desktop.mjs</h1>' +
    '<p>纯渲染 + 桩接口，不含真桥，不写 <code>mobile-sessions.json</code>。端口 ' + PORT +
    '（<code>render-stub.mjs</code> 用 4399，互不冲突）。切换状态用 <code>?s=</code>，切语言用 <code>&locale=</code>。</p>' +
    '<p><strong>取数入口是顶部第三键「设备与通知」</strong>；<code>connected</code> 态则应当开屏自己取数' +
    '（B-3 的判定点：开屏面板不是空的）。</p>' +
    '<p>当前渲染用的 <code>lib/pages.js</code> sha256=<code>' + pagesSha.slice(0, 16) + '</code>' +
    (FROZEN ? '（<code>--frozen</code>：不会随磁盘变化重导）' : '（磁盘一变，下一次请求文档就重导）') + '</p>' +
    '<table><thead><tr><th>态</th><th>入口</th><th>该看到什么</th></tr></thead><tbody>' +
    STATE_NOTES.map(([s, t, n]) => row(s, t, n)).join('') +
    '</tbody></table>' +
    '<h2>暗色配色</h2><p>页面 CSS 走 <code>@media(prefers-color-scheme:dark)</code>，桩里没有开关，须在浏览器里强制：' +
    'Chrome/Edge DevTools → ⋮ → More tabs → <em>Rendering</em> → ' +
    '<em>Emulate CSS media feature prefers-color-scheme</em> → 选 <code>prefers-color-scheme: dark</code>。' +
    'Safari：开发菜单 → 外观（Appearance）→ 深色。看两点：正文背景应变深（<code>--bg:#141416</code>），' +
    '以及仍然写死 <code>#fff/#18191c</code> 的件（QR 白底是刻意的，<code>.copy-tip</code> 提示气泡与 ' +
    '<code>.qr-loading</code> 覆盖层是硬编码）在暗色下是否刺眼。</p>' +
    '<h2>操作提示</h2><ol>' +
    '<li>桩的写操作只改本进程内存，下一次 <code>GET /desktop/devices</code> 立刻反映；' +
    '但<em>重新加载文档会重建该态</em>（页面在二维码倒计时归零时也会自己 reload）。</li>' +
    '<li>不想要 800ms 轮询刷日志就加 <code>--quiet</code>；想看全部请求加 <code>--verbose</code>。</li>' +
    '<li>机器可读的当前状态：<a href="/__stub/world">/__stub/world</a>。</li>' +
    '</ol></main></body></html>'
}

// -------------------------------------------------------------------- http
function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function sendText(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function brandSvg(dark) {
  const fill = dark ? '#6f86ff' : '#4d6bfe'
  const ink = dark ? '#141416' : '#ffffff'
  return '<svg xmlns="http://www.w3.org/2000/svg" width="39" height="22" viewBox="0 0 39 22">' +
    '<rect width="39" height="22" rx="5" fill="' + fill + '"/>' +
    '<text x="19.5" y="15" font-family="sans-serif" font-size="10" font-weight="700" text-anchor="middle" fill="' + ink + '">DSH</text></svg>'
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 65536) request.destroy()
    })
    request.on('end', () => resolve(raw))
    request.on('error', () => resolve(raw))
  })
}

function parseJson(raw) {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

function findDevice(id) {
  return world.devices.find((row) => row.id === id || row.fingerprint === id)
}

const POLL_PATHS = new Set(['/desktop/status', '/desktop/tunnel/status'])

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  const p = url.pathname
  const method = request.method || 'GET'
  const log = (...args) => {
    if (QUIET) return
    if (POLL_PATHS.has(p) && !VERBOSE) return
    console.log(method, p + url.search, ...args)
  }

  // ---- document ----
  if (method === 'GET' && p === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(indexHtml())
    log('-> index')
    return
  }
  if (method === 'GET' && p === '/desktop') {
    const requested = String(url.searchParams.get('s') || stateFlag)
    const state = STATE_NAMES.includes(requested) ? requested : stateFlag
    // Rebuild on every document request: the scenarios are defined by their
    // timestamps, and a stale world would leak one state's clicks into another.
    world = buildWorld(state)
    const locale = /^en/i.test(String(url.searchParams.get('locale') || DEFAULT_LOCALE)) ? 'en' : 'zh'
    const { fn, sha } = await currentRenderer()
    const html = fn(pageOptions(locale))
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(html)
    log('-> document state=' + state + ' locale=' + locale + ' bytes=' + Buffer.byteLength(html) + ' pages.js=' + sha.slice(0, 12))
    return
  }

  // ---- stub introspection ----
  if (method === 'GET' && p === '/__stub/world') {
    sendJson(response, 200, {
      state: world.state,
      connected: world.connected,
      tunnelActive: world.tunnelActive,
      devices: devicesView(),
      pendingPairings: world.pendingPairings,
      failDevices: world.failDevices,
      notifyConfig: world.notifyConfig,
      tunnelConfig: world.tunnelConfig,
      build: pagesBuild(),
    })
    return
  }
  if (method === 'POST' && p === '/__stub/arm-fail') {
    const body = parseJson(await readBody(request))
    world.failDevices = body.mode === 'json' ? 'json' : 'text'
    sendJson(response, 200, { ok: true, failDevices: world.failDevices })
    log('-> armed device failure mode=' + world.failDevices)
    return
  }

  // ---- read endpoints ----
  if (method === 'GET' && p === '/desktop/devices') {
    if (world.failDevices === 'text') {
      // 500 with a non-JSON body: r.json() throws → the page's catch branch runs
      // → error copy + 重试. This is the only flavour that can show the retry
      // button, because loadDevicePanel never inspects r.ok.
      world.failDevices = null
      sendText(response, 500, 'stub: forced device list failure')
      log('-> 500 text (once)')
      return
    }
    if (world.failDevices === 'json') {
      world.failDevices = null
      sendJson(response, 500, { ok: false, error: 'stub: forced device list failure' })
      log('-> 500 json (once)')
      return
    }
    sendJson(response, 200, { ok: true, devices: devicesView() })
    log('-> devices rows=' + world.devices.length)
    return
  }
  if (method === 'GET' && p === '/desktop/status') {
    sendJson(response, 200, {
      connected: world.connected,
      connectedDevices: devicesView().filter((row) => row.online),
      pendingPairings: world.pendingPairings.map((item) => ({ ...item })),
    })
    return
  }
  if (method === 'GET' && p === '/desktop/tunnel/status') {
    sendJson(response, 200, tunnelPayload())
    return
  }
  if (method === 'GET' && p === '/desktop/notify') {
    sendJson(response, 200, { ok: true, ...world.notifyConfig })
    return
  }
  if (method === 'GET' && p === '/desktop/pairing') {
    sendJson(response, 200, { ok: true, ...tunnelPayload() })
    return
  }

  // ---- mutation endpoints (in-memory only) ----
  if (method === 'POST' && p === '/desktop/device/extend') {
    const body = parseJson(await readBody(request))
    const row = findDevice(String(body.deviceId || ''))
    if (!row) {
      sendJson(response, 404, { ok: false, error: 'That device is not paired.' })
      log('-> extend 404')
      return
    }
    row.expiresAt = Date.now() + 30 * DAY
    row.lastSeenAt = Date.now()
    sendJson(response, 200, { ok: true, devices: devicesView() })
    log('-> extend ok newExpiresAt=' + new Date(row.expiresAt).toISOString())
    return
  }
  if (method === 'POST' && p === '/desktop/device/permission') {
    const body = parseJson(await readBody(request))
    if (body.permission !== 'lan' && body.permission !== 'lan+wan') {
      sendJson(response, 400, { ok: false, error: 'The permission must be "lan" or "lan+wan".' })
      return
    }
    const row = findDevice(String(body.deviceId || ''))
    if (!row) {
      sendJson(response, 404, { ok: false, error: 'That device is not paired.' })
      return
    }
    row.permission = body.permission
    if (body.permission === 'lan') row.consented = false
    else row.consented = true
    sendJson(response, 200, { ok: true, devices: devicesView() })
    log('-> permission ok ' + row.id.slice(-6) + ' -> ' + row.permission)
    return
  }
  if (method === 'POST' && p === '/desktop/revoke') {
    const body = parseJson(await readBody(request))
    const id = String(body.deviceId || '')
    const index = world.devices.findIndex((row) => row.id === id || row.fingerprint === id)
    if (index === -1) {
      sendJson(response, 404, { ok: false, error: 'That device is not connected.' })
      log('-> revoke 404')
      return
    }
    const [gone] = world.devices.splice(index, 1)
    if (world.connected && gone.online) world.connected = false
    sendJson(response, 200, { ok: true, ...tunnelPayload() })
    log('-> revoke ok removed=' + gone.id.slice(-6) + ' rows=' + world.devices.length)
    return
  }
  if (method === 'POST' && p === '/desktop/pair/confirm') {
    const body = parseJson(await readBody(request))
    const id = String(body.id || '')
    const index = world.pendingPairings.findIndex((item) => item.id === id)
    const [entry] = index === -1 ? [null] : world.pendingPairings.splice(index, 1)
    if (body.approve === true) {
      const label = entry && entry.label ? entry.label : 'Approved phone'
      world.devices.unshift(deviceRow('stub-fp-approved-' + id.padEnd(6, '0').slice(0, 6), label, {
        online: false,
        lastSeenAt: 0,
        firstPairedAt: Date.now(),
      }))
    }
    sendJson(response, 200, { ok: true })
    log('-> pair-confirm ' + (body.approve === true ? 'allow' : 'deny') + ' rows=' + world.devices.length)
    return
  }
  if (method === 'POST' && p === '/desktop/tunnel/toggle') {
    const body = parseJson(await readBody(request))
    const enable = body.enable === true
    world.tunnelActive = enable
    world.tunnelProvider = enable ? 'cloudflare' : null
    world.tunnelUrl = enable ? 'https://stub-demo-tunnel.trycloudflare.com' : ''
    world.tunnelError = ''
    world.pairingPin = enable ? '202610' : ''
    world.pairingUrl = enable
      ? world.tunnelUrl + '/pair?token=stubtunneltoken0000000000000000002'
      : lanPairingUrl('stublantoken00000000000000000001')
    world.expiresAt = Date.now() + 5 * 60000
    sendJson(response, 200, { ok: true, ...tunnelPayload() })
    log('-> tunnel toggle enable=' + enable)
    return
  }
  if (method === 'POST' && p === '/desktop/pin/consent') {
    const body = parseJson(await readBody(request))
    world.pinConsent = body.consent === true
    world.pinExpiresAt = world.pinConsent ? Date.now() + 30 * DAY : null
    if (world.pinConsent && !world.pairingPin) world.pairingPin = '202610'
    if (!world.pinConsent) world.pairingPin = ''
    sendJson(response, 200, { ok: true, ...tunnelPayload() })
    log('-> pin consent=' + world.pinConsent)
    return
  }
  if (method === 'POST' && p === '/desktop/pin/reset') {
    world.pinRotate += 1
    world.pairingPin = String(202610 + world.pinRotate)
    sendJson(response, 200, { ok: true, ...tunnelPayload() })
    log('-> pin reset ' + world.pairingPin)
    return
  }
  if (method === 'POST' && p === '/desktop/pairing/rotate') {
    world.pairingUrl = world.tunnelActive
      ? world.tunnelUrl + '/pair?token=stubrotatedtoken0000000000000' + world.pinRotate
      : lanPairingUrl('stubrotatedlantoken0000000000' + world.pinRotate)
    world.expiresAt = Date.now() + 5 * 60000
    sendJson(response, 200, { ok: true, pairingUrl: world.pairingUrl, expiresAt: world.expiresAt })
    log('-> pairing rotate')
    return
  }
  if (method === 'POST' && p === '/desktop/notify') {
    const body = parseJson(await readBody(request))
    if (typeof body.channel === 'string') world.notifyConfig.channel = body.channel
    if (typeof body.enabled === 'boolean') world.notifyConfig.enabled = body.enabled
    if (typeof body.key === 'string' && body.key.length > 0) {
      world.notifyConfig.keyMasked = '*****' + body.key.slice(-4)
    }
    sendJson(response, 200, { ok: true, ...world.notifyConfig })
    log('-> notify save channel=' + world.notifyConfig.channel)
    return
  }
  if (method === 'POST' && p === '/desktop/notify/test') {
    sendJson(response, 200, { ok: true, delivered: true })
    log('-> notify test')
    return
  }
  if (method === 'POST' && p === '/desktop/tunnel/config') {
    const body = parseJson(await readBody(request))
    if (typeof body.token === 'string' && body.token.length > 0) {
      world.tunnelConfig.tokenMasked = '*****' + body.token.slice(-4)
    }
    if (typeof body.hostname === 'string') world.tunnelConfig.hostname = body.hostname
    sendJson(response, 200, { ok: true, ...world.tunnelConfig })
    log('-> tunnel config hostname=' + world.tunnelConfig.hostname)
    return
  }
  if (method === 'POST' && p === '/desktop/disconnect') {
    world.connected = false
    world.devices = world.devices.map((row) => ({ ...row, online: false }))
    sendJson(response, 200, { ok: true })
    log('-> disconnect')
    return
  }

  // ---- static placeholders the document references ----
  if (method === 'GET' && (p === '/brand-logo/light' || p === '/brand-logo/dark')) {
    response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' })
    response.end(brandSvg(p === '/brand-logo/dark'))
    return
  }
  if (method === 'GET' && p === '/favicon.ico') {
    response.writeHead(204)
    response.end()
    return
  }

  sendText(response, 404, 'not found: ' + method + ' ' + p)
  log('-> 404')
})

server.on('error', (error) => {
  console.error('stub server error:', error.message)
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () => {
  const base = 'http://127.0.0.1:' + PORT
  console.log('desktop pairing render stub on ' + base + '/')
  console.log('index (all states, both locales): ' + base + '/')
  for (const [state, title] of STATE_NOTES) {
    console.log('  ' + title + ': ' + base + '/desktop?s=' + state)
  }
  console.log('current --state=' + stateFlag + ' --locale=' + DEFAULT_LOCALE + (QUIET ? ' (quiet)' : '') + (VERBOSE ? ' (verbose)' : '') + (FROZEN ? ' (frozen renderer)' : ''))
  console.log('renderer: lib/pages.js sha256=' + pagesSha.slice(0, 16))
  console.log('no bridge, no disk writes; Ctrl-C to stop.')
})
