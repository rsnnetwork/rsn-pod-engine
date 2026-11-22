// ─── "Yesterday on REASON" and "Your week on REASON" (22 Nov 2026, Stefan) ───────────────────────────────────
//
// notification-digest.service.ts against a stand-in database answering by statement. Pinned here: who may get a digest
// (never a guest, a closed account, email off, or an address reserved for testing), the weekly switch fails closed
// while the daily one is on by default, the delivery row is the claim (a member another instance claimed is not sent
// twice), a week with nothing to say is not sent, the unsubscribe token is for this one purpose, and the admin's
// sample goes to their own address. The candidate SQL (Monday 08:00 on the member's own clock) ran on a throwaway
// Postgres with every migration applied (the task report has the run).

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
jest.mock('../../../config/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockConfig = {
  clientUrl: 'https://app.rsn.network', apiBaseUrl: 'https://api.rsn.network', jwtSecret: 'test-secret', notificationEmailGate: 'on',
};
jest.mock('../../../config', () => ({ default: mockConfig, __esModule: true }));
const mockSendWeekly = jest.fn();
const mockSendDaily = jest.fn();
const mockTypeEnabled = jest.fn();
jest.mock('../../../services/email/email.service', () => ({
  sendWeeklyDigestEmail: (...a: unknown[]) => mockSendWeekly(...a),
  sendDailyDigestEmail: (...a: unknown[]) => mockSendDaily(...a),
  isEmailTypeEnabled: (...a: unknown[]) => mockTypeEnabled(...a),
  asBulkEmail: (run: () => Promise<unknown>) => run(),
  __esModule: true,
}));
jest.mock('../../../services/presence/presence.service', () => ({ presenceState: async () => 'offline', __esModule: true }));
const mockMatches = jest.fn();
jest.mock('../../../services/matching/platform-match.service', () => ({
  getPlatformMatches: (...a: unknown[]) => mockMatches(...a),
  __esModule: true,
}));

import jwt from 'jsonwebtoken';
import {
  digestRecipient, digestSwitchOn, mintUnsubscribeToken, processDailyDigests, processWeeklyDigests, readUnsubscribeToken,
  sendDigestSample, unsubscribeUrlFor, weeklyEmailData,
} from '../../../services/notification-email/notification-digest.service';
import type { GateMemberRow } from '../../../services/notification-email/notification-email.service';

const NOW = new Date('2026-11-23T08:30:00Z'); // a Monday
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
const ana: GateMemberRow = {
  id: 'ana', email: 'ana@getreason.app', display_name: 'Ana Lopez', first_name: 'Ana', status: 'active', account_kind: 'member',
  notify_email: true, notification_prefs: {}, last_seen_at: null, local_day: '2026-11-23',
};

/** The answers the weekly facts read, by statement. */
let facts: Record<string, unknown[]>;
let member: GateMemberRow;
let claimFree: boolean;
let weeklySwitch: unknown[];
let candidates: unknown[];
let dailyCandidatesRows: unknown[];
let heldRows: unknown[];

beforeEach(() => {
  jest.clearAllMocks();
  member = { ...ana };
  claimFree = true;
  weeklySwitch = [{ enabled: true }];
  candidates = [{ user_id: 'ana', email: 'ana@getreason.app', local_day: '2026-11-23' }];
  dailyCandidatesRows = [];
  heldRows = [];
  facts = {
    waiting: [{ user_id: 'u1', name: 'Fatima Khan' }],
    sentOpen: [{ n: '2' }],
    connections: [],
    unread: [{ n: '0' }],
    oldestUnread: [],
    events: [],
    members: [{ n: '5' }],
    circles: [],
  };
  mockTypeEnabled.mockResolvedValue(true);
  mockSendWeekly.mockResolvedValue({ sent: true });
  mockSendDaily.mockResolvedValue({ sent: true });
  mockMatches.mockResolvedValue({ matches: [], profileIncomplete: false, nextEvent: null, youAreLookingFor: null });
  mockQuery.mockImplementation(async (sql: unknown) => {
    const s = flat(sql);
    if (/SELECT enabled FROM email_config/.test(s)) return { rows: weeklySwitch };
    if (/^SELECT u\.id AS user_id, u\.email,/.test(s)) return { rows: candidates };
    if (/^SELECT u\.id AS user_id, to_char/.test(s)) return { rows: dailyCandidatesRows };
    if (/^INSERT INTO notification_email_deliveries/.test(s)) return { rows: claimFree ? [{ id: 'd-1' }] : [] };
    if (/FROM users u WHERE u\.id = \$1/.test(s)) return { rows: [member] };
    if (/^UPDATE notification_email_outbox SET status = 'digesting'/.test(s)) return { rows: heldRows };
    if (/FROM user_pokes p JOIN users u ON u\.id = p\.sender_id WHERE p\.recipient_id = \$1/.test(s)) return { rows: facts.waiting };
    if (/FROM user_pokes p JOIN users u ON u\.id = p\.recipient_id WHERE p\.sender_id = \$1/.test(s)) return { rows: facts.sentOpen };
    if (/p\.status = 'accepted' AND p\.responded_at >= \$2/.test(s)) return { rows: facts.connections };
    if (/^SELECT COUNT\(\*\)::text AS n FROM direct_messages/.test(s)) return { rows: facts.unread };
    if (/AS name, dm\.conversation_id FROM direct_messages/.test(s)) return { rows: facts.oldestUnread };
    if (/FROM sessions s WHERE s\.status = 'scheduled'/.test(s)) return { rows: facts.events };
    if (/FROM users WHERE status = 'active' AND account_kind = 'member' AND created_at >= \$2/.test(s)) return { rows: facts.members };
    if (/FROM circles WHERE archived_at IS NULL/.test(s)) return { rows: facts.circles };
    return { rows: [], rowCount: 0 };
  });
});

const settled = () => mockQuery.mock.calls
  .filter(([sql]) => /^UPDATE notification_email_deliveries SET status = \$2, item_count/.test(flat(sql)))
  .map(([, p]) => (p as unknown[])[1]);

describe('who may get a digest', () => {
  it('a member who gets notification emails', () => {
    expect(digestRecipient(ana)).toBe(true);
  });
  it.each([
    ['a guest', { account_kind: 'guest' }],
    ['a suspended account', { status: 'suspended' }],
    ['email switched off', { notify_email: false }],
    ['an address reserved for testing', { email: 'e2e-1@rsn-e2e.invalid' }],
    ['an example.com address', { email: 'someone@example.com' }],
  ])('never %s', (_who, over) => {
    expect(digestRecipient({ ...ana, ...over })).toBe(false);
  });
});

describe('the admin switches', () => {
  it('the weekly one is off unless its row says on: no row, or a read that fails, is off', async () => {
    weeklySwitch = [];
    expect(await digestSwitchOn('weekly_digest')).toBe(false);
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    expect(await digestSwitchOn('weekly_digest')).toBe(false);
    weeklySwitch = [{ enabled: false }];
    expect(await digestSwitchOn('weekly_digest')).toBe(false);
    weeklySwitch = [{ enabled: true }];
    expect(await digestSwitchOn('weekly_digest')).toBe(true);
  });

  it('with the weekly switch off no member is even looked at', async () => {
    weeklySwitch = [{ enabled: false }];
    expect(await processWeeklyDigests(NOW)).toBe(0);
    expect(mockQuery.mock.calls.some(([sql]) => /FROM users u CROSS JOIN LATERAL/.test(flat(sql)))).toBe(false);
  });

  it('with the gate switched off neither digest runs', async () => {
    mockConfig.notificationEmailGate = 'off';
    try {
      expect(await processWeeklyDigests(NOW)).toBe(0);
      expect(await processDailyDigests(NOW)).toBe(0);
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      mockConfig.notificationEmailGate = 'on';
    }
  });
});

describe('the weekly run', () => {
  it('asks for Monday from 08:00 on each member\'s own clock, members only, weekly digest not switched off, not sent today', async () => {
    await processWeeklyDigests(NOW);
    const sql = flat(mockQuery.mock.calls.find(([q]) => /^SELECT u\.id AS user_id, u\.email,/.test(flat(q)))![0]);
    expect(sql).toContain("u.status = 'active' AND u.account_kind = 'member' AND u.notify_email = TRUE");
    expect(sql).toContain("(u.notification_prefs->>'weekly_digest') IS DISTINCT FROM 'false'");
    expect(sql).toContain("EXTRACT(ISODOW FROM ($1::timestamptz AT TIME ZONE z.zone)) = 1");
    expect(sql).toContain("EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE z.zone)) >= 8");
    expect(sql).toContain('pg_timezone_names');
  });

  it('claims the member\'s week, sends one email, and settles the claim as sent', async () => {
    expect(await processWeeklyDigests(NOW)).toBe(1);
    const claim = mockQuery.mock.calls.find(([q]) => /^INSERT INTO notification_email_deliveries/.test(flat(q)))!;
    expect(flat(claim[0])).toContain("ON CONFLICT (user_id, kind, local_day) WHERE kind IN ('daily', 'weekly') DO NOTHING");
    expect(claim[1]).toEqual(['ana', 'weekly', '2026-11-23']);
    expect(mockSendWeekly).toHaveBeenCalledTimes(1);
    const [to, data] = mockSendWeekly.mock.calls[0];
    expect(to).toBe('ana@getreason.app');
    expect(data.recipientName).toBe('Ana');
    expect(data.waitingForYou).toEqual([{ name: 'Fatima Khan', url: 'https://app.rsn.network/people/u1' }]);
    expect(data.sentUnanswered).toBe(2);
    expect(data.suggestions[0]).toEqual({ text: 'Reply to Fatima', url: 'https://app.rsn.network/messages' });
    expect(data.unsubscribeUrl).toMatch(/^https:\/\/api\.rsn\.network\/api\/email\/unsubscribe\/weekly\?token=/);
    expect(settled()).toEqual(['sent']);
  });

  it('settling the claim passes the status and "it went" as two parameters (one read both ways is refused by Postgres)', async () => {
    await processWeeklyDigests(NOW);
    const [sql, params] = mockQuery.mock.calls.find(([q]) => /^UPDATE notification_email_deliveries SET status = \$2, item_count/.test(flat(q)))!;
    expect(flat(sql)).toContain('sent_at = CASE WHEN $4 THEN NOW() ELSE NULL END');
    expect(flat(sql)).not.toMatch(/\$2 = 'sent'/);
    expect(params).toEqual(['d-1', 'sent', 0, true]);
  });

  it('a member another instance claimed is not sent again', async () => {
    claimFree = false;
    expect(await processWeeklyDigests(NOW)).toBe(0);
    expect(mockSendWeekly).not.toHaveBeenCalled();
  });

  it('a week with nothing to say is claimed and skipped, not sent', async () => {
    facts.waiting = [];
    facts.sentOpen = [{ n: '0' }];
    expect(await processWeeklyDigests(NOW)).toBe(0);
    expect(mockSendWeekly).not.toHaveBeenCalled();
    expect(settled()).toEqual(['skipped']);
  });

  it('a member who switched the weekly digest off since is skipped', async () => {
    member = { ...ana, notification_prefs: { weekly_digest: false } };
    await processWeeklyDigests(NOW);
    expect(mockSendWeekly).not.toHaveBeenCalled();
    expect(settled()).toEqual(['skipped']);
  });

  it('an address reserved for testing is claimed and skipped, so the run never picks it again this week', async () => {
    candidates = [{ user_id: 'e2e', email: 'e2etest-9@rsn-e2e.invalid', local_day: '2026-11-23' }];
    await processWeeklyDigests(NOW);
    expect(mockSendWeekly).not.toHaveBeenCalled();
    expect(settled()).toEqual(['skipped']);
  });

  it('suggests up to three people, never someone already asked', async () => {
    mockMatches.mockResolvedValue({
      profileIncomplete: false, nextEvent: null, youAreLookingFor: null,
      matches: [
        { userId: 'p1', displayName: 'Clara', theyCanBring: 'Fundraising', professionalRole: 'Founder', pokeStatus: null },
        { userId: 'p2', displayName: 'Dan', theyCanBring: null, professionalRole: 'Investor', pokeStatus: 'pending' },
        { userId: 'p3', displayName: 'Eve', theyCanBring: null, professionalRole: 'Engineer', pokeStatus: null },
      ],
    });
    await processWeeklyDigests(NOW);
    expect(mockMatches).toHaveBeenCalledWith('ana', { limit: 3 });
    expect(mockSendWeekly.mock.calls[0][1].people).toEqual([
      { name: 'Clara', line: 'Fundraising', url: 'https://app.rsn.network/people/p1' },
      { name: 'Eve', line: 'Engineer', url: 'https://app.rsn.network/people/p3' },
    ]);
  });

  it('suggestions that cannot be read leave the email without them, not unsent', async () => {
    mockMatches.mockRejectedValue(new Error('scoring failed'));
    expect(await processWeeklyDigests(NOW)).toBe(1);
    expect(mockSendWeekly.mock.calls[0][1].people).toEqual([]);
  });
});

describe('the daily run', () => {
  const held = (id: string, kind: string, payload: unknown, sourceId: string) => ({
    id, kind, source_id: sourceId, actor_id: null, bell_link: null, payload, created_at: new Date('2026-11-22T20:00:00Z'), send_after: new Date('2026-11-22T20:10:00Z'),
  });

  it('tidies first: held rows older than three days are let go, and old finished rows removed', async () => {
    await processDailyDigests(NOW);
    const sqls = mockQuery.mock.calls.map(([q]) => flat(q));
    expect(sqls[0]).toMatch(/^UPDATE notification_email_outbox SET status = 'dropped', reason = 'expired' WHERE status = 'held'/);
    expect(sqls.some((s) => /^DELETE FROM notification_email_outbox/.test(s))).toBe(true);
  });

  it('is off when its admin switch is off', async () => {
    mockTypeEnabled.mockResolvedValue(false);
    expect(await processDailyDigests(NOW)).toBe(0);
    expect(mockTypeEnabled).toHaveBeenCalledWith('daily_digest');
  });

  it('claims the member\'s day, takes the rows held before it, and sends what is still unread as one email', async () => {
    dailyCandidatesRows = [{ user_id: 'ana', local_day: '2026-11-23', day_start: new Date('2026-11-23T00:00:00Z') }];
    heldRows = [held('h1', 'direct_message', { senderName: 'Bo', snippet: 'Hi', conversationId: 'c1' }, 'm1')];
    mockQuery.mockImplementationOnce(async () => ({ rows: [] })); // the tidy
    const base = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
      if (/FROM direct_messages dm JOIN dm_conversations c ON c\.id = dm\.conversation_id WHERE dm\.id = ANY/.test(flat(sql))) return { rows: [{ id: 'm1' }] };
      return base(sql, params);
    });
    expect(await processDailyDigests(NOW)).toBe(1);
    const [to, data] = mockSendDaily.mock.calls[0];
    expect(to).toBe('ana@getreason.app');
    expect(data.summary).toBe('1 new message');
    expect(data.dailyMax).toBe(3);
    const claimedRows = mockQuery.mock.calls.find(([q]) => /SET status = 'digesting'/.test(flat(q)))!;
    expect(claimedRows[1]).toEqual(['ana', new Date('2026-11-23T00:00:00Z'), NOW, 'd-1']);
  });

  it('held rows read meanwhile are let go, and with nothing left no email is sent', async () => {
    dailyCandidatesRows = [{ user_id: 'ana', local_day: '2026-11-23', day_start: new Date('2026-11-23T00:00:00Z') }];
    heldRows = [held('h1', 'direct_message', { senderName: 'Bo', snippet: 'Hi', conversationId: 'c1' }, 'm1')];
    expect(await processDailyDigests(NOW)).toBe(0);
    expect(mockSendDaily).not.toHaveBeenCalled();
    expect(settled()).toEqual(['skipped']);
  });
});

describe('the one-click unsubscribe token', () => {
  it('names the member, and only for this', () => {
    expect(readUnsubscribeToken(mintUnsubscribeToken('ana'))).toBe('ana');
  });

  it('refuses a sign-in token, a token for another purpose, a forged one and nonsense', () => {
    expect(readUnsubscribeToken(jwt.sign({ sub: 'ana' }, 'test-secret'))).toBeNull();
    expect(readUnsubscribeToken(jwt.sign({ sub: 'ana', purpose: 'google-photo' }, 'test-secret'))).toBeNull();
    expect(readUnsubscribeToken(jwt.sign({ sub: 'ana', purpose: 'weekly-digest-unsubscribe' }, 'another-secret'))).toBeNull();
    expect(readUnsubscribeToken('not a token')).toBeNull();
    expect(readUnsubscribeToken(undefined)).toBeNull();
  });

  it('an expired token is refused', () => {
    const old = jwt.sign({ sub: 'ana', purpose: 'weekly-digest-unsubscribe', exp: Math.floor(Date.now() / 1000) - 60 }, 'test-secret');
    expect(readUnsubscribeToken(old)).toBeNull();
  });

  it('the link is on the API, carrying the token', () => {
    const url = new URL(unsubscribeUrlFor('ana'));
    expect(url.origin + url.pathname).toBe('https://api.rsn.network/api/email/unsubscribe/weekly');
    expect(readUnsubscribeToken(url.searchParams.get('token'))).toBe('ana');
  });
});

describe('the weekly email\'s content', () => {
  it('names three of the requests waiting and counts the rest', () => {
    const data = weeklyEmailData('Ana', {
      waitingForYou: ['a', 'b', 'c', 'd', 'e'].map((x) => ({ userId: x, name: x.toUpperCase() })),
      sentUnanswered: 0, newConnections: [], unreadMessages: 0, oldestUnreadFrom: null, upcomingEvents: [],
      newMembers: 0, newCircles: [], people: [], profileIncomplete: false,
    }, 'https://api.rsn.network/u');
    expect(data.waitingForYou.map((w) => w.name)).toEqual(['A', 'B', 'C']);
    expect(data.waitingForYouMore).toBe(2);
  });
});

describe('the admin\'s sample', () => {
  it('weekly: built from their own account and sent to their own address, whatever the switch says', async () => {
    weeklySwitch = [{ enabled: false }];
    const result = await sendDigestSample('ana', 'weekly', NOW);
    expect(result).toEqual({ sent: true, to: 'ana@getreason.app', example: false });
    expect(mockSendWeekly).toHaveBeenCalledWith('ana@getreason.app', expect.objectContaining({ recipientName: 'Ana' }));
  });

  it('daily: with nothing of their own in the last week, an example clearly made up', async () => {
    const result = await sendDigestSample('ana', 'daily', NOW);
    expect(result.example).toBe(true);
    const data = mockSendDaily.mock.calls[0][1];
    expect(data.meetingRequests[0].name).toBe('Anna Example');
    expect(data.summary).toBe('3 new messages, 2 meeting requests, 1 accepted request and 1 invite');
  });
});
