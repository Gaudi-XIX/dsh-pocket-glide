// Scroll follow + dual anchors + history virtualization + unread dot + offline
// fallback (change 2026-10-07-feat-pocket-smart-scroll-anchors, W3-卡6).
//
// Layers proven here, mirroring the card's acceptance list:
//   1. the follow state machine's decision organs (near-bottom band, distance)
//      and the machine's behaviour through the REAL paintMessages;
//   2. the dual anchor visibility table (mutually exclusive by construction:
//      the farthest-down target wins);
//   3. content-visibility tagging (only the history tail is marked, the last
//      CV_TAIL_KEEP messages and anything streaming stay untagged);
//   4. the unread ledger (localStorage shape, cap, per-session comparison);
//   5. the service worker's offline navigation fallback — driven behaviourally
//      against a stubbed SW world, with the API/SSE boundary untouched.
// House pattern: behaviour runs the REAL functions spliced out of the rendered
// asset (stream-watermark / subagent-session-dom-assertions precedent); the
// real-browser geometry half lives in test/dom/pages-geometry.mjs (scene G).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets, renderServiceWorker } from '../lib/pages.js'

const assets = { zh: mobilePageAssets({ locale: 'zh' }), en: mobilePageAssets({ locale: 'en' }) }

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

function fakeBox({ scrollHeight = 5000, scrollTop = 0, clientHeight = 800 } = {}) {
  return {
    scrollHeight, scrollTop, clientHeight,
    innerHTML: '',
    getBoundingClientRect() { return { top: 0, bottom: this.clientHeight, height: this.clientHeight } },
    querySelectorAll() { return [] },
    querySelector() { return null },
  }
}

// ------------------------------------------------- 1. follow machine organs

const scrollOrgans = (locale = 'zh') => {
  const js = assets[locale].js
  const names = ['transcriptDistance', 'isNearBottom', 'anchorVisibleState', 'markHistoryTail']
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  // 2026-10-12 P1: isNearBottom no longer trusts the raw 120px band alone — it caps the
  // band at half the settled transcript height, so a 120px band cannot mean "the reader
  // is still following" on a transcript that is barely taller than the viewport. That
  // pulls settledTranscriptHeight (and its lastScrollHeight fallback) into this sandbox.
  return new Function(`
    const SCROLL_FOLLOW_PX=120,ANCHOR_LATEST_SCREENS=1.5,ANCHOR_LEAVE_SCREENS=1,ANCHOR_PROMPT_SCREENS=1,CV_TAIL_KEEP=8;
    let lastScrollHeight=0;
    function settledTranscriptHeight(){const box=$('messages');return box&&box.scrollHeight?box.scrollHeight:lastScrollHeight}
    function $(){return null}
    ${body}
    return { transcriptDistance, isNearBottom, anchorVisibleState, markHistoryTail }
  `)()
}

test('the near-bottom band is the 120px follow threshold, measured from the bottom edge', () => {
  const { transcriptDistance, isNearBottom } = scrollOrgans()
  assert.equal(transcriptDistance({ scrollHeight: 5000, scrollTop: 1000, clientHeight: 800 }), 3200)
  assert.equal(isNearBottom({ scrollHeight: 5000, scrollTop: 4080, clientHeight: 800 }), true, '120px from the bottom still follows')
  assert.equal(isNearBottom({ scrollHeight: 5000, scrollTop: 4079, clientHeight: 800 }), false, '121px away is unlocked')
  assert.equal(isNearBottom({ scrollHeight: 800, scrollTop: 0, clientHeight: 800 }), true, 'a short transcript is always near bottom')
})

test('anchor visibility: ONE gate for both buttons — they open together past the follow band, and ↑ never vanishes mid-climb', () => {
  const { anchorVisibleState } = scrollOrgans()
  // 2026-10-10, unified on the user's instruction (「别搞这么复杂了…统一时间逻辑」): the deck
  // opens the moment the reader leaves the 120px follow band and closes when they return to
  // it. ↓ = back to the bottom; ↑ = the nearest question above the fold, and pressing it
  // again walks to the one above that. Retired here: mutual exclusion, the 1.5-screen ↓
  // lead-in, and the full-screen separation ↑ used to demand (the clause that kept making
  // ↑ blink out mid-climb).
  assert.deepEqual(anchorVisibleState(0, true), { latest: false, prompt: false }, 'sat on the bottom: dark')
  assert.deepEqual(anchorVisibleState(120, true), { latest: false, prompt: false }, 'inside the follow band: dark')
  assert.deepEqual(anchorVisibleState(121, true), { latest: true, prompt: true }, 'one pixel out: BOTH appear, at the same moment')
  assert.deepEqual(anchorVisibleState(121, false), { latest: true, prompt: false }, 'no question above → only ↓, nothing to walk back to')
  assert.deepEqual(anchorVisibleState(6000, true), { latest: true, prompt: true }, 'deep in history: both still there, ↑ never blinked out')
  let latest = false
  for (let dist = 0; dist <= 6000; dist += 37) {
    const swept = anchorVisibleState(dist, true)
    if (latest) assert.equal(swept.latest, true, `↓ vanished at dist=${dist}`)
    latest = swept.latest
    assert.equal(swept.prompt, dist > 120, `↑ flickered at dist=${dist}`)
  }
})

test('the 0.4.4 guard survives the unification: at the foot of a long reply, nothing lights however far above the question sits', () => {
  const { anchorVisibleState } = scrollOrgans()
  // The bug this still blocks: ↑ lighting while the reader had not moved at all, at the
  // bottom of a multi-screen answer. Distance from the bottom is still the only gate.
  for (const dist of [0, 1, 60, 119, 120]) {
    assert.deepEqual(anchorVisibleState(dist, true), { latest: false, prompt: false },
      `dist=${dist} is inside the follow band — nothing may light`)
  }
  assert.equal(anchorVisibleState(121, true).prompt, true, 'leaving the band is the only thing it takes')
})

// --------------------------------------- 1b. the ↑ jump organs (target + settle)

// answerAnchorEl / anchorTopOf / settlePromptJump in ONE sandbox: the target selector and
// the settle chain are exactly the two things that made ↑ "飘/抖动" in the 2026-10-13
// report. setTimeout is shadowed so the chain is observed, never slept on.
// Geometry note: the fake box reports top=0, so anchorTopOf(box,row)=row.top+scrollTop and
// the selection test row.top+scrollTop < scrollTop-JUMP_EDGE_PX reduces to row.top < -4 —
// i.e. "its first line is above the visible area", which is the whole point.
function jumpOrgans() {
  const js = assets.zh.js
  const names = ['answerAnchorEl', 'anchorTopOf', 'settlePromptJump']
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  const timers = []
  const sandbox = new Function('setTimeout', `
    const JUMP_EDGE_PX=4,JUMP_PROMPT_PAD_PX=54;
    function programmaticScroll(){}
    function rowEl(top,fold){return {getBoundingClientRect:()=>({top}),querySelector(){return fold?{nodeType:1}:null},isConnected:true}}
    function boxEl(scrollTop,rows){return {scrollTop,getBoundingClientRect:()=>({top:0}),querySelectorAll(){return rows}}}
    ${body}
    return { answerAnchorEl, anchorTopOf, settlePromptJump, rowEl, boxEl }
  `)((fn) => timers.push(fn))
  return { sandbox, timers }
}

test('↑ targets the nearest assistant ANSWER above the fold, skips fold cards, and never falls back', () => {
  const { sandbox } = jumpOrgans()
  const { answerAnchorEl, rowEl, boxEl } = sandbox
  const answerA = rowEl(-2000, false)   // an answer, far above
  const liveFold = rowEl(-800, true)    // a LIVE turn-process card: it IS wrapped in .message.assistant
  const answerB = rowEl(-50, false)     // the answer whose first line just left the viewport
  const inView = rowEl(200, false)      // still on screen: climbing to it would scroll DOWN
  const box = boxEl(1200, [answerA, liveFold, answerB, inView])
  assert.equal(answerAnchorEl(box), answerB, 'the nearest answer above the fold wins, not the newest row')
  assert.equal(answerAnchorEl(boxEl(1200, [answerA, liveFold])), answerA, 'a fold card is skipped, the walk continues upward')
  assert.equal(answerAnchorEl(boxEl(1200, [liveFold, rowEl(-900, true)])), null, 'only fold cards: no target — the press must do nothing, NOT fall back to the question row')
  assert.equal(answerAnchorEl(boxEl(1200, [inView])), null, 'nothing above the fold: no target')
})

test('the settle chain re-arms on the FIRST pass — the dead-code fix for 飘/抖动', () => {
  const { sandbox, timers } = jumpOrgans()
  const { settlePromptJump, rowEl, boxEl } = sandbox
  // The 2026-10-13 failure: the jump lands on a row whose height is still the 120px
  // content-visibility ESTIMATE, so the very first delta reads 0. The old code kept its
  // setTimeout INSIDE the |delta|>2 branch, so that first zero ended the chain — measured
  // live on a real transcript: 0 queued callbacks across three presses, and the estimate
  // (which was 1:3.07 off the real height) never got corrected.
  const anchor = rowEl(54, false)   // delta = 54 - 0 - 54 = 0: looks perfectly settled
  const box = boxEl(1000, [anchor])
  settlePromptJump(box, anchor, 4)
  assert.equal(timers.length, 1, 'a zero first delta still schedules the next re-measure')
  assert.equal(box.scrollTop, 1000, 'no write when the geometry already agrees')
  // Now let the materialised layout disagree by 2520px — the drift one repaint produced in
  // the 2026-10-13 probe (a settled target row went from +54 to -2466 px after innerHTML).
  anchor.getBoundingClientRect = () => ({ top: 54 - 2520 })
  timers.shift()()
  assert.equal(box.scrollTop, 0, 'a large delta is corrected (clamped at the top when it overshoots)')
  assert.equal(timers.length, 1, 'and the chain keeps going')
  // The chain is bounded: tries count down, and a detached anchor stops it.
  settlePromptJump(box, anchor, 0)
  assert.equal(timers.length, 1, 'tries=0 stops the chain (no unbounded timer)')
  settlePromptJump(box, { getBoundingClientRect: () => ({ top: 0 }), isConnected: false }, 3)
  assert.equal(timers.length, 1, 'a detached anchor stops the chain')
})

test('markHistoryTail tags everything but the last 8 messages; short transcripts stay untagged', () => {
  const { markHistoryTail } = scrollOrgans()
  const long = Array.from({ length: 20 }, () => ({}))
  markHistoryTail(long)
  assert.equal(long.filter((m) => m._history).length, 12, '20 - 8 tail = 12 history rows')
  for (let i = 0; i < 20; i++) {
    if (i < 12) assert.equal(long[i]._history, true, `row ${i} is history`)
    else assert.equal(long[i]._history, false, `row ${i} is tail, must stay untagged`)
  }
  const short = Array.from({ length: 8 }, () => ({}))
  markHistoryTail(short)
  assert.ok(short.every((m) => m._history === false), 'exactly-8 rows: nothing tagged')
  const shorter = Array.from({ length: 3 }, () => ({}))
  markHistoryTail(shorter)
  assert.ok(shorter.every((m) => m._history === false))
  const safe = []
  markHistoryTail(safe)
  assert.equal(safe.length, 0)
  markHistoryTail(null) // must not throw
})

const renderSandbox = () => {
  const js = assets.zh.js
  const body = [
    extractFunction(js, 'renderTurnProcess'),
    extractFunction(js, 'renderMessage'),
  ].join('\n')
  return new Function(`
    const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
    const L={process:'过程',think:'思考'}
    const transcriptView='verbose'
    const turnOpenState=new Map()
    function activityIcon(){return '<i></i>'}
    function activityChevron(){return '<c></c>'}
    function renderBlock(){return '<div class="markdown">x</div>'}
    function renderMessageTail(){return ''}
    function clusterToolBlocks(){return []}
    function toolActivityCategory(){return 'tools'}
    function stepTitleFor(){return ''}
    function renderToolCard(){return ''}
    ${body}
    return { renderMessage, renderTurnProcess }
  `)()
}

test('msg-hist lands on the message wrapper and on history turn-process details, never on the tail', () => {
  const { renderMessage, renderTurnProcess } = renderSandbox()
  const history = renderMessage({ role: 'user', blocks: [{ kind: 'text', text: 'hi' }], _history: true })
  assert.match(history, /^<div class="message msg-hist user">/, 'class order keeps .message.user matching')
  const tail = renderMessage({ role: 'user', blocks: [{ kind: 'text', text: 'hi' }], _history: false })
  assert.match(tail, /^<div class="message user">/, 'untagged markup is byte-identical to the old shape')
  const streamed = renderMessage({ role: 'assistant', streaming: true, blocks: [{ kind: 'text', text: '…' }] })
  assert.doesNotMatch(streamed, /msg-hist/, 'streaming rows are never tagged')
  const process = renderTurnProcess({ turnKey: 't1', streaming: false, blocks: [{ kind: 'tool', id: 'x', name: 'read', status: 'done' }], _history: true })
  assert.match(process, /<details class="turn-process msg-hist"/)
  const tailProcess = renderTurnProcess({ turnKey: 't1', streaming: false, blocks: [{ kind: 'tool', id: 'x', name: 'read', status: 'done' }], _history: false })
  assert.match(tailProcess, /<details class="turn-process" /)
})

// ------------------------------------- 3. the machine through real paintMessages

test('paintMessages sticks only while followStream holds, and a forced stick re-arms it', () => {
  const js = assets.zh.js
  const body = [
    'transcriptHasContent', 'olderButtonHtml', 'loadingShell', 'transcriptWaitHtml',
    'showTranscriptRetry', 'paintMessages', 'esc', 'markHistoryTail', 'readTranscriptAnchor', 'restoreTranscriptAnchor',
  ]
    .map((name) => extractFunction(js, name))
    .join('\n')
  const box = fakeBox({ scrollHeight: 5000, scrollTop: 4200, clientHeight: 800 }) // 0px from bottom after paint… start mid-way
  const make = new Function('box', `
    let activeSession='s1'
    let streamEvents=[],olderEvents=[],olderHasMore=false
    let olderBusy=false,olderRunBusy=false,olderExhausted=false,sessionBlank=false
    let agentRunning=false,pendingQuestion=null
    let followStream=true
    let transcriptAnchor=null,skipAnchorOnce=false
    const turnOpenState=new Map()
    const L={}
    const $=()=>box
    function renderMessage(message){return '<div class="message '+message.role+'"></div>'}
    function syncScrollAnchors(){}
    ${body}
    return {
      paintMessages,
      get follow(){return followStream},
      set follow(v){followStream=v},
    }
  `)
  const sandbox = make(box)

  // following + near bottom → sticks
  box.scrollTop = 4200
  sandbox.follow = true
  sandbox.paintMessages([{ role: 'user', blocks: [] }], false)
  assert.equal(box.scrollTop, box.scrollHeight, 'following: every paint lands on the bottom')

  // unlocked (user scrolled up) → the paint must not steal the position
  box.scrollTop = 1000
  sandbox.follow = false
  sandbox.paintMessages([{ role: 'user', blocks: [] }], false)
  assert.equal(box.scrollTop, 1000, 'unlocked: repaint keeps the reader where they are')

  // explicit stick (send path) → bottom AND re-armed
  sandbox.paintMessages([{ role: 'user', blocks: [] }], true)
  assert.equal(box.scrollTop, box.scrollHeight, 'stickToBottom forces the bottom')
  assert.equal(sandbox.follow, true, 'a forced stick re-arms the follow')

  // unlocked but within 90px of the bottom: the pre-paint near-bottom check no
  // longer overrules the unlock (this is the old behaviour's blind spot)
  box.scrollTop = 5000 - 800 - 80 // 80px from the bottom
  sandbox.follow = false
  sandbox.paintMessages([{ role: 'user', blocks: [] }], false)
  assert.equal(box.scrollTop, 5000 - 880, 'near-bottom alone must not resurrect a following the reader unlocked')
})

test('paintMessages tags the history tail through the real markHistoryTail', () => {
  const js = assets.zh.js
  const body = [
    'transcriptHasContent', 'olderButtonHtml', 'loadingShell', 'transcriptWaitHtml',
    'showTranscriptRetry', 'paintMessages', 'esc', 'markHistoryTail', 'readTranscriptAnchor', 'restoreTranscriptAnchor',
  ]
    .map((name) => extractFunction(js, name))
    .join('\n')
  const box = fakeBox()
  const make = new Function('box', `
    let activeSession='s1'
    let streamEvents=[],olderEvents=[],olderHasMore=false
    let olderBusy=false,olderRunBusy=false,olderExhausted=false,sessionBlank=false
    let agentRunning=false,pendingQuestion=null
    const turnOpenState=new Map()
    const L={}
    const $=()=>box
    function renderMessage(message){return '<div class="message '+message.role+'">'+(message._history===true?'H':'')+'</div>'}
    function syncScrollAnchors(){}
    let followStream=true
    let transcriptAnchor=null,skipAnchorOnce=false
    ${body}
    return { paintMessages }
  `)
  const sandbox = make(box)
  const messages = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', blocks: [] }))
  sandbox.paintMessages(messages, false)
  assert.equal(box.innerHTML.split('H').length - 1, 4, '12 messages → the first 4 carry the history mark')
})

// --------------------------------------------------------- 4. the unread dot

const unreadSandbox = (storage = {}) => {
  const js = assets.zh.js
  const body = [
    'readOpenedMap', 'pruneOpenedMap', 'noteSessionOpened', 'isSessionUnread',
    // 0.4.33: noteSessionOpened schedules the ledger upload, so the sync organs
    // ride along and `fetch` gets a stub — the sandbox must never touch a network.
    'syncOpenedMapNow', 'scheduleOpenedMapSync', 'flushOpenedMapSync',
    // 0.4.35: boot pulls the ledger back from the bridge (per-origin localStorage
    // wipes on every tunnel hostname change) and max-merges it into the local map.
    'mergeOpenedMapFromBridge',
  ]
    .map((name) => extractFunction(js, name))
    .join('\n')
  return new Function('localStorage', 'fetchImpl', `
    const UNREAD_OPEN_KEY='dsh-pocket-opened-at',UNREAD_OPEN_MAX=200;
    const UNREAD_RECENCY_MS=${Number(js.match(/UNREAD_RECENCY_MS=(\d+)/)[1])};
    let openedAtSyncTimer=null,openedAtSyncFailAt=0
    let openedAtLedgerReady=true
    const fetch=fetchImpl
    ${body}
    return { readOpenedMap, pruneOpenedMap, noteSessionOpened, isSessionUnread, mergeOpenedMapFromBridge, setLedgerReady(v){openedAtLedgerReady=v} }
  `)({
    getItem: (key) => (key in storage ? storage[key] : null),
    setItem: (key, value) => { storage[key] = String(value) },
  }, () => ({ then: () => ({ catch: () => {} }) }))
}

test('readOpenedMap accepts only positive finite timestamps and survives garbage', () => {
  assert.deepEqual(unreadSandbox({ 'dsh-pocket-opened-at': '{"a":1000,"b":-5,"c":"x","d":1.5}' }).readOpenedMap(), { a: 1000 })
  assert.deepEqual(unreadSandbox({ 'dsh-pocket-opened-at': 'not json' }).readOpenedMap(), {})
  assert.deepEqual(unreadSandbox({ 'dsh-pocket-opened-at': '[1,2]' }).readOpenedMap(), {}, 'arrays are not a ledger')
  assert.deepEqual(unreadSandbox({}).readOpenedMap(), {})
})

test('noteSessionOpened writes and prunes; the ledger is capped at 200 newest entries', () => {
  const storage = {}
  const sandbox = unreadSandbox(storage)
  sandbox.noteSessionOpened('s1')
  const first = JSON.parse(storage['dsh-pocket-opened-at'])
  assert.ok(first.s1 > 0)
  const before = Date.now()
  sandbox.noteSessionOpened('s1')
  assert.ok(JSON.parse(storage['dsh-pocket-opened-at']).s1 >= before, 're-open refreshes the stamp')
  sandbox.noteSessionOpened('')
  sandbox.noteSessionOpened(null)
  sandbox.noteSessionOpened(42)
  assert.equal(Object.keys(JSON.parse(storage['dsh-pocket-opened-at'])).length, 1, 'junk ids are refused')

  const flood = {}
  for (let i = 0; i < 260; i++) flood['old:' + i] = i + 1 // oldest entries first
  const floodStorage = { 'dsh-pocket-opened-at': JSON.stringify(flood) }
  const s2 = unreadSandbox(floodStorage)
  s2.noteSessionOpened('fresh')
  const kept = JSON.parse(floodStorage['dsh-pocket-opened-at'])
  assert.equal(Object.keys(kept).length, 200, 'cap holds')
  assert.ok(kept.fresh > 0, 'the just-opened session survives its own prune')
  assert.equal(kept['old:60'], undefined, 'the oldest entries go first (fresh + flood values 62..260 fill the cap)')
  assert.equal(kept['old:61'], 62, 'the newest 199 of the flood survive')
})

test('isSessionUnread: activity after last open, excluding running/blank/focused rows', () => {
  const { isSessionUnread } = unreadSandbox({})
  const row = { sessionId: 's1', updatedAt: 5000 }
  assert.equal(isSessionUnread(row, 4000, null), true, 'activity since last open')
  assert.equal(isSessionUnread(row, 5000, null), false, 'opened at the exact activity time')
  assert.equal(isSessionUnread(row, 6000, null), false)
  assert.equal(isSessionUnread(row, 0, null), false, 'never opened and ancient → quiet (a restarted host must not light every row)')
  assert.equal(isSessionUnread({ ...row, updatedAt: Date.now() - 60 * 1000 }, 0, null), true,
    '0.4.33: never opened but finished inside the recency window → unread (the 2026-10-12 blind spot)')
  assert.equal(isSessionUnread({ ...row, updatedAt: Date.now() - 72 * 60 * 60 * 1000 }, 0, null), false,
    'never opened and older than the recency window → quiet')
  assert.equal(isSessionUnread({ ...row, running: true }, 0, null), false, 'running sessions stay quiet')
  assert.equal(isSessionUnread({ ...row, blank: true }, 0, null), false, 'blank shells have nothing to read')
  assert.equal(isSessionUnread(row, 0, 's1'), false, 'the focused session never dots itself')
  assert.equal(isSessionUnread({ sessionId: 's2' }, 0, 's1'), false, 'no updatedAt → no dot')
  assert.equal(isSessionUnread(null, 0, null), false)
  assert.equal(isSessionUnread(row, undefined, null), false, 'a missing ledger entry reads as never opened')
})

test('isSessionUnread: the never-opened inference is suspended until the ledger pull settles', () => {
  // 0.4.35「先默认全灭」：拉回未落定＋本地无条目＝未知，未知不当未读；落定后 48h 规则恢复。
  const sandbox = unreadSandbox({})
  sandbox.setLedgerReady(false)
  assert.equal(sandbox.isSessionUnread({ sessionId: 's1', updatedAt: Date.now() - 60 * 1000 }, 0, null), false,
    'not ready → unknown is not unread')
  sandbox.setLedgerReady(true)
  assert.equal(sandbox.isSessionUnread({ sessionId: 's1', updatedAt: Date.now() - 60 * 1000 }, 0, null), true,
    'settled → the recency rule applies again')
})

const workspaceSandbox = ({ storage = {}, activeSession = null, lastMsg = {} } = {}) => {
  const js = assets.zh.js
  const body = [
    'visibleSessions', 'blankRowVisible', 'taskState', 'taskGlyph', 'pad2',
    'formatMessageClock', 'timeFor', 'titleFor', 'renderWorkspaces', 'readOpenedMap', 'isSessionUnread',
    'isQuestionUnread',
    'readLastMessageMap', 'lastMessageAtOf', 'lastMessageTimeOf', 'sortAtOf', 'pinRank', 'wsHeadTimeAt',
    // T5: renderWorkspaces reads the tail line through tailTextOf — extract the real one.
    'tailTextOf',
    // The head notices (0.4.31): wsFlagsOf/wsFlagHtml are top-level on the page, so
    // the sandbox has to carry them exactly like the renderer it extracts.
    'wsFlagOf', 'wsFlagClass', 'wsFlagRank', 'wsFlagsOf', 'wsFlagHtml', 'wsRunning', 'wsGlyphOf', 'sessionModelLabel',
    'normalizeSelection', 'fieldText',
  ]
    .map((name) => extractFunction(js, name))
    .join('\n')
  const host = { innerHTML: '' }
  const make = new Function(
    'workspaces', 'sessionSummaries', 'expandedWsIds', 'revealedLists', 'activeSession', 'container', 'localStorage', `
    const L=${JSON.stringify({ noWorkspaces: 'none', noTasksHint: 'hint', newChat: 'new', untitled: 'untitled', clockMd: '{m}/{d}', clockYmd: '{y}-{m}-{d}', moreRows: '{n} more', wsNewDone: 'New', wsQuestion: 'Question', wsError: 'Error' })}
    const BLANK_ROW_VISIBLE_MS=${24 * 60 * 60 * 1000}
    const LIST_ROWS_MAX=${25}
    const WS_FLAGS_MAX=${2}
    const UNREAD_OPEN_KEY='dsh-pocket-opened-at',UNREAD_OPEN_MAX=200
    const UNREAD_RECENCY_MS=${Number(js.match(/UNREAD_RECENCY_MS=(\d+)/)[1])}
    // 12h 窗与未读点无关：此档钉 ledger 语义，窗口豁免防 fixture 新旧把行藏进「更多」。窗口钉在 ROWS-RECENT。
    const RECENT_WINDOW_MS=Infinity
    let openedAtLedgerReady=true
    // 2026-10-13 pin passthrough: the renderer sorts pinned rows to the front, so the
    // sandbox owns the same page-level array (empty = no workspace is pinned).
    let pinnedSessionIds=[]
    let pinBusy=new Set()
    const PIN_SVG=''
    const LAST_MESSAGE_KEY=${JSON.stringify(js.match(/LAST_MESSAGE_KEY='([^']+)'/)[1])}
    // T5 tails: the landing paints a tail line only from the prefetch cache, and
    // the sandbox never fetches — an empty cache means no line, matching the page.
    const tailCache=new Map(),tailArmedAt={},tailPending=new Set()
    function requestVisibleTails(){}
    const $=(id)=>container
    function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
    ${body}
    let lastMessageAt=readLastMessageMap()
    return {
      renderWorkspaces,
      markup(){ renderWorkspaces(); return container.innerHTML },
    }
  `)
  const sandbox = make(
    [{ workspaceId: 'w1', title: 'DSH', sessionIds: ['read', 'unread', 'fresh', 'blank1'] }],
    [
      { sessionId: 'read', updatedAt: 1000, blank: false },
      { sessionId: 'unread', updatedAt: 9000, blank: false },
      { sessionId: 'fresh', updatedAt: 9000, blank: false },
      { sessionId: 'blank1', updatedAt: 9000, blank: true },
    ],
    new Set(['w1']),
    new Map(),
    activeSession,
    host,
    {
      getItem: (key) => (key in storage ? storage[key] : key === 'dsh-pocket-last-msg-at' ? JSON.stringify(lastMsg) : null),
      setItem: (key, value) => { storage[key] = String(value) },
    },
  )
  return sandbox
}

test('renderWorkspaces paints is-unread on exactly the rows the ledger marks', () => {
  const storage = { 'dsh-pocket-opened-at': JSON.stringify({ read: 5000, unread: 5000 }) }
  const sandbox = workspaceSandbox({ storage, activeSession: null })
  const markup = sandbox.markup()
  assert.match(markup, /class="task-row is-done is-unread"[^>]*data-id="unread"/, 'activity after last open → dot')
  assert.doesNotMatch(markup, /data-id="read"[^>]*is-unread/, 'opened after its last activity → quiet')
  assert.doesNotMatch(markup, /data-id="fresh"[^>]*is-unread/, 'never opened (no ledger entry) → quiet')
  assert.doesNotMatch(markup, /data-id="unread"[^>]*is-unread/, 'a ledger entry with no later activity → quiet')
  assert.doesNotMatch(markup, /data-id="blank1"[^>]*is-unread/, 'blank rows stay quiet')
  const focused = workspaceSandbox({ storage, activeSession: 'unread' }).markup()
  assert.doesNotMatch(focused, /data-id="unread"[^>]*is-unread/, 'the focused session never dots itself')
})

// ---------------------------------------------------- 5. the wiring (source)

test('mergeOpenedMapFromBridge restores lost history without downgrading newer local stamps', () => {
  // 0.4.35: a tunnel hostname change is a new origin — the browser hands the
  // page an empty localStorage and every row lights up as unread. The bridge
  // kept this device's ledger by fingerprint; the merge puts it back. max()
  // per key: an OLDER bridge stamp must never clobber a newer local one.
  const storage = { 'dsh-pocket-opened-at': JSON.stringify({ s1: 5000 }) }
  const sandbox = unreadSandbox(storage)
  const merged = sandbox.mergeOpenedMapFromBridge({ s1: 4000, s2: 3000, junk: 'not-a-number', gone: 0 })
  assert.equal(merged.s1, 5000, 'local newer stamp survives the bridge copy')
  assert.equal(merged.s2, 3000, 'history the browser lost comes back from the bridge')
  assert.equal(merged.junk, undefined, 'non-numeric bridge values are dropped, not trusted')
  assert.equal(merged.gone, undefined, 'non-positive bridge values are dropped')
  assert.deepEqual(JSON.parse(storage['dsh-pocket-opened-at']), { s1: 5000, s2: 3000 }, 'the merged map lands back in storage')
  assert.deepEqual(sandbox.mergeOpenedMapFromBridge('garbage'), sandbox.readOpenedMap(), 'a foreign body is a no-op, not a wipe')
})

test('the page wires the machine where the tests cannot reach: scroll, open, leave', () => {
  const js = assets.zh.js
  assert.match(js, /followStream=isNearBottom\(live\)/, 'the scroll handler re-decides the follow from the live band')
  assert.match(js, /activeSession=id;const summary=sessionSummaries\.find\(item=>item\.sessionId===id\);sessionBlank=summary\?\.blank\?\?true;noteSessionOpened\(id\);followStream=true;/, 'openSession stamps the ledger and re-arms the follow')
  assert.match(js, /poll=null;if\(activeSession\)noteSessionOpened\(activeSession\);/, 'leaving to the list stamps the ledger (activity seen live is read)')
  assert.match(js, /scheduleOpenedMapSync\(\);void pullOpenedMapRemote\(\);/, 'boot pulls the ledger back from the bridge after the first paint (0.4.35)')
  assert.match(js, /latest\.classList\.toggle\('show',state\.latest\);prompt\.classList\.toggle\('show',state\.prompt\)/, 'each anchor button is wired to its OWN state — no mutual exclusion in the DOM either')
  // Literal grew with the E anchor (0.4.18): this same rAF tick now does a FOURTH
  // thing — it records the reader's row (`transcriptAnchor=readTranscriptAnchor(live)`)
  // whenever the follow is off, so a later full re-paint can put that row back.
  // The contract this assertion carries is unchanged and still holds: all of it
  // happens in ONE tick, so the re-decision, the anchor, the scroll anchors and the
  // top-edge pull can never be spread across frames and fight each other.
  assert.match(js, /followStream=isNearBottom\(live\);if\(!followStream\)transcriptAnchor=readTranscriptAnchor\(live\);pendingFollowFrame=false\}else\{pendingFollowFrame=true\}syncScrollAnchors\(\);topEdgePull\(live\)/, 'the same rAF tick re-decides the anchors and the top edge（2026-10-12 P1 加入 programmaticScroll 静默窗：窗内的帧不许重上膛，改记 pendingFollowFrame）')
  // The deck's own geometry: the ↑ tile sits in the upper slot and ↓ in the lower one,
  // and ↑ chases the nearest ANSWER above the fold (user, 2026-10-13: 「我的意图应该是要回到
  // AI 发的最后那段总结性的话之前…不想往上翻」 — it used to land on the reader's own question,
  // which answered "who asked", not "what was said"). The tiles were once stacked the wrong
  // way round (live report 2026-10-10) and ↑ died the moment the reader climbed past the row
  // he had been aiming at; both halves of that are still the contract here.
  assert.match(assets.zh.document, /id="scrollAnchors"[^>]*><button id="jumpPrompt"[\s\S]{0,400}id="jumpLatest"/, 'the up-jump owns the upper slot')
  assert.match(assets.zh.document, /id="jumpPrompt"[^>]*aria-label="上一条回答"/, 'and is named for the answer above, not the question above')
  assert.match(js, /function answerAnchorEl\(box\)\{const rows=[\s\S]*?for\(let index=rows\.length-1;index>=0;index-=1\)/, 'the scan walks the assistant text rows backwards from the newest')
  assert.match(js, /if\(anchorTopOf\(box,row\)<box\.scrollTop-JUMP_EDGE_PX\)return row/, 'and stops at the first one above the fold')
  assert.match(js, /function topEdgePull\(box\)\{probeMark\('sc'\);if\(box\.scrollTop>0\)\{topEdgeArmed=false;return\}if\(topEdgeArmed\)return;if\(followStream\)return;/, 'the top-edge load is edge-triggered, one page per arrival（开头是滚动时序埋点的打点；边缘触发与一次到达只取一页两条语义不变）')
  assert.match(js, /if\(box\.scrollHeight<=box\.clientHeight\+8\)return;if\(Date\.now\(\)<followReArmAllowedAt\)return;topEdgeArmed=true;/, '2026-10-14 工序1：无可滚范围与 programmaticScroll 静默窗内的钳位 scroll 不算读者甩到顶——被挡下时不消耗 latch（滑到底突然跳顶+显示「正在加载更早消息」的根）')
  assert.match(js, /if\(!activeSession\|\|!olderHasMore\|\|olderBusy\|\|olderRunBusy\)return;void loadOlder\(\)/, 'and it obeys every lock the deliberate pull obeys')
  assert.match(js, /if\(typeof settleTailStick==='function'\)settleTailStick\(box,4\)/, '2026-10-14 工序1：贴底写入后按 120ms 重钉到底——content-visibility 估算行被真渲染时 scrollHeight 继续长，浏览器不会把人带到底（进入会话/发送后没滚到底的根）')
  // 2026-10-15 m02164③ 三轮：贴底链每 120ms 给 250ms 静默窗续期，滚动监听的
  // followStream 因此永不重判 ⇒ 读者上滑被吞、下一帧又被钉回底（橡皮筋）。
  // 两处补口：链条自己有读者出口，窗口到点自己醒一次。
  assert.match(js, /if\(pinned!==undefined&&live\.scrollTop<pinned-2&&live\.scrollHeight-live\.scrollTop-live\.clientHeight>SCROLL_FOLLOW_PX\)\{if\(typeof followStream!=='undefined'\)followStream=false;[\s\S]{0,160}probeMark\('rl'\);return\}/, '2026-10-15 ③三轮：scrollTop 比上次写入值小且离底超跟随带＝读者动过手——解除 follow、记锚、打标 rl 并终止本链（内容长高只增 scrollHeight 不动 scrollTop，故该判据不误伤钳位）')
  assert.match(js, /function programmaticScroll\(\)\{followReArmAllowedAt=Date\.now\(\)\+250;if\(followReArmTimer!==null\)return;followReArmTimer=setTimeout\(\(\)=>\{followReArmTimer=null;[\s\S]{0,220}probeMark\('ra'\);followStream=isNearBottom\(live\)/, '2026-10-15 ③三轮：静默窗到点自醒并重判 follow——原注释「窗长 250ms > 最长 settle 链」只对「一条链只跑 tries 次」成立，流式 patch 每 token 帧与 settleTailStick 每 120ms 都在给自己续期；pendingFollowFrame 那面旗只在 applyHistory 里消费，纯滑动时永远躺着')
  assert.match(js, /if\(btn\.id==='jumpLatest'\)\{box\.__settleTurn=\(box\.__settleTurn\|\|0\)\+1;transcriptAnchor=null;followStream=true;/, '2026-10-15 ③三轮：点 ↓ 先夺令牌并清锚点——上一条 ↑ 的 settlePromptJump 重瞄链必须立刻作废，否则两股相反写入交替（用户「点那个上下按钮的时候也有跳动」）；锚点也要清，它记的是点 ↓ 之前那一眼的最上行')
  // 2026-10-15 m02164③ 四轮：真机 03:43:47 遥测抓到点 ↓ 被拽回顶部——latest@scrollTop=0
  // → jk +11368 到底 → bf 内容长高 → jk -11368 甩回 798 → ol 连拽三次。根因：补页只发生在
  // 读者位于顶部时（topEdgePull 的 scrollTop===0 或 ensureTranscriptFilled 的内容不足一屏），
  // 所以 fetchOlderPage 记下的 transcriptAnchor 结构性地指向「顶部第 1 行」；点 ↓ 跳到底后
  // 那条 ol 链还在飞，就把第 1 行对回盒顶＝把人拽回顶。读者跟在底部时任何锚点对位都是错的。
  assert.match(js, /function settleOlderShift\(box,anchor,tries,turn\)\{if\(!anchor\|\|tries<=0\)return;if\(turn===undefined\)\{turn=\(box\.__settleTurn\|\|0\)\+1;box\.__settleTurn=turn\}const live=\$\('messages'\);if\(!live\|\|!live\.isConnected\|\|live!==box\|\|live\.__settleTurn!==turn\)return;if\(typeof followStream!=='undefined'&&followStream\)return;/, '2026-10-15 ③四轮：补页对位链在 followStream 时直接退出——读者跟在底部时锚点对位只会把人拽走（与 settleTailStick 的读者门对称）')
  assert.match(js, /function settlePromptJump\(box,anchor,tries\)\{if\(!anchor\.isConnected\|\|tries<=0\)return;box\.__settleTurn=\(box\.__settleTurn\|\|0\)\+1;const turn=box\.__settleTurn;const step=\(node,a,left\)=>\{if\(!a\.isConnected\|\|node\.__settleTurn!==turn\)/, '2026-10-15 ③三轮：第四条延时链 settlePromptJump 也纳入 __settleTurn 互斥（此前游离在令牌外，只跑 tries 次的假设同样被它自己的 setTimeout 打破）')
  assert.match(js, /const stick=typeof followStream==='undefined'\|\|followStream;if\(stick\)\{if\(typeof programmaticScroll==='function'\)programmaticScroll\(\);box\.scrollTop=box\.scrollHeight;if\(typeof probeMark==='function'\)probeMark\('bp'\)\}/, 'patchLastStreamMessage gates the stick on followStream（花括号里是可选打点 bp，门槛语义没变；守卫是为了测试沙箱按名抽取时不 ReferenceError）')
  // 2026-10-15 ③五轮（m03791 遥测：ts 在底 → jk +1296 → bt 整段重建；latest 后 jk +7165）：
  // 流式每帧贴底只看 followStream，而该布尔可能被 programmaticScroll 的续期冻在 true——
  // 读者上滑后每吐一个 token 就被拽回底。两处画之前都先用原始几何量读者位置，离开底部
  // 就当场关掉跟随（br 打点）并让 paintMessages 走 keepAnchor。
  assert.match(js, /const near=typeof isNearBottom==='function'\?isNearBottom\(box\):true;if\(!near&&typeof followStream!=='undefined'&&followStream\)\{followStream=false;/, '2026-10-15 ③五轮：流式换帧前先量读者位置——已离开底部就关掉跟随，不再每 token 拽回底')
  assert.match(js, /if\(typeof isNearBottom==='function'&&typeof followStream!=='undefined'&&followStream&&!isNearBottom\(box\)\)\{followStream=false;/, '2026-10-15 ③五轮：整段重建那条路同样先量——否则流式全量重绘一帧就把上滑的读者拽回底（bt 现场）')
  assert.match(assets.zh.document, /id="scrollAnchors"/, 'the anchor deck ships in the document')
  assert.match(js, /anchor-fab/, 'the fab styling ships')
  assert.doesNotMatch(assets.zh.css, /\.msg-hist\{content-visibility/, '2026-10-15 m02164③ 返工：CV 声明撤了（注释里提到该词不算）——遥测实证它让 scrollHeight 在 1828↔4711↔2090 间摆动、浏览器自动滚动锚定把 scrollTop 推到 3980 再掉回 1359，这就是滑动闪烁的根')
  assert.match(assets.zh.css, /@media\(prefers-reduced-motion:reduce\)\{\.anchor-fab\{transition:none\}\.workspaces\{transition:none\}\}/, 'the fade respects reduced motion (0.4.39 shares the block with the landing glow)')
  assert.match(assets.zh.css, /\.task-row\.is-unread \.task-status::after/)
  // the stream-watermark paint sandbox extracts paintMessages WITHOUT the new
  // organs — the typeof guards are what keep that file's sandboxes alive
  assert.match(js, /if\(typeof markHistoryTail==='function'\)markHistoryTail\(messages\)/)
  assert.match(js, /if\(typeof syncScrollAnchors==='function'\)syncScrollAnchors\(\)/)
  assert.match(js, /if\(typeof followStream!=='undefined'\)followStream=true;/)
})

// ------------------------------------------- 6. the service worker's offline page

function swHarness({ failPaths = [] } = {}) {
  const listeners = {}
  const store = new Map() // cache name → Map(key → Response)
  const fetchCalls = []
  const urlOf = (req) => (typeof req === 'string' ? req : req && req.url)
  const cachesStub = {
    async open(name) {
      let bucket = store.get(name)
      if (!bucket) { bucket = new Map(); store.set(name, bucket) }
      return {
        async put(key, res) { bucket.set(urlOf(key), res) },
        async match(key) { return bucket.get(urlOf(key)) },
      }
    },
    async keys() { return [...store.keys()] },
    async delete(name) { return store.delete(name) },
  }
  const selfStub = {
    location: { origin: 'https://pocket.test' },
    addEventListener: (type, fn) => { listeners[type] = fn },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  }
  const fetchStub = async (input) => {
    const url = urlOf(input)
    fetchCalls.push(String(url))
    if (failPaths.some((pattern) => String(url).includes(pattern))) throw new TypeError('network down')
    return new Response('fresh-doc', { headers: { 'content-type': 'text/html' } })
  }
  new Function('self', 'caches', 'Response', 'fetch', 'URL', renderServiceWorker())(
    selfStub, cachesStub, Response, fetchStub, URL,
  )
  let answered = null
  const dispatch = async (request) => {
    answered = null
    let waitings = []
    await listeners.fetch({
      request,
      respondWith: (p) => { answered = p },
      waitUntil: (p) => { waitings.push(Promise.resolve(p).catch(() => {})) },
    })
    await Promise.all(waitings)
    return answered ? await answered : undefined
  }
  return {
    install: async () => { await listeners.install({ waitUntil: (p) => p }) },
    activate: async () => { await listeners.activate({ waitUntil: (p) => p }) },
    dispatch,
    fetchCalls,
    store,
  }
}

const nav = (path, mode = 'navigate') => ({ method: 'GET', mode, url: 'https://pocket.test' + path })

test('install precaches the offline page; a dead navigation to / answers with it', async () => {
  const sw = swHarness({ failPaths: ['revalidate'] })
  await sw.install()
  const bucket = sw.store.get('pocket-v3')
  assert.ok(bucket, 'install opened the cache')
  const cached = bucket.get('/__offline__')
  assert.ok(cached, 'the offline page is precached under /__offline__')
  assert.match(cached.headers.get('content-type') || '', /text\/html/)
  const body = await cached.text()
  assert.match(body, /网络不可用/)
  assert.match(body, /location\.reload\(\)/, 'the retry button reloads')
  assert.match(body, /addEventListener\("online"/, 'the promised auto-resume is wired to the online event')
  assert.doesNotMatch(body, /src="/, 'zero external resources: no src anywhere')
  assert.doesNotMatch(body, /href="/, 'and no href anywhere')

  const res = await sw.dispatch(nav('/'))
  assert.ok(res, 'the navigation was answered')
  assert.equal(res, cached, 'the offline page answered the dead navigation (same cached body)')
  assert.match(body, /DSH Pocket/)
})

test('a live navigation to / passes through and still revalidates', async () => {
  const sw = swHarness()
  await sw.install()
  const res = await sw.dispatch(nav('/'))
  assert.equal(await res.text(), 'fresh-doc', 'online: the network answer wins')
  assert.ok(sw.fetchCalls.some((url) => String(url).includes('/?revalidate=1')), 'the shell revalidation still ran')
})

test('the non-root navigate branch falls back to the offline page when no shell is cached', async () => {
  const sw = swHarness({ failPaths: ['revalidate'] })
  await sw.install()
  const res = await sw.dispatch(nav('/deep-link'))
  assert.ok(res, 'the navigation was answered')
  assert.match(await res.text(), /网络不可用/, 'no cached shell → the offline page instead of a bare 503')
})

test('the API/SSE boundary is untouched: bypassed routes never enter respondWith', async () => {
  const sw = swHarness({ failPaths: ['api'] })
  await sw.install()
  for (const path of ['/api/status', '/api/session/stream?sessionId=s1', '/api/rpc', '/pair/verify', '/consent']) {
    const answered = await sw.dispatch(nav(path))
    assert.equal(answered, undefined, `${path} must bypass the worker entirely`)
  }
  const post = await sw.dispatch({ method: 'POST', mode: 'navigate', url: 'https://pocket.test/' })
  assert.equal(post, undefined, 'non-GET requests pass through')
})

test('the offline page copy is bilingual-tight and the SW still satisfies the older contracts', () => {
  const sw = renderServiceWorker()
  const bypassLine = sw.split('\n').find((line) => line.includes('const BYPASS='))
  assert.match(bypassLine, /\(api\|/, 'api stays bypassed (no-store boundary)')
  assert.match(bypassLine, /\|consent\|bye\)/, 'consent stays bypassed; the restart goodbye joins the list (0.4.34)')
  assert.match(sw, /const V='pocket-v3'/)
  assert.match(renderServiceWorker('9f2c1a4b7e01'), /const V='pocket-9f2c1a4b7e01'/)
  assert.doesNotMatch(sw, /nonce/)
})

// --------------------------------------------------------- 7. asset receipt

test('the shell still announces itself and the anchor deck reaches the en page too', () => {
  for (const locale of ['zh', 'en']) {
    const doc = assets[locale].document
    assert.match(doc, /id="jumpLatest"/)
    assert.match(doc, /id="jumpPrompt"/)
    assert.match(assets[locale].js, /window\.__pocketAppReady=true;?\s*$/, `${locale}: the script must still announce that it parsed`)
  }
})
