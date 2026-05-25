// ─── Phase 4 — LiveKit webhook handler tests ─────────────────────────────────
// Verify that the /api/webhooks/livekit handler:
//   1. Calls updateCanonicalParticipant with connState:'disconnected' on participant_left
//   2. Calls updateCanonicalParticipant with connState:'connected' on participant_joined
//   3. Always responds 200 even on signature-verification errors

jest.mock('livekit-server-sdk', () => {
  const mockReceive = jest.fn();
  return {
    WebhookReceiver: jest.fn().mockImplementation(() => ({ receive: mockReceive })),
    __mockReceive: mockReceive,
  };
});

jest.mock('../../config', () => {
  const cfg: any = {
    livekit: { apiKey: 'test-key', apiSecret: 'test-secret', host: '' },
    logLevel: 'silent',
    isDev: false, isProd: false, isTest: true,
    env: 'test', port: 3001,
    roomEvictionEnabled: false,
  };
  return { __esModule: true, default: cfg, config: cfg };
});

jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), fatal: jest.fn(), trace: jest.fn(),
    child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  },
}));

const mockUpdateCanonicalParticipant = jest.fn(async () => {});
jest.mock('../../services/orchestration/state/canonical-state', () => ({
  updateCanonicalParticipant: mockUpdateCanonicalParticipant,
  updateCanonicalSessionStatus: jest.fn(async () => {}),
  readCanonical: jest.fn(async () => null),
  writeCanonical: jest.fn(async () => {}),
}));

import express from 'express';
import request from 'supertest';

// We need supertest — check if it's available
let supertestAvailable = true;
try { require.resolve('supertest'); } catch { supertestAvailable = false; }

describe('LiveKit webhook handler', () => {
  let app: express.Express;
  let mockReceive: jest.Mock;

  beforeEach(async () => {
    jest.resetModules();
    mockUpdateCanonicalParticipant.mockClear();

    // Re-import after resetModules to get a fresh router
    const lkSdk = require('livekit-server-sdk');
    mockReceive = lkSdk.__mockReceive as jest.Mock;
    mockReceive.mockReset();

    const { webhooksRouter } = await import('../../routes/webhooks');
    app = express();
    app.use('/api/webhooks', webhooksRouter);
  });

  if (!supertestAvailable) {
    it.skip('supertest not available — skipping HTTP integration tests', () => {});
    return;
  }

  it('calls updateCanonicalParticipant(disconnected) on participant_left', async () => {
    mockReceive.mockResolvedValue({
      event: 'participant_left',
      room: { name: 'lobby-sess1' },
      participant: { identity: 'u1' },
    });

    const res = await request(app)
      .post('/api/webhooks/livekit')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', 'Bearer sig')
      .send('{}');

    expect(res.status).toBe(200);
    expect(mockUpdateCanonicalParticipant).toHaveBeenCalledWith(
      'sess1', 'u1', { connState: 'disconnected' }
    );
  });

  it('calls updateCanonicalParticipant(connected) on participant_joined', async () => {
    mockReceive.mockResolvedValue({
      event: 'participant_joined',
      room: { name: 'lobby-sess2' },
      participant: { identity: 'u2' },
    });

    const res = await request(app)
      .post('/api/webhooks/livekit')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', 'Bearer sig')
      .send('{}');

    expect(res.status).toBe(200);
    expect(mockUpdateCanonicalParticipant).toHaveBeenCalledWith(
      'sess2', 'u2', { connState: 'connected' }
    );
  });

  it('always responds 200 even when receiver.receive throws', async () => {
    mockReceive.mockRejectedValue(new Error('bad signature'));

    const res = await request(app)
      .post('/api/webhooks/livekit')
      .set('Content-Type', 'application/webhook+json')
      .send('{}');

    expect(res.status).toBe(200);
    expect(mockUpdateCanonicalParticipant).not.toHaveBeenCalled();
  });

  it('parses match room name to sessionId', async () => {
    mockReceive.mockResolvedValue({
      event: 'participant_left',
      room: { name: 'match-abc123-r1-xxxxxxxx' },
      participant: { identity: 'u3' },
    });

    const res = await request(app)
      .post('/api/webhooks/livekit')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', 'Bearer sig')
      .send('{}');

    expect(res.status).toBe(200);
    expect(mockUpdateCanonicalParticipant).toHaveBeenCalledWith(
      'abc123', 'u3', { connState: 'disconnected' }
    );
  });
});
