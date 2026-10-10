// Process narration overhaul (change 2026-10-07-feat-pocket-process-render-overhaul,
// W1-卡2) — the phone narrates a turn with the Host desktop's own verb language
// instead of raw tool names. Layers proven here, mirroring the card's acceptance
// list:
//   1. the name→category mapping is TOTAL over the Host's tool universe
//      (extracted from app.asar TOOL_TITLE_KEYS / TOOL_VARIANTS / activity(),
//      2026-10-07) and a verbatim port of the Host's own rules;
//   2. the verb tables (zh+en) cover every category with both states;
//   3. diffLineSplit reduces an edit to removed/added line lists;
//   4. toolSummaryLine condenses one call to its primary argument;
//   5. clusterToolBlocks merges consecutive same-category calls and never
//      merges questions/subagents;
//   6. the renderer speaks the verbs: running/done/error titles, count titles
//      on merged clusters, red/green diff rows with the 40-row elision, and the
//      raw-JSON demotion to a second "technical details" fold.
// House pattern: behaviour runs the REAL functions spliced out of the rendered
// asset (block-placeholder.test.js / error-visibility.test.js precedent).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'
import { STEP_PROCESS_LABELS } from '../lib/step-process.generated.js'
import { toolActivityCategory } from '../lib/constants.js'

const assets = { zh: mobilePageAssets({ locale: 'zh' }), en: mobilePageAssets({ locale: 'en' }) }

// The page embeds the generated host table as STEP (message.stepProcess.*);
// the sandbox needs the same data the rendered asset carries.
function STEP_TABLE(locale) {
  return locale === 'en' ? STEP_PROCESS_LABELS.en : STEP_PROCESS_LABELS.zh
}

function labels(locale) {
  const line = assets[locale].js.match(/^const L=(\{.*\});/m)
  assert(line, `${locale}: the label table must render as one JSON line`)
  return JSON.parse(line[1])
}

// Brace-matching extractor (transcript-order house pattern).
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

// The render sandbox: the real render-side organs plus the four toString-embedded
// pure helpers, over stub DOM neighbours. The tool path never touches markdown.
function renderSandbox(locale) {
  const js = assets[locale].js
  const names = [
    'toolActivityCategory', 'diffLineSplit', 'toolSummaryLine', 'clusterToolBlocks', 'stepTitleFor',
    'renderBlock', 'toolClusterState', 'toolArgsOf', 'diffRowsHtml', 'renderToolDiff',
    'renderToolRaw', 'renderToolCard', 'renderTurnProcess', 'pretty',
  ]
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  return new Function(
    'L',
    'STEP',
    'activeSession',
    `${body};
     const esc=v=>String(v==null?'':v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
     const markdown=text=>String(text||'')
     function activityIcon(){return '<i class="icon"></i>'}
     function activityChevron(){return '<c></c>'}
     function reasoningSummary(){return ''}
     const turnOpenState=new Map()
     const transcriptView='verbose'
     const pendingQuestion=null
     return { renderBlock, renderToolCard, renderTurnProcess, clusterToolBlocks, toolActivityCategory, diffLineSplit, toolSummaryLine }`,
  )(labels(locale), STEP_TABLE(locale), 's1')
}

const tool = (name, status, args, result) => ({ kind: 'tool', id: name + ':' + Math.random(), name, status, args, result: result || '' })
const think = (text) => ({ kind: 'reasoning', text })

// ------------------------------------------------------- 1. mapping totality

// The Host tool-name universe, curated from the desktop app.asar registry
// (TOOL_VARIANTS + TOOL_TITLE_KEYS + activity(), read 2026-10-07). Every name a
// session can put on the wire must land in a narrateable category.
const HOST_TOOL_UNIVERSE = [
  'read', 'read_image', 'write', 'edit', 'apply_patch',
  'bash', 'pwsh', 'exec_command', 'write_stdin',
  'terminal_open', 'terminal_read', 'terminal_list', 'terminal_signal', 'terminal_close',
  'grep', 'glob', 'web_search', 'web_fetch', 'run_code',
  'subagent', 'subagent_spawn', 'list_agents', 'list_subagent_models', 'send_message', 'interrupt_agent', 'spawn_teammate',
  'todo_write', 'create_goal', 'update_goal', 'get_goal',
  'ask_user_question', 'request_user_input',
  'cordis_package_inspect', 'cordis_runtime_inspect', 'cordis_run', 'cordis_stop', 'cordis_undefine',
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  'job_list', 'job_output', 'job_kill', 'lsp', 'workflow', 'ralph',
  'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update',
  'team_task_create', 'team_task_get', 'team_task_update', 'team_task_list',
]

test('mapping is total over the Host tool universe and ports the Host rules verbatim', () => {
  const categories = new Set()
  for (const name of HOST_TOOL_UNIVERSE) {
    const category = toolActivityCategory(name)
    assert.equal(typeof category, 'string', `${name} must map to a string category`)
    assert.ok(category.length > 0, `${name} must not map to an empty category`)
    categories.add(category)
  }
  // Every narration category is reachable from real Host tools except readImage's
  // sibling states — read_image covers it — and thinking (reasoning blocks are
  // not tool calls).
  for (const expected of ['read', 'readImage', 'write', 'edit', 'commands', 'code', 'search', 'webSearch', 'webFetch', 'subagents', 'plan', 'questions', 'tools']) {
    assert.ok(categories.has(expected), `the universe must exercise the ${expected} category`)
  }
})

test('mapping follows the Host exact-name rules', () => {
  assert.equal(toolActivityCategory('read'), 'read')
  assert.equal(toolActivityCategory('read_image'), 'readImage')
  assert.equal(toolActivityCategory('write'), 'write')
  assert.equal(toolActivityCategory('edit'), 'edit')
  assert.equal(toolActivityCategory('apply_patch'), 'edit')
  assert.equal(toolActivityCategory('bash'), 'commands')
  assert.equal(toolActivityCategory('pwsh'), 'commands')
  assert.equal(toolActivityCategory('exec_command'), 'commands')
  assert.equal(toolActivityCategory('write_stdin'), 'commands')
  assert.equal(toolActivityCategory('run_code'), 'code')
  assert.equal(toolActivityCategory('web_search'), 'webSearch')
  assert.equal(toolActivityCategory('web_fetch'), 'webFetch')
  assert.equal(toolActivityCategory('grep'), 'search')
  assert.equal(toolActivityCategory('glob'), 'search')
  assert.equal(toolActivityCategory('subagent'), 'subagents')
  assert.equal(toolActivityCategory('todo_write'), 'plan')
  assert.equal(toolActivityCategory('create_goal'), 'plan')
  assert.equal(toolActivityCategory('update_goal'), 'plan')
  assert.equal(toolActivityCategory('get_goal'), 'plan')
  assert.equal(toolActivityCategory('ask_user_question'), 'questions')
  assert.equal(toolActivityCategory('request_user_input'), 'questions')
})

test('mapping honours the Host wildcard families', () => {
  assert.equal(toolActivityCategory('cordis_package_inspect'), 'search', '*_inspect is a search view on the Host')
  assert.equal(toolActivityCategory('some_future_inspect'), 'search')
  assert.equal(toolActivityCategory('terminal_open'), 'commands', 'terminal_* is a command surface on the Host')
  assert.equal(toolActivityCategory('terminal_whatever'), 'commands')
  assert.equal(toolActivityCategory('subagent_anything'), 'subagents')
})

test('mapping falls back to generic tools, Host-style', () => {
  for (const name of ['lsp', 'job_kill', 'cordis_run', 'workflow', 'ralph', 'session_search', 'schedule_create', 'list_agents', 'totally_new_plugin_tool', '', null, undefined]) {
    assert.equal(toolActivityCategory(name), 'tools', `${String(name)} must fall back to tools`)
  }
})

// ------------------------------------------------------- 2. verb tables

const CATEGORIES = ['read', 'readImage', 'write', 'search', 'edit', 'commands', 'code', 'webSearch', 'webFetch', 'subagents', 'plan', 'questions', 'tools']

test('verb tables cover every category in both locales and both states', () => {
  for (const locale of ['zh', 'en']) {
    const L = labels(locale)
    // stepCount is retired: the desktop titles carry no counts (processTitle),
    // and the card title follows the plain done-phrase. The generated STEP
    // table (message.stepProcess.*) is the single narration source instead.
    for (const table of ['stepVerbs', 'stepDone']) {
      assert.ok(L[table], `${locale}: ${table} must exist`)
      assert.deepEqual(Object.keys(L[table]).sort(), [...CATEGORIES].sort(), `${locale}: ${table} covers exactly the narration categories`)
      for (const key of CATEGORIES) {
        assert.ok(String(L[table][key]).length > 0, `${locale}: ${table}.${key} must be non-empty`)
      }
    }
    assert.equal(L.stepCount, undefined, 'the self-invented count table is retired')
    assert.ok(L.toolRaw, `${locale}: the raw-details summary must exist`)
    assert.ok(L.diffMore.includes('{n}'), `${locale}: the elision row must carry the {n} slot`)
  }
})

test('the zh verbs quote the Host stepProcess table verbatim', () => {
  const L = labels('zh')
  assert.equal(L.stepVerbs.read, '正在读取文件')
  assert.equal(L.stepVerbs.readImage, '正在读取图片')
  assert.equal(L.stepVerbs.write, '正在写入文件')
  assert.equal(L.stepVerbs.search, '正在搜索代码')
  assert.equal(L.stepVerbs.edit, '正在编辑文件')
  assert.equal(L.stepVerbs.commands, '正在运行命令')
  assert.equal(L.stepVerbs.code, '正在运行代码')
  assert.equal(L.stepVerbs.webSearch, '正在搜索网页')
  assert.equal(L.stepVerbs.webFetch, '正在访问网页')
  assert.equal(L.stepVerbs.subagents, '正在协调子智能体')
  assert.equal(L.stepVerbs.plan, '正在更新计划')
  assert.equal(L.stepVerbs.questions, '等待你的操作')
  assert.equal(L.stepVerbs.tools, '正在调用工具')
  assert.equal(L.stepDone.edit, '修改了文件', 'the Host past tense for edit is 修改了文件, not 已编辑文件')
  assert.equal(L.stepDone.commands, '执行了命令')
  assert.equal(L.stepDone.code, '运行了代码')
  assert.equal(L.stepDone.plan, '更新了计划')
  assert.equal(L.stepDone.questions, '向用户提出了问题')
  assert.equal(L.toolRaw, '查看技术详情', 'the Host word for the raw fold')
})

test('the en verbs quote the Host stepProcess table verbatim', () => {
  const L = labels('en')
  assert.equal(L.stepVerbs.commands, 'Running commands')
  assert.equal(L.stepDone.edit, 'Edited files')
  assert.equal(L.stepDone.commands, 'Ran commands')
  assert.equal(L.stepDone.questions, 'Asked questions')
  assert.equal(L.stepDone.tools, 'Called tools')
  assert.equal(L.toolRaw, 'View technical details')
})

// ------------------------------------------------------- 3. diff line split

test('diffLineSplit trims the common head and tail so the middle is the edit', () => {
  const { diffLineSplit } = renderSandbox('zh')
  assert.deepEqual(diffLineSplit('a\nb\nc', 'a\nX\nc'), { del: ['b'], add: ['X'] })
  assert.deepEqual(diffLineSplit('a\nb', 'a\nb\nc'), { del: [], add: ['c'] }, 'pure insertion removes nothing')
  assert.deepEqual(diffLineSplit('a\nb\nc', 'a\nc'), { del: ['b'], add: [] }, 'pure deletion adds nothing')
  assert.deepEqual(diffLineSplit('same', 'same'), { del: [], add: [] }, 'identical text splits to nothing')
  assert.deepEqual(diffLineSplit('a\r\nb', 'a\nB'), { del: ['b'], add: ['B'] }, 'CRLF normalises to LF before splitting')
  assert.deepEqual(diffLineSplit('', 'x'), { del: [''], add: ['x'] }, "an empty old string is ONE empty line, so it shows as a removed blank row")
})

// ------------------------------------------------------- 4. summary line

test('toolSummaryLine reduces a call to its primary argument', () => {
  const { toolSummaryLine } = renderSandbox('zh')
  assert.equal(toolSummaryLine('read', { file_path: 'F:\\defws\\deep\\nest\\a.ts' }), 'a.ts', 'windows paths collapse to the basename')
  assert.equal(toolSummaryLine('read', { file_path: '/var/log/app.log' }), 'app.log', 'posix paths too')
  assert.equal(toolSummaryLine('bash', { command: 'npm test -- --watch' }), 'npm test -- --watch')
  assert.equal(toolSummaryLine('bash', { command: 'x'.repeat(80) }), 'x'.repeat(60) + '…', 'long commands clip at 60')
  assert.equal(toolSummaryLine('bash', { command: 'echo  a\n\n  b' }), 'echo a b', 'whitespace collapses to one line')
  assert.equal(toolSummaryLine('web_fetch', { url: 'https://example.com/x' }), 'https://example.com/x')
  assert.equal(toolSummaryLine('read', '{}'), '', 'no recognisable argument, no invented summary')
  assert.equal(toolSummaryLine('read', 'not json'), '', 'unparsable string args degrade to empty')
  assert.equal(toolSummaryLine('read', '{"file_path":"C:\\\\x\\\\y.md"}'), 'y.md', 'string-encoded args parse first')
})

// ------------------------------------------------------- 5. clustering

test('clusterToolBlocks merges consecutive same-category calls only', () => {
  const { clusterToolBlocks } = renderSandbox('zh')
  const threeReads = [tool('read', 'done'), tool('read', 'done'), tool('read', 'done')]
  const merged = clusterToolBlocks(threeReads, toolActivityCategory)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].items.length, 3)
  assert.equal(merged[0].category, 'read')

  const mixed = [tool('read', 'done'), tool('bash', 'done'), tool('read', 'done')]
  const cut = clusterToolBlocks(mixed, toolActivityCategory)
  assert.equal(cut.length, 3, 'a different category cuts the run')
  assert.deepEqual(cut.map((entry) => entry.category), ['read', 'commands', 'read'])

  const reasoningBetween = [tool('read', 'done'), think('hm'), tool('read', 'done')]
  const broken = clusterToolBlocks(reasoningBetween, toolActivityCategory)
  assert.equal(broken.length, 3, 'reasoning breaks a run and rides along as its own entry')
  assert.equal(broken[1].type, 'block')
})

test('clusterToolBlocks never merges questions or subagents', () => {
  const { clusterToolBlocks } = renderSandbox('zh')
  const twoQuestions = [tool('ask_user_question', 'done'), tool('ask_user_question', 'done')]
  const questions = clusterToolBlocks(twoQuestions, toolActivityCategory)
  assert.equal(questions.length, 2, 'each approval stands alone')

  const twoSubagents = [tool('subagent', 'done'), tool('subagent', 'done')]
  assert.equal(clusterToolBlocks(twoSubagents, toolActivityCategory).length, 2, 'each delegation stands alone')

  const run = [tool('read', 'done'), tool('read', 'done'), tool('subagent', 'done'), tool('read', 'done'), tool('read', 'done')]
  const shaped = clusterToolBlocks(run, toolActivityCategory)
  assert.deepEqual(shaped.map((entry) => entry.items.length), [2, 1, 2], 'the subagent splits the read run')
})

test('cluster entries carry original indexes so expansion keys stay stable', () => {
  const { clusterToolBlocks } = renderSandbox('zh')
  const shaped = clusterToolBlocks([think('a'), tool('read', 'done'), tool('read', 'done')], toolActivityCategory)
  assert.equal(shaped[0].index, 0)
  assert.deepEqual(shaped[1].items.map((item) => item.index), [1, 2])
})

// ------------------------------------------------------- 6. rendered verbs

test('a single tool card speaks the verb, not the tool name', () => {
  const { renderBlock } = renderSandbox('zh')
  const running = renderBlock(tool('read', 'running', { file_path: '/x/a.ts' }), false, 'k1')
  assert.ok(running.includes('正在读取文件'), 'the in-progress verb is the title')
  assert.ok(running.includes('data-state="running"'), 'the state rides data-state for the sweep animation')
  assert.ok(!running.includes('>read<'), 'the raw tool name leaves the title')

  const done = renderBlock(tool('read', 'done', { file_path: '/x/a.ts' }), false, 'k2')
  assert.ok(done.includes('已读取文件'), 'the past-tense verb is the title')
  assert.ok(done.includes('data-state="done"'))

  const failed = renderBlock(tool('edit', 'error', { file_path: '/x/a.ts', old_string: 'a', new_string: 'b' }), false, 'k3')
  assert.ok(failed.includes('修改了文件'), 'errors keep the Host past tense')
  assert.ok(failed.includes('失败'), 'and carry the failure word in the status slot')
  assert.ok(failed.includes('data-state="error"'))

  const unknown = renderBlock(tool('brand_new_plugin_tool', 'running', {}), false, 'k4')
  assert.ok(unknown.includes('正在调用工具'), 'unknown tools speak the generic verb')

  const en = renderSandbox('en').renderBlock(tool('read', 'done', { file_path: '/x/a.ts' }), false, 'k5')
  assert.ok(en.includes('Read files'), 'the english page speaks the english verbs')
})

test('the raw JSON demotes to a second technical-details fold', () => {
  const { renderBlock } = renderSandbox('zh')
  const html = renderBlock(tool('read', 'done', { file_path: '/x/a.ts' }, 'file body'), false, 'k1')
  assert.ok(html.includes('<details class="tool-raw">'), 'the raw fold is a nested details')
  assert.ok(html.includes('查看技术详情'), 'with the Host summary word')
  assert.ok(html.includes('file_path'), 'the raw args still live inside it')
  assert.ok(html.includes('file body'), 'so does the raw result')
})

test('an edit renders the red/green diff at the head of the body', () => {
  const { renderBlock } = renderSandbox('zh')
  const html = renderBlock(tool('edit', 'done', {
    file_path: '/x/a.ts',
    old_string: 'const a = 1\nconst b = 2',
    new_string: 'const a = 1\nconst b = 3\nconst c = 4',
  }), false, 'k1')
  assert.ok(html.includes('diff-line-del'), 'removed rows carry the del class')
  assert.ok(html.includes('diff-line-add'), 'added rows carry the add class')
  assert.ok(html.includes('const b = 2'), 'the removed line is visible')
  assert.ok(html.includes('const c = 4'), 'the added line is visible')
  assert.ok(!html.includes('const a = 1\n'), 'the unchanged head is trimmed away')
  const del = html.indexOf('diff-line-del'), add = html.indexOf('diff-line-add')
  assert.ok(del < add, 'deletions render above additions')
})

test('a write renders a green-only preview capped at 60 lines', () => {
  const { renderBlock } = renderSandbox('zh')
  const short = renderBlock(tool('write', 'done', { file_path: '/x/new.ts', content: 'line1\nline2' }), false, 'k1')
  assert.ok(short.includes('diff-line-add'), 'new content shows green')
  assert.ok(!short.includes('diff-line-del'), 'a write deletes nothing')
  const long = renderBlock(tool('write', 'done', { file_path: '/x/new.ts', content: Array.from({ length: 90 }, (_, i) => 'row' + i).join('\n') }), false, 'k2')
  assert.ok(long.includes('diff-elide'), 'the over-cap preview elides')
  assert.ok(long.includes('30'), 'the elision row names the hidden line count')
  const diffOnly = long.slice(0, long.indexOf('tool-raw'))
  assert.ok(diffOnly.includes('row59'), 'the first 60 lines survive')
  assert.ok(!diffOnly.includes('row60'), 'line 61 does not (the raw fold keeps the full truth, the diff does not)')
})

test('a >40-line edit elides its middle with a count', () => {
  const { renderBlock } = renderSandbox('zh')
  const oldLines = Array.from({ length: 30 }, (_, i) => 'old' + i)
  const newLines = Array.from({ length: 30 }, (_, i) => 'new' + i)
  const html = renderBlock(tool('edit', 'done', { old_string: oldLines.join('\n'), new_string: newLines.join('\n') }), false, 'k1')
  assert.ok(html.includes('diff-elide'), 'the middle folds away')
  assert.ok(html.includes('20'), 'the elision names how many rows hid')
  const diffOnly = html.slice(0, html.indexOf('tool-raw'))
  assert.ok(diffOnly.includes('old0') && diffOnly.includes('new29'), 'head and tail survive')
  assert.ok(diffOnly.includes('old19') && diffOnly.includes('new10'), 'the kept 20 + 20 rows reach the fold line')
  assert.ok(!diffOnly.includes('old25') && !diffOnly.includes('new3'), 'the hidden middle stays hidden (the raw fold keeps the full truth)')
})

// ------------------------------------------------------- 7. rendered clusters

function turnOf(locale, blocks) {
  return renderSandbox(locale).renderTurnProcess({ turnKey: '7', streaming: false, blocks })
}

// Desktop processTitle port: the fold's summary title joins the top-3
// categories' done-phrases without counts, exactly like dsh-client-ui-chat.
test('the fold title is the count-free top-3 join, desktop phrasing', () => {
  const { renderTurnProcess } = renderSandbox('zh')
  const one = renderTurnProcess({ turnKey: 'a', streaming: false, blocks: [tool('read', 'done', { file_path: '/w/a' })] })
  assert.ok(one.includes('已读取文件'), 'one category speaks its done-phrase only')
  const two = renderTurnProcess({ turnKey: 'b', streaming: false, blocks: [
    tool('read', 'done', { file_path: '/w/a' }),
    tool('edit', 'done', { file_path: '/w/a', old_string: 'x', new_string: 'y' }),
  ] })
  assert.ok(two.includes('已读取文件并修改了文件'), 'two categories join with joinTwo and strip the shared 已 prefix')
  const three = renderTurnProcess({ turnKey: 'c', streaming: false, blocks: [
    tool('read', 'done', { file_path: '/w/a' }),
    tool('edit', 'done', { file_path: '/w/a', old_string: 'x', new_string: 'y' }),
    tool('bash', 'done', { command: 'npm test' }),
  ] })
  assert.ok(three.includes('已读取文件，修改了文件，执行了命令'), 'three categories join with the zh comma')
  const four = renderTurnProcess({ turnKey: 'd', streaming: false, blocks: [
    tool('read', 'done', { file_path: '/w/a' }),
    tool('edit', 'done', { file_path: '/w/a', old_string: 'x', new_string: 'y' }),
    tool('bash', 'done', { command: 'npm test' }),
    tool('read_image', 'done', { file_path: '/w/i.png' }),
  ] })
  assert.ok(four.includes('等</span>'), 'a fourth category wraps the title in the more-template')
})

test('three reads collapse into one card with a row per file', () => {
  const html = turnOf('zh', [
    tool('read', 'done', { file_path: '/w/src/a.ts' }),
    tool('read', 'done', { file_path: '/w/src/b.ts' }),
    tool('read', 'done', { file_path: '/w/src/c.ts' }),
  ])
  assert.equal(html.split('class="tool change-cluster"').length - 1, 1, 'one card for the whole run')
  // Desktop wording has no counts on the card title (processTitle uses plain
  // done-phrases); the per-file rows below the fold are the count.
  assert.ok(html.includes('已读取文件'), 'the title is the Host done-phrase, count-free')
  assert.equal(html.split('cluster-row').length - 1 >= 3, true, 'three rows')
  for (const name of ['a.ts', 'b.ts', 'c.ts']) assert.ok(html.includes(name), `${name} gets its row`)
})

test('a mixed turn cuts into per-category cards with Host count phrasing', () => {
  const html = turnOf('zh', [
    tool('read', 'done', { file_path: '/w/a.ts' }),
    tool('read', 'done', { file_path: '/w/b.ts' }),
    tool('bash', 'done', { command: 'npm test' }),
    tool('bash', 'done', { command: 'npm lint' }),
    tool('bash', 'done', { command: 'npm build' }),
    tool('edit', 'done', { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' }),
  ])
  assert.equal(html.split('class="tool change-cluster"').length - 1, 3, 'reads, commands and the edit each get a card')
  assert.ok(html.includes('执行了命令'), 'the commands card speaks the count-free Host done-phrase')
  assert.ok(html.includes('修改了文件'), 'a single edit keeps the plain past tense')
})

test('the en page counts in english', () => {
  const html = turnOf('en', [tool('read', 'done', { file_path: '/w/a.ts' }), tool('read', 'done', { file_path: '/w/b.ts' })])
  assert.ok(html.includes('Read files'), 'the en title is the count-free Host done-phrase')
})

test('merged edit clusters fold each row into its own diff', () => {
  const html = turnOf('zh', [
    tool('edit', 'done', { file_path: '/w/a.ts', old_string: 'a1', new_string: 'a2' }),
    tool('edit', 'done', { file_path: '/w/b.ts', old_string: 'b1', new_string: 'b2' }),
  ])
  assert.ok(html.includes('修改了文件'), 'the count-free Host done-phrase title')
  assert.equal(html.split('details class="cluster-row"').length - 1, 2, 'each edit row is its own expander')
  assert.ok(html.includes('diff-line-del'), 'and carries its diff')
})

test('a live turn narrates the last cluster in the in-progress tense', () => {
  const sandbox = renderSandbox('zh')
  const html = sandbox.renderTurnProcess({
    turnKey: '9',
    streaming: true,
    blocks: [tool('read', 'done', { file_path: '/w/a.ts' }), tool('bash', 'running', { command: 'npm test' })],
  })
  assert.ok(html.includes('turn-process-live'), 'the live container shape is unchanged')
  assert.ok(html.includes('已读取文件'), 'the settled call speaks past tense even mid-turn')
  assert.ok(html.includes('正在运行命令'), 'the running call speaks the in-progress verb')
  assert.ok(!html.includes('已调用'), 'no past tense leaks onto the running call')
})

test('a pending question still hides while its composer owns the floor', () => {
  const js = assets.zh.js
  const names = ['toolActivityCategory', 'clusterToolBlocks', 'renderBlock', 'toolClusterState', 'toolArgsOf', 'diffRowsHtml', 'renderToolDiff', 'renderToolRaw', 'renderToolCard']
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  const sandbox = new Function(
    'L', 'activeSession',
    `${body};
     const esc=v=>String(v==null?'':v)
     const markdown=t=>String(t||'')
     const pretty=v=>String(v||'')
     function activityIcon(){return '<i></i>'}
     function activityChevron(){return '<c></c>'}
     const turnOpenState=new Map()
     const transcriptView='verbose'
     const pendingQuestion={rpcId:'q1'}
     return { renderBlock }`,
  )(labels('zh'), 's1')
  const html = sandbox.renderBlock(tool('ask_user_question', 'running', {}), false, 'k1')
  assert.equal(html, '', 'the hidden question block stays hidden — the composer replaces it')
})

// ------------------------------------------------------- 8. stylesheet

// A-档 (2026-10-11): the phone fold shows the CATEGORY plus a count and nothing
// else — no file names, no commands, no diff rows, no raw JSON — unless the
// reader opts into 'verbose'. The data is still fetched; only the paint is thin.
function briefSandbox(locale, view) {
  const js = assets[locale].js
  const names = [
    'toolActivityCategory', 'diffLineSplit', 'toolSummaryLine', 'clusterToolBlocks', 'stepTitleFor',
    'renderBlock', 'toolClusterState', 'toolArgsOf', 'diffRowsHtml', 'renderToolDiff',
    'renderToolRaw', 'renderToolCard', 'renderTurnProcess', 'pretty',
  ]
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  return new Function(
    'L', 'STEP', 'transcriptView', 'activeSession',
    `${body};
     const esc=v=>String(v==null?'':v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
     const markdown=text=>String(text||'')
     function activityIcon(){return '<i class="icon"></i>'}
     function activityChevron(){return '<c></c>'}
     function reasoningSummary(){return ''}
     const turnOpenState=new Map()
     const pendingQuestion=null
     return { renderTurnProcess, renderToolCard }`,
  )(labels(locale), STEP_TABLE(locale), view, 's1')
}

test('A-tier: the card paints a count, never the subjects it touched', () => {
  const html = briefSandbox('zh', 'standard').renderTurnProcess({
    turnKey: 'A1',
    streaming: false,
    blocks: [
      tool('read', 'done', { file_path: '/secret/project/src/salary-ledger.ts' }, 'ledger body'),
      tool('read', 'done', { file_path: '/secret/project/src/payroll.sql' }),
      tool('read', 'done', { file_path: '/secret/project/src/tax-grid.ts' }),
    ],
  })
  assert.ok(html.includes('已读取文件'), 'the category still names what happened')
  assert.ok(html.includes('3 次'), 'and how many times it happened')
  for (const leak of ['salary-ledger.ts', 'payroll.sql', 'tax-grid.ts', 'secret', 'ledger body', 'file_path']) {
    assert.ok(!html.includes(leak), `the ${leak} never reaches the phone screen`)
  }
  assert.ok(!html.includes('diff-line'), 'no diff rows are computed for the fold')
  assert.ok(!html.includes('tool-raw'), 'neither does the raw JSON fold')
})

test('A-tier: the tool name and its arguments stay off a single-call card too', () => {
  const html = briefSandbox('zh', 'standard').renderTurnProcess({
    turnKey: 'A2',
    streaming: false,
    blocks: [tool('bash', 'done', { command: 'rm -rf /Users/toast/private' }, 'removed')],
  })
  assert.ok(html.includes('执行了命令'), 'the category names the action')
  assert.ok(!html.includes('rm -rf'), 'the command itself is not painted')
  assert.ok(!html.includes('private'), 'neither is what it pointed at')
})

test('A-tier: a failed card still says it failed', () => {
  const html = briefSandbox('zh', 'standard').renderTurnProcess({
    turnKey: 'A3',
    streaming: false,
    blocks: [tool('edit', 'error', { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' })],
  })
  assert.ok(html.includes('失败'), 'failure is still legible without the body')
  assert.ok(!html.includes('a.ts'), 'but the failing file stays unnamed')
})

test('A-tier: verbose is the opt-in that puts the detail back', () => {
  const blocks = [tool('read', 'done', { file_path: '/w/a.ts' }, 'file body')]
  const brief = briefSandbox('zh', 'standard').renderTurnProcess({ turnKey: 'A4', streaming: false, blocks })
  const verbose = briefSandbox('zh', 'verbose').renderTurnProcess({ turnKey: 'A4', streaming: false, blocks })
  assert.ok(!brief.includes('a.ts'), 'standard hides it')
  assert.ok(verbose.includes('a.ts'), 'verbose shows it again')
  assert.ok(verbose.includes('file body'), 'result text included')
  assert.ok(verbose.includes('tool-raw'), 'and the technical-details fold returns')
})

test('the stylesheet carries the new organs with token-only colors', () => {
  const { css } = assets.zh
  assert.ok(css.includes('.change-cluster'), 'the cluster card class exists')
  assert.ok(css.includes('.tool-raw'), 'the raw fold class exists')
  assert.ok(css.includes('.diff-line-del'), 'the del class exists')
  assert.ok(css.includes('.diff-line-add'), 'the add class exists')
  const diffBlock = css.slice(css.indexOf('.diff-line{'))
  assert.ok(diffBlock.includes('var(--surface)'), 'diff backgrounds mix onto the theme surface, not a hardcoded color')
  assert.ok(css.includes('.cluster-row-text'), 'rows have their own style')
  assert.ok(css.includes('.diff-elide'), 'the elision row has its own style')
})
