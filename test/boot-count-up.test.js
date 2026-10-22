// The boot ladder's counts climb 0→N instead of popping in whole (user
// 2026-10-20: "先显示数字，一个数字过一个数字，哒哒哒的效果"), every number belongs to
// exactly one row, and it is handed out the moment the ladder enters that row — not
// when the row finishes (user 2026-10-21: "应该一步一步来，我只单的前端显示，后端肯定
// 是提前加载"; 2026-10-22: "有没有可能刚进入那一行，就把后面对应的数字显示出来"). This
// drives the function the phone actually ships — pulled out of sharedStageScript() and
// run against a stub DOM — rather than re-asserting a string, because the whole point
// is the frame-by-frame behaviour: it must advance, must land exactly on the final
// value, must never hold a stage (it is fire-and-forget), must honour
// prefers-reduced-motion by writing the final value at once, and must keep a parked
// number invisible until its row comes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderMobileReconnectPage, renderPairingPinPage } from '../lib/pages.js'

const source = readFileSync(new URL('../lib/pages.js', import.meta.url), 'utf8')
const blockStart = source.indexOf('function sharedStageScript()')
const block = source.slice(blockStart, source.indexOf('export function renderMobileReconnectPage('))

// The organ lines, verbatim from the shipped block. The gate lives before
// COUNT_UP_MS, so the block is grabbed in three pieces around it.
const grab = (start, end) => {
  const from = block.indexOf(start)
  assert.ok(from >= 0, `missing anchor: ${start}`)
  const to = block.indexOf(end, from)
  assert.ok(to > from, `missing end anchor: ${end}`)
  return block.slice(from, to)
}
const ORGANS =
  grab('let ladderGated=false;', 'const COUNT_UP_MS=') +
  grab('const COUNT_UP_MS=', 'function setCount(') +
  grab('function setCount(', '\nconst rpc=')

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
  const run = new Function('document', 'matchMedia', 'requestAnimationFrame', 'Date', `${ORGANS};return {countUp,paintCount,releaseCount,setCount,stepCountEl,gateLadder,countTailMessages}`)
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

test('no odometer: the shipped block carries no countCrawl anywhere', () => {
  // The in-flight odometer is gone for good (user 2026-10-21: "数字都是一样的，
  // 并且数字明显是错的"). It counted frames, not records, and three of them started
  // in the same tick, so all three rows showed the same number. Re-adding it would
  // put the same lie back on the ladder.
  assert.equal(source.includes('countCrawl'), false, 'countCrawl must not exist in lib/pages.js')
  assert.equal(source.includes('CRAWL_MS'), false, 'the crawl clock constant must be gone too')
})

test('a count measured before its row is reached is parked, not painted', () => {
  const { api, pump, text } = makeWorld()
  api.gateLadder()
  api.countUp(api.stepCountEl(1), 9, (v) => `${v} 个会话`)
  pump(40)
  assert.equal(text(1), '', 'the row stays blank until the ladder reaches it')
})

test('opening the gate hands the first row its number at once (that row is already lit)', () => {
  // Row 0 is the row the ladder shows from its first frame, so it must be readable
  // from that first frame too — "刚进入那一行，就把数字显示出来" (user 2026-10-22).
  const { api, pump, text } = makeWorld()
  api.gateLadder()
  api.countUp(api.stepCountEl(0), 2, zhFmt)
  pump(40)
  assert.equal(text(0), '2 个工作区', 'the first row is open, so its number is not held back')
})

test('releaseCount hands the parked number over, and the ladder order is kept', () => {
  const { api, pump, text } = makeWorld()
  api.gateLadder()
  api.countUp(api.stepCountEl(0), 2, zhFmt)
  api.countUp(api.stepCountEl(1), 30, (v) => `${v} 个会话`)
  api.countUp(api.stepCountEl(2), 10, (v) => `${v} 条消息`)
  pump(40)
  assert.deepEqual([text(1), text(2)], ['', ''], 'nothing is shown before its row')
  assert.equal(text(0), '2 个工作区', 'the row the ladder is on shows its own number')
  api.releaseCount(1)
  pump(40)
  assert.equal(text(1), '30 个会话')
  assert.equal(text(2), '', 'three numbers can never be identical because they land one at a time')
})

test('releaseCount on a row whose answer has not come back just opens it', () => {
  const { api, pump, text } = makeWorld()
  api.gateLadder()
  api.releaseCount(3)
  pump(5)
  assert.equal(text(3), '', 'an opened row with no reading stays blank — blank is honest')
  // A reading that arrives after its row was already opened paints immediately.
  api.countUp(api.stepCountEl(3), 4, (v) => `${v} 条消息`)
  pump(40)
  assert.equal(text(3), '4 条消息')
})

test('the gate is off by default, so the app-shell path is unchanged', () => {
  const { api, pump, text } = makeWorld()
  api.countUp(api.stepCountEl(0), 3, zhFmt)
  pump(40)
  assert.equal(text(0), '3 个工作区', 'without gateLadder() the count paints at once')
})

test('both bootstrap pages gate the ladder and hand each row its number as it opens', () => {
  const count = (s, needle) => s.split(needle).length - 1
  for (const [name, html] of [
    ['reconnect', renderMobileReconnectPage('zh', 'lan', {})],
    ['pairing', renderPairingPinPage('zh', null, {})],
  ]) {
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
    assert.equal(count(scripts, 'gateLadder();'), 1, `${name}: the gate is opened once, before the reads go out`)
    assert.equal(count(scripts, 'const openRow=(n)=>{setStep(n);releaseCount(n)};'), 1, `${name}: entering a row is what opens it`)
    assert.equal(count(scripts, 'const stage=stageRunner(openRow);'), 1, `${name}: the runner drives rows through openRow`)
    assert.ok(count(scripts, 'await stage(') >= 3, `${name}: every row is walked one after another`)
    assert.equal(count(scripts, 'countCrawl('), 0, `${name}: no in-flight odometer`)
  }
})

test('the conversation row counts messages, not preloaded packs', () => {
  // "10 组消息" was the number of session tail packs in the boot payload; a reader
  // takes it as "ten messages" (user 2026-10-22: "不应该写 10 组消息，而是看能不能
  // 真实地把消息的条数写出来"). The row now counts the actual message records, by
  // the same rule the transcript itself uses — a turn's tool calls and its boundary
  // records are not messages.
  const { api } = makeWorld()
  const tails = {
    a: { events: [{ type: 'user/message' }, { type: 'assistant/message' }, { type: 'tool/call' }] },
    b: { events: [{ type: 'assistant/message' }, { type: 'turn/end' }, { type: 'assistant/chunk' }] },
    // Failed packs carry no conversation at all and must not be counted as one.
    c: { error: 'timeout' },
  }
  assert.equal(api.countTailMessages(tails), 3)
  assert.equal(api.countTailMessages({}), 0)
  assert.equal(api.countTailMessages(null), 0)
  assert.equal(api.countTailMessages({ a: { events: [] } }), 0)
  // The shipped pages use this exact helper for that row, and no longer count packs.
  for (const [name, html] of [
    ['reconnect', renderMobileReconnectPage('zh', 'lan', {})],
    ['pairing', renderPairingPinPage('zh', null, {})],
  ]) {
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
    assert.ok(scripts.includes('countTailMessages(parsed.tails)'), `${name}: the conversation row counts messages`)
    assert.equal(scripts.includes("' 组消息'"), false, `${name}: the pack wording is gone`)
    assert.ok(scripts.includes("' 条消息'"), `${name}: the row says how many messages`)
  }
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
