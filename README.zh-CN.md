# Pocket for DSH（中文）

**把手机变成你自己 DeepSeek Harness 的客户端——以插件形式挂载。**

Pocket 在 DeepSeek Harness（DSH）桌面进程内起一个很小的 HTTP 桥，用手机浏览器扫码或输入数字密码完成配对，
之后手机就能读会话、发消息、看回复逐字吐出来。它服务的是「你正在用的这台机器」——不是托管服务，不是团队网关，
也不是桌面 GUI 的镜像。

| | |
|---|---|
| 包名 | `@defws/dsh-pocket` |
| 当前版本 | 0.4.0（[变更日志](CHANGELOG.md)） |
| 宿主要求 | DeepSeek Harness 桌面版 `>= 0.2.0-rc.1`（预览线） |
| 运行时 | Node `^22.19.0 \|\| >=24.0.0`——插件跑在宿主进程里 |
| 许可 | Apache-2.0（见 [LICENSE](LICENSE)） |
| 界面语言 | 英文与简体中文，跟随浏览器语言 |

英文正文见 [README.md](README.md)。

---

## 目录

- [为什么做这个](#为什么做这个) · [能得到什么](#能得到什么) · [形态](#形态插件不是独立进程) · [前置要求](#前置要求)
- [安装](#安装) · [首次连接](#首次连接) · [配置项](#配置项) · [环境变量](#环境变量) · [文件落在哪](#文件落在哪)
- [安全模型](#安全模型) · [隧道](#隧道) · [HTTP 接口面](#http-接口面) · [测试](#测试)
- [已知限制](#已知限制) · [排障](#排障) · [打包与许可](#打包与许可)

---

## 为什么做这个

DSH 自带的 web server 只绑 loopback。对桌面应用这是正确的默认值，但也正是手机连不上的原因：
机器外面进不来，机器里面也没有为手机准备的监听口。

Pocket 只补这一块——一个绑 `0.0.0.0` 的监听、门前一道配对门禁、门后一套手机形态的页面。
真正跑 agent 的东西一律留在宿主里：桥在服务端一侧调用宿主自己的内网 API，不把手机请求原样转发给宿主。

在范围内的：连接、读会话与历史、发消息、流式看回复、选模型/预设、执行斜杠命令、上传附件、导出会话。
不在范围内的：远程操作桌面 GUI、多人共用、把会话托管到云上。

## 能得到什么

- **配对**——二维码 + 8 位纯数字密码；可选长效密码，让手机熬过宿主重启不用重新扫码。
- **会话**——列表、未读标记、分页历史、新建、发送、取消、按会话记的水位线（两台设备不会互相踩对方的转录）。
- **流式**——局域网逐 token 实时；走隧道时自动降级为自适应增量轮询。
- **过程可见**——工具调用渲染成本地化的三态叙述，同类操作合并，edit/write 显示行级 diff，原始参数一次点击可看。
- **图片与文件**——图片灯箱、文本附件行内预览、可下载的文件卡（带真名）；也能从手机发出图片和文件。
- **设备管理**——已配对设备列表带到期时间、最后上线、按通道的权限，逐台可撤销。
- **可安装**——PWA manifest 与离线兜底页，「加到主屏幕」得到的是应用壳而不是书签。
- **审批不打断**——AI 等你回答时立刻推送；回合完成可选走 ServerChan / Bark / WxPusher。

## 形态：插件，不是独立进程

入口 `lib/index.js` 只导出 `name`、`inject`、`apply(ctx, config)`（并 `export default apply`）。
它**没有 main 守卫**：`node lib/index.js` 什么都不会发生，装载这件事由宿主完成。

桥是宿主进程内创建的一个 `node:http` 监听。它刻意不挂到宿主自己的 web server 上——那个服务只绑
loopback，手机连不上。它的生死跟随插件 effect：bundle activation 时启，dispose 时全停（监听、
隧道子进程、出站 WebSocket、socket）。

`package.json` 声明两个半区：

- **node 半区**——桥、配对门禁、设备登记表、隧道管理、手机路由；另外把桌面配对面（`/desktop`、
  `/brand-logo`）代理到应用 origin，好让 GUI 用同源 iframe 显示它。
- **浏览器半区**——`client/client.js`，经 `dsh.client.inject` 装载，只注册一件事：侧栏页脚的
  `pocket` 动作，点开就是上面那个配对面。

所有手机页面都是宿主产出的纯 HTML 串，经桥自己的路由下发。本仓没有 React bundle，也没有构建步骤。

**对升级的影响：**源码改动不会热挂载。改完这棵树必须重启 DeepSeek Harness，手机刷新一次即拿到新页面。

## 前置要求

- DeepSeek Harness 桌面版，预览线 `0.2.0-rc.1` 起。预览版的插件 API 会不受通知地变动；宿主比这更老
  或新很多时，请重新验证一遍。
- 宿主自带的 Node 运行时——纯 ESM，无构建。运行时依赖只有一个：`pngjs`（渲染二维码）。
- 可选，仅当你需要公网访问：[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)。
  插件首次开隧道时下载一个钉定版本并校验 SHA-256；你也可以自己放一个到 `PATH`，或用
  `DSH_POCKET_CLOUDFLARED` 指过去。
- 一台手机浏览器。实测形状是近几年 iOS Safari 与 Android Chrome；页面是响应式的，但按触摸视口设计。

## 安装

两步，从本仓的一份 checkout 出发。

```bash
# 1. 把插件登记进桌面宿主真正加载的 profile
dsh plugin --profile desktop add link:/absolute/path/to/dsh-pocket

# 2. 重启 DeepSeek Harness
```

`link:` 是本地目录依赖，profile 通过 junction/symlink 解析插件而不是复制它。所以「改源码 + 重启宿主」
就够了，不需要重装。

注意：

- 宿主在启动时装载 bundle，新登记的 bundle 不会热挂载，所以第 2 步不能省。
- 你的 profile 不叫 `desktop` 就传对应名字给 `--profile`。
- 真正把 link 落地的是 profile 目录里的 `pnpm install`；`dsh plugin` 一般会顺手做完。
- 安装前宿主会校验插件的 peer 兼容性。报 `incompatible-version` 说明宿主版本不在 `package.json`
  的 `dsh.engines.dsh` 区间内。
- 想要先做一次体检并留下备份文件的，用 `node tools/install-to-profile.mjs --dry-run`，去掉
  `--dry-run` 即执行。它只改 profile `package.json` 里的两处条目，改之前先落一个
  `.bak-before-pocket-*` 备份，源树或 profile 清单体检不过就一个字节都不写，并且只有你传 `--install`
  才会跑 `pnpm install`。新 checkout 里该脚本的 `LINK_PATH` 是个占位符——因为仓里不 baked 任何本机路径，
  用之前请把它改成你这份 checkout 的绝对路径。

重启后该在宿主日志里看到这一行：`Pocket bridge ready on 0.0.0.0:<port>`。
一直没出现就是桥没起来——见[排障](#排障)。

## 首次连接

1. 打开桌面 GUI，侧栏页脚，**pocket**。面板给出二维码、配对 URL 与一串数字密码。
2. 手机扫码（或打开 URL 后输入密码）。
3. 走隧道连进来的话，会先过一页确认：接受公网通道之后数据才放行。
4. 之后设备会出现在面板列表里。手机从此持有自己的会话：读会话、发消息、流式看回复。
5. 可选——在桌面面板勾选长效密码。这会写一个 `0600` 文件，让配对熬过宿主重启；不勾就什么都不落盘，
   每次重启都要重新配。

## 配置项

全部配置都在桌面面板里（侧栏 `pocket` → `/desktop`）：

- **通道**——只用局域网，还是在监听之上再开一条隧道。
- **隧道模式**——quick tunnel（每次启动换一个随机 `*.trycloudflare.com` 域名）或命名隧道
  （你的 Cloudflare token + 你自己的域名，URL 固定）。
- **配对**——轮换密码、重置或撤销长效密码、确认待处理的配对、断开或撤销某台设备。
- **设备**——每台设备的名称、到期、最后上线、按通道权限、撤销。
- **通知**——渠道（ServerChan / Bark / WxPusher）、key、开关，以及一次测试发送。

设置与配对状态都以 JSON 文档落在插件数据目录，原子写、POSIX 下 `0600`。Windows 上 mode 位只是装饰，
真正起保护作用的是目录 ACL。

### 环境变量

这些变量由插件进程读取，也就是由**宿主**进程读取。改完必须重启 DeepSeek Harness，刷新页面没用。

| 变量 | 作用 |
|---|---|
| `DSH_MOBILE_PORT` | 强制监听端口（只认正整数），压过配置值与默认 43127。端口被占时是否让号**只看端口号**：43127 与 43128 各让一次；其它端口一律直接抛错，不自作主张挪号——把内嵌 iframe 悄悄指向错端口比报错更糟。 |
| `DSH_HOME` | 统一数据根。设了它，日志 + 长效密码 + 隧道缓存全部只认 `<DSH_HOME>/pocket/`；没设，只有日志搬过去，密码与 cloudflared 缓存留在机器原位。 |
| `DSH_POCKET_DEBUG` | `=1` 时恢复页面渲染的文档体积报告。默认关。 |
| `DSH_POCKET_CLOUDFLARED` | cloudflared 的绝对路径，解析链第一优先。 |
| `CLOUDFLARED_BIN` | 通用变量名，优先级低于上面那个。 |
| `CLOUDFLARED_VERSION` | **只有 `tools/fetch-cloudflared.mjs` 读它**，运行时不读。取非钉定值还要再加 `--allow-unverified`。 |
| `LOCALAPPDATA`、`XDG_CACHE_HOME` | 只在没设 `DSH_HOME` 时参与：决定长效密码与隧道缓存的机器本地写根。 |

### 文件落在哪

下面的「DSH 数据根」指用户主目录下的 `.dsh` 目录，或你设了 `DSH_HOME` 之后的那个值。

| 内容 | 设了 `DSH_HOME`（隔离跑法） | 没设（普通桌面用法） |
|---|---|---|
| 文件日志 | `<DSH 数据根>/pocket/logs/pocket.log` | 同样形状，落在默认数据根下 |
| 长效配对密码 | 只读写 `<DSH 数据根>/pocket/` | 写机器本地目录；读先机器本地目录、再兜底统一根 |
| 已配对设备与会话 | 只读写 `<DSH 数据根>/pocket/` | 机器本地目录 |
| cloudflared 缓存 | 只读写 `<DSH 数据根>/pocket/cloudflared/` | 写机器本地；上一代插件目录只读兜底 |

这份不对称是刻意的，为的是同时守住两条承诺：隔离跑法绝不越出自己的根；普通跑法绝不搬家机器上已有的
凭据——一旦把默认写根统一到一处，所有已配对手机都会掉线，那枚约 55 MB 的钉定二进制也会被重新下载。

日志是 JSON 行（`t`/`level`/`message`），单代 512 KB 上限，级联轮转 3 代，单行 32 KB 截断，硬顶 2 MB；
到顶之后丢行而不是让文件无限涨。写日志永不抛错，也不会把插件带倒。

## 安全模型

**配对。** 桌面面板发一次性配对 token 与一串 8 位纯数字密码，5 分钟有效。开隧道时临时密码当场换新。
长效密码只有你在桌面面板明确同意后才存在，并可随时在那儿撤销。两种密码可以共存：手机输入框收 6–12 位，
所以早先落在盘上的 6 位密码照样能配对。

**暴破限制。** 按限流键（局域网取 socket 对端地址，隧道取 `cf-connecting-ip`）计失败次数，指数退避并回
HTTP 429 带 `Retry-After`。同一个键满 10 次进入 15 分钟硬锁定：锁期间先拒绝再计数，脚本猜测者没法靠持续
尝试让窗口一直滑动。桌面改密码可提前解锁；计数在内存里，所以重启也解开。

**设备凭据。** 每台已配对手机持有自己的 `dsh_mobile` cookie：`HttpOnly`、`SameSite=Strict`、
`Max-Age` 30 天，请求走 HTTPS 隧道时再加 `Secure`。有效期由服务端强制，页面只告诉你「本设备何时失效」。
桌面配对面用另一枚 `dsh_desktop` cookie，12 小时档，非 loopback 同样加 `Secure`。

**与宿主自身凭据隔离**（整体安全姿态见 [SECURITY.md](SECURITY.md)）。桥对宿主认证用的是 harness 的内环浏览器凭据，由它自己兑换。这个凭据只存在于
桥到宿主的服务端链路上，**永不到达手机**。手机只有 `dsh_mobile`，只能调下面那张表里的方法。

**传输。** 局域网模式下手机与桥之间是明文 HTTP，同网段其他设备可以窃听或篡改——这就是配对页与重连页都挂
双语风险提示、公网配对要多一道同意门的原因。在你控制的网络里用局域网模式；不在的时候用隧道。

隧道只把一个端口转发到公网 URL，别的都不暴露：所有手机页面与 RPC 调用都在配对门禁之后，未配对的手机
连品牌资源都读不到（401）。`/sw.js` 按设计保持公开——浏览器在任何凭据之前就要取它，且它不含数据。

**响应卫生。** 所有文档、SSE、附件、导出一律 `no-store`，且 origin 侧不开压缩；2026-10 的两次事故把这条
从建议变成边界。只有三样东西拿长 `max-age`，因为它们的名字要么内容寻址要么恒定：带内容哈希的
`app.css` / `app.js`（7 天）、`/brand-logo/*`（1 小时）、`/app-icon`（1 天）。每个响应都带
`x-content-type-options: nosniff`、`x-frame-options: DENY`、`referrer-policy: no-referrer`，以及每请求
随机值的 CSP——CSP 只授权页面自己的脚本标签，内联事件属性照旧被拦，所以页面用 `data-action` 事件委托。
出去的所有宿主文本都做 HTML 转义；这套代码里没有 `eval`，也没有 shell 拼接。

## 隧道

**quick tunnel**（`cloudflared tunnel --url http://127.0.0.1:<port>`）不需要 Cloudflare 账号，
但每次启动换一个随机 `*.trycloudflare.com` 域名——所以配对二维码必须每次重出，手机重连也要换新址。

**命名隧道**（在桌面面板配 token + 你自己的域名）给出固定的 `https://<hostname>`。两点要知道：

- token 通过 `TUNNEL_TOKEN` 环境变量交给 `cloudflared`，不进命令行，同机进程无法从进程列表里读到它。
- token 模式下的本地转发目标由 Cloudflare Zero Trust 面板里你配的 ingress 决定，**不由本插件决定**。
  它必须指向 `http://127.0.0.1:<桥端口>`——桥端口可能让位到了 43128，也可能是 `DSH_MOBILE_PORT` 指定的值。
  ingress 配错时隧道显示在线、手机全部 502；online 那行日志会明确提示这件事。

二进制解析顺序：调用方显式路径 → `DSH_POCKET_CLOUDFLARED` → `CLOUDFLARED_BIN` → 本仓
`vendor/cloudflared(.exe)` → `PATH` 上的 `cloudflared`。都找不到就下载钉定版本并校验 SHA-256。
想把二进制预置进仓（省掉首次开隧道的约 55 MB 下载）：

```bash
node tools/fetch-cloudflared.mjs --print   # 只打印契约，不联网
node tools/fetch-cloudflared.mjs           # 下到 vendor/，校验不符即删
```

这个工具的版本、发布件文件名与摘要全部从 `lib/tunnel.js` 读，不另抄一份；它写出的文件名就是解析链要探测的那个。
`vendor/` 已在 `.gitignore` 内。macOS 的发布件是 `.tgz`，与「裸可执行件」这条契约不符，工具会指名道姓拒绝——
那条路交给运行时懒下载。

## HTTP 接口面

手机只跟桥说话；桥只在服务端一侧跟宿主说话。

- **手机页** `/`、`/pair`、`/reconnect`、`/disconnected`、`/consent`（含各自 POST）。
  **手机数据** `/api/status`、`/api/boot`、`/api/rpc`、`/api/session/stream`（SSE）、
  `/api/session/events`（隧道轮询）、`/api/session-attachment`、`/api/session-file`、
  `GET|HEAD /api/session-export`。**静态件** `/app.css`、`/app.js`（URL 带内容哈希）、`/sw.js`、
  `/manifest.json`、`/brand-logo/*`、`/app-icon`。**桌面面** `/desktop` 加 `status`、`tunnel/*`、
  `pairing/*`、`pin/*`、`notify/*`、`disconnect`、`revoke`、`pair/confirm`。
- **RPC** `POST /api/rpc`，体为 `{method, payload}`，门禁是设备 cookie + 同源校验。`session.*`、
  `workspace.list`、`settings.describe`、`agentPreset.*`、`permissionPresets.catalog`、
  `command.execute`、`file.upload`、`skills.list`、`commands.list` 转发给宿主；
  `interaction.pending|answer|cancel` 由桥自己应答。其余一律
  `403 RPC method is not available on mobile.` 权威清单是 `lib/constants.js` 的
  `RPC_ALLOWLIST` / `HARNESS_ENDPOINTS`——改那两个才是改接口，本节只是抄录。
- **body 分档** 普通 64 KB，四个带 base64 的方法约 35 MB，按最前 2 KB 内的 `method` 提前定档；
  超限 `413`。
- **状态** `GET /api/status` 与周期性 SSE `status` 帧出自同一个 builder，字节级一致。`connected`
  只表示「这个桥答了」，不表示「桌面端没事」；那看 `hostReachable`，它的 `null` 是「未观测」，
  不能读成「宿主死了」。
- **错误** 传输类 `502`、入参类 `400`、`/api/boot` 失败 `503` + 固定文案；宿主内部错误原文不会转写进
  手机可见的错误。会话流用 `event: failure` 带 `code`——`host-error`（不喂重连退避）、
  `__bridge/stream-transport`（下一行公布下次延迟）、`__bridge/stream-backoff`（连续多次失败后抑制，
  第一次永不拦）。

## 测试

测试是原生 `node:test`，没有框架、没有构建：

```bash
npm install
npm test            # node --test --test-concurrency=1 test/*.test.js
```

默认套件在环回上起真桥、对假宿主，串行跑（`--test-concurrency=1`），因为每个文件自己绑一个 OS 分配端口。
默认套件不碰真机 profile、不碰真机数据根、不出网；`test/tunnel.test.js` 把 `DSH_HOME` 钉到一个一次性目录，
所以 cloudflared 解析链是对空缓存演练的。

另有两样刻意放在默认 glob 之外，因为它们要的东西不在仓里：

```bash
npm run test:real-webserver     # 装载官方宿主 webserver payload：先设 DSH_OFFICIAL_MODULES
node tools/render-stub.mjs      # 真实页面 + 罐头 RPC/SSE，起在 127.0.0.1:4399，用浏览器手机视口目验
node tools/smoke-bridge.mjs     # 自起一个桥：桌面 bootstrap、门禁、未配对拒绝、状态形状
node tools/smoke-pairing.mjs    # 配对 → 设备 cookie → 设备可见性，端到端
```

`test-real-webserver.mjs` 是对着**官方**装载链验的：注册形状被接受、重复 `(kind, path)` 抛错、插件只占
`/desktop` 与 `/brand-logo` 两个前缀、dispose 之后路由消失。缺东西就非零退出并点名它要哪个文件，不装成通过。

`test/dom/` 放浏览器级断言（启动路径的真 DOM 走查，以及手机版式的几何门禁）。它们由环境变量闸门控制，
没有浏览器或没有钉定文件时自己跳过——见那两个文件的头注。

改测试之前先读 [CONTRIBUTING.md](CONTRIBUTING.md)：本仓有若干刻意写成字面量的断言，每条都带一行注释说明
它守的是哪句话。

## 已知限制

- **走隧道就失去实时流。** Cloudflare quick tunnel 会缓冲 SSE 帧，所以隧道下手机降级为增量轮询
  （1.5 s 起自适应，回到前台立刻拉一次）。局域网是实时流。
- **进入一条还没画出来的会话会多发一次头页请求。** 这是空转录唯一的自举路径，且有两道门挡住空转。行为有测试钉住。
- **通知只发文本。** WxPusher 按业务码判定，并能透出对面脱敏后的错误消息；ServerChan 与 Bark 仍只按 HTTP
  状态判定，它们的业务码语义没接。「测试」按钮只显示成功/失败两态，对面的 `msg` 要到桥日志里看。
- **手机不能删会话。** 桥没有 delete 通道，删会话是桌面动作。
- **命名隧道没有面板内回退路径。** 域名填错时隧道显示在线、手机全部 502，目前要清掉存的值只能手改设置文件。
  这是最该被提成 bug 修的一条。
- **宿主被硬杀可能留下孤儿 cloudflared。** `process.on('exit')` 不会跑，子进程可能活下来。闭合它需要
  「本桥 pid sidecar + 身份校验」——按镜像名扫杀会打到别人为别的端口跑的隧道，所以没那么做。
- **子代理会话不显示。** 手机列表过滤 `origin === 'subagent'`；那些会话属于桌面自己的编排。
- **manifest 在配对门禁之后**，且 service worker 注册失败时本会话静默停用（下次访问重试），不弹提示。
- **`muxConnected` / `devicesConnected` 已上报但未被读**；它们本想解释的症状已由 degraded 状态灯覆盖。
- **宿主是预览线。** DSH 版本之间插件 API、内环凭据形状、webserver 注册路径都可能变，而本插件与它们耦合。

## 排障

- **面板显示「Pocket bridge is not ready (port 43128, EACCES).」**：监听根本没绑上。两个字段都知道时消息会带
  端口与 errno。除 43127/43128 之外的端口 EADDRINUSE 是刻意硬失败——腾出端口，或者设 `DSH_MOBILE_PORT`。
  Windows 上注意 `127.0.0.1:P` 与 `0.0.0.0:P` 不互斥，真冲突要占同一个 wildcard 地址。
- **面板空白 / iframe 报错**：浏览器半区是注入到桌面 GUI 的。确认 bundle 在 profile 的
  `dsh.profile.bundles` 里，且装完之后重启过宿主。
- **手机说「连接断开」且一直不回**：临时提示条现在会自己过期（90 秒）也能用右端 × 关掉；如果底层流真的断了，
  把页面切回前台，它会重开会话流。
- **隧道在线、手机 502**：几乎总是 ingress 配错了——它必须指向 `http://127.0.0.1:<桥端口>`，端口以启动日志那行为准。
- **配对成功但宿主重启后页面进不去**：检查是否勾选了长效密码；没勾的话配对只在内存里，重启即结束。
- **日志里没有东西**：日志位置见上面那张表；同样的行也会写进宿主控制台。

## 打包与许可

- `package.json files` 发布 `lib/**/*.js`、`client/**/*.js`、`tools`、`cordis.patch.yml`、
  `README.md`、`README.zh-CN.md`、`LICENSE`、`CHANGELOG.md`。
- `test/` **刻意不在**发布文件清单里：它很大、不是可装载代码，宿主装载插件时也不读它。测试跟着仓库走，
  所以请从 git clone 里跑（`npm install && npm test`），CI 也是这么做的。`tools/` 会发布，因为隧道预置与
  profile 安装这两个助手是给装了这个包的人跑的。
- 许可 Apache-2.0，全文见 [LICENSE](LICENSE)。
- 版本历史见 [CHANGELOG.md](CHANGELOG.md)。它在场、且最新一节跟着 `package.json version` 走；
  不承诺每一笔提交都更新它。

