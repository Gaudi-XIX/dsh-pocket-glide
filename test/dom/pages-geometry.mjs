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

function historyFor(todos = null) {
  const record = (seq, text) => ({
    seq,
    event: { type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } },
  });
  return {
    events: [
      record(1, '起一条对话用于几何目验'),
      { seq: 2, event: { type: 'assistant/message', data: { turn: 't1', message: { content: [{ type: 'text', text: '几何目验用的回复。' }] } } } },
      { seq: 3, event: { type: 'turn/end', data: { turn: 't1', reason: { kind: 'completed' } } } },
    ],
    hasMore: false,
    projections: projections(todos),
  };
}

function startHost({ pendingQuestion = null, todos = null } = {}) {
  let streamRes = null;
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
    if (url.pathname === '/') {
      return send(200, renderMobilePage({ locale: 'zh', boot: JSON.stringify(bootData()), initialChat: false }), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/sw.js') return send(200, 'self.addEventListener("fetch",()=>{})', 'text/javascript; charset=utf-8');
    if (url.pathname === '/api/status') return send(200, { settings: null, tunnelExpiresAt: undefined, device: null });
    if (url.pathname === '/api/session/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': open\n\n');
      const frame = { records: historyFor(todos).events, projections: projections(todos), hasMore: false };
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
        if (method === 'session.history') value = historyFor(todos);
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
    no(snap.inViewport && snap.selfHit, 'banner must stay visible and hittable with the composer hidden');
    return snap;
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
  console.log('GEOMETRY PASS: banner/edit-box/queue-list/todo-dock hold their geometry at 390x844');
  return 0;
}

process.exitCode = await main();
