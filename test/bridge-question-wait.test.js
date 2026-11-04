// D1/D5 — the phone holds a timed question's wait open, and lets it go on purpose.
//
// `userQuestions/attachWait` is a stream method that yields exactly ONE frame,
// `{remainingMs}`, and then stays open. While the claim is open the Host does not
// run its own timer (`TimedQuestionWait` returns early when `claims.size > 0`),
// so the phone can freeze a question for as long as the card is on screen and
// answer slowly without asking the Host for anything. The iOS card's own
// deadline is derived from that one frame, which is why the frame has to arrive
// exactly once and the stream must not be closed under it.
//
// These assertions are behavioral: a recorder stands in for the carrier socket,
// the RPCs are driven over the real bridge, and the frames that would have gone
// on the wire are read back verbatim — the open's exact shape, and the absence of
// any second open or a cancel while the card is still up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { httpFetch, startBridge } from './helpers.js'

/** Resolve true once `predicate` holds, false if it never did inside `limitMs`. */
async function waitFor(predicate, limitMs = 5000) {
  const deadline = Date.now() + limitMs
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return true
}

/** POST one bridge RPC over the mobile cookie. */
async function rpc(t, cookie, method, payload) {
  const res = await httpFetch(`${t.base}/api/rpc`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ method, payload }),
  })
  return { status: res.status, body: await res.json() }
}

/**
 * Pair a handset and wait for its carrier, then replace the carrier writer with a
 * recorder. Pairing is what arms the monitor, and its open is what the bridge's
 * own `registerCarrier` binds to; taking the writer over afterwards is the only
 * way to read the frames without a socket in between.
 */
async function recorded(t, userAgent) {
  const cookie = await t.pairMobile(userAgent)
  assert.ok(await waitFor(() => t.bridge.muxConnected === true), 'the carrier came up')
  /** @type {Array<Record<string, unknown>>} */
  const sent = []
  t.bridge.carrierSend = (frame) => {
    sent.push(JSON.parse(frame))
    return true
  }
  return { cookie, sent }
}

const WAIT_FRAME = (streamId, remainingMs) => JSON.stringify({ type: 'item', streamId, value: { remainingMs } })

test('D1: interaction.wait opens exactly one attachWait stream with the Host method\'s own arguments, and the first frame is the answer', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const { cookie, sent } = await recorded(t, 'PocketWait/1.0')

    const answer = rpc(t, cookie, 'interaction.wait', { sessionId: 'sess-1', callId: 'c1' })
    assert.ok(await waitFor(() => sent.length === 1), 'one frame went out')
    assert.deepEqual(sent[0], {
      type: 'open',
      streamId: 'uq-wait:c1',
      endpoint: 'userQuestions/attachWait',
      // `payload.args` is keyed by the Host method's parameter names, not a list.
      payload: { args: { agent: 'sess-1', callId: 'c1' } },
    })

    // A re-render asks again before the frame has landed: the claim is already
    // in hand, so nothing else may go on the wire. A second `open` on the same
    // stream id makes the gateway close the whole socket ('duplicate Remote
    // stream id'), which would take every live conversation with it.
    const again = rpc(t, cookie, 'interaction.wait', { sessionId: 'sess-1', callId: 'c1' })
    assert.ok(await waitFor(() => true, 50))
    assert.equal(sent.length, 1, 'a second ask re-uses the open claim')

    t.bridge.consumeMuxEnvelope(WAIT_FRAME('uq-wait:c1', 88000))
    const first = await answer
    assert.equal(first.status, 200)
    assert.deepEqual(first.body, { ok: true, value: { remainingMs: 88000 } })
    const cached = await again
    assert.deepEqual(cached.body, { ok: true, value: { remainingMs: 88000 } }, 'the re-ask is answered from the same claim')

    // Holding the claim is the whole point: no cancel, no close, while the card
    // is still on screen.
    assert.equal(sent.length, 1, 'the claim stays open after its one frame')
  } finally {
    await t.stop()
  }
})

test('D1: the wait cannot be held without a carrier, and says so instead of hanging', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    // No handset paired: nothing armed the monitor, so there is no socket and no
    // writer bound. Driven at the method because the RPC door needs a cookie,
    // which is part of what pairing would arm.
    assert.equal(t.bridge.carrierSend, undefined, 'nothing has bound a carrier')
    const refused = await t.bridge.holdWaitClaim('sess-1', 'c9')
    assert.equal(refused.ok, false)
    assert.match(String(refused.error), /not connected/, 'the answer names the missing carrier')
    assert.equal(t.bridge.waitClaims.size, 0, 'nothing is left holding a claim')
  } finally {
    await t.stop()
  }
})

test('D3: interaction.waitRelease closes the claim once, and a second release is a no-op', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const { cookie, sent } = await recorded(t, 'PocketRelease/1.0')

    const answer = rpc(t, cookie, 'interaction.wait', { sessionId: 'sess-1', callId: 'c1' })
    assert.ok(await waitFor(() => sent.length === 1), 'the open went out')
    t.bridge.consumeMuxEnvelope(WAIT_FRAME('uq-wait:c1', 60000))
    await answer

    const released = await rpc(t, cookie, 'interaction.waitRelease', { callId: 'c1' })
    assert.equal(released.status, 200)
    assert.deepEqual(released.body, { ok: true, value: { released: true } })
    assert.deepEqual(sent[1], { type: 'cancel', streamId: 'uq-wait:c1' }, 'closing the stream is what re-arms the Host timer')
    assert.equal(t.bridge.waitClaims.size, 0, 'the claim is gone from the table')

    const second = await rpc(t, cookie, 'interaction.waitRelease', { callId: 'c1' })
    assert.deepEqual(second.body, { ok: true, value: { released: false } })
    assert.equal(sent.length, 2, 'a second release sends nothing')
  } finally {
    await t.stop()
  }
})

test('D1: a claim whose frame never arrives is settled when the carrier goes away', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const { cookie, sent } = await recorded(t, 'PocketCarrierGone/1.0')
    const answer = rpc(t, cookie, 'interaction.wait', { sessionId: 'sess-1', callId: 'c7' })
    assert.ok(await waitFor(() => sent.length === 1), 'the open went out')

    // The same hook the monitor calls when its socket closes. A claim left
    // parked here would block that RPC forever, because the stream it waits on
    // can no longer speak.
    t.bridge.carrierSend = undefined
    t.bridge.dropWaitClaims('Harness event stream is not connected.')
    const settled = await answer
    assert.equal(settled.status, 400)
    assert.equal(settled.body.ok, false)
    assert.equal(t.bridge.waitClaims.size, 0)
  } finally {
    await t.stop()
  }
})
