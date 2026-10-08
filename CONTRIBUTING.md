# Contributing

Thanks for reading this before opening anything.

## What this project is

A single-purpose DSH plugin: a phone bridge that runs inside the DeepSeek Harness process.
Design constraints that decide most review comments:

- **The plugin is not a separate process.** It loads through the host's bundle mechanism and has
  no main guard. Nothing here should assume it can start itself.
- **No build step.** `lib/**` and `client/client.js` are shipped as the same bytes the host
  loads. Please do not add a bundler, a transpiler, or a generated artifact to the tree.
- **Source edits are not hot.** Testing a change against a live host means restarting DeepSeek
  Harness; a page reload on the phone is not enough.
- **Phone-visible errors stay generic.** Host paths, stack traces and internal error text must
  not reach the phone. `tools/red-check.mjs` and the bridge's own tests pin this.
- **Never log a pairing password or a push key.** Secrets exist in memory, in outbound requests,
  and in the `0600` store files — not in the log.

## Working on the code

```bash
git clone <this repository> && cd dsh-pocket
npm install
npm test
```

- Node `^22.19.0 || >=24.0.0`. Everything is ESM (`"type": "module"`); no TypeScript, no lint
  toolchain is configured — match the style of the file you are editing.
- `lib/**` is where the bridge lives. `lib/constants.js` holds the interface shape
  (`RPC_ALLOWLIST`, `HARNESS_ENDPOINTS`, ceilings, TTLs); `lib/pages.js` and `lib/projections.js`
  own the phone's rendering; `client/client.js` is the one browser-half registration.
- `README.md` documents behaviour as it *is*. If you change an interface, the README section and
  `CHANGELOG.md` entry belong in the same pull request.

## Tests

The suite is `node:test` with no framework:

```bash
node --test --test-concurrency=1 test/*.test.js   # same as npm test
```

- Tests bind real loopback listeners, so they run serially by design. Use port `0` (OS-assigned)
  and read the port from the `start()` snapshot; never hard-code a port.
- `test/helpers.js` clears `DSH_MOBILE_PORT` for the run. That line is a guard, not leftover
  config: without it every test file would try to bind the same fixed port.
- Tests must not touch a real profile, a real data root, or the internet. Anything that would
  write into the user's data directory is pinned to a temporary `DSH_HOME` — follow
  `test/tunnel.test.js` and `test/file-log.test.js`.
- `test-real-webserver.mjs` and `test/dom/*` sit outside the default glob because they need the
  official host payload or a real browser. They skip or fail loudly; they never fake a pass.

### The house rule about assertions

Several assertions here are deliberately literal — they count occurrences, or match an exact
phrase in a README, or pin a contract string between a tool and the runtime. Each one carries a
comment naming **the sentence it exists to protect**. If such an assertion goes red:

1. Read that comment first. It says why the assertion exists, not just what it matches.
2. Change the protected sentence (in the README, `package.json`, or the tool's header) and then
   update the assertion to match.
3. Do not comment an assertion out, do not add a skip, and do not loosen it until it passes. That
   is how a fixed bug comes back.

Two literal traps that have burned time here:

- Page output that contains the characters of an opening script tag is counted by the tag-counting
  test. Keep such examples out of rendered strings.
- An assertion compares bytes emitted when no CSP value is injected, so a document carrying a
  certain CSP word can break it. Keep that word out of phone-page copy and comments.

## Before opening a pull request

- `npm test` green on your machine.
- Any behaviour change documented in `README.md` and `README.zh-CN.md`, and recorded in
  `CHANGELOG.md` under the version you are targeting.
- No machine-specific absolute paths, account names, hostnames, addresses or credentials in code,
  comments, docs or fixtures — including your own. Use `<DSH profile dir>`, `<this checkout>` or an
  OS-neutral example.
- Nothing newly added to `package.json files` that is not actually needed at load time, and
  nothing the README promises that `files` then drops.

## Reporting an issue

Use the issue template. The three things that make a report actionable for this project:

1. Host version (`DeepSeek Harness` about-box), OS, plugin version.
2. The relevant lines from `pocket.log` (see README "Where files are kept") — with any password
   or key redacted, never removed by deleting the file.
3. Whether you were on the LAN or a tunnel, and which of the two tunnel modes.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Licence

By contributing you confirm the contribution is yours to offer and that it is licensed under the
Apache License 2.0, the same licence as the rest of this repository.
