// Regression guard for the phone's first paint.
// The landing is ALWAYS the workspace list now (user 2026-10-12: 「默认点链接就进主
// 页面」); the retired initialChat first-byte jump used to open a conversation the
// reader never chose. These tests pin what still ships: a complete first page of
// list rows in the document, the right transport named in the payload, and the
// cache/compression dials that once blanked the page.
import test from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync, brotliDecompressSync } from 'node:zlib'
import { BOOT_PAYLOAD_CAP_BYTES, BOOT_PREVIEW_BYTE_CAP, BOOT_PREVIEW_EVENT_CAP, LanMobileBridge } from '../lib/bridge.js'

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

const candidate = [{ sessionId: 's1', updatedAt: 5, running: false, projections: { asOfSeq: 5 } }]

// R11-1a: the page a row opens with now rides the document, so 「文档里不许有
// events」这条禁令换成有界断言——分片数 ≤ 预览范围（10 个会话），每片 ≤ 30 条，
// 整个载荷 ≤ 一个写死的字节上界。URL 里的图片、更长的历史都不许混进来。
const PREVIEW_SESSIONS_CAP = 10
const PREVIEW_MESSAGES_CAP = BOOT_PREVIEW_EVENT_CAP

function bootPayloadJson(markup) {
  const hit = /window\.__POCKET_BOOT__=(.+?)<\/script>/.exec(markup)
  assert.ok(hit, 'the document carries a boot payload')
  return hit[1]
}

function assertBoundedTranscript(markup) {
  const json = bootPayloadJson(markup)
  const shards = json.match(/"events":\[/g) ?? []
  assert.ok(shards.length <= PREVIEW_SESSIONS_CAP, `at most ${PREVIEW_SESSIONS_CAP} preview pages ride the document, saw ${shards.length}`)
  const payload = JSON.parse(json)
  const tails = Object.values(payload.tails ?? {})
  assert.ok(tails.length <= PREVIEW_SESSIONS_CAP, `at most ${PREVIEW_SESSIONS_CAP} tail entries, saw ${tails.length}`)
  for (const entry of tails) {
    const count = Array.isArray(entry?.events) ? entry.events.length : 0
    assert.ok(count <= PREVIEW_MESSAGES_CAP, `one preview page carries at most ${PREVIEW_MESSAGES_CAP} events, saw ${count}`)
    if (count > 0) {
      const bytes = Buffer.byteLength(JSON.stringify(entry.events), 'utf8')
      assert.ok(bytes <= BOOT_PREVIEW_BYTE_CAP, `one preview page stays under ${BOOT_PREVIEW_BYTE_CAP} B, saw ${bytes}`)
    }
  }
  const bytes = Buffer.byteLength(json, 'utf8')
  assert.ok(bytes <= BOOT_PAYLOAD_CAP_BYTES, `the boot payload stays bounded, saw ${bytes} bytes`)
  return { payload, bytes }
}

test('the landing is always the workspace list, complete from the first byte', async () => {
  const readSessions = []
  const bridge = makeBridge({
    items: candidate,
    invokeHarness: async () => ({ ok: true, value: { records: Array.from({ length: 30 }, (_, index) => ({ seq: index + 1 })), hasMore: false } }),
  })
  const readHistory = bridge.readSessionHistory.bind(bridge)
  bridge.readSessionHistory = async (fields) => {
    readSessions.push(fields.sessionId)
    return readHistory(fields)
  }
  const { markup, response } = await render(bridge)

  assert.doesNotMatch(markup, /class="[^"]*chat-open/, 'no automatic conversation page any more')
  assert.match(markup, /id="sessionsView" class="view active"/, 'the list is the first paint')
  assert.equal(response.headers['x-pocket-cache'], 'app')
  const { payload } = assertBoundedTranscript(markup)
  assert.ok(readSessions.length > 0, 'the first row to open is pre-read from the same page the RPC would serve')
  assert.deepEqual([...new Set(readSessions)], ['s1'], 'and only the row the document ships is read while it is built')
  assert.ok(Array.isArray(payload.tails?.s1?.events) && payload.tails.s1.events.length > 0, 'that page is what rides the document')
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
// 2026-10: the boot switch overlay gained a brand logo <img>, a fourth slot of
// the same cached form — the anchor below counts four, not three.
// 2026-10-30: the Pocket home document gained its cold-start overlay
// (#bootOverlay, 判据 6/7), whose card carries the same brand <img> — a fifth
// slot, again the cached route and never inlined; measured 5 on 2026-10-30.
// The recovery/PIN pages keep inlining: an unpaired phone cannot read a gated
// route, and test/reconnect-icon.test.js K-1 pins that.
test('the app document names the icon route instead of inlining it repeatedly', async () => {
  const bridge = makeBridge({ items: candidate })
  bridge.iconUiBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const { markup } = await render(bridge)

  assert.equal((markup.match(/data:image\/png/g) ?? []).length, 0, 'no base64 icon in the document')
  assert.equal((markup.match(/\/app-icon\?ui=1/g) ?? []).length, 5, 'all five icon slots point at the cached small form')

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

// R11-2: the document is re-downloaded on every cold navigation (no-store), so it
// negotiates compression like the assets do — and the guard from 2026-10-01 stays:
// a client that offered no Accept-Encoding must get the plain bytes, and a client
// that did must get a body that inflates back to exactly that document. A header
// without the matching body (or the reverse) is what blanked the page that day.
test('the mobile document compresses on the wire, and only when the client asked', async () => {
  const bridge = makeBridge({})
  bridge._docCompressed = new Map()
  const body = `<html>${'x'.repeat(6000)}</html>`
  const makeResponse = () => ({
    destroyed: false,
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
    },
    chunks: [],
    end(chunk) {
      this.chunks.push(Buffer.from(chunk))
    },
  })

  const plain = makeResponse()
  await LanMobileBridge.prototype.sendHtml.call(bridge, { headers: {} }, plain, body)
  assert.equal(plain.headers['content-encoding'], undefined, 'no Accept-Encoding means identity')
  assert.equal(plain.markup, body, 'and the body is the document, unread as bytes here')

  const gz = makeResponse()
  await LanMobileBridge.prototype.sendHtml.call(bridge, { headers: { 'accept-encoding': 'gzip, deflate' } }, gz, body)
  assert.equal(gz.headers['content-encoding'], 'gzip')
  assert.equal(gz.headers['vary'], 'accept-encoding')
  assert.equal(Number(gz.headers['content-length']), gz.chunks[0].length)
  assert.equal(gunzipSync(Buffer.concat(gz.chunks)).toString('utf8'), body, 'the body inflates back to the document')

  const br = makeResponse()
  await LanMobileBridge.prototype.sendHtml.call(bridge, { headers: { 'accept-encoding': 'br, gzip' } }, br, body)
  assert.equal(br.headers['content-encoding'], 'br', 'br wins when offered')
  assert.equal(brotliDecompressSync(Buffer.concat(br.chunks)).toString('utf8'), body)
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

// R11-1c: with more rows than the preview range, only the newest ten sessions get a
// page in the document — the rest open through the ordinary RPC, exactly as before.
test('the preview range rides the document, and it is bounded', async () => {
  const items = Array.from({ length: 12 }, (_, index) => ({
    sessionId: `s${index + 1}`,
    updatedAt: index + 1,
    running: false,
    projections: { asOfSeq: 5 },
  }))
  const readSessions = []
  const bridge = makeBridge({
    items,
    invokeHarness: async (endpoint, args) => {
      const max = Number(args?.request?.maxMessages ?? PREVIEW_MESSAGES_CAP)
      return { ok: true, value: { records: Array.from({ length: Math.min(max, 40) }, (_, index) => ({ seq: index + 1 })), hasMore: true } }
    },
  })
  const readHistory = bridge.readSessionHistory.bind(bridge)
  bridge.readSessionHistory = async (fields) => {
    readSessions.push(fields.sessionId)
    return readHistory(fields)
  }
  const payload = await bridge.buildMobileBoot()

  const shipped = Object.keys(payload.tails ?? {})
  assert.equal(shipped.length, PREVIEW_SESSIONS_CAP, 'the newest ten visible rows ship a page, no more')
  assert.equal(new Set(readSessions).size, PREVIEW_SESSIONS_CAP, 'and no other session is read')
  for (const entry of Object.values(payload.tails)) {
    assert.ok(entry.events.length <= PREVIEW_MESSAGES_CAP, `each preview page carries at most ${PREVIEW_MESSAGES_CAP} events`)
  }
})

// R12-7a: the byte cap is enforced by the implementation with the SAME constant the
// assertion reads, so a fat transcript is trimmed (oldest events first) instead of
// passing here while the live document blows past it.
test('a fat transcript is trimmed by the implementation, not left to the assertion', async () => {
  const items = Array.from({ length: PREVIEW_SESSIONS_CAP }, (_, index) => ({
    sessionId: `s${index + 1}`,
    updatedAt: index + 1,
    running: false,
    projections: { asOfSeq: 5 },
  }))
  const fat = 'x'.repeat(900)
  const bridge = makeBridge({
    items,
    invokeHarness: async (endpoint, args) => {
      const max = Number(args?.request?.maxMessages ?? PREVIEW_MESSAGES_CAP)
      return {
        ok: true,
        value: {
          records: Array.from({ length: Math.min(max, PREVIEW_MESSAGES_CAP) }, (_, index) => ({
            seq: index + 1,
            type: 'assistant/message',
            text: fat,
          })),
          hasMore: true,
        },
      }
    },
  })
  const payload = await bridge.buildMobileBoot()
  const json = JSON.stringify(payload)
  const bytes = Buffer.byteLength(json, 'utf8')
  assert.ok(bytes <= BOOT_PAYLOAD_CAP_BYTES, `the payload is trimmed to the cap, saw ${bytes} bytes`)
  for (const entry of Object.values(payload.tails ?? {})) {
    const events = Array.isArray(entry?.events) ? entry.events : []
    assert.ok(events.length <= BOOT_PREVIEW_EVENT_CAP, `per-session events stay capped, saw ${events.length}`)
    const pageBytes = Buffer.byteLength(JSON.stringify(events), 'utf8')
    assert.ok(pageBytes <= BOOT_PREVIEW_BYTE_CAP, `per-session bytes stay capped, saw ${pageBytes}`)
  }

  const events = Object.values(payload.tails ?? {}).reduce(
    (sum, entry) => sum + (Array.isArray(entry?.events) ? entry.events.length : 0),
    0,
  )
  assert.ok(events < PREVIEW_SESSIONS_CAP * PREVIEW_MESSAGES_CAP, `the implementation dropped messages, kept ${events}`)
  assert.ok(payload.stageSummary.messages <= events, 'the card counts what actually shipped')
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

test('the tail cache is bounded and drops the oldest entry first', async () => {
  // 审核 B2-P2-2：tailsMemoryCache 原先没有上限，手机走过多少会话就把多少个
  // compacted tail 永久钉在宿主内存里。这里故意填到 cap 之上再采集一次：修复前
  // 尺寸会涨到 301，修复后停在 cap，且被淘汰的是最早那条（Map 插入序，命中不重排）。
  const now = Date.now()
  const bridge = makeBridge({
    items: [{ sessionId: 's1', updatedAt: now - 1000, projections: { asOfSeq: 5 } }],
    invokeHarness: async (endpoint) => {
      if (endpoint === 'session/page') {
        return {
          ok: true,
          value: { records: [{ seq: 1, type: 'assistant/message', data: { message: { content: [{ kind: 'text', text: 'hi' }] } } }] }
        }
      }
      return { ok: false }
    }
  })
  bridge.tailsMemoryCache = new Map()
  for (let i = 0; i < 300; i++) {
    bridge.tailsMemoryCache.set('old' + i, { throughSeq: 1, updatedAt: 1, events: [] })
  }
  const byId = new Map([['s1', { sessionId: 's1', updatedAt: now - 1000, projections: { asOfSeq: 5 } }]])
  await bridge.collectSessionTails(['s1'], byId)

  assert.ok(bridge.tailsMemoryCache.size < 300, 'the cache stops growing at its cap')
  assert.equal(bridge.tailsMemoryCache.has('old0'), false, 'the oldest insertion is the one dropped')
  assert.equal(bridge.tailsMemoryCache.has('old299'), true, 'the newest insertions survive')
  assert.equal(bridge.tailsMemoryCache.has('s1'), true, 'and the answer that just came back is kept')
})
