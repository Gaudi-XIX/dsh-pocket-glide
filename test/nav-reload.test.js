// Navigation must not re-load what is already on screen (2026-10-10, 0.4.17).
//
// The phone's view switch is a SPA (`history.pushState`, no document reload), but
// every navigation used to re-prove the data:
//   • back to the list  → `showSessionList()` awaited a full `session.list`, which
//     the Host answers as EVERY session of EVERY workspace (~195 KB / 469 rows),
//     and then rebuilt the list DOM — so the list you were already looking at
//     re-fetched, re-painted and lost its scroll position;
//   • into a session    → the cached transcript painted, then `applyHistory`
//     repainted the same messages because `openSession` resets `lastHistoryKey` to
//     '' and an empty key never equals a real one.
// Both reads are deliberate (the list must not go stale), so the fix is a window
// and a key, not a cache:
//   A. back-navigation re-fetches only when the catalogue is older than
//      LIST_FRESH_MS, OR when the session being left is live (running / waiting on
//      an answer) — that row is exactly what a reader goes back to look at;
//   B. an instant paint seeds `lastHistoryKey` with the SAME expression
//      `applyHistory` uses, so a follow-up fetch that changes nothing repaints
//      nothing (and does not yank the transcript to the bottom).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const js = mobilePageAssets({ locale: 'zh' }).js

const sliceTo = (start, end) => {
  const from = js.indexOf(start)
  assert.ok(from >= 0, `${start} is gone from the page script`)
  const to = end === null ? js.length : js.indexOf(end, from)
  assert.ok(to > from, `${end} no longer closes ${start}`)
  return js.slice(from, to)
}

// ---------------------------------------------------------------------------
// A — the list read on back-navigation is gated, not unconditional
// ---------------------------------------------------------------------------

test('A the freshness window is a named constant and the stamp is declared', () => {
  assert.match(js, /const SESSION_CACHE_MAX=\d+,LIST_FRESH_MS=\d+,LIST_ROWS_MAX=\d+;/, 'the navigation caps live together as named constants')
  assert.match(js, /let bootListPartial=[\s\S]*?,listFetchedAt=\d+,openPrefetch=null;/, 'listFetchedAt and the prefetch slot are declared with the boot list state')
})

test('A applying a catalogue stamps its age, and a partial one stamps as expired', () => {
  // `bootListPartial` is the SWR stand-in: a list that came from the stale window
  // must not earn a fresh stamp, or the first back press would keep showing it.
  assert.match(js, /listFetchedAt=bootListPartial\?0:Date\.now\(\)/, 'the stamp is taken where the list is applied')
  const boot = sliceTo('function applyBootData(b){', 'function taskGlyph')
  assert.match(boot, /listFetchedAt=bootListPartial/, 'and it is inside applyBootData, so every reader that applies rows stamps it')
})

test('A going back re-fetches only when the rows are old or the session being left is live', () => {
  const leaving = sliceTo('async function showSessionList(){', 'function paintInstantHistory')
  assert.match(
    leaving,
    /const wasLive=agentRunning\|\|pendingQuestion!==null;/,
    'the live-ness is captured BEFORE syncPendingQuestion(null) clears it',
  )
  assert.ok(
    leaving.indexOf('const wasLive=') < leaving.indexOf('syncPendingQuestion(null)'),
    'capturing after the reset would read false and starve the list of a refresh',
  )
  assert.match(
    leaving,
    /if\(wasLive\|\|Date\.now\(\)-listFetchedAt>LIST_FRESH_MS\)await refreshList\(false\)/,
    'the fetch is conditional, and it is still the last statement of the leave path',
  )
  assert.doesNotMatch(leaving, /;\s*await refreshList\(false\)\}/, 'an unconditional re-fetch is not back')
})

test('A the manual refresh still forces the read', () => {
  // The gate lives in showSessionList only. The button and the error paths call
  // refreshList directly, so a reader who wants the truth always gets it.
  assert.match(js, /\$\('listRefresh'\)\.onclick=[\s\S]*?refreshList\(true\)/, 'the list refresh button bypasses the window')
  assert.ok(js.includes('async function refreshList(showFeedback=false){try{await loadListData()'), 'refreshList itself never asks permission')
})

// ---------------------------------------------------------------------------
// C — the document says which transport it was served over
// ---------------------------------------------------------------------------

test('C a boot payload that names the transport sets it before the first stream', () => {
  // The page's `connectionMode` starts as 'lan' and used to be corrected only by
  // the first /api/status reply. On a tunnel that cost one EventSource that cannot
  // work there, open, and get torn down ~30s later (pocket.log: `session stream
  // closed … reason=client-close ms=30xxx`), with the first paint falling back to
  // the 900ms history timeout. The bridge now stamps `mode` into the payload it
  // already builds (see boot-landing.test.js); the page has to consume it in
  // applyBootData, which is the one function every boot route passes through and
  // which startup runs before it opens the focus session.
  const boot = js.slice(js.indexOf('function applyBootData(b){'), js.indexOf('function taskGlyph'))
  assert.match(
    boot,
    /if\(b\.mode==='tunnel'\|\|b\.mode==='lan'\)setConnectionMode\(b\.mode\);/,
    'a boot payload that names the transport goes through the one transport switch the page has',
  )
  const startup = sliceTo('const boot=takeHandoffBoot()', 'reconcileBoot()')
  assert.ok(
    startup.includes('applyBootData(boot)') && !startup.includes('openSession('),
    'the payload is consumed and startup never opens a session — the landing is the list (0.4.36)',
  )
})

// ---------------------------------------------------------------------------
// D — the tunnel round trip starts under the finger
// ---------------------------------------------------------------------------

test('D pressing a row prefetches that session and nothing else', () => {
  assert.match(
    js,
    /function prefetchSession\(id\)\{if\(!id\|\|id\.startsWith\('pending:'\)\|\|openPrefetch&&openPrefetch\.sessionId===id\)return;/,
    'a provisional local id is never asked of the Host, and one press cannot queue two reads',
  )
  assert.match(
    js,
    /\$\('workspaces'\)\.onpointerdown=e=>\{const open=e\.target\.closest\('button\[data-action="open"\]'\);if\(open\)prefetchSession\(open\.dataset\.id\)\};/,
    'the prefetch hangs off pointerdown, so it fires while the tap is still travelling',
  )
})

test('D the prefetch is consumed once, bounded in time, and never replaces a failed read', () => {
  const load = js.slice(js.indexOf('async function loadHistory(initial,force)'), js.indexOf('const FALLBACK_IMAGE_LIMITS'))
  assert.match(load, /Date\.now\(\)-openPrefetch\.at<4000/, 'a prefetch older than a few seconds is a stale transcript, not a fast one')
  assert.match(load, /openPrefetch&&openPrefetch\.sessionId===sessionId&&Date\.now\(\)-openPrefetch\.at<4000\?openPrefetch:null;openPrefetch=null;/, 'consumed by id and cleared before the await')
  assert.match(load, /pref\.promise\.then\(\(v\)=>v\?\?hist\(\)\)/, 'a rejected prefetch falls back to a real read — the wait is never lost')
  assert.equal((load.match(/openPrefetch=null/g) ?? []).length, 1, 'exactly one place retires the prefetch — a second would mean a second consumer nobody asked for')
})

// ---------------------------------------------------------------------------
// B — a paint seeds the history key, so an identical fetch paints nothing
// ---------------------------------------------------------------------------

test('B the instant paint seeds lastHistoryKey with the exact expression applyHistory compares', () => {
  const key = /\[messages,pendingQuestion\?\.rpcId\|\|null,agentRunning,currentTodos,todoExpanded\]/
  const instant = sliceTo('function paintInstantHistory(events,projections){', 'function paintInstantSession')
  const apply = sliceTo('function applyHistory(value,pending,initial){', 'function flushStreamRender')
  assert.match(instant, /lastHistoryKey=JSON\.stringify\(/, 'the instant paint records what it painted')
  assert.match(instant, key, 'and records it with the same tuple')
  const instantKey = instant.match(/JSON\.stringify\((\[[^\]]*\])\)/)[1]
  const applyKey = apply.match(/JSON\.stringify\((\[[^\]]*\])\)/)[1]
  assert.equal(instantKey, applyKey, 'the two key expressions must stay byte-identical or the dedupe silently dies')
  assert.ok(instant.indexOf('lastHistoryKey=') < instant.indexOf('paintMessages(messages,false)'), 'the key is taken before the paint, like applyHistory does')
})

test('B a re-entry that painted from cache does not show the skeleton', () => {
  const open = sliceTo('async function openSession(id,title', 'function handleHistory')
  assert.match(
    open,
    /const hadInstant=paintInstantSession\(\),instantPainted=hadInstant&&!!\$\('messages'\)\.querySelector\('\.message'\);/,
    'instantPainted is the real question: did pixels land, not did a branch run',
  )
  assert.match(open, /if\(!instantPainted\)\$\('messages'\)\.innerHTML=loadingShell\(\)/, 'the skeleton only replaces nothing')
})

test('B the transcript reset still happens before the instant paint', () => {
  // lastHistoryKey='' on entry is what makes the FIRST paint after entry always
  // repaint; the seed above has to come after it or a re-entry would show a stale
  // transcript with no reconciliation at all.
  const open = sliceTo('async function openSession(id,title', 'function handleHistory')
  assert.ok(
    open.indexOf("lastHistoryKey=''") < open.indexOf('paintInstantSession('),
    'the reset precedes the seed',
  )
  assert.match(open, /schedulePoll\(\)/, 'and the poll that reconciles is still armed')
})
