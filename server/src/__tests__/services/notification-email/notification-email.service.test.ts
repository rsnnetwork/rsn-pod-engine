// ─── The notification email gate: queueing, the flush, the sends (22 Nov 2026, Stefan) ──────────────────────
//
// notification-email.service.ts against a stand-in database that answers by statement (regex-routed, never by
// position). The rules themselves are in notification-email.rules.test.ts; this pins what the service writes and sends:
// nothing is queued for someone who gets no such email, a row is due ten minutes later (now, when "only when I'm away"
// is off), a flush takes the member's lock, re-reads the rows under FOR UPDATE, counts the day, and then sends one
// email (the notification's own for one thing, a round-up for several), holds, or lets go. The SQL itself was run on a
// throwaway Postgres with every migration applied (the task report has the run).

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: async (cb: (client: { query: typeof mockClientQuery }) => Promise<unknown>) => cb({ query: mockClientQuery }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockConfig = { clientUrl: 'https://app.rsn.network', notificationEmailGate: 'on' as 'on' | 'off' };
jest.mock('../../../config', () => ({ default: mockConfig, __esModule: true }));

const mockSendDm = jest.fn();
const mockSendRequest = jest.fn();
const mockSendAccepted = jest.fn();
const mockSendRoundup = jest.fn();
const mockTypeEnabled = jest.fn();
jest.mock('../../../services/email/email.service', () => ({
  sendDmNotificationEmail: (...a: unknown[]) => mockSendDm(...a),
  sendPokeReceivedEmail: (...a: unknown[]) => mockSendRequest(...a),
  sendPokeAcceptedEmail: (...a: unknown[]) => mockSendAccepted(...a),
  sendNotificationRoundupEmail: (...a: unknown[]) => mockSendRoundup(...a),
  isEmailTypeEnabled: (...a: unknown[]) => mockTypeEnabled(...a),
  asBulkEmail: (run: () => Promise<unknown>) => run(),
  __esModule: true,
}));
let mockPresence: string | null = 'offline';
jest.mock('../../../services/presence/presence.service', () => ({
  presenceState: async () => mockPresence,
  __esModule: true,
}));
const mockBuildInviteContext = jest.fn();
const mockEmailInvite = jest.fn();
const mockUnreachable = jest.fn();
jest.mock('../../../services/invite/invite.service', () => ({
  buildInviteContext: (...a: unknown[]) => mockBuildInviteContext(...a),
  emailInvite: (...a: unknown[]) => mockEmailInvite(...a),
  unreachableAddresses: (...a: unknown[]) => mockUnreachable(...a),
  __esModule: true,
}));

import {
  flushMember, processDueNotificationEmails, queueNotificationEmail, sendItems, type StoredItem,
} from '../../../services/notification-email/notification-email.service';

const NOW = new Date('2026-11-22T10:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

interface MemberRow {
  id: string; email: string | null; display_name: string | null; first_name: string | null; status: string;
  account_kind: string; notify_email: boolean; notification_prefs: unknown; last_seen_at: Date | null; local_day: string;
}
let memberRow: MemberRow;
let outboxRows: Array<Record<string, unknown>>;
let unreadMessages: string[];
let pendingRequests: string[];
let readBells: Array<{ link: string; created_at: Date }>;
let sentToday: number;
let lockFree: boolean;

const dmRow = (id: string, minutesAgo: number, sourceId = `m-${id}`, conversationId = 'c1', senderName = 'Bo') => ({
  id, kind: 'direct_message', source_id: sourceId, actor_id: 'bo', bell_link: null,
  payload: { senderName, snippet: `words ${id}`, conversationId },
  created_at: ago(minutesAgo), send_after: new Date(ago(minutesAgo).getTime() + 10 * 60_000),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.notificationEmailGate = 'on';
  mockPresence = 'offline';
  memberRow = {
    id: 'ana', email: 'ana@example.org', display_name: 'Ana Lopez', first_name: 'Ana', status: 'active',
    account_kind: 'member', notify_email: true, notification_prefs: {}, last_seen_at: ago(60), local_day: '2026-11-22',
  };
  outboxRows = [];
  unreadMessages = [];
  pendingRequests = [];
  readBells = [];
  sentToday = 0;
  lockFree = true;
  mockTypeEnabled.mockResolvedValue(true);
  mockSendDm.mockResolvedValue({ sent: true });
  mockSendRequest.mockResolvedValue({ sent: true });
  mockSendAccepted.mockResolvedValue({ sent: true });
  mockSendRoundup.mockResolvedValue({ sent: true });
  mockUnreachable.mockResolvedValue(new Set());
  mockQuery.mockImplementation(async (sql: unknown) => {
    const s = flat(sql);
    if (/FROM users u WHERE u\.id = \$1/.test(s)) return { rows: [memberRow] };
    if (/^INSERT INTO notification_email_outbox/.test(s)) return { rows: [{ id: 'row-new' }] };
    if (/^SELECT .* FROM notification_email_outbox WHERE user_id = \$1 AND status = 'queued'/.test(s)) return { rows: outboxRows };
    if (/FROM notifications WHERE user_id = \$1 AND is_read = TRUE/.test(s)) return { rows: readBells };
    if (/FROM direct_messages dm JOIN dm_conversations/.test(s)) return { rows: unreadMessages.map((id) => ({ id })) };
    if (/FROM user_pokes p JOIN users s/.test(s)) return { rows: pendingRequests.map((id) => ({ id })) };
    return { rows: [], rowCount: 0 };
  });
  mockClientQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
    const s = flat(sql);
    if (/pg_try_advisory_xact_lock/.test(s)) return { rows: [{ locked: lockFree }] };
    if (/FOR UPDATE$/.test(s)) return { rows: (params[0] as string[]).map((id) => ({ id })) };
    if (/COUNT\(\*\)::text AS n FROM notification_email_deliveries/.test(s)) return { rows: [{ n: String(sentToday) }] };
    if (/^INSERT INTO notification_email_deliveries/.test(s)) return { rows: [{ id: 'delivery-1' }] };
    return { rows: [], rowCount: 1 };
  });
});

const outboxInserts = () => mockQuery.mock.calls.filter(([sql]) => /^INSERT INTO notification_email_outbox/.test(flat(sql)));
const clientWrites = (pattern: RegExp) => mockClientQuery.mock.calls.filter(([sql]) => pattern.test(flat(sql)));
const finalWrites = () => mockQuery.mock.calls.filter(([sql]) => /^UPDATE notification_email_outbox SET status = \$2, sent_at/.test(flat(sql)));

const dmRequest = {
  userId: 'ana', kind: 'direct_message' as const, sourceId: 'msg-1', actorId: 'bo',
  payload: { senderName: 'Bo', snippet: 'Hi Ana', conversationId: 'c1' },
};

describe('queueing', () => {
  it('a member who gets these emails has a row due ten minutes from now, once per source', async () => {
    await queueNotificationEmail(dmRequest, NOW);
    expect(outboxInserts()).toHaveLength(1);
    const [sql, params] = outboxInserts()[0];
    expect(flat(sql)).toContain('ON CONFLICT (user_id, kind, source_id) DO NOTHING');
    expect(params).toEqual(['ana', 'direct_message', 'msg-1', 'bo', null, JSON.stringify(dmRequest.payload), new Date(NOW.getTime() + 600_000), NOW]);
  });

  it.each([
    ['a guest', { account_kind: 'guest' }],
    ['a suspended account', { status: 'suspended' }],
    ['someone with email switched off', { notify_email: false }],
    ['someone with message emails switched off', { notification_prefs: { dm_email: false } }],
  ])('nothing is queued for %s', async (_who, over) => {
    memberRow = { ...memberRow, ...over };
    await queueNotificationEmail(dmRequest, NOW);
    expect(outboxInserts()).toHaveLength(0);
  });

  it('a meeting request is not queued while the admin switch for it is off', async () => {
    mockTypeEnabled.mockResolvedValue(false);
    await queueNotificationEmail({ ...dmRequest, kind: 'meeting_request', payload: { senderName: 'Bo', note: null, reasonLine: null } }, NOW);
    expect(mockTypeEnabled).toHaveBeenCalledWith('poke_request');
    expect(outboxInserts()).toHaveLength(0);
  });

  it('with "only when I\'m away" off the row is due now, and the member is flushed straight after', async () => {
    memberRow.notification_prefs = { email_away_only: false };
    await queueNotificationEmail(dmRequest, NOW);
    expect(outboxInserts()[0][1][6]).toEqual(NOW);
    await new Promise((r) => setImmediate(r));
    expect(mockQuery.mock.calls.some(([sql]) => /FROM notification_email_outbox WHERE user_id = \$1 AND status = 'queued'/.test(flat(sql)))).toBe(true);
  });

  it('never throws: a database that fails leaves the notification as it was', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    await expect(queueNotificationEmail(dmRequest, NOW)).resolves.toBeUndefined();
  });

  it('with the gate switched off (NOTIFICATION_EMAIL_GATE=off) the email goes at once and nothing is queued', async () => {
    mockConfig.notificationEmailGate = 'off';
    await queueNotificationEmail(dmRequest, NOW);
    expect(outboxInserts()).toHaveLength(0);
    expect(mockSendDm).toHaveBeenCalledWith('ana@example.org', 'Ana', {
      senderName: 'Bo', snippet: 'Hi Ana', threadUrl: 'https://app.rsn.network/messages/c1',
    });
  });
});

describe('a member\'s flush', () => {
  it('does nothing while none of their rows is due', async () => {
    outboxRows = [dmRow('a', 3)];
    const outcome = await flushMember('ana', NOW);
    expect(outcome.plan).toBeNull();
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('one message, unread, while they were away: its own email, counted for the day, then marked sent', async () => {
    outboxRows = [dmRow('a', 11)];
    unreadMessages = ['m-a'];
    const outcome = await flushMember('ana', NOW);
    expect(outcome.sent).toBe(true);
    expect(clientWrites(/pg_try_advisory_xact_lock/)[0][1]).toEqual([expect.any(Number), 'ana']);
    expect(clientWrites(/FOR UPDATE$/)).toHaveLength(1);
    expect(clientWrites(/^INSERT INTO notification_email_deliveries/)[0][1]).toEqual(['ana', '2026-11-22', 1]);
    expect(clientWrites(/SET status = 'sending'/)[0][1]).toEqual([['a'], NOW, 'delivery-1']);
    expect(mockSendDm).toHaveBeenCalledWith('ana@example.org', 'Ana', {
      senderName: 'Bo', snippet: 'words a', threadUrl: 'https://app.rsn.network/messages/c1',
    });
    expect(finalWrites()[0][1]).toEqual([['a'], 'sent', true]);
  });

  it('several things: ONE round-up email that says what they are', async () => {
    outboxRows = [dmRow('a', 12), dmRow('b', 11), dmRow('c', 5, 'm-c', 'c2', 'Clara'), {
      id: 'r', kind: 'meeting_request', source_id: 'p-1', actor_id: 'fa', bell_link: '/messages?poke=p-1',
      payload: { senderName: 'Fatima', note: 'Coffee?', reasonLine: null }, created_at: ago(4), send_after: ago(-6),
    }];
    unreadMessages = ['m-a', 'm-b', 'm-c'];
    pendingRequests = ['p-1'];
    await flushMember('ana', NOW);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(mockSendRoundup).toHaveBeenCalledTimes(1);
    const [to, data] = mockSendRoundup.mock.calls[0];
    expect(to).toBe('ana@example.org');
    expect(data.summary).toBe('3 new messages and 1 meeting request');
    expect(data.messages).toEqual([
      { name: 'Bo', count: 2, snippet: 'words b', url: 'https://app.rsn.network/messages/c1' },
      { name: 'Clara', count: 1, snippet: 'words c', url: 'https://app.rsn.network/messages/c2' },
    ]);
    expect(data.settingsUrl).toBe('https://app.rsn.network/settings');
    expect(clientWrites(/^INSERT INTO notification_email_deliveries/)[0][1]).toEqual(['ana', '2026-11-22', 4]);
  });

  it('over the day\'s maximum: held for the next morning, no email', async () => {
    outboxRows = [dmRow('a', 11)];
    unreadMessages = ['m-a'];
    sentToday = 3;
    const outcome = await flushMember('ana', NOW);
    expect(outcome.plan?.hold).toEqual(['a']);
    expect(clientWrites(/SET status = 'held', reason = 'daily_max'/)[0][1]).toEqual([['a']]);
    expect(clientWrites(/^INSERT INTO notification_email_deliveries/)).toHaveLength(0);
    expect(mockSendDm).not.toHaveBeenCalled();
  });

  it('a member who chose ten a day still gets the fourth', async () => {
    memberRow.notification_prefs = { email_max_per_day: 10 };
    outboxRows = [dmRow('a', 11)];
    unreadMessages = ['m-a'];
    sentToday = 3;
    await flushMember('ana', NOW);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });

  it('on REASON since it happened: let go as seen, no email', async () => {
    outboxRows = [dmRow('a', 11)];
    unreadMessages = ['m-a'];
    memberRow.last_seen_at = ago(4);
    await flushMember('ana', NOW);
    expect(clientWrites(/SET status = \$2, reason = \$3/)[0][1]).toEqual([['a'], 'skipped', 'seen']);
    expect(mockSendDm).not.toHaveBeenCalled();
  });

  it('online right now: let go as seen', async () => {
    outboxRows = [dmRow('a', 11)];
    unreadMessages = ['m-a'];
    mockPresence = 'online';
    await flushMember('ana', NOW);
    expect(clientWrites(/SET status = \$2, reason = \$3/)[0][1]).toEqual([['a'], 'skipped', 'seen']);
  });

  it('a background tab is away, not online: the email goes', async () => {
    outboxRows = [dmRow('a', 11)];
    unreadMessages = ['m-a'];
    mockPresence = 'away';
    await flushMember('ana', NOW);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });

  it('read meanwhile: let go as read', async () => {
    outboxRows = [dmRow('a', 11)];
    unreadMessages = [];
    await flushMember('ana', NOW);
    expect(clientWrites(/SET status = \$2, reason = \$3/)[0][1]).toEqual([['a'], 'skipped', 'read']);
    expect(mockSendDm).not.toHaveBeenCalled();
  });

  it('a meeting request whose bell was read since: let go, even while it waits for an answer', async () => {
    outboxRows = [{
      id: 'r', kind: 'meeting_request', source_id: 'p-1', actor_id: 'fa', bell_link: '/messages?poke=p-1',
      payload: { senderName: 'Fatima', note: null, reasonLine: null }, created_at: ago(11), send_after: ago(1),
    }];
    pendingRequests = ['p-1'];
    readBells = [{ link: '/messages?poke=p-1', created_at: ago(11) }];
    await flushMember('ana', NOW);
    expect(clientWrites(/SET status = \$2, reason = \$3/)[0][1]).toEqual([['r'], 'skipped', 'read']);
  });

  it('another instance holds the member: nothing is written, nothing is sent', async () => {
    outboxRows = [dmRow('a', 11)];
    unreadMessages = ['m-a'];
    lockFree = false;
    const outcome = await flushMember('ana', NOW);
    expect(outcome.plan).toBeNull();
    expect(mockClientQuery).toHaveBeenCalledTimes(1);
    expect(mockSendDm).not.toHaveBeenCalled();
  });

  it('a row another instance took meanwhile is not sent again', async () => {
    outboxRows = [dmRow('a', 11), dmRow('b', 11)];
    unreadMessages = ['m-a', 'm-b'];
    mockClientQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
      const s = flat(sql);
      if (/pg_try_advisory_xact_lock/.test(s)) return { rows: [{ locked: true }] };
      if (/FOR UPDATE$/.test(s)) return { rows: [{ id: 'b' }] };
      if (/COUNT\(\*\)/.test(s)) return { rows: [{ n: '0' }] };
      if (/^INSERT INTO notification_email_deliveries/.test(s)) return { rows: [{ id: 'delivery-1' }] };
      return { rows: [], rowCount: (params ?? []).length };
    });
    await flushMember('ana', NOW);
    expect(clientWrites(/SET status = 'sending'/)[0][1][0]).toEqual(['b']);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });

  it('a send the provider refused is marked failed, never tried again', async () => {
    outboxRows = [dmRow('a', 11)];
    unreadMessages = ['m-a'];
    mockSendDm.mockResolvedValue({ sent: false });
    const outcome = await flushMember('ana', NOW);
    expect(outcome.sent).toBe(false);
    expect(finalWrites()[0][1]).toEqual([['a'], 'failed', false]);
  });

  it('a member who switched email off since: every row let go as not eligible', async () => {
    outboxRows = [dmRow('a', 11)];
    unreadMessages = ['m-a'];
    memberRow.notify_email = false;
    await flushMember('ana', NOW);
    expect(clientWrites(/SET status = \$2, reason = \$3/)[0][1]).toEqual([['a'], 'dropped', 'not_eligible']);
  });
});

describe('the every-minute run', () => {
  it('gives up on stuck sends first, then flushes each member with a row due, oldest first', async () => {
    await processDueNotificationEmails(NOW);
    const sqls = mockQuery.mock.calls.map(([sql]) => flat(sql));
    expect(sqls[0]).toMatch(/^UPDATE notification_email_outbox SET status = 'failed', reason = 'stuck' WHERE status IN \('sending', 'digesting'\)/);
    expect(sqls.find((s) => /GROUP BY user_id ORDER BY MIN\(send_after\)/.test(s))).toBeDefined();
  });

  it('does nothing with the gate switched off', async () => {
    mockConfig.notificationEmailGate = 'off';
    expect(await processDueNotificationEmails(NOW)).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('each kind on its own is the email it always was', () => {
  const member = { email: 'ana@example.org', display_name: 'Ana Lopez', first_name: 'Ana' };
  const stored = (over: Partial<StoredItem>) => ({ id: 'x', sourceId: 's', actorId: null, bellLink: null, createdAt: NOW, sendAfter: NOW, ...over }) as StoredItem;

  it('a meeting request', async () => {
    await sendItems(member, [stored({ kind: 'meeting_request', payload: { senderName: 'Fatima', note: 'Hi', reasonLine: 'Both in climate' } })]);
    expect(mockSendRequest).toHaveBeenCalledWith('ana@example.org', 'Ana', {
      senderName: 'Fatima', note: 'Hi', reasonLine: 'Both in climate', messagesUrl: 'https://app.rsn.network/messages',
    });
  });

  it('an accepted request opens the conversation', async () => {
    await sendItems(member, [stored({ kind: 'meeting_accepted', payload: { accepterName: 'David', conversationId: 'c3' } })]);
    expect(mockSendAccepted).toHaveBeenCalledWith('ana@example.org', 'Ana', { accepterName: 'David', messagesUrl: 'https://app.rsn.network/messages/c3' });
  });

  it('an invite is built again from the invite, so an event invite keeps its calendar entry', async () => {
    mockBuildInviteContext.mockResolvedValue({ type: 'session', inviterName: 'Stefan' });
    mockEmailInvite.mockResolvedValue({ sent: true });
    const ok = await sendItems(member, [stored({ kind: 'invite', payload: {
      inviterId: 'st', inviterName: 'Stefan', inviteType: 'session', targetName: 'Breakfast', code: 'ABC', podId: null, sessionId: 's1', circleId: null,
    } })]);
    expect(ok).toBe(true);
    expect(mockBuildInviteContext).toHaveBeenCalledWith('st', 'session', { podId: null, sessionId: 's1', circleId: null });
    expect(mockEmailInvite).toHaveBeenCalledWith({ type: 'session', inviterName: 'Stefan' }, { code: 'ABC', inviteeEmail: 'ana@example.org' });
  });

  it('nobody to send to sends nothing', async () => {
    expect(await sendItems({ ...member, email: null }, [stored({ kind: 'direct_message', payload: { senderName: 'Bo', snippet: 'x', conversationId: 'c' } })])).toBe(false);
    expect(mockSendDm).not.toHaveBeenCalled();
  });
});
