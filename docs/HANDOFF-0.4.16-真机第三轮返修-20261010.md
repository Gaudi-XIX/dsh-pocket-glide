# HANDOFF — pocket 0.4.16 未落地部分（2026-10-10 21:5x）

## 0. 现场状态（重要：工作树是混合的，别一把梭）

`F:\defws\dsh-pocket` 当前 HEAD = `0485ecd`（0.4.15，他线的推送节奏改动）。工作树里混着**两拨未提交改动**：

| 归属 | 文件 | 状态 |
|---|---|---|
| **他线（0.4.15 在途）** | `lib/bridge.js`、`lib/mailbag.js`、`test/clawbot.test.js`、`test/mailbag.test.js`、`test/mailbag-post.test.js` | 不是我改的，别 add、别回滚 |
| **我（0.4.16）** | `lib/pages.js`、`test/pages-scroll-anchors.test.js`、`test/turn-footer-meta.test.js`、`test/boot-focus-subagent-guard.test.js`、`test/subagent-session-hiding.test.js` | 见下，前三项已完成、第四项半落地 |

⚠️ 我为了诊断用过 `git stash push -- <我的文件>` / `git stash pop`（各一次），文件内容已恢复，但**stash 的历史里有这两条记录**，看到别慌。

## 1. 已完成并验证的三项（只差提交）

1. **模型一点就消失** → 根因＝点击后我 `renderSessionSettings()` 重建整个面板。现在三个列表随面板一次性渲染、平时 `hidden`，点击只切 `hidden` + `aria-expanded`（新函数 `togglePickField`）。**代码在 `lib/pages.js`：`settingFieldHtml`（约 1215 行区）+ 面板 onclick（搜 `data-pick`）**。
2. **设置面板卡 1–2 秒** → `openSessionSettings` 不再 `rpc('session.list')`（整表 469 行 / ~195 KB 走隧道），改读页面已持有的 summary。配套改了 `test/boot-focus-subagent-guard.test.js:305`（AC-11）与 `test/subagent-session-hiding.test.js:53`：把 openSessionSettings 从"列表投影落点"里摘掉，并新增"设置面板不得再拉整表"的钉。**这两档我已改，未复跑**（见 §3）。
3. **↑/↓ 统一时机** → 只剩一道门：`dist>SCROLL_FOLLOW_PX(120)` 时 ↑↓ **同时出现**，回带内同时消失；↑＝视野上方最近一条用户消息，因为跳过去后它落在视野内，再按 ↑ 自然回翻上一条（无需游标）。删掉 `ANCHOR_LATEST_SCREENS`/`ANCHOR_LEAVE_SCREENS`/`ANCHOR_PROMPT_SCREENS` 与"整屏间隔"条款；`anchorVisibleState(dist,anchorAbove)` 变两参。`test/pages-scroll-anchors.test.js` 两档已按新契约重写。

## 2. 第四条＝半落地，**必须有人接手做完**

用户规则（2026-10-10 21:2x，原话）：
> 「现在 AI 发出来的每一条消息下面不是一块一块的吗？每一块消息下面都应该放一个时间，看着好像才对」

即：**每个 assistant 气泡各带自己的时间**，不是整轮一个、也不是"跑起来全隐藏"。

我已在 `lib/pages.js` 改了两处（就是这两处让 A16 变红）：
- `visibleMessages` 节点内 push 的 message 字面量加了 `messageTime:node.messageTime`（搜 `_seq:node._seq,messageTime:node.messageTime`）；
- `renderMessageTail` 的门从 `!agentRunning&&message.messageTime` 改成 `message.messageTime&&!message.streaming`（约 1126 行）。

### 要翻的旧契约（4 档，别绕）

`test/turn-footer-meta.test.js` 里 **A16 / A18 / A19 / T1** 钉的是**相反**的旧决策：「一轮只有一枚钟，挂在回合末那条文字上」。文件头注释还留着当时的变异实证记录（"每块一钟已废（时钟与药丸同门）"）。当前失败：

```
✖ A16 … AssertionError: exactly one clock on the turn-final text item, saw 2
```

接手要做：
1. 把这四档的期望从"每轮一枚"改成"每个已落地气泡一枚 + 每轮仍只有一枚 usage 药丸"；
2. **usage 药丸的归属不要动**——它仍应只有一枚（挂在回合末那条），这是 `lastText` 那段 `rendered[lastText].usage=…` 的职责，别顺手一起放开；
3. 文件头那段"每块一钟已废"的注释要改写成新决策＋用户原话，并**补一句为什么翻**（否则下次又有人按旧注释把它改回去）；
4. 这四档原先做过变异脚本（`F:\defws\tmp\mutate-footer.mjs`），翻完建议照例做一次红→绿变异自证，或者至少在卡里记"未做变异自证"。

### 若判断"不该翻"（另一种可能）

也有可能是我理解错：用户看到的"时间不见了"也许只是**跑动期间被旧门全局隐藏**（A20 的行为），而"每块一钟"是另一回事。那就退回去：把 §2 两处改动还原（`messageTime:node.messageTime` 与门的改法），恢复 A19c/A20 两档原文（它们也被我按新规则重写过了，见下），并回用户一句确认。

- 我把 `A19c` 改成了"每气泡为门"、`A20` 改成"跑动中已落地气泡保留钟"——**这两档现状与新代码一致、与旧契约相反**；退回代码就得同时退回这两档。

## 3. 收尾清单（接手者按顺序）

1. `cd F:\defws\dsh-pocket; node --test --test-concurrency=1 test/*.test.js` → **预期仍有 11 档红**：`test/tunnel.test.js` 那 11 档是**他线在途造成的**（我实测：把我的文件 `git stash` 掉后单独跑 tunnel.test.js 仍 fail 11），不是本卡范围，别去"修"它。
2. 除 tunnel 那 11 档外应全绿；若 `A16/A18/A19/T1` 仍红 → 说明 §2 没做完。
3. 版本：他线已发到 **0.4.15**，我这些记 **0.4.16**（一节里写清"真机第三轮返修：模型点击不重建／设置不拉整表／↑↓统一时机＋逐条回翻／每气泡一钟"）。
4. 提交纪律：**逐文件 add 我这五个文件**（§0 表格右列），commit message 里必须披露两条：① `lib/bridge.js`/`lib/mailbag.js`/三个 notify 测试是他线在途、未纳入本笔；② `test/tunnel.test.js` 11 档红为既存、非本笔引入。
5. 壳字节：现 zh 260272 / en 260199，**已超 `ASSET_BUDGET_BYTES=261_000`？没超**（余 ~0.7 KB）。若 §2 的收尾再加码，按规矩提额并在 `test/mobile-assets.test.js` 的 WP1 注释续对账单。
6. **全部改动都要重启 DeepSeek Harness 才生效**；现网跑的仍是 0.4.13。真机目验四项：模型点开不消失／设置面板秒开／↑↓同时出现且连按回翻／每块下面的时间。
