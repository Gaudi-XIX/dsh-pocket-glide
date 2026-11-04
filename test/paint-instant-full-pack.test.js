// 首帧「已装内容」必须一次画全 —— 红先回归测试（修复前必失败）
//
// 缺陷（2026-11-04 验收方定位）：lib/pages.js 的 paintInstantHistory 先调 measureRows 量出
// 「够 1.15 屏」的尾部行数 fit，再 paintMessages(box, messages.slice(-fit), …)。预读尾巴包
// 已把 4 个 user/assistant 单位装进内存，页侧却只画尾部够一屏的那几行——已装但未画。
// 实测：四个预读会话包内 units = 4/4/2/2，点开静默后屏幕 .message 只有 2/2/1/2。
//
// 本测试钉的行为（不是钉实现）：
//   ① 首帧画出的 .message 节点数 == 已装单位数，哪怕尾部单行渲染高已超 clientHeight*1.15；
//   ② 同一已装集合再画一次，节点数不减少（重画只增不减）；
//   ③ measureRows 保留，且仍被 qj（够不够一屏 → 补不补拉）消费。
//
// 画法是「一条消息 = 一个 .message 节点」，这条契约由出货页 paintMessages 承担并在
// test/boot-handoff-stream.test.js 的 R4.4 钉住；这里用一个等价的一行替身承接该契约，
// 好让断言落在 DOM 节点数上，而不是落在「函数收了几个参数」上。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mobilePageAssets } from '../lib/pages.js'

const js = mobilePageAssets({ locale: 'zh' }).js

/** 从出货 js 按名字切一个同步函数（纯大括号配平，与 test/boot-handoff-stream.test.js 同一范式）。 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must be declared in the shipped landing page js`)
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  assert.fail(`unbalanced braces after ${name}`)
}

const body = extractFunction(js, 'paintInstantHistory')

/**
 * 把 paintInstantHistory 装进一个只补壳级绑定的沙箱。
 * measureRows 由调用方给出（模拟视口：返回值就是「尾部几行够 1.15 屏」）；
 * paintMessages 用一行替身承接「一条消息 = 一个 .message 节点」，写进 fake box。
 */
function sandbox({ measureRows }) {
  const box = { innerHTML: '', clientHeight: 844 }
  const paints = []
  const shim = [
    'let sessionBlank = false',
    'let streamConnected = true',
    'let agentRunning = false',
    'let pendingQuestion = null',
    'let currentTodos = []',
    'let todoExpanded = false',
    'let lastHistoryKey = ""',
    'let messages = []',
    'const L = {}',
    'const updateRunning = () => {}',
    'const updateTodos = () => {}',
    'const updateGoal = () => {}',
    'const updateQueue = () => {}',
    'const updateSubagents = () => {}',
    'const syncSettingsControls = () => {}',
    'const showSessionModel = () => {}',
    'const modelSelectionOf = () => null',
    'const messagesWithOptimistic = (durable) => durable',
  ].join('\n')
  const deps = {
    box,
    paints,
    visibleMessages: () => box.installed,
    measureRows,
    paintMessages: (target, list) => {
      paints.push(list.length)
      target.innerHTML = list.map((item) => `<div class="message">${item.text}</div>`).join('')
    },
  }
  const factory = new Function(
    'deps',
    `const { visibleMessages, measureRows, paintMessages, box } = deps\nconst $ = () => box\n${shim}\n${body}\nreturn paintInstantHistory`,
  )
  return { box, paints, paint: (installed) => {
    box.installed = installed
    factory(deps)([], null)
    return (box.innerHTML.match(/class="message"/g) ?? []).length
  } }
}

/** 已装集合：四个 user/assistant 单位（对应预读包 units=4/4/2/2 里的一个会话）。 */
const installed = [
  { role: 'assistant', text: 'tool 7/7 complete. Now final checks' },
  { role: 'assistant', text: '全流程走完，7/7 stage 全部完成' },
  { role: 'assistant', text: 'presented' },
  { role: 'assistant', text: '第七格也画出来了吗' },
]

test('an installed pack paints every unit on the first frame, even when the tail row alone already covers the screen', () => {
  // measureRows 返回 1 = 「尾部单行渲染高已超过 clientHeight*1.15」——正是实测里
  // db2080ab 那个会话的形状（包内 4 单位，屏幕上只剩 2）。
  const { paint } = sandbox({ measureRows: () => 1 })
  assert.equal(paint(installed), installed.length, '已装 4 条就必须画出 4 个 .message，而不是够一屏的尾部几条')
})

test('a pack whose rows are short is painted whole too', () => {
  // measureRows 返回 4 = 四行都不够一屏。修复前后都画 4；钉住「不同视口高度不改变画全」。
  const { paint } = sandbox({ measureRows: () => 4 })
  assert.equal(paint(installed), installed.length, '够不够一屏只决定补不补拉，不决定画不画')
})

test('a repaint of the same installed set never shrinks the transcript', () => {
  const { paints, paint } = sandbox({ measureRows: () => 1 })
  assert.equal(paint(installed), 4, 'first frame')
  assert.equal(paint(installed), 4, 'second frame')
  assert.equal(paint(installed), 4, 'third frame')
  // 首帧与后续帧画的是同一份已装集合：只增不减，不会「打开时 4 条、重画后 2 条」。
  assert.deepEqual(paints, [4, 4, 4], 'every paint carries the whole installed set')
})

test('a repaint that pulls older rows upward only grows the painted set', () => {
  // 用户判据 2 的正面：后续重画「只能增（向上补旧）不能减」。
  // 已装 4 条 → 内层 setHistory 把更早 2 条并进已装集合（6 条）→ 第二帧必须画 6，且不回缩。
  const older = [
    { role: 'user', text: '第六格：先看一眼卡面' },
    { role: 'assistant', text: '第六格完成' },
  ]
  const { paints, paint } = sandbox({ measureRows: () => 1 })
  assert.equal(paint(installed), 4, 'first frame paints the installed 4')
  assert.equal(paint(older.concat(installed)), 6, 'after topping up with older rows, the repaint paints 6')
  assert.deepEqual(paints, [4, 6], 'repaint only adds, never subtracts')
  // 旧实现两条都必红：measureRows→1 时它只画尾部 1 条（1 ≠ 4、1 ≠ 6）。
})

test('measureRows survives and still answers the "is one screen full?" question', () => {
  // 用户明令：measureRows 保留，只用于 qj / ensureTranscriptFilled 的补拉判断。
  const measure = extractFunction(js, 'measureRows')
  assert.match(measure, /1\.15/, 'the screen threshold lives in measureRows')
  const qj = extractFunction(js, 'qj')
  assert.match(qj, /measureRows\(/, 'qj is the consumer that decides whether to fetch more')

  // 反面：裁剪用量必须消失——已装的实现细节（fit / slice(-fit)）不许再出现在这个函数里。
  assert.ok(!body.includes('slice(-fit'), 'paintInstantHistory must not truncate installed rows by viewport height')
  assert.match(body, /paintMessages\(box, messages, \{/, 'it hands the whole installed set to the paint')
})