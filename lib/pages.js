import { LARGE_BODY_BYTES, LARGE_BODY_METHODS, MAX_BODY_BYTES, toolActivityCategory } from './constants.js'
import { STEP_PROCESS_LABELS, GENERATED_FROM } from './step-process.generated.js'

/**
 * @typedef {'en' | 'zh'} Locale
 */
/**
 * @typedef {object} MobilePageOptions
 * @property {Locale} locale
 * @property {string} [nonce]
 */
/**
 * @typedef {object} PendingCreatedSession
 * @property {string} workspaceId
 * @property {string} sessionId
 */
/**
 * @typedef {object} PendingWorkspace
 * @property {string} [workspaceId]
 * @property {string[]} [sessionIds]
 */
/**
 * @typedef {object} PendingServerWorkspace
 * @property {unknown} [sessionIds]
 */
/**
 * @typedef {object} ConnectedDevice
 * @property {string} [id]
 * @property {string} label
 * @property {string} remoteAddress
 * @property {number} expiresAt
 */
/**
 * @typedef {object} DesktopPairingPageOptions
 * @property {string} qrSvg
 * @property {string} pairingUrl
 * @property {number} expiresAt
 * @property {Locale} locale
 * @property {boolean} connected
 * @property {boolean} [tunnelActive]
 * @property {boolean} [tunnelLoading]
 * @property {('cloudflare' | 'pinggy')} [tunnelProvider]
 * @property {string} [tunnelUrl]
 * @property {string} [tunnelError]
 * @property {boolean} [unexpectedlyClosed]
 * @property {string} [pairingPin]
 * @property {boolean} [pinConsent]
 * @property {number} [pinExpiresAt]
 * @property {{channel?: string, enabled?: boolean, keyMasked?: string}} [notifyConfig]
 * @property {{tokenMasked?: string, hostname?: string}} [tunnelConfig]
 * @property {{id: string, label?: string, remoteAddress?: string, expiresAt?: number}[]} [pendingPairings]
 * @property {string} [nonce]
 */

/**
 * Keep a phone-created session in its workspace until the follow snapshot
 * lists or archives it. Each workspace reload replaces the local list with
 * the server snapshot, so an id the server has not caught up to has to be
 * spliced in again.
 */
export function applyPendingCreatedSessions(
  workspaces,
  pending,
  serverItems,
  archivedIds
) {
  const stillPending = []
  for (const item of pending) {
    const seen = serverItems.some((workspace) => (
      Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(item.sessionId)
    )) || archivedIds.includes(item.sessionId)
    if (seen) continue
    const workspace = workspaces.find((candidate) => candidate.workspaceId === item.workspaceId)
    const sessionIds = workspace?.sessionIds
    if (workspace && Array.isArray(sessionIds) && !sessionIds.includes(item.sessionId)) {
      workspace.sessionIds = [item.sessionId, ...sessionIds]
    }
    stillPending.push({ workspaceId: item.workspaceId, sessionId: item.sessionId })
  }
  return stillPending
}

// Optimistic creation (#4c): a tap on "+" must show a row at once, so the id is
// minted locally and spliced to the front of the workspace. Both organs are
// exported and inlined into the page via `.toString()` — same pattern as
// applyPendingCreatedSessions above.
/** Insert a provisional id at the front of a sessionIds array. Pure. */
export function spliceProvisionalSession(sessionIds, localId) {
  const ids = Array.isArray(sessionIds) ? sessionIds : []
  return [localId, ...ids.filter((id) => id !== localId)]
}

/** Replace the provisional id with the real one in place; a realId the server
 * already lists wins and only the ghost is removed. Pure. */
export function reconcileProvisionalSession(sessionIds, localId, realId) {
  const ids = Array.isArray(sessionIds) ? sessionIds : []
  if (ids.includes(realId)) return ids.filter((id) => id !== localId)
  return ids.map((id) => (id === localId ? realId : id))
}

// ---- Process narration (change 2026-10-07-feat-pocket-process-render-overhaul)
// The phone narrates a turn with the Host desktop's own verb language instead of
// raw tool names. The name→category mapping lives in lib/constants.js
// (toolActivityCategory, a verbatim port of the Host's activity()); the three
// organs below are its render-side partners: they split an edit into red/green
// line rows, condense one tool call into a one-line summary, and merge a turn's
// consecutive same-category calls into one cluster card. All are exported and
// inlined into the page via `.toString()` — the applyPendingCreatedSessions
// pattern — so they must stay dependency-free and browser-safe.

/** Split two strings into the removed / added line lists of a plain line diff.
 * Common head and tail lines are trimmed first so the middle carries the whole
 * edit. No LCS and no library on purpose: the phone renders exactly what this
 * returns, and a 40-row cap lives in the renderer, not here. Pure. */
export function diffLineSplit(oldText, newText) {
  const split = (value) => String(value == null ? '' : value).replace(/\r\n?/g, '\n').split('\n')
  const oldLines = split(oldText)
  const newLines = split(newText)
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1
  let tail = 0
  while (
    tail < oldLines.length - head && tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail += 1
  return {
    del: oldLines.slice(head, oldLines.length - tail),
    add: newLines.slice(head, newLines.length - tail)
  }
}

/** One-line summary of a tool call: its primary argument, short. File paths
 * collapse to the basename, commands/code collapse whitespace and clip at 60
 * characters. Unrecognizable shapes return '' so the caller falls back to the
 * raw tool name instead of inventing one. Pure. */
export function toolSummaryLine(name, args) {
  let a = args
  if (typeof a === 'string') {
    try { a = JSON.parse(a) } catch { a = null }
  }
  if (!a || typeof a !== 'object') return ''
  const pick = (...keys) => {
    for (const key of keys) {
      const value = a[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }
  const clip = (value, at) => {
    const one = value.replace(/\s+/g, ' ')
    return one.length > at ? one.slice(0, at) + '…' : one
  }
  const path = pick('file_path', 'path', 'notebook_path', 'file', 'filename')
  if (path) return path.split(/[\\/]/).pop() || path
  const command = pick('command', 'cmd')
  if (command) return clip(command, 60)
  const code = pick('code', 'script')
  if (code) return clip(code, 60)
  const query = pick('url', 'query', 'pattern', 'q', 'description', 'prompt')
  if (query) return clip(query, 60)
  for (const key of Object.keys(a)) {
    const value = a[key]
    if (typeof value === 'string' && value.trim()) return clip(value.trim(), 60)
  }
  return ''
}

/** Merge a turn's ordered process blocks into render cards: consecutive
 * same-category tool calls become one cluster; questions and subagents stay
 * one card each (an approval and a delegation are events, not batch work to
 * count); a reasoning block passes through as its own entry and breaks a run,
 * matching the desktop's activity list. Each entry carries the original block
 * index so the fold's expansion-state keys stay stable across repaints.
 * `categorize` is injected (toolActivityCategory) to keep this pure. Pure. */
/**
 * Desktop `processTitle` port (dsh-client-ui-chat): a closed group's title is
 * the top-three tool categories' done-phrases joined WITHOUT counts —
 * "已读取文件并修改了文件" / "已读取文件，修改了文件，执行了命令等". The
 * sharedPrefix (zh 已) is stripped from the continuation when both phrases
 * start with it. Empty work falls back to the thinking phrase. Pure.
 * @param {{category: string, count: number}[]} counts ranked descending
 * @returns {string}
 */
function stepTitleFor(counts) {
  const table = typeof STEP === 'undefined' ? {} : STEP
  const done = (kind) => {
    const value = table['message.stepProcess.done.' + kind]
    return typeof value === 'string' && value ? value : ''
  }
  const ranked = (Array.isArray(counts) ? counts : [])
    .filter((entry) => entry && done(entry.category))
    .slice(0, 3)
  const first = ranked.length ? done(ranked[0].category) : done('thinking')
  if (!first) return ''
  if (ranked.length <= 1) return first
  const continuation = (label) => label.charAt(0).toLowerCase() + label.slice(1)
  const prefix = typeof table['message.stepProcess.sharedPrefix'] === 'string' ? table['message.stepProcess.sharedPrefix'] : ''
  const bare = (label) => (prefix !== '' && label.startsWith(prefix) ? label.slice(prefix.length) : label)
  if (ranked.length === 2) {
    const join = typeof table['message.stepProcess.joinTwo'] === 'string' ? table['message.stepProcess.joinTwo'] : '{first}并{second}'
    return join.replace('{first}', first).replace('{second}', continuation(bare(done(ranked[1].category))))
  }
  const comma = typeof table['message.stepProcess.comma'] === 'string' ? table['message.stepProcess.comma'] : '，'
  const title = [first, ...ranked.slice(1).map((entry) => continuation(bare(done(entry.category))))].join(comma)
  const more = typeof table['message.stepProcess.more'] === 'string' ? table['message.stepProcess.more'] : ''
  return ranked.length < (Array.isArray(counts) ? counts.length : 0) && more ? more.replace('{title}', title) : title
}
export function clusterToolBlocks(blocks, categorize) {
  const list = Array.isArray(blocks) ? blocks : []
  const out = []
  let current = null
  list.forEach((block, index) => {
    if (!block) return
    if (block.kind !== 'tool') {
      current = null
      out.push({ type: 'block', block, index })
      return
    }
    const category = categorize(block.name)
    const mergeable = category !== 'questions' && category !== 'subagents'
    if (current && current.category === category && mergeable) {
      current.items.push({ block, index })
      return
    }
    current = { type: 'cluster', category, items: [{ block, index }] }
    out.push(current)
  })
  return out
}

/** A blank row is listable only while it is fresh. A chat created moments ago
 * must stay on the list until its first message projects a title, but a
 * days-old empty shell (a desktop new-chat nobody ever typed into) is noise —
 * the R1-audit exemption that made real blank rows visible surfaced exactly
 * those, one unnamed row per workspace (reported live 2026-10-05). An
 * unparsable stamp reads as stale, so a row the page synthesized with no real
 * updatedAt never passes; a running session is never hidden by its age.
 * `freshWindowMs` comes in as an argument (BLANK_ROW_VISIBLE_MS) so the organ
 * stays pure and inlines verbatim. Pure. */
export function blankRowVisible(summary, nowMs, freshWindowMs) {
  if (summary.provisional || summary.running) return true
  const stamp = typeof summary.updatedAt === 'number'
    ? summary.updatedAt
    : Date.parse(summary.updatedAt)
  return Number.isFinite(stamp) && nowMs - stamp < freshWindowMs
}

/** The session's long-running goal state, straight out of the Host projection
 * registry (`values.goal` — the same values the desktop GoalBar reads, carried
 * identically by history pages, stream snapshots and session/projections).
 * Null when the session has no goal. Pure. */
export function goalOf(projections) {
  const values = projections && projections.values
  const goal = values && values.goal
  return goal && goal.goal ? goal : null
}

/** The queued (inbox) user messages a running session will consume on its next
 * turn, from the same projection registry the desktop QueueDock reads
 * (`values.inbox['next-turn']`). Rows are render-ready: text joins the text
 * blocks, images/files count theirs. `managed` marks rows that carry the
 * Host's real MessageId — only those may be edited/recalled/steered through
 * session.updateQueue; a synthesized fallback id (`q0`…, for items the Host
 * sent bare) is display-only. Items the Host types as loose JSON are dropped,
 * not thrown, when malformed; an item with only unrenderable blocks is
 * dropped with them. Pure. */
export function queuedRowsOf(projections) {
  const values = projections && projections.values
  const inbox = values && values.inbox
  const items = inbox && Array.isArray(inbox['next-turn']) ? inbox['next-turn'] : []
  const rows = []
  for (const item of items) {
    const content = item && Array.isArray(item.content) ? item.content : null
    if (!content) continue
    const row = {
      id: String(item.id != null ? item.id : 'q' + rows.length),
      managed: item.id != null,
      text: '',
      images: 0,
      files: 0,
    }
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') row.text += (row.text ? '\n' : '') + block.text
      else if (block.type === 'image') row.images += 1
      else if (block.type === 'file') row.files += 1
    }
    if (row.text || row.images || row.files) rows.push(row)
  }
  return rows
}

// Shared with the pairing page's shell pre-warm: after PIN verification the
// phone pre-fetches the app document into this cache under this key, so the
// post-pairing navigation is served instantly instead of re-downloading the
// whole HTML over the tunnel. Both literals must stay in sync.
//
// `SW_CACHE_NAME` is only the fallback: the bridge renders the worker with the
// digest of the current shell, so the cache name changes whenever this file
// does. A fixed name would keep the old document in Cache Storage across an
// update — activate() only evicts keys that differ from its own — and the phone
// would be served the previous build once more after a restart (observed live
// 2026-10-02: the fixed page was on disk but the phone kept painting the old
// one). Anything that is not a safe literal falls back to the name below.
const SW_CACHE_NAME = 'pocket-v3'
const SW_SHELL_KEY = '/__shell__'
// Tab-scoped handoff slot: the pairing page fetches the conversation payload
// (workspaces + session list + the focus turn) and leaves the JSON here; the app
// document picks it up on its first frame. Keeping it in the tab's own memory
// means no browser cache, no service worker and no second payload download stand
// between the handoff and the conversation being on screen.
const POCKET_BOOT_KEY = 'dsh-pocket-boot'
// Set once the browser has refused the shell worker, so later opens in the same
// tab stop paying for a registration that cannot succeed.
const POCKET_NO_SW_KEY = 'dsh-pocket-no-sw'
// How many of the newest sessions the handoff's "syncing session list" stage
// pulls. Enough to prove the list is reachable and to show a list immediately if
// the user goes back; the list view refreshes itself anyway.
const SESSION_LIST_PREFETCH = 30
// How long a message-less (blank:true) session stays a visible row on the
// workspace list. The R1-audit exemption made real blank rows visible so a chat
// created on this phone stays on screen until its first message projects a
// title — but it also surfaced days-old empty shells the desktop leaves behind
// (a new-chat nobody ever typed into), one unnamed row per workspace (reported
// live 2026-10-05). Freshness is the discriminant: a just-created chat is fresh,
// an abandoned shell is not. 24h comfortably covers create→first-message on a
// phone, and a session reappears the moment it has content because non-blank
// rows never meet the rule. Exported for the tests that inline the page script.
export const BLANK_ROW_VISIBLE_MS = 24 * 60 * 60 * 1000

/**
 * The PWA manifest served at /manifest.json. Icon sizes must describe what the
 * /app-icon route actually serves — the raw appIconPath file, whose real pixel
 * size was measured at apply time (2026-10-05, 1024x1024) — so a device does
 * not reject the install for a lie. If the bundled icon ever changes, measure
 * again and change the literal here and in the manifest test together.
 */
export function renderManifestJson() {
  return JSON.stringify({
    name: 'DSH Pocket',
    short_name: 'Pocket',
    start_url: '/',
    display: 'standalone',
    theme_color: '#141416',
    background_color: '#141416',
    icons: [{ src: '/app-icon', sizes: '1024x1024', type: 'image/png', purpose: 'any' }]
  })
}

export function renderServiceWorker(build) {
  // App-shell cache. A cold open paints the cached shell (with its last boot
  // snapshot) instantly, then revalidates the shell and reconciles data via
  // /api/boot. Only documents carrying the x-pocket-cache marker are stored,
  // so reconnect/pair pages never replace the shell. API and pairing routes
  // always pass through to the network.
  const cacheName =
    typeof build === 'string' && /^[a-z0-9][a-z0-9._-]{0,47}$/i.test(build)
      ? `pocket-${build}`
      : SW_CACHE_NAME
  // The offline page is a string, not a route: the bridge serves no /offline.html,
  // so the worker precaches the document itself at install time. Zero external
  // resources (no icon, no font, no script beyond the inline reconnect watcher) —
  // a page shown precisely because the network is gone must not need it.
  const offlineHtml =
    '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="theme-color" content="#141416"><title>DSH Pocket</title>' +
    '<style>:root{color-scheme:dark}html,body{height:100%}body{margin:0;display:grid;place-items:center;background:#141416;color:#f5f5f6;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;padding:24px}' +
    '.brand{font-size:13px;font-weight:600;opacity:.7;letter-spacing:.01em}h1{margin:14px 0 6px;font-size:19px;font-weight:650}p{margin:0;color:#95979d;font-size:13.5px}' +
    'button{margin-top:22px;height:44px;padding:0 26px;border:1px solid #303034;border-radius:12px;background:#1d1d20;color:#f5f5f6;font:inherit;font-weight:600}' +
    'button:active{background:#29292d}</style></head><body><main>' +
    '<div class="brand">DSH Pocket</div><h1>网络不可用</h1>' +
    '<p>Network unavailable · 恢复连接后自动重开</p>' +
    '<button type="button" onclick="location.reload()">重试 Retry</button>' +
    '</main><script>addEventListener("online",function(){location.reload()})<\/script></body></html>'
  return `// DSH Pocket service worker
const V='${cacheName}', SHELL='${SW_SHELL_KEY}', OFFLINE='/__offline__';
const BYPASS=/^\\/(api|pair|desktop|reconnect|disconnected|consent)(\\/|$)/;
const OFFLINE_HTML=${JSON.stringify(offlineHtml)};
self.addEventListener('install',(event)=>{event.waitUntil((async()=>{const cache=await caches.open(V);await cache.put(OFFLINE,new Response(OFFLINE_HTML,{headers:{'content-type':'text/html; charset=utf-8'}}))})());self.skipWaiting()});
self.addEventListener('activate',(event)=>{event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter((k)=>k!==V).map((k)=>caches.delete(k)));await self.clients.claim()})())});
async function revalidateShell(){const cache=await caches.open(V);const res=await fetch('/?revalidate=1',{cache:'no-store'});if(res.ok&&res.headers.get('x-pocket-cache')==='app')await cache.put(SHELL,res.clone());return res}
async function offlineFallback(){const cache=await caches.open(V);return (await cache.match(OFFLINE))||new Response('offline',{status:503})}
self.addEventListener('fetch',(event)=>{
  const req=event.request;if(req.method!=='GET')return;
  const url=new URL(req.url);if(url.origin!==self.location.origin||BYPASS.test(url.pathname))return;
  // The app document is owned by the navigate branch below (shell) and by the
  // browser cache the handoff fills — a generic Cache Storage hit here could
  // hand the page a document from an earlier pairing.
  if(url.pathname==='/'){
    // Network first (this also revalidates the cached shell); when the device is
    // unreachable the precached offline page answers instead. The cached shell is
    // deliberately NOT served here: booting the app into a dead transcript reads
    // as a hang, while the offline page says plainly what happened.
    event.respondWith(revalidateShell().catch(offlineFallback));
    return;
  }
  if(req.mode==='navigate'){
    event.respondWith((async()=>{
      const cache=await caches.open(V);const cached=await cache.match(SHELL);
      event.waitUntil(revalidateShell().catch(()=>{}));
      if(cached)return cached;
      try{return await revalidateShell()}catch{return offlineFallback()}
    })());
    return;
  }
  event.respondWith((async()=>{
    const cache=await caches.open(V);const hit=await cache.match(req);
    const network=fetch(req).then((res)=>{if(res.ok)cache.put(req,res.clone());return res}).catch(()=>hit);
    return hit||network;
  })());
});`
}

/**
 * JSON safe to place inside an inline <script> body.
 *
 * A session summary, a title or a copy string that happens to contain
 * `</script>` would otherwise close the tag early and spill the rest of the
 * payload onto the screen as text — which is exactly what happened on
 * 2026-10-01, when a session summary quoted this plugin's own source. JSON has
 * no `<` outside string literals, so escaping it keeps the value identical
 * while making the markup unambiguous. U+2028/9 are escaped for the same
 * reason (line separators are legal in JSON strings but not in JS source).
 *
 * @param {unknown} value
 * @returns {string}
 */
function scriptJson(value) {
  return escapeScriptJson(JSON.stringify(value))
}

/**
 * @param {string} json
 * @returns {string}
 */
function escapeScriptJson(json) {
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * The document's two static blocks, exactly as they are rendered inline.
 *
 * They are pulled out of a real render rather than duplicated, so the asset the
 * phone caches is byte-identical to the one that used to travel inside every
 * page. The measured weights and the per-locale ceiling are deliberately not
 * recorded here — they live in test/mobile-assets.test.js (ASSET_BUDGET_BYTES
 * and its live-value assertion message). Raise the ceiling there when the shell
 * must grow.
 *
 * @param {{locale?: string}} [options]
 * @returns {{ css: string, js: string }}
 */
export function mobilePageAssets(options = {}) {
  return mobileBlocks(options.locale === 'en' ? 'en' : 'zh')
}

/** @type {Map<string, { css: string, js: string, document: string }>} */
const mobileBlockCache = new Map()

function mobileBlocks(locale) {
  const cached = mobileBlockCache.get(locale)
  if (cached) return cached
  const document = renderMobileDocument({ locale })
  const css = document.match(/<style>([\s\S]*?)<\/style>/)
  const scripts = [...document.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  const blocks = {
    css: css ? css[1] : '',
    js: scripts.length ? scripts[scripts.length - 1][1] : '',
    document
  }
  mobileBlockCache.set(locale, blocks)
  return blocks
}

/**
 * The app document. With `assets` the two static blocks are referenced instead
 * of inlined, so a repeat open only pays for the markup and the boot payload —
 * and a bootstrap snippet re-fetches either block when the cached copy arrived
 * mangled (the phone has done exactly that to an HTML document before).
 *
 * @param {{locale: string, boot?: string|null, icon?: string|null, initialChat?: boolean, assets?: {jsUrl: string, cssUrl: string}|null, nonce?: string}} options
 */
export function renderMobilePage({ locale, boot = null, icon = null, initialChat = false, assets = null, nonce = null }) {
  const nonceAttr = nonce ? ` nonce="${escapeHtml(nonce)}"` : ''
  const document = renderMobileDocument({ locale, boot, icon, initialChat, nonce })
  if (!assets) return document
  const style = document.match(/<style>[\s\S]*?<\/style>/)
  const scripts = [...document.matchAll(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/g)]
  const main = scripts.length ? scripts[scripts.length - 1] : null
  if (!style || !main) return document
  const bootstrap = [
    `<script${nonceAttr}>(function(){`,
    'var js=' + scriptJson(assets.jsUrl) + ',css=' + scriptJson(assets.cssUrl) + ';',
    'var bust="&fresh="+Date.now();',
    'var styled=getComputedStyle(document.documentElement).getPropertyValue("--brand").trim().length>0;',
    'if(window.__pocketAppReady!==true){var s=document.createElement("script");s.src=js+bust;document.body.appendChild(s)}',
    'if(!styled){var l=document.createElement("link");l.rel="stylesheet";l.href=css+bust;document.head.appendChild(l)}',
    '})()</script>'
  ].join('')
  return document
    .replace(style[0], `<link rel="stylesheet" href="${assets.cssUrl}">`)
    .replace(main[0], `<script src="${assets.jsUrl}"></script>${bootstrap}`)
}

/**
 * @param {{locale: string, boot?: string|null, icon?: string|null, initialChat?: boolean, nonce?: string}} options
 */
function renderMobileDocument({ locale, boot = null, icon = null, initialChat = false, nonce = null }) {
  const zh = /^zh/i.test(String(locale || ''))
  const nonceAttr = nonce ? ` nonce="${escapeHtml(nonce)}"` : ''
  const bootScript = boot
    ? `<script${nonceAttr}>window.__POCKET_BOOT__=${escapeScriptJson(boot)}</script>`
    : ''
  return `<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme:light)">
  <meta name="theme-color" content="#141416" media="(prefers-color-scheme:dark)">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="DSH Pocket">
  <link rel="icon" href="${icon || '/app-icon'}">
  <link rel="apple-touch-icon" href="${icon || '/app-icon'}">
  <link rel="manifest" href="/manifest.json">
  <title>DSH Pocket</title>
  <style>
    :root{color-scheme:light;--paper:#fff;--ink:#18191c;--muted:#6b7076;--line:#e5e7eb;--card:#fff;--hover:#f2f3f5;--surface:#f7f7f5;--brand:#4d6bfe;--danger:#c62f3c;--tunnel-warn-h:0px;--todo-h:0px;--queue-h:0px;--composer-h:64px}
    @media(prefers-color-scheme:dark){:root{color-scheme:dark;--paper:#141416;--ink:#f5f5f6;--muted:#95979d;--line:#303034;--card:#1d1d20;--hover:#29292d;--surface:#202023;--brand:#6f86ff;--danger:#ff9ba1}}
    *{box-sizing:border-box}html,body{height:100%;overflow:hidden}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    button,input,textarea,select{font:inherit}.shell{max-width:760px;height:var(--app-height,100dvh);margin:auto;padding:calc(6px + env(safe-area-inset-top)) 14px calc(8px + env(safe-area-inset-bottom));display:flex;flex-direction:column}
    header{height:48px;display:flex;flex:none;align-items:center;justify-content:space-between;padding:0 3px}.brand{font-size:15px;font-weight:600;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}.status{width:8px;height:8px;border-radius:50%;margin-right:4px;background:#35a867;box-shadow:0 0 0 0 rgba(53,168,103,.42);animation:connectedPulse 1.8s ease-out infinite}.status.connecting{background:var(--muted);animation:none}.status.error-state{background:#e34d59;animation:none}.status.degraded{background:#c08400;animation:none}.status-text{flex:none;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:1.25;color:var(--muted);text-align:right}@keyframes connectedPulse{70%{box-shadow:0 0 0 7px rgba(53,168,103,0)}100%{box-shadow:0 0 0 0 rgba(53,168,103,0)}}
    .view{display:none;min-height:0}.view.active{display:flex;flex:1;flex-direction:column}.toolbar{display:flex;flex:none;gap:8px;align-items:center;padding:12px 0}.toolbar select{flex:1;min-width:0}#sessionsView{padding-top:2px}.workspaces{display:grid;grid-auto-rows:min-content;gap:10px;flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:2px 0 14px}.ws-card{border:1px solid var(--line);border-radius:16px;background:var(--card);overflow:hidden}.ws-head{display:flex;align-items:center;gap:2px}.ws-toggle{flex:1;min-width:0;display:flex;align-items:center;gap:7px;text-align:left;background:transparent;border:0;padding:11px 4px 11px 12px}.ws-chevron{flex:none;display:grid;place-items:center;color:var(--muted);transition:transform .2s ease}.ws-card.expanded .ws-chevron{transform:rotate(90deg)}.ws-name{min-width:0;flex:1;font-size:15px;font-weight:620;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}.ws-last{flex:none;display:grid;place-items:center}.ws-last svg{width:16px;height:16px}.ws-last.is-running{color:var(--brand)}.ws-last.is-done{color:#35a867}.ws-last.is-blank{color:var(--muted)}.ws-last.is-awaiting{color:#c08400}.ws-last.is-unknown{color:var(--muted)}.ws-last.is-error{color:var(--danger)}.ws-last-time{flex:none;color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}.msg-tail{display:block;margin-top:6px;color:var(--muted);font-size:11px;line-height:1.4;font-variant-numeric:tabular-nums}.message.user .msg-tail{text-align:right}.usage-pill{display:inline-block;margin-right:8px;padding:1px 8px;border:1px solid var(--line);border-radius:999px}.ws-new{flex:none;display:grid;place-items:center;width:44px;height:44px;margin-right:9px;border-radius:50%;border:1px solid var(--line);background:var(--surface);color:var(--ink)}.ws-new:active{background:var(--hover)}.ws-body{display:none;padding:0 9px 10px}.ws-card.expanded .ws-body{display:block}.task-list{display:grid;gap:7px}.task-row{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;text-align:left;border:1px solid transparent;border-radius:12px;padding:9px 10px;background:var(--surface)}.task-row:active{background:var(--hover)}.task-status{flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:50%}.task-copy{min-width:0;flex:1}.task-copy strong{display:block;font-size:13.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.task-copy time{display:block;margin-top:1px;color:var(--muted);font-size:10.5px;font-variant-numeric:tabular-nums}.task-row.is-running .task-status{color:var(--brand)}.task-row.is-done .task-status{color:#35a867}.task-row.is-blank .task-status{color:var(--muted)}.task-row.is-error{background:color-mix(in srgb,#e34d59 10%,var(--surface))}.task-row.is-error .task-status,.task-row.is-error .task-copy strong{color:var(--danger)}.task-row.is-awaiting{background:#fdf3d3}.task-row.is-awaiting .task-status{color:#c08400}.is-running .spin{animation:spin .8s linear infinite}@media (prefers-color-scheme:dark){.task-row.is-awaiting{background:rgba(201,138,4,.17)}.task-row.is-awaiting .task-copy strong{color:#f0c56b}}.ws-empty{padding:13px 10px;color:var(--muted);font-size:12px;line-height:1.5;text-align:center}body.chat-open header{display:none}body.chat-open .shell{padding:env(safe-area-inset-top) 14px 0}#chatView{position:relative}.chat-toolbar{position:absolute;inset:0 0 auto;z-index:2;min-height:44px;padding:0;background:transparent;pointer-events:none}.back{display:grid;place-items:center;flex:none;width:44px;height:44px;border:1px solid var(--line)!important;border-radius:50%;padding:0!important;background:var(--card)!important;box-shadow:0 2px 8px rgba(0,0,0,.06);pointer-events:auto}.back:hover{background:var(--hover)!important}.back svg{display:block}
    select,button,textarea{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:10px 12px}button{cursor:pointer;-webkit-tap-highlight-color:transparent}button:hover{background:var(--hover)}button.primary{display:flex;align-items:center;justify-content:center;gap:6px;flex:none;min-width:68px;height:44px;border:1px solid var(--ink);border-radius:13px;padding:0 11px 0 13px;background:var(--ink);color:var(--paper);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--paper) 10%,transparent),0 2px 5px rgba(0,0,0,.14);transition:transform .14s ease,opacity .14s ease,box-shadow .14s ease}.primary svg{display:block;flex:none}.primary:hover:not(:disabled){background:var(--ink);opacity:.88;transform:translateY(-1px)}.primary:active:not(:disabled){transform:translateY(0);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--paper) 8%,transparent),0 1px 2px rgba(0,0,0,.12)}.primary:disabled{cursor:default;border-color:var(--line);background:var(--surface);color:var(--muted);box-shadow:none}button.quiet{background:transparent}
.messages{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:0;padding:18px 4px}.chat-open .messages{padding-top:4px;padding-bottom:calc(var(--composer-h) + var(--todo-h) + var(--queue-h) + var(--tunnel-warn-h))}.messages::before{content:'';flex:none;margin-top:auto}.message{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink);line-height:1.65}.message.user{align-self:flex-end;max-width:82%;background:var(--hover);border-radius:22px;padding:9px 15px;margin:8px 0 14px}.message.assistant{align-self:stretch;padding:0 4px;margin:0}.message.assistant+.message.assistant{margin-top:12px}.message .role{display:none}
    .markdown{white-space:normal}.markdown>*:first-child{margin-top:0}.markdown>*:last-child{margin-bottom:0}.markdown p{margin:0 0 10px}.markdown h1,.markdown h2,.markdown h3{line-height:1.3;margin:18px 0 8px}.markdown h1{font-size:22px}.markdown h2{font-size:19px}.markdown h3{font-size:16px}.markdown ul{margin:8px 0;padding-left:22px}.markdown pre{overflow:auto;background:var(--hover);border:1px solid var(--line);border-radius:10px;padding:12px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.markdown code{background:var(--hover);border-radius:5px;padding:2px 5px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}.markdown pre code{padding:0;background:none}.markdown a{color:var(--brand)}.table-wrap{width:100%;overflow-x:auto;margin:10px 0;-webkit-overflow-scrolling:touch}.markdown table{width:100%;min-width:420px;border-collapse:collapse;font-size:13px;line-height:1.5}.markdown th,.markdown td{padding:9px 10px;border:1px solid var(--line);text-align:left;vertical-align:top}.markdown th{background:var(--hover);font-weight:600}.thinking,.tool{position:relative;margin:0;white-space:normal}.thinking summary,.tool summary{position:relative;min-height:34px;cursor:pointer;list-style:none;border-radius:6px;padding:5px 2px;color:var(--ink);font-size:14px;line-height:24px;display:flex;align-items:center;gap:0;overflow:hidden}.thinking summary:hover,.tool summary:hover{background:var(--hover)}.thinking summary::-webkit-details-marker,.tool summary::-webkit-details-marker{display:none}.activity-leading{width:16px;height:16px;display:grid;place-items:center;flex:none;margin-right:6px;color:var(--muted)}.activity-leading svg{display:block}.activity-title{flex:none;font-weight:400}.activity-dot{width:2px;height:2px;margin:0 8px;border-radius:50%;background:var(--muted);opacity:.7;flex:none}.activity-summary{position:relative;min-width:0;flex:1;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.activity-chevron{width:16px;height:16px;display:grid;place-items:center;flex:none;color:var(--muted);transition:transform .14s ease}.thinking[open] .activity-chevron,.tool[open] .activity-chevron{transform:rotate(90deg)}.thinking-body{padding:3px 0 7px 22px;color:var(--muted);font-size:13px;line-height:22px}.tool-body{padding:3px 0 8px 20px;color:var(--muted);font-size:12px}.tool-body strong{display:block;margin:7px 0 3px;font-weight:500}.tool-status.error,.tool[data-state=error] .activity-leading{color:var(--danger)}.tool pre{max-height:260px;white-space:pre-wrap;overflow:auto;overflow-wrap:anywhere;margin:0 0 4px;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:10px;padding:10px 12px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.thinking[data-state=running] .activity-summary:after,.tool[data-state=running] .activity-summary:after{content:'';position:absolute;inset:0 auto 0 -240px;width:240px;pointer-events:none;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--paper) 72%,transparent),transparent);animation:activitySweep 2.6s ease-out infinite}.streaming:after{content:' ';display:inline-block;width:6px;height:15px;margin-left:2px;vertical-align:-2px;background:var(--brand);animation:pulse .7s infinite alternate}.turn-status{height:26px;display:inline-flex;align-items:center;margin:0 4px 6px;pointer-events:none;color:transparent;-webkit-text-fill-color:transparent;background:linear-gradient(90deg,var(--brand) 0%,var(--brand) 40%,color-mix(in srgb,var(--brand) 35%,var(--paper)) 50%,var(--brand) 60%,var(--brand) 100%);background-position:100% 0;background-size:250% 100%;-webkit-background-clip:text;background-clip:text;font-size:14px;font-weight:600;white-space:nowrap;animation:deepDiveShimmer 1.8s linear infinite}
    .turn-process{position:relative;margin:2px 0 4px;white-space:normal;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.turn-process>summary{position:relative;min-height:36px;cursor:pointer;list-style:none;border-radius:12px;padding:6px 10px;color:var(--ink);font-size:14px;line-height:24px;display:flex;align-items:center;gap:0;overflow:hidden}.turn-process>summary:hover{background:var(--hover)}.turn-process>summary::-webkit-details-marker{display:none}.turn-process-body{padding:4px 10px 8px;border-top:1px solid var(--line)}.turn-process-body .thinking,.turn-process-body .tool{margin:2px 0;padding-left:10px;border-left:2px solid var(--line)}.turn-process-live{margin:2px 0}.turn-process-live .thinking,.turn-process-live .tool{margin:2px 0}
    /* Process narration (2026-10-07-feat-pocket-process-render-overhaul): cluster
       cards, per-call rows, the raw-details fold, and red/green diff rows. Tokens
       only — both color schemes feed the same vars, so dark needs no second rule. */
    .change-cluster .cluster-rows{margin:2px 0 4px}.cluster-row{display:flex;align-items:center;gap:8px;min-height:30px;border-top:1px solid var(--line);padding:4px 2px;color:var(--ink)}.cluster-row:first-child{border-top:0}.cluster-row.is-error .cluster-row-text{color:var(--danger)}.cluster-row-text{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}details.cluster-row{display:block}details.cluster-row>summary{min-height:30px;cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;padding:4px 2px;border-radius:6px}details.cluster-row>summary::-webkit-details-marker{display:none}details.cluster-row>summary:active{background:var(--hover)}details.cluster-row[open]>summary .cluster-row-text{white-space:normal}.cluster-row-body{padding:2px 2px 6px}.cluster-row-state{flex:none;color:var(--danger);font-size:11px}.tool-diff{margin:2px 0 6px;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--surface)}.diff-line{display:flex;gap:7px;padding:2px 9px;font:11.5px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-all;color:var(--ink)}.diff-mark{flex:none;-webkit-user-select:none;user-select:none;opacity:.75}.diff-line-del{background:color-mix(in srgb,#e34d59 12%,var(--surface))}.diff-line-del .diff-mark{color:var(--danger);font-weight:600}.diff-line-add{background:color-mix(in srgb,#35a867 15%,var(--surface))}.diff-line-add .diff-mark{color:#35a867;font-weight:600}.diff-elide{justify-content:center;color:var(--muted);background:var(--hover);font:11px/1.9 ui-monospace,SFMono-Regular,Menlo,monospace}.tool-raw{margin-top:6px;border-top:1px dashed var(--line)}.tool-raw>summary{min-height:28px;cursor:pointer;list-style:none;display:flex;align-items:center;color:var(--muted);font-size:11px}.tool-raw>summary::-webkit-details-marker{display:none}.tool-raw>summary:active{color:var(--ink)}
    #messages.pulling,#messages.animating{will-change:transform}#messages.animating{transition:transform .24s cubic-bezier(.22,1,.36,1)}#chatView{position:relative}#pullHint{position:absolute;left:0;right:0;top:8px;z-index:3;display:flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:0 16px;color:var(--muted);font-size:12px;line-height:1.4;text-align:center;pointer-events:none;opacity:0;transform:translateY(-6px);transition:opacity .18s ease,transform .18s ease}#pullHint.visible{opacity:1;transform:translateY(0)}#pullHint.armed{color:var(--brand)}#pullHint .older-spin{display:none}#pullHint.loading .older-spin{display:inline-block}#pullHint.visible+#messages>.older-row{display:none}
    [hidden]{display:none!important}.message:empty{display:none}.composer{position:fixed;z-index:2;left:50%;bottom:0;transform:translateX(-50%);will-change:transform;width:min(760px,100%);padding:10px 14px calc(5px + env(safe-area-inset-bottom));background:linear-gradient(to bottom,transparent 0%,color-mix(in srgb,var(--paper) 55%,transparent) 38%,var(--paper) 100%);pointer-events:none}.composer-inner{min-height:58px;display:flex;gap:8px;align-items:flex-end;border:1px solid var(--line);border-radius:23px;padding:8px 8px 8px 16px;background:var(--card);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--paper) 70%,transparent),0 2px 8px rgba(0,0,0,.06),0 14px 34px rgba(0,0,0,.06);pointer-events:auto;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}.composer-inner:focus-within{border-color:color-mix(in srgb,var(--ink) 28%,var(--line));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--paper) 72%,transparent),0 3px 10px rgba(0,0,0,.08),0 18px 38px rgba(0,0,0,.08)}.composer textarea{flex:1;height:44px;min-height:44px;max-height:150px;overflow-y:auto;resize:none;border:0;outline:0;border-radius:0;padding:9px 0;background:transparent;color:var(--ink);caret-color:var(--brand);font-size:16px;letter-spacing:-.01em}.composer textarea::placeholder{color:var(--muted);opacity:.68}.composer .primary,.primary.cancel{width:44px;min-width:44px;border-radius:50%;padding:0;background:var(--ink);border-color:var(--ink)}.settings-trigger{display:grid;place-items:center;width:44px;min-width:44px;height:44px;border-radius:50%;padding:0;background:var(--surface);color:var(--muted)}.settings-trigger[aria-expanded=true]{border-color:var(--ink);background:var(--ink);color:var(--paper)}.session-settings{position:absolute;right:8px;bottom:calc(76px + var(--tunnel-warn-h));width:min(350px,calc(100vw - 28px));max-height:min(62vh,470px);overflow-y:auto;border:1px solid var(--line);border-radius:18px;padding:15px;background:var(--card);box-shadow:0 8px 26px rgba(0,0,0,.1),0 24px 60px rgba(0,0,0,.12);pointer-events:auto}.settings-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.settings-head strong{font-size:15px;font-weight:650}.settings-close{display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:50%;padding:0;background:transparent;color:var(--muted);font-size:20px;line-height:1}.setting-field{display:block;margin-top:12px}.setting-field>span{display:block;margin:0 2px 5px 13px;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.03em}.setting-pick{width:100%;height:46px;display:flex;align-items:center;gap:8px;padding:0 12px 0 13px;border:1px solid var(--line);border-radius:13px;background:var(--surface);color:var(--ink);font-size:15px;font-weight:550;letter-spacing:-.01em;text-align:left}.setting-pick>span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.setting-pick i{flex:none;width:6px;height:6px;border-right:1.6px solid var(--muted);border-bottom:1.6px solid var(--muted);transform:rotate(45deg) translateY(-3px)}.setting-pick:active{background:var(--hover)}.setting-pick[aria-expanded=true]{border-color:color-mix(in srgb,var(--ink) 32%,var(--line));background:var(--card)}.setting-pick[disabled]{opacity:.55}.setting-list{margin-top:6px;max-height:min(42vh,300px);overflow-y:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--line);border-radius:13px;background:var(--card)}.setting-group{display:block;padding:9px 12px 3px;color:var(--muted);font-size:11px;font-weight:600}.setting-opt{width:100%;min-height:44px;display:flex;align-items:center;gap:8px;padding:0 12px;border:0;border-top:1px solid var(--line);border-radius:0;background:transparent;color:var(--ink);font-size:15px;text-align:left}.setting-group:first-child,.setting-group+.setting-opt,.setting-opt:first-child{border-top:0}.setting-opt:active{background:var(--hover)}.setting-opt.is-on{color:var(--brand);font-weight:600}.setting-opt.is-on::after{content:'✓';margin-left:auto;font-size:13px}.setting-note{margin:5px 2px 0;color:var(--muted);font-size:11px;line-height:1.4}.settings-error{min-height:17px;margin-top:7px;color:var(--danger);font-size:11px}.settings-loading{padding:14px 2px;color:var(--muted);font-size:12px}.todo-dock{margin:0 0 8px;border:1px solid var(--line);border-radius:14px;background:var(--surface);overflow:hidden;pointer-events:auto}.goal-bar{flex:none;display:flex;gap:8px;align-items:baseline;margin:44px 0 6px;border:1px solid var(--line);border-radius:14px;background:var(--surface);padding:9px 12px}.goal-bar.is-blocked{border-color:var(--danger)}.goal-phase{flex:none;font-size:11px;color:var(--brand);border:1px solid var(--line);border-radius:999px;padding:1px 8px}.goal-phase.is-blocked{color:var(--danger)}.goal-objective{min-width:0;flex:1;font-size:13px;font-weight:620;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.goal-rounds{flex:none;color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}.goal-actions{flex:none;display:flex;gap:2px}.goal-bar.is-editing{display:block}.goal-bar .queue-edit-box{margin-bottom:2px}.queue-dock{flex:none;margin:0 0 8px;border:1px solid var(--line);border-radius:14px;background:var(--surface);overflow:hidden;pointer-events:auto}.queue-header{display:flex;gap:7px;align-items:center;padding:8px 12px 0}.queue-title{font-size:12.5px;font-weight:620}.queue-count{color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}.queue-list{display:grid;gap:6px;max-height:180px;overflow-y:auto;padding:7px 12px 9px}.queue-item{min-width:0;display:flex;gap:7px;align-items:baseline;border:1px solid var(--line);border-radius:10px;padding:6px 9px;background:var(--card)}.queue-text{min-width:0;flex:1;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.queue-chip{flex:none;color:var(--muted);font-size:11px}.queue-actions{flex:none;display:flex;gap:2px}.queue-act{flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:8px;border:0;background:transparent;color:var(--muted)}.queue-act:active{background:var(--hover);color:var(--ink)}.queue-act.is-danger{color:var(--danger)}.queue-act[disabled]{opacity:.4}.composer .queue-edit-box{width:100%;min-height:64px;resize:vertical;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);padding:8px 9px;font:inherit;font-size:13px;line-height:1.45}.queue-edit-row{display:flex;gap:8px;justify-content:flex-end;padding:2px 1px 0}.queue-item.is-editing{display:block}.queue-edit-btn{border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink);padding:5px 14px;font:inherit;font-size:12.5px}.queue-edit-btn.is-primary{background:var(--brand);border-color:var(--brand);color:#fff}.queue-edit-btn[disabled]{opacity:.4}.todo-header{width:100%;height:44px;display:flex;align-items:center;gap:8px;border:0;border-radius:0;padding:0 11px;background:transparent;text-align:left}.todo-lead,.todo-chevron{display:grid;place-items:center;flex:none;color:var(--muted)}.todo-title{flex:none;font-size:13px;font-weight:600}.todo-progress{min-width:0;flex:1;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.todo-list{display:grid;gap:7px;max-height:180px;overflow-y:auto;margin:0;padding:1px 12px 10px;list-style:none}.todo-item{min-width:0;display:flex;align-items:center;gap:9px;color:var(--muted);font-size:13px}.todo-glyph{display:grid;place-items:center;width:16px;height:16px;flex:none}.todo-item[data-status=completed] .todo-glyph{color:#35a867}.todo-item[data-status=in_progress] .todo-glyph{color:var(--brand);animation:spin 1s linear infinite}.todo-content{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.turn-running .messages{padding-bottom:calc(116px + var(--queue-h) + var(--tunnel-warn-h))}.todo-open .messages{padding-bottom:calc(130px + var(--queue-h) + var(--tunnel-warn-h))}.turn-running.todo-open .messages{padding-bottom:calc(162px + var(--queue-h) + var(--tunnel-warn-h))}.todo-expanded .messages{padding-bottom:min(42vh,calc(300px + var(--queue-h) + var(--tunnel-warn-h)))}.turn-running.todo-expanded .messages{padding-bottom:min(42vh,calc(332px + var(--queue-h) + var(--tunnel-warn-h)))}.primary[hidden]{display:none}.question-composer{position:absolute;z-index:3;inset:auto 0 0;padding:10px 0 5px;pointer-events:none}.question-shell{max-height:min(70vh,580px);display:flex;flex-direction:column;border:1px solid var(--line);border-radius:23px;background:var(--card);box-shadow:0 4px 16px rgba(0,0,0,.08),0 22px 54px rgba(0,0,0,.1);overflow:hidden;pointer-events:auto}.question-top{display:flex;align-items:center;gap:9px;flex:none;padding:13px 16px 10px;border-bottom:1px solid var(--line)}.question-mark{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;background:var(--surface);color:var(--ink)}.question-context{min-width:0;flex:1}.question-context strong{display:block;font-size:13px;font-weight:650}.question-context span{display:block;color:var(--muted);font-size:11px}.question-close{width:44px;height:44px;display:grid;place-items:center;border:0;border-radius:50%;padding:0;background:transparent;color:var(--muted)}.question-body{min-height:0;overflow-y:auto;padding:14px 16px 4px;-webkit-overflow-scrolling:touch}.question-title{margin:0;font-size:17px;line-height:1.45;letter-spacing:-.015em;font-weight:620}.question-detail{margin-top:7px;color:var(--muted);font-size:13px}.question-options{display:grid;gap:7px;margin-top:13px}.question-option{width:100%;display:flex;align-items:flex-start;gap:10px;border:1px solid var(--line);border-radius:13px;padding:10px 11px;background:var(--card);text-align:left}.question-option.selected{border-color:var(--ink);background:var(--surface)}.option-control{display:grid;place-items:center;width:19px;height:19px;flex:none;margin-top:1px;border:1px solid var(--muted);border-radius:50%;font-size:11px}.multi .option-control{border-radius:6px}.question-option.selected .option-control{border-color:var(--ink);background:var(--ink);color:var(--paper)}.option-copy{min-width:0;flex:1}.option-label{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:14px}.recommendation{border-radius:999px;background:var(--surface);color:var(--muted);padding:1px 6px;font-size:10px}.option-description{display:block;margin-top:2px;color:var(--muted);font-size:12px;line-height:1.45}.custom-label{display:block;margin:13px 1px 5px;color:var(--muted);font-size:11px;font-weight:600}.question-custom{width:100%;min-height:54px;max-height:110px;resize:vertical;border:1px solid var(--line);border-radius:13px;padding:10px 11px;background:var(--surface);outline:none}.question-custom:focus{border-color:color-mix(in srgb,var(--ink) 35%,var(--line))}.question-error{min-height:18px;padding:5px 16px 0;color:var(--danger);font-size:11px}.question-actions{display:flex;align-items:center;gap:7px;flex:none;padding:8px 12px 12px}.question-actions button{height:38px;padding:0 12px;border-radius:11px}.question-actions .spacer{flex:1}.question-actions .submit-answer{border-color:var(--ink);background:var(--ink);color:var(--paper);font-weight:600}.question-actions button:disabled{opacity:.45;cursor:default}.question-open .messages{padding-bottom:min(64vh,520px)}.error{color:var(--danger);font-size:13px;margin:8px 0}#chatError{position:fixed;left:50%;bottom:calc(var(--composer-h) + var(--todo-h) + var(--queue-h) + var(--tunnel-warn-h));transform:translateX(-50%);z-index:4;width:max-content;max-width:min(688px,calc(100% - 28px));margin:0;padding:9px 40px 9px 13px;border:1px solid color-mix(in srgb,#e34d59 35%,var(--line));border-radius:13px;background:color-mix(in srgb,#e34d59 9%,var(--card));color:#d23b47;font-size:12.5px;line-height:1.45;word-break:break-word;box-shadow:0 6px 18px rgba(0,0,0,.08)}#chatError:empty{display:none}.reconnect-bar{position:fixed;left:0;right:0;top:0;z-index:3;padding:calc(4px + env(safe-area-inset-top)) 14px 4px;text-align:center;font-size:11.5px;line-height:1.4;color:var(--muted);background:color-mix(in srgb,var(--paper) 70%,transparent);border-bottom:1px solid var(--line);pointer-events:none}.turn-error-bubble{display:flex;gap:9px;align-items:flex-start;margin:10px 0;padding:11px 13px;border:1px solid color-mix(in srgb,#e34d59 35%,var(--line));background:color-mix(in srgb,#e34d59 9%,var(--card));border-radius:14px;color:#d23b47}.turn-error-bubble svg{flex:none;margin-top:1px}.turn-error-text{display:flex;flex-direction:column;gap:2px;min-width:0}.turn-error-title{font-size:14px;font-weight:600}.turn-error-detail{font-size:13px;line-height:1.45;word-break:break-word;opacity:.85}.toast{position:fixed;left:50%;top:calc(64px + env(safe-area-inset-top));z-index:5;transform:translate(-50%,-8px);background:var(--ink);color:var(--paper);border-radius:999px;padding:6px 11px;font-size:12px;opacity:0;pointer-events:none;transition:.18s ease}.toast.show{opacity:1;transform:translate(-50%,0)}.loading{display:grid;gap:12px;padding:22px 4px}.loading-hint{margin:18px 4px 0;color:var(--muted);font-size:13px;text-align:center}.skeleton{height:14px;border-radius:7px;background:var(--hover);animation:pulse 1.1s ease-in-out infinite alternate}.skeleton:nth-child(2){width:82%}.skeleton:nth-child(3){width:64%}@keyframes pulse{to{opacity:.35}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes activitySweep{0%{left:-240px}90%,to{left:100%}}@keyframes deepDiveShimmer{to{background-position:0 0}}@media(display-mode:standalone){.chat-open .messages{padding-bottom:calc(var(--composer-h) + var(--todo-h) + var(--queue-h) + var(--tunnel-warn-h))}.chat-open.turn-running .messages{padding-bottom:calc(116px + env(safe-area-inset-bottom) + var(--queue-h) + var(--tunnel-warn-h))}.chat-open.todo-open .messages{padding-bottom:calc(130px + env(safe-area-inset-bottom) + var(--queue-h) + var(--tunnel-warn-h))}.chat-open.turn-running.todo-open .messages{padding-bottom:calc(162px + env(safe-area-inset-bottom) + var(--queue-h) + var(--tunnel-warn-h))}.chat-open.todo-expanded .messages{padding-bottom:min(42vh,calc(300px + env(safe-area-inset-bottom) + var(--queue-h) + var(--tunnel-warn-h)))}.chat-open.turn-running.todo-expanded .messages{padding-bottom:min(42vh,calc(332px + env(safe-area-inset-bottom) + var(--queue-h) + var(--tunnel-warn-h)))}.chat-open.question-open .messages{padding-bottom:min(64vh,520px)}.composer,.question-composer{padding-bottom:calc(5px + env(safe-area-inset-bottom))}}@media(prefers-reduced-motion:reduce){.skeleton,.status,.head-icon.spinning svg,.older-spin,.is-running .spin,.thinking[data-state=running] .activity-summary:after,.tool[data-state=running] .activity-summary:after,.turn-status,.todo-item[data-status=in_progress] .todo-glyph{animation:none}.composer-inner,.primary,.plus-sheet,.ws-chevron,#pullHint,#messages.animating{transition:none}}
    /* Keep the popover anchored to its trigger; composer docks may grow behind it. */
    /* body class queue-open (renderQueueDock) has no CSS consumer by design: the queue dock reserves its height via --queue-h only (parent-card decision, do not re-litigate); todo-open below IS consumed by the .messages padding rules. */
    #composer .session-settings{z-index:1;bottom:calc(76px + var(--todo-h) + var(--queue-h) + var(--tunnel-warn-h))}
    .tunnel-warn{margin:4px 16px 0;padding:0;background:transparent;color:var(--muted);font-size:11px;line-height:1.3;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
    body.tunnel-warn-open{--tunnel-warn-h:18px}
    .messages .turn-status{align-self:flex-start;flex:none;margin:3px 4px}
    /* "load earlier" affordance: the transcript is paged by records, not by
       screenfuls, so a short page still needs an explicit way to pull more. */
    .older-row{flex:none;align-self:center;min-height:44px;margin:2px 0 10px;padding:7px 15px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--muted);font-size:12px;line-height:1.4;white-space:nowrap}
    .older-row:active{background:var(--hover);color:var(--ink)}
    .older-row[disabled]{cursor:default;opacity:.72}
    .older-spin{display:none;width:11px;height:11px;margin-right:6px;border:1.7px solid var(--line);border-top-color:var(--muted);border-radius:50%;vertical-align:-1px;animation:olderSpin .7s linear infinite}
    .older-row.busy .older-spin{display:inline-block}
    @keyframes olderSpin{to{transform:rotate(360deg)}}
    /* Scroll follow + dual anchors + history virtualization
       (2026-10-07-feat-pocket-smart-scroll-anchors). msg-hist lets the browser skip
       layout/paint for history rows that are far off-screen; contain-intrinsic-size's
       auto keyword remembers each row's real height once it has been rendered, so the
       estimate only ever applies to rows the reader has not reached. The transcript
       tail stays untagged so the streaming edge never re-estimates. */
    .msg-hist{content-visibility:auto;contain-intrinsic-size:auto 120px}
    .scroll-anchors{position:fixed;right:12px;bottom:calc(var(--composer-h) + var(--todo-h) + var(--queue-h) + var(--tunnel-warn-h) + 16px);z-index:2;display:grid;gap:8px;justify-items:end;pointer-events:none}
    .anchor-fab{pointer-events:auto;padding:0;display:grid;place-items:center;width:38px;height:38px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink);box-shadow:0 2px 10px rgba(0,0,0,.12);opacity:0;visibility:hidden;transform:translateY(4px);transition:opacity .12s ease,transform .12s ease,visibility .12s ease}
    .anchor-fab.show{opacity:1;visibility:visible;transform:none}
    .anchor-fab:active{background:var(--hover)}
    @media(prefers-reduced-motion:reduce){.anchor-fab{transition:none}}
    /* Session unread dot (same change): a row whose last activity postdates the last
       time this phone opened that session, excluding the focused and running ones.
       One 6px token-coloured dot on the status glyph. */
    .task-status{position:relative}
    .task-row.is-unread .task-status::after{content:'';position:absolute;top:-2px;right:-3px;width:6px;height:6px;border-radius:50%;background:var(--danger)}
    .loading-failed{display:grid;gap:10px;place-items:center;margin:auto;padding:18px 10px;color:var(--muted);font-size:13px;text-align:center}
    .loading-failed p{margin:0}
    /* content sticks to the bottom via the .messages::before margin-top:auto spacer */
    .head-expiry{flex:none;margin-left:2px;padding:2px 7px;border-radius:999px;background:var(--surface);color:var(--muted);font-size:10px;line-height:1.5;white-space:nowrap;font-variant-numeric:tabular-nums}
    .head-icon{flex:none;display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:50%;background:transparent;color:var(--muted);padding:0}
    .head-icon:active{background:var(--hover);color:var(--ink)}
    .head-icon.spinning svg{animation:headSpin .55s linear infinite}
    @keyframes headSpin{to{transform:rotate(360deg)}}
    body.chat-open #listRefresh{display:none}
    .plus-trigger{display:grid;place-items:center;width:44px;min-width:44px;height:44px;border-radius:50%;padding:0;background:var(--surface);color:var(--muted)}
    .plus-trigger:active{background:var(--hover)}
    .draft-strip{display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding:0 2px 8px;pointer-events:auto}
    .draft-strip:empty{display:none;padding:0}
    .draft-card{position:relative;flex:none;width:64px;height:64px;border:1px solid var(--line);border-radius:12px;background:var(--surface);overflow:hidden}
    .draft-card img{width:100%;height:100%;object-fit:cover;display:block}
    .draft-file{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;width:100%;height:100%;padding:6px;color:var(--ink)}
    .draft-file svg{width:22px;height:22px;color:var(--muted);flex:none}
    .draft-file .draft-file-name{max-width:56px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .draft-meta{position:absolute;left:0;right:0;bottom:0;padding:2px 3px;font-size:9px;color:#fff;background:rgba(0,0,0,.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .draft-remove{position:absolute;top:3px;right:3px;width:26px;height:26px;border:0;border-radius:50%;padding:0;background:rgba(0,0,0,.55);color:#fff;font-size:13px;line-height:26px;text-align:center}
    .draft-state{position:absolute;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.42);color:#fff;font-size:10px;text-align:center;padding:4px}
    .draft-card.is-failed{border-color:#e34d59}.draft-card.is-failed .draft-state{background:rgba(227,77,89,.28)}
    .plus-overlay{position:fixed;z-index:5;inset:0;background:rgba(0,0,0,.34);display:none}
    .plus-overlay.open{display:block}
    .plus-sheet{position:fixed;z-index:6;left:50%;bottom:0;transform:translate(-50%,105%);width:min(520px,100%);max-height:min(82vh,640px);display:flex;flex-direction:column;border-radius:20px 20px 0 0;padding:10px 14px calc(10px + env(safe-area-inset-bottom));background:var(--paper);box-shadow:0 -10px 40px rgba(0,0,0,.18);transition:transform .22s ease}
    .plus-sheet.open{transform:translate(-50%,0)}
    .plus-handle{width:36px;height:4px;border-radius:2px;background:var(--line);margin:2px auto 10px}
    .plus-search-open{display:flex;align-items:center;gap:7px;width:100%;height:44px;border:1px solid var(--line);border-radius:12px;padding:0 12px;background:var(--surface);color:var(--muted);font-size:14px;text-align:left}
    .plus-search-open svg{flex:none}
    .plus-search-open[hidden]{display:none}
    .plus-search-row{display:flex;align-items:center;gap:8px}
    .plus-search-row[hidden]{display:none}
    .plus-search-row .plus-filter{flex:1;min-width:0}
    .plus-search-cancel{flex:none;min-width:44px;min-height:44px;border:0;background:transparent;color:var(--muted);font-size:14px;padding:6px 4px}
    .plus-filter{width:100%;height:44px;border:1px solid var(--line);border-radius:12px;padding:0 12px;background:var(--surface);color:var(--ink);outline:0}
    .plus-body{overflow-y:auto;-webkit-overflow-scrolling:touch;margin-top:10px}
    .plus-section-title{font-size:12px;font-weight:600;color:var(--muted);padding:8px 4px 4px}
    .plus-row{display:flex;align-items:center;gap:11px;width:100%;text-align:left;border:0;border-radius:13px;padding:10px 10px;background:transparent;color:var(--ink)}
    .plus-row:active{background:var(--hover)}
    .plus-row-icon{flex:none;display:grid;place-items:center;width:30px;height:30px;color:var(--ink)}
    .plus-row-icon svg{width:21px;height:21px}
    .plus-row-title{flex:none;font-size:15px}
    .plus-row-desc{flex:1;min-width:0;text-align:right;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .plus-empty{padding:22px 4px;color:var(--muted);font-size:13px;text-align:center}
    .plus-back{display:inline-flex;align-items:center;gap:4px;min-height:44px;border:0;background:transparent;color:var(--muted);padding:4px;font-size:13px}
    .plus-row-danger{color:var(--danger)}
    .attach-image{margin:7px 0}.attach-image img{display:block;max-width:230px;width:100%;border-radius:13px;border:1px solid var(--line)}.attach-gone{display:inline-flex;align-items:center;max-width:100%;border:1px dashed var(--line);border-radius:12px;padding:7px 10px;color:var(--muted);font-size:12px}
    .attach-file{display:inline-flex;align-items:center;gap:7px;max-width:100%;border:1px solid var(--line);border-radius:12px;padding:8px 11px;margin:5px 0;color:var(--ink);text-decoration:none}
    .attach-file-open{background:var(--card);cursor:pointer;-webkit-tap-highlight-color:transparent}
    .attach-file-open:active{background:var(--row-active, rgba(127,127,127,.08))}
    .attach-file svg{flex:none}.attach-file-name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.attach-file-bytes{flex:none;font-size:11px;color:var(--muted)}.attach-file-action{flex:none;display:inline-flex;align-items:center;margin-left:2px;color:var(--muted)}
    /* Image/file capability (2026-10-07-feat-pocket-image-file-capability):
       the lightbox, the inline text-attachment preview, markdown images the
       session-file route serves, and the presented-file cards. Tokens only. */
    .md-image{display:block;max-width:230px;width:100%;margin:7px 0;border-radius:13px;border:1px solid var(--line)}
    .md-image-fallback{display:inline-block;max-width:100%;margin:5px 0;border:1px dashed var(--line);border-radius:12px;padding:7px 10px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
    .presented-desc{display:block;margin:2px 2px 6px;color:var(--muted);font-size:11.5px;line-height:1.45;max-width:230px}
    .attach-file-desc{display:block;max-width:180px;margin:1px 0 0;color:var(--muted);font-size:11px;line-height:1.4;white-space:normal}
    .attach-preview{display:block;width:100%;max-width:520px;margin:4px 0 8px;border:1px solid var(--line);border-radius:12px;background:var(--surface);overflow:hidden}
    .attach-preview pre{max-height:300px;margin:0;padding:10px 12px;overflow:auto;overflow-wrap:anywhere;white-space:pre;color:var(--ink);font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
    .attach-preview-bar{display:flex;gap:6px;align-items:center;border-top:1px solid var(--line);padding:7px 9px;background:var(--card)}
    .attach-preview-bar button,.attach-preview-bar a{flex:none;display:inline-flex;align-items:center;gap:4px;min-height:32px;border:1px solid var(--line);border-radius:9px;padding:0 11px;background:var(--surface);color:var(--ink);font-size:12px;text-decoration:none}
    .attach-preview-bar button:active,.attach-preview-bar a:active{background:var(--hover)}
    .attach-preview-state{flex:1;min-width:0;color:var(--muted);font-size:11px;text-align:right}
    .lightbox{position:fixed;z-index:9;inset:0;height:100dvh;display:flex;flex-direction:column;background:rgba(0,0,0,.94)}
    .lightbox[hidden]{display:none}
    .lightbox-stage{flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;display:grid;place-items:center}
    .lightbox-stage img{display:block;max-width:100%;max-height:100%;object-fit:contain}
    .lightbox.zoomed .lightbox-stage{display:block}
    .lightbox.zoomed .lightbox-stage img{max-width:none;max-height:none}
    .lightbox-text{max-width:100%;margin:0;padding:14px;color:#f5f5f6;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;overflow-wrap:anywhere}
    .lightbar{flex:none;display:flex;gap:8px;align-items:center;padding:10px 14px calc(10px + env(safe-area-inset-bottom))}
    .lightbar-name{flex:1;min-width:0;color:#fff;opacity:.82;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .lightbar button,.lightbar a{flex:none;display:inline-flex;align-items:center;gap:5px;min-height:40px;border:1px solid rgba(255,255,255,.28);border-radius:11px;padding:0 13px;background:rgba(255,255,255,.1);color:#fff;font-size:13px;text-decoration:none}
    .lightbar button:active,.lightbar a:active{background:rgba(255,255,255,.2)}
    .lightbar .lightbox-close{min-width:40px;padding:0;font-size:18px;justify-content:center}
    .attach-file svg{flex:none}.attach-file-name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.attach-file-bytes{flex:none;font-size:11px;color:var(--muted)}
    .slash-menu{position:absolute;left:0;right:0;bottom:calc(76px + var(--tunnel-warn-h));z-index:4;max-height:min(46vh,340px);overflow-y:auto;-webkit-overflow-scrolling:touch;background:var(--card);border:1px solid var(--line);border-radius:15px;box-shadow:0 -8px 30px rgba(0,0,0,.16);padding:5px;pointer-events:auto}
    .slash-menu[hidden]{display:none}
    .slash-row{display:flex;align-items:center;gap:9px;width:100%;min-height:44px;text-align:left;border:0;border-radius:11px;padding:11px 10px;background:transparent;color:var(--ink)}
    .slash-row.active,.slash-row:active{background:var(--hover)}
    .slash-row-name{flex:none;font-size:14px;font-weight:600}
    .slash-row-desc{flex:1;min-width:0;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .slash-row-kind{flex:none;font-size:10px;color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:1px 5px}
    .slash-empty{padding:16px 6px;color:var(--muted);font-size:13px;text-align:center}
    /* The chat notice is dismissible, not a wall: it carries its own tap target on the
       right end, so clearing it never has to wait for a frame that may never arrive, and
       it yields the floor while a question composer owns the bottom band. Hiding by rule
       (not by JS) keeps the empty-banner :empty collapse above intact. */
    .chat-open #chatError{pointer-events:auto;cursor:pointer}
    .chat-open #chatError::after{content:'\\00d7';position:absolute;top:50%;right:4px;transform:translateY(-50%);display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--hover);color:var(--muted);font-size:16px;line-height:1}
    body.question-open #chatError{display:none}
  </style>
</head>
<body${initialChat ? ' class="chat-open"' : ''}><main class="shell">
  <div id="toast" class="toast" role="status"></div>
  <header><div class="brand"><img src="${icon || '/app-icon'}" alt="" style="width:22px;height:22px;border-radius:5px;object-fit:cover"><span>DSH Pocket</span></div><div class="head-right" style="display:flex;align-items:center;gap:5px"><span id="deviceExpiry" class="head-expiry" hidden></span><button id="listRefresh" class="head-icon" aria-label="${zh ? '刷新会话列表' : 'Refresh sessions'}"><svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.6v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div id="status" class="status connecting" role="status" aria-label="${zh ? '正在连接' : 'Connecting'}"></div><span id="statusText" class="status-text" aria-hidden="true">${zh ? '正在连接' : 'Connecting'}</span></div></header>
  <section id="sessionsView" class="view${initialChat ? '' : ' active'}">
    <div id="workspaces" class="workspaces"></div><div id="listError" class="error" role="status" aria-live="polite"></div>
  </section>
  <section id="chatView" class="view${initialChat ? ' active' : ''}">
    <div class="toolbar chat-toolbar"><button id="back" class="quiet back" aria-label="${zh ? '返回会话列表' : 'Back to sessions'}"><svg width="20" height="20" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.5 3L5.5 8L10.5 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div><div id="reconnectBar" class="reconnect-bar" role="status" aria-live="polite" hidden></div>
    <div id="goalBar" class="goal-bar" hidden></div>
    <div id="pullHint" class="pull-hint" role="status" aria-live="polite"></div><div id="messages" class="messages">${initialChat ? '<div class="loading"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>' : ''}</div><div id="scrollAnchors" class="scroll-anchors"><button id="jumpPrompt" class="anchor-fab" type="button" aria-label="${zh ? '上一条提问' : 'Previous question'}"><svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 13V3M8 3 4.6 6.4M8 3l3.4 3.4" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button id="jumpLatest" class="anchor-fab" type="button" aria-label="${zh ? '回到最新消息' : 'Back to the latest'}"><svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M8 13 4.6 9.6M8 13l3.4-3.4" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div><div id="chatError" class="error" role="status" aria-live="polite" aria-label="${zh ? '提示，轻点右侧关闭' : 'Notice, tap the right side to dismiss'}"></div>
    <div id="questionComposer" class="question-composer" hidden></div>
    <div id="composer" class="composer"><div id="sessionSettings" class="session-settings" hidden></div><section id="todoDock" class="todo-dock" aria-label="${zh ? '任务' : 'To-dos'}" hidden></section><div id="queueDock" class="queue-dock" hidden></div><div id="draftStrip" class="draft-strip" aria-label="${zh ? '附件草稿' : 'Attachment drafts'}"></div><div id="slashMenu" class="slash-menu" role="listbox" aria-label="${zh ? '指令与技能' : 'Commands and skills'}" hidden></div><div class="composer-inner"><button id="plus" class="plus-trigger" aria-label="${zh ? '添加文件或调用指令' : 'Add files or invoke a command'}" aria-haspopup="dialog" aria-expanded="false"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 3.5v11M3.5 9h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button><textarea id="prompt" rows="1" aria-label="${zh ? '消息输入框' : 'Message input'}" placeholder="${zh ? '给智能体发消息' : 'Message the agent'}"></textarea><button id="settings" class="settings-trigger" aria-label="${zh ? '会话设置' : 'Session settings'}" aria-expanded="false"><svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M3 5h7M13 5h2M3 13h2M8 13h7M10 3v4M6 11v4" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg></button><button id="send" class="primary" aria-label="${zh ? '发送' : 'Send'}" disabled><svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 12V4M8 4 4.75 7.25M8 4l3.25 3.25" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button id="cancel" class="primary cancel" aria-label="${zh ? '停止生成' : 'Stop generating'}" hidden><svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor"/></svg></button></div><div id="tunnelWarn" class="tunnel-warn" hidden></div></div>
  </section>
</main>
<div id="plusOverlay" class="plus-overlay" hidden></div>
<div id="plusSheet" class="plus-sheet" role="dialog" aria-modal="true" aria-label="${zh ? '添加文件或调用指令' : 'Add files or invoke a command'}" hidden><div class="plus-handle"></div><button id="plusSearchOpen" class="plus-search-open" type="button" data-plus-search-open><svg width="15" height="15" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.2" stroke="currentColor" stroke-width="1.5"/><path d="m12.1 12.1 3.1 3.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>${zh ? '搜索指令与文件' : 'Search commands and files'}</span></button><div id="plusSearchRow" class="plus-search-row" hidden><input id="plusFilter" class="plus-filter" type="search" aria-label="${zh ? '搜索指令与文件' : 'Search commands and files'}" placeholder="${zh ? '搜索…' : 'Search…'}"><button id="plusSearchCancel" class="plus-search-cancel" type="button" data-plus-search-cancel>${zh ? '取消' : 'Cancel'}</button></div><div id="plusBody" class="plus-body"></div></div>
<div id="lightbox" class="lightbox" role="dialog" aria-modal="true" aria-label="${zh ? '图片查看' : 'Image viewer'}" hidden><div class="lightbox-stage" data-lightbox-stage><img id="lightboxImg" alt="" hidden><pre id="lightboxText" class="lightbox-text" hidden></pre></div><div class="lightbar"><span id="lightboxName" class="lightbar-name"></span><button id="lightboxCopy" type="button" hidden>${zh ? '复制' : 'Copy'}</button><a id="lightboxSave" download hidden>${zh ? '保存' : 'Save'}</a><button id="lightboxClose" type="button" class="lightbox-close" aria-label="${zh ? '关闭' : 'Close'}">×</button></div></div>
<input id="filePickerImage" type="file" accept="image/*" multiple aria-hidden="true" tabindex="-1" style="position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0"><input id="filePickerAny" type="file" multiple aria-hidden="true" tabindex="-1" style="position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0">
${bootScript}
<script${nonceAttr}>
${applyPendingCreatedSessions.toString()}
${spliceProvisionalSession.toString()}
${reconcileProvisionalSession.toString()}
const BLANK_ROW_VISIBLE_MS=${BLANK_ROW_VISIBLE_MS}
${blankRowVisible.toString()}
${goalOf.toString()}
${queuedRowsOf.toString()}
${toolActivityCategory.toString()}
${diffLineSplit.toString()}
${toolSummaryLine.toString()}
${clusterToolBlocks.toString()}
/* Step-process narration from the generated host table (message.stepProcess.*,
   dsh ${GENERATED_FROM.dshVersion} client ${GENERATED_FROM.clientHash}). */
const STEP=${scriptJson(zh ? STEP_PROCESS_LABELS.zh : STEP_PROCESS_LABELS.en)}
${stepTitleFor.toString()}
const L=${scriptJson({
    untitled: zh ? '未命名会话' : 'Untitled session',
    failed: zh ? '请求失败' : 'Request failed',
    running: zh ? '运行中' : 'Running',
    done: zh ? '完成' : 'Done',
    toolFailed: zh ? '失败' : 'Failed',
    input: zh ? '输入' : 'Input',
    output: zh ? '输出' : 'Output'
    /* Process narration copy — the Host desktop's own stepProcess verb table
       (app.asar i18n `message.stepProcess.*`, extracted 2026-10-07), quoted
       verbatim so the phone speaks the same language as the desktop panel. */
    ,toolRaw: zh ? '查看技术详情' : 'View technical details'
    ,diffMore: zh ? '…其余 {n} 行' : '… {n} more lines'
    ,stepVerbs: {
        read: zh ? '正在读取文件' : 'Reading files'
        ,readImage: zh ? '正在读取图片' : 'Reading images'
        ,write: zh ? '正在写入文件' : 'Writing files'
        ,search: zh ? '正在搜索代码' : 'Searching code'
        ,edit: zh ? '正在编辑文件' : 'Editing files'
        ,commands: zh ? '正在运行命令' : 'Running commands'
        ,code: zh ? '正在运行代码' : 'Running code'
        ,webSearch: zh ? '正在搜索网页' : 'Searching the web'
        ,webFetch: zh ? '正在访问网页' : 'Visiting web pages'
        ,subagents: zh ? '正在协调子智能体' : 'Coordinating subagents'
        ,plan: zh ? '正在更新计划' : 'Updating the plan'
        ,questions: zh ? '等待你的操作' : 'Waiting for your action'
        ,tools: zh ? '正在调用工具' : 'Calling tools'
    }
    ,stepDone: {
        read: zh ? '已读取文件' : 'Read files'
        ,readImage: zh ? '已读取图片' : 'Read images'
        ,write: zh ? '已写入文件' : 'Wrote files'
        ,search: zh ? '已搜索代码' : 'Searched code'
        ,edit: zh ? '修改了文件' : 'Edited files'
        ,commands: zh ? '执行了命令' : 'Ran commands'
        ,code: zh ? '运行了代码' : 'Ran code'
        ,webSearch: zh ? '已搜索网页' : 'Searched the web'
        ,webFetch: zh ? '已访问网页' : 'Visited web pages'
        ,subagents: zh ? '已协调子智能体' : 'Coordinated subagents'
        ,plan: zh ? '更新了计划' : 'Updated the plan'
        ,questions: zh ? '向用户提出了问题' : 'Asked questions'
        ,tools: zh ? '已调用工具' : 'Called tools'
    }
    ,noWorkspaces: zh ? '暂无工作区，请先在 DSH 中创建第一个工作区。' : 'No workspaces yet. Create your first workspace in DSH.'
    ,newChat: zh ? '新建对话' : 'New chat'
    ,noTasksHint: zh ? '还没有对话，点右上角 + 新建一个' : 'No chats yet. Tap + to start one.'
    ,refreshed: zh ? '已刷新' : 'Updated'
    ,justNow: zh ? '刚刚' : 'Now'
    ,minute: zh ? ' 分钟前' : 'm ago'
    ,hour: zh ? ' 小时前' : 'h ago'
    ,day: zh ? ' 天前' : 'd ago'
    ,questionNeeded: zh ? '需要你的回答' : 'Your input is needed'
    ,questionProgress: zh ? '个问题' : 'questions'
    ,customAnswer: zh ? '或者输入其他回答' : 'Or enter another answer'
    ,customPlaceholder: zh ? '输入你的回答…' : 'Type your answer…'
    ,skip: zh ? '跳过' : 'Skip'
    ,previous: zh ? '上一个' : 'Back'
    ,next: zh ? '下一个' : 'Next'
    ,submitAnswer: zh ? '提交回答' : 'Submit answers'
    ,cancelQuestions: zh ? '取消这次提问' : 'Cancel this request'
    ,chooseAnswer: zh ? '请选择一个选项、输入回答，或跳过。' : 'Choose an option, enter an answer, or skip.'
    ,chooseAnswerMulti: zh ? '可选择多个选项、输入回答，或跳过。' : 'You can select multiple options, enter an answer, or skip.'
    ,recommended: zh ? '推荐' : 'Recommended'
    ,answering: zh ? '正在提交…' : 'Submitting…'
    ,presetStandard: zh ? '标准模式' : 'Standard mode'
    ,presetCode: zh ? 'PTC 模式' : 'PTC mode'
    ,presetMinimal: zh ? '极简模式' : 'Minimal mode'
    ,presetCordis: zh ? '创造模式' : 'Creator mode'
    ,customPreset: zh ? '自定义' : 'Custom'
    ,sessionSettings: zh ? '会话设置' : 'Session settings'
    ,preset: zh ? '预设' : 'Preset'
    ,model: zh ? '模型' : 'Model'
    ,reasoningEffort: zh ? '思考强度' : 'Reasoning effort'
    ,presetLocked: zh ? '发送首条消息后，预设将锁定。' : 'Preset is locked after the first message.'
    ,presetEditable: zh ? '仅可在发送第一条消息前更改。' : 'Can be changed before the first message only.'
    ,settingsLoading: zh ? '正在读取模型与 Preset…' : 'Loading models and presets…'
    ,settingsUpdated: zh ? '会话设置已更新' : 'Session settings updated'
    ,noModels: zh ? '当前没有可选模型' : 'No models are available'
    ,todoTitle: zh ? '任务' : 'To-dos'
    ,queueCount: zh ? '排队消息 {n} 条' : '{n} queued message(s)'
    ,queueImage: zh ? '图片' : 'image'
    ,queueFile: zh ? '文件' : 'file'
    ,queueUnrenderable: zh ? '[图片/文件]' : '[image/file]'
    ,queueEdit: zh ? '编辑' : 'Edit'
    ,queueSave: zh ? '保存' : 'Save'
    ,queueCancel: zh ? '取消' : 'Cancel'
    ,queueRemove: zh ? '撤回' : 'Recall'
    ,queueSteer: zh ? '立刻发送' : 'Send now'
    ,queueEditFailed: zh ? '编辑失败' : 'Edit failed'
    ,queueRemoveFailed: zh ? '撤回失败' : 'Recall failed'
    ,queueSteerFailed: zh ? '发送失败' : 'Send failed'
    ,goalPhaseActive: zh ? '进行中' : 'active'
    ,goalPhasePaused: zh ? '已暂停' : 'paused'
    ,goalPhaseBlocked: zh ? '受阻' : 'blocked'
    ,goalPhaseComplete: zh ? '已完成' : 'complete'
    ,goalRoundUnit: zh ? ' 轮' : ''
    ,goalPause: zh ? '暂停' : 'Pause'
    ,goalResume: zh ? '恢复' : 'Resume'
    ,goalEdit: zh ? '编辑' : 'Edit'
    ,goalClear: zh ? '清除' : 'Clear'
    ,goalSave: zh ? '保存' : 'Save'
    ,goalCancel: zh ? '取消' : 'Cancel'
    ,goalPaused: zh ? '目标已暂停' : 'Goal paused'
    ,goalResumed: zh ? '目标已恢复' : 'Goal resumed'
    ,goalEdited: zh ? '目标已更新' : 'Goal updated'
    ,goalCleared: zh ? '目标已清除' : 'Goal cleared'
    ,goalActionFailed: zh ? '目标操作失败' : 'Goal action failed'
    ,goalEditFailed: zh ? '目标编辑失败' : 'Goal edit failed'
    ,todoDone: zh ? '已完成' : 'completed'
    ,todoActive: zh ? '进行中' : 'in progress'
    ,todoPending: zh ? '待处理' : 'pending'
    ,think: zh ? '思考' : 'Think'
    ,process: zh ? '过程' : 'Process'
    ,close: zh ? '关闭' : 'Close'
    ,deepDiving: zh ? '深度思考中…' : 'Deep diving...'
    ,stopping: zh ? '正在停止…' : 'Stopping…'
    ,turnError: zh ? '运行出错' : 'Error'
    ,turnAborted: zh ? '已取消' : 'Canceled'
    ,turnBlocked: zh ? '被拦截，未能执行' : 'Blocked'
    ,turnMaxTokens: zh ? '已达到长度上限' : 'Maximum length reached'
    ,turnInterrupted: zh ? '被打断' : 'Interrupted'
    ,streamFailure: zh ? '连接中断' : 'Connection lost'
    ,streamFailBackoff: zh ? '连接中断：宿主暂时不接受这个流。' : 'Connection lost: the Host is not accepting this stream yet.'
    ,streamFailTransport: zh ? '连接中断：连不上宿主的会话流。' : 'Connection lost: the session stream could not reach the Host.'
    ,streamFailHost: zh ? '连接中断：远端流失败。' : 'Connection lost: the remote stream failed.'
    ,draftJoin: zh ? '，' : ', '
    ,plusPermissionLoading: zh ? '正在读取权限预设…' : 'Loading permission presets…'
    ,plusExportDone: zh ? '导出已开始下载' : 'Export download started'
    ,plusExportFailed: zh ? '导出失败' : 'Export failed'
    ,bootListPartial: zh ? '列表只载入了一部分，正在重试…' : 'Only part of the list loaded, retrying…'
    ,plusSectionAdd: zh ? '添加' : 'Add'
    ,plusSectionCommands: zh ? '指令' : 'Commands'
    ,plusBack: zh ? '返回' : 'Back'
    ,plusFile: zh ? '文件' : 'File'
    ,plusFileDesc: zh ? '添加图片或其他文件' : 'Add images or other files'
    ,plusGoal: zh ? '目标' : 'Goal'
    ,plusGoalDesc: zh ? '设置或查看长期任务目标' : 'Set or review the long-running goal'
    ,plusPlan: zh ? '计划' : 'Plan'
    ,plusPlanDesc: zh ? '进入或退出计划模式' : 'Enter or leave plan mode'
    ,plusFeedback: zh ? '反馈' : 'Feedback'
    ,plusFeedbackDesc: zh ? '发送关于当前会话的反馈' : 'Send feedback about this session'
    ,plusCompact: zh ? '压缩' : 'Compact'
    ,plusCompactDesc: zh ? '压缩以上对话内容' : 'Compact the conversation above'
    ,plusPermission: zh ? '权限' : 'Permission'
    ,plusPermissionDesc: zh ? '控制 AI 能自己做多少事：只读 / 工作区可写 / 完全放开' : 'Control how much the AI can do on its own: read-only / workspace-write / full access'
    ,plusModel: zh ? '模型' : 'Model'
    ,plusModelDesc: zh ? '选择模型与推理强度' : 'Choose model and reasoning effort'
    ,plusExport: zh ? '下载日志' : 'Export log'
    ,plusExportDesc: zh ? '将当前会话内容导出为 ZIP' : 'Export this session as a ZIP'
    ,plusCurrentPermission: zh ? '查看当前权限' : 'View current permission'
    ,plusNoMatch: zh ? '未找到匹配项' : 'No matching item'
    ,draftUploading: zh ? '上传中…' : 'Uploading…'
    ,draftFailed: zh ? '失败，点此重试' : 'Failed, tap to retry'
    ,draftRemove: zh ? '移除附件' : 'Remove attachment'
    ,attachTooMany: zh ? '附件数量超出上限' : 'Too many attachments'
    ,attachTooLarge: zh ? '附件大小超出上限，请换用更小的文件后重试' : 'Attachment is too large. Try a smaller file.'
    ,attachBadType: zh ? '不支持的附件类型' : 'Unsupported attachment type'
    ,fileChip: zh ? '文件' : 'File'
    ,imageChip: zh ? '图片' : 'Images'
    ,imageGone: zh ? '图片已过期，无法显示' : 'Image expired and cannot be shown'
    /* Image/file capability (2026-10-07-feat-pocket-image-file-capability):
       the lightbox, the text-attachment preview and the presented-file cards. */
    ,lightboxLabel: zh ? '图片查看' : 'Image viewer'
    ,save: zh ? '保存' : 'Save'
    ,copy: zh ? '复制' : 'Copy'
    ,copied: zh ? '已复制' : 'Copied'
    ,copyFailed: zh ? '复制失败' : 'Copy failed'
    ,viewAll: zh ? '查看全部' : 'View all'
    ,previewLoading: zh ? '正在加载预览…' : 'Loading preview…'
    ,previewFailed: zh ? '预览加载失败' : 'Preview failed'
    ,previewFile: zh ? '预览文件' : 'Preview file'
    ,attachNotAccepted: zh ? '/{command} 不接受附件，请先移除附件' : '/{command} does not accept attachments; remove them first'
    ,plusExportRunning: zh ? '正在准备导出…' : 'Preparing export…'
    ,slashKindCommand: zh ? '命令' : 'Command'
    ,slashKindSkill: zh ? '技能' : 'Skill'
    ,slashEmpty: zh ? '没有匹配的指令' : 'No matching command'
    ,slashLoading: zh ? '正在加载…' : 'Loading…'
    ,slashFailed: zh ? '指令目录加载失败' : 'Could not load the command list'
    ,commandFailed: zh ? '指令执行失败' : 'Command failed'
    ,olderMore: zh ? '加载更多消息' : 'Load earlier messages'
    ,olderLoading: zh ? '正在加载更早的消息…' : 'Loading earlier messages…'
    ,olderStart: zh ? '已经是最早的消息了' : 'Start of the conversation'
    ,olderExhausted: zh ? '没有更多消息了' : 'No earlier messages'
    ,pullHint: zh ? '下拉加载更早的消息' : 'Pull down to load earlier messages'
    ,pullRelease: zh ? '松开即可加载更早的消息' : 'Release to load earlier messages'
    ,requestTimeout: zh ? '请求超时了，请检查网络后重试' : 'The request timed out. Check your connection and try again.'
    ,loadFailed: zh ? '消息没能加载出来' : 'Messages could not be loaded'
    ,syncingChat: zh ? '正在同步会话内容…' : 'Syncing the conversation…'
    ,retry: zh ? '重试' : 'Retry'
    ,disconnectedRetry: zh ? '连接已断开，正在重试…' : 'Connection lost, retrying…'
    ,streamDownTunnel: zh ? '远程链接断了，正在自动重试…' : 'The remote link dropped, retrying on its own…'
    ,streamDownHost: zh ? '桌面端在重启或暂时联系不上，正在重试…' : 'The desktop is restarting or unreachable, retrying…'
    ,streamDownBackground: zh ? '会话被移到后台，回到前台会自动继续' : 'This chat moved to the background; it resumes when you return'
    /* Named reasons (fix-pocket-disconnect-copy): the bridge stamps every failure
       family with a stable errorCode; these are the sentences for the ones a reader
       can act on. Codes outside the map keep the generic copy below. */
    ,codeSessionGone: zh ? '该会话已在电脑端关闭，回到列表看看其他会话吧' : 'This chat was closed on the desktop. Pick another one from the list.'
    ,codeAgentBusy: zh ? '电脑端正在这个会话里忙碌，请稍后再试' : 'The desktop is still busy with this chat. Try again in a moment.'
    ,codeHostStarting: zh ? '桌面端正在启动，正在等它就绪…' : 'The desktop is starting up; waiting for it to be ready…'
    ,codeQuestionClosed: zh ? '这条提问已经关闭了' : 'This question was already closed.'
    ,statusConnected: zh ? '已连接' : 'Connected'
    ,statusDisconnected: zh ? '已断开' : 'Disconnected'
    ,statusReconnecting: zh ? '重连中' : 'Reconnecting'
    ,statusDegraded: zh ? '宿主未响应' : 'Host unreachable'
    ,unreachableOverlay: zh ? '远程地址已失效，请在电脑上的「pocket」扫描新二维码' : 'This remote address is no longer valid. Scan the new QR code in pocket on the computer.'
    ,tunnelWarn: zh ? '远程链接约 {n} 分钟后失效，请及时收尾' : 'This remote link expires in about {n} min. Finish up soon.'
    ,deviceExpiry: zh ? '授权至 {time}' : 'Authorized until {time}'
    ,turnUsageTitle: zh ? '本轮用量' : 'Turn usage'
    ,turnUsageCount: zh ? '{count} tok' : '{count} tok'
    ,turnUsageConsumed: zh ? '用量 {total}' : 'Usage {total}'
    ,clockMd: zh ? '{m}月{d}日' : '{m}/{d}'
    ,clockYmd: zh ? '{y}年{m}月{d}日' : '{y}-{m}-{d}'
    ,numberThousand: zh ? '{value}K' : '{value}K'
    ,numberMillion: zh ? '{value}M' : '{value}M'
  })};
  const HISTORY_POLL_ACTIVE_MS=250,HISTORY_POLL_IDLE_MS=750,HISTORY_POLL_IDLE_CAP_MS=5000,PENDING_SYNC_DEBOUNCE_MS=150,PROJECTIONS_SYNC_DEBOUNCE_MS=250,AWAITING_TURN_MAX_MS=9000,TURN_RUNNING_IDLE_MAX_MS=600000;
  // A request that never settles used to freeze the whole page: the history poll
  // kept its busy flag and never rescheduled. Every call now has its own budget.
  const RPC_TIMEOUT_MS=12000,RPC_SLOW_TIMEOUT_MS=180000;
// Cap for the persisted expansion state (turn folds plus thinking/tool blocks).
const TURN_OPEN_STATE_MAX=400;
// How many sessions may keep a warm transcript snapshot. The cache stores whole
// event arrays, so the bound is what keeps a long-lived page from holding every
// conversation it ever opened.
const SESSION_CACHE_MAX=4;
// Live SSE window bound. Records older than the cap are dropped from the front, so a
// long session cannot grow the resident event array without limit. The paging flags are
// deliberately untouched: olderHasMore still says whether the host has more history, and
// clearing it here would strand the dropped records with no way to fetch them back.
const STREAM_EVENTS_CAP=2000;
  let skeletonWatchdog=null;
  let idlePollMs=HISTORY_POLL_IDLE_MS;
  // Pull-older window: pages older than the live SSE window, merged by seq.
  let olderEvents=[],olderHasMore=false,olderBusy=false,olderExhausted=false
  // One stream watermark per session id. The host numbers records with an offset inside
  // a single session log, so a page-wide watermark silences the very next conversation
  // it gets reused for: that session's snapshot is filtered to nothing and its committed
  // turn/end never reaches the phone (2026-10-02 audit, P0-A).
  const streamWatermarks=new Map()
  function streamWatermark(sessionId){const held=streamWatermarks.get(sessionId);return typeof held==='number'?held:-1}
  // Whether anything of this session has been painted yet. Every recovery path below
  // keys off it: while the transcript is empty the live stream is not allowed to be the
  // only source of truth (2026-10-02 audit, P0-B).
  function transcriptHasContent(){return Boolean(streamEvents.length||olderEvents.length)}
  // Resolves true when the live SSE first frame lands; openSession waits on it
  // so the first screen is not also fetched over RPC unless the stream is slow.
  let streamSnapshotReady=null,markStreamSnapshot=()=>{}
  // A second arm before the first snapshot landed used to overwrite the resolver and
   // strand the openSession await on its 900ms fallback; settling the previous promise
   // as false lets that await fall through to the history fetch it already schedules.
   function settleStreamSnapshot(ok){markStreamSnapshot(ok)}
   function armStreamSnapshot(){settleStreamSnapshot(false);streamSnapshotReady=new Promise(resolve=>{markStreamSnapshot=(ok)=>{markStreamSnapshot=()=>{};resolve(ok)}})}
   // Half-open stream (audit S-R3-3). The browser reports a broken stream only when it
   // decides the socket failed; a tunnel that quietly stops forwarding never gets there, so
   // the page keeps a stream it believes is connected, stops fetching history, and freezes
   // on its last frame while /api/status still answers green. The 15s server keepalive is a
   // comment frame, which a browser never surfaces as an event, and the only periodic frame
   // the page can see is the status frame every 30s (lib/constants.js). So the floor for
   // nothing arriving at all is two status cycles, four keepalive periods: any shorter and a
   // healthy idle chat would be torn down and re-opened every half minute.
   const SSE_KEEPALIVE_MS=15000,STREAM_STALE_MS=SSE_KEEPALIVE_MS*4;
   let bootListPartial=false,lastStreamFrameAt=0,streamDownNoticeShown=false,streamStaleTimer=null,streamRetryTimer=null,tunnelLinkActive=false,importantErrorActive=false;
   // One notice per drop, not one per retry: the latch closes again on the first frame that
   // proves the stream is delivering, and that frame also retires the copy it answered.
   // The bridge stamps every failure family with a stable errorCode (its own '__bridge/*'
   // set plus the Host's RemoteError codes — X4-9 carried the field this far, the page
   // only now reads it). This map turns the families a reader can act on into a real
   // sentence; anything outside it keeps the copy it had, with the four generic tiers
   // below untouched as the fallback.
   const STREAM_CODE_COPY={'session/not-found':'codeSessionGone','session/agent-busy':'codeAgentBusy','__bridge/not-ready':'codeHostStarting','cancelled':'codeQuestionClosed'};
   function streamCodeCopy(code){const key=code&&STREAM_CODE_COPY[code];return key?L[key]:''}
   function isStreamCodeCopy(text){const value=String(text||'');if(!value)return false;for(const code in STREAM_CODE_COPY){if(L[STREAM_CODE_COPY[code]]===value)return true}return false}
   function streamDownCopy(){if(document.hidden)return L.streamDownBackground;return tunnelLinkActive?L.streamDownTunnel:L.streamDownHost}
   // 「重连中」and an error are different states, so they stopped sharing #chatError
   // (fix-pocket-disconnect-copy): the reconnect notice is the thin, translucent bar at
   // the top of the chat (its own aria-live slot), while an error keeps the red banner by
   // the composer. Neither surface ever writes the other's copy.
   function notifyStreamDown(){if(streamDownNoticeShown)return;streamDownNoticeShown=true;const bar=$('reconnectBar');if(bar){bar.textContent=streamDownCopy();bar.hidden=false}setStatusCopy(L.statusReconnecting)}
   function noteStreamRecovery(){const wasDown=streamDownNoticeShown||importantErrorActive;streamDownNoticeShown=false;if(!wasDown)return;importantErrorActive=false;const bar=$('reconnectBar');if(bar&&isStreamDownCopy(bar.textContent)){bar.textContent='';bar.hidden=true}setStatusCopy(L.statusConnected)}
   function clearStreamStaleWatch(){if(streamStaleTimer!==null)clearInterval(streamStaleTimer);streamStaleTimer=null;if(streamRetryTimer!==null)clearTimeout(streamRetryTimer);streamRetryTimer=null}
   // Past the threshold: drop the stream, hand the transcript back to the RPC poll, say it once,
   // and try the stream again on the same bound. Closing it is what the audit asked for, but the
   // copy says the page is retrying — with nothing re-opening it that line would be a lie. One
   // attempt per stale bound is the calmest cadence that still heals a half-open tunnel by itself.
   function armStreamRetry(sessionId){streamRetryTimer=setTimeout(()=>{streamRetryTimer=null;if(activeSession!==sessionId||sessionStream||document.hidden)return;openSessionStream(sessionId)},STREAM_STALE_MS)}
   function armStreamStaleWatch(sessionId){clearStreamStaleWatch();lastStreamFrameAt=Date.now();streamStaleTimer=setInterval(()=>{if(activeSession!==sessionId){clearStreamStaleWatch();return}if(document.hidden){lastStreamFrameAt=Date.now();return}if(streamConnected&&Date.now()-lastStreamFrameAt>STREAM_STALE_MS){notifyStreamDown();closeSessionStream();schedulePoll();armStreamRetry(sessionId)}},SSE_KEEPALIVE_MS)}
  let activeSession=null,poll=null,sessionStream=null,streamConnected=false,streamEvents=[],streamProjections=null,streamRenderFrame=null,streamNeedsFullPaint=false,streamRevision=0,pendingSyncTimer=null,workspaces=[],presets=[],sessionSummaries=[],archivedSessionIds=[],pendingCreatedSessions=[],historyBusy=false,lastHistoryKey='',lastDurableMessages=[],optimisticPrompts=[],agentRunning=false,awaitingTurnSeq=null,awaitingTurnTimer=null,turnRunningSeq=-1,turnRunningOpen=false,turnRunningSeenSeq=-1,turnRunningTimer=null,pendingQuestion=null,questionIndex=0,questionDrafts={},questionBusy=false,sessionBlank=true,currentPreset=null,modelCatalog=null,settingsPick='',effortPick='',settingsBusy=false,currentTodos=[],todoExpanded=false,tokenStream=null,turnOpenState=new Map(),sessionCache=new Map(),embeddedFocus=null,expandedWsIds=new Set(),expandedInitDone=false,currentGoal=null,queuedTurn=[],queueBusy=false,queueEditing=null,queueEditText='',goalBusy=false,goalEditing=false,goalEditText='',stopPending=false,projectionsSyncTimer=null,busyEnter='queue',transcriptView='standard',performanceUsage='detailed',composerDrafts=[],provisionalSession=false;
const $=id=>document.getElementById(id);
// The bridge labels every failure family with errorCode; the page read none of them,
// so a desktop that is not reachable and a request the bridge refused both rendered as
// the same generic failure (audit X4-9). A known family names its tier, an unknown one
// keeps the bridge's own words, and a body that is not JSON falls back on the status.
const BRIDGE_TRANSPORT_CODES=['__bridge/not-ready','__bridge/transport','__bridge/rpc-mismatch'];
function rpcFailure(body,status){const code=typeof body?.errorCode==='string'?body.errorCode:'';const transport=BRIDGE_TRANSPORT_CODES.includes(code)||status===502||status===503;const detail=typeof body?.error==='string'&&body.error?body.error:L.failed;const e=new Error(transport?L.streamDownHost:detail);e.errorCode=code;return e}
async function rpc(method,payload={},timeoutMs){const budget=timeoutMs||((method==='file.upload'||method==='command.execute'||method==='session.prompt')?RPC_SLOW_TIMEOUT_MS:RPC_TIMEOUT_MS);const controller=typeof AbortController==='function'?new AbortController():null;const timer=controller?setTimeout(()=>controller.abort(),budget):null;let r;try{r=await fetch('/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,payload}),...(controller?{signal:controller.signal}:{})})}catch(cause){const aborted=!!(controller&&controller.signal.aborted);const e=new Error(aborted?L.requestTimeout:'');e.disconnected=!aborted;e.timeout=aborted;e.cause=cause;throw e}finally{if(timer!==null)clearTimeout(timer)}if(r.url&&new URL(r.url).pathname==='/consent'){const e=new Error('');e.consentGate=true;location.replace('/consent?next=/');throw e}if(r.status===401){const e=new Error('');e.disconnected=true;throw e}let j;try{j=await r.json()}catch{j=null}if(!r.ok||!j||!j.ok)throw rpcFailure(j,r.status);return j.value}
// A dropped stream and a turn the desktop failed both explain themselves, and the next
// successful poll must not erase them: that pair of erasures is what made a disconnect
// invisible (P0-C). importantErrorActive is the flag the recovery path releases.
function isStreamDownCopy(text){const value=String(text||'');return value===L.disconnectedRetry||value===L.streamDownTunnel||value===L.streamDownHost||value===L.streamDownBackground}
function importantChatCopy(text){return isStreamDownCopy(text)||isStreamCodeCopy(text)||String(text||'').indexOf(L.streamFailure)===0}
// The bridge sends a locale-free reason; its English message is diagnosis only.
// Every branch still starts with L.streamFailure, because importantChatCopy() keys off
// that prefix to decide whether a clean poll is allowed to erase the line — except a
// code the map knows, which names the reason in plain words instead (and stays standing
// because the failure listener marks it important).
function streamFailureCopy(frame){const code=frame&&frame.code;if(code&&frame.reason==='host-error'&&STREAM_CODE_COPY[code])return L[STREAM_CODE_COPY[code]];const known={backoff:L.streamFailBackoff,transport:L.streamFailTransport,'host-error':L.streamFailHost};const copy=known[frame&&frame.reason]||(frame&&frame.message)||L.streamFailure;return copy+(frame&&frame.code?' ('+frame.code+')':'')}
// A standing chat notice used to be permanent: it only left when a stream frame proved
// recovery, and the drop that painted it often delivered no further frame at all. Three
// exits now exist — the frame (unchanged), a 90s deadline armed right here, and a tap on
// the banner's right end. The deadline and the tap both ask the transient guard instead of
// assigning text, so the "no bare erasure" rule the disconnect audit pinned stays true.
// The deadline is written as a literal so this function stays extractable by the notice
// sandboxes, which own the page flags but not a module-scope constant.
function showError(id,error,fallback){const text=error?.disconnected?L.disconnectedRetry:streamCodeCopy(error?.errorCode)||error?.message||fallback||L.failed;if(id==='chatError'&&error?.disconnected){streamDownNoticeShown=true;const bar=$('reconnectBar');if(bar){bar.textContent=text;bar.hidden=false}setStatusCopy(L.statusReconnecting);return}$(id).textContent=text;if(id==='chatError'){importantErrorActive=!!(error?.disconnected||error?.important)||importantChatCopy(text);const painted=text;if(importantErrorActive&&typeof setTimeout==='function'){const deadline=setTimeout(()=>{const el=$('chatError');if(el&&el.textContent===painted)dismissChatNotice(el,null,{force:true})},90000);if(typeof deadline?.unref==='function')deadline.unref()}}}
function clearTransientError(id){if(id==='chatError'&&importantErrorActive)return;const el=$(id);if(el)el.textContent=''}
// The notice's right end doubles as its dismiss control. #chatError stays a plain content
// element (the empty-banner collapse and its structural lock both depend on it being
// empty when there is nothing to say), so the affordance is CSS and this only reads where
// the tap landed. The 90s deadline enters through the same door with force, because it has
// no pointer to locate and its own caller already proved the copy is the one it armed for:
// one function decides every exit, so the "no bare erasure" rule lives in one place.
let chatErrorTapZone=false;
function dismissChatNotice(el,event,options){if(!options?.force){if(!chatErrorTapZone)return;const box=el&&typeof el.getBoundingClientRect==='function'?el.getBoundingClientRect():null;const x=event&&event.clientX;if(!box||typeof x!=='number'||x<box.right-40)return}importantErrorActive=false;clearTransientError('chatError');setStatusCopy(L.statusConnected)}
function stepKey(d){return String(d.turn)+':'+String(d.step)}
function contentBlocks(content){return(Array.isArray(content)?content:[]).flatMap(block=>{if(block?.type==='text'&&block.text)return[{kind:'text',text:block.text}];if(block?.type==='reasoning'&&block.text)return[{kind:'reasoning',text:block.text}];if(block?.type==='tool-call')return[{kind:'tool',id:block.id,name:block.name,args:block.arguments,status:'running'}];if(block?.type==='image'&&block.attachment)return[{kind:'image',attachment:block.attachment,offloaded:block.offloaded===true}];if(block?.type==='file'&&block.attachment)return[{kind:'file',attachment:block.attachment}];return[]})}
function eventSeq(entry){const e=entry&&(entry.event||entry);const s=e&&e.seq;return typeof s==='number'?s:-1}
// Records that carry no seq keep the position at which they arrived instead of
// being appended after the whole transcript, which made them jump below newer
// turns. Their key is anchored to the seq immediately before them plus a share
// of the run position, so the same record keeps the same key no matter what
// else is merged alongside it (the old cursor key moved when history was
// prepended). Duplicate seqs are still dropped (first occurrence wins).
function mergeEntries(list){const map=new Map(),rows=[];let anchor=-1,run=0;for(let i=0;i<list.length;i+=1){const entry=list[i],s=eventSeq(entry);if(s>=0){if(map.has(s))continue;map.set(s,entry);anchor=s;run=0;rows.push({key:s,entry});continue}run+=1;rows.push({key:anchor+0.5*(run/(run+1)),entry})}rows.sort((a,b)=>a.key-b.key);mergeEntries.lastKeys=rows.map(row=>row.key);return rows.map(row=>row.entry)}
// Older pages (pull-older) sit below the live SSE snapshot window; merged by seq.
// One frame paints the transcript and then judges the running turn from the same
// window, so the merge ran twice per frame on every streamed token. The result is
// cached against the exact inputs it was built from: the two source arrays by
// identity plus the revision counter the stream bumps on every record. Any of
// them moving recomputes; nothing else does.
function windowEvents(){const key=olderEvents.length+':'+streamEvents.length+':'+(typeof streamRevision==='number'?streamRevision:'-');if(windowEvents._key===key&&windowEvents._older===olderEvents&&windowEvents._stream===streamEvents){windowEvents.hits=(windowEvents.hits||0)+1;return windowEvents._rows}windowEvents._key=key;windowEvents._older=olderEvents;windowEvents._stream=streamEvents;windowEvents.misses=(windowEvents.misses||0)+1;windowEvents._rows=mergeEntries(olderEvents.concat(streamEvents));return windowEvents._rows}
function visibleMessages(events){if(typeof noteSessionPaths==='function')noteSessionPaths(events);const out=[],steps=new Map(),turns=new Map();let seqOf=-1;const eventTime=record=>{const source=record&&(record.event||record),t=source&&source.time;return typeof t==='number'&&Number.isSafeInteger(t)&&t>0?t:undefined};const normalizeUsage=u=>{if(!u||typeof u!=='object'||Array.isArray(u))return undefined;const ip=u.inputTokens,op=u.outputTokens,tt=u.totalTokens,cr=u.cacheReadTokens,cw=u.cacheWriteTokens,rs=u.reasoningTokens;const count=v=>Number.isSafeInteger(v)&&v>=0;if(!count(ip)||!count(op)||!count(tt))return undefined;if(cr!==undefined&&!count(cr))return undefined;if(cw!==undefined&&!count(cw))return undefined;if(rs!==undefined&&(!count(rs)||rs>op))return undefined;if(tt-op<ip+(cr||0)+(cw||0))return undefined;if(cr!==undefined&&cw!==undefined&&tt-op!==ip+cr+cw)return undefined;const clean={inputTokens:ip,outputTokens:op,totalTokens:tt};if(cr!==undefined)clean.cacheReadTokens=cr;if(cw!==undefined)clean.cacheWriteTokens=cw;if(rs!==undefined)clean.reasoningTokens=rs;return clean};function ensureTurn(d){const key=String(d.turn??''),existing=turns.get(key);if(existing)return existing;const created={nodes:[],closed:false,key:key,_seq:seqOf};turns.set(key,created);out.push({turn:created});return created}function ensureStep(d){const key=stepKey(d);if(!steps.has(key)){const node={role:'assistant',blocks:[],streaming:true,_step:d.step,_seq:seqOf};steps.set(key,node);ensureTurn(d).nodes.push(node)}return steps.get(key)}for(const entry of events){seqOf=eventSeq(entry);const e=entry.event||entry,d=e.data||{},t=String(e.type||'').toLowerCase();if(t==='user/message'){const message=d.message||d;if(message.source?.kind==='user'){const blocks=contentBlocks(message.content).filter(block=>block.kind==='text'||block.kind==='image'||block.kind==='file');if(blocks.length)out.push({role:'user',blocks,_seq:seqOf,messageTime:eventTime(e)})}continue}if(t==='deliverables/presented'){const files=Array.isArray(d.files)?d.files.filter(f=>f&&typeof f.path==='string'&&f.path):[];if(files.length)out.push({role:'assistant',blocks:[{kind:'presented',files}],_seq:seqOf});continue}if(t==='assistant/chunk'){const chunk=d.chunk||{};if(chunk.type!=='text-delta'&&chunk.type!=='reasoning-delta')continue;const node=ensureStep(d),kind=chunk.type==='text-delta'?'text':'reasoning',streamKey=kind+':'+String(chunk.index??0);let block=node.blocks.find(item=>item?._streamKey===streamKey);if(!block){block={kind,text:'',_streamKey:streamKey};node.blocks.push(block)}block.text+=chunk.text||chunk.delta||'';continue}if(t==='assistant/message'){const node=ensureStep(d),turn=ensureTurn(d),blocks=contentBlocks(d.message?.content);node.blocks=blocks;node.streaming=false;node.messageTime=eventTime(e);turn.usage=d.usage;continue}if(t==='tool/call'){const node=ensureStep(d);if(!node.blocks.some(block=>block?.kind==='tool'&&block.id===d.callId))node.blocks.push({kind:'tool',id:d.callId,name:d.name,args:d.arguments,status:'running'});continue}if(t==='tool/result'){const node=ensureStep(d),result=(d.message?.content||[]).find(block=>block?.type==='tool-result'),id=result?.toolCallId;let tool=node.blocks.find(block=>block?.kind==='tool'&&block.id===id);if(!tool){tool={kind:'tool',id,name:id||'tool',args:'',status:'running'};node.blocks.push(tool)}tool.status=d.error||result?.isError?'error':'done';tool.result=(result?.content||[]).filter(block=>block?.type==='text').map(block=>block.text).join('\\n');node.streaming=false}if(t==='turn/end'){const turn=ensureTurn(d),reason=d.reason||{},kind=String(reason.kind||'completed');let label='',detail='';if(kind==='error'){label=L.turnError;detail=reason.error?.message||reason.error?.code||''}else if(kind==='aborted'){label=L.turnAborted;detail=reason.reason?.message||''}else if(kind==='blocked'){label=L.turnBlocked}else if(kind==='max-tokens'){label=L.turnMaxTokens}else if(kind==='interrupted'){label=L.turnInterrupted}if(label){out.push({role:'turn-error',blocks:[{kind:'turn-error',label,detail}]})}turn.closed=true}}function processBlocks(turn){const blocks=[];for(const node of turn.nodes){for(const block of node.blocks){if(block&&(block.kind==='tool'||block.kind==='reasoning'))blocks.push(block)}}return blocks}
  const rendered=[];for(const item of out){if(item.role==='user'){rendered.push(item);continue}if(item.role==='turn-error'){rendered.push(item);continue}if(item.role==='assistant'&&!item.turn){rendered.push(item);continue}const turn=item.turn,live=!turn.closed;let group=[],segment=0,lastText=-1,lastTime=undefined,thinkSeq=0;const flushGroup=done=>{if(!group.length)return;if(group.some(entry=>entry.block.kind==='tool')){rendered.push({role:'assistant',turnProcess:true,turnKey:turn.key,segment,blocks:group.map(entry=>entry.block),streaming:done?false:live,_seq:turn._seq});segment+=1}else{const base=turn.key+'#think';for(const entry of group)rendered.push({role:'assistant',streaming:done?false:entry.stream,blocks:[entry.block],_seq:entry.seq,openKey:base+thinkSeq++})}group=[]};// One step's reasoning heads the answer it produced: same message, not a fold that
// reads like an appendix to the answer above it (user's call 2026-10-10, over a
// spacing-only patch). Reasoning with no text of its own still falls into the group,
// so the process card is untouched.
for(const node of turn.nodes){const streamText=live&&!!node.streaming;const list=node.blocks;let head=0;while(list[head]&&list[head].kind==='reasoning')head++;let lead=list.slice(0,head);const stash=()=>{for(const one of lead)group.push({block:one,stream:streamText,seq:node._seq});lead=[]};for(const block of list.slice(head)){if(!block)continue;if(block.kind==='tool'||block.kind==='reasoning'){stash();group.push({block,stream:streamText,seq:node._seq});continue}if((block.kind==='text'&&block.text)||block.kind==='image'||block.kind==='file'){flushGroup(true);const message={role:'assistant',streaming:streamText,blocks:lead.length?lead.concat([block]):[block],_seq:node._seq,messageTime:node.messageTime};if(lead.length)message.openKey=turn.key+'#think'+thinkSeq++;lead=[];rendered.push(message);lastText=rendered.length-1;lastTime=node.messageTime}}stash()}flushGroup(false);if(lastText>=0){rendered[lastText].messageTime=lastTime;rendered[lastText].usage=normalizeUsage(turn.usage)}}
  return rendered.filter(message=>message.blocks?.length)}
function inlineMarkdown(text){const known=activeSession&&typeof knownPathsOf==='function'?knownPathsOf(activeSession):null,found=[];let source=String(text??'').replace(/!\\[([^\\]]*)\\]\\((?:<([^>]*)>|([^)\\s]+))\\)/g,function(match,alt,bracketed,bare){const path=bracketed||bare||'';if(known&&known.has(path)){found.push({alt:alt,path:path});return '\\u0001'+(found.length-1)+'\\u0001'}return match});let html=esc(source).replace(/\\x60([^\\x60]+)\\x60/g,'<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>').replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^ )]+)\\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>');if(found.length)html=html.replace(/\\u0001(\\d+)\\u0001/g,function(match,index){const img=found[Number(index)];if(!img)return match;return '<img class="md-image" loading="lazy" data-lightbox="image" data-name="'+esc(baseNameOf(img.path))+'" data-path="'+esc(img.path)+'" src="'+sessionFileUrl(img.path)+'" alt="'+esc(img.alt||baseNameOf(img.path))+'">'});return html}
function tableCells(line){let value=line.trim();if(value.startsWith('|'))value=value.slice(1);if(value.endsWith('|'))value=value.slice(0,-1);return value.split('|').map(cell=>cell.trim())}
function markdown(text){const lines=String(text||'').split('\\n');let html='',code=false,list=false;for(let i=0;i<lines.length;i++){const line=lines[i];if(line.trim().startsWith(String.fromCharCode(96,96,96))){if(list){html+='</ul>';list=false}html+=code?'</code></pre>':'<pre><code>';code=!code;continue}if(code){html+=esc(line)+'\\n';continue}const next=lines[i+1]||'',separator=next.trim().replace(/^\\||\\|$/g,'').split('|');if(line.includes('|')&&separator.length>0&&separator.every(cell=>/^\\s*:?-{3,}:?\\s*$/.test(cell))){if(list){html+='</ul>';list=false}const headers=tableCells(line);html+='<div class="table-wrap"><table><thead><tr>'+headers.map(cell=>'<th>'+inlineMarkdown(cell)+'</th>').join('')+'</tr></thead><tbody>';i+=2;while(i<lines.length&&lines[i].includes('|')&&lines[i].trim()){html+='<tr>'+tableCells(lines[i]).map(cell=>'<td>'+inlineMarkdown(cell)+'</td>').join('')+'</tr>';i++}i--;html+='</tbody></table></div>';continue}const heading=line.match(/^(#{1,3})\\s+(.+)$/);if(heading){if(list){html+='</ul>';list=false}const level=heading[1].length;html+='<h'+level+'>'+inlineMarkdown(heading[2])+'</h'+level+'>';continue}const bullet=line.match(/^[-*]\\s+(.+)$/);if(bullet){if(!list){html+='<ul>';list=true}html+='<li>'+inlineMarkdown(bullet[1])+'</li>';continue}if(list){html+='</ul>';list=false}if(line.trim())html+='<p>'+inlineMarkdown(line)+'</p>'}if(list)html+='</ul>';if(code)html+='</code></pre>';return html}
function pretty(value){if(!value)return'';if(typeof value==='object')return JSON.stringify(value,null,2);try{return JSON.stringify(JSON.parse(value),null,2)}catch{return String(value)}}
function activityIcon(kind){return kind==='think'?'<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 1.75a4 4 0 0 0-2.66 6.98c.43.38.66.88.66 1.4v.12h4v-.12c0-.52.23-1.02.66-1.4A4 4 0 0 0 7 1.75Z" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/><path d="M5.4 12h3.2M5.75 10.25h2.5" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>':'<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1.75" y="2.25" width="10.5" height="9.5" rx="2" stroke="currentColor" stroke-width="1.15"/><path d="m4 5 1.5 1.5L4 8M7.5 8h2.5" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
function activityChevron(){return'<span class="activity-chevron" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'}
function reasoningSummary(text,streaming){const lines=String(text||'').split('\\n').map(line=>line.trim()).filter(Boolean);return lines.length?(streaming?lines[lines.length-1]:lines[0]):L.running}
// Expansion state used to survive for the turn fold only, so a thinking or tool block the
// user had opened snapped shut on the next repaint. Both kinds now share one key space,
// with turn: / block: prefixes keeping the two namespaces apart. The map is capped so a
// long conversation cannot keep growing it, and the oldest entry goes first.
function rememberOpenState(key,open){if(!key)return;turnOpenState.set(key,open);const max=typeof TURN_OPEN_STATE_MAX==='number'?TURN_OPEN_STATE_MAX:400;while(turnOpenState.size>max){const oldest=turnOpenState.keys().next().value;turnOpenState.delete(oldest)}}
// Webviews built on the older WebKit toggle path refuse to flip a native
// <details> whose <summary> is display:flex — and every fold header on this page
// is flex. Desktop chrome is unaffected, which is exactly the reported shape:
// folds tap fine on the desktop browser but "点开没反应" on the phone. The
// desktop client does not rely on the native toggle either — its process-group
// header is a button with an onClick driver — so this page drives the flip the
// same way: a delegated tap on a summary preventDefaults the native action (on
// healthy browsers that suppression is what avoids a native+manual double flip)
// and sets .open by hand. The toggle listener above then records the state, so
// the manual flip survives the next repaint just like a native one.
function bindOpenState(root){root.querySelectorAll('details.turn-process,details.thinking,details.tool').forEach(el=>{if(el.dataset.openBound)return;el.dataset.openBound='1';el.addEventListener('toggle',()=>rememberOpenState(el.dataset.openKey,el.open))});const box=root.closest?root.closest('#messages'):null;if(box&&!box.dataset.summaryTapBound){box.dataset.summaryTapBound='1';box.addEventListener('click',event=>{if(event.defaultPrevented)return;const summary=event.target&&event.target.closest?event.target.closest('summary'):null;if(!summary||!box.contains(summary))return;const details=summary.parentElement;if(!details||details.tagName!=='DETAILS')return;event.preventDefault();details.open=!details.open;if(typeof rememberOpenState==='function'&&details.dataset.openKey!==undefined)rememberOpenState(details.dataset.openKey,details.open)})}}
// The warm-transcript cache is a Map, and a Map keeps INSERTION order: re-setting
// an existing key leaves it where it was, so recency is kept at the hit site (delete then set) and eviction drops the front.
function evictSessionCache(){const max=typeof SESSION_CACHE_MAX==='number'?SESSION_CACHE_MAX:4;while(sessionCache.size>max){const oldest=sessionCache.keys().next().value;sessionCache.delete(oldest)}}
  // An image whose attachment the host has already dropped used to render as an
  // empty string, and the rule that hides an empty message then took the whole row
  // out of the transcript: a history message that was only a picture simply
  // vanished. It leaves a named chip in its place now.
function renderBlock(block,streaming,openKey){if(!block)return'';if(block.kind==='turn-error')return'<div class="turn-error-bubble"><svg width="15" height="15" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7.2" fill="currentColor"/><path d="M9 5v4.4" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="9" cy="12.1" r=".95" fill="#fff"/></svg><span class="turn-error-text"><span class="turn-error-title">'+esc(block.label)+'</span>'+(block.detail?'<span class="turn-error-detail">'+esc(block.detail)+'</span>':'')+'</span></div>';if(block.kind==='text')return'<div class="markdown'+(streaming?' streaming':'')+'">'+markdown(block.text)+'</div>';if(block.kind==='reasoning'){if(!streaming&&transcriptView==='compact')return'';const state=streaming?'running':'ok',held=typeof turnOpenState==='undefined'?undefined:turnOpenState.get(openKey),open=held===true||(held!==false&&transcriptView==='verbose');return'<details class="thinking"'+(open?' open':'')+' data-open-key="'+esc(openKey||'')+'" data-state="'+state+'"><summary><span class="activity-leading">'+activityIcon('think')+'</span><span class="activity-title">'+L.think+'</span><span class="activity-dot" aria-hidden="true"></span><span class="activity-summary">'+esc(reasoningSummary(block.text,streaming))+'</span>'+activityChevron()+'</summary><div class="thinking-body markdown'+(streaming?' streaming':'')+'">'+markdown(block.text)+'</div></details>'}if(block.kind==='tool')return renderToolCard({category:toolActivityCategory(block.name),items:[{block,index:-1}]},openKey);if(block.kind==='image'){const a=block.attachment||{};if(block.offloaded||!a.attachmentId)return'<div class="attach-image attach-gone"><span>'+esc(L.imageGone)+'</span></div>';return'<div class="attach-image"><img loading="lazy" data-lightbox="image" data-name="'+esc(a.name||'image')+'" src="/api/session-attachment?sessionId='+encodeURIComponent(activeSession)+'&attachmentId='+encodeURIComponent(a.attachmentId)+'" alt="'+esc(a.name||'image')+'"></div>'}if(block.kind==='file'){const a=block.attachment||{};if(a.attachmentId){if(isTextualAttachment(a))return'<button type="button" class="attach-file attach-file-open" data-file-preview="'+esc(a.attachmentId)+'" data-file-name="'+esc(a.name||L.fileChip)+'" aria-label="'+esc(L.previewFile)+'"><svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M10 2.5H5.2A1.7 1.7 0 0 0 3.5 4.2v9.6c0 .94.76 1.7 1.7 1.7h7.6c.94 0 1.7-.76 1.7-1.7V7L10 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.8 2.8v4.3h4.1" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg><span class="attach-file-name">'+esc(a.name||L.fileChip)+'</span>'+(a.bytes?'<span class="attach-file-bytes">'+formatBytes(a.bytes)+'</span>':'')+'<span class="attach-file-action" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8Z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.9" stroke="currentColor" stroke-width="1.3"/></svg></span></button>';return'<a class="attach-file attach-file-open" href="/api/session-attachment?sessionId='+encodeURIComponent(activeSession)+'&attachmentId='+encodeURIComponent(a.attachmentId)+'" download><svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M10 2.5H5.2A1.7 1.7 0 0 0 3.5 4.2v9.6c0 .94.76 1.7 1.7 1.7h7.6c.94 0 1.7-.76 1.7-1.7V7L10 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.8 2.8v4.3h4.1" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg><span class="attach-file-name">'+esc(a.name||L.fileChip)+'</span>'+(a.bytes?'<span class="attach-file-bytes">'+formatBytes(a.bytes)+'</span>':'')+'<span class="attach-file-action" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 3v8M8 11 4.5 7.5M8 11l3.5-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span></a>'}return'<span class="attach-file"><svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M10 2.5H5.2A1.7 1.7 0 0 0 3.5 4.2v9.6c0 .94.76 1.7 1.7 1.7h7.6c.94 0 1.7-.76 1.7-1.7V7L10 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.8 2.8v4.3h4.1" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg><span class="attach-file-name">'+esc(a.name||L.fileChip)+'</span>'+(a.bytes?'<span class="attach-file-bytes">'+formatBytes(a.bytes)+'</span>':'')+'</span>'}if(block.kind==='presented'){const files=Array.isArray(block.files)?block.files:[],cards=[];for(const f of files){const p=f&&typeof f.path==='string'?f.path:'';if(!p)continue;const name=baseNameOf(p),desc=f&&typeof f.description==='string'?f.description:'';if(isImagePath(p)){cards.push('<figure class="attach-image presented-image"><img loading="lazy" data-lightbox="image" data-name="'+esc(name)+'" data-path="'+esc(p)+'" src="'+sessionFileUrl(p)+'" alt="'+esc(desc||name)+'">'+(desc?'<figcaption class="presented-desc">'+esc(desc)+'</figcaption>':'')+'</figure>')}else{cards.push('<a class="attach-file presented-file" href="'+sessionFileUrl(p)+'" download="'+esc(name)+'"><svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M10 2.5H5.2A1.7 1.7 0 0 0 3.5 4.2v9.6c0 .94.76 1.7 1.7 1.7h7.6c.94 0 1.7-.76 1.7-1.7V7L10 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.8 2.8v4.3h4.1" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg><span class="attach-file-name">'+esc(name)+'</span>'+(desc?'<span class="attach-file-desc">'+esc(desc)+'</span>':'')+'</a>')}}return cards.length?'<div class="presented-group">'+cards.join('')+'</div>':''}return''}
// ---- Image/file capability organs (2026-10-07-feat-pocket-image-file-capability).
// Pure name/type helpers for the attachment cards, the presented-file cards and
// the markdown-image rewrite. They sit between renderBlock and renderTurnProcess
// on purpose: the renderer sandboxes slice exactly that window, so anything the
// image/file branches call must travel with it. sessionFileUrl reads
// activeSession the way renderBlock's attachment links already do.
function baseNameOf(path){const value=String(path||''),cut=Math.max(value.lastIndexOf('\\\\'),value.lastIndexOf('/'));return cut>=0?value.slice(cut+1):value}
function extOf(path){const name=baseNameOf(path),dot=name.lastIndexOf('.');return dot>0?name.slice(dot+1).toLowerCase():''}
const IMAGE_FILE_EXTS=['png','jpg','jpeg','gif','webp','bmp','avif'];
function isImagePath(path){return IMAGE_FILE_EXTS.includes(extOf(path))}
const TEXT_FILE_EXTS=['txt','md','markdown','json','xml','yml','yaml','toml','ini','cfg','conf','csv','tsv','log','js','mjs','cjs','ts','tsx','jsx','css','scss','html','htm','sh','bash','zsh','bat','cmd','ps1','py','rb','php','java','c','h','cpp','hpp','cs','go','rs','swift','kt','sql','diff','patch','env'];
function isTextualAttachment(attachment){const media=String((attachment&&attachment.mediaType)||'').toLowerCase();if(media){if(media.indexOf('text/')===0)return true;if(media==='application/json'||media==='application/xml'||media==='application/javascript'||media==='application/x-sh'||media==='application/sql')return true;if(/\\+(json|xml)$/.test(media))return true;return false}return TEXT_FILE_EXTS.includes(extOf((attachment&&attachment.name)||''))}
function sessionFileUrl(path){return '/api/session-file?sessionId='+encodeURIComponent(activeSession)+'&path='+encodeURIComponent(path)}
// The tool card speaks the Host desktop's verb language: the title is a human
// phrase ("正在读取文件" / "已读取 3 个文件"), the body leads with a red/green
// diff for edits and writes, and the raw args/result JSON demotes to a second
// "technical details" fold. Consecutive same-category calls arrive here merged
// (clusterToolBlocks), so one run of reads is one card with a row per file.
function toolClusterState(cluster){return cluster.items.some(item=>item.block.status==='running')?'running':cluster.items.some(item=>item.block.status==='error')?'error':'done'}
function toolArgsOf(block){const args=block.args;if(args&&typeof args==='object')return args;if(typeof args==='string'){try{return JSON.parse(args)}catch{return null}}return null}
function diffRowsHtml(rows,cap,keep){const row=item=>'<div class="diff-line '+(item[0]==='del'?'diff-line-del':'diff-line-add')+'"><span class="diff-mark" aria-hidden="true">'+(item[0]==='del'?'-':'+')+'</span><span class="diff-text">'+esc(item[1]===''?' ':item[1])+'</span></div>';if(rows.length<=cap)return rows.map(row).join('');return rows.slice(0,keep).map(row).join('')+'<div class="diff-line diff-elide">'+esc(String(L.diffMore||'…').replace('{n}',String(rows.length-keep*2)))+'</div>'+rows.slice(rows.length-keep).map(row).join('')}
function renderToolDiff(block){const args=toolArgsOf(block);if(!args)return'';if(typeof args.old_string==='string'||typeof args.new_string==='string'){const split=diffLineSplit(args.old_string||'',args.new_string||'');return diffRowsHtml(split.del.map(text=>['del',text]).concat(split.add.map(text=>['add',text])),40,20)}if(typeof args.content==='string'&&args.content){const lines=args.content.replace(/\\r\\n?/g,'\\n').split('\\n');return diffRowsHtml(lines.slice(0,60).map(text=>['add',text]),60,60)+(lines.length>60?'<div class="diff-line diff-elide">'+esc(String(L.diffMore||'…').replace('{n}',String(lines.length-60)))+'</div>':'')}return''}
function renderToolRaw(items,merged){const body=items.map(item=>{const block=item.block;if(merged)return (block.args?'<strong>'+esc(block.name||'tool')+'</strong><pre>'+esc(pretty(block.args))+'</pre>':'')+(block.result?'<pre>'+esc(block.result)+'</pre>':'');return (block.args?'<strong>'+L.input+'</strong><pre>'+esc(pretty(block.args))+'</pre>':'')+(block.result?'<strong>'+L.output+'</strong><pre>'+esc(block.result)+'</pre>':'')}).join('');if(!body)return'';return'<details class="tool-raw"><summary>'+esc(L.toolRaw||'')+'</summary><div class="tool-raw-body">'+body+'</div></details>'}
function renderToolCard(cluster,openKey){
  const first=cluster.items[0].block
  if(pendingQuestion&&cluster.category==='questions'&&cluster.items.length===1&&first.status==='running'&&first.name==='ask_user_question')return''
  const state=toolClusterState(cluster),merged=cluster.items.length>1
  const verbs=L.stepVerbs||{},dones=L.stepDone||{}
  const title=state==='running'?(verbs[cluster.category]||verbs.tools):(dones[cluster.category]||dones.tools)
  const held=typeof turnOpenState==='undefined'?undefined:turnOpenState.get(openKey),open=held===true||(held!==false&&transcriptView==='verbose')
  let head
  if(merged){head='<div class="cluster-rows">'+cluster.items.map(item=>{const block=item.block,line=toolSummaryLine(block.name,block.args),text=esc(line||block.name||'tool'),mark=block.status==='error'?'<span class="cluster-row-state" aria-hidden="true">✕</span>':'';if(cluster.category==='edit'||cluster.category==='write')return'<details class="cluster-row"><summary><span class="cluster-row-text">'+text+'</span>'+mark+'</summary><div class="cluster-row-body">'+renderToolDiff(block)+'</div></details>';return'<div class="cluster-row'+(block.status==='error'?' is-error':'')+'"><span class="cluster-row-text">'+text+'</span>'+mark+'</div>'}).join('')+'</div>'}
  else{const diff=renderToolDiff(first),line=toolSummaryLine(first.name,first.args);head=diff||(line?'<div class="cluster-rows"><div class="cluster-row"><span class="cluster-row-text">'+esc(line)+'</span></div></div>':'')}
  return'<details class="tool change-cluster"'+(open?' open':'')+' data-open-key="'+esc(openKey||'')+'" data-state="'+state+'"><summary><span class="activity-leading">'+activityIcon('tool')+'</span><span class="activity-title">'+esc(title)+'</span><span class="activity-dot" aria-hidden="true"></span><span class="activity-summary tool-status '+state+'">'+(state==='error'?esc(L.toolFailed||''):'')+'</span>'+activityChevron()+'</summary><div class="tool-body">'+head+renderToolRaw(cluster.items,merged)+'</div></details>'
}
function renderTurnProcess(message){const blocks=message.blocks.filter(Boolean);if(!blocks.length)return'';const segKey=message.segment===undefined?'':':s'+message.segment,clusters=clusterToolBlocks(blocks,toolActivityCategory),card=(cluster,index)=>cluster.type==='block'?renderBlock(cluster.block,message.streaming,'block:'+message.turnKey+segKey+':'+cluster.index):renderToolCard(cluster,'cluster:'+message.turnKey+segKey+':'+index);if(message.streaming)return'<div class="message assistant turn-process-live">'+clusters.map(card).join('')+'</div>';const openKey='turn:'+message.turnKey+segKey,userState=turnOpenState.get(openKey),open=userState===true||(userState!==false&&transcriptView==='verbose');const tally=new Map();for(const cluster of clusters){if(cluster.type!=='cluster')continue;const cat=cluster.category||'tools';tally.set(cat,(tally.get(cat)||0)+cluster.items.length)}const ranked=[...tally.entries()].map(([category,count])=>({category,count})).sort((a,b)=>b.count-a.count);const summary=stepTitleFor(ranked)||L.process;return'<details class="turn-process'+(message._history?' msg-hist':'')+'" data-open-key="'+esc(openKey)+'"'+(open?' open':'')+'><summary><span class="activity-leading">'+activityIcon('tool')+'</span><span class="activity-title">'+esc(summary)+'</span>'+activityChevron()+'</summary><div class="turn-process-body">'+clusters.map(card).join('')+'</div></details>'}
function renderMessage(message){if(message.turnProcess)return renderTurnProcess(message);const blocks=message.blocks.filter(Boolean);if(message.role==='turn-error')return blocks.map(block=>renderBlock(block,false)).join('');return'<div class="message'+(message._history?' msg-hist':'')+' '+message.role+'">'+blocks.map((block,index)=>renderBlock(block,message.streaming&&index===blocks.length-1&&(block.kind==='text'||block.kind==='reasoning'),message.openKey)).join('')+renderMessageTail(message)+'</div>'}
  function pad2(n){return String(n).padStart(2,'0')}
  function formatTokens(v){if(!Number.isFinite(v))return '';if(v<1000)return String(v);const c=v<1000000?v/1000:v/1000000;return (v<1000000?L.numberThousand:L.numberMillion).replace('{value}',String(c>=100?Math.round(c):Math.round(c*10)/10))}
  function formatMessageClock(time,now){const at=new Date(Number(time)),ref=new Date(now===undefined?Date.now():now),clock=pad2(at.getHours())+':'+pad2(at.getMinutes());const sameYear=at.getFullYear()===ref.getFullYear();if(sameYear&&at.getMonth()===ref.getMonth()&&at.getDate()===ref.getDate())return clock;if(sameYear)return L.clockMd.replace('{m}',String(at.getMonth()+1)).replace('{d}',String(at.getDate()))+' '+clock;return L.clockYmd.replace('{y}',String(at.getFullYear())).replace('{m}',String(at.getMonth()+1)).replace('{d}',String(at.getDate()))+' '+clock}
  function renderMessageTail(message){const usage=message.usage,clock=(message.messageTime&&!message.streaming)?formatMessageClock(message.messageTime):'';if(!usage&&!clock)return '';const pill=usage?'<span class="usage-pill" title="'+esc(L.turnUsageTitle)+'">'+esc(L.turnUsageConsumed.replace('{total}',L.turnUsageCount.replace('{count}',formatTokens(usage.totalTokens))))+'</span>':'';return '<span class="msg-tail">'+pill+'<span class="msg-clock">'+esc(clock)+'</span></span>'}
  // The composer used to force a reflow on every keystroke: write the minimum height,
  // read scrollHeight back, then write the real height. The height only needs revisiting
  // when the text crosses a wrap tier, so the last tier and the fact that a height was
  // written at all are remembered on the function itself. A tier is 16 characters — under
  // one CJK line at the composer's width, so the height can never lag a full line behind
  // the text. Same-tier keystrokes now touch no layout, while shrinking still crosses a
  // tier and re-measures (one read, as before).
  function syncPromptUi(){const prompt=$('prompt'),text=prompt.value,tier=text.length?Math.ceil(text.length/16):0;if(!syncPromptUi._wrote||syncPromptUi._tier!==tier){syncPromptUi._wrote=true;syncPromptUi._tier=tier;prompt.style.height='40px';prompt.style.height=Math.min(150,Math.max(40,prompt.scrollHeight))+'px'}const hasText=!!text.trim();const hasReady=!!readyDrafts().length;const canSend=hasText||hasReady;$('send').hidden=agentRunning&&!canSend;const cancel=$('cancel');cancel.hidden=!agentRunning;if(cancel._stopping!==stopPending){cancel._stopping=stopPending;cancel.innerHTML=stopPending?'<svg class="spin" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5.4" stroke="currentColor" stroke-width="2" stroke-dasharray="24 8" stroke-linecap="round"/></svg>':'<svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor"/></svg>'}cancel.disabled=stopPending;$('send').disabled=!canSend;if(typeof syncComposerHeight==='function')syncComposerHeight()}
  // The thinking status used to be retired by comparing the host's own turn/start
  // stamp with the phone's wall clock. The host stamps that time on its own machine
  // (the session log does it on append), so any skew past a second left the status
  // pinned forever — with it the send and cancel buttons stayed inverted and the
  // history poll stayed locked at its active rate. Retirement is a monotonic
  // quantity now: the send records the newest seq in this session's log and the
  // first turn boundary above that seq ends the wait. No clock from two machines is
  // ever compared, and the timer below clears the flag unconditionally in case that
  // boundary never arrives.
  function clearAwaitingTurn(){awaitingTurnSeq=null;if(awaitingTurnTimer!==null){clearTimeout(awaitingTurnTimer);awaitingTurnTimer=null}}
  function armAwaitingTurn(seq){awaitingTurnSeq=seq;if(awaitingTurnTimer!==null)clearTimeout(awaitingTurnTimer);awaitingTurnTimer=setTimeout(expireAwaitingTurn,AWAITING_TURN_MAX_MS)}
  function expireAwaitingTurn(){awaitingTurnTimer=null;awaitingTurnSeq=null;turnRunningSeq=-1;turnRunningOpen=false;agentRunning=false;stopPending=false;lastHistoryKey='';syncPromptUi();syncTurnStatus();if(activeSession)schedulePoll()}
  // Bounded retirement for the turn high-water below. The mark never times out by itself, so a turn that stops advancing would pin the phone on the thinking state forever. The watch is armed only from a log that actually moved, never from a wall clock on this machine.
  function clearTurnRunningWatch(){if(turnRunningTimer!==null){clearTimeout(turnRunningTimer);turnRunningTimer=null}}
  function expireTurnRunning(){clearTurnRunningWatch();if(pendingQuestion!==null||awaitingTurnSeq!==null){if(turnRunningOpen)turnRunningTimer=setTimeout(expireTurnRunning,TURN_RUNNING_IDLE_MAX_MS);return}if(!turnRunningOpen)return;turnRunningOpen=false;stopPending=false;if(turnRunningSeenSeq>turnRunningSeq)turnRunningSeq=turnRunningSeenSeq;agentRunning=awaitingTurnSeq!==null;lastHistoryKey='';syncPromptUi();syncTurnStatus();if(activeSession)schedulePoll()}
  function watchTurnRunning(maxSeq){if(maxSeq>turnRunningSeenSeq){turnRunningSeenSeq=maxSeq;clearTurnRunningWatch()}if(!turnRunningOpen||awaitingTurnSeq!==null||pendingQuestion!==null){clearTurnRunningWatch();return}if(turnRunningTimer===null)turnRunningTimer=setTimeout(expireTurnRunning,TURN_RUNNING_IDLE_MAX_MS)}
  // Monotonic turn high-water: a turn boundary seen once stays remembered even after the stream window trims its oldest edge, so an event-dense turn can no longer report itself finished while it is still running.
  function noteTurnBoundary(entry){const event=entry.event||entry,type=String(event.type||'').toLowerCase();if(type!=='turn/start'&&type!=='turn/end')return;const seq=eventSeq(entry);if(seq>=0){if(seq<turnRunningSeq)return;turnRunningSeq=seq}turnRunningOpen=type==='turn/start';if(turnRunningOpen){clearTurnRunningWatch();turnRunningSeenSeq=turnRunningSeq;stopPending=false}}
  function updateRunning(events){let turnBoundary=false,maxSeq=-1;for(const entry of events){const seq=eventSeq(entry);if(seq>maxSeq)maxSeq=seq;const event=entry.event||entry,t=String(event.type||'').toLowerCase();if(t!=='turn/start'&&t!=='turn/end')continue;noteTurnBoundary(entry);if(awaitingTurnSeq!==null&&eventSeq(entry)>awaitingTurnSeq)turnBoundary=true}if(turnBoundary)clearAwaitingTurn();watchTurnRunning(maxSeq);agentRunning=turnRunningOpen||awaitingTurnSeq!==null;if(!agentRunning)stopPending=false;syncPromptUi()}
  function updateGoal(projections){const next=goalOf(projections);currentGoal=next;renderGoalBar()}
  function updateQueue(projections){queuedTurn=queuedRowsOf(projections);if(queueEditing!==null)return;renderQueueDock()}
  function renderGoalBar(){const host=$('goalBar'),goal=currentGoal;host.hidden=!goal;if(!goal){host.classList.remove('is-editing');host.innerHTML='';return}const inner=goal.goal||{},phase=String(inner.phase||'active'),blocked=phase==='blocked',phases={active:L.goalPhaseActive,paused:L.goalPhasePaused,blocked:L.goalPhaseBlocked,complete:L.goalPhaseComplete},reason=inner.blockedReason&&inner.blockedReason.message||'',busy=goalBusy,editing=goalEditing;if(phase==='complete'){host.classList.remove('is-editing');host.hidden=true;host.innerHTML='';return}const rounds='<span class="goal-rounds">'+esc((goal.roundsStarted!=null?goal.roundsStarted:'?')+' / '+(inner.maxGoalRounds!=null?inner.maxGoalRounds:'?')+L.goalRoundUnit)+'</span>';if(editing){host.classList.add('is-editing');host.innerHTML='<textarea class="queue-edit-box" data-goal-edit-text>'+esc(goalEditText)+'</textarea><div class="queue-edit-row"><button class="queue-edit-btn" data-goal-action="cancel"'+(busy?' disabled':'')+'>'+esc(L.goalCancel)+'</button><button class="queue-edit-btn is-primary" data-goal-action="save"'+(busy||!goalEditText.trim()?' disabled':'')+'>'+esc(L.goalSave)+'</button></div>';return}host.classList.remove('is-editing');const GOAL_PAUSE_SVG='<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 3v10M10.5 3v10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',GOAL_RESUME_SVG='<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 2.8v10.4L12.6 8 4.5 2.8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',GOAL_EDIT_SVG='<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m11.3 2.2 2.5 2.5L6.4 12.1l-3.2.7.7-3.2 7.4-7.4Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';const acts='<span class="goal-actions">'+(phase==='active'?'<button class="queue-act" data-goal-action="pause" aria-label="'+esc(L.goalPause)+'"'+(busy?' disabled':'')+'>'+GOAL_PAUSE_SVG+'</button>':'')+(phase==='paused'||phase==='blocked'?'<button class="queue-act" data-goal-action="resume" aria-label="'+esc(L.goalResume)+'"'+(busy?' disabled':'')+'>'+GOAL_RESUME_SVG+'</button>':'')+'<button class="queue-act" data-goal-action="edit" aria-label="'+esc(L.goalEdit)+'"'+(busy?' disabled':'')+'>'+GOAL_EDIT_SVG+'</button><button class="queue-act is-danger" data-goal-action="clear" aria-label="'+esc(L.goalClear)+'"'+(busy?' disabled':'')+'>×</button></span>';host.innerHTML='<span class="goal-phase'+(blocked?' is-blocked':'')+'"'+(reason?' title="'+esc(reason)+'"':'')+'>'+esc(phases[phase]||phase)+'</span><span class="goal-objective">'+esc(inner.objective||'')+'</span>'+rounds+acts}
  // GoalBar verbs — the desktop GoalDock's pause / resume / edit / clear, through
  // the goals.* RPCs. The CAS ref is read from the goal projection at call time
  // ({id,revision} off currentGoal.goal); a stale ref is the Host's guard, not
  // ours — success re-pulls the projections so the bar shows the Host's answer.
  async function goalAction(verb,successLabel,failLabel){if(goalBusy||!activeSession)return;const inner=currentGoal&&currentGoal.goal;if(!inner||inner.id==null||inner.revision==null)return;const owner=activeSession;goalBusy=true;renderGoalBar();try{await rpc('goals.'+verb,{sessionId:owner,ref:{id:inner.id,revision:inner.revision}});if(goalEditing){goalEditing=false;goalEditText=''}if(activeSession===owner){await fetchProjectionsNow(owner);showToast(successLabel)}}catch(e){showToast(failLabel+(e&&e.message?' · '+e.message:''))}finally{goalBusy=false;if(activeSession===owner)renderGoalBar()}}
  function startGoalEdit(){if(goalBusy)return;const inner=currentGoal&&currentGoal.goal;if(!inner)return;goalEditing=true;goalEditText=inner.objective||'';renderGoalBar();const box=$('goalBar').querySelector('[data-goal-edit-text]');if(box)box.focus()}
  function cancelGoalEdit(){if(goalBusy)return;goalEditing=false;goalEditText='';renderGoalBar()}
  function saveGoalEdit(){if(goalBusy||!goalEditing)return;const text=goalEditText.trim();if(!text)return;const inner=currentGoal&&currentGoal.goal;if(!inner||inner.id==null||inner.revision==null)return;goalBusy=true;renderGoalBar();void rpc('goals.edit',{sessionId:activeSession,ref:{id:inner.id,revision:inner.revision},request:{objective:text}}).then(async()=>{goalEditing=false;goalEditText='';goalBusy=false;showToast(L.goalEdited);if(activeSession)await fetchProjectionsNow(activeSession)}).catch(e=>{goalBusy=false;showToast(L.goalEditFailed+(e&&e.message?' · '+e.message:''));renderGoalBar()})}
  function renderQueueDock(){const host=$('queueDock'),rows=queuedTurn,visible=rows.length>0;host.hidden=!visible;document.body.classList.toggle('queue-open',visible);if(!visible){host.innerHTML='';syncQueueHeight(host);return}const STEER_SVG='<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 13V3M8 3 3.8 7.2M8 3l4.2 4.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',EDIT_SVG='<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m11.3 2.2 2.5 2.5L6.4 12.1l-3.2.7.7-3.2 7.4-7.4Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',REMOVE_SVG='<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 3.5 9 9m0-9-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';host.innerHTML='<div class="queue-header"><span class="queue-title">'+esc(L.queueCount.replace('{n}',String(rows.length)))+'</span></div><div class="queue-list">'+rows.map(row=>{if(queueEditing===row.id){return '<div class="queue-item is-editing"><textarea class="queue-edit-box" data-queue-edit-text>'+'\\n'+esc(queueEditText)+'</textarea><div class="queue-edit-row"><button class="queue-edit-btn" data-queue-action="cancel"'+(queueBusy?' disabled':'')+'>'+esc(L.queueCancel)+'</button><button class="queue-edit-btn is-primary" data-queue-action="save" data-id="'+esc(row.id)+'"'+(queueBusy||!queueEditText.trim()?' disabled':'')+'>'+esc(L.queueSave)+'</button></div></div>'}const acts=!row.managed||queueBusy?'':'<span class="queue-actions"><button class="queue-act" data-queue-action="steer" data-id="'+esc(row.id)+'" aria-label="'+esc(L.queueSteer)+'">'+STEER_SVG+'</button>'+(!row.images&&!row.files?'<button class="queue-act" data-queue-action="edit" data-id="'+esc(row.id)+'" aria-label="'+esc(L.queueEdit)+'">'+EDIT_SVG+'</button>':'')+'<button class="queue-act is-danger" data-queue-action="remove" data-id="'+esc(row.id)+'" aria-label="'+esc(L.queueRemove)+'">'+REMOVE_SVG+'</button></span>';return '<div class="queue-item"><span class="queue-text">'+esc(row.text||L.queueUnrenderable)+'</span>'+(row.images?'<span class="queue-chip">'+esc(row.images+' '+L.queueImage)+'</span>':'')+(row.files?'<span class="queue-chip">'+esc(row.files+' '+L.queueFile)+'</span>':'')+acts+'</div>'}).join('')+'</div>';syncQueueHeight(host)}
  function fetchProjectionsNow(sessionId){return rpc('session.projections',{sessionId}).then((value)=>{if(activeSession!==sessionId)return;updateGoal(value);updateQueue(value)}).catch(()=>{})}
  function scheduleProjectionsSync(sessionId){if(projectionsSyncTimer!==null)return;projectionsSyncTimer=setTimeout(()=>{projectionsSyncTimer=null;if(activeSession===sessionId)void fetchProjectionsNow(sessionId)},PROJECTIONS_SYNC_DEBOUNCE_MS)}
  // Queue row management — the desktop QueueDock's edit / recall / steer,
  // through session.updateQueue. One action in flight at a time; the dock's
  // buttons disable while queueBusy. Success re-pulls the projections so the
  // count and rows reflect the Host's answer, not a guess.
  async function queueAction(itemId,action,failLabel){if(queueBusy||!activeSession||!itemId)return;const owner=activeSession;queueBusy=true;renderQueueDock();try{await rpc('session.updateQueue',{sessionId:owner,itemId,action});if(queueEditing===itemId){queueEditing=null;queueEditText=''}if(activeSession===owner)await fetchProjectionsNow(owner)}catch(e){showToast(failLabel+(e&&e.message?' · '+e.message:''))}finally{queueBusy=false;if(activeSession===owner)renderQueueDock()}}
  function startQueueEdit(itemId){const row=queuedTurn.find(item=>item.id===itemId);if(!row||!row.managed||queueBusy)return;queueEditing=itemId;queueEditText=row.text;renderQueueDock();const box=$('queueDock').querySelector('[data-queue-edit-text]');if(box)box.focus()}
  function cancelQueueEdit(){if(queueBusy)return;queueEditing=null;queueEditText='';renderQueueDock()}
  function saveQueueEdit(){if(queueBusy||queueEditing===null)return;const text=queueEditText.trim();if(!text)return;queueAction(queueEditing,{kind:'edit',content:[{type:'text',text}]},L.queueEditFailed)}
  function todoProgress(){const done=currentTodos.filter(item=>item.status==='completed').length,active=currentTodos.filter(item=>item.status==='in_progress').length,pending=currentTodos.length-done-active;return[(done?done+' '+L.todoDone:''),(active?active+' '+L.todoActive:''),(pending?pending+' '+L.todoPending:'')].filter(Boolean).join(' · ')}
  function todoGlyph(status){if(status==='completed')return'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.2"/><path d="m4 7 2 2 4-4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';if(status==='in_progress')return'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1a6 6 0 1 1-5.2 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';return'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2.4 2.4"/></svg>'}
  // The dock is a sibling of the composer inside the fixed bottom bar, so the
  // transcript has to reserve its real height or the turn status ("深度思考中…")
  // ends up behind it.
  function syncTodoHeight(host){document.body.style.setProperty('--todo-h',host.hidden?'0px':(host.offsetHeight+10)+'px')}
  function syncQueueHeight(host){document.body.style.setProperty('--queue-h',host.hidden?'0px':(host.offsetHeight+10)+'px')}
  // The composer is the band the notice floats above, and that band is not a constant: a
  // growing textarea (or a mounted dock) moves it under the notice's feet. Measure it and
  // publish it as --composer-h, the same variable the transcript clearance and the notice
  // anchor both spend, so the two can never disagree. The docks are deliberately NOT
  // counted: --todo-h/--queue-h/--tunnel-warn-h already reserve them separately, and
  // #composer is a flex column whose height grows upward with each mounted child, so
  // offsetHeight would hand the notice a band that has already been paid for. Only a real
  // change is written, so an idle screen costs nothing.
  function syncComposerHeight(){const host=$('composer');if(!host)return;const inner=host.querySelector('.composer-inner');if(!inner)return;const cs=getComputedStyle(host);const px=inner.offsetHeight+(parseFloat(cs.paddingTop)||0)+(parseFloat(cs.paddingBottom)||0);if(!(px>0)||px===syncComposerHeight._px)return;syncComposerHeight._px=px;document.body.style.setProperty('--composer-h',px+'px')}
  function renderTodoDock(){const host=$('todoDock'),visible=currentTodos.length>0;host.hidden=!visible;document.body.classList.toggle('todo-open',visible);document.body.classList.toggle('todo-expanded',visible&&todoExpanded);if(!visible){host.innerHTML='';syncTodoHeight(host);return}const chevron=todoExpanded?'m3.5 5 3.5 3.5L10.5 5':'m3.5 9 3.5-3.5L10.5 9';host.innerHTML='<button class="todo-header" aria-expanded="'+todoExpanded+'"><span class="todo-lead"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4.75 3h7M4.75 7h7M4.75 11h7M2 3h.01M2 7h.01M2 11h.01" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></span><span class="todo-title">'+L.todoTitle+'</span><span class="todo-progress">'+esc(todoProgress())+'</span><span class="todo-chevron"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="'+chevron+'" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></button>'+(todoExpanded?'<ul class="todo-list">'+currentTodos.map(item=>'<li class="todo-item" data-status="'+esc(item.status)+'"><span class="todo-glyph">'+todoGlyph(item.status)+'</span><span class="todo-content">'+esc(item.content)+'</span></li>').join('')+'</ul>':'');syncTodoHeight(host)}
  function updateTodos(projections){const value=projections?.values?.todos;if(value===null)currentTodos=[];else if(Array.isArray(value))currentTodos=value.filter(item=>item&&typeof item.content==='string'&&['pending','in_progress','completed'].includes(item.status));renderTodoDock()}
  function presetLabel(preset){const builtIn={standard:L.presetStandard,code:L.presetCode,minimal:L.presetMinimal,cordis:L.presetCordis};const name=preset.trust==='system'&&builtIn[preset.id]?builtIn[preset.id]:preset.name||preset.id;return preset.trust==='user'?name+' · '+L.customPreset:name}
  function presetIsLocked(){return!sessionBlank||optimisticPrompts.length>0}
  function closeSessionSettings(){settingsPick='';$('sessionSettings').hidden=true;$('sessionSettings').innerHTML='';$('settings').setAttribute('aria-expanded','false')}
  function normalizeSelection(value){if(!value||typeof value.provider!=='string'||!value.provider||typeof value.model!=='string'||!value.model)return null;const reasoningEffort=typeof value.reasoningEffort==='string'&&value.reasoningEffort?value.reasoningEffort:'';return{provider:value.provider,model:value.model,...(reasoningEffort?{reasoningEffort}:{})}}
  function modelSelectionOf(projections){const selection=projections&&projections.values&&projections.values.modelSelection;return normalizeSelection(selection&&selection.next)}
// SessionSummary carries no agentPreset (host typert.host.js SessionSummary) —
// the value lives only in the session projection map (string|null). Three-state:
// undefined = no projection data seen, null = projected "no preset", string = id.
function agentPresetOf(projections){const v=projections&&projections.values;return v&&typeof v.agentPreset==='string'?v.agentPreset:(v&&v.agentPreset===null?null:undefined)}
  function sameModelSelection(left,right){return!!left&&!!right&&left.provider===right.provider&&left.model===right.model&&(left.reasoningEffort||'')===(right.reasoningEffort||'')}
  function showSessionModel(selection){const next=normalizeSelection(selection);if(!next||settingsBusy||!modelCatalog||sameModelSelection(modelCatalog.current,next))return;modelCatalog.current=next;if(!$('sessionSettings').hidden)renderSessionSettings()}
  function currentSelection(){return modelCatalog?.current??modelCatalog?.default??{}}
  function modelEntryOf(provider,model){const group=(modelCatalog?.groups||[]).find(item=>item.id===provider);return{group,model:(group?.models||[]).find(item=>item.id===model)}}
  function effortsOf(entry){return entry?.model?.reasoning?.efforts||[]}
  function effortValue(entry){const ids=effortsOf(entry).map(item=>item.id),chosen=effortPick||(currentSelection().reasoningEffort||'');return ids.includes(chosen)?chosen:(entry?.model?.reasoning?.defaultEffort||ids[0]||'')}
  // The native select popup is the phone OS's own sheet: no CSS reaches it, and on
  // Android it arrives as a bare white list (live report 2026-10-10, twice: "仍然很丑,
  // 好像没改"). The fields are therefore a styled button plus an in-page list, so the
  // group headings, the row type and the current choice all belong to this page.
  function settingsHead(){return'<div class="settings-head"><strong>'+L.sessionSettings+'</strong><button class="settings-close" data-settings-close aria-label="'+L.close+'">×</button></div>'}
  function pickRows(field){const current=currentSelection();if(field==='model')return (modelCatalog.groups||[]).map(group=>'<span class="setting-group">'+esc(fieldText(group.name,group.id))+'</span>'+(group.models||[]).map(model=>'<button type="button" class="setting-opt'+(group.id===current.provider&&model.id===current.model?' is-on':'')+'" data-value="'+esc(group.id+'\u001f'+model.id)+'">'+esc(fieldText(model.name,model.id))+'</button>').join('')).join('');if(field==='effort'){const chosen=effortValue(modelEntryOf(current.provider,current.model));return effortsOf(modelEntryOf(current.provider,current.model)).map(item=>'<button type="button" class="setting-opt'+(item.id===chosen?' is-on':'')+'" data-value="'+esc(item.id)+'">'+esc(fieldText(item.name,item.id))+'</button>').join('')}const chosenPreset=presets.find(item=>item.id===currentPreset)||presets.find(item=>item.isDefault)||presets[0];return presets.map(item=>'<button type="button" class="setting-opt'+(item===chosenPreset?' is-on':'')+'" data-value="'+esc(item.id)+'">'+esc(presetLabel(item))+'</button>').join('')}
  // All three lists ship in the DOM, hidden until their field opens. The first cut
  // rebuilt the whole panel on every tap (settingsPick → renderSessionSettings), and that
  // rebuild is what made 模型 vanish the moment it was tapped (live report 2026-10-10:
  // 「模型一点就消失了」) — the list itself was fine, the re-render was not. A tap must never
  // touch markup that is already on screen and working.
  function settingFieldHtml(field,label,current){return'<div class="setting-field"><span>'+label+'</span><button type="button" class="setting-pick" data-pick="'+field+'" aria-expanded="false"><span>'+esc(current||'—')+'</span><i aria-hidden="true"></i></button><div class="setting-list" data-field="'+field+'" hidden>'+pickRows(field)+'</div></div>'}
  function togglePickField(field){settingsPick=settingsPick===field?'':field;for(const node of $('sessionSettings').querySelectorAll('[data-pick],[data-field]')){if(node.dataset.field===undefined)node.setAttribute('aria-expanded',node.dataset.pick===field);else node.hidden=node.dataset.field!==field}}
  function applyPick(field,value){const picked=settingsPick;settingsPick='';if(!value||!picked)return;if(picked==='preset'){void selectPreset(value);return}const current=currentSelection();if(picked==='model')void selectModel(modelEntryOf.apply(null,value.split('\u001f')));else void selectModel(modelEntryOf(current.provider,current.model),value)}
  function syncSettingsControls(){const note=$('presetNote');if(note)note.textContent=presetIsLocked()?L.presetLocked:L.presetEditable;const routable=(modelCatalog?.routableProviders?.length??0)>0||modelCatalog?.routable===true;for(const node of $('sessionSettings').querySelectorAll('[data-pick]'))node.disabled=settingsBusy||!routable||(node.dataset.pick==='preset'&&presetIsLocked())}
  // Catalogue labels arrive from the Host verbatim, and a padded or doubled-space
  // name reads as a gap inside the field (live report 2026-10-10: "字体还空了两格").
  // One collapse+trim pass, with the id as the fallback so a blank name never
  // renders an empty row. The regex is written with a doubled backslash because it
  // ships inside a template literal — a single one arrives as the letter s (and
  // \s already covers the full-width space U+3000).
  function fieldText(value,fallback){const clean=String(value??'').replace(/\\s+/g,' ').trim();return clean||String(fallback??'')}
  function renderSessionSettings(){const host=$('sessionSettings');if(!modelCatalog){host.innerHTML=settingsHead()+'<div class="settings-loading">'+L.settingsLoading+'</div>';return}const current=currentSelection(),entry=modelEntryOf(current.provider,current.model),preset=presets.find(item=>item.id===currentPreset)||presets.find(item=>item.isDefault)||presets[0];host.innerHTML=settingsHead()+settingFieldHtml('model',L.model,fieldText(entry.model?.name,current.model))+((effortsOf(entry).length)?settingFieldHtml('effort',L.reasoningEffort,fieldText(effortsOf(entry).find(item=>item.id===effortValue(entry))?.name,'')):'')+settingFieldHtml('preset',L.preset,preset?presetLabel(preset):'')+'<div id="presetNote" class="setting-note"></div><div id="settingsError" class="settings-error" role="status" aria-live="polite">'+(!modelCatalog.groups?.length?L.noModels:'')+'</div>';syncSettingsControls()}
  function visibleSessions(items){return (Array.isArray(items)?items:[]).filter(item=>item&&item.origin!=='subagent')}
  // A subagent session is another session's tool, never something this phone
  // opens on its own. The list projection above cannot cover the boot focus:
  // it travels outside the list and carries no origin, so it is joined back to
  // the raw row here; only an explicit subagent row blocks, never a missing one.
  function openableFocus(candidate,items){
    if(!candidate||typeof candidate.sessionId!=='string'||!candidate.sessionId)return null;
    const rows=Array.isArray(items)?items:[];
    const row=rows.find(item=>item&&item.sessionId===candidate.sessionId);
    return row&&row.origin==='subagent'?null:candidate
  }
  async function refreshActiveSessionSummary(){if(!activeSession)return;const value=await rpc('session.list',{}),summary=(value.items||[]).find(item=>item.sessionId===activeSession);if(summary){sessionBlank=summary.blank;currentPreset=agentPresetOf(summary.projections)||currentPreset;sessionSummaries=visibleSessions(value.items)}syncSettingsControls()}
  async function openSessionSettings(){if(!$('sessionSettings').hidden){closeSessionSettings();return}const sessionId=activeSession;if(!sessionId)return;$('sessionSettings').hidden=false;$('settings').setAttribute('aria-expanded','true');settingsPick='';effortPick='';modelCatalog=null;renderSessionSettings();try{const [models,presetValue]=await Promise.all([rpc('session.models',{sessionId}),rpc('agentPreset.list',{})]);if(activeSession!==sessionId)return;modelCatalog=models;presets=(presetValue.presets||[]).filter(preset=>!preset.broken);const summary=sessionSummaries.find(item=>item.sessionId===sessionId);if(summary){sessionBlank=summary.blank;currentPreset=agentPresetOf(summary.projections)||currentPreset}const selected=modelSelectionOf(summary&&summary.projections)||modelSelectionOf(streamProjections);if(selected)modelCatalog.current=selected;renderSessionSettings()}catch(e){if(activeSession!==sessionId)return;modelCatalog={default:{provider:'',model:''},routableProviders:[],groups:[],failures:[]};renderSessionSettings();showError('settingsError',e)}}
  async function selectPreset(next){if(settingsBusy||presetIsLocked()||!activeSession)return;const previous=currentPreset;if(!next||next===previous)return;settingsBusy=true;syncSettingsControls();try{const value=await rpc('agentPreset.select',{sessionId:activeSession,agentPreset:next});currentPreset=typeof value==='string'?value:currentPreset;renderSessionSettings();showToast(L.settingsUpdated)}catch(e){showError('settingsError',e);await refreshActiveSessionSummary().catch(()=>{})}finally{settingsBusy=false;syncSettingsControls()}}
  async function selectModel(entry,effortOverride){if(settingsBusy||!activeSession)return;const provider=entry?.group?.id,model=entry?.model?.id;if(!provider||!model)return;settingsBusy=true;syncSettingsControls();const reasoningEffort=effortOverride||effortValue(entry);try{const value=await rpc('session.selectModel',{sessionId:activeSession,provider,model,...(reasoningEffort?{reasoningEffort}:{})});const selected=normalizeSelection(value&&value.selected)||normalizeSelection({provider,model,...(reasoningEffort?{reasoningEffort}:{})});if(selected)modelCatalog.current=selected;effortPick='';renderSessionSettings();showToast(L.settingsUpdated)}catch(e){showError('settingsError',e);syncSettingsControls()}finally{settingsBusy=false;syncSettingsControls()}}
  function durableUserPromptText(message){const block=(message.blocks||[]).find(item=>item&&item.kind==='text');return block?String(block.text||''):''}
  // A locally echoed prompt is placed where it belongs in seq order instead of
  // being appended below an answer that is already streaming, and it is retired
  // as soon as the durable copy of that send lands. The old text tally retired on
  // a count comparison, which broke on a repeated prompt ("继续"): once its earlier
  // copy had scrolled out of the history page the count stayed low, the echo was
  // never retired, and it stayed pinned underneath its own answer.
  // Retirement is deliberately narrow now: a durable copy replaces the echo only
  // when it is the ONLY candidate, and only when the send knew where in this
  // session's own log it sat (a watermark of seq >= 0). From an empty buffer the
  // watermark is -1, which makes every earlier turn look like a candidate — so a
  // prompt repeated from history ("继续") used to erase the echo that had just been
  // sent, and once erased it never came back. The -1 case still retires, but only
  // when the transcript held none of that text at send time: the first message of a
  // conversation nobody has typed into yet, and nothing else. The watermark the
  // candidate test runs against is not frozen at send time either: every paint
  // moves it up to the newest copy of that text the phone has actually seen, so a
  // kept echo still retires the moment something strictly newer arrives (two quick
  // sends of the same prompt, or the reveal above followed by its own copy). The
  // gate below reads the pre-paint value, never the advanced one.
  function messagesWithOptimistic(durable){lastDurableMessages=durable;optimisticPrompts=optimisticPrompts.filter(item=>{const floor=item.afterSeq;let matches=0,newest=floor;for(const message of durable){if(message.role!=='user'||durableUserPromptText(message)!==item.text)continue;const seq=message._seq??-1;if(seq>floor)matches+=1;if(seq>newest)newest=seq}item.afterSeq=newest;return!(matches===1&&(floor>=0||item.sameTextAtSend===0))});if(!optimisticPrompts.length)return durable.slice();const out=durable.slice();for(const item of optimisticPrompts){let index=out.findIndex(message=>(message._seq??-1)>item.afterSeq);if(index<0)index=out.length;out.splice(index,0,{role:'user',blocks:[{kind:'text',text:item.text},...(item.summary?[{kind:'text',text:item.summary}]:[])],optimistic:true})}return out}
  function latestEventSeq(){let max=-1;for(const entry of windowEvents()){const s=eventSeq(entry);if(s>max)max=s}return max}
  // Paint from the live buffer so a send can only ever add to what is on screen.
  // The old code repainted from lastDurableMessages, a snapshot taken by the
  // previous history merge, which is what made earlier messages vanish.
  function currentTranscript(){const live=visibleMessages(windowEvents());return live.length?live:lastDurableMessages}
  // Three honest states, never two names for one: more to ask (the host says so,
  // or nothing is painted yet and no page has been refused) -> olderMore; a real
  // page came back with nothing older while the transcript is still empty ->
  // olderExhausted; the same refusal over a painted transcript means the reader is
  // at the first message -> olderStart.
  function olderButtonHtml(){if(!activeSession)return'';if(!olderHasMore&&!olderEvents.length&&transcriptHasContent())return'';const busy=olderBusy||olderRunBusy,canAsk=olderHasMore||(!transcriptHasContent()&&!olderExhausted),label=busy?L.olderLoading:canAsk?L.olderMore:transcriptHasContent()?L.olderStart:L.olderExhausted;return'<button class="older-row'+(busy?' busy':'')+'" data-older="1"'+(busy||!canAsk?' disabled':'')+'><span class="older-spin" aria-hidden="true"></span>'+esc(label)+'</button>'}
  function statusLineHtml(){return '<div class="turn-status" role="status" aria-live="polite">'+(stopPending?L.stopping:L.deepDiving)+'</div>'}
  function paintMessages(messages,stickToBottom=false){const box=$('messages'),status=agentRunning&&!pendingQuestion?statusLineHtml():'';if(typeof markHistoryTail==='function')markHistoryTail(messages);box.innerHTML=olderButtonHtml()+(messages.length?messages.map(renderMessage).join(''):transcriptWaitHtml(box))+status;if(typeof bindOpenState==='function')bindOpenState(box);if(stickToBottom){if(typeof followStream!=='undefined')followStream=true;box.scrollTop=box.scrollHeight}else if(typeof followStream==='undefined'?box.scrollHeight-box.scrollTop-box.clientHeight<90:followStream){box.scrollTop=box.scrollHeight}if(typeof syncScrollAnchors==='function')syncScrollAnchors()}
  function renderOlderButton(){const box=$('messages'),current=box.querySelector(':scope > .older-row'),html=olderButtonHtml();if(!html){if(current)current.remove();return}if(current){if(current.outerHTML!==html)current.outerHTML=html;return}box.insertAdjacentHTML('afterbegin',html)}
  let fillBusy=false,olderRunBusy=false;
  // The transcript is paged by records, not by screenfuls: 30 records is often
  // less than a single turn, and "show the last N messages" only moves the
  // goalpost (3 is short, so 5, so 10…). Keep pulling older pages until the
  // transcript really does fill the viewport, the conversation starts, or the
  // budget runs out. It only ever runs while the content is shorter than the
  // viewport, so it cannot disturb someone already reading further up.
  async function ensureTranscriptFilled(){if(fillBusy||!activeSession)return;const box=$('messages');if(box.scrollHeight>box.clientHeight+8)return;if(!olderHasMore&&transcriptHasContent())return;fillBusy=true;let pages=0;const deadline=Date.now()+6000;const count=()=>$('messages').querySelectorAll(':scope > .message').length;try{while(activeSession&&(olderHasMore||!transcriptHasContent())&&pages<8&&Date.now()<deadline){const current=$('messages');if(current.scrollHeight>current.clientHeight+8)break;const before=count();pages+=1;if(!await fetchOlderPage())break;
    // A host that keeps claiming hasMore while returning nothing new must not
    // become a polling treadmill: if a page added no messages, stop asking.
    if(count()<=before)break}}finally{fillBusy=false}}
  function oldestEventSeq(){let best=-1;const events=windowEvents();for(let i=0;i<events.length;i+=1){const seq=eventSeq(events[i]);if(seq>=0&&(best<0||seq<best))best=seq}return best}
  function olderUserCount(){return visibleMessages(windowEvents()).filter(message=>message.role==='user').length}
  async function fetchOlderPage(){if(olderBusy||!activeSession||(!olderHasMore&&transcriptHasContent()))return false;const box=$('messages'),sessionId=activeSession,anchorSeq=oldestEventSeq();try{olderBusy=true;renderOlderButton();const prevHeight=box.scrollHeight,prevTop=box.scrollTop;// No anchor at all means nothing of this session has been painted, not that there
// is nothing older: pull the newest page from the head instead of giving up.
const value=anchorSeq<0?await rpc('session.history',{sessionId,maxMessages:30}):await rpc('session.history',{sessionId,beforeSeq:anchorSeq,maxMessages:30});if(activeSession!==sessionId)return false;const records=Array.isArray(value.events)?value.events:[];olderEvents=mergeEntries(records.concat(olderEvents));olderHasMore=value.hasMore===true;if(!olderHasMore)olderExhausted=true;const durable=visibleMessages(windowEvents()),messages=messagesWithOptimistic(durable);paintMessages(messages,false);box.scrollTop=prevTop+(box.scrollHeight-prevHeight);return true}catch(e){showError('chatError',e);return false}finally{olderBusy=false;try{renderOlderButton()}catch(e){showError('chatError',e)}}}
  // One page is 30 raw records, which can be less than a single assistant bubble,
  // so a single-page fetch often adds nothing visible and the tap looks ignored.
  // A tap therefore keeps pulling pages until an earlier user message shows up.
  async function loadOlder(){if(olderRunBusy||!activeSession||(!olderHasMore&&transcriptHasContent()))return false;const before=olderUserCount(),beforeRecords=windowEvents().length,deadline=Date.now()+8000;let pages=0;try{
// The lock is taken inside the try on purpose: refreshing the row reads the live
  // DOM, and a throw there used to leave olderRunBusy pinned true — which disabled
  // the row and every later pull for the rest of the visit.
  olderRunBusy=true;renderOlderButton();while(activeSession&&(olderHasMore||!transcriptHasContent())&&pages<8&&Date.now()<deadline){if(!await fetchOlderPage())break;pages+=1;
  // A page that added no records at all is the start of the conversation, not a page
  // to retry: without this the exhausted case billed up to eight requests per tap.
  if(windowEvents().length===beforeRecords)break;if(olderUserCount()>before)break}}
  finally{// Release first, then refresh the row: the row is cosmetic, the lock is not.
  olderRunBusy=false;void ensureTranscriptFilled();try{renderOlderButton()}catch(e){showError('chatError',e)}}return pages>0}
  function syncTurnStatus(){const box=$('messages'),current=box.querySelector('.turn-status'),visible=agentRunning&&!pendingQuestion,label=stopPending?L.stopping:L.deepDiving;if(visible&&!current)box.insertAdjacentHTML('beforeend',statusLineHtml());else if(!visible&&current)current.remove();else if(visible&&current&&current.textContent!==label)current.textContent=label}
  function patchLastStreamMessage(messages){const box=$('messages'),nodes=box.querySelectorAll(':scope > .message'),index=messages.length-1,message=messages[index];if(!message||message.role!=='assistant'||index!==nodes.length-1){paintMessages(messages,false);return}nodes[index].outerHTML=renderMessage(message);bindOpenState(box);syncTurnStatus();if(typeof followStream==='undefined'||followStream)box.scrollTop=box.scrollHeight;if(typeof syncScrollAnchors==='function')syncScrollAnchors()}
  function recommendation(label){const match=String(label||'').match(/\\s*\\((Recommended|推荐)\\)\\s*$/i);return{label:match?String(label).slice(0,match.index).trim():String(label||''),recommended:!!match}}
  function questionDraft(question){return questionDrafts[question.id]||(questionDrafts[question.id]={selected:[],custom:'',skipped:false})}
  function renderQuestionComposer(){const host=$('questionComposer'),composer=$('composer');if(!pendingQuestion||!pendingQuestion.questions?.length){host.hidden=true;composer.hidden=false;document.body.classList.remove('question-open');host.innerHTML='';return}questionIndex=Math.max(0,Math.min(questionIndex,pendingQuestion.questions.length-1));const question=pendingQuestion.questions[questionIndex],draft=questionDraft(question),options=question.options||[],last=questionIndex===pendingQuestion.questions.length-1;host.hidden=false;composer.hidden=true;document.body.classList.add('question-open');host.innerHTML='<div class="question-shell"><div class="question-top"><span class="question-mark">'+activityIcon('tool')+'</span><div class="question-context"><strong>'+esc(question.header||L.questionNeeded)+'</strong><span>'+(questionIndex+1)+' / '+pendingQuestion.questions.length+' '+L.questionProgress+'</span></div><button class="question-close" data-question-action="cancel" aria-label="'+esc(L.cancelQuestions)+'">×</button></div><div class="question-body"><h2 class="question-title">'+esc(question.question)+'</h2>'+(question.detail?'<div class="question-detail markdown">'+markdown(question.detail)+'</div>':'')+(options.length?'<div class="question-options'+(question.multiSelect?' multi':'')+'">'+options.map((option,index)=>{const display=recommendation(option.label),selected=draft.selected.includes(option.label);return'<button class="question-option'+(selected?' selected':'')+'" data-option-index="'+index+'"><span class="option-control">'+(selected?'✓':'')+'</span><span class="option-copy"><span class="option-label">'+esc(display.label)+(display.recommended?'<span class="recommendation">'+L.recommended+'</span>':'')+'</span>'+(option.description?'<span class="option-description">'+esc(option.description)+'</span>':'')+'</span></button>'}).join('')+'</div>':'')+'<label class="custom-label" for="questionCustom">'+L.customAnswer+'</label><textarea id="questionCustom" class="question-custom" placeholder="'+esc(L.customPlaceholder)+'">'+esc(draft.custom)+'</textarea></div><div id="questionError" class="question-error"></div><div class="question-actions">'+(questionIndex?'<button data-question-action="previous">'+L.previous+'</button>':'<button data-question-action="cancel">'+L.cancelQuestions+'</button>')+'<span class="spacer"></span><button data-question-action="skip">'+L.skip+'</button><button class="submit-answer" data-question-action="continue">'+(questionBusy?L.answering:last?L.submitAnswer:L.next)+'</button></div></div>';host.querySelectorAll('button').forEach(button=>button.disabled=questionBusy)}
  function syncPendingQuestion(next){const changed=(pendingQuestion?.rpcId||null)!==(next?.rpcId||null);pendingQuestion=next;if(changed){questionIndex=0;questionDrafts={};questionBusy=false;renderQuestionComposer()}}
  function advanceQuestion(skip=false){if(!pendingQuestion||questionBusy)return;const question=pendingQuestion.questions[questionIndex],draft=questionDraft(question);draft.custom=String($('questionCustom')?.value||'').trim();if(skip){draft.selected=[];draft.custom='';draft.skipped=true}else{draft.skipped=false;if(!draft.selected.length&&!draft.custom){$('questionError').textContent=question.multiSelect?L.chooseAnswerMulti:L.chooseAnswer;return}}if(questionIndex<pendingQuestion.questions.length-1){questionIndex+=1;renderQuestionComposer()}else submitQuestionAnswers()}
  async function submitQuestionAnswers(){if(!pendingQuestion||questionBusy)return;questionBusy=true;renderQuestionComposer();const current=pendingQuestion;const answers=current.questions.map(question=>{const draft=questionDraft(question);return{id:question.id,selected:!question.multiSelect&&draft.custom?[]:draft.selected,...(draft.custom?{custom:draft.custom}:{})}});try{await rpc('interaction.answer',{rpcId:current.rpcId,sessionId:current.sessionId,answers});lastHistoryKey='';await loadHistory(false)}catch(e){showError('questionError',e)}finally{questionBusy=false;renderQuestionComposer()}}
  async function cancelQuestionRequest(){if(!pendingQuestion||questionBusy)return;questionBusy=true;renderQuestionComposer();const current=pendingQuestion;try{await rpc('interaction.cancel',{rpcId:current.rpcId,sessionId:current.sessionId});lastHistoryKey='';await loadHistory(false)}catch(e){showError('questionError',e)}finally{questionBusy=false;renderQuestionComposer()}}
async function loadListData(){const [wsValue,sessValue,settingsValue]=await Promise.all([rpc('workspace.list'),rpc('session.list',{}),rpc('settings.describe',{}).catch(()=>null)]);applyBootData({ws:wsValue,sess:sessValue,settings:settingsValue?extractMobileSettings(settingsValue):null})}
function applyBootData(b){const ws=b.ws||{},sessInput=b.sess||{};const serverItems=ws.items||[],archivedIds=ws.archivedSessionIds||[];workspaces=serverItems.map(w=>({...w,sessionIds:[...(Array.isArray(w.sessionIds)?w.sessionIds:[])]}));pendingCreatedSessions=${applyPendingCreatedSessions.name}(workspaces,pendingCreatedSessions,serverItems,archivedIds);archivedSessionIds=archivedIds;sessionSummaries=visibleSessions(sessInput.items);bootListPartial=sessInput.partial===true;if(b.settings){busyEnter=b.settings.busyEnter==='steer'?'steer':'queue';transcriptView=['compact','standard','detailed','verbose'].includes(b.settings.transcriptView)?b.settings.transcriptView:'standard';performanceUsage=b.settings.performanceUsage==='compact'?'compact':'detailed'}if(!expandedInitDone){expandedInitDone=true;if(workspaces.length)expandedWsIds.add(workspaces[0].workspaceId)}}
function taskGlyph(state){if(state==='running')return'<svg class="spin" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 2a7 7 0 1 1-6.06 3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';if(state==='unknown')return'<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7.2" fill="currentColor" opacity=".38"/><text x="9" y="12.4" text-anchor="middle" font-size="9.5" font-family="system-ui,sans-serif" font-weight="600" fill="#fff">?</text></svg>';if(state==='error')return'<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7.2" fill="currentColor"/><path d="M9 5v4.4" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="9" cy="12.1" r=".95" fill="#fff"/></svg>';if(state==='awaiting')return'<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7.2" fill="currentColor"/><path d="M6.6 6.9c.2-1 1.2-1.7 2.4-1.7 1.4 0 2.5.8 2.5 2 0 1-.7 1.5-1.7 2-.9.4-1.2.8-1.2 1.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><circle cx="9.1" cy="12.8" r=".9" fill="#fff"/></svg>';if(state==='blank')return'<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.5 2.5"/></svg>';return'<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7.2" fill="currentColor"/><path d="m5.7 9.2 2.2 2.2 4.4-4.7" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
function taskState(s){if(s.awaitingQuestion)return'awaiting';if(s.error||s.lastError||s.status==='error')return'error';if(s.running||s.descendantRunning)return'running';if(s.blank)return'blank';return'done'}
// A blank row is only a ghost when this page synthesized it (missingSummary:true).
// A session created on this phone is blank:true too (createSessionIn) — filtering
// every blank row made the new chat invisible until the server projected a summary.
// But a real blank row also goes stale: the desktop's abandoned new-chat shells
// surfaced as one unnamed row per workspace, so blankRowVisible hides a blank
// older than BLANK_ROW_VISIBLE_MS (non-blank rows never reach that rule).
// ---- Session unread dot (2026-10-07-feat-pocket-smart-scroll-anchors).
// A row is unread when its last activity postdates the last time THIS phone opened
// that session. The opened-at ledger lives in localStorage (session ids and
// timestamps only, never logged), is written on open AND on leave (activity seen
// live in the chat must not read as unread on the way back to the list), and is
// capped so a long-lived install cannot grow the ledger unbounded. Running,
// blank and currently-focused sessions never show the dot.
const UNREAD_OPEN_KEY='dsh-pocket-opened-at',UNREAD_OPEN_MAX=200;
function readOpenedMap(){try{const raw=localStorage.getItem(UNREAD_OPEN_KEY);if(!raw)return{};const parsed=JSON.parse(raw);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return{};const out={};for(const key of Object.keys(parsed)){const value=parsed[key];if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)out[key]=value}return out}catch{return{}}}
function pruneOpenedMap(map){const keys=Object.keys(map);if(keys.length<=UNREAD_OPEN_MAX)return map;const kept=keys.sort((a,b)=>map[b]-map[a]).slice(0,UNREAD_OPEN_MAX),out={};for(const key of kept)out[key]=map[key];return out}
function noteSessionOpened(sessionId){if(!sessionId||typeof sessionId!=='string')return;try{const map=readOpenedMap();map[sessionId]=Date.now();localStorage.setItem(UNREAD_OPEN_KEY,JSON.stringify(pruneOpenedMap(map)))}catch{}}
function isSessionUnread(summary,lastOpenedAt,activeId){if(!summary||summary.running||summary.blank)return false;if(summary.sessionId&&summary.sessionId===activeId)return false;const opened=typeof lastOpenedAt==='number'&&Number.isFinite(lastOpenedAt)&&lastOpenedAt>0?lastOpenedAt:0;if(!opened)return false;return (typeof summary.updatedAt==='number'?summary.updatedAt:0)>opened}
function renderWorkspaces(){const host=$('workspaces');if(!workspaces.length){host.innerHTML='<div class="ws-empty">'+esc(L.noWorkspaces)+'</div>';return}const openedAt=typeof readOpenedMap==='function'?readOpenedMap():{};host.innerHTML=workspaces.map(w=>{const byId=new Map(sessionSummaries.map(s=>[s.sessionId,s]));const tasks=(w.sessionIds||[]).map(id=>byId.get(id)||{sessionId:id,updatedAt:0,blank:true,missingSummary:true}).filter(s=>!s.blank||s.missingSummary!==true&&blankRowVisible(s,Date.now(),BLANK_ROW_VISIBLE_MS)).sort((a,b)=>b.updatedAt-a.updatedAt);const latest=tasks[0]?taskState(tasks[0]):null;const expanded=expandedWsIds.has(w.workspaceId);return'<article class="ws-card'+(expanded?' expanded':'')+'" data-ws="'+esc(w.workspaceId)+'"><div class="ws-head"><button class="ws-toggle" data-action="toggle" aria-expanded="'+expanded+'"><span class="ws-chevron"><svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="m5 3 4.5 4L5 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="ws-name">'+esc(w.title||w.path)+'</span>'+(latest?'<span class="ws-last is-'+latest+'">'+taskGlyph(latest)+'</span><span class="ws-last-time">'+esc(timeFor(tasks[0]))+'</span>':'')+'</button><button class="ws-new" data-action="new" aria-label="'+esc(L.newChat)+'"><svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div><div class="ws-body"><div class="task-list">'+(tasks.length?tasks.map(s=>{const state=taskState(s),unread=typeof isSessionUnread==='function'&&isSessionUnread(s,openedAt[s.sessionId]||0,activeSession);return'<button class="task-row is-'+state+(unread?' is-unread':'')+'" data-action="open" data-id="'+esc(s.sessionId)+'"'+(s.provisional?' title="'+esc(L.newChat)+'" aria-label="'+esc(L.newChat)+'"':'')+'><span class="task-status">'+taskGlyph(state)+'</span><span class="task-copy"><strong>'+esc(titleFor(s))+'</strong><time>'+esc(timeFor(s))+'</time></span></button>'}).join(''):'<div class="ws-empty">'+esc(L.noTasksHint)+'</div>')+'</div></div></article>'}).join('')}
function relativeTime(value){const parsed=typeof value==='number'?value:Date.parse(value),elapsed=Math.max(0,Date.now()-(Number.isFinite(parsed)?parsed:Date.now())),minutes=Math.floor(elapsed/60000);if(minutes<1)return L.justNow;if(minutes<60)return minutes+L.minute;const hours=Math.floor(minutes/60);if(hours<24)return hours+L.hour;return Math.floor(hours/24)+L.day}function timeFor(s){if(!s)return'';if(s.missingSummary)return'';return s.running?L.justNow:relativeTime(s.updatedAt)}
// #4c optimistic creation: the tap paints a pending row immediately (running
// spin, provisional:true), the RPC replaces it in place on success and the row
// is rolled back on failure. A failure after the RPC has landed must NOT roll
// the real row back, so the catch below only reverts while created is still null.
async function createSessionIn(workspaceId){const workspace=workspaces.find(w=>w.workspaceId===workspaceId);if(!workspace)return;const localId='pending:'+Date.now();workspace.sessionIds=spliceProvisionalSession(workspace.sessionIds,localId);sessionSummaries.push({sessionId:localId,updatedAt:Date.now(),blank:true,running:true,provisional:true});expandedWsIds.add(workspaceId);renderWorkspaces();let created=null;try{created=await rpc('session.create',{workspaceId})}catch(e){workspace.sessionIds=(workspace.sessionIds||[]).filter(id=>id!==localId);sessionSummaries=sessionSummaries.filter(s=>s.sessionId!==localId);renderWorkspaces();showError('listError',e);return}
workspace.sessionIds=reconcileProvisionalSession(workspace.sessionIds,localId,created.sessionId);if(!pendingCreatedSessions.some(item=>item.workspaceId===workspaceId&&item.sessionId===created.sessionId))pendingCreatedSessions.push({workspaceId,sessionId:created.sessionId});const provisionalIndex=sessionSummaries.findIndex(s=>s.sessionId===localId);if(created.origin!=='subagent'){const summary={sessionId:created.sessionId,updatedAt:Date.now(),blank:true,running:false,awaitingQuestion:false,agentPreset:created.agentPreset};if(provisionalIndex>=0)sessionSummaries[provisionalIndex]=summary;else sessionSummaries.push(summary)}else if(provisionalIndex>=0)sessionSummaries.splice(provisionalIndex,1);renderWorkspaces();openSession(created.sessionId).catch((e)=>showError('listError',e))}
async function refreshList(showFeedback=false){try{await loadListData();renderWorkspaces();$('listError').textContent='';bootListPartial=false;if(showFeedback)showToast(L.refreshed)}catch(e){if(bootListPartial)showError('listError',{message:L.bootListPartial});else showError('listError',e)}}
let hiddenAt=0,resumeInFlight=false;
const RESUME_AUTO_JUMP_MS=120000;
// A session that was sent to the background while its stream was half-dead comes back to
// a page that keeps reporting the outage it never disproved: a phone page suspended by
// the OS does not fire the transport error that would have re-opened the stream, and the
// stale watchdog deliberately freezes its clock while hidden. Re-arming here gives the
// returning reader a live stream instead of a notice nobody can answer. A stream that is
// still delivering frames is left exactly as it was.
function reopenSessionStream(){if(!activeSession)return;if(streamConnected&&Date.now()-lastStreamFrameAt<=STREAM_STALE_MS)return;closeSessionStream();openSessionStream(activeSession)}
function pickFocusSession(){const list=sessionSummaries.filter(s=>!s.missingSummary&&!s.blank);if(!list.length)return null;if(list.length===1)return list[0];const awaiting=list.filter(s=>s.awaitingQuestion);if(awaiting.length){awaiting.sort((a,b)=>b.updatedAt-a.updatedAt);return awaiting[0]}const running=list.filter(s=>s.running);if(running.length){running.sort((a,b)=>b.updatedAt-a.updatedAt);return running[0]}return[...list].sort((a,b)=>b.updatedAt-a.updatedAt)[0]}
// The resume auto-jump must PUSH its chat entry, not rewrite the current one.
// While the list was showing, the current entry is the synthetic {view:'sessions'}
// anchor from init (line ~1694) — replacing it deleted the last in-app entry, so
// both the back button (history.length>1 counted the pre-app entry) and the
// browser edge swipe left the app instead of returning to the list, and only a
// manual reload rebuilt the anchor. handleHistory already collapses a stale chat
// entry found under a live chat, so the extra entry can never resurrect the old
// "back reopens the same chat" bug (live report 2026-10-09).
async function resumeOnReturn(hiddenForMs){if(resumeInFlight||activeSession)return;resumeInFlight=true;try{try{await loadListData()}catch(e){showError('listError',e);return}renderWorkspaces();$('listError').textContent='';if(hiddenForMs<RESUME_AUTO_JUMP_MS)return;const target=pickFocusSession();if(target)await openSession(target.sessionId,titleFor(target),false,true)}finally{resumeInFlight=false}}
function showToast(message,ms){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(showToast.timer);const dwell=typeof ms==='number'?ms:1000;showToast.timer=setTimeout(()=>$('toast').classList.remove('show'),dwell)}
function titleFor(s){const p=s.projections&&s.projections.values||{};return p.title||p.sessionTitle||p['session.title']||L.untitled}
function extractMobileSettings(d){const namespaces=Array.isArray(d?.namespaces)?d.namespaces:[],byNs=new Map(namespaces.map(ns=>[String(ns.ns),ns.value||{}])),conversation=byNs.get('ui-conversation')||{},chat=byNs.get('ui-chat')||{};return{busyEnter:conversation.busyEnter==='steer'?'steer':'queue',transcriptView:['compact','standard','detailed','verbose'].includes(chat.transcriptView)?chat.transcriptView:'standard',performanceUsage:chat.performanceUsage==='compact'?'compact':'detailed'}}
  function applyInheritedSettings(s){if(!s)return false;const next={busyEnter:s.busyEnter==='steer'?'steer':'queue',transcriptView:['compact','standard','detailed','verbose'].includes(s.transcriptView)?s.transcriptView:'standard',performanceUsage:s.performanceUsage==='compact'?'compact':'detailed'},changed=next.busyEnter!==busyEnter||next.transcriptView!==transcriptView||next.performanceUsage!==performanceUsage;if(!changed)return false;busyEnter=next.busyEnter;transcriptView=next.transcriptView;performanceUsage=next.performanceUsage;syncSettingsControls();if(activeSession&&lastDurableMessages.length)paintMessages(messagesWithOptimistic(lastDurableMessages),false);return true}
  function resetOptimisticMessages(){lastDurableMessages=[];optimisticPrompts=[];clearAwaitingTurn();turnRunningSeq=-1;turnRunningOpen=false;agentRunning=false;currentTodos=[];todoExpanded=false;renderTodoDock();currentGoal=null;queuedTurn=[];queueBusy=false;queueEditing=null;queueEditText='';goalBusy=false;goalEditing=false;goalEditText='';stopPending=false;renderGoalBar();renderQueueDock()}
  // The handoff snapshot is the only copy of the window the pairing payload covered, so
  // it is dropped only once the session it describes is the one being left — otherwise
  // the stale object lives on and repaints a conversation from a page that is older than
  // what the phone already holds. Releasing it any earlier (this ran unconditionally at
  // first) throws that window away before paintInstantSession ever sees it, and the
  // bridge has been told by the watermark not to send those records again.
  function closeSessionStream(){if(sessionStream)sessionStream.close();if(streamRenderFrame!==null)cancelAnimationFrame(streamRenderFrame);if(pendingSyncTimer!==null)clearTimeout(pendingSyncTimer);if(projectionsSyncTimer!==null)clearTimeout(projectionsSyncTimer);projectionsSyncTimer=null;clearSkeletonWatchdog();clearStreamStaleWatch();if(typeof stopEventPolling==='function')stopEventPolling();sessionStream=null;tokenStream=null;streamConnected=false;streamEvents=[];olderEvents=[];olderHasMore=false;olderBusy=false;olderExhausted=false;streamProjections=null;streamRenderFrame=null;streamNeedsFullPaint=false;streamRevision=0;if(typeof turnOpenState!=='undefined')turnOpenState.clear();turnRunningSeq=-1;turnRunningOpen=false;pendingSyncTimer=null;if(activeSession)streamWatermarks.delete(activeSession);if(activeSession&&embeddedFocus&&embeddedFocus.sessionId===activeSession)embeddedFocus=null}
  function applyHistory(value,pending,initial){if(pending!==undefined)syncPendingQuestion(pending);if(streamConnected&&transcriptHasContent()){olderHasMore=olderExhausted?false:olderHasMore||value.hasMore===true}else{
    // Never let an empty page erase a conversation that is already on screen.
    // 2026-10-01: this fallback runs when the live stream has not delivered its
    // first snapshot within ~900ms; it used to assign the fetched events
    // unconditionally, so an empty history page blanked the chat the handoff had
    // just painted. The stream (and the next poll) still own the truth.
    const fetched=Array.isArray(value.events)?value.events:[];
    // Append-only. One history page carries the last 30 *records*, which is often
    // less than a single turn, so assigning it here collapsed a whole transcript
    // down to its newest message ("再发一条消息，前面的消息就突然不见了").
    if(fetched.length)streamEvents=mergeEntries(streamEvents.concat(fetched));
    if(fetched.length||!streamEvents.length)olderHasMore=olderExhausted?false:olderHasMore||value.hasMore===true}const events=windowEvents(),durable=visibleMessages(events);if(durable.some(message=>message.role==='user'))sessionBlank=false;const messages=messagesWithOptimistic(durable);updateRunning(events);updateTodos(value.projections);updateGoal(value.projections);updateQueue(value.projections);const key=JSON.stringify([messages,pendingQuestion?.rpcId||null,agentRunning,currentTodos,todoExpanded]);syncSettingsControls();showSessionModel(modelSelectionOf(value.projections));if(key!==lastHistoryKey){paintMessages(messages,initial);lastHistoryKey=key;idlePollMs=HISTORY_POLL_IDLE_MS}renderOlderButton();void ensureTranscriptFilled()}
  function flushStreamRender(sessionId){streamRenderFrame=null;if(activeSession!==sessionId)return;const durable=visibleMessages(windowEvents()),messages=messagesWithOptimistic(durable);if(tokenStream&&tokenStream.text)messages.push({role:'assistant',streaming:true,blocks:[{kind:'text',text:tokenStream.text}]});if(durable.some(message=>message.role==='user'))sessionBlank=false;updateRunning(windowEvents());syncSettingsControls();if(streamNeedsFullPaint)paintMessages(messages,false);else patchLastStreamMessage(messages);streamNeedsFullPaint=false;lastHistoryKey='';idlePollMs=HISTORY_POLL_IDLE_MS}
  function queueStreamRender(sessionId,fullPaint){streamNeedsFullPaint=streamNeedsFullPaint||fullPaint;if(streamRenderFrame===null)streamRenderFrame=requestAnimationFrame(()=>flushStreamRender(sessionId))}
  function tokenChunkText(value){if(typeof value==='string')return value;if(value&&typeof value==='object'){for(const key of ['text','delta','content']){if(typeof value[key]==='string')return value[key]}}return''}
  function schedulePendingSync(sessionId){if(pendingSyncTimer!==null)return;pendingSyncTimer=setTimeout(()=>{pendingSyncTimer=null;if(activeSession===sessionId)void rpc('interaction.pending',{sessionId}).then(syncPendingQuestion).catch(()=>{})},PENDING_SYNC_DEBOUNCE_MS)}
  function openSessionStream(sessionId){armStreamSnapshot();const sinceSeq=streamWatermark(sessionId);const source=new EventSource('/api/session/stream?sessionId='+encodeURIComponent(sessionId)+(sinceSeq>=0?'&sinceSeq='+sinceSeq:''));sessionStream=source;source.addEventListener('status',event=>{if(activeSession!==sessionId)return;let frame;try{frame=JSON.parse(event.data)}catch{return}lastStreamFrameAt=Date.now();noteStreamRecovery();applyLiveStatus(frame)});source.addEventListener('snapshot',event=>{if(activeSession!==sessionId)return;let frame;try{frame=JSON.parse(event.data)}catch{return}const incoming=frame.records||[];lastStreamFrameAt=Date.now();noteStreamRecovery();tokenStream=null;// A reconnect snapshot only carries the last turn window; replacing the
// buffer would erase every older turn ("前面的消息突然就不见了" on send).
// Always merge by seq: append-only records dedupe and stay ordered.
streamEvents=mergeEntries(streamEvents.concat(incoming));streamProjections=frame.projections;streamConnected=true;streamRevision+=1;applyHistory({events:streamEvents,projections:streamProjections,hasMore:frame.hasMore===true},pendingQuestion,false);markStreamSnapshot(incoming.length>0)});source.addEventListener('event',event=>{if(activeSession!==sessionId)return;lastStreamFrameAt=Date.now();noteStreamRecovery();let frame;try{frame=JSON.parse(event.data)}catch{return}applyStreamEventFrame(sessionId,frame)});// The staleness clock is fed before the parse guard — a frame that is not JSON is
// still proof the stream is alive. The guard is also the P0 fix: this listener
// shipped reading an undeclared variable, so every token frame threw.
source.addEventListener('token',event=>{if(activeSession!==sessionId)return;lastStreamFrameAt=Date.now();noteStreamRecovery();let frame;try{frame=JSON.parse(event.data)}catch{return}applyTokenFrame(sessionId,frame)});source.addEventListener('failure',event=>{if(activeSession!==sessionId)return;let frame;try{frame=JSON.parse(event.data)}catch{return};showError('chatError',{message:streamFailureCopy(frame),important:true})});source.onerror=()=>{streamConnected=false;markStreamSnapshot(false);tokenStream=null;notifyStreamDown();schedulePoll()}
   armStreamStaleWatch(sessionId)}
  // One body per frame kind, shared by both realtime transports (the SSE listeners
  // above and the tunnel poller below). Two divergent copies of this state machine are
  // how the same session would end up drawn differently depending on the door it came
  // through, so both call the very same functions.
  function applyTokenFrame(sessionId,frame){const kind=String(frame.type||'');if(kind==='start'){tokenStream={revision:frame.revision??null,text:'',seen:new Set()};return}if(kind==='chunk'){if(!tokenStream)tokenStream={revision:frame.revision??null,text:'',seen:new Set()};const key=String(frame.revision??'')+':'+String(frame.index??'');if(tokenStream.seen.has(key))return;tokenStream.seen.add(key);const piece=tokenChunkText(frame.chunk);if(piece){tokenStream.text+=piece;queueStreamRender(sessionId,false)}}else if(kind==='end'){const outcome=frame.outcome||null;const abandoned=!!outcome&&outcome.kind==='abandoned';tokenStream=null;if(abandoned)void loadHistory(false)}}
  function applyStreamEventFrame(sessionId,frame){const entry=frame.event||frame,type=String(entry.type||'').toLowerCase();if(type==='model/selection')showSessionModel(entry.data);const seq=eventSeq(frame);if(seq>=0&&seq>streamWatermark(sessionId))streamWatermarks.set(sessionId,seq);streamEvents.push(frame);streamRevision+=1;if(streamEvents.length>STREAM_EVENTS_CAP)streamEvents=streamEvents.slice(streamEvents.length-STREAM_EVENTS_CAP);queueStreamRender(sessionId,type!=='assistant/chunk');if(type!=='assistant/chunk')schedulePendingSync(sessionId);if(type==='goal/change'||type==='agent/inbox/spliced'||type==='user/message'||type==='turn/start'||type==='turn/end')scheduleProjectionsSync(sessionId)}
  // --- Realtime over the tunnel: poll instead of stream (feat-pocket-stream-fallback).
  // A quick tunnel swallows every live SSE frame after the opening snapshot, so when
  // the bridge reports connectionMode:'tunnel' the page never opens an EventSource at
  // all; it polls the incremental events endpoint instead, and the history RPC stays
  // the durable backbone (it already runs while the stream looks connected). mode:'lan'
  // keeps the SSE path above byte-identical. The page script is a rendered string, so
  // these periods are literals; test/pages-tunnel-poll.test.js pins them to the card
  // contract (1.5s base, 6s cap).
  const EVENTS_POLL_BASE_MS=1500,EVENTS_POLL_MAX_MS=6000,EVENTS_FETCH_TIMEOUT_MS=10000;
  let connectionMode='lan',eventPollTimer=null,eventPollSession=null,eventPollCursor=-1,eventPollGeneration=null,eventPollEmpty=0,eventPollFailures=0,eventPollBusy=false;
  function stopEventPolling(){pauseEventPolling();eventPollSession=null;eventPollCursor=-1;eventPollGeneration=null;eventPollEmpty=0;eventPollFailures=0;eventPollBusy=false}
  function pauseEventPolling(){if(eventPollTimer!==null){clearTimeout(eventPollTimer);eventPollTimer=null}}
  function scheduleEventPoll(delay){pauseEventPolling();if(!eventPollSession)return;eventPollTimer=setTimeout(()=>{eventPollTimer=null;const sessionId=eventPollSession;if(sessionId&&activeSession===sessionId)void pollSessionEvents(sessionId)},delay)}
  // The first screen still comes from the history RPC in this mode (the poll is
  // increments only), so the snapshot promise settles false immediately instead of
  // making openSession wait out its 900ms fallback.
  function openEventPolling(sessionId){stopEventPolling();eventPollSession=sessionId;armStreamSnapshot();settleStreamSnapshot(false);scheduleEventPoll(0)}
  function openRealtime(sessionId){if(connectionMode==='tunnel')openEventPolling(sessionId);else openSessionStream(sessionId)}
  // A mode flip must not blank the transcript: unlike closeSessionStream — which resets
  // the whole per-session state for a session about to be rebuilt — this swap keeps
  // every painted record and changes only the realtime leg underneath it.
  function setConnectionMode(mode){if((mode!=='lan'&&mode!=='tunnel')||mode===connectionMode)return;connectionMode=mode;if(mode==='tunnel'){if(sessionStream){sessionStream.close();sessionStream=null}clearStreamStaleWatch();streamConnected=false;tokenStream=null;if(activeSession)openEventPolling(activeSession)}else{stopEventPolling();if(activeSession)openSessionStream(activeSession)}}
  function reopenRealtime(){if(!activeSession)return;if(connectionMode==='tunnel'){if(eventPollSession===activeSession)scheduleEventPoll(0);return}reopenSessionStream()}
  async function pollSessionEvents(sessionId){
    if(!activeSession||sessionId!==activeSession||document.hidden||eventPollBusy)return;
    eventPollBusy=true;
    let raceTimer=null;
    try{
      // One AbortController per page is the mobile-assets pin, so the ceiling here is a
      // race, not an abort: a hung answer is abandoned and the next poll supersedes it.
      // The race timer is retired the moment the race settles — a timer per poll left
      // hanging would be churn on a phone that polls for hours.
      const response=await Promise.race([fetch('/api/session/events?sessionId='+encodeURIComponent(sessionId)+'&sinceSeq='+String(eventPollCursor),{cache:'no-store'}),new Promise(resolve=>{raceTimer=setTimeout(()=>resolve(null),EVENTS_FETCH_TIMEOUT_MS)})]);
      if(activeSession!==sessionId||connectionMode!=='tunnel')return;
      if(!response)throw new Error('poll timeout');
      if(response.status===401){location.replace('/disconnected');return}
      if(response.url&&new URL(response.url).pathname==='/consent'){location.replace('/consent?next=/');return}
      if(!response.ok)throw new Error('events answered '+String(response.status));
      let body;try{body=await response.json()}catch{throw new Error('events body unreadable')}
      if(!body||body.ok!==true)throw new Error('events refused');
      const frames=Array.isArray(body.events)?body.events:[];
      for(let i=0;i<frames.length;i+=1){const entry=frames[i];if(!entry||typeof entry.seq!=='number')continue;if(entry.kind==='token')applyTokenFrame(sessionId,entry.frame);else if(entry.kind==='event')applyStreamEventFrame(sessionId,entry.frame)}
      if(activeSession!==sessionId||connectionMode!=='tunnel')return;
      if(typeof body.latestSeq==='number'&&body.latestSeq>eventPollCursor)eventPollCursor=body.latestSeq;
      lastStreamFrameAt=Date.now();
      noteStreamRecovery();
      // Mode discovery rides every answer (card 1a): a flip to 'lan' retires the poller
      // in the same tick and hands realtime back to the SSE.
      if(typeof body.mode==='string')setConnectionMode(body.mode);
      // Re-sync triggers from the endpoint contract: a new collector generation (idle
      // teardown, LRU eviction, bridge restart), a trimmed window, or a poller that
      // just recovered from consecutive failures. The transcript is rebuilt from
      // history before cursors are trusted again.
      const resync=body.overflow===true||(eventPollGeneration!==null&&body.generation!==eventPollGeneration);
      const recovered=eventPollFailures>=2;
      if(typeof body.generation==='string')eventPollGeneration=body.generation;
      eventPollFailures=0;
      streamConnected=body.connected!==false;
      if(resync||recovered){streamConnected=false;lastHistoryKey='';void loadHistory(false)}
      eventPollEmpty=frames.length?0:eventPollEmpty+1;
    }catch(error){
      if(activeSession!==sessionId||connectionMode!=='tunnel')return;
      eventPollFailures+=1;eventPollEmpty+=1;
      // Two strikes means the realtime leg cannot be trusted: drop the live-stream
      // flag so the history poll returns to its active cadence, and say the outage
      // once through the same notice every other drop uses.
      if(eventPollFailures>=2){streamConnected=false;notifyStreamDown()}
    }finally{
      // The ceiling timer dies with the round, success or failure — a failed poll that
      // left it hanging would fire a resolve into an already-settled race forever.
      if(raceTimer!==null){clearTimeout(raceTimer);raceTimer=null}
      eventPollBusy=false;
      if(eventPollSession===sessionId&&activeSession===sessionId&&!document.hidden)scheduleEventPoll(Math.min(EVENTS_POLL_BASE_MS*Math.pow(2,Math.min(eventPollEmpty,8)),EVENTS_POLL_MAX_MS));
    }
  }
  async function showSessionList(){closePlus();clearTimeout(poll);poll=null;if(activeSession)noteSessionOpened(activeSession);if(activeSession&&streamEvents.length){sessionCache.set(activeSession,{streamEvents,olderEvents,olderHasMore,olderExhausted,streamProjections})}evictSessionCache();closeSessionStream();closeSessionSettings();activeSession=null;resetOptimisticMessages();syncPendingQuestion(null);document.body.classList.remove('chat-open');$('chatView').classList.remove('active');$('sessionsView').classList.add('active');await refreshList(false)}
function paintInstantHistory(events,projections){const durable=visibleMessages(events);if(durable.some(message=>message.role==='user'))sessionBlank=false;const messages=messagesWithOptimistic(durable);updateRunning(events);updateTodos(projections);updateGoal(projections);updateQueue(projections);syncSettingsControls();showSessionModel(modelSelectionOf(projections));paintMessages(messages,false);const box=$('messages');box.scrollTop=box.scrollHeight}
  function paintInstantSession(allowEmbedded){// Cold-open embedded last turn wins once; otherwise reuse the cached live
    // state from the last visit so re-entering a running chat paints instantly
    // instead of showing a skeleton and re-parsing everything after a round trip.
    // A handoff snapshot is one turn wide. Overwriting the buffer with it, or dropping
    // the older window already on screen, reads to the phone as: the messages from a
    // moment ago vanished, only the newest one is left. That symptom has two independent
    // causes — this overwrite and the cross-session watermark — and repairing only one
    // leaves the other producing the same lost history, so both branches below merge by
    // seq and keep the older window exactly where the phone had scrolled to it.
    if(allowEmbedded&&embeddedFocus&&embeddedFocus.sessionId===activeSession){streamEvents=mergeEntries(streamEvents.concat(embeddedFocus.history.events||[]));olderHasMore=embeddedFocus.history.hasMore===true;olderExhausted=false;streamProjections=embeddedFocus.history.projections||null;embeddedFocus=null;paintInstantHistory(windowEvents(),streamProjections);
      // The handoff paints instantly and skips the history RPC, so this is the
      // only place that knows a short handoff may not fill the screen. A phone
      // viewport is far taller than the handoff page, which is why the chat
      // used to open half empty with no attempt to pull the rest.
      void ensureTranscriptFilled();return true}
    const cached=sessionCache.get(activeSession)
    if(cached&&cached.streamEvents.length){sessionCache.delete(activeSession);sessionCache.set(activeSession,cached);streamEvents=mergeEntries(streamEvents.concat(cached.streamEvents));olderEvents=mergeEntries(olderEvents.concat(cached.olderEvents||[]));olderHasMore=cached.olderHasMore;olderExhausted=cached.olderExhausted===true;streamProjections=cached.streamProjections;paintInstantHistory(windowEvents(),streamProjections);return true}
    return false}
  // The desktop keeps the transcript out of the first document on purpose (it
  // would roughly double the page), so a direct re-entry — unlike a pairing
  // handoff, which prewarms this tab's payload — always pays one tunnel round
  // trip before the conversation can paint. Name that wait: three anonymous grey
  // bars read as a frozen page (live report 2026-10-02, "停留在空白的会话页面").
  function loadingShell(){return '<p class="loading-hint">'+L.syncingChat+'</p><div class="loading"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>'}
  // An empty transcript must never read as a blank page: keep the retry block the last
  // failure left on screen, otherwise name the wait. A session the desktop reports as
  // blank is legitimately empty, so it keeps showing nothing instead of a fake wait.
  function transcriptWaitHtml(box){const stalled=box.querySelector(':scope > .loading-failed');if(stalled)return stalled.outerHTML;return sessionBlank?'':loadingShell()}
  // Three silent retries is a stall, not a wait: hand the reader the same tappable
  // reload a failed history fetch leaves, instead of abandoning the skeleton.
  function showTranscriptRetry(){if(!activeSession)return;const box=$('messages');if(box.querySelector('.message'))return;box.innerHTML='<div class="loading-failed">'+esc(L.loadFailed)+'<button class="older-row" data-reload="1">'+esc(L.retry)+'</button></div>'}
  async function openSession(id,title,fromHistory=false,pushHistory=true){// Same-session re-entry while the live stream is already up must be a no-op:
// tearing down the EventSource mid-handshake and repainting the same transcript
// was the re-entry freeze (startup openSession + reconcileBoot openSession raced).
// That no-op must not leave handoffPainted behind: the flag says the pairing handoff
// already painted this page, and the next session would otherwise skip its 900ms history
// fallback on the strength of a paint it never received (audit X3-1). The reset belongs on
// the early exit only — clearing it first thing would take the fast path away from the
// boot that just set it, because noteHandoffCoverage runs before this function is entered.
if(activeSession===id&&streamConnected&&!fromHistory){handoffPainted=false;return}clearTimeout(poll);closeSessionStream();// Only a user-initiated jump may add a history entry. An automatic boot/resume/
// reconcile jump must rewrite the current entry instead, otherwise a stale
// {view:'chat'} entry stays below the live one and the first back press just
// reopens the very session on screen.
if(!fromHistory){const entry={view:'chat',sessionId:id,title:title||L.untitled};if(pushHistory)history.pushState(entry,'');else history.replaceState(entry,'')}activeSession=id;const summary=sessionSummaries.find(item=>item.sessionId===id);sessionBlank=summary?.blank??true;noteSessionOpened(id);followStream=true;currentPreset=agentPresetOf(summary?.projections)||null;modelCatalog=null;closeSessionSettings();lastHistoryKey='';resetOptimisticMessages();syncPendingQuestion(null);composerDrafts=[];renderDrafts();document.body.classList.add('chat-open');$('sessionsView').classList.remove('active');$('chatView').classList.add('active');const hadInstant=paintInstantSession(!fromHistory);if(!hadInstant||!$('messages').querySelector('.message'))$('messages').innerHTML=loadingShell();openRealtime(id);
  // Prefer the live SSE snapshot for the first screen. Fall back to the RPC
  // history only if the first frame is slow (~900ms) or the stream errors, so
  // a healthy connection never fetches the same page twice.
  // Arm the recovery timer BEFORE awaiting the first fetch: a hung socket used
  // to leave the busy flag set and this await pending, so nothing ever retried.
  armSkeletonWatchdog(id);
  const firstFrame=await Promise.race([streamSnapshotReady,new Promise(resolve=>setTimeout(()=>resolve('timeout'),900))]);
  if(activeSession===id&&firstFrame!==true&&!handoffPainted)await loadHistory(true);
  handoffPainted=false;
  schedulePoll()
  // The handoff path (paintInstantHistory) deliberately skips the history RPC,
  // so nothing has called the fill loop yet: on a tall phone screen a short
  // handoff history used to leave the transcript half empty with no attempt to
  // pull the rest. Harmless when the transcript already fills the viewport.
  void ensureTranscriptFilled()}
function handleHistory(state){if(state?.view==='chat'&&state.sessionId){// A chat entry while the chat is already on screen is a stale duplicate: the
// old handler reopened the same session, which repainted an identical view and
// made the back gesture look dead. Collapse it and fall through to the list.
if(document.body.classList.contains('chat-open')){history.replaceState({view:'sessions'},'');showSessionList();return}openSession(state.sessionId,state.title,true);return}showSessionList()}
  function clearSkeletonWatchdog(){if(skeletonWatchdog!==null)clearTimeout(skeletonWatchdog);skeletonWatchdog=null}
  // A blank skeleton is not a resting state. If nothing has painted after 5s the
  // first history fetch either lost its race or came back empty, so retry it up
  // to three times; the failure path renders an inline retry button instead.
  function armSkeletonWatchdog(sessionId,attempt=0){clearSkeletonWatchdog();if(attempt>=3){showTranscriptRetry();return}skeletonWatchdog=setTimeout(()=>{skeletonWatchdog=null;if(activeSession!==sessionId)return;if($('messages').querySelector('.message')||sessionBlank)return;void loadHistory(true,true).finally(()=>armSkeletonWatchdog(sessionId,attempt+1))},5000)}
  // Each poll refetches the last 100 messages through Harness, so an idle chat
  // left open used to cost the desktop a full history serialisation every
  // 750ms indefinitely. Back off while nothing changes, and stop entirely
  // while the tab is hidden.
  function schedulePoll(){clearTimeout(poll);poll=null;if(!activeSession||document.hidden)return;const delay=streamConnected?HISTORY_POLL_IDLE_CAP_MS:agentRunning||pendingQuestion?HISTORY_POLL_ACTIVE_MS:idlePollMs;poll=setTimeout(()=>{void loadHistory(false)},delay)}
  async function loadHistory(initial,force){if(!activeSession||(historyBusy&&!force))return;historyBusy=true;const owner=activeSession,revision=streamRevision;try{const sessionId=activeSession;let value=null,pending;if(streamConnected&&transcriptHasContent()){// The live SSE snapshot already painted the first screen; do not fetch the
        // same last-turn page a second time. Only refresh the pending question.
        pending=await rpc('interaction.pending',{sessionId})}else{[value,pending]=await Promise.all([rpc('session.history',{sessionId,maxMessages:30}),rpc('interaction.pending',{sessionId})])}if(activeSession!==sessionId)return;if(streamConnected&&transcriptHasContent()&&streamRevision!==revision){syncPendingQuestion(pending);return}if(value)applyHistory(value,pending,initial);else syncPendingQuestion(pending);if(!streamConnected&&!agentRunning&&!pendingQuestion)idlePollMs=Math.min(Math.round(idlePollMs*1.5),HISTORY_POLL_IDLE_CAP_MS);clearTransientError('chatError')}catch(e){if(activeSession===owner){if(e&&e.errorCode==='session/agent-busy'){void showSessionList();return}showError('chatError',e);if(!$('messages').querySelector('.message'))$('messages').innerHTML='<div class="loading-failed">'+esc(e?.message||L.loadFailed)+'<button class="older-row" data-reload="1">'+esc(L.retry)+'</button></div>'}}finally{historyBusy=false;schedulePoll()}}
const FALLBACK_IMAGE_LIMITS={maxImageBytes:10*1024*1024,maxImagesPerMessage:4,maxMessageImageBytes:25*1024*1024,mediaTypes:['image/png','image/jpeg','image/webp','image/gif']};
// The bridge reads every RPC body under a ceiling chosen by method, and a
// session.prompt (or file.upload / command.execute) is admitted up to
// LARGE_BODY_BYTES. The Host's own image limits are far larger — live probe
// 2026-10-06 on the shipping Host: maxImageBytes 20 MiB, maxImagesPerMessage
// 20, maxMessageImageBytes 200 MiB — so a draft set the Host would happily
// accept can still build a body the bridge refuses with a bare 413. That is
// exactly what the phone showed on 2026-10-06: the optimistic 「1 图片」 row
// appeared and then vanished, with only "rpc body refused … Request body is
// too large." left on disk. The ceiling is therefore injected here (one source
// of truth) and the effective limits are clamped to what this transport can
// actually carry.
const RPC_BODY_CEILING=${LARGE_BODY_BYTES};
const RPC_SMALL_BODY_CEILING=${MAX_BODY_BYTES};
const RPC_BODY_HEADROOM=64*1024;
const RPC_BODY_BUDGET=RPC_BODY_CEILING-RPC_BODY_HEADROOM;
// The bridge admits a body by METHOD: everything outside this list is read
// under the 64 KB tier and refused above it (live-probed 2026-10-06: a 555 KB
// command.execute carrying one image attachment came back as a bare 413). The
// list is injected from lib/constants.js so the page can never build a body its
// own method cannot carry.
const RPC_LARGE_BODY_METHODS=${JSON.stringify([...LARGE_BODY_METHODS])};
function rpcBodyCeilingFor(method){return RPC_LARGE_BODY_METHODS.indexOf(method)>=0?RPC_BODY_CEILING:RPC_SMALL_BODY_CEILING}
const IMAGE_TYPE_BY_EXT={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'};
// Android gallery picks can arrive with an empty type field; falling back to
// the extension keeps such a file out of the silent filter() drop below.
function imageMediaTypeOf(file){const declared=String(file?.type||'').toLowerCase();if(declared.startsWith('image/'))return declared;const name=String(file?.name||'');const dot=name.lastIndexOf('.');return dot<0?'':IMAGE_TYPE_BY_EXT[name.slice(dot+1).toLowerCase()]||''}
function base64Length(rawBytes){return Math.ceil((Number(rawBytes)||0)/3)*4}
function utf8Length(value){const text=String(value??'');let bytes=text.length;for(let index=0;index<text.length;index+=1){const code=text.charCodeAt(index);if(code>0x7f)bytes+=code>0x7ff?2:1}return bytes}
function encodedImageBytes(){return composerDrafts.filter(d=>d.kind==='image'&&d.status!=='removed').reduce((sum,d)=>sum+(typeof d.data==='string'&&d.data?d.data.length:base64Length(d.bytes)),0)}
function encodedPromptBytes(text){return encodedImageBytes()+utf8Length(text)+2048}
function overBodyBudget(text){return encodedPromptBytes(text)>RPC_BODY_BUDGET}
function imageLimits(){const v=streamProjections?.values?.imageLimits;const merged=v&&typeof v==='object'?{...FALLBACK_IMAGE_LIMITS,...v}:FALLBACK_IMAGE_LIMITS;const rawBudget=Math.max(1,Math.floor(RPC_BODY_BUDGET/4*3));return{...merged,maxImageBytes:Math.min(Number(merged.maxImageBytes)||rawBudget,rawBudget),maxMessageImageBytes:Math.min(Number(merged.maxMessageImageBytes)||rawBudget,rawBudget)}}
let draftSeq=0;
// One mapper for the whole too-large family: a bridge 413 says "Request body is
// too large." in English; the draft card and the chat error must both answer in
// the page language, with the next step attached. send() keeps its own branch
// shape (it must not drop e.disconnected when the failure is NOT too-large), but
// it sources the copy from here, so the regex is defined exactly once.
function attachFailureCopy(e){const message=String(e?.message||'');return /too large/i.test(message)?L.attachTooLarge:(message||L.failed)}
function addImageDrafts(fileList){const picked=Array.from(fileList||[]).map(file=>({file,mediaType:imageMediaTypeOf(file)}));const images=picked.filter(item=>item.mediaType!=='');if(!picked.length)return;if(!images.length)throw new Error(L.attachBadType);const limits=imageLimits();const currentImages=composerDrafts.filter(d=>d.kind==='image'&&d.status!=='removed').length;if(currentImages+images.length>limits.maxImagesPerMessage)throw new Error(L.attachTooMany);// Phase 1: validate every file (type, per-file size) without touching state.
for(const item of images){if(limits.mediaTypes&&limits.mediaTypes.length&&!limits.mediaTypes.includes(item.mediaType))throw new Error(L.attachBadType);if(item.file.size>limits.maxImageBytes)throw new Error(L.attachTooLarge)}// Phase 2: walk the aggregate total, constructing draft objects but pushing
// nothing until the whole batch is known to fit (atomic on failure).
let aggregate=composerDrafts.filter(d=>d.kind==='image'&&d.status!=='removed').reduce((s,d)=>s+(d.bytes||0),0);const accepted=[];for(const item of images){if(aggregate+item.file.size>limits.maxMessageImageBytes)throw new Error(L.attachTooLarge);aggregate+=item.file.size;accepted.push({id:'d'+(++draftSeq),kind:'image',status:'ready',name:item.file.name,mediaType:item.mediaType,bytes:item.file.size,file:item.file,data:null,thumb:null})}// Phase 3: all validation passed — commit the drafts as one batch, render,
// then start readers. A failure above leaves composerDrafts untouched.
for(const draft of accepted)composerDrafts.push(draft);renderDrafts();for(const draft of accepted){const reader=new FileReader();reader.onload=()=>{const url=String(reader.result||'');const comma=url.indexOf(',');draft.thumb=url;draft.data=comma>=0?url.slice(comma+1):url;
// The picked size is the browser's word; the encoded length is a fact. A file
// whose reported size understates its bytes (an Android gallery pick) clears
// every check above and still builds a body the bridge refuses, so the real
// measurement is enforced here and the draft is dropped loudly instead of
// being sent into a 413 that only ever looked like "the picture vanished".
if(typeof draft.data==='string'&&encodedImageBytes()>RPC_BODY_BUDGET){composerDrafts=composerDrafts.filter(d=>d.id!==draft.id);renderDrafts();showError('chatError',new Error(L.attachTooLarge));return}renderDrafts()};reader.readAsDataURL(draft.file)}}
async function uploadGenericFile(file){const draft={id:'d'+(++draftSeq),kind:'file',status:'uploading',name:file.name,bytes:file.size,file,receiptId:null};composerDrafts.push(draft);renderDrafts();if(base64Length(file.size)>RPC_BODY_BUDGET){draft.status='failed';draft.error=L.attachTooLarge;renderDrafts();return}try{const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file)});const comma=dataUrl.indexOf(','),data=comma>=0?dataUrl.slice(comma+1):dataUrl;const value=await rpc('file.upload',{sessionId:activeSession,data,name:file.name});draft.receiptId=value.receiptId;draft.status='ready';renderDrafts()}catch(e){draft.status='failed';draft.error=attachFailureCopy(e);renderDrafts()}}
function addFileDrafts(fileList){const files=Array.from(fileList||[]);for(const file of files)void uploadGenericFile(file)}
function removeDraft(id){const draft=composerDrafts.find(d=>d.id===id);if(!draft)return;draft.status='removed';composerDrafts=composerDrafts.filter(d=>d.id!==id);renderDrafts()}
function retryDraft(id){const draft=composerDrafts.find(d=>d.id===id);if(!draft||draft.kind!=='file')return;if(base64Length(draft.bytes)>RPC_BODY_BUDGET){draft.status='failed';draft.error=L.attachTooLarge;renderDrafts();return}draft.status='uploading';renderDrafts();const dataFromReader=async()=>{const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(draft.file)});const comma=dataUrl.indexOf(',');return comma>=0?dataUrl.slice(comma+1):dataUrl};dataFromReader().then(data=>rpc('file.upload',{sessionId:activeSession,data,name:draft.name})).then(value=>{draft.receiptId=value.receiptId;draft.status='ready';renderDrafts()}).catch(e=>{draft.status='failed';draft.error=attachFailureCopy(e);renderDrafts()})}
const FILE_ICON_SVG='<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M10 2.5H5.2A1.7 1.7 0 0 0 3.5 4.2v9.6c0 .94.76 1.7 1.7 1.7h7.6c.94 0 1.7-.76 1.7-1.7V7L10 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.8 2.8v4.3h4.1" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
function renderDrafts(){const host=$('draftStrip');if(!host)return;host.innerHTML=composerDrafts.map(d=>{const remove='<button type="button" class="draft-remove" data-draft-remove="'+esc(d.id)+'" aria-label="'+esc(L.draftRemove)+'">×</button>';if(d.kind==='image'){return'<div class="draft-card">'+(d.thumb?'<img src="'+d.thumb+'" alt="">':'')+(d.name?'<span class="draft-meta">'+esc(d.name)+'</span>':'')+remove+'</div>'}return'<div class="draft-card'+(d.status==='failed'?' is-failed':'')+'" data-draft-retry="'+esc(d.id)+'" role="button" tabindex="0"><div class="draft-file">'+FILE_ICON_SVG+'<span class="draft-file-name">'+esc(d.name)+'</span></div>'+(d.status==='uploading'?'<span class="draft-state">'+esc(L.draftUploading)+'</span>':d.status==='failed'?'<span class="draft-state">'+esc(L.draftFailed)+'</span>':'')+remove+'</div>'}).join('')}
function readyDrafts(){return composerDrafts.filter(d=>d.status==='ready')}
function validateImagesReady(){const drafts=readyDrafts();const images=drafts.filter(d=>d.kind==='image');if(images.some(d=>!d.data))throw new Error(L.draftUploading)}
function attachmentParts(){return readyDrafts().map(d=>d.kind==='image'?{type:'image',mediaType:d.mediaType,data:d.data,...(d.name?{name:d.name}:{})}:{type:'file',receiptId:d.receiptId})}
function submittedAttachmentParts(){return attachmentParts()}
function draftSummary(){const drafts=readyDrafts();if(!drafts.length)return'';const images=drafts.filter(d=>d.kind==='image').length,files=drafts.filter(d=>d.kind==='file').length;const bits=[];if(images)bits.push(images+' '+L.imageChip);if(files)bits.push(files+' '+L.fileChip);return bits.join(L.draftJoin)}
function clearSentDrafts(){composerDrafts=[];renderDrafts()}
const PLUS_BACK_SVG='<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.5 3L5.5 8L10.5 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PLUS_ICONS={
goal:'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.2" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/></svg>',
plan:'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="4.5" width="14" height="15.5" rx="2.2" stroke="currentColor" stroke-width="1.6"/><path d="m8.4 11 1.4 1.4 2.6-2.7M8.4 16.4l1.4 1.4 2.6-2.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.5 9.5h2M14.5 14.9h2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
feedback:'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6.7A2.2 2.2 0 0 1 6.2 4.5h11.6A2.2 2.2 0 0 1 20 6.7v7.1a2.2 2.2 0 0 1-2.2 2.2H9.4l-3.7 3 .1-3A2.2 2.2 0 0 1 4 13.8V6.7Z" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round"/><path d="M8.5 10h7M8.5 13h4.6" stroke="currentColor" stroke-width="1.55" stroke-linecap="round"/></svg>',
compact:'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 4v3.2c0 1-.8 1.8-1.8 1.8H4M20 9h-3.2c-1 0-1.8-.8-1.8-1.8V4M9 20v-3.2c0-1-.8-1.8-1.8-1.8H4M20 15h-3.2c-1 0-1.8.8-1.8 1.8V20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
permission:'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3.6 5 6.3v5.1c0 4.4 2.9 7.6 7 9 4.1-1.4 7-4.6 7-9V6.3l-7-2.7Z" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round"/><path d="m8.9 12 2.1 2.1 4-4.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
model:'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
export:'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4v10.5M12 4l-3.4 3.4M12 4l3.4 3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 13.5v4.3c0 1 .8 1.7 1.7 1.7h11.6c1 0 1.7-.8 1.7-1.7v-4.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
};
let plusView='root';
let plusPreviousFocus=null;
// Set while a native file dialog is taking over from the sheet: the 230ms
// close timeout must NOT steal focus back, or the phone browser dismisses the
// just-opened file picker.
let plusSuppressFocusReturn=false;
function plusOpen(){return!$('plusSheet').hidden&&plusView!=='closing'}
// The search field is opt-in: opening the sheet must NOT focus an input, or
// Android raises the soft keyboard the moment the user taps "+". The collapsed
// affordance is a plain button; only a real tap swaps in #plusFilter and
// focuses it, which makes the IME intentional rather than incidental.
function plusSetSearch(shown){const row=$('plusSearchRow'),open=$('plusSearchOpen');if(row)row.hidden=!shown;if(open)open.hidden=!!shown;const filter=$('plusFilter');if(filter){filter.hidden=false;if(!shown)filter.value=''}}
function plusShowSearch(){plusSetSearch(true);renderPlusRoot();$('plusFilter').focus()}
function plusHideSearch(){plusSetSearch(false);renderPlusRoot()}
function plusRows(){return[
{id:'file',name:'file',icon:FILE_ICON_SVG,title:L.plusFile,desc:L.plusFileDesc},
{id:'goal',name:'goal',icon:PLUS_ICONS.goal,title:L.plusGoal,desc:L.plusGoalDesc},
{id:'plan',name:'plan',icon:PLUS_ICONS.plan,title:L.plusPlan,desc:L.plusPlanDesc},
{id:'feedback',name:'feedback',icon:PLUS_ICONS.feedback,title:L.plusFeedback,desc:L.plusFeedbackDesc},
{id:'compact',name:'compact',icon:PLUS_ICONS.compact,title:L.plusCompact,desc:L.plusCompactDesc},
{id:'permission',name:'permission',icon:PLUS_ICONS.permission,title:L.plusPermission,desc:L.plusPermissionDesc},
{id:'model',name:'model',icon:PLUS_ICONS.model,title:L.plusModel,desc:L.plusModelDesc},
{id:'export',name:'export',icon:PLUS_ICONS.export,title:L.plusExport,desc:L.plusExportDesc}
]}
function rowHtml(row){return'<button class="plus-row'+(row.danger?' plus-row-danger':'')+'" data-plus-row="'+esc(row.id)+'"><span class="plus-row-icon">'+row.icon+'</span><span class="plus-row-title">'+esc(row.title)+'</span><span class="plus-row-desc">'+esc(row.desc)+'</span></button>'}
function renderPlusRoot(){const q=String($('plusFilter').value||'').trim().toLowerCase();const sections=[[L.plusSectionAdd,['file','goal','plan','feedback']],[L.plusSectionCommands,['compact','permission','model','export']]];const byId=new Map(plusRows().map(r=>[r.id,r]));let html='';for(const [title,ids] of sections){const rows=ids.map(id=>byId.get(id)).filter(r=>!q||((r.title+' '+r.desc+' '+(r.name||'')).toLowerCase().includes(q)));if(rows.length){html+='<div class="plus-section-title">'+esc(title)+'</div>'+rows.map(rowHtml).join('')}}if(!html)html='<div class="plus-empty">'+esc(L.plusNoMatch)+'</div>';$('plusBody').innerHTML=html}
function renderPlusFile(){plusView='file';plusSetSearch(false);$('plusBody').innerHTML='<button class="plus-back" data-plus-back>'+PLUS_BACK_SVG+'<span>'+esc(L.plusBack)+'</span></button><div class="plus-section-title">'+esc(L.plusFile)+'</div>'+rowHtml({id:'pick-image',icon:'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2" stroke="currentColor" stroke-width="1.55"/><circle cx="8.6" cy="9.6" r="1.7" stroke="currentColor" stroke-width="1.5"/><path d="m4.6 17.5 5-5 3.6 3.6 2.4-2.4 3.8 3.8" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg>',title:${scriptJson(zh ? '选择图片' : 'Choose images')},desc:${scriptJson(zh ? '从相册添加图片' : 'Add images from gallery')}})+rowHtml({id:'pick-any',icon:FILE_ICON_SVG,title:${scriptJson(zh ? '选择文件' : 'Choose files')},desc:${scriptJson(zh ? '添加任意类型文件' : 'Add any file type')}})}
async function renderPlusPermission(){plusView='permission';plusSetSearch(false);$('plusBody').innerHTML='<button class="plus-back" data-plus-back>'+PLUS_BACK_SVG+'<span>'+esc(L.plusBack)+'</span></button><div class="plus-section-title">'+esc(L.plusPermission)+'</div><div class="plus-empty">'+esc(L.plusPermissionLoading)+'</div>';let options=[];try{const value=await rpc('permissionPresets.catalog',{});options=Array.isArray(value?.options)?value.options:[]}catch{}if(!options.length)options=[{value:'read-only',name:${scriptJson(zh ? '只读（推荐起步）' : 'Read-only (recommended)')},description:${scriptJson(zh ? '适合先看看 AI 的动作' : 'Watch what the agent does first')}},{value:'workspace-write',name:${scriptJson(zh ? '工作区可写' : 'Workspace write')},description:${scriptJson(zh ? 'AI 可以改工作区里的文件' : 'The agent can edit files in the workspace')}},{value:'danger-full-access',name:${scriptJson(zh ? '完全放开' : 'Full access')},description:${scriptJson(zh ? '不再询问，直接执行' : 'Acts without asking')},danger:true}];if(plusView!=='permission')return;const rows=options.map(o=>({id:'preset:'+o.value,icon:PLUS_ICONS.permission,title:o.name||o.value,desc:o.description||'',danger:o.danger===true}));$('plusBody').innerHTML='<button class="plus-back" data-plus-back>'+PLUS_BACK_SVG+'<span>'+esc(L.plusBack)+'</span></button><div class="plus-section-title">'+esc(L.plusPermission)+'</div>'+rowHtml({id:'permission-current',icon:PLUS_ICONS.permission,title:L.plusCurrentPermission,desc:''})+rows.map(rowHtml).join('')}
// The sheet is a modal: focus moves into it on open and Tab cycles inside it, so a
// phone keyboard cannot walk behind the overlay. Declarative functions, because the
// page tests splice named functions out of this script.
function sheetFocusables(){const sheet=$('plusSheet');if(!sheet)return [];return [...sheet.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(el=>!el.closest('[hidden]'))}
function focusSheetStart(){const items=sheetFocusables();if(items.length)items[0].focus()}
function trapSheetFocus(event){const items=sheetFocusables();if(!items.length)return;const first=items[0],last=items[items.length-1],active=document.activeElement,inside=$('plusSheet').contains(active);if(event.shiftKey){if(active===first||!inside){event.preventDefault();last.focus()}}else if(active===last||!inside){event.preventDefault();first.focus()}}
function openPlus(){plusView='root';plusPreviousFocus=document.activeElement;$('plusFilter').value='';plusSetSearch(false);$('plusOverlay').hidden=false;$('plusSheet').hidden=false;requestAnimationFrame(()=>{$('plusOverlay').classList.add('open');$('plusSheet').classList.add('open');focusSheetStart()});$('plus').setAttribute('aria-expanded','true');renderPlusRoot()}
function closePlus(){const wasView=plusView;plusView='closing';$('plusOverlay').classList.remove('open');$('plusSheet').classList.remove('open');$('plus').setAttribute('aria-expanded','false');setTimeout(()=>{if(plusView==='closing'){plusView=wasView;$('plusOverlay').hidden=true;$('plusSheet').hidden=true;// Restore focus to the opener only if it is still connected and the user
// has not placed focus elsewhere in the meantime. Suppressed while a native
// file dialog is taking over: stealing focus dismisses it on phones.
const opener=plusPreviousFocus;plusPreviousFocus=null;const suppress=plusSuppressFocusReturn;plusSuppressFocusReturn=false;if(!suppress&&(document.activeElement===document.body||document.activeElement===null)){try{opener?.focus()}catch{}}}},230)}
async function runCommandLine(line){try{await rpc('command.execute',{sessionId:activeSession,line});await loadHistory(false)}catch(e){showError('chatError',e,L.commandFailed)}}
function fillSlashCommand(name){closePlus();const prompt=$('prompt');prompt.value='/'+name+' ';syncPromptUi();prompt.focus()}
async function exportSession(){closePlus();showToast(L.plusExportRunning);try{const response=await fetch('/api/session-export?sessionId='+encodeURIComponent(activeSession),{cache:'no-store'});if(!response.ok)throw new Error(L.plusExportFailed+' ('+response.status+')');const blob=await response.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='session-'+String(activeSession||'export')+'.zip';a.rel='noopener';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);showToast(L.plusExportDone,2200)}catch(e){showError('chatError',e)}}
// The sheet belongs to the chat view: a row that arrives after the view came down
  // (a stale tap, or a back gesture that left the chat) has no session to act on.
function dispatchPlusRow(id){if(!activeSession)return;if(id==='file'){renderPlusFile();return}if(id==='pick-image'){plusSuppressFocusReturn=true;closePlus();$('filePickerImage').click();return}if(id==='pick-any'){plusSuppressFocusReturn=true;closePlus();$('filePickerAny').click();return}if(id==='goal'||id==='plan'||id==='feedback'){fillSlashCommand(id);return}if(id==='compact'){closePlus();void runCommandLine('/compact');return}if(id==='permission'){void renderPlusPermission();return}if(id==='permission-current'){closePlus();void runCommandLine('/permission');return}if(id.startsWith('preset:')){const name=id.slice('preset:'.length);closePlus();void runCommandLine('/permission '+name);return}if(id==='model'){closePlus();openSessionSettings();return}if(id==='export'){exportSession()}}
async function send(){const owner=activeSession;const promptEl=$('prompt'),text=promptEl.value.trim();const drafts=readyDrafts();if((!text&&!drafts.length)||!activeSession)return;if(composerDrafts.some(d=>d.status==='uploading')){showToast(L.draftUploading);return}if(composerDrafts.some(d=>d.status==='failed')){showToast(L.draftFailed);return}validateImagesReady();const commandName=slashExecuteName(text);const parts=attachmentParts();const sendMethod=commandName?'command.execute':'session.prompt';if(parts.length&&encodedPromptBytes(text)>rpcBodyCeilingFor(sendMethod)-2048){showError('chatError',new Error(L.attachTooLarge));return}if(commandName&&!['goal','plan'].includes(commandName)&&parts.length){showToast(L.attachNotAccepted.replace('{command}',commandName));return}const sendMode=agentRunning?busyEnter:'queue';const summary=draftSummary(),afterSeq=latestEventSeq(),sameTextAtSend=currentTranscript().reduce((count,message)=>count+(message.role==='user'&&durableUserPromptText(message)===text?1:0),0);const optimistic={id:String(Date.now())+Math.random(),text,summary,sameTextAtSend,afterSeq};optimisticPrompts.push(optimistic);sessionBlank=false;armAwaitingTurn(afterSeq);agentRunning=true;syncSettingsControls();promptEl.value='';syncPromptUi();paintMessages(messagesWithOptimistic(currentTranscript()),true);lastHistoryKey='';try{if(commandName){await rpc('command.execute',{sessionId:activeSession,line:text,...(parts.length&&['goal','plan'].includes(commandName)?{submittedAttachments:submittedAttachmentParts()}:{})})}else{const content=[...(text?[{type:'text',text}]:[]),...parts];await rpc('session.prompt',{sessionId:activeSession,mode:sendMode,content,clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone})}if(activeSession!==owner)return;clearSentDrafts();await loadHistory(false)}catch(e){optimisticPrompts=optimisticPrompts.filter(item=>item.id!==optimistic.id);clearAwaitingTurn();agentRunning=false;const copy=attachFailureCopy(e);if(copy===L.attachTooLarge)e=new Error(copy);showError('chatError',e);if(activeSession!==owner)return;promptEl.value=text;paintMessages(messagesWithOptimistic(currentTranscript()),true);await refreshActiveSessionSummary().catch(()=>{})}finally{syncPromptUi();syncSettingsControls()}}
function formatBytes(n){n=Number(n)||0;if(n<1024)return n+' B';const units=['KB','MB','GB'];let v=n/1024,i=0;while(v>=1024&&i<units.length-1){v/=1024;i++}return v.toFixed(v<10?1:0)+' '+units[i]}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
// Slash menu: a "/" typed at a word boundary opens the merged catalog of host
// commands and skills. Host commands execute on the host (commands/execute,
// never reaching the model); skills stay plain text, because the skill tool
// intercepts the gesture in the prompt on the host side. Catalogs are cached
// briefly so typing does not refetch on every keystroke.
const SLASH_TTL_MS=1500;
let slashCommands=[],slashSkills=[],slashCatalogReady=false,slashCatalogFailed=false,slashCatalogAt=0,slashLoad=null,slashGesture=null,slashRows=[],slashActive=0;
function slashBoundaryOk(draft,index){if(index===0)return true;const prev=draft.charAt(index-1);if(/\\s/.test(prev))return true;if(/[\\p{L}\\p{N}_]/u.test(prev))return false;return prev!=='/'&&prev!==':'}
function slashGestureAt(draft,caret){for(let index=caret-1;index>=0;index--){const char=draft.charAt(index);if(char==='/'){if(!slashBoundaryOk(draft,index))return null;const query=draft.slice(index+1,caret);if(/\\s/.test(query))return null;return{start:index,query:query,leading:draft.search(/\\S/)===index}}if(/\\s/.test(char))return null}return null}
// The host parses a command line with this exact shape; the page must agree on
// what counts as a command name or the menu and the runtime drift apart.
function slashCommandName(line){const match=line.match(/^\\/([a-z][a-z0-9_-]*)(?=$|[\\t\\n\\r ])/u);return match?match[1]:null}
function slashHasArgs(line){const trimmed=line.trim();const name=slashCommandName(trimmed);return !!name&&trimmed.slice(name.length+1).trim().length>0}
// Decision table (mirrors the desktop composer): a catalogued command with an
// input hint runs with whatever the user typed; a bare no-input command runs;
// a no-input command carrying trailing text falls through to a normal message,
// exactly like the desktop Enter handler.
function slashExecuteName(text){const trimmed=text.trim();const name=slashCommandName(trimmed);if(!name)return null;if(!slashCatalogReady)return name;const command=slashCommands.find(item=>item&&item.name===name);if(!command)return null;if(command.input)return name;return slashHasArgs(trimmed)?null:name}
function slashCatalogExpired(){return Date.now()-slashCatalogAt>SLASH_TTL_MS}
async function loadSlashCatalogs(){if(slashCatalogReady&&!slashCatalogExpired())return;if(slashLoad)return slashLoad;const sessionId=activeSession;slashLoad=(async()=>{const answers=await Promise.all([rpc('commands.list',{sessionId:sessionId}).catch(()=>null),rpc('skills.list',{sessionId:sessionId}).catch(()=>null)]);if(activeSession!==sessionId)return;const commands=answers[0];// skills/list answers {skills:[…]}; commands/list answers the array itself.
const skills=answers[1]&&Array.isArray(answers[1].skills)?answers[1].skills:answers[1];if(Array.isArray(commands))slashCommands=commands.filter(item=>item&&typeof item==='object'&&typeof item.name==='string');if(Array.isArray(skills))slashSkills=skills.filter(item=>item&&typeof item==='object'&&typeof item.name==='string');if(Array.isArray(commands)||Array.isArray(skills)){slashCatalogReady=true;slashCatalogFailed=false;slashCatalogAt=Date.now()}else slashCatalogFailed=true})().finally(()=>{slashLoad=null});return slashLoad}
function slashBoundaryBonus(name,index){return index===0||name.charAt(index-1)==='-'||name.charAt(index-1)==='_'?8:0}
function slashAlignmentScore(name,query){if(query.length>name.length)return void 0;const noMatch=Number.NEGATIVE_INFINITY;let previous=Array(name.length).fill(noMatch);for(let index=0;index<name.length;index++)if(name.charAt(index)===query.charAt(0))previous[index]=1+slashBoundaryBonus(name,index)-index;for(let queryIndex=1;queryIndex<query.length;queryIndex++){const current=Array(name.length).fill(noMatch);let left=noMatch,leftLeft=noMatch,bestGapped=noMatch;for(const [index,prior] of previous.entries()){if(leftLeft!==noMatch)bestGapped=Math.max(bestGapped,leftLeft+index-2);if(name.charAt(index)===query.charAt(queryIndex)){const bonus=1+slashBoundaryBonus(name,index);let score=noMatch;if(left!==noMatch)score=left+bonus+4;if(bestGapped!==noMatch)score=Math.max(score,bestGapped+bonus+1-index);current[index]=score}leftLeft=left;left=prior}previous=current}let best=noMatch;for(const score of previous)best=Math.max(best,score);return best===noMatch?void 0:best}
function slashRankByName(items,rawQuery){const query=rawQuery.toLowerCase();if(query==='')return items;const ranked=[];items.forEach((item,index)=>{const keys=item.label===void 0?[item.name]:[item.name,item.label];let prefix=false,score;for(const key of keys){const lower=String(key).toLowerCase();const keyScore=slashAlignmentScore(lower,query);if(keyScore===void 0)continue;prefix=prefix||lower.startsWith(query);score=score===void 0?keyScore:Math.max(score,keyScore)}if(score!==void 0)ranked.push({item:item,index:index,prefix:prefix,score:score})});ranked.sort((left,right)=>Number(right.prefix)-Number(left.prefix)||right.score-left.score||left.index-right.index);return ranked.map(match=>match.item)}
function slashMergeRows(query){const commandRows=slashRankByName(slashCommands,query).map(item=>({name:item.name,kind:'command',desc:String(item.description||''),hint:item.input&&item.input.hint?String(item.input.hint):''}));const taken=new Set(commandRows.map(row=>row.name));const skillRows=slashRankByName(slashSkills,query).filter(item=>!taken.has(item.name)).map(item=>({name:item.name,kind:'skill',desc:String(item.description||''),hint:''}));return commandRows.concat(skillRows)}
function renderSlashMenu(){const host=$('slashMenu');if(!slashRows.length){host.innerHTML='<div class="slash-empty">'+esc(slashCatalogReady?L.slashEmpty:slashCatalogFailed?L.slashFailed:L.slashLoading)+'</div>';return}host.innerHTML=slashRows.map((row,index)=>'<button type="button" class="slash-row'+(index===slashActive?' active':'')+'" role="option" aria-selected="'+(index===slashActive)+'" data-slash-name="'+esc(row.name)+'" data-slash-kind="'+esc(row.kind)+'"><span class="slash-row-name">/'+esc(row.name)+'</span><span class="slash-row-desc">'+esc(row.desc||row.hint||'')+'</span><span class="slash-row-kind">'+esc(row.kind==='command'?L.slashKindCommand:L.slashKindSkill)+'</span></button>').join('')}
function hideSlashMenu(){$('slashMenu').hidden=true;slashGesture=null;slashRows=[];slashActive=0}
function refreshSlashMenu(){const prompt=$('prompt');const host=$('slashMenu');const gesture=slashGestureAt(prompt.value,prompt.selectionStart===null?prompt.value.length:prompt.selectionStart);slashGesture=gesture;if(!gesture||!activeSession){host.hidden=true;return}host.hidden=false;slashRows=slashMergeRows(gesture.query);slashActive=0;renderSlashMenu();if(!slashCatalogReady||slashCatalogExpired()){void loadSlashCatalogs().then(()=>{if(host.hidden)return;const current=slashGestureAt(prompt.value,prompt.selectionStart===null?prompt.value.length:prompt.selectionStart);if(!current)return;slashGesture=current;slashRows=slashMergeRows(current.query);slashActive=0;renderSlashMenu()})}}
function slashCaret(prompt){return prompt.selectionStart===null?prompt.value.length:prompt.selectionStart}
function insertSlashDraft(name){const prompt=$('prompt');const caret=slashCaret(prompt);const gesture=slashGestureAt(prompt.value,caret);const start=gesture?gesture.start:Math.max(0,prompt.value.lastIndexOf('/'));prompt.value=prompt.value.slice(0,start)+'/'+name+' '+prompt.value.slice(caret);const next=start+name.length+2;try{prompt.setSelectionRange(next,next)}catch{}syncPromptUi();hideSlashMenu();prompt.focus()}
function pickSlashRow(name,kind){if(kind==='command'){const command=slashCommands.find(item=>item&&item.name===name);if(command&&!command.input){const prompt=$('prompt');const caret=slashCaret(prompt);const gesture=slashGestureAt(prompt.value,caret);if(gesture){prompt.value=prompt.value.slice(0,gesture.start)+prompt.value.slice(caret);syncPromptUi()}hideSlashMenu();void runCommandLine('/'+name);return}}insertSlashDraft(name)}
function slashMenuKeydown(event){if($('slashMenu').hidden)return false;if(event.key==='Escape'){event.preventDefault();hideSlashMenu();return true}if(event.key==='ArrowDown'||event.key==='ArrowUp'){if(!slashRows.length)return false;event.preventDefault();slashActive=(slashActive+(event.key==='ArrowDown'?1:slashRows.length-1))%slashRows.length;renderSlashMenu();return true}if(event.key==='Enter'||event.key==='Tab'){const row=slashRows[slashActive];if(!row)return false;event.preventDefault();pickSlashRow(row.name,row.kind);return true}return false}
// Keyboard handling: only a real height change (keyboard show/hide) may resize
// the shell. visualViewport "scroll" fires many times while panning and must NOT
// relayout or fight the browser's own input scrolling (that was the focus jank).
let viewportRaf=0,lastAppHeight=0,viewportFillTimer=null
// Android/Chromium uses interactive-widget=resizes-content: the layout viewport
// (and 100dvh) resizes natively with the keyboard, so driving --app-height from
// visualViewport every frame double-relayouts and makes the composer stutter.
// Only Apple WebKit (which ignores interactive-widget) needs the JS height.
const appleTouchDevice=/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)
function applyViewportHeight(){viewportRaf=0;if(!appleTouchDevice)return;const viewport=window.visualViewport;const h=Math.round(viewport?.height||window.innerHeight);if(h&&h!==lastAppHeight){lastAppHeight=h;document.documentElement.style.setProperty('--app-height',h+'px')}}
// M21: a taller viewport (rotation, keyboard dismiss, split-screen change) leaves the
// transcript short of the bottom until the next stream event, and the fill loop only
// runs when something else calls it. Debounce once after the resize settles and ask it
// to top the viewport up. Feature-detected, not a driver: on a device whose layout
// viewport already tracks the keyboard this is a no-op whenever the transcript still
// overflows, and it never touches --app-height (that stays Apple-only above).
function scheduleViewportFill(){if(viewportFillTimer!==null)clearTimeout(viewportFillTimer);viewportFillTimer=setTimeout(()=>{viewportFillTimer=null;if(typeof ensureTranscriptFilled==='function')void ensureTranscriptFilled()},150)}
function scheduleViewport(){if(viewportRaf)return;if(!appleTouchDevice){scheduleViewportFill();return}viewportRaf=requestAnimationFrame(()=>{applyViewportHeight();scheduleViewportFill()})}
document.addEventListener('visibilitychange',()=>{if(document.hidden){hiddenAt=Date.now();clearTimeout(poll);poll=null;pauseEventPolling();return}const wasHiddenForMs=hiddenAt?Date.now()-hiddenAt:0;hiddenAt=0;idlePollMs=HISTORY_POLL_IDLE_MS;syncComposerHeight();reopenRealtime();if(activeSession)void loadHistory(false);else void resumeOnReturn(wasHiddenForMs);void checkConnection()});
window.addEventListener('pageshow',event=>{if(event.persisted&&!activeSession){const forMs=hiddenAt?Date.now()-hiddenAt:0;hiddenAt=0;void resumeOnReturn(forMs)}});
window.visualViewport?.addEventListener('resize',scheduleViewport);window.addEventListener('resize',scheduleViewport);applyViewportHeight();
history.replaceState({view:'sessions'},'');
// The server renders the chat view directly whenever it knows which session to
// open, so this entry gets adopted by the conversation. Keep a workspace entry
// underneath it: the in-app back button can compensate with history.length>1,
// but the browser's own edge swipe cannot — with a single entry a swipe leaves
// the app instead of returning to the workspace list (live report 2026-10-02).
if(document.body.classList.contains('chat-open'))history.pushState({view:'sessions'},'');
window.addEventListener('popstate',event=>handleHistory(event.state));
  $('workspaces').onclick=e=>{const card=e.target.closest('.ws-card');if(!card)return;const wsId=card.dataset.ws,btn=e.target.closest('button[data-action]');if(!btn)return;const action=btn.dataset.action;if(action==='new'){e.stopPropagation();void createSessionIn(wsId)}else if(action==='toggle'){if(expandedWsIds.has(wsId))expandedWsIds.delete(wsId);else expandedWsIds.add(wsId);renderWorkspaces()}else if(action==='open'){void openSession(btn.dataset.id)}};
  $('listRefresh').onclick=()=>{const btn=$('listRefresh');if(btn.classList.contains('spinning'))return;btn.classList.add('spinning');refreshList(true).finally(()=>{setTimeout(()=>btn.classList.remove('spinning'),400)})};
  // Pull-older: dragging down at the top edge loads the previous page. The list
  // follows the finger with resistance and springs back on release, and holds a
  // small offset while the page is in flight so the gesture stays acknowledged.
  // There is deliberately no ring above the list any more. Instead the hint row
  // above the list narrates the gesture itself: idle while pulling, armed once
  // releasing would accept, busy while a page is in flight, and when nothing
  // older can be asked for at all it names that end state instead of promising
  // a release that would fetch nothing.
  // The arming distance is short on purpose (live report 2026-10-10): at 72px of
  // damped travel the reader had to overshoot ~144px of finger, and a hard flick
  // that landed on the top edge still answered "keep pulling". 26px arms past the
  // finger jitter, and arming is one-way within a drag — only pushing the finger
  // back above its own start point cancels it.
  (()=>{const box=$('messages'),hint=$('pullHint'),THRESHOLD=26,MAXPULL=88,HOLD=44;let active=false,startY=0,pulled=0,ready=false;
  function hintText(state){if(!hint)return;if(!state){hint.className='pull-hint';hint.textContent='';return}const inert=!olderHasMore&&(transcriptHasContent()||olderExhausted),busy=state==='loading'&&!inert,armed=!inert&&state==='armed';hint.className='pull-hint visible'+(busy?' loading':armed?' armed':'');const html='<span class="older-spin" aria-hidden="true"></span><span>'+esc(inert?transcriptHasContent()?L.olderStart:L.olderExhausted:busy?L.olderLoading:armed?L.pullRelease:L.pullHint)+'</span>';if(hint.innerHTML!==html)hint.innerHTML=html}
  function setPull(px){box.style.transform=px?'translateY('+px+'px)':''}
  function settle(){hintText('');box.classList.add('animating');setPull(0);setTimeout(()=>{if(!active)box.classList.remove('animating')},320)}
  box.addEventListener('touchstart',e=>{if(active||olderBusy||olderRunBusy)return;if(box.scrollTop>0)return;if(!olderHasMore&&!olderEvents.length&&transcriptHasContent())return;active=true;startY=e.touches[0].clientY;pulled=0;ready=false;hintText('');box.classList.remove('animating');box.classList.add('pulling')},{passive:true});
  box.addEventListener('touchmove',e=>{if(!active)return;const dy=e.touches[0].clientY-startY;if(dy<=0){if(pulled){pulled=0;ready=false;setPull(0);hintText('')}return}pulled=Math.min(dy*.5,MAXPULL);if(pulled>=THRESHOLD)ready=true;hintText(ready?'armed':'idle');setPull(pulled)},{passive:true});
  function end(){if(!active)return;active=false;box.classList.remove('pulling');if(!ready||!olderHasMore&&(transcriptHasContent()||olderExhausted)){settle();return}ready=false;box.classList.add('animating');setPull(HOLD);hintText('loading');void loadOlder().finally(settle)}
  box.addEventListener('touchend',end,{passive:true});box.addEventListener('touchcancel',end,{passive:true});
  box.addEventListener('transitionend',()=>{if(!active)box.classList.remove('animating')})})();
  $('messages').onclick=e=>{const older=e.target.closest('[data-older]');if(older&&!older.disabled){void loadOlder();return}if(e.target.closest('[data-reload]')){$('messages').innerHTML=loadingShell();void loadHistory(true,true)}}
  // ---- Scroll follow + dual anchors (2026-10-07-feat-pocket-smart-scroll-anchors).
  // followStream IS the state machine: while the reader sits within
  // SCROLL_FOLLOW_PX of the bottom the transcript sticks to every paint; one
  // scroll that leaves that band unlocks it, and only an explicit jump back (the
  // ↓ button, a send, or scrolling home) re-arms it. The decisions live in named
  // organs so the tests can run the table without a browser; this block only
  // wires them to the DOM. A touch drag produces scroll events like any other
  // scroll, so there is deliberately no separate touchmove listener.
  const SCROLL_FOLLOW_PX=120,JUMP_EDGE_PX=4,CV_TAIL_KEEP=8,JUMP_PROMPT_PAD_PX=54;
  let followStream=true,anchorSyncQueued=false,topEdgeArmed=true;
  function transcriptDistance(box){return box.scrollHeight-box.scrollTop-box.clientHeight}
  function isNearBottom(box){return transcriptDistance(box)<=SCROLL_FOLLOW_PX}
  function userAnchorEl(box){const rows=box.querySelectorAll(':scope > .message.user');for(let index=rows.length-1;index>=0;index-=1){const row=rows[index];if(anchorTopOf(box,row)<box.scrollTop-JUMP_EDGE_PX)return row}return null}
  function anchorTopOf(box,anchor){return anchor.getBoundingClientRect().top-box.getBoundingClientRect().top+box.scrollTop}
  // Each button is gated on ITS OWN target and neither displaces the other (the old
  // mutual exclusion swapped the identity of the tile mid-gesture: same spot,
  // opposite destination). ↑ is the nearest question ABOVE the fold, so it stays as
  // long as there is somewhere left to climb to — it used to demand a full screen of
  // separation and vanished the moment the reader passed his last question. ↓ still
  // waits ANCHOR_LATEST_SCREENS because it jumps to the very end, and both keep the
  // 2026-10-09 gate that nothing lights on the bottom screen however tall the answer
  // is. Screens, not pixels: one pixel count cannot mean "the reader left" on a tall
  // transcript and a short one alike.
  // SUPERSEDES the two paragraphs above (user, 2026-10-10: 「别搞这么复杂了…统一时间逻辑」):
  // ONE gate for both buttons, opening the moment the reader leaves the follow band and
  // closing when they are back in it. ↓ = back to the bottom. ↑ = the message YOU sent above
  // me, and because the jump lands that question inside the viewport, the next press finds
  // the one above it — N presses walk back N of your own messages. No lead-in distance for
  // ↓, no full-screen separation for ↑ (that clause is what made ↑ keep vanishing).
  function anchorVisibleState(dist,anchorAbove){const away=dist>SCROLL_FOLLOW_PX;return{latest:away,prompt:away&&!!anchorAbove}}
  function syncScrollAnchors(){const latest=$('jumpLatest'),prompt=$('jumpPrompt'),box=$('messages');if(!latest||!prompt||!box)return;const state=anchorVisibleState(transcriptDistance(box),!!userAnchorEl(box)||olderHasMore===true);latest.classList.toggle('show',state.latest);prompt.classList.toggle('show',state.prompt)}
  // content-visibility tagging: everything but the last CV_TAIL_KEEP messages is
  // history the browser may skip rendering until scrolled to. The tail stays
  // untagged so the streaming edge (and the jump targets beside it) never
  // re-estimate its height mid-scroll.
  function markHistoryTail(messages){const count=Array.isArray(messages)?messages.length:0,keep=typeof CV_TAIL_KEEP==='number'?CV_TAIL_KEEP:8;for(let i=0;i<count;i+=1){const message=messages[i];if(message)message._history=i<count-keep}}
  // A fling that lands on the top edge is itself the request to read older
  // messages, so it loads a page without asking for a second, careful drag
  // (2026-10-10). Edge-triggered: the latch only re-arms after the reader has
  // actually left the top, so one arrival fetches one page — and the scroll
  // restore inside fetchOlderPage moves scrollTop off zero by itself, so the
  // page the reader was looking at never jumps under them.
  function topEdgePull(box){if(box.scrollTop>0){topEdgeArmed=false;return}if(topEdgeArmed)return;topEdgeArmed=true;if(!activeSession||!olderHasMore||olderBusy||olderRunBusy)return;void loadOlder()}
  (()=>{const box=$('messages');if(!box)return;box.addEventListener('scroll',()=>{if(anchorSyncQueued)return;anchorSyncQueued=true;requestAnimationFrame(()=>{anchorSyncQueued=false;const live=$('messages');if(!live)return;followStream=isNearBottom(live);syncScrollAnchors();topEdgePull(live)})},{passive:true})})();
  // content-visibility estimates materialize as the jump scrolls history rows into
  // view for the first time — and the real layout lands a few frames AFTER the
  // jump, so an immediate re-measure would still read the estimate and stop early
  // (observed live: the anchor settled ~91px low). The jump therefore re-aims on
  // a short timer, against the materialized layout, until the anchor sits at the
  // pad or the tries run out.
  function settlePromptJump(box,anchor,tries){if(!anchor.isConnected||tries<=0)return;const delta=anchor.getBoundingClientRect().top-box.getBoundingClientRect().top-JUMP_PROMPT_PAD_PX;if(Math.abs(delta)>2){box.scrollTop=Math.max(0,Math.round(box.scrollTop+delta));setTimeout(()=>settlePromptJump(box,anchor,tries-1),100)}}
  $('scrollAnchors').onclick=e=>{const btn=e.target.closest('.anchor-fab');if(!btn)return;const box=$('messages');if(!box)return;if(btn.id==='jumpLatest'){followStream=true;box.scrollTop=box.scrollHeight;syncScrollAnchors();return}const anchor=userAnchorEl(box);if(!anchor){if(olderHasMore)void loadOlder();return}followStream=false;box.scrollTop=Math.max(0,Math.round(anchorTopOf(box,anchor)-JUMP_PROMPT_PAD_PX));settlePromptJump(box,anchor,4);syncScrollAnchors()};
  // ---- Image/file capability, client half (2026-10-07-feat-pocket-image-file-capability).
  // Per-session memory of the local paths this conversation's own event stream
  // surfaced (deliverables/presented files and markdown images in assistant
  // text). Only these are rewritten to /api/session-file URLs — a path the
  // session never showed renders as the plain text it arrived as, and the
  // bridge re-checks the same rule server-side before serving any bytes. The
  // sets live in memory like the other client caches and are never logged.
  const SESSION_PATH_SETS_MAX=8,SESSION_PATH_ENTRIES_MAX=400,SESSION_FILE_HEAL_MAX=200,ATTACH_PREVIEW_CACHE_MAX=8,ATTACH_PREVIEW_LINE_CAP=200;
  const sessionFilePaths=new Map(),sessionFileHealTried=new Set(),attachPreviewCache=new Map();
  function knownPathsOf(sessionId){return sessionFilePaths.get(sessionId)}
  function noteSessionPaths(events){const sessionId=activeSession;if(!sessionId||!Array.isArray(events)||!events.length)return;let set=sessionFilePaths.get(sessionId);if(!set){set=new Set();sessionFilePaths.set(sessionId,set);while(sessionFilePaths.size>SESSION_PATH_SETS_MAX)sessionFilePaths.delete(sessionFilePaths.keys().next().value)}for(const entry of events){const e=(entry&&(entry.event||entry))||{},d=e.data||{},t=String(e.type||'').toLowerCase();if(t==='deliverables/presented'){const files=Array.isArray(d.files)?d.files:[];for(const f of files){if(set.size>=SESSION_PATH_ENTRIES_MAX)return;if(f&&typeof f.path==='string'&&f.path)set.add(f.path)}continue}if(t!=='assistant/message')continue;const message=d.message||d,content=Array.isArray(message.content)?message.content:[];for(const block of content){if(!block||block.type!=='text'||typeof block.text!=='string')continue;const imageRe=/!\\[([^\\]]*)\\]\\((?:<([^>]*)>|([^)\\s]+))\\)/g;let match;while((match=imageRe.exec(block.text))){if(set.size>=SESSION_PATH_ENTRIES_MAX)return;const path=match[2]||match[3]||'';if(path)set.add(path)}}}}
  // The lightbox: one fixed overlay for full-screen images (tap the picture to
  // switch between fit and full-size; the two-level zoom replaces a gesture
  // library) and for full text previews. The 100dvh height keeps iOS Safari
  // honest inside position:fixed.
  const lightboxState={mode:null,blobUrl:null};
  function lightboxOpen(){return !$('lightbox').hidden}
  function lightboxResetBlob(){if(lightboxState.blobUrl){URL.revokeObjectURL(lightboxState.blobUrl);lightboxState.blobUrl=null}}
  function openLightboxImage(src,name){const box=$('lightbox'),img=$('lightboxImg');box.classList.remove('zoomed');lightboxState.mode='image';lightboxResetBlob();$('lightboxText').hidden=true;$('lightboxText').textContent='';$('lightboxCopy').hidden=true;img.hidden=false;img.removeAttribute('src');img.src=src;img.alt=name||'image';$('lightboxName').textContent=name||'';const save=$('lightboxSave');save.hidden=false;save.setAttribute('href',src);save.setAttribute('download',name||'image');box.hidden=false}
  function openLightboxText(text,name){const box=$('lightbox'),img=$('lightboxImg');box.classList.remove('zoomed');lightboxState.mode='text';img.hidden=true;img.removeAttribute('src');const pre=$('lightboxText');pre.hidden=false;pre.textContent=String(text??'');$('lightboxName').textContent=name||'';$('lightboxCopy').hidden=false;$('lightboxSave').hidden=false;lightboxResetBlob();lightboxState.blobUrl=URL.createObjectURL(new Blob([String(text??'')],{type:'text/plain'}));const save=$('lightboxSave');save.setAttribute('href',lightboxState.blobUrl);save.setAttribute('download',name||'file.txt');box.hidden=false}
  function closeLightbox(){const box=$('lightbox');if(box.hidden)return;box.hidden=true;box.classList.remove('zoomed');lightboxState.mode=null;lightboxResetBlob();$('lightboxImg').removeAttribute('src');$('lightboxText').textContent='';$('lightboxSave').removeAttribute('href')}
  async function copyTextToClipboard(text){try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);return true}}catch{}try{const box=document.createElement('textarea');box.value=text;box.setAttribute('readonly','');box.style.position='fixed';box.style.left='-9999px';document.body.appendChild(box);box.select();const ok=document.execCommand('copy');box.remove();return ok}catch(e){return false}}
  // Inline preview of a textual attachment: the panel is DOM-local (tap the card
  // again to fold it), the fetched text is cached per attachment so a transcript
  // repaint re-renders it without a second download, and 200 lines is where the
  // inline copy stops — the lightbox carries the rest.
  function attachPreviewUrl(attachmentId){return '/api/session-attachment?sessionId='+encodeURIComponent(activeSession)+'&attachmentId='+encodeURIComponent(attachmentId)}
  function truncatePreviewLines(text){const lines=String(text??'').replace(/\\r\\n?/g,'\\n').split('\\n');if(lines.length<=ATTACH_PREVIEW_LINE_CAP)return{text:lines.join('\\n'),more:0};return{text:lines.slice(0,ATTACH_PREVIEW_LINE_CAP).join('\\n'),more:lines.length-ATTACH_PREVIEW_LINE_CAP}}
  function toggleFilePreview(button){const host=button.parentElement;if(!host)return;const existing=host.querySelector('.attach-preview');if(existing){existing.remove();return}const attachmentId=button.dataset.filePreview||'',name=button.dataset.fileName||L.fileChip;if(!attachmentId||!activeSession)return;const panel=document.createElement('div');panel.className='attach-preview';panel.innerHTML='<pre></pre><div class="attach-preview-bar"><button type="button" data-preview-copy="'+esc(attachmentId)+'">'+esc(L.copy)+'</button><a data-preview-save href="'+esc(attachPreviewUrl(attachmentId))+'" download="'+esc(name)+'">'+esc(L.save)+'</a><button type="button" data-preview-all="'+esc(attachmentId)+'">'+esc(L.viewAll)+'</button><span class="attach-preview-state"></span></div>';host.appendChild(panel);const pre=panel.querySelector('pre'),state=panel.querySelector('.attach-preview-state');const fill=function(full){const cut=truncatePreviewLines(full);pre.textContent=cut.text;state.textContent=''};const cached=attachPreviewCache.get(attachmentId);if(cached!==undefined){fill(cached);return}state.textContent=L.previewLoading;fetch(attachPreviewUrl(attachmentId)).then(r=>{if(!r.ok)throw new Error(String(r.status));return r.text()}).then(text=>{attachPreviewCache.set(attachmentId,text);while(attachPreviewCache.size>ATTACH_PREVIEW_CACHE_MAX)attachPreviewCache.delete(attachPreviewCache.keys().next().value);if(panel.isConnected)fill(text)}).catch(()=>{if(panel.isConnected)state.textContent=L.previewFailed})}
  // A markdown/presented image the bridge still answers 404 to (LAN realtime
  // paints it before the next history poll reaches the bridge) falls back to the
  // literal path once, and nudges one history refetch so the allowlist catches
  // up and the next paint renders the picture for real.
  function healSessionFile(path){if(!activeSession)return;const key=activeSession+':'+path;if(sessionFileHealTried.has(key))return;sessionFileHealTried.add(key);while(sessionFileHealTried.size>SESSION_FILE_HEAL_MAX)sessionFileHealTried.delete(sessionFileHealTried.keys().next().value);lastHistoryKey='';schedulePoll()}
  $('lightbox').addEventListener('click',e=>{if(e.target.closest('.lightbar'))return;if(lightboxState.mode==='image'){if(e.target.tagName==='IMG'){$('lightbox').classList.toggle('zoomed');return}closeLightbox();return}if(e.target.closest('[data-lightbox-stage]'))return;closeLightbox()});
  $('lightboxClose').onclick=()=>closeLightbox();
  $('lightboxCopy').onclick=async()=>{const ok=await copyTextToClipboard($('lightboxText').textContent);showToast(ok?L.copied:L.copyFailed)};
  $('messages').addEventListener('click',e=>{const img=e.target.closest('img[data-lightbox="image"]');if(img){openLightboxImage(img.getAttribute('src')||'',img.dataset.name||'image');return}const preview=e.target.closest('[data-file-preview]');if(preview){toggleFilePreview(preview);return}const all=e.target.closest('[data-preview-all]');if(all){const text=attachPreviewCache.get(all.dataset.previewAll);if(text!==undefined){const save=all.closest('.attach-preview')?.querySelector('[data-preview-save]');openLightboxText(text,(save&&save.getAttribute('download'))||'file.txt')}return}const copyBtn=e.target.closest('[data-preview-copy]');if(copyBtn){const text=attachPreviewCache.get(copyBtn.dataset.previewCopy);void copyTextToClipboard(text===undefined?'':text).then(ok=>showToast(ok?L.copied:L.copyFailed))}});
  document.addEventListener('error',e=>{const img=e.target;if(!img||img.tagName!=='IMG'||!img.dataset.path)return;const fallback=document.createElement('span');fallback.className='md-image-fallback';fallback.textContent=img.dataset.path;if(img.parentNode)img.parentNode.replaceChild(fallback,img);else img.remove();healSessionFile(img.dataset.path)},true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&lightboxOpen()){e.preventDefault();closeLightbox()}});
  $('settings').onclick=openSessionSettings;$('sessionSettings').onclick=e=>{const head=e.target.closest('[data-pick]'),row=e.target.closest('[data-value]');if(e.target.closest('[data-settings-close]')){closeSessionSettings();return}if(head){if(!head.disabled)togglePickField(head.dataset.pick);return}if(row)applyPick(row.parentElement.dataset.field,row.dataset.value)};$('todoDock').onclick=e=>{if(e.target.closest('.todo-header')){todoExpanded=!todoExpanded;renderTodoDock();lastHistoryKey='';paintMessages(messagesWithOptimistic(lastDurableMessages),false)}};$('queueDock').onclick=e=>{const btn=e.target.closest('[data-queue-action]');if(!btn)return;const action=btn.dataset.queueAction,id=btn.dataset.id;if(action==='edit')startQueueEdit(id);else if(action==='cancel')cancelQueueEdit();else if(action==='save')saveQueueEdit();else if(action==='remove')queueAction(id,{kind:'remove'},L.queueRemoveFailed);else if(action==='steer')queueAction(id,{kind:'steer'},L.queueSteerFailed)};$('queueDock').oninput=e=>{if(!e.target.matches('[data-queue-edit-text]'))return;queueEditText=e.target.value;const save=$('queueDock').querySelector('[data-queue-action=save]');if(save)save.disabled=!queueEditText.trim()};$('goalBar').onclick=e=>{const btn=e.target.closest('[data-goal-action]');if(!btn)return;const action=btn.dataset.goalAction;if(action==='edit')startGoalEdit();else if(action==='cancel')cancelGoalEdit();else if(action==='save')saveGoalEdit();else if(action==='pause')goalAction('pause',L.goalPaused,L.goalActionFailed);else if(action==='resume')goalAction('resume',L.goalResumed,L.goalActionFailed);else if(action==='clear')goalAction('clear',L.goalCleared,L.goalActionFailed)};$('goalBar').oninput=e=>{if(!e.target.matches('[data-goal-edit-text]'))return;goalEditText=e.target.value;const save=$('goalBar').querySelector('[data-goal-action=save]');if(save)save.disabled=!goalEditText.trim()};$('goalBar').onkeydown=e=>{if(e.target.matches('[data-goal-edit-text]')&&e.key==='Escape'){e.preventDefault();cancelGoalEdit()}};$('send').onclick=send;$('chatError').onclick=e=>dismissChatNotice(e.currentTarget,e);chatErrorTapZone=true;$('plus').onclick=()=>{if($('plusSheet').hidden)openPlus();else closePlus()};$('plusOverlay').onclick=closePlus;// Esc closes the sheet only while it is actually open; a sheet on a
// non-root view (file/permission) falls back to the root list first.
document.addEventListener('keydown',e=>{if(e.key==='Tab'&&plusOpen()){trapSheetFocus(e);return}if(e.key!=='Escape'||!plusOpen())return;e.preventDefault();if(plusView==='root'||plusView==='closing')closePlus();else if(plusView==='permission'||plusView==='file'){plusView='root';plusSetSearch(false);renderPlusRoot()}});$('plusSearchOpen').onclick=()=>plusShowSearch();$('plusSearchCancel').onclick=()=>plusHideSearch();$('plusFilter').oninput=()=>{if(plusView==='root')renderPlusRoot()};$('plusBody').onclick=e=>{const back=e.target.closest('[data-plus-back]');if(back){plusView='root';plusSetSearch(false);renderPlusRoot();return}const row=e.target.closest('[data-plus-row]');if(row)dispatchPlusRow(row.dataset.plusRow)};$('draftStrip').onclick=e=>{const rm=e.target.closest('[data-draft-remove]');if(rm){removeDraft(rm.dataset.draftRemove);return}const retry=e.target.closest('[data-draft-retry]');if(retry)retryDraft(retry.dataset.draftRetry)};$('draftStrip').onkeydown=e=>{if(e.key!=='Enter'&&e.key!==' ')return;const retry=e.target.closest('[data-draft-retry]');if(!retry)return;e.preventDefault();retryDraft(retry.dataset.draftRetry)};$('filePickerImage').onchange=e=>{try{addImageDrafts(e.target.files)}catch(err){showError('chatError',err)}e.target.value=''};$('filePickerAny').onchange=e=>{addFileDrafts(e.target.files);e.target.value=''};$('prompt').oninput=()=>{syncPromptUi();refreshSlashMenu()};$('prompt').onblur=()=>{setTimeout(()=>{if(!$('slashMenu').hidden)hideSlashMenu()},160)};$('slashMenu').onmousedown=e=>{e.preventDefault()};$('slashMenu').onclick=e=>{const row=e.target.closest('[data-slash-name]');if(row)pickSlashRow(row.dataset.slashName,row.dataset.slashKind)};$('prompt').onkeydown=e=>{if(slashMenuKeydown(e))return;if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();send()}};$('back').onclick=()=>{if(history.state?.view==='chat'&&history.length>1)history.back();else showSessionList()};$('cancel').onclick=async()=>{if(!activeSession||stopPending)return;stopPending=true;syncPromptUi();syncTurnStatus();try{clearAwaitingTurn();await rpc('session.cancel',{sessionId:activeSession})}catch(e){stopPending=false;syncPromptUi();syncTurnStatus();showError('chatError',e)}finally{lastHistoryKey='';await loadHistory(false)}};$('questionComposer').onclick=e=>{const option=e.target.closest('[data-option-index]');if(option&&pendingQuestion&&!questionBusy){const question=pendingQuestion.questions[questionIndex],draft=questionDraft(question),label=question.options[Number(option.dataset.optionIndex)]?.label;if(label){draft.skipped=false;if(question.multiSelect)draft.selected=draft.selected.includes(label)?draft.selected.filter(item=>item!==label):[...draft.selected,label];else{draft.selected=[label];draft.custom=''}renderQuestionComposer()}return}const action=e.target.closest('[data-question-action]')?.dataset.questionAction;if(action==='continue')advanceQuestion(false);else if(action==='skip')advanceQuestion(true);else if(action==='cancel')cancelQuestionRequest();else if(action==='previous'&&pendingQuestion){const question=pendingQuestion.questions[questionIndex],draft=questionDraft(question);draft.custom=String($('questionCustom')?.value||'').trim();questionIndex=Math.max(0,questionIndex-1);renderQuestionComposer()}};$('questionComposer').oninput=e=>{if(e.target.id==='questionCustom'&&pendingQuestion){const question=pendingQuestion.questions[questionIndex],draft=questionDraft(question);draft.custom=e.target.value;if(!question.multiSelect&&draft.custom.trim()){draft.selected=[];$('questionComposer').querySelectorAll('.question-option.selected').forEach(option=>{option.classList.remove('selected');const control=option.querySelector('.option-control');if(control)control.textContent=''})}}};$('questionComposer').onkeydown=e=>{if(e.target.id==='questionCustom'&&e.key==='Enter'&&(e.metaKey||e.ctrlKey)&&!e.isComposing&&e.keyCode!==229){e.preventDefault();advanceQuestion(false)}};document.addEventListener('click',e=>{if(!$('sessionSettings').hidden&&!e.target.closest('#sessionSettings')&&!e.target.closest('#settings'))closeSessionSettings()});document.addEventListener('keydown',e=>{if(e.key==='Escape')closeSessionSettings()});
let unreachableStreak=0,tunnelExpiryTimer=null;
function showUnreachableOverlay(){let host=$('unreachable');if(!host){host=document.createElement('div');host.id='unreachable';host.style.cssText='position:fixed;inset:0;z-index:9;display:grid;place-items:center;padding:24px;background:color-mix(in srgb,var(--paper) 88%,transparent)';host.innerHTML='<div style="max-width:320px;text-align:center"><strong style="font-size:20px">'+${scriptJson(zh ? '连接已断开' : 'Connection lost')}+'</strong><p style="color:var(--muted);line-height:1.6">'+L.unreachableOverlay+'</p><a href="/disconnected" style="display:inline-block;margin-top:18px;padding:11px 22px;border-radius:12px;background:var(--ink);color:var(--paper);text-decoration:none;font-weight:600">'+${scriptJson(zh ? '重新连接' : 'Reconnect')}+'</a></div>';document.body.appendChild(host)}host.hidden=false}
function hideUnreachableOverlay(){const host=$('unreachable');if(host)host.hidden=true}
// The dot is eight pixels of colour; the reader beside it says the same thing in words,
// which is also what an 8px circle with only an aria-label cannot do on its own.
function setStatusCopy(text){const el=$('statusText');if(el)el.textContent=text||''}
// The status payload carries a tunnel expiry only while the desktop is actually
// reachable through one, which is how a dropped stream tells a dead link apart from a
// restarted desktop.
function renderTunnelWarning(expiresAt){tunnelLinkActive=typeof expiresAt==='number'&&expiresAt>Date.now();const host=$('tunnelWarn');if(!host)return;if(!expiresAt){host.hidden=true;document.body.classList.remove('tunnel-warn-open');return}const minutes=Math.max(0,Math.ceil((expiresAt-Date.now())/60000));host.textContent=L.tunnelWarn.replace('{n}',String(minutes));const show=minutes>0;host.hidden=!show;document.body.classList.toggle('tunnel-warn-open',show)}
function formatDeviceExpiryTime(expiresAt){const d=new Date(expiresAt);const p=(n)=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())}
function renderDeviceExpiry(body){const el=document.getElementById('deviceExpiry');if(!el)return;if(body&&typeof body.expiresAt==='number'){el.textContent=L.deviceExpiry.replace('{time}',formatDeviceExpiryTime(body.expiresAt));el.hidden=false}else{el.textContent='';el.hidden=true}}
async function checkConnection(){if(document.hidden)return;if(Date.now()-lastLiveStatusAt<8000)return;const status=$('status');try{const response=await fetch('/api/status',{cache:'no-store'});status.classList.remove('connecting','error-state');if(response.ok){unreachableStreak=0;hideUnreachableOverlay();let body={};try{body=await response.json()}catch{}
// Same three states as the stream frames: an ok answer whose payload says the
// desktop is not answering is yellow, everything else here stays green/red.
const degraded=body.hostReachable===false;status.classList.toggle('degraded',degraded);if(degraded){status.setAttribute('aria-label',L.statusDegraded);setStatusCopy(L.statusDegraded)}else{status.setAttribute('aria-label',L.statusConnected);setStatusCopy(streamDownNoticeShown?L.statusReconnecting:L.statusConnected)}if(typeof setConnectionMode==='function'&&typeof body.connectionMode==='string')setConnectionMode(body.connectionMode);applyInheritedSettings(body.settings);renderTunnelWarning(typeof body.tunnelExpiresAt==='number'?body.tunnelExpiresAt:undefined);renderDeviceExpiry(body)}else{if(response.status===401){location.replace('/disconnected');return}status.classList.remove('degraded');status.classList.add('error-state');clearTransientError('listError');clearTransientError('chatError');status.setAttribute('aria-label',L.statusDisconnected);setStatusCopy(L.statusDisconnected);unreachableStreak+=1;if(unreachableStreak>=3)showUnreachableOverlay()}}catch{status.classList.remove('connecting','degraded');status.classList.add('error-state');clearTransientError('listError');clearTransientError('chatError');status.setAttribute('aria-label',L.statusDisconnected);setStatusCopy(L.statusDisconnected);unreachableStreak+=1;if(unreachableStreak>=3)showUnreachableOverlay()}}
// Started after the state below is declared: checkConnection() reads
// lastLiveStatusAt on its first line, so calling it before that declaration
// would throw a TDZ ReferenceError (swallowed as an unhandled rejection).
let handoffBoot=null,handoffPainted=false,lastLiveStatusAt=0,noServiceWorker=false;
// A browser that refused the shell worker once (the phone does: /sw.js 404s)
// must not pay a failed registration on every open — the shell is only ever a
// bonus here, never a requirement.
try{noServiceWorker=sessionStorage.getItem('${POCKET_NO_SW_KEY}')==='1'}catch{}
setInterval(checkConnection,5000);checkConnection();
// Read (and consume) the payload the pairing page left in this tab. Consumed on
// purpose: a later reload must fetch its own, not repaint a stale one.
function takeHandoffBoot(){try{const raw=sessionStorage.getItem('${POCKET_BOOT_KEY}');if(!raw)return null;sessionStorage.removeItem('${POCKET_BOOT_KEY}');const parsed=JSON.parse(raw);if(parsed&&parsed.ws&&parsed.sess){handoffBoot=parsed;return parsed}}catch{}return null}
// The handoff payload is a full page of records; the stream's opening snapshot
// only has to bring what is newer than it (the bridge drops the rest), and the
// paint it just produced is fresh enough to skip the 900ms fallback fetch.
function noteHandoffCoverage(boot){const events=boot&&boot.focus&&boot.focus.history?boot.focus.history.events:null;if(!Array.isArray(events)||!events.length)return;const top=events.reduce((max,entry)=>Math.max(max,eventSeq(entry)),-1);streamWatermarks.set(boot.focus.sessionId,top);if(top>=0)handoffPainted=true}
// Connection state rides the live stream, so the poll is only a safety net.
// Three states: a frame that carries hostReachable:false says the tunnel is up
// but the desktop is not answering — yellow, not green and not red. Frames
// without the field (older payloads) keep painting green exactly as before.
function applyLiveStatus(body){lastLiveStatusAt=Date.now();unreachableStreak=0;hideUnreachableOverlay();const status=$('status');if(status){status.classList.remove('connecting','error-state');const degraded=body.hostReachable===false;status.classList.toggle('degraded',degraded);if(degraded){status.setAttribute('aria-label',L.statusDegraded);setStatusCopy(L.statusDegraded)}else{status.setAttribute('aria-label',L.statusConnected);setStatusCopy(L.statusConnected)}}if(typeof setConnectionMode==='function'&&typeof body.connectionMode==='string')setConnectionMode(body.connectionMode);applyInheritedSettings(body.settings);renderTunnelWarning(typeof body.tunnelExpiresAt==='number'?body.tunnelExpiresAt:undefined);renderDeviceExpiry(body)}
(async()=>{
  try{if('serviceWorker'in navigator&&!noServiceWorker){navigator.serviceWorker.register('/sw.js').catch(()=>{noServiceWorker=true;try{sessionStorage.setItem('${POCKET_NO_SW_KEY}','1')}catch{}})}
  const boot=takeHandoffBoot()||window.__POCKET_BOOT__;if(boot&&boot.ws&&boot.sess){applyBootData(boot);if(boot.focus&&boot.focus.history){embeddedFocus=boot.focus;noteHandoffCoverage(boot)}}else{await loadListData()}renderWorkspaces();const target=pickFocusSession();if(target){await openSession(target.sessionId,titleFor(target));provisionalSession=true}else if(document.body.classList.contains('chat-open'))void showSessionList();
  if(!handoffBoot)reconcileBoot()}catch(e){showError('listError',e)}})();
['click','touchstart','keydown'].forEach((type)=>document.addEventListener(type,()=>{provisionalSession=false},{once:true,passive:true}));
async function reconcileBoot(){try{const response=await fetch('/api/boot',{cache:'no-store'});if(!response.ok)return;const fresh=await response.json();if(!fresh||!fresh.ws||!fresh.sess)return;
  const previousFocus=pickFocusSession();
  applyBootData(fresh);renderWorkspaces();
  if(activeSession&&fresh.focus&&fresh.focus.history&&fresh.focus.sessionId===activeSession&&!$('messages').querySelector('.message')){embeddedFocus=fresh.focus;paintInstantSession(true)}
  if(!provisionalSession)return;
  const nextFocus=openableFocus(fresh.focus&&fresh.focus.sessionId?fresh.focus:pickFocusSession(),fresh.sess.items);
  // Reopen only on a genuine server-side focus change: same id, or the id the
  // startup just opened, keeps the live stream and its paint untouched.
  if(nextFocus&&nextFocus.sessionId&&nextFocus.sessionId!==previousFocus?.sessionId&&nextFocus.sessionId!==activeSession){embeddedFocus=fresh.focus&&fresh.focus.history?fresh.focus:null;await openSession(nextFocus.sessionId,titleFor(nextFocus),false,false);provisionalSession=true}
}catch{}}
// Reached only if the whole script parsed and ran. The page's bootstrap uses it
// to notice a mangled cached copy of this file and fetch a fresh one.
window.__pocketAppReady=true;
</script></body></html>`
}

// Both guided pages run the same handoff, so its organs are written once here:
// one bounded fetch, one dwell floor, one verify round trip. A fix to any of them
// cannot land on one page and miss the other.
function sharedStageScript() {
  return `const STEP_DWELL_MS=180,FETCH_TIMEOUT_MS=10000;
function withTimeout(promise,ms){let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),ms)});return Promise.race([promise,timeout.finally(()=>clearTimeout(timer))])}
function pinError(message){const error=new Error(message);error.pinMessage=message;return error}
// The tunnel consent gate (design #3c) sits before the authorized() pipeline
// and the pairing funnel never answers it, so the first /api/rpc after pairing
// comes back 303 /consent. fetch follows that redirect and x.json() chokes on
// the disclaimer HTML, which the stage then reported as an unreachable desktop.
// Flag it instead, so the caller can walk the browser through /consent once.
const rpc=async(method,payload={})=>{const x=await withTimeout(fetch('/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,payload})}),FETCH_TIMEOUT_MS);if(new URL(x.url).pathname==='/consent'){const e=new Error('');e.consentGate=true;throw e}const y=await x.json();if(!x.ok||!y.ok)throw new Error(y.error||'');return y.value};
// Monotone by design: the handoff runs its independent reads side by side, so the
// rows finish in arrival order and a late answer for an earlier row must never
// rewind the ladder.
const stageRunner=(setStep)=>{let high=0;return async(index,work)=>{const started=Date.now();const value=await work();const rest=STEP_DWELL_MS-(Date.now()-started);if(rest>0)await new Promise(r=>setTimeout(r,rest));if(index+1>high){high=index+1;setStep(index+1)}return value}};
async function verifyPin(pin){const r=await withTimeout(fetch('/pair/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin})}),FETCH_TIMEOUT_MS);const j=await r.json();if(r.status===429){const minutes=Math.max(1,Math.ceil(Number(j.retryAfter||r.headers.get('retry-after')||60)/60));throw pinError(T.rateLimited.replace('{n}',String(minutes)))}if(!j.ok)return{ok:false,rescan:Boolean(j.rescan||j.error==='expired')};return{ok:true,pending:j.pending===true,confirmId:j.confirmId,checkAfterMs:j.checkAfterMs}}
// #4a desktop confirmation: the desktop must approve the pairing before the
// phone may proceed. Polls /pair/pending until the entry is consumed; a
// transient fetch error keeps waiting (the server TTL answers expired on its
// own), the total wait is bounded. Denied and expired both fail with the form
// re-enabled.
const PAIR_CONFIRM_MAX_WAIT_MS=120000;
async function awaitPairConfirmation(verification){if(!verification||!verification.pending)return;const confirmId=String(verification.confirmId||'');let wait=Number(verification.checkAfterMs);wait=Number.isFinite(wait)&&wait>0?wait:2000;const deadline=Date.now()+PAIR_CONFIRM_MAX_WAIT_MS;for(;;){if(Date.now()>deadline)throw pinError(T.timeout);await new Promise(resolve=>setTimeout(resolve,wait));let j=null;try{const r=await withTimeout(fetch('/pair/pending?confirmId='+encodeURIComponent(confirmId),{cache:'no-store'}),FETCH_TIMEOUT_MS);j=await r.json()}catch{j=null}if(j&&j.approved)return;if(j&&j.pending===true)continue;throw pinError(j&&j.reason==='denied'?T.confirmDenied:T.expired)}}
async function showPinOnDesktop(){try{await fetch('/pair/retry',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})}catch{}}
`
}
export function renderMobileReconnectPage(
  locale,
  connectionMode = 'lan',
  options = {}
) {
  const zh = /^zh/i.test(String(locale || ''))
  const expired = options.expired === true
  const resumeUnavailable = options.resumeUnavailable === true
  const interactive = !expired && !resumeUnavailable
  const text = {
    title: zh ? '重新连接 DSH' : 'Reconnect DSH',
    heading: zh ? '连接已断开' : 'Connection lost',
    retry: zh ? '重新连接' : 'Reconnect',
    tunnelExit: zh ? '回电脑旁重新扫码' : 'Rescan at the computer',
    restoring: zh ? '正在恢复连接…' : 'Restoring connection…',
    pinHeading: zh ? '输入连接密码' : 'Enter pairing password',
    pinHint: zh ? '隧道仍可用。输入电脑上「pocket」显示的密码即可继续，不必重新扫码。' : 'This tunnel is still reachable. Enter the password shown in pocket on the computer.',
    pinSubmit: zh ? '连接' : 'Connect',
    showPin: zh ? '在电脑上查看密码' : 'Show password on the computer',
    invalid: zh ? '连接密码不正确。' : 'That pairing password is incorrect.',
    rateLimited: zh ? '尝试次数过多，请 {n} 分钟后再试。' : 'Too many attempts. Try again in {n} min.',
    confirmWait: zh ? '请在电脑上确认接入' : 'Approve on the desktop',
    confirmDenied: zh ? '桌面端已拒绝接入' : 'The desktop declined',
    unavailable: zh ? '暂时无法连接桌面端，请确认 DSH 正在运行。' : 'Cannot reach the desktop. Make sure DSH is running.',
    timeout: zh ? '网络超时，请检查手机网络后重试。' : 'Network timed out. Check your connection and retry.',
    openFailed: zh ? '页面打开失败，请点重新连接重试。' : 'Failed to open the page. Tap Reconnect to retry.',
    rescanHeading: zh ? '需要重新扫码' : 'Rescan required',
    rescanGuidance: zh ? '连接无法自动恢复。请回到电脑前，在「pocket」里扫描新的二维码。' : 'The connection cannot be restored automatically. Go back to the computer and scan the new QR code in pocket.',
    guidance: resumeUnavailable
      ? zh
        ? '这部手机没有可恢复的连接。请回到电脑前，扫描「pocket」里的新二维码。'
        : 'This phone has no saved connection. Go back to the computer and scan the new QR code.'
      : connectionMode === 'tunnel'
        ? expired
          ? zh
            ? '远程地址已失效，请在电脑上的「pocket」扫描新二维码。'
            : 'This remote address is no longer valid. Scan the new QR code in pocket on the computer.'
          : zh
            ? '隧道地址仍可用。输入电脑上显示的连接密码即可继续，不必重新扫码。'
            : 'This tunnel is still reachable. Enter the pairing password shown on the computer.'
        : zh
          ? '请确保手机和电脑连接到同一 Wi-Fi，系统将自动尝试重新连接。'
          : 'Stay on the same Wi-Fi — reconnection is attempted automatically.',
    lanRisk: zh
      ? '局域网模式采用明文 HTTP 传输，同一网络下存在被窃听风险；请仅在可信 Wi-Fi 下使用，需要保密时请使用云隧道。'
      : 'LAN mode uses plaintext HTTP and can be eavesdropped on the same network. Use it only on trusted Wi-Fi; switch to the cloud tunnel for privacy.',
    stepWorkspace: zh ? '正在同步工作区' : 'Syncing workspace',
    stepSessionList: zh ? '正在同步会话列表' : 'Syncing session list',
    stepSession: zh ? '正在同步会话内容' : 'Syncing conversation',
    stepPrepare: zh ? '正在准备页面' : 'Preparing page'
  }
  const nonceAttr = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : ''
  const arrowSvg = '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  // Terminal variants (expired tunnel / no saved session) have no automatic
  // recovery — a /reconnect link would just re-render the same dead page.
  // Tunnel mode can never resume on its own: the tunnel hostname rotates on
  // every desktop start and the session cookie is host-scoped, so /pair/retry
  // only ever answers pinRequired. A retry button there is dead UI sitting
  // next to the PIN box the phone actually needs.
  // The two wordmark routes sit behind the pairing gate, and this page's whole audience
  // is a phone that has not paired yet: it used to get a 401 and an empty header slot.
  // The bridge hands over a data URI when it has one; with nothing in hand the brand row
  // stays plain text, so even the half-finished state reads correctly instead of showing
  // a broken image.
  const icon = typeof options.icon === 'string' ? options.icon : null
  const brandRow = icon
    ? '<img src="' + icon + '" alt="" style="width:22px;height:22px;border-radius:5px;object-fit:cover"><span>DSH Pocket</span>'
    : '<span>DSH Pocket</span>'
  const showRetry = interactive && connectionMode !== 'tunnel'
  const action = showRetry
    ? `<button id="retryBtn" class="primary" type="button" data-action="retry" hidden>${text.retry}${arrowSvg}</button>`
    : ''
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme:light)"><meta name="theme-color" content="#141416" media="(prefers-color-scheme:dark)"><title>${text.title}</title><style>:root{color-scheme:light;--bg:#fff;--card:#fff;--panel:#f7f8fa;--ink:#18191c;--muted:#6b7076;--line:#e5e7eb;--brand:#4d6bfe;--danger:#c62f3c}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#141416;--card:#1d1d20;--panel:#202023;--ink:#f5f5f6;--muted:#95979d;--line:#303034;--brand:#6f86ff;--danger:#ff9ba1}}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:100%;max-width:340px;text-align:center}.brand{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:22px;font-size:13px;font-weight:600}h1{margin:0;font-size:28px;line-height:1.18;letter-spacing:-.03em}.guidance{margin:13px auto 0;max-width:310px;color:var(--muted);font-size:14px;line-height:1.65}.primary{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;height:50px;margin-top:26px;border:0;border-radius:15px;background:var(--ink);color:var(--bg);font:inherit;font-weight:650;text-decoration:none;cursor:pointer}#pinBox[hidden],#retryBtn[hidden]{display:none}input{width:100%;height:52px;margin-top:22px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink);text-align:center;font:28px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.28em}#pinSubmit{width:100%;height:44px;margin-top:12px;border:1px solid var(--ink);border-radius:12px;background:var(--ink);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}.quiet{width:100%;height:44px;margin-top:10px;border:0;border-radius:12px;background:transparent;color:var(--ink);font:inherit;cursor:pointer}.note{min-height:20px;margin-top:14px;padding:10px 12px;border-radius:10px;background:var(--panel);color:var(--danger);font-size:13px}.boot-steps{display:none;margin:18px auto 0;text-align:left}.boot-steps.show{display:block}.boot-step{display:flex;align-items:center;color:var(--muted);opacity:.4;font-size:14px;padding:6px 0;transition:opacity .2s ease,color .2s ease}.boot-step.is-active{opacity:1;color:var(--ink);font-weight:600}.boot-step.is-done{opacity:.6;color:var(--muted)}.boot-step.is-done .boot-step-label{text-decoration:line-through;text-decoration-color:var(--brand);text-decoration-thickness:1.5px}.boot-step.is-active::before{content:'';flex:none;width:13px;height:13px;margin-right:9px;border:2px solid var(--line);border-top-color:var(--brand);border-radius:50%;animation:rspin .7s linear infinite}.boot-step:not(.is-active){padding-left:22px}@keyframes rspin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.boot-step.is-active::before{animation:none}}#pinSubmit:disabled{opacity:.55;cursor:default}</style></head><body><main class="card"><div class="brand">${brandRow}</div><div id="content"><h1 id="heading">${text.heading}</h1><p class="guidance" id="guidance">${text.guidance}</p>${connectionMode !== 'tunnel' ? `<p class="guidance" style="margin-top:10px;font-size:12.5px">${text.lanRisk}</p>` : ''}<div id="pinBox" hidden><form data-form="pin"><input id="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="12" pattern="\\d{6,12}" required><button id="pinSubmit" type="submit">${text.pinSubmit}</button></form><button class="quiet" type="button" data-action="show-pin">${text.showPin}</button></div>${action}<div id="status" class="note" hidden></div><div id="bootSteps" class="boot-steps"></div></div></main>${interactive ? `<script${nonceAttr}>const T=${scriptJson(text)};const TUNNEL=${connectionMode === 'tunnel'};
const MODE='auto';
const SESSION_LIST_ROWS=${SESSION_LIST_PREFETCH};
const SHELL_ASSETS=${scriptJson(options.assets ?? null)};
${sharedStageScript()}
const $=id=>document.getElementById(id);
// The network starts warming on the first byte of this page (2026-10-10): the shell
// assets are the same for every pairing, so they come down alongside the retry round
// trip rather than after it, and the bridge warms its own session catalogue for the
// boot read below. Failure is silent — runStages simply re-asks for what is missing.
const shellReady=(async()=>{if(!SHELL_ASSETS)return;const urls=[SHELL_ASSETS.cssUrl,SHELL_ASSETS.jsUrl].filter(Boolean);await Promise.all(urls.map(async(url)=>{try{const res=await withTimeout(fetch(url),FETCH_TIMEOUT_MS);if(res.ok)await withTimeout(res.text(),FETCH_TIMEOUT_MS)}catch{}}))})().catch(()=>{});
function fail(msg){const status=$('status'),btn=$('retryBtn');status.textContent=msg;status.hidden=false;if(btn)btn.hidden=false;
  // Tunnel mode has no retry button (the tunnel hostname rotates on every desktop
  // start, so a retry can only answer pinRequired); what the phone needs instead is
  // the way back to a fresh QR code. Non-tunnel keeps the bare retry affordance.
  if(TUNNEL&&!$('tunnelExit')){const exit=document.createElement('a');exit.id='tunnelExit';exit.href='/disconnected';exit.textContent=T.tunnelExit;exit.style.cssText='display:inline-block;margin-top:14px;padding:11px 20px;border-radius:12px;background:var(--ink);color:var(--bg);text-decoration:none;font-weight:600';status.after(exit)}}
// Entry point: ask the bridge to restore the suspended session. The contract is
// {reconnected}|{pinRequired}|{rescan}|{redirectUrl}, one guided continuation
// per branch instead of dumping the user on a dead card.
async function startRetry(){const status=$('status'),btn=$('retryBtn');if(btn)btn.hidden=true;status.textContent=T.restoring;status.hidden=false;$('bootSteps').classList.remove('show');
  try{
    const r=await withTimeout(fetch('/pair/retry',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),FETCH_TIMEOUT_MS);
    const j=await r.json();
    if(!r.ok||!j.ok)throw new Error('http');
    if(j.redirectUrl){location.replace(j.redirectUrl);return}
    if(j.reconnected){await runStages();return}
    if(j.pinRequired){showPin();return}
    if(j.rescan){showRescan();return}
    throw new Error('payload');
  }catch(e){if(e&&e.consentGate){location.replace('/consent?next=/');return}fail(e&&e.message==='timeout'?T.timeout:T.unavailable)}}
function showPin(){$('heading').textContent=T.pinHeading;$('guidance').textContent=T.pinHint;const status=$('status');status.hidden=true;status.textContent='';$('pinBox').hidden=false;const btn=$('retryBtn');if(btn)btn.hidden=true;setTimeout(()=>{const el=$('pin');if(el&&document.activeElement!==el)el.focus()},60)}
// Static terminal branch: swap the interactive hosts for the rescan card.
function showRescan(){$('content').innerHTML='<h1>'+T.rescanHeading+'</h1><p class="guidance">'+T.rescanGuidance+'</p>'}
async function submitPin(event){event.preventDefault();const pin=$('pin').value.trim(),submit=$('pinSubmit'),status=$('status');submit.disabled=true;status.hidden=true;status.textContent='';
  try{
    const verification=await verifyPin(pin);
    if(!verification.ok){if(verification.rescan){showRescan();return}throw pinError(T.invalid)}
    // Same pending-pairing contract as the first-time PIN page: the desktop
    // must approve before the guided handoff may run.
    if(verification.pending){$('heading').textContent=T.confirmWait;await awaitPairConfirmation(verification);$('heading').textContent=T.pinHeading}
    await runStages();
  }catch(e){if(e&&e.consentGate){location.replace('/consent?next=/');return false}$('heading').textContent=T.pinHeading;fail(e&&e.pinMessage?e.pinMessage:(e&&e.message==='timeout'?T.timeout:T.unavailable));submit.disabled=false}
  return false}
// Same handoff stages as the first-time pairing page: real round trips per row,
// boot payload stashed for the app document, assets warmed, then replace('/').
async function runStages(){const stepsHost=$('bootSteps'),status=$('status');status.hidden=true;status.textContent='';
  const labels=[T.stepWorkspace,T.stepSessionList,T.stepSession,T.stepPrepare];
  stepsHost.innerHTML=labels.map((label,i)=>'<div class="boot-step'+(i===0?' is-active':'')+'"><span class="boot-step-label">'+label+'</span></div>').join('');
  stepsHost.classList.add('show');
  const stepEls=[...stepsHost.children];
  const setStep=(n)=>stepEls.forEach((el,i)=>{el.classList.toggle('is-done',i<n);el.classList.toggle('is-active',i===n)});
  const stage=stageRunner(setStep);
  let shell=null;
  // One tunnel crossing, not three (2026-10-10): the three reads are independent and
  // the bridge dedupes the session catalogue itself, so they go out together and the
  // rows light in arrival order (stageRunner only ever advances).
  await Promise.all([stage(0,()=>rpc('workspace.list')),stage(1,()=>rpc('session.list',{limit:SESSION_LIST_ROWS})),stage(2,async()=>{try{const response=await withTimeout(fetch('/api/boot',{cache:'no-store'}),FETCH_TIMEOUT_MS);if(!response.ok)throw new Error('boot');const raw=await withTimeout(response.text(),FETCH_TIMEOUT_MS);const parsed=JSON.parse(raw);if(parsed&&parsed.ws&&parsed.sess){sessionStorage.setItem('${POCKET_BOOT_KEY}',raw);shell=parsed.assets||null}}catch{}})]);
  await stage(3,async()=>{const extra=shell&&shell!==SHELL_ASSETS?[shell.cssUrl,shell.jsUrl].filter(Boolean):[];
    const extraReady=Promise.all(extra.map(async(url)=>{try{const res=await withTimeout(fetch(url),FETCH_TIMEOUT_MS);if(res.ok)await withTimeout(res.text(),FETCH_TIMEOUT_MS)}catch{}}));
    await Promise.race([Promise.all([shellReady,extraReady]),new Promise(r=>setTimeout(r,12000))]);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))});
  setTimeout(()=>fail(T.openFailed),4000);
  location.replace('/')}
document.addEventListener('click',(event)=>{const el=event.target.closest('[data-action]');if(!el||el.disabled)return;if(el.dataset.action==='retry')startRetry();else if(el.dataset.action==='show-pin')showPinOnDesktop()});
document.addEventListener('submit',(event)=>{if(event.target.matches('form[data-form="pin"]')){event.preventDefault();submitPin(event)}});
if(MODE==='auto')startRetry();
</script>` : ''}</body></html>`
}

/**
 * @param {DesktopPairingPageOptions} options
 * @returns {string}
 */
export function renderDesktopPairingPage(options) {
  const zh = /^zh/i.test(String(options.locale || ''))
  const text = {
    title: zh ? '连接移动设备' : 'Connect Mobile Device',
    heading: zh ? '连接移动设备' : 'Connect a mobile device',
    lanHint: zh
      ? '扫码即可连接。移动设备与电脑需连接至同一 WiFi，同步实时性高。'
      : 'Scan to connect. Keep the phone and computer on the same WiFi.',
    tunnelHint: zh
      ? '移动设备通过互联网（如 4G/5G 或其他WiFi网络等）均可远程操控，同步实时性中等'
      : 'Control remotely over the internet, including 4G/5G or other WiFi networks, with moderate real-time responsiveness.',
    tunnelLoading: zh ? '正在创建全球网络链接' : 'Creating a global network link',
    lanLoading: zh ? '正在切换至 WiFi 连接模式' : 'Switching to WiFi connection mode',
    urlPendingTunnel: zh ? '网络链接生成中…' : 'Generating network link…',
    urlPendingLan: zh ? 'WiFi 链接生成中…' : 'Generating WiFi link…',
    modeLan: zh ? 'WiFi连接模式' : 'WiFi Connection Mode',
    modeTunnel: zh ? '互联网连接模式' : 'Internet Connection Mode',
    manageHeading: zh ? '管理手机连接' : 'Manage phone connection',
    manageHint: zh ? '这台手机当前已连接到 DSH。' : 'Your phone is currently connected to DSH.',
    connected: zh ? '手机已连接' : 'Phone connected',
    closeHint: zh ? '连接会在后台保持，现在可以关闭此窗口。' : 'The connection stays active in the background. You can close this window now.',
    done: zh ? '完成' : 'Done',
    disconnect: zh ? '断开连接' : 'Disconnect',
    qrLabel: zh ? '配对二维码' : 'Pairing QR code',
    copy: zh ? '复制' : 'Copy',
    copied: zh ? '已复制' : 'Copied',
    pinLabel: zh ? '连接密码' : 'Pairing password',
    pinHintTemp: zh ? '5 分钟内有效，过期后需重新扫码。' : 'Valid for 5 minutes. Scan again after it expires.',
    pinHintDurable: zh ? '长效密码保存在本机，可随时重置或取消。' : 'Kept on this computer. Reset or cancel anytime.',
    pinConsent: zh ? '生成长期有效的连接密码' : 'Remember a durable pairing password',
    pinPrivacy: zh
      ? '长效密码只保存在本机，不上云、不写入二维码，可随时重置或取消。'
      : 'The durable password stays on this computer. It is not uploaded or added to the QR code.',
    pinReset: zh ? '重置密码' : 'Reset password',
    pinCancel: zh ? '取消长效密码' : 'Turn off durable password',
    pinClosed: zh ? '远程连接已断开，请重新开启。' : 'The remote connection dropped. Turn it back on.',
    expiresMinutes: zh ? '约 {n} 分钟后失效' : 'Expires in about {n} min',
    expiresSeconds: zh ? '{n} 秒后失效' : 'Expires in {n}s',
    expired: zh ? '二维码已过期，正在自动刷新…' : 'QR expired. Refreshing automatically…',
    qrRefresh: zh ? '刷新二维码' : 'Refresh QR code',
    tunnelError: zh ? '隧道建立失败：' : 'Tunnel failed: ',
    
    lanRisk: zh
      ? '局域网模式采用明文 HTTP 传输，同一网络下存在被窃听风险；请仅在可信 Wi-Fi 下使用，需要保密时请使用云隧道。'
      : 'LAN mode uses plaintext HTTP and can be eavesdropped on the same network. Use it only on trusted Wi-Fi; switch to the cloud tunnel for privacy.',
    revoke: zh ? '吊销' : 'Revoke',
    revokeConfirm: zh ? '吊销后该手机需重新配对。确认吊销？' : 'This phone must pair again after revocation. Revoke?',
    revokeArmed: zh ? '确认吊销' : 'Confirm revoke',
    notifyHeading: zh ? '任务通知' : 'Task notifications',
    notifyChannelLabel: zh ? '通知渠道' : 'Channel',
    notifyChannelOff: zh ? '关' : 'Off',
    notifyKeyLabel: zh ? '推送密钥' : 'Push key',
    notifyEnabled: zh ? '启用通知' : 'Enable notifications',
    notifySave: zh ? '保存' : 'Save',
    notifyTest: zh ? '发送测试' : 'Send test',
    notifySaved: zh ? '已保存' : 'Saved',
    notifyTestSent: zh ? '测试已发送' : 'Test sent',
    notifyTestFailed: zh ? '测试发送失败' : 'Test failed',
    notifySaveFailed: zh ? '保存失败' : 'Save failed',
    clawbotLabel: zh ? '微信 ClawBot' : 'WeChat ClawBot',
    clawbotScanBtn: zh ? '扫码绑定微信' : 'Scan to bind WeChat',
    clawbotRebindBtn: zh ? '重新扫码绑定' : 'Re-scan to bind',
    clawbotResetBtn: zh ? '解除绑定' : 'Unbind',
    clawbotStatusBound: zh ? '已绑定微信：{u}' : 'Bound WeChat: {u}',
    clawbotStatusReady: zh ? '通道就绪' : 'Ready',
    clawbotStatusNeedMsg: zh ? '需在微信发任意消息激活' : 'Send message in WeChat to activate',
    clawbotScanHint: zh ? '请用手机微信扫描二维码授权' : 'Please scan QR code in WeChat',
    clawbotScanned: zh ? '已扫码，请在微信中点击确认授权…' : 'Scanned, please confirm in WeChat…',
    clawbotActivated: zh ? '授权成功！请在微信中向机器人发送任意文字（如发“1”）以激活通道…' : 'Authorized! Send any message in WeChat to activate…',
    clawbotQrFailed: zh ? '获取二维码失败，请重试' : 'Failed to get QR code, please retry',
    tunnelConfigHeading: zh ? '固定域名（命名隧道）' : 'Fixed hostname (named tunnel)',
    tunnelTokenLabel: zh ? '隧道 Token' : 'Tunnel token',
    tunnelHostnameLabel: zh ? '固定域名' : 'Hostname',
    tunnelIngressHint: zh ? '固定域名（命名隧道）模式下，Zero Trust 面板 ingress 须指向 http://127.0.0.1:<桥端口>（端口见桥启动日志 online 行）' : 'With a fixed hostname (named tunnel), the Zero Trust ingress must point at http://127.0.0.1:<bridge-port> (see the online line in the bridge startup log)',
    tunnelConfigSaved: zh ? '已保存' : 'Saved',
    tunnelConfigFailed: zh ? '保存失败' : 'Save failed',
    pairRequest: zh ? '待确认接入' : 'Pending pairings',
    pairAllow: zh ? '允许' : 'Allow',
    pairDeny: zh ? '拒绝' : 'Deny',
    modeDevices: zh ? '设备与通知' : 'Devices & alerts',
    modeDevicesFull: zh ? '设备与通知' : 'Devices & alerts',
    devFingerprint: zh ? '指纹' : 'Fingerprint',
    devFirstPaired: zh ? '首次配对' : 'First paired',
    devCredExpiry: zh ? '凭证到期' : 'Credential expires',
    devLastSeen: zh ? '最后上线' : 'Last seen',
    devNeverSeen: zh ? '未记录' : 'never',
    devPermLan: zh ? '仅本地' : 'LAN only',
    devPermWan: zh ? '本地+公网' : 'LAN + public',
    devPermBadge: zh ? '通道权限：{v}' : 'Access: {v}',
    devMakeLan: zh ? '切为仅本地' : 'Restrict to LAN',
    devMakeWan: zh ? '开启公网' : 'Allow public',
    devExtend: zh ? '延长30天' : 'Extend 30 days',
    devExtendDone: zh ? '已延长 30 天' : 'Extended by 30 days',
    devPermDone: zh ? '权限已更新' : 'Access updated',
    devRevokeDone: zh ? '已吊销' : 'Revoked',
    devActionFailed: zh ? '操作失败' : 'Action failed',
    devOnline: zh ? '在线' : 'online',
    devOffline: zh ? '离线' : 'offline',
    devCredExpired: zh ? '{d}（已过期）' : '{d} (expired)',
    devEmpty: zh ? '还没有已配对的设备。' : 'No paired devices yet.',
    devLoading: zh ? '正在读取设备列表…' : 'Loading the device list…',
    devFailed: zh ? '设备列表读取失败。' : 'Failed to load the device list.',
    devRetry: zh ? '重试' : 'Retry',
    devicesHint: zh ? '管理已连接的手机，并配置任务通知的推送渠道。' : 'Manage connected phones and configure task notification channels.'
  }
  const pinHintRemaining =
    !options.pinConsent && options.pinExpiresAt
      ? Math.max(0, Math.ceil((options.pinExpiresAt - Date.now()) / 1000))
      : 0
  const initialPinHint = options.pinConsent
    ? text.pinHintDurable
    : text.pinHintTemp + (pinHintRemaining ? ` (${pinHintRemaining}s)` : '')
  // Landing on 公网 (the middle tab) by default: the phone is reached over the
  // internet in every real session here, so the LAN tab was one click deep for a
  // mode nobody uses. When the tunnel has not started there is nothing to encode,
  // so the QR is withheld and the address line says so — the alternative is a LAN
  // URL sitting under a "公网" heading, which reads as a working public link.
  const modeView = options.connected ? 'devices' : 'tunnel'
  const publicPending = modeView === 'tunnel' && !options.tunnelActive
  const devicePanelHtml = `<div id="devicePanel" class="device-panel${modeView === 'devices' ? ' show' : ''}"><div id="deviceList" class="device-list"></div></div>`
  const notifyConfigOption = options.notifyConfig || {}
  const notifyChannel = typeof notifyConfigOption.channel === 'string' ? notifyConfigOption.channel : 'off'
  const tunnelConfigOption = options.tunnelConfig || {}
  const pendingPairingItems = Array.isArray(options.pendingPairings) ? options.pendingPairings : []
  const pendingPairingCard = (item) => {
    const left = Math.max(0, Math.ceil(((Number(item.expiresAt) || 0) - Date.now()) / 1000))
    return `<div class="pair-request"><div class="pair-request-copy"><strong>${escapeHtml(item.label || '')}</strong><span>${escapeHtml(item.remoteAddress || '')} · ${left}s</span></div><div class="pin-actions"><button type="button" data-action="pair-approve" data-id="${escapeHtml(item.id || '')}">${text.pairAllow}</button><button type="button" data-action="pair-deny" data-id="${escapeHtml(item.id || '')}">${text.pairDeny}</button></div></div>`
  }
  const panelSectionsHtml = `<div id="deviceExtras"${modeView === 'devices' ? ' show' : ''}><div id="notifyPanel" class="pin-panel show"><div class="pin-label">${text.notifyHeading}</div><label class="config-field"><span>${text.notifyChannelLabel}</span><select id="notifyChannel" class="config-input"><option value="off"${notifyChannel === 'off' ? ' selected' : ''}>${text.notifyChannelOff}</option><option value="serverchan"${notifyChannel === 'serverchan' ? ' selected' : ''}>Server酱</option><option value="bark"${notifyChannel === 'bark' ? ' selected' : ''}>Bark</option><option value="wxpusher"${notifyChannel === 'wxpusher' ? ' selected' : ''}>WxPusher</option><option value="clawbot"${notifyChannel === 'clawbot' ? ' selected' : ''}>${text.clawbotLabel}</option></select></label><div id="clawbotPanel" class="clawbot-panel"${notifyChannel === 'clawbot' ? '' : ' hidden'}><div id="clawbotBoundInfo" class="pin-hint"></div><div class="pin-actions"><button type="button" id="clawbotBindBtn" data-action="clawbot-bind">${text.clawbotScanBtn}</button><button type="button" id="clawbotResetBtn" data-action="clawbot-reset" class="is-danger" hidden>${text.clawbotResetBtn}</button></div><div id="clawbotQrWrap" class="clawbot-qr" hidden><div id="clawbotQrSvg"></div><div id="clawbotQrHint" class="pin-hint" style="margin-top:6px"></div></div></div><label id="notifyKeyRow" class="config-field"${notifyChannel === 'clawbot' ? ' hidden' : ''}><span>${text.notifyKeyLabel}</span><input id="notifyKey" class="config-input" type="password" autocomplete="off" placeholder="${escapeHtml(notifyConfigOption.keyMasked || '')}"></label><label class="pin-consent"><input id="notifyEnabled" type="checkbox"${notifyConfigOption.enabled ? ' checked' : ''}><span>${text.notifyEnabled}</span></label><div class="pin-actions"><button type="button" data-action="notify-save">${text.notifySave}</button><button type="button" data-action="notify-test">${text.notifyTest}</button></div><div id="notifyStatus" class="pin-hint"></div></div></div><div id="tunnelConfigPanel" class="pin-panel${modeView === 'tunnel' ? ' show' : ''}"><div class="pin-label">${text.tunnelConfigHeading}</div><label class="config-field"><span>${text.tunnelTokenLabel}</span><input id="tunnelToken" class="config-input" type="password" autocomplete="off" placeholder="${escapeHtml(tunnelConfigOption.tokenMasked || '')}"></label><label class="config-field"><span>${text.tunnelHostnameLabel}</span><input id="tunnelHostname" class="config-input" type="text" value="${escapeHtml(tunnelConfigOption.hostname || '')}" placeholder="name.example.com" spellcheck="false"></label><div class="pin-hint">${escapeHtml(text.tunnelIngressHint)}</div><div class="pin-actions"><button type="button" data-action="tunnel-config-save">${text.notifySave}</button></div><div id="tunnelConfigStatus" class="pin-hint"></div></div>`
  const nonceAttr = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : ''
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${text.title}</title><style>
  :root{color-scheme:light;--bg:#fff;--surface:#fff;--panel:#f7f8fa;--ink:#18191c;--muted:#6b7076;--line:#e5e7eb;--brand:#4d6bfe;--danger:#c62f3c;--success-bg:#f2f8f4;--success-ink:#277347;--success-muted:#557565}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#141416;--surface:#1d1d20;--panel:#202023;--ink:#f5f5f6;--muted:#95979d;--line:#303034;--brand:#6f86ff;--danger:#ff9ba1;--success-bg:#17261d;--success-ink:#75c991;--success-muted:#8ab99a}}*{box-sizing:border-box}html,body{min-height:100%;background:var(--bg)}body{margin:0;color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:520px;margin:auto;padding:26px 32px 30px;text-align:center}.brand{display:flex;align-items:center;justify-content:center;gap:9px;font-weight:600;margin-bottom:14px}.brand img{width:39px;height:22px;object-fit:contain}.brand .dark-logo{display:none}@media(prefers-color-scheme:dark){.brand .light-logo{display:none}.brand .dark-logo{display:block}}h1{font-size:24px;line-height:1.25;font-weight:600;margin:0}p{margin:0;color:var(--muted)}
  .mode-panel{max-width:410px;margin:18px auto 0;padding:5px 8px 10px;border:1px solid var(--line);border-radius:15px;background:var(--panel)}
  .mode-switch{display:grid;grid-template-columns:1fr 1fr 1fr;width:100%;padding:3px;border-radius:11px;gap:3px}
  .mode-btn{min-width:0;height:34px;border:0;background:transparent;color:var(--muted);padding:0 10px;border-radius:9px;font-size:13px;font-weight:550;cursor:pointer;transition:background .15s,color .15s;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mode-btn.active{background:var(--surface);color:var(--ink);box-shadow:0 1px 4px rgba(0,0,0,.08)}
  .mode-btn:disabled{cursor:not-allowed;opacity:.5}.mode-btn.active:disabled{opacity:.72}
   .device-panel{display:none;margin-top:14px;max-width:410px;margin-left:auto;margin-right:auto}
   .device-panel.show{display:block}
   body.device-view .qr{display:none}
   body.device-view .url-row{display:none}
   body.device-view .expires{display:none}
   body.device-view #pinPanel{display:none}
   .device-card{border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:12px;margin-top:10px;text-align:left}
   .device-card.is-offline{opacity:.78}
   .device-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
   .device-card-name{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
   .device-badge{font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--line);color:var(--muted);flex:none}
   .device-badge.is-on{background:var(--success-bg);color:var(--success-ink);border-color:var(--success-ink)}
   .device-badge.is-warn{color:var(--brand);border-color:var(--brand)}
   .device-card-meta{margin:0 0 10px 0}
   .device-card-meta div{display:flex;gap:6px;font-size:12.5px;margin:3px 0}
   .device-card-meta dt{color:var(--muted);min-width:56px;flex:none}
   .device-card-meta dd{margin:0;color:var(--ink);word-break:break-all}
   .device-card-meta dd.is-expired{color:var(--danger)}
   .device-card-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
   .device-card-actions button{border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);padding:5px 10px;font-size:12px;cursor:pointer}
   .device-card-actions button:hover{background:var(--panel)}
   .device-card-actions button.is-danger{color:var(--danger);border-color:var(--danger)}
   .device-card-actions button.armed{background:var(--danger);color:var(--bg);border-color:var(--danger)}
   .device-card-actions button:disabled{opacity:.5;cursor:wait}
   .device-card .device-action-note{font-size:12px;color:var(--success-ink);margin-top:8px}
   .device-panel-empty,.device-panel-failed{display:none;align-items:center;justify-content:center;gap:8px;color:var(--muted);font-size:13px;margin-top:14px}
   .device-list.is-empty .device-panel-empty,.device-list.is-failed .device-panel-failed{display:flex}
   .device-panel-failed button{border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);padding:5px 12px;cursor:pointer}
  .connection{display:none;flex-direction:column;align-items:center;margin:24px auto 0;max-width:390px;padding:22px;border-radius:14px;background:var(--success-bg);color:var(--success-ink)}.connection.show{display:flex}.connection-title{font-size:16px;font-weight:600}.connection-title:before{content:'✓';display:inline-grid;place-items:center;width:24px;height:24px;margin-right:9px;border-radius:50%;background:#35a867;color:white}.connection-hint{max-width:310px;margin-top:8px;color:var(--success-muted);font-size:13px}.connection-actions{display:flex;gap:8px;margin-top:18px}.connection-actions button{min-width:94px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink);padding:8px 14px;cursor:pointer}.connection-actions .done{background:var(--ink);color:var(--bg);border-color:var(--ink)}.phone-connected .pairing-content{display:none}.manage-connected .connection-hint,.manage-connected .done{display:none}.manage-connected .connection-actions{margin-top:16px}
  .pairing-content{margin-top:16px}.qr{display:inline-flex;background:#fff;padding:12px;border:1px solid var(--line);border-radius:16px;margin:0 0 10px;min-width:244px;min-height:244px;align-items:center;justify-content:center;position:relative}
  .qr svg{width:220px;height:220px;display:block}
  .qr-loading{position:absolute;inset:0;background:rgba(255,255,255,.94);border-radius:16px;display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;font-size:13px;color:#18191c;font-weight:550}
  .qr-loading.show{display:flex}
  .loading-copy{display:flex;width:176px;align-items:center;justify-content:space-between;gap:12px}.loading-copy span:first-child{text-align:left}.loading-value{min-width:32px;text-align:right;color:#62666d;font-variant-numeric:tabular-nums}.tunnel-progress{width:176px;height:5px;overflow:hidden;border-radius:999px;background:#e5e7eb}.tunnel-progress span{display:block;width:0;height:100%;border-radius:inherit;background:var(--brand);transition:width .08s linear}@media(prefers-reduced-motion:reduce){.tunnel-progress span{transition:none}}
  .hint{min-height:38px;display:flex;align-items:center;justify-content:center;font-size:12.5px;line-height:1.55;max-width:370px;margin:7px auto 0;padding:0 5px}
  .url-row{display:flex;align-items:center;gap:8px;margin:10px auto 0;max-width:410px}.url{min-width:0;flex:1;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--panel);border-radius:9px;padding:9px 11px;text-align:left;white-space:normal;word-break:break-all}.url.is-pending{color:var(--muted);word-break:normal}.copy{position:relative;display:grid;place-items:center;width:28px;height:28px;flex:none;border:0;background:transparent;color:var(--muted);padding:0;cursor:pointer}.copy:hover{color:var(--ink)}.copy-icon{display:block}.copy-done{display:none;place-items:center;width:16px;height:16px;border-radius:50%;background:#35a867;color:#fff}.copy.copied .copy-icon{display:none}.copy.copied .copy-done{display:grid}.copy-done svg{display:block}.copy-tip{position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);background:#fff;color:#18191c;border-radius:6px;padding:5px 8px;font-size:12px;line-height:1.2;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.12);opacity:0;pointer-events:none}.copy-tip:after{content:'';position:absolute;left:50%;top:100%;transform:translateX(-50%);border:5px solid transparent;border-top-color:#fff}.copy:hover .copy-tip,.copy.copied .copy-tip{opacity:1}.lan-risk{max-width:340px;margin:10px auto 0;color:var(--muted);font-size:11.5px;line-height:1.6}
  .pin-panel{display:none;max-width:410px;margin:16px auto 0;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}.pin-panel.show{display:block}#deviceExtras{display:none}#deviceExtras.show{display:block}body.device-view #tunnelConfigPanel{display:none}.pin-label{color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}.pin-value{margin:8px 0 6px;font:40px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em}.pin-hint{color:var(--muted);font-size:12px}.pin-consent{display:flex;gap:8px;align-items:flex-start;margin-top:12px;text-align:left;font-size:13px}.pin-actions{display:flex;justify-content:center;gap:8px;margin-top:12px}.pin-actions[hidden]{display:none}.pin-actions button{border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink);padding:7px 12px;cursor:pointer}
  .tunnel-err{display:none;color:var(--danger);font-size:12px;margin:5px 7px 0}.tunnel-err.show{display:block}
  .expires{display:flex;align-items:center;justify-content:center;gap:5px;font-size:12px;margin-top:8px;color:var(--muted)}
  .expires-refresh{display:inline-grid;place-items:center;width:20px;height:20px;padding:0;border:0;background:transparent;color:var(--muted);cursor:pointer;border-radius:50%}
  .expires-refresh:hover{color:var(--ink)}
  .expires-refresh:disabled{opacity:.5;cursor:wait}
  .expires-refresh svg{width:13px;height:13px}
  .expires-refresh.spinning svg{animation:qrRefreshSpin .6s linear infinite}
  @keyframes qrRefreshSpin{to{transform:rotate(360deg)}}
  .config-field{display:block;margin-top:12px;text-align:left}
  .config-field>span{display:block;margin:0 2px 5px;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
  .config-input{width:100%;height:38px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink);padding:0 11px;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:normal}
  select.config-input{cursor:pointer}
  .pair-request{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;font-size:13px}
  .pair-request-copy{min-width:0;display:flex;flex-direction:column;text-align:left}
  .pair-request-copy span{color:var(--muted);font-size:12px}
  .clawbot-panel{margin-top:12px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);text-align:center}.clawbot-panel[hidden]{display:none}.clawbot-qr{display:flex;flex-direction:column;align-items:center;margin:10px auto 4px}.clawbot-qr[hidden]{display:none}.clawbot-qr svg{width:180px;height:180px;display:block}
  </style></head><body class="${options.connected ? 'phone-connected manage-connected device-view' : ''}"><div class="wrap"><div class="brand"><img class="light-logo" src="/brand-logo/light" alt=""><img class="dark-logo" src="/brand-logo/dark" alt=""><span>DSH Pocket</span></div><h1>${options.connected ? text.manageHeading : text.heading}</h1>
  <div class="mode-panel"><div class="mode-switch"><button id="btnLan" class="mode-btn${modeView === 'lan' ? ' active' : ''}" data-action="mode-lan"${options.connected ? ' disabled' : ''}>${text.modeLan}</button><button id="btnTunnel" class="mode-btn${modeView === 'tunnel' ? ' active' : ''}" data-action="mode-tunnel"${options.connected ? ' disabled' : ''}>${text.modeTunnel}</button><button id="btnDevices" class="mode-btn${modeView === 'devices' ? ' active' : ''}" data-action="mode-devices" title="${text.modeDevicesFull}">${text.modeDevices}</button></div><p class="hint" id="modeHint">${modeView === 'tunnel' ? text.tunnelHint : (modeView === 'devices' ? text.devicesHint : text.lanHint)}</p><div id="tunnelError" class="tunnel-err${options.tunnelActive && options.tunnelError ? ' show' : ''}">${options.tunnelActive && options.tunnelError ? text.tunnelError + escapeHtml(options.tunnelError) : ''}</div>${devicePanelHtml}</div>
  <div id="connection" class="connection${options.connected ? ' show' : ''}"><div class="connection-title">${text.connected}</div><p class="connection-hint">${text.closeHint}</p><div class="connection-actions"><button data-action="disconnect">${text.disconnect}</button><button class="done" data-action="done">${text.done}</button></div></div>
  <div class="pairing-content"><div id="qrContainer" class="qr"><div id="qrCode" role="img" aria-label="${text.qrLabel}">${publicPending ? '' : options.qrSvg}</div><div id="qrLoading" class="qr-loading${options.tunnelLoading ? ' show' : ''}"><div class="loading-copy"><span id="tunnelLoadingText">${text.tunnelLoading}</span><span id="tunnelProgressValue" class="loading-value">0%</span></div><div class="tunnel-progress" aria-hidden="true"><span id="tunnelProgressBar"></span></div></div></div><div class="url-row"><div class="url${publicPending ? ' is-pending' : ''}" id="url">${escapeHtml(publicPending ? text.urlPendingTunnel : options.pairingUrl)}</div><button type="button" id="copyBtn" class="copy" data-action="copy" aria-label="${text.copy}"><svg class="copy-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.25" y="5.25" width="7.5" height="7.5" rx="1.4" stroke="currentColor" stroke-width="1.3"/><path d="M3.75 10.25V3.75h6.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="copy-done" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2.4 6.2 4.7 8.5 9.6 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="copy-tip" id="copyTip">${text.copy}</span></button></div><p id="lanRisk" class="lan-risk"${options.tunnelActive ? ' hidden' : ''}>${text.lanRisk}</p><p class="expires"><span id="expiresText"></span><button type="button" id="qrRefreshBtn" class="expires-refresh" data-action="refresh" aria-label="${text.qrRefresh}" title="${text.qrRefresh}"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.6v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></p><div id="pinPanel" class="pin-panel${options.tunnelActive && options.pairingPin ? ' show' : ''}"><div class="pin-label">${text.pinLabel}</div><div id="pinValue" class="pin-value">${escapeHtml(options.pairingPin ?? '')}</div><p id="pinHint" class="pin-hint">${initialPinHint}</p><label class="pin-consent"><input id="pinConsent" type="checkbox" data-action="consent"${options.pinConsent ? ' checked' : ''}><span>${text.pinConsent}<br><small>${text.pinPrivacy}</small></span></label><div id="pinActions" class="pin-actions"${options.pinConsent ? '' : ' hidden'}><button type="button" data-action="reset">${text.pinReset}</button><button type="button" data-action="consent-off">${text.pinCancel}</button></div></div>${panelSectionsHtml}<div id="pendingPairings" class="pin-panel${pendingPairingItems.length ? ' show' : ''}" style="text-align:left">${pendingPairingItems.length ? `<div class="pin-label">${text.pairRequest}</div>${pendingPairingItems.map(pendingPairingCard).join('')}` : ''}</div></div></div>
  <script${nonceAttr}>let end=${options.expiresAt},pairingUrl=${scriptJson(options.pairingUrl)},T=${scriptJson(text)},tunnelActive=${Boolean(options.tunnelActive)},selectedTunnelTab=${modeView === 'tunnel' ? true : Boolean(options.tunnelActive)},tunnelProvider=${scriptJson(options.tunnelProvider??null)},phoneConnected=${options.connected},modeView=sessionStorage.getItem('pocketModeView')||${JSON.stringify(modeView)},modeSwitching=false,tunnelProgressTimer=null,tunnelProgressStartedAt=0,copyFeedbackTimer=null,pinConsent=${Boolean(options.pinConsent)},pinExpiresAt=${options.pinExpiresAt ?? 'null'};
  // D2 contract: notifyConfig / tunnelConfig / pendingPairings arrive verbatim
  // from the bridge; a key or token never travels in the clear — only the
  // masked placeholder the bridge already sent does.
  const notifyConfig=${scriptJson({channel:notifyChannel,enabled:!!notifyConfigOption.enabled,keyMasked:notifyConfigOption.keyMasked||'',clawbot:notifyConfigOption.clawbot||{bound:false,hasContext:false,userIdMasked:''}})},tunnelConfig=${scriptJson({tokenMasked:tunnelConfigOption.tokenMasked||'',hostname:tunnelConfigOption.hostname||''})};
  let pendingPairings=${scriptJson(pendingPairingItems)};
  let clawbotState=notifyConfig.clawbot||{bound:false,hasContext:false,userIdMasked:''},clawbotQrPollTimer=null,clawbotContextPollTimer=null;
  function renderClawbotView(){const panel=document.getElementById('clawbotPanel'),keyRow=document.getElementById('notifyKeyRow'),ch=document.getElementById('notifyChannel').value;if(!panel)return;const isClaw=ch==='clawbot';panel.hidden=!isClaw;if(keyRow)keyRow.hidden=isClaw;if(!isClaw)return;const infoEl=document.getElementById('clawbotBoundInfo'),bindBtn=document.getElementById('clawbotBindBtn'),resetBtn=document.getElementById('clawbotResetBtn');if(clawbotState.bound){const userText=clawbotState.userIdMasked||T.devOnline,statusText=clawbotState.hasContext?T.clawbotStatusReady:T.clawbotStatusNeedMsg;infoEl.textContent=T.clawbotStatusBound.replace('{u}',userText)+' · '+statusText;infoEl.style.color=clawbotState.hasContext?'var(--success-ink)':'var(--brand)';bindBtn.textContent=T.clawbotRebindBtn;resetBtn.hidden=false}else{infoEl.textContent='';bindBtn.textContent=T.clawbotScanBtn;resetBtn.hidden=true}}
  async function bindClawbot(){const wrap=document.getElementById('clawbotQrWrap'),svgEl=document.getElementById('clawbotQrSvg'),hintEl=document.getElementById('clawbotQrHint'),bindBtn=document.getElementById('clawbotBindBtn');clearInterval(clawbotQrPollTimer);bindBtn.disabled=true;hintEl.textContent=T.clawbotScanHint;try{const r=await fetch('/desktop/notify/clawbot/qr');const j=await r.json();if(!j.ok){hintEl.textContent=T.clawbotQrFailed+(j.error?' ('+j.error+')':'');return}svgEl.innerHTML=j.qrSvg;wrap.hidden=false;const qrcode=j.qrcode;clawbotQrPollTimer=setInterval(async()=>{try{const sr=await fetch('/desktop/notify/clawbot/status?qrcode='+encodeURIComponent(qrcode));const sj=await sr.json();if(sj.status==='scaned'){hintEl.textContent=T.clawbotScanned}else if(sj.bound||sj.status==='confirmed'){clearInterval(clawbotQrPollTimer);wrap.hidden=true;clawbotState.bound=true;renderClawbotView();hintEl.textContent=T.clawbotActivated;pollClawbotContext()}}catch{}},1500)}catch{hintEl.textContent=T.clawbotQrFailed}finally{bindBtn.disabled=false}}
  function pollClawbotContext(){clearInterval(clawbotContextPollTimer);let attempts=0;clawbotContextPollTimer=setInterval(async()=>{attempts++;if(attempts>60){clearInterval(clawbotContextPollTimer);return}try{const r=await fetch('/desktop/notify');const j=await r.json();if(j.ok&&j.clawbot){clawbotState=j.clawbot;renderClawbotView();if(clawbotState.hasContext)clearInterval(clawbotContextPollTimer)}}catch{}},2000)}
  async function resetClawbot(){clearInterval(clawbotQrPollTimer);clearInterval(clawbotContextPollTimer);document.getElementById('clawbotQrWrap').hidden=true;try{const r=await fetch('/desktop/notify/clawbot/reset',{method:'POST'});const j=await r.json();if(j.ok){clawbotState=j.clawbot||{bound:false,hasContext:false,userIdMasked:''};document.getElementById('notifyChannel').value=j.channel||'off';document.getElementById('notifyEnabled').checked=!!j.enabled;renderClawbotView()}}catch{}}
  // In a standalone /desktop window (dataelement) this closes the window; in
  // the host iframe it asks the parent to close the in-app modal.
  function donePairing(){
    try{
      if(window.parent&&window.parent!==window){
        window.parent.postMessage({source:'dsh-pocket',type:'done'},'*')
        return
      }
    }catch(e){}
    window.close()
  }
  async function copyUrl(){try{await navigator.clipboard.writeText(pairingUrl)}catch{return}const btn=document.getElementById('copyBtn'),tip=document.getElementById('copyTip');btn.classList.add('copied');tip.textContent=T.copied;clearTimeout(copyFeedbackTimer);copyFeedbackTimer=setTimeout(()=>{btn.classList.remove('copied');tip.textContent=T.copy},1800)}
  function escHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function formatTimestamp(v){const d=new Date(v),p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())}
  // #3a armed two-step revoke: the first tap only arms (3s bounce-back), the
  // second one within the window is what fires the POST.
  function disarmRevoke(button){clearTimeout(button._revokeTimer);button.dataset.armed='';button.classList.remove('armed');button.textContent=T.revoke;button.title=T.revokeConfirm;const note=button.parentElement&&button.parentElement.querySelector('[data-revoke-note]');if(note)note.remove()}
  async function revokeDevice(button){const id=button.dataset.id||'';if(button.dataset.armed!=='1'){button.dataset.armed='1';button.classList.add('armed');button.textContent=T.revokeArmed;clearTimeout(button._revokeTimer);button._revokeTimer=setTimeout(()=>disarmRevoke(button),3000);// The title alone is easy to hover past on a phone: say the consequence in
  // the row too while the button is armed, and take it back on disarm.
  if(button.parentElement&&!button.parentElement.querySelector('[data-revoke-note]')){const note=document.createElement('div');note.className='pin-hint';note.dataset.revokeNote='1';note.textContent=T.revokeConfirm;button.after(note)}return}
    button.disabled=true;try{const r=await fetch('/desktop/revoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId:id})});if(r.ok){const card=button.closest('.device-card');deviceNote(card,T.devRevokeDone);await poll();loadDevicePanel()}}catch{}finally{button.disabled=false;if(button.isConnected)disarmRevoke(button)}}
  // #4a pending pairings: re-rendered by poll() and by the 1s tick (countdown).
  function renderPendingPairings(list){pendingPairings=Array.isArray(list)?list:[];const host=document.getElementById('pendingPairings');if(!host)return;host.classList.toggle('show',pendingPairings.length>0);if(!pendingPairings.length){host.innerHTML='';return}host.innerHTML='<div class="pin-label">'+T.pairRequest+'</div>'+pendingPairings.map((item)=>{const left=Math.max(0,Math.ceil(((Number(item.expiresAt)||0)-Date.now())/1000));return '<div class="pair-request"><div class="pair-request-copy"><strong>'+escHtml(item.label||'')+'</strong><span>'+escHtml(item.remoteAddress||'')+' · '+left+'s</span></div><div class="pin-actions"><button type="button" data-action="pair-approve" data-id="'+escHtml(item.id||'')+'">'+T.pairAllow+'</button><button type="button" data-action="pair-deny" data-id="'+escHtml(item.id||'')+'">'+T.pairDeny+'</button></div></div>'}).join('')}
  async function pairConfirm(id,approve){try{await fetch('/desktop/pair/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,approve})})}catch{}await poll()}
  // #2 notification config: the key field never carries the stored key back —
  // an empty submit keeps the stored key, the masked placeholder is the only
  // echo of what is on file.
  async function saveNotifyConfig(){const statusEl=document.getElementById('notifyStatus');const body={channel:document.getElementById('notifyChannel').value,enabled:document.getElementById('notifyEnabled').checked};const key=document.getElementById('notifyKey').value.trim();if(key)body.key=key;try{const r=await fetch('/desktop/notify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(j.ok){statusEl.textContent=T.notifySaved;const keyInput=document.getElementById('notifyKey');keyInput.value='';keyInput.placeholder=j.keyMasked||notifyConfig.keyMasked;if(j.clawbot){clawbotState=j.clawbot;renderClawbotView()}}else{statusEl.textContent=T.notifySaveFailed+(j.error?' ('+j.error+')':'')}}catch{statusEl.textContent=T.notifySaveFailed}}
  async function testNotifyConfig(){const statusEl=document.getElementById('notifyStatus');try{const r=await fetch('/desktop/notify/test',{method:'POST'});const j=await r.json();statusEl.textContent=j.ok&&j.delivered?T.notifyTestSent:T.notifyTestFailed}catch{statusEl.textContent=T.notifyTestFailed}}
  async function saveTunnelConfig(){const statusEl=document.getElementById('tunnelConfigStatus');const body={};const token=document.getElementById('tunnelToken').value.trim(),hostname=document.getElementById('tunnelHostname').value.trim();if(token)body.token=token;if(hostname)body.hostname=hostname;try{const r=await fetch('/desktop/tunnel/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(j.ok){statusEl.textContent=T.tunnelConfigSaved;const tokenInput=document.getElementById('tunnelToken');tokenInput.value='';tokenInput.placeholder=j.tokenMasked||tunnelConfig.tokenMasked;if(typeof j.hostname==='string')document.getElementById('tunnelHostname').value=j.hostname}else{statusEl.textContent=T.tunnelConfigFailed+(j.error?' ('+j.error+')':'')}}catch{statusEl.textContent=T.tunnelConfigFailed}}
  function syncLanRisk(){const el=document.getElementById('lanRisk');if(el)el.hidden=tunnelActive}
  function syncModeControls(connected){phoneConnected=connected;const disabled=connected||modeSwitching;document.getElementById('btnLan').disabled=disabled;document.getElementById('btnTunnel').disabled=disabled}
  function syncModeSelection(view){document.getElementById('btnLan').classList.toggle('active',view==='lan');document.getElementById('btnTunnel').classList.toggle('active',view==='tunnel');document.getElementById('btnDevices').classList.toggle('active',view==='devices')}
  function setModeView(view){modeView=view;syncModeSelection(view);syncModeControls(phoneConnected);document.getElementById('devicePanel').classList.toggle('show',view==='devices');document.getElementById('deviceExtras').classList.toggle('show',view==='devices');document.getElementById('tunnelConfigPanel').classList.toggle('show',view==='tunnel');document.body.classList.toggle('device-view',view==='devices');const hint=document.getElementById('modeHint');if(hint)hint.textContent=view==='tunnel'?T.tunnelHint:(view==='devices'?T.devicesHint:T.lanHint)}
  function showDevicePanel(){setModeView('devices');loadDevicePanel()}
  function deviceState(device){return device.online ? T.devOnline : T.devOffline}
  function devicePermBadge(device){const lan = device.permission === 'lan';return lan ? T.devPermLan : T.devPermWan}
  function devicePermLabel(device){const lan = device.permission === 'lan';return lan ? T.devMakeWan : T.devMakeLan}
  function deviceCredLabel(device){const expired = device.expiresAt && device.expiresAt <= Date.now();return expired ? T.devCredExpired.replace('{d}',formatTimestamp(device.expiresAt)) : formatTimestamp(device.expiresAt)}
  function deviceFirstSeen(device){return device.firstPairedAt ? formatTimestamp(device.firstPairedAt) : T.devNeverSeen}
  function deviceLastSeen(device){return device.lastSeenAt ? formatTimestamp(device.lastSeenAt) : T.devNeverSeen}
  function deviceNote(card,text){if(!card)return;let note=card.querySelector('.device-action-note');if(!note){note=document.createElement('div');note.className='device-action-note';card.appendChild(note)}note.textContent=text}
   function deviceCardHtml(device){const expired = device.expiresAt && device.expiresAt <= Date.now();const hasId = Boolean(device.id);const permTarget = device.permission === 'lan' ? 'lan+wan' : 'lan';const actions = hasId ? '<div class="device-card-actions"><span class="device-badge is-warn">'+T.devPermBadge.replace('{v}',devicePermBadge(device))+'</span><button type="button" data-action="device-perm" data-id="'+escHtml(device.id||'')+'" data-target-perm="'+permTarget+'">'+escHtml(devicePermLabel(device))+'</button><button type="button" data-action="device-extend" data-id="'+escHtml(device.id||'')+'">'+escHtml(T.devExtend)+'</button><button type="button" data-action="revoke-device" class="is-danger" data-id="'+escHtml(device.id||'')+'">'+escHtml(T.revoke)+'</button></div>' : '';return '<div class="device-card'+(device.online?'':' is-offline')+'" data-device-id="'+escHtml(device.id||'')+'"><div class="device-card-head"><span class="device-card-name">'+escHtml(device.label||device.fingerprint||'')+'</span><span class="device-badge'+(device.online?' is-on':'')+'">'+deviceState(device)+'</span></div><dl class="device-card-meta"><div><dt>'+T.devFingerprint+'</dt><dd>'+escHtml(device.fingerprint||'')+'</dd></div><div><dt>'+T.devFirstPaired+'</dt><dd>'+escHtml(deviceFirstSeen(device))+'</dd></div><div><dt>'+T.devCredExpiry+'</dt><dd class="'+(expired?'is-expired':'')+'">'+escHtml(deviceCredLabel(device))+'</dd></div><div><dt>'+T.devLastSeen+'</dt><dd>'+escHtml(deviceLastSeen(device))+'</dd></div></dl>'+actions+'</div>'}
  async function loadDevicePanel(){const host=document.getElementById('deviceList');if(!host)return;host.innerHTML='';host.classList.remove('is-empty','is-failed');const loading=document.createElement('div');loading.className='device-panel-empty';loading.textContent=T.devLoading;host.appendChild(loading);try{const r=await fetch('/desktop/devices');const j=await r.json();const devices=Array.isArray(j.devices)?j.devices:(Array.isArray(j)?j:[]);if(devices.length){host.innerHTML=devices.map(deviceCardHtml).join('');host.classList.remove('is-empty')}else{const empty=document.createElement('div');empty.className='device-panel-empty';empty.textContent=T.devEmpty;host.appendChild(empty);host.classList.add('is-empty')}}catch(e){const failed=document.createElement('div');failed.className='device-panel-failed';failed.textContent=T.devFailed;const retry=document.createElement('button');retry.textContent=T.devRetry;retry.dataset.action='device-retry';failed.appendChild(retry);host.innerHTML='';host.appendChild(failed);host.classList.add('is-failed')}}
  function retryLoadDevicePanel(){loadDevicePanel()}
  async function extendDevice(button){const id=button.dataset.id||'';button.disabled=true;try{const r=await fetch('/desktop/device/extend',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId:id})});const j=await r.json();if(j.ok){const card=button.closest('.device-card');if(card){card.querySelector('[data-action="device-extend"]').textContent=T.devExtendDone}}else{button.textContent=T.devActionFailed}}catch{button.textContent=T.devActionFailed}finally{button.disabled=false}}
  async function togglePermission(button){const id=button.dataset.id||'';const card=button.closest('.device-card');const toLan = button.dataset.targetPerm === 'lan';button.disabled=true;try{const r=await fetch('/desktop/device/permission',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId:id,permission:toLan?'lan':'lan+wan'})});const j=await r.json();if(j.ok){if(card){const permBtn=card.querySelector('[data-action="device-perm"]');if(permBtn){permBtn.textContent=toLan?T.devMakeWan:T.devMakeLan;permBtn.dataset.targetPerm=toLan?'lan+wan':'lan'}const badge=card.querySelector('.device-badge.is-warn');if(badge)badge.textContent=T.devPermBadge.replace('{v}',toLan?T.devPermLan:T.devPermWan);deviceNote(card,T.devPermDone)}}else{button.textContent=T.devActionFailed}}catch{button.textContent=T.devActionFailed}finally{button.disabled=false}}
  function syncTunnelError(){const el=document.getElementById('tunnelError');el.classList.toggle('show',selectedTunnelTab&&!!el.textContent)}
  function setTunnelProgress(value){const progress=Math.max(0,Math.min(100,Math.round(value)));document.getElementById('tunnelProgressBar').style.width=progress+'%';document.getElementById('tunnelProgressValue').textContent=progress+'%'}
  function startTunnelProgress(enableTunnel){const loading=document.getElementById('qrLoading'),duration=enableTunnel?4500:800;clearInterval(tunnelProgressTimer);tunnelProgressStartedAt=Date.now();document.getElementById('tunnelLoadingText').textContent=enableTunnel?T.tunnelLoading:T.lanLoading;setTunnelProgress(0);loading.classList.add('show');tunnelProgressTimer=setInterval(()=>{setTunnelProgress(Math.min(99,(Date.now()-tunnelProgressStartedAt)/duration*100))},50);return duration}
  async function finishTunnelProgress(completed,duration){const loading=document.getElementById('qrLoading');if(completed){const remaining=Math.max(0,duration-(Date.now()-tunnelProgressStartedAt));if(remaining)await new Promise(resolve=>setTimeout(resolve,remaining));setTunnelProgress(100);await new Promise(resolve=>setTimeout(resolve,180))}clearInterval(tunnelProgressTimer);tunnelProgressTimer=null;loading.classList.remove('show');setTunnelProgress(0)}
  async function switchMode(enableTunnel){if(phoneConnected||modeSwitching)return;if(selectedTunnelTab===enableTunnel&&tunnelActive===enableTunnel)return;const previous=tunnelActive;const previousProvider=tunnelProvider;const previousUrl=pairingUrl;let completed=false;modeSwitching=true;selectedTunnelTab=enableTunnel;syncModeControls(phoneConnected);syncModeSelection(enableTunnel?'tunnel':'lan');document.getElementById('modeHint').textContent=enableTunnel?T.tunnelHint:T.lanHint;syncTunnelError();// The link outside the QR overlay still shows the old mode's URL until the
  // tunnel toggle resolves (~4.5s). Replace it immediately with a placeholder.
  pairingUrl='';document.getElementById('url').textContent=enableTunnel?T.urlPendingTunnel:T.urlPendingLan;document.getElementById('url').classList.add('is-pending');const progressDuration=startTunnelProgress(enableTunnel);try{const r=await fetch('/desktop/tunnel/toggle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enable:enableTunnel})});const j=await r.json();if(j.ok){applyTunnelPayload(j);selectedTunnelTab=enableTunnel;if(modeView!=='devices'){syncModeSelection(enableTunnel?'tunnel':'lan');document.getElementById('modeHint').textContent=enableTunnel?T.tunnelHint:T.lanHint;if(j.active)document.getElementById('tunnelError').textContent='';syncTunnelError()}completed=true}else{throw new Error(j.error||'Tunnel failed')}}catch(e){tunnelActive=previous;tunnelProvider=previousProvider;pairingUrl=previousUrl;const urlEl=document.getElementById('url');urlEl.classList.remove('is-pending');urlEl.textContent=previousUrl;if(modeView!=='devices'){syncModeSelection(selectedTunnelTab?'tunnel':'lan');document.getElementById('modeHint').textContent=selectedTunnelTab?T.tunnelHint:T.lanHint;document.getElementById('tunnelError').textContent=T.tunnelError+(e.message||e);syncTunnelError()}}finally{await finishTunnelProgress(completed,progressDuration);modeSwitching=false;syncModeControls(phoneConnected)}}
  function applyTunnelPayload(j){tunnelActive=!!j.active;tunnelProvider=j.provider||null;const urlEl=document.getElementById('url');if(j.pairingUrl){pairingUrl=j.pairingUrl;urlEl.textContent=pairingUrl;urlEl.classList.remove('is-pending')}else if(!j.active&&!modeSwitching){pairingUrl='';urlEl.textContent='';urlEl.classList.remove('is-pending')}if(j.qrSvg)document.getElementById('qrCode').innerHTML=j.qrSvg;if(j.expiresAt)end=j.expiresAt;syncPin(j);syncLanRisk();if(j.unexpectedlyClosed&&!j.active){document.getElementById('tunnelError').textContent=T.pinClosed;syncTunnelError()}}
  function renderPinHint(){const hint=document.getElementById('pinHint');if(!hint)return;if(pinConsent){hint.textContent=T.pinHintDurable;return}if(!pinExpiresAt){hint.textContent=T.pinHintTemp;return}const left=Math.max(0,Math.ceil((pinExpiresAt-Date.now())/1000));hint.textContent=T.pinHintTemp+(left?' ('+left+'s)':'')}
  function syncPin(j){const panel=document.getElementById('pinPanel'),value=document.getElementById('pinValue'),box=document.getElementById('pinConsent'),actions=document.getElementById('pinActions');pinConsent=!!j.pinConsent;if('pinExpiresAt' in j)pinExpiresAt=j.pinExpiresAt||null;if(value)value.textContent=j.pairingPin||'';if(box)box.checked=pinConsent;renderPinHint();if(actions)actions.hidden=!pinConsent;if(panel)panel.classList.toggle('show',!!(tunnelActive&&j.pairingPin))}
  async function setPinConsent(consent){const r=await fetch('/desktop/pin/consent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({consent})});const j=await r.json();if(j.ok)applyTunnelPayload(j);else{document.getElementById('pinConsent').checked=pinConsent;document.getElementById('tunnelError').textContent=j.error||T.tunnelError;syncTunnelError()}}
  async function resetPin(){const r=await fetch('/desktop/pin/reset',{method:'POST'});const j=await r.json();if(j.ok)applyTunnelPayload(j)}
  async function refreshQr(){const btn=document.getElementById('qrRefreshBtn');if(!btn||btn.disabled||modeSwitching)return;btn.classList.add('spinning');if(selectedTunnelTab&&!tunnelActive){btn.disabled=true;try{await switchMode(true)}finally{btn.classList.remove('spinning');btn.disabled=false}return}// Force a new pairing token first: a plain reload within the TTL redrew the
  // identical QR, URL and countdown. Rotation failures still fall through to a
  // reload, which rotates on its own once the token has expired.
  btn.disabled=true;try{await fetch('/desktop/pairing/rotate',{method:'POST',headers:{'content-type':'application/json'}})}catch{}setTimeout(()=>{sessionStorage.setItem('pocketModeView',modeView);location.reload()},250)}
  let pollBusy=false;
  async function poll(){if(pollBusy)return;if(document.hidden)return;pollBusy=true;try{const [status,tunnel]=await Promise.all([fetch('/desktop/status'),fetch('/desktop/tunnel/status')]);if(status.ok){const j=await status.json();const connected=!!j.connected;document.getElementById('connection').classList.toggle('show',connected);document.body.classList.toggle('phone-connected',connected);syncModeControls(connected);if(Array.isArray(j.pendingPairings))renderPendingPairings(j.pendingPairings)}if(tunnel.ok){const j=await tunnel.json();if(!modeSwitching)applyTunnelPayload(j)}}finally{pollBusy=false}}
  async function disconnectPhone(){await fetch('/desktop/disconnect',{method:'POST'});location.reload()}
  setInterval(()=>{if(document.hidden)return;const n=Math.max(0,Math.ceil((end-Date.now())/1000));const expiresText=document.getElementById('expiresText');const refreshBtn=document.getElementById('qrRefreshBtn');if(expiresText)expiresText.textContent=pairingUrl?(!n?T.expired:(n>90?T.expiresMinutes:T.expiresSeconds).replace('{n}',String(n>90?Math.ceil(n/60):n))):'';if(refreshBtn)refreshBtn.disabled=!pairingUrl;if(!n&&pairingUrl&&!phoneConnected&&!modeSwitching){sessionStorage.setItem('pocketModeView',modeView);location.reload()};renderPinHint();if(pendingPairings.length)renderPendingPairings(pendingPairings)},1000);
  // The CSP only authorizes the script element: inline onclick/onchange
  // attributes are blocked, so every control carries data-action instead.
  document.addEventListener('click',(event)=>{const el=event.target.closest('[data-action]');if(!el||el.disabled)return;switch(el.dataset.action){case 'mode-lan':setModeView('lan');switchMode(false);break;case 'mode-tunnel':setModeView('tunnel');switchMode(true);break;case 'mode-devices':showDevicePanel();break;case 'device-extend':extendDevice(el);break;case 'device-perm':togglePermission(el);break;case 'device-retry':retryLoadDevicePanel();break;case 'disconnect':disconnectPhone();break;case 'done':donePairing();break;case 'copy':copyUrl();break;case 'refresh':refreshQr();break;case 'reset':resetPin();break;case 'consent-off':setPinConsent(false);break;case 'revoke-device':revokeDevice(el);break;case 'notify-save':saveNotifyConfig();break;case 'notify-test':testNotifyConfig();break;case 'clawbot-bind':bindClawbot();break;case 'clawbot-reset':resetClawbot();break;case 'tunnel-config-save':saveTunnelConfig();break;case 'pair-approve':case 'pair-deny':pairConfirm(el.dataset.id,el.dataset.action==='pair-approve');break}});
  document.addEventListener('change',(event)=>{const el=event.target.closest('input[data-action="consent"]');if(el)setPinConsent(el.checked);if(event.target.id==='notifyChannel')renderClawbotView()});
  renderPendingPairings(pendingPairings);
  if(modeView==='devices')loadDevicePanel();
  renderClawbotView();
  // Opening this page IS the intent to connect: the user decided (2026-10-10) that
// landing here should start the public link on its own — 「你都点进去了，肯定是要生成网络连接的呀」.
// Bounded on purpose: once, only while no phone is paired, the public tab is the one
// showing, and the tunnel really is down. Boot-time autostart was explicitly refused,
// so nothing here runs before this page is opened.
if(!phoneConnected&&selectedTunnelTab&&!tunnelActive)void switchMode(true);
setInterval(poll,800);poll()</script></body></html>`
}

export function renderPairingPinPage(locale, icon = null, options = {}) {
  const zh = /^zh/i.test(String(locale || ''))
  const text = {
    title: zh ? '连接 DSH' : 'Pairing DSH',
    heading: zh ? '输入连接密码' : 'Enter pairing password',
    hint: zh ? '在电脑「pocket」窗口查看密码。' : 'Find the password in pocket on the computer.',
    submit: zh ? '连接' : 'Connect',
    showPin: zh ? '在电脑上查看密码' : 'Show password on the computer',
    invalid: zh ? '连接密码不正确。' : 'That pairing password is incorrect.',
    expired: zh ? '密码已过期，请在电脑上扫描新二维码。' : 'This password expired. Scan the new QR code on the computer.',
    rateLimited: zh ? '尝试次数过多，请 {n} 分钟后再试。' : 'Too many attempts. Try again in {n} min.',
    unavailable: zh ? '暂时无法连接桌面端，请先启动 DSH。' : 'Cannot reach the desktop. Start DSH and try again.',
    timeout: zh ? '网络超时，请检查手机网络后重试。' : 'Network timed out. Check your connection and retry.',
    openFailed: zh ? '页面打开失败，请点连接重试。' : 'Failed to open the page. Please retry.',
    confirmWait: zh ? '请在电脑上确认接入' : 'Approve on the desktop',
    confirmDenied: zh ? '桌面端已拒绝接入' : 'The desktop declined',
    stepServer: zh ? '正在连接服务器' : 'Connecting to server',
    stepWorkspace: zh ? '正在同步工作区' : 'Syncing workspace',
    stepSessionList: zh ? '正在同步会话列表' : 'Syncing session list',
    stepSession: zh ? '正在同步会话内容' : 'Syncing conversation',
    stepPrepare: zh ? '正在准备页面' : 'Preparing page'
  }
  const nonceAttr = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : ''
  // Same rule as the guided reconnect card this one duplicates: an unpaired phone reads
  // this page by definition, so an empty icon must not point it at a gated route and
  // leave a broken tile where the mark belongs.
  const logoBox = icon
    ? '<div class="logo"><img src="' + icon + '" alt="DSH" style="width:40px;height:40px;border-radius:9px;object-fit:cover"></div>'
    : ''
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme:light)"><meta name="theme-color" content="#141416" media="(prefers-color-scheme:dark)"><title>${text.title}</title><style>:root{color-scheme:light;--bg:#fff;--card:#fff;--panel:#f7f8fa;--ink:#18191c;--muted:#6b7076;--line:#e5e7eb;--brand:#4d6bfe;--danger:#c62f3c}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#141416;--card:#1d1d20;--panel:#202023;--ink:#f5f5f6;--muted:#95979d;--line:#303034;--brand:#6f86ff;--danger:#ff9ba1}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px}.card{width:100%;max-width:340px;text-align:center}.logo{width:54px;height:54px;display:grid;place-items:center;margin:0 auto 22px;border:1px solid var(--line);border-radius:16px;background:var(--card)}h1{font-size:24px;line-height:1.25;font-weight:600;margin:0 0 8px}p{margin:0;color:var(--muted)}input{width:100%;height:52px;margin-top:22px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink);text-align:center;font:28px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.28em}button{width:100%;height:44px;margin-top:12px;border:1px solid var(--ink);border-radius:12px;background:var(--ink);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}button.quiet{border-color:var(--line);background:transparent;color:var(--ink)}.note{min-height:20px;margin-top:14px;padding:10px 12px;border-radius:10px;background:var(--panel);color:var(--danger);font-size:13px}.boot-steps{display:none;margin:18px auto 0;text-align:left}.boot-steps.show{display:block}.boot-step{display:flex;align-items:center;color:var(--muted);opacity:.4;font-size:14px;padding:6px 0;transition:opacity .2s ease,color .2s ease}.boot-step.is-active{opacity:1;color:var(--ink);font-weight:600}.boot-step.is-done{opacity:.6;color:var(--muted)}.boot-step.is-done .boot-step-label{text-decoration:line-through;text-decoration-color:var(--brand);text-decoration-thickness:1.5px}.boot-step.is-active::before{content:'';flex:none;width:13px;height:13px;margin-right:9px;border:2px solid var(--line);border-top-color:var(--brand);border-radius:50%;animation:bspin .7s linear infinite}.boot-step:not(.is-active){padding-left:22px}@keyframes bspin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.boot-step.is-active::before{animation:none}}button:disabled{opacity:.55;cursor:default}</style></head><body><div class="card">${logoBox}<h1>${text.heading}</h1><p>${text.hint}</p><form data-form="pin"><input id="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="12" pattern="\\d{6,12}" required><button id="submit" type="submit">${text.submit}</button></form><button class="quiet" type="button" data-action="show-pin">${text.showPin}</button><div id="status" class="note" hidden></div><div id="bootSteps" class="boot-steps"></div></div><script${nonceAttr}>const T=${scriptJson(text)};
${sharedStageScript()}
const SESSION_LIST_ROWS=${SESSION_LIST_PREFETCH};
const SHELL_ASSETS=${scriptJson(options.assets ?? null)};
// Start pulling the shell the moment this page opens: the assets are the same
// for every pairing, and having them in the browser cache is what lets the app
// paint the instant the last step finishes. Failure is silent — the app then
// simply fetches them itself. Every fetch is bounded: a tunnel that swallows a
// request must not be able to freeze this page before the PIN is even entered.
const shellReady=(async()=>{if(!SHELL_ASSETS)return;const urls=[SHELL_ASSETS.cssUrl,SHELL_ASSETS.jsUrl].filter(Boolean);await Promise.all(urls.map(async(url)=>{try{const res=await withTimeout(fetch(url),FETCH_TIMEOUT_MS);if(res.ok)await withTimeout(res.text(),FETCH_TIMEOUT_MS)}catch{}}))})().catch(()=>{});
async function submitPin(event){event.preventDefault();const pin=document.getElementById('pin').value.trim(),status=document.getElementById('status'),submit=document.getElementById('submit'),stepsHost=document.getElementById('bootSteps');submit.disabled=true;status.hidden=true;status.textContent='';const fail=(msg)=>{stepsHost.classList.remove('show');status.textContent=msg;status.hidden=false;submit.disabled=false};
  const labels=[T.stepServer,T.stepWorkspace,T.stepSessionList,T.stepSession,T.stepPrepare];stepsHost.innerHTML=labels.map((label,i)=>'<div class="boot-step'+(i===0?' is-active':'')+'"><span class="boot-step-label">'+label+'</span></div>').join('');stepsHost.classList.add('show');const stepEls=[...stepsHost.children];const setStep=(n)=>stepEls.forEach((el,i)=>{el.classList.toggle('is-done',i<n);el.classList.toggle('is-active',i===n)});
  // One row per real stage: run the work, keep the row visible long enough to be
  // read, then advance. Every row waits on an actual round trip to the desktop,
  // so the list is the true progress of the handoff rather than decoration.
  const stage=stageRunner(setStep);
  try{
  await stage(0,async()=>{const verification=await verifyPin(pin);if(!verification.ok)throw pinError(verification.rescan?T.expired:T.invalid);if(verification.pending){const label=stepEls[0].querySelector('.boot-step-label');if(label)label.textContent=T.confirmWait;await awaitPairConfirmation(verification)}});
  // One tunnel crossing, not three (2026-10-10): the three reads are independent, the
  // bridge dedupes the session catalogue itself, and stageRunner only ever advances —
  // so they go out together and the rows light in arrival order.
  // Only the newest rows: the stage is real work either way, but pulling all 469
  // sessions here (195 KB) is not something the phone needs before it can open a
  // conversation — the list view fetches the full list for itself on open.
  // "Syncing conversation" fetches the transcript payload itself — workspaces,
  // session list and the focus turn's latest messages — and leaves it in this
  // tab. The app document then paints it on its first frame, with no browser
  // cache, no re-download and nothing that a mobile browser can mangle.
  let shell=null;
  await Promise.all([stage(1,()=>rpc('workspace.list')),stage(2,()=>rpc('session.list',{limit:SESSION_LIST_ROWS})),stage(3,async()=>{try{const response=await withTimeout(fetch('/api/boot',{cache:'no-store'}),FETCH_TIMEOUT_MS);if(!response.ok)throw new Error('boot http '+response.status);const raw=await withTimeout(response.text(),FETCH_TIMEOUT_MS);const parsed=JSON.parse(raw);if(parsed&&parsed.ws&&parsed.sess){sessionStorage.setItem('${POCKET_BOOT_KEY}',raw);shell=parsed.assets||null}}catch{// The app document assembles the same payload itself, so a failed stash
    // must not abort the handoff. The stage-4 watchdog still guarantees the
    // flow navigates; the app then loads /api/boot on its own if the stash is
    // missing.
    }})]);
  // "Preparing the page" now really prepares it: the stylesheet and the app
  // script are pulled here, into the browser's own cache, so the navigation that
  // follows only has to fetch the small document (and then paints at once).
  // Without this the phone sat on an inert, unstyled skeleton for one more
  // tunnel round trip after the list had finished (observed live 2026-10-01).
  await stage(4,async()=>{
    // The prefetch started when this page loaded; this row waits for it to land.
    // Anything the payload advertised but the page did not know about is pulled
    // here as well. Each fetch is already timeout-bounded; the Promise.race
    // below is a second ceiling so this row can never spin past 12 s even if a
    // browser quirk leaves a promise pending.
    const extra=shell&&shell!==SHELL_ASSETS?[shell.cssUrl,shell.jsUrl].filter(Boolean):[];
    const ready=Promise.all([shellReady,...extra.map(async(url)=>{try{const res=await withTimeout(fetch(url),FETCH_TIMEOUT_MS);if(res.ok)await withTimeout(res.text(),FETCH_TIMEOUT_MS)}catch{}})]);
    await Promise.race([ready,new Promise(resolve=>setTimeout(resolve,12000))]);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
  });
  // Navigation watchdog: location.replace() is not a promise, so if the browser
  // accepts it this page (and its timers) are torn down at once. If this page
  // is still alive 4 s later the navigation did not happen — surface an error
  // with a working retry instead of leaving every row greyed and dead (the
  // 2026-10-01 freeze). A synchronous throw is handled separately.
  setTimeout(()=>fail(T.openFailed),4000);
  try{location.replace('/')}catch{fail(T.openFailed);return false}
  return false}catch(e){if(e&&e.consentGate){location.replace('/consent?next=/');return false}const msg=e&&e.pinMessage?e.pinMessage:(e&&e.message==='timeout'?T.timeout:T.unavailable);return fail(msg)}}
document.addEventListener('click',(event)=>{const el=event.target.closest('[data-action="show-pin"]');if(el&&!el.disabled)showPinOnDesktop()});
document.addEventListener('submit',(event)=>{if(event.target.matches('form[data-form="pin"]')){event.preventDefault();submitPin(event)}});
</script></body></html>`
}

/**
 * #3c public-access consent card: the tunnel gate answers an unconsented
 * request with a 303 to this page. Same card vocabulary as the PIN page, kept
 * to the minimum: risk statement, one checkbox, one submit. The bridge owns the
 * open-redirect check on `next`; this page only carries it through.
 *
 * @param {string} locale
 * @param {{next?: string, nonce?: string}} [options]
 * @returns {string}
 */
export function renderConsentPage(locale, options = {}) {
  const zh = /^zh/i.test(String(locale || ''))
  const next = typeof options.next === 'string' && options.next ? options.next : '/'
  const text = {
    title: zh ? '公网访问确认' : 'Public Access Confirmation',
    heading: zh ? '公网访问确认' : 'Public Access Confirmation',
    risk: zh
      ? '此页面通过公网隧道暴露，任何拿到链接的人都可能打开它。请确认你了解这一风险后继续。'
      : 'This page is exposed through a public tunnel; anyone who obtains the link can open it. Continue only if you accept that risk.',
    agree: zh ? '我理解此页面经公网暴露，存在被他人访问的风险' : 'I understand this page is exposed publicly and can be reached by others',
    submit: zh ? '继续' : 'Continue'
  }
  // Deliberately no inline script: a plain form POST has nothing for a CSP
  // nonce to authorize, so the tunnel gate cannot be broken by script policy.
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme:light)"><meta name="theme-color" content="#141416" media="(prefers-color-scheme:dark)"><title>${text.title}</title><style>:root{color-scheme:light;--bg:#fff;--card:#fff;--panel:#f7f8fa;--ink:#18191c;--muted:#6b7076;--line:#e5e7eb;--brand:#4d6bfe;--danger:#c62f3c}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#141416;--card:#1d1d20;--panel:#202023;--ink:#f5f5f6;--muted:#95979d;--line:#303034;--brand:#6f86ff;--danger:#ff9ba1}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px}.card{width:100%;max-width:340px;text-align:center}h1{font-size:22px;line-height:1.3;font-weight:600;margin:0 0 10px}p{margin:0;color:var(--muted);font-size:14px;line-height:1.65}.consent{display:flex;gap:9px;align-items:flex-start;margin-top:18px;text-align:left;font-size:13.5px;line-height:1.55}.consent input{margin-top:2px;width:16px;height:16px;flex:none}button{width:100%;height:44px;margin-top:16px;border:1px solid var(--ink);border-radius:12px;background:var(--ink);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.45;cursor:default}</style></head><body><div class="card"><h1>${text.heading}</h1><p>${text.risk}</p><form method="post" action="/consent/accept"><input type="hidden" name="next" value="${escapeHtml(next)}"><label class="consent"><input type="checkbox" name="consent" value="1" required><span>${text.agree}</span></label><button type="submit">${text.submit}</button></form></div></body></html>`
}

function formatLocalTimestamp(value) {
  const date = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function escapeHtml(value) {
  const text = value == null ? '' : String(value);
  return text.replace(/[&<>"']/g, (character) => {
    const replacements = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }
    return replacements[character]
  })
}
