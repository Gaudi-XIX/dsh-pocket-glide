// WP-REPO-B — 仓库面卫生钉（change 2026-10-02-fix-pocket-audit-remediation）
//
// 面：只读源码文本 / JSON。不起服务、不开 socket、不触网、不碰真机 profile、
// 不读写任何真机数据根（`%LOCALAPPDATA%\dsh-pocket`、`~\.dsh` 都不在本文件的面上）。
// 唯一 spawn 出去的子进程是 ⑧ 的 `tools/fetch-cloudflared.mjs --print`：那条分支
// （脚本里的 `printOnly`）只打印契约、`process.exit(0)`，不下载、不落盘；本文件另外
// 钉了「跑完 `vendor/` 的存在性与跑前一致」，所以它连目录都不会建。
//
// 每条 test 头上都有一行「钉的是哪句语义」，那是这条断言的**存在理由**。
// 本仓已有教训：一条只写数字的源级计数断言，下一个 worker 的第一反应是删断言。
// 所以要动这里之前，先改被钉的那句话（README / package.json / 工具头注），再随动本文件；
// 反过来做（删断言保字面）就是让同一句谎话重新上岗。
//
// 这份文件**故意不钉**的东西（不是漏了，别顺手补上）：
//   · `package.json version` 的**数值** —— 提位属发布决策，钉住现值等于替那个决策投票。
//     从 0.2.0 起本仓维护 `CHANGELOG.md`（README「打包与许可」已改写成引它为准），
//     所以 ⑨ 钉的是「CHANGELOG 在场 + 其中最新一节就是当前版本 + README 不再声称不维护它」，
//     仍然不钉版本号本身、也不钉任何条目的正文。
//   · `pnpm-workspace.yaml` 是否存在 —— LEAD（K-3）裁的是「删，或缩成真实需要的最小声明」
//     两条都可，而且 `pnpm approve-builds` 这类正常操作本来就会把它再生成一遍；
//     钉存在性会把合法的工具行为读成红。WP-REPO-B 已经把它删了，账在 handoff 里。
//   · `lib/**` 的实现细节与 `lib/constants.js` 的导出数值（连接密码位数、cookie TTL……）
//     —— 这些符号此刻由 bridge 域工人独占写，钉它的现值就是跨包假红。本文件只在 ⑧ 读
//     `lib/tunnel.js` 的**契约字面**（pin / 资产名 / 摘要 / vendor 档名），因为那条关系是
//     「工具 ↔ 运行时」，红的时候两边都归仓库面读者管，且 tunnel 侧当前无人改写。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const pkg = JSON.parse(read('package.json'))

// ①（tasks.md AC-R 第①条）
// 钉的是哪句语义：README「打包与许可」第一行——「`package.json files` = lib/**/*.js、
// client/**/*.js、`test`、`tools`、`cordis.patch.yml`、`README.md`、`LICENSE`、`CHANGELOG.md`」，加上同节
// 那句「列全 `test`/`tools` 的意义是：发布件里 `npm test` 与 README 承诺的工具面真能跑」。
// `test` 不在 files 里 ⇒ `npm pack` 出来的包跑不出 README 承诺的验证；`tools` 不在 ⇒ README
// 「测试与工具」整节对发布态用户是空头话。同时钉「每一项都真在盘上」：`files` 里的幽灵项
// 是下一次「声明了一个已经不存在的东西」的起点，而这正是本卡整族错误的形状。
test('① files 收编了 README 承诺的每一项，且每一项都在盘上', () => {
  for (const promised of ['test', 'tools', 'LICENSE', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md']) {
    assert(pkg.files.includes(promised), `package.json files 必须含 '${promised}'（README 正在承诺它）`)
    assert(existsSync(join(root, promised)), `files 里的 '${promised}' 必须真在仓里，不能只是声明`)
  }
  assert.match(
    pkg.scripts.test,
    /test\/\*\.test\.js/,
    '默认测试命令必须跑 test/ 套件；改了它就同时改 files 与 README，别只改一处',
  )
})

// ②（tasks.md AC-R 第②条）
// 钉的是哪句语义：`package.json` 的 `"license": "Apache-2.0"` 这一**声明**。
// 声明一个许可证而没有正文 = 把许可义务推给读者去猜；正文里留着 Apache 附录的模板占位
// （`{yyyy}` / `{name of copyright owner}`）= 有正文但没署名，法律上仍然没落地。
// 权利人名字本身不钉死（WP-REPO 记档：LEAD 若换正式权利人名称，只改那一行）——钉的是
// 「填过年份的版权声明行存在」这个不随人名漂移的形状。
test('② 声明 Apache-2.0 ⇒ LICENSE 正文在场、随包发布、不是未填模板', () => {
  assert.equal(pkg.license, 'Apache-2.0', 'README 与 LICENSE 都以这个 SPDX id 为准')
  assert(pkg.files.includes('LICENSE'), '许可证正文必须随包发布，否则声明到用户手里是空的')
  const license = read('LICENSE')
  assert.match(
    license.split('\n').slice(0, 4).join('\n'),
    /Apache License/,
    '首屏必须是 Apache License 标题（不是自写摘要顶上去的）',
  )
  assert.doesNotMatch(license, /\{yyyy\}|\{name of copyright owner\}/, '附录占位不得原样留着')
  assert.match(license, /Copyright\s+\d{4}/, '必须有一行填了年份的版权声明')
})

// ③（tasks.md AC-R 第③条）
// 钉的是哪句语义：tasks.md R1 的判语——照旧脚本跑一次 = 往**在役** desktop profile 注入
// 无法解析的 `link:` 依赖 + bundles 行，`pnpm install` 失败、profile 半改态（地雷）。
// 钉三件：① 退役包名 `@defws/dsh-phone-native` 作为**身份字面**不许回来；② 脚本声明的包名
// 必须等于本仓 `package.json name`（两处各写各的时候，脚本就变成了「装另一个东西」——
// 这正是原地雷的成因）；③ 写之前的源树体检（缺件拒写）与「备份先于改动」仍在，
// 因为地雷的正解不是改名，是「不合格一个字节都不写」。
// ⚠️ 口径：钉的是**包名** `@defws/dsh-phone-native`，不是 `phone-native` 这个子串——脚本头注
// 故意留了一句「它曾指向 `F:/defws/dsh-phone-native`，该目录已不存在」当事故说明。那是历史，
// 不是回归；把它读成回归再去删注释，就把事故的唯一痕迹抹掉了。
test('③ install-to-profile 只可能装现役包，且不合格拒写', () => {
  const src = read(join('tools', 'install-to-profile.mjs'))
  assert.doesNotMatch(src, /@defws\/dsh-phone-native/, '退役包名不得再作为身份出现在脚本里')
  const declared = /const PACKAGE_NAME = '([^']+)'/.exec(src)?.[1]
  assert.equal(declared, pkg.name, '脚本里的包名必须等于 package.json name（一致性钉，不是现值钉）')
  const link = /const LINK_PATH = '([^']+)'/.exec(src)?.[1]
  assert.match(link ?? '', /^link:/, 'link 声明必须仍是 link: 形态（junction 桥接是本仓的装机方式）')
  assert.match(link ?? '', /\/dsh-pocket$/, 'link 目标必须是本仓目录名；只钉到目录名，不钉盘符（换机器不恒红）')
  assert.match(src, /REQUIRED_SOURCE_FILES/, '源树 preflight（缺件即拒写）是这颗地雷的正解，删它=复雷')
  assert.match(src, /--no-backup is not supported/, '备份是回滚路径，不许提供「不备份」的出口')
  assert.match(src, /const withInstall = argv\.includes\('--install'\)/, "pnpm install 必须保持显式 opt-in：登记了却没装成就是半改态")
})

// ④（tasks.md AC-R 第④条）
// 钉的是哪句语义：README「测试与工具」节里**不再有**「闭环测试」这一承诺。原根级
// `test-closed-loop.mjs` 的三条断言都与现码相反（`Max-Age=31536000` vs 现值 30 天、
// 「必须把连接密码打到日志」vs bridge 域禁令「日志不落 PIN」、打的还是已退役的 `/phone*`
// 路由族），而它 import 的目录已不存在 ⇒ 它连跑都跑不起来。不可复验的承诺比没承诺更危险：
// 它会让人以为闭环已经验过。删文件 + 同步 README 是同一笔动作，这里钉后半句。
test('④ 退役的闭环脚本没有尸体，也没有残留承诺', () => {
  assert.equal(existsSync(join(root, 'test-closed-loop.mjs')), false, '根级闭环脚本必须不在')
  assert.doesNotMatch(read('README.md'), /closed-loop/i, 'README 不得再承诺闭环测试')
})

// ⑤（tasks.md AC-R 第⑤条）
// 钉的是哪句语义：README 节标题「形态：插件，不是独立进程」及其正文那句「**没有 main 守卫**
// ⇒ `node lib/index.js` 不是运行方式，装载只由宿主完成」。原 README 写「独立桥进程
// （`node lib/index.js`，插件内无构建）」⇒ 照它运维得到的是「命令静默什么都不发生」，
// 并且把「改 `lib/**` 必须重启 DeepSeek Harness」这个关键前提整个藏掉了。
// 负向 + 正向成对钉：只删错话不写对话，措辞下一轮就会漂回去。
test('⑤ README 不再卖「独立桥进程」，且正向说法在位', () => {
  const readme = read('README.md')
  assert.doesNotMatch(readme, /独立桥进程/, '「独立桥进程」是本卡 R6 明确改掉的事实错误')
  assert.match(readme, /不是独立进程/, '与上一句成对：对话必须留在文档里')
  assert.match(readme, /重启/, '「改源码/新增 bundle 须重启宿主」这句前提不许被顺手删掉')
})

// ⑥（tasks.md AC-R 第⑥条）
// 钉的是哪句语义：工作区约定「归档一律进 `_archive/<项目名>/`，不散落根目录」+ R10 的动作
// 是**迁出**插件仓而非删档。它原来躺在宿主 `link:` 的目标目录里 ⇒ 死码位于可加载树内，
// 宿主重启就可能把它当插件内容读。这里钉的是边界「插件仓内不放归档」，不是那四个文件名。
test('⑥ 插件仓内不放归档（死码不得躺在可加载树里）', () => {
  assert.equal(existsSync(join(root, '_archive')), false, '插件仓顶层不应再有 _archive 目录')
  assert.equal(existsSync(join(root, '_archive', 'pre-pocket-20260929')), false, '旧归档目录必须已迁出')
  assert.doesNotMatch(read('README.md'), /pre-pocket-20260929/, '文档也不得再指回仓内旧归档路径')
})

// ⑥b — 迁入点在工作区归档仓，那是**另一棵树**的时点事实：link 装机件在没有工作区布局的机器
// 上会恒红。按 planner 的裁定做成 env-gated、缺省 skip（skip 是有意的，不是漏写）。
test('⑥b 归档在工作区 _archive/dsh-pocket/ 下确实落地（需显式给路径）', (t) => {
  const target = process.env.POCKET_ARCHIVE_RELOCATION?.trim()
  if (!target) {
    t.skip('需要 POCKET_ARCHIVE_RELOCATION 指到工作区归档目录（F:\\defws\\_archive\\dsh-pocket）才验')
    return
  }
  for (const rel of ['lib/http.js', 'lib/invoke.js', 'lib/pairing.js', 'tools/render-preview.mjs']) {
    assert(existsSync(join(target, 'pre-pocket-20260929', rel)), `迁出后的归档件 ${rel} 应在新址`)
  }
})

// ⑦ — `package.json description`（WP-REPO-B 唯一被允许改动的字段）
// 钉的是哪句语义：本仓的实际形态（README 形态节 + `dsh.bundle.patch` 装载链）。旧值
// 「Independent lightweight bridge」在 npm 页与宿主插件列表里会被读成「独立进程的桥」，
// 而 README 已经用整节压住这个误读；「phone-native」是退役身份（AGENTS.md 硬约束 1/6：
// `dsh-phone-native` 目录已不存在，pocket 由它更名演进）。钉的是**类别词**（plugin）与两个
// 会撒谎的字面，不钉整句措辞——句子可以润色，撒谎不许。
test('⑦ 包描述自述为插件，不暗示独立服务，不带退役身份', () => {
  assert.match(pkg.description, /\bplugin\b/i, '元数据必须把这东西说成插件')
  assert.doesNotMatch(pkg.description, /independent/i, '旧措辞的「Independent」= 独立进程暗示，与 README 形态节相反')
  assert.doesNotMatch(pkg.description, /standalone/i, '同上：不许换皮回「可单独起」')
  assert.doesNotMatch(pkg.description, /phone-native/i, '退役包身份不得回到元数据')
  assert.doesNotMatch(pkg.description, /\bnode lib\/index\.js\b/, '描述里不许出现「运行方式」——它不是这么跑的')
})

// ⑧（前棒 handoff 建议的可选第⑦条，本包落成第⑧条）
// 钉的是哪句语义：README「隧道」节那句「它写出的文件名就是解析链要查的
// `vendor/cloudflared(.exe)`（不是发布件原名），版本与摘要都从 `lib/tunnel.js` 里读，
// 不自己另抄一份」。旧状态是**写侧与读侧永不相交**：工具写 `cloudflared-windows-amd64.exe`
// （GitHub 发布件原名），`resolveCloudflared()` 只查 `<plugin root>/vendor/cloudflared(.exe)`
// ⇒ 下载成功、隧道照旧回落 PATH，而脚本尾语承诺「lib/tunnel.js will pick this up from
// vendor/ automatically」为假；同时脚本默认 `'latest'` 且不校 sha256 ⇒ 它产出的二进制绕过
// 运行时钉版与校验。这一条是「工具跑成功但永远不被取用」这类漂移的唯一防线。
test('⑧ fetch-cloudflared 与 tunnel.js 的 vendor 契约同源（--print 不联网、不落盘）', (t) => {
  const tunnelSrc = read('lib/tunnel.js')
  const toolSrc = read(join('tools', 'fetch-cloudflared.mjs'))

  // (a) 文件名：两侧必须是同一对平台字面量，且落在同一个目录。
  const NAME_TERNARY = /process\.platform === 'win32' \? '([^']+)'\s*:\s*'([^']+)'/
  const inTool = toolSrc.match(NAME_TERNARY)
  const inTunnel = tunnelSrc.match(NAME_TERNARY)
  assert(inTool && inTunnel, '任一侧不再用「win32 三元挑文件名」这个形状时，改两侧并保住本条，别删断言')
  assert.deepEqual(
    [inTool[1], inTool[2]],
    [inTunnel[1], inTunnel[2]],
    '工具写出的文件名必须就是 resolveCloudflared() 探测的文件名（永不相交就是原事故）',
  )
  assert.match(tunnelSrc, /\.\.\/vendor\/\$\{exe\}/, '解析链的 vendor 档 = <plugin root>/vendor/（lib/ -> ../vendor）')
  assert.match(toolSrc, /path\.join\(\s*pluginRoot,\s*'vendor'\s*\)/, '工具写的必须是同一个 vendor/ 目录')

  // (b) 单一真源：工具里不许另抄版本或摘要。
  assert.doesNotMatch(toolSrc, /'2026\.8\.2'|c29eee/, '工具自己抄一份 pin/摘要 = 把下一次漂移排进日程；它现在读 lib/tunnel.js')
  assert.doesNotMatch(toolSrc, /CLOUDFLARED_VERSION \|\| 'latest'/, "默认版本回到 'latest' 就等于产出运行时不肯收的二进制")

  // (c) 运行时侧的契约字面（本机平台那一项）。
  const pin = /const CLOUDFLARED_VERSION = '([^']+)'/.exec(tunnelSrc)?.[1]
  assert(pin, 'lib/tunnel.js 不再声明这个 const 时：此处与工具的 readPinnedContract() 一起随动')
  const key = `${process.platform}-${process.arch}`
  const table = /const ASSETS = \{([\s\S]*?)\n\}/.exec(tunnelSrc)?.[1] ?? ''
  const entry = new RegExp(`'${key}':\\s*\\{([^}]*)\\}`).exec(table)
  if (entry === null) {
    t.skip(`lib/tunnel.js 的 ASSETS 未钉 ${key}，本条只在钉了本平台时验`)
    return
  }
  const assetFile = /file:\s*'([^']+)'/.exec(entry[1])?.[1]
  const assetSha = /sha256:\s*'([0-9a-f]+)'/.exec(entry[1])?.[1]
  assert(assetFile && assetSha, `ASSETS['${key}'] 必须同时给出 file 与 sha256`)

  // (d) 跑 `--print`：printOnly 分支只打印契约。显式清掉 CLOUDFLARED_VERSION 覆盖，
  // 因为这条钉的是「默认取的就是运行时 pin」。
  const env = { ...process.env }
  delete env.CLOUDFLARED_VERSION
  const vendorBefore = existsSync(join(root, 'vendor'))
  const run = spawnSync(process.execPath, [join(root, 'tools', 'fetch-cloudflared.mjs'), '--print'], {
    cwd: root,
    encoding: 'utf8',
    env,
  })
  assert.equal(existsSync(join(root, 'vendor')), vendorBefore, '--print 不许建目录或落件（它只报契约）')
  const out = run.stdout ?? ''
  const pinMatch = /runtime pin\s*: (\S+) \(([^)]+)\)/.exec(out)
  const printedPin = pinMatch?.[1]
  const printedAsset = pinMatch?.[2]
  const printedSha = /expected sha\s*: ([0-9a-f]+)/.exec(out)?.[1]
  const printedTarget = /vendor target:\s*(.+)$/m.exec(out)?.[1]?.trim()
  assert(printedPin && printedAsset && printedSha && printedTarget, `--print 的输出形状变了，解析跟着改：\n${out}`)
  assert.equal(printedPin, pin, '打印的 pin 必须等于 lib/tunnel.js 的 CLOUDFLARED_VERSION')
  assert.equal(printedAsset, assetFile, '取件用的发布件原名必须等于 ASSETS 里本平台那一项')
  assert.equal(printedSha, assetSha, '打印并用于校验的摘要必须来自 ASSETS，不另存一份')
  assert.equal(
    basename(printedTarget),
    process.platform === 'win32' ? inTunnel[1] : inTunnel[2],
    'vendor 目标文件名必须就是解析链探测的那个名字',
  )
  if (/\.tgz$/.test(assetFile)) {
    // macOS 的发布件是 .tgz，与「vendor/ 只当裸可执行件探测」冲突：README 已写明这条走
    // 运行时懒下载。工具在打印完契约之后 fail-loud，是**设计如此**，不是本条的红。
    assert.match(run.stderr ?? '', /is an archive/, 'darwin 应当指名道姓地拒绝 .tgz 进 vendor，而不是默默放个解包件')
  } else {
    assert.equal(run.status, 0, `--print 应零退出：${run.stderr?.trim()}`)
  }
})

// ⑨（ship 随发布，2026-10-03 起）
// 钉的是哪句语义：README「打包与许可」的版本策略句。0.1.0 那会儿它写的是「本仓**不维护
// CHANGELOG**（变更账在 git log 与 flow change 卡里）」——那是一句**事实陈述**，不是愿望清单；
// 既然 0.2.0 起建了 CHANGELOG，就必须同时把那句改成指向它，否则 README 就在撒谎（本卡纪律：
// 删掉一句错话必须配一句对话，见 ⑤ 的负正成对）。
// 仍然**不钉**：版本号的数值（提位是发布决策，钉住现值等于替那个决策投票）、任何条目的正文。
test('⑨ CHANGELOG.md 在场、最新一节跟着 version 走，且 README 不再声称不维护它', () => {
  const changelogPath = join(root, 'CHANGELOG.md')
  assert(existsSync(changelogPath), 'CHANGELOG.md 必须在仓里（README「打包与许可」正在承诺它）')
  assert(pkg.files.includes('CHANGELOG.md'), 'package.json files 必须把 CHANGELOG.md 收进去（README 已列它）')
  const changelog = read('CHANGELOG.md')
  const headings = [...changelog.matchAll(/^##\s+(\S+)/gm)].map((m) => m[1])
  assert(headings.length >= 2, `CHANGELOG 至少要有「本版」与「上一版」两节，实际：${headings.join(', ')}`)
  assert.equal(
    headings[0],
    pkg.version,
    `CHANGELOG 最新一节必须就是当前 package.json version（${pkg.version}），实际最新是 ${headings[0]}`,
  )
  const readme = read('README.md')
  assert.match(readme, /CHANGELOG\.md/, 'README 必须指向 CHANGELOG.md')
  assert.doesNotMatch(readme, /不维护\s*CHANGELOG/i, 'README 不得再声称本仓不维护 CHANGELOG —— 它现在维护')
})
