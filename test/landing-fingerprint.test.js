// Landing refresh convergence — card 2026-10-14-feature-pocket-手机八问收敛 T6.
//
// Returning to the landing used to re-download every session of every workspace
// over the tunnel (~195 KB / 469 rows measured, 465-719ms on the Host leg alone)
// to find out that nothing had changed. The three layers now separate:
//   1. bridge — session.list carries a fingerprint of the exact rows; a matching
//      request answers `notModified` and ships nothing;
//   2. page — loadListData carries the last fingerprint and hands it forward,
//      applyBootData keeps the whole session projection when the bridge says
//      `notModified` (workspaces still refresh, the list did not change);
//   3. render — the row host already skips an identical innerHTML, so with 1 and
//      2 in place a no-change poll never repaints.
//
// What must stay true:
//   1. the fingerprint is stable for the same rows and changes with any row;
//   2. a mismatched or absent request still gets the full payload;
//   3. `limit`-trimmed reads never claim not-modified (the trim is client-side);
//   4. the page preserves the session projection on notModified — covered by
//      the source-regex test below (applyBootData's notModified gate). A runtime
//      new-Function extraction of applyBootData was tried and dropped: the
//      function is sync but references many page globals, and slicing between
//      indexOf anchors is fragile when the function body is a template-string
//      payload (see memory: "heavy sync functions: assert the gate in source,
//      do not extract into a sandbox").
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LanMobileBridge } from '../lib/bridge.js'

const bridgeSource = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')

function makeBridge({ items = [] } = {}) {
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = []
  bridge.log = () => {}
  bridge.locale = () => 'zh'
  bridge.now = () => Date.now()
  bridge.pendingQuestions = new Map()
  bridge.workspaceSnapshot = { items: [] }
  bridge.noteSavings = () => {}
  bridge.cachedSessionList = async () => ({ ok: true, value: { items: Array.isArray(items) ? items.map((i) => ({ ...i })) : items } })
  return bridge
}

const rows = (n, extra = {}) => Array.from({ length: n }, (_, index) => ({ sessionId: 's' + index, updatedAt: 1000 + index, ...extra }))

test('the same rows always fingerprint the same, any row change moves it', async () => {
  const a = await makeBridge({ items: rows(4) }).forwardRpc('session.list', {})
  const b = await makeBridge({ items: rows(4) }).forwardRpc('session.list', {})
  assert.equal(a.value.fingerprint, b.value.fingerprint, 'deterministic for identical input')
  assert.match(a.value.fingerprint, /^[A-Za-z0-9_-]{10}$/, 'ten url-safe characters')
  const c = await makeBridge({ items: rows(5) }).forwardRpc('session.list', {})
  assert.notEqual(c.value.fingerprint, a.value.fingerprint, 'one more row is a different catalogue')
  const d = await makeBridge({ items: rows(4, { updatedAt: 9999 }) }).forwardRpc('session.list', {})
  assert.notEqual(d.value.fingerprint, a.value.fingerprint, 'one changed stamp is a different catalogue')
})

test('a matching fingerprint answers notModified and ships no rows', async () => {
  const bridge = makeBridge({ items: rows(6) })
  const first = await bridge.forwardRpc('session.list', {})
  const second = await bridge.forwardRpc('session.list', { fingerprint: first.value.fingerprint })
  assert.equal(second.ok, true)
  assert.deepEqual(second.value, { notModified: true, fingerprint: first.value.fingerprint }, 'the answer is the stamp and nothing else')
})

test('a stale fingerprint still gets the full payload, and the new stamp', async () => {
  const bridge = makeBridge({ items: rows(6) })
  const stale = await bridge.forwardRpc('session.list', {})
  const answer = await bridge.forwardRpc('session.list', { fingerprint: 'deadbeef00' })
  assert.equal(answer.value.notModified, undefined)
  assert.equal(answer.value.items.length, 6, 'the rows travelled')
  assert.equal(answer.value.fingerprint, stale.value.fingerprint, 'and the stamp travels with them')
})

test('a limit-trimmed read never claims not-modified', async () => {
  // The fingerprint describes the full catalogue; the trim is client-side. A
  // limited reader must never be satisfied by a stamp — it would strand the
  // caller with a permanently short list.
  const bridge = makeBridge({ items: rows(8) })
  const limited = await bridge.forwardRpc('session.list', { limit: 2 })
  assert.equal(limited.value.items.length, 2, 'the trim still happens')
  const again = await bridge.forwardRpc('session.list', { limit: 2, fingerprint: limited.value.fingerprint })
  assert.equal(again.value.notModified, undefined, 'a limited reader cannot be satisfied by a stamp')
  assert.equal(again.value.items.length, 2)
})

test('an absent catalogue fingerprints null and never matches anything', async () => {
  const bridge = makeBridge({ items: null })
  const answer = await bridge.forwardRpc('session.list', {})
  const other = await makeBridge({ items: null }).forwardRpc('session.list', {})
  assert.equal(answer.value.fingerprint, other.value.fingerprint, 'stable for the empty catalogue')
  const echo = await bridge.forwardRpc('session.list', { fingerprint: answer.value.fingerprint })
  assert.equal(echo.value.notModified, undefined, 'nothing to short-circuit on')
})

test('the page hands the fingerprint forward and keeps the projection on notModified', () => {
  const source = readFileSync(new URL('../lib/pages.js', import.meta.url), 'utf8')
  // loadListData asks with the stamp it last saw and records the fresh one.
  assert.match(source, /const sessReq=listFingerprint\?\{fingerprint:listFingerprint\}:\{\};/)
  assert.match(source, /if\(sessValue&&sessValue\.fingerprint\)listFingerprint=sessValue\.fingerprint;/)
  // applyBootData: the session projection runs only when the rows really came.
  assert.match(source, /if\(!\(sessInput\.notModified===true\)\)\{subagentRowsByParent=splitSubagentRows\(sessInput\.items\);sessionSummaries=projectSessionRows\(sessInput\.items\);bootListPartial=sessInput\.partial===true;/)
  // A redraw of the subagent capsule follows on purpose: the boot rows are the only
  // child-row source before the first refresh, so a chat opened from a cold boot has
  // nothing to show until this lands (m00002, 2026-10-18).
  assert.match(source, /bootListPartial=sessInput\.partial===true;if\(activeSession&&!subagentView\)renderSubagentBar\(\)\};/)
  assert.match(source, /,listFingerprint=''/, 'the stamp is page state, like the rest')
  // The bridge function and the notModified answer exist in source.
  assert.match(bridgeSource, /function listFingerprint\(items\)\s*\{/)
  assert.match(bridgeSource, /notModified/)
})
