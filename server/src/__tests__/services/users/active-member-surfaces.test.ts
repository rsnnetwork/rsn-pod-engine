// ─── Every list, count and send path says "active member" the one way (T2, 1 Nov 2026) ───────────────────────────
//
// The behaviour is proved on real Postgres by removed-members-and-event-access.sql.test.ts (opt-in: it needs a local
// database). This runs everywhere: each surface's own query is read as the service sends it, and must carry
// activeMemberSql (or the event access fragments), so a later edit cannot quietly drop it.

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: async (cb: (client: unknown) => unknown) => cb({ query: (...args: unknown[]) => mockClientQuery(...args) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../services/block/block.service', () => ({ __esModule: true, areBlocked: jest.fn(async () => false) }));

import { activeMemberSql } from '../../../services/users/active-member';
import { approvalPodOutsiderSql, visibleEventSql } from '../../../services/session/session-access';
import * as pods from '../../../services/pod/pod.service';
import * as circles from '../../../services/circle/circle.service';
import * as wall from '../../../services/circle/circle-wall.service';
import * as sessions from '../../../services/session/session.service';
import * as dm from '../../../services/dm/dm.service';

const ACTIVE = activeMemberSql('u');
const POD = '0c1d2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f';
const ME = '1d2e3f4a-5b6c-4d7e-9f80-9b0c1d2e3f4a';
const THEM = '2e3f4a5b-6c7d-4e8f-a091-ac1d2e3f4a5b';

/** Every SQL text the service sent, whitespace folded. */
const sent = (mock: jest.Mock = mockQuery) => mock.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));
const flat = (sql: string) => sql.replace(/\s+/g, ' ');

beforeEach(() => {
  mockQuery.mockReset();
  mockClientQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('pods', () => {
  it('the member list leaves out accounts that are not active', async () => {
    await pods.getPodMembers(POD);
    expect(sent()[0]).toContain(ACTIVE);
  });

  it('the pod\'s count, its director and every pods list count the same people', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: POD }] });
    await pods.getPodById(POD);
    expect(sent()[0]).toMatch(/JOIN users u ON u\.id = pm\.user_id WHERE pm\.status = 'active' AND u\.status = 'active'/);
    expect(sent()[0]).toContain(`pm.role = 'director' AND pm.status = 'active' AND ${ACTIVE}`);

    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValueOnce({ rows: [] });
    await pods.listPods({ userId: ME });
    expect(sent()[1]).toMatch(/JOIN users u ON u\.id = pm\.user_id WHERE pm\.status = 'active' AND u\.status = 'active'/);
  });

  it('the director\'s counts and the capacity check count the same people', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: '0' }] });
    await pods.getMemberStatusCounts(POD);
    expect(sent()[0]).toContain(ACTIVE);

    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ id: POD, maxMembers: 12 }] })
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ userId: ME }] });
    await pods.addMember(POD, ME);
    expect(sent(mockClientQuery)[1]).toContain(ACTIVE);
  });
});

describe('circles', () => {
  it('the members, the member counts and the events on a circle page', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: POD, name: 'C' }] });
    await circles.getCircleDetail(POD, ME, 'member');
    const [detail, members, , events, children] = sent();
    expect(detail).toContain(activeMemberSql('cm_u'));
    expect(members).toContain(ACTIVE);
    expect(events).toContain(flat(visibleEventSql('s', '$2')));
    expect(mockQuery.mock.calls[3][1]).toEqual([POD, ME, false]);
    expect(children).toContain(activeMemberSql('cm_u'));
  });

  it('an admin is named every attached pod\'s event', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: POD, name: 'C' }] });
    await circles.getCircleDetail(POD, ME, 'admin');
    expect(mockQuery.mock.calls[3][1]).toEqual([POD, ME, true]);
  });

  it('the circles list counts active members', async () => {
    await circles.listCircles(ME);
    expect(sent()[0]).toContain(activeMemberSql('cm_u'));
  });

  it('the wall keeps a former member\'s posts and comments, as "Former member"', async () => {
    await wall.listPosts(POD, ME);
    // T14: the feed first asks whether the viewer may read the wall (a closed circle's is for its members).
    expect(sent().find((s) => /author_former/.test(s))).toContain(`(NOT ${ACTIVE}) AS author_former`);
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [{ id: 'c1', author_id: THEM, display_name: 'Gone', avatar_url: 'x', author_former: true, content: 'hi', created_at: new Date() }] });
    const [comment] = await wall.listComments(POD, ME);
    expect(sent().find((s) => /author_former/.test(s))).toContain(`(NOT ${ACTIVE}) AS author_former`);
    expect(comment).toMatchObject({ authorName: 'Former member', authorAvatarUrl: null, authorClosed: true, content: 'hi' });
  });
});

describe('events', () => {
  it('the participants list and both counts leave out accounts that are not active', async () => {
    await sessions.getSessionParticipants(POD);
    expect(sent()[0]).toContain(ACTIVE);
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [{ count: '0' }] });
    await sessions.getParticipantCount(POD);
    expect(sent()[0]).toContain(ACTIVE);
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
    await sessions.getParticipantStatusCounts(POD);
    expect(sent()[1]).toContain(ACTIVE);
  });

  it('the events list for a member is the events they may open (D1)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValueOnce({ rows: [] });
    await sessions.listSessions({ userId: ME });
    expect(sent()[0]).toContain(flat(visibleEventSql('s', '$1')));
    expect(sent()[0]).not.toMatch(/invite_only/);
  });

  it('an approval pod\'s event refuses an outsider, and the registration counts only active accounts (D2)', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ id: POD, podId: POD, status: 'scheduled', config: {} }] })
      .mockResolvedValueOnce({ rows: [{ visibility: 'public_with_approval' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ outsider: true }] });
    await expect(sessions.registerParticipant(POD, ME, 'member' as never)).rejects.toMatchObject({
      statusCode: 403, message: "This event is for the pod's members. Ask to join the pod first, or ask the host for an invite.",
    });
    expect(sent(mockClientQuery)[3]).toContain(flat(approvalPodOutsiderSql('s', '$2')));
  });
});

describe('messages', () => {
  it('the inbox keeps a former member\'s conversation, as "Former member" with nothing else of theirs', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [{
        conversation_id: 'c1', other_user_id: THEM, other_display_name: 'Gone', other_avatar_url: 'a', other_job_title: 'CEO',
        other_company: 'Co', other_bio: 'Bio', other_former: true, last_message: 'Old', last_message_at: new Date(),
        last_message_from: THEM, last_attachment_type: null, last_message_kind: 'user', unread_count: '0',
      }] });
    const inbox = await dm.listConversations(ME);
    expect(sent()[1]).toContain(`(NOT ${ACTIVE}) AS other_former`);
    expect(inbox.conversations[0]).toMatchObject({
      otherUserId: THEM, otherDisplayName: 'Former member', otherAvatarUrl: null, otherJobTitle: null,
      otherCompany: null, otherBio: null, otherIsFormerMember: true, lastMessage: 'Old',
    });
  });

  it('a message to a former member is refused in words, whoever writes it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'admin', recipient_active: false }] });
    await expect(dm.sendMessage(ME, THEM, 'Hello?')).rejects.toMatchObject({
      statusCode: 403, message: 'This person is no longer a member of REASON, so they cannot get messages.',
    });
    expect(sent()[0]).toContain(activeMemberSql('r'));
    expect(mockQuery.mock.calls[0][1]).toEqual([ME, THEM]);
  });
});

describe('meeting requests', () => {
  it('cannot be sent to an account an admin removed, suspended or banned (the existence check asks for an active one)', () => {
    const { readFileSync } = jest.requireActual<typeof import('fs')>('fs');
    const { join } = jest.requireActual<typeof import('path')>('path');
    const source = readFileSync(join(__dirname, '../../../services/poke/poke.service.ts'), 'utf8');
    expect(source).toContain("`SELECT id FROM users WHERE id = $1 AND ${activeMemberSql('users')}`");
    expect(source).toContain("'That member is no longer available.'");
  });
});
