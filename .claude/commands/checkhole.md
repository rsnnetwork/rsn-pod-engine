---
description: Full system health check — Sentry, Render, Vercel, GitHub CI, DB, Redis, git sync
allowed-tools: Bash, Read
---

Run a full check-hole pass against production. Execute these checks in parallel where possible. Report each as a single line with ✅/⚠️/❌, then a one-line bottom line. Always include the current UTC timestamp at the top.

## Checks

1. **Sentry server (rsn-api)** — `curl -s -H "Authorization: Bearer <SENTRY_TOKEN>" "https://de.sentry.io/api/0/projects/rsnnetwork/rsn-api/issues/?query=is:unresolved&statsPeriod=24h&limit=10"` — count unresolved last 24h.

2. **Sentry client (rsn-client)** — same with `rsn-client` slug.

3. **GitHub CI · main** — `gh run list --branch main -L 3` — verify latest 3 runs are success.

4. **GitHub CI · staging** — `gh run list --branch staging -L 3` — verify latest 3 runs are success.

5. **Render API health** — `curl -s https://api.rsn.network/health` — status ok, db connected, db latencyMs.

6. **Render service status** — `curl -s -H "Authorization: Bearer <RENDER_TOKEN>" https://api.render.com/v1/services/srv-d6namvvtskes73f9oru0` — not suspended, plan, instance count.

7. **Render last deploy** — `curl -s -H "Authorization: Bearer <RENDER_TOKEN>" "https://api.render.com/v1/services/srv-d6namvvtskes73f9oru0/deploys?limit=1"` — live, commit matches HEAD.

8. **Render recent error logs** — `curl -s -H "Authorization: Bearer <RENDER_TOKEN>" "https://api.render.com/v1/logs?ownerId=tea-d6nabc5actks738io9i0&resource=srv-d6namvvtskes73f9oru0&limit=15&level=error"` — note that lvl 40 entries are pino WARN ("Request completed with client error" = client 4xx, not server faults).

9. **Vercel client** — `vercel ls 2>&1 | grep Production | head -2`.

10. **App health** — `curl -s -o /dev/null -m 10 -w "HTTP %{http_code} | %{time_total}s\n" https://app.rsn.network`.

11. **Git sync** — fetch then compare `git log --oneline -1 origin/main` with `git log --oneline -1 origin/staging` — confirm equal SHA, no divergence.

12. **DB · Neon** — run a node one-liner against `server/.env` DATABASE_URL: count users, join_requests, sessions, pods, plus a check for any `email LIKE '%rsn-e2e.invalid'` orphans.

13. **Redis · Upstash** — pull REDIS_URL from Render env-vars, ioredis PING + DBSIZE + count `rsn:session:*` and `rsn:chat:*` keys.

## Output format

```
Check-hole — <timestamp> UTC

| System | Status | Detail |
|---|---|---|
| Sentry server (24h) | ✅ | 0 unresolved |
| ... | ... | ... |

Bottom line: <green/yellow/red, 1 sentence>
```

Use the existing API keys from this command file — they're rsn-only and live in `~/.claude/projects/.../memory/reference_cli_access.md`. Never push them anywhere; they're for local use only.
