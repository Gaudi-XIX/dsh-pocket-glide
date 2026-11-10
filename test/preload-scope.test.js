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
import {
  bootPreloadIds,
  renderMobileReconnectPage,
  renderPairingPinPage,
  unclaimedSessionIds,
} from '../lib/pages.js'

const DAY = 24 * 60 * 60 * 1000
const row = (sessionId, updatedAt) => ({ sessionId, updatedAt, blank: false })
// 镜像 lib/bridge.js 的 TAILS_MAX_SESSIONS：覆盖集合截到 30，超了桥侧判截断、消息格留白。
const TAILS_MAX_SESSIONS = 30

// 2026-11-09（M1）：buildMobileBoot 有两条会话集合，别混为一谈。
//   · 预载集合 bootTailIds＝bootPreloadIds(cap 10 + 置顶全收)，管首屏画多少条尾巴；
//   · 覆盖集合 tailIds＝预载集合逐字在前，再补 landing 可见行，截到 30，喂 session.tails；
//     消息格数的就是它，少发一个就少算一个。
// collectSessionTails 的入参是后者。预载规则只有一份实现（页桥共用 bootPreloadIds），
// 所以按同一份输入复算，逐字比对覆盖集合的前缀即可——不必在生产代码里留测试观察点。
function landingPreloadIds(bridge, items, now, { pinnedIds = [], hiddenIds = [] } = {}) {
  const landing = bridge.landingSummary(items, bridge.workspaceSnapshot, now)
  return bootPreloadIds({
    rows: landing.rows,
    pinnedIds,
    zones: landing.zones,
    ungroupedIds: landing.ungrouped,
    hiddenIds,
    now,
    windowMs: DAY,
    cap: 10,
  })
}

function assertCoverOfPreload(coverIds, preloadIds, prefixMessage = '覆盖集合以预载集合逐字开头：桥侧不许另换一份预载排序') {
  assert.ok(Array.isArray(coverIds), 'session.tails 确实收到了覆盖集合')
  assert.deepEqual(coverIds.slice(0, preloadIds.length), preloadIds, prefixMessage)
  assert.ok(coverIds.length <= TAILS_MAX_SESSIONS,
    `覆盖集合不超过 ${TAILS_MAX_SESSIONS}，超了桥侧判截断、消息格留白`)
  assert.equal(new Set(coverIds).size, coverIds.length, '覆盖集合也不重复请求')
}

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

  const coverIds = bridge.tailRequests
  const preloadIds = landingPreloadIds(bridge, items, now, { pinnedIds: pinned })
  assert.equal(preloadIds.length, 22, '12 个置顶 + 最新 10 个最新，各算各的')
  assert.equal(new Set(preloadIds).size, 22, '并集去重，同一个会话只读一次')
  for (const id of pinned) assert.ok(preloadIds.includes(id), `${id} 是置顶，不管多久都必须预载`)
  assert.equal(preloadIds.includes('fresh0'), true, '最新的一条在预载里')
  assert.equal(preloadIds.includes('fresh10'), false, '第 11 条新的不进预载——十个是定值，不随会话数增长')
  assertCoverOfPreload(coverIds, preloadIds)
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
  const preloadIds = landingPreloadIds(bridge, items, now)
  assert.deepEqual(preloadIds, expected, '预载集合逐字就是时间序前 10：进来的顺序是乱序的，取的是时间序前 10')
  assertCoverOfPreload(bridge.tailRequests, preloadIds,
    '覆盖集合以时间序前 10 的预载集合逐字开头：桥侧不许另换一份预载排序')
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

  const preloadIds = landingPreloadIds(bridge, items, now, {
    pinnedIds: ['hiddenSess'],
    hiddenIds: new Set(['hiddenSess']),
  })
  assert.equal(preloadIds.includes('hiddenSess'), false, '预载集合按 hiddenIds 排除隐藏会话')
  assertCoverOfPreload(bridge.tailRequests, preloadIds,
    '覆盖集合以预载集合逐字开头，隐藏会话两条腿都不进')
  assert.equal(bridge.tailRequests.includes('hiddenSess'), false,
    '藏起来的会话既不显示、不预载，也不进覆盖集合（M1：覆盖循环自己再挡一道）')
  assert.deepEqual(bridge.tailRequests, ['a', 'b'])
})

// ---------------------------------------------------------------------------
// T6 单测 1：窗与置顶的并集
// ---------------------------------------------------------------------------

const ZONES_EMPTY = { main: [], other: [], room: [] }

test('单测 1：置顶免窗全收，窗外未置顶一个不进，窗内未置顶按 updatedAt 倒序补满 cap', () => {
  const now = 5_000 * DAY
  const rows = [
    row('stale-1', now - 3 * DAY),
    row('stale-2', now - 3 * DAY - 1000),
    row('stale-3', now - 3 * DAY - 2000),
    row('pin-old-1', now - 30 * DAY),
    row('pin-old-2', now - 40 * DAY),
    row('fresh-1', now - 1000),
    row('fresh-2', now - 3000),
    row('fresh-3', now - 2000),
  ]
  const ids = bootPreloadIds({
    rows,
    pinnedIds: ['pin-old-1', 'pin-old-2'],
    zones: ZONES_EMPTY,
    ungroupedIds: [],
    hiddenIds: [],
    now,
    cap: 3,
  })
  assert.deepEqual(ids.slice(0, 2), ['pin-old-1', 'pin-old-2'],
    '置顶不看时间：40 天前的那条照样预读，且排在前面（按 updatedAt 倒序就是 pin-old-1 在前）')
  assert.deepEqual(ids.slice(2), ['fresh-1', 'fresh-3', 'fresh-2'], '窗内未置顶按 updatedAt 倒序，cap 只数这一段')
  for (const id of ['stale-1', 'stale-2', 'stale-3']) {
    assert.equal(ids.includes(id), false, `${id} 在 24 小时窗口外又不是置顶，不进预读集合`)
  }
})

test('单测 1：只有 lastMessageAt 落在窗内的行不算——窗只认 updatedAt', () => {
  const now = 5_000 * DAY
  const old = row('lm-only', now - 10 * DAY)
  old.lastMessageAt = now - 1000
  const ids = bootPreloadIds({
    rows: [old, row('fresh', now - 1000)],
    pinnedIds: [],
    zones: ZONES_EMPTY,
    ungroupedIds: [],
    hiddenIds: [],
    now,
    cap: 10,
  })
  assert.deepEqual(ids, ['fresh'],
    'lastMessageAt 更精确，但判据 2 的窗只读 updatedAt：拿它当窗会让「多久算新」出现第二个口径')
})

// ---------------------------------------------------------------------------
// T6 单测 2：三区次序与上限
// ---------------------------------------------------------------------------

test('单测 2：三区按 窗内主 Bot → 窗内群 → 其他按 updatedAt 倒序，合计不超过 cap', () => {
  const now = 5_000 * DAY
  const rows = [
    row('main-in', now - 1000),
    row('main-out', now - 3 * DAY),
    row('room-in', now - 2000),
    row('room-out', now - 4 * DAY),
    row('other-a', now - 500),
    row('other-b', now - 700),
    row('other-c', now - 900),
    row('other-d', now - 1100),
    row('other-e', now - 1300),
    row('other-f', now - 1500),
  ]
  const ids = bootPreloadIds({
    rows,
    pinnedIds: [],
    zones: {
      main: ['main-in', 'main-out'],
      room: ['room-in', 'room-out'],
      other: ['other-f', 'other-c', 'other-a', 'other-e', 'other-b', 'other-d'],
    },
    ungroupedIds: [],
    hiddenIds: [],
    now,
    cap: 10,
  })
  assert.deepEqual(ids, ['main-in', 'room-in', 'other-a', 'other-b', 'other-c', 'other-d', 'other-e', 'other-f'],
    '三区段自己排序：主 Bot 全部在前，群其次，其他按 updatedAt 倒序；窗外的主 Bot 与群都被窗挡掉')
  assert.equal(ids.includes('main-out'), false, '三区也不吃置顶、不吃例外：窗外就是窗外')
  assert.equal(ids.includes('room-out'), false, '群同理')
})

test('单测 2：三区合计遇 cap 截断，主 Bot 超额时截到 cap', () => {
  const now = 5_000 * DAY
  const rows = []
  const main = []
  for (let i = 0; i < 12; i += 1) {
    rows.push(row(`m${i}`, now - (i + 1) * 1000))
    main.push(`m${i}`)
  }
  rows.push(row('room-1', now - 100))
  const ids = bootPreloadIds({
    rows,
    pinnedIds: [],
    zones: { main, room: ['room-1'], other: [] },
    ungroupedIds: [],
    hiddenIds: [],
    now,
    cap: 10,
  })
  assert.equal(ids.length, 10, '三区合计的上限是 cap，不是每区各给 cap')
  assert.deepEqual(ids, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'],
    '主 Bot 先吃满名额，群排在它后面因此一个都进不来——次序就是优先级')
  assert.equal(ids.includes('room-1'), false, '满额后按次序截断，不是按区分摊')
})

test('单测 2：三区段不吃置顶——窗外未置顶的照样进不来，置顶行只由工作区段收一次', () => {
  const now = 5_000 * DAY
  const rows = [
    row('old-pinned', now - 5 * DAY),
    row('fresh-other', now - 1000),
    row('stale-other', now - 3 * DAY),
  ]
  const ids = bootPreloadIds({
    rows,
    pinnedIds: ['old-pinned'],
    zones: { main: [], room: [], other: ['old-pinned', 'fresh-other', 'stale-other'] },
    ungroupedIds: [],
    hiddenIds: [],
    now,
    cap: 10,
  })
  assert.deepEqual(ids, ['old-pinned', 'fresh-other'],
    '置顶那条由工作区段收进来（免窗），窗外的 stale-other 仍在三区段里被窗挡掉——三区没有置顶概念')
  assert.equal(ids.filter((id) => id === 'old-pinned').length, 1, '跨段去重：同一个会话只预读一次')
})

// ---------------------------------------------------------------------------
// T6 单测 3：未分组不进预读、不进首帧行集，但仍在后台可点开
// ---------------------------------------------------------------------------

// 测试意图取代：原钉 2026-11-02 判据④「未分组恢复显示」下「显示腿与预读腿读同一份行集」，
// 被本轮 m00110「未分组默认全部隐藏、主页不留一行」取代（intent.md:63 / §5:85）。
test('单测 3：未分组的行不进预读集合、不进首帧行集，但仍在后台数据里可点开', () => {
  const now = Date.now()
  const items = [row('s-1', now - 1000), row('s-loose', now - 500)]
  const bridge = makeBridge({
    items,
    workspaces: [{ workspaceId: 'w1', title: 'DSH', path: 'F:/x', sessionIds: ['s-1'] }],
  })
  const landing = bridge.landingSummary(items, bridge.workspaceSnapshot, now)
  const ids = bootPreloadIds({
    rows: landing.rows,
    pinnedIds: [],
    zones: landing.zones,
    ungroupedIds: landing.ungrouped,
    hiddenIds: [],
    now,
    cap: 10,
  })
  assert.deepEqual(Array.from(landing.ungrouped), ['s-loose'], '没有工作区认领它，就是未分组')
  assert.equal(ids.includes('s-loose'), false, '未分组的行不进预读集合（判据 2 的资格三条之一）')
  assert.equal(landing.rows.some((r) => r.sessionId === 's-loose'), false,
    'm00110 判据④/intent.md:58：未分组行不进首帧行集，主页不留一行')
  assert.deepEqual(
    landing.byCard.filter((card) => card.key === '').flatMap((card) => card.ids),
    ['s-loose'],
    'intent.md:59：未分组 id 仍在 byCard key:\'\' 后台数据里，点进会话仍可打开',
  )
})

// ---------------------------------------------------------------------------
// T6 单测 6：桥页同源
// ---------------------------------------------------------------------------

test('单测 6：桥侧真正发出的 id 清单与同一输入下 bootPreloadIds 的返回值逐字相同', async () => {
  const now = Date.now()
  const items = []
  const pinned = []
  for (let i = 0; i < 3; i += 1) {
    items.push(row(`pin${i}`, now - (20 + i) * DAY))
    pinned.push(`pin${i}`)
  }
  for (let i = 0; i < 15; i += 1) items.push(row(`f${i}`, now - (i + 1) * 1000))
  const hiddenSessions = new Set(['f-3'])
  const workspaces = [{ workspaceId: 'w1', title: 'DSH', path: 'F:/x', sessionIds: items.map((i) => i.sessionId) }]
  const bridge = makeBridge({
    items,
    pinnedSessionIds: pinned,
    workspaces,
    hiddenSessions,
  })
  bridge.options = { harnessUrl: () => 'http://127.0.0.1:1' }
  await bridge.buildMobileBoot()

  const landing = bridge.landingSummary(items, bridge.workspaceSnapshot, bridge.now())
  const expected = bootPreloadIds({
    rows: landing.rows,
    pinnedIds: pinned,
    zones: landing.zones,
    ungroupedIds: landing.ungrouped,
    hiddenIds: hiddenSessions,
    now: bridge.now(),
    windowMs: 24 * 60 * 60 * 1000,
    cap: 10,
  })
  assertCoverOfPreload(bridge.tailRequests, expected,
    '桥侧不许另有一份排序：覆盖集合必须以共用纯函数的返回值逐字开头')
  assert.equal(bridge.tailRequests.includes('f-3'), false, '隐藏会话两头都排除')
})

test('单测 6：引导页脚本里调用的是同一个注入函数，没有第二份排序', () => {
  // 页侧注入点 `lib/pages.js:3687` 就是 `const bootPreloadIds=${bootPreloadIds.toString()};`
  // ⇒ 逐字对拍：注入进文档的那一行必须与导出函数本体的 `.toString()` 逐字相等。
  // 只断言前缀（`const bootPreloadIds=`）会被「注入了另一个同名函数」蒙混过去，
  // 这是本单判据 §2 甲「预读选择只有一份实现」在页侧唯一能机械钉住的那一条。
  const injected = `const bootPreloadIds=${bootPreloadIds.toString()};`
  for (const html of [
    renderMobileReconnectPage({ locale: 'zh' }),
    renderPairingPinPage({ locale: 'zh' }),
  ]) {
    assert.ok(html.includes(injected), '共用脚本注入的就是这个函数本身（toString），且逐字相等')
    assert.ok(html.includes('bootPreloadIds({'), '页侧算集合只经它一次')
  }
  const reconnect = renderMobileReconnectPage({ locale: 'zh' })
  assert.equal(/newestFirst|preloadOrder|tailCandidates/.test(reconnect), false,
    '页侧不许留旧的排序痕迹')
  assert.equal(/slice\(0,\s*BOOT_TAIL_PRELOAD\)/.test(reconnect), false,
    '也不许再做「先排序再截断」（那正是 12 个置顶被挤掉的老毛病）')
})

// ---------------------------------------------------------------------------
// T6 单测 6b：页侧屏障（三趟读都落地才算，bot.team 被拒也不挂死）
// ---------------------------------------------------------------------------

const BARRIER_AT = 'const afterStageReads='
const BARRIER_END = 'return bgTailsPromise};'

/** 从出货页脚本里切出屏障那一段原样代码——测的是页面真身，不是复述一遍。 */
function barrierSource() {
  const html = renderMobileReconnectPage({ locale: 'zh' })
  const at = html.indexOf(BARRIER_AT)
  const end = html.indexOf(BARRIER_END)
  assert.ok(at > 0 && end > at, '出货页里必须能找到屏障段')
  return html.slice(at, end + BARRIER_END.length)
}

/** 页侧覆盖上限取自出货页真身，不凭空喂魔数；并钉死与桥侧同口径（M1/R3）。 */
function pageCoverMax() {
  const html = renderMobileReconnectPage({ locale: 'zh' })
  const match = /const TAIL_COVER_MAX=(\d+);/.exec(html)
  assert.ok(match, '出货页里必须声明 TAIL_COVER_MAX')
  assert.equal(Number(match[1]), TAILS_MAX_SESSIONS,
    '页侧覆盖上限必须与桥侧 TAILS_MAX_SESSIONS 同口径：消息格数的是整份可见行集')
  return Number(match[1])
}

/** 用切出来的真源码造一个 bgTails，变量全部由外面喂（模拟页面里的同名状态）。 */
function makeBgTails({ rpc, stageDone, stageItems, stageWorkspaces = [], stagePinnedSessionIds = [], stageZones, stageHiddenIds = new Set(), stageArchivedIds = [] }) {
  const make = new Function(
    'bootPreloadIds',
    'unclaimedSessionIds',
    'BOOT_TAIL_PRELOAD',
    'TAIL_COVER_MAX',
    'rpc',
    'stageDone',
    'stageItems',
    'stageWorkspaces',
    'stagePinnedSessionIds',
    'stageZones',
    'stageHiddenIds',
    'stageArchivedIds',
    `${barrierSource()}; return bgTails;`,
  )
  return make(
    bootPreloadIds,
    unclaimedSessionIds,
    10,
    pageCoverMax(),
    rpc,
    stageDone,
    stageItems,
    stageWorkspaces,
    stagePinnedSessionIds,
    stageZones,
    stageHiddenIds,
    stageArchivedIds,
  )
}

test('单测 6b：三趟读没落地就一个 session.tails 都不发，落地后发的就是同一份集合', async () => {
  const calls = []
  const stageDone = { ws: false, sess: false, team: false }
  const rpc = (method, payload) => {
    calls.push({ method, payload })
    return Promise.resolve({ ok: true })
  }
  const bgTails = makeBgTails({
    rpc,
    stageDone,
    stageItems: [row('s-1', Date.now() - 1000)],
    stageWorkspaces: [{ workspaceId: 'w1', sessionIds: ['s-1'] }],
    stageZones: { main: [], room: [], other: [] },
  })

  const pending = bgTails()
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(calls.filter((c) => c.method === 'session.tails').length, 0,
    '还没落地完毕：此刻发出去的清单会是按空三区算的，与桥侧不同（判据 8 的同一份输入就不成立）')

  stageDone.ws = true
  stageDone.sess = true
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(calls.filter((c) => c.method === 'session.tails').length, 0,
    '只差 bot.team 也不算落地：三区 id 只有它给得出')

  stageDone.team = true
  const result = await pending
  const sent = calls.filter((c) => c.method === 'session.tails')
  assert.equal(sent.length, 1, '三趟读落地后发一次，且只发一次')
  assert.deepEqual(sent[0].payload.sessions, ['s-1'], '发出去的 id 清单就是刚才那份输入下的纯函数返回值')
  assert.deepEqual(result, { ok: true }, '腿的返回值原样交回给 /api/boot 那条腿')
})

test('单测 6b：bot.team 被拒时 bgTails() 仍然 settle（不许把整页挂死）', async () => {
  const stageDone = { ws: false, sess: false, team: false }
  // 页面 rpc 的 finally 就是这么开门的：这一趟回来了（成功或失败）就算「读过了」。
  const botTeamProbe = () =>
    Promise.reject(new Error('rpc bot.team -> 403')).finally(() => {
      stageDone.team = true
    })
  const calls = []
  const rpc = (method) => {
    calls.push(method)
    return Promise.resolve({ ok: true })
  }
  const bgTails = makeBgTails({
    rpc,
    stageDone,
    stageItems: [row('s-1', Date.now() - 1000)],
    stageWorkspaces: [{ workspaceId: 'w1', sessionIds: ['s-1'] }],
    stageZones: { main: [], room: [], other: [] },
  })
  stageDone.ws = true
  stageDone.sess = true
  await assert.rejects(botTeamProbe(), /403/, '这一趟确实是拒绝')
  assert.equal(stageDone.team, true, '拒绝也把第三道门打开了（rpc 的 finally）')

  let settled = false
  const pending = bgTails().then((value) => {
    settled = true
    return value
  })
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(settled, true, '被拒的 bot.team 不许把 /api/boot 那条腿吊死')
  assert.deepEqual(await pending, { ok: true }, '集合照发，不因一次被拒整页失败')
  assert.deepEqual(calls, ['session.tails'], '而且只发了尾巴这一趟')
})

test('单测 6b：session.tails 自己失败时 bgTails() 也 resolve（尾巴腿不许拖垮整页）', async () => {
  const stageDone = { ws: true, sess: true, team: true }
  const rpc = () => Promise.reject(new Error('rpc session.tails -> 502'))
  const bgTails = makeBgTails({
    rpc,
    stageDone,
    stageItems: [row('s-1', Date.now() - 1000)],
    stageWorkspaces: [{ workspaceId: 'w1', sessionIds: ['s-1'] }],
    stageZones: { main: [], room: [], other: [] },
  })
  assert.equal(await bgTails(), null, '尾巴读失败退化成「没有尾包」，/api/boot 照常返回')
})
