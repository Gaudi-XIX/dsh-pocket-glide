// 判据 R1/R2/R3/R4/R5 的机检（change
// 2026-11-03-bugfix-pocket-boot-handoff-stream-and-preload-fill）。
//
// 这里只钉判据原文要求的那几件事：
//   R1  点下「连接」这一瞬就进等待态（文案逐字、转圈在、失败能复原）；
//   R3  第 4 行改「同步消息数量」/「Syncing message count」，单位与行数不动；
//   R4  尾包腿带回的 messages 就是页侧归并后能画出的消息单位数（countVisibleMessageUnits），
//       且每会话补到一屏即停；
//   R5  /api/boot 的 team 与 /api/rpc 的 bot.team 是同一份投影，首帧就能画 BOT 卡。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startBridge, httpFetch } from './helpers.js'
import { BOOT_PAYLOAD_CAP_BYTES, LanMobileBridge } from '../lib/bridge.js'
import { countTailMessages, countVisibleMessageUnits, mobilePageAssets, renderMobileReconnectPage, renderPairingPinPage } from '../lib/pages.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'lib', 'pages.js'), 'utf8')

const WAIT_ZH = '正在与桌面端通信'
const WAIT_EN = 'Talking to the desktop'

test('R1 both submitPin paths enter the waiting state before their first await', () => {
  assert.equal(SOURCE.split('请在电脑上确认接入').length - 1, 0, 'the old waiting copy is gone from lib/')
  // 恰好两处，且两处都是 `confirmWait:` 定义行（PIN 面一张、断线重连面一张）。
  for (const copy of [WAIT_ZH, WAIT_EN]) {
    const lines = SOURCE.split(String.fromCharCode(10)).filter((line) => line.includes(copy))
    assert.equal(lines.length, 2, `${copy} ships on exactly two definition lines`)
    for (const line of lines) assert.ok(line.includes('confirmWait:'), `only a confirmWait definition carries it: ${line.trim()}`)
  }

  // 两处 submitPin：写等待态的语句必须早于第一个 await。
  const starts = [...SOURCE.matchAll(/async function submitPin\(event\)\{/g)].map((m) => m.index)
  assert.equal(starts.length, 2, 'two submitPin paths: the pairing page and the reconnect page')
  for (const start of starts) {
    const body = SOURCE.slice(start, start + 4000)
    const wait = body.indexOf('T.confirmWait')
    const firstAwait = body.indexOf('await ')
    assert.ok(wait > 0, 'the waiting state is written on this path')
    assert.ok(firstAwait > 0, 'the path still awaits the desktop')
    assert.ok(wait < firstAwait, `the waiting state lands before the first await (wait ${wait} < await ${firstAwait})`)
    // 转圈会停：确认之后要撤掉等待标记，不能一路转到跳转。
    assert.ok(body.indexOf("classList.remove('is-waiting')") > 0, 'the waiting mark is cleared on this path')
  }

  // 两张交付页都带同一份文案与一个活动动效（prefers-reduced-motion 下停转）。
  for (const [name, page] of [
    ['reconnect', renderMobileReconnectPage('zh', 'lan', {})],
    ['pairing', renderPairingPinPage('zh', null, {})],
  ]) {
    assert.ok(page.includes(WAIT_ZH), `${name}: the waiting copy ships in the page's own table`)
    assert.ok(page.includes('is-waiting'), `${name}: the waiting element is marked for its spinner`)
    assert.ok(page.includes('@keyframes bspin'), `${name}: the spinner keyframes ship with the page`)
    const reduce = page.indexOf('@media(prefers-reduced-motion:reduce)')
    assert.ok(reduce > 0, `${name}: reduced motion is respected`)
    assert.ok(page.indexOf('is-waiting', reduce) > reduce, `${name}: the waiting spinner stops under reduced motion`)
  }
  for (const [name, page] of [
    ['reconnect en', renderMobileReconnectPage('en', 'lan', {})],
    ['pairing en', renderPairingPinPage('en', null, {})],
  ]) {
    assert.ok(page.includes(WAIT_EN), `${name}: the English waiting copy is the ruled one`)
  }
})

test('R3 the fourth row is the message count on all three faces', () => {
  assert.equal(SOURCE.split('同步会话内容').length - 1, 0, 'the retired label is gone from lib/')
  assert.equal(SOURCE.split('Syncing conversation').length - 1, 0, 'the retired English label is gone from lib/')
  assert.equal(SOURCE.split("'同步消息数量'").length - 1, 1, 'the new zh label lives on the one shared table')
  assert.equal(SOURCE.split('Syncing message count').length - 1, 2, 'the new en label lives on the table and its comment')
  assert.ok(SOURCE.includes("' 条消息'") && SOURCE.includes("' messages'"), 'the units did not move')
  for (const [name, page] of [
    ['reconnect', renderMobileReconnectPage('zh', 'lan', {})],
    ['pairing', renderPairingPinPage('zh', null, {})],
  ]) {
    assert.ok(page.includes('同步消息数量'), `${name}: the fourth row carries the new label`)
    assert.equal(page.includes('同步会话内容'), false, `${name}: the old label is nowhere in the document`)
  }
})

// ---------------------------------------------------------------------------
// R4 — 尾包腿：数字与包内真值同一口径，每会话补到一屏即停
// ---------------------------------------------------------------------------

function makeBridge(overrides = {}) {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = []
  bridge.log = () => {}
  bridge.now = () => Date.now()
  bridge.tailsMemoryCache = new Map()
  bridge.workspaceSnapshot = { items: [] }
  bridge.invokeHarness = overrides.invokeHarness ?? (async () => ({ ok: false, error: 'not stubbed' }))
  return bridge
}

/** One compacted-looking session record; fitTailToScreen only needs seq + type. */
const rec = (seq, text = 'x') => ({
  seq,
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] } },
})
const userRec = (seq) => ({ seq, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'q' }] } } })

test('R4.3 a short first page is topped up with the page before it, until one screen fits', async () => {
  const requests = []
  const first = [userRec(5), rec(6), userRec(7), rec(8)]
  const older = [userRec(1), rec(2), userRec(3), rec(4)]
  const bridge = makeBridge({
    invokeHarness: async (endpoint, { request }) => {
      requests.push(request)
      if (request.beforeSeq !== undefined) return { ok: true, value: { records: older, hasMore: false } }
      return { ok: true, value: { records: first, hasMore: true } }
    },
  })
  const byId = new Map([['s-1', { sessionId: 's-1', updatedAt: 7, projections: { asOfSeq: 8 } }]])
  const tails = await bridge.collectSessionTails(['s-1'], byId, { timeoutMs: 5000 })

  assert.equal(tails['s-1'].events.length, 8, 'the older page rides in front of the first one')
  assert.equal(requests.length, 2, 'exactly one backward page was asked for')
  assert.equal(requests[1].beforeSeq, 5, 'the cursor is the oldest seq already held')
  assert.deepEqual(tails['s-1'].events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8], 'merged oldest-first')
  assert.equal(tails['s-1'].hasMore, false, 'the host said there is no more')
})

test('R4.3 a page that already fills the screen is never walked back', async () => {
  let calls = 0
  const many = Array.from({ length: 60 }, (_, i) => rec(i + 1, 'y'))
  const bridge = makeBridge({
    invokeHarness: async () => {
      calls += 1
      return { ok: true, value: { records: many, hasMore: true } }
    },
  })
  const byId = new Map([['s-2', { sessionId: 's-2', updatedAt: 9, projections: { asOfSeq: 60 } }]])
  const tails = await bridge.collectSessionTails(['s-2'], byId, { timeoutMs: 5000 })
  assert.equal(calls, 1, 'the heavy page is already a screen; no second read')
  assert.ok(tails['s-2'].events.length <= 40, 'the pack stays inside TAIL_MAX_RECORDS')
  assert.equal(tails['s-2'].hasMore, true, 'dropped records are honestly flagged as more')
})

test('R4.1 the tail leg ships one message count computed from exactly the tails it ships', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: {} })
  try {
    const cookie = await t.pairMobile('PocketR4/1.0')
    const response = await httpFetch(`${t.base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ method: 'session.tails', payload: { sessions: ['missing-session'] } }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.value.messages, body.value.complete ? countVisibleMessageUnits(body.value.tails) : null, 'a complete pack carries its count; an incomplete one carries no number at all')
    assert.deepEqual(body.stage, { messages: body.value.messages }, 'the ladder cell gets the same number')
  } finally {
    await t.stop()
  }
})

test('R4.1 a clean tail pack ships its own count unconditionally', async () => {
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/list'
          ? { ok: true, value: { items: [{ sessionId: 's-clean', updatedAt: Date.now() - 60_000, projections: { asOfSeq: 5 } }] } }
          : pathname === '/api/session/page'
            ? { ok: true, value: { records: [{ seq: 1, event: { type: 'user/message', time: Date.now(), data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'clean' }] }, stream: 'x', header: 'h', meta: 'm' } } }], hasMore: false } }
            : undefined,
    },
  })
  try {
    const cookie = await t.pairMobile('PocketR4/1.0')
    const response = await httpFetch(`${t.base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ method: 'session.tails', payload: { sessions: ['s-clean'] } }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.value.complete, true, 'a clean batch is complete')
    assert.equal(body.value.messages, countVisibleMessageUnits(body.value.tails), 'the number equals the pack it rides with')
    assert.deepEqual(body.stage, { messages: body.value.messages }, 'the ladder cell gets the same number')
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// R4 第 4 格的口径：卡上的数字 == 点进预读集合、不发新请求就能画出的气泡数
// ---------------------------------------------------------------------------

/** 从出货 js 按名字切一个同步函数（纯大括号配平，与 test/message-blocks.test.js 同一范式）。 */
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

/** 出货页的渲染链沙箱：visibleMessages（事件流→行）+ renderMessage（行→HTML）。
 *  mock 只补渲染链闭包里要的壳级绑定，不整壳 boot（240KB 的壳喂不饱，会假绿）。 */
function pageRender() {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const names = [
    'esc', 'renderBlock', 'renderMessage', 'renderMessageTail', 'visibleMessages',
    'contentBlocks', 'turnKeyOf', 'eventSeq', 'stepKey', 'orderUserBubblesByTime',
    'formatMessageClock', 'formatTokens', 'formatElapsed', 'pad2',
  ]
  const shim = [
    'const L = {}',
    "const markdown = (s) => '<p>' + String(s == null ? '' : s) + '</p>'",
    'const noteSessionPaths = () => {}',
    'const turnRetryMax = new Map()',
    'const turnElapsedByTurn = new Map()',
    'const turnOpenState = new Map()',
    'const knownPathsOf = () => null',
    'const IMAGE_FILE_EXTS = []',
    'const TEXT_FILE_EXTS = []',
    "const FILE_SVG = ''",
    "const SJ = ''",
    "const SE = ''",
    "const SC = ''",
    "let activeSession = ''",
    'let rows = []',
    'let pendingQuestion = null',
    'const zh = true',
  ].join('\n')
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  return new Function(`${shim}\n${body}\nreturn { visibleMessages, renderMessage }`)()
}

test('R4.4 the card counts drawn bubbles: a sourceless user record and one turn\'s repeated answers merge', async () => {
  // 用户 2026-11-01 的等式：卡上的数字必须等于点进去真画出来的量。
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 7 } },
    // 没有 message.source 的 user/message：页侧永远画不出来，旧口径却把它算了一条。
    { seq: 2, type: 'user/message', data: { message: { content: [{ type: 'text', text: '没有来源' }] } } },
    { seq: 3, type: 'user/message', data: { turn: 7, message: { source: { kind: 'user' }, content: [{ type: 'text', text: '问一句' }] } } },
    // 同一回合（同 turn、同 step）的三条 assistant/message：页侧归并成一个气泡，旧口径算三条。
    { seq: 4, type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: '甲' }] } } },
    { seq: 5, type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: '乙' }] } } },
    { seq: 6, type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: '丙' }] } } },
  ]
  const bridge = makeBridge({ invokeHarness: async () => ({ ok: true, value: { records: events, hasMore: false } }) })
  const byId = new Map([['s-afc', { sessionId: 's-afc', updatedAt: 7, projections: { asOfSeq: 6 } }]])
  const tails = await bridge.collectSessionTails(['s-afc'], byId, { timeoutMs: 5000 })

  const units = countVisibleMessageUnits(tails)
  assert.equal(countTailMessages(tails), 5, 'the old record count still sees five records')
  assert.equal(units, 2, 'the merge leaves one user bubble and one answer bubble')
  const page = pageRender()
  const html = page.visibleMessages(tails['s-afc'].events).map((message) => page.renderMessage(message)).join('')
  assert.equal(html.split('<div class="message').length - 1, units, 'card number == .message bubbles the page paints')
})

// ---------------------------------------------------------------------------
// R5 — boot 的 team 与 bot.team 是同一份投影
// ---------------------------------------------------------------------------

test('R5.1 /api/boot ships the same team the bot.team RPC answers', async () => {
  const state = {
    ok: true,
    value: {
      bots: [{ id: 'bot-a', name: '阿甲', sessionId: 'bot-sess-1', role: 'member' }],
      members: [],
      groups: [],
      rooms: [{ id: 'room-1', name: '群一', sessionIds: [] }],
      approvals: [],
      questions: [],
    },
  }
  const respond = (pathname) =>
    pathname === '/api/session/list' ? { ok: true, value: { items: [] } } : undefined
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: { respond, botRespond: (endpoint) => (endpoint === 'state' ? state : { ok: true, value: {} }) },
  })
  try {
    t.bridge.workspaceSnapshot = { items: [], pinnedSessionIds: [] }
    const cookie = await t.pairMobile('PocketR5/1.0')
    // 满载跑批下这一份 fake harness 偶尔让整次 boot 构建超时（路由的 catch 回 503
    // `{ok:false}`）。真少一段的回归会两次都少，所以只对「压根没拿到载荷」重试一次。
    const fetchBoot = async () => {
      const response = await httpFetch(t.base + '/api/boot', { headers: { cookie } })
      const text = await response.text()
      return { status: response.status, text, body: JSON.parse(text) }
    }
    let bootHit = await fetchBoot()
    if (!Object.prototype.hasOwnProperty.call(bootHit.body, 'team')) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      bootHit = await fetchBoot()
    }
    const boot = bootHit.body
    assert.ok(
      Object.prototype.hasOwnProperty.call(boot, 'team'),
      `the payload carries a team section (status ${bootHit.status}, keys ${Object.keys(boot).join(',')}, bytes ${bootHit.text.length}, logs ${JSON.stringify(t.logs ?? []).slice(0, 600)})`,
    )
    t.bridge._botTeamValue = null
    const answer = await httpFetch(`${t.base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ method: 'bot.team', payload: {} }),
    })
    const body = await answer.json()
    assert.equal(body.ok, true)
    assert.deepEqual(boot.team, body.value, 'boot team and bot.team are the same projection, field for field')
    // 判据 R2.7.2：三个计数也随这条腿下发，且与 boot 的 stageSummary 同一份数。
    assert.deepEqual(body.stage, {
      bots: boot.stageSummary.bots,
      botSessions: boot.stageSummary.botSessions,
      rooms: boot.stageSummary.rooms,
    })
  } finally {
    await t.stop()
  }
})

// 判据 R5.3：封顶量的是「真发出去的那一份」。team 段现在也随载荷走，若把它接在
// 封顶之后再挂上去，大 roster 会从 300 000 B 的口子里漏出去（独立审查 Minor 7）。
test('R5.3 the byte cap measures the payload that ships, team included', async () => {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = []
  bridge.log = () => {}
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
  const rows = Array.from({ length: 10 }, (_, index) => ({
    sessionId: `s${index}`,
    updatedAt: Date.now(),
    running: false,
    projections: { asOfSeq: 5 },
  }))
  bridge.cachedSessionList = async () => ({ ok: true, value: { items: rows } })
  const fat = 'x'.repeat(900)
  bridge.invokeHarness = async (endpoint, args) => ({
    ok: true,
    value: {
      records: Array.from({ length: Math.min(Number(args?.request?.maxMessages ?? 24), 24) }, (_, index) => ({
        seq: index + 1,
        type: 'assistant/message',
        text: fat,
      })),
      hasMore: true,
    },
  })
  // 一支大 roster：team 段自己就占掉一百多 KB，封顶必须连它一起量。
  const view = {
    bots: Array.from({ length: 1200 }, (_, index) => ({ id: `bot-${index}`, name: '阿'.repeat(20) + index, sessionId: `bot-sess-${index}`, role: 'member' })),
    members: [],
    groups: [],
    rooms: [],
    approvals: [],
    questions: [],
  }
  bridge.botRoster = async () => ({ view })
  bridge._botTeamValue = { at: 0, view }

  const payload = await bridge.buildMobileBoot()
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  assert.ok(bytes <= BOOT_PAYLOAD_CAP_BYTES, `the shipped payload (team included) stays under the cap, saw ${bytes}`)
  assert.equal(payload.stageSummary.messages, countVisibleMessageUnits(payload.tails), 'the card still counts what actually shipped')
})
