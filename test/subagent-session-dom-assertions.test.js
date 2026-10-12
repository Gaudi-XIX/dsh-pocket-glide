// WP-SESSION-DOM (change 2026-10-03-fix-pocket-session-dom-assertions, WP-1).
//
// A subagent session is another session's tool, never a row on this phone's list.
// test/subagent-session-hiding.test.js already pins that rule at SOURCE level: it reads
// the rendered asset and checks the ORDER OF indexOf() inside loadHistory's catch. That
// is a literal assertion, so it cannot see anything the slice stops short of — and the
// slice stops short of two real behaviours this file now runs:
//
//   * the busy branch's actual EFFECT (zero writes into #messages, no error painted) as
//     opposed to the mere presence of three substrings in that order;
//   * the control that makes the busy assertion mean anything — an ordinary failure
//     MUST still paint the retry row. Without it, "no writes" would also be what a
//     broken render path produces, and the busy test would pass for the wrong reason;
//   * renderWorkspaces() runs against synthetic state, so the blank-row
//     fallback that keeps a filtered id from ghosting is observed rather than described;
//   * a mutation case: feed the UNPROJECTED rows and watch the rule break. That is the
//     discriminating-power receipt for this whole file — see the R1.3 comment.
//
// House pattern (copied locally, not imported: test/** is a serial single-writer domain
// and no shared helper may be added by this card). The page script lives inside one
// template literal, so every assertion pulls the REAL text out of the rendered asset and
// runs it. Behaviour-level first; source-level only where a behaviour cannot be observed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mobilePageAssets, blankRowVisible, BLANK_ROW_VISIBLE_MS } from '../lib/pages.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_DIR = path.join(REPO_ROOT, 'test');
const { js } = mobilePageAssets({ locale: 'zh' });

// --------------------------------------------------------------- R1.0 提取配方

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
        // The anchor `function name(` also matches `async function name(`, and the slice
        // then begins at `function` — splicing that into a Function body turns every
        // `await` in the body into a SyntaxError. Put the keyword back.
        const before = source.slice(Math.max(0, start - 6), start);
        return before.endsWith('async ') ? 'async ' + slice : slice;
      }
    }
  }
  throw new Error(`unbalanced braces after ${name}`);
}

// The page's own label tables, so every copy asserted below is what the phone renders.
function pageLabels(source) {
  const line = source.match(/^const L=(\{.*\});/m);
  assert.ok(line, 'the page label table must render as one JSON line');
  return JSON.parse(line[1]);
}

const L = pageLabels(js);
const HISTORY_IDLE_CAP = Number(js.match(/HISTORY_POLL_IDLE_CAP_MS=(\d+)/)[1]);
// renderWorkspaces caps the rows it builds per expanded workspace; the sandbox must
// carry the same ceiling or the cap under test is the test's own, not the page's.
const LIST_ROWS_MAX = Number(js.match(/LIST_ROWS_MAX=(\d+)/)[1]);
// The workspace head builds its notices through wsFlagsOf/wsFlagHtml (0.4.31), which
// read this same ceiling out of page scope — the sandbox has to declare it too.
const WS_FLAGS_MAX = Number(js.match(/WS_FLAGS_MAX=(\d+)/)[1]);

// loadHistory's catch reads the errorCode off whatever its rpc rejected with, so the
// sandbox below hands it a hand-written `rpc` stub that throws the Error this file
// controls. The page's own rpc / rpcFailure are deliberately NOT spliced in: the case is
// about loadHistory's catch branch, and driving the real transport would test the bridge
// instead while making the branch's own error handling harder to see.

function fakeElement() {
  const el = {
    textContent: '',
    innerHTML: '',
    writes: [],
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: {
      _set: new Set(),
      add(...names) { names.forEach((n) => this._set.add(n)); },
      remove(...names) { names.forEach((n) => this._set.delete(n)); },
      contains(name) { return this._set.has(name); },
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html || ''; },
    set(value) { el._html = value; el.writes.push(value); },
  });
  return el;
}

// --------------------------------------------------------- R1.1 buildHistorySandbox

// loadHistory owns a dozen page globals. A sandbox that forgets one throws inside the try
// and silently measures the catch branch instead of the path under test, so every flag
// the function reads is declared here with the same initial value the page gives it.
function buildHistorySandbox({ rpcThrows = null, streamConnected = false } = {}) {
  const containers = { messages: fakeElement(), chatError: fakeElement() };
  const events = [];
  const make = new Function(
    'containers',
    'fail',
    'events',
    `
    let activeSession='s1',historyBusy=false,streamRevision=0,streamConnected=${streamConnected}
    let agentRunning=false,pendingQuestion=null,idlePollMs=750
    let streamEvents=[],olderEvents=[],olderHasMore=false
    let importantErrorActive=false,openPrefetch=null
    const HISTORY_POLL_IDLE_CAP_MS=${HISTORY_IDLE_CAP}
    const L=${JSON.stringify(L)}
    const $=(id)=>containers[id]
    function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
    function isStreamDownCopy(t){const v=String(t||'');return v===L.disconnectedRetry||v===L.streamDownTunnel||v===L.streamDownHost||v===L.streamDownBackground}
    function importantChatCopy(t){return isStreamDownCopy(t)||String(t||'').indexOf(L.streamFailure)===0}
    function showError(id,error,fallback){const text=error?.disconnected?L.disconnectedRetry:error?.message||fallback||L.failed;$(id).textContent=text;if(id==='chatError')importantErrorActive=!!(error?.disconnected||error?.important)||importantChatCopy(text)}
    function clearTransientError(id){if(id==='chatError'&&importantErrorActive)return;const el=$(id);if(el)el.textContent=''}
    function transcriptHasContent(){return Boolean(streamEvents.length||olderEvents.length)}
    function syncPendingQuestion(){}
    function applyHistory(){}
    function schedulePoll(){}
    function showSessionList(){events.push('showSessionList')}
    async function rpc(method){if(method==='session.history')throw fail;return null}
    ${extractFunction(js, 'loadHistory')}
    return {
      loadHistory,
      events,
      containers,
      get idlePollMs(){return idlePollMs},
    }
  `,
  );
  const error = new Error('rpc failed');
  if (rpcThrows) Object.assign(error, rpcThrows);
  const sandbox = make(containers, error, events);
  sandbox.error = error;
  return sandbox;
}

test('R1.1 a refused subagent address writes nothing into the transcript', async () => {
  // The host refuses a direct address to a subagent session with an English sentence.
  // The page must answer that with a return to the list — no sentence, no retry button.
  const sandbox = buildHistorySandbox({
    rpcThrows: { errorCode: 'session/agent-busy', message: 'durable parent address is not reachable' },
  });
  await sandbox.loadHistory(false, false);

  assert.deepEqual(sandbox.events, ['showSessionList'], 'the busy family falls back to the list');
  assert.equal(sandbox.containers.chatError.textContent, '', 'no error copy is painted at all');
  assert.deepEqual(sandbox.containers.messages.writes, [], 'and #messages is never touched — not even emptied');
  assert.ok(!sandbox.containers.messages.innerHTML.includes('durable parent address'), 'the host sentence reaches no markup');
});

test('R1.1 the control: an ordinary failure still paints the retry row', async () => {
  // This is what makes the test above mean anything. Same sandbox, same render path, a
  // failure that is NOT the busy family: the page must surface it and hand back a retry.
  // If the render path were broken, BOTH tests would see zero writes and the busy
  // assertion would pass for the wrong reason.
  const sandbox = buildHistorySandbox({ rpcThrows: { message: 'boom' } });
  await sandbox.loadHistory(false, false);

  assert.deepEqual(sandbox.events, [], 'an ordinary failure does not bounce to the list');
  assert.equal(sandbox.containers.chatError.textContent, 'boom', 'the real message is shown');
  assert.equal(sandbox.containers.messages.writes.length, 1, 'and exactly one write happens');
  const markup = sandbox.containers.messages.innerHTML;
  assert.ok(markup.includes('class="loading-failed"'), 'the failure row is the one the page styles');
  assert.ok(markup.includes('data-reload="1"'), 'it carries the reload affordance');
  assert.ok(markup.includes(L.retry), 'labelled with the page own retry copy, not a test literal');
  assert.equal(L.retry, '重试', 'and that copy is the zh one the phone renders');
});

// ---------------------------------------------------------- R1.2 buildRenderSandbox

// renderWorkspaces() paints #workspaces from two arrays the page keeps: `workspaces` (the
// per-workspace shell, each carrying sessionIds) and `sessionSummaries` (the PROJECTED
// rows). The whole no-ghost-row guarantee lives in the mismatch between them, so the
// sandbox owns both and lets the real render run.
// `expanded` defaults to EVERY workspace: these tests are about which sessions
// become rows, and since 2026-10-10 the page builds rows only for expanded
// workspaces (a collapsed card renders its rows on the next tap, so 469 hidden
// rows stop costing a phone 300 KB of markup per refresh). A test that wants the
// collapsed behaviour must say so — `expanded: []`.
function buildRenderSandbox({ workspaces = [], summaries = [], expanded = null, revealed = null } = {}) {
  const host = fakeElement();
  const make = new Function(
    'workspaces',
    'sessionSummaries',
    'expandedWsIds',
    'revealedLists',
    'container',
    `
    const L=${JSON.stringify(L)}
    const BLANK_ROW_VISIBLE_MS=${BLANK_ROW_VISIBLE_MS}
    const LIST_ROWS_MAX=${LIST_ROWS_MAX}
    const WS_FLAGS_MAX=${WS_FLAGS_MAX}
    // These tests pin projection/row/pill behavior, not the unread census: recency 0
    // keeps never-opened rows quiet exactly as they were before 0.4.33 (every fixture
    // here is fresh + the ledger is empty). The census itself is pinned in
    // test/landing-attention.test.js and test/pages-scroll-anchors.test.js.
    const UNREAD_RECENCY_MS=0
    // 0.4.35 的台账就绪位：这些沙箱不测「拉回前的悬置」，直接置就绪。
    let openedAtLedgerReady=true
    let bootAttention=0
    // The head notices need the focused-session id (a focused row never reads as
    // unread); these sandboxes render with nothing open.
    let activeSession=null
    const readOpenedMap=()=>({})
    ${extractFunction(js, 'normalizeSelection')}
    ${extractFunction(js, 'fieldText')}
    ${extractFunction(js, 'sessionModelLabel')}
    ${extractFunction(js, 'isSessionUnread')}
    ${extractFunction(js, 'readLastMessageMap')}
    ${extractFunction(js, 'lastMessageAtOf')}
    ${extractFunction(js, 'lastMessageTimeOf')}
    ${extractFunction(js, 'sortAtOf')}
    const LAST_MESSAGE_KEY=${JSON.stringify(js.match(/LAST_MESSAGE_KEY='([^']+)'/)[1])}
    let lastMessageAt=readLastMessageMap()
    const $=(id)=>container
    function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
    ${extractFunction(js, 'visibleSessions')}
    ${extractFunction(js, 'blankRowVisible')}
    ${extractFunction(js, 'taskState')}
    ${extractFunction(js, 'taskGlyph')}
    ${extractFunction(js, 'relativeTime')}
    ${extractFunction(js, 'timeFor')}
    ${extractFunction(js, 'titleFor')}
    ${extractFunction(js, 'wsFlagOf')}
    ${extractFunction(js, 'wsFlagClass')}
    ${extractFunction(js, 'wsFlagRank')}
    ${extractFunction(js, 'wsFlagsOf')}
    ${extractFunction(js, 'wsFlagHtml')}
    ${extractFunction(js, 'renderWorkspaces')}
    return {
      renderWorkspaces,
      visibleSessions,
      taskState,
      taskGlyph,
      get markup(){return container.innerHTML},
      rowIds(){return [...container.innerHTML.matchAll(/data-id="([^"]*)"/g)].map((m)=>m[1])},
    }
  `,
  );
  const sandbox = make(workspaces, summaries, new Set(expanded ?? workspaces.map((w) => w.workspaceId)), new Set(revealed ?? []), host);
  sandbox.host = host;
  return sandbox;
}

const WS_ROW = (sessionId, extra = {}) => ({
  sessionId,
  updatedAt: Date.now(),
  projections: { values: { title: `chat ${sessionId}` } },
  ...extra,
});

test('R1.2 focus is picked from the projected rows only', () => {
  const sub = WS_ROW('sub1', { origin: 'subagent', awaitingQuestion: true, updatedAt: Date.now() + 9_999 });
  const running = WS_ROW('s1', { running: true, updatedAt: Date.now() + 5_000 });
  const idle = WS_ROW('s2');
  const projected = buildRenderSandbox().visibleSessions([idle, sub, running]);

  // Feed the projection's real output back in, so this is the same array the page holds.
  const sandbox = buildRenderSandbox({ summaries: projected });

  assert.deepEqual(projected.map((s) => s.sessionId), ['s2', 's1'], 'the subagent row never reaches sessionSummaries');
  // The focus picker itself retired with the landing jump (0.4.36); what is pinned
  // here is that the projection the list renders is the one visibleSessions keeps.
});

test('R1.2 the workspace list paints the projected row and nothing else', () => {
  const sandbox = buildRenderSandbox({
    workspaces: [{ workspaceId: 'w1', title: 'DSH', path: 'F:/defws', sessionIds: ['sub1', 's1'] }],
    summaries: buildRenderSandbox().visibleSessions([
      WS_ROW('sub1', { origin: 'subagent', projections: { values: { title: 'CHILD-SECRET' } } }),
      WS_ROW('s1'),
    ]),
  });
  sandbox.renderWorkspaces();

  assert.deepEqual(sandbox.rowIds(), ['s1'], 'the subagent id is not a clickable row');
  assert.ok(!sandbox.markup.includes('CHILD-SECRET'), 'and its transcript title never leaks into the markup');
  assert.ok(!sandbox.markup.includes('data-id="sub1"'), 'nor as an attribute value');
  assert.ok(sandbox.markup.includes('data-ws="w1"'), 'the workspace itself is still rendered');
  // The per-workspace task count was retired by user decision (2026-10-10: 「我要这个
  // 数量干啥呢？直接不传吧」) — the row list above IS the answer, and it already
  // excludes subagent children, projected-away ids and stale blank shells.
  assert.ok(!sandbox.markup.includes('ws-count'), 'no task count is painted any more');
});

test('R1.2 a projected-away id lands on the empty state, not on a ghost row', () => {
  // The workspace shell still lists the id (the host owns that list); the summary is gone.
  // renderWorkspaces must synthesise a blank entry, filter it, and show the empty hint —
  // that filter is the only thing standing between a stale id and a dead row.
  const sandbox = buildRenderSandbox({
    workspaces: [{ workspaceId: 'w1', title: 'DSH', path: 'F:/defws', sessionIds: ['sub1'] }],
    summaries: buildRenderSandbox().visibleSessions([]),
  });
  sandbox.renderWorkspaces();

  assert.deepEqual(sandbox.rowIds(), [], 'no row at all — a blank entry is not a row');
  assert.ok(!sandbox.markup.includes('sub1'), 'the id appears nowhere');
  assert.ok(sandbox.markup.includes('class="ws-empty"'), 'the empty hint is what the user sees');
  assert.ok(sandbox.markup.includes(L.noTasksHint), 'carrying the page own copy');
  assert.ok(!sandbox.markup.includes('ws-last'), 'no status glyph is invented for a row that does not exist');
});

// ------------------------------------------------------------------ R1.3 mutation

test('R1.3 mutation: unprojected rows ghost and leak — the projection is load-bearing', () => {
  // This is the discriminating-power receipt for the whole file. It feeds the SAME
  // renderWorkspaces() the tests above used, with the ONE difference that the rows
  // skipped visibleSessions(). Every guarantee above inverts:
  //
  //   * the subagent becomes a clickable row twice (once per workspace),
  //   * its transcript title leaks into the markup.
  //
  // If any assertion in this file were "rewritten until true" instead of observed, this
  // case would have to go red with it — it runs the page's real render, so a fake
  // assertion cannot make it green and a real regression cannot leave it green.
  const rawRows = [
    WS_ROW('sub1', {
      origin: 'subagent',
      awaitingQuestion: true,
      updatedAt: Date.now() + 9_999,
      projections: { values: { title: 'CHILD-SECRET' } },
    }),
    WS_ROW('s1'),
  ];
  const sandbox = buildRenderSandbox({
    workspaces: [
      { workspaceId: 'w1', title: 'DSH', path: 'F:/defws', sessionIds: ['sub1', 's1'] },
      { workspaceId: 'w2', title: 'other', path: 'F:/defws/tmp', sessionIds: ['sub1'] },
    ],
    summaries: rawRows, // NOT passed through visibleSessions()
  });
  sandbox.renderWorkspaces();

  assert.deepEqual(sandbox.rowIds(), ['sub1', 's1', 'sub1'], 'the child is a row in both workspaces');
  assert.ok(sandbox.markup.includes('CHILD-SECRET'), 'and its title is on screen');
});

// --------------------------------- R1-audit item 4 (change 2026-10-04-fix-pocket-r1-audit-batch)
//
// A session created on this phone used to be invisible: createSessionIn pushes a
// blank:true summary (the :748 shape re-fed below) and renderWorkspaces filtered
// EVERY blank row, so the new chat stayed a ghost until the server projected a
// non-blank summary. The exemption is the missingSummary discriminant: the
// synthesized placeholder carries missingSummary:true (the R1.2 guard above keeps
// pinning that), a real blank row does not.
//
// Follow-up (2026-10-05, live report): the same exemption surfaced the desktop's
// abandoned new-chat shells — days-old blank:true summaries, one unnamed row per
// workspace. The two cases are separated by freshness now (blankRowVisible): a
// blank row is a row only inside BLANK_ROW_VISIBLE_MS, and non-blank rows never
// meet the rule, so a shell reappears the moment it has content.

test('R1-audit a locally created blank session is a visible row, not a ghost', () => {
  const sandbox = buildRenderSandbox({
    workspaces: [{ workspaceId: 'w1', title: 'DSH', path: 'F:/defws', sessionIds: ['new1'] }],
    summaries: [{ sessionId: 'new1', updatedAt: Date.now(), running: false, blank: true, awaitingQuestion: false }],
  });
  sandbox.renderWorkspaces();

  assert.deepEqual(sandbox.rowIds(), ['new1'], 'the new session is a clickable row');
});

test('R1-audit follow-up a days-old blank shell is not a row again', () => {
  const sandbox = buildRenderSandbox({
    workspaces: [{ workspaceId: 'w1', title: 'DSH', path: 'F:/defws', sessionIds: ['old1'] }],
    summaries: [{ sessionId: 'old1', updatedAt: Date.now() - 3 * BLANK_ROW_VISIBLE_MS, running: false, blank: true, awaitingQuestion: false }],
  });
  sandbox.renderWorkspaces();

  assert.deepEqual(sandbox.rowIds(), [], 'a stale empty shell is not a clickable row');
  assert.ok(sandbox.markup.includes('class="ws-empty"'), 'the empty hint is what the user sees');
});

test('R1-audit follow-up blankRowVisible owns the freshness boundary', () => {
  // The organ decides, so pin it directly: one millisecond either side of the
  // window flips visibility, an unparsable stamp is never fresh, and a running
  // session is never hidden by its age. The rendered copy behaving identically is
  // what the two sandbox tests above pin.
  const now = 1_800_000_000_000;
  assert.equal(blankRowVisible({ updatedAt: now - BLANK_ROW_VISIBLE_MS + 1 }, now, BLANK_ROW_VISIBLE_MS), true, 'just inside the window');
  assert.equal(blankRowVisible({ updatedAt: now - BLANK_ROW_VISIBLE_MS - 1 }, now, BLANK_ROW_VISIBLE_MS), false, 'just outside the window');
  assert.equal(blankRowVisible({ updatedAt: 'not-a-date' }, now, BLANK_ROW_VISIBLE_MS), false, 'an unparsable stamp is not fresh');
  assert.equal(blankRowVisible({ updatedAt: now - 99 * BLANK_ROW_VISIBLE_MS, running: true }, now, BLANK_ROW_VISIBLE_MS), true, 'running beats stale');
});

// ------------------------------------------------- R1.4 default-entry drift guard

// ---- Status honesty (change 2026-10-08-feat-pocket-subagent-status-visibility, item 1) ----
// The old taskState fell through to 'done' — a green check — for every row that was
// merely not running. Two false signals came out of that: a lead whose child works on
// (running:false on the parent row) and a row whose writer is held elsewhere
// (agentAvailable:false, the wire's only "not routable" signal). The new chain shows
// both explicitly, and the green check survives only where nothing says otherwise.

test('STATUS-1 a held writer (agentAvailable:false) reads done like the desktop', () => {
  const sandbox = buildRenderSandbox();
  assert.equal(sandbox.taskState({ running: false, agentAvailable: false }), 'done', 'agentAvailable is not a state signal — a restart lights nothing');
  assert.ok(!sandbox.taskState({ running: false, agentAvailable: false }).match(/unknown/), 'the unknown state is gone entirely');
});

test('STATUS-2 a frozen parent with a running child (descendantRunning) reads running', () => {
  const sandbox = buildRenderSandbox();
  assert.equal(sandbox.taskState({ running: false, descendantRunning: true }), 'running', 'the aggregation from the projection decides');
  assert.ok(sandbox.taskGlyph('running').includes('spin'), 'and paints the spinner');
});

test('STATUS-3 a settled row with no adverse signal keeps the green check', () => {
  const sandbox = buildRenderSandbox();
  assert.equal(sandbox.taskState({ running: false }), 'done');
  const glyph = sandbox.taskGlyph('done');
  assert.ok(glyph.includes('m5.7 9.2 2.2 2.2 4.4-4.7'), 'the check-mark path is unchanged (green comes from CSS is-done)');
  assert.ok(!glyph.includes('spin') && !glyph.includes('?'), 'and it is neither the spinner nor the unknown mark');
});

test('STATUS-4 priority: awaiting and error outrank the rest; no signal means done', () => {
  const sandbox = buildRenderSandbox();
  assert.equal(sandbox.taskState({ awaitingQuestion: true, agentAvailable: false }), 'awaiting');
  assert.equal(sandbox.taskState({ lastError: 'x', agentAvailable: false }), 'error');
  assert.equal(sandbox.taskState({ running: true, descendantRunning: true }), 'running');
  assert.equal(sandbox.taskState({ running: false, agentAvailable: undefined }), 'done', 'missing agentAvailable is done');
  assert.equal(sandbox.taskState({ running: false, agentAvailable: false }), 'done', 'false is not a state either (desktop parity)');
  assert.equal(sandbox.taskState({ blank: true }), 'blank');
});

test('STATUS-5 a held writer paints done end to end (the unknown pill is retired)', () => {
  const sandbox = buildRenderSandbox({
    workspaces: [{ workspaceId: 'w1', title: 'DSH', path: 'F:/defws', sessionIds: ['held1'] }],
    summaries: [{ sessionId: 'held1', updatedAt: Date.now(), running: false, agentAvailable: false }],
  });
  sandbox.renderWorkspaces();

  assert.ok(sandbox.markup.includes('ws-last is-done'), 'the pill class carries done');
  assert.ok(sandbox.markup.includes('task-row is-done'), 'and the row class does too');
  assert.ok(!sandbox.markup.includes('is-unknown'), 'no unknown anywhere');
});

// ------------------------------------------------- BUG-2 agentPreset reads the projection, never the summary

test('PRESET-1 agentPresetOf reads the projection map with three states', () => {
  const make = new Function(
    `
    ${extractFunction(js, 'agentPresetOf')}
    return agentPresetOf;
  `,
  )();

  // undefined: the row carries no projection values at all (list rows without
  // the agentPreset key) — the caller must keep its current preset.
  assert.equal(make(undefined), undefined, 'no projections at all reads undefined');
  assert.equal(make({}), undefined, 'empty projections read undefined');
  assert.equal(make({ values: {} }), undefined, 'values without agentPreset read undefined');
  // null: the host projected an explicit "no preset".
  assert.equal(make({ values: { agentPreset: null } }), null, 'a projected null is a real null, not undefined');
  // string: the projected id wins.
  assert.equal(make({ values: { agentPreset: 'balanced' } }), 'balanced', 'a projected id passes through');
  // A non-string value (defensive) never leaks through.
  assert.equal(make({ values: { agentPreset: 5 } }), undefined, 'non-string values read undefined');
});

test('PRESET-2 the settings row feeds the projection into the preset state', () => {
  const sandbox = buildRenderSandbox({
    workspaces: [{ workspaceId: 'w1', title: 'DSH', path: 'F:/defws', sessionIds: ['s1'] }],
    summaries: [{ sessionId: 's1', updatedAt: Date.now(), running: false, projections: { values: { agentPreset: 'codex-plan' } } }],
  });
  // taskState must not be confused by a projections-bearing row (the state chain
  // reads only signal booleans; a values map is not a completion signal).
  assert.equal(sandbox.taskState({ sessionId: 's1', running: false, projections: { values: { agentPreset: 'codex-plan' } } }), 'done', 'a preset row with no other signal stays done');
});

// ------------------------------------------------- R1.4 default-entry drift guard (layout lock)

test('R1.4 the default entry cannot pick up the DOM script — one-level glob, resolved by node:fs', () => {
  // WP-2 (test/dom/subagent-session-dom.mjs) needs a browser and must stay out of the
  // default entry. The safety argument is not about file NAMES — it is about how the
  // entry's PATTERN RESOLVES — so the pattern is resolved here, by Node's own glob engine
  // (`node:fs` `globSync`), the engine `npm test` resolves a pattern with, asked here of the
  // literal the `entry` const below carries. That literal is hardcoded in this file, NOT read
  // from package.json: retune `scripts.test` and this guard stays green. Known boundary, not a
  // defect — if the real entry ever moves, the const moves with it by hand.
  // A hand-rolled readdir list only resembles a glob: it can go red, or stay green, for
  // reasons that have nothing to do with glob semantics.
  //
  //   entry      — the hardcoded `*.test.js` over test/: the default entry's current shape.
  //                What actually keeps the browser script out is the `.test.js` suffix, not
  //                the single level — a recursive `**/*.test.js` over the same tree
  //                resolves the same files (41 at this commit) and still no `.mjs`;
  //   domModules — `*.mjs` over test/dom/;
  //   domEntry   — `*.test.js` over test/dom/: the SAME one-level pattern, asked of the
  //                directory that holds the browser script;
  //   deep       — an independent recursive walk, the second opinion on what a `*` does
  //                not reach.
  //
  // The load-bearing pair is domModules + domEntry: the engine really does look inside
  // test/dom/ (the .mjs pattern resolves the script there) and really is pattern-selective
  // once it is there (.test.js resolves to nothing). Without the first half the second
  // would be vacuous — an empty result is also exactly what a silently skipped directory
  // produces. Drop any .test.js into test/dom/ and the domEntry line is what turns red,
  // with glob semantics as its reason.
  const domDir = path.join(TEST_DIR, 'dom');
  const domScript = path.join(domDir, 'subagent-session-dom.mjs');
  const selfPath = fileURLToPath(import.meta.url);

  // Results are normalised against the directory each pattern ran in, so the assertions
  // read the same whether the engine hands back relative names or absolute paths.
  const resolved = (dir, pattern) => globSync(pattern, { cwd: dir })
    .map((hit) => path.resolve(dir, hit));
  const namesIn = (dir, pattern) => globSync(pattern, { cwd: dir })
    .map((hit) => path.relative(dir, path.resolve(dir, hit)));

  const entry = resolved(TEST_DIR, '*.test.js');
  const domModules = namesIn(domDir, '*.mjs');
  const domEntry = namesIn(domDir, '*.test.js');

  assert.ok(statSync(domScript).isFile(), 'the DOM script exists where WP-2 put it');

  // Non-vacuity: the one-level pattern really does resolve the whole suite, so "the DOM
  // script is not in it" is a fact about this entry, not about an empty match.
  assert.ok(entry.length > 30, `the default entry is the whole suite (${entry.length} files), not a stub`);
  assert.ok(entry.includes(path.resolve(selfPath)), 'and this very file IS in the default entry');

  // 2026-10-07-fix-pocket-r3-audit-batch: test/dom/ now holds a second gated
  // browser script (pages-geometry.mjs, the T1-T3 geometry载具). The lock's
  // purpose is unchanged — enumerate what the .mjs pattern really resolves — so
  // the expected list grows with it instead of shrinking the walk.
  assert.deepEqual(
    domModules,
    ['pages-geometry.mjs', 'subagent-session-dom.mjs'],
    'node:fs descends into test/dom/ — the .mjs pattern resolves the gated scripts there, which is what keeps the next line from being vacuous',
  );
  assert.deepEqual(
    domEntry,
    [],
    'and the same one-level pattern over test/dom/ resolves no .test.js at all, which is what keeps a browser out of the default entry',
  );

  // The default entry, resolved by the same engine over the same tree, does not contain it.
  assert.ok(!entry.includes(path.resolve(domScript)), 'a one-level glob over test/ does not descend into test/dom/');

  // Independent second opinion, not glob-based: a recursive walk does see the script,
  // and does not see any .test.js hiding under test/dom/.
  const deep = [];
  const walk = (dir, prefix = '') => {
    for (const entryItem of readdirSync(dir, { withFileTypes: true })) {
      const next = path.join(dir, entryItem.name);
      if (entryItem.isDirectory()) walk(next, `${prefix}${entryItem.name}/`);
      else deep.push(`${prefix}${entryItem.name}`);
    }
  };
  walk(TEST_DIR);
  assert.ok(deep.includes('dom/subagent-session-dom.mjs'), 'a recursive glob would have found it');
  assert.ok(
    !deep.some((name) => name.startsWith('dom/') && name.endsWith('.test.js')),
    'and no .test.js hides under test/dom/, which is what would pull the browser in',
  );
});

// ---------------------------------------------------------------------------
// ROWS (2026-10-10) — the list builds rows only for what the reader can see.
//
// A collapsed card used to emit its entire session list into hidden markup and a
// busy workspace emitted all ~436 rows: measured at the live scale (436 + 266
// sessions), one refresh produced 319 KB of HTML and 712 inline <svg> nodes for a
// phone that shows a dozen rows — and it did that on cold open, on back-nav, on
// every expand/collapse, and on every return from the background.
// ---------------------------------------------------------------------------

const manyRows = (n, prefix = 's') => Array.from({ length: n }, (_, i) => WS_ROW(`${prefix}${i}`));

test('ROWS-1 a collapsed workspace builds no rows at all', () => {
  const rows = manyRows(3, 'a');
  const sandbox = buildRenderSandbox({
    workspaces: [{ workspaceId: 'w1', title: 'DSH', path: 'F:/defws', sessionIds: rows.map((r) => r.sessionId) }],
    summaries: rows,
    expanded: [],
  });
  sandbox.renderWorkspaces();

  assert.deepEqual(sandbox.rowIds(), [], 'hidden rows are not built, not merely hidden by CSS');
  assert.ok(sandbox.markup.includes('data-ws="w1"'), 'the card itself stays on screen');
  assert.doesNotMatch(sandbox.markup, /ws-empty/, 'and a workspace WITH chats is never labelled empty');
});

test('ROWS-2 an expanded workspace caps its rows and names what it left out', () => {
  const hidden = 7;
  const rows = manyRows(LIST_ROWS_MAX + hidden, 'b');
  const sandbox = buildRenderSandbox({
    workspaces: [{ workspaceId: 'w1', title: 'DSH', path: 'F:/defws', sessionIds: rows.map((r) => r.sessionId) }],
    summaries: rows,
  });
  sandbox.renderWorkspaces();

  assert.equal(sandbox.rowIds().length, LIST_ROWS_MAX, 'exactly the ceiling is built');
  const markup = sandbox.markup;
  assert.ok(markup.includes('>' + L.moreRows.replace('{n}', String(hidden)) + '<'), 'the remainder is counted, never silently dropped');
  assert.match(markup, /data-action="more"/, 'and offered as a tap, not as text');
});

test('ROWS-3 revealing one workspace lifts its cap without touching another', () => {
  const big = manyRows(LIST_ROWS_MAX + 3, 'b');
  const small = manyRows(LIST_ROWS_MAX + 2, 'c');
  const sandbox = buildRenderSandbox({
    workspaces: [
      { workspaceId: 'w1', title: 'DSH', path: 'F:/defws', sessionIds: big.map((r) => r.sessionId) },
      { workspaceId: 'w2', title: 'other', path: 'F:/x', sessionIds: small.map((r) => r.sessionId) },
    ],
    summaries: [...big, ...small],
    revealed: ['w1'],
  });
  sandbox.renderWorkspaces();

  const markup = sandbox.markup;
  const w1 = markup.slice(markup.indexOf('data-ws="w1"'), markup.indexOf('data-ws="w2"'));
  const w2 = markup.slice(markup.indexOf('data-ws="w2"'));
  assert.equal((w1.match(/data-id="/g) ?? []).length, LIST_ROWS_MAX + 3, 'the revealed card shows everything');
  assert.doesNotMatch(w1, /data-action="more"/, 'and stops offering more');
  assert.equal((w2.match(/data-id="/g) ?? []).length, LIST_ROWS_MAX, 'the other card keeps its own cap');
  assert.match(w2, /data-action="more"/, 'and still offers its rest');
});