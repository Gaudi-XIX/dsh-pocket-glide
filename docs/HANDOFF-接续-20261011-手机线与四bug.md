# 接续 handoff — pocket 手机端线（2026-10-11 15:0x，从"上下文耗尽、换新会话"起）

**新会话第一步**：读本文件 → 跑 `cd F:\defws\dsh-pocket; node --test --test-concurrency=1 test/*.test.js`
确认起点绿 → 再按 §3 的顺序开工。不要重新考古：所有锚点已写到行号。

---

## 1. 现场快照（15:0x 实测，非常量，用前复核）

| 项 | 值 |
|---|---|
| pocket 源树 HEAD | `0c2ffa5`，工作树**干净**，`version=0.4.26` |
| 已装载进宿主 | **0.4.26**（桥 pid 57176 起于 14:50:46 ＞ 提交 14:41:01） |
| 全量测试 | **1066 / 1064 pass / 0 fail / 2 skipped**（两遍一致） |
| 手机 | 华为 NOH-AN00 / Android 12，`device paired mode=tunnel`，隧道 `interstate-required-jacksonville-netw…` |
| 设置档真身 | `%LOCALAPPDATA%\dsh-pocket\mobile-bridge-settings.json`，顶层键 `notify, tunnel, diagnostics`，`diagnostics.probe=false` |
| 设备档案 | `%LOCALAPPDATA%\dsh-pocket\mobile-sessions.json`＝**Map 持久化成 [键,值] 数组**（读法：`j.devices[i][1].expiresAt`），两台设备各有绝对到期（11-10 11:45 / 11-10 12:57） |
| 根仓 | 3 个未提交项属**他人线**：`README.md`(M)、`docs/magpie-实测参数审计-20261011.md`、`tools/magpie-sync-models.py` —— 未获授权前不代签 |

**手机端八问（用户 2026-10-10 23:08）现状**：A/B/C/D/E/G/H 已修并真机验收；**F 拆成两半都已修**：
中段"闪"＝我自己和浏览器抢写 `scrollTop`（0.4.21 撤除，真机复测 `rs` 13→**0**）；
贴底"弹"＝键盘末段视口冲高 704→648 再回弹 +56px（0.4.22 改 `--kb` 抬起输入区后，复测过冲**0 次**）。
判读与更正（含"`resizes-visual` 在华为浏览器未生效"这条对我自己不利的结论）在
`docs/F真机判读-20261011.md`；一手读数存档在 `docs/F真机读数-20261011.md`。

## 2. 未完成：面板诊断开关（用户 14:18 令「做面板开关」）

后端与存档层**已落**：`diagnosticsProbeEnabled()` 读 `diagnostics.probe`；公网 `pairingUrl` 与微信回话都按它追加
`?probe=1`；`settings-store.js` 已登记该段（**曾会静默丢弃**，见 §4）。**只剩这三块**：

1. **路由**：新增 `POST /desktop/diagnostics`，照 `lib/bridge.js:3868` 的 `tunnel/config` 全套抄——
   `rejectUnlessDesktop(request, transportAddress, response)` → `verifySameOrigin` → `JSON.parse(await readBody(request))`
   → **严格布尔**（非布尔回 400，不许 truthy 混过）→ `settingsStore.save({diagnostics:{probe}})` → 回快照。
2. **回显**：`snapshot()`（`bridge.js:2561` 附近那个返回对象）加 `diagnostics: { probe: this.diagnosticsProbeEnabled() }`。
3. **UI**：`lib/pages.js:2272` 的 `panelSectionsHtml`（`#deviceExtras` / `#notifyPanel` 内）加一行开关；
   **zh/en 两套文案**都要给（照 `text.notify*` 那批键）。文案必须写代价：开着时手机每滑动 1.5 s 回传一批、
   日志会涨；**换隧道域名（每次重启）后必须重新用带 `?probe=1` 的链接进一次**——localStorage 按 origin 隔离。
4. 测试三档：路由契约（未鉴权 403 / 非布尔 400 / 成功后快照回显）+ 面板渲染档（zh 与 en）；PARSE 档必须绿。
5. 版本 `0.4.27` + CHANGELOG 同步（`repo-hygiene` 断言最新一节 == version）。**做完要重启才生效——先问用户。**

## 3. 四个新 bug（用户 14:29 报，全部未修；先取证再动手）

| # | 现象 | 状态与下一步 |
|---|---|---|
| **B-1** | **AI 推消息进来时"瞬移到最底部"**（用户确认：不是他自己发的） | **未复现到**。0.4.25 起有来源标记：`bt`=强制贴底／`bf`=跟随贴底／`bp`=流式贴底。14:07 那批 `bp=0`、两次 `bt` 都落在该贴的时机（进会话首帧、自己按发送后）。**下一步**：让诊断模式开着（或用带 `?probe=1` 的链接进）、停在会话中上部、等 AI 推进来一次，读 `kbprobe` 直接指认是哪条路。别在拿到这条数据前改代码 |
| **B-2** | 模型选择点"下拉"后不变"上拉"、无法恢复 | 属 0.4.14 自绘列表那条线（`.setting-pick`/`.setting-list`/`.setting-opt`/`.setting-group`）。**观感类**：字符层绿不算依据，须用 CDP 量展开后列表的矩形与可视区（夹具在 `tmp\20261010-dom-*.mjs`、`tmp\20261011-f-kbfirst.mjs`） |
| **B-3** | ↑ 有时一次点击生效两次，第二次效果奇怪 | **现有埋点分不开**——缺"↑ 被按了几次"的标记。**下一步**：在 `.scroll-anchors` 的 click 委托里（`pages.js:1866` 附近，判 `btn.id==='jumpPrompt'`）加一条 `probeMark('up')`；一次点击出现两条 `up`＝双触发（子元素冒泡/重瞄未结束又进一次），只有一条却两次位移＝`settlePromptJump` 的 100ms×4 重瞄在重复推 |
| **B-4** | 输入栏点"换行"变成发送 | **口径已由用户定死：换行就是换行，发送只点箭头。** 待查 `#prompt` 的 keydown：是否区分 `isComposing`（输入法合成态）／`shiftKey`／软键盘 return；改后要有行为测试钉住"换行键插入换行、不触发 send" |

## 4. 今天新踩的坑（会反复用到，别再踩）

1. **`DSH_HOME` 会劫持 pocket 的数据根**。我的 pwsh 工具带 `DSH_HOME=C:\Users\toast\.dsh`，于是独立进程读到的是**另一份**设置档
   （`enabled=false channel=off`），一度让我写下"外部脚本发不出微信"这种错结论。**判据：独立进程读 pocket 设置/凭据前先清
   `$env:DSH_HOME=''`**；真档在 `%LOCALAPPDATA%\dsh-pocket\`。
2. **工具产物≠证据**：我把自己 pwsh 的**超时返回 -1** 当成"计划任务失败"的读数；又把**估算的字节数**（+336 B）写进 CHANGELOG。
   两次都是同一毛病。**字节一律用 `mobilePageAssets()` 实测**（css+js 相加，别只报一个）。
3. **测试沙箱按名抽取函数** ⇒ 页内脚本新增调用要用本仓既有写法 `if(typeof probeMark==='function')…`，
   否则 `ReferenceError` 红一片（今天真红过两档）。
4. **页内脚本是模板字符串出货的 JS** ⇒ 注释里**不能写反引号**，一个就截断模板、`lib/pages.js` 整个模块加载失败；
   守卫是 `test/script-embedding.test.js` 的 **PARSE 档**（今天我又犯一次）。
5. **pwsh 里的正则/引号**：契约字面里 `if(...)` 的圆括号**必须转义**（忘了就匹配不到、还自以为是实现错）；
   含中文引号的 `git commit -m` 不通 → 一律写文件 `git commit -F`；`node -e` 拼复杂脚本必坏 → 落成 `.mjs`。
6. **CRLF**：多行字面量替换会静默 0 命中 → 按行索引或单行锚点。
7. **测试泄漏临时目录**：每跑几次全量，`%TEMP%` 就积上百个 `dsh-pocket-mailbag-settings-*`（本轮清掉 252 个、
   上一轮 1634 个）；Edge 探针也曾每次漏一个 11–58 MB 的 profile（累计 803.9 MB）。**夹具已改为"杀→等退出→带重试删"，
   但 mailbag 测试的 teardown 还没修**（顺手修它，别当额外工作）。
8. **负载敏感假失败**（已知，别当回归改代码）：`tunnel-output.test.js` 的 `S5`（曾报"machine data root changed shape"，
   根因是用目录 mtime 当证据，已被 `877d9f7` 改成条目名集合）、`stream-watermark.test.js`、`notify-judge`。
   流程固定：**单跑 → 复跑全量 → 都过才定性**。

## 5. 常用命令备忘

```powershell
# 读手机回传的滚动时序（诊断模式开着才有）
Select-String -Path "$env:USERPROFILE\.dsh\pocket\logs\pocket.log" -Pattern 'kbprobe' | Select-Object -Last 10
# 字段：tag@perf|scrollTop|scrollHeight|clientHeight|innerHeight|vv.height|vv.offsetTop
# tag: rz 视口变化 / sc 一次滚动 / rs 锚点复原写了 / bt 强制贴底 / bf 跟随贴底 / bp 流式贴底 / on armed 回执
# ⚠ 读法：tag@perf 是一段，后 6 段才是数值；rz 在同毫秒成对出现（两个 resize 监听器共用下游打点），别当两次动作

# 从宿主之外推微信（必须先清 DSH_HOME）
$env:DSH_HOME=''; cd F:\defws\scripts; node dsh-push-notice.mjs "<标题>" "<正文>"

# 重启（红线，须用户发话）
cd F:\defws\scripts; powershell -File .\dsh-restart-now.ps1
```

## 6. 仍挂着、等用户发话的四件

1. **pocket 仓没有远端**（`git remote -v` 空）：今天 20+ 笔只在本地一份历史里。AGENTS 记着该推 `Gaudi-XIX/dsh-pocket`。
2. 根仓 magpie 那 **3 个未提交文件**不是我写的，不代签。
3. **配对页 PIN 框 60 ms 后自动聚焦**（`showPin()`）——用户报"点进来就弹输入法"唯一可复现的来源就是它，
   要不要去掉等他裁（是有意省一次点击，不是 bug）。
4. `CHANGELOG.md` 0.4.19 那节的"摘除清单"语义已变（埋点转为常设工具，0.4.25），**发布过的段落不改写**，
   新状态记在 0.4.25/0.4.26 两节；若日后真要拆埋点，按 0.4.23 那节的路走过。
