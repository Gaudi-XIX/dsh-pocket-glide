# HANDOFF — 手机页跳跃：loadOlder 连补页导致连续整屏重画

- **落 handoff 时刻**：2026-10-24 01:40（北京时间）
- **用户原话**（2026-10-24 01:02:40）：「刚刚pocket手机页面跳屏了好几次」
- **本轮状态**：**只诊断，零改动**。`lib/pages.js` 里没有本线的任何未提交改动。

---

## 一、接管顺序（照这个次序读，不要跳）

1. 读本文档 §二（现场读数）→ §三（铁证）→ §四（成因链）。
2. 打开 `F:\defws\dsh-pocket\lib\pages.js`，**用关键串 grep 定位**（本文所有行号都按 2026-10-24 01:36 工作树实测，工作树含他线在途改动，**行号用前必重读**）。
3. 读 §五（修法 A/B）→ 用户拍板选哪个。
4. 改前先读 §六（硬约束与陷阱）——尤其是 **shell 字节预算**和 **`settleOlderShift` 的 `__settleTurn`**。
5. 读 `docs/调查报告-页面跳跃-20261019.md` §5.5（测试锚点清单，647 行那份，**必须读**，改错一个字测试就红）。

---

## 二、现场读数（时点值，用前重读）

| 项 | 读数 | 测得时刻 |
|---|---|---|
| pocket 仓 HEAD | `37882b9`＝0.4.58 | 2026-10-24 01:0x |
| 宿主进程 | pid 35636，起于 2026-10-23 22:17:23 | 同上 |
| 桥端口 | `0.0.0.0:43127`；GUI `127.0.0.1:10973` | 同上 |
| 运行壳摘要 zh | `pocket-534473b02eff`（css 53,502 + js 337,797 = 391,299 B） | 同上 |
| 运行壳摘要 en | `pocket-cc52407e06a7` | 同上 |
| 磁盘实算 | 与运行壳**同值** ⇒ 运行态＝磁盘态＝0.4.58，日志可信 | 同上 |
| 日志 | `C:\Users\toast\.dsh\pocket\logs\pocket.log`（当前文件 502 行，另有 .1/.2/.3 各约 524 KB） | 同上 |

**复核口径**：`GET http://127.0.0.1:43127/sw.js` 取实返 `V=`，与磁盘侧同式实算比对（内容寻址摘要）。**宿主未重启则运行态不变**——改动源码不重启不生效。

---

## 三、铁证：01:01:47–01:01:53 六秒内五次整屏重画

原始探针（日志时间 UTC，+8 = 北京时间；`pt@` 行的格式是 `pt@scrollTop|消息条数n|上次条数prev|本次条数post|标志位fl`）：

```
17:01:47.790 pt@77899|11|5|11|1   sc ra@78179|1736|3926|735
17:01:48.725 pt@79225|17|11|17|1  jk@79229|2375  ol@79345|3518|5708|735  ol@79466|3518|5708|735  ra@79507|3518
17:01:49.906 pt@80836|26|17|26|1  jk@80851|2138
17:01:50.868 ol@80957|5274|7464|735  ra@81116|5274
17:01:52.185 pt@82075|29|26|29|1  jk@82091|939  ol@82196|5831|8021|735  ra@82356|5831
17:01:53.423 pt@83294|29|29|29|1  jk@83309|670  ol@83415|6063|8253|735  ra@83575|6063
```

换算成人话：

| 时刻（北京） | 消息条数 | 屏幕总高 | 内容被推 | 备注 |
|---|---|---|---|---|
| 01:01:47.790 | 5 → 11 | 3926 | — | fl=1（可见、不贴底、不跟随） |
| 01:01:48.725 | 11 → 17 | 5708 | **+2375** | 紧跟 2 次 `ol`（对位写） |
| 01:01:49.906 | 17 → 26 | 7464 | **+2138** | |
| 01:01:52.185 | 26 → 29 | 8021 | +939 | |
| 01:01:53.423 | 29 → 29 | 8253 | +670 | **一条新消息都没加，纯重复重画** |

- 视口 `clientHeight` 全程 735（没有键盘收放的 450↔735 切换 ⇒ **不是 A 类键盘噪声**）。
- `jk` = 相邻两次采样间 scrollTop 净位移 ≥200 px 时补插的行，**四条全是正号**（内容把视线往上推）。
- `ol` = `settleOlderShift` 打的标记，**全文件只可能由 `fetchOlderPage` 触发**（唯一调用点在 `lib/pages.js:1764`，自身递归在 `:2777`）⇒ 这四次 `ol` 就是**四次 `fetchOlderPage`**。
- 同一时刻盒高 3926–8253 B，远大于视口 735 B，`ensureTranscriptFilled` 的入口闸（`lib/pages.js:1756` 的 `if(box.scrollHeight>box.clientHeight+8)return`）会直接返回 ⇒ **这四次不可能是 fill 链，只能是 `loadOlder`**。

**同窗口服务端旁证**（非探针行）：`17:01:28 history attempt … ms=13502 records=11 verdict=ok`（一个历史请求 13.5 秒只回 11 条），`17:02:41 history answer calls=14 records=1577`（一分钟内 14 次历史调用）。

---

## 四、成因链（代码，行号按现树实测）

1. **触发**：用户往上滑到顶。`topEdgePull`（`lib/pages.js:2757`，关键串 `function topEdgePull(box){probeMark('sc')`）判定 `box.scrollTop===0` 且过了 `topEdgeArmed`／`followReArmAllowedAt` 门 ⇒ 调一次 `loadOlder()`。**一次触顶只触发一次 `loadOlder`**，连发不在这里。

2. **连补**：`loadOlder`（`lib/pages.js:1768-1777`，关键串 `async function loadOlder(){if(olderRunBusy`）内是 while，上限 8 页、8 秒。源码注释自述设计意图：
   > `// so a single-page fetch often adds nothing visible and the tap looks ignored.`
   > `// A tap therefore keeps pulling pages until an earlier user message shows up.`
   > `// A page that added no records at all is the start of the conversation, not a page to retry`

   循环条件（均为**数据层**，不碰 DOM）：`activeSession`、`olderHasMore||!transcriptHasContent()`（`transcriptHasContent` 定义在 `lib/pages.js:1027`）、`pages<8`、`Date.now()<deadline`；两个 break 是 `fetchOlderPage()` 返回 false、`windowEvents().length===beforeRecords` / `olderUserCount()>before`（`olderUserCount` 在 `:1761`）。

3. **每页重画**：`fetchOlderPage`（`lib/pages.js:1762-1764`，关键串 `async function fetchOlderPage(){if(olderBusy`）。核心序列（`:1764` 单物理行内）：
   ```
   prevHeight=box.scrollHeight
   prevTop=box.scrollTop
   … rpc('session.history',{sessionId,beforeSeq:anchorSeq,maxMessages:30,…})
   olderEvents=mergeEntries(records.concat(olderEvents))
   skipAnchorOnce=true
   paintMessages(messages,false)          // ← 整屏 innerHTML 重建
   box.scrollTop=prevTop+(box.scrollHeight-prevHeight)
   programmaticScroll()
   transcriptAnchor=readTranscriptAnchor(box)
   settleOlderShift(box,transcriptAnchor,4)   // ← 120ms×4 对位链，打 'ol'
   ```

4. **整屏重建的实现**：`paintMessages`（`lib/pages.js:1740`），`:1747` 一行内 `box.innerHTML=earlierPartsHtml()+olderButtonHtml()+messages.map(renderMessage).join('')+status` ⇒ **全量替换，无增量 patch**。

5. **对位链的开关**：`lib/pages.js:1747` 开头 `const keepAnchor=(!stickToBottom&&skipAnchorOnce!==true&&followStream===false)?readTranscriptAnchor(box):null;skipAnchorOnce=false;`。顶拉场景 `followStream===false` 且 `fetchOlderPage` 自己置了 `skipAnchorOnce=true` ⇒ **`keepAnchor=null`，`paintMessages` 内建对位链整条关闭**，完全交给第 3 步那套。两条链互斥，且锚点语义不同：`keepAnchor` 是**重画前**读的 DOM 锚，`fetchOlderPage` 的是**重画后**读的。

**结论一句话**：一次上滑 = `loadOlder` 连补 4 页 = **4 次整屏 `innerHTML` 重建 + 4 组对位写**。观感跳的根因是「重画了几次」，不是「位置补偿算错」。**这也解释了为什么 10-19 那轮修了 R1（对位重试链）之后仍会跳——修的是事后数值修正，没动重画次数。**

### 明确排除（本轮形态对不上）

- **A 类键盘钳位**：判据是 `|Δ|∈[280,292]` 且前后 `clientHeight` 在 450↔735 切换。本轮全程 735，**零命中**。
- **骨架屏清空（R3）**：本轮无 `scrollHeight<=clientHeight` 的 F 形态。
- **切会话假塌盒**：`17:02:21 pt@111353|1|29|1|21 bt@111354|0|450|450` 是**用户切到了另一个短会话**（`n` 29→1，clientHeight 735→450），不是 bug。`pt` 的 `prev` 是全局 `paintProbe._n`，跨会话不重置 ⇒ **判读 `post<prev` 时必须先排除切会话**。

---

## 五、修法（A / B，等用户拍板；两侧利弊对称）

### 方案 A — 合并重画（推荐主选）

`fetchOlderPage(silent)` 加参数：`silent` 为真时只更新数据（`olderEvents` / `olderHasMore` / `olderExhausted`）并返回，**不** paint、**不** 写 scrollTop、**不** 起 `settleOlderShift`。`loadOlder` 循环里一律传 `silent=true`，循环结束后统一做一次：抓 `prevHeight/prevTop` → `skipAnchorOnce=true` → `paintMessages(messages,false)` → `box.scrollTop=prevTop+(新-旧)` → `programmaticScroll()` → `readTranscriptAnchor` → `settleOlderShift(box,anchor,4)`。

- **收益**：一次上滑 5 次重画 → **1 次**；`ol` 4 条 → 1 条；`jk` 4 条 → 1 条。
- **代价**：改动约 20 行，落在被测试逐字钉住的函数上；`ensureTranscriptFilled`（`:1756`）那条链**不要一起改**，它的循环体依赖 DOM 几何（`if(current.scrollHeight>current.clientHeight+8)break`），且它只在「内容不足一屏」时跑，属于用户预期内的增长。

### 方案 B — 限页数

把 `loadOlder` 的 `pages<8` 降到 `pages<2`（或 3）。

- **收益**：改 1 个数字；弱网下少打几个历史请求。
- **代价**：需要多滑几次才能补够；不能解决「看到重画」本身。

### 对照表

| | 方案 A | 方案 B | A+B |
|---|---|---|---|
| 一次上滑重画次数 | 5 → **1** | 5 → 2 | 5 → **1** |
| 一次上滑历史请求数 | 4–5（不变） | 4–5 → **≤2** | **≤2** |
| 改动量 | ~20 行 | 1 个数字 | ~20 行 + 1 个数字 |
| 主要风险 | 对位只能排一条，见 §六.2 | 用户可能要多滑 | 同左 |
| 建议 | — | — | **推荐** |

---

## 六、硬约束与陷阱（改之前逐条过）

### 1. shell 字节预算：余量极小，**先做减法再加代码**

- 预算常量：`test/mobile-assets.test.js:1104` `const ASSET_BUDGET_BYTES = 391_500`。同文件 `:1103` 有注释 `不要改大 ASSET_BUDGET_BYTES`。
- 01:0x 实算 zh 壳 391,299 B ⇒ **余量约 200 B 量级**（用前重读，工作树在动）。
- 纪律：**不得顺手抬升上限**；确需增长必须先做等量减法（清理死代码／复用键），并留书面收据。方案 A 的 net 变化必须实测（`node --test test/mobile-assets.test.js`）。
- 参考：`docs/调查报告-页面跳跃-20261019.md` 写的 358_000 是 10-19 时点值，**已过时**。

### 2. `settleOlderShift` 的 `__settleTurn` 去重

`lib/pages.js:2777` 关键串 `function settleOlderShift(box,anchor,tries,turn){if(!anchor||tries<=0)return;if(turn===undefined){turn=(box.__settleTurn||0)+1;box.__settleTurn=turn}`。每页各排一条 120ms×4 自递归链；**合并成一次画后只能排一条**，且要让先前排下的链失效（`box.__settleTurn` 递增即天然作废旧链）。否则会重复写、且是造成跳的另一半原因。

### 3. `prevHeight/prevTop` 必须挪到循环之前抓

`:1764` 里这两个是**画前**读的。循环内不画了，就只能在循环开始前抓一次、最后一次画后统一补一次补偿。**否则整段位移全丢。**

### 4. 循环条件不碰 DOM，但循环体副作用碰

`fetchOlderPage` 每页的 `paintMessages` 会重算 `readerAway=!isNearBottom(box)` 并据此关 `followStream`／贴底。这个状态是后续 `settleOlderShift`（`:2777` 里 `if(followStream)return`）与 `topEdgePull`（`:2757` 里 `if(box.scrollTop>0)`）的输入。合并重画后，`readerAway`／`followStream` 只在最后一次画时更新一次——**这本身是想要的（少打断用户），但要确认不会把 `followStream` 卡在错误状态**。

### 5. `fetchOlderPage` 返回 true 不代表可见条数增加

30 条记录可能不足一条气泡（`visibleMessages` 过滤）。所以 `:1775` 那两个数据层 break **必须保留**，不能靠「画了几次」判断。

### 6. 测试锚点（改前逐条读原文）

见 `docs/调查报告-页面跳跃-20261019.md` §5.5，重点是：

- `test/transcript-order.test.js:248` —— `box.scrollTop=prevTop+(box.scrollHeight-prevHeight)` **被逐字钉住，别顺手删**；`:165-167` send 不得强制贴底。
- `test/pick-toggle-anchor-restore.test.js:79/89/215` —— slice 签名与白名单（`new Function('$','probeMark','followStream','setTimeout', …)` **只允许四个外部标识符**）。
- `test/nav-reload.test.js:247/254/264`；`test/landing-tails.test.js:371/421`；`test/pages-scroll-anchors.test.js:52-73/268/274/277-278/286/511/521/533/535/540/541/547/548/549/554/555/565`；`test/goal-queue-dock.test.js:430`；`test/mobile-assets.test.js:993`（注：993 是文档性注释，**真预算常量在 `:1104`**）。

### 7. 行号可信度提醒

本轮派出的只读子代理曾报 `settleOlderShift` 在 `:2775`，**我实读为 `:2777`（与 HEAD 同）**。以**自己 grep 实测**为准，不要采信二手行号。

---

## 七、别顺手改什么（本线明确不动）

- 不改 `ensureTranscriptFilled`（`:1756`）的循环体——它是首屏填充链，不是本次成因，且依赖 DOM 几何。
- 不动 `paintMessages` 的整屏重建策略（`:1747`）——改成增量 patch 是大工程，另立项。
- 不补 `probeMark` 到无 tag 的写入点（10-19 报告 §5.6 已否，要动预算与 CHANGELOG）。
- 不动 `isNearBottom` 的扣坞预留（同 §5.6）。
- 改 `lib/pages.js` version / `CHANGELOG.md` 前先看 §九——**别线未提交时不单方提号**。

---

## 八、验收判据（真机满窗，重启后）

**改完必须重启宿主才生效**（硬约束：重启属红线，须用户在场或授权）。重启后手机须**完全关闭重开**拿新壳，先按 §二口径核对 `V=` 摘要已变。

判据（缺一不算过）：

1. **同窗口形态归零**：往上滑到顶补历史时，`pt@` 不再出现「6 秒内 ≥3 次 `pt` 且 `jk` ≥2 条正号大幅值（≥500 px）」的组合。
2. **`ol` 次数**：一次上滑补 Page 时 `ol` 从 4 条降到 ≤1 条（合并重画后只排一条链）。
3. **视觉**：往上翻历史时不再看到多次闪动；位置保持稳定。
4. **功能不回归**：往上翻仍能补到更早的消息；`ensureTranscriptFilled` 的首屏填充仍正常（进会话不空白）。
5. **预算**：`node --test test/mobile-assets.test.js` 绿，且**没有**改大 `ASSET_BUDGET_BYTES`。
6. 回归：`node --test test/transcript-order.test.js test/pages-scroll-anchors.test.js test/landing-tails.test.js test/nav-reload.test.js test/pick-toggle-anchor-restore.test.js`。

---

## 九、未提交工作树的归属界线（截至 01:40）

工作树 `git status --porcelain` 显示 **114 个条目**，但 `git diff --stat` 只有 **1 个文件有真实改动**：

| 文件 | 真实改动 | 归属 |
|---|---|---|
| `lib/pages.js:2041` `ensureSession()` | 加 `workspaceId=draftWorkspaceId` 参数 + `gone`（是否已回主页）判定，避免在主页误设 `activeSession` | **他线**（「发送后退回主页空会话」那条，改动时间 01:30:10） |
| `lib/pages.js:2535` `send()` | 加 `draftAtSend` 快照传给 `ensureSession`；失败分支区分是否已切走，`showToast(L.queueSteerFailed)` | **他线**，同上 |

- 其余 113 个 "M" 是**行尾符（LF↔CRLF）造成的假脏**（`git` 报 `LF will be replaced by CRLF the next time Git touches it`），**不是内容改动**。
- **本线未改任何文件**（只诊断）。
- 提交纪律：**逐文件显式 `git add`**，禁 `git add -A`/`-u`；`lib/pages.js` 混着两条线的 hunk 时须做 hunk 级归属并在 commit message 里点名（先例：pocket `786ff4a`、`e92b13c`）。
- **别线未提交时不单方改 `package.json` version、不写 `CHANGELOG.md` 最新一节**——最新一节＝版本号，单方提号会把别人的活标成自己的版本。

---

## 十、退回方案（乙案）

若方案 A 改完真机反而更差（例如对位只剩一次导致位置漂移更大）：

1. `git checkout -- lib/pages.js` 只回滚本线 hunk 会连他线一起丢 ⇒ **不要整文件回滚**。
2. 正确退回：`git diff lib/pages.js > tmp/rollback-<时刻>.patch` 先留底，再 `git apply -R` 只反打本线那几个 hunk；或手工把 `fetchOlderPage` 的 `silent` 参数与 `loadOlder` 的循环后统一重画删掉，恢复「每页一画」。
3. 单独保留方案 B（`pages<2`）作为低成本备选：它不触碰对位链，风险面最小。

---

## 十一、取证命令（复现本轮分析）

日志在 `C:\Users\toast\.dsh\pocket\logs\pocket.log`，每行一条 JSON，探针在 `message` 字段里以 `kbprobe` 开头。

```bash
# 打印 17:01-17:03 窗口的探针序列（sc 折叠）
python - <<'EOF'
import json,re
for line in open(r"C:\Users\toast\.dsh\pocket\logs\pocket.log",encoding="utf-8",errors="replace"):
    line=line.strip()
    if not line: continue
    try: o=json.loads(line)
    except Exception: continue
    t=o.get("t",""); m=o.get("message","")
    if t[11:16] not in ("17:01","17:02","17:03") or not m.startswith("kbprobe"): continue
    body=m.split(" ",2)[2] if m.count(" ")>=2 else ""
    out=["sc" if tok.startswith("sc@") else tok for tok in body.split(" ")]
    print(t[11:23], re.sub(r'(?:sc ){2,}','sc* '," ".join(out)).strip()[:260])
EOF
```

**探针语义**（读源码确认，勿凭记忆）：`probeMark(tag)` 在 `lib/pages.js:2608`，格式 `tag@perf|top|scrollHeight|clientHeight|innerHeight|vv.height|vv.offsetTop`；`paintProbe(n,fl)` 在 `:2614`，格式 `pt@perf|n|prev|post|fl`，`_n` **全局跨会话记账**。fl 位：1=容器可见、2=子代理视图、4=调用方要求贴底、16=followStream 仍开。常量 `PROBE_MAX=120, PROBE_FLUSH_MS=900, PROBE_JUMP_PX=200, PROBE_JUMP_GAP_MS=250`。

**A 类键盘噪声判据**（判读前必先剔除）：`|Δ|∈[280,292]` 且前后 `clientHeight` 在 450↔735 切换（735−450=285）。

---

## 十二、所属更大议题

同日另发现（**不是本次跳屏成因**，勿混算）：`session.list` 一次读 **17 MB、30–68 秒**，`01:02:30`/`01:03:39` 各有一次 `session.list … aborted due to timeout`；一次超时会**成批**带走同刻在飞的 `session.history`／`session.tails`。这属 **S2 系列（流量/延迟）**——0.4.58 就是 S2-0（埋点第一步），S2-2 是 `{unchanged:true}` 应答。相关判据：`lib/bridge.js:6275` `noteHistoryAttempt`、`:6305` `noteHistoryAnswer`（`unchanged` 在 S2-2 落地前**恒为 0**，读成「尚未实现」）、`:6509` `list read` 分桶（`miss+stale+force` 是入口次数、`host` 是真读宿主次数，**不可相加**）。

---

## 十三、第 2 轮：甲方案（增量插入）— 2026-10-24 19:36 用户拍板

**用户原话（m00171）**：「我刚刚确实感觉已经减缓了很多，但是我有个没搞明白的：为什么每次向上刷新的时候，会有一次跳动？就不能不跳动吗？加载历史消息的时候，就加载就行了吗」

**用户拍板（m00186）**：「那就按甲来做」。

### 13.1 方案 A 已由 `d290551` 落地，但还剩一次跳

`d290551`（2026-10-24 17:41）把「每页一画」改成「循环内不画、`finally` 统一画一次」。真机读数：今天 18:00 起 `ol` 全天仅 **1** 条（对照昨晚一次上拉 4 条）⇒ 合并重画已生效，这就是用户感到的「减缓了很多」。

**剩下那一次跳的机制**（北京 19:18:40 样本）：
```
11:18:31.792 pt@14360|1|0|1|17 bf@617|1352
11:18:33.256 pt@15781|4|1|4|17 bf@1032|1767
11:18:40.157 pt@22637|6|4|6|1  ol@22759|1277|3044|735
```
`settleOlderShift` 首轮是**同步立即**执行的，它没写（偏差 ≤2 px ⇒ 画完立刻补偿是准的）；**122 ms 后**那次重试才写 `ol` ⇒ **这 122 ms 内页面高度变了**。原因是整屏 `innerHTML` 重画把图片/代码块节点**重新创建**，重新渲染后高度才定下来，位置随即漂移并被掰回。用户看到的那一次跳就是这一下。

### 13.2 甲方案：只插新节点，已有节点一个不动

`loadOlder` 的 `finally` 不再 `paintMessages` 整屏重建，改为把**新增的老消息**用 `insertAdjacentHTML('beforebegin')` 插到第一个已有 `.message` 之前：
- 已有节点不销毁 ⇒ 图片不重载、不重新布局 ⇒ **高度在插入瞬间就是终值** ⇒ 不需要事后对位（也就没有那 122 ms 后的 `ol`）
- 位置补偿仍用 `scrollTop += (scrollHeight - scrollHeightBefore)`，这次它是**准确的**，因为只有增量部分贡献高度

**判据（拿不到就退回整屏重画）**：`next.map(olderKey)` 的后缀必须与画前 `oldKeys` 逐项全等（`grown>0 && oldKeys.every((k,i)=>keys[grown+i]===k)`）。`olderKey`：
```js
function olderKey(m){return m.turn?'t'+m.turn.key+m.turn.nodes.length:'s'+m._seq+m.role}
```
`turn` 节点带上 `nodes.length`——补页可能把更早的步骤并进**同一个 turn**，那时 turn 的 `key` 不变但内容变了，只看 `key` 会漏判。

**保留的兜底**：`paintOlder` 返回 `false`（没插成功 / 画前 DOM 为空 / 后缀对不上）时，仍走原来的 `paintMessages + settleOlderShift`。所以 `test/older-pull-coalesce.test.js` 第 4 个测试钉的那条字面串**必须留在原处**。

**已知不解决**：新插入的老消息若含**图片**，图片加载完高度仍会变（无占位高度）。本轮不做图片占位——它属乙方案的活。

### 13.3 预算减法：从正文搬出的注释原文（逐字存档）

壳预算是 **UTF-8 字节**、`ASSET_BUDGET_BYTES = 391_500`（`test/mobile-assets.test.js:1104`，**不许抬**）。本轮动手前实测（2026-10-24 19:5x，`Buffer.byteLength`）：zh `css 53,818 + js 337,297 = 391,115` ⇒ **余 385 B**；en 余 478 B。（`.length` 只有 372,278——**中文按 3 字节算，别看 `.length`**。）

为给增量插入腾地方，从 `lib/pages.js` 正文搬出下面两段注释，正文只留一行短指针。**内容是逐字存的，别删这一节。**

**(1) `paintMessages` 入口的 R3 现场注释**（原在 `lib/pages.js:1741-1745`，六行）：
```
// R3（m00002/m00134 现场）：入口 br 只解锁了 followStream，stickToBottom/bf 两个贴底分支仍会
// 无条件把读者写回盒底——日志里 br 与 bt/bf 同帧相邻（09:40:59 bt 把 2824→3205、09:43:14 bf
// 把 534→1072、09:43:25 bt 把 2115→2495、09:45:26 bt 把 1623→2096）就是它的签名。读者此刻
// 人不在盒底，这一帧的意图就是「停在原处」，所以贴底分支必须让位于 keepAnchor 复原。
// 判据只看实时几何，不看 followStream 这个可能已被上一帧解锁的陈旧布尔。
```
下一行是正文 `const readerAway=typeof isNearBottom==='function'&&!isNearBottom(box);`，**这一行不能动**——它就是这段注释说的判据。

**(2) `ensureTranscriptFilled` 的分页理由注释**（原在 `lib/pages.js:1750-1755`，六行）：
```
// The transcript is paged by records, not by screenfuls: 30 records is often
// less than a single turn, and "show the last N messages" only moves the
// goalpost (3 is short, so 5, so 10…). Keep pulling older pages until the
// transcript really does fill the viewport, the conversation starts, or the
// budget runs out. It only ever runs while the content is shorter than the
// viewport, so it cannot disturb someone already reading further up.
```

## 十四、2026-10-24 21:0x 用户定调：第一性要求是「不跳」，改为「读够再画」

用户原话（m00399）：「这种情况下，我觉得就应该多读取一些，或者少读一些，读完一轮就不要跳。我的第一性要求是不要跳屏」。

**上一版留下的缺口**：增量插入只在「新增部分是纯前缀」时命中。若上拉补回的记录正好落在某个已显示回合的中间（读到半个回合）， 里带的 `turn.nodes.length` 就会对不上，于是退回整屏重画——那一次仍跳。

**改法（比加内容指纹更根本）**：让切点永远落在回合边界上，增量插入就永远命中。回合的起点必是一条用户消息，而 `loadOlder` 的循环本来就有天然出口 `if(olderUserCount()>before)break`——读到更早的一条用户消息才停。破坏这个出口的只有两个保底上限，把上限放宽到「覆盖任何单个回合」之后，切在中间就只可能出现在超长回合里：

- `lib/pages.js:1765` `deadline=Date.now()+8000` → `+12000`
- `lib/pages.js:1766` `pages<8` → `pages<20`（一页 30 条原始记录，600 条足够任何回合）
- `test/transcript-order.test.js:249/250` 两条钉住字面量的断言同步改
- 字节代价 ≈ 0（数字同长），zh 余 194 B / en 余 287 B

**代价与残余**：弱网下一次上拉最多多花约 4 秒（多读几页）；单个回合超过 600 条原始记录才会再切在中间，那时仍退回整屏重画跳一次。**不采用「少读」**：把不完整的首回合整个藏起来会让内容凭空消失/再出现，同样是跳。

**真机验收**：上拉后 `pocket.log` 里出现 `pt@…|n|prev|…` 且**没有** `ol@`；若两者同时出现，说明当次走了重画兜底（把当时的记录发我，看是不是超长回合）。
