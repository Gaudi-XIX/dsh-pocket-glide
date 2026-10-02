// Coverage for m10822: a desktop turn that ends abnormally must surface on the
// phone. visibleMessages() is browser-script code inlined via a template
// literal, so it is not a module export. The test extracts the real function
// source (with its two helpers) from pages.js and runs it in a vm context that
// supplies the page-global `L` labels exactly as the browser page does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../lib/pages.js', import.meta.url)), 'utf8')

function between(startAnchor, endAnchor) {
  const start = source.indexOf(startAnchor)
  const end = source.indexOf(endAnchor, start)
  assert.notEqual(start, -1, `anchor ${startAnchor} must exist in pages.js`)
  assert.notEqual(end, -1, `anchor ${endAnchor} must exist in pages.js`)
  return source.slice(start, end)
}

const code = [
  between('function stepKey(d)', 'function contentBlocks(content)'),
  between('function contentBlocks(content)', 'function visibleMessages(events)'),
  between('function visibleMessages(events)', 'function inlineMarkdown(text)'),
].join('\n')

const L = {
  turnError: '运行出错',
  turnAborted: '已取消',
  turnBlocked: '被拦截，未能执行',
  turnMaxTokens: '已达到长度上限',
  turnInterrupted: '被打断',
}

const context = vm.createContext({ L })
const visibleMessages = vm.runInContext(`${code}\n;visibleMessages`, context)

function endEvent(reason) {
  return { event: { type: 'turn/end', turn: 1, data: { reason } } }
}

function expectBlock(block, kind, label, detail) {
  assert.equal(block.kind, kind)
  assert.equal(block.label, label)
  assert.equal(block.detail, detail)
}

test('turn/end with an LlmFailure projects a turn-error bubble with the message', () => {
  const messages = visibleMessages([
    endEvent({ kind: 'error', error: { message: 'Provider rate limit', code: 'rate_limit' } }),
  ])
  const error = messages.find((message) => message.role === 'turn-error')
  assert(error, 'a turn-error message must be projected')
  assert.equal(error.blocks.length, 1)
  expectBlock(error.blocks[0], 'turn-error', '运行出错', 'Provider rate limit')
})

test('turn/end error without a message falls back to the failure code', () => {
  const messages = visibleMessages([endEvent({ kind: 'error', error: { code: 'offline_503' } })])
  assert.equal(messages.at(-1).blocks[0].detail, 'offline_503')
})

test('aborted turns show the cancel reason', () => {
  const messages = visibleMessages([
    endEvent({ kind: 'aborted', reason: { message: 'user pressed stop' } }),
  ])
  expectBlock(messages.at(-1).blocks[0], 'turn-error', '已取消', 'user pressed stop')
})

test('blocked, max-tokens and interrupted turns each get their label', () => {
  for (const [kind, label] of [
    ['blocked', '被拦截，未能执行'],
    ['max-tokens', '已达到长度上限'],
    ['interrupted', '被打断'],
  ]) {
    const messages = visibleMessages([endEvent({ kind })])
    const block = messages.at(-1).blocks[0]
    assert.equal(block.kind, 'turn-error')
    assert.equal(block.label, label)
    assert.equal(block.detail, '')
  }
})

test('completed and forked turns produce no error bubble', () => {
  for (const reason of [{ kind: 'completed' }, { kind: 'forked' }]) {
    const messages = visibleMessages([endEvent(reason)])
    assert.equal(
      messages.some((message) => message.role === 'turn-error'),
      false,
      `${reason.kind} must not look like an error`,
    )
  }
})

// WP-A2 (P0-C) non-regression pair. The disconnect work moved copies into the error
// line; it must not have touched the two things this file exists for — the turn-error
// bubble is still projected by visibleMessages, and the transport copies stay in
// #chatError rather than leaking into the transcript. A later worker who "simplifies"
// either half should see this go red.
test('the error line carries a dropped stream; the transcript still carries the turn failure', () => {
  // 1. The stream `failure` frame keeps its own surface and its own copy.
  const streamSlice = between(
    "source.addEventListener('failure'",
    'source.onerror',
  )
  assert.ok(streamSlice.includes("showError('chatError',{message:(frame.message||L.streamFailure)"), 'the failure frame still writes chatError')
  assert.ok(streamSlice.includes('important:true'), 'and is flagged so a clean poll cannot erase it')

  // 2. The transcript renderer never speaks for the transport.
  const renderer = source.slice(source.indexOf('function renderMessage('), source.indexOf('\n', source.indexOf('function renderMessage(')))
  assert.notEqual(renderer, '', 'the message renderer must still exist')
  for (const key of ['disconnectedRetry', 'streamDownTunnel', 'streamDownHost', 'streamDownBackground']) {
    assert.ok(!renderer.includes(`L.${key}`), `${key} must not be rendered into a message bubble`)
  }
  // Each disconnect label is read by exactly two places: the copy classifier and the
  // notice writer. Any third reader belongs to the transcript and must be argued for.
  for (const key of ['disconnectedRetry', 'streamDownTunnel', 'streamDownHost', 'streamDownBackground', 'statusConnected', 'statusDisconnected', 'statusReconnecting']) {
    const reads = [...source.matchAll(new RegExp(`L\\.${key}\\b`, 'g'))].length
    assert.ok(reads >= 1, `${key} must have a consumer, not just a definition`)
    assert.ok(reads <= 3, `${key} is read in ${reads} places; the transport copy needs at most three`)
  }

  // 3. visibleMessages is still the one projection point for turn failures.
  const messages = visibleMessages([
    endEvent({ kind: 'error', error: { message: 'Provider rate limit', code: 'rate_limit' } }),
  ])
  assert.equal(messages.at(-1).role, 'turn-error', 'the bubble survives the P0-C changes')
  assert.equal(messages.at(-1).blocks[0].detail, 'Provider rate limit', 'with its own detail')
})
