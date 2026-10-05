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
      if (depth === 0) return source.slice(start, i + 1);
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
    { id: 'm1', text: '先跑测试\n再修', images: 0, files: 0 },
    { id: 'm2', text: '', images: 1, files: 1 },
    { id: 'm3', text: '带附件', images: 1, files: 0 },
  ], 'text blocks join, media count, contentless and unrenderable items drop');
  assert.equal(rows[0].id, 'm1');
});

test('queuedRowsOf keeps its own id fallback for items the Host sent bare', () => {
  const rows = queuedRowsOf({ values: { inbox: { 'next-turn': [{ content: [{ type: 'text', text: 'x' }] }] } } });
  assert.equal(rows[0].id, 'q0', 'a missing id never renders as undefined');
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
    let currentGoal=null,queuedTurn=[]
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

// ------------------------------------------------------- wiring source pins

test('the docks are wired where the page already consumes projections', () => {
  // The page reads the registry in exactly three places; the docks must ride
  // all three or they drift out of date (the todos precedent).
  assert.match(js, /updateTodos\(value\.projections\);updateGoal\(value\.projections\);updateQueue\(value\.projections\)/,
    'applyHistory feeds the docks alongside todos');
  assert.match(js, /updateTodos\(projections\);updateGoal\(projections\);updateQueue\(projections\)/,
    'paintInstantHistory feeds the docks too');
  assert.match(js, /renderTodoDock\(\);currentGoal=null;queuedTurn=\[\];renderGoalBar\(\);renderQueueDock\(\)/,
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
});

test('the projections RPC is allowlisted with a flat sessionId wire param', () => {
  const entry = HARNESS_ENDPOINTS['session.projections'];
  assert.deepEqual(entry.args({ sessionId: 's1' }), { sessionId: 's1' },
    'the host declares { sessionId } flat, not a request wrap');
  assert.equal(entry.endpoint, 'session/projections');
  assert.ok(RPC_ALLOWLIST.has('session.projections'), 'paired phones may call it');
});
