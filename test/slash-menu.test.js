// Coverage for the mobile "/" slash menu:
//  - the two new catalog methods pass the allowlist and reach the Host with the
//    exact Typert wire shape (skills/list wraps `request`, commands/list is flat)
//  - the page ships the menu DOM/CSS and the pure helpers behave like the
//    desktop composer (gesture detection, ranking, command-vs-message split)
// FULL-STACK for the transport part: real HTTP through the real bridge into the
// fake Harness. The page helpers are extracted from the rendered asset, so they
// are tested as the phone actually receives them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, httpFetch } from './helpers.js'
import { RPC_ALLOWLIST } from '../lib/constants.js'
import { renderMobilePage, mobilePageAssets } from '../lib/pages.js'

function rpcCall(t, cookie, method, payload = {}) {
  return httpFetch(`${t.base}/api/rpc`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ method, payload }),
  })
}

test('skills.list / commands.list pass the allowlist and carry the Host wire shape', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()

    let res = await rpcCall(t, cookie, 'skills.list', { sessionId: 'sess-9' })
    assert.notEqual(res.status, 403, 'skills.list must be allowlisted')
    assert.equal(
      res.status,
      200,
      [
        'skills.list must reach the Harness',
        ...(t.transportFailures?.() ?? ['(this fixture exposes no transport diagnostics)']),
        `(HTTP ${res.status})`,
      ].join(' | '),
    )
    const skills = t.harness.records.calls.find((c) => c.url === '/api/skills/list')
    assert.ok(skills, 'bridge must POST /api/skills/list')
    // Typert declares a single json-wire param named `request`: it must be wrapped.
    assert.deepEqual(skills.args, { request: { sessionId: 'sess-9' } })

    res = await rpcCall(t, cookie, 'commands.list', { sessionId: 'sess-9' })
    assert.notEqual(res.status, 403, 'commands.list must be allowlisted')
    assert.equal(
      res.status,
      200,
      [
        'commands.list must reach the Harness',
        ...(t.transportFailures?.() ?? ['(this fixture exposes no transport diagnostics)']),
        `(HTTP ${res.status})`,
      ].join(' | '),
    )
    const commands = t.harness.records.calls.find((c) => c.url === '/api/commands/list')
    assert.ok(commands, 'bridge must POST /api/commands/list')
    // commands/list scopes on the agent lookup, whose wire name is `agentId`.
    assert.deepEqual(commands.args, { agentId: 'sess-9' })
  } finally {
    await t.stop()
  }
})

test('both catalog methods are derived into RPC_ALLOWLIST', () => {
  assert.ok(RPC_ALLOWLIST.has('skills.list'))
  assert.ok(RPC_ALLOWLIST.has('commands.list'))
})

test('the served page ships the slash menu DOM, CSS and helpers', () => {
  const assets = mobilePageAssets({ locale: 'zh' })
  const html = renderMobilePage({
    locale: 'zh',
    boot: JSON.stringify({ ws: { items: [] }, sess: { items: [] }, settings: null }),
    icon: null,
    initialChat: true,
    assets: { cssUrl: '/app.css?h=x', jsUrl: '/app.js?l=zh&h=x' },
  })

  assert.match(html, /id="slashMenu"/, 'the menu host must be in the document')
  assert.match(html, /role="listbox"/)
  // The menu lives inside the composer, which is the positioned ancestor the
  // CSS relies on (`#composer` is position:fixed, the menu is absolute in it).
  const composer = html.slice(html.indexOf('<div id="composer"'), html.indexOf('</main>'))
  assert.ok(composer.includes('id="slashMenu"'), 'the menu must sit inside #composer')
  assert.match(assets.css, /\.slash-menu\{/)
  assert.match(assets.css, /\.slash-row\.active/)
  for (const name of [
    'slashBoundaryOk',
    'slashGestureAt',
    'slashCommandName',
    'slashExecuteName',
    'slashRankByName',
    'slashMergeRows',
    'pickSlashRow',
    'slashMenuKeydown',
  ]) {
    assert.ok(assets.js.includes(`function ${name}(`), `${name} must ship to the phone`)
  }
  // The Enter handler must consult the menu before sending.
  assert.match(assets.js, /if\(slashMenuKeydown\(e\)\)return;/)
  // The old inline matcher in send() is replaced by the decision table.
  assert.ok(!assets.js.includes("text.match(/^\\\\s*\\\\/([a-zA-Z]"), 'send() must use slashExecuteName')
})

// --- pure helpers, extracted from the rendered asset ------------------------

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

function loadSlashHelpers() {
  const js = mobilePageAssets({ locale: 'zh' }).js
  const names = [
    'slashBoundaryOk',
    'slashGestureAt',
    'slashCommandName',
    'slashHasArgs',
    'slashExecuteName',
    'slashBoundaryBonus',
    'slashAlignmentScore',
    'slashRankByName',
    'slashMergeRows',
  ]
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  const factory = new Function(
    `let slashCatalogReady=false,slashCommands=[],slashSkills=[];\n${body}\n` +
      'return{setReady:value=>{slashCatalogReady=value},setCommands:value=>{slashCommands=value},setSkills:value=>{slashSkills=value},' +
      'slashBoundaryOk,slashGestureAt,slashCommandName,slashExecuteName,slashRankByName,slashMergeRows}'
  )
  return factory()
}

test('the slash gesture only opens at a word boundary and never spans a space', () => {
  const h = loadSlashHelpers()
  assert.deepEqual(h.slashGestureAt('/go', 3), { start: 0, query: 'go', leading: true })
  assert.deepEqual(h.slashGestureAt('hi /go', 6), { start: 3, query: 'go', leading: false })
  assert.equal(h.slashGestureAt('a/go', 4), null, 'a word char before "/" is not a boundary')
  assert.equal(h.slashGestureAt('/a b', 4), null, 'a space ends the gesture')
  assert.equal(h.slashGestureAt('plain', 5), null)
  // "//" is not a gesture start.
  assert.equal(h.slashGestureAt('//x', 3), null)
})

test('command names match the Host parser exactly', () => {
  const h = loadSlashHelpers()
  assert.equal(h.slashCommandName('/goal ship it'), 'goal')
  assert.equal(h.slashCommandName('/compact'), 'compact')
  assert.equal(h.slashCommandName('/plan\ttail'), 'plan')
  assert.equal(h.slashCommandName('/Goal'), null, 'uppercase is not a Host command')
  assert.equal(h.slashCommandName('hello /goal'), null, 'must be leading')
  // Trailing word characters extend the name (the Host lookahead only ends it at
  // whitespace or end-of-line), so an unknown name simply misses the catalog.
  assert.equal(h.slashCommandName('/goalx'), 'goalx')
  assert.equal(h.slashCommandName('/goal-x_y'), 'goal-x_y')
})

test('ranking mirrors the desktop composer (prefix first, then score)', () => {
  const h = loadSlashHelpers()
  const items = [{ name: 'compact' }, { name: 'plan' }, { name: 'permission' }]
  assert.deepEqual(h.slashRankByName(items, ''), items, 'an empty query keeps the order')
  assert.deepEqual(
    h.slashRankByName(items, 'pe').map((item) => item.name),
    ['permission']
  )
  assert.deepEqual(
    h.slashRankByName([{ name: 'export' }, { name: 'plan' }], 'p').map((item) => item.name),
    ['plan', 'export']
  )
})

test('send() decides between a command and a plain message like the desktop', () => {
  const h = loadSlashHelpers()
  // Catalog not ready yet: optimistic, keep the name so /goal works immediately.
  assert.equal(h.slashExecuteName('/goal ship it'), 'goal')
  h.setReady(true)
  h.setCommands([{ name: 'goal', description: '', input: { hint: 'objective' } }, { name: 'compact', description: '' }])
  // A catalogued command with an input hint runs with its trailing text.
  assert.equal(h.slashExecuteName('/goal ship it'), 'goal')
  // A bare no-input command runs.
  assert.equal(h.slashExecuteName('/compact'), 'compact')
  // A no-input command with trailing text falls through to a normal message.
  assert.equal(h.slashExecuteName('/compact now'), null)
  // Unknown names are skills/plain text: they go to the model.
  assert.equal(h.slashExecuteName('/native-skill'), null)
  assert.equal(h.slashExecuteName('just text'), null)
})

test('the merged menu lists commands before skills and dedupes by name', () => {
  const h = loadSlashHelpers()
  h.setReady(true)
  h.setCommands([{ name: 'plan', description: 'plan it', input: { hint: 'task' } }])
  h.setSkills([{ name: 'plan', description: 'dupe' }, { name: 'native', description: 'skill' }])
  const rows = h.slashMergeRows('')
  assert.deepEqual(
    rows.map((row) => `${row.kind}:${row.name}`),
    ['command:plan', 'skill:native']
  )
  assert.equal(rows[0].hint, 'task')
})