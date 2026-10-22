// Process narration rework (change 2026-10-21-feat-pocket-process-line-flatten).
// The phone now shows ONE flat, non-tappable line per run of same-category tool
// work — "已读取文件 3 次，正在修改文件" — instead of the desktop's collapsible
// 过程 fold, and it shows exactly that shape for every reader: the four desktop
// display tiers (transcriptView) no longer reach the phone at all.
// Layers proven here:
//   1. the name→category mapping is TOTAL over the Host's tool universe
//      (extracted from app.asar TOOL_TITLE_KEYS / TOOL_VARIANTS / activity(),
//      2026-10-07) and a verbatim port of the Host's own rules;
//   2. the verb tables (zh+en) cover every category with both states;
//   3. processLineText aggregates counts per category in arrival order, speaks
//      the running verb last, and marks a failed category;
//   4. clusterToolBlocks merges consecutive same-category calls and never
//      merges questions/subagents;
//   5. the renderer paints the verbs on a plain div — never a <details>, never
//      a tool name, never an argument or a result, on any tier (there is no
//      other tier); thinking renders always and starts closed;
//   6. the status row carries the elapsed clock and the model-retry notice, and
//      the retry count rides into the turn-error banner.
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

// The render sandbox: the two pure line-builders plus the render organs, over
// stub DOM neighbours. Nothing on the tool path touches markdown.
function renderSandbox(locale) {
  const js = assets[locale].js
  const names = [
    'toolActivityCategory', 'processLineText', 'clusterToolBlocks',
    'renderBlock', 'processRows', 'processLineHtml', 'renderProcessLine', 'formatElapsed', 'pad2',
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
     const pendingQuestion=null
     return { renderBlock, renderProcessLine, processLineText, clusterToolBlocks, toolActivityCategory, formatElapsed }`,
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
  // The Host's own precedence, ported: exact names before wildcard families.
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
  assert.ok(categories.size >= 10, 'the universe must actually exercise most of the table')
})

test('mapping follows the Host wildcard families', () => {
  assert.equal(toolActivityCategory('terminal_open'), 'commands')
  assert.equal(toolActivityCategory('terminal_signal'), 'commands')
  assert.equal(toolActivityCategory('subagent_spawn'), 'subagents')
  assert.equal(toolActivityCategory('cordis_package_inspect'), 'search')
})

test('an unmapped tool falls back to the generic category, never a blank', () => {
  assert.equal(toolActivityCategory('brand_new_plugin_tool'), 'tools')
  assert.equal(toolActivityCategory(''), 'tools')
})

// ------------------------------------------------------- 2. verb tables

const CATEGORIES = ['read', 'readImage', 'write', 'search', 'edit', 'commands', 'code', 'webSearch', 'webFetch', 'subagents', 'plan', 'questions', 'tools']

test('the verb tables cover every category in both locales and both states', () => {
  for (const locale of ['zh', 'en']) {
    const L = labels(locale)
    for (const table of ['stepVerbs', 'stepDone']) {
      assert.ok(L[table], `${locale}: ${table} must exist`)
      assert.deepEqual(Object.keys(L[table]).sort(), [...CATEGORIES].sort(), `${locale}: ${table} must cover exactly the mapped categories`)
    }
    assert.ok(L.processSep, `${locale}: the join separator must exist`)
    assert.ok(L.toolCount.includes('{count}'), `${locale}: the count template needs its slot`)
    assert.ok(L.toolFailedCount.includes('{count}'), `${locale}: the failure breakdown needs its slot`)
  }
})

test('the zh verbs are the Host desktop phrasing, verbatim', () => {
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
  assert.equal(L.stepDone.edit, '修改了文件')
  assert.equal(L.stepDone.commands, '执行了命令')
  assert.equal(L.stepDone.code, '运行了代码')
  assert.equal(L.stepDone.plan, '更新了计划')
  assert.equal(L.stepDone.questions, '向用户提出了问题')
})

test('the en verbs carry the english phrasing', () => {
  const L = labels('en')
  assert.equal(L.stepVerbs.commands, 'Running commands')
  assert.equal(L.stepDone.edit, 'Edited files')
  assert.equal(L.stepDone.commands, 'Ran commands')
  assert.equal(L.stepDone.questions, 'Asked questions')
  assert.equal(L.stepDone.tools, 'Called tools')
})

// ------------------------------------------------------- 3. the line text

test('processLineText counts per category, in arrival order, running last', () => {
  const { processLineText } = renderSandbox('zh')
  const L = labels('zh')
  const pack = (rows) => processLineText(rows, { verbs: L.stepVerbs, done: L.stepDone, sep: L.processSep, count: L.toolCount, failedTemplate: L.toolFailedCount })
  assert.equal(pack([{ category: 'read', count: 1 }]), '已读取文件', 'a lone call never shows a count')
  assert.equal(pack([{ category: 'read', count: 3 }]), '已读取文件 3 次', 'a run carries its count')
  assert.equal(
    pack([{ category: 'read', count: 3 }, { category: 'edit', count: 1, running: true }]),
    '已读取文件 3 次，正在编辑文件',
    'what is still going rides the end of the line',
  )
  assert.equal(pack([{ category: 'edit', count: 1, running: true }]), '正在编辑文件', 'before anything settles, the line is the verb alone')
  assert.equal(
    pack([{ category: 'tools', count: 1, failed: true, failedCount: 1 }]),
    '已调用工具（失败 1 次）',
    'a lone failure still says how many broke',
  )
  assert.equal(
    pack([{ category: 'tools', count: 5, failed: true, broken: 2 }]),
    '已调用工具 5 次（失败 2 次）',
    '2026-10-22 m02802: the count is the whole run, the breakdown rides in brackets',
  )
  assert.equal(
    pack([{ category: 'tools', count: 5, failed: true }]),
    '已调用工具 5 次（失败 1 次）',
    'without a breakdown the mark counts the entry as one broken call, never the whole run',
  )
  assert.equal(
    pack([{ category: 'tools', count: 1, failed: true, broken: 1 }, { category: 'tools', count: 2, failed: true, broken: 1 }]),
    '已调用工具 3 次（失败 2 次）',
    'two rows of one category add their totals AND their breakdowns',
  )
  assert.equal(
    pack([{ category: 'read', count: 2 }, { category: 'commands', count: 1 }, { category: 'webSearch', count: 4 }]),
    '已读取文件 2 次，执行了命令，已搜索网页 4 次',
    'three categories join on the separator, no top-three truncation — the phone shows the whole line',
  )
  assert.equal(
    pack([{ category: 'read', count: 1 }, { category: 'read', count: 2 }]),
    '已读取文件 3 次',
    'the same category twice in the rows adds up instead of repeating',
  )
})

test('processLineText survives nonsense input without inventing words', () => {
  const { processLineText } = renderSandbox('zh')
  assert.equal(processLineText(null, null), '')
  assert.equal(processLineText([], {}), '')
  assert.equal(processLineText([null, { category: '' }], {}), '', 'no category, no phrase')
  const L = labels('en')
  assert.equal(
    processLineText([{ category: 'unknown_cat', count: 2 }], { done: L.stepDone, count: L.toolCount }),
    'unknown_cat 2 times'.replace('unknown_cat', 'Called tools'),
    'an unmapped category falls back to the generic done phrase',
  )
})

// ------------------------------------------------------- 4. clustering

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
  assert.equal(clusterToolBlocks(twoQuestions, toolActivityCategory).length, 2, 'each approval stands alone')

  const twoSubagents = [tool('subagent', 'done'), tool('subagent', 'done')]
  assert.equal(clusterToolBlocks(twoSubagents, toolActivityCategory).length, 2, 'each delegation stands alone')

  const run = [tool('read', 'done'), tool('read', 'done'), tool('subagent', 'done'), tool('read', 'done'), tool('read', 'done')]
  const shaped = clusterToolBlocks(run, toolActivityCategory)
  assert.deepEqual(shaped.map((entry) => entry.items.length), [2, 1, 2], 'the subagent splits the read run')
})

test('cluster entries carry original indexes so keys stay stable', () => {
  const { clusterToolBlocks } = renderSandbox('zh')
  const shaped = clusterToolBlocks([think('a'), tool('read', 'done'), tool('read', 'done')], toolActivityCategory)
  assert.equal(shaped[0].index, 0)
  assert.deepEqual(shaped[1].items.map((item) => item.index), [1, 2])
})

// ------------------------------------------------------- 5. the painted line

test('a single tool call speaks the verb, never the tool name', () => {
  const { renderBlock } = renderSandbox('zh')
  const running = renderBlock(tool('read', 'running', { file_path: '/x/a.ts' }), false, 'k1')
  assert.ok(running.includes('正在读取文件'), 'the in-progress verb is the whole title')
  assert.ok(running.includes('data-state="running"'), 'the state rides data-state for the sweep animation')
  assert.ok(!running.includes('>read<'), 'the raw tool name leaves the screen')

  const done = renderBlock(tool('read', 'done', { file_path: '/x/a.ts' }), false, 'k2')
  assert.ok(done.includes('已读取文件'), 'the past-tense verb is the title')
  assert.ok(done.includes('data-state="done"'))

  const failed = renderBlock(tool('edit', 'error', { file_path: '/x/a.ts', old_string: 'a', new_string: 'b' }), false, 'k3')
  assert.ok(failed.includes('修改了文件'), 'errors keep the Host past tense')
  assert.ok(failed.includes('失败'), 'and carry the failure word')
  assert.ok(failed.includes('data-state="error"'))

  const unknown = renderBlock(tool('brand_new_plugin_tool', 'running', {}), false, 'k4')
  assert.ok(unknown.includes('正在调用工具'), 'unknown tools speak the generic verb')

  const en = renderSandbox('en').renderBlock(tool('read', 'done', { file_path: '/x/a.ts' }), false, 'k5')
  assert.ok(en.includes('Read files'), 'the english page speaks the english verbs')
})

test('the process line is a plain div — not openable, not a menu', () => {
  const { renderBlock } = renderSandbox('zh')
  const html = renderBlock(tool('read', 'done', { file_path: '/x/a.ts' }), false, 'k1')
  assert.ok(html.startsWith('<div class="process-line"'), `the line is a div: ${html.slice(0, 60)}`)
  assert.ok(!html.includes('<details'), 'no fold anywhere on the line')
  assert.ok(!html.includes('summary'), 'no summary, so nothing to tap')
  assert.ok(!html.includes('activity-chevron'), 'and no chevron to suggest one')
})

test('nothing the tool touched reaches the phone — arguments and results stay unpainted', () => {
  const { renderBlock } = renderSandbox('zh')
  const html = renderBlock(tool('read', 'done', { file_path: '/secret/project/src/salary-ledger.ts' }, 'ledger body'), false, 'k1')
  for (const leak of ['salary-ledger.ts', 'secret', 'ledger body', 'file_path', 'diff-line', 'tool-raw', '查看技术详情']) {
    assert.ok(!html.includes(leak), `the ${leak} never reaches the phone screen`)
  }
  const command = renderBlock(tool('bash', 'done', { command: 'rm -rf /Users/toast/private' }, 'removed'), false, 'k2')
  assert.ok(command.includes('执行了命令'), 'the category names the action')
  assert.ok(!command.includes('rm -rf'), 'the command itself is not painted')
  assert.ok(!command.includes('private'), 'neither is what it pointed at')
})

test('a run of three reads is one line with the count on it', () => {
  const { renderProcessLine } = renderSandbox('zh')
  const html = renderProcessLine({
    category: 'read',
    items: [
      { block: tool('read', 'done', { file_path: '/w/src/a.ts' }), index: 0 },
      { block: tool('read', 'done', { file_path: '/w/src/b.ts' }), index: 1 },
      { block: tool('read', 'done', { file_path: '/w/src/c.ts' }), index: 2 },
    ],
  }, false)
  assert.ok(html.includes('已读取文件 3 次'), 'the merged run counts itself on the line')
  assert.equal(html.split('class="process-line"').length - 1, 1, 'one line for the whole run')
  for (const name of ['a.ts', 'b.ts', 'c.ts']) assert.ok(!html.includes(name), `${name} never appears`)
})

test('a mixed turn cuts into one line per category, in arrival order', () => {
  const { renderProcessLine } = renderSandbox('zh')
  const line = (category, status, count) => renderProcessLine({
    category,
    items: Array.from({ length: count }, () => ({ block: tool('x', status), index: 0 })),
  }, status === 'running')
  const reads = line('read', 'done', 2)
  const commands = line('commands', 'done', 3)
  const edit = line('edit', 'running', 1)
  assert.ok(reads.includes('已读取文件 2 次'))
  assert.ok(commands.includes('执行了命令 3 次'))
  assert.ok(edit.includes('正在编辑文件'), 'the live category speaks the in-progress tense')
  assert.ok(edit.includes('data-live="1"'), 'and marks itself live for the sweep')
})

test('a pending question still hides while its composer owns the floor', () => {
  const js = assets.zh.js
  const names = ['toolActivityCategory', 'processLineText', 'clusterToolBlocks', 'renderBlock', 'processRows', 'processLineHtml', 'renderProcessLine']
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  const sandbox = new Function(
    'L', 'activeSession',
    `${body};
     const esc=v=>String(v==null?'':v)
     const markdown=t=>String(t||'')
     function activityIcon(){return '<i></i>'}
     function activityChevron(){return '<c></c>'}
     function reasoningSummary(){return ''}
     const turnOpenState=new Map()
     const pendingQuestion={rpcId:'q1'}
     return { renderBlock }`,
  )(labels('zh'), 's1')
  const html = sandbox.renderBlock(tool('ask_user_question', 'running', {}), false, 'k1')
  assert.equal(html, '', 'the hidden question block stays hidden — the composer replaces it')
})

// ------------------------------------------------------- 6. thinking

test('thinking always renders, even after the turn settles, and starts closed', () => {
  const js = assets.zh.js
  const reasoning = extractFunction(js, 'renderBlock')
  assert.ok(!reasoning.includes("transcriptView==='compact'"), 'no display tier may delete the thinking block')
  assert.ok(!reasoning.includes("transcriptView==='verbose'"), 'and no tier may auto-open it')
  assert.ok(reasoning.includes('open=held===true'), 'only a reader who opened it once keeps it open')
})

// ------------------------------------------------------- 7. the retired shape

test('the fold, the tiers and the detail organs are gone from the shipped script', () => {
  const { js } = assets.zh
  for (const dead of ['renderTurnProcess', 'renderToolCard', 'renderToolDiff', 'renderToolRaw', 'diffRowsHtml',
    'toolClusterState', 'toolArgsOf', 'stableLiveTitle', 'liveThinkingLine', 'stepTitleFor', 'transcriptView',
    'turn-process', 'cluster-rows', 'change-cluster', 'cluster-row', 'tool-raw', 'diff-line', 'diff-elide']) {
    assert.ok(!js.includes(dead), `${dead} must not survive in the page script`)
  }
})

// ------------------------------------------------------- 8. stylesheet

test('the stylesheet carries the flat line and drops the fold organs', () => {
  const { css } = assets.zh
  assert.ok(css.includes('.process-line'), 'the line class exists')
  assert.ok(css.includes('.process-line[data-state=error]'), 'and its failure tint')
  assert.ok(css.includes('.turn-status'), 'the status row is still styled')
  assert.ok(css.includes('[data-warn'), 'and it has its amber retry state')
  for (const dead of ['.turn-process', '.change-cluster', '.cluster-row', '.tool-raw', '.diff-line']) {
    assert.ok(!css.includes(dead), `${dead} must leave the stylesheet with its renderer`)
  }
})

test('the process line never animates under reduced motion', () => {
  const { css } = assets.zh
  const block = css.slice(css.indexOf('@media(prefers-reduced-motion:reduce)'))
  assert.ok(block.includes('.turn-status'), 'the status row is in the reduced-motion list')
  assert.ok(/\.process-line\[data-live\][^}]*\{animation:none|\.turn-status[^}]*\{animation:none/.test(block), 'the live sweep is switched off there')
})

// ------------------------------------------------------- 9. the status row

// The status row is the page's "am I still running?" signal: it beats with the
// elapsed clock, and while the host is retrying the model it says so.
function statusSandbox(locale) {
  const js = assets[locale].js
  const names = ['statusLabel', 'statusLineHtml', 'noteLlmRetry', 'formatElapsed', 'pad2', 'syncTurnStatusLabel']
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  const state = { stopPending: false, turnElapsedAt: 0, turnElapsedTurn: null, turnRetry: null, turnRetryMax: new Map(), pendingQuestion: null }
  const line = { textContent: '', dataset: {}, classList: { toggle() {} } }
  const box = { querySelector: (sel) => (sel === '.turn-status' ? line : null) }
  const sandbox = new Function(
    'L',
    'state',
    'box',
    `${body};
     const esc=v=>String(v==null?'':v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
     const $=()=>box
     const agentRunning=true
     function syncTurnStatus(){syncTurnStatusLabel()}
     let stopPending=state.stopPending,turnElapsedAt=state.turnElapsedAt,turnElapsedTurn=state.turnElapsedTurn,turnRetry=state.turnRetry,turnRetryMax=state.turnRetryMax,pendingQuestion=state.pendingQuestion
     return { read:()=>({stopPending,turnElapsedAt,turnElapsedTurn,turnRetry}), statusLabel, statusLineHtml, noteLlmRetry, syncTurnStatusLabel, set:(k,v)=>{if(k==='turnElapsedAt')turnElapsedAt=v;if(k==='stopPending')stopPending=v;if(k==='turnRetry')turnRetry=v}}`,
  )(labels(locale), state, box)
  return { sandbox, line }
}

test('the status row beats with the elapsed clock', () => {
  const { sandbox } = statusSandbox('zh')
  const L = labels('zh')
  sandbox.set('turnElapsedAt', 0)
  assert.equal(sandbox.statusLabel(), L.deepDiving, 'with no clock it is the plain waiting phrase')
  sandbox.set('turnElapsedAt', Date.now() - 12_000)
  const text = sandbox.statusLabel()
  assert.ok(text.startsWith(L.deepDivingFor.split('{')[0]), 'the waiting phrase leads')
  assert.match(text, /12秒/, 'and the elapsed time rides behind it, in the desktop duration words')
})

test('a model error replaces the waiting phrase while the retry is in flight', () => {
  const { sandbox, line } = statusSandbox('zh')
  const L = labels('zh')
  sandbox.noteLlmRetry({ retry: 2, maxRetries: 3, turn: 7, failure: { code: 'rate_limited', status: 429 } })
  const text = sandbox.statusLabel()
  assert.ok(text.includes('2/3'), `the retry count shows as n/m: ${text}`)
  assert.ok(text.includes(L.retryError.split('{')[0]), 'and names the model error')
  const html = sandbox.statusLineHtml()
  assert.ok(html.includes('data-warn="1"'), 'the amber state rides the node')
  sandbox.syncTurnStatusLabel()
  assert.equal(line.dataset.warn, '1', 'and lands on the live node')
})

test('a retry payload without a count still shows something', () => {
  const { sandbox } = statusSandbox('zh')
  sandbox.noteLlmRetry({ retry: 1, turn: 3, failure: { message: 'boom' } })
  const text = sandbox.statusLabel()
  assert.ok(text.includes('1/1'), `a bare retry repeats itself as 1/1: ${text}`)
  assert.ok(!text.includes('boom'), 'the raw provider message never paints on the status row')
})

test('a payload with no retry number is ignored', () => {
  const { sandbox } = statusSandbox('zh')
  sandbox.noteLlmRetry({ turn: 3 })
  assert.equal(sandbox.read().turnRetry, null, 'nothing to show, nothing remembered')
})

test('the retry counter is kept for the failure banner', () => {
  const { sandbox } = statusSandbox('zh')
  sandbox.noteLlmRetry({ retry: 3, maxRetries: 3, turn: 9, failure: { code: 'overloaded' } })
  assert.ok(sandbox.read().turnRetry, 'the row knows about it')
})

// ------------------------------------------------- 6. the whole turn, one line

// 2026-10-22 (m01708 ①②): the reader saw one line per tool and a sweep running
// under every thinking block that had already finished. Both come from the same
// function, so both are asserted through the real renderMessage.
function messageSandbox(locale) {
  const js = assets[locale].js
  const names = [
    'toolActivityCategory', 'processLineText', 'clusterToolBlocks', 'renderBlock',
    'processRows', 'processLineHtml', 'renderProcessLine', 'renderMessage',
  ]
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  return new Function(
    'L', 'STEP', 'activeSession',
    `${body};
     const esc=v=>String(v==null?'':v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
     const markdown=text=>String(text||'')
     function activityIcon(){return '<i class="icon"></i>'}
     function activityChevron(){return '<c></c>'}
     function reasoningSummary(){return ''}
     const turnOpenState=new Map()
     const pendingQuestion=null
     function renderMessageTail(){return ''}
     return { renderMessage, processRows }`,
  )(labels(locale), STEP_TABLE(locale), 's1')
}

// 2026-10-22 (m01925): the vertical stack the reader drew is
//   干了啥 / 思考 / 回复 / 干了啥 / 思考 / 回复 ...
// so the line covers ONE run of tool work (a segment). 2026-10-22 morning (m02105)
// then struck the "at the top" half: nothing is hoisted any more — a run of tools
// draws its line where that run arrived, thinking stays where it arrived.
test('one run of tool work is one line, where that run arrived', () => {
  const { renderMessage, processRows } = messageSandbox('zh')
  const tools = [
    tool('read', 'done', { file_path: '/w/a.ts' }),
    tool('read', 'done', { file_path: '/w/b.ts' }),
    tool('bash', 'done', { command: 'ls' }),
    tool('edit', 'running', { file_path: '/w/c.ts' }),
  ]
  assert.equal(processRows(tools).length, 3, 'one row per category, in first-appearance order')
  const html = renderMessage({ turnProcess: true, turnKey: 't1', streaming: true, blocks: [...tools, think('看一眼再改')] })
  assert.equal(html.split('class="process-line"').length - 1, 1, 'the run speaks through a single line')
  assert.ok(html.includes('已读取文件 2 次'), 'the finished reads fold into a count')
  assert.ok(html.includes('执行了命令'), 'so does the command')
  assert.ok(/正在编辑文件/.test(html), 'and the action in flight is written at the tail of that same line')
  assert.ok(html.indexOf('class="process-line"') < html.indexOf('class="thinking"'), 'tools first: the line comes before the thinking that followed them')
  assert.ok(!html.includes('a.ts'), 'no path rides along')
})

test('a thought that arrived before the tools is never pushed under them', () => {
  const { renderMessage } = messageSandbox('zh')
  const html = renderMessage({
    turnProcess: true,
    turnKey: 't1',
    streaming: false,
    blocks: [think('先想想'), tool('read', 'done', { file_path: '/w/a.ts' })],
  })
  assert.ok(html.indexOf('class="thinking"') < html.indexOf('class="process-line"'), 'arrival order stands: the fold is drawn first')
  assert.equal(html.split('class="process-line"').length - 1, 1, 'and the run still owns exactly one line')
})

test('two separate runs draw two lines, never one merged turn-wide line', () => {
  const { renderMessage } = messageSandbox('zh')
  const first = renderMessage({ turnProcess: true, turnKey: 't1', segment: 0, streaming: false, blocks: [tool('read', 'done')] })
  const second = renderMessage({ turnProcess: true, turnKey: 't1', segment: 1, streaming: true, blocks: [tool('edit', 'running')] })
  assert.equal(first.split('class="process-line"').length - 1, 1, 'the first run owns its line')
  assert.equal(second.split('class="process-line"').length - 1, 1, 'and so does the second')
  assert.ok(first.includes('已读取文件') && !first.includes('正在编辑文件'), 'the first says only what it did')
  assert.ok(second.includes('正在编辑文件') && !second.includes('已读取文件'), 'the second says only what it is doing')
})

test('only the newest thinking block wears the sweep; the finished ones sit still', () => {
  const { renderMessage } = messageSandbox('zh')
  const html = renderMessage({
    turnProcess: true,
    turnKey: 't1',
    streaming: true,
    blocks: [think('先想一想'), think('再想一想')],
  })
  assert.equal(html.split('data-state="running"').length - 1, 1, 'exactly one block is marked live')
  const states = [...html.matchAll(/class="thinking"[^>]*data-state="([a-z]+)"/g)].map((match) => match[1])
  assert.deepEqual(states, ['ok', 'running'], 'the older thought sits still, the newest one animates')
})
