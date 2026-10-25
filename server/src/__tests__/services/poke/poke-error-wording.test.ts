// server/src/__tests__/services/poke/poke-error-wording.test.ts
// 8 Oct 2026: members never see the word "poke" anywhere else in the product,
// which says "Meet" and "meeting request". The refusals thrown on the send,
// accept and decline paths are shown to the member as a toast, so they speak
// the same words, with no internal id and no internal name in them. Statuses
// and codes are not part of the wording and must not move, except where the
// product changed them: since 26 Oct a request answered twice the same way is
// not refused, and the other answer is a 409 MEETING_REQUEST_ALREADY_ANSWERED.
const mockQuery = jest.fn();
const mockAreBlocked = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: (client: { query: typeof mockQuery }) => unknown) => cb({ query: mockQuery }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../index', () => ({ io: { to: () => ({ emit: () => {} }) }, __esModule: true }));
jest.mock('../../../realtime/emit', () => ({
  emitEntities: jest.fn().mockResolvedValue(undefined),
  getRealtimeIo: () => null,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../services/block/block.service', () => ({
  areBlocked: (...args: unknown[]) => mockAreBlocked(...args),
  __esModule: true,
}));

import { sendPoke, acceptPoke, declinePoke } from '../../../services/poke/poke.service';

const POKE_ID = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';
const SENDER = 'u-send';
const RECIPIENT = 'u-recv';

/** The row the accept and decline paths read; empty `rows` is a request that is not there. */
function requestIs(status: 'pending' | 'accepted' | 'declined' | 'missing') {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM user_pokes WHERE id/.test(sql) && status !== 'missing') {
      return Promise.resolve({
        rows: [{
          id: POKE_ID, sender_id: SENDER, recipient_id: RECIPIENT, status, message: null,
          responded_at: null, created_at: new Date('2026-10-08T10:00:00Z'), preferred_format: null,
        }],
      });
    }
    return Promise.resolve({ rows: [] });
  });
}

/**
 * The attempt must be refused; the refusal must read as the product does, and carry the status and code it always had.
 * It is shown to the member as a toast, so none of the ids in play may be in it.
 */
async function expectRefusal(
  attempt: Promise<unknown>,
  want: { statusCode: number; code: string; message: string },
) {
  const err = await attempt.then(
    () => { throw new Error('expected the attempt to be refused'); },
    (e: unknown) => e as Error,
  );
  expect(err).toMatchObject(want);
  expect(err.message).not.toMatch(/poke/i);
  for (const id of [POKE_ID, SENDER, RECIPIENT]) expect(err.message).not.toContain(id);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockAreBlocked.mockReset().mockResolvedValue(false);
});

describe('sendPoke refusals', () => {
  it('tells a member who asks to meet themselves, in meeting-request words', async () => {
    await expectRefusal(sendPoke(SENDER, SENDER), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: "You can't send a meeting request to yourself.",
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('tells a member who cannot ask this person so, without saying why', async () => {
    mockAreBlocked.mockResolvedValue(true);
    await expectRefusal(sendPoke(SENDER, RECIPIENT), {
      statusCode: 403,
      code: 'AUTH_FORBIDDEN',
      message: "You can't send a meeting request to this person.",
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('says a member who is not there any more is no longer available, with no id in it', async () => {
    // No earlier meeting, no earlier "no", and no such member: every lookup comes back empty.
    mockQuery.mockResolvedValue({ rows: [] });
    await expectRefusal(sendPoke(SENDER, RECIPIENT), {
      statusCode: 404,
      code: 'USER_NOT_FOUND',
      message: 'That member is no longer available.',
    });
  });
});

describe('acceptPoke refusals', () => {
  it('says a request that is not there could not be found, with no id in it', async () => {
    requestIs('missing');
    await expectRefusal(acceptPoke(POKE_ID, RECIPIENT), {
      statusCode: 404,
      code: 'POKE_NOT_FOUND',
      message: "We couldn't find that meeting request.",
    });
  });

  it('says only the person it was sent to can accept it', async () => {
    requestIs('pending');
    await expectRefusal(acceptPoke(POKE_ID, SENDER), {
      statusCode: 403,
      code: 'AUTH_FORBIDDEN',
      message: 'Only the person this meeting request was sent to can accept it.',
    });
  });

  // 26 Oct 2026: answering twice is safe. Accepting an accepted request is done already and
  // answers with it (200); only the other answer is refused, as a 409 that says what was chosen.
  it('accepting a request that is already accepted is not refused: it answers with the request', async () => {
    requestIs('accepted');
    await expect(acceptPoke(POKE_ID, RECIPIENT)).resolves.toMatchObject({ poke: { id: POKE_ID, status: 'accepted' } });
  });

  it('says a request that was declined was declined, in the member\'s own words', async () => {
    requestIs('declined');
    await expectRefusal(acceptPoke(POKE_ID, RECIPIENT), {
      statusCode: 409,
      code: 'MEETING_REQUEST_ALREADY_ANSWERED',
      message: 'You already declined this request.',
    });
  });
});

describe('declinePoke refusals', () => {
  it('says a request that is not there could not be found, with no id in it', async () => {
    requestIs('missing');
    await expectRefusal(declinePoke(POKE_ID, RECIPIENT), {
      statusCode: 404,
      code: 'POKE_NOT_FOUND',
      message: "We couldn't find that meeting request.",
    });
  });

  it('says only the person it was sent to can decline it', async () => {
    requestIs('pending');
    await expectRefusal(declinePoke(POKE_ID, SENDER), {
      statusCode: 403,
      code: 'AUTH_FORBIDDEN',
      message: 'Only the person this meeting request was sent to can decline it.',
    });
  });

  it('declining a request that is already declined is not refused: it answers with the request', async () => {
    requestIs('declined');
    await expect(declinePoke(POKE_ID, RECIPIENT)).resolves.toMatchObject({ id: POKE_ID, status: 'declined' });
  });

  it('says a request that was accepted was accepted, in the member\'s own words', async () => {
    requestIs('accepted');
    await expectRefusal(declinePoke(POKE_ID, RECIPIENT), {
      statusCode: 409,
      code: 'MEETING_REQUEST_ALREADY_ANSWERED',
      message: 'You already accepted this request.',
    });
  });
});
