// T1-1 — Email identity-match guard on invite acceptance (Issue 1)
//
// Multi-device scenario: user A logged in on their phone clicks an invite
// addressed to user B from a desktop. Pre-fix: A consumed B's invite
// (recovery code wrongly assumed multi-device collision). Post-fix: server
// rejects with IDENTITY_MISMATCH and a clear message naming both emails.
//
// Optional userEmail parameter so:
//  - legacy callers without an email still work (no guard runs)
//  - public/code-only invites without invitee_email pass through unaffected
//  - typed invites with both invitee_email AND user email enforce the match

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../services/invite/invite.service.ts'),
    'utf8',
  );
}

describe('T1-1 — invite identity-match guard', () => {
  const src = readSource();

  describe('acceptInvite signature accepts userEmail', () => {
    it('takes (code, userId, userEmail?) — optional for back-compat', () => {
      expect(src).toMatch(/export async function acceptInvite\(\s*code:\s*string,\s*userId:\s*string,\s*userEmail\?:\s*string,?\s*\)/);
    });
  });

  describe('guard logic', () => {
    const fnStart = src.indexOf('export async function acceptInvite');
    const fnEnd = src.indexOf('\n}\n', fnStart);
    const fn = src.slice(fnStart, fnEnd);

    it('only runs when BOTH invite.inviteeEmail AND userEmail are set', () => {
      // Both must be truthy to enter the check
      expect(fn).toMatch(/if\s*\(\s*invite\.inviteeEmail\s*&&\s*userEmail\s*\)/);
    });

    it('compares case-insensitive (toLowerCase + trim)', () => {
      expect(fn).toMatch(/invite\.inviteeEmail\.trim\(\)\.toLowerCase\(\)/);
      expect(fn).toMatch(/userEmail\.trim\(\)\.toLowerCase\(\)/);
    });

    it('throws IDENTITY_MISMATCH with both emails in the message, the invited one masked', () => {
      expect(fn).toMatch(/IDENTITY_MISMATCH/);
      expect(fn).toMatch(/invite\.inviteeEmail/);
      expect(fn).toMatch(/identityMismatchMessage\(invite\.inviteeEmail, userEmail\)/);
      // The message names both addresses so the user knows what to do. The invited one is masked (26 Oct 2026, fix
      // round 2): whole, it gave the address to anybody signed in who held the code. The wording is run in
      // invite.service.test.ts; this pins where it comes from.
      const helperStart = src.indexOf('function identityMismatchMessage');
      const helper = src.slice(helperStart, src.indexOf('\n}', helperStart));
      expect(helper).toMatch(/sent to \$\{maskEmail\(inviteeEmail\)\}/);
      expect(helper).toMatch(/you're logged in as \$\{userEmail\}/);
    });

    it('throws BEFORE the use-count idempotent path so a different account cannot trigger re-acceptance', () => {
      const guardIdx = fn.indexOf("'IDENTITY_MISMATCH'");
      const useCountIdx = fn.indexOf('invite.useCount >= invite.maxUses');
      expect(guardIdx).toBeGreaterThan(-1);
      expect(useCountIdx).toBeGreaterThan(-1);
      expect(guardIdx).toBeLessThan(useCountIdx);
    });

    it('uses HTTP 403 (Forbidden) — not 400 — to signal auth-context mismatch', () => {
      expect(fn).toMatch(/throw new AppError\(\s*403,\s*['"]IDENTITY_MISMATCH['"]/);
    });
  });

  describe('route passes req.user.email to acceptInvite', () => {
    const routeSrc = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../routes/invites.ts'),
      'utf8',
    );

    it('the /accept handler forwards req.user.email as the third arg', () => {
      const handlerStart = routeSrc.indexOf("'/:code/accept'");
      const handlerEnd = routeSrc.indexOf("router.post(\n  '/:code/mark-accepted'", handlerStart);
      const handler = routeSrc.slice(handlerStart, handlerEnd);
      expect(handler).toMatch(/inviteService\.acceptInvite\(\s*req\.params\.code,\s*req\.user!\.userId,\s*req\.user!\.email/);
    });
  });
});
