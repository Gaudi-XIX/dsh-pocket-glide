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
  const line = { textContent: '', removed: false, dataset: {}, remove() { this.removed = true; } };
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
    // 2026-10-21: the line also carries the live turn clock and the retry notice,
    // both read from page globals. The sandbox leaves them idle so the classic
    // 正在停止/深度求索 copy is what these assertions see.
    let turnElapsedAt=0,turnElapsedTurn=null,turnRetry=null
    const L={deepDiving:'深度求索中',deepDivingFor:'深度求索中，用时{duration} ···',stopping:'正在停止…',retryError:'模型报错，正在重试 {retry}/{max}',durHour:'小时',durMin:'分',durSec:'秒'}
    const $=()=>box
    const esc=(v)=>String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    const formatElapsed=(ms)=>Math.round(ms/1000)+'s'
    const startTurnStatusTimer=()=>{},stopTurnStatusTimer=()=>{},syncTurnStatusLabel=()=>{}
    ${extractFunction(js, 'statusLabel')}
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
  assert.match(box.stopHtml(), /深度求索中/, 'running label while not stopping');
  box.setStop(true);
  assert.match(box.stopHtml(), /正在停止…/, 'stopping label the instant the flag flips');

  box.sync();
  assert.ok(box.line, 'the line is inserted while running');
  assert.match(box.insertedHtml, /正在停止…/, 'inserted with the stopping copy');
  box.setStop(false);
  box.sync();
  assert.equal(box.line.textContent, '深度求索中', 'an existing line is rewritten in place, not left stale');
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
  assert.match(body, /stopPending=true;[\s\S]*?syncPromptUi\(\);syncTurnStatus\(\);try\{clearAwaitingTurn/,
    'the ack happens before the rpc leaves');
  assert.match(body, /stopPendingTimer=setTimeout\(\(\)=>\{stopPendingTimer=null;if\(!agentRunning\)return;stopPending=false;/,
    'a cancel the host never answers cannot leave the button disabled forever');
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
  assert.match(js, /queueEditText='';goalBusy=false;goalEditing=false;goalEditText='';stopPending=false;renderGoalBar\(\)/,
    'a session switch drops a stale stop request');
});

// ------------------------------------------------- turn-boundary reconcile
//
// The optimistic stop belongs to the turn that was running when the button was
// pressed. The watchdogs that retire a dead turn used to leave the flag set,
// so the composer stayed on the spinner even though nothing was running any
// more; and a turn/start after a cancelled turn inherited the stale request.

function buildBoundarySandbox() {
  const noop = () => {};
  // 2026-10-13: expireTurnRunning no longer retires synchronously — it consults
  // the host (session.list) first, so a long silent tool run cannot fake a
  // finished turn. The sandbox models that rpc with a controllable host row.
  const hostState = { running: false };
  const rpc = (method) => method === 'session.list'
    ? Promise.resolve({ items: [{ sessionId: 's1', running: hostState.running }] })
    : Promise.resolve({});
  const make = new Function(
    'eventSeq',
    'clearTurnRunningWatch',
    'syncPromptUi',
    'syncTurnStatus',
    'schedulePoll',
    'rpc',
    `
    let awaitingTurnTimer=null,awaitingTurnSeq=null,turnRunningTimer=null
    let turnRunningSeq=-1,turnRunningOpen=false,turnRunningSeenSeq=-1
    let turnRunningConfirming=false
    let agentRunning=true,stopPending=true,lastHistoryKey='',pendingQuestion=null,activeSession='s1'
    let turnElapsedAt=0,turnElapsedTurn=null,turnRetry=null
    const turnElapsedByTurn=new Map(),turnRetryMax=new Map()
    const stopTurnStatusTimer=()=>{}
    const AWAITING_TURN_MAX_MS=1000,TURN_RUNNING_IDLE_MAX_MS=1000
    ${extractFunction(js, 'expireAwaitingTurn')}
    ${extractFunction(js, 'expireTurnRunning')}
    ${extractFunction(js, 'confirmTurnRunning')}
    ${extractFunction(js, 'finishTurnConfirm')}
    ${extractFunction(js, 'watchTurnRunning')}
    ${extractFunction(js, 'noteTurnBoundary')}
    return {
      setStop(v){stopPending=v},
      expireAwaiting(){expireAwaitingTurn()},
      expireRunning(){expireTurnRunning()},
      note(entry){noteTurnBoundary(entry)},
      get stop(){return stopPending},
      get running(){return turnRunningOpen},
      get confirming(){return turnRunningConfirming},
    }
  `,
  );
  const box = make(
    (entry) => {
      const e = entry && (entry.event || entry);
      const s = e && e.seq;
      return typeof s === 'number' ? s : -1;
    },
    noop, noop, noop, noop, rpc,
  );
  box.setHost = (running) => { hostState.running = running === true };
  box.settle = async () => { await new Promise((r) => setImmediate(r)); };
  return box;
}

test('the watchdogs that retire a dead turn also retire its stop request', async () => {
  const box = buildBoundarySandbox();

  box.setStop(true);
  box.expireAwaiting();
  assert.equal(box.stop, false, 'expireAwaitingTurn clears a stale stop');
  assert.equal(box.running, false, 'and closes the running state as before');

  box.note({ seq: 5, event: { type: 'turn/start' } });
  assert.equal(box.running, true, 'a fresh turn opens the running state');
  box.setStop(true);
  box.setHost(false);
  box.expireRunning();
  assert.equal(box.stop, true, 'the stop stays while the host is being asked');
  assert.equal(box.confirming, true, 'a consult is in flight');
  assert.equal(box.running, true, 'the turn is still open while consulting');
  await box.settle();
  assert.equal(box.stop, false, 'expireTurnRunning clears a stale stop once the host agrees it is idle');
  assert.equal(box.running, false, 'and closes the running state as before');
  assert.equal(box.confirming, false, 'the consult flag clears after the verdict');
});

test('a host that says still-running keeps the turn open and the stop alive', async () => {
  const box = buildBoundarySandbox();
  box.note({ seq: 5, event: { type: 'turn/start' } });
  box.setStop(true);
  box.setHost(true);
  box.expireRunning();
  await box.settle();
  assert.equal(box.running, true, 'the turn stays open when the host says still running');
  assert.equal(box.stop, true, 'the stop request survives because the turn did not retire');
  assert.equal(box.confirming, false, 'the consult flag still clears');
});

test('a new turn/start retires the previous stop; a bare turn/end does not', () => {
  const box = buildBoundarySandbox();

  box.setStop(true);
  box.note({ seq: 5, event: { type: 'turn/start' } });
  assert.equal(box.stop, false, 'the stop belonged to the turn that was running when it was pressed');
  assert.equal(box.running, true, 'and the new turn still opens');

  box.setStop(true);
  box.note({ seq: 6, event: { type: 'turn/end' } });
  assert.equal(box.stop, true, 'turn/end alone leaves the flag to updateRunning');
  assert.equal(box.running, false, 'the turn closes as before');
});

test('the boundary clear points ship in the page source', () => {
  assert.match(js, /turnRunningOpen=false;agentRunning=false;stopPending=false;/,
    'expireAwaitingTurn retires the stale stop');
  // 2026-10-13: the retirement lines moved out of expireTurnRunning into
  // finishTurnConfirm — expireTurnRunning now consults the host first (a long
  // silent tool run must not fake a finished turn), and only the host saying
  // "not running" reaches the retirement. Pin both halves.
  assert.match(js, /if\(!turnRunningOpen\|\|turnRunningConfirming\)return;[\s\S]*?confirmTurnRunning\(turnRunningSeenSeq\)/,
    'expireTurnRunning hands the verdict to the host consult');
  assert.match(js, /if\(!turnRunningOpen\)return;if\(turnRunningSeenSeq>seenAtStart\)\{watchTurnRunning\(turnRunningSeenSeq\);return\}if\(busy\)\{[\s\S]*?\}turnRunningOpen=false;stopPending=false;/,
    'finishTurnConfirm retires the stale stop only on a host that says idle');
  assert.match(js, /if\(turnRunningOpen\)\{clearTurnRunningWatch\(\);turnRunningSeenSeq=turnRunningSeq;if\(fresh\)stopPending=false;[\s\S]*?if\(!turnElapsedAt\|\|turnElapsedTurn!==startedKey\)\{turnElapsedTurn=startedKey;turnElapsedAt=Date\.now\(\);turnRetry=null\}/,
    'noteTurnBoundary retires the stop when a new turn starts and arms the turn clock');
});
