// SEC-1 (2026-06-13 audit C1) — the acting-as-host self-toggle endpoint was
// formerly gated only by `authenticate` (and a director refusal), so ANY
// authenticated participant could POST { value: true } on their own row and
// be promoted to cohost via getEffectiveRole — full host control surface.
//
// The gate now allows OPT-IN (value:true) only for platform admins /
// super_admins. Opt-out (value:false) and clear (value:null) are
// de-escalations and stay open to any caller — the live Host Control Center
// toggle only ever posts false|null (HostControlCenter.tsx:510-511), so a
// member-role co-host flipping back is never blocked. The event director can
// never toggle (Phase P), regardless of role.

jest.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = (global as any).__sec1User;
    next();
  },
}));

jest.mock('../../middleware/audit', () => ({
  auditMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

const mockGetSessionById = jest.fn();
const mockSetActingAsHost = jest.fn(async () => {});
jest.mock('../../services/session/session.service', () => ({
  getSessionById: (...a: any[]) => (mockGetSessionById as any)(...a),
  setActingAsHost: (...a: any[]) => (mockSetActingAsHost as any)(...a),
}));

const mockEmitPermissionsUpdated = jest.fn(async () => {});
jest.mock('../../realtime/fanout', () => ({
  emitPermissionsUpdated: (...a: any[]) => (mockEmitPermissionsUpdated as any)(...a),
}));

jest.mock('../../services/orchestration/orchestration.service', () => ({
  getActiveSessionState: jest.fn(),
}));

import express from 'express';
import request from 'supertest';

let supertestAvailable = true;
try { require.resolve('supertest'); } catch { supertestAvailable = false; }

const DIRECTOR_ID = 'director-1';

describe('SEC-1 — POST /sessions/:id/host/acting-as-host authorization gate', () => {
  let app: express.Express;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGetSessionById.mockResolvedValue({ id: 'sess1', hostUserId: DIRECTOR_ID });

    const { default: hostRouter } = await import('../../routes/host');
    app = express();
    app.use(express.json());
    app.use('/api/sessions', hostRouter);
    // Minimal error handler mirroring middleware/errorHandler's status mapping.
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
    });
  });

  if (!supertestAvailable) {
    it.skip('supertest not available — skipping HTTP integration tests', () => {});
    return;
  }

  function setUser(userId: string, role: string): void {
    (global as any).__sec1User = { userId, role };
  }

  function postToggle(value: boolean | null) {
    return request(app).post('/api/sessions/sess1/host/acting-as-host').send({ value });
  }

  it('blocks a plain participant (member) from opting IN (value:true) → 403, no write', async () => {
    setUser('member-1', 'member');
    const res = await postToggle(true);
    expect(res.status).toBe(403);
    expect(mockSetActingAsHost).not.toHaveBeenCalled();
  });

  it('allows a member to opt OUT (value:false) → 200, write performed', async () => {
    setUser('member-1', 'member');
    const res = await postToggle(false);
    expect(res.status).toBe(200);
    expect(mockSetActingAsHost).toHaveBeenCalledWith('sess1', 'member-1', false);
  });

  it('allows a member to CLEAR the override (value:null) → 200 (HCC "switch back" path)', async () => {
    setUser('cohost-member-1', 'member');
    const res = await postToggle(null);
    expect(res.status).toBe(200);
    expect(mockSetActingAsHost).toHaveBeenCalledWith('sess1', 'cohost-member-1', null);
  });

  it('allows an ADMIN (non-director) to opt IN (value:true) → 200, write performed', async () => {
    setUser('admin-1', 'admin');
    const res = await postToggle(true);
    expect(res.status).toBe(200);
    expect(mockSetActingAsHost).toHaveBeenCalledWith('sess1', 'admin-1', true);
  });

  it('allows a SUPER_ADMIN (non-director) to opt IN (value:true) → 200', async () => {
    setUser('sa-1', 'super_admin');
    const res = await postToggle(true);
    expect(res.status).toBe(200);
    expect(mockSetActingAsHost).toHaveBeenCalledWith('sess1', 'sa-1', true);
  });

  it('still refuses the event director (Phase P) before the role gate → 403, no write', async () => {
    // Even a super_admin who happens to be the director cannot toggle; the
    // director check runs first and is independent of the new role gate.
    setUser(DIRECTOR_ID, 'super_admin');
    const res = await postToggle(true);
    expect(res.status).toBe(403);
    expect(mockSetActingAsHost).not.toHaveBeenCalled();
  });
});
