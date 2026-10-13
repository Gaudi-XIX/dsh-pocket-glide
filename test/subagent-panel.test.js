// The subagent bar (0.4.41): the phone reads a parent session's subagentCatalog
// projection (label/createdAt/mode — the desktop CatalogDropdown rows) and the
// session.list child rows for running/error state, and opens a child session
// read-only through the Host's durable subagent address. This file pins the
// page-side half: row grouping, state ranking, the bar markup, the read-only
// mode switch and the address plumbing. The stream/bridge half is pinned at
// source level at the bottom (session-stream.js's followAddressOf is unit-tested
// directly; the RPC and route layers are one-line forwarders).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { mobilePageAssets } from '../lib/pages.js'
import { followAddressOf } from '../lib/session-stream.js'

const { js } = mobilePageAssets({ locale: 'zh' })

function pageLabels(locale) {
  const line = mobilePageAssets({ locale }).js.match(/^const L=(\{.*\});/m)
  assert(line, `${locale}: the label table must render as one JSON line`)
  return JSON.parse(line[1])
}

const L = pageLabels('zh')

function extractFunction(source, name) {
  const plain = source.indexOf('function ' + name + '(')
  const start = plain === -1 ? source.indexOf('async function ' + name + '(') : plain
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

function fakeBar() {
  const el = {
    hidden: true,
    _html: '',
    writes: [],
    querySelectorAll: () => [],
    set innerHTML(v) { el._html = v; el.writes.push(v) },
    get innerHTML() { return el._html },
  }
  return el
}

// One sandbox carrying every page global the bar organs read. Anything missing
// throws inside renderSubagentBar and measures the test, not the page.
function buildBarSandbox({ catalog = null, rows = new Map(), view = null, active = 'parent1', expanded = false } = {}) {
  const bar = fakeBar()
  const timers = []
  const make = new Function(
    'bar',
    'L',
    'initialCatalog',
    'initialRows',
    'initialView',
    'setInterval',
    'clearInterval',
    `
    let activeSession=${JSON.stringify(active)}
    let subagentCatalog=initialCatalog
    let subagentView=initialView
    let subagentExpanded=${JSON.stringify(expanded)}
    let subagentTicker=null
    const subagentRowsByParent=initialRows
    const $=(id)=>id==='subagentBar'?bar:null
    const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
    ${extractFunction(js, 'pad2')}
    ${extractFunction(js, 'formatMessageClock')}
    ${extractFunction(js, 'updateSubagents')}
    ${extractFunction(js, 'subagentRowOf')}
    ${extractFunction(js, 'subagentStateOf')}
    ${extractFunction(js, 'subagentDurationText')}
    ${extractFunction(js, 'stopSubagentTicker')}
    ${extractFunction(js, 'startSubagentTicker')}
    ${extractFunction(js, 'renderSubagentBar')}
    return {
      renderSubagentBar, updateSubagents, subagentStateOf, subagentDurationText,
      get catalog(){return subagentCatalog},
      get expanded(){return subagentExpanded},
      set expanded(v){subagentExpanded=v},
      get ticker(){return subagentTicker},
      get bar(){return bar},
    }
  `,
  )
  // A real setInterval would keep node's event loop (and this test process) alive
  // for the full 30s tick; record the handle instead so the ticker's presence is
  // still assertable without ever arming it.
  const sandbox = make(bar, L, catalog, rows, view, (fn, ms) => { timers.push(ms); return 7 }, (handle) => { if (handle === 7) timers.length = 0 })
  sandbox.timers = timers
  return sandbox
}

const CHILD = (id, overrides = {}) => ({ id, createdAt: Date.now() - 5 * 60000, mode: 'one-shot', label: 'probe the host', ...overrides })
const ROW = (id, overrides = {}) => ({ sessionId: id, origin: 'subagent', parentSessionId: 'parent1', running: false, ...overrides })

// ------------------------------------------------------------------ grouping

test('splitSubagentRows keys child rows by parent and drops everything else', () => {
  const sandboxRows = new Function(`
    const rows=new Map()
    ${extractFunction(js, 'splitSubagentRows')}
    return splitSubagentRows
  `)()
  const items = [
    { sessionId: 'lead', running: false },
    ROW('c1'),
    { sessionId: 'orphan', origin: 'subagent' },
    { sessionId: 'c2', origin: 'subagent', parentSessionId: 'other-parent' },
    null,
  ]
  const rows = sandboxRows(items)
  assert.ok(rows instanceof Map, 'grouped by parent in a Map')
  assert.deepEqual([...rows.keys()], ['parent1', 'other-parent'], 'only rows with a parent key land')
  assert.equal(rows.get('parent1')[0].sessionId, 'c1')
  assert.equal(rows.get('other-parent')[0].sessionId, 'c2')
  const empty = sandboxRows(null)
  assert.equal(empty.size, 0, 'a missing list is an empty map, never a crash')
})

// ------------------------------------------------------------------ state rank

test('subagentStateOf ranks error over running, and idle is the fallback', () => {
  const sandbox = buildBarSandbox({ rows: new Map([['parent1', [ROW('err', { lastError: 'boom' }), ROW('run', { running: true }), ROW('calm')]]]) })
  assert.equal(sandbox.subagentStateOf({ id: 'err' }), 'error', 'a row carrying lastError reads as error first')
  assert.equal(sandbox.subagentStateOf({ id: 'run' }), 'running')
  assert.equal(sandbox.subagentStateOf({ id: 'calm' }), 'idle')
  assert.equal(sandbox.subagentStateOf({ id: 'ghost' }), 'idle', 'a catalog entry with no list row (cold list) is idle, not an invention')
})

// ------------------------------------------------------------------ duration

test('subagentDurationText speaks minutes and hours, never raw ms', () => {
  const sandbox = buildBarSandbox({})
  assert.equal(sandbox.subagentDurationText(30_000), L.subagentJustNow)
  assert.equal(sandbox.subagentDurationText(5 * 60_000), '5 分钟')
  assert.equal(sandbox.subagentDurationText(125 * 60_000), '2 小时 5 分')
  assert.equal(sandbox.subagentDurationText(-1), '', 'a bogus duration renders as nothing')
})

// ------------------------------------------------------------------ the bar

test('renderSubagentBar hides itself with no catalog, in a subagent view, or with no session', () => {
  for (const [name, opts] of [['no catalog', {}], ['subagent view', { view: { parentSessionId: 'p', mode: 'one-shot' }, catalog: [CHILD('c1')] }], ['no session', { active: null, catalog: [CHILD('c1')] }]]) {
    const sandbox = buildBarSandbox(opts)
    sandbox.renderSubagentBar()
    assert.equal(sandbox.bar.hidden, true, `${name}: the bar stays hidden`)
    assert.equal(sandbox.bar.innerHTML, '', `${name}: no markup lingers`)
  }
})

test('renderSubagentBar paints one row per catalog entry with running count and labels', () => {
  const now = Date.now()
  const catalog = [CHILD('c1', { createdAt: now - 5 * 60000 }), CHILD('c2', { label: 'second child' }), CHILD('c3', { createdAt: now - 90 * 60000 })]
  const rows = new Map([['parent1', [ROW('c1', { running: true }), ROW('c3', { lastError: 'died' })]]])
  const sandbox = buildBarSandbox({ catalog, rows })
  sandbox.renderSubagentBar()
  assert.equal(sandbox.bar.hidden, false, 'the bar shows')
  const html = sandbox.bar.innerHTML
  assert.ok(html.includes('data-subagent-open="c1"') && html.includes('data-subagent-open="c2"') && html.includes('data-subagent-open="c3"'), 'every catalog entry is a row')
  assert.ok(html.includes('probe the host') && html.includes('second child'), 'labels render (fallback label applied where missing)')
  assert.ok(html.includes('is-running') && html.includes('is-error') && html.includes('is-idle'), 'state classes land on the right rows')
  assert.ok(html.includes(L.subagentRunningCount.replace('{n}', '1')), 'the running count is the header badge')
  assert.ok(html.includes(L.subagentErrorCount.replace('{n}', '1')), 'the error count is on the header too')
  assert.ok(html.includes('data-subagent-elapsed'), 'the running row carries its createdAt for the ticker')
  assert.ok(html.includes('5 分钟'), 'the running row shows elapsed time from createdAt')
  const idleClock = (html.match(/data-subagent-open="c2"[\s\S]*?<time>([^<]*)<\/time>/) || [])[1]
  assert.match(String(idleClock), /^\d{2}:\d{2}$/, 'an idle row shows the absolute 24h wall clock of its createdAt — never "x ago" (2026-10-13 unification)')
})

test('the rows container is collapsed until expanded, and the ticker only runs expanded+running', () => {
  const catalog = [CHILD('c1')]
  const rows = new Map([['parent1', [ROW('c1', { running: true })]]])
  const collapsed = buildBarSandbox({ catalog, rows, expanded: false })
  collapsed.renderSubagentBar()
  assert.ok(collapsed.bar.innerHTML.includes(' hidden>'), 'collapsed: rows hidden')
  assert.equal(collapsed.ticker, null, 'collapsed: no ticker')
  assert.deepEqual(collapsed.timers, [], 'collapsed: no timer armed')

  const expanded = buildBarSandbox({ catalog, rows, expanded: true })
  expanded.renderSubagentBar()
  assert.ok(!expanded.bar.innerHTML.includes(' hidden>'), 'expanded: rows visible')
  assert.notEqual(expanded.ticker, null, 'expanded + running: the ticker runs')
  assert.deepEqual(expanded.timers, [30000], 'expanded + running: one 30s timer armed')

  const expandedIdle = buildBarSandbox({ catalog, expanded: true })
  expandedIdle.renderSubagentBar()
  assert.equal(expandedIdle.ticker, null, 'expanded + idle: no ticker')
})

test('updateSubagents takes the catalog from the projection values and nothing else does', () => {
  const sandbox = buildBarSandbox({})
  sandbox.updateSubagents({ values: { subagentCatalog: [CHILD('c1')] } })
  assert.equal(sandbox.catalog.length, 1, 'a real catalog lands')
  sandbox.updateSubagents({ values: {} })
  assert.equal(sandbox.catalog, null, 'a projection without the key clears the bar (the child view carries no catalog)')
  sandbox.updateSubagents(null)
  assert.equal(sandbox.catalog, null, 'a missing projection clears, never throws')
})

// ------------------------------------------------------- read-only open path

test('openSubagentSession forwards the durable address and refuses to nest', () => {
  const opened = []
  const make = new Function('L', 'openSession', `
    let activeSession='parent1',subagentView=null
    ${extractFunction(js, 'openSubagentSession')}
    return { openSubagentSession, get view(){return subagentView}, set view(v){subagentView=v} }
  `)
  const sandbox = make(L, async (id, title, fromHistory, pushHistory, opts) => { opened.push({ id, title, opts }) })
  sandbox.openSubagentSession({ id: 'child9', mode: 'continuable', label: 'worker' })
  assert.deepEqual(opened, [{ id: 'child9', title: 'worker', opts: { subagent: { parentSessionId: 'parent1', mode: 'continuable' } } }], 'the open carries parent+mode verbatim and the label as title')
  // Once openSession has flipped the mode (what the real one does), a second row
  // tap must be a no-op: no nested subagent-of-a-subagent address.
  sandbox.view = { parentSessionId: 'child9', mode: 'one-shot' }
  sandbox.openSubagentSession({ id: 'child10' })
  assert.equal(opened.length, 1, 'already inside a subagent view: no nesting')
  const none = new Function('L', 'openSession', `
    let activeSession=null,subagentView=null
    ${extractFunction(js, 'openSubagentSession')}
    return { openSubagentSession }
  `)(L, async () => {})
  none.openSubagentSession({ id: 'child11' })
})

test('openSession normalizes the subagent opt and the page hides the write surface in that mode', () => {
  const css = mobilePageAssets({ locale: 'zh' }).css
  // The opt never reaches the runtime unvalidated: a malformed parent or mode
  // degrades to the ordinary session view rather than a broken address.
  assert.ok(js.includes("subagentView=opts&&opts.subagent&&typeof opts.subagent.parentSessionId==='string'&&opts.subagent.parentSessionId?"), 'openSession validates the opt shape')
  assert.ok(css.includes("body.subagent-open #composer,body.subagent-open #questionComposer{display:none}"), 'composer and question panel are the hidden pair (stop rides inside the composer)')
  assert.ok(js.includes('subagentNote.textContent=subagentView?L.subagentReadonly'), 'the read-only note names the mode')
  assert.ok(js.includes("openSession(entry.id,label,false,true,{subagent:{parentSessionId,mode}})"), 'the bar row opens through openSession with the subagent opt')
  // history round-trip: the entry carries the address so popstate restores it
  assert.ok(js.includes('...(subagentView?{subagent:subagentView}:{})'), 'pushState entries carry the subagent address')
  assert.ok(js.includes('state.subagent?{subagent:state.subagent}:null'), 'popstate hands it back')
})

// --------------------------------------------------------- history plumbing

test('loadHistory asks with the subagent address while a child is open, and both refusals bounce to the list', () => {
  const loading = extractFunction(js, 'loadHistory')
  assert.ok(loading.includes('...(subagentView?{subagent:subagentView}:{})'), 'the history rpc carries the address when subagentView is set')
  assert.ok(loading.includes("if(e&&e.errorCode==='session/agent-busy'){void showSessionList();return}"), 'the original agent-busy list-jump is untouched')
  assert.ok(loading.includes("errCode.lastIndexOf('subagent/',0)===0"), 'subagent/* refusals join the bounce family')
})

// ------------------------------------------------------- stream/bridge half

test('followAddressOf builds the durable subagent shape only from a complete pair', () => {
  assert.deepEqual(followAddressOf('c1', null), { kind: 'session', sessionId: 'c1' }, 'no subagent: the ordinary address')
  assert.deepEqual(followAddressOf('c1', {}), { kind: 'session', sessionId: 'c1' }, 'empty subagent: the ordinary address')
  assert.deepEqual(followAddressOf('c1', { parentSessionId: 'p' }), { kind: 'session', sessionId: 'c1' }, 'half a pair: the ordinary address')
  assert.deepEqual(
    followAddressOf('c1', { parentSessionId: 'p', mode: 'one-shot' }),
    { kind: 'subagent', childSessionId: 'c1', parentSessionId: 'p', mode: 'one-shot' },
    'a complete pair builds the durable address the Host validates'
  )
})

test('both realtime routes forward the parent/mode query pair, and session.history validates it', () => {
  const bridge = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
  const routeReads = [...bridge.matchAll(/url\.searchParams\.get\('parentSessionId'\)/g)].length
  assert.equal(routeReads, 2, 'the query pair is read on both routes (stream + events)')
  for (const needle of [
    "const subagent = parentParam && modeParam ? { parentSessionId: parentParam, mode: modeParam } : null",
    'followAddressOf(sessionId, subagent)',
    "if (!parentSessionId || !mode) {",
    'subagentRaw',
  ]) {
    assert.ok(bridge.includes(needle), `bridge.js pins: ${needle}`)
  }
  assert.ok(bridge.includes('createSessionEventCollector(this, sessionId, subagent)'), 'the tunnel collector gets the address too')
  assert.ok(bridge.includes('return streamSessionStream(this, request, response, sessionId, sinceSeq, subagent)'), 'the SSE forwarder gets the address too')
})
