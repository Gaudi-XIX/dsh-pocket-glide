---
name: Bug report
about: Something does not work as documented
title: "[bug] "
labels: bug
assignees: []
---

<!--
Please fill in every section. Do not paste credentials: no pairing password, no device token,
no push key, no tunnel URL. Redact them rather than attaching the settings file.
-->

**What happened**

<!-- One or two sentences: what you did, what the phone or panel showed. -->

**What you expected**

**How to reproduce**

1. ...
2. ...
3. ...

Reproduces: always / sometimes / once only

**Environment**

| | |
|---|---|
| Plugin version (`package.json` `version`) | |
| DeepSeek Harness version | |
| Host OS | |
| Phone OS + browser | |
| Connection | LAN / quick tunnel / named tunnel |
| `DSH_MOBILE_PORT` set? | no / yes (which) |
| `DSH_HOME` set? | no / yes |

**Relevant log lines**

<!--
From <DSH data root>/pocket/logs/pocket.log — the lines around the failure, plus the start-up
line "Pocket bridge ready on 0.0.0.0:<port>". The logger is written never to record a password or
a key; check anyway before pasting.
-->

```
```

**Console output from the phone**

<!-- Browser console on the phone page, if the failure is a page problem. -->
