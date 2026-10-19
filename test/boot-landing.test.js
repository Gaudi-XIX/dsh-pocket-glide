// Regression guard for the phone's first paint.
// The landing is ALWAYS the workspace list now (user 2026-10-12: 「默认点链接就进主
// 页面」); the retired initialChat first-byte jump used to open a conversation the
// reader never chose. These tests pin what still ships: a complete first page of
// list rows in the document, the right transport named in the payload, and the
// cache/compression dials that once blanked the page.
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

async function render(bridge, url = '/?warm=123', request = null) {
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value } }
  // The router always hands a real IncomingMessage here. A bare `{url}` used to be
  // enough, but the payload now carries the transport the phone opens its first
  // realtime channel with, and that read wants `socket` + `headers` — under-specified
  // fixtures made the whole boot branch throw into its own catch, so the document
  // silently lost its payload and no test noticed.
  const markup = await bridge.renderMobilePage(
    request ?? { url, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:43127' } },
    response,
  )
  return { markup, response }
}

const candidate = [{ sessionId: 's1', updatedAt: 5, running: false }]

test('the landing is always the workspace list, complete from the first byte', async () => {
  const bridge = makeBridge({
    items: candidate,
    invokeHarness: async () => {
      throw new Error('the document must not read the transcript')
    },
  })
  const { markup, response } = await render(bridge)

  assert.doesNotMatch(markup, /class="[^"]*chat-open/, 'no automatic conversation page any more')
  assert.match(markup, /id="sessionsView" class="view active"/, 'the list is the first paint')
  assert.equal(response.headers['x-pocket-cache'], 'app')
  assert.doesNotMatch(markup, /"events":\[/, 'the transcript must not be embedded in the document')
  const log = bridge.logs.join('\n')
  assert.match(log, /bytes=\d+/)
  assert.match(log, /boot=embedded/, 'the boot payload still rides the document')
  assert.doesNotMatch(log, /initialChat=/, 'the retired flag is gone from the log line')
})

test('a workspace with no sessions still lands on the list', async () => {
  const bridge = makeBridge({ items: [] })
  const { markup } = await render(bridge)

  assert.doesNotMatch(markup, /<body class="chat-open">/)
  assert.match(bridge.logs.join('\n'), /boot=embedded/)
})






test('an unavailable boot payload degrades to a bare list document', async () => {
  const bridge = makeBridge({ items: candidate })
  bridge.cachedSessionList = async () => ({ ok: false, error: 'workspaces not loaded yet' })
  const { markup } = await render(bridge)

  assert.doesNotMatch(markup, /<body class="chat-open">/)
  assert.match(bridge.logs.join('\n'), /boot=none/, 'the log says the landing has no payload, not that it will open a chat')
})

// The phone picks its realtime transport on the FIRST openSession, before any
// /api/status reply can reach it. `connectionMode` on the page starts as 'lan',
// so a tunnel document used to open an EventSource a quick tunnel cannot carry,
// sit on it until the ~30s teardown (visible in pocket.log as
// `session stream closed … reason=client-close ms=30xxx`), and paint from the
// 900ms history fallback instead. The document therefore has to say which
// transport it was served over.
test('the boot payload names the transport, so the first stream is the right one', async () => {
  const bridge = makeBridge({ items: candidate })
  const { markup } = await render(bridge)
  assert.match(markup, /"mode":"lan"/, 'a loopback document with a loopback transport is lan')

  const tunneled = await render(bridge, '/?warm=123', {
    url: '/?warm=123',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'ribbon-recommends-drums-treated.trycloudflare.com' },
  })
  assert.match(tunneled.markup, /"mode":"tunnel"/, 'the cloudflared host header is what the router itself reads')

  const lanHost = await render(bridge, '/?warm=123', {
    url: '/?warm=123',
    socket: { remoteAddress: '192.168.1.40' },
    headers: { host: '192.168.1.40:43127' },
  })
  assert.match(lanHost.markup, /"mode":"lan"/, 'a phone on the LAN never boots into the poller')
})

// The app document used to inline the 96px icon as base64 THREE times (favicon,
// apple-touch-icon, header <img>) — 31.7 KB on a `no-store` document that is
// re-downloaded on every cold open, for a glyph that renders at 22px. The doc is
// only ever rendered for a paired phone, so it names the cached route instead.
// The recovery/PIN pages keep inlining: an unpaired phone cannot read a gated
// route, and test/reconnect-icon.test.js K-1 pins that.
test('the app document names the icon route instead of inlining it three times', async () => {
  const bridge = makeBridge({ items: candidate })
  bridge.iconUiBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const { markup } = await render(bridge)

  assert.equal((markup.match(/data:image\/png/g) ?? []).length, 0, 'no base64 icon in the document')
  assert.equal((markup.match(/\/app-icon\?ui=1/g) ?? []).length, 3, 'all three icon slots point at the cached small form')

  // With no small bytes in hand (no icon configured, or pngjs unavailable), the
  // document must not invent a route that 404s differently than before.
  const bare = makeBridge({ items: candidate })
  const { markup: fallbackMarkup } = await render(bare)
  assert.match(fallbackMarkup, /href="\/app-icon"/, 'no icon in hand falls back to the plain route')
  assert.doesNotMatch(fallbackMarkup, /\?ui=1/, 'and does not claim a variant it cannot serve')
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

test('the boot payload tells the handoff where the shell lives', async () => {
  // The pairing page pulls these before it navigates; if the payload stops
  // advertising them (or the hashes drift), the phone sits on an unstyled,
  // inert skeleton for another tunnel round trip after the last step.
  const bridge = makeBridge({ items: candidate })
  const payload = await bridge.buildMobileBoot({ history: false })

  assert.match(payload.assets.cssUrl, /^\/app\.css\?h=[0-9a-f]{12}$/)
  assert.match(payload.assets.jsUrl, /^\/app\.js\?l=zh&h=[0-9a-f]{12}$/)
  assert.equal(bridge.mobileAssetBodies('zh').urls.jsUrl, payload.assets.jsUrl, 'the advertised URLs must be the ones the document uses')
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

test('an empty session list ships an empty boot list and no focus', async () => {
  const bridge = makeBridge({ items: [] })
  const payload = await bridge.buildMobileBoot()

  assert.equal('focus' in payload, false, 'no focus field ships at all')
  assert.deepEqual(payload.sess.items, [])
})

test('buildMobileBoot includes tails for visible rows', async () => {
  const now = Date.now()
  const bridge = makeBridge({
    items: [
      { sessionId: 's1', updatedAt: now - 1000, projections: { asOfSeq: 5 } },
      { sessionId: 's2', updatedAt: now - 2000, projections: { asOfSeq: 8 } }
    ],
    invokeHarness: async (endpoint, args) => {
      if (endpoint === 'session/page') {
        const id = args.request.address.sessionId
        return {
          ok: true,
          value: {
            records: [
              { seq: 1, type: 'assistant/message', data: { message: { content: [{ kind: 'text', text: `tail for ${id}` }] } } }
            ]
          }
        }
      }
      return { ok: false }
    }
  })
  const payload = await bridge.buildMobileBoot()
  assert.ok(payload.tails, 'boot payload must include tails')
  assert.ok(payload.tails.s1, 'tail for visible session s1 must be included')
  assert.ok(payload.tails.s2, 'tail for visible session s2 must be included')
  assert.equal(payload.tails.s1.events.length, 1)
})

test('buildMobileBoot skips subagent rows from boot tail fetch', async () => {
  const now = Date.now()
  let pageCalledForSubagent = false
  const bridge = makeBridge({
    items: [
      { sessionId: 's1', updatedAt: now - 1000, projections: { asOfSeq: 5 } },
      { sessionId: 'sub1', origin: 'subagent', updatedAt: now - 500, projections: { asOfSeq: 3 } }
    ],
    invokeHarness: async (endpoint, args) => {
      if (endpoint === 'session/page') {
        const id = args.request.address.sessionId
        if (id === 'sub1') pageCalledForSubagent = true
        return {
          ok: true,
          value: { records: [{ seq: 1, type: 'assistant/message', data: { message: { content: [{ kind: 'text', text: 'ok' }] } } }] }
        }
      }
      return { ok: false }
    }
  })
  const payload = await bridge.buildMobileBoot()
  assert.equal(pageCalledForSubagent, false, 'subagent session must not trigger session/page RPC')
  assert.ok(payload.tails.s1, 'visible row s1 is still fetched')
})

test('collectSessionTails hits memory cache on repeated calls without RPC', async () => {
  const now = Date.now()
  let rpcCount = 0
  const bridge = makeBridge({
    items: [{ sessionId: 's1', updatedAt: now - 1000, projections: { asOfSeq: 5 } }],
    invokeHarness: async (endpoint) => {
      if (endpoint === 'session/page') {
        rpcCount++
        return {
          ok: true,
          value: { records: [{ seq: 1, type: 'assistant/message', data: { message: { content: [{ kind: 'text', text: 'hi' }] } } }] }
        }
      }
      return { ok: false }
    }
  })
  const byId = new Map([['s1', { sessionId: 's1', updatedAt: now - 1000, projections: { asOfSeq: 5 } }]])
  const tails1 = await bridge.collectSessionTails(['s1'], byId)
  assert.equal(rpcCount, 1)
  assert.equal(tails1.s1.events.length, 1)

  // Second call with same state should hit cache
  const tails2 = await bridge.collectSessionTails(['s1'], byId)
  assert.equal(rpcCount, 1, 'repeated call must hit cache without additional RPC')
  assert.equal(tails2.s1.events.length, 1)
})
