// Render-layer verification stub for the pocket mobile page (canonical version in dsh-pocket/tools/).
// Serves the REAL rendered assets from lib/pages.js with canned goal+queue state, so a browser
// (mobile viewport 390x844) can verify layout/focus behavior without the DSH host. Control endpoint
// POST /emit fires a goal/change SSE frame to trigger the projections refresh path while the edit
// box is focused. All canned data lives in the CONFIG object below; override the port with
// `node tools/render-stub.mjs --port N`. CONFIG.pendingQuestion seeds the interaction.pending RPC
// (shape: { rpcId, sessionId, questions: [{ id, header?, question, detail?, options?: [{ label,
// description? }], multiSelect? }] }); default null keeps the composer hidden (zero regression).
import { createServer } from 'node:http';
import { mobilePageAssets } from '../lib/pages.js';

const NOW = Date.now();
const CONFIG = {
  port: 4399,
  locale: 'zh',
  sessionTitle: '渲染目验会话',
  keepaliveMs: 1200,
  // Set to a pending-question value to stub the question composer UI (see shape note above).
  pendingQuestion: null,
  goal: {
    goal: { objective: '手机端目标条渲染目验（假数据）', phase: 'active', maxGoalRounds: 64, id: 'goal-x', revision: 1 },
    roundsStarted: 3, createdAt: 1791000000000, updatedAt: 1791000600000,
  },
  queue: { 'next-turn': [
    { id: 'q1', content: [{ type: 'text', text: '这是一条排队目验消息\n第二行测试首换行防护' }] },
    { id: 'q2', content: [{ type: 'image', mediaType: 'image/png' }, { type: 'file', name: 'a.zip' }] },
  ] },
  events: [
    { event: { type: 'user/message', seq: 1, time: NOW - 60000, data: { turn: 1, message: { source: { kind: 'user' }, content: [{ type: 'text', text: '起一条对话用于目验' }] } } } },
    { event: { type: 'assistant/message', seq: 2, time: NOW - 30000, data: { turn: 1, message: { content: [{ type: 'text', text: '好的，这是目验用的回复。' }] } } } },
  ],
};

const portArgv = process.argv.indexOf('--port');
const portOverride = portArgv !== -1 ? Number(process.argv[portArgv + 1]) : NaN;
const PORT = Number.isFinite(portOverride) && portOverride > 0 ? portOverride : CONFIG.port;

const assets = mobilePageAssets({ locale: CONFIG.locale });
const GOAL = CONFIG.goal;
const QUEUE = CONFIG.queue;
const EVENTS = CONFIG.events;
const PROJECTIONS = { asOfSeq: 10, values: { goal: GOAL, inbox: QUEUE, todos: null, modelSelection: null } };
let streamRes = null;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'POST' && p === '/emit') {
    if (streamRes) {
      streamRes.write(`event: event\ndata: ${JSON.stringify({ event: { type: 'goal/change', seq: 99, time: Date.now() } })}\n\n`);
      res.writeHead(200); res.end('emitted');
    } else { res.writeHead(503); res.end('no stream'); }
    return;
  }
  if (req.method === 'POST' && p === '/api/rpc') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { method } = JSON.parse(body || '{}');
      let value;
      if (method === 'session.list') value = { items: [{ sessionId: 's-probe', running: true, projections: { asOfSeq: 10, values: { title: CONFIG.sessionTitle } } }], archivedSessionIds: [] };
      else if (method === 'workspace.list') value = { items: [{ workspaceId: 'w1', title: 'defws', path: 'F:/defws', sessionIds: ['s-probe'] }] };
      else if (method === 'settings.describe') value = { namespaces: [] };
      else if (method === 'session.history') value = { events: EVENTS, projections: PROJECTIONS, hasMore: false };
      else if (method === 'interaction.pending') value = CONFIG.pendingQuestion ?? null;
      else if (method === 'session.projections') value = PROJECTIONS;
      else if (method === 'session.models') value = { default: { provider: '', model: '' }, routableProviders: [], groups: [], failures: [] };
      else if (method === 'agentPreset.list') value = { presets: [] };
      else value = {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, value }));
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/session/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 1500\n\n');
    res.write(`event: snapshot\ndata: ${JSON.stringify({ records: [], projections: PROJECTIONS, hasMore: false })}\n\n`);
    streamRes = res;
    const keepalive = setInterval(() => {
      try { streamRes && streamRes.write(`event: status\ndata: ${JSON.stringify({ agentRunning: true, at: Date.now() })}\n\n`); } catch { /* dropped */ }
    }, CONFIG.keepaliveMs);
    req.on('close', () => { clearInterval(keepalive); streamRes = null; });
    return;
  }
  if (req.method === 'GET' && (p === '/app.js' || p.startsWith('/app.js'))) {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(assets.js);
    return;
  }
  if (req.method === 'GET' && (p === '/app.css' || p.startsWith('/app.css'))) {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end(assets.css);
    return;
  }
  if (req.method === 'GET' && p === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(assets.document);
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(PORT, '127.0.0.1', () => console.log('render stub on http://127.0.0.1:' + PORT + '/'));
