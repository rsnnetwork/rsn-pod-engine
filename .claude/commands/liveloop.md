---
description: During a real test event, kick off a polling loop that runs /checkhole every minute so any production regression surfaces within 60 seconds
allowed-tools: Bash
---

Set up a 1-minute polling loop that runs `/checkhole` until manually stopped. Use the built-in `/loop` slash command:

```
/loop 1m /checkhole
```

Use this WHEN:
- Stefan + Shraddha (or any client) are running a real live test
- You just shipped a high-risk change and want to monitor the deploy window
- You're debugging a transient production issue

Stop conditions:
- The test finishes and you tell me to stop
- A red status appears — escalate immediately, don't wait for next tick
- The session ends (loop is in-session only)

Important: `/loop` runs in this Claude Code session only — it stops when you close the terminal. For laptop-off monitoring, use `/schedule` (cloud-based remote agent) instead.
