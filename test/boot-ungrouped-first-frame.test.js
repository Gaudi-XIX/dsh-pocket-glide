// 「手机 Pocket 首屏行数虚高（未分组卡那一支）」的数据面回归。
//
// 判据 §2 的 V2 判定串把「未归属」定义成：既不在 B.ws.items 的任何
// sessionIds 里，也不在 BOT 三卡的 DOM 行里。桥侧原先只把 paintRows 算出的
// 未分组桶 ids 放进 landing.rows，却没有对应的 ws.items 项，于是那 15 行在
// 数据面上永远 neither。这里把修法钉在数据面：buildMobileBoot 必须把未分组桶
// 作为 workspaceId '' 的项交给页面。
//
// 页面侧首帧展开由 applyBootData 的
//   for(const w of workspaces)expandedWsIds.add(String(w.workspaceId??''))
// 覆盖（lib/pages.js:2590）。DOM 逐帧复验归设计(Pixel) 真机复测，本文件不冒充。
import test from 'node:test'
import assert from 'node:assert/strict'
import { LanMobileBridge } from '../lib/bridge.js'

const row = (sessionId, updatedAt) => ({ sessionId, updatedAt, blank: false })

function makeBridge({ items, workspaceItems, locale = 'zh', hiddenId = null }) {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = []
  bridge.log = () => {}
  bridge.locale = () => locale
  bridge.now = () => Date.now()
  bridge.pendingQuestions = new Map()
  bridge.noteSavings = () => {}
  bridge.workspaceSnapshot = { items: workspaceItems, pinnedSessionIds: [] }
  bridge.cachedSettings = async () => ({ ok: true, value: {} })
  bridge.cachedSessionList = async () => ({ ok: true, value: { items } })
  bridge.mobileAssetBodies = () => ({ urls: {} })
  bridge.refreshBotWorkspaceId = async () => hiddenId
  return bridge
}

const WORKSPACE_ITEMS = [
  { workspaceId: 'w1', title: 'one', path: 'F:\\one', sessionIds: ['w1a', 'w1b'] },
  { workspaceId: 'w2', title: 'two', path: 'F:\\two', sessionIds: ['w2a'] },
]
const CLAIMED = ['w1a', 'w1b', 'w2a']
const ORPHANS = ['o1', 'o2', 'o3', 'o4']

async function boot(options = {}) {
  const {
    ids = [...CLAIMED, ...ORPHANS],
    locale = 'zh',
    hiddenId = null,
    workspaceItems = WORKSPACE_ITEMS,
    ...buildOptions
  } = options
  const now = Date.now()
  const bridge = makeBridge({
    items: ids.map((id) => row(id, now - 1000)),
    workspaceItems,
    locale,
    hiddenId,
  })
  return bridge.buildMobileBoot(buildOptions)
}

// 判据 §2 判定串的数据面半边：inWs 取自 ws.items，bot 卡是 DOM 项；本夹具
// team 为 null（没有 BOT 卡），所以 neither = 不在 inWs 的行数。
function dataFace(b) {
  const ids = b.sess.items.map((item) => item.sessionId)
  const inWs = new Set()
  for (const item of b.ws.items) for (const id of item.sessionIds || []) inWs.add(id)
  return {
    ids,
    inWs,
    neither: ids.filter((id) => !inWs.has(id)),
    ungroupedItem: b.ws.items.find((item) => String(item.workspaceId ?? '') === ''),
  }
}

test('未分组桶的 ids 作为 workspaceId "" 的项交给页面，首帧行集不再 neither', async () => {
  const b = await boot()
  const face = dataFace(b)

  assert.equal(face.ids.length, 7, '夹具：3 行在工作区卡 + 4 行两边都不在')
  assert.deepEqual(face.neither, [], '判据 §2 V2：每一行都在 B.ws.items 里')
  assert.ok(face.ungroupedItem, '判据 §4 V6：首帧有 data-ws="" 这一张卡')
  assert.deepEqual([...face.ungroupedItem.sessionIds].sort(), [...ORPHANS].sort(),
    '这张卡认领的正是那 4 条未归属行')
  assert.equal(face.ungroupedItem.sessionTotal, ORPHANS.length,
    '卡上数字等于首屏真画出的量')
  assert.equal(face.ungroupedItem.sessionIds.length, ORPHANS.length,
    '不许出现卡在但一行没有、要等后台补的形态')
})

test('V1 数据面：行数、sess.items、stageSummary.sessions 同源', async () => {
  const b = await boot()
  assert.equal(b.stageSummary.sessions, b.sess.items.length)
  assert.equal(b.sess.items.length, 7)
  assert.equal(
    b.ws.items.filter((item) => String(item.workspaceId ?? '') !== '').length,
    2,
    '未分组卡不是工作区卡：真实工作区仍是两张，多出来的那张单独算',
  )
})

test('壳形状（tails: false）同样把未分组桶交给页面', async () => {
  const b = await boot({ tails: false })
  const face = dataFace(b)
  assert.deepEqual(face.neither, [])
  assert.ok(face.ungroupedItem)
  assert.deepEqual([...face.ungroupedItem.sessionIds].sort(), [...ORPHANS].sort())
  assert.equal(b.stageSummary.sessions, b.sess.items.length)
})

test('en 语种用 Ungrouped 标题', async () => {
  const b = await boot({ locale: 'en' })
  assert.equal(dataFace(b).ungroupedItem.title, 'Ungrouped')
})

test('没有未归属行时不补空卡', async () => {
  const b = await boot({ ids: CLAIMED })
  assert.equal(dataFace(b).ungroupedItem, undefined)
  assert.deepEqual(dataFace(b).neither, [])
})

test('隐藏工作区成员未解析（hiddenSessionIds 在场且为空）时不补未分组卡', async () => {
  const b = await boot({ hiddenId: 'hidden-ws' })
  assert.deepEqual(b.ws.hiddenSessionIds, [], 'fail-closed 档的信号仍在')
  assert.equal(dataFace(b).ungroupedItem, undefined,
    '页面 ungroupedCards() 在这一档早退，补进来的项会整张画出，绕过 Truth-Guard 2026-10-28 的判定')
})
