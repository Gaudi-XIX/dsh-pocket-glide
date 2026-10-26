// S2-0 (2026-10-23): the second step ("make the phone's questions cheaper") cannot be
// proven without a baseline, and the baseline did not exist: a successful `session/list`
// wrote nothing, and `history attempt` carries milliseconds but never the bytes the phone
// pays. These two lines are that baseline — one line a minute each, so a log that caps at
// 512KB does not fill with per-call rows.
//
// `bridgeOptions.trafficLogEveryMs = 0` retires every bucket on the next counter activity,
// so each entry and each host read lands on its own line. The exact number of lines is
// asserted, not just "at least one": a bucket that flushes twice, or a counter that never
// resets, must turn this red.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, httpFetch } from './helpers.js'

const respondOk = (pathname) => {
  if (pathname === '/api/session/list') {
    return {
      ok: true,
      value: {
        items: [{ sessionId: 'sess-traffic', updatedAt: 1, projections: { asOfSeq: 40 } }],
      },
    }
  }
  if (pathname === '/api/session/page') {
    return {
      ok: true,
      value: {
        records: [{ seq: 40, type: 'user/message', data: { text: 'hello' } }],
        hasMore: false,
      },
    }
  }
  return undefined
}

const rpc = async (base, cookie, method, payload) => {
  const res = await httpFetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ method, payload }),
  })
  assert.equal(res.status, 200, `${method} answers`)
  return res
}

// A read that fails on the Host side answers the page with an error status; the counter
// still owes a line, so this path must not insist on 200.
const rpcAnyStatus = async (base, cookie, method, payload) => {
  return httpFetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ method, payload }),
  })
}


const sum = (lines, pattern) =>
  lines.reduce((total, line) => {
    const hit = pattern.exec(line)
    return total + (hit ? Number(hit[1]) : 0)
  }, 0)

test('S2-0: list reads are counted by reason, and one Host read carries ms/rows/bytes together', async () => {
  const lines = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: { respond: respondOk },
    bridgeOptions: { log: (level, message) => lines.push(`${level} ${message}`), trafficLogEveryMs: 0 },
  })
  try {
    const cookie = await t.pairMobile('PocketTraffic/1.0')
    for (let i = 0; i < 4; i++) await rpc(t.base, cookie, 'session.list', {})

    const reads = lines.filter((line) => line.includes('list read '))
    // Four entries: the first misses, the next three hit the 10s window. Each entry
    // retires a bucket and each retire flushes one line, so four entries plus the one
    // host read landing in its pinned bucket give exactly four lines here.
    assert.equal(reads.length, 4, `one line per retired bucket, got:\n${reads.join('\n')}`)
    assert.equal(sum(reads, /\bmiss=(\d+)/), 1, 'only the first entry paid a Host read')
    assert.equal(sum(reads, /\bttl-hit=(\d+)/), 2, 'the calls inside the 10s window cost nothing')
    assert.equal(sum(reads, /\bhost=(\d+)/), 1, 'exactly one real Host read for four page calls')
    assert.equal(sum(reads, /\brows=(\d+)/), 1, 'and its row count')
    assert.ok(sum(reads, /\bbytes=(\d+)/) > 0, 'and the payload size it cost')

    // The byte/ms/row figures belong to the one read: they must sit on ONE line, not be
    // scattered across buckets (a slow read crossing a minute boundary must not split).
    const hostLines = reads.filter((line) => / host=1(\s|$)/.test(line))
    assert.equal(hostLines.length, 1, 'the Host read is reported on exactly one line')
    assert.match(hostLines[0], / rows=1(\s|$)/, 'rows on the same line as host')
    assert.match(hostLines[0], / ms=\d+(\s|$)/, 'ms on the same line as host')
    assert.match(hostLines[0], / bytes=\d+\s*$/, 'bytes on the same line as host')
  } finally {
    await t.stop()
  }
})

test('S2-0: a failed Host read still reports its round trip (no rows/bytes guessed)', async () => {
  const lines = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/list' ? { ok: false, error: { message: 'boom' } } : respondOk(pathname),
    },
    bridgeOptions: { log: (level, message) => lines.push(`${level} ${message}`), trafficLogEveryMs: 0 },
  })
  try {
    const cookie = await t.pairMobile('PocketTraffic/1.0')
    await rpcAnyStatus(t.base, cookie, 'session.list', {})
    // A second entry retires the bucket the failed read was pinned to.
    await rpcAnyStatus(t.base, cookie, 'session.list', {})

    const reads = lines.filter((line) => line.includes('list read '))
    const failed = reads.filter((line) => / host=1(\s|$)/.test(line))
    assert.ok(failed.length >= 1, `the failed read was counted:\n${reads.join('\n')}`)
    assert.match(failed[0], / ms=\d+(\s|$)/, 'its round trip is reported')
    assert.match(failed[0], / rows=0(\s|$)/, 'rows are not guessed')
    assert.match(failed[0], / bytes=0\s*$/, 'bytes are not guessed')
  } finally {
    await t.stop()
  }
})

test('S2-0: every history answer reports its call count and a byte sample', async () => {
  const lines = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: { respond: respondOk },
    bridgeOptions: { log: (level, message) => lines.push(`${level} ${message}`), trafficLogEveryMs: 0 },
  })
  try {
    const cookie = await t.pairMobile('PocketTraffic/1.0')
    // Two answers: the first opens a bucket, the second retires it with its sample.
    await rpc(t.base, cookie, 'session.history', { sessionId: 'sess-traffic', maxMessages: 30 })
    await rpc(t.base, cookie, 'session.history', { sessionId: 'sess-traffic', maxMessages: 30 })

    const answers = lines.filter((line) => line.includes('history answer '))
    assert.equal(answers.length, 1, `one line per retired bucket, got:\n${answers.join('\n')}`)
    const line = answers[0]
    assert.match(line, /calls=1(\s|$)/, 'how many answers the phone paid for')
    assert.match(line, /records=\d+(\s|$)/, 'how many records they carried')
    assert.match(line, /unchanged=0(\s|$)/, 'zero until S2-2 ships the {unchanged:true} answer')
    assert.match(line, /sampleBytes=\d+\s*$/, 'the payload weight, sampled once a minute')
    assert.ok(Number(/sampleBytes=(\d+)/.exec(line)[1]) > 0, 'a non-empty answer is measured, not guessed')
  } finally {
    await t.stop()
  }
})
