// Stop button latency (live report 2026-10-05: "摁下去有延迟").
//
// Root cause: the stop press had zero visual acknowledgment. The handler
// awaited the session.cancel round trip (one tunnel RTT) and then a full
// loadHistory (another) before agentRunning flipped — a second or three over
// the tunnel where the button looked untouched and the deep-diving shimmer
// kept spinning; a hung request stayed silent for the full 12s rpc budget.
//
// The fix is an optimistic stop: the press flips a stopPending flag BEFORE the
// rpc, the button swaps to a disabled spinner and the turn-status line reads
// 正在停止… immediately; the flag reconciles when the Host confirms (turn end
// clears it via updateRunning) and reverts on a refused rpc.
//
// Behaviour-level first: the status line and the button swap both run against
// synthetic state; the handler and the reconcile points are source-pinned.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mobilePageAssets } from '../lib/pages.js';

const { js } = mobilePageAssets({ locale: 'zh' });

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in the rendered asset`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = source.slice(start, i + 1);
        const before = source.slice(Math.max(0, start - 6), start);
        return before.endsWith('async ') ? 'async ' + slice : slice;
      }
    }
  }
  throw new Error(`unbalanced braces after ${name}`);
}

const SQUARE = /<rect x="2" y="2"/;
const SPINNER = /class="spin"/;

// ------------------------------------------------------- turn-status line

function buildStatusSandbox() {
  const line = { textContent: '', removed: false, remove() { this.removed = true; } };
  const box = {
    _line: null,
    _html: '',
    scrollTop: 0, scrollHeight: 100, clientHeight: 100,
    querySelector: (sel) => (sel === '.turn-status' ? box._line : null),
    insertAdjacentHTML: (pos, html) => { box._line = line; box._html = html; },
  };
  const make = new Function(
    'box',
    `
    let agentRunning=true,pendingQuestion=null,stopPending=false
    const L={deepDiving:'深度思考中…',stopping:'正在停止…'}
    const $=()=>box
    ${extractFunction(js, 'statusLineHtml')}
    ${extractFunction(js, 'syncTurnStatus')}
    return {
      setStop(v){stopPending=v},
      setRunning(v){agentRunning=v},
      setQuestion(v){pendingQuestion=v},
      sync(){syncTurnStatus()},
      stopHtml(){return statusLineHtml()},
      get line(){return box._line},
      get insertedHtml(){return box._html},
    }
  `,
  );
  return make(box);
}

test('the status line reads 正在停止… the moment stopPending flips', () => {
  const box = buildStatusSandbox();
  assert.match(box.stopHtml(), /深度思考中…/, 'running label while not stopping');
  box.setStop(true);
  assert.match(box.stopHtml(), /正在停止…/, 'stopping label the instant the flag flips');

  box.sync();
  assert.ok(box.line, 'the line is inserted while running');
  assert.match(box.insertedHtml, /正在停止…/, 'inserted with the stopping copy');
  box.setStop(false);
  box.sync();
  assert.equal(box.line.textContent, '深度思考中…', 'an existing line is rewritten in place, not left stale');
});

test('the status line still yields to questions and settles with the turn', () => {
  const box = buildStatusSandbox();
  box.setStop(true);
  box.setQuestion({});
  box.sync();
  assert.equal(box.line, null, 'a pending question owns the composer; no status line fights it');

  box.setQuestion(null);
  box.sync();
  assert.ok(box.line, 'back when the question is gone');
  box.setRunning(false);
  box.sync();
  assert.equal(box.line.removed, true, 'turn over — the line goes');
});

// ---------------------------------------------------------- cancel button

function buildPromptSandbox() {
  const prompt = { value: '', style: {}, scrollHeight: 40 };
  const send = { hidden: false, disabled: false };
  const cancel = { hidden: false, disabled: false, innerHTML: '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor"/></svg>', _stopping: undefined };
  const els = { prompt, send, cancel };
  const make = new Function(
    'els',
    `
    let agentRunning=true,stopPending=false
    function readyDrafts(){return []}
    const $=(id)=>els[id]
    ${extractFunction(js, 'syncPromptUi')}
    return {
      prompt:els.prompt,send:els.send,cancel:els.cancel,
      setStop(v){stopPending=v},
      setRunning(v){agentRunning=v},
      type(t){els.prompt.value=t},
      sync(){syncPromptUi()},
    }
  `,
  );
  return make(els);
}

test('the stop button swaps to a disabled spinner on request and back on settle', () => {
  const box = buildPromptSandbox();
  box.sync();
  assert.match(box.cancel.innerHTML, SQUARE, 'idle stop shows the square');
  assert.equal(box.cancel.disabled, false);

  box.setStop(true);
  box.sync();
  assert.match(box.cancel.innerHTML, SPINNER, 'the press is acknowledged instantly (optimistic)');
  assert.equal(box.cancel.disabled, true, 'a second press cannot double-fire');

  box.setStop(false);
  box.sync();
  assert.match(box.cancel.innerHTML, SQUARE, 'settled back to the square');
  assert.equal(box.cancel.disabled, false);
});

test('the swap is guarded — syncing per keystroke never rewrites the button', () => {
  const box = buildPromptSandbox();
  box.sync();
  const stable = box.cancel.innerHTML;
  box.type('hello');
  box.sync();
  box.sync();
  assert.equal(box.cancel.innerHTML, stable, 'same state, same DOM — no churn');
  assert.equal(box.send.hidden, false, 'typed text shows send again');
});

// ----------------------------------------------------------- source pins

test('the cancel handler goes optimistic before the rpc and reverts on refusal', () => {
  const start = js.indexOf("$('cancel').onclick=");
  assert.notEqual(start, -1, 'the handler is wired');
  const body = js.slice(start, js.indexOf(";$('questionComposer')", start));
  assert.match(body, /if\(!activeSession\|\|stopPending\)return/, 'a pending stop cannot double-fire');
  assert.match(body, /stopPending=true;syncPromptUi\(\);syncTurnStatus\(\)/,
    'the ack happens before the rpc leaves');
  assert.match(body, /clearAwaitingTurn\(\);await rpc\('session\.cancel'/, 'the rpc itself is unchanged');
  assert.match(body, /catch\(e\)\{stopPending=false;syncPromptUi\(\);syncTurnStatus\(\);showError/,
    'a refused stop reverts instead of leaving a stuck spinner');
  assert.match(body, /finally\{lastHistoryKey='';await loadHistory\(false\)\}/,
    'the post-cancel reconciliation is kept');
});

test('stopPending reconciles where the turn actually ends', () => {
  assert.match(js, /agentRunning=turnRunningOpen\|\|awaitingTurnSeq!==null;if\(!agentRunning\)stopPending=false;/,
    'updateRunning clears the flag when the turn settles');
  assert.match(js, /status=agentRunning&&!pendingQuestion\?statusLineHtml\(\):''/,
    'paintMessages renders the shared status line');
  assert.match(js, /queueEditText='';stopPending=false;renderGoalBar\(\)/,
    'a session switch drops a stale stop request');
});
