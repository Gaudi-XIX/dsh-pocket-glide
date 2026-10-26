// BUG (user m00001 2026-10-25): 「新手机 Pocket 手机页面里面，初始对话默认的模型点开是个横杠」。
//
// 取证（读代码取得，非猜测）：设置面板里模型那一格的文本是
//   renderSessionSettings → fieldText(entry.model?.name, current.model)，current 来自
//   draftModelSelection() → sessionSelection ?? modelSelectionOf(streamProjections)。
// 新建对话是草稿态（activeSession=null、streamProjections=null），两路都是 null ⇒
// normalizeSelection 回 null ⇒ modelEntryOf 找不到目录项 ⇒ fieldText 拿到空 ⇒ 画 '—'。
// 目录（modelCatalog）本身是宿主全局的、问得到，问题只是草稿态没人去问它就是：
// openSessionSettings 在目录为空时确实会 refreshSessionSettings，但桥对 session.models
// 有 30s 缓存，目录过期/为空的那次重读会被同一份缓存再答一次，于是这一格一直是横杠。
// 修法：草稿态也读目录——进草稿时先静默读一次（ensureDraftModelCatalog），点开面板时
// 若目录为空或已过 TTL 再读一次（openSessionSettings），并且用目录的默认项回答
// 「默认模型是什么」（draftDefaultSelection）。
//
// 本文件两层：① 字符层（真渲染出来的页脚本里这些守卫必须在）；
// ② 行为层——把真函数切出来在合成状态上跑，证明草稿面板画的确实是目录默认模型。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })

// Brace-matching extractor (test/pages-render-fixes.test.js 房规：保留 async 前缀)。
function extractFunction(source, name) {
  let start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the source`)
  if (source.slice(start - 6, start) === 'async ') start -= 6
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

// ---------------------------------------------------------------- 字符层

test('M1 the draft reads the catalogue instead of only the (empty) session projections', () => {
  const ensure = extractFunction(js, 'ensureDraftModelCatalog')
  assert.match(ensure, /modelCatalog\.groups\?\.length/, 'an empty catalogue counts as "must read"')
  assert.match(ensure, /Date\.now\(\)-modelCatalogAt<DRAFT_CATALOG_TTL_MS/,
    'a catalogue older than the bridge\'s own cache window is re-read, not trusted')
  assert.match(ensure, /refreshSessionSettings\(null\)\.catch\(\(\)=>\{\}\)/,
    'the read is silent and session-less — a draft must never create a session')

  const draft = extractFunction(js, 'startDraftChat')
  assert.match(draft, /ensureDraftModelCatalog\(\)/, 'entering a new chat warms the catalogue')

  const open = extractFunction(js, 'openSessionSettings')
  assert.match(open, /refreshDraftCatalog\(\)/, 'opening the panel in a draft re-reads a stale catalogue')
  assert.match(open, /refreshSessionSettings\(sessionId\)/, 'and still refreshes as before (live sessions unchanged)')

  const refreshDraft = extractFunction(js, 'refreshDraftCatalog')
  assert.match(refreshDraft, /if\(activeSession\)return;/,
    'the live-session path is untouched — it already reads on every open')
  assert.match(refreshDraft, /Date\.now\(\)-modelCatalogAt<DRAFT_CATALOG_TTL_MS\)return/,
    'a fresh catalogue is reused — no extra round trip on every open')

  const render = extractFunction(js, 'renderSessionSettings')
  assert.match(render, /draftDefaultSelection\(\)/,
    'the model row asks for the default selection, not only the (absent) session one')

  const fallback = extractFunction(js, 'draftDefaultSelection')
  assert.match(fallback, /modelCatalog\?\.default\?\./, 'the catalogue default is the first answer')
  assert.match(fallback, /groups\?\.\[0\]\?\.models\?\.\[0\]/, 'the first catalogue entry is the last resort')
  assert.match(fallback, /provider&&model\?\{provider,model\}:null/, 'a catalogue with no models still answers null')

  // 目录必须记时：没有 modelCatalogAt 就无从判断「这份目录还能不能信」。
  assert.match(js, /modelCatalog=null,modelCatalogAt=0/, 'the catalogue carries its read time')
  const refresh = extractFunction(js, 'refreshSessionSettings')
  assert.match(refresh, /modelCatalogAt=Date\.now\(\)/, 'every catalogue read stamps it')
  assert.match(refresh, /if\(sessionId!==null&&activeSession!==sessionId\)return/,
    'the draft read (sessionId=null) must survive the guard — a late answer still must not land on another session')
})

test('M2 the draft fallback is a draft-only last resort', () => {
  const helper = extractFunction(js, 'draftDefaultSelection')
  // 活动会话绝不走兜底：会话投影才是那个会话的真话（BUG-2 的单一事实源不许被撬）。
  // 活动会话绝不走兜底：会话投影才是那个会话的真话（BUG-2 的单一事实源不许被撬）。
  assert.match(helper, /if\(activeSession\)return null/)
  // 草稿里用户亲手选过的模型由 draftPending 承载，优先于目录默认。
  const model = extractFunction(js, 'draftModelSelection')
  assert.match(model, /draftPending&&draftPending\.model/)
})

// ---------------------------------------------------------------- 行为层

// 真跑 renderSessionSettings / refreshSessionSettings，配一份合成目录与空的会话状态。
// opts.catalogAt 控制「图录读于多久之前」；opts.rpc 决定桥怎么答。
function buildDraftSettingsSandbox(opts) {
  const settingsHost = { innerHTML: '', hidden: false, querySelectorAll: () => [] }
  const make = new Function('box', 'opts', `
    let activeSession=null,settingsBusy=false,settingsPick='',presets=[],currentPreset=null,draftPending=null
    let sessionSelection=null,sessionSummaries=[],streamProjections=null
    let modelCatalog=opts.catalog,modelCatalogAt=opts.catalogAt
    const toast=[],errors=[]
    const L={model:'模型',reasoningEffort:'推理强度',reasoningEffortFixed:'由桌面端指定',noModels:'当前没有可选模型',settingsLoading:'正在读取模型与 Preset…',preset:'Preset',sessionSettings:'会话设置',close:'关闭',presetLocked:'',presetEditable:''}
    function $(id){return id==='sessionSettings'?box:{hidden:true,innerHTML:'',querySelectorAll:()=>[],setAttribute(){},dataset:{}}}
    function esc(value){return String(value)}
    function showToast(message){toast.push(message)}
    function showError(id,error){errors.push({id,error})}
    function syncSettingsControls(){}
    function settingsHead(){return ''}
    function presetIsLocked(){return false}
    function presetLabel(preset){return preset&&preset.id||''}
    function draftAgentPreset(){return null}
    function agentPresetOf(){return undefined}
    function normalizeSelection(value){if(!value||typeof value.provider!=='string'||!value.provider||typeof value.model!=='string'||!value.model)return null;const reasoningEffort=typeof value.reasoningEffort==='string'&&value.reasoningEffort?value.reasoningEffort:'';return{provider:value.provider,model:value.model,...(reasoningEffort?{reasoningEffort}:{})}}
    function modelSelectionOf(projections){const selection=projections&&projections.values&&projections.values.modelSelection;return normalizeSelection(selection&&selection.next)}
    function sameModelSelection(left,right){return!!left&&!!right&&left.provider===right.provider&&left.model===right.model&&(left.reasoningEffort||'')===(right.reasoningEffort||'')}
    function modelEntryOf(provider,model){const group=(modelCatalog?.groups||[]).find(item=>item.id===provider);return{group,model:(group?.models||[]).find(item=>item.id===model)}}
    function effortsOf(entry){return entry?.model?.reasoning?.efforts||[]}
    function effortValue(){return ''}
    function effortLabel(){return ''}
    function currentSelection(){return sessionSelection??{}}
    function fieldText(value,fallback){const clean=String(value??'').replace(/\\\\s+/g,' ').trim();return clean||String(fallback??'')}
    async function rpc(method){
      if(method==='session.models')throw new Error(opts.rpcError||'bridge down')
      if(method==='agentPreset.list')return{presets:[]}
      return{}
    }
    function showSessionModel(selection){const next=normalizeSelection(selection);if(!next||sameModelSelection(sessionSelection,next))return;sessionSelection=next;if(!$('sessionSettings').hidden)renderSessionSettings()}
    // 「新建对话」这一步本身：resetOptimisticMessages 把 sessionSelection 清空，activeSession 仍是
    // null —— 这正是 m00001 报的那种状态（切了几次会话再新建），早先的沙箱从没复现它。
    function startDraft(){sessionSelection=null;sessionSummaries=[];streamProjections=null}
    ${extractFunction(js, 'settingReadonlyHtml')}
    ${extractFunction(js, 'settingFieldHtml')}
    ${extractFunction(js, 'draftModelSelection')}
    ${extractFunction(js, 'draftDefaultSelection')}
    ${extractFunction(js, 'refreshSessionSettings')}
    ${extractFunction(js, 'renderSessionSettings')}
    const DRAFT_CATALOG_TTL_MS=${/const DRAFT_CATALOG_TTL_MS=([0-9*\s]+);/.exec(js)[1]}
    return {
      render(){renderSessionSettings();const text=box.innerHTML;const match=text.match(/data-pick="model"[^>]*><span>([^<]*)</);return {label:match?match[1]:'',html:text}},
      startDraft,
      async refresh(){await refreshSessionSettings(null);return this},
      state(){return {catalogAt:modelCatalogAt,selection:sessionSelection}},
      toasts:toast,
      errors
    }
  `)
  return make(settingsHost, opts)
}

const CATALOG = {
  groups: [
    { id: 'qoder', models: [{ id: 'qwen3-max', name: 'Qwen3 Max' }] },
    { id: 'magpie', models: [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }] },
  ],
  routableProviders: ['qoder', 'magpie'],
  default: { provider: 'magpie', model: 'glm-5.3-flash' },
}

test('M3 a brand-new chat shows the default model, not a dash', () => {
  const sandbox = buildDraftSettingsSandbox({ catalog: CATALOG, catalogAt: Date.now() })
  assert.equal(sandbox.render().label, 'GLM 5.3 Flash',
    'the empty draft has no projections to read, so the catalogue default must answer')
})

test('M4 a catalogue with no default entry still names the first model', () => {  const sandbox = buildDraftSettingsSandbox({
    catalog: { groups: CATALOG.groups, routableProviders: CATALOG.routableProviders },
    catalogAt: Date.now(),
  })
  assert.equal(sandbox.render().label, 'Qwen3 Max', 'the first listed model is the last resort')
})

test('M6 a draft entered AFTER a live session still answers (the m00001 shape)', () => {
  // 真机路径：先开过一个会话（showSessionModel 把 sessionSelection 记成那个会话的模型），
  // 再回列表点「新建对话」→ startDraftChat 清空 sessionSelection 但 activeSession=null。
  // 这一刻 renderSessionSettings 里 `if(activeSession)return null` 的兜底必须让路，
  // 否则模型格又是横杠 —— 这正是用户报的那一幕。
  const sandbox = buildDraftSettingsSandbox({ catalog: CATALOG, catalogAt: Date.now() })
  sandbox.startDraft()
  assert.equal(sandbox.render().label, 'GLM 5.3 Flash',
    'the draft must fall through to the catalogue once the previous session is gone')
})

test('M7 a stale catalogue is re-read, a fresh one is not (the 30s cache trap)', async () => {
  // 桥对 session.models 有 30s 缓存；页面若相信一份过期目录，重读只会拿回同一份空答案。
  // ensureDraftModelCatalog / refreshDraftCatalog 都按 DRAFT_CATALOG_TTL_MS 判「还能不能信」。
  const ttl = Number(/const DRAFT_CATALOG_TTL_MS=([0-9*\s]+);/.exec(js)[1].split('*').reduce((a, b) => a * b, 1))
  assert.equal(ttl, 30_000, 'the window is the bridge cache\'s own window')
  const harness = new Function(`
    let activeSession=null,modelCatalog={groups:[{id:'q',models:[{id:'m'}]}]},modelCatalogAt=Date.now()
    let calls=0
    function refreshSessionSettings(){calls+=1;return Promise.resolve()}
    const DRAFT_CATALOG_TTL_MS=${ttl}
    ${extractFunction(js, 'ensureDraftModelCatalog')}
    ${extractFunction(js, 'refreshDraftCatalog')}
    return {
      ensure(){ensureDraftModelCatalog()},
      openHook(){refreshDraftCatalog()},
      age(ms){modelCatalogAt=Date.now()-ms},
      empty(){modelCatalog={groups:[]};modelCatalogAt=Date.now()},
      calls(){return calls}
    }
  `)
  const box = harness()
  box.ensure()
  box.openHook()
  assert.equal(box.calls(), 0, 'a fresh, populated catalogue costs nothing')
  box.age(ttl + 1)
  box.ensure()
  assert.equal(box.calls(), 1, 'a catalogue older than the window is re-read on entering a draft')
  box.empty()
  box.openHook()
  assert.equal(box.calls(), 2, 'an empty catalogue is re-read when the panel opens')
})

test('M5 a failed read is silent and leaves the panel honest, not blank-silent', async () => {
  const sandbox = buildDraftSettingsSandbox({
    catalog: { default: { provider: '', model: '' }, routableProviders: [], groups: [], failures: [] },
    catalogAt: 0,
    rpcError: 'bridge down',
  })
  // 目录里一个模型都没有时，面板照旧把说明写在 settingsError 那一行（stale 路径原有口径），
  // 模型格仍是空值占位——它不再被冒充成一个名字，也不会额外弹 toast。
  const before = sandbox.render()
  assert.equal(before.label, '—', 'an empty catalogue cannot name a model')
  assert.match(before.html, /当前没有可选模型/, 'the strip explains the emptiness')
  await sandbox.refresh()
  const after = sandbox.render()
  assert.equal(after.label, '—', 'a failed read keeps the stale-but-honest state')
  assert.match(after.html, /当前没有可选模型/, 'and the explanation survives the failure')
  assert.deepEqual(sandbox.toasts, [], 'a draft never shouts about a flaky tunnel')
})
