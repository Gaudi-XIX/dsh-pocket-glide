/**
 * @typedef {'en' | 'zh'} Locale
 */
/**
 * @typedef {object} MobilePageOptions
 * @property {Locale} locale
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
 * @property {ConnectedDevice[]} [connectedDevices]
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

// Shared with the pairing page's shell pre-warm: after PIN verification the
// phone pre-fetches the app document into this cache under this key, so the
// post-pairing navigation is served instantly instead of re-downloading the
// whole HTML over the tunnel. Both literals must stay in sync.
const SW_CACHE_NAME = 'pocket-v2'
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

export function renderServiceWorker() {
  // App-shell cache. A cold open paints the cached shell (with its last boot
  // snapshot) instantly, then revalidates the shell and reconciles data via
  // /api/boot. Only documents carrying the x-pocket-cache marker are stored,
  // so reconnect/pair pages never replace the shell. API and pairing routes
  // always pass through to the network.
  return `// DSH Pocket service worker
const V='${SW_CACHE_NAME}', SHELL='${SW_SHELL_KEY}';
const BYPASS=/^\\/(api|pair|desktop|reconnect|disconnected)(\\/|$)/;
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',(event)=>{event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter((k)=>k!==V).map((k)=>caches.delete(k)));await self.clients.claim()})())});
async function revalidateShell(){const cache=await caches.open(V);const res=await fetch('/?revalidate=1',{cache:'no-store'});if(res.ok&&res.headers.get('x-pocket-cache')==='app')await cache.put(SHELL,res.clone());return res}
self.addEventListener('fetch',(event)=>{
  const req=event.request;if(req.method!=='GET')return;
  const url=new URL(req.url);if(url.origin!==self.location.origin||BYPASS.test(url.pathname))return;
  // The app document is owned by the navigate branch below (shell) and by the
  // browser cache the handoff fills — a generic Cache Storage hit here could
  // hand the page a document from an earlier pairing.
  if(url.pathname==='/')return;
  if(req.mode==='navigate'){
    event.respondWith((async()=>{
      const cache=await caches.open(V);const cached=await cache.match(SHELL);
      event.waitUntil(revalidateShell().catch(()=>{}));
      if(cached)return cached;
      try{return await revalidateShell()}catch{return new Response('offline',{status:503})}
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
 * page: 88 KB (22.6 KB CSS + 62 KB JS) that only changes when this file does.
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
 * @param {{locale: string, boot?: string|null, icon?: string|null, initialChat?: boolean, assets?: {jsUrl: string, cssUrl: string}|null}} options
 */
export function renderMobilePage({ locale, boot = null, icon = null, initialChat = false, assets = null }) {
  const document = renderMobileDocument({ locale, boot, icon, initialChat })
  if (!assets) return document
  const style = document.match(/<style>[\s\S]*?<\/style>/)
  const scripts = [...document.matchAll(/<script>[\s\S]*?<\/script>/g)]
  const main = scripts.length ? scripts[scripts.length - 1] : null
  if (!style || !main) return document
  const bootstrap = [
    '<script>(function(){',
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
 * @param {{locale: string, boot?: string|null, icon?: string|null, initialChat?: boolean}} options
 */
function renderMobileDocument({ locale, boot = null, icon = null, initialChat = false }) {
  const zh = locale === 'zh'
  const bootScript = boot
    ? `<script>window.__POCKET_BOOT__=${escapeScriptJson(boot)}</script>`
    : ''
  return `<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme:light)">
  <meta name="theme-color" content="#141416" media="(prefers-color-scheme:dark)">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="DSH Pocket">
  <link rel="icon" href="${icon || '/app-icon'}">
  <link rel="apple-touch-icon" href="${icon || '/app-icon'}">
  <title>DSH Pocket</title>
  <style>
    :root{color-scheme:light;--paper:#fff;--sidebar:#f7f8fa;--ink:#18191c;--muted:#81858c;--line:#e5e7eb;--card:#fff;--hover:#f2f3f5;--surface:#f7f7f5;--brand:#4d6bfe;--tunnel-warn-h:0px}
    @media(prefers-color-scheme:dark){:root{color-scheme:dark;--paper:#141416;--sidebar:#19191b;--ink:#f5f5f6;--muted:#95979d;--line:#303034;--card:#1d1d20;--hover:#29292d;--surface:#202023;--brand:#6f86ff}}
    *{box-sizing:border-box}html,body{height:100%;overflow:hidden}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    button,input,textarea,select{font:inherit}.shell{max-width:760px;height:var(--app-height,100dvh);margin:auto;padding:calc(6px + env(safe-area-inset-top)) 14px calc(8px + env(safe-area-inset-bottom));display:flex;flex-direction:column}
    header{height:48px;display:flex;flex:none;align-items:center;justify-content:space-between;padding:0 3px}.brand{font-size:15px;font-weight:600;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}.brand img{width:35px;height:20px;object-fit:contain}.brand .dark-logo{display:none}@media(prefers-color-scheme:dark){.brand .light-logo{display:none}.brand .dark-logo{display:block}}.status{width:8px;height:8px;border-radius:50%;margin-right:4px;background:#35a867;box-shadow:0 0 0 0 rgba(53,168,103,.42);animation:connectedPulse 1.8s ease-out infinite}.status.connecting{background:var(--muted);animation:none}.status.error-state{background:#e34d59;animation:none}@keyframes connectedPulse{70%{box-shadow:0 0 0 7px rgba(53,168,103,0)}100%{box-shadow:0 0 0 0 rgba(53,168,103,0)}}
    .view{display:none;min-height:0}.view.active{display:flex;flex:1;flex-direction:column}.toolbar{display:flex;flex:none;gap:8px;align-items:center;padding:12px 0}.toolbar select{flex:1;min-width:0}#sessionsView{padding-top:2px}.workspaces{display:grid;grid-auto-rows:min-content;gap:10px;flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:2px 0 14px}.ws-card{border:1px solid var(--line);border-radius:16px;background:var(--card);overflow:hidden}.ws-head{display:flex;align-items:center;gap:2px}.ws-toggle{flex:1;min-width:0;display:flex;align-items:center;gap:7px;text-align:left;background:transparent;border:0;padding:11px 4px 11px 12px}.ws-chevron{flex:none;display:grid;place-items:center;color:var(--muted);transition:transform .2s ease}.ws-card.expanded .ws-chevron{transform:rotate(90deg)}.ws-name{min-width:0;flex:1;font-size:15px;font-weight:620;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}.ws-last{flex:none;display:grid;place-items:center}.ws-last svg{width:16px;height:16px}.ws-last.is-running{color:var(--brand)}.ws-last.is-done{color:#35a867}.ws-last.is-blank{color:var(--muted)}.ws-last.is-awaiting{color:#c08400}.ws-last.is-error{color:#e34d59}.ws-last-time,.ws-count{flex:none;color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}.ws-new{flex:none;display:grid;place-items:center;width:38px;height:38px;margin-right:9px;border-radius:50%;border:1px solid var(--line);background:var(--surface);color:var(--ink)}.ws-new:active{background:var(--hover)}.ws-body{display:none;padding:0 9px 10px}.ws-card.expanded .ws-body{display:block}.task-list{display:grid;gap:7px}.task-row{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:1px solid transparent;border-radius:12px;padding:9px 10px;background:var(--surface)}.task-row:active{background:var(--hover)}.task-status{flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:50%}.task-copy{min-width:0;flex:1}.task-copy strong{display:block;font-size:13.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.task-copy time{display:block;margin-top:1px;color:var(--muted);font-size:10.5px;font-variant-numeric:tabular-nums}.task-row.is-running .task-status{color:var(--brand)}.task-row.is-done .task-status{color:#35a867}.task-row.is-blank .task-status{color:var(--muted)}.task-row.is-error{background:color-mix(in srgb,#e34d59 10%,var(--surface))}.task-row.is-error .task-status,.task-row.is-error .task-copy strong{color:#e34d59}.task-row.is-awaiting{background:#fdf3d3}.task-row.is-awaiting .task-status{color:#c08400}.is-running .spin{animation:spin .8s linear infinite}@media (prefers-color-scheme:dark){.task-row.is-awaiting{background:rgba(201,138,4,.17)}.task-row.is-awaiting .task-copy strong{color:#f0c56b}}.ws-empty{padding:13px 10px;color:var(--muted);font-size:12px;line-height:1.5;text-align:center}body.chat-open header{display:none}body.chat-open .shell{padding:env(safe-area-inset-top) 14px 0}#chatView{position:relative}.chat-toolbar{position:absolute;inset:0 0 auto;z-index:2;min-height:40px;padding:0;background:transparent;pointer-events:none}.back{display:grid;place-items:center;flex:none;width:40px;height:40px;border:1px solid var(--line)!important;border-radius:50%;padding:0!important;background:var(--card)!important;box-shadow:0 2px 8px rgba(0,0,0,.06);pointer-events:auto}.back:hover{background:var(--hover)!important}.back svg{display:block}
    select,button,textarea{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:10px 12px}button{cursor:pointer}button:hover{background:var(--hover)}button.primary{display:flex;align-items:center;justify-content:center;gap:6px;flex:none;min-width:68px;height:40px;border:1px solid var(--ink);border-radius:13px;padding:0 11px 0 13px;background:var(--ink);color:var(--paper);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--paper) 10%,transparent),0 2px 5px rgba(0,0,0,.14);transition:transform .14s ease,opacity .14s ease,box-shadow .14s ease}.primary svg{display:block;flex:none}.primary:hover:not(:disabled){background:var(--ink);opacity:.88;transform:translateY(-1px)}.primary:active:not(:disabled){transform:translateY(0);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--paper) 8%,transparent),0 1px 2px rgba(0,0,0,.12)}.primary:disabled{cursor:default;border-color:var(--line);background:var(--surface);color:var(--muted);box-shadow:none}button.quiet{background:transparent}
.messages{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:0;padding:18px 4px}.chat-open .messages{padding-top:4px;padding-bottom:calc(84px + var(--tunnel-warn-h))}.messages::before{content:'';flex:none;margin-top:auto}.message{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink);line-height:1.65}.message.user{align-self:flex-end;max-width:82%;background:var(--hover);border-radius:22px;padding:9px 15px;margin:8px 0 14px}.message.assistant{align-self:stretch;padding:0 4px;margin:0}.message.assistant+.message.assistant{margin-top:12px}.message .role{display:none}
    .markdown{white-space:normal}.markdown>*:first-child{margin-top:0}.markdown>*:last-child{margin-bottom:0}.markdown p{margin:0 0 10px}.markdown h1,.markdown h2,.markdown h3{line-height:1.3;margin:18px 0 8px}.markdown h1{font-size:22px}.markdown h2{font-size:19px}.markdown h3{font-size:16px}.markdown ul{margin:8px 0;padding-left:22px}.markdown pre{overflow:auto;background:var(--hover);border:1px solid var(--line);border-radius:10px;padding:12px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.markdown code{background:var(--hover);border-radius:5px;padding:2px 5px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}.markdown pre code{padding:0;background:none}.markdown a{color:var(--brand)}.table-wrap{width:100%;overflow-x:auto;margin:10px 0;-webkit-overflow-scrolling:touch}.markdown table{width:100%;min-width:420px;border-collapse:collapse;font-size:13px;line-height:1.5}.markdown th,.markdown td{padding:9px 10px;border:1px solid var(--line);text-align:left;vertical-align:top}.markdown th{background:var(--hover);font-weight:600}.thinking,.tool{position:relative;margin:0;white-space:normal}.thinking summary,.tool summary{position:relative;min-height:34px;cursor:pointer;list-style:none;border-radius:6px;padding:5px 2px;color:var(--ink);font-size:14px;line-height:24px;display:flex;align-items:center;gap:0;overflow:hidden}.thinking summary:hover,.tool summary:hover{background:var(--hover)}.thinking summary::-webkit-details-marker,.tool summary::-webkit-details-marker{display:none}.activity-leading{width:16px;height:16px;display:grid;place-items:center;flex:none;margin-right:6px;color:var(--muted)}.activity-leading svg{display:block}.activity-title{flex:none;font-weight:400}.activity-dot{width:2px;height:2px;margin:0 8px;border-radius:50%;background:var(--muted);opacity:.7;flex:none}.activity-summary{position:relative;min-width:0;flex:1;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.activity-chevron{width:16px;height:16px;display:grid;place-items:center;flex:none;color:var(--muted);transition:transform .14s ease}.thinking[open] .activity-chevron,.tool[open] .activity-chevron{transform:rotate(90deg)}.thinking-body{padding:3px 0 7px 22px;color:var(--muted);font-size:13px;line-height:22px}.tool-body{padding:3px 0 8px 20px;color:var(--muted);font-size:12px}.tool-body strong{display:block;margin:7px 0 3px;font-weight:500}.tool-status.error,.tool[data-state=error] .activity-leading{color:#e34d59}.tool pre{max-height:260px;white-space:pre-wrap;overflow:auto;overflow-wrap:anywhere;margin:0 0 4px;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:10px;padding:10px 12px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.thinking[data-state=running] .activity-summary:after,.tool[data-state=running] .activity-summary:after{content:'';position:absolute;inset:0 auto 0 -240px;width:240px;pointer-events:none;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--paper) 72%,transparent),transparent);animation:activitySweep 2.6s ease-out infinite}.streaming:after{content:' ';display:inline-block;width:6px;height:15px;margin-left:2px;vertical-align:-2px;background:var(--brand);animation:pulse .7s infinite alternate}.turn-status{height:26px;display:inline-flex;align-items:center;margin:0 4px 6px;pointer-events:none;color:transparent;-webkit-text-fill-color:transparent;background:linear-gradient(90deg,var(--brand) 0%,var(--brand) 40%,color-mix(in srgb,var(--brand) 35%,var(--paper)) 50%,var(--brand) 60%,var(--brand) 100%);background-position:100% 0;background-size:250% 100%;-webkit-background-clip:text;background-clip:text;font-size:14px;font-weight:600;white-space:nowrap;animation:deepDiveShimmer 1.8s linear infinite}
    .turn-process{position:relative;margin:2px 0 4px;white-space:normal;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.turn-process>summary{position:relative;min-height:36px;cursor:pointer;list-style:none;border-radius:12px;padding:6px 10px;color:var(--ink);font-size:14px;line-height:24px;display:flex;align-items:center;gap:0;overflow:hidden}.turn-process>summary:hover{background:var(--hover)}.turn-process>summary::-webkit-details-marker{display:none}.turn-process-body{padding:4px 10px 8px;border-top:1px solid var(--line)}.turn-process-body .thinking,.turn-process-body .tool{margin:2px 0;padding-left:10px;border-left:2px solid var(--line)}.turn-process-live{margin:2px 0}.turn-process-live .thinking,.turn-process-live .tool{margin:2px 0}
#chatView{position:relative}#messages.pulling,#messages.animating{will-change:transform}#messages.animating{transition:transform .24s cubic-bezier(.22,1,.36,1)}.pull-indicator{position:absolute;left:0;right:0;top:46px;height:64px;overflow:hidden;pointer-events:none;z-index:1;opacity:0}.pull-indicator.active,.pull-indicator.busy{opacity:1}.pull-ring{position:absolute;left:50%;top:10px;width:26px;height:26px;transform:translateX(-50%)}.pull-ring circle{fill:none;stroke-width:3}.ring-track{stroke:var(--line)}.ring-fill{stroke:var(--brand);stroke-linecap:round;transform:rotate(-90deg);transform-origin:center;stroke-dasharray:106.8}.pull-indicator.busy .pull-ring{animation:pullspin .7s linear infinite}@keyframes pullspin{to{transform:translateX(-50%) rotate(360deg)}}
    [hidden]{display:none!important}.message:empty{display:none}.composer{position:fixed;z-index:2;left:50%;bottom:0;transform:translateX(-50%);will-change:transform;width:min(760px,100%);padding:10px 14px calc(5px + env(safe-area-inset-bottom));background:linear-gradient(to bottom,transparent 0%,color-mix(in srgb,var(--paper) 55%,transparent) 38%,var(--paper) 100%);pointer-events:none}.composer-inner{min-height:58px;display:flex;gap:8px;align-items:flex-end;border:1px solid var(--line);border-radius:23px;padding:8px 8px 8px 16px;background:var(--card);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--paper) 70%,transparent),0 2px 8px rgba(0,0,0,.06),0 14px 34px rgba(0,0,0,.06);pointer-events:auto;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}.composer-inner:focus-within{border-color:color-mix(in srgb,var(--ink) 28%,var(--line));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--paper) 72%,transparent),0 3px 10px rgba(0,0,0,.08),0 18px 38px rgba(0,0,0,.08)}.composer textarea{flex:1;height:40px;min-height:40px;max-height:150px;overflow-y:auto;resize:none;border:0;outline:0;border-radius:0;padding:9px 0;background:transparent;color:var(--ink);caret-color:var(--brand);font-size:16px;letter-spacing:-.01em}.composer textarea::placeholder{color:var(--muted);opacity:.68}.composer .primary,.primary.cancel{width:40px;min-width:40px;border-radius:50%;padding:0;background:var(--ink);border-color:var(--ink)}.settings-trigger{display:grid;place-items:center;width:40px;min-width:40px;height:40px;border-radius:50%;padding:0;background:var(--surface);color:var(--muted)}.settings-trigger[aria-expanded=true]{border-color:var(--ink);background:var(--ink);color:var(--paper)}.session-settings{position:absolute;right:8px;bottom:calc(76px + var(--tunnel-warn-h));width:min(350px,calc(100vw - 28px));max-height:min(62vh,470px);overflow-y:auto;border:1px solid var(--line);border-radius:18px;padding:15px;background:var(--card);box-shadow:0 8px 26px rgba(0,0,0,.1),0 24px 60px rgba(0,0,0,.12);pointer-events:auto}.settings-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.settings-head strong{font-size:15px;font-weight:650}.settings-close{display:grid;place-items:center;width:28px;height:28px;border:0;border-radius:50%;padding:0;background:transparent;color:var(--muted);font-size:20px;line-height:1}.setting-field{display:block;margin-top:11px}.setting-field>span{display:block;margin:0 2px 5px;color:var(--muted);font-size:11px;font-weight:600}.setting-field select{width:100%;height:42px;background:var(--surface)}.setting-field select:disabled{opacity:.55}.setting-note{margin:5px 2px 0;color:var(--muted);font-size:11px;line-height:1.4}.settings-error{min-height:17px;margin-top:7px;color:#e34d59;font-size:11px}.settings-loading{padding:14px 2px;color:var(--muted);font-size:12px}.todo-dock{margin:0 0 8px;border:1px solid var(--line);border-radius:14px;background:var(--surface);overflow:hidden;pointer-events:auto}.todo-header{width:100%;height:38px;display:flex;align-items:center;gap:8px;border:0;border-radius:0;padding:0 11px;background:transparent;text-align:left}.todo-lead,.todo-chevron{display:grid;place-items:center;flex:none;color:var(--muted)}.todo-title{flex:none;font-size:13px;font-weight:600}.todo-progress{min-width:0;flex:1;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.todo-list{display:grid;gap:7px;max-height:180px;overflow-y:auto;margin:0;padding:1px 12px 10px;list-style:none}.todo-item{min-width:0;display:flex;align-items:center;gap:9px;color:var(--muted);font-size:13px}.todo-glyph{display:grid;place-items:center;width:16px;height:16px;flex:none}.todo-item[data-status=completed] .todo-glyph{color:#35a867}.todo-item[data-status=in_progress] .todo-glyph{color:var(--brand);animation:spin 1s linear infinite}.todo-content{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.turn-running .messages{padding-bottom:calc(116px + var(--tunnel-warn-h))}.todo-open .messages{padding-bottom:calc(130px + var(--tunnel-warn-h))}.turn-running.todo-open .messages{padding-bottom:calc(162px + var(--tunnel-warn-h))}.todo-expanded .messages{padding-bottom:min(42vh,calc(300px + var(--tunnel-warn-h)))}.turn-running.todo-expanded .messages{padding-bottom:min(42vh,calc(332px + var(--tunnel-warn-h)))}.turn-running .session-settings{bottom:calc(108px + var(--tunnel-warn-h))}.todo-open .session-settings{bottom:calc(122px + var(--tunnel-warn-h))}.turn-running.todo-open .session-settings{bottom:calc(154px + var(--tunnel-warn-h))}.todo-expanded .session-settings{bottom:min(42vh,calc(292px + var(--tunnel-warn-h)))}.turn-running.todo-expanded .session-settings{bottom:min(42vh,calc(324px + var(--tunnel-warn-h)))}.primary[hidden]{display:none}.question-composer{position:absolute;z-index:3;inset:auto 0 0;padding:10px 0 5px;pointer-events:none}.question-shell{max-height:min(70vh,580px);display:flex;flex-direction:column;border:1px solid var(--line);border-radius:23px;background:var(--card);box-shadow:0 4px 16px rgba(0,0,0,.08),0 22px 54px rgba(0,0,0,.1);overflow:hidden;pointer-events:auto}.question-top{display:flex;align-items:center;gap:9px;flex:none;padding:13px 16px 10px;border-bottom:1px solid var(--line)}.question-mark{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;background:var(--surface);color:var(--ink)}.question-context{min-width:0;flex:1}.question-context strong{display:block;font-size:13px;font-weight:650}.question-context span{display:block;color:var(--muted);font-size:11px}.question-close{width:30px;height:30px;display:grid;place-items:center;border:0;border-radius:50%;padding:0;background:transparent;color:var(--muted)}.question-body{min-height:0;overflow-y:auto;padding:14px 16px 4px;-webkit-overflow-scrolling:touch}.question-title{margin:0;font-size:17px;line-height:1.45;letter-spacing:-.015em;font-weight:620}.question-detail{margin-top:7px;color:var(--muted);font-size:13px}.question-options{display:grid;gap:7px;margin-top:13px}.question-option{width:100%;display:flex;align-items:flex-start;gap:10px;border:1px solid var(--line);border-radius:13px;padding:10px 11px;background:var(--card);text-align:left}.question-option.selected{border-color:var(--ink);background:var(--surface)}.option-control{display:grid;place-items:center;width:19px;height:19px;flex:none;margin-top:1px;border:1px solid var(--muted);border-radius:50%;font-size:11px}.multi .option-control{border-radius:6px}.question-option.selected .option-control{border-color:var(--ink);background:var(--ink);color:var(--paper)}.option-copy{min-width:0;flex:1}.option-label{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:14px}.recommendation{border-radius:999px;background:var(--surface);color:var(--muted);padding:1px 6px;font-size:10px}.option-description{display:block;margin-top:2px;color:var(--muted);font-size:12px;line-height:1.45}.custom-label{display:block;margin:13px 1px 5px;color:var(--muted);font-size:11px;font-weight:600}.question-custom{width:100%;min-height:54px;max-height:110px;resize:vertical;border:1px solid var(--line);border-radius:13px;padding:10px 11px;background:var(--surface);outline:none}.question-custom:focus{border-color:color-mix(in srgb,var(--ink) 35%,var(--line))}.question-error{min-height:18px;padding:5px 16px 0;color:#e34d59;font-size:11px}.question-actions{display:flex;align-items:center;gap:7px;flex:none;padding:8px 12px 12px}.question-actions button{height:38px;padding:0 12px;border-radius:11px}.question-actions .spacer{flex:1}.question-actions .submit-answer{border-color:var(--ink);background:var(--ink);color:var(--paper);font-weight:600}.question-actions button:disabled{opacity:.45;cursor:default}.question-open .messages{padding-bottom:min(64vh,520px)}.error{color:#e34d59;font-size:13px;margin:8px 0}.turn-error-bubble{display:flex;gap:9px;align-items:flex-start;margin:10px 0;padding:11px 13px;border:1px solid color-mix(in srgb,#e34d59 35%,var(--line));background:color-mix(in srgb,#e34d59 9%,var(--card));border-radius:14px;color:#d23b47}.turn-error-bubble svg{flex:none;margin-top:1px}.turn-error-text{display:flex;flex-direction:column;gap:2px;min-width:0}.turn-error-title{font-size:14px;font-weight:600}.turn-error-detail{font-size:13px;line-height:1.45;word-break:break-word;opacity:.85}.toast{position:fixed;left:50%;top:calc(64px + env(safe-area-inset-top));z-index:5;transform:translate(-50%,-8px);background:var(--ink);color:var(--paper);border-radius:999px;padding:6px 11px;font-size:12px;opacity:0;pointer-events:none;transition:.18s ease}.toast.show{opacity:1;transform:translate(-50%,0)}.loading{display:grid;gap:12px;padding:22px 4px}.skeleton{height:14px;border-radius:7px;background:var(--hover);animation:pulse 1.1s ease-in-out infinite alternate}.skeleton:nth-child(2){width:82%}.skeleton:nth-child(3){width:64%}@keyframes pulse{to{opacity:.35}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes activitySweep{0%{left:-240px}90%,to{left:100%}}@keyframes deepDiveShimmer{to{background-position:0 0}}@media(display-mode:standalone){.chat-open .messages{padding-bottom:calc(84px + env(safe-area-inset-bottom) + var(--tunnel-warn-h))}.chat-open.turn-running .messages{padding-bottom:calc(116px + env(safe-area-inset-bottom) + var(--tunnel-warn-h))}.chat-open.todo-open .messages{padding-bottom:calc(130px + env(safe-area-inset-bottom) + var(--tunnel-warn-h))}.chat-open.turn-running.todo-open .messages{padding-bottom:calc(162px + env(safe-area-inset-bottom) + var(--tunnel-warn-h))}.chat-open.todo-expanded .messages{padding-bottom:min(42vh,calc(300px + env(safe-area-inset-bottom) + var(--tunnel-warn-h)))}.chat-open.turn-running.todo-expanded .messages{padding-bottom:min(42vh,calc(332px + env(safe-area-inset-bottom) + var(--tunnel-warn-h)))}.chat-open.question-open .messages{padding-bottom:min(64vh,520px)}.composer,.question-composer{padding-bottom:calc(5px + env(safe-area-inset-bottom))}}@media(prefers-reduced-motion:reduce){.skeleton,.status,.icon-button.refreshing svg,.thinking[data-state=running] .activity-summary:after,.tool[data-state=running] .activity-summary:after,.turn-status,.todo-item[data-status=in_progress] .todo-glyph{animation:none}.composer-inner,.primary{transition:none}}
    /* Keep the popover anchored to its trigger; composer docks may grow behind it. */
    #composer .session-settings{z-index:1;bottom:calc(76px + var(--tunnel-warn-h))}
    .tunnel-warn{margin:4px 16px 0;padding:0;background:transparent;color:var(--muted);font-size:11px;line-height:1.3;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
    body.tunnel-warn-open{--tunnel-warn-h:18px}
    .messages .turn-status{align-self:flex-start;flex:none;margin:3px 4px}
    /* content sticks to the bottom via the .messages::before margin-top:auto spacer */
    .head-expiry{flex:none;margin-left:2px;padding:2px 7px;border-radius:999px;background:var(--surface);color:var(--muted);font-size:10px;line-height:1.5;white-space:nowrap;font-variant-numeric:tabular-nums}
    .head-icon{flex:none;display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:50%;background:transparent;color:var(--muted);padding:0}
    .head-icon:active{background:var(--hover);color:var(--ink)}
    .head-icon.spinning svg{animation:headSpin .55s linear infinite}
    @keyframes headSpin{to{transform:rotate(360deg)}}
    body.chat-open #listRefresh{display:none}
  </style>
</head>
<body${initialChat ? ' class="chat-open"' : ''}><main class="shell">
  <div id="toast" class="toast" role="status"></div>
  <header><div class="brand"><img src="${icon || '/app-icon'}" alt="" style="width:22px;height:22px;border-radius:5px;object-fit:cover"><span>DSH Pocket</span></div><div class="head-right" style="display:flex;align-items:center;gap:5px"><span id="deviceExpiry" class="head-expiry" hidden></span><button id="listRefresh" class="head-icon" aria-label="${zh ? '刷新会话列表' : 'Refresh sessions'}"><svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.6v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div id="status" class="status connecting" role="status" aria-label="${zh ? '正在连接' : 'Connecting'}"></div></div></header>
  <section id="sessionsView" class="view${initialChat ? '' : ' active'}">
    <div id="workspaces" class="workspaces"></div><div id="listError" class="error"></div>
  </section>
  <section id="chatView" class="view${initialChat ? ' active' : ''}">
    <div class="toolbar chat-toolbar"><button id="back" class="quiet back" aria-label="${zh ? '返回会话列表' : 'Back to sessions'}"><svg width="20" height="20" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.5 3L5.5 8L10.5 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
    <div id="pullIndicator" class="pull-indicator" aria-hidden="true"><svg class="pull-ring" viewBox="0 0 40 40"><circle class="ring-track" cx="20" cy="20" r="17"></circle><circle class="ring-fill" id="pullRingFill" cx="20" cy="20" r="17"></circle></svg></div>
    <div id="messages" class="messages">${initialChat ? '<div class="loading"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>' : ''}</div><div id="chatError" class="error"></div>
    <div id="questionComposer" class="question-composer" hidden></div>
    <div id="composer" class="composer"><div id="sessionSettings" class="session-settings" hidden></div><section id="todoDock" class="todo-dock" aria-label="${zh ? '任务' : 'To-dos'}" hidden></section><div class="composer-inner"><textarea id="prompt" rows="1" placeholder="${zh ? '给智能体发消息' : 'Message the agent'}"></textarea><button id="settings" class="settings-trigger" aria-label="${zh ? '会话设置' : 'Session settings'}" aria-expanded="false"><svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M3 5h7M13 5h2M3 13h2M8 13h7M10 3v4M6 11v4" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg></button><button id="send" class="primary" aria-label="${zh ? '发送' : 'Send'}" disabled><svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 12V4M8 4 4.75 7.25M8 4l3.25 3.25" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button id="cancel" class="primary cancel" aria-label="${zh ? '停止生成' : 'Stop generating'}" hidden><svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor"/></svg></button></div><div id="tunnelWarn" class="tunnel-warn" hidden></div></div>
  </section>
</main>
${bootScript}
<script>
${applyPendingCreatedSessions.toString()}
const L=${scriptJson({
    untitled: zh ? '未命名会话' : 'Untitled session',
    failed: zh ? '请求失败' : 'Request failed',
    running: zh ? '运行中' : 'Running',
    done: zh ? '完成' : 'Done',
    toolFailed: zh ? '失败' : 'Failed',
    input: zh ? '输入' : 'Input',
    output: zh ? '输出' : 'Output'
    ,noWorkspaces: zh ? '暂无工作区，请先在 DSH 中创建第一个工作区。' : 'No workspaces yet. Create your first workspace in DSH.'
    ,taskUnit: zh ? '个任务' : ' tasks'
    ,runningUnit: zh ? '个运行中' : ' running'
    ,newChat: zh ? '新建对话' : 'New chat'
    ,noTasksHint: zh ? '还没有对话，点右上角 + 新建一个' : 'No chats yet. Tap + to start one.'
    ,awaitingUnit: zh ? '待回应' : 'needs input'
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
    ,presetLocked: zh ? '发送首条消息后，Preset 已锁定。' : 'Preset is locked after the first message.'
    ,presetEditable: zh ? '仅可在发送第一条消息前更改。' : 'Can be changed before the first message only.'
    ,settingsLoading: zh ? '正在读取模型与 Preset…' : 'Loading models and presets…'
    ,settingsUpdated: zh ? '会话设置已更新' : 'Session settings updated'
    ,noModels: zh ? '当前没有可选模型' : 'No models are available'
    ,defaultEffort: zh ? '默认' : 'Default'
    ,todoTitle: zh ? '任务' : 'To-dos'
    ,todoDone: zh ? '已完成' : 'completed'
    ,todoActive: zh ? '进行中' : 'in progress'
    ,todoPending: zh ? '待处理' : 'pending'
    ,think: zh ? '思考' : 'Think'
    ,process: zh ? '过程' : 'Process'
    ,close: zh ? '关闭' : 'Close'
    ,deepDiving: zh ? '深度思考中…' : 'Deep diving...'
    ,turnError: zh ? '运行出错' : 'Error'
    ,turnAborted: zh ? '已取消' : 'Canceled'
    ,turnBlocked: zh ? '被拦截，未能执行' : 'Blocked'
    ,turnMaxTokens: zh ? '已达到长度上限' : 'Maximum length reached'
    ,turnInterrupted: zh ? '被打断' : 'Interrupted'
    ,streamFailure: zh ? '连接中断' : 'Connection lost'
  })};
  const HISTORY_POLL_ACTIVE_MS=250,HISTORY_POLL_IDLE_MS=750,HISTORY_POLL_IDLE_CAP_MS=5000,PENDING_SYNC_DEBOUNCE_MS=150;
  let idlePollMs=HISTORY_POLL_IDLE_MS;
  // Pull-older window: pages older than the live SSE window, merged by seq.
  let olderEvents=[],olderHasMore=false,olderBusy=false
  // Resolves true when the live SSE first frame lands; openSession waits on it
  // so the first screen is not also fetched over RPC unless the stream is slow.
  let streamSnapshotReady=null,markStreamSnapshot=()=>{}
  function armStreamSnapshot(){streamSnapshotReady=new Promise(resolve=>{markStreamSnapshot=(ok)=>{markStreamSnapshot=()=>{};resolve(ok)}})}
  let activeSession=null,poll=null,sessionStream=null,streamConnected=false,streamEvents=[],streamProjections=null,streamRenderFrame=null,streamNeedsFullPaint=false,streamRevision=0,pendingSyncTimer=null,workspaces=[],presets=[],sessionSummaries=[],archivedSessionIds=[],pendingCreatedSessions=[],historyBusy=false,lastHistoryKey='',lastDurableMessages=[],optimisticPrompts=[],latestUserTextCounts=new Map(),agentRunning=false,awaitingTurnStartedAt=0,pendingQuestion=null,questionIndex=0,questionDrafts={},questionBusy=false,sessionBlank=true,currentPreset=null,modelCatalog=null,settingsBusy=false,currentTodos=[],todoExpanded=false,tokenStream=null,turnOpenState=new Map(),sessionCache=new Map(),embeddedFocus=null,expandedWsIds=new Set(),expandedInitDone=false,busyEnter='queue',transcriptView='standard',performanceUsage='detailed';
const $=id=>document.getElementById(id);
async function rpc(method,payload={}){let r;try{r=await fetch('/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,payload})})}catch{const e=new Error('');e.disconnected=true;throw e}if(r.status===401){const e=new Error('');e.disconnected=true;throw e}let j;try{j=await r.json()}catch{throw new Error(L.failed)}if(!r.ok||!j.ok)throw new Error(j.error||L.failed);return j.value}
function showError(id,error){$(id).textContent=error?.disconnected?'':error?.message||L.failed}
function stepKey(d){return String(d.turn)+':'+String(d.step)}
function contentBlocks(content){return(Array.isArray(content)?content:[]).flatMap(block=>{if(block?.type==='text'&&block.text)return[{kind:'text',text:block.text}];if(block?.type==='reasoning'&&block.text)return[{kind:'reasoning',text:block.text}];if(block?.type==='tool-call')return[{kind:'tool',id:block.id,name:block.name,args:block.arguments,status:'running'}];return[]})}
function eventSeq(entry){const e=entry&&(entry.event||entry);const s=e&&e.seq;return typeof s==='number'?s:-1}
function mergeEntries(list){const map=new Map();const tail=[];for(const entry of list){const s=eventSeq(entry);if(s>=0){if(!map.has(s))map.set(s,entry)}else tail.push(entry)}return[...map.entries()].sort((a,b)=>a[0]-b[0]).map(pair=>pair[1]).concat(tail)}
// Older pages (pull-older) sit below the live SSE snapshot window; merged by seq.
function windowEvents(){return mergeEntries(olderEvents.concat(streamEvents))}
function visibleMessages(events){const out=[],steps=new Map(),turns=new Map();function ensureTurn(d){const key=String(d.turn??''),existing=turns.get(key);if(existing)return existing;const created={nodes:[],answer:null,closed:false,key:key};turns.set(key,created);out.push({turn:created});return created}function ensureStep(d){const key=stepKey(d);if(!steps.has(key)){const node={role:'assistant',blocks:[],streaming:true,_step:d.step};steps.set(key,node);ensureTurn(d).nodes.push(node)}return steps.get(key)}for(const entry of events){const e=entry.event||entry,d=e.data||{},t=String(e.type||'').toLowerCase();if(t==='user/message'){const message=d.message||d;if(message.source?.kind==='user'){const blocks=contentBlocks(message.content).filter(block=>block.kind==='text');if(blocks.length)out.push({role:'user',blocks})}continue}if(t==='assistant/chunk'){const chunk=d.chunk||{};if(chunk.type!=='text-delta'&&chunk.type!=='reasoning-delta')continue;const node=ensureStep(d),kind=chunk.type==='text-delta'?'text':'reasoning',streamKey=kind+':'+String(chunk.index??0);let block=node.blocks.find(item=>item?._streamKey===streamKey);if(!block){block={kind,text:'',_streamKey:streamKey};node.blocks.push(block)}block.text+=chunk.text||chunk.delta||'';continue}if(t==='assistant/message'){const node=ensureStep(d),turn=ensureTurn(d),blocks=contentBlocks(d.message?.content);node.blocks=blocks;node.streaming=false;if(blocks.some(block=>block.kind==='text'))turn.answer=d.step;turn.closed=true;continue}if(t==='tool/call'){const node=ensureStep(d);if(!node.blocks.some(block=>block?.kind==='tool'&&block.id===d.callId))node.blocks.push({kind:'tool',id:d.callId,name:d.name,args:d.arguments,status:'running'});continue}if(t==='tool/result'){const node=ensureStep(d),result=(d.message?.content||[]).find(block=>block?.type==='tool-result'),id=result?.toolCallId;let tool=node.blocks.find(block=>block?.kind==='tool'&&block.id===id);if(!tool){tool={kind:'tool',id,name:id||'tool',args:'',status:'running'};node.blocks.push(tool)}tool.status=d.error||result?.isError?'error':'done';tool.result=(result?.content||[]).filter(block=>block?.type==='text').map(block=>block.text).join('\\n');node.streaming=false}if(t==='turn/end'){const turn=ensureTurn(d),reason=d.reason||{},kind=String(reason.kind||'completed');let label='',detail='';if(kind==='error'){label=L.turnError;detail=reason.error?.message||reason.error?.code||''}else if(kind==='aborted'){label=L.turnAborted;detail=reason.reason?.message||''}else if(kind==='blocked'){label=L.turnBlocked}else if(kind==='max-tokens'){label=L.turnMaxTokens}else if(kind==='interrupted'){label=L.turnInterrupted}if(label){out.push({role:'turn-error',blocks:[{kind:'turn-error',label,detail}]})}turn.closed=true}}function processBlocks(turn){const blocks=[];for(const node of turn.nodes){for(const block of node.blocks){if(block&&(block.kind==='tool'||block.kind==='reasoning'))blocks.push(block)}}return blocks}
  const rendered=[];for(const item of out){if(item.role==='user'){rendered.push(item);continue}if(item.role==='turn-error'){rendered.push(item);continue}const turn=item.turn,live=!turn.closed,process=processBlocks(turn),textItems=[];for(const node of turn.nodes){for(const block of node.blocks){if(block&&block.kind==='text')textItems.push({block,streaming:live&&!!node.streaming})}}if(process.length)rendered.push({role:'assistant',streaming:live,turnProcess:true,turnKey:turn.key,blocks:process});for(const item of textItems)rendered.push({role:'assistant',streaming:item.streaming,blocks:[item.block]})}
  return rendered.filter(message=>message.blocks?.length)}
function inlineMarkdown(text){return esc(text).replace(/\\x60([^\\x60]+)\\x60/g,'<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>').replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^ )]+)\\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>')}
function tableCells(line){let value=line.trim();if(value.startsWith('|'))value=value.slice(1);if(value.endsWith('|'))value=value.slice(0,-1);return value.split('|').map(cell=>cell.trim())}
function markdown(text){const lines=String(text||'').split('\\n');let html='',code=false,list=false;for(let i=0;i<lines.length;i++){const line=lines[i];if(line.trim().startsWith(String.fromCharCode(96,96,96))){if(list){html+='</ul>';list=false}html+=code?'</code></pre>':'<pre><code>';code=!code;continue}if(code){html+=esc(line)+'\\n';continue}const next=lines[i+1]||'',separator=next.trim().replace(/^\\||\\|$/g,'').split('|');if(line.includes('|')&&separator.length>0&&separator.every(cell=>/^\\s*:?-{3,}:?\\s*$/.test(cell))){if(list){html+='</ul>';list=false}const headers=tableCells(line);html+='<div class="table-wrap"><table><thead><tr>'+headers.map(cell=>'<th>'+inlineMarkdown(cell)+'</th>').join('')+'</tr></thead><tbody>';i+=2;while(i<lines.length&&lines[i].includes('|')&&lines[i].trim()){html+='<tr>'+tableCells(lines[i]).map(cell=>'<td>'+inlineMarkdown(cell)+'</td>').join('')+'</tr>';i++}i--;html+='</tbody></table></div>';continue}const heading=line.match(/^(#{1,3})\\s+(.+)$/);if(heading){if(list){html+='</ul>';list=false}const level=heading[1].length;html+='<h'+level+'>'+inlineMarkdown(heading[2])+'</h'+level+'>';continue}const bullet=line.match(/^[-*]\\s+(.+)$/);if(bullet){if(!list){html+='<ul>';list=true}html+='<li>'+inlineMarkdown(bullet[1])+'</li>';continue}if(list){html+='</ul>';list=false}if(line.trim())html+='<p>'+inlineMarkdown(line)+'</p>'}if(list)html+='</ul>';if(code)html+='</code></pre>';return html}
function pretty(value){if(!value)return'';try{return JSON.stringify(JSON.parse(value),null,2)}catch{return String(value)}}
function activityIcon(kind){return kind==='think'?'<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 1.75a4 4 0 0 0-2.66 6.98c.43.38.66.88.66 1.4v.12h4v-.12c0-.52.23-1.02.66-1.4A4 4 0 0 0 7 1.75Z" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/><path d="M5.4 12h3.2M5.75 10.25h2.5" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>':'<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1.75" y="2.25" width="10.5" height="9.5" rx="2" stroke="currentColor" stroke-width="1.15"/><path d="m4 5 1.5 1.5L4 8M7.5 8h2.5" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
function activityChevron(){return'<span class="activity-chevron" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'}
function reasoningSummary(text,streaming){const lines=String(text||'').split('\\n').map(line=>line.trim()).filter(Boolean);return lines.length?(streaming?lines[lines.length-1]:lines[0]):L.running}
  function renderBlock(block,streaming){if(!block)return'';if(block.kind==='turn-error')return'<div class="turn-error-bubble"><svg width="15" height="15" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7.2" fill="currentColor"/><path d="M9 5v4.4" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="9" cy="12.1" r=".95" fill="#fff"/></svg><span class="turn-error-text"><span class="turn-error-title">'+esc(block.label)+'</span>'+(block.detail?'<span class="turn-error-detail">'+esc(block.detail)+'</span>':'')+'</span></div>';if(block.kind==='text')return'<div class="markdown'+(streaming?' streaming':'')+'">'+markdown(block.text)+'</div>';if(block.kind==='reasoning'){if(!streaming&&transcriptView==='compact')return'';const state=streaming?'running':'ok';return'<details class="thinking"'+(transcriptView==='verbose'?' open':'')+' data-state="'+state+'"><summary><span class="activity-leading">'+activityIcon('think')+'</span><span class="activity-title">'+L.think+'</span><span class="activity-dot" aria-hidden="true"></span><span class="activity-summary">'+esc(reasoningSummary(block.text,streaming))+'</span>'+activityChevron()+'</summary><div class="thinking-body markdown'+(streaming?' streaming':'')+'">'+markdown(block.text)+'</div></details>'}if(block.kind==='tool'){if(pendingQuestion&&block.status==='running'&&block.name==='ask_user_question')return'';const label=block.status==='running'?L.running:block.status==='error'?L.toolFailed:L.done;return'<details class="tool"'+(transcriptView==='verbose'?' open':'')+' data-state="'+esc(block.status)+'"><summary><span class="activity-leading">'+activityIcon('tool')+'</span><span class="activity-title tool-name">'+esc(block.name||'tool')+'</span><span class="activity-dot" aria-hidden="true"></span><span class="activity-summary tool-status '+esc(block.status)+'">'+label+'</span>'+activityChevron()+'</summary><div class="tool-body">'+(block.args?'<strong>'+L.input+'</strong><pre>'+esc(pretty(block.args))+'</pre>':'')+(block.result?'<strong>'+L.output+'</strong><pre>'+esc(block.result)+'</pre>':'')+'</div></details>'}return''}
function renderTurnProcess(message){const blocks=message.blocks.filter(Boolean);if(!blocks.length)return'';if(message.streaming)return'<div class="message assistant turn-process-live">'+blocks.map(block=>renderBlock(block,true)).join('')+'</div>';const userState=turnOpenState.get(message.turnKey),open=userState===true||(userState!==false&&transcriptView==='verbose');return'<details class="turn-process" data-turn-key="'+esc(message.turnKey)+'"'+(open?' open':'')+'><summary><span class="activity-leading">'+activityIcon('tool')+'</span><span class="activity-title">'+L.process+'</span>'+activityChevron()+'</summary><div class="turn-process-body">'+blocks.map(block=>renderBlock(block,false)).join('')+'</div></details>'}
function renderMessage(message){if(message.turnProcess)return renderTurnProcess(message);const blocks=message.blocks.filter(Boolean);if(message.role==='turn-error')return blocks.map(block=>renderBlock(block,false)).join('');return'<div class="message '+message.role+'">'+blocks.map((block,index)=>renderBlock(block,message.streaming&&index===blocks.length-1&&(block.kind==='text'||block.kind==='reasoning'))).join('')+'</div>'}
  function syncPromptUi(){const prompt=$('prompt');prompt.style.height='40px';prompt.style.height=Math.min(150,Math.max(40,prompt.scrollHeight))+'px';const hasText=!!prompt.value.trim();const showSend=!agentRunning||hasText;$('send').hidden=!showSend;$('cancel').hidden=showSend;$('send').disabled=!hasText}
  function updateRunning(events){let running=false,latestStart=0;for(const entry of events){const event=entry.event||entry,t=String(event.type||'').toLowerCase();if(t==='turn/start'){running=true;latestStart=Math.max(latestStart,Number(event.time)||0)}else if(t==='turn/end')running=false}if(awaitingTurnStartedAt&&latestStart>=awaitingTurnStartedAt){awaitingTurnStartedAt=0}agentRunning=running||awaitingTurnStartedAt>0;syncPromptUi()}
  function todoProgress(){const done=currentTodos.filter(item=>item.status==='completed').length,active=currentTodos.filter(item=>item.status==='in_progress').length,pending=currentTodos.length-done-active;return[(done?done+' '+L.todoDone:''),(active?active+' '+L.todoActive:''),(pending?pending+' '+L.todoPending:'')].filter(Boolean).join(' · ')}
  function todoGlyph(status){if(status==='completed')return'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.2"/><path d="m4 7 2 2 4-4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';if(status==='in_progress')return'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1a6 6 0 1 1-5.2 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';return'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2.4 2.4"/></svg>'}
  function renderTodoDock(){const host=$('todoDock'),visible=currentTodos.length>0;host.hidden=!visible;document.body.classList.toggle('todo-open',visible);document.body.classList.toggle('todo-expanded',visible&&todoExpanded);if(!visible){host.innerHTML='';return}const chevron=todoExpanded?'m3.5 5 3.5 3.5L10.5 5':'m3.5 9 3.5-3.5L10.5 9';host.innerHTML='<button class="todo-header" aria-expanded="'+todoExpanded+'"><span class="todo-lead"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4.75 3h7M4.75 7h7M4.75 11h7M2 3h.01M2 7h.01M2 11h.01" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></span><span class="todo-title">'+L.todoTitle+'</span><span class="todo-progress">'+esc(todoProgress())+'</span><span class="todo-chevron"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="'+chevron+'" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></button>'+(todoExpanded?'<ul class="todo-list">'+currentTodos.map(item=>'<li class="todo-item" data-status="'+esc(item.status)+'"><span class="todo-glyph">'+todoGlyph(item.status)+'</span><span class="todo-content">'+esc(item.content)+'</span></li>').join('')+'</ul>':'')}
  function updateTodos(projections){const value=projections?.values?.todos;if(value===null)currentTodos=[];else if(Array.isArray(value))currentTodos=value.filter(item=>item&&typeof item.content==='string'&&['pending','in_progress','completed'].includes(item.status));renderTodoDock()}
  function presetLabel(preset){const builtIn={standard:L.presetStandard,code:L.presetCode,minimal:L.presetMinimal,cordis:L.presetCordis};const name=preset.trust==='system'&&builtIn[preset.id]?builtIn[preset.id]:preset.name||preset.id;return preset.trust==='user'?name+' · '+L.customPreset:name}
  function presetIsLocked(){return!sessionBlank||optimisticPrompts.length>0}
  function closeSessionSettings(){$('sessionSettings').hidden=true;$('sessionSettings').innerHTML='';$('settings').setAttribute('aria-expanded','false')}
  function normalizeSelection(value){if(!value||typeof value.provider!=='string'||!value.provider||typeof value.model!=='string'||!value.model)return null;const reasoningEffort=typeof value.reasoningEffort==='string'&&value.reasoningEffort?value.reasoningEffort:'';return{provider:value.provider,model:value.model,...(reasoningEffort?{reasoningEffort}:{})}}
  function modelSelectionOf(projections){const selection=projections&&projections.values&&projections.values.modelSelection;return normalizeSelection(selection&&selection.next)}
  function sameModelSelection(left,right){return!!left&&!!right&&left.provider===right.provider&&left.model===right.model&&(left.reasoningEffort||'')===(right.reasoningEffort||'')}
  function showSessionModel(selection){const next=normalizeSelection(selection);if(!next||settingsBusy||!modelCatalog||sameModelSelection(modelCatalog.current,next))return;modelCatalog.current=next;if(!$('sessionSettings').hidden)renderSessionSettings()}
  function selectedModelEntry(){const value=$('modelSelect')?.value||'',parts=value.split('\u001f'),group=(modelCatalog?.groups||[]).find(item=>item.id===parts[0]);return{group,model:group?.models?.find(item=>item.id===parts[1])}}
  function syncEffortOptions(){const field=$('effortField'),select=$('effortSelect'),entry=selectedModelEntry().model,efforts=entry?.reasoning?.efforts||[];if(!field||!select)return;field.hidden=!efforts.length;if(!efforts.length){select.innerHTML='';return}const previous=select.value,current=(modelCatalog?.current??modelCatalog?.default)?.reasoningEffort,preferred=efforts.some(item=>item.id===previous)?previous:efforts.some(item=>item.id===current)?current:entry.reasoning.defaultEffort||efforts[0].id;select.innerHTML=efforts.map(item=>'<option value="'+esc(item.id)+'">'+esc(item.name)+'</option>').join('');select.value=preferred}
  function syncSettingsControls(){const locked=presetIsLocked(),preset=$('presetSelect'),note=$('presetNote');if(preset)preset.disabled=settingsBusy||locked;if(note)note.textContent=locked?L.presetLocked:L.presetEditable;const model=$('modelSelect'),effort=$('effortSelect'),routable=(modelCatalog?.routableProviders?.length??0)>0||modelCatalog?.routable===true;if(model)model.disabled=settingsBusy||!routable;if(effort)effort.disabled=settingsBusy||!routable}
  function renderSessionSettings(){const host=$('sessionSettings');if(!modelCatalog){host.innerHTML='<div class="settings-head"><strong>'+L.sessionSettings+'</strong><button class="settings-close" data-settings-close aria-label="'+L.close+'">×</button></div><div class="settings-loading">'+L.settingsLoading+'</div>';return}const current=modelCatalog.current??modelCatalog.default??{},modelValue=current.provider+'\u001f'+current.model,presetFallback=presets.find(item=>item.isDefault)?.id||presets[0]?.id||'',presetValue=presets.some(item=>item.id===currentPreset)?currentPreset:presetFallback;host.innerHTML='<div class="settings-head"><strong>'+L.sessionSettings+'</strong><button class="settings-close" data-settings-close aria-label="'+L.close+'">×</button></div><label class="setting-field"><span>'+L.model+'</span><select id="modelSelect"'+(!modelCatalog.groups?.length?' disabled':'')+'>'+(modelCatalog.groups||[]).map(group=>'<optgroup label="'+esc(group.name)+'">'+(group.models||[]).map(model=>'<option value="'+esc(group.id+'\u001f'+model.id)+'">'+esc(model.name)+'</option>').join('')+'</optgroup>').join('')+'</select></label><label id="effortField" class="setting-field" hidden><span>'+L.reasoningEffort+'</span><select id="effortSelect"></select></label><label class="setting-field"><span>'+L.preset+'</span><select id="presetSelect">'+presets.map(item=>'<option value="'+esc(item.id)+'">'+esc(presetLabel(item))+'</option>').join('')+'</select></label><div id="presetNote" class="setting-note"></div><div id="settingsError" class="settings-error">'+(!modelCatalog.groups?.length?L.noModels:'')+'</div>';if((modelCatalog.groups||[]).some(group=>(group.models||[]).some(model=>group.id+'\u001f'+model.id===modelValue)))$('modelSelect').value=modelValue;if($('presetSelect'))$('presetSelect').value=presetValue;syncEffortOptions();syncSettingsControls()}
  async function refreshActiveSessionSummary(){if(!activeSession)return;const value=await rpc('session.list',{}),summary=(value.items||[]).find(item=>item.sessionId===activeSession);if(summary){sessionBlank=summary.blank;currentPreset=summary.agentPreset||currentPreset;sessionSummaries=value.items||[]}syncSettingsControls()}
  async function openSessionSettings(){if(!$('sessionSettings').hidden){closeSessionSettings();return}const sessionId=activeSession;if(!sessionId)return;$('sessionSettings').hidden=false;$('settings').setAttribute('aria-expanded','true');modelCatalog=null;renderSessionSettings();try{const [models,presetValue,sessions]=await Promise.all([rpc('session.models',{sessionId}),rpc('agentPreset.list',{}),rpc('session.list',{})]);if(activeSession!==sessionId)return;modelCatalog=models;presets=(presetValue.presets||[]).filter(preset=>!preset.broken);sessionSummaries=sessions.items||[];const summary=sessionSummaries.find(item=>item.sessionId===sessionId);if(summary){sessionBlank=summary.blank;currentPreset=summary.agentPreset||currentPreset}const selected=modelSelectionOf(summary&&summary.projections)||modelSelectionOf(streamProjections);if(selected)modelCatalog.current=selected;renderSessionSettings()}catch(e){if(activeSession!==sessionId)return;modelCatalog={default:{provider:'',model:''},routableProviders:[],groups:[],failures:[]};renderSessionSettings();showError('settingsError',e)}}
  async function selectPreset(){const select=$('presetSelect');if(!select||settingsBusy||presetIsLocked()||!activeSession)return;const previous=currentPreset,next=select.value;if(!next||next===previous)return;settingsBusy=true;syncSettingsControls();try{const value=await rpc('agentPreset.select',{sessionId:activeSession,agentPreset:next});currentPreset=value.agentPreset;showToast(L.settingsUpdated)}catch(e){select.value=previous||select.value;showError('settingsError',e);await refreshActiveSessionSummary().catch(()=>{})}finally{settingsBusy=false;syncSettingsControls()}}
  async function selectModel(chosen){const select=$('modelSelect');if(!select||settingsBusy||!activeSession)return;const entry=chosen||selectedModelEntry(),provider=entry.group?.id,model=entry.model?.id;if(!provider||!model)return;settingsBusy=true;syncSettingsControls();const reasoningEffort=$('effortSelect')?.value||entry.model?.reasoning?.defaultEffort;try{const value=await rpc('session.selectModel',{sessionId:activeSession,provider,model,...(reasoningEffort?{reasoningEffort}:{})});const selected=normalizeSelection(value&&value.selected)||normalizeSelection({provider,model,...(reasoningEffort?{reasoningEffort}:{})});if(selected)modelCatalog.current=selected;renderSessionSettings();showToast(L.settingsUpdated)}catch(e){showError('settingsError',e);syncSettingsControls()}finally{settingsBusy=false;syncSettingsControls()}}
  function durableUserTextCounts(messages){const counts=new Map();for(const message of messages){if(message.role!=='user')continue;const text=message.blocks?.filter(block=>block?.kind==='text').map(block=>block.text).join('\\n')||'';counts.set(text,(counts.get(text)||0)+1)}return counts}
  function messagesWithOptimistic(durable){const counts=durableUserTextCounts(durable);optimisticPrompts=optimisticPrompts.filter(item=>(counts.get(item.text)||0)<item.targetCount);latestUserTextCounts=counts;lastDurableMessages=durable;return[...durable,...optimisticPrompts.map(item=>({role:'user',blocks:[{kind:'text',text:item.text}],optimistic:true}))]}
  function nextOptimisticTarget(text){let target=latestUserTextCounts.get(text)||0;for(const item of optimisticPrompts)if(item.text===text)target=Math.max(target,item.targetCount);return target+1}
  function olderButtonHtml(){return''}
  function paintMessages(messages,stickToBottom=false){const box=$('messages'),nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<90,status=agentRunning&&!pendingQuestion?'<div class="turn-status" role="status" aria-live="polite">'+L.deepDiving+'</div>':'';box.innerHTML=messages.map(renderMessage).join('')+status;box.querySelectorAll('details.turn-process').forEach(el=>el.addEventListener('toggle',()=>{const key=el.dataset.turnKey;if(key!=null)turnOpenState.set(key,el.open)}));if(stickToBottom||nearBottom)box.scrollTop=box.scrollHeight}
  function renderOlderButton(){}
  async function loadOlder(){if(olderBusy||!activeSession)return;const box=$('messages'),anchorSeq=eventSeq(windowEvents()[0]);if(anchorSeq<0)return;olderBusy=true;renderOlderButton();const prevHeight=box.scrollHeight,prevTop=box.scrollTop;try{const value=await rpc('session.history',{sessionId:activeSession,beforeSeq:anchorSeq,maxMessages:30});const records=value.events||[];olderEvents=mergeEntries(records.concat(olderEvents));olderHasMore=value.hasMore===true;const durable=visibleMessages(windowEvents()),messages=messagesWithOptimistic(durable);paintMessages(messages,false);box.scrollTop=prevTop+(box.scrollHeight-prevHeight)}catch(e){showError('chatError',e)}finally{olderBusy=false;renderOlderButton()}}
  function syncTurnStatus(){const box=$('messages'),current=box.querySelector('.turn-status'),visible=agentRunning&&!pendingQuestion;if(visible&&!current)box.insertAdjacentHTML('beforeend','<div class="turn-status" role="status" aria-live="polite">'+L.deepDiving+'</div>');else if(!visible&&current)current.remove()}
  function patchLastStreamMessage(messages){const box=$('messages'),nodes=box.querySelectorAll(':scope > .message'),index=messages.length-1,message=messages[index],nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<90;if(!message||message.role!=='assistant'||index!==nodes.length-1){paintMessages(messages,false);return}nodes[index].outerHTML=renderMessage(message);syncTurnStatus();if(nearBottom)box.scrollTop=box.scrollHeight}
  function recommendation(label){const match=String(label||'').match(/\\s*\\((Recommended|推荐)\\)\\s*$/i);return{label:match?String(label).slice(0,match.index).trim():String(label||''),recommended:!!match}}
  function questionDraft(question){return questionDrafts[question.id]||(questionDrafts[question.id]={selected:[],custom:'',skipped:false})}
  function renderQuestionComposer(){const host=$('questionComposer'),composer=$('composer');if(!pendingQuestion||!pendingQuestion.questions?.length){host.hidden=true;composer.hidden=false;document.body.classList.remove('question-open');host.innerHTML='';return}questionIndex=Math.max(0,Math.min(questionIndex,pendingQuestion.questions.length-1));const question=pendingQuestion.questions[questionIndex],draft=questionDraft(question),options=question.options||[],last=questionIndex===pendingQuestion.questions.length-1;host.hidden=false;composer.hidden=true;document.body.classList.add('question-open');host.innerHTML='<div class="question-shell"><div class="question-top"><span class="question-mark">'+activityIcon('tool')+'</span><div class="question-context"><strong>'+esc(question.header||L.questionNeeded)+'</strong><span>'+(questionIndex+1)+' / '+pendingQuestion.questions.length+' '+L.questionProgress+'</span></div><button class="question-close" data-question-action="cancel" aria-label="'+esc(L.cancelQuestions)+'">×</button></div><div class="question-body"><h2 class="question-title">'+esc(question.question)+'</h2>'+(question.detail?'<div class="question-detail markdown">'+markdown(question.detail)+'</div>':'')+(options.length?'<div class="question-options'+(question.multiSelect?' multi':'')+'">'+options.map((option,index)=>{const display=recommendation(option.label),selected=draft.selected.includes(option.label);return'<button class="question-option'+(selected?' selected':'')+'" data-option-index="'+index+'"><span class="option-control">'+(selected?'✓':'')+'</span><span class="option-copy"><span class="option-label">'+esc(display.label)+(display.recommended?'<span class="recommendation">'+L.recommended+'</span>':'')+'</span>'+(option.description?'<span class="option-description">'+esc(option.description)+'</span>':'')+'</span></button>'}).join('')+'</div>':'')+'<label class="custom-label" for="questionCustom">'+L.customAnswer+'</label><textarea id="questionCustom" class="question-custom" placeholder="'+esc(L.customPlaceholder)+'">'+esc(draft.custom)+'</textarea></div><div id="questionError" class="question-error"></div><div class="question-actions">'+(questionIndex?'<button data-question-action="previous">'+L.previous+'</button>':'<button data-question-action="cancel">'+L.cancelQuestions+'</button>')+'<span class="spacer"></span><button data-question-action="skip">'+L.skip+'</button><button class="submit-answer" data-question-action="continue">'+(questionBusy?L.answering:last?L.submitAnswer:L.next)+'</button></div></div>';host.querySelectorAll('button').forEach(button=>button.disabled=questionBusy)}
  function syncPendingQuestion(next){const changed=(pendingQuestion?.rpcId||null)!==(next?.rpcId||null);pendingQuestion=next;if(changed){questionIndex=0;questionDrafts={};questionBusy=false;renderQuestionComposer()}}
  function advanceQuestion(skip=false){if(!pendingQuestion||questionBusy)return;const question=pendingQuestion.questions[questionIndex],draft=questionDraft(question);draft.custom=String($('questionCustom')?.value||'').trim();if(skip){draft.selected=[];draft.custom='';draft.skipped=true}else{draft.skipped=false;if(!draft.selected.length&&!draft.custom){$('questionError').textContent=L.chooseAnswer;return}}if(questionIndex<pendingQuestion.questions.length-1){questionIndex+=1;renderQuestionComposer()}else submitQuestionAnswers()}
  async function submitQuestionAnswers(){if(!pendingQuestion||questionBusy)return;questionBusy=true;renderQuestionComposer();const current=pendingQuestion;const answers=current.questions.map(question=>{const draft=questionDraft(question);return{id:question.id,selected:!question.multiSelect&&draft.custom?[]:draft.selected,...(draft.custom?{custom:draft.custom}:{})}});try{await rpc('interaction.answer',{rpcId:current.rpcId,sessionId:current.sessionId,answers});lastHistoryKey='';await loadHistory(false)}catch(e){questionBusy=false;renderQuestionComposer();showError('questionError',e)}}
  async function cancelQuestionRequest(){if(!pendingQuestion||questionBusy)return;questionBusy=true;renderQuestionComposer();const current=pendingQuestion;try{await rpc('interaction.cancel',{rpcId:current.rpcId,sessionId:current.sessionId});lastHistoryKey='';await loadHistory(false)}catch(e){questionBusy=false;renderQuestionComposer();showError('questionError',e)}}
async function loadListData(){const [wsValue,sessValue,settingsValue]=await Promise.all([rpc('workspace.list'),rpc('session.list',{}),rpc('settings.describe',{}).catch(()=>null)]);applyBootData({ws:wsValue,sess:sessValue,settings:settingsValue?extractMobileSettings(settingsValue):null})}
function applyBootData(b){const ws=b.ws||{},sessInput=b.sess||{};const serverItems=ws.items||[],archivedIds=ws.archivedSessionIds||[];workspaces=serverItems.map(w=>({...w,sessionIds:[...(Array.isArray(w.sessionIds)?w.sessionIds:[])]}));pendingCreatedSessions=${applyPendingCreatedSessions.name}(workspaces,pendingCreatedSessions,serverItems,archivedIds);archivedSessionIds=archivedIds;sessionSummaries=sessInput.items||[];if(b.settings){busyEnter=b.settings.busyEnter==='steer'?'steer':'queue';transcriptView=['compact','standard','detailed','verbose'].includes(b.settings.transcriptView)?b.settings.transcriptView:'standard';performanceUsage=b.settings.performanceUsage==='compact'?'compact':'detailed'}if(!expandedInitDone){expandedInitDone=true;if(workspaces.length)expandedWsIds.add(workspaces[0].workspaceId)}}
function taskGlyph(state){if(state==='running')return'<svg class="spin" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 2a7 7 0 1 1-6.06 3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';if(state==='error')return'<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7.2" fill="currentColor"/><path d="M9 5v4.4" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="9" cy="12.1" r=".95" fill="#fff"/></svg>';if(state==='awaiting')return'<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7.2" fill="currentColor"/><path d="M6.6 6.9c.2-1 1.2-1.7 2.4-1.7 1.4 0 2.5.8 2.5 2 0 1-.7 1.5-1.7 2-.9.4-1.2.8-1.2 1.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><circle cx="9.1" cy="12.8" r=".9" fill="#fff"/></svg>';if(state==='blank')return'<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.5 2.5"/></svg>';return'<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7.2" fill="currentColor"/><path d="m5.7 9.2 2.2 2.2 4.4-4.7" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
function taskState(s){if(s.awaitingQuestion)return'awaiting';if(s.error||s.lastError||s.status==='error')return'error';if(s.running)return'running';if(s.blank)return'blank';return'done'}
function renderWorkspaces(){const host=$('workspaces');if(!workspaces.length){host.innerHTML='<div class="ws-empty">'+esc(L.noWorkspaces)+'</div>';return}host.innerHTML=workspaces.map(w=>{const byId=new Map(sessionSummaries.map(s=>[s.sessionId,s]));const tasks=(w.sessionIds||[]).map(id=>byId.get(id)||{sessionId:id,updatedAt:0,blank:true,missingSummary:true}).filter(s=>!s.blank).sort((a,b)=>b.updatedAt-a.updatedAt);const latest=tasks[0]?taskState(tasks[0]):null;const expanded=expandedWsIds.has(w.workspaceId);return'<article class="ws-card'+(expanded?' expanded':'')+'" data-ws="'+esc(w.workspaceId)+'"><div class="ws-head"><button class="ws-toggle" data-action="toggle" aria-expanded="'+expanded+'"><span class="ws-chevron"><svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="m5 3 4.5 4L5 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="ws-name">'+esc(w.title||w.path)+'</span>'+(latest?'<span class="ws-last is-'+latest+'">'+taskGlyph(latest)+'</span><span class="ws-last-time">'+esc(timeFor(tasks[0]))+'</span>':'')+'<span class="ws-count">'+tasks.length+L.taskUnit+'</span></button><button class="ws-new" data-action="new" aria-label="'+esc(L.newChat)+'"><svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div><div class="ws-body"><div class="task-list">'+(tasks.length?tasks.map(s=>{const state=taskState(s);return'<button class="task-row is-'+state+'" data-action="open" data-id="'+esc(s.sessionId)+'"><span class="task-status">'+taskGlyph(state)+'</span><span class="task-copy"><strong>'+esc(titleFor(s))+'</strong><time>'+esc(timeFor(s))+'</time></span></button>'}).join(''):'<div class="ws-empty">'+esc(L.noTasksHint)+'</div>')+'</div></div></article>'}).join('')}
function relativeTime(value){const parsed=typeof value==='number'?value:Date.parse(value),elapsed=Math.max(0,Date.now()-(Number.isFinite(parsed)?parsed:Date.now())),minutes=Math.floor(elapsed/60000);if(minutes<1)return L.justNow;if(minutes<60)return minutes+L.minute;const hours=Math.floor(minutes/60);if(hours<24)return hours+L.hour;return Math.floor(hours/24)+L.day}function timeFor(s){if(!s)return'';if(s.missingSummary)return'';return s.running?L.justNow:relativeTime(s.updatedAt)}
async function createSessionIn(workspaceId){const workspace=workspaces.find(w=>w.workspaceId===workspaceId);if(!workspace)return;try{const created=await rpc('session.create',{workspaceId});const ids=workspace.sessionIds||[];if(!ids.includes(created.sessionId))workspace.sessionIds=[created.sessionId,...ids];if(!pendingCreatedSessions.some(item=>item.workspaceId===workspaceId&&item.sessionId===created.sessionId))pendingCreatedSessions.push({workspaceId,sessionId:created.sessionId});sessionSummaries.push({sessionId:created.sessionId,updatedAt:Date.now(),running:false,blank:true,awaitingQuestion:false,agentPreset:created.agentPreset});expandedWsIds.add(workspaceId);await openSession(created.sessionId)}catch(e){showError('listError',e)}}
async function refreshList(showFeedback=false){try{await loadListData();renderWorkspaces();$('listError').textContent='';if(showFeedback)showToast(L.refreshed)}catch(e){showError('listError',e)}}
let hiddenAt=0,resumeInFlight=false;
const RESUME_AUTO_JUMP_MS=120000;
function pickFocusSession(){const list=sessionSummaries.filter(s=>!s.missingSummary&&!s.blank);if(!list.length)return null;if(list.length===1)return list[0];const awaiting=list.filter(s=>s.awaitingQuestion);if(awaiting.length){awaiting.sort((a,b)=>b.updatedAt-a.updatedAt);return awaiting[0]}const running=list.filter(s=>s.running);if(running.length){running.sort((a,b)=>b.updatedAt-a.updatedAt);return running[0]}return[...list].sort((a,b)=>b.updatedAt-a.updatedAt)[0]}
async function resumeOnReturn(hiddenForMs){if(resumeInFlight||activeSession)return;resumeInFlight=true;try{try{await loadListData()}catch(e){showError('listError',e);return}renderWorkspaces();$('listError').textContent='';if(hiddenForMs<RESUME_AUTO_JUMP_MS)return;const target=pickFocusSession();if(target)await openSession(target.sessionId,titleFor(target))}finally{resumeInFlight=false}}
function showToast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>$('toast').classList.remove('show'),1000)}
function titleFor(s){const p=s.projections&&s.projections.values||{};return p.title||p.sessionTitle||p['session.title']||L.untitled}
function extractMobileSettings(d){const namespaces=Array.isArray(d?.namespaces)?d.namespaces:[],byNs=new Map(namespaces.map(ns=>[String(ns.ns),ns.value||{}])),conversation=byNs.get('ui-conversation')||{},chat=byNs.get('ui-chat')||{};return{busyEnter:conversation.busyEnter==='steer'?'steer':'queue',transcriptView:['compact','standard','detailed','verbose'].includes(chat.transcriptView)?chat.transcriptView:'standard',performanceUsage:chat.performanceUsage==='compact'?'compact':'detailed'}}
  function applyInheritedSettings(s){if(!s)return false;const next={busyEnter:s.busyEnter==='steer'?'steer':'queue',transcriptView:['compact','standard','detailed','verbose'].includes(s.transcriptView)?s.transcriptView:'standard',performanceUsage:s.performanceUsage==='compact'?'compact':'detailed'},changed=next.busyEnter!==busyEnter||next.transcriptView!==transcriptView||next.performanceUsage!==performanceUsage;if(!changed)return false;busyEnter=next.busyEnter;transcriptView=next.transcriptView;performanceUsage=next.performanceUsage;syncSettingsControls();if(activeSession&&lastDurableMessages.length)paintMessages(messagesWithOptimistic(lastDurableMessages),false);return true}
  function resetOptimisticMessages(){lastDurableMessages=[];optimisticPrompts=[];latestUserTextCounts=new Map();awaitingTurnStartedAt=0;agentRunning=false;currentTodos=[];todoExpanded=false;renderTodoDock()}
  function closeSessionStream(){if(sessionStream)sessionStream.close();if(streamRenderFrame!==null)cancelAnimationFrame(streamRenderFrame);if(pendingSyncTimer!==null)clearTimeout(pendingSyncTimer);sessionStream=null;tokenStream=null;streamConnected=false;streamEvents=[];olderEvents=[];olderHasMore=false;olderBusy=false;streamProjections=null;streamRenderFrame=null;streamNeedsFullPaint=false;streamRevision=0;pendingSyncTimer=null}
  function applyHistory(value,pending,initial){if(pending!==undefined)syncPendingQuestion(pending);if(streamConnected){olderHasMore=olderHasMore||value.hasMore===true}else{
    // Never let an empty page erase a conversation that is already on screen.
    // 2026-10-01: this fallback runs when the live stream has not delivered its
    // first snapshot within ~900ms; it used to assign the fetched events
    // unconditionally, so an empty history page blanked the chat the handoff had
    // just painted. The stream (and the next poll) still own the truth.
    const fetched=Array.isArray(value.events)?value.events:[];
    if(fetched.length||!streamEvents.length){streamEvents=fetched;olderHasMore=value.hasMore===true}}const events=windowEvents(),durable=visibleMessages(events);if(durable.some(message=>message.role==='user'))sessionBlank=false;const messages=messagesWithOptimistic(durable);updateRunning(events);updateTodos(value.projections);const key=JSON.stringify([messages,pendingQuestion?.rpcId||null,agentRunning,currentTodos,todoExpanded]);syncSettingsControls();showSessionModel(modelSelectionOf(value.projections));if(key!==lastHistoryKey){paintMessages(messages,initial);lastHistoryKey=key;idlePollMs=HISTORY_POLL_IDLE_MS}renderOlderButton()}
  function flushStreamRender(sessionId){streamRenderFrame=null;if(activeSession!==sessionId)return;const durable=visibleMessages(windowEvents()),messages=messagesWithOptimistic(durable);if(tokenStream&&tokenStream.text)messages.push({role:'assistant',streaming:true,blocks:[{kind:'text',text:tokenStream.text}]});if(durable.some(message=>message.role==='user'))sessionBlank=false;updateRunning(windowEvents());syncSettingsControls();if(streamNeedsFullPaint)paintMessages(messages,false);else patchLastStreamMessage(messages);streamNeedsFullPaint=false;lastHistoryKey='';idlePollMs=HISTORY_POLL_IDLE_MS}
  function queueStreamRender(sessionId,fullPaint){streamNeedsFullPaint=streamNeedsFullPaint||fullPaint;if(streamRenderFrame===null)streamRenderFrame=requestAnimationFrame(()=>flushStreamRender(sessionId))}
  function tokenChunkText(value){if(typeof value==='string')return value;if(value&&typeof value==='object'){for(const key of ['text','delta','content']){if(typeof value[key]==='string')return value[key]}}return''}
  function schedulePendingSync(sessionId){if(pendingSyncTimer!==null)return;pendingSyncTimer=setTimeout(()=>{pendingSyncTimer=null;if(activeSession===sessionId)void rpc('interaction.pending',{sessionId}).then(syncPendingQuestion).catch(()=>{})},PENDING_SYNC_DEBOUNCE_MS)}
  function openSessionStream(sessionId){armStreamSnapshot();const source=new EventSource('/api/session/stream?sessionId='+encodeURIComponent(sessionId)+(streamSinceSeq>=0?'&sinceSeq='+streamSinceSeq:''));sessionStream=source;source.addEventListener('status',event=>{if(activeSession!==sessionId)return;let frame;try{frame=JSON.parse(event.data)}catch{return}applyLiveStatus(frame)});source.addEventListener('snapshot',event=>{if(activeSession!==sessionId)return;const frame=JSON.parse(event.data);const incoming=frame.records||[];streamEvents=streamSinceSeq>=0?mergeEntries(streamEvents.concat(incoming)):incoming;streamProjections=frame.projections;streamConnected=true;streamRevision+=1;applyHistory({events:streamEvents,projections:streamProjections,hasMore:frame.hasMore===true},pendingQuestion,false);markStreamSnapshot(true)});source.addEventListener('event',event=>{if(activeSession!==sessionId)return;const frame=JSON.parse(event.data),entry=frame.event||frame,type=String(entry.type||'').toLowerCase();if(type==='model/selection')showSessionModel(entry.data);streamEvents.push(frame);streamRevision+=1;queueStreamRender(sessionId,type!=='assistant/chunk');if(type!=='assistant/chunk')schedulePendingSync(sessionId)});source.addEventListener('token',event=>{if(activeSession!==sessionId)return;let frame;try{frame=JSON.parse(event.data)}catch{return}const kind=String(frame.type||'');if(kind==='start'){tokenStream={revision:frame.revision??null,text:'',seen:new Set()};return}if(kind==='chunk'){if(!tokenStream)tokenStream={revision:frame.revision??null,text:'',seen:new Set()};const key=String(frame.revision??'')+':'+String(frame.index??'');if(tokenStream.seen.has(key))return;tokenStream.seen.add(key);const piece=tokenChunkText(frame.chunk);if(piece){tokenStream.text+=piece;queueStreamRender(sessionId,false)}}else if(kind==='end'){const outcome=frame.outcome||null;const abandoned=!!outcome&&outcome.kind==='abandoned';tokenStream=null;if(abandoned)void loadHistory(false)}});source.addEventListener('failure',event=>{if(activeSession!==sessionId)return;let frame;try{frame=JSON.parse(event.data)}catch{return};showError('chatError',{message:(frame.message||L.streamFailure)+(frame.code?' ('+frame.code+')':'')})});source.onerror=()=>{streamConnected=false;markStreamSnapshot(false);schedulePoll()}}
  async function showSessionList(){clearTimeout(poll);poll=null;if(activeSession&&streamEvents.length){sessionCache.set(activeSession,{streamEvents,olderEvents,olderHasMore,streamProjections})}closeSessionStream();closeSessionSettings();activeSession=null;resetOptimisticMessages();syncPendingQuestion(null);document.body.classList.remove('chat-open');$('chatView').classList.remove('active');$('sessionsView').classList.add('active');await refreshList(false)}
function paintInstantHistory(events,projections){const durable=visibleMessages(events);if(durable.some(message=>message.role==='user'))sessionBlank=false;const messages=messagesWithOptimistic(durable);updateRunning(events);updateTodos(projections);syncSettingsControls();showSessionModel(modelSelectionOf(projections));paintMessages(messages,false);const box=$('messages');box.scrollTop=box.scrollHeight}
  function paintInstantSession(allowEmbedded){// Cold-open embedded last turn wins once; otherwise reuse the cached live
    // state from the last visit so re-entering a running chat paints instantly
    // instead of showing a skeleton and re-parsing everything after a round trip.
    if(allowEmbedded&&embeddedFocus&&embeddedFocus.sessionId===activeSession){streamEvents=embeddedFocus.history.events||[];olderEvents=[];olderHasMore=embeddedFocus.history.hasMore===true;streamProjections=embeddedFocus.history.projections||null;embeddedFocus=null;paintInstantHistory(windowEvents(),streamProjections);return true}
    const cached=sessionCache.get(activeSession)
    if(cached&&cached.streamEvents.length){streamEvents=cached.streamEvents;olderEvents=cached.olderEvents;olderHasMore=cached.olderHasMore;streamProjections=cached.streamProjections;paintInstantHistory(windowEvents(),streamProjections);return true}
    return false}
  async function openSession(id,title,fromHistory=false){clearTimeout(poll);closeSessionStream();if(!fromHistory)history.pushState({view:'chat',sessionId:id,title:title||L.untitled},'');activeSession=id;const summary=sessionSummaries.find(item=>item.sessionId===id);sessionBlank=summary?.blank??true;currentPreset=summary?.agentPreset||null;modelCatalog=null;closeSessionSettings();lastHistoryKey='';resetOptimisticMessages();syncPendingQuestion(null);document.body.classList.add('chat-open');$('sessionsView').classList.remove('active');$('chatView').classList.add('active');const hadInstant=paintInstantSession(!fromHistory);if(!hadInstant||!$('messages').querySelector('.message'))$('messages').innerHTML='<div class="loading"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';openSessionStream(id);
  // Prefer the live SSE snapshot for the first screen. Fall back to the RPC
  // history only if the first frame is slow (~900ms) or the stream errors, so
  // a healthy connection never fetches the same page twice.
  const firstFrame=await Promise.race([streamSnapshotReady,new Promise(resolve=>setTimeout(()=>resolve('timeout'),900))]);
  if(activeSession===id&&firstFrame!==true&&!handoffPainted)await loadHistory(true);
  handoffPainted=false;
  schedulePoll()}
function handleHistory(state){if(state?.view==='chat'&&state.sessionId)openSession(state.sessionId,state.title,true);else showSessionList()}
  // Each poll refetches the last 100 messages through Harness, so an idle chat
  // left open used to cost the desktop a full history serialisation every
  // 750ms indefinitely. Back off while nothing changes, and stop entirely
  // while the tab is hidden.
  function schedulePoll(){clearTimeout(poll);poll=null;if(!activeSession||document.hidden)return;const delay=streamConnected?HISTORY_POLL_IDLE_CAP_MS:agentRunning||pendingQuestion?HISTORY_POLL_ACTIVE_MS:idlePollMs;poll=setTimeout(()=>{void loadHistory(false)},delay)}
  async function loadHistory(initial){if(!activeSession||historyBusy)return;historyBusy=true;const revision=streamRevision;try{const sessionId=activeSession;let value=null,pending;if(streamConnected){// The live SSE snapshot already painted the first screen; do not fetch the
        // same last-turn page a second time. Only refresh the pending question.
        pending=await rpc('interaction.pending',{sessionId})}else{[value,pending]=await Promise.all([rpc('session.history',{sessionId,maxMessages:30}),rpc('interaction.pending',{sessionId})])}if(activeSession!==sessionId)return;if(streamConnected&&streamRevision!==revision){syncPendingQuestion(pending);return}if(value)applyHistory(value,pending,initial);else syncPendingQuestion(pending);if(!streamConnected&&!agentRunning&&!pendingQuestion)idlePollMs=Math.min(Math.round(idlePollMs*1.5),HISTORY_POLL_IDLE_CAP_MS);$('chatError').textContent=''}catch(e){showError('chatError',e)}finally{historyBusy=false;schedulePoll()}}
async function send(){const prompt=$('prompt'),text=prompt.value.trim();if(!text||!activeSession)return;const sendMode=agentRunning?busyEnter:'queue';const optimistic={id:String(Date.now())+Math.random(),text,targetCount:nextOptimisticTarget(text)};optimisticPrompts.push(optimistic);sessionBlank=false;awaitingTurnStartedAt=Date.now()-1000;agentRunning=true;syncSettingsControls();prompt.value='';syncPromptUi();paintMessages([...lastDurableMessages,...optimisticPrompts.map(item=>({role:'user',blocks:[{kind:'text',text:item.text}],optimistic:true}))],true);lastHistoryKey='';try{await rpc('session.prompt',{sessionId:activeSession,mode:sendMode,content:[{type:'text',text}],clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});await loadHistory(false)}catch(e){optimisticPrompts=optimisticPrompts.filter(item=>item.id!==optimistic.id);awaitingTurnStartedAt=0;agentRunning=false;showError('chatError',e);prompt.value=text;paintMessages([...lastDurableMessages,...optimisticPrompts.map(item=>({role:'user',blocks:[{kind:'text',text:item.text}],optimistic:true}))],true);await refreshActiveSessionSummary().catch(()=>{})}finally{syncPromptUi();syncSettingsControls()}}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
// Keyboard handling: only a real height change (keyboard show/hide) may resize
// the shell. visualViewport "scroll" fires many times while panning and must NOT
// relayout or fight the browser's own input scrolling (that was the focus jank).
let viewportRaf=0,lastAppHeight=0
// Android/Chromium uses interactive-widget=resizes-content: the layout viewport
// (and 100dvh) resizes natively with the keyboard, so driving --app-height from
// visualViewport every frame double-relayouts and makes the composer stutter.
// Only Apple WebKit (which ignores interactive-widget) needs the JS height.
const appleTouchDevice=/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)
function applyViewportHeight(){viewportRaf=0;if(!appleTouchDevice)return;const viewport=window.visualViewport;const h=Math.round(viewport?.height||window.innerHeight);if(h&&h!==lastAppHeight){lastAppHeight=h;document.documentElement.style.setProperty('--app-height',h+'px')}}
function scheduleViewport(){if(!appleTouchDevice||viewportRaf)return;viewportRaf=requestAnimationFrame(applyViewportHeight)}
document.addEventListener('visibilitychange',()=>{if(document.hidden){hiddenAt=Date.now();clearTimeout(poll);poll=null;return}const wasHiddenForMs=hiddenAt?Date.now()-hiddenAt:0;hiddenAt=0;idlePollMs=HISTORY_POLL_IDLE_MS;if(activeSession)void loadHistory(false);else void resumeOnReturn(wasHiddenForMs);void checkConnection()});
window.addEventListener('pageshow',event=>{if(event.persisted&&!activeSession){const forMs=hiddenAt?Date.now()-hiddenAt:0;hiddenAt=0;void resumeOnReturn(forMs)}});
window.visualViewport?.addEventListener('resize',scheduleViewport);window.addEventListener('resize',scheduleViewport);applyViewportHeight();
history.replaceState({view:'sessions'},'');window.addEventListener('popstate',event=>handleHistory(event.state));
  $('workspaces').onclick=e=>{const card=e.target.closest('.ws-card');if(!card)return;const wsId=card.dataset.ws,btn=e.target.closest('button[data-action]');if(!btn)return;const action=btn.dataset.action;if(action==='new'){e.stopPropagation();void createSessionIn(wsId)}else if(action==='toggle'){if(expandedWsIds.has(wsId))expandedWsIds.delete(wsId);else expandedWsIds.add(wsId);renderWorkspaces()}else if(action==='open'){void openSession(btn.dataset.id)}};
  $('listRefresh').onclick=()=>{const btn=$('listRefresh');if(btn.classList.contains('spinning'))return;btn.classList.add('spinning');refreshList(true).finally(()=>{setTimeout(()=>btn.classList.remove('spinning'),400)})};
  // Pull-older: reaching the top edge auto-loads the previous page (debounced
  // by olderBusy). The #messages element is reused across sessions.
  // Pull-to-refresh: the whole list follows the finger; a ring fills above it.
  // Releasing loads only when the ring is full, otherwise it springs back.
  (()=>{const box=$('messages'),ind=$('pullIndicator'),ring=$('pullRingFill'),C=2*Math.PI*17,THRESHOLD=72;let active=false,startY=0,d=0,ready=false;
  ring.style.strokeDashoffset=String(C);
  function paint(){box.style.transform=d?'translateY('+d.toFixed(1)+'px)':'';ring.style.strokeDashoffset=(C*(1-Math.min(d/THRESHOLD,1))).toFixed(2);ind.classList.toggle('active',d>0)}
  box.addEventListener('touchstart',e=>{if(box.scrollTop<=0&&olderHasMore&&!olderBusy){active=true;startY=e.touches[0].clientY;d=0;ready=false;box.classList.add('pulling');box.classList.remove('animating');ind.classList.remove('busy');paint()}},{passive:true});
  box.addEventListener('touchmove',e=>{if(!active)return;const dy=e.touches[0].clientY-startY;if(dy<=0)return;e.preventDefault();d=Math.min(dy*0.5,110);ready=d>=THRESHOLD;paint()},{passive:false});
  async function end(){if(!active)return;active=false;box.classList.remove('pulling');box.classList.add('animating');if(ready){d=56;paint();ind.classList.add('busy');try{await loadOlder()}finally{d=0;paint();ind.classList.remove('busy')}}else{d=0;paint()}setTimeout(()=>box.classList.remove('animating'),280)}
  box.addEventListener('touchend',()=>{void end()},{passive:true});box.addEventListener('touchcancel',()=>{void end()},{passive:true})})();
  $('settings').onclick=openSessionSettings;$('sessionSettings').onclick=e=>{if(e.target.closest('[data-settings-close]'))closeSessionSettings()};$('sessionSettings').onchange=e=>{if(e.target.id==='presetSelect')selectPreset();else if(e.target.id==='modelSelect'){const chosen=selectedModelEntry();syncEffortOptions();selectModel(chosen)}else if(e.target.id==='effortSelect')selectModel()};$('todoDock').onclick=e=>{if(e.target.closest('.todo-header')){todoExpanded=!todoExpanded;renderTodoDock();lastHistoryKey='';paintMessages(messagesWithOptimistic(lastDurableMessages),false)}};$('send').onclick=send;$('prompt').oninput=syncPromptUi;$('prompt').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();send()}};$('back').onclick=()=>{if(history.state?.view==='chat')history.back();else showSessionList()};$('cancel').onclick=async()=>{if(activeSession){awaitingTurnStartedAt=0;await rpc('session.cancel',{sessionId:activeSession});lastHistoryKey='';await loadHistory(false)}};$('questionComposer').onclick=e=>{const option=e.target.closest('[data-option-index]');if(option&&pendingQuestion&&!questionBusy){const question=pendingQuestion.questions[questionIndex],draft=questionDraft(question),label=question.options[Number(option.dataset.optionIndex)]?.label;if(label){draft.skipped=false;if(question.multiSelect)draft.selected=draft.selected.includes(label)?draft.selected.filter(item=>item!==label):[...draft.selected,label];else{draft.selected=[label];draft.custom=''}renderQuestionComposer()}return}const action=e.target.closest('[data-question-action]')?.dataset.questionAction;if(action==='continue')advanceQuestion(false);else if(action==='skip')advanceQuestion(true);else if(action==='cancel')cancelQuestionRequest();else if(action==='previous'&&pendingQuestion){const question=pendingQuestion.questions[questionIndex],draft=questionDraft(question);draft.custom=String($('questionCustom')?.value||'').trim();questionIndex=Math.max(0,questionIndex-1);renderQuestionComposer()}};$('questionComposer').oninput=e=>{if(e.target.id==='questionCustom'&&pendingQuestion){const question=pendingQuestion.questions[questionIndex],draft=questionDraft(question);draft.custom=e.target.value;if(!question.multiSelect&&draft.custom.trim()){draft.selected=[];$('questionComposer').querySelectorAll('.question-option.selected').forEach(option=>{option.classList.remove('selected');const control=option.querySelector('.option-control');if(control)control.textContent=''})}}};$('questionComposer').onkeydown=e=>{if(e.target.id==='questionCustom'&&e.key==='Enter'&&(e.metaKey||e.ctrlKey)&&!e.isComposing&&e.keyCode!==229){e.preventDefault();advanceQuestion(false)}};document.addEventListener('click',e=>{if(!$('sessionSettings').hidden&&!e.target.closest('#sessionSettings')&&!e.target.closest('#settings'))closeSessionSettings()});document.addEventListener('keydown',e=>{if(e.key==='Escape')closeSessionSettings()});
const unreachableCopy=${scriptJson(zh ? '远程地址已失效，请在电脑上的「连接手机」扫描新二维码' : 'This remote address is no longer valid. Scan the new QR code in Connect Phone on the computer.')};
const tunnelWarnCopy=${scriptJson(zh ? '远程链接约 {n} 分钟后失效，请及时收尾' : 'This remote link expires in about {n} min. Finish up soon.')};
const deviceExpiryCopy=${scriptJson(zh ? '授权至 {time}' : 'Authorized until {time}')};
let unreachableStreak=0,tunnelExpiryTimer=null;
function showUnreachableOverlay(){let host=$('unreachable');if(!host){host=document.createElement('div');host.id='unreachable';host.style.cssText='position:fixed;inset:0;z-index:9;display:grid;place-items:center;padding:24px;background:color-mix(in srgb,var(--paper) 88%,transparent)';host.innerHTML='<div style="max-width:320px;text-align:center"><strong style="font-size:20px">'+${scriptJson(zh ? '连接已断开' : 'Connection lost')}+'</strong><p style="color:var(--muted);line-height:1.6">'+unreachableCopy+'</p></div>';document.body.appendChild(host)}host.hidden=false}
function hideUnreachableOverlay(){const host=$('unreachable');if(host)host.hidden=true}
function renderTunnelWarning(expiresAt){const host=$('tunnelWarn');if(!host)return;if(!expiresAt){host.hidden=true;document.body.classList.remove('tunnel-warn-open');return}const minutes=Math.max(0,Math.ceil((expiresAt-Date.now())/60000));host.textContent=tunnelWarnCopy.replace('{n}',String(minutes));const show=minutes>0;host.hidden=!show;document.body.classList.toggle('tunnel-warn-open',show)}
function formatDeviceExpiryTime(expiresAt){const d=new Date(expiresAt);const p=(n)=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())}
function renderDeviceExpiry(body){const el=document.getElementById('deviceExpiry');if(!el)return;if(body&&typeof body.expiresAt==='number'){el.textContent=deviceExpiryCopy.replace('{time}',formatDeviceExpiryTime(body.expiresAt));el.hidden=false}else{el.textContent='';el.hidden=true}}
async function checkConnection(){if(document.hidden)return;if(Date.now()-lastLiveStatusAt<8000)return;const status=$('status');try{const response=await fetch('/api/status',{cache:'no-store'});status.classList.remove('connecting','error-state');if(response.ok){unreachableStreak=0;hideUnreachableOverlay();status.setAttribute('aria-label',${scriptJson(zh ? '已连接' : 'Connected')});let body={};try{body=await response.json()}catch{}applyInheritedSettings(body.settings);renderTunnelWarning(typeof body.tunnelExpiresAt==='number'?body.tunnelExpiresAt:undefined);renderDeviceExpiry(body)}else{if(response.status===401){location.replace('/disconnected');return}status.classList.add('error-state');$('listError').textContent='';$('chatError').textContent='';status.setAttribute('aria-label',${scriptJson(zh ? '已断开' : 'Disconnected')})}}catch{status.classList.remove('connecting');status.classList.add('error-state');$('listError').textContent='';$('chatError').textContent='';status.setAttribute('aria-label',${scriptJson(zh ? '已断开' : 'Disconnected')});unreachableStreak+=1;if(unreachableStreak>=3)showUnreachableOverlay()}}
setInterval(checkConnection,5000);checkConnection();
let handoffBoot=null,handoffPainted=false,streamSinceSeq=-1,lastLiveStatusAt=0,noServiceWorker=false;
// A browser that refused the shell worker once (the phone does: /sw.js 404s)
// must not pay a failed registration on every open — the shell is only ever a
// bonus here, never a requirement.
try{noServiceWorker=sessionStorage.getItem('${POCKET_NO_SW_KEY}')==='1'}catch{}
// Read (and consume) the payload the pairing page left in this tab. Consumed on
// purpose: a later reload must fetch its own, not repaint a stale one.
function takeHandoffBoot(){try{const raw=sessionStorage.getItem('${POCKET_BOOT_KEY}');if(!raw)return null;sessionStorage.removeItem('${POCKET_BOOT_KEY}');const parsed=JSON.parse(raw);if(parsed&&parsed.ws&&parsed.sess){handoffBoot=parsed;return parsed}}catch{}return null}
// The handoff payload is a full page of records; the stream's opening snapshot
// only has to bring what is newer than it (the bridge drops the rest), and the
// paint it just produced is fresh enough to skip the 900ms fallback fetch.
function noteHandoffCoverage(boot){const events=boot&&boot.focus&&boot.focus.history?boot.focus.history.events:null;if(!Array.isArray(events)||!events.length)return;streamSinceSeq=events.reduce((max,entry)=>Math.max(max,eventSeq(entry)),-1);if(streamSinceSeq>=0)handoffPainted=true}
// Connection state rides the live stream, so the poll is only a safety net.
function applyLiveStatus(body){lastLiveStatusAt=Date.now();unreachableStreak=0;hideUnreachableOverlay();const status=$('status');if(status){status.classList.remove('connecting','error-state');status.setAttribute('aria-label',${scriptJson(zh ? '已连接' : 'Connected')})}applyInheritedSettings(body.settings);renderTunnelWarning(typeof body.tunnelExpiresAt==='number'?body.tunnelExpiresAt:undefined);renderDeviceExpiry(body)}
(async()=>{
  try{if('serviceWorker'in navigator&&!noServiceWorker){navigator.serviceWorker.register('/sw.js').catch(()=>{noServiceWorker=true;try{sessionStorage.setItem('${POCKET_NO_SW_KEY}','1')}catch{}})}
  const boot=takeHandoffBoot()||window.__POCKET_BOOT__;if(boot&&boot.ws&&boot.sess){applyBootData(boot);if(boot.focus&&boot.focus.history){embeddedFocus=boot.focus;noteHandoffCoverage(boot)}}else{await loadListData()}renderWorkspaces();const target=pickFocusSession();if(target){await openSession(target.sessionId,titleFor(target));provisionalSession=true}else if(document.body.classList.contains('chat-open'))void showSessionList();
  if(!handoffBoot)reconcileBoot()}catch(e){showError('listError',e)}})();
let provisionalSession=false;
['click','touchstart','keydown'].forEach((type)=>document.addEventListener(type,()=>{provisionalSession=false},{once:true,passive:true}));
async function reconcileBoot(){try{const response=await fetch('/api/boot',{cache:'no-store'});if(!response.ok)return;const fresh=await response.json();if(!fresh||!fresh.ws||!fresh.sess)return;
  const previousFocus=pickFocusSession();
  applyBootData(fresh);renderWorkspaces();
  if(activeSession&&fresh.focus&&fresh.focus.history&&fresh.focus.sessionId===activeSession&&!$('messages').querySelector('.message')){embeddedFocus=fresh.focus;paintInstantSession(true)}
  if(!provisionalSession)return;
  const nextFocus=fresh.focus&&fresh.focus.sessionId?fresh.focus:pickFocusSession();
  if(nextFocus&&nextFocus.sessionId&&nextFocus.sessionId!==previousFocus?.sessionId){embeddedFocus=fresh.focus&&fresh.focus.history?fresh.focus:null;await openSession(nextFocus.sessionId,titleFor(nextFocus));provisionalSession=true}
}catch{}}
// Reached only if the whole script parsed and ran. The page's bootstrap uses it
// to notice a mangled cached copy of this file and fetch a fresh one.
window.__pocketAppReady=true;
</script></body></html>`
}

export function renderMobileReconnectPage(
  locale,
  connectionMode = 'lan',
  options = {}
) {
  const zh = locale === 'zh'
  const expired = options.expired === true
  const resumeUnavailable = options.resumeUnavailable === true
  const text = {
    title: zh ? '重新连接 DSH' : 'Reconnect DSH',
    heading: zh ? '连接已断开' : 'Connection lost',
    action:
      connectionMode === 'tunnel' && !expired
        ? zh
          ? '输入连接密码'
          : 'Enter pairing password'
        : zh
          ? '重新连接'
          : 'Reconnect',
    guidance: resumeUnavailable
      ? zh
        ? '这部手机没有可恢复的连接。请回到电脑前，扫描「连接手机」里的新二维码。'
        : 'This phone has no saved connection. Go back to the computer and scan the new QR code.'
      : connectionMode === 'tunnel'
        ? expired
          ? zh
            ? '远程地址已失效，请在电脑上的「连接手机」扫描新二维码。'
            : 'This remote address is no longer valid. Scan the new QR code in Connect Phone on the computer.'
          : zh
            ? '隧道地址仍可用。输入电脑上显示的连接密码即可继续，不必重新扫码。'
            : 'This tunnel is still reachable. Enter the pairing password shown on the computer.'
        : zh
          ? '请确保手机和电脑连接到同一 Wi-Fi，然后点下面的按钮重新连接。'
          : 'Stay on the same Wi-Fi, then tap the button below to reconnect.',
    lanRisk: zh
      ? '局域网模式采用明文 HTTP 传输，同一网络下存在被窃听风险；请仅在可信 Wi-Fi 下使用，需要保密时请使用云隧道。'
      : 'LAN mode uses plaintext HTTP and can be eavesdropped on the same network. Use it only on trusted Wi-Fi; switch to the cloud tunnel for privacy.'
  }
  const action = resumeUnavailable
    ? ''
    : `<a class="primary" href="/reconnect">${text.action}<svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme:light)"><meta name="theme-color" content="#141416" media="(prefers-color-scheme:dark)"><title>${text.title}</title><style>:root{color-scheme:light;--bg:#fff;--ink:#18191c;--muted:#81858c}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#141416;--ink:#f5f5f6;--muted:#95979d}}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:100%;max-width:340px;text-align:center}.brand{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:22px;font-size:13px;font-weight:600}.brand img{width:35px;height:20px;object-fit:contain}.brand .dark-logo{display:none}@media(prefers-color-scheme:dark){.brand .light-logo{display:none}.brand .dark-logo{display:block}}h1{margin:0;font-size:28px;line-height:1.18;letter-spacing:-.03em}.guidance{margin:13px auto 0;max-width:310px;color:var(--muted);font-size:14px;line-height:1.65}.primary{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;height:50px;margin-top:26px;border-radius:15px;background:var(--ink);color:var(--bg);font-weight:650;text-decoration:none}</style></head><body><main class="card"><div class="brand"><img class="light-logo" src="/brand-logo/light" alt=""><img class="dark-logo" src="/brand-logo/dark" alt=""><span>DSH Pocket</span></div><h1>${text.heading}</h1><p class="guidance">${text.guidance}</p>${connectionMode !== 'tunnel' ? `<p class="guidance" style="margin-top:10px;font-size:12.5px">${text.lanRisk}</p>` : ''}${action}</main></body></html>`
}

/**
 * @param {DesktopPairingPageOptions} options
 * @returns {string}
 */
export function renderDesktopPairingPage(options) {
  const zh = options.locale === 'zh'
  const text = {
    title: zh ? '连接移动设备' : 'Connect Mobile Device',
    heading: zh ? '连接移动设备' : 'Connect a mobile device',
    hint: zh ? '扫码即可连接。' : 'Scan the QR code to connect.',
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
    refresh: zh ? '二维码将在 ' : 'QR refreshes in ',
    seconds: zh ? ' 秒后刷新' : 's',
    expired: zh ? '二维码已过期，正在自动刷新…' : 'QR expired. Refreshing automatically…',
    qrRefresh: zh ? '刷新二维码' : 'Refresh QR code',
    tunnelError: zh ? '隧道建立失败：' : 'Tunnel failed: ',
    expiresPrefix: zh ? '失效时间 ' : 'Expires ',
    lanRisk: zh
      ? '局域网模式采用明文 HTTP 传输，同一网络下存在被窃听风险；请仅在可信 Wi-Fi 下使用，需要保密时请使用云隧道。'
      : 'LAN mode uses plaintext HTTP and can be eavesdropped on the same network. Use it only on trusted Wi-Fi; switch to the cloud tunnel for privacy.'
  }
  const pinHintRemaining =
    !options.pinConsent && options.pinExpiresAt
      ? Math.max(0, Math.ceil((options.pinExpiresAt - Date.now()) / 1000))
      : 0
  const initialPinHint = options.pinConsent
    ? text.pinHintDurable
    : text.pinHintTemp + (pinHintRemaining ? ` (${pinHintRemaining}s)` : '')
  const connectedDeviceItems = Array.isArray(options.connectedDevices) ? options.connectedDevices : []
  const connectedDevicesHtml = `<div id="connectedDevices" class="url-row" style="flex-direction:column;align-items:stretch;gap:6px;max-width:340px;margin-top:14px"${connectedDeviceItems.length ? '' : ' hidden'}>${connectedDeviceItems.map((device) => `<div class="url" style="white-space:normal;overflow:visible;text-overflow:clip">${escapeHtml(device.label)} · ${escapeHtml(device.remoteAddress)} · ${zh ? '失效时间 ' : 'Expires '}${formatLocalTimestamp(device.expiresAt)}</div>`).join('')}</div>`
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${text.title}</title><style>
  :root{color-scheme:light;--bg:#fff;--surface:#fff;--panel:#f7f8fa;--ink:#18191c;--muted:#81858c;--line:#e5e7eb;--brand:#4d6bfe;--success-bg:#f2f8f4;--success-ink:#277347;--success-muted:#557565}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#141416;--surface:#1d1d20;--panel:#202023;--ink:#f5f5f6;--muted:#95979d;--line:#303034;--brand:#6f86ff;--success-bg:#17261d;--success-ink:#75c991;--success-muted:#8ab99a}}*{box-sizing:border-box}html,body{min-height:100%;background:var(--bg)}body{margin:0;color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:520px;margin:auto;padding:26px 32px 30px;text-align:center}.brand{display:flex;align-items:center;justify-content:center;gap:9px;font-weight:600;margin-bottom:14px}.brand img{width:39px;height:22px;object-fit:contain}.brand .dark-logo{display:none}@media(prefers-color-scheme:dark){.brand .light-logo{display:none}.brand .dark-logo{display:block}}h1{font-size:24px;line-height:1.25;font-weight:600;margin:0}p{margin:0;color:var(--muted)}
  .mode-panel{max-width:410px;margin:18px auto 0;padding:5px 8px 10px;border:1px solid var(--line);border-radius:15px;background:var(--panel)}
  .mode-switch{display:grid;grid-template-columns:1fr 1fr;width:100%;padding:3px;border-radius:11px;gap:3px}
  .mode-btn{min-width:0;height:34px;border:0;background:transparent;color:var(--muted);padding:0 10px;border-radius:9px;font-size:13px;font-weight:550;cursor:pointer;transition:background .15s,color .15s}
  .mode-btn.active{background:var(--surface);color:var(--ink);box-shadow:0 1px 4px rgba(0,0,0,.08)}
  .mode-btn:disabled{cursor:not-allowed;opacity:.5}.mode-btn.active:disabled{opacity:.72}
  .connection{display:none;flex-direction:column;align-items:center;margin:24px auto 0;max-width:390px;padding:22px;border-radius:14px;background:var(--success-bg);color:var(--success-ink)}.connection.show{display:flex}.connection-title{font-size:16px;font-weight:600}.connection-title:before{content:'✓';display:inline-grid;place-items:center;width:24px;height:24px;margin-right:9px;border-radius:50%;background:#35a867;color:white}.connection-hint{max-width:310px;margin-top:8px;color:var(--success-muted);font-size:13px}.connection-actions{display:flex;gap:8px;margin-top:18px}.connection-actions button{min-width:94px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink);padding:8px 14px;cursor:pointer}.connection-actions .done{background:var(--ink);color:var(--bg);border-color:var(--ink)}.phone-connected .pairing-content{display:none}.manage-connected .connection-hint,.manage-connected .done{display:none}.manage-connected .connection-actions{margin-top:16px}
  .pairing-content{margin-top:16px}.qr{display:inline-flex;background:#fff;padding:12px;border:1px solid var(--line);border-radius:16px;margin:0 0 10px;min-width:244px;min-height:244px;align-items:center;justify-content:center;position:relative}
  .qr svg{width:220px;height:220px;display:block}
  .qr-loading{position:absolute;inset:0;background:rgba(255,255,255,.94);border-radius:16px;display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;font-size:13px;color:#18191c;font-weight:550}
  .qr-loading.show{display:flex}
  .loading-copy{display:flex;width:176px;align-items:center;justify-content:space-between;gap:12px}.loading-copy span:first-child{text-align:left}.loading-value{min-width:32px;text-align:right;color:#62666d;font-variant-numeric:tabular-nums}.tunnel-progress{width:176px;height:5px;overflow:hidden;border-radius:999px;background:#e5e7eb}.tunnel-progress span{display:block;width:0;height:100%;border-radius:inherit;background:var(--brand);transition:width .08s linear}@media(prefers-reduced-motion:reduce){.tunnel-progress span{transition:none}}
  .hint{min-height:38px;display:flex;align-items:center;justify-content:center;font-size:12.5px;line-height:1.55;max-width:370px;margin:7px auto 0;padding:0 5px}
  .url-row{display:flex;align-items:flex-start;gap:8px;margin:10px auto 0;max-width:410px}.url{min-width:0;flex:1;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--panel);border-radius:9px;padding:9px 11px;text-align:left;white-space:normal;word-break:break-all}.url.is-pending{color:var(--muted);word-break:normal}.copy{position:relative;display:grid;place-items:center;width:28px;height:28px;flex:none;border:0;background:transparent;color:var(--muted);padding:0;cursor:pointer}.copy:hover{color:var(--ink)}.copy-icon{display:block}.copy-done{display:none;place-items:center;width:16px;height:16px;border-radius:50%;background:#35a867;color:#fff}.copy.copied .copy-icon{display:none}.copy.copied .copy-done{display:grid}.copy-done svg{display:block}.copy-tip{position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);background:#fff;color:#18191c;border-radius:6px;padding:5px 8px;font-size:12px;line-height:1.2;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.12);opacity:0;pointer-events:none}.copy-tip:after{content:'';position:absolute;left:50%;top:100%;transform:translateX(-50%);border:5px solid transparent;border-top-color:#fff}.copy:hover .copy-tip,.copy.copied .copy-tip{opacity:1}.lan-risk{max-width:340px;margin:10px auto 0;color:var(--muted);font-size:11.5px;line-height:1.6}.expires{font-size:12px;margin-top:8px}
  .pin-panel{display:none;max-width:410px;margin:16px auto 0;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}.pin-panel.show{display:block}.pin-label{color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}.pin-value{margin:8px 0 6px;font:40px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em}.pin-hint{color:var(--muted);font-size:12px}.pin-consent{display:flex;gap:8px;align-items:flex-start;margin-top:12px;text-align:left;font-size:13px}.pin-actions{display:flex;justify-content:center;gap:8px;margin-top:12px}.pin-actions[hidden]{display:none}.pin-actions button{border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink);padding:7px 12px;cursor:pointer}
  .tunnel-err{display:none;color:#e34d59;font-size:12px;margin:5px 7px 0}.tunnel-err.show{display:block}
  .expires{display:flex;align-items:center;justify-content:center;gap:5px;font-size:12px;margin-top:8px;color:var(--muted)}
  .expires-refresh{display:inline-grid;place-items:center;width:20px;height:20px;padding:0;border:0;background:transparent;color:var(--muted);cursor:pointer;border-radius:50%}
  .expires-refresh:hover{color:var(--ink)}
  .expires-refresh:disabled{opacity:.5;cursor:wait}
  .expires-refresh svg{width:13px;height:13px}
  .expires-refresh.spinning svg{animation:qrRefreshSpin .6s linear infinite}
  @keyframes qrRefreshSpin{to{transform:rotate(360deg)}}
  </style></head><body class="${options.connected ? 'phone-connected manage-connected' : ''}"><div class="wrap"><div class="brand"><img class="light-logo" src="/brand-logo/light" alt=""><img class="dark-logo" src="/brand-logo/dark" alt=""><span>DSH Pocket</span></div><h1>${options.connected ? text.manageHeading : text.heading}</h1>
  <div class="mode-panel"><div class="mode-switch"><button id="btnLan" class="mode-btn${!options.tunnelActive ? ' active' : ''}" onclick="switchMode(false)"${options.connected ? ' disabled' : ''}>${text.modeLan}</button><button id="btnTunnel" class="mode-btn${options.tunnelActive ? ' active' : ''}" onclick="switchMode(true)"${options.connected ? ' disabled' : ''}>${text.modeTunnel}</button></div><p class="hint" id="modeHint">${options.tunnelActive ? text.tunnelHint : text.lanHint}</p><div id="tunnelError" class="tunnel-err${options.tunnelActive && options.tunnelError ? ' show' : ''}">${options.tunnelActive && options.tunnelError ? text.tunnelError + escapeHtml(options.tunnelError) : ''}</div></div>
  <div id="connection" class="connection${options.connected ? ' show' : ''}"><div class="connection-title">${text.connected}</div><p class="connection-hint">${text.closeHint}</p><div class="connection-actions"><button onclick="disconnectPhone()">${text.disconnect}</button><button class="done" onclick="donePairing()">${text.done}</button></div>${connectedDevicesHtml}</div>
  <div class="pairing-content"><div id="qrContainer" class="qr"><div id="qrCode">${options.qrSvg}</div><div id="qrLoading" class="qr-loading${options.tunnelLoading ? ' show' : ''}"><div class="loading-copy"><span id="tunnelLoadingText">${text.tunnelLoading}</span><span id="tunnelProgressValue" class="loading-value">0%</span></div><div class="tunnel-progress" aria-hidden="true"><span id="tunnelProgressBar"></span></div></div></div><div class="url-row"><div class="url" id="url">${escapeHtml(options.pairingUrl)}</div><button type="button" id="copyBtn" class="copy" onclick="copyUrl()" aria-label="${text.copy}"><svg class="copy-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.25" y="5.25" width="7.5" height="7.5" rx="1.4" stroke="currentColor" stroke-width="1.3"/><path d="M3.75 10.25V3.75h6.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="copy-done" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2.4 6.2 4.7 8.5 9.6 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="copy-tip" id="copyTip">${text.copy}</span></button></div><p id="lanRisk" class="lan-risk"${options.tunnelActive ? ' hidden' : ''}>${text.lanRisk}</p><p class="expires"><span id="expiresText"></span><button type="button" id="qrRefreshBtn" class="expires-refresh" onclick="refreshQr()" aria-label="${text.qrRefresh}" title="${text.qrRefresh}"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.6v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></p><div id="pinPanel" class="pin-panel${options.tunnelActive && options.pairingPin ? ' show' : ''}"><div class="pin-label">${text.pinLabel}</div><div id="pinValue" class="pin-value">${escapeHtml(options.pairingPin ?? '')}</div><p id="pinHint" class="pin-hint">${initialPinHint}</p><label class="pin-consent"><input id="pinConsent" type="checkbox"${options.pinConsent ? ' checked' : ''} onchange="setPinConsent(this.checked)"><span>${text.pinConsent}<br><small>${text.pinPrivacy}</small></span></label><div id="pinActions" class="pin-actions"${options.pinConsent ? '' : ' hidden'}><button type="button" onclick="resetPin()">${text.pinReset}</button><button type="button" onclick="setPinConsent(false)">${text.pinCancel}</button></div></div></div></div>
  <script>let end=${options.expiresAt},pairingUrl=${scriptJson(options.pairingUrl)},T=${scriptJson(text)},tunnelActive=${Boolean(options.tunnelActive)},selectedTunnelTab=${Boolean(options.tunnelActive)},tunnelProvider=${scriptJson(options.tunnelProvider??null)},phoneConnected=${options.connected},modeSwitching=false,tunnelProgressTimer=null,tunnelProgressStartedAt=0,copyFeedbackTimer=null,pinConsent=${Boolean(options.pinConsent)},pinExpiresAt=${options.pinExpiresAt ?? 'null'};
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
  function connectedDeviceHtml(device){return'<div class="url" style="white-space:normal;overflow:visible;text-overflow:clip">'+escHtml(device.label)+' · '+escHtml(device.remoteAddress)+' · '+T.expiresPrefix+formatTimestamp(device.expiresAt)+'</div>'}
  function renderConnectedDevices(list){const host=document.getElementById('connectedDevices');if(!host)return;const items=Array.isArray(list)?list:[];host.innerHTML=items.map(connectedDeviceHtml).join('');host.hidden=!items.length}
  function syncLanRisk(){const el=document.getElementById('lanRisk');if(el)el.hidden=tunnelActive}
  function syncModeControls(connected){phoneConnected=connected;const disabled=connected||modeSwitching;document.getElementById('btnLan').disabled=disabled;document.getElementById('btnTunnel').disabled=disabled}
  function syncModeSelection(active){document.getElementById('btnLan').classList.toggle('active',!active);document.getElementById('btnTunnel').classList.toggle('active',active)}
  function syncTunnelError(){const el=document.getElementById('tunnelError');el.classList.toggle('show',selectedTunnelTab&&!!el.textContent)}
  function setTunnelProgress(value){const progress=Math.max(0,Math.min(100,Math.round(value)));document.getElementById('tunnelProgressBar').style.width=progress+'%';document.getElementById('tunnelProgressValue').textContent=progress+'%'}
  function startTunnelProgress(enableTunnel){const loading=document.getElementById('qrLoading'),duration=enableTunnel?4500:800;clearInterval(tunnelProgressTimer);tunnelProgressStartedAt=Date.now();document.getElementById('tunnelLoadingText').textContent=enableTunnel?T.tunnelLoading:T.lanLoading;setTunnelProgress(0);loading.classList.add('show');tunnelProgressTimer=setInterval(()=>{setTunnelProgress(Math.min(99,(Date.now()-tunnelProgressStartedAt)/duration*100))},50);return duration}
  async function finishTunnelProgress(completed,duration){const loading=document.getElementById('qrLoading');if(completed){const remaining=Math.max(0,duration-(Date.now()-tunnelProgressStartedAt));if(remaining)await new Promise(resolve=>setTimeout(resolve,remaining));setTunnelProgress(100);await new Promise(resolve=>setTimeout(resolve,180))}clearInterval(tunnelProgressTimer);tunnelProgressTimer=null;loading.classList.remove('show');setTunnelProgress(0)}
  async function switchMode(enableTunnel){if(phoneConnected||modeSwitching)return;if(selectedTunnelTab===enableTunnel&&tunnelActive===enableTunnel)return;const previous=tunnelActive;const previousProvider=tunnelProvider;const previousUrl=pairingUrl;let completed=false;modeSwitching=true;selectedTunnelTab=enableTunnel;syncModeControls(phoneConnected);syncModeSelection(enableTunnel);document.getElementById('modeHint').textContent=enableTunnel?T.tunnelHint:T.lanHint;syncTunnelError();// The link outside the QR overlay still shows the old mode's URL until the
  // tunnel toggle resolves (~4.5s). Replace it immediately with a placeholder.
  pairingUrl='';document.getElementById('url').textContent=enableTunnel?T.urlPendingTunnel:T.urlPendingLan;document.getElementById('url').classList.add('is-pending');const progressDuration=startTunnelProgress(enableTunnel);try{const r=await fetch('/desktop/tunnel/toggle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enable:enableTunnel})});const j=await r.json();if(j.ok){applyTunnelPayload(j);selectedTunnelTab=enableTunnel;syncModeSelection(enableTunnel);document.getElementById('modeHint').textContent=enableTunnel?T.tunnelHint:T.lanHint;if(j.active)document.getElementById('tunnelError').textContent='';syncTunnelError();completed=true}else{throw new Error(j.error||'Tunnel failed')}}catch(e){tunnelActive=previous;tunnelProvider=previousProvider;pairingUrl=previousUrl;const urlEl=document.getElementById('url');urlEl.classList.remove('is-pending');urlEl.textContent=previousUrl;syncModeSelection(selectedTunnelTab);document.getElementById('modeHint').textContent=selectedTunnelTab?T.tunnelHint:T.lanHint;document.getElementById('tunnelError').textContent=T.tunnelError+(e.message||e);syncTunnelError()}finally{await finishTunnelProgress(completed,progressDuration);modeSwitching=false;syncModeControls(phoneConnected)}}
  function applyTunnelPayload(j){tunnelActive=!!j.active;tunnelProvider=j.provider||null;const urlEl=document.getElementById('url');if(j.pairingUrl){pairingUrl=j.pairingUrl;urlEl.textContent=pairingUrl;urlEl.classList.remove('is-pending')}else if(!j.active&&!modeSwitching){pairingUrl='';urlEl.textContent='';urlEl.classList.remove('is-pending')}if(j.qrSvg)document.getElementById('qrCode').innerHTML=j.qrSvg;if(j.expiresAt)end=j.expiresAt;syncPin(j);syncLanRisk();if(j.unexpectedlyClosed&&!j.active){document.getElementById('tunnelError').textContent=T.pinClosed;syncTunnelError()}renderConnectedDevices(j.connectedDevices)}
  function renderPinHint(){const hint=document.getElementById('pinHint');if(!hint)return;if(pinConsent){hint.textContent=T.pinHintDurable;return}if(!pinExpiresAt){hint.textContent=T.pinHintTemp;return}const left=Math.max(0,Math.ceil((pinExpiresAt-Date.now())/1000));hint.textContent=T.pinHintTemp+(left?' ('+left+'s)':'')}
  function syncPin(j){const panel=document.getElementById('pinPanel'),value=document.getElementById('pinValue'),box=document.getElementById('pinConsent'),actions=document.getElementById('pinActions');pinConsent=!!j.pinConsent;if('pinExpiresAt' in j)pinExpiresAt=j.pinExpiresAt||null;if(value)value.textContent=j.pairingPin||'';if(box)box.checked=pinConsent;renderPinHint();if(actions)actions.hidden=!pinConsent;if(panel)panel.classList.toggle('show',!!(tunnelActive&&j.pairingPin))}
  async function setPinConsent(consent){const r=await fetch('/desktop/pin/consent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({consent})});const j=await r.json();if(j.ok)applyTunnelPayload(j);else{document.getElementById('pinConsent').checked=pinConsent;document.getElementById('tunnelError').textContent=j.error||T.tunnelError;syncTunnelError()}}
  async function resetPin(){const r=await fetch('/desktop/pin/reset',{method:'POST'});const j=await r.json();if(j.ok)applyTunnelPayload(j)}
  async function refreshQr(){const btn=document.getElementById('qrRefreshBtn');if(!btn||btn.disabled||modeSwitching)return;btn.classList.add('spinning');if(selectedTunnelTab&&!tunnelActive){btn.disabled=true;try{await switchMode(true)}finally{btn.classList.remove('spinning');btn.disabled=false}return}// Force a new pairing token first: a plain reload within the TTL redrew the
  // identical QR, URL and countdown. Rotation failures still fall through to a
  // reload, which rotates on its own once the token has expired.
  btn.disabled=true;try{await fetch('/desktop/pairing/rotate',{method:'POST',headers:{'content-type':'application/json'}})}catch{}setTimeout(()=>location.reload(),250)}
  async function poll(){const [status,tunnel]=await Promise.all([fetch('/desktop/status'),fetch('/desktop/tunnel/status')]);if(status.ok){const j=await status.json();const connected=!!j.connected;document.getElementById('connection').classList.toggle('show',connected);document.body.classList.toggle('phone-connected',connected);syncModeControls(connected)}if(tunnel.ok){const j=await tunnel.json();if(!modeSwitching)applyTunnelPayload(j)}}
  async function disconnectPhone(){await fetch('/desktop/disconnect',{method:'POST'});location.reload()}
  setInterval(()=>{const n=Math.max(0,Math.ceil((end-Date.now())/1000));const expiresText=document.getElementById('expiresText');const refreshBtn=document.getElementById('qrRefreshBtn');if(expiresText)expiresText.textContent=pairingUrl?(n?T.refresh+n+T.seconds:T.expired):'';if(refreshBtn)refreshBtn.disabled=!pairingUrl;if(!n&&pairingUrl&&!phoneConnected&&!modeSwitching)location.reload();renderPinHint()},1000);
  setInterval(poll,800);poll()</script></body></html>`
}

export function renderPairingPinPage(locale, icon = null, options = {}) {
  const zh = locale === 'zh'
  const text = {
    title: zh ? '连接 DSH' : 'Pairing DSH',
    heading: zh ? '输入连接密码' : 'Enter pairing password',
    hint: zh ? '在电脑「连接手机」窗口查看 6 位密码。' : 'Find the 6-digit password in Connect Phone on the computer.',
    submit: zh ? '连接' : 'Connect',
    showPin: zh ? '在电脑上查看密码' : 'Show password on the computer',
    invalid: zh ? '连接密码不正确。' : 'That pairing password is incorrect.',
    expired: zh ? '密码已过期，请在电脑上扫描新二维码。' : 'This password expired. Scan the new QR code on the computer.',
    rateLimited: zh ? '尝试次数过多，请 {n} 分钟后再试。' : 'Too many attempts. Try again in {n} min.',
    unavailable: zh ? '暂时无法连接桌面端，请先启动 DSH。' : 'Cannot reach the desktop. Start DSH and try again.',
    timeout: zh ? '网络超时，请检查手机网络后重试。' : 'Network timed out. Check your connection and retry.',
    navigating: zh ? '正在打开…' : 'Opening…',
    openFailed: zh ? '页面打开失败，请点连接重试。' : 'Failed to open the page. Please retry.',
    connecting: zh ? '正在连接…' : 'Connecting…',
    stepServer: zh ? '正在连接服务器' : 'Connecting to server',
    stepWorkspace: zh ? '正在同步工作区' : 'Syncing workspace',
    stepSessionList: zh ? '正在同步会话列表' : 'Syncing session list',
    stepSession: zh ? '正在同步会话内容' : 'Syncing conversation',
    stepPrepare: zh ? '正在准备页面' : 'Preparing page'
  }
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme:light)"><meta name="theme-color" content="#141416" media="(prefers-color-scheme:dark)"><title>${text.title}</title><style>:root{color-scheme:light;--bg:#fff;--card:#fff;--panel:#f7f8fa;--ink:#18191c;--muted:#81858c;--line:#e5e7eb;--brand:#4d6bfe}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#141416;--card:#1d1d20;--panel:#202023;--ink:#f5f5f6;--muted:#95979d;--line:#303034;--brand:#6f86ff}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px}.card{width:100%;max-width:340px;text-align:center}.logo{width:54px;height:54px;display:grid;place-items:center;margin:0 auto 22px;border:1px solid var(--line);border-radius:16px;background:var(--card)}.logo img{width:39px;height:22px;object-fit:contain}.logo .dark-logo{display:none}@media(prefers-color-scheme:dark){.logo .light-logo{display:none}.logo .dark-logo{display:block}}h1{font-size:24px;line-height:1.25;font-weight:600;margin:0 0 8px}p{margin:0;color:var(--muted)}input{width:100%;height:52px;margin-top:22px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink);text-align:center;font:28px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.28em}button{width:100%;height:44px;margin-top:12px;border:1px solid var(--ink);border-radius:12px;background:var(--ink);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}button.quiet{border-color:var(--line);background:transparent;color:var(--ink)}.note{min-height:20px;margin-top:14px;padding:10px 12px;border-radius:10px;background:var(--panel);color:#e34d59;font-size:13px}.boot-steps{display:none;margin:18px auto 0;text-align:left}.boot-steps.show{display:block}.boot-step{display:flex;align-items:center;color:var(--muted);opacity:.4;font-size:14px;padding:6px 0;transition:opacity .2s ease,color .2s ease}.boot-step.is-active{opacity:1;color:var(--ink);font-weight:600}.boot-step.is-done{opacity:.6;color:var(--muted)}.boot-step.is-done .boot-step-label{text-decoration:line-through;text-decoration-color:var(--brand);text-decoration-thickness:1.5px}.boot-step.is-active::before{content:'';flex:none;width:13px;height:13px;margin-right:9px;border:2px solid var(--line);border-top-color:var(--brand);border-radius:50%;animation:bspin .7s linear infinite}.boot-step:not(.is-active){padding-left:22px}@keyframes bspin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.boot-step.is-active::before{animation:none}}button:disabled{opacity:.55;cursor:default}</style></head><body><div class="card"><div class="logo"><img src="${icon || '/brand-logo/light'}" alt="DSH" style="width:40px;height:40px;border-radius:9px;object-fit:cover"></div><h1>${text.heading}</h1><p>${text.hint}</p><form onsubmit="return submitPin(event)"><input id="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" required><button id="submit" type="submit">${text.submit}</button></form><button class="quiet" type="button" onclick="showPinOnDesktop()">${text.showPin}</button><div id="status" class="note" hidden></div><div id="bootSteps" class="boot-steps"></div></div><script>const T=${scriptJson(text)};
// The handoff list is the only progress the user has, so a stage that finishes
// in a few milliseconds must not look like it was skipped. This floor pads only
// rows that were faster than that; real network work still dominates the total.
const STEP_DWELL_MS=180;
const FETCH_TIMEOUT_MS=10000;
function withTimeout(promise,ms){let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),ms)});return Promise.race([promise,timeout.finally(()=>clearTimeout(timer))])}
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
  const rpc=async(method,payload={})=>{const job=fetch('/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,payload})});const x=await withTimeout(job,FETCH_TIMEOUT_MS);const y=await x.json();if(!x.ok||!y.ok)throw new Error(y.error||'');return y.value};
  // One row per real stage: run the work, keep the row visible long enough to be
  // read, then advance. Every row waits on an actual round trip to the desktop,
  // so the list is the true progress of the handoff rather than decoration.
  const stage=async(index,work)=>{const started=Date.now();const value=await work();const rest=STEP_DWELL_MS-(Date.now()-started);if(rest>0)await new Promise(r=>setTimeout(r,rest));setStep(index+1);return value};
  const pinError=(message)=>{const error=new Error(message);error.pinMessage=message;return error};
  try{
  await stage(0,async()=>{const r=await withTimeout(fetch('/pair/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin})}),FETCH_TIMEOUT_MS);const j=await r.json();if(r.status===429){const minutes=Math.max(1,Math.ceil(Number(j.retryAfter||r.headers.get('retry-after')||60)/60));throw pinError(T.rateLimited.replace('{n}',String(minutes)))}if(!j.ok)throw pinError(j.rescan||j.error==='expired'?T.expired:T.invalid)});
  await stage(1,()=>rpc('workspace.list'));
  // Only the newest rows: the stage is real work either way, but pulling all 469
  // sessions here (195 KB) is not something the phone needs before it can open a
  // conversation — the list view fetches the full list for itself on open.
  await stage(2,()=>rpc('session.list',{limit:SESSION_LIST_ROWS}));
  // "Syncing conversation" fetches the transcript payload itself — workspaces,
  // session list and the focus turn's latest messages — and leaves it in this
  // tab. The app document then paints it on its first frame, with no browser
  // cache, no re-download and nothing that a mobile browser can mangle.
  let shell=null;
  await stage(3,async()=>{try{const response=await withTimeout(fetch('/api/boot',{cache:'no-store'}),FETCH_TIMEOUT_MS);if(!response.ok)throw new Error('boot http '+response.status);const raw=await withTimeout(response.text(),FETCH_TIMEOUT_MS);const parsed=JSON.parse(raw);if(parsed&&parsed.ws&&parsed.sess){sessionStorage.setItem('${POCKET_BOOT_KEY}',raw);shell=parsed.assets||null}}catch{// The app document assembles the same payload itself, so a failed stash
    // must not abort the handoff. The stage-4 watchdog still guarantees the
    // flow navigates; the app then loads /api/boot on its own if the stash is
    // missing.
    }});
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
  return false}catch(e){const msg=e&&e.pinMessage?e.pinMessage:(e&&e.message==='timeout'?T.timeout:T.unavailable);return fail(msg)}}
async function showPinOnDesktop(){try{await fetch('/pair/retry',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})}catch{}}</script></body></html>`
}

function formatLocalTimestamp(value) {
  const date = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => {
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
