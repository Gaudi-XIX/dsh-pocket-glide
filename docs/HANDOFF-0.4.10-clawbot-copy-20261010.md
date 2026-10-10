# HANDOFF：pocket 微信 ClawBot 直连推送（0.4.10 已提交，剩真机验收）

写于 2026-10-10 上午，收尾于同日 10:5x。本文件是**跨会话续接的唯一入口**：接手的人读完这一份就能接着干，不需要回看聊天记录。

---

## 1. 一句话现状

微信 ClawBot 直连通道的功能本体（0.4.7 / 0.4.8 / 0.4.9）与文案改造（0.4.10）**全部已提交**，
工作树只剩本文件未跟踪。**剩下的唯一一件事是：重启 DSH，然后照 §7 做 ClawBot 通道的首次真机端到端验收**
——这个验收以前从没做过（0.4.9 起消息才真能送到微信，而它要重启才装载）。
0.4.10 = `4b0fd08`（4 files / +62 −20），全量测试 **995＝993 pass / 0 fail / 2 skipped**。

---

## 2. 用户诉求（原始，逐字）

> User said (m01400): 「一起补。然后这个推送，第一不用强调DSH，都是DSH里的。第二个，哪个会话的推送要写上会话名称。第三个，推送的原因要简单写上。比如有提问需要回答、已经完成、什么报错停止（这个不一定能看出来），等等等等。先把前两个完成，其他的异常到时候慢慢优化。」

解读与本轮范围：
- ① 去掉推送里的「DSH Pocket」自报家门
- ② 推送带上会话名
- ③ 简单写明推送原因
- **本轮做前两条 ＋ 补 clawbot watcher 的静默吞异常**；③里的「什么报错停止」类（异常/停止原因）**留待后续优化**，用户明说「到时候慢慢优化」

早前的相关诉求（已完工，列此备查）：
- User said (m00778): 「重启了。绑定了，发送测试没反应。」
- User said (m01211): 「一条都没收到」
- User said (m01236): 「11a 和 11c 收到了」——这句是**根因的判决性证据**（见 §5）

---

## 3. 仓库与环境

| 事项 | 值 |
|---|---|
| 仓 | `F:\defws\dsh-pocket`（DSH Pocket 手机桥插件，Node ESM，桥端口 43127） |
| 装机形态 | `C:\Users\toast\.dsh\profiles\desktop\node_modules\@defws\dsh-pocket` 是 **junction**，Target=`F:\defws\dsh-pocket`；全盘只此一份 `lib\clawbot.js` ⇒ 改工作树即改现网代码 |
| 装载机制 | **改源码必须重启 DSH 才生效**（junction 活的，但宿主 bundle 随启动装载） |
| 重启脚本 | `F:\defws\scripts\dsh-restart-now.ps1`（先 `-DryRun`） |
| 插件日志 | `C:\Users\toast\.dsh\pocket\logs\pocket.log`，**`t` 字段是 UTC，读时 +8** |
| 设置档 | `C:\Users\toast\AppData\Local\dsh-pocket\mobile-bridge-settings.json`（含 `notify.clawbot.{botToken,userId,contextToken}`，0600） |
| 探针目录 | `F:\defws\tmp\20261010-clawbot-probe\`（根仓 gitignore 掉 `tmp/`，不入库） |
| 测试命令 | `cd F:\defws\dsh-pocket; node --test --test-concurrency=1 test/*.test.js` |

### commit 纪律（`F:\defws\AGENTS.md` 硬约束，违反会造成事故）

1. **逐文件显式 `git add`**，禁 `git add -A` / `-u` 裹挟。
2. commit 前跑 `git grep --cached -E 'sk-[A-Za-z0-9]{32,}'` 复扫（历史实测 0 命中）。
3. `stash@{0}: pocket-tunnel-autostart-and-address-push-REVERTED-20261009` **属用户资产，勿清**。
4. **`pwsh` 拼含中文引号的 `git commit -m` 会转义失败**（报 `error: pathspec '...`）⇒ 先用 write 工具把 message 写到 `F:\defws\tmp\20261010-clawbot-probe\`，再 `git commit -F <file>`。
5. 改 `F:\defws\AGENTS.md`/`docs/`/`tools/`/`scripts/` 也要 commit。

---

## 4. 已提交的四笔（git log）

```
4b0fd08 feat(notify): 推送换形状——标题是会话名、正文是原因，就绪回执不再静默吞失败 (0.4.10)
e575529 fix(clawbot): 消息项类型键名改为 type——服务端受理但微信端静默丢弃的真根因 (0.4.9)
3ba7e67 fix(notify): clawbot 成功也落日志并回传 message_id——日志沉默不再等于没发出去 (0.4.8)
5cb8c66 feat(notify): 微信 ClawBot 直连通道——iLink bot 协议自建，扫码绑定 + context_token 换令牌 + 三类推送 (0.4.7)
```

### 0.4.7（`5cb8c66`，11 files / +965 −20）
新增 `lib/clawbot.js`（约 260 行，统一 `{ok,error}` 永不抛）：
`randomUin / buildIlinkHeaders / getBotQrCode / pollBotQrStatus / notifyStart / getUpdates(botToken, buf, options) / sendTextMessage(botToken, {contextToken, toUserId, text}, options)`

配套：`lib/constants.js` 增 `'clawbot'` 到 `NOTIFY_CHANNELS` + `CLAWBOT_IDLE_POLL_MS=1000`；`lib/settings-store.js` 增 `notify.clawbot={botToken,userId(≤128),contextToken(≤1024)}` 且 channel==='clawbot' 时 key↔botToken 双向同步、**保存时 patch 未提 clawbot 则保留已获上下文**；`lib/bridge.js` 增 `syncClawbotWatcher/startClawbotWatcher/stopClawbotWatcher/abortableSleep` + 端点 `/desktop/notify/clawbot/{qr,status,reset}`；`lib/pages.js` 增扫码 UI；`test/clawbot.test.js` 11 条。全量 994 = 992 pass / 0 fail / 2 skipped。

落地踩的两个真 bug（都已在 0.4.7 修掉）：
- `startClawbotWatcher` 轮询空批不 sleep，遇立刻返回的桩端点会空转打满事件循环、测试挂死 ⇒ 加 `CLAWBOT_IDLE_POLL_MS` 地板。
- `sendTextMessage` 一度写成 `/ilink/bot/msg/sendmessage`（多带 `/msg/`）⇒ 改回 `/ilink/bot/sendmessage`。

### 0.4.8（`3ba7e67`，5 files / +63 −6）
现象「桌面点了测试、日志说有发、微信一条没有」⇒ 补可观测性。
- `sendTextMessage` 回传 `messageId`，**从响应原文正则取** `/"message_id"\s*:\s*(?:"([^"]*)"|(-?\d+))/`，**不走 `JSON.parse`**——`message_id` 是 64 位整数（如 `7514407535056518664`），超 `Number.MAX_SAFE_INTEGER` 会舍成 `…519000`，那样的号没法跟微信里那条对账。
- `lib/notify.js` clawbot 成功路径补 info：`notify sent: clawbot ok message_id=<号>`。
- 测试夹具必须用原始 JSON 文本字面量 `'{"ret":0,"message_id":7514407535056518664}'`；写 `JSON.stringify({message_id: 7514407535056518664})` 会在 JS 解析期就舍入，断言必挂。

### 0.4.9（`e575529`，4 files / +42 −2）—— **真根因**
`lib/clawbot.js` 的 `item_list[0].item_type` → **`type`**。详见 §5。
全量 978 pass / 1 fail / 2 skipped，失败档 `test/tunnel.test.js` 单独复跑 45 pass / 0 fail ⇒ 时序敏感档偶发失败（既有模式，见项目记忆 image-send-budget / file.upload 那条），与本次无关。

---

## 5. 最贵的一条经验：根因与判据（务必先读这段再动手）

### 判决性实验（probe11）

同一个 context_token 连发三条，**只改 item 字段名**，服务端对三条**一律回 200 + message_id**：

| 变体 | 请求体 | 服务端 | 微信端 |
|---|---|---|---|
| A | `item_list: [{ type: 1, ... }]` | 200 `message_id=7514489654797662984` | **收到** |
| B | `item_list: [{ item_type: 1, ... }]` | 200 `message_id=7514489656118807944` | **没收到** |
| C | `item_list: [{ type: 1, item_type: 1, ... }]` | 200 `message_id=7514489657536482824` | **收到** |

> User said (m01236): 「11a 和 11c 收到的」

**结论：线上键名是 `type`；服务端不校验该键、照样受理并分配 `message_id`，但微信端识别不到就静默丢弃。** 与参考实现一致——`ilink-hub` 的 `MessageItem` 是 `#[serde(rename="type", skip_serializing_if="Option::is_none")] pub item_type: Option<i32>`，即线上键名为 `type`。

**所以「服务端受理」根本不是送达判据。** `test/clawbot.test.js` 里那条 wire 键名断言（`item_list[0].type === 1` 且 `'item_type' in item_list[0]` 为 false）是**「能不能真送到微信」的闸门**，不是格式洁癖——键名错了服务端照样点头。

### 排障铁律（已写进 CHANGELOG 0.4.9，留给下一个查这个协议的人）

1. **用已失效的 `context_token` 做的排除实验全部无效。** `ret=-2 prepare failed` 只说明 token 过期了，**不能证明请求体字段对不对**。当时 probe5/probe6 试了 `item_type:1`／`type:1`／两者都带／都不带、带不带 `message_id` 共六个变体，全回 `prepare failed`，据此判「键名不是原因」——**这个结论是错的，token 先死了**。
   **判据**：设置档里 `context_token` 的落盘时间是否在近几分钟内。
2. **`clawbot prepare failed` 不是本地源码里的字符串**（全仓 grep、git 历史 grep、`D:\DSH\resources\app.asar` 用 findstr 全无命中），是服务端 errmsg 经 `notify send failed: clawbot ${detail}` 透出来的。
3. probe7/probe8 长轮询 `msgs` 恒 0：pocket 自己的 watcher 同时消费同一条 getupdates 流，两边在竞争 ⇒ 独立探针抓不到入站消息是预期的，不是通道坏了。
4. 用户发来的截图本机读不到（GUI 不渲染本地图片、pwsh 7 调不动 `Windows.Media.Ocr`）⇒ 直接请用户文字回答，别在 OCR 上耗时间。

### iLink 协议基线（据 `github.com/jeffkit/ilink-hub` 源码核对，未安装该依赖）

- base `https://ilinkai.weixin.qq.com`
- 端点：`GET /ilink/bot/get_bot_qrcode?bot_type=3`；`GET /ilink/bot/get_qrcode_status?qrcode=<key>`（status 是**字符串** `wait|scaned|confirmed|expired`）；`POST /ilink/bot/msg/notifystart`（**唯一带 `/msg/` 段**）；`POST /ilink/bot/getupdates`；`POST /ilink/bot/sendmessage`（**不带 `/msg/`**）
- 认证五头缺一即会话超时：`AuthorizationType: ilink_bot_token`、`Authorization: Bearer <bot_token>`、`X-WECHAT-UIN: base64(<随机 uint32 十进制>)`、`iLink-App-Id: bot`、`iLink-App-ClientVersion: 132102`（=(2<<16)|(4<<8)|6）
- `base_info = { channel_version: '2.4.6', bot_agent: 'dsh-pocket' }`
- sendmessage 成功响应体**不是空体**，是 `{"message_id": <int64>}`
- `to_user_id` **必填**，留空回 `{"ret":-2,"errmsg":"invalid arguments"}`
- **机制约束：`context_token` 只能从入站消息换取 ⇒ 绑定后用户必须先在微信给机器人发一句。** 通道有效性取决于那个 token 还活着；过期后需用户再发一句。这是 iLink 的机制，不是 bug。

### 探针脚本清单（`F:\defws\tmp\20261010-clawbot-probe\`）

| 文件 | 覆盖 |
|---|---|
| `probe.mjs` | 三端点连通性（notifystart / getupdates / sendmessage） |
| `probe2.mjs` | `to_user_id` 留空 → 验证必填 |
| `probe3/7/8.mjs` | 长轮询抓入站消息、换新 `context_token` |
| `probe4/5/6.mjs` | 字段变体实验（**受陈旧 token 污染，结论无效**，见铁律 1） |
| `probe9.mjs` | 新 token 连发 3 条 |
| `probe11.mjs` | **决定性对照实验**（type vs item_type） |

---

## 6. 四处编辑（✅ 已随 `4b0fd08` 提交，本节留档说明改了什么）

```
4b0fd08  lib/bridge.js + test/notify-judge.test.js + package.json + CHANGELOG.md  (4 files, +62 −20)
```

`lib/bridge.js` 的**四处编辑**：

**① clawbot watcher 就绪回执**（`startClawbotWatcher` 的 `isNew` 分支，原 L1259–1273）
- 文案：`【DSH Pocket】微信通知通道已就绪！后续任务完成、等待审批或连接地址变更将通过此通道推送给你。` → `微信通知通道已就绪：任务完成、等待审批或连接地址变更会推到这里。`
- **删掉 `try { … } catch { /* ignore */ }`**，改为：
```js
const ack = await sendTextMessage(
  botToken,
  { contextToken, toUserId: fromUserId || '', text: '微信通知通道已就绪：任务完成、等待审批或连接地址变更会推到这里。' },
  { fetchImpl, baseUrl, signal: abort.signal }
).catch((error) => ({ ok: false, error: error instanceof Error ? error.name : 'Error' }))
if (ack.ok) {
  this.log('info', 'clawbot ready notice sent')
} else {
  this.log('warn', `clawbot ready notice failed ${ack.error}`)
}
```
- 决策理由：只记 ok / 失败**类名**，不引述 `errmsg`（沿用 D6 保密纪律——失败理由不进日志，回显体不保证不含敏感串）。这条消息发不出去 ＝ 通道已废（token 过期／频控／参数被拒），此前被静默吞掉，日志里看不出通道已死。

**② 完成推送**（`pollNotifyRunning` 的 `fire` 分支，原 L1374–1385）
```js
const sessionLabel =
  (typeof item.title === 'string' && item.title.trim().length > 0
    ? item.title.trim()
    : '会话').slice(0, NOTIFY_TITLE_MAX)
void notifySend(config, sessionLabel, '已完成', { … })
```
原为 `notifySend(config, title, '任务已完成')`、title 是会话名或兜底 `'DSH 会话'` ⇒ 兜底位不再自称「DSH 会话」，也不编像真名的占位。

**③ 提问推送**（`pushPendingQuestionNotice` 尾部，原 L1429–1433）
```js
await notifySend(config, ident, '有问题需要你回答', { … })
```
原为 `notifySend(config, 'AI 在等你审批', \`「${ident}」有问题正在等你审批\`)` ⇒ 标题＝会话名（`ident` 已是 `label || pending.sessionId` 截断），正文＝原因。

**④ 桌面测试推送**（`POST /desktop/notify/test`，原 L3268–3279）
`'DSH Pocket 通知测试'` / `'这是一条测试通知'` ⇒ `'通知测试'` / `'这是一条测试通知，能收到就说明通道是通的'`

`node --check lib/bridge.js` 通过。`Select-String -Path lib/bridge.js -Pattern 'DSH Pocket|DSH 会话|AI 在等你审批|正在等你审批'` 只剩两处**注释**命中（原 L1383、L3275，是本轮新写的「推送形状」说明注释），无残留推送文案。

---

## 7. 收尾三步（✅ 全部做完，2026-10-10 10:5x）＋ 重启后的验收清单

> 下面是当时的三步计划，逐条按原样做完了，各条末尾记了实测结果。**现在唯一剩的事是本节最后的验收清单**（要重启后才能做）。

### 步骤 1：修那条因文案变更而失效的测试 ✅

全量跑出来：`ℹ tests 979 / pass 977 / fail 1 / skipped 2 / duration_ms 56212.4998`，唯一失败：

```
test at test\notify-judge.test.js:297:1
✖ bridge question push: one notice per question, identified by session title, silent when unconfigured (62.9573ms)
  AssertionError [ERR_ASSERTION]: the notice names the wait
      at TestContext.<anonymous> (file:///F:/defws/dsh-pocket/test/notify-judge.test.js:314:12)
  actual: false, expected: true, operator: '=='
```

原因：`test/notify-judge.test.js:314` 断言的是旧文案 `sent[0].includes(encodeURIComponent('AI 在等你审批'))`，而本轮把标题改成了会话名、正文改成「有问题需要你回答」。

**改法**：`test/notify-judge.test.js:314` 那条断言改为查新文案（`encodeURIComponent('有问题需要你回答')`）。L315 的 `部署周报` 断言（会话名进标题）**仍然成立**，不用动。用例本体在 `F:\defws\dsh-pocket\test\notify-judge.test.js:297-334`。

**✅ 已做（2026-10-10 10:5x）**：L314 断言换新文案，L315 未动。另查过全仓，除本条外没有第二处测试钉旧文案（完成推送那条只查会话名 `编队`，桌面「测试」端点那条只查 `delivered`）。

### 步骤 2：提版本 + 写 CHANGELOG ✅

- `F:\defws\dsh-pocket\package.json`：`"version": "0.4.9"` → `"0.4.10"`（**用 edit 工具改单点值**，别用 `Set-Content` 整文件写回，会把多行 JSON 压成单行）
- `F:\defws\dsh-pocket\CHANGELOG.md`：加 `## 0.4.10 — 2026-10-10` 节，内容要写：
  - 推送文案形状变更（不喊 DSH Pocket／标题带会话名／正文是原因）
  - clawbot watcher 不再静默吞发送失败（就绪回执发不出去会落 warn）
  - **必须过的那道闸**：`test/repo-hygiene.test.js` 的「⑨ CHANGELOG 最新一节 == package.json version」会红，版本号与章节标题要同步改

**✅ 已做（2026-10-10 10:5x）**：`package.json` 用 edit 工具单点改成 `0.4.10`；`CHANGELOG.md` 加 `## 0.4.10 — 2026-10-10` 节（含「标题＝对象、正文＝原因」四场景表 ＋ 就绪回执不再静默吞失败 ＋ 明写本轮未做报错/停止原因）。闸 ⑨ 随全量一起过。

### 步骤 3：提交 + 让用户重启验收 ✅

```powershell
cd F:\defws\dsh-pocket
git add lib/bridge.js test/notify-judge.test.js package.json CHANGELOG.md
git grep --cached -E 'sk-[A-Za-z0-9]{32,}'      # 期望 0 命中
# message 写到 F:\defws\tmp\20261010-clawbot-probe\commit-0410.txt，再：
git commit -F F:\defws\tmp\20261010-clawbot-probe\commit-0410.txt
```

**✅ 已做（2026-10-10 10:5x）**：逐文件 `git add` 那四件 → key 复扫 **0 命中** → 提交 `4b0fd08`（4 files / +62 −20）。
全量 `node --test --test-concurrency=1 test/*.test.js` = **995 tests / 993 pass / 0 fail / 2 skipped / 53.4s**。
工作树只剩本文件未跟踪。

**⏳ 待用户做**：重启 DSH（下面这条命令，对话会随宿主一起断），重启后照本节末尾清单验收。

提交后告知用户：
```powershell
powershell -File F:\defws\scripts\dsh-restart-now.ps1
```
（对话会随宿主一起断，重启后说一声「继续」。）

**重启后的验收清单**（这是 ClawBot 通道第一次真机端到端验收，之前从没通过）：

> **顺序纠正（10:4x 看日志实证后改的，原来的顺序会把人引到「测试按钮坏了」的误判上）**：
> `context_token` 现在**是过期的**。`pocket.log`（UTC，+8 后为当地）里 09:52–10:22 每一次推送都回
> `notify send failed: clawbot prepare failed`，最后一次成功是 09:34（`message_id=7514498537624668040`）。
> 那次成功出自**装载 0.4.9 之前的代码**（0.4.9 提交于 09:51:41，宿主 10:30:45 才重启）⇒
> 按 0.4.9 的根因推断，那条在服务端受理、微信端被静默丢弃，手机上大概率没有（用户可径直确认）。
> 另：09:34:23 一秒内十几条 `prepare failed` 挤在一起，说明**推送本身一直在生成**（完成判据在跑），
> 卡住的只有投递。
> 令牌**只能从入站消息换出**，所以第 1 步必须是「在微信里先发一句」，不是先点「测试」。
> 代码路径已核（`lib/bridge.js:1235–1281`，提交 `4b0fd08` 后的行号）：watcher 抓到 `context_token` 与存档不同 ⇒
> 落盘 + `clawbot context_token updated and persisted` + 自动回一条「通道已就绪」回执；
> **不需要重新扫码**。

1. **微信里给机器人随便发一句** → 应收到 `微信通知通道已就绪：任务完成、等待审批或连接地址变更会推到这里。`
   （这句文案本身就是 0.4.10 的判据：旧文案以「【DSH Pocket】」开头）；日志应见
   `clawbot context_token updated and persisted` 紧跟 `clawbot ready notice sent`。
2. 桌面配对页 → 设备视图 → 通知 → 通道下拉确认是「微信 ClawBot」（应已是，设置档里 `channel=clawbot`、`enabled=true`）。
3. 点「测试」→ 微信里应收到：标题 `通知测试`，正文 `这是一条测试通知，能收到就说明通道是通的`
4. 真实场景：让一个 DSH 会话跑完 → 微信里应收到：标题 = 会话名，正文 `已完成`
5. 真实场景：让一个会话抛出提问 → 微信里应收到：标题 = 会话名，正文 `有问题需要你回答`
6. 看 `C:\Users\toast\.dsh\pocket\logs\pocket.log`（**UTC，+8**）：应见 `notify sent: clawbot ok message_id=<号>`；
   若再见 `clawbot ready notice failed ...` 或 `notify send failed: clawbot prepare failed`，就是令牌又过期了 ⇒ 回第 1 步。
   **推论**：令牌活得短（09:34 成功、09:52 起全失败 ⇒ 窗口可能只有十几分钟或一次性），
   「什么时候必须让用户再发一句」这条还没量化，属 §8 第 3 项后续优化要回答的。

---

## 8. 待办清单（跨会话）

| # | 事项 | 状态 |
|---|---|---|
| 1 | 0.4.10 收尾三步（§7） | **✅ 全部做完**（`4b0fd08`，995/993 pass/0 fail/2 skipped） |
| 2 | ClawBot 通道真机端到端验收 | ⏳ **唯一剩下的事**——0.4.9 起消息才真能送达，而它要重启 DSH 才装载；清单在 §7 末尾 |
| 3 | 异常/停止类推送原因（「什么报错停止」） | **用户明说留待后续慢慢优化**（m01400 第三条部分），本轮不做 |
| 4 | `F:\defws\AGENTS.md` 现役快照更新 | **✅ 已做（2026-10-10 10:5x）**：0.4.7→0.4.10 四笔合并成一条现役快照，协议细节改指 `CHANGELOG.md` 0.4.7–0.4.9 节与本文件 §5；顺手删掉该条里已被 0.4.8 更正的旧事实「sendmessage 成功判据是空体 200」 |

**Open objectives**：
- ClawBot 通道真机端到端验收（须先重启 DSH；0.4.9 的 `type` 键名修复＋0.4.10 均未装载）
- 异常/停止类推送原因的后续优化（m01400 第三条，用户主动延后）