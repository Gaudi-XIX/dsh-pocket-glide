// Page-side tail prefetch (card 2026-10-14-feature-pocket-手机八问收敛 T5).
//
// session.tails ships raw compacted records. What must stay true on this leg:
//   1. only user/message and assistant/message count, and a user record needs
//      source.kind === 'user' (the same test visibleMessages applies);
//   2. the LAST text record wins, tool rows and empty blocks are skipped;
//   3. over-long lines are clipped with an ellipsis, whitespace flattened;
//   4. the time handed to the row clock is the last text record's own stamp,
//      0 when absent — sortAtOf must not invent a timestamp;
//   5. the fetch is judged on updatedAt: unchanged rows are never pulled, a RUNNING
//      row is pulled too (the pack is there for the tap that opens it — 2026-10-19),
//      and one batch is in flight per id at most.
//   6. 2026-10-14 (m02164①): this is a PREFETCH ONLY — the landing row paints
//      title/clock/state and no message text. The first version rendered the
//      tail into the row and the user rejected it outright:「我要你做的是，在
//      登录的时候，把时间限制以内的会话，每个会话的对话消息提前加载几条，
//      而不是让你显示到主页上」. So the batch must never re-render the landing
//      (the rows would rebuild under the reader's thumb) and the row markup must
//      stay free of the tail line.
//   7. 2026-10-15 (m01005①②): the batch is a PACK, not a one-liner. The bridge
//      already returns up to TAIL_PAGE_MESSAGES full records per session; the old
//      code threw them away at tailCache.set and kept {text,time}, so opening a
//      session still paid a full round trip (「为什么点进会话不是秒开」). Now the
//      records are kept, bounded to TAIL_PACK_MAX newest-by-seq, the pack cache is
//      bounded to TAIL_CACHE_MAX sessions, and paintInstantSession paints from the
//      pack when sessionCache missed — 「不能空白、不能等加载」.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const assets = { zh: mobilePageAssets({ locale: 'zh' }) }

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

const limitOf = () => {
  const m = assets.zh.js.match(/const TAIL_TEXT_LIMIT=(\d+);/)
  assert.ok(m, 'TAIL_TEXT_LIMIT must be a plain number in the asset')
  return Number(m[1])
}

const packMaxOf = () => {
  const m = assets.zh.js.match(/const TAIL_PACK_MAX=(\d+);/)
  assert.ok(m, 'TAIL_PACK_MAX must be a plain number in the asset')
  return Number(m[1])
}

const cacheMaxOf = () => {
  const m = assets.zh.js.match(/const TAIL_CACHE_MAX=(\d+);/)
  assert.ok(m, 'the pack cache must be bounded — it holds full records now, not one-liners')
  return Number(m[1])
}

const retryMaxOf = () => {
  const m = assets.zh.js.match(/const TAIL_RETRY_MAX=(\d+);/)
  assert.ok(m, 'TAIL_RETRY_MAX must be a plain number in the asset')
  return Number(m[1])
}

const batchMaxOf = () => {
  const m = assets.zh.js.match(/const TAIL_BATCH_MAX=(\d+);/)
  assert.ok(m, 'TAIL_BATCH_MAX must be a plain number in the asset')
  return Number(m[1])
}

const roundsMaxOf = () => {
  const m = assets.zh.js.match(/const TAIL_ROUNDS_MAX=(\d+);/)
  assert.ok(m, 'TAIL_ROUNDS_MAX must be a plain number in the asset')
  return Number(m[1])
}

const requeueMaxOf = () => {
  const m = assets.zh.js.match(/const TAIL_REQUEUE_MAX=(\d+);/)
  assert.ok(m, 'TAIL_REQUEUE_MAX must be a plain number in the asset')
  return Number(m[1])
}

const tailSandbox = () => {
  const js = assets.zh.js
  const body = [
    extractFunction(js, 'contentBlocks'),
    extractFunction(js, 'extractTail'),
    extractFunction(js, 'tailTextOf'),
  ].join('\n')
  return new Function(`
    const TAIL_TEXT_LIMIT=${limitOf()}
    const tailCache=new Map()
    ${body}
    return { extractTail, tailTextOf, tailCache }
  `)()
}

// Records arrive in the two shapes the transcript leg already accepts: wrapped
// ({seq, event:{type,time,data}} — what session/page ships, see
// test/pages-image-file.test.js:278) or flat ({type,time,data}).
const userRec = (text, time) => ({
  seq: 1,
  event: { type: 'user/message', time, data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } }
})

const assistantRec = (blocks, time) => ({
  seq: 2,
  event: { type: 'assistant/message', time, data: { message: { content: blocks } } }
})

test('the last text record is the tail, tool noise and empty blocks are skipped', () => {
  const { extractTail } = tailSandbox()
  const hit = extractTail([
    userRec('first question', 1000),
    { seq: 3, event: { type: 'tool/call', time: 1500, data: {} } },
    assistantRec([{ type: 'reasoning', text: 'thinking' }], 2000),
    assistantRec([{ type: 'tool-call', id: 'x', name: 'read' }], 2500),
    assistantRec([{ type: 'text', text: '  answer   with   spaces  ' }], 3000)
  ])
  assert.equal(hit.text, 'answer with spaces', 'whitespace flattened')
  assert.equal(hit.time, 3000, 'the clock is the tail record own stamp')
})

test('a user record only counts when the source says user', () => {
  const { extractTail } = tailSandbox()
  const fake = { seq: 1, event: { type: 'user/message', time: 9, data: { message: { source: { kind: 'assistant' }, content: [{ type: 'text', text: 'nope' }] } } } }
  assert.deepEqual(extractTail([fake, userRec('real', 11)]), { text: 'real', time: 11 })
  assert.deepEqual(extractTail([fake]), { text: '', time: 0 }, 'nothing left to show')
})

test('an over-long tail is clipped with an ellipsis at the shipped limit', () => {
  const { extractTail } = tailSandbox()
  const limit = limitOf()
  const hit = extractTail([userRec('x'.repeat(limit + 50), 5)])
  assert.equal(hit.text.length, limit + 1, 'the clip plus the ellipsis')
  assert.ok(hit.text.endsWith('…'))
})

test('junk in, empty out — no throw on the landing', () => {
  const { extractTail } = tailSandbox()
  for (const junk of [null, undefined, {}, 'x', [null], [{}], [{ seq: 1, event: { type: 'assistant/message', data: null } }]]) {
    assert.deepEqual(extractTail(junk), { text: '', time: 0 }, 'junk must degrade to no tail')
  }
  // a flat record whose stamp is junk still shows its text, only the clock drops
  assert.deepEqual(extractTail([{ type: 'assistant/message', time: 'soon', data: { message: { content: [{ type: 'text', text: 'hi' }] } } }]), { text: 'hi', time: 0 })
})

test('tailTextOf only speaks for a cached row with actual text', () => {
  const { tailTextOf, tailCache } = tailSandbox()
  assert.equal(tailTextOf('missing'), '')
  tailCache.set('a', { text: '', time: 5 })
  assert.equal(tailTextOf('a'), '', 'an empty tail paints no line')
  tailCache.set('b', { text: 'hello', time: 7 })
  assert.equal(tailTextOf('b'), 'hello')
})

// ------------------------------------- the pull is judged on updatedAt

const listSandbox = ({ state = {}, rpcImpl }) => {
  const js = assets.zh.js
  const body = [
    extractFunction(js, 'contentBlocks'),
    extractFunction(js, 'eventSeq'),
    extractFunction(js, 'extractTail'),
    extractFunction(js, 'tailPack'),
    extractFunction(js, 'requestVisibleTails'),
  ].join('\n')

  return new Function('rpc, taskState, noteSessionMessageAt, renderWorkspaces, fakeHost, state', `
    const TAIL_TEXT_LIMIT=${limitOf()}
    const TAIL_PACK_MAX=${packMaxOf()}
    const TAIL_CACHE_MAX=${cacheMaxOf()}
    const TAIL_RETRY_MAX=${retryMaxOf()}
    const TAIL_BATCH_MAX=${batchMaxOf()}
    const TAIL_ROUNDS_MAX=${roundsMaxOf()}
    const TAIL_REQUEUE_MAX=${requeueMaxOf()}
    const tailCache=new Map(),tailArmedAt={},tailPending=new Set(),tailFailed={}
    let activeSession=${JSON.stringify(state.activeSession ?? null)}
    const sessionSummaries=${JSON.stringify(state.rows ?? [])}
    ${body}
    return {
      requestVisibleTails: () => requestVisibleTails(fakeHost()),
      tailArmedAt, tailPending, tailCache, tailFailed, sessionSummaries
    }
  `)(rpcImpl, (s) => s.state || '', (...a) => { state.stamps = state.stamps || []; state.stamps.push(a) }, () => { state.paints = (state.paints || 0) + 1 }, () => ({
    querySelectorAll: (sel) => sel === '.task-row[data-id]' ? (state.visible || []).map((id) => ({ getAttribute: () => id })) : []
  }))
}

test('rows whose stamp did not move are never pulled, and a running row is pulled too', async () => {
  const asked = []
  const state = { rows: [{ sessionId: 'a', updatedAt: 10 }, { sessionId: 'b', updatedAt: 20, state: 'running' }, { sessionId: 'c', updatedAt: 30 }], visible: ['a', 'b', 'c', 'ghost'] }
  const box = listSandbox({ state, rpcImpl: async (method, payload) => { asked.push(payload.sessions.slice()); return { tails: {} } } })
  box.tailArmedAt.a = 10 // already fetched at this exact stamp
  await box.requestVisibleTails()
  assert.deepEqual(asked[0], ['b', 'c'], 'unchanged row and a row with no summary are skipped; a running row is pulled too')
})

test('an active transcript stops the prefetch, and a batch is in flight once per id', async () => {
  const asked = []
  const state = { activeSession: 's1', rows: [{ sessionId: 'a', updatedAt: 1 }], visible: ['a'] }
  const box = listSandbox({ state, rpcImpl: async (method, payload) => { asked.push(payload.sessions.slice()); return { tails: {} } } })
  await box.requestVisibleTails()
  assert.equal(asked.length, 0, 'inside a session the landing is not on screen')

  const state2 = { rows: [{ sessionId: 'a', updatedAt: 5 }], visible: ['a'] }
  let release
  const gate = new Promise((r) => { release = r })
  const box2 = listSandbox({ state: state2, rpcImpl: async () => { await gate; return { tails: { a: { updatedAt: 5, events: [userRec('late', 9)] } } } } })
  const first = box2.requestVisibleTails()
  assert.ok(box2.tailPending.has('a'), 'the id is claimed before the response')
  await box2.requestVisibleTails()
  assert.equal(box2.tailPending.size, 1, 'a second render while in flight does not double-ask')
  release()
  await first
  assert.equal(box2.tailCache.get('a').text, 'late', 'the answer landed in the cache')
  assert.equal(box2.tailArmedAt.a, 5, 'armed at the stamp the batch was judged on')
  assert.deepEqual(state2.stamps[0], ['a', 9], 'the row clock got the tail time')
  assert.equal(box2.tailPending.size, 0, 'the claim is released either way')
})

test('a failed batch releases the claim so the next render can retry', async () => {
  const state = { rows: [{ sessionId: 'a', updatedAt: 1 }], visible: ['a'] }
  let calls = 0
  const box = listSandbox({ state, rpcImpl: async () => { calls += 1; if (calls === 1) throw new Error('tunnel down'); return { tails: {} } } })
  await box.requestVisibleTails()
  assert.equal(box.tailPending.size, 0, 'nothing stays claimed after a failure')
  assert.equal(box.tailArmedAt.a, undefined, 'a failure does not arm the stamp — it is not an answer')
  await box.requestVisibleTails()
  assert.equal(calls, 2, 'the next render asks again')
})

test('per-row markers do not poison the cache or the clock', async () => {
  const state = { rows: [{ sessionId: 'a', updatedAt: 1 }, { sessionId: 'b', updatedAt: 2 }], visible: ['a', 'b'] }
  const box = listSandbox({ state, rpcImpl: async () => ({ tails: { a: { error: 'page-failed' }, b: { updatedAt: 2, events: [] } } }) })
  await box.requestVisibleTails()
  assert.equal(box.tailCache.has('a'), false, 'a marker is not a tail')
  assert.equal(box.tailCache.get('b').text, '', 'an empty page caches an empty tail')
  assert.equal(state.stamps, undefined, 'no time means nothing fed the ledger')
  // 2026-10-16 反向：旧锁写的是 tailArmedAt.a===1（「仍然盖戳，所以主页不会反复敲」），
  // 那把「一次失败＝永久不再预载」钉成了契约——用户报的「有些对话点进去完全没有消息」
  // 正是它。失败的会话必须还能再试，所以这里改成：不盖戳，且失败计入 tailFailed。
  assert.equal(box.tailArmedAt.a, undefined, 'a marker is not an answer — it must not arm the row')
  assert.equal(box.tailFailed.a.count, 1, 'the failure is counted so the retry can be bounded')
})

// The flip side of "retry after failure": a session whose tail can NEVER be
// fetched (the bridge reports no-cursor/unknown for a row the Host cannot page)
// must not be re-asked on every landing render — startListPoll repaints the
// landing every 60s, so unbounded retry is a permanent host-page treadmill.
test('a permanently failing row is retried, then left alone until its stamp moves', async () => {
  const state = { rows: [{ sessionId: 'a', updatedAt: 7 }], visible: ['a'] }
  let calls = 0
  const box = listSandbox({ state, rpcImpl: async () => { calls += 1; return { tails: { a: { error: 'no-cursor' } } } } })
  const cap = retryMaxOf()
  for (let i = 0; i < cap; i++) await box.requestVisibleTails()
  assert.equal(calls, cap, 'the row is retried up to the cap')
  await box.requestVisibleTails()
  assert.equal(calls, cap, 'past the cap the landing stops asking — no treadmill')
  // A new turn on that session moves updatedAt, which is worth one more try.
  box.sessionSummaries[0].updatedAt = 8
  await box.requestVisibleTails()
  assert.equal(calls, cap + 1, 'a moved stamp resets the budget and asks again')
})

// 2026-10-21 用户 m02339 定范围：「所有拉取的会话消息，都停留在这个主页上显示的会话，
// 也就是 24 小时之内更新的，再加置顶的」。rangeOf 把 renderWorkspaces 里算 cap 的那几句
// 抽出来——它自带 24h 窗口（RECENT_WINDOW_MS）与置顶穿透，补拉沿用同一份口径就不会外溢。
const rangeOf = () => {
  const js = assets.zh.js
  const cap = extractFunction(js, 'bootRangeCap')
  return new Function(`const RECENT_WINDOW_MS=${Number(js.match(/const RECENT_WINDOW_MS=(\d+)/)[1])};
    function sortAtOf(s){return Number((s&&s.updatedAt)||0)}
    ${cap}
    return bootRangeCap`)()
}

test('the landing补拉 range is the 24h window plus pinned rows, never the whole list', () => {
  const cap = rangeOf()
  const now = 1_000_000_000_000
  const H = 60 * 60 * 1000
  const members = [
    { sessionId: 'new', updatedAt: now - H }, // in window
    { sessionId: 'old', updatedAt: now - 30 * H }, // out of window
    { sessionId: 'old-pinned', updatedAt: now - 90 * 24 * H }, // out of window but pinned
    { sessionId: 'edge', updatedAt: now - 24 * H + 1000 }, // just inside
  ]
  const pinned = new Set(['old-pinned'])
  assert.equal(cap(members, now, pinned), 3, 'pinned + 24h rows only — the 30-day-old unpinned row stays out')
})

test('the补拉 keeps asking in batches until the visible rows are done（进主页以后再加载）', async () => {
  const batch = batchMaxOf()
  const rounds = roundsMaxOf()
  const total = Math.min(batch * rounds, 24)
  assert.ok(total > batch, 'the fixture must need more than one batch')
  const rows = []
  const visible = []
  const tails = {}
  for (let i = 0; i < total; i++) {
    const id = 's' + i
    rows.push({ sessionId: id, updatedAt: i + 1 })
    visible.push(id)
    tails[id] = { updatedAt: i + 1, events: [rec(i + 1)] }
  }
  const asked = []
  const box = listSandbox({ state: { rows, visible }, rpcImpl: async (method, payload) => { asked.push(payload.sessions.slice()); return { tails } } })
  await box.requestVisibleTails()
  assert.ok(asked.length >= 2, `more than one batch went out (got ${asked.length})`)
  assert.equal(asked.length, Math.ceil(total / batch), 'one round covers the visible rows by chaining batches')
  for (const call of asked) assert.ok(call.length <= batch, `a batch never exceeds ${batch} sessions (bridge fans out 4 at a time under a 4500ms deadline)`)
  assert.equal(box.tailCache.size, total, 'every visible row ends up armed')
  for (const id of visible) assert.equal(box.tailArmedAt[id], rows.find((r) => r.sessionId === id).updatedAt, `${id} armed at its own stamp`)
})

test('a row the bridge could not reach in time is requeued, not written off（超时≠失败）', async () => {
  const rows = [{ sessionId: 'a', updatedAt: 1 }, { sessionId: 'b', updatedAt: 2 }]
  const visible = ['a', 'b']
  const asked = []
  let pass = 0
  const box = listSandbox({
    state: { rows, visible },
    rpcImpl: async (method, payload) => {
      asked.push(payload.sessions.slice())
      pass += 1
      // First pass: the bridge's deadline cut 'b' off. Second pass: it arrives.
      if (pass === 1) return { tails: { a: { updatedAt: 1, events: [rec(1)] }, b: { error: 'timeout' } } }
      return { tails: { b: { updatedAt: 2, events: [rec(2)] } } }
    },
  })
  await box.requestVisibleTails()
  assert.deepEqual(asked[1], ['b'], 'the timed-out row comes back in the next batch')
  assert.equal(box.tailCache.has('b'), true, 'and it lands')
  assert.equal(box.tailFailed.b, undefined, 'a deadline is not counted as a failure')
})

test('a row that keeps timing out stops requeueing, and a moved stamp lets it try again', async () => {
  const cap = requeueMaxOf()
  const rows = [{ sessionId: 'a', updatedAt: 1 }]
  const box = listSandbox({ state: { rows, visible: ['a'] }, rpcImpl: async () => ({ tails: { a: { error: 'timeout' } } }) })
  const asked = []
  box.rpcAsked = asked
  await box.requestVisibleTails()
  // One round = 1 + TAIL_REQUEUE_MAX attempts at the same row.
  assert.equal(box.tailArmedAt.a, undefined, 'never armed by a timeout')
  assert.equal(box.tailFailed.a.count, 1, 'the give-up is recorded as one failure')
  // Its stamp moving is a new question.
  box.sessionSummaries[0].updatedAt = 2
  await box.requestVisibleTails()
  assert.equal(box.tailArmedAt.a, undefined, 'still not armed, but it asked again (no treadmill, no permanent write-off)')
})

// ------------------------------------- the pack itself (m01005①)

const packSandbox = () => {
  const js = assets.zh.js
  const body = [extractFunction(js, 'eventSeq'), extractFunction(js, 'tailPack')].join('\n')
  return new Function(`
    const TAIL_PACK_MAX=${packMaxOf()}
    ${body}
    return { tailPack }
  `)()
}

// eventSeq reads the seq off the inner event (pages.js eventSeq), which is the
// shape session/page ships, so the pack fixtures use that shape, not the flat
// one the extractTail fixtures above use.
const rec = (seq) => ({ seq, event: { seq, type: 'assistant/message', time: seq, data: { message: { content: [{ type: 'text', text: 'm' + seq }] } } } })

test('the pack is bounded and keeps the newest records, ordered old to new', () => {
  const { tailPack } = packSandbox()
  const max = packMaxOf()
  const many = []
  for (let i = 1; i <= max + 5; i++) many.push(rec(i))
  const pack = tailPack(many)
  assert.equal(pack.length, max, '排到上限就不排了 — older records are dropped')
  assert.deepEqual(pack.map((entry) => entry.seq), Array.from({ length: max }, (_, k) => k + 6), 'the newest max, oldest first')
})

test('a shuffled page still yields a sorted pack, and junk never throws', () => {
  const { tailPack } = packSandbox()
  const pack = tailPack([rec(9), rec(3), rec(7)])
  assert.deepEqual(pack.map((entry) => entry.seq), [3, 7, 9], 'the bridge page arrives by seq; the pack must not invert it')
  for (const junk of [null, undefined, {}, 'x', [null]]) {
    assert.ok(Array.isArray(tailPack(junk)), 'junk degrades to an empty pack')
  }
})

test('the pack is what gets cached, so opening the session has content to paint', async () => {
  const state = { rows: [{ sessionId: 'a', updatedAt: 5 }], visible: ['a'] }
  // the user record needs source.kind==='user' for the one-liner, and a seq of
  // its own for the pack — so it is spelled out instead of reusing userRec().
  const tail = { seq: 3, event: { seq: 3, type: 'user/message', time: 9, data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'late' }] } } } }
  const box = listSandbox({
    state,
    rpcImpl: async () => ({ tails: { a: { updatedAt: 5, events: [rec(1), rec(2), tail] } } })
  })
  await box.requestVisibleTails()
  const cached = box.tailCache.get('a')
  assert.equal(cached.text, 'late', 'the one-line tail still exists for tailTextOf')
  assert.deepEqual(cached.pack.map((entry) => entry.seq), [1, 2, 3], 'and the full records stay in the pack (m01005①)')
})

test('the pack cache is bounded — full records must not pile up unbounded', async () => {
  const max = cacheMaxOf()
  const rows = []
  const visible = []
  const tails = {}
  for (let i = 0; i <= max; i++) {
    const id = 's' + i
    rows.push({ sessionId: id, updatedAt: i + 1 })
    visible.push(id)
    tails[id] = { updatedAt: i + 1, events: [rec(i + 1)] }
  }
  const box = listSandbox({ state: { rows, visible }, rpcImpl: async () => ({ tails }) })
  await box.requestVisibleTails()
  assert.ok(box.tailCache.size <= max, `the cache holds at most ${max} packs, got ${box.tailCache.size}`)
})

// ------------------------------------- the wiring stays visible in the asset

test('the batch is prefetch only: no tail line in the row, no re-render after it', () => {
  const js = assets.zh.js
  assert.doesNotMatch(js, /task-copy[^]*msg-tail[^]*tailTextOf/, 'the landing row paints no message text — prefetch only (m02164①)')
  assert.match(js, /rpc\('session\.tails',\{sessions:batch\},60000\)/, '每批尾包按 60s 自己的预算算，不吃 12s 默认档（桥 4 路并发翻 Host 页，一页 465–719ms）')
  assert.match(js, /if\(host\.innerHTML!==html\)host\.innerHTML=html;requestTailBootRound\(host\);requestVisibleTails\(host\)/, '首屏那一轮立即补、之后的接续轮次也随着每次重画（m02267 用户：「进去主页以后再加载」）')
  assert.match(js, /extracted\.pack=tailPack\(hit\.events\);tailCache\.set\(id,extracted\)/, 'the pack is cached whole, not clipped to one line (m01005①)')
  // A batch that lands must not rebuild the list: the reader is scrolling it.
  // Cut the real function out of the asset — a whole-file regex would happily
  // match renderWorkspaces() defined a thousand lines below the fetch.
  const pull = extractFunction(js, 'requestVisibleTails')
  assert.doesNotMatch(pull, /renderWorkspaces\(\)/, 'a prefetched tail never re-renders the landing')
})

// ------------------------------------- the list stays warm behind an open chat (m02327②+m02338)

// 读一个会话时，别的会话刚跑完也要被预载（用户：「在读的时候，如果其他会话已经结束了，
// 那就应该把它加载进来」）。behindChat 是这条静默档的通行证：主页档照旧被 activeSession
// 挡住（不能隔着聊天页重画列表），静默档只补首屏行的包，且正在读的那一行不敲（流是真相源）。
test('requestVisibleTails is blocked inside a chat and prefetches visible rows on landing (running included)', async () => {
  const askedChat = []
  const stateChat = {
    activeSession: 'b',
    rows: [{ sessionId: 'a', updatedAt: 10 }, { sessionId: 'b', updatedAt: 20 }, { sessionId: 'c', updatedAt: 30, state: 'running' }],
    visible: ['a', 'b', 'c'],
  }
  const boxChat = listSandbox({ state: stateChat, rpcImpl: async (method, payload) => { askedChat.push(payload.sessions.slice()); return { tails: {} } } })
  await boxChat.requestVisibleTails()
  assert.equal(askedChat.length, 0, 'the landing档 stays blocked inside a chat')

  const askedLanding = []
  const stateLanding = {
    activeSession: null,
    rows: [{ sessionId: 'a', updatedAt: 10 }, { sessionId: 'b', updatedAt: 20 }, { sessionId: 'c', updatedAt: 30, state: 'running' }],
    visible: ['a', 'b', 'c'],
  }
  const boxLanding = listSandbox({ state: stateLanding, rpcImpl: async (method, payload) => { askedLanding.push(payload.sessions.slice()); return { tails: {} } } })
  await boxLanding.requestVisibleTails()
  assert.deepEqual(askedLanding[0], ['a', 'b', 'c'], 'on landing every visible row without a stamp is prefetched, running included')
})

// 首屏判据不在这里——折叠区的行压根不进 #workspaces 的 DOM（renderWorkspaces 的 cap），
// querySelectorAll 拿不到，就永远不预载（m02327①：「只要是被首屏折叠的会话，逻辑就固定为
// 不加载，都是点进去再加载」）。沙盒的 visible 列表就是那份 DOM。
test('the landing poll and instant paint are judged on the wiring, not on memory', () => {
  const js = assets.zh.js
  const tailPaint = extractFunction(js, 'paintInstantSession')
  // 预载包画出后必须盖 at 戳（判据②「有最终答案就显示最后一条」的落地）：旧写法不盖章，
  // instantFresh 恒 false，点进去还是要付一次全量——用户报的「进去还要加载消息」。
  assert.match(tailPaint, /olderHasMore=true;paintInstantHistory\(windowEvents\(\),streamProjections\);sessionCache\.set\(activeSession,\{streamEvents,olderEvents,olderHasMore:true,olderExhausted,streamProjections,at:Date\.now\(\)\}\)/, 'a painted pack stamps freshness AND declares older records exist, so ensureTranscriptFilled can fill the screen (m02296①)')
  // 返回主页的交接 stash 也补了 at（判据：返回列表再进来同样免全量）。
  const leaving = js.slice(js.indexOf('async function showSessionList(){'), js.indexOf('function paintInstantHistory'))
  assert.match(leaving, /streamEvents,olderEvents,olderHasMore,olderExhausted,streamProjections,at:Date\.now\(\)\}\)/, 'the back-to-list handover stamps its snapshot')
  assert.match(leaving, /void resumeOnReturn\(true\);startListPoll\(\)\}/, 'back to the list refreshes quietly and arms the clock as its last statement')
  // 方案B：会话页不跑后台轮询（防宿主30s超时与断联），返回主页由 showSessionList 按需对齐
  const poll = extractFunction(js, 'startListPoll')
  assert.match(poll, /if\(document\.hidden\|\|activeSession\|\|draftWorkspaceId\)return;/, 'an open chat, draft or hidden tab stops the poll — no background treadmill')
  assert.match(poll, /void resumeOnReturn\(true\)\.finally\(startListPoll\)/, 'landing poll re-arms itself through resumeOnReturn')
  // openSession 进门后停止主页轮询
  const opening = extractFunction(js, 'openSession')
  assert.match(opening, /stopListPoll\(\)/, 'the entry stops list poll during chat')
})

test('applyBootTails populates tailCache and marks tailArmedAt from boot payload', () => {
  const js = assets.zh.js
  const body = [
    extractFunction(js, 'eventSeq'),
    extractFunction(js, 'contentBlocks'),
    extractFunction(js, 'extractTail'),
    extractFunction(js, 'tailPack'),
    extractFunction(js, 'applyBootTails'),
  ].join('\n')
  const fn = new Function(
    'tails',
    `const tailCache = new Map(), tailArmedAt = {}, tailFailed = {}, TAIL_PACK_MAX = ${packMaxOf()}, TAIL_CACHE_MAX = ${cacheMaxOf()}, TAIL_TEXT_LIMIT = ${limitOf()};
     function noteSessionMessageAt(id, time) {}
     ${body}
     applyBootTails(tails);
     return { tailCache, tailArmedAt, tailFailed };`
  )
  const mockEvents = [
    { seq: 1, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }] } } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'World' }] } } }
  ]
  const res = fn({
    s1: { updatedAt: 123456, events: mockEvents },
    s2: { error: 'no-cursor' }
  })
  assert.equal(res.tailCache.has('s1'), true)
  assert.equal(res.tailCache.get('s1').text, 'World')
  assert.equal(res.tailCache.get('s1').pack.length, 2)
  assert.equal(res.tailArmedAt['s1'], 123456)
  assert.equal(res.tailCache.has('s2'), false)
})

test('applyBootData wires boot.tails into tailCache', () => {
  const js = assets.zh.js
  const bootData = extractFunction(js, 'applyBootData')
  assert.match(bootData, /if\(b\.tails\)applyBootTails\(b\.tails\)/, 'applyBootData forwards b.tails to applyBootTails')
})
