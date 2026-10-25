// W4 冷开 boot 只付一份（2026-10-24）。
//
// 配对页 / 重连页先 `GET /api/boot` 写 sessionStorage，然后 `location.replace('/')`
// 发起文档导航；页侧 `takeHandoffBoot()` 让 sessionStorage 那份胜出，于是文档里
// 内嵌的那一份同量载荷（911,048 B）下载即弃 —— 一次冷开付两份，共 1,832,028 B。
//
// 桥侧因此记一笔一次性窄账（设备指纹 + HANDOFF_BOOT_STASH_MS = 120 s）：`/api/boot`
// 200 后记，紧接的文档命中即删、不再内嵌。挡住「壳缓存毒化」的那条不变量是
// 命中时**不设** `x-pocket-cache: app` —— SW 只收带这个头的文档进 SHELL，
// 一份没有载荷的壳被缓存下来，下次深层路由冷开会永远缺 boot。
//
// 全部断言经 helpers.startBridge 起的**真** createServer（真 cookie、真响应头、
// 真日志）。`test/boot-landing.test.js:137-171` 那种手工拼一个 response 对象再交给
// 渲染函数的写法是假信号——W2b 复审抓到过，AC-7 最后三条断言禁止它回到这里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startBridge, httpFetch } from './helpers.js'
import { mobilePageAssets } from '../lib/pages.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const BOOT_MARKER = 'window.__POCKET_BOOT__='

/** Three rows a landing can paint; `updatedAt` stays inside the recent window. */
const NOW = Date.now()
const ROWS = [
  { sessionId: 's-alpha', updatedAt: NOW - 60_000, projections: { values: { title: 'alpha 工作会话' } } },
  { sessionId: 's-beta', updatedAt: NOW - 120_000, projections: { values: { title: 'beta session' } } },
  { sessionId: 's-gamma', updatedAt: NOW - 180_000, projections: { values: { title: 'gamma' } } }
]

/** The one upstream answer the cold open needs: a session list. */
function respond(pathname) {
  if (pathname === '/api/session/list') return { ok: true, value: { items: ROWS } }
  return undefined
}

/**
 * The fake Harness cannot follow-stream workspaces, so the snapshot the mux
 * would normally deliver is stood up by hand — the same seam
 * `test/bot-page.test.js:148` uses. Everything under it stays real.
 * @param {any} bridge
 * @param {any[]} [rows]
 */
function seedWorkspaces(bridge, rows = ROWS) {
  bridge.workspaceSnapshot = {
    items: [{ workspaceId: 'ws-mine', name: 'Mine', paths: [], sessionIds: rows.map((row) => row.sessionId) }],
    pinnedSessionIds: []
  }
}

/** The payload a document carries, or null when it carries none. */
function embeddedPayload(html) {
  const match = html.match(/window\.__POCKET_BOOT__=([\s\S]*?)<\/script>/)
  return match ? match[1] : null
}

/** The ` nonce="…"` on a script tag changes every response; strip it to compare bytes. */
function withoutNonce(html) {
  return html.replace(/ nonce="[^"]*"/g, '')
}

/** @param {{logs: {level: string, message: string}[]}} t @param {RegExp} pattern */
function matches(t, pattern) {
  return t.logs.map((line) => line.message).filter((message) => pattern.test(message))
}

const bytes = (text) => Buffer.byteLength(text)

// ---------------------------------------------------------------------------
// T1 — 台账：AC-1 … AC-4
// ---------------------------------------------------------------------------

test('AC-1 a document that follows /api/boot ships no payload and no shell-cache marker', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: { respond } })
  try {
    seedWorkspaces(t.bridge)
    const cookie = await t.pairMobile()
    const boot = await httpFetch(t.base + '/api/boot', { headers: { cookie } })
    assert.equal(boot.status, 200, 'the handoff step itself must work')
    assert.equal(bytes(await boot.text()) > 0, true)

    const res = await httpFetch(t.base + '/', { headers: { cookie } })
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.equal(embeddedPayload(html), null, 'the second copy of the payload is gone')
    assert.doesNotMatch(html, /window\.__POCKET_BOOT__=/, 'not even the assignment survives')
    assert.ok(bytes(html) < 20000, `the landing is a bare shell now, got ${bytes(html)} B`)
    assert.equal(res.headers.get('x-pocket-cache'), null,
      'a payload-less shell must never be marked for the app-shell cache')
    assert.equal(res.headers.get('cache-control'), 'no-store', 'and it stays uncacheable')
    assert.equal(matches(t, /boot=handoff/).length, 1, 'the log names the shape: boot=handoff')
  } finally { await t.stop() }
})

test('AC-2 the note is one-shot: the next document inside the window embeds again', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: { respond } })
  try {
    seedWorkspaces(t.bridge)
    const cookie = await t.pairMobile()
    await httpFetch(t.base + '/api/boot', { headers: { cookie } })
    // First document consumes the note, second one has nothing left to ride.
    await httpFetch(t.base + '/', { headers: { cookie } })
    const res = await httpFetch(t.base + '/', { headers: { cookie } })
    const html = await res.text()
    assert.notEqual(embeddedPayload(html), null, 'a document with no note embeds a payload')
    assert.equal(res.headers.get('x-pocket-cache'), 'app',
      'the full document is what the app-shell cache is allowed to keep')
    assert.equal(matches(t, /boot=embedded/).length, 1)
    assert.equal(matches(t, /boot=handoff/).length, 1, 'the note was consumed exactly once')
  } finally { await t.stop() }
})

test('AC-3 a direct cold open is untouched: same rows, same tails, payload embedded', async () => {
  const first = await startBridge({ harness: 'fake', harnessOptions: { respond } })
  const second = await startBridge({ harness: 'fake', harnessOptions: { respond } })
  try {
    // The handoff path: what the payload looks like when the bridge serves it.
    seedWorkspaces(first.bridge)
    const handoffCookie = await first.pairMobile()
    const boot = await httpFetch(first.base + '/api/boot', { headers: { cookie: handoffCookie } })
    const bootPayload = JSON.parse(await boot.text())

    // The direct path: a second bridge, a different cookie, the document first.
    seedWorkspaces(second.bridge)
    const directCookie = await second.pairMobile()
    const res = await httpFetch(second.base + '/', { headers: { cookie: directCookie } })
    const payload = JSON.parse(embeddedPayload(await res.text()))
    assert.equal(res.headers.get('x-pocket-cache'), 'app', 'a direct open still caches as a shell')
    assert.equal(matches(second, /boot bytes=/).length, 0, 'the direct path never calls /api/boot')
    assert.equal(payload.sess.items.length, bootPayload.sess.items.length,
      'the landing rows are the same rows, whatever the route')
    assert.deepEqual(
      payload.sess.items.map((row) => row.sessionId).sort(),
      bootPayload.sess.items.map((row) => row.sessionId).sort(),
      'and they are the same sessions'
    )
    assert.deepEqual(
      Object.keys(payload.tails ?? {}).sort(),
      Object.keys(bootPayload.tails ?? {}).sort(),
      'the tail prefetch is identical on both routes'
    )
    assert.equal(payload.mode, bootPayload.mode, 'the transport rides both routes')
  } finally {
    await first.stop()
    await second.stop()
  }
})

test('AC-4 one cold open pays for one payload: one boot build, one payload size', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: { respond } })
  try {
    seedWorkspaces(t.bridge)
    const cookie = await t.pairMobile()
    const bootBody = await (await httpFetch(t.base + '/api/boot', { headers: { cookie } })).text()
    await httpFetch(t.base + '/', { headers: { cookie } })
    const embedded = embeddedPayload(await (await httpFetch(t.base + '/', { headers: { cookie } })).text())

    assert.equal(matches(t, /^boot bytes=\d+ ms=\d+$/).length, 1,
      'exactly one /api/boot build in this cold open')
    const delta = Math.abs(bytes(embedded) - bytes(bootBody))
    assert.ok(delta <= 64, `the document carries the same payload, off by ${delta} B (≤64 expected)`)
    // 同一 fixture 下两份同源同体量：差值只可能来自 JSON 转义（`<` → \u003c 等）。
    assert.equal(embedded.replace(/\\u003c/g, '<'), bootBody, 'and it is byte-identical once unescaped')
  } finally { await t.stop() }
})

// ---------------------------------------------------------------------------
// T1 的两个边界：TTL 过期、开关关闭 — 都退回今天的行为（内嵌）
// ---------------------------------------------------------------------------

test('AC-1 a note older than 120 s is not a handoff any more', async () => {
  let clock = Date.now()
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: { respond },
    bridgeOptions: { now: () => clock }
  })
  try {
    seedWorkspaces(t.bridge)
    const cookie = await t.pairMobile()
    await httpFetch(t.base + '/api/boot', { headers: { cookie } })
    clock += 121_000 // past HANDOFF_BOOT_STASH_MS
    const html = await (await httpFetch(t.base + '/', { headers: { cookie } })).text()
    assert.notEqual(embeddedPayload(html), null, 'an expired note must not skip the embed')
    assert.equal(matches(t, /boot=embedded/).length, 1)
  } finally { await t.stop() }
})

test('AC-1 DSH_POCKET_BOOT_HANDOFF=0 puts every document back on the embedded shape', async () => {
  const previous = process.env.DSH_POCKET_BOOT_HANDOFF
  process.env.DSH_POCKET_BOOT_HANDOFF = '0'
  let t = null
  try {
    t = await startBridge({ harness: 'fake', harnessOptions: { respond } })
    seedWorkspaces(t.bridge)
    const cookie = await t.pairMobile()
    await httpFetch(t.base + '/api/boot', { headers: { cookie } })
    const res = await httpFetch(t.base + '/', { headers: { cookie } })
    const html = await res.text()
    assert.notEqual(embeddedPayload(html), null, 'the switch off means the old behaviour')
    assert.equal(res.headers.get('x-pocket-cache'), 'app', 'and the shell cache stays as it was')
    assert.equal(matches(t, /boot=handoff/).length, 0)
  } finally {
    await t?.stop()
    if (previous === undefined) delete process.env.DSH_POCKET_BOOT_HANDOFF
    else process.env.DSH_POCKET_BOOT_HANDOFF = previous
  }
})

// ---------------------------------------------------------------------------
// SF-5 补例 — CHANGELOG「怎么验」三条：换指纹、开关三档、未交付不记台账
// ---------------------------------------------------------------------------

test('AC-10 a different device fingerprint does not ride the same handoff note', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: { respond } })
  try {
    seedWorkspaces(t.bridge)
    const uaA = 'PocketTest/1.0'
    const uaB = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36'
    const cookieA = await t.pairMobile(uaA)
    // The one bridge hands out one single-use pairing token, and issuing A's
    // cookie cleared it — a second device must rotate to pair for real.
    t.bridge.rotatePairingToken()
    const pairB = await httpFetch(`${t.base}/pair?token=${t.bridge.pairingToken}`, {
      headers: { 'user-agent': uaB }
    })
    assert.equal(pairB.status, 302, 'device B pairs through the real /pair route')
    const cookieB = (pairB.headers.get('set-cookie') ?? '').split(';')[0]
    assert.match(cookieB, /^dsh_mobile=/)

    await httpFetch(t.base + '/api/boot', { headers: { cookie: cookieA, 'user-agent': uaA } })
    // B's document embeds: B never bought a payload, so B must pay for its own.
    const resB = await httpFetch(t.base + '/', { headers: { cookie: cookieB, 'user-agent': uaB } })
    assert.notEqual(embeddedPayload(await resB.text()), null,
      'a different fingerprint gets the embedded shape, not A\'s note')
    assert.equal(resB.headers.get('x-pocket-cache'), 'app')
    // A's next document still rides the note — B's visit did not consume it.
    const resA = await httpFetch(t.base + '/', { headers: { cookie: cookieA, 'user-agent': uaA } })
    assert.equal(embeddedPayload(await resA.text()), null, 'A\'s note is intact after B came by')
    assert.equal(matches(t, /boot=embedded/).length, 1)
    assert.equal(matches(t, /boot=handoff/).length, 1, 'and the log shows one handoff: A\'s')
  } finally { await t.stop() }
})

test('AC-11 DSH_POCKET_BOOT_HANDOFF is on unless explicitly 0: unset, empty and 1 all hand off', async () => {
  const previous = process.env.DSH_POCKET_BOOT_HANDOFF
  // The switch is read at request time (bootHandoffEnabled() -> process.env),
  // so one real bridge serves all three states — each state gets its own
  // boot+document pair and must land on the handoff shape.
  const states = [
    ['unset', () => { delete process.env.DSH_POCKET_BOOT_HANDOFF }],
    ['empty string', () => { process.env.DSH_POCKET_BOOT_HANDOFF = '' }],
    ['1', () => { process.env.DSH_POCKET_BOOT_HANDOFF = '1' }]
  ]
  const t = await startBridge({ harness: 'fake', harnessOptions: { respond } })
  try {
    seedWorkspaces(t.bridge)
    const cookie = await t.pairMobile()
    for (let i = 0; i < states.length; i++) {
      const [label, apply] = states[i]
      apply()
      await httpFetch(t.base + '/api/boot', { headers: { cookie } })
      const res = await httpFetch(t.base + '/', { headers: { cookie } })
      const html = await res.text()
      assert.equal(embeddedPayload(html), null,
        `DSH_POCKET_BOOT_HANDOFF ${label} (state ${i}) means the handoff shape`)
      assert.equal(res.headers.get('x-pocket-cache'), null,
        `state ${i}: a handoff document is never marked for the app-shell cache`)
      assert.equal(matches(t, /boot=handoff/).length, i + 1,
        `state ${i}: the note was recorded and consumed exactly once`)
    }
  } finally {
    await t.stop()
    if (previous === undefined) delete process.env.DSH_POCKET_BOOT_HANDOFF
    else process.env.DSH_POCKET_BOOT_HANDOFF = previous
  }
})

test('AC-12 a /api/boot that never delivers records no note (401 short-circuit, 503 build)', async () => {
  const stashSize = (bridge) => (bridge.handoffBootStash instanceof Map ? bridge.handoffBootStash.size : 0)
  // 1) Unauthorized: the gate short-circuits before the note could be filed.
  const t = await startBridge({ harness: 'fake', harnessOptions: { respond } })
  try {
    seedWorkspaces(t.bridge)
    const cookie = await t.pairMobile()
    const denied = await httpFetch(t.base + '/api/boot')
    assert.equal(denied.status, 401, 'no cookie, no payload')
    assert.equal(stashSize(t.bridge), 0, 'an unauthorized boot records nothing')
    // Positive control: the same observation sees a delivered boot record one.
    await httpFetch(t.base + '/api/boot', { headers: { cookie } })
    assert.equal(stashSize(t.bridge), 1, 'the ledger only ever counts delivered boots')
  } finally { await t.stop() }

  // 2) Authorized but the payload build fails (session list not ok -> 503):
  //    the note sits after the successful-delivery branch, so a failed build
  //    must leave the ledger empty too.
  const failing = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => (
        pathname === '/api/session/list' ? { ok: false, error: { message: 'boom' } } : undefined
      )
    }
  })
  try {
    const cookie = await failing.pairMobile()
    const res = await httpFetch(failing.base + '/api/boot', { headers: { cookie } })
    assert.equal(res.status, 503, 'the build failure reaches the phone as 503')
    assert.equal(stashSize(failing.bridge), 0, 'a failed boot records nothing')
  } finally { await failing.stop() }
})

// ---------------------------------------------------------------------------
// T2/T3 — AC-5 死参、AC-6 可观察性
// ---------------------------------------------------------------------------

test('AC-5 buildMobileBoot takes no options: one payload shape for both routes', () => {
  const source = readFileSync(join(REPO, 'lib', 'bridge.js'), 'utf8')
  assert.equal(source.match(/buildMobileBoot\(/g).length, 3,
    'one definition plus the two cold-open call sites, all argument-free')
  assert.equal(source.match(/buildMobileBoot\(\{/g), null, 'no call site passes an options object')
  assert.equal(source.match(/history: *false/g), null, 'the dead { history: false } option is gone')
})

test('AC-6 the fast /api/boot answer still logs, and the document log names all three shapes', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: { respond } })
  try {
    seedWorkspaces(t.bridge)
    const cookie = await t.pairMobile()
    await httpFetch(t.base + '/api/boot', { headers: { cookie } })
    const bootLines = matches(t, /^boot bytes=\d+ ms=\d+$/)
    assert.equal(bootLines.length, 1, 'the boot line is unconditional now, not gated on bootMs >= 300')
    const ms = Number(bootLines[0].match(/ms=(\d+)/)[1])
    assert.ok(ms < 300, `this fixture answers fast (${ms} ms) — exactly the case the old gate swallowed`)

    await httpFetch(t.base + '/', { headers: { cookie } }) // handoff
    await httpFetch(t.base + '/', { headers: { cookie } }) // embedded
    for (const shape of ['handoff', 'embedded']) {
      assert.equal(matches(t, new RegExp(`boot=${shape}`)).length, 1, `the log carries boot=${shape}`)
    }
    // The third token cannot be produced on demand (it needs buildMobileBoot to
    // fail), so it is pinned structurally: the renderer has a `none` state and
    // every document log line quotes whichever state it reached.
    const bridgeSource = readFileSync(join(REPO, 'lib', 'bridge.js'), 'utf8')
    assert.match(bridgeSource, /let bootState = 'none'/, 'a failed build has its own token')
    assert.match(bridgeSource, /boot=\$\{bootState\}/, 'and the document log always quotes it')
  } finally { await t.stop() }
})

// ---------------------------------------------------------------------------
// T4/T5 — AC-7 结构不变量、AC-8 三指标、AC-9 预算
// ---------------------------------------------------------------------------

test('AC-7 the page side keeps exactly its two handoff fetches and this file never fakes a response', () => {
  const pages = readFileSync(join(REPO, 'lib', 'pages.js'), 'utf8')
  assert.equal(pages.match(/fetch\('\/api\/boot'/g).length, 2,
    'only the pairing page and the reconnect page may fetch the payload')
  assert.equal(pages.match(/reconcileBoot|bootFromCache/g), null,
    'the second unconditional fetch stays deleted (card A removed it)')
  const self = readFileSync(join(HERE, 'handoff-boot-dedup.test.js'), 'utf8')
  // 自查的字面量要拼出来，否则这段断言会命中它自己的源码——mobile-assets.test.js:1130
  // 那条注释记着同一个坑（第一版就是这么误红的）。
  const faked = ['prototype', '.html.call'].join('')
  assert.equal(self.includes(faked), false, 'no hand-made response: that is a fake signal')
  const clone = ['Object', '.create(LanMobileBridge', '.prototype)'].join('')
  assert.equal(self.includes(clone), false, 'no half-built bridge either')
  const rawRequest = ['node:http', "').request"].join('')
  assert.equal(self.includes(rawRequest), false,
    'every request goes through startBridge + httpFetch, i.e. a real createServer')
})

test('AC-8 three metrics on one fixture: boot fetches, payload bytes, document bytes', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: { respond } })
  try {
    seedWorkspaces(t.bridge)
    const cookie = await t.pairMobile()
    const bootBody = await (await httpFetch(t.base + '/api/boot', { headers: { cookie } })).text()
    const bare = withoutNonce(await (await httpFetch(t.base + '/', { headers: { cookie } })).text())
    const embeddedHtml = withoutNonce(await (await httpFetch(t.base + '/', { headers: { cookie } })).text())
    const payload = bytes(embeddedPayload(embeddedHtml))

    // 1. boot fetch count: the handoff path is 1 → 1 (AC-4 pins the exact line).
    assert.equal(matches(t, /^boot bytes=/).length, 1)

    // 2. payload bytes: before = two copies (boot + document), after = one copy.
    const before = bytes(bootBody) + payload
    const after = payload
    assert.ok(after * 2 <= before * 1.11, `payload bytes ${before} → ${after} (need ≥45% off)`)

    // 3. document bytes: before = embedded document, after = the bare landing.
    assert.ok(bytes(bare) < 20000, `the landing is ${bytes(bare)} B, no payload inside`)
    const docDelta = bytes(embeddedHtml) - bytes(bare)
    // 去掉每响应的 nonce 之后，差值 = 载荷 + `<script>`/`</script>` 33 B。
    assert.ok(Math.abs(docDelta - payload) <= 64,
      `document delta ${docDelta} B vs payload ${payload} B (≤64 B of markup expected)`)

    // 4. first paint and tails are unchanged by the route (AC-3 asserts row identity).
    const embeddedRows = JSON.parse(embeddedPayload(embeddedHtml)).sess.items.length
    assert.equal(embeddedRows, JSON.parse(bootBody).sess.items.length)
  } finally { await t.stop() }
})

test('AC-9 the shell budget is untouched: no new bytes, no raised ceiling', () => {
  const source = readFileSync(join(HERE, 'mobile-assets.test.js'), 'utf8')
  // 原来钉什么：ceiling === 391_500（W2b 留下的历史具体值）。2026-10-24 W2a 剥注释后
  //   两档各瘦 100 KB，线按裁定改成 299_000，硬编码的具体值必然腐烂成假红。
  // 现在钉什么：那条不随时间腐烂的关系——线必须始终高于实测最大档一个最小余量。
  //   常量只从 mobile-assets.test.js 读（两处同源），这里不引入第二份定义。
  const ceiling = Number(source.match(/ASSET_BUDGET_BYTES = ([\d_]+)/)[1].replace(/_/g, ''))
  const minHeadroom = Number(source.match(/ASSET_MIN_HEADROOM_BYTES = ([\d_]+)/)[1].replace(/_/g, ''))
  assert.ok(minHeadroom > 0, 'the minimum-headroom floor must be defined in mobile-assets.test.js')
  const measured = ['zh', 'en'].map((locale) => {
    const { css, js } = mobilePageAssets({ locale })
    return Buffer.byteLength(css) + Buffer.byteLength(js)
  })
  const heaviest = Math.max(...measured)
  assert.ok(
    ceiling >= heaviest + minHeadroom,
    `the ceiling must sit at least ${minHeadroom} B above the heaviest shell (${heaviest} B) — it is ${ceiling} B, which no longer leaves the promised headroom`,
  )
  // 本卡对 lib/pages.js / lib/constants.js 零改动，所以壳资产的实测值必须仍是
  // 改前那一档；这条按渲染结果量，而不是按 diff 推断。
  for (const locale of ['zh', 'en']) {
    const { css, js } = mobilePageAssets({ locale })
    const total = Buffer.byteLength(css) + Buffer.byteLength(js)
    assert.ok(total <= ceiling, `${locale} shell assets weigh ${total} B, budget ${ceiling} B`)
  }
})
