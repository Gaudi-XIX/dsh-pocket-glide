// Session pinning, folded into the workspace projection.
//
// The Host's `workspace/follow` baseline already carries `pinnedSessionIds` and it
// pushes `{type:'pinned', pinnedSessionIds:[...]}` to every follower on each
// pin/unpin. Until 2026-10-13 the pinned arm of `applyWorkspaceFollowFrame` threw
// that field away with a bare `return snapshot` (the comment claimed the snapshot
// "carries no pinned projection"), so the phone never learned which sessions the
// desktop had pinned even though the data arrived. The neighbouring `archived` arm
// is the correct shape and is pinned here alongside it as the contract.
//
// Everything below imports the real export — no function extraction, no sandboxed
// copy — so a change to `lib/projections.js` cannot pass these tests by being
// copied into this file.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyWorkspaceFollowFrame, isWorkspaceSnapshot } from '../lib/projections.js'

/**
 * A minimal but realistic baseline: two workspaces, each owning sessions, plus the
 * two session-id sets the Host broadcasts alongside `items`.
 * @param {Record<string, unknown>} [over]
 */
function baseline(over) {
  return {
    items: [
      { workspaceId: 'ws-a', label: 'A', sessionIds: ['s1', 's2'] },
      { workspaceId: 'ws-b', label: 'B', sessionIds: ['s3'] }
    ],
    archivedSessionIds: ['s2'],
    pinnedSessionIds: ['s1'],
    ...over
  }
}

test('a baseline keeps the pinnedSessionIds the Host sent', () => {
  const snapshot = applyWorkspaceFollowFrame(null, { type: 'baseline', value: baseline() })

  assert.ok(isWorkspaceSnapshot(snapshot), 'and the snapshot is still a workspace snapshot')
  assert.deepEqual(snapshot.pinnedSessionIds, ['s1'])
  assert.deepEqual(snapshot.archivedSessionIds, ['s2'])
})

test('a baseline with no pinned field at all stays a valid snapshot', () => {
  // Older Host builds (or a Host that has nothing pinned and omits the key): the
  // baseline arm only validates `items`, so this must not throw and must not invent
  // the field — the page falls back to `ws.pinnedSessionIds || []`.
  const snapshot = applyWorkspaceFollowFrame(null, {
    type: 'baseline',
    value: { items: [{ workspaceId: 'ws-a', sessionIds: [] }] }
  })

  assert.deepEqual(snapshot.items, [{ workspaceId: 'ws-a', sessionIds: [] }])
  assert.equal('pinnedSessionIds' in snapshot, false)
})

test('a pinned increment replaces the field instead of dropping it', () => {
  const current = baseline()
  const snapshot = applyWorkspaceFollowFrame(current, {
    type: 'pinned',
    pinnedSessionIds: ['s3', 's1']
  })

  // Full replacement, not a union: the Host sends the whole set every time, so an
  // unpin on the desktop has to disappear on the phone too.
  assert.deepEqual(snapshot.pinnedSessionIds, ['s3', 's1'])
  assert.deepEqual(snapshot.archivedSessionIds, ['s2'], 'the other field survives untouched')
  assert.deepEqual(snapshot.items, current.items, 'the items are not re-ordered or rebuilt')
})

test('a pinned increment does not alias or mutate the frame it was given', () => {
  // The bridge hands the same parsed frame object to the fold and the ids array
  // belongs to whoever decoded it; the snapshot must hold its own copy.
  const ids = ['s1']
  const snapshot = applyWorkspaceFollowFrame(baseline(), { type: 'pinned', pinnedSessionIds: ids })

  assert.notEqual(snapshot.pinnedSessionIds, ids, 'the array is a copy')
  ids.push('mutated-after-fold')
  assert.deepEqual(snapshot.pinnedSessionIds, ['s1'], 'and later mutation of the frame cannot reach it')
})

test('a malformed pinned frame is a no-op and never writes undefined over the ids', () => {
  const current = baseline()

  // Shape the projection must tolerate: the increment arrived without the array
  // (old Host shape) or with the wrong type. `.slice()` on either would throw, and
  // a missing field written through `{ ...current, pinnedSessionIds: undefined }`
  // would erase a baseline that was perfectly good.
  for (const frame of [
    { type: 'pinned' },
    { type: 'pinned', pinnedSessionIds: null },
    { type: 'pinned', pinnedSessionIds: 's1' },
    { type: 'pinned', pinnedSessionIds: { 0: 's1' } }
  ]) {
    const snapshot = applyWorkspaceFollowFrame(current, frame)
    assert.equal(snapshot, current, `${JSON.stringify(frame)} leaves the snapshot alone`)
    assert.deepEqual(snapshot.pinnedSessionIds, ['s1'], 'the baseline ids are still there')
  }
})

test('a pinned increment before any baseline is ignored', () => {
  // Same rule as every other increment arm: there is no projection to apply to.
  const snapshot = applyWorkspaceFollowFrame(null, { type: 'pinned', pinnedSessionIds: ['s1'] })

  assert.equal(snapshot, null)
})

test('pinned folds compose with the archived arm and with later item increments', () => {
  // The three arms must not clobber each other in either direction — the page reads
  // both sets off the same snapshot.
  let snapshot = applyWorkspaceFollowFrame(null, { type: 'baseline', value: baseline() })
  snapshot = applyWorkspaceFollowFrame(snapshot, { type: 'pinned', pinnedSessionIds: [] })
  assert.deepEqual(snapshot.pinnedSessionIds, [], 'an unpin-everything frame clears the set')

  snapshot = applyWorkspaceFollowFrame(snapshot, { type: 'archived', archivedSessionIds: ['s3'] })
  assert.deepEqual(snapshot.archivedSessionIds, ['s3'])
  assert.deepEqual(snapshot.pinnedSessionIds, [], 'the archived fold left pinned alone')

  snapshot = applyWorkspaceFollowFrame(snapshot, {
    type: 'upsert',
    workspace: { workspaceId: 'ws-a', label: 'A renamed', sessionIds: ['s1'] }
  })
  assert.equal(snapshot.items[0].label, 'A renamed')
  assert.deepEqual(snapshot.archivedSessionIds, ['s3'], 'the upsert fold left the id sets alone')

  snapshot = applyWorkspaceFollowFrame(snapshot, { type: 'pinned', pinnedSessionIds: ['s1'] })
  assert.deepEqual(snapshot.pinnedSessionIds, ['s1'])
  assert.equal(snapshot.items.length, 2, 'and pinning left the items untouched')
})

test('an unknown frame type is still ignored', () => {
  // Regression guard for the general contract: only the known arms fold, and the
  // pinned arm is now keyed on `Array.isArray` like `order` is, so a renamed type
  // cannot sneak through and write a field.
  const current = baseline()
  const snapshot = applyWorkspaceFollowFrame(current, { type: 'pinnedSessions', pinnedSessionIds: ['x'] })

  assert.equal(snapshot, current)
})
