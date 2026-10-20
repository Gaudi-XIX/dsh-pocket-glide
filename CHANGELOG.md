# Changelog

本档只记**版本级的对外变化**：装机、使用与行为契约。逐笔施工账（谁在哪个包改了什么、证据在哪）
在 `git log` 与 flow change 卡（`F:\defws\.agents\flow\changes\`）里，不在这里重复。
最新的一节对应当前 `package.json` 的 `version`。

## 未发布（工作树）

**贴底重钉链首趟就认出读者已滑走（R4，跳跃残留的最后一根橡皮筋）**（⏳ 待重启生效：`lib/pages.js` 属宿主装载面，手机要完全关闭重开才拿得到新壳；生效判据＝运行桥 `GET /sw.js` 的 `V=` 变为盘上实算值。用户 2026-10-20 22:43 原话：「刚刚又跳了」）。

- **真机证据**（22:42:34，device r2AhHude1h，壳 pocket-909ab20f393f）：`pt@737157|62|14|32|21 bt@737158|5128|5863|735` 整屏重绘写到底 → 读者上滑 `sc…→4577`（−551px）→ 仅 121ms 后 `ts@737279|5128` 把他**钉回 5128** → 再 123ms 才 `rl@737402` 解除。读者出口（`rl` 门）在链条第二趟才生效，首趟无条件写回盒底。
- **R1/R2/R3 都守不住这里**：R3 的 `readerAway` 门守的是 `paintMessages` 那一次贴底写本身（bt/bf 分支）；`bt` 写完之后交给 `settleTailStick(box,4)` 的四趟重钉链（对付 content-visibility 估行转真行时 scrollHeight 继续长），链条入口那趟 `pinned` 是 undefined，`if(pinned!==undefined&&…)` 整个跳过——首趟必钉。
- **改法**（一行，净增 43 B）：`settleTailStick` 入口拿令牌那趟顺手 `if(pinned===undefined)pinned=box.scrollTop`——调用它之前那次贴底写刚把 scrollTop 写成底，此刻值就是合法基准。判据本身不动：内容长高只增 scrollHeight 不动 scrollTop，所以「scrollTop 变小」仍只可能是读者动手；合法重钉场景（进会话/发送后）不受影响，视口变高钳位（dist=0<120）与塌盒（无可滚范围）两条边界照旧。
- **计量账**：`ASSET_BUDGET_BYTES` 保持 381_950；改后实测 zh 381 836（css 56 093 + js 325 743）/ en 381 756，余量 **114 B**。
- **回归锁**：`test/pick-toggle-anchor-restore.test.js` 新增「入口即记下 pinned——贴底写后第一趟读者已滑走就不再钉回」＋原四条 tail stick 用例逐条复跑全绿。全量 `node --test --test-concurrency=1 test/*.test.js` = **1375 tests / 1373 pass / 0 fail / 2 skipped**（2026-10-20 23:1x）。

**启动页三步计数改为爬升，不再整块蹦出**（⏳ 待重启生效：`lib/pages.js` 属宿主装载面，手机要完全关闭重开才拿得到新壳；生效判据＝运行桥 `GET /sw.js` 的 `V=` 变为盘上实算值。用户 2026-10-20 原话：「先显示数字，一个数字过一个数字，哒哒哒的效果」）。

- **范围**：配对页与重连页共用的引导阶梯（`sharedStageScript()`），三处计数——工作区数、会话数、消息组数——由「答案到手就整串写死」改成 0→N 爬升；「已连接」「就绪」这类文字标签仍直写，不动画（`setCount` 保留原语义）。两页各一套阶梯，改在共享块里，一次覆盖两面。
- **机制**：新增 `countUp(el,target,fmt)`（`COUNT_UP_MS=450`，缓出曲线 `1-(1-p)^3`，`requestAnimationFrame` 逐帧）与 `stepCountEl(i)`（按序号取行内的 `.boot-step-count`）。**发射后不管**——`stageRunner` 不 await 它，动画不会拖住任何一步的推进，也拦不住最后的 `location.replace('/')`。计数元素本就带 `font-variant-numeric:tabular-nums`，滚动时宽度不变、版心不抖。
- **三条边界**：① 数据没回来前该行**保持空白**，不预填 0——不显示没人量过的数值（选项 B「先填 0」被否，公网慢时停在「0 个工作区」会被读成真的没有）；② 实测值确实是 0 时直接写终值，因为那是真读数不是缺字段；③ `prefers-reduced-motion:reduce` 下直接写终值、不滚。
- **计量账**：本笔只动两个引导页文档，**不进 app 壳**——`ASSET_BUDGET_BYTES` 保持 376_000，实测壳字节仍为 zh 375 696（css 55 217 + js 320 479）/ en 375 614，与 `aedb4f9` 读数一致。
- **回归锁**：新增 `test/boot-count-up.test.js` 7 条——把共享块里的器官原样抽出、套桩 DOM 实跑，验证「逐帧推进且末帧等于终值」「reduced-motion 立刻出终值」「0 直写」「行不存在不抛」「setCount 文字不参与动画」「两页各带一份器官」「行模板发出时是空 span 不预填」。全量 `node --test --test-concurrency=1 test/*.test.js` = **1351 tests / 1349 pass / 0 fail / 2 skipped**。

**工作区头徽标口径按真机复验改正**（⏳ 待重启生效：`lib/pages.js` 属宿主装载面，手机要完全关闭重开才拿得到新壳；生效判据＝运行桥 `GET /sw.js` 的 `V=` 变为盘上实算值。用户 2026-10-20 真机复验两条：①「我刚刚专门挑了一个错误的对话，它报错了，我没读，工作区标题栏上面不显示」②「如果有已完成的消息，标题栏上面还是显示'正在进行中'，这和我的设定就不符」）。

- **用户新口径（m00623，取代同日 m00126②）**：「工作区标题栏的显示规则应该是：只要这个工作区里面有以下内容，都要显示出来：1. 未读的新消息 2. 未读的错误 3. 提问」＋「(a) 提问：理论上讲，提问不分已读未读，只要有提问就都要显示出来。(b) 错误和已完成：肯定是分已读和未读的」。即提问徽标**不设已读门禁**（上一节写的「提问已读即静」被真机判为错），错误与已完成都过未读门禁，三类同时出现时都要画出来。
- **① 未读错误在 running 行上也出现**：`isQuestionUnread` 改名 `isNoticeUnread`（逻辑一字未改：与 `isSessionUnread` 同构，只差「不按 running 一票否决」），`wsFlagOf` 的 error 分支由 `isSessionUnread` 改走它。根因：报错的那一轮宿主经常仍把行标成 `running:true`（`turn/end` 的 error 不落 `running=false`），而 `isSessionUnread` 首句 `if(!summary||summary.running||summary.blank)return false` 直接否决 ⇒ 徽标消失。running 否决只该管「新完成」提醒（还在忙就别喊完成了），不该管错误。
- **② 提问不论读过与否都显示**：`wsFlagOf` 的 awaiting 分支去掉未读门禁，只保留 `activeId` 排除（人正在那个会话里回答，徽标不该再喊）。
- **③ 三类徽标不再被截断**：`WS_FLAGS_MAX` 2→3。cap=2 时一个工作区同时有「未读错误＋提问＋未读新完成」会静默丢掉第三类，与用户「都要显示出来」直接冲突。
- **未动的**：`taskState` 仍对 error 返回 `'error'`、行的红字形不撤（「不能把错误改成已完成」是行的状态，「不能一直显示错误」是头的提醒，两者分离）；`wsGlyphOf` 的兜底两态、`wsHeadTimeAt` 的头时钟均按上一节，本笔未改。
- **计量账**：`ASSET_BUDGET_BYTES` 保持 376_000（本笔不动该常量）。本笔后实测壳字节 zh 375 131（css 55 217 + js 319 914）/ en 375 049（css 55 217 + js 319 832），相对「一 Bot 一行」基线（zh 374 315 / en 374 233）净 +816 B，余量 869 B。
- **回归锁**：`test/workspace-head-notices.test.js` 改写 2 条旧口径用例（rank 那条由 `[error, question]` 改为三类全出；「提问已读即静」那条按 (a) 反转为「读过也显示」并补 (b) 的读后错误仍静）＋新增 1 条「running 行上的未读错误仍出徽标、running 行不算新完成」；`test/pages-scroll-anchors.test.js` 沙箱 `WS_FLAGS_MAX` 同步为 3、抽取名单改 `isNoticeUnread`；`test/subagent-session-dom-assertions.test.js` 抽取名单同步改名。全量 `node --test --test-concurrency=1 test/*.test.js` = **1342 tests / 1340 pass / 0 fail / 2 skipped**（共享工作树含他线在途改动，非净检出）。
- **已知边界（未修）**：错误标记由 `lib/session-stream.js` 的进程内 store 累积（`sessionErrorStores` 是 WeakMap，容量 16），**宿主重启后、重启前发生的错误无法回溯显示**；某会话自重启起没被 follow 流订阅过就不会有 `lastError`，头也不出错误徽标。

**工作区头三处显示裁定**（⏳ 待重启生效：`lib/pages.js` 属宿主装载面，手机要完全关闭重开才拿得到新壳；生效判据＝运行桥 `GET /sw.js` 的 `V=` 变为盘上实算值。用户 2026-10-20 三问：①「如果我置顶了比如前天的会话，它就会只显示前天的时间」②「已经阅读过的错误会话，不能在会话里面把错误改成已完成……置顶里面应该关注的是没有看的提问、没有看的错误、没有阅读的新回答」③「最终的显示状态应该只有两种」）。
- **① 置顶不拖回工作区头时钟**：新增 `wsHeadTimeAt`，头时钟取全部行中最新时间戳而非置顶行，置顶只影响阅读顺序、不冒充「最后说话时间」，无时钟时不输出空 span。
- **② 提问已读即静**：新增 `isQuestionUnread`（与 `isSessionUnread` 同构但去掉 running/blank 早退），awaiting 提问读过即不再进工作区头徽标；error 仍由 `isSessionUnread` 门控，状态与徽标分离。**（此条口径已被上一节推翻：2026-10-20 真机复验裁定提问不分已读未读，该函数改名为 `isNoticeUnread` 且 awaiting 分支去掉门禁；原文保留仅为记录演变。）**
- **③ 工作区头仅两态**：`wsGlyphOf` 收敛混态回落，只剩「正在进行的对话」与「整个工作区没有正在进行的对话」两态；空白工作区保留现状空白虚线，不算完成。
- **计量账**：`ASSET_BUDGET_BYTES` 367_000→371_000，HEAD+本笔实测 zh 367 944（css 55 217 + js 312 727）/ en 367 862，余量 ~3.1 KB。
- **回归锁**：`test/workspace-head-notices.test.js` 新增 5 条（本批 74/74），净检出全量 `node --test --test-concurrency=1 test/*.test.js` = 1324 pass / 0 fail / 4 skipped。

**乐观回声按「形状指纹」退休**（2026-10-20。用户报障原话：「图片发送以后，好像会有那种图片消失又重复出现、消失又出现的 bug」，当日两次真机连发两张图 165 KB / 319 KB 复现）。

- **动机**：乐观回显的退休判据原先只比文字 `durableUserPromptText(message)!==item.text`。纯图消息的文字是空串，所以「两条都只带一张图的发送」在判据眼里是同一句话——谁的 durable 副本先落地，就把**另一条还没到的回声**一起退掉，屏幕上那次发送消失；等它自己的副本落地再画出来。附件的 `attachmentId` 不能拿来当判据：宿主回显时会把图片重写一份（规范化副本、新 id），两边永远对不上。
- **判据**：新增 `promptShape(message)`，把「一条发送」归约成 `图片数|文件数|文字长度|文字`。文字取第一个 `text` 块（回声自身没有 blocks，回落到 `message.text`）；图片/文件数先数 blocks，再把 `message.chips`（`'1 图片'` / `'1 Images'` / `'1 文件'` / `'1 File'`）里的数字按「含『图』或英文 image」归到图片、其余归到文件累加。`messagesWithOptimistic` 的淘汰判据由文字相等改成指纹相等，水位推进（`item.afterSeq` 每帧上移到已见过的最新同形副本）**原样保留**——去掉它会让 matches≥2 的回声永久不退休、变成卡死的重复气泡（`test/transcript-order.test.js` 的 M17 用例正是钉这一点的）。
- **本笔不声称修好闪烁**：上面这条只消灭「相似发送互相误退休」这一类。真机上「图片消失又出现」的机制另有出处且本笔未动——`paintMessages` 每帧 `box.innerHTML` 整段重建会话 DOM（任何非 `assistant/chunk` 流事件都触发全量重画，见 `queueStreamRender(…, type!=='assistant/chunk')`），而 `/api/session-attachment` 带 `cache-control: private, no-store`，每个 `<img>` 重建后都要重新下载/解码。手机端这条待另修。
- **计量账**：预算不动（`ASSET_BUDGET_BYTES` 保持 371_000）。相对 HEAD 净增 zh +2 298 B / en +2 298 B，实测壳字节 zh 370 242（css 55 217 + js 315 025）/ en 370 160（css 55 217 + js 314 943），余量 zh 758 B / en 840 B。
- **回归锁**：新增 `test/pages-optimistic-retirement.test.js` 6 条（不同图数不误退休 / 无附件不误退休 / 图片副本不退休纯文件回声 / 自己的副本仍退休（防修过度）/ 多帧渲染不翻转 / 同形两回声仍会被第一份副本一起退休——**已知形状盲区，明文钉住**）；`test/transcript-order.test.js` 沙箱补注入 `promptShape` 并把 M17 静态锁改钉规则而非稠密表达式；`test/pages-render-fixes.test.js` BUG3 沙箱同步补注入。红前置自证：把 `lib/pages.js` 还原成 HEAD、只留测试，`test/pages-optimistic-retirement.test.js` = **6 tests / 2 pass / 4 fail**（帧序列那条 `['kept','retired','retired','retired']` ≠ `['kept','kept','retired','retired']`）。净检出全量 `node --test --test-concurrency=1 test/*.test.js` = **1334 tests / 1332 pass / 0 fail / 2 skipped**。

**附件响应改为可缓存（闪烁的另一半）**（⏳ 待重启生效：`lib/bridge.js` 属宿主装载面，手机要完全关闭重开才拿得到新壳；生效判据＝运行桥 `GET /sw.js` 的 `V=` 变为盘上实算值。承接上一节「本笔不声称修好闪烁」里点名的真机机制——那一节修的是「相似发送互相误退休」，这一节修的是「每帧重建把图片重新下载一遍」。2026-10-20 用户报「图片发送以后，图片消失又重复出现」）。

- **机制**：`paintMessages` 每帧用 `box.innerHTML` 整段重建会话，任何非 `assistant/chunk` 的流事件（tool/call、tool/result、step/\*、job/\*）都触发全量重画，于是每个 `<img>` 都是新元素；而 `/api/session-attachment` 原先带 `cache-control: private, no-store`，新元素没有可复用的字节，手机就在每个非 chunk 事件后把 165 KB / 319 KB 的图重新下载一遍再解码——屏幕上正是「消失一下又出现」。
- **修法**：附件响应头 `private, no-store` → **`private, max-age=86400`**。attachmentId 是内容寻址的，宿主该行在会话期内字节不变，答案可安全从浏览器缓存重放；`private` 保证字节不落共享缓存。选一天窗口与上方静态资源分支（`public, max-age=86400`）同档。**不改 service worker**：壳的 `BYPASS` 正则（`lib/pages.js` 内 `/^\/(api|…)/`）已把 `/api` 整段排除在 SW 拦截外，`/api/session-attachment` 从来只走浏览器 HTTP 缓存，所以改响应头正是对的杠杆。
- **未动的两处 no-store**：同文件 `session-file`、`session-export` 两条路由的 `private, no-store` 保持原样——它们不是会话内反复重画的 `<img>` 源，改它们没有这块收益，且导出/下载本就不该缓存。
- **计量账**：`lib/bridge.js` 不在壳内，壳字节与 `ASSET_BUDGET_BYTES` 均不动。
- **回归锁**：`test/plus-panel.test.js` 附件路由断言同步为 `private, max-age=86400`（同文件 export 路由的 no-store 断言不动）。`node --test test/plus-panel.test.js` = **19 tests / 19 pass / 0 fail**。
- **仍存的另一半**：本节让重画的 `<img>` 命中浏览器缓存、不再重下载，但「每帧 `innerHTML` 整段重建」本身没动——彻底不重建 DOM（图片元素增量保留）是更大的改动，留待后续。真机是否仍闪，须重启宿主＋手机完全关闭重开后实测。

## 0.4.53 — 2026-10-19

**上传有转圈与进度、附件占位改胶囊、桥侧开始记上传耗时**（⏳ 待重启生效：`lib/pages.js` 与 `lib/bridge.js` 都属宿主装载面，手机要完全关闭重开才拿得到新壳；生效判据＝运行桥 `GET /sw.js` 的 `V=` 变为盘上实算值。用户 2026-10-19 真机上传 1.17 MB PDF 后三问：①「上传中我觉得要有一个圆圈或者什么上传进度，不能这种硬卡在这儿。我不知道你是卡死了，还是确实正在上传」②「发出去以后……会有'图片 1'、'文件 1'之类的占位，为什么会有这个东西发出去？」③「这个上传进度很慢啊，是 Cloudflare 的原因还是别的什么」）。

- **① 上传中不再是一张静止的卡**：draft 卡在 `uploading` 态由「半透明遮罩＋静止文字『上传中…』」改为转圈（`.draft-ring`）＋百分比＋`已传 / 总量` 两行，底部蓝条按 `--p` 填充；`ready` 后右上角补一枚绿勾（`.draft-done`），不再需要靠卡片「不变」来推断成功。百分比的真实来源是 `xhr.upload.onprogress`——`fetch()` 没有上传进度事件，故新增 `rpcUpload()` 走 XHR，**只有 `file.upload` 走它，其余调用仍走原 `rpc()`**。进度用**原地补丁**写进已在屏的那张卡而不是重建 `draftStrip`：每 tick 重建 DOM 会让转圈动画归零、卡片每秒被丢弃数十次，那正是这个功能要消灭的抖动。
- **① 慢 ≠ 卡死：45 秒静默看门狗**：`rpcUpload` 内 5 s 一次巡检，`Date.now()-lastByteAt >= 45 000` 才 abort。判据是**静默时长而非总时长**——一个 20 MB 文件在弱网慢慢爬仍在走，掐掉它恰好制造了用户分不清的那次「卡死」。硬超时 `RPC_SLOW_TIMEOUT_MS*4`（12 min）只兜病理情况。上传体发完后等回执那段不再有任何进度事件，`xhr.upload.onload` 重置静默时钟，让回执独享一个完整窗口。
- **② 「1 文件」占位不是发出去的**：它是乐观行把计数串当**第二段纯文本**渲染出来的（发送内容 `content` 里从来没有它，宿主侧也没有）。现在 `draftSummary()` 返回数组而非 join 好的串，乐观行带 `attachment-summary` 块，`renderBlock` 把每一条渲染成胶囊（`.draft-chip`），与已落定消息里的附件样式一致。顺带删掉已无人使用的 `draftJoin` 标签，消掉一处「英文用户看到全角逗号」的本地化泄漏。
- **③ 慢在哪一段，桥侧开始记账**：`/api/rpc` 对成功的 `file.upload` 落一条 `rpc upload ok trace=… device=… bytes=… arrival=…ms host=…ms`——`arrival` 是手机字节穿过隧道进桥，`host` 是桥交宿主并拿回执。在此之前，成功上传**在日志上是完全静默的**（只有失败才有行），所以「是 Cloudflare 还是别的」无法从盘上取证。
- **计量账**：`ASSET_BUDGET_BYTES` 358_000 → **365_000**。实测壳字节 zh 363 564（css 55 010 + js 308 554）/ en 363 482（css 55 010 + js 308 472），相对上一条基线（zh 357 070 / en 356 987）净 +6 494 B（css +1 506 / js +4 988），余量约 1 436 B。（0.4.53 收尾时 HEAD 又并入「提问弹窗两钮／上滑不拽底」一笔，实测量随之变为 zh 363 951 / en 363 869，净 +6 881 B，余量 1 049 B；本条数字为上传批落盘时的读数。）
- **回归锁**：`test/mobile-assets.test.js` AC-UI8 守卫按新形态重写（拦「英文用户看到中文标点」的用意不变，改为断言 `attachment-summary` 分支、chips 逐个成 span、且源码里没有 `join('，')`）。全量 **1314 tests / 1312 pass / 0 fail / 2 skipped**。

## 0.4.52 — 2026-10-19

**刷新按钮在「手机已连上」时不再静默失效**（⏳ 待重启生效：`lib/pages.js` 属宿主装载面。2026-10-19 重启后实测发现 0.4.51 的强制重建仍被一层页面门拦住：`switchMode` 首句 `if(phoneConnected||modeSwitching)return`——手机在线时点「刷新」静默无操作，桥侧 `force` 日志（`tunnel rebuilt on desktop refresh`）命中为 0，即原始报障「点刷新链接二维码都不刷新」在连接态下的完整成因。桥侧 force 重建本就允许把在线手机 park 掉而非拒绝（同隧道意外死亡处置），页面这一层与服务端口径不符，按「服务端已允许的，页面不得自行再加一层」删去）。

- **force 豁免连接态早退**：`switchMode(enableTunnel,force)` 首句改为 `if(modeSwitching||(!force&&phoneConnected))return`——普通切模式在连接态仍照旧拒绝（2026-10-12 裁定的风险口径不变），但桌面刷新按钮的强制重建放行；桥侧 park 手机会话（不登出），手机拿新链接重配即可。
- **回归锁**：`test/desktop-connected-unlocked.test.js` D 例的源码锚点同步为新守卫；`test/queue-steer-refresh-20261019.test.js` ① 例加两条断言（普通切换仍被连接态拦、旧守卫写法不残留）。全量 **1314 tests / 1312 pass / 0 fail / 2 skipped**。

## 0.4.51 — 2026-10-19

**刷新按钮＝强制重建公网隧道 ＋ 排队消息即时上屏与按写入时间复位落位**（⏳ 待重启生效：`lib/bridge.js` 与 `lib/pages.js` 都属宿主装载面，手机要完全关闭重开才拿得到新壳；生效判据＝运行桥 `GET /sw.js` 的 `V=` 变为盘上实算的 zh `pocket-bab0c067b098` / en `pocket-1f45ea709999`。用户 2026-10-19 三项报障，裁定「改成强制重建」「修复」「刚刚给你发的图片就是证据」）。

- **刷新按钮恢复「重建临时通道」语义**：桌面配对页的刷新按钮自初版（`0435cbb`）起只做两件事——隧道没起就开隧道，隧道已起就只轮换配对 token 并重载页面（`c880f70` 2026-10-01 的改动，动因是 LAN 语境下「TTL 内重载画出一模一样的码」）。但公网模式下配对地址由隧道实例派生，轮换 token 动不了它 ⇒ 按钮在用户眼里完全失效（用户原话：「之前的刷新按钮，意思就是重新手动重建一次临时的通道，二维码和链接都会刷新」）。现在：`bridge.toggleTunnel(enable, force)` 收到 `force` 且隧道活着时，先把在线手机会话 park（与隧道意外死亡同一处置：不登出、下次请求回配对门）、停掉旧隧道、清空隧道态，再走一次全新的 launch ⇒ 新域名、新二维码、新链接；`POST /desktop/tunnel/status` 的兄弟路由 `/desktop/tunnel/toggle` 接受 `{force:true}`（只认严格 `true`），桌面页 `switchMode(enableTunnel,force)` 透传。切模式 tab 仍不带 force，不会被误判成要换域名；LAN 档没有隧道可重建，刷新保持「轮换 token + 重载」。
- **排队消息点「立刻发送」即时上屏**：此前 `queueAction` 成功后只重拉 projections（队列坞与 GoalBar），正文要等下一帧 events——公网隧道模式没有 SSE，事件轮询 1.5 s 起步、无新帧时指数退避到 6 s，再叠公网往返，即用户说的「显示出来的速度非常之慢」。现在成功后立刻踢一次轮询并清掉历史去重键、强制拉一次会话正文，气泡在同一个动作里上屏。
- **排队消息不再落到会话最底部**：宿主把 steer 出来的消息 splice 进正在跑的回合，事件 seq 是最新的，而会话渲染严格按 seq 排序 ⇒ 排队期间写的消息会被画在「当时正在流式的答复」下方（用户截图：19:02 的气泡落在 19:04 的答复底下）。seq 是宿主的排序口径、本层不能重写，但气泡自带写入时刻：新增按时间戳复位的重排——只有当某条用户气泡的时刻早于它上方相邻行时才上移，没有时间戳的行（过程卡、活回合）当墙，非用户行一条都不动。
- **计量账**：`ASSET_BUDGET_BYTES` 356_000 → **358_000**。实测壳字节 zh 357 070（css 53 504 + js 303 566）/ en 356 987，相对上一条基线（zh 354 860 / en 354 777）净 +2 210 B（css −17 / js +2 227），余量约 930 B。
- **回归锁**：新增 `test/queue-steer-refresh-20261019.test.js` 8 例（force 重建换新 URL 与新二维码、plain enable 仍复用、强制重建后手机是 park 而非登出、refreshQr/switchMode 源码契约、steer 后即时踢轮询与拉正文、四种落位场景）。白盒沙箱抽取名单补 `orderUserBubblesByTime`（5 个测试文件）；`goal-queue-dock` 的队列动作沙箱补 `connectionMode`/`scheduleEventPoll`/`loadHistory` 并断言踢动序列。全量 **1314 tests / 1312 pass / 0 fail / 2 skipped**。

## 0.4.50 — 2026-10-19

> 本节原先是 `## 未发布（工作树）`，一次性收录了 `0.4.48`～`0.4.50` 三批的条目：前两版随 commit 发布
> （`0b55fc5`、`353a4ab`）但没单列节，条目一直挂在这里没丢；本次随六 bug 批正式提位并封节。
> 条目里标着版本号的是该条实际所属版本，标着「✅ 已随某日重启上线」的是早于本节发布的、随当次重启生效的内容。

**子代理胶囊时间戳右侧防截断 ＋ 只读视图独立悬浮停止按钮（方案一）**（⏳ 待重启生效：`lib/pages.js` 属宿主装载面，手机端需重载 PWA 壳生效。用户反馈：「子代理胶囊里面的显示还是有问题，右边的时间被吃掉了一块儿，没有显示全」；「还要加一个子代理任务结束的按钮，跟主会话的按钮一样。加到哪儿呢？是不是加到子代理点进去的那个地方？这样会更符合操作逻辑一些……那就按方案一呗」）。

- **胶囊排版右侧时间截断根因修复**：根因系 `.subagent-rows` 采用隐式 Grid 且未声明列宽规则，单元格按内容宽度（长标题）自动撑开至 520px+，致使内部 `<time>` 时间标签被顶出右侧可视边界截断。修复措施：`.subagent-rows` 增加 `grid-template-columns: minmax(0, 1fr)` 严格锁死列宽；`.subagent-row` 声明 `min-width: 0; max-width: 100%; overflow: hidden` 强制内部文字省略截断；`<time>` 显式指定 `text-align: right`，经 Headless Edge 实测行宽由 522.3px 严密收敛至 286.0px（有滚动条时 271.0px），时间戳完整展示且杜绝横向滚动。
- **子代理只读视图新增 44px 悬浮停止按钮（方案一）**：
  - **视觉与交互对齐主会话**：在 `#chatView` 内新增悬浮圆形停止按钮 `#subagentCancel`（`.subagent-stop`），规格 44×44px（深色背景、圆角矩形方块停止图标，点击触发与主会话停止相同的 0.94 弹性缩放），仅在 `subagentView && agentRunning` 时浮现在右下角（`bottom: calc(18px + env(safe-area-inset-bottom))`）；在 `body.subagent-open` 时消息列表底部增加 72px 安全间距防遮挡。
  - **停止逻辑与状态联动**：点击后直接调用 `session.cancel` 取消当前子代理会话，停止中自动切为旋转菊花加载态并禁用防重复点击；离开会话或列表回退时立即隐匿。
- **计量账**：`ASSET_BUDGET_BYTES` 352_000 → **354_000**。实测壳字节 zh 352 550（css 53 012 + js 299 538）/ en 352 447，净 +1 286 B（css +405 / js +881），余量约 1 450 B。
- **回归锁**：`test/subagent-panel.test.js` 20 pass（新增子代理停止按钮 DOM/CSS/JS 状态联动断言，修复午夜跨天测试脆弱性）；`test/stop-pending.test.js` 19 pass；`test/mobile-assets.test.js` 20 pass。全量测试除另一在途线未碰文件外全绿。

**子代理仍在跑时不再显示「已完成」＋ 胶囊运行态可见（0.4.50）**（⏳ 待重启生效：`lib/projections.js` 与 `lib/pages.js` 属宿主装载面，手机要完全关闭重开才拿得到新壳。用户 m00002「主代理的会话结束了，子代理还在运行呢，这个会话显示就是"已完成"，这个是不对的」；m00053「子代理本身正在运行，但显示的不是"正在运行"的状态，应该是个蓝色的标志」）。

- **聚合改成整棵子树（与宿主同判据）**：`lib/projections.js` 的 `applyDescendantRunning` 旧版只给运行中子行的**直接父**打 `descendantRunning`——孙辈在跑、子已收工时父仍误判 done。现在自每一行向下 BFS 整条后代链，任一后代 `running===true` 即标记该行，`visited` 防 `parentSession` 成环；与宿主自己的 `dsh-subagent/lib/index.js` `runningDescendants()` 同构。本机 590 个会话头实测：`origin` 只有 `'subagent'`(402) 与无(188)，带 `parentSession` 的非 subagent 行为 0，402 条 `parentSession` 全部命中现存 header.id ⇒ 现有 `origin==='subagent'` 过滤是完备的、join 字面同形。无脏行仍原数组直返（不变异缓存行，「never mutates」钉值不动）。
- **页面不再谎报 idle**：`subagentStateOf` 拿不到子行时旧版一律 `'idle'`。新增 `parentRowOfActive()`，父行带 `descendantRunning` 而子行缺席（boot 只取最近 30 行，子会话历史行被切掉）时报新状态 `'unknown'`——诚实的「有子代理在跑但我定位不到哪一条」，不冒充 idle。
- **胶囊头蓝点由父行标志兜底**：`has-running` 条件扩为「有 running 行 ∨ 有 unknown 行 ∨ 父行 `descendantRunning`」，故即使一行子状态都判不出来，胶囊头也是蓝色脉冲点、主页那格不再是绿勾。运行点/脉冲点加 `animation:pulse` 与静止灰点区分（复用既有 `@keyframes pulse`，未新增动画名）；`is-unknown` 点半透明蓝；`.subagent-rows` 补 `overflow-x:hidden;touch-action:pan-y`（只许上下滚、禁左右拖）。长标题单行省略、左标题右顶时间——CSS 层原本已成立，本次未动。
- **进会话按需补拉一次全量子行**：`openSession` 尾挂 `refreshSubagentRowsIfNeeded()`——仅当「父有 catalog 且子行窗口为空」时发一次既有的全量 `session.list`（桥 10 秒窗内重复打开很便宜），同一会话最多一次，不为每个会话都付全量读；不新增 RPC 面。
- **boot 行落地即重画胶囊**：`applyBootData` 更新 `subagentRowsByParent`/`sessionSummaries` 后，若在聊天页补一次 `renderSubagentBar()`（此前要等 60 秒列表轮询或显式刷新才反映，进聊天时可能一直显示旧态）。
- **修不了的一条（宿主面缺口，非本插件）**：外部/ACP 工人子代理在宿主 `dsh-subagent/lib/index.js:827 establishExternalCatalogChild` 只写 catalog、**不建子 session 行**，且 catalog 条目只 append 永不移除（本机实测某父的 91 条 catalog `childId` **全部**指向已不存在的会话）；宿主自己的子代理树 `listDescendants`（`:2394`/`:2421`）对 `mode==='external'` 同样报 inactive，冷会话行 `running` 恒 `false`（`summarizeCold`）。⇒ 这类子代理的运行态在手机侧无可证数据源；真机若仍误判，需当次会话 id 判定是否 external/cold。
- **计量账**：`ASSET_BUDGET_BYTES` 349_000 → **352_000**。实测壳字节 zh 351 264（css 52 607 + js 298 657）/ en 351 163，净 +3 042 B（css +412 / js +2 630）。
- **回归锁**：`test/subagent-panel.test.js` 19 pass（夹具补注入 `parentRowOfActive` 与 `sessionSummaries`；新增 unknown 判定、父标志兜底亮蓝点、unknown 排序与计数）；`test/record-projection.test.js` 26 pass（旧「只一层」钉值按新语义改写为「aggregated all the way up to the root lead」，另加成环必收敛的反例）；`test/landing-fingerprint.test.js` 6 pass（改钉 `applyBootData` 的重画尾巴）。全量 `npm test` 1295 项／1292 pass／1 fail／2 skipped——唯一红属同工作树另一条在途线（`test/pin-field-width.test.js:118` 仍钉已被方案C 改掉的旧重连文案），本线未碰。

**重启通知归位直白功能提醒 + 页面侧方案C双端贯通文艺就绪视觉**（⏳ 待重启生效：`lib/pages.js` 与 `lib/bridge.js` 属宿主装载面；`scripts/dsh-revive.ps1` 落盘即生效无需重启。用户「C吧？都改下」）。

- **微信推送回归功能通知**：用户澄清「文案是在 pocket 加载页面里显示，不是微信推送里显示」。`scripts/dsh-revive.ps1` 成功推送标题切回直白的 `DSH 已重启`、正文 `已就绪。回任意一句话拿新地址。`；并顺手补齐脚本首部 UTF-8 BOM，消除 Windows PowerShell 5.1 解析失败崩溃（退出码 1）的历史根因。确认卡第 5 条丑话同步回切。
- **页面侧方案 C 双端贯通与过渡页精简**（用户「副标题改为两行，一级准备那儿单独起一行 其余按你推荐」）：
  - **`/reconnect` 等待过渡页**：标题保留 `连接已断开`，副标题独立分为两行（首行品牌引述 `Curiouser and curiouser!`，次行就绪提示 `Pocket 一级准备`），视觉层次清晰；
  - **剔除多余次级按钮**：移除歧义严重的 `在电脑上查看密码` 弱按钮，消除手机端误导（在独立配对 PIN 页一并隐藏）；
  - **精炼引导文案**：压缩长难句并删除极客黑话（`公网通道仍可用……不必重新扫码` 提炼为直白的 `输入电脑端 Pocket 显示的连接密码。`；局域网引导提炼为 `手机与电脑需在同一 Wi-Fi，正在自动重连…`）；
  - **主页 `GET /` 首屏加载壳**：在列表数据未到达前，`<div id="workspaces">` 占位呈现 `.ws-splash`，展示爱丽丝台词与就绪提示，数据一到即无感覆盖。
- **远程强制重启链路健壮性与确认卡交互收敛**（用户「有子任务的时候无法强制重启，这个点你要改一下。强重启不是会转圈圈嘛，直接在立刻重启上改UI直接变成转圈圈，把立刻重启直接改为强制重启，不能增加过多按钮」）：
  - **强制重启穿透子任务限制**：`lib/bridge.js` 在 `force=true` 时对 busy 会话发起最佳努力 `session/cancel`，即便子任务（如 `agent-busy` 或 subagent 会话）取消失败或被拒，也不再返回 502 阻断流程，而是如实告警并坚决放行推进宿主武装重启；
  - **转圈圈就地内嵌按钮**：`lib/pages.js` 点击重启后直接将 `#hostGo` 按钮内容替换为 `.host-spin` 环形转圈（同时禁用 `取消` 与重启钮），移除下方额外挤出一行的 `#hostStatus` 转圈，消除视觉跳动与排版下移；
  - **单按钮状态就地切换**：遇有会话在推进时，`#hostGo` 按钮文本由 `确认重启` 就地切换为 `强制重启`，彻底废弃外挂的第三个 `#hostForce` 按钮，严格保持 `取消` + `确认/强制重启` 双按钮紧凑格局；取消或重开时复位。
- **置顶/取消置顶按钮轻量乐观更新与微状态**（用户「你排查下，手机pocket页面，置顶按钮点击取消很卡」）：
  - 点击置顶/取消瞬间立即在内存中反转 `pinnedSessionIds` 并即时呈现（0ms 等待感），消除等待网络 RPC 期间无视觉反馈引发的「界面卡顿/无响应」体感；
  - 补充 `.task-pin:disabled{opacity:.5;pointer-events:none}` 状态样式，同步期间防重复狂点与误触；
  - 针对展开卡片锁定 `revealedLists` 显式显示行数，防止取消置顶的超 24h 历史行从用户拇指下凭空蒸发折叠；
  - RPC 失败时精准回滚 `pinnedSessionIds` 原值并弹出 `pinFailed` 提示；
  - 回归锁：`test/workspace-head-notices.test.js` 24 pass、`test/mobile-assets.test.js` 20 pass，全量 1289 pass / 0 fail / 2 skipped；壳字节 zh 348 527（预算 349 000，余量 473 B）。
- **计量账**：`ASSET_BUDGET_BYTES` 348_000 → **349_000**。实测壳字节 zh 348 222（css 52 195 + js 296 027）/ en 348 122，净 +250 B。
- **回归锁**：`test/host-restart.test.js` 10 pass／`test/pages-render-fixes.test.js` 29 pass／`test/mobile-assets.test.js` 20 pass；全量 `npm test` 1283 项／1281 pass／0 fail／2 skipped。

**预载会话点进去免全量 + 读会话时列表保温预载 + tails 冷行一次强刷（0.4.49）**（⏳ 待重启生效：`lib/pages.js` 与 `lib/bridge.js` 都属宿主装载面，手机要完全关闭重开才拿得到新壳。用户 m00002「已经预载的会话，点进去还要加载消息」）。

- **点进预载会话不再付全量**：主页预载尾包画出来后，旧写法不给快照盖时间戳 → 60 秒「刚看过」判据恒假 → 每次点开仍发一次全量历史读。现在画出即盖章，返回列表再进来同样免读。
- **进会话至少一屏**：尾包只带最后 ≤8 条记录，旧写法把「还有更早」标志留成假 → 「补满一屏」的循环直接不跑。现在包画出即声明有更早，一屏由既有的补屏循环负责，翻到头由服务端判定，不会无限拉。
- **读会话时别的会话跑完也预载**：列表保温并入既有的 60 秒一条链（不新增第二个轮询，m02338）：静默档只更新背后列表与首屏行的包；正在读的会话不敲（流是真相源），**被折叠的会话照旧永不预载**（m02327①「折叠的点开再加载」）。
- **桥侧冷行救活**：`session.tails` 的目录缓存 10 秒一跳，桌面新建的会话在窗内拿不到游标，旧写法判死刑、点开必付全量；现在每批最多一次强刷补目录，强刷仍无游标才落标记。手机侧有界重试封顶，无望行不会反复敲。
- **取数口径未动**：尾包仍是 8 条记录，不加更宽档——预载只管「点进去不空白、直接看到最后几条」，满屏补齐由点开后在真实屏幕上量的既有的补屏循环做。
- **壳预算**：zh 347 972 / en 347 872（css 51 945 + js 296 027），预算 348 000 **余量仅 28 B**——本批新注释已按预算瘦过三轮；下一笔壳增量必须先挤注释或用户拍板放宽（肥肉清单见 `test/mobile-assets.test.js` WP1 注记）。
- **回归锁**：`test/landing-tails.test.js`（behind-chat 行为档 + 接线钉：盖章/有更早/静默档三连/一条链/进门重挂）、`test/session-tails.test.js`（冷行一次强刷 + 热批次不付强刷反例）、`test/nav-reload.test.js` E 档与 `test/stream-watermark.test.js` AC-D1b 同步改钉。四条反向变异各自转红（详见 commit `353a4ab` 消息体）。全量 `npm test` 1283 项／1281 pass／0 fail／2 skipped。

**Pocket 名字统一：页面上一律叫产品名 `Pocket`**（用户 2026-10-17：「名字都统一吧」；⚠️ 已随 2026-10-17 20:51:42 重启上线——运行桥 `V=pocket-31f8c824b374`＝当时磁盘态）。

- **桌面入口名**：`client/client.js` 的 `label` 小写 `pocket` → `Pocket`（中英同串，与 `frameTitle` 一致）。原先入口写小写、手机页指引却让用户去找「pocket」窗口，两处口径不一致。
- **手机配对/重连页**：`连接 DSH` → `连接 Pocket`、`重新连接 DSH` → `重新连接 Pocket`（en `Pairing DSH` → `Pairing Pocket`、`Reconnect DSH` → `Reconnect Pocket`）。
- **找不到桌面端时的失败提示**：`暂时无法连接桌面端，请确认 DSH 正在运行。` → `……请确认 Pocket 正在运行。`；`暂时无法连接桌面端，请先启动 DSH。` → `……请先启动 Pocket。`（en 同步）；手机壳 `openFailed`「Pocket 打开失败，请重启 DSH 后再试。」→「Pocket 打开失败，请重启后再试。」——页面本身就叫 Pocket，再让用户去启动 DSH 是错误指令。
- **指引里的窗口名**：`在电脑「pocket」窗口查看密码。` → `密码在电脑的 Pocket 窗口里。`；`请在电脑上的「pocket」扫描新二维码` → `……在电脑上的 Pocket 扫描新二维码`（zh/en 各 6 处，含重连页三处分支与壳内浮层）。
- **顺手一处黑话**：「隧道仍可用／隧道地址仍可用」→「公网通道仍可用」（与桌面页 `tunnelError` 同口径；真要操作 Cloudflare 的固定域名面板不动）。
- **一处事实性修正**：`暂无工作区，请先在 DSH 中创建第一个工作区。` → `……请先在 Pocket 里创建第一个工作区。`——主路径是从手机连回来后直接在 Pocket 里建，原句会把用户支到电脑前。
- **故意保留**：`DSH Pocket` 品牌字（品牌名，不是指代）；`桌面端`（既定术语，手机壳同用）。
- **壳预算**：本批全在壳页文案里，实测 zh 346 917（css 51 945 + js 294 972）/ en 346 817，相对上一条基线净 +905 B，已贴 347 000 上限 ⇒ **不放宽到「大一些」，只记账到 348 000**（余量 ~1.1 KB）。肥肉清单实算：三份 locale 文案表重复约 12 KB、样式串约 10 KB，属独立瘦身任务。
- **回归锁**：`test/client-i18n.test.js`（入口名与 `openFailed` 字面）、`test/pages-render-fixes.test.js`（配对页 `<h1>`）、`test/pin-field-width.test.js`（「密码在哪」四条措辞锚点）、`test/mobile-assets.test.js`（预算记账）。全量 `npm test` 1269 pass／0 fail／skipped 2。

**Pocket 电脑端页面文案顺写：去极客黑话、统一产品名口径**（⏳ 待重启生效：`lib/pages.js` 属宿主装载面）。

- **产品名口径**（沿用既有规则：原「手机连接／DSH」位一律写产品名 `Pocket`，中英同串不翻译）：`manageHint`「这台手机当前已连接到 DSH。」→「这台手机已连上 Pocket。」／`Your phone is connected to Pocket.`。
- **网络黑话改白话**：`tunnelError`「隧道建立失败：」→「公网通道没打开：」（与「正在开通公网通道」同口径；「隧道」只留给固定域名面板那种真要操作 Cloudflare 的语境）；`clawbotStatusReady`「通道就绪」→「已接通」；`clawbotStatusNeedMsg`「需在微信发任意消息激活」→「在微信回一句话即可接通」；`clawbotActivated`「授权成功！请在微信中向机器人发送任意文字（如发“1”）以激活通道…」→「授权成功。在微信里随便回一句话，就接通了。」（删「机器人」「激活通道」与举例）。
- **公网同意卡去「暴露」**：`risk`「此页面通过公网隧道暴露，任何拿到链接的人都可能打开它。请确认你了解这一风险后继续。」→「这个页面走的是公网链接，任何拿到链接的人都能打开它。确认明白再继续。」；`agree`「我理解此页面经公网暴露，存在被他人访问的风险」→「我明白这条链接别人也能打开」。风险信息一字未减，只换说法。
- **运维口吻改人话**：`devFingerprint`「指纹」→「设备标识」／`Device ID`（「指纹」易被读成手机指纹解锁）；`devCredExpiry`「凭证到期」→「连接有效期」；`devPermBadge`「通道权限：{v}」→「访问范围：{v}」。
- **故意不改的**：「桌面端」是全仓既定术语（手机壳 4 处同用，改要连壳一起动，超出本批范围）；`lanRisk`「可能被听到」精准且最省字；`diagProbeHint` 全文（写代价是产品决策，一个字不软）；固定域名面板 `tunnelIngressHtml`（只有要配 Cloudflare 固定域名的人会打开，`127.0.0.1`／桥端口／`online` 行正是操作坐标，顺成人话反而没法照做）。
- **生效路径**：桌面页与同意卡都是 SSR 文档/静态页，**不进手机壳字节预算**（`ASSET_BUDGET_BYTES` 不变）；改的是 `lib/pages.js` ⇒ 需重启宿主才上线。
- **回归锁**：`test/pages-panel-ux.test.js` 的同意卡 zh/en 两条锚点同步；该文件六档 + connected-devices + device-panel-exec + pages-input-hardening + diagnostics-panel + desktop-connected-unlocked 合跑 **62 pass／0 fail**。

**重启回执改文艺文案、确认卡一行一条、告别页四行楚门台词、点重启改为转圈**（⏳ 待重启生效：`lib/pages.js` 三处属宿主装载面。`scripts/dsh-revive.ps1` 是计划任务现读，推送文案落盘即生效，不需重启）。

- **推送回执（成功分支）**：标题 `Curiouser and curiouser!`、正文 `Pocket 一级准备，任意回复获得本轮公网地址。`。文艺只给成功那一次——**未完全就位分支保持白话**（`DSH 已重启（未完全就位）` / `gui=… bridge=…，请回电脑看一眼。`），别让爱丽丝台词挡住「回电脑看一眼」这个动作。锁屏只显示标题一行，故正文首词是产品名 `Pocket`；「回一句话＝拿地址＝续额度」三件因果留在正文里。
- **重启确认卡**：原三条长句 `<li>` 拆成**八条一行一个事实**（zh/en 同步），字面随推送标题同步。
- **中间态**：点「确认重启」后不再显示文字「正在重启…」，`status` 挂 `.host-spin` 转圈（复用现成 `@keyframes headSpin`）；`hostRestarting` 文案键降级为 `aria-label`，读屏仍可听见。
- **`GET /bye` 告别页**：`h1` 从「已受理，再见」换成《楚门的世界》四行 `in case i don't see you / good afternoon / good evening / and good night`（`h1.farewell span{display:block}`，中英同串不翻译）；原第二个 `<p>` 里的 `<br>` 拆成三个独立 `<p>`，不再写死推送标题字面。仍零 `<script>`。
- **不改成文艺的**：`/reconnect`、`/disconnected`、SW 离线页——那三处是故障叙事，不是告别。
- **计量账**：`ASSET_BUDGET_BYTES` 346_000 → **347_000**。实测壳字节 zh 345 772 → 346 012、en 345 668 → 345 908（净 +240 B：css +191／js +49）。确认卡 `<li>` 拆行与 /bye 四行属 SSR 文档，不进壳计量。
- **回归锁**：`test/host-restart.test.js`（八条 `</li>` 逐行断言／`host-spin` 存在且仍带 `L.hostRestarting`／/bye 四行 + `doesNotMatch /<br>/`／`任意回复` 字面）＋ `test/mobile-assets.test.js` WP1 抬额。`node --test test/host-restart.test.js test/mobile-assets.test.js` = 30 pass／0 fail。
- **文档同步**：`docs/GUI-CHECKLIST.md` 第 14／37 条六处旧字面逐条替换（每条命中数=1 才改）。

**Pocket 手机端深色模式消除夜间纯白刺眼，锁定系统设置且不损白天易读性**（✅ 2026-10-17 12:37:47 重启已带上线：运行桥 `V=pocket-4b779940b1ee`＝磁盘同式实算，运行态＝磁盘态）。

- **根因＝深色模式下反转变量导致主操作按钮变成纯白高亮圆盘**：在白天模式下，主按钮使用 `background: var(--ink)`（黑底 `#18191c`）与白图标；而在 `@media (prefers-color-scheme: dark)` 下，`--ink` 翻转为 `#f5f5f6`，导致输入框右下角 44px 发送按钮、停止生成按钮、展开后的会话设置齿轮、提问确认弹窗提交按钮、选中控制点、Toast 气泡及重连页大按钮全部变成刺眼的实心大白块，夜晚暗光环境下眩目严重。
- **改法＝夜间主交互收敛至品牌色与暗色卡片，白天极简黑白保持零漂移**：
  - 发送按钮启用时改为品牌蓝（`var(--brand)` / `#6f86ff`）底加白箭头；禁用状态（刚进入会话/输入框为空）显式覆盖为深色暗板底色（`var(--surface)` / `#202023`）配暗线（`var(--line)`）与浅灰弱化箭头（`var(--muted)`），彻底消除刚进入页面时的半透明白炽圆盘眩光及打字激活时的强烈频闪；
  - 停止生成按钮改为深色卡片微渗危险红底（`color-mix(in srgb, var(--danger) 16%, var(--card))`）与红方块，柔和表达终止动作；
  - 会话设置展开态改为 hover 底配品牌蓝边框；
  - 提问弹窗提交按钮统一收敛至品牌蓝底白字，选中项控制点改为品牌蓝；
  - Toast 浮层提示改为深灰质感微光胶囊（`#232428`）；
  - 移动端重连页面主按钮在深色模式下同样收敛为品牌蓝底白字；
  - 纯 CSS `@media (prefers-color-scheme: dark)` 随系统自动切换，不设任何白天/黑夜模式开关；白天模式规则 100% 保持原有黑白高对比。
- **回归锁**：`test/pages-render-fixes.test.js` 新增 `DM-1` 单测，覆盖深色启用/禁用覆盖规则、提问提交按钮与白天基准规则；全量测试集 100% 通过。
- ✅ 2026-10-17 12:37:47 重启已带上线（运行态＝磁盘态，见本节首笔）。

**局域网 IP 解析彻底移除 PowerShell 进程调用，消除桌面黑色控制台闪窗**（✅ 2026-10-17 12:37:47 重启已带上线：运行态＝磁盘态；Windows PowerShell 日志 `Get-NetIPAddress` 持续 0 条）。

- **根因＝Windows 环境下拉起 CUI 控制台子系统导致瞬时闪窗**：`preferredLanAddress` 在刷新网卡时通过 `execFile` 调用 `powershell.exe -NoProfile -Command Get-NetIPAddress...`。在 Windows 10/11 GUI 宿主下，系统底层 `conhost.exe` 即使指定 `windowsHide: true` 也会在初始化瞬间闪现黑色终端窗口，且每次冷启 PowerShell 耗时达 2 秒。
- **改法＝改用 Node.js 原生 `os.networkInterfaces()` 内存级解析**：实现 `findLanAddress(interfaces)`，直接过滤 `VIRTUAL_ADAPTER_PATTERN`（WSL/Hyper-V/VMware/Docker/Tailscale 等），首选真实物理网卡私网 IPv4，在全虚拟环境下兜底回退任意私网 IPv4。耗时从 2000ms 降至 0.05ms，彻底零子进程。保留 `parseLanAdapterLines` 保持历史单测兼容。
- **回归锁**：`test/bridge-review.test.js` 新增 3 项单测（虚拟网卡过滤、全虚拟兜底回退、进程内执行契约），45/45 全绿；关联测试集 144 绿/0 红/2 跳过。
- ✅ 2026-10-17 12:37:47 重启已带上线（运行态＝磁盘态，见本节首笔）。

**第一次打开手机页不再谎报「连接已断开」**（✅ 2026-10-17 12:37:47 重启已带上线：运行态＝磁盘态；服务端 `GET /` 无 cookie 实返 h1/title 均为「连接 DSH」，无「连接已断开」）。

- **根因＝「没连上」与「曾经连上又掉了」共用一套文案**：未授权落地页（`lib/bridge.js:4520-4538`）
  历来一律渲染 `renderMobileReconnectPage`，而那一页写死了 `title:'重新连接 DSH'` / `heading:'连接已断开'`。
  **首次访问的手机什么都没丢**，却先看到一句「连接已断开」——这是观感误导，不是真实掉线。
- **改法＝按「是否持有活会话」分流**：桥侧新增 `const fresh = !this.mobileSessionActive(request)`
  并把 `fresh` 传进 `renderMobileReconnectPage`；页面据此选文案——`fresh` 时标题/大标题为
  「连接 DSH」/「Connect to DSH」，否则维持「重新连接 DSH」/「连接已断开」。**真实掉线分支的文案
  逐字节不变**（`test/pages-render-fixes.test.js` 的 `T5b` 两头都钉住：`fresh` 不含「连接已断开」，
  返回的老设备仍必须含）。
- **副作用审查**：`mobileSessionActive` 会 `touchDevice`（LRU 重插）＋`noteDeviceSeen`（刷 `lastSeenAt`），
  但它在 `!token || !this.sessions.has(token)` 时**先返回 false**，故对真正的首次访问者零副作用；
  仅当请求已持活会话却仍走到未授权分支时才会刷新时间戳，语义上无害（该设备确实刚活动过）。
- **回归锁**：新增 `T5b a first-time phone is not told its connection was lost`。该文件 **24 项全绿**；
  字符层全量 **1243 项／1241 绿／0 红／2 跳过**。
- ✅ 2026-10-17 12:37:47 重启已带上线（运行态＝磁盘态，见本节首笔）；重启后手机页须完全关闭重开拿新壳。

**工作区头不再把「还有人在跑」误报成「已完成」**（用户口述 m00001：「如果工作区里面正在进行的几个对话中
有一个对话已经完成，就会把这个工作区的状态定为已完成」「只有当工作区里面任何一个对话都已经完成了，
并且不在这 3 个状态里面时，才会显示"已完成"」）。

- **根因＝头部兜底只看最新那一行**：徽标为空时，头画的是 `taskState(tasks[0])`——`tasks` 按置顶／
  `sortAtOf` 降序，`tasks[0]` 就是最新一行。于是「最新那行刚跑完、工作区里另一行还在跑」＝绿色对勾，
  而此刻该工作区根本没完成。**四态里 error／待回答／新完成本来就走徽标（与运行态无关），漏的正是
  「正在进行」这一态**：它不在 `wsFlagOf` 的返回值里，只作为兜底 glyph 存在，而兜底又被最新一行绑死。
- **改法＝把兜底从「最新一行」改成「整个工作区」**：新增 `wsRunning(tasks)`（任一行 running）与
  `wsGlyphOf(tasks)`——**只要还有一行在跑就画 running，绝不许画 done**；全为 done 才画 done；
  其余混态回落 `states[0]`（＝旧行为，逐字节不变）。运行态**不吃 `isSessionUnread`**：未读与否是
  「要不要提醒你」，与「还在不在跑」无关——若吃，一个已读的 running 行会让头回落成绿勾，缺陷原样复现。
- **不做第四态「需要提权」**：宿主 `session/list` 行 schema 实测只有 `agentAvailable/sessionId/updatedAt/
  running/blank/parentSessionId?/origin?/cwd?/projections`，**没有任何待审批字段**；手机 mux 转发表列了
  `user-questions/request`，**没有 `approval/request`**（asar 里那 6 处 `awaitingApproval` 全属 Cordis
  动态插件面板的 run 状态，与会话行无关）；`permissions` 投影是**当前权限档名**（如 danger-full-access），
  不是「有个审批在等你」。⇒ 该态要落地必须先改宿主（把 `approval/request` 接进转发面或加轮询 RPC），
  违反硬约束 7「手机端只走 pocket 源码、禁改宿主文件」。**已在 L 表注释里写明这条结论**，不留错觉。
- **回归锁**：`workspace-head-notices.test.js` 新增两条——`one busy row anywhere stops the head claiming
  the workspace is done`（已读＋最新行 done＋别处 running ⇒ 头必须是 `ws-last is-running`，且不得出现
  `ws-last is-done`）与 `a workspace of only blank chats does not claim completion either`（全 blank
  工作区不许因 `every(done)` 之外的新兜底而误画绿勾）。三个测试沙箱的 extract 名单同步加
  `wsRunning`/`wsGlyphOf`（`workspace-head-notices`／`pages-scroll-anchors`／`subagent-session-dom-assertions`）。
- 字符层全量 **1243 项／1241 绿／0 红／2 跳过**；头徽标专项 22 项全绿。
- ✅ 仍在运行态（2026-10-17 12:37:47 重启后复核运行态＝磁盘态）；重启后手机页须完全关闭重开拿新壳。

**有些会话点进去一直完全没有消息**（用户口述 m00003「点击主页中显示的会话，消息同步加载需要很长时间」，
m00274「有些对话点进去好像完全没有消息，是不是还有一个什么总量的受到限制了」）。

- **根因是「失败的预载被当成成功记下了」**：主页每轮渲染都会给可见行批量预载尾包，回包处理却是
  **先** `tailArmedAt[id]=stamp`（记下「这个会话在 updatedAt=X 时预载过」）**再**判 `hit.error`。
  而重新预载的唯一条件正是「行的 `updatedAt` 变了」——所以一次失败（隧道瞬断、宿主翻页失败）
  就等于该会话**此后永久不再预载**，每次点开都是空屏＋骨架，等那条慢的全量历史。用户那句「完全
  没有消息」不是错觉，也不是「总量受限」，是这个永久失效。
- **改法＝把盖戳挪到成功之后**，失败不再冒充答案；成功的会话行为逐字节不变。
- **配套加了 `TAIL_RETRY_MAX=3` 的有界重试**：只挪戳的话，一个永远拉不到的会话（桥侧 `no-cursor`／
  `unknown` 是常态标记）会被每 60s 一次的主页后台刷新反复重试，变成长跑。故失败另记 `tailFailed`
  计数，到上限停手；行的 `updatedAt` 一变即清零重来——有新内容就值得再试一次。
- **回归锁**：旧锁 `per-row markers do not poison the cache or the clock` 原本把缺陷钉成了契约
  （断言失败行 `tailArmedAt.a===1`，注释写「仍然盖戳，所以主页不会反复敲」），已反向改写；
  新增 `a permanently failing row is retried, then left alone until its stamp moves` 钉住
  「重试→封顶→戳动才重试」三段。字符层全量 **1241 项／1239 绿／0 红／2 跳过**。
- **反向注入**：把旧顺序（盖戳在前）写回源码，两条锁同时转红，恢复后全绿——锁确实能抓到缺陷。
- **真机行为级 A/B**（`tmp/20261016-tail-latency/` 多会话探针，s-B 的尾包第一次失败、第二次成功）：
  旧码两次渲染后 `armed` 含 s-B 而 `cached` 不含 ⇒ 点开 `n=0` ＋ 3 骨架；修复后第二次渲染把 s-B 收进
  缓存 ⇒ 点开 **+25ms 即 `n=8`**。两侧均先重启探针服务再测（壳在 import 期被读进内存，不重启测的是旧码）。
- **未动的相邻缺陷**：8 条预载包只够画满一屏（实测 `scrollHeight=clientHeight=844`，全量后 2072），
  补齐仍要等那条慢的全量（8→30）。这属加载量口径，用户 m00002② 立过「不能造成非常大的净加载量」
  的红线，本次只修「永久失效」，不碰加载量。
- ✅ 仍在运行态（2026-10-17 12:37:47 重启后复核运行态＝磁盘态）；重启后手机页须完全关闭重开拿新壳。

**首条消息不再「点了没反应」**（用户口述 m00003「Pocket 一个会话第一次发送消息的时候会连续发送两次」，
随即更正 m00006「第一次会话发送消息以后会有很长的延迟，大概有 1 秒钟。这时候如果用户没反应，因为完全不知道
消息发没发出去，多点一次就会重复发送。所以，关键是在这个延迟上面」）。

- **反馈搬到了第一个 `await` 之前**：旧 `send()` 把清输入框、画乐观气泡、翻转发送钮全部押在
  `await ensureSession()` 之后——草稿态那条链要走 `session.create` ＋ `applyDraftPending`（预设/模型/权限
  最多 3 次额外往返）才轮到 UI，期间屏幕一动不动，用户只能靠再点一次确认，于是两次 `session.prompt`。
  现在同步段先落 `agentRunning=true` ＋乐观气泡 ＋清空正文，再进 await。
- **`sendBusy` 闩锁**：`send()` 入口 `if(sendBusy)return`，`finally` 解锁——跨 `await` 的连点不再能叠出第二次发送。
- **`owner` 捕获移到 `ensureSession()` 之后**：旧写法在草稿态捕获到 `null`，两处 `activeSession!==owner`
  守卫永远不成立（发送成功分支的 `clearSentDrafts()`／`loadHistory(false)` 会整段跳过）。现在守卫成对：
  成功分支比 `!==`，回执分支比 `===` 才动气泡与运行态。
- **失败路径拆成两层 catch**：`session.create` 失败（外层）撤气泡、解运行态、`stopPendingSend()` 撤乐观行标记、
  把正文放回输入框；`session.prompt`／`command.execute` 失败（内层）只在「读者还在这条会话上」时回滚。
  新增 `stopPendingSend(id)`——乐观 running 标记是有期限的谎，真失败时手撤。
- 副作用：`optimisticPrompts` 的 echo 清扫在乐观上屏时也要跑（`messagesWithOptimistic(...,true)`），
  否则稍后到达的持久副本会在乐观气泡旁边再画一个；预检拒绝（附件未传完/图片草稿未完成）从静默 return
  改成 `showError('chatError')`——窗口关在 await 之前以后，静默返回就等于「点了没反应」。

验证覆盖＝字符层全量 **1238 项／1236 绿／0 红**（新增 `test/pages-send-latency.test.js` 6 项钉顺序而非措辞；
反向注入 HEAD 旧 `send()` 实测 6 项中 5 项转红，恢复即全绿）。**外壳预算抬额 338 000 → 342 000**
（本线实测 zh 339 875＝css 50 598＋js 289 277，相对 HEAD 只 js +2 018 B、css 零增长）。
渲染层与实机层未覆盖 ⇒ 「连点是否真被闩住、首条气泡是否即时出现」须真机走查。✅ 2026-10-17 12:37:47 重启已带上线（运行态＝磁盘态，见本节首笔），
重启后手机页须完全关闭重开拿新壳。

**权限栏不再显示横杠、也不再整栏无高亮**（用户真机口述 m00691/m01512「模式和权限…显示的都是个横杠。
点开模式后 standard 是高亮的，而点开权限后，没有任何高亮」；✅ 与上面那笔同批，已随 2026-10-17 12:37:47 重启带上线）。

- **根因不是「你没有权限值」，是页面把宿主已经给出的答案扔了**：`permissionPresets.catalog`
  除了选项表还答 `defaultPreset`（宿主 `dsh-permission-presets` 的 `catalog()` 同时返回
  `{options, defaultOptions, defaultPreset}`），页侧只取 `options`，丢掉 `defaultPreset`。
  新建会话的权限投影还没落回来时，`permissionCurrent()` 三级回落全空 ⇒ 返回 `''` ⇒
  「查看当前权限」行渲染成裸破折号，且**没有一行能匹配上高亮**。
- **`permissionCurrent()` 末级回落改用宿主默认**：`…流投影 → 会话行 → permissionDefault`。
  「还没钉」时宿主默认就是真相，不再谎报「没有默认值」。
- **破折号这个文案本身删掉**：无值时改说「正在读取权限预设…」（`L.plusPermissionLoading`）——
  横杠读起来像「你没配过权限」，这正是真机看到的那一幕。
- **抽出 `renderPermissionSheet(options)` ＋ `refreshPlusPermission()`**：抽屉开着时权限投影/事件
  落地会即时重画，不再保留打开瞬间那个空值（原来「整栏无高亮」能在每个新会话的头几秒里活下来）。
- **设置面板「模式」字段同款兜底**：`renderSessionSettings` 的 preset 取值在无 `currentPreset`
  时改回落 `presets.find(item=>item.isDefault)`（与 `pickRows` 的三级兜底对齐），
  免得两处对「当前是哪个」给出不同答案。
- 副作用：`fetchProjectionsNow` 多调一次 `refreshPlusPermission()`（无 `plusView==='permission'` 时立即返回）。

验证覆盖＝字符层全量 **1239 项／1237 绿／0 红／2 skip**（新增 `NF-1b` 四项：宿主默认回落、
catalog 存 `defaultPreset`、`renderPermissionSheet` 不再出裸破折号；`NF-1` 的两条断言由
「空描述槽 + 破折号」反转为「零破折号 + 说出正在读取」）。**外壳预算未抬**：本线实测
zh 341 553 B（css 50 598 ＋ js 290 955）／en 341 445 B，仍在 `ASSET_BUDGET_BYTES = 342_000` 内
（余量 447 B，比上一版 2.1 KB 紧）。渲染层与实机层未覆盖 ⇒ 「横杠是否真的不见了、危险档是否亮起」
须真机走查。

**六个报障 bug 的修复（0.4.50）**（⏳ 待重启生效：`lib/pages.js` 属宿主装载面，手机要完全关闭重开才拿得到新壳；
生效判据＝运行桥 `GET /sw.js` 的 `V=` 不再是 `pocket-8a85c83c0205`，盘上实算基线 zh `pocket-2288196767f0` /
en `pocket-2074815f30a5`。施工账 `docs/交付报告-六bug修复批-20261019.md` 与 flow 卡
`2026-10-19-pocket-six-bugs-20261019` 归档件）。

- **发完消息秒退回主页不再留下空会话**：根因是 `send()` 在 `await ensureSession()` **之后**才回读共享的
  `activeSession`——草稿态补发 preset/model/permission 是 1~3 个串行 RPC（真机实测窗口 1.19 s），
  这段时间里返回主页的手势已把 `activeSession` 清成 `null` ⇒ 发出 `sessionId:null`，宿主以
  `gateway/input-invalid` 拒收，而 `session.create` 已成功 ⇒ 用户看到的是一个**完全空的会话**。
  修复＝owner 取 await 的返回值本身（`const owner=activeSession||await ensureSession()`），不再回读共享变量。
- **草稿设置不再冒充运行中会话的实况**：草稿缓冲（`draftPending`）原先无条件优先于投影，`draftSetModel`/
  `draftSetPreset`/`draftSetPermission` 只写缓冲不发 RPC，却弹与真切换同一句「会话设置已更新」。现在三个读取点
  都加 `!activeSession` 门（运行中会话一律以投影为准），草稿点选改弹「已选定，会话开始后生效」；`draftSetPreset`
  不再覆写运行中会话的 `currentPreset`。
- **排队消息不再被画进会话框**：`send()` 的乐观记录带上 `queued` 标记，`messagesWithOptimistic` 遇排队项跳过
  ——排队消息在宿主侧是 `agent/inbox/spliced` ＋ `values.inbox['next-turn']`，尚未成为转录事件，
  把它画成气泡等于把「未投递」呈现成「已投递」。
- **打字时发送钮顶掉停止钮**：`cancel.hidden=!agentRunning` 改成 `!agentRunning||canSend`——有输入或待发附件时
  两钮并存，flex 挤压把发送钮挤向左侧，拇指一偏就按到停止。
- **有排队消息时页面能滑动**：队列坞/待办坞是 `pointer-events:none` 的 fixed composer 的直接子元素却各自开了
  `auto`，屏幕下方 131~168 px 那条带（视觉上只是转录区的预留空白）被坞吃掉，坞内无可滚范围、composer 又不是
  `#messages` 的祖先 ⇒ 真·滑不动。现在坞容器放行、只有按钮与编辑框开回 `auto`，列表真溢出时才自取滚动权。
- **提问弹窗可以收起**：原先只有 ×（真取消该次提问），没有非破坏性出口。现在标题行加收起钮，收起后能继续看
  下方会话；底部净空由页面自量的 `--question-h` 承担（不写死 px，避免输入框长到上限时失准）。
- **壳预算**：本批把 `ASSET_BUDGET_BYTES` 抬到 **356 000**（354 000 → 356 000，六 bug 的 CSS/JS 增量）；
  实测 zh 354 914 B / en 354 831 B，余量 1 086 / 1 169 B。
- **验证**：全量 1306 项 / 1301 绿 / 0 红 / 2 skip；真 Edge（390×844）几何台 BUG-5 穿透场景**修前红 8 条、
  修后 0 条**；BUG-3/4/5/6 四组变异各自恰红恰复位。**真机走查六条未做**（用户重启宿主并完全重开页面后才验）。

## 0.4.47 — 2026-10-16

**预取包不再压成一行——点进会话先有内容，不等全量**（用户口述「如果一开始已经把显示出来的对话最后几条消息加载了，
为什么点进会话不是秒开」（m00925）、「这 8 条应该是一个单独的文件包，并且要有上限，消息按照时间从最新往后排，排到上限
就不排了」、「关键不是消息多准确，而是不能空白、不能等加载，有东西然后一条一条吐出来」（m01005））。

- **`session.tails` 的 8 条记录真的存下来了**：桥早就把每个会话最后 8 条完整消息记录翻回来，页侧却在 `tailCache.set`
  那一步只留 `{text,time}` 一行、把记录当场丢弃——所以点进会话仍要等一次公网往返。现在整包按 `seq` 从旧到新排、从最新
  往回取到 `TAIL_PACK_MAX=8` 为止（排到上限就不排），随 `{text,time}` 一起进缓存。
- **首屏多了这条路**：`paintInstantSession()` 在 sessionCache 未命中（冷开、或已被驱逐）时改用预取包先画，屏幕不再
  是骨架。它只并进尾部缓冲、不写 `sessionCache` 的 `at` 戳，所以「新鲜缓存免全量读」那道门照旧关闭——`session.history`
  与实时帧回来按 seq 去重，一条条接在后面补全（不做一次性整屏替换）。
- **净加载量有账**：包缓存新增 `TAIL_CACHE_MAX=64` 上限，按插入顺序驱逐最旧的包；`tailArmedAt` 的时间戳不跟着清，
  被驱逐的包不会立刻重拉（`updatedAt` 变了才重新 arm）。载荷条数与 RPC 次数一字未改——同一批数据，此前用完即扔。
- 主页行仍不显示尾消息文本（2026-10-14 m02164①「预取不显示」口径不变），`tailTextOf` 与行时钟台账照旧。

验证覆盖＝字符层（全量 1232 项／1230 绿／2 skip；landing-tails 新增包形状与上限档、stream-watermark 新增 AC-D1b/D1c
首屏分支档）。渲染层与实机层未覆盖 ⇒ 冷开/首点是否真不空白、补全是否逐条吐出属观感项，须真机走查（含 0.4.46 的
两条与旧 22–29 条）。**欠重启宿主**，重启后手机页须完全关闭重开拿新壳。

## 0.4.46 — 2026-10-15

**首屏跳变与返回主页刷新两条**（用户口述「第一次登录有 5 步，进去后主页会话仍会跳变——先两三条，再跳成 24h＋置顶全量」、
「返回主页一刷新整个页面都变了，刷新就在背后偷偷刷新呗」）。

- **冷开首屏一次画完整**：boot payload 原先只带最新 12 行（`LANDING_LIST_ROWS`），随后 `bootListPartial` 触发后台补拉
  全量列表，于是先看到一小片、再跳成「24h＋置顶」全量。现在两条冷开路（`/api/boot` 与内嵌 document）都带**全量会话行**，
  首屏即终屏；补拉路径保留为兜底安全网。代价是 document 更重、冷开更慢——用户明确接受（「4 个转圈圈各干一个转圈圈的事儿」）。
- **返回主页改为后台静默刷新**：原先离开会话要 `await refreshList(false)` 等三个 RPC 落地才放手，还带 400ms 转圈底噪，
  表现为「一刷新整个页面都变了」。现在改成 `resumeOnReturn(true)` 静默后台读：列表已在屏幕上，新数据到了且真有变化才重绘，
  期间可继续点；若读回前又点进别的会话则放弃重绘。转圈与错误横幅只属于主页右上角手动刷新钮。
- 同树他线改动（`client/client.js`，DSH 侧边栏 Pocket 按钮几何对齐 footer 辅助区基线）随本批一并提交，与本两条无耦合。

验证覆盖＝字符层（全量 1226 项／1224 绿／2 skip；改动同批更新 nav-reload 契约档）。渲染层与实机层未覆盖 ⇒
首屏一次画完整、返回主页无跳变属观感项，须按 GUI-CHECKLIST 真机走查（含旧 22–29 条）。
**欠重启宿主**，重启后手机页须完全关闭重开拿新壳。

## 0.4.45 — 2026-10-14

**手机八问收敛批**（滚动三症状、主页尾消息与刷新收敛、子代理两条、错误红点、会话设置去卡）。

- **进会话滑到底不再跳顶显示「正在加载更早消息」**：三条症状同根——content-visibility 的估算行被真渲染后
   transcript 的 scrollHeight 继续长，浏览器把 scrollTop 钳回界内时**会派发一次真 scroll 事件**，旧代码把它当成
  读者甩到顶的手势，于是中途弹出一页更早消息。现在顶部边缘触发加了 followStream／无可滚范围／写入静默窗三道门，
  并且贴底写入后 120ms×4 重钉到底，浏览器钳位不再把位置抢走。
- **发了消息、退出再进，末尾都停在最新一条**：同一个根（估算高度塌缩导致贴底写入落在半屏）。重钉链跟到布局稳定。
- **主页每个会话带最后一条消息**：会话行现在显示该会话末尾一条消息的文本（≤160 字符）与时间；一次性批量 RPC 拉取
  可见会话（≤30 个、每会话 8 条），`updatedAt` 未变的会话不重复拉，运行中的会话不拉。
- **主页列表按 24h 单一界限收敛**：24h 是「一个会话还算活着」的唯一界限——窗口内全显、带红点、参与预载，窗口外进
  「还有 N 条」。窗口从原来显示 12h／红点 48h 两个值合并为同一个 24h。渲染上限（原先最多 25 行）取消。
- **退回主页不再全量重拉**：桥侧给 session.list 加内容指纹，页侧带指纹重问、列表未变即只回指纹不传整目录；
  页层拿到「未变」保留既有行投影只刷工作区；渲染层同串守卫不重画。
- **子代理胶囊点框外即关**，离开子代理态（返回、切会话、agent-busy 弹回）不再残留只读态。
- **从子代理返回落回父会话**，不再直接丢到主页：历史弹出条目与当前会话不同时判定为真实跳转。
- **错误会话看过即消**：行级红点走既有未读台账（离开会话即盖章），头部「错误」药丸只在未读时挂——会话崩了开新
  会话解决后，旧错误行不再常驻打扰。
- **会话设置面板去卡**：模型/预设/effort 三个列表改为首次展开才生成（原先每次打开都同步把全部 provider×model
  按钮拼进 DOM，打开一次要付两次整份重建）；agentPreset.list 加 30s 桥侧缓存（不再拖慢面板的并行取数）；
  settings.describe 接上已存在的 5s 缓存（列表页每次刷新不再打 Host）。

验证覆盖＝字符层（全量 1211 项／1208 绿／2 skip／1 假红＝session-events 长轮询计时档，单跑 19/19 绿；
壳字节 zh 320 629／en 320 533，预算 322 000 内未抬额）。渲染层与实机层未覆盖 ⇒ 滚动三症状、主页尾消息行、
子代理胶囊交互、设置面板流畅度属观感与真机链路，须按 GUI-CHECKLIST 真机走查（含旧 22–29 条）。
**欠重启宿主**，重启后手机页须完全关闭重开拿新壳。

## 0.4.44 — 2026-10-14

**「+」抽屉里的权限/预设开关与图片发送两条报障**（用户口述「权限开关好像没用，那个+里的，可能整个都没有，
我上传图片也失败」）。

- **草稿态点「+」里的条目不再没反应**：行分发器原本第一句是 `if(!activeSession)return` ——新起草的会话还没物化，
  于是权限、预设、模型、目标、/compact、导出六类条目**整排点下去一个字都不发生**（这才是「可能整个都没有」的实况）。
  现在附件三类（选文件／选图／任意文件）本就不需要会话、照旧直连；其余条目缺会话时先 `await ensureSession()`
  物化草稿再执行原动作（物化失败则静默放弃，错误播报走 ensureSession 自己的通道）。
- **权限切换有了回声**：`/permission …` 走的是宿主命令通道，宿主返回 `{result:{kind,text}}`（成功＝`preset <name>`、
  未知预设＝`unknown preset "x" (available: …)`），此前页面把整个返回丢掉 ⇒ 切成功了和被拒了看起来一模一样。
  现在 error 走错误条、有文本走 toast。
- **当前权限显示出来了**：宿主的 `session.projections` 一直带 `values.permissions.currentValue`（派生出的当前预设名），
  但桥侧的会话行投影白名单只放行 title/todos/modelSelection 三个值，对象形状一律被 `isSmallRowValue` 丢掉 ⇒
  手机上永远读不到。白名单加 `permissions`、`imageLimits` 两个键（形状夹取沿用既有规则），「+」权限抽屉里
  当前项尾缀「使用中」、顶行「查看当前权限」显示当前值（无则「—」）。
- **预设不再被模型目录连坐禁用**：设置面板的禁用判据原先是一条 `!routable||preset&&locked` 连坐式 ——
  模型目录不可路由时把预设字段一起灰掉。现在各字段只按自己的理由禁用（预设＝非空会话或已有待发提示词时锁）。
- **新起草的会话能设预设了**：`ensureSession` 物化草稿时抢先把 `sessionBlank` 置 false，而「可编辑预设」的判据就是
  blank ⇒ 一打开设置面板预设就已锁死。物化不再抢置，改由发提示词/读到 durable 历史的路径各自置。
- **预设名不再谎报**：`currentPreset` 为空或不在目录里时，此前回落到 `isDefault` 项显示，等于给用户看一个没生效的
  名字；现在未知 id 显示其原始 id、没有值显示「—」。内置名表补 `ptc`（本机真实预设 id，表里原本只有 `code`）。
- **图片读取失败看得见、能重试**：图片草稿的 FileReader 只有 onload 没有 onerror（文件通道两者都有），读盘失败
  （权限被撤、文件已移走、超大 HEIC 解码失败）就永远停在无缩略图的死卡上。现在 onerror 置 failed＋显示原因，
  失败卡片按文件卡片同型带「失败，点此重试」与可点重试；重试走同一套体量判据。
- **附件上限不再永远吃保守兜底**：`imageLimits()` 读 `streamProjections.values.imageLimits`，而 `fetchProjectionsNow`
  此前从不写 `streamProjections`（只有 SSE 快照写）⇒ 手机重连/切会话后拿不到宿主真上限，一直按兜底 10 MiB 夹附件。
  现在主动拉投影也写这份快照（`closeSessionStream` 的复位语义不变）。

验证覆盖＝字符层（全量 1180 项／1178 绿／2 skip／0 红；壳字节 zh 312 947／en 312 851，预算 316 000 内未抬额）；
渲染层与实机层未覆盖 ⇒ 权限抽屉回显、草稿态可用性、图片失败卡属观感与真机链路，须按 GUI-CHECKLIST 第 28–29 条真机走查。
**欠重启宿主**（0.4.43 批同此一次了结），重启后手机页须完全关闭重开拿新壳。

## 0.4.43 — 2026-10-13

**用户口述七项一次性修掉**（「统一排查先找到原因」→「其他你就开始进行吧」）：会话设置卡顿、
↑ 箭头飘走与目标重设计、子代理折叠条占整行、秒退回主页状态不更新、会话置顶透传、会话错误
不显示、停止钮变发送钮。

- **会话设置不再卡**：点「会话设置」打开模型/预设面板，此前每次都要等桥侧转发宿主
  `session/modelCatalog` 的 ~1.4s 往返（新老会话都卡），且面板在等待期间控件全灰不可点。
  桥侧现在给 `session/modelCatalog` 加了与 `session.list` 同级的缓存（30s TTL、SWR、切模型
  后失效重取、开机预热），第二次起面板 ≤50ms 可交互；首次冷开仍如实等（不再有「加载中」
  壳等了又等）。
- **↑ 箭头改跳「最后一段回答」而非「上一条提问」**：用户原话「我的意图应该是要回到 AI 发的
  最后那段总结性的话之前…不想往上翻」。此前 ↑ 找最近一条用户提问，但 `content-visibility`
  估算高度（120px）与真实高度（1:3.07）脱钩，加上 `settlePromptJump` 是死代码（首测 delta=0
  即停链、从未排一次重瞄）、一次 `innerHTML` 重绘把目标行搬走视口、250ms 程序滚动盲区无还原
  ⇒ 点几下就「飘」。现在 ↑ 找「视口上方最近一段 assistant 正文」（跳过过程折叠卡），落点重瞄
  改为每轮无条件排一次（不再因 delta≤2 早退），找不到目标则不动作（不 fallback 回提问）。
  ①-②③属观感层 ⇒ 须真机走查（GUI-CHECKLIST 第 22 条）。
- **子代理折叠条改成右上悬浮胶囊**：此前 `.subagent-bar` 是会话区 flex 列里的 `flex:none` 实块，
  占一整行。现改为 `position:fixed` 右上角胶囊——折叠态只剩圆点（运行中蓝/出错红）＋计数，
  点开才弹出浮层。**顺序倒置**：电脑端因鼠标好拿，最活跃的按 `createdAt` 正序排在最下；手机
  点开应最先看到刚启动的，故渲染前按状态（运行中带最上→出错带→闲置）再按 `createdAt` 新→旧
  倒序。只读子代理会话视图不显示胶囊（用户裁定）。③属观感层 ⇒ 须真机走查（GUI-CHECKLIST 第 23 条）。
- **秒退回主页也能显示「正在进行」**：发消息后秒退回工作区页，此前因桥侧 `cachedSessionList`
  有 10s TTL，回主页读到的是发送前那批行（多为绿勾「已完成」），要等下一次刷新才翻成「正在进行」。
  现在发消息时给该会话行打乐观 `running:true` 标记（短信任窗 `SEND_TRUST_MS=30s`，长过桥 10s
  缓存的两倍余量）；宿主行一旦自己说 running，标记立刻作废；超信任窗后采信宿主「没在跑」；
  当前正在看的那个会话不打标记（那里直播事件流是真值）。④属观感层 ⇒ 须真机走查（GUI-CHECKLIST 第 24 条）。
- **会话置顶透传到工作区页**：电脑端的「会话置顶」此前在手机上完全看不到——桥侧 follow 帧本就
  带 `pinnedSessionIds`，但 `projections.js` 的 pinned 分支把它丢了（注释自认「no projection」已过时）。
  现接住该字段，主页列表把置顶会话分区提到前面（分区内仍按最后消息时间排，与桌面 sidebar 一致）；
  每行尾部加图钉钮（13×13 stroke SVG，置顶态填实），点击调 `workspace/pinSession`/`unpinSession`，
  用返回值的最新 `pinnedSessionIds` 全量集合本地刷新（不等 follow 帧）。⑤属观感层 ⇒ 须真机走查
  （GUI-CHECKLIST 第 25 条）。
- **会话错误透传到工作区页**：此前会话出错时工作区页仍显示绿色打勾「已完成」。根因是宿主
  `session.list` 行结构从无 error 字段（错误是 `turn/end` 的 `reason.kind==='error'` 事件，不是投影）。
  桥侧现在用本就在转发的 `turn/end` 事件为每会话记最近一次错误，作为新键 `lastError`/`bridgeError`
  挂到行上（aborted/blocked/max-tokens/interrupted 同算出错，不清除——它们在转录里同样渲染成
  错误横幅）。页面侧 `taskState` 判据顺序也翻转：**error 提到 awaitingQuestion 之前**（此前提问中
  无条件盖掉出错）。微信推送的同根因（`pollNotifyRunning` 读宿主原始行永远报「已完成」）同批修。
  ⑥属观感层 ⇒ 须真机走查（GUI-CHECKLIST 第 26 条）。
- **停止钮不再变发送钮**：此前右下角停止钮在「运行时间比较长了以后」会退化成发送钮，手机上
  无法停止会话。根因是 `agentRunning` 纯本地推断，`turnRunningOpen` 期间若 600000ms（10 分钟）
  内无任何新事件 seq 推进即判回合已结束、清零 `agentRunning`。长工具/子代理/模型侧停顿让事件流
  静默即触发。现在判死前先问宿主（`session.list` 的 `running`/`descendantRunning`）：宿主说在跑→
  保持开并重挂表；宿主说没跑或 RPC 失败→沿用旧退休路径。咨询期间 `agentRunning` 不动（无闪烁）。
  ⑦属观感层 ⇒ 须真机走查（GUI-CHECKLIST 第 27 条）。

## 0.4.42 — 2026-10-13

**主页行时钟与子代理折叠条时间统一为 24 小时制绝对钟点（用户口述「折叠和红点的时间都统一为24小时」）。**

此前两处显示相对时间（「刚刚 / x 分钟前 / x 小时前 / x 天前」），与全页其余时间（聊天消息钟点、
设备管理等）不一致。现两处改走与消息气泡同一把 `formatMessageClock`：当天显示 `HH:MM`，
同年显示「M月D日 HH:MM」，跨年带年份（en 侧为 `M/D`／`YYYY-M-D` 各自格式）。子代理折叠条
**运行中**的「已运行 X」是时长不是时刻，语义不变。`relativeTime` 及其四条相对时间文案
（`justNow`/`minute`/`hour`/`day`）随唯一消费方一并退役；时间戳缺失的行显示空白（与原缺失行为一致）。

## 0.4.41 — 2026-10-13

**会话页新增「子智能体」折叠条——主会话派出的子代理在手机上第一次可见、可查状态、可点开看会话（此前手机端对子代理全盲）。**

数据与形态全部对齐桌面官方：条目来自父会话的 `subagentCatalog` 投影（`label`＝创建时冻结的
名字/任务一句话、`createdAt`、`mode`），与桌面 `CatalogDropdown` 同源；运行状态来自
`session.list` 的子行（`running`／`lastError`），与父行绿勾聚合（0.4.8 的
`descendantRunning`）同一数据面。折叠条只在该会话真有子代理时出现，头部显示
「子智能体 N · M 运行中（· K 出错）」，展开后每行＝名字＋状态点（运行中蓝／出错红／
结束灰）＋时间（运行中的显示「已运行 X」，30s 一跳；结束的显示创建相对时间）。

- **点子代理行＝只读打开它的会话**：走宿主的 durable subagent 地址
  （`kind:'subagent'`＋`childSessionId`＋`parentSessionId`＋`mode`，`session.history`
  与 `session/follow` 两条通道全部参数化；tunnel 模式的轮询 collector 同样支持）。
  子代理视图顶部有「子代理会话 · 只读」提示，输入框／提问面板／停止键整体隐藏——
  子代理不吃普通 prompt（宿主把它们的读写都归 subagent routing），手机端不做
  `subagent.deliver` 写通道，这是明确的本期边界。
- 宿主拒绝的子代理（descriptor 缺失的老会话、已被清理的 catalog 残条：`subagent/*`
  错误族）与 `session/agent-busy` 同规：静默弹回会话列表，不上错误横幅。
- 历史导航闭环：进子代理会话的 history entry 自带地址参数，系统返回键回到父会话不丢
  只读态；屏幕返回键照旧回会话列表。
- 子代理行照旧**不出现在主页列表**（「子代理是会话的工具，不是行」的既有契约不动，
  `subagent-session-hiding` 断言原样保留）；它们的新出口只有父会话内的这条折叠条。
- 已知边界：子代理行的运行状态随列表数据刷新（60s 停留轮询／进页必刷），折叠条内
  不为状态单独开通道；精确工作时长（`subagentTiming` 投影）未接，时长按创建时刻起算
  的墙钟值显示。
- **同批并入（另一条线的思考泄露修复，代码 hunk 随本笔工作树入库）：即时回复气泡不再
  吞思考文本**——`tokenChunkText` 原先不看宿主流 chunk 类型，`reasoning-delta` 也被拼进
  气泡按正文渲染：模型思考多长，正文位置就漏多长，turn 结束气泡清空即「冒出来又收进去」
  （泄漏文字在全部 388 个会话持久档零命中——只活在直播 token 通道，纯手机侧）。修＝气泡
  只收 `text-delta`（及无类型旧形状），思考本就有自己的折叠卡（0.4.40 起）。测试
  `test/token-bubble.test.js` 三项（测试文件未随 59d92a7 入库，于后续笔补交）。

## 0.4.40 — 2026-10-13

**工具过程的直播态与完成态统一成同一张折叠卡——「先平铺一列、跑完突然收拢」的跳变不再有（用户：「出现的时候，就跟电脑端的折叠一样」）。**

0.4.3x 的过程改版只把**完成态**移植成了桌面样（单折叠＋连缀标题），直播态还是最初手机
handoff 那版的平铺形状：每个工具类一张独立卡，一条条长出来，等正文开始或轮次结束时整列
突然收拢成一行。现在直播态从出现的第一刻起就是与完成态**同构**的那张 `turn-process`
折叠卡，形状永不跳变，只有标题文字在换——与桌面端 `ProcessGroupHeader` 行为一致
（`dsh-client-ui-chat` 原文核实：桌面直播中本就是一张折叠卡，默认档折叠体收着，标题
进行时动词＋微光，跑完就地换成完成式连缀）。

- 直播标题＝最内一个运行中聚类的进行时动词（「正在运行命令」）；没有运行中的调用时回退
  宿主词表 `message.stepProcess.thinking`（「正在分析请求」），带微光动画（「减少动态
  效果」下关闭）。
- **标题最短停留**（桌面 `useStableLiveProcessTitle` 移植，桌面 150ms、手机按隧道节奏
  放宽到 2s）：连发快工具时标题不闪烁；到点后就地改一个 `textContent`，不整棵重画。
  按会话＋折叠隔离：新一轮/新段的折叠卡立即采用真实标题，不继承上一张卡的残余停留。
- **纯思考阶段也在同一张折叠卡里**（同日重启后追加，用户：「思考文字冒出来又收进去」）：
  原状是第一个工具调用前，思考内容渲染成独立「思考」行，工具一动整行被收进过程折叠卡，
  多轮思考就反复冒出收进。现在思考内容从出现的第一刻就在折叠卡体内（与桌面过程组一致）；
  纯思考期直播标题＝「正在分析请求 · 当前思路一行」（对齐桌面 standard 档
  liveProcessDetail；长行省略号截断），纯思考段落定后标题＝「已完成分析」；独立
  「思考」行整体退役——回复 own 的段首思考照旧挂在它的回复上方、回复之后的思考照旧
  留在回复下方（位置契约不变），只是形状同为折叠卡。
- 直播/完成共用同一把展开记忆键（`turn:<轮次>`）——直播期手动展开的卡，翻转后不再弹回。
  直播态保留 `.message` 包裹层，流式增量补写（`patchLastStreamMessage`）的寻址不变。
- 「标准」视图下直播折叠默认收起（与桌面 collapsed 分组一致）；「完全展开」视图照旧
  默认展开。折叠体内部仍是原有聚类卡（进行时动词/完成式动词、次数角标、diff）。
- 已知取舍：直播标题不再逐卡显示「N 次」角标（收进折叠体展开可见）；标题文案与正文间
  的「深度思考中…」状态行照旧（与桌面「头部叙述＋输入区状态」并存同构）。

## 0.4.39 — 2026-10-13

**返回主页的列表刷新加过渡润滑——不再是「静默几秒然后啪一下跳变」（用户：「中间加一个转圈圈的动画……不要那种硬切过去」）。**

0.4.37 让返回主页必刷，但刷的那一两秒里旧快照毫无表示、数据到了突然翻面。现在所有
**用户主动**的列表刷新（退回主页、点头部刷新钮、切后台回来）在请求走隧道期间显示
润滑态：头部刷新钮图标转圈（复用手刷按钮已有的 `.spinning` 模式）＋ 列表整体轻微
降透明（`.is-refreshing`，0.18s 缓动），数据到达后回升——旧内容始终在场，过渡有垫。

- 收口为公共的 `beginListGlow`/`endListGlow`：`refreshList` 无条件挂，`resumeOnReturn`
  仅非 quiet 挂；停留期 60s 后台轮询保持完全无视觉（quiet 语义扩为「失败不播报＋
  过程不发光」），不然每分钟闪一次是噪音。
- 结束含 **400ms 保底**：局域网亚秒返回时指示不闪帧；无论成功失败都收场，无常亮态。
- 手刷按钮 onclick 只留防重入，转圈的挂摘归公共函数（原 400ms 定时器逻辑并入，
  行为等价）。
- 「减少动态效果」系统偏好下缓动关闭（指示仍出现/消失，无动画）。

**同批入库（并行线收口，`99a74b6` 合并提交）——会话设置目录跨会话缓存**：
`openSession`/`startDraftChat` 不再在每次进会话时清空 `modelCatalog`。该目录是
宿主级数据（`session/modelCatalog` 不带会话参数），旧逻辑让「每次进会话后的
首次点开设置面板」都打回「加载中」等两个宿主往返（实测单调用 ~1.4s，
pocket.log 2026-10-13 01:22）；0.4.36 的 `93172ed` 只帮到了同一次停留内的
重复开面板。现在面板打开即画缓存、`refreshSessionSettings` 在后台复核
（既有机制），钉子在 `test/pages-state-reset.test.js` S-2。已知残余：草稿态
点设置仍先等 `session.create`（`ensureSession` 挡在面板前，属草稿扇出线域）。

## 0.4.38 — 2026-10-13

**微信通道两修：重启后配置被抹成 off（双向全哑）＋额度捎话永远差一条。**

- **重启后微信全哑（推送收不到、微信里发消息也没反应）——根因是设置档被「毒写」**：
  0.4.36 的额度计数落盘（`persistClawbotQuota`）每推一条就向设置档 save 一次
  `{notify:{clawbot:{quotaUsed}}}` 部分节，而 store 的 save 对 patch 未提名的字段
  （`channel`/`enabled`/`key`）不是保留盘上现值、而是落回默认 `off`/`false`/`''`。
  于是磁盘上的通道配置从第一次推送起就是「关」，只是内存里配置仍正确、推送照常——
  **下一次重启读盘，通道即死**：入站轮询门槛（channel==='clawbot' 且 enabled）过不去，
  微信发消息无人听；推送在 `notifyReady()` 处静默早退，日志一条不留。修复：store 的
  notify 节改为**字段级合并**（以盘上现值为底、patch 提名的字段覆盖；clawbot 子节
  提名即整体替换、未提名保留，语义同前）。全量节写入者（设置页、扫码绑定、reset、
  入站绑定）行为不变。现网已被抹的配置档已修复（备份 `.bak-fix-20261013`）。
- **「额度用完」捎话漏报（用户累计第 10 次）——门地址回话占用额度但不记账**：
  微信入站触发的隧道交接回话（「Pocket 已打开：…」）同样消耗服务器那条
  「一入站换 10 出站」的额度，却不走额度账本；一次隧道换址交接就让账本比服务器
  落后一条，此后 `计数===10` 的捎话条件永远差一条——额度耗尽的那条推送被服务端
  静默拒收，用户只看到消息停了、没有任何解释。修复：交接回话走同一本账
  （`clawbotQuotaTail` 预占计数），恰好落在第 10 条时捎话搭这条车；失败分类与
  notify 同规（服务端拒收＝额度态本身，挂起；传输丢失＝回滚预占）。

## 0.4.37 — 2026-10-13

**主页会话列表：进入即刷新＋停留期低频自刷新（走查反馈：会话内发消息后退回主页，状态与时间长期不动）。**

- **根因**：主页（工作区列表）是静态快照——退出会话时只在「退出瞬间会话还在跑/挂着提问」
  或「列表数据已超 30 秒」时拉一次新数据，而停留期间没有任何更新源（会话页的轮询
  `schedulePoll` 一进主页就停）。发消息退出后 AI 跑完、状态翻转、时间推进一概不反映，
  直到切走浏览器再切回或手动点刷新。
- **进入主页必刷**（用户裁定「进入到主页面的时候就马上一次刷新」）：`showSessionList`
  无条件拉一次列表（0.4.17 的 30 秒新鲜窗 `LIST_FRESH_MS`/`listFetchedAt` 随之退役）；
  配套把 `renderWorkspaces` 改为「标记没变就不动 DOM」——必刷不再附带滚动跳顶的代价
  （那正是 0.4.17 当初设窗的动机，痛点就地解决而不是绕开）。
- **停留期轮询**：主页在前台期间每 60 秒（`LIST_POLL_MS`）静默拉一次并重画；进会话/起草新
  聊天即停，锁屏/切后台即停，回前台重启。复用 `resumeOnReturn` 的拉取与重画（新增 `quiet`
  形态：后台单次拉取失败不闪错误条，失败播报仍归手动刷新按钮）。桥侧 `session.list`
  走既有 10 秒目录缓存与行投影，宿主侧负担与手刷一次相同。

## 0.4.36 — 2026-10-12

**冷开一律停主页（用户裁定「默认点链接就进主页面」），通知三件精调，一批手机页修正。**

- **落地页只停主页**：自动进会话的三条路径全部退役——冷开 boot jump（0.4.32 已半退）、
  **配对 handoff 直进**（正是「进会话后左滑直接退出页面」的元凶：`location.replace` 只留
  单条历史，`replaceState` 进会话把底座也换掉）、后台超 2 分钟回来自动跳（resumeOnReturn）。
  桥侧 SSR 的 `initialChat` 第一字节直进、focus 预热载荷（`focusBootHistory`/`pickFocusItem`）、
  拥挤普查（`landingAttention`/`LANDING_ATTENTION_MAX`）、`provisionalSession`/`embeddedFocus`/
  `handoffPainted` 一整套配套机制随之退役；配对 handoff 载荷保留但只服务**列表首屏**（不跳转）。
  进会话只发生在一个动作上：用户亲手点行。台账（0.4.33/0.4.35）保留，继续驱动主页未读点。
- **通知前台抑制**：手机页活着（事件长轮询按既有节奏刷新认证 `lastSeenAt`，30s 窗口）时
  推送一律跳过——页面正在实时刷新，推送是重复打扰；切后台/锁屏轮询自停，30s 内恢复推送。
- **每条推送自带入口**：所有通知通道（Server酱/Bark/WxPusher/ClawBot）正文末尾另起一行放
  本次隧道地址（隧道没跑则不带），不用再往上翻第一次的回执。
- **额度尾巴去数字**：推送不再显示「第 N/10 条」。计数转入设置档 `notify.clawbot.quotaUsed`
  落盘（重启不再归零重数）、传输级失败回滚（确认没发出去的不算）；额度内最后一条捎话
  「额度用完，在微信回一句就续上」——在通道死掉之前预告。本机计数仍是模拟，但不再有人消费
  它的精确值。
- **出错如实显示**：会话行的错误信号在压缩时保留（截断 `lastError`），手机列表不再把
  真出错会话显示成绿勾「已完成」——与推送侧（读原始行）从此一致。
- **主页默认只列最近 12 小时**（走查反馈补）：展开的工作区卡片默认显示最近 12h 内有活动
  的会话（`RECENT_WINDOW_MS`，至少保 1 行最新），更早的照旧收在「更多 N 行」里，点开全量。
- **会话设置面板秒开**（走查反馈补，0.4.32 移交事项①落地）：打开不再清空目录等两个隧道
  往返——立即画上次目录（当前模型/预设从会话投影即时同步），目录刷新走后台，落地无痛
  替换；刷新失败保留屏上内容，只有无缓存的首开才走「加载中→错误」老路。
- **列表时间与模型名**：正在推进的会话不再显示「刚刚」而显示真实最后消息时间（一分钟内
  仍是「刚刚」）；会话行模型名带服务商前缀（`provider/model`，与桌面端一致）。
- **桌面配对页两处显隐 bug**（0.4.2x 起的存量）：「设备」视图的通知/诊断面板从未显示过——
  `deviceExtras` 的 `show` 被写成裸属性而非 class、诊断面板被不匹配的后代选择器引用；
  修复后设备视图下设备列表下方可见任务通知与诊断（探针开关）面板。
- **文案**：/bye 告别页与重启确认卡精简（额度与隧道两条合并），链接类回执加就绪半句
  「打不开就等几秒再点」。

## 0.4.35 — 2026-10-12

**已读台账回源：换隧道域名不再「失忆」**。0.4.33 的台账只上行不下行，而手机浏览器按域名隔离
localStorage——quick tunnel 每换一个新域名就是新 origin，本地已读记录清零，所有近期会话全部亮未读点
（用户实测：「太多了，这咋点呢」）。方案经用户裁定走治根（不设「全部已读」按钮、不加确认弹窗）：

- 桥新增 **`GET /api/opened-at`**（与 POST 同门：同源＋在册手机会话），按**请求设备**的指纹返回它自己的
  台账——永远不给别的手机的。
- 手机开机时拉一次、按会话号取 `max` 合并进本地：桥上更旧的条目不会倒灌覆盖本地更新的，浏览器丢掉的历史
  如数领回。合并后顺手上传（两侧收敛，幂等）。
- 效果：换域名、清浏览器数据之后，未读点与冷开普查直接就是真实读态，无需任何手动操作。
- **先默认全灭，台账到手再亮**（用户裁定）：拉回未落定且本地无台账时，「从未打开＋近期完成」的未读推断
  一律悬置——不只圆点安静，手机侧冷开普查也不再被空台账推过阈值（桥知道不拥挤就不会多停一次主页）；
  三态（推进中／错误／提问）照常计数。拉回落定（成败皆可）即恢复完整规则；真新设备在落定后仍按 48h 规则亮起。
  已知残余：首次开页到拉回之间有一个几百毫秒的「全灭→亮」过渡（首帧不等网络是既有的冷开纪律）。

## 0.4.34 — 2026-10-12

**宿主远程重启：手机主页按钮调脚本，不再在会话里喊 AI**。手机主页头部（POCKET
品牌行右侧、刷新钮旁）新增电源钮，点开确认卡，确认后桥调用现成的
`scripts/dsh-restart-now.ps1`——注册一次性计划任务 DSH-ReviveOnce（宿主进程树
在同一 Windows Job Object 里，圈内谁也拉不起自己，圈外的计划任务是唯一可靠
执行者），约 8 秒后它杀宿主→拉起→等就位→微信推「DSH 已重启」→自注销。
杀/拉/推送全部复用 revive 脚本现成的机制，桥只武装。

- **硬拒**（用户 2026-10-12 裁）：有会话在推进（`running`/`descendantRunning`，全新
  强读不信任 10s 缓存）就拒绝并把名单亮在确认卡里；卡死的会话由用户自己去桌面端
  结束，没有强制口子。会话列表读不到同样拒绝——破坏性动作的守卫不许在猜。
- **回执口径**（确认卡写明，让用户自适应）：点确认手机页**立即退出**——先试
  window.close()，浏览器不让关就跳 `/bye` 告别页（静态零 JS，已加进 SW 的 BYPASS
  名单，不会被缓存壳劫回应用），屏上留着「回一句话拿地址」；页面上没有「成功」，
  唯一回执是微信推送「DSH 已重启」；额度用完推送会被丢，在微信回任意一句话续上，
  同一句回复带回新公网地址；重启后公网隧道是关着的，手机连回靠那句回复拿地址。
- 端点 `POST /api/host/restart`：同源＋在册手机会话门（与 /api/opened-at 同类）——
  能驱动手机的人本就能发 prompt、建会话，配对漏斗就是这条能力的权限边界。
- 目验项：`docs/GUI-CHECKLIST.md` 第 14 条。桥侧改动随下次重启上线。

## 0.4.33 — 2026-10-12

**拥挤规则的计数盲区闭合：已读台账上桥**。0.4.32 的「>2 个会话在等 ⇒ 冷开停在主页」在照代码跑，但计数
数不到用户数的东西——「完成未读」只有手机知道、「停止」在数据里没有任何标记——实测八次冷开桥侧 attention
全部 ≤2，阈值从未触发（pocket.log 2026-10-12 09:09–10:04 实证）。方案经用户当场拍板选「台账同步到桥」档，
停止口径裁定为「停止且没读才算」：

- 每台手机把本地 `dsh-pocket-opened-at` 台账经 **`POST /api/opened-at`** 镜像上桥：同源＋鉴权门内、64KB 限长、
  白名单清洗；全量上传（幂等、无序依赖），清空 localStorage 的手机上传空表即清掉自己的台账。桥按设备指纹
  （`sha256(userAgent)` 前 10 位，与设备注册表同键）分账持久化到 pocket 数据根的 `mobile-opened-at.json`
  （本机布局＝`%LOCALAPPDATA%\dsh-pocket\`，`DSH_HOME` 覆盖时＝`<DSH_HOME>\pocket\`，与配对 PIN／会话档案同根），
  防抖 1.5s 落盘、`stop()` 冲刷——**重启桌面后冷开（本功能的主场景）台账不丢**。
- 冷开普查（`sess.attention` 与文档 `initialChat` 判定）改为按**请求设备**的台账算全量四态：正在推进／有错误／
  有提问／**完成未读**（最后活动晚于该机上次打开＝未读）。桥在第一字节就按完整规则决定进不进会话，
  不再「先嵌会话骨架、再让页面退回主页」。
- **「从未打开过」盲区一并闭合**：无台账条目按近期完成计未读（48h 内，`UNREAD_RECENCY_MS`），更旧的算旧事
  不拦人。手机侧未读点／工作区徽标与冷开共用同一判据，行为同步翻新。
- 手机侧保留 live 台账自算并取 `max(own, bridge)`：一次同步在途或失败只会让桥多算（停在主页），不会盲进。
  上传 2s 防抖＋失败 60s 退避＋`pagehide` keepalive 冲刷。
- 已知口径：同型号两台手机共享指纹＝共享台账（与设备注册表同粒度）；手机钟与桌面钟的偏差影响「未读」边界
  的分钟级判定（与 0.4.31 已读点同一暴露面）。
- 目验项：`docs/GUI-CHECKLIST.md` 第 13 条；装机照例需重启 DeepSeek Harness。

## 0.4.32 — 2026-10-12

**七条并行线的合并收口版**。10-12 凌晨多条会话在同一工作树上作业、改动物理混排、逐线自测各自绿，
谁都不掌握全貌；本节由值守线在停笔后统一清点，**逐段标出来源会话**，逐文件与逐 hunk 的提交账在本笔
`git log` 的 message 里。装机仍需重启 DeepSeek Harness（宿主 pid 16952 起于 10-11 20:46:52，未重启）。

- **工作区三态提示与会话模型名**（`session-45e600e1`，代码已在 `e92b13c`；当时按用户裁定未立版本节，此处补记对外账）。
  工作区名不再一律显示「正在进行」，改按 `新完成／待回答／有错误` 实际状态标；会话行沿原时间位置显示该会话所用模型名。
- **桌面配对页：结构修复保留，连接态重新禁切模式**（`session-1343f071` 的解锁在并入本版前被用户回退）。
  面板结构层的修复全部保留：「待确认接入」不再被绿色连接卡整块遮住；隧道配置面板从 `#deviceExtras`
  提到 `.wrap` 直属——原两处 `.show` 条件互斥，**任何视图都进不去，即 hostname 从来没有 UI 可改**
  （「待你裁决」4-② 的 I-13 就此了结，实况比原判更糟）。
  **连接态下的两个模式键仍按旧规禁用**：连接态点另一模式的键＝真的切隧道，正走公网的那台手机会掉线；
  该风险高于「提前填固定地址」的收益，故页面这一层恢复拦截（模板 `disabled` ＋ `syncModeControls`
  ＋ `switchMode` 早退，三处）。**桥侧能力不变**——`/desktop/tunnel/toggle` 仍照 M4
  「A live phone is not a reason to refuse」放行，`/desktop/tunnel/config` 仍无门禁，被拦的只是页面。
  ⚠️ **取舍的已知代价**：因两键在连接态不可点，hostname 配置面板只能等该手机断开后才可达——
  而解锁的原始动机正是来自此处。目验项见 `docs/GUI-CHECKLIST.md` 第 12 条。
- **新建对话改草稿态**（`session-3c0469b0`）。点「+」不再向宿主发 `session.create`，会话延迟到首次真实动作
  （发送／上传文件／打开会话设置）才物化，根治手机端那条去不掉的「未命名会话」；宿主无 delete/archive RPC，
  故唯一根治方向是不把它建出来。空会话可见窗 `BLANK_ROW_VISIBLE_MS` 24h → **5 min**，既存残留重启后即不再显示。
- **冷开拥挤时停在主页**（`session-d95049f7`）。满足「正在推进／推完未读／有提问／有错误」任一的会话**超过两个**
  （严格 >2）时，冷开与后台返回都不再随便进一个会话，只停在工作区页；判据两边各算、取 `max` 不相加
  （「未读」只有手机知道），并复用工作区头三个徽标 `wsFlagOf` 不另立定义。为此冷开 boot 行数由 1 提到 12
  （新常量 `LANDING_LIST_ROWS`，文档 8.2 KB→12.5 KB）。残余边界：未读项排在第 12 行之后手机侧看不见，
  闭合需把已读台账同步到桥侧，本轮按「不扩成一套机制」未做。
- **拉到顶端补页不再跳几下**（`session-2e0b31be`）。旧消息行带 `content-visibility:auto`，补页当场量到的
  `scrollHeight` 是估算值，行被真正渲染后高度转真值、视口跟着位移。新增 `settleOlderShift()` 在补页后按当下
  布局重瞄 4 轮（120 ms／轮，埋点 tag `ol`）；阈值 `|delta|>2` 才动，免得自己制造抖动。
- **任务胶囊「叉叉」改图标字形**（`session-6f9d3389`）。裸文本 `×` 与旁边的 13×13 SVG 同排时走字体排版
  （继承 `body` 的 `font:14px/1.5` ⇒ 行盒 21 px、墨迹 19 px、基线下压），实测墨迹中心比 SVG 低 **4.41 px**
  并溢出自己的按钮盒，而三者 `getBoundingClientRect()` 完全相同——**盒子层测量证明不了这个 bug**，
  这正是它躲过字符层测试的原因。改为 SVG 字形，并扫了同类站点。
- **工作区里的会话时间改取「最后一条消息」的时间**（`session-d38deef2`）。此前显示的是宿主 `updatedAt`，
  与对话下方每条消息各自的时间戳不同源；改为取该会话最后一条已落定消息的时间，显示与排序同源。
  同批把壳字节预算 `ASSET_BUDGET_BYTES` 提到 **284 000**（实测 zh 281 120，余 2 880）。
- **链接重入的预加载与后台刷新**（`session-6369da2f`，**完成度未经该线自证**）。该线未写 handoff，
  其 hunk 与其他线在同一文件内物理混排、拆不出来，故随本笔一并入库。⚠️ 若该线实际未完，需要后续一笔修正——
  这是合并收口的代价，如实记在这里而不是藏进历史。

验证：全量单跑（08:05，无并发写入）＝**1100 项／1098 通过／0 失败／2 skip**（skip 是既有的环境门控档）。
`script-embedding` 的 PARSE 档绿。**渲染层与实机观感未覆盖**——观感类改动字符层绿不构成依据，
目验单见 `docs/GUI-CHECKLIST.md`；真机验收项按各线 handoff 逐条走。

### 0.4.32 补笔（2026-10-12 10:5x）：读者停在中间不再被新消息拽到底

来源：`docs/HANDOFF-pocket瞬移到底与模型默认副作用-20261011.md` 的 **P1**（协调线 `session-451057b8`，
8 发实锤、最大位移 13 042 px）。**这是本版唯一由值守线自己施工的一项**，其余六条均为代各线入库。

三条口子各修一处，都在页内脚本的滚动机器里：

- **带宽不再恒为 120 px**。`isNearBottom` 原写死 `dist<=SCROLL_FOLLOW_PX`（120），在一个只比视口高一点的
  转录上，120 px 已接近半屏——代码自己在 `anchorVisibleState` 的注释里就承认过「Screens, not pixels：
  一个像素数在长转录与短转录上不可能都表示『读者离开了』」，但那条认知只用在按钮上。现改为
  `dist<=Math.min(SCROLL_FOLLOW_PX,Math.round(settled/2))`，短转录上带宽自动收窄。
- **滚动监听器加 250 ms 静默窗**。它原来看见任何 scroll 就用原始几何重上膛 `followStream`，**不看事件来源**：
  程序化写 `scrollTop`（每次绘制、每次锚点还原、每个 settle 循环）会发真 scroll 事件，重排把 `scrollTop`
  往新的最大值钳一次也会发（键盘收放、`content-visibility` 估高转真高）。两者都曾在读者背后把跟随重新打开。
  现在 `programmaticScroll()` 只在每个写点盖一个 `followReArmAllowedAt=now+250`，窗内到达的帧记
  `pendingFollowFrame=true` 而不动 `followStream`，并由 `applyHistory` 在下一帧按当时的真实几何补一次判定
  （窗长 250 ms > 本文件最长的 settle 链：`settlePromptJump` 4×100 ms、`settleOlderShift` 4×120 ms）。
- **send 路径不再硬编贴底**。两处 `paintMessages(…,true)`（成功路径与失败回滚路径）改为发信前锁下的
  `readIntent`：读者停在中间时发消息，乐观回显与失败回滚都留在原处；他本来就贴着底部时照旧跟随。

同批：壳字节预算 `ASSET_BUDGET_BYTES` 284 000 → **288 000**（实测 zh 286 236 / en 286 148，余 1 764 / 1 852）。
三处测试同步：`transcript-order` 的「send 从活缓冲重绘」档改钉 `readIntent` 并**断言不许再出现硬编 `true`**；
`pages-scroll-anchors` 的 rAF 时序档补上 `pendingFollowFrame` 分支、`patchLastStreamMessage` 档改钉 `stick`
新形状、`scrollOrgans` 沙箱补 `settledTranscriptHeight` 与 `$`（`isNearBottom` 新依赖，缺了它该档直接
`ReferenceError`——正是本仓「沙箱漏名单」那条老坑）。

验证：全量单跑（10:5x，无并发写入）＝**1102 项／1100 通过／0 失败／2 skip**。**实机观感未验**：
本条修的是滚动时序，字符层绿不构成依据，须按 `docs/GUI-CHECKLIST.md` 真机复看「停在中间来新消息」一项。

## 0.4.31 — 2026-10-12

**↑ 邮包作废：有消息就推，推送标题带真实会话名**。用户 2026-10-12 00:0x 裁定：「有消息就推，不管是完成
还是提问错误，只要有会话就推送。不要搞什么『搭车不搭车』、什么时间、什么信封，这些概念全部取消。
没推到的就没推到，也不用管了。」外加「目前推送的会话没有名称，我看不到……把这个名称显示出来。」

- **删掉整个邮包（0.4.12–0.4.30 的合并车道）**。`lib/mailbag.js`（攒包、封口、`due()` 三条件）
  与 `lib/mailbag-store.js`（落盘 `notify-mailbag.json`）两个模块连同它们的测试一并删除，
  数据目录里那份空包也已清掉。桥侧 `sendMail(reason)` 的 `tick|inbound|hitchhike` 三种发车理由、
  `flushOrdinaryOnRegistered()`、`scheduleMailbagPersist()`/`flushMailbagPersist()`、`restoreMailbag()`、
  `noteMobilePresence()`（进手机端重置计时）**全部取消**；`held` 字段从桌面接口移除。
  它们背后的概念——信封、班次、末班车、封顶、顺路搭车、挂号信补投、跨重启恢复——**一起作废**。
- **改成一条路：`sendNotice(title, body)`**。完成、提问、报错都走它，判到就当场发一条，
  **发不出去就丢**（日志 `notify dropped: <名字> <原因>`），不攒、不等、不补投、不跨重启。
  这条同时废掉了「没额度就先扣着，等下一次入站第一件补投」的挂号信车道。
- **推送标题改为真实会话名**。根因是**读错了字段**：标题在 `item.projections.values.title`
  （宿主 rc.2 的 projection），旧代码读的是行顶层 `item.title`，那里从来没有值，
  于是每条推送的标题都退化成字面量「会话」。新增 `sessionTitleOf(item)` 按
  `projections.values.title` → `sessionTitle` → `session.title` → 顶层 `title` 依次取，
  取不到仍明说「会话」，**不许**拿 sessionId 冒充名字。手机页 `titleFor()` 早就是这么读的，
  这也解释了「手机页看得到名字、推送看不到」。
- 保留未动：`clawbotQuotaTail()` 的「（第 N/10 条）」计数与续期归零、`judgeSessionCompletion`
  的 settle 判定（quietMs 90s / graceMs 10s / minBusyMs 20s / staleMs 30min）、`lib/notify.js`
  与 `lib/clawbot.js` 整体。
- 验证：全量 `node --test --test-concurrency=1 test/*.test.js` ⇒ 1078 tests / 1073 pass / 3 fail / 2 skipped；
  三个红档（`stream-watermark` AC-A6、`transcript-order` 两条）经 stash 他线文件后单跑 **66/66 全绿**，
  归属当时并行在改 `lib/pages.js` 的另一条线，与本版无关。

## 0.4.30 — 2026-10-11

**↑ 只做一件事：把正在读的那条回答的提问放回视口顶**。这一节只收这一件，另有一条线在改会话设置，不在本节范围。

- **「摁一下翻两次」修掉（B-3）**。探针现场（2026-10-11 21:04）：连续三条 `up` 标记各自成对，
  间隔 1085ms / 1216ms——既不是冒泡双触发（同 tick），也不是 `settlePromptJump` 的 4×100ms 重瞄，
  是**同一次按压里跑了两个机制**。`↑` 原来在「上方找不到提问」时会顺手调 `loadOlder()` 拉一页历史，
  于是同一次按压 = 跳转 + 加载，加载完 `fetchOlderPage` 又把视口挪到新页锚点。落点实测
  `scrollTop 17213 → 14`（文档最顶），因为上方唯一那条提问在 17145px 之外。修法：`↑` 找不到提问就
  什么都不做；**加载历史仍由「滚到顶边」那条下拉手势负责，原样保留**。
- **`↑` 的亮灯条件同步收紧**。原来还带「还有更早历史」这一支，那是给被删掉的拉历史动作准备的；
  留着会让按钮**亮着而点了没反应**。现在只看「上方有没有提问」。
- **`↑` 的产品定义**（用户 2026-10-11 口述后写进代码注释）：AI 回答很长时提问早被顶出屏幕，
  这颗按钮省掉手翻去找。因此**跳得远不是缺陷**——落在 17145px 外的那条正是这条回答的提问。
  施工中一度给 `userAnchorEl` 加过「超过 3 屏就不跳」的距离上限，已按此定义全部撤回。
- 验证：`mobile-assets`（壳字节仍在 269 000 预算内）+ `script-embedding` PARSE 档。

## 0.4.29 — 2026-10-11

**B-2 的后半截 + 一次真机取证抓到的「抖一下就扯过去」**。0.4.28 重启后真机验收回来的三条答复：
换行已好；箭头能翻上去了但**点了收不回**；停在中上部阅读时屏幕**会闪一下再扯过去**。

- **B-2 后半截：面板点了收不回**。0.4.28 只修了箭头没表达状态，这一节修另一半——
  `togglePickField` 的关闭分支**从 0.4.14 自绘列表落地起就从未执行过**：第二次点同一字段时
  `settingsPick` 已被清空，但循环体拿传进来的 `field` 做比较，等于把面板按「打开」重写一遍。
  循环现在比对 `settingsPick`（当前值），不再比 `field`（本次点击值）。这条解释了 handoff 里
  B-2 的原话「不变上拉、**无法恢复**」——两个症状是同一个根。
- **中上部阅读时的闪动，根因实锤并修掉**。探针取到的现场（2026-10-11 19:47）：AI 内容推进来那刻
  `scrollHeight` 暴涨 2157→3562，锚点复原函数 `restoreTranscriptAnchor` 拿**正在重渲的中间态**当基准
  （写入瞬间行数不够，`Math.min` 把锚点索引钳到末行），于是 `rs@19930` 把 scrollTop 写到 188——
  当时你的真实位置是 1151；120ms 后 `rs@20050` 又写到 969。两次落点都和你无关。修法：
  **行数少于锚点记录时跳过这次写入**，交给既有的 120ms 重试链等布局稳定；锚点行还在且偏离时照常复原。
- 新增 `test/pick-toggle-anchor-restore.test.js` 五条行为测试（沙箱跑真实函数）：同字段再点收回、
  换字段打开时原字段收回、行数不足不写 scrollTop、锚点行偏离照常回写、已对齐不写。
- **诊断开关管到第三条路**：面板开关此前只管住桥自己推地址的两条路（微信回话、配对页），
  `tools/dsh-push-notice.mjs` 推的链接全靠人记得手打 `?probe=1`——开关关着照样发得出带诊断的链接，
  「关了就干净」这个预期不成立。现在该脚本自己读 `diagnostics.probe`：开着就给文案里的地址补参数
  （用 URL 类构造，与桥出的 `https://<host>/?probe=1` 逐字节一致），关着发裸地址；已带 probe 的幂等。
  新增 `test/push-notice-probe-suffix.test.js` 七条，其中一条钉住「确实按开关调用」，防 helper 写对了却没人接线。
  改的是 `tools/` 下的独立脚本，**不需要重启**，即刻生效。
- **B-1「AI 推消息瞬移到底部」本轮未复现**：探针证伪了「停在中上部会被拽到底」——
  那批数据里 `bt`/`bf`/`bp` 一条都没有（`followStream` 关着时三条贴底路全部没武装）。
  该 bug 若要复现，需在**人在底部、AI 正在生成**的那一刻抓；继续靠诊断模式等现场。

## 0.4.28 — 2026-10-11

**输入栏换行 + 模型下拉箭头两处观感/行为修正**，另给 ↑ 加了取证埋点。用户 14:29 报的四个 bug
（B-1~B-4），本节收掉能确定的两条，另两条留取证。

- **B-4 换行不再变成发送**（用户口径定死：「换行就是换行，发送只点箭头」）。根因是输入栏的 keydown：
  旧写法 `if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();send()}`——
  它排掉了输入法合成态，但**排不掉软键盘的 return 键**：Android 把那个键报成 `key==='Enter'` 且
  `shiftKey===false`，与硬件 Enter 在事件字段上完全同形，所以手机上每次想换行都发出去了一条。
  修法是**让 Enter 什么都不做**（只留埋点），`<textarea>` 的原生行为就把换行插进去了——这也让代码比原来更短。
  斜杠菜单仍在 Enter 上优先取词（`slashMenuKeydown` 自己 `preventDefault`），那条路不受影响。
  新增 `test/composer-enter-newline.test.js` 五条行为测试：软键盘 return 换行且不发送、光标处断行而非行尾、
  shift+Enter 同样只换行、菜单打开时 Enter 仍取词、以及源码层「该 handler 里不许出现 `send(`/`preventDefault`」。
- **B-2 下拉打开后箭头改成指上**（用户报「点下拉后不变上拉、无法恢复」）。`togglePickField` 一直在正确写
  `aria-expanded`，但 chevron 只有一个写死的 `rotate(45deg)`，**没有任何 `[aria-expanded=true] i` 规则去翻它**
  ——于是列表已经展开、箭头仍朝下，界面等于不承认自己开了；再点一次收起，读起来就是「点了没用、还回不去了」。
  补 `.setting-pick[aria-expanded=true] i{transform:rotate(225deg) ...}`，并在 `test/mobile-assets.test.js`
  的 AC-UI9 里钉住「打开态必须指上、且不许停在指下」。
  **注意这条只修了「状态没被表达」，没有动列表的展开方向**：`.setting-list` 是面板内的常规流块
  （`margin-top:6px;max-height:min(42vh,300px)`），不是浮层，所以它本来就不会也不该「往上弹」。
- **B-3 ↑ 加取证埋点**：`.scroll-anchors` 的 click 委托里加 `probeMark('up')`（↑）与 `probeMark('latest')`（↓）。
  判据：诊断模式开着时点一次 ↑，日志里出现**两条** `up` ＝ 事件双触发（子元素冒泡／重瞄未结束又进一次）；
  只有**一条**却位移两次 ＝ `settlePromptJump` 的 100ms×4 重瞄在重复推。埋点走既有的 `probeMark`，
  默认关（`diagnostics.probe`）。
- **B-1（AI 推消息时瞬移到底）本节不改代码**：这是 handoff 就定下的口径——现有 `bt`/`bf`/`bp`/`rs` 四个标记
  已足以指认是哪条路，缺的只是**真机上的一次现场**。做法：打开面板诊断开关（或用带 `?probe=1` 的链接进一次）、
  把会话停在中上部、等 AI 推进来一条，然后读 `pocket.log` 的 `kbprobe`。**拿到那条数据之前不动代码**，
  否则就是在猜。
- 字节：zh 壳 **268 305 B**（预算 269 000），`ASSET_BUDGET_BYTES` **不需要提额**——B-4 最终修法比原实现更短，
  中间那版自建 `insertPromptNewline` 助手（+948 B）已废弃。
- 全量 **1077 / 1075 pass / 0 fail / 2 skipped**（0.4.27 的 1072 ＋ B-4 新档 5 条）。
- **需要重启才生效**（改了页与包版本）。

## 0.4.27 — 2026-10-11

**诊断模式补上面板开关**（用户 14:18 令「做面板开关」）。0.4.26 只落了后端，开关只能靠手改设置档
或手机侧手动带 `?probe=1`；本节把最后三块补齐：**路由 / 回显 / UI**。

- **`POST /desktop/diagnostics`**（`bridge.js`）：照 `tunnel/config` 全套 —— 桌面会话闸 → 同源校验 →
  解析正文 → **严格布尔**（`probe` 非 boolean 一律 400，`"true"`、`1` 这类 truthy 不放行）→
  `settingsStore.save({ diagnostics: { probe } })` → 回快照。严格布尔是这条路由的重点：放一个 truthy 过去
  就等于把手机的滚动时序持续写进 `pocket.log`，而默认关的全部意义就是不让它发生。
- **回显**：`snapshot()` 与 `desktopTunnelPayload()` 都加 `diagnostics: { probe }`。只加 `snapshot()` 不够——
  面板实际读的是 `desktopTunnelPayload`（`/desktop/tunnel/status`），漏了它开关就会每次刷新都弹回关。
- **UI**（`pages.js`）：`#deviceExtras` 内新增 `#diagPanel`，一行勾选 + 说明 + 保存；zh/en 两套文案。
  文案写全代价：**开着时手机每滑动约 1.5 秒回传一批**、日志会涨、**换隧道域名后必须重新用带 `?probe=1`
  的链接进一次**（localStorage 按 origin 隔离）。
- 测试 `test/diagnostics-panel.test.js` 五条：路由契约（未鉴权 403 / 七种非布尔 400 且不落盘 / 开-关往返与
  快照回显 / 被拒的载荷不改设置）+ 面板渲染（关不预勾、开预勾、缺省段=关）+ 两语文案代价 + 页内 fetch 契约。
  PARSE 档同批绿。
- 字节：**手机壳零变化**（实测 `mobilePageAssets` zh 263 660 → 263 660，改的全在桌面配对页，
  不进壳预算）；`ASSET_BUDGET_BYTES` 维持 269 000。
- **需要重启才生效**（改了桥与页）。

## 0.4.26 — 2026-10-11

**电脑面板交给手机的公网入口改成裸地址**（用户 14:1x：「公网地址也不要后面那一长串，就裸地址」）。

- 之前那条是 `https://<隧道域名>/pair?token=<一次性配对令牌>`。**公网路径上这个 token 不省 PIN**：
  `/pair` 校验通过后仍然渲染 PIN 页（`bridge.js:4007-4008`）。它唯一的作用是"从二维码跳过来"，
  代价是把一次性凭据摊在屏幕上、进剪贴板、可能被复制进聊天记录。所以公网去掉它**零功能损失**。
- **局域网那一份保持带 token**（`/pair?token=…`）：那条路径是「校验通过直接发 cookie、免输 PIN」，
  token 是它的机制，去掉就是降级。契约两侧都钉住了（`test/bridge-review.test.js`）。
- 新增**诊断模式**设置位（`diagnostics.probe`，与 notify/tunnel 同一份 `mobile-bridge-settings.json`，
  不新增第二份存储）：开着时交给手机的公网入口与微信回话地址一律追加 `?probe=1`；默认关。
  ⚠️ **面板上的开关 UI 尚未做**（本笔只落了后端）：在那之前，诊断模式只能由手机侧手动带 `?probe=1`
  打开，或把 `diagnostics.probe=true` 写进设置档。
- 顺带把配对令牌从一处测试取值方式改掉（原先从 `pairingUrl` 里 parse token，公网那条现在故意不带），
  被验的性质没变；注释按本仓规矩同批改写。
- 字节：无变化（改的是桥侧 URL 组装，页内壳未动）。全量 `node --test` = **1066 / 1064 pass / 0 fail / 2 skipped**。
- **需要重启才生效**（改了桥）。

## 0.4.25 — 2026-10-11

**把滚动时序埋点转正为常设诊断工具**（用户 13:4x：「那个 probe 的技术手段还是留着，我感觉很有用」）。
0.4.23 按「收尾」字面把它整批删了，删过头 —— 本节把它恢复回来并改性质：**不是待拆的临时脚手架，
而是随版本走的默认关诊断**。

- 页内：`?probe` 或 6 小时内 armed 过才动作；记 `rz`（视口变化）/`sc`（一次滚动）/`rs`（锚点复原真写了
  scrollTop）/`on`（armed 回执）；攒 1.5 s 批量回传，缓冲 30 条。默认零行为、零开销。
- 桥侧：`POST /api/mobile-probe` 同源 + 已鉴权手机会话，正文 4 KB，字符白名单**不含换行**，一秒限流，
  两个失败分支都留痕（`probe refused` / `probe dropped`）——**静默的"没数据"分不出三种成因，这不算可诊断**。
- 契约：`test/mobile-probe.test.js` 三条（未鉴权进不来 / 清洗与行数不膨胀含换行注入 / 开关活过 SW 改写
  且 armed 可自证）。
- 用法（下次要查滚动问题）：用手机浏览器打开 `<隧道地址>/?probe=1`，做一遍想查的动作，
  然后在电脑上 `Select-String -Path "$env:USERPROFILE\.dsh\pocket\logs\pocket.log" -Pattern kbprobe`。
- **0.4.25 另加三个贴底打点**（用户 13:5x 新报「发新消息了还是会瞬移到最底部」，必须先分清是谁做的决定）：
  `docs/F真机判读-20261011.md` §9）。
- 代价：壳 **+2 001 B**（zh 266 023 → **268 024**，css 44 051 + js 223 973；en 267 947），
  本节前半段写的是 267 876 —— 那是加贴底打点**之前**的数，加完按实测改成本行。
  `ASSET_BUDGET_BYTES` 267 000 → **269 000**（余 976 B）。这笔不再是"有到期日"的提额，
  而是常设工具的固定成本，所以账上写清它换来了什么。
- **需要重启才生效**（改了页与桥）。

## 0.4.24 — 2026-10-11

**修「连接须知每换一个隧道域名就重新问一遍」**——用户想直接在微信里点链接进 Pocket，
上午那条路会卡在须知页反复打转，当时归因给了 WebView 不存 cookie；**真因在桥这边**。

- 设备档案里本来就有 `publicConsentedAt`（设计意图：cookie 按 origin 存，隧道换随机域名必然丢，
  而档案按设备存 ⇒ 答案该跟着设备走）。但**读和写两头都要求「已有活会话」**：
  而真实顺序永远是**先同意须知 → 后输 PIN 配对**，同意那一刻还没有会话，
  于是答案既写不进档案、读也读不到。实测两台设备的 `publicConsentedAt` 确实都是空。
- 修法是把口径统一成档案本来的身份算法：`deviceFingerprint(userAgent)`
  （有活会话用会话的指纹，没有就从 UA 算）。读写各一处，别的逻辑不动。
- **这不是放宽授权**：能不能进来的门（配对漏斗、渠道权限 `canPublic`）都在这道须知之前就已经查过，
  本函数只决定「免责须知还要不要问第二遍」。没配对过的设备照旧要问（契约档反向钉住了这条）。
  顺带一个已知边界：无 UA 的请求 `deviceFingerprint` 返回固定值 `no-agent`，
  这类客户端会共用同一条须知回答——它们本来也过不了配对门，且须知不是凭据。
- 契约：`test/consent.test.js` 新增一档（配对一台设备 → 不带 cookie 请求 ⇒ 303 去须知 →
  POST 同意 → 再不带 cookie 请求 ⇒ 不再被送去须知页；换陌生 UA 仍 303）。
- 全量与 PARSE 档见本笔提交前复跑。**需要重启才生效**（改了桥）。

## 0.4.23 — 2026-10-11

**为 F 装的临时取证埋点整批撤除**（用户 13:1x 说「可以收尾了」）。这批代码从 0.4.19 装进来到 0.4.22
拿到判据，账上每一步都标了「有到期日」，这一笔就是去兑现那句到期日。

- 撤掉：页内 `PROBE_ON`/`probeMark`/`probeSend` 与三处打点、0.4.20 的 localStorage 凭据与 `on` 回执、
  桥侧 `POST /api/mobile-probe` 路由（38 行）、契约测试 `test/mobile-probe.test.js`；
  `test/pages-scroll-anchors.test.js` 里被 `probeMark` 撑长的 `topEdgePull` 字面断言**改回原样**。
- 留下的是功能，不是埋点：`--kb` 键盘抬起量（0.4.22）与 0.4.21「视口期间不写 scrollTop」的形状。
- 字节：撤完**实测 zh 266 023**（css 43 971 + js 222 052）、en 265 946。
  原先打算「降回 266 000」是**我估的**，实测超 23 B，所以预算写 **267 000**（余量 977 B），
  并把三级来路逐笔标在 `test/mobile-assets.test.js` 的 WP1 上方。
- 已发布段落不改写：0.4.19 那一节的摘除清单原地保留，本节就是它的执行回执。
- F 的结论没有随埋点一起消失，都在 `docs/F真机读数-20261011.md`（265 条一手读数的存档）与
  `docs/F真机判读-20261011.md`（含 §10 复测：`rs` 13 → **0**、末段过冲 **0** 次、
  以及一条对我自己不利的更正：`resizes-visual` 在用户那台华为浏览器上**没有生效**，
  `innerHeight` 仍随键盘 735↔450 跳，所以「过冲消失」不能记在换声明头上）。
- 复测还坐实了两条用户问题：① 会话页**不存在自动聚焦**（全文件 10 处 `.focus()` 都挂在明确动作后，
  唯一自动聚焦的是**配对页 PIN 框**）；② **停在最顶上让流继续跑不会被拽到最底**
  （CDP 实测 `TOP0 st:0/index:0 → TOP1 st:0/index:0`，chunk＋tool/start＋tool/result＋turn/end 一连串），
  顶边自动取页也没被误触发（行数 120 不变）。
- 全量与 PARSE 档见本笔提交前复跑；**需要重启才生效**（改了页与桥）。

## 0.4.22 — 2026-10-11

**键盘不再重排页面；输入框那一整叠自己抬到键盘上方。** 依据是用户 12:44 给的三条要求：

1. 点进来时不要把输入法自动弹起来；
2. 点输入法 → 键盘弹出 → 输入框就在输入法上面，**页面不动**；
3. 输入法往下走，**到哪就是哪**，不闪也不弹。

- 视口声明 `interactive-widget=resizes-content` → **`resizes-visual`**：布局视口不再被键盘压缩，
  **（13:0x 真机复测更正：这一句在用户那台华为浏览器上不成立——`innerHeight`/`clientHeight` 仍然
  在 735↔450 之间跳，说明该浏览器没有理会 `resizes-visual`。末段过冲确实消失了，但「过冲消失」
  不能记在这条声明头上，真实机制待复证；详见 `docs/F真机判读-20261011.md` §10。）**
  于是既没有「scrollTop 被钳」也没有末段那次 **+56 px 回弹**（0.4.21 判读里那半条没治的病，
  根子在视口声明，不在滚动逻辑）。
- `.composer`（待办卡／排队坞／设置面板都挂在它里面）加 `translateY(calc(-1*var(--kb,0px)))`，
  `.scroll-anchors`（上下两枚）同样抬起——不抬它们就会掉进键盘后面；
- 新增 `applyKeyboardLift()`：`--kb = innerHeight - visualViewport.height - visualViewport.offsetTop`，
  减 `offsetTop` 是因为浏览器自己 pan 过时不能重复抬一次；**每一拍 resize 都重算**（键盘动画是逐帧的，
  晚一帧就是输入框慢半拍），开机先算一次。**iOS 路径原样不动**：它忽略 `interactive-widget`，
  本来就用 `--app-height` 走同一语义，再叠 `--kb` 就会抬两倍。
- **要求 1 的核查结果（如实报）**：现码里**没有**「进会话自动聚焦」——全文件 10 处 `.focus()`
  都挂在明确动作后面（改目标、改排队项、＋ 面板、插斜杠命令、配对页 PIN 框）。所以这条在代码层
  本来就不成立；唯一会在「进来」时自动弹键盘的是**配对页的 PIN 输入框**（`showPin()` 里 60 ms 后
  聚焦，为省一次点击而做）。**要我一并去掉它请说一声**，那是一次有意的取舍而不是 bug。
- 代价（这条要求的直接后果，不是缺陷）：打字时键盘遮住的那一条转写本区域**不再让位**，
  最新几条会被键盘盖住，需要上滑看。老行为是压缩列表让它让位——而那正是「闪/弹」的来源。
  若这条不可接受，替代方案是给 `#messages` 加 `padding-bottom: var(--kb)`，但那样 `scrollHeight`
  会随键盘涨缩、贴底时又会出现位移。
- 契约：`test/mobile-assets.test.js` 新增一档钉住「视口声明 + 两处 transform + 抬起量公式」
  （把 meta 翻回 resizes-content 会红）；AC-PERF 的字面随真实文本更新，注释同批改写。
  过程中我第一版把断言写成「全文不许出现 resizes-content」，结果被**注释里的历史说明**误红——
  钉的应该是「声明」本身，收紧为只匹配 `interactive-widget=` 前缀。
- 全量 `node --test --test-concurrency=1 test/*.test.js` = **1064 / 1062 pass / 0 fail / 2 skipped**；
  途中 `stream-watermark` 一条红：单跑 20/20 绿、复跑全量 0 fail ⇒ 按既有口径记为负载敏感假失败。
- **预算告紧**：壳 zh **267 821 B**（预算 268 000，**只剩 179 B**）、en 267 744 B。
  下一笔要么先压字（本仓铁律：复用/改文案 → 砍功能 → 提预算），要么正面提额并写对账。
- **需要重启才生效**（改了页与壳资产，宿主 bundle 随启动装载）。

## 0.4.21 — 2026-10-11

**撤掉「键盘收放时由我复原滚动位置」这一路**——真机埋点证明它是**和浏览器抢写 `scrollTop`**，
而抢写就是用户说的「停在会话中间时屏幕闪一下」。一手读数与判读在
`docs/F真机判读-20261011.md` §7（265 → 1199 条，`rs` 13 次全在中段，6–20 ms 一次来回摆：
`sc 2102 → rs 2145 → sc 2086 → rs 2145`）。

- 0.4.18 加在 `scheduleViewport()` 里的 `restoreViewportAnchor()` 基于两条判断：
  「视口变高时浏览器钳了 scrollTop」**且**「它不发 scroll 事件」，所以必须同一帧补回去。
  **真机两条都错**：浏览器会发 scroll（每次 `rz` 之后 1–2 ms 必有 `sc`），而且它自己的
  scroll anchoring 已经把位置校正住了 ⇒ 我那写是多余的一手，多余的一手与浏览器互相把对方
  当扰动，就成了抖动。**已删除该函数与两处调用**，视口变化期间不再写 `scrollTop`。
- **E 的修复不受影响**（整段重建后按「行号＋距盒顶偏移」复原那条路保留）：复测深滚
  `topIndex 61 → 61`、`scrollTop 2452` 三轮不动、耗时档仍是半程 0.1/0.2 ms、重瞄三次 0.6 ms、
  页内无异常。契约 `test/mobile-assets.test.js` AC-PERF 两条字面随真实文本更新，注释同批改写
  为「这是有意的移除，加回来会红」。
- 收益：壳 267 352 → **267 150 B**（−202 B），预算 268 000 未动。
- 全量 `node --test --test-concurrency=1 test/*.test.js` = **1063 / 1061 pass / 0 fail / 2 skipped**。
- **本笔没治的那一半**：贴着底部时键盘收回**末段**视口冲高 704 再回落 648、`scrollTop` 每轮都跳
  **+56 px**（五轮五轮都在，其中一轮转写本还没打开也照样出现 ⇒ 属视口层，不是 pocket 的滚动代码）。
  要消掉它得改「键盘怎么占位」，是方向决策（A 不压缩内容／B 等高度稳定再对齐／C 稳定 min-height），
  判读文档 §6 列了代价表，**等用户拍**。

## 0.4.20 — 2026-10-11

**修 0.4.19 埋点自己的失明缺陷**（用户 11:38 复现完，日志里 `kbprobe` **0 条**）。

- 根因写在日志里：最后一次装载的是 `doc url=/?revalidate=1` —— 本仓的 SW／离线路径会自己拿查询参数
  改写 URL，所以「开关只看 `location.search`」在第二次装载就变成 false。用户点了输入法、也上滑了，
  页面根本没在记。**这是我这次埋点的设计缺陷，不是操作问题。**
- 改成**持久化标记**：命中 `?probe` 或仍在期内就续一份 **6 小时到期**的 localStorage 凭据，过期自己删。
  临时仪器不留残余，也不需要谁记得去关。
- armed 之后**立刻发一条 `on`**：「有没有开」从此可证，不再靠「日志里没有」反推（那种推理本轮失败了一次）。
- 两个失败分支补留痕：`probe refused`（跨站被拒）与 `probe dropped`（正文清洗后为空）。原先全是静默 403/200，
  所以「没数据」三种成因根本分不开。
- 守卫档 `test/mobile-probe.test.js` 新增一条，钉住上面四条语义，防止开关退回一次性 URL 标记。
- 代价：壳 **+655 B**（zh 266 697 → **267 352** ＝ css 43 971 + js 223 381；en 267 275），
  仍在 0.4.19 已提到 268 000 的预算内（余 648 B），**没有再提额**。
  本行原先写的是「+336 B」——那是我**估的**，实测后改成本行数字；账上不留估计值。
- 另外记一次自踩：改这段注释时我在页内脚本的注释里写了反引号，**直接把模板字符串截断**，
  `lib/pages.js` 整个模块加载失败（`SyntaxError: Unexpected token '?'`）。
  这正是 0.4.13 立的那条规矩（页内脚本是模板字符串出货的 JS，改动先看 PARSE 档），本轮又犯了一次，
  被 `test/script-embedding.test.js` 的 PARSE 档与模块加载当场抓住。

---

## 0.4.19 — 2026-10-11

**临时取证埋点：手机页带 `?probe` 才会记录「键盘收放这一拍里谁在动滚动位置」**。
加它的理由很具体：F（「输入法收回来时整页弹一下」）在模拟里量不出来 —— 四支 CDP 夹具证明
`scrollTop` 被钳到的是 315/102/385 而不是 0，且 +80 ms 之后的采样完全一致，
**模拟里不存在用户描述的「键盘到家了还在往下长」那种延迟运动**（判据见
`docs/HANDOFF-手机8问-EF追加取证-20261011.md` §11）。缺的是一次真机时序，而真机看不到控制台。

- 页面侧默认**零开销**：URL 不带 `?probe` 就不挂监听、不发请求。带上时只记三种事件
  （`rz` 视口变化那一拍／`rs` 锚点复原真的写了 `scrollTop`／`sc` 一次滚动到达），
  攒 1.5 s 批量回传，缓冲上限 30 条。
- 新端点 `POST /api/mobile-probe`：**只接受同源 + 已鉴权的手机会话**，正文限 4 KB，
  字符白名单 `0-9A-Za-z|/@.:-`（**换行不在内** —— 折成空格，一次请求伪造不出第二行日志），
  一秒内的连发丢弃。落 `pocket.log` 一行可 grep 的 `kbprobe device=… <序列>`。
  契约测试 `test/mobile-probe.test.js` 钉四条：未鉴权进不来、清洗、限流、日志行数不膨胀。
  （写测试时才发现第一版白名单放了 `\s` ⇒ 能注入换行伪造第二行；改的是代码不是断言。）
- **代价与到期日**：壳 +1 143 B（zh 265 554 → 266 697），`ASSET_BUDGET_BYTES` 266 000 →
  268 000。这是**有到期日的提额**：F 量完、埋点摘掉后要把预算降回 266 000
  （对账写在 `test/mobile-assets.test.js` WP1 上方）。
- 摘除清单（量完照做，别留在树上）：① `lib/pages.js` 的 `PROBE_ON`/`probeMark`/`probeSend`
  与三处打点；② `lib/bridge.js` 的 `/api/mobile-probe` 路由；③ `test/mobile-probe.test.js`；
  ④ `test/pages-scroll-anchors.test.js` 里被 `probeMark` 撑长的 `topEdgePull` 字面断言改回原样；
  ⑤ 预算降回 266 000；⑥ 另起一笔记「已摘」（已发布段落不改写）。

## 0.4.18 — 2026-10-11

**手机端过程折叠只说「做了哪一类事、做了几次」，不再说动了哪个文件、跑了哪条命令**（用户原话）：
「在手机上面，根本就不需要看到『调用了什么工具』、『打开了什么文件』。」

- 折叠里剩下的信息：类别短语（沿用桌面端的措辞，如 `已读取文件` / `已执行命令` / `修改了文件`）
  ＋ 条数（同类超过一次才给，如 `3 次`），失败照样挂 `失败` 两字。**文件名、命令、diff 行、
  原始 JSON 一律不再绘制到手机上。**
- **数据照样全量传到手机**，只是不画出来。想看细节的把「过程」设置切到**完全展开**（verbose）
  这一档——四档设置（简洁／标准／详细／完全展开）与桌面端同源，切回去细节立刻回来。
  留这一档是为了「哪天又想跟桌面一样看透传」时不用改代码。
- 顺带修掉一个真 bug：`tool/result` 事件的线上形状早就变了（正文在 `data.message.content[0].text`，
  callId 在 `message.toolCallId`），而手机端还在按旧形状（内层 `type:'tool-result'` 块）去取，
  取不到 ⇒ 工具块的参数与结果恒为空、状态永远停在 running，所以**折叠里只剩那五个字、里面一片空白**。
  现在三种形状（新／旧／callId 缺失回退本步最后一条 running）都能读出来。

量到的效果（同一个重回合，6 个工具：3 次 read + 一次 90 行 write + 一次 60/60 行 edit + 一次 grep）：

| 档位 | 字符 | UTF-8 字节 | DOM 节点 |
|---|---|---|---|
| 标准（新默认） | 1 660 | 1 736 | ~43 |
| 完全展开（旧默认） | 25 141 | 25 303 | ~388 |

即这类回合的过程区少掉约 **93% 字节 / 89% 节点**。真正能被感知的不是快慢，而是**屏幕不抖**——
标题里不再塞变长文件名，长 `<pre>` 也不再顶走滚动锚点。

### 手机页导航不再重新加载（五条）

施工账 `docs/HANDOFF-0.4.17-导航五条-20261011.md`。起因是用户口述的一个说不清的不适感
（「返回会话列表好像又要重新加载一次，进新会话又加载一次」）。诊断：**视图切换本来就是 SPA 的**
（`pushState`，文档不重载），不对的是数据模型——每次导航都重新向桌面端证明一遍数据是新的。

- **列表只建看得见的行**：`renderWorkspaces()` 原来给每个工作区的**每一条**会话都生成行 HTML，
  折叠只靠 CSS `display:none` ⇒ 折叠一个字节都不省。改成只建展开区的行，实测每次刷新列表 markup −300 KB。
- **图标不再内联三次**：同一份 data-URI 在文档里出现三次 ⇒ 冷开文档 −31.7 KB（改走 `/app-icon?ui=1`）。
- **索引 Map 移出工作区循环**：原来每个工作区都重建一遍索引。
- **按下去就预取**（`prefetchSession`）：把「进会话」那一次隧道往返挪到手指底下，点击与取数据并行。
- **隧道空轮询改握等新帧**：延迟上限从 6 s 降到近零。
- **字节账**：壳预算 `ASSET_BUDGET_BYTES` **261_000 → 263_000**（zh 现值 261 996 / en 261 917，
  余约 1 KB）。理由：壳带内容哈希 + `private, max-age=604800` + service worker ⇒ 这 1.8 KB
  **每个装机版本只付一次**，换回来的是**每次开页都省**。逐笔增量账写在 `test/mobile-assets.test.js`
  WP1 上方注释（本仓规矩：the diff of this test is the receipt）。
  ⚠️ 这条提额是在用户「先做了再决定」的授权下自行做的，**否决只需把常量改回 `261_000` 并砍掉预取那条**。

### 电脑端配对页：配对码 8 位 → 6 位，文案去技术腔

施工账 `docs/HANDOFF-配对页文案与PIN位数-20261011.md`。用户 2026-10-10 口述六条，全部照做：

- **配对码 8 位 → 6 位**（`lib/constants.js` 的 `PAIRING_PIN_DIGITS`，唯一改点；`PAIRING_PIN_SPACE`
  自动跟随。`MIN=6`／`MAX=12`／`^\d{6,12}$` 都不动 ⇒ **已配过的手机不受影响**）。
- 页内大标题「连接移动设备」**整块删掉**（不是改名）。
- 二维码刷新时的「正在创建全球网络链接」换掉；「WiFi 连接模式／互联网连接模式」改叫**局域网／公网**；
  删掉 4G/5G/WiFi 那段枚举，并消除页面里第二个「Wi-Fi」概念。
- Cloudflare 固定域名地址直接做成**可点超链接**，不再讲原理。
- 所有「手机连接 / Phone connection / Connect Mobile Device」统一改称 **Pocket**
  （标题、iframe 标题、打开中提示、失败提示、注释同步）。

### 手机端八问批次（用户 2026-10-10 23:08 一口气报的八条）

取证账 `docs/HANDOFF-手机8问取证与修法-20261010.md` ＋ `docs/HANDOFF-手机8问-EF追加取证-20261011.md`
（含真 Edge headless + CDP 390×844 的实测读数）。逐条对外变化：

- **A｜微信推送现在看得出是哪个会话**：通知第一行原本是「N 个会话已完成」，会话名沉在正文里，
  而微信通知栏/锁屏**只显示第一行** ⇒ 现在标题在 80 字预算内尽量把名字列上
  （`2 个会话已完成：写周报、部署`），一个名字都塞不进就退回原形状（不砍半个名字），
  只列下一部分就补「等」，不假装列全。提问那封（挂号信）原本在会话列表读不到名字时会把
  **sessionId 原样印成标题** ⇒ 先强刷一次列表再放弃，仍取不到就说「会话」，机器 id 不再冒充名字。
- **G｜手机凭证改成绝对时间**（**行为契约变化，代价写在这**）：原来每次重新配对/隧道恢复都把
  凭证到期拨回满 30 天 ⇒ 档案永远不会老、`/pair/verify` 的「已知设备免桌面确认直接发 cookie」
  永远成立，30 天退化成「多久摸一次 PIN」的闹钟（而 PIN 本身不过期）。现在**重签不延长到期线**：
  只有两条路能推后它——档案确实已过期（按新设备重走完整漏斗）、或你在桌面点「延期」（人工动作）。
  **后果：从首次配对算满 30 天后，这台手机必须回桌面确认一次才能再上公网**；cookie 的 `Max-Age`
  同步按真实剩余寿命给。隧道每次重开换域名的场景不受影响（那本来就要重走一次 PIN）。
- **H｜AI 运行中「停止」不再被草稿顶掉**：原来输入框里只要有一个字，右下角就变回「发送」，
  想停停不了（实测 `draftLen=5 ⇒ 停止钮隐藏`）。现在运行中停止永远在，有草稿时发送与停止**并排**。
- **B｜↑ 翻到自己第一条提问后不再当场消失**：门槛原本是「视野上方还有没有我发过的消息」，
  翻到第一条就关门，可上面还有更早的一页没取 ⇒ 现在把「还有更早的一页可取」也算进去，
  点了却没有上方提问时去取那一页，不留死按钮。
- **C｜上下按钮的箭头回到圆心**（实测偏移 右 2.5px／下 0.5px → 0／0）：`.anchor-fab` 补 `padding:0`。
- **D｜圆形按钮按下去不再出现方块高亮**（八枚圆按钮原本都吃安卓默认的矩形 `tap-highlight`）。
- **E｜上滑时新消息不再把整段甩走**：任何一个非 chunk 事件（工具开始/结束、回合边界……）原本都触发
  整段 `innerHTML` 重建，重建后所有历史行都是新节点、「记住上次量过的尺寸」失效，整段高度塌缩，
  人正在看的那条在内容坐标里丢了。深滚基线（60 轮、滚到 25% 处推一帧 `tool/start`）实测：
  视野第一行 **index 61 → 113**、`scrollTop` 被推到 3566（窜 1114px）。
  现在重建后按「行号 + 距盒顶偏移」复原，并在 120 ms 内重瞄 3 次——上方各行是**逐渐**量开的，
  只做一次同步复原会过冲到另一头（实测 61 → 9，恰为基线偏移的镜像）；前置补页那条路自己管滚动，跳过一次。
  复测：`61 → 61`、`scrollTop 2452` 不动，稳定档一致、页内无异常。
  **代价**：壳 +2 554 B（zh 265 554 ＝ css 43 971 + js 221 583），`ASSET_BUDGET_BYTES` 263 000 →
  **266 000**，对账写在 `test/mobile-assets.test.js` WP1 上方；页内长注释已先压成两行指针
  （中文注释 UTF-8 每字 3 字节，而壳量的是出货后的字节）。壳带内容哈希 + `private, max-age=604800`
  + service worker ⇒ 这笔字节**每个装机版本只付一次**。
- **F｜键盘收回时整页弹一下——本版本未修**：模拟里能复现的两件事都**不是延迟运动**。
  ① 短会话那截贴底自动间距随视口伸缩（`::before` 的 `margin-top` 实测 574→150→574），整段平移一个键盘高度；
  ② 视口变高时浏览器在同一帧把 `scrollTop` 钳回去（实测 739→315、526→102、764→385）。
  **这一帧是真的会发 scroll 事件**（事件计数 1→2、2→4）——账上原先写「它不发 scroll 事件」是错的，本轮改过来；
  但钳完 `scrollTop === maxScrollTop`，人仍在底部，那是正确行为、不是 bug。
  我先前押的第三条链（`scrollTop` 被砸到 **0** ⇒ 顶边自动取页把布局变化误判成「他划到顶要读更早的」
  ⇒ 前置一整页再回弹）**已被四支夹具证伪**：砸到的是 315/102/385 而不是 0，且开场填充必然过冲，
  模拟里造不出「收键盘后内容才短于视口」那个窗口 ⇒ 「到顶自动取页须由真人手势授权」那版修法**没有依据，不做**。
  用户说的是键盘**到家之后还在往下长**，而所有采样在 +80 ms 已稳定 ⇒ 缺的是真机上
  `visualViewport.resize` 与 `#messages` scroll 的时间戳序列那一次观察，量到再改。
  四支夹具的完整读数见 `docs/HANDOFF-手机8问-EF追加取证-20261011.md` §11。

## 0.4.17 — 2026-10-10

**通知规则砍到三条**（用户原话）：「只有特殊消息立即发；你进手机端立即重置待发送，打个时间戳啥的；
否则最早一条满 15 分钟打包发一条摘要。就这么简单。」

0.4.15 那套 **15 / 30 / 5** 被判定「太复杂了，我跟你讨论了蛮久」。三个阈值里有两个被删掉，
只留**一个**时间尺度：

- **`rideMs`（末班车：安静 15 分钟才走）删掉。** 它和 15 分钟的封顶是同一件事的两种量度——
  不打扰人的办法是「固定等 15 分钟」，不需要「沉默一会儿」这个概念。原来「15 和 30 有啥区别」
  那个问题（任务一直不停完成时 rideMs 永不满足、只能靠 holdMs 兜底）随之消失。
- **`lettersMax`（装满 5 件就走）删掉。** 同样是拿条数去逼近同一个时间尺度。一封摘要列得下几行
  与**什么时候发**无关，所以列名上限另立常量 `NOTIFY_MAIL_LIST_MAX = 8`。
- **`holdMs` 30 分钟 → 15 分钟**，成为唯一尺度：**最早那件压满 15 分钟就走**，
  后来者搭同一班车（只取不筛，一封摘要带走这一班里的全部）。

新增第三条规则：

- **进手机端就重置待发送**（`mailbag.notePresence()`，由 `GET /api/status` 触发）。
  人在页面里露一面，包里那几件的时间戳全部改写为此刻，15 分钟从「他放下手机」开始数。
  只动时间戳：不取走、不丢弃。空包什么都不做。
  **这不是「在场就不推」**——是「刚看过就不用再告诉他一遍」；他也从没要求过静默，
  要的是**别在刚看完之后马上又来一条**。
  判据是页面可见时每 8–10 秒一次、切后台零次的那个状态轮询（页内所有轮询都带
  `if(document.hidden)return`）。**判断错了只会多推**：没网／息屏久了心跳停 → 当成不在 →
  照发，而那时人确实不在。状态只在内存，重启后重新数一次，无妨。

「两小时作废」已在 0.4.16 节取消，这一版不涉及。

### 桌面管理页：任务通知板块不再被藏掉

已配对（也就是日常打开 `/desktop` 的那个状态）时，页面上的**任务通知**板块整块不可见，
只能在「设备与通知」这一栏里看到设备列表。原因是 `.phone-connected .pairing-content{display:none}`
这条 CSS 在手机已连接时把整个 `.pairing-content` 容器隐藏，而通知面板（连同隧道配置面板、
待确认接入列表）一直被渲染在**这个容器里面**——元素在 DOM 里，只是永远不显示。
未配对时同理：默认视图是「公网」，面板不带 `show` 类，也不显示。

修法是把这一组面板移出 `.pairing-content`，改为 `.wrap` 的直接子节点（同一个页面、
同一套样式，位置不变）。`test/connected-devices.test.js` 新增一档钉住「通知面板不得是
`.pairing-content` 的后代」，免得这类嵌套以后再回来。

**「锁死在设备与通知」不是这一处造成的**：手机已连接时 `btnLan` / `btnTunnel` 两个模式键
本来就置 `disabled`（连接模式下改传输方式没有意义），`btnDevices` 始终可点。这是既有设计，
本版未改。

## 0.4.16 — 2026-10-10

**在微信里说一句话，就能拿到 Pocket 的公网地址**；同时**取消邮包的「两小时作废」**，
并**修好移动端几处点击与滚动的手感**。

### 桌面之外的手感（合并自另一条工作线 `c482925`）

- 模型选择、设置项等再也不「点一下面板就重建」——面板原地更新，不再闪。
- 打开会话设置不再为了几行字去拉一次整表 `session.list`。
- ↑/↓ 统一时机：只剩一道门 `dist > SCROLL_FOLLOW_PX`，两个按钮同时出现、同时收起。
  ↑ ＝ 跳到视野上方的最近一条用户消息，跳过去后它进视野，再按即回翻上一条（无需游标）；↓ ＝ 回底部。
  删掉 `ANCHOR_LATEST_SCREENS` / `ANCHOR_LEAVE_SCREENS` / `ANCHOR_PROMPT_SCREENS` 与「整屏间隔」条款
  ——那条就是「↑ 当着人面消失」的原因。`anchorVisibleState(dist, anchorAbove)` 换成单一阈值。
- 每个 AI 气泡各带自己的时间：`renderMessageTail` 的门从「整轮在跑就全隐藏」改成
  「这一条自己还在流式就不显示」。随之翻掉三档旧契约：A16 / A18（每轮一枚钟 → 每气泡一枚，
  usage 药丸仍只有一枚）、T1（中间 step 现在也有钟）。
  **遗留**：`test/turn-footer-meta.test.js` 文件头与 694 行注释仍写着旧的「每块一钟已废／读 agentRunning」，
  该线本轮预算耗尽未清理，以该档 A16 / A20 的新注释为准。

### 微信入站 → 拉隧道 → 回地址

一条入站消息现在除了续额度，还会让桥去确保公网隧道在跑（或发现已在跑），并把地址回给你。
这就是「最小的远程入口」：桥本来就有隧道开关（桌面 UI 与手机页面按的是同一个 `toggleTunnel`），
这里只是让**一条经过认证的微信入站**也能按下它。因此：

- **没有新增任何 HTTP 端点**，桥也没有多出任何可以被外部触碰的入口——触发器只有一个，
  就是那条入站消息，而那条路上只有绑定过的人能说话。
- 地址不是立刻就有（cloudflared 冷启动可能要下载），所以这一段是**异步**的，不挡入站循环的下一轮。
- **只在地址真的换了时才回话**（用户当天问过「那正常发，他就每次返回地址吗？」）。
  每次照抄一遍同一个地址是噪音，还会白吃一条出站额度。地址换了（新隧道＝新观众）才值得说一句；
  隧道**没打开或报错时每次都回**——那本身就是你要知道的答案，沉默会被当成消息丢了。
- 这条交接**不占额度计数**（不走 `clawbotQuotaTail`）：它不是一条通知，一条入站地址只交接一次。
  占掉「第 1/10 条」那个位置会让紧接着的真通知从第 2 条起数，而那个序号是给你看「还剩几条」的。
- 换地址意味着换观众：新隧道会作废旧的一次性 PIN，手机上需要重新配对一次
  （配对页打开即自动生成地址，见 0.4.14）。

### 邮包的「两小时作废」整条取消

原来「压过 2 小时的平邮不再寄」。它**永远轮不到触发**：正常路径一封信最多躺 30 分钟。
它唯一会生效的场合是「额度耗尽、信发不出去」，
而那正是**最不该丢信**的时候——微信那头卡一上午，通了就该一次全发过来。

代价是包会越积越多，用户 2026-10-10 明确接受。`take()` 现在只取不筛。

## 0.4.15 — 2026-10-10

推送节奏重定：**15 / 30 / 5**（原 10 / 20 / 8）＋ **提问时把攒着的一起发**。

三个阈值是**并排的 OR 触发，不是接力**——这一条是本版最容易被误读的地方，用户当天专门问过
「15 分钟和 30 分钟解决啥问题？安静 15 分钟再发，那它永远不会到 30 分钟啊」：

- **`rideMs` 10→15 分钟（末班车）**：这一波没有新的了就发。它**只在「人停手了」时才满足**。
- **`holdMs` 20→30 分钟（封顶）**：最早那件压到 30 分钟必走。**它不是 rideMs 之后的第二段**，
  而是反方向的保险：任务一个接一个不停完成时，rideMs 永远不满足，只有它兜底，
  否则最早那件会被后来者无限压住。例（每 10 分钟完成一个）：0/10/20 分钟都只有安静
  10 分钟不够 15，到第 30 分钟 holdMs 触发，一次全寄。
- **`lettersMax` 8→5（装满即走）**：专治任务极密——攒到第 5 件那一轮立刻发车，前两条都不用等。
  它同时是信里列名的上限（超了折成「另有 N 个就不列了」），所以 8→5 也让单封信更短。

**提问时顺路带走攒着的**（用户当天拍：「提问时，包里攒着的一起强制发」）。原来提问那条自己立刻就走
（挂号信不攒），但邮包里的那些还得等 15/30/5 谁先满足，于是同一次「有件事等你」被劈成两条消息
（提问现在到、完成通知十几分钟后才到）。现在提问投出去之后立刻补一班车：`flushOrdinaryOnRegistered()`
——包里是空的就安静返回（绝不因为这条理由多发一封），有攒的就跟着走。

### 验证覆盖

字符层 1030 档（含 `mailbag.test.js` 的班次表断言同步改成 15/30/5）；HTTP 层 `test-real-webserver.mjs`。
目验：任务停 15 分钟来一封 / 连着跑满 30 分钟来一封 / 攒够 5 件来一封 / 提问那条到了之后紧跟着收到攒着的。
装机不即上线：需重启 DeepSeek Harness。

## 0.4.14 — 2026-10-10

真机第二轮反馈的三条。前两条是上一轮的判断失误，写清楚免得再犯。

- **两个跳转按钮的位置摆正**：原来 DOM 里「回最新」在前，于是 ↓ 占上格、↑ 落在下格——
  箭头指向和所在格子正好相反。现在 ↑ 在上、↓ 在下，各占固定格子，位置永不互换。
- **↑ 不再在往上翻时消失**：上一轮我留了「提问必须在视野上方**整整一屏**才亮 ↑」的门槛，
  结果你一翻过上一条提问，↑ 就当着你面没了。现在 ↑ 找的是**视野上方最近的那条提问**
  （`userAnchorEl` 从最新往前扫，取第一条位于视野上沿之上的），所以只要上面还有提问它就一直在，
  连着按还能一条一条往回翻。「贴底那一屏什么都不亮」这条 0.4.4 的门槛保留。
  aria 名字也从「回到我最近的提问」改成了「上一条提问」——现在的语义确实是往回翻。
- **模型／推理强度／预设改成页面自绘列表**：前两轮我只改了**合上的框**（字号、箭头、缩进），
  而你点开看到的是**手机系统自己画的选单**，CSS 一点进不去——所以你说「好像没改」，是对的。
  现在点开就在面板里就地展开一列：服务商作小标题、行高 44px、15px 墨色、当前项品牌色加 ✓、
  列表自己滚动。原生下拉彻底不用（连带删掉 `.setting-field select` 那套样式与 `syncEffortOptions`）。
- **电脑端配对页默认停在「网络」那一档**：以前只有隧道已开着才停公网，否则落局域网——
  而你这儿每次都是从公网连的，等于每次都得先点一下。现在默认公网档；**隧道没开时不再挂着
  一张局域网二维码冒充公网链接**（二维码留空，地址行显示「网络链接生成中…」）。

### 打开配对页＝要连网（用户裁定，同日补做）

「一点进去就该已经连好」这条我上一轮留了个"等你拍"，你回了：**开机自启不要，但人点进配对页本身就是意图**
——「你都点进去了，肯定是要生成网络连接的呀」。照此实现：配对页加载完就自己发起公网隧道
（`if(!phoneConnected&&selectedTunnelTab&&!tunnelActive)void switchMode(true)`，跑在 800ms 状态轮询之前），
于是你看到的就是「网络链接生成中…」＋进度条 → 二维码，中间那一下"开启网络"不用点了。
三个条件缺一不可：**没手机连着 ＋ 停在公网档 ＋ 隧道确实没在跑**，所以连上之后重开页面不会去动隧道。
**开机自启这条按你的意思不做**（那条 10-09 08:55 被回退过的实现仍躺在 stash `pocket-tunnel-autostart-and-address-push-REVERTED-20261009` 里，不复活）。

### 验证覆盖

字符层 1029 档＝1027 pass / 0 fail / 2 skipped（复跑一次为准；首轮 `notify-judge` 一档在全量负载下假失败，
单跑 13 pass——本仓既有负载敏感档，按规矩先单跑甄别再定性）。HTTP 层 `test-real-webserver.mjs` 12/12。
壳预算 258_000→261_000（自绘列表 +1.3 KB，对账单在 WP1 注释；现 zh 259266 / en 259193，余 ~1.7 KB）。
**渲染层与实机层未覆盖**——这三条恰恰是"我以为改好了、手机上一看没改"，所以目验清单写在回复正文，
请逐条在手机上确认。装机不即上线：需重启 DeepSeek Harness。

## 0.4.13 — 2026-10-10

七条都来自手机上的实际手感（2026-10-10 用户三轮口述），逐条改行为不改解释。

### 变更（用户可见）

- **↑ 不再被 ↓ 顶掉**。原来划一屏出 ↑，划过一屏半把 ↑ 换成 ↓——同一个位置、不同箭头、
  相反目的地，使劲往上翻的人正在够 ↑，结果「咚」一声踩中的是回底的按钮。现在两个按钮
  **各看各的目标**：↑ 只管「我最近的提问在上方一屏之外」，↓ 只管「底部还差一屏半」，互不驱逐。
  贴底那一屏仍然什么都不显示（0.4.4 那条规则一字不动，它治的是「没动就亮按钮」）。
- **上拉加载更早：阈值 72→26，且够到就定**。原来得拖出约 144px 手指行程才算数，
  猛一挥落在顶上还是「请继续下拉」。现在一指节即武装，武装后**只有把手指推回起点之上**才取消。
  另外新增**划到顶自动补一页**：落在顶上这个动作本身就等于「给我更早的」，不必再补一次
  小心翼翼的下拉。每次落到顶上只补一页（离开顶部才重新上闩），已读位置不会被新页顶走。
- **会话设置里的三个下拉重做质感**（模型／推理强度／预设）：46px 实心控件、15px 墨色正文、
  自绘箭头替掉系统箭头——「字体还空了两格」的成因就是系统箭头前那片内缩叠上了控件自己的
  padding；另加聚焦描边，展开后的选项与分组同一套字号字色。目录里带回车／全角空格的模型名
  统一折叠修剪，名字不再顶着空格进框。
- **连接页一打开就在加载网络**：① 重连页的静态壳预热从「交接阶段里」提到「页面第一帧就发」；
  ② PIN 页与重连页的 workspace／会话列表／boot 三次隧道往返并成一次并发（进度行按到货顺序点亮，
  且只前进不回退）；③ 桥侧新增 `prewarmMobileBoot`——未配对的手机落在连接页、或隧道刚起来时，
  就把冷路径上最贵的那一次宿主读（会话目录，实测 469 行 / ~195 KB / 465–719 ms）提前做掉，
  等 PIN 验完直接吃热缓存。节流 20 秒，刷新页面不会把宿主踩响。

- **工作区行末的「N 个任务」整个摘掉**（用户 2026-10-10：「我要这个数量干啥呢？直接不传吧」）。
  它本来就不是宿主传过来的字段，是手机页面上拿 `sessionIds` 现数出来的——数出来的那批行
  已经按「子代理会话不进列表／归档不进列表／空壳超过 24 小时不算」筛过了，行本身就在，
  数字只是把同一件事再说一遍。顺带删掉 `taskUnit` 两条文案与 `.ws-count` 样式。
- **下拉加载更早时不再出现两句提示**（用户 2026-10-10：「一个动的一个不动的」）。病根：手势旁白
  `#pullHint` 钉在列表上方不动，列表里那条「更早的消息」跟着手指往下走，两句说的还是同一件事。
  现在手势接管期间（`#pullHint.visible`）列表里那条直接不画——一条事件只有一个指示器；
  轻点那条行／自动补页时行照常说话，因为那时手势没接管。

### 边界（不是能优化掉的等待）

手机**还没配对时读不到会话内容**——内容路由按设计是鉴权门（硬约束 7 的范围就是「连接＋会话读写」）。
所以「预加载网络」提前的是三样：隧道通道本身、静态壳、桥侧那一份目录。真数据仍在验完 PIN 之后取，
只是那时它只需要一次往返。

### 回合分组改了：思考折长在它产出的那段答复上（用户选 A）

取证过程（不改代码先看清）：把本机两份真会话（`2b457e49…`／`3bfb7413…`）的记录，经
`compactSessionRecords`（手机真正拿到的字节形状）喂给**出货的** `visibleMessages`，
渲染序列里确实出现 `[text] [reasoning] [text]`。根因不是时序错——宿主一个 step 的 content 数组本来就是
`[reasoning, text, tool-call]`（16:4x 重跑计数：两份会话里这种「思考开头＋文字」的记录分别 97 处与 6 处；
会话仍在追加，数字会漂），而手机把一个 step 的思考攒进组里、
**等下一段文字到达才落组**，于是那个「思考」条目挂在上一段答复之后：时序对，归属看着错。

- **改后**：一段 step **开头的**思考不再单独成条，它和它产出的那段文字合成**一条消息**
  （思考折在上、文字在下，同一个消息体内）。真会话重跑后序列变成
  `过程卡(…) [reasoning+text]`，两条会话里每一段答复的思考都贴在自己答复头上。
- **没动的两件事**（故意的，不是漏）：
  ① 一段只有思考、自己没产出文字的思维流，仍照旧落进累积组（有工具就并进过程卡），
    不硬塞给别人的答复；
  ② 模型**答完之后**接着想的思考（content 里 text 在前、reasoning 在后）仍显示在答复下面——
    它确实发生在后面，把它提到上面去就是编故事。真会话里这种形状一份都没有，所以是低频尾案。
- 副作用（已知可接受）：折叠展开状态的 key 整体位移一次（`turn.key#thinkN` 计数变了），
  重启后第一次打开旧会话时，用户手动展开/收起的那点偏好不延续——数据无损，纯观感。
- 新增 4 档测试 `MERGE-1..4`（在 `test/visible-interleave.test.js`，与 INTERLEAVE-* 同一套
  白盒沙箱，跑出货函数本体，不是字符串锚）。

### 验证覆盖

字符层 1028 档全绿（2 skipped 为既有）；HTTP 层 `test-real-webserver.mjs` 12/12。
`ASSET_BUDGET_BYTES` 保持 258_000：本轮回合分组 +652 B，靠摘掉工作区任务数（−~130 B）
与压注释/局部变量自用的部分抵掉，落到 zh 257945 / en 257872——**余量只剩 55 B / 128 B，
下一笔增量要么自己挣回来，要么按规矩提额并在 WP1 注释写对账单**。
**渲染层与实机层未覆盖**（本机读不到手机屏），行为要真机目验（目验单见交付回复）。
改动需重启 DeepSeek Harness 才生效。

补一条本轮抓到的东西：页内脚本是「模板字符串出货的 JS」——改坏了 `lib/pages.js` 自己照样合法、
字节数照样对、字符串锚照样在，只有浏览器会白屏。第一版就是这样给 PIN 页漏了一个右括号发出去
（套件全绿而页面不可解析）。已加 `PARSE:` 守卫档（`test/script-embedding.test.js`）：八个页面的
每段内联脚本连两份壳资产一起过 `node:vm` 编译，编译不过就红。

## 0.4.12 — 2026-10-10

（本节当天改写过一次：这一版从提交到现在的中间形态从没进过运行中的宿主（改动要重启才生效），
所以把它定稿成最终样子，而不是再立一个没人见过的版本号。）

### 变更（用户可见）

- **攒着一起寄：邮包**。一条入站只换 10 条推送额度，而老写法是**每个跑完的会话各寄一封**：
  一分钟里多几个会话交活就能把 10 条一次烧穿（本机 2026-10-10 09:34:23 实测：一秒 13 发、12 发被拒），
  紧跟着真正要命的「有提问等你回答」也就寄不出去了——省下来的额度本来正是留给它的。
  现在跑完的事先进邮包，攒成一封寄：标题 `5 个会话已完成`，正文逐行列名字。
  只跑完一件事时**形状和 0.4.10 完全一样**（标题＝会话名、正文＝已完成），已验收的样子不动。
- **什么时候发车**——按你给的尺度定（「完成通知十几二十分钟能接受」），不是固定延迟：

  | 条件 | 什么时候寄 |
  |---|---|
  | 包里攒够 8 封 | 立刻寄（一封装得下 8 个名字，多的折成「另有 N 个就不列了」） |
  | 最后一封进来后安静 10 分钟 | 寄——这一波收尾了，没必要再等 |
  | 最早一封压了 20 分钟还没走 | 强制寄，后面信来得再密也不能把它压没 |
  | 你按了桌面「测试」／在微信回了一句 | 顺路带走，不多等一班 |
  | 一封压过 2 小时 | 不再寄了（隔半天的「昨晚跑完了」是噪音），并在日志里说丢了几封 |

  只跑完一件事时你大约 10 分钟后收到；连着跑一批则最迟 20 分钟一趟、装满 8 件立刻走。
  **入站那一次最特殊**：额度刚续上，而且你正在看手机——攒着的事此刻最有人读。
- **「通道已就绪」回执只在第一次绑定时发**。它自己要吃掉一条额度（10 条里的第 1 条），
  而续期时它已经没信息量了——每条推送都写着「第 N/10 条」，再发一句「已就绪」等于白拿一次投递机会说废话。
  之后每次你在微信回话，那 10 条额度整条留给你用。
- **额度用尽时不再丢消息**：服务端回 `prepare failed`（＝这一轮寄不动了）时，信留在包里，
  等你在微信回一句自动补发，不再每 30 秒撞一次墙。此前这类失败是**直接丢掉**的。
- **「有问题需要你回答」是挂号信**：不进邮包、到了就投；这一轮投不出去就留在手里，
  下一次入站第一件事补投它。
- **邮包落盘**：攒着没寄的完成通知写进数据目录的 `notify-mailbag.json`（写盘纪律同设置档：
  同目录临时文件＋原子改名＋`0600`，读坏了就当空包）。**宿主重启不会再把包清空**——
  今天这台机重启了好几次，而「等下一次入站再寄」这件事本来就必然横跨重启。
  挂号信**故意不落盘**：那条「等你回答」现在还成不成立只有活着的桥知道（可能已被回答、或随宿主重启消失），
  存下来重启后再补一发是拿过去了的事催人。
- **桌面「测试」现在能区分两种失败**：回答多了 `held`（包里还攒几封）和
  `quotaSpent`（是不是这一轮额度用完了），不再只有一个含糊的 `delivered:false`。
- 0.4.11 的计数继续有效：合并后的整封只占**一条**额度、序号 +1（8 件事合成一封＝8 倍的消息花同样的额度）。

### 施工账

- 新模块 `lib/mailbag.js`：邮包本体，纯函数＋注入时钟（装满／末班／封顶／过期作废四个条件、按会话去重、
  挂号信不合并且溢出丢最老的、装信形状按「理由是否相同」决定要不要在正文里重复）。
  落盘与恢复不在这里做，只留 `ordinaryLetters()` 与「带 `inAt` 投回来」两个口子；
  作废时限只有 `ttlMs` 一处，不在恢复路径上再写第二个。
- 新模块 `lib/mailbag-store.js`：`notify-mailbag.json` 的读写，纪律照 `settings-store.js`／`session-store.js`
  （同目录临时文件 + 原子改名 + `0600` + 目录按需建；读坏了＝空包）。只存平邮、不存挂号信，理由写在模块头。
- `lib/bridge.js`：`NOTIFY_MAILBAG` 班次表（lettersMax 8 / rideMs 10 分钟 / holdMs 20 分钟 /
  registeredMax 8 / ttlMs 2 小时）、`sendMail(reason)` 发车、`quotaBody()` 保证「第 N/10 条」不被截断、
  `markClawbotQuotaSpent()` 与服务端定性联动，以及 `scheduleMailbagPersist()`／`flushMailbagPersist()`／
  `restoreMailbag()` 接上落盘（`stop()` 里先 flush 再清引用，理由同 session：关桥是重启边界，不是包空了）。
  完成点改为进包，提问点改为失败可补投，轮询末尾判班，入站后续期＋发车＋顺路；
  就绪回执的判据从「令牌变了」改成「存档里原本没有令牌」（＝首次绑定）。
  **换通道时解除「额度已尽」**：清掉这个标志的唯一事件是 clawbot 入站，改去 Server酱／Bark 后再没有入站，
  不解除就是永久停摆。
- `lib/notify.js`：ClawBot 分支新增 `hooks.onQuota` —— 只有服务端说
  `prepare failed`／`invalid arguments`／`ret -2` 才算「这轮寄不动」；网络抖动不算，
  免得一次代理超时把推送无故停到下次入站（同 hermes-agent #80125 的教训：那句 errmsg 被别人误当限频过）。
- `lib/index.js`：接上 `createDefaultMailbagStore()`（与设置档、会话档同数据根）。
- 测试 23 条：`test/mailbag.test.js` 14 条测班次（含「新信一直来会把末班车一直推迟，所以封顶兜住最早那封」
  这条容易被忽略的组合），`test/mailbag-post.test.js` 9 条测接线（装满即走且折行的说出来 / 单件等末班 /
  额度拒后留存并在**同令牌入站**时补发 / 首绑才发回执 / 挂号信可补投 / 桌面测试顺路 /
  **落盘与重启恢复**（含挂号信不落盘）/ 换通道解除挂起 / 未配置时静默且不攒）。
- 旧的三处「settle 即出站」断言按新契约改写（不是放宽）：先断言「进包未发车」，再把时钟推过末班断言发车。
- `CHANGELOG.md`／`package.json`：0.4.11 → 0.4.12。

## 0.4.11 — 2026-10-10

### 新增（用户可见）

- **微信 ClawBot 的推送带上额度计数**：正文末尾多一截「第 N/10 条」，用完之后改说
  「已超 10 条，在微信回一句就续上」。微信侧**一条入站消息换 10 条出站**（本机 2026-10-10 11:00
  受控实验实测：就绪回执 + 9 条推送全部成功，第 11 条起 `ret=-2 prepare failed`），
  这个刻度是**能推几条**的唯一可见线索——不然只能在手机上干等。
  - 计数在**任何一条入站消息**上归零，包括 `context_token` 字符串没变的那种（同一条对话线常给出同一个串，
    那种入站照样续额度，只是不触发就绪回执）。
  - **就绪回执自己也占一条**（它就是第 1 条），所以「绑定后发一句」那一轮实际还能推 9 条。
  - 只加在 clawbot 通道上；Server酱／Bark／WxPusher 没有这份额度，一个字都不加。
  - **它是提示不是保证**：桥一重启本地就从 0 重数（真额度可能早就用完）；独立探针脚本与桥共用同一份 10 条，
    也会把读数打偏（见 `docs/HANDOFF-0.4.10-clawbot-copy-20261010.md` §5 铁律 5）。
    计数是**预占**（算标签时就 +1，发送失败不回滚）——并发下「先算后发」会撞出同一个序号，
    而失败的那条本来就出不了门，回滚反而把序号骗小。

### 施工账

- `lib/constants.js`：新增 `CLAWBOT_QUOTA_LIMIT = 10`（注释记实测与官方口径的出处）。
- `lib/bridge.js`：`clawbotQuotaTail()` ＋ `refillClawbotQuota()`，状态 `clawbotQuotaUsed` 纯内存；
  四处出口（完成、提问、桌面「测试」、就绪回执）接上尾巴，归零挂在每条入站上。
- `test/clawbot.test.js`：新增两条——计数语义（含超限措辞与其它通道不加字），
  以及**尾巴真的进了发给微信的那段文字**（含「同令牌重复入站也归零」这条实测行为）。

## 0.4.10 — 2026-10-10

### 变更（用户可见）

- **推送文案换形状**：通知本来就来自这台 DSH，自报家门是废话；该说的是「哪个会话」和「为什么推」。
  统一为**标题＝对象、正文＝原因**：

  | 场景 | 标题 | 正文 |
  |---|---|---|
  | 会话跑完 | 会话名（取不到则 `会话`） | `已完成` |
  | 有提问待答 | 会话名（取不到则会话 id） | `有问题需要你回答` |
  | 桌面「测试」按钮 | `通知测试` | `这是一条测试通知，能收到就说明通道是通的` |
  | 微信绑定就绪回执 | — | `微信通知通道已就绪：任务完成、等待审批或连接地址变更会推到这里。` |

  旧形状：标题写 `DSH Pocket 通知测试`／`AI 在等你审批`，会话名裹在正文的「」里。会话名取不到时的
  兜底位也不写 `DSH 会话`——那串看着像个真名，分不清是兜底还是会话。
- **通道死掉不再是静默的**：clawbot watcher 发「通道已就绪」回执时原是 `try { … } catch {}`，失败整个吞掉。
  那条握手消息发不出去就等于通道本身已废（**额度已尽**／缺令牌／参数被拒），症状是「绑定明明成功、
  之后一条都收不到」，而日志里查不出任何痕迹。现在成功落 `info: clawbot ready notice sent`，
  失败落 `warn: clawbot ready notice failed <错误类名>`。只记类名，不引述服务端 `errmsg`——
  沿用既有保密纪律：失败理由不进日志，回显体不保证不含敏感串。
- **推送额度已量化**（同日 11:00 真机受控实验）：**一条入站消息换 10 条出站推送**——就绪回执自己占第 1 条，
  之后 9 条测试推送全部成功，第 11 条起服务端回 `ret=-2 prepare failed`。与微信 ClawBot 官方口径
  「每下发 10 次消息后需主动发起一次对话／每隔 24 小时需一次主动对话」一致
  （0.4.7 节「已知平台限制」当时写的是「宽严只能实测」，现已测完）。
  ⇒ 使用上的实际含义：**推满 10 条要你在微信里再发一句才续得上**。`prepare failed` 说的是这个，
  **不是令牌身上有个时钟**——协议文档只列 `errcode -14` 会话过期，通篇没有分钟级 TTL；
  排查时先确认「刚刚有入站」，并注意**独立探针脚本与桥共用同一份额度**，别拿探针的读数当平台规则。

### 施工账

- `lib/bridge.js`：四处推送文案改造 ＋ 就绪回执的观测补全（+30 −18）。
- `test/notify-judge.test.js`：提问推送的断言跟着换新文案；「会话名进标题」那条断言仍然成立，未动。
- `CHANGELOG.md`／`package.json`：0.4.9 → 0.4.10。
- **本轮未做**（用户明说留待后续慢慢优化）：异常／报错停止类推送的「什么原因停的」——现在只有
  「已完成」和「有问题需要你回答」两种原因可读。

## 0.4.9 — 2026-10-10

### 修复（用户可见）

- **微信 ClawBot 消息「服务端受理但微信端收不到」**：根因是**消息项的类型键名错了**——线上字段是
  `type`，pocket 一直在发 `item_type`。服务端不校验这个键，照样回 `200` + `message_id`，
  但微信端识别不到就**静默丢弃**，于是表现为「日志说发出去了、微信里什么都没有」。
  现已改发 `type: 1`。
  - **受控实验（2026-10-10 上午，同一 context_token 连发三条，只改这一处）**：A `type:1`、
    B `item_type:1`、C 两者都带。三条服务端全回 200 + message_id（`7514489654797662984` /
    `7514489656118807944` / `7514489657536482824`），**但只有 A 与 C 送达，B 没到**。
  - 与参考实现一致：`ilink-hub` 的 `MessageItem` 是 `#[serde(rename = "type")] item_type`，
    即线上键名 `type`。
- **`test/clawbot.test.js` 加一条 wire 键名断言**：`item_list[0].type === 1` 且 `item_type`
  不得出现。这条是「能不能真送到微信」的闸门，不是格式检查——键名错了服务端照样点头。

### 施工账

- `lib/clawbot.js` 的 `sendTextMessage`：`item_list[0].item_type` → `type`（附中文注释记受控实验结论）。
- `CHANGELOG.md`／`package.json`：0.4.8 → 0.4.9。
- 本段踩过的两个坑，写给下一个查这个协议的人：
  - **`prepare failed` 不是本地代码里的字符串**，是服务端 errmsg 经
    `notify send failed: clawbot ${detail}` 透出来的；本地 grep 全仓与 git 历史都搜不到它。
  - **用已失效的 `context_token` 做的排除实验全部无效**：`ret=-2 prepare failed` 只说明
    token 过期了（同一 token 反复发必然复现），并不能证明请求体字段对不对。当时
    `item_type`/`type`/两者/都不带、带不带 `message_id` 六个变体全报 `prepare failed`，
    看起来像「字段名不是原因」，其实是 token 先死了。**排查 iLink 必须先确认 token 是新的**，
    判据：`settings` 里 context_token 的落盘时间是否在近几分钟内。

## 0.4.8 — 2026-10-10

### 修复（用户可见）

- **「点了测试但好像没反应」的定位盲区**：iLink 的 sendmessage 成功时不报错也不落任何日志，
  日志里「没有新行」一直被读成「没发出去」。现在成功也落一行
  `notify sent: clawbot ok message_id=<服务端分配的消息号>`，日志沉默不再等于失败，
  消息号可以直接和微信里那条消息对照。
- **顺带坐实两个协议事实**（本机实测）：`to_user_id` 是**必填**——留空只靠 `context_token`
  寻址会被服务端回 `ret:-2 invalid arguments`；成功响应体不是空体，而是
  `{"message_id":<64 位整数>}`（此前按「空体 200」记，见 0.4.7 节，此处更正）。

### 施工账

- `lib/clawbot.js` 的 `sendTextMessage`：返回体新增 `messageId`，并且**从响应原文里用正则取
  `message_id`，不走 `JSON.parse`** —— 它是 64 位整数（实测 7514407535056518664），JSON.parse
  会在超过 `Number.MAX_SAFE_INTEGER` 时静默舍入（成 …519000），那样的号没法用来对账。
- `lib/notify.js` 的 clawbot 分支：成功路径补一行 info 日志（带 message_id 时带上，纯数字才带）。
- `test/clawbot.test.js` 补 2 条：`sendTextMessage` 回传未舍入的 message_id、
  业务 `ret != 0`（如 `-14` 会话过期）仍判失败并透出 `errmsg`；notifySend 成功必须落 info 行。

## 0.4.7 — 2026-10-10

### 新增（用户可见）

- **通知可以直连微信了（ClawBot / 微信 iLink 机器人协议）**：通知通道新增 **微信 ClawBot** 一项。
  此前三类消息（任务完成、等待审批、连接地址变更）只能借道 Server酱 / Bark / WxPusher 这类第三方
  中转；现在 pocket 自己说微信的 iLink bot 协议，端到端只有你和微信两台机器。
  **绑定方式**：桌面配对页 → 设备视图 → 通知 → 通道选「微信 ClawBot」→ 点「扫码绑定微信」→
  手机微信扫码并在手机上点确认 → **在微信里给这个机器人随便发一条消息**（这一步不可省）。
- **为什么还要发一句话**：iLink 协议里，机器人要给你推消息必须持有 `context_token`，而这个令牌
  **只能从你发来的消息里换出来**，没有任何「凭空主动推」的接口。所以授权成功后的第一句话是你在微信里发，
  pocket 收到后回你一条「通道已就绪」，并把令牌落盘；从这一刻起才推得动。
- **令牌持久化与自动重连**：`context_token` 与 bot token 一起写进设置档（0600），桥起来就自动续上，
  不用每次重启重新扫码。协议层会话超时（errcode -14）需要重新扫码，届时页面会回到未绑定态。
- **解绑**：面板上「解除绑定」清掉令牌并停掉轮询，通道回到 off。
- **已知平台限制**：微信侧对机器人主动发消息有自己的频控（ClawBot 官方口径「10 条 / 24h 需回一句续期」），
  自建 bot 同样受约束，宽严只能实测。**⇒ 同日 11:00 已实测：正好 10 条一条入站换一次，官方口径无折扣，见 0.4.10 节。**

### 协议实现要点（施工账，防重查）

- 端点：`get_bot_qrcode?bot_type=3` / `get_qrcode_status` / `msg/notifystart` / `getupdates` /
  `sendmessage`，base = `https://ilinkai.weixin.qq.com`。**只有 notifystart 带 `/msg/` 段**，
  sendmessage 不带（写错即 404 级失败）。
- 认证五头缺一即超时：`AuthorizationType: ilink_bot_token`、`Authorization: Bearer <token>`、
  `X-WECHAT-UIN: base64(random_uint32)`、`iLink-App-Id: bot`、`iLink-App-ClientVersion: 132102`。
- 出站 `msg`：`message_type:2` / `message_state:2` / `from_user_id:""`（必须空串）/ `client_id` 唯一 /
  `item_list:[{item_type:1,text_item:{text}}]`。sendmessage 成功判据是**空体 200**；有体时按 `ret` 判。
- 新增 `lib/clawbot.js`（协议客户端，统一 `{ok,error}` 返回、不抛异常）+ 三个桌面端点
  （`/desktop/notify/clawbot/{qr,status,reset}`，均过桌面 cookie 与同源校验）+ `CLAWBOT_IDLE_POLL_MS`
  空批地板（防桩端点或降级端点把事件循环打满）。
- 新增 11 条测试（`test/clawbot.test.js`）：头构造、二维码解析与失败、三态轮询、notifystart、
  getupdates、sendmessage、notifySend clawbot 分支（缺 context_token 不得发）、设置档持久化与
  「未提 clawbot 的保存不得清掉已获令牌」、三个端点 E2E。

## 0.4.6 — 2026-10-09

### 性能（用户可见）

- **手机冷开少等约半秒**：打开页面时，文档原来要**站在一次宿主机 RPC 前面等它回来**才发得出来——
  那次调用把**所有工作区的全部会话**整个拉回来（实测 469 条 / ~195 KB / **465–719 ms**，
  占冷开总耗时的 ~97%），而首屏只用到其中**一行**加一个总数。`session/list` 端点没有任何过滤或
  限量参数（本机 reference 实证），无法少要。
  现在改为**旧值先顶上、新值背后拉**：文档用上一份成功取到的会话目录立刻渲染，同时把这次调用
  发出去，下一次读就是新数据。**每次打开都省掉这半秒，只有一次例外**——重启后的第一次仍然要等
  （那时还没有「上一份」可用）。
  **代价说清楚**：旧值窗口 **2 分钟**。窗口内你在桌面新建的会话，手机自动打开的可能还是上一个会话；
  2 分钟之外一律等真实数据。会话列表本身不受影响（它每次打开都强制取新），受影响只有「自动进哪个会话」
  这一件事。失败的一次读取永远不会被记成旧值，也不会顶掉上一次的成功结果。
  手机壳**一字节未增**（改动全在服务端 `lib/bridge.js`，不进 253 KB 预算）。
  新增 8 条测试钉住这套新鲜度契约（`test/boot-list-stale.test.js`）：只有冷开文档可取旧值、窗口到期即拒、
  失败不入档、force 无视旧值、取旧值仍会触发刷新。

## 0.4.5 — 2026-10-09

### 修复（用户可见）

- **下拉加载更多消息现在有过程反馈**：此前从顶部下拉只有列表位移，屏幕上没有任何
  「现在松手会怎样」的信号。现在列表上方有一句提示，随手指走三段：起拉即显示
  **「下拉加载更早的消息」**，拉过触发阈值（72px）换成 **「松开即可加载更早的消息」**
  并把字色提为品牌色，松手进入请求期间显示 **「正在加载更早的消息…」** 并转圈，请求
  落地或失败后自动收走。提示条 `pointer-events:none`，不接管任何点击。
- **「已经到头」从此有两句话，各说各的事**：同一个「取不到更早消息」的状态原先按屏上
  有没有内容分裂成两种表现——有内容说「已经是最早的消息了」（灰掉），**没内容却仍显示
  「加载更多消息」并且可点，点了永远拉不出东西**。现在按确据分三态：还能要 →
  「加载更多消息」；确证没有更早的页而屏上仍空 → **「没有更多消息了」**（灰掉，不再
  给死按钮）；同样确证而屏上有内容 → 「已经是最早的消息了」（读者在第一条上）。
  下拉提示走同一判据：到头时它直接说出那个结局，不再谎报「松手即可加载」。
- **拉回头之后不再空放请求**：松手时若已确证没有更早的页，手势只做回弹，不再发一次
  注定为空的 `session.history`。

## 0.4.4 — 2026-10-09

### 修复（用户可见）

- **滚动锚点按钮不再在最底部就冒出来**：两个跳转钮（↓ 回最新 / ↑ 回提问）现在统一以
  **「读者实际往回滑了多少」**为门槛，而不是「提问是否在屏幕上方一屏外」。旧规则在
  **长回复**上会误报：读者明明还停在最后一屏没动，只因为回答长到把提问顶出一屏，↑ 就亮了。
  新规则：停在最后一屏时**两个都不显示**；往回滑够**一个屏幕**才显示 ↑（回提问只是一屏内的
  微调，够一屏就响应）；滑够 **1.5 屏**才显示 ↓（它是跳到最末尾的大动作，门槛更高）。
  两个钮仍然互斥，永远不会同时出现。

## 0.4.3 — 2026-10-09

### 修复（用户可见）

- **「已调用工具」折叠点开没反应**（手机 webview）：页面所有折叠头是 `display:flex` 的
  `<summary>`，旧 WebKit webview 的原生 `<details>` 切换在此失效（桌面 Chrome 不受影响，
  正是"手机上点不开"的形态）。现按桌面客户端同款思路改为 JS 驱动翻转（tap → 手动
  `.open` 切换并记入重绘存续表），健康浏览器由 `preventDefault` 抑制原生翻转避免双翻。
- **排队消息「取消」符号不齐**：remove 由文本 `×` 改为与立即发送/编辑同规格的 13×13
  stroke SVG（红色 `is-danger` 保留为破坏性标记）。
- **退出重进后返回键/边缘手势失效**：自动跳回会话的 resume 跳转原以 `replaceState`
  改写当前条目——列表态下当前条目正是 init 铺的 `{view:'sessions'}` 应用内锚，被改写后
  返回键与边缘手势都会退出应用，刷新才恢复。现改为 push（栈下陈旧 chat 条目已有折叠
  守卫，不会复活"返回键重开当前会话"旧 bug）。

## 0.4.2 — 2026-10-09

### 新增（用户可见）

- **GoalBar 目标控件**：长目标栏新增暂停 / 恢复 / 编辑 / 清除四动词（与桌面 GoalDock 同款）——active 显
  暂停，paused/blocked 显恢复，编辑为内联输入框（Enter/保存提交、Esc/取消退出、空文本禁提交）；
  `phase==='complete'` 时整条隐藏。动词经 `goals.pause/resume/clear/edit` RPC（CAS ref 取自目标投影，
  过期由宿主 GOAL_STALE_REVISION 守卫）。

### 修复（用户可见）

- **退出重进后全体「？」假象消除**：任务行状态机删除 `agentAvailable===false → unknown` 分支（与桌面端
  对齐——该信号不承载状态语义，宿主重启后全体 false 曾致列表全体问号）；干净行回落为已完成（绿勾）。
- **退出重进后全体红点消除**：未读红点改为**仅对「本机打开过（台账有记录）且在其后又有活动」的会话**
  点亮——从未打开过的会话保持安静，重启/重装后不再整列标红。
- **设备页提示条跟随视图**：配对页模式提示（modeHint）随 WiFi/互联网/设备三视图切换各自文案（设备视图
  说明设备与通知管理），不再在设备页晾着连接模式的提示。
- **错误提示条关闭钮不再压字**：#chatError 右侧为关闭钮留出固定内边距，长文本不再被「×」遮挡。

## 0.4.1 — 2026-10-08

### 修复（用户可见）

- **重启后不再残留假连接**：宿主重启恢复的配对档案改为**停泊**（`parkedByRestart` 标记）而非直接回到
  在线表——手机带着旧 cookie 的下一次请求会静默复活（无感，契约不变），但状态页不再显示一个手机实际
  已掉线的"已连接"；桌面手动断开仍清标记，之后一律走 PIN/扫码/重连漏斗。
- **桌面配对页板块归位**：「任务通知」面板并入设备视图（第三键改名**「设备与通知」**，中英同步），只在
  设备 tab 显示；「固定域名（命名隧道）」面板只在隧道 tab 显示；「待确认接入」卡保留在配对流程原位
  （未连接、LAN/隧道视图下批准）。设备视图内不再晾出无关面板。
- **回合末尾假「已完成分析」折叠行清除**：闭合回合只剩推理块（无工具调用）时不再折进"过程"折叠容器，
  改按桌面端行为渲染为普通思考卡（compact 视图隐藏、verbose 可展开）；含工具调用的过程折叠与标题
  兜底逻辑不变。

## 0.4.0 — 2026-10-08

本版为「九卡特性批」：九张 change（两轨并行）+ 独立审查（渲染层 P1 修复 + 桥安全 PASS-with-notes 两条 P3 顺手修）。
逐卡账在 `F:\defws\.agents\flow\changes\2026-10-07-*`（各卡 planning-context + HANDOFF）。

### 新增（用户可见）

- **隧道模式流式降级**（feat-pocket-tunnel-stream-fallback）：quick tunnel 下 Cloudflare 吞 SSE 实时帧
  （10-07 真机实证），手机页现按桥端透出的连接模式自动分流——公网走 `/api/session/events` 增量轮询
  （1.5s 起自适应，回前台即拉），局域网保持 SSE 实时流；AI 回复在手机上从「冻住→蹦一段」变匀速吐字。
- **过程呈现改版**（feat-pocket-process-render-overhaul）：工具卡从「英文工具名+原始 JSON」改为宿主官方
  中文动词三态叙事（正在编辑文件…→修改了文件），同类操作聚合（「已读取 5 个文件」），edit/write 显示
  行级红绿 diff（截断防巨页），原始参数降为「查看技术详情」二层折叠。
- **图片/文件闭环**（feat-pocket-image-file-capability）：图片灯箱（全屏/两档缩放/保存）、文本类附件
  行内预览（200 行截断+查看全部+复制）、AI `present` 呈现的图片/文件直接渲染成卡（带描述）、消息里
  `![](<本机路径>)` 图改写可显示——新端点 `/api/session-file` 只服务「本会话事件流中出现过的路径」，
  集合外一律 404（防任意文件读）。
- **设备档案与恢复**（feat-pocket-device-registry）：换域名/重启后手机**只输 PIN 即恢复**（凭证+公网同意
  一并换发，不再重复点同意——同意书从浏览器迁到设备档案）；桌面面板新增「已配对设备」页（名称/配对
  时间/到期/最后上线/通道权限，逐台撤销[踢线]/延长/改权限）；新设备权限按首连通道自动定（局域网=仅
  本地，公网=本地+公网）；存量配对平滑迁移不重新配对。
- **智能滚动**（feat-pocket-smart-scroll-anchors）：流式自动贴底、上滑即停、双锚点「↓ 最新/↑ 提问」
  （↑ 一键回到本轮你发的那条消息）；历史消息 `content-visibility` 原生虚拟化，长会话不卡。
- **会话未读红点**+**PWA 离线回退页**（同卡）：列表显示哪个会话有新动静；断网时手机页显示 offline
  页而非白屏，恢复后一键重载。
- **完成通知判准升级+审批到达即推送**（feat-pocket-notify-judge-upgrade）：静默 90s/宽限 10s/连忙 20s
  即时/30min 兜底，治「任务完成」误报漏报；AI 提问等待审批时立即推送（零配置时静默跳过）。

### 修复（用户可见）

- **后台在跑却画绿勾（假完成）**（feat-pocket-subagent-status-visibility，2026-10-08 刀④⑥批）：
  子代理（含 agent team 成员 / ACP 工人，宿主侧同为 origin:'subagent' 子会话）在跑时，父会话行自身
  `running:false`，手机列表因此画绿勾（已完成）——实际没做完；完成推送同判据也会误报。本笔把
  「直接子代理在跑」聚合为父行 `descendantRunning` 派生布尔（桥端单源 `applyDescendantRunning`，
  列表/开机数据/通知采样三消费点共用），父行转圈不画勾；写手被占（agentAvailable:false）的行改为
  **灰问号「状态未知」**，绿勾只剩真完成。手机不可见的子代理行自身不再参与完成判定（不再重复推送）。
  另修同源小 bug：权限预设下拉的当前值改读会话投影（`agentPresetOf`），不再恒回默认档。
- **转录过程/正文交替编排 + 桌面词表**（同卡刀⑤，2026-10-08）：一轮内改为「过程折叠块→正文→过程折叠块→
  正文…」按到达序交替呈现（原先过程整块先出、正文堆后）；过程段标题接宿主官方词表（如
  「已读取文件并修改了文件」），删除自造计数措辞。页壳字节 243995/243936，预算 248000 内不升。
- **wxpusher 假成功**（fix-pocket-wxpusher-simple-push）：换 simple-push 语义+读业务码 `code===1000`，
  「HTTP 200 但没送到」不再记成功；对面错误消息脱敏截断后透出给「测试」按钮。
- **隧道 token 出命令行**（fix-pocket-tunnel-token-env）：命名隧道 token 改走 `TUNNEL_TOKEN` 环境变量，
  不再出现在进程列表（同机进程可读 argv）。
- **断线原因说人话**（fix-pocket-disconnect-copy）：「连接断开」细分为会话过期/桌面断开/工作区关闭/
  连接超时，重连中与错误横幅视觉分离。
- 独立审查 P1：含 AI 发图记录的会话在手机上打开即崩溃（presented 记录缺 turn 字段击穿渲染循环）——
  已修并补全程行为测试。
- **手机上「问题自己跳走」不再静默**（fix-pocket-question-lost-on-reconnect）：蜂窝事件流每建立一次连接
  （首连与每次重连）都会把「待你回答的问题」表整个清空，而这张表只能靠推送填、没有任何重建来源——
  一次网络抖动或一次切后台，正在显示的那道题就凭空消失，手机再提交只会得到「no longer pending」。
  本笔把**五条清空路径**（无 URL／无 base／base 变更／下行断开／carrier 开流）统一收口，每次清空都如实
  留下一行 `pending questions cleared via=<哪条路> dropped=… sessions=… backlog=… evictedLifetime=…`，
  **只报计数与路径标签，不含会话 id、问题 id 或任何提问文字**；空表被清不算事件，不刷屏。
  同时修掉一处遮挡：`interaction.pending` 原先返回**最旧**那道，同一会话里新到的问题会被永久挡住；
  现返回该会话**最新**那道，答掉之后被藏的那道自动浮上来——没有任何问题被跳过，只是上屏顺序变了。
  连带修掉一处为本改动**新引入**的回归（原实现每次作答尝试都把题搬到队尾，一旦作答失败，这道答不上的题
  就永久占住「最新」，把另一道重新藏起来）。
  ⚠ **未解决、也非本仓可解**：重连之后那道旧题**仍然无法作答**——宿主 gateway 要求作答方在该事件的投递
  名单内，重连后的新连接必然落空，且**静默丢弃、不报错**。根治需宿主提供「向新连接重投仍等待中的事件」
  或「按 callId 作答」的能力；本笔只做到不再无声丢失。详见 `docs/question-auto-answer-investigation-20261008.md`。

生效需要重启 DeepSeek Harness。测试基线 756→933（截至本笔 10-08 14:1x 复跑；并行线仍在追加，引用前先复刷）。

### 修复（用户可见）

- **配对设备页并入横向模式栏**（feat-pocket-devices-into-mode-bar）：桌面桥接页原本悬在 iframe 之上的那条
  「已配对设备」页签（白底黑字、纯英文，与整页暗色/中英不搭）被**整条删除**，设备档案改由
  `.mode-switch` 里与「WiFi连接模式/互联网连接模式」并列的第三键「连接设备管理」承载——三键互斥，
  点它即整体替换二维码/链接内容为设备列表，且该键**不受连接状态禁用**（连着手机也能管设备，不倒退）。
  设备档案八项能力（在线态/指纹/首次配对/凭证到期/最后上线/仅本地↔本地+公网/延长 30 天/两步确认吊销）
  与旧页签完全等价，**无一处减配**；设备卡改用桥页 `var(--surface/--ink/--line/--danger)` 主题变量
  （修掉原来白底黑字不合暗色的问题），中英文随桥页 locale 源走（修掉原来外壳页签全英文的问题）。
  测试同步收紧：新增**执行级看门狗** `test/device-panel-exec.test.js`（把 `lib/pages.js` 真实函数体
  splice 进 node:vm 沙箱、用 FakeNode/fetch 桩驱动真实 click/fetch 路径，非字符串断言——已用变异实验
  证明删掉委托 case、抹掉 `data-target-perm`、反向注入 `devicePermLabel` 均会使其变红），另有
  `tools/render-stub-desktop.mjs` 供目验 full/empty/failed/connected/tunnel 状态页。

生效需要重启 DeepSeek Harness。测试基线 947→949（截至本笔 10-08 16:0x 复跑；并行线仍在追加，引用前先复刷）。

## 0.3.1 — 2026-10-07

### 新增（用户可见）

- 手机侧文件附件卡片：历史消息里的文件附件从「死芯片」变成可点下载卡片——带真文件名、
  大小，点击即存（走既有 `/api/session-attachment` 路由，非图片返回下载而非内联）。
  图片附件维持内联渲染不变；附件已被宿主回收（无 attachmentId）时退回只读芯片，不请求。

### 修复（用户可见）

- 手机保存文件不再一律叫 "attachment"：`/api/session-attachment` 的下载处置现在携带宿主
  附件记录里的真文件名（缺省回退 "attachment"；文件名中的引号/换行被剥除，防止破头）。
- 会话提示条（「连接已断开…」「会话被移到后台…」那一类）不再钉死不退：它原先只等「流恢复帧」
  这一条退路，而把它触发的那次断流往往再也不来帧，于是提示条永久驻留（用户报「已经正常聊了好几轮
  它还挂着」）。现在有三条出口——流帧（原样）、**90 秒自动过期**、以及点提示条右端的 × **手动关闭**；
  三者都走同一道守卫，不会被一次成功轮询偷偷抹掉。
- 提示条现在**跟随输入框长高**：底部锚点从写死的 `84px` 改为实测输入框带高（`--composer-h`）。
  输入框撑到 150px 上限时，原先提示条会原地不动、被输入框压住；现在它同步上移并保持间距。
- 提问面板（宿主要你选选项的那块）打开时，提示条不再以更高 `z-index` 浮在面板之上，改为让位隐藏。
- 手机页从后台切回前台时，若会话流已断则**自动重开**：此前后台挂起不会触发重开，回到前台仍显示
  一条没人能应答的旧断流提示。

生效需要重启 DeepSeek Harness。

## 0.3.0 — 2026-10-07

本版跨 10-03 之后五批改动累积（手机体验两批、UX 批、持久化与同意门、审计与 413 修复），并含 0.3.0
定稿前两轮审查修复批（渲染批修与小契约）的对外可见变化——「修复」节末六条为 2026-10-07 补录。
生效需要重启 DeepSeek Harness。

### 新增（用户可见）

- PWA：手机页挂上 `<link rel="manifest">`，`/manifest.json` 随桥服务（配对门禁后可取）——
  加到主屏幕不再是普通书签（0.2.0「已知边界」里的那条挂起项就此翻篇）。
- 连接状态三态灯：顶部状态点区分「已连接 / 宿主未响应（degraded）/ 已断开」，宿主挂掉不再
  伪装成一切正常——消费的是状态帧里的 `hostReachable` 字段。
- 通知出站：回合完成可推送到 Server酱 / Bark / WxPusher 三渠道；桌面面板新增通知配置
  （渠道 / key / 开关）与「发送测试」，设置原子落盘（`0600`）。已知边界见 README（wxpusher
  的「假成功」嫌疑披露）。
- 公网同意门：经隧道配对时手机先过一道免责声明页（`/consent`），接受后 RPC 才放行；
  配对漏斗与同意门的衔接修了两条（配对后 303 导航 + `sec-fetch-site` 造成的 403）。
- 命名隧道（Named tunnel）：桌面面板可配 Cloudflare tunnel token + 固定 hostname，URL 不再
  每次启动变化；**dashboard ingress 必须指向 `http://127.0.0.1:<桥端口>`**——面板与 online
  日志都会提示（见 README「云隧道」节）。
- 断线免扫码：桌面面板新增设备列表三节；配对过的手机断线后免扫码恢复，不再要求重新扫二维码。
- 会话持久化：配对结果落盘（`0600` 原子写），DSH 重启后手机 cookie 直接有效——一次配对管 30 天，
  不再「重启就重配」。
- 桌面 GoalBar 与 QueueDock 透传：目标状态条与排队消息在手机端可见；排队消息可行内编辑、
  撤回、立刻发送。
- 停止按钮乐观反馈：按下即转 Spinner、状态行改「正在停止」，不再等两个往返才动。

### 修复（用户可见）

- 流式回复逐 token 上屏复活：事件监听器对 gateway 流帧形状的误判把每个 token 都吞掉了
  （R1 审计 P0，带回归断言）。
- 图片发送 413 修复：页侧收口传输预算，`command.execute` 升大档（`session.updateQueue` 同批）；
  413 文案带「原尺寸 / 限额」双尺寸诊断，不再是无头无尾的英文原文。
- 隧道意外死亡不再连坐：quick tunnel 进程被外部杀掉时只 park 隧道态，不再把 LAN 会话一起踢下线。
- 空壳会话不再顶成「未命名」行：桌面遗留的 blank 会话按新鲜度过滤；新建会话失败不再静默
  （成功路径错误可见性恢复）。
- 卡死的「深度思考中…」运行态由闲置看门狗回收；挂着待答提问的回合不被误收。
- 手机页渲染批修（审查三 Major）：发送失败红条从文档流提为固定横幅，不再被输入框与排队坞遮住，
  提问单盖开时仍可见可点；排队消息行内编辑框不再误吃输入框样式、超长排队文本不再撑破行（× 完整
  在界）；「+」面板二级页的返回钮恢复为「‹ 返回」（原先伪装成分组名文字）；多选题的空答案提示
  改用多选措辞。
- 权限预设兜底中文化：宿主目录拉不到预设目录时，三个兜底项显示「只读（推荐起步）/ 工作区可写 /
  完全放开」与白话说明，危险档标红；「附件过大」一族失败（含桥端 413 的英文原文）统一映射为页面
  语言文案并附下一步指引。
- 重连失败页新增出口：隧道模式下重连失败给出「回电脑旁重新扫码」链接，不再只剩干等重试一条路。
- 通知开关现在在发送层拦截：开关为关时不再有任何出站推送（此前关掉开关挡不住已配置渠道的
  完成/测试推送）。
- 增量同步不再丢弃无 seq 记录：这类记录此前被按「必然已见过」整条滤掉，只有整页刷新才回得来。
- 隧道 hostname 上限 253 → 150：配对二维码容量（固定 63 字节前缀 + hostname，最高版恰好 213 字节）
  只容得下 150，超限值此前能存进设置、配对二维码却渲染失败；现在存储读写与面板保存端点三处同限，
  超限保存显式回 400 报错，不再「提示成功」而值被静默丢弃。

### 变更

- 转录时钟收口为「每轮恰一枚」不变量（主体语义已记于 0.2.1 节，本版补不变量锁定与变异实证），
  顺带清掉五条恒压死的 CSS 规则。

### 仓库面

- 版本号 `0.2.1 → 0.3.0`；验证工具固化进 `tools/`（渲染桩参数化 / 线上探针 / 红形态证明器），
  README「测试与工具」节已同批记载。

## 0.2.1 — 2026-10-03

本版跨多卡累积五节改动（三批修复、两批测试加固）。生效同样需要重启 DeepSeek Harness。

### 修复（用户可见）

- 回合运行状态指示器（「深度思考中…」）在事件密集的长回合里会提前消失：流缓冲裁剪最老边后，
  运行态被重新算成「未运行」。改为在事件到达时记录单调高水位，裁剪不再影响结论。
- 手机端会话列表过滤 `origin === 'subagent'` 的子会话；命中宿主 `session/agent-busy`
  （durable parent address）时回退到会话列表，不再把宿主的英文报错与粘住的「重试」留在屏上。
- 桌面入口文案统一改名：`连接手机` / `Connect Phone` → `pocket`（`client/client.js` 与
  `README`、`cordis.patch.yml`、`tools/install-to-profile.mjs` 同批）。

### 修复（Windows 观感）

- 解包 cloudflared 归档的那次 `tar` 调用补 `windowsHide`，减少 Windows 上多弹的黑窗。
  真正的黑窗来源在宿主侧的 worker，不在本仓（见卡内证据报告）。

### 修复（手机端启动）

- 手机端启动时若宿主把焦点指向一个子代理会话（那是别的会话的工具、不是手机端该自己打开的
  东西），以前会被自动跳进去。改为按会话 id 回到原始会话行上看它是不是子代理会话：确知是子
  代理才拦，行不在或看不出出身的一律放行——守卫只否决，不替换、不回退，其余聚焦与重开行为
  不变。

### 测试（运行期断言）

这次不动产品行为——只是把「子代理会话在手机端不可见」这条已经交付的行为，从阅读与源码
针脚升级成可复跑的断言，分两条线：

- 进默认测试套件的一条（7 例）：在沙箱里跑真实的页面资产，断言子代理地址被拒时转录窗一个
  字节都不写（对照组则必须画出失败行与重试按钮，证明前一条不是空断言）；焦点只在投影后的
  行里挑；工作区列表对被过滤掉的会话落空态，而不是画出一行幽灵行。另配一条变更检测用例
  （把未投影的行直接喂进去，上面的断言必须同时变红）自证断言有鉴别力。同档还证明浏览器
  脚本不在默认入口内——用 Node 自己的通配解析跑默认入口的模式，而不是手搓一份文件列表。
- 需要真实浏览器的一条（`test/dom/subagent-session-dom.mjs`）：在真 DOM 上走完「启动时宿主
  把焦点指向一个子代理会话」的整段路径，断言会话列表回到激活态、页面不落在会话页、工作区
  列表里没有子代理行、转录窗里没有失败行也没有重试按钮、错误区为空，并在跨过看门狗重试
  时点之后再测一次（专门证伪「事后补画」）；同档记录会话历史请求的地址序列，确认那条路径
  真的走到了，不是全绿的空转。

浏览器档自带环境闸（`POCKET_DOM_E2E` / `POCKET_CDP_PORT` / `POCKET_EDGE`）：不设闸时打印
`DOM SKIP:` 并正常退出，所以默认入口在任何环境都不会红；设了闸却拿不到浏览器时退出码非 0，
并打印一条可直接粘贴的启动命令。

### 测试（偶发可诊断）

两条间歇失败现在能在红时说出传输病因，不再只报一个裸状态码不匹配。一条是技能菜单在
桥接层返回 502 时红：失败消息现在把桥自己的传输日志带进断言文案，红时点名是哪一类
传输故障，而不是一个孤零零的 502。另一条是流帧节奏例在载体中断时红：现在先断言载体
健康、再看节奏，能把「载波没活到采样点」与「帧声明的节奏不对」分开。502 形态在规划
期 80 次插桩运行中复现 3 次，机制在夹具侧（两条到测试宿主的连接同时断开），但本次不
声称已消除，发生率也未压到零。

另有一族整文件级中止——技能菜单与手机资源各出现过一次——与早先一次底层运行库收尾
中止同源；本卡写域内无修法，未修、未承诺。

### 变更（手机端转录页脚）

手机端转录现在按「每轮一枚」挂时钟页脚：每轮消息结束，整轮只在最后一条 AI 消息的
结尾出现一个时间（与电脑版同一套 `formatMessageClock` 三段式：当天显示 `HH:mm`，同年
显示 `M月d日 HH:mm`，跨年再补年份）；同一枚气泡上还挂一枚 token 用量药丸
（「用量 9.5K tok」），用户消息仍带自己的时刻。

- 时刻与用量都直接来自宿主事件本身，**没有改动 `lib/projections.js`**：
  `user/message` 与 `assistant/message` 的 `event.time` 已经在传给手机端的记录里，
  `PHONE_RECORD_DROP_KEYS` 只丢 `stream`/`header`/`meta`，所以这两样本来就「传过来」了。
- 取值口径对着电脑版 `normalizeUsage` 实现（`llm/token-meter/lib/types/turn-usage.js`）：
  `inputTokens`/`outputTokens`/`totalTokens` 必须是非负安全整数，`reasoningTokens` 不得
  超过 `outputTokens`，`(total − output)` 不得小于 `input + cacheRead + cacheWrite`；
  两个缓存键都出现时还要求**严格相等**，与电脑版 `exactPrompt !== knownPrompt` 的守卫一致。
  任何一条不满足就不画药丸（宁可不画，也不画一个对不上的数）。这不是求和：本轮只显示
  `totalTokens`，绝不跨 step 累加。
- 用量药丸按**文字项下标**取，落在本轮最后一条文字气泡上。所以一条消息带 2/3/5 个文字块
  时药丸仍只出现一次（`e613c96`），而带 `seq` 或不带 `seq` 的记录都不会重复打印
  （`d3dc31d`）。回合过程 `<details>` 那条合成行、用户消息、`turn-error` 行一律没有药丸。
- 时钟与药丸同门限，都只落在每轮最后一条文字气泡上：回合中途的步骤气泡与仍在流式输出
  的气泡一律无钟；用户消息仍带自己的时刻，与电脑版把用户时刻放在顶部不同（记为差异 D1）。
- 依据 3704 条真实 `assistant/message` 记录核对过记账不变式 `exactPrompt = input +
  cacheRead + cacheWrite`：有 `cacheRead` 的 3436 条、两个缓存键都有的 32 条全部严格相等，
  0 例缺口，所以「两键齐全就必须相等」这条严格守卫不会误伤合法数据。


## 0.2.0 — 2026-10-03

一轮覆盖全仓的审计整改（flow change `2026-10-02-fix-pocket-audit-remediation`）。

**装上本版后必须重启 DeepSeek Harness**，手机端才会拿到新页面与桥接逻辑：装机是 `link:` junction，
`lib/pages.js` / `lib/bridge.js` 都是静态 import，HMR 不跟 junction。

### 修复（用户可见）

- 会话列表：修顺序错乱、修新消息把已读旧消息盖掉；上拉「加载更多」改为固定条数语义
  （默认 30 条，上限 200）。
- 页面稳定性：修掉整页冻死——转录窗口、热转录缓存、输入框（`+` 面板）三处都改为有界。
- 重连：重连后不再出现空白会话页；重连页与 PIN 页的「重连」按钮不再点了没反应。
- 错误可见性：掉线 / 流中断 / 后台 / 隧道各有具名文案，不再被一次成功轮询静默擦掉、
  也不再被空串抹平（见 `lib/pages.js` 的 `showError` / `noteStreamRecovery` / `importantChatCopy`）。
- 滑动返回：从会话页返回落在工作区列表，不再直接退出浏览器。
- `+` 面板的搜索框不再自动拉起输入法（要点才弹）。

### 变更（契约 / 行为）

- 连接密码位数 **6 → 8**。输入框与校验仍收 6–12 位，盘上存量 6 位密码**零迁移**、照旧可用
  （`PAIRING_PIN_MIN_DIGITS` / `PAIRING_PIN_MAX_DIGITS` / `PAIRING_PIN_PATTERN`）。
- 未配对的请求依旧一律 401 先于路由（不变）。宿主凭据缓存现在带 10 分钟 TTL 与世代失效：
  authority 变了或握手失败时会丢掉旧 cookie 重取，不再「带着过期凭据重试到 TTL 到期」
  （`lib/inner-auth.js` 的 `invalidate()` + `lib/mux-client.js` / `lib/session-stream.js` 两处调用）。
- 被拒的提问载荷会写一行 `warn`：`pending question refused reason=<reason>`（必要时带 `count=`）。
  日志**不含**事件 id 与题干、选项文案。
- 手机页触摸目标抬到 44px，浅色主题对比度达 WCAG AA；去掉 viewport 的 `maximum-scale`；
  补 `role="status"` / `aria-live`、`+` 面板焦点陷阱、QR 图的 `role="img"`、图标按钮 `aria-label`。
  例外一处：草稿删除按钮保持 26px（测试里有具名例外断言）。
- 重连页与 PIN 页共享同一段阶段脚本（原先一分两份）；跨页面文案统一走 i18n key。
- 会话水位线改为**按会话**记账；探针/刷新不再把另一个会话的进度当成自己的。

### 仓库面

- `package.json files` 收全 `test` / `tools`，并把 `CHANGELOG.md` 纳入发布件；`.gitignore` 补
  `vendor/`、`*.log*`、`*.tar`、`*.tgz`；`README` 的数据根、端口、版本策略三节按实现复刷。
- 版本号 `0.1.0 → 0.2.0`，本档从本版起维护（此前 `README` 写的是「本仓不维护 CHANGELOG」）。

### 已知边界（本版未做，见 `README`「已知边界」）

- 会话行的整宽按钮高 38.5px（触摸面积足够，未强抬到 44）。
- `_sessionCursors` 运行中不淘汰；宿主被硬杀时 cloudflared 可能留孤儿进程。
- PWA manifest 仍未挂；桌面端 `client/client.js` 一处浅灰文字未随对比度整改。

## 0.1.0

- 初版：LAN 监听 + 可选 Cloudflare quick tunnel；QR / PIN 配对；会话列表、历史、发消息与流式回复。