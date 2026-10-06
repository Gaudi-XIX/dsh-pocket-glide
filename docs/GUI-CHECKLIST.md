# dsh-pocket 手机页 GUI 目验清单

> 载体性质：pocket 手机页（`lib/pages.js` 渲染资产）专属目验清单。`F:\defws\flow-plugin\docs\GUI-CHECKLIST.md`
> 是 flow 看板专用同名文件，两者同名不同物，勿跨产品引用（phantom 引用教训见文末留痕节）。

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
| 6 | question-open 共存态 | 提问 composer 现身、输入框隐藏、body.question-open 在位 | 父卡验收项 5 ⊘→**待构造项：依赖姊妹卡桩态能力**（tools/render-stub.mjs 的 CONFIG.pendingQuestion；姊妹卡已交付〔2026-10-06 apply 落地〕，本项可桩验，尚无首例实践记录） |
| 7 | 回合恰一枚钟 | 每轮消息结束后整轮只在最后一条 AI 气泡结尾一枚钟（用户气泡自持一枚；回合中段与流式中气泡零钟）；判据锚 A18（clocks===2）/A16（clocks===1）/verify-footer-turns T1 | clock 卡 reflux 新卡点（30d2080） |

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
