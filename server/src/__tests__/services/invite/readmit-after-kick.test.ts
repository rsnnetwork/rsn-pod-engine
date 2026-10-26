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

  it('registerParticipant takes when the personal invite was made, and gates the REMOVED bar on a removal before it', () => {
    // H1b fix round 1 — "fresh" is exact: the invite's time, not a boolean.
    expect(sessionSvc).toMatch(/personalInviteCreatedAt\?\s*:\s*Date/);
    // The removed bar throws unless this invite lifts the removal (made after it).
    expect(sessionSvc).toMatch(/readmits = existing\.rows\[0\]\?\.status === 'removed' && liftedByPersonalInvite\(existing\.rows\[0\]\.left_at, invitedAt\)/);
    expect(sessionSvc).toMatch(/existingStatus === 'removed'\s*&&\s*!readmits/);
    expect(sessionSvc).toMatch(/REMOVED_FROM_EVENT/);
  });

  it('invite-accept lifts the bar ONLY for a personal (targeted-email) invite, never a shared link', () => {
    expect(inviteSvc).toMatch(/personalInviteCreatedAt = invite\.inviteeEmail \? new Date\(invite\.createdAt\) : undefined/);
    expect(inviteSvc).toMatch(/registerParticipant\([^)]*\{\s*personalInviteCreatedAt\s*\}/s);
  });

  it('the accept\'s own insert lifts a removed row only when its removal was made before the personal invite', () => {
    // H1b fix round 1 — the unit tests' fake databases evaluate this rule themselves, so the SQL carries it here too:
    // a kick made after the invite (left_at >= $3) is left as it is by the insert's DO UPDATE.
    expect(inviteSvc).toMatch(
      /DO UPDATE SET status = 'registered', left_at = NULL\s+WHERE session_participants\.status = 'removed'\s+AND \(session_participants\.left_at IS NULL OR session_participants\.left_at < \$3::timestamptz\)/,
    );
    expect(inviteSvc).toMatch(/personalInviteCreatedAt \? \[invite\.sessionId, userId, personalInviteCreatedAt\] : \[invite\.sessionId, userId\]/);
  });

  it('the host can create a fresh invite for a kicked user (removed/left not counted as an active participant)', () => {
    expect(inviteSvc).toMatch(/JOIN session_participants sp[\s\S]{0,160}sp\.status NOT IN \('removed', 'left'\)/);
  });

  it('the kick revokes the kicked user\'s personal session invites so old links die', () => {
    const start = hostActions.indexOf('export async function handleHostRemoveParticipant(');
    const fn = hostActions.slice(start, hostActions.indexOf('\nexport ', start + 1));
    expect(fn).toMatch(/UPDATE invites SET status = 'revoked'/);
    expect(fn).toMatch(/invitee_email = lower\(\(SELECT email FROM users WHERE id = \$2\)\)/);
    expect(fn).toMatch(/status IN \('pending', 'accepted'\)/);
  });
});
