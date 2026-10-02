# @defws/dsh-pocket

手机远程 DSH 桥（phone remote selfbuild）。**跑在宿主进程里的 DSH 插件**：桌面端侧栏「连接手机」打开配对面板，
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
    `-ui-sidebar`）装载，只注册一件事——侧栏页脚「连接手机」动作，点开就是上面那个内嵌 `/desktop`。
    它是源码直出的单文件，无构建产物。
- 所有手机页面也是宿主产出的纯 HTML 串（`lib/pages.js`），经桥自己的路由下发 ⇒ 本仓没有 React bundle、没有构建步骤。

## 端口与绑定

- 绑 `0.0.0.0`（局域网扫码需要），端口优先级：`DSH_MOBILE_PORT`（正整数才生效）→ 构造入参 `config.port`
  → 产品默认 **43127**。`config.port = 0` 表示 OS 随机端口，测试依赖它。
- `EADDRINUSE` 的 +1 重试是**有界的**：仅当端口正是 43127 或 43128、且是第一次尝试时才换 `port+1`
  （即 43127→43128、43128→43129）。设了 `DSH_MOBILE_PORT` 或显式传了别的端口时**直接抛错**，不自作主张挪号。
- 实际端口以 `bridge.start()` 返回快照的 `snap.port` 为准，工具/测试一律从快照取端口、不硬编码。
  启动成功日志行：`Pocket bridge ready on 0.0.0.0:<port>`（`lib/index.js`）。
- 桥还没起来时，应用内配对面板只见 `Pocket bridge is not ready.`／`Pocket bridge is unavailable.`
  ——这两条错误体**不含端口与 errno**（把端口/errno 写进错误体属行为改动，本卡另行处置）。

## 路由面（桥自己的 server）

| 面 | 路由 |
|---|---|
| 手机页 | `GET /`（App 页）、`GET /pair`、`GET /reconnect`、`GET /disconnected`、`POST /pair/verify`、`POST /pair/retry` |
| 手机数据 | `GET /api/status`、`GET /api/boot`、`POST /api/rpc`、`GET /api/session/stream`（SSE）、`GET /api/session-attachment`、`GET|HEAD /api/session-export` |
| 静态件 | `GET /app.css`、`GET /app.js`（URL 带内容哈希）、`GET /sw.js`、`GET /brand-logo/{,dark}`、`GET /app-icon` |
| 桌面配对面 | `GET /desktop`（含一次性 `?k=` bootstrap）、`GET /desktop/status`、`GET /desktop/tunnel/status`、`POST /desktop/pairing/rotate`、`POST /desktop/pin/{consent,reset}`、`POST /desktop/tunnel/toggle`、`POST /desktop/disconnect`、`POST /desktop/revoke` |

> 旧的 `/phone*` 路由族已退役，不再是本插件的接口面。

## RPC 方法面

`POST /api/rpc`（需 `dsh_mobile` cookie + 同源/Sec-Fetch 校验），JSON `{method,payload}`。白名单判定在
`lib/constants.js` 的 `RPC_ALLOWLIST`，转发形状在 `HARNESS_ENDPOINTS`；改这两个才是改接口，README 只是抄录：

- 会话/模型/设置类（转发宿主 Typert 端点）：`session.list`、`session.history`、`session.create`、
  `session.prompt`、`session.cancel`、`session.models`（→ `session/modelCatalog`）、`session.selectModel`、
  `workspace.list`、`settings.describe`、`agentPreset.list`、`agentPreset.select`、`permissionPresets.catalog`
- 命令/附件类：`command.execute`（→ `commands/execute`，桥补 `{agentId, line, submittedAttachments}`）、
  `file.upload`（→ `fileUploads/upload`，回 `{receiptId, file}`）、`skills.list`、`commands.list`（斜杠面板目录）
- 桥本地方法（在白名单判定**之前**就地处理，不落宿主）：`interaction.pending`、`interaction.answer`、
  `interaction.cancel`（宿主 `user-questions/request` 的应答回路）
- 不在面上的方法一律 **403** `RPC method is not available on mobile.`；`session.prompt` 的 `requestId`
  由桥生成并**置于参数末尾**，客户端 payload 无法钉住或覆写它。

**body 上限分级**：普通方法 64KB（`MAX_BODY_BYTES`）；`file.upload`、`session.prompt` 用大档
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
`/sw.js` 按设计保持公开（浏览器在拿到任何凭据之前就要取它，且它不含数据）。

## 安全模型

- **配对**：桌面「连接手机」面板展示二维码与连接密码；一次性配对 token 短时有效、用后即焚。
  连接密码位数由 `lib/constants.js` 的 `PAIRING_PIN_DIGITS` 决定（**现值 6 位纯数字**；本卡的 B1/M8 正在把它提到
  8 位以上，届时这行随动，README 只把符号锚当权威）。`PAIRING_PIN_MIN_DIGITS`/`PAIRING_PIN_MAX_DIGITS` 允许
  磁盘上更旧或更长的密码继续可用，升强度不把已配对手机踢下线。一次性密码 `PIN_TTL_MS` = 5 分钟。
- **暴破限制**：错 PIN 计数 + 按 IP 限流（429 带 `Retry-After`，指数退避 `PIN_FAIL_BASE_SECONDS`→`PIN_FAIL_MAX_SECONDS`），
  到 `PIN_FAIL_HARD_LOCK` 次**硬锁定**（`PIN_FAIL_LOCKOUT_MS`），只能由桌面改密码或重启桥解除；
  限流键在 LAN 模式就是 socket 对端地址（隧道模式才取 `cf-connecting-ip`）。长效密码可随时在桌面面板重置/取消。
- **设备凭据**：每台手机独立 `dsh_mobile` 会话 cookie——`HttpOnly`、`SameSite=Strict`、
  `Max-Age=2592000`（30 天，`MOBILE_COOKIE_TTL_MS`；隧道 HTTPS 下追加 `Secure`）；有效期由服务端强制，
  页面只展示「本设备将于 … 失效」。桌面配对会话 `dsh_desktop` 是一天半档（`DESKTOP_COOKIE_TTL_MS` = 12h，
  非 loopback 时同样加 `Secure`）。
- **凭据隔离**：宿主内环凭证（`dsh-auth-` cookie / launch token）只存在于桥到宿主的服务端链路，
  **永不到达手机**；手机只持有 `dsh_mobile`，且只能调上面那张方法面。
- **SSE**：`/api/session/stream` 需 `dsh_mobile` + 可信来源；桥每 15s（`SSE_KEEPALIVE_MS`）写 `: ping` 保活，
  并每 30s（`SSE_STATUS_MS`）推连接状态帧；断线 EventSource 自动重连，快照对齐。
- 页面渲染所有外部文本均经 HTML 转义；无 eval / shell 拼接。

### 局域网（LAN）明文风险

WiFi/LAN 模式下手机与桥之间是**明文 HTTP**：同一网络内的其他设备可窃听或篡改流量，且无隧道端到端加密。
配对页与重连页在 LAN 模式下均显示双语风险提示。请仅在可信 Wi-Fi 下使用 LAN 模式；在不可信网络或需要保密时，
改用互联网（云隧道）模式。

## 环境变量

> 插件跑在宿主进程内 ⇒ 改这些变量的**生效方式是重启 DeepSeek Harness**，不是刷新页面。

| 变量 | 读点 | 语义 |
|---|---|---|
| `DSH_MOBILE_PORT` | `LanMobileBridge.start()` | 正整数才生效，压过 `config.port` 与默认 43127；此路设值时端口被占**不重试** |
| `DSH_POCKET_DEBUG` | `lib/bridge.js`（文档体积报告处） | 仅 `=1` 时恢复体积报告；默认关。注意它只管这一处，boot/文档渲染行仍恒开 |
| `DSH_POCKET_CLOUDFLARED` | `resolveCloudflared()` | 本插件自己的 cloudflared 覆盖（绝对路径） |
| `DSH_PHONE_NATIVE_CLOUDFLARED` | 同上 | 上一代插件留下的兼容别名，仅作回落读取 |
| `CLOUDFLARED_BIN` | 同上 | 通用变量名，优先级低于 `DSH_POCKET_CLOUDFLARED` |
| `CLOUDFLARED_VERSION` | `tools/fetch-cloudflared.mjs` | **只对预置工具有效**，运行时不读它；非 pinned 值需再加 `--allow-unpinned` |
| `DSH_HOME` | `lib/file-log.js` 的 `defaultDshHome()` | 目前**只有日志根**认它（见下节） |
| `LOCALAPPDATA` / `XDG_CACHE_HOME` | `pin-store.js` / `tunnel.js` | 长效密码与 cloudflared 缓存的落盘基准 |

## 数据根与日志（现值如实记载）

| 内容 | 解析点 | Windows 现值 | 其它平台 |
|---|---|---|---|
| 长效配对密码 `mobile-pairing-pin.json` | `pin-store.js defaultDataDir()` | `%LOCALAPPDATA%\dsh-pocket\` | `~/.dsh-pocket/` |
| cloudflared 懒下载缓存 | `tunnel.js cloudflaredCacheDir()` | `%LOCALAPPDATA%\dsh-pocket\cloudflared\` | `$XDG_CACHE_HOME/dsh-pocket/cloudflared` |
| 文件日志 `pocket.log` | `file-log.js defaultLogDir()` | `<DSH_HOME 或 ~/.dsh>/pocket/logs/` | 同左 |

**注意这三处并不同根**：只有日志认 `DSH_HOME`，另两处走 `%LOCALAPPDATA%`/`XDG_CACHE_HOME` ⇒ 以 `DSH_HOME`
做的「隔离跑法」**仍会读写真机的长效配对密码文件**。统一解析属桥域改动（本 README 只负责把现状写清）。
日志是 JSON 行（`t`/`level`/`message`），超过 `MAX_BYTES`（512KB）轮转一次成 `pocket.log.1`（不留更多代数）。

## 云隧道（cloudflared quick tunnel）

- 二进制解析链（`lib/tunnel.js resolveCloudflared()`，**顺序即优先级**）：调用方 `binaryPath` →
  `DSH_POCKET_CLOUDFLARED` → `DSH_PHONE_NATIVE_CLOUDFLARED`（legacy）→ `CLOUDFLARED_BIN` →
  `<插件根>/vendor/cloudflared(.exe)` → 裸名 `cloudflared`（PATH；查不到就进懒下载）。
- 运行时**钉一个发布版并校 SHA-256**：`CLOUDFLARED_VERSION`（现值 `2026.8.2`）+ 六平台摘要表
  `tunnel.js ASSETS`。下载件落在上面那张缓存表里的 cloudflared 目录；上一代插件的缓存目录会一次性迁移过来。
- 想把二进制**预置**进仓（省掉首次开隧道时的下载）：`node tools/fetch-cloudflared.mjs`。
  它写出的文件名就是解析链要查的 `vendor/cloudflared(.exe)`（不是发布件原名），版本与摘要都从
  `lib/tunnel.js` 里读，不自己另抄一份，下载后必校摘要、不符即删。先看契约不联网：`--print`。
  `vendor/` 已在 `.gitignore` 内。macOS 的发布件是 `.tgz`，与「裸可执行件」这一契约不符——那条路交给运行时懒下载。
- quick tunnel URL 每次启动都可能变，隧道重建后手机要用新址。

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

## 打包与许可

- `package.json files` = `lib/**/*.js`、`client/**/*.js`、`test`、`tools`、`cordis.patch.yml`、`README.md`、
  `LICENSE`。本机装机是 `link:` **junction**，白名单只对发布态（`npm pack`/publish）生效，不影响装机态；
  列全 `test`/`tools` 的意义是：发布件里 `npm test` 与 README 承诺的工具面真能跑。
- 许可 Apache-2.0，正文见 `LICENSE`。
- 版本策略：现值 `0.1.0`，本仓**不维护 CHANGELOG**（变更账在 `git log` 与 flow change 卡里）；README 不承诺它。

## 已知边界（不在本卡承诺范围）

- PWA：`<link rel="manifest">` 未挂（Service Worker 注册失败现已可见，但 manifest 属挂起项）。
- `hostCtx.set('pocket', …)` 这枚服务目前仍会因未 `provide` 而报 `cannot set property "pocket" without provide`，
  被启动的 `.catch()` 记成「bridge failed to start」——桥其实起来了。删它属桥域（M1）。
- 一切页面/桥侧改动的上线方式都是「改完 → 用户重启 DSH → 手机上目验」，中途不催重启。
