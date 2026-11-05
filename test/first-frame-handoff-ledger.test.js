// 首帧裁决卡的桥侧半场（AC-H1/H2/H3）：handoff 账本从「窗口内可反复发薄文档」收成
// 「每设备每趟只发一张」。本档只走真 createServer（真 cookie、真响应头），不碰渲染函数
// 造私货；页面渲染的三形状标记另用 renderMobilePage 直测，避免起桥只为看一个字符串。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, httpFetch } from './helpers.js'
import { renderMobilePage } from '../lib/pages.js'

const BOOT_MARKER = 'window.__POCKET_BOOT__='
const THIN_MAX_BYTES = 21000
const NOW = Date.now()
const ROWS = [
  { sessionId: 's-alpha', updatedAt: NOW - 60_000, projections: { values: { title: 'alpha 工作会话' } } },
  { sessionId: 's-beta', updatedAt: NOW - 120_000, projections: { values: { title: 'beta session' } } }
]

/** The one upstream answer the cold open needs: a session list. */
function respond(pathname) {
  if (pathname === '/api/session/list') return { ok: true, value: { items: ROWS } }
  return undefined
}

/** The fake Harness cannot follow-stream workspaces; stand the snapshot up by hand. */
function seedWorkspaces(bridge) {
  bridge.workspaceSnapshot = {
    items: [{ workspaceId: 'ws-mine', name: 'Mine', paths: [], sessionIds: ROWS.map((row) => row.sessionId) }],
    pinnedSessionIds: []
  }
}

const bytes = (text) => Buffer.byteLength(text)
const hasPayload = (html) => html.includes(BOOT_MARKER)
/** The document's shape marker, or null when it carries none. */
function shapeOf(html) {
  const match = html.match(/window\.__POCKET_BOOT_STATE__="?([a-z]+)"?/)
  return match ? match[1] : null
}

const boot = JSON.stringify({ ws: { items: [] }, sess: { items: [] } })

test('AC-H1 one /api/boot then two documents: the first is thin, the second embeds', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: { respond } })
  try {
    seedWorkspaces(t.bridge)
    const cookie = await t.pairMobile()

    const bootRes = await httpFetch(`${t.base}/api/boot`, { headers: { cookie } })
    assert.equal(bootRes.status, 200, 'the device buys its payload first')

    const first = await httpFetch(`${t.base}/`, { headers: { cookie } })
    const firstHtml = await first.text()
    assert.equal(hasPayload(firstHtml), false, 'the note is issued: this document carries no payload')
    assert.equal(shapeOf(firstHtml), 'handoff', 'and it says so in __POCKET_BOOT_STATE__')
    assert.ok(bytes(firstHtml) < THIN_MAX_BYTES, `the thin document must stay under ${THIN_MAX_BYTES} B, saw ${bytes(firstHtml)}`)
    assert.equal(first.headers.get('x-pocket-cache'), null, 'a payload-less document is never marked for the shell cache')

    const second = await httpFetch(`${t.base}/`, { headers: { cookie } })
    const secondHtml = await second.text()
    assert.equal(hasPayload(secondHtml), true, 'one note per device: the second document embeds again')
    assert.equal(shapeOf(secondHtml), 'embedded')
    assert.equal(second.headers.get('x-pocket-cache'), 'app', 'the embedded document is the one the worker may cache')
  } finally {
    await t.stop()
  }
})

test('AC-H2 a /api/boot after the handoff document cannot re-arm a second one', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: { respond } })
  try {
    seedWorkspaces(t.bridge)
    const cookie = await t.pairMobile()
    await httpFetch(`${t.base}/api/boot`, { headers: { cookie } })
    await httpFetch(`${t.base}/`, { headers: { cookie } })

    const ledger = [...t.bridge.handoffBootStash.values()]
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0].issued, true, 'the served handoff is remembered inside the same window')

    // The thin document's own /api/boot fallback (N2) writes a new `at` but must keep `issued`.
    await httpFetch(`${t.base}/api/boot`, { headers: { cookie } })
    const next = await httpFetch(`${t.base}/`, { headers: { cookie } })
    const html = await next.text()
    assert.equal(hasPayload(html), true, 'a second /api/boot inside the window still lands on embedded')
    assert.equal(shapeOf(html), 'embedded')
    assert.equal([...t.bridge.handoffBootStash.values()][0].issued, true)
  } finally {
    await t.stop()
  }
})

test('AC-H2b the window still closes: a stale note lets the next trip hand off again', async () => {
  const t = await startBridge({ harness: 'fake', harnessOptions: { respond } })
  try {
    seedWorkspaces(t.bridge)
    const cookie = await t.pairMobile()
    await httpFetch(`${t.base}/api/boot`, { headers: { cookie } })
    await httpFetch(`${t.base}/`, { headers: { cookie } })
    // Age the ledger past HANDOFF_BOOT_STASH_MS (120 s) instead of waiting it out.
    for (const entry of t.bridge.handoffBootStash.values()) entry.at = 0

    await httpFetch(`${t.base}/api/boot`, { headers: { cookie } })
    const res = await httpFetch(`${t.base}/`, { headers: { cookie } })
    const html = await res.text()
    assert.equal(hasPayload(html), false, 'the expired note is pruned on the next write')
    assert.equal(shapeOf(html), 'handoff')
  } finally {
    await t.stop()
  }
})

test('AC-H3 each document shape carries its own __POCKET_BOOT_STATE__', async () => {
  const make = (bootState, bootPayload) => renderMobilePage({
    locale: 'zh', boot: bootPayload, icon: null, initialChat: false, bootState
  })
  assert.equal(shapeOf(make('handoff', null)), 'handoff')
  assert.equal(shapeOf(make('shell', boot)), 'shell')
  assert.equal(shapeOf(make('embedded', boot)), 'embedded')
  assert.equal(shapeOf(make(null, boot)), null, 'no marker when the bridge has no shape to report')

  // The real bridge reports `shell` for a service-worker revalidation: a payload-less
  // document the worker is allowed to cache, so it must not look like a cold start.
  const t = await startBridge({ harness: 'fake', harnessOptions: { respond } })
  try {
    seedWorkspaces(t.bridge)
    const cookie = await t.pairMobile()
    const res = await httpFetch(`${t.base}/?revalidate=1`, { headers: { cookie } })
    const html = await res.text()
    assert.equal(hasPayload(html), false)
    assert.equal(shapeOf(html), 'shell')
  } finally {
    await t.stop()
  }
})
