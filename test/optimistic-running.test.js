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
  const bodies = ['visibleSessions', 'markRowRunning', 'applyRunningMarks', 'projectSessionRows']
    .map((name) => extractFunction(js, name));
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
