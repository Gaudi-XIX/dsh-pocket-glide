// 输入栏按键行为：Enter 换行、只有箭头发送（用户 2026-10-11 定死口径：「换行就是换行，
// 发送只点箭头」）。
//
// 复现的现象：手机上点「换行」变成了发送。根因在 keydown 处理器——
//   if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();send()}
// 它排除掉了输入法合成态，但排除不掉软键盘的 return 键：Android 把那个键报成
// key==='Enter' 且 shiftKey===false，与硬件 Enter 在事件字段上完全同形。于是「凡是
// Enter 就发送」这条判据在手机上必然把换行也吃掉。
//
// 现在处理器对 Enter 什么都不做（除了埋点），于是 textarea 的原生行为生效：插入换行。
// 本文件把这条钉成可复跑的行为断言，而不是只读源码文本——「没有 preventDefault」
// 是手段，「换行真的进去了、发送真的没被调用」才是判据。
//
// house pattern 见 question-no-gesture-no-submit.test.js 头部：把真实 handler 文本抽进沙箱。
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

const KEYDOWN = slice(js, "$('prompt').onkeydown=", "$('back').onclick=")

/**
 * Run the REAL prompt keydown handler over a REAL textarea, in a sandbox where
 * `send` is a spy. The textarea is a plain object that mimics the two things the
 * handler and the browser's default action touch: `value` and the selection range.
 * @param {{value?: string, selectionStart?: number, selectionEnd?: number}} initial
 */
function build(initial = {}) {
  const sent = []
  const prompt = {
    value: initial.value ?? '',
    selectionStart: initial.selectionStart ?? (initial.value ?? '').length,
    selectionEnd: initial.selectionEnd ?? (initial.value ?? '').length,
    style: {},
    scrollHeight: 40,
  }
  const make = new Function(
    'box', 'send', 'slashMenuKeydown', 'probeMark', 'syncPromptUi', 'refreshSlashMenu',
    `
    const $=(id)=>box[id]
    const handler=${KEYDOWN.replace("$('prompt').onkeydown=", '')}
    return { handler };
    `
  )
  const api = make(
    { prompt, send: { hidden: false, disabled: false }, cancel: { hidden: true, disabled: false } },
    () => sent.push('send'),
    () => false,
    () => {},
    () => {},
    () => {},
  )
  // The default action a browser performs for a keydown the handler did not cancel:
  // a textarea inserts the typed character. Model it explicitly so the test asserts
  // the OUTCOME (a newline lands in the box) and not merely that preventDefault was
  // skipped — a handler that called preventDefault would leave this step unrun.
  const press = (event) => {
    const handled = api.handler(event)
    const cancelled = event.defaultPrevented === true || handled === true
    if (!cancelled && event.key === 'Enter') {
      prompt.value = prompt.value.slice(0, prompt.selectionStart) + '\n' + prompt.value.slice(prompt.selectionEnd)
      prompt.selectionStart = prompt.selectionEnd = prompt.selectionStart + 1
    }
    return { cancelled, sent: sent.slice() }
  }
  return { press, prompt, sent }
}

/** A keydown event shaped the way each keyboard actually reports it. */
function keydown(key, extra = {}) {
  return { key, shiftKey: false, isComposing: false, keyCode: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...extra }
}

test('B-4: a soft-keyboard return inserts a newline and never sends', () => {
  // Android reports the return key exactly like this — that is the whole bug.
  const page = build({ value: '第一行' })
  const result = page.press(keydown('Enter'))
  assert.equal(page.prompt.value, '第一行\n', 'the newline is in the box')
  assert.deepEqual(result.sent, [], 'and nothing was sent')
  assert.equal(result.cancelled, false, 'the handler must not cancel the default insert')
})

test('B-4: Enter mid-text splits at the caret, not at the end', () => {
  const page = build({ value: 'abcd', selectionStart: 2, selectionEnd: 2 })
  page.press(keydown('Enter'))
  assert.equal(page.prompt.value, 'ab\ncd', 'the caret position decides where the break lands')
  assert.equal(page.prompt.selectionStart, 3, 'and the caret follows the newline')
})

test('B-4: shift+Enter is a newline too, and still not a send', () => {
  const page = build({ value: 'x' })
  const result = page.press(keydown('Enter', { shiftKey: true }))
  assert.equal(page.prompt.value, 'x\n', 'shift does not change what Enter means now')
  assert.deepEqual(result.sent, [], 'no send on any Enter variant')
})

test('B-4: an Enter that closes the slash menu picks a row and does not insert a newline', () => {
  // The slash menu consumes Enter before the composer sees it. That path must keep
  // working — the fix removes the send, not the menu.
  const sent = []
  const prompt = { value: '/mod', selectionStart: 4, selectionEnd: 4, style: {}, scrollHeight: 40 }
  const picked = []
  const make = new Function(
    'box', 'send', 'slashMenuKeydown', 'probeMark', 'syncPromptUi', 'refreshSlashMenu', 'picked',
    `
    const $=(id)=>box[id]
    const handler=${KEYDOWN.replace("$('prompt').onkeydown=", '')}
    return { handler };
    `
  )
  const api = make(
    { prompt, send: {}, cancel: {} },
    () => sent.push('send'),
    (event) => { if (event.key === 'Enter') { event.preventDefault(); picked.push('row'); return true } return false },
    () => {},
    () => {},
    () => {},
    picked,
  )
  const event = keydown('Enter')
  api.handler(event)
  assert.deepEqual(picked, ['row'], 'the menu still gets first refusal on Enter')
  assert.equal(event.defaultPrevented, true, 'and the menu cancels the insert itself')
  assert.equal(prompt.value, '/mod', 'no newline was added by the composer')
  assert.deepEqual(sent, [], 'still no send')
})

test('B-4: no Enter path in the shipped handler can reach send', () => {
  // Belt and braces on the source itself: the handler text must not mention send at
  // all. A future edit that re-adds `send()` on Enter fails here even if the
  // behaviour tests above were loosened to match.
  assert.ok(!/\bsend\(/.test(KEYDOWN), 'the prompt keydown handler must not call send()')
  assert.ok(!/preventDefault/.test(KEYDOWN), 'and must not cancel Enter, or the textarea cannot insert')
})
