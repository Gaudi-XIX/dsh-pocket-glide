// What the cold-open document carries (2026-10-17).
//
// History: the landing once shipped a 12-row page and refilled behind it, which
// made the list jump; then it shipped the WHOLE catalogue in one paint, which
// made the document grow with the workspace's entire history. It now ships the
// rows the page actually paints on its own — pinned plus everything inside 24h —
// and carries the rest alongside in `partial` for「更多」to page through.
//
// The two halves of that contract are pinned here:
//   1. the document is small: rows outside the window do not ride in `items`;
//   2. nothing is lost: every row is still in `partial`, so「更多」needs no RPC;
//   3. the fingerprint still covers the full catalogue, or the landing's
//      no-repaint check would stop noticing a change to a row it is hiding.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LanMobileBridge } from '../lib/bridge.js'

const bridgeSource = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
// The contract is the 24h window, so speak it in days here instead of reading
// the bridge's own constant: a fixture that recomputes its expectations from the
// value under test stays green through any change to that value.
const DAY = 24 * 60 * 60 * 1000

const row = (sessionId, updatedAt) => ({ sessionId, updatedAt, blank: false })

function makeBridge({ items, pinnedSessionIds = [], workspaceIds = null } = {}) {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = []
  bridge.log = () => {}
  bridge.locale = () => 'zh'
  bridge.now = () => Date.now()
  bridge.pendingQuestions = new Map()
  bridge.noteSavings = () => {}
  const ids = workspaceIds ?? items.map((item) => item.sessionId)
  bridge.workspaceSnapshot = {
    items: [{ workspaceId: 'w1', title: 'DSH', path: 'F:/x', sessionIds: ids }],
    pinnedSessionIds,
  }
  bridge.cachedSettings = async () => ({ ok: true, value: {} })
  bridge.cachedSessionList = async () => ({ ok: true, value: { items } })
  bridge.mobileAssetBodies = () => ({ urls: {} })
  return bridge
}

const idsOf = (rows) => rows.map((r) => r.sessionId)

test('the document ships only the rows the landing paints: pinned plus the 24h window', async () => {
  const now = Date.now()
  const items = [
    row('fresh1', now - 1000),
    row('fresh2', now - 2000),
    row('stale', now - 5 * DAY),
    row('old1', now - 2 * DAY),
    row('old2', now - 3 * DAY),
    row('pinnedOld', now - 9 * DAY),
  ]
  const bridge = makeBridge({ items, pinnedSessionIds: ['pinnedOld'] })
  const boot = await bridge.buildMobileBoot()

  // `stale` sits in the gap a widened window would swallow: it proves the
  // boundary is the 24h one and not "everything the host sent".
  assert.deepEqual(
    idsOf(boot.sess.items).sort(),
    ['fresh1', 'fresh2', 'pinnedOld'],
    'a pinned row travels no matter how old it is; the rest of the window travels with it; nothing older does',
  )
})

test('nothing is lost: the full catalogue still rides in `partial`, so「更多」needs no round trip', async () => {
  const now = Date.now()
  const items = [row('fresh', now - 1000), row('old1', now - 2 * DAY), row('old2', now - 3 * DAY)]
  const bridge = makeBridge({ items })
  const boot = await bridge.buildMobileBoot()

  assert.equal(boot.sess.partial, true, 'the page is told the catalogue is complete behind the document')
  assert.equal(boot.sess.items.length < items.length, true, 'and the document itself is the trimmed set')
})

test('the list fingerprint covers every row, including the ones the document hides', () => {
  // If the fingerprint only hashed the shipped rows, a change to a hidden row
  // would leave the landing thinking nothing moved — and the revealed list would
  // keep painting stale titles and clocks until some visible row happened to move.
  assert.match(
    bridgeSource,
    /const fingerprint = listFingerprint\(rows\)/,
    'the fingerprint is taken over the whole catalogue before any trimming',
  )
  const buildBody = bridgeSource.slice(
    bridgeSource.indexOf('async buildMobileBoot('),
    bridgeSource.indexOf('this.mobileAssetBodies(this.locale()).urls'),
  )
  assert.ok(
    !buildBody.includes('listFingerprint'),
    'and the boot path never re-fingerprints the trimmed set',
  )
})

test('a workspace snapshot with no membership keeps every row rather than blanking a card', async () => {
  const now = Date.now()
  const items = [row('a', now - 3 * DAY), row('b', now - 4 * DAY)]
  const bridge = makeBridge({ items, workspaceIds: [] })
  const boot = await bridge.buildMobileBoot()
  assert.deepEqual(idsOf(boot.sess.items).sort(), ['a', 'b'], 'unclaimed rows are kept: the card must not go blank')
})

test('the all-old workspace still ships its newest row (the page floors at one)', async () => {
  const now = Date.now()
  const items = [row('newer', now - 2 * DAY), row('older', now - 3 * DAY)]
  const bridge = makeBridge({ items })
  const boot = await bridge.buildMobileBoot()
  assert.deepEqual(idsOf(boot.sess.items), ['newer'], 'same floor as the renderer: one row is always visible')
})

// Regression (2026-10-17, caught on the restart verification of the trim).
//
// The page orders a workspace's rows `pinRank(b)-pinRank(a) || sortAtOf(b)-sortAtOf(a)`
// and then applies its cap, so the cap always lands on pinned rows plus the newest
// visible ones. The bridge reproduced the count but sorted on "pinned" alone, so
// with one fresh and one stale unpinned row the cap of 1 took whichever the
// catalogue happened to list first — it shipped the STALE row and hid the fresh
// one, and the landing painted an old title with「更多」behind it.
test('a workspace with one fresh and one stale row ships the FRESH one, not whichever came first', async () => {
  const now = Date.now()
  // Catalogue order is deliberately adversarial: stale first.
  const items = [row('stale', now - 5 * DAY), row('fresh', now - 60 * 1000)]
  const bridge = makeBridge({ items })
  const boot = await bridge.buildMobileBoot()
  assert.deepEqual(idsOf(boot.sess.items), ['fresh'], 'the tie-break is recency, as in the renderer')

  // And the answer cannot depend on how the host happened to order the catalogue.
  const flipped = makeBridge({ items: [row('fresh', now - 60 * 1000), row('stale', now - 5 * DAY)] })
  const bootFlipped = await flipped.buildMobileBoot()
  assert.deepEqual(idsOf(bootFlipped.sess.items), ['fresh'], 'same answer whichever way the catalogue is ordered')
})

test('pinned still outranks recency inside the same workspace', async () => {
  const now = Date.now()
  // Two unpinned rows inside the window plus an old pin: cap is 3, so all travel,
  // but the ORDER the cap counts through must put the pin first.
  const items = [row('fresh', now - 1000), row('pinnedOld', now - 30 * DAY)]
  const bridge = makeBridge({ items, pinnedSessionIds: ['pinnedOld'] })
  const boot = await bridge.buildMobileBoot()
  assert.ok(idsOf(boot.sess.items).includes('pinnedOld'), 'an old pin is never squeezed out by a fresh row')
  assert.ok(idsOf(boot.sess.items).includes('fresh'), 'and the fresh row rides with it')
})
