// 预载与预读的作用域（任务卡 2026-10-29 §3 B2/B3/B4，用户原话「最大加载会话数量」）。
//
// 冷启动预载的作用域规则：**全页置顶的全部，加上全页最新的 10 个，去重**。
// 这条规则只管「提前读哪几个」，不管屏幕上显示几行——显示侧仍是「置顶 + 24 小时
// 窗口内」，一行都不许动（B0 守卫在 test/landing-attention.test.js 与
// test/list-bounds.test.js 里）。
//
// 旧行为坏在排序与截断的组合：
//   · 冷启动文档：先按「置顶优先」排序，再 slice(0,10)——置顶超过 10 个时，
//     多出来的置顶被自己「优先」的位置挤掉了；
//   · Bot 页预读：直接取名单里的前 6 个，置顶与「刚用过的会话」都可能落在外面。
// 两个都是「该提前读的没读到」，用户点进去还是要等。
//
// 2026-11-03（本单 Task 7）：BOT 页整页取消，页面侧的 previewQueue / PREVIEW_BOTS /
// PREVIEW_ROOMS 随旧 BOT 页模块退场。原 B3/B4 那四条钉的是「BOT 页客户端预热队列」
// 这一具体机制；它的**作用域不变量**（置顶全部 ∪ 最新 10、去重、隐藏会话不预载）
// 在统一后的落地页由冷启动桥侧预载承担，也就是本文件保留的 B2 三条
// （buildMobileBoot → collectSessionTails 喂给 session.tails 的 id 清单）。
// 落地页的 fillTail/requestVisibleTails 只管「已渲染行」的尾巴内容形态（末条文本/裁剪/
// 打包缓存，见 test/landing-tails.test.js），不是同一条「取前 N 个」的作用域规则，
// 故不重复钉，也不新建用例——B2 即 previewQueue 退场后的等价落点。
import test from 'node:test'
import assert from 'node:assert/strict'
import { LanMobileBridge } from '../lib/bridge.js'

const DAY = 24 * 60 * 60 * 1000
const row = (sessionId, updatedAt) => ({ sessionId, updatedAt, blank: false })

function makeBridge({ items, pinnedSessionIds = [], workspaces = null, hiddenId = null, hiddenSessions = null }) {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = []
  bridge.log = () => {}
  bridge.locale = () => 'zh'
  bridge.now = () => Date.now()
  bridge.pendingQuestions = new Map()
  bridge.noteSavings = () => {}
  bridge.workspaceSnapshot = {
    items: workspaces ?? [{ workspaceId: 'w1', title: 'DSH', path: 'F:/x', sessionIds: items.map((item) => item.sessionId) }],
    pinnedSessionIds,
  }
  bridge.cachedSettings = async () => ({ ok: true, value: {} })
  bridge.cachedSessionList = async () => ({ ok: true, value: { items } })
  bridge.mobileAssetBodies = () => ({ urls: {} })
  // 预载集合就是喂给 session.tails 的 id 清单，记下来比读 tails 的键更直接。
  bridge.tailRequests = null
  bridge.collectSessionTails = async (ids) => {
    bridge.tailRequests = ids.slice()
    const tails = {}
    for (const id of ids) tails[id] = { updatedAt: 1, events: [] }
    return tails
  }
  bridge.refreshBotWorkspaceId = async () => hiddenId
  bridge.botWorkspaceHiddenSessions = async () => hiddenSessions
  return bridge
}

test('B2 冷启动预载＝置顶全部 ∪ 最新 10：12 个置顶不会被十个名额截掉', async () => {
  const now = Date.now()
  const items = []
  const pinned = []
  for (let i = 0; i < 12; i += 1) {
    const id = `pin${i}`
    items.push(row(id, now - 10 * DAY - i * 1000))
    pinned.push(id)
  }
  for (let i = 0; i < 20; i += 1) items.push(row(`fresh${i}`, now - (i + 1) * 1000))
  const bridge = makeBridge({ items, pinnedSessionIds: pinned })
  await bridge.buildMobileBoot()

  const ids = bridge.tailRequests
  assert.equal(ids.length, 22, '12 个置顶 + 最新 10 个最新，各算各的')
  assert.equal(new Set(ids).size, 22, '并集去重，同一个会话只读一次')
  for (const id of pinned) assert.ok(ids.includes(id), `${id} 是置顶，不管多久都必须预载`)
  assert.equal(ids.includes('fresh0'), true, '最新的一条在预载里')
  assert.equal(ids.includes('fresh10'), false, '第 11 条新的不进预载——十个是定值，不随会话数增长')
})

test('B2 没有置顶时就是按时间倒序的最新 10 条', async () => {
  const now = Date.now()
  const items = []
  for (let i = 0; i < 20; i += 1) items.push(row(`s${i}`, now - ((i * 7) % 20) * 1000))
  const bridge = makeBridge({ items })
  await bridge.buildMobileBoot()

  const expected = items
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 10)
    .map((item) => item.sessionId)
  assert.deepEqual(bridge.tailRequests, expected, '进来的顺序是乱序的，取的是时间序前 10')
})

test('B2 隐藏工作区的会话不进预载：过滤排在预载之前', async () => {
  const now = Date.now()
  const items = [row('hiddenSess', now - 1000), row('a', now - 2000), row('b', now - 3000)]
  const bridge = makeBridge({
    items,
    pinnedSessionIds: ['hiddenSess'],
    workspaces: [
      { workspaceId: 'w1', title: 'DSH', path: 'F:/x', sessionIds: ['a', 'b'] },
      { workspaceId: 'wbot', title: 'BOT', path: 'F:/y', sessionIds: ['hiddenSess'] },
    ],
    hiddenId: 'wbot',
    hiddenSessions: new Set(['hiddenSess']),
  })
  await bridge.buildMobileBoot()

  assert.equal(bridge.tailRequests.includes('hiddenSess'), false, '藏起来的会话既不显示也不预载，即使被置顶')
  assert.deepEqual(bridge.tailRequests, ['a', 'b'])
})
