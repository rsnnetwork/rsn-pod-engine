// Source-pins for the June-9 client fixes that have no pure-logic seam.
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const clientSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8');

describe('June 9 client fixes', () => {
  // 26 Oct 2026 (C9): the event and pod pages invite through one sheet (features/invites/InvitePickerSheet.tsx), and
  // the pending invites, with Remind and Withdraw, are listed by InviteStatusList.tsx. These pins moved with the code.
  it('#1 — invite search inputs render readable dark text (not white-on-white)', () => {
    const picker = clientSrc('features/invites/InvitePickerSheet.tsx');
    const inv = clientSrc('features/invites/InvitesPage.tsx');
    // The picker's search (both pages) and the Invites page's own search carry an explicit dark text colour.
    expect(picker).toMatch(/text-reason-ink[\s\S]{0,400}placeholder=\{SEARCH_PLACEHOLDER\}|placeholder=\{SEARCH_PLACEHOLDER\}[\s\S]{0,400}text-reason-ink/);
    expect(inv).toMatch(/Search by name or email[\s\S]{0,160}text-gray-900/);
  });

  it('#5 — a shareable session invite link is capped at the event capacity, not 10', () => {
    const sdp = clientSrc('features/sessions/SessionDetailPage.tsx');
    const picker = clientSrc('features/invites/InvitePickerSheet.tsx');
    const logic = clientSrc('features/invites/invite-picker.ts');
    // The event page hands the sheet its capacity; the sheet sends it as the link's maxUses (500 when unset).
    expect(sdp).toMatch(/linkCap=\{session\.config\?\.maxParticipants\}/);
    expect(picker).toMatch(/const cap = linkCap\(/);
    expect(logic).toMatch(/maxUses: cap/);
    expect(logic).toMatch(/LINK_CAP_DEFAULT = 500/);
    expect(sdp + picker + logic).not.toMatch(/maxUses: (body\.inviteeEmail \? 1 : )?10\b/);
  });

  it('#6 — the event page can revoke a pending invite (DELETE /invites/:id)', () => {
    const sdp = clientSrc('features/sessions/SessionDetailPage.tsx');
    const list = clientSrc('features/invites/InviteStatusList.tsx');
    expect(sdp).toMatch(/<InviteStatusList\b/);
    expect(list).toMatch(/revokeInviteMutation/);
    expect(list).toMatch(/api\.delete\(`\/invites\/\$\{inviteId\}`\)/);
  });

  it('#4 — co-host promote/demote updates the host view optimistically', () => {
    const hcc = clientSrc('features/live/HostControlCenter.tsx');
    expect(hcc).toMatch(/useSessionStore\.getState\(\)\.addCohost\(userId\)/);
    expect(hcc).toMatch(/useSessionStore\.getState\(\)\.removeCohost\(userId\)/);
  });
});
