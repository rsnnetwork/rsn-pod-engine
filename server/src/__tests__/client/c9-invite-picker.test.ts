// ─── Inviting people from your connections (26 Oct 2026, C9, POD-02 and the invites half of POD-04) ───
//
// 25 Oct walkthrough: Stefan, inviting to a pod: "I should be able to see all the users I'm friends with. I may have
// 400 friends. I can't remember that he's called Claus." He invited by typed email. Claus, on the event page, closed
// the invite modal to see whether it had worked ("it greys out"), because the result only showed behind it.
//
// Now one sheet (the REASON Sheet) on the pod page ("Invite members") and the event page ("Invite people", and open
// on arrival with ?invite=1): your connections a page of 30 at a time with "Show more", searched by name, role or
// company; chosen people as chips that stay across searches and fold into "+N"; a sticky "Send {n} invites"; rows
// that say Member, Going, Invited or Declined and cannot be picked again; results drawn in place while the sheet stays
// open, closed with "Done"; "Invite by email" and "Share a link" with the link's real cap; on an event, its pod's
// members ("This pod ({n})") with "Invite everyone in {pod} ({n})". Beside it, an always-visible list of who is
// invited and who declined, for the people who run the pod or event.
//
// The pure parts (what the picker says and decides) are run here; the wiring is pinned by its source.

import * as fs from 'fs';
import * as path from 'path';
import type { InviteBatchResponse, InviteCandidate } from '@rsn/shared';
import {
  BATCH_MAX, CHIPS_SHOWN, CONNECTIONS_PAGE, DONE, INVITE_BY_EMAIL, LINK_CAP_DEFAULT, POD_PAGE, POD_PAGES_MAX,
  SEARCH_PLACEHOLDER, SHARE_A_LINK, SHOW_MORE, YOUR_CONNECTIONS,
  batchBody, batchSentence, candidateEntities, candidateParams, canPick, chipsView, countLabel, effectiveState,
  emailInviteBody, emailSchema, everyoneOnce, inviteErrorSentence, inviteEveryoneLabel, linkBody, linkCap,
  people, pickerTitle, podSegmentLabel, sendLabel, shareLinkNote, stateAfter, stateLabel, targetTags,
  type InviteTarget,
} from '../../../../client/src/features/invites/invite-picker';
import {
  REMIND_GAP_MS, STATUS_TITLE, WITHDRAW_CONFIRM,
  inviteStatusGroups, personLine, remindAllSentence, remindSentence, settleInTurn, statusSummary, tallyReminders,
  type InviteListRow,
} from '../../../../client/src/features/invites/invite-status';
import { CONNECTION_LOST } from '../../../../client/src/features/reason/errors';

const SRC = path.join(__dirname, '../../../../client/src');
const exists = (rel: string) => fs.existsSync(path.join(SRC, rel));
// A file that is not there reads as empty, so each test that needs it fails on its own expectations.
const read = (rel: string) => (exists(rel) ? fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n') : '');

const POD: InviteTarget = { type: 'pod', podId: 'p1' };
const EVENT: InviteTarget = { type: 'session', sessionId: 's1', podId: 'p1' };

const candidate = (userId: string, state: InviteCandidate['state'] = 'available'): InviteCandidate => ({
  userId, displayName: `Person ${userId}`, avatarUrl: null, jobTitle: null, company: null, how: 'connected', since: '2026-10-26T10:00:00.000Z', state,
});

const counts = (over: Partial<InviteBatchResponse['counts']> = {}): InviteBatchResponse['counts'] => ({
  invited: 0, already_member: 0, already_going: 0, already_invited: 0, declined: 0, not_allowed: 0, failed: 0, ...over,
});
const answer = (over: Partial<InviteBatchResponse['counts']>, remaining?: number): InviteBatchResponse => {
  const c = counts(over);
  const results = Object.entries(c).flatMap(([outcome, n]) =>
    Array.from({ length: n }, (_v, i) => ({ userId: `${outcome}-${i}`, outcome: outcome as keyof typeof c })));
  return remaining === undefined ? { results, counts: c } : { results, counts: c, remaining };
};

const failure = (status: number, error: Record<string, unknown>) => ({ isAxiosError: true, response: { status, data: { error } } });

// ─── The picker's words and decisions ─────────────────────────────────────────────────────────────

describe('the picker: what it asks the server for', () => {
  it('pages of 30 from your connections, the whole pod (50 a page, at most four pages) for an event', () => {
    expect(CONNECTIONS_PAGE).toBe(30);
    expect(POD_PAGE).toBe(50);
    expect(POD_PAGES_MAX).toBe(4);
    expect(BATCH_MAX).toBe(50);
  });

  it('names the pod or the event, the list, the trimmed search and the page already shown', () => {
    expect(candidateParams(POD, 'connections', '', null)).toEqual({ podId: 'p1', source: 'connections', limit: 30 });
    expect(candidateParams(EVENT, 'pod', '  cla ', null)).toEqual({ sessionId: 's1', source: 'pod', q: 'cla', limit: 50 });
    expect(candidateParams(EVENT, 'connections', 'x', '2026-10-26T10:00:00.000Z'))
      .toEqual({ sessionId: 's1', source: 'connections', q: 'x', before: '2026-10-26T10:00:00.000Z', limit: 30 });
  });

  it('follows the tags that change who is listed, and no others (fix round 1: each tag re-reads every loaded page against 60 reads a minute)', () => {
    // The pod or event and its invites, the event's pod when the list is its members, and the member's own new
    // connections (a request accepted) and blocks. Not the member's own record or messages (user:me and user:me:dms
    // fire on every message and read receipt), and not the event's participants (every join while an event is live).
    expect(candidateEntities(POD, 'connections', 'me')).toEqual(['pod:p1', 'pod:p1:members', 'pod:p1:invites', 'user:me:invites', 'user:me:blocks']);
    expect(candidateEntities(EVENT, 'pod', 'me')).toEqual(['session:s1', 'session:s1:invites', 'pod:p1:members', 'user:me:blocks']);
    expect(candidateEntities(EVENT, 'connections', 'me')).toEqual(['session:s1', 'session:s1:invites', 'user:me:invites', 'user:me:blocks']);
    // Before the member is known there is still something to follow: the pod or event itself.
    expect(candidateEntities(POD, 'connections', undefined)).toEqual(['pod:p1', 'pod:p1:members', 'pod:p1:invites']);
  });

  it('the tags the server\'s fan-out sends after an invite to this pod or event, which the sender\'s own screen refetches too', () => {
    expect(targetTags(POD)).toEqual(['pod:p1', 'pod:p1:members', 'pod:p1:invites']);
    expect(targetTags(EVENT)).toEqual(['session:s1', 'session:s1:participants', 'session:s1:invites']);
  });

  it('sends people by id (never an address), and "everyone in the pod" only for an event', () => {
    expect(batchBody(POD, ['a', 'b'])).toEqual({ type: 'pod', podId: 'p1', inviteeUserIds: ['a', 'b'] });
    expect(batchBody(EVENT, ['a'])).toEqual({ type: 'session', sessionId: 's1', inviteeUserIds: ['a'] });
    expect(batchBody(EVENT, [], true)).toEqual({ type: 'session', sessionId: 's1', inviteeUserIds: [], allPodMembers: true });
  });

  it('an email invite is one use and a week long; a link has the real cap (the pod\'s or the event\'s capacity, 500 when unset)', () => {
    expect(emailInviteBody(POD, '  Claus@Example.com ')).toEqual({ type: 'pod', podId: 'p1', inviteeEmail: 'Claus@Example.com', maxUses: 1, expiresInHours: 168 });
    expect(emailInviteBody(EVENT, 'a@b.co')).toEqual({ type: 'session', sessionId: 's1', inviteeEmail: 'a@b.co', maxUses: 1, expiresInHours: 168 });
    expect(LINK_CAP_DEFAULT).toBe(500);
    for (const unset of [undefined, null, 0, -3, Number.NaN]) expect(linkCap(unset)).toBe(500);
    expect(linkCap(12)).toBe(12);
    expect(linkCap(12.7)).toBe(12);
    expect(linkBody(POD, 12)).toEqual({ type: 'pod', podId: 'p1', maxUses: 12, expiresInHours: 168 });
    expect(linkBody(EVENT, 50)).toEqual({ type: 'session', sessionId: 's1', maxUses: 50, expiresInHours: 168 });
  });

  it('the email field says what is wrong at the field, in words', () => {
    expect(emailSchema.safeParse({ email: '' }).success).toBe(false);
    const empty = emailSchema.safeParse({ email: '   ' });
    expect(empty.success ? '' : empty.error.issues[0].message).toBe('Enter their email address');
    const bad = emailSchema.safeParse({ email: 'claus' });
    expect(bad.success ? '' : bad.error.issues[0].message).toBe('Enter a whole email address, like name@example.com');
    expect(emailSchema.safeParse({ email: ' claus@example.com ' })).toEqual({ success: true, data: { email: 'claus@example.com' } });
  });
});

describe('the picker: rows, chips and the footer', () => {
  it('a row says Member, Going, Invited or Declined, and only someone available can be picked', () => {
    expect(stateLabel('member')).toBe('Member');
    expect(stateLabel('going')).toBe('Going');
    expect(stateLabel('invited')).toBe('Invited');
    expect(stateLabel('declined')).toBe('Declined');
    expect(stateLabel('available')).toBeNull();
    expect(['available', 'member', 'going', 'invited', 'declined'].filter((s) => canPick(s as InviteCandidate['state']))).toEqual(['available']);
  });

  it('a person just sent for reads as the server will say, until the refreshed list arrives; the server wins otherwise', () => {
    expect(stateAfter('invited')).toBe('invited');
    expect(stateAfter('already_invited')).toBe('invited');
    expect(stateAfter('already_member')).toBe('member');
    expect(stateAfter('already_going')).toBe('going');
    expect(stateAfter('declined')).toBe('declined');
    expect(stateAfter('not_allowed')).toBeNull();
    expect(stateAfter('failed')).toBeNull();
    const sent = new Map([['a', 'invited' as const]]);
    expect(effectiveState(candidate('a'), sent)).toBe('invited');
    expect(effectiveState(candidate('a', 'declined'), sent)).toBe('declined');
    expect(effectiveState(candidate('b'), sent)).toBe('available');
  });

  it('the footer button counts the people chosen: "Send 1 invite", "Send 5 invites", and "Send invites" with nobody', () => {
    expect(sendLabel(0)).toBe('Send invites');
    expect(sendLabel(1)).toBe('Send 1 invite');
    expect(sendLabel(5)).toBe('Send 5 invites');
    expect(DONE).toBe('Done');
  });

  it('chips fold into "+N" after the first three, and open to show everyone', () => {
    expect(CHIPS_SHOWN).toBe(3);
    expect(chipsView(['a', 'b'], false)).toEqual({ chips: ['a', 'b'], more: 0 });
    expect(chipsView(['a', 'b', 'c', 'd', 'e'], false)).toEqual({ chips: ['a', 'b', 'c'], more: 2 });
    expect(chipsView(['a', 'b', 'c', 'd', 'e'], true)).toEqual({ chips: ['a', 'b', 'c', 'd', 'e'], more: 0 });
  });

  it('the pod segment and "Invite everyone" say how many, with a + while the pod is not all loaded', () => {
    expect(podSegmentLabel(null)).toBe('This pod');
    expect(podSegmentLabel('8')).toBe('This pod (8)');
    expect(countLabel(8, true)).toBe('8');
    expect(countLabel(200, false)).toBe('200+');
    expect(inviteEveryoneLabel('Founders Circle', '7')).toBe('Invite everyone in Founders Circle (7)');
    expect(inviteEveryoneLabel(undefined, '3')).toBe('Invite everyone in the pod (3)');
  });

  it('the sheet is called what its button is called; the words a person reads', () => {
    expect(pickerTitle(POD)).toBe('Invite members');
    expect(pickerTitle(EVENT)).toBe('Invite people');
    expect(SEARCH_PLACEHOLDER).toBe('Search by name, role or company');
    expect([INVITE_BY_EMAIL, SHARE_A_LINK, SHOW_MORE, YOUR_CONNECTIONS]).toEqual(['Invite by email', 'Share a link', 'Show more', 'Your connections']);
    expect(shareLinkNote(POD, 12)).toBe('Anyone with this link can join the pod, up to 12 people, for 7 days.');
    expect(shareLinkNote(EVENT, 1)).toBe('Anyone with this link can join the event, up to 1 person, for 7 days.');
    expect(people(1)).toBe('1 person');
    expect(people(2)).toBe('2 people');
  });

  it('two pages asked for at different times list a person once', () => {
    const pages = [{ items: [candidate('a'), candidate('b')] }, { items: [candidate('b'), candidate('c')] }];
    expect(everyoneOnce(pages).map((c) => c.userId)).toEqual(['a', 'b', 'c']);
  });
});

describe('the picker: what a batch says afterwards', () => {
  it('"Invitations sent" is what the server promises (the emails follow); one sentence for each kind of answer', () => {
    expect(batchSentence(answer({ invited: 5 }))).toEqual({ message: '5 invitations sent.', tone: 'success' });
    expect(batchSentence(answer({ invited: 1 }))).toEqual({ message: '1 invitation sent.', tone: 'success' });
    expect(batchSentence(answer({ invited: 3, already_invited: 1, declined: 1, not_allowed: 1 }))).toEqual({
      message: '3 invitations sent. 1 person was already invited. 1 person declined an earlier invitation. 1 person can\'t be invited.',
      tone: 'info',
    });
    expect(batchSentence(answer({ already_member: 2 })).message).toBe('2 people are already in the pod.');
    expect(batchSentence(answer({ already_going: 1 })).message).toBe('1 person is already going.');
    expect(batchSentence(answer({ already_invited: 2 })).message).toBe('2 people were already invited.');
  });

  it('a failure is said as one, and "everyone in the pod" says how many are left', () => {
    expect(batchSentence(answer({ failed: 2 }))).toEqual({ message: '2 invitations could not be sent. Try again.', tone: 'error' });
    expect(batchSentence(answer({ invited: 1, failed: 1 }))).toEqual({ message: '1 invitation sent. 1 invitation could not be sent. Try again.', tone: 'info' });
    expect(batchSentence(answer({ invited: 50 }, 8))).toEqual({ message: '50 invitations sent. 8 more people in the pod can still be invited.', tone: 'info' });
    expect(batchSentence(answer({ invited: 3 }, 0))).toEqual({ message: '3 invitations sent.', tone: 'success' });
    expect(batchSentence(answer({}))).toEqual({ message: 'Nobody new to invite.', tone: 'info' });
  });
});

describe('the picker: a refusal in the server\'s own words', () => {
  const fallback = 'Those invitations could not be sent. Try again.';

  it('passes the server\'s sentence on for a refusal a member can meet', () => {
    expect(inviteErrorSentence(failure(429, { message: 'You have sent a lot of invitations this hour. Please try again later.' }), fallback))
      .toBe('You have sent a lot of invitations this hour. Please try again later.');
    expect(inviteErrorSentence(failure(429, { code: 'INVITE_LIMIT_REACHED', message: 'You can send up to 100 invites per day. Try again tomorrow.' }), fallback))
      .toBe('You can send up to 100 invites per day. Try again tomorrow.');
    expect(inviteErrorSentence(failure(400, { message: 'Cannot invite to a completed event' }), fallback)).toBe('Cannot invite to a completed event');
    expect(inviteErrorSentence(failure(403, { message: 'Only pod directors can view pod invites' }), fallback)).toBe('Only pod directors can view pod invites');
    expect(inviteErrorSentence(failure(409, { message: "This person can't be invited." }), fallback)).toBe("This person can't be invited.");
    expect(inviteErrorSentence(failure(503, { message: 'We could not send the reminder just now. Please try again.' }), fallback))
      .toBe('We could not send the reminder just now. Please try again.');
  });

  it('a validation refusal says its first field\'s problem, never "Validation failed"', () => {
    expect(inviteErrorSentence(failure(400, { message: 'Validation failed', details: { inviteeUserIds: ['Choose at least one person to invite'] } }), fallback))
      .toBe('Choose at least one person to invite');
    expect(inviteErrorSentence(failure(400, { message: 'Validation failed', details: {} }), fallback)).toBe(fallback);
  });

  it('no answer is a lost connection; a fault, an id or a server error is the caller\'s own sentence', () => {
    expect(inviteErrorSentence({ isAxiosError: true }, fallback)).toBe(CONNECTION_LOST);
    expect(inviteErrorSentence(new TypeError('x is undefined'), fallback)).toBe(fallback);
    expect(inviteErrorSentence(failure(500, { message: 'Internal server error' }), fallback)).toBe(fallback);
    expect(inviteErrorSentence(failure(404, { message: 'Pod with id 3f2a9c1e-7d4b-4c55-9b1a-0e8f6a2d9c11 not found' }), fallback)).toBe(fallback);
  });
});

// ─── The organisers' list: who is invited, who declined ──────────────────────────────────────────

const row = (over: Partial<InviteListRow> & { id: string }): InviteListRow => ({
  code: `code-${over.id}`, inviteeEmail: `${over.id}@example.com`, inviteeName: `Name ${over.id}`, inviteeUserId: `u-${over.id}`,
  status: 'pending', createdAt: '2026-10-20T10:00:00.000Z', declinedAt: null, ...over,
});

describe('the organisers\' list: Invited, Declined and the open links', () => {
  it('a pending invite to a person is Invited; an open link (no address) is listed apart', () => {
    const groups = inviteStatusGroups([row({ id: 'a' }), row({ id: 'link', inviteeEmail: null, inviteeName: null, inviteeUserId: null })], [], new Set());
    expect(groups.invited.map((r) => r.id)).toEqual(['a']);
    expect(groups.links.map((r) => r.id)).toEqual(['link']);
    expect(groups.declined).toEqual([]);
  });

  it('someone already in (a member, or going) is not Invited or Declined', () => {
    const groups = inviteStatusGroups(
      [row({ id: 'a', inviteeUserId: 'in' })],
      [row({ id: 'd', inviteeUserId: 'in', status: 'revoked', declinedAt: '2026-10-21T10:00:00.000Z' })],
      new Set(['in']),
    );
    expect(groups.invited).toEqual([]);
    expect(groups.declined).toEqual([]);
  });

  it('a decline stands until the person is invited again or says yes later, as the server reads it', () => {
    const declined = row({ id: 'd1', inviteeUserId: 'p', status: 'revoked', declinedAt: '2026-10-21T10:00:00.000Z' });
    // Declined, nothing since.
    expect(inviteStatusGroups([], [declined], new Set()).declined.map((r) => r.id)).toEqual(['d1']);
    // Declined, then invited again: Invited, not both.
    const again = row({ id: 'p2', inviteeUserId: 'p', createdAt: '2026-10-22T10:00:00.000Z' });
    const both = inviteStatusGroups([again], [declined, again], new Set());
    expect(both.invited.map((r) => r.id)).toEqual(['p2']);
    expect(both.declined).toEqual([]);
    // Declined, then accepted a later invite (and maybe left since): no longer Declined.
    const yes = row({ id: 'y', inviteeUserId: 'p', status: 'accepted', createdAt: '2026-10-23T10:00:00.000Z' });
    expect(inviteStatusGroups([], [declined, yes], new Set()).declined).toEqual([]);
    // An invite accepted BEFORE the decline does not undo it.
    const before = row({ id: 'old', inviteeUserId: 'p', status: 'accepted', createdAt: '2026-10-01T10:00:00.000Z' });
    expect(inviteStatusGroups([], [before, declined], new Set()).declined.map((r) => r.id)).toEqual(['d1']);
  });

  it('a withdrawal is not a decline; two declines are one person, the latest; an address with no member is still a person', () => {
    const withdrawn = row({ id: 'w', status: 'revoked', declinedAt: null });
    expect(inviteStatusGroups([], [withdrawn], new Set()).declined).toEqual([]);
    const first = row({ id: 'x1', inviteeUserId: 'q', status: 'revoked', declinedAt: '2026-10-21T10:00:00.000Z' });
    const second = row({ id: 'x2', inviteeUserId: 'q', status: 'revoked', declinedAt: '2026-10-24T10:00:00.000Z' });
    const stranger = row({ id: 's', inviteeUserId: null, inviteeName: null, inviteeEmail: 'Out@Side.com', status: 'revoked', declinedAt: '2026-10-22T10:00:00.000Z' });
    expect(inviteStatusGroups([], [first, second, stranger], new Set()).declined.map((r) => r.id)).toEqual(['x2', 's']);
  });

  it('the summary counts Members (a pod) or Going (an event), Invited and Declined', () => {
    const groups = inviteStatusGroups([row({ id: 'a' }), row({ id: 'b' })], [row({ id: 'd', status: 'revoked', declinedAt: '2026-10-21T10:00:00.000Z' })], new Set());
    expect(statusSummary('pod', 7, groups)).toEqual([{ label: 'Members', count: 7 }, { label: 'Invited', count: 2 }, { label: 'Declined', count: 1 }]);
    expect(statusSummary('session', 3, groups)[0]).toEqual({ label: 'Going', count: 3 });
    expect(STATUS_TITLE).toBe('Invitations');
  });

  it('a row reads the name, and the address under it only when it is a different line', () => {
    expect(personLine(row({ id: 'a' }))).toEqual({ name: 'Name a', detail: 'a@example.com' });
    // A co-host's list puts the member's name where the address was: said once, not twice.
    expect(personLine(row({ id: 'a', inviteeEmail: 'Name a' }))).toEqual({ name: 'Name a', detail: null });
    expect(personLine(row({ id: 'a', inviteeName: null }))).toEqual({ name: 'a@example.com', detail: null });
  });
});

describe('the organisers\' list: reminders and withdrawing, in words', () => {
  it('one reminder: sent, or already sent within the hour', () => {
    expect(remindSentence({ reminded: true })).toEqual({ message: 'Reminder sent.', tone: 'success' });
    expect(remindSentence({ reminded: false, recentlyReminded: true })).toEqual({ message: 'They were reminded less than an hour ago.', tone: 'info' });
  });

  it('Remind all says how many went, and never claims a reminder that did not go', () => {
    expect(remindAllSentence({ reminded: 3, total: 3, recentlyReminded: 0 })).toEqual({ message: 'Reminders sent to 3 people.', tone: 'success' });
    expect(remindAllSentence({ reminded: 2, total: 2, recentlyReminded: 1 })).toEqual({ message: 'Reminders sent to 2 people. 1 person was reminded less than an hour ago.', tone: 'success' });
    expect(remindAllSentence({ reminded: 1, total: 3, recentlyReminded: 0 })).toEqual({ message: 'Reminders sent to 1 of 3 people. Try the rest again in a moment.', tone: 'info' });
    expect(remindAllSentence({ reminded: 0, total: 2, recentlyReminded: 0 })).toEqual({ message: 'The reminders could not be sent just now. Please try again.', tone: 'error' });
    expect(remindAllSentence({ reminded: 0, total: 0, recentlyReminded: 4 })).toEqual({ message: 'Everyone was reminded less than an hour ago.', tone: 'info' });
    expect(remindAllSentence({ reminded: 0, total: 0, recentlyReminded: 0 })).toEqual({ message: 'Nobody is waiting for a reminder.', tone: 'info' });
  });

  it('the pod page reminds one by one and counts what came back: sent, reminded within the hour, failed', () => {
    const results: PromiseSettledResult<{ reminded?: boolean; recentlyReminded?: boolean }>[] = [
      { status: 'fulfilled', value: { reminded: true } },
      { status: 'fulfilled', value: { reminded: false, recentlyReminded: true } },
      { status: 'rejected', reason: new Error('503') },
      { status: 'fulfilled', value: { reminded: true } },
    ];
    expect(tallyReminders(results)).toEqual({ reminded: 2, total: 3, recentlyReminded: 1 });
  });

  it('withdrawing asks first', () => {
    expect(WITHDRAW_CONFIRM).toBe('Withdraw this invite? Its link stops working, and you can invite them again afterwards.');
  });
});

// Fix round 1: the pod's Remind all fired every reminder at once; the mail provider takes about two sends a second and
// drops the rest, so most of a big pod's reminders came back "not sent". They go one at a time now, half a second apart.
describe('the pod page reminds one invite at a time, half a second apart', () => {
  it('runs each in turn, in order, pausing between them and not after the last; a failure is kept and the rest still run', async () => {
    const order: string[] = [];
    const pauses: number[] = [];
    const run = jest.fn(async (id: string) => {
      order.push(`start ${id}`);
      if (id === 'b') throw new Error('503');
      await Promise.resolve();
      order.push(`end ${id}`);
      return { reminded: true };
    });
    const wait = jest.fn(async (ms: number) => { pauses.push(ms); });
    const results = await settleInTurn(['a', 'b', 'c'], run, 500, wait);
    expect(order).toEqual(['start a', 'end a', 'start b', 'start c', 'end c']);
    expect(pauses).toEqual([500, 500]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(tallyReminders(results)).toEqual({ reminded: 2, total: 3, recentlyReminded: 0 });
  });

  it('nothing to remind: no call and no pause', async () => {
    const run = jest.fn(async () => ({ reminded: true }));
    const wait = jest.fn(async () => {});
    expect(await settleInTurn([], run, 500, wait)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it('the pod page uses it, half a second apart, and no longer fires them all at once', () => {
    const list = read('features/invites/InviteStatusList.tsx');
    expect(REMIND_GAP_MS).toBe(500);
    expect(list).toMatch(/settleInTurn\(\s*rows,\s*\(row\) => api\.post\(`\/invites\/\$\{row\.id\}\/remind`\)/);
    expect(list).toMatch(/REMIND_GAP_MS,?\s*\)/);
    expect(list).not.toMatch(/Promise\.allSettled/);
  });
});

// ─── The wiring, pinned by its source ────────────────────────────────────────────────────────────

describe('the sheet is the REASON Sheet, with the footer the brief asks for', () => {
  const sheet = read('features/invites/InvitePickerSheet.tsx');

  it('is built on the REASON Sheet (a bottom sheet on phones, a dialog from 768px, portalled, focus kept inside)', () => {
    expect(sheet).toMatch(/import Sheet from '@\/features\/reason\/ui\/Sheet';/);
    expect(sheet).toMatch(/<Sheet\b[\s\S]*?footer=\{/);
  });

  it('its sticky footer holds Done and "Send {n} invites"', () => {
    const footer = sheet.slice(sheet.indexOf('footer={'), sheet.indexOf('footer={') + 1200);
    expect(footer).toContain('{DONE}');
    expect(footer).toMatch(/sendLabel\(/);
    expect(footer).toMatch(/min-h-\[44px\]/);
  });

  it('searches as you type (debounced), browses with "Show more", folds chips, and offers email and a link with the real cap', () => {
    expect(sheet).toMatch(/useDebouncedValue\(/);
    expect(sheet).toMatch(/placeholder=\{SEARCH_PLACEHOLDER\}/);
    expect(sheet).toMatch(/isFetchingNextPage \? 'Loading more…' : SHOW_MORE/);
    expect(sheet).toMatch(/chipsView\(/);
    expect(sheet).toContain('{INVITE_BY_EMAIL}');
    expect(sheet).toContain('{SHARE_A_LINK}');
    expect(sheet).toMatch(/shareLinkNote\(/);
    expect(sheet).toMatch(/const cap = linkCap\(capacity\)/);
    expect(sheet).toMatch(/useShareLink\(target, cap,/);
    expect(sheet).not.toMatch(/maxUses: 10\b/);
  });

  it('the typed search is dark ink on a white field (it was white on white once, 9 Jun) and 16px on a phone', () => {
    const input = sheet.slice(sheet.indexOf('placeholder={SEARCH_PLACEHOLDER}') - 600, sheet.indexOf('placeholder={SEARCH_PLACEHOLDER}') + 400);
    expect(input).toMatch(/text-reason-ink/);
    expect(input).toMatch(/text-\[16px\]/);
  });

  it('an event opens on its pod ("This pod ({n})") with "Invite everyone in {pod} ({n})"', () => {
    expect(sheet).toMatch(/podSegmentLabel\(/);
    expect(sheet).toMatch(/inviteEveryoneLabel\(/);
    expect(sheet).toMatch(/useState<InviteCandidateSource>\(\s*target\.type === 'session' && target\.podId \? 'pod' : 'connections'/);
  });

  it('never asks the old encounters search', () => {
    expect(sheet).not.toMatch(/\/users\/connected/);
  });
});

describe('the data layer: candidates as a useInfiniteQuery that declares its tags, and one batch call', () => {
  const hooks = read('features/invites/useInviteCandidates.ts');

  it('pages the candidates by nextBefore and declares meta.entities (the realtime guard does not scan useInfiniteQuery)', () => {
    expect(hooks).toMatch(/useInfiniteQuery\(\{/);
    expect(hooks).toMatch(/api\.get\('\/invites\/candidates'/);
    expect(hooks).toMatch(/getNextPageParam: \(last\) => last\.nextBefore \?\? undefined/);
    expect(hooks).toMatch(/meta: \{ entities: candidateEntities\(target, source, me\) \}/);
  });

  it('reads each list once a minute at most and not on focus (fix round 1: the budget is 60 reads a minute, shared with People)', () => {
    const q = hooks.slice(hooks.indexOf('export function useInviteCandidates'));
    expect(hooks).toMatch(/const CANDIDATES_FRESH_MS = 60_000;/);
    expect(q).toMatch(/staleTime: CANDIDATES_FRESH_MS,/);
    expect(q).toMatch(/refetchOnWindowFocus: false,/);
    // Not gcTime 0: a search is another query, and the browsed pages must still be there when the search is cleared
    // (gcTime 0 forgot them the moment the search began, so "Show more" twice and then a cleared search showed one page).
    expect(q).not.toMatch(/gcTime/);
    expect(hooks).toMatch(/export const targetKey = /);
  });

  it('forgets every page the sheet read when the sheet closes, so each opening reads one page (a refetch re-reads every page loaded so far)', () => {
    const sheet = read('features/invites/InvitePickerSheet.tsx');
    expect(sheet).toMatch(/import \{ targetKey, [^}]*\} from '\.\/useInviteCandidates';/);
    expect(sheet).toMatch(/useEffect\(\(\) => \(\) => \{ qc\.removeQueries\(\{ queryKey: forget\.current \}\); \}, \[qc\]\);/);
  });

  it('sends a batch to /invites/batch, an email or a link to /invites, and refetches what the server\'s fan-out names', () => {
    expect(hooks).toMatch(/api\.post\('\/invites\/batch', batchBody\(/);
    expect(hooks).toMatch(/api\.post\('\/invites', emailInviteBody\(/);
    expect(hooks).toMatch(/api\.post\('\/invites', linkBody\(/);
    expect(hooks).toMatch(/invalidateTags\(qc, targetTags\(target\)\)/);
    expect(hooks).not.toMatch(/setQueryData/);
  });
});

describe('the organisers\' list keeps the pages\' query keys and their tags', () => {
  const list = read('features/invites/InviteStatusList.tsx');

  it('the pod\'s pending invites and history follow the pod\'s invites tag', () => {
    const pending = list.slice(list.indexOf("queryKey: ['pod-pending-invites', podId]"));
    expect(pending).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.podInvites\(podId\)/);
    const history = list.slice(list.indexOf("queryKey: ['pod-invite-history', podId]"));
    expect(history).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.podInvites\(podId\)/);
  });

  it('the event\'s pending invites and history follow the event\'s invites tag', () => {
    const pending = list.slice(list.indexOf("queryKey: ['session-pending-invites', sessionId]"));
    expect(pending).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.sessionInvites\(sessionId\)/);
    const history = list.slice(list.indexOf("queryKey: ['session-invite-history', sessionId]"));
    expect(history).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,200}E\.sessionInvites\(sessionId\)/);
  });

  it('reminds (one, or all on an event), withdraws after asking, and is always on screen for the people who run it', () => {
    expect(list).toMatch(/api\.post\(`\/invites\/\$\{inviteId\}\/remind`\)/);
    expect(list).toMatch(/api\.post\(`\/invites\/remind-all\/\$\{sessionId\}`\)/);
    expect(list).toMatch(/window\.confirm\(WITHDRAW_CONFIRM\)/);
    expect(list).toContain('{STATUS_TITLE}');
    expect(list).not.toMatch(/setQueryData/);
  });
});

describe('the pod page and the event page open the sheet and show the list', () => {
  const pod = read('features/pods/PodDetailPage.tsx');
  const event = read('features/sessions/SessionDetailPage.tsx');

  it('"Invite members" opens the sheet on the pod page; the old four-option modal and its search are gone', () => {
    expect(pod).toMatch(/<InvitePickerSheet\b/);
    expect(pod).toMatch(/> Invite members\s*</);
    expect(pod).not.toMatch(/Invite Members to Pod|Option 1|Option 2|Option 3|\/users\/connected/);
    expect(pod).toMatch(/linkCap=\{pod\.maxMembers\}/);
  });

  it('the pod\'s list is there for its director and host of any pod that is not archived, with no chip to reveal it; the members count no longer counts invites', () => {
    // Fix round 1: a draft or suspended pod can be invited to (the button shows, the server refuses only an archived
    // pod), so its organisers see the card too.
    expect(pod).toMatch(/isDirectorOrHost && pod\.status !== 'archived' && podId && \(\s*<InviteStatusList\b/);
    expect(pod).not.toMatch(/showPodPendingInvites|Pending Pod Invites|View & Remind/);
    expect(pod).toMatch(/- \(podMemberCounts\.pendingInvites \|\| 0\)/);
  });

  it('the event page opens the sheet with ?invite=1, for its host, co-hosts and admins, while the event can still take people', () => {
    expect(event).toMatch(/searchParams\.get\('invite'\) === '1'/);
    expect(event).toMatch(/const mayInvite = \(isHost \|\| isAdmin \|\| viewerIsCohost\) && \(phase === 'pre' \|\| phase === 'live'\);/);
    expect(event).toMatch(/<InvitePickerSheet\b[\s\S]{0,400}open=\{pickerOpen\}/);
    expect(event).toMatch(/linkCap=\{session\.config\?\.maxParticipants\}/);
  });

  it('the event\'s list replaces the "Pending Invites" chip and the grey rows; the old modal\'s calls are gone', () => {
    expect(event).toMatch(/mayInvite && sessionId && \(\s*<InviteStatusList\b/);
    expect(event).not.toMatch(/showPendingInvites|Invite Pending|Invite to Event|Option 1|\/users\/connected|\/invites\/bulk|members\/for-invite/);
    expect(event).toMatch(/- \(participantCounts\.pendingInvites \?\? 0\)/);
  });

  it('the dead CreateInviteModal is gone and nothing imports it', () => {
    expect(exists('features/invites/CreateInviteModal.tsx')).toBe(false);
    expect(pod + event + read('App.tsx') + read('features/invites/InvitesPage.tsx')).not.toMatch(/CreateInviteModal/);
  });
});
