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
  return new Function(`
    const SCROLL_FOLLOW_PX=120,ANCHOR_LATEST_SCREENS=1.5,ANCHOR_LEAVE_SCREENS=1,ANCHOR_PROMPT_SCREENS=1,CV_TAIL_KEEP=8;
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

// --------------------------------------- 2. content-visibility tagging rules

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
  const body = ['readOpenedMap', 'pruneOpenedMap', 'noteSessionOpened', 'isSessionUnread']
    .map((name) => extractFunction(js, name))
    .join('\n')
  return new Function('localStorage', `
    const UNREAD_OPEN_KEY='dsh-pocket-opened-at',UNREAD_OPEN_MAX=200;
    ${body}
    return { readOpenedMap, pruneOpenedMap, noteSessionOpened, isSessionUnread }
  `)({
    getItem: (key) => (key in storage ? storage[key] : null),
    setItem: (key, value) => { storage[key] = String(value) },
  })
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
  assert.equal(isSessionUnread(row, 0, null), false, 'never opened → quiet (a restarted host must not light every row)')
  assert.equal(isSessionUnread({ ...row, running: true }, 0, null), false, 'running sessions stay quiet')
  assert.equal(isSessionUnread({ ...row, blank: true }, 0, null), false, 'blank shells have nothing to read')
  assert.equal(isSessionUnread(row, 0, 's1'), false, 'the focused session never dots itself')
  assert.equal(isSessionUnread({ sessionId: 's2' }, 0, 's1'), false, 'no updatedAt → no dot')
  assert.equal(isSessionUnread(null, 0, null), false)
  assert.equal(isSessionUnread(row, undefined, null), false, 'a missing ledger entry reads as never opened')
})

const workspaceSandbox = ({ storage = {}, activeSession = null, lastMsg = {} } = {}) => {
  const js = assets.zh.js
  const body = [
    'visibleSessions', 'blankRowVisible', 'taskState', 'taskGlyph', 'relativeTime',
    'timeFor', 'titleFor', 'renderWorkspaces', 'readOpenedMap', 'isSessionUnread',
    'readLastMessageMap', 'lastMessageAtOf', 'lastMessageTimeOf', 'sortAtOf',
    // The head notices (0.4.31): wsFlagsOf/wsFlagHtml are top-level on the page, so
    // the sandbox has to carry them exactly like the renderer it extracts.
    'wsFlagOf', 'wsFlagClass', 'wsFlagRank', 'wsFlagsOf', 'wsFlagHtml', 'sessionModelLabel',
    'normalizeSelection', 'fieldText',
  ]
    .map((name) => extractFunction(js, name))
    .join('\n')
  const host = { innerHTML: '' }
  const make = new Function(
    'workspaces', 'sessionSummaries', 'expandedWsIds', 'revealedLists', 'activeSession', 'container', 'localStorage', `
    const L=${JSON.stringify({ noWorkspaces: 'none', noTasksHint: 'hint', newChat: 'new', untitled: 'untitled', justNow: 'now', minute: 'm', hour: 'h', day: 'd', moreRows: '{n} more', wsNewDone: 'New', wsQuestion: 'Question', wsError: 'Error' })}
    const BLANK_ROW_VISIBLE_MS=${24 * 60 * 60 * 1000}
    const LIST_ROWS_MAX=${25}
    const WS_FLAGS_MAX=${2}
    const UNREAD_OPEN_KEY='dsh-pocket-opened-at',UNREAD_OPEN_MAX=200
    const LAST_MESSAGE_KEY=${JSON.stringify(js.match(/LAST_MESSAGE_KEY='([^']+)'/)[1])}
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
    new Set(),
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

test('the page wires the machine where the tests cannot reach: scroll, open, leave', () => {
  const js = assets.zh.js
  assert.match(js, /followStream=isNearBottom\(live\)/, 'the scroll handler re-decides the follow from the live band')
  assert.match(js, /activeSession=id;const summary=sessionSummaries\.find\(item=>item\.sessionId===id\);sessionBlank=summary\?\.blank\?\?true;noteSessionOpened\(id\);followStream=true;/, 'openSession stamps the ledger and re-arms the follow')
  assert.match(js, /poll=null;if\(activeSession\)noteSessionOpened\(activeSession\);/, 'leaving to the list stamps the ledger (activity seen live is read)')
  assert.match(js, /latest\.classList\.toggle\('show',state\.latest\);prompt\.classList\.toggle\('show',state\.prompt\)/, 'each anchor button is wired to its OWN state — no mutual exclusion in the DOM either')
  // Literal grew with the E anchor (0.4.18): this same rAF tick now does a FOURTH
  // thing — it records the reader's row (`transcriptAnchor=readTranscriptAnchor(live)`)
  // whenever the follow is off, so a later full re-paint can put that row back.
  // The contract this assertion carries is unchanged and still holds: all of it
  // happens in ONE tick, so the re-decision, the anchor, the scroll anchors and the
  // top-edge pull can never be spread across frames and fight each other.
  assert.match(js, /followStream=isNearBottom\(live\);if\(!followStream\)transcriptAnchor=readTranscriptAnchor\(live\);syncScrollAnchors\(\);topEdgePull\(live\)/, 'the same rAF tick re-decides the anchors and the top edge')
  // The deck's own geometry: the ↑ tile sits in the upper slot and ↓ in the lower one,
  // and ↑ chases the nearest question ABOVE the fold rather than the last question
  // (live report 2026-10-10: the tiles were stacked the wrong way round and ↑ died
  // the moment the reader climbed past the question he had been aiming at).
  assert.match(assets.zh.document, /id="scrollAnchors"[^>]*><button id="jumpPrompt"[\s\S]{0,400}id="jumpLatest"/, 'the up-jump owns the upper slot')
  assert.match(assets.zh.document, /id="jumpPrompt"[^>]*aria-label="上一条提问"/, 'and is named for the question above, not the last one')
  assert.match(js, /function userAnchorEl\(box\)\{const rows=[\s\S]*?for\(let index=rows\.length-1;index>=0;index-=1\)/, 'the scan walks the questions backwards from the newest')
  assert.match(js, /if\(anchorTopOf\(box,row\)<box\.scrollTop-JUMP_EDGE_PX\)return row/, 'and stops at the first one above the fold')
  assert.match(js, /function topEdgePull\(box\)\{probeMark\('sc'\);if\(box\.scrollTop>0\)\{topEdgeArmed=false;return\}if\(topEdgeArmed\)return;topEdgeArmed=true;/, 'the top-edge load is edge-triggered, one page per arrival（开头是滚动时序埋点的打点；边缘触发与一次到达只取一页两条语义不变）')
  assert.match(js, /if\(!activeSession\|\|!olderHasMore\|\|olderBusy\|\|olderRunBusy\)return;void loadOlder\(\)/, 'and it obeys every lock the deliberate pull obeys')
  assert.match(js, /if\(typeof followStream==='undefined'\|\|followStream\)\{box\.scrollTop=box\.scrollHeight;if\(typeof probeMark==='function'\)probeMark\('bp'\)\}/, 'patchLastStreamMessage gates the stick on followStream（花括号里是可选打点 bp，门槛语义没变；守卫是为了测试沙箱按名抽取时不 ReferenceError）')
  assert.match(assets.zh.document, /id="scrollAnchors"/, 'the anchor deck ships in the document')
  assert.match(js, /anchor-fab/, 'the fab styling ships')
  assert.match(assets.zh.css, /\.msg-hist\{content-visibility:auto;contain-intrinsic-size:auto 120px\}/)
  assert.match(assets.zh.css, /@media\(prefers-reduced-motion:reduce\)\{\.anchor-fab\{transition:none\}\}/, 'the fade respects reduced motion')
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
  assert.match(bypassLine, /\|consent\)/, 'consent stays bypassed')
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
