# 面板诊断开关的落地前提 + 四个新 bug（2026-10-11 14:3x 取证待办）

用户 14:29 令：「做面板开关」，并新报四个 bug。本文件把开工前提与待办写全，**下一条照此执行，不用重新考古**。

## 一、开关为什么不能"顺手加上就行"——已查到的硬事实

`lib/settings-store.js:145-171` 的 `save(patch)` **只合并 `notify` 与 `tunnel` 两段**，其余键一律丢弃：

```js
save: (patch) => {
  const next = readSettingsDocument(filePath)
  if (patch.notify …) { next.notify = … }
  if (patch.tunnel …) { next.tunnel.token/hostname = … }
  // 没有 diagnostics 分支 ⇒ 写 {diagnostics:{probe:true}} 会被静默丢掉
}
```

而 `0.4.26` 的后端读的是 `doc.diagnostics.probe`（`bridge.js` 的 `diagnosticsProbeEnabled()`）。
⇒ **如果只加"面板一行 + 一个 POST 路由"，勾上去会被存档层丢掉，开关永远不生效，而且不报错。**
这正是本仓最反对的静默失效。所以开关必须连着存档层一起做，且**必须有存档档来回证**。

## 二、开关的完整改动清单（5 处，按依赖顺序）

1. `lib/settings-store.js`：`save()` 增加 `diagnostics` 分支（照 `tunnel` 那段做**字段级合并**：
   只有 `typeof patch.diagnostics.probe === 'boolean'` 才写），并确认 `readSettingsDocument()` /
   `sanitizeDocument()` 不会把新段过滤掉（读它的白名单实现，别猜）。
2. `lib/bridge.js`：新增 `POST /desktop/diagnostics`（照 `:3868` 的 `tunnel/config` 全套：
   `rejectUnlessDesktop` → `verifySameOrigin` → `JSON.parse(readBody())` → 校验 → `settingsStore.save` → 回快照）。
   **body 必须是严格布尔**，非布尔回 400，不许 truthy 混过。
3. `lib/bridge.js`：`snapshot()` 回一个 `diagnostics: { probe }`，供面板回显（不新增 HTTP 端点）。
4. `lib/pages.js:2272` 的 `panelSectionsHtml`（`#deviceExtras`/`#notifyPanel` 内）插一行开关控件；
   **zh/en 两套文案都要给**（照 `text.notify*` 那批键的写法），文案必须写清代价：
   开着时手机每滑动 1.5 s 回传一批滚动时序、日志会涨、**换隧道域名要重新用带 `?probe` 的链接进一次**。
5. 测试三档：存档 round-trip（存进去再 load 还在）、路由契约（未鉴权 403 / 非布尔 400 / 成功后快照回显）、
   面板渲染档（zh 与 en 都含该控件与文案）。**PARSE 档必须绿**（页内脚本是模板字符串出货的 JS）。

字节：面板是电脑端页面，不进手机壳预算；`snapshot()` 多一个布尔无影响。

## 三、四个新 bug（全部**未开工**，都要先取证再改）

### B-1 AI 推消息进来时"瞬移到最底部"（用户 14:29 确认：是 **AI 发消息**时，不是他自己发）

- 已有手段：0.4.25 的三个来源标记。**下一次发生就有的读**：
  `bt`=被强制贴底（`pages.js:1401` 首帧 / `:1697` 自己发送后）、`bp`=流式增量贴底、`bf`=跟随态贴底。
- 14:07 那批样本里 `bp=0`、两次 `bt` 都落在该贴的时机 ⇒ **那次没抓到**。别据此说"没问题"，也别据此改代码。
- 待取证条件：手机停在会话中上部、AI 正在输出时，让它发生一次，我读 `kbprobe` 直接指认是哪条路。
  注意：诊断模式必须开着（换域名后要重新用带 `?probe=1` 的链接进一次，理由见上面第 4 条代价说明）。

### B-2 模型选择：点下拉后不会变成上拉、无法恢复

- 这是 0.4.14 自绘列表那条线（`.setting-pick`/`.setting-list`/`.setting-opt`/`.setting-group`）。
- 现象待确认到底是：面板向上展开时被容器/`overflow` 裁掉，还是滚动位置/焦点没跟随，
  导致"看起来不能恢复"。**先按观感类问题处理：字符层测试全绿不算依据**，要真机/CDP 量它展开后
  列表的矩形与可视区（`#messages` 同理那套 CDP 夹具可用）。

### B-3 ↑（回上一条提问）有时一次点击生效两次，第二次效果奇怪

- 现有实现：`.scroll-anchors` 的 click 委托里按 `btn.id==='jumpPrompt'` 走逐条回翻 +
  `settlePromptJump` 100ms×4 重瞄。**"两次生效"高度可疑于**：click 委托被触发两次
  （按钮内 SVG 子元素冒泡 / 上一次重瞄尚未结束又进一次），或重瞄把已到位的位置又推了一次。
- 取证方式：`kbprobe` 已记 `sc`，但**没有记"↑ 被按了几次"** —— 需要在 `jumpPrompt` 的 handler 入口
  加一条打点（如 `up`），一次点击若出现两条 `up` 就是双触发；只有一条 `up` 却是两次位移就是重瞄的问题。
- 这条要**先加一条打点再复现**，不要凭读代码定案。

### B-4 输入栏里点"换行"变成了发送

- 现象直指 Enter 键处理没有区分：输入法 composing（`isComposing`）、`shiftKey`、
  以及"换行键"（移动端软键盘的 return，`enterKeyHint`/`inputmode` 语义）三者。
- 取证/修法方向：查 `#prompt` 的 keydown 绑定（是否有 `e.shiftKey` 与 `e.isComposing` 双条件），
  以及 textarea 上有没有 `enterKeyHint`。用户诉求是**"换行就是换行"**：软键盘的换行键应插入换行，
  发送要留给明确的发送钮 —— 这是行为决策（谁按 Enter 发送），改前需用户确认口径。

## 四、当前进度与状态

- pocket `HEAD = af44ead`（0.4.26：公网裸地址 + `diagnostics.probe` 后端读取 + 两侧契约），
  工作树干净；全量 1066 / 1064 pass / 0 fail / 2 skipped。
- **0.4.26 还需一次重启才生效**（改了桥）。开关做完后两件事一起重启，少掉一次掉线。
- 本轮**未动任何代码**：上下文已尽，与其写出静默失效的开关，不如把前提和取证路径写清。
