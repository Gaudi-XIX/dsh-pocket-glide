# SOP — 底部让位带与触摸死区（dock / composer / 固定层）

> 载体性质：本文件是 pocket 手机页**底部让位带**的规则文档。`lib/pages.js` 里的代码是这件事的
> 可执行面，本文件是它的**不可检索面**——新人修「点了没反应」「划不动」这类症状时，第一站应是本文件，
> 而不是去 `pages.js` 第 502 行那条 19,680 字符的样式行里考古。
> 与 `docs/GUI-CHECKLIST.md` 的关系：那边是**目验判据**（这条长什么样才算对），这边是**机理与纪律**
> （为什么会长成这样、改的时候不能碰什么）。两者单向引用：目验单引本文件，本文件不引目验单。

## 一、死区是怎么长出来的（机理）

底部这一带有四个参与者，任何一处写错都会变成死区：

| 角色 | 元素 | 定位方式 |
| --- | --- | --- |
| 输入条容器 | `#composer` | `position:fixed; bottom:0`，**`pointer-events:none`** |
| 输入条本体 | `.composer-inner` | `pointer-events:auto` |
| 两个 dock | `#queueDock` / `#todoDock` | 挂在 `#composer` 的流内列里（`#todoDock` 2026-10-22 起改为贴右侧的浮动胶囊，见第六节） |
| 浮动层 | `#chatError`、`.scroll-anchors`、`.subagent-stop`、`.slash-menu`、`.session-settings` | 各自 `fixed`，按让位 var 栈算 `bottom` |

死区的成因链：

1. `#composer` 是 `pointer-events:none` 的——它必须透明，否则整条底部渐变背景会吃掉所有触摸。
2. dock 挂在这个透明容器里。dock 自己若也声明 `pointer-events:auto`，那么**它占的那一整块矩形**
   就重新变成不透明：手指落上去命中 dock。
3. dock 的列表（`.queue-list` / `.todo-list`）默认没有可滚内容，且 `#composer` 不是 `#messages` 的祖先，
   事件链一路上溯到 `body{overflow:hidden}` 就断了——**没有任何人消费这次手势**。
4. 于是那块矩形就是死区：视觉上有东西，触摸上什么都没发生。

2026-10-19 实测的形态：`#composer` 上沿到底部 131–168px 的整条带子。

**要点**：死区不是「某个按钮位置不对」，是**一个透明容器里多了一个不透明子节点**。修它的方式不是挪位置，
是让不该接手势的节点重新透明。

## 二、正解三件套（已落地，改动时照此形态）

### 1. 容器整块放行

dock 容器与它的列表 wrapper 一律 `pointer-events:none`，**只有真正有点击语义的控件**才
`pointer-events:auto`。

```
.queue-dock{...pointer-events:none}   /* 容器 */
.queue-list{...pointer-events:none}   /* 列表 wrapper */
.queue-act{...pointer-events:auto}    /* 行内操作钮，唯一例外 */
```

`todo-*` 一族同构（`.todo-dock` / `.todo-list` / `.todo-header`）。

判据：**数一数有多少个 `pointer-events:auto`**。应当等于「有 click 语义的控件种类数」，不是越多越好。

### 2. 只有真的溢出才重新武装滚动

列表的高度是内容决定的，而 dock 高度又参与让位计算，所以「列表能不能滚」不能在 CSS 里写死，要运行时量：

```js
queueList.style.pointerEvents = queueList.scrollHeight > queueList.clientHeight + 1 ? 'auto' : 'none'
```

`lib/pages.js:1368`（queue）与 `:1402`（todo）各一份。

**`+1` 不是误差容忍**：子像素高度会让 `scrollHeight === clientHeight` 在真机上偶尔差 1，
没有 `+1` 会让「刚好一屏」的列表反复横跳。`+1` 是必要的，别顺手改干净。

### 3. 让位高度自量成 CSS 变量，禁写死 px

```js
function syncComposerHeight(){ ... document.body.style.setProperty('--composer-h', px + 'px') }
function syncQueueHeight(host){ ... --queue-h ... }
// todo 半边例外：胶囊高度固定，2026-10-22 起写常量 52px，不再量 offsetHeight（见第六节取舍 2）
function syncTodoHeight(host){ document.body.style.setProperty('--todo-h', host.hidden ? '0px' : (host.querySelector('.todo-header') ? 52 : 0) + 'px') }
```

让位 var 栈 = `--composer-h + --todo-h + --queue-h + --tunnel-warn-h`，**五处**消费：
`.chat-open .messages` 的 `padding-bottom`（主/standalone 两条基础档）、`#chatError` 的 `bottom`、
`.scroll-anchors` 的 `bottom`、`#composer .session-settings` 的 `bottom`。
其中 `.session-settings` 与 `.slash-menu` 另加 76px 抬升（它们浮得更高）。

**`--composer-h` 故意不含 dock**：`syncComposerHeight()` 只量 `.composer-inner` 的高度＋容器
padding。dock 在 composer 的流内、会把 composer 盒子顶高，但 `--composer-h` 不跟着长 ⇒
**凡按 `--composer-h` 定位的固定层，都必须自己把 dock 高度加进让位栈**，否则落在 dock 带里
（2026-10-22 第一版胶囊化在这里栽过一次：把 `.scroll-anchors` 与 `.session-settings` 的
`var(--todo-h)` 摘掉，两颗 anchor-fab 与设置面板当场压到胶囊上）。

**为什么禁写死**：composer 是 flex 列，每挂一个 dock 高度就往上长；textarea 也会长到 150px。
写死一个数（历史值是 84px）意味着「只要 dock 出现，让位就是错的」。写死 84px 曾直接撞
`test/pages-render-fixes.test.js:127-129` 的两条负向守卫。

## 三、当前覆盖不对称（修 dock 前必读）

> 2026-10-22 更新：todo 半边已有 1 条机械钉（`test/goal-queue-dock.test.js` 的
> 「the todo dock is a right-hugging pill above the composer, not a full-width band」），
> 钉的是新胶囊形态（见第六节），不再是无钉半边。

| 半边 | 机械钉 | 状态 |
| --- | --- | --- |
| queue（排队） | **6 条**（`test/goal-queue-dock.test.js:535-554`） | 容器/wrapper 透明、三个控件放行、`+1` 守卫、`max-height:180px` 封顶、`.chat-open .messages` 双 dock 让位、`syncQueueHeight()` 与 `toggle('queue-open')` 存在 |
| todo（任务） | **1 条**（`test/goal-queue-dock.test.js` 的「right-hugging pill」那条，2026-10-22 新增） | 钉新胶囊形态：`width:max-content` + `margin:0 0 8px auto` + `flex-direction:column-reverse`、容器/列表 `pointer-events:none`、头部 `pointer-events:auto`、`touch-action:pan-y`、`syncTodoHeight()` 存在、`$('todoDock').onclick` 存在、仍在 `#composer` 内、点外 pointerdown 收起。**让位栈那条仍靠 queue 半边与 `pages-render-fixes` 顺带覆盖**——todo 自己没有「`--todo-h` 必须留在 `.scroll-anchors` 里」的钉 |

**代码里两半边曾是同构的**（`:1368` 与 `:1402` 逐字同构，CSS 也成对出现）。2026-10-22 起
`#todoDock` 改成贴右侧的浮动胶囊（第六节），queue 半边**未动**，两者从此**不同构**——
改 queue 时不要再照 todo 的形状推断，反之亦然。

⇒ 修 dock 相关问题时，先确认你改的是哪一半；要补钉就照 queue 那 6 条的形状补，别新发明判据。

## 四、仍未收敛的写死余量（登记，不在本卡修）

> 2026-10-22 更新：五档旧让位（`116px` / `130px` / `162px` / `300px` / `332px`）与第二版里的
> `.todo-open .messages{…52px…}` / `.todo-expanded .messages{…120px…}` 两条已随胶囊化
> **整批删除**（其中 `.turn-running*` 三档本来就是死规则——`turn-running` body class 全仓零命中）。
> 现存写死余量只有 `72px` 与 `76px` 两条。

`lib/pages.js:502` 是单物理行（19,680 字符），里面还留着这些字面量：

- `72px` —— `body.subagent-open` 下 `.messages` / `.scroll-anchors` / `#chatError` 的让位
- `76px` —— `.session-settings` 与 `.slash-menu` 的 `bottom`
- `52px` —— 第六节胶囊自身高度，**只有 `syncTodoHeight` 一份**（`height:44px` + `margin-bottom:8px`），
  `.messages` 侧一律消费 `var(--todo-h)`，不再有第二个 52
- `env(safe-area-inset-bottom)` —— 在多处直接与上面这些数相加

而 `test/pages-render-fixes.test.js:127-129` **只钉 `84px` 这一条**负向守卫。

⇒ 现在给上面任何一条加负向守卫都会**当场红**，因为它要钉的正是当前代码里的字面值。
收这些余量是**独立的修复卡**：先把字面量换成自量变量，再补守卫，两步不能并作一步。

## 五、改这一带时的三条硬纪律

1. **先分清「改高度」还是「改透明」**。症状不同：划不动／点了没反应 = 透明问题（第二节 1、2 条）；
   内容被挡／浮层压住 = 高度问题（第二节 3 条）。两类混着改必出回归。
2. **`#chatError` 的覆盖规则必须排在基线 `#chatError{…}` 之后**。同权重后者胜，排前面等于没写
   （`body.subagent-open #chatError{bottom:calc(72px + env(safe-area-inset-bottom))}` 就是这么栽过）。
3. **改完必须在真浏览器量，不在字符层收工**。这一带的 bug 全部是「字符层看不出错」的类型——
   CSS 存在、JS 语句存在、测试字面量匹配，页面照样是死的。判据见 `docs/GUI-CHECKLIST.md` 第 44 条
   与「§4 验证层披露格式」（渲染层缺失时必须明写「渲染层未覆盖」）。

## 六、todo dock 的胶囊化（2026-10-22）

**动因**（用户三条要求）：① 默认往右缩进、收纳到右下角，不再横贯全宽挤压消息区；
② 保持悬浮、不遮挡内容；③ 不与上翻／下翻（`.scroll-anchors` 两颗 anchor-fab）冲突。

**形态**：`#todoDock` 仍是 `#composer` 的子元素（DOM 位置没动），但 CSS 从「flex 流内全宽卡片」
改成「贴右侧、悬浮在输入条上方的小胶囊」：

```css
.todo-dock{display:flex;flex-direction:column-reverse;align-items:flex-end;gap:6px;
  width:max-content;max-width:min(300px,calc(100vw - 28px));margin:0 0 8px auto;pointer-events:none}
.todo-header{...border-radius:999px;background:var(--card);box-shadow:0 2px 10px rgba(0,0,0,.12);pointer-events:auto}
.todo-list{...width:min(300px,calc(100vw - 28px));max-height:min(52vh,340px);touch-action:pan-y;
  overscroll-behavior:contain;box-shadow:0 8px 28px rgba(0,0,0,.18);pointer-events:none}
```

**三个关键取舍**：

1. **`flex-direction:column-reverse`**：展开的卡片在 DOM 里排在胶囊**之后**，靠反向排列画在
   胶囊**上方**——胶囊本身不移动，展开态与收起态的锚点一致。
2. **`--todo-h` 由量高度改成常量 52px**（`syncTodoHeight`：有 header 就是 52px，否则 0px）。
   理由：胶囊高度固定（`height:44px` + `margin-bottom:8px`），而展开卡片是浮层、不占让位；
   旧实现量 `offsetHeight` 在展开态会把整张卡片算进让位。**52 这个数只有这一份定义点**。
3. **让位栈的成员一个都不能少**：`--todo-h` 必须同时留在 `.chat-open .messages`（主/standalone
   两条基础档）、`#chatError`、`.scroll-anchors`、`#composer .session-settings` 四处。
   2026-10-22 第一版曾把后两处的 `var(--todo-h)` 摘掉，理由是「胶囊在输入条内部、fabs 钉在输入条
   上方，两者不同带」——**这个理由是错的**：`syncComposerHeight` 只量 `.composer-inner` 的高度
   （`--composer-h` ≈ 73px，**故意不含 dock**），而胶囊在 composer 的流内、把 composer 的盒子
   往上顶了 52px。所以按 `--composer-h` 定位的固定层实际落在胶囊带里（算例：胶囊占屏幕底
   71–115px，`.scroll-anchors` 在 89px、`.session-settings` 在 76px，双双相交）。摘掉就是让
   ↑/↓ 与设置面板压到胶囊上。⇒ **凡是按 `--composer-h` 定位的固定层，dock 高度就得自己加回来**。
4. **`.todo-open .messages` / `.todo-expanded .messages` 两条已删除**（2026-10-22 第二版）：
   `chat-open` 在 `openSession` 里与 todo 渲染同源挂上，所以基础档 `.chat-open .messages` 已经
   覆盖这两种状态；而展开卡片是**浮层**，像 `.subagent-rows` 一样压着转录区是设计意图、不额外
   留白。旧版那条 `min(42vh,calc(120px …))` 还漏了 `--composer-h`——textarea 长到 150px 时
   让位只剩 120px，最后几条消息会被输入条吃掉。

**点外收起**：todo 胶囊各挂一条 `pointerdown` 监听（与子代理胶囊那条**分开、不合并**——
`test/subagent-panel.test.js` 逐字钉住子代理那条）。

**展开态的几何后果**：卡片是 `.composer` 的流内子元素（`flex-direction:column-reverse`，占
`gap:6px` + 卡片高），所以**展开时 composer 盒子会继续往上长**，`syncComposerHeight()` 只量
`.composer-inner`、量不到它 ⇒ `--composer-h` 不变，四层固定层全部停在原位，只有 `.messages`
被卡片压住（浮层语义，同 `.subagent-rows`）。卡片 `max-height:min(52vh,340px)` + `overflow-y:auto`
+ `touch-action:pan-y` ⇒ 卡内滚动不会带着消息区一起跑。

## 七、与相邻文件的边界

- `dsh-pocket/AGENTS.md` —— 管**提交纪律**与**测试基线怎么钉**（不可变 sha、判树脏只准 `git diff --name-only`）。
  本文件不管那些。
- `docs/GUI-CHECKLIST.md` —— 管**目验判据**。本文件不复制判据，只说明机理与纪律。
- `test/goal-queue-dock.test.js` / `test/pages-render-fixes.test.js` —— 管**机械拦截**。
  本文件里写的东西凡能写成断言的，最终都该去那里；留在文档里的只有「为什么」。
