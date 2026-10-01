# @defws/dsh-pocket

手机远程 DSH 桥（phone remote selfbuild）。独立 Node 进程运行桥服务：手机浏览器扫码配对后，
经桥访问本机 DSH 会话——会话列表、历史、发送、流式回复、模型/preset 设置。云隧道
（cloudflared quick tunnel）可让手机不在同一 Wi-Fi 时经互联网连接。

## 形态与端口

- 独立桥进程（`node lib/index.js`，插件内无构建），默认监听 **0.0.0.0:43127**
  （绑全部网卡以便局域网扫码；桌面面板路由仍仅 loopback 可访问）；
  端口被占（EADDRINUSE）时自动 +1 重试。实际端口以 `bridge.start()` 返回快照的
  `snap.port` 为准，工具/测试一律从快照取端口，不硬编码。
- 桥对内经宿主 mux WS（session/follow 等）代理 RPC；对外只暴露白名单方法，不是任意转发。
- 桌面面板路由（`/desktop*`）仅 loopback + 会话级 `dsh_desktop` cookie 可访问。

## 手机端接口

- **POST `/api/rpc`**（`dsh_mobile` + 同源校验）：JSON `{method,payload}`，仅白名单方法可用。
  会话/模型类：`session.list`、`session.history`、`session.create`、`session.prompt`、
  `session.cancel`、`session.models`、`session.selectModel`、`workspace.list`、
  `settings.describe`、`agentPreset.list`、`agentPreset.select`。
  命令/附件类：
  - `command.execute` → 宿主 `commands/execute`，桥补 wire 形
    `{agentId: sessionId, line, submittedAttachments?}`；宿主解析并执行斜杠命令
    （goal/plan/feedback/compact/permission 等），命令不发给模型，错误文案原样透传。
  - `file.upload` → 宿主 `fileUploads/upload`，桥补 `{agentId: sessionId,
    request:{data(base64), name?}}`，返回 `{receiptId, file}`。
  - `permissionPresets.catalog` → 宿主 `permissionPresets/catalog`，动态取权限预设。
  - `session.prompt` 的 content 支持 `{type:'text'}` /
    `{type:'image',mediaType,data,name?}` / `{type:'file',receiptId}`。
- **GET `/api/session-attachment?sessionId=&attachmentId=`**：经 Typert 信封取
  `session/attachment` 的 `{attachment,data(base64)}`，桥解码后按 mediaType 回写
  （`cache-control: private, no-store`）。
- **GET/HEAD `/api/session-export?sessionId=`**：流式代理宿主 `/api/session.export`
  下载 ZIP；桥固定追加 `includeDescendants=true`，不透传其他自定义参数。
- **body 上限分级**：普通方法 64KB；`file.upload`、`session.prompt` 用大档
  `ceil(25MB × 1.4)`（计入 base64 4/3 膨胀）；超限返回 413
  `Request body is too large.`。

## 安全模型

- **配对**：桌面「连接手机」展示二维码与 6 位连接密码；一次性配对 token 短时有效、
  用后即焚。PIN 有暴力破解限制：错 PIN 计数 + 按 IP 限流（429，retry-after），
  长效密码可随时在桌面面板重置/取消。
- **设备凭据**：每台手机独立 `dsh_mobile` 会话 cookie——`HttpOnly`、`SameSite=Strict`、
  `Max-Age=30d`（隧道 HTTPS 下追加 `Secure`）；每设备独立有效期（30 天），
  有效期由服务端强制，页面仅展示「本设备将于 … 失效」。
- **凭据隔离**：宿主内环凭证（`dsh-auth-` cookie / launch token）只存在于桥到宿主的
  服务端链路，**永不到达手机**；手机只持有 `dsh_mobile`，且只能调白名单 RPC。
- **SSE**：`/api/session/stream` 需 `dsh_mobile` + 可信来源；桥每 15s 写 `: ping`
  保活，断线 EventSource 自动重连，snapshot 对齐。
- 安全头：`cache-control: no-store`、`x-content-type-options: nosniff`、
  `x-frame-options: DENY`、`referrer-policy`、CSP。
- 页面渲染所有外部文本均经 HTML 转义；无 eval / shell 拼接。

### 局域网（LAN）明文风险

WiFi/LAN 模式下手机与桥之间是**明文 HTTP**：同一网络内的其他设备可窃听或篡改流量，
且无隧道端到端加密。配对页与重连页在 LAN 模式下均显示双语风险提示。请仅在可信 Wi-Fi
下使用 LAN 模式；在不可信网络或需要保密时，改用互联网（云隧道）模式。

## 测试

```
node --test --test-concurrency=1 test/*.test.js   # test/ 单元套件（真桥 + 假宿主）
node test-closed-loop.mjs          # 进程内闭环（假 harness，不联网）
node test-real-webserver.mjs       # 真实 webserver 联调
node tools/smoke-bridge.mjs        # 自起桥实例，端口取自 start() 快照
node tools/smoke-pairing.mjs       # 配对/401/限流路径，非 JSON 响应有守卫
```

两个 smoke 脚本各自启动独立桥实例并从快照端口寻址，可与在役桥并行不冲突。
