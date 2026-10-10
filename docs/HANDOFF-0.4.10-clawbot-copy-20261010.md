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
   **判据**（**10:5x 更正**）：要确认「刚刚有入站消息」——看日志有没有 `clawbot context_token updated and persisted`。
   ~~设置档里 `context_token` 的落盘时间是否在近几分钟内~~ **这条判据已作废**：刷新只在令牌**字符串发生变化**时才落盘记日志，
   同一条对话线上 repeated 入站可能给出同一个字符串 ⇒ 落盘时间只是**下界**，按它判断会把「有入站但没变化」误读成「没入站」。
   另：`prepare failed` 的成因是**缺令牌或额度用尽**，不是「时间到期」（见下一节）。
2. **`clawbot prepare failed` 不是本地源码里的字符串**（全仓 grep、git 历史 grep、`D:\DSH\resources\app.asar` 用 findstr 全无命中），是服务端 errmsg 经 `notify send failed: clawbot ${detail}` 透出来的。
3. probe7/probe8 长轮询 `msgs` 恒 0：pocket 自己的 watcher 同时消费同一条 getupdates 流，两边在竞争 ⇒ 独立探针抓不到入站消息是预期的，不是通道坏了。
4. 用户发来的截图本机读不到（GUI 不渲染本地图片、pwsh 7 调不动 `Windows.Media.Ocr`）⇒ 直接请用户文字回答，别在 OCR 上耗时间。

### context_token 的失效规律（2026-10-10 10:5x 查证——**先纠正本文件上午那句「窗口可能只有十几分钟」**）

那是按「时钟」想的，错了。外部两份口径＋本机 45 行日志都指向**额度**，不是时间。

**外部口径**

- **协议文档 [wechatbot.dev/zh/protocol](https://www.wechatbot.dev/zh/protocol)**（微信 iLink Bot API＝ClawBot 背后的 HTTP/JSON 协议，base 与本机一致）：`context_token` 的定位是「每条入站消息都带、每条出站 sendmessage 必须原样回传」的**会话路由令牌**，按 userId 缓存、跨重启持久化；它给出的失效条件**只有**「会话过期 `errcode -14`」和「重新登录」，**通篇没有任何分钟级 TTL**。错误码表：`ret 0` 成功、`errcode -14` 会话过期（须重扫）、**`ret -2` 参数错误／检查请求体**。
  ⚠️ 同一页有个「有效期约 24 小时」的东西是 **`typing_ticket`**（"正在输入"票据），**不是** context_token——别看串成一条。
  另外该页记 `getupdates` 长轮询挂起约 **35 秒**、首次 `get_updates_buf` 必须是空串。
- **微信 ClawBot 官方限制（[pushplus 渠道文档](https://www.pushplus.plus/doc/channel/clawbot.html)，更新 2026-07-07）**——「10 条/24h 需回一句续期」这句话的原始出处在这里，四条：① 扫码绑定，且**一个微信号只能绑一个 ClawBot**；② **绑定后要主动发起一次对话，才能下发消息**；③ **每下发 10 次消息后，需要主动发起一次对话**；④ **每隔 24 小时，也需要有一次主动对话**。⇒ 全是**配额与节拍**，没有一条是「令牌 X 分钟过期」；且文档自己写了「非常的新，后续可能进一步调整」。
- **`prepare failed` 究竟说什么（[hermes-agent issue #80125](https://github.com/NousResearch/hermes-agent/issues/80125)，2026-08-06 提、09-18 关闭）**：别人踩了同一个坑——把 `ret=-2` + `errmsg:"prepare failed"` 无条件当限频、开 30 秒熔断，于是断联三天里日志一直在报 `rate limited; cooldown active for 30.0s`，**真因是这个账户压根没有 context_token（用户从没发过入站消息）**。结论：**`prepare failed` ＝ 缺／无效 context_token，不是限频**。
  pocket 侧现状：`lib/*.js` 里 cooldown/throttle 只出现在配对 PIN 的限次上，**通知路径没有熔断器**，失败只落一行 warn 然后**这条推送就直接丢了**。

**本机日志（45 条 clawbot 行，t 是 UTC，下表已 +8）**

| 当地时刻 | 事件 |
|---|---|
| 10-10 03:26:35 | 桌面配对成功 |
| 03:26:50 | 推送 `prepare failed` ⇒ 正是 #80125 的形状：配对后用户还没在微信发话，压根没有令牌 |
| 03:26:54 | 入站消息 ⇒ `clawbot context_token updated and persisted` |
| 03:53:05 | 推送**成功** |
| 03:53:36 | **31 秒后**再发即 `prepare failed` |
| 04:02→04:34 | 六次推送全失败 |
| 08:54:20 | 入站 ⇒ 令牌刷新 |
| 08:59:57 | 成功（**5.5 分钟**后仍可用） |
| 09:22:28 | 成功（**28 分钟**后仍可用） |
| 09:34:23 | **同一秒内 13 次发送：12 失败、1 成功**（日志 L1454–L1474） |
| 09:36→10:43 | 全失败（最后一条 10:43:21，就发生在本文件写完之前） |

⇒ 同一枚令牌既能在 31 秒后死、也能在 28 分钟后还活着，**存活与时间无关**；而 09:34 那一秒里失败与成功**交错**——「过期」不会这样交错，那是**额度被打光**的形状。08:54 之后能成两次，多半是中间用户又发过话而令牌字符串没变（代码只在 `contextToken !== 存档` 时才记 refresh，`lib/bridge.js:1241`），所以**日志里的 refresh 次数是入站次数的下界**，别拿它当分母。

**影响分两栏**

- **对当前 pocket**：只要用户在两次推送之间没在微信里说话，「已完成／有问题需要你回答」就大概率静默丢失，日志只留一行 warn。用户的体感会是「微信通道不可靠」——而他选这条通道正是为了可靠。
- **对架构**：任何拿 ClawBot 做**主动推**的设计都撞同一面墙（这是平台侧规则，不是 pocket 的实现缺陷）；官方文档明写后续可能进一步调整，所以这面墙还会移动。

**因此新增一条待办，排在原 §8 第 3 项前面**：推送侧要有**额度意识**——
① 收到 `prepare failed` 时把这条待推内容**入队**，等 watcher 抓到新入站消息后冲刷（与「通道已就绪」回执合并，别一次灌十几条——那正是 09:34 的形状）；
② 完成/提问推送要**批处理节流**（一秒 13 次发送本身就说明 `pollNotifyRunning` 没有批处理）；
③ 桌面「测试」按钮要能区分「没额度」与「协议不通」，回「先在微信里发一句激活」而不是只给 `delivered:false`。

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

> **顺序纠正（10:4x 看日志实证、10:5x 查证外部口径后改的；原来的顺序会把人引到「测试按钮坏了」的误判上）**：
> `context_token` 现在**没有可用额度**（`pocket.log` 最后一条 10:43:21 仍是 `prepare failed`）。
> **注意用词**：这不是「令牌过期了」——查完协议文档与官方限制后确认它**不是计时器**，是配额，
> 详见 §5 的「context_token 的失效规律」。
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
   若再见 `notify send failed: clawbot prepare failed`，**是额度用尽不是令牌到期**（见 §5）⇒ 回第 1 步在微信再发一句。
   **验收时顺手量化一条**（现在还没有这个数）：从「在微信发一句」到「下一次 `prepare failed`」之间到底推得动几条——
   官方口径是 **10 条**，本机日志里出现过 **31 秒即失败**，两者差很远，宽严待实测。

---

## 8. 待办清单（跨会话）

| # | 事项 | 状态 |
|---|---|---|
| 1 | 0.4.10 收尾三步（§7） | **✅ 全部做完**（`4b0fd08`，995/993 pass/0 fail/2 skipped） |
| 2 | ClawBot 通道真机端到端验收 | ⏳ **唯一剩下的事**——0.4.9 起消息才真能送达，而它要重启 DSH 才装载；清单在 §7 末尾 |
| 3 | **推送侧要有额度意识**：`prepare failed` 时入队等新入站再冲刷（与就绪回执合并）＋完成/提问推送批处理节流＋「测试」按钮区分没额度 vs 协议不通 | **新增（10:5x）**，判据与三条改法在 §5「context_token 的失效规律」；这是通道能不能用的问题，排在下一项前面 |
| 4 | 异常/停止类推送原因（「什么报错停止」） | **用户明说留待后续慢慢优化**（m01400 第三条部分），本轮不做 |
| 4 | `F:\defws\AGENTS.md` 现役快照更新 | **✅ 已做（2026-10-10 10:5x）**：0.4.7→0.4.10 四笔合并成一条现役快照，协议细节改指 `CHANGELOG.md` 0.4.7–0.4.9 节与本文件 §5；顺手删掉该条里已被 0.4.8 更正的旧事实「sendmessage 成功判据是空体 200」 |

**Open objectives**：
- ClawBot 通道真机端到端验收（须先重启 DSH；0.4.9 的 `type` 键名修复＋0.4.10 均未装载）
- 异常/停止类推送原因的后续优化（m01400 第三条，用户主动延后）