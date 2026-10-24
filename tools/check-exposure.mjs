#!/usr/bin/env node
/**
 * 暴露姿态自检 —— 起一个**未配对**的桥，用伪造的 Host 头逐条打路由，看谁漏了数据。
 *
 * 为什么值得常设：这张网里每一条路由「该拒答还是该公开」都只写在代码里，改一个判断
 * 顺序就可能把 `/api/status` 挪到 `authorized()` 之前，而那种改动**不会**弄红任何一条
 * 既有测试（现有测试大多带着配对 cookie 在打）。这道门禁只做一件事：在没有任何凭证的
 * 前提下把 23 条路径 × 4 组 Host 全打一遍，谁给了 2xx 就喊。另一头静态盯
 * `RPC_ALLOWLIST`：白名单里悄悄多一条路径，必须经过一次显式改动（改本文件基线）。
 *
 * 用法：
 *   node tools/check-exposure.mjs                  # 进程内 ephemeral 端口（默认 --port 0）
 *   node tools/check-exposure.mjs --verbose        # 打印 92 格逐格读数
 *   node tools/check-exposure.mjs --port 43127     # 打一个已经存在的桥（只读！不自起进程）
 *   node tools/check-exposure.mjs --url https://x  # 打外部部署（无进程内桥）
 *   node tools/check-exposure.mjs --self-test      # 只跑判定器自证，不联网、不起桥
 *   node tools/check-exposure.mjs --bridge-source <path>  # 换一份 bridge 源码当抽取源（默认 lib/bridge.js）
 *
 * 判据（退出码）：
 *   0  clean（受保护面全拒答、桌面面全 403、公开面不因 Host 变脸也不漏数据、白名单没多项）
 *   2  CRITICAL（有路径未配对就拿到了数据 / 白名单多出项 / 出现未登记的 `===` 字面量）
 *   3  SKIP（一条受保护面都没拿到可判定读数 —— **没测到不等于干净**，绝不用 0 表达）
 *   1  工具自身异常（参数错、桥起不来、Host 注入未生效、--self-test 判定器不自洽）
 *
 * 为什么默认 `--port 0` 而**不**默认打 43127：43127 是桌面宿主里那个桥，也是用户手机
 * 此刻正在用的桥（`tools/smoke-bridge.mjs`、`README.md` 的端口说明）。去打它得到的读数
 * 被配对态与在途会话污染，既不是证据，也等于往用户正在用的连接上加噪声。`--port 0` 让
 * OS 分一个临时端口，起一个干净的、未配对的桥来测。
 *
 * 关于「evil 列」：把 Host 伪造成攻击者域名后，**没有任何一条路径比 honest 多给数据**。
 * 这一列是留给未来的：哪天它出现 200，就是有人开始拿 Host 当信任凭证了。
 *
 * 只读：本工具只发 GET，以及四个**已知不会改状态**的 POST —— `/api/rpc`（未配对必拒，
 * 顺带验白名单）、`/pair/verify`（空 PIN，必拒）、`/desktop/pairing/rotate`（无桌面
 * cookie 必 403）、`/__diag`（写一行日志的失败现场上报）。不写任何文件、不杀任何外部
 * 进程、不改任何配置。进程内起的那个桥由本工具自己 stop；`--port` / `--url` 模式下
 * 本工具不持有任何 server，也就不会去 stop 别人的桥。
 */

import http from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LanMobileBridge } from '../lib/bridge.js'
import { RPC_ALLOWLIST } from '../lib/constants.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GET = 'GET'
// 唯一的写方法常量：本文件不落散装 POST 字面量，发行目标集中在 POST_TARGETS 自证里。
const POST = 'POST'

// ---------------------------------------------------------------------------
// 1. 三张面 + 网格（23 条路径；本工具唯一的「该拒答 / 该公开」事实来源）
// ---------------------------------------------------------------------------

/** 受保护面：未配对必须拒答（4xx，或 3xx 且 Location 指向登录面）。2xx = CRITICAL。 */
const PROTECTED = [
  { method: GET, path: '/manifest.json' },
  { method: GET, path: '/app.js' },
  { method: GET, path: '/app.css' },
  { method: GET, path: '/app-icon' },
  { method: GET, path: '/brand-logo/light' },
  { method: GET, path: '/api/status' },
  { method: GET, path: '/api/boot' },
  { method: GET, path: '/api/opened-at' },
  { method: POST, path: '/api/rpc', body: { method: 'session.list', payload: {} } }
]

/** 桌面面：必须 403 `Desktop only.`。非 403 = CRITICAL。 */
const DESKTOP = [
  { method: GET, path: '/desktop' },
  { method: GET, path: '/desktop/status' },
  { method: GET, path: '/desktop/devices' },
  { method: GET, path: '/desktop/tunnel/config' },
  { method: POST, path: '/desktop/pairing/rotate' }
]

/**
 * 公开面（设计上未配对可访问）：两条判据 ——
 * ① 同一路径在 honest 与 evil 两组 Host 下状态码必须相同（Host 不得改变公开面）；
 * ② 响应体不得含 `dsh_` 开头的 cookie 值，也不得含 token/pin/deviceName/pairingCode
 *    这四个 **JSON 键**。键的判据带冒号（`"pin":`）而非裸 `"pin"`：落地页有 `id="pin"`、
 *    `data-form="pin"` 这类 DOM 属性，裸串判据会永久红 —— 一个永久红的门禁等于没有门禁
 *    （与 design §1.1 拒采「非 403 即暴露」同一个理由）。
 * 隧道变体豁免状态码一致律（它按设计跳 `/consent`）。
 */
const PUBLIC = [
  { method: GET, path: '/' },
  { method: GET, path: '/sw.js' },
  { method: GET, path: '/consent' },
  { method: GET, path: '/reconnect' },
  { method: GET, path: '/disconnected' },
  { method: GET, path: '/bye' },
  { method: GET, path: '/pair' },
  { method: POST, path: '/pair/verify', body: {} },
  { method: POST, path: '/__diag', body: { message: 'check-exposure self-check' } }
]

const GRID = [
  ...PROTECTED.map((route) => ({ ...route, face: 'protected' })),
  ...DESKTOP.map((route) => ({ ...route, face: 'desktop' })),
  ...PUBLIC.map((route) => ({ ...route, face: 'public' }))
]

/**
 * 已知例外（AC1.9）：登记过的「看起来像漏洞、实际不是」的三条。只打 note，不计入判定。
 * 一条新例外想进这张表，必须带一行「为什么不算漏洞」。
 */
const KNOWN_PUBLIC = [
  {
    path: 'POST /__diag',
    why: '设计如此：引导页在手机上一错即死、桌面日志全静默，这条 200 是 sendBeacon 的失败现场上报，只写一行 client diag 进 pocket.log，不回显、不入库。'
  },
  {
    path: '/brand-logo/*, /app-icon',
    why: '未配对 401 但不跳 /consent，与其它受保护路径形态不同 —— 那是路由顺序（这两条在 consent 门之前），判「拒答」即可，形状差异不是漏洞。'
  },
  {
    path: 'GET /',
    why: '未配对 200 是设计：内网访问拿重连/落地页（说明「连不上」这件事本身），公开面，不含会话数据。'
  }
]

/**
 * 登记表：`lib/bridge.js` 里每一个 `url.pathname === '<字面量>'` 都必须在这里有名字。
 * 没登记的路由由 `findUnregistered()` 抓出来，**未登记本身就 CRITICAL**（2026-10-24 fixer 收紧：
 * 只按「GET 拿到 2xx」判红会给 POST 形新路由发静默绿 —— 新增一条 `POST /x` 时 GET 拿 404/405）。
 * 禁止通配：逐条字面量（通配等于给未来所有路由发通行证）；前缀路由另见 PREFIX_ROUTES。
 * `write` = 会改状态或需真凭证，工具**不测**（只登记，免得门禁自己成为破坏面）。
 */
const REGISTERED = {
  ...Object.fromEntries(PROTECTED.map((route) => [route.path, { face: 'protected', why: '受保护面（网格内测量）' }])),
  ...Object.fromEntries(DESKTOP.map((route) => [route.path, { face: 'desktop', why: '桌面面（网格内测量）' }])),
  ...Object.fromEntries(PUBLIC.map((route) => [route.path, { face: 'public', why: '公开面（网格内测量）' }])),
  // 登记但不进网格（网格固定 23 条；这些是「同类面里的其它成员」）：
  '/api/session-attachment': { face: 'protected', why: '附件读取，在 authorized() 之后' },
  '/api/session-file': { face: 'protected', why: '会话文件读取，在 authorized() 之后' },
  '/api/session-export': { face: 'protected', why: '会话导出，在 authorized() 之后' },
  '/api/session/stream': { face: 'protected', why: 'SSE 长连接，打一条会挂住；未配对必 401，与 /api/session/events 同族' },
  '/api/session/events': { face: 'protected', why: '轮询兜底，在 authorized() 之后' },
  '/brand-logo/dark': { face: 'protected', why: '与 /brand-logo/light 同分支，只差变体名' },
  '/desktop/device/extend': { face: 'desktop', why: '桌面会话写操作，未配对必 403' },
  '/desktop/device/permission': { face: 'desktop', why: '同上' },
  '/desktop/diagnostics': { face: 'desktop', why: '同上' },
  '/desktop/disconnect': { face: 'desktop', why: '同上' },
  '/desktop/notify': { face: 'desktop', why: '通知配置读写，未配对必 403' },
  '/desktop/notify/test': { face: 'desktop', why: '同上' },
  '/desktop/notify/clawbot/qr': { face: 'desktop', why: '同上' },
  '/desktop/notify/clawbot/status': { face: 'desktop', why: '同上' },
  '/desktop/notify/clawbot/reset': { face: 'desktop', why: '同上' },
  '/desktop/pair/confirm': { face: 'desktop', why: '同上' },
  '/desktop/pin/consent': { face: 'desktop', why: '同上' },
  '/desktop/pin/reset': { face: 'desktop', why: '同上' },
  '/desktop/revoke': { face: 'desktop', why: '同上' },
  '/desktop/tunnel/status': { face: 'desktop', why: '同上' },
  '/desktop/tunnel/toggle': { face: 'desktop', why: '同上' },
  '/pair/pending': { face: 'protected', why: '配对轮询，未配对必 401' },
  // DS Bot 页面（2026-10-24）：独立路由 + 独立脚本，都在 authorized() 之后（未配对 401，见
  // test/bot-page.test.js）。它不进网格：网格 23 条是既有页面，这两条是新增页面的文档与
  // 脚本，形状同 `/` 与 `/app.js`（文档 200、脚本按 hash 缓存），登记以声明「不是漏登记」。
  '/bot': { face: 'protected', why: 'DS Bot 页面文档，在 authorized() 之后，no-store' },
  '/bot.js': { face: 'protected', why: 'DS Bot 页面脚本，在 authorized() 之后，按内容 hash 寻址' },
  '/api/host/restart': { face: 'write', why: '会重启宿主；门禁绝不碰' },
  '/api/mobile-probe': { face: 'write', why: '手机滚动埋点上报（写日志），未配对必 401，不需要门禁去写一条' },
  '/consent/accept': { face: 'write', why: '会下发 consent cookie，是状态变更' },
  '/pair/retry': { face: 'write', why: '会更新配对重试计数' }
}

/**
 * 前缀路由：`lib/bridge.js` 用 `startsWith` 而不是 `===` 的两处。
 * `===` 字面量集合（AC1.6 的抽取口径）不含它们，这里显式登记，免得「前缀路由」被误读成
 * 「没登记也没事」。`/brand-logo/` 的下级变体由 `/brand-logo/light` 代表测量。
 *
 * **这张表是唯一的前缀放行来源**，`--self-test` 用下面 `PREFIX_ALLOWLIST` 逐字比对它的键。
 * 加一条合法前缀必须同时改两处（表里带 face/why，清单里只放键）—— 这是故意的双人复核：
 * 只改一处会直接红。键必须以 `/` 结尾：`'/desktop'` 这种无尾斜杠的宽前缀会吞掉
 * `/desktop/evil` 这类未来路由，正是 2026-10-24 P1 的形态（自检另有一条形状断言）。
 */
const PREFIX_ROUTES = {
  '/brand-logo/': { face: 'protected', why: '前缀路由，变体由 /brand-logo/light 代表测量' }
}

/** 已论证的前缀白名单（唯一合法键集）。见上：本清单与 PREFIX_ROUTES 必须逐字一致。 */
const PREFIX_ALLOWLIST = ['/brand-logo/']

// 不得为 `/desktop` 开豁免（2026-10-24 独立审查 P1，阻断项）：
// 桥里 notePhoneAgent 用 `!url.pathname.startsWith('/desktop')` 把桌面面板的请求排除在
// 「最后一台手机」之外（`lib/bridge.js:4144`），但 `/desktop` 自己是一条**真实路由**
// （`lib/bridge.js:4226` 的 `url.pathname === '/desktop'`，已作为网格第 70 行的登记项逐条在册）。
// 把这个前缀塞进上面那张表，`findUnregistered` 就会对任何命中的 `/desktop*` 前缀直接放行 ——
// 那正是本工具要堵的静默绿，而桌面面恰恰是真实数据面。
// 实测依据：删掉它之后，从 bridge 源码抽出的 48 条 `===` 字面量全部仍落在 23 + 26 = 49 个
// 登记键内，靠前缀才覆盖到的路径数 = 0，所以这次删除零影响。
// 将来若真要放行前缀，必须先进 REGISTERED 逐条字面量登记，不许在这里开口子；
// 自检里已钉死「前缀表只准有 /brand-logo/ 这一条」，加宽前缀会直接变红。

/** `RPC_ALLOWLIST` 基线（AC1.2）。多出任何一项 = CRITICAL + 打印差集；少项只 warning（收紧不算暴露）。 */
const RPC_BASELINE = [
  'agentPreset.list',
  'agentPreset.select',
  'bot.approval',
  'bot.earlier',
  'bot.team',
  'command.execute',
  'commands.list',
  'file.upload',
  'goals.clear',
  'goals.edit',
  'goals.pause',
  'goals.resume',
  'permissionPresets.catalog',
  'session.cancel',
  'session.create',
  'session.history',
  'session.list',
  'session.models',
  'session.projections',
  'session.prompt',
  'session.selectModel',
  'session.tails',
  'session.updateQueue',
  'settings.describe',
  'skills.list',
  'workspace.list',
  'workspace.pin',
  'workspace.unpin'
]

/** 本工具能发出的全部非 GET 请求。自证盯着这条「只读」承诺。 */
const POST_TARGETS = ['/api/rpc', '/pair/verify', '/desktop/pairing/rotate', '/__diag']

// ---------------------------------------------------------------------------
// 2. 判定器（纯函数；`--self-test` 一条条喂红/绿样例，保证它们不是摆设）
// ---------------------------------------------------------------------------

const LOGIN_SURFACE_RE = /^(?:https?:\/\/[^/]+)?\/(?:consent|reconnect)(?:[/?]|$)/

/** @returns {{verdict: 'ok'|'note'|'critical'|'missing', reason: string}} */
function judgeProtected(cell) {
  if (cell.error) return { verdict: 'missing', reason: `not measured: ${cell.error}` }
  const { status } = cell
  if (status >= 400 && status < 500) return { verdict: 'ok', reason: `${status} 拒答` }
  if (status >= 300 && status < 400) {
    return LOGIN_SURFACE_RE.test(cell.location ?? '')
      ? { verdict: 'ok', reason: `${status} -> ${cell.location}` }
      : { verdict: 'critical', reason: `受保护面重定向到未知目标 ${status} -> ${cell.location ?? '(无 location)'}` }
  }
  if (status >= 200 && status < 300) {
    return { verdict: 'critical', reason: `受保护面未配对返回 ${status}（未配对必须拒答，2xx 即出数据）` }
  }
  return { verdict: 'missing', reason: `不可判定：${status}（既不是拒答也不是暴露，不计入通过）` }
}

/** @returns {{verdict: 'ok'|'critical'|'missing', reason: string}} */
function judgeDesktop(cell) {
  if (cell.error) return { verdict: 'missing', reason: `not measured: ${cell.error}` }
  if (cell.status === 403) return { verdict: 'ok', reason: '403 Desktop only.' }
  return { verdict: 'critical', reason: `桌面面未配对返回 ${cell.status}（必须 403）` }
}

/** 公开面响应体里的禁用项。键判据带冒号，理由见 PUBLIC 上方注释。 */
function bodyLeaks(body) {
  const hits = []
  if (/dsh_[A-Za-z0-9]/.test(body)) hits.push('dsh_ cookie value')
  for (const key of ['token', 'pin', 'deviceName', 'pairingCode']) {
    if (body.includes(`"${key}":`)) hits.push(`"${key}":`)
  }
  return hits
}

/**
 * @param {{status?: number, body?: string, error?: string}} cell
 * @param {{status?: number}} honest
 * @param {{variant: string, path: string}} where
 * @returns {{verdict: 'ok'|'critical'|'missing', reason: string}}
 */
function judgePublic(cell, honest, where) {
  if (cell.error) return { verdict: 'missing', reason: `not measured: ${cell.error}` }
  const leaks = bodyLeaks(cell.body ?? '')
  if (leaks.length > 0) return { verdict: 'critical', reason: `公开面响应体漏数据：${leaks.join(', ')}` }
  if ((cell.status ?? 0) >= 500) return { verdict: 'critical', reason: `公开面 ${cell.status}（公开面不该 5xx）` }
  if (where.path === '/__diag') {
    const parsed = parseJson(cell.body ?? '')
    if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
      return { verdict: 'critical', reason: '/__diag 必须回 JSON 对象' }
    }
    const keys = Object.keys(parsed)
    if (keys.length !== 1 || keys[0] !== 'ok') {
      return { verdict: 'critical', reason: `/__diag 只许回 {"ok":bool}，实际键：${keys.join(', ')}（防回显注入）` }
    }
    return { verdict: 'ok', reason: `${cell.status} {"ok":${String(parsed.ok)}}` }
  }
  // 内网 400 / 隧道 401 expired 都算拒答，但必须打印：PIN 校验在内网被直接拒掉是一道真防线。
  if (where.path === '/pair/verify') return { verdict: 'ok', reason: `${cell.status}（PIN 校验拒答，形态随 connection mode 变）` }
  if (where.variant !== 'tunnel' && honest.status !== undefined && cell.status !== honest.status) {
    return {
      verdict: 'critical',
      reason: `Host 改变了公开面状态：honest ${honest.status} vs ${where.variant} ${cell.status}`
    }
  }
  return { verdict: 'ok', reason: `${cell.status}` }
}

/** @param {{actual: Set<string>|string[], baseline: string[]}} input */
function judgeWhitelist(input) {
  const baseline = new Set(input.baseline)
  const actual = new Set(input.actual)
  const extra = [...actual].filter((name) => !baseline.has(name)).sort()
  const missing = [...baseline].filter((name) => !actual.has(name)).sort()
  const verdict = extra.length > 0 ? 'critical' : missing.length > 0 ? 'note' : 'ok'
  const reason = extra.length > 0
    ? `多出 ${extra.length} 项（每多一项都是一条新的手机可调用入口）`
    : missing.length > 0
      ? `少了 ${missing.length} 项（收紧不算暴露，但要同步基线）`
      : `${actual.size} 项，与基线一致`
  return { extra, missing, verdict, reason }
}

/**
 * 从 bridge 源码抽 `url.pathname === '<字面量>'` 集合（AC1.6 的口径：只要 `===`）。
 * 单双引号都收：只认单引号时，`url.pathname === "/new-route"` 会从差集里整条消失 ——
 * 那是抽取器的静默盲区，与「给路由开后门」等价（2026-10-24 fixer 补）。
 */
function extractRouteLiterals(source) {
  const found = new Set()
  for (const match of source.matchAll(/url\.pathname\s*===\s*(?:'([^']+)'|"([^"]+)")/g)) {
    found.add(match[1] ?? match[2])
  }
  return found
}

/** @param {{literals: Set<string>, registered: Record<string, unknown>, prefixes?: Record<string, unknown>}} input */
function findUnregistered(input) {
  const prefixes = input.prefixes ?? {}
  return [...input.literals]
    .filter((path) => {
      if (Object.hasOwn(input.registered, path)) return false
      return !Object.keys(prefixes).some((prefix) => path.startsWith(prefix))
    })
    .sort()
}

/** 登记表禁用通配：一个 `*` 都不许有（前缀路由另用 PREFIX_ROUTES 显式登记）。 */
function findWildcards(registered) {
  return Object.keys(registered).filter((path) => path.includes('*'))
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 3. 网络：唯一伪造 Host 的写法（fetch 不行，Host 是 forbidden header）
// ---------------------------------------------------------------------------

/**
 * @param {{port?: number, base?: URL, method: string, path: string,
 *          headers: Record<string, string>, body?: unknown, timeoutMs?: number}} spec
 * @returns {Promise<{status?: number, location?: string, body?: string, error?: string}>}
 */
function rawRequest(spec) {
  return new Promise((resolve) => {
    const headers = { ...spec.headers }
    const payload = spec.body === undefined ? undefined : Buffer.from(JSON.stringify(spec.body), 'utf8')
    if (payload !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }
    const common = {
      method: spec.method,
      headers,
      // 这里**故意不写 `setHost`**：本机 node 24.15.0 实测两种取值等价（`setHost: true` 时显式
      // 给的 Host 照样原样送达，隧道变体仍是 303），Node 只在调用方没给 Host 时才自动补一个。
      // 但「默认不会覆盖」是版本行为、不是接口承诺，所以工具不靠它：每次跑都先用回显 server
      // 自证伪造确实送达（见 proveHostInjection），证不出来就 exit 1 —— 那一层才是判据。
      timeout: spec.timeoutMs ?? 3000
    }
    const options = spec.base
      ? { ...common, protocol: spec.base.protocol, hostname: spec.base.hostname, port: spec.base.port, path: spec.path }
      : { ...common, host: '127.0.0.1', port: spec.port, path: spec.path }
    const request = http.request(options, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        if (body.length < 400_000) body += chunk
      })
      response.on('end', () => resolve({ status: response.statusCode, location: response.headers.location, body }))
      response.on('error', (error) => resolve({ error: error.message }))
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', (error) => resolve({ error: error.message ?? String(error) }))
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

/**
 * Host 注入自证：起一个回显 `Host` 的小 server，把**四组变体的头各真发一次**，逐组比对回显。
 *
 * 为什么不能只看 `/manifest.json` 拿 303：`requestConnectionMode` 的隧道判据是
 * 「Host 是 *.trycloudflare.com **或** 带 cf-connecting-ip + cf-ray」，隧道变体两个 cf 头
 * 都带着，所以即使 Host 没送进去它照样 303 —— 那个读数**证明不了**注入生效。回显才证明。
 *
 * 为什么逐组而不是只发一次 attacker.example：只发一组只能证明「显式 Host 送得出去」，证明不了
 * evil / tunnel / lanip 三组**各自**真的带了头。三组一起退化成 honest 的副本时，那两列会安静地
 * 变成 honest 的复印件（假绿）—— 而假绿是这道工具唯一不能犯的错。
 * @returns {Promise<{ok: boolean, rows: Array<{variant: string, sent: string, echoed: string, ok: boolean}>, reason: string}>}
 */
function proveHostInjection() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      response.statusCode = 200
      response.setHeader('content-type', 'text/plain')
      response.end(String(request.headers.host ?? ''))
    })
    server.on('error', (error) => resolve({ ok: false, rows: [], reason: `回显 server 起不来：${error.message}` }))
    server.listen(0, '127.0.0.1', async () => {
      const echoPort = /** @type {import('node:net').AddressInfo} */ (server.address()).port
      const rows = []
      for (const variant of VARIANTS) {
        // 用回显端口生成头：honest/lanip 的 Host 里带端口，得和真正的连接端口自洽。
        const headers = variant.headers(echoPort)
        const cell = await rawRequest({ port: echoPort, method: GET, path: '/', headers })
        const echoed = (cell.body ?? '').trim()
        rows.push({ variant: variant.name, sent: headers.host, echoed, ok: !cell.error && echoed === headers.host })
      }
      server.close()
      const bad = rows.filter((row) => !row.ok)
      resolve({
        ok: bad.length === 0,
        rows,
        reason: bad.length === 0
          ? `${rows.length} 组伪造 Host 全部原样送达（${rows.map((row) => row.variant).join(' / ')}）`
          : bad.map((row) => `${row.variant} 送 ${row.sent ?? '(没送 Host)'}，服务端看到 ${row.echoed || '(空)'}`).join('；')
      })
    })
  })
}

// ---------------------------------------------------------------------------
// 4. 主流程
// ---------------------------------------------------------------------------

const VARIANTS = [
  { name: 'honest', headers: (port) => ({ host: `127.0.0.1:${port}` }) },
  { name: 'evil', headers: () => ({ host: 'attacker.example' }) },
  {
    name: 'tunnel',
    headers: () => ({
      host: 'abcd1234.trycloudflare.com',
      'cf-connecting-ip': '203.0.113.9',
      'cf-ray': '8ab-EXPOSURE'
    })
  },
  { name: 'lanip', headers: (port) => ({ host: `192.168.1.50:${port}` }) }
]

const USAGE = `用法：
  node tools/check-exposure.mjs                 # 进程内 ephemeral 端口（默认）
  node tools/check-exposure.mjs --verbose       # 逐格读数
  node tools/check-exposure.mjs --port 43127    # 打已存在的桥（只读）
  node tools/check-exposure.mjs --url <base>    # 打外部部署
  node tools/check-exposure.mjs --bridge-source <path>  # 换 bridge 源码抽取源（默认 lib/bridge.js）
  node tools/check-exposure.mjs --self-test     # 只跑判定器自证`

function parseArgs(argv) {
  const options = { port: 0, url: undefined, verbose: false, selfTest: false, bridgeSource: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--verbose') options.verbose = true
    else if (arg === '--self-test') options.selfTest = true
    else if (arg === '--bridge-source') {
      const raw = argv[i + 1]
      i += 1
      if (raw === undefined || raw === '') {
        return { error: '--bridge-source 需要一个文件路径，收到 undefined' }
      }
      options.bridgeSource = raw
    } else if (arg === '--port') {
      const raw = argv[i + 1]
      i += 1
      if (raw === undefined || !/^\d+$/.test(raw)) {
        return { error: `--port 需要一个非负整数，收到 ${JSON.stringify(raw)}` }
      }
      options.port = Number(raw)
    } else if (arg === '--url') {
      const raw = argv[i + 1]
      i += 1
      let parsed
      try {
        parsed = new URL(raw)
      } catch {
        return { error: `--url 需要一个 http(s) 地址，收到 ${JSON.stringify(raw)}` }
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: `--url 需要一个 http(s) 地址，收到 ${JSON.stringify(raw)}` }
      }
      options.url = parsed
    } else if (arg === '--help' || arg === '-h') {
      return { help: true }
    } else {
      return { error: `未知参数 ${JSON.stringify(arg)}` }
    }
  }
  return { options }
}

function runSelfTest() {
  const failures = []
  let samples = 0
  const check = (name, actual, expected) => {
    samples += 1
    if (actual !== expected) failures.push(`${name}: 期望 ${expected}，实得 ${actual}`)
  }
  const honest = { status: 200 }

  check('受保护面 200 → 红', judgeProtected({ status: 200, body: '{"x":1}' }).verdict, 'critical')
  check('受保护面 401 → 绿', judgeProtected({ status: 401, body: '' }).verdict, 'ok')
  check('受保护面 303→/consent → 绿', judgeProtected({ status: 303, location: '/consent?next=%2F' }).verdict, 'ok')
  check('受保护面 303→别处 → 红', judgeProtected({ status: 303, location: '/elsewhere' }).verdict, 'critical')
  check('受保护面 超时 → 不可判定', judgeProtected({ error: 'timeout' }).verdict, 'missing')
  check('桌面面 200 → 红', judgeDesktop({ status: 200 }).verdict, 'critical')
  check('桌面面 403 → 绿', judgeDesktop({ status: 403 }).verdict, 'ok')
  check('公开面 "token" 键 → 红', judgePublic({ status: 200, body: '{"token":"abc"}' }, honest, { variant: 'evil', path: '/sw.js' }).verdict, 'critical')
  check('公开面 dsh_ 值 → 红', judgePublic({ status: 200, body: 'dsh_abc' }, honest, { variant: 'evil', path: '/sw.js' }).verdict, 'critical')
  check('公开面 id="pin" → 绿（裸串误报护栏）', judgePublic({ status: 200, body: '<input id="pin">' }, honest, { variant: 'evil', path: '/sw.js' }).verdict, 'ok')
  check('evil 与 honest 状态不等 → 红', judgePublic({ status: 200 }, { status: 401 }, { variant: 'evil', path: '/sw.js' }).verdict, 'critical')
  check('evil 与 honest 状态相同 → 绿', judgePublic({ status: 200 }, honest, { variant: 'evil', path: '/sw.js' }).verdict, 'ok')
  check('隧道变体状态不同 → 绿（豁免）', judgePublic({ status: 303 }, honest, { variant: 'tunnel', path: '/' }).verdict, 'ok')
  check('/__diag 只回 ok → 绿', judgePublic({ status: 200, body: '{"ok":true}' }, honest, { variant: 'honest', path: '/__diag' }).verdict, 'ok')
  check('/__diag 回显额外键 → 红', judgePublic({ status: 200, body: '{"ok":true,"echo":"x"}' }, honest, { variant: 'honest', path: '/__diag' }).verdict, 'critical')

  const extra = judgeWhitelist({ actual: [...RPC_BASELINE, 'shell.exec'], baseline: RPC_BASELINE })
  check('白名单多一项 → 红', extra.verdict, 'critical')
  check('白名单差集定位 + shell.exec', extra.extra.join(','), 'shell.exec')
  check('白名单少一项 → 不红（收紧不算暴露）', judgeWhitelist({ actual: RPC_BASELINE.slice(1), baseline: RPC_BASELINE }).verdict, 'note')
  check('白名单一致 → 绿', judgeWhitelist({ actual: RPC_BASELINE, baseline: RPC_BASELINE }).verdict, 'ok')

  const synthetic = [
    "if (url.pathname === '/api/status') {}",
    "if (url.pathname === '/new-public-route') {}",
    "if (url.pathname.startsWith('/brand-logo/')) {}"
  ].join('\n')
  const literals = extractRouteLiterals(synthetic)
  check('抽字面量只收 === 口径', [...literals].sort().join(','), '/api/status,/new-public-route')
  // 抽取器不能只认单引号：双引号写法被漏掉时，那条路由对门禁等于不存在（静默盲区）。
  const doubleQuoted = extractRouteLiterals('if (url.pathname === "/new-double-quoted-route") {}')
  check('抽字面量双引号也收', [...doubleQuoted].join(','), '/new-double-quoted-route')
  check('未登记路由被抓出', findUnregistered({ literals, registered: { '/api/status': {} } }).join(','), '/new-public-route')
  check('前缀路由不算未登记', findUnregistered({
    literals: new Set(['/brand-logo/light']),
    registered: {},
    prefixes: PREFIX_ROUTES
  }).length, 0)
  check('登记表不许通配', findWildcards({ '/brand-logo/*': {}, '/ok': {} }).join(','), '/brand-logo/*')

  const postPaths = [...PROTECTED, ...DESKTOP, ...PUBLIC]
    .filter((route) => route.method === POST)
    .map((route) => route.path)
    .sort()
  check('非 GET 目标集合', postPaths.join(','), [...POST_TARGETS].sort().join(','))
  check('网格 23 条', GRID.length, 23)
  check('Host 变体 4 组', VARIANTS.length, 4)
  check('基线 28 项', RPC_BASELINE.length, 28)
  check('登记表无通配', findWildcards(REGISTERED).length, 0)
  // 前缀表本身也要钉死（2026-10-24 复查建议 + fixer 收紧）：宽前缀（如 '/api'）不带 `*`，
  // findWildcards 看不见它，只有白名单式的逐字比对才拦得住。
  // 比的是**键集**（排序后），不是单个拼接串，多条合法前缀也能表达；允许清单见 PREFIX_ALLOWLIST。
  check('前缀表只有已论证的那一条', Object.keys(PREFIX_ROUTES).sort().join(','), [...PREFIX_ALLOWLIST].sort().join(','))
  // 形状断言：无尾斜杠的宽前缀会吞掉同名前缀下的未来路由（'/desktop' → '/desktop/evil'，P1 形态）。
  check('前缀键必须以 / 结尾', Object.keys(PREFIX_ROUTES).every((prefix) => prefix.endsWith('/')), true)
  // --bridge-source：红态可指向 test/fixtures/ 的假 bridge 源，不必再为验接线去碰 lib/。
  check('--bridge-source 接受路径', parseArgs(['--bridge-source', 'test/fixtures/bridge-fixture.js']).options?.bridgeSource, 'test/fixtures/bridge-fixture.js')
  check('--bridge-source 缺参数 → 用法错', typeof parseArgs(['--bridge-source']).error, 'string')

  if (failures.length === 0) {
    console.log(`--self-test: 判定器自证通过（${samples} 个样例全部符合预期）→ exit 0`)
    console.log('  覆盖：受保护面 200/401/303 跳登录面/303 跳别处/超时；桌面面 200/403；')
    console.log('  公开面带 token 键/dsh_ 值/id="pin" 误报护栏/Host 变脸；隧道豁免；/__diag 回显；')
    console.log('  白名单多项/少项/一致；未登记路由抽取（单双引号）与兜底；登记表禁通配；')
    console.log('  前缀表与允许清单一致 + 尾斜杠形状；非 GET 目标集合；--bridge-source 解析；网格规模。')
    return 0
  }
  console.error(`--self-test: 判定器自证失败 ${failures.length} 条 → exit 1`)
  for (const failure of failures) console.error(`  - ${failure}`)
  return 1
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    console.log(USAGE)
    return 0
  }
  if (parsed.error) {
    console.error(`check-exposure: ${parsed.error}`)
    console.error(USAGE)
    return 1
  }
  const options = parsed.options
  if (options.selfTest) return runSelfTest()

  let bridge
  let port = options.port
  const base = options.url
  if (base === undefined && port === 0) {
    bridge = new LanMobileBridge({
      harnessUrl: () => 'http://127.0.0.1:19387',
      innerAuth: { ready: async () => undefined, invalidate: () => {} },
      locale: 'zh',
      pairingPinStore: { load: () => ({}), save: () => true },
      tunnelLog: () => {},
      port: 0
    })
    try {
      const snapshot = await bridge.start()
      port = snapshot.port
    } catch (error) {
      console.error(`check-exposure: 进程内桥起不来：${error?.message ?? error}`)
      return 1
    }
  }

  const criticals = []
  const notes = []

  try {
    const injection = await proveHostInjection()
    console.log('== 暴露姿态自检 ==')
    console.log(
      `桥：${base ? `外部 ${base.href}` : `127.0.0.1:${port}${bridge ? '（进程内 ephemeral，--port 0）' : '（已存在的桥，只读）'}`}`
    )
    if (!injection.ok) {
      console.error(`Host 注入自证失败：${injection.reason}`)
      console.error('  四组 Host 变体已经退化成同一组，本次读数不是证据 → exit 1')
      return 1
    }
    console.log(`Host 注入自证：${injection.reason}`)

    // --- 92 格 ------------------------------------------------------------
    /** @type {Array<{route: any, variant: string, cell: any, judged: any}>} */
    const rows = []
    for (const route of GRID) {
      for (const variant of VARIANTS) {
        const cell = await rawRequest({
          port: base ? undefined : port,
          base,
          method: route.method,
          path: route.path,
          headers: variant.headers(port),
          body: route.body,
          timeoutMs: 3000
        })
        const where = { variant: variant.name, path: route.path }
        const judged = route.face === 'protected'
          ? judgeProtected(cell)
          : route.face === 'desktop'
            ? judgeDesktop(cell)
            : judgePublic(cell, findHonest(rows, route.path), where)
        rows.push({ route, variant: variant.name, cell, judged })
        if (judged.verdict === 'critical') criticals.push(`${route.method} ${route.path} [${variant.name}] ${judged.reason}`)
        else if (judged.verdict === 'note') notes.push(`${route.method} ${route.path} [${variant.name}] ${judged.reason}`)
        if (options.verbose || judged.verdict === 'critical' || route.path === '/pair/verify') {
          console.log(
            `  ${pad(`${route.method} ${route.path}`, 32)} ${pad(variant.name, 8)} ${pad(String(cell.status ?? 'ERR'), 5)} ${pad(judged.verdict.toUpperCase(), 9)} ${judged.reason}`
          )
        }
      }
    }

    const missing = rows.filter((row) => row.judged.verdict === 'missing')
    console.log(
      `路径数 ${GRID.length} × Host 变体 ${VARIANTS.length} = ${GRID.length * VARIANTS.length} 格，NOT MEASURED = ${missing.length}`
    )
    console.log(
      `受保护面 ${PROTECTED.length} 条 / 桌面面 ${DESKTOP.length} 条 / 公开面 ${PUBLIC.length} 条（可判定 ${rows.length - missing.length}/${rows.length}）`
    )

    // --- Host 注入的隧道判据（AC1.3 明文要求）------------------------------
    const tunnelManifest = rows.find((row) => row.route.path === '/manifest.json' && row.variant === 'tunnel')?.cell
    if (tunnelManifest?.status === 401) {
      console.error('Host 注入未生效：隧道变体下 /manifest.json 拿到 401（应 303 → /consent）→ exit 1')
      return 1
    }

    // --- 白名单静态哨兵（AC1.2）------------------------------------------
    const whitelist = judgeWhitelist({ actual: RPC_ALLOWLIST, baseline: RPC_BASELINE })
    console.log(`RPC_ALLOWLIST ${RPC_ALLOWLIST.size} 项（基线 ${RPC_BASELINE.length}）：${whitelist.reason}`)
    for (const name of whitelist.extra) {
      console.error(`  + ${name}`)
      criticals.push(`RPC_ALLOWLIST 多出项 + ${name}`)
    }
    for (const name of whitelist.missing) console.log(`  - ${name}（基线多出；收紧不是暴露，但请同步基线）`)

    // --- 白名单动态探测：未配对 POST 每个名字 ------------------------------
    let rpcReached = 0
    let rpcUnmeasured = 0
    for (const name of [...RPC_ALLOWLIST].sort()) {
      const cell = await rawRequest({
        port: base ? undefined : port,
        base,
        method: POST,
        path: '/api/rpc',
        headers: { host: `127.0.0.1:${port}` },
        body: { method: name, payload: {} },
        timeoutMs: 3000
      })
      if (cell.error) {
        rpcUnmeasured += 1
        continue
      }
      if (cell.status >= 200 && cell.status < 300) {
        rpcReached += 1
        criticals.push(`白名单名 ${name} 未配对即在 /api/rpc 拿到 ${cell.status}`)
      } else if (cell.status === 400 && /sessionId|projections|result/.test(cell.body ?? '')) {
        criticals.push(`白名单名 ${name} 未配对返回 400 且带 harness 字段（跑到了 authorized() 之前）`)
      }
    }
    console.log(
      `白名单动态探测：${RPC_ALLOWLIST.size} 个名字 POST /api/rpc，未配对 2xx ${rpcReached} 条，不可测 ${rpcUnmeasured} 条`
    )

    // --- 未登记路由兜底（AC1.6）------------------------------------------
    const sourcePath = options.bridgeSource ?? join(ROOT, 'lib', 'bridge.js')
    let source
    try {
      source = readFileSync(sourcePath, 'utf8')
    } catch (error) {
      console.error(`check-exposure: 读不到 bridge 源码 ${sourcePath}：${error?.message ?? error}`)
      return 1
    }
    const literals = extractRouteLiterals(source)
    const unregistered = findUnregistered({ literals, registered: REGISTERED, prefixes: PREFIX_ROUTES })
    const sourceLabel = options.bridgeSource ?? 'lib/bridge.js'
    console.log(`未登记路由：${unregistered.length} 条（${sourceLabel} 的 === 字面量 ${literals.size} 条，已登记 ${Object.keys(REGISTERED).length} 条）`)
    for (const path of unregistered) {
      const cell = await rawRequest({
        port: base ? undefined : port,
        base,
        method: GET,
        path,
        headers: { host: `127.0.0.1:${port}` },
        timeoutMs: 3000
      })
      const status = typeof cell.status === 'number' ? cell.status : undefined
      const exposure = status !== undefined && status >= 200 && status < 300
        ? '2xx：未配对就出数据'
        : 'GET 看不到 POST 形路由'
      console.log(`  ? ${path} GET → ${status ?? 'ERR'}（未登记：全新 === 字面量必须显式登记；${exposure}）`)
      // 未登记本身即 CRITICAL（2026-10-24 fixer 收紧）：只按 GET 2xx 判红时，新增一条
      // `POST /x` 拿到 404/405 就是静默绿 —— 与 P1「前缀豁免」同一类「门禁看不见」。
      criticals.push(`未登记路由 ${path}（GET ${status ?? 'ERR'}；未登记本身即 CRITICAL，${exposure}）`)
    }
    for (const wildcard of findWildcards(REGISTERED)) criticals.push(`登记表出现通配 ${wildcard}`)

    // --- 已知例外（只打 note）--------------------------------------------
    console.log('已知例外（登记，不计入判定）：')
    for (const entry of KNOWN_PUBLIC) console.log(`  note ${entry.path} —— ${entry.why}`)
    const diagLine = source.split('\n').findIndex((line) => line.includes('client diag'))
    console.log(
      `  note /__diag 空白折叠正则（历史观察项）：现场重查 ${sourceLabel}:${diagLine + 1} 是 /\\s+/g，未复现 design 记载的 \\s+ 瑕疵；只记 note、不修（改 lib/ 与在途线相撞）。`
    )

    // --- 汇总 -------------------------------------------------------------
    if (criticals.length > 0) {
      console.error('')
      console.error(`CRITICAL ${criticals.length} 条：`)
      for (const line of criticals) console.error(`  ! ${line}`)
      console.error('critical')
      return 2
    }
    const protectedJudged = rows.filter(
      (row) => row.route.face === 'protected' && row.judged.verdict !== 'missing' && row.judged.verdict !== 'critical'
    ).length
    if (protectedJudged === 0) {
      console.error('')
      console.error(`SKIP：一条受保护面都没拿到可判定读数（NOT MEASURED ${missing.length}/${rows.length}），没测到不等于干净`)
      console.error('skip')
      return 3
    }
    if (notes.length > 0) console.log(`note ${notes.length} 条（不计入判定）`)
    console.log('clean')
    return 0
  } finally {
    if (bridge !== undefined) {
      try {
        await bridge.stop()
      } catch {
        // 自起的桥停不下来不该覆盖结论：进程退出时 socket 自然关闭。
      }
    }
  }
}

/** 同一路径的 honest 读数（公开面「Host 不得不改变状态」的比较基准）。 */
function findHonest(rows, path) {
  return rows.find((row) => row.variant === 'honest' && row.route.path === path)?.cell ?? {}
}

function pad(text, width) {
  return String(text).padEnd(width)
}

process.exitCode = await main()
