// P1-5 (2026-11-04): a bot-to-bot relay frame is a head, not a message. Every
// user/message frame used to force a full transcript repaint (and inside a chat
// that repaint is what made the phone stutter), even though the frame only ever
// appends one divider row at the tail. The tail patcher now accepts a trailing
// event row as well as the streaming assistant bubble; anything that does not
// line up still falls back to the full repaint.
import test from 'node:test'
import assert from 'node:assert/strict'

import { mobilePageAssets } from '../lib/pages.js'

const { js } = mobilePageAssets({ locale: 'zh' })

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, `function ${name} must exist in the page source`)
  let i = source.indexOf('{', start)
  let depth = 0
  for (; i < source.length; i++) {
    const c = source[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return source.slice(start, i + 1) }
  }
  assert.fail(`function ${name} is never closed`)
}

function buildPatcher({ nodes = 1 } = {}) {
  const box = {
    children: [],
    scrollTop: 0,
    scrollHeight: 100,
    insertAdjacentHTML(_where, html) { box.children.push(html) },
  }
  const rows = []
  for (let i = 0; i < nodes; i++) { const node = { outerHTML: '' }; rows.push(node); box.children.push(node) }
  box.querySelectorAll = () => rows
  const state = { painted: 0, patched: 0, bound: 0, synced: 0, scrolled: 0 }
  const make = new Function(
    'box', 'state',
    `
    const $=(id)=>id==='messages'?box:null
    let followStream=true
    let transcriptAnchor=null
    const paintMessages=()=>{state.painted++}
    const renderMessage=(m)=>'<div class="message '+m.role+'">'+m.key+'</div>'
    const bindOpenState=()=>{state.bound++}
    const syncTurnStatus=()=>{state.synced++}
    const isNearBottom=()=>true
    const programmaticScroll=()=>{state.scrolled++}
    const syncScrollAnchors=()=>{}
    ${extractFunction(js, 'patchLastStreamMessage')}
    return { patchLastStreamMessage }
  `,
  )
  const page = make(box, state)
  page.box = box
  page.state = state
  page.patch = (messages) => { state.patched++; return page.patchLastStreamMessage(messages) }
  return page
}

test('B10 a relay frame no longer forces a full repaint', () => {
  const hit = js.match(/const FULL_PAINT_STREAM_EVENTS=new Set\(\[([^\]]*)\]\)/)
  assert.ok(hit, 'the full-paint set must be a literal list')
  const events = hit[1]
  assert.match(events, /'turn\/end'/, 'turn boundaries still repaint')
  assert.match(events, /'turn\/start'/)
  assert.doesNotMatch(events, /'user\/message'/, 'a relay row patches the tail instead')
})

test('B11 a trailing event row is appended, never repainted', () => {
  const page = buildPatcher({ nodes: 1 })
  const messages = [
    { role: 'assistant', key: 'bubble' },
    { role: 'event', key: 'divider', blocks: [{ kind: 'divider', text: 'Pixel' }] },
  ]
  page.patch(messages)
  assert.equal(page.state.painted, 0, 'no full repaint for one appended row')
  assert.equal(page.box.children.length, 2, 'the row is appended to the transcript')
  assert.match(String(page.box.children[1]), /class="message event"/, 'and it is the divider row that was appended')
})

test('B11 a streaming assistant frame still replaces in place', () => {
  const page = buildPatcher({ nodes: 2 })
  page.patch([{ role: 'assistant', key: 'a' }, { role: 'assistant', key: 'b' }])
  assert.equal(page.state.painted, 0, 'the tail bubble is patched')
  assert.match(page.box.children[1].outerHTML, /class="message assistant"/)
  assert.equal(page.box.children.length, 2, 'nothing was added')
})

test('B11 anything that does not line up still falls back to the full repaint', () => {
  const page = buildPatcher({ nodes: 1 })
  page.patch([{ role: 'assistant', key: 'a' }, { role: 'user', key: 'u' }])
  assert.equal(page.state.painted, 1, 'an unknown tail role rebuilds the box')
  assert.equal(page.box.children.length, 1, 'and the rebuild is the box owner\'s job, not the patcher\'s')
})
