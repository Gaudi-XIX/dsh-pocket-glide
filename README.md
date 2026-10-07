# @defws/dsh-pocket

手机远程 DSH 桥（phone remote selfbuild）。**跑在宿主进程里的 DSH 插件**：桌面端侧栏「pocket」打开配对面板，
手机浏览器用二维码/连接密码配对后，经桥访问本机 DSH 会话——会话列表、历史、发送、流式回复、模型/preset 设置、
斜杠命令、附件上传、会话导出。局域网（LAN）直连与 Cloudflare quick tunnel 两条来路。

## 形态：插件，不是独立进程

- 入口 `lib/index.js` 只导出 `name='pocket'` / `inject=[]` / `apply(ctx, config)`（含 `export default apply`），
  **没有 main 守卫** ⇒ `node lib/index.js` 不是运行方式，装载只由宿主完成。
- 桥本身是**宿主进程内**的一个独立 `node:http` 监听（`LanMobileBridge.start()`），刻意不挂 `ctx.webServer`
  （宿主 web server 只绑 loopback， LAN 手机连不上）。它的启停随插件 `effect`：activation 起、dispose 全停
  （隧道、mux、socket）。
- 半区两块（`package.json` 声明，`cordis.patch.yml` 的头注同样说明）：
  - **node 半区**：桥、配对门禁、设备登记表、隧道管理、手机路由；并把桌面配对面
    （`/desktop`、`/brand-logo`）代理到应用 origin，好让 GUI 用同源 iframe 显示。
  - **浏览器半区**：`client/client.js`，经 `dsh.client.inject`（`@deepseek-ai/dsh-client-ui-slots` +
    `-ui-sidebar`）装载，只注册一件事——侧栏页脚「pocket」动作，点开就是上面那个内嵌 `/desktop`。
    它是源码直出的单文件，无构建产物。
- 所有手机页面也是宿主产出的纯 HTML 串（`lib/pages.js`），经桥自己的路由下发 ⇒ 本仓没有 React bundle、没有构建步骤。

## 端口与绑定

- 绑 `0.0.0.0`（局域网扫码需要），端口优先级：`DSH_MOBILE_PORT`（正整数才生效）→ 构造入参 `config.port`
  → 产品默认 **43127**。`config.port = 0` 表示 OS 随机端口，测试依赖它。
- 让号条件**只看端口号与尝试序号，不看值从哪来**（判据是 `lib/bridge.js` 的 `LanMobileBridge.start()` 里那句
  `error.code === 'EADDRINUSE' && (chosenPort === 43127 || chosenPort === 43128) && attempt === 0`，
  现取命令见本节末）。所以真话是：**只有 43127 与 43128、且只有第一次 `listen` 失败**才 `+1`
  （43127→43128、43128→43129）。推论两条：`DSH_MOBILE_PORT=43127` 一样会让到 43128；而 `DSH_MOBILE_PORT=8080`
  或显式传任何别的端口被占时**直接抛错**，不自作主张挪号（把 iframe 悄悄指向错端口比失败更糟）。
- 抛错时桥会在错误对象上**自己钉** `listenPort`/`listenErrno` 再往上抛：Node 的 listen 错误在
  `listen(port, '0.0.0.0')` 形态下 `err.port` 是**空串**（只有 `address`/`code`/`errno`/`syscall`），白嫖不到端口。
- 于是「桥还没起来」时应用内配对面板现在**会报端口与 errno**：`lib/index.js` 的 `describeListenFailure()` 只收
  合法端口区间 + `[A-Z][A-Z0-9_]*` 形态的 errno 枚举名（**不收 `error.message`** ⇒ 宿主路径/栈行进不了错误体），
  `notReadyBody()` 产出 `Pocket bridge is not ready (port 43128, EACCES).`；两个字段都不知道时仍是原句
  `Pocket bridge is not ready.`。代理上游连接失败那一条仍是 `Pocket bridge is unavailable.`（`lib/index.js`）。
- 实际端口以 `bridge.start()` 返回快照的 `snap.port` 为准，工具/测试一律从快照取端口、不硬编码。
  启动成功日志行：`Pocket bridge ready on 0.0.0.0:<port>`（`lib/index.js`）。
- ⚠️ Windows 造端口冲突时注意：**先占 `127.0.0.1:P` 再绑 `0.0.0.0:P` 会成功**（两者不互斥），要复现 `EADDRINUSE`
  必须占同一个 wildcard 地址。

现值不抄进正文，用可复跑命令取（第一条打出让号判据原文，第二条直接演示 `notReadyBody()` 的两种形状）：

```
node --input-type=module -e "import{readFileSync}from'node:fs';const s=readFileSync('./lib/bridge.js','utf8');const i=s.indexOf('const retryable');console.log(s.slice(i,i+250))"
node --input-type=module -e "import('./lib/index.js').then(m=>console.log(JSON.stringify([m.notReadyBody(undefined),m.notReadyBody({port:43128,errno:'EACCES'})])))"
```

## 路由面（桥自己的 server）

| 面 | 路由 |
|---|---|
| 手机页 | `GET /`（App 页）、`GET /pair`、`GET /reconnect`、`GET /disconnected`、`POST /pair/verify`、`POST /pair/retry`、`GET /pair/pending`、`GET /consent`、`POST /consent/accept` |
| 手机数据 | `GET /api/status`、`GET /api/boot`、`POST /api/rpc`、`GET /api/session/stream`（SSE）、`GET /api/session-attachment`、`GET|HEAD /api/session-export` |
| 静态件 | `GET /app.css`、`GET /app.js`（URL 带内容哈希）、`GET /sw.js`、`GET /brand-logo/{,dark}`、`GET /app-icon`、`GET /manifest.json` |
| 桌面配对面 | `GET /desktop`（含一次性 `?k=` bootstrap）、`GET /desktop/status`、`GET /desktop/tunnel/status`、`POST /desktop/pairing/rotate`、`POST /desktop/pin/{consent,reset}`、`POST /desktop/tunnel/toggle`、`POST /desktop/disconnect`、`POST /desktop/revoke`、`GET|POST /desktop/notify`、`POST /desktop/notify/test`、`GET|POST /desktop/tunnel/config`、`POST /desktop/pair/confirm` |

> 旧的 `/phone*` 路由族已退役，不再是本插件的接口面。
> 表录全量接口面；穷举判据是 `bridge.handle()` 的 `url.pathname` 判定（35 处路由判定 `pathname ===` +
  1 处 `startsWith('/brand-logo/')`）。修后本表 4 行录 33 条方法条目、覆盖 35 个路径实例
  （`/brand-logo/{,dark}` 与 `/desktop/pin/{consent,reset}` 各一条目覆盖两径、`GET|POST` 两条目各覆盖双方法）。

## RPC 方法面

`POST /api/rpc`（需 `dsh_mobile` cookie + 同源/Sec-Fetch 校验），JSON `{method,payload}`。白名单判定在
`lib/constants.js` 的 `RPC_ALLOWLIST`，转发形状在 `HARNESS_ENDPOINTS`；改这两个才是改接口，README 只是抄录：

- 会话/模型/设置类（转发宿主 Typert 端点）：`session.list`、`session.history`、`session.create`、
  `session.prompt`、`session.cancel`、`session.models`（→ `session/modelCatalog`）、`session.selectModel`、
  `workspace.list`、`settings.describe`、`agentPreset.list`、`agentPreset.select`、`permissionPresets.catalog`、`session.projections`（投影增量）
- 命令/附件类：`command.execute`（→ `commands/execute`，桥补 `{agentId, line, submittedAttachments}`）、
  `file.upload`（→ `fileUploads/upload`，回 `{receiptId, file}`）、`skills.list`、`commands.list`（斜杠面板目录）、`session.updateQueue`（排队管理）
- 桥本地方法（在白名单判定**之前**就地处理，不落宿主）：`interaction.pending`、`interaction.answer`、
  `interaction.cancel`（宿主 `user-questions/request` 的应答回路）
- 不在面上的方法一律 **403** `RPC method is not available on mobile.`；`session.prompt` 的 `requestId`
  由桥生成并**置于参数末尾**，客户端 payload 无法钉住或覆写它。

**body 上限分级**：普通方法 64KB（`MAX_BODY_BYTES`）；`file.upload`、`session.prompt`、`command.execute`、
`session.updateQueue` 用大档
`LARGE_BODY_BYTES = ceil(25MB × 1.4)`（计入 base64 4/3 膨胀）；method 键必须在最前 `RPC_METHOD_PROBE_BYTES`
（2KB）内出现，否则无法提前定档。超限 413 `Request body is too large.`。

## 缓存与压缩（分层，按现值）

**文档、SSE、附件、导出、`/sw.js` 一律 `no-store`，并且 origin 侧不开压缩**——这是刻意设计：
`LanMobileBridge.renderMobilePage`/`html()` 一带的注释记着 2026-10-01 两次事故（缓存/压缩把手机上的
文档弄脏过一次）。以下三处是**仅有的**长 `max-age` 例外，判据是「名字恒定或内容寻址」：

| 响应 | `cache-control`（现值） | 为什么可以给 |
|---|---|---|
| `/brand-logo/*` | `public, max-age=3600` | 路径恒定的品牌图；且已纳入鉴权门禁 |
| `/app-icon` | `public, max-age=86400` | 同上 |
| `/app.css`、`/app.js` | `private, max-age=604800` | URL 带内容哈希，内容变则名变，永不 serve 旧代码 |

其余响应由 `handle()` 开头统一打 `cache-control: no-store`，并带 `x-content-type-options: nosniff`、
`x-frame-options: DENY`、`referrer-policy: no-referrer` 与每请求随机 nonce 的 CSP。
品牌资源公开探测已被收口：`canReadBranding()` 只放「已配对手机」或「loopback + 桌面会话」，
**未配对的手机读 `/brand-logo/*` 与 `/app-icon` 得到 401**（这是刻意的，不为一个 logo 开未认证资源面）；
需要在配对之前就出图的那枚页面走桥传入的 `iconDataUri`（`renderPairingPinPage` 的 `icon` 形参那一支），
不硬编这两条路由。`/sw.js` 按设计保持公开（浏览器在拿到任何凭据之前就要取它，且它不含数据）。
禁开 gzip、禁给文档强缓存——`lib/bridge.js` 的注释记着 2026-10-01 的两次事故，本节不是建议而是边界。

## 安全模型

- **配对**：桌面「pocket」面板展示二维码与连接密码；一次性配对 token 短时有效、用后即焚。
  连接密码位数由 `lib/constants.js` 的 `PAIRING_PIN_DIGITS` 决定（**现值 8 位纯数字**，生成空间
  `PAIRING_PIN_SPACE = 10 ** PAIRING_PIN_DIGITS`）。一次性密码 `PIN_TTL_MS` = 5 分钟；
  开隧道时临时密码当场换新（`rotateEphemeralPinForTunnel()`），长效密码（`pinConsent`）跨隧道续用、不自动过期。
- **位数是跨文件量，改动必须整组走**：`PAIRING_PIN_MIN_DIGITS`/`PAIRING_PIN_MAX_DIGITS`（现值 6–12）加
  `PAIRING_PIN_PATTERN` 是 `lib/pin-store.js` 读写校验的唯一门 ⇒ **盘上存量 6 位密码零迁移继续可用**。
  手机侧那两枚 PIN 输入框（`renderPairingPinPage` 与 `renderMobileReconnectPage` 各一枚 `<input id="pin">`）
  现在是 `maxlength="12" pattern="\d{6,12}"`，**与 `PAIRING_PIN_PATTERN` 同域而不是恰好 8 位**，所以新发的 8 位密码
  和盘上的 6 位密码在同一个框里都打得进去（源码在模板串里把反斜杠写成 `\\d{6,12}`），配套文案也刻意不写死位数。
  **把这个框收窄成 `maxlength="8" pattern="\d{8}"` 就会造成现网配对失败**：桥发 8 位、拿着旧密码的手机卡在第 7 位，
  新配对接不上，重置长效密码等于把自己锁在门外。`test/pin-field-width.test.js` 正面钉住「6 位与 8 位都接受、13 位被拒」。
  改之前跑这两条：

```
node --input-type=module -e "import('./lib/constants.js').then(c=>console.log(c.PAIRING_PIN_DIGITS, c.PAIRING_PIN_SPACE, c.PAIRING_PIN_MIN_DIGITS, c.PAIRING_PIN_MAX_DIGITS, String(c.PAIRING_PIN_PATTERN)))"
node --input-type=module -e "import{readFileSync}from'node:fs';const s=readFileSync('./lib/pages.js','utf8');console.log(s.match(/<input id=.pin. inputmode[^>]*>/g))"
```

- **暴破限制**：错 PIN 计数 + 按 IP 限流（429 带 `Retry-After`，指数退避 `PIN_FAIL_BASE_SECONDS`→`PIN_FAIL_MAX_SECONDS`），
  到 `PIN_FAIL_HARD_LOCK` 次**硬锁定**（`PIN_FAIL_LOCKOUT_MS`），只能由桌面改密码或重启桥解除；
  限流键在 LAN 模式就是 socket 对端地址（隧道模式才取 `cf-connecting-ip`）。长效密码可随时在桌面面板重置/取消。
- **设备凭据**：每台手机独立 `dsh_mobile` 会话 cookie——`HttpOnly`、`SameSite=Strict`、
  `Max-Age=2592000`（30 天，`MOBILE_COOKIE_TTL_MS`；隧道 HTTPS 下追加 `Secure`）；有效期由服务端强制，
  页面只展示「本设备将于 … 失效」。桌面配对会话 `dsh_desktop` 是一个工作日档（`DESKTOP_COOKIE_TTL_MS` = 12h，
  `desktopCookieAttributes()` 现在把 `Max-Age=43200` 一起写出去，非 loopback 时同样加 `Secure`；过了这一档
  桌面重新兑换一次性的 `/desktop?k=` 链接）。
- **凭据隔离**：宿主内环凭证（`dsh-auth-` cookie / launch token）只存在于桥到宿主的服务端链路，
  **永不到达手机**；手机只持有 `dsh_mobile`，且只能调上面那张方法面。
- **SSE**：`/api/session/stream` 需 `dsh_mobile` + 可信来源；桥每 15s（`SSE_KEEPALIVE_MS`）写 `: ping` 保活，
  并每 30s（`SSE_STATUS_MS`）推连接状态帧；断线 EventSource 自动重连，快照对齐。`retry:` 不再是常量、
  以及载体丢失时补发的 `event: failure`，见下面「状态与错误面」那一节。
- 页面渲染所有外部文本均经 HTML 转义；无 eval / shell 拼接。

### 局域网（LAN）明文风险

WiFi/LAN 模式下手机与桥之间是**明文 HTTP**：同一网络内的其他设备可窃听或篡改流量，且无隧道端到端加密。
配对页与重连页在 LAN 模式下均显示双语风险提示。请仅在可信 Wi-Fi 下使用 LAN 模式；在不可信网络或需要保密时，
改用互联网（云隧道）模式。

## 状态与错误面（B1/B2 之后的现值）

### `GET /api/status` 与 SSE 的 `status` 帧是同一个 builder

负载由 `LanMobileBridge.buildStatusPayload()` 一处产出（`/api/status` 的响应体 = 每
`SSE_STATUS_MS`（30s）推下会话流的那帧，字节级同源），核心字段与语义（**非穷举**：表外还有
`tunnelProvider`/`tunnelExpiresAt`/`issuedAt`/`expiresAt`/`settings`，页面已消费其中两枚）：

| 字段 | 取值 | 含义 |
|---|---|---|
| `connected` | **恒 `true`** | 一直就只表示「这个桥答了」。取值与含义**一字未动**（旧页面还在读它） |
| `hostReachable` | `true` / `false` / **`null`** | 宿主（桌面端）在不在答。取自**本就在做**的那次 `cachedSettings` 往返（`hostReachability()`），零额外流量 |
| `hostProbeAgeMs` | 数字 / `null` | 那次观测距今多久（`null` = 从没观测过；探针老了它仍是数字，见下一条） |
| `hostProbeCode` | 字符串 / `null` | 失败类别（宿主不可达时含 `__bridge/transport`），就是「为什么不可达」的那半个答案；宿主在答时它是 `null` |
| `muxConnected` | `true` / `false` | 事件载体那条出站 WebSocket 在不在（`createMuxMonitor` 经 `reportMuxState` 上报） |
| `devicesConnected` | `true` / `false` | 有没有挂着手机（桌面面那个 `connected` 一直就是这个意思） |

- **`null` 是「未观测」，不得当 `false` 用**（`hostReachability()` 的两条 `null` 路径）：一次探针都还没做过，
  或者探针已经老过缓存窗口（现值 10s，与 `cachedSessionList` 的窗口对齐——那时 `hostReachable` 翻回 `null`，
  而 `hostProbeAgeMs`/`hostProbeCode` 仍带着上一次的值）。把 `null` 读成「宿主死了」就是再造一个假红。
- 「绿点 + 内容冻结」那对症状的两条腿现在分别叫 `hostReachable === false` 与 `connected === true`
  （桥活着、宿主没答）。
- **消费现值**：`hostReachable === false` 已被页面双臂消费——`/api/status` 轮询臂与 SSE 状态帧臂都把它
  翻译成连接灯的 degraded 态（aria-label「宿主未响应」）；`muxConnected` / `devicesConnected` 仍零命中
  （只有测试在读）。本节承诺「负载里有这些字段」；连接灯把 degraded 那半句兑现了，「绿点+冻结」的
  残留半句随这两个未读字段走。

现取字段清单（只读符号，不起桥；带凭据的两态负载见 `test/bridge-review.test.js` 的 `B2 X4⑤` 两档）：

```
node --input-type=module -e "import{readFileSync}from'node:fs';const s=readFileSync('./lib/bridge.js','utf8');const i=s.indexOf('async buildStatusPayload');console.log(s.slice(i,i+700))"
```

### `event: failure` 的三种 `code`

会话流 `/api/session/stream`（`lib/session-stream.js`）在 SSE 上发 `event: failure`，`data` 一定带 `code`，三种形态：

| 来源 | `data` | 含义 |
|---|---|---|
| 宿主自己下的 `error` 帧 | `{message, code}`（`code` 可能是宿主码，也可能 `undefined`） | 宿主答了并拒绝了这次 follow ⇒ 只日志，**不喂重连退避**（`host-error` 分支） |
| 载体丢失 | `{message, code:'__bridge/stream-transport', retryMs}` | 那条出站 WS 死了/连不上，宿主从没 `end` 过。帧后**紧跟一行** `retry: <n>`，下一次重连就照它等 |
| 服务端抑制 | `{message:'The Host is not accepting this stream yet.', code:'__bridge/stream-backoff', retryInMs}` | 从**第二次连续失败**起，比公布窗口更早到的请求不再转发给宿主。**首次失败永不拦**（人按一次刷新不受罚）；HTTP 状态码仍是 200 |

重连节奏不再是常量：`bridge.streamRetryDelayMs(sessionId)` = `STREAM_RETRY_BASE_MS × 2^连续失败数`，封顶
`STREAM_RETRY_CAP_MS`（现值 500ms → 15s）；从没失败过的会话**仍是 500ms**（健康路径字节不变）。

### 状态码面（B1 起对手机可见的四处契约变化）

- `/api/rpc` 的**transport 类**失败（`errorCode ∈ {__bridge/not-ready, __bridge/transport, __bridge/rpc-mismatch}`，
  见 `TRANSPORT_ERROR_CODES`）由 **400 改 502**：宿主不可达不是「你的请求不对」，且要与导出/附件路径同类同码。
- `/api/rpc` 的**入参**类失败是 400 + `errorCode:'__bridge/invalid-arguments'`（`readNumericArgument` 的越界值
  **不静默夹**，见 `HISTORY_PAGE_MAX_MESSAGES`/`SESSION_LIST_MAX_ROWS`）。
- `/desktop/tunnel/toggle` 的 **409 只剩 in-flight 一种**（`A tunnel switch is already in progress.`）；
  过去那种「还有设备挂着就不许切」的拒绝已撤。
- `/api/boot` 失败回 503 + 固定文案 `Boot failed.`（不再转写宿主内部错误原文）；导出/附件的宿主 5xx 同样泛化成 502。

## 环境变量

> 插件跑在宿主进程内 ⇒ 改这些变量的**生效方式是重启 DeepSeek Harness**，不是刷新页面。

| 变量 | 读点 | 语义 |
|---|---|---|
| `DSH_MOBILE_PORT` | `LanMobileBridge.start()` | 正整数才生效，压过 `config.port` 与默认 43127。让号与否**只看端口号**：取 `43127`/`43128` 时照样让一次，取别的端口被占就直接抛（见「端口与绑定」节） |
| `DSH_POCKET_DEBUG` | `lib/bridge.js`（文档体积报告处） | 仅 `=1` 时恢复体积报告；默认关。注意它只管这一处，boot/文档渲染行仍恒开 |
| `DSH_POCKET_CLOUDFLARED` | `resolveCloudflared()` | 本插件自己的 cloudflared 覆盖（绝对路径） |
| `DSH_PHONE_NATIVE_CLOUDFLARED` | 同上 | 上一代插件留下的兼容别名，仅作回落读取 |
| `CLOUDFLARED_BIN` | 同上 | 通用变量名，优先级低于 `DSH_POCKET_CLOUDFLARED` |
| `CLOUDFLARED_VERSION` | `tools/fetch-cloudflared.mjs` | **只对预置工具有效**，运行时不读它；非 pinned 值需再加 `--allow-unverified` |
| `DSH_HOME` | `lib/constants.js` 的 `defaultDshHome()`/`dshHomeOverridden()`（`lib/file-log.js` re-export 同一个） | 统一数据根。**设了它 = 隔离到底**（日志 + 长效密码 + 隧道缓存全部只认它，见「数据根」节）；**没设 = 只有日志落到 `~/.dsh/pocket/`**，密码与缓存留在机器原位 |
| `LOCALAPPDATA` / `XDG_CACHE_HOME` | `pin-store.js` 的 `legacyDataDir()`、`tunnel.js` 的 `preUnificationCacheDir()` | **仅在未设 `DSH_HOME` 时**是长效密码与 cloudflared 缓存的写根；设了 `DSH_HOME` 就整体不参与 |

## 数据根（一个解析器；写根与读根分开裁决）

解析规则只有一处，在 `lib/constants.js`：`defaultDshHome()` = `DSH_HOME?.trim() || ~/.dsh`、
`dshHomeOverridden()` = 有没有设 `DSH_HOME`、`pocketDataDir(…segments)` = `<统一根>/pocket/…`。
`lib/file-log.js` 改为取用它（并继续 re-export `defaultDshHome`，旧调用点不破）。

三份数据**怎么用**这条规则是刻意的不对称，不是一处漏改：

| 内容 | 设了 `DSH_HOME`（隔离跑法） | 没设（真机默认） |
|---|---|---|
| 文件日志 `pocket.log` | `<DSH_HOME>/pocket/logs/pocket.log` | `~/.dsh/pocket/logs/pocket.log` |
| 长效配对密码 `mobile-pairing-pin.json` | 只读写 `<DSH_HOME>/pocket/` | **写** `%LOCALAPPDATA%\dsh-pocket\`（非 Windows `~/.dsh-pocket/`，见 `legacyDataDir()`）；**读**先机器位、再兜底 `<统一根>/pocket/`（见 `pairingPinReadPaths()`） |
| cloudflared 懒下载缓存 | 只读写 `<DSH_HOME>/pocket/cloudflared/` | **写** `%LOCALAPPDATA%\dsh-pocket\cloudflared\`（非 Windows `$XDG_CACHE_HOME/dsh-pocket/cloudflared`，见 `preUnificationCacheDir()`）；**只读**沿用统一根与上一代的 `…\dsh-phone-native\cloudflared\`（见 `cloudflaredCacheCandidates()`） |

两条承诺同时成立，靠的正是「写根保持原位、统一根只当读兜底」：

- **隔离性**：设了 `DSH_HOME` ⇒ 读候选链**提前收成单元素**（`pairingPinReadPaths()` 与
  `cloudflaredCacheCandidates()` 都只回隔离那一条），既不读也不写机器位；
  `migrateLegacyCloudflaredCache()` 在 `dshHomeOverridden()` 为真时**整段跳过**——它原本用 `rename`
  搬家，那一步会把真机的缓存搬走。
- **不搬家**：没设时长效密码与隧道缓存留在它们今天所在的位置 ⇒ 已配对设备不掉线，那枚 pinned 件
  （本机实测 **54,893,480 字节**，时点 2026-10-03 04:0x +08:00；复刷=`Get-Item` 那条路径）既不重下也不被移走；
  而曾在隔离根下写过的密码，变量清掉后仍读得到（兜底那一 rung）。

**这就是为什么默认写根不能统一**：统一一次，测试与真机就共用同一枚 cloudflared 缓存目录。本卡实证过一遍——
把默认写根统一到 `~/.dsh/pocket` 之后，本仓自己的 `test/tunnel.test.js` 把一枚 17 字节的假 cloudflared 件
写进了真机 `~/.dsh/pocket/cloudflared/`，而且它排在解析链首位，下一次真隧道真的会用它。

两条规则各自的现值，用同一条命令对照着取（PowerShell 下先临时把 `DSH_HOME` 指到一个假根 = 隔离那一支；
`Remove-Item` 掉它 = 机器默认那一支。这条命令**只解析、不写任何文件**）：

```
$probe = "import('./lib/constants.js').then(async c=>{const p=await import('./lib/pin-store.js');console.log(JSON.stringify({overridden:c.dshHomeOverridden(),unified:c.pocketDataDir(),logDir:(await import('./lib/file-log.js')).defaultLogDir(),pinWrite:p.defaultDataDir(),pinReads:p.pairingPinReadPaths()},null,1))})"

node --input-type=module -e $probe                                    # 未设 DSH_HOME：写根在机器原位，读候选两条
$env:DSH_HOME = "F:\defws\tmp\fake-dsh-home"; node --input-type=module -e $probe   # 设了：全部收成隔离那一条
Remove-Item Env:DSH_HOME
```

隧道那侧的两个解析器是模块私有的（`cloudflaredCacheDir()` / `cloudflaredCacheCandidates()`），所以现值从符号取：

```
node --input-type=module -e "import{readFileSync}from'node:fs';const s=readFileSync('./lib/tunnel.js','utf8');console.log(s.match(/function (cloudflaredCacheDir|cloudflaredCacheCandidates)\(\) \{[\s\S]{0,200}/g).join('\n---\n'))"
```

## 日志（`pocket.log`，现值如实记载）

- 落点见「数据根」那张表：`<DSH_HOME 或 ~/.dsh>/pocket/logs/pocket.log`。行是 JSON（`t`/`level`/`message`），
  写入器 `lib/file-log.js` 的 `createFileLogger()`，**永不抛**（日志失败不许把插件带倒）。
- 轮转是**级联 3 代**（`ROTATIONS = 3`）：超过 `MAX_BYTES`（512KB）就把 `pocket.log`→`.1`→`.2`→`.3`
  逐代下压，最老一代丢弃。
- 驱动轮转的字节数**每行从磁盘重读**（`bytesOnDisk()` 用 `statSync`），不是在 logger 里累加。原因是宿主可以
  同时跑两个进程共享同一个 `pocket.log`：各自累加时双方都以为文件只有自己写的那点大，文件于是越过一切上限
  而无视。
- 每行先过**单行上限** `MAX_LINE_BYTES`（32KB）：超长行截断续写并计 `truncatedLines`，不整行丢弃。
- `rename` 失败**不把计数归零**（记 `rotationFailures`），下一条继续尝试轮转；轮转永久失败时文件涨到
  `MAX_CEILING_BYTES`（= `MAX_BYTES × 4`，即 2MB）封顶，此后**丢行**并计 `droppedLines`——丢行比占满磁盘轻。
- 可观测面：`logger.stats()` → `{bytes, rotationFailures, rotated, droppedLines, truncatedLines,
  writeFailures, lastWriteError}` 七字段（`bytes` 同样是磁盘现值；以 `lib/file-log.js` 的
  `PocketFileLoggerStats` typedef 为准）。
- `droppedLines` 的宿主侧出口**已有，粒度是 dispose 时汇总**：插件收尾时 `reportFileLogHealth()`
  （`lib/index.js`）读 `stats()` 上告一行 `pocket file log degraded: …`（含 droppedLines/truncatedLines/
  writeFailures），写失败另有 warn-once。不是逐条实时告警；要看实时，握着 logger 对象看 `stats()`。
  要改上限/代数/单行截断，改 `lib/file-log.js` 的 `MAX_BYTES`/`MAX_CEILING_BYTES`/`MAX_LINE_BYTES`/`ROTATIONS`。

现取那四个常量（模块私有常量，从符号取，不抄进正文）：

```
node --input-type=module -e "import{readFileSync}from'node:fs';const s=readFileSync('./lib/file-log.js','utf8');console.log(s.match(/const (MAX_BYTES|MAX_CEILING_BYTES|MAX_LINE_BYTES|ROTATIONS) = [^\n]+/g).join('\n'))"
```

## 云隧道（cloudflared quick tunnel）

- 二进制解析链（`lib/tunnel.js resolveCloudflared()`，**顺序即优先级**）：调用方 `binaryPath` →
  `DSH_POCKET_CLOUDFLARED` → `DSH_PHONE_NATIVE_CLOUDFLARED`（legacy）→ `CLOUDFLARED_BIN` →
  `<插件根>/vendor/cloudflared(.exe)` → 裸名 `cloudflared`（PATH；查不到就进懒下载）。
- 运行时**钉一个发布版并校 SHA-256**：`CLOUDFLARED_VERSION`（现值 `2026.8.2`）+ 六平台摘要表
  `tunnel.js ASSETS`。下载件落在上面那张缓存表里的 cloudflared 目录；上一代插件（`dsh-phone-native`）的缓存目录
  是**一次性 `rename` 迁移**过来，而它只在**未设 `DSH_HOME`** 时跑——隔离跑法下旧位置改成**只读复用**，
  不搬（`migrateLegacyCloudflaredCache()` 的那道 `dshHomeOverridden()` 短路）。
- 想把二进制**预置**进仓（省掉首次开隧道时的下载）：`node tools/fetch-cloudflared.mjs`。
  它写出的文件名就是解析链要查的 `vendor/cloudflared(.exe)`（不是发布件原名），版本与摘要都从
  `lib/tunnel.js` 里读，不自己另抄一份，下载后必校摘要、不符即删。先看契约不联网：`--print`。
  `vendor/` 已在 `.gitignore` 内。macOS 的发布件是 `.tgz`，与「裸可执行件」这一契约不符——那条路交给运行时懒下载。
- quick tunnel URL 每次启动都可能变，隧道重建后手机要用新址。

### Named tunnel（token 模式，固定主机名）

- 桌面面板可配 Cloudflare tunnel token + hostname（`GET|POST /desktop/tunnel/config`，经
  `lib/settings-store.js` 原子落盘 `0600`）。两者齐且 hostname 形状合法（`isValidTunnelHostname`）时走
  `cloudflared tunnel run --token`，URL 固定为 `https://<hostname>`。
- **token 模式下本地转发目标由 Zero Trust 面板的 ingress 决定，不是桥端口**：ingress 必须指向
  `http://127.0.0.1:<桥端口>`（桥端口可能让位 43128 或被 `DSH_MOBILE_PORT` 覆盖，见「端口与绑定」）。
  配置错了隧道照样显示在线、手机全部 502——online 日志里带这句提示（`lib/tunnel.js`）。
- hostname 上限与 QR 容量的推导关系见 `lib/qr-svg.js` 容量常量注释与 `lib/settings-store.js`（配对 URL
  要塞进一枚 QR），现值用可复跑命令取，不在本文硬编。

## 装到 profile（junction 桥接）

```
node tools/install-to-profile.mjs --dry-run     # 只看会写什么
node tools/install-to-profile.mjs               # 写 dependencies + dsh.profile.bundles 两处
node tools/install-to-profile.mjs --install     # 写完后顺带跑 pnpm install
```

脚本先做 preflight（源树四件齐不齐、链接路径与脚本所在树是否同一棵树、profile `package.json` 能否解析），
不合格**一个字节都不写**；写之前先落 `package.json.bak-before-pocket-<yyyymmdd>` 备份，写完回读复核两条目都在。
默认**不**跑 `pnpm install`（登记了却没装成，就是半改态）。之后必须**重启 DeepSeek Harness**——
本版宿主不做新 bundle 热挂载，且 `link:` 是 junction，改源码同样要重启才生效。

## 测试与工具

```
node --test --test-concurrency=1 test/*.test.js   # test/ 套件（真桥 + 假宿主，npm test 同此）
node test-real-webserver.mjs                      # 官方 dsh-host-webserver 真装载集成件（见其头注）
node tools/smoke-bridge.mjs                       # 自起桥实例：桌面 bootstrap/门禁/未配对拒绝/状态形状
node tools/smoke-pairing.mjs                      # 配对 → dsh_mobile cookie → 设备可见性闭环
node tools/gen-qr-fixtures.mjs                    # 重生成 test/fixtures/qr-matrices.json（dev-only，需 qrcode 包）
node tools/render-stub.mjs                       # 渲染桩：真实页面资产+桩数据起本地服务（默认 127.0.0.1:4399），浏览器手机视口目验
```

- 两个 smoke 脚本各自起独立桥实例并从 `start()` 快照取端口寻址；它们启停的是本地 HTTP 监听，不出网。
  端口让位是有条件的：43127 被在役桥占住时它 +1 到 43128；若 43127 与 43128 **都**被占，`start()` 直接抛错。
- 根上的 `test-real-webserver.mjs` 是**集成件**：它加载官方 payload 里的 `dsh-host-webserver` 与 `cordis`，
  把本插件按真实 cordis 装载链（`apply()` → `ctx.inject(['connection','webServer'])` → `webServer.register`）
  装上去，验注册形状被官方 `register()` 接受、重复 `(kind,path)` 抛错、插件只占 `/desktop` 与 `/brand-logo`
  两个前缀、dispose 后路由消失、未注册路径仍 404。它**不在 `test/*.test.js` glob 里**（跑它会起真监听），
  所以 `npm test` 不含它；入口是 `npm run test:real-webserver`。它要求官方 payload 的解包件在场，
  路径可用 `DSH_OFFICIAL_MODULES` 覆盖；不在场就 fail-loud 退出并告诉你缺哪个文件。
- 实机 UI 审计（触摸目标/对比度/回流）不在本仓，走工作区 `tmp/phone-e2e/` 那套脚本。
- **模板字符串注释地雷**：`lib/pages.js` 的页面脚本区是一个大模板字符串资产。区内（包括注释里）
  写反引号或 `${` 插值序列会提前终止字面量 → 整资产 SyntaxError、多个测试文件同瞬全红。撞上时
  红名就是方向：先查最近改过的**注释**，不是产品逻辑（R1 卡 apply 期真实踩中一次，现有测试即
  防线——教训入档于此，别再靠当轮自捕）。
- **镜像/变异测试的模块解析前置**：本仓测试解析仓内 `node_modules`（`pngjs` 等，reconnect-icon
  实证）。任何用于变异测试或并行验证的**镜像副本必须放在交付仓树内**（或显式给镜像一个可解析
  的模块根）——镜像放在仓外（如工作区 `tmp/`）时 `require` 解析不到仓内依赖，报的是**假失败**，
  会被误读成产品回归（R2 前身卡 verify 轮为此烧掉一整轮诊断）。
- **渲染桩与线上探针（tools/render-stub.mjs / probe-updatequeue.mjs / red-check.mjs）**：render-stub
  服务 `lib/pages.js` 真实渲染资产+罐头 RPC/SSE 桩数据，起服务后浏览器（手机视口 390×844）目验，免宿主
  重启；桩数据/端口/pendingQuestion 桩态在文件头 CONFIG 对象，换场景改那里。probe-updatequeue 打 live 桥
  实测（产品默认端口 43127；token 从 mobile-sessions.json 读、只进 Cookie 不打印）。**桥无会话 delete 通道：
  每次探针在 defws 工作区残留一条不可删除的会话**——探针会话标题统一带 `[pocket-probe]` 前缀（实机核验：宿主派生标题剥掉方括号），清理由用户
  在 DSH 主界面按标记词 `pocket-probe` 筛选后手动删除（探针前先向用户披露残留）。red-check 是断言强化的红形态验证器
  （extractFunction 抽真函数+沙盒+回归模拟），可作同类验证的模板。

## 打包与许可

- `package.json files` = `lib/**/*.js`、`client/**/*.js`、`test`、`tools`、`cordis.patch.yml`、`README.md`、
  `LICENSE`、`CHANGELOG.md`。本机装机是 `link:` **junction**，白名单只对发布态（`npm pack`/publish）生效，不影响装机态；
  列全 `test`/`tools` 的意义是：发布件里 `npm test` 与 README 承诺的工具面真能跑。
- 许可 Apache-2.0，正文见 `LICENSE`。
- 版本策略：现值 `0.3.0`。逐版的**对外变化**（修复 / 契约变更 / 已知边界）见根 `CHANGELOG.md`；
  更细的逐笔施工账在 `git log` 与 flow change 卡里。从 `0.2.0` 起本仓维护这份 CHANGELOG，
  README 承诺的是「它存在且跟着版本走」，不承诺它随每一笔提交更新。

## 已知边界

- PWA：manifest 已挂——`<link rel="manifest">` → `/manifest.json`（配对门禁后可取，`renderManifestJson()`）。
  Service Worker 注册失败时本会话静默停用（sessionStorage 去重、下次访问重试），无用户可见提示。
- 那个「假服务注册」已经删掉了：入口不再向宿主声明这枚 `pocket` 服务（它从来没被 `provide` 过，也没有任何
  消费方），启停改用双臂 `then(onFulfilled, onRejected)` ⇒ **`bridge failed to start` 现在只可能来自 `start()`
  真的被拒**，成功路径不再刷一堆假错误进日志。判据在 `test/index-service.test.js`。
  （这一节以前把它列为「已知边界」，那句话现在已经不成立，故从边界清单里移除。）
- **未修的残留限制**（都在 change `2026-10-02-fix-pocket-audit-remediation` 登记为候选，别读成已解决）：
  - 「绿点 + 冻结」的 degraded 半句已上页面（连接灯三态，见「状态与错误面」一节）；`muxConnected` /
    `devicesConnected` 两字段页面侧仍未读。
  - `droppedLines` 的宿主侧出口已有（dispose 时 `reportFileLogHealth()` 汇总上告，见「日志」一节）；逐条实时告警仍没有。
  - 宿主被**硬杀**时 `process.on('exit')` 不跑 ⇒ cloudflared 子进程可能留孤儿；闭合它需要「本桥 pid sidecar +
    镜像名校验」，**不能按镜像名扫杀**（那会打到别人为别的端口跑的隧道）。
  - 会话级载体 WS 复用没做（本卡选了「退避」那一支）。`_sessionCursors` 现按 `SESSION_CURSOR_MAX`（128）
    LRU 淘汰、读时重插（`capSessionCursors()`）——原先「运行中既不淘汰也不刷新」的陈述已随实现翻转，此处存档。
- **刻意代价（不是缺陷）：进入「一条都还没画出来」的会话会多发一次头页请求**。触发面＝每次进入一个缓冲为空的会话，含全新空会话：页面侧 `fetchOlderPage()` 遇到 `anchorSeq<0` 按「从头拉」处理，发一条**不带 `beforeSeq`** 的 `session.history`（`maxMessages: 30`）去铺第一页；`ensureTranscriptFilled()` 的空转录自举循环因此会先走这一条。**为什么可接受**：这一条请求本身就是空缓冲会话唯一的自举路径，去掉它「加载更多」就没有出口；它拿到的是最新一页，且两道门都不会让它空转——页面侧 `ensureTranscriptFilled()` 用 `count()<=before` 判「没多出消息就停」，桥侧 `LanMobileBridge.forwardRpc` 的 `session.history` 分支在不带 `beforeSeq` 时保留三级阶梯护栏（`pageRequests` 三种形状）。行为锁在 `test/stream-watermark.test.js` 的 `AC-A6 an empty buffer pulls the head page without beforeSeq` 与 `test/transcript-order.test.js` 的头页用例里。
- 一切页面/桥侧改动的上线方式都是「改完 → 用户重启 DSH → 手机上目验」，中途不催重启。
- 通知出站的 wxpusher 通道是 **shape-only 发送**：POST 体只带 `appToken`/`summary`/`content`/`contentType`（=1 文本），不带
  `uid`/`tagIds`，而 WxPusher 的业务错误随 HTTP 200 返回——桥只判 `response.ok`，对面没收到也可能记
  「已送达」（Server酱/Bark 走 URL 判 2xx，无此嫌疑）。真机通道实测待做；坐实另开修复卡。
