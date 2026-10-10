# HANDOFF — pocket 0.4.17 导航五条（施工账，2026-10-11 周日 00:2x）

批次内容：**手机页导航不再重新加载**。起因是用户口述的一个说不清的不适感：

> 「对于一个已经打开的 Pocket 手机页面，为什么返回会话列表，好像又要重新加载一次会话列表；然后进入到新会话里面，又要重新加载一次会话？……我总感觉这里面好像不太对，我不知道怎么说」

诊断结论（写在这里供后来者不必重走）：**视图切换本来就是 SPA 的（`pushState`，文档不重载），不对的是数据模型——每次导航都重新向桌面端证明一遍数据是新的**。三条成因 + 顺带挖出的两条，构成本批五条改动。

---

## 0. 现场状态：工作树是**混合的**，别一把梭

`F:\defws\dsh-pocket`，HEAD = `505d254`（0.4.17 通知规则，他线 22:46:51 已提交）。工作树里同时躺着**两拨未提交改动**：

| 归属 | 文件 | 备注 |
|---|---|---|
| **本档（导航五条）** | `lib/pages.js`（**仅 ≤1754 行区**，见 §0.2）、`lib/bridge.js`、`lib/icon.js`、`lib/session-stream.js`、`test/nav-reload.test.js`（新建）、`test/boot-landing.test.js`、`test/reconnect-icon.test.js`、`test/session-events.test.js`、`test/pages-tunnel-poll.test.js`、`test/pages-scroll-anchors.test.js`、`test/subagent-session-dom-assertions.test.js`、`test/mobile-assets.test.js`、`test/helpers.js` | 全量测试由本档跑到绿 |
| **他线（8 问取证与修法）** | `CHANGELOG.md`、`README.md`、`client/client.js`、`lib/constants.js`、`test/audit-anchor-hardening.test.js`、`test/client-i18n.test.js`、`test/connected-devices.test.js`、`test/pages-panel-ux.test.js`、`test/pages-render-fixes.test.js`、`test/pin-field-width.test.js`、`docs/HANDOFF-0.4.16-真机第三轮返修-20261010.md`、`docs/HANDOFF-手机8问取证与修法-20261010.md` | **不是本档改的**；其中含配对码 **8 位 → 6 位** 的决定 |

⚠️ 本档**没有执行过 stash**，也没有整文件重写（一律用 edit 工具逐处改）。§0.2 的 hunk 归属用 `git diff -U0` 现取，非记忆。

### 0.2 `lib/pages.js` 的 hunk 分界（提交前必看）

现取 `git diff -U0 lib/pages.js` 的行号：

- **本档 12 处**：`753→754`（L.moreRows 文案）、`932→933`（LIST_FRESH_MS / LIST_ROWS_MAX）、`969→970` 与 `994→995`（listFetchedAt / openPrefetch / revealedLists 声明）、`1321→1322`（applyBootData：mode + listFetchedAt）、`1342→1343`（renderWorkspaces）、`1471→1472`（held 归零退避）、`1487,2→1488,2`（showSessionList + paintInstantHistory）、`1532→1533`（openSession：instantPainted）、`1561→1563,5` 与 `1564→1570`（prefetchSession + loadHistory）、`1748→1754,2`（workspaces onclick 的 more 分支 + onpointerdown）
- **他线 10 处**：`1998,2→2005,2`（renderMobileReconnectPage）、`2102`–`2292`（renderDesktopPairingPage 一族）

⇒ **整文件 `git add lib/pages.js` 会把他线那 10 处一并带进本档的提交**。要么接受（见 §6 一把梭文案），要么按 §6.2 拆。

`lib/bridge.js` 的 15 处 hunk 全部属于本档（导入、jsdoc 选项、`eventHolds`、`iconUiBytes`、`eventHoldMs`、`/app-icon?ui=1`、`/api/boot` 的 `mode`、文档渲染、握等三处）。测试文件两边**零重叠**。

---

## 1. 五条改动（现象 → 根因 → 改法 → 证据）

### 条 1｜列表只建看得见的行（最大头）

- **现象/根因**：`renderWorkspaces()` 给每个工作区的每条会话都生成一行 HTML，折叠只靠 CSS `.ws-body{display:none}`（`lib/pages.js` 样式行 537）。所以折叠**一个字节都不省**。
- **实测规模**（用户现场 436 + 266 条会话，沙箱基准 `tmp/20261010-pocket-abc/bench-list.mjs`，配方照 `test/subagent-session-dom-assertions.test.js`）：

  | 展开状态 | HTML | 行数 | 内联 `<svg>` | 建串耗时 |
  |---|---|---|---|---|
  | 只展开第一个（启动默认） | 改前 **319.2 KB** → 改后 **14.8 KB** | 702 → **25** | 712 → **35** | 1–3 ms |
  | 全部折叠 | 319.2 KB → **3.6 KB** | 702 → **0** | 712 → 10 | — |
  | 全展开 | 319.3 KB → 26.0 KB | 702 → 50 | 712 → 60 | — |
  | 点开某区「还有 N 条」 | 199.6 KB | 436 | 446 | 1.0 ms |

- **改法**：`shown = expanded ? tasks.slice(0, revealedLists.has(wsId) ? tasks.length : LIST_ROWS_MAX) : []`；超出部分出一枚复用现成 `.older-row` 类的药丸（`L.moreRows`＝「还有 {n} 条」），点它进 `revealedLists` 后重渲染。**没有新增任何 CSS 规则**。展开键原本就调 `renderWorkspaces()`，接口天然接得上。
- **注意（语义后果）**：`buildRenderSandbox` 的 `expanded` 默认值改成了**全展开**——因为那批测试的主体是「哪些会话成行」，不是折叠可见性；要验折叠必须显式传 `expanded: []`。这条写在测试文件注释里了。
- **守卫**：`test/subagent-session-dom-assertions.test.js` 的 **ROWS-1 / ROWS-2 / ROWS-3**（折叠不建行且不谎报「还没有对话」、封顶数正确且余数被**说出口**、点开一个区不影响另一个区的封顶）。
- **未覆盖**：浏览器侧 `innerHTML` 解析与布局耗时（V8 建串只 1–3 ms，真正的钱在手机上 parse 700 个带 SVG 的节点）。本档只证明了**送进浏览器的字节与节点数**降了 95%，手机上的实际帧收益待真机看。

### 条 2｜图标不再内联三次（每次冷开省 31.7 KB）

- **根因**：文档三处 `${icon || '/app-icon'}`（favicon、apple-touch-icon、页头 `<img`），而桥传的是 data URI ⇒ 同一个 96px 图标内联 **3 次**。实测：源 PNG 128,820 B → 缩放后 data URI **10,566 B**；带图标文档 **39,143 B**，不带 **7,472 B**。日志里 `bytes=49943` 的构成＝7.5 KB 真 markup ＋ ~10 KB boot payload ＋ **31.7 KB 图标×3**。文档是 `no-store` ＋ SW 网络优先 ⇒ **每次重开都重下**。
- **改法**：`lib/icon.js` 把真产品拆成 `buildIconBytes()`（PNG 字节），`buildIconDataUri()` 退化成它的一种编码；桥新增 `iconUiBytes` 字段，`/app-icon?ui=1` 送这 10.5 KB（`public, max-age=86400`）；**应用文档**改传 URL。裸 `/app-icon` **仍送 1024 原图**——manifest 里 `sizes:'1024x1024'` 承诺的是它（`test/pages-panel-ux.test.js` ① 钉着），不许换。**恢复页 / PIN 页继续内联**：未配对手机读不了 gated 路由，这条由 `test/reconnect-icon.test.js` K-1 钉着，本档没动它。
- **守卫**：`boot-landing` 新档（文档内 `data:image/png` 出现 0 次、三个槽位全指 `?ui=1`、没图标时回落裸路由）＋ `reconnect-icon` **K-2**（`?ui=1` 需鉴权、`cache-control` 为 24h、字节是缩放那份、`iconUiBytes` 为空时**不假装**有这个档）。

### 条 3｜索引 Map 移出工作区循环

`const byId=new Map(sessionSummaries.map(...))` 原来写在 `workspaces.map(w=>…)` **里面**：4 个工作区 × 702 条 ⇒ 每次刷新 2808 次插入去重复算同一份索引。提到循环外 ⇒ 702 次。无守卫档（纯机械等价，被 ROWS 三档间接覆盖）。

### 条 4｜按下去就预取（把隧道往返挪到手指底下）

- **改法**：`$('workspaces').onpointerdown` 命中 `data-action="open"` 的行即发 `session.history(30)`；`loadHistory` 在**同 id 且 4 秒内**时消费那条 promise（消费即清空，`openPrefetch=null` 只有一处），promise 失败则 `?? hist()` **回落到真取**——预取永远不可能让一次进入「等不到数据」。
- **门槛的理由**：点 A → 去 B → 5 分钟后回 A，若无时间戳就会把 5 分钟前的旧页当新数据刷出来。`pending:` 开头的本地 id 不预取。
- **代价**：**+888 B 壳字节**（四条里最贵，其中约 200 B 是解释性注释，故意留着）。嫌贵可整条砍掉（§8 回滚点），其余四条不受影响。
- **守卫**：`test/nav-reload.test.js` **D 两档**（预取的门与挂点；单次消费、时间门槛、失败回落、退役处唯一）。

### 条 5｜隧道空轮询改握等新帧（延迟上限 6 s → 近零）

- **根因**：`/api/session/events` 的采集器 `poll()` 是「取窗口里现有的」，空就立刻答 `[]`；手机于是按 `1500×2^n` 退避到 **6000 ms** 再问一次 ⇒ 空闲时白烧往返，出字时最坏 6 秒后才看见。
- **改法**：采集器加 `waiters` 表与 `onFrames(wake)`——`push()` 以 `'frame'` 唤醒、`stop()` 以 `'stopped'` 唤醒（**停机不能让人等满上限**）；桥 `holdSessionEvents()` 注册 frame 看客 ＋ 定时器 ＋ `request 'close'`，三路退出全释放，并登记进 `eventHolds`，`stop()` 兜底清表；答案带 `held:true`，手机见到 `held` 就把退避梯子归零（⇒ 几乎始终有一个请求开着）。
- **三个必须成立的边界，都有档**：
  1. **故障绝不握**：`connected:false` 时不启用（那个空答**就是**故障通知）。`EVENT_HOLD_MS=8000` 必须 < 手机放弃时限 `EVENTS_FETCH_TIMEOUT_MS=10000`，这条**按关系**钉（`session-events` HOLD-1），不是两个孤立字面量。
  2. **上限到点必答**（HOLD-3，`held:true` 且诚实为空）。
  3. **`stop()` 放人**（HOLD-5：60 s 上限下停机，请求 2 s 内 settle，`eventHolds.size === 0` 不泄漏）。
- **测试侧时序零污染**：`test/helpers.js` 的 `startBridge` 默认 `eventHoldMs: 0`（**答即走**），只有新五档显式开启 ⇒ 上面所有既有事件的档行为一字未变。
- **代价**：服务端 ~160 行（不占壳字节）＋ 手机侧一行 **65 B**。

---

## 2. 字节账（预算提额的对账）

- **基线**（不是抄注释里的旧数）：把 HEAD `505d254` 的 `lib/pages.js` 物化成 `lib/pages-head-tmp.js` 实测 → **zh 260122 / en 260049**，量完即删（`Test-Path` 复核已无残留，`git status` 无该文件）。
- **现值**：**zh 261996 / en 261917**，净 **+1874 / +1868**；四笔＝A/B/C +380、条 1 +391、条 4 +888、条 5 +65。
- **预算**：`ASSET_BUDGET_BYTES` **261_000 → 263_000**，余 **1004 B (zh) / 1083 B (en)**。逐笔账写进 `test/mobile-assets.test.js` WP1 上方注释（本仓规矩：「the diff of this test is the receipt」）。
- **提额的理由**：壳是内容哈希 ＋ `private, max-age=604800` ＋ service worker ⇒ 这 1.8 KB **每个装机版本只付一次**；换回来的是**每次开页都省**：文档 −31.7 KB、每次刷新列表 markup −300 KB、内容没变不再重绘。**注意**：这是本档在用户「先做了再决定」授权下自行做的决定，否决只需把常量改回 `261_000` 并砍条 4。

---

## 3. 测试账

| 项 | 结果 |
|---|---|
| `npm test` 全量 | **1053 ＝ 1051 pass / 0 fail / 2 skipped** |
| `node test-real-webserver.mjs`（真 HTTP 层） | **12/12**，warnings 0 errors 0 |
| `PARSE:` 内联脚本编译档 | **7/7**（改坏模板括号时它当场变红，两次） |
| 本档新增档 | **22 档**：nav-reload 10（新文件）、ROWS 3、HOLD 5、boot-landing 2、reconnect-icon 1、pages-tunnel-poll 1 |
| 未覆盖 | **渲染层与实机**（真机目验见 §5）；条 1 的浏览器 parse 耗时；`test/dom/*.mjs` 两个门控浏览器脚本本档没跑 |

过程中两次自己绊自己，记下来免得后人重犯：

1. **模板字符串里的 JS 多打一个 `}`**——`lib/pages.js` 自己照样合法、字节数照样对，只有 `PARSE:` 档红（0.4.13/0.4.14 已立此守卫，本轮再次兑现价值）。
2. **PowerShell 核验命令两次写错**：`Select-String -SimpleMatch` 配 `[regex]::Escape` 等于拿转义后的字面去比原文（`(` `?` `||` 全变字面反斜杠）；去掉 Escape 又漏了 `-SimpleMatch`（括号被当正则）。⇒ 结论：**别用命令字符串证明自己，去跑逐字断言这些改动的测试档**（120/120 绿）。

---

## 4. 装载状态：本批**全部未上线**

| 判据 | 值 |
|---|---|
| 宿主 `DeepSeek Harness.exe` 进程 | 5 个，均 **2026-10-10 23:00:00** 起（另有 23:15:33 一个渲染进程，不是判据） |
| HEAD 提交 | `505d254` **22:46:51** ⇒ 0.4.17 通知改动**已在装载内** |
| 本档改动落地时间 | **23:19 – 00:20**，全部晚于进程启动 ⇒ **未装载** |

junction 是活的，但 bundle 随启动装载 ⇒ **需要再重启一次 DeepSeek Harness 才生效**。重启属红线，本档没动宿主。重启后按下面 §5 逐条看。

---

## 5. 重启后真机目验清单（本机代劳不了）

1. 进会话 → 返回列表：**不闪、不跳回顶部**（30 秒内那次取数根本没发；离开时会话在跑或等回答则照发）
2. 同一会话退出去再进来：内容直接就在，**不被重绘拽到底**
3. 列表首屏明显变轻；工作区底部出现「还有 N 条」，点它才展开该区全部
4. 手指按住某一行稍停再松，进入更快
5. `~/.dsh/pocket/logs/pocket.log`（**UTC，+8 读**）：走隧道时**不再出现** `session stream closed`；桌面出字后手机上**不再等满 6 秒**
6. 顺带（**他线**决定）：配对页数字位数应为 **6 位**

---

## 6. 提交建议

### 6.1 一把梭（两拨一起提，message 里分账）

工作树现势共 **26 个文件**：A 线 14（含新建 `test/nav-reload.test.js` 与本文件）、B 线 12（含两份他线 HANDOFF）。

⚠️ 别用 `\` 续行——那是 bash 的写法，**PowerShell 不认**；三个文档路径含中文，拼引号也容易出错。故 23 个纯 ASCII 路径走 `--pathspec-from-file`，3 个中文路径单独一条：

```powershell
cd F:\defws\dsh-pocket
git add --pathspec-from-file=F:/defws/tmp/20261011-pocket-nav/add-list.txt
git add "docs/HANDOFF-0.4.17-导航五条-20261011.md" "docs/HANDOFF-手机8问取证与修法-20261010.md" "docs/HANDOFF-0.4.16-真机第三轮返修-20261010.md"
git grep --cached -E 'sk-[A-Za-z0-9]{32,}'   # 提交纪律要求的复扫，应无输出
git status --porcelain                        # 应只剩 tmp/ 下那三份一次性产物（不在仓内）
git commit -F F:/defws/tmp/20261011-pocket-nav/commit-msg.txt
```

- 逐文件显式 add 是硬约束（禁 `-A`/`-u`）；上面那份清单是**显式列表**，只是借 pathspec 文件避免 Windows 引号与续行坑。
- 含中文的 message 走 `-F` 文件（`pwsh -Command` 里拼中文引号的 `-m` 反复转义不通，本机记过）。
- `commit-msg.txt` 与 `add-list.txt` 在 `F:\defws\tmp\20261011-pocket-nav\`（`tmp/` 被根仓 `.gitignore` 排除，不进任何仓）。

### 6.2 拆两笔（想要干净历史时）

`lib/pages.js` 是**混合文件**，拆它得 hunk 级暂存（`git add -p` 逐块选，或先 `git diff -- <路径> > patch` 手工切）。**风险提示**：本仓记过一次「`pages.js` 在作业中途被外部进程整文件还原」的事故，切 hunk 期间两线仍在写同一文件 ⇒ 要么他线先收工，要么接受 6.1。

---

## 7. 对上一轮判断的两处更正（不要按旧结论改代码）

1. **`session stream closed … ms=30274` 不是「每 30 秒被拆一次的定时器」**。绝大多数是你自己在会话里待了 ~30 秒然后离开。真缺陷是**冷开时先在隧道上开了一条通不了的 EventSource**（`connectionMode` 默认 `'lan'`，靠 `/api/status` 事后纠正），由条 5/条 C 治掉；`ms=229`／`ms=89` 那两条才是导航拆的。
2. **「每 250 ms 拉整段 history」这个担心不成立**：隧道健康态下 `streamConnected` 由轮询答案置 `true`（`lib/pages.js:1469`），`loadHistory` 于是只取 `interaction.pending`。别照这条去改。

---

## 8. 回滚点（都在盘上，按需最小回退）

| 想退什么 | 动哪里 |
|---|---|
| 条 4（预取，省 888 B） | 删 `prefetchSession` 及其 `onpointerdown` 行；`loadHistory` 的 else 分支还原成 `[rpc('session.history',{sessionId,maxMessages:30}),rpc('interaction.pending',{sessionId})]`；删 `openPrefetch` 声明与 D 两档；预算可回到 `262_000` |
| 预算提额 | `test/mobile-assets.test.js` 的 `ASSET_BUDGET_BYTES` 改回 `261_000`（会变红，须同时退条 4） |
| 条 5 握等 | `EVENT_HOLD_MS = 0`（`lib/session-stream.js`）即恢复「空答即走」，其余机制不动 |
| 条 1 封顶 | `LIST_ROWS_MAX` 调大（如 `500`）即等效旧行为 |
| 条 2 图标 | `lib/bridge.js` 里 `renderMobilePage` 的 `icon` 传回 `this.iconDataUri` |
| 条 3 | 无害，不必单独退 |

---

## 9. 遗留与治理

- **CHANGELOG.md 本档没动**（他线在途文件）。要并入 0.4.17 节的文案见 §10。
- ⚠️ **`lib/pages.js` 本轮出现两个写者**（本档 ≤1754 行区，他线 ≥1998 行区）。区域不重叠所以没互相覆盖，但仓里的《pocket 文件域登记》写的是 `pages.js` **严格单写者串行**，工作区规则也有一条「并行唯一硬约束＝两个工人不能写同一个文件」。**这次是运气，不是机制在起作用**。建议后续要么按行段把登记写实，要么真的串行。
- 条 1 的手机侧实际帧收益待 §5 目验；`test/dom/pages-geometry.mjs` 那套浏览器几何本档没跑。

---

## 10. CHANGELOG 可粘段落（0.4.17 节末，简体中文，对外口径）

```markdown
### 手机页导航不再"重新加载"

- **返回列表不再无条件重取**：30 秒内直接沿用屏上那页；离开时若该会话正在跑或等你回答，照旧强制取。手动刷新键绕过窗口。
- **列表只建看得见的行**：折叠的工作区不再生成隐藏 markup，展开区一屏封顶 25 行，其余收成"还有 N 条"。按现场规模（436+266 条）实测每次刷新的 markup 从 319 KB / 702 行降到 14.8 KB / 25 行。
- **进会话不再被重绘**：命中缓存先画出来的内容会被随后一次"内容完全相同"的取数整屏重画并把滚动拽到底——现在即时绘制记下自己画了什么，取回一样的东西就不重绘。
- **图标不再内联三次**：手机文档每次冷开都要重下 31.7 KB 的 base64 图标（favicon / 触摸图标 / 页头各一份）。现在文档引用 `/app-icon?ui=1`（10.5 KB，缓存 24 小时），文档本体 39 KB → 7.5 KB。恢复页与配对页仍内联（未配对手机读不了受限路由）。
- **按下去就开始取**：手指按住会话行即发起首屏读数，隧道往返花在手指底下而不是花在等待里（4 秒内有效，失败自动回落到正常取数）。
- **隧道下新内容不再等 6 秒**：空闲轮询由「立刻答空、手机退避到 6 秒」改为「桥握住请求直到有新帧」（上限 8 秒，安全低于手机自身的 10 秒放弃时限）。故障通知不握、停机立刻放人。
```
