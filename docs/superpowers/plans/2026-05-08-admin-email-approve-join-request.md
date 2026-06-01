# Admin email-approve / reject join request

**Date:** 2026-05-08
**Owner:** Ali (RSN)
**Status:** Plan, awaiting approval
**Estimated effort:** ~1 day end-to-end, 1 commit

## Goal

When a new join request is submitted, every admin (currently 3 super_admins) receives an email with **Approve** and **Reject** buttons. Clicking either button takes the admin to a one-click confirmation page; one more click finalises the decision. The applicant flow continues exactly as it does from the dashboard today (welcome email or decline email).

The admin should be able to act without opening the app.

## Non-goals

- In-email native action buttons (Gmail AMP / Outlook Actionable Messages). The provider-specific setup is not worth it for 3 admins.
- "Request more info" as a third button — out of scope for v1, easy to add later.
- Email reply parsing (brittle, ruled out).
- Rebuilding the existing dashboard review flow.

## Architecture (matches Dr Arch lens)

### Token shape (single source of truth — no new table)

Extend the existing `magic_links` table with two columns:

```
ALTER TABLE magic_links
  ADD COLUMN purpose       TEXT NOT NULL DEFAULT 'login',
  ADD COLUMN target_user_id UUID REFERENCES users(id)  ON DELETE CASCADE,  -- the admin
  ADD COLUMN target_id      UUID,                                          -- the join_request id
  ADD COLUMN action         TEXT;                                          -- 'approve' | 'reject' (NULL for login)

CREATE INDEX idx_magic_links_purpose
  ON magic_links(purpose, target_id) WHERE purpose <> 'login';
```

`purpose` defaults to `'login'` so every existing row keeps working. New rows for this feature use `purpose = 'join_request_review'`.

### Token lifecycle

1. New join request created → service queries every admin → for each admin, generate **two** tokens (one for `approve`, one for `reject`) tied to (admin_id, request_id, action). Store hashes in `magic_links`. 24-hour expiry.
2. Email sent to that admin's inbox with two URLs:
   - `https://app.rsn.network/admin/jr/{token_approve}`
   - `https://app.rsn.network/admin/jr/{token_reject}`
3. Admin clicks → React route `/admin/jr/:token` mounts → component fetches `GET /api/admin/join-request-action/{token}` (peek). Server hashes token, looks up the row, validates expiry + not-yet-used, returns the request summary + intended action.
4. Page renders: applicant name, email, reason, the action ("This will approve {Name}"), a single **Confirm** button, and a Cancel link to the dashboard.
5. Confirm click → `POST /api/admin/join-request-action/{token}/confirm`. Server hashes token, validates, marks used_at, calls the existing `reviewJoinRequest()` service with the bound (request_id, action, admin_id). Existing welcome / decline email fires.
6. Confirmation page: "Approved {Name}. They've been emailed a welcome link." or the decline equivalent.

### Why two-step (peek + confirm), not one-click GET

Outlook Safe Links and Gmail's preview crawlers prefetch GET URLs in emails. A single-click GET that mutates would be silently consumed before the human clicks. Peek is read-only, idempotent — safe to be prefetched. Confirm is POST and cannot be triggered by a crawler. This is the standard industry pattern (Stripe, Linear, etc.).

### Race conditions

Two admins click their respective links at the same time on the same request:
- Token rows are per-admin (so each has their own valid token).
- Both POST `/confirm` arrives at the server.
- The service uses `UPDATE join_requests SET status = $1, reviewed_by = $2 ... WHERE id = $3 AND status = 'pending' RETURNING *`. The `WHERE status = 'pending'` clause makes it a single atomic check-and-set: only the first transaction wins. The second one sees zero rows updated and gets a friendly "Already reviewed by {other admin name}" page.
- Both tokens get marked `used_at` regardless (so they can't be replayed).

### Architectural fit

- **Phase 4 (Redis / multi-instance) compatible:** tokens live in Postgres, no in-process state. Email send is fire-and-forget against Resend (already proven non-blocking).
- **No N+1:** admin list is one SELECT; token issuance is N inserts batched in a single transaction; email send is N parallel `Promise.allSettled` calls.
- **Rate limiting:** new limiter for `/admin/jr/*` endpoints (peek + confirm) — 30 requests/15 min/IP. Prevents brute-force token guessing.
- **Cleanup:** existing `magic_links` cleanup cron already trims expired rows.

## Phased delivery (one commit, multiple phases)

### Phase A — DB migration

`055_join_request_action_tokens.sql`:
- ALTER TABLE magic_links + new index (above)

### Phase B — Server service layer

`server/src/services/join-request/admin-action-tokens.service.ts` (new):
- `issueReviewTokens(requestId, adminUserIds): Promise<Map<adminUserId, { approveToken, rejectToken }>>`
  - Single transaction: insert 2N rows
  - 24h expiry
- `peekActionToken(rawToken): Promise<{ requestId, action, adminUserId, alreadyUsed, expired, snapshot }>`
- `confirmActionToken(rawToken): Promise<{ status: 'success'|'already_reviewed'|'expired'|'invalid', request, action, finalisedBy }>`
  - Wraps existing `reviewJoinRequest` so welcome/decline emails fire as before
  - Atomic UPDATE with `WHERE status = 'pending'` for race-safety

`server/src/services/email/email.service.ts` (extend):
- New template: `sendJoinRequestAdminReviewEmail(adminEmail, adminDisplayName, request, approveUrl, rejectUrl)`
  - Mobile-friendly HTML (table layout, inline styles, max-width 600px)
  - Two prominent buttons; large tap targets (44 px+ height)
  - Fallback plain-text version

`server/src/services/join-request/join-request.service.ts` (extend `createJoinRequest`):
- After the existing in-app notification fan-out, also call the new `issueReviewTokens` + `sendJoinRequestAdminReviewEmail` for each admin
- Fire-and-forget (non-blocking, like the existing welcome email pattern)

### Phase C — Server routes

`server/src/routes/admin-actions.ts` (new file, mounted at `/api/admin/join-request-action`):
- `GET /:token` — peek; rate-limited; returns request snapshot
- `POST /:token/confirm` — finalises; rate-limited; returns result

Mounted in `server/src/index.ts` alongside existing route imports.

### Phase D — Client route + page

- New route in `client/src/App.tsx`: `/admin/jr/:token` → new component `<AdminJoinRequestActionPage />`
- New file `client/src/features/admin/AdminJoinRequestActionPage.tsx`:
  - On mount: `GET /admin/join-request-action/:token`
  - Renders 4 states: loading / ready (with Confirm button) / already_processed / expired_or_invalid
  - Confirm click → POST; show success / failure
  - Mobile-responsive (360 / 414 / 768 / 1024 verified per RajaSkill rule)
- Page is publicly reachable (no auth gate) — the token IS the auth

## Testing (TDD red→green)

### Architectural pins (`server/src/__tests__/routes/admin-action-tokens.test.ts`)

- New service file exists with the three exported methods
- magic_links migration adds the 4 columns + new index
- Email template function exported with the canonical signature
- Two new routes wired in `routes/admin-actions.ts` and mounted in index.ts
- Rate-limiter applied to both routes

### Behavioural pins (`server/src/__tests__/services/join-request/admin-action-tokens.behaviour.test.ts`)

(integration-style with a stubbed pg client + email service):
- `issueReviewTokens` writes 2N rows for N admins; tokens hash differently
- `peekActionToken` rejects expired tokens (no state change)
- `peekActionToken` returns the right snapshot for valid tokens
- `confirmActionToken` flips the request status atomically
- **Race:** two simultaneous `confirmActionToken` calls on the same request — only one succeeds, the other sees `already_reviewed`
- Token replay: a used token returns `already_reviewed`
- Wrong-action token (admin clicks Approve link after another admin already approved) returns the right messaging

## Security review (Phase 2.1 mandatory gate)

- ✅ Token entropy: `crypto.randomBytes(32)` (256 bits) — same as login magic links
- ✅ Token storage hashed (SHA-256) — never plaintext at rest
- ✅ Token bound to (admin_id, request_id, action) — can't be reused across admins or requests
- ✅ Single-use (`used_at` set on confirm)
- ✅ Expiry 24h
- ✅ Two-step (peek GET + confirm POST) — Outlook/Gmail prefetch can't fire the action
- ✅ Rate-limited
- ✅ No PII logged in tokens; logs use `requestId`/`adminId` only
- ✅ Confirmation page reveals applicant info ONLY after token is validated (so prefetchers see nothing)
- ✅ HTTPS-only (existing app config)
- ✅ Token URLs do not appear in browser referrer headers leaving the page (we'll add `<meta name="referrer" content="no-referrer">` on the action page just in case)

## UI/UX review (Phase 2.1 mandatory gate)

Email:
- Plain-text fallback (Resend supports `text` field)
- Single-column 600px-wide table layout (renders the same on Gmail / Outlook / Apple Mail / Android Gmail / iOS Mail)
- Two buttons stacked on mobile, side-by-side on desktop
- 44 px+ tap targets per the new RajaSkill mobile rule
- Clear sender, clear subject ("New RSN join request from {name}")

Action page:
- Loading state (skeleton)
- Ready state with applicant name, email, reason, the action label, Confirm + Cancel
- Already-processed state (with the other admin's name + decision)
- Expired/invalid state with "Open dashboard" link
- Success state with a brief explanation of what happens next
- Mobile-responsive at 360 / 414 / 768 / 1024 px

## Rollback

- `git revert` the single commit
- Migration is additive (added columns, added index, all nullable / defaulted) — does not require down-migration
- New routes 404 after revert; existing dashboard review flow unaffected
- In-flight tokens become orphaned but harmless (the action endpoints no longer exist; tokens expire naturally in 24h)

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Email scanners prefetch & consume tokens | Two-step (peek GET + confirm POST) |
| Two admins approve simultaneously | Atomic `WHERE status = 'pending'` clause |
| Email lands in spam | Resend already authenticated for `rsn.network`; reuse the same `from` / sender setup proven for login emails |
| Token leaked (forwarded email) | 24h expiry; single-use; bound to specific admin |
| Render restart drops in-flight emails | Resend retries; if a send fails, the in-app notification + dashboard fallback still work — it's an enhancement, not the only path |
| Spam attacker submits 1000 join requests | Existing public POST rate-limit on `/join-requests` (Phase 0 audit confirmed) |

## What this does NOT change

- Existing dashboard review flow stays exactly as it is
- Existing welcome/decline emails (sent after review) untouched
- In-app notifications still fire on join request creation
- Existing magic-link login flow untouched (the `purpose` column defaults to `'login'`)

## Open questions before I start

1. **Acceptable expiry?** Plan: 24h. Acceptable, or longer (3 days) since admins might not check email for a day?
2. **Should super-admins get the email and only-admins not, or both?** Plan: anyone with role IN (admin, super_admin) gets it (matches the existing in-app notification fan-out).
3. **Confirmation page tone?** Plan: short, factual, no marketing copy. Sample: "Approve **Stefan Smith** to join RSN? They'll get a welcome email immediately."

If you say "go" with no other changes, I'll proceed with the defaults above and ship under RajaSkill discipline.
