// The batch lane wired into the bridge (0.4.12). Three things the unit tests
// cannot see, each one the reason the lane exists:
//   1. a busy minute no longer spends the whole quota on one tick — a fleet of
//      settled sessions departs as ONE message (live trace 2026-10-10 09:34:23:
//      13 sends in one second, 12 refused);
//   2. when the server says the quota is gone, news is *held*, not dropped, and
//      the next inbound message releases it — including an inbound whose
//      context_token string is unchanged (the refuel happens on every inbound);
//   3. an arrive-and-answer notice that could not be delivered is retried,
//      because that is the one notice the user cannot afford to miss.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startBridge, httpFetch } from './helpers.js'
import { createSettingsStore } from '../lib/settings-store.js'
import { NOTIFY_BATCH, NOTIFY_JUDGE_THRESHOLDS } from '../lib/bridge.js'

const B = NOTIFY_BATCH
const J = NOTIFY_JUDGE_THRESHOLDS
const BOT = 'bot_token_batch'
const CTX = 'ctx_batch'

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * A clawbot bridge whose whole wire is a recorder. Every stub answer carries
 * both `json()` and `text()` because the iLink client reads sendmessage with
 * `.text()` (the 64-bit id must be taken off the wire, not through JSON.parse)
 * while getupdates/notifystart read `.json()`.
 *
 * @param {{ refuse?: boolean }} [behaviour] refuse ＝ 服务端回 prepare failed
 */
function makeFixture(behaviour = {}) {
  const dir = makeTempDir('dsh-pocket-batch-')
  const store = createSettingsStore(dir)
  store.save({
    notify: {
      channel: 'clawbot',
      key: BOT,
      enabled: true,
      clawbot: { botToken: BOT, userId: 'user_batch', contextToken: CTX }
    }
  })
  const sent = []
  const state = {
    refuse: behaviour.refuse === true,
    inbound: null,
    items: [],
    at: 10_000_000
  }
  const notifyFetchImpl = async (url, options) => {
    const u = String(url)
    if (u.includes('/sendmessage')) {
      const body = JSON.parse(options.body)
      sent.push({
        text: body.msg.item_list[0].text_item.text,
        token: body.msg.context_token,
        refused: state.refuse
      })
      const payload = state.refuse
        ? { ret: -2, errmsg: 'prepare failed' }
        : { ret: 0, message_id: 7514520117146685576 }
      const wire = JSON.stringify(payload)
      return { ok: true, status: 200, json: async () => payload, text: async () => wire }
    }
    if (u.includes('/getupdates')) {
      const msg = state.inbound
      state.inbound = null
      const payload = { ret: 0, msgs: msg ? [msg] : [], get_updates_buf: 'buf_1' }
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
    }
    return { ok: true, status: 200, json: async () => ({ ret: 0 }), text: async () => '{"ret":0}' }
  }
  const bridgePromise = startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/list' ? { ok: true, value: { items: state.items } } : undefined
    },
    bridgeOptions: {
      settingsStore: store,
      notifyFetchImpl,
      now: () => state.at
    }
  })
  return { dir, sent, state, bridgePromise }
}

const tick = async (t) => {
  t.bridge._sessionListCache = undefined
  await t.bridge.pollNotifyRunning()
}

/**
 * Drive one or more sessions to a judged completion. The judge needs the run
 * *proven* before the flip counts as work: two running observations spanning
 * minBusyMs arm `longBusy`, and the flip then fires after graceMs of quiet
 * instead of waiting out the 90s settle.
 */
async function runThenSettle(t, fx, rows) {
  fx.state.items = rows.map((row) => ({ ...row, running: true, updatedAt: fx.state.at }))
  await tick(t)
  fx.state.at += J.minBusyMs + 10_000
  await tick(t)
  fx.state.at += 30_000
  fx.state.items = rows.map((row) => ({ ...row, running: false, updatedAt: fx.state.at - J.graceMs }))
  await tick(t)
}

/** Let the last bus reach its departure condition. */
async function rideLastBus(t, fx) {
  fx.state.at += B.batchQuietMs + 1
  await tick(t)
}

const settleFor = async (what, limitMs = 8000) => {
  const deadline = Date.now() + limitMs
  for (;;) {
    if (what()) return
    if (Date.now() > deadline) throw new Error('the batch lane never caught up')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('batch lane: a fleet that settles at once departs as ONE message, not one per session', async () => {
  const fx = makeFixture()
  const t = await fx.bridgePromise
  try {
    const names = ['写周报', '部署', '回归', '审计', '整理']
    const rows = names.map((title, i) => ({ sessionId: `s${i}`, title }))
    await runThenSettle(t, fx, rows)

    assert.equal(fx.sent.length, 1, 'one departure, not five')
    assert.ok(fx.sent[0].text.includes('5 个会话已完成'), fx.sent[0].text)
    for (const name of names) assert.ok(fx.sent[0].text.includes(name), `every name is in the list: ${name}`)
    assert.ok(fx.sent[0].text.includes('（第 1/10 条）'), 'the merged message spends ONE quota slot')
    assert.equal(t.bridge.notifyEnvelope.batchCount, 0, 'the lane is empty after departing')
  } finally {
    await t.stop()
    fs.rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('batch lane: 一个会话收尾时不上车，等末班车；期间不重复排队', async () => {
  const fx = makeFixture()
  const t = await fx.bridgePromise
  try {
    await runThenSettle(t, fx, [{ sessionId: 'solo', title: '一个人' }])
    assert.equal(fx.sent.length, 0, 'a lone completion waits for the last bus instead of leaving at once')
    assert.equal(t.bridge.notifyEnvelope.batchCount, 1)
    await rideLastBus(t, fx)
    assert.equal(fx.sent.length, 1, 'the last bus departs with it')
    assert.ok(fx.sent[0].text.includes('一个人'), 'a single passenger keeps the per-session shape')
    assert.ok(fx.sent[0].text.includes('已完成'))
  } finally {
    await t.stop()
    fs.rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('batch lane: 服务端说没额度就把新闻留在信封里，下一次入站（哪怕令牌没变）立刻补发', async () => {
  const fx = makeFixture({ refuse: true })
  const t = await fx.bridgePromise
  try {
    await runThenSettle(t, fx, [{ sessionId: 'a', title: '甲' }])
    await rideLastBus(t, fx)

    assert.equal(fx.sent.length, 1, 'the departure was attempted')
    assert.equal(t.bridge.clawbotQuotaSpent, true, 'prepare failed 定性为额度已尽')
    assert.equal(t.bridge.notifyEnvelope.batchCount, 1, '被拒的不是丢掉，是留在信封里')

    // 额度没回来之前，再来两个会话收尾：只攒不发，不去每 30s 撞一次墙。
    // （它们必须从「在跑」推起来——一个首次被看到就是 idle 的会话不算完成，
    // 那是判据本来的规矩，不能为了凑批次绕过它。）
    const attempts = fx.sent.length
    await runThenSettle(t, fx, [
      { sessionId: 'b', title: '乙' },
      { sessionId: 'c', title: '丙' }
    ])
    for (let i = 0; i < 2; i++) {
      fx.state.at += 30_000
      await tick(t)
    }
    assert.equal(fx.sent.length, attempts, 'spent quota holds departures instead of retrying every tick')
    assert.equal(t.bridge.notifyEnvelope.batchCount, 3, 'the new arrivals queue up behind it')

    // 用户在微信回一句。令牌照旧是同一个字符串——续期照样发生。
    fx.state.refuse = false
    fx.state.inbound = { context_token: CTX, from_user_id: 'user_batch' }
    await settleFor(() => fx.sent.length >= 2)

    assert.equal(fx.sent.length, 2, '一次入站补发一趟合并消息（同令牌不进回执那条分支）')
    assert.equal(t.bridge.clawbotQuotaSpent, false)
    const last = fx.sent[1].text
    assert.ok(last.includes('3 个会话已完成'), last)
    for (const name of ['甲', '乙', '丙']) assert.ok(last.includes(name))
    assert.ok(last.includes('（第 1/10 条）'), 'refilled quota restarts the count')
  } finally {
    await t.stop()
    fs.rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('batch lane: 提问是 T1——到就发；这一轮发不出去也要留着，等下一次入站补到', async () => {
  const fx = makeFixture({ refuse: true })
  const t = await fx.bridgePromise
  try {
    fx.state.items = [{ sessionId: 'q1', running: false, title: '部署周报', updatedAt: 1 }]
    t.bridge.rememberPendingQuestion('evt-1', { rpcId: 'r1', sessionId: 'q1', questions: [{ id: 'one' }] })
    await settleFor(() => fx.sent.length >= 1)

    assert.equal(fx.sent.length, 1, 'T1 不排队，到了就发')
    assert.ok(fx.sent[0].text.includes('有问题需要你回答'))
    assert.equal(t.bridge.clawbotQuotaSpent, true, '服务端把它拒了')
    assert.equal(t.bridge.notifyEnvelope.urgentCount, 1, '但没丢：留在紧急车道里')

    // 用户在微信回一句 → 额度回来 → 第一件事就是把这条等回答的送到。
    fx.state.refuse = false
    fx.state.inbound = { context_token: `${CTX}_2`, from_user_id: 'user_batch' }
    await settleFor(() => fx.sent.length >= 3)

    const texts = fx.sent.map((entry) => entry.text)
    assert.ok(
      texts.slice(1).some((text) => text.includes('有问题需要你回答') && text.includes('部署周报')),
      `the held question goes out after the refuel: ${JSON.stringify(texts)}`
    )
    assert.equal(t.bridge.notifyEnvelope.urgentCount, 0, 'delivered, so nothing is held any more')
  } finally {
    await t.stop()
    fs.rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('batch lane: 桌面「测试」是 T1，按下去就发，并顺路把攒着的新闻带走', async () => {
  const fx = makeFixture()
  const t = await fx.bridgePromise
  try {
    await runThenSettle(t, fx, [{ sessionId: 'z', title: '攒着的' }])
    assert.equal(t.bridge.notifyEnvelope.batchCount, 1, 'one passenger waiting')
    assert.equal(fx.sent.length, 0, 'and it has not left yet')

    const desktop = await t.pairDesktop()
    const res = await httpFetch(`${t.base}/desktop/notify/test`, {
      method: 'POST',
      headers: { Cookie: desktop }
    })
    const json = JSON.parse(await res.text())
    assert.deepEqual(json, { ok: true, delivered: true, held: 0, quotaSpent: false })
    assert.equal(fx.sent.length, 2, 'the test push went out, and the waiting news hitched a ride')
    assert.ok(fx.sent[0].text.includes('通知测试'))
    assert.ok(fx.sent[1].text.includes('攒着的'))
    assert.ok(fx.sent[1].text.includes('（第 2/10 条）'), 'the two sends count as two slots')
  } finally {
    await t.stop()
    fs.rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('batch lane: 没配置通道时，信封一个字都不发、也不往里攒', async () => {
  const dir = makeTempDir('dsh-pocket-batch-off-')
  const sent = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/list'
          ? { ok: true, value: { items: [{ sessionId: 'a', running: false, title: '甲', updatedAt: 1 }] } }
          : undefined
    },
    bridgeOptions: {
      settingsStore: { load: () => ({}), save: () => true },
      notifyFetchImpl: async (url) => {
        sent.push(String(url))
        return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
      },
      now: () => 9_000_000
    }
  })
  try {
    await t.bridge.pollNotifyRunning()
    await t.bridge.flushNotifyEnvelope('refill')
    assert.equal(sent.length, 0, 'unconfigured means silent')
    assert.equal(t.bridge.notifyEnvelope.batchCount, 0, 'and it does not accumulate either')
  } finally {
    await t.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('batch lane: 出厂航班表就是实测出来的那张表', () => {
  // 这四个数各有来历：batchMax 4 条一车（一条入站 10 条额度，四合一约两轮半新闻）；
  // quiet 75s 是末班车——比 NOTIFY_POLL_MS(30s) 宽，容得下两个 tick 的抖动；
  // hold 180s 封顶，防止持续进站的会话流把第一件等到超时；urgentMax 8 是「等人回答」的排队上限。
  assert.deepEqual(
    { ...B },
    { batchMax: 4, batchQuietMs: 75_000, batchHoldMs: 180_000, urgentMax: 8 },
    '改这四个数要连带改本注释与 CHANGELOG'
  )
})
