// ─── A request sent from an event's RSN Call link (Part 2 foundation, Task 6, 11 Nov 2026) ─────────────────
//
// A private event with an admission mode is unlisted, not closed (D3: "private = unlisted, link only"): someone holding
// its link may ask for a place on an approval event even though the event's page is not theirs to see yet. Without the
// link, or on an event with no admission mode, the private refusal stands exactly as before.

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
jest.mock('../../../realtime/emit', () => ({ emitEntities: jest.fn().mockResolvedValue(undefined), getRealtimeIo: () => null, __esModule: true }));
jest.mock('../../../services/post-event-message/event-organisers', () => ({ resolveEventOrganiserIds: jest.fn().mockResolvedValue([]), __esModule: true }));
const mockFacts = jest.fn();
jest.mock('../../../services/session/event-access', () => {
  const actual = jest.requireActual('../../../services/session/event-access');
  return { ...actual, readEventAccessFacts: (...a: unknown[]) => mockFacts(...a) };
});

import { ErrorCodes, UserRole } from '@rsn/shared';
import { requestToJoin } from '../../../services/session/event-requests.service';

const EVENT = '00000000-0000-4000-8000-000000000100';
const ME = '00000000-0000-4000-8000-000000000002';
const facts = (over: Record<string, unknown> = {}) => ({
  visibility: 'private', podId: 'p', podVisibility: 'private', isHost: false, isCohost: false, isPodOrganiser: false,
  inAudience: false, isInvited: false, participantStatus: null, accountActive: true, myRequest: null, outsideClosedCircle: false,
  admissionMode: 'approval', entitled: false, entitledVia: null, publication: 'published', archived: false,
  registrationOpensAt: null, eventTimezone: null, isPodAdmin: false, placesHeld: 0, capacity: null, placesTaken: 0, waitlistPosition: null, waitlistAhead: 0, eventStatus: 'scheduled', ...over,
});

beforeEach(() => {
  mockQuery.mockReset().mockImplementation((sql: string) => {
    if (/INSERT INTO event_join_requests/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'r1', sessionId: EVENT, userId: ME, status: 'pending', message: null, opened: true }] });
    }
    if (/SELECT s\.title/.test(sql)) return Promise.resolve({ rows: [{ title: 'Probe', name: 'Rae' }] });
    return Promise.resolve({ rows: [] });
  });
  mockFacts.mockReset();
});

async function refusal(p: Promise<unknown>) {
  try { await p; return 'ok'; } catch (e) { return (e as { code?: string }).code; }
}

describe('requestToJoin from the call link', () => {
  it('someone holding the link asks for a place on a private approval event', async () => {
    mockFacts.mockResolvedValue(facts());
    const r = await requestToJoin(EVENT, ME, UserRole.MEMBER, null, { arrivedThroughCallLink: true });
    expect(r).toMatchObject({ status: 'pending' });
  });

  it('without the link the private refusal stands, as before', async () => {
    mockFacts.mockResolvedValue(facts());
    expect(await refusal(requestToJoin(EVENT, ME, UserRole.MEMBER, null))).toBe(ErrorCodes.EVENT_PRIVATE);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('an event with no admission mode is closed to the link too (only its pod and invitees)', async () => {
    mockFacts.mockResolvedValue(facts({ admissionMode: null }));
    expect(await refusal(requestToJoin(EVENT, ME, UserRole.MEMBER, null, { arrivedThroughCallLink: true }))).toBe(ErrorCodes.EVENT_PRIVATE);
  });

  it('a closed account is refused whatever it holds', async () => {
    mockFacts.mockResolvedValue(facts({ accountActive: false }));
    expect(await refusal(requestToJoin(EVENT, ME, UserRole.MEMBER, null, { arrivedThroughCallLink: true }))).toBe(ErrorCodes.EVENT_PRIVATE);
  });
});
