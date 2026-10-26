// 宿主 token 守卫 —— 退化版：只钉「别名还在不在」，不钉值。
// ① 为什么退化：宿主 token 表不可机读（桌面件是归档格式、换机器路径就断、仓内无 @deepseek-ai 依赖、桥也拿不到），
//    所以比对源是 2026-10-23 从宿主安装包实采的**别名快照**，不是活表；不伪造一个「像活表」的比对源。
// ② 代价：宿主删掉某个别名时本仓测不出来（快照里还留着），只有真机渲染才发现；不校验别名的值；快照随宿主版本漂移需人工复采。
// ③ 复采：跑下面两条命令（PowerShell 7 或 bash 均可，`*.asar` 会展开成宿主 resources 下那个唯一的归档），
//    把用到的别名贴回快照并改采集日期。
//
// 采集命令（2026-10-23 实采）：
//   grep -a -o -- '--dsw-alias-[a-z0-9-]*' D:/DSH/resources/*.asar | sort -u
//   grep -a -o -- '--dsw-focus-ring-[a-z-]*' D:/DSH/resources/*.asar | sort -u
//
// 为什么快照放常量而不是读宿主：CI 没有宿主安装目录，测试一旦读它必挂。所以本文件**不出现
// 宿主安装包的归档文件名**（机械核法：对该文件名做 grep，计数必须为 0）；路径只在上面注释里以
// 采集命令的形式出现，供人手工复采，不被任何断言读取。
//
// 方向两条（双向才不是只查新增）：
//   * 客户端半边新增一个宿主别名 → 快照里没有 → 红（说明有人开始用没登记的东西）。
//   * 快照里删掉一个客户端在用的别名 → 红（模拟宿主删别名，见「红态自证」）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 2026-10-23 实采，采集命令见文件头（改这条常量前先按命令复采一次）。 */
const SNAPSHOT = [
  '--dsw-alias-label-tertiary',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-state-business-primary',
  '--dsw-focus-ring-color',
  '--dsw-focus-ring-width',
]

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8')
const PAGES_SRC = readFileSync(fileURLToPath(new URL('../lib/pages.js', import.meta.url)), 'utf8')

/** 客户端半边用到的宿主别名（`var(--dsw-*)`；嵌套 fallback 里的也会被抽到）。 */
function usedHostTokens(source) {
  return [...source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1])
}

const USED = usedHostTokens(CLIENT_SRC)
const UNIQUE_USED = [...new Set(USED)].sort()

// ---------------------------------------------------------------- 正向
// AC2.1：客户端半边（2026-10-24 时在 client/client.js:104、:106、:107、:108 四行）用到的
// 每一个宿主别名都必须在快照里。逐个别断言，红的时候直接看得出是哪个名字。
for (const token of UNIQUE_USED) {
  test(`客户端用到的宿主别名 ${token} 在快照里（宿主没有它就没有这个颜色）`, () => {
    assert.ok(SNAPSHOT.includes(token), `${token} 不在 2026-10-23 的宿主别名快照里`)
  })
}

test('客户端用到的宿主别名正好是快照里那五个（多了少了都红）', () => {
  // 空集合会让上面那个 for 循环一条断言都不生成 —— 静默变绿是最坏的绿，先钉住非空。
  assert.ok(UNIQUE_USED.length >= 5, `客户端应该用到 5 个宿主别名，实际只抽到 ${UNIQUE_USED.length} 个：${UNIQUE_USED.join(', ')}`)
  assert.deepEqual(UNIQUE_USED, [...SNAPSHOT].sort(), '客户端用到的别名集合与快照不一致')
  assert.equal(new Set(SNAPSHOT).size, SNAPSHOT.length, '快照里有重复项')
})

// ---------------------------------------------------------------- 反向（房规）
// AC2.3：壳自己的页面只用自有 palette，宿主变量只许出现在桌面注入件（client/）里。
// 与 test/turn-footer-meta.test.js 的「no invented theme variable」同向，只是从单条规则
// 抬到整份页面：lib/pages.js 里一个 --dsw- / --dsh- 都不许有。
test('lib/pages.js 不含任何宿主主题变量（壳只用自有 palette）', () => {
  const hits = [...PAGES_SRC.matchAll(/--(?:dsw|dsh)-[a-z0-9-]+/g)].map((match) => match[0])
  assert.deepEqual([...new Set(hits)], [], `lib/pages.js 出现了宿主变量：${[...new Set(hits)].join(', ')}`)
  assert.ok(PAGES_SRC.includes('--muted'), 'lib/pages.js 读不到页面 palette（路径或文件变了会静默放过上面那条）')
})
