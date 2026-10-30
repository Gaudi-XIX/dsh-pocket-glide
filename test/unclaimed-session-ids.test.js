// `unclaimedSessionIds` —— 归属的唯一算法（用户 2026-10-30「隐藏就是两个工作区，未分组
// 和DSBOT」之后，「未被任何可见工作区认领」这个集合只用于一件事：判断主页那一行
// 要不要画、以及过渡卡那一格数不数它）。
//
// 纯函数，无 IO；测的是集合算得对不对，两侧（页面 `ungroupedCards` 与桥侧
// `pageWarmSummary`）读的是同一个函数体，所以这里算错就是两侧一起错。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unclaimedSessionIds } from '../lib/pages.js'

const row = (sessionId) => ({ sessionId, updatedAt: 1 })

test('a row no workspace claims is unclaimed, and a claimed one is not', () => {
  const ids = unclaimedSessionIds(
    [row('a'), row('b')],
    [{ workspaceId: 'w1', sessionIds: ['a'] }]
  )
  assert.deepEqual(ids, ['b'])
})

test('hidden and archived rows are excluded: they are excluded from the phone too', () => {
  const ids = unclaimedSessionIds(
    [row('a'), row('hidden'), row('archived')],
    [{ workspaceId: 'w1', sessionIds: ['a'] }],
    ['hidden'],
    ['archived']
  )
  assert.deepEqual(ids, [], 'a hidden workspace member and an archived row are both gone')
})

test('no workspaces at all means every row is unclaimed', () => {
  // The snapshot has not arrived yet: nothing claims anything, so every row would
  // land in the bucket — which is why the page leaves the whole list empty then.
  assert.deepEqual(unclaimedSessionIds([row('a'), row('b')], []), ['a', 'b'])
  assert.deepEqual(unclaimedSessionIds([row('a')], undefined), ['a'])
})

test('malformed input is skipped, never thrown on', () => {
  const ids = unclaimedSessionIds(
    [row('a'), null, { updatedAt: 1 }, { sessionId: 42 }],
    [null, 'nope', { workspaceId: 'w1' }, { workspaceId: 'w2', sessionIds: ['a'] }]
  )
  assert.deepEqual(ids, [], 'a null row, a row without an id and a workspace without members change nothing')
})

test('the order of the rows is preserved: the bucket reads like the list it came from', () => {
  const ids = unclaimedSessionIds(
    [row('a'), row('b'), row('c')],
    [{ workspaceId: 'w1', sessionIds: ['b'] }]
  )
  assert.deepEqual(ids, ['a', 'c'])
})
