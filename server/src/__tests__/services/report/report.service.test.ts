// ─── User reports (report → admin moderation queue) ─────────────────────────
//
// 8 Sep 2026 (Ali): a report filed from a chat carries the conversation so
// admins can review the messages behind it — but only if the reporter is
// actually in that conversation (no spoofing another chat's id).
//
// 11 Nov 2026 (Shirley Palmer's item 16): a report names a member, one direct message or one wall post. For a message
// or post the member reported is its author (never the client's word), the reporter must be able to see it now, and a
// copy of its words is kept, so the evidence outlives a delete. Nobody reports themselves or their own words, and the
// same report within 24 hours is "You already reported this.", decided under a lock on that reporter and target.

const mockQuery = jest.fn<any, any[]>();
const mockTxSql: string[] = [];
const mockPodPost = jest.fn();
const mockCirclePost = jest.fn();
const mockEventChatAccess = jest.fn();
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => { mockTxSql.push(String(a[0])); return mockQuery(...a); } }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/pod/pod-wall.service', () => ({ __esModule: true, getPost: (...a: unknown[]) => mockPodPost(...a) }));
jest.mock('../../../services/circle/circle-wall.service', () => ({ __esModule: true, getPost: (...a: unknown[]) => mockCirclePost(...a) }));
jest.mock('../../../services/event-chat/event-chat.service', () => ({ __esModule: true, canReadEventChat: (...a: unknown[]) => mockEventChatAccess(...a) }));

import { ForbiddenError } from '../../../middleware/errors';
import { EXCERPT_MAX, REPORT_WORDS, excerptOf, submitReport } from '../../../services/report/report.service';

const REPORTER = 'u-reporter';
const REPORTED = 'u-reported';
const CONV = 'conv-1';
const MSG = 'msg-1';
const POST = 'post-1';
const me = { userId: REPORTER, role: 'member' };

interface World {
  earlier?: boolean;
  member?: boolean;
  conversation?: boolean;
  message?: { from_user_id: string; content: string | null; kind?: string | null; attachment_type?: string | null; attachment_url?: string | null } | null;
  podPostOf?: string | null;
  /** Fix round 1: a wall comment (with its post's wall), a group message, an event chat message. */
  podComment?: { author_id: string; content: string } | null;
  circleComment?: { author_id: string; content: string } | null;
  groupMessage?: { from_user_id: string; content: string; kind?: string } | null;
  eventMessage?: { sender_id: string | null; content: string; scope: 'lobby' | 'room'; audience_ids?: string[] | null } | null;
}

/** The database as each statement finds it. */
function arm(w: World = {}) {
  mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
    const s = String(sql).replace(/\s+/g, ' ');
    if (/pg_advisory_xact_lock/.test(s)) return Promise.resolve({ rows: [{}] });
    if (/SELECT 1 FROM user_reports/.test(s)) return Promise.resolve({ rows: w.earlier ? [{ '?column?': 1 }] : [] });
    if (/SELECT id FROM users WHERE id/.test(s)) return Promise.resolve({ rows: w.member === false ? [] : [{ id: params?.[0] }] });
    if (/FROM dm_conversations WHERE id/.test(s)) return Promise.resolve({ rows: w.conversation ? [{ id: CONV }] : [] });
    if (/FROM direct_messages m JOIN dm_conversations c/.test(s)) {
      return Promise.resolve({ rows: w.message ? [{ conversation_id: CONV, kind: 'user', attachment_type: null, attachment_url: null, ...w.message }] : [] });
    }
    if (/SELECT pod_id FROM pod_posts/.test(s)) return Promise.resolve({ rows: w.podPostOf ? [{ pod_id: w.podPostOf }] : [] });
    if (/FROM pod_post_comments c JOIN pod_posts p/.test(s)) return Promise.resolve({ rows: w.podComment ? [{ ...w.podComment, post_id: 'post-9', pod_id: 'pod-9' }] : [] });
    if (/FROM circle_post_comments c JOIN circle_posts p/.test(s)) return Promise.resolve({ rows: w.circleComment ? [{ ...w.circleComment, post_id: 'post-8' }] : [] });
    if (/JOIN dm_group_members gm/.test(s)) {
      return Promise.resolve({ rows: w.groupMessage ? [{ kind: 'user', attachment_type: null, attachment_url: null, ...w.groupMessage }] : [] });
    }
    if (/FROM event_chat_messages/.test(s)) {
      return Promise.resolve({ rows: w.eventMessage ? [{ session_id: 'ev-1', audience_ids: null, ...w.eventMessage }] : [] });
    }
    if (/INSERT INTO user_reports/.test(s)) {
      return Promise.resolve({ rows: [{
        id: 'rep-1', reporter_id: params?.[1], reported_id: params?.[2], reason: params?.[3], description: params?.[4],
        status: 'open', resolved_by: null, resolved_at: null, resolution_notes: null, created_at: new Date(),
        subject_kind: params?.[6], subject_id: params?.[7],
      }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

const insert = () => mockQuery.mock.calls.find((c) => /INSERT INTO user_reports/.test(String(c[0])));
const inserted = () => insert()![1] as unknown[];

beforeEach(() => {
  mockQuery.mockReset();
  mockTxSql.length = 0;
  mockPodPost.mockReset();
  mockCirclePost.mockReset();
  mockEventChatAccess.mockReset().mockResolvedValue('all');
  arm();
});

describe('a member', () => {
  it('cannot be reported by themselves (refused before anything is read or written)', async () => {
    await expect(submitReport(me, { reportedId: REPORTER, reason: 'spam' })).rejects.toMatchObject({ statusCode: 400, message: REPORT_WORDS.self });
    expect(insert()).toBeUndefined();
  });

  it('stores the conversation when the reporter is part of it', async () => {
    arm({ conversation: true });
    await submitReport(me, { reportedId: REPORTED, reason: 'spam', description: 'bad', conversationId: CONV });
    expect(String(insert()![0])).toMatch(/conversation_id/);
    expect(inserted()[5]).toBe(CONV);
    expect(inserted().slice(6)).toEqual([null, null, null]); // no message or post named
  });

  it('drops a conversation id the reporter does NOT belong to (no spoofing)', async () => {
    arm({ conversation: false });
    await submitReport(me, { reportedId: REPORTED, reason: 'spam', conversationId: 'someone-elses-conv' });
    expect(inserted()[5]).toBeNull();
  });

  it('stores null conversation when reported from a profile (no conversation id)', async () => {
    await submitReport(me, { reportedId: REPORTED, reason: 'spam' });
    expect(mockQuery.mock.calls.find((c) => /FROM dm_conversations WHERE id/.test(String(c[0])))).toBeUndefined();
    expect(inserted()[5]).toBeNull();
  });

  it('who does not exist is a 404', async () => {
    arm({ member: false });
    await expect(submitReport(me, { reportedId: REPORTED, reason: 'spam' })).rejects.toMatchObject({ statusCode: 404 });
    expect(insert()).toBeUndefined();
  });

  it('reported again within 24 hours is "You already reported this." (409), checked under a lock, and nothing is written', async () => {
    arm({ earlier: true });
    await expect(submitReport(me, { reportedId: REPORTED, reason: 'harassment' })).rejects.toMatchObject({
      statusCode: 409, code: 'REPORT_ALREADY_SENT', message: 'You already reported this.',
    });
    expect(insert()).toBeUndefined();
    const lock = mockQuery.mock.calls.find((c) => /pg_advisory_xact_lock/.test(String(c[0])))!;
    expect(lock[1]).toEqual([`report:${REPORTER}:member:${REPORTED}`]);
    const check = mockQuery.mock.calls.find((c) => /SELECT 1 FROM user_reports/.test(String(c[0])))!;
    expect(String(check[0]).replace(/\s+/g, ' ')).toContain('WHERE reporter_id = $1 AND reported_id = $2 AND subject_id IS NULL AND created_at > NOW() - ($3::int * INTERVAL \'1 hour\')');
    expect(check[1]).toEqual([REPORTER, REPORTED, 24]);
  });

  it('the lock, the check and the write are one transaction, in that order', async () => {
    await submitReport(me, { reportedId: REPORTED, reason: 'spam' });
    const order = mockTxSql.map((s) => (/pg_advisory/.test(s) ? 'lock' : /SELECT 1 FROM user_reports/.test(s) ? 'check' : /INSERT INTO user_reports/.test(s) ? 'insert' : s));
    expect(order).toEqual(['lock', 'check', 'insert']);
  });

  it('an unknown reason is refused', async () => {
    await expect(submitReport(me, { reportedId: REPORTED, reason: 'nonsense' as never })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a report naming nobody and nothing is refused', async () => {
    await expect(submitReport(me, { reason: 'spam' })).rejects.toMatchObject({ statusCode: 400, message: REPORT_WORDS.noTarget });
  });
});

describe('a message', () => {
  it('reports its author, whatever the client sent, with a copy of its words and its conversation', async () => {
    arm({ message: { from_user_id: REPORTED, content: '  You will regret this.  ' } });
    await submitReport(me, { reportedId: 'u-someone-else', reason: 'harassment', subject: { kind: 'dm_message', id: MSG } });
    const read = mockQuery.mock.calls.find((c) => /FROM direct_messages m JOIN dm_conversations c/.test(String(c[0]).replace(/\s+/g, ' ')))!;
    expect(String(read[0])).toMatch(/WHERE m\.id = \$1 AND \(c\.user_a_id = \$2 OR c\.user_b_id = \$2\)/);
    expect(read[1]).toEqual([MSG, REPORTER]);
    const row = inserted();
    expect(row[2]).toBe(REPORTED);
    expect(row[5]).toBe(CONV);
    expect(row.slice(6)).toEqual(['dm_message', MSG, 'You will regret this.']);
  });

  it('a voice note or a picture is kept as its address', async () => {
    arm({ message: { from_user_id: REPORTED, content: null, attachment_type: 'audio', attachment_url: 'https://res.cloudinary.com/x/v.webm' } });
    await submitReport(me, { reason: 'harassment', subject: { kind: 'dm_message', id: MSG } });
    expect(inserted()[8]).toBe('[Voice message] https://res.cloudinary.com/x/v.webm');
  });

  it('in a chat the reporter is not part of (or gone, or a group message) is "no longer there", nothing written', async () => {
    arm({ message: null });
    await expect(submitReport(me, { reason: 'spam', subject: { kind: 'dm_message', id: MSG } })).rejects.toMatchObject({
      statusCode: 404, message: REPORT_WORDS.messageGone,
    });
    expect(insert()).toBeUndefined();
  });

  it('of the reporter\'s own is refused', async () => {
    arm({ message: { from_user_id: REPORTER, content: 'mine' } });
    await expect(submitReport(me, { reason: 'spam', subject: { kind: 'dm_message', id: MSG } })).rejects.toMatchObject({
      statusCode: 400, message: REPORT_WORDS.ownMessage,
    });
  });

  it('REASON\'s own cards cannot be reported', async () => {
    arm({ message: { from_user_id: REPORTED, content: 'Meeting confirmed', kind: 'system' } });
    await expect(submitReport(me, { reason: 'spam', subject: { kind: 'dm_message', id: MSG } })).rejects.toMatchObject({
      statusCode: 400, message: REPORT_WORDS.systemMessage,
    });
  });

  it('reported again within 24 hours is refused, counted by the message itself', async () => {
    arm({ message: { from_user_id: REPORTED, content: 'x' }, earlier: true });
    await expect(submitReport(me, { reason: 'spam', subject: { kind: 'dm_message', id: MSG } })).rejects.toMatchObject({ statusCode: 409 });
    const check = mockQuery.mock.calls.find((c) => /SELECT 1 FROM user_reports/.test(String(c[0])))!;
    expect(String(check[0]).replace(/\s+/g, ' ')).toContain('WHERE reporter_id = $1 AND subject_kind = $2 AND subject_id = $3');
    expect(check[1]).toEqual([REPORTER, 'dm_message', MSG, 24]);
    const lock = mockQuery.mock.calls.find((c) => /pg_advisory_xact_lock/.test(String(c[0])))!;
    expect(lock[1]).toEqual([`report:${REPORTER}:dm_message:${MSG}`]);
  });

  it('from someone the reporter blocked can still be reported: no block is asked', async () => {
    arm({ message: { from_user_id: REPORTED, content: 'x' } });
    await submitReport(me, { reason: 'safety', subject: { kind: 'dm_message', id: MSG } });
    expect(mockQuery.mock.calls.some((c) => /user_blocks/.test(String(c[0])))).toBe(false);
    expect(insert()).toBeDefined();
  });

  it('a copy longer than 2000 characters is cut to 2000', async () => {
    arm({ message: { from_user_id: REPORTED, content: 'a'.repeat(5000) } });
    await submitReport(me, { reason: 'spam', subject: { kind: 'dm_message', id: MSG } });
    expect((inserted()[8] as string).length).toBe(EXCERPT_MAX);
  });
});

describe('a wall post', () => {
  const podPost = (authorId: string) => ({ id: POST, podId: 'pod-1', authorId, content: 'Buy my course', media: [{ type: 'image', url: 'https://img/1.png' }] });

  it('on a pod is read through the pod wall (who may read it decides), and reports its author with its words and pictures', async () => {
    arm({ podPostOf: 'pod-1' });
    mockPodPost.mockResolvedValue(podPost(REPORTED));
    await submitReport({ userId: REPORTER, role: 'member' }, { reason: 'spam', subject: { kind: 'pod_post', id: POST } });
    expect(mockPodPost).toHaveBeenCalledWith('pod-1', POST, { userId: REPORTER, role: 'member' });
    const row = inserted();
    expect(row[2]).toBe(REPORTED);
    expect(row[5]).toBeNull();
    expect(row.slice(6)).toEqual(['pod_post', POST, 'Buy my course\n[Photo] https://img/1.png']);
  });

  it('on a pod the reporter was removed from is refused by the wall, and nothing is written', async () => {
    arm({ podPostOf: 'pod-1' });
    mockPodPost.mockRejectedValue(new ForbiddenError('Join the pod to read its discussion.'));
    await expect(submitReport(me, { reason: 'spam', subject: { kind: 'pod_post', id: POST } })).rejects.toMatchObject({ statusCode: 403 });
    expect(insert()).toBeUndefined();
  });

  it('that was deleted is "no longer there"', async () => {
    arm({ podPostOf: null });
    await expect(submitReport(me, { reason: 'spam', subject: { kind: 'pod_post', id: POST } })).rejects.toMatchObject({
      statusCode: 404, message: REPORT_WORDS.postGone,
    });
    expect(mockPodPost).not.toHaveBeenCalled();
  });

  it('of the reporter\'s own is refused', async () => {
    arm({ podPostOf: 'pod-1' });
    mockPodPost.mockResolvedValue(podPost(REPORTER));
    await expect(submitReport(me, { reason: 'spam', subject: { kind: 'pod_post', id: POST } })).rejects.toMatchObject({
      statusCode: 400, message: REPORT_WORDS.ownPost,
    });
  });

  it('on a circle is read through the circle wall; one it hides (gone or blocked) is "no longer there"', async () => {
    mockCirclePost.mockResolvedValue(null);
    await expect(submitReport(me, { reason: 'spam', subject: { kind: 'circle_post', id: POST } })).rejects.toMatchObject({ statusCode: 404 });
    expect(mockCirclePost).toHaveBeenCalledWith(POST, REPORTER, 'member');
    mockCirclePost.mockResolvedValue({ id: POST, circleId: 'c-1', authorId: REPORTED, content: 'hello', media: [] });
    await submitReport(me, { reason: 'other', subject: { kind: 'circle_post', id: POST } });
    expect(inserted().slice(6)).toEqual(['circle_post', POST, 'hello']);
  });
});

describe('excerptOf', () => {
  it('joins the words and each attachment, trimmed, and never more than 2000 characters', () => {
    expect(excerptOf('  hi  ', [{ label: 'Photo', url: 'u' }])).toBe('hi\n[Photo] u');
    expect(excerptOf(null)).toBe('');
    expect(excerptOf('x'.repeat(3000)).length).toBe(2000);
  });
});

// ── Fix round 1 (controller ruling): comments on both walls, group chat and event chat messages ─────────────────────
describe('a wall comment, a group message, an event chat message', () => {
  const wordsOf = (kind: string) => (kind.endsWith('comment') ? REPORT_WORDS.ownComment : REPORT_WORDS.ownMessage);
  const kinds = [
    {
      kind: 'pod_comment' as const,
      visible: () => { arm({ podComment: { author_id: REPORTED, content: 'Nasty reply' } }); mockPodPost.mockResolvedValue({ id: 'post-9' }); },
      hidden: () => { arm({ podComment: { author_id: REPORTED, content: 'Nasty reply' } }); mockPodPost.mockRejectedValue(new ForbiddenError('Join the pod')); },
      gone: () => arm({ podComment: null }),
      own: () => { arm({ podComment: { author_id: REPORTER, content: 'mine' } }); mockPodPost.mockResolvedValue({ id: 'post-9' }); },
      readsThroughTheWall: () => expect(mockPodPost).toHaveBeenCalledWith('pod-9', 'post-9', { userId: REPORTER, role: 'member' }),
    },
    {
      kind: 'circle_comment' as const,
      visible: () => { arm({ circleComment: { author_id: REPORTED, content: 'Nasty reply' } }); mockCirclePost.mockResolvedValue({ id: 'post-8' }); },
      hidden: () => { arm({ circleComment: { author_id: REPORTED, content: 'Nasty reply' } }); mockCirclePost.mockResolvedValue(null); },
      gone: () => arm({ circleComment: null }),
      own: () => { arm({ circleComment: { author_id: REPORTER, content: 'mine' } }); mockCirclePost.mockResolvedValue({ id: 'post-8' }); },
      readsThroughTheWall: () => expect(mockCirclePost).toHaveBeenCalledWith('post-8', REPORTER, 'member'),
    },
    {
      kind: 'group_message' as const,
      visible: () => arm({ groupMessage: { from_user_id: REPORTED, content: 'Nasty reply' } }),
      // The read joins the reporter's own membership: someone who left (or was never in it) finds nothing.
      hidden: () => arm({ groupMessage: null }),
      gone: () => arm({ groupMessage: null }),
      own: () => arm({ groupMessage: { from_user_id: REPORTER, content: 'mine' } }),
      readsThroughTheWall: () => {
        const read = mockQuery.mock.calls.find((c) => /JOIN dm_group_members gm/.test(String(c[0])))!;
        // Only what the group's own read shows them: messages written since they joined (fix round 2).
        expect(String(read[0]).replace(/\s+/g, ' ')).toContain('JOIN dm_group_members gm ON gm.group_id = m.group_id AND gm.user_id = $2 WHERE m.id = $1 AND m.group_id IS NOT NULL AND m.created_at >= gm.joined_at');
      },
    },
    {
      kind: 'event_chat_message' as const,
      visible: () => arm({ eventMessage: { sender_id: REPORTED, content: 'Nasty reply', scope: 'lobby' } }),
      hidden: () => { arm({ eventMessage: { sender_id: REPORTED, content: 'Nasty reply', scope: 'lobby' } }); mockEventChatAccess.mockResolvedValue(null); },
      gone: () => arm({ eventMessage: null }),
      own: () => arm({ eventMessage: { sender_id: REPORTER, content: 'mine', scope: 'lobby' } }),
      // The room's own chat rule (fix round 2): someone registered and in the room before the start reads its lobby.
      readsThroughTheWall: () => expect(mockEventChatAccess).toHaveBeenCalledWith(REPORTER, 'member', 'ev-1', { inSessionRoom: true }),
    },
  ];

  describe.each(kinds)('$kind', (k) => {
    it('one the reporter can see is filed against its author, with a copy of its words', async () => {
      k.visible();
      await submitReport(me, { reportedId: 'u-someone-else', reason: 'harassment', subject: { kind: k.kind, id: 'x-1' } });
      k.readsThroughTheWall();
      const row = inserted();
      expect(row[2]).toBe(REPORTED);
      expect(row.slice(6)).toEqual([k.kind, 'x-1', 'Nasty reply']);
    });

    it('one the reporter cannot see (no longer a member, removed, not invited) is refused, nothing written', async () => {
      k.hidden();
      await expect(submitReport(me, { reason: 'spam', subject: { kind: k.kind, id: 'x-1' } })).rejects.toMatchObject({ statusCode: expect.any(Number) });
      expect(insert()).toBeUndefined();
    });

    it('one that is gone is "no longer there"', async () => {
      k.gone();
      await expect(submitReport(me, { reason: 'spam', subject: { kind: k.kind, id: 'x-1' } })).rejects.toMatchObject({ statusCode: 404 });
    });

    it("the reporter's own words are refused", async () => {
      k.own();
      await expect(submitReport(me, { reason: 'spam', subject: { kind: k.kind, id: 'x-1' } })).rejects.toMatchObject({
        statusCode: 400, message: wordsOf(k.kind),
      });
    });

    it('reported again within a day: "You already reported this.", locked and counted by the item itself', async () => {
      k.visible();
      arm({ ...(k.kind === 'pod_comment' ? { podComment: { author_id: REPORTED, content: 'x' } } : {}),
        ...(k.kind === 'circle_comment' ? { circleComment: { author_id: REPORTED, content: 'x' } } : {}),
        ...(k.kind === 'group_message' ? { groupMessage: { from_user_id: REPORTED, content: 'x' } } : {}),
        ...(k.kind === 'event_chat_message' ? { eventMessage: { sender_id: REPORTED, content: 'x', scope: 'lobby' as const } } : {}),
        earlier: true });
      await expect(submitReport(me, { reason: 'spam', subject: { kind: k.kind, id: 'x-1' } })).rejects.toMatchObject({ statusCode: 409, message: REPORT_WORDS.already });
      expect(mockQuery.mock.calls.find((c) => /pg_advisory_xact_lock/.test(String(c[0])))![1]).toEqual([`report:${REPORTER}:${k.kind}:x-1`]);
      expect(insert()).toBeUndefined();
    });
  });

  it("a group chat's REASON line cannot be reported", async () => {
    arm({ groupMessage: { from_user_id: REPORTED, content: 'Ana joined', kind: 'system' } });
    await expect(submitReport(me, { reason: 'spam', subject: { kind: 'group_message', id: 'x-1' } })).rejects.toMatchObject({
      statusCode: 400, message: REPORT_WORDS.systemMessage,
    });
  });

  it("an event's breakout room message only by the people it was for", async () => {
    arm({ eventMessage: { sender_id: REPORTED, content: 'room words', scope: 'room', audience_ids: [REPORTED, 'u-other'] } });
    await expect(submitReport(me, { reason: 'spam', subject: { kind: 'event_chat_message', id: 'x-1' } })).rejects.toMatchObject({ statusCode: 404 });
    arm({ eventMessage: { sender_id: REPORTED, content: 'room words', scope: 'room', audience_ids: [REPORTED, REPORTER] } });
    await submitReport(me, { reason: 'spam', subject: { kind: 'event_chat_message', id: 'x-1' } });
    expect(inserted()[8]).toBe('room words');
  });

  // Fix round 2 (I-1): before the event starts, a registered member in its room has no joined_at yet; the room's own
  // chat rule (inSessionRoom) lets them read the lobby, so the report rule must too. Someone with no place still can't.
  it('a registered member in the room before the start can report a lobby message; someone with no place cannot', async () => {
    const roomRule = (registered: boolean) => (_u: string, _r: string, _s: string, opts?: { inSessionRoom?: boolean }) =>
      Promise.resolve(registered && opts?.inSessionRoom ? 'all' : null);
    arm({ eventMessage: { sender_id: REPORTED, content: 'Lobby words', scope: 'lobby' } });
    mockEventChatAccess.mockImplementation(roomRule(true));
    await submitReport(me, { reason: 'harassment', subject: { kind: 'event_chat_message', id: 'x-1' } });
    expect(inserted().slice(6)).toEqual(['event_chat_message', 'x-1', 'Lobby words']);
    arm({ eventMessage: { sender_id: REPORTED, content: 'Lobby words', scope: 'lobby' } });
    mockEventChatAccess.mockImplementation(roomRule(false));
    await expect(submitReport(me, { reason: 'harassment', subject: { kind: 'event_chat_message', id: 'x-1' } })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("an event chat message whose sender's account is gone is \"no longer there\"", async () => {
    arm({ eventMessage: { sender_id: null, content: 'x', scope: 'lobby' } });
    await expect(submitReport(me, { reason: 'spam', subject: { kind: 'event_chat_message', id: 'x-1' } })).rejects.toMatchObject({ statusCode: 404 });
  });
});
