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
import vm from 'node:vm'
import { startBridge, httpFetch } from './helpers.js'
import { BOT_PAGE_JS, renderBotPage } from '../lib/bot-page.js'
import { renderMobilePage, renderMobileReconnectPage } from '../lib/pages.js'

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
    assert.match(html, /<title>BOT<\/title>/)

    // 样式表仍按内容 hash 取，改一次就换一个地址。
    const css = html.match(/<link rel="stylesheet" href="(\/app\.css\?h=[0-9a-f]+)">/)
    assert.ok(css, 'the stylesheet link is content-addressed')
    // R10-B（2026-11-01）：首帧不许是骨架。文档把 roster 与每行最新一页内联给页面脚本，
    // 脚本也在解析期内联执行——所以这里钉的是「内联载荷 + 内联脚本本体」，
    // 而不是外链 <script src>：外链脚本下载的那段时间里，首帧只能是一张空壳。
    assert.doesNotMatch(html, /<script src=/, 'no external script: it would paint an empty shell first')
    // R13（2026-11-02）：/bot 文档也带 CSP 的 per-request nonce，内联脚本必须挂同一个 nonce——
    // 之前没有 nonce，整段内联脚本被浏览器拦掉（实测 headless 里 window.__BOT_BOOT__ 为 undefined）。
    // 断言因此从「没有 nonce」改成「两段内联脚本都带 nonce，且与响应头里的 CSP 一致」。
    const csp = res.headers.get('content-security-policy') ?? ''
    const nonce = (csp.match(/'nonce-([^']+)'/) ?? [])[1]
    assert.ok(nonce, 'the response authorizes exactly one nonce')
    assert.match(html, new RegExp('<script nonce="' + nonce + '">window\\.__BOT_BOOT__='),
      'the document carries the roster and previews inline under the nonce')
    assert.ok(html.includes('<script nonce="' + nonce + '">' + BOT_PAGE_JS + '</script>'),
      'the shipped script is inlined byte for byte under the same nonce, so it runs while parsing')
    assert.equal((html.match(/<script nonce="/g) ?? []).length, 2,
      'both inline scripts carry the nonce — a bare <script> would be blocked by the CSP')
    assert.doesNotMatch(html, /<script>/, 'no bare inline script that the CSP would refuse to run')

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
          questions: { chief: { id: 'q-1', question: 'pick one', options: [{ label: 'A' }, { label: 'B' }] } },
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
    // The count stays, and each open question now travels with what the phone
    // needs to ask it: whose question it is, which chat answers it, the card id
    // the Host matches the answer against, and the question with its options.
    // The rest of the Host's state still stays behind.
    assert.deepEqual(team.value.questions, {
      count: 1,
      items: [{
        botId: 'chief',
        sessionId: 's-chief',
        questionId: 'q-1',
        question: 'pick one',
        options: [{ label: 'A' }, { label: 'B' }],
        multiSelect: false,
        allowCustom: false
      }]
    }, 'the open question travels with the Bot, the chat and its options')
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
  // 过渡卡的步骤数。真机的 `querySelectorAll('.boot-step')` 取的就是壳里写着的这几
  // 个节点；替身按壳现造，壳改了步骤数它会跟着变，而写死「4」会在那天骗人，正如
  // 写死「节点按需现造」骗了整整一批测试（P1-5）。
  let steps = 0
  // 每步里那个数字位（`class="bsc"`，页面脚本用 querySelector('.bsc') 拿到它再写
  // 「12 个会话」）。数出来而不是写死：壳少一个位就是一行没有数字。
  let counts = 0
  const stack = []
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
  for (const [, closing, rawName, attrs] of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
    const name = rawName.toLowerCase()
    if (closing) {
      const at = stack.findLastIndex((open) => open.name === name)
      if (at >= 0) stack.length = at
      continue
    }
    // 过渡卡的步骤：class 里**整词**等于 `boot-step` 的节点，且必须挂在那张卡里面
    // （`boot-step-label` 是步骤里的文字标签，`boot-steps` 是容器，两者都不是一步）。
    const classAttr = /\bclass="([^"]*)"/.exec(attrs)?.[1] ?? ''
    if (classAttr.split(/\s+/).includes('boot-step') && stack.some((open) => open.id === 'bpSwitchOverlay')) steps += 1
    if (classAttr.split(/\s+/).includes('bsc') && stack.some((open) => open.id === 'bpSwitchOverlay')) counts += 1
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
  // 每一行的「单位」与起步读数也照壳取（`data-unit` 与节点里的初值）：真 DOM 里
  // `el.dataset.unit` 与 `el.textContent` 就是这么来的。替身缺这两样，卡片脚本写出来
  // 的就不是真机上的那句话——「12」与「12 个会话」差的是同一个教训（P1-5）。
  const slots = [...html.matchAll(/<span class="bsc" data-unit="([^"]*)"[^>]*>([^<]*)</g)]
    .map(([, unit, start]) => ({ unit, start }))
  return { ids, ancestors, flags, steps, counts, slots }
}
const SHELL = shellShape()
const SHELL_IDS = SHELL.ids

/** 预热清单（不是白名单——权威是上面的 `SHELL_IDS`）：先把页面要碰的节点造出来。 */
const PAGE_IDS = ['bpBack', 'bpHome', 'bpReload', 'bpTitle', 'bpHint', 'bpBar', 'bpList', 'bpMembersList', 'bpMsgs', 'bpComposer', 'bpPrompt', 'bpSettings', 'bpSettingsPanel', 'bpSend', 'bpToast', 'bpSwitchOverlay']

// 判据 9 的队列断言要跑的是页面上真正发出去的那个 `previewQueue`，所以从
// `BOT_PAGE_JS` 里把它抠出来在 vm 里求值——同一个函数体、同一份常量，不是另抄一遍。
// （同一套取法 test/preload-scope.test.js 已在用，这里按同一范式补上主 bot 这一档。）
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the rendered page script`)
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

const PREVIEW_BOTS = Number((BOT_PAGE_JS.match(/var PREVIEW_BOTS = (\d+)/) || [])[1])
const PREVIEW_ROOMS = Number((BOT_PAGE_JS.match(/var PREVIEW_ROOMS = (\d+)/) || [])[1])

/**
 * A browser stand-in holding just what `/bot`'s script touches: ten elements
 * with textContent/innerHTML/hidden/disabled, the three event targets, a fetch
 * that answers `/api/rpc` from `answer(method, payload)`, and timers that never
 * fire (the page's pollers are not what these tests are about).
 */
function fakeBrowser({
  answer = () => ({}),
  seed = null,
  hang = null,
  js = BOT_PAGE_JS,
  // 判据 ③d：顶部状态点与授权胶囊读 /api/status，重启读 /api/host/restart。
  // 两个都不是 /api/rpc，所以在这里按 url 分流，默认值让既有测试原样通过。
  status = {},
  statusFailure = false,
  restart = { ok: true },
} = {}) {
  // 会话流的替身。真机上 `new EventSource(url)` 由浏览器给，注入进来测试才发得了帧：
  // 替身不给，生产代码就得多一条「没有 EventSource 就不接流」的判据，那条判据在真
  // 机上的唯一作用是给替身让路（P1-5）。给得上，接流才是真的被测到。
  const streams = []
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.handlers = Object.create(null)
      this.closed = false
      this.onerror = null
      streams.push(this)
    }
    addEventListener(type, fn) {
      ;(this.handlers[type] ??= []).push(fn)
    }
    /** 推一帧。真机上桥推下来的就是 JSON 文本，页面自己 parse。 */
    dispatch(type, frame) {
      for (const fn of this.handlers[type] ?? []) fn({ data: JSON.stringify(frame) })
    }
    /** 推一帧不是 JSON 的，页面不许为此抛错。 */
    dispatchRaw(type, data) {
      for (const fn of this.handlers[type] ?? []) fn({ data })
    }
    /** 流开不出来（隧道就是这种：连得上、帧留不住）。真机上触发的是 onerror。 */
    fail() {
      if (this.onerror) this.onerror({ type: 'error' })
    }
    close() {
      this.closed = true
    }
  }
  const nodes = new Map()
  // 过渡卡的四步（由下面那个 for 按 `SHELL.steps` 造出来）。页面动画会 toggle 它们
  // 的 class，测试于是能断言「走到了哪一步」而不是只能看它有没有直接跳走。
  const switchSteps = []
  // 每一步里的数字位（`.bsc`）。页面脚本在桥答复后写「12 个会话」／「已就绪」，
  // 断言读这里。
  const switchCounts = []
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
      // 判据 1 起，设置键用 aria-expanded 报自己的开合（Pocket 的 .settings-trigger
      // 就是按这个属性上色的），所以替身必须像真机那样存得住属性——只答固定值的
      // 替身会把「点开却没改属性」这种缺陷放过去。
      const attrs = new Map()
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
        getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
        setAttribute: (name, value) => { attrs.set(name, String(value)) },
        addEventListener(type, fn) { nodeListeners.set(id + ':' + type, fn) },
        // 过渡卡的步骤。真机上 `#bpSwitchOverlay` 里就挂着壳里那几个 `.boot-step`，
        // 页面脚本对它们做 70ms/步的动画。替身从前没有这个方法，页面为此写了
        // `typeof overlay.querySelectorAll === 'function'` 的双判据——那条判据在
        // 生产里的唯一作用就是给替身让路，动画分支因此从未被任何测试执行过
        // （P1-5：替身反向塑造生产代码）。补上之后它成了可测路径。
        querySelectorAll(selector) {
          if (id !== 'bpSwitchOverlay' || selector !== '.boot-step') return []
          return switchSteps
        },
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
        let html = ''
        // Every child the transcript draws, in the order it appears: the older
        // button, dividers, event rows and messages. Both scrollHeight and the
        // anchor geometry read this one list, so a row's pixel top and the
        // box's total height can never disagree.
        const rowsOf = () => {
          const out = []
          const re = /class="(bp-(?:msg|divider|event|older)[^"]*)"/g
          let match
          while ((match = re.exec(html))) {
            out.push({ classes: match[1].split(/\s+/), message: /\bbp-msg\b/.test(match[1]) })
          }
          return out
        }
        // 2026-10-29：进一次会话消息区被整段重写的次数，就是用户说的「刚进来时候
        // 会跳」的计量口径（卡三 A4）。计数只能在 setter 里：paintChat 自己有一条
        // 守卫（键没变就不写 DOM），所以「调用了几次」不等于「重画了几次」——写下去
        // 的次数才是看得见的那几次。
        let writes = 0
        made.htmlWrites = () => writes
        Object.defineProperty(made, 'innerHTML', {
          configurable: true,
          get: () => html,
          // A real box clamps its scrollTop to the content it is given: content
          // that shrank pulls the reader up. The anchor restore measures against
          // that clamp, so the stand-in has to do it too.
          set: (next) => {
            writes += 1
            html = String(next)
            const max = Math.max(0, rowsOf().length * 40 - made.clientHeight)
            if (made.scrollTop > max) made.scrollTop = max
          },
        })
        Object.defineProperty(made, 'scrollHeight', {
          configurable: true,
          get: () => rowsOf().length * 40,
        })
        made.clientHeight = 300
        // 页面「贴底」的写法是 `scrollTop = scrollHeight`，真浏览器会把它钳到
        // `scrollHeight - clientHeight`。替身不钳的话，「钉在底部」与「冲过头」
        // 在断言里是同一个读数，A5 那条判据就永远打不了勾。
        let parked = 0
        Object.defineProperty(made, 'scrollTop', {
          configurable: true,
          get: () => parked,
          set: (next) => {
            const max = Math.max(0, rowsOf().length * 40 - made.clientHeight)
            parked = Math.min(Math.max(0, Math.round(Number(next) || 0)), max)
          },
        })
        // The geometry the scroll anchor reads. The box sits at the top of the
        // viewport; each row is forty pixels tall, so a row's top is its index
        // times forty minus whatever has been scrolled. Before this the stand-in
        // had no getBoundingClientRect and no `:scope > .message`, so the anchor
        // code could never be asserted (P1-5 all over again: a stand-in that is
        // missing something makes the page carry a branch for it).
        // 判据 3：消息流末尾那一行「正在干活」是个带 id 的节点，页面画完就该能按 id 取到。
        // 替身此前只会答 `:scope > .message`，于是「末尾那行是不是它」在替身上根本问不出来
        // ——一个缺能力的替身会让页面为它多长一条分支（P1-5 那个教训）。
        made.querySelector = (selector) => {
          if (selector !== '#bpTurnStatus') return null
          return html.includes('id="bpTurnStatus"') ? { id: 'bpTurnStatus' } : null
        }
        made.getBoundingClientRect = () => ({ top: 0, bottom: made.clientHeight, height: made.clientHeight })
        made.querySelectorAll = (selector) => {
          if (selector !== ':scope > .message') return []
          const rows = rowsOf()
          const out = []
          for (let index = 0; index < rows.length; index += 1) {
            if (!rows[index].message) continue
            const top = index * 40 - made.scrollTop
            out.push({
              index: out.length,
              rowIndex: index,
              getBoundingClientRect: () => ({ top, bottom: top + 40, height: 40 }),
            })
          }
          return out
        }
      }
      nodes.set(id, made)
    }
    return made
  }
  for (const id of PAGE_IDS) node(id)
  // 过渡卡的四步。`setStep` 对每个节点 toggle `is-done`／`is-active`（真 DOM 的
  // `classList.toggle` 支持 `(name, force)` 两参形态），测试据此断言走到了第几步。
  for (let index = 0; index < SHELL.steps; index += 1) {
    const classes = new Set(index === 0 ? ['boot-step', 'is-active'] : ['boot-step'])
    const slot = SHELL.slots[index] || { unit: '', start: '' }
    // 数字位与真 DOM 同形：有初值、有 `dataset.unit`（单位照壳读）、有 parentElement
    // 指回这一行——卡片脚本靠这三样把「读了多少」写成人话并给这一行划线。
    const countNode = { textContent: slot.start, dataset: { unit: slot.unit } }
    const stepNode = {
      index,
      classes,
      // 数字位。页面脚本用 `querySelector('.bsc')` 拿它再写字；替身从前没有这个
      // 方法，那行数字就永远是空的（与 P1-5 同一条教训：替身缺什么，生产里就多
      // 一条给替身让路的判据）。
      querySelector: (selector) => (selector === '.bsc' ? countNode : null),
      classList: {
        toggle(name, force) {
          const on = force === undefined ? !classes.has(name) : Boolean(force)
          if (on) classes.add(name)
          else classes.delete(name)
        },
        contains: (name) => classes.has(name),
      },
    }
    countNode.parentElement = stepNode
    switchCounts.push(countNode)
    switchSteps.push(stepNode)
  }
  // The page marks its two views on the body (`bp-list` / `bp-chat`) so the
  // floating buttons can trade places, and it drops `bp-ready`'s hairline once
  // a read lands. Both are assertions now, so the classes are recorded rather
  // than thrown away.
  const classes = new Set(['bp-list', 'bp-loading', 'bp-busy'])
  const body = {
    // R14-1 的离屏量高把探针挂到 body 上排版；替身照真浏览器答「挂得上、随后能摘」。
    appendChild() {},
    removeChild() {},
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
    // R14-1：一屏的判据从「scrollHeight 比 clientHeight 高」换成「离屏容器里
    // 逐行量高、累加 ≥ clientHeight×1.15」（lib/bot-page.js measureChatRows）。
    // 替身不给 createElement 的话，量高会抛、退回 rows.length，于是「刚好够一屏」
    // 与「不够一屏」在替身里同值——那条判据在替身里永远打不了勾（P1-5：替身缺
    // 什么，生产里就多一条给替身让路的判据）。这里按 bpMsgs 同一套几何答：
    // 一行 40px。
    createElement: () => {
      let probeHtml = ''
      const probe = {
        tagName: 'DIV',
        style: {},
        setAttribute() {},
        appendChild() {},
        remove() {},
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        children: [],
        getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 }),
        querySelectorAll: () => [],
      }
      Object.defineProperty(probe, 'innerHTML', {
        configurable: true,
        get: () => probeHtml,
        set: (next) => {
          probeHtml = String(next)
          const re = /class="(bp-(?:msg|divider|event|older)[^"]*)"/g
          const rows = []
          while (re.exec(probeHtml)) rows.push(1)
          probe.children = rows.map(() => ({ getBoundingClientRect: () => ({ top: 0, bottom: 40, height: 40 }) }))
        },
      })
      return probe
    },
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
  // 判据 v7 §2 / 裁决 R5：出口只剩 location.replace('/')——back 提交后本文档就卸载了，
  // 落点无从校验，所以替身必须提供 replace，并把落点记进同一个历史账本。
  location.replace = (url) => {
    historyReplaced.push([url])
    location.href = url
  }
  // Timers are collected instead of fired, so a test can choose the moment: the
  // page arms one timeout per rpc (its own give-up) and one per toast.
  const timers = []
  // 页面给每个 rpc 上了一个放弃用的 timeout、给 toast 一个自隐的，过渡卡走完还要
  // 隔 60ms 才真的离开。记下毫秒数，`fireTimers(ms)` 才能只推某一档。
  const fakeSetTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
  const statusCalls = []
  const restartCalls = []
  const fetch = (url, options) => {
    // 顶部四件走的是 Pocket 那几个非 rpc 端点（判据 ③d 要求数据同源复用），
    // 所以这里按 url 分流；/api/rpc 那套夹具与 calls 断言原样不动。
    if (url === '/api/status') {
      statusCalls.push(1)
      if (statusFailure) return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve(null) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(status) })
    }
    if (url === '/api/host/restart') {
      restartCalls.push(JSON.parse(options.body))
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(restart) })
    }
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
  // 页面自己的两个轮询（5 秒读消息、15 秒读团队）仍然不自己 fire——它们不是这些
  // 测试要说的事。但 interval 现在会被记下来，让测试能显式推一档：过渡卡的
  // 70ms×4 动画只有这样才跑得到，否则那条分支在替身里永远是死代码（P1-5）。
  const intervals = []
  const fakeSetInterval = (fn, ms) => { intervals.push({ fn, ms, alive: true }); return intervals.length }
  const fakeClearInterval = (id) => { const entry = intervals[id - 1]; if (entry) entry.alive = false }
  new Function(
    'document', 'window', 'location', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Intl', 'localStorage', 'navigator', 'EventSource',
    js
  )(document, window, location, fetch, fakeSetInterval, fakeClearInterval, fakeSetTimeout, () => {}, Intl, localStorage, navigator, FakeEventSource)
  return {
    node,
    streams,
    switchSteps,
    switchCounts,
    calls,
    statusCalls,
    restartCalls,
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
    /**
     * 烧掉已 arm 的 timeout（页面对 rpc 的放弃、toast 自隐、过渡卡走完后的 60ms）。
     * 不传 `ms` 全烧；传了只烧这一档——顺手把 rpc 放弃也烧掉会把无关分支推进去。
     */
    fireTimers: (ms) => {
      const due = typeof ms === 'number' ? timers.filter((entry) => entry.ms === ms) : timers.slice()
      for (const entry of due) {
        const at = timers.indexOf(entry)
        if (at >= 0) timers.splice(at, 1)
        entry.fn()
      }
    },
    /** 推一档 interval（只推这个毫秒数的、且还没被 clearInterval 停掉的）。 */
    fireIntervals: (ms) => {
      for (const entry of intervals) if (entry.alive && entry.ms === ms) entry.fn()
    },
    click: (id, event) => {
      // 真机不给 disabled 控件派发 click。修复④正是栽在这上面：壳里 `bpSend`
      // 初始 `disabled`，代码里没有启用点，替身却能点动 ⇒ 发送类测试全绿而真机
      // 永久灰。替身照真机拦，删掉启用行的那天测试就红。
      if (node(id).disabled) throw new Error(`#${id} is disabled; a browser would not dispatch this click`)
      return nodeListeners.get(id + ':click')(event)
    },
  }
}

/**
 * 把过渡卡推完。真机上点 BOT 页右上角那一下先起四步卡（70ms 一步），走完再停
 * dwell 才真的离开页面——替身里 timeout 不自己 fire，所以测试必须显式推。
 *
 * 2026-10-27② 起卡片还要等桥答复一份「已载入多少」，等不到 1.6s 兜底就自己走；
 * 替身里那个 timeout 也不自己 fire，所以这里连它一起烧——等价于「桥 1.6 秒没答」。
 * 1.6 这个数字不是随手定的：桥那边等 warmPage 的上限是 `pageCueWaitMs ?? 1500`，
 * 卡先放弃就会把数字写在正在卸载的文档上（2026-10-28）。
 *
 * 2026-10-30 Q1：逐行阶梯与停留都改成链式 setTimeout（原先 70ms 那档走 setInterval），
 * 所以推的是 fireTimers 而不是 fireIntervals——每档只烧毫秒数相等的那些表。
 */
async function finishSwitch(page) {
  for (let step = 0; step < page.switchSteps.length; step += 1) page.fireTimers(70)
  page.fireTimers(1600)
  await page.settle()
  // 判据 6D：完成文字落屏之后要停 500ms 才跳转，这条表就是那 0.5 秒。
  page.fireTimers(500)
  await page.settle()
}

test('the way out says how much of the landing is already warm, on the row that speaks for it', async () => {
  // 用户 2026-10-27②：「中间页也应该有数据的显示（即加载了多少数据的显示）」。
  // 四步卡片快步走完只要 280ms，那时桥还什么都没说；现在它等 bridge 的答复（1.6s
  // 兜底），把「读了多少会话 / 是否就绪」写在自己的那两行上。
  const page = fakeBrowser({
    answer: (method) => (method === 'page.cue'
      ? { ready: true, workspaces: 3, sessions: 12, messages: null, bots: null, botSessions: null, rooms: null }
      : {}),
  })
  await page.settle()
  assert.equal(SHELL.counts, SHELL.steps, 'every step carries one slot for its number')
  page.click('bpHome', { preventDefault() {} })
  await page.settle()
  // Q1 起四行由同一份 ladderRun 逐行推：每一行亮起的那一刻才去取自己的读数，
  // 所以这里先把那四档推出来，再看卡上落的是什么。
  for (let step = 0; step < page.switchSteps.length; step += 1) page.fireTimers(70)
  await page.settle()
  assert.equal(page.switchCounts[0].textContent, '3 个工作区', 'the first row says how many workspaces the landing holds')
  assert.equal(page.switchCounts[1].textContent, '12 个会话', 'the row that reads the list says how many rows it read')
  assert.equal(page.switchCounts[3].textContent, '已就绪', 'the last row says whether the landing is warm')
})

test('a cold summary never overwrites the numbers the page already holds with zeros', async () => {
  // 2026-10-28：冷摘要（ready:false）里每一格都是 0。照写就把点下去那一刻刚用本地缓存
  // 填好的「读了多少会话 / 多少消息」抹回 0——用户看到的正是「第 0/1 格恒 0」。
  // 只有 ready:true 才允许写数字：桥没读到就说「未就绪」，一个数都不装。
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') return { events: [saidByBot('预读过的一句', 400)], hasMore: false }
      if (method === 'page.cue') {
        return { ready: false, workspaces: 0, sessions: 0, messages: 0, bots: null, botSessions: null, rooms: null }
      }
      return {}
    },
  })
  await page.settle(40)
  page.click('bpHome', { preventDefault() {} })
  await page.settle()
  for (let step = 0; step < page.switchSteps.length; step += 1) page.fireTimers(70)
  await page.settle()
  assert.equal(page.switchCounts[1].textContent, '2 个会话', 'the rows this page already read stay on the row that counts them')
  assert.equal(page.switchCounts[2].textContent, '2 条消息', 'and so do the messages it already holds')
  assert.equal(page.switchCounts[3].textContent, '未就绪', 'a bridge that read nothing says so instead of printing zeros as facts')
})

test('the card outlasts the bridge’s own wait before giving up on the numbers', async () => {
  // 桥那边等一次预热的上限是 `warmPage` 的 `pageCueWaitMs ?? 1500`（lib/bridge.js）。
  // 卡片 1.2s 就自己走的话，慢答把数字写在正在卸载的文档上——手机上就是「第 0 格还是 0」。
  // 所以这里钉住的是先后：1.2s 时必须还在等，1.6s 的兜底到了才准离开。
  const page = fakeBrowser({ answer: () => ({}), hang: (method) => method === 'page.cue' })
  await page.settle()
  page.click('bpHome', { preventDefault() {} })
  for (let step = 0; step < page.switchSteps.length; step += 1) page.fireTimers(70)
  await page.settle()
  page.fireTimers(1200)
  await page.settle()
  assert.deepEqual(page.navigations, [], '1.2s is inside the bridge’s window; leaving here is what loses the numbers')
  page.fireTimers(1600)
  await page.settle()
  assert.deepEqual(page.navigations, [], 'the bound that lets the card go replaces this entry with the landing')
  assert.deepEqual(page.historyReplaced, [['/']], 'and the entry it replaces points at the landing')
  assert.equal(page.historyReplaced[0][0], '/', 'the landing is exactly /')
})

test('a chat the roster already read opens with its rows and does not read them again', async () => {
  // 用户 2026-10-27③a：「BOT 会话未提前读取：加载后点进 BOT 的会话还是会要加载」。
  // 名单到手后就在后台把前几个会话的最新一页读进来；点进去直接用，不再空屏。
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') return { events: [saidByBot('预读过的一句', 400)], hasMore: false }
      return {}
    },
  })
  await page.settle(40)
  const readBefore = page.calls.filter((call) => call.method === 'session.history').length
  assert.ok(readBefore >= 1, 'the roster reads the newest page of what it lists, before anyone taps it')
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  assert.match(page.node('bpMsgs').innerHTML, /预读过的一句/, 'the first paint already carries the page')
  await page.settle(40)
  const readAfter = page.calls.filter((call) => call.method === 'session.history').length
  assert.equal(readAfter, readBefore, 'opening a previewed chat does not read the page it already holds')
})

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
  assert.equal(shape.steps, 0, 'a fragment without boot steps counts none')
  assert.equal(shellShape('<div id="bpSwitchOverlay"><div class="boot-step is-active"></div><div class="boot-step"></div></div>').steps, 2,
    'the boot steps inside the switch card are counted off the same pass')
  assert.equal(shellShape('<div id="o"><div class="boot-step"></div></div>').steps, 0,
    'a boot step outside that card is not one of them')
  assert.equal(SHELL.steps, 4, 'and the shipped shell really has four of them (P1-5)')
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

/**
 * 一张待答提问，连问它的那个成员一起。形状就是桥送来的那一条（`botQuestions`）：
 * 提问住在 ds-bot 自己的 state 里，所以谁问的、在哪个会话答、卡号是多少都随它来。
 */
function teamWithQuestion(over = {}) {
  const team = teamWith()
  team.questions = {
    count: 1,
    items: [Object.assign({
      botId: 'chief',
      sessionId: 's-chief',
      questionId: 'q-1',
      question: '要走哪条路？',
      options: [{ label: '甲' }, { label: '乙' }],
      multiSelect: false,
      allowCustom: false,
    }, over)],
  }
  return team
}

test('an approval draws its two buttons only when the Host says the phone may answer', async () => {
  const page = fakeBrowser({
    answer: (method) => (method === 'bot.team'
      ? teamWith({ id: 'a-1', botId: 'chief', tool: 'bash', reason: 'needs a shell', answerable: true })
      : {}),
  })
  await page.settle()
  // 判据 4A⑤：「待答」不再单开一段，审批卡画进「主 BOT」那张卡的 .task-list 顶部。
  const html = page.node('bpMembersList').innerHTML
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
  assert.match(page.node('bpMembersList').innerHTML, /这条要在电脑上回答/)
  assert.ok(!page.node('bpMembersList').innerHTML.includes('data-approve='), 'the phone draws no button it cannot answer')
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

// ---- 提问卡（BOT 页）--------------------------------------------------------
// 用户 2026-10-27：「BOT 的选择栏只能看到提示，也不知道是谁要选择，也不知道要选择
// 什么，而且更加点不了。」下面四条按这句话的四段逐个钉住：谁在问、问什么、点得动、
// 答得上（外加「关掉」不许退化成空答一张卡）。

/** 点列表里那一行（`data-open` 分支需要行上带三个属性）。 */
function clickQuestionRow(page) {
  const row = {
    getAttribute: (name) => ({
      'data-open': 'bot',
      'data-id': 'chief',
      'data-sid': 's-chief',
      'data-title': 'Chief',
    })[name] ?? null,
  }
  page.click('bpList', { target: { closest: (selector) => (selector === '[data-open]' ? row : null) } })
}

/** 点卡上的某样东西：选项、提交、关闭。 */
function clickCard(page, selector, attr, value) {
  const target = { getAttribute: (name) => (name === attr ? value : null) }
  page.click('bpQuestion', { target: { closest: (sel) => (sel === selector ? target : null) } })
}

/** 列表页 → 那个 Bot 的会话（`bpQuestion` 有内容的地方）。 */
async function openQuestionChat(page) {
  await page.settle(20)
  clickQuestionRow(page)
  await page.settle(5)
  page.fireWindow('hashchange')
  await page.settle(60)
}

test('an open question is a row that names the asker, the question and the chat that answers it', async () => {
  const page = fakeBrowser({ answer: (method) => (method === 'bot.team' ? teamWithQuestion() : {}) })
  await page.settle()
  const html = page.node('bpMembersList').innerHTML
  assert.match(html, /data-open="bot"/, '这一行点得动（走的是列表里已有那个打开分支）')
  assert.match(html, /data-sid="s-chief"/, '它开的是能回答这个问题的那个会话')
  assert.match(html, /Chief · 需要你的回答/, '先说清是谁要选择')
  assert.match(html, /要走哪条路？/, '再说清要选择什么')
  assert.ok(!/个问题等你回答/.test(html), '不再只剩一句数字')
})

test('opening that row lands on the card: the question, its options and a way to send', async () => {
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWithQuestion()
      if (method === 'session.history') return { events: [saidByBot('在的', 9)] }
      return {}
    },
  })
  await openQuestionChat(page)
  const card = page.node('bpQuestion')
  assert.equal(page.node('bpList').hidden, true, '先进了会话')
  assert.equal(card.hidden, false, '会话里摆出了这张卡')
  assert.match(card.innerHTML, /要走哪条路？/, '题干在卡上')
  assert.match(card.innerHTML, /data-option-index="0"/, '选项可点')
  assert.match(card.innerHTML, /data-option-index="1"/, '不止一个选项')
  assert.match(card.innerHTML, /data-question-action="continue"/, '有提交键')
  assert.match(card.innerHTML, /data-question-action="cancel"/, '也有把它关掉的键')
  assert.equal(card.innerHTML.includes('question-custom'), false,
    '这一页没有自定义输入（落地页才有），所以卡上不画它')
})

test('tapping an option marks it, and sending hands the Host the option text itself', async () => {
  // 宿主答掉一条就从自己的 state 里删掉它（ds-bot `answer-question` 先 delete 再
  // 交给 Agent），所以下一次 bot.team 读回来时这条已经不在——替身照这个来。
  let held = teamWithQuestion()
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return held
      if (method === 'session.history') return { events: [] }
      if (method === 'bot.answer') { held = teamWith(); return {} }
      return {}
    },
  })
  await openQuestionChat(page)
  clickCard(page, '[data-option-index]', 'data-option-index', '1')
  await page.settle()
  assert.match(page.node('bpQuestion').innerHTML, /question-option selected[^>]*>\s*<span class="option-control">/,
    '选中的那项有选中态')

  clickCard(page, '[data-question-action]', 'data-question-action', 'continue')
  await page.settle()
  assert.deepEqual(
    page.calls.find((call) => call.method === 'bot.answer').payload,
    { sessionId: 's-chief', questionId: 'q-1', answer: { selected: ['乙'] } },
    '交回宿主的是选项原文（ds-bot 用 label 比对），不是下标'
  )
  assert.equal(page.node('bpQuestion').hidden, true, '答完卡就收起来')
  assert.equal(page.node('bpToast').textContent, '已提交')
})

test('sending with nothing chosen is refused here, not left to the Host', async () => {
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWithQuestion()
      if (method === 'session.history') return { events: [] }
      return {}
    },
  })
  await openQuestionChat(page)
  clickCard(page, '[data-question-action]', 'data-question-action', 'continue')
  await page.settle()
  assert.equal(page.calls.some((call) => call.method === 'bot.answer'), false,
    '空答案在 ds-bot 那边只会被拒（Nothing to send），所以这里不发')
  assert.equal(page.node('bpToast').textContent, '选一个再提交')
  assert.equal(page.node('bpQuestion').hidden, false, '卡还在，等着真的选一个')
})

test('closing the card asks the Host to drop the question instead of sending an empty answer', async () => {
  let held = teamWithQuestion()
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return held
      if (method === 'session.history') return { events: [] }
      if (method === 'bot.dismiss') { held = teamWith(); return {} }
      return {}
    },
  })
  await openQuestionChat(page)
  clickCard(page, '[data-question-action]', 'data-question-action', 'cancel')
  await page.settle()
  assert.deepEqual(page.calls.find((call) => call.method === 'bot.dismiss').payload, { sessionId: 's-chief' },
    '关掉＝让宿主把这条提问撤掉（dismiss-question）')
  assert.equal(page.calls.some((call) => call.method === 'bot.answer'), false, '不是拿空答案去顶')
  assert.equal(page.node('bpQuestion').hidden, true)
  assert.equal(page.node('bpToast').textContent, '已跳过')
})

test('a multi-select card keeps every chosen option', async () => {
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWithQuestion({ multiSelect: true })
      if (method === 'session.history') return { events: [] }
      return {}
    },
  })
  await openQuestionChat(page)
  clickCard(page, '[data-option-index]', 'data-option-index', '0')
  await page.settle()
  clickCard(page, '[data-option-index]', 'data-option-index', '1')
  await page.settle()
  clickCard(page, '[data-question-action]', 'data-question-action', 'continue')
  await page.settle()
  assert.deepEqual(page.calls.find((call) => call.method === 'bot.answer').payload.answer, { selected: ['甲', '乙'] })
})

test('a question for another chat never shows up in this one', async () => {
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWithQuestion({ sessionId: 's-elsewhere' })
      if (method === 'session.history') return { events: [] }
      return {}
    },
  })
  await openQuestionChat(page)
  assert.equal(page.node('bpQuestion').hidden, true, '别人的提问不摆到这一页上')
})

// ---- 模型入口（BOT 页）------------------------------------------------------
// 用户 2026-10-28：手机端三个动作都要——替你回话、关卡片、改模型。前两个早就有界面，
// 第三个桥里一直有（`bot.update` 只收 model / effort），手机上没有入口。
//
// 下面这几条钉的是入口本身，不钉宿主：清单一个都不写死（读 `session.models`，也就是
// 宿主的 `session/modelCatalog`）；改完必须回读 `bot.team`，回读说没变就不许写「已换到」。
// 判据 1③ 定了这一页只有一个字段——模型；宿主答案里即便带着 reasoning.efforts（下面那份
// 目录就带着），也不摆思考档位。

const MODEL_CATALOG = {
  default: { provider: 'magpie-gateway', model: 'group/pool' },
  routableProviders: ['magpie-gateway'],
  groups: [
    {
      id: 'magpie-gateway',
      name: 'Magpie',
      models: [
        {
          id: 'group/pool',
          name: 'Pool',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
        },
        { id: 'group/flash', name: 'Flash' },
      ],
    },
  ],
}

/** 团队视图里那个 Bot 记录带着 model（`botTeamView` 就裁到这一层）。 */
function teamWithModel(model) {
  const team = teamWith()
  team.bots[0].model = model
  return team
}

/** 点会话输入条里那枚设置键（判据 1：入口从标题行搬进 composer）。 */
function clickModelToggle(page) {
  page.click('bpSettings')
}

/** 点面板里的某一行（模型或档位）。 */
function clickModelPick(page, selector, attr, value) {
  const target = { getAttribute: (name) => (name === attr ? value : null) }
  page.click('bpSettingsPanel', { target: { closest: (sel) => (sel === selector ? target : null) } })
}

/** 打开 Chief 的会话，并让 `session.models` 答一份两模型的目录。 */
function modelPage(over = {}) {
  let held = teamWithModel('magpie-gateway/group/pool')
  const page = fakeBrowser({
    answer: (method, payload) => {
      if (method === 'bot.team') return held
      if (method === 'session.history') return { events: [] }
      if (method === 'session.models') return MODEL_CATALOG
      if (method === 'bot.update') {
        if (typeof over.onUpdate === 'function') held = over.onUpdate(held, payload) || held
        return {}
      }
      return {}
    },
  })
  return openQuestionChat(page).then(() => page)
}

test('the settings key lives in the composer and names what that Bot runs on', async () => {
  const page = await modelPage()
  const key = page.node('bpSettings')
  assert.equal(key.hidden, false, '会话里摆出设置键')
  assert.equal(key.visible, true, '而且真的看得见（不是只有 hidden=false）')
  assert.equal(key.getAttribute('aria-expanded'), 'false', '出生是收起态')
  const panel = page.node('bpSettingsPanel')
  assert.equal(panel.hidden, true, '没点开就不摆面板')
  clickModelToggle(page)
  await page.settle()
  assert.equal(key.getAttribute('aria-expanded'), 'true', '点开：键自己报展开')
  assert.equal(panel.hidden, false, '面板摆出来')
  assert.match(panel.innerHTML, /magpie-gateway\/group\/pool/,
    '写的是 Bot 记录里的 model，不是界面自己的记忆')
  assert.match(panel.innerHTML, /class="setting-pick" data-pick="model"/,
    '面板套的是共享 .setting-* 那一套，只有一个字段')
  // 判据 1：BOT 侧不许再有第二套入口/选择器的类名（§6 探针：真存在的旧类名）。
  assert.doesNotMatch(panel.innerHTML, /bp-pick|bp-modelbar/, '旧模型入口的类名一个都不留')
  // 判据 1 的落位口径：面板必须是 .bp-composer 的后代（`$('bpSettings').closest('.bp-composer')`
  // 要能 `contains($('bpSettingsPanel'))`），否则 absolute 面板会相对页面定位、跑到屏幕外。
  // §6 探针用壳里真实存在的 id 链：bpComposer 是 bpSettingsPanel 的祖先。
  assert.ok(SHELL.ancestors.get('bpSettingsPanel').includes('bpComposer'),
    '面板长在输入条里面，absolute 才有定位祖先')
})

test('the list view keeps no settings key, because there is no Bot to change there', async () => {
  const page = fakeBrowser({
    answer: (method) => (method === 'bot.team' ? teamWithModel('magpie-gateway/group/pool') : {}),
  })
  await page.settle()
  assert.equal(page.node('bpSettings').hidden, true, '列表页没有入口')
  assert.equal(page.node('bpSettings').getAttribute('aria-expanded'), 'false')
  assert.equal(page.node('bpSettingsPanel').hidden, true)
  // 判据 1：名单页那一次点击不许顺手读一份用不到的模型目录。
  const before = page.calls.filter((call) => call.method === 'session.models').length
  clickModelToggle(page)
  await page.settle()
  assert.equal(page.calls.filter((call) => call.method === 'session.models').length, before,
    '列表页按设置键不读模型目录')
  assert.equal(page.node('bpSettingsPanel').hidden, true, '也不摆出面板')
})

test('opening the key reads the Host catalogue, and only the model is offered', async () => {
  const page = await modelPage()
  clickModelToggle(page)
  await page.settle()
  assert.ok(page.calls.some((call) => call.method === 'session.models'),
    '清单问的是宿主，不是写死在页面里的表')
  const panel = page.node('bpSettingsPanel')
  assert.equal(panel.hidden, false, '点开就摆出面板')
  assert.equal(panel.visible, true)
  assert.match(panel.innerHTML, /data-model-pick="magpie-gateway\/group\/pool"/, '当前模型在清单里')
  assert.match(panel.innerHTML, /data-model-pick="magpie-gateway\/group\/flash"/, '别的模型也在')
  assert.match(panel.innerHTML, /class="setting-opt is-on" data-model-pick="magpie-gateway\/group\/pool"/,
    '当前那个带着选中态')
  // 判据 1③：BOT 只有一个字段——模型。Pocket 那边的「预设」「思考强度」在这边不出现，
  // 哪怕宿主答案里带着 reasoning.efforts（MODEL_CATALOG 就带着），也不许列出来。
  assert.doesNotMatch(panel.innerHTML, /data-effort-pick/, '不摆思考档位这一组')
  assert.doesNotMatch(panel.innerHTML, /思考档位/, '也不摆这一组的标题')
  assert.equal((panel.innerHTML.match(/class="setting-field"/g) || []).length, 1,
    '整块面板只有一个字段')
  // 收起：再点一下同一处，面板收走，但目录不再重读（已经拿到了）。
  clickModelToggle(page)
  await page.settle()
  assert.equal(page.node('bpSettingsPanel').hidden, true)
  assert.equal(page.node('bpSettings').getAttribute('aria-expanded'), 'false')
  assert.equal(page.calls.filter((call) => call.method === 'session.models').length, 1,
    '目录读一次就够，收起再展开不重复问宿主')
})

test('picking a model goes through bot.update and is confirmed by re-reading the Bot', async () => {
  const page = await modelPage({
    onUpdate: (_held, payload) => (payload.model ? teamWithModel(payload.model) : _held),
  })
  clickModelToggle(page)
  await page.settle()
  const before = page.calls.filter((call) => call.method === 'bot.team').length
  clickModelPick(page, '[data-model-pick]', 'data-model-pick', 'magpie-gateway/group/flash')
  await page.settle()
  assert.deepEqual(
    page.calls.find((call) => call.method === 'bot.update').payload,
    { id: 'chief', model: 'magpie-gateway/group/flash' },
    '只发 id 与 model 两个字段——桥那侧的口径就是这样，界面不许自己加'
  )
  assert.ok(page.calls.filter((call) => call.method === 'bot.team').length > before,
    '改完再读一次团队视图：确认靠回读，不靠 update 的答复')
  assert.equal(page.node('bpToast').textContent, '已换到 magpie-gateway/group/flash')
  assert.match(page.node('bpSettingsPanel').innerHTML, /magpie-gateway\/group\/flash/,
    '面板里的选中态跟着回读走')
  assert.match(page.node('bpSettingsPanel').innerHTML,
    /class="setting-opt is-on" data-model-pick="magpie-gateway\/group\/flash"/,
    '刚换上的那个就地打勾')
})

test('a Host that answers but still runs the old model is said so, not papered over', async () => {
  const page = await modelPage() // 一直回读旧模型：update 收下了，但没真变
  clickModelToggle(page)
  await page.settle()
  clickModelPick(page, '[data-model-pick]', 'data-model-pick', 'magpie-gateway/group/flash')
  await page.settle()
  assert.equal(page.node('bpToast').textContent,
    '没换成：Bot 现在还是 magpie-gateway/group/pool',
    '回读说没变，就不许写「已换到」')
  assert.match(page.node('bpSettingsPanel').innerHTML, /magpie-gateway\/group\/pool/,
    '界面停在回读的事实上')
})

test('a settings panel for one Bot never stays open into the next conversation', async () => {
  const page = await modelPage()
  clickModelToggle(page)
  await page.settle()
  assert.equal(page.node('bpSettingsPanel').hidden, false)
  page.location.hash = ''
  page.fireWindow('hashchange')
  await page.settle()
  assert.equal(page.node('bpSettings').hidden, true, '回到列表，入口收起')
  assert.equal(page.node('bpSettings').getAttribute('aria-expanded'), 'false', '键也回到收起态')
  assert.equal(page.node('bpSettingsPanel').hidden, true, '面板也不许留在展开态')
})

test('a message typed here goes out as that session, in the shape the landing uses', async () => {
  const page = fakeBrowser({ answer: (method) => (method === 'session.history' ? { events: [] } : {}) })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=' + encodeURIComponent('Chief')
  page.fireWindow('hashchange')
  await page.settle()
  // 判据 2：会话页不再在标题行重复一遍会话名（返回键与它已表明身处会话），
  // 只有列表页那行写 document.title。
  assert.equal(page.node('bpTitle').textContent, '', '会话页标题行留空')
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
  // and they stay until the Host shows the message itself. The text now sits in
  // an inner .markdown block (BOT_PAGE_JS renders through the shared markdown
  // source), so the words come after that opening tag, not straight after .bp-msg.
  assert.match(page.node('bpMsgs').innerHTML, /class="bp-msg message user is-pending"><div class="markdown"><p>在吗<\/p>/, 'the send paints at once, marked pending')
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
  assert.match(msgs, /class="bp-msg message user"><div class="markdown"><p>你好<\/p>/)
  assert.match(msgs, /class="bp-msg message assistant"><div class="markdown"><p>在<\/p>/)
  assert.ok(!msgs.includes('tool_use'), '工具调用不进手机的消息流')
  assert.ok(!msgs.includes('先想一想'), '思考也不进')
})

// 2026-10-27: the message body now renders through the same markdown source the
// Pocket landing uses (pages.js markdownScript → BOT_PAGE_JS). This pins the two
// halves of that contract: block/inline markdown becomes elements instead of
// showing its own syntax, and the image rewrite — which needs the landing's
// session-file organ — stays out, so a picture arrives as the text it was.
test('a message body is drawn as markdown, and an image stays the text it arrived as', async () => {
  const body = '# 标题\n\n说 **重点** 和 `代码`\n\n- 一\n- 二\n\n![截图](C:\\tmp\\a.png)'
  const page = fakeBrowser({
    answer: (method) => (method === 'session.history'
      ? {
          events: [
            { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: body }] } } } },
          ],
        }
      : {}),
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle()
  const msgs = page.node('bpMsgs').innerHTML
  assert.ok(msgs.includes('<h1>标题</h1>'), 'a heading becomes a heading, not a line starting with #')
  assert.ok(msgs.includes('<strong>重点</strong>'), 'bold becomes bold')
  assert.ok(msgs.includes('<code>代码</code>'), 'a code span becomes code')
  assert.ok(msgs.includes('<li>一</li>'), 'a list becomes a list')
  assert.ok(!msgs.includes('**重点**'), 'no raw markdown syntax is left on screen')
  assert.ok(!msgs.includes('<img'), 'no image is requested from a page that cannot serve session files')
  assert.ok(msgs.includes('![截图](C:\\tmp\\a.png)'), 'the image syntax is shown as written')
})

// ---------------------------------------------------------------------------
// 设计底座（用户 2026-10-27）：列表渲染只进槽位、返回只在会话里、时间与状态
// 和 landing 同一套哲学 —— 有数据就显示，没有就不占位。
// ---------------------------------------------------------------------------

test('the roster paints into the slots it was handed, never over the page itself', async () => {
  // 当日固定时刻，用来反算卡头右格期望的「HH:MM」（clockOf 三层时钟，与 Pocket 同构）。
  const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime() }
  const page = fakeBrowser({
    answer: (method) => {
      if (method !== 'bot.team') return {}
      const team = teamWith()
      team.bots[0].updatedAt = at(9, 5)
      team.bots.push({ id: 'other-a', name: 'OtherA', role: '成员', sessionId: 's-other', updatedAt: at(11, 20) })
      team.rooms[0].updatedAt = at(18, 40)
      return team
    },
  })
  await page.settle()
  assert.equal(page.node('bpList').innerHTML, '', 'the scroll box itself is never rewritten — the roster lands in the slots')
  assert.match(page.node('bpMembersList').innerHTML, /data-open="room" data-id="r-flow"/, 'the group row lands in its slot')
  assert.match(page.node('bpMembersList').innerHTML, /data-sid="s-chief"/, 'the member row lands in its slot')
  // 判据 4A②/4B：三张分区卡出生就是展开的。单次命中即绿会放过「只第一张展开」的缺陷，
  // 所以数次数，不是找一个。
  assert.equal(
    (page.node('bpMembersList').innerHTML.match(/class="ws-card expanded"/g) || []).length, 3,
    '三张分区卡全都出生展开，不是只第一张')
  // 判据 4A③：标题文案固定这三个，且不再是 .bp-section 那套 h2。
  assert.deepEqual(
    (page.node('bpMembersList').innerHTML.match(/class="ws-name">([^<]+)</g) || [])
      .map((s) => s.replace(/class="ws-name">|</g, '')),
    ['主 BOT', '其他 BOT', '群聊'], '三区标题就是这三个字')
  assert.doesNotMatch(page.node('bpMembersList').innerHTML, /<h2/,
    '判据 4A③：不许再套 .bp-section 那套标题')
  // 判据 Q2-①：卡头右格写的是「这一区最后活动时刻」，不是条数——三张卡各按自己
  // 那批记录的 updatedAt 求 max，再走本页 clockOf（三层时钟）。这里锁死「右格是时间、
  // 不是计数」：空分区不输出该格，所以三张卡都放人的那条同时也在锁「三卡同一份规则」。
  assert.deepEqual(
    (page.node('bpMembersList').innerHTML.match(/class="ws-last-time">([^<]+)</g) || [])
      .map((s) => s.replace(/class="ws-last-time">|</g, '')),
    ['09:05', '11:20', '18:40'], 'each card carries the time of its own last activity, not a count')
  assert.equal(page.node('bpMsgs').hidden, true, 'the chat half survived the paint: the old bug destroyed it')
  assert.equal(page.node('bpMsgs').visible, false, 'list view: the transcript is hidden, so it is not visible')
  // 判据 2①：列表页那行标题仍是 document.title（只有会话页才留空）。
  assert.equal(page.node('bpTitle').textContent, 'DS Bot', '列表页标题行写的是 document.title')
})

test('each section is newest-first, and a main Bot outranks everyone in its own card', async () => {
  // 判据 4C：分区内「主 bot 优先 → 其余按 updatedAt 降序」，群聊分区同样按 updatedAt
  // 降序；不许吃接口原序。夹具故意把接口原序打乱（主 bot 的 updatedAt 最小、普通 bot
  // 是降序给的），接口原序与期望序在每一区都不一样。
  const bots = [
    { id: 'main-old', name: 'MainOld', role: '主', sessionId: 's-main-old', updatedAt: 1 },
    { id: 'other-d', name: 'OtherD', role: '成员', sessionId: 's-d', updatedAt: 40 },
    { id: 'main-mid', name: 'MainMid', role: '主', sessionId: 's-main-mid', updatedAt: 2 },
    { id: 'other-b', name: 'OtherB', role: '成员', sessionId: 's-b', updatedAt: 20 },
    { id: 'main-new', name: 'MainNew', role: '主', sessionId: 's-main-new', updatedAt: 3 },
    { id: 'other-e', name: 'OtherE', role: '成员', sessionId: 's-e', updatedAt: 50 },
    { id: 'other-a', name: 'OtherA', role: '成员', sessionId: 's-a', updatedAt: 10 },
    { id: 'other-c', name: 'OtherC', role: '成员', sessionId: 's-c', updatedAt: 30 },
  ]
  const rooms = [
    { id: 'r-old', name: 'Old', members: [], updatedAt: 5 },
    { id: 'r-new', name: 'New', members: [], updatedAt: 7 },
  ]
  const team = {
    bots,
    rooms,
    mainBotIds: ['main-old', 'main-mid', 'main-new'],
    questions: { count: 0 },
    work: { approvals: [] },
  }
  const page = fakeBrowser({ answer: (method) => (method === 'bot.team' ? team : {}) })
  await page.settle()
  const html = page.node('bpMembersList').innerHTML
  const order = (slice) => (slice.match(/data-sid="([^"]+)"/g) || []).map((s) => s.replace(/data-sid="|"/g, ''))

  // 主 BOT 卡在前，里面三条按 updatedAt 降序：3 → 2 → 1。
  assert.deepEqual(order(html), ['s-main-new', 's-main-mid', 's-main-old', 's-e', 's-d', 's-c', 's-b', 's-a'],
    '主区三条按 updatedAt 倒序排在最前，其余五条按 updatedAt 倒序跟上')
  const cards = html.split('<section class="ws-card')
  assert.equal(order(cards[1]).length, 3, '主 BOT 卡里正好三条')
  assert.deepEqual(order(cards[1]), ['s-main-new', 's-main-mid', 's-main-old'], '主区内部也是降序')
  assert.deepEqual(order(cards[2]), ['s-e', 's-d', 's-c', 's-b', 's-a'], '其他 BOT 卡五条，降序')
  // 群聊分区同样按 updatedAt 降序（7 → 5），不吃接口原序（5 → 7）。
  assert.deepEqual((cards[3].match(/data-id="([^"]+)"/g) || []).map((s) => s.replace(/data-id="|"/g, '')),
    ['r-new', 'r-old'], '群聊分区也按 updatedAt 降序')

  // 承重断言：排序靠的是这个比较器，而不是「接口正好按这个顺序给的」。删掉三处
  // .sort(byNewest) 里任何一处，上面的顺序断言就会红；这条钉的是它的存在。
  assert.match(BOT_PAGE_JS, /var byNewest = function \(a, b\) \{ return \(Number\(b\.updatedAt\) \|\| 0\) - \(Number\(a\.updatedAt\) \|\| 0\) \}/,
    '降序比较器只有一个，三处共用')
  assert.match(BOT_PAGE_JS, /mainBots\.sort\(byNewest\)/, '主区排一次')
  assert.match(BOT_PAGE_JS, /otherBots\.sort\(byNewest\)/, '其他区排一次')
  assert.match(BOT_PAGE_JS, /rooms\.slice\(\)\.sort\(byNewest\)/, '群聊区排一次')
})

test('tapping a section head folds that card, and the fold is memory-only', async () => {
  // 判据 4A⑥：点 .ws-toggle 切 expanded 类、aria-expanded 跟着变，状态只存内存。
  const page = fakeBrowser({ answer: (method) => (method === 'bot.team' ? teamWith() : {}) })
  await page.settle()
  assert.equal((page.node('bpMembersList').innerHTML.match(/class="ws-card expanded"/g) || []).length, 3,
    '出生三张都展开')
  assert.equal(page.node('bpMembersList').innerHTML.match(/aria-expanded="true"/g).length, 3,
    '三个折叠键出生都报展开')

  const head = {
    getAttribute: (name) => (name === 'data-ws-toggle' ? '群聊' : null),
    setAttribute(name, value) { this[name] = String(value) },
    classList: { add() {}, remove() {} },
  }
  const card = {
    classList: {
      classes: new Set(['ws-card', 'expanded']),
      add(name) { this.classes.add(name) },
      remove(name) { this.classes.delete(name) },
      contains(name) { return this.classes.has(name) },
    },
  }
  head.closest = (selector) => (selector === '.ws-card' ? card : null)
  page.click('bpList', { target: { closest: (selector) => (selector === '[data-ws-toggle]' ? head : null) } })
  await page.settle()
  assert.equal(head['aria-expanded'], 'false', '点一下：这个键报收起')
  assert.equal(card.classList.contains('expanded'), false, '这张卡的 expanded 也摘了')

  // 只存内存：折叠不写 localStorage（判据 4A⑥ 与 §5 第 4B 裁决）。本页确实用
  // localStorage，但只存名单缓存这一个键（TEAM_CACHE_KEY），折叠没有自己的键。
  assert.deepEqual(Array.from(page.store.keys()), ['pocketBotTeam'],
    '折叠没有落进 localStorage：这里只有名单缓存那一个键')
  // 这一条在 baseline 与 head 上都是 0 命中（名单缓存里从来没有过折叠字段），
  // 按 §6 它不构成本批的证据，只是防「以后有人图省事把折叠塞进缓存」的回归守卫；
  // 真正的承重断言是上面那条键集 deepEqual。
  assert.doesNotMatch(page.store.get('pocketBotTeam') || '', /collapsed/i,
    '名单缓存里也不带折叠状态')
})

test('hidden Bots fold behind one row in the other-Bots card, and only there', async () => {
  // 判据 Q2-②：hidden 只在「其他 BOT」这一栏折叠；主 BOT 卡照显（哪怕主 Bot 自己被标
  // 隐藏），群聊卡没有这个机制。展开态只存内存，与 collapsedWs 同口径。
  const team = {
    bots: [
      { id: 'm1', name: 'Main', role: '主', sessionId: 's-main', updatedAt: 9, hidden: true },
      { id: 'o1', name: 'Other1', role: '成员', sessionId: 's-o1', updatedAt: 8 },
      { id: 'o2', name: 'Other2', role: '成员', sessionId: 's-o2', updatedAt: 7 },
      { id: 'h1', name: 'Hidden1', role: '成员', sessionId: 's-h1', updatedAt: 6, hidden: true },
    ],
    rooms: [{ id: 'r1', name: 'Flow', members: [{ id: 'm1' }], updatedAt: 6 }],
    mainBotIds: ['m1'],
    questions: { count: 0 },
    work: { approvals: [] },
  }
  const page = fakeBrowser({ answer: (method) => (method === 'bot.team' ? team : {}) })
  await page.settle()
  const sectionOf = (title) => (page.node('bpMembersList').innerHTML
    .split('<section class="ws-card').find((b) => b.includes('>' + title + '<')) || '')

  const other = sectionOf('其他 BOT')
  assert.match(other, /data-sid="s-o1"/, '第一个普通成员在「其他 BOT」里占行')
  assert.match(other, /data-sid="s-o2"/, '第二个普通成员也在')
  assert.doesNotMatch(other, /data-sid="s-h1"/, '隐藏的成员默认不占行')
  const toggle = other.match(/<button type="button" class="older-row" data-hidden-toggle="1">([^<]*)</)
  assert.ok(toggle, '卡底补一行展开开关')
  assert.match(toggle[1], /隐藏/, '开关文案说的是隐藏')
  assert.match(toggle[1], /1/, '文案带着隐藏的条数')

  // 用户 10:00 原话「应该只在『其他 BOT』这一栏有这个东西。主 BOT 和群应该都没有」。
  assert.match(sectionOf('主 BOT'), /data-sid="s-main"/, '主 BOT 卡不折叠，隐藏标记不影响它')
  assert.doesNotMatch(sectionOf('主 BOT'), /older-row/, '主 BOT 卡里没有隐藏折叠开关')
  assert.doesNotMatch(sectionOf('群聊'), /older-row/, '群聊卡里没有隐藏折叠开关')

  page.click('bpList', { target: { closest: (selector) => (selector === '[data-hidden-toggle]' ? {} : null) } })
  await page.settle()
  const opened = sectionOf('其他 BOT')
  assert.match(opened, /data-sid="s-h1"/, '展开后隐藏的成员按同一份 4C 序插回来')
  assert.match(opened, /收起隐藏 BOT/, '展开后按钮说的是收起')
  assert.doesNotMatch(opened, /显示 \d+ 个隐藏 BOT/, '展开后不再说「显示」')
  assert.deepEqual(Array.from(page.store.keys()), ['pocketBotTeam'],
    '隐藏展开态没有落进 localStorage')
})

test('a working bot and a talking group say so on their rows', async () => {
  const team = teamWith()
  team.bots[0].working = { tool: 'bash' }
  team.rooms[0].running = true
  const page = fakeBrowser({ answer: (method) => (method === 'bot.team' ? team : {}) })
  await page.settle()
  const members = page.node('bpMembersList').innerHTML
  assert.match(members, /正在 bash/, 'the member row names what the Bot is running')
  // 2026-10-29 判据 D5a②：正在活动改用 Pocket 的行级状态类（.task-row.is-running），
  // BOT 原来的 .bp-avatar.is-busy 边框脉冲是第二套语言，已删。
  assert.match(members, /class="task-row is-running"/, 'the row carries Pocket is-running, not a pulsing avatar')
  assert.doesNotMatch(members, /is-busy/, 'the pulsing busy mark is gone')
  const rooms = page.node('bpMembersList').innerHTML
  assert.match(rooms, /讨论中/, 'the group row says a turn is running there')
  assert.match(rooms, /class="task-row is-running"/, 'the group row uses the same state class')
  assert.doesNotMatch(rooms, /is-busy/, 'and the same one, not a second')
})

test('a waiting bot gets the amber row instead of a word of its own', async () => {
  const team = teamWith()
  team.bots[0].waiting = true
  const page = fakeBrowser({ answer: (method) => (method === 'bot.team' ? team : {}) })
  await page.settle()
  const html = page.node('bpMembersList').innerHTML
  // 2026-10-29 判据 D5a③ / §4.1 第 2 条：换掉硬编码色的 .bp-tag-wait，改用 Pocket
  // is-awaiting 的琥珀行；「等模型」不再单独占一个文字标签——标签位只留两格，
  // 被角色与「正在 X」共用，等模型由整行的底色说出来。
  assert.match(html, /class="task-row is-awaiting"/, 'the row carries Pocket is-awaiting')
  assert.doesNotMatch(html, /等模型/, 'the state is told by the row, not by a word tag')
  assert.doesNotMatch(html, /bp-tag-wait/, 'the hardcoded amber tag is gone')
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

test('a working Bot says so on a status line at the tail, not by painting the answer as streaming', async () => {
  const now = new Date()
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 30).getTime()
  const team = teamWith()
  team.bots[0].working = { tool: 'bash' }
  const page = fakeBrowser({
    answer: (method) => (method === 'bot.team' ? team : method === 'session.history'
      ? { events: [saidByUser('在吗', 2, at), saidByBot('正在写', 3, at)], hasMore: false }
      : {}),
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle()
  const msgs = page.node('bpMsgs').innerHTML
  // 判据 3：进行中不再靠给最后一条消息加 .streaming 表达（那是第二套语言），改成消息流
  // 末尾追加一行 #bpTurnStatus；文案由 working 的形状决定——对象带 tool 就报工具名。
  assert.doesNotMatch(msgs, /class="markdown streaming"/, '最后一条消息不再被打上 streaming')
  // 承重断言：baseline 那套「挑出最后一条 assistant 再给它挂 .streaming」的写法是靠
  // `lastAnswer` 这个下标变量撑起来的（`e46e979:lib/bot-page.js` 里 4 处）。本批把它连同
  // `i === lastAnswer ? ' streaming' : ''` 一起删干净了——这才是真删掉的标识。
  assert.doesNotMatch(BOT_PAGE_JS, /lastAnswer/, '挑「最后一条 assistant」的那套下标逻辑整段删掉了')
  // 回归守卫：防止有人再把 streaming 这套第二语言补回来（baseline 里它本就不是这个写法，
  // 所以这条只守未来，不证明本批删了什么）。
  assert.doesNotMatch(msgs, /classList\.add\('streaming'\)/, '也不许在别处补一个 streaming')
  assert.match(msgs, /<div id="bpTurnStatus" class="turn-status">正在 bash<\/div>/, '末尾那行报到工具名')
  assert.equal((msgs.match(/id="bpTurnStatus"/g) || []).length, 1, '只有一行，不叠')
  assert.ok(page.node('bpMsgs').querySelector('#bpTurnStatus'), '画完能按 id 取到它')
  // 消息流末尾就是它：它后面不该再有别的行。
  assert.ok(msgs.trimEnd().endsWith('</div>'), '结尾仍是一个闭合的 div')
  assert.equal(msgs.replace(/[\s\S]*id="bpTurnStatus"/, '').replace(/<\/div>\s*$/, '').includes('bp-msg'),
    false, '状态行排在所有消息之后，后面不再有消息行')
})

test('a working Bot with no tool named just says it is working', async () => {
  const now = new Date()
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 30).getTime()
  const team = teamWith()
  team.bots[0].working = true
  const page = fakeBrowser({
    answer: (method) => (method === 'bot.team' ? team : method === 'session.history'
      ? { events: [saidByUser('在吗', 2, at), saidByBot('在', 3, at)], hasMore: false }
      : {}),
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle()
  const msgs = page.node('bpMsgs').innerHTML
  assert.match(msgs, /<div id="bpTurnStatus" class="turn-status">正在干活<\/div>/,
    'working 是个布尔时只说「正在干活」，不编一个工具名')
  assert.doesNotMatch(msgs, /分|秒/, '不带用时')
})

test('the status line goes away the moment the Bot stops working, with no completion line left behind', async () => {
  const now = new Date()
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 30).getTime()
  const team = teamWith()
  team.bots[0].working = { tool: 'bash' }
  let held = team
  const page = fakeBrowser({
    answer: (method) => (method === 'bot.team' ? held : method === 'session.history'
      ? { events: [saidByUser('在吗', 2, at), saidByBot('正在写', 3, at)], hasMore: false }
      : {}),
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle()
  assert.ok(page.node('bpMsgs').innerHTML.includes('id="bpTurnStatus"'), '先有一行')
  const still = teamWith()
  still.bots[0].working = false
  held = still
  page.fireIntervals(5000) // 会话里那支五秒轮询：refreshLatest().then(refreshWorking)
  await page.settle()
  const after = page.node('bpMsgs').innerHTML
  assert.doesNotMatch(after, /id="bpTurnStatus"/, '开工结束就收走，不留一行完成文案')
  assert.doesNotMatch(after, /已完成|已就绪|写完了/, '也不留完成文案')
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

// ---------------------------------------------------------------------------
// Bot 之间的往来（用户 2026-10-29 21:57：「我希望跟电脑端一样，bot之间的对话默认折」）
//
// 一个 Bot 写给另一个 Bot，宿主记的是 source.kind:'bot' 的 user/message。电脑端
// 把它画成一行「Message from / Reply from + 名字」（ds-bot client.js EventLine），
// 更早那几段走 bot.earlier 时本页也画成 `· 名字`（earlierRows）；只有最新这一页
// 因为 source.kind 不是 'user' 整条丢掉，于是只有往来记录的段打开是空白的。
// ---------------------------------------------------------------------------

/** One relay record as the Host writes it: a user/message whose source is a Bot. */
function relayedBy(name, seq, role) {
  return {
    event: {
      type: 'user/message', seq,
      data: { message: { source: { kind: 'bot', form: 'relay', role: role || 'request', senderName: name, senderSessionId: 's-' + name.toLowerCase() }, content: [{ type: 'text', text: '[Message from ' + name + '] 这边的一段正文，很长很长' }] } },
    },
  }
}

/** A handoff record: a part boundary the Host writes into the new part. */
function handedOff(seq) {
  return {
    event: {
      type: 'user/message', seq,
      data: { message: { source: { kind: 'bot', form: 'relay', role: 'handoff', senderName: 'DS Bot', handoff: true }, content: [{ type: 'text', text: '[Handoff · part 57] DS Bot moved your own chat with the user into a new part.' }] } },
    },
  }
}

/** A system injection: not a Bot speaking, nothing this page may draw. */
function injected(kind, seq) {
  return { event: { type: 'user/message', seq, data: { message: { source: { kind }, content: [{ type: 'text', text: '系统注入的 ' + kind + ' 正文' }] } } } }
}

async function openWith(events) {
  const page = fakeBrowser({
    answer: (method) => (method === 'bot.team' ? teamWith() : method === 'session.history' ? { events, hasMore: false } : {}),
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle()
  return page
}

test('a Bot writing to a Bot is drawn as one line naming the sender, like the desktop', async () => {
  const page = await openWith([relayedBy('Pixel', 4, 'request'), relayedBy('Curator', 6, 'reply')])
  const msgs = page.node('bpMsgs').innerHTML
  assert.match(msgs, /<div class="bp-event">· Pixel<\/div>/, 'the sender is named on one line, the way bot.earlier rows already are')
  assert.match(msgs, /<div class="bp-event">· Curator<\/div>/, 'a reply is one line too')
  assert.ok(!msgs.includes('这边的一段正文'), 'the body stays folded: the desktop shows the sender line, not the whole message')
  assert.ok(!msgs.includes('bp-empty'), 'and the part is not empty any more')
})

test('a handoff keeps its own label instead of collapsing into a sender line', async () => {
  const page = await openWith([handedOff(3), relayedBy('Pixel', 4, 'request')])
  const msgs = page.node('bpMsgs').innerHTML
  assert.match(msgs, /<div class="earlier-divider"><span>\[Handoff · part 57\]/, 'the part boundary is on screen, as it is on the desktop')
  assert.match(msgs, /<div class="bp-event">· Pixel<\/div>/, 'and the relay next to it is still one line')
})

test('the injections the Host puts in a turn stay off the transcript', async () => {
  const page = await openWith([injected('runtime-context', 1), injected('plugin:memory', 2), injected('tool-jobs', 3), relayedBy('Pixel', 4, 'request')])
  const msgs = page.node('bpMsgs').innerHTML
  assert.ok(!msgs.includes('系统注入的'), 'no system injection became a message, even one whose source.kind is bot-like')
  assert.match(msgs, /<div class="bp-event">· Pixel<\/div>/, 'the Bot that really wrote is still named')
})

// 判据 5（往来折叠，L140–155）：连续三条同一对端的往来合成一行「与 X 的 N 条往来」，
// 点开是与对端 Bot 的会话，单条仍显示 `· 名字`。

test('three consecutive relays from one Bot take one line, counted', async () => {
  const page = await openWith([relayedBy('Pixel', 4, 'request'), relayedBy('Pixel', 6, 'reply'), relayedBy('Pixel', 8, 'request')])
  const msgs = page.node('bpMsgs').innerHTML
  assert.equal((msgs.match(/bp-comm/g) || []).length, 1, 'one folded line, not three')
  assert.match(msgs, /与 Pixel 的 3 条往来/, 'the line says how many messages it stands for')
  assert.ok(!msgs.includes('<div class="bp-event">· Pixel</div>'), 'the singles are gone — the run replaced them')
  assert.ok(!msgs.includes('这边的一段正文'), 'the bodies stay folded, as before')
})

test('a folded relay line opens the conversation with that Bot', async () => {
  const page = await openWith([relayedBy('Pixel', 4, 'request'), relayedBy('Pixel', 6, 'reply')])
  const msgs = page.node('bpMsgs').innerHTML
  // 这一行自己就把对端带着走：点开落到哪个会话，全部信息来自这一行，不看别处。
  assert.match(msgs, /data-exchange="1"[^>]*data-sid="s-pixel"/, 'the folded line carries the peer session id it opens')
  assert.match(msgs, /data-name="Pixel"/, 'and the name it shows in the part header')
  const exchange = { getAttribute: (name) => ({ 'data-sid': 's-pixel', 'data-name': 'Pixel' })[name] ?? null }
  page.click('bpMsgs', { target: { closest: (selector) => (selector === '[data-exchange]' ? exchange : null) } })
  await page.settle()
  assert.equal(page.location.hash, '#s=s-pixel&k=bot&t=Pixel', 'the tap lands in the peer Bot part, the desktop openExchange path')
})

test('a run breaks at another speaker and at anything in between; a lone relay keeps its line', async () => {
  const page = await openWith([
    relayedBy('Pixel', 4, 'request'),
    saidByBot('中间插进来的一句', 5),
    relayedBy('Pixel', 6, 'reply'),
    relayedBy('Pixel', 7, 'request'),
    relayedBy('Curator', 8, 'reply'),
  ])
  const msgs = page.node('bpMsgs').innerHTML
  assert.match(msgs, /<div class="bp-event">· Pixel<\/div>/, 'the run before the message is a lone relay and keeps its line')
  assert.match(msgs, /与 Pixel 的 2 条往来/, 'seq keeps counting from where the run resumes')
  assert.ok(!msgs.includes('与 Pixel 的 3 条往来'), 'the assistant row in between ended the run')
  assert.match(msgs, /<div class="bp-event">· Curator<\/div>/, 'another speaker starts its own line, never folded into the run')
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
  await finishSwitch(page)
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
  await finishSwitch(page)
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

// Both builders carry the Host's stamp the way a durable record really does: on
// the event itself. `message.messageTime` lives only on the landing's
// synthesized rows, so a fake that put it here let the clock-less Bot page pass
// for months (2026-10-27: the page printed no stamp at all on a phone).
/** @param {string} text @param {number} [seq] the Host's own event number, used to page backwards */
function saidByBot(text, seq, time) {
  return { event: { type: 'assistant/message', seq, time, data: { message: { content: [{ type: 'text', text }] } } } }
}

/** A user row with a Host timestamp, the field the transcript clock prints. */
function saidByUser(text, seq, time) {
  return { event: { type: 'user/message', seq, time, data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } } }
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
  assert.match(msgs, /class="bp-msg message user"><div class="markdown"><p>最早的那句话/, 'the oldest part is drawn, not just the newest')
  assert.match(msgs, /class="bp-msg message user"><div class="markdown"><p>上一段说的话/, 'and the part right before it')
  assert.match(msgs, /class="bp-divider"/, 'a divider marks where one part begins')
  assert.match(msgs, /class="bp-msg message assistant"><div class="markdown"><p>最新那一段的话/, 'the part the page was pointed at stays at the bottom')

  const calls = page.calls.filter((call) => call.method === 'bot.earlier')
  assert.equal(calls.length, 2, 'it keeps asking until the Host says there is nothing older')
  assert.deepEqual(calls[0].payload, { sessionId: 's-chief', cursor: null }, 'the first page starts from the newest end')
  assert.deepEqual(calls[1].payload, { sessionId: 's-chief', cursor: { part: 2, beforeSeq: 40 } }, 'and carries the cursor it got back')
  assert.ok(!msgs.includes('data-earlier'), 'with nothing older left there is no button to press')
})

test('entering a chat repaints the transcript at most four times instead of thirteen', async () => {
  // 卡三 A1／A4（用户 2026-10-29 20:18：「刚进来时候会跳」）。改前：一页只有十
  // 几条消息，`loadChat` 为了凑满 FILL_ROWS=60 行继续向前补，最多 6 跳，每跳整段
  // 重画两遍（忙碌一遍、数据到一遍），进一次会话最多重画 13 遍，肉眼就是跳。
  // 改后：第一页已经超过一屏就停，一次也不补。
  let pages = 0
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') {
        const events = []
        for (let i = 0; i < 12; i += 1) events.push(saidByBot('第 ' + i + ' 句', 100 - i))
        return { events }
      }
      if (method === 'bot.earlier') {
        pages += 1
        return { items: earlierPage(3, 'p' + pages + '-'), cursor: { part: pages + 1, beforeSeq: 7 } }
      }
      return {}
    },
  })
  await page.settle(40)
  const box = page.node('bpMsgs')
  const before = box.htmlWrites()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(80)

  // 十二行 = 480px，替身的一屏是 300px：打开即满屏，不该再向前翻一页
  const paints = box.htmlWrites() - before
  assert.ok(paints <= 4, 'entering repaints the transcript at most four times, got ' + paints)
  assert.equal(page.calls.filter((call) => call.method === 'bot.earlier').length, 0,
    'a first page that already covers the screen is left alone')
})

test('a first page shorter than the screen keeps reaching back until the screen is full', async () => {
  // 卡三 A2／A3／A5：「一屏就停」不等于「只读一页」。第一页没填满屏时要接着补，
  // 补到满屏或者没有更早记录为止；忙碌态只在首跳画一次，不然同一段内容会被画两遍。
  let pages = 0
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') return { events: [saidByBot('一句', 9), saidByBot('二句', 8), saidByBot('三句', 7)] }
      if (method === 'bot.earlier') {
        pages += 1
        return { items: earlierPage(3, 'p' + pages + '-'), cursor: { part: pages + 1, beforeSeq: 6 } }
      }
      return {}
    },
  })
  await page.settle(40)
  const box = page.node('bpMsgs')
  const before = box.htmlWrites()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(80)

  // 三行 120px 不够一屏，补一页六行 240px 还不够，补到九行 360px 才停
  assert.equal(pages, 2, 'it keeps reading until the screen is full, then stops')
  assert.ok(box.scrollHeight > box.clientHeight + 8, 'and the screen really is full')
  const paints = box.htmlWrites() - before
  assert.ok(paints <= 2 + pages, 'one paint per page it reads plus one busy paint at most, got ' + paints + ' for ' + pages + ' pages')
  assert.ok(box.scrollHeight - box.scrollTop - box.clientHeight <= 2, 'a reader who was at the bottom is still at the bottom')
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
  // 2026-10-29 起「一屏」按消息区的真实高度量（一行 40px、替身一屏 300px），
  // 不再数 60 行：三十条一页就有 1200px，补过一页就停。
  assert.equal(auto.length, 1, 'one page of thirty already covers the screen, so it stops there')
  assert.match(page.node('bpMsgs').innerHTML, /data-earlier="1"/, 'the rest is behind the button')

  const rowsBefore = (page.node('bpMsgs').innerHTML.match(/class="bp-msg /g) || []).length
  const button = { disabled: false }
  page.click('bpMsgs', { target: { closest: (selector) => (selector === '[data-earlier]' ? button : null) } })
  await page.settle(20)
  const all = page.calls.filter((call) => call.method === 'bot.earlier')
  assert.equal(all.length, 2, 'the button asks for exactly one more page')
  assert.deepEqual(all[1].payload, { sessionId: 's-chief', cursor: { part: 1, beforeSeq: 7 } }, 'from where the automatic fill stopped')
  const rowsAfter = (page.node('bpMsgs').innerHTML.match(/class="bp-msg /g) || []).length
  assert.ok(rowsAfter > rowsBefore, 'pressing the button still adds rows: the one-screen rule is the automatic path only')
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
  // 2026-10-27③a 起，名单画完就会给头几个会话各读一页（预取）。那几读发生在
  // 打开之前，所以先取一次基线：这里要说的是「打开这一个会话读了几页」。
  const baseline = page.calls.filter((call) => call.method === 'session.history').length
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(80)

  const history = page.calls.filter((call) => call.method === 'session.history').map((call) => call.payload).slice(baseline)
  // 预取已经把这一段的最新一页读进缓存（③a），打开时不再重读它：所以这里从
  // 「再往前两页」开始，第一读直接带锚。
  assert.equal(history.length, 2, 'the preview held the newest page, so this part is read two pages back inside itself')
  assert.equal(history[0].beforeSeq, 300, 'the page after the preview starts at the oldest seq seen')
  assert.equal(history[1].beforeSeq, 200)
  assert.equal(history[1].maxMessages, 60, 'every page asks for the same window')

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
  // 同上：预取的那几读不计入「打开这个会话读了几页」。
  const baseline = page.calls.filter((call) => call.method === 'session.history').length
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(80)

  const history = () => page.calls.filter((call) => call.method === 'session.history').length - baseline
  const earlier = () => page.calls.filter((call) => call.method === 'bot.earlier').length
  assert.equal(history(), 1, 'the preview held the newest page, and the one page back brought nothing older')
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

// 2026-10-29, in the card's own terms: a poll must not move what the reader is
// looking at (top of #bpMsgs as the reference, first visible row as the offset,
// the landing's own 2px threshold from lib/pages.js:3134) and must not drop rows
// already drawn. Both halves are computed here, not judged by eye.
test('a poll that hands back fewer rows leaves the drawn ones where they were', async () => {
  let reads = 0
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') {
        reads += 1
        // A part turned over between reads: the second page starts later and
        // holds fewer rows than the screen already has. Replacing the drawn rows
        // with it (what refreshLatest used to do wholesale) drops the older half.
        const first = reads === 1 ? 1 : 8
        const count = reads === 1 ? 12 : 5
        return { events: Array.from({ length: count }, (_, i) => saidByBot(`第 ${first + i} 句`, first + i)), hasMore: false }
      }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(60)

  const box = page.node('bpMsgs')
  const lookAt = () => {
    const rows = box.querySelectorAll(':scope > .message')
    const top = box.getBoundingClientRect().top
    for (const row of rows) {
      const rect = row.getBoundingClientRect()
      if (rect.bottom > top + 2) return { rows: rows.length, offset: Math.round(rect.top - top) }
    }
    return { rows: rows.length, offset: null }
  }
  box.scrollTop = 100 // the reader stopped a little above the newest line
  const before = lookAt()
  assert.equal(before.rows, 12, 'the first read drew a dozen rows')
  assert.ok(before.offset !== null, 'and one of them is in front of the reader')

  page.fireIntervals(5000)
  await page.settle(20)

  const after = lookAt()
  assert.ok(after.rows >= before.rows, 'the rows already drawn are still on screen')
  assert.ok(Math.abs(after.offset - before.offset) <= 2,
    'and the reader still has the same row in front of them, within the landing\'s 2px threshold')
})

test('the word you sent is on screen once, through the poll that brings it back', async () => {
  let reads = 0
  let showFrom = null
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') {
        reads += 1
        // The Host shows nothing until the poll after the send: a queued word
        // takes a read or two to surface.
        if (showFrom === null || reads < showFrom) return { events: [], hasMore: false }
        return { events: [saidByUser('在吗', 9), saidByBot('在', 10)], hasMore: false }
      }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(60)

  const countOf = (haystack, needle) => haystack.split(needle).length - 1
  showFrom = reads + 2 // the send's own refresh reads once; the poll reads after it

  page.node('bpPrompt').value = '在吗'
  page.click('bpSend', {})
  await page.settle(20)
  const optimistic = page.node('bpMsgs').innerHTML
  assert.equal(countOf(optimistic, '在吗'), 1, 'the optimistic row is the only copy on screen')
  assert.match(optimistic, /is-pending/, 'and it is marked still waiting')

  page.fireIntervals(5000)
  await page.settle(20)
  const shown = page.node('bpMsgs').innerHTML
  assert.equal(countOf(shown, '在吗'), 1, 'the Host showing the word does not draw it twice')
  assert.ok(!shown.includes('is-pending'), 'the optimistic copy is gone')
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
  await finishSwitch(page)

  const cue = page.calls.find((call) => call.method === 'page.cue')
  assert.ok(cue, 'the hop says so while this page is still going, on the request the browser finishes for a dying document')
  assert.equal(cue.payload.page, 'landing',
    'and it names the page it is heading for: the way out lands on the Pocket page')
  assert.deepEqual(page.navigations, [], 'the landing is reached by replacing this entry, not by stepping back into it')
  assert.deepEqual(page.historyReplaced, [['/']], 'and the entry it replaces points at the landing')
  assert.equal(page.historyReplaced[0][0], '/', 'the landing is exactly /')
})

test('the last word on the way out rides a keepalive request, because the answer is needed', async () => {
  const page = fakeBrowser({ answer: () => ({}) })
  await page.settle()

  page.click('bpHome', { preventDefault() {} })
  await finishSwitch(page)

  // 2026-10-27②：卡片要印「已载入多少」，beacon 交不回答案，所以走 keepalive
  // fetch（文档消失后浏览器仍会把它做完），beacon 只在没有 fetch 时兜底。
  assert.equal(page.calls.filter((call) => call.method === 'page.cue').length, 1,
    'one cue, and nothing else, carries the word')
  assert.equal(page.beacons.length, 0,
    'the beacon is the fallback for a page without fetch, not the path taken when fetch is here')
})

// P1-5：真机的过渡卡是 70ms×4 的动画，走完再隔 60ms 才离开。替身从前没有
// `querySelectorAll`，页面为此写了一条双判据，于是这条分支只有真机跑得到——
// 动画里抛错让 `leave()` 永不执行（用户卡过渡页）时，测试面照样全绿。
test('the way out shows every step, and strikes a row only once its reading is settled', async () => {
  const page = fakeBrowser({ answer: () => ({}) })
  const cueCount = () => page.calls.filter((call) => call.method === 'page.cue').length
  assert.equal(page.switchSteps.length, 4,
    'the shell ships four boot steps, and the stand-in counts them off the markup instead of trusting a number')
  assert.deepEqual([...page.switchSteps[0].classes], ['boot-step', 'is-active'],
    'the card starts on its first step, as the markup says')

  page.click('bpHome', { preventDefault() {} })
  assert.equal(page.node('bpSwitchOverlay').hidden, false, 'the card covers the screen while the page is on its way out')
  assert.deepEqual(page.navigations, [], 'and the page has not started leaving')

  page.fireTimers(70)
  // 用户 2026-10-27：「每一行都是要完全完成以后才是划横线」——走过不等于读完，
  // 读数没定稿的这一行不划线（旧实现是 i<idx 就划，于是出现「四行全划完、右边还空着」）。
  assert.ok(!page.switchSteps[0].classList.contains('is-done'),
    'a row that walked past is not struck while its reading is still open')
  assert.ok(page.switchSteps[1].classList.contains('is-active'), 'and the one it reached is is-active')
  assert.deepEqual(page.navigations, [], 'still animating, so still here')

  for (let step = 1; step < page.switchSteps.length; step += 1) page.fireTimers(70)
  await page.settle()
  // Q1 起末行一有读数就收口：冷摘要写「未就绪」，收口即离开（原来那 60ms 的帧同步
  // 尾巴没有了）。所以这里钉的是「四档走完、每一行都定了稿，然后才离开」。
  assert.ok(page.switchSteps.every((step) => step.classList.contains('is-done')),
    'the last row settles every open row, so the card never leaves with an unstruck line')
  assert.equal(cueCount(), 1, 'and only then does it say its one word')
  assert.deepEqual(page.navigations, [], 'the landing is reached by replacing this entry')
  assert.deepEqual(page.historyReplaced, [['/']], 'and the entry it replaces points at the landing')
  assert.equal(page.historyReplaced[0][0], '/', 'the landing is exactly /')
})

// 判据 6D：完成文字落屏之后要停 0.5 秒再走（t1 - t0 ∈ [500,1200]ms），而且这 0.5 秒
// 必须是**自己那一支表**量出来的，不许靠帧同步顺带凑够。这一条把三件事分开钉：
// ①「已就绪」落屏那一刻还没开始走；②下一档就是整整 500ms 的停留，不是 60ms 的余量；
// ③读数没到（fail-closed 写「未就绪」）这条路上不做这次停留，仍按原来的兜底放行。
test('the way out dwells half a second after the completion line, on its own timer', async () => {
  const page = fakeBrowser({
    answer: (method) => (method === 'page.cue'
      ? { ready: true, workspaces: 3, sessions: 12, messages: null, bots: null, botSessions: null, rooms: null }
      : {}),
  })
  await page.settle()
  page.click('bpHome', { preventDefault() {} })
  // 桥的答复在微任务里就到了（真机也是 1.6s 上限内先答）。Q1 起四行由同一份
  // ladderRun 逐档推：推到第四档时它才取到「已就绪」，落屏之后那 0.5 秒才起算。
  await page.settle()
  for (let step = 0; step < page.switchSteps.length; step += 1) page.fireTimers(70)
  await page.settle()

  assert.equal(page.switchCounts[3].textContent, '已就绪', 'the completion line is on screen before the dwell starts')
  assert.ok(page.switchSteps.every((step) => step.classList.contains('is-done')), 'and every row is struck')
  assert.deepEqual(page.navigations, [], 't0: the line landed, the page has not left yet')

  // 判据 6D：t1 - t0 ≥ 500ms。只有 500ms 那一档烧掉之后才准离开——原来 60ms 的余量
  // 让「已就绪」几乎与跳转同帧，用户根本看不到（判据 §2 第 6 条）。
  page.fireTimers(500)
  await page.settle()
  assert.deepEqual(page.navigations, [], 't1: half a second after t0, the way out replaces this entry')
  assert.deepEqual(page.historyReplaced, [['/']], 'and the entry it replaces points at the landing')
  assert.equal(page.historyReplaced[0][0], '/', 'the landing is exactly /')
})

test('the way out does not pretend it read the landing: no dwell on the not-ready branch', async () => {
  const page = fakeBrowser({ answer: (method) => (method === 'page.cue' ? { ready: false, rows: 0, workspaces: 0 } : {}) })
  await page.settle()
  page.click('bpHome', { preventDefault() {} })
  await page.settle()
  for (let step = 0; step < page.switchSteps.length; step += 1) page.fireTimers(70)

  assert.equal(page.switchCounts[3].textContent, '未就绪', 'the card says the landing is cold instead of "已就绪"')
  // 未就绪这一档的停留是 0ms（ladderRun 的 notReadyDwellMs: 0）：文字落屏就离开，
  // 一次 500ms 的停留都没挣到，也不该被它拖慢。
  assert.deepEqual(page.navigations, [], 'the cold branch still leaves by replacing this entry')
  assert.deepEqual(page.historyReplaced, [['/']], 'and the entry it replaces points at the landing')
  assert.equal(page.historyReplaced[0][0], '/', 'the landing is exactly /')
  // 反证：那一档 500ms 的停留表根本不存在，烧它也不会再走一次。
  // 说清这条验的是什么：它证明的是 onDone 的幂等守卫（ladder 里 `if(left)return`）
  // 挡住重复交棒，不证明「停留时长」——停留时长由上面 6D 那组的 dwellTimer 断言管。
  // 别把它读成时序证据：这个断言在任何时长的实现下都能绿。
  page.fireTimers(500)
  await page.settle()
  assert.deepEqual(page.navigations, [], 'and the way out is a replace, not a step back')
  assert.deepEqual(page.historyReplaced, [['/']], 'and the entry it replaces points at the landing')
  assert.equal(page.historyReplaced[0][0], '/', 'the landing is exactly /')
})

// 判据 6D 的承重断言：停留必须挂在自己的表上。只断言「500ms 后才走」的话，把
// `setTimeout(depart, TRANSITION_DWELL_MS)` 删掉、让帧同步顺手多等一会儿，测试照样绿。
test('the half-second dwell is a timer of its own, not spare time inside the frame sync', () => {
  assert.match(BOT_PAGE_JS, /var TRANSITION_DWELL_MS = 500\b/, 'the dwell is a named constant, not a literal buried in a branch')
  // Q1 起这次停留由共用的 ladderRun 起表（链式 setTimeout，时长仍是那个具名常量）：
  // 卡3 把常量交给它，表在 ladderRun 内部 arm——不再是页面里那一句 setTimeout(depart, …)。
  assert.match(BOT_PAGE_JS, /dwellMs: TRANSITION_DWELL_MS/, 'the hold is handed to the ladder as the named dwell')
  assert.match(BOT_PAGE_JS, /dwellTimer=setTimeout\(/, 'and the ladder arms a timer of its own for it')
  // 下面两条是回归守卫（baseline 与 HEAD 都是 0 命中，它们守未来、不证明本批删了什么）：
  // 0.5 秒既不许内联在调用点，也不许折进帧同步自己的表里——那样就变成「帧同步顺手多等一会儿」。
  assert.doesNotMatch(BOT_PAGE_JS, /setTimeout\(depart, 500\)/, 'the 0.5s is not inlined at the call site')
  assert.doesNotMatch(BOT_PAGE_JS, /setTimeout\(go, 500\)/, 'nor is it folded into the frame sync’s own timer')
})

// 判据 9：预读队列 =（全部主 bot）∪（全部 pinned）∪（其余按 updatedAt 降序前 10 个）。
// 主 bot 与 pinned 都**不占**那十个名额——名额只发给剩下的普通会话。无 sessionId 的
// 不在队列里（没有可读的东西），群聊仍是另一条队列。
test('the preload queue takes every main Bot, then every pinned one, then the newest ten of the rest', () => {
  const previewQueue = (team, previews) =>
    Array.from(vm.runInNewContext(`(${extractFunction(BOT_PAGE_JS, 'previewQueue')})`, { PREVIEW_BOTS, PREVIEW_ROOMS })(team, previews))

  const bots = []
  for (let i = 0; i < 3; i += 1) bots.push({ id: `main${i}`, sessionId: `main${i}`, updatedAt: 100 + i })
  for (let i = 0; i < 15; i += 1) bots.push({ id: `bot${i}`, sessionId: `bot${i}`, updatedAt: i + 1 })
  bots.push({ id: 'no-session', updatedAt: 999 })
  const rooms = [{ id: 'r1' }, { id: 'r2' }]

  const queue = previewQueue({ bots, rooms, mainBotIds: ['main0', 'main1', 'main2'] }, {})
  assert.equal(PREVIEW_BOTS, 10, '十个仍是定值，主 bot 不从这里扣名额')
  assert.equal(queue.length, 3 + 10 + 2, '三主 + 最新十个普通 + 两个群聊')
  assert.deepEqual(queue.slice(0, 3), ['main2', 'main1', 'main0'], '主 bot 全取，按 updatedAt 倒序排在最前')
  assert.deepEqual(queue.slice(3, 13), ['bot14', 'bot13', 'bot12', 'bot11', 'bot10', 'bot9', 'bot8', 'bot7', 'bot6', 'bot5'],
    '其余只发十个名额，按 updatedAt 倒序')
  assert.equal(queue.includes('no-session'), false, '没有 sessionId 就没有可读的东西，不进队列')
  assert.deepEqual(queue.slice(13), ['r1', 'r2'], '群聊还是单独那一队')
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

test('a failed team read shows no recalled roster, so the first frame cannot jump', async () => {
  // R14-3.5：BOT 主页的机器人数/群数若先用 localStorage 缓存 `pocketBotTeam` 画一
  // 遍、真值到达再二画，就是现象①⑤（数字先少后跳）。新契约：首帧数字只来自同一
  // 份快照，缺项留白，不许先用缓存旧值画一遍。`paintRecall()`（原「名单画完即把
  // 上次缓存先画一版」）已删——这条按新契约改：缓存里的名单在任何时刻都不得上屏。
  const recalled = {
    bots: [{ id: 'b-chief', name: 'Chief', role: 'Chief of Staff', sessionId: 's-chief' }],
    rooms: [],
    mainBotIds: ['b-chief'],
    questions: null,
    at: Date.now()
  }
  // The read fails: under the old contract the phone would still show the cached
  // roster; under R14-3 the first frame has to stay blank, not a stale copy.
  const page = fakeBrowser({
    seed: { pocketBotTeam: JSON.stringify(recalled) },
    answer: (method) => (method === 'bot.team' ? { ok: false, error: '连不上', code: 'bot/down' } : {}),
  })
  await page.settle(20)

  assert.ok(!page.node('bpMembersList').innerHTML.includes('Chief'),
    'the roster from last time is NOT painted first: a stale copy must not fill the list before the read (R14-3)')
  assert.ok(!page.node('bpMembersList').innerHTML.includes('data-approve'),
    'no 允许/拒绝 button comes back from a copy — a stale card must not be answerable')
  const defined = BOT_PAGE_JS.includes('function paintRecall()') ? 1 : 0
  assert.equal(BOT_PAGE_JS.split('paintRecall()').length - 1 - defined, 0,
    'the cache-first paint has no call site left: a stale roster must not be drawn before the read (R14-3.5)')
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

test('the copy kept for the next open keeps the question count and never the card', async () => {
  const page = fakeBrowser({ answer: (method) => (method === 'bot.team' ? teamWithQuestion() : {}) })
  await page.settle()

  const kept = JSON.parse(page.store.get('pocketBotTeam'))
  assert.deepEqual(kept.questions, { count: 1 }, 'the count travels in the copy')
  assert.ok(!JSON.stringify(kept).includes('要走哪条路？'),
    'the question itself does not: a recalled card would invite an answer the Host has already closed')
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
  assert.match(page.node('bpHint').textContent, /连不上 BOT/)
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
  assert.equal(page.node('bpMembersList').innerHTML, '', 'the roster slot is cleared')
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


test('the Bot page uses PIN-code style transition card with Pocket heading when switching to Pocket', () => {
  const html = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  assert.match(html, /id="bpSwitchOverlay" class="switch-overlay" hidden/, 'the switch overlay is in markup')
  // 2026-10-29 判据 D6 + 第五节 A：视觉顺序 h1(24) → p(14) → boot-step(13) → brand(13)，
  // 品牌行从主标题上方挪到阶梯下方，当页脚签名——这样它不会再小于自己下方任何文本。
  assert.match(html, /<div class="card"><h1>Pocket<\/h1><p>/, 'the card opens with the heading, not the wordmark')
  assert.match(html, /<\/div><div class="brand" style="flex-wrap:wrap">/, 'and the wordmark closes it as a footer signature')
  assert.match(html, /Curiouser and curiouser!/, 'the card wears the same wordmark line as the landing')
  assert.match(html, /<em style="flex-basis:100%;text-align:center">/, 'the line sits on its own row, not beside the name')
  assert.match(html, /<h1>Pocket<\/h1>/, 'carries the Pocket heading')
  assert.match(html, /class="boot-steps show"/, 'carries the PIN boot steps container')
  assert.match(html, /读取工作区/, 'step 1 reads what the landing reads first')
  assert.match(html, /读取会话列表/, 'step 2 reads the session list')
  assert.match(html, /读取会话消息/, 'step 3 reads the messages')
  assert.match(html, /正在准备页面/, 'step 4 prepares the page')
})

test('the Pocket page uses PIN-code style transition card with BOT heading when switching to Bot', () => {
  const html = renderMobilePage({ locale: 'zh', boot: null })
  assert.match(html, /id="switchOverlay" class="switch-overlay" hidden/, 'the Pocket switch overlay is in markup')
  // 2026-10-29 判据 D6 + 第五节 A：与 BOT 侧那张卡同序，品牌行落在阶梯之后。
  assert.match(html, /<div class="card"><h1>BOT<\/h1><p>/, 'the card opens with the heading, not the wordmark')
  assert.match(html, /<\/p><div class="brand" style="flex-wrap:wrap">/, 'and the wordmark closes it as a footer signature')
  assert.match(html, /Curiouser and curiouser!/, 'the card wears the same wordmark line as the landing')
  assert.match(html, /<em style="flex-basis:100%;text-align:center">/, 'the line sits on its own row, not beside the name')
  assert.match(html, /<h1>BOT<\/h1>/, 'carries the BOT heading')
  assert.match(html, /class="boot-steps show"/, 'carries the PIN boot steps container')
  assert.match(html, /机器人数/, 'step 1 counts the Bots the Bot page will list')
  assert.match(html, /群数/, 'step 2 counts the groups')
  assert.match(html, /加载消息/, 'step 3 counts the messages the /bot document ships')
  assert.match(html, /正在准备页面/, 'step 4 prepares the page')
  // 三格起始形态按「本轮快照到没到」分两类：Pocket→BOT 卡前三格（BOT/群/消息）在快照到手
  // 之前留白、真值一次写成（判据 R14-3.2/3 禁止先画 0 再改真值）；冷启动卡那几格本轮不改，
  // 仍写「0＋单位」。
  assert.match(html, /data-unit=" 个 BOT"[^>]*data-blank="1"[^>]*><\/span>/, 'step 1 starts blank until the snapshot lands, never a painted 0')
  assert.match(html, /data-unit=" 个会话"[^>]*>0 个会话</, 'step 2 starts at zero chats')
  assert.match(html, /data-unit=" 个群"[^>]*data-blank="1"[^>]*><\/span>/, 'step 3 starts blank until the snapshot lands')
  assert.match(html, /data-unit=" 条消息"[^>]*data-blank="1"[^>]*><\/span>/, 'the messages cell starts blank until the snapshot lands')
  assert.match(html, /data-unit=""[^>]*>准备中</, 'the prepare step starts with its own word')
})

test('going to the Bot page replaces the landing entry, so the way back leaves instead of bouncing', () => {
  const html = renderMobilePage({
    locale: 'zh',
    boot: null,
    assets: { cssUrl: '/app.css?h=1', jsUrl: '/app.js?h=2' },
  })
  // Q4 (2026-10-30): Pocket 主页与 BOT 主页互为平级主页，主页上返回＝离开。这一跳必须 replace 掉
  // Pocket 那条历史，BOT 页 leave() 的 history.back() 才不会弹回 Pocket 主页（10-27 曾反向要求 push）。
  assert.match(html, /var doNav=function\(\)\{location\.replace\("\/bot"\)\}/, 'the hop replaces the landing entry')
  assert.doesNotMatch(html, /location\.href="\/bot"/, 'the hop does not push a parent entry behind the Bot page')
  assert.match(
    html,
    /window\.addEventListener\("pageshow",function\(\)\{var ov=document\.getElementById\("switchOverlay"\);if\(ov\)ov\.hidden=true\}\)/,
    'the card is lifted when this document comes back from the bfcache',
  )
})

test('the Bot page lifts its own card when the browser restores it', () => {
  assert.match(BOT_PAGE_JS, /window\.addEventListener\('pageshow', function \(\) \{/, 'listens for the restore')
  assert.match(BOT_PAGE_JS, /var overlay = document\.getElementById\('bpSwitchOverlay'\)/, 'targets the switch card')
})

test('the landing, the reconnect page and both transition cards wear the same wordmark row', () => {
  const row = /<div class="brand" style="flex-wrap:wrap">(?:<img[^>]*>)?<span>Pocket<\/span><em style="flex-basis:100%;text-align:center">Curiouser and curiouser!<\/em><\/div>/
  const landing = renderMobilePage({ locale: 'zh', boot: null })
  const reconnect = renderMobileReconnectPage({ locale: 'zh', connectionMode: 'tunnel' })
  const bot = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  for (const [name, html] of [['landing', landing], ['reconnect', reconnect], ['bot', bot]]) {
    assert.match(html, row, `${name} wears the shared wordmark row`)
  }
})

test('the landing card counts the Bots the page already knows, before anything answers', () => {
  // User 2026-10-27: 「能启动，右边不是有那个数量、数字吗？这里没有」— the card sat
  // blank until a cue came back, and a cold bridge cue carries zeros.
  const html = renderMobilePage({
    locale: 'zh',
    boot: null,
    assets: { cssUrl: '/app.css?h=1', jsUrl: '/app.js?h=2' },
  })
  assert.match(html, /var lockRow=function\(i\)\{if\(!cueDone\|\|!cueSummary\)return null;/, 'every cell waits for the bridge cue, and none is pre-filled locally')
  assert.match(html, /typeof cueSummary\.bots==="number"\?cueSummary\.bots:null/, 'the Bot count is the summary field, not a local tally')
  assert.match(html, /typeof cueSummary\.rooms==="number"\?cueSummary\.rooms:null/, 'the room count is the summary field, not a local tally')
  assert.match(html, /typeof cueSummary\.messages==="number"\?cueSummary\.messages:null/, 'and the shipped-preview message count (R14-5.1)')
  assert.doesNotMatch(html, /cueSummary\.botSessions/, 'the Bot-session row is gone (R14-5.2)')
  assert.doesNotMatch(html, /var bots=0,chats=0;/, 'no local counter survives for the landing card')
  // Q1 口径 B：页面已知的读数不再预填进任何缓冲，也没有「先写着、激活时覆盖」的第二条路径——
  // 轮到哪一行，lockRow 就在那一刻现取（pre-cue 有读数的要求本身没变）。
  assert.doesNotMatch(html, /cardCounts\[0\]=/, 'no stashed count is painted ahead of the row that owns it')
  assert.doesNotMatch(html, /cardCounts\[i\]/, 'and no second buffer survives to be overwritten later')
  // 等强度替换（Q1）：原钉 `{host:ov,rows:rows,` 里的 `host` 是 ladderRun 早已不用的死参数
  // （行由 rows 给），去掉后这条仍然钉同一件事——卡不是自己一套循环，是被共用阶梯驱动的。
  assert.match(html, /var ladder=ladderRun\(\{rows:rows,/, 'the landing card is driven by the shared ladder')
  assert.match(html, /lock:lockRow/, 'the row picks up its reading the moment the ladder reaches it')
})

test('the BOT page counts the chats it already read, before the cue answers', () => {
  assert.match(BOT_PAGE_JS, /var knownRows = 0/, 'counts only what this page already read, as a fallback')
  assert.match(BOT_PAGE_JS, /if \(warm && typeof summary\.sessions === 'number'\) return summary\.sessions/, 'the summary field wins when the bridge answers')
  assert.match(BOT_PAGE_JS, /if \(warm && typeof summary\.messages === 'number'\) return summary\.messages/, 'and so does the message count')
  assert.doesNotMatch(BOT_PAGE_JS, /var previewRows = 0/, 'the old pre-cue tally is gone; the fallback is named for what it is')
  // 同一份行级规则：这些数只在轮到那一行时被 lock 现取，不预填、不提前写。
  assert.match(BOT_PAGE_JS, /var ladder = ladderRun\(\{/, 'the way-out card is driven by the shared ladder')
  assert.match(BOT_PAGE_JS, /lock: lock,/, 'and every row answers for itself when the ladder reaches it')
  assert.doesNotMatch(BOT_PAGE_JS, /if \(knownRows > 0\) cardCount\(1, knownRows\)/, 'no stashed count is painted ahead of its row')
  assert.doesNotMatch(BOT_PAGE_JS, /cardCount\(2, knownMessages\)/, 'nor for the message row')
})

// 判据 2：左上角返回键与 Pocket 一致——悬浮不占位、44×44 圆、Pocket 那条折线图标，
// 会话页不显示 Bot 名字；消息区顶部内边距跟着变成 4px。
test('the corner back key floats over the page like Pocket, and the chat header carries no name', () => {
  const html = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  // 判据 2②：会话页那根工具条脱离文档流，所以返回键不占位。BOT 只有一根条，它还服
  // 列表页（列表页的标题与刷新键本来在流内），所以悬浮只在 body.bp-chat 下成立——
  // 一刀切成 absolute 会把列表页的标题压到头一张分区卡上（2026-10-30 走查实测）。
  assert.match(html, /body\.bp-chat \.bp-bar\{position:\s*absolute;\s*inset:\s*0 0 auto;\s*z-index:\s*2;\s*min-height:\s*44px;.*?padding:\s*0;\s*background:\s*transparent;\s*pointer-events:\s*none\}/,
    '会话页工具条悬浮、不占位、不吃点击')
  // 这条在 baseline e46e979 与 head 上都是 0 命中，它守的是 2575f96 那笔的回归
  // （当时把 .bp-bar 一刀切成 absolute，列表页标题压到第一张卡上）。按 §6「0 命中
  // 当证据等于没核对」，这里如实标明它不是本批的改动证据，只是防复发。
  assert.doesNotMatch(html, /(^|\})\s*\.bp-bar\{position:\s*absolute/,
    '列表页那根条仍在流内（否则标题压在卡上）')
  assert.match(html, /\.bp-bar button\{[^}]*pointer-events:\s*auto/, '键本身仍然点得动')
  assert.match(html, /\.bp-bar \.bp-hint\{[^}]*pointer-events:\s*none/, '提示文字不吃点击')
  // 判据 2③：44×44 圆 + 阴影，图标是 Pocket 那条折线，不再是字符 ‹。
  assert.match(html, /\.bp-bar #bpBack\{[^}]*width:\s*44px;\s*min-width:\s*44px;\s*height:\s*44px[^}]*border-radius:\s*50%;\s*padding:\s*0;\s*box-shadow:\s*0 2px 8px rgba\(0,0,0,\.06\)/,
    '44×44 圆，带 Pocket 那层浅阴影')
  assert.match(html, /<button id="bpBack"[^>]*><svg width="20" height="20"[^>]*><path d="M10\.5 3L5\.5 8L10\.5 13" stroke="currentColor" stroke-width="1\.5"/,
    '图标是 Pocket 那条折线，20×20、1.5 粗')
  assert.doesNotMatch(html, /<button id="bpBack"[^>]*>‹/, '字符 ‹ 那版已经不在')
  // 判据 2④：消息区顶部内边距 6px → 4px（Pocket 的 .chat-open .messages 就是 4px）。
  assert.match(html, /#bpMsgs\{[^}]*padding:\s*4px 2px 14px\}/, '消息区顶部 4px')
})

test('the Bot page viewport and typography prevent mobile WebView zoom-out scaling regression', () => {
  const html = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  assert.match(html, /<meta name="viewport" content="[^"]*interactive-widget=resizes-content[^"]*">/, 'viewport resizes content')
  assert.match(html, /-webkit-text-size-adjust:\s*100%!important/, 'locks webkit text-size-adjust to prevent WebView shrinking')
  assert.match(html, /text-size-adjust:\s*100%!important/, 'locks text-size-adjust')
  assert.match(html, /font:\s*14px\/1\.5/, 'base font size is 14px, the same value as the Pocket body')
  // 2026-10-29 必改 1：消息正文不得自带字号。BOT 原来 body 与 .bp-msg 两处都是 15px，
  // 而 Pocket 的 .message 继承 body 的 14px——同一个组件两页差 7%，375px 下换行位置差一两个字。
  // 钉成「.bp-msg 不声明 font-size」，把 15px 加回去这条就红。
  assert.doesNotMatch(html, /\.bp-msg\{[^}]*font-size/, 'the message body declares no font size; it inherits 14px like Pocket .message')
  // 2026-10-29 判据 D2：基准是 Pocket 的 .task-row（44px / 13.5px·550），不是 64px / 15.5px。
  // 旧断言把 BOT 自己那套放大值当成了 Pocket 的值钉在这里，方向正好反了（Pocket 原文实测）。
  // 2026-10-30 判据 4A④：行容器改叫 .task-row，几何一条也不再由 BOT 自己声明——它逐字来自共享源。
  assert.doesNotMatch(html, /\.bp-row\{/, 'BOT 侧不再自己声明行容器几何（改叫 .task-row，由共享源提供）')
  // 注释里出现过旧类名，也不算——判据 4A④ 要的是「不再有那条规则」，注释不是规则。
  assert.doesNotMatch(html.replace(/\/\*[\s\S]*?\*\//g, ''), /\.bp-row\b/, '删干净：规则与注释都不留旧类名')
  assert.doesNotMatch(html, /\.task-row\{/, '也不许在这里复制一份 .task-row（那是第二处定义，改一处另一处必漂）')
  assert.match(renderMobilePage({ locale: 'zh', boot: null }), /\.task-row\{[^}]*min-height:\s*44px/, 'the shared source owns Pocket .task-row 44px')
  assert.match(html, /\.bp-copy b\{[^}]*font-size:\s*13\.5px/, 'card title aligned with Pocket .task-copy strong 13.5px')
})

test('the Bot transcript inherits Pocket message geometry instead of re-declaring it', () => {
  const html = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  const pocketHtml = renderMobilePage({ locale: 'zh', boot: null })
  // 2026-10-29 判据 D4：.bp-msg 本身就带 message 类，用户气泡与助手行的几何
  // （82% / 22px / 9px 15px / margin 8px 0 14px / padding 0 4px / 相邻 12px）
  // 由共享样式源提供。BOT 原文里的 84% / 20px / 9px 14px / padding 0 3px 是第二套值，
  // 留着就永远有两处定义，改一处另一处必漂。
  assert.match(pocketHtml, /\.message\.user\{[^}]*max-width:\s*82%;[^}]*background:\s*var\(--hover\);\s*border-radius:\s*22px;\s*padding:\s*9px 15px;\s*margin:\s*8px 0 14px\}/, 'the shared source still carries Pocket geometry')
  assert.match(pocketHtml, /\.message\.assistant\{[^}]*padding:\s*0 4px;\s*margin:\s*0\}/, 'and the assistant row')
  assert.match(pocketHtml, /\.message\.assistant\+\.message\.assistant\{[^}]*margin-top:\s*12px/, 'and the 12px between two assistant rows')
  assert.doesNotMatch(html, /\.bp-msg\.user\{/, 'the Bot page no longer re-declares the user bubble')
  assert.doesNotMatch(html, /\.bp-msg\.assistant\{/, 'nor the assistant row')
  // 行距必须由 .message 的 margin 单独决定：留着 gap 就会变成 gap+12px，两页行距各算各的。
  assert.match(html, /#bpMsgs\{[^}]*flex-direction:\s*column;\s*gap:\s*0/, 'the transcript column has no gap of its own')
  assert.match(html, /\.bp-tail\{[^}]*margin-top:\s*6px/, 'the stamp sits 6px under the text, like Pocket .msg-tail')
})

test('the Bot rows speak Pocket state semantics instead of a second language', () => {
  const html = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  const pocketHtml = renderMobilePage({ locale: 'zh', boot: null })
  // 2026-10-29 判据 D5a③：等用户这一态沿用 Pocket 的琥珀语言，色值与 .task-row.is-awaiting 逐字相同。
  assert.match(pocketHtml, /\.task-row\.is-awaiting\{background:#fdf3d3\}/, 'the shared source owns the amber row')
  assert.match(pocketHtml, /\.task-row\.is-awaiting \.task-status\{color:#c08400\}/, 'and its status mark')
  assert.match(pocketHtml, /@media \(prefers-color-scheme:dark\)\{\.task-row\.is-awaiting\{background:rgba\(201,138,4,\.17\)\}/, 'and the dark amber')
  // 2026-10-30 判据 4A④/④：BOT 的行容器就是 .task-row，于是这两态**零新增 CSS**——
  // BOT 侧不再自己写一条琥珀/品牌的第二定义，也不许复制一份共享规则。
  // 判据只看规则本体：注释里提到旧类名不算（那几条注释正是用来解释「副本为什么删」的），
  // 所以先去掉注释再判，和 §6「探针要用真实选择器」的要求一致——探的是规则，不是散文。
  const bare = html.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(bare, /\.[a-z-]*bp-row\.is-awaiting/, 'BOT 不再自己声明等用户的琥珀底')
  assert.doesNotMatch(bare, /\.bp-row\.is-running/, '也不再自己声明进行中的状态色')
  assert.doesNotMatch(bare, /\.task-row\.is-awaiting\{/, '更不许把共享那条复制到 BOT 侧')
  assert.doesNotMatch(bare, /\.task-row\.is-running\{/, '同上，进行中那条也不复制')
  // 2026-10-29 判据 D5a②：正在活动只剩一套语言——Pocket 的行级 is-running，状态位取 brand。
  // 状态位在 BOT 侧仍是 .bp-avatar / .bp-chip；它们只保留几何，颜色由共享 .bp-working 与行级态给。
  // 2026-10-29 必改 2：状态位常态必须是中性态，否则 running 的 brand 是「蓝→蓝」的空操作——
  // 改前 .bp-avatar 常态就是 16% 品牌底 + brand 字，Bot 行看不出忙闲；群行的 .bp-chip 常态是灰的，
  // 所以同一条规则只在群行有效。两个 26px 圆形图标位同取 var(--hover)，两行字面同构。
  assert.match(html, /\.bp-avatar\{[^}]*background:var\(--hover\);[^}]*color:var\(--muted\)/, 'the avatar idles neutral, so is-running has something to change')
  assert.match(html, /\.bp-chip\{[^}]*background:var\(--hover\);[^}]*color:var\(--muted\)/, 'and the group chip idles the same neutral, not surface on a surface row')
  assert.doesNotMatch(html, /\.bp-chip\{background:/, 'running changes the mark colour only, like Pocket .task-status, with no tint of its own')
  assert.doesNotMatch(html, /bpPulse/, 'the border pulse (a second language Pocket does not have) is gone')
  assert.doesNotMatch(html, /\.bp-avatar\.is-busy/, 'and so is the busy avatar class')
  assert.doesNotMatch(html, /bp-tag-wait/, 'and the hardcoded amber tag')
})

test('the row title is a flex line: the name alone ellipsizes, the tags never shrink, the sub line is the clock', async () => {
  const html = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  // 2026-10-29 判据 §4.1 第 1 条：省略只允许发生在名字那一层。整行 b 若自己挂着
  // overflow:hidden + text-overflow，标签是它的子元素，名字一长先被裁掉的就是「主」，
  // 裁成半个字——所以标题改成 flex 行容器，标签 flex:none，名字单独包一层裁。
  assert.match(html, /\.bp-copy b\{[^}]*display:flex[^}]*align-items:center[^}]*gap:4px[^}]*min-width:0/, 'the title is a flex line, not one ellipsized text block')
  assert.doesNotMatch(html, /\.bp-copy b\{[^}]*text-overflow:ellipsis/, 'the ellipsis moved off the whole title')
  assert.match(html, /\.bp-name\{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/, 'the name alone is the layer that clips')
  assert.match(html, /\.bp-tag\{flex:none;white-space:nowrap/, 'the main tag neither shrinks nor wraps')
  assert.match(html, /\.bp-tag-slot\{flex:none;white-space:nowrap/, 'nor does the role / working slot')
  // 判据第四节：副行让位给时间，规格取 Pocket .task-copy time。
  assert.match(html, /\.bp-sub\{color:var\(--muted\);font-size:10\.5px;font-variant-numeric:tabular-nums/, 'the sub line takes the Pocket clock size')

  const team = teamWith()
  const at = new Date()
  at.setHours(10, 30, 0, 0)
  team.bots[0].updatedAt = at.getTime()
  team.bots.push({ id: 'scout', name: 'Scout', role: '观察员', sessionId: 's-scout', updatedAt: at.getTime() })
  const page = fakeBrowser({ answer: (method) => (method === 'bot.team' ? team : {}) })
  await page.settle()
  const members = page.node('bpMembersList').innerHTML
  assert.match(members, /<b><span class="bp-name">Scout<\/span><span class="bp-tag-slot">观察员<\/span><\/b>/, 'an idle member shows its role in the one shared slot')
  assert.match(members, /<span class="bp-sub">10:30<\/span>/, 'and the sub line is the clock, not the role again')
  // 「主」已经占一格，角色若与它同字就不再重复一遍（夹具里 chief 的 role 正是「主」）。
  assert.doesNotMatch(members, /class="bp-tag">主<\/span><span class="bp-tag-slot">主</, 'the main tag is not repeated by an identical role')

  team.bots[1].working = { tool: 'bash' }
  const page2 = fakeBrowser({ answer: (method) => (method === 'bot.team' ? team : {}) })
  await page2.settle()
  const working = page2.node('bpMembersList').innerHTML
  assert.match(working, /<span class="bp-tag-slot"><span class="bp-working">正在 bash<\/span><\/span>/, 'a working member puts the work in the same slot, not a second one')
  assert.doesNotMatch(working, /观察员/, 'and the role does not sit beside it')
})

test('the Bot composer send button reuses Pocket circular layout and centers the arrow SVG without text nodes', () => {
  const html = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  assert.match(html, /<button id="bpSend" class="primary" aria-label="发送" disabled><svg width="17" height="17"/, 'reuses Pocket primary class with centered SVG')
  assert.doesNotMatch(html, /<button id="bpSend"[^>]*>[^<]*发送/, 'no inline text node inside button')
  // 2026-10-29 判据 D3：发送键改成与 Pocket .composer .primary 同构的墨色反色
  // （border-color:var(--ink) + background:var(--ink) + color:var(--paper)），
  // 品牌蓝底白字两个主题都不达 AA，见判据 2.3。
  // 2026-10-30 判据 1：输入条里多了设置键，这条规则必须收窄到 #bpSend——否则设置键
  // 会连同提交键一起吃到墨底反色。这里同时钉「收窄没改变选中元素」：还是 44×44 圆、
  // 还是墨底反色，只是不再用元素选择器。
  assert.match(html, /#bpSend\{[^}]*width:\s*44px;\s*min-width:\s*44px;\s*height:\s*44px;\s*border:\s*1px solid var\(--ink\);\s*border-radius:\s*50%/, 'pure 44x44 circular button')
  assert.match(html, /#bpSend\{[^}]*background:\s*var\(--ink\);\s*color:\s*var\(--paper\)/, 'send button uses the inverted primary pair, not the brand blue')
  assert.doesNotMatch(html, /#bpSend\{[^}]*background:\s*var\(--brand\)/, 'the brand-blue send button must be gone')
  assert.doesNotMatch(html, /\.bp-composer button\{/, '元素选择器不再误伤设置键')
})

test('the floating action buttons on Pocket and Bot pages share one rule instead of two copies', () => {
  const botHtml = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  const pocketHtml = renderMobilePage({ locale: 'zh', boot: null })

  // 2026-10-29 判据 D7①：这枚圆钮的几何只有一处定义，在共享样式源 /app.css 里。
  assert.match(pocketHtml, /\.bot-fab\{[^}]*width:\s*52px;\s*height:\s*52px;\s*border:\s*1px solid var\(--line\);\s*border-radius:\s*50%;\s*background:\s*var\(--card\);\s*color:\s*var\(--brand\);\s*box-shadow:\s*0 4px 16px rgba\(0,0,0,\.12\)/)
  assert.match(pocketHtml, /\.bot-fab:active\{[^}]*background:\s*var\(--hover\);\s*transform:\s*scale\(\.92\)/)

  // Bot 页挂同一个类名，自己不再抄一份（抄的那份是 .bp-fab）。
  assert.match(botHtml, /<a id="bpHome" class="bot-fab"/, 'the Bot home anchor uses the shared class')
  assert.doesNotMatch(botHtml, /\.bp-fab[{:]/, 'the Bot page must not keep a second copy of the circular geometry')

  // Both anchors are marked draggable="false"
  assert.match(botHtml, /id="bpHome"[^>]*draggable="false"/)
  assert.match(pocketHtml, /id="botFab"[^>]*draggable="false"/)
})

// 2026-10-29 判据 D7①：过渡卡是两页同一张卡，样式只该有一份。
// 上一版 Bot 页把 .switch-overlay 全套、.boot-step 全套、.bsc 连同 @keyframes 又抄了
// 一遍；抄本比共享源多写了 display/align-items/gap 与 .bsc 四条，两处细节各写一次。
test('the Bot transition card borrows the shared overlay language instead of copying it', () => {
  const botHtml = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  const pocketHtml = renderMobilePage({ locale: 'zh', boot: null })

  // 共享源里这一套是全的，过渡卡在两页都靠它。
  for (const rule of [
    /\.switch-overlay\{[^}]*position:\s*fixed;\s*inset:\s*0/,
    /\.switch-overlay\[hidden\]\{display:\s*none\}/,
    /\.switch-overlay h1\{[^}]*font-size:\s*24px/,
    /\.boot-step\{[^}]*font-size:\s*13px;\s*padding:\s*6px 0\}/,
    /\.boot-step-label\{flex:\s*1\}/,
    /@keyframes bspin\{to\{transform:rotate\(360deg\)\}\}/,
  ]) {
    assert.match(pocketHtml, rule, 'the shared sheet carries the transition card: ' + rule)
  }

  // Bot 页只留自己的结构性差异（#bpSwitchOverlay 这个容器），不再存样式副本。
  assert.match(botHtml, /<div id="bpSwitchOverlay" class="switch-overlay" hidden>/)
  // 只认「规则本体」的形态（选择器后紧跟 {）——注释里提到这些类名不算副本。
  for (const copy of [/\.switch-overlay\{/, /\.switch-overlay\[hidden\]\{/, /\.switch-overlay \.brand\{/, /\.switch-overlay h1\{/, /\.boot-steps\{/, /\.boot-step\{/, /\.boot-step-label\{/, /\.bsc\{/, /@keyframes bspin/]) {
    assert.doesNotMatch(botHtml, copy, 'the Bot page must not restate ' + copy)
  }
})

// 2026-10-29 判据 D6 + 第五节 A：切换页内部字号必须严格递减
// （h1 ≥ p ≥ .boot-step > .bsc），且 .brand 不得小于它下方任何文本——定案是把品牌行
// 从主标题上方挪到阶梯下方当页脚签名，这样它下方再没有文本，字号也不用动。
test('the transition cards keep one decreasing type ladder with the wordmark as its footer', () => {
  const pocketHtml = renderMobilePage({ locale: 'zh', boot: null })
  const botHtml = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })

  // 数字只写一次，在共享源里；两张卡都读它。
  assert.match(pocketHtml, /\.switch-overlay h1\{[^}]*font-size:\s*24px/, 'h1 tops the ladder')
  assert.match(pocketHtml, /\.switch-overlay p\{[^}]*font-size:\s*14px/, 'the sub line sits under it')
  assert.match(pocketHtml, /\.boot-step\{[^}]*font-size:\s*13px/, 'the step rows drop one notch below the sub line')
  assert.match(pocketHtml, /class="bsc" data-unit="[^"]*" style="[^"]*font-size:12px/, 'and the reading inside a step is smaller still')
  assert.match(pocketHtml, /\.switch-overlay \.brand\{[^}]*font-size:\s*13px/, 'the wordmark closes at 13px, never below what it sits under')

  // 页脚签名：品牌行在阶梯之后（markup 顺序，不用 CSS order 兜）。
  for (const [name, html, anchor] of [
    ['pocket', pocketHtml, 'id="switchOverlay"'],
    ['bot', botHtml, 'id="bpSwitchOverlay"'],
  ]) {
    const at = html.indexOf(anchor)
    assert.ok(at >= 0, `${name}: the card is in the markup`)
    const card = html.slice(html.indexOf('<div class="card">', at))
    const ladder = card.indexOf('class="boot-steps show"')
    const brand = card.indexOf('class="brand"')
    assert.ok(ladder >= 0, `${name}: the ladder is inside the card`)
    assert.ok(brand > ladder, `${name}: the wordmark comes after the ladder, not above the heading`)
  }
})

// 2026-10-28 闸门二退回项：共用卡在 pages.js 里无条件渲染「跳过」，而本页的委托只接了
// continue 与 cancel ⇒ 那枚按钮点了零反应，报告却写着「可跳过」。它漏在「P-9 只守 markup
// 结构、守不到事件绑定」这个缺口上。这条钉住绑定本身：跳过必须走到撤卡那条路。
test('the shared card’s skip control is wired, not a dead button', () => {
  assert.match(BOT_PAGE_JS, /name === 'skip'\)\s*dismissQuestion\(\)/,
    'skip must reach dismissQuestion: the card renders that control unconditionally')
  assert.match(BOT_PAGE_JS, /name === 'cancel'\)\s*dismissQuestion\(\)/, 'the close key still closes')
  assert.match(BOT_PAGE_JS, /name === 'continue'\)\s*submitQuestion\(\)/, 'submit still submits')
})

// ---------------------------------------------------------------------------
// 正在写的那一句（用户 2026-10-29 21:57：「最后一个回复不显示」）
//
// 这一页原先只有 5 秒一次的 session.history，而正在写的回合还没落进 history —— 末行
// 于是停在上一句。接流之后，字从流上来、行仍只有 chat.latest 一个来源（流往末尾挂一
// 条 _stream 行，每次重挂先摘掉它），隧道下开不出流就退回轮询。S1/S2 各钉一条腿，
// S3 反向把 chunk 那条分支变异掉，证明 S1 的断言真的在称它的重量。
// ---------------------------------------------------------------------------

/** The page's own transcript read: strips tags so an assertion can talk about words. */
function drawnRows(page) {
  const html = page.node('bpMsgs').innerHTML
  return (html.match(/class="bp-msg message (user|assistant)/g) || []).length
}

test('the answer being written reaches the transcript through the stream, not through the next poll', async () => {
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      // 轮询读到的只有写之前那一条：这句只能从流上进来。
      if (method === 'session.history') return { events: [saidByBot('写之前的那句', 260, 1_762_000_000_000)] }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(60)

  const before = page.node('bpMsgs').innerHTML
  assert.match(before, /写之前的那句/, 'the polled row is on screen when the chat opens')
  assert.doesNotMatch(before, /正在写的这句/, 'and nothing of the turn being written is known yet')

  const source = page.streams.at(-1)
  assert.ok(source, 'opening the chat opened the stream')
  // 带上手上已有的水位：进会话时屏上已经有 260 那一条，声明到这个序号，桥就不会把
  // 整窗重新灌一遍（不带 sinceSeq 桥按 -1 处理，等于说手上一份都没有）。
  assert.equal(source.url, '/api/session/stream?sessionId=s-chief&sinceSeq=260',
    'it is the bridge’s own stream for this conversation, opened at the water mark already on screen')

  const pollsBefore = page.calls.filter((call) => call.method === 'session.history').length
  const rowsBefore = drawnRows(page)
  source.dispatch('token', { type: 'start', revision: 9 })
  source.dispatch('token', { type: 'chunk', revision: 9, index: 0, chunk: { type: 'text-delta', text: '正在写的这句' } })
  source.dispatch('token', { type: 'chunk', revision: 9, index: 1, chunk: { type: 'text-delta', text: '的后半段' } })
  source.dispatch('token', { type: 'chunk', revision: 9, index: 2, chunk: { type: 'reasoning-delta', text: '（这是推理，不该进回复）' } })

  const after = page.node('bpMsgs').innerHTML
  assert.match(after, /正在写的这句的后半段/, 'the answer lands while it is still being written')
  assert.doesNotMatch(after, /这是推理/, 'a reasoning delta is not painted as the reply')
  assert.equal(page.calls.filter((call) => call.method === 'session.history').length, pollsBefore,
    'nothing was polled to get it: it came down the stream')
  assert.equal(drawnRows(page), rowsBefore + 1, 'the live answer is the one new row at the bottom, not a rewritten page')
  assert.ok(after.indexOf('写之前的那句') < after.indexOf('正在写的这句的后半段'),
    'and it sits under what was already said')

  // 写完之后 Host 的正式行接手：同一句不许画两遍，正式行要能落到同一个位置。
  source.dispatch('event', {
    event: { type: 'assistant/message', seq: 263, time: 1_762_000_000_500, data: { message: { content: [{ type: 'text', text: '正在写的这句的后半段' }] } } },
  })
  await page.settle(40)
  assert.equal(page.node('bpMsgs').innerHTML.split('正在写的这句的后半段').length - 1, 1,
    'the streamed copy gave way to the Host’s own row instead of being drawn beside it')
})

test('a chunk that arrives without its start frame is not wiped by the five-second poll', async () => {
  // 入库检的必改：中途订阅、丢帧时这一回合没有 start 帧，水位还停在 -1。而让位判据是
  // 「正式行 _seq 比水位大」——-1 之下任何既有 assistant 行都算更深，于是 5 秒一次的
  // refreshLatest 每一拍都把正在写的字清空一次。用户看到的是「写了一半的字每 5 秒消
  // 失一次」。这条不发 start、直接给 chunk，再手动推一拍轮询。
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') return { events: [saidByBot('写之前的那句', 260, 1_762_000_000_000)] }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(60)

  const source = page.streams.at(-1)
  assert.ok(source, 'opening the chat opened the stream')
  // 只有 chunk，没有 start。
  source.dispatch('token', { type: 'chunk', revision: 9, index: 0, chunk: { type: 'text-delta', text: '正在写的这句' } })
  assert.match(page.node('bpMsgs').innerHTML, /正在写的这句/, 'the piece lands even without a start frame')

  // 这一拍轮询读到的是「写之前的那句」（seq 260）。水位若还停在 -1，它就算比水位深，
  // 正文被清空——这正是必改要堵的那条路。
  page.fireIntervals(5000)
  await page.settle(60)
  const after = page.node('bpMsgs').innerHTML
  assert.match(after, /正在写的这句/, 'the half-written answer survives the poll: the chunk established its own water mark')
  assert.match(after, /写之前的那句/, 'and the transcript under it is still drawn')
})

test('a stream that cannot carry frames is closed, and the five-second poll still lands the last answer', async () => {
  let history = [saidByBot('写之前的那句', 260, 1_762_000_000_000)]
  const page = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') return { events: history }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(60)

  const source = page.streams.at(-1)
  assert.ok(source, 'the stream was tried')
  source.fail()
  assert.equal(source.closed, true, 'a stream that cannot carry frames is closed instead of being retried for ever')
  // 隧道下桥连得上、帧留不住：断了之后这一页不许停在原地，5 秒一次的读还在。
  history = [saidByBot('写之前的那句', 260, 1_762_000_000_000), saidByBot('写完的那句话', 263, 1_762_000_001_000)]
  page.fireIntervals(5000)
  await page.settle(60)
  assert.match(page.node('bpMsgs').innerHTML, /写完的那句话/, 'the poll is the fallback: the last answer still lands')

  // 回列表要把流断掉：否则上一个会话的帧会往列表上写字。
  page.location.hash = ''
  page.fireWindow('hashchange')
  await page.settle(20)
  assert.equal(source.closed, true, 'leaving the conversation closes its stream')
})

test('REVERSE: with the chunk body emptied the answer being written never reaches the transcript', async () => {
  // 反向承重（§5 S3）。变异只动一行：chunk 里往流式行追字那句换成空操作，其余一字
  // 不改。S1 那条断言必须因此变红，而且红在「最后一条没更新」——actual 里仍画着写
  // 之前那句、却没有正在写的这句；若它红在别处（页面没开、抛错），这条测试同样红。
  const mutated = BOT_PAGE_JS.replace(
    "chat.streamText = String(chat.streamText || '') + piece",
    "chat.streamEnded = false"
  )
  assert.notEqual(mutated, BOT_PAGE_JS, 'the mutation landed on the line it means to break')

  const page = fakeBrowser({
    js: mutated,
    answer: (method) => {
      if (method === 'bot.team') return teamWith()
      if (method === 'session.history') return { events: [saidByBot('写之前的那句', 260, 1_762_000_000_000)] }
      return {}
    },
  })
  await page.settle()
  page.location.hash = '#s=s-chief&k=bot&t=Chief'
  page.fireWindow('hashchange')
  await page.settle(60)
  const source = page.streams.at(-1)
  source.dispatch('token', { type: 'start', revision: 9 })
  source.dispatch('token', { type: 'chunk', revision: 9, index: 0, chunk: { type: 'text-delta', text: '正在写的这句' } })

  let failure = null
  try {
    assert.match(page.node('bpMsgs').innerHTML, /正在写的这句/, 'the answer being written is on screen')
  } catch (error) {
    failure = error
  }
  assert.ok(failure, 'the mutation must break the assertion — otherwise it is not carrying the weight')
  const actual = String(failure.actual)
  assert.doesNotMatch(actual, /正在写的这句/, 'it goes red on the last answer not being updated')
  assert.match(actual, /写之前的那句/, 'while the transcript itself is still drawn: the red is not somewhere else')
})


// ---------- 判据 ③d：BOT 顶部与 Pocket 主页 header 逐件对齐 --------------------

test('the BOT header wears the same four fixtures as the Pocket home header', () => {
  const html = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  // 左：brand（22px /app-icon + 文字，与 Pocket lib/pages.js:1037 同一形状）。
  assert.match(html, /<div class="brand"><img src="\/app-icon" alt="" style="width:22px;height:22px;border-radius:5px;object-fit:cover"><span>BOT<\/span><\/div>/,
    'the left slot is Pocket\u2019s brand: the same icon size and the same word slot')
  // 右：授权胶囊 / 刷新圆钮 / 重启圆钮 / 状态点 + 文字，四件齐全且全用共享类。
  assert.match(html, /<span id="bpExpiry" class="head-expiry" hidden><\/span>/, 'the expiry capsule is the shared .head-expiry')
  assert.match(html, /<button id="bpReload" class="head-icon"/, 'reload is a round .head-icon key, not a text glyph')
  assert.match(html, /<button id="bpRestart" class="head-icon"/, 'restart is the second round .head-icon key')
  assert.match(html, /<div id="bpStatus" class="status connecting" role="status"/, 'the dot is the shared .status, born connecting')
  assert.match(html, /<span id="bpStatusText" class="status-text" aria-hidden="true">/, 'and it speaks through the shared .status-text')
  // 旧那一行裸标题的尺寸规则必须消失（判据验收：grep 归零）。
  assert.doesNotMatch(html, /\.bp-bar b\{/, 'the old bare <b> title rule is gone')
  assert.doesNotMatch(html, /font-size:16px;font-weight:650/, 'and so is its type scale')
  // ③d 只在有 rpc 的页面上加纸：brand 与右侧四件都不许在会话页占位（Pocket 的
  // body.chat-open header 同样整条隐藏），刷新键由既有 .hidden 关闭。
  assert.match(html, /body\.bp-chat \.bp-bar \.brand,body\.bp-chat \.bp-bar \.head-right\{display:none\}/,
    'the chat view keeps only the floating back key')
})

test('the header states follow the shared three-state semantics, and the expiry capsule says when', () => {
  return (async () => {
    // 固定本地时刻 ⇒ 期望文案不随测试机时区漂。
    const until = new Date(2026, 10, 30, 9, 5, 0, 0).getTime()
    const page = fakeBrowser({
      answer: () => teamWith(),
      status: { expiresAt: until, hostReachable: false },
    })
    await page.settle()
    const dot = page.node('bpStatus')
    assert.equal(dot.className, 'status degraded', 'ok + hostReachable:false is the yellow state, same as Pocket')
    assert.equal(page.node('bpStatusText').textContent, '宿主机不响应', 'and it says why in words, not only in colour')
    assert.equal(page.node('bpExpiry').hidden, false, 'a payload with expiresAt fills the capsule')
    // 胶囊只印「至 MM-DD」（2026-10-31 第二轮）：375 宽放不下完整时刻，而 375 是主流宽。
    // 完整时刻不丢，挂在 title 上。
    assert.equal(page.node('bpExpiry').textContent, '至 11-30', 'the capsule prints the day it expires, short enough for 375px')
    assert.equal(page.node('bpExpiry').title, '授权至 2026-11-30 09:05', 'the full stamp stays on the title, so nothing is lost')

    const down = fakeBrowser({ answer: () => teamWith(), statusFailure: true })
    await down.settle()
    assert.equal(down.node('bpStatus').className, 'status error-state', 'an unpaired or failing status read is the red state')
    assert.equal(down.node('bpStatusText').textContent, '连接断开', 'and it says disconnected')
    assert.equal(down.node('bpExpiry').hidden, true, 'no payload means no capsule')
  })()
})

test('restart asks first, and only then posts the same request the desktop sheet posts', () => {
  return (async () => {
    const page = fakeBrowser({ answer: () => teamWith() })
    await page.settle()
    assert.equal(page.node('bpRestartCard').hidden, true, 'the sheet starts closed')
    page.click('bpRestart')
    assert.equal(page.node('bpRestartCard').hidden, false, 'the key opens the confirmation sheet')
    assert.equal(page.node('bpRestartOverlay').hidden, false, 'with the shared overlay behind it')
    assert.equal(page.restartCalls.length, 0, 'nothing is posted before the confirmation')
    page.click('bpRestartGo')
    assert.deepEqual(page.restartCalls, [{ force: false }], 'the confirmed restart posts {force:false}, as Pocket does')
  })()
})

// ---------- Q3：切入瞬间的大空白 --------------------------------

test('the roster is painted from the document itself, so no skeleton ever appears', () => {
  const view = {
    mainBotIds: ['b1'],
    bots: [{ id: 'b1', name: 'Curator', sessionId: 's1', updatedAt: 2_000 }],
    rooms: [],
    questions: { count: 0 },
    work: { approvals: [] }
  }
  const html = renderBotPage({
    cssUrl: '/app.css?h=1',
    jsUrl: '/bot.js?h=2',
    boot: { team: view, previews: { s1: { events: [{ seq: 1, type: 'user/message', turnId: 't1', text: 'hi' }], hasMore: false } } }
  })

  // R10-B：骨架整套退场——文档里不许再有骨架节点、骨架样式或「先浮层后替换」的等高补偿。
  assert.doesNotMatch(html, /bp-skel/, 'no skeleton classes remain')
  assert.doesNotMatch(html, /#bpSkel/, 'and no skeleton node')
  assert.doesNotMatch(html, /#bpMembersList\{min-height:/, 'no height compensator to keep the slot from jumping')
  // 首帧的来源是文档自己：roster 与预览页内联、脚本内联，所以解析完就是最终画面。
  assert.match(html, /<script>window\.__BOT_BOOT__=\{"team":\{"mainBotIds":\["b1"\]/,
    'the roster is in the document before any script runs')
  assert.ok(html.indexOf('window.__BOT_BOOT__=') < html.indexOf('<script>' + BOT_PAGE_JS),
    'payload first, then the inline page script that paints it')
  // 打开会话不再写「读取中…」占位（R10-B2）：那一段已经删掉了。
  assert.doesNotMatch(html, /\$\('bpMsgs'\)\.innerHTML = '<p class="bp-empty">读取中…/,
    'the transcript never starts as a placeholder that is replaced a moment later')
})

// ---------- 2026-10-31 复验：顶栏收口 / 列表底留白 / 闲置行绿勾 ----------

test('the right head group gives way before the bar clips it', () => {
  const html = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  const pocketHtml = renderMobilePage({ locale: 'zh', boot: null })
  // 真宿主五档复验（320/360/375/390/414）：390 收口后只有 375 溢出——可用 343，内容
  // 353.3，末字「接」被 .bp-bar 的 overflow:hidden 裁掉 8.4px。375 是 iPhone SE2/8/13 mini
  // 的逻辑宽，且用户要求授权信息显式，不能靠隐藏胶囊绕开。第二轮三处收口都只在本页作用域。
  assert.match(html, /\.bp-bar\{[^}]*gap:4px/,
    'the bar packs its three blocks tighter (8→4), which is the other half of the missing pixels')
  assert.match(html, /\.bp-bar \.bp-hint\{[^}]*padding:0;/,
    'the spacer stops paying 4px of padding it has no text for')
  assert.match(html, /\.bp-bar \.head-right\{flex:none;display:flex;align-items:center;gap:4px;pointer-events:auto\}/,
    'the right group packs tighter too')
  assert.match(html, /\.bp-bar \.head-expiry\{padding:2px 5px\}/,
    'and the capsule pays 4px of its own padding, scoped to the Bot bar only')
  // 共享规则不被裸改：Pocket 页那份 .head-expiry 仍是 app.css 的 padding:2px 7px。
  assert.match(pocketHtml, /\.head-expiry\{[^}]*padding:2px 7px/, 'Pocket keeps the shared capsule untouched')
  // 胶囊整颗退场只留 340 及以下；360 现在放得下，而要件②要求 ≥375 不许隐藏，360 跟着留。
  assert.match(html, /@media \(max-width:340px\)\{\.bp-bar #bpExpiry\{display:none\}\}/,
    'narrower than 340 drops the capsule instead of clipping the status text')
  assert.doesNotMatch(html, /@media \(max-width:360px\)\{\.bp-bar #bpExpiry\{display:none\}\}/,
    '360 must keep the capsule: 375 is a mainstream width and the authorisation has to stay visible')
  // 状态文字不许被压成省略号：共享 .status-text 是 flex:none，BOT 侧不覆盖它。
  assert.doesNotMatch(html, /\.bp-bar \.status-text\{/,
    'the status text keeps the shared flex:none, so it can never be the thing that shrinks')
})

test('the Bot list clears the corner button the way the Pocket home does', () => {
  const html = renderBotPage({ cssUrl: '/app.css?h=1', jsUrl: '/bot.js?h=2' })
  const pocketHtml = renderMobilePage({ locale: 'zh', boot: null })
  // 390×900 实测：FAB 52×52 顶边 830，滚到底末卡 bottom 881.5 ⇒ 压住 51.5px。
  // 数字取 Pocket 主页那 74px（判据要求 ≥70 且 74±4），不另造一个值让两页各留各的。
  const pad = Number((html.match(/#bpList\{padding-bottom:(\d+)px\}/) || [])[1])
  assert.ok(pad >= 70 && pad <= 78, 'the list reserves the Pocket 74px (70..78), got ' + pad)
  assert.match(pocketHtml, /\.workspaces\{[^}]*padding:2px 0 74px/, 'which is the same number the Pocket home uses')
  // 会话页那一支不动：它已经由 composer 让位（末条消息 bottom 805 < composer top 830）。
  assert.doesNotMatch(html, /#bpMsgs\{[^}]*padding-bottom:\s*74px/, 'the transcript keeps its own bottom')
  assert.match(html, /\.bp-scroll\{[^}]*padding-bottom:10px/, 'and the scroll box itself is untouched')
})

test('an idle row is marked is-done, so its status mark keeps the Pocket green', async () => {
  const pocketHtml = renderMobilePage({ locale: 'zh', boot: null })
  // 绿是共享源给的那条规则；BOT 侧只负责把类名挂对，不复制色值。
  assert.match(pocketHtml, /\.task-row\.is-done \.task-status\{color:#35a867\}/, 'the shared source paints the done mark green')
  const team = teamWith()
  team.bots.push({ id: 'scout', name: 'Scout', role: '观察员', sessionId: 's-scout' })
  const draw = async () => {
    const page = fakeBrowser({ answer: (method) => (method === 'bot.team' ? team : {}) })
    await page.settle()
    return page.node('bpMembersList').innerHTML
  }
  // ① 闲：既没在干活也没有待答 ⇒ is-done（改前这一行三个类全无，图标落回 --ink 的白）。
  const idle = await draw()
  assert.match(idle, /class="task-row is-done" data-open="bot" data-id="scout"/,
    'a member that is neither busy nor waiting is done, which is what turns its mark green')
  // ② 三态互斥：每个 Bot 行只落一个状态类，不能出现 is-running + is-done 并存。
  // 群聊行（data-open="room"）是另一类行，它的行首是「群」字 chip、没有状态图标，不在本条判据内。
  for (const cls of [...idle.matchAll(/<button class="(task-row[^"]*)" data-open="bot"/g)].map((m) => m[1])) {
    const hits = ['is-running', 'is-awaiting', 'is-done'].filter((s) => cls.split(' ').includes(s))
    assert.equal(hits.length, 1, 'exactly one state class per row, got: ' + cls)
  }
  // ③ 忙 / 等答这两态视觉不变：类名与改前逐字相同。
  team.bots[1].working = { tool: 'bash' }
  assert.match(await draw(), /class="task-row is-running" data-open="bot" data-id="scout"/, 'busy is still is-running alone')
  team.bots[1].working = false
  team.bots[1].waiting = true
  assert.match(await draw(), /class="task-row is-awaiting" data-open="bot" data-id="scout"/, 'waiting is still is-awaiting alone')
})
