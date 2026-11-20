// 21 Nov 2026 (Ben Hotaling): a link pasted into Luma must keep working until the event, not for 7 days.
import { InviteType } from '@rsn/shared';
import { inviteExpiresAt } from '../../../services/invite/invite-expiry';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const WEEK = 168;

describe('inviteExpiresAt', () => {
  it('gives an event link no timer, even when an old client asks for a week', () => {
    expect(inviteExpiresAt({ type: InviteType.SESSION, isLink: true, expiresInHours: WEEK }, NOW)).toBeNull();
  });

  it('gives an email invite to an event no timer: it ends with the event', () => {
    expect(inviteExpiresAt({ type: InviteType.SESSION, isLink: false, expiresInHours: WEEK }, NOW)).toBeNull();
  });

  it('gives a pod link and a circle link no timer', () => {
    expect(inviteExpiresAt({ type: InviteType.POD, isLink: true, expiresInHours: WEEK }, NOW)).toBeNull();
    expect(inviteExpiresAt({ type: InviteType.CIRCLE, isLink: true, expiresInHours: WEEK }, NOW)).toBeNull();
  });

  it('keeps the asked hours for an email invite to a pod or a circle', () => {
    const inAWeek = new Date('2026-11-28T10:00:00.000Z');
    expect(inviteExpiresAt({ type: InviteType.POD, isLink: false, expiresInHours: WEEK }, NOW)).toEqual(inAWeek);
    expect(inviteExpiresAt({ type: InviteType.CIRCLE, isLink: false, expiresInHours: WEEK }, NOW)).toEqual(inAWeek);
  });

  it('keeps the asked hours for a platform invite, and no timer when none is asked', () => {
    expect(inviteExpiresAt({ type: InviteType.PLATFORM, isLink: true, expiresInHours: 24 }, NOW)).toEqual(new Date('2026-11-22T10:00:00.000Z'));
    expect(inviteExpiresAt({ type: undefined, isLink: false, expiresInHours: 24 }, NOW)).toEqual(new Date('2026-11-22T10:00:00.000Z'));
    expect(inviteExpiresAt({ type: InviteType.POD, isLink: false }, NOW)).toBeNull();
  });
});
