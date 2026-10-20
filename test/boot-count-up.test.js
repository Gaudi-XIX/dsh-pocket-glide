// The boot ladder's counts now climb 0→N instead of popping in whole (user
// 2026-10-20: "先显示数字，一个数字过一个数字，哒哒哒的效果"). This drives the
// function the phone actually ships — pulled out of sharedStageScript() and run
// against a stub DOM — rather than re-asserting a string, because the whole point
// is the frame-by-frame behaviour: it must advance, must land exactly on the final
// value, must never hold a stage (it is fire-and-forget), and must honour
// prefers-reduced-motion by writing the final value at once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderMobileReconnectPage, renderPairingPinPage } from '../lib/pages.js'

const source = readFileSync(new URL('../lib/pages.js', import.meta.url), 'utf8')
const blockStart = source.indexOf('function sharedStageScript()')
const block = source.slice(blockStart, source.indexOf('export function renderMobileReconnectPage('))

// The three organ lines, verbatim from the shipped block.
const grab = (start, end) => {
  const from = block.indexOf(start)
  assert.ok(from >= 0, `missing anchor: ${start}`)
  const to = block.indexOf(end, from)
  assert.ok(to > from, `missing end anchor: ${end}`)
  return block.slice(from, to)
}
const ORGANS =
  grab('const COUNT_UP_MS=', 'function stepCountEl') +
  grab('function stepCountEl(', 'function setCount(') +
  grab('function setCount(', 'const CRAWL_MS=') +
  grab('const CRAWL_MS=', '\nconst rpc=')

// Build a bootSteps host with `rows` rows, each carrying one .boot-step-count span.
function makeWorld({ reduced = false } = {}) {
  const rows = Array.from({ length: 5 }, () => {
    const el = { textContent: '' }
    return { el, querySelector: (sel) => (sel === '.boot-step-count' ? el : null) }
  })
  const host = { children: rows }
  const document = { getElementById: (id) => (id === 'bootSteps' ? host : null) }
  const matchMedia = (q) => ({ matches: reduced && /reduce/.test(q) })
  let queue = []
  const requestAnimationFrame = (cb) => {
    queue.push(cb)
    return queue.length
  }
  // A clock we control: each drain step advances by 90ms so the 450ms ladder is
  // walked in a handful of frames instead of real time.
  let now = 0
  const DateShim = { now: () => now }
  const run = new Function('document', 'matchMedia', 'requestAnimationFrame', 'Date', `${ORGANS};return {countUp,countCrawl,setCount,stepCountEl}`)
  const api = run(document, matchMedia, requestAnimationFrame, DateShim)
  const pump = (frames = 40) => {
    for (let i = 0; i < frames && queue.length; i += 1) {
      now += 90
      const batch = queue
      queue = []
      for (const cb of batch) cb()
    }
  }
  return { api, rows, pump, text: (i) => rows[i].el.textContent }
}

const zhFmt = (v) => `${v} 个工作区`

test('a count climbs frame by frame and lands exactly on the final value', () => {
  const { api, pump, text } = makeWorld()
  api.countUp(api.stepCountEl(0), 7, zhFmt)
  // It has started moving but is not there yet on an early frame.
  pump(2)
  const mid = Number.parseInt(text(0), 10)
  assert.ok(mid > 0 && mid < 7, `mid-flight value should be between 0 and 7, saw "${text(0)}"`)
  // Run to the end of the ladder.
  pump(40)
  assert.equal(text(0), '7 个工作区', 'the last frame writes the exact final string')
})

test('reduced motion writes the final value at once, no animation', () => {
  const { api, pump, text } = makeWorld({ reduced: true })
  api.countUp(api.stepCountEl(1), 12, (v) => `${v} 个会话`)
  assert.equal(text(1), '12 个会话', 'final value lands before any frame runs')
  pump(5)
  assert.equal(text(1), '12 个会话', 'and does not change afterwards')
})

test('a measured zero is written directly (it is a real reading, not a missing field)', () => {
  const { api, pump, text } = makeWorld()
  api.countUp(api.stepCountEl(2), 0, zhFmt)
  assert.equal(text(2), '0 个工作区')
  pump(5)
  assert.equal(text(2), '0 个工作区')
})

test('countUp never throws when the row is gone (page already navigated away)', () => {
  const { api } = makeWorld()
  assert.doesNotThrow(() => api.countUp(null, 5, zhFmt))
  // Index past the ladder rows resolves to no element and is a silent no-op.
  assert.doesNotThrow(() => api.countUp(api.stepCountEl(99), 5, zhFmt))
})

test('setCount still writes a literal (the text labels: 已连接 / 就绪)', () => {
  const { api, pump, text } = makeWorld()
  api.setCount(4, '就绪')
  assert.equal(text(4), '就绪')
  pump(5)
  assert.equal(text(4), '就绪', 'a literal is not animated')
})

test('both bootstrap pages carry the climbing organs exactly once', () => {
  const count = (s, needle) => s.split(needle).length - 1
  for (const [name, html] of [
    ['reconnect', renderMobileReconnectPage('zh', 'lan', {})],
    ['pairing', renderPairingPinPage('zh', null, {})],
  ]) {
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
    assert.equal(count(scripts, 'function countUp('), 1, `${name}: one countUp definition`)
    assert.equal(count(scripts, 'function stepCountEl('), 1, `${name}: one stepCountEl definition`)
    assert.ok(count(scripts, 'countUp(stepCountEl(') >= 2, `${name}: at least the ws + session counts climb`)
  }
})

test('countCrawl moves the row while the request is still out', () => {
  const { api, pump, text } = makeWorld()
  api.countCrawl(0, zhFmt)
  assert.equal(text(0), '', 'the first tick is queued, not written eagerly')

  pump(1)
  assert.match(text(0), /\d+ 个工作区/, 'the row is already moving before any answer')

  const first = Number.parseInt(text(0), 10)
  pump(3)
  const later = Number.parseInt(text(0), 10)
  assert.ok(later > first, `one tick per crawl frame: ${first} -> ${later}`)
})

test('countUp supersedes the crawl and the landing value is never overwritten', () => {
  const { api, pump, text } = makeWorld()
  api.countCrawl(0, zhFmt)
  pump(3)
  api.countUp(api.stepCountEl(0), 7, zhFmt)
  pump(40)
  assert.equal(text(0), '7 个工作区', 'the crawl stops once the real count lands')
})

test('the crawl respects prefers-reduced-motion by never starting', () => {
  const { api, pump, text } = makeWorld({ reduced: true })
  api.countCrawl(0, zhFmt)
  pump(3)
  assert.equal(text(0), '', 'no odometer for a reader who asked for less motion')
})

test('the ladder rows start blank, so no number is shown before it is measured', () => {
  // The rows are built at runtime by labels.map(...), so "blank at first" lives in
  // that template string, not in the static document. The count span is emitted
  // empty and the count is written only once an answer arrives.
  const html = renderMobileReconnectPage('zh', 'lan', {})
  const rowTemplate = html.match(/'<div class="boot-step'\+\(i===0\?' is-active':''\)\+'"><span class="boot-step-label">'[\s\S]*?<\/span><span class="boot-step-count"[^+]*><\/span>/)
  assert.ok(rowTemplate, 'the runtime row template is present')
  assert.match(rowTemplate[0], /class="boot-step-count"[^>]*><\/span>/, 'the count span is emitted empty — nothing pre-filled')
})
