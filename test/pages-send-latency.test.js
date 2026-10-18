// First-message send latency (2026-10-16, user report):
//
//   "Pocket 第一次会话发送消息以后会有很长的延迟，大概有 1 秒钟。这时候如果用户
//    没反应，因为完全不知道消息发没发出去，多点一次就会重复发送。"
//
// The mechanism was pure ordering. send() opened with `await ensureSession()`
// and only cleared the composer, flipped the arrow to the stop square and
// painted the user's bubble AFTER that chain returned — and on a draft that
// chain is session.create plus the buffered preset/model/permission calls plus
// openRealtime. A reader watching an unchanged screen for a second taps again,
// and the second tap carried the same text into a second session.prompt.
//
// The fix is not a debounce. It is: the composer empties and the turn reads as
// started BEFORE the first await, so a second tap finds nothing to send; and a
// sendBusy latch closes the window for taps that race that same tick.
//
// These tests pin the ORDER, not the wording, because the order is the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mobilePageAssets } from '../lib/pages.js';

const { js } = mobilePageAssets({ locale: 'zh' });

function extractFunction(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} must exist in the page script`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} never closed`);
}

const sendBody = extractFunction(js, 'send');

// The first suspension point in the function body. Everything the reader can
// see has to be behind it, not in front.
const firstAwaitAt = sendBody.indexOf('await');
const composerClearedAt = sendBody.indexOf("promptEl.value=''");
const runningLockAt = sendBody.indexOf('agentRunning=true');
const bubblePaintedAt = sendBody.indexOf('paintMessages(');
const busyLatchAt = sendBody.indexOf('sendBusy=true');

test('send() clears the composer before its first await, not after the round trips', () => {
  assert.notEqual(composerClearedAt, -1, 'send() still empties the composer');
  assert.notEqual(firstAwaitAt, -1, 'send() still talks to the host');
  assert.ok(
    composerClearedAt < firstAwaitAt,
    'the composer must empty in the synchronous segment — otherwise the create window shows the same text and a second tap resends it',
  );
});

test('send() takes the turn lock and paints the bubble before the first await', () => {
  assert.ok(
    runningLockAt < firstAwaitAt,
    'agentRunning flips synchronously, so the send arrow becomes the stop square without waiting on the host',
  );
  assert.ok(
    bubblePaintedAt < firstAwaitAt,
    'the optimistic bubble is on screen before the first round trip — that bubble is the strongest "it went" signal there is',
  );
});

test('send() latches while in flight so a racing tap cannot double-send', () => {
  assert.notEqual(busyLatchAt, -1, 'the in-flight latch is set');
  assert.ok(busyLatchAt < firstAwaitAt, 'and it is set in the synchronous segment, before anything can suspend')
  assert.match(sendBody, /^function send\(\)\{if\(sendBusy\)return;/, 'a second tap during the flight returns immediately')
  assert.match(sendBody, /finally\{sendBusy=false;/, 'and the latch is released on every exit path, or the composer dies after one send')
});

test('the click handler is the only enter point and Enter still just types a newline', () => {
  // A double tap on the arrow is the reported trigger. Enter does not send
  // (composer-enter-newline.test.js), so the guard belongs here and only here.
  assert.match(js, /\$\('send'\)\.onclick=send/, 'the arrow is wired straight to send()')
  assert.doesNotMatch(sendBody, /onkeydown|keydown/, 'send() must not grow its own key handling')
});

test('a draft send materializes the session inside the rollback path', () => {
  // The await moved INTO the try, so a failed create now unwinds through the
  // same catch as a failed prompt: bubble withdrawn, lock released, text back.
  // 2026-10-19: the create still runs in the try, but the id it returns IS the
  // owner — `activeSession||await ensureSession()`. Reading activeSession again
  // after the await handed the send a session the reader had already left (a
  // back-tap landing inside ensureSession's buffered draft RPCs) and put
  // sessionId:null on the wire, which the Host rejects as gateway/input-invalid.
  const ownerAt = sendBody.indexOf('const owner=activeSession||await ensureSession()')
  assert.notEqual(ownerAt, -1, 'the draft still materializes on first use')
  assert.match(
    sendBody,
    /rpc\('session\.prompt',\{sessionId:owner/,
    'and the send addresses the session it just materialized',
  )
  assert.match(sendBody, /throw new Error\(L\.sendFailed/, 'a create that returns nothing is a failure, not a silent return')
});

test('the retry path clears the stale optimistic bubble even when the reader left', () => {
  // The bubble is only withdrawn for the session that owns it, but it is
  // withdrawn either way — an unconditional early return left it on the
  // transcript of a session the reader had switched to.
  const switchGuardAt = sendBody.indexOf('if(activeSession===owner&&optimisticPrompts.includes(optimistic))')
  assert.notEqual(switchGuardAt, -1, 'the reply branch confirms its session before touching live UI')
  assert.match(
    sendBody,
    /\}else\{optimisticPrompts=optimisticPrompts\.filter\(item=>item\.id!==optimistic\.id\)\}/,
    'and the bubble is dropped on the abandoned path too',
  )
});
