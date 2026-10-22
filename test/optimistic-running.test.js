// The optimistic running mark (2026-10-13). Sending a prompt returns long before
// the host publishes running:true on its session row, and the bridge answers the
// next session.list from a 10-second cache — so leaving the chat right after
// sending showed the row as it was BEFORE the send. The mark re-adds running:true
// for a short trust window, then hands the truth back to the host.
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

// The constants are read back out of the shipped script, never copied here: a
// hand-written copy stops tracking the real source and the档 goes quietly stale.
const TRUST_MS = Number(/SEND_TRUST_MS=(\d+)/.exec(js)[1]);
const HORIZON_MS = Number(/TURN_RUNNING_IDLE_MAX_MS=(\d+)/.exec(js)[1]);

function buildSandbox() {
  // projectSessionRows folds a Bot's older parts before it marks anything, so the
  // fold and its one constant travel with it.
  const bodies = ['visibleSessions', 'markRowRunning', 'applyRunningMarks', 'projectSessionRows', 'mergeBotParts']
    .map((name) => extractFunction(js, name));
  bodies.push(/const MERGE_LEGACY_FOLDER=.*/.exec(js)[0]);
  for (const body of bodies) {
    assert.ok(!body.includes('`') && !body.includes('${'), 'page code is spliced into a Function body');
  }
  return new Function(`
    let now = 1000000;
    const Date = { now: () => now };
    let pendingSendAt = new Map();
    let sessionSummaries = [];
    let activeSession = null;
    const SEND_TRUST_MS = ${TRUST_MS};
    const TURN_RUNNING_IDLE_MAX_MS = ${HORIZON_MS};
    ${bodies.join('\n')}
    return {
      markRowRunning, applyRunningMarks, projectSessionRows,
      advance(ms) { now += ms },
      setActive(id) { activeSession = id },
      setSummaries(rows) { sessionSummaries = rows },
      summaries() { return sessionSummaries },
      pending() { return pendingSendAt.size },
    };
  `)();
}

function row(id, running) {
  return { sessionId: id, running, blank: false, awaitingQuestion: false };
}

test('a send marks its row running while the host still reports the old row', () => {
  const box = buildSandbox();
  box.setSummaries([row('s1', false), row('s2', false)]);
  box.markRowRunning('s1');
  const painted = box.projectSessionRows([row('s1', false), row('s2', false)]);
  assert.equal(painted.find((r) => r.sessionId === 's1').running, true);
  assert.equal(painted.find((r) => r.sessionId === 's2').running, false);
  assert.equal(box.pending(), 1, 'the mark is held for the trust window');
});

test('a session the host has never listed is painted as a running row', () => {
  const box = buildSandbox();
  box.setSummaries([]);
  box.markRowRunning('fresh');
  assert.deepEqual(
    box.summaries().map((r) => [r.sessionId, r.running]),
    [['fresh', true]],
  );
});

test('the host takes the truth back the moment it agrees the row is running', () => {
  const box = buildSandbox();
  box.setSummaries([row('s1', false)]);
  box.markRowRunning('s1');
  box.projectSessionRows([row('s1', true)]);
  assert.equal(box.pending(), 0, 'the mark retires once the host publishes running');
  const later = box.projectSessionRows([row('s1', false)]);
  assert.equal(later[0].running, false, 'and it may not come back for this send');
});

test('past the trust window a not-running host row is believed again', () => {
  const box = buildSandbox();
  box.setSummaries([row('s1', false)]);
  box.markRowRunning('s1');
  box.advance(TRUST_MS + 1);
  assert.equal(box.projectSessionRows([row('s1', false)])[0].running, false);
  assert.ok(TRUST_MS > 10000, 'the window must outlive the bridge 10s session.list cache');
});

test('the chat being read right now is never marked — the live log is the truth there', () => {
  const box = buildSandbox();
  box.setSummaries([row('s1', false)]);
  box.setActive('s1');
  box.markRowRunning('s1');
  assert.equal(box.projectSessionRows([row('s1', false)])[0].running, false);
});

test('a leaked mark cannot outlive the watchdog horizon', () => {
  const box = buildSandbox();
  box.setSummaries([row('s1', false)]);
  box.markRowRunning('s1');
  box.advance(HORIZON_MS + 1);
  assert.equal(box.projectSessionRows([row('s1', false)])[0].running, false);
  assert.equal(box.pending(), 0, 'the backstop drops the mark, so the map cannot grow forever');
});

test('subagent rows are still dropped before any mark is applied', () => {
  const box = buildSandbox();
  box.setSummaries([]);
  box.markRowRunning('child');
  const painted = box.projectSessionRows([{ sessionId: 'child', origin: 'subagent', running: false }]);
  assert.deepEqual(painted, [], 'a subagent session is another session tool, never a list row');
});

// ---- one Bot, one row (2026-10-20, Chief) ----
// A long conversation moves to a fresh Session at a context line (ds-bot
// parts.js). Every part of one Bot carries the same title and the same working
// directory, so before mergeBotParts the phone showed one Bot as two or three
// rows with no way to tell they were one conversation.
function botRow(sessionId, title, folder, updatedAt, origin) {
  return {
    sessionId,
    updatedAt,
    ...(origin ? { origin } : {}),
    projections: { values: { title, workingDirectory: folder } },
  };
}

test('three parts of one Bot in one folder fold to the newest row only', () => {
  const box = buildSandbox();
  const painted = box.projectSessionRows([
    botRow('p1', 'Chief', 'F:\\DSBOT', 100),
    botRow('p2', 'Chief', 'F:\\DSBOT', 200),
    botRow('p3', 'Chief', 'F:\\DSBOT', 300),
  ]);
  assert.deepEqual(painted.map((r) => r.sessionId), ['p3']);
});

test('a part in the pre-move default folder folds into the new workspace part', () => {
  const box = buildSandbox();
  const painted = box.projectSessionRows([
    botRow('old', 'Chief', 'C:\\Users\\someone\\.dsh\\bot\\workspace', 100),
    botRow('new', 'Chief', 'F:\\DSBOT', 300),
  ]);
  assert.deepEqual(painted.map((r) => r.sessionId), ['new']);
});

test('two Bots in one folder stay two rows', () => {
  const box = buildSandbox();
  const painted = box.projectSessionRows([
    botRow('chief', 'Chief', 'F:\\DSBOT', 300),
    botRow('verifier', 'Verifier', 'F:\\DSBOT', 100),
  ]);
  assert.deepEqual(painted.map((r) => r.sessionId), ['chief', 'verifier']);
});

test('same title in unrelated folders stays two rows', () => {
  const box = buildSandbox();
  const painted = box.projectSessionRows([
    botRow('a', 'X', 'F:\\one', 100),
    botRow('b', 'X', 'F:\\two', 300),
  ]);
  assert.deepEqual(painted.map((r) => r.sessionId), ['a', 'b']);
});

test('a newer part at an ancestor folder folds the older deeper part', () => {
  const box = buildSandbox();
  const painted = box.projectSessionRows([
    botRow('deep', 'Chief', 'F:\\DSBOT', 100),
    botRow('shallow', 'Chief', 'F:\\', 300),
  ]);
  assert.deepEqual(painted.map((r) => r.sessionId), ['shallow']);
});

test('a subagent row between two parts does not stop the fold', () => {
  const box = buildSandbox();
  const painted = box.projectSessionRows([
    botRow('p1', 'Chief', 'F:\\DSBOT', 100),
    botRow('s1', 'child', 'F:\\DSBOT', 200, 'subagent'),
    botRow('p2', 'Chief', 'F:\\DSBOT', 300),
  ]);
  assert.deepEqual(painted.map((r) => r.sessionId), ['p2']);
});

test('rows without a title are never folded', () => {
  const box = buildSandbox();
  const painted = box.projectSessionRows([
    { sessionId: 'd1', updatedAt: 100, projections: { values: { workingDirectory: 'F:\\DSBOT' } } },
    { sessionId: 'd2', updatedAt: 300, projections: { values: { workingDirectory: 'F:\\DSBOT' } } },
  ]);
  assert.deepEqual(painted.map((r) => r.sessionId), ['d1', 'd2']);
});
