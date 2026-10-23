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
  between('function turnKeyOf(', 'function contentBlocks(content)'),
  between('function contentBlocks(content)', 'function visibleMessages(events)'),
  between('function visibleMessages(events)', 'function inlineMarkdown(text)'),
].join('\n')

const L = {
  turnError: '运行出错',
  turnAborted: '已取消',
  turnBlocked: '被拦截，未能执行',
  turnMaxTokens: '已达到长度上限',
  turnInterrupted: '被打断',
  retryFailed: '重试 {n} 次后失败：',
}

// 2026-10-21: visibleMessages now reads two page globals — the per-turn elapsed
// map (to stamp the clock line) and the retry-count map (to prefix the error
// bubble). The page always declares them; the vm context must too. The maps are
// held by name so a test can seed one the way noteLlmRetry would.
const turnElapsedByTurn = new Map()
const turnRetryMax = new Map()
const context = vm.createContext({ L, turnElapsedByTurn, turnRetryMax })
const visibleMessages = vm.runInContext(`${code}\n;visibleMessages`, context)

function endEvent(reason) {
  return { event: { type: 'turn/end', data: { turn: 1, reason } } }
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

// 2026-10-21 (user m00068): the desktop retries a doomed model call a few times
// before it gives up. The phone already receives llm/retry; noteLlmRetry parks
// the count for this turn, and the failure that finally lands must say how many
// attempts it took — otherwise a three-retry failure reads like an instant one.
test('a turn that failed after retries says how many it took', () => {
  turnRetryMax.set('1', 3)
  const messages = visibleMessages([
    endEvent({ kind: 'error', error: { message: 'Provider overloaded', code: 'overloaded' } }),
  ])
  const block = messages.at(-1).blocks[0]
  assert.equal(block.kind, 'turn-error')
  assert.equal(block.detail, '重试 3 次后失败：Provider overloaded', 'the retry count prefixes the provider message')
  assert.equal(turnRetryMax.has('1'), false, 'the count is spent — the next turn starts clean')
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
  assert.ok(streamSlice.includes("showError('chatError',{message:streamFailureCopy(frame)"), 'the failure frame still writes chatError')
  assert.ok(streamSlice.includes('important:true'), 'and is flagged so a clean poll cannot erase it')
  // RC-7 moved the copy off the raw English frame.message and onto the bridge's
  // locale-free `reason`. Both halves of that contract are pinned so a later worker
  // cannot drop the reason table, nor drop the local-label fallback underneath it.
  const copyFn = between('function streamFailureCopy(frame){', 'function showError(id,error,fallback){')
  for (const key of ['L.streamFailBackoff', 'L.streamFailTransport', 'L.streamFailHost']) {
    assert.ok(copyFn.includes(key), `${key} must localize its own reason`)
  }
  assert.ok(copyFn.includes('||L.streamFailure'), 'an unknown reason still falls back to the local label')
  for (const key of ['streamFailBackoff', 'streamFailTransport', 'streamFailHost']) {
    assert.ok(source.includes(`,${key}:`), `${key} must have a label beside streamFailure`)
  }

  // 2. The transcript renderer never speaks for the transport.
  const renderer = source.slice(source.indexOf('function renderMessage('), source.indexOf('\n', source.indexOf('function renderMessage(')))
  assert.notEqual(renderer, '', 'the message renderer must still exist')
  for (const key of ['disconnectedRetry', 'streamDownTunnel', 'streamDownHost', 'streamDownFailed', 'streamDownBackground']) {
    assert.ok(!renderer.includes(`L.${key}`), `${key} must not be rendered into a message bubble`)
  }
  // Each disconnect label is read by exactly two places: the copy classifier and the
  // notice writer. Any third reader belongs to the transcript and must be argued for.
  // Gate follow (4.14, change 2026-10-07-fix-pocket-r2-pages-batch C3): aria-label
  // single-sourcing moved the two inline zh/en ternaries onto L.status*, so each
  // status key grew exactly two aria readers on top of its setStatusCopy readers
  // (measured at this change: 5 / 4 / 2). Transport copy caps stay at three.
  // 2026-10-07-fix-pocket-banner-dismiss-and-ttl: dismissing the banner or letting its
  // 90s deadline fire restores the connected label, because the standing notice is what
  // put the light into "reconnecting" — that is one more statusConnected reader (6).
  // 2026-10-23: showError names the slow-desktop tier (L.streamDownHost) when the stream
  // is still delivering frames; the same review split the failed-request copy onto its own
  // key (L.streamDownFailed, rpcFailure only) because "still waiting" is a lie once the
  // request already died. Neither is ever the transcript's word for a turn failure.
  const readerCaps = { statusConnected: 6, statusDisconnected: 4, statusReconnecting: 3 }
  for (const key of ['disconnectedRetry', 'streamDownTunnel', 'streamDownHost', 'streamDownFailed', 'streamDownBackground', 'statusConnected', 'statusDisconnected', 'statusReconnecting']) {
    const reads = [...source.matchAll(new RegExp(`L\\.${key}\\b`, 'g'))].length
    const cap = readerCaps[key] ?? 3
    assert.ok(reads >= 1, `${key} must have a consumer, not just a definition`)
    assert.ok(reads <= cap, `${key} is read in ${reads} places; the transport copy needs at most ${cap}`)
  }

  // 3. visibleMessages is still the one projection point for turn failures.
  const messages = visibleMessages([
    endEvent({ kind: 'error', error: { message: 'Provider rate limit', code: 'rate_limit' } }),
  ])
  assert.equal(messages.at(-1).role, 'turn-error', 'the bubble survives the P0-C changes')
  assert.equal(messages.at(-1).blocks[0].detail, 'Provider rate limit', 'with its own detail')
})
