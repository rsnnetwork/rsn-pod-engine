// Source-pins for the June-9 client fixes that have no pure-logic seam.
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const clientSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8');

describe('June 9 client fixes', () => {
  it('#1 — invite search inputs render readable dark text (not white-on-white)', () => {
    const sdp = clientSrc('features/sessions/SessionDetailPage.tsx');
    const inv = clientSrc('features/invites/InvitesPage.tsx');
    // both "Search by name or email" inputs now carry an explicit dark text color
    expect(sdp).toMatch(/Search by name or email[\s\S]{0,160}text-gray-900/);
    expect(inv).toMatch(/Search by name or email[\s\S]{0,160}text-gray-900/);
  });

  it('#5 — a shareable session invite link is capped at the event capacity, not 10', () => {
    const sdp = clientSrc('features/sessions/SessionDetailPage.tsx');
    expect(sdp).toMatch(/maxUses: body\.inviteeEmail \? 1 : \(session\?\.config\?\.maxParticipants \?\? 500\)/);
    expect(sdp).not.toMatch(/maxUses: body\.inviteeEmail \? 1 : 10/);
  });

  it('#6 — the event page can revoke a pending invite (DELETE /invites/:id)', () => {
    const sdp = clientSrc('features/sessions/SessionDetailPage.tsx');
    expect(sdp).toMatch(/revokeInviteMutation/);
    expect(sdp).toMatch(/api\.delete\(`\/invites\/\$\{inviteId\}`\)/);
  });

  it('#4 — co-host promote/demote updates the host view optimistically', () => {
    const hcc = clientSrc('features/live/HostControlCenter.tsx');
    expect(hcc).toMatch(/useSessionStore\.getState\(\)\.addCohost\(userId\)/);
    expect(hcc).toMatch(/useSessionStore\.getState\(\)\.removeCohost\(userId\)/);
  });
});
