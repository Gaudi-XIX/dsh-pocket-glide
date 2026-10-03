# Changelog

本档只记**版本级的对外变化**：装机、使用与行为契约。逐笔施工账（谁在哪个包改了什么、证据在哪）
在 `git log` 与 flow change 卡（`F:\defws\.agents\flow\changes\`）里，不在这里重复。
最新的一节对应当前 `package.json` 的 `version`。

## 0.2.1 — 2026-10-03

本卡四类修复（审计整改收尾）。生效同样需要重启 DeepSeek Harness。

### 修复（用户可见）

- 回合运行状态指示器（「深度思考中…」）在事件密集的长回合里会提前消失：流缓冲裁剪最老边后，
  运行态被重新算成「未运行」。改为在事件到达时记录单调高水位，裁剪不再影响结论。
- 手机端会话列表过滤 `origin === 'subagent'` 的子会话；命中宿主 `session/agent-busy`
  （durable parent address）时回退到会话列表，不再把宿主的英文报错与粘住的「重试」留在屏上。
- 桌面入口文案统一改名：`连接手机` / `Connect Phone` → `pocket`（`client/client.js` 与
  `README`、`cordis.patch.yml`、`tools/install-to-profile.mjs` 同批）。

### 修复（Windows 观感）

- 解包 cloudflared 归档的那次 `tar` 调用补 `windowsHide`，减少 Windows 上多弹的黑窗。
  真正的黑窗来源在宿主侧的 worker，不在本仓（见卡内证据报告）。

## 0.2.0 — 2026-10-03

一轮覆盖全仓的审计整改（flow change `2026-10-02-fix-pocket-audit-remediation`）。

**装上本版后必须重启 DeepSeek Harness**，手机端才会拿到新页面与桥接逻辑：装机是 `link:` junction，
`lib/pages.js` / `lib/bridge.js` 都是静态 import，HMR 不跟 junction。

### 修复（用户可见）

- 会话列表：修顺序错乱、修新消息把已读旧消息盖掉；上拉「加载更多」改为固定条数语义
  （默认 30 条，上限 200）。
- 页面稳定性：修掉整页冻死——转录窗口、热转录缓存、输入框（`+` 面板）三处都改为有界。
- 重连：重连后不再出现空白会话页；重连页与 PIN 页的「重连」按钮不再点了没反应。
- 错误可见性：掉线 / 流中断 / 后台 / 隧道各有具名文案，不再被一次成功轮询静默擦掉、
  也不再被空串抹平（见 `lib/pages.js` 的 `showError` / `noteStreamRecovery` / `importantChatCopy`）。
- 滑动返回：从会话页返回落在工作区列表，不再直接退出浏览器。
- `+` 面板的搜索框不再自动拉起输入法（要点才弹）。

### 变更（契约 / 行为）

- 连接密码位数 **6 → 8**。输入框与校验仍收 6–12 位，盘上存量 6 位密码**零迁移**、照旧可用
  （`PAIRING_PIN_MIN_DIGITS` / `PAIRING_PIN_MAX_DIGITS` / `PAIRING_PIN_PATTERN`）。
- 未配对的请求依旧一律 401 先于路由（不变）。宿主凭据缓存现在带 10 分钟 TTL 与世代失效：
  authority 变了或握手失败时会丢掉旧 cookie 重取，不再「带着过期凭据重试到 TTL 到期」
  （`lib/inner-auth.js` 的 `invalidate()` + `lib/mux-client.js` / `lib/session-stream.js` 两处调用）。
- 被拒的提问载荷会写一行 `warn`：`pending question refused reason=<reason>`（必要时带 `count=`）。
  日志**不含**事件 id 与题干、选项文案。
- 手机页触摸目标抬到 44px，浅色主题对比度达 WCAG AA；去掉 viewport 的 `maximum-scale`；
  补 `role="status"` / `aria-live`、`+` 面板焦点陷阱、QR 图的 `role="img"`、图标按钮 `aria-label`。
  例外一处：草稿删除按钮保持 26px（测试里有具名例外断言）。
- 重连页与 PIN 页共享同一段阶段脚本（原先一分两份）；跨页面文案统一走 i18n key。
- 会话水位线改为**按会话**记账；探针/刷新不再把另一个会话的进度当成自己的。

### 仓库面

- `package.json files` 收全 `test` / `tools`，并把 `CHANGELOG.md` 纳入发布件；`.gitignore` 补
  `vendor/`、`*.log*`、`*.tar`、`*.tgz`；`README` 的数据根、端口、版本策略三节按实现复刷。
- 版本号 `0.1.0 → 0.2.0`，本档从本版起维护（此前 `README` 写的是「本仓不维护 CHANGELOG」）。

### 已知边界（本版未做，见 `README`「已知边界」）

- 会话行的整宽按钮高 38.5px（触摸面积足够，未强抬到 44）。
- `_sessionCursors` 运行中不淘汰；宿主被硬杀时 cloudflared 可能留孤儿进程。
- PWA manifest 仍未挂；桌面端 `client/client.js` 一处浅灰文字未随对比度整改。

## 0.1.0

- 初版：LAN 监听 + 可选 Cloudflare quick tunnel；QR / PIN 配对；会话列表、历史、发消息与流式回复。
