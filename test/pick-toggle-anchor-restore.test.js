// 两个 B 系 bug 的行为断言（复跑判据是行为，不是源码文本）。
//
// 1) 设置面板自绘列表「点了收不回」。根因在 togglePickField：第二次点同一字段时
//    settingsPick 已被清空，但循环体拿传进来的 field 做比较，等于把面板按「打开」
//    重写一遍——所以从 0.4.14 自绘列表落地起，关闭分支从未真正执行过。现在循环比对的
//    是 settingsPick（当前值），不是 field（本次点击值）。
// 2) 停在会话中上部阅读时，AI 推进来屏幕「抖一下就扯过去」。根因在 restoreTranscriptAnchor
//    的 Math.min(anchor.index, rows.length-1)：列表正在重渲、行数少于锚点记录时，索引被钳
//    到末行，拿一个和锚点毫无关系的行当基准写 scrollTop。真机取证（kbprobe，2026-10-11
//    19:47）：rs@19930 把 scrollTop 写到 188，当时真实位置 1151；120ms 后 rs@20050 写到 969，
//    写入瞬间 scrollHeight 只有 2274/3401，真实内容 3562+。现在行数不够就跳过这次写入，
//    交 120ms 重试等布局稳定，绝不照错行写。
//
// house pattern 见 question-no-gesture-no-submit.test.js 头部：把真实函数文本抽进沙箱跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })

function slice(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle)
  assert.notEqual(start, -1, `${startNeedle} must exist in the rendered asset`)
  const end = source.indexOf(endNeedle, start)
  assert.notEqual(end, -1, `${endNeedle} must follow ${startNeedle}`)
  return source.slice(start, end)
}

// ─── 1) togglePickField ────────────────────────────────────────────────

const TOGGLE = slice(js, 'function togglePickField(field){', 'function applyPick(field,value)')

function buildToggle() {
  const pickModel = { dataset: { pick: 'model' }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v } }
  const listModel = { dataset: { field: 'model' }, hidden: true }
  const pickPreset = { dataset: { pick: 'preset' }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v } }
  const listPreset = { dataset: { field: 'preset' }, hidden: true }
  const all = [pickModel, listModel, pickPreset, listPreset]
  const box = { querySelectorAll(sel) { return sel === '[data-pick],[data-field]' ? all : [] } }
  const make = new Function('$', `let settingsPick='';${TOGGLE};return {togglePickField,peek:()=>settingsPick}`)
  const api = make(() => box)
  return { ...api, pickModel, listModel, pickPreset, listPreset }
}

test('pick toggle: 再点一次同一字段把面板收回去', () => {
  const t = buildToggle()
  t.togglePickField('model')
  assert.equal(t.peek(), 'model')
  assert.equal(t.pickModel.attrs['aria-expanded'], true)
  assert.equal(t.listModel.hidden, false)
  t.togglePickField('model')
  assert.equal(t.peek(), '')
  assert.equal(t.pickModel.attrs['aria-expanded'], false)
  assert.equal(t.listModel.hidden, true)
})

test('pick toggle: 点开另一个字段时原来的收回去', () => {
  const t = buildToggle()
  t.togglePickField('model')
  t.togglePickField('preset')
  assert.equal(t.peek(), 'preset')
  assert.equal(t.pickModel.attrs['aria-expanded'], false)
  assert.equal(t.listModel.hidden, true)
  assert.equal(t.pickPreset.attrs['aria-expanded'], true)
  assert.equal(t.listPreset.hidden, false)
})

// ─── 2) restoreTranscriptAnchor ────────────────────────────────────────

const RESTORE = slice(js, 'function restoreTranscriptAnchor(box,anchor,tries){', '// 键盘收/放')

function buildRestore(rows, boxTop = 0) {
  const marks = []
  const box = {
    scrollTop: 100,
    querySelectorAll() { return rows },
    getBoundingClientRect() { return { top: boxTop } },
  }
  const make = new Function('$', 'probeMark', 'followStream', 'setTimeout', `${RESTORE};return restoreTranscriptAnchor`)
  // tries 传 0，重试链不进 setTimeout，测的就是当下这一次写入决策。
  const restore = make(() => ({ isConnected: true }), (tag) => marks.push(tag), false, () => {})
  return { restore, box, marks }
}

const row = (top) => ({ getBoundingClientRect: () => ({ top }) })

test('anchor restore: 行数少于锚点记录时不写 scrollTop（重渲中间态）', () => {
  const { restore, box, marks } = buildRestore([row(10), row(50), row(90)])
  const ok = restore(box, { index: 5, offset: 50 }, 0)
  assert.equal(ok, true)
  assert.equal(box.scrollTop, 100)
  assert.deepEqual(marks, [])
})

test('anchor restore: 锚点行还在且已偏离时照常回写', () => {
  const { restore, box, marks } = buildRestore([row(10), row(200), row(320)])
  restore(box, { index: 1, offset: 50 }, 0) // delta = 200-0-50 = 150
  assert.equal(box.scrollTop, 250)
  assert.deepEqual(marks, ['rs'])
})

test('anchor restore: 锚点行已对齐时不写', () => {
  const { restore, box, marks } = buildRestore([row(10), row(50), row(90)])
  restore(box, { index: 1, offset: 50 }, 0) // delta = 50-0-50 = 0
  assert.equal(box.scrollTop, 100)
  assert.deepEqual(marks, [])
})
