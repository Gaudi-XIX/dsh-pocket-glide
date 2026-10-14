// Unread-dot mathematics, pinned directly.
//
// The landing never opens a conversation by itself any more (user 2026-10-12:
// 「默认点链接就进主页面」), so the retired pieces this file used to pin — the
// attention census (landingAttention), the 2/3 crowding boundary and the
// focus picker (pickFocusItem) — are gone with the jump they served. What still
// runs, and what this file now pins, is `isRowUnread`: the predicate behind the
// workspace list's unread dot and the WS badges (via wsFlagOf), fed by the
// synced ledger each phone uploads (0.4.33).
import test from 'node:test'
import assert from 'node:assert/strict'
import { UNREAD_RECENCY_MS, isRowUnread } from '../lib/projections.js'
import { mobilePageAssets } from '../lib/pages.js'

const MINUTE = 60 * 1000
const ago = (minutes) => Date.now() - Math.round(minutes * MINUTE)
const now = () => Date.now()

const quiet = (id, at) => ({ sessionId: id, updatedAt: at ?? ago(9) })
const running = (id, at) => ({ sessionId: id, updatedAt: at ?? ago(1), running: true })
// 30h old — outside the never-opened recency window (24h), so an absent ledger
// entry reads as 「old business」, not unread.
const ancient = (id) => quiet(id, ago(30 * 60))

test('a running row is never unread — it is counted as running, not finished-quietly', () => {
  assert.equal(isRowUnread(running('a'), 0, now()), false, 'no ledger entry, but running is not the unread state')
  assert.equal(isRowUnread(running('a'), ago(0), now()), false, 'even a fresh open does not change the verdict')
})

test('a row with no activity timestamp has nothing to be behind on', () => {
  assert.equal(isRowUnread({ sessionId: 'a', updatedAt: 0 }, 0, now()), false)
  assert.equal(isRowUnread(null, 0, now()), false)
})

test('a positive ledger entry decides exactly: finished after the last open is unread', () => {
  const row = quiet('a', ago(9))
  assert.equal(isRowUnread(row, ago(60), now()), true, 'opened BEFORE it finished → the tail is unread')
  assert.equal(isRowUnread(row, ago(1), now()), false, 'opened AFTER it finished → read')
  assert.equal(isRowUnread(quiet('b', ago(70 * 60)), ago(71 * 60), now()), true, 'the exact rule does not care how old the row is')
})

test('an absent ledger entry falls back to recency, and only inside the window', () => {
  const recency = 60 * MINUTE
  assert.equal(isRowUnread(quiet('a', ago(9)), 0, now(), recency), true, 'finished 9min ago, window 60min → unread')
  assert.equal(isRowUnread(quiet('b', ago(61)), 0, now(), recency), false, 'finished outside the window → old business')
  assert.equal(isRowUnread(ancient('c'), 0, now()), false, 'default window is 24h (UNREAD_RECENCY_MS)')
  assert.equal(UNREAD_RECENCY_MS, 24 * 60 * 60 * 1000, 'and the default stays pinned')
  // 2026-10-14 (user ruling m00073): the old 48h unread window and the 12h
  // display window are ONE boundary — 24h is the single「still alive」limit that
  // decides showing, red-dotting and preloading. lib/pages.js RECENT_WINDOW_MS
  // carries the same value for the landing script; this pins them together so a
  // future edit to one alone fails here.
  assert.equal(Number(mobilePageAssets({ locale: 'zh' }).js.match(/RECENT_WINDOW_MS=(\d+)/)[1]), UNREAD_RECENCY_MS, 'the landing display window and the unread window are one value')
})
