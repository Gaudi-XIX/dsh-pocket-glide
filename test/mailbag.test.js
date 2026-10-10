// 邮包的班次规则（0.4.12）：平邮攒成一封寄、什么时候发车、挂号信不排队。
// （「压太久作废」那条已在 0.4.15 取消，见下面那一档。）
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

test('平邮：最早一件压满 15 分钟才发——唯一的时间尺度', () => {
  const b = bag()
  const t0 = 1_000_000
  assert.equal(b.post(POST_ORDINARY, { key: 's1', title: '写周报', body: '已完成' }, t0), true)
  assert.equal(b.due(t0), false, '刚投进来，还没到点')
  assert.equal(b.due(t0 + M.holdMs - 1), false, '差一毫秒')
  assert.equal(b.due(t0 + M.holdMs), true, '最早那件压满 ⇒ 走')

  const taken = b.take(t0 + M.holdMs)
  assert.equal(taken.ordinary.length, 1)
  assert.equal(taken.ordinary[0].title, '写周报')
  assert.equal(b.ordinaryCount, 0, 'take 就是取走')
  assert.equal(b.due(t0 + M.holdMs * 2), false, '空包永远不该「到点」')
})

test('平邮：后面一直有新信进来，也拦不住最早那封到点（看的是最早，不是最后一封）', () => {
  // 这一档钉的是 0.4.17 把「末班车」砍掉之后的行为变化：原来 rideMs 看的是**最后一件**
  // 进来的时间，所以一直有新信就会把发车一直往后推；现在只看**最早那件**，
  // 它到 15 分钟就走，后来者跟着这一班一起走（用户原话：「最早一条满 15 分钟打包发一条摘要」）。
  const b = bag()
  const t0 = 2_000_000
  b.post(POST_ORDINARY, { key: 's1', title: '第一封', body: '已完成' }, t0)
  // 每 5 分钟来一封新的：第一封到 15 分钟时，后面已经又进来两封。
  b.post(POST_ORDINARY, { key: 's2', title: '第二封', body: '已完成' }, t0 + 5 * 60_000)
  b.post(POST_ORDINARY, { key: 's3', title: '第三封', body: '已完成' }, t0 + 10 * 60_000)
  assert.equal(b.due(t0 + 15 * 60_000 - 1), false, '最早那件还差一毫秒')
  assert.equal(b.due(t0 + 15 * 60_000), true, '最早那件到点 ⇒ 走，不管最后一件才进来 5 分钟')
  const taken = b.take(t0 + 15 * 60_000)
  assert.deepEqual(
    taken.ordinary.map((l) => l.title),
    ['第一封', '第二封', '第三封'],
    '一封摘要带走这一班里的全部'
  )
})

test('平邮：进手机端就重置计时——人放下手机之后才重新数 15 分钟', () => {
  // 用户 2026-10-10 22:33：「你进手机端立即重置待发送，打个时间戳啥的」。
  const b = bag()
  const t0 = 3_000_000
  b.post(POST_ORDINARY, { key: 's1', title: '会话一', body: '已完成' }, t0)
  b.post(POST_ORDINARY, { key: 's2', title: '会话二', body: '已完成' }, t0)

  // 压了 14 分钟，眼看就要发了 —— 这时人在手机页面前台露了一面。
  const seenAt = t0 + 14 * 60_000
  assert.equal(b.notePresence(seenAt), 2, '两件都被重新计时')
  assert.equal(b.ordinaryCount, 2, '只动时间戳：不取走、不丢弃')
  assert.equal(b.due(seenAt), false, '刚露面不该马上发')
  assert.equal(b.due(seenAt + M.holdMs - 1), false, '从「露面那一刻」重新数')
  assert.equal(b.due(seenAt + M.holdMs), true, '露面之后满 15 分钟才走')

  // 空包时什么都不做：没有东西需要重新计时。
  assert.equal(b.take(seenAt + M.holdMs).ordinary.length, 2)
  assert.equal(b.notePresence(seenAt + M.holdMs), 0, '空包 ⇒ 0 件被计时')
})

test('平邮：同一会话只占一个位置，标题取最新那次', () => {
  const b = bag()
  const t0 = 4_000_000
  b.post(POST_ORDINARY, { key: 's1', title: '旧标题', body: '已完成' }, t0)
  b.post(POST_ORDINARY, { key: 's1', title: '新标题', body: '已完成' }, t0 + 1000)
  assert.equal(b.ordinaryCount, 1, '同一个会话不占两个位置')
  const taken = b.take(t0 + 1000 + M.holdMs)
  assert.equal(taken.ordinary.length, 1)
  assert.equal(taken.ordinary[0].title, '新标题')
  assert.equal(taken.ordinary[0].key, 's1', 'take 之后 key 还在，寄失败时还能放回原位')
})

test('包里没有「放太久就作废」：压多久都还在，发车时一封不丢', () => {
  // 用户 2026-10-10 20:55 拍掉的规矩。原来有个 ttlMs（2 小时）会在发车那一刻把旧信扔掉，
  // 理由是「隔半天再通知昨晚跑完了是噪音」。但额度死掉、信发不出去时正是最不该丢信的场合：
  // 微信卡了一早上，通了就该一次全发过来。所以现在 take 只取不筛。
  const b = bag({ ...M, ttlMs: 60_000 })
  const t0 = 5_000_000
  b.post(POST_ORDINARY, { key: 'old', title: '很久以前的', body: '已完成' }, t0)
  b.post(POST_ORDINARY, { key: 'new', title: '刚跑完的', body: '已完成' }, t0 + 50_000)
  const taken = b.take(t0 + 90_000)
  assert.deepEqual(
    taken.ordinary.map((letter) => letter.title),
    ['很久以前的', '刚跑完的'],
    '过了 ttlMs 也照发——作废判据已整条取消'
  )
  assert.equal('voided' in taken, false, 'take 的返回值里不该再有 voided')
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
  assert.equal(many.title, '2 个会话已完成：写周报、部署', 'A 问：名字要在标题里，微信只显示第一行')
  assert.equal(many.body, '· 写周报\n· 部署', '标题已经说了「已完成」，正文每行就不用再重复')
})

test('装信：标题里的名字装不下就不硬塞，装了名字又没列全就补「等」', () => {
  const tight = sealOrdinaryMail(
    [
      { title: '很长的会话名称一', body: '已完成' },
      { title: '很长的会话名称二', body: '已完成' }
    ],
    { titleMax: 10, listMax: 8 }
  )
  assert.equal(tight.title, '2 个会话已完成', '一个名字都塞不进 ⇒ 退回原形状，不砍半个名字')

  const partial = sealOrdinaryMail(
    [
      { title: '会话0', body: '已完成' },
      { title: '会话1', body: '已完成' },
      { title: '会话2', body: '已完成' }
    ],
    { titleMax: 14, listMax: 8 }
  )
  assert.equal(partial.title, '3 个会话已完成：会话0等', '只列下第一个 ⇒ 说「等」，不假装列全')
})

test('装信：理由不一样时不许含糊成同一个理由', () => {
  const mixed = sealOrdinaryMail(
    [
      { title: 'A', body: '已完成' },
      { title: 'B', body: '已停止' }
    ],
    { titleMax: 80, listMax: 8 }
  )
  assert.equal(mixed.title, '2 个会话有进展：A、B', '混在一起标题只能说笼统的「有进展」，但名字照样要带上')
  assert.ok(mixed.body.includes('· A：已完成'))
  assert.ok(mixed.body.includes('· B：已停止'), '各自理由逐行带上')
})

test('装信：一封装不下的数量写在信里，标题报的是总数不是列出的数', () => {
  const letters = []
  for (let i = 0; i < 20; i++) letters.push({ title: `会话${i}`, body: '已完成' })
  const merged = sealOrdinaryMail(letters, { titleMax: 80, listMax: 8 })
  assert.equal(
    merged.title,
    '20 个会话已完成：会话0、会话1、会话2、会话3、会话4、会话5、会话6、会话7等',
    '标题报的是总数，名字列到装不下为止，剩下的说「等」'
  )
  assert.equal(merged.body.split('\n').length, 9, '八行名字 + 一行「另有几个」')
  assert.ok(merged.body.includes('另有 12 个'), '折掉了多少必须说出来')
})

test('装信：没东西可说就是空信，不是一封空白邮件', () => {
  assert.deepEqual(sealOrdinaryMail([], { titleMax: 80, listMax: 8 }), { title: '', body: '' })
})

test('班次表就是定出来的那张表（改数要连带改注释与 CHANGELOG）', () => {
  // 2026-10-10 22:33 用户亲自砍到这个程度：「只有特殊消息立即发；你进手机端立即重置待发送，
  // 打个时间戳啥的；否则最早一条满 15 分钟打包发一条摘要。就这么简单」。
  // 见 lib/bridge.js 的 NOTIFY_MAILBAG 注释（那里记了砍掉 rideMs/lettersMax 的理由）。
  // holdMs 15 分钟 ＝ **唯一**的时间尺度：最早那件压满就走；
  // registeredMax 8 ＝ 等补投的挂号信上限。
  // **表里不该再出现 rideMs／lettersMax**：一个时间尺度，不再有「安静够了才走」和「装满就走」。
  // **表里不该再出现 ttlMs**：作废判据 2026-10-10 20:55 已被用户整条取消。
  assert.deepEqual({ ...M }, {
    holdMs: 15 * 60_000,
    registeredMax: 8
  })
  assert.equal('rideMs' in M, false, '末班车已砍：发车只看最早那件')
  assert.equal('lettersMax' in M, false, '装满就走已砍：它是同一个时间尺度的另一种量度')
})
