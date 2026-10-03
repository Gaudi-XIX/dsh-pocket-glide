// WP-SESSION-FILTER — a subagent session is another session's tool, never a row
// on this phone's list. The page projects every session.list answer through one
// helper, so no load path can put one back; and when the host refuses a direct
// address to such a session the page drops the pinned session instead of
// repeating the host's English sentence with a retry button under it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mobilePageAssets } from '../lib/pages.js';

const SOURCE = readFileSync(fileURLToPath(new URL('../lib/pages.js', import.meta.url)), 'utf8');
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

// page code is spliced into a Function body, so it must stay free of template syntax
const visibleSessions = (() => {
  const body = extractFunction(js, 'visibleSessions');
  assert.ok(!body.includes('`') && !body.includes('${'), 'visibleSessions must be spliceable');
  return new Function(`${body};return visibleSessions;`)();
})();

test('the projection keeps every ordinary row and drops only the subagent ones', () => {
  const rows = [
    { sessionId: 'a' },
    { sessionId: 'b', origin: 'subagent' },
    { sessionId: 'c', origin: 'local' },
    null,
    { sessionId: 'd' },
  ];
  assert.deepEqual(visibleSessions(rows).map((row) => row.sessionId), ['a', 'c', 'd']);
});

test('a missing or malformed answer is an empty list, never a crash', () => {
  assert.deepEqual(visibleSessions(undefined), []);
  assert.deepEqual(visibleSessions(null), []);
  assert.deepEqual(visibleSessions({ items: [] }), []);
});

test('all three session.list loads go through the one projection', () => {
  const sites = [
    ['refreshActiveSessionSummary', 'sessionSummaries=visibleSessions(value.items)'],
    ['openSessionSettings', 'sessionSummaries=visibleSessions(sessions.items)'],
    ['applyBootData', 'sessionSummaries=visibleSessions(sessInput.items)'],
  ];
  for (const [name, needle] of sites) {
    assert.ok(extractFunction(js, name).includes(needle), `${name} must project its answer`);
  }
  assert.ok(
    !/sessionSummaries\s*=\s*(?:value|sessions|sessInput)\.items/.test(js),
    'no load path may assign the raw list over the projected one',
  );
});

test('a locally created session is not listed when the host says it is a subagent', () => {
  const body = extractFunction(js, 'createSessionIn');
  assert.ok(
    body.includes("if(created.origin!=='subagent')sessionSummaries.push("),
    'the local push is origin-guarded like the loads are',
  );
});

test('a busy subagent session falls back to the list before any error is painted', () => {
  const body = extractFunction(js, 'loadHistory');
  const judged = body.indexOf("e.errorCode==='session/agent-busy'");
  const fallback = body.indexOf('void showSessionList();return');
  const painted = body.indexOf("showError('chatError',e)");
  assert.ok(judged >= 0, 'the catch judges by the bridge error code, not by the sentence');
  assert.ok(fallback > judged, 'the busy family clears the pinned session and returns');
  assert.ok(painted > fallback, 'the raw host sentence stays unreachable for this family');
});

test('the page carries no copy of the host sentence for a refused address', () => {
  assert.ok(!js.includes('durable parent address'), 'the page script must not repeat it');
  assert.ok(!SOURCE.includes('durable parent address'), 'and neither may the module');
});
