// T0-4 — atomic invite acceptance (Issue 2)
//
// Pre-fix: invite UPDATE committed inside the transaction, then service
// calls (podService.addMember, sessionService.registerParticipant) ran
// against the GLOBAL POOL outside the transaction. If they failed after
// the invite UPDATE, invite was permanently flagged accepted but the user
// was never registered. Next attempt: INVITE_ALREADY_USED, recovery code
// assumed they were a member (they weren't).
//
// Post-fix:
//   1. SELECT FOR UPDATE invite + run validations
//   2. Apply registration (idempotent ON CONFLICT)  ← FAILS first if anything wrong
//   3. UPDATE invite as accepted (single statement, can't realistically fail
//      while client holds the row lock)
//   4. Return { invite, redirectTo, registeredFor }
//
// If step 2 throws → invite UPDATE never runs → next attempt re-validates
// and retries cleanly. Self-healing.
//
// Server returns explicit `redirectTo` so the client navigates definitively
// without guessing.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../services/invite/invite.service.ts'),
    'utf8',
  );
}

describe('T0-4 — atomic invite acceptance', () => {
  const src = readSource();

  describe('AcceptInviteResult contract', () => {
    it('exports AcceptInviteResult with invite + redirectTo + registeredFor', () => {
      expect(src).toMatch(/export interface AcceptInviteResult\s*\{[\s\S]+?invite:\s*Invite[\s\S]+?redirectTo:\s*string[\s\S]+?registeredFor:/);
    });

    it('acceptInvite returns Promise<AcceptInviteResult>', () => {
      expect(src).toMatch(/export async function acceptInvite\([\s\S]+?\):\s*Promise<AcceptInviteResult>/);
    });
  });

  describe('execution order — registration BEFORE invite UPDATE', () => {
    const fnStart = src.indexOf('export async function acceptInvite');
    const fnEnd = src.indexOf('\n}\n', fnStart);
    const fn = src.slice(fnStart, fnEnd);

    it('calls applyInviteRegistration before the UPDATE invites SET use_count statement', () => {
      const registrationIdx = fn.indexOf('applyInviteRegistration(invite, userId)');
      const updateIdx = fn.indexOf('UPDATE invites SET use_count');
      expect(registrationIdx).toBeGreaterThan(-1);
      expect(updateIdx).toBeGreaterThan(-1);
      expect(registrationIdx).toBeLessThan(updateIdx);
    });

    it('returns the result of computeRedirectTo on success', () => {
      expect(fn).toMatch(/redirectTo:\s*computeRedirectTo\(invite,\s*registered\)/);
    });
  });

  describe('idempotent re-acceptance (same user, useCount maxed)', () => {
    it('detects acceptedByUserId === userId and re-applies registration', () => {
      const fnStart = src.indexOf('export async function acceptInvite');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/invite\.acceptedByUserId\s*===\s*userId/);
      expect(fn).toMatch(/applyInviteRegistration\(invite,\s*userId\)/);
    });

    it('returns AcceptInviteResult shape from idempotent path too (with redirectTo)', () => {
      const fnStart = src.indexOf('export async function acceptInvite');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // Post-2026-04-28 restructure: idempotent log + return live in Phase C
      // (after Phase A's INVITE_ALREADY_USED throw). Anchor on the
      // re-acceptance log line and look at the next return-block.
      const reAcceptIdx = fn.indexOf('Invite re-acceptance');
      expect(reAcceptIdx).toBeGreaterThan(-1);
      const idempotentReturnIdx = fn.indexOf('return {', reAcceptIdx);
      expect(idempotentReturnIdx).toBeGreaterThan(-1);
      const idempotentBlock = fn.slice(reAcceptIdx, idempotentReturnIdx + 250);
      expect(idempotentBlock).toMatch(/redirectTo:\s*computeRedirectTo/);
    });
  });

  // ── Post-2026-04-28 restructure pins ──
  // The original acceptInvite wrapped the entire flow (validation,
  // applyInviteRegistration, final UPDATE) in `transaction()`. Under
  // concurrent accepts, the outer connection sat idle past Neon's
  // idle-in-transaction timeout while nested service transactions
  // serialized on a shared pod-row lock — Postgres killed the connection,
  // requests 500'd after a ~22-second hang, users saw "click does
  // nothing." These tests pin the four-phase split that fixes it.
  describe('Phase A — short transaction (lock released before slow work)', () => {
    const fnStart = src.indexOf('export async function acceptInvite');
    const fnEnd = src.indexOf('\n}\n', fnStart);
    const fn = src.slice(fnStart, fnEnd);

    it('the only transaction wrapper is for Phase A — short, validation-only', () => {
      const txOpens = (fn.match(/await transaction\(async \(client\)/g) || []).length;
      expect(txOpens).toBe(1);
    });

    it('Phase A transaction body does NOT call applyInviteRegistration', () => {
      const txStart = fn.indexOf('await transaction(async (client)');
      expect(txStart).toBeGreaterThan(-1);
      const phaseAEndMarker = fn.indexOf('Phase A committed', txStart);
      expect(phaseAEndMarker).toBeGreaterThan(txStart);
      const phaseABody = fn.slice(txStart, phaseAEndMarker);
      expect(phaseABody).not.toMatch(/applyInviteRegistration\(/);
    });

    it('applyInviteRegistration is invoked AFTER the transaction wrapper closes', () => {
      const phaseAEndMarker = fn.indexOf('Phase A committed');
      const applyIdx = fn.indexOf('applyInviteRegistration(invite, userId)');
      expect(phaseAEndMarker).toBeGreaterThan(-1);
      expect(applyIdx).toBeGreaterThan(phaseAEndMarker);
    });
  });

  describe('Phase C — atomic UPDATE with race-safe WHERE clause', () => {
    it('Phase C UPDATE includes use_count < max_uses race guard', () => {
      expect(src).toMatch(/UPDATE invites[\s\S]+?WHERE[\s\S]+?use_count\s*<\s*max_uses/);
    });

    it('Phase C UPDATE excludes revoked + expired statuses', () => {
      expect(src).toMatch(/status NOT IN[\s\S]+?revoked[\s\S]+?expired/);
    });

    it('handles 0-row UPDATE result (concurrent caller bumped use_count past max)', () => {
      const fnStart = src.indexOf('export async function acceptInvite');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/updateResult\.rowCount\s*===\s*0/);
    });

    it('Phase C runs against the pool, not the Phase A transaction client', () => {
      const fnStart = src.indexOf('export async function acceptInvite');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      const phaseAEndMarker = fn.indexOf('Phase A committed');
      const after = fn.slice(phaseAEndMarker);
      // Should be a top-level `await query(...)`, not `await client.query(...)`
      expect(after).toMatch(/await query<Invite>\(\s*\n?\s*`UPDATE invites/);
    });
  });

  describe('NotificationBell does not double-fire register on success', () => {
    const bellSrc = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../client/src/components/ui/NotificationBell.tsx'),
      'utf8',
    );

    it('handleAcceptInvite success path does not POST to /sessions/:id/register', () => {
      // The success-path register call was the source of the
      // 2026-04-28 incident: it raced with the server's nested
      // sessionService.registerParticipant. The server now handles
      // registration in Phase B; the client must not duplicate.
      const handlerStart = bellSrc.indexOf('const tryAcceptAndRegister');
      const handlerEnd = bellSrc.indexOf('catch (err: any)', handlerStart);
      expect(handlerStart).toBeGreaterThan(-1);
      expect(handlerEnd).toBeGreaterThan(handlerStart);
      const successPath = bellSrc.slice(handlerStart, handlerEnd);
      expect(successPath).not.toMatch(/api\.post\(`\/sessions\/\$\{[^}]+\}\/register`\)/);
    });

    it('error fallback for SESSION_ALREADY_REGISTERED still POSTs register (intentional)', () => {
      // The error-fallback register IS still allowed because the server
      // told us we're in a state where we don't need to redo work; this
      // path just normalizes membership for the navigation that follows.
      const fallbackStart = bellSrc.indexOf("errCode === 'SESSION_ALREADY_REGISTERED'");
      expect(fallbackStart).toBeGreaterThan(-1);
      const fallbackBlock = bellSrc.slice(fallbackStart, fallbackStart + 400);
      expect(fallbackBlock).toMatch(/api\.post\(`\/sessions\/\$\{[^}]+\}\/register`\)/);
    });
  });

  describe('redirectTo computation', () => {
    // The route is `/session/:sessionId/live` (SINGULAR) — see client/src/App.tsx.
    // Plural `/sessions/...` is the registration-list namespace and falls into
    // the SPA NotFoundPage. Pre-fix this test pinned the broken plural URL,
    // which is why every "fix" of the email-invite 404 regressed.
    // #1 (June-10 debrief) — a session invite lands on the event DETAILS page
    // (`/sessions/:sessionId`), not straight into the live room, so the user sees
    // event info + an explicit "Enter Event" button and camera/mic are only
    // acquired after they click through to the live page.
    it('session invites land on the event details page /sessions/:id (not the live room)', () => {
      expect(src).toMatch(/return\s*`\/sessions\/\$\{registered\.sessionId\}`/);
      expect(src).not.toMatch(/return\s*`\/session\/\$\{registered\.sessionId\}\/live`/);
    });

    it('pod invites land on /pods/:id', () => {
      expect(src).toMatch(/return\s*`\/pods\/\$\{registered\.podId\}`/);
    });

    it('fallback to /dashboard for malformed invites (no podId or sessionId)', () => {
      expect(src).toMatch(/return\s*['"]\/dashboard['"]/);
    });

    // Invariant guard — pin the URL produced by computeRedirectTo against the
    // actual <Route> registered in App.tsx so the two cannot drift again.
    it('redirectTo URL pattern matches a route registered in client App.tsx', () => {
      const appSrc = nodeFs.readFileSync(
        nodePath.join(__dirname, '../../../../../client/src/App.tsx'),
        'utf8',
      );
      // The event-details route the invite now lands on (#1).
      expect(appSrc).toMatch(/<Route\s+path="\/sessions\/:sessionId"\s+element=\{<SessionDetailPage/);
      // The live-session route the "Enter Event" button leads to.
      expect(appSrc).toMatch(/<Route\s+path="\/session\/:sessionId\/live"/);
    });
  });

  describe('applyInviteRegistration helper', () => {
    it('exists as a separate function', () => {
      expect(src).toMatch(/async function applyInviteRegistration\([\s\S]+?invite:\s*Invite,\s*userId:\s*string,?/);
    });

    it('handles ConflictError as already-member (no-op for that step)', () => {
      const helperStart = src.indexOf('async function applyInviteRegistration');
      const helperEnd = src.indexOf('\n}\n', helperStart);
      const helper = src.slice(helperStart, helperEnd);
      // Both pod and session paths swallow ConflictError
      const conflictHandlers = (helper.match(/if\s*\(!?\(?err instanceof ConflictError\)/g) || []).length;
      expect(conflictHandlers).toBeGreaterThanOrEqual(2);
    });

    it('rethrows non-ConflictError so the transaction rolls back', () => {
      const helperStart = src.indexOf('async function applyInviteRegistration');
      const helperEnd = src.indexOf('\n}\n', helperStart);
      const helper = src.slice(helperStart, helperEnd);
      // Either explicit throw err or no swallow — ConflictError is the ONLY swallowed case
      expect(helper).toMatch(/throw err/);
    });
  });

  describe('routes/invites.ts surfaces redirectTo + registeredFor', () => {
    const routeSrc = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../routes/invites.ts'),
      'utf8',
    );

    it('passes result.redirectTo and result.registeredFor in the response', () => {
      const handlerStart = routeSrc.indexOf("'/:code/accept'");
      const handlerEnd = routeSrc.indexOf("router.post(\n  '/:code/mark-accepted'", handlerStart);
      const handler = routeSrc.slice(handlerStart, handlerEnd);
      expect(handler).toMatch(/redirectTo:\s*result\.redirectTo/);
      expect(handler).toMatch(/registeredFor:\s*result\.registeredFor/);
    });
  });

  describe('client InviteAcceptPage uses server-provided redirectTo', () => {
    const clientSrc = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../client/src/features/invites/InviteAcceptPage.tsx'),
      'utf8',
    );

    it('reads redirectTo from server response (not guessed client-side)', () => {
      expect(clientSrc).toMatch(/data\?\.redirectTo\s*\|\|\s*fallbackDestination\(\)/);
    });

    it('drops the old recovery chain (mark-accepted + manual register fallback)', () => {
      // The pre-T0-4 recovery code called mark-accepted if accept failed.
      // Post-T0-4: server is source of truth, no recovery chain needed.
      // This test pins that the failure-recovery loop is gone.
      const acceptFnStart = clientSrc.indexOf('const accept = useCallback');
      const acceptFnEnd = clientSrc.indexOf('  // Pre-emptive check', acceptFnStart);
      const acceptFn = clientSrc.slice(acceptFnStart, acceptFnEnd);
      expect(acceptFn).not.toMatch(/api\.post\(`\/invites\/\$\{code\}\/mark-accepted`\)/);
    });

    // Stefan/Shraddha 10 May 2026 — when the server returned POD_MEMBER_EXISTS
    // (or SESSION_ALREADY_REGISTERED) for an already-registered user, the
    // catch block set the toast text to "You're already a member — navigating
    // to the event" but never actually navigated. The user got stuck on a
    // "Try Again" button that retried the same idempotent op and saw the
    // same misleading toast forever. This test pins the fix: those error
    // codes are now treated as success and trigger navigation.
    it('catch block treats POD_MEMBER_EXISTS / SESSION_ALREADY_REGISTERED / INVITE_ALREADY_USED as success (navigates to lobby)', () => {
      const acceptFnStart = clientSrc.indexOf('const accept = useCallback');
      const acceptFnEnd = clientSrc.indexOf('  // Pre-emptive check', acceptFnStart);
      const acceptFn = clientSrc.slice(acceptFnStart, acceptFnEnd);
      // The catch block must contain a code-equality check for all three codes
      expect(acceptFn).toMatch(/errCode\s*===\s*['"]POD_MEMBER_EXISTS['"]/);
      expect(acceptFn).toMatch(/errCode\s*===\s*['"]SESSION_ALREADY_REGISTERED['"]/);
      expect(acceptFn).toMatch(/errCode\s*===\s*['"]INVITE_ALREADY_USED['"]/);
      // And inside that branch it must navigate via fallbackDestination
      const branchStart = acceptFn.indexOf("errCode === 'POD_MEMBER_EXISTS'");
      const branchEnd = acceptFn.indexOf('// EVENT_ENDED', branchStart);
      expect(branchEnd).toBeGreaterThan(branchStart);
      const branch = acceptFn.slice(branchStart, branchEnd);
      expect(branch).toMatch(/navigate\(fallbackDestination\(\)/);
      expect(branch).toMatch(/return;/);
    });
  });
});
