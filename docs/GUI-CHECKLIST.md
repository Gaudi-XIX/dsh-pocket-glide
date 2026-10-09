# dsh-pocket 手机页 GUI 目验清单

> 载体性质：pocket 手机页（`lib/pages.js` 渲染资产）专属目验清单。`F:\defws\flow-plugin\docs\GUI-CHECKLIST.md`
> 是 flow 看板专用同名文件，两者同名不同物，勿跨产品引用（phantom 引用教训见文末留痕节）。

## 0. 状态（2026-10-07 刷新，卡 2026-10-07-docpatch-pocket-renderstub-todos-doc）

首例实践覆盖：八场景中七场景已有首例实证，**待办未全清零**——

- 场景 1-4：父卡首例（archive/2026-10-06-2026-10-06-fix-pocket-review-findings/lead-render-verification.md，
  4 ✅ 1 ⊘——那个 ⊘ 即当时的场景 6，已被下行 R3 批补落）。
- 场景 5/6/8：R3 audit 批首例（archive/2026-10-07-2026-10-07-fix-pocket-r3-audit-batch/research/
  render-verification.md）：scene1=场景 5（turn 运行态隐藏元素现身）、scene67+scene1b=场景 6
  （CONFIG.pendingQuestion 桩态）、scene1*.png+pages-geometry 场景 A/A2=场景 8。
- **场景 7 仍 ⊘（唯一未清零项）**：repo 桩 EVENTS 无 turn/end 帧，钟不渲染无从目验；判据锚已由
  verify-footer-turns 字符层锁定，待桩态补齐（桩 EVENTS 支持 turn/end）后抽查补实。

常设义务（非待办清单，逐卡生效）：§1 双必选（用户可见面增量 ship 前）照旧；场景 5 任何 UI 增量不得
跳过；§4 四层披露缺层明说；场景 8 判据公式随动——让位 var 栈（84px/safe-area/queue-h/tunnel-warn-h）
变更时同步改判据文案（campaign-final-report record-only 清单在案）。

## 1. 目验触发条件

- 用户可见面（UI/交互/布局）增量 ship 前：换家独立审查 + 渲染层复验双必选（与 flow 仓 stages-verify.md
  「Verification Heuristics」纪律条目同源；字符层测试绿与 HTTP 实测过不构成放行依据）
- 涉及 CSS 几何/焦点/事件链的修复：渲染层必验（沙盒假元素无几何概念，字符层断言验不出布局事实）
- 真机/宿主不可用时：渲染桩离线目验为最低替代档（选桩理由：页面资产换新需宿主重启，桩免重启且可精确
  构造状态；真机恢复后抽查一轮补实机层）
- 范围界：本清单只管手机页渲染资产；pocket 桌面设置面板等其他宿主面 UI 不在此列，按其所在面自己的目验
  惯例走

## 2. 桩验步骤（渲染桩离线目验）

1. `node tools/render-stub.mjs`（默认 http://127.0.0.1:4399/，`--port N` 可换口；桩数据/pendingQuestion 在
   文件头 CONFIG——工具与 CONFIG 参数化由姊妹卡 2026-10-06-feat-pocket-verify-tooling-hygiene 固化）
2. 内嵌浏览器/真浏览器开手机视口 390×844 访问 `/`
3. 按场景构造桩态：goal+排队+媒体行=默认桩；question-open 共存态=CONFIG.pendingQuestion 设值（value shape
   见 pages.js renderQuestionComposer 消费端：`{ rpcId, sessionId, questions: [...] }`，questions 空或缺 →
   composer 隐藏、`question-open` 移除）
4. 重绘触发器：`curl -X POST http://127.0.0.1:<port>/emit`（向活跃 SSE 流注入 goal/change 帧）——场景 4/5 的
   重绘链用它驱动；无活跃流时桩回 503（先开页面再 emit）
5. 逐场景截图 + 几何抽查（elementFromPoint / getBoundingClientRect），对照第 3 节清单逐行记录 ✅/⊘（⊘ 写明原因）
6. 保留活体帧：桩须按宿主节奏发 status 帧（默认桩已带 1.2s keepalive），否则页面报「连接已断开」浮层（桩伪影，
   非产品缺陷——父卡实证；顺带可验断线检测与重连路径）
7. 测毕杀桩进程（Windows 按 PID 精确清杀，勿留 4399 监听）
8. 桩/产品判疑次序：桩只服务目验不改产品行为；桩表现与预期不符时先怀疑桩数据（文件头 CONFIG），再查
   产品码——父卡实证过桩伪影（断线浮层）冒充产品缺陷的形态

## 3. 必覆盖场景清单

| # | 场景 | 判据 | 底稿出处 |
|---|------|------|---------|
| 1 | queueDock 可见可点 | 排队坞渲染于输入框正上方、落在 composer 带、pointer-events 命中自身子节点 | 父卡验收项 1 |
| 2 | 让位与封顶 | 消息区不被坞盖（.messages padding 生效）、queue-list max-height 在场 | 父卡验收项 2 |
| 3 | goalBar 位置 | 不被 absolute toolbar 压住；徽章+目标文案+轮次完整渲染 | 父卡验收项 3 |
| 4 | 编辑态焦点保持 | SSE 事件（POST /emit→goal/change）触发重绘后编辑框仍在、activeElement 保持、光标位置保持 | 父卡验收项 4（修复②） |
| 5 | **默认隐藏元素现身** | turn 运行中+有排队时隐藏元素（排队坞/状态条）真实现身可见——非仅 DOM 存在（gate-lesson 核心场景：字符层断言验不出「该现身时现身」） | memory pocket-review-gate-lesson |
| 6 | question-open 共存态 | 提问 composer 现身、输入框隐藏、body.question-open 在位 | 父卡验收项 5 ⊘→✅ **首例已落**：R3 audit 批（2026-10-07-fix-pocket-r3-audit-batch）render-verification.md 场景 6 ✅（scene67/scene1b，CONFIG.pendingQuestion 桩态，2026-10-07） |
| 7 | 回合恰一枚钟 | 每轮消息结束后整轮只在最后一条 AI 气泡结尾一枚钟（用户气泡自持一枚；回合中段与流式中气泡零钟）；判据锚 A18（clocks===2）/A16（clocks===1）/verify-footer-turns T1 | clock 卡 reflux 新卡点（30d2080） |
| 8 | **错误横幅可见性** | 有文案态下 #chatError 悬于 composer 上沿（bottom=让位 var 栈 84px+safe-area+queue-h+tunnel-warn-h）、不与 .composer-inner 相交、中心 self-hit、视口内；question-open 态横幅仍可见可命中 | R3 audit 卡 T1 首例实证（2026-10-07-fix-pocket-r3-audit-batch）：test/dom/pages-geometry.mjs 场景 A/A2 + 该卡 research/shots/scene1*.png |
| 9 | **状态诚实与交替编排**（2026-10-08 刀④⑤⑥批新增） | ① 列表三态：子代理在跑的父会话行 = running 转圈（非绿勾）；agentAvailable:false 行 = 灰问号 unknown（非绿勾）；真完成才绿勾。② 转录分段：一轮内「过程折叠块→正文→过程折叠块→正文…」按到达序交替（而非过程全堆在正文前）；被回复切断的过程段呈折叠态，轮尾活跃段流式展开。③ 工具折叠标题用桌面词表 join（如「已读取文件并修改了文件」），无计数。 | 刀④⑤⑥批（applyDescendantRunning/taskState unknown/stepTitleFor/交替编排 visibleMessages）；行为测试 visible-interleave.test.js + subagent-session-dom-assertions.test.js STATUS-1..5/PRESET-1..2 + record-projection.test.js 聚合四测；渲染层首例待落（§2 桩验步骤，场景构造=父行 descendantRunning:true 桩态） |
| 10 | **下拉加载的过程反馈与两种终局**（2026-10-09 0.4.5 新增） | ① 从列表顶部起拉，`#pullHint` 现身且文案为「下拉加载更早的消息」；继续拉到 72px 阈值以上文案换「松开即可加载更早的消息」且字色转 `--brand`；松手进请求期文案「正在加载更早的消息…」并带 `.older-spin` 转圈；请求落地/失败后提示随 `settle` 收走（`.visible` 移除）。② 提示条 `pointer-events:none`——下拉过程中返回钮仍可命中。③ 提示条悬于 `#chatView` 顶部（`top:8px`，absolute），**不得压住 `.chat-toolbar` 的返回钮**（工具条 absolute z-index 2，提示 z-index 3 但只占顶部居中一行）。④ 终局两句话各说各事：屏上有内容且已确证无更早 → 行与提示都写「已经是最早的消息了」；屏上为空且已确证无更早 → 都写「没有更多消息了」且灰掉不可点；还能要 → 「加载更多消息」可点。⑤ 已确证到头时松手只回弹，Network 里不得再出现一次 `session.history`。 | 判据锚：`transcript-order.test.js`「the list follows the finger…」新增的挂载/三态字面量断言 + 「the pull hint names the end state instead of arming a dead release」+「J-1 a refused page over an empty transcript says there is nothing more, not more」；**渲染层首例待落**（0.4.5 提交时只有字符层，触屏手势需真机或 CDP touch 事件构造，桩验步骤 §2 无法自动下拉）；实机层待用户手机走查 |

场景 5 是 gate-lesson 的直接对应物，任何 UI 增量不得跳过；场景 1-4 首例实证见父卡
`archive/2026-10-06-2026-10-06-fix-pocket-review-findings/lead-render-verification.md`（4 ✅ 1 ⊘）。

## 4. 验证层披露格式

报验证结论时按四层披露，缺层明说：

- 字符层（测试断言：id/CSS/语句序存在性）
- HTTP 层（桥/RPC 实测）
- 渲染层（浏览器真渲染/截图/几何抽查）
- 实机层（手机真机走查）

「全绿/全过」只允许描述已覆盖层的并集；渲染层缺失时明写「渲染层未覆盖」——不把字符层绿当放行依据。
披露示例：`验证覆盖=字符层+HTTP 层+渲染层；实机层未覆盖`。
反例（gate-lesson 原始形态）：只报「tests 720 全绿」而页面从未在浏览器打开过——四层披露缺渲染层与实机层，
不构成用户可见面修复的放行结论。

## 附：phantom 引用教训留痕

2026-10-06 父卡目验单曾写「真机偶遇时按 GUI-CHECKLIST 补一眼」，而 pocket 仓当时无此文件——本清单落位后
留痕防跨产品引用复发；引用本清单时以本文件实际存在为前提（载体存在性核查）。
留痕不追责：目验单作者按当时认知行事，本清单是机制补位非个案批评——引用任何清单/文档前先 stat 它存在。
