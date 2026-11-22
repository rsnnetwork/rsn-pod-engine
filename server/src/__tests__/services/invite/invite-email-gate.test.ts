// ─── An invite to someone who already has an account goes through the notification email gate (22 Nov 2026) ───
//
// Stefan: "only get notifications if I am not online", "max X a day". An invite to a pod, an event or a circle for an
// active member is queued (sent only while away, within their daily maximum, dropped once they open it from their
// bell); an address with no member account behind it is emailed at once as before; a platform invite (only ever to an
// address with no account) and a context without its inviter are never queued.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
jest.mock('../../../config/logger', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }, __esModule: true }));
jest.mock('../../../config', () => ({ default: { clientUrl: 'https://app.rsn.network' }, __esModule: true }));
const mockSendInviteEmail = jest.fn();
jest.mock('../../../services/email/email.service', () => ({
  sendInviteEmail: (...a: unknown[]) => mockSendInviteEmail(...a),
  __esModule: true,
}));
const mockQueue = jest.fn();
jest.mock('../../../services/notification-email/notification-email.service', () => ({
  queueNotificationEmail: (...a: unknown[]) => mockQueue(...a),
  __esModule: true,
}));

import { InviteType } from '@rsn/shared';
import { emailOrQueueInvite, type InviteContext } from '../../../services/invite/invite.service';

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
const ctx: InviteContext = {
  type: InviteType.SESSION, podId: null, sessionId: 's-1', circleId: null, inviterId: 'u-host', inviterName: 'Stefan',
  targetName: 'Founders breakfast', scheduledAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSendInviteEmail.mockResolvedValue({ sent: true });
  mockQueue.mockResolvedValue(undefined);
});

describe('an invite\'s email', () => {
  it('an active member is queued, with what the email is built from when it goes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u-ana', invite_id: 'inv-1' }] });
    const result = await emailOrQueueInvite(ctx, { code: 'ABC', inviteeEmail: 'ana@getreason.app' });
    expect(result).toEqual({ sent: true });
    expect(flat(mockQuery.mock.calls[0][0])).toContain("u.email = lower($1) AND u.status = 'active' AND u.account_kind = 'member'");
    expect(mockQueue).toHaveBeenCalledWith({
      userId: 'u-ana', kind: 'invite', sourceId: 'inv-1', actorId: 'u-host', bellLink: '/invite/ABC',
      payload: {
        inviterId: 'u-host', inviterName: 'Stefan', inviteType: 'session', targetName: 'Founders breakfast', code: 'ABC',
        podId: null, sessionId: 's-1', circleId: null,
      },
    });
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it('a member known by id (a batch) is looked up by id, and the invite id the caller has is the one kept', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u-ana', invite_id: 'inv-other' }] });
    await emailOrQueueInvite(ctx, { code: 'ABC', inviteeEmail: 'ana@getreason.app', inviteeUserId: 'u-ana', inviteId: 'inv-1' });
    expect(flat(mockQuery.mock.calls[0][0])).toContain('WHERE u.id = $1');
    expect(mockQuery.mock.calls[0][1]).toEqual(['u-ana', 'ABC']);
    expect(mockQueue).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'inv-1' }));
  });

  it('an address with no member account behind it (someone new, a guest, a closed account) is emailed now, as before', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await emailOrQueueInvite(ctx, { code: 'ABC', inviteeEmail: 'new@getreason.app' });
    expect(result).toEqual({ sent: true });
    expect(mockQueue).not.toHaveBeenCalled();
    expect(mockSendInviteEmail).toHaveBeenCalledWith('new@getreason.app', expect.objectContaining({
      inviterName: 'Stefan', type: 'session', inviteUrl: 'https://app.rsn.network/invite/ABC',
    }));
  });

  it('a platform invite, and a context that does not say who invited, are emailed now without asking anything', async () => {
    await emailOrQueueInvite({ ...ctx, type: InviteType.PLATFORM }, { code: 'ABC', inviteeEmail: 'x@getreason.app' });
    await emailOrQueueInvite({ ...ctx, inviterId: undefined }, { code: 'ABC', inviteeEmail: 'x@getreason.app' });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockQueue).not.toHaveBeenCalled();
    expect(mockSendInviteEmail).toHaveBeenCalledTimes(2);
  });
});
