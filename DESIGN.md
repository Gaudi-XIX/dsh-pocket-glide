---
name: Pocket DSH
description: DSH 的轻量手机伴侣——快、顺滑、跟手；界面本身不该被记住。
colors:
  paper: "#ffffff"
  paper-dark: "#141416"
  ink: "#18191c"
  ink-dark: "#f5f5f6"
  muted: "#6b7076"
  muted-dark: "#95979d"
  line: "#e5e7eb"
  line-dark: "#303034"
  card: "#ffffff"
  card-dark: "#1d1d20"
  hover: "#f2f3f5"
  hover-dark: "#29292d"
  surface: "#f7f7f5"
  surface-dark: "#202023"
  brand: "#4d6bfe"
  brand-dark: "#6f86ff"
  danger: "#c62f3c"
  danger-dark: "#ff9ba1"
  pin-row-bg: "#f2f5ff"
  pin-row-bg-dark: "#1b1d2b"
  pin-row-line: "#c9d5ff"
  pin-row-line-dark: "#3a4270"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body-lg:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.3
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
  caption:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
    height: "44px"
  button-primary-dark:
    backgroundColor: "{colors.ink-dark}"
    textColor: "{colors.paper-dark}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
    height: "44px"
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
    height: "44px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "10px 16px"
    height: "44px"
  input-composer:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "12px"
  card-row:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "12px"
  chip-pill:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "2px 7px"
---

# Design System: Pocket DSH

> 依据 `lib/pages.js:835-836`（token 定义）、`lib/pages.js:546/837/843`（字体）、实测样本统计（字号/圆角/内距/阴影/动效时长）。
> 所有对比度数字由 WCAG 2.1 相对亮度公式实算，不是估算。

## 1. Overview

**Creative North Star: "The Vanishing Tool"（消失的工具）**

这个系统的目标是让界面消失。用户打开 Pocket 的那一刻，他脑子里应该只有一件事——我要发的那句话——而不是"这个 App 挺好看"。所有视觉决策都服从一条排序：**响应速度 > 状态诚实 > 熟悉感 > 品牌感 > 美观**。任何在这一排序上越级的装饰都是错的，哪怕它确实更好看。

整套系统建立在**减法**上：一个强调色、一套系统字体、两种阴影、四个圆角档位。少不是风格，是工程约束的诚实表达——手机壳（HTML+CSS+JS）钉死在逐 locale 的字节预算内，每一个像素的样式都要为"微信里点链接秒开"让路。所以这里的极简不是审美选择，是**代价换来的性能**。

它明确拒绝：SaaS 落地页的营销排版、AI 工具的紫蓝渐变与玻璃拟态、对微信原生的机械模仿、对桌面端布局的窄屏平移。它也不做装饰性动效——动效唯一的职责是让状态变化被看见。

**Key Characteristics:**
- 一个强调色（品牌蓝），按屏占用 ≤10%，只用于主操作、当前选中、状态指示
- 纯系统字体栈，零自定义字体（字节预算决定）
- 静止状态不用阴影表达层级；层级靠留白、底色分层与 1px 描边
- 触摸目标 44×44px 是底线，不是建议
- 深色模式与浅色模式完整对称，两套 token 都必须是第一等公民
- 中文与英文两套文案同等完整

## 2. Colors

冷调中性色打底，一个电光蓝作唯一强调色——底色几乎无色相，所以那个蓝一旦出现就是唯一的注意力焦点。

### Primary

- **Electric Companion Blue**（浅色 `#4d6bfe` / 深色 `#6f86ff`）：唯一强调色。只出现在主操作按钮、当前选中的标签/行、进行中的状态指示（忙态、未读）。**不做装饰，不做背景填充，不做标题着色。**

### Neutral

- **Pure Paper**（浅色 `#ffffff` / 深色 `#141416`）：页面底色。深色用近黑而非纯黑，避免 OLED 上边缘发灰与对比过硬。
- **Ink**（浅色 `#18191c` / 深色 `#f5f5f6`）：正文与标题。浅色不是纯黑，是带一点冷灰的深墨，长时间阅读不刺眼。
- **Muted Graphite**（浅色 `#6b7076` / 深色 `#95979d`）：次要文字——时间戳、说明、占位符、计数。**这是唯一允许弱化的文字档，弱化只能用这个颜色，不允许用 opacity。**
- **Hairline**（浅色 `#e5e7eb` / 深色 `#303034`）：分隔线与容器描边。1px，不加重，不做色带。
- **Card Stock**（浅色 `#ffffff` / 深色 `#1d1d20`）：卡片与浮层底色。浅色模式下卡片与纸底同色——靠描边与留白分离，不靠明度差。
- **Quiet Surface**（浅色 `#f7f7f5` / 深色 `#202023`）：次级容器底——输入区外层、分组背景、次级面板。比纸底暖一档（`#f7f7f5` 带极轻的暖调），是唯一带温度的中性色。
- **Press Wash**（浅色 `#f2f3f5` / 深色 `#29292d`）：按压/hover 反馈底色。**按压必须有可见反馈，靠这个色，不靠缩放。**

### Semantic

- **Signal Red**（浅色 `#c62f3c` / 深色 `#ff9ba1`）：危险、失败、拒绝。**只用于真实危险**——不用它做强调、不做装饰、不用它标记"重要"。

### Named Rules

**The One Accent Rule.** 全系统只有一个强调色。品牌蓝在任意一屏的占用面积不超过 10%。它的稀有就是它的力量——如果一屏里出现两处蓝，其中一处一定是错的。

**The 4.33 Rule.** 浅色模式下品牌蓝 `#4d6bfe` 在纸底上只有 **4.33:1**，不达 WCAG AA 的正文门槛 4.5:1。因此：**品牌蓝在浅色模式下禁止作为小正文文字颜色**——只能用于 ≥18.66px 粗体字、图形、图标、边框、焦点环（这些门槛是 3:1）。需要品牌色小字时改用 `#3a55e0`（**5.91:1**）。深色模式下 `#6f86ff` 在纸底 **5.72:1** 达标，可直接作文字。

**The Inverted Primary Rule.** 主按钮是**反色按钮，不是蓝底按钮**。浅色：`--ink`（`#18191c`）底 + `--paper`（`#fff`）字 = **17.58:1**；深色：同样是 `--ink`/`--paper`，即 `#f5f5f6` 底 + `#141416` 字 = **16.89:1**。两侧必须同构（深底浅字 ↔ 浅底深字），**任何一侧改成蓝底白字都判不合格**——`#fff` on `#6f86ff` 仅 **3.22:1**，on `#4d6bfe` 仅 **4.33:1**。深色侧曾违规（`lib/pages.js:836` 旧覆盖），**2026-10-28 已移除**，现两模式同构。

**深色为什么用反色而不用品牌色**（用户 2026-10-28 拍板）：宿主 DSH 自己的深色主按钮就是近白底（`brand-primary` 在深色下解析为 `neutral-bluish-50` #f9fafb），Pocket 必须与其同构，否则手机页比桌面页"更蓝"。**品牌色的适用边界**：只用于非按钮元素——链接、焦点环、状态点、图标、进度、危险动作用危险色。2026-10-16「深色用品牌强调色」讲的是强调色，**不是按钮底色**，两者不冲突。

**The Verdict Table Rule.** 对比度争议一律查这张实算表，不靠肉眼判断：

| 组合 | 对比度 | AA 正文（4.5） |
|---|---|---|
| **浅色主按钮** 白字 `#fff` / 墨底 `#18191c` | **17.58** | 过（实装） |
| **深色主按钮** 深字 `#141416` / 反色底 `#f5f5f6` | **16.89** | 过（实装，2026-10-28） |
| 浅色 正文 `#18191c` / `#fff` | **17.58** | 过 |
| 浅色 次要 `#6b7076` / `#fff` | **4.99** | 过 |
| 浅色 次要 `#6b7076` / 表层 `#f7f7f5` | **4.66** | 过 |
| 浅色 危险 `#c62f3c` / `#fff` | **5.42** | 过 |
| 深色 正文 `#f5f5f6` / `#141416` | **16.89** | 过 |
| 深色 次要 `#95979d` / `#141416` | **6.30** | 过 |
| 深色 次要 `#95979d` / 卡片 `#1d1d20` | **5.76** | 过 |
| 深色 危险 `#ff9ba1` / `#141416` | **9.16** | 过 |
| 深色 品牌蓝 `#6f86ff` / `#141416` | **5.72** | 过（可作文字） |
| 浅色 品牌蓝 `#4d6bfe` / `#fff` | **4.33** | **不过**（仅图形/大字） |
| 浅色 品牌蓝 `#4d6bfe` / 表层 `#f7f7f5` | **4.04** | **不过**（仅图形/大字） |
| 浅色 品牌蓝 `#4d6bfe` / 置顶行底 `#f2f5ff` | **3.98** | **不过**（仅图形/大字） |
| 白字 / 品牌蓝底 `#6f86ff`（深色，旧覆盖已删） | **3.22** | **不过**（本项目不使用） |
| 白字 / 品牌蓝底 `#4d6bfe` | **4.33** | **不过**（本项目不使用） |

## 3. Typography

**Display Font:** 无（这个系统没有显示字体，也不需要）
**Body Font:** 系统栈 `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
**Label/Mono Font:** `ui-monospace, SFMono-Regular, Menlo, monospace`（仅代码块与工具输出）

**Character:** 没有字体设计，只有字体纪律。系统栈是唯一解——它为字节预算让路，代价是完全放弃品牌辨识度，这是有意识的交易。所以排版的全部功力必须落在**层级、间距、字重**上，而不是字体本身。

### Hierarchy

系统实际使用的字号分布（实测出现频次）：`13px`×36、`12px`×29、`11px`×28、`14px`×15、`15px`×8、`19px`×4、`16px`×4。**重心明显偏低**——大量 11–13px 的辅助信息。这是移动端信息密度换来的，但也踩在可读性边缘。

- **Title**（600, `19px`, 1.3）：页面级标题、会话名。一屏最多一处。
- **Body Large**（400, `15px`, 1.6）：消息正文、主要阅读区。
- **Body**（400, `14px`, 1.5）：默认正文、列表主文字、按钮文字。
- **Label**（500, `12px`, 1.4）：次级标签、字段名、可点的辅助文字。
- **Caption**（400, `11px`, 1.4）：**仅限非交互、非关键信息**——时间戳、计数、徽标。
- **Mono**（400, `13px`, 1.55）：代码块、工具调用参数、路径。

### Named Rules

**The 11px Ceiling Rule.** 11px 是辅助信息的上限，不是正文的下限。**可点文字的正文不得小于 12px，长文本正文不得小于 13px。** 11px 只允许出现在不需要点、不影响决策的位置上（时间、计数、状态徽标）。任何把可点文字压到 11px 的改动直接判不合格。

**The Weight-Not-Size Rule.** 需要拉开层级时，先用字重（400→500/600）和颜色档（ink→muted），最后才动字号。系统已有 6 档字号，再增加档位就是失控。

**The System Stack Rule.** 禁止引入任何自定义字体（含中文 Web 字体、图标字体）。图标一律内联 SVG。理由不是审美，是壳字节预算——一个中文字体子集就能吃掉整个预算的几十分之一。

## 4. Elevation

**这个系统基本上是平的。** 层级主要靠三件东西表达：留白、底色分层（`paper` → `surface` → `card`）、1px 描边（`line`）。阴影不是层级工具，是**"这个元素真的浮在页面之上"的信号**，只有真正脱离文档流的元素才配用它。

实测全库只有两种阴影主题，它们构成完整的阴影词汇表：

### Shadow Vocabulary

- **Lifted**（`box-shadow: 0 2px 10px rgba(0,0,0,.12)`）：轻浮起。用于贴底浮动的控件（回底箭头、小提示条）。它是"浮起来一点点"。
- **Overlay**（`box-shadow: 0 8px 28px rgba(0,0,0,.18)`）：真浮层。用于模态、弹层、覆盖在内容之上必须立刻被识别为"另一层"的东西。

### Named Rules

**The Flat-At-Rest Rule.** 静止状态不用阴影表达层级。列表行、卡片、分组、面板——一律零阴影，靠描边与留白分离。**如果一屏里出现三处以上阴影，那三处里至少两处是错的。**

**The Two-Shadow Rule.** 阴影词汇表只有两档。需要第三档时，说明层级设计错了，回去用留白解决，不要新增阴影值。

**The No-Glow Rule.** 禁止发光效果（`box-shadow` 带色相、`filter: drop-shadow` 带色、外发光边框）。这个系统里没有任何东西需要发光。

## 5. Components

### Buttons

- **Shape:** 柔和圆角（`12px`，`{rounded.md}`），不是胶囊；只有标签/筛选器用胶囊（`999px`）。
- **Primary（反色按钮，不是蓝底）:** 墨底 + 纸字——浅色 `--ink`/`--paper`（**17.58:1**），深色同为 `--ink`/`--paper` 即白底深字（**16.89:1**）。内距 `10px 16px`，最小高度 `44px`。**任何一侧做成蓝底白字都判不合格**（Inverted Primary 规则），**主按钮同屏只允许一个**。
- **Ghost:** 表层底（`surface`）+ 正文色，用于次级操作。**ghost 与 primary 在同一屏出现时，primary 只能有一个。**
- **Danger:** 危险红底 + 白字，仅用于不可逆操作（拒绝、删除）。
- **Hover / Focus:** 按压态靠底色变化（`hover` 档）表达，**不靠缩放、不靠位移**。焦点环用品牌蓝实线（非文本 3:1 门槛，`#4d6bfe` 的 4.33 达标）。
- **Disabled:** 降不透明度到 `0.5` 且**保留形状与尺寸**——不允许禁用时改变布局。
- **Loading:** 保留按钮尺寸，内部换成忙态指示，**不允许按钮在加载时消失或缩水**。

### Chips

- **Style:** 表层底（`surface`）+ 次要文字色（`muted`），胶囊圆角（`999px`），内距 `2px 7px`，字号 `12px`。
- **State:** 选中态换成品牌蓝底或品牌蓝描边 + 品牌蓝字（**注意 4.33 规则：浅色模式下品牌蓝字在小字号不达标，选中态优先用"品牌蓝底 + 白字/深字"而非"蓝字"**）。
- **Role:** 只做标记与筛选，不做主要操作入口。

### Cards / Containers

- **Corner Style:** 会话行与内容卡 `12px`；输入区外框 `16px`。
- **Background:** 浅色模式卡片与纸底同色（`#ffffff`）；深色模式卡片比纸底亮一档（`#1d1d20` vs `#141416`）。**这是两套模式唯一不对称的地方，因为浅色靠描边、深色靠明度差。**
- **Shadow Strategy:** 零阴影（见 Flat-At-Rest 规则）。
- **Border:** `1px` + `line` 色。**只用 1px，禁止彩色左侧竖条、禁止 >1px 描边。**
- **Internal Padding:** 基准 `12px`（`{spacing.md}`），区块级 `24px`（`{spacing.lg}`）。

### Inputs / Fields

- **Style:** 卡片底 + `16px` 圆角 + `1px` `line` 描边，内距 `12px`。
- **Focus:** 描边换成品牌蓝（1px 加粗到 2px 也行，但**不允许出现外发光**）。
- **软键盘避让：** 键盘唤起时输入区必须精准上浮，不遮挡输入内容、不顶碎布局。**这是硬要求，不是优化项。**
- **Error / Disabled:** 错误态用 `danger` 描边 + 下方 `12px` 说明文字；禁用态降不透明度，保留布局。

### Navigation

- **Style:** 顶部条与页面同底（`paper`），不用阴影，用 `1px` 下描边（`line`）。标题 `19px`/600 居中或居左，返回控件在左。
- **States:** 当前选中用品牌蓝标记（文字色或 2px 指示条），未选中用 `muted`。
- **Mobile treatment:** 顶部不放只有一只手够不到的关键动作；主要操作下沉到拇指区。
- **回底箭头：** 浮起控件（`Lifted` 阴影），只在下滑离底时出现，轻点平滑回底，**绝不自动回底**。

### Signature Components

**审批卡（Permission Card）。** 这是 Pocket 存在的理由之一，视觉上必须做到三件事：允许/拒绝两个动作在拇指可达区、按钮 ≥44px、桌面端才能回答的卡**如实标注且不出借按钮**。假按钮是这条线最严重的错误——它让用户以为点了会生效，实际什么都不会发生。

**工具调用折叠卡（Tool Call Fold）。** 思考链与工具调用收拢在同一张卡内平滑更新，**更新时不许跳屏、不许撑开改变滚动位置**。折叠行的运行态用忙态描边（品牌蓝 1px 到 2px 的呼吸感描边），不用旋转 spinner。

**忙态标记。** 表示"正在跑"的唯一语言是描边/底色的轻微脉动。禁止使用旋转 loading 图标、禁止使用进度条假装知道进度。

## 6. Do's and Don'ts

### Do:

- **Do** 用 `44×44px` 作为所有可点目标的命中区底线（`test/mobile-assets.test.js` 已钉死，改小即测试红）。
- **Do** 把主按钮做成反色：浅色墨底白字、深色白底墨字，两侧同构（17.58 / 16.89:1）。
- **Do** 用 `muted` 档表达弱化，而不是给 `ink` 加 opacity——opacity 会让对比度不可预测。
- **Do** 让按压有可见反馈（`hover` 底色变化），因为触摸屏没有光标悬停这个中间态。
- **Do** 保持深色与浅色两套 token 完整对称，新加颜色必须同时给出两档。
- **Do** 新增任何视觉元素前先算字节，壳预算（逐 locale）是硬上限，不是参考值。
- **Do** 在动效里设 `prefers-reduced-motion` 降级。
- **Do** 把时长控制在 120–250ms；超过 250ms 必须能说清它传达了哪个状态。

### Don't:

- **Don't** 用 `#4d6bfe` 当浅色模式的小正文文字色——4.33:1 不合格（见 4.33 规则）；它作图标、边框、大字、焦点环是合规的。
- **Don't** 把主按钮任何一侧做成蓝底白字——`#fff` on `#6f86ff` 仅 3.22:1、on `#4d6bfe` 仅 4.33:1，两个都不合格（Inverted Primary 规则）。
- **Don't** 用紫蓝渐变、玻璃拟态、发光边框、霓虹强调色——这是"AI 工具默认长相"，PRODUCT.md 明确列为反例。
- **Don't** 做 SaaS 落地页式排版（hero 区、大标题配副标题的营销结构）——这是工具，不是官网。
- **Don't** 机械模仿微信原生（不用微信绿、不做"看不出是另一个 App"）——它是 DSH 的一部分。
- **Don't** 把桌面端布局平移到窄屏——桌面按大屏设计的信息密度直接搬过来就是挤。
- **Don't** 加装饰性动效。动效只服务状态变化，不服务"有活力"。
- **Don't** 用超过两档的阴影值；也不要在静止状态用阴影表达层级（Flat-At-Rest）。
- **Don't** 用彩色左侧竖条或 >1px 描边做强调——强调靠品牌蓝与字重。
- **Don't** 在列表/卡片上用旋转 spinner 表示加载——用骨架态（内容形状占位），不用居中转圈。
- **Don't** 把可点文字压到 11px 以下，也不要把正文压到 13px 以下（11px Ceiling 规则）。
- **Don't** 引入自定义字体、图标字体、Web 字体——系统栈 + 内联 SVG 是唯一解。
- **Don't** 让任何自动行为改变用户当前滚动位置（PRODUCT.md 原则 3）。用户向上滑走，贴底逻辑必须解除。
- **Don't** 出借点了没用的按钮。做不了的按钮要么标注"需回到电脑前"，要么不给按钮——**假按钮比缺失的按钮更坏**。
- **Don't** 在加载/禁用时改变控件尺寸——不允许布局跳动。

---

<!--
配套：PRODUCT.md（产品目的、定位、反例、六条产品原则、可访问性）
验收用法：改动后按本文件「Do's and Don'ts」逐条对，加上 PRODUCT.md 六条原则，全过才算过。
本次未生成 `.impeccable/design.json` 面板 sidecar——它只服务 impeccable live panel 的组件预览，本项目不用那个面板；需要时再补。
-->
