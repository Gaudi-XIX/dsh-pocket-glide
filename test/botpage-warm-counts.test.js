// BOT 页过渡卡「读取工作区」恒 0（2026-10-28）。
//
// 用户报的是「第 0 格永远是 0」。运行时取证把根因钉死在这里：`session/list` 的行
// 根本不带工作区字段（实抓 boot 里 1079 行，带 string `workspaceId` 的 **0** 行），
// 所以从前那个「按行去重 workspaceId」的 Set 恒空——数出来的自然是 0，而不是没数。
//
// 真值在同页另一份快照里：`workspace/follow` 的 baseline（boot 已经把它给到手机），
// 形状 `{ items: [{ workspaceId, path, title, sessionIds[] }] }`。判据 v7 §3/§4 把这一格
// 钉成「主页画出来的工作区卡数」：页面 `applyBootData` 把快照 items 逐条铺成 `workspaces`，
// `renderWorkspaces` 一张工作区一张卡（空的也画），所以摘要里的 `workspaces` 就是
// 过滤掉隐藏工作区后的 items 长度——不是「有行的才算」。
//
// 这一档钉五件事：①按快照的卡片数报，不按行上的字段数报（变异回去必红）；②Bot 团队那个
// 工作区永不计入（它在主页上是要藏起来的）；③快照没到、隐藏工作区未知时报 null，不编一个
// 像真的 0；④形状不对的条目照样是一张卡（页面也不筛），而且不许抛；⑤7 键形状固定。
import test from 'node:test'
import assert from 'node:assert/strict'
import { LanMobileBridge } from '../lib/bridge.js'

/** 行就是宿主送来的样子：只有 sessionId 这类顶层小字段，没有 workspaceId。 */
const rowsOf = (sessionIds) => sessionIds.map((sessionId) => ({ sessionId, updatedAt: 1 }))

// `hidden` 默认给一个已解析的 id：真实运行时 roster 在 boot 就把它读出来了，缓存为空是
// 少数窗口。要把「还不知道隐藏工作区是谁」这一档单独钉住，用例里显式传 `hidden: null`。
function makeBridge({ rows = [], items = [], hidden = 'w-bot' } = {}) {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.log = () => {}
  bridge.now = () => Date.now()
  bridge._sessionListValue = { at: Date.now(), result: { ok: true, value: { items: rows } } }
  bridge.workspaceSnapshot = { items }
  if (hidden !== null) bridge.botWorkspaceCache = { at: Date.now(), id: hidden }
  return bridge
}

/** 七键，一个不多一个不少：四张卡只读这同一份形状（criteria v7 §3）。 */
const LANDING_KEYS = ['ready', 'workspaces', 'sessions', 'messages', 'bots', 'botSessions', 'rooms']

test('the landing summary counts the workspace cards the snapshot will paint, not the rows it read', () => {
  const bridge = makeBridge({
    rows: rowsOf(['s-1', 's-2']),
    items: [
      { workspaceId: 'w-a', sessionIds: ['s-1', 's-x'] },
      { workspaceId: 'w-b', sessionIds: ['s-2'] },
      { workspaceId: 'w-c', sessionIds: ['s-y'] },
    ],
  })
  const summary = bridge.pageWarmSummary('landing')
  assert.equal(summary.ready, true)
  assert.deepEqual(Object.keys(summary), LANDING_KEYS, 'one shape for all four cards')
  assert.equal(summary.sessions, 2, 'the row count is still what the list will paint')
  assert.equal(summary.workspaces, 3,
    'w-c holds none of these rows, but the landing still paints one card for it, so the card count is 3')
})

test('a workspace with no rows yet is still a card, so it is still counted', () => {
  const bridge = makeBridge({
    rows: rowsOf(['s-1']),
    items: [
      { workspaceId: 'w-a', sessionIds: ['s-1'] },
      { workspaceId: 'w-b', sessionIds: [] },
      { workspaceId: 'w-c', path: 'F:\\\\defws', title: 'no sessions field' },
    ],
  })
  assert.equal(bridge.pageWarmSummary('landing').workspaces, 3,
    'applyBootData turns every item into a card; an empty card is still a card')
})

test('the Bot team workspace never counts, even when its sessions are among these rows', () => {
  // 主页要把 Bot 团队那个工作区藏起来（用户 2026-10-24）；它的 id 来自 roster 读取，
  // 不是写死的常量。行被 withoutWorkspaceRows 摘掉是常态，这条守的是摘掉之前那一刻。
  const bridge = makeBridge({
    rows: rowsOf(['s-bot', 's-1']),
    items: [
      { workspaceId: 'w-bot', sessionIds: ['s-bot'] },
      { workspaceId: 'w-a', sessionIds: ['s-1'] },
    ],
    hidden: 'w-bot',
  })
  assert.equal(bridge.pageWarmSummary('landing').workspaces, 1, 'the hidden workspace is not one of the numbers')
})

test('a snapshot that has not arrived omits the workspace count instead of inventing a zero', () => {
  const bridge = makeBridge({ rows: rowsOf(['s-1']) })
  delete bridge.workspaceSnapshot
  // 会话行是真的（ready 保持 true，卡片照写会话数），但工作区这一格**一个数字都不发**：
  // 落回 0 会把「没读到」装成「读了 0 个」，正是本次要根治的假读数（Truth-Guard 2026-10-28 08:3x）。
  //
  // 会话数是 0：快照没到 ⇒ 没有任何工作区认领这些行 ⇒ 它们属于「未分组」那一桶，而用户
  // 2026-10-30 已把那张卡从主页退场（「隐藏就是两个工作区，未分组和DSBOT」）⇒ 主页此刻也画
  // 不出这一行。两侧读同一个 `unclaimedSessionIds`，所以这里与页面一致（判据 1 的 A===B）。
  const summary = bridge.pageWarmSummary('landing')
  assert.deepEqual(summary, {
    ready: true,
    workspaces: null,
    sessions: 0,
    messages: null,
    bots: null,
    botSessions: null,
    rooms: null,
  })
})

test('an unresolved Bot workspace id also omits the count, since nothing can be excluded yet', () => {
  // 隐藏工作区是谁还没读到时，快照里的 Bot 团队工作区排除不了——数出来可能多一个。
  // 与快照没到同一条原则：宁可这一格空着，也不发一个可能错的数字。
  const bridge = makeBridge({
    rows: rowsOf(['s-1']),
    items: [{ workspaceId: 'w-a', sessionIds: ['s-1'] }],
    hidden: null,
  })
  const summary = bridge.pageWarmSummary('landing')
  assert.deepEqual(summary, {
    ready: true,
    workspaces: null,
    sessions: 1,
    messages: null,
    bots: null,
    botSessions: null,
    rooms: null,
  })
})

test('malformed snapshot entries become cards too (the page does not filter them), and never throw', () => {
  const bridge = makeBridge({
    rows: rowsOf(['s-1']),
    items: [
      null,
      'nope',
      { workspaceId: 'w-a' },
      { workspaceId: 'w-b', sessionIds: 's-1' },
      { workspaceId: 'w-c', sessionIds: ['s-1'] },
    ],
  })
  let summary
  assert.doesNotThrow(() => {
    summary = bridge.pageWarmSummary('landing')
  }, 'a malformed snapshot is a card count, not an exception')
  assert.equal(summary.workspaces, 5, 'applyBootData spreads every item into a card, so all five are painted')
})

test('an empty landing says ready with nothing read, rather than lying about either', () => {
  const bridge = makeBridge({ rows: [], items: [{ workspaceId: 'w-a', sessionIds: ['s-1'] }] })
  assert.deepEqual(bridge.pageWarmSummary('landing'), {
    ready: true,
    workspaces: 1,
    sessions: 0,
    messages: null,
    bots: null,
    botSessions: null,
    rooms: null,
  }, 'no rows read yet, but the one workspace card is still painted')
})
