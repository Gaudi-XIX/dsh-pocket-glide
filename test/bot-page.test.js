// DS Bot 页面（2026-10-24）：手机上一个独立路由 `/bot` + 独立脚本 `/bot.js`，
// 从首页右下角的浮窗进入。它为什么独立成页：壳资产有一份逐 locale 的字节预算
// （test/mobile-assets.test.js:ASSET_BUDGET_BYTES），而这一页要画成员列表、私聊、
// 群聊与审批卡，塞进壳里只能靠删现有页面换空间。独立路由的代价只有一条——
// 它必须进 service worker 的 BYPASS，否则任何导航都被兜成缓存的首页外壳
// （见 test/consent.test.js 与 test/pages-scroll-anchors.test.js 的同类断言）。
//
// 这一档钉四件事：文档长得对（结构地标 + 外链带 hash + 不可缓存）、脚本按内容
// 寻址可缓存、未配对寸步不让、首页那颗浮窗只在会话页里出现且指向 /bot。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, httpFetch } from './helpers.js'
import { BOT_PAGE_JS, renderBotPage } from '../lib/bot-page.js'
import { renderMobilePage } from '../lib/pages.js'

test('the Bot page is its own document: structure, hashed links, never cached', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(t.base + '/bot', { headers: { cookie } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store', 'the document is never replayed from a cache')
    const html = await res.text()

    // 三个区：会话列表、消息流、输入条。少任何一个这个页面都干不了活。
    assert.match(html, /id="bpList"/, 'the conversation list is there')
    assert.match(html, /id="bpMsgs"/, 'the transcript is there')
    assert.match(html, /id="bpComposer"/, 'the composer is there')
    assert.match(html, /id="bpBack"/, 'the back button returns to the list')
    assert.match(html, /<title>DS Bot<\/title>/)

    // 外链与主页同规矩：按内容 hash 取，改一次就换一个地址。
    const css = html.match(/<link rel="stylesheet" href="(\/app\.css\?h=[0-9a-f]+)">/)
    const js = html.match(/<script src="(\/bot\.js\?h=[0-9a-f]+)"><\/script>/)
    assert.ok(css, 'the stylesheet link is content-addressed')
    assert.ok(js, 'the script link is content-addressed')
    assert.doesNotMatch(html, /<script>/, 'no inline script: the page rides on the external one')
    assert.doesNotMatch(html, /nonce/, 'no nonce plumbing: nothing inline to guard')

    // 外链必须真的取得到，而且款式来自共享的壳样式表。
    const sheet = await httpFetch(t.base + css[1], { headers: { cookie } })
    assert.equal(sheet.status, 200)
    assert.match(await sheet.text(), /\.bot-fab/, 'the shared stylesheet carries the corner button')
  } finally { await t.stop() }
})

test('the Bot script is content-addressed and cacheable for as long as the shell is', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(t.base + '/bot.js', { headers: { cookie } })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /application\/javascript/)
    assert.match(res.headers.get('cache-control') || '', /max-age=604800/,
      'the URL carries the hash, so the phone may keep it a week')
    const body = await res.text()
    assert.equal(body, BOT_PAGE_JS, 'the route serves the module, byte for byte')
    // 它不直连 DS Bot 的 /api/bot：手机上唯一的通道是桥的 rpc（配对 cookie +
    // 白名单），新加的两个方法在 lib/constants.js 的白名单里。
    assert.match(body, /'\/api\/rpc'/, 'it talks through the bridge rpc, not straight to the Bot route')
    assert.match(body, /'bot\.team'/, 'and asks for the team under the whitelisted method name')
  } finally { await t.stop() }
})

test('an unpaired phone gets nothing from the Bot page or its script', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    for (const path of ['/bot', '/bot.js']) {
      const res = await httpFetch(t.base + path)
      assert.equal(res.status, 401, `${path} refuses an unpaired caller`)
    }
  } finally { await t.stop() }
})

test('the corner button lives on the conversation list only and points at /bot', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const html = await (await httpFetch(t.base + '/', { headers: { cookie } })).text()
    assert.match(html, /<a id="botFab" class="bot-fab" href="\/bot"/, 'the button is a plain link to the page')
    // 它必须挂在会话页里：聊天页右下角已经有「↓ 跳最新」与「停止子代理」，
    // 历史上那两个钮重叠过 32×31 px（点 ↓ 命中了停止）。放到会话页之外就是
    // 把那个事故重做一遍，所以这里按文档顺序钉死它在 sessionsView 内、chatView 之外。
    const listAt = html.indexOf('id="sessionsView"')
    const chatAt = html.indexOf('id="chatView"')
    const fabAt = html.indexOf('id="botFab"')
    assert.ok(listAt >= 0 && chatAt > listAt, 'the two views are both in the document')
    assert.ok(fabAt > listAt, 'the button sits inside the conversation list view')
    assert.ok(fabAt < chatAt, 'and never in the chat view')
  } finally { await t.stop() }
})

test('the Bot document follows the paired phone locale', () => {
  const zh = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  const en = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2', locale: 'en' })
  assert.match(zh, /<html lang="zh-CN">/)
  assert.match(en, /<html lang="en">/)
  assert.match(zh, /id="bpSend"[^>]*aria-label="发送"/, 'the zh document carries the send label')
  assert.match(en, /id="bpSend"[^>]*aria-label="Send"/, 'and the en one its own')
})

// ---------------------------------------------------------------------------
// 首页过滤（用户 2026-10-24：「DS BOT 不在主页的会话里面显示」，只在 /bot 页里）
// ---------------------------------------------------------------------------

/** The id the roster answers with — asked for at runtime, never written down. */
const BOT_WS = 'e82b4128-6d03-41a9-9537-d1b7553ac30a'

/** Two workspaces: one row belongs to the Bot team, one does not. */
function teamAndMine() {
  return [
    { sessionId: 'in-team', workspaceId: BOT_WS, updatedAt: 2_000, projections: { values: { title: 'team chat' } } },
    { sessionId: 'outside', workspaceId: 'ws-other', updatedAt: 1_000, projections: { values: { title: 'my own chat' } } }
  ]
}

test('the Bot team workspace never reaches the phone: not through session.list, not through the cold open', async () => {
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => {
        if (pathname === '/api/session/list') return { ok: true, value: { items: teamAndMine() } }
        return undefined
      },
      botRespond: (endpoint) => (endpoint === 'state'
        // The empty approvals live under `work`, where the page and `botTeamView`
        // both read them: a top-level `approvals: []` was a field the engine never
        // looks at, so that case could not have caught a real break (audit P2-3).
        ? { ok: true, value: { revision: 1, workspaceId: BOT_WS, bots: [], rooms: [], questions: { count: 0 }, work: { approvals: [] } } }
        : { ok: true, value: {} })
    }
  })
  try {
    const cookie = await t.pairMobile()
    const answer = await httpFetch(t.base + '/api/rpc', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'session.list', payload: {} })
    })
    assert.equal(answer.status, 200)
    const list = await answer.json()
    assert.equal(list.ok, true, list.error?.message)
    const ids = (list.value?.items ?? []).map((row) => row.sessionId)
    assert.deepEqual(ids, ['outside'], 'the Bot team row is removed before the answer is written')

    // The other two exits read the workspace snapshot, which the fake Harness
    // cannot follow-stream — so the test stands one up by hand and checks that
    // the removal reaches both of them too.
    t.bridge.workspaceSnapshot = {
      items: [
        { workspaceId: BOT_WS, name: 'DS Bot team', paths: [] },
        { workspaceId: 'ws-other', name: 'Mine', paths: [] }
      ],
      // A pin is an id with no row attached, so it is the one thing an id list can
      // still use to name a session the landing may not show (audit P1-1).
      pinnedSessionIds: ['in-team', 'outside']
    }
    const wsAnswer = await httpFetch(t.base + '/api/rpc', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'workspace.list', payload: {} })
    })
    const wsList = await wsAnswer.json()
    assert.equal(wsList.ok, true, wsList.error?.message)
    assert.deepEqual(
      (wsList.value?.items ?? []).map((item) => item.workspaceId),
      ['ws-other'],
      'workspace.list drops the card as well as the rows'
    )
    assert.deepEqual(
      wsList.value?.pinnedSessionIds ?? [],
      ['outside'],
      'and the pin pointing into that workspace goes with it'
    )

    // The cold open is the frame the phone paints before any list answer
    // arrives, so it has to carry the same absence.
    const boot = await (await httpFetch(t.base + '/api/boot', { headers: { cookie } })).json()
    assert.ok(Array.isArray(boot.sess?.items), `the cold open answered with rows: ${JSON.stringify(boot).slice(0, 120)}`)
    assert.deepEqual(
      (boot.sess?.items ?? []).map((row) => row.sessionId),
      ['outside'],
      'the cold open ships no row of the Bot team workspace'
    )
    assert.deepEqual(
      (boot.ws?.items ?? []).map((item) => item.workspaceId),
      ['ws-other'],
      'and no card for it either'
    )
  } finally { await t.stop() }
})

test('with no workspace id the landing hides nothing and says so once', async () => {
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => {
        if (pathname === '/api/session/list') return { ok: true, value: { items: teamAndMine() } }
        return undefined
      },
      botRespond: () => ({ ok: false, error: 'no roster', code: 'bot/unavailable' })
    }
  })
  try {
    const cookie = await t.pairMobile()
    const answer = await httpFetch(t.base + '/api/rpc', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'session.list', payload: {} })
    })
    const list = await answer.json()
    assert.equal(list.ok, true, list.error?.message)
    const ids = (list.value?.items ?? []).map((row) => row.sessionId)
    assert.deepEqual(ids, ['in-team', 'outside'], 'an unanswerable roster filters nothing instead of guessing')
    const warnings = t.logs.filter(({ message }) => message.includes('the landing hides nothing'))
    assert.equal(warnings.length, 1, 'and it says so exactly once, however many landings ask')
    assert.equal(warnings[0].level, 'warn')
  } finally { await t.stop() }
})

test('a Host without the roster is asked once a minute, not on every landing', async () => {
  // A Host whose ds-bot plugin is missing used to pay a full probe on every cold
  // open, because a null answer was never cached (audit P1-3): with a 30 s budget
  // that could hold the first frame for half a minute on each open.
  let rosterCalls = 0
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => {
        if (pathname === '/api/session/list') return { ok: true, value: { items: teamAndMine() } }
        return undefined
      },
      botRespond: () => {
        rosterCalls += 1
        return { ok: false, error: 'no roster', code: 'bot/unavailable' }
      }
    }
  })
  try {
    const cookie = await t.pairMobile()
    for (let landing = 0; landing < 3; landing += 1) {
      const answer = await httpFetch(t.base + '/api/rpc', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'session.list', payload: {} })
      })
      assert.equal((await answer.json()).ok, true)
    }
    assert.equal(rosterCalls, 1, 'the miss is remembered for the minute the id itself would have been trusted')
  } finally { await t.stop() }
})

test('the roster answer is cut down to what the page draws', async () => {
  // The Host's `state` view is its management surface: provider secrets and who
  // may use them, permissions, the model catalogue, prefs, and every Bot's and
  // group's `parts` (chats of sessions the landing hides). None of it is drawn by
  // the phone, and ~900 KB of it used to cross the tunnel on every poll (P1-2).
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      botRespond: () => ({
        ok: true,
        value: {
          revision: 7,
          workspaceId: BOT_WS,
          mainBotIds: ['chief'],
          bots: [{ id: 'chief', name: 'Chief', role: 'chief', sessionId: 's-chief', parts: ['s-hidden'], waiting: false }],
          rooms: [{ id: 'r-1', name: 'Flow', preview: 'hi', members: [{ id: 'chief', name: 'Chief' }], parts: ['s-hidden'] }],
          questions: { 's-hidden': { text: 'the question text stays off the wire' } },
          work: {
            approvals: [
              { id: 'a-1', botId: 'chief', tool: 'bash', reason: 'needs a shell', detail: { text: 'ls', code: 'E1' }, at: 1, answerable: true }
            ],
            bots: { chief: { tool: 'bash', since: 1 } },
            rooms: { 'r-1': [{ botId: 'chief', since: 1 }] },
            turns: [{ botId: 'chief' }]
          },
          secrets: [{ name: 'DSH_SECRET_TOKEN', bots: ['chief'] }],
          permissions: { shell: true },
          models: [{ provider: 'p', id: 'm' }],
          prefs: { theme: 'dark' }
        }
      })
    }
  })
  try {
    const cookie = await t.pairMobile()
    const answer = await httpFetch(t.base + '/api/rpc', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'bot.team', payload: {} })
    })
    const team = await answer.json()
    assert.equal(team.ok, true, team.error?.message)
    const text = JSON.stringify(team.value)
    for (const leaked of ['secrets', 'permissions', 'models', 'prefs', 'parts', 'turns', 's-hidden']) {
      assert.ok(!text.includes(leaked), `the roster answer carries no ${leaked}`)
    }
    assert.deepEqual(team.value.bots.map((bot) => bot.id), ['chief'], 'members still arrive')
    assert.deepEqual(team.value.rooms.map((room) => room.id), ['r-1'], 'groups still arrive')
    assert.equal(team.value.mainBotIds[0], 'chief')
    assert.deepEqual(team.value.questions, { count: 1 }, 'only the count of open questions travels')
    assert.equal(team.value.work.approvals[0].answerable, true, 'and the approvals stay answerable')
    assert.equal(team.value.work.approvals[0].detail.text, 'ls')
    // The live work map travels as what the rows draw: what the Bot is doing
    // now, and whether the group has anyone talking — nothing else.
    assert.deepEqual(team.value.bots[0].working, { tool: 'bash' }, 'the running tool rides with the member')
    assert.equal(team.value.rooms[0].running, true, 'a group with a running turn says so')
  } finally { await t.stop() }
})

test('a Host that stops answering keeps the last workspace hidden', async () => {
  // P2-5 (audit 2026-10-24): the probe used to hand `null` back whenever one
  // answer carried no id, so a Host that lost the roster for a minute showed
  // every session of the Bot team workspace again — and the log said "the
  // landing hides nothing" even when the previous id was still the one hiding.
  let failing = false
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => (pathname === '/api/session/list' ? { ok: true, value: { items: teamAndMine() } } : undefined),
      botRespond: (endpoint) => (endpoint === 'state'
        ? (failing
            ? { ok: false, error: 'no roster', code: 'bot/unavailable' }
            : { ok: true, value: { revision: 1, workspaceId: BOT_WS, bots: [], rooms: [], questions: { count: 0 }, work: { approvals: [] } } })
        : { ok: true, value: {} })
    }
  })
  try {
    const cookie = await t.pairMobile()
    const landing = async () => {
      const answer = await httpFetch(t.base + '/api/rpc', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'session.list', payload: {} })
      })
      const body = await answer.json()
      assert.equal(body.ok, true, body.error?.message)
      return (body.value?.items ?? []).map((row) => row.sessionId)
    }
    assert.deepEqual(await landing(), ['outside'], 'a known id hides its workspace')
    failing = true
    // Cross the minute the id would have been trusted for, so the next landing
    // has to probe again and gets nothing back.
    t.bridge.now = () => Date.now() + 10 * 60_000
    assert.deepEqual(await landing(), ['outside'], 'an unanswerable probe keeps the last id in force')
    const kept = t.logs.filter(({ message }) => message.includes('keeping the last known id'))
    assert.equal(kept.length, 1, 'the log names the id it is still hiding by')
    assert.equal(kept[0].level, 'warn')
    assert.ok(
      !t.logs.some(({ message }) => message.includes('the landing hides nothing')),
      'and no longer promises that nothing is hidden'
    )
  } finally { await t.stop() }
})

// ---------------------------------------------------------------------------
// 页面脚本真的跑起来（审查 P1-1，2026-10-24）
//
// 上面那些断言只读 `/bot.js` 的源串：页面逻辑整段坏掉，它们照样全绿，而审批卡
// 是这一批唯一的交付面。下面用一个刚够用的浏览器替身把 BOT_PAGE_JS 执行一遍，
// 覆盖四条分支 —— 审批卡两态、点击回话、发消息、读消息流。
// ---------------------------------------------------------------------------

/**
 * 壳的两条静态事实，都从发货 `/bot` 用的同一个 `renderBotPage` 产出里读：
 * - `ids`：壳里全部 `id="…"`。修复②的成因是脚本写了一个壳里不存在的 id
 *   （`bpChatTitle`），真机 TypeError 而替身「按需现造」照样绿 —— 所以 `$` 问
 *   壳外的 id 当场 throw。
 * - `ancestors`：每个 id 的祖先 id 链。修复③的成因是「`#bpMsgs` 嵌在 `#bpList`
 *   里，列表 hidden 把消息半区连坐隐藏」，那件事只有父子关系表达得了，孤立的
 *   hidden 布尔看不见（消费点在 node() 的 `visible`）。
 */
function shellShape(html = renderBotPage({ cssUrl: '/app.css?h=0', jsUrl: '/bot.js?h=0' })) {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id))
  const ancestors = new Map()
  // 壳里写死的初值就是真机的初值：标记里带 `hidden`/`disabled` 的节点，页面脚本
  // 必须自己把它们打开。修复④之所以逃过全部测试，正是替身把初值丢了——`bpSend`
  // 壳里是灰的，替身造出来却是可点的。
  const flags = new Map()
  const stack = []
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
  for (const [, closing, rawName, attrs] of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
    const name = rawName.toLowerCase()
    if (closing) {
      const at = stack.findLastIndex((open) => open.name === name)
      if (at >= 0) stack.length = at
      continue
    }
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1] ?? null
    if (id) {
      ancestors.set(id, stack.map((open) => open.id).filter(Boolean))
      flags.set(id, {
        hidden: /(^|\s)hidden(\s|\/|$)/.test(attrs),
        disabled: /(^|\s)disabled(\s|\/|$)/.test(attrs),
      })
    }
    if (!VOID.has(name) && !attrs.trimEnd().endsWith('/')) stack.push({ name, id })
  }
  return { ids, ancestors, flags }
}
const SHELL = shellShape()
const SHELL_IDS = SHELL.ids

/** 预热清单（不是白名单——权威是上面的 `SHELL_IDS`）：先把页面要碰的节点造出来。 */
const PAGE_IDS = ['bpBack', 'bpHome', 'bpReload', 'bpTitle', 'bpHint', 'bpList', 'bpSkel', 'bpPending', 'bpRoomsCount', 'bpRoomsList', 'bpMembersCount', 'bpMembersList', 'bpMsgs', 'bpComposer', 'bpPrompt', 'bpSend', 'bpToast', 'bpSwitchOverlay']

/**
 * A browser stand-in holding just what `/bot`'s script touches: ten elements
 * with textContent/innerHTML/hidden/disabled, the three event targets, a fetch
 * that answers `/api/rpc` from `answer(method, payload)`, and timers that never
 * fire (the page's pollers are not what these tests are about).
 */
function fakeBrowser({ answer = () => ({}), seed = null, hang = null } = {}) {
  const nodes = new Map()
  const nodeListeners = new Map()
  const windowListeners = new Map()
  const documentListeners = new Map()
  const calls = []
  function node(id) {
    // 壳里没有这个 id ⇒ 真机上是 `Cannot read properties of null`；替身不许再
    // 按需现造，否则「脚本引用了壳里不存在的节点」永远测不出来（修复②）。
    if (!SHELL_IDS.has(id)) throw new Error(`the page asked for #${id}, which the shell does not ship`)
    let made = nodes.get(id)
    if (!made) {
      // 初值取壳里标记写死的那些（`bpMsgs`/`bpComposer`/`bpToast` 出生就 hidden，
      // `bpSend` 出生就 disabled）——真机就是这样，页面脚本得自己打开它们。
      const born = SHELL.flags.get(id) ?? { hidden: false, disabled: false }
      made = {
        id,
        hidden: born.hidden,
        disabled: born.disabled,
        textContent: '',
        innerHTML: '',
        value: '',
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        style: {},
        addEventListener(type, fn) { nodeListeners.set(id + ':' + type, fn) },
        // 视觉可见性：真机由 CSS 裁决（祖先 hidden 连坐就是修复③的原形），孤立
        // 的 hidden 布尔表达不了。断言读 `visible`，页面脚本读的仍是 `hidden`。
        get visible() {
          if (made.hidden) return false
          return (SHELL.ancestors.get(id) ?? []).every((ancestor) => !nodes.get(ancestor)?.hidden)
        },
      }
      if (id === 'bpMsgs') {
        // A height to compensate with: forty pixels a row, the box one screen
        // tall. Without it scrollHeight is 0 and the "reading further back
        // leaves the view where it was" logic has nothing to move.
        Object.defineProperty(made, 'scrollHeight', {
          configurable: true,
          get: () => (made.innerHTML.match(/class="bp-(msg|divider|event|older)/g) || []).length * 40,
        })
        made.clientHeight = 300
      }
      nodes.set(id, made)
    }
    return made
  }
  for (const id of PAGE_IDS) node(id)
  // The page marks its two views on the body (`bp-list` / `bp-chat`) so the
  // floating buttons can trade places, and it drops `bp-ready`'s hairline once
  // a read lands. Both are assertions now, so the classes are recorded rather
  // than thrown away.
  const classes = new Set(['bp-list', 'bp-loading', 'bp-busy'])
  const body = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
  }
  const store = new Map()
  if (seed) for (const [key, value] of Object.entries(seed)) store.set(key, String(value))
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
  const document = {
    title: 'DS Bot',
    hidden: false,
    body,
    // The script reads the locale off <html lang> for its clock copy; the real
    // document pairs with a zh phone, so the stand-in says zh too.
    documentElement: { lang: 'zh-CN' },
    getElementById: (id) => node(id),
    addEventListener: (type, fn) => documentListeners.set(type, fn),
  }
  const navigations = []
  const historyReplaced = []
  // The page says its last word on the way out with a beacon, because a plain
  // fetch dies with the document that made it. The beacon is recorded apart
  // from the fetch log: a test must be able to tell which of the two carried it.
  const beacons = []
  const navigator = {
    // A Blob is not readable synchronously (String(blob) is just [object
    // Blob]), so the stub takes the URL and keeps the body it can read; the
    // payload itself is asserted on the page's side, where it was built.
    sendBeacon: (url, body) => {
      beacons.push({ url, body: typeof body === 'string' ? body : null })
      return true
    },
  }
  const window = {
    addEventListener: (type, fn) => windowListeners.set(type, fn),
    // One entry behind this page, as after tapping the landing's corner button.
    // A test that wants no entry behind it sets `window.history = null` before
    // the first click, or `window.history.length = 1`.
    history: {
      length: 2,
      back: () => navigations.push('back'),
      // The back key clears its hash with a replace so no entry lands between
      // this page and the landing; the stub applies it like a browser would.
      replaceState: (_state, _unused, url) => {
        historyReplaced.push([url])
        const mark = typeof url === 'string' ? url.indexOf('#') : -1
        location.hash = mark >= 0 ? url.slice(mark) : ''
      },
    },
  }
  const location = { hash: '', href: '', origin: 'http://127.0.0.1:9896', pathname: '/bot', search: '' }
  // Timers are collected instead of fired, so a test can choose the moment: the
  // page arms one timeout per rpc (its own give-up) and one per toast.
  const timers = []
  const fakeSetTimeout = (fn) => { timers.push(fn); return timers.length }
  const fetch = (url, options) => {
    const body = JSON.parse(options.body)
    calls.push({ method: body.method, payload: body.payload })
    if (hang && hang(body.method)) {
      // A bridge that accepts the call and never answers. The real fetch rejects
      // when the page's own AbortController fires; so does this one.
      return new Promise((resolve, reject) => {
        const signal = options.signal
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted.')
            error.name = 'AbortError'
            reject(error)
          })
        }
      })
    }
    const result = answer(body.method, body.payload)
    const failed = result && result.ok === false
    return Promise.resolve({
      ok: !failed,
      status: failed ? 409 : 200,
      json: () => Promise.resolve(failed
        ? { ok: false, error: { message: result.error, code: result.code } }
        : { ok: true, value: result }),
    })
  }
  const neverFire = () => 1
  new Function(
    'document', 'window', 'location', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Intl', 'localStorage', 'navigator',
    BOT_PAGE_JS
  )(document, window, location, fetch, neverFire, () => {}, fakeSetTimeout, () => {}, Intl, localStorage, navigator)
  return {
    node,
    calls,
    beacons,
    document,
    location,
    navigations,
    historyReplaced,
    window,
    classes,
    store,
    settle: async (rounds = 10) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve)) },
    fireWindow: (type) => windowListeners.get(type)(),
    fireDocument: (type) => documentListeners.get(type)(),
    /** Fire every timeout the page has armed so far (the page's own give-up). */
    fireTimers: () => { for (const fn of timers.splice(0)) fn() },
    click: (id, event) => {
      // 真机不给 disabled 控件派发 click。修复④正是栽在这上面：壳里 `bpSend`
      // 初始 `disabled`，代码里没有启用点，替身却能点动 ⇒ 发送类测试全绿而真机
      // 永久灰。替身照真机拦，删掉启用行的那天测试就红。
      if (node(id).disabled) throw new Error(`#${id} is disabled; a browser would not dispatch this click`)
      return nodeListeners.get(id + ':click')(event)
    },
  }
}

// 替身自己新加的两道门也要有锚——否则「加了守卫」这件事无法回归证明，门被
// 悄悄删掉时测试面照旧全绿。
test('the stand-in refuses an id the shell does not ship', () => {
  const page = fakeBrowser()
  assert.throws(() => page.node('bpChatTitle'), /does not ship/,
    'a script asking for a node the shell never renders is exactly the TypeError of 修复②')
})

test('the stand-in refuses a click on a disabled control, as a browser would', () => {
  const page = fakeBrowser()
  page.node('bpSend').disabled = true
  assert.throws(() => page.click('bpSend', {}), /is disabled/)
})

// `visible` 的价值全在祖先链上：解析器一旦退化成空 Map，它就退回成 `!hidden`，
// 那两条 visible 断言会永远绿（假绿）。所以先钉住解析器本身。
test('the shell shape reader really reads nesting', () => {
  const shape = shellShape('<div id="outer"><div class="x"><div id="inner" hidden></div></div></div>')
  assert.deepEqual(shape.ancestors.get('inner'), ['outer'], 'the id chain is what `visible` walks')
  assert.ok(shape.ids.has('inner'), 'and the id set comes from the same pass')
  assert.deepEqual(shape.ancestors.get('outer'), [], 'a top-level id has no ancestors — the reader invents none')
  assert.deepEqual(shape.flags.get('inner'), { hidden: true, disabled: false },
    'the born-hidden / born-disabled flags come off the same markup a browser would read (修复④)')
})

/** One approvalable tool request plus the member that asked for it. */
function teamWith(...approvals) {
  return {
    bots: [{ id: 'chief', name: 'Chief', role: '主', sessionId: 's-chief' }],
    rooms: [{ id: 'r-flow', name: 'Flow', preview: 'hi', members: [{ id: 'chief', name: 'Chief' }] }],
    mainBotIds: ['chief'],
    questions: { count: 0 },
    work: { approvals: approvals },
  }
}

test('an approval draws its two buttons only when the Host says the phone may answer', async () => {
  const page = fakeBrowser({
    answer: (method) => (method === 'bot.team'
      ? teamWith({ id: 'a-1', botId: 'chief', tool: 'bash', reason: 'needs a shell', answerable: true })
      : {}),
  })
  await page.settle()
  const html = page.node('bpPending').innerHTML
  assert.match(html, /data-approve="allow" data-id="a-1"/, '允许 carries the card id')
  assert.match(html, /data-approve="reject" data-id="a-1"/, '拒绝 carries the same id')
  assert.match(html, /Chief · bash/, 'the card names who asked and for what')
  assert.equal(page.node('bpComposer').hidden, true, 'the list is what a landing shows first')

  const button = { disabled: false, getAttribute: (name) => (name === 'data-id' ? 'a-1' : 'allow') }
  page.click('bpList', { target: { closest: (selector) => (selector === '[data-approve]' ? button : null) } })
  await page.settle()
  assert.equal(button.disabled, true, '答过的键当场变灰，不等回包')
  assert.deepEqual(page.calls.find((call) => call.method === 'bot.approval').payload, { id: 'a-1', choice: 'allow' })
  assert.equal(page.node('bpToast').textContent, '已允许')
})

test('a card the desktop must answer gets no buttons', async () => {
  const page = fakeBrowser({
    answer: (method) => (method === 'bot.team'
      ? teamWith({ id: 'a-2', botId: 'chief', tool: 'write', reason: 'desktop only', answerable: false })
      : {}),
  })
  await page.settle()
  assert.match(page.node('bpPending').innerHTML, /这条要在电脑上回答/)
  assert.ok(!page.node('bpPending').innerHTML.includes('data-approve='), 'the phone draws no button it cannot answer')
})

test('an answer the Host already closed hands the button back and says why', async () => {
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith({ id: 'a-1', botId: 'chief', tool: 'bash', reason: 'needs a shell', answerable: true })
      if (method === 'bot.approval') return { ok: false, error: 'this card is gone', code: 'bot/stale' }
      return {}
    },
  })
  await page.settle()
  const button = { disabled: false, getAttribute: (name) => (name === 'data-id' ? 'a-1' : 'reject') }
  page.click('bpList', { target: { closest: (selector) => (selector === '[data-approve]' ? button : null) } })
  await page.settle()
  assert.equal(button.disabled, false, '没答上就把键还回去')
  assert.match(page.node('bpToast').textContent, /没答上：this card is gone/)
  assert.deepEqual(page.calls.find((call) => call.method === 'bot.approval').payload, { id: 'a-1', choice: 'reject' })
})

test('a message typed here goes out as that session, in the shape the landing uses', async () => {
  const page = fakeBrowser({ answer: (method) => (method === 'session.history' ? { events: [] } : {}) })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=' + encodeURIComponent('Chief')
  page.fireWindow('hashchange')
  await page.settle()
  assert.equal(page.node('bpTitle').textContent, 'Chief')
  assert.equal(page.node('bpComposer').hidden, false, '进入对话就把输入条放出来')
  assert.equal(page.node('bpList').hidden, true, '并把列表让位')
  assert.equal(page.node('bpMsgs').visible, true,
    'the transcript stays visible while the list is hidden — put it back inside #bpList and this goes false (修复③)')
  assert.equal(page.node('bpBack').hidden, false, '会话里才有返回')
  assert.equal(page.node('bpSend').disabled, false, '发送键随会话启用——真机的键在壳里就是灰的，启用只能发生在打开时')

  page.node('bpPrompt').value = '在吗'
  page.click('bpSend', {})
  await page.settle()
  const sent = page.calls.find((call) => call.method === 'session.prompt')
  assert.equal(sent.payload.sessionId, 's-chief', '私聊与群聊用的是同一个 sessionId')
  assert.equal(sent.payload.mode, 'queue')
  assert.deepEqual(sent.payload.content, [{ type: 'text', text: '在吗' }])
  assert.equal(typeof sent.payload.clientTimeZone, 'string')
  assert.equal(page.node('bpPrompt').value, '', '发出去之后输入框才清空')
  // The optimistic row: the words were on screen before the round trip answered,
  // and they stay until the Host shows the message itself.
  assert.match(page.node('bpMsgs').innerHTML, /class="bp-msg user is-pending">在吗</, 'the send paints at once, marked pending')
})

test('the transcript keeps what was said and drops the machinery', async () => {
  const page = fakeBrowser({
    answer: (method) => (method === 'session.history'
      ? {
          events: [
            { event: { type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } } } },
            { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在' }, { type: 'tool_use', id: 't-1' }] } } } },
            { event: { type: 'assistant/reasoning', data: { text: '先想一想' } } },
          ],
        }
      : {}),
  })
  await page.settle()
  page.location.hash = '#s=r-flow&k=room&t=Flow'
  page.fireWindow('hashchange')
  await page.settle()
  const msgs = page.node('bpMsgs').innerHTML
  assert.match(msgs, /class="bp-msg user">你好</)
  assert.match(msgs, /class="bp-msg assistant">在</)
  assert.ok(!msgs.includes('tool_use'), '工具调用不进手机的消息流')
  assert.ok(!msgs.includes('先想一想'), '思考也不进')
})

// ---------------------------------------------------------------------------
// 设计底座（用户 2026-10-27）：列表渲染只进槽位、返回只在会话里、时间与状态
// 和 landing 同一套哲学 —— 有数据就显示，没有就不占位。
// ---------------------------------------------------------------------------

test('the roster paints into the slots it was handed, never over the page itself', async () => {
  const page = fakeBrowser({ answer: (method) => (method === 'bot.team' ? teamWith() : {}) })
  await page.settle()
  assert.equal(page.node('bpList').innerHTML, '', 'the scroll box itself is never rewritten — the roster lands in the slots')
  assert.match(page.node('bpRoomsList').innerHTML, /data-open="room" data-id="r-flow"/, 'the group row lands in its slot')
  assert.match(page.node('bpMembersList').innerHTML, /data-sid="s-chief"/, 'the member row lands in its slot')
  assert.equal(page.node('bpRoomsCount').textContent, '1')
  assert.equal(page.node('bpMembersCount').textContent, '1')
  assert.equal(page.node('bpMsgs').hidden, true, 'the chat half survived the paint: the old bug destroyed it')
  assert.equal(page.node('bpMsgs').visible, false, 'list view: the transcript is hidden, so it is not visible')
})

test('a working bot and a talking group say so on their rows', async () => {
  const team = teamWith()
  team.bots[0].working = { tool: 'bash' }
  team.rooms[0].running = true
  const page = fakeBrowser({ answer: (method) => (method === 'bot.team' ? team : {}) })
  await page.settle()
  const members = page.node('bpMembersList').innerHTML
  assert.match(members, /正在 bash/, 'the member row names what the Bot is running')
  assert.match(members, /is-busy/, 'the avatar carries the busy mark')
  const rooms = page.node('bpRoomsList').innerHTML
  assert.match(rooms, /讨论中/, 'the group row says a turn is running there')
  assert.match(rooms, /is-busy/, 'the group chip carries the busy mark')
})

test('a waiting bot gets the amber tag, an idle bot keeps its role alone', async () => {
  const team = teamWith()
  team.bots[0].waiting = true
  const page = fakeBrowser({ answer: (method) => (method === 'bot.team' ? team : {}) })
  await page.settle()
  assert.match(page.node('bpMembersList').innerHTML, /等模型/, 'the greeting-on-hold state is named')
})

test('a message carries the same three-tier clock the landing stamps', async () => {
  const now = new Date()
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 30).getTime()
  const page = fakeBrowser({
    answer: (method) => (method === 'bot.team' ? teamWith() : method === 'session.history'
      ? { events: [saidByUser('在吗', 2, at), saidByBot('在', 3, at)], hasMore: false }
      : {}),
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle()
  const msgs = page.node('bpMsgs').innerHTML
  assert.match(msgs, /class="bp-tail">10:30</, 'today prints the time of day, like the landing')
  assert.ok((msgs.match(/class="bp-tail">/g) || []).length === 2, 'both sides of the chat carry the stamp')
})

test('a divider stamps when the earlier part began', async () => {
  const now = new Date()
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5).getTime()
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') return { events: [saidByBot('新的一段', 9)], hasMore: false }
      if (method === 'bot.earlier') return { items: [{ kind: 'divider', time: at }, { kind: 'bot', text: '旧的一段' }], cursor: null }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle()
  const msgs = page.node('bpMsgs').innerHTML
  assert.match(msgs, /09:05 · 更早的记录/, 'the divider prints the part boundary like the landing does')
})

test('a send that fails takes its optimistic row back and says why', async () => {
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') return { events: [saidByBot('在', 3)], hasMore: false }
      if (method === 'session.prompt') return { ok: false, error: '队列满了', code: 'bot/busy' }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle()
  page.node('bpPrompt').value = '在吗'
  page.click('bpSend', {})
  await page.settle()
  const msgs = page.node('bpMsgs').innerHTML
  assert.ok(!msgs.includes('is-pending'), 'the failed optimistic row came off the screen')
  assert.ok(!msgs.includes('在吗'), 'and it did not stay as a plain row either')
  assert.match(page.node('bpToast').textContent, /没发出去/)
})

test('the Host showing the message takes over from the optimistic row', async () => {
  let historyTurn = 0
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') {
        historyTurn += 1
        return historyTurn < 2
          ? { events: [], hasMore: false }
          : { events: [saidByUser('在吗', 9, Date.now())], hasMore: false }
      }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle()
  page.node('bpPrompt').value = '在吗'
  page.click('bpSend', {})
  await page.settle()
  const msgs = page.node('bpMsgs').innerHTML
  assert.match(msgs, /在吗/, 'the words are on screen — optimistic first, then the Host row')
  assert.ok(!msgs.includes('is-pending'), 'the Host row took over, so nothing stays pending')
  assert.equal((msgs.match(/在吗/g) || []).length, 1, 'and the optimistic copy did not double with the real row')
})

test('the back key steps out of a chat, and the list itself carries no back', async () => {
  const page = fakeBrowser({
    answer: (method) => (method === 'bot.team' ? teamWith() : { events: [] }),
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle()
  assert.equal(page.node('bpComposer').hidden, false, 'a chat is open')
  assert.equal(page.node('bpBack').hidden, false, 'the back key belongs to the chat')

  page.click('bpBack')
  assert.equal(page.location.hash, '', 'the one press steps back to the list')
  assert.equal(page.historyReplaced.length, 1, 'the clear is a replace — no entry may land between this page and the landing')
  assert.deepEqual(page.navigations, [], 'and does not leave the page')
  page.fireWindow('hashchange')
  await page.settle()
  assert.equal(page.node('bpBack').hidden, true, 'the list has no back: from a chat back to the list, and that is all')
  assert.equal(page.node('bpHome').hidden, false, 'the way out of this page is the corner button')

  page.click('bpBack')
  assert.deepEqual(page.navigations, [], 'a back press on the list does nothing — the key is not even visible')
})

test('a page opened with nothing behind it still finds the way home', async () => {
  const page = fakeBrowser()
  await page.settle()
  page.window.history.length = 1
  page.click('bpHome', { preventDefault() {} })
  assert.deepEqual(page.navigations, [], 'there is nothing to go back to')
  assert.equal(page.location.href, '/', 'so it names the landing itself')
})

test('a page opened from another site goes to the landing, not back to that site', async () => {
  const page = fakeBrowser()
  await page.settle()
  // Opened from a chat app or a search result: there is an entry behind this
  // page, but it is not this site's landing.
  page.document.referrer = 'https://evil.example/post'
  page.click('bpHome', { preventDefault() {} })
  await page.settle()
  assert.deepEqual(page.navigations, [], 'going back would hand the phone to the site that linked here')
  assert.equal(page.location.href, '/', 'so the Pocket button names the landing itself')
})

// ---------------------------------------------------------------------------
// 更早的对话（用户 2026-10-24：「看不到这个 Chief 之前的聊天记录」）
//
// 一个 Bot 的私聊不是一条 Session：它长了就交班，新的一段只装最新的几轮，之前
// 的全在 `bot.earlier` 里。打开时只读当前那一段，等于把一年的记录画成一句问候。
// 下面三条钉住：打开就自动向前翻、够一屏就停（剩下的交给按钮）、群聊不走这条路。
// ---------------------------------------------------------------------------

/** @param {string} text @param {number} [seq] the Host's own event number, used to page backwards */
function saidByBot(text, seq, time) {
  return { event: { type: 'assistant/message', seq, data: { message: { messageTime: time, content: [{ type: 'text', text }] } } } }
}

/** A user row with a Host timestamp, the field the transcript clock prints. */
function saidByUser(text, seq, time) {
  return { event: { type: 'user/message', seq, data: { message: { source: { kind: 'user' }, messageTime: time, content: [{ type: 'text', text }] } } } }
}

/** One page of earlier items: n Bot messages, oldest last (the Host pages newest-first). */
function earlierPage(n, prefix) {
  const items = []
  for (let i = 0; i < n; i += 1) items.push({ kind: 'bot', text: prefix + i })
  return items
}

test('opening a Bot chat reaches back past the newest part to what came before it', async () => {
  let pages = 0
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') return { events: [saidByBot('最新那一段的话')] }
      if (method === 'bot.earlier') {
        pages += 1
        if (pages === 1) return { items: [{ kind: 'user', text: '上一段说的话' }], cursor: { part: 2, beforeSeq: 40 } }
        return { items: [{ kind: 'divider' }, { kind: 'user', text: '最早的那句话' }], cursor: null }
      }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(60)

  const msgs = page.node('bpMsgs').innerHTML
  assert.match(msgs, /class="bp-msg user">最早的那句话/, 'the oldest part is drawn, not just the newest')
  assert.match(msgs, /class="bp-msg user">上一段说的话/, 'and the part right before it')
  assert.match(msgs, /class="bp-divider"/, 'a divider marks where one part begins')
  assert.match(msgs, /class="bp-msg assistant">最新那一段的话/, 'the part the page was pointed at stays at the bottom')

  const calls = page.calls.filter((call) => call.method === 'bot.earlier')
  assert.equal(calls.length, 2, 'it keeps asking until the Host says there is nothing older')
  assert.deepEqual(calls[0].payload, { sessionId: 's-chief', cursor: null }, 'the first page starts from the newest end')
  assert.deepEqual(calls[1].payload, { sessionId: 's-chief', cursor: { part: 2, beforeSeq: 40 } }, 'and carries the cursor it got back')
  assert.ok(!msgs.includes('data-earlier'), 'with nothing older left there is no button to press')
})

test('one screen full is where the automatic reach-back stops, the button does the rest', async () => {
  let pages = 0
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') return { events: [saidByBot('当前这一段')] }
      if (method === 'bot.earlier') {
        pages += 1
        return { items: earlierPage(30, 'p' + pages + '-'), cursor: { part: pages, beforeSeq: 7 } }
      }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(80)

  const auto = page.calls.filter((call) => call.method === 'bot.earlier')
  assert.equal(auto.length, 2, '60 rows is a screen: two pages of 30 and it stops on its own')
  assert.match(page.node('bpMsgs').innerHTML, /data-earlier="1"/, 'the rest is behind the button')

  const button = { disabled: false }
  page.click('bpMsgs', { target: { closest: (selector) => (selector === '[data-earlier]' ? button : null) } })
  await page.settle(20)
  const all = page.calls.filter((call) => call.method === 'bot.earlier')
  assert.equal(all.length, 3, 'the button asks for exactly one more page')
  assert.deepEqual(all[2].payload, { sessionId: 's-chief', cursor: { part: 2, beforeSeq: 7 } }, 'from where the automatic fill stopped')
})

test('a group chat is one Session, so it has no earlier parts to reach for', async () => {
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') return { events: [saidByBot('群里的话')] }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=r-flow&k=room&t=Flow'
  page.fireWindow('hashchange')
  await page.settle(40)
  assert.equal(page.calls.filter((call) => call.method === 'bot.earlier').length, 0, 'a group is asked nothing it cannot answer')
  assert.match(page.node('bpMsgs').innerHTML, /群里的话/)
})

test('one long part is walked back within itself before the part before it', async () => {
  // 60 条一页只是一个窗口：这个 Bot 换段之前的那一段本身就有 180 条，
  // 只读最新一页会从「这一段的最新一条」直接跳到「上一段」，中间 120 条凭空消失。
  const page = fakeBrowser({
    answer: (method, payload) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') {
        if (payload.beforeSeq === undefined) return { events: [saidByBot('这一段最新一句', 300)], hasMore: true }
        if (payload.beforeSeq === 300) return { events: [saidByBot('段内更早的一句', 200)], hasMore: true }
        return { events: [saidByBot('这一段的开头', 100)], hasMore: false }
      }
      if (method === 'bot.earlier') return { items: [{ kind: 'user', text: '上一段说的话' }], cursor: null }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(80)

  const history = page.calls.filter((call) => call.method === 'session.history').map((call) => call.payload)
  assert.equal(history.length, 3, 'the first read plus two pages back inside the part')
  assert.equal(history[0].beforeSeq, undefined, 'the newest page needs no anchor')
  assert.equal(history[1].beforeSeq, 300, 'the page after it starts at the oldest seq seen')
  assert.equal(history[2].beforeSeq, 200)
  assert.equal(history[2].maxMessages, 60, 'every page asks for the same window')

  const order = page.calls.map((call) => call.method)
  assert.deepEqual(order.filter((name) => name === 'bot.earlier').length, 1, 'the part before it is read once, at the end')
  assert.equal(order.lastIndexOf('session.history') < order.indexOf('bot.earlier'), true,
    'and never before this part has been read back to its own start')

  const html = page.node('bpMsgs').innerHTML
  const at = (text) => html.indexOf(text)
  assert.ok(at('上一段说的话') >= 0 && at('这一段的开头') >= 0 && at('段内更早的一句') >= 0 && at('这一段最新一句') >= 0,
    'every page of both kinds is on screen')
  assert.ok(at('上一段说的话') < at('这一段的开头'), 'the older part sits above this part')
  assert.ok(at('这一段的开头') < at('段内更早的一句') && at('段内更早的一句') < at('这一段最新一句'),
    'and this part reads top to bottom in order, no gap in the middle')
})

test('a host that keeps claiming more without moving is read once, not forever', async () => {
  // The Host may hold a stale cursor and hand the same page back while still
  // saying hasMore. Without a guard, every tap stacks the same sixty rows.
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') return { events: [saidByBot('最新一句', 300)], hasMore: true }
      // A fresh object each time, the way the bridge re-makes the cursor on
      // every hop: identity would never see the same value come back.
      if (method === 'bot.earlier') return { items: [{ kind: 'user', text: '上一段的话' }], cursor: { part: 2, beforeSeq: 40 } }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(80)

  const history = () => page.calls.filter((call) => call.method === 'session.history').length
  const earlier = () => page.calls.filter((call) => call.method === 'bot.earlier').length
  assert.equal(history(), 2, 'the newest page, then one page that brought nothing older')
  assert.equal(earlier(), 0, 'the reach-back stops there rather than looping in place')

  const button = { disabled: false }
  const tap = () => page.click('bpMsgs', { target: { closest: (selector) => (selector === '[data-earlier]' ? button : null) } })

  tap()
  await page.settle(20)
  assert.equal(earlier(), 1, 'the button reads the other kind of before once')
  assert.equal(page.node('bpMsgs').innerHTML.split('上一段的话').length - 1, 1, 'that page is drawn once')

  tap()
  await page.settle(20)
  assert.equal(earlier(), 2, 'a cursor that did not move ends it')
  assert.equal(page.node('bpMsgs').innerHTML.split('上一段的话').length - 1, 1, 'and its repeat is not stacked on')
  assert.ok(!page.node('bpMsgs').innerHTML.includes('data-earlier'), 'with nothing further to read the button is gone')

  tap()
  await page.settle(20)
  assert.equal(earlier(), 2, 'and a tap on a button that is no longer drawn asks nothing')
})

test('a read that fails after the reader left the conversation writes nothing', async () => {
  let page
  let left = false
  page = fakeBrowser({
    answer: (method, payload) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history' && payload.sessionId === 's-a') {
        if (!left) {
          left = true
          // The reader steps back to the list while this read is in flight.
          page.location.hash = ''
          page.fireWindow('hashchange')
        }
        return { ok: false, error: 'the read blew up', code: 'bot/boom' }
      }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-a&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(60)

  assert.equal(page.node('bpList').hidden, false, 'the reader is on the list')
  assert.doesNotMatch(page.node('bpMsgs').innerHTML, /读不到消息/,
    'a failure from the conversation that was left does not land on the list')
})

test('a page the Host hands back out of order is still drawn oldest first', async () => {
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') {
        return { events: [saidByBot('第三句', 30), saidByBot('第一句', 10), saidByBot('第二句', 20)] }
      }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(60)

  const html = page.node('bpMsgs').innerHTML
  const at = (text) => html.indexOf(text)
  assert.ok(at('第一句') >= 0 && at('第二句') >= 0 && at('第三句') >= 0, 'all three are drawn')
  assert.ok(at('第一句') < at('第二句') && at('第二句') < at('第三句'),
    'in the order they were said, not the order they arrived')
})

test('reading further back leaves the reader looking at the same message', async () => {
  const ROW = 40
  const page = fakeBrowser({
    answer: (method, payload) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') {
        // A full screen already, so the automatic fill stops and the button is
        // the only thing that reads on.
        if (payload.beforeSeq === undefined) {
          return { events: Array.from({ length: 60 }, (_, i) => saidByBot(`最新第 ${i} 句`, 400 - i)), hasMore: true }
        }
        return { events: Array.from({ length: 10 }, (_, i) => saidByBot(`更早第 ${i} 句`, 200 - i)), hasMore: false }
      }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(60)

  const box = page.node('bpMsgs')
  const beforeHeight = box.scrollHeight
  const beforeTop = 0
  box.scrollTop = beforeTop // the reader scrolled back to the top of what is loaded

  const button = { disabled: false }
  page.click('bpMsgs', { target: { closest: (selector) => (selector === '[data-earlier]' ? button : null) } })
  await page.settle(20)

  assert.equal(box.scrollHeight - beforeHeight, 10 * ROW, 'ten older rows were added above')
  assert.equal(box.scrollTop, beforeTop + 10 * ROW,
    'and the view moved down by exactly their height, so the same message is still in front of the reader')
})

// ---------------------------------------------------------------------------
// 切页不再是一次空白（用户 2026-10-24：「每次从 Pocket 切到 bot 页面的时候会很卡」）
//
// 四条：列表与聊天各自该露哪个浮窗、离开前先给首页起个头、上次的名单先画出来、
// 数据一到顶部那条线就撤。前两条是需求本身，后两条是「不空白」的判据。
// ---------------------------------------------------------------------------

test('the list shows the way home, and taking it says so before leaving', async () => {
  const page = fakeBrowser({ answer: () => ({}) })
  await page.settle()

  assert.ok(page.classes.has('bp-list'), 'the list is the side of the page the way home belongs on')
  assert.ok(!page.classes.has('bp-chat'))

  page.click('bpHome', { preventDefault() {} })
  await page.settle()

  const beacon = page.beacons.find((entry) => entry.url === '/api/rpc')
  assert.ok(beacon, 'the hop says so while this page is still going, on the one channel that survives it')
  assert.deepEqual(page.navigations, ['back'], 'and the landing is reached by going back, not by a new entry')
})

test('the last word on the way out travels as a beacon, because the page is already going', async () => {
  const page = fakeBrowser({ answer: () => ({}) })
  await page.settle()

  page.click('bpHome', { preventDefault() {} })
  await page.settle()

  // The navigation happens in the same turn, which is exactly when a plain
  // fetch gets cancelled. The cue must ride the one channel the browser still
  // finishes for a dying document — and must not also be sent as a fetch.
  assert.equal(page.beacons.length, 1, 'one beacon, and nothing else, carries the cue')
  assert.equal(page.beacons[0].url, '/api/rpc', 'and it goes to the same door every other call uses')
  assert.equal(page.calls.filter((call) => call.method === 'page.cue').length, 0,
    'the cue is not sent twice: the beacon is the one the browser keeps')
})

test('a chat keeps the way back to the list, not to the landing', async () => {
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') return { events: [saidByBot('在', 3)], hasMore: false }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(30)

  assert.ok(page.classes.has('bp-chat'), 'the chat is the side of the page that offers the way back to the list')
  assert.ok(!page.classes.has('bp-list'))
})

test('the last roster is on screen before the team read returns, and carries no approval card', async () => {
  const recalled = {
    bots: [{ id: 'b-chief', name: 'Chief', role: 'Chief of Staff', sessionId: 's-chief' }],
    rooms: [],
    mainBotIds: ['b-chief'],
    questions: null,
    at: Date.now()
  }
  // The read fails: whatever is on screen can only have come from the recall.
  const page = fakeBrowser({
    seed: { pocketBotTeam: JSON.stringify(recalled) },
    answer: (method) => (method === 'bot.team' ? { ok: false, error: '连不上', code: 'bot/down' } : {}),
  })
  await page.settle(20)

  assert.ok(page.node('bpMembersList').innerHTML.includes('Chief'),
    'the roster the phone drew last time is painted at once, before any read returns')
  assert.ok(!page.node('bpPending').innerHTML.includes('data-approve'),
    'no 允许/拒绝 button comes back from a copy — a stale card must not be answerable')
})

test('the copy kept for the next open carries the rows and no approval card', async () => {
  const page = fakeBrowser({
    answer: (method) => (method === 'bot.team'
      ? teamWith({ id: 'a-1', botId: 'chief', tool: 'bash', reason: 'needs a shell', answerable: true })
      : {}),
  })
  await page.settle()
  const kept = JSON.parse(page.store.get('pocketBotTeam'))
  assert.ok(Array.isArray(kept.bots) && kept.bots.length > 0, 'the rows are what the shortcut is for')
  assert.ok(!('work' in kept), 'the live approvals are left out of the copy')
  assert.ok(!JSON.stringify(kept).includes('a-1'), 'and no card id survives in it')
})

test('the hairline stops once the team read lands', async () => {
  const page = fakeBrowser({ answer: () => ({}) })
  assert.ok(!page.classes.has('bp-ready'), 'a read is still in flight at the first paint')
  assert.ok(page.classes.has('bp-busy'), 'the busy mark drives the hairline animation')
  await page.settle()
  assert.ok(page.classes.has('bp-ready'), 'and the progress hairline goes away when it lands')
  assert.ok(!page.classes.has('bp-busy'), 'the animation class itself is removed — ready only hides the skeleton')
})

test('the hairline stops when the read fails, not only when it succeeds', async () => {
  const page = fakeBrowser({
    answer: (method) => (method === 'bot.team' ? { ok: false, error: '连不上', code: 'bot/down' } : {}),
  })
  assert.ok(!page.classes.has('bp-ready'), 'the read is in flight')
  await page.settle()
  assert.ok(page.classes.has('bp-ready'), 'a failed read must not leave the hairline running for ever')
  assert.ok(!page.classes.has('bp-busy'), 'a failed read drops the animation class too')
  assert.match(page.node('bpHint').textContent, /连不上 DS Bot/)
})

test('an unpaired clear empties the slots, never the scroll box that owns the skeleton', async () => {
  let teamReads = 0
  const page = fakeBrowser({
    answer: (method) => {
      if (method !== 'bot.team') return {}
      teamReads += 1
      if (teamReads === 1) return teamWith()
      return { ok: false, error: '未配对', code: 'pocket/unpaired' }
    },
  })
  await page.settle()
  assert.match(page.node('bpMembersList').innerHTML, /Chief/, 'the roster is drawn first')
  // The door then says the phone is unpaired (a fresh read, like the visibility
  // poller would make): content must go, but the slots that renderTeam paints
  // into must survive — emptying bpList itself pulled the skeleton nodes out of
  // the document and every later renderTeam died on a null $().
  page.fireDocument('visibilitychange')
  await page.settle()
  assert.equal(teamReads, 2, 'a visible page re-reads its roster')
  assert.equal(page.node('bpRoomsList').innerHTML, '', 'room rows are cleared')
  assert.equal(page.node('bpMembersList').innerHTML, '', 'member rows are cleared')
  assert.equal(page.node('bpRoomsCount').textContent, '0', 'counts go to zero')
  // Not "bpMsgs exists" — the stand-in's node() never returns null, so that
  // assertion is always true (audit 2026-10-27 bundle E). What the clear must
  // not touch is the chat half's own state.
  assert.equal(page.node('bpMsgs').hidden, true, 'the chat half keeps its state through the clear')
})

test('a bridge that never answers gives up instead of loading for ever', async () => {
  const page = fakeBrowser({ hang: (method) => method === 'bot.team' })
  await page.settle()
  assert.ok(!page.classes.has('bp-ready'), 'still waiting, so the hairline is right to run')
  page.fireTimers()
  await page.settle()
  assert.ok(page.classes.has('bp-ready'), 'the page stops waiting and says so')
  assert.match(page.node('bpHint').textContent, /等了 12 秒没有回音/)
})


// ---------------------------------------------------------------------------
// 预热（2026-10-24 用户 m00048「切到 bot 页很卡」+ m00191「不要死加载」）：
// 首页浮窗被按下的那一刻，桥先去把 bot 页第一屏要读的东西读了。它不进
// 白名单——白名单是「能翻成 Host 端点」的封闭集合，而 cue 是桥自己的动作，
// 只在两个页面之间点火，所以它走前置分支、只认两个页名。
// ---------------------------------------------------------------------------

const cue = (t, cookie, page) => httpFetch(t.base + '/api/rpc', {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ method: 'page.cue', payload: { page } })
})

test('the cue stays outside the allowlist and only names pages that exist', async () => {
  const { RPC_ALLOWLIST } = await import('../lib/constants.js')
  assert.ok(!RPC_ALLOWLIST.has('page.cue'),
    'the cue is the bridge warming itself, not another way to reach the Host')

  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    assert.equal((await cue(t, cookie, 'bot')).status, 200)
    assert.equal((await cue(t, cookie, 'landing')).status, 200)
    assert.equal((await cue(t, cookie, 'nope')).status, 400, 'a page the bridge cannot warm is refused')
    assert.equal((await cue(t, cookie, '../../etc')).status, 400, 'the name is matched, never resolved')

    // 前置分支不等于绕过门：/api/rpc 整条路由都在配对门之后，cue 也不例外。
    const reachedBefore = t.harness.records.calls.filter((c) => c.url === '/api/bot').length
    assert.equal((await cue(t, '', 'bot')).status, 401, 'an unpaired caller cannot start a read either')
    assert.equal(t.harness.records.calls.filter((c) => c.url === '/api/bot').length, reachedBefore,
      'and nothing reached the Host from it')

    // 前置分支也不在同源门之前：sendBeacon 正是跨站伪造的典型路径，而 cue 是
    // 唯一由 sendBeacon 触发的调用。
    const forged = await httpFetch(t.base + '/api/rpc', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ method: 'page.cue', payload: { page: 'bot' } })
    })
    assert.equal(forged.status, 403, 'a forged cue is refused before it can warm anything')
    assert.equal(t.harness.records.calls.filter((c) => c.url === '/api/bot').length, reachedBefore,
      'and no read left the bridge for it')
  } finally { await t.stop() }
})

test('the cue reads what the Bot page will ask for, so that page finds it ready', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const botCalls = () => t.harness.records.calls.filter((c) => c.url === '/api/bot').length

    const before = botCalls()
    assert.equal((await cue(t, cookie, 'bot')).status, 200)
    // 预热心是在 respond 之后自己跑的：它不发请求给首页，等这一拍。
    await new Promise((r) => setTimeout(r, 200))
    const warmed = botCalls()
    assert.equal(warmed, before + 1, 'one read starts the moment the phone is told the page will open')

    const res = await httpFetch(t.base + '/api/rpc', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'bot.team', payload: {} })
    })
    // bot.team 的应答是 Host 的原生信封，不套 client-request 的 result 层。
    const result = await res.json()
    assert.equal(result.ok, true, 'the page read still works')
    assert.equal(botCalls(), warmed, 'and it is served from the read the cue already paid for')
  } finally { await t.stop() }
})

test('the cue never turns a failing Host read into a failed cue', async () => {
  const t = await startBridge({
    harness: 'fake',
    botRespond: () => ({ ok: false, error: '宿主没起来', code: 'bot/unavailable' })
  })
  try {
    const cookie = await t.pairMobile()
    assert.equal((await cue(t, cookie, 'bot')).status, 200,
      'the phone already left home; a warm read that fails must not surface as an error')
  } finally { await t.stop() }
})

test('answering a card ends the warm copy, so the next read is a real one', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const botCalls = () => t.harness.records.calls.filter((c) => c.url === '/api/bot').length
    const call = (method, payload) => httpFetch(t.base + '/api/rpc', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method, payload })
    })

    assert.equal((await cue(t, cookie, 'bot')).status, 200)
    await new Promise((r) => setTimeout(r, 200))
    const warmed = botCalls()
    assert.equal((await call('bot.team', {})).status, 200)
    assert.equal(botCalls(), warmed, 'the first read is the one the cue already paid for')

    // A cue read that is still flying when the phone answers: it must not be
    // allowed to land afterwards and write the pre-answer view back into the
    // cache. The harness answers instantly, so the window is opened by hand —
    // a cue fired and read back before the answer, then answered while the
    // warm promise is still the newest one in the bridge.
    assert.equal((await cue(t, cookie, 'bot')).status, 200)
    await new Promise((r) => setTimeout(r, 200))
    const reWarmed = botCalls()
    assert.equal((await call('bot.approval', { id: 'a-1', choice: 'allow' })).status, 200)
    assert.equal((await call('bot.team', {})).status, 200)
    // Two more calls: the answer itself, and a read that had to be real. The
    // warm promise cleared with the value would otherwise have answered it.
    assert.equal(botCalls(), reWarmed + 2,
      'the view after an answer is read again — a warm copy would hand the settled card back')
  } finally { await t.stop() }
})


test('the Bot page uses PIN-code style transition card with DS Pocket heading when switching to Pocket', () => {
  const html = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  assert.match(html, /id="bpSwitchOverlay" class="switch-overlay" hidden/, 'the switch overlay is in markup')
  assert.match(html, /<div class="card"><div class="logo">/, 'reuses the PIN code page card and logo layout')
  assert.match(html, /<h1>DS Pocket<\/h1>/, 'carries the DS Pocket heading')
  assert.match(html, /class="boot-steps show"/, 'carries the PIN boot steps container')
  assert.match(html, /读取工作区/, 'step 1 reads what the landing reads first')
  assert.match(html, /读取会话列表/, 'step 2 reads the session list')
  assert.match(html, /读取会话消息/, 'step 3 reads the messages')
  assert.match(html, /正在准备页面/, 'step 4 prepares the page')
})

test('the Pocket page uses PIN-code style transition card with DSBOT heading when switching to Bot', () => {
  const html = renderMobilePage({ locale: 'zh', boot: null })
  assert.match(html, /id="switchOverlay" class="switch-overlay" hidden/, 'the Pocket switch overlay is in markup')
  assert.match(html, /<div class="card"><div class="logo">/, 'reuses the PIN code page card and logo layout')
  assert.match(html, /<h1>DSBOT<\/h1>/, 'carries the DSBOT heading')
  assert.match(html, /class="boot-steps show"/, 'carries the PIN boot steps container')
  assert.match(html, /读取 BOT 列表/, 'step 1 reads what the Bot page reads first')
  assert.match(html, /读取 BOT 消息/, 'step 2 reads the bot conversations')
  assert.match(html, /读取群聊/, 'step 3 reads the groups')
  assert.match(html, /正在准备页面/, 'step 4 prepares the page')
})

test('the Bot page viewport and typography prevent mobile WebView zoom-out scaling regression', () => {
  const html = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  assert.match(html, /<meta name="viewport" content="[^"]*interactive-widget=resizes-content[^"]*">/, 'viewport resizes content')
  assert.match(html, /-webkit-text-size-adjust:\s*100%!important/, 'locks webkit text-size-adjust to prevent WebView shrinking')
  assert.match(html, /text-size-adjust:\s*100%!important/, 'locks text-size-adjust')
  assert.match(html, /font:\s*15px\/1\.5/, 'base font size is 15px aligned with Pocket')
  assert.match(html, /\.bp-row\{[^}]*min-height:\s*64px/, 'card row height aligned with Pocket 64px')
  assert.match(html, /\.bp-copy b\{[^}]*font-size:\s*15\.5px/, 'card title aligned with Pocket 15.5px')
})

test('the Bot composer send button reuses Pocket circular layout and centers the arrow SVG without text nodes', () => {
  const html = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  assert.match(html, /<button id="bpSend" class="primary" aria-label="发送" disabled><svg width="17" height="17"/, 'reuses Pocket primary class with centered SVG')
  assert.doesNotMatch(html, /<button id="bpSend"[^>]*>[^<]*发送/, 'no inline text node inside button')
  assert.match(html, /\.bp-composer button\{[^}]*width:\s*44px;\s*min-width:\s*44px;\s*height:\s*44px;\s*border:\s*0;\s*border-radius:\s*50%/, 'pure 44x44 circular button')
})

test('the floating action buttons on Pocket and Bot pages share identical circular geometry, border-radius and shadow', () => {
  const botHtml = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  const pocketHtml = renderMobilePage({ locale: 'zh', boot: null })

  // Both have identical 52x52 circular styling
  assert.match(botHtml, /\.bp-fab\{[^}]*width:\s*52px;\s*height:\s*52px;\s*border:\s*1px solid var\(--line\);\s*border-radius:\s*50%;\s*background:\s*var\(--card\);\s*color:\s*var\(--brand\);\s*box-shadow:\s*0 4px 16px rgba\(0,0,0,\.12\)/)
  assert.match(pocketHtml, /\.bot-fab\{[^}]*width:\s*52px;\s*height:\s*52px;\s*border:\s*1px solid var\(--line\);\s*border-radius:\s*50%;\s*background:\s*var\(--card\);\s*color:\s*var\(--brand\);\s*box-shadow:\s*0 4px 16px rgba\(0,0,0,\.12\)/)

  // Both have identical active state scaling
  assert.match(botHtml, /\.bp-fab:active\{[^}]*background:\s*var\(--hover\);\s*transform:\s*scale\(\.92\)/)
  assert.match(pocketHtml, /\.bot-fab:active\{[^}]*background:\s*var\(--hover\);\s*transform:\s*scale\(\.92\)/)

  // Both anchors are marked draggable="false"
  assert.match(botHtml, /id="bpHome"[^>]*draggable="false"/)
  assert.match(pocketHtml, /id="botFab"[^>]*draggable="false"/)
})
