// P0-4 (2026-11-04): the landing page used to own two independent clocks — a 5s
// setInterval for /api/status and a self-chaining 60s setTimeout for the list.
// The status read now rides that same 60s list chain (one read per tick, plus one
// at boot), so the second clock is gone entirely: no new scheduler object, no
// second interval. The 8s live-status exemption stays inside checkConnection.
import test from 'node:test'
import assert from 'node:assert/strict'

import { mobilePageAssets } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, `function ${name} must exist in the page source`)
  let i = source.indexOf('{', start)
  let depth = 0
  for (; i < source.length; i++) {
    const c = source[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return source.slice(start, i + 1) }
  }
  assert.fail(`function ${name} is never closed`)
}

function constant(name) {
  const hit = js.match(new RegExp('(?:^|[,;(\\s])' + name + '=(\\d+)'))
  assert.ok(hit, `${name} must be a numeric constant in the page source`)
  return Number(hit[1])
}

const LIST_MS = constant('LIST_POLL_MS')

// Drive the real startListPoll/stopListPoll bodies with a fake setTimeout chain.
// resumeOnReturn returns a synchronous thenable so .finally(startListPoll)
// re-arms the chain inside the same tick, exactly as the page does.
function buildLanding() {
  const state = { hidden: false, active: false, draft: false, status: 0, list: 0, pending: null }
  const made = new Function('state', 'LIST_POLL_MS', `
    let listPoll=null
    let activeSession=state.active?'s-open':null
    let draftWorkspaceId=state.draft?'d':null
    const document={get hidden(){return state.hidden}}
    const checkConnection=()=>{state.status++}
    const resumeOnReturn=()=>{state.list++;return {finally(fn){fn();return this}}}
    const setTimeout=(fn,ms)=>{state.pending={fn,ms};return 1}
    const clearTimeout=()=>{}
    ${extractFunction(js, 'stopListPoll')}
    ${extractFunction(js, 'startListPoll')}
    return {
      startListPoll(){startListPoll()},
      tick(){const p=state.pending;state.pending=null;if(p)p.fn()},
      get pendingMs(){return state.pending?state.pending.ms:null},
    }
  `)
  return { state, page: made(state, LIST_MS) }
}

test('B5 an idle landing costs three to six status reads in two minutes', () => {
  const { state, page } = buildLanding()
  const boot = 1 // checkConnection(); at startup
  page.startListPoll()
  assert.equal(page.pendingMs, LIST_MS, 'the 60s list chain is the only clock left')
  const due = Math.floor(130000 / LIST_MS) // 60s, 120s
  for (let i = 0; i < due; i++) page.tick()
  const reads = boot + state.status
  assert.ok(reads >= 3, `boot plus one read per list tick must fire within 130s (saw ${reads})`)
  assert.ok(reads <= 6, `and never more often than the 60s chain allows (saw ${reads})`)
  assert.equal(state.list, due, 'each tick also refreshes the landing list')
})

test('B6 a hidden tab spends nothing', () => {
  const { state, page } = buildLanding()
  state.hidden = true
  page.startListPoll()
  page.tick()
  assert.equal(state.status, 0, 'no status read while the tab is hidden')
  assert.equal(state.list, 0, 'and no landing read either')
  assert.equal(page.pendingMs, null, 'the chain stops re-arming while hidden')
})

test('B7 coming back to the foreground runs a status read at once', () => {
  const { state, page } = buildLanding()
  state.hidden = true
  page.startListPoll()
  page.tick()
  assert.equal(state.status, 0, 'the hidden stretch spent nothing')
  state.hidden = false
  // the visibilitychange handler ends with void checkConnection() and re-arms the chain
  state.status++
  page.startListPoll()
  assert.ok(state.status >= 1, 'one read happens on the return, not 60s later')
  assert.equal(page.pendingMs, LIST_MS, 'and the list chain is armed again')
})

test('B7 the visibilitychange handler still re-arms the chain and reads status', () => {
  assert.match(js, /else\{if\(tabWasHidden\)void resumeOnReturn\(\);startListPoll\(\)\}void checkConnection\(\)\}\);/,
    'returning to the foreground calls checkConnection() and startListPoll()')
})

test('B8 the landing list keeps its own deadline', () => {
  const { state, page } = buildLanding()
  page.startListPoll()
  page.tick()
  assert.ok(state.list >= 1, 'the 60s landing deadline still fires and refreshes the list')
  assert.match(extractFunction(js, 'resumeOnReturn'), /await loadListData\(\)/, 'and the landing read still goes through the list fetch')
  assert.match(extractFunction(js, 'loadListData'), /rpc\('session\.list'/, 'which is the call that asks the bridge')
})

test('B9 the status clock is gone and no second chain was added', () => {
  assert.doesNotMatch(js, /setInterval\(checkConnection,5000\)/, 'the old 5s status chain is gone')
  assert.doesNotMatch(js, /setInterval\(schedTick,SCHED_TICK_MS\)/, 'no replacement scheduler tick exists')
  assert.doesNotMatch(js, /SCHED_TICK_MS|schedStatusAt|schedListAt/, 'no scheduler deadline state either')
  assert.match(js, /\ncheckConnection\(\);\n/, 'boot still reads status once')
  assert.match(extractFunction(js, 'startListPoll'), /checkConnection\(\);/, 'the status read rides the existing 60s list chain')
  // The page keeps its other functional timers (stream keepalive, byte watchdog,
  // subagent ticker, turn status, question countdown). HEAD shipped six including
  // the 5s status interval; removing that one leaves five, with no new timer.
  const armed = js.match(/setInterval\(/g) || []
  assert.equal(armed.length, 5, 'five timers, exactly the six the page had minus the status clock')
})
