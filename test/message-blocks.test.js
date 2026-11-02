// T7–T11 + R14（会话内容 / 审批卡 / 团队提问 / 模型切换 / relay 行 / 更早分页）
//
// 本文件原来的两半判据，随 BOT 页整页退场（判据①：只有 `/` 一个页面，`/bot` 302 回主页）一并改写法：
//   ① 注入契约（BOT 页的块渲染器必须是「从出货产物切出来的同一份源码」，逐函数字节对照判据表）
//      —— 主题已不存在：落地页壳自己就是那份渲染器的唯一宿主，没有第二页要复用，
//         BOT 页专用的那对「切块脚本 / 标签子集」导出已从 lib/pages.js 退场，本节整体删除。
//   ② 画出来的东西（用浏览器替身执行旧 BOT 页脚本，读 #bpMsgs 的 innerHTML）
//      —— 改为直接驱动「出货落地页 js 里切出来的同一批真函数」：
//         visibleMessages（事件流→行）+ renderBlock/renderMessage（行→HTML），
//         断言落在 HTML 字符串本身上。房规范式见 test/pages-process-render.test.js:512
//         的 messageSandbox：extractFunction 抽真函数 + new Function 补 shim，
//         不整壳 boot（24 万字符的壳有 SW/RPC/boot-overlay，替身喂不饱，会假绿）。
//   ③ 桥侧 prefetch 契约（error/descendantRunning 只由 prefetch 上下文供、applyDescendantRunning
//      是唯一一份标记实现）—— 与 BOT 页无关，原样保留。
//
// R14 四项能力（AC5.4–AC5.10）也并到本文件（Task 7 不新建 test 文件）：同样是 extractFunction
// 抽 lib/pages.js 出货 js 里的真函数（selectModel/approvalRows/botQuestion/submitQuestionAnswers/
// cancelQuestionRequest/olderPage/fetchEarlierPage + `$('messages').onclick` 那段匿名 handler），
// 用记录 payload 的 rpc 替身钉「发什么 RPC、payload 逐字对上」，不依赖整页 DOM。
//
// 测试替身是独立写的一份，不 import 别处：这里只需要按名字切函数、记录 rpc、把 fake DOM 元素喂给 onclick。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { mobilePageAssets } from '../lib/pages.js'
import { applyDescendantRunning, isRecord } from '../lib/projections.js'
import { withSessionErrors, noteSessionTurnEnd } from '../lib/session-stream.js'

const PAGE_JS = mobilePageAssets({ locale: 'zh' }).js

/** 从出货产物按名字切一个同步函数出来（纯大括号配平，与 test/pages-process-render.test.js:43
 *  同款——渲染链那批函数体里的引号/正则不参与计数，大括号本身配平即可，实测切片可用）。 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must be declared in the shipped landing page js`)
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  assert.fail(`unbalanced braces after ${name}`)
}

/** 抽一个可能是 `async function` 的函数（RPC 那批带 await，必须连 async 前缀一起切，
 *  否则抽出来丢 `async ` → 里面的 await 直接 SyntaxError）。大括号配平、字符串感知。 */
function extractAsyncFn(source, name) {
  let at = source.indexOf(`async function ${name}(`)
  if (at < 0) at = source.indexOf(`function ${name}(`)
  assert.notEqual(at, -1, `${name} must be declared in the shipped landing page js`)
  let i = source.indexOf('{', at)
  let depth = 0
  let str = null
  for (; i < source.length; i += 1) {
    const ch = source[i]
    if (str) {
      if (ch === '\\') i += 1
      else if (ch === str) str = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(at, i + 1)
    }
  }
  assert.fail(`unbalanced braces after ${name}`)
}

/** 切一个「`obj.prop = (arg) => { ... }`」形状的匿名箭头（`$('messages').onclick=...`）。 */
function sliceArrow(source, marker) {
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, `${marker} must be present in the shipped landing page js`)
  let i = source.indexOf('=>', at)
  i = source.indexOf('{', i)
  let depth = 0
  let str = null
  for (; i < source.length; i += 1) {
    const ch = source[i]
    if (str) {
      if (ch === '\\') i += 1
      else if (ch === str) str = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(at + marker.length, i + 1)
    }
  }
  assert.fail(`unbalanced braces after ${marker}`)
}

// ---------------------------------------------------------------------------
// 渲染沙箱：从出货 js 切出「事件流 → 行 → HTML」这一整条渲染真函数
// ---------------------------------------------------------------------------
const RENDER_NAMES = [
  'esc', 'renderBlock', 'renderMessage', 'renderMessageTail', 'visibleMessages',
  'contentBlocks', 'turnKeyOf', 'eventSeq', 'stepKey', 'formatMessageClock',
  'formatTokens', 'formatElapsed', 'toolActivityCategory', 'processLineHtml',
  'processLineText', 'clusterToolBlocks',
  'renderProcessLine', 'processRows', 'activityIcon', 'activityChevron',
  'reasoningSummary', 'bindOpenState', 'rememberOpenState', 'baseNameOf',
  'isImagePath', 'isTextualAttachment', 'sessionFileUrl', 'formatBytes',
  'earlierItemHtml', 'orderUserBubblesByTime', 'pad2', 'extOf',
]

// 出货产物里被渲染链引用的顶层字面量（不是函数，切片取不到，只能按同一份值补齐 shim）。
// L 直接从出货壳里解析真表（221 键，含 processLineText 要的 stepVerbs/stepDone/processSep 等），
// 手抄一份必然与真表漂移——这正是 ① 旧注入契约当年要守的东西，只是现在改成解析出货产物本身。
const PAGE_L = JSON.parse(PAGE_JS.match(/^const L=(\{.*\});/m)[1])
const RENDER_CONST = `
  const L = ${JSON.stringify(PAGE_L)}
  const IMAGE_FILE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']
  const TEXT_FILE_EXTS = ['txt', 'md', 'markdown', 'json', 'xml', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'htm', 'sh', 'sql', 'yml', 'yaml', 'log', 'csv', 'ini', 'toml', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp']
  const FILE_SVG = '<svg class="file-icon"></svg>'
  const SJ = '" stroke-linecap="round" stroke-linejoin="round"/>'
  const SE = SJ + '</svg>'
  const SC = ' stroke="currentColor" stroke-width="1.6"'
  const markdown = (s) => '<p>' + String(s == null ? '' : s) + '</p>'
  const normalizeUsage = (u) => u
  const noteSessionPaths = () => {}
  const mergeEntries = () => {}
  const zh = true
  let pendingQuestion = null
  let activeSession = 's-repo'
  const turnOpenState = new Map()
  const turnRetryMax = new Map()
  const turnElapsedByTurn = new Map()
  let rows = []
  let visible = []
  let idx = 0
`

const renderSandbox = new Function(`${RENDER_CONST}\n${RENDER_NAMES.map((n) => extractFunction(PAGE_JS, n)).join('\n')}\n
  return {
    visibleMessages, renderBlock, renderMessage, earlierItemHtml,
    setActive: (sid) => { activeSession = sid },
    // 落地页把整屏行交给 renderMessage，renderMessage 内部要读 rows（它按整屏算
    // 「本回合的第几张卡」）。renderAll 就是复刻 paintMessages 的 map，不引入 DOM。
    renderAll: (rs) => { rows = rs; return rs.map((m) => renderMessage(m)).join('') },
  }
`)()

/** 夹具的「现在」：固定住，否则每次重算时钟会漂。 */
const NOW = Date.now()

/** 一段真实形状的宿主事件流：块、工具结果、报错收尾、交付物都齐（沿用旧夹具的 7 条）。
 *  记录形状 = {event:{type,seq,time,data},time}：pageSeq 读 event.seq、stampOf 读 event.time。 */
function historyAnswer() {
  const at = NOW
  const record = (seq, type, data) => ({ event: { type, seq, time: at, data }, time: at })
  return [
    record(1, 'user/message', { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '把页面修一下' }] } }),
    record(2, 'assistant/message', {
      message: {
        content: [
          { type: 'reasoning', text: '先看清结构' },
          { type: 'text', text: '看完了，接着改。' },
          { type: 'tool-call', id: 'call-1', name: 'Bash', arguments: { command: 'ls' } },
        ],
      },
    }),
    record(3, 'tool/result', { message: { toolCallId: 'call-1', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } }),
    record(4, 'assistant/message', {
      message: {
        content: [
          { type: 'image', attachment: { attachmentId: 'att-1', name: 'shot.png' } },
          { type: 'file', attachment: { attachmentId: 'att-2', name: 'notes.md', bytes: 2048 } },
        ],
      },
    }),
    // 只有思考、没有文本的一条：从前整行被丢掉（T7 的第二条缺口）。
    record(5, 'assistant/message', { message: { content: [{ type: 'reasoning', text: '再想一步' }] } }),
    record(6, 'turn/end', { reason: { kind: 'error', error: { message: 'boom' } } }),
    // 第七类块：交付物（landing 的 deliverables/presented 出口）。
    record(7, 'deliverables/presented', { files: [{ path: '/tmp/out/report.png', description: '结果图' }, { path: '/tmp/out/report.txt' }] }),
  ]
}

/** 更早的记录（bot.earlier）：落地页用 earlierItemHtml 逐条画，形状是 host item（kind/text/time/name/role）。 */
function earlierAnswer() {
  return {
    cursor: null,
    items: [
      { kind: 'divider', text: '', time: NOW },
      { kind: 'user', text: '早前的问', time: NOW },
      { kind: 'assistant', text: '早前的答', time: NOW },
      { kind: 'event', name: 'Curator', role: 'tool', time: NOW },
    ],
  }
}

// ---------------------------------------------------------------------------
// ② 画出来的东西：落地页渲染真函数（驱动 visibleMessages → renderMessage）
// ---------------------------------------------------------------------------

test('T7：每种块都由落地页同一份块渲染器画出来（text / reasoning / tool / image / file / turn-error / presented / approval）', () => {
  const rb = (b) => renderSandbox.renderBlock(b, false, 'k')
  // 正文文本块：markdown 段（旧 BOT 页是 bp-msg，落地页只有这一份渲染器）。
  assert.match(rb({ kind: 'text', text: '看完了，接着改。' }), /<div class="markdown"><p>看完了，接着改。<\/p><\/div>/)
  // 思考块：details.thinking + 活动摘要。
  const think = rb({ kind: 'reasoning', text: '先看清结构' })
  assert.ok(think.includes('class="thinking"'), '思考块必须画成 details.thinking')
  assert.ok(think.includes('先看清结构'), '思考摘要文本必须在')
  // 工具块：process-line，state 由 status 决定（running / done）。
  assert.match(rb({ kind: 'tool', name: 'Bash', status: 'running', args: { command: 'ls' } }), /class="process-line"[^>]*data-state="running"/, '工具无结果 ⇒ running')
  assert.match(rb({ kind: 'tool', name: 'Bash', status: 'done', args: { command: 'ls' }, result: { content: [{ type: 'text', text: 'ok' }] } }), /class="process-line"[^>]*data-state="done"/, '工具读完结果 ⇒ done')
  // 图片块：attach-image + session-attachment 代理 src。
  const img = rb({ kind: 'image', attachment: { attachmentId: 'att-1', name: 'shot.png' }, _seq: 1 })
  assert.ok(img.includes('class="attach-image"'), '图片块必须画 attach-image')
  assert.ok(img.includes('/api/session-attachment?'), '图片必须走 session-attachment 代理')
  assert.ok(img.includes('attachmentId=att-1'), '图片代理必须带 attachmentId')
  // 文件块：data-file-preview + 人话字节。
  const file = rb({ kind: 'file', attachment: { attachmentId: 'att-2', name: 'notes.md', bytes: 2048 } })
  assert.ok(file.includes('data-file-preview="att-2"'), '文本类附件必须给可预览按钮')
  assert.ok(file.includes('2.0 KB'), '附件必须报人话字节')
  // 报错收尾：turn-error-bubble（label + detail）。
  const err = rb({ kind: 'turn-error', label: '运行出错', detail: 'boom' })
  assert.ok(err.includes('class="turn-error-bubble"'), 'turn/end error 必须画错误气泡')
  assert.ok(err.includes('运行出错'), '错误气泡必须带标题')
  assert.ok(err.includes('boom'), '错误气泡必须带原始 detail')
  // 交付物：presented-group 单独成块，图片走 session-file，文件走下载链接。
  const presented = rb({ kind: 'presented', files: [{ path: '/tmp/out/report.png', description: '结果图' }, { path: '/tmp/out/report.txt' }] })
  assert.ok(presented.includes('class="presented-group"'), 'presented 必须单独成一组')
  assert.ok(presented.includes('presented-image'), 'presented 里图片必须是 presented-image')
  assert.ok(presented.includes('/api/session-file?'), 'presented 图片必须走 session-file 代理')
  assert.ok(presented.includes('class="attach-file presented-file"'), 'presented 里的文件必须是可下载链接')
  // 审批卡（未作答）走同一份渲染器，复用既有 question-shell。
  assert.ok(rb({ kind: 'approval', id: 'ap1', head: 'Repo · Bash', body: 'rm -rf', yes: true }).includes('class="question-shell"'), '审批卡必须复用 question-shell')
})

test('T7：只含 reasoning 的消息不再整行丢掉', () => {
  // 旧缺口：只有 reasoning、没有正文的一条整行被丢。落地页渲染器必须照画。
  const only = renderSandbox.renderBlock({ kind: 'reasoning', text: '再想一步' }, false, 'k')
  assert.ok(only.includes('再想一步'), '只含思考的一条也必须进屏')
  assert.ok(/class="thinking"/.test(only), '思考块必须画成 details.thinking')
  // 带正文那段的思考摘要也要在（两条 thinking 都要活下来）。
  const withBody = renderSandbox.renderBlock({ kind: 'reasoning', text: '先看清结构' }, false, 'k')
  assert.ok(withBody.includes('先看清结构'), '带正文那条的思考摘要必须在')
  assert.ok(/class="thinking"/.test(withBody), '两条都必须是 details.thinking')
})

test('T7：没有块的行整格不动（user 行仍是文本渲染，不被过程卡逻辑接管）', () => {
  const rows = renderSandbox.visibleMessages(historyAnswer())
  const html = renderSandbox.renderAll(rows)
  // 用户行必须保持 message user 的文本壳，不叠 turnProcess/assistant 类。
  const userRow = html.match(/<div class="message user">[\s\S]*?<\/div>/)
  assert.ok(userRow, '必须有一条 user 行')
  assert.ok(!/assistant/.test(userRow[0]), 'user 行不得混进 assistant 结构')
})

test('T7（跨轮询）：第一轮画 running，第二轮读回的 done 必须进屏，行数与位置不变', () => {
  const at = NOW
  const rec = (seq, type, data) => ({ event: { type, seq, time: at, data }, time: at })
  const first = [
    rec(1, 'user/message', { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '跑个命令' }] } }),
    rec(2, 'assistant/message', { message: { content: [{ type: 'tool-call', id: 'c1', name: 'Bash', arguments: { command: 'ls' } }] } }),
  ]
  const rows1 = renderSandbox.visibleMessages(first)
  const html1 = renderSandbox.renderAll(rows1)
  assert.match(html1, /class="process-line"[^>]*data-state="running"/, '第一轮无结果 ⇒ 工具 running')
  const second = first.concat([
    rec(3, 'tool/result', { message: { toolCallId: 'c1', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } }),
  ])
  const rows2 = renderSandbox.visibleMessages(second)
  const html2 = renderSandbox.renderAll(rows2)
  assert.match(html2, /class="process-line"[^>]*data-state="done"/, '第二轮读到结果 ⇒ 工具 done')
  assert.ok(!/data-state="running"/.test(html2), '第二轮不得再残留 running')
  // 回填状态只换 state、不改可见行数：两轮都必须有那条带工具的 assistant 过程卡。
  assert.ok(
    rows2.some((r) => r.role === 'assistant') && rows1.some((r) => r.role === 'assistant'),
    '两轮都得把带工具的那条 assistant 过程卡画上',
  )
})

test('T9：更早记录按落地页形状逐条画（divider / user / assistant / event）', () => {
  const items = earlierAnswer().items
  const html = items.map((it) => renderSandbox.earlierItemHtml(it)).join('')
  // 落地页早先分页用 earlier-divider，不画旧 BOT 页的 bp-divider。
  assert.ok(html.includes('class="earlier-divider"'), '必须画落地页 earlier-divider')
  assert.ok(html.includes('更早的对话'), 'divider 必须带「更早的对话」文案')
  // user / assistant 早先行：落地页是 message <role> earlier-msg。
  assert.ok(html.includes('<div class="message user earlier-msg">早前的问</div>'), 'user 早先行必须逐字对上落地页 markup')
  assert.ok(html.includes('早前的答'), 'assistant 早先行文本必须在')
  // event 早先行：落地页是 span.earlier-event（带 data-role），不画旧 BOT 页的 bp-event。
  assert.match(html, /<span class="earlier-event" data-role="tool">/, 'event 早先行必须是 earlier-event[data-role]')
  assert.ok(html.includes('Curator'), 'event 早先行要带发起者名')
  // 反向钉：落地页早先行不再逐行挂时间戳（这是与旧 BOT 页的有意差异，见交接说明）。
  assert.ok(!/bp-divider|bp-event|bp-msg|bp-tail/.test(html), '不得残留旧 BOT 页的 bp-* 类')
})

test('AC5.9：relay 记录（source.kind=bot）在 visibleMessages 产出里可见（旧 BOT 页 relayRow 的等价物）', () => {
  const at = NOW
  const rec = (seq, data) => ({ event: { type: 'user/message', seq, time: at, data }, time: at })
  const events = [
    // 交接行：handoff=true ⇒ 取正文首行，画成 role='event' 的整行。
    rec(1, { message: { source: { kind: 'bot', handoff: true }, content: [{ type: 'text', text: 'relay line one\nsecond line' }] } }),
    // 普通 relay：非 deferred/resumed/retried，role 在 request|reply|report|stopped ⇒ 「· <who>」+ peer。
    rec(2, { message: { source: { kind: 'bot', role: 'reply', senderName: 'Scout', senderSessionId: 's-scout' }, content: [{ type: 'text', text: 'x' }] } }),
  ]
  const rows = renderSandbox.visibleMessages(events)
  const events1 = rows.filter((r) => r.role === 'event')
  assert.ok(events1.length >= 2, '两条 relay 都要成为 event 行')
  const handoff = events1.find((r) => r.blocks.some((b) => b.kind === 'event' && b.text === 'relay line one'))
  assert.ok(handoff, 'handoff relay 必须渲成 event 行，取正文首行（旧 relayRow 语义）')
  const peer = events1.find((r) => r.blocks.some((b) => b.text === '· Scout'))
  assert.ok(peer, 'reply relay 必须渲成「· <senderName>」')
  assert.equal(peer.peer, 's-scout', 'reply relay 要带上 senderSessionId 作为 peer')
})

test('AC5.5：渲染链里没有旧 BOT 页的 #bpMsgs 容器（内容已并进落地页 transcript）', () => {
  // 落地页把会话画进 #messages（$('messages')），不再有 #bpMsgs 这个独立页容器。
  assert.equal((PAGE_JS.match(/bpMsgs/g) || []).length, 0, '出货落地页 js 里不得有 #bpMsgs')
})

// ---------------------------------------------------------------------------
// ③ 桥侧 prefetch 契约（与 BOT 页无关，原样保留）
// ---------------------------------------------------------------------------

const BRIDGE_SOURCE = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')

/** 从一段源码里按名字切一个函数出来（纯大括号配平，与 pages.js 的切法同形）。 */
function sliceFunction(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, `${name} must be declared in the source under test`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  assert.fail(`unbalanced braces after ${name}`)
}

/** 一个类方法（`  name() {`，没有 function 关键字）按大括号配平切出来。 */
function extractMethod(source, name) {
  const start = source.indexOf('  ' + name + '() {')
  assert.notEqual(start, -1, `${name} must be a method of lib/bridge.js`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  assert.fail(`unbalanced braces after ${name}`)
}

const botQuestionsSource = sliceFunction(BRIDGE_SOURCE, 'botQuestions')
const botQuestions = vm.runInNewContext(`(${botQuestionsSource})`, { isRecord })
const botTeamView = vm.runInNewContext(`(${sliceFunction(BRIDGE_SOURCE, 'botTeamView')})`, {
  isRecord,
  botQuestions,
  Set,
})
const sessionRowHasError = vm.runInNewContext(`(${sliceFunction(BRIDGE_SOURCE, 'sessionRowHasError')})`, {})
const botTeamPrefetchContext = vm.runInNewContext(`({${extractMethod(BRIDGE_SOURCE, 'botTeamPrefetchContext')}})`, {
  applyDescendantRunning,
  withSessionErrors,
  sessionRowHasError,
  Array,
  Map,
  Number,
  Set,
}).botTeamPrefetchContext

/** JSON 往返：手机只看得见 JSON，跨 realm 的对象也用这个比。 */
const plain = (value) => JSON.parse(JSON.stringify(value))

test('T8/T10（桥）：error 与 descendantRunning 由 prefetch 上下文供，旧调用路径不出现这两个键', () => {
  const items = [
    { sessionId: 's1', updatedAt: 111, running: false },
    { sessionId: 's2', origin: 'subagent', parentSessionId: 's1', running: true },
    { sessionId: 's3', updatedAt: 222, running: false },
  ]
  const bridge = {
    workspaceSnapshot: { pinnedSessionIds: [] },
    _sessionListValue: { result: { ok: true, value: { items } } },
    now: () => 1_760_000_000_000,
  }
  // 生产上原始 session/list 行没有 error 字段（lib/session-stream.js:194-197）：
  // is-error 只能来自桥自己的 turn/end tally，由 withSessionErrors 叠上去。
  const quiet = botTeamPrefetchContext.call(bridge)
  assert.equal(quiet.errorOf('s1'), false, 'tally 里没有记录就不亮')
  noteSessionTurnEnd(bridge, 's1', {
    event: { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } },
  })
  const ctx = botTeamPrefetchContext.call(bridge)
  assert.equal(ctx.errorOf('s1'), true, '桥 tally 记到的失败必须让 errorOf 为 true')
  assert.equal(ctx.errorOf('s3'), false, 'tally 里没有的会话仍是 false')
  assert.equal(ctx.descendantRunningOf('s1'), true, '子孙在跑 ⇒ 父行标 descendantRunning')
  assert.equal(ctx.descendantRunningOf('s3'), false, '没有子孙在跑就是 false')
  assert.equal(ctx.descendantRunningOf('s2'), false, '还在跑的那一行自己的 running 已经是 true，不靠这个标记')

  const answer = {
    revision: 1,
    mainBotIds: ['b1'],
    bots: [{ id: 'b1', name: 'Ops', role: 'editor', sessionId: 's1' }],
    rooms: [],
    questions: { count: 0 },
    work: { bots: {}, rooms: [] },
  }
  const withCtx = plain(botTeamView(answer, ctx))
  assert.equal(withCtx.bots[0].descendantRunning, true)
  assert.equal(withCtx.bots[0].error, true)
  // 没有这两个取值器时必须是 undefined（JSON 往返后键消失），不是 false——
  // test/host-shape-contract.test.js 用 deepEqual 钉死了 bots 行的键集合。
  const legacy = plain(botTeamView(answer, { pinnedIds: new Set(), updatedAtOf: () => 0 }))
  assert.equal('descendantRunning' in legacy.bots[0], false)
  assert.equal('error' in legacy.bots[0], false)
  // 首次 session/list 还没回来：两张表留空，错误答 false、子孙答 undefined。
  const cold = botTeamPrefetchContext.call({ workspaceSnapshot: { pinnedSessionIds: [] }, _sessionListValue: null })
  assert.equal(cold.errorOf('s1'), false)
  assert.equal(cold.descendantRunningOf('s1'), undefined, '没读到过的行答 undefined，不是 false')
})

test('T10（桥）：applyDescendantRunning 是唯一一份标记实现，桥只消费它', () => {
  const items = [
    { sessionId: 'p', running: false },
    { sessionId: 'c', origin: 'subagent', parentSessionId: 'p', running: true },
  ]
  const marked = applyDescendantRunning(items)
  assert.equal(marked[0].descendantRunning, true, '父行被标上')
  assert.equal(items[0].descendantRunning, undefined, '原数组不被就地改（返回的是新对象）')
})

// ---------------------------------------------------------------------------
// AC5.4–AC5.10：R14 四项能力的 RPC 面（抽 lib/pages.js 出货 js 里的真函数 + 记录 rpc 替身）
// ---------------------------------------------------------------------------
// 注意：lib/ 在途字节瘦身把 botRowOf / botQuestion 内联进了 selectModel / 调用点（不再是
// 独立具名函数）。AC5.7/AC5.8 改为直接驱动承载它们的外层真函数（selectModel 读 teamState.bots
// 自带那段查找；submitQuestionAnswers/cancelQuestionRequest 吃我构造的 pendingQuestion 字面量），
// 不抽 botRowOf/botQuestion——避免把「谁在哪个函数里」钉死成测试契约。见交接遗留项。
const RPC_NAMES = [
  'approvalRows', 'selectModel', 'submitQuestionAnswers',
  'cancelQuestionRequest', 'fetchEarlierPage', 'olderPage',
]
const RPC_PRE = `
  const rpcs = []
  let failApproval = false
  let activeSession = null, teamState = null, pendingQuestion = null, approvalDone = new Set()
  let questionBusy = false, settingsBusy = false
  let earlierBusy = false, earlierDone = false, earlierCursor = null, earlierGen = 0
  let lastHistoryKey = 'k'
  const esc = (v) => String(v == null ? '' : v)
  const L = { approvalTool: '审批', approvalPc: '请在电脑上处理', earlierMore: '载入更早', earlierPartsLoading: '载入中', settingsUpdated: '已更新', failed: '失败' }
  function rpc(method, payload) {
    rpcs.push({ method, payload })
    if (failApproval && method === 'bot.approval') return Promise.reject(new Error('boom'))
    return Promise.resolve({ items: [], cursor: null })
  }
  const showError = () => {}, showToast = () => {}
  const loadListData = () => Promise.resolve(), loadHistory = () => Promise.resolve()
  const loadOlder = () => {}
  // onclick 里审批分支要用 document.querySelectorAll 按 data-approve 选择器取回同卡按钮，
  // 置 disabled（并发点击的闸门），故替身也要给一个能按选择器取按钮的 document。
  let document = { querySelectorAll: () => [] }
  const syncSettingsControls = () => {}, draftSetModel = () => {}
  const normalizeSelection = (x) => x || null
  const showSessionModel = () => {}, sessionRowValues = () => ({ modelSelection: {} }), renderSessionSettings = () => {}
  const renderQuestionComposer = () => {}
  let questionSelection = []
  const questionDraft = () => ({ selected: questionSelection, custom: '' })
  const paintEarlierFeed = () => {}
  const subagentView = null
`
const RPC_RET = `
  return {
    rpcs,
    set: (key, value) => {
      switch (key) {
        case 'activeSession': activeSession = value; return
        case 'teamState': teamState = value; return
        case 'pendingQuestion': pendingQuestion = value; return
        case 'approvalDone': approvalDone = value; return
        case 'failApproval': failApproval = value; return
        case 'questionSelection': questionSelection = value; return
        case 'earlierCursor': earlierCursor = value; return
        case 'earlierDone': earlierDone = value; return
        case 'document': document = value; return
        case 'failApproval': failApproval = value; return
        default: throw new Error('no such key ' + key)
      }
    },
    approvalRows, selectModel, submitQuestionAnswers,
    cancelQuestionRequests: cancelQuestionRequest, fetchEarlierPage, olderPage,
    // 落地页把审批按钮挂在一个匿名 handler 上：从同一份出货 js 里切出那段箭头来驱动，
    // 而不是重写一个——否则「点了审批到底发什么」测的是测试自己。
    messagesOnclick: (${sliceArrow(PAGE_JS, "$('messages').onclick=")}),
  }
`
const rpcSandbox = new Function(`${RPC_PRE}\n${RPC_NAMES.map((n) => extractAsyncFn(PAGE_JS, n)).join('\n')}\n${RPC_RET}`)()

const flushMicrotasks = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }
/** 造一个假审批按钮：有 data-* 与 disabled 旗，closest('[data-approve]') 返回自己。
 *  onclick 里审批分支会把同 aid 的按钮全部置 disabled（并发点击闸门），再点 disabled 的
 *  按钮不算数——这就是「已关不再发」的真实实现，替身要对上。 */
const approveButton = (id, choice) => {
  const el = {
    disabled: false,
    getAttribute: (a) => (a === 'data-approve' ? id : a === 'data-choice' ? choice : null),
  }
  el.closest = (sel) => (sel === '[data-approve]' ? el : null)
  return el
}
/** 记录一组按钮，给 onclick 当 DOM：querySelectorAll('[data-approve="X"]') 返回同 X 的按钮。 */
const fakeDocument = (buttons) => ({
  querySelectorAll: (sel) => {
    const m = /data-approve="([^"]+)"/.exec(sel)
    return m ? buttons.filter((b) => b.getAttribute('data-approve') === m[1]) : []
  },
})

test('AC5.4：点 BOT 私聊行走 session.history，且 payload.sessionId 对上该 bot 的 sessionId（不钉整串 payload）', async () => {
  rpcSandbox.set('activeSession', 's-repo')
  rpcSandbox.rpcs.length = 0
  await rpcSandbox.olderPage('s-repo', -1)
  const call = rpcSandbox.rpcs.filter((c) => c.method === 'session.history').pop()
  assert.ok(call, '必须发 session.history')
  assert.equal(call.payload.sessionId, 's-repo', 'AC5.4 payload.sessionId 必须等于该 bot 的 sessionId')
  // 既有实现还带 maxMessages 等额外键——断言只钉 sessionId，不钉整串。
  assert.ok('maxMessages' in call.payload, 'AC5.4 不钉整串 payload：maxMessages 这类附带键允许存在')
})

test('AC5.4：BOT 私聊行走 open 通道后真的落在会话页（chatView 激活、sessionsView 让位）', async () => {
  // 上一条只钉到 seam 的请求参数；「点开一行就进了会话页」这半句没人钉。
  // 这里跑整条真实链路：$('workspaces').onclick 的 action==='open' 分支（lib/pages.js:3132）
  // → 真 openSession（lib/pages.js:2789）→ $('chatView').classList.add('active')（:2803，首个 await 之前）。
  // 两段都从出货壳里切出来，替身只补 DOM 与 openSession 的自由变量；断言读的是它自己写下的状态。
  // 注：不用 extractAsyncFn 切它——它靠大括号配平，而函数体注释里 `entry's` 那个撇号
  // 会被当成单引号串开始，导致配平算不出终点。按相邻函数的边界切（同 test/nav-reload.test.js:268）。
  const openAt = PAGE_JS.indexOf('async function openSession(')
  const openEnd = PAGE_JS.indexOf('function handleHistory(', openAt)
  assert.ok(openAt !== -1 && openEnd > openAt, 'async function openSession 必须夹在 function handleHistory 之前')
  const openSession = PAGE_JS.slice(openAt, openEnd)
  const workspacesClick = sliceArrow(PAGE_JS, "$('workspaces').onclick=")
  const channel = new Function('init', `
    // classList 用真 Set 记账：contains() 读的是 add/remove 之后的真实结果，不是被打的桩。
    const classes = (initial) => { const set = new Set(initial); return {
      classList: {
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
        contains: (c) => set.has(c),
        toggle: (c, force) => { const on = force === undefined ? !set.has(c) : !!force; if (on) set.add(c); else set.delete(c); return on },
      },
    } }
    const chats = classes([]), lists = classes(['active']), messages = classes([]), note = classes([])
    messages.innerHTML = ''
    messages.querySelector = () => null
    const els = { chatView: chats, sessionsView: lists, messages, subagentNote: note }
    const document = { body: classes([]) }
    const $ = (id) => els[id] || null
    const noop = () => {}
    let activeSession = null, streamConnected = false, poll = null, streamEvents = [], olderEvents = []
    let olderHasMore = false, olderExhausted = false, streamProjections = { values: {} }
    let sessionBlank = true, lastHistoryKey = '', subagentView = null
    let subagentCatalog = null, subagentExpanded = false, agentRunning = false, turnRunningOpen = false
    let composerDrafts = [], kr = 0
    const sessionCache = new Map(), tailCache = new Map(), subagentRowsByParent = new Map()
    const history = { pushState: noop, replaceState: noop }
    const L = { untitled: '未命名', subagentReadonly: '' }
    const sessionSummaries = init.summaries
    const stopListPoll = noop, evictSessionCache = noop, resetEarlierParts = noop
    const closeSessionStream = noop, noteSessionOpened = noop, agentPresetOf = () => null
    const closeSessionSettings = noop, resetOptimisticMessages = noop, resumeSend = noop
    const syncPendingQuestion = noop, aj = noop, stopSubagentTicker = noop, renderSubagentBar = noop
    const fillTail = () => Promise.resolve(), paintInstantSession = () => false
    const openRealtime = noop, fetchProjectionsNow = noop, refreshSubagentRowsIfNeeded = noop
    const startEarlierParts = noop, armSkeletonWatchdog = noop, schedulePoll = noop
    const ensureTranscriptFilled = noop, loadHistory = () => Promise.resolve()
    const paintInstantHistory = noop, windowEvents = () => []
    const streamSnapshotReady = Promise.resolve(true), SESSION_CACHE_FRESH_MS = 1000
    ${openSession}
    const onWorkspacesClick = (${workspacesClick})
    // 卡与按钮都是 lib/pages.js:2499 给每张卡的任务行画的形状：BOT 私聊行与工作区行共用这一条通道。
    const click = (btn) => {
      const card = { dataset: { ws: init.ws } }
      onWorkspacesClick({ target: { closest: (sel) => (sel === '.ws-card' ? card : sel === 'button[data-action]' ? btn : null) } })
    }
    return {
      click,
      seen: () => ({
        activeSession,
        chatViewActive: chats.classList.contains('active'),
        sessionsViewActive: lists.classList.contains('active'),
        chatOpen: document.body.classList.contains('chat-open'),
      }),
    }
  `)({ summaries: [{ sessionId: 's-repo', blank: false }], ws: 'bot:main' })

  channel.click({ dataset: { action: 'open', id: 's-repo' } })
  await flushMicrotasks()

  const seen = channel.seen()
  assert.equal(seen.activeSession, 's-repo', 'AC5.4 open 通道必须把该 bot 的 sessionId 交给 openSession')
  assert.equal(seen.chatViewActive, true, "AC5.4 必须真的执行 $('chatView').classList.add('active')（lib/pages.js:2803）")
  assert.equal(seen.sessionsViewActive, false, 'AC5.4 会话页与列表页互斥：sessionsView 必须让位')
  assert.equal(seen.chatOpen, true, 'AC5.4 document.body 同步置上 chat-open')
})

test('AC5.5：群行打开时 session.history 的 sessionId = 群 id（与私聊走同一条 seam，无独立页容器）', async () => {
  rpcSandbox.set('activeSession', 'g-team')
  rpcSandbox.rpcs.length = 0
  await rpcSandbox.olderPage('g-team', -1)
  const call = rpcSandbox.rpcs.filter((c) => c.method === 'session.history').pop()
  assert.equal(call.payload.sessionId, 'g-team', 'AC5.5 群行 sessionId 必须就是群 id')
})

test('AC5.6：answerable 审批卡渲两个选项、点击发 bot.approval(id+choice)、已关不再发、失败回滚可重发', async () => {
  rpcSandbox.set('activeSession', 's-repo')
  rpcSandbox.set('teamState', {
    bots: [{ id: 'b-repo', name: 'Repo', sessionId: 's-repo' }],
    work: { approvals: [
      { id: 'ap1', botId: 'b-repo', tool: 'Bash', detail: { text: 'rm -rf' }, answerable: true, sessionId: 's-repo' },
      { id: 'ap2', botId: 'b-repo', tool: 'Bash', reason: 'x', answerable: true, sessionId: 's-repo' },
    ] },
  })
  const rows = rpcSandbox.approvalRows()
  assert.equal(rows.length, 2, 'AC5.6 两张可作答审批卡都要出现')
  assert.equal(rows[0].blocks[0].kind, 'approval')
  assert.equal(rows[0].blocks[0].yes, true, 'answerable 必须映射成 yes:true（渲两个按钮）')
  // 用渲染真函数确认「yes⇒两个选项按钮」的 markup（id/choice 逐字对上）。
  const cardHtml = renderSandbox.renderBlock(rows[0].blocks[0], false, 'ap1')
  assert.match(cardHtml, /class="question-shell"/, '可作答审批卡必须复用既有 question-shell 样式')
  assert.match(cardHtml, /data-approve="ap1"\s+data-choice="allow"/, '允许按钮必须带 data-approve=ap1 data-choice=allow')
  assert.match(cardHtml, /data-approve="ap1"\s+data-choice="reject"/, '拒绝按钮必须带 data-approve=ap1 data-choice=reject')
  // 点击 ap1/allow ⇒ bot.approval{id,choice}；成功后同 aid 的按钮被置 disabled（并发点击闸门）。
  const allow1 = approveButton('ap1', 'allow')
  const reject1 = approveButton('ap1', 'reject')
  rpcSandbox.set('document', fakeDocument([allow1, reject1]))
  rpcSandbox.set('failApproval', false)
  rpcSandbox.rpcs.length = 0
  rpcSandbox.messagesOnclick({ target: allow1 })
  await flushMicrotasks()
  const sent = rpcSandbox.rpcs.filter((c) => c.method === 'bot.approval')
  assert.equal(sent.length, 1, 'AC5.6 点击必须发一次 bot.approval')
  assert.equal(sent[0].payload.id, 'ap1', 'AC5.6 payload.id 对上')
  assert.equal(sent[0].payload.choice, 'allow', 'AC5.6 payload.choice 对上')
  assert.equal(allow1.disabled, true, 'AC5.6 成功点击后同卡按钮必须被置 disabled')
  // 已关（同一按钮已 disabled）⇒ 再点不再发。
  rpcSandbox.rpcs.length = 0
  rpcSandbox.messagesOnclick({ target: allow1 })
  await flushMicrotasks()
  assert.equal(rpcSandbox.rpcs.filter((c) => c.method === 'bot.approval').length, 0, 'AC5.6 已关的卡不得再发（disabled 闸门生效）')
  // NOTE（2026-11-02 契约核对）：出货实现里「已关不再发」只由按钮 disabled 闸门承载——
  // 出货壳中 approvalDone 出现 0 次，approvalRows 不再按 approvalDone 过滤。
  // 故这里只钉出货代码真实提供的保证（disabled 闸门 ×2 方向 + 失败回滚），
  // 不钉一条已被删掉的渲染侧过滤；旧口径的「approvalDone 生效」是本单的偏差项，记在交接里。
  // 失败回滚：桥拒 ⇒ catch 复位按钮（disabled=false）⇒ 同一张卡可重发。
  const reject2 = approveButton('ap2', 'reject')
  rpcSandbox.set('document', fakeDocument([reject2]))
  rpcSandbox.set('failApproval', true)
  rpcSandbox.rpcs.length = 0
  rpcSandbox.messagesOnclick({ target: reject2 })
  await flushMicrotasks()
  assert.equal(rpcSandbox.rpcs.filter((c) => c.method === 'bot.approval').length, 1, 'AC5.6 首发被桥拒')
  assert.equal(reject2.disabled, false, 'AC5.6 失败回滚必须把按钮复位（disabled=false）')
  rpcSandbox.set('failApproval', false)
  rpcSandbox.rpcs.length = 0
  rpcSandbox.messagesOnclick({ target: reject2 })
  await flushMicrotasks()
  assert.equal(rpcSandbox.rpcs.filter((c) => c.method === 'bot.approval').length, 1, 'AC5.6 失败回滚后同一卡必须可重发')
})

test('AC5.6：answerable:false 的审批卡只画「这条要在电脑上回答」提示行，不出 data-approve 按钮', () => {
  // AC5.6 的另一半（方向）：`lib/pages.js` 的 approval 分支对 `answerable !== true` 的条目
  // 走 `block.yes` 的假分支，只画 `L.approvalPc` 提示行、不出两个按钮。上面那条用例只覆盖了
  // 可作答方向，抠不出「不可作答时按钮必须不出现」这条。文案逐字以出货 `lib/pages.js` 为准。
  rpcSandbox.set('activeSession', 's-repo')
  rpcSandbox.set('teamState', {
    bots: [{ id: 'b-repo', name: 'Repo', sessionId: 's-repo' }],
    work: { approvals: [
      { id: 'ap-pc', botId: 'b-repo', tool: 'Bash', detail: { text: 'rm -rf' }, answerable: false, sessionId: 's-repo' },
    ] },
  })
  const rows = rpcSandbox.approvalRows()
  assert.equal(rows.length, 1, 'AC5.6 不可作答的审批卡也要出现（只是不给按钮）')
  assert.equal(rows[0].blocks[0].yes, false, 'answerable !== true 必须映射成 yes:false')
  const cardHtml = renderSandbox.renderBlock(rows[0].blocks[0], false, 'ap-pc')
  assert.match(cardHtml, /这条要在电脑上回答/, 'AC5.6 不可作答必须画出「这条要在电脑上回答」提示行')
  assert.equal((cardHtml.match(/data-approve/g) || []).length, 0, 'AC5.6 不可作答不得出现任何 data-approve 按钮')
})

test('AC5.7：team.questions.items 的一条可作答（bot.answer：sessionId+questionId 逐字对上）也可关闭（bot.dismiss：sessionId）', async () => {
  rpcSandbox.set('activeSession', 's-repo')
  rpcSandbox.set('teamState', {
    bots: [{ id: 'b-repo', name: 'Repo', sessionId: 's-repo' }],
    questions: { items: [{ sessionId: 's-repo', questionId: 'q7', question: { id: 'qa', text: '要哪个？' } }] },
  })
  // botQuestion 已被 lib/ 字节瘦身内联，这里按它产出同一形状手工构造待答卡（current.bot=true 走团队通道）。
  const q = { rpcId: 'bot:q7', sessionId: 's-repo', questionId: 'q7', bot: true, questions: [{ id: 'qa', text: '要哪个？' }] }
  // 有选择 ⇒ bot.answer，payload.sessionId + payload.questionId 逐字对上。
  rpcSandbox.set('pendingQuestion', q)
  rpcSandbox.set('questionSelection', ['a'])
  rpcSandbox.rpcs.length = 0
  await rpcSandbox.submitQuestionAnswers()
  let call = rpcSandbox.rpcs.filter((c) => c.method === 'bot.answer').pop()
  assert.ok(call, 'AC5.7 有选择必须发 bot.answer')
  assert.equal(call.payload.sessionId, 's-repo', 'AC5.7 bot.answer payload.sessionId 对上')
  assert.equal(call.payload.questionId, 'q7', 'AC5.7 bot.answer payload.questionId 对上')
  // 无选择 ⇒ bot.dismiss（关闭），payload 只带 sessionId。
  rpcSandbox.set('pendingQuestion', q)
  rpcSandbox.set('questionSelection', [])
  rpcSandbox.rpcs.length = 0
  await rpcSandbox.submitQuestionAnswers()
  call = rpcSandbox.rpcs.filter((c) => c.method === 'bot.dismiss').pop()
  assert.ok(call, 'AC5.7 空作答必须转成 bot.dismiss（关闭）')
  assert.equal(call.payload.sessionId, 's-repo', 'AC5.7 bot.dismiss payload.sessionId 对上')
  // 取消入口（cancelQuestionRequest）也走 bot.dismiss{sessionId}。
  rpcSandbox.set('pendingQuestion', q)
  rpcSandbox.rpcs.length = 0
  await rpcSandbox.cancelQuestionRequests()
  call = rpcSandbox.rpcs.filter((c) => c.method === 'bot.dismiss').pop()
  assert.ok(call, 'AC5.7 cancelQuestionRequest 必须发 bot.dismiss')
  assert.equal(call.payload.sessionId, 's-repo', 'AC5.7 cancel bot.dismiss payload.sessionId 对上')
})

test('AC5.8：BOT 行改模型发 bot.update(payload.sessionId 对)，普通行不发 bot.update（两个方向都钉）', async () => {
  // BOT 行：activeSession 命中 teamState.bots 里某行 ⇒ botRowOf 返回该行 ⇒ 走 bot.update。
  rpcSandbox.set('activeSession', 's-repo')
  rpcSandbox.set('teamState', { bots: [{ id: 'b-repo', name: 'Repo', sessionId: 's-repo' }] })
  rpcSandbox.rpcs.length = 0
  await rpcSandbox.selectModel({ group: { id: 'deepseek' }, model: { id: 'chat' } })
  const updates = rpcSandbox.rpcs.filter((c) => c.method === 'bot.update')
  assert.equal(updates.length, 1, 'AC5.8 BOT 行必须发一次 bot.update')
  assert.equal(updates[0].payload.sessionId, 's-repo', 'AC5.8 bot.update payload.sessionId 对上')
  assert.equal(rpcSandbox.rpcs.some((c) => c.method === 'session.selectModel'), false, 'AC5.8 BOT 行不得发 session.selectModel')
  // 普通行：activeSession 不在 bots 里 ⇒ 走 session.selectModel，绝不发 bot.update。
  rpcSandbox.set('activeSession', 's-plain')
  rpcSandbox.set('teamState', { bots: [{ id: 'b-repo', name: 'Repo', sessionId: 's-repo' }] })
  rpcSandbox.rpcs.length = 0
  await rpcSandbox.selectModel({ group: { id: 'deepseek' }, model: { id: 'chat' } })
  assert.equal(rpcSandbox.rpcs.some((c) => c.method === 'session.selectModel'), true, 'AC5.8 普通行必须走 session.selectModel')
  assert.equal(rpcSandbox.rpcs.some((c) => c.method === 'bot.update'), false, 'AC5.8 普通行不得发 bot.update')
})

test('AC5.10：BOT 会话里 bot.earlier 更早分页可用（既有实现，出用例钉住防回归）', async () => {
  rpcSandbox.set('activeSession', 's-repo')
  rpcSandbox.set('earlierDone', false)
  rpcSandbox.set('earlierCursor', null)
  rpcSandbox.rpcs.length = 0
  const ok = await rpcSandbox.fetchEarlierPage()
  const call = rpcSandbox.rpcs.filter((c) => c.method === 'bot.earlier').pop()
  assert.ok(call, 'AC5.10 BOT 会话点「更早」必须发 bot.earlier')
  assert.equal(call.payload.sessionId, 's-repo', 'AC5.10 bot.earlier payload.sessionId 对上')
  assert.equal(call.payload.cursor, null, 'AC5.10 首次取更早页 cursor 为 null')
  assert.equal(ok, false, 'AC5.10 空页返回 false（不谎报还有更多）')
})
