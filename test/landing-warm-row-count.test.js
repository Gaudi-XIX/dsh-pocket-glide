// BOT→Pocket 过渡卡「读取会话列表」的数（用户 2026-10-30 第 8 条：
// 「bot切换到pocket的时候,会话数量显示有误」）。
//
// 用户看到的那个数来自 `pageWarmSummary('landing').rows`（BOT 侧 `lib/bot-page.js` 的
// `printCounts` 把它写进卡片第 1 格）。修之前它读的是 `_sessionListValue` 里那份**未过滤的
// 原件**——Host `session/list` 的全量行（本机注释自认 469 行 / ~195 KB 量级），而主页真正画
// 出来的只有其中「本工作区 + 置顶或 24 小时内」的那几十行。两侧不同源，量级差一个数量级。
//
// 现在的口径（判据 2，落点固定在 `pageWarmSummary` 的 landing 分支）：与 boot 交给页面的那份
// 同一套现成过滤——`withoutWorkspaceRows` + `bootVisibleRows`，调用侧先剔掉页面永不画的两类行
// （隐藏工作区的成员、`origin === 'subagent'` 的行）。两个公共函数本体一个分支都没加（第 7 条
// 用例拿 e46e979 的原文对比钉死）；也没有偏移量、没有 clamp（第 6 条用例）。
//
// 已知残差（页面独有逻辑，桥侧没有对应实现，复制就等于「另写一份过滤」，故不闭合）：页面
// `mergeBotParts` 按 Bot 名折叠同一 Bot 的多个 part（lib/pages.js:1927）、`blankRowVisible`
// 对陈旧空白行的过滤（lib/pages.js:2355）、排序优先读 localStorage 的 `lastMessageAt`
// （lib/pages.js:2265）。这三项决定「A === B」在两侧都只走判据 2 那两函数时到不了 ±0。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LanMobileBridge } from '../lib/bridge.js'
import { preFixBaseline } from './helpers/pre-fix-baseline.mjs'

const DAY_MS = 86_400_000
// 固定时钟：24 小时窗口的边界必须是确定值，不能跟着跑测试的时刻漂。
const NOW = 1_764_000_000_000
const RECENT = NOW - 60_000
const OLD = NOW - 10 * DAY_MS

const rowOf = (sessionId, at = NOW, extra = {}) => ({ sessionId, updatedAt: at, ...extra })

function makeBridge({ rows = [], items = [], pinnedSessionIds, hidden = 'w-bot', now = NOW } = {}) {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.log = () => {}
  bridge.now = () => now
  bridge._sessionListValue = { at: now, result: { ok: true, value: { items: rows } } }
  bridge.workspaceSnapshot = pinnedSessionIds ? { items, pinnedSessionIds } : { items }
  if (hidden !== null) bridge.botWorkspaceCache = { at: now, id: hidden }
  return bridge
}

test('the card reports the rows the landing will paint, not the raw list it was read from', () => {
  // 一个工作区，6 个会话：2 个在 24 小时内、4 个是十天前的。主页默认视图只画那 2 个
  // （`bootRangeCap` = 置顶 + 24 小时，地板 1 行），修之前卡片读的是原件的 6。
  const rows = [
    rowOf('s-1', OLD), rowOf('s-2', OLD), rowOf('s-3', OLD), rowOf('s-4', OLD),
    rowOf('s-5', RECENT), rowOf('s-6', RECENT - 1_000),
  ]
  const bridge = makeBridge({
    rows,
    items: [{ workspaceId: 'w-a', sessionIds: ['s-1', 's-2', 's-3', 's-4', 's-5', 's-6'] }],
  })
  const summary = bridge.pageWarmSummary('landing')
  assert.equal(summary.ready, true)
  assert.equal(summary.rows, 2, '2 rows are inside the 24h window; the other 4 are not painted by default')
  assert.notEqual(summary.rows, rows.length, 'the raw list length (6) is exactly the number the user saw as wrong')
  assert.equal(summary.workspaces, 1)
})

test('the count is the same read three times in a row', () => {
  // 判据 3 的桥侧那一半：同一个数字连采 3 次必须相等（±0）。这里的读法是纯函数式的——
  // 摘要只读缓存，不因为多读一次而变化。
  const bridge = makeBridge({
    rows: [rowOf('s-1', RECENT), rowOf('s-2', OLD)],
    items: [{ workspaceId: 'w-a', sessionIds: ['s-1', 's-2'] }],
  })
  const three = [1, 2, 3].map(() => bridge.pageWarmSummary('landing').rows)
  assert.deepEqual(three, [1, 1, 1], 'one of the two rows is inside 24h, and that does not drift')
})

test('sessions of the hidden Bot-team workspace are never part of the number', () => {
  // 那个工作区在主页上是要藏起来的（用户 2026-10-24）：boot 把它的条目从快照里摘走，它的行
  // 就变成「没有卡认领」的孤儿行——而孤儿行 `bootVisibleRows` 是故意保留的。不在这里剔掉，
  // 过渡卡就会把用户关掉的那扇门里的会话数报回来。
  const bridge = makeBridge({
    rows: [rowOf('s-bot', RECENT), rowOf('s-1', RECENT)],
    items: [
      { workspaceId: 'w-bot', sessionIds: ['s-bot'] },
      { workspaceId: 'w-a', sessionIds: ['s-1'] },
    ],
    hidden: 'w-bot',
  })
  assert.equal(bridge.pageWarmSummary('landing').rows, 1, 'only the row the landing can paint is counted')
})

test('subagent rows are not counted, even in a workspace that holds nothing else', () => {
  // 页面第一步就把 subagent 行滤掉了（lib/pages.js:1883 `visibleSessions`）——它们不占卡片
  // 任何一行。w-c 只装了这样一行，修之前它会被当成「该工作区读了 1 行」报出去。
  const bridge = makeBridge({
    rows: [rowOf('s-1', RECENT), rowOf('s-sub', RECENT, { origin: 'subagent' })],
    items: [
      { workspaceId: 'w-a', sessionIds: ['s-1'] },
      { workspaceId: 'w-c', sessionIds: ['s-sub'] },
    ],
  })
  assert.equal(bridge.pageWarmSummary('landing').rows, 1)
})

test('a pinned row survives the window and an unclaimed row is kept, as on the page', () => {
  // 置顶行不论多旧都在视图里（`bootRangeCap` 的 p 项）；没有工作区认领的行是页面「未分组」
  // 那一桶（`ungroupedCards`），也是有行画的。两者都在数里。
  const bridge = makeBridge({
    rows: [rowOf('s-pin', OLD), rowOf('s-old', OLD), rowOf('s-orp', OLD)],
    items: [{ workspaceId: 'w-a', sessionIds: ['s-pin', 's-old'] }],
    pinnedSessionIds: ['s-pin'],
  })
  assert.equal(bridge.pageWarmSummary('landing').rows, 2,
    'the pinned row plus the unclaimed row; the old unpinned row is behind the window edge')
})

test('a few hundred live rows are reported in full, not truncated to a round number', () => {
  // 判据 4：不许「减一个偏移量」也不许 clamp 到一个好看的上限。全部落在窗口内的行，一行不少。
  const sessionIds = Array.from({ length: 250 }, (_, i) => `s-${i}`)
  const bridge = makeBridge({
    rows: sessionIds.map((id, i) => rowOf(id, RECENT - i)),
    items: [{ workspaceId: 'w-a', sessionIds }],
  })
  const summary = bridge.pageWarmSummary('landing')
  assert.equal(summary.rows, 250)
  assert.notEqual(summary.rows, 200, '200 would be a ceiling, and there is none')
})

test('the landing branch is wired to the shared filters, and the shared filters are untouched', () => {
  // 结构钉（判据 2 的硬约束：口径必须落在那两个公共函数的调用侧，公共函数本体不加分支）：
  // ①落点体内确实调用 `withoutWorkspaceRows` 与 `bootVisibleRows`；②没有任何 `rows: rows.length`
  // 式的原件读数残留；③没有偏移量／钳位补丁；④两个公共函数的正文与基提交 e46e979 逐字节相同。
  const source = readFileSync(fileURLToPath(new URL('../lib/bridge.js', import.meta.url)), 'utf8')
  const start = source.indexOf('  pageWarmSummary(page) {')
  assert.notEqual(start, -1, 'pageWarmSummary is where this batch says it is')
  const end = source.indexOf('\n  async warmPage(', start)
  assert.notEqual(end, -1, 'the landing branch ends where warmPage begins')
  const body = source.slice(start, end)
  assert.ok(body.includes('withoutWorkspaceRows(rows, hidden)'), 'the shared row filter is called, not re-implemented')
  assert.ok(body.includes('bootVisibleRows(shownRows'), 'the shared visibility window is called')
  assert.doesNotMatch(body, /rows:\s*rows\.length/, 'the raw list length is no longer a reading')
  assert.doesNotMatch(body, /rows\.length\s*-/, 'no offset is subtracted')
  assert.doesNotMatch(body, /Math\.min\(\s*200/, 'no ceiling is clamped in')

  const baseline = preFixBaseline('e46e979', 'lib/bridge.js')
  if (!baseline) {
    // 读不到基线 ≠ 基线成立（test/helpers/pre-fix-baseline.mjs:11-14）：记未取证，不回退读工作树。
    return
  }
  const bodyOf = (text, signature) => {
    const at = text.indexOf(signature)
    assert.notEqual(at, -1, `${signature} is present`)
    const close = text.indexOf('\n}\n', at)
    assert.notEqual(close, -1, `${signature} closes at column 0`)
    return text.slice(at, close + 2)
  }
  assert.equal(
    bodyOf(source, 'function bootVisibleRows(rows, wsSnapshot, now) {'),
    bodyOf(baseline, 'function bootVisibleRows(rows, wsSnapshot, now) {'),
    'bootVisibleRows is shared with the landing: this batch may not add a branch to it'
  )
  assert.equal(
    bodyOf(source, 'function withoutWorkspaceRows(rows, workspaceId) {'),
    bodyOf(baseline, 'function withoutWorkspaceRows(rows, workspaceId) {'),
    'withoutWorkspaceRows is shared with the landing: this batch may not add a branch to it'
  )
})
