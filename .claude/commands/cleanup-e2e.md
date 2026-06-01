---
description: Force-clean any leftover E2E dummy users from the DB (only emails matching %rsn-e2e.invalid)
allowed-tools: Bash
---

Run the orphan cleanup script and report what was cleaned:

```bash
cd "C:/Users/ARFA TECH/Desktop/RSN" && node scripts/e2e-cleanup-orphans.mjs
```

Then verify DB is at baseline by running a quick count query (users, jr, sessions, pods, orphans) — orphans MUST be 0.

If any other E2E tables show drift (e.g. session_participants tied to deleted users, leftover audit_log rows), fix them with explicit per-ID DELETEs — never blanket DELETE.
