// The optimistic echo retires on a fingerprint, not on words alone — WHITE-BOX
// (extract the page functions and run them against synthetic event frames).
//
// Live report 2026-10-20: two photo-only prompts sent in one turn. A photo-only
// prompt carries no words at all, so a words-only comparison makes every such send
// the same send: a durable copy that declares a different number of images — or no
// attachment at all — retired an echo it did not belong to, before that echo's own
// copy had landed.
//
// This file also runs against a pre-fix shell on purpose: when the page has no
// promptShape() yet, the sandbox substitutes the old words-only fingerprint, so
// these cases fail on behaviour instead of on a missing symbol.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

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

function buildSandbox() {
  const { js } = mobilePageAssets({ locale: 'zh' })
  const shapeAware = js.includes('function promptShape(')
  const names = ['durableUserPromptText', 'messagesWithOptimistic']
  if (shapeAware) names.push('promptShape')
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  const fallback = shapeAware ? '' : 'function promptShape(message){return durableUserPromptText(message)}'
  return new Function(
    `let lastDurableMessages=[],optimisticPrompts=[];
     const processBlocks=()=>[];
     const L={};
     ${body}
     ${fallback}
     return {
       messagesWithOptimistic,
       setOptimistic(value){optimisticPrompts=value},
       kept(){return optimisticPrompts.map(item=>item.id)},
     }`,
  )()
}

const userText = (seq, text) => ({ role: 'user', _seq: seq, blocks: [{ kind: 'text', text }] })
const assistantText = (seq, text) => ({ role: 'assistant', _seq: seq, blocks: [{ kind: 'text', text }] })
const images = (seq, count) => ({ role: 'user', _seq: seq, blocks: Array.from({ length: count }, () => ({ kind: 'image', attachmentId: 'a' + seq })) })
const emptyText = (seq) => ({ role: 'user', _seq: seq, blocks: [{ kind: 'text', text: '' }] })
const fileOnly = (seq) => ({ role: 'user', _seq: seq, blocks: [{ kind: 'file', receiptId: 'r' + seq }] })
const textAndImages = (seq, text, count) => ({ role: 'user', _seq: seq, blocks: [{ kind: 'text', text }, ...Array.from({ length: count }, () => ({ kind: 'image', attachmentId: 'x' + seq }))] })

// What the transcript already holds when the send below goes out.
const settled = [userText(1, '你好'), assistantText(2, '答'), userText(3, '<relevant-memories>…')]

const photoEcho = (id) => ({ id, text: '', chips: ['1 图片'], sameTextAtSend: 0, afterSeq: 3, queued: false })

test('R2 a durable copy with a different image count does not retire the echo', () => {
  const sandbox = buildSandbox()
  sandbox.setOptimistic([photoEcho('a')])
  // The phone sent one photo; what lands here is somebody else's two-photo prompt.
  const rendered = sandbox.messagesWithOptimistic([...settled, images(4, 2)])
  assert.equal(rendered.filter((message) => message.optimistic).length, 1, 'the echo is still on screen')
  assert.deepEqual(sandbox.kept(), ['a'])
})

test('R2 a durable message with no attachments does not retire a photo echo', () => {
  const sandbox = buildSandbox()
  sandbox.setOptimistic([photoEcho('a')])
  // Same empty words, nothing attached: not this send.
  const rendered = sandbox.messagesWithOptimistic([...settled, emptyText(4)])
  assert.equal(rendered.filter((message) => message.optimistic).length, 1, 'the echo is still on screen')
  assert.deepEqual(sandbox.kept(), ['a'])
})

test('R2 a durable photo does not retire a file-only echo', () => {
  const sandbox = buildSandbox()
  sandbox.setOptimistic([{ id: 'f', text: '', chips: ['1 文件'], sameTextAtSend: 0, afterSeq: 3, queued: false }])
  // The mirror image of the case above: both sends are wordless, only one of them
  // is an image, and the image/file split in the fingerprint is what tells them apart.
  const rendered = sandbox.messagesWithOptimistic([...settled, images(4, 1)])
  assert.equal(rendered.filter((message) => message.optimistic).length, 1, 'the echo is still on screen')
  assert.deepEqual(sandbox.kept(), ['f'])
  const photosOnly = buildSandbox()
  photosOnly.setOptimistic([{ id: 'f2', text: '', chips: ['1 文件'], sameTextAtSend: 0, afterSeq: 3, queued: false }])
  photosOnly.messagesWithOptimistic([...settled, fileOnly(4)])
  assert.deepEqual(photosOnly.kept(), [], 'its own file copy still retires it')
})

test('R2 the echo still retires once its own durable copy lands', () => {
  const sandbox = buildSandbox()
  sandbox.setOptimistic([{ id: 'd', text: '看图', chips: ['1 图片'], sameTextAtSend: 0, afterSeq: 3, queued: false }])
  const rendered = sandbox.messagesWithOptimistic([...settled, textAndImages(4, '看图', 1)])
  assert.equal(rendered.filter((message) => message.optimistic).length, 0, 'the durable copy replaces the echo')
  assert.deepEqual(sandbox.kept(), [], 'and nothing is left pending')
  assert.equal(rendered.length, 4, 'the transcript is exactly the durable rows')
})

test('R2 a run of frames never flips one echo between kept and retired', () => {
  const sandbox = buildSandbox()
  sandbox.setOptimistic([photoEcho('a')])
  // Frame by frame, the way the page paints: nothing new, then a wordless lookalike
  // with no photo, then this send's own copy, then one more row.
  const frames = [
    settled,
    [...settled, fileOnly(4)],
    [...settled, fileOnly(4), images(5, 1)],
    [...settled, fileOnly(4), images(5, 1), assistantText(6, '收到')],
  ]
  const decisions = frames.map((durable) => {
    const drawn = sandbox.messagesWithOptimistic(durable).filter((message) => message.optimistic).length
    return drawn === 1 ? 'kept' : 'retired'
  })
  assert.deepEqual(decisions, ['kept', 'kept', 'retired', 'retired'], 'retirement is one-way and happens exactly once')
  const everRetired = decisions.indexOf('retired')
  assert.ok(!decisions.slice(everRetired).includes('kept'), 'a retired echo never comes back')
})

test('R2 two same-shape photo echoes are both retired by the first copy — the known limit', () => {
  const sandbox = buildSandbox()
  // Two one-photo sends, both wordless: identical fingerprints, so the first durable
  // copy that lands cannot be attributed to either of them and retires both. This is
  // the measured behaviour of the user's 2026-10-20 report and it is why the blinking
  // they described has to be chased somewhere other than this test (see CHANGELOG
  // 0.4.53: the transcript is rebuilt whole on every stream record).
  sandbox.setOptimistic([{ id: 'a', text: '', chips: ['1 图片'], sameTextAtSend: 0, afterSeq: 3, queued: false }, { id: 'b', text: '', chips: ['1 图片'], sameTextAtSend: 1, afterSeq: 3, queued: true }])
  const first = sandbox.messagesWithOptimistic([...settled, images(4, 1)])
  assert.deepEqual(sandbox.kept(), [], 'the first copy takes both echoes')
  assert.equal(first.filter((message) => message.optimistic).length, 0)
})
