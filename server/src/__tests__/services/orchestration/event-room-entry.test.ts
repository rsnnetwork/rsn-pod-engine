// ─── The live join's one rule for an event's room (H1, fix round 1) ──────────────────────────────────
//
// decideRoomEntry is the one place that decides what a join does with a socket: let it into the event's room,
// give a removed member the terminal bounce, or refuse it with one sentence. It reads who the event admits
// (session-access eventRoomAdmission), and when that read fails it never drops someone the event has already
// let in or someone this join's registration has just proved; otherwise it asks once more and then refuses.
// liveStateAccess applies the same rule to the resync answer. refuseOnce tells a page at most once per sentence.

const mockAdmission = jest.fn();
jest.mock('../../../services/session/session-access', () => ({
  eventRoomAdmission: (...args: unknown[]) => mockAdmission(...args),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import type { Socket } from 'socket.io';
import {
  decideRoomEntry, eventRoomRefusal, liveStateAccess, refuseOnce, RegistrationOutcome,
} from '../../../services/orchestration/event-room-entry';

const EVENT = '0c1d2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f';
const ME = '1d2e3f4a-5b6c-4d7e-9f80-9b0c1d2e3f4a';
const ROOM = `session:${EVENT}`;

const POD_ONLY = { code: 'AUTH_FORBIDDEN', message: 'This event is only open to its pod\'s members.' };
const RETRY = { code: 'JOIN_FAILED', message: 'You could not join this event. Refresh the page to try again.' };
const ENDED = { code: 'EVENT_ENDED', message: 'This event has ended.' };

type FakeSocket = { rooms: Set<string>; emit: jest.Mock };
function page(inRoom = false): FakeSocket {
  return { rooms: new Set(inRoom ? [ROOM] : []), emit: jest.fn() };
}
const asSocket = (s: FakeSocket): Socket => s as unknown as Socket;
const dbDown = () => new Error('Connection terminated unexpectedly');

function decide(s: FakeSocket, registration: RegistrationOutcome, eventStatus = 'lobby_open') {
  return decideRoomEntry({ socket: asSocket(s), sessionId: EVENT, userId: ME, role: 'member', eventStatus, registration });
}

beforeEach(() => mockAdmission.mockReset());

describe('decideRoomEntry, when the event can be asked', () => {
  it('lets in whoever the event admits, in one read', async () => {
    mockAdmission.mockResolvedValue('admitted');
    expect(await decide(page(), { registered: false, refusalCode: 'AUTH_FORBIDDEN' })).toEqual({ kind: 'enter' });
    expect(mockAdmission).toHaveBeenCalledTimes(1);
    expect(mockAdmission).toHaveBeenCalledWith(EVENT, ME, 'member');
  });

  it('gives a removed member the terminal bounce, whatever the registration said', async () => {
    mockAdmission.mockResolvedValue('removed');
    for (const refusalCode of ['SESSION_FULL', 'SESSION_NOT_SCHEDULED', 'AUTH_FORBIDDEN', undefined]) {
      expect(await decide(page(true), { registered: false, refusalCode })).toEqual({ kind: 'evict' });
    }
  });

  it('lets in someone refused only because the event is full (today\'s behaviour, on purpose)', async () => {
    mockAdmission.mockResolvedValue('refused');
    expect(await decide(page(), { registered: false, refusalCode: 'SESSION_FULL' })).toEqual({ kind: 'enter' });
  });

  it('refuses everyone else, in words that fit them', async () => {
    mockAdmission.mockResolvedValue('refused');
    expect(await decide(page(), { registered: false, refusalCode: 'AUTH_FORBIDDEN' })).toEqual({ kind: 'refuse', refusal: POD_ONLY });
    expect(await decide(page(), { registered: false, refusalCode: 'SESSION_NOT_SCHEDULED' }, 'completed')).toEqual({ kind: 'refuse', refusal: ENDED });
  });

  it('a definite no takes a socket out even if an earlier answer let it in', async () => {
    mockAdmission.mockResolvedValue('refused');
    expect(await decide(page(true), { registered: false, refusalCode: 'AUTH_FORBIDDEN' })).toEqual({ kind: 'refuse', refusal: POD_ONLY });
  });
});

describe('decideRoomEntry, when the read fails (a pool or Neon error must never drop a member)', () => {
  it('lets in someone this registration just registered, without asking again', async () => {
    mockAdmission.mockRejectedValue(dbDown());
    expect(await decide(page(), { registered: true })).toEqual({ kind: 'enter' });
    expect(mockAdmission).toHaveBeenCalledTimes(1);
  });

  it('lets in someone the registration found already registered', async () => {
    mockAdmission.mockRejectedValue(dbDown());
    expect(await decide(page(), { registered: false, refusalCode: 'SESSION_ALREADY_REGISTERED' })).toEqual({ kind: 'enter' });
    expect(mockAdmission).toHaveBeenCalledTimes(1);
  });

  it('never takes a socket that is already in the room out of it (a focus return, a second ask)', async () => {
    mockAdmission.mockRejectedValue(dbDown());
    expect(await decide(page(true), { registered: false, refusalCode: 'AUTH_FORBIDDEN' })).toEqual({ kind: 'enter' });
    expect(mockAdmission).toHaveBeenCalledTimes(1);
  });

  it('otherwise asks once more, and refuses with a request to refresh when that fails too (a stranger stays out)', async () => {
    mockAdmission.mockRejectedValue(dbDown());
    expect(await decide(page(), { registered: false, refusalCode: 'AUTH_FORBIDDEN' })).toEqual({ kind: 'refuse', refusal: RETRY });
    expect(mockAdmission).toHaveBeenCalledTimes(2);
  });

  it('uses the second answer when it comes back', async () => {
    mockAdmission.mockRejectedValueOnce(dbDown()).mockResolvedValueOnce('refused');
    expect(await decide(page(), { registered: false, refusalCode: 'AUTH_FORBIDDEN' })).toEqual({ kind: 'refuse', refusal: POD_ONLY });
    mockAdmission.mockRejectedValueOnce(dbDown()).mockResolvedValueOnce('admitted');
    expect(await decide(page(), { registered: false, refusalCode: 'AUTH_FORBIDDEN' })).toEqual({ kind: 'enter' });
    mockAdmission.mockRejectedValueOnce(dbDown()).mockResolvedValueOnce('removed');
    expect(await decide(page(), { registered: false, refusalCode: 'SESSION_FULL' })).toEqual({ kind: 'evict' });
  });

  it('a full event proves nothing about a removal, so it is asked about again like anyone else', async () => {
    mockAdmission.mockRejectedValue(dbDown());
    expect(await decide(page(), { registered: false, refusalCode: 'SESSION_FULL' })).toEqual({ kind: 'refuse', refusal: RETRY });
    expect(mockAdmission).toHaveBeenCalledTimes(2);
  });
});

describe('liveStateAccess (who a resync answers)', () => {
  it('answers someone the event admits, even before their join has put them in the room', async () => {
    mockAdmission.mockResolvedValue('admitted');
    expect(await liveStateAccess(asSocket(page()), EVENT, ME, 'member')).toBe('answer');
  });

  it('tells a removed member they are removed', async () => {
    mockAdmission.mockResolvedValue('removed');
    expect(await liveStateAccess(asSocket(page(true)), EVENT, ME, 'member')).toBe('removed');
  });

  it('answers a socket the join let in (someone over capacity), and nobody else', async () => {
    mockAdmission.mockResolvedValue('refused');
    expect(await liveStateAccess(asSocket(page(true)), EVENT, ME, 'member')).toBe('answer');
    expect(await liveStateAccess(asSocket(page(false)), EVENT, ME, 'member')).toBe('ignore');
  });

  it('when the read fails, answers a socket in the room and ignores one outside it', async () => {
    mockAdmission.mockRejectedValue(dbDown());
    expect(await liveStateAccess(asSocket(page(true)), EVENT, ME, 'member')).toBe('answer');
    expect(await liveStateAccess(asSocket(page(false)), EVENT, ME, 'member')).toBe('ignore');
  });
});

describe('refuseOnce', () => {
  it('tells a page once per event and sentence; a new page is told again', () => {
    const first = page();
    refuseOnce(asSocket(first), EVENT, POD_ONLY);
    refuseOnce(asSocket(first), EVENT, POD_ONLY);
    refuseOnce(asSocket(first), EVENT, RETRY);
    expect(first.emit.mock.calls).toEqual([['error', POD_ONLY], ['error', RETRY]]);
    const second = page();
    refuseOnce(asSocket(second), EVENT, POD_ONLY);
    expect(second.emit.mock.calls).toEqual([['error', POD_ONLY]]);
  });
});

describe('eventRoomRefusal: what the refused person reads', () => {
  it('an event that is over', () => {
    expect(eventRoomRefusal('completed', 'SESSION_NOT_SCHEDULED')).toEqual(ENDED);
  });

  it('a cancelled event', () => {
    expect(eventRoomRefusal('cancelled', 'SESSION_NOT_SCHEDULED')).toEqual({ code: 'EVENT_ENDED', message: 'This event was cancelled.' });
  });

  it('a private or invite-only pod\'s event, for someone who is not one of its members', () => {
    for (const status of ['scheduled', 'lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby']) {
      expect(eventRoomRefusal(status, 'AUTH_FORBIDDEN')).toEqual(POD_ONLY);
    }
  });

  it('anything else (a registration that failed, a check that could not run) asks them to try again', () => {
    for (const code of [undefined, 'NOT_FOUND', 'INTERNAL_ERROR']) {
      expect(eventRoomRefusal('round_active', code)).toEqual(RETRY);
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
