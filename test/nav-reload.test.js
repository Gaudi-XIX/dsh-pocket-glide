// Navigation and the landing list clock (reworked 2026-10-13, 0.4.37).
//
// The phone's view switch is a SPA (`history.pushState`, no document reload).
// 0.4.17 gated the back-navigation re-fetch behind a freshness window because
// the repaint flung the scroll to the top. 2026-10-13 the user ruled the other
// way: a returning reader must see the truth immediately (「进入到主页面的时
// 候就马上一次刷新」), a landing left standing re-reads on the slow LIST_POLL_MS
// clock, and the scroll problem is solved where it lives — a render whose
// markup did not change leaves the DOM (and the scroll position) untouched.
//   A. back to the list  → always a quiet resume (resumeOnReturn); repaint only
//      on real change; the spinner belongs to the manual button alone;
//   A2. the re-read glows while it travels (0.4.39): the header spinner plus a
//       slight list dim — the poll (section E) stays silent by design;
//   B. landing standing  → the quiet LIST_POLL_MS poll (see section E);
//   C. into a session    → an instant paint seeds `lastHistoryKey` with the
//      SAME expression `applyHistory` uses, so a follow-up fetch that changes
//      nothing repaints nothing (and does not yank the transcript to the
//      bottom).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const js = mobilePageAssets({ locale: 'zh' }).js
const css = mobilePageAssets({ locale: 'zh' }).css

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
  // 2026-10-15 改为静默后台读：返回主页不再 await 一次带 spinner 的 refreshList，
  // 而是 void resumeOnReturn(true) 在后台补读，读完有变才重绘，期间可直接点
  // （「刷新就在背后偷偷刷新呗，先让用户再点呗」）。无条件读的契约不变，只是不再
  // 让读者等：spinner/400ms 底噪/错误横幅全部只属于手动刷新钮。
  const leaving = sliceTo('async function showSessionList(){', 'function paintInstantHistory')
  assert.match(
    leaving,
    /\$\('sessionsView'\)\.classList\.add\('active'\);[\s\S]*?void resumeOnReturn\(true\);startListPoll\(\)\}/,
    'the fetch is unconditional and arming the clock is the last statement of the leave path',
  )
  assert.ok(!leaving.includes('LIST_FRESH_MS'), 'no freshness window survives')
  assert.ok(!leaving.includes('wasLive'), 'no live-ness gate survives — every return re-reads')
})

test('A an unchanged catalogue repaints nothing, so the mandatory re-fetch keeps the scroll', () => {
  // innerHTML always rebuilds nodes, even for an identical string — the 0.4.17
  // scroll complaint lived exactly there. The repaint now happens only when the
  // markup actually differs.
  const render = sliceTo('function renderWorkspaces(){', 'function timeFor')
  assert.match(render, /const html=workspaces\.map\(/, 'the markup is built into a local first')
  assert.match(render, /if\(host\.innerHTML!==html\)host\.innerHTML=html/, 'and assigned only when it differs')
})

test('A the manual refresh still forces the read', () => {
  // The gate lives in showSessionList only. The button and the error paths call
  // refreshList directly, so a reader who wants the truth always gets it.
  assert.match(js, /\$\('listRefresh'\)\.onclick=[\s\S]*?refreshList\(true\)/, 'the list refresh button bypasses the window')
  assert.match(js, /async function refreshList\(showFeedback=false\)\{beginListGlow\(\);try\{await loadListData\(\)/, 'refreshList itself never asks permission')
})

// ---------------------------------------------------------------------------
// A2 — the mandatory re-read is lubricated, not a hard cut (2026-10-13, 0.4.39)
//
// 0.4.37 made the return-to-landing re-fetch unconditional, but during the
// tunnel round-trip the stale snapshot just sat there with no signal and the
// fresh rows popped in after silence (user: 「中间加一个转圈圈的动画……不要
// 那种硬切过去，而是中间有一个润滑」). The glow rides the header refresh
// button (spinner, the pattern the manual button already had) plus a slight
// list dim; endListGlow keeps both on for ≥400ms so a fast read does not flash.
// ---------------------------------------------------------------------------

test('A2 the glow marks the list and the header button, with a 400ms floor', () => {
  const glow = sliceTo('function beginListGlow()', 'let tabWasHidden=document.hidden;')
  assert.match(glow, /function beginListGlow\(\)\{[\s\S]*?\$\('workspaces'\)\.classList\.add\('is-refreshing'\)[\s\S]*?btn\.classList\.add\('spinning'\)/, 'begin dims the list and spins the header button')
  assert.match(glow, /function endListGlow\(\)\{[\s\S]*?Math\.max\(0,400-\(Date\.now\(\)-listGlowAt\)\)/, 'end keeps the indicator on for at least 400ms — a fast read must not flash')
  assert.match(glow, /finally\{endListGlow\(\)\}\}/, 'refreshList retires the glow on success and failure alike')
})

test('A2 the glow covers the return paths, the quiet poll stays invisible', () => {
  // resumeOnReturn serves two masters: the reader who just came back (a tab
  // return, a bfcache restore — same surprise as back-navigation, same glow)
  // and the slow LIST_POLL_MS clock (must stay silent — a 60s visual pulse
  // would be noise). quiet already means "announce nothing", so it gates the
  // glow exactly as it gates the error banner.
  assert.match(js, /resumeInFlight=true;if\(!quiet\)beginListGlow\(\)/, 'a user-initiated resume glows')
  assert.match(js, /finally\{if\(!quiet\)endListGlow\(\);resumeInFlight=false\}\}/, 'and retires it even when the read fails')
  assert.match(js, /void resumeOnReturn\(true\)\.finally\(startListPoll\)/, 'the background poll stays quiet — no glow, no banner')
})

test('A2 the manual button hands spinning to the glow and keeps only its guard', () => {
  // The old onclick painted and unpainted its own spinner with a bare 400ms
  // timeout; that logic now lives in begin/endListGlow where every path shares
  // it. What must stay at the button is the re-entry guard against double reads.
  assert.match(js, /\$\('listRefresh'\)\.onclick=\(\)=>\{if\(\$\('listRefresh'\)\.classList\.contains\('spinning'\)\)return;refreshList\(true\)\}/, 'guard stays, spinner choreography is the glow\'s job')
})

test('A2 the dim lives in the stylesheet and honours reduced motion', () => {
  assert.match(css, /\.workspaces\{[^}]*transition:opacity \.18s ease\}/, 'the container eases between opaque and dimmed')
  assert.match(css, /\.workspaces\.is-refreshing\{opacity:\.55\}/, 'the refresh state dims the standing rows instead of blanking them')
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.anchor-fab\{transition:none\}\.workspaces\{transition:none\}\}/, 'reduced motion switches the dim instantly, no ease')
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
    /listPoll=setTimeout\(\(\)=>\{listPoll=null;if\(document\.hidden\|\|activeSession\|\|draftWorkspaceId\)return;void resumeOnReturn\(true\)\.finally\(startListPoll\)\},LIST_POLL_MS\)/,
    'one tick re-arms the next; an open chat, draft or hidden tab stops the chain — no background treadmill',
  )
  assert.match(
    js,
    /async function resumeOnReturn\(quiet\)\{[\s\S]*?if\(!quiet\)showError\('listError',e\)/,
    'a background miss must not flash the error banner — announcing failure stays the manual refresh button\'s job',
  )
})

test('E the poll lives exactly on the landing: armed on entry, disarmed into a chat', () => {
  const leaving = sliceTo('async function showSessionList(){', 'function paintInstantHistory')
  assert.match(leaving, /void resumeOnReturn\(true\);startListPoll\(\)\}/, 'back to the list refreshes quietly and arms the clock as its last statement')
  // 用户 2026-10-15：「从对话里面返回到主页的时候，它是要刷新的，但现在一刷新整个
  // 页面都变了……刷新就在背后偷偷刷新呗，先让用户再点呗」。返回主页不再 await 一次
  // 带 spinner 的 refreshList：列表已经在屏幕上（上次访问留下的），quiet resume 在后台
  // 补读，读完若内容有变才重绘，期间读者可以直接点。refreshList 只留给刷新钮。
  const open = sliceTo('async function openSession(id,title', 'function handleHistory')
  // (2026-10-14 m02164②) entering a chat also hands the outgoing transcript to the
  // cache first — same statement sequence, one more step in the middle.
  assert.match(open, /clearTimeout\(poll\);stopListPoll\(\);[\s\S]*?evictSessionCache\(\)\}closeSessionStream\(\);/, 'entering a session disarms it beside the session poll')
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

test('REQ3 the handoff landing refills its short list like every other route', () => {
  // 用户 2026-10-15 REQ3：「进入对话以后的显示逻辑仍然有问题。24 小时之内的所有会话
  // 都应该显示出来，至少刚刚我进来就没显示」。boot 现在带全量会话行，首屏即完整、
  // bootListPartial 不再触发；但补拉路径保留作安全网。这里钉住：补拉是无条件的
  // （只看 bootListPartial），reconcile 的守卫不变（handoff 已带完整首屏，不需再取 /api/boot）。
  const startup = sliceTo('const boot=takeHandoffBoot()', 'async function reconcileBoot()')
  assert.match(startup, /if\(bootListPartial\)void fillListFromServer\(\)/, 'the refill is not gated on how the payload arrived')
  assert.doesNotMatch(startup, /if\(!handoff&&bootListPartial\)/, 'the old handoff guard is what hid the rest of the 24h window')
  assert.match(startup, /if\(!handoffBoot\)reconcileBoot\(\)/, 'reconcile keeps its own guard — the handoff payload is already fresh')
})

test('REQ3 a completed refill clears the partial flag so the notice stops', () => {
  const fill = js.slice(js.indexOf('async function fillListFromServer()'), js.indexOf('async function fillListFromServer()') + 700)
  assert.match(fill, /bootListPartial=false;renderWorkspaces\(\)/, 'the full table replaces the short one, so the「正在重试」notice must go with it')
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

// ---------------------------------------------------------------------------
// F — a session-to-session jump hands the transcript over instead of dropping it
// (2026-10-14 m02164②: 「返回的时候为什么又要把这个会话加载了？这不是已经加载好了的吗」)
// ---------------------------------------------------------------------------

test('F leaving one chat for another stashes the outgoing transcript before the teardown', () => {
  const open = sliceTo('async function openSession(id,title', 'function handleHistory')
  assert.match(
    open,
    /if\(activeSession&&activeSession!==id&&streamEvents\.length\)\{sessionCache\.set\(activeSession,\{streamEvents,olderEvents,olderHasMore,olderExhausted,streamProjections,at:Date\.now\(\)\}\);evictSessionCache\(\)\}closeSessionStream\(\)/,
    'the jump caches by the OUTGOING id and only then closes the stream — closing first would empty the arrays it is reading',
  )
  assert.ok(
    open.indexOf('sessionCache.set(activeSession') < open.indexOf('evictSessionCache()}closeSessionStream()'),
    'the stash strictly precedes the teardown (compared against the call, not the comment that names it)',
  )
})

test('F a fresh handover paint skips the history refetch, a stale one does not', () => {
  const open = sliceTo('async function openSession(id,title', 'function handleHistory')
  assert.match(
    open,
    /const instantFresh=instantPainted&&Date\.now\(\)-\(\(sessionCache\.get\(id\)\|\|\{\}\)\.at\|\|0\)<SESSION_CACHE_FRESH_MS;/,
    'freshness is measured against the stamp the same entry wrote — an unstamped or missing cache is never fresh',
  )
  assert.match(
    open,
    /if\(activeSession===id&&firstFrame!==true&&!instantFresh\)await loadHistory\(true\);/,
    'the refetch still happens for a slow first frame or a cold paint — only the redundant one is dropped',
  )
  assert.match(js, /const SESSION_CACHE_FRESH_MS=\d+;/, 'the window is a named constant, not a literal')
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
