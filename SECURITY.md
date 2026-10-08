# Security Policy

## Current posture

This repository is **private** while the plugin is stabilising. The claims below describe the
private stage: what we can promise changes if and when the repository goes public.

Apache-2.0 applies to the code as licensed. There is currently no published package, no
third-party hosting of this bridge, and no formal disclosure programme.

## What this software does to your security posture

Read this section before you deploy it anywhere, including at home.

- The plugin opens an HTTP listener on `0.0.0.0` in the DeepSeek Harness process. On the LAN that
  listener speaks **plain HTTP**; anything on the same network can observe it.
- A tunnel (Cloudflare quick or named) publishes that listener to a public URL. A paired device
  can then read your session list, message history, and send prompts on your machine.
- It grants a remote device access to a working agent on your machine. Treat a paired phone,
  a leaked pairing password, and a leaked tunnel URL as credentials.
- Credentials on disk: the durable pairing password, device session tokens, push-notification key
  and Cloudflare tunnel token live in JSON files written `0600` on POSIX. On Windows the mode bits
  do not apply; the directory ACL is what protects them.

## Reported behaviours we consider design, not bugs

- Unauthenticated requests are refused with `401`, including branding assets.
- Pairing passwords expire (5 minutes for the ephemeral one) and a hard lockout follows repeated
  failures (15 minutes per limit key).
- The host's own inner credential is never sent to a phone.
- Documents, streams and exports are served `no-store`; only content-hashed or constant asset URLs
  are cacheable.

## Reporting a vulnerability

Open a private issue, or contact the repository owner directly if the private issue tracker is not
available to you. Include:

1. What an attacker gains, and what they must already hold to gain it (LAN access, a pair, a URL).
2. The version (`package.json` `version`) and the host version.
3. Steps to reproduce against a fresh install.

What to leave out of the report body: your pairing password, your device tokens, your push key, and
your tunnel URL. Redact them; do not paste the file contents. We may ask for the log file
(`<DSH data root>/pocket/logs/pocket.log`) — the logger is written never to record a password or a
key, but check before attaching.

**Acknowledgement:** we aim to reply within 7 days at the private stage.
**Fix disclosure:** if a fix ships, it will be described in `CHANGELOG.md` under that version. There
is no embargo commitment while the repository is private.

## Hardening checklist for an installation

- Prefer a named tunnel on a hostname you control over the random quick-tunnel URL.
- Set the durable password only if you need pairings to survive restarts; revoke it when a device
  leaves your control, and revoke devices individually from the desktop panel.
- Do not pair from a network you do not control (conference Wi-Fi, hotel, a shared mobile
  hotspot).
- Keep `DSH_MOBILE_PORT` at its default unless you understand the port-yielding rule, and never
  expose the bridge through a reverse proxy that adds its own authentication in front of it —
  the pairing gate is the authentication.
- If the machine is shared with other user accounts, remember that a process running as the same
  user can reach the loopback listener. This plugin does not attempt to protect against a
  same-user process on the host machine.
