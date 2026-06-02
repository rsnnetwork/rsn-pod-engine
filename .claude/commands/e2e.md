---
description: Run the full E2E test against production — creates dummy users, walks invite/accept/visibility/state flows, cleans up by ID
allowed-tools: Bash
---

Run the production E2E:

```bash
cd "C:/Users/ARFA TECH/Desktop/RSN" && node scripts/e2e-may10-fixes.mjs
```

When it finishes, immediately verify cleanup was complete:

```bash
node -e "require('dotenv').config({path:'C:/Users/ARFA TECH/Desktop/RSN/server/.env'});const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:1});(async()=>{const r=await p.query(\"SELECT (SELECT count(*) FROM users WHERE email LIKE '%rsn-e2e.invalid')::int orphans,(SELECT count(*) FROM magic_links WHERE email LIKE '%rsn-e2e.invalid')::int orphan_ml\");console.log('orphans:',r.rows[0]);await p.end()})()"
```

If orphans > 0, run `/cleanup-e2e` to force-clean them.

The script tests:
- Phase A: invite-accept redirect URL is `/session/:id/live` (singular), idempotent re-accept handles cleanly
- Phase D1: testMode is false on a real prod event
- Phase G: setHostVisibility succeeds and snapshot includes hostVisibilityModes

If any assertion fails, the script logs `❌ <step>` and exits non-zero. Cleanup still runs in finally{} so no DB drift either way.
