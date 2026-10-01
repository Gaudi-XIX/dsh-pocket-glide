// Regression guard for the phone's first paint.
//
// Live bug 2026-10-01: the inline history read (`session/page`) failed during
// the PIN-page prewarm, so `payload.focus` went missing and `initialChat` fell
// back to false. The phone then painted the workspace list first and walked the
// whole list → chat → content sequence again — exactly the sequence the prewarm
// exists to remove. The landing view must depend on "will a session be opened",
// never on the history read succeeding.
import test from 'node:test'
import assert from 'node:assert/strict'
import { LanMobileBridge } from '../lib/bridge.js'

function makeBridge(overrides = {}) {
  const logs = []
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = logs
  bridge.log = (level, message) => logs.push(`${level}: ${message}`)
  bridge.locale = () => 'zh'
  bridge.iconDataUri = null
  bridge.now = () => Date.now()
  bridge.html = (response, markup) => {
    response.markup = markup
    return markup
  }
  bridge.pendingQuestions = new Map()
  bridge.workspaceSnapshot = { items: [] }
  bridge.cachedSettings = async () => ({ ok: true, value: {} })
  bridge.cachedSessionList = async () => ({ ok: true, value: { items: overrides.items ?? [] } })
  bridge.invokeHarness = overrides.invokeHarness ?? (async () => ({ ok: false, error: 'not stubbed' }))
  return bridge
}

async function render(bridge, url = '/?warm=123') {
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value } }
  const markup = await bridge.renderMobilePage({ url }, response)
  return { markup, response }
}

const candidate = [{ sessionId: 's1', updatedAt: 5, running: false }]

test('the app document opens in the chat view and leaves the payload to the handoff', async () => {
  // The document must decide its first paint from "will a session be opened",
  // never from a payload read that can fail, and it must stay small: the
  // transcript travels through /api/boot and the tab's memory, so no browser
  // cache, service worker or inline payload sits in the landing path.
  const bridge = makeBridge({
    items: candidate,
    invokeHarness: async () => {
      throw new Error('the document must not read the transcript')
    },
  })
  const { markup, response } = await render(bridge)

  assert.match(markup, /<body class="chat-open">/, 'first paint must already be the conversation page')
  assert.equal(response.headers['x-pocket-cache'], 'app')
  assert.doesNotMatch(markup, /"events":\[/, 'the transcript must not be embedded in the document')
  const log = bridge.logs.join('\n')
  assert.match(log, /initialChat=true/)
  assert.match(log, /bytes=\d+/)
  assert.match(log, /candidate=s1/)
  assert.match(log, /baseline=history-deferred/)
  assert.equal(bridge._bootDiag.events, 0)
})

test('landing falls back to the workspace list only when no session can be opened', async () => {
  const bridge = makeBridge({ items: [] })
  const { markup } = await render(bridge)

  assert.doesNotMatch(markup, /<body class="chat-open">/)
  assert.match(bridge.logs.join('\n'), /initialChat=false/)
  assert.match(bridge.logs.join('\n'), /baseline=no-candidate/)
})

test('focus history prefers the projection sequence and embeds the records', async () => {
  const calls = []
  const bridge = makeBridge({
    invokeHarness: async (endpoint, args) => {
      calls.push({ endpoint, request: args.request })
      return { ok: true, value: { records: [{ seq: 3 }], hasMore: true } }
    },
  })

  const focus = await bridge.focusBootHistory({ sessionId: 's1', projections: { asOfSeq: 7 } })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].endpoint, 'session/page')
  assert.equal(calls[0].request.throughSeq, 7)
  assert.equal(focus.sessionId, 's1')
  assert.deepEqual(focus.history.events, [{ seq: 3 }])
  assert.equal(focus.history.hasMore, true)
  assert.equal(bridge._focusBootReason, '')
})

test('focus history still resolves without a projected sequence', async () => {
  const calls = []
  const bridge = makeBridge({
    invokeHarness: async (endpoint, args) => {
      calls.push(args.request)
      return { ok: true, value: { records: [{ seq: 1 }] } }
    },
  })

  const focus = await bridge.focusBootHistory({ sessionId: 's1', projections: null })

  assert.equal(calls.length, 1)
  assert.equal('throughSeq' in calls[0], false)
  assert.deepEqual(focus.history.events, [{ seq: 1 }])
})

test('focus history retries without the turn window when the first page is empty', async () => {
  const calls = []
  const bridge = makeBridge({
    invokeHarness: async (endpoint, args) => {
      calls.push(args.request)
      return calls.length === 1
        ? { ok: true, value: { records: [] } }
        : { ok: true, value: { records: [{ seq: 2 }] } }
    },
  })

  const focus = await bridge.focusBootHistory({ sessionId: 's1', projections: { asOfSeq: 7 } })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].throughSeq, 7)
  assert.equal('throughSeq' in calls[1], false)
  assert.deepEqual(focus.history.events, [{ seq: 2 }])
})

test('focus history reports why it gave up instead of failing silently', async () => {
  const bridge = makeBridge({
    invokeHarness: async () => ({ ok: false, error: { message: 'harness down' } }),
  })

  const focus = await bridge.focusBootHistory({ sessionId: 's1', projections: { asOfSeq: 1 } })

  assert.equal(focus, null)
  assert.equal(bridge._focusBootReason, 'page-failed:harness down')
})

test('buildMobileBoot embeds the focus turn and records diagnostics', async () => {
  const bridge = makeBridge({
    items: [{ sessionId: 's1', updatedAt: 9, projections: { asOfSeq: 4 } }],
    invokeHarness: async () => ({ ok: true, value: { records: [{ seq: 4 }], hasMore: false } }),
  })

  const payload = await bridge.buildMobileBoot()

  assert.equal(payload.focus.sessionId, 's1')
  assert.deepEqual(payload.focus.history.events, [{ seq: 4 }])
  assert.equal(bridge._bootDiag.candidate, 's1')
  assert.equal(bridge._bootDiag.events, 1)
  assert.equal(bridge._bootDiag.reason, '')
})

test('an unavailable boot payload still opens in the chat view', async () => {
  const bridge = makeBridge({ items: candidate })
  bridge.cachedSessionList = async () => ({ ok: false, error: 'workspaces not loaded yet' })
  const { markup } = await render(bridge)

  assert.match(markup, /<body class="chat-open">/)
  assert.match(bridge.logs.join('\n'), /initialChat=true/)
  assert.match(bridge.logs.join('\n'), /candidate=none/)
})

test('the app document is never cacheable', async () => {
  // 2026-10-01: a `private, max-age=10` window let a mobile browser replay a
  // mangled copy for the landing navigation and the app came up blank. The
  // document is fetched fresh every time; nothing in the landing path may depend
  // on a cache.
  const bridge = makeBridge({ items: candidate })
  const { response } = await render(bridge)

  assert.equal(response.headers['cache-control'], 'no-store')
})

test('the mobile document is never compressed at the origin', () => {
  // 2026-10-01 regression: serving this document with content-encoding: gzip made
  // the phone render the compressed bytes as text (the header was dropped
  // somewhere along the tunnel / browser path while the body stayed compressed).
  // The origin must always send it plain; wire compression belongs to the edge.
  const bridge = makeBridge({})
  const body = `<html>${'x'.repeat(4096)}</html>`
  const response = {
    destroyed: false,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
    },
    chunks: [],
    end(chunk) {
      this.chunks.push(Buffer.from(chunk))
    },
  }

  LanMobileBridge.prototype.html.call(bridge, response, body)

  assert.equal(response.headers['content-encoding'], undefined)
  assert.equal(Buffer.concat(response.chunks).toString('utf8'), body)
})

test('session.history retries when the aligned page comes back empty', async () => {
  // 2026-10-01: the phone's fallback history fetch got an empty aligned page and
  // blanked the conversation it had just painted. A second request shape must be
  // tried before an empty page is believed.
  const calls = []
  const bridge = makeBridge({
    invokeHarness: async (endpoint, args) => {
      calls.push(args.request)
      return calls.length === 1
        ? { ok: true, value: { records: [] } }
        : { ok: true, value: { records: [{ seq: 9 }], hasMore: false } }
    },
  })
  bridge.cachedSessionList = async () => ({ ok: true, value: { items: [{ sessionId: 's1', projections: { asOfSeq: 9 } }] } })

  const result = await bridge.forwardRpc('session.history', { sessionId: 's1' })

  assert.equal(result.ok, true)
  assert.deepEqual(result.value.events, [{ seq: 9 }])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].turnWindow.minTurns, 1)
  assert.equal('turnWindow' in calls[1], false)
})

test('session.history keeps an honest empty page when every shape is empty', async () => {
  const calls = []
  const bridge = makeBridge({
    invokeHarness: async (endpoint, args) => {
      calls.push(args.request)
      return { ok: true, value: { records: [] } }
    },
  })
  bridge.cachedSessionList = async () => ({ ok: true, value: { items: [{ sessionId: 's1', projections: { asOfSeq: 3 } }] } })

  const result = await bridge.forwardRpc('session.history', { sessionId: 's1' })

  assert.equal(result.ok, true)
  assert.deepEqual(result.value.events, [])
  assert.equal(calls.length, 3)
})

test('an empty session list never claims a focus session', async () => {
  const bridge = makeBridge({ items: [] })
  const payload = await bridge.buildMobileBoot()

  assert.equal('focus' in payload, false)
  assert.equal(bridge._bootDiag.candidate, 'none')
  assert.equal(bridge._bootDiag.reason, 'no-candidate')
})
