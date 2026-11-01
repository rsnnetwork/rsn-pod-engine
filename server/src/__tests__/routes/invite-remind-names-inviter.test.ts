// ─── A reminder names the invite's own inviter (26 Oct 2026, H2b item 8) ─────────────────────────────────
//
// A co-host may remind the host's event invites, and the host a co-host's. The reminder email read "{whoever pressed
// Remind} invited you", because the route built the email's context from the presser. It is the invite's inviter who
// invited the person, and the email says so, whoever presses. The presser still spends their own reminder allowance
// and is still the one whose blocks are checked.
//
// The real router runs under express; sign-in, the database, the services and the fan-out are stand-ins.

import express from 'express';
import request from 'supertest';

const HOST = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COHOST = 'aaaaaaaa-0000-4000-8000-00000000000b';
const INVITE = 'cccccccc-0000-4000-8000-0000000000aa';
const EVENT = 'dddddddd-0000-4000-8000-0000000000aa';

jest.mock('../../config', () => ({
  default: { clientUrl: 'https://app.rsn.network', rateLimitWindowMs: 60_000, rateLimitMaxRequests: 1000, env: 'test', isTest: true },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: 'aaaaaaaa-0000-4000-8000-00000000000b', email: 'co@getjacksapp.com', role: 'member', sessionId: 's-1' };
    next();
  },
  optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  __esModule: true,
}));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
jest.mock('../../realtime/fanout');
jest.mock('../../services/invite/invite.service');
jest.mock('../../services/invite/invite-reminders.service');
jest.mock('../../services/invite/invite-candidates.service');
jest.mock('../../services/email/email.service');
jest.mock('../../services/session/session.service');
jest.mock('../../services/pod/pod.service');

import * as inviteService from '../../services/invite/invite.service';
import * as inviteReminders from '../../services/invite/invite-reminders.service';
import * as emailService from '../../services/email/email.service';
import inviteRoutes from '../../routes/invites';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/invites', inviteRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const theInvite = {
  id: INVITE, invitee_email: 'guest@getjacksapp.com', type: 'session', session_id: EVENT, pod_id: null, circle_id: null,
  status: 'pending', code: 'CODE123', expires_at: null, inviter_id: HOST,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockImplementation(async (sql: string) => (
    /FROM invites WHERE id = \$1/.test(sql) ? { rows: [theInvite], rowCount: 1 } : { rows: [], rowCount: 0 }
  ));
  (inviteService.isAdminRole as jest.Mock).mockReturnValue(false);
  (inviteService.eventInviteRole as jest.Mock).mockResolvedValue('cohost');
  (inviteService.unreachableAddresses as jest.Mock).mockResolvedValue(new Set());
  (inviteService.buildInviteContext as jest.Mock).mockResolvedValue({ inviterName: 'Claus', type: 'session' });
  (inviteService.emailInvite as jest.Mock).mockResolvedValue({ sent: true });
  (inviteReminders.reminderAllowance as jest.Mock).mockResolvedValue(10);
  (inviteReminders.claimReminders as jest.Mock).mockResolvedValue({ claimed: [INVITE], recent: [] });
  (inviteReminders.releaseReminders as jest.Mock).mockResolvedValue(undefined);
  (inviteReminders.countRemindersSent as jest.Mock).mockResolvedValue(undefined);
});

describe('POST /invites/remind-all/:sessionId by a co-host (review I2: the event\'s Remind all names each invite\'s own inviter)', () => {
  const INVITE_2 = 'cccccccc-0000-4000-8000-0000000000bb';

  it('each reminder names the person who made its invite, and the presser\'s allowance is the one spent', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FROM sessions WHERE id = \$1/.test(sql)) {
        return { rows: [{ id: EVENT, title: 'Founders dinner', scheduled_at: null, host_user_id: HOST, pod_id: null, config: {}, event_format: null }], rowCount: 1 };
      }
      if (/SELECT id, invitee_email, code, inviter_id FROM invites/.test(sql)) {
        return {
          rows: [
            { id: INVITE, invitee_email: 'guest@getjacksapp.com', code: 'CODE123', inviter_id: HOST },
            { id: INVITE_2, invitee_email: 'other@getjacksapp.com', code: 'CODE456', inviter_id: COHOST },
          ],
          rowCount: 2,
        };
      }
      if (/SELECT id, display_name FROM users WHERE id = ANY/.test(sql)) {
        return { rows: [{ id: HOST, display_name: 'Claus' }, { id: COHOST, display_name: 'Co Host' }], rowCount: 2 };
      }
      return { rows: [], rowCount: 0 };
    });
    (inviteService.isAdminRole as jest.Mock).mockReturnValue(false);
    (inviteService.eventInviteRole as jest.Mock).mockResolvedValue('cohost');
    (inviteService.unreachableAddresses as jest.Mock).mockResolvedValue(new Set());
    (inviteReminders.reminderAllowance as jest.Mock).mockResolvedValue(10);
    (inviteReminders.claimReminders as jest.Mock).mockResolvedValue({ claimed: [INVITE, INVITE_2], recent: new Map() });
    (inviteReminders.releaseReminders as jest.Mock).mockResolvedValue(undefined);
    (inviteReminders.countRemindersSent as jest.Mock).mockResolvedValue(undefined);
    (emailService.sendInviteEmail as jest.Mock).mockResolvedValue({ sent: true });
    (emailService.asBulkEmail as jest.Mock).mockImplementation((run: () => Promise<unknown>) => run());

    const res = await request(app).post(`/invites/remind-all/${EVENT}`).send({});

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ reminded: 2, total: 2 });
    const sent = (emailService.sendInviteEmail as jest.Mock).mock.calls.map((c) => [c[0], c[1].inviterName]);
    expect(sent).toEqual(expect.arrayContaining([['guest@getjacksapp.com', 'Claus'], ['other@getjacksapp.com', 'Co Host']]));
    expect(sent).toHaveLength(2);
    expect(inviteReminders.reminderAllowance).toHaveBeenCalledWith(COHOST);
    expect(inviteReminders.countRemindersSent).toHaveBeenCalledWith(COHOST, 2);
  });
});

describe('POST /invites/:id/remind by a co-host for the host\'s invite', () => {
  it('builds the email for the invite\'s own inviter, and spends the presser\'s allowance', async () => {
    const res = await request(app).post(`/invites/${INVITE}/remind`).send({});

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ reminded: true });
    expect(inviteService.buildInviteContext).toHaveBeenCalledTimes(1);
    expect((inviteService.buildInviteContext as jest.Mock).mock.calls[0][0]).toBe(HOST);
    expect(inviteService.emailInvite).toHaveBeenCalledWith(expect.objectContaining({ inviterName: 'Claus' }), { code: 'CODE123', inviteeEmail: 'guest@getjacksapp.com' });
    expect(inviteReminders.reminderAllowance).toHaveBeenCalledWith(COHOST);
    expect(inviteReminders.countRemindersSent).toHaveBeenCalledWith(COHOST, 1);
    expect(inviteService.unreachableAddresses).toHaveBeenCalledWith(COHOST, ['guest@getjacksapp.com']);
  });
});
