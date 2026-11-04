# 调查报告：提问卡冻结档位 ↔ 桌面 `waitState` 对应表；第三处「提问区自己往下跳」机制未定

**调研时间**：2026-11-04（本轮 review-loop 复核时点；行号与字节为当日实读）
**调研人**：flow change `2026-11-03-bugfix-pocket-question-pause-and-room-shapes` 的 review-loop 修复工人（非作者）
**数据来源**（三类，全部为实测，非推断）：

1. **仓内实读**：`F:/defws/dsh-pocket-glide/lib/pages.js`（工作树，2026-11-04 01:20 前后；605 170 B、LF 4 547、CR 0）。本文件所引「本轮复核值」行号均按该时点工作树给出；propose 时点（design/planning-context 落盘时）的行号另列，两者差值来自本卡 apply 期的净 +23 行插入。
2. **asar 内实测**（桌面侧，只读打开）：`D:/DSH/resources/app.asar`。容器结构：文件头 16 字节，其后 offset 12 处的 uint32LE = header size = **4 760 396**；**文件数据起始 = 16 + headerSize + entry.offset**。本文件所引桌面 `client.js` 行号取自 entry `/dsh/node_modules/@deepseek-ai/dsh-client-ui-user-questions/lib/client.js`（offset **44 152 501**、size **89 548**、共 **1 943** 行）；宿主侧取自 entry `.../dsh-user-questions/lib/types/timed-wait.js`（offset **99 220 327**、size **3 256**）；同族 entry 还有 `.../dsh-user-questions/lib/index.js`（offset 99 086 920、size 28 131）、`.../lib/typert.host.js`（offset 99 115 051、size 62 682）、`.../lib/types/projection.js`（offset 99 207 465、size 12 862）。
3. **探针读数**：`F:/AgentData/dsh/data/pocket/logs/pocket.log` + `.1` + `.2` + `.3`（各约 512 KB 轮转；落点由 `lib/file-log.js:103 defaultLogDir()` = `$DSH_HOME/pocket/logs` 与 `lib/constants.js:16 defaultDSHHome()` 决定）。

**本文件要回答的两个问题**（也是本 change 的 AC3.5 / T5⑥ 要求落进 `docs/` 的两件）：

1. 手机侧提问卡的冻结档位（`countdown.held` 四个取值）与桌面侧提问卡的 `waitState` 五值枚举怎么对应，三面私有旗子与宿主暂停条件各在何处。
2. 第三处「提问区自己往下跳/往下拉」的机制**为什么仍未判定**，判据差什么，以及需要什么样的读数才能定案。

---

## 一、提问卡冻结档位 ↔ 桌面 `waitState` 对应表

### 1.1 桌面侧现状（取证只读，未改）

`client.js:225` 定义 `waitState` 五值枚举（本行由 asar 内实读）：`continued` / `waiting` / `editing` / `focused` / `counting`。枚举值不是独立状态位，而是**由三面私有旗子映射出来的**：

| 桌面旗子 | 置位入口（asar 内行号） | 语义 |
|---|---|---|
| `#held` | `takeTime()` `client.js:328-335` | 「慢慢回答」：计时停摆 |
| `#focused` | `holdFocus(now)` `client.js:340-346`；`releaseFocus` 用 `now + #remainingMs` 重建 deadline `client.js:351-357` | 「读者看/点在答案面上」：冻结、离开即恢复 |
| `#engaged` | `engage(now)` `client.js:362-369`（把 `#deadline` 置 `void 0`） | 「已开始作答」：此后不再前台倒计时、不恢复 |

映射结果：三旗皆假 ⇒ `counting`；`#focused` ⇒ `focused`；`#engaged` ⇒ `editing`；`#held` ⇒ `waiting`；另有不依赖旗子的 `continued`（到点/继续）。

配套行为（同为 asar 内实读）：`timeout()` `client.js:372` 对 `#focused`/`#engaged`/`#held` 三种情形一律 `return`（不判到点、不发超时）；输入与指针绑定在 `client.js:853-858`（`focusAnswerSurface`/`blurAnswerSurface`）与 `:902-906`（`updateDraft` 首行 `engage()`）；窗口与可见性复原在 `client.js:859-883`（`window` 的 `blur`/`focus` + `document` 的 `visibilitychange`，`refocus` 的判据是「`editing` 就 re-engage，否则指针仍在答案面内才 `holdFocus`」）；带计时的卡不自动聚焦（`client.js:1158`）；UI 词 `wait.held` 的门禁在 `client.js:1041-1043`、词条在 `:1569`/`:1572`/`:1603`/`:1606`。

### 1.2 宿主侧暂停条件（提问计时到底由谁停）

宿主侧 `dsh-user-questions/lib/types/timed-wait.js`（entry offset 99 220 327、size 3 256，全文读完）的暂停条件是 **`claims.size > 0`**：`schedule()` 只在**没有任何 claim** 时才挂 `setTimeout`。⇒ 桌面这三面旗子最终都通过「有没有 claim」这一条落到宿主的计时上；页侧旗子只决定「页面上显示什么、要不要发超时」。

### 1.3 手机侧对应物与本卡定稿的 `held` 四值

手机侧的对应物是 `lib/pages.js` 的 `holdQuestionFocus`/`releaseQuestionFocus`/`takeQuestionTime`（本轮复核行号 `:2365`/`:2368`/`:2372`），`countdown.held` 字段取值域 `'' | 'focus' | 'engage' | 'held'`。对应关系如下（此表为**本卡的定稿语义**，也是 T1 实现所依据的那一张）：

| 手机 `countdown.held` | 语义 | 桌面等价物 | 桌面旗子/枚举 |
|---|---|---|---|
| `''` | 未冻结，前台倒计时 | `counting` | 三旗皆假 |
| `'focus'` | 读者看/点在答案面上 ⇒ 冻结，离开即恢复（余量折进 `remainingMs`、`deadline` 置空） | `focused` | `#focused`（`client.js:340-346` / `:351-357`） |
| `'engage'` | 读者已开始作答 ⇒ 此后不再前台倒计时、不恢复（`deadline` 置空） | `editing` | `#engaged`（`client.js:362-369`） |
| `'held'` | 「慢慢回答」⇒ 永久停摆（与 `paused=true` 同真，不得只留一个） | `waiting` | `#held`（`client.js:328-335`） |

`continued`（到点/继续）**不是** `held` 的取值：手机侧由既有的 `countdown.continued` 位承载、文案沿用既有 `L.questionContinued`（不新增「已超时」语义）。`countdownText(cd)` 的分档顺序为 `continued` → `paused`（即 `'held'` 档）→ `held === 'engage'` → 倒计时。

### 1.4 与桌面**不同**的两处（如实登记，勿按同名当同物）

1. **`editing` 档在手机侧没有独立旗子**：桌面 `#engaged` 由 `updateDraft` 首行 `engage()` 置位（`client.js:902-906`）；手机侧把「开始作答」的入口挂在 `questionComposer` 的 `oninput` 首行（`held='engage'`），指针入口挂在元素自身的 `onpointerdown`/`onpointerleave`（**未**新增 `document` 级监听；`pointerleave` 不冒泡，故接在元素上），未使用 `touchstart`。
2. **可见性复原的语义比桌面松**：桌面 `refocus`（`client.js:859-883`）在 `editing` 之外还要求「指针仍在答案面内」才 `holdFocus`；手机侧 `visibilitychange` 可见时**直接走 `releaseQuestionFocus`**，由该函数自身的判据拒绝两个永久档（`held==='engage' || held==='held'`），**省掉了「指针是否仍在作答面内」这一内判**（约 180 B 出货字节，8 000 B 硬余量地板吃不下）。⇒ 行为差异：**手机侧「可见」后不区分指针位置，非永久档一律恢复前台倒计时**；桌面侧指针已不在答案面内时不恢复。这一差异是本卡的有据裁剪（见 `tasks.md:31` 的 T1 apply 注），在此登记以免下一位读者按「与桌面同构」误判。
   附带：`releaseQuestionFocus()` 相对设计稿**额外**加了两道拒绝（`held==='engage' || held==='held'`），否则 engage 档会在 `pointerleave`/`focusout` 被拉回前台倒计时（`tasks.md:27`）。

---

## 二、第三处「提问区自己往下跳/往下拉」：机制**未定**，判据已就位、真机读数未取

### 2.1 已判定的部分（可核）

- 库内 `scrollTop` 写点**共 10 处，全部在 `lib/pages.js`**；`lib/bridge.js` 与 `client/client.js` **零命中**（`grep -n "scrollTop *=\|scrollTo(\|scrollIntoView" lib/pages.js lib/bridge.js client/client.js`）。
- **无任何定时器路径写滚动**（`startTurnStatusTimer lib/pages.js:2264`、`questionTimer lib/pages.js:2350`、`subagentTicker` 只写文本）⇒ 重复位移只能来自「重画 + 补偿写/贴底写交替」这一族机制，不是某个定时器在周期性拽。
- 10 处写点按**有没有守卫**分三个阵营（下表「本轮复核值」= 2026-11-04 工作树实读，「propose 时点值」= design/planning-context 落盘时的读数；两列的差 = 本卡 apply 期净 +23 行的插入位移）：

| 阵营 | 写点（本轮复核值） | 写点（propose 时点值） | 逐字算式 | 守卫 |
|---|---|---|---|---|
| A 补偿写（**无守卫**） | `:2286 paintEarlierFeed` | `:2282` | `box.scrollTop=prevTop+Math.max(0,box.scrollHeight-prevHeight)` | 无 |
| A 补偿写（**无守卫**） | `:2315 fetchOlderPage` | `:2311` | `box.scrollTop=prevTop+(box.scrollHeight-prevHeight)`（**裸差值**） | 无 |
| A 补偿写（**无守卫**） | `:2324 loadOlder` finally | `:2320` | 同上（裸差值） | 无 |
| B 贴底写 | `:2293 paintMessages`（标记 `bt`/`bf`，两个写点） | `:2289` | `box.scrollTop=box.scrollHeight` | `followStream` / `isNearBottom(box)` |
| B 贴底写 | `:2330 patchLastStreamMessage`（`bp`） | `:2326` | `box.scrollTop=box.scrollHeight` | 同上 |
| B 贴底写 | `:3453 settleTailStick`（`ts`，写 `live` 而非 `box`） | `:3445` | `live.scrollTop=live.scrollHeight` | 同上 |
| C 锚点复原/微调 | `:3426 restoreTranscriptAnchor`（`rs`） | `:3418` | `box.scrollTop=Math.max(0,Math.round(box.scrollTop+delta))` | 各自有（`rs` 另有 R1「读者已离开跟随带就不再拽回」） |
| C 锚点复原/微调 | `:3435 settleOlderShift`（`ol`） | `:3427` | 同上 | 各自有（首行 `if(followStream)return`） |
| C 锚点复原/微调 | `:3468 settlePromptJump`（`pj`） | `:3460` | `node.scrollTop=Math.max(0,Math.round(node.scrollTop+delta))` | 各自有 |
| C 读者按键 | `:3470`（`$('scrollAnchors').onclick` 内） | `:3462` | `box.scrollTop=box.scrollHeight` 与 `box.scrollTop=Math.max(0,Math.round(anchorTopOf(box,anchor)-JUMP_PROMPT_PAD_PX))` | 读者按键 |

  **算式口径纠正（重要）**：三处补偿写**不是**同一个式子——**只有 `paintEarlierFeed` 带 `Math.max(0,…)`**，`fetchOlderPage` 与 `loadOlder` finally 是裸差值 `prevTop+(box.scrollHeight-prevHeight)`。（design 与 tasks 曾把三处写成同一个带 `Math.max` 的式子；`design.md` 的阵营表已按实读改正，本卡**未改任何算式**：`git diff --numstat HEAD -- lib/pages.js` 的 13 个 hunk 里，含 `scrollTop` 的 `+`/`-` 行只有 `probeMark` 那一条 ⇒ 算式 diff 0 行。）
  `programmaticScroll()`（定义在本轮复核 `:3366`）的调用点覆盖 A/B/C 中的 `:2286`、`:2293`、`:2315`、`:2324`、`:2330`、`:3435`、`:3453`、`:3468`、`:3470`。

### 2.2 为什么用现有数据判不出机制

**探针缺的那一件**：冒泡 `scroll` 事件的 `event.isTrusted`。写的理由在 `lib/pages.js` 的注释里（propose 时点记作 `:3343-3349`；**本轮复核为 `:3351`–`:3354` 四行**，其后 `:3355`–`:3357` 是续行），逐字：

> The scroll listener re-arms followStream from the raw geometry. Only the reader's own scroll may do that: a programmatic write (every paint, every anchor restore, every settle loop) fires a real scroll event with the same trusted flag off, and a re-layout clamping scrollTop fires a trusted one the reader never asked for.

即：**同一个 `scroll` 事件里，「程序写的滚动」与「重排夹出来的滚动」用同一个可信位区分不了**——前者 `isTrusted=false`，后者是浏览器自己发的 `isTrusted=true`（读者没要求过）。而「读者真的在滚」也是 `isTrusted=true`。⇒ 不把 `isTrusted` 记下来，两条路径在数据上完全重合。

**propose 时点的探针状态**：`probeMark(tag)`（propose 记作 `lib/pages.js:3252`；本轮复核 `:3260`）当时只压 7 段：`tag@perf|scrollTop|scrollHeight|clientHeight|innerHeight|vvHeight|vvOffsetTop`，**不记冒泡 scroll 的 `isTrusted`**。

**本卡 T3 已把缺口补齐**（本轮复核实读的现行行格式，逐字）：

```
probeBuf.push(tag+'@'+perf+'|'+top+'|'+Math.round(b.scrollHeight)+'|'+b.clientHeight+'|'+
  Math.round(innerHeight)+'|'+Math.round(vv?vv.height:0)+'|'+Math.round(vv?vv.offsetTop:0)+'|'+
  (b.__readerScroll===undefined?'-':b.__readerScroll?1:0)+'|'+
  (Date.now()<followReArmAllowedAt?1:0))
```

第 8 段 = `b.__readerScroll`（在**现有的那一个**元素级 `scroll` 监听里赋值 `box.__readerScroll = e.isTrusted`，见本轮复核 `:3460`；未新增 `document` 级监听，以避开锚点唯一性表），取值 `1`=读者自己的滚动 / `0`=程序写的或重排夹出来的 / `-`=该行采集时还没收到过 `scroll`；第 9 段 = 采集时是否仍在 250 ms 静默窗内（`1`=`Date.now() < followReArmAllowedAt`）。⇒ **判据在位，但真机读数未取**（本卡不做真机走查）。

**现有数据的可复现判读**（planning-context §三记录的实跑，2026-11-03 23:47；范围 `.log` + `.1` + `.2` + `.3`，正则 `jk@(\d+)\|(-?\d+)` 与 `pt@(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)`，只取含 `kbprobe` 的行）：

- `kbprobe` 行共 **2 222** 条；一行内出现 ≥2 个 `|Δ|≥500` 的 `jk` 命中 **19** 行（其中重画型 9 行 = 同行 `pt` 有 `post-prev>=5`；塌缩型 4 行 = `prev-post>=5`；两者皆无 6 行）。
- 形态两类：**(a) 切会话/冷开**（`scrollHeight` 从数千塌到一个视口 735，例 `2026-11-03T05:11:42` `jk -16192,+11196`）；**(b) 补页或首屏贴底**（`scrollHeight` 一帧内长数千且 `bf@` 紧跟，例 `2026-11-03T01:14:17.442Z` 逐字 `pt@1465644|4|0|4|17 jk@1465644|1342 bf@1465644|1342|2077|735|735|735|0`，即**页面在插图过程中自己把 view 下移 1 342 px 到内容底**：`scrollHeight 2077 − clientHeight 735 = 1342`）。
- 形态 (a) 里含有「读者本来就在底部、跟随只是尽职」的合理成分；形态 (b) 在读者刚往上滚过（同 `flush` 前有 `sc@` 序列）时也会出现 ⇒ **两者都还要 `isTrusted` 才能定案**。

### 2.3 结论与判据（本轮如实登记的「未定」）

**结论**：第三处是「机制候选」而**不是**「已判定为页面自己滚」。`2026-11-03T01:14:17.442Z` 那条 `jk +1342/+6800` 到底是读者自己滚的还是页面自己滚的，**用本卡之前的探针数据判不出来**；本卡只交付「判据在位 + 可判部分改完（补偿写与贴底阵营同享同一条静默窗）」，「机制」的那一步留给一次真机读数。

**定案需要的读数（判据）**：一次真机走查——进 BOT 会话页、往上滚两屏、停 5 s 以上——取带新字段的 `kbprobe` 行，然后看那类行的第 8/9 段：

- 第 8 段 `1` ⇒ 读者自己滚的（`isTrusted=true`）；若同时与贴底时机重合，结论是「跟随策略在读者已在底部时尽职」，第三处按「非缺陷」收口。
- 第 8 段 `0` ⇒ 由程序写触发（`false`）⇒ 需要继续分辨是补偿写还是重排夹出；
- 第 8 段 `-` ⇒ 该行是**重排夹出来的滚动**（读者没要求过、监听也还没收到过冒泡 `scroll`）⇒ 指向「重画/重排」这一族。

**在读数落地之前**：任何「整屏重画次数 == 0」「`jk` 必为 0」这类断言都不成立（本卡的改用例已按此写死边界，见 `tasks.md` AC3.5）。**本卡不删任何贴底分支**（`design.md` 风险表「③ 改错方向」条）：行为改动保持为零，只加判据 + 补静默窗。

### 2.4 本卡不加「滚动所有权登记表」的理由（记录，非新结论）

`programmaticScroll()` 已经是「记下我刚刚写过滚动」的那一件东西（`followReArmAllowedAt = Date.now()+250` + 280 ms 自醒重判 `probeMark('ra')`）。2026-10-24 两轮修复与 `patchLastStreamMessage` 返工③的现场读数（`jk +1296 / +7165`）都指向「重画次数」为主因，而不是「谁写了 `scrollTop` 判不出来」。加一张登记表会扩大改动面、引入与 `followStream` 的双状态不一致风险，且**不补 `isTrusted` 这个缺的证据** ⇒ 本卡不加。

---

## 三、本文件与本卡的边界（如实声明）

- 本文件是**调研与判据记录**，不是修复凭证：它记录「哪些已判定、哪些未定、未定的部分靠什么读数定案」。
- 本文件所引手机侧行号 = 2026-11-04 工作树实读值；桌面侧行号 = asar 内 entry 实读值（offset/size 见文件头）。**行号会随改动漂移**，引用时请以本文件头的调研时间与「propose 时点值/本轮复核值」两列为准，不要跨时点混用。
- 未取的真机读数（本文件 §2.3）、以及第三处之外的另两项开放问题（ds-bot 是否接受 `room.id` 当 `sessionId`；iOS Safari `pointerdown` 是否总能到达 `.question-shell`）不在本文件范围内，见 `design.md` §Open Questions 与 `verification-report.md` 的未核项。
