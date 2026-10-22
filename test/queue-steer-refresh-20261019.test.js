// Three live reports from 2026-10-19, each fixed in the source it belongs to:
//
//   ① the desktop pairing page's "刷新" must rebuild the ephemeral tunnel — a
//      new *.trycloudflare.com domain, a new QR, a new link — instead of
//      re-drawing the tunnel that is already up (user: 「之前的刷新按钮，意思就是
//      重新手动重建一次临时的通道，二维码和链接都会刷新」);
//   ② "立刻发送" on a queued item showed the message in the transcript only after
//      the next realtime frame — up to 6s of tunnel poll backoff (user: 「点击排队
//      消息上方的"发送"后，显示出来的速度非常之慢」);
//   ③ a steered message was drawn at the very bottom of the transcript, below the
//      answer that was streaming when it was written (user screenshot: a 19:02
//      bubble under the 19:04 reply).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mobilePageAssets } from '../lib/pages.js'
import { startBridge, httpFetch } from './helpers.js'

// The refresh button lives on the desktop pairing page, whose body is shipped as
// a template literal inside lib/pages.js — same read the desktop tests use.
const PAGES_SOURCE = fs.readFileSync(new URL('../lib/pages.js', import.meta.url), 'utf8')

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

/** A tunnel seam that hands out a fresh domain per launch and counts the teardown. */
function countingTunnelSeam() {
  const calls = { launch: 0, stop: 0, urls: [] }
  return {
    calls,
    seam: {
      createCloudflareTunnel: async () => {
        calls.launch += 1
        const url = `https://rebuild-${calls.launch}.trycloudflare.com`
        calls.urls.push(url)
        return {
          url,
          provider: 'cloudflare',
          stop: async () => {
            calls.stop += 1
          },
          process: { once: () => {} },
        }
      },
    },
  }
}

// ---------------------------------------------------------------------------
// ① bridge: force rebuild
// ---------------------------------------------------------------------------

test('① refresh: force rebuilds a live tunnel and mints a new URL where a plain enable reuses it', async () => {
  const { calls, seam } = countingTunnelSeam()
  const t = await startBridge({ bridgeOptions: seam })
  try {
    const desktop = await t.pairDesktop()
    const post = (body) =>
      httpFetch(`${t.base}/desktop/tunnel/toggle`, {
        method: 'POST',
        headers: { Cookie: desktop, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    const first = await (await post({ enable: true })).json()
    assert.equal(first.active, true)
    assert.equal(calls.launch, 1, 'the first enable launches the carrier')

    const reused = await (await post({ enable: true })).json()
    assert.equal(calls.launch, 1, 'a plain enable still reuses the live tunnel')
    assert.equal(reused.pairingUrl, first.pairingUrl, 'so its link does not move')

    const rebuilt = await (await post({ enable: true, force: true })).json()
    assert.equal(calls.launch, 2, 'force launches a second carrier')
    assert.equal(calls.stop, 1, 'and the first one is stopped, not leaked')
    assert.equal(rebuilt.active, true)
    assert.notEqual(rebuilt.pairingUrl, first.pairingUrl, 'the phone is offered a new domain')
    assert.ok(rebuilt.qrSvg, 'and the QR is redrawn against it')
    assert.equal(t.bridge.tunnelActive, true)
  } finally {
    await t.stop()
  }
})

test('① refresh: a forced rebuild parks the handsets instead of signing them out', async () => {
  const { seam } = countingTunnelSeam()
  const t = await startBridge({ bridgeOptions: seam })
  try {
    const cookie = await t.pairMobile('PocketRebuild/1.0')
    const token = cookie.split('=')[1]
    await t.bridge.toggleTunnel(true)
    assert.equal(t.bridge.sessions.has(token), true, 'the phone is live on the first tunnel')

    await t.bridge.toggleTunnel(true, true)

    assert.equal(t.bridge.tunnelActive, true, 'a new tunnel is up')
    assert.equal(t.bridge.sessions.has(token), false, 'the live map drops the old-domain session')
    assert.equal(t.bridge.resumableSessions.has(token), true, 'but it is parked, exactly like a tunnel death')
    assert.equal(t.bridge.suspendedSessions.has(token), true, 'in both park maps')
  } finally {
    await t.stop()
  }
})

test('① refresh button: tunnel mode rebuilds, LAN mode still rotates the pairing token', () => {
  const refresh = extractFunction(PAGES_SOURCE, 'refreshQr')
  assert.match(refresh, /if\(selectedTunnelTab\)\{btn\.disabled=true;try\{await switchMode\(true,true\)\}/,
    'the tunnel tab rebuilds the tunnel with force')
  assert.doesNotMatch(refresh, /selectedTunnelTab&&!tunnelActive/,
    'a live tunnel no longer falls through to the token-only path')
  assert.match(refresh, /await fetch\('\/desktop\/pairing\/rotate'/,
    'the LAN branch keeps rotating the token')
  const switchMode = extractFunction(PAGES_SOURCE, 'switchMode')
  assert.match(switchMode, /if\(!force&&selectedTunnelTab===enableTunnel&&tunnelActive===enableTunnel\)return;/,
    'and the same-tab early return does not block a forced rebuild')
  assert.match(switchMode, /if\(modeSwitching\|\|\(!force&&phoneConnected\)\)return;/,
    'a live phone still blocks a plain mode switch')
  assert.ok(!/if\(phoneConnected\|\|modeSwitching\)return/.test(switchMode),
    'but not a forced rebuild — the bridge parks the handset instead')
  assert.match(switchMode, /body:JSON\.stringify\(force\?\{enable:enableTunnel,force:true\}:\{enable:enableTunnel\}\)/,
    'force travels to the bridge')
})

// ---------------------------------------------------------------------------
// ② pages: a queued action pulls the transcript now
// ---------------------------------------------------------------------------

test('② a queued action kicks the realtime leg instead of waiting out the poll backoff', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  const action = extractFunction(js, 'queueAction')
  assert.match(action, /rpc\('session\.updateQueue',\{sessionId:owner,itemId,action\}\)/, 'the action still goes through the bridge')
  assert.match(action, /if\(connectionMode==='tunnel'\)scheduleEventPoll\(0\)/,
    'tunnel mode polls immediately instead of waiting 1.5–6s')
  assert.match(action, /lastHistoryKey='';void loadHistory\(false,true\)/,
    'and the durable side is repainted in the same breath')
  const projectionsAt = action.indexOf('await fetchProjectionsNow(owner)')
  const pollAt = action.indexOf("scheduleEventPoll(0)")
  assert.ok(projectionsAt !== -1 && pollAt > projectionsAt, 'the dock still refreshes first — it must not wait on the transcript')
})

// ---------------------------------------------------------------------------
// ③ pages: a steered message lands where it was written
// ---------------------------------------------------------------------------

function userEvent(seq, time, text) {
  return { event: { seq, time, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } } }
}

function assistantEvent(seq, time, turn, step, text) {
  return { event: { seq, time, type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'text', text }] } } } }
}

// A tool call turns into the stamp-less process card the phone draws as
// 「正在运行命令」 — the row that blocked the 2026-10-20 report.
function toolEvent(seq, turn, step, callId, name) {
  return { event: { seq, type: 'tool/call', data: { turn, step, callId, name, arguments: {} } } }
}

// A presented deliverable becomes the attachment card the phone draws under the
// answer. The host stamps it with a clock (seq/time/turn) but pocket keeps it
// stamp-less on the row — it is a unit member, not a timestamp of its own, so
// it must travel with its answer instead of joining the time comparison.
function presentedEvent(seq, turn, files) {
  return { event: { seq, type: 'deliverables/presented', data: { turn, callId: 'call-1', files } } }
}

function buildSandbox() {
  const { js } = mobilePageAssets({ locale: 'zh' })
  const names = ['eventSeq', 'mergeEntries', 'contentBlocks', 'turnKeyOf', 'stepKey', 'windowEvents', 'visibleMessages', 'orderUserBubblesByTime']
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  return new Function(
    `let olderEvents=[],streamEvents=[],lastDurableMessages=[];
     const processBlocks=()=>[];
     const L={};
     ${body}
     let turnElapsedByTurn=new Map(),turnRetryMax=new Map(),turnElapsedAt=0,turnElapsedTurn=null,turnRetry=null;
     return {
       visibleMessages, windowEvents,
       setStream(value){streamEvents=value},
       render(){return visibleMessages(windowEvents())},
     }`,
  )()
}

test('③ a steered message is drawn where it was written, not under the answer it spliced into', () => {
  const sandbox = buildSandbox()
  sandbox.setStream([
    userEvent(1, 1_000, '把文档整理一下'),
    assistantEvent(2, 2_000, 1, 1, '整理完成'),
    // The queued message carries the newest seq — the host spliced it into the
    // running turn — but its own clock says it was written before the answer.
    userEvent(3, 1_500, '顺便跑一下测试'),
  ])
  const rendered = sandbox.render()
  assert.deepEqual(rendered.map((m) => m.role), ['user', 'user', 'assistant'],
    'the steered bubble moves above the reply that was streaming when it was typed')
  assert.deepEqual(rendered.filter((m) => m.role === 'user').map((m) => m.blocks[0].text),
    ['把文档整理一下', '顺便跑一下测试'])
})

test('③ normal transcripts are untouched: rising clocks keep their seq order', () => {
  const sandbox = buildSandbox()
  sandbox.setStream([
    userEvent(1, 1_000, '第一条'),
    assistantEvent(2, 2_000, 1, 1, '回答一'),
    userEvent(3, 3_000, '第二条'),
  ])
  const rendered = sandbox.render()
  assert.deepEqual(rendered.map((m) => m.role), ['user', 'assistant', 'user'])
  assert.deepEqual(rendered.map((m) => m._seq), [1, 2, 3])
})

// A steered bubble cannot land ON a stamp-less row: that row is part of the unit
// above it (an answer with its process card, its attachment card), so the bubble
// goes above the whole unit or below it. Landing between the answer and its own
// attachment was the 2026-10-20 report this guard replaced.
test('③ a stamp-less row above is transparent, not a wall', () => {
  const sandbox = buildSandbox()
  sandbox.setStream([
    userEvent(1, 1_000, '第一条'),
    assistantEvent(2, undefined, 1, 1, '没有时间戳的回答'),
    userEvent(3, 1_500, '排队的一条'),
  ])
  const rendered = sandbox.render()
  assert.deepEqual(rendered.map((m) => m._seq), [1, 3, 2],
    'the bubble walks over the stamp-less row and anchors under the oldest stamped one')
  assert.equal(rendered[1].role, 'user', 'the bubble never wedges itself between a row and the unit it belongs to')
})

test('③ with no stamp anywhere above there is nothing to reorder on: seq order stands', () => {
  const sandbox = buildSandbox()
  sandbox.setStream([
    assistantEvent(1, undefined, 1, 1, '没有时间戳的回答'),
    toolEvent(2, 2, 1, 'call-1', 'run_command'),
    userEvent(3, 1_500, '排队的一条'),
  ])
  const rendered = sandbox.render()
  assert.deepEqual(rendered.map((m) => m._seq), [1, 2, 3],
    'absence of every clock is not evidence, so the bubble keeps the seq order')
})

// The 2026-10-19 fix made stamp-less rows walls, and the report came straight
// back (2026-10-20 06:05 bubble under the 06:13 reply): the running turn's
// process card sits between the two, so the bubble never got past it. This is
// that transcript, byte for byte.
test('③ a running turn process card does not wall the bubble in (2026-10-20 report)', () => {
  const sandbox = buildSandbox()
  sandbox.setStream([
    userEvent(1, 1_000, '早先的一条'),
    assistantEvent(2, 4_000, 1, 1, 'shows 25 failures, not the same reason as before.'),
    toolEvent(3, 2, 1, 'call-1', 'run_command'),
    userEvent(4, 1_500, '第二个也是显示的问题'),
  ])
  const rendered = sandbox.render()
  assert.deepEqual(rendered.map((m) => m.role), ['user', 'user', 'assistant', 'assistant'])
  assert.deepEqual(rendered.map((m) => m._seq), [1, 4, 2, 3],
    'the 06:05 bubble lands above the 06:13 answer; the answer keeps its process card under it')
})

test('③ a user bubble without a stamp is never moved', () => {
  const sandbox = buildSandbox()
  sandbox.setStream([
    userEvent(1, 1_000, '第一条'),
    assistantEvent(2, 2_000, 1, 1, '回答一'),
    userEvent(3, undefined, '没时间戳的一条'),
  ])
  const rendered = sandbox.render()
  assert.deepEqual(rendered.map((m) => m._seq), [1, 2, 3])
})

// The 2026-10-20 report, extended: the previous answer carries an attachment
// card, and the attachment has no clock of its own. The bubble must land above
// the whole unit — answer card AND attachment together — never between them.
test('③ an attachment card travels with its answer when a steered bubble moves up', () => {
  const sandbox = buildSandbox()
  sandbox.setStream([
    userEvent(1, 1_000, '早先的一条'),
    assistantEvent(2, 4_000, 1, 1, 'shows 25 failures, not the same reason as before.'),
    presentedEvent(3, 1, [{ path: 'peer-quota-429.txt', size: 12, name: 'peer-quota-429.txt' }]),
    userEvent(4, 1_500, '第二个也是显示的问题'),
  ])
  const rendered = sandbox.render()
  assert.deepEqual(rendered.map((m) => m._seq), [1, 4, 2, 3],
    'the bubble lands above the answer, and the attachment stays under its answer')
  const presented = rendered.filter((m) => m.blocks?.some((b) => b.kind === 'presented'))
  assert.equal(presented.length, 1, 'the attachment card is still present')
  assert.equal(rendered.indexOf(presented[0]), 3,
    'the attachment card sits under its answer, below the steered bubble')
})

// The mirror case: a new message typed AFTER the answer was finished must not
// slide between the answer and its own attachment. It stays below the unit.
test('③ a later message stays below an answer with an attachment, never inside it', () => {
  const sandbox = buildSandbox()
  sandbox.setStream([
    userEvent(1, 1_000, '早先的一条'),
    assistantEvent(2, 4_000, 1, 1, 'shows 25 failures, not the same reason as before.'),
    presentedEvent(3, 1, [{ path: 'peer-quota-429.txt', size: 12, name: 'peer-quota-429.txt' }]),
    userEvent(4, 9_000, '后来的新问题'),
  ])
  const rendered = sandbox.render()
  assert.deepEqual(rendered.map((m) => m._seq), [1, 2, 3, 4],
    'the later message stays below the unit; the attachment is never pushed above it')
})
