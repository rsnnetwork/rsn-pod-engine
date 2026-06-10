// #4B (June-10 debrief) — a kicked (removed) participant can return ONLY via a
// fresh PERSONAL invite from the host, and the kick revokes their old personal
// invite so the stale link is dead. Source-pinned so the wiring can't regress.
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const read = (rel: string) => nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');

describe('#4B — kicked user re-admitted only by a fresh personal invite', () => {
  const sessionSvc = read('services/session/session.service.ts');
  const inviteSvc = read('services/invite/invite.service.ts');
  const hostActions = read('services/orchestration/handlers/host-actions.ts');

  it('registerParticipant takes an allowRemovedReadmit option and gates the REMOVED bar on it', () => {
    expect(sessionSvc).toMatch(/allowRemovedReadmit\?\s*:\s*boolean/);
    // The removed bar must only throw when re-admit is NOT allowed.
    expect(sessionSvc).toMatch(/existingStatus === 'removed'\s*&&\s*!options\?\.allowRemovedReadmit/);
    expect(sessionSvc).toMatch(/REMOVED_FROM_EVENT/);
  });

  it('invite-accept lifts the bar ONLY for a personal (targeted-email) invite, never a shared link', () => {
    expect(inviteSvc).toMatch(/allowRemovedReadmit\s*=\s*!!invite\.inviteeEmail/);
    expect(inviteSvc).toMatch(/registerParticipant\([^)]*\{\s*allowRemovedReadmit\s*\}/s);
  });

  it('the kick revokes the kicked user\'s personal session invites so old links die', () => {
    const start = hostActions.indexOf('export async function handleHostRemoveParticipant(');
    const fn = hostActions.slice(start, hostActions.indexOf('\nexport ', start + 1));
    expect(fn).toMatch(/UPDATE invites SET status = 'revoked'/);
    expect(fn).toMatch(/invitee_email = lower\(\(SELECT email FROM users WHERE id = \$2\)\)/);
    expect(fn).toMatch(/status IN \('pending', 'accepted'\)/);
  });
});
