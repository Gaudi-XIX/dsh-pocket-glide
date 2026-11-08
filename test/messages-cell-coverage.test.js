// 消息格（阶梯第 4 格）的覆盖判据 —— 2026-11-09 判据 M1。
//
// 缺陷：11-04 用户报「PIN 码页会话消息后面没有数字」，11-08 仍未修好。上一版把完好性
// 判成「session.list 全量 ⊆ 预载集合」，而预载是按设计只有 10 个、还排除子代理/隐藏/
// 未归属——两个集合永远不相等，真机 16 个会话时该格只能永远留白。
// 定案（设计 2026-11-09 复核）：留白只针对「请求了但没答回」，不针对「没请求」：
//   ① 完整性只判这一批请求了的会话是否都拿回尾巴且无 error；
//   ② 请求集合要覆盖会话格数的同一份行集，上限 TAILS_MAX_SESSIONS(30)，超了才留白；
//   ③ 空集仍然单独交 messages:0（every 对空集恒真，不许由它出数）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { LanMobileBridge } from '../lib/bridge.js'

const MIN = 60 * 1000
// 与 lib/bridge.js:186 `const TAILS_MAX_SESSIONS = 30` 同口径（未导出，故在此复写）。
const TAILS_MAX_SESSIONS = 30

function makeBridge({ items = [], subCalled = null } = {}) {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = []
  bridge.log = () => {}
  bridge.locale = () => 'zh'
  bridge.now = () => Date.now()
  bridge.iconDataUri = null
  bridge.html = (response, markup) => { response.markup = markup; return markup }
  bridge.pendingQuestions = new Map()
  bridge.workspaceSnapshot = { items: [] }
  bridge.noteSavings = () => {}
  bridge.cachedSettings = async () => ({ ok: true, value: {} })
  bridge.cachedSessionList = async () => ({ ok: true, value: { items } })
  bridge.invokeHarness = async (endpoint, args) => {
    if (endpoint === 'session/page') {
      const id = args?.request?.address?.sessionId
      if (subCalled && id === 'sub1') subCalled.called = true
      return {
        ok: true,
        value: {
          records: [{
            seq: 1,
            event: {
              type: 'user/message',
              time: Date.now() - MIN,
              data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'tail ' + id }], stream: 'x', header: 'h', meta: 'm' } }
            }
          }]
        }
      }
    }
    return { ok: false }
  }
  return bridge
}

// 24 小时窗内的可见行（updatedAt 递减，最新在前），每行都带游标。
const rows = (n) => Array.from({ length: n }, (_, i) => ({
  sessionId: `s${i + 1}`,
  updatedAt: Date.now() - (i + 1) * MIN,
  projections: { asOfSeq: 42 }
}))

test('M1 session.tails：16 个可见会话（超过预载 10）这一格必须真能成值', async () => {
  const items = rows(16)
  const bridge = makeBridge({ items })
  const ids = items.map((row) => row.sessionId)
  const result = await bridge.forwardRpc('session.tails', { sessions: ids })
  assert.equal(result.ok, true)
  assert.equal(result.value.complete, true, '这批请求的会话全答回且无 error 就是完整——不再拿全量清单去比')
  assert.equal(typeof result.value.messages, 'number', '16 个会话时必须给数，不能跟上一版一样永远留白')
  assert.ok(result.value.messages >= 16, `每个会话至少一条消息，saw ${result.value.messages}`)
  assert.equal(result.stage.messages, result.value.messages, '阶梯第 4 格收的就是这个数')
  assert.equal(Object.keys(result.value.tails).length, 16, '请求了多少就要回多少条尾巴')
})

test('M1 session.tails：请求量超过上限才算不完，超了才留白', async () => {
  const items = rows(TAILS_MAX_SESSIONS + 5)
  const bridge = makeBridge({ items })
  const ids = items.map((row) => row.sessionId)
  const result = await bridge.forwardRpc('session.tails', { sessions: ids })
  assert.equal(result.ok, true)
  assert.equal(result.value.complete, false, '被截断的一批不许声称完整')
  assert.equal(result.value.messages, null, 'R1：不完整就不给数')
  assert.equal(result.stage.messages, null)
  assert.equal(Object.keys(result.value.tails).length, TAILS_MAX_SESSIONS, '上限之内的那部分照旧答回，页面还能画')
})

test('M1 session.tails：一条尾巴报错仍然整批留白（既有强度不下调）', async () => {
  const items = [
    { sessionId: 's1', updatedAt: Date.now() - MIN, projections: { asOfSeq: 42 } },
    { sessionId: 's2', updatedAt: Date.now() - 2 * MIN }
  ]
  const bridge = makeBridge({ items })
  const result = await bridge.forwardRpc('session.tails', { sessions: ['s1', 's2'] })
  assert.equal(result.value.complete, false)
  assert.equal(result.value.messages, null)
})

test('M1 整包：16 个可见会话的首包不再因为预载只取 10 个而留白', async () => {
  const items = rows(16)
  const bridge = makeBridge({ items })
  const payload = await bridge.buildMobileBoot()
  assert.equal(typeof payload.stageSummary.messages, 'number', '首包这一格也要真数，不能留白')
  assert.ok(payload.stageSummary.messages >= 16, `saw ${payload.stageSummary.messages}`)
  assert.equal(Object.keys(payload.tails || {}).length, 16, '要数的会话与发的尾巴是同一份集合')
})

test('M1 整包：子代理行不进覆盖集合，也不让这一格留白', async () => {
  const subCalled = { called: false }
  const items = [...rows(3), { sessionId: 'sub1', origin: 'subagent', updatedAt: Date.now() - MIN, projections: { asOfSeq: 7 } }]
  const bridge = makeBridge({ items, subCalled })
  const payload = await bridge.buildMobileBoot()
  assert.equal(subCalled.called, false, '子代理行没有尾巴可读，不许被请求')
  assert.equal(typeof payload.stageSummary.messages, 'number', '有子代理行不该把这一格一起拖成留白')
  assert.equal(payload.tails.sub1, undefined)
})

test('M1 整包：可见行超过上限时留白（超 30 才有资格留白）', async () => {
  const items = rows(TAILS_MAX_SESSIONS + 1)
  const bridge = makeBridge({ items })
  const payload = await bridge.buildMobileBoot()
  assert.equal(payload.stageSummary.messages, null, '截断的一批不给数')
})