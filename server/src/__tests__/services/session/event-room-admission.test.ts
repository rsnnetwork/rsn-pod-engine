// ─── Who an event lets into its live room (H1, 26 Oct 2026) ──────────────────────────────────────────
//
// One positive check decides whether a socket joins an event's live room: the event's host, a co-host or
// moderator, a platform admin or super admin (they may act as host), or someone whose participant row is
// not `removed`. Someone who left is coming back, which is recoverable; a removed row is terminal and wins
// over every role, as the registration's own REMOVED_FROM_EVENT check already does. Everyone else is
// refused, and is told in words that are true for them.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  __esModule: true,
}));

import { eventRoomAdmission, eventRoomRefusal } from '../../../services/session/session-access';

const EVENT = '0c1d2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f';
const ME = '1d2e3f4a-5b6c-4d7e-9f80-9b0c1d2e3f4a';

type Facts = { is_host: boolean; is_cohost: boolean; participant_status: string | null };

/** What the database says about the event and this person (null: there is no such event). */
function facts(f: Partial<Facts> | null) {
  mockQuery.mockResolvedValueOnce({
    rows: f === null ? [] : [{ is_host: false, is_cohost: false, participant_status: null, ...f }],
  });
}

beforeEach(() => mockQuery.mockReset());

describe('eventRoomAdmission', () => {
  it('reads the event, its co-hosts and the person\'s participant row in one parameterised query', async () => {
    facts({});
    await eventRoomAdmission(EVENT, ME, 'member');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([EVENT, ME]);
    expect(sql).toMatch(/FROM sessions s/);
    expect(sql).toMatch(/session_cohosts/);
    expect(sql).toMatch(/session_participants/);
    expect(sql).not.toContain(EVENT);
    expect(sql).not.toContain(ME);
  });

  it.each<[string, Partial<Facts>, string | undefined]>([
    ['the event\'s host', { is_host: true }, 'member'],
    ['a co-host or moderator', { is_cohost: true }, 'member'],
    ['a platform admin who is not in the event', {}, 'admin'],
    ['a super admin who is not in the event', {}, 'super_admin'],
    ['a registered participant', { participant_status: 'registered' }, 'member'],
    ['a checked-in participant', { participant_status: 'checked_in' }, 'member'],
    ['a participant in the main room', { participant_status: 'in_lobby' }, 'member'],
    ['a participant in a breakout', { participant_status: 'in_round' }, 'member'],
    ['a participant who dropped and is reconnecting', { participant_status: 'disconnected' }, 'member'],
    ['a participant who left and is coming back', { participant_status: 'left' }, 'member'],
    ['a participant marked a no-show who turns up', { participant_status: 'no_show' }, 'member'],
    ['a participant whose token carries no role', { participant_status: 'registered' }, undefined],
  ])('admits %s', async (_who, f, role) => {
    facts(f);
    expect(await eventRoomAdmission(EVENT, ME, role)).toBe('admitted');
  });

  it.each<[string, Partial<Facts> | null, string | undefined]>([
    ['someone with no participant row and no role in the event', {}, 'member'],
    ['someone with the platform host role but nothing in this event', {}, 'host'],
    ['someone whose token carries no role and who has no row', {}, undefined],
    ['anyone, when the event does not exist', null, 'super_admin'],
  ])('refuses %s', async (_who, f, role) => {
    facts(f);
    expect(await eventRoomAdmission(EVENT, ME, role)).toBe('refused');
  });

  it.each<[string, Partial<Facts>, string]>([
    ['a removed participant', {}, 'member'],
    ['a removed participant who is an admin', {}, 'admin'],
    ['a removed participant who is a super admin', {}, 'super_admin'],
    ['a removed participant who is a co-host', { is_cohost: true }, 'member'],
    ['a removed participant who is the host', { is_host: true }, 'member'],
  ])('a removal is terminal: %s is removed', async (_who, f, role) => {
    facts({ ...f, participant_status: 'removed' });
    expect(await eventRoomAdmission(EVENT, ME, role)).toBe('removed');
  });
});

describe('eventRoomRefusal: what the refused person reads', () => {
  it('an event that is over', () => {
    expect(eventRoomRefusal('completed', 'SESSION_NOT_SCHEDULED')).toEqual({ code: 'EVENT_ENDED', message: 'This event has ended.' });
  });

  it('a cancelled event', () => {
    expect(eventRoomRefusal('cancelled', 'SESSION_NOT_SCHEDULED')).toEqual({ code: 'EVENT_ENDED', message: 'This event was cancelled.' });
  });

  it('a private or invite-only pod\'s event, for someone who is not one of its members', () => {
    for (const status of ['scheduled', 'lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby']) {
      expect(eventRoomRefusal(status, 'AUTH_FORBIDDEN')).toEqual({
        code: 'AUTH_FORBIDDEN',
        message: 'This event is only open to its pod\'s members.',
      });
    }
  });

  it('anything else (a registration that failed, a check that could not run) asks them to try again', () => {
    for (const code of [undefined, 'NOT_FOUND', 'INTERNAL_ERROR']) {
      expect(eventRoomRefusal('round_active', code)).toEqual({
        code: 'JOIN_FAILED',
        message: 'You could not join this event. Refresh the page to try again.',
      });
    }
  });

  it('is always a plain sentence about an event: no code, no "session"', () => {
    const all = [
      eventRoomRefusal('completed', undefined), eventRoomRefusal('cancelled', undefined),
      eventRoomRefusal('lobby_open', 'AUTH_FORBIDDEN'), eventRoomRefusal('lobby_open', undefined),
    ];
    for (const { message } of all) {
      expect(message).toMatch(/^[A-Z].*\.$/);
      expect(message).toMatch(/event/);
      expect(message).not.toMatch(/session|_|[A-Z]{3,}/);
    }
  });
});
