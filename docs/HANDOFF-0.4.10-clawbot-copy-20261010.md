# HANDOFF：pocket 微信 ClawBot 直连推送（0.4.10 验收闭合，0.4.11＋0.4.12 待重启）

写于 2026-10-10 上午，收尾于同日 12:1x。本文件是**跨会话续接的唯一入口**：接手的人读完这一份就能接着干，不需要回看聊天记录。

---

## 1. 一句话现状

微信 ClawBot 通道**已端到端打通、验收闭合**（0.4.7 功能本体 / 0.4.8 可观测 / 0.4.9 送达真根因 / 0.4.10 文案换形状，
宿主 10:59:41 重启装载，用户 11:1x 目验三条全中）。额度也量化了：**一条入站换 10 条出站**，与微信官方口径逐字吻合（§5）。
**在案的两件新活都已做完、只差重启**：
- **0.4.11**（用户第 4 条「推送给个计数」）＝推送正文尾巴带「（第 N/10 条）」（`601b1f4`）。
- **0.4.12**（用户第 5 条：提问／报错到了就发，完成可以攒着寄但不能压太久）＝**邮包与班次**：
  跑完的事进邮包攒成一封寄，挂号信（提问）当场投；发车看三个条件谁先到（装满／末班车／封顶），
  额度用尽时信留在包里等下一次入站补投，包本身落盘所以重启不丢（`b1bda28` → 定稿 `7585e9e`，
  新模块 `lib/mailbag.js` ＋ `lib/mailbag-store.js`）。整套设计、定稿数字和三个问题的答案在**新增的 §9**。
**重启后两条判据**：① 下一条推送尾巴是 `（第 1/10 条）`；② 几个会话同轮收尾时手机只收到**一条**「N 个会话已完成」。
全量测试现为 **1020＝1018 pass / 0 fail / 2 skipped**。

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

## 4. 已提交的九笔（git log；只改本文件状态的文档提交未列）

```
7585e9e refactor(notify): 隐喻统一成邮政，时间尺度按用户预期拉长，邮包落盘——0.4.12 定稿
edc78ad fix(notify): 换到无额度概念的通道时解除「额度已尽」挂起，邮包不会永远停在邮局
b1bda28 feat(notify): 推送改成「一趟车一条」的额度调度——末班车＋封顶＋顺路，提问仍是 T1 (0.4.12)
601b1f4 feat(notify): 微信推送带上额度计数——正文尾巴「第 N/10 条」，入站一条即归零 (0.4.11)
0217245 docs(clawbot): 额度实测入档并改掉三处「过期」措辞——CHANGELOG/HANDOFF/bridge.js 注释
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

1. **拿「已经推不动」的状态做排除实验，全部无效。** `ret=-2 prepare failed` 只说明**此刻没有可用的 context_token（缺令牌或 10 条额度已尽）**，**不能证明请求体字段对不对**。当时 probe5/probe6 试了 `item_type:1`／`type:1`／两者都带／都不带、带不带 `message_id` 共六个变体，全回 `prepare failed`，据此判「键名不是原因」——**这个结论是错的，那时已经没有额度了**。
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

**✅ 额度已量化（2026-10-10 11:00 受控实验＝C）**：宿主 10:59:41 重启装载 0.4.10，用户在 11:00:01 于微信发一句，日志给出这条干净序列（当地时刻）：

| 时刻 | 事件 | 第几条 |
|---|---|---|
| 11:00:01 | 入站 ⇒ `clawbot context_token updated and persisted` | 充值 |
| 11:00:02 | `clawbot ready notice sent`（就绪回执） | **第 1 条** |
| 11:00:08 / 13 / 17 / 21 / 24 / 27 / 30 / 33 / 36 | `notify sent: clawbot ok message_id=…` ×9（桌面连点「测试」） | 第 2–10 条 |
| 11:00:38 | `notify send failed: clawbot prepare failed` | 第 11 条 ⇒ 拒 |
| 11:00:44 | 同上 | 第 12 条 ⇒ 拒 |

**结论：一次入站消息 ＝ 10 条出站额度，与官方转述逐字吻合；「通道已就绪」回执自己就吃掉 1 条。**

**上一条提交（`7bf3814`）里那句「本机实测比官方更紧（31 秒即失败）」作废**——那是**探针脚本与桥抢同一份额度**造成的假象：
03:26 充值后 03:32–03:33 跑过 probe1–3，08:54 充值后 08:54–08:58 跑过 probe9–11（探针目录 mtime 为证），
所以到 03:53、09:34 时那 10 条早就见底了。上午所有「比官方紧」的读数都是这个原因，不是平台更严。

**新增排障铁律 5：探针与桥共用同一份 10 条额度**（同一个 bot 账号）。做受控实验前先确认没有在跑探针——
铁律 3 讲的是「探针抓不到入站」，这条讲的是「探针把额度花掉了」；两者都会让读数变成
「别人花了多少」而不是「微信给多少」。

**影响分两栏**

- **对当前 pocket**：够用，但不无限。一次入站换 10 条推送 ⇒ 正常使用（完成任务、提问待答）撑得住；
  真正的风险是**pocket 自己把额度烧光**——09:34:23 一秒内 13 次发送就是证据（`pollNotifyRunning` 没有批处理），
  烧光之后到用户下次发话之间，所有推送静默丢失，日志只留一行 warn。
- **对架构**：10 条/入站 与 24h 一句 是平台侧规则（不是 pocket 的实现缺陷），且官方文档明写后续可能进一步调整 ⇒ 这面墙还会移动。任何拿 ClawBot 做主动推的设计都撞同一面墙。

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

> **顺序纠正（10:4x 看日志实证、10:5x 查证外部口径、11:00 受控实验后定稿；原来的顺序会把人引到「测试按钮坏了」的误判上）**：
> 额度是**一次入站换 10 条**，用完就得再发一句——所以每次要验收，第 1 步永远是「先在微信里发一句」，不是先点「测试」。
> **11:00 那次 C 实验已经把这一轮 10 条用光**（1 回执 + 9 测试，第 11 条起 `prepare failed`）⇒ 现在这条通道的额度是 0，
> 下一次验收前必须再充一次。
> **注意用词**：这不是「令牌过期了」——查完协议文档与官方限制后确认它**不是计时器**，是配额，
> 详见 §5 的「context_token 的失效规律」。
> 顺带一条历史读数：09:34 那次成功出自**装载 0.4.9 之前的代码**（0.4.9 提交于 09:51:41，宿主 10:30:45 才重启）⇒
> 按 0.4.9 的根因推断，那条在服务端受理、微信端被静默丢弃，手机上大概率没有。
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
   若再见 `notify send failed: clawbot prepare failed`，**是这 10 条额度用完了**（不是令牌到期，见 §5）⇒ 回第 1 步在微信再发一句。
   ~~这条量化待办~~ **✅ 已办结（11:00 实测）**：一句入站＝10 条出站，就绪回执占 1 条；见 §5 的受控实验表。

**✅ 11:00 实测已过，且用户目验三条全中（11:1x）**：宿主 10:59:41 重启 ⇒ 0.4.10 已装载（硬判据＝日志出现 `clawbot ready notice sent`，这条只在 0.4.10 存在）；
用户确认「10 条都收到了／就绪回执是新文案／测试那条是 `通知测试` ＋ 新正文」——
⇒ **0.4.7→0.4.10 这条线到此闭合**（`type` 键名修复的真机送达也第一次得到证明）。
验收清单里剩下的「真实会话完成／提问」两种形状尚未在现场看过，但形状与测试推送走同一处代码，风险低。

**下一步（同日本子做掉的事）**：用户提的第 4 条「推送给个计数」已实现为 **0.4.11**（`601b1f4`，待重启生效）——
推送正文尾巴带「（第 N/10 条）」，超过 10 条改说「已超 10 条，在微信回一句就续上」；
计数挂在**每条入站**上归零（含 `context_token` 字符串没变的那种），非 clawbot 通道一个字都不加。

---

## 8. 待办清单（跨会话）

| # | 事项 | 状态 |
|---|---|---|
| 1 | 0.4.10 收尾三步（§7） | **✅ 全部做完**（`4b0fd08`，995/993 pass/0 fail/2 skipped） |
| 2 | ClawBot 通道真机端到端验收 | **✅ 闭合（11:00 实测 + 11:1x 用户目验三条全中）**：10 条都收到、就绪回执是新文案、测试那条是 `通知测试` ＋ 新正文 ⇒ 0.4.9 的 `type` 键名修复真机得证。未在现场看过「真实会话完成／提问」两种形状（与测试推送同一段代码，风险低） |
| 3 | 一句入站到底能推几条（额度量化） | **✅ 已办结（11:00 受控实验）**＝**10 条**，就绪回执占 1 条；与官方口径吻合 |
| 4 | **推送侧要有额度意识**：`prepare failed` 时入队等新入站再冲刷（与就绪回执合并）＋完成/提问推送**批处理节流**（09:34 一秒 13 次是 pocket 自己的问题）＋「测试」按钮区分没额度 vs 协议不通 | **✅ 全部做完＝0.4.12（`b1bda28`），待重启生效**——见下面第 8 项 |
| 5 | 异常/停止类推送原因（「什么报错停止」） | **用户明说留待后续慢慢优化**（m01400 第三条部分）。0.4.12 已给它留好**挂号信车道**（不攒、当场投、投不出去必补），缺的只是原因判定 |
| 6 | `F:\defws\AGENTS.md` 现役快照更新 | **✅ 已做（根仓 `16df7fc` ＋ 改判 `30352cf`＋`b591d05`）**：0.4.7→0.4.10 四笔合并成一条现役快照，协议细节改指 `CHANGELOG.md` 0.4.7–0.4.9 节与本文件 §5；顺手删掉该条里已被 0.4.8 更正的旧事实「sendmessage 成功判据是空体 200」 |
| 7 | **推送带额度计数**（用户验收时提的第 4 条） | **✅ 已做＝0.4.11（`601b1f4`），待重启生效**：正文尾巴「（第 N/10 条）」，超 10 条改说「已超 10 条，在微信回一句就续上」；计数挂在**每条入站**上归零（含 `context_token` 字符串没变的那种）；非 clawbot 通道一个字都不加；全量 997＝995 pass/0 fail/2 skipped |
| 8 | **邮包与班次**（用户第 5 条：挂号信即投、平邮可攒但不能压太久） | **✅ 已做＝0.4.12，定稿 `7585e9e`，待重启生效**。设计、定稿数字、以及用户当场问的三个问题（窗口多长／包存哪儿／重启还在不在）的答案全在**下面 §9**，本行只留一句话：跑完的事攒成一封寄、提问当场投、寄不动的留在包里下次入站补，包落盘 |

**Open objectives**：
- **重启 DSH 让 0.4.11 ＋ 0.4.12 一起生效**，三条判据：① 下一条推送尾巴是 `（第 1/10 条）`；
  ② 几个会话同轮收尾时只收到**一封**「N 个会话已完成」；③ 已经在用微信的人在续期之后**不再收到「通道已就绪」**
- 班次表（8 件／10 分钟／20 分钟／2 小时）是照用户给的尺度定的**初值**，真机跑一阵按体感回校：
  嫌慢压 `rideMs`，嫌额度紧抬 `lettersMax`（改要连带 `test/mailbag.test.js` 最后那条钉数值的档与 §9 的表）
- 异常/停止类推送原因的后续优化（m01400 第三条，用户主动延后）——**挂号信车道已就位**，
  将来判出原因就是 `mailbag.post(POST_REGISTERED, …)` 一行接入

---

## 9. 邮包与班次（0.4.12 定稿；设计说明与三个问题的答案）

一套话：跑完的事是**平邮**（攒着一起寄），等你回答的事是**挂号信**（当场投），
寄不出去的信留在**邮包**里等下一班。**没有航班、没有信封、没有 T1**——之前那三个隐喻混着用，读的人要付三遍理解成本。

### 为什么非要攒

微信一条入站换 10 条出站。老写法是每个跑完的会话各寄一封，于是 09:34:23 那一秒 13 封把额度点光，
之后**真正要命的「有提问等你回答」恰好进不来**。攒的意义不是少说话，是同样一条额度多报几件事。

### 三个问题（用户当场问的，答案就是设计）

**① 时间窗口。** 你给的是「十几二十分钟」，所以：装满 8 封立刻走 ／ 最后一封进来后安静 10 分钟走 ／
最早一封压满 20 分钟强制走。只跑完一件事 ⇒ 约 10 分钟后到；连着跑一批 ⇒ 最迟 20 分钟一趟。
判班跑在 30 秒轮询上，所以实际是「阈值 ~ 阈值+30s」。

**② 「凑满 8 封」是容量，不是条件。** 这是你担心的那个坑，答案是**不会干等**：装满只是让三个条件之一先成立，
只有 3 件事时它靠「安静 10 分钟」或「压满 20 分钟」出发。装满存在的理由是信也要能读——
一封信列 8 个名字，再多折成「另有 N 个就不列了」（数量说出来，不静默吞）。

**③ 包存哪儿、重启还在不在。** 存内存不够：今天这台宿主重启了好几次，而「等下一次入站再寄」本来就必然横跨重启。
所以包落盘在数据目录 `notify-mailbag.json`（写盘纪律照设置档与会话档：同目录临时文件＋原子改名＋`0600`，
读坏了当空包，最坏等于没有这个文件）。**恢复时按原时间戳排队**——重启前已经压了 18 分钟的，重启后 2 分钟就走。
**但挂号信不落盘**，这是刻意的：那条「等你回答」现在还成不成立只有活着的桥知道（可能已被回答、或随宿主消失），
存下来重启后再补一发，是拿一件过去了的事催人。
另外加了一小时限：**压过 2 小时的平邮不再寄**（隔半天告诉你「昨晚某会话跑完了」是噪音不是消息），
并在日志里说明丢了几封。

### 顺路（这是最值钱的一条）

任何一次已经发生的发送都捎走包里的平邮：桌面按了「测试」之后、**以及你在微信回一句之后**。
入站那一次尤其值——额度刚续上，而且**你正在看手机**，是整条链路上唯一「寄出的时机＝看的时机」重合的时刻。

### 首绑才发回执（你拍的）

「通道已就绪」自己要吃一条额度（10 条里的第 1 条），而续期时它已经没有信息量——每条推送都写着「第 N/10 条」。
所以判据从「令牌变了」改成「存档里原本没有令牌」，之后每次回话，10 条整条留给真消息。

### 失败怎么分（这条差点写错）

服务端明说寄不动（`prepare failed`／`invalid arguments`／`ret -2`）才算「这轮没额度」：包留下、下次入站补，
期间**不再每 30 秒撞一次墙**。网络抖动不算——那按老行为丢掉，否则一次代理超时就把推送无故停到下次入站。
这个区分有外部先例：hermes-agent issue #80125 把 `prepare failed` 误当限频开了熔断，断联三天没看出来。
`lib/notify.js` 因此多了一个 `hooks.onQuota`。

顺带防死锁（`edc78ad`）：清掉「额度已尽」的唯一事件是 clawbot 入站。你要是改去 Server酱／Bark
（它们没额度这回事）就再也不会有入站，不解除就是包永久停在邮局。发车前先按当前通道解除。

### 落地在哪

`lib/mailbag.js`（纯函数，`now` 从参数进来，所以整套班次能用手工时钟测完）、
`lib/mailbag-store.js`（落盘）、`lib/bridge.js`（`NOTIFY_MAILBAG` 班次表、`sendMail()`、`restoreMailbag()`、
`quotaBody()` 保证「第 N/10 条」不被截断）。测试 23 条分两个文件（班次 14 ＋ 接线 9，含落盘与重启恢复）。
全量 **1020＝1018 pass / 0 fail / 2 skipped**。

### 还没做的

- 「报错／停止」这一类的原因判定（你说慢慢优化）。车道已留好：`mailbag.post(POST_REGISTERED, …)`。
- 桌面 UI 还没把 `held`／`quotaSpent` 显示成人话（接口已经回了这两个字段）。
- 班次四个数是推出来的初值，不是测出来的最优值。