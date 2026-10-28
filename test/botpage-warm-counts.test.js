// BOT 页过渡卡「读取工作区」恒 0（2026-10-28）。
//
// 用户报的是「第 0 格永远是 0」。运行时取证把根因钉死在这里：`session/list` 的行
// 根本不带工作区字段（实抓 boot 里 1079 行，带 string `workspaceId` 的 **0** 行），
// 所以从前那个「按行去重 workspaceId」的 Set 恒空——数出来的自然是 0，而不是没数。
//
// 真值在同页另一份快照里：`workspace/follow` 的 baseline（boot 已经把它给到手机），
// 形状 `{ items: [{ workspaceId, path, title, sessionIds[] }] }`。于是判据只有一条：
// 一个工作区「读到了」＝ 它的 `sessionIds` 与这一次的行有交集。
//
// 这一档钉四件事：①按快照交集数，不按行上的字段数（变异回去必红）；②Bot 团队那个
// 工作区永不计入（它在主页上是要藏起来的）；③快照没到就报冷摘要，不编一个像真的 0；
// ④形状不对的条目跳过而不是抛。
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

test('the landing summary counts workspaces off the workspace snapshot, not off the session rows', () => {
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
  assert.equal(summary.rows, 2, 'the row count is still what the list will paint')
  assert.equal(summary.workspaces, 2,
    'w-a and w-b hold rows that were read; w-c holds none of them, so it was not read either')
})

test('a workspace the rows never mention is not counted, whatever the snapshot holds', () => {
  const bridge = makeBridge({
    rows: rowsOf(['s-1']),
    items: [
      { workspaceId: 'w-a', sessionIds: ['s-1'] },
      { workspaceId: 'w-b', sessionIds: [] },
      { workspaceId: 'w-c', path: 'F:\\defws', title: 'no sessions field' },
    ],
  })
  assert.equal(bridge.pageWarmSummary('landing').workspaces, 1,
    'empty or missing sessionIds cannot vouch for a workspace')
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
  const summary = bridge.pageWarmSummary('landing')
  assert.deepEqual(summary, { ready: true, rows: 1, bots: 0, rooms: 0 })
  assert.equal('workspaces' in summary, false, 'the field is absent, so the card leaves that cell alone')
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
  assert.deepEqual(summary, { ready: true, rows: 1, bots: 0, rooms: 0 })
  assert.equal('workspaces' in summary, false)
})

test('malformed workspace entries are skipped, never thrown on', () => {
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
  assert.equal(bridge.pageWarmSummary('landing').workspaces, 1, 'only the well-formed workspace with a matching row counts')
})

test('an empty landing says ready with nothing read, rather than lying about either', () => {
  const bridge = makeBridge({ rows: [], items: [{ workspaceId: 'w-a', sessionIds: ['s-1'] }] })
  assert.deepEqual(bridge.pageWarmSummary('landing'), { ready: true, rows: 0, workspaces: 0, bots: 0, rooms: 0 },
    'no rows read means no workspace was read either')
})
