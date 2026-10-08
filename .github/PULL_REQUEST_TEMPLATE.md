<!--
Keep this pull request one behaviour change. Delete this comment block before submitting.

If the diff touches the phone pages, the pairing gate, the RPC allowlist or the tunnel manager,
say which guarantee you believe still holds — those four areas are where this plugin can go wrong
quietly.
-->

## What changed

## Why

<!-- The problem being solved, not the mechanism. Link an issue if there is one. -->

## How it was verified

- [ ] `npm test` (`node --test --test-concurrency=1 test/*.test.js`) is green
- [ ] the change was also exercised against a live host (DeepSeek Harness restarted, phone reloaded)
- [ ] `node tools/render-stub.mjs` eyeballed in a phone viewport (page/render changes only)
- [ ] a mutation or a manual counter-case proves the new assertion can fail
      <!-- An assertion that cannot go red is not a guard. Describe what you broke on purpose. -->

## Docs kept in step

- [ ] `README.md` — the section describing this behaviour
- [ ] `README.zh-CN.md` — the same section, in Chinese
- [ ] `CHANGELOG.md` — an entry under the target version (user-facing wording only)
- [ ] `SECURITY.md` — if the change widens what a paired device, or a stranger, can reach

## Known gaps

<!-- What you did not do, what you are unsure about, anything you deliberately left broken. -->
