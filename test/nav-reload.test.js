// Navigation and the landing list clock (reworked 2026-10-13, 0.4.37).
//
// The phone's view switch is a SPA (`history.pushState`, no document reload).
// 0.4.17 gated the back-navigation re-fetch behind a freshness window because
// the repaint flung the scroll to the top. 2026-10-13 the user ruled the other
// way: a returning reader must see the truth immediately (「进入到主页面的时
// 候就马上一次刷新」), a landing left standing re-reads on the slow LIST_POLL_MS
// clock, and the scroll problem is solved where it lives — a render whose
// markup did not change leaves the DOM (and the scroll position) untouched.
//   A. back to the list  → always `refreshList`; repaint only on real change;
//   B. landing standing  → the quiet LIST_POLL_MS poll (see section E);
//   C. into a session    → an instant paint seeds `lastHistoryKey` with the
//      SAME expression `applyHistory` uses, so a follow-up fetch that changes
//      nothing repaints nothing (and does not yank the transcript to the
//      bottom).
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
// A — the list read on back-navigation is unconditional; the paint is not
// ---------------------------------------------------------------------------

test('A the navigation caps live together as named constants', () => {
  assert.match(js, /const SESSION_CACHE_MAX=\d+,LIST_ROWS_MAX=\d+,LIST_POLL_MS=\d+;/, 'the navigation caps live together as named constants')
})

test('A going back re-fetches unconditionally — the 0.4.17 window is retired', () => {
  // 用户 2026-10-13：「进入到主页面的时候就马上一次刷新」。A reader who taps a
  // row, reads the reply and comes back wants the CURRENT row, not the one they
  // left behind — no age window decides otherwise.
  const leaving = sliceTo('async function showSessionList(){', 'function paintInstantHistory')
  assert.match(
    leaving,
    /\$\('sessionsView'\)\.classList\.add\('active'\);await refreshList\(false\);startListPoll\(\)\}/,
    'the fetch is unconditional and arming the clock is the last statement of the leave path',
  )
  assert.ok(!leaving.includes('LIST_FRESH_MS'), 'no freshness window survives')
  assert.ok(!leaving.includes('wasLive'), 'no live-ness gate survives — every return re-reads')
})

test('A an unchanged catalogue repaints nothing, so the mandatory re-fetch keeps the scroll', () => {
  // innerHTML always rebuilds nodes, even for an identical string — the 0.4.17
  // scroll complaint lived exactly there. The repaint now happens only when the
  // markup actually differs.
  const render = sliceTo('function renderWorkspaces(){', 'function relativeTime')
  assert.match(render, /const html=workspaces\.map\(/, 'the markup is built into a local first')
  assert.match(render, /if\(host\.innerHTML!==html\)host\.innerHTML=html/, 'and assigned only when it differs')
})

test('A the manual refresh still forces the read', () => {
  // The gate lives in showSessionList only. The button and the error paths call
  // refreshList directly, so a reader who wants the truth always gets it.
  assert.match(js, /\$\('listRefresh'\)\.onclick=[\s\S]*?refreshList\(true\)/, 'the list refresh button bypasses the window')
  assert.ok(js.includes('async function refreshList(showFeedback=false){try{await loadListData()'), 'refreshList itself never asks permission')
})

// ---------------------------------------------------------------------------
// E — the landing keeps a slow clock of its own (2026-10-13, 0.4.37)
//
// Leaving a live session refreshed the list once, and then nothing on the
// landing ever moved again: schedulePoll exits on !activeSession, so the row
// kept its exit-moment state and timestamp until the reader happened to switch
// tabs back (the only other resumeOnReturn trigger). The poll closes that gap.
// ---------------------------------------------------------------------------

test('E the landing poll re-arms itself and reads through resumeOnReturn, quietly', () => {
  const poller = sliceTo('function stopListPoll()', 'function showToast')
  assert.match(
    poller,
    /listPoll=setTimeout\(\(\)=>\{listPoll=null;if\(activeSession\|\|draftWorkspaceId\|\|document\.hidden\)return;void resumeOnReturn\(true\)\.finally\(startListPoll\)\},LIST_POLL_MS\)/,
    'one tick re-arms the next, and a chat, a draft or a hidden tab stops the chain instead of racing it',
  )
  assert.match(
    js,
    /async function resumeOnReturn\(quiet\)\{[\s\S]*?if\(!quiet\)showError\('listError',e\)/,
    'a background miss must not flash the error banner — announcing failure stays the manual refresh button\'s job',
  )
})

test('E the poll lives exactly on the landing: armed on entry, disarmed into a chat', () => {
  const leaving = sliceTo('async function showSessionList(){', 'function paintInstantHistory')
  assert.match(leaving, /await refreshList\(false\);startListPoll\(\)\}/, 'back to the list arms the clock as its last statement')
  const open = sliceTo('async function openSession(id,title', 'function handleHistory')
  assert.match(open, /clearTimeout\(poll\);stopListPoll\(\);closeSessionStream\(\);/, 'entering a session disarms it beside the session poll')
  const draft = sliceTo('function startDraftChat(workspaceId){', 'async function ensureSession()')
  assert.match(draft, /stopListPoll\(\);draftWorkspaceId=workspaceId;/, 'a new-chat draft counts as a chat too')
})

test('E the poll also stops for a hidden tab and restarts with the page', () => {
  assert.match(
    js,
    /pauseEventPolling\(\);stopListPoll\(\);return\}/,
    'hidden stops the chain — visibilitychange is what restarts it',
  )
  assert.match(
    js,
    /else\{if\(tabWasHidden\)void resumeOnReturn\(\);startListPoll\(\)\}void checkConnection\(\)/,
    'back on the landing the clock restarts (and the immediate resume still runs)',
  )
  assert.match(
    js,
    /scheduleOpenedMapSync\(\);void pullOpenedMapRemote\(\);startListPoll\(\);/,
    'boot arms it too — the landing is on screen from the first paint',
  )
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
