// AC-CLI regression for the desktop client half (WP-CLIENT): every user-facing
// string in client/client.js must come from the I18N table, never from a
// hard-coded literal.
//
// The client half cannot be imported: it registers through the host browser
// global `window.__ModuleLoader__` and takes `require` as a factory argument,
// so `import`/`require` of the file would fail outside the host. The test
// therefore reads the source text with fs and runs it inside a `node:vm`
// context with a minimal fake DOM plus a fake locale service — the same two
// halves the card pins: source-level negative guards and behavioural checks.
//
// Cross-realm note (Durable Finding): arrays and objects built inside the vm
// have a different Array.prototype than the host's, so any value that
// originates in the sandbox is normalized with Array.from / spread before it
// reaches assert.deepEqual.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../client/client.js', import.meta.url))
const SRC = readFileSync(CLIENT_PATH, 'utf8')

/* ------------------------------------------------------------------ *
 * fake DOM
 * ------------------------------------------------------------------ */

class Node {
  constructor(tag) {
    this.tagName = tag
    this.children = []
    this.attrs = {}
    this.style = {}
    this.dataset = {}
    this.listeners = {}
    this.parentNode = null
    this._text = ''
    this.id = ''
    this.className = ''
    this.type = ''
  }
  get textContent() {
    return this._text
  }
  set textContent(v) {
    this._text = String(v)
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v)
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null
  }
  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child)
    child.parentNode = null
    return child
  }
  addEventListener(name, fn) {
    ;(this.listeners[name] ??= []).push(fn)
  }
  removeEventListener(name, fn) {
    this.listeners[name] = (this.listeners[name] ?? []).filter((f) => f !== fn)
  }
  matchesSel(sel) {
    if (sel === 'iframe') return this.tagName === 'iframe'
    if (sel.startsWith('.')) return String(this.className).split(/\s+/).includes(sel.slice(1))
    return false
  }
  descendants() {
    const out = []
    const walk = (n) => {
      for (const c of n.children) {
        out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
  querySelector(sel) {
    return this.descendants().find((n) => n.matchesSel(sel)) ?? null
  }
  querySelectorAll(sel) {
    return this.descendants().filter((n) => n.matchesSel(sel))
  }
}

function makeSandbox(lang) {
  const doc = new Node('#document')
  doc.head = new Node('head')
  doc.body = new Node('body')
  doc.documentElement = { lang }
  doc._byId = new Map()
  doc.createElement = (tag) => new Node(tag)
  doc.getElementById = (id) => doc._byId.get(id) ?? null

  const win = { location: { origin: 'dsh-app://app' }, listeners: {} }
  win.addEventListener = (name, fn) => {
    ;(win.listeners[name] ??= []).push(fn)
  }
  win.removeEventListener = (name, fn) => {
    win.listeners[name] = (win.listeners[name] ?? []).filter((f) => f !== fn)
  }

  const loaded = []
  win.__ModuleLoader__ = { load: (def) => loaded.push(def) }
  const logs = { log: [], warn: [], error: [] }
  const sandbox = {
    window: win,
    document: doc,
    console: {
      log: (m) => logs.log.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
      error: (m) => logs.error.push(String(m)),
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SRC, sandbox)
  assert.equal(loaded.length, 1, 'the client half must register exactly one module via __ModuleLoader__')
  return { doc, win, logs, def: loaded[0] }
}

// PocketButton / PhoneIcon are function components, so createElement must call
// them; native tags become plain element descriptors for the assertions below.
const reactStub = () => ({
  createElement: (type, props, ...kids) => {
    if (typeof type === 'function') return type({ ...(props || {}), children: kids })
    return { type, props: props || {}, kids }
  },
})

function mount(lang, localeActive) {
  const { doc, win, logs, def } = makeSandbox(lang)
  const req = (name) => {
    if (name === 'react') return reactStub()
    throw new Error('unknown require ' + name)
  }
  const api = def.factory(req)
  // the inject list is a sandbox-realm array: normalize before deepEqual
  assert.deepEqual(Array.from(api.inject), ['slots'], 'module.exports.inject must stay ["slots"]')

  const registrations = []
  const disposals = []
  let handler = null
  const ctx = {
    slots: {
      inject: (name, factory) => {
        registrations.push(factory())
        return () => {
          disposals.push(name)
        }
      },
      register: (meta, render) => ({ ...meta, render }),
    },
    on: (event, fn) => {
      assert.equal(event, 'locale/change', 'the client must subscribe to the host locale event')
      handler = fn
      return () => {
        handler = null
      }
    },
  }
  if (localeActive !== undefined) ctx.locale = { getLocale: () => ({ active: localeActive }) }
  const dispose = api.apply(ctx)

  return {
    doc,
    win,
    logs,
    ctx,
    registrations,
    disposals,
    dispose,
    fireLocale: (snap) => handler && handler(snap),
    setLocale: (active) => {
      ctx.locale = { getLocale: () => ({ active }) }
    },
  }
}

const renderBtn = (r, wide = true) => r.registrations.at(-1).render({ wide })
const label = (r) => renderBtn(r).props['aria-label']

function openModal(r) {
  renderBtn(r).props.onClick()
  const overlay = r.doc.body.children.find((n) => n.className === 'dsh-pocket-overlay')
  assert.ok(overlay, 'the overlay must be mounted on body')
  const panel = overlay.children[0]
  return {
    r,
    panel,
    // The modal is overlay > panel > (body + close); the body holds the status
    // line and the paired iframe. Locate children by class, never by order.
    close: panel.querySelector('.dsh-pocket-close'),
    frame: panel.querySelector('iframe'),
    status: panel.querySelector('.dsh-pocket-status'),
  }
}

const statusOf = (m) => m.panel.querySelector('.dsh-pocket-status')

// The sidebar label is the product name `pocket` in BOTH packs, so it can no
// longer separate the locales on its own (that is the point of the rename).
// Every locale-resolution assertion below is therefore paired with the zh-only
// close string, which is what actually proves which pack the client resolved.
const closeLabel = (r) => openModal(r).close.getAttribute('aria-label')

/* ------------------------------------------------------------------ *
 * I18N table, read straight off the source text
 * ------------------------------------------------------------------ */

const TABLE_MATCH = SRC.match(/var I18N = (\{[\s\S]*?\n    \})/)
const I18N = TABLE_MATCH
  ? vm.runInContext('(' + TABLE_MATCH[1] + ')', vm.createContext({}))
  : null

const KEYS = [
  // 模态外壳(WP-CLIENT 原七键)
  'label', 'close', 'opening', 'frameTitle', 'openFailed', 'reactUnavailable', 'slotsUnavailable',
]

/* ------------------------------------------------------------------ *
 * behavioural: locale resolution
 * ------------------------------------------------------------------ */

test('the client registers once by package name and keeps inject = ["slots"]', () => {
  const box = makeSandbox('zh-CN')
  assert.equal(box.def.id, '@defws/dsh-pocket', 'registered under the package name')
  assert.equal(typeof box.def.factory, 'function')
  const r = mount('zh-CN')
  assert.equal(typeof r.dispose, 'function', 'apply must hand back a disposer')
  assert.equal(r.registrations.length, 1, 'one sidebar registration per apply')
})

test('with no host locale service the client falls back to <html lang>, unknown tags resolve to en', () => {
  assert.equal(label(mount('zh-CN')), 'pocket', 'html lang=zh-CN → zh')
  assert.equal(closeLabel(mount('zh-CN')), '关闭', 'html lang=zh-CN really resolved the zh pack')
  assert.equal(label(mount('en-US')), 'pocket', 'html lang=en-US → en')
  assert.equal(closeLabel(mount('en-US')), 'Close', 'html lang=en-US really resolved the en pack')
  assert.equal(label(mount('ja-JP')), 'pocket', 'unknown language ja falls back to en')
  assert.equal(label(mount('')), 'pocket', 'an empty lang attribute falls back to en')
  assert.equal(label(mount('zh-TW')), 'pocket', 'zh-TW must not degrade to English (/^zh/i)')
  assert.equal(closeLabel(mount('zh-TW')), '关闭', 'zh-TW must not degrade to English (/^zh/i)')
})

test('the host locale service outranks <html lang> in both directions', () => {
  assert.equal(label(mount('en-US', 'zh-TW')), 'pocket', 'ctx.locale overrides html lang')
  assert.equal(closeLabel(mount('en-US', 'zh-TW')), '关闭', 'ctx.locale overrides html lang')
  assert.equal(label(mount('zh-CN', 'en-US')), 'pocket', 'ctx.locale overrides html lang (reverse)')
  assert.equal(closeLabel(mount('zh-CN', 'en-US')), 'Close', 'ctx.locale overrides html lang (reverse)')
})

test('the visible label, the rail title and the omitted text node share one source', () => {
  const zh = mount('zh-CN', 'zh')
  assert.equal(renderBtn(zh).kids[1].kids[0], 'pocket', 'the wide label comes from the same key')
  assert.equal(renderBtn(zh, false).props.title, 'pocket', 'the narrow title comes from the same key')
  assert.equal(renderBtn(zh, false).kids[1], null, 'the rail renders no text node')
})

test('locale/change withdraws the old registration and re-registers exactly once', () => {
  const live = mount('en-US', 'en-US')
  assert.equal(label(live), 'pocket')
  assert.equal(closeLabel(live), 'Close', 'the en pack is the one on screen before the switch')

  live.setLocale('zh-CN')
  live.fireLocale({ active: 'zh-CN' })
  assert.deepEqual(live.disposals, ['sidebar.footer.action'], 'switching language must withdraw the old registration')
  assert.equal(live.registrations.length, 2, 'switching language re-registers once')
  assert.equal(label(live), 'pocket')
  assert.equal(closeLabel(live), '关闭', 'the switch really moved the shell to the zh pack')

  live.fireLocale({ active: 'zh-CN' })
  assert.equal(live.registrations.length, 2, 'a burst of the same language must not re-register')
  live.fireLocale({ active: 'zh' })
  assert.equal(live.registrations.length, 2, 'zh and zh-CN normalize to one locale, so still no re-registration')
})

test('dispose unwinds the subscription and the registration, and later events stay inert', () => {
  const gone = mount('zh-CN', 'zh')
  const registeredBefore = gone.registrations.length
  gone.dispose()
  assert.deepEqual(gone.disposals, ['sidebar.footer.action'], 'dispose withdraws the registration once')

  gone.setLocale('en-US')
  gone.fireLocale({ active: 'en-US' })
  assert.equal(gone.registrations.length, registeredBefore, 'after dispose a locale event must not re-register')
})

/* ------------------------------------------------------------------ *
 * behavioural: the modal shell
 * ------------------------------------------------------------------ */

test('every string on the modal shell comes from the table, in zh and in en', () => {
  const zhModal = openModal(mount('zh-CN', 'zh'))
  assert.equal(zhModal.panel.getAttribute('aria-label'), 'pocket')
  assert.equal(zhModal.close.getAttribute('aria-label'), '关闭')
  assert.equal(zhModal.frame.getAttribute('title'), '连接移动设备')
  assert.equal(zhModal.status.textContent, '正在打开手机连接…')

  const enModal = openModal(mount('en-US', 'en-US'))
  assert.equal(enModal.panel.getAttribute('aria-label'), 'pocket')
  assert.equal(enModal.close.getAttribute('aria-label'), 'Close')
  assert.equal(enModal.frame.getAttribute('title'), 'Connect Mobile Device')
  assert.equal(enModal.status.textContent, 'Opening phone connection…')
})

test('the iframe error branch reports through the openFailed key, not a literal', () => {
  const fail = openModal(mount('en-US', 'en-US'))
  fail.frame.listeners.error[0]()
  assert.equal(
    statusOf(fail).textContent,
    'Failed to open the phone connection. Restart DSH and try again.',
    'the failure string is the table value for openFailed'
  )

  // an unknown host language still opens a fully English shell
  const jaModal = openModal(mount('ja-JP'))
  assert.equal(jaModal.close.getAttribute('aria-label'), 'Close')
  assert.equal(jaModal.status.textContent, 'Opening phone connection…')
})

test('a locale switch while the modal is open re-resolves every shell string', () => {
  const live = openModal(mount('en-US', 'en-US'))
  live.frame.listeners.error[0]()
  assert.equal(statusOf(live).textContent, 'Failed to open the phone connection. Restart DSH and try again.')

  live.r.setLocale('zh-CN')
  live.r.fireLocale({ active: 'zh-CN' })
  assert.equal(live.panel.getAttribute('aria-label'), 'pocket')
  assert.equal(live.close.getAttribute('aria-label'), '关闭')
  assert.equal(live.frame.getAttribute('title'), '连接移动设备')
  assert.equal(statusOf(live).textContent, '手机连接打开失败，请重启 DSH 后再试。', 'the remembered status key re-resolves')

  live.r.fireLocale({ active: 'zh' })
  assert.equal(live.r.registrations.length, 2, 'the language did not really change, so no extra re-registration')
  assert.equal(statusOf(live).textContent, '手机连接打开失败，请重启 DSH 后再试。')
})

/* ------------------------------------------------------------------ *
 * source-level negative guards (AC-CLI literal)
 * ------------------------------------------------------------------ */

const CJK = /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f\u3040-\u30ff\u31c0-\u31ef]/

// Three-zone lexical walk over the raw source: code / string literal / comment.
// Only the I18N table may hold CJK, so the string-literal bucket must equal the
// CJK characters of I18N.zh exactly — nothing more (no stray literal), nothing
// less (the table itself is what is being pinned).
function scanCjk(text) {
  const buckets = { code: [], string: [], comment: [] }
  let state = 'code'
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const two = text.slice(i, i + 2)
    if (state === 'code') {
      if (two === '/*') {
        state = 'block'
        i++
        continue
      }
      if (two === '//') {
        state = 'line'
        i++
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        state = 'string'
        quote = c
        continue
      }
      if (CJK.test(c)) buckets.code.push(c)
      continue
    }
    if (state === 'string') {
      if (c === '\\') {
        i++
        continue
      }
      if (c === quote) {
        state = 'code'
        continue
      }
      if (CJK.test(c)) buckets.string.push(c)
      continue
    }
    if (state === 'block') {
      if (two === '*/') {
        state = 'code'
        i++
      } else if (CJK.test(c)) buckets.comment.push(c)
      continue
    }
    if (c === '\n') state = 'code'
    else if (CJK.test(c)) buckets.comment.push(c)
  }
  return { code: buckets.code.join(''), comment: buckets.comment.join(''), strings: buckets.string }
}

test('no CJK survives outside the I18N table and the string literals equal its zh pack exactly', () => {
  const scan = scanCjk(SRC)
  assert.equal(scan.code, '', 'the code zone (neither comment nor literal) must hold no CJK')

  const wholeTable = (SRC.match(/var I18N = \{[\s\S]*?\n    \}/) ?? [''])[0]
  assert.ok(wholeTable.length > 0, 'the I18N table must exist in the source')
  // Anchor at the pack declarations' own lines: a bare indexOf('en:') lands
  // mid-key the moment any key name ends in "en" (lastSeen), truncating the
  // zh pack and failing the equality below for the wrong reason.
  const zhStart = wholeTable.indexOf('\n      zh: {')
  const enStart = wholeTable.indexOf('\n      en: {')
  const zhPart = wholeTable.slice(zhStart, enStart)
  assert.ok(zhStart >= 0 && enStart > zhStart, 'both pack declarations must be present')
  assert.ok(zhPart.length > 0 && zhPart.includes('关闭'), 'the I18N.zh pack must be present')

  const inZhTable = zhPart.replace(/[^\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/g, '')
  assert.equal(
    [...scan.strings].sort().join(''),
    [...inZhTable].sort().join(''),
    'every CJK character inside a string literal must be, and must only be, I18N.zh content'
  )
})

test('the hard-coded literals named by AC-CLI are gone', () => {
  assert.doesNotMatch(SRC, /=\s*'连接手机'/, "the LABEL hard-coding must be gone")
  assert.doesNotMatch(SRC, /setAttribute\('aria-label',\s*'关闭'\)/, 'the close button must go through the table')
  assert.doesNotMatch(SRC, /setStatus\('[^']*[\u4e00-\u9fff]/, 'setStatus only accepts keys')
  assert.doesNotMatch(
    SRC,
    /console\.(warn|error|log)\(\s*'[^']*[\u4e00-\u9fff]/,
    'log lines must be an ASCII prefix plus t(key), never embedded Chinese'
  )
})

test('the client half stays a classic script: no ESM form, loader registration intact', () => {
  assert.doesNotMatch(SRC, /^export /m, 'no ESM export statement')
  assert.doesNotMatch(SRC, /^import /m, 'no ESM import statement')
  assert.match(SRC, /window\.__ModuleLoader__\.load\(\{/, 'registration goes through the host loader')
  assert.match(SRC, /id: '@defws\/dsh-pocket'/, 'registered by package name')
})

test('the zh and en packs expose the same seven keys, with one shared product-name literal', () => {
  assert.ok(I18N, 'the I18N table must be readable from the source')
  const zhKeys = Object.keys(I18N.zh).sort()
  const enKeys = Object.keys(I18N.en).sort()
  assert.deepEqual(enKeys, zhKeys, 'zh/en key sets must be equal')
  assert.deepEqual(zhKeys, [...KEYS].sort(), 'the table holds exactly the seven AC-CLI keys')
  // The desktop entry is the product name: one lowercase literal, deliberately
  // identical in both packs, so it is the only key allowed to read the same.
  assert.equal(I18N.zh.label, 'pocket', 'the desktop entry is named pocket in zh')
  assert.equal(I18N.en.label, 'pocket', 'and the very same literal in en')
  for (const k of zhKeys) {
    assert.equal(typeof I18N.zh[k], 'string', k + ' must be a string in zh')
    assert.equal(typeof I18N.en[k], 'string', k + ' must be a string in en')
    assert.ok(I18N.zh[k].length > 0 && I18N.en[k].length > 0, k + ' must not be empty')
    if (k !== 'label') {
      assert.notEqual(I18N.en[k], I18N.zh[k], k + ' must read differently in each pack')
    }
    assert.ok(!CJK.test(I18N.en[k]), k + ' must stay CJK-free in the en pack')
  }
})

test('degraded paths log through the table and mount no UI', () => {
  const withoutReact = makeSandbox('zh-CN')
  const brokenApi = withoutReact.def.factory(() => {
    throw new Error('react is not available')
  })
  assert.deepEqual(Array.from(brokenApi.inject), [], 'without react the client injects nothing')
  assert.equal(typeof brokenApi.apply({}), 'function', 'apply still hands back a no-op disposer')
  assert.equal(withoutReact.logs.error.length, 1, 'the react failure is reported once')
  assert.ok(withoutReact.logs.error[0].startsWith('[dsh-pocket] '), 'the log keeps its ASCII prefix')
  assert.equal(
    withoutReact.logs.error[0],
    '[dsh-pocket] ' + I18N.zh.reactUnavailable,
    'the diagnostic text is the table value for the resolved locale, not a literal at the call site'
  )

  const noSlots = makeSandbox('en-US')
  const api = noSlots.def.factory(reactStub)
  assert.equal(typeof api.apply({}), 'function', 'a missing slots service still returns a disposer')
  assert.equal(noSlots.logs.warn.length, 1, 'the slots failure is warned once')
  assert.ok(noSlots.logs.warn[0].startsWith('[dsh-pocket] '))
  assert.equal(noSlots.logs.warn[0], '[dsh-pocket] ' + I18N.en.slotsUnavailable, 'the warning is the table value')
})
