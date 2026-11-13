# Pocket DSH

> 手机不是第二块桌面。它是长任务的输入端，和门禁的放行口。

Pocket 是 DeepSeek Harness（DSH）的移动端接入层。人离开电脑，长任务继续跑：手机上能发指令、看流式回复、点掉权限审批，还能直接管 DS Bot 团队。

它跑在宿主进程里。每个手机页面由宿主按窄屏直接产出，桌面画面不往手机上搬。

本仓的包名是 `dsh-pocket-glide`，GitHub 仓库是 [Gaudi-XIX/dsh-pocket-glide](https://github.com/Gaudi-XIX/dsh-pocket-glide)；它与 GitHub 上的 `shaobeichen/dsh-pocket` 是互不相干的两个项目，而 npm 上的裸名 `dsh-pocket` 又是别人发布的第三个包（v2.12.0，GPL-2.0）——别装错。

---

## 一、它只解决两件事

DSH 在电脑上跑重构、排查、改代码、跑测试时，一个任务常常持续十几分钟到几小时。人离开电脑以后，真正会卡住的只有两个点：

1. **发新指令**：想到什么、发现什么，要马上把话递进去，让电脑继续干；
2. **放行门禁**：Agent 要权限、要人做选择，不点就一直挂着。

其余的事——改配置、装插件、读 diff、翻文件树——留在电脑前做。这条线只做上面两件事，做到点开就通、手指跟得上。

---

## 二、手机页面的技术维度

手机上的体验由下面这些选择共同决定。每一行都是这条线实际站着的位置，以及为它付的账。

| 维度 | 我们选在哪 | 换来的与付出的 |
|---|---|---|
| 运行位置 | 宿主进程内的 Cordis 插件，随 DSH 起停，无独立进程、无守护、无云端 | 装一次就接上，不用另起服务；代价是宿主不跑，手机页也不在 |
| 页面交付 | 宿主现场产出 HTML/CSS/JS，零构建步骤、零前端框架运行时 | 首屏字节完全可控；代价是页面逻辑手写，改版门槛比组件框架高 |
| 体积纪律 | 逐语言的壳资产预算 309,000 B、最低余量 8,000 B；首帧薄文档上限 21,000 B，全部写成测试断言 | 每次冷启动都是可预期的轻；代价是加任何功能先得省出等量字节 |
| 链路 | 局域网内手机到桥走 SSE（`EventSource`）；走出站隧道时改走增量事件轮询（1.5 s 起，退避到 6 s，空闲 30 s）；桥到宿主是出站 WebSocket 多路复用通道 | 局域网下有实时单向流；隧道态不被中间层吞帧，代价是秒级延迟；桥到宿主那半条是出站的，宿主不开入站端口 |
| 首帧 | 文档带 `handoff` / `shell` / `embedded` 三态；薄文档 4.5 s 内自取 `/api/boot`；6 s（Wi-Fi）/ 10 s（弱网）必落 `painted` 或 `failed` | 不出现没有尽头的白屏，失败也说得清是哪一种；代价是多一套首帧状态机和诊断埋点 |
| 网络 | 局域网直连 `0.0.0.0:43127`（占用顺延），外加 Cloudflare Quick Tunnel 出站穿透 | 不碰路由器、不要公网 IP，扫码就能连；代价是临时域名不固定，换址后靠下一条推送、或在微信里发一句话把新地址带回来兜 |
| 交互反馈 | 发送乐观上屏、骨架先到、忙态描边、按压底色；不用 spinner、不用整屏 loading | 手指落下就有回应；代价是失败要能撤回，状态机比「等接口」复杂得多 |
| 视口 | 流式增量落屏；上滑即解除贴底；回底要手动点箭头；软键盘唤起时输入区动态上浮 | 阅读位置不被抢走，输入不被键盘吃掉；代价是滚动与渲染耦合，验收要逐帧看 |
| 状态呈现 | 思考链与工具调用收在同一张折叠卡里直播；子代理折叠行；消息时间今天给时刻、同年补月日、跨年补全年 | 信息密度高但不跳屏；代价是折叠状态要跨重连与分段回填保持一致 |
| 分发形态 | 纯 Web 链接 + PWA 全屏，微信 WebView 第一优先 | 免安装、免应用商店审核，点开就用；代价是拿不到系统级推送，要用 Webhook 补 |

---

## 三、哲学：工具用完就该消失

这条线的排序是固定的：**响应速度 > 状态诚实 > 熟悉感 > 品牌感 > 美观**。

漂亮的界面如果慢半拍，就算失败；看起来能用但点下去没反应的按钮，比没有按钮更坏。

由此得到六条可检查的原则：

* **先看得见，再好用**：先给骨架和上一份数据，再补真数据；
* **状态必须诚实**：加载、失败、断开、等待，各说各的，不拿一个转圈盖住四种情况；
* **不抢视口**：滚动、键盘、流式输出，都不许动用户正在读的位置；
* **减法要明说**：做不到的事写在文档里，不用「即将支持」拖过去；
* **入口固定**：通知里的链接一律落到工作区页，不替你擅自挑一个会话跳进去；
* **加东西先付字节**：预算写进测试，谁加功能谁先省出空间。

设计语言的落点是一句话：好的工具在需要时出现，事情办完就退场，用户记住的是事情办完了，不是这个工具长什么样。

---

## 四、和别的做法分在哪

**与「把桌面投到手机」分界。** 远程桌面、投屏、网页版 IDE 都是把像素搬过去，手机上得到一块缩小的大屏。Pocket 不搬像素：宿主知道屏幕只有几英寸，直接把内容重排成拇指够得着的一列。

**与「云端 SaaS 加账号」分界。** 没有中心服务器，没有注册登录。插件跟着宿主在本机跑，出站用临时隧道，提示词、回复、代码不经过第三方账号体系。

**与「原生 App」分界。** 一个链接就够了，微信里点开即用，不用装、不用等审核、不用管 Android 与 iOS 两套发版。

**与「功能齐全的控制台」分界。** 窄屏上每多一个入口，就多一次误触。环境变量、profile 编排、插件管理、文件树、代码编辑，全部留在电脑。少掉这些不是省事，是这条线顺滑的来源。

**与「通用 Web 聊天壳」分界。** 通用壳能收发消息，但不管长任务里的那些硬细节：权限卡要能点、排队要能看、子代理要能展开、思考链要收在一张卡里、断线回来不能把正在读的位置顶掉。这些是 Pocket 花时间最多的地方。

---

## 五、为顺滑付的工程账

* **内容寻址的长缓存**：壳脚本与样式按内容哈希命名，改一个字节就换一个地址，所以可以放心给一周缓存；
* **首帧必落裁决**：三态文档 + 自取引导包 + 6/10 秒定时裁决，每次落定都记一条诊断，白屏从「偶尔发生」变成可计数的事件；
* **统计单一来源**：冷启动文档里的阶段统计与主页那一屏的七个读数走同一份 `landingSummary` 计算，卡片上的数和点进去看到的必须是同一份；
* **乐观上屏与有期限的运行态**：点了发送字就上屏；「进行中」标记带过期时间，不会永远挂着骗人；
* **增量落屏**：新消息只画新增的那几行，不整屏重绘，长会话滚到一半也不会被拽回去；
* **换址找得回来**：电脑重启后临时隧道换了域名，下一条推送正文末尾会带上当下地址；在微信里发一句话，回话里也会把当前地址给你。

---

## 六、确实不做

以下都想过，结论是不做。每一项都在给「快、轻、跟手」让路：

* **不做全量桌面配置与插件管理**：环境变量、profile、插件安装属于桌面职责，窄屏上配这些容易误触，要改就回电脑前；
* **不做文件树与在机代码编辑器**：手机负责提需求和放行，读 diff、审代码留在大屏；
* **不自建云端与账号体系**：纯本地运行，出站穿透，不在第三方留存内容；
* **不打包原生 App**：纯 Web 链接，免装免审，微信里点开就用、关掉就退。

---

## 七、安装

### 从 npm 装

> `dsh-pocket-glide@0.4.59` 已发布到 npm，直接从 npm 装即可；下面的「从仓库装」留给开发调试。

```bash
dsh plugin --profile <你的 profile> add dsh-pocket-glide
```

装完重启 DSH，桌面侧栏出现 Pocket 图标。需要 DSH `>= 0.2.0-rc.1`。

### 从仓库装（开发调试用）

在仓库根目录先看它要改什么，再落盘：

```bash
node tools/install-to-profile.mjs --dry-run
node tools/install-to-profile.mjs
```

它只改 DSH profile 的 `package.json` 两处（依赖指向本仓、`dsh.profile.bundles` 加一条），改前自动备份；加 `--install` 会顺带跑 `pnpm install`。装完重启 DSH 生效。

### 扫码配对

1. 点击 DSH 桌面端侧边栏的 **Pocket** 图标，打开配对面板；
2. 手机相机或微信扫码即可访问；Safari / Chrome 里可「添加到主屏幕」全屏使用。

### 配置外带通知（可选）

在桌面配对面板里填推送凭据（微信 Server酱 / WxPusher / Bark）：

* 任务完成或等待输入时，手机收到提醒；
* 触发远程重启后，下一条推送（或在微信里发一句话）会带上新生成的公网地址。

---

## 八、运行环境

* **宿主依赖**：DeepSeek Harness `v0.2.0-rc.1` 及以上，Node.js `^22.19.0 || >=24.0.0`；
* **架构形态**：宿主进程内加载（In-Process Cordis Plugin），不是独立进程，随 DSH 启动而起、随退出而止，没有独立后台守护；
* **改动生效**：改 `lib/**` 或新增 bundle 必须**重启 DeepSeek Harness**；手机端还要**完全关闭重开**页面才能拿到新壳，下拉刷新拿到的仍是旧壳；
* **架构细则**：形态、桥的宿主内生命周期、目录与关键常量见 [`docs/SPEC-ARCHITECTURE.md`](docs/SPEC-ARCHITECTURE.md)；
* **网络端口**：默认监听 `0.0.0.0:43127`（占用自动顺延至 `43128`，可用 `DSH_MOBILE_PORT` 显式指定）；
* **外网访问**：内置出站型 Cloudflare Quick Tunnel，无需公网 IP 与端口映射。

> **版本与变更账**：逐版的对外变化（修复 / 契约变更 / 已知边界）见 [`CHANGELOG.md`](CHANGELOG.md)，最新一节对应当前 `package.json` 的 `version`；逐笔施工账在 `git log` 与 flow change 卡里。本仓从 `0.2.0` 起维护这份变更账。

---

## 九、三处对外简介（随 README 同步维护）

**GitHub 仓库简介（About）：**

> DSH 的手机接入层：宿主按窄屏直接产页面，不搬桌面像素。微信提醒点开进工作区，会话就在最上面；发送乐观上屏、流式不拽滚动、审批与排队在手机上完成，还能直接管 DS Bot 团队。纯 Web 链接免安装，局域网直连或 Cloudflare 临时隧道出站，换址后由下一条推送带回新地址；零构建，壳字节预算写进测试。

**npm 包简介（description）：**

> Pocket DSH: a zero-build phone plugin for DeepSeek Harness. The host renders narrow screens, no desktop pixels streamed; optimistic sends, steady scroll, on-phone approvals, LAN or outbound tunnel.

**DSH 插件市场简介（`description.zh`）：**

> 把 DSH 的手机面做成拇指够得着的一列：宿主按窄屏直接产页面，零构建、零前端框架，不搬桌面像素。排序是响应速度 > 状态诚实 > 熟悉感 > 品牌感 > 美观。微信提醒点开进工作区，会话就在最上面；发送乐观上屏，流式不拽滚动，权限审批与排队在手机上完成；新建会话、换模型、传图片文件、看子代理都有。主页右下角可进 DS Bot 团队——成员私聊、群聊、工具审批卡。局域网扫码直连，或走出站 Cloudflare 临时隧道，换址后由下一条推送带回新地址。壳字节预算写进测试。

**DSH 插件市场简介（`description.en`）：**

> Turn DSH's phone side into one thumb-reachable column: the host renders pages for narrow screens, zero build, no front-end framework, no desktop pixels streamed. The order is responsiveness > honest state > familiarity > brand > looks. A WeChat push opens the workspace with the conversation on top; sends appear optimistically, streaming never steals your scroll, approvals and queued prompts happen on the phone, plus new sessions, model switching, image and file uploads, and sub-agent rows. The DS Bot team is a tap away with member DMs, group chat and tool-approval cards. Pair over LAN by QR, or go out through a Cloudflare quick tunnel; after a restart the next push carries the new address. A shell byte budget is asserted in tests.

---

> *"In case I don't see you, good afternoon, good evening, and good night."*

## 开源协议

本项目采用 [MIT](LICENSE) 协议开源。
