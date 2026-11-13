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
import { botStage } from '../lib/pages.js'
import { startBridge, httpFetch } from './helpers.js'

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
      { workspaceId: 'w-c', path: 'F:\\\\workspace', title: 'no sessions field' },
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

// T6 单测 5：BOT 行的数字＝三区实际画出来的行数合计（判据 7）。
//   bots       = 主 Bot 行 + 其他 Bot 行
//   rooms      = 群行
//   botSessions= bots + rooms（卡片只显示这一个数字）
// 三份都从同一份 roster view 现算，页侧 botStage 喂同样的输入必须得同样三张卡。
const ZONE_LABELS = { mainBot: '', otherBots: '', rooms: '', tagMain: '', tagNoModel: '' }

function teamView({ main = [], others = [], rooms = [] } = {}) {
  return {
    mainBotIds: main.map((bot) => bot.id),
    bots: [...main, ...others],
    rooms,
  }
}

test('单测 5：BOT 行的数字＝botStage 三卡 sessionIds 合计，bots+rooms=botSessions', () => {
  const view = teamView({
    main: [{ id: 'b1', sessionId: 's-main' }],
    others: [
      { id: 'b2', sessionId: 's-other-1' },
      { id: 'b3', sessionId: 's-other-2' },
    ],
    rooms: [
      { id: 'r1', sessionId: 's-room-1' },
      { id: 'r2', sessionId: 's-room-2' },
      { id: 'r3', sessionId: 's-room-3' },
    ],
  })
  const bridge = makeBridge({
    rows: rowsOf(['s-main', 's-other-1', 's-other-2', 's-room-1', 's-room-2', 's-room-3']),
    items: [{ workspaceId: 'w-a', sessionIds: ['s-main', 's-other-1', 's-other-2', 's-room-1', 's-room-2', 's-room-3'] }],
  })
  bridge._botTeamValue = { at: Date.now(), view }

  const summary = bridge.pageWarmSummary('landing')
  const cards = botStage(view, [], ZONE_LABELS)
  const ids = Object.fromEntries(['main', 'other', 'room'].map((section) => [
    section,
    cards.find((card) => card.botSection === section)?.sessionIds ?? [],
  ]))

  assert.equal(summary.bots, ids.main.length + ids.other.length, '主 Bot 行 + 其他 Bot 行 = bots')
  assert.equal(summary.rooms, ids.room.length, '群行 = rooms')
  assert.equal(summary.botSessions, summary.bots + summary.rooms, 'botSessions 是那两段之和，不是另数一遍')
  assert.equal(summary.botSessions, ids.main.length + ids.other.length + ids.room.length,
    '与页侧 botStage 同输入同结果：三卡 sessionIds 合计就是一个数字')
  assert.deepEqual(Object.keys(summary), LANDING_KEYS, '七键形状不变，只是后三键有了真值')
})

test('单测 5：没有 BOT 也没有群时三键是 0，不是 null', () => {
  const view = teamView({})
  const bridge = makeBridge({ rows: rowsOf(['s-1']), items: [{ workspaceId: 'w-a', sessionIds: ['s-1'] }] })
  bridge._botTeamValue = { at: Date.now(), view }
  const summary = bridge.pageWarmSummary('landing')
  assert.equal(summary.bots, 0, '读到了 roster、里面确实没有 Bot ⇒ 0 是真读数')
  assert.equal(summary.rooms, 0, '同理')
  assert.equal(summary.botSessions, 0, '两者之和')
})

// ---------------------------------------------------------------------------
// FIX-1（LEAD finding F-3）：shell 形状（`/?revalidate=1`）那趟的七数门
// ---------------------------------------------------------------------------
// `lib/bridge.js:7567-7591` 的 shell 分支自己 `await this.botRoster()`（`:7577`）
// 之后取 `pageWarmSummary('landing')`（`:7578`），再用 `isNum` 逐格校验**七个数**
// （`:7582-7590`），全绿才把 `{ stageSummary }` 写进文档（`:7591`）。
// `pageWarmSummary` 的第一道门是 `lib/bridge.js:8880`
// `if (!held || held.result?.ok !== true) return empty`（`held = this._sessionListValue`），
// `landingSummary` 的 `:8992` 又要求 `hidden !== null`（隐藏工作区已解析）。
// 上面那两档（「单测 5」两例）只调 `pageWarmSummary`，从不经过壳分支那道门——
// 于是「重进那趟三键是不是真数字」此前没有任何机械证据。
//
// 全部断言走 `helpers.startBridge` 起的**真** createServer + 真 `httpFetch`：
// 手工拼 response 或半造桥是假信号（同纪律见 `test/handoff-boot-dedup.test.js:391-407`）。
const ROSTER_MAIN = { id: 'b1', name: '主 Bot', sessionId: 's-main' }
const ROSTER_OTHERS = [
  { id: 'b2', name: '其他一', sessionId: 's-other-1' },
  { id: 'b3', name: '其他二', sessionId: 's-other-2' },
]
const ROSTER_ROOMS = [{ id: 'r1', name: '群一' }, { id: 'r2', name: '群二' }]
const ROSTER_SESSIONS = ['s-main', 's-other-1', 's-other-2', 's-room-1', 's-room-2']
const ROSTER_ROWS = ROSTER_SESSIONS.map((sessionId) => ({ sessionId, updatedAt: Date.now() - 60_000 }))

/** 宿主 `state` 答案的形状＝`lib/bridge.js:1491-1524` 逐键读的那几个。 */
const ROSTER_VALUE = {
  workspaceId: 'w-bot',
  mainBotIds: ['b1'],
  bots: [ROSTER_MAIN, ...ROSTER_OTHERS],
  rooms: ROSTER_ROOMS,
}

/** 文档里那份摘要载荷（没发摘要 ⇒ null）。 */
function embeddedBoot(html) {
  const match = html.match(/window\.__POCKET_BOOT__=([\s\S]*?)<\/script>/)
  return match ? JSON.parse(match[1]) : null
}

test('FIX-1：shell 形状的七数门在三键上给出真数字，roster 取不到时整份不发（fail-closed）', async () => {
  let rosterAnswers = true
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/list' ? { ok: true, value: { items: ROSTER_ROWS } } : undefined,
      botRespond: (endpoint) =>
        endpoint === 'state'
          ? rosterAnswers
            ? { ok: true, value: ROSTER_VALUE }
            : { ok: false, error: 'Host refused that read.', code: 'not-ready' }
          : undefined,
    },
  })
  try {
    t.bridge.workspaceSnapshot = {
      items: [{ workspaceId: 'w-mine', name: 'Mine', paths: [], sessionIds: ROSTER_SESSIONS }],
      pinnedSessionIds: [],
    }
    const cookie = await t.pairMobile()
    // 先走一趟普通文档：`_sessionListValue` 与 `_landingMessages` 都是那一趟落进缓存的
    // （`lib/bridge.js:7782-7783`、`:8092`）。shell 那条门只认这两份 held 值。
    await httpFetch(t.base + '/', { headers: { cookie } })
    assert.equal(t.bridge._sessionListValue?.result?.ok, true, '会话列表已就绪（held 有值）')

    // 把 roster 三处副本全清掉：壳分支那次 `await this.botRoster()`（`:7577`）必须真的发生，
    // 而且它得把 `botWorkspaceCache.id` 一起写回来，否则 `landingSummary` 的 `:8992`
    // 那道 `hidden === null` 会先一步把 `workspaces` 也打成 null。
    t.bridge._botTeamValue = undefined
    t.bridge.botWorkspaceCache = undefined
    t.bridge.botRosterFlight = null

    const shell = await (await httpFetch(t.base + '/?revalidate=1', { headers: { cookie } })).text()
    assert.equal(t.logs.filter((line) => /boot=shell/.test(line.message)).length, 1,
      '这一趟走的确是壳分支（`lib/bridge.js:7568`），不是 embedded／handoff——否则整包也带 stageSummary，本用例就成了空转')
    assert.equal(/"tails":/.test(shell), false, '壳里没有整包（`lib/handoff-boot-dedup.test.js:379` 同一条不变量）')
    const boot = embeddedBoot(shell)
    assert.ok(boot, '七数门全绿 ⇒ shell 必须带一份带行集的载荷（R15-2.2 甲）')
    // 2026-11-05 change：壳必须自带 ws + sess 行集，否则关掉 PWA（sessionStorage 清空）
    // 后重进拿到的又是一份画不出列表的空壳——那正是「重进卡死」的根。tails 仍不下发。
    assert.equal(typeof boot.ws, 'object', '壳里带工作区行集，不是只有摘要')
    assert.equal(typeof boot.sess, 'object', '壳里带会话行集')
    assert.ok(Array.isArray(boot.sess?.items), '会话行集是可画的数组')
    assert.equal(Object.keys(boot).includes('tails'), false, '尾巴包不随壳下发')
    const summary = boot.stageSummary
    assert.ok(summary, '壳里的载荷带的正是 stageSummary')
    assert.deepEqual(Object.keys(summary), LANDING_KEYS, '仍是同一份七键形状')
    const expectedBots = 1 + ROSTER_OTHERS.length
    const expectedRooms = ROSTER_ROOMS.length
    assert.equal(typeof summary.bots, 'number', 'bots 必须是真数字，不是 null')
    assert.equal(typeof summary.botSessions, 'number', 'botSessions 必须是真数字')
    assert.equal(typeof summary.rooms, 'number', 'rooms 必须是真数字')
    assert.equal(summary.bots, expectedBots, '主 Bot 行 + 其他 Bot 行 = 3，与 roster 在册数一致')
    assert.equal(summary.rooms, expectedRooms, '群行 = 2，与 roster 在册数一致')
    assert.equal(summary.botSessions, summary.bots + summary.rooms, '不变量 botSessions === bots + rooms')
    assert.equal(summary.botSessions, expectedBots + expectedRooms, '与 roster 计数一致：3 + 2 = 5')
    assert.equal(summary.ready, true, '七数门要求 ready 为真；同时钉住旧格仍在')

    // 负向：roster 取不到 ⇒ 三键停在 null（这里是 `lib/bridge.js:8987 if (team)` 不成立，
    // 不是 `:8995` 那条「认不出快照」豁免）⇒ `:7582-7590` 的七数门拒绝整份摘要。
    // `botWorkspaceCache` 有意留在上一趟读出来的 `w-bot`：让失败只落在三键上、不牵连
    // `workspaces`，这样「三键缺一个就整份不发」才是被单独钉住的那一条。
    rosterAnswers = false
    t.bridge._botTeamValue = undefined
    t.bridge.botRosterFlight = null
    const shell2 = await (await httpFetch(t.base + '/?revalidate=1', { headers: { cookie } })).text()
    assert.equal(t.logs.filter((line) => /boot=shell/.test(line.message)).length, 2,
      '第二趟也走壳分支——「不发摘要」因此是七数门的裁决，不是走错了分支')
    assert.equal(embeddedBoot(shell2), null,
      'roster 取不到 ⇒ bots/botSessions/rooms 为 null ⇒ 七数门拒绝，摘要整份不发（fail-closed）')
    assert.equal(/window\.__POCKET_BOOT__=/.test(shell2), false, '不发就是真的不在文档里')
  } finally {
    await t.stop()
  }
})
