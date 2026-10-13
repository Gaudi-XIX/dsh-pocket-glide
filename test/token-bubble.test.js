// The instant reply bubble (tokenStream) only takes ANSWER text. The host's
// assistant-stream chunks are typed — text-delta / reasoning-delta /
// tool-call-delta / usage … (the dsh-client-ui-chat isTokenDelta vocabulary,
// read from the shipped bundle 2026-10-13) — and tokenChunkText used to grab
// `.text` off ANY of them, so every reasoning-delta painted the raw chain of
// thought as a plain message bubble that retracted at turn end (live report
// 2026-10-13: the leaked text exists on no durable session record — all 388
// session stores scanned, zero hits — it is phone-side only). The gate lives
// in tokenChunkText; these tests splice the REAL function out of the rendered
// asset, block-placeholder.test.js precedent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const js = mobilePageAssets({ locale: 'zh' }).js

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

const tokenChunkText = new Function(`return ${extractFunction(js, 'tokenChunkText')}`)()

test('the bubble takes answer deltas and the legacy bare-string shape', () => {
  assert.equal(tokenChunkText({ type: 'text-delta', index: 3, text: '答' }), '答')
  assert.equal(tokenChunkText('裸字符串'), '裸字符串', 'the legacy bare-string chunk still lands')
  assert.equal(tokenChunkText({ text: '无类型旧形状' }), '无类型旧形状', 'untyped objects keep the legacy tolerance')
})

test('reasoning deltas never reach the bubble — they own the process fold', () => {
  assert.equal(tokenChunkText({ type: 'reasoning-delta', index: 0, text: 'Let me look at the host-side handler.' }), '', 'a reasoning-delta is not reply text')
  assert.equal(tokenChunkText({ type: 'reasoning-delta', index: 1, delta: '另一段思考' }), '', 'the delta key is gated the same as text')
})

test('non-prose chunk types stay out of the bubble too', () => {
  assert.equal(tokenChunkText({ type: 'tool-call-delta', name: 'read', argumentsDelta: '{"f"' }), '', 'tool-call deltas have their own cards')
  assert.equal(tokenChunkText({ type: 'usage', usage: {} }), '', 'usage carries no prose')
  assert.equal(tokenChunkText({ type: 'block-start', blockType: 'text' }), '', 'block framing is not text')
})
