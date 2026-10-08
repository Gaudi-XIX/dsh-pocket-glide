# Pocket for DSH

**A phone client for your own DeepSeek Harness, as a plugin.**

Pocket mounts a small HTTP bridge inside the DeepSeek Harness (DSH) desktop process, pairs
with a phone browser over a QR code or a numeric password, and lets that phone read your
sessions, send messages, and watch the answer stream in. It is for the machine you already
work on — not a hosted service, not a team gateway, not a mirror of the desktop GUI.

| | |
|---|---|
| Package | `@defws/dsh-pocket` |
| Current version | 0.4.0 ([Changelog](CHANGELOG.md)) |
| Host requirement | DeepSeek Harness desktop `>= 0.2.0-rc.1` (preview line) |
| Runtime | Node `^22.19.0 \|\| >=24.0.0` — the plugin runs in the host's own process |
| Licence | Apache-2.0 ([LICENSE](LICENSE)) |
| UI languages | English and Simplified Chinese |

## Table of contents

- [Why this exists](#why-this-exists) · [What you get](#what-you-get) · [Form](#form-a-plugin-not-a-separate-process) · [Requirements](#requirements)
- [Install](#install) · [First connection](#first-connection) · [Configuration](#configuration) · [Environment variables](#environment-variables)
- [Where files are kept](#where-files-are-kept) · [Security model](#security-model) · [Tunnels](#tunnels) · [HTTP surface](#http-surface)
- [Testing](#testing) · [Known limitations](#known-limitations) · [Troubleshooting](#troubleshooting) · [Packaging and licence](#packaging-and-licence)

## Why this exists

DSH's own web server binds to loopback. That is the right default for a desktop app, and it
is also the reason a phone cannot reach it: nothing outside the machine can connect, and
nothing on the machine listens for a handset.

Pocket adds exactly that missing piece — one listener on `0.0.0.0`, one pairing gate in
front of it, and a phone-shaped page behind it. Everything that actually runs an agent stays
in the host: Pocket talks to the host's own inner API server-side and never forwards a
phone's request straight to the harness.

In scope: connecting, reading sessions and history, sending a message, streaming the reply,
picking a model or preset, running a slash command, attaching a file, exporting a session.
Out of scope: driving the desktop GUI remotely, multi-user access, hosting sessions.

## What you get

- **Pairing** — a QR code plus an 8-digit numeric password; opt into a durable password and
  a phone survives a host restart without re-scanning.
- **Sessions** — list, unread marks, history with paging, create, send, cancel, and a per-session
  watermark so two devices don't fight over one transcript.
- **Streaming** — SSE token-by-token on the LAN; adaptive incremental polling where a tunnel
  would buffer the stream away.
- **Process transparency** — tool calls render as a localized three-state story, repeated
  actions collapse, edit/write show line-level diffs, raw arguments stay one tap away.
- **Attachments** — images with a lightbox, text files inline, downloadable file cards with real
  names; images and files can also be sent from the phone.
- **Devices** — a paired-device list with per-device expiry, last seen, channel permission
  and one-tap revoke.
- **Installable** — PWA manifest plus an offline fallback page: `add to home screen` gives an
  app shell rather than a bookmark.
- **Approvals on the move** — a push the moment the assistant waits for your answer, and
  optional completion notifications over ServerChan, Bark or WxPusher.

## Form: a plugin, not a separate process

The entry point `lib/index.js` exports `name`, `inject` and `apply(ctx, config)` (with
`export default apply`). It has **no main guard**: `node lib/index.js` does nothing, because
loading is the host's job.

The bridge is a `node:http` listener created inside the host process. It deliberately does
not attach to the host's own web server, because that server only binds loopback. Its
lifetime follows the plugin's effect: it starts when the bundle activates and stops when the
bundle disposes — listener, tunnel child process, outbound websocket, sockets.

Two halves, both declared in `package.json`:

- **node half** — the bridge, the pairing gate, the device registry, the tunnel manager, and
  the phone routes. It also proxies the desktop pairing surface (`/desktop`, `/brand-logo`)
  onto the application origin so the desktop GUI can show it in a same-origin frame.
- **browser half** — `client/client.js`, loaded through `dsh.client.inject`, which registers
  exactly one thing: the `pocket` action in the sidebar footer that opens that pairing
  surface.

Every phone page is a plain HTML string produced by the host and served over the bridge's own
routes. There is no React bundle and no build step in this repository.

**Consequence for upgrades:** a source edit is not hot-mounted. Change this tree, restart DeepSeek
Harness, reload the phone page.

## Requirements

- DeepSeek Harness desktop, preview line `0.2.0-rc.1` or newer. The plugin API of a preview
  host can and does change without notice; if your host is older or much newer, expect to
  re-verify.
- The Node runtime the host ships — plain ESM, no build. One runtime dependency: `pngjs`
  (QR rendering).
- Optional, only for internet access: [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/).
  The plugin downloads a pinned build on first use and verifies its SHA-256. You can also put
  your own binary on `PATH` or point `DSH_POCKET_CLOUDFLARED` at one.
- A phone browser — recent iOS Safari and Android Chrome are the tested shapes; the page is
  responsive but assumes a touch viewport.

## Install

Two steps, from a checkout of this repository.

```bash
# 1. register the plugin in the profile the desktop host actually loads
dsh plugin --profile desktop add link:/absolute/path/to/dsh-pocket

# 2. restart DeepSeek Harness
```

`link:` is a local directory dependency, so the profile resolves the plugin through a
junction/symlink instead of copying it. A source edit plus a host restart is therefore enough
to pick up a change — no reinstall step.

Notes:

- The desktop host loads bundles at start-up and does not hot-mount a new one, so step 2 is
  not optional.
- If your profile is not called `desktop`, pass that name to `--profile`.
- `pnpm install` in the profile directory is what materialises the link; the `dsh plugin`
  command normally does it for you. It also checks peer compatibility first, so
  `incompatible-version` means the host is outside `dsh.engines.dsh` in `package.json`.
- Alternative for people who want a preflight and a backup file first:
  `node tools/install-to-profile.mjs --dry-run`, then without `--dry-run`. It edits only two
  entries in the profile's `package.json`, writes a `.bak-before-pocket-*` copy beforehand,
  refuses to write anything if the source tree or the profile manifest fails its checks, and
  does not run `pnpm install` unless you pass `--install`. In a fresh checkout `LINK_PATH` in
  that script is a placeholder — set it to the absolute path of your checkout first, because
  no local path is baked into the repository.

After the restart, the host log line to look for is `Pocket bridge ready on 0.0.0.0:<port>`.
If it never appears, the bridge refused to start — see [Troubleshooting](#troubleshooting).

## First connection

1. Open the desktop GUI, sidebar footer, **pocket**. The panel shows a QR code, the pairing
   URL, and a numeric password.
2. On the phone, scan the QR code (or open the URL and type the password).
3. If you connected over a tunnel, one confirmation page asks you to accept public-channel
   use before any data flows.
4. The panel lists the device, and the phone has its own session from here: read sessions,
   send messages, stream replies.
5. Optional — tick the durable password on the panel. That writes one `0600` file so the pairing
   survives a host restart; without it nothing is persisted, and every restart needs a fresh
   pairing.

## Configuration

Everything is configured from the desktop panel (sidebar `pocket` → `/desktop`). The panel
controls:

- **Channel** — LAN only, or a tunnel on top of the LAN listener.
- **Tunnel mode** — quick tunnel (a random `*.trycloudflare.com` hostname every start) or a
  named tunnel (your Cloudflare token + your own hostname, fixed URL).
- **Pairing** — rotate the password, reset or revoke the durable one, confirm a pending
  pairing, disconnect or revoke a device.
- **Devices** — per-device name, expiry, last seen, channel permission, revoke.
- **Notifications** — channel (ServerChan / Bark / WxPusher), key, on/off, and a test send.

Settings and pairing state are stored as JSON documents in the plugin data directory, written
atomically with mode `0600` on POSIX. On Windows the mode bits are advisory; the protection
that matters there is the directory's ACL.

### Environment variables

These are read by the plugin process, i.e. by the **host** process. Changing one means
restarting DeepSeek Harness — reloading the page does not help.

| Variable | Effect |
|---|---|
| `DSH_MOBILE_PORT` | Forces the listener port (positive integers only). Overrides the config value and the default 43127. Whether a busy port yields to the next one depends **only on the port number**: 43127 and 43128 step aside once; any other port fails loudly instead of moving, because silently pointing an embedded frame at the wrong port is worse than an error. |
| `DSH_HOME` | The unified data root. Set it and everything — log, durable password, tunnel cache — is confined under `<DSH_HOME>/pocket/`. Unset it and only the log moves: the password and the cloudflared cache keep their machine-local homes. |
| `DSH_POCKET_DEBUG` | `=1` re-enables the document size report at page render. Off by default. |
| `DSH_POCKET_CLOUDFLARED` | Absolute path to a cloudflared binary; first preference in the resolution chain. |
| `CLOUDFLARED_BIN` | Generic alternative; lower priority than the above. |
| `CLOUDFLARED_VERSION` | Read only by `tools/fetch-cloudflared.mjs`, never by the runtime. A value other than the pinned one needs `--allow-unverified`. |
| `LOCALAPPDATA`, `XDG_CACHE_HOME` | Only in play when `DSH_HOME` is unset: they locate the machine-local write root for the durable password and the tunnel cache. |

### Where files are kept

`<DSH data root>` below means the `.dsh` directory under the user home, or `DSH_HOME` when you
set it.

| Content | `DSH_HOME` set (isolated) | `DSH_HOME` unset (normal desktop use) |
|---|---|---|
| File log | `<DSH data root>/pocket/logs/pocket.log` | same shape, under the default data root |
| Durable pairing password | `<DSH data root>/pocket/` only | written to the machine-local directory; read from machine-local first, then the unified root as a fallback |
| Paired devices and sessions | `<DSH data root>/pocket/` only | machine-local directory |
| cloudflared cache | `<DSH data root>/pocket/cloudflared/` only | written machine-locally; older plugin directories are read as fallbacks |

The asymmetry is deliberate. Two promises are held at once: an isolated run touches nothing
outside its own root, and an ordinary run never relocates a machine's existing credentials —
moving the default write root would log out every paired phone and re-download a ~55 MB
pinned binary.

The log is JSON lines (`t`, `level`, `message`), capped at 512 KB per generation with a
cascade of three rotated files, a 32 KB per-line ceiling, and a hard 2 MB stop at which point
lines are dropped rather than letting the file grow without bound. Writing a log line never
throws and never takes the plugin down with it.

## Security model

The desktop panel issues a one-time pairing token and an 8-digit numeric
password valid for 5 minutes. Opening a tunnel rotates the ephemeral password on the spot. A
durable password exists only if you consent to it on the desktop panel, and you can revoke it
there at any time. One-time and durable passwords coexist: the phone's input field accepts
6–12 digits, so an older 6-digit password still pairs after the width changed.

Failures are counted per limit key (the socket address on the LAN; the `cf-connecting-ip`
value behind a tunnel) with exponential backoff and HTTP 429 plus `Retry-After`. Ten failures
on one key hard-lock it for 15 minutes — while locked, attempts are refused before a new
failure is counted, so a scripted guesser cannot keep the window sliding. A desktop password
action clears a lock early, and so does a restart, because the counters live in memory.

Each paired phone holds its own `dsh_mobile` cookie: `HttpOnly`,
`SameSite=Strict`, 30-day `Max-Age`, with `Secure` added whenever the request arrived over an
HTTPS tunnel. Expiry is enforced server-side; the page only tells you when this device stops
working. The desktop pairing session uses a separate `dsh_desktop` cookie with a 12-hour
window and a non-loopback `Secure` flag.

**Separation from the host's own credentials** (full posture: [SECURITY.md](SECURITY.md)): the
bridge authenticates to the host with the harness's inner browser credential, which it redeems
itself. That credential exists only on the server-side path between bridge and host — **it never
reaches the phone**, which holds `dsh_mobile` and can call only the RPC methods listed below.

On the LAN the phone talks plain HTTP. Anyone on the same network can sniff or
tamper with that traffic, which is why the pairing and reconnect pages show a bilingual
warning and why public-channel pairings pass a consent page. Use the LAN mode on a network you
control; use a tunnel when you do not.

A tunnel forwards one port to a public URL and nothing else: every phone route and every RPC
call sits behind the pairing gate, and unauthenticated reads of branding assets are refused
(401). `/sw.js` is public by design — a browser fetches it before it holds any credential, and
it carries no data.

Every document, SSE stream, attachment and export is served
`no-store`, and the origin does not compress them; two documented incidents in 2026-10 made
that a boundary rather than a preference. Only three things get a long `max-age`, and only
because their name is either content-addressed or constant: the content-hashed `app.css` /
`app.js` (7 days), `/brand-logo/*` (1 hour) and `/app-icon` (1 day). Every response carries
`x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer` and
a per-request Content-Security-Policy nonce that authorises only the page's own script tag —
inline event attributes are still blocked, so the pages use delegated `data-action` handlers.
All text coming from the host is HTML-escaped on the way out; there is no `eval` and no shell
interpolation in this codebase.

## Tunnels

**Quick tunnel** (`cloudflared tunnel --url http://127.0.0.1:<port>`) needs no Cloudflare
account and mints a random `*.trycloudflare.com` hostname on every start — so the pairing QR
has to be re-issued each time, and a phone that reconnects needs the new URL.

**Named tunnel** (token + your own hostname, configured in the desktop panel) gives a stable
`https://<hostname>`. Two things to know:

- The token is handed to `cloudflared` through the `TUNNEL_TOKEN` environment variable, never
  on the command line, so same-machine processes cannot read it out of a process list.
- In token mode the local forwarding target is decided by the ingress you configured in the
  Cloudflare Zero Trust dashboard, **not** by this plugin. It must point at
  `http://127.0.0.1:<bridge port>` — the bridge port may have yielded to 43128, or be
  whatever `DSH_MOBILE_PORT` says. A wrong ingress shows a healthy, "online" tunnel while
  every phone request returns 502; the online log line says so explicitly.

The binary is resolved in this order: an explicit caller path, `DSH_POCKET_CLOUDFLARED`,
`CLOUDFLARED_BIN`, `vendor/cloudflared(.exe)` in this repository, then `cloudflared` on `PATH`.
If nothing is found, the pinned build is downloaded and its SHA-256 verified before use. To
pre-seed it (so the first tunnel start does not fetch ~55 MB):

```bash
node tools/fetch-cloudflared.mjs --print   # show the contract, no network
node tools/fetch-cloudflared.mjs           # download into vendor/, verify, delete on mismatch
```

The tool reads the pinned version, the asset filename and the digest from `lib/tunnel.js` — it
does not keep its own copy — and writes exactly the filename the resolver looks for.
`vendor/` is git-ignored. macOS ships a `.tgz`, which the bare-binary contract rejects
deliberately; on macOS the download path stays with the runtime.

## HTTP surface

The phone talks to the bridge only; the bridge talks to the host only, from the server side.

- **Phone pages** `/`, `/pair`, `/reconnect`, `/disconnected`, `/consent` (+ their POSTs).
  **Phone data** `/api/status`, `/api/boot`, `/api/rpc`, `/api/session/stream` (SSE),
  `/api/session/events` (tunnel polling), `/api/session-attachment`, `/api/session-file`,
  `GET|HEAD /api/session-export`. **Assets** `/app.css`, `/app.js` (content-hashed URLs),
  `/sw.js`, `/manifest.json`, `/brand-logo/*`, `/app-icon`. **Desktop surface** `/desktop` plus
  `status`, `tunnel/*`, `pairing/*`, `pin/*`, `notify/*`, `disconnect`, `revoke`, `pair/confirm`.
- **RPC** `POST /api/rpc` with `{method, payload}`, behind the device cookie and a same-origin
  check. `session.*`, `workspace.list`, `settings.describe`, `agentPreset.*`,
  `permissionPresets.catalog`, `command.execute`, `file.upload`, `skills.list`,
  `commands.list` are forwarded to the host; `interaction.pending|answer|cancel` are answered by
  the bridge itself. Anything else is `403 RPC method is not available on mobile.` The
  authoritative list is `RPC_ALLOWLIST` / `HARNESS_ENDPOINTS` in `lib/constants.js` — change
  those to change the interface; this section is a transcription.
- **Body tiers** 64 KB normally, ~35 MB for the four methods carrying base64, decided from the
  first 2 KB of the payload; over that, `413`.
- **Status** `GET /api/status` and the periodic SSE `status` frame come from one builder, so they
  are byte-identical. `connected` means "this bridge answered", never "the desktop is fine" —
  that is `hostReachable`, whose `null` means *not observed* and must not be read as *dead*.
- **Errors** transport `502`, arguments `400`, boot failure `503` with fixed copy; host internals
  are never transcribed to the phone. The stream emits `event: failure` with a `code` —
  `host-error` (does not feed reconnect backoff), `__bridge/stream-transport` (announces the
  next delay), `__bridge/stream-backoff` (suppression after repeated failures, never the first).

## Testing

The suite is plain `node:test`, no framework, no build:

```bash
npm install
npm test            # node --test --test-concurrency=1 test/*.test.js
```

Tests run a real bridge against a fake host over loopback, serially by design (`--test-concurrency=1`)
because each file binds its own OS-assigned port. Nothing in the default suite touches a real
profile, a real data root, or the internet; `test/tunnel.test.js` pins `DSH_HOME` to a throwaway
directory so the cloudflared resolver is exercised against an empty cache.

Two extras are intentionally outside the default glob, because they need more than the
repository:

```bash
npm run test:real-webserver     # loads the official host webserver payload: set DSH_OFFICIAL_MODULES first
node tools/render-stub.mjs      # real pages + canned RPC/SSE on 127.0.0.1:4399, for eyeballing in a phone viewport
node tools/smoke-bridge.mjs     # one bridge instance: bootstrap, gates, unpaired refusals, status shape
node tools/smoke-pairing.mjs    # pairing -> device cookie -> device visibility, end to end
```

`test-real-webserver.mjs` checks the plugin against the *official* loader: that the
registration shape is accepted, a duplicate `(kind, path)` throws, the plugin claims only
`/desktop` and `/brand-logo`, and its routes disappear on dispose. It exits non-zero and names
what it wanted rather than pretending to pass. `test/dom/` holds the browser-level assertions
(a real DOM pass over the boot path, a geometry gate over the phone layout); they are behind
environment switches and skip themselves when the browser or the pin file is absent.

See [CONTRIBUTING.md](CONTRIBUTING.md) before touching a test: several assertions here are
deliberately literal, and each one carries a comment naming the sentence it protects.

## Known limitations

- **A tunnel costs you real-time streaming.** Cloudflare's quick tunnel buffers SSE frames, so
  over a tunnel the phone falls back to incremental polling (from 1.5 s, adapting, and pulling
  immediately when the page returns to the foreground). On the LAN the stream is real time.
- **One extra head-page request when you open a session that has not been drawn yet** — the only
  bootstrap path for an empty transcript, bounded by two guards so it cannot spin. Pinned by tests.
- **Notifications are text-only.** WxPusher is judged by its business code and can echo the
  peer's masked error message; ServerChan and Bark are judged by HTTP status alone (their
  business-code semantics are not implemented). The test button shows success or failure only —
  the peer's message is in the bridge log.
- **No session delete from the phone.** The bridge has no delete channel; deleting a session
  is a desktop action.
- **A named tunnel has no in-panel recovery path.** If the hostname you typed is wrong, the
  tunnel reports online and every phone request 502s; clearing the stored value currently
  means editing the settings file by hand. This is the most likely next bug fix.
- **A hard-killed host can orphan cloudflared.** `process.on('exit')` does not run, so the child
  may survive. Closing this needs a pid sidecar plus an identity check — matching by image name
  would kill other people's tunnels, so it is not done.
- **Subagent sessions are not shown.** The phone list filters `origin === 'subagent'`; those
  sessions belong to the desktop's own orchestration.
- **The manifest is behind the pairing gate**, and a failed service-worker registration is
  quietly disabled for that browsing session (retried on the next visit) rather than nagging.
- **`muxConnected` / `devicesConnected` are reported but unread** by the page; the degraded light
  already covers the symptom they were meant to explain.
- **The host is a preview line.** Plugin APIs, the inner credential shape and the webserver
  registration path can change between DSH releases, and this plugin is coupled to them.

## Troubleshooting

- **"Pocket bridge is not ready (port 43128, EACCES)."** in the panel means the listener
  never bound. The message carries the port and errno when both are known. EADDRINUSE on
  anything other than 43127/43128 is a hard failure by design — free the port or set
  `DSH_MOBILE_PORT`. On Windows, note that `127.0.0.1:P` and `0.0.0.0:P` do not conflict; a
  real collision needs the same wildcard address.
- **The panel shows nothing / an iframe error.** The browser half is injected into the desktop
  GUI. Confirm the bundle is in the profile's `dsh.profile.bundles` and that the host was
  restarted after installing.
- **Phone says "connection lost" and never recovers.** A transient notice now expires on its
  own (90 s) or can be dismissed with its ×; if the underlying stream really is gone, bring
  the page to the foreground — it reopens the session stream.
- **Tunnel online, phone 502.** Almost always the Zero Trust ingress: it must point at
  `http://127.0.0.1:<bridge port>`, and that port is the one in the start-up log line.
- **Pairing accepted but the page will not load after a restart.** Check the durable password was
  consented to; without it pairings are memory-only and a restart ends them.
- **Nothing in the log.** The log lives under the data root shown above; the same lines are
  written to the host console.

## Packaging and licence

- `package.json files` publishes `lib/**/*.js`, `client/**/*.js`, `tools`,
  `cordis.patch.yml`, `README.md`, `README.zh-CN.md`, `LICENSE` and `CHANGELOG.md`.
- `test/` is deliberately **not** in the published file list: it is large, it is not loadable
  code, and the host never reads it when loading the plugin. Tests live in the repository, so
  run them from a git clone (`npm install && npm test`) — that is also what CI does. `tools/`
  *is* published, because the tunnel pre-seed and profile-install helpers are meant to be run
  by whoever installed the package.
- Licence is Apache-2.0; the full text is in [LICENSE](LICENSE).
- Release history is in [CHANGELOG.md](CHANGELOG.md): it exists, and its newest section tracks
  `package.json version`. Being updated on every commit is not promised.

