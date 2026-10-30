// 完成通知的两条跳过（用户 2026-10-30 原话：「未命名的也不通知」「Bot 只在 Bot 回复
// 用户的时候推送」）。
//
// 两条都只约束**完成通知**这一条链路（`pollNotifyRunning` 的 fire 分支）：重试风暴
// （卡在重试）、提问（待回答）、桌面测试端点各自另有语义，本批不动。
//
// 判据：
//   ① 取不到标题的行不推（`sessionTitleOf` 四级字段全空 → 兜底「会话」）。
//   ② Bot 会话只在它这一回合真的回给用户时才推：读 `session/page`，窗口内**存在**
//      `source.kind==='user'` 的 `user/message` 才推。判据是「存在」不是「最后一条」——
//      同一回合里注入行（runtime-context / time-context / plugin:memory）可能排在用户行
//      之后，位置说明不了任何事（`lib/bot-page.js:880-883`：「the decision is the role,
//      never the kind alone」）。
//   ③ 读页失败 fail-open 照推：判不出时不静默吞通知。一次 settle 只 fire 一次
//      （`state.notified` 一旦置真永不补推），所以「延后一拍重试」在这里等于永久丢失。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge } from './helpers.js'

const REAL_KEY = 'SECRETKET1234567890AB'

function notifyBridgeOptions(sent) {
  return {
    settingsStore: {
      load: () => ({ notify: { channel: 'bark', key: REAL_KEY, enabled: true } }),
      save: () => true
    },
    notifyFetchImpl: async (url) => {
      sent.push(String(url))
      return { ok: true, text: async () => '{}' }
    }
  }
}

/**
 * Drive one session from busy to a settled (idle for 90 s) and collect what went
 * out. The clock is injected, because the judge settles on QUIET time, not on the
 * number of polls.
 */
async function settle(t, items, clock) {
  const tick = async () => {
    t.bridge._sessionListCache = undefined
    await t.bridge.pollNotifyRunning()
  }
  await tick() // baseline: the session is busy
  items[0].running = false
  clock.at += 30_000
  await tick() // the flip tick: the judge notes the stop but does not believe it yet
  clock.at += 91_000
  await tick() // 91 s of silence ⇒ the judge settles
}

function startWith(sent, items, clock, respond) {
  return startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => {
        if (pathname === '/api/session/list') return { ok: true, value: { items } }
        if (pathname === '/api/session/page') return respond ? respond() : undefined
        return undefined
      }
    },
    bridgeOptions: { ...notifyBridgeOptions(sent), now: () => clock.at }
  })
}

test('an untitled session settles without a push: a nameless notice is unreadable', async () => {
  const sent = []
  const clock = { at: 1_000_000 }
  // No title anywhere: not in projections.values, not at the top level.
  const items = [{ sessionId: 's1', running: true, updatedAt: clock.at }]
  const t = await startWith(sent, items, clock, () => undefined)
  try {
    await settle(t, items, clock)
    assert.equal(sent.length, 0, 'no name, no push')
    assert.ok(
      t.logs.some(({ message }) => message.includes('notify skipped (untitled)')),
      'and the skip says why',
    )
  } finally {
    await t.stop()
  }
})

test('a titled session settles with a push: the name is what makes the notice usable', async () => {
  const sent = []
  const clock = { at: 1_000_000 }
  const items = [
    { sessionId: 's1', running: true, updatedAt: clock.at, projections: { values: { title: '写周报' } } }
  ]
  const t = await startWith(sent, items, clock, () => undefined)
  try {
    await settle(t, items, clock)
    assert.equal(sent.length, 1, 'a named session still announces itself')
    assert.ok(sent[0].includes(encodeURIComponent('写周报')))
  } finally {
    await t.stop()
  }
})

test('a Bot turn that never reached the user settles without a push', async () => {
  const sent = []
  const clock = { at: 1_000_000 }
  const items = [
    {
      sessionId: 's1',
      running: true,
      updatedAt: clock.at,
      projections: { asOfSeq: 12, values: { title: 'Bot 接力', botName: 'Helper' } }
    }
  ]
  // The window holds a `user/message` from another Bot (a relay), not from the
  // operator. That is the shape of Bot-to-Bot traffic, and it is not a reply to
  // the user.
  const t = await startWith(sent, items, clock, () => ({
    ok: true,
    value: {
      records: [
        { type: 'event', event: { type: 'user/message', seq: 12, data: { source: { kind: 'bot' }, content: 'ping' } } }
      ],
      hasMore: false
    }
  }))
  try {
    await settle(t, items, clock)
    assert.equal(sent.length, 0, 'a Bot talking to a Bot is not an answer to the user')
    assert.ok(
      t.logs.some(({ message }) => message.includes('notify skipped (bot turn did not reach the user)')),
      'and the skip says why',
    )
  } finally {
    await t.stop()
  }
})

test('a Bot turn that reached the user settles with a push', async () => {
  const sent = []
  const clock = { at: 1_000_000 }
  const items = [
    {
      sessionId: 's1',
      running: true,
      updatedAt: clock.at,
      projections: { asOfSeq: 12, values: { title: 'Bot 接力', botName: 'Helper' } }
    }
  ]
  // The operator's own line is in the window — even though a system injection
  // lands AFTER it (position says nothing; presence does).
  const t = await startWith(sent, items, clock, () => ({
    ok: true,
    value: {
      records: [
        { type: 'event', event: { type: 'user/message', seq: 10, data: { source: { kind: 'user' }, content: '在吗' } } },
        { type: 'event', event: { type: 'user/message', seq: 11, data: { source: { kind: 'plugin:memory' }, content: '…' } } }
      ],
      hasMore: false
    }
  }))
  try {
    await settle(t, items, clock)
    assert.equal(sent.length, 1, 'the Bot did answer the user, so the notice goes out')
    assert.ok(sent[0].includes(encodeURIComponent('Bot 接力')))
  } finally {
    await t.stop()
  }
})

test('an unreadable page is fail-open: the notice goes out rather than being swallowed', async () => {
  const sent = []
  const clock = { at: 1_000_000 }
  const items = [
    {
      sessionId: 's1',
      running: true,
      updatedAt: clock.at,
      projections: { asOfSeq: 12, values: { title: 'Bot 接力', botName: 'Helper' } }
    }
  ]
  // The Host cannot answer the page read. A settle fires exactly once, so
  // "retry next tick" would mean "never": the notice must go out.
  const t = await startWith(sent, items, clock, () => undefined)
  try {
    await settle(t, items, clock)
    assert.equal(sent.length, 1, 'judging nothing is not a reason to swallow the notice')
  } finally {
    await t.stop()
  }
})
