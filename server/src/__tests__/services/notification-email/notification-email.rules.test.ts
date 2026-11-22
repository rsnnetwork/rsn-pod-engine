// ─── The rules of the member notification email gate (22 Nov 2026, Stefan) ─────────────────────────────────
//
// "Only get notifications if I am not online", "max X notifications a day, and if more than X, then send a mail the
// next day", "a weekly digest". notification-email.rules.ts is pure; each rule is run here on its own.

import {
  AWAY_DELAY_MINUTES, type FlushMember, type OutboxItem, type PlannedItem, type WeeklyFacts,
  emailTypeOf, memberGetsNotificationEmails, planFlush, prefCategoryOf, sectionsOf, sendAfterFor, snippetOf,
  summaryLine, weeklyHasNews, weeklySuggestions,
} from '../../../services/notification-email/notification-email.rules';

const NOW = new Date('2026-11-22T10:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const APP = 'https://app.rsn.network';

const member = (over: Partial<FlushMember> = {}): FlushMember => ({
  eligible: true, awayOnly: true, dailyMax: 3, lastSeenAt: null, onlineNow: false, sentToday: 0, ...over,
});
const item = (id: string, over: Partial<PlannedItem> = {}): PlannedItem => ({
  id, createdAt: minutes(-11), sendAfter: minutes(-1), switchedOn: true, stillNews: true, ...over,
});

describe('who gets member notification emails at all', () => {
  const base = { email: 'ana@example.org', status: 'active', accountKind: 'member', notifyEmail: true };
  it('an active member with an address and email switched on', () => {
    expect(memberGetsNotificationEmails(base)).toBe(true);
  });
  it.each([
    ['a guest', { accountKind: 'guest' }],
    ['a suspended account', { status: 'suspended' }],
    ['a closed account', { status: 'deactivated' }],
    ['email switched off', { notifyEmail: false }],
    ['no address', { email: null }],
  ])('never %s', (_who, over) => {
    expect(memberGetsNotificationEmails({ ...base, ...over })).toBe(false);
  });
  it('nobody, when there is no account', () => {
    expect(memberGetsNotificationEmails(null)).toBe(false);
  });
});

describe('when a queued email is due', () => {
  it(`waits ${AWAY_DELAY_MINUTES} minutes while "Only email me when I'm away" is on`, () => {
    expect(sendAfterFor(NOW, true)).toEqual(minutes(AWAY_DELAY_MINUTES));
  });
  it('is due at once when it is off', () => {
    expect(sendAfterFor(NOW, false)).toEqual(NOW);
  });
});

describe('which switches each kind answers to', () => {
  it('a meeting request and its acceptance answer to the meeting request switch and the admin\'s poke switches', () => {
    expect(prefCategoryOf('meeting_request')).toBe('poke');
    expect(prefCategoryOf('meeting_accepted')).toBe('poke');
    expect(emailTypeOf('meeting_request')).toBe('poke_request');
    expect(emailTypeOf('meeting_accepted')).toBe('poke_accepted');
  });
  it('a message and an invite answer to their own switches, with no admin switch of their own', () => {
    expect(prefCategoryOf('direct_message')).toBe('dm');
    expect(prefCategoryOf('invite')).toBe('invite');
    expect(emailTypeOf('direct_message')).toBeNull();
    expect(emailTypeOf('invite')).toBeNull();
  });
});

describe('a member\'s flush', () => {
  it('does nothing until one of their rows is due', () => {
    const plan = planFlush(member(), [item('a', { sendAfter: minutes(5) }), item('b', { sendAfter: minutes(9) })], NOW);
    expect(plan.wait).toBe(true);
    expect(plan.send).toEqual([]);
  });

  it('sends everything at once when one is due, so what came in the meantime rides in the same email', () => {
    const plan = planFlush(member(), [item('a'), item('b', { createdAt: minutes(-2), sendAfter: minutes(8) })], NOW);
    expect(plan).toEqual({ wait: false, letGo: [], send: ['a', 'b'], hold: [] });
  });

  it('lets go of what the member saw by being on REASON after it happened', () => {
    const plan = planFlush(member({ lastSeenAt: minutes(-5) }), [item('old', { createdAt: minutes(-11) }), item('new', { createdAt: minutes(-3) })], NOW);
    expect(plan.letGo).toEqual([{ id: 'old', reason: 'seen' }]);
    expect(plan.send).toEqual(['new']);
  });

  it('lets go of everything while the member is online right now', () => {
    const plan = planFlush(member({ onlineNow: true }), [item('a'), item('b')], NOW);
    expect(plan.letGo.map((l) => l.reason)).toEqual(['seen', 'seen']);
    expect(plan.send).toEqual([]);
  });

  it('with "only when I\'m away" off, being on REASON does not stop it', () => {
    const plan = planFlush(member({ awayOnly: false, onlineNow: true, lastSeenAt: NOW }), [item('a')], NOW);
    expect(plan.send).toEqual(['a']);
  });

  it('lets go of what was read or answered meanwhile, and what a switch now turns off', () => {
    const plan = planFlush(member(), [item('read', { stillNews: false }), item('off', { switchedOn: false }), item('news')], NOW);
    expect(plan.letGo).toEqual([{ id: 'read', reason: 'read' }, { id: 'off', reason: 'switched_off' }]);
    expect(plan.send).toEqual(['news']);
  });

  it('lets go of everything for a member who no longer gets these emails', () => {
    const plan = planFlush(member({ eligible: false }), [item('a'), item('b')], NOW);
    expect(plan.letGo).toEqual([{ id: 'a', reason: 'not_eligible' }, { id: 'b', reason: 'not_eligible' }]);
  });

  it.each([
    [1, 0, 'send'], [1, 1, 'hold'], [3, 2, 'send'], [3, 3, 'hold'], [3, 7, 'hold'], [10, 9, 'send'], [10, 10, 'hold'],
  ])('with at most %i a day and %i sent today: %s', (dailyMax, sentToday, expected) => {
    const plan = planFlush(member({ dailyMax, sentToday }), [item('a'), item('b')], NOW);
    expect(expected === 'send' ? plan.send : plan.hold).toEqual(['a', 'b']);
    expect(expected === 'send' ? plan.hold : plan.send).toEqual([]);
  });

  it('nothing left to send uses none of the day\'s emails', () => {
    const plan = planFlush(member({ sentToday: 3 }), [item('a', { stillNews: false })], NOW);
    expect(plan.hold).toEqual([]);
    expect(plan.send).toEqual([]);
  });
});

describe('what the email says', () => {
  it.each([
    [{ meetingRequests: 0, acceptances: 0, messages: 1, invites: 0 }, '1 new message'],
    [{ meetingRequests: 1, acceptances: 0, messages: 3, invites: 0 }, '3 new messages and 1 meeting request'],
    [{ meetingRequests: 2, acceptances: 1, messages: 2, invites: 1 }, '2 new messages, 2 meeting requests, 1 accepted request and 1 invite'],
    [{ meetingRequests: 0, acceptances: 0, messages: 0, invites: 2 }, '2 invites'],
    [{ meetingRequests: 0, acceptances: 0, messages: 0, invites: 0 }, 'nothing new'],
  ])('%o reads "%s"', (counts, line) => {
    expect(summaryLine(counts)).toBe(line);
  });

  const at = (m: number) => minutes(m);
  const items: OutboxItem[] = [
    { id: '1', sourceId: 'm1', actorId: 'bo', createdAt: at(-9), sendAfter: at(1), kind: 'direct_message', payload: { senderName: 'Bo', snippet: 'Hi', conversationId: 'c1' } },
    { id: '2', sourceId: 'p1', actorId: 'fa', createdAt: at(-8), sendAfter: at(2), kind: 'meeting_request', payload: { senderName: 'Fatima', note: 'Coffee?', reasonLine: null } },
    { id: '3', sourceId: 'm2', actorId: 'bo', createdAt: at(-7), sendAfter: at(3), kind: 'direct_message', payload: { senderName: 'Bo', snippet: 'Thursday works', conversationId: 'c1' } },
    { id: '4', sourceId: 'm3', actorId: 'cl', createdAt: at(-6), sendAfter: at(4), kind: 'direct_message', payload: { senderName: 'Clara', snippet: 'Hello', conversationId: 'c2' } },
    { id: '5', sourceId: 'p2', actorId: 'da', createdAt: at(-5), sendAfter: at(5), kind: 'meeting_accepted', payload: { accepterName: 'David', conversationId: 'c3' } },
    { id: '6', sourceId: 'i1', actorId: 'st', createdAt: at(-4), sendAfter: at(6), kind: 'invite', payload: {
      inviterId: 'st', inviterName: 'Stefan', inviteType: 'session', targetName: 'Founders breakfast', code: 'ABC',
      podId: null, sessionId: 's1', circleId: null,
    } },
  ];

  it('groups them: requests, acceptances, one line per conversation with its count and latest words, invites', () => {
    const { sections, counts } = sectionsOf(items, APP);
    expect(counts).toEqual({ meetingRequests: 1, acceptances: 1, messages: 3, invites: 1 });
    expect(sections.messages).toEqual([
      { name: 'Bo', count: 2, snippet: 'Thursday works', url: `${APP}/messages/c1` },
      { name: 'Clara', count: 1, snippet: 'Hello', url: `${APP}/messages/c2` },
    ]);
    expect(sections.meetingRequests).toEqual([{ name: 'Fatima', note: 'Coffee?', url: `${APP}/messages` }]);
    expect(sections.acceptances).toEqual([{ name: 'David', url: `${APP}/messages/c3` }]);
    expect(sections.invites).toEqual([{ inviterName: 'Stefan', targetName: 'Founders breakfast', what: 'event', url: `${APP}/invite/ABC` }]);
  });

  it('keeps the order things happened in, whatever order they were read back in', () => {
    const { sections } = sectionsOf([...items].reverse(), APP);
    expect(sections.messages.map((m) => m.name)).toEqual(['Bo', 'Clara']);
    expect(sections.messages[0].snippet).toBe('Thursday works');
  });

  it('a message\'s first words: one line, at most 200 characters, and a photo or voice message described', () => {
    expect(snippetOf('  Hello\n\nthere  ')).toBe('Hello there');
    expect(snippetOf('x'.repeat(300))).toHaveLength(200);
    expect(snippetOf(null, 'image')).toBe('Sent you a photo');
    expect(snippetOf('', 'audio')).toBe('Sent you a voice message');
    expect(snippetOf(undefined)).toBe('New message');
  });
});

describe('the weekly digest', () => {
  const quiet: WeeklyFacts = {
    waitingForYou: [], sentUnanswered: 0, newConnections: [], unreadMessages: 0, oldestUnreadFrom: null,
    upcomingEvents: [], newMembers: 0, newCircles: [], people: [], profileIncomplete: false,
  };

  it('is not sent for a week with nothing to say, even with new members on the platform', () => {
    expect(weeklyHasNews(quiet)).toBe(false);
    expect(weeklyHasNews({ ...quiet, newMembers: 12 })).toBe(false);
  });

  it.each([
    ['a request waiting for them', { waitingForYou: [{ userId: 'u1', name: 'Anna' }] }],
    ['their own requests unanswered', { sentUnanswered: 2 }],
    ['a new connection', { newConnections: [{ userId: 'u2', name: 'Bo', conversationId: 'c1' }] }],
    ['an unread message', { unreadMessages: 1 }],
    ['an event coming up', { upcomingEvents: [{ id: 's1', title: 'Breakfast', when: 'Tue', going: false }] }],
    ['a new circle', { newCircles: [{ id: 'c1', name: 'Nordic' }] }],
    ['someone to meet', { people: [{ userId: 'u3', name: 'Clara', line: null }] }],
  ])('is sent for %s', (_what, over) => {
    expect(weeklyHasNews({ ...quiet, ...over })).toBe(true);
  });

  it('suggests answering the person who asked first, then the oldest unread message, at most two', () => {
    const s = weeklySuggestions({
      ...quiet,
      waitingForYou: [{ userId: 'u1', name: 'Anna Berg' }],
      oldestUnreadFrom: { name: 'Bo Lind', conversationId: 'c7' },
      upcomingEvents: [{ id: 's1', title: 'Founders breakfast', when: 'Tue', going: false }],
      profileIncomplete: true,
    }, APP);
    expect(s).toEqual([
      { text: 'Reply to Anna', url: `${APP}/messages` },
      { text: 'Reply to Bo', url: `${APP}/messages/c7` },
    ]);
  });

  it('suggests the next event they are not going to yet, and completing their profile', () => {
    const s = weeklySuggestions({
      ...quiet,
      upcomingEvents: [
        { id: 's1', title: 'Going already', when: 'Mon', going: true },
        { id: 's2', title: 'Founders breakfast', when: 'Tue', going: false },
      ],
      profileIncomplete: true,
    }, APP);
    expect(s).toEqual([
      { text: 'Join Founders breakfast', url: `${APP}/sessions/s2` },
      { text: 'Complete your profile', url: `${APP}/profile/edit` },
    ]);
  });

  it('does not tell them to reply to the same person twice', () => {
    const s = weeklySuggestions({
      ...quiet, waitingForYou: [{ userId: 'u1', name: 'Anna' }], oldestUnreadFrom: { name: 'Anna', conversationId: 'c1' },
    }, APP);
    expect(s).toEqual([{ text: 'Reply to Anna', url: `${APP}/messages` }]);
  });
});
