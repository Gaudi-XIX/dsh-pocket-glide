// 判据 2(c) 的可证定义：首屏可见行的 tail 答案是不是真到手（filled 这一位）。
//
// 「已就绪」不许靠「刚发过一趟 rpc」作证——发出去不等于答案到手。这一层只问三件事：
//   1. requestVisibleTails 把那一趟 rpc('session.tails') 的答案（含空页答案）落成
//      tailCache 里 filled===true；
//   2. 桥给 {error:'timeout'}、行又已回队到 TAIL_REQUEUE_MAX 上限时，这一行不算到手
//      （visibleTailsFilled 必须说 false，不许替桥作答）；
//   3. 冷启动文档自带 tails（applyBootTails）落地时同样盖章 filled —— 这些行被
//      tailArmedAt 挡住不再重拉，不盖章就永远等不到「已就绪」。
// 另钉一条判据 3b 的机械保证：就绪流程与 renderWorkspaces 末尾那趟共享同一个在飞
// Promise，就绪前不新增任何往返。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const assets = { zh: mobilePageAssets({ locale: 'zh' }) }

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the rendered asset`)
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const char = source[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${name}`)
}

const numberAt = (re, why) => {
  const m = assets.zh.js.match(re)
  assert.ok(m, why)
  return Number(m[1])
}
const limitOf = () => numberAt(/const TAIL_TEXT_LIMIT=(\d+);/, 'TAIL_TEXT_LIMIT must be a plain number in the asset')
const packMaxOf = () => numberAt(/const TAIL_PACK_MAX=(\d+);/, 'TAIL_PACK_MAX must be a plain number in the asset')
const cacheMaxOf = () => numberAt(/const TAIL_CACHE_MAX=(\d+);/, 'the pack cache must be bounded')
const retryMaxOf = () => numberAt(/const TAIL_RETRY_MAX=(\d+);/, 'TAIL_RETRY_MAX must be a plain number in the asset')
const batchMaxOf = () => numberAt(/const TAIL_BATCH_MAX=(\d+);/, 'TAIL_BATCH_MAX must be a plain number in the asset')
const roundsMaxOf = () => numberAt(/const TAIL_ROUNDS_MAX=(\d+);/, 'TAIL_ROUNDS_MAX must be a plain number in the asset')
const requeueMaxOf = () => numberAt(/const TAIL_REQUEUE_MAX=(\d+);/, 'TAIL_REQUEUE_MAX must be a plain number in the asset')

// One user message record in the shape the bridge ships (entry.event wrapper).
const userMsg = (text, time, seq) => ({
  event: { type: 'user/message', seq, time, data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } }
})

// 只切 tail 那一段的真身（prefetch 只看已渲染行），DOM 与网络用替身。
const tailSandbox = ({ state = {}, rpcImpl }) => {
  const js = assets.zh.js
  const body = [
    extractFunction(js, 'contentBlocks'),
    extractFunction(js, 'eventSeq'),
    extractFunction(js, 'extractTail'),
    extractFunction(js, 'tailPack'),
    extractFunction(js, 'applyBootTails'),
    extractFunction(js, 'requestVisibleTails'),
    extractFunction(js, 'visibleTailsFilled'),
  ].join('\n')

  return new Function('rpc, taskState, noteSessionMessageAt, renderWorkspaces, fakeHost, state', `
    const TAIL_TEXT_LIMIT=${limitOf()}
    const TAIL_PACK_MAX=${packMaxOf()}
    const TAIL_CACHE_MAX=${cacheMaxOf()}
    const TAIL_RETRY_MAX=${retryMaxOf()}
    const TAIL_BATCH_MAX=${batchMaxOf()}
    const TAIL_ROUNDS_MAX=${roundsMaxOf()}
    const TAIL_REQUEUE_MAX=${requeueMaxOf()}
    const tailCache=new Map(),tailArmedAt={},tailPending=new Set(),tailFailed={}
    let activeSession=${JSON.stringify(state.activeSession ?? null)}
    let tailRound=Promise.resolve()
    const sessionSummaries=${JSON.stringify(state.rows ?? [])}
    ${body}
    return {
      requestVisibleTails: () => requestVisibleTails(fakeHost()),
      visibleTailsFilled: () => visibleTailsFilled(fakeHost()),
      applyBootTails, tailCache, tailArmedAt, tailPending, tailFailed
    }
  `)(rpcImpl, (s) => s.state || '', () => {}, () => {}, () => ({
    querySelectorAll: (sel) => sel === '.task-row[data-id]' ? (state.visible || []).map((id) => ({ getAttribute: () => id })) : []
  }), state)
}

test('可见行的 tail 答案到手才算 filled（含空页答案）', async () => {
  const state = { rows: [{ sessionId: 'a', updatedAt: 10 }, { sessionId: 'b', updatedAt: 20 }], visible: ['a', 'b'] }
  const asked = []
  const box = tailSandbox({
    state,
    rpcImpl: async (method, payload) => {
      asked.push(method)
      return { tails: Object.fromEntries(payload.sessions.map((id) => [id, { updatedAt: id === 'a' ? 10 : 20, events: id === 'a' ? [userMsg('第一条', 100, 1)] : [] }])) }
    }
  })
  assert.equal(box.visibleTailsFilled(), false, '答案还没到手：不许先认成已就绪')
  await box.requestVisibleTails()
  assert.deepEqual(asked, ['session.tails'], '只等这一趟往返')
  assert.equal(box.tailCache.get('a').filled, true, '有内容的行到手即盖章')
  assert.equal(box.tailCache.get('a').text, '第一条', '到手的是真读数，不是空壳')
  assert.equal(box.tailCache.get('b').filled, true, '空页答案也算答案到手（桥说「这一页没有消息」也是真值）')
  assert.equal(box.visibleTailsFilled(), true, '两行都到手 ⇒ 谓词为真（判据 2(c)）')
})

test('桥回 timeout 且已回队到上限的行不算到手', async () => {
  const state = { rows: [{ sessionId: 'a', updatedAt: 10 }], visible: ['a'] }
  let calls = 0
  const box = tailSandbox({
    state,
    rpcImpl: async () => {
      calls += 1
      return { tails: { a: { error: 'timeout' } } }
    }
  })
  await box.requestVisibleTails()
  assert.equal(calls, requeueMaxOf() + 1, `timeout 允许回队 ${requeueMaxOf()} 次，第 ${requeueMaxOf() + 1} 次收手`)
  assert.equal(box.tailCache.get('a'), undefined, '没拿到包就不许盖章')
  assert.equal(box.visibleTailsFilled(), false, '没到手就不许说已就绪——不替桥作答')
  assert.equal(box.tailFailed.a.count, 1, '到上限的那一次记进失败计数，下次 updatedAt 一变即清零重来')
})

test('冷启动文档自带 tails 落地即算到手，页内不再重拉', async () => {
  const state = { rows: [{ sessionId: 'a', updatedAt: 10 }, { sessionId: 'b', updatedAt: 20 }], visible: ['a', 'b'] }
  const asked = []
  const box = tailSandbox({ state, rpcImpl: async (...a) => { asked.push(a); throw new Error('自带 tails 的行不该再拉一趟') } })
  box.applyBootTails({
    a: { updatedAt: 10, events: [userMsg('自带第一条', 100, 1)] },
    b: { updatedAt: 20, events: [] }
  })
  assert.equal(box.tailCache.get('a').filled, true, '自带 tails 同样算「这一行 tail 答案已到手」')
  assert.equal(box.visibleTailsFilled(), true, '自带 tails 的行也是「可点开直接看」的行')
  await box.requestVisibleTails()
  assert.equal(asked.length, 0, 'updatedAt 与原戳一致 ⇒ 不再重拉（就绪前不新增往返）')
  assert.equal(box.visibleTailsFilled(), true)
})

test('就绪那一趟与重画末尾那趟共享同一个在飞 Promise，且空集也返回它', async () => {
  const state = { rows: [{ sessionId: 'a', updatedAt: 10 }, { sessionId: 'b', updatedAt: 20 }], visible: ['a', 'b'] }
  let calls = 0
  const box = tailSandbox({ state, rpcImpl: () => { calls += 1; return new Promise(() => {}) } })
  const first = box.requestVisibleTails()
  const second = box.requestVisibleTails()
  assert.equal(first, second, '同一轮里的第二次调用必须返回同一个在飞 Promise（判据 3b：不新增往返）')
  assert.equal(calls, 1, '往返仍然只有一趟')
  assert.equal(box.tailPending.has('a') && box.tailPending.has('b'), true, '两行都还在这一轮里')
  assert.equal(box.tailCache.get('a'), undefined, '这一趟还没回来：不许提前盖章')

  const empty = tailSandbox({ state: { rows: [{ sessionId: 'a', updatedAt: 10 }], visible: [] }, rpcImpl: async () => ({ tails: {} }) })
  assert.ok(empty.requestVisibleTails() instanceof Promise, '没有可见行时也必须返回这一轮的 Promise，不再返回 undefined')
})