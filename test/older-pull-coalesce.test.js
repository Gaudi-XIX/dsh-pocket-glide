// loadOlder 增量插入 — WHITE-BOX（抽出页内真函数，对合成事件帧跑）。
//
// 现场 2026-10-24 01:01:47–01:01:53（北京，用户手机）：六秒内五次整屏重画，
// 消息条数 5→11→17→26→29，屏幕总高 3926→8253，视口 clientHeight 全程 735。
// 四次 `ol` = 四次 fetchOlderPage，因为触顶拖拽（topEdgePull）调一次 loadOlder，
// 而 loadOlder 的 while 循环每拉一页就让 fetchOlderPage 整屏重建一次 innerHTML。
// 根因是「重画了几次」，不是位置补偿算错——位移账目（jk）四条全为正号。
//
// 第 1 轮（`d290551`）：多页连拉期间由 loadOlder 独占重画，fetchOlderPage 只更数据不画；
// 循环结束在 finally 里统一画一次。真机读数：`ol` 从一次上拉 4 条降到全天 1 条，
// 用户感到「减缓了很多」，但还剩一次跳。
//
// 第 2 轮（本文件现在守的）：那一次跳来自「整屏重画后 122 ms 页面高度才定下来」——
// 重画会销毁并重建图片/代码块节点，重新布局后位置漂移，被 settleOlderShift 掰回。
// 改法是**增量插入**：只把新增的老消息插到已有第一个 `.message` 之前，已有节点一个不动
// ⇒ 不重排 ⇒ 高度在插入瞬间就是终值 ⇒ 不需要事后对位。判据失败才退回整屏重画。
//
// 判据来源：docs/HANDOFF-手机页跳跃-loadOlder连补重画-20261024.md §13（两轮都记在里面）。
//
// 两处「为什么」因为壳预算（ASSET_BUDGET_BYTES 不许抬）没能写进 lib/pages.js，只能记在这里——
// 动那两个地方之前先读它们：
//
// (1) 循环里那两个 data-layer break 必须保留。`windowEvents().length===beforeRecords`
//     的意思是「这一页一条新记录都没有 = 已经到对话开头了，不是一页可以重试的页」。
//     没有它，拉到尽头的那一次点击会一路重试，最多打 8 个请求（每页一个，
//     `pages<20` 就是上限）；读者看到的是一次点击、二十次网络往返，但只画一次。
//
// (2) 解锁必须无条件执行。画块里 `$('messages')` 取不到、`paintOlder` 抛、
//     `paintMessages` 抛、`readTranscriptAnchor` 抛——任何一处抛错，排在它后面的
//     `olderRunBusy=false` 就不会执行，锁被永久钉在 true：『更早的消息』整行与之后
//     每一次拉页，在本次访问里全部失效。所以 loadOlder 的 finally 里，画块自己再包一层
//     try，解锁放进第二个 finally，本文件第 1 个测试守这条。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

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

function between(source, from, to) {
  const start = source.indexOf(from)
  assert.notEqual(start, -1, `${from} must exist in the rendered asset`)
  const end = source.indexOf(to, start)
  assert.notEqual(end, -1, `${to} must follow ${from}`)
  return source.slice(start, end)
}

// 真 loadOlder + 真 fetchOlderPage + 真 olderKey/paintOlder 同场，rpc 永远再给一页
// （只给 assistant 记录，于是 olderUserCount() 不增长，循环能一直拉到 pages<20 的上限）。
// `paints` 记整屏重画次数、`inserts` 记增量插入次数——现场那四次 ol 换来的就是 paints 的长度。
const HARNESS = `
  let olderBusy=false,olderRunBusy=false,olderHasMore=true,olderExhausted=false
  let activeSession='s1',subagentView=null,skipAnchorOnce=false,transcriptAnchor=null
  let seq=9
  let olderEvents=[{event:{seq:9,type:'assistant',role:'assistant',_seq:9,text:'already painted'}}]
  const paints=[],inserts=[],probes=[]
  const rows=[{insertAdjacentHTML(pos,html){inserts.push(pos+'|'+html)}}]
  const box={scrollHeight:4000,clientHeight:735,scrollTop:0,querySelectorAll(){return rows}}
  const $=()=>box
  function eventSeq(e){return e.event.seq}
  function windowEvents(){return olderEvents}
  function visibleMessages(events){return events.map(e=>e.event)}
  function messagesWithOptimistic(list){return list}
  function transcriptHasContent(){return olderEvents.length>0}
  function olderUserCount(){return visibleMessages(windowEvents()).filter(m=>m.role==='user').length}
  function oldestEventSeq(){return -1}
  function mergeEntries(list){return list}
  function renderOlderButton(){}
  function showError(){}
  function programmaticScroll(){}
  function readTranscriptAnchor(){return null}
  function settleOlderShift(){}
  function ensureTranscriptFilled(){}
  function renderMessage(m){return '<i>'+m._seq+'</i>'}
  function markHistoryTail(){}
  function bindOpenState(){}
  function paintProbe(){}
  function probeMark(tag){probes.push(tag)}
  function paintMessages(){paints.push(box.scrollHeight)}
  function rpc(method,payload){
    seq-=1
    return Promise.resolve({events:[{event:{seq,type:'assistant',role:'assistant',_seq:seq,text:'older'}}],hasMore:true})
  }
`

function buildSandbox() {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const fetchPage = 'async ' + extractFunction(js, 'fetchOlderPage')
  const pull = 'async ' + extractFunction(js, 'loadOlder')
  const keyFn = extractFunction(js, 'olderKey')
  const paintFn = extractFunction(js, 'paintOlder')
  return new Function(`
    ${HARNESS}
    ${fetchPage}
    ${keyFn}
    ${paintFn}
    ${pull}
    return { pull: loadOlder, page: fetchOlderPage, paints, inserts, probes, state: () => ({ olderHasMore, olderEvents }) }
  `)()
}

// 画前 DOM 为空（首屏还没画）时 paintOlder 必须拒绝，调用方退回整屏重画。
function buildNoRowsSandbox(paintThrows) {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const fetchPage = 'async ' + extractFunction(js, 'fetchOlderPage')
  const pull = 'async ' + extractFunction(js, 'loadOlder')
  const keyFn = extractFunction(js, 'olderKey')
  const paintFn = extractFunction(js, 'paintOlder')
  return new Function(`
    ${HARNESS}
    rows.length=0
    ${paintThrows ? "paintMessages=()=>{throw new Error('paint blew up')}" : ''}
    ${fetchPage}
    ${keyFn}
    ${paintFn}
    ${pull}
    return { pull: loadOlder, paints, inserts, state: () => ({ olderRunBusy, olderEvents }) }
  `)()
}

test('a throw while repainting still releases the run lock', async () => {
  const sandbox = buildNoRowsSandbox(true)
  const result = await sandbox.pull()

  assert.equal(result, true, 'the pages that landed are still reported')
  assert.equal(
    sandbox.state().olderRunBusy,
    false,
    'a throw in the coalesced repaint must not leave olderRunBusy pinned — ' +
      'a pinned lock disables the older row and every later pull for the rest of the visit'
  )
})

test('the multi-page pull inserts the new messages once and never rebuilds the transcript', async () => {
  const sandbox = buildSandbox()
  const result = await sandbox.pull()

  assert.equal(result, true, 'the pull reports that pages landed')
  assert.equal(
    sandbox.state().olderEvents.length,
    21,
    'and it really was a multi-page pull — otherwise this test proves nothing'
  )
  assert.equal(
    sandbox.paints.length,
    0,
    'the incremental path must not rebuild the transcript at all — ' +
      'every innerHTML swap destroys and recreates the nodes above it, and the relocated layout ' +
      'is what the reader saw as a jump 122 ms after the paint'
  )
  assert.equal(sandbox.inserts.length, 1, 'the 8 new older messages land in a single insert')
  assert.match(sandbox.inserts[0], /^beforebegin\|/, 'and they go in front of the first already-painted message')
  assert.equal(
    sandbox.probes.filter((tag) => tag === 'ol').length,
    0,
    'and it stays silent about ol: that mark means a settle chain moved the box, so an insert that ' +
      'never touches scrollTop must not fake it — "pt yes, ol no" is exactly how a field log proves this path ran'
  )
})

test('when the insert declines, the pull falls back to one full repaint', async () => {
  const sandbox = buildNoRowsSandbox(false)
  await sandbox.pull()
  assert.equal(sandbox.inserts.length, 0, 'nothing to insert into')
  assert.equal(sandbox.paints.length, 1, 'so the pull repaints once — the new page must not stay invisible')
})

test('a single page fetched outside the pull still repaints itself', async () => {
  const sandbox = buildSandbox()
  const result = await sandbox.page()

  assert.equal(result, true, 'the page lands')
  assert.equal(
    sandbox.paints.length,
    1,
    'nobody is holding the run lock here (the automatic fill path fetches this way), ' +
      'so suppressing the repaint would leave the new page invisible'
  )
})

test('the incremental insert happens before the run lock is released', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const pull = between(js, 'async function loadOlder()', 'function syncTurnStatus()')
  const insert = pull.indexOf('paintOlder(added,box,next)')
  assert.notEqual(insert, -1, 'the pull owns the incremental insert')
  assert.ok(
    insert < pull.indexOf('olderRunBusy=false'),
    'and it lands while the lock is still held — after the release, a nested fill could repaint over it'
  )
  assert.ok(pull.indexOf('finally{') < insert, 'the insert belongs to the finally, so a throw inside the loop still draws what landed')

  const fallback = pull.indexOf('if(!paintOlder(added,box,next)){skipAnchorOnce=true;paintMessages(next,false)')
  assert.notEqual(fallback, -1, 'a declined insert must still fall back to a full repaint')

  const page = between(js, 'async function fetchOlderPage()', 'async function loadOlder()')
  const guard = page.indexOf('!olderRunBusy')
  assert.notEqual(guard, -1, 'the page fetch consults the run lock before drawing')
  assert.ok(
    guard < page.indexOf('paintMessages(messages,false)'),
    'and the consultation comes first: the per-page paint must sit inside that branch'
  )

  // 顺序即正确性：先画后标。反过来 markHistoryTail 会把新插入的早期行标成 msg-hist，
  // 那些行随即落进 content-visibility 的 56px 估算，真实高度一到就又挪一次 —— 增量插入
  // 的全部收益当场作废。这条断言是那个顺序的唯一见证。
  const paintOlder = extractFunction(js, 'paintOlder')
  assert.ok(
    paintOlder.indexOf('insertAdjacentHTML') < paintOlder.indexOf('markHistoryTail'),
    'the insert renders before markHistoryTail, so new rows keep real heights instead of the CV estimate'
  )
})
