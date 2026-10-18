// R3 audit batch (change 2026-10-07-fix-pocket-r3-audit-batch) — GEOMETRY layer.
//
// Character-layer tests prove strings exist; they cannot prove that a banner
// stops overlapping the composer, that a textarea actually wins a specificity
// fight, or that a grid row stops widening its track. This file proves exactly
// that against the page RENDERED and RUNNING in a real browser at the phone
// viewport (390x844), following test/dom/subagent-session-dom.mjs precedent:
// a real Edge/Chrome, a real DOM, the real bootstrap IIFE, zero new dependencies
// (Node >= 22 ships WebSocket; CDP needs nothing else).
//
// Deliberately NOT in the default entry: `node --test test/*.test.js` is a
// ONE-level glob, so nothing here can ever be pulled into `npm test` — a
// browser is not something `npm test` may require.
//
// Gates (all three, same contract as the precedent):
//   POCKET_DOM_E2E=1        — opt in at all
//   POCKET_CDP_PORT=9333    — the debugging port (default 9333)
//   POCKET_EDGE=<path>      — Edge/Chrome binary (default: auto-detect)
//
// Exit codes: 0 pass-or-gated-skip; 1 assertion failed; 2 environment (browser
// or CDP unreachable — stderr prints a pasteable launch command).
//
// Scenarios (tasks T1-T3, red-first: all three were red on the d51a8c1 baseline
// and flip green only when the matching fix lands):
//   A  #chatError banner vs composer: failure SSE frame -> product showError ->
//      banner must not intersect .composer-inner, must self-hit at its center,
//      must sit inside the viewport; question-open regression (composer hidden)
//      keeps the banner visible.
//   B  .queue-edit-box computed style in the real edit state (clicked via the
//      row's own edit button): min-height 64 / font 13 / border 1 / opaque bg /
//      resize vertical, content unclipped; main #prompt textarea zero drift.
//   C  .queue-list does not scroll horizontally on long queued text: scrollWidth
//      <= clientWidth, the × handle fully inside, ellipsis engaged, dock band
//      regression (dock sits above the composer with its 8px gap).
//   H  (2026-10-19-fix BUG-5) dock passthrough: with a live queue dock (and with the
//      todo dock expanded) no dock CHROME point may win a hit-test — the band above the
//      input row must pass touches down to #messages — while the row × handles, the
//      inline edit box and the todo header keep their own hit areas.
//   D  (2026-10-07-fix-pocket-r2-pages-batch, W2) todo dock vs the failure
//      banner: with a real todos projection up (todo-open, --todo-h > 0) the
//      banner must clear #todoDock by area 0, the dock header must self-hit at
//      its center, the banner stays viewport-bound and clear of the composer;
//      the todo-expanded state re-runs the same set.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMobilePage } from '../../lib/pages.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SESSION_ID = 's1';
const LONG_TEXT = '这是一条用于溢出目验的长排队消息第一行\n第二行续写排队内容继续加长加长加长';

const GATE_ENV = 'POCKET_DOM_E2E';
const PORT_ENV = 'POCKET_CDP_PORT';
const EDGE_ENV = 'POCKET_EDGE';
const CDP_PORT = Number(process.env[PORT_ENV] || 9333);

const log = (...parts) => console.log('[geometry]', ...parts);
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function gate() {
  const missing = [GATE_ENV, PORT_ENV, EDGE_ENV].filter((key) => !process.env[key]);
  return { on: process.env[GATE_ENV] === '1' && missing.length === 0, missing };
}

// ------------------------------------------------------------------ mock host

function bootData() {
  return {
    ws: { items: [{ workspaceId: 'w1', title: 'DSH', path: REPO_ROOT, sessionIds: [SESSION_ID] }] },
    sess: { items: [{ sessionId: SESSION_ID, running: true, updatedAt: Date.now() - 1000, projections: { values: { title: '渲染几何目验' } } }] },
    focus: { sessionId: SESSION_ID, history: { events: [], hasMore: false } },
  };
}

function projections(todos = null) {
  const now = Date.now();
  return {
    asOfSeq: 10,
    values: {
      goal: { goal: { objective: '几何目验目标（假数据）', phase: 'active', maxGoalRounds: 64, id: 'g1', revision: 1 }, roundsStarted: 3, createdAt: now, updatedAt: now },
      inbox: { 'next-turn': [
        { id: 'q1', content: [{ type: 'text', text: LONG_TEXT }] },
        { id: 'q2', content: [{ type: 'image', mediaType: 'image/png' }, { type: 'file', name: 'a.zip' }] },
      ] },
      todos,
      modelSelection: null,
    },
  };
}

function historyFor(todos = null, longHistory = false) {
  // The real record shape puts seq INSIDE the event envelope (eventSeq reads
  // entry.event.seq); a top-level seq reads as seq-less and defeats mergeEntries
  // dedupe — the double-painted rows this mock once produced (scene G users x2).
  const record = (seq, text) => ({
    event: { seq, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } },
  });
  const turnEnd = (seq, turn) => ({ event: { seq, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } } });
  const replyFor = (seq, turn, text) => ({ event: { seq, type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } } });
  if (!longHistory) {
    return {
      events: [
        record(1, '起一条对话用于几何目验'),
        replyFor(2, 't1', '几何目验用的回复。'),
        turnEnd(3, 't1'),
      ],
      hasMore: false,
      projections: projections(todos),
    };
  }
  // Scene G (2026-10-07-feat-pocket-smart-scroll-anchors): a transcript long
  // enough to scroll — twelve turns whose replies each run a few screens.
  const events = [];
  let seq = 0;
  const reply = '这是长回复的一行，用来把视口撑出好几屏的距离。'.repeat(80);
  for (let turn = 1; turn <= 12; turn++) {
    events.push(record(++seq, `第 ${turn} 轮的提问，用于锚点目验`));
    events.push(replyFor(++seq, `t${turn}`, reply));
    events.push(turnEnd(++seq, `t${turn}`));
  }
  return { events, hasMore: false, projections: projections(todos) };
}

function startHost({ pendingQuestion = null, todos = null, longHistory = false } = {}) {
  let streamRes = null;
  let nextSeq = 5000;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.method === 'POST' && url.pathname === '/emit-failure') {
      if (!streamRes) return send(503, { ok: false });
      streamRes.write('event: failure\n');
      streamRes.write(`data: ${JSON.stringify({ reason: 'transport' })}\n\n`);
      return send(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/emit-chunk') {
      // Scene G: one assistant/chunk frame appended to the live stream — the
      // fuel the follow machine runs on.
      if (!streamRes) return send(503, { ok: false });
      const frame = {
        event: { seq: nextSeq++, type: 'assistant/chunk', data: { turn: 't-new', step: 1, chunk: { type: 'text-delta', index: 0, text: '流式追加的一行内容，用来观察跟滚。'.repeat(6) } } },
      };
      streamRes.write(`event: event\ndata: ${JSON.stringify(frame)}\n\n`);
      return send(200, { ok: true });
    }
    if (url.pathname === '/') {
      return send(200, renderMobilePage({ locale: 'zh', boot: JSON.stringify(bootData()), initialChat: false }), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/sw.js') return send(200, 'self.addEventListener("fetch",()=>{})', 'text/javascript; charset=utf-8');
    if (url.pathname === '/api/status') return send(200, { settings: null, tunnelExpiresAt: undefined, device: null });
    if (url.pathname === '/api/session/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': open\n\n');
      const frame = { records: historyFor(todos, longHistory).events, projections: projections(todos), hasMore: false };
      res.write(`event: snapshot\ndata: ${JSON.stringify(frame)}\n\n`);
      res.write(`event: status\ndata: ${JSON.stringify({ settings: null, agentRunning: true, at: Date.now() })}\n\n`);
      streamRes = res;
      const keepalive = setInterval(() => {
        try { streamRes && streamRes.write(`event: status\ndata: ${JSON.stringify({ agentRunning: true, at: Date.now() })}\n\n`); } catch { /* dropped */ }
      }, 1200);
      req.on('close', () => { clearInterval(keepalive); streamRes = null; });
      return undefined;
    }
    if (url.pathname === '/api/rpc') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* page always sends json */ }
        const method = parsed.method;
        let value;
        if (method === 'session.history') value = historyFor(todos, longHistory);
        else if (method === 'interaction.pending') value = pendingQuestion;
        else if (method === 'session.projections') value = projections(todos);
        else if (method === 'session.list') value = bootData().sess;
        else if (method === 'workspace.list') value = bootData().ws;
        else if (method === 'settings.describe') value = { namespaces: [] };
        else if (method === 'session.models') value = { default: { provider: '', model: '' }, routableProviders: [], groups: [], failures: [] };
        else if (method === 'agentPreset.list') value = { presets: [] };
        else value = null;
        send(200, { ok: true, value });
      });
      return undefined;
    }
    return send(404, { ok: false, error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

// -------------------------------------------------------------------- browser

function findBrowser() {
  if (process.env[EDGE_ENV]) return existsSync(process.env[EDGE_ENV]) ? process.env[EDGE_ENV] : null;
  const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
  const suffixes = ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe'];
  for (const root of roots) for (const suffix of suffixes) {
    const candidate = path.join(root, ...suffix.split('/'));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function waitForCdp(port, timeoutMs = 15000) {
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
    // The phone viewport is the claim under test: 390x844, mobile.
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Page.navigate', { url: `${origin}/` });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const probe = await send('Runtime.evaluate', { expression: 'window.__pocketAppReady===true', returnByValue: true });
      if (probe?.result?.value === true) break;
      await wait(150);
    }
    // 2026-10-19: the page no longer jumps into a conversation from the boot payload
    // (the `initialChat` first-byte jump was retired in 653f26c「冷开一律停主页」).
    // Every scenario below measures the CHAT view, so the harness walks in the way a
    // reader does — click the canned session row and wait for chat-open. Without this
    // the page stays on the workspace list and all assertions fail against a blank view.
    const entered = await send('Runtime.evaluate', {
      expression: `(() => { const row = document.querySelector('button[data-action="open"]'); if (!row) return 'no-row'; row.click(); return 'clicked' })()`,
      returnByValue: true,
    });
    if (entered?.result?.value !== 'clicked') throw new Error(`geometry harness: no session row to open (${entered?.result?.value})`);
    const chatDeadline = Date.now() + 15000;
    let chatOpen = false;
    while (Date.now() < chatDeadline) {
      const probe = await send('Runtime.evaluate', { expression: `document.body.classList.contains('chat-open')`, returnByValue: true });
      if (probe?.result?.value === true) { chatOpen = true; break; }
      await wait(150);
    }
    if (!chatOpen) throw new Error('geometry harness: the chat view never opened after clicking the session row');
    return await fn({
      send,
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

// ----------------------------------------------------------------- scenarios

const bannerSnapshot = `(() => {
  const banner = document.getElementById('chatError')
  const ci = document.querySelector('.composer-inner')
  if (!banner || !ci) return { missing: true }
  const br = banner.getBoundingClientRect()
  const cr = ci.getBoundingClientRect()
  const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2)
  const w = window.innerWidth, h = window.innerHeight
  return {
    missing: false,
    text: (banner.textContent || '').trim(),
    banner: { top: br.top, left: br.left, right: br.right, bottom: br.bottom, width: br.width, height: br.height },
    composer: { top: cr.top, left: cr.left, right: cr.right, bottom: cr.bottom },
    overlap: !(br.right <= cr.left || cr.right <= br.left || br.bottom <= cr.top || cr.bottom <= br.top),
    selfHit: !!hit && (hit === banner || banner.contains(hit)),
    hitDesc: hit ? hit.tagName + (hit.className ? '.' + hit.className : '') : 'null',
    inViewport: br.top >= 0 && br.left >= -1 && br.right <= w + 1 && br.bottom <= h + 1 && br.width > 0 && br.height > 0,
    viewport: { w, h },
    questionOpen: document.body.classList.contains('question-open'),
    composerHidden: document.getElementById('composer').hidden,
  }
})()`

const queueSnapshot = `(() => {
  const list = document.querySelector('.queue-list')
  const item = document.querySelector('.queue-item')
  const text = document.querySelector('.queue-text')
  const remove = document.querySelector('[data-queue-action="remove"]')
  const dock = document.getElementById('queueDock')
  const ci = document.querySelector('.composer-inner')
  if (!list || !item || !text || !remove || !dock || !ci) return { missing: true, rows: document.querySelectorAll('.queue-item').length }
  const lr = list.getBoundingClientRect()
  const rr = remove.getBoundingClientRect()
  const dr = dock.getBoundingClientRect()
  const cr = ci.getBoundingClientRect()
  return {
    missing: false,
    rows: document.querySelectorAll('.queue-item').length,
    scrollWidth: list.scrollWidth,
    clientWidth: list.clientWidth,
    noHScroll: list.scrollWidth <= list.clientWidth,
    removeInside: rr.right <= lr.right + 0.5,
    ellipsis: getComputedStyle(text).textOverflow,
    dockGap: cr.top - dr.bottom,
    dockVisible: dr.width > 0 && dr.height > 0,
  }
})()`

const editSnapshot = `(() => {
  const editBtn = document.querySelector('[data-queue-action="edit"]')
  if (!editBtn) return { missing: true, reason: 'no edit button' }
  editBtn.click()
  return new Promise((resolve) => setTimeout(() => {
    const box = document.querySelector('[data-queue-edit-text]')
    if (!box) return resolve({ missing: true, reason: 'no edit box after click' })
    const cs = getComputedStyle(box)
    const br = box.getBoundingClientRect()
    const prompt = document.getElementById('prompt')
    const pcs = getComputedStyle(prompt)
    resolve({
      missing: false,
      minHeight: cs.minHeight,
      fontSize: cs.fontSize,
      borderWidth: cs.borderWidth,
      background: cs.backgroundColor,
      resize: cs.resize,
      unclipped: br.height >= box.scrollHeight - 1,
      rectH: br.height,
      scrollH: box.scrollHeight,
      prompt: { minHeight: pcs.minHeight, fontSize: pcs.fontSize, background: pcs.backgroundColor, resize: pcs.resize },
    })
  }, 120))
})()`

// Scene E probe (2026-10-07-fix-pocket-banner-dismiss-and-ttl): the notice's two new
// exits and the measured band. overlap* are exact intersection areas in px², the gap is
// the pixel distance between the banner's bottom and .composer-inner's top, and disp is
// the computed display of #chatError (the question-open tier hides it by rule while a
// standing copy stays in the DOM — hence both signals).
const noticeBandSnapshot = `(() => {
  const banner = document.getElementById('chatError')
  const inner = document.querySelector('.composer-inner')
  const prompt = document.getElementById('prompt')
  const statusText = document.getElementById('statusText')
  if (!banner || !inner || !prompt) return { missing: true }
  const br = banner.getBoundingClientRect()
  const ir = inner.getBoundingClientRect()
  const overlapArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  const w = window.innerWidth, h = window.innerHeight
  return {
    missing: false,
    text: (banner.textContent || '').trim(),
    disp: getComputedStyle(banner).display,
    banner: { top: br.top, left: br.left, right: br.right, bottom: br.bottom, width: br.width, height: br.height },
    overlapInner: overlapArea(br, ir),
    gapInner: ir.top - br.bottom,
    composerH: (getComputedStyle(document.body).getPropertyValue('--composer-h') || '').trim(),
    composerOffset: document.getElementById('composer').offsetHeight,
    innerOffset: inner.offsetHeight,
    composerPad: (parseFloat(getComputedStyle(document.getElementById('composer')).paddingTop) || 0) + (parseFloat(getComputedStyle(document.getElementById('composer')).paddingBottom) || 0),
    dockExtra: Math.max(0, document.getElementById('composer').offsetHeight - inner.offsetHeight - ((parseFloat(getComputedStyle(document.getElementById('composer')).paddingTop) || 0) + (parseFloat(getComputedStyle(document.getElementById('composer')).paddingBottom) || 0))),
    promptH: prompt.style.height,
    statusText: (statusText ? statusText.textContent : '').trim(),
    questionOpen: document.body.classList.contains('question-open'),
    inViewport: br.top >= 0 && br.left >= -1 && br.right <= w + 1 && br.bottom <= h + 1 && br.width > 0 && br.height > 0,
  }
})()`

const FAILURE_COPY = '连接中断：连不上宿主的会话流。';

async function scenarioBanner(host, port, failures) {
  return withPage(port, host.origin, async (page) => {
    await wait(900); // let the stream snapshot paint the chat and the queue dock
    await page.evaluate(`fetch('/emit-failure',{method:'POST'})`);
    await wait(500);
    const snap = await page.evaluate(bannerSnapshot);
    const no = (cond, msg) => { if (!cond) failures.push(`A(banner): ${msg} — ${JSON.stringify(snap)}`); };
    no(!snap.missing, 'banner or composer missing from the DOM');
    if (snap.missing) return snap;
    no(snap.text === FAILURE_COPY, `the failure copy must be painted by the product path, got ${JSON.stringify(snap.text)}`);
    no(!snap.overlap, 'banner intersects .composer-inner');
    no(snap.selfHit, `banner center is not self-hit (topmost=${snap.hitDesc})`);
    no(snap.inViewport, 'banner outside the viewport');
    return snap;
  });
}

async function scenarioBannerQuestionOpen(host, port, failures) {
  return withPage(port, host.origin, async (page) => {
    // The pending question reaches the page on the first poll AFTER the stream
    // has gone idle (HISTORY_POLL_IDLE_CAP_MS = 5s), so a fixed sleep races it.
    // Wait for the state under test itself before injecting the failure.
    const deadline = Date.now() + 12000;
    let open = false;
    while (Date.now() < deadline) {
      open = await page.evaluate(`document.body.classList.contains('question-open')`);
      if (open) break;
      await wait(250);
    }
    if (!open) {
      failures.push('A2(question-open): the question composer never opened — interaction.pending was never consumed');
      return null;
    }
    await page.evaluate(`fetch('/emit-failure',{method:'POST'})`);
    await wait(500);
    const snap = await page.evaluate(bannerSnapshot);
    const no = (cond, msg) => { if (!cond) failures.push(`A2(question-open): ${msg} — ${JSON.stringify(snap)}`); };
    no(!snap.missing, 'banner or composer missing');
    if (snap.missing) return snap;
    no(snap.questionOpen && snap.composerHidden, 'the scenario must run with the question composer open and the main composer hidden');
    no(snap.text === FAILURE_COPY, `failure copy must persist, got ${JSON.stringify(snap.text)}`);
    // Rewritten in 2026-10-07-fix-pocket-banner-dismiss-and-ttl: the old contract ("banner
    // stays visible and hittable") is what made the notice float OVER the question panel,
    // which is where the user reported losing sight of it and of the panel beneath.
    no(snap.banner.width === 0 && snap.banner.height === 0, 'the question-open tier must collapse the banner to zero area (body.question-open #chatError{display:none})');
    no(!snap.inViewport && !snap.selfHit, 'and with zero area it can neither be read nor hit');
    return { ...snap, disp: await page.evaluate(`getComputedStyle(document.getElementById('chatError')).display`) };
  });
}

// Scene D probe: geometry of the failure banner against a LIVE todo dock
// (todo-open, and again with todo-expanded). overlap* are exact intersection
// areas in px², so "0" is the whole claim — no eyeballed gaps.
const todoBannerSnapshot = `(() => {
  const banner = document.getElementById('chatError')
  const dock = document.getElementById('todoDock')
  const header = dock && dock.querySelector('.todo-header')
  const ci = document.querySelector('.composer-inner')
  if (!banner || !dock || !header || !ci) return { missing: true, todoRows: dock ? 0 : -1 }
  const br = banner.getBoundingClientRect()
  const dr = dock.getBoundingClientRect()
  const cr = ci.getBoundingClientRect()
  const overlapArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  const hr = header.getBoundingClientRect()
  const hit = document.elementFromPoint(hr.left + hr.width / 2, hr.top + hr.height / 2)
  const w = window.innerWidth, h = window.innerHeight
  return {
    missing: false,
    text: (banner.textContent || '').trim(),
    todoOpen: document.body.classList.contains('todo-open'),
    expanded: document.body.classList.contains('todo-expanded'),
    todoH: (getComputedStyle(document.body).getPropertyValue('--todo-h') || '').trim(),
    overlapDock: overlapArea(br, dr),
    overlapComposer: overlapArea(br, cr),
    headerSelfHit: !!hit && (hit === header || header.contains(hit)),
    hitDesc: hit ? hit.tagName + (hit.className ? '.' + hit.className : '') : 'null',
    inViewport: br.top >= 0 && br.left >= -1 && br.right <= w + 1 && br.bottom <= h + 1 && br.width > 0 && br.height > 0,
  }
})()`

async function scenarioBannerTodo(host, port, failures) {
  return withPage(port, host.origin, async (page) => {
    await wait(900); // let the stream snapshot paint the chat, the queue dock and the todo dock
    const up = await page.evaluate(`(() => { const d = document.getElementById('todoDock'); return !!d && !d.hidden && document.body.classList.contains('todo-open') })()`);
    if (!up) {
      failures.push('D(todo-open): todoDock never became visible — the todos projection was not consumed');
      return null;
    }
    await page.evaluate(`fetch('/emit-failure',{method:'POST'})`);
    await wait(500);
    const snap = await page.evaluate(todoBannerSnapshot);
    const no = (cond, msg) => { if (!cond) failures.push(`D(todo-open): ${msg} — ${JSON.stringify(snap)}`); };
    no(!snap.missing, 'banner/todoDock/composer organs missing from the DOM');
    if (snap.missing) return snap;
    no(snap.text === FAILURE_COPY, `the failure copy must be painted by the product path, got ${JSON.stringify(snap.text)}`);
    no(snap.todoOpen && snap.todoH !== '0px' && snap.todoH !== '', `todo dock must hold a real --todo-h, got ${JSON.stringify(snap.todoH)}`);
    no(snap.overlapDock === 0, `banner intersects #todoDock (area ${snap.overlapDock}px²) — W2 --todo-h missing from the stack`);
    no(snap.overlapComposer === 0, 'banner intersects .composer-inner');
    no(snap.headerSelfHit, `todo header center is not self-hit (topmost=${snap.hitDesc})`);
    no(snap.inViewport, 'banner outside the viewport');
    // expanded tier: open the dock's own header and re-run the same geometry set
    await page.evaluate(`document.querySelector('.todo-header').click()`);
    await wait(300);
    const open = await page.evaluate(todoBannerSnapshot);
    const nx = (cond, msg) => { if (!cond) failures.push(`D(todo-expanded): ${msg} — ${JSON.stringify(open)}`); };
    if (open.missing) { nx(false, 'organs vanished after expand'); return snap; }
    nx(open.expanded, 'the todo-expanded body class never engaged after the header click');
    nx(open.overlapDock === 0, `expanded: banner intersects #todoDock (area ${open.overlapDock}px²)`);
    nx(open.overlapComposer === 0, 'expanded: banner intersects .composer-inner');
    nx(open.headerSelfHit, `expanded: todo header center not self-hit (topmost=${open.hitDesc})`);
    nx(open.inViewport, 'expanded: banner outside the viewport');
    return { snap, open };
  });
}

// Scene E: the notice band is MEASURED, not a constant. At baseline the banner's bottom
// was pinned at 84px, so a textarea grown to its 150px ceiling (the composer grows to
// ~183px) left the banner sitting on top of the input. The claim here is not "the banner
// moved" but "it is still exactly above the input, with a real gap, at both sizes".
async function scenarioNoticeBand(host, port, failures) {
  return withPage(port, host.origin, async (page) => {
    await wait(900);
    await page.evaluate(`fetch('/emit-failure',{method:'POST'})`);
    await wait(400);
    const idle = await page.evaluate(noticeBandSnapshot);
    const no = (cond, msg) => { if (!cond) failures.push(`E(band/idle): ${msg} — ${JSON.stringify(idle)}`); };
    no(!idle.missing, 'banner/composer/prompt organs missing from the DOM');
    if (idle.missing) return idle;
    no(idle.text === FAILURE_COPY, `the failure copy must be painted by the product path, got ${JSON.stringify(idle.text)}`);
    no(idle.composerH.endsWith('px') && parseFloat(idle.composerH) > 0, `--composer-h must hold a measured band, got ${JSON.stringify(idle.composerH)}`);
    // The band is the composer's own footprint, not #composer's flex column: the docks
    // already have --todo-h/--queue-h, so counting them here would double-charge them.
    const wantIdle = idle.innerOffset + idle.composerPad;
    no(idle.dockExtra > 0, `non-vacuity: the docks must actually be mounted, else this scene cannot tell the two definitions apart (dockExtra=${idle.dockExtra})`);
    no(Math.abs(parseFloat(idle.composerH) - wantIdle) < 1.5,
      `--composer-h ${idle.composerH} must equal .composer-inner ${idle.innerOffset} + the composer's own padding ${idle.composerPad} (docks excluded) — expected ~${wantIdle}px, #composer.offsetHeight would give ${idle.composerOffset}px`);
    no(idle.overlapInner === 0, `banner intersects .composer-inner (area ${idle.overlapInner}px²)`);
    no(idle.gapInner >= 2, `the banner must keep a real gap above the input, got ${idle.gapInner}px`);

    // grow the textarea to the 150px ceiling and re-run the same set
    await page.evaluate(`(() => {
      const p = document.getElementById('prompt')
      p.value = Array.from({ length: 10 }, (_, i) => '第' + i + '行输入内容').join('\\n')
      p.dispatchEvent(new Event('input', { bubbles: true }))
    })()`);
    await wait(300);
    const grown = await page.evaluate(noticeBandSnapshot);
    const nx = (cond, msg) => { if (!cond) failures.push(`E(band/grown): ${msg} — ${JSON.stringify(grown)}`); };
    nx(grown.text === FAILURE_COPY, `the notice must survive typing a long draft, got ${JSON.stringify(grown.text)}`);
    nx(parseFloat(grown.promptH) >= 150, `non-vacuity: the textarea must actually reach its 150px ceiling, got ${JSON.stringify(grown.promptH)}`);
    nx(Math.abs(grown.gapInner - idle.gapInner) <= 2, `the banner must track the input (gap ${idle.gapInner}px -> ${grown.gapInner}px, baseline bug: banner stays put and the input grows into it)`);
    nx(grown.overlapInner === 0, `grown: banner intersects .composer-inner (area ${grown.overlapInner}px²)`);
    nx(grown.inViewport, 'grown: banner outside the viewport');
    return { idle, grown };
  });
}

// Scene F: the notice's new exits. The right end of the banner is a dismiss control
// (handled by a CSS ::after affordance, so #chatError stays :empty and keeps collapsing
// when it has nothing to say) and the rest of the banner must NOT be one.
async function scenarioNoticeDismiss(host, port, failures) {
  return withPage(port, host.origin, async (page) => {
    await wait(900);
    await page.evaluate(`fetch('/emit-failure',{method:'POST'})`);
    await wait(400);
    const standing = await page.evaluate(noticeBandSnapshot);
    const no = (cond, msg) => { if (!cond) failures.push(`F(dismiss): ${msg} — ${JSON.stringify(standing)}`); };
    no(!standing.missing, 'banner organs missing from the DOM');
    if (standing.missing) return standing;
    no(standing.text === FAILURE_COPY, `non-vacuity: the notice must be painted first, got ${JSON.stringify(standing.text)}`);
    no(standing.disp === 'block', `non-vacuity: the notice must be visible before the tap, display=${JSON.stringify(standing.disp)}`);

    // a tap on the text half must not dismiss it: the guard is "is this the right end?"
    await page.evaluate(`document.getElementById('chatError').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: Math.round(document.getElementById('chatError').getBoundingClientRect().left + 5), clientY: Math.round(document.getElementById('chatError').getBoundingClientRect().top + 18) }))`);
    await wait(200);
    const leaning = await page.evaluate(noticeBandSnapshot);
    no(leaning.text === FAILURE_COPY, `a tap on the banner's text must not dismiss it, got ${JSON.stringify(leaning.text)}`);

    // a tap on the right end (the ::after zone) retires it and restores the status label
    await page.evaluate(`(() => {
      const b = document.getElementById('chatError')
      const r = b.getBoundingClientRect()
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: Math.round(r.right - 4), clientY: Math.round(r.top + r.height / 2) }))
    })()`);
    await wait(200);
    const after = await page.evaluate(noticeBandSnapshot);
    const nx = (cond, msg) => { if (!cond) failures.push(`F(dismiss/after): ${msg} — ${JSON.stringify(after)}`); };
    nx(after.text === '', `the tap must clear the standing copy, got ${JSON.stringify(after.text)}`);
    nx(after.disp === 'none', `#chatError must collapse once empty, display=${JSON.stringify(after.disp)}`);
    nx(after.statusText === '已连接', `the light must be told the transport is fine again, got ${JSON.stringify(after.statusText)}`);
    // the affordance itself must be real, not only the handler: #chatError stays a bare
    // content element, so the × and its hit area come from a ::after rule
    const affordance = await page.evaluate(`(() => {
      const el = document.getElementById('chatError')
      const cs = getComputedStyle(el, '::after')
      const box = el.getBoundingClientRect()
      return { content: cs.content, width: parseFloat(cs.width) || 0, right: parseFloat(cs.right) || 0, pointerEvents: getComputedStyle(el).pointerEvents, height: box.height }
    })()`);
    no(affordance.content === '"×"', `the dismiss affordance must be painted by a ::after rule, got content=${JSON.stringify(affordance.content)}`);
    no(affordance.width >= 24, `the affordance must be a real tap target, got ${affordance.width}px`);
    no(affordance.pointerEvents === 'auto', `the banner must be hittable, got pointer-events:${affordance.pointerEvents}`);
    return { standing, leaning, after, affordance };
  });
}

async function scenarioQueue(host, port, failures) {
  return withPage(port, host.origin, async (page) => {
    await wait(900);
    const snap = await page.evaluate(queueSnapshot);
    const no = (cond, msg) => { if (!cond) failures.push(`C(queue-list): ${msg} — ${JSON.stringify(snap)}`); };
    no(!snap.missing, 'queue organs missing from the DOM');
    if (snap.missing) return snap;
    no(snap.rows >= 2, `non-vacuity: expected the two canned rows, got ${snap.rows}`);
    no(snap.noHScroll, `queue-list scrolls horizontally (scrollWidth ${snap.scrollWidth} > clientWidth ${snap.clientWidth})`);
    no(snap.removeInside, 'the × handle pokes past the list edge');
    no(snap.ellipsis === 'ellipsis', `.queue-text text-overflow is ${JSON.stringify(snap.ellipsis)}`);
    no(snap.dockVisible, 'the dock renders with a real box');
    no(snap.dockGap >= 6, `dock band regression: gap below dock is ${snap.dockGap}px (scene 1/2 anchor ~8px)`);

    const edit = await page.evaluate(editSnapshot);
    const en = (cond, msg) => { if (!cond) failures.push(`B(edit-box): ${msg} — ${JSON.stringify(edit)}`); };
    en(!edit.missing, `edit state unreachable: ${edit.reason || 'unknown'}`);
    if (!edit.missing) {
      en(edit.minHeight === '64px', `minHeight ${edit.minHeight} (baseline bug: 44px from .composer textarea)`);
      en(edit.fontSize === '13px', `fontSize ${edit.fontSize} (baseline bug: 16px)`);
      en(edit.borderWidth === '1px', `borderWidth ${edit.borderWidth}`);
      en(edit.background !== 'transparent' && edit.background !== 'rgba(0, 0, 0, 0)', `background ${edit.background} must be opaque`);
      en(edit.resize === 'vertical', `resize ${edit.resize}`);
      en(edit.unclipped, `two-line content clipped: rect ${edit.rectH} < scroll ${edit.scrollH}`);
      en(edit.prompt.minHeight === '44px' && edit.prompt.fontSize === '16px', `prompt drifted: ${JSON.stringify(edit.prompt)}`);
      en(edit.prompt.background === 'rgba(0, 0, 0, 0)', `prompt background ${edit.prompt.background} must stay transparent`);
      en(edit.prompt.resize === 'none', `prompt resize ${edit.prompt.resize} must stay none`);
    }
    return { snap, edit };
  });
}

// Scene G (2026-10-07-feat-pocket-smart-scroll-anchors): the follow machine and
// the dual anchors, driven with real streamed chunks in the real layout.
//   G1 near the bottom both anchors are hidden;
//   G2 a streamed chunk sticks to the bottom (following);
//   G3 scrolling up unlocks: the next chunk must NOT steal the position, and ↓
//      appears while ↑ stays dark (mutual exclusion);
//   G4 tapping ↓ returns to the bottom, hides ↓, re-arms the follow, and lights
//      ↑ because the last question sits more than a screen above the top;
//   G5 tapping ↑ brings the last user message to the top edge (+pad);
//   G6 the history tail carries msg-hist (content-visibility) and the tail
//      messages do not.
const scrollSnapshot = `(() => {
  const box = document.getElementById('messages')
  const latest = document.getElementById('jumpLatest')
  const prompt = document.getElementById('jumpPrompt')
  if (!box || !latest || !prompt) return { missing: true }
  const rows = box.querySelectorAll(':scope > .message')
  const lastUser = box.querySelectorAll(':scope > .message.user')
  const anchor = lastUser.length ? lastUser[lastUser.length - 1] : null
  const boxTop = box.getBoundingClientRect().top
  return {
    missing: false,
    dist: box.scrollHeight - box.scrollTop - box.clientHeight,
    clientH: box.clientHeight,
    scrollTop: box.scrollTop,
    showLatest: latest.classList.contains('show'),
    showPrompt: prompt.classList.contains('show'),
    latestHidden: latest.hidden,
    promptHidden: prompt.hidden,
    messages: rows.length,
    users: box.querySelectorAll(':scope > .message.user').length,
    assistants: box.querySelectorAll(':scope > .message.assistant').length,
    histCount: box.querySelectorAll(':scope > .msg-hist').length,
    cvFirst: rows.length ? getComputedStyle(rows[0]).contentVisibility : '',
    cvFirstClass: rows.length ? rows[0].classList.contains('msg-hist') : false,
    tailClass: rows.length ? Array.from(rows).slice(-8).some((r) => r.classList.contains('msg-hist')) : false,
    // box-relative: "the top of the screen" for the transcript is the top of the
    // scroll area (the back button overlays it), not the viewport origin — the
    // shell chrome above it measures ~91px in this environment.
    anchorTop: anchor ? anchor.getBoundingClientRect().top - boxTop : -1,
  }
})()`

async function scenarioScroll(host, port, failures) {
  return withPage(port, host.origin, async (page) => {
    await wait(900); // let the long snapshot paint
    const snap0 = await page.evaluate(scrollSnapshot);
    const n0 = (cond, msg) => { if (!cond) failures.push(`G0(baseline): ${msg} — ${JSON.stringify(snap0)}`); };
    n0(!snap0.missing, 'messages/anchor organs missing');
    if (snap0.missing) return null;
    n0(snap0.messages >= 24, `non-vacuity: expected the 24-message long history, got ${snap0.messages}`);
    // "At the bottom" is the follow band (120px): the open jump lands, then the
    // content-visibility estimates converge and --composer-h settles, which can
    // leave a few dozen px of drift before the next paint re-sticks.
    n0(snap0.dist < 120, `the page must open at the bottom (within the follow band), dist=${snap0.dist}`);
    n0(!snap0.showLatest, 'at the bottom ↓ must be dark');
    // ↑ lights exactly when the last question hangs more than a screen above the
    // viewport top — which, in a long-reply transcript viewed from the bottom, is
    // the product's whole point (the question is off-screen above while you read
    // the answer).
    n0(!snap0.showPrompt, 'at the bottom nothing may light (↑ also dark: the reader has not left yet)');
    n0(snap0.cvFirstClass, 'the first message must carry msg-hist');
    n0(!snap0.tailClass, 'the last 8 messages must stay untagged');
    n0(snap0.cvFirst === 'auto', `msg-hist must compute content-visibility:auto, got ${JSON.stringify(snap0.cvFirst)}`);

    // G2: a streamed chunk sticks (following)
    const before = snap0.scrollTop;
    await page.evaluate(`fetch('/emit-chunk',{method:'POST'})`);
    await wait(450);
    const snap1 = await page.evaluate(scrollSnapshot);
    const n1 = (cond, msg) => { if (!cond) failures.push(`G2(follow): ${msg} — ${JSON.stringify(snap1)}`); };
    n1(snap1.scrollTop > before, `the streamed chunk must pull the view down (${before} -> ${snap1.scrollTop})`);
    n1(snap1.dist < 60, `still following after the chunk, dist=${snap1.dist}`);

    // G3: scroll up → unlock; the next chunk must not steal the position
    await page.evaluate(`(() => { const b = document.getElementById('messages'); b.scrollTop = Math.max(0, b.scrollTop - Math.round(b.clientHeight * 2.5)) })()`);
    await wait(300);
    const parked = await page.evaluate(scrollSnapshot);
    const n2 = (cond, msg) => { if (!cond) failures.push(`G3(unlock): ${msg} — ${JSON.stringify(parked)}`); };
    n2(parked.showLatest, '↓ must appear past 1.5 screens from the bottom');
    n2(!parked.showPrompt, '↑ must stay dark while ↓ is lit (mutual exclusion)');
    const parkedTop = parked.scrollTop;
    await page.evaluate(`fetch('/emit-chunk',{method:'POST'})`);
    await wait(450);
    const after = await page.evaluate(scrollSnapshot);
    n2(Math.abs(after.scrollTop - parkedTop) < 6, `an unlocked chunk must not steal the position (${parkedTop} -> ${after.scrollTop})`);

    // G4: ↓ returns to the bottom, re-arms the follow, and hands the floor to ↑
    await page.evaluate(`document.getElementById('jumpLatest').click()`);
    await wait(350);
    const home = await page.evaluate(scrollSnapshot);
    const n3 = (cond, msg) => { if (!cond) failures.push(`G4(jump-latest): ${msg} — ${JSON.stringify(home)}`); };
    n3(home.dist < 60, `↓ must land at the bottom, dist=${home.dist}`);
    n3(!home.showLatest, '↓ must go dark at the bottom');
    n3(home.showPrompt, `↑ must light when the question is far above the viewport (anchorTop=${home.anchorTop}, clientH=${home.clientH})`);

    // G5: ↑ brings the last question to the top edge (+ the 54px pad)
    // G5.2 (2026-10-09): the whole point of the fix — the ↑ button must NOT rise
    // the instant the follow unlocks. Unlocking is a hair's breadth (120px); the
    // product's trigger is a screen of scrolling back through this turn.
    const nudged = await (async () => {
      await page.evaluate(`(() => { const b = document.getElementById('messages'); b.scrollTop = Math.max(0, b.scrollTop - 200) })()`);
      await wait(250);
      return page.evaluate(scrollSnapshot);
    })();
    const n4b = (cond, msg) => { if (!cond) failures.push(`G5-2(hysteresis): ${msg} — ${JSON.stringify(nudged)}`); };
    n4b(!nudged.showPrompt, `↑ must stay dark after a 200px nudge off the bottom (the trigger is a screen, not the follow band), anchorTop=${nudged.anchorTop}`);

    await page.evaluate(`document.getElementById('jumpPrompt').click()`);
    await wait(600); // the settle re-aims against materialized cv layout
    const asked = await page.evaluate(scrollSnapshot);
    const n4 = (cond, msg) => { if (!cond) failures.push(`G5(jump-prompt): ${msg} — ${JSON.stringify(asked)}`); };
    n4(Math.abs(asked.anchorTop - 54) < 40, `the last question must sit ~54px from the top, got ${asked.anchorTop}px`);
    n4(!asked.showPrompt, '↑ must go dark once the question is in view');

    // G6: after the jump the follow stays unlocked until the reader returns —
    // one more chunk must not move the view.
    const hold = asked.scrollTop;
    await page.evaluate(`fetch('/emit-chunk',{method:'POST'})`);
    await wait(450);
    const still = await page.evaluate(scrollSnapshot);
    n4(Math.abs(still.scrollTop - hold) < 6, `the unlocked view must hold (${hold} -> ${still.scrollTop})`);
    return { snap0, snap1, parked, home, asked, still };
  });
}

// ------------------------------------------------------------------ scene H
// Scene H (2026-10-19, BUG-5 "有排队消息的时候页面不能滑动"): the dock dead zone.
// The queue/todo docks sit inside the pointer-events:none composer and used to claim
// pointer-events:auto for their WHOLE box. A touch anywhere in that reserved band then
// hit-tested to the dock: the dock's own list had nothing to scroll, the composer is not
// an ancestor of #messages, and the chain dies at body{overflow:hidden} — so the
// transcript could not be dragged while a message was queued. The docks are transparent
// containers now and only controls with click semantics opt back in. Character-level pins
// cannot prove a hit-test; this does, at the real 390x844 viewport.
const DOCK_LAYERS = ['queueDock', 'todoDock', 'composer-inner', 'composer-other'];

const OWNER_HELPER = `  const ownerOf = (el) => {
    if (!el) return 'null'
    if (el.closest) {
      if (el.closest('#queueDock')) return 'queueDock'
      if (el.closest('#todoDock')) return 'todoDock'
      if (el.closest('.composer-inner')) return 'composer-inner'
      if (el.closest('#composer')) return 'composer-other'
    }
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
  }
  const at = (x, y) => ownerOf(document.elementFromPoint(Math.round(x), Math.round(y)))`;

const dockPassthroughSnapshot = `(() => {
  const dock = document.getElementById('queueDock')
  const box = document.getElementById('messages')
  if (!dock || !box) return { missing: true }
${OWNER_HELPER}
  const r = dock.getBoundingClientRect()
  const list = dock.querySelector('.queue-list')
  const lr = list ? list.getBoundingClientRect() : null
  const act = dock.querySelector('[data-queue-action="remove"]')
  const ar = act ? act.getBoundingClientRect() : null
  const actEl = ar ? document.elementFromPoint(Math.round(ar.left + ar.width / 2), Math.round(ar.top + ar.height / 2)) : null
  const item = dock.querySelector('.queue-item')
  const qr = item ? item.getBoundingClientRect() : null
  const overflows = !!list && list.scrollHeight > list.clientHeight + 1
  return {
    missing: false,
    dockVisible: r.height > 0 && r.width > 0,
    rows: dock.querySelectorAll('.queue-item').length,
    overflows,
    listPointerEvents: list ? getComputedStyle(list).pointerEvents : '',
    bandTop: at(r.left + r.width / 2, r.top + 3),
    bandMid: at(r.left + r.width / 2, r.top + r.height / 2),
    bandLeftEdge: at(r.left + 4, r.top + r.height / 2),
    bandRightEdge: at(r.right - 4, r.top + r.height / 2),
    itemLeftEdge: qr ? at(qr.left + 3, qr.top + qr.height / 2) : 'no-item',
    listBottomPad: lr ? at(lr.left + lr.width / 2, lr.bottom - 2) : 'no-list',
    actOwner: actEl ? ownerOf(actEl) : 'null',
    actSelfHit: !!act && (!!actEl && (actEl === act || act.contains(actEl))),
    messagesBottom: Math.round(box.getBoundingClientRect().bottom),
    dockTop: Math.round(r.top),
  }
})()`

const dockEditHitSnapshot = `(() => {
  const dock = document.getElementById('queueDock')
  const editBtn = dock && dock.querySelector('[data-queue-action="edit"]')
  if (!editBtn) return { missing: true, reason: 'no edit button' }
  editBtn.click()
  return new Promise((resolve) => setTimeout(() => {
    const boxEl = document.querySelector('[data-queue-edit-text]')
    if (!boxEl) return resolve({ missing: true, reason: 'no edit box after click' })
    const r = boxEl.getBoundingClientRect()
    const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
    resolve({
      missing: false,
      self: !!el && (el === boxEl || boxEl.contains(el)),
      tag: el ? el.tagName.toLowerCase() + (el.className ? '.' + el.className : '') : 'null',
    })
  }, 140))
})()`

const todoPassthroughSnapshot = `(() => {
  const dock = document.getElementById('todoDock')
  const header = dock && dock.querySelector('.todo-header')
  if (!dock || !header || !dock.offsetParent) return { missing: true }
${OWNER_HELPER}
  const hr = header.getBoundingClientRect()
  const hel = document.elementFromPoint(Math.round(hr.left + hr.width / 2), Math.round(hr.top + hr.height / 2))
  const headerOwner = ownerOf(hel)
  if (!document.body.classList.contains('todo-expanded')) header.click()
  return new Promise((resolve) => setTimeout(() => {
    const item = dock.querySelector('.todo-item')
    const target = item || dock.querySelector('.todo-list')
    const out = {
      missing: false,
      headerSelfHit: !!hel && (hel === header || header.contains(hel)),
      headerOwner,
      expanded: document.body.classList.contains('todo-expanded'),
      rowOwner: 'no-row',
      rowPointerEvents: '',
      dockBottom: Math.round(dock.getBoundingClientRect().bottom),
    }
    if (!target) return resolve(out)
    const r = target.getBoundingClientRect()
    out.rowOwner = at(r.left + 6, r.top + Math.min(r.height / 2, 8))
    out.rowPointerEvents = getComputedStyle(target).pointerEvents
    resolve(out)
  }, 180))
})()`


async function scenarioDockPassthrough(host, port, failures) {
  return withPage(port, host.origin, async (page) => {
    await wait(900); // the stream snapshot paints the queue dock with the two canned rows
    const snap = await page.evaluate(dockPassthroughSnapshot);
    const no = (cond, msg) => { if (!cond) failures.push(`H(dock-passthrough): ${msg} — ${JSON.stringify(snap)}`); };
    no(!snap.missing, 'queueDock or #messages missing from the DOM');
    if (snap.missing) return snap;
    no(snap.dockVisible && snap.rows >= 2, `non-vacuity: the dock must paint the canned rows, got ${JSON.stringify({ visible: snap.dockVisible, rows: snap.rows })}`);
    no(snap.dockTop < snap.messagesBottom, 'the dock band must sit inside the transcript box (that is the reserved padding the user drags through)');
    // Every sample below is dock CHROME — border, header strip, list padding, the left
    // edge of a row. None of it has click semantics, so all of it must be transparent.
    // When the list genuinely overflows it re-arms its own scrolling (inline style) and
    // the two inner samples legitimately land on the dock — that case asserts the
    // opposite: the list must be self-hittable so it can be dragged.
    const chrome = ['bandTop', 'bandMid', 'bandLeftEdge', 'bandRightEdge', 'itemLeftEdge', 'listBottomPad'];
    if (snap.overflows) {
      no(snap.listPointerEvents === 'auto', `an overflowing queue-list must keep its own scroll, computed pointer-events=${JSON.stringify(snap.listPointerEvents)}`);
    } else {
      for (const key of chrome) {
        no(!DOCK_LAYERS.includes(snap[key]), `${key} is still eaten by the dock layer (${snap[key]}): a vertical drag there can neither scroll the dock nor the transcript`);
      }
      no(snap.listPointerEvents === 'none', `a non-overflowing queue-list must stay transparent, computed pointer-events=${JSON.stringify(snap.listPointerEvents)}`);
    }
    no(snap.actSelfHit, `the × handle lost its own hit area (topmost=${snap.actOwner})`);
    const edit = await page.evaluate(dockEditHitSnapshot);
    const ne = (cond, msg) => { if (!cond) failures.push(`H2(queue-edit-hit): ${msg} — ${JSON.stringify(edit)}`); };
    ne(!edit.missing, `the edit state is unreachable: ${edit.reason || 'unknown'}`);
    if (!edit.missing) ne(edit.self, `the inline edit box is not hittable (topmost=${edit.tag})`);
    return { snap, edit };
  });
}

async function scenarioTodoPassthrough(host, port, failures) {
  return withPage(port, host.origin, async (page) => {
    await wait(900);
    const snap = await page.evaluate(todoPassthroughSnapshot);
    const no = (cond, msg) => { if (!cond) failures.push(`H3(todo-passthrough): ${msg} — ${JSON.stringify(snap)}`); };
    no(!snap.missing, 'todoDock or its header missing from the DOM');
    if (snap.missing) return snap;
    no(snap.headerSelfHit, `the collapse header must keep its hit area (topmost=${snap.headerOwner})`);
    no(snap.expanded, 'the scenario must run with the todo list expanded');
    no(snap.rowOwner !== 'no-row', 'no todo row to probe — the expanded list painted nothing');
    no(!DOCK_LAYERS.includes(snap.rowOwner), `a todo row is still eaten by the dock layer (${snap.rowOwner})`);
    return snap;
  });
}
// ----------------------------------------------------------------------- main

async function main() {
  const { on, missing } = gate();
  if (!on) {
    console.log(
      `GEOMETRY SKIP: set ${GATE_ENV}=1, ${PORT_ENV}=<port> and ${EDGE_ENV}=<browser path> to run the real-browser geometry assertions`
      + (missing.length ? ` (missing: ${missing.join(', ')})` : ' (set but not enabled)'),
    );
    return 0;
  }
  const browser = findBrowser();
  const launchCommand = `"${browser || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'}" --headless=new --remote-debugging-port=${CDP_PORT} --user-data-dir="%TEMP%\\pocket-geom-profile" --no-first-run --no-default-browser-check about:blank`;
  if (!browser) {
    process.stderr.write(`GEOMETRY ERROR: no browser found. Set ${EDGE_ENV} to an Edge or Chrome binary.\n`);
    process.stderr.write(`GEOMETRY HINT: start one by hand, then re-run with ${PORT_ENV}=${CDP_PORT}:\n  ${launchCommand}\n`);
    return 2;
  }
  const profile = mkdtempSync(path.join(tmpdir(), 'pocket-geom-'));
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
  const report = { browser, cdpPort: CDP_PORT, viewport: '390x844', scenarios: [] };
  try {
    const version = await waitForCdp(CDP_PORT);
    if (!version) {
      process.stderr.write(`GEOMETRY ERROR: no CDP endpoint on 127.0.0.1:${CDP_PORT} after 15s.\n`);
      process.stderr.write(`GEOMETRY HINT: start one by hand, then re-run:\n  ${launchCommand}\n`);
      if (stderr.trim()) process.stderr.write(`GEOMETRY NOTE: browser stderr:\n${stderr.trim()}\n`);
      return 2;
    }
    log('browser', version.Browser || browser);

    const plain = await startHost({});
    try {
      report.scenarios.push(await scenarioBanner(plain, CDP_PORT, failures));
      report.scenarios.push(await scenarioQueue(plain, CDP_PORT, failures));
      report.scenarios.push(await scenarioNoticeDismiss(plain, CDP_PORT, failures));
      report.scenarios.push(await scenarioDockPassthrough(plain, CDP_PORT, failures));
    } finally {
      await plain.close();
    }
    const todoHost = await startHost({
      todos: [
        { content: '几何目验任务一（进行中）', status: 'in_progress' },
        { content: '几何目验任务二（待处理）', status: 'pending' },
      ],
    });
    try {
      report.scenarios.push(await scenarioBannerTodo(todoHost, CDP_PORT, failures));
      report.scenarios.push(await scenarioNoticeBand(todoHost, CDP_PORT, failures));
      report.scenarios.push(await scenarioTodoPassthrough(todoHost, CDP_PORT, failures));
    } finally {
      await todoHost.close();
    }
    const questionHost = await startHost({
      pendingQuestion: { rpcId: 'rpc1', sessionId: SESSION_ID, questions: [{ id: 'qq1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] }] },
    });
    try {
      report.scenarios.push(await scenarioBannerQuestionOpen(questionHost, CDP_PORT, failures));
    } finally {
      await questionHost.close();
    }
    const scrollHost = await startHost({ longHistory: true });
    try {
      report.scenarios.push(await scenarioScroll(scrollHost, CDP_PORT, failures));
    } finally {
      await scrollHost.close();
    }
  } finally {
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
    console.log('GEOMETRY FAIL:');
    for (const line of failures) console.log(`  - ${line}`);
    return 1;
  }
  console.log('GEOMETRY PASS: banner/edit-box/queue-list/todo-dock/notice/scroll-follow/dock-passthrough hold their geometry at 390x844');
  return 0;
}

process.exitCode = await main();
