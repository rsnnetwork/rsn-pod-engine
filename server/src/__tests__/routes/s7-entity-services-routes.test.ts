// ─── PUT /api/entities/:id/services (Shirley pilot S7, 11 Nov 2026; brief RSN 15) ───────────────────────────────
// What the route accepts (the controlled categories, a 280-character description counted as the database counts it, an
// https website and never javascript:, at most one per category, at most 15), whom it lets through (the service's
// lockForAdmin: an entity admin or a platform admin; anyone else 403, an archived entity 404), and that a save tells the
// entity's screens (fanoutEntityChange) only once it has happened. The service is a stand-in here; its SQL runs in
// services/entity/entity-services.service.test.ts and for real on PGlite (the task report).

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active', account_kind: 'member' }] }),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/entity/entity.service', () => ({ __esModule: true }));
jest.mock('../../services/entity/entity-pictures.service', () => ({ __esModule: true }));
const mockSet = jest.fn();
jest.mock('../../services/entity/entity-services.service', () => ({
  ...jest.requireActual('../../services/entity/entity-services.service'),
  setEntityServices: (...a: unknown[]) => mockSet(...a),
  __esModule: true,
}));
const mockFanoutEntity = jest.fn().mockResolvedValue(undefined);
const mockFanoutCircles = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({
  fanoutEntityChange: (...a: unknown[]) => mockFanoutEntity(...a),
  fanoutProfileChange: jest.fn(),
  fanoutEntityCircles: (...a: unknown[]) => mockFanoutCircles(...a),
  __esModule: true,
}));

import entityRoutes from '../../routes/entities';
import { authenticate } from '../../middleware/auth';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { entityWriteLimiter } from '../../middleware/rateLimit';
import { ForbiddenError, NotFoundError } from '../../middleware/errors';
import { SERVICE_WEBSITE_REFUSED } from '../../services/entity/entity-services.service';
import { ENTITY_SERVICE_CATEGORIES } from '@rsn/shared';

const app = express();
app.use(express.json());
app.use('/entities', entityRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const as = (sub: string, role = 'member') => ({ Authorization: `Bearer ${token(sub, role)}` });
const ID = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';
const put = (who: Record<string, string>, body: unknown, id = ID) => request(app).put(`/entities/${id}/services`).set(who).send(body as object);

beforeEach(() => {
  jest.clearAllMocks();
  mockSet.mockImplementation(async (_me: string, _id: string, list: unknown[]) => list);
});

describe('an entity admin sets its services', () => {
  it('two services, in order, trimmed, blank as null, a bare address made https; the page is told after the save', async () => {
    const res = await put(as('u-admin'), {
      services: [
        { category: 'coaching', description: '  One to one coaching for founders.  ', website: 'acme.com/coaching' },
        { category: 'events', description: '   ', website: '' },
      ],
    });
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('u-admin', ID, [
      { category: 'coaching', description: 'One to one coaching for founders.', website: 'https://acme.com/coaching' },
      { category: 'events', description: null, website: null },
    ], false);
    expect(res.body.data.services).toHaveLength(2);
    expect(mockFanoutEntity).toHaveBeenCalledWith(ID, 'u-admin');
    expect(mockFanoutEntity.mock.invocationCallOrder[0]).toBeGreaterThan(mockSet.mock.invocationCallOrder[0]);
  });

  it('an empty list clears them', async () => {
    const res = await put(as('u-admin'), { services: [] });
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('u-admin', ID, [], false);
  });

  it.each([['admin'], ['super_admin']])('a platform %s is passed as one (the service lets them through)', async (role) => {
    await put(as('u-staff', role), { services: [{ category: 'legal' }] });
    expect(mockSet).toHaveBeenCalledWith('u-staff', ID, [{ category: 'legal', description: null, website: null }], true);
  });

  it('an id in capitals is the same entity, lower-cased', async () => {
    await put(as('u-admin'), { services: [] }, ID.toUpperCase());
    expect(mockSet).toHaveBeenCalledWith('u-admin', ID, [], false);
  });

  it('a description of 280 emoji is 280 characters (as the database counts them), and is accepted', async () => {
    const res = await put(as('u-admin'), { services: [{ category: 'design', description: '🎨'.repeat(280) }] });
    expect(res.status).toBe(200);
  });
});

describe('what the route refuses, before the service is reached', () => {
  const refused = async (body: unknown, says: RegExp) => {
    const res = await put(as('u-admin'), body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).toMatch(says);
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockFanoutEntity).not.toHaveBeenCalled();
  };

  it.each([
    ['javascript:alert(1)'], ['JavaScript:alert(document.cookie)'], ['data:text/html,<script>alert(1)</script>'],
    ['http://acme.com'], ['ftp://acme.com'], ['https://user:pass@acme.com'], ['https://localhost'], ['acme .com'],
    ['mailto:a@acme.com'],
  ])('a website of %s', async (website) => {
    await refused({ services: [{ category: 'consulting', website }] }, /https:\/\//);
    expect(SERVICE_WEBSITE_REFUSED).toMatch(/https:\/\//);
  });

  it('a description of 281 characters', async () => {
    await refused({ services: [{ category: 'design', description: 'x'.repeat(281) }] }, /280 characters/);
  });

  it('281 emoji (each one character)', async () => {
    await refused({ services: [{ category: 'design', description: '🎨'.repeat(281) }] }, /280 characters/);
  });

  it('a category that is not on the list', async () => {
    await refused({ services: [{ category: 'crypto_pumping' }] }, /Choose a service from the list/);
  });

  it('the same category twice', async () => {
    await refused({ services: [{ category: 'legal' }, { category: 'legal', description: 'again' }] }, /listed once/);
  });

  it('more than fifteen', async () => {
    const services = [...ENTITY_SERVICE_CATEGORIES, 'other'].map((category) => ({ category }));
    await refused({ services }, /at most 15/);
  });

  it('no list at all, or a field the route does not know', async () => {
    await refused({}, /Send the list of services/);
    await refused({ services: [{ category: 'legal', price: 100 }] }, /price|Unrecognized/i);
  });

  it('an id that is not one', async () => {
    const res = await put(as('u-admin'), { services: [] }, 'not-an-id');
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('someone not signed in', async () => {
    const res = await request(app).put(`/entities/${ID}/services`).send({ services: [] });
    expect(res.status).toBe(401);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('what the service refuses is passed on, and tells no screen', () => {
  it('a member who is not one of its admins: 403 in words', async () => {
    mockSet.mockRejectedValueOnce(new ForbiddenError("Only this entity's admins can change or archive it."));
    const res = await put(as('u-member'), { services: [{ category: 'legal' }] });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe("Only this entity's admins can change or archive it.");
    expect(mockFanoutEntity).not.toHaveBeenCalled();
  });

  it('an entity archived meanwhile: 404', async () => {
    mockSet.mockRejectedValueOnce(new NotFoundError('Entity', ID, 'This entity could not be found.'));
    const res = await put(as('u-admin'), { services: [] });
    expect(res.status).toBe(404);
    expect(mockFanoutEntity).not.toHaveBeenCalled();
  });
});

describe('the route carries the write limiter, after authenticate and ahead of its handler', () => {
  interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }
  it('PUT /:id/services', () => {
    const handlers = (entityRoutes as unknown as { stack: Layer[] }).stack
      .filter((layer) => layer.route?.path === '/:id/services' && layer.route.methods.put)
      .flatMap((layer) => layer.route!.stack.map((s) => s.handle));
    expect(handlers.length).toBeGreaterThan(2);
    expect(handlers.indexOf(entityWriteLimiter)).toBeGreaterThan(handlers.indexOf(authenticate));
    expect(handlers.indexOf(authenticate)).toBeGreaterThanOrEqual(0);
  });
});
