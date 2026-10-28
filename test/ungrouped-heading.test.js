// The「未分组」heading (user 2026-10-28).
//
// The desktop groups its session list by workspace and paints every session that
// belongs to none of them under `t("group.ungrouped")` — the host's own copy says
// so twice: `ProjectRowItem` labels a group with no `workspaceId` that way, and
// `delete.desc` promises a removed workspace's sessions「将显示在“未分组”下」.
// The phone had no such heading: `bootVisibleRows` keeps unclaimed rows on purpose
// (「they are the ones the landing resolves to a synthetic placeholder row」) and no
// card ever claimed them, so 1,075 of the live document's 1,087 rows reached the
// phone and were dropped on the last step.
//
// Two halves, tested where each lives:
//   bridge — it must hand over WHICH of the unclaimed rows are unclaimed only
//            because their workspace is hidden here (`hiddenSessionIds`), since
//            those look identical to genuinely orphaned rows on the page;
//   page   — `ungroupedCards()` must claim exactly「the rest」: not a workspace's,
//            not hidden, not archived.
import test from 'node:test'
import assert from 'node:assert/strict'
import { LanMobileBridge } from '../lib/bridge.js'
import { mobilePageAssets } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })
const { js: jsEn } = mobilePageAssets({ locale: 'en' })

const DAY = 24 * 60 * 60 * 1000
const row = (sessionId, updatedAt) => ({ sessionId, updatedAt, blank: false })

function makeBridge({ items, workspaceItems, pinnedSessionIds = [], hiddenId = null }) {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = []
  bridge.log = () => {}
  bridge.locale = () => 'zh'
  bridge.now = () => Date.now()
  bridge.pendingQuestions = new Map()
  bridge.noteSavings = () => {}
  bridge.workspaceSnapshot = { items: workspaceItems, pinnedSessionIds }
  bridge.cachedSettings = async () => ({ ok: true, value: {} })
  bridge.cachedSessionList = async () => ({ ok: true, value: { items } })
  bridge.mobileAssetBodies = () => ({ urls: {} })
  bridge.refreshBotWorkspaceId = async () => hiddenId
  return bridge
}

const WORKSPACE = 'w1'
const HIDDEN = 'bot-ws'

// The live shape (measured 2026-10-28): a workspace item carries its own
// `sessionIds` (235/67/19/6 across the four visible ones), and NO session row
// carries a `workspaceId` (0 of 1,087). A fixture that gave rows a workspaceId
// would let a filter that only reads rows pass here and do nothing on the phone.
const twoWorkspaces = [
  { workspaceId: WORKSPACE, title: 'defws', path: 'F:\\defws', sessionIds: ['a', 'b'] },
  { workspaceId: HIDDEN, title: 'DS Bot', path: 'F:\\DSBOT', sessionIds: ['bot1', 'bot2'] },
]

test('the bridge hands over the hidden membership, so the page can tell hidden from orphaned', async () => {
  const now = Date.now()
  const items = [row('a', now - 1000), row('bot1', now - 1000), row('orphan', now - 1000)]
  const bridge = makeBridge({ items, workspaceItems: twoWorkspaces, hiddenId: HIDDEN })
  const boot = await bridge.buildMobileBoot()

  assert.deepEqual(
    boot.ws.hiddenSessionIds?.slice().sort(),
    ['bot1', 'bot2'],
    'both sessions of the hidden workspace travel as ids: the page cannot derive them (rows carry no workspaceId)',
  )
  assert.equal(
    boot.ws.items.some((item) => item.workspaceId === HIDDEN),
    false,
    'and the hidden workspace itself still does not',
  )
})

test('nothing hidden, no field: a bridge with no hidden workspace ships no empty list', async () => {
  const now = Date.now()
  const items = [row('a', now - 1000)]
  const bridge = makeBridge({ items, workspaceItems: [twoWorkspaces[0]], hiddenId: null })
  const boot = await bridge.buildMobileBoot()

  assert.equal('hiddenSessionIds' in boot.ws, false, 'an empty set adds nothing to a 1.7 MB document')
})

// Regression (audit P1-1, 2026-10-24): the hidden ids used to be collected from
// the session rows (`row.workspaceId === hiddenId`), and the host sends no
// workspaceId on any row — so the set was always empty and the hidden workspace's
// pins were never stripped. The membership lives in the workspace item.
test('the hidden membership comes from the workspace item, not from the rows', () => {
  const bridge = makeBridge({ items: [{ sessionId: 'bot1' }], workspaceItems: twoWorkspaces, hiddenId: HIDDEN })
  const hidden = bridge.botWorkspaceHiddenSessions.call(bridge, HIDDEN)
  return hidden.then((ids) => {
    assert.deepEqual([...ids].sort(), ['bot1', 'bot2'], 'the item is the only place the host records membership')
  })
})

test('a pin inside the hidden workspace is dropped with it', async () => {
  const now = Date.now()
  const items = [row('a', now - DAY), row('bot1', now - DAY)]
  const bridge = makeBridge({
    items,
    workspaceItems: twoWorkspaces,
    pinnedSessionIds: ['a', 'bot1'],
    hiddenId: HIDDEN,
  })
  const boot = await bridge.buildMobileBoot()

  assert.deepEqual(boot.ws.pinnedSessionIds, ['a'], 'the Bot team cannot ride back in on the pin list')
})

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

// The page's own function, run against the page's own state names: a fixture that
// re-implemented the difference here would stay green while the page did nothing.
function ungroupedCards({ workspaces, sessionSummaries, archivedSessionIds = [], hiddenWsSessionIds = [] }) {
  const body = extractFunction(js, 'ungroupedCards')
  const make = new Function(
    'workspaces',
    'sessionSummaries',
    'archivedSessionIds',
    'hiddenWsSessionIds',
    `${body};return ungroupedCards()`,
  )
  return make(workspaces, sessionSummaries, archivedSessionIds, hiddenWsSessionIds)
}

const summaries = (ids) => ids.map((sessionId) => ({ sessionId, updatedAt: 1, blank: false }))
const lastCard = (cards) => cards[cards.length - 1]
const hasUngrouped = (cards) => cards.some((card) => card.ungrouped === true)

test('an unclaimed session is painted under「未分组」, and the claimed ones stay where they are', () => {
  const cards = ungroupedCards({
    workspaces: [{ workspaceId: WORKSPACE, title: 'defws', sessionIds: ['a'] }],
    sessionSummaries: summaries(['a', 'orphan1', 'orphan2']),
  })

  assert.equal(hasUngrouped(cards), true, 'the heading the desktop has must exist here too')
  const bucket = lastCard(cards)
  assert.equal(bucket.ungrouped, true)
  assert.deepEqual(bucket.sessionIds, ['orphan1', 'orphan2'], 'exactly the rows no workspace claims')
  assert.deepEqual(cards[0].sessionIds, ['a'], 'and the workspace card is untouched')
  assert.equal(cards.length, 2, 'the bucket rides beside the workspaces, not inside one')
})

test('the bucket sorts last, the way the desktop paints the leftovers after the workspaces', () => {
  const cards = ungroupedCards({
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['a'] },
      { workspaceId: 'w2', sessionIds: ['b'] },
    ],
    sessionSummaries: summaries(['a', 'b', 'orphan']),
  })

  assert.deepEqual(
    cards.map((card) => card.ungrouped === true),
    [false, false, true],
  )
})

test('a hidden workspace\u2019s sessions do not leak in under the new heading', () => {
  const cards = ungroupedCards({
    workspaces: [{ workspaceId: WORKSPACE, sessionIds: ['a'] }],
    sessionSummaries: summaries(['a', 'bot1', 'orphan']),
    hiddenWsSessionIds: ['bot1', 'bot2'],
  })

  assert.deepEqual(
    lastCard(cards).sessionIds,
    ['orphan'],
    'the Bot team\u2019s sessions are HIDDEN, not ungrouped (user 2026-10-24)',
  )
})

test('archived sessions stay out of the bucket, as they stay out of a workspace card', () => {
  const cards = ungroupedCards({
    workspaces: [{ workspaceId: WORKSPACE, sessionIds: ['a'] }],
    sessionSummaries: summaries(['a', 'orphan', 'archived1']),
    archivedSessionIds: ['archived1'],
  })

  assert.deepEqual(lastCard(cards).sessionIds, ['orphan'])
})

test('every row accounted for: no bucket at all rather than an empty card', () => {
  const cards = ungroupedCards({
    workspaces: [{ workspaceId: WORKSPACE, sessionIds: ['a', 'b'] }],
    sessionSummaries: summaries(['a', 'b']),
  })

  assert.equal(hasUngrouped(cards), false, 'an empty heading would be furniture, not information')
})

test('a page with no workspaces at all still shows nothing invented', () => {
  const cards = ungroupedCards({ workspaces: [], sessionSummaries: summaries([]) })
  assert.deepEqual(cards, [], 'nothing to claim and nothing to claim it with')
  assert.equal(hasUngrouped(cards), false)
})

// The two strings a phone user actually reads. The dictionary is already
// serialised by the time it reaches the asset, so the label is pinned in its
// shipped form rather than in its source form.
test('the heading is the desktop\u2019s own wording in both locales', () => {
  const zh = mobilePageAssets({ locale: 'zh' }).js
  const en = mobilePageAssets({ locale: 'en' }).js
  assert.ok(zh.includes('"ungrouped":"未分组"'), 'zh: the host dictionary calls it 未分组 (group.ungrouped)')
  assert.ok(en.includes('"ungrouped":"Ungrouped"'), 'en: and Ungrouped (group.ungrouped, en dictionary)')
})

test('the bucket card carries no「+」: there is no workspace behind it to create in', () => {
  const marker = js.slice(js.indexOf("const wsKey=w.ungrouped"), js.indexOf("const wsKey=w.ungrouped") + 4000)
  assert.match(marker, /w\.ungrouped\?' is-ungrouped':'/, 'the card is marked, so a stylesheet can tell it apart')
  assert.match(marker, /w\.ungrouped\?'':'<button class="ws-new"/, 'and it offers no workspace-level action')
  assert.match(marker, /esc\(w\.ungrouped\?L\.ungrouped:/, 'the title is the bucket label, not a path')
})

test('the landing stores the hidden membership the bridge sends', () => {
  assert.match(
    js,
    /hiddenWsSessionIds=Array\.isArray\(ws\.hiddenSessionIds\)/,
    'applyBootData is the one door every list answer comes through (boot, loadListData, fillListFromServer)',
  )
})
