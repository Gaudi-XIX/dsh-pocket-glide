/**
 * 数一数 %TEMP% 里 pocket 测试留下的临时目录 —— 跑全量前后各来一次，差值就是漏。
 *
 * 为什么值得常设：测试在 Windows 上删不掉临时目录是**静默**的（`force: true` 吞掉
 * ENOENT 之后，EBUSY/EPERM 会以异常形式炸在 finally 里，把已经通过的断言带红，
 * 或者干脆被某个 `catch` 吃掉只留目录）。这条漏了整整一段时间没人发现，直到
 * %TEMP% 积到上千个 `dsh-pocket-mailbag-settings-*`。
 *
 * 用法：
 *   node tools/temp-leak-check.mjs          # 列出当前存量 + 按前缀归组
 *   node tools/temp-leak-check.mjs --recent # 只看最近 10 分钟创建的（跑完一轮全量后看）
 *
 * 判据：跑全量前后各跑一次（不带 --recent），两个总数应当相等。不等就是漏了，
 * 差出来的前缀直接指向漏的那个 test 文件。
 *
 * 只读：不删任何东西。清存量请自己确认后手删 —— 这个工具不替你做删除决定。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PREFIX = 'dsh-pocket-'
const recentOnly = process.argv.includes('--recent')
const windowMs = 10 * 60 * 1000
const cut = Date.now() - windowMs

const rows = []
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith(PREFIX)) continue
  const full = join(tmpdir(), name)
  let mtime = 0
  try {
    mtime = statSync(full).mtimeMs
  } catch {
    // 正好被别的进程删了：不算漏。
    continue
  }
  if (recentOnly && mtime < cut) continue
  rows.push({ name, mtime })
}

rows.sort((a, b) => a.mtime - b.mtime)

// 前缀 = 名字去掉结尾 6 位随机串。归组是为了让「差出来的那 7 个」直接指向一个 test 文件。
const byPrefix = new Map()
for (const row of rows) {
  const m = /^(.*?)-[A-Za-z0-9]{6}$/.exec(row.name)
  const key = m ? m[1] : row.name
  byPrefix.set(key, (byPrefix.get(key) ?? 0) + 1)
}

console.log(recentOnly
  ? `pocket temp dirs created in the last ${windowMs / 60000} min: ${rows.length}`
  : `pocket temp dirs currently in %TEMP%: ${rows.length}`)
for (const [prefix, count] of [...byPrefix].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${prefix}-*`)
}
if (rows.length > 0 && rows.length <= 40) {
  console.log('--- oldest first ---')
  for (const row of rows) console.log(`  ${new Date(row.mtime).toISOString()}  ${row.name}`)
}
