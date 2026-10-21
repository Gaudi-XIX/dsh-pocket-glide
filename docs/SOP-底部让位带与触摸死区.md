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
| 两个 dock | `#queueDock` / `#todoDock` | 挂在 `#composer` 的 flex 列里 |
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
function syncTodoHeight(host){ document.body.style.setProperty('--todo-h', host.hidden ? '0px' : (host.offsetHeight + 10) + 'px') }
function syncQueueHeight(host){ ... --queue-h ... }
```

让位 var 栈 = `--composer-h + --todo-h + --queue-h + --tunnel-warn-h`，四处消费：
`.chat-open .messages` 的 `padding-bottom`、`#chatError` 的 `bottom`、`.scroll-anchors` 的 `bottom`、
`@media(display-mode:standalone)` 里同名那一套。

**为什么禁写死**：composer 是 flex 列，每挂一个 dock 高度就往上长；textarea 也会长到 150px。
写死一个数（历史值是 84px）意味着「只要 dock 出现，让位就是错的」。写死 84px 曾直接撞
`test/pages-render-fixes.test.js:127-129` 的两条负向守卫。

## 三、当前覆盖不对称（修 dock 前必读）

| 半边 | 机械钉 | 状态 |
| --- | --- | --- |
| queue（排队） | **6 条**（`test/goal-queue-dock.test.js:535-554`） | 容器/wrapper 透明、三个控件放行、`+1` 守卫、`max-height:180px` 封顶、`.chat-open .messages` 双 dock 让位、`syncQueueHeight()` 与 `toggle('queue-open')` 存在 |
| todo（任务） | **0 条** | `grep` `.todo-dock{` / `.todo-list{` / `todoList.style` 在 `test/` 下零命中 |

**代码里两半边是同构的**（`:1368` 与 `:1402` 逐字同构，CSS 也成对出现），**测试里只有一半被钉**。
也就是说：queue 半边退化会被测试拦住，todo 半边退化不会。

⇒ 修 todo dock 相关问题时，不要因为「queue 那边有测试」就以为自己被覆盖了；
要补钉就照 `goal-queue-dock.test.js:535-554` 那 6 条的形状补，别新发明判据。

## 四、仍未收敛的写死余量（登记，不在本卡修）

`lib/pages.js:502` 是单物理行（19,680 字符），里面还留着这些字面量：

- `116px` / `130px` / `162px` / `300px` / `332px` —— `.turn-running`、`.todo-open`、
  `.turn-running.todo-open`、`.todo-expanded`、`.turn-running.todo-expanded` 五档的 `.messages` 让位
- `72px` —— `body.subagent-open` 下 `.messages` / `.scroll-anchors` / `#chatError` 的让位
- `76px` —— `.session-settings` 与 `.slash-menu` 的 `bottom`
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

## 六、与相邻文件的边界

- `dsh-pocket/AGENTS.md` —— 管**提交纪律**与**测试基线怎么钉**（不可变 sha、判树脏只准 `git diff --name-only`）。
  本文件不管那些。
- `docs/GUI-CHECKLIST.md` —— 管**目验判据**。本文件不复制判据，只说明机理与纪律。
- `test/goal-queue-dock.test.js` / `test/pages-render-fixes.test.js` —— 管**机械拦截**。
  本文件里写的东西凡能写成断言的，最终都该去那里；留在文档里的只有「为什么」。
