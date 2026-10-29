// 预载与预读的作用域（任务卡 2026-10-29 §3 B2/B3/B4，用户原话「最大加载会话数量」）。
//
// 两处「提前读」共用一条规则：**全页置顶的全部，加上全页最新的 10 个，去重**。
// 这条规则只管「提前读哪几个」，不管屏幕上显示几行——显示侧仍是「置顶 + 24 小时
// 窗口内」，一行都不许动（B0 守卫在 test/landing-attention.test.js 与
// test/list-bounds.test.js 里）。
//
// 旧行为坏在排序与截断的组合：
//   · 冷启动文档：先按「置顶优先」排序，再 slice(0,10)——置顶超过 10 个时，
//     多出来的置顶被自己「优先」的位置挤掉了；
//   · Bot 页预读：直接取名单里的前 6 个，置顶与「刚用过的会话」都可能落在外面。
// 两个都是「该提前读的没读到」，用户点进去还是要等。
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { LanMobileBridge } from '../lib/bridge.js'
import { BOT_PAGE_JS } from '../lib/bot-page.js'

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

// ---- Bot 页预读（B3/B4）----------------------------------------------------
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the rendered page script`)
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  assert.fail(`unbalanced braces after ${name}`)
}

const PREVIEW_BOTS = Number((BOT_PAGE_JS.match(/var PREVIEW_BOTS = (\d+)/) || [])[1])
const PREVIEW_ROOMS = Number((BOT_PAGE_JS.match(/var PREVIEW_ROOMS = (\d+)/) || [])[1])
// 惰性求值：先红取证要在改动前的页面上跑这一组，那时 previewQueue 还不存在——顶层
// 就抛错会把前面 B2 那三条一起吞掉，红的证据就分不清是哪一条在承重了。
const previewQueue = (team, previews) =>
  Array.from(
    vm.runInNewContext(`(${extractFunction(BOT_PAGE_JS, 'previewQueue')})`, {
      PREVIEW_BOTS,
      PREVIEW_ROOMS,
    })(team, previews)
  )

test('B3 Bot 页预读＝置顶全部 ∪ 最新 10，不再是名单里的前六个', () => {
  assert.equal(PREVIEW_BOTS, 10, '十个是定值')
  const bots = []
  for (let i = 0; i < 12; i += 1) bots.push({ sessionId: `p${i}`, pinned: true, updatedAt: 1000 + i })
  for (let i = 0; i < 20; i += 1) bots.push({ sessionId: `n${i}`, pinned: false, updatedAt: 5000 + i })
  const queue = previewQueue({ bots }, {})

  assert.equal(queue.length, 22, '12 个置顶 + 最新 10')
  for (let i = 0; i < 12; i += 1) assert.ok(queue.includes(`p${i}`), `p${i} 被置顶，必须预读`)
  assert.equal(queue[0], 'p11', '置顶按时间倒序排在最前')
  assert.ok(queue.includes('n19'), '最新的一条也被预读')
  assert.equal(queue.includes('n9'), false, '第 11 条新的不预读')
})

test('B3 二十条乱序 updatedAt、零置顶：队列就是倒序前十个', () => {
  const bots = []
  for (let i = 0; i < 20; i += 1) bots.push({ sessionId: `b${i}`, pinned: false, updatedAt: (i * 13) % 20 })
  const expected = bots
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 10)
    .map((bot) => bot.sessionId)
  assert.deepEqual(previewQueue({ bots }, {}), expected)
})

test('B3 已知缓存的会话不再重复预读', () => {
  const bots = [{ sessionId: 'a', pinned: true, updatedAt: 5 }, { sessionId: 'b', pinned: false, updatedAt: 4 }]
  assert.deepEqual(previewQueue({ bots }, { a: { rows: [] } }), ['b'])
})

test('B4 rooms 不进时间序，也不挤占 Bot 的十个名额', () => {
  const bots = Array.from({ length: 20 }, (_, i) => ({ sessionId: `n${i}`, pinned: false, updatedAt: 1000 + i }))
  const rooms = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}` }))
  const queue = previewQueue({ bots, rooms }, {})

  assert.equal(queue.length, 10 + 6, 'Bot 十个 + 群聊自己的六个')
  assert.deepEqual(queue.slice(0, 10), bots.slice(-10).reverse().map((bot) => bot.sessionId))
  assert.deepEqual(queue.slice(10), rooms.slice(0, 6).map((room) => room.id), '群聊按名单顺序，不参与时间排序')
})
