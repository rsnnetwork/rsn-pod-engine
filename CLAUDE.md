# RSN Pod Engine — Claude Code Rules

> RSN (Raw Speed Networking) is a real-time video networking platform (like Zoom/Google Meet but with structured matching, rounds, ratings, and pod orchestration). It must behave instantly, never require manual refresh, and handle every edge case gracefully. These rules are non-negotiable for every line of code, every bug fix, every feature, and every deployment.

---

## 1. Architecture (Know the System)

### Stack
- **Monorepo**: `shared/` (types) → `server/` (Express + Socket.IO) → `client/` (React + Vite)
- **Server**: Express 4, Socket.IO 4, PostgreSQL (raw SQL via `pg`), Redis (ioredis), Pino logger, Zod validation, JWT auth, Sentry
- **Client**: React 18, Vite 5, Zustand (local state), React Query (server state), Socket.IO client, LiveKit (video), Tailwind CSS
- **Deploy**: Server on Render, Client on Vercel, DB on Neon/hosted PostgreSQL, Redis on Upstash
- **Real-time**: Socket.IO with Redis adapter for multi-instance broadcasting, Redis-backed session state + chat persistence
- **Monitoring**: Sentry for error tracking (server-side wired, client needs DSN)

### Critical Invariant: Real-Time First
RSN is a LIVE platform. Every state change must propagate to every affected client within milliseconds WITHOUT requiring a page refresh. This is the #1 architectural rule.

**The pattern** (entity-tag invalidation — see `docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md`):
1. Server mutates data → calls `emitEntities(io, affectedUserIds, ['entity:tag', ...])` 
2. Client receives `entity:changed` → React Query predicates match `meta.entities` → auto-refetch
3. UI updates instantly, zero refresh needed

**Every mutation** (REST route, socket handler, background job) MUST emit entity tags. If you add a new mutation and skip the emit, you break real-time. No exceptions.

---

## 2. Bug Fix Rules (Root Cause, Not Symptoms)

### Before writing a single line of code:
1. **Reproduce** the bug — describe exact steps, what happens, what should happen
2. **Trace the full data flow** — DB → service → route/socket → client store → React component
3. **Identify the ROOT CAUSE** — not "the UI doesn't update" but WHY it doesn't update (missing socket emit? missing entity tag? wrong React Query key? stale Zustand selector?)
4. **Check for the same pattern elsewhere** — if this bug exists in one place, it likely exists in similar places. Fix ALL of them in one pass.

### The fix must be architectural:
- Don't add `window.location.reload()` or `setTimeout(fetchData, 1000)` — those are hacks
- Don't add one-off socket events for one screen — use the entity-tag pattern
- Don't duplicate state between Zustand and React Query — React Query is the source of truth for server data; Zustand is only for ephemeral client-only state (live session, toasts, auth tokens)
- If the fix requires a refresh to work, it's not a fix

### After the fix:
- Verify the fix works WITHOUT any page refresh
- Verify it works for ALL affected users (the actor, other participants, the host, admin)
- Verify it works on mobile and desktop
- Verify no regressions in related features

---

## 3. Real-Time Rules

### Server-side (every mutation):
```
1. Validate input (Zod)
2. Execute DB transaction
3. Return REST response to the caller
4. emitEntities(io, affectedUserIds, [entity tags]) ← NEVER SKIP
```

### Entity tag rules:
- Tags are **domain-shaped**, never UI-shaped: `pod:<id>:members` not `pod-detail-page-member-list`
- When in doubt, emit MORE tags, not fewer — over-invalidation causes a refetch (cheap), under-invalidation causes stale UI (expensive bug)
- Affected users = everyone who could be looking at this data. For pod changes: all pod members. For session changes: all participants + host. For admin changes: all admin users.
- Reference `ENTITIES.md` and `docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md` for the full entity vocabulary

### Client-side (every useQuery):
- Every `useQuery` MUST have `meta: { entities: [...] }` declaring which entity tags would invalidate it
- If a query has no entity tags, it will NEVER update in real-time — this is always a bug
- The global `useEntityChangedHandler` in `App.tsx` handles invalidation automatically

### Socket event rules:
- NEVER add new bespoke socket events (e.g., `pod:something_happened`) — use `entity:changed` instead
- Existing bespoke events are legacy; they stay until the migration is complete but new code must use the entity-tag pattern
- In-event orchestration events (match assignments, round transitions, presence) remain as-is — they carry payload, not just invalidation signals

### Known real-time pitfalls (guard against these):
- **REST overwrites socket state**: `applyFullState()` from periodic resync can overwrite newer socket-pushed data. Always timestamp snapshots and only apply if newer.
- **Late-joiner race**: A user joining mid-session gets socket listeners + a REST snapshot. If a socket event arrives between mount and snapshot response, the snapshot overwrites it. Guard with timestamps.
- **Missed events during disconnect**: If a client disconnects and reconnects, it misses all socket events during the gap. On reconnect, ALWAYS fetch a full state snapshot and chat history.
- **Targeted vs broadcast events**: Some events go to a single user (`socket.emit`) while others go to the room (`io.to(sessionRoom).emit`). When ALL participants need to know about a change, always broadcast to the room — never rely on each client to poll for it.

---

## 4. Coding Rules

### General:
- TypeScript strict mode, no `any` unless truly unavoidable (and then add a comment explaining why)
- No `// @ts-ignore` or `// @ts-expect-error` — fix the type
- No `console.log` — use `logger` (server) or remove it (client)
- No dead code, no commented-out code, no TODO without a linked issue
- No `eslint-disable` without a comment explaining why
- Functions do one thing. If a function needs a comment explaining what it does, rename it or split it.
- Prefer early returns over nested if/else
- Error messages must be user-friendly (no stack traces, no technical jargon in toast messages)

### Server:
- All DB queries use parameterized statements (`$1, $2` — never string interpolation)
- All mutations wrapped in `transaction()` when they touch multiple tables
- All routes validate input with Zod before touching the DB
- All routes use the existing `AppError` hierarchy (NotFoundError, ForbiddenError, etc.) — never `throw new Error('...')`
- All new routes must have rate limiting appropriate to the action
- Service functions return data; routes format responses. Services never touch `req`/`res`.
- Socket handlers: always wrap in try/catch, always verify the user has permission for the action

### Client:
- React Query for ALL server data (pods, sessions, users, invites, etc.)
- Zustand ONLY for: auth state, live session ephemeral state (current match, timer, connection status), UI state (toasts, modals)
- Never store server data in Zustand — that creates two sources of truth that drift
- Never call `queryClient.setQueryData()` to manually update cache — let entity-tag invalidation trigger a refetch. Manual cache updates cause drift.
- Exception: optimistic updates for instant UI feedback (e.g., marking a notification as read) — but always pair with invalidation as the source of truth
- All API calls go through `lib/api.ts` (the Axios instance with auth interceptor)
- All forms use `react-hook-form` + Zod resolver
- All error states must show meaningful feedback (never a blank screen or silent failure)
- All loading states must show a skeleton or spinner (never a layout jump)
- All empty states must show a message (never a blank area)

### Naming:
- Files: `kebab-case.ts` for utilities, `PascalCase.tsx` for React components
- Variables/functions: `camelCase`
- Types/interfaces: `PascalCase`
- DB columns: `snake_case`
- API responses: `camelCase` (converted at the route level)
- Entity tags: `kebab-case:uuid` or `kebab-case:uuid:sub-resource`

---

## 5. Security Rules

- NEVER trust client input — validate everything server-side with Zod
- NEVER expose internal error details in production (stack traces, SQL errors, file paths)
- NEVER put secrets in code, config files, or client bundles — env vars only
- NEVER commit `.env` files — use `.env.example` with placeholder values
- All authenticated endpoints must use `authenticate` middleware
- All role-restricted endpoints must use `requireRole()` or `requireOwnerOrRole()` middleware
- Socket handlers must verify the user's relationship to the session/pod before executing (e.g., only hosts can emit `host:*` actions)
- Rate limiting on every public endpoint (auth endpoints get stricter limits)
- SQL injection: parameterized queries ONLY — never interpolate user input into SQL strings
- XSS: sanitize any user-generated content that gets rendered (pod names, chat messages, profile fields)
- CSRF: use SameSite cookies and verify Origin headers for state-changing requests

---

## 6. Error Handling Rules

### Server:
- All route handlers: `try { ... } catch (err) { next(err); }` — the global error handler does the rest
- Service layer throws `AppError` subclasses (NotFoundError, ForbiddenError, ConflictError, etc.)
- Unknown errors get caught by the global handler, logged as `error`, and returned as 500 with a generic message
- Sentry captures all unhandled errors automatically — don't add manual `Sentry.captureException()` in route handlers unless you need extra context

### Client:
- `ErrorBoundary` at root catches React render crashes — never let the whole app go white
- API errors: extract the error message from `err.response.data.error.message`, show via toast
- Network errors: show "Connection lost, retrying..." — never show "AxiosError" or "Network Error" to users
- Socket disconnection: show a banner, auto-reconnect, re-sync state on reconnect
- Form validation: show errors inline next to the field, not as a toast
- Never swallow errors silently (`catch(() => {})`) unless you've explicitly decided that failure is acceptable and documented why

---

## 7. Performance Rules

- No N+1 queries — if you're fetching a list, get all related data in one query (JOIN or subquery)
- No unbounded queries — always LIMIT results, paginate large lists
- Database indexes on every column used in WHERE, JOIN ON, or ORDER BY clauses
- Batch operations: if updating 100 rows, use a single UPDATE with IN clause, not 100 individual UPDATEs
- Socket fanout: `emitEntities()` broadcasts to user rooms — never iterate users and emit individually in route code
- Client: React.memo only when profiling shows a bottleneck — don't prematurely optimize
- Client: lazy-load heavy routes (live session, admin pages) with React.lazy + Suspense
- Images: use proper sizing, compression, and lazy loading
- API responses: only return fields the client needs, not entire DB rows

---

## 8. Testing Rules

- Every bug fix should include a description of how you verified it works
- Test the golden path AND the edge cases:
  - What if the user double-clicks?
  - What if two users do the same thing simultaneously?
  - What if the network drops mid-action?
  - What if the user has no permissions?
  - What if the data doesn't exist (deleted pod, cancelled session)?
  - What if the input is empty, too long, or contains special characters?
- For live session features: test with 1 participant, 2 participants, odd number, and max capacity
- For real-time features: verify updates appear on ALL affected clients without refresh
- Build must pass (`npm run build` for both server and client) before any commit
- TypeScript must compile with zero errors

---

## 9. Redis Rules

RSN uses Redis (ioredis + Upstash) for three critical functions:
1. **Socket.IO adapter** — `@socket.io/redis-adapter` enables multi-instance broadcasting. Every `io.to(room).emit()` reaches ALL server instances.
2. **Session state persistence** — `activeSessions` map is backed to Redis with TTL. Server restart recovers live sessions from Redis instead of losing them.
3. **Rate limiting** — `rate-limit-redis` distributes rate limit counters across instances.

### Rules:
- Redis is **optional but expected** in production. The system gracefully degrades to in-memory if Redis is unavailable — but this means session state is lost on restart and multi-instance broadcasting breaks.
- Always use `getRedisClient()` and check for `null` before Redis operations — never assume Redis is available.
- All Redis keys must be prefixed with their domain (`rsn:session:`, `rsn:chat:`, etc.) to avoid collisions.
- Always set TTL on Redis keys — never store data without expiry. Live session data: 4 hours. Chat messages: 4 hours. Rate limit counters: match the window.
- Never store large objects in Redis — keep payloads under 1MB. If you need to store more, put it in PostgreSQL and cache a reference in Redis.
- For new features that need caching: use Redis first, PostgreSQL as the source of truth. Cache invalidation must happen in the same transaction as the DB write.

---

---

## 10. Database Rules

- Migrations are append-only — never modify an existing migration file
- New migration files: `NNN_descriptive_name.sql` (next number in sequence)
- Every migration must be wrapped in a transaction (BEGIN/COMMIT)
- Every new table must have: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at TIMESTAMPTZ DEFAULT NOW()`, appropriate indexes
- Every FK must have ON DELETE behavior specified (CASCADE, SET NULL, or RESTRICT — choose deliberately)
- Every enum change must use the safe pattern: add new value, migrate data, then (optionally) remove old value
- Never DROP TABLE or DROP COLUMN in production without a data migration plan
- JSONB columns are acceptable for flexible config, but fields that get queried/filtered must be proper columns with indexes

---

## 11. Deployment Rules

- Server deploys to Render from `main` branch — every push to main is a production deploy
- Client deploys to Vercel from `main` branch — same
- NEVER push directly to main without testing the full flow
- Migrations run automatically on server startup — ensure they're idempotent and safe
- If a migration could fail on existing data, add a safety check (IF NOT EXISTS, etc.)
- Environment variables: add to Render/Vercel BEFORE deploying code that uses them
- After deploy: verify `/health` endpoint, check Sentry for new errors, test the critical path (login → join session → see participants)

---

## 12. UI/UX Rules

- Every action must have immediate visual feedback (button loading state, optimistic update, or toast)
- Never show raw IDs, error codes, or technical strings to users
- Destructive actions (delete, remove, leave) require a confirmation dialog
- Navigation must never dead-end — every page must have a way back
- Mobile: touch targets minimum 44x44px, no hover-only interactions
- Forms: disable submit button while submitting, show validation errors inline, preserve user input on error
- Empty states: always show a message and ideally a CTA ("No sessions yet — create one")
- Loading states: skeleton screens for layout-heavy pages, spinners for inline actions
- Toasts: success auto-dismiss in 2.5s, errors persist for 6s, info for 4s (already configured in toastStore)

---

## 13. When Adding a New Feature

Follow this checklist for EVERY new feature:

1. **Shared types**: Add/update types in `shared/src/types/`
2. **Database**: Create migration if new tables/columns needed
3. **Server service**: Business logic in a service file (not in routes)
4. **Server route**: Thin handler that validates, calls service, returns response
5. **Entity tags**: Add `emitEntities()` calls for every mutation, update `ENTITIES.md`
6. **Client API**: Add API call in the appropriate feature
7. **Client query**: `useQuery` with `meta.entities` for real-time updates
8. **Client mutation**: `useMutation` with optimistic update if appropriate
9. **UI states**: Loading, empty, error, and success states for every screen
10. **Permissions**: Server-side auth checks + client-side conditional rendering
11. **Mobile**: Test on small screens
12. **Edge cases**: Empty data, concurrent users, network failure, permission denied

---

## 14. What NOT to Do

- Don't add `window.location.reload()` or `router.refresh()` to fix stale data — fix the real-time flow
- Don't add `setTimeout` or `setInterval` to poll for changes — use socket events
- Don't add `useEffect` that fetches data on a timer — use React Query with entity-tag invalidation
- Don't store server data in `useState` or Zustand — use React Query
- Don't add new bespoke socket events — use the entity-tag pattern
- Don't fix a bug in one place and leave the same bug in 5 other places
- Don't add a feature without error handling, loading states, and empty states
- Don't skip input validation because "the UI prevents invalid input" — validate server-side always
- Don't add dependencies without justification — check if existing deps already solve the problem
- Don't write 200-line components — split into smaller, focused components
- Don't use `any` to make TypeScript errors go away — fix the type
- Don't commit code that doesn't build
- Don't deploy on Friday nights
