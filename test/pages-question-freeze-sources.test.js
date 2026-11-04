// Task 3 (2026-11-03 pocket-question-and-bot-rooms-parity) / T3: the third defect is
// "the question page keeps jumping". Nothing here decides WHICH mechanism did it — that
// needs a device reading. What this file pins is the two things apply can prove:
//   ① every compensation write happens inside the existing silent window, so the page's
//      own write cannot re-arm `followStream` behind the reader's back;
//   ② the probe now says whether a scroll was the reader's (`isTrusted`) and whether the
//      silent window was still open, so the device reading can be judged at all.
// AC3.5 is the honest half: no assertion here claims the repaint mechanism is known.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMobilePage } from '../lib/pages.js'

const html = renderMobilePage({ locale: 'zh' })
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

const slice = (start, end) => {
  const from = script.indexOf(start)
  assert.ok(from >= 0, `missing anchor in the shipped page: ${start}`)
  const to = script.indexOf(end, from)
  assert.ok(to > from, `missing end anchor in the shipped page: ${end}`)
  return script.slice(from, to)
}

test('AC3.1: the three compensation writes are the only ones, and each arms the window', () => {
  assert.equal(script.split('.scrollTop=').length - 1, 12, 'the shipped page still writes scrollTop from twelve places (this batch adds none)')
  const bodies = [
    slice('function paintEarlierFeed(', '\n  async function fetchOlderPage('),
    slice('async function fetchOlderPage(', '\n  async function loadOlder('),
    slice('async function loadOlder(', '\n  // The landing row is usually'),
  ]
  for (const body of bodies) {
    // paintEarlierFeed clamps with Math.max(0,…); fetchOlderPage/loadOlder write the raw
    // delta. Both are the same compensation, so the assertion is about the pair, not the form.
    const write = body.indexOf('box.scrollTop=prevTop')
    assert.ok(write >= 0, 'the compensation write is untouched')
    const arm = body.indexOf('programmaticScroll()', write)
    assert.ok(arm > write, 'the silent window is armed right after the compensating write')
  }
})

/** The probe, driven by a hand-cranked clock: one sample per call, parsed back. */
function prober({ trusted, reArmAt }) {
  const MARK = slice('function probeMark(tag){', '\n')
  // eslint-disable-next-line no-new-func
  const build = new Function(
    '$', 'window', 'performance', 'Date', 'innerHeight', 'PROBE_ON', 'PROBE_MAX', 'PROBE_FLUSH_MS', 'probeSend',
    'PROBE_JUMP_PX', 'PROBE_JUMP_GAP_MS',
    `var probeBuf=[],hv=null,probeLastTop=null,probeLastAt=0,probeDropped=0;
     var followReArmAllowedAt=${reArmAt};
     ${MARK}
     return { probeMark, get buf(){return probeBuf}, get dropped(){return probeDropped} }`,
  )
  const now = 1_000_000
  const api = build(
    () => ({ scrollTop: 42, scrollHeight: 2077, clientHeight: 735, __readerScroll: trusted }),
    { visualViewport: { height: 700, offsetTop: 0 } },
    { now: () => 14_656 },
    { now: () => now },
    700,
    true,
    120,
    900,
    () => {},
    200,
    250,
  )
  api.probeMark('sc')
  return { buf: api.buf, dropped: api.dropped, now }
}

test('AC3.2: a sample still parses, with the reader flag and the window state at the end', () => {
  const sample = (opts) => prober(opts).buf.find((line) => line.startsWith('sc@'))
  const reader = sample({ trusted: true, reArmAt: 1_000_000 })
  const page = sample({ trusted: false, reArmAt: 1_000_000 })
  const unknown = sample({ trusted: undefined, reArmAt: 1_000_000 })
  const inside = sample({ trusted: true, reArmAt: 1_000_500 })

  for (const line of [reader, page, unknown, inside]) {
    assert.match(line, /^sc@\d+\|\d+\|\d+\|\d+\|\d+\|\d+\|-?\d+\|[01-]\|[01]$/, 'seven geometry values, then reader and window')
    assert.equal(line.split('|').length, 9, 'the sample keeps one field per separator')
  }
  assert.match(reader, /\|1\|0$/, 'a trusted scroll after the window closed')
  assert.match(page, /\|0\|0$/, 'a programmatic scroll')
  assert.match(unknown, /\|-\|0$/, 'no scroll seen yet is not "the reader did it"')
  assert.match(inside, /\|1\|1$/, 'and the window reads open while the compensation write is still fresh')
  const geometry = reader.split('|').slice(1, 7).join('|')
  assert.equal(geometry, '42|2077|735|700|700|0', 'the old fields keep their order and meaning')
})

/**
 * The scroll listener, lifted whole: a reader scroll re-arms `followStream`, a scroll that
 * lands inside the silent window does not. `programmaticScroll` is the real one.
 */
function scroller({ nearBottom = false } = {}) {
  let now = 1_000_000
  const timers = []
  const box = {
    scrollTop: 0,
    scrollHeight: 2077,
    clientHeight: 735,
    addEventListener(type, handler, options) {
      assert.equal(type, 'scroll')
      assert.deepEqual(options, { passive: true })
      this.handler = handler
    },
  }
  const programmatic = slice('function programmaticScroll(){', '\n')
  // eslint-disable-next-line no-new-func
  const build = new Function(
    '$', 'Date', 'setTimeout', 'requestAnimationFrame', 'isNearBottom', 'canRearmFollow', 'readTranscriptAnchor', 'syncScrollAnchors', 'topEdgePull',
    `let followStream=true,followReArmAllowedAt=0,followReArmTimer=null,transcriptAnchor=null,pendingFollowFrame=false,fx=false;
     ${programmatic}
     ${slice("(()=>{const box=$('messages');if(!box)return;box.addEventListener('scroll'", ',{passive:true})})();')},{passive:true})})();
     return {
       get followStream(){return followStream},
       get pendingFollowFrame(){return pendingFollowFrame},
       programmaticScroll,
     }`,
  )
  const api = build(
    () => box,
    { now: () => now },
    (fn, ms) => { timers.push(ms); return timers.length },
    (fn) => { fn(); return 1 },
    () => nearBottom,
    () => nearBottom,
    () => 'anchor',
    () => {},
    () => {},
  )
  return {
    api, box, timers,
    advance(ms) { now += ms },
    /** A scroll event as the browser would deliver it. */
    reader(to, trusted = true) { box.scrollTop = to; box.handler({ isTrusted: trusted }) },
  }
}

test('AC3.3: a reader scroll off the bottom drops followStream, and the page cannot grab it back', () => {
  const s = scroller({ nearBottom: false })
  s.reader(100, true)
  assert.equal(s.api.followStream, false, 'the reader moved away, so the page stops following')

  // Now the page itself writes a scroll (a paint with sticky on) inside the two-frame gap.
  s.api.programmaticScroll()
  assert.deepEqual(s.timers, [280], 'the 280ms self-re-arm re-check is still scheduled once')
  s.advance(100)
  s.reader(s.box.scrollHeight - s.box.clientHeight, false)
  assert.equal(s.api.followStream, false, 'a page write inside the silent window never re-arms follow')
  assert.equal(s.api.pendingFollowFrame, true, 'it defers to the window instead')

  // And the same operation twice must not flip it back either.
  s.api.programmaticScroll()
  s.advance(50)
  s.reader(s.box.scrollHeight - s.box.clientHeight, false)
  assert.equal(s.api.followStream, false)
})

test('AC3.4: the window really is open right after a compensation write, and closed after it', () => {
  const s = scroller({ nearBottom: true })
  s.api.programmaticScroll()
  s.advance(249)
  s.reader(0, false)
  assert.equal(s.api.pendingFollowFrame, true, 'inside 250ms the listener defers instead of re-judging')
  s.advance(2)
  s.reader(0, true)
  assert.equal(s.api.pendingFollowFrame, false, 'past the window the listener judges again')
})

test('AC3.5: no assertion here claims the repaint mechanism is known', () => {
  // Deliberately absent: "jk must be 0", "no full repaint", "the page never scrolls itself".
  // Those cannot be told apart from a reader scroll until a device reading carries the flag.
  assert.ok(script.includes('__readerScroll'), 'the criterion is in the shipped page')
  assert.ok(script.includes("b.__readerScroll===undefined?'-':b.__readerScroll?1:0"), 'and it reports three states, not two')
})
