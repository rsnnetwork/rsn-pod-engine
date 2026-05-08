// Phase 4 (1 May 2026 spec) — Invite flow: server-confirmed registration
//
// Stefan reported: "Accept → 404 → magically works". Root cause: post-Phase-T0-4
// the server transaction commits cleanly, but the client navigated before
// React Query caches refetched, so the live page rendered against a stale
// "you're not in this session" cache and the user saw 404 until they clicked
// again. Phase 4 fix: server returns participantStatus in the accept response;
// client awaits the critical refetches before navigating.

import * as fs from 'fs';
import * as path from 'path';

function readServer(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');
}

function readRepo(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../../../', rel), 'utf8');
}

describe('Phase 4 — invite flow registered ack', () => {
  describe('server invite.service.ts returns participantStatus', () => {
    const src = readServer('services/invite/invite.service.ts');

    it('AcceptInviteResult declares optional participantStatus', () => {
      const ifaceStart = src.indexOf('export interface AcceptInviteResult');
      // Walk to the closing brace at column 0 (full interface end).
      const ifaceEnd = src.indexOf('\n}', ifaceStart);
      const iface = src.slice(ifaceStart, ifaceEnd);
      expect(iface).toMatch(/participantStatus\?\s*:\s*string/);
    });

    it('happy-path acceptInvite reads back session_participants.status', () => {
      // Last return in acceptInvite should populate participantStatus.
      const acceptIdx = src.indexOf('export async function acceptInvite');
      const slice = src.slice(acceptIdx);
      expect(slice).toMatch(/SELECT status FROM session_participants/);
      expect(slice).toMatch(/participantStatus,?\s*\n\s*\}/);
    });

    it('idempotent re-acceptance also returns participantStatus', () => {
      // Phase 8A.1 (8 May spec) — search a wider slice; the variable
      // name lives ~3kb after the first isIdempotent reference.
      const idempIdx = src.indexOf('isIdempotent');
      const slice = src.slice(idempIdx, idempIdx + 5000);
      expect(slice).toMatch(/participantStatusIdempotent/);
    });
  });

  describe('client InviteAcceptPage awaits refetch before navigating', () => {
    const src = readRepo('client/src/features/invites/InviteAcceptPage.tsx');

    it('awaits Promise.all of refetchQueries on session and session-participants', () => {
      expect(src).toMatch(/await Promise\.all\(\[[\s\S]*?qc\.refetchQueries\([\s\S]*?session-participants[\s\S]*?qc\.refetchQueries\([\s\S]*?session/);
    });

    it('trusts the 200 response — no false-negative throw on missing pStatus (Phase 8A.1, Stefan #1)', () => {
      // Phase 8A.1 (8 May spec) — pre-fix the client threw a custom
      // Error whenever the server's idempotent path returned no
      // participantStatus, which surfaced as the false-negative
      // "Failed to accept invite" toast even though the user WAS
      // registered. Trust the 200 now; server defaults the field
      // to 'registered' on the idempotent path.
      expect(src).not.toMatch(/if \(sid && !pStatus\)\s*\{\s*throw new Error/);
    });

    it('still uses navigate (SPA transition, not window.location.href)', () => {
      expect(src).toMatch(/navigate\(destination, \{ replace: true \}\)/);
    });
  });
});
