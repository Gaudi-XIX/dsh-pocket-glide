// Goal bar + queue dock: the phone passing through what the desktop shows.
//
// The desktop renders a GoalBar (long-running goal state) and a QueueDock
// (messages queued behind a running turn). Both live in the Host's projection
// registry — `values.goal` and `values.inbox['next-turn']` — the same values
 // object this page already consumes for todos and model selection. So the
// pass-through is a rendering concern: two pure organs read the registry, two
// docks paint it, and the registry the page already holds is refreshed when
// the events that fold into those projections arrive on the stream.
//
// Behaviour-level first (organs run for real, docks render through the same
// extraction recipe the subagent-session-dom assertions use); source-level
// only for the wiring that has no observable effect in isolation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mobilePageAssets, goalOf, queuedRowsOf } from '../lib/pages.js';
import { HARNESS_ENDPOINTS, RPC_ALLOWLIST } from '../lib/constants.js';

const { css, js, document } = mobilePageAssets({ locale: 'zh' });

// --------------------------------------------------------------- extraction

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
        // The anchor also matches `async function name(` — splice the keyword
        // back or every `await` in the body becomes a SyntaxError.
        const before = source.slice(Math.max(0, start - 6), start);
        return before.endsWith('async ') ? 'async ' + slice : slice;
      }
    }
  }
  throw new Error(`unbalanced braces after ${name}`);
}

const GOAL = {
  goal: { objective: '修复BUG', phase: 'active', maxGoalRounds: 256, id: 'goal-1', revision: 2 },
  roundsStarted: 4,
  createdAt: 1790124422703,
  updatedAt: 1790124687934,
};

// ------------------------------------------------------------------- organs

test('goalOf reads the projection registry and refuses everything else', () => {
  assert.equal(goalOf(null), null, 'no projections at all');
  assert.equal(goalOf(undefined), null);
  assert.equal(goalOf({}), null, 'no values key');
  assert.equal(goalOf({ values: {} }), null, 'registry without a goal entry');
  assert.equal(goalOf({ values: { goal: null } }), null, 'an ended goal projects null');
  assert.equal(goalOf({ values: { goal: {} } }), null, 'a goal entry without the inner goal is malformed');
  assert.equal(goalOf({ values: { goal: GOAL } }), GOAL, 'a live goal passes through untouched');
});

test('queuedRowsOf renders inbox next-turn rows and drops malformed items', () => {
  assert.deepEqual(queuedRowsOf(null), [], 'no projections');
  assert.deepEqual(queuedRowsOf({ values: {} }), [], 'registry without inbox');
  assert.deepEqual(queuedRowsOf({ values: { inbox: {} } }), [], 'inbox without next-turn');
  assert.deepEqual(queuedRowsOf({ values: { inbox: { 'next-turn': 'nope' } } }), [], 'a non-array next-turn is ignored');

  const rows = queuedRowsOf({ values: { inbox: { 'next-turn': [
    { id: 'm1', content: [{ type: 'text', text: '先跑测试' }, { type: 'text', text: '再修' }] },
    { id: 'm2', content: [{ type: 'image', mediaType: 'image/png' }, { type: 'file', name: 'a.zip' }] },
    { id: 'm3', content: [{ type: 'text', text: '带附件' }, { type: 'image' }] },
    { content: 'not-an-array' },
    null,
    { id: 'm4', content: [{ type: 'tool-removal' }] },
  ] } } });

  assert.deepEqual(rows, [
    { id: 'm1', managed: true, text: '先跑测试\n再修', images: 0, files: 0 },
    { id: 'm2', managed: true, text: '', images: 1, files: 1 },
    { id: 'm3', managed: true, text: '带附件', images: 1, files: 0 },
  ], 'text blocks join, media count, contentless and unrenderable items drop');
  assert.equal(rows[0].id, 'm1');
});

test('queuedRowsOf marks which rows carry the Host MessageId', () => {
  const rows = queuedRowsOf({ values: { inbox: { 'next-turn': [
    { id: 'real', content: [{ type: 'text', text: 'a' }] },
    { content: [{ type: 'text', text: 'b' }] },
  ] } } });
  assert.equal(rows[0].managed, true, 'a real id is manageable');
  assert.equal(rows[1].managed, false, 'a synthesized fallback id is display-only');
});

// -------------------------------------------------------------- dock render

function buildDockSandbox() {
  const fake = () => ({ innerHTML: '', hidden: true });
  const containers = { goalBar: fake(), queueDock: fake() };
  const make = new Function(
    'containers',
    `
    const L={
      goalPhaseActive:'进行中',goalPhasePaused:'已暂停',goalPhaseBlocked:'受阻',goalPhaseComplete:'已完成',
      goalRoundUnit:' 轮',queueCount:'排队消息 {n} 条',queueImage:'图片',queueFile:'文件',queueUnrenderable:'[图片/文件]'
    }
    let currentGoal=null,queuedTurn=[],queueBusy=false,queueEditing=null,queueEditText=''
    const $=(id)=>containers[id]
    function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
    ${extractFunction(js, 'goalOf')}
    ${extractFunction(js, 'queuedRowsOf')}
    ${extractFunction(js, 'updateGoal')}
    ${extractFunction(js, 'updateQueue')}
    ${extractFunction(js, 'renderGoalBar')}
    ${extractFunction(js, 'renderQueueDock')}
    return {
      goalBar: containers.goalBar,
      queueDock: containers.queueDock,
      setGoal(v){updateGoal(v)},
      setQueue(v){updateQueue(v)},
      get goalHtml(){return containers.goalBar.innerHTML},
      get queueHtml(){return containers.queueDock.innerHTML},
    }
  `,
  );
  return make(containers);
}

test('the goal bar paints objective, phase and rounds, and hides when goalless', () => {
  const box = buildDockSandbox();

  box.setGoal({ values: { goal: GOAL } });
  assert.equal(box.goalBar.hidden, false, 'a live goal is visible');
  assert.ok(box.goalHtml.includes('修复BUG'), 'the objective is on screen');
  assert.ok(box.goalHtml.includes('进行中'), 'the phase renders in the page locale');
  assert.ok(box.goalHtml.includes('4 / 256 轮'), 'the round counter is there');

  box.setGoal({ values: { goal: { ...GOAL, goal: { ...GOAL.goal, phase: 'blocked' }, } } });
  assert.ok(box.goalHtml.includes('受阻'), 'the blocked phase gets its own label');
  assert.match(box.goalBar.innerHTML, /is-blocked/, 'and the blocked styling hook');

  box.setGoal({ values: { goal: null } });
  assert.equal(box.goalBar.hidden, true, 'an ended goal hides the bar');
  assert.equal(box.goalHtml, '', 'and leaves no stale markup behind');

  box.setGoal(null);
  assert.equal(box.goalBar.hidden, true, 'a registry without the key hides too');
});

test('the queue dock paints the count and per-row previews, and hides when empty', () => {
  const box = buildDockSandbox();

  box.setQueue({ values: { inbox: { 'next-turn': [
    { id: 'm1', content: [{ type: 'text', text: '先跑测试' }] },
    { id: 'm2', content: [{ type: 'image' }, { type: 'file', name: 'a.zip' }] },
  ] } } });
  assert.equal(box.queueDock.hidden, false, 'queued messages are visible');
  assert.ok(box.queueHtml.includes('排队消息 2 条'), 'the count reads the row number');
  assert.ok(box.queueHtml.includes('先跑测试'), 'text preview on screen');
  assert.ok(box.queueHtml.includes('1 图片'), 'image blocks become chips');
  assert.ok(box.queueHtml.includes('1 文件'), 'file blocks become chips');

  box.setQueue({ values: { inbox: { 'next-turn': [] } } });
  assert.equal(box.queueDock.hidden, true, 'an emptied queue hides the dock');
  assert.equal(box.queueHtml, '');

  box.setQueue({ values: {} });
  assert.equal(box.queueDock.hidden, true, 'a registry without inbox hides too');
});

// --------------------------------------------------- queue row management

function buildQueueActionSandbox(rpc) {
  const fake = () => ({ innerHTML: '', hidden: true, querySelector: () => null });
  const containers = { goalBar: fake(), queueDock: fake() };
  const toasts = [];
  const make = new Function(
    'containers',
    'rpc',
    'showToast',
    'toasts',
    `
    const L={queueEditFailed:'编辑失败',queueRemoveFailed:'撤回失败',queueSteerFailed:'发送失败',queueCount:'排队消息 {n} 条',queueImage:'图片',queueFile:'文件',queueUnrenderable:'[图片/文件]',queueEdit:'编辑',queueSave:'保存',queueCancel:'取消',queueRemove:'撤回',queueSteer:'立刻发送'}
    let currentGoal=null,queuedTurn=[],queueBusy=false,queueEditing=null,queueEditText='',activeSession='s1'
    const $=(id)=>containers[id]
    function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
    ${extractFunction(js, 'goalOf')}
    ${extractFunction(js, 'queuedRowsOf')}
    ${extractFunction(js, 'updateGoal')}
    ${extractFunction(js, 'updateQueue')}
    ${extractFunction(js, 'renderGoalBar')}
    ${extractFunction(js, 'renderQueueDock')}
    ${extractFunction(js, 'fetchProjectionsNow')}
    ${extractFunction(js, 'scheduleProjectionsSync')}
    ${extractFunction(js, 'queueAction')}
    ${extractFunction(js, 'startQueueEdit')}
    ${extractFunction(js, 'cancelQueueEdit')}
    ${extractFunction(js, 'saveQueueEdit')}
    return {
      queueDock: containers.queueDock,
      toasts,
      queueAction,
      startQueueEdit,
      cancelQueueEdit,
      saveQueueEdit,
      setQueue(v){updateQueue(v)},
      setEditText(v){queueEditText=v},
      get busy(){return queueBusy},
      get editing(){return queueEditing},
      get html(){return containers.queueDock.innerHTML},
    }
  `,
  );
  const box = make(containers, rpc, (msg) => toasts.push(msg), toasts);
  return box;
}

const REAL_QUEUE = { values: { inbox: { 'next-turn': [
  { id: 'm1', content: [{ type: 'text', text: '先跑测试' }] },
  { id: 'm2', content: [{ type: 'text', text: '' }, { type: 'image' }] },
] } } };

test('recall sends remove and refreshes the registry with the answer', async () => {
  const calls = [];
  const after = { values: { inbox: { 'next-turn': [
    { id: 'm2', content: [{ type: 'text', text: '' }, { type: 'image' }] },
  ] } } };
  const box = buildQueueActionSandbox(async (method, payload) => {
    calls.push([method, payload]);
    if (method === 'session.updateQueue') {
      assert.deepEqual(payload, { sessionId: 's1', itemId: 'm1', action: { kind: 'remove' } },
        'the recall rides the request shape the host declares');
      return { accepted: true };
    }
    assert.equal(method, 'session.projections');
    return after;
  });
  box.setQueue(REAL_QUEUE);
  await box.queueAction('m1', { kind: 'remove' }, '撤回失败');

  assert.deepEqual(calls.map(([method]) => method), ['session.updateQueue', 'session.projections'],
    'the action is followed by a registry refresh, not a local guess');
  assert.equal(box.busy, false, 'the in-flight flag always clears');
  assert.match(box.html, /m2|m1/, 'the dock re-rendered from the refreshed registry');
  assert.deepEqual(box.toasts, [], 'no error on the happy path');
});

test('a refused action toasts the failure and clears the busy flag', async () => {
  const box = buildQueueActionSandbox(async (method) => {
    if (method === 'session.updateQueue') throw new Error('queued item is no longer pending');
    return REAL_QUEUE;
  });
  box.setQueue(REAL_QUEUE);
  await box.queueAction('m1', { kind: 'remove' }, '撤回失败');

  assert.deepEqual(box.toasts, ['撤回失败 · queued item is no longer pending'],
    'the host error text rides the toast');
  assert.equal(box.busy, false);
});

test('edit opens inline, save sends the trimmed text, empty save is a no-op', async () => {
  const calls = [];
  const box = buildQueueActionSandbox(async (method, payload) => {
    calls.push([method, payload]);
    return method === 'session.updateQueue' ? { accepted: true } : REAL_QUEUE;
  });
  box.setQueue(REAL_QUEUE);

  box.startQueueEdit('m1');
  assert.equal(box.editing, 'm1', 'the row is in edit state');
  assert.match(box.html, /data-queue-edit-text/, 'the dock renders the edit box');
  assert.match(box.html, /先跑测试/, 'pre-filled with the row text');

  box.setEditText('   ');
  box.saveQueueEdit();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [], 'whitespace-only text never reaches the host');

  box.setEditText('  新文本  ');
  box.saveQueueEdit();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const update = calls.find(([method]) => method === 'session.updateQueue');
  assert.deepEqual(update && update[1], { sessionId: 's1', itemId: 'm1', action: { kind: 'edit', content: [{ type: 'text', text: '新文本' }] } },
    'the save sends the host edit shape, trimmed');
  assert.equal(box.editing, null, 'a successful save leaves edit state');
});

test('cancel leaves the row untouched', () => {
  const box = buildQueueActionSandbox(async () => ({ accepted: true }));
  box.setQueue(REAL_QUEUE);
  box.startQueueEdit('m1');
  box.cancelQueueEdit();
  assert.equal(box.editing, null);
  assert.match(box.html, /data-queue-action="edit"/, 'the row is back to its buttons');
  assert.doesNotMatch(box.html, /data-queue-edit-text/, 'no edit box left behind');
});

// ------------------------------------------------------- wiring source pins

test('the docks are wired where the page already consumes projections', () => {
  // The page reads the registry in exactly three places; the docks must ride
  // all three or they drift out of date (the todos precedent).
  assert.match(js, /updateTodos\(value\.projections\);updateGoal\(value\.projections\);updateQueue\(value\.projections\)/,
    'applyHistory feeds the docks alongside todos');
  assert.match(js, /updateTodos\(projections\);updateGoal\(projections\);updateQueue\(projections\)/,
    'paintInstantHistory feeds the docks too');
  assert.match(js, /renderTodoDock\(\);currentGoal=null;queuedTurn=\[\];queueBusy=false;queueEditing=null;queueEditText='';renderGoalBar\(\);renderQueueDock\(\)/,
    'a session switch clears the docks with the todos');

  // Live updates: the stream events that fold into these projections schedule
  // the light registry fetch, and the timer dies with the stream.
  assert.match(js, /type==='goal\/change'\|\|type==='agent\/inbox\/spliced'\|\|type==='user\/message'\|\|type==='turn\/start'\|\|type==='turn\/end'\)scheduleProjectionsSync\(sessionId\)/,
    'projection-folding events schedule the refresh');
  assert.match(js, /rpc\('session\.projections',\{sessionId\}\)/, 'the refresh calls the projections endpoint');
  assert.match(js, /if\(projectionsSyncTimer!==null\)clearTimeout\(projectionsSyncTimer\);projectionsSyncTimer=null;/,
    'closing the stream cancels a pending refresh');

  // The docks exist in the document and the organs are inlined for page scope.
  assert.match(document, /id="goalBar"/, 'goal bar slot');
  assert.match(document, /id="queueDock"/, 'queue dock slot');
  assert.match(css, /\.goal-bar\{/, 'goal bar styled');
  assert.match(css, /\.queue-dock\{/, 'queue dock styled');

  // Row management wiring: the dock's buttons and edit box have live handlers.
  assert.match(js, /rpc\('session\.updateQueue',\{sessionId:owner,itemId,action\}\)/,
    'row actions go through the updateQueue endpoint');
  assert.match(js, /\$\('queueDock'\)\.onclick=/, 'the dock has a click handler');
  assert.match(js, /\$\('queueDock'\)\.oninput=/, 'the edit box has an input handler');
  assert.match(js, /function queueAction\(itemId,action,failLabel\)/, 'one action runner');
  assert.match(js, /function startQueueEdit\(/, 'inline edit opener');
  assert.match(js, /queueBusy=false;queueEditing=null;queueEditText='';/, 'a session switch clears the edit state');
});

test('the projections RPC is allowlisted with a flat sessionId wire param', () => {
  const entry = HARNESS_ENDPOINTS['session.projections'];
  assert.deepEqual(entry.args({ sessionId: 's1' }), { sessionId: 's1' },
    'the host declares { sessionId } flat, not a request wrap');
  assert.equal(entry.endpoint, 'session/projections');
  assert.ok(RPC_ALLOWLIST.has('session.projections'), 'paired phones may call it');
});

test('the updateQueue RPC is allowlisted with the request wrap the host declares', () => {
  const entry = HARNESS_ENDPOINTS['session.updateQueue'];
  assert.equal(entry.endpoint, 'session/updateQueue');
  const payload = { sessionId: 's1', itemId: 'm1', action: { kind: 'edit', content: [{ type: 'text', text: 'x' }] } };
  assert.deepEqual(entry.args(payload), { request: payload },
    'the whole call rides a single json param named request');
  assert.ok(RPC_ALLOWLIST.has('session.updateQueue'), 'paired phones may call it');
});
