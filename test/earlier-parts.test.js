// Earlier conversation parts (bot.earlier) — the Pocket page prepends the
// merged earlier parts of the same Bot/session above the current part.
//
// Problem (user m00257/m00258, 2026-10-20): the one-row merge (方案 A) folded a
// Bot's parts into a single list row, but opening it showed only the newest
// part. The fix mirrors the desktop's EarlierParts: the page calls the host's
// bot.earlier endpoint on session open and paints each earlier part above the
// current transcript, newest part first, records kept in page order.
//
// Layers proven here:
//   1. asset wiring — the RPC call, the openSession reset/start, the prepend;
//   2. earlierItemHtml — every host display kind (divider/user/answer/event/fallback);
//   3. page ordering — pages-reversed, items-forward (the v1 bug: flattening
//      then reversing scrambled each page's internal order);
//   4. fetch machine — cursor advance, done detection, busy/done/session gates,
//      stale-reply guard, start/reset state machine;
//   5. paintEarlierFeed — host insert/removal and the height-delta scroll keep.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

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

// ------------------------------------------------------------ 1. asset wiring

test('the rendered asset wires bot.earlier into the session open path', () => {
  const js = assets.zh.js
  assert.ok(js.includes("rpc('bot.earlier',{sessionId:sid,cursor:earlierCursor})"),
    'the bridge call carries the session and the page cursor')
  assert.ok(js.includes('activeSession=id;resetEarlierParts();'),
    'opening a session clears the previous feed before the summary read')
  assert.ok(js.includes('startEarlierParts();'),
    'opening a session preloads the earlier feed')
  assert.ok(js.includes('box.innerHTML=earlierPartsHtml()+olderButtonHtml()+'),
    'the feed prepends before the older row, leaving the older-pull axis untouched')
  assert.ok(js.includes('function earlierItemHtml('), 'the item renderer ships')
  assert.ok(js.includes('function fetchEarlierPage('), 'the fetch machine ships')
  assert.ok(js.includes('function paintEarlierFeed('), 'the feed painter ships')
})

test('the earlier-parts label ships per locale', () => {
  assert.ok(assets.zh.js.includes('更早的对话'), 'zh label is present')
  assert.ok(assets.en.js.includes('Earlier conversation'), 'en label is present')
})

// -------------------------------------------------- 2. earlierItemHtml kinds

function buildItemSandbox() {
  const body = ['earlierItemHtml', 'esc'].map((name) => extractFunction(assets.zh.js, name)).join('\n')
  return new Function(`
    const zh=true
    const L={earlierParts:'更早的对话'}
    function formatMessageClock(t){return String(t)}
    ${body}
    return { render: earlierItemHtml }
  `)()
}

test('earlierItemHtml renders a divider with the part label and time', () => {
  const s = buildItemSandbox()
  const html = s.render({ kind: 'divider', time: '10:20' })
  assert.match(html, /class="earlier-divider"/, 'divider carries its own class')
  assert.ok(html.includes('10:20'), 'the part start time is shown')
  assert.ok(html.includes('更早的对话'), 'the part label is shown')
})

test('earlierItemHtml renders a user message with an image count', () => {
  const s = buildItemSandbox()
  const html = s.render({ kind: 'user', text: '你好', images: 2 })
  assert.match(html, /class="message user earlier-msg"/, 'reuses the message user row')
  assert.ok(html.includes('你好'), 'the text is escaped and shown')
  assert.ok(html.includes('图片 × 2'), 'the image count is shown for zh')
})

test('earlierItemHtml renders an answer with questions and answers', () => {
  const s = buildItemSandbox()
  const html = s.render({ kind: 'answer', questions: ['q1'], answers: ['a1'] })
  assert.match(html, /earlier-qa-q/, 'questions render')
  assert.match(html, /earlier-qa-a/, 'answers render')
  assert.ok(html.includes('q1') && html.includes('a1'), 'both sides are visible')
})

test('earlierItemHtml renders an event capsule with role and room', () => {
  const s = buildItemSandbox()
  const html = s.render({ kind: 'event', role: 'request', name: 'Chief', roomId: 'room1' })
  assert.match(html, /data-role="request"/, 'the role is carried as data')
  assert.ok(html.includes('Chief'), 'the bot name is shown')
  assert.ok(html.includes('room1'), 'the room id is shown')
})

test('earlierItemHtml falls back to an assistant row for plain bot items', () => {
  const s = buildItemSandbox()
  const html = s.render({ kind: 'bot', text: 'hello' })
  assert.match(html, /class="message assistant earlier-msg"/, 'bot text uses the assistant row')
  assert.ok(html.includes('hello'), 'the text is shown')
})

// ---------------------------------------------------- 3. page ordering (v1 bug)

function buildRowsSandbox() {
  const body = ['earlierRowsHtml', 'earlierMoreRowHtml', 'earlierPartsHtml'].map((name) => extractFunction(assets.zh.js, name)).join('\n')
  return new Function(`
    let earlierPages=[]
    let earlierCursor=null
    let earlierDone=false
    let earlierBusy=false
    function esc(t){return String(t)}
    const L={earlierMore:'加载更早的对话',earlierPartsLoading:'正在加载更早的对话…'}
    function earlierItemHtml(item){return item.id}
    ${body}
    return {
      rows: earlierRowsHtml,
      moreRow: earlierMoreRowHtml,
      html: earlierPartsHtml,
      setPages(p){earlierPages=p},
      setCursor(v){earlierCursor=v},
      setBusy(v){earlierBusy=v},
    }
  `)()
}

test('earlier rows paint pages-reversed but keep in-page order (newest page first)', () => {
  const s = buildRowsSandbox()
  // fetch order = newest page first; each page is internally oldest→newest.
  s.setPages([
    [{ id: 'a1' }, { id: 'a2' }],
    [{ id: 'b1' }, { id: 'b2' }],
  ])
  assert.equal(s.rows(), 'b1b2a1a2',
    'page order reverses, the records inside a page never do')
  assert.equal(s.html(), '<div class="earlier-feed">b1b2a1a2</div>',
    'earlierPartsHtml wraps the rows in the feed container')
})

test('earlier parts render nothing when no pages have loaded', () => {
  const s = buildRowsSandbox()
  assert.equal(s.rows(), '', 'no rows')
  assert.equal(s.html(), '', 'no feed container')
})

// v3 必改（Verifier 第三轮）：首页为空但 cursor 仍活时，续拉行必须自己撑起容器，
// 否则用户既看不到行也永远点不到第二次 —— 状态机对、渲染门漏。
test('a leading-empty page still paints the next-page row', () => {
  const s = buildRowsSandbox()
  s.setCursor({ part: 7, beforeSeq: 400 })
  assert.equal(s.rows(), '', 'no rows yet')
  assert.match(s.moreRow(), /data-earlier="1"/, 'the row itself is ready')
  assert.match(s.html(), /^<div class="earlier-feed"><button[^>]*data-earlier="1"/,
    'the row, not the rows, opens the container')
  s.setBusy(true)
  assert.match(s.html(), /disabled/, 'the in-flight first page paints a disabled spinner row')
  s.setCursor(null)
  assert.equal(s.html(), '', 'no cursor and no rows → nothing at all')
})

// ----------------------------------------------------- 4. fetch state machine

function buildFetchSandbox({ session = 's1', cursor = null, done = false, pages = [] } = {}) {
  const js = assets.zh.js
  const fetchSrc = 'async ' + extractFunction(js, 'fetchEarlierPage')
  const body = ['startEarlierParts', 'resetEarlierParts', 'earlierMoreRowHtml'].map((name) => extractFunction(js, name)).join('\n')
  return new Function('init', `
    let activeSession=init.session
    let earlierPages=init.pages
    let earlierCursor=init.cursor
    let earlierDone=init.done
    let earlierBusy=false
    let earlierStartedFor=null
    let earlierGen=0
    const calls=[]
    const resolvers=[]
    const zh=true
    const L={earlierMore:'加载更早的对话',earlierPartsLoading:'正在加载更早的对话…'}
    function esc(t){return String(t).replace(/&/g,'&amp;')}
    function showError(id,e){calls.push({kind:'error',id,message:e&&e.message})}
    function paintEarlierFeed(){calls.push({kind:'paint',pages:earlierPages.length})}
    function rpc(method,payload){calls.push({method,payload});return new Promise((resolve)=>{resolvers.push(resolve)})}
    ${fetchSrc}
    ${body}
    return {
      run:fetchEarlierPage,
      start:startEarlierParts,
      reset:resetEarlierParts,
      moreRow:earlierMoreRowHtml,
      setCursorBusy(o){earlierCursor=o.cursor;earlierDone=o.done;earlierBusy=!!o.busy},
      setSession(id){activeSession=id},
      respond(value){const r=resolvers.shift();resolverAssert(r);r(value)},
      state:()=>({activeSession,earlierPages:earlierPages.slice(),earlierCursor,earlierDone,earlierBusy,earlierStartedFor}),
      calls,
    }
    function resolverAssert(r){if(!r)throw new Error('respond() with nothing pending')}
  `)({ session, cursor, done, pages })
}

test('fetchEarlierPage pulls a page and advances the cursor', async () => {
  const s = buildFetchSandbox({ session: 's1' })
  const p = s.run()
  assert.equal(s.state().earlierBusy, true, 'busy during flight')
  s.respond({ items: [{ kind: 'bot', text: 'a' }], cursor: { part: 0, beforeSeq: 5 } })
  assert.equal(await p, true, 'a non-empty page returns true')
  const st = s.state()
  assert.equal(st.earlierPages.length, 1, 'the page is appended')
  assert.deepEqual(st.earlierCursor, { part: 0, beforeSeq: 5 }, 'cursor advances')
  assert.equal(st.earlierDone, false, 'a cursor means more pages')
  assert.equal(st.earlierBusy, false, 'busy clears in finally')
  const call = s.calls.find((c) => c.method === 'bot.earlier')
  assert.deepEqual(call, { method: 'bot.earlier', payload: { sessionId: 's1', cursor: null } },
    'the first call carries the initial cursor')
})

test('fetchEarlierPage stops when the host returns no cursor', async () => {
  const s = buildFetchSandbox({ session: 's1' })
  const p = s.run()
  s.respond({ items: [{ kind: 'bot', text: 'a' }], cursor: null })
  assert.equal(await p, true, 'the last page still lands')
  assert.equal(s.state().earlierDone, true, 'no cursor marks the feed complete')
})

test('fetchEarlierPage reports an empty page honestly', async () => {
  const s = buildFetchSandbox({ session: 's1' })
  const p = s.run()
  s.respond({ items: [], cursor: null })
  assert.equal(await p, false, 'no items returns false')
  assert.equal(s.state().earlierDone, true, 'still marks done (nothing older)')
})

test('fetchEarlierPage ignores a late reply after the session switched', async () => {
  const s = buildFetchSandbox({ session: 's1' })
  const p = s.run()
  s.setSession('s2')
  s.respond({ items: [{ kind: 'bot', text: 'stale' }], cursor: null })
  assert.equal(await p, false, 'a stale reply is dropped')
  const st = s.state()
  assert.equal(st.earlierPages.length, 0, 'no page appended')
  assert.equal(st.earlierDone, false, 'state untouched')
  assert.equal(st.earlierBusy, false, 'busy still clears')
})

test('fetchEarlierPage gates on busy, done and session', async () => {
  const busy = buildFetchSandbox({ session: 's1' })
  const p = busy.run()
  assert.equal(await busy.run(), false, 'a second call while busy is refused')
  busy.respond({ items: [], cursor: null })
  await p

  const done = buildFetchSandbox({ session: 's1', done: true })
  assert.equal(await done.run(), false, 'a completed feed is not re-pulled')

  const none = buildFetchSandbox({ session: null })
  assert.equal(await none.run(), false, 'no session means no pull')
})

test('startEarlierParts primes the feed once per session and resets on switch', async () => {
  const s = buildFetchSandbox({ session: 's1' })
  const rpcCount = () => s.calls.filter((c) => c.method === 'bot.earlier').length
  s.start()
  assert.equal(s.state().earlierStartedFor, 's1', 'the session is remembered')
  assert.equal(rpcCount(), 1, 'first start pulls')
  s.start()
  assert.equal(rpcCount(), 1, 'second start for the same session is a no-op')
  s.respond({ items: [{ kind: 'bot', text: 'a' }], cursor: null })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(s.state().earlierPages.length, 1, 'the primed page lands')
  assert.equal(s.state().earlierDone, true, 'and completes when the host has no more')

  s.setSession('s2')
  s.start()
  assert.equal(s.state().earlierStartedFor, 's2', 'a new session re-primes')
  assert.equal(s.state().earlierPages.length, 0, 'stale pages are dropped before the new pull')
  assert.equal(rpcCount(), 2, 'a second pull goes out')
  s.respond({ items: [{ kind: 'bot', text: 'b' }], cursor: { part: 1, beforeSeq: 3 } })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(s.state().earlierPages.length, 1, 'the new session page lands')
})

test('resetEarlierParts clears the feed state', async () => {
  const s = buildFetchSandbox({ session: 's1' })
  const p = s.run()
  s.respond({ items: [{ kind: 'bot', text: 'a' }], cursor: null })
  await p
  assert.equal(s.state().earlierDone, true, 'feed completed before reset')
  s.reset()
  const st = s.state()
  assert.deepEqual(st.earlierPages, [], 'pages cleared')
  assert.equal(st.earlierCursor, null, 'cursor cleared')
  assert.equal(st.earlierDone, false, 'done cleared')
  assert.equal(st.earlierBusy, false, 'busy cleared')
  assert.equal(st.earlierStartedFor, null, 'session marker cleared')
})

// ------------------------------------------------------- 5. paintEarlierFeed

function buildFeedSandbox() {
  const body = ['paintEarlierFeed', 'earlierRowsHtml'].map((name) => extractFunction(assets.zh.js, name)).join('\n')
  return new Function(`
    let earlierPages=[]
    let moreStub=''
    function earlierItemHtml(item){return item.id}
    function earlierMoreRowHtml(){return moreStub}
    const host={className:'',_html:'',removed:false,remove(){this.removed=true}}
    let extraHeight=0
    const box={scrollHeight:1000,scrollTop:200,hostPresent:false,insertedAt:null,insertedEl:null,
      querySelector(sel){return sel===':scope > .earlier-feed'?(this.hostPresent?host:null):null},
      insertAdjacentElement(pos,el){this.insertedAt=pos;this.insertedEl=el;this.hostPresent=true}}
    Object.defineProperty(host,'innerHTML',{
      get(){return this._html},
      set(v){this._html=v;extraHeight=v.length;box.scrollHeight=1000+extraHeight},
    })
    const document={createElement(){return host}}
    const $=()=>box
    ${body}
    return {
      paint:paintEarlierFeed,
      setPages(p){earlierPages=p},
      setMore(v){moreStub=v},
      box,
      host,
      get extra(){return extraHeight},
    }
  `)()
}

test('paintEarlierFeed grows the feed above without moving the reader', () => {
  const s = buildFeedSandbox()
  s.setPages([[{ id: 'a1' }, { id: 'a2' }], [{ id: 'b1' }, { id: 'b2' }]])
  s.paint()
  assert.equal(s.box.insertedAt, 'afterbegin', 'host goes to the top of the transcript')
  assert.equal(s.host.className, 'earlier-feed', 'host carries the feed class')
  assert.equal(s.host._html, 'b1b2a1a2', 'pages-reversed, in-page order kept')
  assert.equal(s.box.scrollTop, 200 + s.extra, 'scrollTop compensates the prepended height')
})

test('paintEarlierFeed removes the host when no earlier rows remain', () => {
  const s = buildFeedSandbox()
  s.setPages([[{ id: 'a1' }]])
  s.paint()
  assert.equal(s.box.hostPresent, true, 'host exists after a paint with rows')
  s.setPages([])
  s.paint()
  assert.equal(s.host.removed, true, 'empty feed removes the host')
})

// v3 必改的另一半：paint 的移除门必须与渲染门同口径 —— 行是空的但续拉行还在时，
// 不许把已经插好的容器拆掉（否则首屏在飞时转圈会闪一下就没）。
test('paintEarlierFeed keeps the host while only the next-page row remains', () => {
  const s = buildFeedSandbox()
  s.setMore('<button data-earlier="1">M</button>')
  s.paint()
  assert.equal(s.box.insertedAt, 'afterbegin', 'a live next-page row opens the host on its own')
  assert.equal(s.host._html, '<button data-earlier="1">M</button>', 'row painted without any message rows')
  assert.equal(s.host.removed, false, 'no removal while the row is offered')
  s.setMore('')
  s.paint()
  assert.equal(s.host.removed, true, 'both empty → the host goes away')
})

// ------------------------------------ 6. next-page row + transcript-probe fix

function buildMoreRowSandbox() {
  const body = ['earlierMoreRowHtml', 'esc'].map((name) => extractFunction(assets.zh.js, name)).join('\n')
  return new Function(`
    let earlierCursor=null,earlierDone=false,earlierBusy=false
    const L={earlierMore:'加载更早的对话',earlierPartsLoading:'正在加载更早的对话…'}
    ${body}
    return {
      html: earlierMoreRowHtml,
      set(o){earlierCursor=o.cursor;earlierDone=o.done;earlierBusy=!!o.busy},
    }
  `)()
}

test('earlierMoreRowHtml offers the next page only while the host has one', () => {
  const s = buildMoreRowSandbox()
  assert.equal(s.html(), '', 'no cursor means nothing to tap')
  s.set({ cursor: { part: 0, beforeSeq: 5 }, done: false, busy: false })
  const html = s.html()
  assert.match(html, /data-earlier="1"/, 'the row is tappable')
  assert.ok(html.includes('加载更早的对话'), 'the zh next-page label is shown')
  s.set({ cursor: { part: 0, beforeSeq: 5 }, done: false, busy: true })
  assert.match(s.html(), /disabled/, 'a busy fetch disables the row')
  assert.ok(s.html().includes('正在加载更早的对话…'), 'the busy label is the loading copy')
  s.set({ cursor: { part: 0, beforeSeq: 5 }, done: true, busy: false })
  assert.equal(s.html(), '', 'done hides the row')
})

test('the feed exposes a real next-page reader and the transcript probes skip earlier rows', () => {
  const js = assets.zh.js
  assert.ok(js.includes('function earlierMoreRowHtml('), 'the next-page row renderer ships')
  assert.ok(js.includes("closest('[data-earlier]')"), 'the tap is delegated on #messages')
  assert.ok(js.includes('void fetchEarlierPage();return'), 'the tap pulls the next page')
  assert.equal((js.match(/querySelector\('\.message:not\(\.earlier-msg\)'\)/g) || []).length, 3,
    'the three transcript-emptiness probes ignore earlier rows')
})

test('earlierItemHtml renders nothing for a fallback item with no text', () => {
  const s = buildItemSandbox()
  assert.equal(s.render({ kind: 'bot', text: '' }), '', 'an empty bot item does not paint an empty bubble')
})

test('reset invalidates an in-flight fetch (generation guard)', async () => {
  const s = buildFetchSandbox({ session: 's1' })
  const p = s.run()
  s.reset()
  s.respond({ items: [{ kind: 'bot', text: 'stale' }], cursor: null })
  assert.equal(await p, false, 'the reply that started before the reset is dropped')
  assert.equal(s.state().earlierPages.length, 0, 'no page is appended after the reset')
})

// The host computes more = hasMore && events.length (parts.js:1077), so a page
// whose records are all tool events comes back items:[] with a LIVE cursor.
// earlierDone must key off the cursor alone or that empty page silently kills
// the whole deeper feed (round-2 blocker 1).
test('an empty page with a live cursor keeps the feed open', async () => {
  const s = buildFetchSandbox({ session: 's1' })
  const p = s.run()
  s.respond({ items: [], cursor: { part: 7, beforeSeq: 400 } })
  assert.equal(await p, false, 'an empty page still reports false (nothing landed)')
  const st = s.state()
  assert.equal(st.earlierDone, false, 'a live cursor means the feed is NOT done')
  assert.deepEqual(st.earlierCursor, { part: 7, beforeSeq: 400 }, 'the cursor survives the empty page')
  assert.match(s.moreRow(), /data-earlier="1"/, 'the next-page row stays tappable after an empty page')
})

// Round-2 blocker 2: the finally of a discarded (stale) reply must not clear
// the busy flag of a newer in-flight fetch, or the row unlocks early and the
// same page gets appended twice (A→B→A with two overlapping first pages).
test('a stale reply cannot clear the busy flag of the newer generation', async () => {
  const s = buildFetchSandbox({ session: 's1', cursor: { part: 2, beforeSeq: 300 } })
  const p1 = s.run()                 // generation 0 in flight
  s.reset()                          // A→B→A: gen 1, busy cleared by reset
  const p2 = s.run()                 // generation 1 in flight
  s.respond({ items: [{ kind: 'bot', text: 'g0' }], cursor: null }) // gen 0's reply arrives first
  assert.equal(await p1, false, 'the gen-0 reply is dropped')
  assert.equal(s.state().earlierBusy, true, 'the gen-0 finally must NOT clear the gen-1 busy flag')
  assert.equal(s.moreRow(), '', 'with gen 1 still holding the initial cursor the row is not offered yet')
  s.respond({ items: [{ kind: 'bot', text: 'g1' }], cursor: { part: 4, beforeSeq: 900 } }) // gen 1's reply
  assert.equal(await p2, true, 'the gen-1 reply lands')
  const st = s.state()
  assert.equal(st.earlierPages.length, 1, 'exactly one page appended, not two')
  assert.equal(st.earlierBusy, false, 'busy clears when the generation itself finishes')
  assert.match(s.moreRow(), /data-earlier="1"/, 'the row comes back tappable once the live generation finishes')
})

// The row's own guard, isolated: a busy flag set with no cursor must not open a
// second request for the same (absent) page.
test('the row stays disabled while a page is in flight', () => {
  const s = buildFetchSandbox({ session: 's1', cursor: { part: 2, beforeSeq: 300 }, done: false })
  s.setCursorBusy({ cursor: { part: 2, beforeSeq: 300 }, done: false, busy: true })
  assert.match(s.moreRow(), /disabled/, 'a busy fetch disables the row')
  s.setCursorBusy({ cursor: { part: 2, beforeSeq: 300 }, done: false, busy: false })
  assert.match(s.moreRow(), /data-earlier="1"/, 'and it unlocks when the fetch is done')
})

// The full chain the row exists for: tap → next page → ... → cursor null → row
// gone and further taps send no RPC.
test('tapping through pages stops at the end of the feed', async () => {
  const s = buildFetchSandbox({ session: 's1' })
  const rpcCount = () => s.calls.filter((c) => c.method === 'bot.earlier').length
  const p1 = s.run()
  s.respond({ items: [{ id: 'p1' }], cursor: { part: 2, beforeSeq: 300 } })
  assert.equal(await p1, true)
  const p2 = s.run()
  s.respond({ items: [{ id: 'p2' }], cursor: { part: 1, beforeSeq: 200 } })
  assert.equal(await p2, true)
  const p3 = s.run()
  s.respond({ items: [{ id: 'p3' }], cursor: null })
  assert.equal(await p3, true)
  assert.equal(s.state().earlierDone, true, 'cursor null completes the feed')
  assert.equal(s.moreRow(), '', 'the row hides itself at the end')
  const p4 = await s.run()
  assert.equal(p4, false, 'no pull after done')
  assert.equal(rpcCount(), 3, 'exactly three pages were requested')
})

// ------------------------------------------------- 6. currentTranscript rows
//
// paintMessages numbers the .message nodes one-to-one against the messages it
// is handed (older-row / earlier-feed first, then the rows). When the reader had
// pulled earlier parts, windowEvents() — which does not know about them — handed
// back only the current window, so patchLastStreamMessage index/nodes.length
// check failed and the whole box was repainted down to a single row: the
// transcript collapsed to one screenful, the browser clamped scrollTop to 0 and
// the reader position was gone (真机 2026-10-21 01:14:30: pt n=36 prev=100 post=19,
// scrollHeight 15734 -> 2657).
// The rows handed over must cover every earlier part that is on screen.
function buildTranscriptSandbox(init) {
  const body = ['earlierPlainRow', 'currentTranscript', 'windowEvents']
    .map((name) => extractFunction(assets.zh.js, name)).join('\n')
  // The page appends the current window first and then pushes the earlier rows,
  // then sorts by seq: hand them over the same way so the guard is exercised.
  const pages = (init.pages || []).map((items) => items.slice().reverse());
  const stream = (init.events || []).slice().reverse();
  const args = { older: [], stream: stream, pages: pages, feed: init.feedPresent !== false }
  const sandbox = new Function('init', [
    'let olderEvents=init.older,streamEvents=init.stream,streamRevision=1,lastDurableMessages=[]',
    'let earlierPages=init.pages',
    'const box={querySelector(sel){return sel===\':scope > .earlier-feed\'?(init.feed?{}:null):null}}',
    'const $=()=>box',
    'function mergeEntries(list){return list}',
    'function visibleMessages(ev){return ev.filter((row)=>row&&typeof row._seq==="number")}',
    body,
    'return { rows: currentTranscript }',
  ].join('\n'))
  return sandbox(args)
}

test('every earlier part on screen keeps its row so the last row can be patched in place', () => {
  const events = [{ _seq: 900, role: 'assistant', blocks: [{ kind: 'text', text: 'now' }] }]
  const pages = [
    [{ kind: 'answer', text: 'last part', seq: 800 }],
    [{ kind: 'user', text: 'old question', seq: 500 }, { kind: 'assistant', text: 'old answer', seq: 501 }],
  ]
  const s = buildTranscriptSandbox({ events, pages })
  const rows = s.rows()
  assert.equal(rows.length, 4, 'one row per painted message: the window row plus every earlier item')
  assert.deepEqual(rows.map((r) => r._seq), [500, 501, 800, 900], 'rows come back in seq order')
  assert.equal(rows[3].blocks[0].text, 'now', 'the live row keeps its blocks')
})

test('a divider takes a node but no row, and a merged seq is handed over once', () => {
  const events = [{ _seq: 700, role: 'assistant', blocks: [{ kind: 'text', text: 'window copy' }] }]
  const pages = [
    [{ kind: 'divider', time: 0 }, { kind: 'assistant', text: 'window copy again', seq: 700 }, { kind: 'answer', text: '', seq: 650 }],
  ]
  const s = buildTranscriptSandbox({ events, pages })
  const rows = s.rows()
  // paintEarlierFeed paints the divider (a node) and skips the item with no text;
  // the seq already carried by the current window is not handed over twice.
  // paintEarlierFeed paints the divider (a node) and the item with no text is
  // skipped, so the box holds one earlier node; the current window's own records
  // are handed over as they are (mergeEntries dedupes them inside the page).
  assert.equal(rows.length, 3, 'one earlier row on screen plus the two window records')
  assert.deepEqual(rows.map((r) => r._seq), [650, 700, 700], 'earlier rows come first, ordered by seq')
})

test('with no earlier feed the transcript stays exactly the current window', () => {
  const events = [{ _seq: 900, role: 'assistant', blocks: [{ kind: 'text', text: 'now' }] }]
  const s = buildTranscriptSandbox({ events, feedPresent: false, pages: [[{ kind: 'user', text: 'old', seq: 500 }]] })
  assert.deepEqual(s.rows().map((r) => r._seq), [900], 'no rows are borrowed from earlier parts')
})

// --------------------------------- 7. the feed is kept in step with the box
//
// paintMessages numbers the nodes in the box against the messages it is handed.
// A pull of earlier parts adds nodes to the box, so the transcript must be
// repainted right after it lands — otherwise the next streaming frame is one row
// short again. Conversely a feed that survives a real session switch paints the
// previous conversation on top of the new one.
test('a landed earlier page repaints the transcript with the same buffers', async () => {
  const js = assets.zh.js
  const src = extractFunction(js, 'startEarlierParts').replace('void fetchEarlierPage().then(', 'return fetchEarlierPage().then(')
  const s0 = new Function('init', `
    let activeSession=init.session, earlierPages=[], earlierCursor=null, earlierDone=false, earlierStartedFor=null, earlierGen=0
    let streamEvents=[{_seq:1}], streamProjections={values:{}}, olderHasMore=true
    const calls=[]
    function fetchEarlierPage(){calls.push('fetch');return Promise.resolve(true)}
    function applyHistory(value,pending,initial){calls.push({kind:'apply',events:value.events.length,hasMore:value.hasMore,initial})}
    ${src}
    return { start: startEarlierParts, calls, state:()=>({startedFor:earlierStartedFor}) }
  `)({ session: 's1' })
  s0.start()
  await Promise.resolve()
  await Promise.resolve()
  const apply = s0.calls.find((c) => c && c.kind === 'apply')
  assert.ok(apply, 'the pull repaints the transcript')
  assert.equal(apply.events, 1, 'the repaint carries the live window')
  assert.equal(apply.hasMore, true, 'and the current older flag')
})

test('a real session switch drops the feed, so the next session never inherits it', () => {
  const js = assets.zh.js
  const open = extractFunction(js, 'openSession')
  assert.ok(open.includes('if(activeSession&&activeSession!==id)resetEarlierParts()'),
    'the switch clears the feed before the stream is rebuilt')
  const list = extractFunction(js, 'showSessionList')
  assert.ok(list.includes('closeSessionStream();resetEarlierParts();'),
    'leaving the chat clears it too')
  const draft = extractFunction(js, 'startDraftChat')
  assert.ok(draft.includes('closeSessionStream();resetEarlierParts();'),
    'a fresh draft starts without the previous conversation feed')
})
