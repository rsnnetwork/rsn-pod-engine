// ─── PUT /dm/conversations/:id/scheduling/availability: the body (26 Oct 2026) ─
//
// A save that leaves exactly one shared time now books it, so the save may say how long and what
// kind of call. Both are optional: production's scheduler sends only { windows } and must go on
// working exactly as it does, booking 30 minutes of video. Same bounds as confirm (5–240 minutes,
// audio or video), refused before anything is saved.
//
// These go through express with the real router; only the sign-in check and the service are stand-ins.

import express from 'express';
import request from 'supertest';

jest.mock('../../config', () => ({ default: { clientUrl: 'https://app.rsn.network' }, __esModule: true }));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: 'u-a', email: 'ana@example.com', role: 'member', sessionId: 's-1' };
    next();
  },
  __esModule: true,
}));
const mockSetAvailability = jest.fn();
jest.mock('../../services/dm/meeting-windows.service', () => ({
  setAvailability: (...a: unknown[]) => mockSetAvailability(...a),
  __esModule: true,
}));
jest.mock('../../services/dm/meeting-call.service', () => ({ __esModule: true }));
jest.mock('../../services/presence/presence.service', () => ({ areActive: jest.fn(), __esModule: true }));
jest.mock('../../db', () => ({ query: jest.fn(), transaction: jest.fn(), __esModule: true }));

import meetingRoutes from '../../routes/meeting';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/dm', meetingRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const PATH = '/dm/conversations/conv-1/scheduling/availability';
const SLOT = '2026-11-02T12:00:00Z';

beforeEach(() => {
  mockSetAvailability.mockReset().mockResolvedValue({ conversationId: 'conv-1', confirmed: null });
});

describe('PUT …/scheduling/availability', () => {
  it('a legacy availability body { windows } with no durationMin/type is accepted, and books with the defaults', async () => {
    const res = await request(app).put(PATH).send({ windows: [SLOT] });

    expect(res.status).toBe(200);
    expect(mockSetAvailability).toHaveBeenCalledWith('conv-1', 'u-a', [SLOT], { durationMin: undefined, type: undefined });
  });

  it('hands the length and kind sent with the save to the booking', async () => {
    const res = await request(app).put(PATH).send({ windows: [SLOT], durationMin: 45, type: 'audio' });

    expect(res.status).toBe(200);
    expect(mockSetAvailability).toHaveBeenCalledWith('conv-1', 'u-a', [SLOT], { durationMin: 45, type: 'audio' });
  });

  it('answers with the scheduling the service returns, confirmed meeting and all', async () => {
    mockSetAvailability.mockResolvedValue({ conversationId: 'conv-1', confirmed: { window: SLOT, durationMin: 30, type: 'video' } });

    const res = await request(app).put(PATH).send({ windows: [SLOT] });

    expect(res.body).toEqual({ success: true, data: { conversationId: 'conv-1', confirmed: { window: SLOT, durationMin: 30, type: 'video' } } });
  });

  it.each([
    ['a length under 5 minutes', { durationMin: 4 }],
    ['a length over 240 minutes', { durationMin: 241 }],
    ['a length that is not whole minutes', { durationMin: 12.5 }],
    ['a length written as text', { durationMin: '30' }],
    ['a kind of call that does not exist', { type: 'phone' }],
  ])('refuses %s before anything is saved', async (_label, extra) => {
    const res = await request(app).put(PATH).send({ windows: [SLOT], ...extra });

    expect(res.status).toBe(400);
    expect(mockSetAvailability).not.toHaveBeenCalled();
  });

  it('still refuses a body without windows', async () => {
    expect((await request(app).put(PATH).send({ durationMin: 30 })).status).toBe(400);
    expect(mockSetAvailability).not.toHaveBeenCalled();
  });
});
