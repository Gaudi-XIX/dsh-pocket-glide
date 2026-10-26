// The 2026-10-06 phone image-send failure, pinned.
//
// What the phone showed (user report): sending a photo painted a 「1 图片」 row
// and then the row vanished, "as if the picture had never been sent"; the draft
// thumbnail stayed in the composer. What the bridge had on disk was a single
// `rpc body refused … Request body is too large.` per attempt and nothing else:
// the body never reached the Host, so there was no Host error to read, no
// session journal entry, and the queued-inbox projection stayed empty.
//
// Root cause: the bridge admits an RPC body by METHOD, and the image paths did
// not agree with that table.
//   · `session.prompt` and `file.upload` were the large tier (25 MiB × 1.4);
//   · `command.execute` — which carries the composer's image drafts as
//     `submittedAttachments` for `/goal` and `/plan` — was still the 64 KB tier,
//     so one 542 KB photo (≈723 KB base64) was refused as "too large";
//   · `session.updateQueue` has the same shape (an `action.content` array) and
//     was in the same tier;
//   · the Host's own image limits (20 MiB per image, 200 MiB per message,
//     live-probed via `session/projections`) are far above any RPC ceiling, and
//     the page adopted them wholesale.
// The page now clamps to the transport budget, measures the encoded payload
// itself, and refuses a body its own method could not carry — with a message,
// not a silent disappearance. The bridge names the method, ceiling and both
// byte counts on every refusal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, httpFetch } from './helpers.js'
import { LARGE_BODY_BYTES, LARGE_BODY_METHODS } from '../lib/constants.js'
import { mobilePageAssets } from '../lib/pages.js'

function rpcCall(t, cookie, method, payload = {}) {
  return httpFetch(`${t.base}/api/rpc`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ method, payload }),
  })
}

test('§1 every method that can carry inline image base64 rides the large tier', () => {
  for (const method of ['file.upload', 'session.prompt', 'command.execute', 'session.updateQueue']) {
    assert.ok(
      LARGE_BODY_METHODS.has(method),
      `${method} can carry base64; the 64 KB tier refuses any real attachment`,
    )
  }
})

test('§2 command.execute carries a >64 KB attachment body through to the Host', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const submittedAttachments = [
      { type: 'image', mediaType: 'image/png', data: 'A'.repeat(70 * 1024), name: 'a.png' },
    ]
    const res = await rpcCall(t, cookie, 'command.execute', {
      sessionId: 's1',
      line: '/goal ship it',
      submittedAttachments,
    })
    assert.notEqual(res.status, 413, 'a /goal image attachment is exactly the 2026-10-06 failure')
    assert.equal(res.status, 200)
    const call = t.harness.records.calls.find((item) => item.url === '/api/commands/execute')
    assert.ok(call, 'command.execute must reach the Host')
    assert.equal(call.args.agentId, 's1')
    assert.equal(call.args.submittedAttachments.length, 1, 'the image draft must survive the transport')
    assert.equal(call.args.submittedAttachments[0].mediaType, 'image/png')
  } finally {
    await t.stop()
  }
})

test('§3 session.updateQueue carries a >64 KB edit body through to the Host', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await rpcCall(t, cookie, 'session.updateQueue', {
      sessionId: 's1',
      itemId: 'q0',
      action: { kind: 'edit', content: [{ type: 'text', text: 'x'.repeat(70 * 1024) }] },
    })
    assert.notEqual(res.status, 413, 'an edited queued message rides the same content array')
    assert.equal(res.status, 200)
    assert.ok(t.harness.records.calls.some((item) => item.url === '/api/session/updateQueue'))
  } finally {
    await t.stop()
  }
})

test('§4 a refused body names its method, ceiling and both sizes', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    // A normal-tier method keeps the test cheap: 70 KB is already over 64 KB.
    const oversized = JSON.stringify({ method: 'settings.describe', payload: { pad: 'x'.repeat(70 * 1024) } })
    const res = await httpFetch(`${t.base}/api/rpc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: oversized,
    })
    assert.equal(res.status, 413)
    assert.equal((await res.json()).error, 'Request body is too large.')
    const refusal = t.logs.find(({ message }) => message.startsWith('rpc body refused'))
    assert.ok(refusal, 'the refusal must say so on the log')
    assert.match(
      refusal.message,
      /rpc body refused trace=\S+ device=\S+ bytes=\d+ declared=\d+ method=settings\.describe ceiling=65536: Request body is too large\./,
      'a 413 that names no method and no sizes is undiagnosable from the phone\u2019s side',
    )
  } finally {
    await t.stop()
  }
})

test('§5 the served page carries the ceilings and the method-aware guard', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  assert.ok(
    js.includes(`const RPC_BODY_CEILING=${LARGE_BODY_BYTES};`),
    'the bridge ceiling must be injected from lib/constants.js — a duplicated literal drifts',
  )
  assert.ok(
    js.includes(`const RPC_LARGE_BODY_METHODS=${JSON.stringify([...LARGE_BODY_METHODS])};`),
    'the page must know which methods the bridge admits in the large tier',
  )
  assert.ok(
    js.includes('rpcBodyCeilingFor(sendMethod)'),
    'send() must refuse a body its own method cannot carry, before the bridge has to',
  )
  assert.ok(
    js.includes('encodedImageBytes()>RPC_BODY_BUDGET'),
    'the picked size is the browser\u2019s word; the encoded length is the fact that must gate the draft',
  )
  assert.ok(
    js.includes('imageMediaTypeOf'),
    'an Android gallery pick with an empty type must not be dropped without a word',
  )
  assert.ok(
    js.includes("method==='command.execute'||method==='session.prompt'"),
    'a prompt carrying a photo takes far longer than 12 s over the tunnel',
  )
})

test('§6 the clamp, the tier lookup and the encoded measurement are executed, not merely present', () => {
  const { js } = mobilePageAssets({ locale: 'zh' })
  const start = js.indexOf('const FALLBACK_IMAGE_LIMITS=')
  const end = js.indexOf('let draftSeq=0;')
  assert.ok(start >= 0 && end > start, 'the budget block must sit between the fallback and the draft sequence')
  const block = js.slice(start, end)
  const build = (drafts, projections) =>
    new Function(
      'streamProjections',
      'composerDrafts',
      `${block}; return { imageLimits, base64Length, utf8Length, overBodyBudget, rpcBodyCeilingFor }`,
    )(projections, drafts)

  // The Host's live numbers (2026-10-06 probe): 20 MiB per image, 20 images,
  // 200 MiB per message. The aggregate is the one that builds an uncarryable body.
  const hostLimits = {
    maxImageBytes: 20971520,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 209715200,
    maxImagePixels: 64000000,
    maxImageDimension: 8192,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  }
  const clamped = build([], { values: { imageLimits: hostLimits } })
  const limits = clamped.imageLimits()
  assert.equal(limits.maxImageBytes, 20971520, 'a 20 MiB single image still fits the transport')
  assert.equal(limits.maxImagesPerMessage, 20, 'the per-image count is not the transport boundary')
  assert.ok(
    limits.maxMessageImageBytes < 209715200,
    'the Host aggregate must be clamped: 200 MiB can never travel in one RPC body',
  )
  assert.ok(
    clamped.base64Length(limits.maxMessageImageBytes) <= LARGE_BODY_BYTES - 64 * 1024,
    'the clamped aggregate must encode inside the bridge ceiling, headroom included',
  )

  // Without a projection the fallback numbers stand (both already inside budget).
  const fallback = build([], undefined).imageLimits()
  assert.equal(fallback.maxImageBytes, 10 * 1024 * 1024)
  assert.equal(fallback.maxMessageImageBytes, 25 * 1024 * 1024)

  // The tier lookup mirrors lib/constants.js, not a guess.
  assert.equal(clamped.rpcBodyCeilingFor('session.prompt'), LARGE_BODY_BYTES)
  assert.equal(clamped.rpcBodyCeilingFor('command.execute'), LARGE_BODY_BYTES)
  assert.equal(clamped.rpcBodyCeilingFor('settings.describe'), 64 * 1024)

  // Over budget means over, measured on the encoded base64 and on UTF-8 text.
  const huge = build([{ kind: 'image', status: 'ready', data: 'A'.repeat(36 * 1024 * 1024) }], undefined)
  assert.equal(huge.overBodyBudget(''), true, '36 MiB of base64 plus envelope cannot fit a 35 MiB ceiling')
  const small = build([{ kind: 'image', status: 'ready', data: 'A'.repeat(1024) }], undefined)
  assert.equal(small.overBodyBudget('hello'), false)
  assert.equal(small.utf8Length('图片'), 6, 'a CJK client must measure UTF-8 bytes, not code units')
  assert.equal(small.base64Length(3), 4)
})
