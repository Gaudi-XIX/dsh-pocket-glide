// loadOlder 合并重画 — WHITE-BOX（抽出页内真函数，对合成事件帧跑）。
//
// 现场 2026-10-24 01:01:47–01:01:53（北京，用户手机）：六秒内五次整屏重画，
// 消息条数 5→11→17→26→29，屏幕总高 3926→8253，视口 clientHeight 全程 735。
// 四次 `ol` = 四次 fetchOlderPage，因为触顶拖拽（topEdgePull）调一次 loadOlder，
// 而 loadOlder 的 while 循环每拉一页就让 fetchOlderPage 整屏重建一次 innerHTML。
// 根因是「重画了几次」，不是位置补偿算错——位移账目（jk）四条全为正号。
//
// 改法：多页连拉期间由 loadOlder 独占重画（它在循环全程持 olderRunBusy），
// fetchOlderPage 只更数据不画；循环结束在 finally 里统一画一次。
// 单页路径（ensureTranscriptFilled 的补拉、以及任何直接调用）不受影响，
// 它进去时没人持锁，照样自己画——这条是本文件第二个测试守的东西，
// 防止「为了让连拉不闪，把单页该画的那一次也一起吞掉」。
//
// 判据来源：docs/HANDOFF-手机页跳跃-loadOlder连补重画-20261024.md（只诊断、零改动）。
//
// 两处「为什么」因为壳预算（zh 余量仅 19 B，`ASSET_BUDGET_BYTES` 不许抬）没能写进
// lib/pages.js，只能记在这里——动那两个地方之前先读它们：
//
// (1) 循环里那两个 data-layer break 必须保留。`windowEvents().length===beforeRecords`
//     的意思是「这一页一条新记录都没有 = 已经到对话开头了，不是一页可以重试的页」。
//     没有它，拉到尽头的那一次点击会一路重试，最多打 8 个请求（每页一个，
//     `pages<8` 就是上限）；读者看到的是一次点击、八次网络往返。
//
// (2) 解锁必须无条件执行。画块里 `$('messages')` 取不到、`paintMessages` 抛、
//     `readTranscriptAnchor` 抛——任何一处抛错，排在它后面的 `olderRunBusy=false`
//     就不会执行，锁被永久钉在 true：『更早的消息』整行与之后每一次拉页，在本次
//     访问里全部失效。所以 loadOlder 的 finally 里，画块自己再包一层 try，
//     解锁放进第二个 finally，本文件第 4 个测试守这条。

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

// 真 loadOlder + 真 fetchOlderPage 同场，rpc 永远再给一页（只给 assistant 记录，
// 于是 olderUserCount() 不增长，循环能一直拉到 pages<8 的上限）。
// paints 记的就是「整屏重画了几次」——现场那四次 ol 换来的就是这个数组的长度。
const HARNESS = `
  let olderBusy=false,olderRunBusy=false,olderHasMore=true,olderExhausted=false
  let activeSession='s1',subagentView=null,skipAnchorOnce=false,transcriptAnchor=null
  let olderEvents=[],seq=100
  const paints=[]
  const box={scrollHeight:4000,clientHeight:735,scrollTop:0}
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
  function paintMessages(){paints.push(box.scrollHeight)}
  function rpc(method,payload){
    seq-=1
    return Promise.resolve({events:[{event:{seq,type:'assistant',text:'older'}}],hasMore:true})
  }
`

function buildCoalesceSandbox() {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const fetchPage = 'async ' + extractFunction(js, 'fetchOlderPage')
  const pull = 'async ' + extractFunction(js, 'loadOlder')
  return new Function(`
    ${HARNESS}
    ${fetchPage}
    ${pull}
    return { pull: loadOlder, page: fetchOlderPage, paints, state: () => ({ olderHasMore, olderEvents }) }
  `)()
}

function buildThrowOnPaintSandbox() {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const fetchPage = 'async ' + extractFunction(js, 'fetchOlderPage')
  const pull = 'async ' + extractFunction(js, 'loadOlder')
  return new Function(`
    ${HARNESS}
    paintMessages=()=>{throw new Error('paint blew up')}
    ${fetchPage}
    ${pull}
    return { pull: loadOlder, state: () => ({ olderRunBusy, olderEvents }) }
  `)()
}

test('a throw while repainting still releases the run lock', async () => {
  const sandbox = buildThrowOnPaintSandbox()
  const result = await sandbox.pull()

  assert.equal(result, true, 'the pages that landed are still reported')
  assert.equal(
    sandbox.state().olderRunBusy,
    false,
    'a throw in the coalesced repaint must not leave olderRunBusy pinned — ' +
      'a pinned lock disables the older row and every later pull for the rest of the visit'
  )
})

test('the multi-page pull repaints the transcript once, not once per page', async () => {
  const sandbox = buildCoalesceSandbox()
  const result = await sandbox.pull()

  assert.equal(result, true, 'the pull reports that pages landed')
  assert.equal(sandbox.state().olderEvents.length, 8, 'and it really was a multi-page pull — otherwise this test proves nothing')
  assert.equal(
    sandbox.paints.length,
    1,
    `a drag that pulls 8 pages must rebuild the transcript once, not ${sandbox.paints.length} times — ` +
      'each rebuild is a full innerHTML swap, which is what the reader saw as five jumps in six seconds'
  )
})

test('a single page fetched outside the pull still repaints itself', async () => {
  const sandbox = buildCoalesceSandbox()
  const result = await sandbox.page()

  assert.equal(result, true, 'the page lands')
  assert.equal(
    sandbox.paints.length,
    1,
    'nobody is holding the run lock here (the automatic fill path fetches this way), ' +
      'so suppressing the repaint would leave the new page invisible'
  )
})

test('the coalesced repaint happens before the run lock is released', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const pull = between(js, 'async function loadOlder()', 'function syncTurnStatus()')
  const repaint = pull.indexOf('paintMessages(messagesWithOptimistic(visibleMessages(windowEvents())),false)')
  assert.notEqual(repaint, -1, 'the pull owns the single repaint')
  assert.ok(
    repaint < pull.indexOf('olderRunBusy=false'),
    'and it lands while the lock is still held — after the release, a nested fill could repaint over it'
  )
  assert.ok(pull.indexOf('finally{') < repaint, 'the repaint belongs to the finally, so a throw inside the loop still draws what landed')

  const page = between(js, 'async function fetchOlderPage()', 'async function loadOlder()')
  const guard = page.indexOf('!olderRunBusy')
  assert.notEqual(guard, -1, 'the page fetch consults the run lock before drawing')
  assert.ok(
    guard < page.indexOf('paintMessages(messages,false)'),
    'and the consultation comes first: the per-page paint must sit inside that branch'
  )
})
