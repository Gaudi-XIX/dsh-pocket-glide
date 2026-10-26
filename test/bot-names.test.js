// Which Bot owns a Session (2026-10-23). ds-bot keys every part of a Bot's long
// conversation in its own roster; the bridge reads that roster and stamps the
// Bot's name on the Host session row, so the phone can fold the parts by
// identity instead of by working directory. These cases pin the parse, and the
// last one pins the promise that an unknown shape costs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botSessionNamesFromState } from '../lib/projections.js';
import { LanMobileBridge, stampBotNames } from '../lib/bridge.js';
import { BOT_NAMES_CACHE_MS } from '../lib/constants.js';

const roster = (name) =>
  JSON.stringify({ bots: { a: { name, segments: [{ sessionId: 's1' }] } } });
const shell = (botStatePath) => {
  const bridge = Object.create(LanMobileBridge.prototype);
  bridge.options = { botStatePath };
  return bridge;
};

test('every part of every Bot carries its Bot name', () => {
  const names = botSessionNamesFromState({
    bots: {
      a: { name: 'Chief', segments: [{ sessionId: 's1' }, { sessionId: 's2' }] },
      b: { name: 'Verifier', segments: [{ sessionId: 's3' }] },
    },
  });
  assert.deepEqual([...names.entries()], [
    ['s1', 'Chief'],
    ['s2', 'Chief'],
    ['s3', 'Verifier'],
  ]);
});

test('a live part named outside the segment list is still stamped', () => {
  const names = botSessionNamesFromState({
    bots: { a: { name: 'Scout', sessionId: 'live', segments: [] } },
  });
  assert.equal(names.get('live'), 'Scout');
});

test('a Bot without a name or a segment is skipped, not fatal', () => {
  const names = botSessionNamesFromState({
    bots: {
      noname: { segments: [{ sessionId: 's1' }] },
      segments: 'not-an-array',
      ok: { name: 'Magpie-Watch', segments: [{}, { sessionId: 42 }, { sessionId: 's9' }] },
    },
  });
  assert.deepEqual([...names.keys()], ['s9']);
});

test('an unknown or empty state yields no names, so nothing is stamped', () => {
  for (const state of [null, undefined, {}, { bots: null }, { bots: [] }, 'x', 7]) {
    assert.equal(botSessionNamesFromState(state).size, 0);
  }
});

test('the roster is read once per window, then re-read when it changes on disk', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pocket-botnames-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  await writeFile(path, roster('Chief'));
  const bridge = shell(path);
  assert.equal((await bridge.botNamesForSessions()).get('s1'), 'Chief');
  // A write inside the window is deliberately not seen: the map is reused as
  // is, so a rename takes at most five seconds to reach the phone.
  await writeFile(path, roster('Renamed'));
  assert.equal((await bridge.botNamesForSessions()).get('s1'), 'Chief');
  // Past the window it stats again, and a newer mtime makes it re-parse.
  const ahead = new Date(Date.now() + 1000);
  await utimes(path, ahead, ahead);
  bridge._botNamesCache.at = Date.now() - (BOT_NAMES_CACHE_MS + 1);
  assert.equal((await bridge.botNamesForSessions()).get('s1'), 'Renamed');
});

test('a roster that cannot be read stamps nothing and is remembered for the window', async () => {
  const bridge = shell(join(tmpdir(), 'pocket-no-such-roster-here.json'));
  assert.equal((await bridge.botNamesForSessions()).size, 0);
  // The failure is cached like a success: a missing roster must not turn every
  // list refresh into a fresh failed stat.
  assert.ok(bridge._botNamesCache.at > 0);
  assert.equal(bridge._botNamesCache.mtimeMs, 0);
});

test('stamping answers a new array and leaves the cached rows untouched', () => {
  const rows = [{ sessionId: 's1', projections: { values: { title: 'x' } } }, { sessionId: 's2' }];
  const snapshot = JSON.stringify(rows);
  const out = stampBotNames(rows, new Map([['s1', 'Chief']]));
  assert.notEqual(out, rows, 'the list out of the bridge cache must not be written into');
  assert.equal(JSON.stringify(rows), snapshot);
  assert.equal(out[0].projections.values.botName, 'Chief');
  assert.equal(out[0].projections.values.title, 'x');
  assert.equal(out[1].projections, undefined);
  assert.equal(stampBotNames(rows, new Map()), rows, 'an empty map hands the rows back as is');
});

test('the boot payload stamps Bot names too, not only session.list', () => {
  const source = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8');
  const start = source.indexOf('async buildMobileBoot(');
  const end = source.indexOf('async collectSessionTails(');
  assert.ok(start > 0 && end > start);
  const body = source.slice(start, end);
  // An unstamped boot paints a Bot's parts as two rows and only folds them away
  // one leg later — the reader sees "two rows → one row" on every cold open.
  assert.match(body, /stampBotNames\(\s*rawItems/);
});
