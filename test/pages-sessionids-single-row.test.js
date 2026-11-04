// P0-2 (2026-11-04): the phone asked session.list for the whole world and then
// overwrote the whole list from the answer. The ask is now narrowed to the one
// session the chat is showing: sessionIds:[activeSession] (the bridge filters
// by it, children included). The narrowed answer must not rewrite the projected
// list at all — boot and loadListData own that projection.
import test from 'node:test'
import assert from 'node:assert/strict'

import { mobilePageAssets } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })

function extractFunction(source, name) {
  const plain = source.indexOf('function ' + name + '(')
  const start = plain === -1 ? source.indexOf('async function ' + name + '(') : plain
  assert.notEqual(start, -1, `function ${name} must exist in the page source`)
  if (source.slice(start - 6, start) === 'async ') return source.slice(start - 6, sliceBody(source, start))
  return source.slice(start, sliceBody(source, start))
}

function sliceBody(source, start) {
  let i = source.indexOf('{', start)
  let depth = 0
  for (; i < source.length; i++) {
    const c = source[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i + 1 }
  }
  assert.fail('function body is never closed')
}

// One sandbox carrying the page globals the two callers read. projectSessionRows
// is a passthrough here: it is the row-shaping organ (bot parts, running marks),
// not the merge under test, and the real one drags in the bot staging chain.
function buildSandbox({ active = 's-active', items = [], summaries = [], rows = new Map() } = {}) {
  const calls = []
  const confirmed = []
  const made = new Function(
    'active',
    'items',
    'calls',
    'confirmed',
    'summaries',
    'rows',
    `
    let activeSession=active
    let sessionBlank=false
    let currentPreset=null
    let subagentView=false
    let sessionSummaries=summaries
    let subagentRowsByParent=rows
    let bars=0
    const rpc=(method,payload)=>{calls.push({method,payload});return Promise.resolve({items})}
    const projectSessionRows=(list)=>list.filter(item=>item&&item.origin!=='subagent')
    const agentPresetOf=(p)=>(p&&p.preset)||null
    const renderSubagentBar=()=>{bars++}
    const syncSettingsControls=()=>{}
    const finishTurnConfirm=(seen,busy)=>confirmed.push({seen,busy})
    ${extractFunction(js, 'splitSubagentRows')}
    ${extractFunction(js, 'refreshActiveSessionSummary')}
    ${extractFunction(js, 'confirmTurnRunning')}
    return {
      refreshActiveSessionSummary, confirmTurnRunning, calls, confirmed,
      get summaries(){return sessionSummaries},
      get rows(){return subagentRowsByParent},
      get blank(){return sessionBlank},
      get preset(){return currentPreset},
      get bars(){return bars},
    }
  `,
  )
  return made(active, items, calls, confirmed, summaries, rows)
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('B1 the active-session read asks for that session only, and no fingerprint', async () => {
  const box = buildSandbox({ items: [{ sessionId: 's-active', title: 'Chat' }] })
  await box.refreshActiveSessionSummary()
  assert.equal(box.calls.length, 1, 'one read')
  assert.equal(box.calls[0].method, 'session.list')
  assert.deepEqual(box.calls[0].payload, { sessionIds: ['s-active'] }, 'the payload names exactly the open session')
  assert.equal(box.calls[0].payload.fingerprint, undefined, 'no fingerprint on the page-side call — the bridge window owns that')
})

test('B2 the single-row answer never rewrites the projected list', async () => {
  const other = { sessionId: 's-other', title: 'Other', running: true, updatedAt: 11 }
  const stale = { sessionId: 's-active', title: 'Old', running: false }
  const fresh = { sessionId: 's-active', title: 'Fresh', running: true }
  const box = buildSandbox({ items: [fresh], summaries: [other, stale] })
  const before = JSON.stringify(box.summaries)
  await box.refreshActiveSessionSummary()
  assert.equal(JSON.stringify(box.summaries), before, 'the list keeps every row byte-identical; boot/loadListData own it')
})

test('B2 a missing active row is not inserted by this read either', async () => {
  const box = buildSandbox({ items: [{ sessionId: 's-active', title: 'Fresh' }], summaries: [{ sessionId: 's-other' }] })
  const before = JSON.stringify(box.summaries)
  await box.refreshActiveSessionSummary()
  assert.equal(JSON.stringify(box.summaries), before, 'no insert: the projected list is untouched')
})

test('B3 the turn confirm asks the same narrowed question and still reads running', async () => {
  const box = buildSandbox({ items: [{ sessionId: 's-active', running: true }, { sessionId: 's-other', running: true }] })
  box.confirmTurnRunning(1234)
  await settle()
  assert.deepEqual(box.calls[0].payload, { sessionIds: ['s-active'] }, 'same narrowing as the summary read')
  assert.deepEqual({ seen: box.confirmed[0].seen, busy: box.confirmed[0].busy }, { seen: 1234, busy: true }, 'a running active row still confirms a turn in flight')
})

test('B4 child rows of the active session still reach the bar group', async () => {
  const child = { sessionId: 'c1', origin: 'subagent', parentSessionId: 's-active', running: true }
  const box = buildSandbox({ items: [{ sessionId: 's-active' }, child], rows: new Map([['s-active', [{ sessionId: 'c-old' }]]]) })
  await box.refreshActiveSessionSummary()
  assert.ok(box.rows.get('s-active').length > 0, 'the active parent keeps a child group')
  assert.equal(box.rows.get('s-active')[0].sessionId, 'c1', 'the fresh child row replaces the stale group')
  assert.equal(box.rows.has('s-other'), false, 'a group for another parent is never created by this read')
  assert.equal(box.bars, 1, 'the bar repaints once')
})

test('the whole-list overwrite is gone from the source', () => {
  assert.doesNotMatch(js, /sessionSummaries=projectSessionRows\(value\.items\)/, 'the narrowed answer must never wholesale-replace the projection')
})
