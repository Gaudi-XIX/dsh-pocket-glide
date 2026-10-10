// 邮包的班次规则（0.4.12）：平邮攒成一封寄、什么时候发车、挂号信不排队、压太久作废。
// 这只包不读时钟也不碰磁盘，`now` 从参数进来，所以整套规则能用一个手工时钟测完；
// 桥那边的接线（含落盘）在 test/mailbag-post.test.js。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createMailbag,
  sealOrdinaryMail,
  POST_ORDINARY,
  POST_REGISTERED
} from '../lib/mailbag.js'
import { NOTIFY_MAILBAG } from '../lib/bridge.js'

const M = NOTIFY_MAILBAG

/** @param {object} [limits] */
function bag(limits = M) {
  return createMailbag(limits)
}

test('平邮：刚投进来不发车，这一波安静够了才走（末班车看最后一次投递）', () => {
  const b = bag()
  const t0 = 1_000_000
  assert.equal(b.post(POST_ORDINARY, { key: 's1', title: '写周报', body: '已完成' }, t0), true)
  assert.equal(b.due(t0), false, '刚投进来，还没到末班')
  assert.equal(b.due(t0 + M.rideMs - 1), false, '差一毫秒')
  assert.equal(b.due(t0 + M.rideMs), true, '这一波安静够了 ⇒ 走')

  const taken = b.take(t0 + M.rideMs)
  assert.equal(taken.ordinary.length, 1)
  assert.equal(taken.ordinary[0].title, '写周报')
  assert.equal(b.ordinaryCount, 0, 'take 就是取走')
  assert.equal(b.due(t0 + M.rideMs * 2), false, '空包永远不该「到点」')
})

test('平邮：一直有新信进来会把末班车一直推迟，所以封顶时间兜住最早那一封', () => {
  // 「末班车」单独用是有洞的：只要 stream 不断，就永远等不到安静。
  // 这一档测的就是那个兜底：每隔 9 分钟来一封（ rideMs 是 10 分钟），前两回都不该走，
  // 到第三回最早那封已经压了 27 分钟 ⇒ 强制发车。
  const b = bag()
  const t0 = 2_000_000
  b.post(POST_ORDINARY, { key: 's1', title: '第一封', body: '已完成' }, t0)
  let now = t0
  for (let i = 2; i <= 3; i++) {
    now += M.rideMs - 60_000
    b.post(POST_ORDINARY, { key: `s${i}`, title: `第${i}封`, body: '已完成' }, now)
    assert.equal(b.due(now), false, `第 ${i} 封进来时：既没装满也没安静 ⇒ 不走`)
  }
  now += M.rideMs - 60_000
  b.post(POST_ORDINARY, { key: 's4', title: '第4封', body: '已完成' }, now)
  assert.ok(b.pressureMs(now) > M.holdMs, '最早那封已经压过封顶时间')
  assert.equal(b.due(now), true, '封顶了就走，不管后面还有没有信来')
})

test('平邮：攒满一封装不下那么多就立刻走，不等安静不等封顶', () => {
  const b = bag()
  const t0 = 3_000_000
  for (let i = 0; i < M.lettersMax - 1; i++) {
    b.post(POST_ORDINARY, { key: `s${i}`, title: `会话${i}`, body: '已完成' }, t0)
  }
  assert.equal(b.due(t0), false, '还差一封')
  b.post(POST_ORDINARY, { key: 'last', title: '收尾', body: '已完成' }, t0)
  assert.equal(b.due(t0), true, '装满立刻走')
})

test('平邮按会话去重：同一件事办完两次只说一次，说最新那次', () => {
  const b = bag()
  const t0 = 4_000_000
  b.post(POST_ORDINARY, { key: 's1', title: '旧标题', body: '已完成' }, t0)
  b.post(POST_ORDINARY, { key: 's1', title: '新标题', body: '已完成' }, t0 + 1000)
  assert.equal(b.ordinaryCount, 1, '同一个会话不占两个位置')
  const taken = b.take(t0 + 1000 + M.rideMs)
  assert.equal(taken.ordinary.length, 1)
  assert.equal(taken.ordinary[0].title, '新标题')
  assert.equal(taken.ordinary[0].key, 's1', 'take 之后 key 还在，寄失败时还能放回原位')
})

test('平邮压太久就作废，而且说得出作废了几封（不静默吞）', () => {
  const b = bag({ ...M, ttlMs: 60_000 })
  const t0 = 5_000_000
  b.post(POST_ORDINARY, { key: 'old', title: '昨天的', body: '已完成' }, t0)
  b.post(POST_ORDINARY, { key: 'new', title: '刚跑完的', body: '已完成' }, t0 + 50_000)
  const taken = b.take(t0 + 90_000)
  assert.deepEqual(taken.ordinary.map((letter) => letter.title), ['刚跑完的'], '过期那封不寄')
  assert.equal(taken.voided, 1, '但要在日志里说清楚丢了几封')
})

test('挂号信：不排队、不合并，也不替邮包提前发车', () => {
  const b = bag()
  const t0 = 6_000_000
  b.post(POST_REGISTERED, { title: '部署周报', body: '有问题需要你回答' }, t0)
  assert.equal(b.due(t0), false, '挂号信的存在不该让平邮提前走')
  assert.equal(b.registeredCount, 1)
  const taken = b.take(t0)
  assert.equal(taken.registered.length, 1)
  assert.equal(taken.registered[0].title, '部署周报')
  assert.deepEqual(taken.ordinary, [])
})

test('挂号信：待补投是有上限的，挤掉最老的而不是最新的', () => {
  const b = bag({ ...M, registeredMax: 3 })
  const t0 = 7_000_000
  for (let i = 0; i < 5; i++) b.post(POST_REGISTERED, { title: `q${i}`, body: '有问题需要你回答' }, t0)
  assert.equal(b.registeredCount, 3, '等补投的挂号信不能无限堆')
  assert.deepEqual(b.take(t0).registered.map((item) => item.title), ['q2', 'q3', 'q4'], '留的是最新的')
})

test('空信不收：标题正文都空的东西不能变成一封空邮件寄出去', () => {
  const b = bag()
  const t0 = 8_000_000
  assert.equal(b.post(POST_ORDINARY, { key: 's1', title: '  ', body: '' }, t0), false)
  assert.equal(b.post(POST_REGISTERED, undefined, t0), false)
  assert.equal(b.post(POST_ORDINARY, { key: 's2', title: '有名字', body: '' }, t0), true, '只有标题也算一条消息')
  assert.equal(b.ordinaryCount, 1)
})

test('落盘恢复：带原时间戳回来，重启前已压 18 分钟的信不会重新数一遍', () => {
  const b = bag()
  const t0 = 9_000_000
  // 文件里读出来的信自带 inAt（= 当初投进包的时间），bridge 原样灌回来。
  b.post(POST_ORDINARY, { key: 's1', title: '重启前跑完的', body: '已完成', inAt: t0 - 18 * 60_000 }, t0)
  assert.equal(b.pressureMs(t0), 18 * 60_000, '按它本来的时间排队，不当新信重新计时')
  assert.equal(b.due(t0 + 2 * 60_000), true, '已过封顶时间 ⇒ 下一班就走')
})

test('装信：只有一件时保持原样，多件才有汇总；理由相同就别在正文里重复', () => {
  const one = sealOrdinaryMail([{ title: '写周报', body: '已完成' }], { titleMax: 80, listMax: 8 })
  assert.equal(one.title, '写周报', '单独一件时标题仍是会话名——0.4.10 已验收的形状不动')
  assert.equal(one.body, '已完成')

  const many = sealOrdinaryMail(
    [
      { title: '写周报', body: '已完成' },
      { title: '部署', body: '已完成' }
    ],
    { titleMax: 80, listMax: 8 }
  )
  assert.equal(many.title, '2 个会话已完成')
  assert.equal(many.body, '· 写周报\n· 部署', '标题已经说了「已完成」，正文每行就不用再重复')
})

test('装信：理由不一样时不许含糊成同一个理由', () => {
  const mixed = sealOrdinaryMail(
    [
      { title: 'A', body: '已完成' },
      { title: 'B', body: '已停止' }
    ],
    { titleMax: 80, listMax: 8 }
  )
  assert.equal(mixed.title, '2 个会话有进展', '混在一起只能说笼统的「有进展」')
  assert.ok(mixed.body.includes('· A：已完成'))
  assert.ok(mixed.body.includes('· B：已停止'), '各自理由逐行带上')
})

test('装信：一封装不下的数量写在信里，标题报的是总数不是列出的数', () => {
  const letters = []
  for (let i = 0; i < 20; i++) letters.push({ title: `会话${i}`, body: '已完成' })
  const merged = sealOrdinaryMail(letters, { titleMax: 80, listMax: 8 })
  assert.equal(merged.title, '20 个会话已完成', '标题是 20 件，不是列出来的 8 件')
  assert.equal(merged.body.split('\n').length, 9, '八行名字 + 一行「另有几个」')
  assert.ok(merged.body.includes('另有 12 个'), '折掉了多少必须说出来')
})

test('装信：没东西可说就是空信，不是一封空白邮件', () => {
  assert.deepEqual(sealOrdinaryMail([], { titleMax: 80, listMax: 8 }), { title: '', body: '' })
})

test('班次表就是定出来的那张表（改数要连带改注释与 CHANGELOG）', () => {
  // lettersMax 8 ＝ 一封信列得下的名字数（也是信的可读长度上限）；
  // rideMs 10 分钟、holdMs 20 分钟 ＝ 用户给的尺度「完成通知十几二十分钟能接受」；
  // registeredMax 8 ＝ 等补投的挂号信上限；ttlMs 2 小时之后的完成消息不值得再寄。
  assert.deepEqual({ ...M }, {
    lettersMax: 8,
    rideMs: 10 * 60_000,
    holdMs: 20 * 60_000,
    registeredMax: 8,
    ttlMs: 2 * 60 * 60_000
  })
})
