// ─── The admin's message to an applicant comes from REASON (21 Oct 2026) ─────
//
// The client's 19 Oct feedback: "Call it REASON everywhere". When an admin writes to someone who
// asked to join, the email's subject is "Message from REASON".
//
// This goes through express with the real router; only the sign-in check, the join-request lookup,
// the email and the database are stand-ins.

import express from 'express';
import request from 'supertest';

jest.mock('../../config', () => ({
  default: { rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000, env: 'test', isDev: false, isProd: false, isTest: true },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
let mockRole = 'admin';
jest.mock('../../middleware/auth', () => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: 'u-admin', email: 'admin@example.com', role: mockRole, sessionId: 's-1' };
    next();
  },
  __esModule: true,
}));
jest.mock('../../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }), transaction: jest.fn(), __esModule: true }));
const mockGetRequest = jest.fn();
jest.mock('../../services/join-request/join-request.service', () => ({
  getJoinRequestById: (...a: unknown[]) => mockGetRequest(...a),
  __esModule: true,
}));
const mockSendGeneric = jest.fn();
jest.mock('../../services/email/email.service', () => ({
  sendGenericEmail: (...a: unknown[]) => mockSendGeneric(...a),
  __esModule: true,
}));
jest.mock('../../realtime/fanout', () => ({
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  fanoutUserEntity: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));

import joinRequestRoutes from '../../routes/join-requests';
import { errorHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/join-requests', joinRequestRoutes);
app.use(errorHandler);

describe('POST /join-requests/:id/message', () => {
  beforeEach(() => {
    mockRole = 'admin';
    mockGetRequest.mockReset().mockResolvedValue({ id: 'jr-1', email: 'sam@example.com', fullName: 'Sam Applicant' });
    mockSendGeneric.mockReset().mockResolvedValue(undefined);
  });

  it('emails the applicant with the subject "Message from REASON" and the admin\'s own words', async () => {
    const res = await request(app).post('/join-requests/jr-1/message').send({ message: 'Could you tell us a little more about your company?' });

    expect(res.status).toBe(200);
    expect(mockSendGeneric).toHaveBeenCalledTimes(1);
    expect(mockSendGeneric).toHaveBeenCalledWith('sam@example.com', 'Sam Applicant', {
      subject: 'Message from REASON',
      body: 'Could you tell us a little more about your company?',
    });
  });

  it('sends nothing for someone who is not an admin', async () => {
    mockRole = 'member';
    const res = await request(app).post('/join-requests/jr-1/message').send({ message: 'Hello' });
    expect(res.status).toBe(403);
    expect(mockSendGeneric).not.toHaveBeenCalled();
  });
});
