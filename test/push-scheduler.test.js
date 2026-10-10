// The push envelope (0.4.12): completion news catches a bus instead of each
// taking its own slot, arrive-and-answer news never waits, and a spent quota
// holds the news rather than losing it. The envelope is pure — `now` comes in
// as an argument — so the flight plan is decided here, on a hand-driven clock,
// and the bridge tests only cover the wiring.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPushEnvelope,
  mergeBatchItems,
  PUSH_BATCH,
  PUSH_URGENT
} from '../lib/push-scheduler.js'
import { NOTIFY_BATCH } from '../lib/bridge.js'

const B = NOTIFY_BATCH

/** An envelope with the shipped limits, driven by an explicit clock. */
function envelope(limits = B) {
  return createPushEnvelope(limits)
}

test('batch lane: a lone completion waits for the last bus, not for a fixed window', () => {
  const e = envelope()
  const t0 = 1_000_000
  assert.equal(e.add(PUSH_BATCH, { key: 's1', title: '写周报', body: '已完成' }, t0), true)
  assert.equal(e.due(t0), false, 'just arrived: nothing to leave with yet')
  assert.equal(e.due(t0 + B.batchQuietMs - 1), false, 'one ms short of the last bus')
  assert.equal(e.due(t0 + B.batchQuietMs), true, 'silence since the last arrival departs')

  const taken = e.take(t0 + B.batchQuietMs)
  assert.equal(taken.batch.length, 1)
  assert.equal(taken.batch[0].title, '写周报')
  assert.equal(e.batchCount, 0, 'take empties the lane')
  assert.equal(e.due(t0 + B.batchQuietMs * 2), false, 'an empty lane is never due')
})

test('batch lane: a full flight leaves at once', () => {
  const e = envelope()
  const t0 = 2_000_000
  for (let i = 0; i < B.batchMax - 1; i++) {
    e.add(PUSH_BATCH, { key: `s${i}`, title: `会话${i}`, body: '已完成' }, t0)
  }
  assert.equal(e.due(t0), false, 'not full, not quiet, not capped')
  e.add(PUSH_BATCH, { key: 'last', title: '会话N', body: '已完成' }, t0)
  assert.equal(e.due(t0), true, 'the flight is full: depart now')
})

test('batch lane: a stream that never goes quiet still departs at the hold cap', () => {
  // 末班车靠安静判定；如果会话持续 settle，quiet 条件永远不满足——封顶就是防止
  // 第一件等上车的事件无限等下去（赶飞机哲学：最多提前这么多，不误机）。
  const e = envelope()
  const t0 = 3_000_000
  let now = t0
  for (let i = 0; i < B.batchMax - 1; i++) {
    now += B.batchQuietMs - 1_000 // 每次都把 quiet 计时器重置掉
    e.add(PUSH_BATCH, { key: `s${i}`, title: `会话${i}`, body: '已完成' }, now)
    assert.equal(e.due(now), false, 'the arrival stream keeps the bus waiting')
  }
  assert.ok(e.oldestWaitMs(now) < B.batchHoldMs, 'the oldest passenger is still inside the cap')
  now += B.batchHoldMs
  assert.equal(e.due(now), true, 'the cap overrules a busy stream')
  assert.equal(e.oldestWaitMs(now) >= B.batchHoldMs, true)
})

test('batch lane: one session settling twice says it once', () => {
  const e = envelope()
  const t0 = 4_000_000
  e.add(PUSH_BATCH, { key: 's1', title: '旧标题', body: '已完成' }, t0)
  e.add(PUSH_BATCH, { key: 's1', title: '新标题', body: '已完成' }, t0 + 1000)
  assert.equal(e.batchCount, 1, 'per-session news is deduplicated, newest wins')
  const taken = e.take(t0 + 1000 + B.batchQuietMs)
  assert.equal(taken.batch.length, 1)
  assert.equal(taken.batch[0].title, '新标题')
  assert.equal(taken.batch[0].key, 's1', 'the key survives take() so a retry dedups the same way')
})

test('urgent lane: never merged, never waits, and take() hands it over first', () => {
  const e = envelope()
  const t0 = 5_000_000
  e.add(PUSH_URGENT, { title: '部署周报', body: '有问题需要你回答' }, t0)
  assert.equal(e.due(t0), false, 'urgent news does not make a batch departure due')
  assert.equal(e.urgentCount, 1)
  const taken = e.take(t0)
  assert.deepEqual(taken.urgent, [{ title: '部署周报', body: '有问题需要你回答' }])
  assert.deepEqual(taken.batch, [])
})

test('urgent lane: a bounded wait list drops the oldest, not the newest', () => {
  const e = envelope({ ...B, urgentMax: 3 })
  const t0 = 6_000_000
  for (let i = 0; i < 5; i++) e.add(PUSH_URGENT, { title: `q${i}`, body: '有问题需要你回答' }, t0)
  assert.equal(e.urgentCount, 3, 'the lane is bounded')
  const taken = e.take(t0)
  assert.deepEqual(taken.urgent.map((item) => item.title), ['q2', 'q3', 'q4'], 'newest kept')
})

test('envelope: an empty or contentless item is refused, not queued as a blank push', () => {
  const e = envelope()
  const t0 = 7_000_000
  assert.equal(e.add(PUSH_BATCH, { key: 's1', title: '  ', body: '' }, t0), false)
  assert.equal(e.add(PUSH_URGENT, undefined, t0), false)
  assert.equal(e.add(PUSH_BATCH, { key: 's2', title: '有名字', body: '' }, t0), true, 'a title alone is news')
  assert.equal(e.batchCount, 1)
})

test('merge: one passenger keeps the per-session shape, two or more become a list', () => {
  const one = mergeBatchItems([{ title: '写周报', body: '已完成' }], { titleMax: 80, listMax: 8 })
  assert.equal(one.title, '写周报', 'the m01400 shape is unchanged for a single session')
  assert.equal(one.body, '已完成')

  const two = mergeBatchItems(
    [
      { title: '写周报', body: '已完成' },
      { title: '部署', body: '已完成' }
    ],
    { titleMax: 80, listMax: 8 }
  )
  assert.equal(two.title, '2 个会话已完成', 'the title counts, because it can no longer name one')
  assert.ok(two.body.includes('· 写周报：已完成'))
  assert.ok(two.body.includes('· 部署：已完成'))
})

test('merge: a long fleet is capped in the list and counted in the title', () => {
  const items = []
  for (let i = 0; i < 20; i++) items.push({ title: `会话${i}`, body: '已完成' })
  const merged = mergeBatchItems(items, { titleMax: 80, listMax: 8 })
  assert.equal(merged.title, '20 个会话已完成', 'the count is the news, not the list')
  assert.equal(merged.body.split('\n').length, 9, 'eight names plus one overflow line')
  assert.ok(merged.body.includes('另有 12 个'), 'what was folded away is stated, not silent')
})

test('merge: mixed reasons do not claim one shared reason', () => {
  const merged = mergeBatchItems(
    [
      { title: 'A', body: '已完成' },
      { title: 'B', body: '已停止' }
    ],
    { titleMax: 80, listMax: 8 }
  )
  assert.equal(merged.title, '2 个会话有更新', 'a mixed departure says 有更新, not 已完成')
})

test('merge: nothing to say is an empty envelope, not a blank push', () => {
  const merged = mergeBatchItems([], { titleMax: 80, listMax: 8 })
  assert.deepEqual(merged, { title: '', body: '' })
})
