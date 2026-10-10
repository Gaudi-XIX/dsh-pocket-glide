# 提交报告 — 电脑端配对页改造（PIN 6 位 + 文案去技术腔 + 去大标题）

时间：2026-10-11 00:3x（东八区）
仓库：`F:\defws\dsh-pocket`（独立 git 仓，基线 HEAD=505d254）
状态：**全部落盘、全量测试全绿、未提交** —— 按用户要求由用户统一提交。
生效条件：pocket 是 `link:` junction 装载，**需重启 DeepSeek Harness 才生效**。

## 一、需求与裁决

用户 2026-10-10 口述（语音转写）：电脑端 `/desktop` 配对页
① PIN 码改位数（8 位太长）→ 用户拍定 **6 位**；
② 页内大标题「连接移动设备」**整块不要**（不是改名，是删掉）；
③ 二维码刷新时的「正在创建全球网络链接」太中二，换掉；
④ 「WiFi连接模式 / 互联网连接模式」命名拗口 → 改「局域网 / 公网」（AI 定名，用户授权）；
⑤ 说明太啰嗦，删 4G/5G/WiFi 那段枚举，且消除页面里第二个「Wi-Fi」概念；
⑥ 固定域名文案太技术向 → Cloudflare 域名地址直接做成可点超链接。

追加（2026-10-11）：所有「手机连接 / Phone connection / Connect Mobile Device」一律用
**Pocket** 代替 —— 标题、iframe 标题、打开中提示、失败提示、注释同步。

## 二、逐文件改动

### `lib/constants.js`（PIN 位数，唯一改点）
- `PAIRING_PIN_DIGITS` `8` → **`6`**；`PAIRING_PIN_SPACE = 10 ** 6`（= 1e6）自动跟随。
- `PAIRING_PIN_MIN_DIGITS` 保持 **6**，`PAIRING_PIN_MAX_DIGITS` 保持 **12**，
  `PAIRING_PIN_PATTERN = ^\d{6,12}$`。
- 注释改写：说明现值 6 位的来由（8 位用户老打错）、以及「改这一个数就行」的前提
  （手机输入框必须与 PATTERN 同域，不能收窄到 6）。

### `lib/pages.js`
- **大标题整块删除**：`renderDesktopPairingPage` 的
  `<h1>${options.connected ? text.manageHeading : text.heading}</h1>` 整行删掉，
  现为 `</div>` 后直接进 `<div class="mode-panel">`；text 表删 `heading` 与 `manageHeading` 两键。
- **`title` 改 `Pocket`**：`title: 'Pocket'`（中英同串，产品名不翻译）。
- **模式键改名**：`modeLan` `WiFi连接模式`→`局域网` / `Local network`；
  `modeTunnel` `互联网连接模式`→`公网` / `Public internet`。
- **模式说明重写**（各一句，删掉 4G/5G/WiFi 枚举）：
  lanHint「扫一下就连上。手机和电脑要在同一个局域网里，速度最快。」
  tunnelHint「走公网连接，手机在外面也能连回来，比局域网慢一点。」
- **加载/等待文案**：`tunnelLoading`「正在创建全球网络链接」→「正在开通公网通道」/
  `Opening the public link`；`lanLoading`→「正在切回局域网」；
  `urlPendingTunnel/Lan`→「公网/局域网地址生成中…」。
- **LAN 明文风险句**（两处：重连页 + 配对页，replace_all）→
  「局域网走明文传输，同一网络下可能被听到；要保密就切到公网。」/
  `Traffic on the local network is unencrypted and can be overheard there. Switch to the public link when it needs to stay private.`
  （去掉「明文 HTTP」「可信 Wi-Fi」「云隧道」三个技术/重复概念，消除第二个 Wi-Fi）。
- **固定域名区**：`tunnelConfigHeading`「固定域名（命名隧道）」→「固定域名」；
  新增 `tunnelIngressHtml`（zh/en 双语，内嵌
  `<a href="https://one.dash.cloudflare.com/" target="_blank" rel="noreferrer noopener">Cloudflare Zero Trust</a>`），
  渲染点由 `${escapeHtml(text.tunnelIngressHint)}` 改为**不转义**的 `${text.tunnelIngressHtml}`
  —— 这是该页唯一一处不 escape 的输出，源码已就地留注释说明原因。
- **PIN 输入框不收窄**：两枚 `<input id="pin">`（`renderPairingPinPage` / `renderMobileReconnectPage`）
  保持 `maxlength="12" pattern="\d{6,12}"`。**这是刻意的**：收窄到 6 位会让盘上存量 8 位
  长效密码打不进去，等于现网把已配对手机锁在门外。

### `client/client.js`
- `frameTitle` → `Pocket`（zh/en 同串）；`opening`「正在打开 Pocket…」/ `Opening Pocket…`；
  `openFailed`「Pocket 打开失败，请重启 DSH 后再试。」/ `Failed to open Pocket. Restart DSH and try again.`
- 表头注释里的旧字面对齐（`Connect Mobile Device` → `Pocket`）。

### `README.md`
- 安全模型段改 6 位口径：现值 6 位、范围 6–12、`maxlength="12" pattern="\d{6,12}"`、
  「6–12 位都接受、13 位被拒」；顺手删掉改写时留下的一句重复。
- 「局域网（LAN）明文风险」段不再点名 Wi-Fi，并记一句改写理由（避免第二个「无线网」概念）。

### 测试锚点（跟着改，不是放宽）
- `test/client-i18n.test.js`：frameTitle/status 断言改 Pocket；「七键表只有 label 允许中英同串」
  那条改为**两个产品名键**（`label` / `frameTitle`）——frameTitle 现在是 `Pocket`，
  中英必然相同，原断言会误红。
- `test/pages-panel-ux.test.js`：钉 `/固定域名/`（去掉「（命名隧道）」后缀）。
- `test/audit-anchor-hardening.test.js`：P-3 钉 `['zh','局域网走明文传输']`、`['en','local network is unencrypted']`。
- `test/pin-field-width.test.js`：档头注释与断言改 6 位口径（`PAIRING_PIN_DIGITS === 6`、
  `PAIRING_PIN_SPACE - 1 === 999999`）；「余量在哪一头」的断言从
  `PAIRING_PIN_MIN_DIGITS < PAIRING_PIN_DIGITS` 改为 `PAIRING_PIN_MAX_DIGITS > PAIRING_PIN_DIGITS`
  （下限与现值同为 6，容纳旧 8 位密码的余量在上限）。
- `test/pages-render-fixes.test.js` T6 档：不再钉被转义的 ingress 旧文案，改钉
  `one.dash.cloudflare.com` 出现、形如 `<a href="https://one.dash.cloudflare.com/"…>Cloudflare Zero Trust</a>`、
  含 `127.0.0.1`，且位置在 `tunnelHostname` 之后、保存按钮之前；切片边界同步
  （面板现在是 `#deviceExtras` 的最后一块，下一个标记是 `<script`）。

## 三、验证

- 全量 `node --test` = **1057 tests / 1055 pass / 0 fail / 2 skipped**（约 11.8s）。
- 页面相关 12 档单跑 176/176 pass。
- `test/script-embedding.test.js` 的 `PARSE:` 档通过 —— 页内脚本是模板串出货的 JS，
  改坏了 `lib/pages.js` 自身照样合法、字符串锚照样在，只有浏览器白屏，所以这档是必看守卫。
- 冒烟（zh/en 双语）：`<title>Pocket</title>`、`<h1` 计数 **0**、Cloudflare 锚点存在；
  重连页 h1 仍「连接已断开」、PIN 页 h1 仍「输入连接密码」（未受牵连）。

### 中途踩到并已回退的一处
曾把 `PAIRING_PIN_MIN_DIGITS` 降到 4，全量立刻红 `test/pin-store-width.test.js:44`
（5 位密码被接纳）。**没有任何版本发过 4 位密码**，那只是无谓放宽 ⇒ 回退 6，
并同步回改 constants 注释、pages.js 输入框、README、pin-field-width 的口径。

## 四、真机目验清单（本机代劳不了，重启后逐条看）

1. 配对页**没有大标题**（DSH Pocket 商标行之后直接是模式切换）。
2. 两个模式键叫「局域网 / 公网」。
3. 二维码刷新时显示「正在开通公网通道」/「正在切回局域网」，地址行显示「公网/局域网地址生成中…」。
4. 固定域名区那行 **Cloudflare Zero Trust 是可点链接**，点开到 `one.dash.cloudflare.com`。
5. PIN 是 **6 位数字**。
6. 浏览器标签页 / 宿主 iframe 标题是 **Pocket**。

## 五、提交注意（用户统一提交时）

工作树里除本轮改动外**还有他线的未提交改动**（`lib/bridge.js`、`lib/session-stream.js`、
`lib/icon.js`、`test/session-events.test.js`、`test/helpers.js`、`test/mobile-assets.test.js`、
`test/pages-tunnel-poll.test.js`、`CHANGELOG.md` 等），提交时按既有纪律**逐文件显式
`git add`**，别用 `-A` / `-u` 把别线的活裹进去。
