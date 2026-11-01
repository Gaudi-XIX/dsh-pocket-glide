// T7–T11（BOT 页内容缺失 / 主页行状态 / 消息时间 / 子代理仍跑 / 待答提问）
//
// 这一批的验收面分两半，本文件把两半都钉住：
//   ① 注入契约：BOT 页的块渲染器必须是「从出货产物切出来的同一份源码」——
//      17 个函数、逐函数字节与判据表一致、能在服务端求值、本页不留第二份。
//   ② 画出来的东西：用一个只够用的浏览器替身执行 `BOT_PAGE_JS`，喂真实的宿主事件，
//      断言块、时间戳、行状态真的落进了 HTML。
//
// 替身是独立写的一份，不 import test/bot-page.test.js（那份的夹具为它自己的判据而设，
// 借过来会把两批的判据缠死）。这里只需要三样：按 id 取的节点、按 url 分流的 fetch、
// 记录而不触发的定时器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { BOT_PAGE_JS, renderBotPage } from '../lib/bot-page.js'
import { mobilePageAssets, messageBlocksScript, messageBlocksLabels } from '../lib/pages.js'
import { applyDescendantRunning, isRecord } from '../lib/projections.js'

/** 判据 §3 的注入清单：17 个函数与各自的 UTF-8 字节数，合计 13486。不许增减。 */
const BLOCK_WEIGHTS = {
  renderBlock: 6002,
  processLineText: 1515,
  toolActivityCategory: 793,
  activityIcon: 731,
  renderProcessLine: 601,
  contentBlocks: 595,
  processLineHtml: 562,
  isTextualAttachment: 453,
  bindOpenState: 816,
  formatBytes: 194,
  baseNameOf: 155,
  sessionFileUrl: 136,
  extOf: 123,
  isImagePath: 72,
  activityChevron: 284,
  reasoningSummary: 195,
  rememberOpenState: 259,
}
const BLOCK_TOTAL = 13486
const BLOCK_NAMES = Object.keys(BLOCK_WEIGHTS)

/** 判据 §4 的 15 个 L 键：渲染 10 + turn-error 合成 5。 */
const LABEL_KEYS = [
  'think', 'fileChip', 'imageGone', 'previewFile', 'running', 'processSep',
  'stepDone', 'stepVerbs', 'toolCount', 'toolFailedCount', 'turnError',
  'turnAborted', 'turnBlocked', 'turnMaxTokens', 'turnInterrupted',
]

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

const BRIDGE_SOURCE = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')

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
  sessionRowHasError,
  Array,
  Map,
  Number,
  Set,
}).botTeamPrefetchContext

/** JSON 往返：手机只看得见 JSON，跨 realm 的对象也用这个比。 */
const plain = (value) => JSON.parse(JSON.stringify(value))

// ---------------------------------------------------------------------------
// ① 注入契约
// ---------------------------------------------------------------------------

test('块渲染器从出货产物切片：17 个函数、逐函数同字节、合计 13486', () => {
  for (const locale of ['zh', 'en']) {
    const script = messageBlocksScript(locale)
    let total = 0
    for (const name of BLOCK_NAMES) {
      const bytes = Buffer.byteLength(sliceFunction(script, name), 'utf8')
      assert.equal(bytes, BLOCK_WEIGHTS[name], `${locale}: ${name} 的注入字节必须与判据表一致`)
      total += bytes
    }
    assert.equal(total, BLOCK_TOTAL, `${locale}: 17 个函数合计必须 ${BLOCK_TOTAL} B`)
    // processRows 不在调用图里（renderBlock 不调它），注进来就是多一份。
    assert.equal(script.includes('function processRows('), false, 'processRows 不在闭包里')
    // 两张扩展名表是函数裸用的全局，照行从同一份出货文本带出来。
    assert.equal(script.includes("const IMAGE_FILE_EXTS=['png','jpg','jpeg','gif','webp','bmp','avif'];"), true)
    assert.match(script, /const TEXT_FILE_EXTS=\['txt',/)
    // 服务端求值自证：切错了这里就抛 SyntaxError。
    const api = new Function(`${script}\nreturn {${BLOCK_NAMES.join(',')}}`)()
    for (const name of BLOCK_NAMES) assert.equal(typeof api[name], 'function', `${name} 必须可调用`)
    assert.deepEqual(JSON.parse(JSON.stringify(api.contentBlocks([{ type: 'text', text: 'hi' }]))), [{ kind: 'text', text: 'hi' }])
  }
  // 函数源码与语言无关（词表在 L 里），所以一份注入就够。
  assert.equal(messageBlocksScript('zh'), messageBlocksScript('en'), 'zh 与 en 的函数源码逐字节相同')
})

test('L 子集：15 键、两张步骤表整张带上、zh/en 各一份', () => {
  const zh = messageBlocksLabels('zh')
  const en = messageBlocksLabels('en')
  assert.deepEqual(Object.keys(zh).sort(), [...LABEL_KEYS].sort(), '取的就是那 15 个键，不多不少')
  assert.deepEqual(Object.keys(en).sort(), [...LABEL_KEYS].sort())
  assert.equal(Object.keys(zh.stepDone).length, 13, 'stepDone 13 键全留')
  assert.equal(Object.keys(zh.stepVerbs).length, 13, 'stepVerbs 13 键全留')
  assert.equal(zh.think, '思考')
  assert.equal(en.think, 'Think')
  assert.equal(zh.turnError, '运行出错')
  assert.equal(en.turnError, 'Error')
})

test('BOT 页自己的脚本文本里，块渲染器只出现一份', () => {
  assert.equal(BOT_PAGE_JS.includes(messageBlocksScript('zh')), true, '注进本页的就是切出来的那一份')
  for (const name of BLOCK_NAMES) {
    const count = BOT_PAGE_JS.split('function ' + name + '(').length - 1
    assert.equal(count, 1, `${name} 在本页只能有一份声明`)
  }
  // 未读判定同样是一份源码，不是第二套规则。
  assert.equal(BOT_PAGE_JS.split('function isRowUnread(').length - 1, 1)
})

// ---------------------------------------------------------------------------
// ② 画出来的东西：一个只够用的浏览器替身
// ---------------------------------------------------------------------------

const SHELL_IDS = new Set(
  [...renderBotPage({ locale: 'zh', cssUrl: '/app.css', jsUrl: '/bot.js' }).matchAll(/id="([^"]+)"/g)].map((m) => m[1])
)

/**
 * 执行 BOT_PAGE_JS，返回能读能推的那几样东西。
 * @param {{answer?: (method: string, payload: any) => any, openedAt?: Record<string, number>, openedFails?: boolean}} options
 */
function fakeBrowser({ answer = () => ({}), openedAt = {}, openedFails = false } = {}) {
  const nodes = new Map()
  const nodeListeners = new Map()
  const windowListeners = new Map()
  const documentListeners = new Map()
  const timers = []
  const calls = []
  const beaconed = []

  function makeNode(id) {
    const classes = new Set()
    const attrs = new Map()
    const made = {
      id,
      hidden: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      value: '',
      checked: false,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      dataset: {},
      style: {},
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
          const on = force === undefined ? !classes.has(name) : Boolean(force)
          if (on) classes.add(name)
          else classes.delete(name)
          return on
        },
      },
      addEventListener: (type, fn) => nodeListeners.set(id + ':' + type, fn),
      removeEventListener: () => {},
      setAttribute: (name, value) => attrs.set(name, String(value)),
      getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
      closest: () => null,
      contains: () => false,
      remove: () => {},
      focus: () => {},
      blur: () => {},
      click: () => {},
      appendChild: () => {},
      insertAdjacentHTML: () => {},
      matches: () => false,
    }
    nodes.set(id, made)
    return made
  }
  for (const id of SHELL_IDS) makeNode(id)

  const classes = new Set(['bp-list', 'bp-loading', 'bp-busy'])
  const document = {
    title: 'DS Bot',
    hidden: false,
    body: {
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
          const on = force === undefined ? !classes.has(name) : Boolean(force)
          if (on) classes.add(name)
          else classes.delete(name)
          return on
        },
      },
    },
    documentElement: { lang: 'zh-CN' },
    getElementById: (id) => {
      if (!SHELL_IDS.has(id)) throw new Error(`the page asked for #${id}, which the shell does not ship`)
      return nodes.get(id) || makeNode(id)
    },
    addEventListener: (type, fn) => documentListeners.set(type, fn),
  }
  const window = { addEventListener: (type, fn) => windowListeners.set(type, fn), history: { length: 2, back: () => {}, replaceState: () => {} } }
  const location = { hash: '', href: '', origin: 'http://127.0.0.1:9896', pathname: '/bot', search: '' }
  const store = new Map()
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
  const navigator = { sendBeacon: (url, body) => (beaconed.push({ url, body }), true) }
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.handlers = Object.create(null)
      this.closed = false
      this.onerror = null
    }
    addEventListener(type, fn) {
      ;(this.handlers[type] ??= []).push(fn)
    }
    close() {
      this.closed = true
    }
  }
  const jsonOf = (value, ok = true, status = 200) => ({ ok, status, json: () => Promise.resolve(value) })
  const fetch = (url, options) => {
    if (url === '/api/status') return Promise.resolve(jsonOf({ ok: true, connected: true }))
    if (url === '/api/opened-at') {
      if (options && options.method === 'POST') {
        calls.push({ url, body: JSON.parse(options.body) })
        return Promise.resolve(jsonOf({ ok: true, entries: 0 }))
      }
      if (openedFails) return Promise.resolve(jsonOf({ ok: false, error: 'nope' }, false, 500))
      return Promise.resolve(jsonOf({ ok: true, openedAt }))
    }
    const body = JSON.parse(options.body)
    calls.push({ method: body.method, payload: body.payload })
    const result = answer(body.method, body.payload) ?? {}
    const failed = result && result.ok === false
    return Promise.resolve({
      ok: !failed,
      status: failed ? 409 : 200,
      json: () => Promise.resolve(failed
        ? { ok: false, error: { message: result.error, code: result.code } }
        : { ok: true, value: result }),
    })
  }
  const fakeSetTimeout = (fn, ms) => {
    timers.push({ fn, ms })
    return timers.length
  }
  const fakeSetInterval = (fn, ms) => {
    timers.push({ fn, ms, repeat: true })
    return timers.length
  }
  new Function(
    'document', 'window', 'location', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Intl', 'localStorage', 'navigator', 'EventSource',
    BOT_PAGE_JS
  )(document, window, location, fetch, fakeSetInterval, () => {}, fakeSetTimeout, () => {}, Intl, localStorage, navigator, FakeEventSource)

  /** 把已经排到的微任务都跑完（替身的 fetch 全是同步 resolve 的 Promise）。 */
  const flush = async (rounds = 24) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
  }
  /** 只推某一档的定时器（页面给每个 rpc 挂 12000、账本 2000）。 */
  const fireTimers = (ms) => {
    const due = timers.filter((entry) => entry.ms === ms)
    for (const entry of due) entry.fn()
    return due.length
  }
  const openChat = async (sessionId) => {
    location.hash = '#s=' + encodeURIComponent(sessionId) + '&k=bot&t=Repo'
    const route = windowListeners.get('hashchange')
    assert.ok(typeof route === 'function', 'the page must listen for hashchange')
    route()
    await flush()
  }
  const goList = async () => {
    location.hash = ''
    const route = windowListeners.get('hashchange')
    assert.ok(typeof route === 'function', 'the page must listen for hashchange')
    route()
    await flush()
  }
  const click = (id, event) => {
    const fn = nodeListeners.get(id + ':click')
    assert.ok(typeof fn === 'function', `#${id} must have a click listener`)
    fn(event)
  }
  return { node: (id) => nodes.get(id), classes, calls, timers, flush, fireTimers, openChat, goList, click, location, beaconed }
}

/** 夹具的「现在」：固定住，否则每次重读 bot.team 都拿新的 Date.now()，刚读过的行又会变未读。 */
const BOT_NOW = Date.now()

/** 一份只含这一批用得到的 bot.team 应答。 */
function teamAnswer(overrides = {}) {
  return {
    revision: 3,
    mainBotIds: ['b-repo'],
    bots: [
      { id: 'b-repo', name: 'Repo', role: 'editor', model: 'deepseek/x', sessionId: 's-repo', waiting: false, hidden: false, updatedAt: BOT_NOW },
      { id: 'b-scout', name: 'Scout', role: 'researcher', sessionId: 's-scout', waiting: false, hidden: false, updatedAt: BOT_NOW - 5000 },
    ],
    rooms: [],
    questions: { count: 0 },
    work: { bots: {}, rooms: [] },
    ...overrides,
  }
}

/** 一段真实形状的宿主事件流：块、工具结果、报错收尾都齐。
 *  记录的 seq 与 time 挂在 event 上——pageSeq 读 event.seq、stampOf 读 event.time。 */
function historyAnswer() {
  const at = Date.now()
  const record = (seq, type, data) => ({ event: { type, seq, time: at, data }, time: at })
  return {
    hasMore: false,
    events: [
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
      // 第七类块：交付物（landing 的 deliverables/presented 出口）
      record(7, 'deliverables/presented', { files: [{ path: '/tmp/out/report.png', description: '结果图' }, { path: '/tmp/out/report.txt' }] }),
    ],
  }
}

/** 更早的记录（bot.earlier）：每条都带自己的时间，正文是纯文本。 */
function earlierAnswer() {
  const at = Date.now()
  return {
    cursor: null,
    items: [
      { kind: 'divider', text: '', time: at },
      { kind: 'user', text: '早前的问', time: at },
      { kind: 'assistant', text: '早前的答', time: at },
      { kind: 'event', name: 'Curator', time: at },
    ],
  }
}

function bootChat(options = {}) {
  return fakeBrowser({
    answer: (method, payload) => {
      if (method === 'bot.team') return teamAnswer(options.team)
      if (method === 'session.history') {
        return payload && payload.sessionId === 's-repo' || !payload || !payload.sessionId ? historyAnswer() : { events: [], hasMore: false }
      }
      if (method === 'bot.earlier') return earlierAnswer()
      return {}
    },
    ...options,
  })
}

test('T7：会话页画齐 text / reasoning / tool / image / file / turn-error，且块走同一份渲染器', async () => {
  const browser = bootChat()
  await browser.flush()
  await browser.openChat('s-repo')
  const html = browser.node('bpMsgs').innerHTML

  assert.match(html, /<div class="bp-msg message user"><div class="markdown"><p>把页面修一下<\/p><\/div>/, 'user 行仍是原来的单层 .markdown')
  assert.match(html, /<div class="markdown"><p>看完了，接着改。<\/p><\/div>/, 'text 块由 renderBlock 画，外层 .markdown 只此一层')
  assert.match(html, /<details class="thinking" data-open-key="2#think1"/, 'reasoning 块是 <details class="thinking">，键是 <seq>#think<n>')
  assert.match(html, /<span class="activity-summary">先看清结构<\/span>/, 'reasoning 摘要走 reasoningSummary')
  assert.match(html, /<div class="process-line" data-state="done"/, 'tool 块画成 .process-line，tool/result 回填后是 done 不是 running')
  assert.match(html, /data-file-preview="att-2"/, '文件块是 .attach-file 的可预览形态')
  assert.match(html, /class="attach-file-bytes">2\.0 KB/, 'formatBytes 生效')
  assert.match(html, /<div class="attach-image"><img loading="lazy"[^>]*src="\/api\/session-attachment\?sessionId=s-repo&attachmentId=att-1"/, '图片块用当前会话号拼地址')
  assert.match(html, /<div class="turn-error-bubble">[\s\S]*?<span class="turn-error-title">运行出错<\/span><span class="turn-error-detail">boom<\/span>/, 'turn/end(error) 出收尾气泡')
  assert.match(html, /<div class="presented-group"><figure class="attach-image presented-image"><img[^>]*data-path="\/tmp\/out\/report\.png"[^>]*src="\/api\/session-file\?sessionId=s-repo&path=%2Ftmp%2Fout%2Freport\.png"[^>]*><figcaption class="presented-desc">结果图<\/figcaption><\/figure><a class="attach-file presented-file" href="[^"]*report\.txt"/, 'presented 块画成 .presented-group（图 + 文件）')
  // 已知差异（判据登记）：bindOpenState 后半段找 #messages，本页容器是 #bpMsgs，不命中。
  assert.equal(html.includes('id="bpTurnStatus"'), false, '这里没有正在干活，就不挂 turn-status')
  assert.equal(browser.classes.has('bp-chat'), true)
})

test('T7：只含 reasoning 的消息不再整行丢掉', async () => {
  const browser = bootChat()
  await browser.flush()
  await browser.openChat('s-repo')
  const html = browser.node('bpMsgs').innerHTML
  assert.match(html, /再想一步/, '只有思考的一条也要画出来')
  assert.equal((html.match(/<details class="thinking"/g) || []).length, 2, '两条 reasoning 各一个折叠')
})

test('T7：没有块的行整格不动（user 行仍是文本渲染）', async () => {
  const browser = bootChat()
  await browser.flush()
  await browser.openChat('s-repo')
  const html = browser.node('bpMsgs').innerHTML
  assert.match(
    html,
    /<div class="bp-msg message user"><div class="markdown"><p>把页面修一下<\/p><\/div>(<span class="bp-tail">\d{2}:\d{2}<\/span>)?<\/div>/,
    'user 行仍是「行 div + 一层 .markdown」的老样子，没有被块渲染接管'
  )
})

test('T9：更早的记录里每一条消息行与 divider 都带时间', async () => {
  const browser = bootChat()
  await browser.flush()
  await browser.openChat('s-repo')
  // 替身的消息区量不到一屏高 ⇒ 页面自己会往回补，补的就是 bot.earlier 那一段。
  await browser.flush()
  const html = browser.node('bpMsgs').innerHTML
  assert.match(html, /<div class="bp-divider"><span>\d{2}:\d{2} · 更早的记录<\/span><\/div>/, 'divider 带时间')
  assert.match(html, /<div class="bp-msg message user"><div class="markdown"><p>早前的问<\/p><\/div><span class="bp-tail">\d{2}:\d{2}<\/span><\/div>/, '更早的 user 行带时间')
  assert.match(html, /<div class="bp-msg message assistant"><div class="markdown"><p>早前的答<\/p><\/div><span class="bp-tail">\d{2}:\d{2}<\/span><\/div>/, '更早的 assistant 行带时间')
  // 「· 名字」那类行显式豁免：markup 被既有断言钉死，本批不画时间。
  assert.match(html, /<div class="bp-event">· Curator<\/div>/, 'event 行仍是不带时间的原样')
})

test('T10（页）：主 turn 结束但子代理还在跑 ⇒ 行仍是 is-running', async () => {
  const browser = fakeBrowser({
    openedAt: { 's-repo': Date.now(), 's-scout': Date.now() },
    answer: (method) => {
      if (method === 'bot.team') {
        return teamAnswer({
          work: { bots: {}, rooms: [] },
        })
      }
      return {}
    },
  })
  await browser.flush()
  // 桥侧已把 descendantRunning 标上（T10 桥侧那条测试钉住它怎么来的）。
  const html = browser.node('bpMembersList').innerHTML
  assert.match(html, /class="task-row is-done[^"]*"[^>]*data-sid="s-repo"/, '没有子代理在跑时是 is-done（基线）')

  const busy = fakeBrowser({
    openedAt: { 's-repo': Date.now(), 's-scout': Date.now() },
    answer: (method) => {
      if (method === 'bot.team') {
        const team = teamAnswer()
        team.bots[0].descendantRunning = true
        team.bots[0].working = false
        return team
      }
      return {}
    },
  })
  await busy.flush()
  const marked = busy.node('bpMembersList').innerHTML
  assert.match(marked, /class="task-row[^"]*is-running[^"]*"[^>]*data-sid="s-repo"/, '子孙还在跑，这一行必须转圈')
  assert.equal(/class="task-row[^"]*is-done[^"]*"[^>]*data-sid="s-repo"/.test(marked), false, '不许落绿勾')
})

test('T11（页）：有提问卡待答 ⇒ is-awaiting，且不再落 is-running / is-done', async () => {
  const browser = fakeBrowser({
    openedAt: { 's-repo': Date.now(), 's-scout': Date.now() },
    answer: (method) => {
      if (method === 'bot.team') {
        const team = teamAnswer({
          questions: { count: 1, items: [{ botId: 'b-repo', sessionId: 's-repo', questionId: 'q-1', question: '选哪条路？' }] },
        })
        // 主 turn 也在跑：待答优先于忙（判据 §T11 第三条）。
        team.work = { bots: { 'b-repo': { tool: 'Bash' } }, rooms: [] }
        return team
      }
      if (method === 'session.history') return { events: [], hasMore: false }
      return {}
    },
  })
  await browser.flush()
  const html = browser.node('bpMembersList').innerHTML
  assert.match(html, /class="task-row[^"]*is-awaiting[^"]*"[^>]*data-sid="s-repo"/, '待答 ⇒ is-awaiting')
  const row = /<button class="[^"]*is-awaiting[^"]*"[^>]*data-sid="s-repo"/.exec(html)[0]
  assert.equal(row.includes('is-running'), false, 'is-running 不许同时出现')
  assert.equal(row.includes('is-done'), false, 'is-done 不许同时出现')
  // 没有提问卡的另一个 Bot 行不受影响。
  assert.match(html, /class="task-row is-done"[^>]*data-sid="s-scout"/)
})

test('T8（页）：is-error 与 is-unread 只加类名，账本未到手时一条红点都不画', async () => {
  const seeded = fakeBrowser({
    openedAt: { 's-repo': Date.now() - 60_000, 's-scout': Date.now() },
    answer: (method) => {
      if (method === 'bot.team') {
        const team = teamAnswer()
        team.bots[0].updatedAt = BOT_NOW
        team.bots[1].updatedAt = 0
        return team
      }
      return {}
    },
  })
  await seeded.flush()
  const html = seeded.node('bpMembersList').innerHTML
  assert.match(html, /class="task-row[^"]*is-unread[^"]*"[^>]*data-sid="s-repo"/, '有比打开时刻更新的内容 ⇒ is-unread')
  // 桥侧下发的 error 字段（T8 桥侧那条测试钉住它怎么来的）。
  const errored = fakeBrowser({
    answer: (method) => {
      if (method === 'bot.team') {
        const team = teamAnswer()
        team.bots[0].error = true
        return team
      }
      return {}
    },
  })
  await errored.flush()
  assert.match(errored.node('bpMembersList').innerHTML, /class="task-row[^"]*is-error[^"]*"[^>]*data-sid="s-repo"/, 'error ⇒ 整行着色')

  // fail-closed：账本拉失败＝空账本＝全无未读，不许把整页点亮。
  const noLedger = fakeBrowser({
    openedFails: true,
    answer: (method) => {
      if (method === 'bot.team') {
        const team = teamAnswer()
        team.bots[0].updatedAt = BOT_NOW
        return team
      }
      return {}
    },
  })
  await noLedger.flush()
  assert.equal(noLedger.node('bpMembersList').innerHTML.includes('is-unread'), false, '账本没到手就不画红点')
})

test('T8（页）：打开会话后账本记成已读并 debounce 上推给桥', async () => {
  const browser = bootChat({ openedAt: { 's-repo': BOT_NOW - 60_000, 's-scout': BOT_NOW } })
  await browser.flush()
  assert.match(browser.node('bpMembersList').innerHTML, /class="task-row[^"]*is-unread[^"]*"[^>]*data-sid="s-repo"/, '打开之前那一行有红点')
  await browser.openChat('s-repo')
  assert.equal(browser.fireTimers(2000), 1, '账本上传挂在 2 秒防抖上')
  await browser.flush()
  const posts = browser.calls.filter((call) => call.url === '/api/opened-at')
  assert.equal(posts.length, 1, '整份上传一次')
  assert.ok(typeof posts[0].body.openedAt['s-repo'] === 'number', '上传的是整张 map')
  // 回到列表：这一行不该再有红点（hashchange 由替身自己推）。
  browser.goList()
  await browser.flush()
  assert.equal(/class="task-row[^"]*is-unread[^"]*"[^>]*data-sid="s-repo"/.test(browser.node('bpMembersList').innerHTML), false, '读过就不该再有红点')
})

test('T8/T10（桥）：error 与 descendantRunning 由 prefetch 上下文供，旧调用路径不出现这两个键', () => {
  const items = [
    { sessionId: 's1', updatedAt: 111, running: false, status: 'error' },
    { sessionId: 's2', origin: 'subagent', parentSessionId: 's1', running: true },
    { sessionId: 's3', updatedAt: 222, running: false },
  ]
  const ctx = botTeamPrefetchContext.call({
    workspaceSnapshot: { pinnedSessionIds: [] },
    _sessionListValue: { result: { ok: true, value: { items } } },
  })
  assert.equal(ctx.descendantRunningOf('s1'), true, '子孙在跑 ⇒ 父行标 descendantRunning')
  assert.equal(ctx.descendantRunningOf('s3'), false, '没有子孙在跑就是 false')
  assert.equal(ctx.descendantRunningOf('s2'), false, '还在跑的那一行自己的 running 已经是 true，不靠这个标记')
  assert.equal(ctx.errorOf('s1'), true, 'sessionRowHasError 判据：status=error')
  assert.equal(ctx.errorOf('s3'), false)

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
  // 首次 session/list 还没回来：两张表留空，取值器照旧存在但答 false。
  const cold = botTeamPrefetchContext.call({ workspaceSnapshot: { pinnedSessionIds: [] }, _sessionListValue: null })
  assert.equal(cold.errorOf('s1'), false)
  assert.equal(cold.descendantRunningOf('s1'), false)
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
