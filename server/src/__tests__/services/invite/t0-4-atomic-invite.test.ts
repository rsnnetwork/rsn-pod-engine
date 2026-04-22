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
      const idempotentBlock = fn.slice(fn.indexOf('Invite re-acceptance'), fn.indexOf('throw new AppError(400, \'INVITE_ALREADY_USED\''));
      expect(idempotentBlock).toMatch(/redirectTo:\s*computeRedirectTo/);
    });
  });

  describe('redirectTo computation', () => {
    it('session invites land on /sessions/:id/live', () => {
      expect(src).toMatch(/return\s*`\/sessions\/\$\{registered\.sessionId\}\/live`/);
    });

    it('pod invites land on /pods/:id', () => {
      expect(src).toMatch(/return\s*`\/pods\/\$\{registered\.podId\}`/);
    });

    it('fallback to /dashboard for malformed invites (no podId or sessionId)', () => {
      expect(src).toMatch(/return\s*['"]\/dashboard['"]/);
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
  });
});
