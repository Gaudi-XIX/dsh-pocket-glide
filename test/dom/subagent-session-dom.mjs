// WP-SESSION-DOM (change 2026-10-03-fix-pocket-session-dom-assertions, WP-2).
//
// A subagent session is another session's tool, never a row on this phone's list — but
// test/subagent-session-dom-assertions.test.js proves that against the page SCRIPT spliced
// into a Function body. This file proves it against the page RENDERED and RUNNING in a real
// browser: a real Edge, a real DOM, the real bootstrap IIFE, the real reconcileBoot().
//
// It is deliberately NOT in the default entry. `node --test test/*.test.js` is a ONE-level
// glob (machine-checked by the R1.4 case in the sibling file), so nothing here can ever be
// pulled into the suite — a browser is not something `npm test` may require.
//
// Gates (all three must be present to run):
//   POCKET_DOM_E2E=1        — opt in at all
//   POCKET_CDP_PORT=9333    — the debugging port (default 9333)
//   POCKET_EDGE=<path>      — Edge/Chrome binary (default: auto-detect the usual paths)
//
// Exit codes:
//   0 — assertions passed, OR no gate (DOM SKIP: — a skip is not a failure)
//   1 — an assertion failed
//   2 — gated in, but the browser or CDP endpoint could not be reached (environment, not
//       a regression; stderr prints a pasteable launch command so the next run just works)
//
// Zero new dependencies: Node ≥22 ships a global WebSocket, and CDP needs nothing else.
//
// Scope of the refusal assertion: the only request this file makes for the child address is a
// bare `fetch('/api/rpc', …)` written by the DRIVER, not the page's own rpc() — it runs
// through no product code, and its answer is matched against this file's own REFUSAL
// constants, so it demonstrates that the FAKE host contract echoes, nothing more. The
// product-level guarantee (a refused host makes the page write nothing) lives in the sibling
// file's R1.1-a, which drives the real loadHistory catch. A green run here is not product
// coverage.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMobilePage } from '../../lib/pages.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SUBAGENT_ID = 'sub1';
const VISIBLE_ID = 's1';
const CHILD_TITLE = 'CHILD-SECRET';
// The host refuses a direct address to a subagent session in its own words. The page must
// never repeat it; the mock refuses exactly this way so the busy branch is exercised.
const REFUSAL = 'durable parent address is not reachable';
const REFUSAL_CODE = 'session/agent-busy';

const log = (...parts) => console.log('[dom]', ...parts);

// ------------------------------------------------------------------ gate

const GATE_ENV = 'POCKET_DOM_E2E';
const PORT_ENV = 'POCKET_CDP_PORT';
const EDGE_ENV = 'POCKET_EDGE';
const CDP_PORT = Number(process.env[PORT_ENV] || 9333);

function gate() {
  const missing = [GATE_ENV, PORT_ENV, EDGE_ENV].filter((key) => !process.env[key]);
  return { on: process.env[GATE_ENV] === '1' && missing.length === 0, missing };
}

// ------------------------------------------------------------------ mock host

// One shape serves both scenarios: the host owns a workspace that lists BOTH sessions and
// points its focus at the subagent. Everything below is asserted from the browser's side.
function hostData({ includeVisible }) {
  const sess = [
    {
      sessionId: SUBAGENT_ID,
      origin: 'subagent',
      awaitingQuestion: true,
      running: true,
      updatedAt: Date.now() - 1_000,
      projections: { values: { title: CHILD_TITLE } },
    },
  ];
  if (includeVisible) {
    sess.push({
      sessionId: VISIBLE_ID,
      running: false,
      updatedAt: Date.now() - 600_000,
      projections: { values: { title: 'main chat' } },
    });
  }
  return {
    ws: {
      items: [
        {
          workspaceId: 'w1',
          title: 'DSH',
          path: REPO_ROOT,
          sessionIds: includeVisible ? [SUBAGENT_ID, VISIBLE_ID] : [SUBAGENT_ID],
        },
      ],
    },
    sess: { items: sess },
    // The focus is the whole point: the host says "look at the child session".
    focus: { sessionId: SUBAGENT_ID, history: { events: [], hasMore: false } },
  };
}

function historyFor(sessionId) {
  const now = Date.now();
  const record = (seq, text) => ({
    seq,
    event: {
      type: 'user/message',
      data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } },
    },
  });
  return {
    events: [
      record(1, `hello from ${sessionId}`),
      {
        seq: 2,
        event: {
          type: 'assistant/message',
          data: { step: 1, turn: 't1', message: { content: [{ type: 'text', text: `answer in ${sessionId}` }] } },
        },
      },
      { seq: 3, event: { type: 'turn/end', data: { turn: 't1', reason: { kind: 'completed' } } } },
    ],
    hasMore: false,
    projections: { title: `chat ${sessionId}` },
    _now: now,
  };
}

function startHost({ includeVisible }) {
  const state = { historySeq: [], rpcSeq: [], bootRequests: 0, snapshotSent: new Set() };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (url.pathname === '/') {
      // The initial boot is inlined, and reconcileBoot stays off for a document served
      // from the network (2026-10-23), so this route carries the whole scenario.
      return send(200, renderMobilePage({ locale: 'zh', boot: JSON.stringify(hostData({ includeVisible })), initialChat: false }), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/sw.js') return send(200, 'self.addEventListener("fetch",()=>{})', 'text/javascript; charset=utf-8');
    if (url.pathname === '/api/boot') {
      state.bootRequests += 1;
      return send(200, hostData({ includeVisible }));
    }
    if (url.pathname === '/api/status') {
      return send(200, { settings: null, tunnelExpiresAt: undefined, device: null });
    }
    if (url.pathname === '/api/session/stream') {
      // Hold the stream open and deliver one snapshot, so the chat paints like a live one.
      const sessionId = url.searchParams.get('sessionId') || '';
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': open\n\n');
      if (!state.snapshotSent.has(sessionId)) {
        state.snapshotSent.add(sessionId);
        const frame = { records: historyFor(sessionId).events, projections: { title: `chat ${sessionId}` }, hasMore: false };
        res.write(`event: snapshot\ndata: ${JSON.stringify(frame)}\n\n`);
        res.write(`event: status\ndata: ${JSON.stringify({ settings: null })}\n\n`);
      }
      return undefined;
    }
    if (url.pathname === '/api/rpc') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* the page always sends json */ }
        const method = parsed.method;
        const payload = parsed.payload || {};
        state.rpcSeq.push({ method, sessionId: payload.sessionId ?? null });
        if (method === 'session.history') {
          const sessionId = payload.sessionId;
          state.historySeq.push(sessionId);
          if (sessionId === SUBAGENT_ID) {
            // The refusal this whole card is about.
            return send(200, { ok: false, error: REFUSAL, errorCode: REFUSAL_CODE });
          }
          return send(200, { ok: true, value: historyFor(sessionId) });
        }
        if (method === 'session.list') return send(200, { ok: true, value: hostData({ includeVisible }).sess });
        if (method === 'workspace.list') return send(200, { ok: true, value: hostData({ includeVisible }).ws });
        if (method === 'interaction.pending') return send(200, { ok: true, value: null });
        if (method === 'settings.describe') return send(200, { ok: true, value: null });
        return send(200, { ok: true, value: null });
      });
      return undefined;
    }
    return send(404, { ok: false, error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// ------------------------------------------------------------------ browser

function findBrowser() {
  if (process.env[EDGE_ENV]) return existsSync(process.env[EDGE_ENV]) ? process.env[EDGE_ENV] : null;
  const roots = [
    process.env['PROGRAMFILES(X86)'],
    process.env.PROGRAMFILES,
    process.env.LOCALAPPDATA,
  ].filter(Boolean);
  const suffixes = [
    'Microsoft/Edge/Application/msedge.exe',
    'Microsoft/Edge/Application/msedge.exe',
    'Google/Chrome/Application/chrome.exe',
  ];
  for (const root of roots) for (const suffix of suffixes) {
    const candidate = path.join(root, ...suffix.split('/'));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitForCdp(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch { /* not up yet */ }
    await wait(200);
  }
  return null;
}

// Minimal CDP client: a fresh tab (PUT /json/new?about:blank, then navigate — PUT creates
// the target; Page.navigate moves it) over Node's global WebSocket.
async function withPage(port, origin, fn) {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  if (!created.ok) throw new Error(`CDP /json/new answered ${created.status}`);
  const target = await created.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    if (frame.id && pending.has(frame.id)) {
      const { resolve, reject } = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) reject(new Error(frame.error.message));
      else resolve(frame.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = (nextId += 1);
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `${origin}/` });
    // The page boots asynchronously; wait for its own readiness flag rather than a timer.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const probe = await send('Runtime.evaluate', { expression: 'window.__pocketAppReady===true', returnByValue: true });
      if (probe?.result?.value === true) break;
      await wait(150);
    }
    return await fn({
      evaluate: async (expression) => {
        const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (out?.exceptionDetails) throw new Error(out.exceptionDetails.text || 'page threw');
        return out?.result?.value;
      },
    });
  } finally {
    try { socket.close(); } catch { /* already gone */ }
    try { await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`); } catch { /* best effort */ }
  }
}

// The six assertions, read from the rendered DOM.
const SNAPSHOT = `(() => ({
  rowIds: [...document.querySelectorAll('#workspaces [data-id]')].map((n) => n.getAttribute('data-id')),
  sessionsActive: document.getElementById('sessionsView').classList.contains('active'),
  chatOpen: document.body.classList.contains('chat-open'),
  loadingFailed: document.querySelectorAll('#messages .loading-failed').length,
  reloadButtons: document.querySelectorAll('#messages [data-reload]').length,
  chatError: (document.getElementById('chatError')?.textContent || '').trim(),
  bodyText: document.body.innerText,
  messagesText: (document.getElementById('messages')?.innerText || '').trim(),
  workspaceHtml: document.getElementById('workspaces')?.innerHTML || '',
}))()`;

// ------------------------------------------------------------------ scenarios

function judge(snapshot, state, label, failures) {
  const no = (condition, message) => { if (!condition) failures.push(`${label}: ${message}`); };
  no(!snapshot.rowIds.includes(SUBAGENT_ID), `the subagent id became a row: ${JSON.stringify(snapshot.rowIds)}`);
  no(!snapshot.workspaceHtml.includes(CHILD_TITLE), 'the child title leaked into the markup');
  no(snapshot.loadingFailed === 0, `a loading-failed row appeared (${snapshot.loadingFailed})`);
  no(snapshot.reloadButtons === 0, `a retry button appeared (${snapshot.reloadButtons})`);
  no(snapshot.chatError === '', `an error copy was painted: ${JSON.stringify(snapshot.chatError)}`);
  no(!snapshot.bodyText.includes(REFUSAL), 'the host refusal sentence reached the screen');
  no(!snapshot.bodyText.includes(CHILD_TITLE), 'the child title reached the screen');
  // The child must not appear in the transcript either, even when some other session is open.
  no(!snapshot.messagesText.includes(SUBAGENT_ID), `the child id is on screen: ${JSON.stringify(snapshot.messagesText)}`);
  return snapshot;
}

async function scenarioChat(host, port, failures) {
  const state = host.state;
  const result = await withPage(port, host.origin, async (page) => {
    const first = await page.evaluate(SNAPSHOT);
    await wait(6500);
    const second = await page.evaluate(SNAPSHOT);

    // Non-hollow anchor (see handoff): the DRIVER asks the mock host directly for the child
    // address, so the sequence provably contains it and the mock's refusal branch is
    // exercised. Read carefully what that proves: this is a bare `fetch('/api/rpc', …)` typed
    // here by the test — it calls NO product code (no rpc / loadHistory / openSession /
    // __pocket lies on this path), and the answer is compared against this file's OWN
    // module-level REFUSAL constants. So it verifies an ECHO of the fake host contract, and
    // only that: if the mock's refusal branch were wrong, this probe would reproduce the wrong
    // branch faithfully. The product-level guarantee — a host refusal makes the page write
    // nothing — is carried by R1.1-a in test/subagent-session-dom-assertions.test.js, which
    // runs the page's real loadHistory and its real catch (deleting the busy branch turns
    // that case red). Do not read a green run here as product coverage.
    const refusal = await page.evaluate(
      `fetch('/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'session.history',payload:{sessionId:'${SUBAGENT_ID}'}})}).then((r)=>r.json())`,
    );
    const after = await page.evaluate(SNAPSHOT);
    return { first, second, after, refusal };
  });

  judge(result.first, state, 'chat', failures);
  judge(result.second, state, 'chat(t+9s)', failures);
  judge(result.after, state, 'chat(after probe)', failures);

  const stable = ['rowIds', 'sessionsActive', 'chatOpen', 'loadingFailed', 'reloadButtons', 'chatError']
    .every((key) => JSON.stringify(result.first[key]) === JSON.stringify(result.second[key]));
  if (!stable) failures.push('chat: the two snapshots disagree — a late paint still moved the DOM');

  // Non-vacuity, part one: the scenario really booted a real chat. The live snapshot
  // normally wins the race inside openSession (that is the 900ms fallback working), so the
  // transcript is painted from SSE and NO session.history is issued for s1 at all — a fact
  // that is itself worth asserting, because it means the page never needed the history RPC.
  if (!result.first.messagesText || !result.first.messagesText.includes(VISIBLE_ID)) {
    failures.push(`chat: no transcript painted for ${VISIBLE_ID} — the scenario never ran: ${JSON.stringify(result.first.messagesText)}`);
  }
  if (!result.first.chatOpen) failures.push('chat: the visible session did not open — the bootstrap did not run');
  // 2026-10-23: reconcileBoot is gated on the document coming out of the shell cache,
  // and this page is served straight from the network — so the inline payload is the
  // only boot the page ever gets. Zero requests here is the proof that the ghost path
  // survives without the second 1.09 MB download.
  if (state.bootRequests !== 0) failures.push(`chat: reconcileBoot asked /api/boot ${state.bootRequests} time(s) — the inline payload already carried this data`);
  if (state.historySeq.some((id) => id !== SUBAGENT_ID)) {
    failures.push(`chat: the page asked the host for a session other than the probe: ${JSON.stringify(state.historySeq)}`);
  }

  // Non-vacuity, part two: the child address is in the sequence AND it was refused.
  if (!state.historySeq.includes(SUBAGENT_ID)) {
    failures.push(`chat: the child address never reached the host: ${JSON.stringify(state.historySeq)}`);
  }
  const refusal = result.refusal || {};
  if (refusal.ok !== false || refusal.errorCode !== REFUSAL_CODE) {
    failures.push(`chat: the child address was not refused the way the host refuses it: ${JSON.stringify(refusal)}`);
  }

  return {
    scenario: 'chat',
    rowIds: result.first.rowIds,
    sessionsActive: result.first.sessionsActive,
    chatOpen: result.first.chatOpen,
    loadingFailed: result.first.loadingFailed,
    reloadButtons: result.first.reloadButtons,
    chatError: result.first.chatError,
    chatMessages: result.first.messagesText,
    historyRequestsForVisible: state.historySeq.filter((id) => id === VISIBLE_ID).length,
    secondIdentical: stable,
    bootRequests: state.bootRequests,
    historySeq: state.historySeq,
    refusal: { ok: refusal.ok, errorCode: refusal.errorCode, error: refusal.error },
  };
}

async function scenarioList(host, port, failures) {
  const state = host.state;
  const result = await withPage(port, host.origin, async (page) => {
    const snapshot = await page.evaluate(SNAPSHOT);
    return snapshot;
  });

  // The list scenario asks the opposite of the chat one: with no visible session at all,
  // the workspace must show its empty hint, not a ghost row for the child. The task count
  // is retired by user decision (2026-10-10): its absence is what is asserted now.
  if (result.rowIds.length !== 0) failures.push(`list: rows appeared with no visible session: ${JSON.stringify(result.rowIds)}`);
  if (!result.workspaceHtml.includes('class="ws-empty"')) failures.push('list: the empty hint is missing');
  if (result.workspaceHtml.includes('ws-count')) failures.push('list: a task count was painted; the field is retired');
  if (result.workspaceHtml.includes(SUBAGENT_ID)) failures.push('list: the child id is still in the markup');
  if (!result.sessionsActive) failures.push('list: the list view is not active');
  if (state.historySeq.includes(SUBAGENT_ID)) failures.push(`list: a child history request was made: ${JSON.stringify(state.historySeq)}`);

  return {
    scenario: 'list',
    rowIds: result.rowIds,
    sessionsActive: result.sessionsActive,
    emptyHint: result.workspaceHtml.includes('class="ws-empty"'),
    noCount: !result.workspaceHtml.includes('ws-count'),
    historySeq: state.historySeq,
  };
}

// ------------------------------------------------------------------ main

// A judge that cannot fail is worse than no judge. Before any browser work, run the exact
// assertion block against a snapshot of what a REGRESSION looks like — a ghost row, a
// leaked title, a painted failure row, the host's refusal on screen, the child address in
// the transcript — and require that every one of those is caught. If a future edit weakens
// judge(), this goes red even though the browser run would still be green.
function selfCheck() {
  const ghost = {
    rowIds: [SUBAGENT_ID, VISIBLE_ID],
    sessionsActive: false,
    chatOpen: true,
    loadingFailed: 1,
    reloadButtons: 1,
    chatError: REFUSAL,
    bodyText: `${CHILD_TITLE} ${REFUSAL}`,
    messagesText: `hello from ${SUBAGENT_ID}`,
    workspaceHtml: `<button data-id="${SUBAGENT_ID}"><strong>${CHILD_TITLE}</strong></button>`,
  };
  const caught = [];
  judge(ghost, { historySeq: [SUBAGENT_ID] }, 'selfcheck', caught);
  const expected = 8; // every assertion judge() makes
  if (caught.length !== expected) {
    throw new Error(`selfcheck: judge() caught ${caught.length}/${expected} regressions: ${JSON.stringify(caught)}`);
  }
  log(`selfcheck: judge() catches all ${expected} regression shapes (a hollow judge would not)`);
}

async function main() {
  const { on, missing } = gate();
  if (!on) {
    console.log(
      `DOM SKIP: set ${GATE_ENV}=1, ${PORT_ENV}=<port> and ${EDGE_ENV}=<browser path> to run the real-browser assertions`
      + (missing.length ? ` (missing: ${missing.join(', ')})` : ' (set but not enabled)'),
    );
    return 0;
  }

  const browser = findBrowser();
  const launchCommand = `"${browser || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'}" --headless=new --remote-debugging-port=${CDP_PORT} --user-data-dir="%TEMP%\\pocket-dom-profile" --no-first-run --no-default-browser-check about:blank`;
  try {
    selfCheck();
  } catch (error) {
    process.stderr.write(`DOM ERROR: ${error.message}\n`);
    return 1;
  }
  if (!browser) {
    process.stderr.write(`DOM ERROR: no browser found. Set ${EDGE_ENV} to an Edge or Chrome binary.\n`);
    process.stderr.write(`DOM HINT: start one by hand, then re-run with ${PORT_ENV}=${CDP_PORT}:\n  ${launchCommand}\n`);
    return 2;
  }

  const profile = mkdtempSync(path.join(tmpdir(), 'pocket-dom-'));
  const child = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  const failures = [];
  const report = { browser, cdpPort: CDP_PORT, scenarios: [] };
  try {
    const version = await waitForCdp(CDP_PORT);
    if (!version) {
      process.stderr.write(`DOM ERROR: no CDP endpoint on 127.0.0.1:${CDP_PORT} after 15s.\n`);
      process.stderr.write(`DOM HINT: start one by hand, then re-run:\n  ${launchCommand}\n`);
      if (stderr.trim()) process.stderr.write(`DOM NOTE: browser stderr:\n${stderr.trim()}\n`);
      return 2;
    }
    log('browser', version.Browser || browser, 'cdp', version.webSocketDebuggerUrl ? 'up' : 'up');

    // The chat scenario needs a visible session to open; the list one needs none.
    const chatHost = await startHost({ includeVisible: true });
    try {
      report.scenarios.push(await scenarioChat(chatHost, CDP_PORT, failures));
    } finally {
      await chatHost.close();
    }
    const listHost = await startHost({ includeVisible: false });
    try {
      report.scenarios.push(await scenarioList(listHost, CDP_PORT, failures));
    } finally {
      await listHost.close();
    }
  } finally {
    // Wait for the process to finish before touching its profile, or the delete races it.
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill();
      setTimeout(resolve, 4000);
    });
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) {
    console.log('DOM FAIL:');
    for (const line of failures) console.log(`  - ${line}`);
    return 1;
  }
  console.log('DOM PASS: the child session stayed out of the phone UI');
  return 0;
}

process.exitCode = await main();