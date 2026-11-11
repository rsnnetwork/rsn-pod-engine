// ─── POST /dm/messages: the length a voice note is sent with (11 Nov 2026, Shirley Palmer RSN 06, prod smoke) ──────────
//
// A webm fresh from Chrome's MediaRecorder carries no length, so the players now show the length stored with the note
// (attachment.meta.durationMs, the recorder's measure; durationSec, Cloudinary's, on every older note). The server cannot
// measure the file, so it checks the reported length: a real number, at most 65 s (the 60 s cap plus the stop's lag).
// Both are optional, so a note from a client of before then is still taken. Pictures are not checked.

import express from 'express';
import request from 'supertest';

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
jest.mock('../../config', () => ({
  default: { clientUrl: 'https://app.rsn.network', jwtSecret: 'x', env: 'test', isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'ana@example.com', role: 'member', sessionId: 's-1' };
    next();
  },
  __esModule: true,
}));
const mockSendMessage = jest.fn();
jest.mock('../../services/dm/dm.service', () => ({
  __esModule: true,
  sendMessage: (...a: unknown[]) => mockSendMessage(...a),
}));
jest.mock('../../services/orchestration/handlers/dm-handlers', () => ({
  __esModule: true,
  broadcastDmMessage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../realtime/fanout', () => ({
  __esModule: true,
  fanoutDmConversation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }), transaction: jest.fn(), __esModule: true }));

import dmRoutes, { VOICE_NOTE_TOO_LONG, VOICE_NOTE_UPLOAD_LIMIT_MS } from '../../routes/dm';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { VOICE_NOTE_UPLOAD_LIMIT_MS as CLIENT_LIMIT, VOICE_COPY } from '../../../../client/src/features/messages/voice/voice-note';

const app = express();
app.use(express.json());
app.set('io', { to: () => ({ emit: () => undefined }) });
app.use('/dm', dmRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const BEN = 'bbbbbbbb-0000-4000-8000-000000000002';
const URL_AUDIO = 'https://res.cloudinary.com/demo/video/upload/v1/note.webm';
const voice = (meta: Record<string, unknown> | null | undefined) => ({ toUserId: BEN, content: '', attachment: { url: URL_AUDIO, type: 'audio', meta } });
const post = (body: unknown) => request(app).post('/dm/messages').send(body as object);

beforeEach(() => {
  jest.clearAllMocks();
  mockSendMessage.mockResolvedValue({ conversationId: 'c-1', message: { id: 'm-1' } });
});

describe('the length a voice note is sent with', () => {
  it('the server\'s limit is the client\'s: 65 s, and the refusal says the same sentence', () => {
    expect(VOICE_NOTE_UPLOAD_LIMIT_MS).toBe(65_000);
    expect(CLIENT_LIMIT).toBe(VOICE_NOTE_UPLOAD_LIMIT_MS);
    expect(VOICE_NOTE_TOO_LONG).toBe(VOICE_COPY.tooLong);
  });

  it('a 12 s note with the recorder\'s measure and Cloudinary\'s: taken, and the length is stored with it as sent', async () => {
    const res = await post(voice({ durationMs: 12_340, durationSec: 12.3, bytes: 100, format: 'webm' }));
    expect(res.status).toBe(201);
    expect(mockSendMessage).toHaveBeenCalledWith(ME, BEN, '', { url: URL_AUDIO, type: 'audio', meta: expect.objectContaining({ durationMs: 12_340, durationSec: 12.3 }) }, null);
  });

  it('exactly 65 s is taken (the cap plus the stop\'s lag)', async () => {
    expect((await post(voice({ durationMs: 65_000, durationSec: 65 }))).status).toBe(201);
  });

  it.each([
    ['durationMs over 65 s', { durationMs: 65_001 }, 'attachment.meta.durationMs'],
    ['durationSec over 65 s', { durationSec: 70 }, 'attachment.meta.durationSec'],
    ['a zero length', { durationMs: 0 }, 'attachment.meta.durationMs'],
    ['a negative length', { durationSec: -3 }, 'attachment.meta.durationSec'],
    ['a length that is not a number', { durationMs: 'twelve' }, 'attachment.meta.durationMs'],
  ])('%s: refused (400), with the field named, and nothing is sent', async (_what, meta, field) => {
    const res = await post(voice(meta));
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.details ?? {})).toContain(field);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('too long says the member\'s sentence', async () => {
    const res = await post(voice({ durationMs: 120_000 }));
    expect(res.body.error.details['attachment.meta.durationMs']).toEqual([VOICE_NOTE_TOO_LONG]);
  });

  it('a note from a client of before (no length, or no meta at all) is still taken', async () => {
    expect((await post(voice({ bytes: 100 }))).status).toBe(201);
    expect((await post(voice(null))).status).toBe(201);
    expect((await post(voice(undefined))).status).toBe(201);
  });

  it('a picture is not checked for a length', async () => {
    const res = await post({ toUserId: BEN, content: '', attachment: { url: 'https://res.cloudinary.com/demo/image/upload/v1/p.png', type: 'image', meta: { durationMs: 999_999 } } });
    expect(res.status).toBe(201);
  });
});
