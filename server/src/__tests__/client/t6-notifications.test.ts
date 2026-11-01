// ─── The notifications page and the shared notification row (30 Oct 2026 review, item 4.5) ───────────────────────────
//
// Stefan: "Add a place to see all notifications in one list (like Facebook)." /notifications reads them thirty at a
// time (the server's ?before=&limit=, R10g), newest first under Today, Yesterday and Earlier, and runs several message
// bells in a row from one conversation into one line ("Shradha sent you 3 messages"), on the page only. The bell and the
// page draw each row with one NotificationItem, which holds P11: a request that is gone reads "No longer available",
// with nothing to press. The pure rules are run here; the screens are pinned by their source, and walked in real
// browsers by e2e/tests/n1-t6-messaging.spec.ts.

import * as fs from 'fs';
import * as path from 'path';
import {
  NOTIFICATIONS_KEY, NOTIFICATIONS_PAGE_KEY, NOTIFICATIONS_PAGE_SIZE, canActOnInvite, dayGroupOf, destinationOf,
  pageSections, rowsOfPages, type Notification,
} from '../../../../client/src/features/notifications/notification-logic';
import { bellRequestView } from '../../../../client/src/features/messages/request-answer';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

const NOW = new Date(2026, 10, 1, 15, 0, 0);
const at = (daysAgo: number, hour = 12) => new Date(2026, 10, 1 - daysAgo, hour, 0, 0).toISOString();
let seq = 0;
const row = (over: Partial<Notification>): Notification => ({
  id: `n-${++seq}`, type: 'platform_match', title: 'Someone to meet', body: null, link: '/', isRead: false, createdAt: at(0), ...over,
});
const msg = (name: string, conv: string, over: Partial<Notification> = {}) =>
  row({ type: 'direct_message', title: `${name} sent you a message`, link: `/messages/${conv}`, ...over });

describe('the page\'s lines', () => {
  it('under Today, Yesterday and Earlier, by the reader\'s own day', () => {
    expect(dayGroupOf(at(0, 0), NOW)).toBe('Today');
    expect(dayGroupOf(at(1, 23), NOW)).toBe('Yesterday');
    expect(dayGroupOf(at(1, 0), NOW)).toBe('Yesterday');
    expect(dayGroupOf(at(2, 23), NOW)).toBe('Earlier');
    const sections = pageSections([row({ createdAt: at(0) }), row({ createdAt: at(1) }), row({ createdAt: at(9) }), row({ createdAt: at(30) })], NOW);
    expect(sections.map((s) => [s.day, s.entries.length])).toEqual([['Today', 1], ['Yesterday', 1], ['Earlier', 2]]);
  });

  it('several messages in a row from one conversation read as one line: "Shradha sent you 3 messages", unread while any is', () => {
    const rows = [
      msg('Shradha', 'c-1', { isRead: true }), msg('Shradha', 'c-1'), msg('Shradha', 'c-1', { isRead: true }),
      msg('Claus', 'c-2'),
      msg('Shradha', 'c-1'),
    ];
    const [today] = pageSections(rows, NOW);
    expect(today.entries.map((e) => [e.title, e.members.length, e.isRead])).toEqual([
      ['Shradha sent you 3 messages', 3, false],
      ['Claus sent you a message', 1, false],
      ['Shradha sent you a message', 1, false],
    ]);
    // Opening the line opens the newest and marks all three read.
    expect(today.entries[0].lead).toBe(rows[0]);
  });

  it('only messages run together; nothing else does, and a run does not cross a day', () => {
    const [first, second] = pageSections([
      row({ title: 'Match 1' }), row({ title: 'Match 2' }),
      msg('Ana', 'c-1', { createdAt: at(0, 9) }), msg('Ana', 'c-1', { createdAt: at(1, 22) }),
    ], NOW);
    expect(first.entries.map((e) => e.title)).toEqual(['Match 1', 'Match 2', 'Ana sent you a message']);
    expect(second.entries.map((e) => e.title)).toEqual(['Ana sent you a message']);
  });

  it('the loaded pages read as one list with no row twice (a refetch may move a row to the next page)', () => {
    const a = row({}); const b = row({}); const c = row({});
    expect(rowsOfPages([
      { notifications: [a, b], unreadCount: 3, nextBefore: 'x' },
      { notifications: [b, c], unreadCount: 3, nextBefore: null },
    ]).map((n) => n.id)).toEqual([a.id, b.id, c.id]);
  });
});

describe('removed or blocked people on the page: rows carry no actor, so the request or invite answers for itself', () => {
  const REQUEST = '3f1c2b4a-1111-4a2b-9c3d-0123456789ab';
  const request = (over: Partial<Notification>) => row({ type: 'poke', link: `/messages?poke=${REQUEST}`, ...over });

  it('a request from someone removed or blocked (the server: requestState null, pokeStatus gone) offers nothing and reads "No longer available" (P11)', () => {
    expect(bellRequestView(request({ requestState: null, pokeStatus: 'gone' }))).toMatchObject({ canAnswer: false, label: 'No longer available' });
    expect(bellRequestView(request({ requestState: { status: 'pending', conversationId: null } }))).toMatchObject({ canAnswer: true, label: null });
  });

  it('an invite that is not waiting (revoked, expired, accepted) offers no Accept or Decline', () => {
    const invite = (inviteStatus: string) => row({ type: 'event_invite', link: '/invite/ABC123', inviteStatus });
    expect(canActOnInvite(invite('pending'))).toBe(true);
    for (const s of ['revoked', 'expired', 'accepted']) expect(canActOnInvite(invite(s))).toBe(false);
  });

  it('a row opens where it points: an event, a pod, a request (or its conversation once accepted), else its link', () => {
    expect(destinationOf(row({ sessionId: 's-1' }))).toBe('/sessions/s-1');
    expect(destinationOf(row({ podId: 'p-1' }))).toBe('/pods/p-1');
    expect(destinationOf(request({ requestState: { status: 'accepted', conversationId: 'c-9' } }))).toBe('/messages/c-9');
    expect(destinationOf(msg('Ana', 'c-1'))).toBe('/messages/c-1');
  });
});

describe('the page (source)', () => {
  const page = read('features/notifications/NotificationsPage.tsx');

  it('reads a page at a time through useInfiniteQuery, under the bell\'s key, live by the member\'s notifications tag', () => {
    // check-realtime-entities.js does not scan useInfiniteQuery, so its tags are pinned here.
    expect(page).toMatch(/useInfiniteQuery\(\{\s*queryKey: NOTIFICATIONS_PAGE_KEY,/);
    expect(page).toMatch(/meta: \{ entities: me \? \[E\.userNotifications\(me\)\] : \[\] \}/);
    expect(page).toMatch(/getNextPageParam: \(last: NotificationList\) => last\.nextBefore \?\? undefined/);
    expect(page).toMatch(/params: \{ limit: NOTIFICATIONS_PAGE_SIZE, \.\.\.\(before \? \{ before \} : \{\}\) \}/);
    expect(NOTIFICATIONS_PAGE_SIZE).toBe(30);
    expect(NOTIFICATIONS_PAGE_KEY.slice(0, 1)).toEqual([...NOTIFICATIONS_KEY]);
  });

  it('has a skeleton, "No notifications yet", an error with Try again, "Mark all as read" and "Load more"', () => {
    expect(page).toMatch(/<PageSkeleton \/>/);
    expect(page).toMatch(/>No notifications yet</);
    expect(page).toMatch(/We could not load your notifications\.[\s\S]*Try again/);
    expect(page).toMatch(/Mark all as read/);
    expect(page).toMatch(/Load more/);
  });

  it('a re-read that fails (its own sixty-a-minute limit, or the network) keeps the list and says so, with Try again (fix round 1)', () => {
    expect(page).toContain('{list.isRefetchError && (');
    expect(page).toContain('This list could not be brought up to date.');
    const stale = page.slice(page.indexOf('data-testid="notifications-stale"'));
    const block = stale.slice(0, stale.indexOf('</div>'));
    expect(block).toContain('onClick={() => { void list.refetch(); }}');
    expect(block).toContain('min-h-[44px]');
    expect(block).toContain('Try again');
  });

  it('lives inside the shell at /notifications', () => {
    const app = read('App.tsx');
    const shellRoutes = app.slice(app.indexOf('<ReasonShell />'), app.indexOf('{/* Protected without layout'));
    expect(shellRoutes).toMatch(/<Route path="\/notifications" element=\{<NotificationsPage \/>\} \/>/);
  });

  it('is named in ENTITIES.md among the readers of user:<id>:notifications', () => {
    const entities = fs.readFileSync(path.join(__dirname, '../../../../ENTITIES.md'), 'utf8');
    const line = entities.split('\n').find((l) => l.startsWith('| `user:<userId>:notifications`'))!;
    expect(line).toMatch(/the notifications page \(`\/notifications`/);
  });
});

describe('the bell, split, and the row they share', () => {
  const bell = read('components/ui/NotificationBell.tsx');
  const item = read('features/notifications/NotificationItem.tsx');

  it('the bell and the page draw every row with NotificationItem, and answer through the same actions', () => {
    expect(bell).toMatch(/<NotificationItem\b/);
    expect(read('features/notifications/NotificationsPage.tsx')).toMatch(/<NotificationItem\b/);
    expect(bell).toMatch(/useNotificationActions\(close\)/);
    expect(bell.split('\n').length).toBeLessThan(200);
  });

  it('the bell\'s foot is a 44px "See all notifications" to the page', () => {
    expect(bell).toMatch(/<Link\s+to="\/notifications"\s+onClick=\{close\}\s+data-testid="bell-see-all"\s+className="flex min-h-\[44px\]/);
    expect(bell).toMatch(/See all notifications/);
  });

  it('a pushed notification reads both lists again (the ["notifications"] prefix)', () => {
    expect(bell).toMatch(/const readAgain = \(\) => \{ void qc\.invalidateQueries\(\{ queryKey: NOTIFICATIONS_KEY \}\); \};/);
    expect(bell).toMatch(/socket\.on\('notification:new', readAgain\);/);
  });

  it('the row draws a request\'s label from bellRequestView, whatever it is: "No longer available" lives there once', () => {
    expect(item).toMatch(/const request = bellRequestView\(n\);/);
    expect(item).toMatch(/if \(!view\.label\) return null;/);
    expect(item).toMatch(/\{view\.label\}/);
  });
});
