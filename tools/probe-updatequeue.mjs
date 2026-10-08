// E-stage live probe: session.updateQueue edit + remove against the local bridge.
// Canonical version in dsh-pocket/tools/ (fixed from tmp/20261006-pocket-verify/).
// Title convention: the bridge has no session delete channel, so every probe run leaves one
// undeletable session in the defws workspace. PROBE_TAG is prefixed to the FIRST prompt text so
// the host-derived session title carries the marker — disclose the leftover before probing, then
// clean up manually from the DSH UI by filtering titles on 'pocket-probe'. Live-verified
// 2026-10-06: host title derivation keeps the marker word but STRIPS the '[' ']' from PROBE_TAG
// ('[pocket-probe] 回复ok两个字' -> title 'pocket-probe 回复 ok 连接测试'), so the practical
// filter string is the bare word, not the bracketed tag.
// Token handling: read from disk, used ONLY in the Cookie header, never printed.
import fs from 'node:fs';

const PROBE_TAG = '[pocket-probe]';
const BRIDGE = 'http://127.0.0.1:43127';
const storePath = process.env.LOCALAPPDATA + '/dsh-pocket/mobile-sessions.json';
const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
const now = Date.now();
const entry = (store.sessions || []).find(([, rec]) => rec && typeof rec.token === 'string' && Number(rec.expiresAt) > now);
if (!entry) { console.log('PROBE_SKIP: no unexpired mobile session in store'); process.exit(0); }
const cookie = 'dsh_mobile=' + entry[1].token;

async function rpc(method, payload = {}) {
  const r = await fetch(BRIDGE + '/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ method, payload }),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok || !j || !j.ok) {
    const err = j && j.error ? j.error : ('http ' + r.status);
    throw new Error(`rpc ${method} failed: ${err}`);
  }
  return j.value;
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const log = (...a) => console.log(...a);

try {
  // 0. workspaceId from boot snapshot
  const bootR = await fetch(BRIDGE + '/api/boot?history=false', { headers: { cookie } });
  const boot = await bootR.json();
  const wsItem = boot && boot.ws && Array.isArray(boot.ws.items) ? boot.ws.items[0] : null;
  const workspaceId = wsItem && wsItem.workspaceId;
  log('step0 boot: wsFound=' + Boolean(workspaceId) + (wsItem ? ' wsName=' + JSON.stringify(wsItem.name ?? wsItem.wsName ?? '?') : ''));

  // 1. create probe session
  const created = await rpc('session.create', workspaceId ? { workspaceId } : {});
  const sessionId = created && (created.sessionId || (created.request && created.request.sessionId) || (created.session && created.session.sessionId));
  if (!sessionId) { log('step1 session.create value keys:', Object.keys(created || {}).join(',')); throw new Error('no sessionId in create result'); }
  log('step1 session.create: ok, sessionId=<len ' + String(sessionId).length + '>');

  // 2. prompt turn 1 (PROBE_TAG first so the host-derived session title carries the marker)
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: PROBE_TAG + ' 回复ok两个字' }], clientTimeZone: 'Asia/Shanghai' });
  log('step2 session.prompt #1: accepted (tagged)');

  // 3. poll session.list for running
  let running = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(400);
    const list = await rpc('session.list', {});
    const row = (list.items || []).find((it) => it.sessionId === sessionId);
    if (row && row.running === true) { running = true; break; }
    if (row && row.running === false && i > 12) break; // turn came and went fast
  }
  log('step3 poll session.list: running=' + running);

  // 4. queue a second message while running
  const QUEUE_TEXT = '排队探针文本-editme';
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: QUEUE_TEXT }], clientTimeZone: 'Asia/Shanghai' });
  log('step4 session.prompt #2 (mode queue): accepted');

  // 5. projections: inbox['next-turn'] non-empty, grab itemId
  let itemId = null;
  let queuedText = null;
  for (let i = 0; i < 20; i += 1) {
    const proj = await rpc('session.projections', { sessionId });
    const inbox = proj && proj.values && proj.values.inbox;
    const rows = inbox && Array.isArray(inbox['next-turn']) ? inbox['next-turn'] : [];
    if (rows.length > 0) {
      itemId = rows[0].id;
      queuedText = (rows[0].content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
      break;
    }
    await sleep(400);
  }
  if (!itemId) throw new Error('inbox next-turn never appeared');
  log('step5 projections: inbox next-turn rows=1 itemId=<present> text=' + JSON.stringify(queuedText));

  // 6. updateQueue edit
  const EDITED = '排队探针文本-已编辑';
  const editRes = await rpc('session.updateQueue', { sessionId, itemId, action: { kind: 'edit', content: [{ type: 'text', text: EDITED }] } });
  log('step6 updateQueue edit: ' + JSON.stringify(editRes));

  // 7. verify projections text changed
  let seenEdited = false;
  for (let i = 0; i < 10; i += 1) {
    const proj = await rpc('session.projections', { sessionId });
    const rows = (proj.values && proj.values.inbox && proj.values.inbox['next-turn']) || [];
    const text = rows.length ? (rows[0].content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : null;
    if (text === EDITED) { seenEdited = true; break; }
    await sleep(300);
  }
  log('step7 projections after edit: textChanged=' + seenEdited);

  // 8. updateQueue remove
  const removeRes = await rpc('session.updateQueue', { sessionId, itemId, action: { kind: 'remove' } });
  log('step8 updateQueue remove: ' + JSON.stringify(removeRes));

  // 9. verify inbox emptied
  let emptied = false;
  for (let i = 0; i < 10; i += 1) {
    const proj = await rpc('session.projections', { sessionId });
    const rows = (proj.values && proj.values.inbox && proj.values.inbox['next-turn']) || [];
    const stillThere = rows.some((r2) => r2 && r2.id === itemId);
    if (!stillThere) { emptied = true; break; }
    await sleep(300);
  }
  log('step9 projections after remove: inboxCleared=' + emptied);

  // 10. cancel the turn so the leftover session is at rest
  await rpc('session.cancel', { sessionId });
  log('step10 session.cancel: accepted');

  const pass = editRes && editRes.accepted === true && removeRes && removeRes.accepted === true && seenEdited && emptied;
  log('PROBE_' + (pass ? 'PASS' : 'CHECK') + ': edit.accepted=' + (editRes && editRes.accepted) + ' remove.accepted=' + (removeRes && removeRes.accepted) + ' textChanged=' + seenEdited + ' inboxCleared=' + emptied);
  log('LEFTOVER: probe session cannot be deleted (bridge has no delete channel) — one probe session remains, at rest (turn cancelled). The host-derived title keeps the marker word but strips the brackets: filter titles on pocket-probe in the DSH UI and delete manually.');
} catch (e) {
  log('PROBE_ERROR: ' + e.message);
  process.exitCode = 1;
}
