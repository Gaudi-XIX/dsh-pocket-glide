# 提问「没人答就自己继续」探寻报告

调研时间：2026-10-08 W3 11:33–12:00（数据基准：现网 `D:\DSH\resources\app.asar` = 官方 desktop 0.2.0-rc.1/2，`~/.dsh/sessions` 337 个会话文件全量解码，`~/.dsh/pocket/logs/pocket.log` 自 2026-09-30 起）
结论由 LEAD 直读宿主发布包原文与本机会话记录得出，非推断。复跑件：`F:\defws\tmp\20261008-question-timeout-probe\`（`asar-rg.mjs`/`asar-cat.mjs` 搜 asar，`outcomes2.mjs`/`empty-answers.mjs` 解 zstd 会话）。

## 一句话结论

**「超时自动回答」这条假设被证伪。** 超时机制确实存在，但住在宿主机核、且本机从未启用；会话记录里 161 次真实提问调用中超时次数为 **0**。让 agent 自己往下走的实际原因是另一件事：**有 17 次提问的返回值是空答案 `{"answers":[{"id":"…","selected":[]}]}`**，而空 `selected` 在协议里的语义是「用户显式跳过」。

A（复现）已做完，见 §4：**页面代码里不存在「没有用户手势也能提交」的路径**，10 条断言 + 三种变异回归证明。所以那些空答案每一次都对应一次真实的「跳过」点击；可行动的是命中区设计（P-9：`跳过` 与 `提交` 在手机上贴在一起），不是提交逻辑。

## 1. 「不要瞎提问」——已经写了

`~/.dsh/AGENTS.md` 「输出方式」节第 22 行原文：

> 在红线范围内直接执行，不问确认性话术。判据：只有一条合理路径的**执行选择**自己定（执行选择≠方向决策）；多条合理路径各有利弊的方向分叉才问

规则不缺，缺的是执行。**新发现的冲突**：`flow` 技能的 intent 盘问循环（gate-clarity 等）会按机制强制发问，与这条「只有一条合理路径就别问」存在张力。实证：会话 `session-d25c4f73`（11:22 起，paradise 标签那条）11:30 那次提问的两个选项是「可以，转 change 开工（推荐）」/「不对，我要改」——只有一个合理推荐路径，按上面这条本就不该问。归属应判给 flow 的盘问纪律，不是 Pocket、不是宿主。

## 2. 超时机制在哪一端

| | 位置 | 现网状态 |
|---|---|---|
| 超时本体 | 宿主机核 `@deepseek-ai/dsh-user-questions/lib/types/timed-wait.js` + `@deepseek-ai/dsh-tool-ask-user/lib/index.js` | 代码存在，**未启用** |
| Pocket | `dsh-pocket/lib/constants.js`、`lib/questions.js` | **刻意不做**，且有测试钉死 |

- 工具是两种模式，`Config.mode` 默认 `legacy`（阻塞，永不自答）。只有 preset 条目写成 `config: {mode: timed, timeout: N}` 才有倒计时，`timeout` 缺省 120 秒。
- 出厂三个 preset（`dsh-web-app/presets/` 的 standard / cordis / ptc）的 `- id: tool-ask-user` 条目**都没有 config 段** ⇒ 现网走 legacy。
- 到期时返回的不是「替你选了推荐项」，而是 `{pending:true, callId, message}`，message 原文：`… Continue useful independent work. … Do not treat this as permission.`（模型被明确要求继续独立干活，所以看起来像「自己回答了」）
- 计时只在**没有任何回答界面 claim 这个等待**时才跑：`TimedQuestionWait.schedule()` 里 `claims.size > 0` 直接 return。桌面卡片打开时调 `ctx.remote.userQuestions.attachWait(…)` 持有等待；焦点落在回答区还会 `holdFocus()`（i18n 键 `wait.paused`）。**Pocket 全仓对 `attachWait` 零命中**——手机从不 claim。这条现在无害（legacy 不计时），但**一旦哪天开了 timed 模式，手机端就会 120 秒必自答**。
- Pocket 侧明确无超时：`constants.js` 写「A question stays answerable while it is on the phone's screen, whatever the …」，`test/map-ceilings.test.js` 断言 `held.expiresAt === undefined`（"a question carries no deadline"）与 "a question survives any number of sweeps — time is not the eviction rule"。pendingQuestions 只有条数上限 + 驱逐，没有过期。

## 3. 真凶：17 次空答案

`empty-answers.mjs` 全量扫描（161 次已完成调用，17 次空答案，去重后约 9 个独立事件——同一结果在 fork 的两个会话文件里各记一次）：

```
2026-10-08 11:30:08 → 11:32:32  wait=  143s  nQ=1   {"answers":[{"id":"final","selected":[]}]}
2026-10-06 21:49:45 → 21:51:01  wait=   76s  nQ=1   {"answers":[{"id":"repro","selected":[]}]}
2026-10-06 20:46:58 → 21:03:33  wait=  996s  nQ=2   两题全空
2026-10-04 13:14:19 → 13:15:03  wait=   44s  nQ=1
2026-10-02 23:37:15 → 23:38:16  wait=   61s  nQ=2   两题全空
2026-10-02 08:41:07 → 08:51:00  wait=  593s  nQ=1
2026-10-02 01:18:42 → 08:18:40  wait=25198s nQ=1    （睡了 7 小时）
2026-10-01 22:11:05 / 20:36:49  wait= 93s / 675s
2026-09-29 17:47:43 → 17:47:53  wait=   10s  nQ=1
2026-09-26 22:05:32 → 22:08:26  wait=  174s  nQ=2
```

**等待时长从 10 秒到 7 小时，没有聚集在某个固定值 ⇒ 不是定时器**（定时器会全数落在 120s/timeout 上）。空答案在全部调用里的占比随时长上升：`>=10min` 档 27 次里 5 次空、`1-2min` 档 31 次里 5 次空。

两端提交路径都要求显式动作，代码上都没有「自动提交」：
- 桌面 `submitDrafts()`：未完成项先 `error.incomplete` 拦回，只有 `value.skipped` 才产出 `selected: []`；skip 是按钮。
- Pocket `$('questionComposer').onclick`：只认 `data-option-index` / `continue` / `skip` / `cancel` / `previous`；`advanceQuestion(false)` 没选就报 `L.chooseAnswer` 并 return，只有 `skip` 分支写 `draft.skipped=true`。

一条现场线索值得注意：2026-10-06 那次，手机 `13:50:57` 打开页面 → `13:51:01` 宿主记录到空答案 → `13:51:02` Pocket 收到第二次 `interaction.answer` 被拒（`This question request is no longer pending.`）。1 秒内两次提交，形态更像**连点**（skip 钮与 continue 钮在同一行右端），而非定时。注意 Pocket 的 `interaction.answer` **成功路径不写日志**，因此「pocket.log 里没有 question 记录」不能证明手机没提交——这条曾误导本次排查。

## 4. A 已做完：自动提交路径**不存在**（复现件 + 变异证明）

用户裁定走 A（测试复现），intent 盘问机制保留不动。结论已用可复跑件定死，不再依赖猜测：

`test/question-no-gesture-no-submit.test.js`（10 条，全绿；全量门禁 924 tests / 922 pass / 0 fail / 2 skip）
把页面**真实**的 `$('questionComposer').onclick` handler 与真实的 `advanceQuestion` / `submitQuestionAnswers` / `cancelQuestionRequest` / `syncPendingQuestion` 抽进沙箱跑：

| 断言 | 命题 |
|---|---|
| P-1 / P-2 | 问题到达后只等着、或点在非控件处 → **一次都不发** `interaction.answer` |
| P-3 | 什么都没选就点提交 → 被页面守卫拦回并给文案，**不会**发空答案 |
| P-4 | 点「跳过」是**唯一**能产出 `{selected:[]}` 的手势 |
| P-5 | 两题全空 = **两次**跳过点击（复现 10-01 22:11 那次的形态） |
| P-6 / P-7 / P-8 | 选项+提交不为空；cancel 走 `interaction.cancel`；busy 后连点不再结算 |
| P-9 | 渲染的按钮条里「跳过」与「提交」**直接相邻**，中间无任何标记 |
| P-10 | `submitQuestionAnswers()` 全页只有 2 个调用点，且任一调用点前 120 字符内不得出现 timer/listener |

P-4/P-6/P-7 是正向断言（要求「真的发出去了」），因此 P-1/P-2 的「没发出」不是空转得来——这一点本身是踩出来的：初版把 `pendingQuestion` 手工置错成 `undefined`，`advanceQuestion` 一进门就 return，导致 P-1/P-2 **假通过**，是 P-3 报错才暴露的。

**变异证明**（证明断言能失败，非恒绿）：注入三种自动提交回归——重连时自动跳过、`setTimeout(()=>{submitQuestionAnswers()},120000)`、`visibilitychange` 驱动——三者全部判红，真实页面判绿。

顺带修掉一条**虚设的守门**：初版用 `/setTimeout\([^)]*submitQuestionAnswers/`，而箭头函数自带的 `)` 提前结束了字符类，这条子句**对任何代码都恒真**。换成调用点回溯判据后 MUT-2 才被抓到。同类的「看起来在防、其实防不住」，与 0.3.1 那次「90s 截止通道空转」是同一种病。

### 所以 17 次空答案是什么

> **本节归因已被用户补充观测推翻一半，见 §4b。** Pocket 侧「无手势不提交」仍然成立；但「每次都对应一次真实跳过点击」是错的——操作者根本没碰鼠标，碰的是**键盘**。

代码侧排除后，Pocket 这一端的解释只剩一个：**每一次 `selected:[]` 都是一次真实的「跳过」点击**（多题全空 = 逐题点过）。这与 §3 的时长分布（10s…7h，无固定聚集）和 10-06 那次 1 秒内两次提交（第二次被宿主拒为 `no longer pending`）完全一致。

用户「没看到」却又产生了跳过，物理成因在 P-9：手机上 `跳过` 与 `提交` 并排贴在一起、右端成簇，**语义相差一个指位**。操作者凭位置习惯性点右端时，落点是「跳过」。这不是提交逻辑的 bug，是**把「授权跳过」放在与「提交」同一命中簇里**的设计缺陷。

## 4b. 用户补充观测：「进去啥都没点，就刷刷刷全部跳过了」→ 真凶在桌面卡片

这条观测把范围从「Pocket 的鼠标」挪到**宿主桌面 GUI 的键盘**——而且 10-08 11:30 那次空答案提交时手机本就离线，**作答端一直是桌面**。本次实测的盲区正是桌面（只测了 Pocket），现补。

`@deepseek-ai/dsh-client-ui-user-questions/lib/client.js`（宿主发布包原文，非推断）里四件事叠成一条免确认通路：

| # | 代码位置 | 事实 |
|---|---|---|
| 1 | `initialDrafts` | 单选题带 `(Recommended)` 时，**推荐项被预置进草稿**：`selected: answer===void 0 && recommended!==void 0 ? [recommended] : …` |
| 2 | `answered()` / `completed()` | 预置即视为**已答**：`answered = selected.length>0 \|\| custom.trim()!==""` |
| 3 | `AnswerField` 的 `autoFocus` | `canSubmit && countdown === void 0 && !locked && !focused…`——**countdown 为空才聚焦，而现网正是 legacy 模式（无 deadline），所以每次必自动聚焦**到回答输入框 |
| 4 | `continueFromCustom` | 该输入框 `onKeyDown` 上，**裸 Enter**（只排除 shiftKey 与输入法 composing）即 `continueFlow()`：已答就 `index+1` 前进，到最后一题就 `submitDrafts(drafts)` 提交 |

于是：卡片出现 → 焦点自动落在回答框 → 每题都已预置成「已答」→ **用户照习惯按 Enter（以为在发下一条消息），一次翻页一题，末题那一下直接整批提交**。观感就是「我啥都没点，它刷刷刷全部跳过」，而 agent 收到的是**替你选的推荐项**——正好是最初那句「你就自己回答了」。

选项按钮上还另有一条更短的：`onKeyDown: Enter → submitDrafts(drafts)`，焦点在选项上时 Enter **直接提交整批**，不经过 `continueFlow` 的翻页。

**对照：Pocket 是安全的**。手机页同样的推进要求 **Ctrl/Cmd+Enter**（`e.key==='Enter'&&(e.metaKey||e.ctrlKey)`），裸 Enter 不推进——已补成 P-11/P-12 两条断言钉住，防止哪天有人把两端"对齐"成裸 Enter。

`selected:[]` 这一形态仍需一次 `skipped` 才能产出（`submitDrafts` 里只有 `value.skipped` 分支输出空 selected），所以 17 次空答案是**键盘免确认提交**与**跳过**两种操作混在一起的产物；单靠读码到此为止，见 §6 的受控验证。

## 4c. 处置边界

这条通路在**宿主包里**，而工作区硬约束 7 明确「禁止再改宿主文件」。所以可动的只有三处：向 DSH 官方报问题、操作侧规避（提问卡片出现时先别按 Enter）、以及 Pocket 端保持并已证明的保守键盘策略。**不是 Pocket 的 bug，也不是能在本仓修掉的 bug。**



## 5. 建议（按影响排序）

1. **对 Pocket（唯一待裁定的动作，A 之后剩下的就是它）**：既然代码证明「空答案 ⇔ 一次跳过点击」，可改的只有命中区设计——skip 走二次确认，或与提交分开到不同命中区；并把文案从「跳过」改成能表达后果的句子（如「本题不答，按跳过提交」）。**未动手，等用户裁定**：这属于方向分叉（三种改法各有取舍），且本轮用户只令做 A。
2. **对宿主/preset**：不要把 `tool-ask-user` 开成 `mode: timed`，除非先给 Pocket 补 `attachWait` claim——否则手机端提问必在 timeout 到点后自答（见 §2 最后一条）。这是**架构风险，不是当前影响**：当前影响为 0（现网 legacy），换到 timed 的那天才兑现。
3. **对 flow**：盘问循环加一条「只有一个合理推荐路径就不发问」的前置判断，与 `~/.dsh/AGENTS.md:22` 对齐。
4. 提问语义本身值得记一笔：**空答案（跳过）≠ 沉默**。宿主 legacy 下用户不答就一直挂着，任何返回 `selected: []` 的结果都意味着「有人提交了跳过」，agent 侧应当按「用户明确不表态」处理，不得当作默认同意——`session-d25c4f73` 里模型当时的判断是对的（"An empty answer is not approval"）。
