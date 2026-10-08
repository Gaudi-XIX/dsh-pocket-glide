---
name: Feature request
about: A capability you would like the bridge to have
title: "[feat] "
labels: enhancement
assignees: []
---

**The problem, in your words**

<!-- What cannot be done today, and what you do instead. A use case, not a design. -->

**Where it would live**

- [ ] phone pages / rendering
- [ ] pairing, devices, permissions
- [ ] tunnel
- [ ] notifications
- [ ] the desktop panel (`/desktop`, sidebar)
- [ ] host integration (new RPC surface)
- [ ] other (say which)

**Would it need a new interface?**

<!--
Adding or widening an RPC method is a contract change: the allowlist in lib/constants.js is the
only gate between a phone and the host, and it is pinned by tests. Say explicitly if your request
needs one, and what a phone could then reach.
-->

**Security posture effect**

<!-- Does this widen what is reachable from a public tunnel, or store a new secret? If unsure, say so. -->

**Alternatives you considered**

**Implementation notes (optional)**

<!-- Anything you already know about the code paths involved. Completely fine to leave blank. -->
