# Pocket 对「子代理 / Agent Team / ACP 工人」全盲，且把它们在跑时的父会话画成已完成（绿勾）

> 本文件第二版（12:2x 重写）。第一版由 LEAD 直读宿主发布包得出；第二版合入一条独立取证线（产物
> `F:\AgentData\work\20261008-pocket-agent-display-probe\HOST-FACTS.md`）的交叉验证，**据此改掉了第一版写错的字段名**
> （`parentId` → 实为 `parentSessionId`），并把两条由取证带出的新事实升级成结论；另补 §6 第二条 bug（LEAD 第一版漏判）。
> 两处冲突的处理都写在 §8。

调研时间：2026-10-08 W4 11:47–12:2x（数据基准：`D:\DSH\resources\app.asar` 121,348,951 B，其内 `dsh/package.json`
= `@deepseek-ai/dsh-desktop-runtime` **version 0.2.0-rc.2**；`~/.dsh/storages/session_projcache/sessions` 263 个投影全量扫描；
pocket 源码基准 = `dsh-pocket` HEAD `4e92143`、`package.json` 版本 **0.4.0**）

## 1. 一句话结论

**用户报的两件事同源，且都不是回归：**桌面端已有的「父会话行代表后代活动」聚合，Pocket 从来没实现过（没有任何 change 在做，见 §7）；
而 pocket 的行状态判据只看该行自己的 `running`——宿主那个字段是**逐会话**量、明确不会把后代活动折进去，
于是 lead 派活并交还控制权之后，手机上出现绿勾「已完成」，同时桥还会推一条「任务已完成」。
三种实体（内置子代理 / agent team 成员 / ACP 工人）在宿主列表面上**是同一个形状**（都是 `origin:'subagent'` 的子会话），
所以一条聚合能同时让三者可见；要**区分**它们才需要额外一跳（§5-④）。

## 2. 现象与判据（pocket 侧）

| 现象 | 符号锚 | 实况 |
|---|---|---|
| 三种实体在手机端没有任何显示出口 | `visibleSessions()`、`openableFocus()`（`lib/pages.js`）、`pickFocusItem()`（`lib/bridge.js`）、`createSessionIn()` 里的 `created.origin!=='subagent'` | 带 `origin==='subagent'` 的行被四处过滤；父行不做任何后代聚合；`lib/` 全仓 `team`、`acp` 字样**零命中** |
| 后代在跑时行尾画绿实心勾（= 已完成） | `taskState()` 兜底返回 `'done'` → `taskGlyph('done')` → CSS `.ws-last.is-done{color:#35a867}`（`lib/pages.js`） | 前置条件只有 `awaitingQuestion / error / running / blank`，**全部只看该会话自身** |
| 同一判据的第二个出口 | notify tick：`const sample = { running: item.running === true, … }` → 停跳即 `notifySend(config, title, '任务已完成', …)`（`lib/bridge.js`） | 绿勾误报的同时手机还收到假完成推送。**修状态不同改这里 = 界面修好、推送继续骗人** |

## 3. 宿主数据面实况（官方声明原文，两路独立取证一致）

`@deepseek-ai/dsh-api-session-controller` 的 typert 声明里，会话行的线格式是**封闭的 9 键**：

```ts
export interface SessionSummary {
    readonly agentAvailable: boolean;   // = ctx.agents.get(id)?.session === session（该会话的 agent 实例是否在本进程可用）
    readonly sessionId: SessionId;
    readonly updatedAt: number;
    readonly running: boolean;
    readonly blank: boolean;
    readonly parentSessionId?: SessionId;   // ← 由 listFields() 从 header.parentSession 改名而来
    readonly origin?: 'subagent';           // ← 类型层就只有一个非缺省取值
    readonly cwd?: string;
    readonly projections?: SessionProjectionHints;
}
```

- **`origin` 的取值集合 = { 缺省（本地会话） | `'subagent'` }**，没有 `'local'`/`'teammate'`/`'acp'`。
- **三类实体在行面上同形**：agent team 成员由 `ctx.subagents.startContinuable({...})` 起
  （`dsh-experimental-agent-team/lib/types/roster.js`、`…/lib/index.js`）；ACP 工人由现役装载的市场插件
  `@deepseek-ai/dsh-subagent-acp` 注册进同一个运行时（`lib/index.js`：`providerName: z.string().default("acp")` +
  `ctx.subagents.registerProvider(new AcpProvider(validated.providerName, ctx, validated))`）。
  两者的子会话都是 `origin:'subagent'` + `parentSessionId = lead`。
- **`running` 是逐会话量**：`summaryFor()` 里 `running` 来自 agent loop 的 `get status()`（phase ∈ idle|running|maintenance）。
  lead 派活并交还控制权 ⇒ 它的 agent 回 idle ⇒ **`running=false`**；只有子会话结算时经 `parent.followup → wakeDriver` 才被短暂打回 true。
  ⇒ 宿主不会替客户端算「背后还有活」，聚合必须在 pocket 侧做。
- **`session/agent-busy` 不是「有子任务」的信号**，是**路由归属拒绝**：对 `origin==='subagent'` 的会话用普通 `kind:'session'` 地址读写即抛
  （`apiSessionSubagentOwnershipError` / history 的 `validateAddress`），要求 durable parent address。
- `agentPreset` / `title` / `depth` **都不是行字段**（在 `SessionHeader` 与投影里）。见 §6。
- 这些字段能穿过 pocket 桥的裁剪：`compactSessionRows()`/`compactRowValues()`（`lib/projections.js`）对非白名单键采取
  「小值即留」（≤200 字符串 / 数字 / 布尔 / null），`parentSessionId`、`origin`、`agentAvailable`、`running` 都保留；
  而 `subagentCatalog`、`agentTeam`、`goal` 这类对象在**列表行**上被丢弃（这条裁剪本身是对的：实测整包 ~1 MB / 2026-10-01 事故）。

## 4. 桌面端已有的正确形态（官方文档原文口径）

`@deepseek-ai/dsh-client-ui-workspace/README.zh.md`：

- 「侧边栏隐藏持久化摘要中带有 `origin: 'subagent'` 的行。**可见普通行的共享 ongoing loading 来自其已加载 parent 目录中正在运行的直接 child**，绝不来自摘要谱系。」
- 「待处理交互的优先级高于共享 ongoing loading；已完成但未查看的 Session 使用 done。」
- 「正在运行的 Session（**包括有子会话正在运行的父会话**）始终按原顺序显示，不占用这五条配额。」

⇒ **pocket 过滤子行与桌面一致，这条不该动**；缺的是父行的后代聚合。Agent Team 另有桌面专属面板
（`dsh-experimental-client-ui-agent-team/README.zh.md`：从 Lead Session 的 `agentTeam` 投影读 roster/任务板，
provisioning 与 running 成员用共享 ongoing loading，failed 红点），手机无。

⚠️ 同源限制：桌面的聚合只在**父目录已加载**时成立；子会话 scope 未加载时宿主给的就是 `running:false`（且 `agentAvailable:false` 标得出这种情况），
此时桌面同样退回 `done`。pocket 照此修可消除主现象，不保证 100% 不漏。

## 5. 修复面（按代价从低到高；④⑤ 是本次交叉验证新加的约束）

1. **父行聚合（核心，改 `lib/pages.js`）**：`taskState()` 增「后代活动」入参，调用方按 **`parentSessionId`** 把
   `origin==='subagent' && running===true` 的子行归到父行；自身或后代任一在跑 ⇒ running 转圈，不画绿勾。
   取数三处：`applyBootData()`、`refreshActiveSessionSummary()`、`renderWorkspaces()`。
   建议同时把 `agentAvailable===false` 的父行标成「状态未知」而非 done——这是现成的诚实出口。
2. **notify 同判据（改 `lib/bridge.js`）**：notify tick 的 `sample.running` 换成「自身 ∪ 后代」同一算法，否则推送继续误报；
   `test/notify.test.js` 的「running→done 恰好推一次」需重铺子行场景。
3. **会话页明细（可选，另成一张卡）**：走已有的 `session.projections`（`lib/constants.js` 已注册 `session/projections`）取
   `values.subagentCatalog` / `values.agentTeam.members`，官方 `dsh-client-ui-subagent` 面板就是这条路上。呈现按 WP3 调研结论：
   手机屏幕小，折叠一行摘要 + 点开详情（`F:\AgentData\work\20261007-pocket-copy-survey\WP3-CHATUI.md`）。
4. **⚠️ 光靠 `subagentCatalog` 判「还在跑」不够**：它是 append-only、**只记身份不标终态**。要判活跃需组合
   `subagentTiming{settledMs, active{since, through}}`、或 member 行自己的 `running`（`agentTeam` 投影**没有**任何运行态字段，
   必须二次去行面上查）、或后台 one-shot 子代理的 `job/list {sessionId}` 里 `kind:"subagent"` 作业状态。
5. **⚠️ 想区分三类实体需要额外一跳**：`provider` 名（内置 / `acp` / fork）只出现在子会话的 `subagent/descriptor` 事件里，
   读它得用 durable parent address 走 `session/page`/`session/follow`。宿主**没有**「聚合活跃子任务」布尔，
   `subagents.listChildren/listDescendants` **未标 @Remote**（第三方插件用不了，只能自己按 `parentSessionId` 组树）。
6. **ACP 舰队台账（另议）**：哪家 CLI / 冷却 / 额度这类信息在 `dsh-acp-progress` 自己的运行态里，跨插件，成本远高于 1–2 项。

## 6. 顺带挖出的第二条 bug（独立，级别低）：权限预设下拉的当前值读错了源

- **事实**：`agentPreset` 在宿主侧存在于 `SessionHeader`（可选）与投影 `SessionProjectionMap.agentPreset: string|null`，
  **不在 `SessionSummary` 上**。而 pocket 页面把它当行字段读：
  `openSession()` 里 `currentPreset=summary?.agentPreset||null`（`lib/pages.js`）—— 恒 `undefined` ⇒ 每次进会话都把当前预设归零；
  `refreshActiveSessionSummary()` 与 `openSessionSettings()` 里 `currentPreset=summary.agentPreset||currentPreset` —— 恒不更新。
  随后 `renderSessionSettings()` 用 `presetValue = presets.some(i=>i.id===currentPreset) ? currentPreset : presetFallback` 兜底，
  ⇒ **下拉框停在「默认档」，而不是该会话真实的预设**。
- **唯一有效的一处**是 `createSessionIn()` 读 `created.agentPreset`：`SessionCreateValue` 线格式**确有**该字段；
  `selectPreset()` 读 `agentPreset.select` 返回值同样有效——所以症状是「刚改完显示对，重进会话就漂回默认档」。
- **严重性分栏**：对当前现网影响 **低**——`presetIsLocked(){return !sessionBlank||optimisticPrompts.length>0}` 使非空白会话的下拉本就禁用
  （宿主侧也有 `agent-preset/locked` 错误码，两边语义一致，那条锁定不是 bug），所以后果只有**显示误导**，没有误写风险；
  对代码面影响也低：修法是把读源改成 `projections.values.agentPreset`，而该值作为短字符串**已能穿过桥的小值保留规则**，
  **不需要动 `SESSION_ROW_VALUE_KEYS` 白名单**（这点第一版若写会容易误判成要放开白名单）。
- 记这一条的理由：它是「同一个认知错误（把投影列当行字段）的两处症状」之一，与 §5 的聚合修在同一个函数面上，宜同批处理。

## 7. 账本校正：这条 bug 之前**没有**任何 change 在做

- 活跃卡与归档卡（`.agents/flow/changes/` 及 `archive/`、`rejected/`）里 pocket 相关 30+ 张，唯一沾 `subagent` 的是
  `2026-10-03-fix-pocket-boot-focus-subagent`（后续 `subagent-session-hiding` / `subagent-session-dom-assertions`），**方向相反**：
  把子代理会话从手机端隐藏并加断言（`CHANGELOG.md` 0.2.1：「子代理会话在手机端不可见」是被刻意锁定的行为）。
- `2026-10-07-feat-pocket-process-render-overhaul` 只在**转录的工具簇动词**里认得 `subagent` 这个工具名（`clusterToolBlocks`），与运行态显示无关。
- 2026-10-07 可抄性调研只留一句方向结论（WP3：手机上看子代理照 LobeChat 折叠卡那种形态做），没落成卡。
- `README.md`「已知边界」节没有这条 —— 当前文档把它当成不存在。本文件即为补账。

## 8. 两处取证冲突的处理（Provenance）

| 项 | 第一版（LEAD 直读） | 第二版采信 | 依据 |
|---|---|---|---|
| 父指针对段的名字 | 写作 `parentId` | **改为 `parentSessionId`** | 我第一版引的是 `projectList()` 里宿主 **UI store 内部 byId** 形状；RPC 线格式由 `listFields()`（`dsh-api-session-controller/lib/types/list.js`）与 `interface SessionSummary` 声明定为 `parentSessionId`，两路独立取证一致 ⇒ 采信 `parentSessionId`，第一版该处为**读错层** |
| 宿主版本 | 沿用 AGENTS.md 的 v0.2.0-rc.1 | **0.2.0-rc.2** | 直读 asar 内 `dsh/package.json`（`@deepseek-ai/dsh-desktop-runtime` version 字段实测）。⚠️ 这使 `AGENTS.md` 权威层记的「预览版 v0.2.0-rc.1」成为**待更正错账**；该文件正被另一条线写，未由我改 |

## 9. 可复跑取证

```powershell
# 宿主 bundle 内三处原文（线格式声明 + 官方桌面语义 + 子行补齐）
node F:\defws\tmp\20261008-question-timeout-probe\asar-rg.mjs D:\DSH\resources\app.asar 'interface SessionSummary' 4 500
node F:\defws\tmp\20261008-question-timeout-probe\asar-cat.mjs D:\DSH\resources\app.asar `
  dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/README.zh.md workspace-readme.md
# 已抽出的整包副本（1541 个 @deepseek-ai js/json，grep 比 re-slice asar 快）
#   F:\defws\tmp\20261008-host-session-probe\extract\@deepseek-ai\
# 独立取证件（Q1–Q5 全量，每条带符号名+原文片段）
#   F:\AgentData\work\20261008-pocket-agent-display-probe\HOST-FACTS.md
# 本次 LEAD 侧原文快照
#   F:\defws\tmp\20261008-pocket-agents-blind\（host-session-service.js / host-session-manager.js /
#   host-ui-workspace-readme-zh.md / team-roster.js / team-ui-readme-zh.md / dsh-package.json）
# pocket 侧
Select-String F:\defws\dsh-pocket\lib\pages.js -Pattern 'visibleSessions|taskState|taskGlyph|summary.agentPreset'
Select-String F:\defws\dsh-pocket\lib\projections.js -Pattern 'SESSION_ROW_VALUE_KEYS'
Select-String F:\defws\dsh-pocket\lib\bridge.js -Pattern "origin !== 'subagent'|running: item.running|任务已完成"
```

`tmp/` 内容可再生，不作长期保留承诺。

## 10. 未验证 / 遗留

- **agent team 现网无样本**：263 个投影里 `agentTeam.members` 非空 = 0（本机从没真跑过 team）。
  「成员会话 = `startContinuable` 造的 subagent 子会话」是**源码级直证**（roster.js / index.js 两处调用点），
  但其在 `session/list` 上的 `parentSessionId`/`running` 是否齐备仍需真跑一次 team 目验。
- **pocket 实际收到的 `session.list` 响应体未抓过**：子行是否总在、`agentAvailable` 在冷会话上的表现，需要真机连 pocket 在 lead 派子代理期间抓一次。
- **本次 ACP 派单未落地**（与 bug 无关，记此免得下游误以为「ACP 显示」已验证）：本会话工具面没有 ACP 的 `subagent_*` 位，
  `dispatch.mjs` 只写出任务卡 `F:\AgentData\work\20261008-115117-codebuddy-codebuddy-hy4\TASK.md`（`PROGRESS.md` 0 字节、无进程）；
  改由内置 subagent 完成取证，且**没给它设定稿时限**（它 12:08 才交件，约 17 分钟）。
- §5-④⑤ 的两条组合判据（`subagentTiming.active.through` 与 `job/list`）只到"存在可用字段"这一层，未实测其边界（结算后 through 是否停更、job 表保留多久）。

## 11. 与 GitHub 发布线的冲突提示

本文件已进入 `dsh-pocket` 仓 HEAD（`288fb36` + `cf4202b` + 本笔），**内含本机绝对路径**（`F:\defws\…`、`C:\Users\toast\…`、`F:\AgentData\work\…`）
与内部工人 id（`subagent_cb_hy4`、`codebuddy-hy4` 一类）。另一条线在做「对外推干净新历史」的副本整形，
其 11:5x 统计的私有路径命中基线 = **pocket 41 处**（清单 `F:\AgentData\work\20261008-release-pocket\private-path-inventory.txt`），
取的是整形时点的 `git ls-files`、**不含本文件**；若按新 HEAD 重刷，该数会从这里往上走。远端是**私有**仓（用户 10-08 令），带本机路径本身可接受，
此处只记账，避免下游把「41 处」当现势值消费。
