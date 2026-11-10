// ─── An event's lifecycle, the shared rule (Part 2 foundation, Task 2; D1) ────────────────────────────
//
// eventLifecycleOf reads the seven states from sessions.status beside the two new facts (publication, archived_at)
// and the registration opening time, in D1's order: cancelled, archived, completed, live, draft, published before
// registration opens, else registration open. allowedLifecycleActions says who may take which step in which state.

import {
  eventLifecycleOf, allowedLifecycleActions, eventAllowedActions, EVENT_LIVE_STATUSES, SessionStatus,
  type EventLifecycle, type EventLifecycleAction, type EventLifecycleWho, type EventPublication,
} from '@rsn/shared';
import { LIVE_STATUSES } from '../../services/session/main-room';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const LATER = '2026-11-11T12:00:00.000Z';
const EARLIER = new Date('2026-11-09T12:00:00.000Z');

const ALL_STATUSES = Object.values(SessionStatus) as string[];
const LIVE = ['lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby'];

/** What D1's order says, written out by hand for one combination. */
function expected(status: string, publication: EventPublication, archived: boolean, opensAt: 'none' | 'past' | 'future'): EventLifecycle {
  if (status === 'cancelled') return 'cancelled';
  if (archived) return 'archived';
  if (status === 'completed') return 'completed';
  if (LIVE.includes(status)) return 'live';
  if (publication === 'draft') return 'draft';
  return opensAt === 'future' ? 'published' : 'registration_open';
}

describe('eventLifecycleOf', () => {
  it('knows the same live statuses as the server', () => {
    expect([...EVENT_LIVE_STATUSES].sort()).toEqual([...LIVE].sort());
    expect(ALL_STATUSES.sort()).toEqual(
      ['cancelled', 'closing_lobby', 'completed', 'lobby_open', 'round_active', 'round_rating', 'round_transition', 'scheduled'],
    );
  });

  const combos: Array<[string, EventPublication, boolean, 'none' | 'past' | 'future']> = [];
  for (const status of ALL_STATUSES) {
    for (const publication of ['draft', 'published'] as EventPublication[]) {
      for (const archived of [false, true]) {
        for (const opens of ['none', 'past', 'future'] as const) combos.push([status, publication, archived, opens]);
      }
    }
  }

  it.each(combos)('status %s, %s, archived %s, registration opening %s', (status, publication, archived, opens) => {
    const registrationOpensAt = opens === 'none' ? null : opens === 'past' ? EARLIER : LATER;
    const got = eventLifecycleOf({ status, publication, archivedAt: archived ? EARLIER : null, registrationOpensAt }, NOW);
    expect(got).toBe(expected(status, publication, archived, opens));
  });

  it('the cases D1 names: cancelled+archived reads cancelled, completed+archived reads archived, a live draft reads live', () => {
    expect(eventLifecycleOf({ status: 'cancelled', publication: 'published', archivedAt: EARLIER, registrationOpensAt: null }, NOW)).toBe('cancelled');
    expect(eventLifecycleOf({ status: 'completed', publication: 'published', archivedAt: EARLIER, registrationOpensAt: null }, NOW)).toBe('archived');
    expect(eventLifecycleOf({ status: 'lobby_open', publication: 'draft', archivedAt: null, registrationOpensAt: null }, NOW)).toBe('live');
  });

  it('a production-shaped event (published, never archived, no opening time) is open for registration, as today', () => {
    expect(eventLifecycleOf({ status: 'scheduled', publication: 'published', archivedAt: null, registrationOpensAt: null }, NOW))
      .toBe('registration_open');
  });

  it('registration opens at its time exactly, and takes ISO strings as well as dates', () => {
    const at = '2026-11-10T12:00:00.000Z';
    expect(eventLifecycleOf({ status: 'scheduled', publication: 'published', archivedAt: null, registrationOpensAt: at }, NOW)).toBe('registration_open');
    expect(eventLifecycleOf({ status: 'scheduled', publication: 'published', archivedAt: null, registrationOpensAt: new Date(LATER) }, NOW)).toBe('published');
  });
});

describe('allowedLifecycleActions', () => {
  const nobody: EventLifecycleWho = { isOwner: false, isCohost: false, isAdmin: false, isSuperAdmin: false };
  const owner = { ...nobody, isOwner: true };
  const cohost = { ...nobody, isCohost: true };
  const admin = { ...nobody, isAdmin: true };
  const superAdminAttendee = { ...nobody, isSuperAdmin: true };

  const table: Array<[string, EventLifecycleWho, EventLifecycle, number, EventLifecycleAction[]]> = [
    ['the owner of a draft', owner, 'draft', 0, ['publish', 'cancel']],
    ['a co-host of a draft', cohost, 'draft', 0, ['publish']],
    ['an admin of a draft', admin, 'draft', 0, ['publish', 'cancel']],
    ['a member on a draft', nobody, 'draft', 0, []],
    ['the owner, published, nobody registered', owner, 'published', 0, ['unpublish', 'cancel']],
    ['the owner, registration open, nobody registered', owner, 'registration_open', 0, ['unpublish', 'cancel']],
    ['the owner, registration open, someone registered', owner, 'registration_open', 1, ['cancel']],
    ['a co-host, registration open, nobody registered (may not cancel)', cohost, 'registration_open', 0, ['unpublish']],
    ['a co-host, registration open, someone registered', cohost, 'registration_open', 3, []],
    ['the owner of a live event', owner, 'live', 0, []],
    ['an admin of a live event', admin, 'live', 0, []],
    ['the owner of a completed event', owner, 'completed', 5, ['archive']],
    ['a co-host of a cancelled event', cohost, 'cancelled', 5, ['archive']],
    ['an admin of an archived event', admin, 'archived', 5, ['unarchive']],
    ['a member of a completed event', nobody, 'completed', 5, []],
    ['a super admin who only attends a draft', superAdminAttendee, 'draft', 0, ['publish', 'cancel', 'delete_permanently']],
    ['a super admin who only attends a completed event', superAdminAttendee, 'completed', 2, ['archive', 'delete_permanently']],
    ['a super admin who only attends a live event', superAdminAttendee, 'live', 2, []],
    ['a super admin who only attends an archived event', superAdminAttendee, 'archived', 2, ['unarchive', 'delete_permanently']],
  ];

  it.each(table)('%s', (_label, who, lifecycle, registered, actions) => {
    expect(allowedLifecycleActions(lifecycle, who, registered)).toEqual(actions);
  });

  // Fix round 1: a cancelled event that was archived reads 'cancelled' (D1's order); the rule is told it is archived.
  it.each([
    ['the owner, cancelled and archived', owner, 'cancelled', true, ['unarchive']],
    ['the owner, cancelled, not archived', owner, 'cancelled', false, ['archive']],
    ['a co-host, cancelled and archived', cohost, 'cancelled', true, ['unarchive']],
    ['a member, cancelled and archived', nobody, 'cancelled', true, []],
    ['a super admin attendee, cancelled and archived', superAdminAttendee, 'cancelled', true, ['unarchive', 'delete_permanently']],
    ['the owner, archived (archived implied)', owner, 'archived', false, ['unarchive']],
    ['the owner, completed, not archived', owner, 'completed', false, ['archive']],
  ] as Array<[string, EventLifecycleWho, EventLifecycle, boolean, EventLifecycleAction[]]>)(
    '%s', (_label, who, lifecycle, archived, actions) => {
      expect(allowedLifecycleActions(lifecycle, who, 0, { archived })).toEqual(actions);
    },
  );

  it('only a super admin ever deletes for good, and never a live event', () => {
    const lifecycles: EventLifecycle[] = ['draft', 'published', 'registration_open', 'live', 'completed', 'archived', 'cancelled'];
    for (const lifecycle of lifecycles) {
      for (const who of [owner, cohost, admin, nobody]) {
        expect(allowedLifecycleActions(lifecycle, who, 0)).not.toContain('delete_permanently');
      }
      expect(allowedLifecycleActions(lifecycle, superAdminAttendee, 0).includes('delete_permanently')).toBe(lifecycle !== 'live');
    }
  });
});

describe('eventAllowedActions (the one the server and the client call)', () => {
  const owner: EventLifecycleWho = { isOwner: true, isCohost: false, isAdmin: false, isSuperAdmin: false };
  const event = (status: string, archived: boolean, publication: EventPublication = 'published') =>
    ({ status, publication, archivedAt: archived ? EARLIER : null, registrationOpensAt: null });

  it('reads the lifecycle and archived_at from the event: an archived cancelled event offers Unarchive, never Archive', () => {
    expect(eventAllowedActions(event('cancelled', true), owner, 0, NOW)).toEqual(['unarchive']);
    expect(eventAllowedActions(event('cancelled', false), owner, 0, NOW)).toEqual(['archive']);
    expect(eventAllowedActions(event('completed', true), owner, 0, NOW)).toEqual(['unarchive']);
    expect(eventAllowedActions(event('completed', false), owner, 0, NOW)).toEqual(['archive']);
    expect(eventAllowedActions(event('scheduled', false, 'draft'), owner, 0, NOW)).toEqual(['publish', 'cancel']);
    expect(eventAllowedActions(event('scheduled', false), owner, 2, NOW)).toEqual(['cancel']);
  });

  it('agrees with allowedLifecycleActions on every state when it is told whether the event is archived', () => {
    for (const status of ALL_STATUSES) {
      for (const archived of [false, true]) {
        for (const publication of ['draft', 'published'] as EventPublication[]) {
          const e = event(status, archived, publication);
          expect(eventAllowedActions(e, owner, 0, NOW))
            .toEqual(allowedLifecycleActions(eventLifecycleOf(e, NOW), owner, 0, { archived }));
        }
      }
    }
  });
});

describe('the live statuses are one list', () => {
  it('the shared EVENT_LIVE_STATUSES equals the server\'s LIVE_STATUSES (main-room.ts)', () => {
    expect([...EVENT_LIVE_STATUSES].sort()).toEqual([...LIVE_STATUSES].sort());
  });
});
