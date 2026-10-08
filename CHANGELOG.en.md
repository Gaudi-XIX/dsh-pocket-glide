# Changelog

All notable user-facing changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries
describe what changes for someone installing or using the plugin — internal refactoring,
audit trails and build notes live in the commit history instead.

Because the plugin runs inside the host process, **every release needs a DeepSeek Harness
restart** before a phone picks it up.

The Chinese version is in [CHANGELOG.md](CHANGELOG.md).

## 0.4.0 - 2026-10-08

### Added

- **Streaming survives a public tunnel.** Cloudflare's quick tunnel buffers SSE frames,
  so an AI reply used to freeze and then arrive in lumps. Over a tunnel the phone now
  falls back to adaptive incremental polling (from 1.5 s, and it pulls immediately when
  the page returns to the foreground); on the LAN the real-time stream is unchanged.
- **Tool activity reads as a story.** Tool cards show a localized three-state narrative
  (editing a file → changed a file) instead of an English tool name plus raw JSON,
  collapse repeated actions ("read 5 files"), render line-level diffs for edit/write,
  and keep the technical payload behind a second-level disclosure.
- **Images and files became usable on a phone.** Lightbox for images (fullscreen, two
  zoom levels, save), inline preview for text attachments (truncated with "show all" and
  copy), and files or images the assistant presents now render as cards. A new
  session-file endpoint serves only paths that already appear in this session's event
  stream — anything else answers 404, so no arbitrary file read is possible.
- **Device profiles and recovery.** A paired phone recovers with the PIN alone after the
  tunnel hostname changes or the host restarts — credential and public-access consent are
  re-issued from the device record instead of being asked again. The desktop panel gains a
  paired-devices page (name, paired at, expiry, last seen, per-channel permission) with
  per-device revoke, extend and permission edits. Existing pairings migrate without
  re-pairing.
- **Smart scrolling.** The transcript pins to the bottom while streaming, stops the
  moment you scroll up, and offers two anchors: "latest" and "back to your last message".
  Historical messages are virtualized, so long sessions stay responsive.
- **Unread markers per session**, and an **offline fallback page** instead of a white
  screen when the connection drops, with one-tap reload.
- **Approval pushes.** When the assistant is waiting for an answer to a question, a
  notification goes out immediately (silently skipped if no push channel is configured).

### Changed

- Completion notifications judge "done" from a quiet period (90 s), a 10 s grace, an
  immediate push when a queued message is sent, and a 30-minute backstop — fewer false
  "task finished" reports and fewer missed ones.
- Disconnect copy is now specific: session expired, desktop disconnected, workspace
  closed and connection timeout are separate messages, and the reconnect banner is
  visually distinct from an error banner.

### Fixed

- WxPusher no longer records a success when the push was not delivered: the simple-push
  endpoint is used and the business code in the response body decides the outcome. The
  peer's own error text is masked and surfaced on the "send test" button.
- A named tunnel's Cloudflare token is passed through the `TUNNEL_TOKEN` environment
  variable instead of the command line, so same-machine processes can no longer read it.
- Opening a session that contains an assistant-attached image no longer crashes the phone
  page.

## 0.3.1 - 2026-10-07

### Added

- File attachments in history are downloadable cards with the real filename and size, not
  dead chips. Images keep rendering inline; an attachment the host already reclaimed stays
  a read-only chip and is not requested.

### Fixed

- Saving a file from the phone no longer names everything "attachment": the download
  carries the filename recorded by the host (with quotes and newlines stripped).
- A transient notice ("connection lost", "moved to the background, resuming when you
  return") is no longer permanent. It now has three exits — a stream frame, a 90-second
  expiry, or the × on its right edge — all behind the same guard, so a successful poll
  cannot silently clear something that still matters.
- Notices follow the composer as it grows instead of being pinned at a fixed height and
  getting covered by it.
- The notice yields to the question panel rather than floating above it.
- Returning the phone page to the foreground reopens the session stream when it is down.

## 0.3.0 - 2026-10-07

### Added

- PWA manifest is attached, so "add to home screen" gives a real app shell instead of a
  bookmark.
- The connection dot is tri-state: connected / host unresponsive / disconnected. A desktop
  that stopped answering is no longer presented as business-as-usual.
- Outbound completion notifications over ServerChan, Bark or WxPusher, with channel, key
  and on/off controls in the desktop panel; settings are written atomically.
- A consent page gates pairings that arrive over a tunnel: public access needs an explicit
  acknowledgement before RPC is allowed.
- Named tunnels: a Cloudflare token plus a fixed hostname in the desktop panel, so the URL
  stops changing at every start. The dashboard ingress must point at
  `http://127.0.0.1:<bridge port>`; both the panel and the online log say so.
- Paired phones recover without re-scanning a QR code, from a device list in the panel.
- Pairing results persist, so a host restart does not invalidate a 30-day device cookie.
- The desktop goal bar and the queue dock are mirrored on the phone: queued messages can be
  edited inline, withdrawn, or sent immediately.
- The stop button reacts instantly (spinner plus a "stopping" line) instead of waiting for
  two round trips.

### Fixed

- Token-by-token streaming output is restored — an event-shape mismatch was swallowing
  every streamed piece.
- Sending an image is no longer rejected outright: the page budgets the transfer, and a
  413 now reports both the original size and the limit with next steps.
- A tunnel killed from outside no longer disconnects LAN sessions with it.
- Empty leftover desktop sessions no longer appear as unnamed rows, and a failed session
  creation is no longer silent.
- A wedged "thinking…" indicator is reclaimed by an idle watchdog, while a turn awaiting a
  user question is not.
- Render fixes: the send-failure banner is a fixed banner (not pushed out of view by the
  composer or the queue dock), inline editing of queued messages no longer borrows composer
  styles, long queued text no longer breaks its row, the "+" panel's sub-page keeps a real
  back button, and the multi-select empty-answer hint uses multi-select wording.
- Permission presets fall back to localized names and plain-language descriptions when the
  host catalog is unavailable, with the dangerous tier marked in red.
- The reconnect-failure page offers "go back to the computer and re-scan" in tunnel mode.
- Turning notifications off actually stops outbound pushes.
- Incremental sync no longer drops records that carry no sequence number.
- The tunnel hostname ceiling matches what a QR code can hold (150 characters), the same
  limit is enforced on read, write and the panel's save endpoint, and an over-long value is
  a visible 400 rather than a "success" that discards it.

### Removed

- Nothing user-facing was removed in this release.

## 0.2.1 - 2026-10-03

### Added

- Each assistant turn gets exactly one timestamp on its final message, plus a token-usage
  pill on the same bubble; user messages keep their own time.

### Fixed

- The running indicator no longer disappears early in long, event-dense turns.
- The session list hides subagent sessions and no longer leaves a host error message plus a
  stuck "retry" on screen.
- The phone no longer jumps into a subagent session when the host reports focus there at
  boot; an unknown row is let through rather than replaced.
- Extracting a cloudflared archive on Windows hides the console window.

### Changed

- The desktop entry is labelled "pocket" instead of "connect phone".

## 0.2.0 - 2026-10-03

### Added

- Session list ordering is fixed and "load more" has a definite page size (30 by default,
  capped at 200).
- Named disconnect copy for dropped streams, background moves and tunnel failures.
- Swipe-back from a session lands on the workspace list instead of leaving the browser.
- Touch targets raised to 44 px, light theme contrast at WCAG AA, status roles and live
  regions added, focus trapping in the "+" panel, labelled icon buttons.

### Changed

- The pairing password is 8 digits instead of 6. Input fields and validation accept 6–12,
  so a durable password already on disk keeps working without migration.
- Host credential caching gained a TTL and generation invalidation, so an authority change
  or a failed handshake re-authenticates instead of retrying with a stale cookie.
- The session watermark is tracked per session; probes and refreshes can't borrow another
  session's progress.
- The "+" panel search box no longer opens the keyboard by itself.

## 0.1.0

### Added

- First release: LAN listener with an optional Cloudflare quick tunnel, QR and PIN pairing,
  session list, history, sending a message and streaming the reply.
