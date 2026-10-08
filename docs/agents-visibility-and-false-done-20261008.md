# Pocket 对「子代理 / Agent Team / ACP 工人」全盲，且把它们在跑时的父会话画成已完成（绿勾）

调研时间：2026-10-08 W4 11:47–12:05（数据基准：现网 `D:\DSH\resources\app.asar` = 官方 desktop 0.2.0-rc.1，
`~/.dsh/storages/session_projcache/sessions` 263 个投影文件全量扫描；pocket 源码基准 = `dsh-pocket` HEAD `4e92143`、`package.json` 版本 **0.4.0**）
取证件与复跑命令见文末「§6 可复跑取证」。结论由直读宿主发布包内官方文档与投影源码得出，非推断。

## 一句话结论

这不是漏画，也不是回归：**桌面端有的「父会话行代表后代活动」聚合，Pocket 从来没有实现过**；同时 Pocket 的行状态判据
只看该行自己的 `running`，于是 lead 把活派出去、自己那一轮交还控制权之后，手机上出现绿勾「已完成」而子代理仍在跑。
两类现象同源，宿主的数据已经送到 pocket 桥里，pocket 一侧没用。

## 1. 现象与判据

| 现象 | 代码位置（符号锚） | 实况 |
|---|---|---|
| 三种实体（subagent / teammate / ACP）在手机端没有任何显示出口 | `visibleSessions()`、`openableFocus()`（`lib/pages.js`）；`pickFocusItem()`（`lib/bridge.js`）；`created.origin!=='subagent'`（`createSessionIn`） | 带 `origin==='subagent'` 的行被四处过滤掉，父行也不做任何聚合；`lib/` 全仓 `team`、`acp` 字样**零命中** |
| 后台还有这三种在跑时，行尾显示绿色实心勾（= 已完成） | `taskState()` → 兜底返回 `'done'`；`taskGlyph('done')` → 实心圆 + 白勾；CSS `.ws-last.is-done{color:#35a867}`（`lib/pages.js`） | 判据链只有 `awaitingQuestion / error / running / blank` 四个前置条件，**全部只看该会话自己**；lead 派活后自身 `running=false` ⇒ 落到 `done` |
| 同一判据的第二个出口 | notify tick：`const sample = { running: item.running === true, … }` → 停跳即 `notifySend(..., '任务已完成')`（`lib/bridge.js`） | 绿勾误报的同时，手机还会收到一条「任务已完成」推送。修状态时必须同改这一处，否则界面改了、推送照样骗人 |

## 2. 宿主侧的数据面（已到手，pocket 没用）

1. **子会话确实作为行出现在宿主列表快照里，带父子关系。**
   `@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.js` 的 `projectList()`：
   先按 manager 快照建 `byId`（字段实列：`id / displayTitle / running / retainedBy / blank / updatedAt / projectionValues? / title? / cwd? / parentId? / origin?`），
   再遍历每个父会话投影的 `values.subagentCatalog`，把没在列表里的 child 补成行，写入
   `origin: 'subagent'`、`parentId: <父 id>`、`running: this.scopes.get(childId)?.session.getSnapshot().running ?? false`。
   ⇒ `parentId` 与 `origin` 是宿主给的一等字段，不是 pocket 猜的。
2. **这两个字段能穿过 pocket 桥的裁剪。** `compactSessionRows()`/`compactRowValues()`（`lib/projections.js`）对顶层
   字段按「小值即留」（短字符串 / 数字 / 布尔），`origin`、`parentId`、`running` 都能过（pocket 现有代码已在读 `item.origin`，即为证明）。
   但 `projections.values` 走 **白名单** `SESSION_ROW_VALUE_KEYS = {title, sessionTitle, session.title, todos, modelSelection}`，
   ⇒ `subagentCatalog`、`agentTeam`、`subagentTiming`、`goal` 在列表行上被桥端丢弃（这条裁剪本身是对的：实测整包 ~1 MB / 2026-10-01 事故）。
3. **Agent Team 的名册与任务板挂在父会话投影的 `agentTeam` 列上**（`{id, members, tasks, messages, delivered, nextTaskNumber}`），
   teammate 走的是同一套 subagent 地址体系——`@deepseek-ai/dsh-experimental-agent-team/lib/types/roster.js` 里
   取消/打断成员用的是 `this.ctx.subagents.interrupt(...)`，成员可用性取 `agent?.status === 'running'`。
4. **ACP 工人要分两层看**：工人 CLI 进程本身在 DSH 侧**没有会话归属**（`F:\defws\dsh-acp-progress\lib\parent-session.js` 文件头实证：
   只能靠任务书文本反查父会话，且「唯一命中才认」）；而派发它的那次执行在 DSH 侧是一枚 subagent 会话
   （舰队台账里它们是 `subagent_*` 工具位，如 `subagent_cb_hy4`）。
   ⇒ 「哪个会话在替我跑 ACP 活」可以随 subagent 聚合一起显示；「哪家 CLI / 冷却 / 额度」这类舰队台账住在 acp-progress，Pocket 要显示得另接一条数据面。

## 3. 桌面端已有的正确形态（官方文档原文口径）

`@deepseek-ai/dsh-client-ui-workspace/README.zh.md` 三处：

- 「侧边栏隐藏持久化摘要中带有 `origin: 'subagent'` 的行。**可见普通行的共享 ongoing loading 来自其已加载 parent 目录中正在运行的直接 child**，绝不来自摘要谱系。Child 活动状态使用最新 UI status，尚无该状态时使用 Session 摘要。」
- 「待处理交互的优先级高于共享 ongoing loading；已完成但未查看的 Session 使用 done，idle 在行内不显示点。」
- 「正在运行的 Session（**包括有子会话正在运行的父会话**）始终按原顺序显示，不占用这五条配额。」

即：**pocket 过滤子行与桌面一致（这条不该动）**，缺的是父行上的「后代在跑」聚合。Agent Team 另有专门面板
（`@deepseek-ai/dsh-experimental-client-ui-agent-team/README.zh.md`：从 Lead Session 的 `agentTeam` 投影读 roster/任务板，
provisioning 与 running 成员用共享 ongoing loading，failed 用红点），桌面 Web 有、手机无。

⚠️ 同源限制要一并写清：桌面的聚合只在**父目录已加载**时成立，冷启动或子会话 scope 未加载时宿主给的 `running` 就是 `?? false`，
此时桌面也会退回 `done`。pocket 照此判据修，可消除「lead 明明在等子代理却画绿勾」这一主现象，但不保证 100% 不漏——
彻底不漏需要宿主提供 parent 级 active 标志，或 pocket 对候选活跃会话额外拉一次 `session.projections`。

## 4. 修复面（按代价从低到高，尚未动手）

1. **父行聚合（核心）**：`taskState()` 增加「后代活动」入参，由调用方按 `parentId` 把 `origin==='subagent' && running===true` 的子行归到父行；
   优先级排在 `awaitingQuestion` 之后、`running` 同级（自身或后代任一在跑 ⇒ running 转圈，不画绿勾）。改动集中在 `lib/pages.js` 的
   `renderWorkspaces()` / `refreshActiveSessionSummary()` / `applyBootData()` 三处取数与一处判据。
2. **notify 同判据**：`lib/bridge.js` 的 notify tick 里 `sample.running` 换成「自身 ∪ 后代」同一算法，否则推送继续误报。
   注意 `test/notify.test.js` 的「running→done 边沿恰好推一次」需要重铺子行场景。
3. **会话页明细（可选，另成一张卡）**：在 `SESSION_ROW_VALUE_KEYS` 加 `agentTeam` 并配**有界提取**（成员数 / 任务数 / 各成员 phase，
   不许把整个 roster 灌给手机），或直接走已有的 `session.projections` 通道（`lib/constants.js` 已注册，页面在会话内才同步，天然避开列表体积问题）。
   呈现按 WP3 调研的既有结论：手机屏幕小，折叠一行摘要 + 点开详情是唯一被验证过的形态（`F:\AgentData\work\20261007-pocket-copy-survey\WP3-CHATUI.md`）。
4. **ACP 舰队台账（另议）**：要在手机上看「谁在跑 / 哪家 CLI / 冷却」，得由 pocket 读 acp-progress 的运行态，跨插件数据面，成本远高于上面三项。

## 5. 这条 bug 在账本上的位置（用户印象校正）

- **没有任何 change 在做这件事。** 活跃卡与归档卡（`.agents/flow/changes/` 及 `archive/`、`rejected/`）里 pocket 相关 30+ 张，
  唯一沾「subagent」的是 `2026-10-03-fix-pocket-boot-focus-subagent`（含 `subagent-session-hiding` / `subagent-session-dom-assertions` 两张后续卡），
  方向**相反**：把子代理会话从手机端隐藏并加了断言（`CHANGELOG.md` 0.2.1 节，「子代理会话在手机端不可见」是被刻意锁定的行为）。
- `2026-10-07-feat-pocket-process-render-overhaul` 只在**转录的工具簇动词**里认得 `subagent` 这个工具名（`clusterToolBlocks`，
  见 `test/pages-process-render.test.js`），与「子代理会话/团队/工人的运行态显示」无关。
- 2026-10-07 的可抄性调研只留下一句方向性结论（WP3：任务树/子代理在手机上照 LobeChat 折叠卡那种形态做），没有落成卡。
- `README.md` 的「已知边界」节**也没有这条**——即当前文档把它当成不存在。本文件即为补上的那条记录。

⇒ 定性：**未实现的功能缺失（feature gap）+ 一处判据不完备导致的误报（真 bug）**。绿勾误报是可立即伤害使用的（用户在手机上被
「已完成」骗一次就不会再信这个界面），优先级高于「显示三类实体」的呈现工作。

## 6. 可复跑取证

```powershell
# 会话列表项字段与子行补齐逻辑（宿主投影源码）
node F:\defws\tmp\20261008-question-timeout-probe\asar-cat.mjs D:\DSH\resources\app.asar `
  dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.js out.js
# 官方桌面语义（三处原文所在）
node F:\defws\tmp\20261008-question-timeout-probe\asar-rg.mjs D:\DSH\resources\app.asar 'origin: .subagent.' 12 200
node F:\defws\tmp\20261008-question-timeout-probe\asar-cat.mjs D:\DSH\resources\app.asar `
  dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/README.zh.md workspace-readme.md
# pocket 侧四处过滤与判据
Select-String F:\defws\dsh-pocket\lib\pages.js -Pattern 'visibleSessions|taskState|taskGlyph'
Select-String F:\defws\dsh-pocket\lib\projections.js -Pattern 'SESSION_ROW_VALUE_KEYS'
Select-String F:\defws\dsh-pocket\lib\bridge.js -Pattern "origin !== 'subagent'|running: item.running|任务已完成"
# 现网投影：263 个文件里带 childId 的父会话 38 个；agentTeam.members 非空 0 个（本机从未真跑过 team）
```

本次取证的宿主原文快照：`F:\defws\tmp\20261008-pocket-agents-blind\`（`host-session-service.js`、
`host-ui-workspace-readme-zh.md`、`team-roster.js`、`team-ui-readme-zh.md`）。`tmp/` 内容可再生，不作长期保留承诺。

## 7. 未验证 / 遗留

- **Agent Team 成员会话在 pocket 侧的真实形状未实测**：本机 263 个投影里 `agentTeam.members` 非空为 0，
  即从没用过 team；「teammate 走 subagent 地址体系」是读 `roster.js` 用 `ctx.subagents.interrupt` 得出的，
  需要真跑一次 team 才能确认其在 `session.list` 上的 `origin` 值与 `parentId` 是否齐备。
- **ACP 工人的 subagent 会话形状同理未实测**：本次派 ACP 工人未落地（本会话工具面没有 `subagent_*` 的 ACP 位，
  `dispatch.mjs` 只写出任务卡 `F:\AgentData\work\20261008-115117-codebuddy-codebuddy-hy4\TASK.md`、`PROGRESS.md` 0 字节、无进程），
  改由内置 subagent 取证。这条派单失败本身是舰队运营问题，与本 bug 无关，但记此免得下游以为「ACP 显示」已验证过。
- **lead 自身 `running` 的宿主算式已直证**（`@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/manager.js`）：
  running 是**逐会话**的 agent 状态，由 `syncFromListSnapshot()` 把宿主列表响应的 `summary.running` 灌进
  `session.handleRunning(s.running)`，撤回时置 `handleRunning(false)`（状态帧形状 `{kind:'status', running:false, agentAvailable:false}`）。
  ⇒ 宿主**不会**把后代活动折进父行的 `running`；桌面那句「父行的 ongoing loading 来自其已加载 parent 目录中正在运行的直接 child」
  是**客户端侧聚合**（`dsh-client-ui-workspace` 自己做的）。所以 pocket 必须在 `lib/pages.js` 侧自己按 `parentId` 归并，等不到宿主替它算。
- **仍缺一件实测**：pocket 收到的 `session.list` 实况里子行是否总是存在（取决于宿主是否已把 child 补进快照、以及 scope 未加载时的 `?? false`）；
  需要真机连一次 pocket、在 lead 派 subagent 期间抓一次 `session.list` 响应体才能定。修法设计已按「有子行就聚合、无子行退回现状」写。

## 8. 与 GitHub 发布线的冲突提示（12:1x 补记）

本文件已进入 `dsh-pocket` 仓 HEAD（笔 `288fb36` + 本笔），**内含本机绝对路径**（`F:\defws\…`、`C:\Users\toast\…`、`F:\AgentData\work\…`）、
内部工人 id（`subagent_cb_hy4`、`codebuddy-hy4` 一类）与 flow 卡名。另一条线正在做「对外推干净新历史」的副本整形，
其 11:5x 统计的私有路径命中基线是 **pocket 41 处**（清单在 `F:\AgentData\work\20261008-release-pocket\private-path-inventory.txt`）——
该清单取的是整形时点的 `git ls-files`，**本文件不在其中**；若发布副本后续按新 HEAD 重刷，命中数会从这里往上走。
远端是**私有**仓（用户 10-08 令），带本机路径本身可接受；此处只记账，避免下游把「41 处」当现势值消费。
