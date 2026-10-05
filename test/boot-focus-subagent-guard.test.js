// BF — a boot focus may not be another session's tool.
//
// Two guards now stand between a subagent session and the phone's first paint,
// and both are pinned here:
//
//   1. the bridge picker (`LanMobileBridge.pickFocusItem`) refuses a subagent row
//      outright, so the doomed `session/page` ladder is never walked;
//   2. the page (`openableFocus`) judges the focus the payload carried against the
//      raw rows and falls back, so a payload that predates (1), or that arrives
//      from anywhere else, still cannot drag the phone into a child session.
//
// (2) used to be the only guard, and that is why the host picker was described
// here as "unfiltered" — the premise AC-1/AC-2 used to pin. The picker is filtered
// now, so that premise is gone and those two cases assert the new invariant
// instead. (2) is kept deliberately: it costs one join, and it is the layer that
// still protects the phone when the focus arrives from a payload the bridge did
// not build.
//
// Anchors are symbol anchors (function name + the exact statement), never line
// numbers: line anchors drift with every neighbouring commit.
import test from 'node:test'
import assert from 'node:assert/strict'
import { LanMobileBridge } from '../lib/bridge.js'
import { mobilePageAssets } from '../lib/pages.js'

const js = mobilePageAssets({ locale: 'zh' }).js

// Same stub surface as test/boot-landing.test.js: the boot payload is built from
// a prototype call, so only the leaves are replaced.
function makeBridge(overrides = {}) {
  const logs = []
  const bridge = Object.create(LanMobileBridge.prototype)
  bridge.logs = logs
  bridge.log = (level, message) => logs.push(`${level}: ${message}`)
  bridge.locale = () => 'zh'
  bridge.iconDataUri = null
  bridge.now = () => Date.now()
  bridge.html = (response, markup) => {
    response.markup = markup
    return markup
  }
  bridge.pendingQuestions = new Map()
  bridge.workspaceSnapshot = { items: [] }
  bridge.cachedSettings = async () => ({ ok: true, value: {} })
  bridge.cachedSessionList = async () => ({ ok: true, value: { items: overrides.items ?? [] } })
  bridge.invokeHarness = overrides.invokeHarness ?? (async () => ({ ok: false, error: 'not stubbed' }))
  return bridge
}

// Splice the named page function out of the page script. The head must be the
// exact declaration form, so a stray space in the source breaks the anchor here
// instead of silently returning a fragment. The anchor lands on "function", so
// an async declaration arrives without its keyword and would not parse in the
// sandbox — put it back.
function extractFunction(text, name) {
  const head = 'function ' + name + '('
  const start = text.indexOf(head)
  assert.ok(start >= 0, `function ${name} must exist in the page script`)
  const keyword = text.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : ''
  let depth = 0
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return keyword + text.slice(start, i + 1)
    }
  }
  throw new Error(`function ${name} never closed`)
}

// The host rows the boot payload is built from: a real conversation and a
// subagent row that is newer, so the unfiltered host picker lands on the child.
const hostRows = () => [
  { sessionId: 'parent', updatedAt: 5 },
  { sessionId: 'child', updatedAt: 50, origin: 'subagent' },
]

// page code is spliced into a Function body, so it must stay free of template syntax
const openableFocus = (() => {
  const body = extractFunction(js, 'openableFocus')
  assert.ok(!body.includes('`') && !body.includes('${'), 'openableFocus must be spliceable')
  return new Function(`${body};return openableFocus;`)()
})()

// Drive the real reconcileBoot over a stub boot payload and record every open.
function runReconcileBoot({ fresh, activeSession = null, previousFocus = null }) {
  const opened = []
  const fetchCalls = []
  const scope = [
    'var activeSession = opts.activeSession;',
    'var embeddedFocus = null;',
    'var provisionalSession = true;',
    extractFunction(js, 'openableFocus'),
    extractFunction(js, 'reconcileBoot'),
    'return async function(){ await reconcileBoot(); return provisionalSession; }',
  ].join('\n')
  const build = new Function(
    'opts',
    'fetch',
    'pickFocusSession',
    'applyBootData',
    'renderWorkspaces',
    '$',
    'paintInstantSession',
    'titleFor',
    'openSession',
    scope,
  )
  const run = build(
    { activeSession },
    async (url, init) => {
      fetchCalls.push({ url, init })
      // the first /api/boot answer has to be live, or the body returns early
      return { ok: true, json: async () => fresh }
    },
    () => previousFocus,
    () => {},
    () => {},
    () => ({ querySelector: () => null }),
    () => {},
    (focus) => ({ title: 'stub:' + String(focus && focus.sessionId) }),
    async (sessionId) => {
      opened.push(sessionId)
    },
  )
  return { run, opened, fetchCalls }
}

test('AC-1 the bridge picker no longer offers a subagent row as the boot focus', async () => {
  // The primary guard. A subagent row is the newest one here, which is exactly
  // what the unfiltered picker used to land on — and it then spent the whole
  // history ladder on attempts the Host refuses (`session/agent-busy`) before
  // returning no focus history at all. Picking the real row instead is what
  // gives the phone its instant first paint back.
  const bridge = makeBridge({
    items: hostRows(),
    invokeHarness: async () => ({ ok: true, value: { records: [{ seq: 1 }], hasMore: false } }),
  })

  const payload = await bridge.buildMobileBoot()

  assert.equal(payload.focus.sessionId, 'parent', 'the filtered picker lands on the real row')
  assert.equal('origin' in payload.focus, false, 'the focus payload still carries no origin of its own')
  assert.equal(
    payload.sess.items.find((item) => item.sessionId === 'child').origin,
    'subagent',
    'the raw row does carry it — that is what the picker and the page guard read',
  )
})

test('AC-1b the Host is never asked to page the subagent row', async () => {
  // The behavioural teeth of AC-1: AC-1 could pass on a picker that returned the
  // right id and still paged the wrong session. Here every session the history
  // ladder asks about is recorded, so a picker that merely relabelled the row —
  // or that fell back to the newest row somewhere downstream — still goes red.
  const paged = []
  const bridge = makeBridge({
    items: hostRows(),
    invokeHarness: async (method, payloadIn) => {
      if (method === 'session/page') {
        paged.push(payloadIn?.request?.address?.sessionId)
      }
      return { ok: true, value: { records: [{ seq: 1 }], hasMore: false } }
    },
  })

  const payload = await bridge.buildMobileBoot()

  assert.ok(paged.length > 0, 'the ladder must actually have run — otherwise this proves nothing')
  assert.deepEqual([...new Set(paged)], ['parent'], 'the ladder may only ever ask about the row it picked')
  assert.equal(payload.focus.sessionId, 'parent')
})

test('AC-1c the picker fails open, so a row without a known origin still wins', () => {
  // A guard that refused on anything unfamiliar would strand a phone whose list
  // carries no origin key at all. Only a positively known subagent is turned away.
  const pick = LanMobileBridge.prototype.pickFocusItem
  const rows = [
    { sessionId: 'no-key', updatedAt: 9 },
    { sessionId: 'local', updatedAt: 8, origin: 'local' },
  ]
  assert.equal(pick.call({}, rows).sessionId, 'no-key', 'a row with no origin key is still a candidate')

  const allSubagents = [
    { sessionId: 'a', updatedAt: 9, origin: 'subagent' },
    { sessionId: 'b', updatedAt: 8, origin: 'subagent' },
  ]
  assert.equal(pick.call({}, allSubagents), null, 'no real row means no focus at all')
  assert.equal(pick.call({}, []), null)
  assert.equal(pick.call({}, undefined), null)
})

test('AC-2 the trimmed boot list still keeps the row it picked', async () => {
  // /api/boot ships listLimit 1. Whatever the picker chose must survive the
  // trim, or the page has no row to judge the focus against and the boot payload
  // describes a conversation the list never shows.
  const bridge = makeBridge({
    items: hostRows(),
    invokeHarness: async () => ({ ok: true, value: { records: [{ seq: 1 }], hasMore: false } }),
  })

  const payload = await bridge.buildMobileBoot({ listLimit: 1 })

  assert.equal(payload.sess.partial, true)
  assert.equal(payload.sess.items.length, 1)
  assert.equal(payload.sess.items[0].sessionId, 'parent', 'the kept row is the one the payload focuses')
  assert.equal(payload.sess.items[0].origin, undefined)
})

test('AC-3 a focus joined to an explicit subagent row is not openable', () => {
  assert.equal(openableFocus({ sessionId: 'child' }, [{ sessionId: 'child', origin: 'subagent' }]), null)
})

test('AC-4 every other focus still opens, by the same reference, so nothing else changes', () => {
  // Failing open is the point: a row that is not a subagent row, a row with no
  // origin key at all, a row the trimmed list left out, and a payload with no
  // usable list all keep the candidate untouched.
  const candidate = { sessionId: 'child' }
  const openable = [
    ['an ordinary origin', [{ sessionId: 'child', origin: 'local' }]],
    ['no origin key on the row', [{ sessionId: 'child' }]],
    ['a row that is not in the payload', [{ sessionId: 'parent', origin: 'local' }]],
    ['a payload with no usable list', undefined],
  ]
  for (const [label, items] of openable) {
    assert.equal(openableFocus(candidate, items), candidate, `${label} must still open, by identity`)
  }
})

test('AC-5 a focus with no usable session id is refused before the join', () => {
  const rows = [{ sessionId: 'child', origin: 'subagent' }]
  assert.equal(openableFocus(null, rows), null)
  assert.equal(openableFocus({}, rows), null)
  assert.equal(openableFocus({ sessionId: '' }, rows), null)
  assert.equal(openableFocus({ sessionId: 1 }, rows), null)
})

test('AC-6 the guard judges the origin, never the host sentence or the bridge error code', () => {
  const body = extractFunction(js, 'openableFocus')
  assert.ok(
    body.includes("row.origin==='subagent'"),
    'the verdict is the joined row origin',
  )
  assert.ok(
    !/errorCode|agent-busy|durable parent/i.test(body),
    'the guard must not become a matcher for the refusal the host raises',
  )
})

test('AC-7 the boot redirect opens a subagent focus no more, and still opens a look-alike one', async () => {
  // Both directions in one case on purpose: reconcileBoot swallows every throw,
  // so a stub typo or a missing name would make the negative control pass for
  // the wrong reason. The positive control is what proves the sandbox ran.
  const subagent = {
    ws: {},
    sess: { items: [{ sessionId: 'child', origin: 'subagent' }] },
    focus: { sessionId: 'child', history: { events: [] } },
  }
  const lookAlike = {
    ws: {},
    sess: { items: [{ sessionId: 'child' }] },
    focus: { sessionId: 'child', history: { events: [] } },
  }

  const blocked = runReconcileBoot({ fresh: subagent, activeSession: 'parent', previousFocus: { sessionId: 'parent' } })
  await blocked.run()
  assert.deepEqual(blocked.opened, [], 'a subagent focus must not reach openSession')

  const opened = runReconcileBoot({ fresh: lookAlike, activeSession: 'parent', previousFocus: { sessionId: 'parent' } })
  await opened.run()
  assert.deepEqual(opened.opened, ['child'], 'the same shape without the verdict still opens')
})

test('AC-8 the guard leaves the existing reopen gate alone', async () => {
  // pickFocusSession already names the same session the host focus names, so
  // the older gate stops the reopen. The guard must not turn that into a new
  // reason to open, nor swallow the gate.
  const fresh = {
    ws: {},
    sess: { items: [{ sessionId: 'child' }] },
    focus: { sessionId: 'child', history: { events: [] } },
  }
  const run = runReconcileBoot({ fresh, activeSession: 'parent', previousFocus: { sessionId: 'child' } })

  await run.run()

  assert.deepEqual(run.opened, [], 'same id on both sides keeps the live stream untouched')
})

test('AC-9 the boot focus is taken through the guard, on the raw rows of the same payload', () => {
  assert.match(
    js,
    /const nextFocus=openableFocus\(fresh\.focus&&fresh\.focus\.sessionId\?fresh\.focus:pickFocusSession\(\),fresh\.sess\.items\)/,
    'the redirect must judge the host focus against the payload it arrived with',
  )
})

test('AC-10 the straight-through focus is gone', () => {
  assert.ok(
    !/const nextFocus=fresh\.focus&&fresh\.focus\.sessionId\?fresh\.focus:pickFocusSession\(\);/.test(js),
    'the unguarded assignment must not come back',
  )
})

test('AC-11 the list projection and its four landing points are untouched', () => {
  const sites = [
    ['refreshActiveSessionSummary', 'sessionSummaries=visibleSessions(value.items)'],
    ['openSessionSettings', 'sessionSummaries=visibleSessions(sessions.items)'],
    ['applyBootData', 'sessionSummaries=visibleSessions(sessInput.items)'],
  ]
  for (const [name, needle] of sites) {
    assert.ok(extractFunction(js, name).includes(needle), `${name} must still project its answer`)
  }
  assert.ok(
    extractFunction(js, 'createSessionIn').includes("if(created.origin!=='subagent'){const summary="),
    'the local summary is still origin-guarded (optimistic creation converts or drops the provisional row)',
  )
  assert.ok(
    !/sessionSummaries\s*=\s*(?:value|sessions|sessInput)\.items/.test(js),
    'no load path may assign the raw list over the projected one',
  )
})

test('AC-12 the busy-session fallback is still decided before any error is painted', () => {
  const body = extractFunction(js, 'loadHistory')
  const judged = body.indexOf("e.errorCode==='session/agent-busy'")
  const fallback = body.indexOf('void showSessionList();return')
  const painted = body.indexOf("showError('chatError',e)")
  assert.ok(judged >= 0, 'the catch judges by the bridge error code, not by the sentence')
  assert.ok(fallback > judged, 'the busy family clears the pinned session and returns')
  assert.ok(painted > fallback, 'the raw host sentence stays unreachable for this family')
})

test('AC-13 the page keeps its literal discipline: no template syntax, no script tag, no nonce', () => {
  assert.ok(!js.includes('`'), 'no backtick in the page script')
  assert.ok(!/<script/.test(js), 'no literal script tag in the page script')
  assert.ok(!/nonce/.test(js), 'no nonce wording in the page script')
})