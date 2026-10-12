# 交接：拉到顶端加载历史时的抖动修复（`settleOlderShift`）

**交出方**：本会话（手机线）
**接收方**：`session-45e600e1-…`（10-12 00:1x 起持有 `dsh-pocket` 的 pages/client＋bridge 域）
**时间**：2026-10-12 00:2x
**交出原因**：用户 10-12 00:0x 令把 `dsh-pocket` 整块划给 `session-45e600e1`；本线改动与它同处 `lib/pages.js`，按「严格单写者」让出，不再动该仓任何文件。

---

## 1. 要修的现象（用户 m01370 原话）

> 「如果现在把这个上只改为只有那一页历史，加载历史时，滑动有时候好像也会跳几下。其实按照我讲的，拉到顶端拉一下，就跳一个一个会话」

用户当场选定的口径：**位置不动，只修抖动**。（即：保留「拉到顶边拉一下加载一页历史」这个机制本身，不改成别的交互。）

---

## 2. 根因

`lib/pages.js:568`：

```
.msg-hist{content-visibility:auto;contain-intrinsic-size:auto 120px}
```

旧消息行带 `content-visibility:auto`，浏览器在它们**还没被滚进视野时按每行 120px 估算高度**。`fetchOlderPage()` 拼完新页后当场量 `scrollHeight` 做对位，量到的是**估算值**；用户继续上滑、这些行被真正渲染，高度从估值变成真值，视口就跟着位移一次 —— 真机上表现为「跳几下」。

**关键点**：拼完那一次对位不够，因为「估值→真值」的切换发生在之后的若干帧里。

---

## 3. 本线已写入工作树的改动（两处，均在 `lib/pages.js`）

### 3.1 调用点 —— `fetchOlderPage()` 尾部（`lib/pages.js:1314`）

在原有对位之后追加一行调用：

```js
...;skipAnchorOnce=true;paintMessages(messages,false);
box.scrollTop=prevTop+(box.scrollHeight-prevHeight);
transcriptAnchor=readTranscriptAnchor(box);
settleOlderShift(box,transcriptAnchor,4);   // ← 本线新增
return true
```

### 3.2 新函数 —— 插在 `restoreTranscriptAnchor`（`lib/pages.js:1882`）之后、`// 键盘收/放`（`lib/pages.js:1889`）之前

注释 5 行在 `lib/pages.js:1883-1887`，函数体单独一行在 **`lib/pages.js:1888`**。

含上方 5 行中文注释，函数体：

```js
function settleOlderShift(box,anchor,tries){if(!anchor||tries<=0)return;const live=$('messages');if(!live||!live.isConnected||live!==box)return;const rows=box.querySelectorAll(':scope > .message');if(anchor.index>=rows.length)return;const rect=rows[anchor.index].getBoundingClientRect();const delta=Math.round(rect.top-box.getBoundingClientRect().top-anchor.offset);if(Math.abs(delta)>2){box.scrollTop=Math.max(0,Math.round(box.scrollTop+delta));probeMark('ol');transcriptAnchor=readTranscriptAnchor(box)}setTimeout(()=>settleOlderShift(box,transcriptAnchor,tries-1),120)}
```

**设计要点（复跑前请先读这段，否则容易「顺手改对」而破坏原意）**：

1. **`tries<=0` 就返回** —— 这是有意的。`tries` 是「剩余重试次数」，调用点传 4 ⇒ 最多重瞄 5 次（当下那次 + 4 次 120ms 后）。**它和 `restoreTranscriptAnchor` 的 `tries` 语义不同**：后者的守卫是 `if(!anchor)return false`，不挡 0。写测试时若照抄后者的 `tries=0` 惯例，会一进函数就返回、断言全落空（本线踩过，见 §5）。
2. **`live!==box` 守卫** —— 会话切走后 `#messages` 已是另一个节点，此时按旧 box 写 `scrollTop` 是写到已脱离文档的节点上，没意义还会干扰新会话。
3. **`anchor.index>=rows.length` 就返回** —— 与 `restoreTranscriptAnchor` 同一条纪律：行数不够时**跳过写入**，绝不用 `Math.min` 钳到末行（拿与锚点无关的行当基准写 `scrollTop` 正是 B-1 那条「抖一下就扯过去」的成因）。
4. **每次写入后重新 `readTranscriptAnchor(box)`** —— 让重试链跟住**当下真实布局**，而不是一路拿拼完那一刻的旧锚点算。这是本函数与 `restoreTranscriptAnchor` 最重要的区别：后者的重试链复用同一个 `anchor`，这里每轮都重新读。
5. **门槛 `Math.abs(delta)>2`** —— 抖动本身是几像素级，1~2px 的差不动它，免得自己制造抖动。
6. **埋点 tag `ol`**（older layout）—— 与既有 `rz`/`sc`/`rs`/`bt`/`bf`/`bp`/`on`/`up`/`latest`/`nl` 并列。真机取证时看 `pocket.log` 的 `kbprobe` 行即可知道这条修法在不在干活。

---

## 4. 测试（已写入工作树，可独立验证）

`test/pick-toggle-anchor-restore.test.js` —— 该文件原有 5 条（本线此前提交的 toggle + restore 断言），本线追加了 5 条 `settleOlderShift` 断言，**当前 10/10 绿**。

抽取方式与既有 house pattern 一致：

```js
const SETTLE = slice(js, 'function settleOlderShift(box,anchor,tries){', '// 键盘收/放')
```

> ⚠️ **endNeedle 是 `// 键盘收/放`** —— 本函数插在该注释之前，所以切片会把 `settleOlderShift` 整段包进来。若之后有人在两者之间再插函数，这个切片会连带包进去，断言可能莫名变红。**更稳的锚是函数自己结尾**，但 `slice()` 只支持「起点 + 后续某串」，请按需调整。

沙箱构造 `buildSettle(rowsOrFn, boxTop, opts)` 的三个要点：

- `$('messages')` **默认返回 `box` 本身** —— 因为 `settleOlderShift` 第一道守卫是 `live!==box`。传 `opts.staleBox=true` 才返回另一个对象，专门测「会话已切走」那条。
- `readTranscriptAnchor` 的桩返回 `{index:0, offset:b.scrollTop}` —— 这样写一次之后 `peek()` 能看出锚点被重新读了。
- **`tries` 传 1**（不是 0）—— 跑当下这一次、不进重试链。`opts.realTimers` 会把 `setTimeout` 换成记录器（`timers` 数组），留给需要测重试链的断言。

五条断言分别覆盖：行数不足不动 / 偏离时按真实布局对回来（`delta=180` ⇒ `scrollTop 100→280`，marks `['ol']`）/ 差 2px 不写 / 写完重读锚点 / 会话切走不写。

---

## 5. 本线踩过的两个坑（省下接手方的时间）

1. **`tries=0` 会让函数立刻返回** —— 照抄 `restoreTranscriptAnchor` 测试的惯例写的断言全落空，`scrollTop` 纹丝不动、`marks` 为空。改成 `tries=1` 后 10/10 绿。判据：两条函数的 `tries` 语义不同（见 §3 要点 1）。
2. **`new Function` 的形参名不能与函数体内 `let` 同名** —— 一开始把 `transcriptAnchor` 同时写成沙箱形参和内部 `let`，报 `SyntaxError: Identifier 'transcriptAnchor' has already been declared`。去掉形参、只在模板里 `let transcriptAnchor=null;` 即可。

---

## 6. 验证读数（本线实测，供接手方复跑比对）

| 项 | 读数 | 命令 |
|---|---|---|
| PARSE 档 | **7 tests / 7 pass / 0 fail** | `node --test --test-concurrency=1 test/script-embedding.test.js` |
| 本文件行为档 | **10 tests / 10 pass / 0 fail** | `node --test --test-concurrency=1 test/pick-toggle-anchor-restore.test.js` |
| 壳字节（zh） | css 44596 + js 223064 = **267660**，预算 269000，余 **1340** | `mobilePageAssets('zh')` 的 `.css.length` / `.js.length` |
| 壳字节（en） | total 同为 267660 | 同上 |
| 改动前基线 | total **266799**（余 2201） | — |

> 口径提醒：`mobilePageAssets()` 返回的 `css`/`js` 是**字符串**，要 `.length` 才是字节数；直接 `console.log` 整个对象会把整页 HTML 打进 stdout 被截断，请只输出汇总行（用 `console.error`）。

---

## 7. 全量测试未跑 —— 原因与接手方须知

本线**没有跑全量**。原因：工作树混着 `session-45e600e1` 的 11 个未提交文件，跑出来的读数无法归属。接手方在自己那条线上跑全量时，这 5 条断言应一并计入。

---

## 8. 顺带交出的两条定位结论（与本次修复无关，但可省接手方的时间）

**8.1 你那条线的 9 档红，根因是测试沙箱名单漏了一个函数名，不是源码缺陷。**

- 红档：`test/workspace-head-notices.test.js` 6 档 + `test/mobile-assets.test.js` 3 档。
- 决定性证据：把该文件的 `listSandbox` 原样抄成独立 repro 后报 **`ReferenceError: wsFlagClass is not defined`**（抛点 `wsFlagHtml` → `renderWorkspaces`）。
- 补上 `wsFlagClass` 后，`wsFlagHtml` 正常工作，徽标输出 `['待回答']`、`['有错误']` —— 与断言期望一致。
- 涉及两处名单：`test/workspace-head-notices.test.js`（`listSandbox`）与 `test/pages-scroll-anchors.test.js:317` 的 `workspaceSandbox`，**两处都漏**。
- 另需补：新 L 键 `wsNewDone`/`wsQuestion`/`wsError`（`lib/pages.js:759-761`，值 `新完成`/`待回答`/`有错误`）与常量 `WS_FLAGS_MAX=2`（`lib/pages.js:943`）。

**8.2 `'20737 天前'` 那两条断言不是 `timeFor` 的缺陷。**

- `relativeTime(value)`（`lib/pages.js:1371`）拿 `value` 与 `Date.now()` 相减；断言传的 `updatedAt: 9000` 是 **1970-01-01 的毫秒时间戳**，本来就会算出两万天。
- 用真实时间戳实测：`Date.now()-1000` ⇒ `刚刚`；`Date.now()-120000` ⇒ `2 分钟前`。**实现是对的**，是断言喂了占位值。

---

## 9. 接手方要做的三件事

1. 把 §3 的两处改动**保留在你的工作树里**（它们已经在那里了，不需要重新打）。
2. 把 §4 的测试文件与你的测试改动一起提交。
3. 版本号：本线未动（仍 0.4.30）。CHANGELOG 请在你的那一节里加一条说明「拉到顶端加载历史时的抖动：`content-visibility` 估高转真高，补页后按当下布局重瞄 4 轮（埋点 `ol`）」。

---

## 10. 本线不再触碰的范围

自用户裁决起（10-12 00:2x），本线**不再修改 `dsh-pocket` 下任何文件**，包括 `lib/pages.js` 与 `test/pick-toggle-anchor-restore.test.js`。§3/§4 的内容已完整写在本文档里，可独立复现。
