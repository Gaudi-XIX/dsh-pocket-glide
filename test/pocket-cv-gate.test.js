// P2-2 开关（卡 2026-10-24-pocket-mobile-interaction / T5）。
//
// 只钉 `CV_ON` + `applyContentVisibility` 这两个器官的真行为，做法沿用本仓既有范式：
// 从渲染出的壳里按名抽出函数/表达式，塞进 `new Function` 沙箱（不引入 jsdom）。
// 沙箱 stub：location.search、localStorage、CSS.supports、$('messages') 的 classList、
// probeMark（计数）。为什么值得单测：这开关最坏的失败是「静默不生效」——老 iOS 忽略
// content-visibility 时会得到 N1≈N0，看起来「有效且无摆动」，正是要防的假绿。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const js = mobilePageAssets({ locale: 'zh' }).js

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the rendered asset`)
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${name}`)
}

// `const CV_ON=…;` 是表达式而不是函数，按行抽（壳里只此一处）。
function cvOnExpression() {
  const line = js.split('\n').find((row) => row.startsWith('const CV_ON='))
  assert.ok(line, 'CV_ON must exist in the rendered asset')
  return line.replace(/^const CV_ON=/, '').replace(/;$/, '')
}

function runGate({ search = '', supports = true, hasBox = true, stored = null } = {}) {
  const writes = []
  const marks = []
  const classes = []
  const store = new Map(stored === null ? [] : [['pocketCv', String(stored)]])
  const box = hasBox
    ? {
        classList: {
          add: (name) => classes.push(name),
        },
      }
    : null
  const sandbox = new Function(
    'location',
    'localStorage',
    'CSS',
    'probeMark',
    '$',
    `${extract(js, 'applyContentVisibility')}
     const CV_ON=${cvOnExpression()}
     return { applyContentVisibility, CV_ON }`
  )
  const api = sandbox(
    { search },
    {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => {
        writes.push([key, value])
        store.set(key, String(value))
      },
    },
    { supports: () => supports },
    (tag) => marks.push(tag),
    (id) => {
      assert.equal(id, 'messages', '只对 #messages 挂类')
      return box
    }
  )
  api.applyContentVisibility()
  return { classes, writes, marks, CV_ON: api.CV_ON }
}

test('?cv=1 mounts the gate and writes the 6h credential; nothing else does', () => {
  const opened = runGate({ search: '?cv=1' })
  assert.deepEqual(opened.classes, ['cv'], '?cv=1 ⇒ 挂 .cv')
  assert.equal(opened.writes.length, 1, '凭据只写一次')
  const [key, value] = opened.writes[0]
  assert.equal(key, 'pocketCv')
  assert.ok(Number(value) > Date.now() + 215e5, '凭据 6h（216e5）到期')

  const plain = runGate({ search: '' })
  assert.deepEqual(plain.classes, [], '默认不挂')
  assert.equal(plain.writes.length, 0)

  const forcedOff = runGate({ search: '?cv=1&cv=0' })
  assert.deepEqual(forcedOff.classes, [], '?cv=0 优先级最高：不挂类也不发凭据')
  assert.equal(forcedOff.writes.length, 0)
})

test('a 6h credential keeps the gate open after standalone launch drops the query', () => {
  const kept = runGate({ search: '', stored: Date.now() + 36e5 })
  assert.deepEqual(kept.classes, ['cv'], '凭据未过期 ⇒ 仍然挂')
  const expired = runGate({ search: '', stored: Date.now() - 1 })
  assert.deepEqual(expired.classes, [], '凭据过期 ⇒ 回到默认关')
  const garbage = runGate({ search: '', stored: 'soon' })
  assert.deepEqual(garbage.classes, [], '凭据是垃圾 ⇒ 当成没开（+NaN 不是有效的未来）')
})

test('an engine without content-visibility is reported, not silently believed', () => {
  const unsupported = runGate({ search: '?cv=1', supports: false })
  assert.deepEqual(unsupported.classes, [], 'CSS.supports=false ⇒ 不挂 .cv')
  assert.deepEqual(unsupported.marks, ['cvna'], '必须打 cvna（RC1 见到 cvna 本轮作废）')
  assert.equal(unsupported.writes.length, 1, '已经请求过还是要记凭据（否则每次冷开都重来）')
})

test('before a conversation is open there is no #messages and the gate stays quiet', () => {
  const early = runGate({ search: '?cv=1', hasBox: false })
  assert.deepEqual(early.classes, [], '没有容器就不挂（进会话前会走到这条）')
  assert.deepEqual(early.marks, [], '没有容器不算引擎不支持，不打 cvna')
})
